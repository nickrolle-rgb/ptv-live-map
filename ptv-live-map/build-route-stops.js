import { createReadStream, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createInterface } from 'node:readline';

const [, , tripsOutputPath, stopTimesPath, stopsPath, outputPath, namesOutputPath] = process.argv;
if (!tripsOutputPath || !stopTimesPath || !stopsPath || !outputPath) {
  console.error('Usage: node build-route-stops.js <route-trips.json> <stop_times.txt> <stops.txt> <output.json> [stop-names-output.json]');
  process.exit(1);
}

function parseCsvLine(line) {
  const fields = [];
  let current = '';
  let inQuotes = false;
  for (const char of line) {
    if (char === '"') inQuotes = !inQuotes;
    else if (char === ',' && !inQuotes) { fields.push(current); current = ''; }
    else current += char;
  }
  fields.push(current);
  return fields;
}

async function forEachRow(path, onRow) {
  const rl = createInterface({ input: createReadStream(path, { encoding: 'utf-8' }), crlfDelay: Infinity });
  let headers = null;
  let first = true;
  for await (const rawLine of rl) {
    if (!rawLine) continue;
    const line = first && rawLine.charCodeAt(0) === 0xFEFF ? rawLine.slice(1) : rawLine;
    if (first) { headers = parseCsvLine(line); first = false; continue; }
    onRow(parseCsvLine(line), headers);
  }
}

const routeTrips = JSON.parse(readFileSync(tripsOutputPath, 'utf-8'));
const neededTripIds = new Set();
Object.values(routeTrips).forEach((tripIds) => tripIds.forEach((id) => neededTripIds.add(id)));
console.log(`Looking for stop times across ${neededTripIds.size} representative trips...`);

console.log('Streaming stop_times (usually the largest file in the export — this may take a little while, that is expected)...');
let stTripIdx, stStopIdx, stSeqIdx;
const stopsByTrip = new Map();
let stopTimeRowCount = 0;

await forEachRow(stopTimesPath, (fields, headers) => {
  if (stTripIdx === undefined) {
    stTripIdx = headers.indexOf('trip_id');
    stStopIdx = headers.indexOf('stop_id');
    stSeqIdx = headers.indexOf('stop_sequence');
  }
  stopTimeRowCount++;
  const tripId = fields[stTripIdx];
  if (!neededTripIds.has(tripId)) return;
  if (!stopsByTrip.has(tripId)) stopsByTrip.set(tripId, []);
  stopsByTrip.get(tripId).push({ stopId: fields[stStopIdx], seq: Number(fields[stSeqIdx]) });
});
console.log(`Scanned ${stopTimeRowCount.toLocaleString()} stop_times rows, matched ${stopsByTrip.size} of ${neededTripIds.size} needed trips.`);
stopsByTrip.forEach((list) => list.sort((a, b) => a.seq - b.seq));

const neededStopIds = new Set();
stopsByTrip.forEach((list) => list.forEach((s) => neededStopIds.add(s.stopId)));

console.log('Reading stops...');
let sIdIdx, sNameIdx, sLatIdx, sLonIdx;
const stopLookup = new Map();
await forEachRow(stopsPath, (fields, headers) => {
  if (sIdIdx === undefined) {
    sIdIdx = headers.indexOf('stop_id');
    sNameIdx = headers.indexOf('stop_name');
    sLatIdx = headers.indexOf('stop_lat');
    sLonIdx = headers.indexOf('stop_lon');
  }
  const stopId = fields[sIdIdx];
  if (!neededStopIds.has(stopId)) return;
  stopLookup.set(stopId, { name: fields[sNameIdx], lat: Number(fields[sLatIdx]), lon: Number(fields[sLonIdx]) });
});

const output = {};
Object.entries(routeTrips).forEach(([routeId, tripIds]) => {
  const lines = tripIds
    .map((tripId) => (stopsByTrip.get(tripId) || []).map((s) => stopLookup.get(s.stopId)).filter(Boolean).map((s) => [s.lat, s.lon]))
    .filter((line) => line.length > 0);
  if (lines.length > 0) output[routeId] = lines;
});

mkdirSync('./src/data', { recursive: true });
const json = JSON.stringify(output);
writeFileSync(outputPath, json);
console.log(`Wrote stops for ${Object.keys(output).length} routes to ${outputPath} (${(json.length / 1024).toFixed(1)} KB)`);

if (namesOutputPath) {
  // Reuses stopLookup/stopsByTrip already computed above — no extra pass over
  // stop_times.txt needed. Used to let riders search a route by a station it serves,
  // not just by route name.
  const namesOutput = {};
  Object.entries(routeTrips).forEach(([routeId, tripIds]) => {
    const names = new Set();
    tripIds.forEach((tripId) => {
      (stopsByTrip.get(tripId) || []).forEach((s) => {
        const stop = stopLookup.get(s.stopId);
        if (stop) names.add(stop.name);
      });
    });
    if (names.size > 0) namesOutput[routeId] = [...names];
  });
  const namesJson = JSON.stringify(namesOutput);
  writeFileSync(namesOutputPath, namesJson);
  console.log(`Wrote stop names for ${Object.keys(namesOutput).length} routes to ${namesOutputPath} (${(namesJson.length / 1024).toFixed(1)} KB)`);
}