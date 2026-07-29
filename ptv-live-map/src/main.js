import './style.css';
import 'leaflet/dist/leaflet.css';
import L from 'leaflet';
import trainRouteNames from './data/train-routes.json';
import tramRouteNames from './data/tram-routes.json';
import vlineRouteNames from './data/vline-routes.json';

const TILES = {
  light: 'https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png',
  dark: 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png',
};
const ATTRIBUTION = '&copy; OpenStreetMap contributors &copy; CARTO';
const LOCAL_RADIUS_KM = 5;

const MODES = {
  tram: { label: 'Trams', color: '#6b46c1', names: tramRouteNames, hasAlerts: true },
  train: { label: 'Trains', color: '#1d4ed8', names: trainRouteNames, hasAlerts: true },
  vline: { label: 'V/Line', color: '#8F1A95', names: vlineRouteNames, hasAlerts: false },
};

const map = L.map('app').setView([-37.8136, 144.9631], 13);
let tileLayer = L.tileLayer(TILES.light, { attribution: ATTRIBUTION }).addTo(map);

function setDarkMode(dark) {
  map.removeLayer(tileLayer);
  tileLayer = L.tileLayer(dark ? TILES.dark : TILES.light, { attribution: ATTRIBUTION }).addTo(map);
  document.body.classList.toggle('dark-mode', dark);
}
const darkQuery = window.matchMedia('(prefers-color-scheme: dark)');
setDarkMode(darkQuery.matches);
darkQuery.addEventListener('change', (e) => setDarkMode(e.matches));

const markers = new Map();
let allVehicles = [];
let alertsByRoute = new Map();
let userLocation = null;
const selectedRoutes = new Set();
let searchQuery = '';
let activeTab = 'all';

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

  allVehicles.forEach((v) => {
    if (v.lat == null || v.lon == null) return;
    const key = `${v.mode}-${v.id}`;
    seen.add(key);

    const routeKey = `${v.mode}:${baseRouteId(v.routeId)}`;
    const withinRadius = !userLocation || haversineKm(userLocation.lat, userLocation.lon, v.lat, v.lon) <= LOCAL_RADIUS_KM;
    const visible = hasSelection ? selectedRoutes.has(routeKey) : withinRadius;

    let marker = markers.get(key);
    if (!marker) {
      const info = routeInfo(v.mode, v.routeId);
      const color = info.color || MODES[v.mode]?.color || '#666';
      marker = L.circleMarker([v.lat, v.lon], { radius: 6, color, fillColor: color, fillOpacity: 0.9 });
      marker.bindPopup(`<strong>${MODES[v.mode]?.label ?? v.mode} route ${info.name}</strong><br>Vehicle: ${v.id}`);
      markers.set(key, marker);
    } else {
      marker.setLatLng([v.lat, v.lon]);
    }

    if (visible && !map.hasLayer(marker)) marker.addTo(map);
    if (!visible && map.hasLayer(marker)) map.removeLayer(marker);
  });

  for (const [key, marker] of markers.entries()) {
    if (!seen.has(key)) {
      map.removeLayer(marker);
      markers.delete(key);
    }
  }
}

const toggleButton = document.getElementById('route-picker-toggle');
const panel = document.getElementById('route-picker-panel');
const searchInput = document.getElementById('route-search');
const modeTabsEl = document.getElementById('mode-tabs');
const routeListEl = document.getElementById('route-list');

function updateToggleLabel() {
  toggleButton.textContent = selectedRoutes.size === 0
    ? 'All vehicles (near me) ▾'
    : `${selectedRoutes.size} route${selectedRoutes.size > 1 ? 's' : ''} selected ▾`;
}

function buildRouteRow(container, mode, routeId, info) {
  const routeKey = `${mode}:${routeId}`;
  const selected = selectedRoutes.has(routeKey);

  const row = document.createElement('div');
  row.className = 'rp-row' + (selected ? ' selected' : '');
  row.dataset.routeKey = routeKey;
  row.setAttribute('role', 'checkbox');
  row.setAttribute('aria-checked', String(selected));
  row.tabIndex = 0;

  const swatch = document.createElement('span');
  swatch.className = 'rp-swatch';
  swatch.style.backgroundColor = info.color || MODES[mode]?.color || '#999';

  const textWrap = document.createElement('div');
  textWrap.className = 'rp-text';
  const nameEl = document.createElement('div');
  nameEl.className = 'rp-name';
  nameEl.textContent = info.name;
  if (selected) nameEl.style.color = info.color || MODES[mode]?.color || '';
  const statusEl = document.createElement('div');
  statusEl.className = 'rp-status';
  textWrap.appendChild(nameEl);
  textWrap.appendChild(statusEl);
  row.appendChild(swatch);
  row.appendChild(textWrap);

  function toggle() {
    const isSelected = selectedRoutes.has(routeKey);
    if (isSelected) {
      selectedRoutes.delete(routeKey);
      row.classList.remove('selected');
      nameEl.style.color = '';
    } else {
      selectedRoutes.add(routeKey);
      row.classList.add('selected');
      nameEl.style.color = info.color || MODES[mode]?.color || '';
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
    const color = info.color || '#999999';
    if (!colorGroups.has(color)) colorGroups.set(color, []);
    colorGroups.get(color).push([routeId, info]);
  });

  [...colorGroups.values()]
    .sort((a, b) => a[0][1].name.localeCompare(b[0][1].name, undefined, { numeric: true }))
    .forEach((group) => {
      group.sort((a, b) => a[1].name.localeCompare(b[1].name, undefined, { numeric: true }));
      const groupEl = document.createElement('div');
      groupEl.className = group.length > 1 ? 'rp-group-shared' : '';
      if (group.length > 1) groupEl.style.borderLeftColor = group[0][1].color || '#999';
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

  toggleButton.addEventListener('click', () => { panel.hidden = !panel.hidden; });

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
setInterval(refreshData, 20000);