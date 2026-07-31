// Journey planning — Phase 1: walking-leg computation (see the approved roadmap in
// PRINCIPLES.md's "Deferred, not excluded" section). Deliberately self-contained: no
// live vehicle/trip-updates data, no UI, no dependency on main.js — just "given a
// point, which stops can I reasonably walk to?" This is the one piece of logic every
// later journey-planning phase depends on, and the seam main.js's future
// journey-planning code should keep growing from rather than the monolith itself.

import { haversineKm } from './geo.js';

// Average adult walking pace. Straight-line (haversine) distance understates real
// walking distance — rivers, freeways, and building layouts routinely add 30-80% (a
// standard "circuity factor" in pedestrian-routing literature) — so WALK_CIRCUITY
// inflates the straight-line distance before converting to minutes, biasing toward
// *not* overpromising walkability. This is a named estimate, not a routed direction:
// no street-network data exists in this app, so any UI surfacing a walking leg should
// label it as approximate, not as turn-by-turn.
export const WALK_SPEED_KMH = 4.8;
export const WALK_CIRCUITY = 1.3;
export const DEFAULT_WALK_CAP_MINUTES = 10;

export function walkingMinutesTo(lat1, lon1, lat2, lon2) {
  const straightKm = haversineKm(lat1, lon1, lat2, lon2);
  return ((straightKm * WALK_CIRCUITY) / WALK_SPEED_KMH) * 60;
}

// Some GTFS stops.txt exports include internal wayfinding nodes at complex stations
// (lift/stair access points, concourse "decision points") alongside real boarding
// stops — not something a rider would ever board a service at. Best-effort filter
// based on patterns actually observed in this app's stop data, not exhaustive; these
// entries never appear as a real stop_id in live trip-updates either, so excluding
// them here can't affect journey-matching accuracy (Phase 3), only display clutter.
const NON_BOARDING_STOP_PATTERN = /decision point|\bdp\s?\d+\b|\blift\b|\bconcourse\b/i;

// stopTables: [{ mode, stopNames }], stopNames shaped stopId -> [name, lat, lon] (the
// same tables MODES[mode].stopNames already provides in main.js) — passed in rather
// than imported so this module has no dependency on main.js's app state.
//
// Groups by stop *name*, not stop_id, the same way computeNearestStops does in
// main.js: interchange/multi-platform stations have several stop_ids at near-identical
// coordinates, and appear independently in more than one mode's static export (e.g.
// Flinders Street in both train's and V/Line's stops.txt) — collapsing by name avoids
// listing the same physical stop two or three times.
//
// Returns { stops, withinCap, cappedAtMinutes }. Per "10 minutes unless it's our only
// option": if nothing is within the cap, falls back to the single nearest stop
// regardless of distance, but flags withinCap: false so a caller never presents that
// longer walk as if it fit the cap (Principle 1 — honesty over confidence — applied to
// a derived estimate, not just a live field).
// Each returned stop also carries `stopIds` — every underlying stop_id that shares its
// name (a station can have one per platform/child stop). Phase 1 itself never needed
// these, but Phase 3's live journey matching does: trip-updates references specific
// stop_ids, not names, so matching a walkable "stop" against what a live trip actually
// reports requires this set.
export function findWalkableStops(lat, lon, stopTables, { capMinutes = DEFAULT_WALK_CAP_MINUTES } = {}) {
  const byName = new Map();
  stopTables.forEach(({ mode, stopNames }) => {
    Object.entries(stopNames).forEach(([stopId, [name, stopLat, stopLon]]) => {
      if (NON_BOARDING_STOP_PATTERN.test(name)) return;
      const minutes = walkingMinutesTo(lat, lon, stopLat, stopLon);
      const existing = byName.get(name);
      if (!existing) {
        byName.set(name, { name, lat: stopLat, lon: stopLon, minutes, modes: new Set([mode]), stopIds: new Set([stopId]) });
        return;
      }
      existing.modes.add(mode);
      existing.stopIds.add(stopId);
      if (minutes < existing.minutes) {
        existing.lat = stopLat;
        existing.lon = stopLon;
        existing.minutes = minutes;
      }
    });
  });

  const all = [...byName.values()]
    .map((entry) => ({ ...entry, modes: [...entry.modes], stopIds: [...entry.stopIds] }))
    .sort((a, b) => a.minutes - b.minutes);

  const withinCap = all.filter((stop) => stop.minutes <= capMinutes);
  if (withinCap.length > 0) return { stops: withinCap, withinCap: true, cappedAtMinutes: capMinutes };

  if (all.length === 0) return { stops: [], withinCap: true, cappedAtMinutes: capMinutes };
  return { stops: [all[0]], withinCap: false, cappedAtMinutes: capMinutes };
}
