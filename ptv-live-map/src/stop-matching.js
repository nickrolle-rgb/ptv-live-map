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

function formatEtaMinutes(unixSeconds, nowMs) {
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
