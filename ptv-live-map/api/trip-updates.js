import GtfsRealtimeBindings from 'gtfs-realtime-bindings';

export const config = { runtime: 'edge' };

const FEEDS = {
  tram: 'https://api.opendata.transport.vic.gov.au/opendata/public-transport/gtfs/realtime/v1/tram/trip-updates',
  train: 'https://api.opendata.transport.vic.gov.au/opendata/public-transport/gtfs/realtime/v1/metro/trip-updates',
  vline: 'https://api.opendata.transport.vic.gov.au/opendata/public-transport/gtfs/realtime/v1/vline/trip-updates',
};

export default async function handler(req) {
  const requestedMode = new URL(req.url).searchParams.get('mode');
  const mode = FEEDS[requestedMode] ? requestedMode : 'tram';

  try {
    const upstream = await fetch(FEEDS[mode], { headers: { KeyID: process.env.GTFS_API_KEY } });
    if (!upstream.ok) throw new Error(`Upstream request failed with status ${upstream.status}`);
    const buffer = await upstream.arrayBuffer();
    const feed = GtfsRealtimeBindings.transit_realtime.FeedMessage.decode(new Uint8Array(buffer));

    const updates = {};
    feed.entity.forEach((entity) => {
      const tu = entity.tripUpdate;
      const tripId = tu?.trip?.tripId;
      const stu = tu?.stopTimeUpdate?.[0];
      if (!tripId || !stu) return;
      updates[tripId] = {
        stopId: stu.stopId ?? null,
        arrival: stu.arrival?.time != null ? Number(stu.arrival.time) : null,
        departure: stu.departure?.time != null ? Number(stu.departure.time) : null,
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
