// Live user GPS -> "is this phone plausibly riding this specific vehicle" matching.
// Split out the same way src/stop-matching.js was, so this heuristic is unit-testable
// without main.js's DOM/Leaflet/watchPosition state — main.js owns the rolling
// per-tripId streak state (across ticks) and calls into this module with plain fix data
// each tick. Never asserts a match on its own; it only ever produces evidence for
// main.js to act on (prompt the user), per this app's "honesty over confidence"
// principle — the actual claim always waits for explicit user confirmation.

import { haversineKm } from './geo.js';
import { positionStaleness } from './stop-matching.js';

// Loose enough for phone GPS error + antenna offset (typically 5-30m), tight enough
// that two vehicles on separate streets/tracks can't both qualify at once. Bus included
// for forward-compatibility (scoreCandidates doesn't special-case mode exclusion), even
// though wiring bus vehicles in is out of scope for v1 — see the implementation plan.
export const RIDE_PROXIMITY_KM = {
  tram: 0.05,
  train: 0.08,
  vline: 0.1,
  bus: 0.05,
};

// Rejects "walking past a stopped vehicle" (pedestrian ~4-5km/h vs vehicle 0km/h) while
// still being generous enough for GPS/speedometer noise between two independently
// sampled devices when genuinely riding (both experience the same real speed, so error
// here should be small). Deliberately tighter than pedestrian pace, not looser — the
// stationary-vehicle false positive is exactly the case this threshold exists to reject.
export const SPEED_TOLERANCE_KMH = 4;

// Below this, a fix pair's implied displacement is dominated by GPS jitter, not real
// movement — heading agreement is skipped (treated as neutral), not compared.
export const MOVEMENT_NOISE_FLOOR_M = 8;

// Generous enough for tram/train curves and a phone jostling in a pocket/bag.
export const HEADING_TOLERANCE_DEG = 35;

// Consecutive qualifying ticks required before confirming a match, and (applied
// symmetrically, see advanceDivergence) consecutive disqualifying ticks required before
// concluding a previously-confirmed match has ended. Same weight of evidence both ways
// is a deliberate consistency choice, not just convenience.
export const RIDE_CONFIRM_STREAK = 3;

function computeBearingDeg(lat1, lon1, lat2, lon2) {
  const toRad = (d) => (d * Math.PI) / 180;
  const toDeg = (r) => (r * 180) / Math.PI;
  const dLon = toRad(lon2 - lon1);
  const y = Math.sin(dLon) * Math.cos(toRad(lat2));
  const x = Math.cos(toRad(lat1)) * Math.sin(toRad(lat2)) - Math.sin(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.cos(dLon);
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

// Smallest angle between two compass bearings, handling the 0/360 wraparound.
function angleDiffDeg(a, b) {
  const diff = Math.abs(a - b) % 360;
  return diff > 180 ? 360 - diff : diff;
}

// userFixPrev/userFixNext: { lat, lon, timestampMs, headingDeg? } — headingDeg from
// GeolocationCoordinates.heading when the device reports it (often null at low speed).
// vehicles: this tick's live vehicle list (main.js's `allVehicles` shape: { id, mode,
// tripId, routeId, lat, lon, bearing, speed, currentStatus, timestamp }).
// priorVehicleFixes: Map<vehicleKey, { lat, lon, timestampMs }> — main.js supplies this
// from the position history renderMarkers() already maintains per-marker
// (`marker._lastRawLatLng`/`_lastRawUpdateAt`), not a new parallel store.
//
// Returns every candidate (not just qualifying ones — callers/tests can see exactly why
// a candidate failed), sorted by distance. A vehicle with no tripId can't be confirmed
// against (nothing to fetch a stop list for) and is skipped entirely.
export function scoreCandidates({ userFixPrev, userFixNext, vehicles, priorVehicleFixes = new Map(), nowMs = Date.now() }) {
  const userMovedKm = userFixPrev ? haversineKm(userFixPrev.lat, userFixPrev.lon, userFixNext.lat, userFixNext.lon) : 0;
  const userDtSec = userFixPrev ? (userFixNext.timestampMs - userFixPrev.timestampMs) / 1000 : 0;
  const userSpeedKmh = userDtSec > 0 ? (userMovedKm / userDtSec) * 3600 : 0;
  const userMovedM = userMovedKm * 1000;
  const userHeadingDeg = userFixNext.headingDeg != null
    ? userFixNext.headingDeg
    : (userFixPrev && userMovedM > MOVEMENT_NOISE_FLOOR_M
        ? computeBearingDeg(userFixPrev.lat, userFixPrev.lon, userFixNext.lat, userFixNext.lon)
        : null);

  return vehicles
    .filter((v) => v.tripId)
    .map((v) => {
      const vehicleKey = `${v.mode}-${v.id}`;
      const distanceKm = haversineKm(userFixNext.lat, userFixNext.lon, v.lat, v.lon);
      const { stale } = positionStaleness(v.timestamp, nowMs);

      const priorFix = priorVehicleFixes.get(vehicleKey);
      const vehicleMovedKm = priorFix ? haversineKm(priorFix.lat, priorFix.lon, v.lat, v.lon) : 0;
      const vehicleDtSec = priorFix && v.timestamp != null ? (v.timestamp * 1000 - priorFix.timestampMs) / 1000 : 0;
      const vehicleMovedM = vehicleMovedKm * 1000;

      const vehicleSpeedKmh = Number.isFinite(v.speed)
        ? v.speed * 3.6
        : (vehicleDtSec > 0 ? (vehicleMovedKm / vehicleDtSec) * 3600 : null);

      const vehicleHeadingDeg = Number.isFinite(v.bearing)
        ? v.bearing
        : (priorFix && vehicleMovedM > MOVEMENT_NOISE_FLOOR_M
            ? computeBearingDeg(priorFix.lat, priorFix.lon, v.lat, v.lon)
            : null);

      const passesProximity = Number.isFinite(distanceKm) && distanceKm < (RIDE_PROXIMITY_KM[v.mode] ?? RIDE_PROXIMITY_KM.train);

      const speedDeltaKmh = vehicleSpeedKmh != null ? Math.abs(userSpeedKmh - vehicleSpeedKmh) : null;
      const passesSpeed = speedDeltaKmh != null && speedDeltaKmh < SPEED_TOLERANCE_KMH;

      // A rider boarding while the vehicle dwells is exactly when confidence should
      // start building, not be blocked — heading is undefined at a standstill, so skip
      // (don't fail) the check rather than treat "stationary" as evidence against a match.
      const dwelling = v.currentStatus === 'STOPPED_AT';
      const headingEvaluable = !dwelling && userHeadingDeg != null && vehicleHeadingDeg != null;
      const headingDeltaDeg = headingEvaluable ? angleDiffDeg(userHeadingDeg, vehicleHeadingDeg) : null;
      // Distinguished from passesHeading: this is only true for a REAL agreeing
      // comparison, never for a skipped/neutral one — used by advanceStreaks to require
      // actual correlated movement was observed at least once, not just proximity while
      // both happen to be stationary (see this module's header + the plan's
      // disambiguation rationale for two vehicles idling at the same stop).
      const headingActuallyMatched = headingEvaluable && headingDeltaDeg < HEADING_TOLERANCE_DEG;
      const passesHeading = !headingEvaluable || headingActuallyMatched;

      const qualifies = !stale && passesProximity && passesSpeed && passesHeading;

      return {
        vehicleKey, tripId: v.tripId, mode: v.mode, routeId: v.routeId,
        distanceKm, speedDeltaKmh, headingDeltaDeg,
        passesProximity, passesSpeed, passesHeading, headingActuallyMatched,
        stale, qualifies,
      };
    })
    .sort((a, b) => a.distanceKm - b.distanceKm);
}

// Advances a per-tripId streak map by one tick's scored candidates. Pure: returns a new
// map rather than mutating prevStreaks. A non-qualifying tick simply omits that tripId
// from the returned map — no partial credit/decay, the streak resets to 0 outright,
// matching this module's "the evidence broke, don't paper over it" discipline.
//
// eligibleTripIds is every tripId that currently meets the confirmation bar (streak >=
// RIDE_CONFIRM_STREAK AND real correlated movement observed at least once), recomputed
// fresh each call rather than edge-triggered on the tick it first crosses — an
// edge-triggered version would permanently miss a candidate that first crosses
// simultaneously with another (both suppressed per the tie rule below) and later becomes
// the sole survivor, since the "just crossed" moment would already be in the past. The
// caller (main.js) is responsible for not re-prompting for a tripId it's already shown
// or the user already dismissed — that's session/UI state, not evidence state, so it
// doesn't belong in this pure function.
//
// Two or more simultaneously-eligible candidates (e.g. two vehicles running close
// together, both moving in step with the user) means neither should be confirmed yet —
// deliberately erring toward under-claiming per this app's honesty-over-confidence
// principle; callers should treat `eligibleTripIds.length !== 1` as "don't prompt yet."
export function advanceStreaks(prevStreaks, candidates) {
  const next = new Map();
  candidates.forEach((c) => {
    if (!c.qualifies) return;
    const prior = prevStreaks.get(c.tripId);
    const count = (prior?.count ?? 0) + 1;
    const everHeadingMatched = Boolean(prior?.everHeadingMatched) || c.headingActuallyMatched;
    next.set(c.tripId, { count, everHeadingMatched, vehicleKey: c.vehicleKey, mode: c.mode, routeId: c.routeId });
  });
  const eligibleTripIds = [...next.entries()]
    .filter(([, s]) => s.count >= RIDE_CONFIRM_STREAK && s.everHeadingMatched)
    .map(([tripId]) => tripId);
  return { streaks: next, eligibleTripIds };
}

// Symmetric to advanceStreaks, for withdrawing a confirmed match once evidence stops
// supporting it. candidateForConfirmedTrip is the one scored candidate matching the
// currently-confirmed tripId (from this tick's scoreCandidates output), or null if that
// vehicle has dropped out of the feed entirely (also treated as divergence — no data to
// support the claim is itself grounds to stop asserting it).
export function advanceDivergence(prevCount, candidateForConfirmedTrip) {
  if (!candidateForConfirmedTrip || !candidateForConfirmedTrip.qualifies) {
    const count = (prevCount ?? 0) + 1;
    return { count, shouldExit: count >= RIDE_CONFIRM_STREAK };
  }
  return { count: 0, shouldExit: false };
}
