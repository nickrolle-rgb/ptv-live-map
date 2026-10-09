import { describe, it, expect } from 'vitest';
import { buildLegPath, locateOnLeg, scheduledEpochAt, vehicleFeedDelayMs, assessItinerary, GPS_FRESH_MS } from './journey-tracking.js';

// A straight north-running line of stops 1km apart (0.008993 deg of latitude ~ 1km).
const KM = 0.008993;
const LON = 144.95;
const T0 = Date.UTC(2026, 7, 4, 22, 0, 0); // 08:00 Melbourne
const MIN = 60 * 1000;
const at = (km) => ({ lat: -37.8 + km * KM, lon: LON });
const stop = (id, km, minutesAfterT0) => ({ stopId: id, name: id, ...at(km), epochMs: T0 + minutesAfterT0 * MIN });

// Leg A: stops at 0, 1, 2km, departing 08:00, 2 minutes per km. Leg B boards at the
// same stop A ends at (2km), departing 08:07, on to 4km.
const legA = { mode: 'train', tripId: 'A', stops: [stop('a0', 0, 0), stop('a1', 1, 2), stop('a2', 2, 4)] };
const legB = { mode: 'train', tripId: 'B', stops: [stop('a2', 2, 7), stop('b1', 3, 9), stop('b2', 4, 11)] };
const withTimes = (leg) => ({ ...leg, boardEpochMs: leg.stops[0].epochMs, alightEpochMs: leg.stops.at(-1).epochMs });
const itinerary = { legs: [withTimes(legA), withTimes(legB)] };
const paths = itinerary.legs.map((leg) => buildLegPath(leg));
const gps = (km, nowMs) => ({ ...at(km), timestampMs: nowMs });

describe('buildLegPath / locateOnLeg / scheduledEpochAt', () => {
  it('places stops along the path and interpolates the schedule between them', () => {
    const path = paths[0];
    expect(path.stopAlong[1]).toBeCloseTo(1000, -1);
    expect(path.stopAlong[2]).toBeCloseTo(2000, -1);
    const spot = locateOnLeg(path, at(1.5).lat, at(1.5).lon);
    expect(spot.along).toBeCloseTo(1500, -1);
    expect(scheduledEpochAt(legA, path, spot.along)).toBeCloseTo(T0 + 3 * MIN, -3);
  });

  it('is not on the leg when well off the line', () => {
    expect(locateOnLeg(paths[0], at(1).lat, LON + 0.02)).toBeNull(); // ~1.8km east
  });

  it('keeps stops in order along a shape that passes the same place twice (City Loop style)', () => {
    // Shape goes north 0->2km, loops back south to 0.5km, then north again to 3km.
    const shape = [[at(0).lat, LON], [at(2).lat, LON], [at(2).lat, LON + 0.0005], [at(0.5).lat, LON + 0.0005], [at(0.5).lat, LON + 0.001], [at(3).lat, LON + 0.001]];
    const leg = { stops: [stop('s0', 0, 0), stop('s1', 2, 4), stop('s2', 1, 8), stop('s3', 3, 12)] };
    const path = buildLegPath(leg, [shape]);
    expect(path.source).toBe('shape');
    for (let i = 1; i < path.stopAlong.length; i++) expect(path.stopAlong[i]).toBeGreaterThan(path.stopAlong[i - 1]);
  });

  it('cannot track a leg without a stop list (live-matched options)', () => {
    expect(buildLegPath({ tripId: 'X' })).toBeNull();
  });
});

describe('vehicleFeedDelayMs', () => {
  it('measures predicted minus scheduled at the first of the leg\'s stops the feed reports', () => {
    const update = { stops: [{ stopId: 'zz', arrival: 1 }, { stopId: 'a1', arrival: (T0 + 5 * MIN) / 1000 }] };
    expect(vehicleFeedDelayMs(legA, update)).toBe(3 * MIN); // scheduled a1 at +2, predicted +5
  });
  it('is null when the feed has nothing for this leg', () => {
    expect(vehicleFeedDelayMs(legA, { stops: [{ stopId: 'other', arrival: 1 }] })).toBeNull();
    expect(vehicleFeedDelayMs(legA, undefined)).toBeNull();
  });
});

describe('assessItinerary', () => {
  it('measures the delay from GPS while riding, and flags a connection that now fails', () => {
    // At 1.5km at 08:07: scheduled there at 08:03, so 4 minutes late. Leg A now reaches
    // a2 at 08:08; with the 2-minute minimum change that misses B's 08:07 by 3 minutes.
    const nowMs = T0 + 7 * MIN;
    const result = assessItinerary(itinerary, { nowMs, position: gps(1.5, nowMs), paths });
    expect(result.ridingLegIndex).toBe(0);
    expect(result.legs[0].source).toBe('gps');
    expect(result.legs[0].delayMs).toBeCloseTo(4 * MIN, -3);
    expect(result.problem.type).toBe('connection');
    expect(result.problem.toLeg).toBe(1);
    expect(result.problem.shortByMs).toBeCloseTo(3 * MIN, -3);
    expect(result.problem.atStop.stopId).toBe('a2');
  });

  it('raises no problem when running on time', () => {
    const nowMs = T0 + 3 * MIN;
    const result = assessItinerary(itinerary, { nowMs, position: gps(1.5, nowMs), paths });
    expect(result.legs[0].delayMs).toBeCloseTo(0, -3);
    expect(result.problem).toBeNull();
  });

  it('uses the vehicle feed when there is no GPS fix (e.g. underground)', () => {
    const nowMs = T0 + 1 * MIN;
    const result = assessItinerary(itinerary, { nowMs, position: null, paths, vehicleDelayMs: (i) => (i === 0 ? 5 * MIN : null) });
    expect(result.ridingLegIndex).toBeNull();
    expect(result.legs[0]).toMatchObject({ delayMs: 5 * MIN, source: 'vehicle' });
    expect(result.problem.type).toBe('connection');
  });

  it('flags a missed vehicle when GPS says the rider is still at the boarding stop well after it left', () => {
    const nowMs = T0 + 3.5 * MIN; // departed 08:00, 3-minute grace has passed
    const result = assessItinerary(itinerary, { nowMs, position: gps(0, nowMs), paths });
    expect(result.ridingLegIndex).toBeNull();
    expect(result.problem).toEqual({ type: 'missed', legIndex: 0 });
  });

  it('never claims a missed vehicle without a fresh GPS fix', () => {
    const nowMs = T0 + 3.5 * MIN;
    const stale = gps(0, nowMs - GPS_FRESH_MS - 1000);
    expect(assessItinerary(itinerary, { nowMs, position: stale, paths }).problem).toBeNull();
    expect(assessItinerary(itinerary, { nowMs, position: null, paths }).problem).toBeNull();
  });

  it('does not count standing at the boarding stop as riding', () => {
    const nowMs = T0 - 1 * MIN;
    const result = assessItinerary(itinerary, { nowMs, position: gps(0.05, nowMs), paths });
    expect(result.ridingLegIndex).toBeNull();
    expect(result.problem).toBeNull();
  });

  it('reports the journey finished well after the last arrival', () => {
    const nowMs = T0 + 60 * MIN;
    expect(assessItinerary(itinerary, { nowMs, position: null, paths }).finished).toBe(true);
  });
});
