import './style.css';
import 'leaflet/dist/leaflet.css';
import L from 'leaflet';
import { haversineKm } from './geo.js';
import { findWalkableStops, DEFAULT_WALK_CAP_MINUTES } from './journey.js';
import { pickNextStop, describeNextStop, STOP_SANITY_KM } from './stop-matching.js';
import trainRouteNames from './data/train-routes.json';
import tramRouteNames from './data/tram-routes.json';
import vlineRouteNames from './data/vline-routes.json';
import trainShapes from './data/train-shapes.json';
import tramShapes from './data/tram-shapes.json';
import vlineShapes from './data/vline-shapes.json';
import trainStops from './data/train-stops.json';
import tramStops from './data/tram-stops.json';
import vlineStops from './data/vline-stops.json';
import trainStopNames from './data/train-stop-names.json';
import tramStopNames from './data/tram-stop-names.json';
import vlineStopNames from './data/vline-stop-names.json';
import trainRouteStopNames from './data/train-route-stop-names.json';
import metroBusRoutes from './data/metro-bus-routes.json';
import regionalBusRoutes from './data/regional-bus-routes.json';

const TILES = {
  light: 'https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png',
  dark: 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png',
};
const ATTRIBUTION = '&copy; OpenStreetMap contributors &copy; CARTO';
const LOCAL_RADIUS_KM = 1;
const REFRESH_INTERVAL_MS = 10000;
const STATIONARY_THRESHOLD_M = 15;
const STATIONARY_AFTER_MS = 25000;
// Bigger than the vehicle icon's own circle (VEHICLE_ICON_SIZE * 0.42 ≈ 7.5px) so an
// occupied stop reads as a landing pad the vehicle icon is parked inside, not just a
// bigger dot competing with it. Also used for train/V-Line's resting (unoccupied) stop
// circles, so a station already looks like a landing pad rather than growing into one.
const STOP_OCCUPIED_RADIUS_PX = 11;
// Real GPS fixes land every 20-60s+ in normal operation (see renderMarkers comment
// below) — beyond this, the feed itself hasn't heard from the vehicle in a while, so
// its plotted position is a guess rather than a live report and the popup says so
// instead of presenting it with false confidence.
const STALE_POSITION_MS = 3 * 60 * 1000;

const MODES = {
  tram: { label: 'Trams', color: '#6b46c1', names: tramRouteNames, hasAlerts: true, shapes: tramShapes, stops: tramStops, stopNames: tramStopNames },
  train: { label: 'Trains', color: '#1d4ed8', names: trainRouteNames, hasAlerts: true, shapes: trainShapes, stops: trainStops, stopNames: trainStopNames, routeStopNames: trainRouteStopNames },
  vline: { label: 'V/Line', color: '#8F1A95', names: vlineRouteNames, hasAlerts: false, shapes: vlineShapes, stops: vlineStops, stopNames: vlineStopNames },
};

// Buses are deliberately NOT part of MODES: that object drives the mode tabs, the
// browsable route list, and refreshData()'s unconditional per-mode fetch every 10s —
// none of which should apply to buses (~950 routes, ~1,500 concurrent vehicles across
// Metro + Regional). Buses are only ever fetched for a route the user has explicitly
// searched and picked; see the "Bus support" section below.
const BUS_ROUTES = { ...metroBusRoutes, ...regionalBusRoutes };
const BUS_LABEL = 'Bus';

const map = L.map('app').setView([-37.8136, 144.9631], 13);
let tileLayer = L.tileLayer(TILES.light, { attribution: ATTRIBUTION }).addTo(map);

new ResizeObserver(() => map.invalidateSize()).observe(document.getElementById('app'));

let currentlyDark = false;
function setDarkMode(dark) {
  currentlyDark = dark;
  map.removeLayer(tileLayer);
  tileLayer = L.tileLayer(dark ? TILES.dark : TILES.light, { attribution: ATTRIBUTION }).addTo(map);
  document.body.classList.toggle('dark-mode', dark);
}
const darkQuery = window.matchMedia('(prefers-color-scheme: dark)');
setDarkMode(darkQuery.matches);
darkQuery.addEventListener('change', (e) => {
  setDarkMode(e.matches);
  renderRoutePicker();
});

const markers = new Map();
let allVehicles = [];
let coreVehicles = [];
let alertsByRoute = new Map();
let tripUpdatesByTrip = new Map();
const tripHeadsignsByMode = {};
let userLocation = null;
let userLocationMarker = null;
const selectedRoutes = new Set();
let searchQuery = '';
let activeTab = 'all';
const routeShapeLayers = new Map();
const autoShapeKeys = new Set();
// key -> L.circleMarker. The static hollow stop circles drawn in showRouteShape (for
// train/V-Line only) and the "occupied" ring here are deliberately independent: they
// come from two different per-stop datasets (MODES[mode].stops, built from one
// representative trip's stop_times, vs. MODES[mode].stopNames, resolved per-trip at
// runtime) that can legitimately disagree by tens of meters at multi-platform stations
// — trying to match one to the other by proximity intermittently lit up a circle with
// no vehicle anywhere near it. Drawing the ring fresh at the vehicle's own resolved
// dwelling coordinate (see nextStopInfo/renderMarkers) instead guarantees it's always
// exactly where the vehicle marker itself is, for every mode.
const dwellingRingLayers = new Map();

// Bus support state (see BUS_ROUTES above for why this is separate from MODES).
const busShapeLoaders = import.meta.glob('./data/bus-shapes/*.json');
const busTripInfoLoaders = {
  metro: () => import('./data/metro-bus-trip-info.json'),
  regional: () => import('./data/regional-bus-trip-info.json'),
};
const busStopNameLoaders = {
  metro: () => import('./data/metro-bus-stop-names.json'),
  regional: () => import('./data/regional-bus-stop-names.json'),
};
const busTripInfoByRegion = {};
const busStopNamesByRegion = {};
const busShapesByRoute = {};
const selectedBusRoutes = new Set();
let busVehicles = [];

// Favourites/Recents: persisted so opening the panel doesn't always start from a blank
// search — entries are either { kind: 'route', mode, routeId } (train/tram/vline) or
// { kind: 'bus', routeIds, shortName, longName, region, color } (the whole
// operator-variant group, consistent with how bus selection already groups them).
const FAVOURITES_KEY = 'ptv-map-favourites';
const RECENTS_KEY = 'ptv-map-recents';
const RECENTS_LIMIT = 8;

function loadEntries(key) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}
function saveEntries(key, entries) {
  try { localStorage.setItem(key, JSON.stringify(entries)); } catch { /* storage unavailable — favourites just won't persist */ }
}
function entryKey(entry) {
  return entry.kind === 'bus' ? `bus:${entry.shortName}:${entry.region}` : `route:${entry.mode}:${entry.routeId}`;
}

let favouriteEntries = loadEntries(FAVOURITES_KEY);
let recentEntries = loadEntries(RECENTS_KEY);

function isFavourited(entry) {
  return favouriteEntries.some((e) => entryKey(e) === entryKey(entry));
}
function toggleFavourite(entry) {
  favouriteEntries = isFavourited(entry)
    ? favouriteEntries.filter((e) => entryKey(e) !== entryKey(entry))
    : [...favouriteEntries, entry];
  saveEntries(FAVOURITES_KEY, favouriteEntries);
}
function pushRecent(entry) {
  const key = entryKey(entry);
  recentEntries = [entry, ...recentEntries.filter((e) => entryKey(e) !== key)].slice(0, RECENTS_LIMIT);
  saveEntries(RECENTS_KEY, recentEntries);
}

function ensureBusTripInfo(region) {
  if (!busTripInfoByRegion[region]) {
    busTripInfoByRegion[region] = busTripInfoLoaders[region]().then((mod) => {
      busTripInfoByRegion[region] = mod.default;
      return mod.default;
    });
  }
  return Promise.resolve(busTripInfoByRegion[region]);
}
function ensureBusStopNames(region) {
  if (!busStopNamesByRegion[region]) {
    busStopNamesByRegion[region] = busStopNameLoaders[region]().then((mod) => {
      busStopNamesByRegion[region] = mod.default;
      renderMarkers();
      return mod.default;
    });
  }
  return Promise.resolve(busStopNamesByRegion[region]);
}
function ensureBusShape(routeId) {
  if (busShapesByRoute[routeId]) return Promise.resolve(busShapesByRoute[routeId]);
  const loader = busShapeLoaders[`./data/bus-shapes/${routeId}.json`];
  if (!loader) return Promise.resolve(null);
  return loader().then((mod) => {
    busShapesByRoute[routeId] = mod.default;
    linePrepCache.delete(`bus:${routeId}`);
    return mod.default;
  });
}

function hexToRgb(hex) {
  const clean = hex.replace('#', '');
  const bigint = parseInt(clean, 16);
  return { r: (bigint >> 16) & 255, g: (bigint >> 8) & 255, b: bigint & 255 };
}
function relativeLuminance({ r, g, b }) {
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255;
}
function mixWith(hex, target, amount) {
  const { r, g, b } = hexToRgb(hex);
  const mix = (c, t) => Math.round(c + (t - c) * amount);
  const parts = [mix(r, target.r), mix(g, target.g), mix(b, target.b)];
  return `#${parts.map((v) => v.toString(16).padStart(2, '0')).join('')}`;
}
function readableTextColor(hex, dark) {
  if (!hex) return '';
  const luminance = relativeLuminance(hexToRgb(hex));
  if (dark && luminance < 0.35) return mixWith(hex, { r: 255, g: 255, b: 255 }, 0.55);
  if (!dark && luminance > 0.85) return mixWith(hex, { r: 0, g: 0, b: 0 }, 0.35);
  return hex;
}

function routeInfo(mode, routeId) {
  if (mode === 'bus') {
    const bus = BUS_ROUTES[routeId];
    return bus ? { name: bus.shortName, color: bus.color } : { name: routeId, color: null };
  }
  const table = MODES[mode]?.names || {};
  return table[routeId] || { name: routeId, color: null };
}
function baseRouteId(routeId) {
  return routeId.replace(/-R:$/, ':');
}
function hasActiveReplacement(mode, routeId) {
  return allVehicles.some((v) => v.mode === mode && v.routeId?.endsWith('-R:') && baseRouteId(v.routeId) === routeId);
}
function pickAlertText(texts) {
  if (!texts || texts.length === 0) return null;
  const busReplacement = texts.find((t) => /buses replace/i.test(t));
  if (busReplacement) return busReplacement;
  const delay = texts.find((t) => /delay/i.test(t));
  if (delay) return delay;
  return texts[0];
}
function routeStatus(mode, routeId) {
  const alertText = pickAlertText(alertsByRoute.get(`${mode}:${routeId}`));
  if (alertText) return alertText;
  if (hasActiveReplacement(mode, routeId)) return 'Bus replacement';
  return '';
}

// Route-snapped animation: rather than a straight GPS-to-GPS lerp (which visibly cuts
// corners off curved track/road), the marker walks the actual drawn route line between
// the two GPS pings' projected positions. Lines are prepared (cumulative arc-length
// built) once per route and cached, since many vehicles share the same route.
const linePrepCache = new Map();
function prepareLine(points) {
  const cumulative = [0];
  for (let i = 1; i < points.length; i++) {
    cumulative.push(cumulative[i - 1] + haversineKm(points[i - 1][0], points[i - 1][1], points[i][0], points[i][1]));
  }
  return { points, cumulative };
}
function getPreparedLines(mode, routeId) {
  const key = `${mode}:${routeId}`;
  if (!linePrepCache.has(key)) {
    const lines = mode === 'bus' ? (busShapesByRoute[routeId] || []) : (MODES[mode]?.shapes?.[routeId] || []);
    linePrepCache.set(key, lines.filter((pts) => pts.length >= 2).map(prepareLine));
  }
  return linePrepCache.get(key);
}
// Nearest point on a prepared line to (lat, lon), via a local flat-plane projection
// per segment (accurate enough at street/track scale) combined with the line's
// haversine-based cumulative arc-length for the along-line position.
function projectOntoLine(prepared, lat, lon) {
  const { points, cumulative } = prepared;
  let best = null;
  for (let i = 0; i < points.length - 1; i++) {
    const [lat1, lon1] = points[i];
    const [lat2, lon2] = points[i + 1];
    const kmPerLonDeg = 111.32 * Math.cos((lat1 * Math.PI) / 180);
    const kmPerLatDeg = 110.574;
    const dx = (lon2 - lon1) * kmPerLonDeg;
    const dy = (lat2 - lat1) * kmPerLatDeg;
    const px = (lon - lon1) * kmPerLonDeg;
    const py = (lat - lat1) * kmPerLatDeg;
    const segLenSq = dx * dx + dy * dy;
    const t = segLenSq > 0 ? Math.max(0, Math.min(1, (px * dx + py * dy) / segLenSq)) : 0;
    const distanceKm = Math.hypot(px - t * dx, py - t * dy);
    const arcLengthKm = cumulative[i] + t * Math.sqrt(segLenSq);
    if (!best || distanceKm < best.distanceKm) best = { distanceKm, arcLengthKm };
  }
  return best;
}
const SNAP_MAX_DISTANCE_KM = 0.15;
function snapToRoute(mode, routeId, lat, lon) {
  const lines = getPreparedLines(mode, routeId);
  let best = null;
  let bestLine = null;
  lines.forEach((line) => {
    const proj = projectOntoLine(line, lat, lon);
    if (proj && (!best || proj.distanceKm < best.distanceKm)) {
      best = proj;
      bestLine = line;
    }
  });
  if (!best || best.distanceKm > SNAP_MAX_DISTANCE_KM) return null;
  return { line: bestLine, arcLengthKm: best.arcLengthKm };
}
// Builds an animation path that follows the shape line between two arc-length
// positions, inserting any shape vertices in between so the marker traces the curve.
function buildSnappedPath(line, fromArcKm, toArcKm, fromPoint, toPoint) {
  const { points, cumulative } = line;
  const via = [];
  for (let i = 0; i < points.length; i++) {
    if (cumulative[i] > fromArcKm && cumulative[i] < toArcKm) via.push(points[i]);
  }
  return [fromPoint, ...via, toPoint];
}
const SNAP_BACKWARD_TOLERANCE_KM = 0.05;
function routeSnappedPath(mode, routeId, prevLat, prevLon, nextLat, nextLon) {
  const snappedNext = snapToRoute(mode, routeId, nextLat, nextLon);
  if (!snappedNext) return null;
  const projPrev = projectOntoLine(snappedNext.line, prevLat, prevLon);
  if (!projPrev || projPrev.distanceKm > SNAP_MAX_DISTANCE_KM) return null;
  if (snappedNext.arcLengthKm < projPrev.arcLengthKm - SNAP_BACKWARD_TOLERANCE_KM) return null;
  return buildSnappedPath(snappedNext.line, projPrev.arcLengthKm, snappedNext.arcLengthKm, [prevLat, prevLon], [nextLat, nextLon]);
}

const COMPASS_POINTS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
function bearingToCompass(bearing) {
  const normalized = ((bearing % 360) + 360) % 360;
  return COMPASS_POINTS[Math.round(normalized / 22.5) % 16];
}
function computeBearing(lat1, lon1, lat2, lon2) {
  const toRad = (d) => (d * Math.PI) / 180;
  const toDeg = (r) => (r * 180) / Math.PI;
  const y = Math.sin(toRad(lon2 - lon1)) * Math.cos(toRad(lat2));
  const x = Math.cos(toRad(lat1)) * Math.sin(toRad(lat2)) -
    Math.sin(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.cos(toRad(lon2 - lon1));
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}


const OCCUPANCY_LABELS = {
  0: 'Empty', 1: 'Many seats available', 2: 'Few seats available',
  3: 'Standing room only', 4: 'Very crowded', 5: 'Full', 6: 'Not accepting passengers',
};
function occupancyLabel(status) {
  return status === null || status === undefined ? null : OCCUPANCY_LABELS[status] ?? null;
}

function resolveStop(mode, stopId, region) {
  if (!stopId) return null;
  const table = mode === 'bus' ? busStopNamesByRegion[region] : MODES[mode]?.stopNames;
  const entry = table?.[stopId];
  if (!entry) return null;
  const [name, lat, lon] = entry;
  return { name, lat, lon };
}

function formatEtaMinutes(unixSeconds) {
  const diffMs = unixSeconds * 1000 - Date.now();
  const mins = Math.round(diffMs / 60000);
  if (mins > 0) return `${mins} min`;
  // mins === 0 is the predicted instant itself; negative means the predicted time has
  // already passed per schedule but GPS hasn't confirmed departure yet — "now" would
  // overstate confidence there, "soon" doesn't.
  return mins === 0 ? 'now' : 'soon';
}

function formatDistance(km) {
  return km < 1 ? `${Math.round(km * 1000)} m` : `${km.toFixed(1)} km`;
}

function formatAge(ms) {
  const mins = Math.floor(ms / 60000);
  return mins < 1 ? `${Math.round(ms / 1000)}s` : `${mins}m`;
}

// Trip-updates' predicted arrival/departure times lag reality far more than the
// vehicle's live GPS does (testing showed most "arrival already passed" entries were
// still several km out, still en route) — so live distance to the claimed stop, not
// the predicted time, decides "At" vs "Next stop" and whether to trust the entry at
// all. Bounds are generous single-hop distances per mode (tram stops are close
// together; V/Line stops can be tens of km apart), tighter for "At" since that implies
// the vehicle is physically there right now.
// "at" must mean "physically there right now" — it drives not just the popup's "At: X"
// text but also whether the marker visually snaps onto the stop and its landing-pad
// ring lights up. 0.6km (the original bound, sized for the "next" distance calc, not
// this) was loose enough that a train still hundreds of metres out could be labelled
// "At: Station" with nothing to visually back that up. Tightened to roughly platform
// length plus GPS slop per mode; "next" (a different, coarser sanity check for
// picking a plausible upcoming stop at all) is unchanged. Values live in
// stop-matching.js (imported above) so the unit tests covering this scoring logic
// exercise the exact same numbers this file renders with.

// trip-updates and vehicle-positions are two independently-polled feeds, joined only
// by tripId — trip-updates can lag behind and still list a stop the vehicle's live GPS
// shows it has already passed (observed: a train's raw position at one station while
// trip-updates still named an earlier one as current/next). Rather than always
// trusting the feed's first remaining stop, score every stop kept for this trip (see
// stopsPerTrip in api/trip-updates.js) by live distance and take the closest one within
// sanity range — this self-corrects as soon as the true current/next stop is anywhere
// in that short lookahead list, instead of surfacing a stale station name. The scoring
// itself (pickNextStop/describeNextStop) lives in stop-matching.js, testable without
// this file's DOM/Leaflet/fetch state; this function is just the resolveStop glue.
function nextStopInfo(mode, tripId, vLat, vLon, region) {
  if (!tripId || vLat == null || vLon == null) return null;
  const update = tripUpdatesByTrip.get(`${mode}:${tripId}`);
  const sanity = STOP_SANITY_KM[mode];

  const resolved = (update?.stops ?? []).map((stopUpdate) => ({
    stopUpdate,
    stop: resolveStop(mode, stopUpdate.stopId, region),
  }));
  const best = pickNextStop(resolved, vLat, vLon, sanity);
  return describeNextStop(best, sanity);
}

// Speed a schedule-predicted hop would imply, above which we distrust the trip-updates
// prediction for *positioning* purposes (label/ETA text can tolerate more slack than a
// moving icon can) and fall back to plain GPS-to-GPS animation instead.
const PREDICTIVE_SPEED_CEILING_KMH = { tram: 70, train: 120, vline: 160, bus: 100 };
const MIN_PREDICTIVE_DURATION_MS = 3000;

// Dead-reckons a vehicle's position between its last confirmed GPS fix and its
// predicted arrival at the next stop (from trip-updates), rather than only animating
// retroactively between two already-received GPS pings. Real fixes land every 20-60s+
// in practice (see renderMarkers) — without this, a vehicle just sits frozen at its
// last fix for that whole gap, which is exactly the "60 seconds / two stops behind"
// drift observed on a walking commute. Each new GPS fix (rawChanged in renderMarkers)
// or each updated prediction corrects the trajectory on the next render; a bad or
// missing prediction falls back to the existing GPS-to-GPS eased hop untouched.
function predictiveAnchors(mode, marker, stopInfo) {
  if (!stopInfo || stopInfo.label !== 'Next stop' || stopInfo.lat == null) return null;
  const endSec = stopInfo.arrival ?? stopInfo.departure;
  const anchorA = marker._lastRawLatLng;
  const startMs = marker._lastRawTimestamp;
  if (endSec == null || !anchorA || startMs == null) return null;

  const endMs = endSec * 1000;
  const durationMs = endMs - startMs;
  if (durationMs < MIN_PREDICTIVE_DURATION_MS) return null;

  const distanceKm = haversineKm(anchorA.lat, anchorA.lng, stopInfo.lat, stopInfo.lon);
  const impliedKmh = distanceKm / (durationMs / 3600000);
  if (impliedKmh > (PREDICTIVE_SPEED_CEILING_KMH[mode] ?? 100)) return null;

  return { startMs, endMs, fromLat: anchorA.lat, fromLon: anchorA.lng, toLat: stopInfo.lat, toLon: stopInfo.lon };
}

function headsignFor(mode, tripId) {
  if (!tripId) return null;
  return tripHeadsignsByMode[mode]?.[tripId] ?? null;
}

const DISCOVERY_MODES = ['train', 'tram', 'vline'];

// The stop tables findWalkableStops (src/journey.js) needs — passed in rather than
// having that module import MODES directly, so it stays decoupled from main.js's app
// state (see journey.js's own header comment).
function journeyStopTables() {
  return DISCOVERY_MODES.map((mode) => ({ mode, stopNames: MODES[mode].stopNames }));
}

// Flat, de-duplicated-by-name list of every train/tram/V-Line stop, for the "search a
// destination" box in the journey panel — built once, since the underlying stop data
// never changes at runtime.
let journeyStopIndexCache = null;
function journeyStopIndex() {
  if (journeyStopIndexCache) return journeyStopIndexCache;
  const byName = new Map();
  journeyStopTables().forEach(({ stopNames }) => {
    Object.values(stopNames).forEach(([name, lat, lon]) => {
      if (!byName.has(name)) byName.set(name, { name, lat, lon });
    });
  });
  journeyStopIndexCache = [...byName.values()];
  return journeyStopIndexCache;
}

// Journey planning Phase 3: live-first journey matching. Answers "what's actually
// running right now that gets me from A toward B" using only data already being
// fetched — no static schedule exists in this app (see PRINCIPLES.md's roadmap), so
// this is deliberately real-time-only: it can't see a service that hasn't started
// reporting live position yet, and one-transfer discovery is bounded by however many
// stops ahead trip-updates currently keeps per trip (api/trip-updates.js's
// stopsPerTrip, 4 for non-bus). Both limits are surfaced in the UI, not hidden.

// A realistic minimum to physically make a transfer (walk across a platform, etc.) —
// not a real per-station number (no data exists for that), just a sanity floor so a
// 10-second "connection" isn't suggested as if it were walkable.
const MIN_TRANSFER_SEC = 120;
const MAX_JOURNEY_OPTIONS = 5;

// stopId -> [{ mode, tripId, routeId, stopIndex, stops, arrival, departure }] — every
// (currently live) trip's stops, indexed by stop, built once per search rather than
// rescanning all trips for every candidate stop.
function buildLiveStopIndex() {
  const index = new Map();
  tripUpdatesByTrip.forEach((update, key) => {
    const sep = key.indexOf(':');
    const mode = key.slice(0, sep);
    if (mode === 'bus') return; // excluded — see Phase 0 scoping notes
    const tripId = key.slice(sep + 1);
    (update.stops ?? []).forEach((s, stopIndex) => {
      if (!s.stopId) return;
      if (!index.has(s.stopId)) index.set(s.stopId, []);
      index.get(s.stopId).push({ mode, tripId, routeId: update.routeId, stopIndex, stops: update.stops, arrival: s.arrival, departure: s.departure });
    });
  });
  return index;
}

// Flattens a findWalkableStops() result into stopId -> { name, minutes } — the walk
// time to whichever named stop that stop_id belongs to.
function collectCandidateStopIds(walkResult) {
  const map = new Map();
  walkResult.stops.forEach((stop) => {
    stop.stopIds.forEach((stopId) => {
      const existing = map.get(stopId);
      if (!existing || stop.minutes < existing.minutes) map.set(stopId, { name: stop.name, minutes: stop.minutes });
    });
  });
  return map;
}

// Keeps only the fastest option per distinct journey (same boarding trip, and same
// transfer trip if any) — the search below can otherwise find the same physical
// journey more than once (e.g. a trip matches two nearby candidate platforms).
function addJourneyOption(best, option) {
  const signature = option.transfer
    ? `${option.mode}:${option.tripId}>${option.transfer.mode}:${option.transfer.tripId}`
    : `${option.mode}:${option.tripId}`;
  const existing = best.get(signature);
  if (!existing || option.totalMinutes < existing.totalMinutes) best.set(signature, option);
}

// The core Phase 3 search. Not run automatically on every render (see renderJourneyPanel)
// — it's a real, if bounded, scan of every currently-live trip, deliberately triggered
// rather than recomputed on every geolocation tick.
function findLiveJourneys(origin, destination, { capMinutes = DEFAULT_WALK_CAP_MINUTES } = {}) {
  if (!origin || !destination) return { options: [], originWalk: null, destWalk: null };

  const stopTables = journeyStopTables();
  const originWalk = findWalkableStops(origin.lat, origin.lon, stopTables, { capMinutes });
  const destWalk = findWalkableStops(destination.lat, destination.lon, stopTables, { capMinutes });
  const originStopIds = collectCandidateStopIds(originWalk);
  const destStopIds = collectCandidateStopIds(destWalk);

  const stopIndex = buildLiveStopIndex();
  const nowSec = Date.now() / 1000;
  const best = new Map();

  originStopIds.forEach((originInfo, originStopId) => {
    (stopIndex.get(originStopId) ?? []).forEach(({ mode, tripId, routeId, stopIndex: boardIdx, stops }) => {
      const boardStop = stops[boardIdx];
      const boardTime = boardStop.departure ?? boardStop.arrival;
      if (boardTime == null) return;
      const minutesUntilBoard = (boardTime - nowSec) / 60;
      // Must be a future departure, and reachable on foot before it leaves.
      if (minutesUntilBoard < 0 || originInfo.minutes > minutesUntilBoard) return;

      for (let j = boardIdx + 1; j < stops.length; j++) {
        const laterStopId = stops[j].stopId;
        const arriveTime = stops[j].arrival ?? stops[j].departure;
        if (arriveTime == null) continue;

        // Zero-transfer: this same trip reaches a destination candidate later on.
        const destInfo = destStopIds.get(laterStopId);
        if (destInfo) {
          addJourneyOption(best, {
            mode, routeId, tripId,
            originStopName: originInfo.name, originWalkMinutes: originInfo.minutes, minutesUntilBoard,
            transfer: null,
            destStopName: destInfo.name, destWalkMinutes: destInfo.minutes,
            totalMinutes: (arriveTime - nowSec) / 60 + destInfo.minutes,
          });
        }

        // One-transfer: anything else departing from this same later stop, reaching a
        // destination candidate on its own remaining (up to 4) stops.
        (stopIndex.get(laterStopId) ?? []).forEach((t) => {
          if (t.tripId === tripId && t.mode === mode) return; // same trip, not a transfer
          const board2 = t.stops[t.stopIndex];
          const board2Time = board2.departure ?? board2.arrival;
          if (board2Time == null || board2Time - arriveTime < MIN_TRANSFER_SEC) return;

          for (let k = t.stopIndex + 1; k < t.stops.length; k++) {
            const alight2StopId = t.stops[k].stopId;
            const dest2Info = destStopIds.get(alight2StopId);
            if (!dest2Info) continue;
            const alight2Time = t.stops[k].arrival ?? t.stops[k].departure;
            if (alight2Time == null) continue;
            const transferStop = resolveStop(mode, laterStopId, undefined);
            addJourneyOption(best, {
              mode, routeId, tripId,
              originStopName: originInfo.name, originWalkMinutes: originInfo.minutes, minutesUntilBoard,
              transfer: {
                mode: t.mode, routeId: t.routeId, tripId: t.tripId,
                stopName: transferStop?.name ?? 'transfer stop',
                arriveMinutes: (arriveTime - nowSec) / 60,
                departMinutes: (board2Time - nowSec) / 60,
              },
              destStopName: dest2Info.name, destWalkMinutes: dest2Info.minutes,
              totalMinutes: (alight2Time - nowSec) / 60 + dest2Info.minutes,
            });
          }
        });
      }
    });
  });

  const options = [...best.values()].sort((a, b) => a.totalMinutes - b.totalMinutes).slice(0, MAX_JOURNEY_OPTIONS);
  return { options, originWalk, destWalk };
}

// Inverts tripUpdatesByTrip (keyed by trip) into a per-stop view (keyed by stop), so
// "what's the next service at stop X" can be answered regardless of which specific
// trip/vehicle it belongs to. Bus is excluded — its trip-updates only ever carry one
// stop per trip (see api/trip-updates.js), and buses aren't part of the nearest-stops
// feature (matches the app's default-hidden bus behavior).
function buildStopDepartures() {
  const index = new Map();
  tripUpdatesByTrip.forEach((update, key) => {
    const mode = key.slice(0, key.indexOf(':'));
    if (!DISCOVERY_MODES.includes(mode) || !update.stops) return;
    update.stops.forEach((s) => {
      if (!s.stopId) return;
      if (!index.has(s.stopId)) index.set(s.stopId, []);
      index.get(s.stopId).push({ mode, routeId: update.routeId, arrival: s.arrival, departure: s.departure });
    });
  });
  index.forEach((list) => list.sort((a, b) => (a.departure ?? a.arrival ?? Infinity) - (b.departure ?? b.arrival ?? Infinity)));
  return index;
}

// Scans every known train/tram/V-Line stop (~5,100 total — trivial cost) and returns
// the closest ones to userLocation that currently have at least one live upcoming
// departure, sorted by walking distance.
function computeNearestStops(limit = 8) {
  if (!userLocation) return [];
  const departures = buildStopDepartures();
  // Big stations (e.g. Flinders Street) have several stop_ids — one per platform/child
  // stop, often at near-identical coordinates — and interchange stations are listed
  // independently in more than one mode's static export (e.g. Flinders Street appears
  // in both train's and V/Line's stops.txt, same stop_ids, since V/Line departs from
  // the same platforms). Group by name alone (not mode+name) so these all collapse
  // into one entry with departures merged, rather than a same-named duplicate per
  // mode/stop_id.
  const byKey = new Map();
  DISCOVERY_MODES.forEach((mode) => {
    Object.entries(MODES[mode].stopNames).forEach(([stopId, [name, lat, lon]]) => {
      const upcoming = departures.get(stopId);
      if (!upcoming?.length) return;
      const distanceKm = haversineKm(userLocation.lat, userLocation.lon, lat, lon);
      if (!byKey.has(name)) byKey.set(name, { name, lat, lon, distanceKm, upcoming: [] });
      const entry = byKey.get(name);
      if (distanceKm < entry.distanceKm) { entry.lat = lat; entry.lon = lon; entry.distanceKm = distanceKm; }
      entry.upcoming.push(...upcoming);
    });
  });
  const candidates = [...byKey.values()];
  candidates.forEach((c) => {
    // The same physical stop_id can be pulled in once per mode whose static export
    // lists it (see comment above), contributing the same departures array more than
    // once — dedupe before capping to the soonest few.
    const seen = new Set();
    c.upcoming = c.upcoming.filter((u) => {
      const key = `${u.mode}:${u.routeId}:${u.departure ?? u.arrival}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    c.upcoming.sort((a, b) => (a.departure ?? a.arrival ?? Infinity) - (b.departure ?? b.arrival ?? Infinity));
    c.upcoming = c.upcoming.slice(0, 3);
  });
  return candidates.sort((a, b) => a.distanceKm - b.distanceKm).slice(0, limit);
}

function buildPopupContent(v, info, bearing, moving) {
  const modeLabel = v.mode === 'bus' ? BUS_LABEL : (MODES[v.mode]?.label ?? v.mode);
  const parts = [`<strong>${modeLabel} route ${info.name}</strong>`, `Vehicle: ${v.id}`];
  const status = routeStatus(v.mode, baseRouteId(v.routeId));
  if (status) parts.push(`⚠ ${status}`);
  const headsign = v.mode === 'bus' ? v.headsign : headsignFor(v.mode, v.tripId);
  if (headsign) parts.push(`To: ${headsign}`);
  if (moving) parts.push(`Heading: ${bearingToCompass(bearing)}`);
  else parts.push('Status: stationary');
  // nextStopInfo picks the nearest matching stop to the vehicle's live GPS — but if
  // that GPS fix itself is stale, "nearest to a stale position" can be confidently
  // wrong (e.g. a station the vehicle has since departed, now sitting well past it
  // with no fresher fix to prove that). Rather than assert a specific station off data
  // we already know is too old to trust, drop the claim entirely and let the staleness
  // line below speak for itself.
  const positionAgeMs = v.timestamp != null ? Date.now() - v.timestamp * 1000 : null;
  const positionStale = positionAgeMs != null && positionAgeMs > STALE_POSITION_MS;
  const next = positionStale ? null : nextStopInfo(v.mode, v.tripId, v.lat, v.lon, v.region);
  if (next) {
    if (next.eta == null) parts.push(`${next.label}: ${next.name}`);
    else if (next.etaVerb) parts.push(`${next.label}: ${next.name} (${next.etaVerb} ${next.eta})`);
    else parts.push(`${next.label}: ${next.name} (${next.eta})`);
  }
  const occupancy = occupancyLabel(v.occupancyStatus);
  if (occupancy) parts.push(`Crowding: ${occupancy}`);
  if (positionStale) parts.push(`Position may be outdated (last update ${formatAge(positionAgeMs)} ago)`);
  return parts.join('<br>');
}

// Glyphs drawn in a fixed 24x24 local box, white fill, centered on (12,12) — a
// stylised badge in a circle rather than a rotating direction pointer. Polygons carry
// a matching round stroke so corners bulge softly instead of coming to a hard point.
// Vehicle movement is conveyed by the marker's own position animating across the map
// (see predictiveAnchors/animateMarkerTo), not by anything in the icon itself — heading
// is the least trustworthy data point (see PRINCIPLES.md), so it stays out of the icon
// and lives only in the popup's "Heading: NE" text.
const MODE_GLYPHS = {
  tram: '<polygon points="12,4.5 19.5,17 12,12.5 4.5,17" fill="white" stroke="white" stroke-width="2.4" stroke-linejoin="round"/>',
  train: '<polygon points="12,4.5 19.5,17 4.5,17" fill="white" stroke="white" stroke-width="2.4" stroke-linejoin="round"/>',
  vline: '<polyline points="6,16 12,6.5 18,16" fill="none" stroke="white" stroke-width="3.4" stroke-linecap="round" stroke-linejoin="round"/>',
  bus: '<rect x="5.5" y="5.5" width="13" height="13" rx="4" fill="white"/>',
};

const VEHICLE_ICON_SIZE = 18;
// Trains/V-Line read as physically bigger vehicles than a tram or bus, so they get a
// few extra pixels rather than relying on color/glyph alone to tell them apart.
const TRAIN_ICON_SIZE = 21;
function buildVehicleIcon(mode, color) {
  const size = mode === 'train' || mode === 'vline' ? TRAIN_ICON_SIZE : VEHICLE_ICON_SIZE;
  const r = size * 0.42;
  const cx = size / 2, cy = size / 2;
  const glyphScale = ((r * 2) / 24) * 1.05;
  const glyphOffset = (size - 24 * glyphScale) / 2;
  const glyph = MODE_GLYPHS[mode] || MODE_GLYPHS.tram;
  const inner = `<svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
    <circle cx="${cx}" cy="${cy}" r="${r}" fill="${color}" stroke="rgba(0,0,0,0.35)" stroke-width="0.5"/>
    <g transform="translate(${glyphOffset}, ${glyphOffset}) scale(${glyphScale})">${glyph}</g>
  </svg>`;
  return L.divIcon({ className: 'vehicle-icon', html: inner, iconSize: [size, size], iconAnchor: [size / 2, size / 2] });
}

function buildUserLocationIcon() {
  const html = '<div style="position:relative;width:14px;height:14px;"><div class="user-location-pulse"></div><div class="user-location-dot"></div></div>';
  return L.divIcon({ className: 'user-location-icon', html, iconSize: [14, 14], iconAnchor: [7, 7] });
}

// Ease-in-out rather than constant speed, so a vehicle visibly accelerates away from
// a stop and decelerates into the next one instead of moving at a uniform pace for the
// whole 10s hop.
function easeInOutCubic(t) {
  return t < 0.5 ? 4 * t * t * t : 1 - ((-2 * t + 2) ** 3) / 2;
}

// startTimeMs/endTimeMs are wall-clock epoch millis (Date.now()-comparable), not a
// duration relative to when this function is called — this lets the predictive path
// (src/main.js predictiveAnchors) anchor the animation to a real GPS fix's own
// timestamp and a predicted arrival time, and lets the frame loop keep advancing
// correctly in real time even if it's restarted (e.g. on the next 10s poll) with the
// same anchors, since position only ever depends on Date.now() vs these two fixed
// points, never on when the loop itself started running.
function animateMarkerTo(marker, path, startTimeMs, endTimeMs) {
  const cumulative = [0];
  // One bearing per segment, so the icon can turn progressively through a curve
  // instead of snapping to a single "as the crow flies" heading for the whole hop.
  const segmentBearings = [];
  for (let i = 1; i < path.length; i++) {
    cumulative.push(cumulative[i - 1] + haversineKm(path[i - 1][0], path[i - 1][1], path[i][0], path[i][1]));
    segmentBearings.push(computeBearing(path[i - 1][0], path[i - 1][1], path[i][0], path[i][1]));
  }
  const total = cumulative[cumulative.length - 1];
  function step() {
    const span = endTimeMs - startTimeMs;
    const t = span > 0 ? Math.min(Math.max((Date.now() - startTimeMs) / span, 0), 1) : 1;
    let lat, lon;
    if (total === 0) {
      [lat, lon] = path[path.length - 1];
    } else {
      const targetKm = easeInOutCubic(t) * total;
      let i = 0;
      while (i < cumulative.length - 2 && cumulative[i + 1] < targetKm) i++;
      const segStart = cumulative[i];
      const segEnd = cumulative[i + 1];
      const segT = segEnd > segStart ? (targetKm - segStart) / (segEnd - segStart) : 0;
      const [lat1, lon1] = path[i];
      const [lat2, lon2] = path[i + 1];
      lat = lat1 + (lat2 - lat1) * segT;
      lon = lon1 + (lon2 - lon1) * segT;

      // Bearing is still tracked (used by the popup's "Heading: NE" text) even though
      // the icon itself no longer rotates to show it — see MODE_GLYPHS above.
      marker._bearing = segmentBearings[i];
    }
    marker.setLatLng([lat, lon]);
    if (t < 1) marker._animFrame = requestAnimationFrame(step);
  }
  if (marker._animFrame) cancelAnimationFrame(marker._animFrame);
  marker._animFrame = requestAnimationFrame(step);
}

function showRouteShape(mode, routeId) {
  const routeKey = `${mode}:${routeId}`;
  if (routeShapeLayers.has(routeKey)) return;
  const lines = MODES[mode]?.shapes?.[routeId] || [];
  if (lines.length === 0) return;
  const color = routeInfo(mode, routeId).color || MODES[mode]?.color || '#666';
  const pathColor = mixWith(color, { r: 0, g: 0, b: 0 }, 0.35);
  const layers = lines.map((points) => L.polyline(points, { color: pathColor, weight: 3, opacity: 0.55 }));

  // Static hollow stops-on-the-map only make sense for train/V-Line — sparse, widely
  // spaced stations worth showing at rest. Tram (and bus, which never had these) has
  // stops packed too tightly for that to read as anything but clutter. Sized the same
  // as the arriving-vehicle ring (STOP_OCCUPIED_RADIUS_PX) so a station already reads
  // as a landing pad waiting to receive a train, rather than growing into one only once
  // something arrives. These are pure decoration — a "this line has a station roughly
  // here" indicator, not a reliable proxy for any given vehicle's actual resolved stop
  // (see the note by dwellingRingLayers above); the arriving-vehicle ring is always
  // drawn separately, directly on top.
  if (mode !== 'tram') {
    const stopLines = MODES[mode]?.stops?.[routeId] || [];
    stopLines.forEach((points) => {
      points.forEach(([lat, lon]) => {
        layers.push(L.circleMarker([lat, lon], {
          radius: STOP_OCCUPIED_RADIUS_PX,
          color: pathColor,
          weight: 2,
          opacity: 0.9,
          fillColor: pathColor,
          fillOpacity: 0,
        }));
      });
    });
  }

  const group = L.layerGroup(layers).addTo(map);
  routeShapeLayers.set(routeKey, group);
}

function hideRouteShape(mode, routeId) {
  const routeKey = `${mode}:${routeId}`;
  const group = routeShapeLayers.get(routeKey);
  if (group) {
    map.removeLayer(group);
    routeShapeLayers.delete(routeKey);
  }
}

// Creates a ring (white fill, colored border) at a dwelling vehicle's own resolved
// stop coordinate — same trusted "At" determination that already snaps the vehicle
// marker there (see nextStopInfo/renderMarkers) — so the vehicle icon (rendered in
// Leaflet's marker pane, above the vector-shape pane this ring lives in) appears
// parked inside it. Removed the moment nothing is dwelling there. dwellingStops is
// collected fresh each renderMarkers() pass, so a vehicle departing clears its ring on
// the very next render. Applies to all four modes uniformly — see the note by
// dwellingRingLayers above for why this doesn't try to reuse train/V-Line's static
// stop circles instead.
function updateDwellingRings(dwellingStops) {
  const seen = new Set();
  dwellingStops.forEach(({ key, lat, lon, color }) => {
    seen.add(key);
    if (!dwellingRingLayers.has(key)) {
      const ring = L.circleMarker([lat, lon], {
        radius: STOP_OCCUPIED_RADIUS_PX,
        color,
        weight: 2.5,
        fillColor: '#fff',
        fillOpacity: 1,
      }).addTo(map);
      dwellingRingLayers.set(key, ring);
    }
  });
  dwellingRingLayers.forEach((ring, key) => {
    if (!seen.has(key)) {
      map.removeLayer(ring);
      dwellingRingLayers.delete(key);
    }
  });
}

function syncNearbyRouteShapes(nearbyRouteKeys) {
  autoShapeKeys.forEach((key) => {
    if (!nearbyRouteKeys.has(key)) {
      const [mode, routeId] = key.split(/:(.+)/);
      hideRouteShape(mode, routeId);
      autoShapeKeys.delete(key);
    }
  });
  nearbyRouteKeys.forEach((key) => {
    if (!autoShapeKeys.has(key)) {
      const [mode, routeId] = key.split(/:(.+)/);
      showRouteShape(mode, routeId);
      autoShapeKeys.add(key);
    }
  });
}

function clearAutoRouteShapes() {
  autoShapeKeys.forEach((key) => {
    const [mode, routeId] = key.split(/:(.+)/);
    hideRouteShape(mode, routeId);
  });
  autoShapeKeys.clear();
}

// Bus shapes are lazy-loaded per route (see ensureBusShape) rather than looked up in
// an eagerly-bundled MODES[mode].shapes table, since there's no small combined file at
// bus's scale (~950 routes). Reuses the same `routeShapeLayers` map as the other
// modes (keyed `bus:${routeId}`), so hideRouteShape('bus', routeId) works unchanged.
function showBusRouteShape(routeId) {
  const routeKey = `bus:${routeId}`;
  if (routeShapeLayers.has(routeKey)) return;
  ensureBusShape(routeId).then((lines) => {
    if (!lines || lines.length === 0) return;
    if (!selectedBusRoutes.has(routeId) || routeShapeLayers.has(routeKey)) return;
    const color = routeInfo('bus', routeId).color || '#FF8200';
    const pathColor = mixWith(color, { r: 0, g: 0, b: 0 }, 0.35);
    const layers = lines.map((points) => L.polyline(points, { color: pathColor, weight: 3, opacity: 0.55 }));
    routeShapeLayers.set(routeKey, L.layerGroup(layers).addTo(map));
  });
}

async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) return [];
  return res.json();
}

async function refreshData() {
  const modeKeys = Object.keys(MODES);

  const [vehicleResults, alertResults, tripUpdateResults] = await Promise.all([
    Promise.all(modeKeys.map((mode) => fetchJson(`/api/vehicles?mode=${mode}`).then((data) => data.map((v) => ({ ...v, mode }))))),
    Promise.all(modeKeys.map((mode) => (MODES[mode].hasAlerts ? fetchJson(`/api/alerts?mode=${mode}`) : Promise.resolve([])))),
    Promise.all(modeKeys.map((mode) => fetchJson(`/api/trip-updates?mode=${mode}`))),
  ]);

  coreVehicles = vehicleResults.flat();

  const newAlerts = new Map();
  modeKeys.forEach((mode, i) => {
    alertResults[i].forEach((a) => {
      a.routeIds.forEach((id) => {
        const key = `${mode}:${id}`;
        if (!newAlerts.has(key)) newAlerts.set(key, []);
        newAlerts.get(key).push(a.text);
      });
    });
  });
  alertsByRoute = newAlerts;

  const newTripUpdates = new Map();
  modeKeys.forEach((mode, i) => {
    Object.entries(tripUpdateResults[i]).forEach(([tripId, update]) => {
      newTripUpdates.set(`${mode}:${tripId}`, update);
    });
  });
  // refreshBusData() maintains its own `bus:`-prefixed entries on the same shared map
  // independently (runs concurrently with this function) — carry them forward here so
  // whichever of the two finishes last doesn't wipe out the other's contribution.
  tripUpdatesByTrip.forEach((update, key) => {
    if (key.startsWith('bus:')) newTripUpdates.set(key, update);
  });
  tripUpdatesByTrip = newTripUpdates;
}

function composeVehicles() {
  allVehicles = coreVehicles.concat(busVehicles);
}

// Buses are only ever fetched for routes explicitly selected via search (see
// buildBusRouteRow) — never eagerly, unlike the three core modes above.
async function refreshBusData() {
  const metroRouteIds = [...selectedBusRoutes].filter((id) => BUS_ROUTES[id]?.region === 'metro');
  if (metroRouteIds.length === 0) {
    busVehicles = [];
    return;
  }
  ensureBusStopNames('metro');

  const shortNames = [...new Set(metroRouteIds.map((id) => BUS_ROUTES[id].shortName))];
  const [tripInfo, vehicleResults, tripUpdatesRaw] = await Promise.all([
    ensureBusTripInfo('metro'),
    Promise.all(shortNames.map((sn) => fetchJson(`/api/vehicles?mode=bus&routeShortName=${encodeURIComponent(sn)}`))),
    fetchJson('/api/trip-updates?mode=bus'),
  ]);

  [...tripUpdatesByTrip.keys()].forEach((key) => {
    if (key.startsWith('bus:')) tripUpdatesByTrip.delete(key);
  });
  Object.entries(tripUpdatesRaw).forEach(([tripId, update]) => tripUpdatesByTrip.set(`bus:${tripId}`, update));

  // The live feed's routeId is just the bare short-name (ambiguous — e.g. Metro and
  // Regional both have a "600") and only ever returns Metro vehicles anyway (verified:
  // Regional buses have no live tracking), but tripId->routeId resolution via
  // tripInfo is what actually confirms and attributes each vehicle correctly.
  const seenIds = new Set();
  const resolved = [];
  vehicleResults.flat().forEach((v) => {
    if (seenIds.has(v.id)) return;
    const info = tripInfo[v.tripId];
    if (!info) return;
    const [routeId, headsign] = info;
    if (!selectedBusRoutes.has(routeId)) return;
    seenIds.add(v.id);
    resolved.push({ ...v, mode: 'bus', routeId, headsign, region: 'metro' });
  });
  busVehicles = resolved;
}

async function refreshBusDataNow() {
  await refreshBusData();
  composeVehicles();
  renderMarkers();
  renderRoutePicker();
}

function renderMarkers() {
  const seen = new Set();
  const hasSelection = selectedRoutes.size > 0;
  const nearbyRouteKeys = new Set();
  const dwellingRingStops = [];

  allVehicles.forEach((v) => {
    if (v.lat == null || v.lon == null) return;
    const key = `${v.mode}-${v.id}`;
    seen.add(key);

    const routeKey = `${v.mode}:${baseRouteId(v.routeId)}`;
    // Bus vehicles only ever end up in allVehicles when their route was explicitly
    // searched and selected (see refreshBusData) — always visible, no radius/selection
    // gating like the other three modes.
    const withinRadius = !userLocation || haversineKm(userLocation.lat, userLocation.lon, v.lat, v.lon) <= LOCAL_RADIUS_KM;
    const visible = v.mode === 'bus' ? true : (hasSelection ? selectedRoutes.has(routeKey) : withinRadius);
    if (v.mode !== 'bus' && !hasSelection && withinRadius) nearbyRouteKeys.add(routeKey);

    const info = routeInfo(v.mode, v.routeId);
    const color = info.color || MODES[v.mode]?.color || '#666';
    let marker = markers.get(key);

    if (!marker) {
      const initialBearing = v.bearing || 0;
      marker = L.marker([v.lat, v.lon], { icon: buildVehicleIcon(v.mode, color) });
      marker._color = color;
      marker._lastRealLatLng = L.latLng(v.lat, v.lon);
      marker._lastRawLatLng = L.latLng(v.lat, v.lon);
      marker._lastRawUpdateAt = Date.now();
      marker._lastRawTimestamp = v.timestamp != null ? v.timestamp * 1000 : Date.now();
      marker._bearing = initialBearing;
      marker._lastMovedAt = Date.now();
      marker.bindPopup(buildPopupContent(v, info, initialBearing, false));
      markers.set(key, marker);
    } else {
      const prev = marker._lastRealLatLng;
      const rawNext = L.latLng(v.lat, v.lon);
      const movedMeters = prev.distanceTo(rawNext);
      if (movedMeters > STATIONARY_THRESHOLD_M) {
        marker._bearing = computeBearing(prev.lat, prev.lng, rawNext.lat, rawNext.lng);
        marker._lastMovedAt = Date.now();
      }

      // renderMarkers() also gets called from the geolocation watchPosition callback
      // (to re-evaluate "near me" visibility as the user walks), which fires far more
      // often than the 10s vehicle-data refresh and reuses the exact same v.lat/v.lon.
      // rawChanged tells the fallback GPS-to-GPS path apart from a no-op re-render;
      // the predictive path stays live across these extra calls regardless, since it's
      // schedule-anchored rather than triggered by a change in v.lat/v.lon.
      const rawChanged = !marker._lastRawLatLng || marker._lastRawLatLng.lat !== v.lat || marker._lastRawLatLng.lng !== v.lon;
      const previousRawUpdateAt = marker._lastRawUpdateAt;
      if (rawChanged) {
        marker._lastRawUpdateAt = Date.now();
        marker._lastRawLatLng = rawNext;
        marker._lastRawTimestamp = v.timestamp != null ? v.timestamp * 1000 : Date.now();
      }

      const stopInfo = nextStopInfo(v.mode, v.tripId, v.lat, v.lon, v.region);
      // "At" (see STOP_SANITY_KM) now means "physically there right now" for both the
      // popup text and the visual snap/ring — previously these used two different
      // distances, so the text could confidently say "At: Station X" while the marker
      // itself sat well outside that station's landing pad, un-ringed.
      const dwelling = stopInfo?.label === 'At' && stopInfo.lat != null;
      // nextStopInfo re-resolves "closest matching stop" fresh every render — with two
      // stops close together, that pick can flip to a different-but-nearby stop between
      // real GPS fixes, even though the marker only ever re-snaps on rawChanged (see
      // below). Pinning the dwelling target to marker._dwellingStop, only updated when
      // rawChanged (or on first bootstrap), keeps the ring locked to wherever the marker
      // actually is instead of chasing every re-resolution.
      if (dwelling) {
        if (rawChanged || !marker._dwellingStop) marker._dwellingStop = { lat: stopInfo.lat, lon: stopInfo.lon };
      } else {
        marker._dwellingStop = null;
      }
      // A route's shape (and any train/V-Line stops on it) is shown whenever *any*
      // vehicle on that route is nearby/selected — but that doesn't mean *this*
      // vehicle is one of the ones currently visible as its own marker. Gating on
      // `visible` here keeps a ring from lighting up far from where you're looking
      // because some other, off-screen vehicle on the same route is dwelling elsewhere.
      if (marker._dwellingStop && visible) {
        const ringKey = `${v.mode}:${marker._dwellingStop.lat.toFixed(5)}:${marker._dwellingStop.lon.toFixed(5)}`;
        const ringColor = mixWith(color, { r: 0, g: 0, b: 0 }, 0.35);
        dwellingRingStops.push({ key: ringKey, lat: marker._dwellingStop.lat, lon: marker._dwellingStop.lon, color: ringColor });
      }
      const predictive = dwelling ? null : predictiveAnchors(v.mode, marker, stopInfo);
      const moving = predictive ? true : dwelling ? false : (Date.now() - marker._lastMovedAt < STATIONARY_AFTER_MS);

      if (color !== marker._color) {
        marker.setIcon(buildVehicleIcon(v.mode, color));
        marker._color = color;
      }
      marker.setPopupContent(buildPopupContent(v, info, marker._bearing, moving));

      if (predictive) {
        // Dead-reckon toward the predicted next stop instead of freezing at the last
        // GPS fix — see predictiveAnchors(). Only (re)build the snapped path and
        // restart the frame loop when the anchors actually moved, since renderMarkers()
        // fires far more often (geolocation ticks) than the anchors themselves change.
        const changed = marker._predStartMs !== predictive.startMs
          || Math.abs((marker._predEndMs ?? 0) - predictive.endMs) > 2000
          || marker._predToLat !== predictive.toLat
          || marker._predToLon !== predictive.toLon;
        if (changed) {
          const snapped = routeSnappedPath(v.mode, baseRouteId(v.routeId), predictive.fromLat, predictive.fromLon, predictive.toLat, predictive.toLon);
          const path = snapped || [[predictive.fromLat, predictive.fromLon], [predictive.toLat, predictive.toLon]];
          animateMarkerTo(marker, path, predictive.startMs, predictive.endMs);
          marker._predStartMs = predictive.startMs;
          marker._predEndMs = predictive.endMs;
          marker._predToLat = predictive.toLat;
          marker._predToLon = predictive.toLon;
        }
        marker._lastRealLatLng = L.latLng(predictive.toLat, predictive.toLon);
      } else if (rawChanged) {
        // Real vehicles update at very different, often much sparser cadences than our
        // 10s poll — measured live: every single real position change observed over a
        // 2.5-minute window had a gap of at least 20s since that vehicle's previous
        // change, some past 60s. Using a single global "since last refresh" duration
        // for every vehicle meant one that had been stale for 50s still had its next
        // (much larger) jump squeezed into ~10s, making it visibly dash past several
        // stops before decelerating hard — exactly the "stopped for ages, then speeds
        // past 2 stops" pattern reported. Duration is now based on how long it's
        // actually been since *this* vehicle's own last real position change, capped
        // at 90s so a very long gap doesn't turn into an oddly slow-motion glide.
        const startMs = Date.now();

        // While confirmed dwelling at a stop, animate to the stop's precise
        // coordinates instead of the raw GPS ping, which otherwise jitters slightly
        // around the platform rather than looking cleanly parked. This is also what
        // lights up the stop's landing-pad ring (see updateDwellingRings), and that
        // ring lights up immediately off live GPS proximity — so the snap here uses a
        // short fixed duration rather than the variable "time since last update" one
        // below, otherwise a vehicle that had gone quiet for a while would visibly lag
        // behind its own ring for up to 90s.
        const next = dwelling ? L.latLng(marker._dwellingStop.lat, marker._dwellingStop.lon) : rawNext;
        const vehicleAnimationDuration = dwelling
          ? 3000
          : previousRawUpdateAt
            ? Math.min(Math.max(startMs - previousRawUpdateAt, 2000), 90000)
            : REFRESH_INTERVAL_MS;

        const snappedPath = routeSnappedPath(v.mode, baseRouteId(v.routeId), prev.lat, prev.lng, next.lat, next.lng);
        animateMarkerTo(marker, snappedPath || [[prev.lat, prev.lng], [next.lat, next.lng]], startMs, startMs + vehicleAnimationDuration);
        marker._lastRealLatLng = next;
      }
    }

    if (visible && !map.hasLayer(marker)) marker.addTo(map);
    if (!visible && map.hasLayer(marker)) map.removeLayer(marker);
  });

  for (const [key, marker] of markers.entries()) {
    if (!seen.has(key)) {
      if (marker._animFrame) cancelAnimationFrame(marker._animFrame);
      map.removeLayer(marker);
      markers.delete(key);
    }
  }

  if (hasSelection) clearAutoRouteShapes();
  else syncNearbyRouteShapes(nearbyRouteKeys);

  updateDwellingRings(dwellingRingStops);
}

const toggleButton = document.getElementById('route-picker-toggle');
const toggleLabel = document.getElementById('route-picker-toggle-label');
const panel = document.getElementById('route-picker-panel');
const searchInput = document.getElementById('route-search');
const searchWrap = document.getElementById('route-search-wrap');
const searchClearButton = document.getElementById('route-search-clear');
const closeButton = document.getElementById('route-picker-close');
const modeTabsEl = document.getElementById('mode-tabs');
const routeListEl = document.getElementById('route-list');
const panelHeading = document.getElementById('route-picker-heading');
const panelTrack = document.getElementById('panel-track');
const panelViewport = document.getElementById('panel-viewport');
const discoveryPaneEl = document.getElementById('discovery-pane');
const panelTabEls = [...document.querySelectorAll('.panel-tab')];
const PANE_LABELS = { discovery: 'Nearby', routes: 'Routes' };

const journeyToggleButton = document.getElementById('journey-toggle');
const journeyPanelEl = document.getElementById('journey-panel');
const journeyCloseButton = document.getElementById('journey-close');
const journeyOriginRowEl = document.getElementById('journey-origin-row');
const journeyTimeModeEl = document.getElementById('journey-time-mode');
const journeyTimeInputEl = document.getElementById('journey-time-input');
const journeySearchInput = document.getElementById('journey-search');
const journeySearchWrap = document.getElementById('journey-search-wrap');
const journeySearchClearButton = document.getElementById('journey-search-clear');
const journeyResultsEl = document.getElementById('journey-results');

let activePane = 'discovery';
let discoveryRadiusCircle = null;

function switchPane(pane) {
  activePane = pane;
  panelTrack.style.transform = pane === 'discovery' ? 'translateX(0%)' : 'translateX(-50%)';
  panelTabEls.forEach((tab) => tab.classList.toggle('active', tab.dataset.pane === pane));
  panelHeading.textContent = PANE_LABELS[pane];

  if (pane === 'discovery') {
    updateDiscoveryPane();
    if (userLocation) {
      if (discoveryRadiusCircle) map.removeLayer(discoveryRadiusCircle);
      discoveryRadiusCircle = L.circle([userLocation.lat, userLocation.lon], {
        radius: 1000, color: '#2563eb', weight: 1.5, dashArray: '4 6', fillOpacity: 0.03,
      }).addTo(map);
    }
  } else if (discoveryRadiusCircle) {
    map.removeLayer(discoveryRadiusCircle);
    discoveryRadiusCircle = null;
  }
}

panelTabEls.forEach((tab) => tab.addEventListener('click', () => switchPane(tab.dataset.pane)));

// Swipe is an enhancement on top of tab-click switching, not a replacement — tracks a
// horizontal drag and snaps to whichever pane is nearer once released.
(function wireSwipe() {
  let startX = null;
  let dragging = false;
  let viewportWidth = 0;

  panelViewport.addEventListener('touchstart', (e) => {
    startX = e.touches[0].clientX;
    viewportWidth = panelViewport.getBoundingClientRect().width;
    dragging = true;
    panelTrack.classList.add('dragging');
  }, { passive: true });

  panelViewport.addEventListener('touchmove', (e) => {
    if (!dragging || startX == null) return;
    const deltaX = e.touches[0].clientX - startX;
    const basePercent = activePane === 'discovery' ? 0 : -50;
    const dragPercent = (deltaX / viewportWidth) * 50;
    const clamped = Math.max(-50, Math.min(0, basePercent + dragPercent));
    panelTrack.style.transform = `translateX(${clamped}%)`;
  }, { passive: true });

  panelViewport.addEventListener('touchend', (e) => {
    if (!dragging || startX == null) return;
    dragging = false;
    panelTrack.classList.remove('dragging');
    const deltaX = (e.changedTouches[0]?.clientX ?? startX) - startX;
    startX = null;
    const threshold = viewportWidth * 0.2;
    if (activePane === 'discovery' && deltaX < -threshold) switchPane('routes');
    else if (activePane === 'routes' && deltaX > threshold) switchPane('discovery');
    else switchPane(activePane);
  });
})();

function updateToggleLabel() {
  const total = selectedRoutes.size + selectedBusRoutes.size;
  toggleLabel.textContent = total === 0
    ? 'All vehicles (near me)'
    : `${total} route${total > 1 ? 's' : ''} selected`;
}

function buildRouteRow(container, mode, routeId, info) {
  const routeKey = `${mode}:${routeId}`;
  const selected = selectedRoutes.has(routeKey);
  const rawColor = info.color || MODES[mode]?.color || '';

  const row = document.createElement('div');
  row.className = 'rp-row' + (selected ? ' selected' : '');
  row.dataset.routeKey = routeKey;
  row.setAttribute('role', 'checkbox');
  row.setAttribute('aria-checked', String(selected));
  row.tabIndex = 0;

  const swatch = document.createElement('span');
  swatch.className = 'rp-swatch';
  swatch.style.backgroundColor = rawColor || '#999';

  const textWrap = document.createElement('div');
  textWrap.className = 'rp-text';
  const nameEl = document.createElement('div');
  nameEl.className = 'rp-name';
  nameEl.textContent = info.name;
  if (selected) nameEl.style.color = readableTextColor(rawColor, currentlyDark);
  const statusEl = document.createElement('div');
  statusEl.className = 'rp-status';
  textWrap.appendChild(nameEl);
  textWrap.appendChild(statusEl);

  const favEntry = { kind: 'route', mode, routeId };
  const starEl = document.createElement('span');
  starEl.className = 'rp-star' + (isFavourited(favEntry) ? ' favourited' : '');
  starEl.textContent = isFavourited(favEntry) ? '★' : '☆';
  starEl.setAttribute('role', 'button');
  starEl.setAttribute('aria-label', 'Toggle favourite');
  starEl.tabIndex = 0;
  starEl.addEventListener('click', (e) => {
    e.stopPropagation();
    toggleFavourite(favEntry);
    renderRoutePicker();
  });
  starEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); toggleFavourite(favEntry); renderRoutePicker(); }
  });

  const checkEl = document.createElement('span');
  checkEl.className = 'rp-check';
  checkEl.textContent = '✓';
  checkEl.setAttribute('aria-hidden', 'true');
  if (selected) checkEl.style.color = readableTextColor(rawColor, currentlyDark);

  row.appendChild(swatch);
  row.appendChild(textWrap);
  row.appendChild(starEl);
  row.appendChild(checkEl);

  function toggle() {
    const isSelected = selectedRoutes.has(routeKey);
    if (isSelected) {
      selectedRoutes.delete(routeKey);
      hideRouteShape(mode, routeId);
    } else {
      selectedRoutes.add(routeKey);
      autoShapeKeys.delete(routeKey);
      showRouteShape(mode, routeId);
      pushRecent(favEntry);
    }
    updateToggleLabel();
    renderMarkers();
    renderRoutePicker();
  }

  row.addEventListener('click', toggle);
  row.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); }
  });

  container.appendChild(row);
}

// A single rider-facing bus route (e.g. "903 — Mordialloc - Altona") is frequently
// split across several GTFS route_id rows in PTV's data — different operator
// franchises covering different sections/times, sharing the same short name and
// destination. `group` bundles their routeIds together so selecting the route once
// pulls in vehicles from all of them, rather than just whichever operator's row
// happened to get clicked.
function buildBusRouteRow(container, group) {
  const { shortName, longName, region, color, routeIds } = group;
  const selected = routeIds.every((id) => selectedBusRoutes.has(id));
  const rawColor = color || '';

  const row = document.createElement('div');
  row.className = 'rp-row' + (selected ? ' selected' : '');
  row.dataset.busRouteIds = routeIds.join(',');
  row.setAttribute('role', 'checkbox');
  row.setAttribute('aria-checked', String(selected));
  row.tabIndex = 0;

  const swatch = document.createElement('span');
  swatch.className = 'rp-swatch';
  swatch.style.backgroundColor = rawColor || '#999';

  const textWrap = document.createElement('div');
  textWrap.className = 'rp-text';
  const nameEl = document.createElement('div');
  nameEl.className = 'rp-name';
  const regionSuffix = region === 'regional' ? ' (Regional)' : '';
  nameEl.textContent = `${shortName} — ${longName}${regionSuffix}`;
  if (selected) nameEl.style.color = readableTextColor(rawColor, currentlyDark);
  const statusEl = document.createElement('div');
  statusEl.className = 'rp-status';
  if (region === 'regional') {
    statusEl.textContent = 'No live tracking available for this service';
    statusEl.classList.add('has-disruption');
  }
  textWrap.appendChild(nameEl);
  textWrap.appendChild(statusEl);

  const favEntry = { kind: 'bus', routeIds, shortName, longName, region, color };
  const starEl = document.createElement('span');
  starEl.className = 'rp-star' + (isFavourited(favEntry) ? ' favourited' : '');
  starEl.textContent = isFavourited(favEntry) ? '★' : '☆';
  starEl.setAttribute('role', 'button');
  starEl.setAttribute('aria-label', 'Toggle favourite');
  starEl.tabIndex = 0;
  starEl.addEventListener('click', (e) => {
    e.stopPropagation();
    toggleFavourite(favEntry);
    renderRoutePicker();
  });
  starEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); toggleFavourite(favEntry); renderRoutePicker(); }
  });

  const checkEl = document.createElement('span');
  checkEl.className = 'rp-check';
  checkEl.textContent = '✓';
  checkEl.setAttribute('aria-hidden', 'true');
  if (selected) checkEl.style.color = readableTextColor(rawColor, currentlyDark);

  row.appendChild(swatch);
  row.appendChild(textWrap);
  row.appendChild(starEl);
  row.appendChild(checkEl);

  function toggle() {
    const isSelected = routeIds.every((id) => selectedBusRoutes.has(id));
    if (isSelected) {
      routeIds.forEach((id) => { selectedBusRoutes.delete(id); hideRouteShape('bus', id); });
    } else {
      routeIds.forEach((id) => { selectedBusRoutes.add(id); showBusRouteShape(id); });
      pushRecent(favEntry);
    }
    updateToggleLabel();
    refreshBusDataNow();
  }

  row.addEventListener('click', toggle);
  row.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); }
  });

  container.appendChild(row);
}

function renderRouteSection(container, mode, routeNames) {
  container.innerHTML = '';
  const query = searchQuery.trim().toLowerCase();

  const entries = Object.entries(routeNames).filter(([routeId, info]) => {
    if (routeId.endsWith('-R:')) return false;
    if (!query) return true;
    if (info.name.toLowerCase().includes(query)) return true;
    const stopNames = MODES[mode]?.routeStopNames?.[routeId];
    return Boolean(stopNames?.some((name) => name.toLowerCase().includes(query)));
  });

  const colorGroups = new Map();
  entries.forEach(([routeId, info]) => {
    const groupKey = info.group || info.color || '#999999';
    if (!colorGroups.has(groupKey)) colorGroups.set(groupKey, []);
    colorGroups.get(groupKey).push([routeId, info]);
  });

  [...colorGroups.values()]
    .sort((a, b) => a[0][1].name.localeCompare(b[0][1].name, undefined, { numeric: true }))
    .forEach((group) => {
      group.sort((a, b) => a[1].name.localeCompare(b[1].name, undefined, { numeric: true }));
      const groupEl = document.createElement('div');
      groupEl.className = group.length > 1 ? 'rp-group-shared' : '';

      if (group.length > 1) {
        groupEl.style.borderLeftColor = group[0][1].color || '#999';
        const groupKeys = group.map(([routeId]) => `${mode}:${routeId}`);

        const selectAllBtn = document.createElement('div');
        selectAllBtn.className = 'rp-select-all';
        selectAllBtn.tabIndex = 0;
        selectAllBtn.setAttribute('role', 'button');

        function updateSelectAllLabel() {
          const allSelected = groupKeys.every((k) => selectedRoutes.has(k));
          selectAllBtn.textContent = allSelected ? 'Deselect all' : 'Select all';
        }
        updateSelectAllLabel();

        function selectAllToggle() {
          const allSelected = groupKeys.every((k) => selectedRoutes.has(k));
          groupKeys.forEach((key) => {
            const isSelected = selectedRoutes.has(key);
            const needsClick = allSelected ? isSelected : !isSelected;
            if (needsClick) {
              const row = groupEl.querySelector(`[data-route-key="${CSS.escape(key)}"]`);
              if (row) row.click();
            }
          });
          updateSelectAllLabel();
        }
        selectAllBtn.addEventListener('click', selectAllToggle);
        selectAllBtn.addEventListener('keydown', (e) => {
          if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); selectAllToggle(); }
        });

        groupEl.appendChild(selectAllBtn);
      }

      group.forEach(([routeId, info]) => buildRouteRow(groupEl, mode, routeId, info));
      container.appendChild(groupEl);
    });
}

function buildModeTabs() {
  modeTabsEl.innerHTML = '';
  const allTab = document.createElement('div');
  allTab.className = 'mode-tab active';
  allTab.dataset.tab = 'all';
  allTab.textContent = 'All';
  modeTabsEl.appendChild(allTab);

  Object.entries(MODES).forEach(([mode, config]) => {
    const tab = document.createElement('div');
    tab.className = 'mode-tab';
    tab.dataset.tab = mode;
    tab.textContent = config.label;
    modeTabsEl.appendChild(tab);
  });

  modeTabsEl.querySelectorAll('.mode-tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      modeTabsEl.querySelectorAll('.mode-tab').forEach((t) => t.classList.remove('active'));
      tab.classList.add('active');
      activeTab = tab.dataset.tab;
      renderRoutePicker();
    });
  });
}

function buildRouteListSkeleton() {
  routeListEl.innerHTML = '';

  // Pinned to the top, above the per-mode/bus sections, so an already-selected route
  // (especially a searched-then-selected bus, which otherwise has no other visible
  // trace once the search box is cleared) is always one glance away to deselect.
  const selectedGroup = document.createElement('div');
  selectedGroup.className = 'route-picker-group';
  selectedGroup.dataset.group = 'selected';
  selectedGroup.style.display = 'none';
  const selectedHeading = document.createElement('strong');
  selectedHeading.textContent = 'Selected';
  const selectedRows = document.createElement('div');
  selectedRows.id = 'selected-rows';
  selectedGroup.appendChild(selectedHeading);
  selectedGroup.appendChild(selectedRows);
  routeListEl.appendChild(selectedGroup);

  // Favourites (with Recent as a subheading underneath) leads the Routes pane on an
  // empty search, so reopening the panel to reselect a regular route doesn't require
  // re-searching or re-scrolling.
  const favGroup = document.createElement('div');
  favGroup.className = 'route-picker-group';
  favGroup.dataset.group = 'favourites';
  favGroup.style.display = 'none';
  const favHeading = document.createElement('strong');
  favHeading.textContent = 'Favourites';
  const favRows = document.createElement('div');
  favRows.id = 'favourites-rows';
  const recentHeading = document.createElement('strong');
  recentHeading.id = 'recent-subheading';
  recentHeading.className = 'rp-subheading';
  recentHeading.textContent = 'Recent';
  const recentRows = document.createElement('div');
  recentRows.id = 'recent-rows';
  favGroup.appendChild(favHeading);
  favGroup.appendChild(favRows);
  favGroup.appendChild(recentHeading);
  favGroup.appendChild(recentRows);
  routeListEl.appendChild(favGroup);

  Object.entries(MODES).forEach(([mode, config]) => {
    const group = document.createElement('div');
    group.className = 'route-picker-group';
    group.dataset.group = mode;
    const heading = document.createElement('strong');
    heading.textContent = config.label;
    const rows = document.createElement('div');
    rows.id = `${mode}-rows`;
    group.appendChild(heading);
    group.appendChild(rows);
    routeListEl.appendChild(group);
  });

  // Buses are deliberately not part of the mode-tab loop above (see BUS_ROUTES) — this
  // group only ever becomes visible when the search box has a matching route number.
  const busGroup = document.createElement('div');
  busGroup.className = 'route-picker-group';
  busGroup.dataset.group = 'bus';
  busGroup.style.display = 'none';
  const busHeading = document.createElement('strong');
  busHeading.textContent = 'Buses';
  const busRows = document.createElement('div');
  busRows.id = 'bus-rows';
  busGroup.appendChild(busHeading);
  busGroup.appendChild(busRows);
  routeListEl.appendChild(busGroup);
}

// Groups a list of [routeId, info] bus entries by rider-facing identity (short name +
// destination + region) — see buildBusRouteRow for why several GTFS route_ids can
// represent what's really "one" route. Shared by search results and the Selected list.
function groupBusEntries(entries) {
  const grouped = new Map();
  entries.forEach(([routeId, info]) => {
    const key = `${info.shortName} ${info.longName} ${info.region}`;
    if (!grouped.has(key)) {
      grouped.set(key, { shortName: info.shortName, longName: info.longName, region: info.region, color: info.color, routeIds: [] });
    }
    grouped.get(key).routeIds.push(routeId);
  });
  return [...grouped.values()].sort((a, b) => a.shortName.localeCompare(b.shortName, undefined, { numeric: true }) || a.region.localeCompare(b.region));
}

function getSelectedBusGroups() {
  const entries = [...selectedBusRoutes].map((routeId) => [routeId, BUS_ROUTES[routeId]]).filter(([, info]) => info);
  return groupBusEntries(entries);
}

function renderBusSection() {
  const group = routeListEl.querySelector('.route-picker-group[data-group="bus"]');
  const rows = document.getElementById('bus-rows');
  rows.innerHTML = '';
  const query = searchQuery.trim().toLowerCase();
  if (!query) { group.style.display = 'none'; return; }

  const matches = Object.entries(BUS_ROUTES).filter(([, info]) => {
    if (!info.shortName) return false;
    return info.shortName.toLowerCase().startsWith(query) || info.longName?.toLowerCase().includes(query);
  });
  const groups = groupBusEntries(matches).slice(0, 20);

  if (groups.length === 0) { group.style.display = 'none'; return; }
  group.style.display = '';
  groups.forEach((g) => buildBusRouteRow(rows, g));
}

function renderSelectedSection() {
  const group = routeListEl.querySelector('.route-picker-group[data-group="selected"]');
  const rows = document.getElementById('selected-rows');
  rows.innerHTML = '';

  if (selectedRoutes.size === 0 && selectedBusRoutes.size === 0) { group.style.display = 'none'; return; }
  group.style.display = '';

  selectedRoutes.forEach((routeKey) => {
    const [mode, routeId] = routeKey.split(/:(.+)/);
    buildRouteRow(rows, mode, routeId, routeInfo(mode, routeId));
  });
  getSelectedBusGroups().forEach((g) => buildBusRouteRow(rows, g));
}

function renderEntryRow(container, entry) {
  if (entry.kind === 'bus') {
    buildBusRouteRow(container, {
      shortName: entry.shortName, longName: entry.longName, region: entry.region, color: entry.color, routeIds: entry.routeIds,
    });
  } else {
    buildRouteRow(container, entry.mode, entry.routeId, routeInfo(entry.mode, entry.routeId));
  }
}

function renderFavouritesSection() {
  const group = routeListEl.querySelector('.route-picker-group[data-group="favourites"]');
  const favRows = document.getElementById('favourites-rows');
  const recentHeading = document.getElementById('recent-subheading');
  const recentRows = document.getElementById('recent-rows');
  favRows.innerHTML = '';
  recentRows.innerHTML = '';

  const filteredRecent = recentEntries.filter((e) => !isFavourited(e));
  if (searchQuery.trim() || (favouriteEntries.length === 0 && filteredRecent.length === 0)) {
    group.style.display = 'none';
    return;
  }
  group.style.display = '';

  favouriteEntries.forEach((entry) => renderEntryRow(favRows, entry));
  recentHeading.style.display = filteredRecent.length > 0 ? '' : 'none';
  filteredRecent.forEach((entry) => renderEntryRow(recentRows, entry));
}

function renderRoutePicker() {
  renderSelectedSection();
  renderFavouritesSection();
  Object.keys(MODES).forEach((mode) => {
    const group = routeListEl.querySelector(`.route-picker-group[data-group="${mode}"]`);
    group.style.display = activeTab === 'all' || activeTab === mode ? '' : 'none';
    renderRouteSection(document.getElementById(`${mode}-rows`), mode, MODES[mode].names);
  });
  renderBusSection();
  updateRouteStatuses();
}

function updateDiscoveryPane() {
  if (!panel.classList.contains('open') || activePane !== 'discovery') return;
  discoveryPaneEl.innerHTML = '';

  if (!userLocation) {
    const msg = document.createElement('div');
    msg.className = 'discovery-empty';
    msg.textContent = 'Enable location to see the nearest stops and next departures.';
    discoveryPaneEl.appendChild(msg);
    return;
  }

  const stops = computeNearestStops(8);
  if (stops.length === 0) {
    const msg = document.createElement('div');
    msg.className = 'discovery-empty';
    msg.textContent = 'No live departures found nearby right now.';
    discoveryPaneEl.appendChild(msg);
    return;
  }

  stops.forEach((stop) => {
    const row = document.createElement('div');
    row.className = 'discovery-stop';

    const top = document.createElement('div');
    top.className = 'discovery-stop-top';
    const nameEl = document.createElement('span');
    nameEl.className = 'discovery-stop-name';
    nameEl.textContent = stop.name;
    const distEl = document.createElement('span');
    distEl.className = 'discovery-stop-distance';
    distEl.textContent = formatDistance(stop.distanceKm);
    top.appendChild(nameEl);
    top.appendChild(distEl);
    row.appendChild(top);

    const chips = document.createElement('div');
    chips.className = 'discovery-departures';
    stop.upcoming.forEach((u) => {
      const chip = document.createElement('span');
      chip.className = 'discovery-chip';
      const info = routeInfo(u.mode, u.routeId);
      chip.style.background = info.color || MODES[u.mode]?.color || '#666';
      const etaSeconds = u.departure ?? u.arrival;
      chip.textContent = `${info.name} · ${formatEtaMinutes(etaSeconds)}`;
      chips.appendChild(chip);
    });
    row.appendChild(chips);

    row.addEventListener('click', () => map.setView([stop.lat, stop.lon], 17));
    discoveryPaneEl.appendChild(row);
  });
}

// Journey planning Phase 2: destination-only picking (search a stop name, search a
// free-text address via Nominatim, or tap the map) — origin is always userLocation for
// now. Nothing here computes an actual journey yet (Phase 3) — this just proves the
// pipeline by showing walkable stops (src/journey.js, Phase 1) near both ends.
let journeyDestination = null; // { lat, lon, label } | null
let journeyDestMarker = null;
let journeyQuery = '';

// Journey planning: when to travel — 'now' (default), 'depart' (leave at a chosen
// time), or 'arrive' (arrive by a chosen time; api/plan-journey.js's
// planJourneyArrivingBy). Only meaningful for the Phase 5 timetable section below —
// Phase 3's live-first matching has no notion of a future/past query, it only ever
// sees what's reporting position right now, so that section is hidden outside 'now'
// rather than silently showing "live" results for a different time.
let journeyTimeMode = 'now';
let journeyTimeValue = ''; // "HH:MM" from the <input type="time">, browser-local

// Interprets journeyTimeValue as a wall-clock time on the browser's own local calendar
// day, rolling to tomorrow if that time has already passed today — the ordinary meaning
// of picking a bare time with no date ("8am" said at 9pm means tomorrow). Uses the
// browser's local timezone rather than an Australia/Melbourne-aware conversion (unlike
// the server-side melbourneDateAndSeconds): a plain <input type="time"> has no timezone
// concept of its own, and this app's whole live-map premise already assumes it's being
// used in Melbourne, so browser-local and Melbourne-local coincide for the overwhelming
// majority of real usage.
function journeyTimeValueToEpochMs(hhmm, nowMs) {
  const [h, m] = hhmm.split(':').map(Number);
  const d = new Date(nowMs);
  d.setHours(h, m, 0, 0);
  if (d.getTime() <= nowMs) d.setDate(d.getDate() + 1);
  return d.getTime();
}

// { mode: 'now' } | { mode: 'depart'|'arrive', epochMs }. Falls back to 'now' whenever
// a non-'now' mode is selected but no time has actually been picked yet.
function journeyWhenSpec() {
  if (journeyTimeMode === 'now' || !journeyTimeValue) return { mode: 'now' };
  return { mode: journeyTimeMode, epochMs: journeyTimeValueToEpochMs(journeyTimeValue, Date.now()) };
}

// Nominatim address search (api/geocode.js) — debounced well past its 1-req/sec usage
// policy, and gated behind a 3-character minimum so it never fires on a stray keypress.
// journeyGeocodeResults/Pending are keyed implicitly to journeyQuery: a response only
// gets applied if journeyQuery still matches the text it was requested for, so a
// slow/out-of-order response can't clobber what the user has since typed.
const GEOCODE_DEBOUNCE_MS = 600;
const GEOCODE_MIN_CHARS = 3;
let journeyGeocodeResults = [];
let journeyGeocodePending = false;
let journeyGeocodeTimer = null;

async function runJourneyGeocode(query) {
  journeyGeocodePending = true;
  renderJourneyPanel();
  let places = [];
  try {
    const res = await fetch(`/api/geocode?q=${encodeURIComponent(query)}`);
    places = res.ok ? await res.json() : [];
  } catch (err) {
    console.error(err);
  }
  if (journeyQuery.trim() !== query) return; // superseded by further typing — discard
  journeyGeocodeResults = Array.isArray(places) ? places : [];
  journeyGeocodePending = false;
  renderJourneyPanel();
}

// Journey planning Phase 5: the full-timetable itinerary (api/plan-journey.js), shown
// alongside Phase 3's live-only options — see that endpoint's header for why it needs a
// real algorithm (CSA over static GTFS) rather than the live-feed scan above: it has no
// blind spot for services that haven't started reporting position yet, and works for any
// query time, not just "right now".
//
// renderJourneyPanel() runs on every location tick and data refresh (frequent), but this
// fetch should only fire when the actual origin/destination pair changes — keyed the same
// way runJourneyGeocode keys off journeyQuery, so a stale in-flight response can't clobber
// a newer request's result.
let plannedJourneyKey = null;
let plannedJourneyResult = null;
let plannedJourneyPending = false;

function plannedJourneyKeyFor(origin, destination, when) {
  return `${origin.lat.toFixed(4)},${origin.lon.toFixed(4)}->${destination.lat.toFixed(4)},${destination.lon.toFixed(4)}`
    + `@${when.mode}:${when.epochMs ?? ''}`;
}

async function ensurePlannedJourney(origin, destination, when) {
  const key = plannedJourneyKeyFor(origin, destination, when);
  if (key === plannedJourneyKey) return; // already fetched (or in flight) for this pair+time
  plannedJourneyKey = key;
  plannedJourneyPending = true;
  plannedJourneyResult = null;

  let result = { ok: false, reason: 'request_failed' };
  try {
    const params = new URLSearchParams({
      originLat: origin.lat, originLon: origin.lon,
      destLat: destination.lat, destLon: destination.lon,
    });
    if (when.mode === 'depart') params.set('departure', when.epochMs);
    else if (when.mode === 'arrive') params.set('arriveBy', when.epochMs);
    const res = await fetch(`/api/plan-journey?${params}`);
    result = await res.json();
  } catch (err) {
    console.error(err);
  }
  if (plannedJourneyKey !== key) return; // superseded by a newer origin/destination/time
  plannedJourneyResult = result;
  plannedJourneyPending = false;
  renderJourneyPanel();
}

function selectJourneyDestination(point) {
  journeySearchInput.value = '';
  journeyQuery = '';
  journeySearchWrap.classList.remove('has-text');
  journeyGeocodeResults = [];
  journeyGeocodePending = false;
  clearTimeout(journeyGeocodeTimer);
  setJourneyDestination(point);
}

function buildJourneyDestIcon() {
  const html = '<svg width="26" height="34" viewBox="0 0 26 34">'
    + '<path d="M13 0C5.8 0 0 5.8 0 13c0 9.75 13 21 13 21s13-11.25 13-21C26 5.8 20.2 0 13 0z" fill="#dc2626" stroke="#fff" stroke-width="1.5"/>'
    + '<circle cx="13" cy="13" r="5" fill="#fff"/></svg>';
  return L.divIcon({ className: 'journey-dest-icon', html, iconSize: [26, 34], iconAnchor: [13, 34] });
}

function setJourneyDestination(point) {
  journeyDestination = point;
  if (point) {
    if (journeyDestMarker) journeyDestMarker.setLatLng([point.lat, point.lon]);
    else journeyDestMarker = L.marker([point.lat, point.lon], { icon: buildJourneyDestIcon() }).addTo(map);
  } else if (journeyDestMarker) {
    map.removeLayer(journeyDestMarker);
    journeyDestMarker = null;
  }
  renderJourneyPanel();
}

function journeyEmptyMsg(text) {
  const el = document.createElement('div');
  el.className = 'journey-empty';
  el.textContent = text;
  return el;
}

function journeySectionLabel(text) {
  const el = document.createElement('div');
  el.className = 'journey-section-label';
  el.textContent = text;
  return el;
}

function journeyResultRow(text, onClick) {
  const row = document.createElement('div');
  row.className = 'journey-row';
  row.textContent = text;
  row.addEventListener('click', onClick);
  return row;
}

function renderJourneyWalkSection(label, walkResult) {
  journeyResultsEl.appendChild(journeySectionLabel(label));

  if (!walkResult) {
    journeyResultsEl.appendChild(journeyEmptyMsg('Enable location to see this.'));
    return;
  }
  if (!walkResult.withinCap) {
    const warn = document.createElement('div');
    warn.className = 'journey-cap-warning';
    const nearest = walkResult.stops[0];
    warn.textContent = nearest
      ? `No stop within ${DEFAULT_WALK_CAP_MINUTES} min walk — nearest is ~${Math.round(nearest.minutes)} min away.`
      : 'No known stop nearby at all.';
    journeyResultsEl.appendChild(warn);
  }
  walkResult.stops.slice(0, 6).forEach((stop) => {
    const row = document.createElement('div');
    row.className = 'journey-walk-stop';
    const nameEl = document.createElement('span');
    nameEl.textContent = stop.name;
    const minsEl = document.createElement('span');
    minsEl.className = 'journey-muted';
    minsEl.textContent = `~${Math.round(stop.minutes)} min walk`;
    row.appendChild(nameEl);
    row.appendChild(minsEl);
    journeyResultsEl.appendChild(row);
  });
}

// Deliberately blunt about what this can't see — a live-only search has real, specific
// blind spots (see findLiveJourneys), and pretending otherwise would be exactly the
// false-confidence Principle 1 exists to rule out.
const JOURNEY_CAVEAT = "Live options only — a service that hasn't started reporting "
  + "position yet won't show here, and a transfer more than a few stops further down a "
  + "route can be missed. Bus isn't included yet.";

function formatMinutesFromNow(minutes) {
  const rounded = Math.round(minutes);
  return rounded <= 0 ? 'now' : `in ${rounded} min`;
}

function renderJourneyOptionLeg(mode, routeId, tripId, text) {
  const info = routeInfo(mode, routeId);
  const leg = document.createElement('div');
  leg.className = 'journey-option-leg';
  const swatch = document.createElement('span');
  swatch.className = 'journey-option-swatch';
  swatch.style.background = info.color || MODES[mode]?.color || '#666';
  const label = document.createElement('span');
  label.textContent = text;
  leg.appendChild(swatch);
  leg.appendChild(label);
  return leg;
}

function renderJourneyOption(option) {
  const card = document.createElement('div');
  card.className = 'journey-option';

  const info = routeInfo(option.mode, option.routeId);
  const modeLabel = MODES[option.mode]?.label ?? option.mode;
  const headsign = headsignFor(option.mode, option.tripId);
  card.appendChild(renderJourneyOptionLeg(
    option.mode, option.routeId, option.tripId,
    `${modeLabel} ${info.name}${headsign ? ` to ${headsign}` : ''} — board at ${option.originStopName} ${formatMinutesFromNow(option.minutesUntilBoard)}`,
  ));

  if (option.transfer) {
    const tInfo = routeInfo(option.transfer.mode, option.transfer.routeId);
    const tModeLabel = MODES[option.transfer.mode]?.label ?? option.transfer.mode;
    const tHeadsign = headsignFor(option.transfer.mode, option.transfer.tripId);
    const waitMinutes = Math.max(0, Math.round(option.transfer.departMinutes - option.transfer.arriveMinutes));
    card.appendChild(renderJourneyOptionLeg(
      option.transfer.mode, option.transfer.routeId, option.transfer.tripId,
      `Change at ${option.transfer.stopName} (${waitMinutes} min wait), then ${tModeLabel} ${tInfo.name}${tHeadsign ? ` to ${tHeadsign}` : ''}`,
    ));
  }

  const summary = document.createElement('div');
  summary.className = 'journey-option-summary';
  summary.textContent = `${Math.round(option.destWalkMinutes)} min walk to ${option.destStopName} — total ≈ ${Math.round(option.totalMinutes)} min`;
  card.appendChild(summary);

  return card;
}

// Deliberately separate wording from JOURNEY_CAVEAT above — this result carries the
// opposite honesty caveat: it's schedule-accurate but positionally blind, where the live
// section is positionally-grounded but can miss services outright (see this section's
// header comment near ensurePlannedJourney).
const PLANNED_JOURNEY_CAVEAT = "From the published timetable, not live positions — "
  + "won't reflect delays, cancellations, or replacement buses.";

const PLANNED_JOURNEY_ERROR_MESSAGES = {
  no_walkable_stops: 'No train or V/Line stop is within walking range of your start or destination.',
  no_journey_found: 'No timetabled journey found between those stops.',
  unreachable_by_target: "No timetabled journey arrives that early — try a later time.",
  missing_or_invalid_coordinates: "Couldn't look up the timetable for this trip.",
  invalid_departure: "Couldn't look up the timetable for this trip.",
  invalid_arrive_by: "Couldn't look up the timetable for this trip.",
  planning_failed: "Couldn't look up the timetable right now.",
  request_failed: "Couldn't reach the timetable lookup — try again shortly.",
};

function renderPlannedJourneyCard(result) {
  const card = document.createElement('div');
  card.className = 'journey-option';

  // Only present for an 'arrive by' query (planJourneyArrivingBy) — shown so a rider can
  // see at a glance that the actual arrival below is at/before what they asked for, not
  // just trust it silently (Principle 1: honesty over confidence).
  if (result.requestedArriveBy) {
    const requestedLine = document.createElement('div');
    requestedLine.className = 'journey-option-summary journey-muted';
    requestedLine.textContent = `Requested: arrive by ${result.requestedArriveBy}`;
    card.appendChild(requestedLine);
  }

  const originLine = document.createElement('div');
  originLine.className = 'journey-option-summary';
  originLine.textContent = `Walk ${result.origin.walkMinutes} min to ${result.origin.stopName}`;
  card.appendChild(originLine);

  result.legs.forEach((leg, i) => {
    if (i > 0 && leg.transferMinutes !== null) {
      const transferLine = document.createElement('div');
      transferLine.className = 'journey-option-summary';
      transferLine.textContent = leg.changedPlatform
        ? `Change platform, ${leg.transferMinutes} min wait`
        : `${leg.transferMinutes} min wait`;
      card.appendChild(transferLine);
    }
    const modeLabel = MODES[leg.mode]?.label ?? leg.mode;
    const info = routeInfo(leg.mode, leg.routeId);
    card.appendChild(renderJourneyOptionLeg(
      leg.mode, leg.routeId, leg.tripId,
      `${modeLabel} ${info.name} — ${leg.boardStop} ${leg.boardTime} → ${leg.alightStop} ${leg.alightTime}`,
    ));
  });

  const summary = document.createElement('div');
  summary.className = 'journey-option-summary';
  summary.textContent = `Walk ${result.destination.walkMinutes} min to ${result.destination.stopName} — `
    + `arrive by ${result.arriveBy} (≈ ${result.totalMinutes} min total)`;
  card.appendChild(summary);

  return card;
}

function renderPlannedJourneySection() {
  journeyResultsEl.appendChild(journeySectionLabel('Full itinerary (timetable)'));

  if (plannedJourneyPending || !plannedJourneyResult) {
    journeyResultsEl.appendChild(journeyEmptyMsg('Looking up the timetable…'));
    return;
  }

  const caveat = document.createElement('div');
  caveat.className = 'journey-caveat';
  caveat.textContent = PLANNED_JOURNEY_CAVEAT;
  journeyResultsEl.appendChild(caveat);

  if (!plannedJourneyResult.ok) {
    const message = PLANNED_JOURNEY_ERROR_MESSAGES[plannedJourneyResult.reason] ?? PLANNED_JOURNEY_ERROR_MESSAGES.planning_failed;
    journeyResultsEl.appendChild(journeyEmptyMsg(message));
    return;
  }

  journeyResultsEl.appendChild(renderPlannedJourneyCard(plannedJourneyResult));
}

function renderJourneyPanel() {
  if (!journeyPanelEl.classList.contains('open')) return;

  journeyOriginRowEl.innerHTML = userLocation
    ? 'From: <strong>Your location</strong>'
    : '<span class="journey-muted">From: enable location, or tap the map to set a destination</span>';

  journeyTimeModeEl.value = journeyTimeMode;
  journeyTimeInputEl.value = journeyTimeValue;
  journeyTimeInputEl.classList.toggle('hidden', journeyTimeMode === 'now');

  journeyResultsEl.innerHTML = '';

  const query = journeyQuery.trim().toLowerCase();
  if (query) {
    const stopMatches = journeyStopIndex().filter((s) => s.name.toLowerCase().includes(query)).slice(0, 8);

    if (stopMatches.length > 0) {
      journeyResultsEl.appendChild(journeySectionLabel('Stops'));
      stopMatches.forEach((stop) => {
        journeyResultsEl.appendChild(journeyResultRow(stop.name, () => selectJourneyDestination({ lat: stop.lat, lon: stop.lon, label: stop.name })));
      });
    }

    if (journeyGeocodePending || journeyGeocodeResults.length > 0) {
      journeyResultsEl.appendChild(journeySectionLabel('Addresses'));
    }
    if (journeyGeocodePending) {
      journeyResultsEl.appendChild(journeyEmptyMsg('Searching addresses…'));
    } else if (journeyGeocodeResults.length > 0) {
      journeyGeocodeResults.forEach((place) => {
        journeyResultsEl.appendChild(journeyResultRow(place.label, () => selectJourneyDestination({ lat: place.lat, lon: place.lon, label: place.label })));
      });
      const attribution = document.createElement('div');
      attribution.className = 'journey-attribution';
      attribution.textContent = 'Addresses via OpenStreetMap Nominatim';
      journeyResultsEl.appendChild(attribution);
    }

    if (stopMatches.length === 0 && !journeyGeocodePending && journeyGeocodeResults.length === 0) {
      journeyResultsEl.appendChild(journeyEmptyMsg(query.length < GEOCODE_MIN_CHARS ? 'Keep typing to search stops and addresses…' : 'No matches.'));
    }
    return;
  }

  if (!journeyDestination) {
    journeyResultsEl.appendChild(journeyEmptyMsg('Search a destination stop above, or tap the map to drop a pin.'));
    return;
  }

  const destHeader = document.createElement('div');
  destHeader.className = 'journey-dest-header';
  destHeader.innerHTML = `To: <strong>${journeyDestination.label}</strong><span class="journey-clear-dest">change</span>`;
  destHeader.querySelector('.journey-clear-dest').addEventListener('click', () => setJourneyDestination(null));
  journeyResultsEl.appendChild(destHeader);

  if (!userLocation) {
    journeyResultsEl.appendChild(journeyEmptyMsg('Enable location to find journeys.'));
    renderJourneyWalkSection('Stops near your destination', findWalkableStops(journeyDestination.lat, journeyDestination.lon, journeyStopTables(), { capMinutes: DEFAULT_WALK_CAP_MINUTES }));
    return;
  }

  const { options, originWalk, destWalk } = findLiveJourneys(userLocation, journeyDestination);
  const when = journeyWhenSpec();

  journeyResultsEl.appendChild(journeySectionLabel('Right now (live)'));

  if (when.mode === 'now') {
    const caveat = document.createElement('div');
    caveat.className = 'journey-caveat';
    caveat.textContent = JOURNEY_CAVEAT;
    journeyResultsEl.appendChild(caveat);

    if (options.length > 0) {
      options.forEach((option) => journeyResultsEl.appendChild(renderJourneyOption(option)));
    } else {
      journeyResultsEl.appendChild(journeyEmptyMsg("No live journey found right now. A service might still be coming that this can't see yet — try again shortly."));
    }
  } else {
    // Phase 3's live matching only ever sees currently-active trips — it has no way to
    // answer a future/past query, so it's hidden here rather than shown against the
    // wrong time (Principle 1: honesty over confidence).
    journeyResultsEl.appendChild(journeyEmptyMsg('Live positions only cover right now — see the timetable below for your chosen time.'));
  }

  ensurePlannedJourney(userLocation, journeyDestination, when);
  renderPlannedJourneySection();

  renderJourneyWalkSection('Stops near your start', originWalk);
  renderJourneyWalkSection('Stops near your destination', destWalk);
}

function initJourneyPanel() {
  function setJourneyPanelOpen(open) {
    journeyPanelEl.classList.toggle('open', open);
    journeyToggleButton.classList.toggle('open', open);
    journeyToggleButton.setAttribute('aria-expanded', String(open));
    if (open) renderJourneyPanel();
  }
  journeyToggleButton.addEventListener('click', () => setJourneyPanelOpen(!journeyPanelEl.classList.contains('open')));
  journeyCloseButton.addEventListener('click', () => setJourneyPanelOpen(false));

  journeyTimeModeEl.addEventListener('change', (e) => {
    journeyTimeMode = e.target.value;
    // Default the time picker to now/soon the moment it becomes relevant, rather than
    // leaving it empty (which would silently fall back to 'now' behavior per
    // journeyWhenSpec — technically correct but a confusing empty box to show the user).
    if (journeyTimeMode !== 'now' && !journeyTimeValue) {
      const d = new Date();
      journeyTimeValue = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    }
    renderJourneyPanel();
  });
  journeyTimeInputEl.addEventListener('change', (e) => {
    journeyTimeValue = e.target.value;
    renderJourneyPanel();
  });

  journeySearchInput.addEventListener('input', (e) => {
    journeyQuery = e.target.value;
    journeySearchWrap.classList.toggle('has-text', journeyQuery.length > 0);
    clearTimeout(journeyGeocodeTimer);
    const query = journeyQuery.trim();
    if (query.length < GEOCODE_MIN_CHARS) journeyGeocodeResults = [];
    renderJourneyPanel();
    if (query.length >= GEOCODE_MIN_CHARS) {
      journeyGeocodeTimer = setTimeout(() => runJourneyGeocode(query), GEOCODE_DEBOUNCE_MS);
    }
  });
  journeySearchClearButton.addEventListener('click', () => {
    journeySearchInput.value = '';
    journeyQuery = '';
    journeySearchWrap.classList.remove('has-text');
    journeyGeocodeResults = [];
    journeyGeocodePending = false;
    clearTimeout(journeyGeocodeTimer);
    renderJourneyPanel();
    journeySearchInput.focus();
  });

  // Only picks a destination while the panel is actually open, so this never
  // interferes with normal map interaction (vehicle popups, panning) otherwise.
  map.on('click', (e) => {
    if (!journeyPanelEl.classList.contains('open')) return;
    setJourneyDestination({
      lat: e.latlng.lat,
      lon: e.latlng.lng,
      label: `Dropped pin (${e.latlng.lat.toFixed(4)}, ${e.latlng.lng.toFixed(4)})`,
    });
  });
}

function updateRouteStatuses() {
  document.querySelectorAll('.rp-row[data-route-key]').forEach((row) => {
    const [mode, routeId] = row.dataset.routeKey.split(/:(.+)/);
    const statusEl = row.querySelector('.rp-status');
    const status = routeStatus(mode, routeId);
    statusEl.textContent = status;
    statusEl.classList.toggle('has-disruption', Boolean(status));
  });
}

function initRoutePicker() {
  buildModeTabs();
  buildRouteListSkeleton();
  renderRoutePicker();

  function setPanelOpen(open) {
    panel.classList.toggle('open', open);
    toggleButton.classList.toggle('open', open);
    toggleButton.setAttribute('aria-expanded', String(open));
    if (open && activePane === 'discovery') switchPane('discovery');
  }
  toggleButton.addEventListener('click', () => setPanelOpen(!panel.classList.contains('open')));
  closeButton.addEventListener('click', () => setPanelOpen(false));

  searchInput.addEventListener('input', (e) => {
    searchQuery = e.target.value;
    searchWrap.classList.toggle('has-text', searchQuery.length > 0);
    renderRoutePicker();
  });

  searchClearButton.addEventListener('click', () => {
    searchInput.value = '';
    searchQuery = '';
    searchWrap.classList.remove('has-text');
    renderRoutePicker();
    searchInput.focus();
  });
}

function boundsAroundPoint(lat, lon, radiusKm) {
  const latDelta = radiusKm / 111;
  const lonDelta = radiusKm / (111 * Math.cos((lat * Math.PI) / 180));
  return L.latLngBounds([lat - latDelta, lon - lonDelta], [lat + latDelta, lon + lonDelta]);
}

let hasCenteredOnUser = false;
let lastVisibilityUserLocation = null;
const VISIBILITY_REFRESH_KM = 0.02; // ~20m — small GPS jitter shouldn't re-trigger a full render

// Vehicles shouldn't appear until the view they're plotted on is actually settled and
// the first live fetch has landed — otherwise markers pop in on the default Melbourne
// view and then jump when centerOnUser() re-fits to the user's real location a moment
// later. Both flags latch true once and stay there; the overlay only ever hides once.
let mapSettled = false;
let dataSettled = false;
function checkInitialLoadDone() {
  if (mapSettled && dataSettled) document.getElementById('map-loading')?.classList.add('hidden');
}

function centerOnUser() {
  if (!navigator.geolocation) {
    mapSettled = true;
    checkInitialLoadDone();
    return;
  }
  // watchPosition (not a one-shot getCurrentPosition) so "nearest stops" stays accurate
  // while actually walking around. Only the very first fix recenters/zooms the map —
  // later updates just move the dot, so the view doesn't jump around as GPS refines.
  navigator.geolocation.watchPosition(
    (position) => {
      userLocation = { lat: position.coords.latitude, lon: position.coords.longitude };
      if (!hasCenteredOnUser) {
        hasCenteredOnUser = true;
        map.fitBounds(boundsAroundPoint(userLocation.lat, userLocation.lon, LOCAL_RADIUS_KM));
        mapSettled = true;
        checkInitialLoadDone();
      }
      if (userLocationMarker) {
        userLocationMarker.setLatLng([userLocation.lat, userLocation.lon]);
      } else {
        userLocationMarker = L.marker([userLocation.lat, userLocation.lon], {
          icon: buildUserLocationIcon(),
          zIndexOffset: 1000,
        }).addTo(map);
      }
      // renderMarkers()/updateDiscoveryPane() re-evaluate "near me" visibility and are
      // comparatively expensive (rebuild every marker's icon/popup) — only worth doing
      // once the user has actually moved a meaningful distance, not on every GPS tick.
      const movedKm = lastVisibilityUserLocation
        ? haversineKm(lastVisibilityUserLocation.lat, lastVisibilityUserLocation.lon, userLocation.lat, userLocation.lon)
        : Infinity;
      if (movedKm > VISIBILITY_REFRESH_KM) {
        lastVisibilityUserLocation = userLocation;
        renderMarkers();
        updateDiscoveryPane();
        renderJourneyPanel();
      }
    },
    () => {
      mapSettled = true;
      checkInitialLoadDone();
    },
    { timeout: 5000, enableHighAccuracy: true }
  );
}

async function scheduleRefresh() {
  try {
    await Promise.all([refreshData(), refreshBusData()]);
    composeVehicles();
    renderMarkers();
    updateRouteStatuses();
    updateDiscoveryPane();
    renderJourneyPanel();
  } catch (err) {
    console.error(err);
  } finally {
    dataSettled = true;
    checkInitialLoadDone();
    setTimeout(scheduleRefresh, REFRESH_INTERVAL_MS);
  }
}

const HEADSIGN_LOADERS = {
  train: () => import('./data/train-trip-headsigns.json'),
  tram: () => import('./data/tram-trip-headsigns.json'),
  vline: () => import('./data/vline-trip-headsigns.json'),
};
function loadTripHeadsigns() {
  Object.entries(HEADSIGN_LOADERS).forEach(([mode, load]) => {
    load().then((mod) => {
      tripHeadsignsByMode[mode] = mod.default;
      renderMarkers();
    });
  });
}

initRoutePicker();
initJourneyPanel();
updateToggleLabel();
centerOnUser();
scheduleRefresh();
loadTripHeadsigns();