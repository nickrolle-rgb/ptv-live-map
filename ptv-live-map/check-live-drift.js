import { readFileSync, existsSync } from 'node:fs';
import GtfsRealtimeBindings from 'gtfs-realtime-bindings';
import { melbourneDateAndSeconds } from './src/schedule-search.js';

// Differential check: live GTFS-RT trip-updates vs. the static schedule's own prediction
// for the same trip+stop, for whatever is running right now. Deliberately NOT part of
// `npm test` — it needs a real GTFS_API_KEY and live network data, and live transit data
// is inherently non-deterministic, so it can't be a repeatable CI assertion the way
// schedule-search.test.js's synthetic fixtures are.
//
// The two numbers being compared come from independently-polled/derived sources (a live
// feed vs. a bundled static extract run through schedule-search.js's own date math), so
// close agreement on an unremarkable trip is a good sign; a large, systematic gap across
// many trips — especially a suspiciously round one like 60 or 600 minutes — points to a
// bug in one of the two paths (a timezone/offset mistake, e.g.), where a single real
// trip running late is expected to be random, not systematic.
//
// Usage: node check-live-drift.js [train|vline]

if (!process.env.GTFS_API_KEY && existsSync('.env.local')) {
  readFileSync('.env.local', 'utf-8').split('\n').forEach((line) => {
    const m = line.match(/^([A-Z_]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
  });
}
if (!process.env.GTFS_API_KEY) {
  console.error('GTFS_API_KEY is not set (checked process.env and .env.local). Get one from https://opendata.transport.vic.gov.au/.');
  process.exit(1);
}

const [, , modeArg] = process.argv;
const mode = modeArg === 'vline' ? 'vline' : 'train';
const FEEDS = {
  train: 'https://api.opendata.transport.vic.gov.au/opendata/public-transport/gtfs/realtime/v1/metro/trip-updates',
  vline: 'https://api.opendata.transport.vic.gov.au/opendata/public-transport/gtfs/realtime/v1/vline/trip-updates',
};
const THRESHOLD_MIN = 15;

console.log(`Fetching live ${mode} trip-updates...`);
const res = await fetch(FEEDS[mode], { headers: { KeyID: process.env.GTFS_API_KEY } });
if (!res.ok) {
  console.error(`Upstream request failed: ${res.status}`);
  process.exit(1);
}
const buffer = await res.arrayBuffer();
const feed = GtfsRealtimeBindings.transit_realtime.FeedMessage.decode(new Uint8Array(buffer));

console.log(`Loading bundled static ${mode} schedule...`);
const schedule = JSON.parse(readFileSync(`./src/data/schedule/${mode}-schedule.json`, 'utf-8'));
const stopIndexById = new Map(schedule.stopIds.map((id, idx) => [id, idx]));

// Epoch ms for local midnight "today" in Melbourne — derived from the app's own date
// math (melbourneDateAndSeconds), not a hand-rolled offset, so this script reasons about
// time the same way the app does.
const nowMs = Date.now();
const { seconds: nowSeconds } = melbourneDateAndSeconds(nowMs);
const todayStartMs = nowMs - nowSeconds * 1000;

let compared = 0;
let large = 0;
const deltasMin = [];

for (const entity of feed.entity) {
  const tu = entity.tripUpdate;
  const tripId = tu?.trip?.tripId;
  const trip = tripId && schedule.trips[tripId];
  if (!trip) continue;

  for (const stu of tu.stopTimeUpdate ?? []) {
    const liveSec = stu.arrival?.time ?? stu.departure?.time;
    if (liveSec == null || !stu.stopId) continue;
    const stopIdx = stopIndexById.get(stu.stopId);
    const staticStop = trip.stops.find(([idx]) => idx === stopIdx);
    if (!staticStop) continue;
    const [, staticArr, staticDep] = staticStop;
    const staticSec = staticArr ?? staticDep;
    if (staticSec == null) continue;

    const staticEpochMs = todayStartMs + staticSec * 1000;
    const liveEpochMs = Number(liveSec) * 1000;
    const deltaMin = (liveEpochMs - staticEpochMs) / 60000;
    compared++;
    deltasMin.push(deltaMin);
    if (Math.abs(deltaMin) > THRESHOLD_MIN) {
      large++;
      console.log(
        `  [large drift] trip=${tripId} stop=${stu.stopId} ` +
        `static=${new Date(staticEpochMs).toLocaleTimeString('en-AU')} ` +
        `live=${new Date(liveEpochMs).toLocaleTimeString('en-AU')} delta=${deltaMin.toFixed(1)}min`
      );
    }
    break; // one stop per trip is enough signal for this diagnostic
  }
}

const meanDelta = deltasMin.length ? deltasMin.reduce((a, b) => a + b, 0) / deltasMin.length : 0;
console.log(`\nCompared ${compared} trip/stop pairs. ${large} exceeded the ${THRESHOLD_MIN}-minute drift threshold.`);
console.log(`Mean delta: ${meanDelta.toFixed(1)} min (live minus static).`);
console.log('A handful of large deltas is normal (real disruptions/early running). A large mean delta, or one clustered near a round number like 60/600 minutes, points to a timezone or unit bug rather than real-world delay.');
