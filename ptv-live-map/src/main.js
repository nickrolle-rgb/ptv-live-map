import './style.css';
import 'leaflet/dist/leaflet.css';
import L from 'leaflet';
import trainRouteNames from './data/train-routes.json';
import tramRouteNames from './data/tram-routes.json';
import vlineRouteNames from './data/vline-routes.json';
import trainShapes from './data/train-shapes.json';
import tramShapes from './data/tram-shapes.json';
import vlineShapes from './data/vline-shapes.json';
import trainStops from './data/train-stops.json';
import tramStops from './data/tram-stops.json';
import vlineStops from './data/vline-stops.json';

const TILES = {
  light: 'https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png',
  dark: 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png',
};
const ATTRIBUTION = '&copy; OpenStreetMap contributors &copy; CARTO';
const LOCAL_RADIUS_KM = 1;
const REFRESH_INTERVAL_MS = 10000;
const STATIONARY_THRESHOLD_M = 15;
const STATIONARY_AFTER_MS = 25000;
const TICK_LENGTH_M = 18;

const MODES = {
  tram: { label: 'Trams', color: '#6b46c1', names: tramRouteNames, hasAlerts: true, shapes: tramShapes, stops: tramStops },
  train: { label: 'Trains', color: '#1d4ed8', names: trainRouteNames, hasAlerts: true, shapes: trainShapes, stops: trainStops },
  vline: { label: 'V/Line', color: '#8F1A95', names: vlineRouteNames, hasAlerts: false, shapes: vlineShapes, stops: vlineStops },
};

const map = L.map('app').setView([-37.8136, 144.9631], 13);
let tileLayer = L.tileLayer(TILES.light, { attribution: ATTRIBUTION }).addTo(map);

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
let alertsByRoute = new Map();
let userLocation = null;
let userLocationMarker = null;
const selectedRoutes = new Set();
let searchQuery = '';
let activeTab = 'all';
const routeShapeLayers = new Map();
const autoShapeKeys = new Set();

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

function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
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

function offsetPoint(lat, lon, bearingDeg, distanceMeters) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const toDeg = (r) => (r * 180) / Math.PI;
  const bearingRad = toRad(bearingDeg);
  const latRad = toRad(lat);
  const lonRad = toRad(lon);
  const angularDist = distanceMeters / R;
  const newLatRad = Math.asin(
    Math.sin(latRad) * Math.cos(angularDist) + Math.cos(latRad) * Math.sin(angularDist) * Math.cos(bearingRad)
  );
  const newLonRad = lonRad + Math.atan2(
    Math.sin(bearingRad) * Math.sin(angularDist) * Math.cos(latRad),
    Math.cos(angularDist) - Math.sin(latRad) * Math.sin(newLatRad)
  );
  return [toDeg(newLatRad), toDeg(newLonRad)];
}

function buildStopTicks(points) {
  const ticks = [];
  points.forEach(([lat, lon], i) => {
    let bearing;
    if (points.length === 1) bearing = 0;
    else if (i === 0) bearing = computeBearing(lat, lon, points[1][0], points[1][1]);
    else if (i === points.length - 1) bearing = computeBearing(points[i - 1][0], points[i - 1][1], lat, lon);
    else bearing = computeBearing(points[i - 1][0], points[i - 1][1], points[i + 1][0], points[i + 1][1]);
    const perpBearing = (bearing + 90) % 360;
    const p1 = offsetPoint(lat, lon, perpBearing, TICK_LENGTH_M / 2);
    const p2 = offsetPoint(lat, lon, (perpBearing + 180) % 360, TICK_LENGTH_M / 2);
    ticks.push([p1, p2]);
  });
  return ticks;
}

const OCCUPANCY_LABELS = {
  0: 'Empty', 1: 'Many seats available', 2: 'Few seats available',
  3: 'Standing room only', 4: 'Very crowded', 5: 'Full', 6: 'Not accepting passengers',
};
function occupancyLabel(status) {
  return status === null || status === undefined ? null : OCCUPANCY_LABELS[status] ?? null;
}
function buildPopupContent(v, info, bearing, moving) {
  const parts = [`<strong>${MODES[v.mode]?.label ?? v.mode} route ${info.name}</strong>`, `Vehicle: ${v.id}`];
  if (moving) parts.push(`Heading: ${bearingToCompass(bearing)}`);
  else parts.push('Status: stationary');
  const occupancy = occupancyLabel(v.occupancyStatus);
  if (occupancy) parts.push(`Crowding: ${occupancy}`);
  return parts.join('<br>');
}

const MODE_SHAPES = {
  tram: { type: 'polygon', points: '8,2 14,12 8,7 2,12' },
  train: { type: 'polygon', points: '8,2 14,12 2,12' },
  vline: { type: 'chevron', points: '3,10 8,3 13,10' },
};

function buildVehicleIcon(mode, color, bearing, moving) {
  const size = 16;
  const shape = MODE_SHAPES[mode] || MODE_SHAPES.tram;
  const bar = moving ? '' : `<rect x="4" y="12.5" width="8" height="2.5" rx="1" fill="${color}"/>`;
  const shapeSvg = shape.type === 'chevron'
    ? `<polyline points="${shape.points}" fill="none" stroke="${color}" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>`
    : `<polygon points="${shape.points}" fill="${color}" stroke="${color}" stroke-width="1"/>`;
  const inner = `<svg width="${size}" height="${size}" viewBox="0 0 16 16" style="transform: rotate(${bearing}deg); transform-origin: 50% 50%;">${bar}${shapeSvg}</svg>`;
  return L.divIcon({ className: 'vehicle-icon', html: inner, iconSize: [size, size], iconAnchor: [size / 2, size / 2] });
}

function buildUserLocationIcon() {
  const html = '<div style="position:relative;width:14px;height:14px;"><div class="user-location-pulse"></div><div class="user-location-dot"></div></div>';
  return L.divIcon({ className: 'user-location-icon', html, iconSize: [14, 14], iconAnchor: [7, 7] });
}

function animateMarkerTo(marker, fromLatLng, toLatLng, duration) {
  const startTime = performance.now();
  function step(now) {
    const t = Math.min((now - startTime) / duration, 1);
    const lat = fromLatLng.lat + (toLatLng.lat - fromLatLng.lat) * t;
    const lon = fromLatLng.lng + (toLatLng.lng - fromLatLng.lng) * t;
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

  const stopLines = MODES[mode]?.stops?.[routeId] || [];
  stopLines.forEach((points) => {
    buildStopTicks(points).forEach(([p1, p2]) => {
      layers.push(L.polyline([p1, p2], { color: pathColor, weight: 2, opacity: 0.85 }));
    });
  });

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

async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) return [];
  return res.json();
}

async function refreshData() {
  const modeKeys = Object.keys(MODES);

  const vehicleResults = await Promise.all(
    modeKeys.map((mode) => fetchJson(`/api/vehicles?mode=${mode}`).then((data) => data.map((v) => ({ ...v, mode }))))
  );
  allVehicles = vehicleResults.flat();

  const alertResults = await Promise.all(
    modeKeys.map((mode) => (MODES[mode].hasAlerts ? fetchJson(`/api/alerts?mode=${mode}`) : Promise.resolve([])))
  );
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

  renderMarkers();
  updateRouteStatuses();
}

function renderMarkers() {
  const seen = new Set();
  const hasSelection = selectedRoutes.size > 0;
  const nearbyRouteKeys = new Set();

  allVehicles.forEach((v) => {
    if (v.lat == null || v.lon == null) return;
    const key = `${v.mode}-${v.id}`;
    seen.add(key);

    const routeKey = `${v.mode}:${baseRouteId(v.routeId)}`;
    const withinRadius = !userLocation || haversineKm(userLocation.lat, userLocation.lon, v.lat, v.lon) <= LOCAL_RADIUS_KM;
    const visible = hasSelection ? selectedRoutes.has(routeKey) : withinRadius;
    if (!hasSelection && withinRadius) nearbyRouteKeys.add(routeKey);

    const info = routeInfo(v.mode, v.routeId);
    const color = info.color || MODES[v.mode]?.color || '#666';
    let marker = markers.get(key);

    if (!marker) {
      const initialBearing = v.bearing || 0;
      marker = L.marker([v.lat, v.lon], { icon: buildVehicleIcon(v.mode, color, initialBearing, false) });
      marker._lastRealLatLng = L.latLng(v.lat, v.lon);
      marker._bearing = initialBearing;
      marker._lastMovedAt = Date.now();
      marker.bindPopup(buildPopupContent(v, info, initialBearing, false));
      markers.set(key, marker);
    } else {
      const prev = marker._lastRealLatLng;
      const next = L.latLng(v.lat, v.lon);
      const movedMeters = prev.distanceTo(next);
      if (movedMeters > STATIONARY_THRESHOLD_M) {
        marker._bearing = computeBearing(prev.lat, prev.lng, next.lat, next.lng);
        marker._lastMovedAt = Date.now();
      }
      const moving = Date.now() - marker._lastMovedAt < STATIONARY_AFTER_MS;

      marker.setIcon(buildVehicleIcon(v.mode, color, marker._bearing, moving));
      marker.setPopupContent(buildPopupContent(v, info, marker._bearing, moving));
      animateMarkerTo(marker, prev, next, REFRESH_INTERVAL_MS);
      marker._lastRealLatLng = next;
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
}

const toggleButton = document.getElementById('route-picker-toggle');
const toggleLabel = document.getElementById('route-picker-toggle-label');
const panel = document.getElementById('route-picker-panel');
const searchInput = document.getElementById('route-search');
const closeButton = document.getElementById('route-picker-close');
const modeTabsEl = document.getElementById('mode-tabs');
const routeListEl = document.getElementById('route-list');

function updateToggleLabel() {
  toggleLabel.textContent = selectedRoutes.size === 0
    ? 'All vehicles (near me)'
    : `${selectedRoutes.size} route${selectedRoutes.size > 1 ? 's' : ''} selected`;
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

  const checkEl = document.createElement('span');
  checkEl.className = 'rp-check';
  checkEl.textContent = '✓';
  checkEl.setAttribute('aria-hidden', 'true');
  if (selected) checkEl.style.color = readableTextColor(rawColor, currentlyDark);

  row.appendChild(swatch);
  row.appendChild(textWrap);
  row.appendChild(checkEl);

  function toggle() {
    const isSelected = selectedRoutes.has(routeKey);
    if (isSelected) {
      selectedRoutes.delete(routeKey);
      row.classList.remove('selected');
      nameEl.style.color = '';
      checkEl.style.color = '';
      hideRouteShape(mode, routeId);
    } else {
      selectedRoutes.add(routeKey);
      row.classList.add('selected');
      nameEl.style.color = readableTextColor(rawColor, currentlyDark);
      checkEl.style.color = readableTextColor(rawColor, currentlyDark);
      autoShapeKeys.delete(routeKey);
      showRouteShape(mode, routeId);
    }
    row.setAttribute('aria-checked', String(!isSelected));
    updateToggleLabel();
    renderMarkers();
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
    if (query && !info.name.toLowerCase().includes(query)) return false;
    return true;
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
}

function renderRoutePicker() {
  Object.keys(MODES).forEach((mode) => {
    const group = routeListEl.querySelector(`.route-picker-group[data-group="${mode}"]`);
    group.style.display = activeTab === 'all' || activeTab === mode ? '' : 'none';
    renderRouteSection(document.getElementById(`${mode}-rows`), mode, MODES[mode].names);
  });
  updateRouteStatuses();
}

function updateRouteStatuses() {
  document.querySelectorAll('.rp-row').forEach((row) => {
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
  }
  toggleButton.addEventListener('click', () => setPanelOpen(!panel.classList.contains('open')));
  closeButton.addEventListener('click', () => setPanelOpen(false));

  searchInput.addEventListener('input', (e) => {
    searchQuery = e.target.value;
    renderRoutePicker();
  });
}

function boundsAroundPoint(lat, lon, radiusKm) {
  const latDelta = radiusKm / 111;
  const lonDelta = radiusKm / (111 * Math.cos((lat * Math.PI) / 180));
  return L.latLngBounds([lat - latDelta, lon - lonDelta], [lat + latDelta, lon + lonDelta]);
}

function centerOnUser() {
  if (!navigator.geolocation) return;
  navigator.geolocation.getCurrentPosition(
    (position) => {
      userLocation = { lat: position.coords.latitude, lon: position.coords.longitude };
      map.fitBounds(boundsAroundPoint(userLocation.lat, userLocation.lon, LOCAL_RADIUS_KM));
      if (userLocationMarker) map.removeLayer(userLocationMarker);
      userLocationMarker = L.marker([userLocation.lat, userLocation.lon], {
        icon: buildUserLocationIcon(),
        zIndexOffset: 1000,
      }).addTo(map);
      renderMarkers();
    },
    () => {},
    { timeout: 5000 }
  );
}

initRoutePicker();
updateToggleLabel();
centerOnUser();
refreshData();
setInterval(refreshData, REFRESH_INTERVAL_MS);