import { describe, it, expect } from 'vitest';
import { haversineKm } from './geo.js';
import {
  walkingMinutesTo,
  findWalkableStops,
  WALK_SPEED_KMH,
  WALK_CIRCUITY,
  DEFAULT_WALK_CAP_MINUTES,
} from './journey.js';

describe('walkingMinutesTo', () => {
  it('is zero for the same point', () => {
    expect(walkingMinutesTo(-37.8136, 144.9631, -37.8136, 144.9631)).toBe(0);
  });

  it('applies the circuity factor on top of straight-line distance', () => {
    const lat1 = -37.8136, lon1 = 144.9631, lat2 = -37.8200, lon2 = 144.9700;
    const straightKm = haversineKm(lat1, lon1, lat2, lon2);
    const expectedMinutes = ((straightKm * WALK_CIRCUITY) / WALK_SPEED_KMH) * 60;
    expect(walkingMinutesTo(lat1, lon1, lat2, lon2)).toBeCloseTo(expectedMinutes, 6);
  });

  it('is monotonic with distance', () => {
    const near = walkingMinutesTo(-37.8136, 144.9631, -37.8140, 144.9635);
    const far = walkingMinutesTo(-37.8136, 144.9631, -37.9000, 145.0500);
    expect(near).toBeLessThan(far);
  });
});

describe('findWalkableStops', () => {
  const stopTables = [
    {
      mode: 'train',
      stopNames: {
        near1: ['Near Station', -37.8136, 144.9631],
        near2: ['Near Station', -37.81365, 144.96315], // same name, different platform stop_id
        mid: ['Mid Station', -37.8300, 144.9800],
        far: ['Far Station', -38.5000, 145.5000],
        dp: ['Near Station - Decision Point 1', -37.8137, 144.9632],
        lift: ['Near Station Lift', -37.8138, 144.9633],
      },
    },
  ];
  const origin = { lat: -37.8136, lon: 144.9631 };

  it('returns every stop within the cap, sorted by walking time', () => {
    const result = findWalkableStops(origin.lat, origin.lon, stopTables, { capMinutes: DEFAULT_WALK_CAP_MINUTES });
    expect(result.withinCap).toBe(true);
    const names = result.stops.map((s) => s.name);
    expect(names).toContain('Near Station');
    expect(names).not.toContain('Far Station');
    for (let i = 1; i < result.stops.length; i++) {
      expect(result.stops[i].minutes).toBeGreaterThanOrEqual(result.stops[i - 1].minutes);
    }
  });

  it('collapses same-named stops (different platforms) into one entry carrying every stop_id', () => {
    const result = findWalkableStops(origin.lat, origin.lon, stopTables, { capMinutes: DEFAULT_WALK_CAP_MINUTES });
    const near = result.stops.find((s) => s.name === 'Near Station');
    expect(near.stopIds.sort()).toEqual(['near1', 'near2']);
  });

  it('filters out non-boarding wayfinding nodes (decision points, lifts, concourses)', () => {
    const result = findWalkableStops(origin.lat, origin.lon, stopTables, { capMinutes: DEFAULT_WALK_CAP_MINUTES });
    const names = result.stops.map((s) => s.name);
    expect(names).not.toContain('Near Station - Decision Point 1');
    expect(names).not.toContain('Near Station Lift');
  });

  it('falls back to the single nearest stop, flagged withinCap:false, when nothing is within the cap', () => {
    const farOnlyTables = [{ mode: 'train', stopNames: { far: ['Far Station', -38.5000, 145.5000] } }];
    const result = findWalkableStops(origin.lat, origin.lon, farOnlyTables, { capMinutes: DEFAULT_WALK_CAP_MINUTES });
    expect(result.withinCap).toBe(false);
    expect(result.stops).toHaveLength(1);
    expect(result.stops[0].name).toBe('Far Station');
  });

  it('returns an empty, withinCap:true result when there are no stops at all', () => {
    const result = findWalkableStops(origin.lat, origin.lon, [{ mode: 'train', stopNames: {} }], { capMinutes: DEFAULT_WALK_CAP_MINUTES });
    expect(result.stops).toEqual([]);
    expect(result.withinCap).toBe(true);
  });

  it('merges modes when the same stop name appears in more than one mode table', () => {
    const twoModeTables = [
      { mode: 'train', stopNames: { a: ['Shared Station', -37.8136, 144.9631] } },
      { mode: 'vline', stopNames: { b: ['Shared Station', -37.8136, 144.9631] } },
    ];
    const result = findWalkableStops(origin.lat, origin.lon, twoModeTables, { capMinutes: DEFAULT_WALK_CAP_MINUTES });
    expect(result.stops).toHaveLength(1);
    expect(result.stops[0].modes.sort()).toEqual(['train', 'vline']);
    expect(result.stops[0].stopIds.sort()).toEqual(['a', 'b']);
  });
});
