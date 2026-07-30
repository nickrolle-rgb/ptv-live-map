import GtfsRealtimeBindings from 'gtfs-realtime-bindings';

export const config = { runtime: 'edge' };

const FEEDS = {
  tram: 'https://api.opendata.transport.vic.gov.au/opendata/public-transport/gtfs/realtime/v1/tram/vehicle-positions',
  train: 'https://api.opendata.transport.vic.gov.au/opendata/public-transport/gtfs/realtime/v1/metro/vehicle-positions',
  vline: 'https://api.opendata.transport.vic.gov.au/opendata/public-transport/gtfs/realtime/v1/vline/vehicle-positions',
};

export default async function handler(req) {
  const requestedMode = new URL(req.url).searchParams.get('mode');
  const mode = FEEDS[requestedMode] ? requestedMode : 'tram';

  try {
    const upstream = await fetch(FEEDS[mode], { headers: { KeyID: process.env.GTFS_API_KEY } });
    if (!upstream.ok) throw new Error(`Upstream request failed with status ${upstream.status}`);
    const buffer = await upstream.arrayBuffer();
    const feed = GtfsRealtimeBindings.transit_realtime.FeedMessage.decode(new Uint8Array(buffer));

    const vehicles = feed.entity
      .filter((entity) => entity.vehicle)
      .map((entity) => {
        const v = entity.vehicle;
        return {
          id: entity.id,
          routeId: v.trip?.routeId ?? null,
          tripId: v.trip?.tripId ?? null,
          lat: v.position?.latitude,
          lon: v.position?.longitude,
          bearing: v.position?.bearing ?? null,
          speed: v.position?.speed ?? null,
          occupancyStatus: v.occupancyStatus ?? null,
          stopId: v.stopId ?? null,
          currentStatus: v.currentStatus ?? null,
        };
      });

    return new Response(JSON.stringify(vehicles), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 's-maxage=20, stale-while-revalidate=30',
      },
    });
  } catch (err) {
    console.error(err);
    return new Response(JSON.stringify({ error: 'Failed to fetch vehicle positions' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}
