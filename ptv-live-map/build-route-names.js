import fs from 'node:fs';

const [, , inputPath, prefix, outputPath, nameField] = process.argv;
if (!inputPath || !prefix || !outputPath) {
  console.error('Usage: node build-route-names.js <input.txt> <route_id prefix> <output.json> [long]');
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

function formatLongName(text) {
  const match = text.match(/^(.+?) - Melbourne Via (.+)$/i);
  if (!match) return text;
  const [, destination, via] = match;
  return destination.trim() === via.trim() ? destination.trim() : `${destination.trim()} via ${via.trim()}`;
}

let raw = fs.readFileSync(inputPath, 'utf-8');
if (raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1);
const lines = raw.split(/\r?\n/).filter(Boolean);
const headers = parseCsvLine(lines[0]);

console.log('Headers found:', headers);
console.log('Total data rows:', lines.length - 1);

const idIndex = headers.indexOf('route_id');
const shortNameIndex = headers.indexOf('route_short_name');
const longNameIndex = headers.indexOf('route_long_name');
const colorIndex = headers.indexOf('route_color');

if (idIndex === -1) {
  throw new Error('Could not find a "route_id" column — check the headers printed above.');
}

const lookup = {};

for (const line of lines.slice(1)) {
  const fields = parseCsvLine(line);
  const routeId = fields[idIndex];
  if (!routeId || !routeId.startsWith(prefix)) continue;

  const shortName = fields[shortNameIndex];
  const longName = fields[longNameIndex];
  const color = fields[colorIndex] ? `#${fields[colorIndex]}` : null;

  const name = shortName === 'Replacement Bus'
    ? `${longName.replace(' - City', '')} (bus replacement)`
    : nameField === 'long'
      ? formatLongName(longName)
      : shortName || longName;

  lookup[routeId] = { name, color };
}

fs.mkdirSync('./src/data', { recursive: true });
fs.writeFileSync(outputPath, JSON.stringify(lookup, null, 2));
console.log(`Wrote ${Object.keys(lookup).length} routes to ${outputPath}`);