import https from 'node:https';
import GtfsRealtimeBindings from 'gtfs-realtime-bindings';

const FEEDS = {
  tram: 'https://api.opendata.transport.vic.gov.au/opendata/public-transport/gtfs/realtime/v1/tram/trip-updates',
  train: 'https://api.opendata.transport.vic.gov.au/opendata/public-transport/gtfs/realtime/v1/metro/trip-updates',
  vline: 'https://api.opendata.transport.vic.gov.au/opendata/public-transport/gtfs/realtime/v1/vline/trip-updates',
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

    res.setHeader('Cache-Control', 's-maxage=20, stale-while-revalidate=30');
    res.status(200).json(updates);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch trip updates' });
  }
}
