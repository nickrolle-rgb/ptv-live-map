// Journey planning Phase 5: the full static-schedule planner (see PRINCIPLES.md's
// roadmap). Runs server-side only, from api/plan-journey.js — see that file's header
// for why this needs a Node.js Function rather than the Edge runtime every other
// endpoint in this app uses.
//
// Implements the Connection Scan Algorithm (CSA): flatten every active trip into
// stop-to-stop "connections" for the query date, sort by departure time, then scan
// forward relaxing earliest-arrival times. Chosen over full RAPTOR because a single
// one-to-one query doesn't need RAPTOR's route-grouping optimization, and CSA is
// materially simpler to get correct — relevant here since, unlike Phase 3's live
// matching, there's no live data to cross-check this against; correctness rests
// entirely on this algorithm and Phase 4's data.
//
// Reuses Phase 1's walking-leg logic (src/journey.js) for both the origin/destination
// walking legs and for modelling interchange transfers between nearby platforms that
// share a station name but not a stop_id.

import { findWalkableStops, walkingMinutesTo, DEFAULT_WALK_CAP_MINUTES } from './journey.js';

// Matches Phase 3's live-matching constant (main.js) — the minimum realistic time to
// physically change trains at the same platform, applied here as a floor even when a
// connection's own timetabled gap is shorter than that.
const MIN_TRANSFER_SEC = 120;

// Two platforms sharing a station name are only treated as a walkable interchange pair
// if a rider could plausibly get between them inside this many minutes — keeps a same
// -named-but-actually-distant edge case (unlikely in this data, but not guaranteed
// absent) from silently producing an impossible transfer.
const MAX_INTERCHANGE_WALK_MINUTES = 10;

const DAY_COLUMNS = 7;
const SECONDS_PER_DAY = 86400;

function epochDay(dateStr) {
  const y = Number(dateStr.slice(0, 4));
  const m = Number(dateStr.slice(4, 6));
  const d = Number(dateStr.slice(6, 8));
  return Math.floor(Date.UTC(y, m - 1, d) / (SECONDS_PER_DAY * 1000));
}

// 0 = Monday .. 6 = Sunday, matching build-schedule.js's DAY_COLUMNS order.
function dayOfWeekIndex(dateStr) {
  const y = Number(dateStr.slice(0, 4));
  const m = Number(dateStr.slice(4, 6));
  const d = Number(dateStr.slice(6, 8));
  const jsDay = new Date(Date.UTC(y, m - 1, d)).getUTCDay(); // 0=Sun..6=Sat
  return (jsDay + DAY_COLUMNS - 1) % DAY_COLUMNS;
}

function addDays(dateStr, delta) {
  const y = Number(dateStr.slice(0, 4));
  const m = Number(dateStr.slice(4, 6));
  const d = Number(dateStr.slice(6, 8));
  const dt = new Date(Date.UTC(y, m - 1, d) + delta * SECONDS_PER_DAY * 1000);
  const yy = dt.getUTCFullYear();
  const mm = String(dt.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(dt.getUTCDate()).padStart(2, '0');
  return `${yy}${mm}${dd}`;
}

// Resolves "now" (or an explicit query instant) to the GTFS service-day date and
// seconds-since-midnight it represents in Melbourne local time — the frame every
// stop_times.txt time is written in. Uses Intl rather than a hardcoded UTC+10 offset so
// this stays correct if the data window ever spans a DST change.
export function melbourneDateAndSeconds(epochMs) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Australia/Melbourne',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).formatToParts(new Date(epochMs));
  const get = (type) => parts.find((p) => p.type === type).value;
  const dateStr = `${get('year')}${get('month')}${get('day')}`;
  const hour = Number(get('hour')) % 24; // some engines report midnight as "24"
  const seconds = hour * 3600 + Number(get('minute')) * 60 + Number(get('second'));
  return { dateStr, seconds };
}

// Inverse of melbourneDateAndSeconds: resolves a Melbourne-local calendar date plus
// GTFS-style seconds-since-midnight (0..86399, or beyond for >24h overflow trips) back
// to the real epoch instant it represents. Needed because stop_times.txt (and this
// file's own connections timeline, built from it) is written in naive wall-clock
// seconds — one flat 86400s per calendar day — which silently diverges from real
// elapsed time on the two Melbourne DST-transition days each year. Everywhere that
// divergence is harmless (CSA's internal ordering/comparisons stay self-consistent
// since every value uses the same naive timeline; formatTimeOfDay's HH:MM display is
// *supposed* to show local wall-clock digits regardless of DST), so this is only used
// where a *real* elapsed duration or epoch instant is actually required — see
// arrivalEpochMs below.
//
// Melbourne's DST is always a whole-hour, instantaneous-transition offset (UTC+10 AEST
// / UTC+11 AEDT), so one correction pass suffices: guess the epoch assuming AEST, ask
// melbourneDateAndSeconds what that guess actually reads as locally, and shift by
// whatever error is observed (which, for any guess within the same or adjacent
// calendar day as the target, can only ever be 0 or a whole number of hours).
//
// The one genuine ambiguity this can't resolve — GTFS wall-clock seconds can't
// distinguish which occurrence is meant during the repeated hour on the April fall-back
// date (02:00-03:00 happens twice, AEDT then AEST) — always resolves to the SECOND
// (AEST) occurrence: the initial guess already assumes AEST, so for a target in that
// repeated hour it reads back correctly immediately (errorSeconds is 0) and no
// correction is ever applied, landing on the later of the two real instants.
export function melbourneWallClockToEpochMs(dateStr, secondsOfDay) {
  const y = Number(dateStr.slice(0, 4));
  const m = Number(dateStr.slice(4, 6));
  const d = Number(dateStr.slice(6, 8));
  const utcMidnight = Date.UTC(y, m - 1, d);
  let guess = utcMidnight + (secondsOfDay - 10 * 3600) * 1000; // assume AEST (UTC+10)
  const actual = melbourneDateAndSeconds(guess);
  const targetAbs = epochDay(dateStr) * SECONDS_PER_DAY + secondsOfDay;
  const actualAbs = epochDay(actual.dateStr) * SECONDS_PER_DAY + actual.seconds;
  const errorSeconds = targetAbs - actualAbs;
  if (errorSeconds !== 0) guess += errorSeconds * 1000;
  return guess;
}

function resolveActiveServices(scheduleData, dateStr) {
  const active = new Set();
  const dow = dayOfWeekIndex(dateStr);
  scheduleData.serviceIds.forEach((serviceId, idx) => {
    const cal = scheduleData.calendar[serviceId];
    let valid = !!(cal && cal.days[dow] && dateStr >= cal.start && dateStr <= cal.end);
    const exceptions = scheduleData.calendarDates[serviceId];
    if (exceptions) {
      exceptions.forEach((ex) => {
        if (ex.date !== dateStr) return;
        if (ex.type === 1) valid = true;
        else if (ex.type === 2) valid = false;
      });
    }
    if (valid) active.add(idx);
  });
  return active;
}

// Builds every stop-to-stop connection for one schedule's trips whose service is
// active on `serviceDate`, expressed on an absolute-seconds timeline anchored at
// `queryDate` (so a service_id valid on the day before the query, whose late trips
// carry GTFS's >24h overflow times, lands correctly in the query day's early hours —
// see this module's header for why only D and D-1 need considering).
// Pushes directly into the caller's shared `out` array rather than building and
// returning its own, so the caller never needs `out.push(...built)` — spreading a large
// array as call arguments blows V8's argument-count ceiling (confirmed: tram's ~90k
// trips produced enough same-day connections to hit "Maximum call stack size exceeded"
// on exactly that spread, a limit train+V/Line's much smaller connection counts had
// never come close to).
function buildConnections(schedule, mode, serviceDate, queryDate, activeServices, out) {
  const dayOffset = epochDay(serviceDate) - epochDay(queryDate);
  const baseSeconds = dayOffset * SECONDS_PER_DAY;
  Object.entries(schedule.trips).forEach(([tripId, trip]) => {
    if (!activeServices.has(trip.s)) return;
    const { stops } = trip;
    const routeId = schedule.routeIds[trip.r];
    for (let i = 0; i < stops.length - 1; i++) {
      const [fromIdx, , depRaw] = stops[i];
      const [toIdx, arrRaw] = stops[i + 1];
      if (depRaw == null || arrRaw == null) continue;
      out.push({
        tripId,
        routeId,
        mode,
        fromStopId: schedule.stopIds[fromIdx],
        toStopId: schedule.stopIds[toIdx],
        fromSeq: i,
        toSeq: i + 1,
        depTime: baseSeconds + depRaw,
        arrTime: baseSeconds + arrRaw,
      });
    }
  });
}

// Groups a stop-name registry (stopId -> [name, lat, lon]) by name, so mid-journey
// transfers between nearby platforms (different stop_id, possibly different name) can be
// modelled as a short walking edge rather than requiring an exact stop_id match to continue.
//
// Originally this grouped stops by exact name match (train/V-Line's shared PTV-wide
// stop_id space meant same-station multi-platform transfers already had matching names).
// That silently breaks for tram: it uses a completely separate stop_id space *and* naming
// convention (train: "Flinders Street Station"; tram: "Flinders Street Railway
// Station/Elizabeth St #1") — confirmed zero exact-name overlap against real stop data
// before relying on proximity instead — so name matching would never find a real
// interchange between them, even at Flinders Street. Proximity (can a rider actually walk
// between these platforms, per the same MAX_INTERCHANGE_WALK_MINUTES cap as before) is the
// criterion that was always actually meant; name matching was only ever an approximation
// of it. Confirmed against the existing "far-apart same name" test below that this is a
// strict generalization, not a behavior change, for stops that do share a name.
//
// Stops are bucketed into a coarse lat/lon grid first so this stays close to linear as more
// modes' stops are added, rather than comparing every stop against every other stop. Grid
// cells (~1.1km, ~0.87km of longitude at Victoria's latitude) are sized comfortably larger
// than MAX_INTERCHANGE_WALK_MINUTES' ~615m straight-line reach, so checking a stop's own
// cell plus its 8 neighbours can never miss a pair the walk-time check would otherwise allow.
const INTERCHANGE_GRID_DEG = 0.01;

function gridCell(lat, lon) {
  return [Math.floor(lat / INTERCHANGE_GRID_DEG), Math.floor(lon / INTERCHANGE_GRID_DEG)];
}

function buildInterchangeGroups(stopRegistry) {
  const stops = Object.entries(stopRegistry).map(([stopId, [name, lat, lon]]) => ({ stopId, name, lat, lon }));

  const grid = new Map();
  stops.forEach((s) => {
    const [gLat, gLon] = gridCell(s.lat, s.lon);
    const key = `${gLat}:${gLon}`;
    if (!grid.has(key)) grid.set(key, []);
    grid.get(key).push(s);
  });

  const groups = new Map(); // stopId -> [{ stopId, transferSec }]
  stops.forEach((self) => {
    const [gLat, gLon] = gridCell(self.lat, self.lon);
    const edges = [];
    const seen = new Set();
    for (let dLat = -1; dLat <= 1; dLat++) {
      for (let dLon = -1; dLon <= 1; dLon++) {
        const neighbours = grid.get(`${gLat + dLat}:${gLon + dLon}`);
        if (!neighbours) continue;
        neighbours.forEach((other) => {
          if (seen.has(other.stopId)) return;
          seen.add(other.stopId);
          if (other.stopId === self.stopId) {
            edges.push({ stopId: other.stopId, transferSec: MIN_TRANSFER_SEC });
            return;
          }
          const walkMinutes = walkingMinutesTo(self.lat, self.lon, other.lat, other.lon);
          if (walkMinutes > MAX_INTERCHANGE_WALK_MINUTES) return;
          edges.push({ stopId: other.stopId, transferSec: Math.round(walkMinutes * 60) + MIN_TRANSFER_SEC });
        });
      }
    }
    groups.set(self.stopId, edges);
  });
  return groups;
}

// Keyed by stopRegistry object identity: the caller (api/plan-journey.js) builds the
// merged registry once at module scope, so this cache actually pays off across warm
// invocations of the same function instance instead of rebuilding on every request.
const interchangeGroupsCache = new WeakMap();
function getInterchangeGroups(stopRegistry) {
  let groups = interchangeGroupsCache.get(stopRegistry);
  if (!groups) {
    groups = buildInterchangeGroups(stopRegistry);
    interchangeGroupsCache.set(stopRegistry, groups);
  }
  return groups;
}

function formatTimeOfDay(absSeconds) {
  const s = ((absSeconds % SECONDS_PER_DAY) + SECONDS_PER_DAY) % SECONDS_PER_DAY;
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

// --- Journey options (Fastest / Simplest / Least walking) ---------------------------
//
// The scan runs in rounds, one per vehicle boarded: round k only boards from stops
// reached with at most k-1 vehicles, so after round k each stop's arrival is the best
// achievable using at most k vehicles. Keeping every round's result (not just the last)
// is what lets "Simplest" trade time for fewer changes: a single unbounded scan only
// remembers the earliest arrival, so a slightly slower one-vehicle journey gets
// overwritten by a faster four-vehicle one before anything can compare them.

// How much faster an extra vehicle has to make the trip before "Simplest" accepts it.
// 5 minutes per change, chosen by the user over an initial 10-minute suggestion.
export const SIMPLEST_TRANSFER_PENALTY_SEC = 5 * 60;
// "Least walking" caps each end's walk tighter than the default and weights the final
// walk (to the destination) heavily when ranking where to get off.
export const LEAST_WALKING_CAP_MINUTES = 8;
const LEAST_WALKING_DEST_WEIGHT = 3;
// Upper bound on vehicles in one itinerary. Each round is a full pass over the day's
// connections; six vehicles is already well past any sensible Melbourne trip.
const MAX_LEGS = 6;
// The longest journey worth planning. Melbourne's longest V/Line runs (Albury,
// Bairnsdale, Warrnambool) are around four hours end to end; six leaves room for waits.
const MAX_JOURNEY_SPAN_SEC = 6 * 3600;

// Building + sorting a day's connections is most of a query's cost (~250ms on real data)
// and depends only on the query date, not the departure time — so it's cached per date.
// planJourneyArrivingBy's binary search runs a dozen probes on the same date, all of
// which now share one build.
const connectionsCache = new WeakMap(); // schedules array -> Map(queryDate -> connections)
function getConnections(schedules, queryDate) {
  let byDate = connectionsCache.get(schedules);
  if (!byDate) { byDate = new Map(); connectionsCache.set(schedules, byDate); }
  let connections = byDate.get(queryDate);
  if (!connections) {
    connections = [];
    // The query date and the day before (to catch post-midnight overflow trips whose
    // service belongs to the previous service day).
    schedules.forEach(({ mode, data }) => {
      [queryDate, addDays(queryDate, -1)].forEach((serviceDate) => {
        const active = resolveActiveServices(data, serviceDate);
        if (active.size === 0) return;
        buildConnections(data, mode, serviceDate, queryDate, active, connections);
      });
    });
    connections.sort((a, b) => a.depTime - b.depTime);
    // Bounded: a warm function instance only ever sees a handful of dates.
    if (byDate.size >= 3) byDate.delete(byDate.keys().next().value);
    byDate.set(queryDate, connections);
  }
  return connections;
}

function firstIndexAtOrAfter(connections, t) {
  let lo = 0;
  let hi = connections.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (connections[mid].depTime < t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

// The next timetabled departures from any of `stopIds`, earliest first, one per trip,
// within windowSec of fromEpochMs. Used for a stop's popup where the live feed has
// nothing (PTV's tram feed only reports a few timing-point stops ahead of each tram).
export function stopDepartures({ schedules, stopIds, fromEpochMs, limit = 5, windowSec = 2 * 3600 }) {
  const wanted = new Set(stopIds);
  const { dateStr, seconds } = melbourneDateAndSeconds(fromEpochMs);
  const connections = getConnections(schedules, dateStr);
  const out = [];
  const seenTrips = new Set();
  for (let i = firstIndexAtOrAfter(connections, seconds); i < connections.length && out.length < limit; i++) {
    const c = connections[i];
    if (c.depTime > seconds + windowSec) break;
    if (!wanted.has(c.fromStopId) || seenTrips.has(c.tripId)) continue;
    seenTrips.add(c.tripId);
    out.push({
      tripId: c.tripId, routeId: c.routeId, mode: c.mode, stopId: c.fromStopId,
      time: formatTimeOfDay(c.depTime),
      epochMs: melbourneWallClockToEpochMs(dateStr, c.depTime),
    });
  }
  return out;
}

// Origin walk -> Map(stopId -> arrival seconds), from a findWalkableStops result.
function seedArrivals(originWalk, queryAbs) {
  const seeds = new Map();
  originWalk.stops.forEach((stop) => {
    const arriveAt = queryAbs + Math.ceil(stop.minutes * 60);
    stop.stopIds.forEach((stopId) => {
      const existing = seeds.get(stopId);
      if (existing === undefined || arriveAt < existing) seeds.set(stopId, arriveAt);
    });
  });
  return seeds;
}

// Returns rounds[k-1] = { arrival, predecessor } for "at most k vehicles". A hop is an
// immutable snapshot { tripId, routeId, mode, fromStopId, toStopId, depTime, arrTime,
// prevHop, legs, rootStopId }:
// - prevHop on a continuing trip is that same trip's previous hop (not whatever hop
//   currently holds fromStopId's best arrival, which may belong to another trip); on a
//   fresh boarding it's the hop that reached the boarding stop in the previous round.
//   Captured by reference at creation, so reconstruction is a DAG walk that later
//   improvements can't invalidate (re-resolving through a live Map once produced an
//   unfollowable cycle on V/Line's Richmond<->Flinders St runs).
// - legs counts distinct vehicles along the chain; rootStopId is the origin-seeded stop
//   the chain started from.
// - Boarding from a different stop_id than the connection's own goes through the
//   interchange groups (nearby platforms/stops) and links via the stop actually arrived
//   at, not c.fromStopId — linking via c.fromStopId was a real bug once: the chain
//   truncated at the first platform change, dropping every earlier leg.
// destCost (stopId -> weighted walk seconds from that stop to the destination) and
// penaltySec describe the most demanding ranking this scan will feed, so the scan can
// prune: once some journey reaches the destination with score S = arrival + destCost +
// penaltySec x (vehicles - 1), any connection departing after S can't be part of a
// better answer under that ranking or any gentler one (every score is at least the
// arrival time, and arrival is at least the departure). Each round stops there instead
// of running to endIdx — the bulk of the speedup that brought arrive-by down from ~10s.
function scanRounds(connections, startIdx, endIdx, seeds, interchangeGroups, destCost, penaltySec) {
  const rounds = [];
  let bound = Infinity;
  let prevArrival = seeds;
  let prevPredecessor = new Map();

  function boardingStop(stopId, depTime) {
    const edges = interchangeGroups.get(stopId) || [{ stopId, transferSec: 0 }];
    for (const { stopId: fromStop, transferSec } of edges) {
      const arr = prevArrival.get(fromStop);
      if (arr !== undefined && arr + transferSec <= depTime) return fromStop;
    }
    return null;
  }

  for (let k = 1; k <= MAX_LEGS; k++) {
    const arrival = new Map(prevArrival);
    const predecessor = new Map(prevPredecessor);
    const tripHop = new Map(); // tripId -> its latest hop this round
    let improved = false;
    for (let i = startIdx; i < endIdx; i++) {
      const c = connections[i];
      if (c.depTime > bound) break;
      let prev = tripHop.get(c.tripId);
      let rootStopId;
      if (prev === undefined) {
        const boardFrom = boardingStop(c.fromStopId, c.depTime);
        if (boardFrom === null) continue;
        prev = prevPredecessor.get(boardFrom) ?? null;
        if (prev === null) {
          if (!seeds.has(boardFrom)) continue;
          rootStopId = boardFrom;
        }
      }
      const hop = {
        tripId: c.tripId, routeId: c.routeId, mode: c.mode,
        fromStopId: c.fromStopId, toStopId: c.toStopId, depTime: c.depTime, arrTime: c.arrTime,
        prevHop: prev,
        legs: prev ? prev.legs + (prev.tripId === c.tripId ? 0 : 1) : 1,
        rootStopId: prev ? prev.rootStopId : rootStopId,
      };
      tripHop.set(c.tripId, hop);
      const best = arrival.get(c.toStopId);
      if (best === undefined || c.arrTime < best) {
        arrival.set(c.toStopId, c.arrTime);
        predecessor.set(c.toStopId, hop);
        improved = true;
        const cost = destCost.get(c.toStopId);
        if (cost !== undefined) bound = Math.min(bound, c.arrTime + cost + penaltySec * (hop.legs - 1));
      }
    }
    rounds.push({ arrival, predecessor });
    if (!improved) break;
    prevArrival = arrival;
    prevPredecessor = predecessor;
  }
  return rounds;
}

// stopId -> weight x walk seconds from that stop to the destination, for every stop the
// destination-side walk covers (see scanRounds' pruning and pickBest's scoring).
function destinationCosts(destWalk, destination, stopRegistry, weight) {
  const costs = new Map();
  destWalk.stops.forEach((stop) => {
    stop.stopIds.forEach((stopId) => {
      const entry = stopRegistry[stopId];
      const walkSec = entry ? walkingMinutesTo(entry[1], entry[2], destination.lat, destination.lon) * 60 : stop.minutes * 60;
      costs.set(stopId, weight * walkSec);
    });
  });
  return costs;
}

// Picks the best destination-side hop across every round. Score = arrival at the stop
// + destWeight x the walk from that specific stop to the destination + transferPenalty
// for each vehicle beyond the first. Only stops actually reached by riding count: a stop
// the origin walk itself seeded could otherwise win as a zero-leg "journey" (a real bug:
// two "Collins St" station entrances 1.3km apart were once merged into one walkable
// stop, giving Southern Cross -> Melbourne Museum a 2-minute trip that boarded nothing).
// Walk is weighed at all because ranking by arrival alone once chose a train to
// Melbourne Central plus a 17-minute walk over a tram stopping at the destination.
function pickBest(rounds, destWalk, destination, stopRegistry, { transferPenaltySec = 0, destWeight = 1 } = {}) {
  let best = null;
  rounds.forEach(({ arrival, predecessor }) => {
    destWalk.stops.forEach((stop) => {
      stop.stopIds.forEach((stopId) => {
        const hop = predecessor.get(stopId);
        if (!hop) return;
        const arr = arrival.get(stopId);
        const entry = stopRegistry[stopId];
        const walkSec = entry ? walkingMinutesTo(entry[1], entry[2], destination.lat, destination.lon) * 60 : stop.minutes * 60;
        const score = arr + destWeight * walkSec + transferPenaltySec * (hop.legs - 1);
        if (!best || score < best.score) best = { score, stopId, arrival: arr, hop };
      });
    });
  });
  return best;
}

// Turns a chosen hop chain into the API's itinerary shape.
function buildItinerary({ best, origin, destination, departureEpochMs, queryDate, queryAbs, originWalk, destWalk, stopRegistry }) {
  const hops = [];
  for (let hop = best.hop; hop; hop = hop.prevHop) hops.push(hop);
  hops.reverse();
  const boardStopId = hops[0].fromStopId;
  const bestStopId = best.stopId;

  // Real epoch ms for a naive wall-clock-digit time on the query's timeline (see the
  // totalMinutes comment below for why the two can't just be subtracted).
  const toEpochMs = (abs) => melbourneWallClockToEpochMs(
    addDays(queryDate, Math.floor(abs / SECONDS_PER_DAY)),
    ((abs % SECONDS_PER_DAY) + SECONDS_PER_DAY) % SECONDS_PER_DAY,
  );

  // Each leg also records every stop it passes with its scheduled time ([stopId, abs
  // seconds]) — the client's live tracking compares the rider's GPS position against
  // these to measure how late the vehicle is actually running (see journey-tracking.js).
  // A boarded trip's hop chain includes every connection from boarding onward, so the
  // intermediate stops are all here.
  const legs = [];
  hops.forEach((hop) => {
    const last = legs[legs.length - 1];
    if (last && last.tripId === hop.tripId) {
      last.alightStopId = hop.toStopId;
      last.alightTime = hop.arrTime;
      last.stops.push([hop.toStopId, hop.arrTime]);
    } else {
      legs.push({
        mode: hop.mode, routeId: hop.routeId, tripId: hop.tripId,
        boardStopId: hop.fromStopId, boardTime: hop.depTime,
        alightStopId: hop.toStopId, alightTime: hop.arrTime,
        stops: [[hop.fromStopId, hop.depTime], [hop.toStopId, hop.arrTime]],
      });
    }
  });

  const nameFor = (stopId) => stopRegistry[stopId]?.[0] ?? stopId;
  // null for tram/V-Line (their stops.txt doesn't carry platform_code at all — see
  // build-stop-names.js) and for train stops without one (e.g. a single-platform stop).
  const platformFor = (stopId) => stopRegistry[stopId]?.[3] ?? null;
  const walkMinutesToStop = (point, stopId, fallback) => {
    const entry = stopRegistry[stopId];
    return entry ? walkingMinutesTo(point.lat, point.lon, entry[1], entry[2]) : fallback;
  };
  const originStop = originWalk.stops.find((s) => s.stopIds.includes(boardStopId))
    ?? originWalk.stops.find((s) => s.stopIds.includes(hops[0].rootStopId))
    ?? originWalk.stops[0];
  const destStop = destWalk.stops.find((s) => s.stopIds.includes(bestStopId)) ?? destWalk.stops[0];

  const legsOut = legs.map((leg, i) => {
    const prev = legs[i - 1];
    return {
      mode: leg.mode,
      routeId: leg.routeId,
      tripId: leg.tripId,
      boardStop: nameFor(leg.boardStopId),
      boardPlatform: platformFor(leg.boardStopId),
      boardTime: formatTimeOfDay(leg.boardTime),
      alightStop: nameFor(leg.alightStopId),
      alightPlatform: platformFor(leg.alightStopId),
      alightTime: formatTimeOfDay(leg.alightTime),
      transferMinutes: prev ? Math.round((leg.boardTime - prev.alightTime) / 60) : null,
      changedPlatform: prev ? prev.alightStopId !== leg.boardStopId : false,
      boardEpochMs: toEpochMs(leg.boardTime),
      alightEpochMs: toEpochMs(leg.alightTime),
      stops: leg.stops.map(([stopId, abs]) => {
        const entry = stopRegistry[stopId];
        return { stopId, name: entry?.[0] ?? stopId, lat: entry?.[1] ?? null, lon: entry?.[2] ?? null, epochMs: toEpochMs(abs) };
      }),
    };
  });

  // totalMinutes deliberately does NOT come from (arrival - queryAbs) / 60 — both are
  // naive wall-clock-digit seconds (see buildConnections/melbourneWallClockToEpochMs
  // headers), and diffing them directly silently gains or loses an hour for any journey
  // whose *scheduled* span crosses a Melbourne DST transition (confirmed: a real trip
  // spanning 2026-10-04's spring-forward gap reported 190 minutes for what is actually a
  // 130-minute wait+journey in real time). Converting the arrival's wall-clock reading
  // back to a real epoch and diffing against the real departureEpochMs gives the true
  // elapsed duration instead.
  const arrivalDateStr = addDays(queryDate, Math.floor(best.arrival / SECONDS_PER_DAY));
  const arrivalSecondsOfDay = ((best.arrival % SECONDS_PER_DAY) + SECONDS_PER_DAY) % SECONDS_PER_DAY;
  const arrivalEpochMs = melbourneWallClockToEpochMs(arrivalDateStr, arrivalSecondsOfDay);

  return {
    ok: true,
    query: { date: queryDate, time: formatTimeOfDay(queryAbs) },
    // Walk times measured to the specific stop_id actually boarded/alighted at, not the
    // walkable-stop cluster's nearest member.
    origin: { walkMinutes: Math.round(walkMinutesToStop(origin, boardStopId, originStop.minutes)), stopName: originStop.name, withinCap: originWalk.withinCap },
    destination: { walkMinutes: Math.round(walkMinutesToStop(destination, bestStopId, walkingMinutesTo(destination.lat, destination.lon, destStop.lat, destStop.lon))), stopName: destStop.name, withinCap: destWalk.withinCap },
    legs: legsOut,
    totalMinutes: Math.round((arrivalEpochMs - departureEpochMs) / 60000),
    arriveBy: formatTimeOfDay(best.arrival),
    arrivalEpochMs,
  };
}

const OPTION_KINDS = ['fastest', 'simplest', 'least_walking'];

// Two options are the same journey if they ride the same vehicles between the same stops.
function itinerarySignature(itinerary) {
  return itinerary.legs.map((l) => `${l.tripId}:${l.boardStop}>${l.alightStop}`).join('|');
}

// One planner run per departure time, returning every option kind that found a
// journey: { ok, options: [{ kinds: [...], ...itinerary }] }. Options riding the same
// vehicles end-to-end are merged into one entry carrying every kind they satisfy (a
// journey that's both fastest and simplest shows once, labelled both). Fastest and
// Simplest share one scan; Least walking needs its own because its tighter walk cap
// changes which stops get seeded at all.
export function planJourneyOptions({
  origin, destination, departureEpochMs, schedules, stopRegistry, capMinutes = DEFAULT_WALK_CAP_MINUTES, latestDepartureAbs,
  kinds = OPTION_KINDS,
}) {
  const { dateStr: queryDate, seconds: queryAbs } = melbourneDateAndSeconds(departureEpochMs);

  // stopRegistry is already merged across modes, so findWalkableStops only needs one table.
  const stopTable = [{ mode: 'rail', stopNames: stopRegistry }];
  const originWalk = findWalkableStops(origin.lat, origin.lon, stopTable, { capMinutes });
  const destWalk = findWalkableStops(destination.lat, destination.lon, stopTable, { capMinutes });
  if (originWalk.stops.length === 0 || destWalk.stops.length === 0) {
    return { ok: false, reason: 'no_walkable_stops', originWalk, destWalk };
  }

  const interchangeGroups = getInterchangeGroups(stopRegistry);
  const connections = getConnections(schedules, queryDate);
  const startIdx = firstIndexAtOrAfter(connections, queryAbs);
  // Nothing departing after this can be part of a useful answer, so the scan stops there
  // instead of running to the end of the day — the difference between ~10s and well
  // under that for an arrive-by search on the live function. Arrive-by passes its own
  // target (a connection leaving after it can't get you there in time); otherwise
  // MAX_JOURNEY_SPAN_SEC past the departure.
  const endIdx = firstIndexAtOrAfter(connections, (latestDepartureAbs ?? queryAbs + MAX_JOURNEY_SPAN_SEC) + 1);
  const ctx = { origin, destination, departureEpochMs, queryDate, queryAbs, stopRegistry };

  const picks = [];
  if (kinds.includes('fastest') || kinds.includes('simplest')) {
    // One scan serves both; it prunes against Simplest's (stricter) score, which is never
    // below Fastest's, so nothing Fastest needs gets cut.
    const rounds = scanRounds(connections, startIdx, endIdx, seedArrivals(originWalk, queryAbs), interchangeGroups,
      destinationCosts(destWalk, destination, stopRegistry, 1), kinds.includes('simplest') ? SIMPLEST_TRANSFER_PENALTY_SEC : 0);
    const fastest = kinds.includes('fastest') && pickBest(rounds, destWalk, destination, stopRegistry);
    if (fastest) picks.push(['fastest', fastest, originWalk, destWalk]);
    const simplest = kinds.includes('simplest') && pickBest(rounds, destWalk, destination, stopRegistry, { transferPenaltySec: SIMPLEST_TRANSFER_PENALTY_SEC });
    if (simplest) picks.push(['simplest', simplest, originWalk, destWalk]);
  }

  const lwCap = Math.min(capMinutes, LEAST_WALKING_CAP_MINUTES);
  const lwOriginWalk = findWalkableStops(origin.lat, origin.lon, stopTable, { capMinutes: lwCap });
  const lwDestWalk = findWalkableStops(destination.lat, destination.lon, stopTable, { capMinutes: lwCap });
  // Only meaningful when both ends genuinely have a stop inside the tighter cap —
  // findWalkableStops falls back to the single nearest stop otherwise, which would just
  // reproduce a long walk under a "Least walking" label.
  if (kinds.includes('least_walking') && lwOriginWalk.withinCap && lwDestWalk.withinCap && lwOriginWalk.stops.length && lwDestWalk.stops.length) {
    const lwRounds = scanRounds(connections, startIdx, endIdx, seedArrivals(lwOriginWalk, queryAbs), interchangeGroups,
      destinationCosts(lwDestWalk, destination, stopRegistry, LEAST_WALKING_DEST_WEIGHT), 0);
    const leastWalking = pickBest(lwRounds, lwDestWalk, destination, stopRegistry, { destWeight: LEAST_WALKING_DEST_WEIGHT });
    if (leastWalking) picks.push(['least_walking', leastWalking, lwOriginWalk, lwDestWalk]);
  }

  if (picks.length === 0) return { ok: false, reason: 'no_journey_found', originWalk, destWalk };

  const options = [];
  picks.forEach(([kind, best, oWalk, dWalk]) => {
    const itinerary = buildItinerary({ ...ctx, best, originWalk: oWalk, destWalk: dWalk });
    const existing = options.find((o) => itinerarySignature(o) === itinerarySignature(itinerary));
    if (existing) existing.kinds.push(kind);
    else options.push({ kinds: [kind], ...itinerary });
  });
  return { ok: true, options };
}

// origin/destination: { lat, lon }. schedules: [{ mode, data }]. stopRegistry:
// stopId -> [name, lat, lon, platform] (merged across modes). Returns just the Fastest
// option in the original single-itinerary shape — kept for existing callers and tests;
// new callers should use planJourneyOptions.
export function planJourney(args) {
  const result = planJourneyOptions(args);
  if (!result.ok) return result;
  const { kinds, ...fastest } = result.options.find((o) => o.kinds.includes('fastest'));
  return fastest;
}

// "Arrive by Z" — answered by binary-searching planJourneyOptions' own departure time,
// not a separate reverse-CSA implementation. This relies on one property: querying a
// later departure can only ever see a subset of an earlier query's connections
// (anything with c.depTime < queryAbs is dropped), so the earliest possible arrival is
// non-decreasing as departure time increases. That makes "does departing at time t
// still arrive by Z" a sorted-boolean search — the latest still-valid t is the answer —
// without writing and maintaining a reverse-direction version of the scan.
//
// Each option kind gets its own search (the latest departure whose Fastest arrives in
// time isn't necessarily the latest whose Simplest does). Probes are memoized by
// minute, so the three searches share most of their work, and each probe reuses the
// cached connections for the day (see getConnections), so a probe is only the scan.
//
// The monotonicity above is strict for Fastest. Simplest and Least walking rank by more
// than arrival, so their search can occasionally settle on a slightly earlier departure
// than the latest that would work — the result always genuinely arrives by Z (each
// probe's arrival is checked directly), it just may not be the last possible one.
const ARRIVE_BY_STEP_MS = 60 * 1000; // minute-granularity search, matching this planner's own display precision

export function planJourneyOptionsArrivingBy({
  origin, destination, arriveByEpochMs, schedules, stopRegistry, capMinutes = DEFAULT_WALK_CAP_MINUTES,
}) {
  // Memoized per minute *and* per scan: Fastest and Simplest share a scan, Least walking
  // needs its own, so a probe for one never pays for the other.
  const probes = new Map();
  const scanKinds = (kind) => (kind === 'least_walking' ? ['least_walking'] : ['fastest', 'simplest']);
  const probe = (minute, kind = 'fastest') => {
    const key = `${minute}:${scanKinds(kind)[0]}`;
    if (!probes.has(key)) {
      probes.set(key, planJourneyOptions({
        kinds: scanKinds(kind),
        origin, destination, departureEpochMs: minute * ARRIVE_BY_STEP_MS, schedules, stopRegistry, capMinutes,
        // Same-day window (below), so the probe's query date is the target's date and the
        // target's seconds-of-day is directly comparable to its connections' times.
        latestDepartureAbs: targetSeconds,
      }));
    }
    return probes.get(key);
  };
  // Uses the planner's own real-epoch arrivalEpochMs directly rather than re-deriving
  // departure + totalMinutes — see buildItinerary's totalMinutes comment for why.
  const optionFor = (result, kind) => (result.ok ? result.options.find((o) => o.kinds.includes(kind)) : undefined);

  // Restricted to departures on the SAME Melbourne calendar day as the target arrival
  // (from local midnight up to the target time), not an arbitrary lookback window. This
  // isn't just a scope simplification — it's what keeps the binary search correct. The
  // non-decreasing-arrival property only holds while queryDate(t) — and therefore the
  // exact connections planJourneyOptions scans — stays fixed. Once a window crosses
  // local midnight, a recurring daily service can make "still reachable" flip
  // true/false/true as t increases (confirmed by hand-tracing a 24h-lookback version
  // against the synthetic weekday fixture). Practical effect: an overnight trip needs
  // the query framed as arriving "tomorrow", not a lookback past midnight.
  const { seconds: targetSeconds } = melbourneDateAndSeconds(arriveByEpochMs);
  const hiMin = Math.floor(arriveByEpochMs / ARRIVE_BY_STEP_MS);
  // ...and no earlier than MAX_JOURNEY_SPAN_SEC before the target: a departure further
  // back than the longest journey worth planning can't be the latest one that works.
  const loMin = hiMin - Math.floor(Math.min(targetSeconds, MAX_JOURNEY_SPAN_SEC) / 60);

  // A failure that isn't time-dependent (no walkable stop at all near either end) fails
  // identically at every departure time — surface that specific reason immediately.
  const hiResult = probe(hiMin);
  if (!hiResult.ok && hiResult.reason === 'no_walkable_stops') return hiResult;

  const picks = [];
  OPTION_KINDS.forEach((kind) => {
    let lo = loMin;
    let hi = hiMin;
    let found = null;
    while (lo <= hi) {
      const mid = lo + Math.floor((hi - lo) / 2);
      const option = optionFor(probe(mid, kind), kind);
      if (option && option.arrivalEpochMs <= arriveByEpochMs) {
        found = option;
        lo = mid + 1; // this departure works — try a later (closer to the target) one
      } else {
        hi = mid - 1; // too late to arrive in time — try an earlier departure
      }
    }
    if (found) picks.push([kind, found]);
  });

  if (picks.length === 0) return { ok: false, reason: 'unreachable_by_target' };

  // Merge kinds that settled on the same journey (possibly found via different probes).
  const options = [];
  picks.forEach(([kind, option]) => {
    const signature = itinerarySignature(option);
    const existing = options.find((o) => itinerarySignature(o) === signature);
    if (existing) existing.kinds.push(kind);
    else options.push({ ...option, kinds: [kind] });
  });
  return { ok: true, options, requestedArriveBy: formatTimeOfDay(targetSeconds) };
}

// Fastest-only "arrive by", in the original single-itinerary shape — kept for existing
// callers and tests; new callers should use planJourneyOptionsArrivingBy.
export function planJourneyArrivingBy(args) {
  const result = planJourneyOptionsArrivingBy(args);
  if (!result.ok) return result;
  const fastest = result.options.find((o) => o.kinds.includes('fastest'));
  if (!fastest) return { ok: false, reason: 'unreachable_by_target' };
  const { kinds, ...itinerary } = fastest;
  return { ...itinerary, requestedArriveBy: result.requestedArriveBy };
}
