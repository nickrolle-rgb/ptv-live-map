import GtfsRealtimeBindings from 'gtfs-realtime-bindings';

export const config = { runtime: 'edge' };

const FEEDS = {
  tram: 'https://api.opendata.transport.vic.gov.au/opendata/public-transport/gtfs/realtime/v1/tram/trip-updates',
  train: 'https://api.opendata.transport.vic.gov.au/opendata/public-transport/gtfs/realtime/v1/metro/trip-updates',
  vline: 'https://api.opendata.transport.vic.gov.au/opendata/public-transport/gtfs/realtime/v1/vline/trip-updates',
  bus: 'https://api.opendata.transport.vic.gov.au/opendata/public-transport/gtfs/realtime/v1/bus/trip-updates',
};

export default async function handler(req) {
  const requestedMode = new URL(req.url).searchParams.get('mode');
  const mode = FEEDS[requestedMode] ? requestedMode : 'tram';

  try {
    const upstream = await fetch(FEEDS[mode], { headers: { KeyID: process.env.GTFS_API_KEY } });
    if (!upstream.ok) throw new Error(`Upstream request failed with status ${upstream.status}`);
    const buffer = await upstream.arrayBuffer();
    const feed = GtfsRealtimeBindings.transit_realtime.FeedMessage.decode(new Uint8Array(buffer));

    // Keep several upcoming stops per trip (not just the immediate one) so a
    // stop-centric "nearest stops" view can be built client-side. Bus stays capped at
    // 1 — its trip-updates are already fetched live per searched route and this data
    // isn't used for buses, so there's no reason to pay the extra payload size.
    const stopsPerTrip = mode === 'bus' ? 1 : 4;
    const updates = {};
    feed.entity.forEach((entity) => {
      const tu = entity.tripUpdate;
      const tripId = tu?.trip?.tripId;
      const stus = tu?.stopTimeUpdate?.slice(0, stopsPerTrip);
      if (!tripId || !stus?.length) return;
      updates[tripId] = {
        routeId: tu.trip?.routeId ?? null,
        stops: stus.map((stu) => ({
          stopId: stu.stopId ?? null,
          arrival: stu.arrival?.time != null ? Number(stu.arrival.time) : null,
          departure: stu.departure?.time != null ? Number(stu.departure.time) : null,
        })),
      };
    });

    return new Response(JSON.stringify(updates), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 's-maxage=20, stale-while-revalidate=30',
      },
    });
  } catch (err) {
    console.error(err);
    return new Response(JSON.stringify({ error: 'Failed to fetch trip updates' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}
