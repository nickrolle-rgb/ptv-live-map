import { describe, it, expect } from 'vitest';
import { haversineKm } from './geo.js';

describe('haversineKm', () => {
  it('is zero for identical points', () => {
    expect(haversineKm(-37.8136, 144.9631, -37.8136, 144.9631)).toBe(0);
  });

  it('is symmetric', () => {
    const a = [-37.8183, 144.9667]; // Flinders Street Station
    const b = [-38.1426, 145.1260]; // Frankston Station
    expect(haversineKm(...a, ...b)).toBeCloseTo(haversineKm(...b, ...a), 10);
  });

  it('matches a known real-world distance (Flinders St -> Frankston, ~39km as the crow flies)', () => {
    const km = haversineKm(-37.8183, 144.9667, -38.1426, 145.1260);
    expect(km).toBeGreaterThan(35);
    expect(km).toBeLessThan(43);
  });

  it('satisfies the triangle inequality for three arbitrary points', () => {
    const a = [-37.8136, 144.9631]; // Melbourne CBD
    const b = [-37.8136, 145.0631]; // ~10km east
    const c = [-37.9136, 144.9631]; // ~10km south
    const ab = haversineKm(...a, ...b);
    const bc = haversineKm(...b, ...c);
    const ac = haversineKm(...a, ...c);
    expect(ac).toBeLessThanOrEqual(ab + bc + 1e-9);
  });

  it('one degree of latitude is close to 111km, independent of longitude', () => {
    expect(haversineKm(0, 0, 1, 0)).toBeCloseTo(111.19, 0);
    expect(haversineKm(-37, 145, -36, 145)).toBeCloseTo(111.19, 0);
  });
});
