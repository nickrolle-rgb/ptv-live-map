import https from 'node:https';
import GtfsRealtimeBindings from 'gtfs-realtime-bindings';

const FEEDS = {
  tram: 'https://api.opendata.transport.vic.gov.au/opendata/public-transport/gtfs/realtime/v1/tram/vehicle-positions',
  train: 'https://api.opendata.transport.vic.gov.au/opendata/public-transport/gtfs/realtime/v1/metro/vehicle-positions',
  vline: 'https://api.opendata.transport.vic.gov.au/opendata/public-transport/gtfs/realtime/v1/vline/vehicle-positions',
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
  const mode = FEEDS[req.query.mode] ? req.query.mode : 'tram';

  try {
    const buffer = await fetchBuffer(FEEDS[mode], { KeyID: process.env.GTFS_API_KEY });
    const feed = GtfsRealtimeBindings.transit_realtime.FeedMessage.decode(new Uint8Array(buffer));

    const vehicles = feed.entity
      .filter((entity) => entity.vehicle)
      .map((entity) => {
        const v = entity.vehicle;
        return {
          id: entity.id,
          routeId: v.trip?.routeId ?? null,
          lat: v.position?.latitude,
          lon: v.position?.longitude,
          bearing: v.position?.bearing ?? null,
          speed: v.position?.speed ?? null,
          mode,
        };
      });

    res.setHeader('Cache-Control', 's-maxage=20, stale-while-revalidate=30');
    res.status(200).json(vehicles);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch vehicle positions' });
  }
}