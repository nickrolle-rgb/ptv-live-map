import GtfsRealtimeBindings from 'gtfs-realtime-bindings';

export const config = { runtime: 'edge' };

const FEEDS = {
  tram: 'https://api.opendata.transport.vic.gov.au/opendata/public-transport/gtfs/realtime/v1/tram/service-alerts',
  train: 'https://api.opendata.transport.vic.gov.au/opendata/public-transport/gtfs/realtime/v1/metro/service-alerts',
};

export default async function handler(req) {
  const mode = new URL(req.url).searchParams.get('mode') === 'train' ? 'train' : 'tram';

  try {
    const upstream = await fetch(FEEDS[mode], { headers: { KeyID: process.env.GTFS_API_KEY } });
    if (!upstream.ok) throw new Error(`Upstream request failed with status ${upstream.status}`);
    const buffer = await upstream.arrayBuffer();
    const feed = GtfsRealtimeBindings.transit_realtime.FeedMessage.decode(new Uint8Array(buffer));

    const alerts = feed.entity
      .filter((entity) => entity.alert)
      .map((entity) => {
        const alert = entity.alert;
        const routeIds = (alert.informedEntity || []).map((e) => e.routeId).filter(Boolean);
        const text = alert.headerText?.translation?.[0]?.text || 'Service alert';
        return { routeIds, text };
      })
      .filter((a) => a.routeIds.length > 0);

    return new Response(JSON.stringify(alerts), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 's-maxage=30, stale-while-revalidate=60',
      },
    });
  } catch (err) {
    console.error(err);
    return new Response(JSON.stringify({ error: 'Failed to fetch service alerts' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}
