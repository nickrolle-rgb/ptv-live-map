import { createReadStream, writeFileSync, mkdirSync } from 'node:fs';
import { createInterface } from 'node:readline';

const [, , tripsPath, outputPath] = process.argv;
if (!tripsPath || !outputPath) {
  console.error('Usage: node build-bus-trip-info.js <trips.txt> <output.json>');
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

let tripIdx, routeIdx, headsignIdx;
const output = {};
await forEachRow(tripsPath, (fields, headers) => {
  if (tripIdx === undefined) {
    tripIdx = headers.indexOf('trip_id');
    routeIdx = headers.indexOf('route_id');
    headsignIdx = headers.indexOf('trip_headsign');
  }
  const routeId = fields[routeIdx];
  const headsign = fields[headsignIdx];
  if (!routeId) return;
  output[fields[tripIdx]] = [routeId, headsign || null];
});

mkdirSync('./src/data', { recursive: true });
const json = JSON.stringify(output);
writeFileSync(outputPath, json);
console.log(`Wrote ${Object.keys(output).length} trip records to ${outputPath} (${(json.length / 1024).toFixed(1)} KB)`);
