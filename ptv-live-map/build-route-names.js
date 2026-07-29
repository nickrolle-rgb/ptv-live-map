import fs from 'node:fs';

const [, , inputPath, prefix, outputPath] = process.argv;
if (!inputPath || !prefix || !outputPath) {
  console.error('Usage: node build-route-names.js <input.txt> <route_id prefix> <output.json>');
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

let raw = fs.readFileSync(inputPath, 'utf-8');
if (raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1);
const lines = raw.split(/\r?\n/).filter(Boolean);
const headers = parseCsvLine(lines[0]);

const idIndex = headers.indexOf('route_id');
const shortNameIndex = headers.indexOf('route_short_name');
const longNameIndex = headers.indexOf('route_long_name');
const colorIndex = headers.indexOf('route_color');

const lookup = {};
for (const line of lines.slice(1)) {
  const fields = parseCsvLine(line);
  const routeId = fields[idIndex];
  if (!routeId || !routeId.startsWith(prefix)) continue;
  const shortName = fields[shortNameIndex];
  const longName = fields[longNameIndex];
  const name = shortName === 'Replacement Bus'
    ? `${longName.replace(' - City', '')} (bus replacement)`
    : shortName || longName;
  const color = fields[colorIndex] ? `#${fields[colorIndex]}` : null;
  lookup[routeId] = { name, color };
}

fs.mkdirSync('./src/data', { recursive: true });
fs.writeFileSync(outputPath, JSON.stringify(lookup, null, 2));
console.log(`Wrote ${Object.keys(lookup).length} routes to ${outputPath}`);