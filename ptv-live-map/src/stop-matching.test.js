import { describe, it, expect } from 'vitest';
import { pickNextStop, describeNextStop, STOP_SANITY_KM } from './stop-matching.js';

// A straight, evenly-spaced train line for boundary testing:
// StopA --- (0.5km) --- StopB --- (0.5km) --- StopC
// Built with real-ish lat deltas (1 degree lat ~= 111km) rather than lon, so
// haversineKm distances are easy to reason about by hand.
const KM_PER_DEG_LAT = 111.19;
const STEP_DEG = 0.5 / KM_PER_DEG_LAT;
const BASE_LAT = -37.8;
const LON = 144.96;

const stopA = { name: 'Stop A', lat: BASE_LAT, lon: LON };
const stopB = { name: 'Stop B', lat: BASE_LAT + STEP_DEG, lon: LON };
const stopC = { name: 'Stop C', lat: BASE_LAT + STEP_DEG * 2, lon: LON };

function candidate(stop, overrides = {}) {
  return { stopUpdate: { stopId: stop.name, arrival: 1000, departure: 1010, ...overrides }, stop };
}

describe('pickNextStop', () => {
  const sanity = STOP_SANITY_KM.train; // { at: 0.25, next: 10 }

  it('picks the closest candidate to the vehicle, not the first in the list', () => {
    // trip-updates lists B first (stale) even though the vehicle's live GPS is at C.
    const resolved = [candidate(stopB), candidate(stopC)];
    const best = pickNextStop(resolved, stopC.lat, stopC.lon, sanity);
    expect(best.stop.name).toBe('Stop C');
  });

  it('exact match at a stop coordinate resolves to that stop with distance 0', () => {
    const resolved = [candidate(stopA), candidate(stopB)];
    const best = pickNextStop(resolved, stopA.lat, stopA.lon, sanity);
    expect(best.stop.name).toBe('Stop A');
    expect(best.distanceKm).toBe(0);
  });

  it('at the midpoint between two stops, resolves to whichever is (near-)closest, not null or a third stop', () => {
    const midLat = BASE_LAT + STEP_DEG / 2;
    const resolved = [candidate(stopA), candidate(stopB)];
    const best = pickNextStop(resolved, midLat, LON, sanity);
    // Both are ~equidistant (~0.25km each) — haversine floating-point rounding means an
    // exact tie (and therefore which one wins) isn't guaranteed, so this only pins down
    // the boundary invariant: some real candidate is chosen, at roughly the halfway
    // distance, not null and not a stop further away.
    expect(['Stop A', 'Stop B']).toContain(best.stop.name);
    expect(best.distanceKm).toBeCloseTo(0.25, 2);
  });

  it('just past the midpoint, the closer stop ahead wins even though it is still "next" not "at"', () => {
    const justPastMidLat = BASE_LAT + STEP_DEG / 2 + 0.0001;
    const resolved = [candidate(stopA), candidate(stopB)];
    const best = pickNextStop(resolved, justPastMidLat, LON, sanity);
    expect(best.stop.name).toBe('Stop B');
  });

  it('discards candidates beyond the "next" sanity distance entirely', () => {
    const farAway = { name: 'Far Stop', lat: BASE_LAT + 1, lon: LON }; // ~111km away
    const resolved = [candidate(farAway)];
    const best = pickNextStop(resolved, stopA.lat, stopA.lon, sanity);
    expect(best).toBeNull();
  });

  it('returns null when there are no candidates', () => {
    expect(pickNextStop([], stopA.lat, stopA.lon, sanity)).toBeNull();
  });

  it('skips candidates whose stop failed to resolve (unknown stopId)', () => {
    const resolved = [{ stopUpdate: { stopId: 'ghost', arrival: 1, departure: 2 }, stop: null }, candidate(stopA)];
    const best = pickNextStop(resolved, stopA.lat, stopA.lon, sanity);
    expect(best.stop.name).toBe('Stop A');
  });

  it('respects per-mode sanity bounds (a stop 5km out is "next" for train but out of range for tram)', () => {
    const farStop = { name: 'Far Stop', lat: BASE_LAT + 5 / KM_PER_DEG_LAT, lon: LON }; // ~5km
    const resolved = [candidate(farStop)];
    expect(pickNextStop(resolved, stopA.lat, stopA.lon, STOP_SANITY_KM.train)).not.toBeNull();
    expect(pickNextStop(resolved, stopA.lat, stopA.lon, STOP_SANITY_KM.tram)).toBeNull();
  });
});

describe('describeNextStop', () => {
  const sanity = STOP_SANITY_KM.train; // { at: 0.25, next: 10 }
  const nowMs = 1_000_000_000_000;

  it('labels "At" when within the at-distance, with a departing ETA', () => {
    const best = { stopUpdate: { arrival: nowMs / 1000 - 30, departure: nowMs / 1000 + 120 }, stop: stopA, distanceKm: 0.1 };
    const result = describeNextStop(best, sanity, nowMs);
    expect(result.label).toBe('At');
    expect(result.etaVerb).toBe('departing');
    expect(result.eta).toBe('2 min');
  });

  it('labels "At" with no ETA text when the feed has no departure time', () => {
    const best = { stopUpdate: { arrival: nowMs / 1000 - 30, departure: null }, stop: stopA, distanceKm: 0.1 };
    const result = describeNextStop(best, sanity, nowMs);
    expect(result.label).toBe('At');
    expect(result.eta).toBeNull();
  });

  it('labels "Next stop" just outside the at-distance', () => {
    const best = { stopUpdate: { arrival: nowMs / 1000 + 300, departure: nowMs / 1000 + 310 }, stop: stopB, distanceKm: 0.26 };
    const result = describeNextStop(best, sanity, nowMs);
    expect(result.label).toBe('Next stop');
    expect(result.eta).toBe('5 min');
  });

  it('prefers departure over arrival for the "Next stop" ETA when both are present', () => {
    const best = {
      stopUpdate: { arrival: nowMs / 1000 + 100, departure: nowMs / 1000 + 400 },
      stop: stopB, distanceKm: 1,
    };
    const result = describeNextStop(best, sanity, nowMs);
    expect(result.eta).toBe(Math.round(400 / 60) + ' min');
  });

  it('falls back to arrival when departure is missing', () => {
    const best = { stopUpdate: { arrival: nowMs / 1000 + 180, departure: null }, stop: stopB, distanceKm: 1 };
    const result = describeNextStop(best, sanity, nowMs);
    expect(result.eta).toBe('3 min');
  });

  it('reports "soon" (never a false "now"/positive minute count) for a time already in the past', () => {
    const best = { stopUpdate: { arrival: nowMs / 1000 - 600, departure: nowMs / 1000 - 600 }, stop: stopA, distanceKm: 5 };
    const result = describeNextStop(best, sanity, nowMs);
    expect(result.eta).toBe('soon');
  });

  it('returns null when there is no matching candidate at all', () => {
    expect(describeNextStop(null, sanity, nowMs)).toBeNull();
  });
});
