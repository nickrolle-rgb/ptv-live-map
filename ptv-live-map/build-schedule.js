import { createReadStream, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { dirname } from 'node:path';

// Phase 4 of journey planning (see PRINCIPLES.md's roadmap). Scoped to Metro Train and
// V/Line first — a real GTFS export showed tram+bus's stop_times.txt is ~15x bigger
// (11.1M rows / 894MB combined) than train+V/Line's (738K rows / 59MB), confirmed
// before committing to this rather than assumed; tram/bus are deferred to a later pass.
//
// Unlike build-route-stops.js (which deliberately samples one representative trip per
// route+direction for drawing a line on the map), this retains every trip's full,
// ordered stop sequence with real scheduled times — the actual substrate a
// stop_times-based journey planner needs, not just a shape to draw. Output is
// dictionary-encoded (stop/route ids referenced by index, not repeated per trip/stop)
// to keep the result well short of the raw CSV size without needing a database.

const [, , tripsPath, stopTimesPath, calendarPath, calendarDatesPath, transfersPath, outputPath] = process.argv;
if (!tripsPath || !stopTimesPath || !calendarPath || !calendarDatesPath || !transfersPath || !outputPath) {
  console.error('Usage: node build-schedule.js <trips.txt> <stop_times.txt> <calendar.txt> <calendar_dates.txt> <transfers.txt> <output.json>');
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
  let headerIndex = null;
  let first = true;
  for await (const rawLine of rl) {
    if (!rawLine) continue;
    const line = first && rawLine.charCodeAt(0) === 0xFEFF ? rawLine.slice(1) : rawLine;
    if (first) {
      headers = parseCsvLine(line);
      headerIndex = new Map(headers.map((h, i) => [h, i]));
      first = false;
      continue;
    }
    onRow(parseCsvLine(line), headerIndex);
  }
}

function col(fields, headerIndex, name) {
  const idx = headerIndex.get(name);
  return idx === undefined ? undefined : fields[idx];
}

// "HH:MM:SS" -> seconds since midnight of the service day (can exceed 86400 for a trip
// that runs past midnight — GTFS's own convention, kept as-is rather than wrapped, so
// a later stage can tell a 25:30 trip apart from a 01:30 one).
function parseGtfsTime(value) {
  if (!value) return null;
  const [h, m, s] = value.split(':').map(Number);
  if (Number.isNaN(h) || Number.isNaN(m) || Number.isNaN(s)) return null;
  return h * 3600 + m * 60 + s;
}

function makeInterner(list, index) {
  return (value) => {
    if (value == null || value === '') return null;
    let idx = index.get(value);
    if (idx === undefined) {
      idx = list.length;
      list.push(value);
      index.set(value, idx);
    }
    return idx;
  };
}

const stopIds = [];
const internStop = makeInterner(stopIds, new Map());
const routeIds = [];
const internRoute = makeInterner(routeIds, new Map());
const serviceIds = [];
const internService = makeInterner(serviceIds, new Map());

console.log('Reading trips...');
const trips = new Map(); // tripId -> { r, s, stops: [] }
await forEachRow(tripsPath, (fields, headerIndex) => {
  const tripId = col(fields, headerIndex, 'trip_id');
  if (!tripId) return;
  trips.set(tripId, {
    r: internRoute(col(fields, headerIndex, 'route_id')),
    s: internService(col(fields, headerIndex, 'service_id')),
    stops: [],
  });
});
console.log(`Read ${trips.size.toLocaleString()} trips.`);

console.log('Streaming stop_times (the largest file — this will take a little while, that is expected)...');
let stopTimeRows = 0;
let skippedNoTrip = 0;
await forEachRow(stopTimesPath, (fields, headerIndex) => {
  stopTimeRows++;
  const tripId = col(fields, headerIndex, 'trip_id');
  const trip = trips.get(tripId);
  if (!trip) { skippedNoTrip++; return; }
  trip.stops.push([
    Number(col(fields, headerIndex, 'stop_sequence')),
    internStop(col(fields, headerIndex, 'stop_id')),
    parseGtfsTime(col(fields, headerIndex, 'arrival_time')),
    parseGtfsTime(col(fields, headerIndex, 'departure_time')),
  ]);
});
console.log(`Scanned ${stopTimeRows.toLocaleString()} stop_times rows (${skippedNoTrip.toLocaleString()} referenced a trip not in trips.txt, skipped).`);

// Sort each trip's stops by stop_sequence (stop_times.txt is usually already in this
// order, but GTFS doesn't guarantee it) and drop the now-redundant sequence number —
// array order carries it from here on, one less number to store per stop.
const tripsOut = {};
trips.forEach((trip, tripId) => {
  if (trip.stops.length === 0) return; // no matching stop_times rows at all — skip
  trip.stops.sort((a, b) => a[0] - b[0]);
  tripsOut[tripId] = { r: trip.r, s: trip.s, stops: trip.stops.map(([, stopIdx, arrival, departure]) => [stopIdx, arrival, departure]) };
});

console.log('Reading calendar...');
const DAY_COLUMNS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
const calendar = {};
await forEachRow(calendarPath, (fields, headerIndex) => {
  const serviceId = col(fields, headerIndex, 'service_id');
  if (!serviceId) return;
  calendar[serviceId] = {
    days: DAY_COLUMNS.map((d) => Number(col(fields, headerIndex, d)) || 0),
    start: col(fields, headerIndex, 'start_date'),
    end: col(fields, headerIndex, 'end_date'),
  };
});

console.log('Reading calendar_dates...');
const calendarDates = {};
await forEachRow(calendarDatesPath, (fields, headerIndex) => {
  const serviceId = col(fields, headerIndex, 'service_id');
  if (!serviceId) return;
  if (!calendarDates[serviceId]) calendarDates[serviceId] = [];
  calendarDates[serviceId].push({
    date: col(fields, headerIndex, 'date'),
    type: Number(col(fields, headerIndex, 'exception_type')),
  });
});

console.log('Reading transfers...');
const transfers = [];
await forEachRow(transfersPath, (fields, headerIndex) => {
  const fromStop = col(fields, headerIndex, 'from_stop_id');
  const toStop = col(fields, headerIndex, 'to_stop_id');
  if (!fromStop || !toStop) return;
  transfers.push({
    fromStop: internStop(fromStop),
    toStop: internStop(toStop),
    fromRoute: internRoute(col(fields, headerIndex, 'from_route_id')),
    toRoute: internRoute(col(fields, headerIndex, 'to_route_id')),
    fromTrip: col(fields, headerIndex, 'from_trip_id') || null,
    toTrip: col(fields, headerIndex, 'to_trip_id') || null,
    type: Number(col(fields, headerIndex, 'transfer_type')),
  });
});
console.log(`Read ${transfers.length.toLocaleString()} transfer rows.`);

const output = { stopIds, routeIds, serviceIds, trips: tripsOut, calendar, calendarDates, transfers };

mkdirSync(dirname(outputPath), { recursive: true });
const json = JSON.stringify(output);
writeFileSync(outputPath, json);
console.log(`Wrote schedule for ${Object.keys(tripsOut).length.toLocaleString()} trips to ${outputPath} (${(json.length / 1024 / 1024).toFixed(1)} MB)`);
