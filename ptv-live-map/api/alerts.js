import https from 'node:https';
import GtfsRealtimeBindings from 'gtfs-realtime-bindings';

const FEEDS = {
  tram: 'https://api.opendata.transport.vic.gov.au/opendata/public-transport/gtfs/realtime/v1/tram/service-alerts',
  train: 'https://api.opendata.transport.vic.gov.au/opendata/public-transport/gtfs/realtime/v1/metro/service-alerts',
};

function fetchBuffer(url, headers) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers }, (response) => {
      if (response.statusCode < 200 || response.statusCode >= 300) {
        reject(new Error(`Upstream request failed with status ${response.statusCode}`));
        response.resume();
        return;
      }
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => resolve(Buffer.concat(chunks)));
    }).on('error', reject);
  });
}

export default async function handler(req, res) {
  const mode = req.query.mode === 'train' ? 'train' : 'tram';

  try {
    const buffer = await fetchBuffer(FEEDS[mode], { KeyID: process.env.GTFS_API_KEY });
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

    res.setHeader('Cache-Control', 's-maxage=30, stale-while-revalidate=60');
    res.status(200).json(alerts);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch service alerts' });
  }
}