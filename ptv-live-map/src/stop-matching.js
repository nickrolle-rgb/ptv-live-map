// Live vehicle -> "which stop is this" matching. Split out from main.js's nextStopInfo
// (Phase 3 live-first journey matching) so this scoring logic can be unit-tested
// without main.js's DOM/Leaflet/fetch module-scope state — main.js still owns
// resolving a stopId to {name, lat, lon} (mode-specific stop tables) and calls into
// this module with the resolved candidates.

import { haversineKm } from './geo.js';

// "at" must mean "physically there right now"; "next" is a looser sanity check for
// picking a plausible upcoming stop at all. Bounds are generous single-hop distances
// per mode (tram stops are close together; V/Line stops can be tens of km apart). See
// main.js's original comment (git history) for the full rationale and tuning notes.
export const STOP_SANITY_KM = {
  tram: { at: 0.15, next: 3 },
  train: { at: 0.25, next: 10 },
  vline: { at: 0.35, next: 60 },
  bus: { at: 0.15, next: 5 },
};

// Exported (not just used internally by describeNextStop) so any other view needing the
// same "N min / now / soon" text — e.g. a per-stop ETA list rather than a single next
// stop — reuses this exact formatting instead of re-deriving it.
export function formatEtaMinutes(unixSeconds, nowMs) {
  const diffMs = unixSeconds * 1000 - nowMs;
  const mins = Math.round(diffMs / 60000);
  if (mins > 0) return `${mins} min`;
  // mins === 0 is the predicted instant itself; negative means the predicted time has
  // already passed per schedule but GPS hasn't confirmed departure yet — "now" would
  // overstate confidence there, "soon" doesn't.
  return mins === 0 ? 'now' : 'soon';
}

// resolvedStops: [{ stopUpdate: {stopId, arrival, departure}, stop: {name, lat, lon} }]
// — trip-updates' remaining-stops list for one trip (see stopsPerTrip in
// api/trip-updates.js), each already resolved to its static name/coordinates.
//
// trip-updates and vehicle-positions are two independently-polled feeds, joined only by
// tripId — trip-updates can lag behind and still list a stop the vehicle's live GPS
// shows it has already passed. Rather than always trusting the feed's first remaining
// stop, this scores every candidate by live distance and picks the closest one within
// sanity.next km — self-correcting as soon as the true current/next stop is anywhere in
// the short lookahead list, instead of surfacing a stale station name.
export function pickNextStop(resolvedStops, vLat, vLon, sanity) {
  let best = null;
  for (const candidate of resolvedStops) {
    const { stop } = candidate;
    if (!stop) continue;
    const distanceKm = haversineKm(vLat, vLon, stop.lat, stop.lon);
    // A NaN distance (malformed vehicle GPS or stop coordinate) must never win by
    // default: `NaN > x` and `NaN < best.distanceKm` are both false, so without this
    // guard a NaN candidate landing first in the list would satisfy `!best`, lock in as
    // "best" with distanceKm: NaN, and then be un-overridable — every later, valid
    // candidate would also fail `distanceKm < NaN`, leaving the NaN entry as the result.
    if (!Number.isFinite(distanceKm)) continue;
    if (distanceKm > sanity.next) continue;
    if (!best || distanceKm < best.distanceKm) best = { ...candidate, distanceKm };
  }
  return best;
}

// Turns a pickNextStop() result into the display shape main.js renders. nowMs is a
// parameter (not Date.now() inline) so eta text is deterministic under test.
export function describeNextStop(best, sanity, nowMs = Date.now()) {
  if (!best) return null;
  const { stopUpdate, stop, distanceKm } = best;
  const { arrival, departure } = stopUpdate;
  if (distanceKm <= sanity.at) {
    return departure == null
      ? { label: 'At', name: stop.name, eta: null, lat: stop.lat, lon: stop.lon, arrival, departure }
      : { label: 'At', name: stop.name, eta: formatEtaMinutes(departure, nowMs), etaVerb: 'departing', lat: stop.lat, lon: stop.lon, arrival, departure };
  }
  const etaSeconds = departure ?? arrival;
  return etaSeconds == null
    ? { label: 'Next stop', name: stop.name, eta: null, lat: stop.lat, lon: stop.lon, arrival, departure }
    : { label: 'Next stop', name: stop.name, eta: formatEtaMinutes(etaSeconds, nowMs), etaVerb: null, lat: stop.lat, lon: stop.lon, arrival, departure };
}

// Real GPS fixes land every 20-60s+ in normal operation — beyond this, the feed itself
// hasn't heard from the vehicle in a while, so its plotted position is a guess rather
// than a live report, and main.js's popup says so instead of presenting it with false
// confidence (including suppressing nextStopInfo's claim entirely — see main.js's
// buildPopupContent). Lives here, not main.js, so the same threshold that gates that
// claim is what this module's own tests exercise, matching STOP_SANITY_KM's rationale.
export const STALE_POSITION_MS = 3 * 60 * 1000;

// v.timestamp is GTFS-realtime's vehicle-position epoch seconds (Number | null). nowMs
// is a parameter (not Date.now() inline) so staleness is deterministic under test, same
// rationale as describeNextStop's nowMs.
export function positionStaleness(timestamp, nowMs = Date.now()) {
  const ageMs = timestamp != null ? nowMs - timestamp * 1000 : null;
  const stale = ageMs != null && ageMs > STALE_POSITION_MS;
  return { ageMs, stale };
}
