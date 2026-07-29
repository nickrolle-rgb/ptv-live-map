import { createReadStream, writeFileSync, mkdirSync } from 'node:fs';
import { createInterface } from 'node:readline';

const [, , stopsPath, outputPath] = process.argv;
if (!stopsPath || !outputPath) {
  console.error('Usage: node build-stop-names.js <stops.txt> <output.json>');
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

let idIdx, nameIdx;
const output = {};
await forEachRow(stopsPath, (fields, headers) => {
  if (idIdx === undefined) {
    idIdx = headers.indexOf('stop_id');
    nameIdx = headers.indexOf('stop_name');
  }
  output[fields[idIdx]] = fields[nameIdx];
});

mkdirSync('./src/data', { recursive: true });
const json = JSON.stringify(output);
writeFileSync(outputPath, json);
console.log(`Wrote ${Object.keys(output).length} stop names to ${outputPath} (${(json.length / 1024).toFixed(1)} KB)`);
