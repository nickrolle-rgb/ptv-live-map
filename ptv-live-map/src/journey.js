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
// 10 min (real-world use, 2026-08-02: a straight-line 1.0km station — genuinely
// walkable — was landing at ~16.25 min once circuity is applied, and getting excluded
// entirely) covers only ~0.6km straight-line; 20 min covers ~1.23km, which comfortably
// includes that case with some margin.
export const DEFAULT_WALK_CAP_MINUTES = 20;

export function walkingMinutesTo(lat1, lon1, lat2, lon2) {
  const straightKm = haversineKm(lat1, lon1, lat2, lon2);
  return ((straightKm * WALK_CIRCUITY) / WALK_SPEED_KMH) * 60;
}

// Some GTFS stops.txt exports include internal wayfinding/amenity nodes at complex
// stations (lift/stair access points, concourse "decision points", park & ride lots)
// alongside real boarding stops — not something a rider would ever board a service at.
// Best-effort filter based on patterns actually observed in this app's stop data, not
// exhaustive.
//
// This is not just display clutter to trim: these names are frequently reused verbatim
// across dozens of unrelated stations statewide (confirmed against the bundled data —
// "Park & Ride" alone spans ~95 physical locations, "Decision point 1" ~120), and
// findWalkableStops groups by exact name match, but only merges same-named entries that
// are also physically close (see SAME_NAME_MERGE_RADIUS_KM below) — a real design
// tradeoff for genuinely same-named multi-platform stations (e.g. every "Flinders Street
// Station" platform), balanced against generic names that recur across unrelated,
// far-apart stations. NON_BOARDING_STOP_PATTERN below still exists to filter out
// wayfinding/amenity nodes outright (not worth surfacing as a "walkable stop" at all,
// near or far) — but before the geography-aware merge was added, any *boardable* stop
// with a coincidentally-reused name (not just amenity ones) would merge across whatever
// distance separated them. Concretely: both Frankston's and Ivanhoe's station-entrance
// nodes are named "Young St" (a generic street name, not an amenity pattern) despite
// being ~40km apart — confirmed in real bundled data, not a hypothetical — so an
// unguarded merge folded Ivanhoe's entrance stop_id into what should have been a
// Frankston-only "walkable stop" entry. Dormant while schedule-search.js's interchange
// matching was itself name-only (that stage separately capped same-named-but-distant
// pairs by walk time), but once that matching became proximity-based, the phantom entry
// was live data indistinguishable from a real short walk, and let the planner treat a
// same-named entrance halfway across Melbourne as instantly reachable.
const NON_BOARDING_STOP_PATTERN = /decision point|\bdp\s?\d+\b|\blift\b|\bconcourse\b|park\s*&\s*ride|bike\s*&\s*ride|kiss\s*&\s*ride|taxi\s*zone/i;

// Generous enough to span every platform/entrance of one real station (even a large
// interchange), small enough that two unrelated stations sharing a generic name (the
// "Young St" case above) land in separate clusters instead of one contaminated entry.
const SAME_NAME_MERGE_RADIUS_KM = 2;

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
  // name -> array of clusters (usually one; more than one only when the same name
  // recurs at physically distant locations, e.g. the "Young St" case above), each
  // { name, lat, lon, minutes, modes, stopIds }.
  const byName = new Map();
  stopTables.forEach(({ mode, stopNames }) => {
    Object.entries(stopNames).forEach(([stopId, [name, stopLat, stopLon]]) => {
      if (NON_BOARDING_STOP_PATTERN.test(name)) return;
      const minutes = walkingMinutesTo(lat, lon, stopLat, stopLon);
      const clusters = byName.get(name);
      const cluster = clusters?.find((c) => haversineKm(c.lat, c.lon, stopLat, stopLon) <= SAME_NAME_MERGE_RADIUS_KM);
      if (!cluster) {
        const entry = { name, lat: stopLat, lon: stopLon, minutes, modes: new Set([mode]), stopIds: new Set([stopId]) };
        if (clusters) clusters.push(entry);
        else byName.set(name, [entry]);
        return;
      }
      cluster.modes.add(mode);
      cluster.stopIds.add(stopId);
      if (minutes < cluster.minutes) {
        cluster.lat = stopLat;
        cluster.lon = stopLon;
        cluster.minutes = minutes;
      }
    });
  });

  const all = [...byName.values()]
    .flat()
    .map((entry) => ({ ...entry, modes: [...entry.modes], stopIds: [...entry.stopIds] }))
    .sort((a, b) => a.minutes - b.minutes);

  const withinCap = all.filter((stop) => stop.minutes <= capMinutes);
  if (withinCap.length > 0) return { stops: withinCap, withinCap: true, cappedAtMinutes: capMinutes };

  if (all.length === 0) return { stops: [], withinCap: true, cappedAtMinutes: capMinutes };
  return { stops: [all[0]], withinCap: false, cappedAtMinutes: capMinutes };
}
