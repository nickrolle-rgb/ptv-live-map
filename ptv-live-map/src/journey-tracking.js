// Live tracking for a selected journey: is the rider on the vehicle they planned to be
// on, how late is it actually running, and will they still make each connection?
//
// The primary signal is the rider's own GPS, matched against the leg they're riding:
// project their position onto the leg's path, look up where the vehicle *should* be
// at this moment from the timetabled stop times the planner returns with each leg, and
// the difference is the delay. That works for trams too, where the live vehicle feed's
// trip IDs don't line up with the published timetable at all. The vehicle feed
// (trip-updates) is the fallback for when GPS can't help: underground in the City Loop
// or Metro Tunnel, or before boarding, when the question is whether the first service
// is late.
//
// Deliberately free of DOM/Leaflet/app state, so it can be tested on its own.

import { walkingMinutesTo } from './journey.js';

// GPS within this distance of a leg's path counts as being on it. Generous enough for
// urban GPS error and for a straight-line fallback path cutting a gentle curve.
export const ON_ROUTE_METERS = 150;
// Wider tolerance for a straight-line fallback path (no route shape matched): between
// two distant stops the real track can bow well away from the straight line, and a
// too-tight tolerance there would read a rider on board as "not on it" — a false
// "missed it" alarm.
export const ON_ROUTE_FALLBACK_METERS = 600;
// Must be at least this far along the path from the boarding stop before it counts as
// riding — standing at the boarding stop is on the path too, but isn't riding yet.
export const PAST_BOARDING_METERS = 200;
// Older than this and a GPS fix says nothing reliable about where the rider is now.
export const GPS_FRESH_MS = 60 * 1000;
// Realistic minimum to physically change vehicles, matching the planner's own.
export const MIN_TRANSFER_MS = 120 * 1000;
// How long past a vehicle's (delay-adjusted) departure before not being on it counts
// as having missed it — absorbs a slow GPS fix or a vehicle just pulling out.
export const MISSED_GRACE_MS = 3 * 60 * 1000;
// Never call a vehicle more than this early: a GPS position slightly ahead of the
// interpolated schedule is far likelier to be timing noise than a genuinely early
// service.
const MAX_EARLY_MS = 2 * 60 * 1000;
// A stop more than this far from a candidate shape line means that line isn't this leg.
const SHAPE_MATCH_METERS = 200;

const EARTH_RADIUS_M = 6371000;

// Equirectangular projection to local metres around a reference latitude — accurate
// to well under a metre over a city-sized area, and cheap.
function toXY(lat, lon, lat0) {
  const rad = Math.PI / 180;
  return [lon * rad * EARTH_RADIUS_M * Math.cos(lat0 * rad), lat * rad * EARTH_RADIUS_M];
}

function makePath(latLons, lat0) {
  const points = latLons.map(([lat, lon]) => toXY(lat, lon, lat0));
  const cum = [0];
  for (let i = 1; i < points.length; i++) {
    cum.push(cum[i - 1] + Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1]));
  }
  return { points, cum, lat0 };
}

// Nearest point on the path to (lat, lon) at or beyond minAlong metres along it.
// Returns { along, offset, seg } — distance along the path, metres off it, and which
// segment matched. minAlong is what keeps a route that passes the same spot twice (the
// City Loop) from snapping a later stop back onto the earlier pass.
function project(path, lat, lon, minAlong = 0) {
  const [px, py] = toXY(lat, lon, path.lat0);
  let best = { along: 0, offset: Infinity, seg: 0 };
  for (let i = 0; i < path.points.length - 1; i++) {
    if (path.cum[i + 1] < minAlong) continue;
    const [ax, ay] = path.points[i];
    const [bx, by] = path.points[i + 1];
    const dx = bx - ax;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy;
    const segLen = Math.sqrt(len2);
    const tMin = segLen === 0 ? 0 : Math.max(0, (minAlong - path.cum[i]) / segLen);
    const t = len2 === 0 ? 0 : Math.max(tMin, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2));
    const offset = Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
    if (offset < best.offset) best = { along: path.cum[i] + t * segLen, offset, seg: i };
  }
  return best;
}

// Builds the path a leg's vehicle travels, with each of the leg's stops placed along
// it. Prefers the route's real shape (so a curve or a long V/Line run isn't a straight
// line through paddocks); stops are projected strictly forward along it, one after the
// other, so a route that passes the same place twice (the City Loop) can't send a later
// stop back to an earlier pass. Falls back to straight lines between consecutive stops
// when no shape fits — less precise between stops, but stop times stay exact.
// Returns null when the leg has no usable stop coordinates (live-matched options don't
// carry a stop list, so they can't be tracked this way).
export function buildLegPath(leg, shapeLines = []) {
  const stops = (leg.stops ?? []).filter((s) => Number.isFinite(s.lat) && Number.isFinite(s.lon));
  if (stops.length < 2 || stops.length !== (leg.stops ?? []).length) return null;
  const lat0 = stops[0].lat;

  for (const line of shapeLines) {
    if (!Array.isArray(line) || line.length < 2) continue;
    const path = makePath(line, lat0);
    const stopAlong = [];
    let ok = true;
    for (const stop of stops) {
      const p = project(path, stop.lat, stop.lon, stopAlong.length ? stopAlong[stopAlong.length - 1] : 0);
      if (p.offset > SHAPE_MATCH_METERS) { ok = false; break; }
      stopAlong.push(p.along);
    }
    if (ok) return { ...path, stopAlong, source: 'shape' };
  }

  const path = makePath(stops.map((s) => [s.lat, s.lon]), lat0);
  return { ...path, stopAlong: path.cum.slice(), source: 'stops' };
}

// Where the rider is along this leg, if they're plausibly on it: within ON_ROUTE_METERS
// of the path, between the boarding and alighting stops.
export function locateOnLeg(path, lat, lon) {
  const first = path.stopAlong[0];
  const last = path.stopAlong[path.stopAlong.length - 1];
  // Search only from the boarding stop onward — a shape-based path covers the whole
  // route, which can extend well before the leg starts.
  const p = project(path, lat, lon, first);
  const tolerance = path.source === 'shape' ? ON_ROUTE_METERS : ON_ROUTE_FALLBACK_METERS;
  if (p.offset > tolerance || p.along < first - tolerance || p.along > last + tolerance) return null;
  return { along: Math.max(first, Math.min(last, p.along)), offset: p.offset };
}

// The timetabled moment a vehicle on this leg should be at `along`, interpolating
// between the two stops either side.
export function scheduledEpochAt(leg, path, along) {
  const sa = path.stopAlong;
  for (let i = 0; i < sa.length - 1; i++) {
    if (along <= sa[i + 1]) {
      const span = sa[i + 1] - sa[i];
      const f = span <= 0 ? 0 : Math.max(0, (along - sa[i]) / span);
      return leg.stops[i].epochMs + f * (leg.stops[i + 1].epochMs - leg.stops[i].epochMs);
    }
  }
  return leg.stops[leg.stops.length - 1].epochMs;
}

// Delay of a leg's vehicle from the live vehicle feed: the first of the leg's own stops
// that appears in the trip's realtime update, predicted time minus scheduled. tripUpdate
// is the trip-updates shape ({ stops: [{ stopId, arrival, departure }] }, epoch seconds).
export function vehicleFeedDelayMs(leg, tripUpdate) {
  if (!tripUpdate?.stops || !leg.stops) return null;
  for (const rt of tripUpdate.stops) {
    const scheduled = leg.stops.find((s) => s.stopId === rt.stopId);
    const predicted = rt.arrival ?? rt.departure;
    if (scheduled && predicted != null) return predicted * 1000 - scheduled.epochMs;
  }
  return null;
}

function transferNeedMs(fromLeg, toLeg) {
  const a = fromLeg.stops?.[fromLeg.stops.length - 1];
  const b = toLeg.stops?.[0];
  const walkMs = a && b && Number.isFinite(a.lat) && Number.isFinite(b.lat)
    ? walkingMinutesTo(a.lat, a.lon, b.lat, b.lon) * 60 * 1000
    : 0;
  return MIN_TRANSFER_MS + walkMs;
}

// The whole assessment, recomputed from scratch on every GPS fix / data refresh.
//
// itinerary.legs: [{ stops: [{ stopId, name, lat, lon, epochMs }], boardEpochMs,
//   alightEpochMs, ... }]. paths: buildLegPath per leg (or null). position:
//   { lat, lon, timestampMs } | null. vehicleDelayMs(legIndex) -> ms | null.
//
// Returns:
// - ridingLegIndex: the leg GPS places the rider on, or null.
// - legs[i]: { delayMs, source: 'gps'|'vehicle'|null, predictedBoardEpochMs,
//   predictedAlightEpochMs } — unknown delays are treated as on time.
// - problem: null, or the first thing that breaks the plan from here on:
//   { type: 'connection', fromLeg, toLeg, shortByMs, atStop, predictedArrivalEpochMs }
//   { type: 'missed', legIndex }
// - finished: the last leg's predicted arrival is well in the past.
export function assessItinerary(itinerary, { nowMs, position, paths, vehicleDelayMs = () => null }) {
  const legs = itinerary.legs;
  const gpsFresh = Boolean(position) && nowMs - position.timestampMs <= GPS_FRESH_MS;

  let ridingLegIndex = null;
  let ridingAlong = null;
  if (gpsFresh) {
    legs.forEach((leg, i) => {
      const path = paths[i];
      if (!path || nowMs < leg.boardEpochMs - 10 * 60 * 1000) return;
      const spot = locateOnLeg(path, position.lat, position.lon);
      if (!spot || spot.along - path.stopAlong[0] < PAST_BOARDING_METERS) return;
      ridingLegIndex = i; // the latest matching leg wins — a later leg can share track with an earlier one
      ridingAlong = spot.along;
    });
  }

  const out = legs.map((leg, i) => {
    let delayMs = null;
    let source = null;
    if (i === ridingLegIndex) {
      delayMs = Math.max(-MAX_EARLY_MS, nowMs - scheduledEpochAt(leg, paths[i], ridingAlong));
      source = 'gps';
    } else {
      const v = vehicleDelayMs(i);
      if (v != null) { delayMs = Math.max(-MAX_EARLY_MS, v); source = 'vehicle'; }
    }
    return {
      delayMs,
      source,
      predictedBoardEpochMs: leg.boardEpochMs + (delayMs ?? 0),
      predictedAlightEpochMs: leg.alightEpochMs + (delayMs ?? 0),
    };
  });

  const finished = nowMs > out[out.length - 1].predictedAlightEpochMs + 30 * 60 * 1000;
  let problem = null;

  // Missed a vehicle: well past its (delay-adjusted) departure, fresh GPS, and not on
  // it. Only for the leg that should be underway now — and only with fresh GPS, so a
  // rider underground (no fix) is never told they've missed something they're on.
  if (gpsFresh && ridingLegIndex === null && !finished) {
    const due = out.findIndex((l, i) => nowMs > l.predictedBoardEpochMs + MISSED_GRACE_MS && nowMs < l.predictedAlightEpochMs
      && (i === 0 || nowMs > out[i - 1].predictedAlightEpochMs));
    if (due !== -1) problem = { type: 'missed', legIndex: due };
  }

  // Connections still ahead: from the leg being ridden (or the start) onward.
  if (!problem && !finished) {
    const firstLeg = ridingLegIndex ?? 0;
    for (let i = firstLeg + 1; i < legs.length; i++) {
      if (ridingLegIndex === null && nowMs > out[i].predictedBoardEpochMs) continue; // already past it
      const arrival = out[i - 1].predictedAlightEpochMs;
      const shortByMs = arrival + transferNeedMs(legs[i - 1], legs[i]) - out[i].predictedBoardEpochMs;
      if (shortByMs > 0) {
        problem = {
          type: 'connection', fromLeg: i - 1, toLeg: i, shortByMs,
          atStop: legs[i - 1].stops?.[legs[i - 1].stops.length - 1] ?? null,
          predictedArrivalEpochMs: arrival,
        };
        break;
      }
    }
  }

  return { ridingLegIndex, legs: out, problem, finished };
}
