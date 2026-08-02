import { describe, it, expect, vi, beforeEach } from 'vitest';

// gtfs-realtime-bindings does real protobuf decoding of upstream bytes — mocked here so
// tests control the decoded feed shape directly instead of hand-crafting valid protobuf
// wire bytes just to exercise this handler's own field-mapping/filtering logic.
vi.mock('gtfs-realtime-bindings', () => ({
  default: { transit_realtime: { FeedMessage: { decode: vi.fn() } } },
}));

import handler from './vehicles.js';
import GtfsRealtimeBindings from 'gtfs-realtime-bindings';

const decode = GtfsRealtimeBindings.transit_realtime.FeedMessage.decode;

function mockFeed(entities) {
  decode.mockReturnValue({ entity: entities });
}

function req(query = '') {
  return { url: `https://example.com/api/vehicles${query}` };
}

beforeEach(() => {
  decode.mockReset();
  mockFeed([]);
  global.fetch = vi.fn(async () => ({
    ok: true,
    status: 200,
    arrayBuffer: async () => new ArrayBuffer(0),
  }));
});

describe('api/vehicles — mode resolution', () => {
  it('defaults to tram when no mode is given', async () => {
    await handler(req());
    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(global.fetch.mock.calls[0][0]).toContain('/tram/vehicle-positions');
  });

  it('defaults to tram for an unrecognised mode rather than passing it through', async () => {
    await handler(req('?mode=not-a-real-mode'));
    expect(global.fetch.mock.calls[0][0]).toContain('/tram/vehicle-positions');
  });

  it('fetches the matching upstream feed for a recognised mode', async () => {
    await handler(req('?mode=train'));
    expect(global.fetch.mock.calls[0][0]).toContain('/metro/vehicle-positions');
  });
});

describe('api/vehicles — bus route filtering', () => {
  it('never hits the upstream feed for bus without a routeShortName (avoids the unfiltered ~1,500-vehicle feed)', async () => {
    const res = await handler(req('?mode=bus'));
    expect(global.fetch).not.toHaveBeenCalled();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  });

  it('filters bus vehicles down to only the requested route', async () => {
    mockFeed([
      { id: 'v1', vehicle: { trip: { routeId: '901' }, position: {} } },
      { id: 'v2', vehicle: { trip: { routeId: '902' }, position: {} } },
      { id: 'v3', vehicle: { trip: { routeId: '901' }, position: {} } },
    ]);
    const res = await handler(req('?mode=bus&routeShortName=901'));
    const body = await res.json();
    expect(body.map((v) => v.id).sort()).toEqual(['v1', 'v3']);
    expect(body.every((v) => v.routeId === '901')).toBe(true);
  });

  it('does not filter by route for non-bus modes even if routeShortName is (irrelevantly) present', async () => {
    mockFeed([
      { id: 'v1', vehicle: { trip: { routeId: 'A' }, position: {} } },
      { id: 'v2', vehicle: { trip: { routeId: 'B' }, position: {} } },
    ]);
    const res = await handler(req('?mode=train&routeShortName=A'));
    const body = await res.json();
    expect(body).toHaveLength(2);
  });
});

describe('api/vehicles — field mapping', () => {
  it('filters out feed entities with no vehicle payload at all', async () => {
    mockFeed([
      { id: 'trip-update-only', tripUpdate: {} },
      { id: 'v1', vehicle: { trip: {}, position: {} } },
    ]);
    const res = await handler(req('?mode=train'));
    const body = await res.json();
    expect(body).toHaveLength(1);
    expect(body[0].id).toBe('v1');
  });

  it('maps every field, and falls back to null (not undefined/throw) when sub-fields are entirely absent', async () => {
    mockFeed([{ id: 'bare', vehicle: {} }]);
    const res = await handler(req('?mode=train'));
    const [v] = await res.json();
    expect(v).toEqual({
      id: 'bare',
      routeId: null,
      tripId: null,
      lat: undefined,
      lon: undefined,
      bearing: null,
      speed: null,
      occupancyStatus: null,
      stopId: null,
      currentStatus: null,
      timestamp: null,
    });
  });

  it('converts a present timestamp to a Number rather than leaving it as a protobuf Long/string', async () => {
    mockFeed([{ id: 'v1', vehicle: { timestamp: '1735689600' } }]);
    const res = await handler(req('?mode=train'));
    const [v] = await res.json();
    expect(v.timestamp).toBe(1735689600);
    expect(typeof v.timestamp).toBe('number');
  });

  it('reads lat/lon straight from position when present', async () => {
    mockFeed([{ id: 'v1', vehicle: { position: { latitude: -37.8, longitude: 144.96 } } }]);
    const res = await handler(req('?mode=train'));
    const [v] = await res.json();
    expect(v.lat).toBe(-37.8);
    expect(v.lon).toBe(144.96);
  });
});

describe('api/vehicles — upstream failure handling', () => {
  it('returns 500 when the upstream feed responds with a non-ok status', async () => {
    global.fetch = vi.fn(async () => ({ ok: false, status: 503 }));
    const res = await handler(req('?mode=train'));
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Failed to fetch vehicle positions' });
  });

  it('returns 500 when the upstream fetch itself throws (network failure)', async () => {
    global.fetch = vi.fn(async () => { throw new Error('network down'); });
    const res = await handler(req('?mode=train'));
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Failed to fetch vehicle positions' });
  });
});

describe('api/vehicles — response headers', () => {
  it('sets a short-lived, stale-while-revalidate cache header on success', async () => {
    const res = await handler(req('?mode=train'));
    expect(res.headers.get('Cache-Control')).toBe('s-maxage=20, stale-while-revalidate=30');
    expect(res.headers.get('Content-Type')).toBe('application/json');
  });
});
