import { createReadStream, writeFileSync, mkdirSync } from 'node:fs';
import { createInterface } from 'node:readline';

const [, , routesPath, region, outputPath] = process.argv;
if (!routesPath || !region || !outputPath) {
  console.error('Usage: node build-bus-routes.js <routes.txt> <region> <output.json>');
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

let idIdx, shortIdx, longIdx, colorIdx;
const output = {};
await forEachRow(routesPath, (fields, headers) => {
  if (idIdx === undefined) {
    idIdx = headers.indexOf('route_id');
    shortIdx = headers.indexOf('route_short_name');
    longIdx = headers.indexOf('route_long_name');
    colorIdx = headers.indexOf('route_color');
  }
  const routeId = fields[idIdx];
  const color = fields[colorIdx];
  output[routeId] = {
    shortName: fields[shortIdx],
    longName: fields[longIdx],
    color: color ? `#${color}` : null,
    region,
  };
});

mkdirSync('./src/data', { recursive: true });
const json = JSON.stringify(output);
writeFileSync(outputPath, json);
console.log(`Wrote ${Object.keys(output).length} ${region} bus routes to ${outputPath} (${(json.length / 1024).toFixed(1)} KB)`);
