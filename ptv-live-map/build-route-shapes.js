import { createReadStream, writeFileSync, mkdirSync } from 'node:fs';
import { createInterface } from 'node:readline';

const [, , tripsPath, shapesPath, prefix, outputPath, tripsOutputPath] = process.argv;
if (!tripsPath || !shapesPath || !prefix || !outputPath || !tripsOutputPath) {
  console.error('Usage: node build-route-shapes.js <trips.txt> <shapes.txt> <route_id prefix> <shapes-output.json> <trips-output.json>');
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

console.log('Reading trips...');
let routeIdx, shapeIdx, dirIdx, tripIdIdx;
const counts = new Map();
const sampleTripId = new Map();

await forEachRow(tripsPath, (fields, headers) => {
  if (routeIdx === undefined) {
    routeIdx = headers.indexOf('route_id');
    shapeIdx = headers.indexOf('shape_id');
    dirIdx = headers.indexOf('direction_id');
    tripIdIdx = headers.indexOf('trip_id');
  }
  const routeId = fields[routeIdx];
  if (!routeId || !routeId.startsWith(prefix)) return;
  const shapeId = fields[shapeIdx];
  const direction = fields[dirIdx];
  const tripId = fields[tripIdIdx];
  if (!shapeId) return;
  const key = `${routeId}\u0000${direction}\u0000${shapeId}`;
  counts.set(key, (counts.get(key) || 0) + 1);
  if (!sampleTripId.has(key)) sampleTripId.set(key, tripId);
});

const bestShapePerDirection = new Map();
counts.forEach((count, key) => {
  const [routeId, direction, shapeId] = key.split('\u0000');
  if (!bestShapePerDirection.has(routeId)) bestShapePerDirection.set(routeId, new Map());
  const dirMap = bestShapePerDirection.get(routeId);
  const current = dirMap.get(direction);
  if (!current || count > current.count) dirMap.set(direction, { shapeId, count, tripId: sampleTripId.get(key) });
});

const neededShapeIds = new Set();
bestShapePerDirection.forEach((dirMap) => dirMap.forEach(({ shapeId }) => neededShapeIds.add(shapeId)));
console.log(`Routes matched: ${bestShapePerDirection.size}, distinct shapes needed: ${neededShapeIds.size}`);

console.log('Streaming shapes (large file — this may take a little while, that is expected)...');
let sIdIdx, latIdx, lonIdx, seqIdx;
const shapePoints = new Map();
let shapeRowCount = 0;

await forEachRow(shapesPath, (fields, headers) => {
  if (sIdIdx === undefined) {
    sIdIdx = headers.indexOf('shape_id');
    latIdx = headers.indexOf('shape_pt_lat');
    lonIdx = headers.indexOf('shape_pt_lon');
    seqIdx = headers.indexOf('shape_pt_sequence');
  }
  shapeRowCount++;
  const shapeId = fields[sIdIdx];
  if (!neededShapeIds.has(shapeId)) return;
  if (!shapePoints.has(shapeId)) shapePoints.set(shapeId, []);
  shapePoints.get(shapeId).push({ seq: Number(fields[seqIdx]), lat: Number(fields[latIdx]), lon: Number(fields[lonIdx]) });
});
console.log(`Scanned ${shapeRowCount.toLocaleString()} shape points, kept points for ${shapePoints.size} shapes.`);
shapePoints.forEach((points) => points.sort((a, b) => a.seq - b.seq));

const output = {};
const tripsOutput = {};
bestShapePerDirection.forEach((dirMap, routeId) => {
  const lines = [];
  const tripIds = [];
  dirMap.forEach(({ shapeId, tripId }) => {
    const points = shapePoints.get(shapeId);
    if (points && points.length > 1) {
      lines.push(points.map((p) => [p.lat, p.lon]));
      tripIds.push(tripId);
    }
  });
  if (lines.length > 0) { output[routeId] = lines; tripsOutput[routeId] = tripIds; }
});

mkdirSync('./src/data', { recursive: true });
const json = JSON.stringify(output);
writeFileSync(outputPath, json);
writeFileSync(tripsOutputPath, JSON.stringify(tripsOutput));
console.log(`Wrote shapes for ${Object.keys(output).length} routes to ${outputPath} (${(json.length / 1024).toFixed(1)} KB)`);
console.log(`Wrote representative trip IDs to ${tripsOutputPath}`);