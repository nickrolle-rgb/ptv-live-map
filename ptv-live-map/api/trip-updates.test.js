import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('gtfs-realtime-bindings', () => ({
  default: { transit_realtime: { FeedMessage: { decode: vi.fn() } } },
}));

import handler from './trip-updates.js';
import GtfsRealtimeBindings from 'gtfs-realtime-bindings';

const decode = GtfsRealtimeBindings.transit_realtime.FeedMessage.decode;

function mockFeed(entities) {
  decode.mockReturnValue({ entity: entities });
}

function req(query = '') {
  return { url: `https://example.com/api/trip-updates${query}` };
}

function stu(stopId, arrival, departure) {
  return { stopId, arrival: arrival == null ? undefined : { time: arrival }, departure: departure == null ? undefined : { time: departure } };
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

describe('api/trip-updates — mode resolution', () => {
  it('defaults to tram when no mode is given', async () => {
    await handler(req());
    expect(global.fetch.mock.calls[0][0]).toContain('/tram/trip-updates');
  });

  it('defaults to tram for an unrecognised mode', async () => {
    await handler(req('?mode=nonsense'));
    expect(global.fetch.mock.calls[0][0]).toContain('/tram/trip-updates');
  });

  it('fetches the matching upstream feed for a recognised mode', async () => {
    await handler(req('?mode=vline'));
    expect(global.fetch.mock.calls[0][0]).toContain('/vline/trip-updates');
  });
});

describe('api/trip-updates — stopsPerTrip cap', () => {
  const sixStops = ['S1', 'S2', 'S3', 'S4', 'S5', 'S6'].map((id, i) => stu(id, 1000 + i, 1010 + i));

  it('keeps up to 4 upcoming stops per trip for rail/tram modes', async () => {
    mockFeed([{ tripUpdate: { trip: { tripId: 'T1', routeId: 'R1' }, stopTimeUpdate: sixStops } }]);
    const res = await handler(req('?mode=train'));
    const body = await res.json();
    expect(body.T1.stops).toHaveLength(4);
    expect(body.T1.stops.map((s) => s.stopId)).toEqual(['S1', 'S2', 'S3', 'S4']);
  });

  it('caps bus at 1 stop per trip (bus does not use this lookahead data)', async () => {
    mockFeed([{ tripUpdate: { trip: { tripId: 'T1', routeId: 'R1' }, stopTimeUpdate: sixStops } }]);
    const res = await handler(req('?mode=bus'));
    const body = await res.json();
    expect(body.T1.stops).toHaveLength(1);
    expect(body.T1.stops[0].stopId).toBe('S1');
  });
});

describe('api/trip-updates — tripId param (on-board ride detection full stop list)', () => {
  const twentyStops = Array.from({ length: 20 }, (_, i) => stu(`S${i}`, 1000 + i, 1010 + i));

  it('returns the full unsliced stop list for the one trip matching tripId', async () => {
    mockFeed([{ tripUpdate: { trip: { tripId: 'T1', routeId: 'R1' }, stopTimeUpdate: twentyStops } }]);
    const res = await handler(req('?mode=train&tripId=T1'));
    const body = await res.json();
    expect(body.T1.stops).toHaveLength(20);
  });

  it('still applies the normal stopsPerTrip cap to every other trip in the same response', async () => {
    mockFeed([
      { tripUpdate: { trip: { tripId: 'T1', routeId: 'R1' }, stopTimeUpdate: twentyStops } },
      { tripUpdate: { trip: { tripId: 'T2', routeId: 'R2' }, stopTimeUpdate: twentyStops } },
    ]);
    const res = await handler(req('?mode=train&tripId=T1'));
    const body = await res.json();
    expect(body.T1.stops).toHaveLength(20);
    expect(body.T2.stops).toHaveLength(4);
  });

  it('applies the normal cap to every trip when tripId does not match any entity', async () => {
    mockFeed([{ tripUpdate: { trip: { tripId: 'T1', routeId: 'R1' }, stopTimeUpdate: twentyStops } }]);
    const res = await handler(req('?mode=train&tripId=NONEXISTENT'));
    const body = await res.json();
    expect(body.T1.stops).toHaveLength(4);
  });

  it('behaves exactly as before when tripId is absent (no regression to the always-on poll)', async () => {
    mockFeed([{ tripUpdate: { trip: { tripId: 'T1', routeId: 'R1' }, stopTimeUpdate: twentyStops } }]);
    const res = await handler(req('?mode=train'));
    const body = await res.json();
    expect(body.T1.stops).toHaveLength(4);
  });
});

describe('api/trip-updates — entity filtering', () => {
  it('skips entities with no tripId', async () => {
    mockFeed([{ tripUpdate: { trip: {}, stopTimeUpdate: [stu('S1', 1000, 1010)] } }]);
    const res = await handler(req('?mode=train'));
    const body = await res.json();
    expect(body).toEqual({});
  });

  it('skips entities with an empty or missing stopTimeUpdate list', async () => {
    mockFeed([
      { tripUpdate: { trip: { tripId: 'EMPTY' }, stopTimeUpdate: [] } },
      { tripUpdate: { trip: { tripId: 'MISSING' } } },
      { tripUpdate: { trip: { tripId: 'OK' }, stopTimeUpdate: [stu('S1', 1000, 1010)] } },
    ]);
    const res = await handler(req('?mode=train'));
    const body = await res.json();
    expect(Object.keys(body)).toEqual(['OK']);
  });

  it('skips entities with no tripUpdate at all (e.g. a vehicle-position-only entity)', async () => {
    mockFeed([{ vehicle: { trip: { tripId: 'V1' } } }]);
    const res = await handler(req('?mode=train'));
    const body = await res.json();
    expect(body).toEqual({});
  });
});

describe('api/trip-updates — field mapping', () => {
  it('falls back to null for a missing routeId', async () => {
    mockFeed([{ tripUpdate: { trip: { tripId: 'T1' }, stopTimeUpdate: [stu('S1', 1000, 1010)] } }]);
    const res = await handler(req('?mode=train'));
    const body = await res.json();
    expect(body.T1.routeId).toBeNull();
  });

  it('maps arrival/departure to Number when present, null when absent', async () => {
    mockFeed([{
      tripUpdate: {
        trip: { tripId: 'T1', routeId: 'R1' },
        stopTimeUpdate: [stu('S1', 1000, null), stu('S2', null, 2000)],
      },
    }]);
    const res = await handler(req('?mode=train'));
    const body = await res.json();
    expect(body.T1.stops[0]).toEqual({ stopId: 'S1', arrival: 1000, departure: null });
    expect(body.T1.stops[1]).toEqual({ stopId: 'S2', arrival: null, departure: 2000 });
  });

  it('falls back to null stopId when a stop-time update has none', async () => {
    mockFeed([{ tripUpdate: { trip: { tripId: 'T1' }, stopTimeUpdate: [{ arrival: { time: 1000 } }] } }]);
    const res = await handler(req('?mode=train'));
    const body = await res.json();
    expect(body.T1.stops[0].stopId).toBeNull();
  });
});

describe('api/trip-updates — upstream failure handling', () => {
  it('returns 500 when the upstream feed responds with a non-ok status', async () => {
    global.fetch = vi.fn(async () => ({ ok: false, status: 503 }));
    const res = await handler(req('?mode=train'));
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Failed to fetch trip updates' });
  });

  it('returns 500 when the upstream fetch itself throws', async () => {
    global.fetch = vi.fn(async () => { throw new Error('network down'); });
    const res = await handler(req('?mode=train'));
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Failed to fetch trip updates' });
  });
});

describe('api/trip-updates — response headers', () => {
  it('sets a short-lived, stale-while-revalidate cache header on success', async () => {
    const res = await handler(req('?mode=train'));
    expect(res.headers.get('Cache-Control')).toBe('s-maxage=20, stale-while-revalidate=30');
    expect(res.headers.get('Content-Type')).toBe('application/json');
  });
});
