import { describe, it, expect } from 'vitest';
import {
  scoreCandidates,
  advanceStreaks,
  advanceDivergence,
  RIDE_CONFIRM_STREAK,
} from './ride-detection.js';

// Real lat delta so haversineKm-derived distances/speeds are hand-computable, matching
// src/stop-matching.test.js's fixture style.
const KM_PER_DEG_LAT = 111.19;
const BASE_LAT = -37.8;
const LON = 144.96;
const T0 = 1_700_000_000_000;

function metersToDegLat(m) {
  return (m / 1000) / KM_PER_DEG_LAT;
}

function vehicle(overrides = {}) {
  return {
    id: 'v1', mode: 'tram', tripId: 'T1', routeId: 'R1',
    lat: BASE_LAT, lon: LON, bearing: null, speed: null,
    currentStatus: 'IN_TRANSIT_TO', timestamp: T0 / 1000,
    ...overrides,
  };
}

describe('scoreCandidates', () => {
  it('qualifies an exact match: user and vehicle move together, same speed and heading', () => {
    const nextLat = BASE_LAT + metersToDegLat(22); // ~22m north over 20s => ~4km/h
    const userFixPrev = { lat: BASE_LAT, lon: LON, timestampMs: T0 };
    const userFixNext = { lat: nextLat, lon: LON, timestampMs: T0 + 20000 };
    const v = vehicle({ lat: nextLat, lon: LON, timestamp: (T0 + 20000) / 1000 });
    const priorVehicleFixes = new Map([['tram-v1', { lat: BASE_LAT, lon: LON, timestampMs: T0 }]]);

    const [result] = scoreCandidates({ userFixPrev, userFixNext, vehicles: [v], priorVehicleFixes, nowMs: T0 + 20000 });

    expect(result.distanceKm).toBe(0);
    expect(result.passesProximity).toBe(true);
    expect(result.passesSpeed).toBe(true);
    expect(result.speedDeltaKmh).toBeCloseTo(0, 5);
    expect(result.passesHeading).toBe(true);
    expect(result.headingActuallyMatched).toBe(true);
    expect(result.qualifies).toBe(true);
  });

  it('skips (does not fail) the heading check when movement is below the GPS-jitter noise floor', () => {
    const jitterLat = BASE_LAT + metersToDegLat(2); // 2m < MOVEMENT_NOISE_FLOOR_M (8m)
    const userFixPrev = { lat: BASE_LAT, lon: LON, timestampMs: T0 };
    const userFixNext = { lat: jitterLat, lon: LON, timestampMs: T0 + 20000 };
    const v = vehicle({ lat: jitterLat, lon: LON, timestamp: (T0 + 20000) / 1000, currentStatus: 'IN_TRANSIT_TO' });
    const priorVehicleFixes = new Map([['tram-v1', { lat: BASE_LAT, lon: LON, timestampMs: T0 }]]);

    const [result] = scoreCandidates({ userFixPrev, userFixNext, vehicles: [v], priorVehicleFixes, nowMs: T0 + 20000 });

    expect(result.headingDeltaDeg).toBeNull();
    expect(result.passesHeading).toBe(true);
    expect(result.headingActuallyMatched).toBe(false);
  });

  it('rejects a pedestrian walking past a stopped vehicle (speed mismatch)', () => {
    const walkedLat = BASE_LAT + metersToDegLat(28); // ~28m over 20s => ~5km/h pedestrian pace
    const userFixPrev = { lat: BASE_LAT, lon: LON, timestampMs: T0 };
    const userFixNext = { lat: walkedLat, lon: LON, timestampMs: T0 + 20000 };
    // Vehicle hasn't moved at all — genuinely stopped, not just reporting STOPPED_AT.
    const v = vehicle({ lat: BASE_LAT, lon: LON, timestamp: (T0 + 20000) / 1000, currentStatus: 'STOPPED_AT' });
    const priorVehicleFixes = new Map([['tram-v1', { lat: BASE_LAT, lon: LON, timestampMs: T0 }]]);

    const [result] = scoreCandidates({ userFixPrev, userFixNext, vehicles: [v], priorVehicleFixes, nowMs: T0 + 20000 });

    expect(result.passesProximity).toBe(true); // still close by
    expect(result.passesSpeed).toBe(false);
    expect(result.qualifies).toBe(false);
  });

  it('disqualifies a candidate with a stale position, regardless of otherwise-matching numbers', () => {
    const nextLat = BASE_LAT + metersToDegLat(22);
    const userFixPrev = { lat: BASE_LAT, lon: LON, timestampMs: T0 };
    const userFixNext = { lat: nextLat, lon: LON, timestampMs: T0 + 20000 };
    // Vehicle's own fix is 5 minutes old relative to nowMs — stale (STALE_POSITION_MS is 3 min).
    const staleTimestampSec = (T0 + 20000 - 5 * 60 * 1000) / 1000;
    const v = vehicle({ lat: nextLat, lon: LON, timestamp: staleTimestampSec });
    const priorVehicleFixes = new Map([['tram-v1', { lat: BASE_LAT, lon: LON, timestampMs: T0 }]]);

    const [result] = scoreCandidates({ userFixPrev, userFixNext, vehicles: [v], priorVehicleFixes, nowMs: T0 + 20000 });

    expect(result.stale).toBe(true);
    expect(result.passesProximity).toBe(true);
    expect(result.qualifies).toBe(false);
  });

  it('never lets a NaN/malformed vehicle coordinate qualify by default', () => {
    const userFixPrev = { lat: BASE_LAT, lon: LON, timestampMs: T0 };
    const userFixNext = { lat: BASE_LAT, lon: LON, timestampMs: T0 + 20000 };
    const v = vehicle({ lat: NaN, lon: NaN, timestamp: (T0 + 20000) / 1000 });

    const [result] = scoreCandidates({ userFixPrev, userFixNext, vehicles: [v], nowMs: T0 + 20000 });

    expect(result.passesProximity).toBe(false);
    expect(result.qualifies).toBe(false);
  });

  it('skips a vehicle with no tripId entirely — nothing to confirm a ride against', () => {
    const userFixPrev = { lat: BASE_LAT, lon: LON, timestampMs: T0 };
    const userFixNext = { lat: BASE_LAT, lon: LON, timestampMs: T0 + 20000 };
    const v = vehicle({ tripId: null });

    const results = scoreCandidates({ userFixPrev, userFixNext, vehicles: [v], nowMs: T0 + 20000 });

    expect(results).toHaveLength(0);
  });
});

describe('advanceStreaks', () => {
  function qualifyingCandidate(tripId, headingActuallyMatched = true) {
    return { tripId, vehicleKey: `tram-${tripId}`, mode: 'tram', routeId: 'R1', qualifies: true, headingActuallyMatched };
  }

  it('accumulates a streak across consecutive qualifying ticks', () => {
    let streaks = new Map();
    ({ streaks } = advanceStreaks(streaks, [qualifyingCandidate('T1')]));
    expect(streaks.get('T1').count).toBe(1);
    ({ streaks } = advanceStreaks(streaks, [qualifyingCandidate('T1')]));
    expect(streaks.get('T1').count).toBe(2);
    ({ streaks } = advanceStreaks(streaks, [qualifyingCandidate('T1')]));
    expect(streaks.get('T1').count).toBe(3);
  });

  it('resets to 0 (not decremented) on a single non-qualifying tick — no partial credit', () => {
    let streaks = new Map();
    ({ streaks } = advanceStreaks(streaks, [qualifyingCandidate('T1')]));
    ({ streaks } = advanceStreaks(streaks, [qualifyingCandidate('T1')]));
    expect(streaks.get('T1').count).toBe(2);

    ({ streaks } = advanceStreaks(streaks, [])); // T1 doesn't qualify this tick
    expect(streaks.has('T1')).toBe(false);

    ({ streaks } = advanceStreaks(streaks, [qualifyingCandidate('T1')]));
    expect(streaks.get('T1').count).toBe(1); // starts over, not resumed at 2
  });

  it('only reports a tripId eligible once it has crossed the streak AND had real heading agreement at some point', () => {
    let streaks = new Map();
    let eligibleTripIds;
    // Qualifies on proximity/speed for 3 ticks but never actually had matching heading
    // (e.g. stationary the whole time) — must not become eligible.
    for (let i = 0; i < RIDE_CONFIRM_STREAK; i++) {
      ({ streaks, eligibleTripIds } = advanceStreaks(streaks, [qualifyingCandidate('T1', false)]));
    }
    expect(eligibleTripIds).toEqual([]);

    // A 4th qualifying tick where heading agreement is finally observed crosses it —
    // count is 4 here (already past the streak threshold), confirming eligibility isn't
    // missed just because the heading-match happened after count first hit the threshold.
    ({ streaks, eligibleTripIds } = advanceStreaks(streaks, [qualifyingCandidate('T1', true)]));
    expect(streaks.get('T1').count).toBe(RIDE_CONFIRM_STREAK + 1);
    expect(eligibleTripIds).toEqual(['T1']);
  });

  it('reports more than one eligible tripId when two candidates cross simultaneously — caller must not prompt', () => {
    let streaks = new Map();
    let eligibleTripIds;
    for (let i = 0; i < RIDE_CONFIRM_STREAK; i++) {
      ({ streaks, eligibleTripIds } = advanceStreaks(streaks, [qualifyingCandidate('T1'), qualifyingCandidate('T2')]));
    }
    expect(eligibleTripIds.sort()).toEqual(['T1', 'T2']);
  });

  it('does not permanently lock out a candidate that was suppressed by a tie, once the tie resolves', () => {
    // T1 and T2 cross simultaneously (suppressed, per the test above) — then T2 stops
    // qualifying on the next tick. T1 must still be reported eligible afterward, not
    // stuck forever because its "crossing moment" already passed while tied.
    let streaks = new Map();
    let eligibleTripIds;
    for (let i = 0; i < RIDE_CONFIRM_STREAK; i++) {
      ({ streaks, eligibleTripIds } = advanceStreaks(streaks, [qualifyingCandidate('T1'), qualifyingCandidate('T2')]));
    }
    expect(eligibleTripIds.sort()).toEqual(['T1', 'T2']);

    ({ streaks, eligibleTripIds } = advanceStreaks(streaks, [qualifyingCandidate('T1')])); // T2 drops out
    expect(eligibleTripIds).toEqual(['T1']);
  });
});

describe('advanceDivergence', () => {
  const qualifying = { qualifies: true };

  it('accumulates a divergence streak across consecutive non-qualifying ticks and flags exit at the threshold', () => {
    let count = 0;
    let shouldExit;
    ({ count, shouldExit } = advanceDivergence(count, null));
    expect(count).toBe(1);
    expect(shouldExit).toBe(false);
    ({ count, shouldExit } = advanceDivergence(count, null));
    expect(count).toBe(2);
    expect(shouldExit).toBe(false);
    ({ count, shouldExit } = advanceDivergence(count, null));
    expect(count).toBe(RIDE_CONFIRM_STREAK);
    expect(shouldExit).toBe(true);
  });

  it('treats a non-qualifying candidate the same as a missing one (vehicle present but evidence broke)', () => {
    const { count, shouldExit } = advanceDivergence(RIDE_CONFIRM_STREAK - 1, { qualifies: false });
    expect(count).toBe(RIDE_CONFIRM_STREAK);
    expect(shouldExit).toBe(true);
  });

  it('resets to 0 as soon as a single agreeing tick occurs, discarding prior divergence progress', () => {
    let count = 0;
    ({ count } = advanceDivergence(count, null));
    ({ count } = advanceDivergence(count, null));
    expect(count).toBe(2);

    const result = advanceDivergence(count, qualifying);
    expect(result.count).toBe(0);
    expect(result.shouldExit).toBe(false);
  });
});
