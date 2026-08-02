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
function buildConnections(schedule, mode, serviceDate, queryDate, activeServices) {
  const dayOffset = epochDay(serviceDate) - epochDay(queryDate);
  const baseSeconds = dayOffset * SECONDS_PER_DAY;
  const connections = [];
  Object.entries(schedule.trips).forEach(([tripId, trip]) => {
    if (!activeServices.has(trip.s)) return;
    const { stops } = trip;
    const routeId = schedule.routeIds[trip.r];
    for (let i = 0; i < stops.length - 1; i++) {
      const [fromIdx, , depRaw] = stops[i];
      const [toIdx, arrRaw] = stops[i + 1];
      if (depRaw == null || arrRaw == null) continue;
      connections.push({
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
  return connections;
}

// Groups a stop-name registry (stopId -> [name, lat, lon]) by name, so mid-journey
// transfers between platforms of the same station (different stop_id, same name — the
// exact case Phase 1's findWalkableStops already collapses for display) can be modelled
// as a short walking edge rather than requiring an exact stop_id match to continue.
function buildInterchangeGroups(stopRegistry) {
  const byName = new Map();
  Object.entries(stopRegistry).forEach(([stopId, [name, lat, lon]]) => {
    if (!byName.has(name)) byName.set(name, []);
    byName.get(name).push({ stopId, lat, lon });
  });

  const groups = new Map(); // stopId -> [{ stopId, transferSec }]
  byName.forEach((members) => {
    members.forEach((self) => {
      const edges = [];
      members.forEach((other) => {
        if (other.stopId === self.stopId) {
          edges.push({ stopId: other.stopId, transferSec: MIN_TRANSFER_SEC });
          return;
        }
        const walkMinutes = walkingMinutesTo(self.lat, self.lon, other.lat, other.lon);
        if (walkMinutes > MAX_INTERCHANGE_WALK_MINUTES) return;
        edges.push({ stopId: other.stopId, transferSec: Math.round(walkMinutes * 60) + MIN_TRANSFER_SEC });
      });
      groups.set(self.stopId, edges);
    });
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

// origin/destination: { lat, lon }. schedules: [{ mode, data }]. stopRegistry:
// stopId -> [name, lat, lon] (merged across modes — safe because train and V/Line
// share one PTV-wide stop_id space, confirmed against real data before relying on it).
export function planJourney({ origin, destination, departureEpochMs, schedules, stopRegistry, capMinutes = DEFAULT_WALK_CAP_MINUTES }) {
  const { dateStr: queryDate, seconds: queryTime } = melbourneDateAndSeconds(departureEpochMs);
  const queryAbs = queryTime;

  // stopRegistry is already merged across train+V/Line (shared stop_id space,
  // confirmed against real data), so findWalkableStops only needs one table entry.
  const stopTable = [{ mode: 'rail', stopNames: stopRegistry }];
  const originWalk = findWalkableStops(origin.lat, origin.lon, stopTable, { capMinutes });
  const destWalk = findWalkableStops(destination.lat, destination.lon, stopTable, { capMinutes });

  if (originWalk.stops.length === 0 || destWalk.stops.length === 0) {
    return { ok: false, reason: 'no_walkable_stops', originWalk, destWalk };
  }

  const interchangeGroups = getInterchangeGroups(stopRegistry);

  // Build connections for the query date and the day before (to catch post-midnight
  // overflow trips whose service belongs to the previous service day).
  const connections = [];
  schedules.forEach(({ mode, data }) => {
    [queryDate, addDays(queryDate, -1)].forEach((serviceDate) => {
      const active = resolveActiveServices(data, serviceDate);
      if (active.size === 0) return;
      connections.push(...buildConnections(data, mode, serviceDate, queryDate, active));
    });
  });
  connections.sort((a, b) => a.depTime - b.depTime);

  const earliestArrival = new Map(); // stopId -> absSeconds
  // stopId -> hop, where a hop is an immutable snapshot: { ..., prevHop: <hop for
  // fromStopId at the moment this hop was created, or null>. Capturing prevHop by
  // reference (not re-resolving fromStopId through this Map later) matters — see the
  // long comment at the backtrack site below for why a naive "look fromStopId up in this
  // Map when reconstructing" approach can produce an unfollowable cycle.
  const predecessor = new Map();
  const inTrip = new Set(); // tripId currently boarded/continuing

  originWalk.stops.forEach((stop) => {
    const arriveAt = queryAbs + Math.ceil(stop.minutes * 60);
    stop.stopIds.forEach((stopId) => {
      const existing = earliestArrival.get(stopId);
      if (existing === undefined || arriveAt < existing) earliestArrival.set(stopId, arriveAt);
    });
  });

  // Returns the interchange-group member stop whose earliest arrival actually permits
  // boarding this connection — may differ from `stopId` itself when boarding requires a
  // same-station platform transfer (e.g. the rider's earliest arrival is at S2, but this
  // connection departs from a different stop_id, S2B, sharing S2's station name). Null
  // if nothing in the group permits it in time.
  function boardingStop(stopId, depTime) {
    const edges = interchangeGroups.get(stopId) || [{ stopId, transferSec: 0 }];
    for (const { stopId: fromStop, transferSec } of edges) {
      const arr = earliestArrival.get(fromStop);
      if (arr !== undefined && arr + transferSec <= depTime) return fromStop;
    }
    return null;
  }

  for (const c of connections) {
    if (c.depTime < queryAbs) continue;
    // inTrip.has(c.tripId): already riding this trip, so the boarding stop is simply
    // wherever it was already boarded (c.fromStopId itself) — no interchange lookup
    // needed or correct here, since earliestArrival was never separately recorded for
    // every intermediate stop_id of a trip already being ridden.
    const boardFromStop = inTrip.has(c.tripId) ? c.fromStopId : boardingStop(c.fromStopId, c.depTime);
    if (boardFromStop === null) continue;
    inTrip.add(c.tripId);
    const currentBest = earliestArrival.get(c.toStopId);
    if (currentBest !== undefined && currentBest <= c.arrTime) continue;
    earliestArrival.set(c.toStopId, c.arrTime);
    predecessor.set(c.toStopId, {
      tripId: c.tripId, routeId: c.routeId, mode: c.mode,
      fromStopId: c.fromStopId, toStopId: c.toStopId, depTime: c.depTime, arrTime: c.arrTime,
      // Linked via boardFromStop, not c.fromStopId — see boardingStop's comment above.
      // Using c.fromStopId directly here was a real bug this file's test suite caught:
      // predecessor has no entry for a stop_id nobody ever actually arrived at via a
      // connection, so the chain silently truncated at the first platform-transfer,
      // dropping every earlier leg from the reconstructed itinerary while totalMinutes/
      // arriveBy (computed independently, from earliestArrival) still reported the full,
      // correct journey time — an itinerary that claimed a duration its own displayed
      // legs didn't account for.
      prevHop: predecessor.get(boardFromStop) ?? null,
    });
  }

  // Best destination-side stop: earliest arrival among every stop_id the destination
  // candidate walk covers (multi-platform stations resolve to several stop_ids).
  let bestStopId = null;
  let bestArrival = Infinity;
  destWalk.stops.forEach((stop) => {
    stop.stopIds.forEach((stopId) => {
      const arr = earliestArrival.get(stopId);
      if (arr !== undefined && arr < bestArrival) {
        bestArrival = arr;
        bestStopId = stopId;
      }
    });
  });

  if (bestStopId === null) {
    return { ok: false, reason: 'no_journey_found', originWalk, destWalk };
  }

  // Walk the hop chain back to an origin-seeded stop (prevHop null), merging consecutive
  // hops on the same trip into a single ride leg.
  //
  // This walks prevHop references, not a fresh Map.get(fromStopId) lookup — deliberately.
  // predecessor is last-write-wins as the sweep finds improvements, so by the time
  // reconstruction runs, predecessor.get(someStopId) reflects that stop's *final* best
  // arrival, which isn't necessarily the one this hop's connection actually boarded
  // against. Two different connections can each legitimately improve the other's stop
  // (confirmed against real data: V/Line's Richmond<->Flinders St connections run both
  // directions), which, if reconstruction re-resolves fromStopId through the live Map,
  // can produce predecessor[A] and predecessor[B] pointing at each other — an
  // unfollowable cycle despite each being individually valid when it was written.
  // prevHop sidesteps this entirely: it's captured once, at the moment this hop is
  // created, as a snapshot of whatever hop.fromStopId's chain was *then* — and since hop
  // objects are never mutated after creation (only replaced), that snapshot can't later
  // be invalidated by a subsequent improvement. Following prevHop is therefore a DAG walk
  // by construction, not just a cycle-guarded one.
  const hops = [];
  let hop = predecessor.get(bestStopId) ?? null;
  while (hop) {
    hops.push(hop);
    hop = hop.prevHop;
  }
  hops.reverse();
  const boardStopId = hops.length > 0 ? hops[0].fromStopId : bestStopId; // where the walking leg from origin lands

  const legs = [];
  hops.forEach((hop) => {
    const last = legs[legs.length - 1];
    if (last && last.tripId === hop.tripId) {
      last.alightStopId = hop.toStopId;
      last.alightTime = hop.arrTime;
    } else {
      legs.push({
        mode: hop.mode,
        routeId: hop.routeId,
        tripId: hop.tripId,
        boardStopId: hop.fromStopId,
        boardTime: hop.depTime,
        alightStopId: hop.toStopId,
        alightTime: hop.arrTime,
      });
    }
  });

  const nameFor = (stopId) => stopRegistry[stopId]?.[0] ?? stopId;
  const originStopIdx = originWalk.stops.findIndex((s) => s.stopIds.includes(boardStopId));
  const originStop = originStopIdx >= 0 ? originWalk.stops[originStopIdx] : originWalk.stops[0];
  const destStop = destWalk.stops.find((s) => s.stopIds.includes(bestStopId)) ?? destWalk.stops[0];

  const legsOut = legs.map((leg, i) => {
    const prev = legs[i - 1];
    const transferMinutes = prev ? Math.round((leg.boardTime - prev.alightTime) / 60) : null;
    const changedPlatform = prev ? prev.alightStopId !== leg.boardStopId : false;
    return {
      mode: leg.mode,
      routeId: leg.routeId,
      tripId: leg.tripId,
      boardStop: nameFor(leg.boardStopId),
      boardTime: formatTimeOfDay(leg.boardTime),
      alightStop: nameFor(leg.alightStopId),
      alightTime: formatTimeOfDay(leg.alightTime),
      transferMinutes,
      changedPlatform,
    };
  });

  const totalMinutes = Math.round((bestArrival - queryAbs) / 60);

  return {
    ok: true,
    query: { date: queryDate, time: formatTimeOfDay(queryAbs) },
    origin: { walkMinutes: Math.round(originStop.minutes), stopName: originStop.name, withinCap: originWalk.withinCap },
    destination: { walkMinutes: Math.round(walkingMinutesTo(destination.lat, destination.lon, destStop.lat, destStop.lon)), stopName: destStop.name, withinCap: destWalk.withinCap },
    legs: legsOut,
    totalMinutes,
    arriveBy: formatTimeOfDay(bestArrival),
  };
}

// "Arrive by Z" — answered by binary-searching planJourney's own departure time, not a
// separate reverse-CSA implementation. This relies on one property: querying a later
// departure can only ever see a subset of an earlier query's connections (anything with
// c.depTime < queryAbs is dropped), so the resulting arrival time is non-decreasing as
// departure time increases. That makes "does departing at time t still arrive by Z" a
// simple sorted-boolean-array search — the latest still-valid t is the answer — without
// writing and separately maintaining a second, reverse-direction version of the CSA scan
// (and re-risking the same class of reconstruction bug the forward version had).
// Costs ~11 forward planJourney calls (log2 of the search window in minutes) instead of
// one; accepted as the simpler-to-get-correct tradeoff, matching this file's existing
// CSA-over-RAPTOR rationale.
const ARRIVE_BY_STEP_MS = 60 * 1000; // minute-granularity search, matching this planner's own display precision

export function planJourneyArrivingBy({
  origin, destination, arriveByEpochMs, schedules, stopRegistry, capMinutes = DEFAULT_WALK_CAP_MINUTES,
}) {
  function attempt(departureEpochMs) {
    const result = planJourney({ origin, destination, departureEpochMs, schedules, stopRegistry, capMinutes });
    const arrivalEpochMs = result.ok ? departureEpochMs + result.totalMinutes * 60000 : Infinity;
    return { result, arrivalEpochMs };
  }

  // Restricted to departures on the SAME Melbourne calendar day as the target arrival
  // (from local midnight up to the target time), not an arbitrary lookback window. This
  // isn't just a scope simplification — it's what keeps the binary search below correct.
  // The non-decreasing-arrival property above only holds while queryDate(t) — and
  // therefore the exact connections array planJourney filters — stays fixed. Once a
  // search window crosses local midnight, buildConnections rebuilds against a different
  // D/D-1 pair per candidate t, and a recurring daily service can make "still reachable"
  // flip true/false/true as t increases, which breaks binary search's core assumption
  // (confirmed by hand-tracing a 24h-lookback version against this file's synthetic
  // weekday fixture before landing on this same-day bound instead). Practical effect: an
  // overnight trip (e.g. depart 11pm, arrive by 6am) needs the query framed as arriving
  // "tomorrow", not a lookback past midnight from an evening departure.
  const { seconds: targetSeconds } = melbourneDateAndSeconds(arriveByEpochMs);
  const hiMin = Math.floor(arriveByEpochMs / ARRIVE_BY_STEP_MS);
  const loMin = hiMin - Math.floor(targetSeconds / 60);

  // A failure here that isn't time-dependent (no walkable stop at all near the origin or
  // destination) will fail identically at every departure time in the window — surface
  // that specific reason immediately rather than a generic "unreachable".
  const hiAttempt = attempt(hiMin * ARRIVE_BY_STEP_MS);
  if (!hiAttempt.result.ok && hiAttempt.result.reason === 'no_walkable_stops') return hiAttempt.result;

  let lo = loMin;
  let hi = hiMin;
  let bestMin = null;
  let bestResult = null;
  while (lo <= hi) {
    const mid = lo + Math.floor((hi - lo) / 2);
    const { result, arrivalEpochMs } = attempt(mid * ARRIVE_BY_STEP_MS);
    if (arrivalEpochMs <= arriveByEpochMs) {
      bestMin = mid;
      bestResult = result;
      lo = mid + 1; // this departure works — try a later (closer to the target) one
    } else {
      hi = mid - 1; // too late to arrive in time — try an earlier departure
    }
  }

  if (bestMin === null) {
    return { ok: false, reason: 'unreachable_by_target' };
  }
  return { ...bestResult, requestedArriveBy: formatTimeOfDay(targetSeconds) };
}
