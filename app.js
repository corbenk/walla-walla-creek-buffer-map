/* Walla Walla Creek Buffer Map — static app. No backend.
   Everything geographic is read LIVE in the browser from public ArcGIS services (City of Walla Walla GIS, Walla Walla County GIS,
   WA DNR). No City or County geometry is re-hosted on this site. See ../README.md for URLs, fields, and content schemas. */
(function () {
  'use strict';

  // ---------- Config ----------
  const CENTER = [-118.343, 46.065];           // Walla Walla
  const BBOX = { w: -118.50, s: 45.98, e: -118.20, n: 46.14 }; // geocoder bounds (WW + College Place + margin)
  const WIDTHS = [35, 50, 75, 100, 150];
  const NEAR_FT = 50;                            // "near" band outside the buffer edge
  const UNCERTAIN_FT = 150;                      // OHWM / top-of-bank uncertainty band
  const FT_PER_M = 3.280839895;
  const PARCEL_ZOOM = 16;                        // parcel outlines are fetched for the viewport at/above this zoom
  const params = new URLSearchParams(location.search);
  const DEMO = params.get('demo') === '1';
  const DATA = DEMO ? 'dev-sample/' : 'data/';
  const RM = !!(window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches); // reduced motion: no animation, instant states
  const SHARED = !!(params.get('lat') && params.get('lng'));
  const RMX = RM || params.get('rm') === '1';                 // reduced motion for the entry sequence (rm=1 is a test hook)
  const HOMING = !SHARED && !DEMO && params.get('intro') === 'wa'; // 2026-10-12 landing hook: the page opens on Walla Walla; the Washington-State opening is an optional flourish (?intro=wa). runHoming() still runs for ZIP searches (see the submit handler)
  const WA_CENTER = [-120.6, 47.4], WA_ZOOM = 6;
  const COUNTY_BBOX = [-119.047, 45.982, -117.966, 46.618];
  // Walla Walla County ZIP areas (bbox from the County parcel layer's situs_zip extents, 99362 trimmed to the city area; 2026-10-10)
  const ZIPS = { '99362': { name: 'Walla Walla', bbox: [-118.42, 46.01, -118.26, 46.12], pt: [-118.343, 46.065] }, '99324': { name: 'College Place', bbox: [-118.45, 46.02, -118.36, 46.08], pt: [-118.389, 46.048] },
                 '99361': { name: 'Dixie / east valley', bbox: [-118.25, 46.08, -117.99, 46.30] }, '99348': { name: 'Prescott', bbox: [-118.77, 46.20, -118.23, 46.61] },
                 '99360': { name: 'Touchet', bbox: [-118.87, 45.99, -118.34, 46.26] }, '99363': { name: 'Wallula', bbox: [-118.95, 46.03, -118.85, 46.12] },
                 '99329': { name: 'Waitsburg', bbox: [-118.49, 46.01, -117.99, 46.20] }, '99323': { name: 'Burbank', bbox: [-119.03, 46.00, -118.75, 46.30] } };
  const COUNTY_LINE = 'https://services8.arcgis.com/COL6rRPkF9w28VGX/ArcGIS/rest/services/Administrative_Boundaries/FeatureServer/0'; // County Boundary polygon (4 KB generalized)
  const homing = { active: false, pending: false, skip: false, done: !HOMING };
  const DEFAULT_ZOOM = 12.6, INTRO_ZOOM_OUT = 0.9;  // intro eases from a slightly wider citywide view into the default view
  const BAND = { fill: '#d4891c', line: '#a86a10', fillOpacity: 0.35, lineOpacity: 0.8 }; // amber band
  const INK = '#15202b', CREEK = '#1d6fb8', TEAL = '#1F6F8B', SAGE = '#7a8f7f', MILLBLUE = '#17385c', ZONE = '#8c6bb1', FLOOD = '#3b8ea5';
  const html = document.documentElement;
  const intro = { modalClosed: false, layersShown: false }; const afterIntroQ = [];
  let styleReady = false; // style JSON parsed (sources/layers can be added). Unlike map.isStyleLoaded() it does not wait for basemap tiles, which keep loading during camera moves

  // Live public services (all answer CORS for this origin). Documented in README.md and method.html.
  const CITY_FS = 'https://services1.arcgis.com/F8n8WJgK0mEjXgtm/arcgis/rest/services/WW_Streams_Riparian_Buffer/FeatureServer';
  const COUNTY_FS = 'https://services8.arcgis.com/COL6rRPkF9w28VGX/ArcGIS/rest/services';
  const COUNTY_PARCELS = COUNTY_FS + '/Tax_Parcels/FeatureServer/0';
  const COUNTY_BUFFER = COUNTY_FS + '/Minimum_Riparian_Buffer/FeatureServer/0';      // "WallaWallaCounty_Minimum_Riparian_Buffer_20260831", buff_dist 35/50/75/100
  const COUNTY_STREAMS = COUNTY_FS + '/Hydrologic_Features/FeatureServer/0';          // County-mapped streams incl. MILL CREEK / MILL CREEK (CHANNEL)
  const COUNTY_CITIES = COUNTY_FS + '/City_Limits/FeatureServer/0';                   // 5 city polygons (name)
  const COUNTY_UGA = COUNTY_FS + '/Urban_Growth_Areas/FeatureServer/0';                // 6 UGA polygons (name)
  const COUNTY_ZONING = COUNTY_FS + '/Zoning/FeatureServer/0';                        // unincorporated + UGA zoning (zon_abbrev, zoning, jurisdicti)
  const COUNTY_FLOOD = COUNTY_FS + '/FEMA/FeatureServer/0';                           // legacy FEMA Q3 (zone, floodway, sfha); the county is not in the digital NFHL
  const DNR_HYDRO = 'https://gis.dnr.wa.gov/site2/rest/services/Public_Forest_Practices/WADNR_PUBLIC_FP_Hydro/MapServer/0'; // Watercourses (DNR), FP_WTRTY_CD
  const PARCEL_FIELDS = 'geo_id,prop_id,full_situs,situs_num,situs_city,situs_zip,size_acres,link';
  const AREA_BBOX = '-118.52,45.96,-118.14,46.16';   // city + UGA + margin; County layers are fetched once for this envelope, generalized ~2 m server-side
  const GEN = { geometry: AREA_BBOX, geometryType: 'esriGeometryEnvelope', inSR: 4326, spatialRel: 'esriSpatialRelIntersects', maxAllowableOffset: 0.00002, geometryPrecision: 6 };
  const CITY_LABEL = 'City of Walla Walla GIS, Oct 6 2026';
  const COMPUTED_LABEL = 'computed in your browser from the City’s stream centerlines (' + CITY_LABEL + ')';
  const MILL_NAMES = ['MILL CREEK', 'MILL CREEK (CHANNEL)'];
  const MILL_FT = 35, SHORELINE_FT = 200;

  const state = { w: Number(params.get('w')) || 100, wantW: null, streams: null, buffers: {}, bufferSource: {}, city: null, cityRings: null,
                  content: null, stats: null, marker: null, lastPoint: null, lastLabel: null, lastParcel: null,
                  cityLimits: null, uga: null, unin: null, countyBuf: null, countyStreams: null, countyOut: null, mill: null, millBand: null,
                  zoning: null, dnr: null, flood: null, countyGaps: null, countyLine: null, layers: {}, loading: {} };

  // ---------- Helpers ----------
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const fmt = (n, d = 0) => Number(n).toLocaleString(undefined, { maximumFractionDigits: d });
  const qs = (o) => Object.entries(o).map(([k, v]) => encodeURIComponent(k) + '=' + encodeURIComponent(v)).join('&');
  const titleCase = (s) => String(s || '').trim().toLowerCase().replace(/\b\w/g, c => c.toUpperCase()).replace(/\bUga\b/, 'UGA').replace(/\bOf\b/, 'of');
  const EMPTY = { type: 'FeatureCollection', features: [] };
  async function getJSON(url, opts) { const r = await fetch(url, opts || { cache: 'no-cache' }); if (!r.ok) throw new Error(url + ' ' + r.status); return r.json(); }
  async function arcgis(layerUrl, extra) {
    const url = layerUrl + '/query?' + qs(Object.assign({ where: '1=1', outFields: '*', f: 'geojson', outSR: 4326, returnGeometry: true }, extra || {}));
    const r = await fetch(url); if (!r.ok) throw new Error('HTTP ' + r.status + ' from ' + layerUrl);
    const j = await r.json(); if (j && j.error) throw new Error('ArcGIS error ' + JSON.stringify(j.error));
    j.features = (j.features || []).filter(f => f.geometry); return j;
  }
  function banner(msg) { const b = $('banner'); if (!msg) { b.classList.add('hidden'); return; } b.textContent = msg; b.classList.remove('hidden'); }
  function lsGet(k) { try { return localStorage.getItem(k); } catch { return null; } }
  function lsSet(k, v) { try { localStorage.setItem(k, v); } catch {} }
  const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
  const pip = (pt, f) => { try { return turf.booleanPointInPolygon(pt, f); } catch { return false; } };

  // ---------- Layer registry (onX-style panel). key = URL token; ids = map layer ids; load = lazy fetch on first switch-on ----------
  const LAYERS = [
    { key: 'cty', group: 'Boundaries', label: 'Walla Walla County boundary', desc: 'County line (County GIS).', sw: 'cty', def: true, ids: ['county-line'], load: 'county_line' },
    { key: 'ww', group: 'Boundaries', label: 'City of Walla Walla limits', desc: 'The proposed ordinance applies inside this line (City GIS, Oct 6 2026).', sw: 'city', def: true, ids: ['city-line'] },
    { key: 'cp', group: 'Boundaries', label: 'City of College Place limits', desc: 'College Place has its own critical-areas code; boundary only (County GIS).', sw: 'cp', def: true, ids: ['cp-line', 'cp-label'], load: 'boundaries' },
    { key: 'uga', group: 'Boundaries', label: 'Urban Growth Area boundary', desc: 'County Urban_Growth_Areas. Unincorporated land inside the UGA follows County rules.', sw: 'uga', def: true, ids: ['uga-line', 'uga-label'], load: 'boundaries' },
    { key: 'unin', group: 'Boundaries', label: 'Unincorporated county outside the UGA', desc: 'Light shading where neither a city nor a UGA applies.', sw: 'unin', def: false, ids: ['unin-fill'], load: 'boundaries' },
    { key: 'b100', group: 'Buffer rules', label: 'City proposed 100-ft band', desc: 'The City’s own polygon (Oct 6 2026). The 35/50/75/150 pills above swap comparison widths.', sw: 'band', def: true, ids: WIDTHS.map(w => 'buf' + w + '-fill').concat(WIDTHS.map(w => 'buf' + w + '-line')) },
    { key: 'cbuf', group: 'Buffer rules', label: 'County working buffer (Aug 2026, tiered 35–100 ft)', desc: 'Walla Walla County GIS working layer, Aug 31 2026; applies outside city limits. Not an adopted rule.', sw: 'cbuf', def: true, ids: ['cbuf-fill', 'cbuf-line'], load: 'county' },
    { key: 'mill', group: 'Buffer rules', label: 'Mill Creek: Shoreline Master Program 35-ft', desc: 'Flood-channel buffer under the City SMP (Table 6.5-1); Mill Creek is not part of this ordinance.', sw: 'mill', def: true, ids: ['mill-band-fill', 'mill-band-line', 'mill-line', 'mill-label'], load: 'county' },
    { key: 'cpnote', group: 'Buffer rules', label: 'College Place buffers', desc: 'No public College Place buffer layer exists; only its boundary is drawn. Ask College Place Planning.', note: true },
    { key: 'cstr', group: 'Streams', label: 'City-mapped streams', desc: 'City of Walla Walla visible-stream centerlines, Oct 6 2026 (inside city limits only).', sw: 'stream', def: true, ids: ['streams-line', 'streams-label'] },
    { key: 'cstreams', group: 'Streams', label: 'County-mapped streams', desc: 'Walla Walla County Hydrologic Features (2021), drawn outside city limits.', sw: 'cstream', def: true, ids: ['cstreams-line', 'cstreams-label'], load: 'county' },
    { key: 'cgaps', group: 'Streams', label: 'County-mapped reaches not in the City\u2019s layer (likely piped or not digitized)', desc: 'Inside city limits, reaches the County maps but the City\u2019s visible-streams layer does not (Lincoln, Butcher, Bryant, short Garrison/Owen pieces). The draft would not buffer them unless the City adds them.', sw: 'cgap', def: false, ids: ['cgaps-line', 'cgaps-label'], load: 'county' },
    { key: 'dnr', group: 'Streams', label: 'DNR watercourses (water type S / F / N)', desc: 'WA DNR Forest Practices hydro with water-type codes; a different dataset for a different law, shown for comparison.', sw: 'dnr', def: false, ids: ['dnr-line', 'dnr-label'], load: 'dnr' },
    { key: 'zon', group: 'Zoning', label: 'County zoning districts', desc: 'Walla Walla County zoning (unincorporated + UGA), labeled by district at zoom 14+. No public City of Walla Walla or College Place zoning service exists.', sw: 'zon', def: false, ids: ['zon-fill', 'zon-line', 'zon-label'], load: 'zoning' },
    { key: 'parcels', group: 'Reference', label: 'Parcels (zoom in)', desc: 'County Assessor parcel lines, fetched for the view at zoom 16+.', sw: 'parcel', def: true, ids: ['parcels-line'] },
    { key: 'flood', group: 'Reference', label: 'Floodplain (FEMA Q3 via County, legacy)', desc: 'Walla Walla County is not in FEMA’s digital NFHL; this is the County GIS copy of the legacy Q3 flood zones.', sw: 'flood', def: false, ids: ['flood-fill', 'flood-line', 'flood-label'], load: 'flood' },
  ];
  const LAYER_BY_KEY = Object.fromEntries(LAYERS.map(l => [l.key, l]));
  (function initLayerState() {
    const defaults = Object.fromEntries(LAYERS.filter(l => !l.note).map(l => [l.key, !!l.def]));
    let s = Object.assign({}, defaults);
    const tok = params.get('layers');
    if (tok != null) { const on = new Set(tok.split('.').filter(Boolean)); Object.keys(s).forEach(k => s[k] = on.has(k)); }
    else { try { const saved = JSON.parse(lsGet('ww_layers') || 'null'); if (saved && typeof saved === 'object') Object.keys(s).forEach(k => { if (k in saved) s[k] = !!saved[k]; }); } catch {} }
    state.layers = s; state.layerDefaults = defaults;
  })();
  const layerOn = (key) => state.layers[key] !== false;
  const vis = (key) => (layerOn(key) ? 'visible' : 'none');

  // ---------- Map ----------
  const rasterFallback = { version: 8, sources: { osm: { type: 'raster', tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'], tileSize: 256,
    attribution: '&copy; OpenStreetMap contributors' } }, layers: [{ id: 'osm', type: 'raster', source: 'osm' }] };
  const map = new maplibregl.Map({
    container: 'map',
    style: 'https://tiles.openfreemap.org/styles/liberty',
    center: HOMING ? WA_CENTER : [Number(params.get('lng')) || CENTER[0], Number(params.get('lat')) || CENTER[1]],
    zoom: HOMING ? WA_ZOOM : (Number(params.get('z')) || (DEFAULT_ZOOM - (RM || SHARED ? 0 : INTRO_ZOOM_OUT))),
    attributionControl: true,
    pixelRatio: Math.min(window.devicePixelRatio || 1, 2)   // 2026-10-12: cap at 2x; 3x iPhones otherwise hold ~2.25x the GPU memory (scroll stalls)
  });
  map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
  map.addControl(new maplibregl.GeolocateControl({ positionOptions: { enableHighAccuracy: true }, trackUserLocation: false }), 'top-right');
  map.on('error', (e) => { // style failed → raster fallback
    if (e && e.error && /style|tiles.openfreemap/i.test(String(e.error.message || e.error))) { try { styleReady = false; map.setStyle(rasterFallback); } catch {} }
  });

  const FONT = ['Noto Sans Regular'];
  function addLayers() {
    const shown = intro.layersShown; const T = { duration: RM ? 0 : 350 }; // before the intro reveal, layers start transparent and fade in
    const below = (id) => (map.getLayer(id) ? id : undefined);
    // --- County context beneath everything: unincorporated shading, UGA, College Place, County buffer, County streams, zoning, flood
    if (state.countyLine && !map.getSource('county')) {
      map.addSource('county', { type: 'geojson', data: state.countyLine });
      map.addLayer({ id: 'county-line', type: 'line', source: 'county', layout: { visibility: vis('cty') }, paint: { 'line-color': INK, 'line-width': 1.2, 'line-opacity': homing.active ? 0 : 0.8 } });
    }
    if (state.unin && !map.getSource('unin')) {
      map.addSource('unin', { type: 'geojson', data: state.unin });
      map.addLayer({ id: 'unin-fill', type: 'fill', source: 'unin', layout: { visibility: vis('unin') }, paint: { 'fill-color': INK, 'fill-opacity': 0.06 } });
    }
    if (state.flood && !map.getSource('flood')) {
      map.addSource('flood', { type: 'geojson', data: state.flood, attribution: 'Flood zones: FEMA Q3 via Walla Walla County GIS (legacy)' });
      map.addLayer({ id: 'flood-fill', type: 'fill', source: 'flood', layout: { visibility: vis('flood') }, paint: { 'fill-color': FLOOD, 'fill-opacity': ['case', ['==', ['get', 'sfha'], 'IN'], 0.22, 0.1] } });
      map.addLayer({ id: 'flood-line', type: 'line', source: 'flood', layout: { visibility: vis('flood') }, paint: { 'line-color': FLOOD, 'line-width': 0.6, 'line-opacity': 0.7 } });
      map.addLayer({ id: 'flood-label', type: 'symbol', source: 'flood', minzoom: 14, layout: { visibility: vis('flood'), 'text-field': ['concat', 'Zone ', ['get', 'zone']], 'text-size': 10, 'text-font': FONT }, paint: { 'text-color': FLOOD, 'text-halo-color': '#fff', 'text-halo-width': 1.2 } });
    }
    if (state.zoning && !map.getSource('zon')) {
      map.addSource('zon', { type: 'geojson', data: state.zoning, attribution: 'Zoning: Walla Walla County GIS' });
      map.addLayer({ id: 'zon-fill', type: 'fill', source: 'zon', minzoom: 14, layout: { visibility: vis('zon') }, paint: { 'fill-color': ZONE, 'fill-opacity': 0.08 } });
      map.addLayer({ id: 'zon-line', type: 'line', source: 'zon', minzoom: 14, layout: { visibility: vis('zon') }, paint: { 'line-color': ZONE, 'line-width': 0.8, 'line-opacity': 0.6 } });
      map.addLayer({ id: 'zon-label', type: 'symbol', source: 'zon', minzoom: 14, layout: { visibility: vis('zon'), 'text-field': ['get', 'zon_abbrev'], 'text-size': 11, 'text-font': FONT, 'symbol-placement': 'point' }, paint: { 'text-color': ZONE, 'text-halo-color': '#fff', 'text-halo-width': 1.4 } });
    }
    if (state.countyBuf && !map.getSource('cbuf')) {
      map.addSource('cbuf', { type: 'geojson', data: state.countyBuf, attribution: 'County buffer & streams: Walla Walla County GIS (2026-08-31)' });
      map.addLayer({ id: 'cbuf-fill', type: 'fill', source: 'cbuf', layout: { visibility: vis('cbuf') }, paint: { 'fill-color': SAGE, 'fill-opacity': 0.4 } });
      map.addLayer({ id: 'cbuf-line', type: 'line', source: 'cbuf', layout: { visibility: vis('cbuf') }, paint: { 'line-color': TEAL, 'line-width': 0.8, 'line-dasharray': [2, 2], 'line-opacity': 0.8 } });
    }
    if (state.countyOut && !map.getSource('cstreams')) {
      map.addSource('cstreams', { type: 'geojson', data: state.countyOut });
      map.addLayer({ id: 'cstreams-line', type: 'line', source: 'cstreams', layout: { visibility: vis('cstreams') }, paint: { 'line-color': TEAL, 'line-width': ['interpolate', ['linear'], ['zoom'], 10, 1, 16, 2.6], 'line-dasharray': [3, 2] } });
      map.addLayer({ id: 'cstreams-label', type: 'symbol', source: 'cstreams', minzoom: 13, layout: { visibility: vis('cstreams'), 'symbol-placement': 'line', 'text-field': ['get', 'label'], 'text-size': 10.5, 'text-font': FONT }, paint: { 'text-color': TEAL, 'text-halo-color': '#fff', 'text-halo-width': 1.2 } });
    }
    if (state.countyGaps && !map.getSource('cgaps')) {
      map.addSource('cgaps', { type: 'geojson', data: state.countyGaps });
      map.addLayer({ id: 'cgaps-line', type: 'line', source: 'cgaps', layout: { visibility: vis('cgaps') }, paint: { 'line-color': TEAL, 'line-width': 1.2, 'line-dasharray': [2, 2], 'line-opacity': 0.9 } });
      map.addLayer({ id: 'cgaps-label', type: 'symbol', source: 'cgaps', minzoom: 14, layout: { visibility: vis('cgaps'), 'symbol-placement': 'line', 'text-field': ['concat', ['get', 'label'], ' (County only)'], 'text-size': 10, 'text-font': FONT }, paint: { 'text-color': TEAL, 'text-halo-color': '#fff', 'text-halo-width': 1.2 } });
    }
    if (state.dnr && !map.getSource('dnr')) {
      map.addSource('dnr', { type: 'geojson', data: state.dnr, attribution: 'DNR watercourses: WA DNR Forest Practices' });
      map.addLayer({ id: 'dnr-line', type: 'line', source: 'dnr', layout: { visibility: vis('dnr') }, paint: { 'line-color': '#6b4fa0', 'line-width': 1.4, 'line-dasharray': [1, 1.5], 'line-opacity': 0.9 } });
      map.addLayer({ id: 'dnr-label', type: 'symbol', source: 'dnr', minzoom: 14, layout: { visibility: vis('dnr'), 'symbol-placement': 'line', 'text-field': ['get', 'label'], 'text-size': 10, 'text-font': FONT }, paint: { 'text-color': '#6b4fa0', 'text-halo-color': '#fff', 'text-halo-width': 1.2 } });
    }
    if (state.uga && !map.getSource('uga')) {
      map.addSource('uga', { type: 'geojson', data: state.uga, attribution: 'UGA & city limits: Walla Walla County GIS' });
      map.addLayer({ id: 'uga-line', type: 'line', source: 'uga', layout: { visibility: vis('uga') }, paint: { 'line-color': SAGE, 'line-width': 2, 'line-dasharray': [1, 1.2], 'line-opacity': 0.9 } });
      map.addLayer({ id: 'uga-label', type: 'symbol', source: 'uga', minzoom: 11, layout: { visibility: vis('uga'), 'symbol-placement': 'line', 'text-field': ['get', 'label'], 'text-size': 10.5, 'text-font': FONT }, paint: { 'text-color': '#4b5f51', 'text-halo-color': '#fff', 'text-halo-width': 1.2 } });
    }
    if (state.cpPoly && !map.getSource('cp')) {
      map.addSource('cp', { type: 'geojson', data: state.cpPoly });
      map.addLayer({ id: 'cp-line', type: 'line', source: 'cp', layout: { visibility: vis('cp') }, paint: { 'line-color': '#5d6974', 'line-width': 2, 'line-dasharray': [2, 1.4], 'line-opacity': 0.9 } });
      map.addLayer({ id: 'cp-label', type: 'symbol', source: 'cp', minzoom: 11, layout: { visibility: vis('cp'), 'symbol-placement': 'line', 'text-field': 'City of College Place (own code)', 'text-size': 10.5, 'text-font': FONT }, paint: { 'text-color': '#5d6974', 'text-halo-color': '#fff', 'text-halo-width': 1.2 } });
    }
    // --- City of Walla Walla layers
    if (state.city && !map.getSource('city')) {
      map.addSource('city', { type: 'geojson', data: state.city, attribution: DEMO ? '' : 'City limit: City of Walla Walla GIS' });
      map.addLayer({ id: 'city-line', type: 'line', source: 'city', layout: { visibility: vis('ww') }, paint: { 'line-color': INK, 'line-width': 2.8, 'line-dasharray': [3, 1.6], 'line-opacity': shown ? 1 : 0, 'line-opacity-transition': T } });
    }
    WIDTHS.forEach(w => {
      const fc = state.buffers[w]; if (!fc || map.getSource('buf' + w)) return;
      const on = shown && w === state.w; // bands are always "visible"; the selected one is opaque, the others transparent (cross-fade on toggle)
      map.addSource('buf' + w, { type: 'geojson', data: fc, attribution: (!DEMO && w === 100) ? '100-ft buffer: City of Walla Walla GIS (2026-10-06)' : '' });
      map.addLayer({ id: 'buf' + w + '-fill', type: 'fill', source: 'buf' + w, layout: { visibility: vis('b100') }, paint: { 'fill-color': BAND.fill, 'fill-opacity': on ? BAND.fillOpacity : 0, 'fill-opacity-transition': T } });
      map.addLayer({ id: 'buf' + w + '-line', type: 'line', source: 'buf' + w, layout: { visibility: vis('b100') }, paint: { 'line-color': BAND.line, 'line-width': 1.2, 'line-opacity': on ? BAND.lineOpacity : 0, 'line-opacity-transition': T } });
    });
    if (state.mill && !map.getSource('mill')) { // Mill Creek (SMP): in-city reach from the County layer + 35-ft flood-channel band
      map.addSource('mill-band', { type: 'geojson', data: state.millBand || EMPTY });
      map.addLayer({ id: 'mill-band-fill', type: 'fill', source: 'mill-band', layout: { visibility: vis('mill') }, paint: { 'fill-color': MILLBLUE, 'fill-opacity': 0.15 } });
      map.addLayer({ id: 'mill-band-line', type: 'line', source: 'mill-band', layout: { visibility: vis('mill') }, paint: { 'line-color': MILLBLUE, 'line-width': 1, 'line-dasharray': [2, 1.5], 'line-opacity': 0.9 } });
      map.addSource('mill', { type: 'geojson', data: state.mill });
      map.addLayer({ id: 'mill-line', type: 'line', source: 'mill', layout: { visibility: vis('mill') }, paint: { 'line-color': MILLBLUE, 'line-width': ['interpolate', ['linear'], ['zoom'], 10, 1.4, 16, 3.2], 'line-dasharray': [0.4, 1.8] } });
      map.addLayer({ id: 'mill-label', type: 'symbol', source: 'mill', minzoom: 12, layout: { visibility: vis('mill'), 'symbol-placement': 'line', 'text-field': 'Mill Creek (Shoreline Master Program)', 'text-size': 11, 'text-font': FONT }, paint: { 'text-color': MILLBLUE, 'text-halo-color': '#fff', 'text-halo-width': 1.2 } });
    }
    if (state.streams && !map.getSource('streams')) {
      map.addSource('streams', { type: 'geojson', data: state.streams, attribution: DEMO ? 'DEMO data' : 'Streams: City of Walla Walla GIS (2026-10-06)' });
      map.addLayer({ id: 'streams-line', type: 'line', source: 'streams', layout: { visibility: vis('cstr') }, paint: { 'line-color': CREEK, 'line-width': ['interpolate', ['linear'], ['zoom'], 10, 1.2, 16, 3.5], 'line-opacity': shown ? 1 : 0, 'line-opacity-transition': T } });
      map.addLayer({ id: 'streams-label', type: 'symbol', source: 'streams', minzoom: 13,
        layout: { visibility: vis('cstr'), 'symbol-placement': 'line', 'text-field': ['coalesce', ['get', 'name'], ''], 'text-size': 11, 'text-font': FONT },
        paint: { 'text-color': CREEK, 'text-halo-color': '#fff', 'text-halo-width': 1.2, 'text-opacity': shown ? 1 : 0, 'text-opacity-transition': T } });
    }
    if (!DEMO && !map.getSource('parcels')) { // live viewport parcels (outline only, zoom >= PARCEL_ZOOM)
      map.addSource('parcels', { type: 'geojson', data: EMPTY, attribution: 'Parcels: Walla Walla County GIS / Assessor' });
      map.addLayer({ id: 'parcels-line', type: 'line', source: 'parcels', minzoom: PARCEL_ZOOM, layout: { visibility: vis('parcels') }, paint: { 'line-color': '#777', 'line-width': 0.6, 'line-opacity': 0.7 } });
    }
    if (!map.getSource('parcel-hit')) { // the one parcel being checked
      map.addSource('parcel-hit', { type: 'geojson', data: state.lastParcel ? turf.featureCollection([state.lastParcel]) : EMPTY });
      map.addLayer({ id: 'parcel-hit-fill', type: 'fill', source: 'parcel-hit', paint: { 'fill-color': CREEK, 'fill-opacity': 0.14 } });
      map.addLayer({ id: 'parcel-hit-casing', type: 'line', source: 'parcel-hit', paint: { 'line-color': '#ffffff', 'line-width': 5, 'line-opacity': 0.9 } });
      map.addLayer({ id: 'parcel-hit-line', type: 'line', source: 'parcel-hit', paint: { 'line-color': INK, 'line-width': 2.2 } });
    }
    // keep the stacking order stable when context layers arrive after the City layers: context below 'city-line', Mill Creek below 'streams-line'
    ['county-line', 'unin-fill', 'flood-fill', 'flood-line', 'flood-label', 'zon-fill', 'zon-line', 'zon-label', 'cbuf-fill', 'cbuf-line', 'cstreams-line', 'cstreams-label', 'cgaps-line', 'cgaps-label', 'dnr-line', 'dnr-label', 'uga-line', 'uga-label', 'cp-line', 'cp-label']
      .forEach(id => { if (map.getLayer(id) && map.getLayer('city-line')) map.moveLayer(id, 'city-line'); });
    ['mill-band-fill', 'mill-band-line', 'mill-line', 'mill-label'].forEach(id => { if (map.getLayer(id) && map.getLayer('streams-line')) map.moveLayer(id, 'streams-line'); });
    ['parcel-hit-fill', 'parcel-hit-casing', 'parcel-hit-line'].forEach(id => { if (map.getLayer(id)) map.moveLayer(id); });
    if (!shown) setTimeout(revealLayers, 60); // let the transparent state paint once, then fade in (no-op until the disclaimer closes)
  }
  map.on('style.load', () => { styleReady = true; addLayers(); });

  function setWidth(w) {
    if (!state.buffers[w]) { state.wantW = w; return; }
    state.w = w; state.wantW = null; $('legendW').textContent = w; $('legendSrc').textContent = state.bufferSource[w] || '';
    document.querySelectorAll('#widths button').forEach(b => b.classList.toggle('active', Number(b.dataset.w) === w));
    moveInd();
    if (intro.layersShown) WIDTHS.forEach(x => bandOpacity(x, x === w)); // cross-fade bands (paint transitions)
    renderStats();
    if (state.lastPoint) evaluate(state.lastPoint, state.lastLabel, state.lastParcel);
    syncURL();
  }
  function syncURL() {
    const p = state.lastPoint; const u = new URL(location.href); u.search = '';
    if (p) { u.searchParams.set('lat', p[1].toFixed(6)); u.searchParams.set('lng', p[0].toFixed(6)); }
    u.searchParams.set('w', state.w); u.searchParams.set('z', map.getZoom().toFixed(1)); if (DEMO) u.searchParams.set('demo', '1');
    const keys = Object.keys(state.layerDefaults); if (keys.some(k => !!state.layers[k] !== state.layerDefaults[k])) u.searchParams.set('layers', keys.filter(k => state.layers[k]).join('.'));
    history.replaceState(null, '', u.toString());
  }

  // ---------- Layers panel ----------
  const LOADERS = { boundaries: loadBoundaries, county: loadCountyLayers, dnr: loadDNR, zoning: loadZoning, flood: loadFlood, county_line: loadCountyLine };
  function applyLayer(key) {
    const L = LAYER_BY_KEY[key]; if (!L || L.note) return; const on = layerOn(key);
    L.ids.forEach(id => { if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', on ? 'visible' : 'none'); });
    if (key === 'b100' && on && intro.layersShown) WIDTHS.forEach(x => bandOpacity(x, x === state.w, 0));
    if (key === 'parcels') loadViewportParcels();
    if (on && L.load && LOADERS[L.load] && !state.loading[L.load]) LOADERS[L.load]();
  }
  async function setLayer(key, on) {
    state.layers[key] = !!on; lsSet('ww_layers', JSON.stringify(state.layers)); applyLayer(key); syncURL();
    const cb = document.querySelector('#layersPanel input[data-key="' + key + '"]'); if (cb) cb.checked = !!on;
    if (key === 'cstr' || key === 'cbuf' || key === 'mill' || key === 'zon') { if (state.lastPoint) evaluate(state.lastPoint, state.lastLabel, state.lastParcel, true); }
  }
  function buildLayersPanel() {
    const p = $('layersPanel'); if (!p) return; const groups = [];
    LAYERS.forEach(l => { if (!groups.includes(l.group)) groups.push(l.group); });
    p.innerHTML = '<div class="lp-head"><h2>Map layers</h2><button type="button" class="lp-close" id="layersClose" aria-label="Close layers">×</button></div>' +
      groups.map(g => '<h3 class="lp-group">' + esc(g) + '</h3>' + LAYERS.filter(l => l.group === g).map(l => l.note
        ? '<div class="lp-row note"><span class="sw none"></span><span class="lp-text"><span class="lp-label">' + esc(l.label) + '</span><span class="lp-desc">' + esc(l.desc) + '</span></span></div>'
        : '<label class="lp-row"><input type="checkbox" data-key="' + l.key + '"' + (layerOn(l.key) ? ' checked' : '') + '><span class="sw ' + esc(l.sw) + '"></span><span class="lp-text"><span class="lp-label">' + esc(l.label) + '</span><span class="lp-desc">' + esc(l.desc) + '</span></span><span class="lp-spin" aria-hidden="true"></span></label>').join('')).join('') +
      '<p class="lp-foot">All layers are read live from the public City, County and DNR map services. Your choices are kept on this device and in the share link.</p>';
    p.querySelectorAll('input[type=checkbox]').forEach(cb => cb.addEventListener('change', () => setLayer(cb.dataset.key, cb.checked)));
    $('layersClose').onclick = () => toggleLayersPanel(false);
    p.addEventListener('keydown', (e) => { if (e.key === 'Escape') { toggleLayersPanel(false); $('layersBtn').focus(); } });
  }
  function toggleLayersPanel(open) {
    const p = $('layersPanel'), b = $('layersBtn'); if (!p) return;
    const willOpen = open == null ? p.classList.contains('hidden') : open;
    p.classList.toggle('hidden', !willOpen); b.setAttribute('aria-expanded', String(willOpen)); b.classList.toggle('active', willOpen);
    if (willOpen) { const f = p.querySelector('input,button'); if (f) f.focus(); }
  }
  function setLoading(loadKey, on) { LAYERS.filter(l => l.load === loadKey).forEach(l => { const row = document.querySelector('#layersPanel input[data-key="' + l.key + '"]'); if (row) row.closest('.lp-row').classList.toggle('loading', !!on); }); }

  // ---------- Motion hooks (class toggles, paint transitions, rAF counters; everything is instant under prefers-reduced-motion) ----------
  function bandOpacity(w, on, dur) { // cross-fade one band
    if (!map.getLayer('buf' + w + '-fill')) return;
    const t = { duration: RM ? 0 : (dur == null ? 350 : dur) };
    map.setPaintProperty('buf' + w + '-fill', 'fill-opacity-transition', t); map.setPaintProperty('buf' + w + '-fill', 'fill-opacity', on ? BAND.fillOpacity : 0);
    map.setPaintProperty('buf' + w + '-line', 'line-opacity-transition', t); map.setPaintProperty('buf' + w + '-line', 'line-opacity', on ? BAND.lineOpacity : 0);
  }
  function fadeIn(id, prop, delay) { if (!map.getLayer(id)) return; map.setPaintProperty(id, prop + '-transition', { duration: RM ? 0 : 900, delay: RM ? 0 : delay }); map.setPaintProperty(id, prop, 1); }
  function revealLayers() { // intro: the band fades in (0 → 0.35) and the streams draw up, once, after the disclaimer closes
    if (intro.layersShown || !intro.modalClosed) return;
    if (!map.getLayer('streams-line') && !map.getLayer('buf' + state.w + '-fill')) return;
    intro.layersShown = true;
    fadeIn('city-line', 'line-opacity', 0); fadeIn('streams-line', 'line-opacity', 250); fadeIn('streams-label', 'text-opacity', 500);
    WIDTHS.forEach(x => bandOpacity(x, x === state.w, 900));
  }
  function runIntro() { // after the disclaimer closes (at once for returning visitors): ease into the default view, reveal layers, stagger the panel
    if (intro.modalClosed) return; intro.modalClosed = true;
    html.classList.remove('pre-intro'); html.classList.add('intro-go');
    if (HOMING) { html.classList.add('homing'); $('q').focus(); }
    else if (!RM && !SHARED && !params.get('z')) { const go = () => map.easeTo({ zoom: DEFAULT_ZOOM, duration: 1600, easing: t => 1 - Math.pow(1 - t, 3) }); if (map.loaded()) go(); else map.once('load', go); }
    revealLayers(); afterIntroQ.splice(0).forEach(fn => fn());
  }
  const afterIntro = (fn) => intro.modalClosed ? fn() : afterIntroQ.push(fn);
  function moveInd() { // the amber pill slides under the active width toggle (transform only)
    const wd = $('widths'); let ind = wd.querySelector('.ind');
    if (!ind) { ind = document.createElement('span'); ind.className = 'ind'; ind.setAttribute('aria-hidden', 'true'); wd.appendChild(ind); }
    const b = wd.querySelector('button.active'); if (!b) { ind.classList.remove('show'); return; }
    ind.style.width = b.offsetWidth + 'px'; ind.style.height = b.offsetHeight + 'px'; ind.style.transform = 'translate(' + b.offsetLeft + 'px,' + b.offsetTop + 'px)';
    ind.classList.add('show'); if (!RM && !ind.classList.contains('ready')) { void ind.offsetWidth; ind.classList.add('ready'); }
  }
  function syncPadding() { // camera padding so eases/flights center in the map area not covered by the panel (phone: bottom sheet; desktop: left card)
    if (window.creekLayout && window.creekLayout.padding) { map.setPadding(window.creekLayout.padding()); return; } // 2026-10-12 landing hook: the landing layout keeps the panel beside the map, so it owns the padding
    const panel = $('panel'); const phone = innerWidth <= 720;
    map.setPadding(phone ? { top: 0, right: 0, bottom: Math.min(panel.offsetHeight, Math.round(innerHeight * 0.62)), left: 0 } : { top: 0, right: 0, bottom: 0, left: Math.min(panel.offsetWidth + 32, Math.round(innerWidth * 0.5)) });
  }
  syncPadding();
  window.addEventListener('resize', debounce(() => { moveInd(); syncPadding(); }, 150));
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => moveInd());
  let busyN = 0; function busy(on) { busyN = Math.max(0, busyN + (on ? 1 : -1)); $('progress').classList.toggle('on', busyN > 0); } // thin top progress bar
  function toast(msg) { const t = $('toast'); t.textContent = msg; t.classList.add('show'); clearTimeout(toast.t); toast.t = setTimeout(() => t.classList.remove('show'), 1800); }
  function tween(el, from, to, d, ms) { // rAF number counter, ease-out
    if (RM || !isFinite(from) || !isFinite(to) || from === to) { el.textContent = fmt(to, d); return; }
    if (el._raf) cancelAnimationFrame(el._raf); const t0 = performance.now();
    const step = (t) => { const k = Math.min(1, (t - t0) / ms), e = 1 - Math.pow(1 - k, 3); el.textContent = fmt(from + (to - from) * e, d); el._raf = k < 1 ? requestAnimationFrame(step) : null; };
    el._raf = requestAnimationFrame(step);
  }
  function onVisible(el, fn) { if (!('IntersectionObserver' in window)) return fn(); const io = new IntersectionObserver(es => { if (es.some(x => x.isIntersecting)) { io.disconnect(); fn(); } }, { threshold: 0.25 }); io.observe(el); }
  function skeleton(on) { // shimmer placeholder in place of the result card while an address lookup is in flight
    let k = $('skel'); const r = $('result');
    if (on) { if (!k) { k = document.createElement('div'); k.id = 'skel'; k.className = 'result loading'; k.innerHTML = '<div class="skel w55"></div><div class="skel w90"></div><div class="skel w70"></div>'; k._was = !r.classList.contains('hidden'); r.before(k); } r.classList.add('hidden'); }
    else if (k) { if (k._was) r.classList.remove('hidden'); k.remove(); }
  }
  function pulseAsk() { if (state.pulsed) return; state.pulsed = true; const b = document.querySelector('#ask .btn.primary'); if (b) b.classList.add('pulse-once'); } // once per page load
  function revealCard(r, cls, key) { // slide the card up for a new point; on a width toggle or parcel resolve only the stripe/tint re-color
    const fresh = state.cardKey !== key; state.cardKey = key;
    const keep = !fresh && r.classList.contains('reveal'); // same point re-rendered (parcel resolved, width toggled): keep the running slide-up
    r.className = 'result' + (cls ? ' ' + cls : '') + (keep ? ' reveal' : ''); if (fresh && !RM) { void r.offsetWidth; r.classList.add('reveal'); }
  }

  // ---------- Data ----------
  async function loadData() {
    const tries = []; busy(true);
    const slow = setTimeout(() => { if (!DEMO) banner('The City’s map service is slow right now. Still loading the live stream layers…'); }, 8000);
    tries.push(getJSON(DATA + 'stats.json').then(d => state.stats = d).catch(() => null));
    tries.push(getJSON('content/restrictions.json').then(d => state.content = d).catch(() => null));
    if (DEMO) {
      tries.push(getJSON(DATA + 'streams.geojson').then(d => state.streams = d).catch(() => null));
      WIDTHS.forEach(w => tries.push(getJSON(DATA + 'buffer_' + w + '.geojson').then(d => { state.buffers[w] = d; state.bufferSource[w] = 'DEMO data'; }).catch(() => null)));
      tries.push(getJSON(DATA + 'city_limits.geojson').then(d => { state.city = d; buildCityRings(); }).catch(() => null));
    } else {
      banner('Loading live City of Walla Walla GIS layers…');
      tries.push(arcgis(CITY_FS + '/0', { outFields: 'StreamName,WaterVisible,Intermittent,Subtype,Basin_Name' })
        .then(fc => { fc.features.forEach(f => { f.properties = f.properties || {}; f.properties.name = f.properties.StreamName || null; }); state.streams = fc; })
        .catch(e => console.warn('City streams layer failed', e)));
      tries.push(arcgis(CITY_FS + '/1', { outFields: 'BUFF_DIST,StreamName' })
        .then(fc => { state.buffers[100] = fc; state.bufferSource[100] = CITY_LABEL; })
        .catch(e => console.warn('City buffer layer failed', e)));
      tries.push(arcgis(CITY_FS + '/2', { outFields: 'NAME,LABEL,GIS_ACRES' })
        .then(fc => { fc.features.forEach(f => { f.properties = f.properties || {}; f.properties.name = f.properties.NAME; }); state.city = fc; buildCityRings(); })
        .catch(e => console.warn('City limit layer failed', e)));
    }
    await Promise.all(tries); clearTimeout(slow); busy(false);

    if (DEMO && state.streams && !Object.keys(state.buffers).length) { // demo: compute buffers client-side from sample centerlines
      WIDTHS.forEach(w => { try { state.buffers[w] = turf.buffer(state.streams, w * 0.3048, { units: 'meters' }); state.bufferSource[w] = 'DEMO data'; } catch {} }); }
    if (DEMO) banner('DEMO MODE: synthetic sample streams. Not real data.');
    else if (!state.streams || !state.buffers[100]) banner('The City of Walla Walla’s live GIS service could not be reached. Address checks are unavailable until it is back (this site does not re-host City or County map data). Please try again in a minute.');
    else banner(null);

    if (!state.buffers[state.w]) { state.wantW = state.w; state.w = state.buffers[100] ? 100 : (WIDTHS.find(w => state.buffers[w]) || 100); }
    const wd = $('widths');
    WIDTHS.forEach(w => { const b = document.createElement('button'); b.type = 'button'; b.dataset.w = w; b.textContent = w + ' ft';
      b.title = w === 100 && !DEMO ? CITY_LABEL : 'comparison width, ' + COMPUTED_LABEL;
      if (!state.buffers[w]) b.disabled = true; if (w === state.w) b.classList.add('active'); b.onclick = () => setWidth(w); wd.appendChild(b); });
    moveInd();
    $('legendW').textContent = state.w; $('legendSrc').textContent = state.bufferSource[state.w] || '';
    if (styleReady) addLayers();
    renderStatic(); buildLayersPanel();
    if (!DEMO && state.streams) computeComparisonBuffers();
    if (!DEMO) { loadBoundaries(); LAYERS.filter(l => l.load && layerOn(l.key)).forEach(l => { if (!state.loading[l.load]) LOADERS[l.load](); }); }
    if (params.get('lat') && params.get('lng')) { const p = [Number(params.get('lng')), Number(params.get('lat'))]; placeMarker(p); evaluate(p, 'Shared location', null); fetchParcelAt(p); }
  }
  // County boundaries (small, always fetched): city polygons for jurisdiction + College Place line; UGA polygons; unincorporated mask
  async function loadBoundaries() {
    if (state.loading.boundaries) return state.loading.boundaries;
    state.loading.boundaries = (async () => {
      setLoading('boundaries', true);
      const [cities, uga] = await Promise.all([
        arcgis(COUNTY_CITIES, Object.assign({ outFields: 'name,label' }, GEN)).catch(e => { console.warn('County city limits failed', e); return null; }),
        arcgis(COUNTY_UGA, Object.assign({ outFields: 'name' }, GEN)).catch(e => { console.warn('County UGA failed', e); return null; })]);
      if (cities) { cities.features.forEach(f => f.properties.label = titleCase(f.properties.name)); state.cityLimits = cities;
        state.cpPoly = turf.featureCollection(cities.features.filter(f => /COLLEGE PLACE/i.test(f.properties.name || ''))); }
      if (uga) { uga.features.forEach(f => f.properties.label = titleCase(f.properties.name)); state.uga = uga;
        const holes = []; uga.features.forEach(f => { const g = f.geometry; (g.type === 'Polygon' ? [g.coordinates] : g.coordinates).forEach(poly => holes.push(poly[0])); });
        const [x0, y0, x1, y1] = AREA_BBOX.split(',').map(Number); const outer = [[x0 - 1, y0 - 1], [x1 + 1, y0 - 1], [x1 + 1, y1 + 1], [x0 - 1, y1 + 1], [x0 - 1, y0 - 1]];
        state.unin = turf.featureCollection([turf.polygon([outer].concat(holes))]); }
      if (styleReady) addLayers(); setLoading('boundaries', false);
      if (state.lastPoint) evaluate(state.lastPoint, state.lastLabel, state.lastParcel, true);
    })();
    return state.loading.boundaries;
  }
  async function loadCountyLayers() {
    if (state.loading.county) return state.loading.county;
    state.loading.county = (async () => {
      setLoading('county', true);
      const [buf, str] = await Promise.all([
        arcgis(COUNTY_BUFFER, Object.assign({ outFields: 'name,buff_dist' }, GEN)).catch(e => { console.warn('County buffer layer failed', e); return null; }),
        arcgis(COUNTY_STREAMS, Object.assign({ outFields: 'name,length_mi,source' }, GEN)).catch(e => { console.warn('County streams layer failed', e); return null; })]);
      if (buf) { buf.features.forEach(f => { f.properties.name = (f.properties.name || '').trim(); f.properties.label = titleCase(f.properties.name); }); state.countyBuf = buf; }
      if (str) { str.features.forEach(f => { f.properties.name = (f.properties.name || '').trim(); f.properties.label = titleCase(f.properties.name) || 'Unnamed'; }); state.countyStreams = str; splitCountyStreams(str); }
      if (styleReady) addLayers(); setLoading('county', false);
      if (state.lastPoint) evaluate(state.lastPoint, state.lastLabel, state.lastParcel, true);
    })();
    return state.loading.county;
  }
  // County streams: runs of vertices outside the city -> "County-mapped streams"; Mill Creek runs inside the city -> SMP layer + 35-ft band.
  function splitCountyStreams(fc) {
    const out = [], millRuns = [], inRuns = [];
    const runsOf = (coords, want) => { const runs = []; let run = [];
      for (const c of coords) { const ok = state.cityRings ? inCity(turf.point(c)) : false; if (ok === want) run.push(c); else { if (run.length > 1) runs.push(run); run = []; } }
      if (run.length > 1) runs.push(run); return runs; };
    for (const f of fc.features) {
      const g = f.geometry; const lines = g.type === 'LineString' ? [g.coordinates] : g.type === 'MultiLineString' ? g.coordinates : [];
      const isMill = MILL_NAMES.includes(f.properties.name);
      for (const coords of lines) {
        runsOf(coords, false).forEach(r => out.push(turf.lineString(r, { name: f.properties.name, label: f.properties.label })));
        if (isMill) runsOf(coords, true).forEach(r => millRuns.push(r));
        else runsOf(coords, true).forEach(r => inRuns.push({ coords: r, name: f.properties.name, label: f.properties.label }));
      }
    }
    state.countyOut = turf.featureCollection(out);
    setTimeout(() => computeCountyGaps(inRuns), 0);
    if (millRuns.length) {
      state.mill = turf.featureCollection(millRuns.map(r => turf.lineString(r, { name: 'Mill Creek', label: 'Mill Creek (SMP)' })));
      try { state.millBand = turf.featureCollection([turf.buffer(turf.multiLineString(millRuns), MILL_FT * 0.3048, { units: 'meters' })]); } catch (e) { console.warn('Mill Creek band failed', e); }
    }
  }
  // County reaches inside the city with no City centerline within 50 ft (vertex test): what residents will report as "missing".
  // 2026-10-15 performance hook (same result): the old loop measured every county vertex against every whole city line and froze the
  // page ~10 s after load (taps waited). City lines are now cut into short chunks with padded boxes; only chunks whose box holds the
  // vertex are measured (0.0005° is >38 m east-west and >55 m north-south here, far more than 50 ft), and the loop yields every ~25 ms.
  function computeCountyGaps(inRuns) {
    if (!state.streams) return; const token = computeCountyGaps.token = (computeCountyGaps.token || 0) + 1;
    const PAD = 0.0005, CH = 24, chunks = [];
    for (const f of state.streams.features) { const g = f.geometry; if (!g) continue;
      const lines = g.type === 'LineString' ? [g.coordinates] : g.type === 'MultiLineString' ? g.coordinates : [];
      for (const coords of lines) { if (coords.length < 2) continue;
        for (let i = 0; i < coords.length - 1; i += CH) { const part = coords.slice(i, i + CH + 1);
          let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
          for (const c of part) { if (c[0] < x0) x0 = c[0]; if (c[0] > x1) x1 = c[0]; if (c[1] < y0) y0 = c[1]; if (c[1] > y1) y1 = c[1]; }
          chunks.push({ line: turf.lineString(part), b: [x0 - PAD, y0 - PAD, x1 + PAD, y1 + PAD] }); } } }
    const near = c => { let pt = null;
      for (const k of chunks) { if (c[0] < k.b[0] || c[0] > k.b[2] || c[1] < k.b[1] || c[1] > k.b[3]) continue;
        pt = pt || turf.point(c); if (turf.nearestPointOnLine(k.line, pt, { units: 'meters' }).properties.dist * FT_PER_M <= 50) return true; }
      return false; };
    const gaps = []; let r = 0, v = 0, cur = [];
    (function step() { if (token !== computeCountyGaps.token) return; const t0 = performance.now();
      while (r < inRuns.length) { const run = inRuns[r];
        while (v < run.coords.length) { const c = run.coords[v++];
          if (!near(c)) cur.push(c); else { if (cur.length > 1) gaps.push(turf.lineString(cur, { name: run.name, label: run.label })); cur = []; }
          if (performance.now() - t0 > 25) { setTimeout(step, 0); return; } }
        if (cur.length > 1) gaps.push(turf.lineString(cur, { name: run.name, label: run.label })); cur = []; v = 0; r++; }
      state.countyGaps = turf.featureCollection(gaps.filter(g => turf.length(g, { units: 'feet' }) >= 150));
      if (styleReady) addLayers();
      if (state.lastPoint) evaluate(state.lastPoint, state.lastLabel, state.lastParcel, true);
    })();
  }
  async function loadCountyLine() {
    if (state.loading.county_line) return state.loading.county_line;
    state.loading.county_line = (async () => { setLoading('county_line', true);
      const f = await arcgis(COUNTY_LINE, { outFields: 'name', maxAllowableOffset: 0.0005, geometryPrecision: 5 }).catch(e => { console.warn('County boundary failed', e); return null; });
      if (f) state.countyLine = f; if (styleReady) addLayers(); setLoading('county_line', false); })();
    return state.loading.county_line;
  }
  async function loadZoning() {
    if (state.loading.zoning) return state.loading.zoning;
    state.loading.zoning = (async () => { setLoading('zoning', true);
      const z = await arcgis(COUNTY_ZONING, Object.assign({ outFields: 'zon_abbrev,zoning,jurisdicti' }, GEN)).catch(e => { console.warn('County zoning failed', e); return null; });
      if (z) state.zoning = z; if (styleReady) addLayers(); setLoading('zoning', false);
      if (state.lastPoint) evaluate(state.lastPoint, state.lastLabel, state.lastParcel, true); })();
    return state.loading.zoning;
  }
  async function loadDNR() {
    if (state.loading.dnr) return state.loading.dnr;
    state.loading.dnr = (async () => { setLoading('dnr', true);
      const d = await arcgis(DNR_HYDRO, Object.assign({ outFields: 'WC_GNIS_NM,FP_WTRTY_CD,WC_PERIOD_LABEL_NM', resultRecordCount: 1000 }, GEN)).catch(e => { console.warn('DNR hydro failed', e); return null; });
      if (d) { d.features.forEach(f => { const p = f.properties; p.label = (p.WC_GNIS_NM ? titleCase(p.WC_GNIS_NM) + ' ' : '') + 'Type ' + (p.FP_WTRTY_CD || '?'); }); state.dnr = d; }
      if (styleReady) addLayers(); setLoading('dnr', false); })();
    return state.loading.dnr;
  }
  async function loadFlood() {
    if (state.loading.flood) return state.loading.flood;
    state.loading.flood = (async () => { setLoading('flood', true);
      const f = await arcgis(COUNTY_FLOOD, Object.assign({ outFields: 'zone,floodway,sfha', where: "zone <> 'X'" }, GEN)).catch(e => { console.warn('County flood failed', e); return null; });
      if (f) state.flood = f; if (styleReady) addLayers(); setLoading('flood', false); })();
    return state.loading.flood;
  }

  function allStreamLines() {
    const parts = [];
    for (const f of state.streams.features) { const g = f.geometry; if (!g) continue;
      if (g.type === 'LineString' && g.coordinates.length > 1) parts.push(g.coordinates);
      else if (g.type === 'MultiLineString') g.coordinates.forEach(c => { if (c.length > 1) parts.push(c); }); }
    return turf.multiLineString(parts);
  }
  // 35/50/75/150-ft comparison bands: turf.buffer on the City's 61 centerline segments, dissolved. Runs after first paint.
  function computeComparisonBuffers() {
    const todo = WIDTHS.filter(w => w !== 100 && !state.buffers[w]);
    const step = () => {
      const w = todo.shift(); if (w == null) return;
      try {
        let fc;
        try { const b = turf.buffer(allStreamLines(), w * 0.3048, { units: 'meters' }); fc = turf.featureCollection([b]); }
        catch (e) { console.warn('dissolved buffer ' + w + ' ft failed; using per-segment polygons', e); fc = turf.buffer(state.streams, w * 0.3048, { units: 'meters' }); }
        fc.features.forEach(f => { f.properties = { buffer_ft: w, source: COMPUTED_LABEL }; });
        state.buffers[w] = fc; state.bufferSource[w] = 'comparison width, ' + COMPUTED_LABEL;
        const b = document.querySelector('#widths button[data-w="' + w + '"]'); if (b) b.disabled = false;
        if (styleReady) addLayers();
        if (state.wantW === w) setWidth(w);
      } catch (e) { console.warn('buffer ' + w + ' ft failed', e); }
      setTimeout(step, 0);
    };
    setTimeout(step, 50);
  }

  function renderStatic() {
    const c = state.content; const disc = (c && c.disclaimer) || DEFAULT_DISCLAIMER;
    $('disclaimerModal').textContent = disc; $('disclaimerFooter').textContent = disc;
    if (c && c.about_data) $('aboutData').innerHTML = '<b>About the data:</b> ' + esc(c.about_data.streams_source) + (c.about_data.streams_date ? ' (' + esc(c.about_data.streams_date) + ')' : '') + '. ' + esc(c.about_data.method) +
      (DEMO ? '' : ' Layers are read live from the City’s, County’s and DNR’s public map services each time this page loads; nothing is copied to this site.');
    renderStats();
    if (c && c.ask) { const a = c.ask; $('ask').hidden = false; const mail = a.email_to ? 'mailto:' + encodeURIComponent(a.email_to) + '?subject=' + encodeURIComponent(a.email_subject || '') + '&body=' + encodeURIComponent(a.email_body || '') : null;
      $('ask').innerHTML = '<h3>' + esc(a.headline) + '</h3><p>' + esc(a.body) + '</p><div class="actions">' + (mail ? '<a class="btn primary" href="' + mail + '">Email the City Council</a>' : '<span class="btn" title="Council email address not yet configured">Email the City Council (coming)</span>') + '<button class="btn" id="share" type="button">Copy link to this view</button><button class="btn" type="button" onclick="window.print()">Print</button></div>';
      $('share').onclick = async () => { syncURL(); try { await navigator.clipboard.writeText(location.href); toast('Link copied'); } catch { prompt('Copy this link', location.href); } }; }
  }
  function renderStats() {
    const s = state.stats; if (!s) return; const el = $('stats'); el.hidden = false;
    const bw = s.by_width && s.by_width[String(state.w)];
    const acres = bw ? bw.acres : (state.w === 100 ? s.buffer_acres_city : null);
    const parcels = bw ? bw.parcels : (state.w === 100 ? s.parcels_touched : null);
    const k = s.consultant; const prev = el._vals || {};
    el.innerHTML = stat(s.stream_miles_city, 'mapped stream miles in city', 1, 0) + stat(acres, 'acres in ' + state.w + ' ft band', 0, 1) + stat(parcels, 'city parcels touched (' + state.w + ' ft)', 0, 2) +
      '<div class="statnote">Source: ' + esc(s.source || '') + (s.method_url ? ' · <a href="' + esc(s.method_url) + '" target="_blank" rel="noopener">how we computed this</a>' : '') + ' \u00b7 <a href="impact.html">Walla Walla impact: see the charts</a></div>' +
      (k ? '<div class="statnote">' + esc(k.label) + ': buffer area <b>' + fmt(k.acres_today, 1) + ' → ' + fmt(k.acres_proposed, 1) + ' acres</b> on ' + fmt(k.stream_miles, 1) + ' stream miles (' + fmt(k.open_miles, 1) + ' open + ' + fmt(k.piped_miles, 1) + ' piped). ' + esc(k.note || '') + '</div>' : '');
    const bs = Array.from(el.querySelectorAll('.stat b[data-v]')); el._vals = {}; bs.forEach(b => el._vals[b.dataset.i] = +b.dataset.v);
    if (RM) { el._shown = true; return; }
    if (!el._shown) { // first reveal: count up from 0 (800 ms, ease-out), once per page load, when the strip is on screen and the disclaimer is gone
      bs.forEach(b => b.textContent = fmt(0, +b.dataset.d));
      if (!el._armed) { el._armed = true;
        const land = (animate) => { if (el._shown) return; el._shown = true; el.querySelectorAll('.stat b[data-v]').forEach(b => animate ? tween(b, 0, +b.dataset.v, +b.dataset.d, 800) : (b.textContent = fmt(+b.dataset.v, +b.dataset.d))); };
        onVisible(el, () => afterIntro(() => land(true)));
        afterIntro(() => setTimeout(() => land(false), 4000)); } // strip still below the fold after 4 s: show the real numbers without the count-up
      return;
    }
    bs.forEach(b => { if (prev[b.dataset.i] != null) tween(b, prev[b.dataset.i], +b.dataset.v, +b.dataset.d, 500); }); // width toggle: numbers tween to the new value
  }
  const stat = (v, l, d, i) => '<div class="stat"><b' + (v == null ? '' : ' data-v="' + Number(v) + '" data-d="' + (d || 0) + '" data-i="' + i + '"') + '>' + (v == null ? '—' : fmt(v, d || 0)) + '</b><span>' + esc(l) + '</span></div>';
  const DEFAULT_DISCLAIMER = 'This map is a community awareness tool, not an official determination. Stream lines and the buffer band are drawn from publicly available GIS data. The City\'s proposed ordinance would measure buffers from the ordinary high water mark, so the regulated area may be larger than shown. Only the City of Walla Walla can determine whether a specific property is subject to critical-areas rules. Nothing here is legal advice. Confirm with City of Walla Walla Development Services or a land-use attorney before you buy, sell, build, or decide anything about your property.';

  // ---------- Parcel lookup (Walla Walla County Tax_Parcels, live) ----------
  const SUFFIX = { AVENUE: 'AVE', STREET: 'ST', ROAD: 'RD', DRIVE: 'DR', LANE: 'LN', COURT: 'CT', PLACE: 'PL', BOULEVARD: 'BLVD', CIRCLE: 'CIR', TERRACE: 'TER', HIGHWAY: 'HWY', PARKWAY: 'PKWY', TRAIL: 'TRL' };
  const DIR = { NORTH: 'N', SOUTH: 'S', EAST: 'E', WEST: 'W', NORTHEAST: 'NE', NORTHWEST: 'NW', SOUTHEAST: 'SE', SOUTHWEST: 'SW' };
  const ORD = { FIRST: '1ST', SECOND: '2ND', THIRD: '3RD', FOURTH: '4TH', FIFTH: '5TH', SIXTH: '6TH', SEVENTH: '7TH', EIGHTH: '8TH', NINTH: '9TH', TENTH: '10TH' };
  const SUFFIX_SET = new Set([...Object.values(SUFFIX), 'WAY', 'LOOP', 'AVE', 'ST', 'RD', 'DR', 'LN', 'CT', 'PL', 'BLVD', 'CIR', 'TER', 'HWY', 'PKWY', 'TRL']);
  const DIR_SET = new Set(Object.values(DIR));
  const UNIT_WORDS = new Set(['APT', 'UNIT', 'STE', 'SUITE', '#', 'SPC', 'SPACE', 'LOT', 'TRLR', 'BLDG']);
  function normalizeAddress(q) {
    let t = q.toUpperCase().split(',')[0].replace(/[.#]/g, m => m === '#' ? ' # ' : '').replace(/\s+/g, ' ').trim();
    t = t.replace(/\b(WALLA WALLA|COLLEGE PLACE|WASHINGTON|WA)\b/g, '').replace(/\b\d{5}(-\d{4})?\b$/, '').replace(/\s+/g, ' ').trim();
    const toks = t.split(' ').map(w => SUFFIX[w] || DIR[w] || ORD[w] || w);
    const num = /^\d+[A-Z]?$/.test(toks[0] || '') ? toks.shift() : null;
    const core = []; let unit = false;
    for (const w of toks) { if (unit) continue; if (UNIT_WORDS.has(w)) { unit = true; continue; } if (DIR_SET.has(w) || SUFFIX_SET.has(w)) continue; core.push(w); }
    return { full: (num ? num + ' ' : '') + toks.join(' '), num, core: core.join(' '), first: core[0] || null, raw: t };
  }
  const sq = (s) => String(s).replace(/'/g, "''");
  async function parcelQuery(where, n) {
    const fc = await arcgis(COUNTY_PARCELS, { where, outFields: PARCEL_FIELDS, resultRecordCount: n || 10 });
    return (fc.features || []).filter(f => f.geometry);
  }
  async function findParcel(q) {
    const a = normalizeAddress(q); const wheres = [];
    if (/^\d{12}$/.test(a.raw)) wheres.push("geo_id='" + a.raw + "'");                       // parcel number typed directly
    if (a.full) wheres.push("UPPER(full_situs) LIKE '%" + sq(a.full) + "%'");                 // "420 S 2ND AVE"
    if (a.num && a.core) wheres.push("situs_num='" + sq(a.num) + "' AND UPPER(full_situs) LIKE '%" + sq(a.core) + "%'"); // number + street core, ignores N/S/Ave/St
    if (a.num && a.first && a.first !== a.core) wheres.push("situs_num='" + sq(a.num) + "' AND UPPER(full_situs) LIKE '% " + sq(a.first) + "%'");
    for (const where of wheres) {
      const feats = await parcelQuery(where, 10); if (!feats.length) continue;
      feats.sort((x, y) => { const sx = x.properties.full_situs || '', sy = y.properties.full_situs || '';
        const ex = sx === a.full ? 0 : 1, ey = sy === a.full ? 0 : 1; return ex - ey || sx.length - sy.length || sx.localeCompare(sy); });
      const p = feats[0]; return { parcel: p, count: feats.length, label: (p.properties.full_situs || ('Parcel ' + p.properties.geo_id)) + ' (County parcel ' + p.properties.geo_id + ')', src: 'Walla Walla County parcels' };
    }
    return null;
  }
  async function fetchParcelAt(lnglat) {
    if (DEMO) return null; busy(true);
    try {
      const fc = await arcgis(COUNTY_PARCELS, { geometry: lnglat[0].toFixed(7) + ',' + lnglat[1].toFixed(7), geometryType: 'esriGeometryPoint', inSR: 4326,
        spatialRel: 'esriSpatialRelIntersects', outFields: PARCEL_FIELDS, resultRecordCount: 1 });
      const p = (fc.features || []).find(f => f.geometry) || null;
      if (state.lastPoint === lnglat) evaluate(lnglat, state.lastLabel, p, true);
      return p;
    } catch (e) { console.warn('parcel lookup failed', e); if (state.lastPoint === lnglat) evaluate(lnglat, state.lastLabel, null, true); return null; }
    finally { busy(false); }
  }
  const loadViewportParcels = debounce(async () => {
    if (DEMO || !map.getSource('parcels')) return;
    if (map.getZoom() < PARCEL_ZOOM || !layerOn('parcels')) { map.getSource('parcels').setData(EMPTY); return; }
    const b = map.getBounds(); const seq = (loadViewportParcels.seq = (loadViewportParcels.seq || 0) + 1);
    try {
      const fc = await arcgis(COUNTY_PARCELS, { geometry: [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()].map(v => v.toFixed(6)).join(','), geometryType: 'esriGeometryEnvelope',
        inSR: 4326, spatialRel: 'esriSpatialRelIntersects', outFields: 'geo_id,full_situs', resultRecordCount: 1000 });
      if (seq === loadViewportParcels.seq && map.getSource('parcels')) map.getSource('parcels').setData(fc);
    } catch (e) { console.warn('viewport parcels failed', e); }
  }, 400);
  map.on('moveend', loadViewportParcels);
  map.on('style.load', () => setTimeout(loadViewportParcels, 300));

  // ---------- Geocoding fallback (only when no County parcel matches) ----------
  async function geocodeFallback(q) {
    let text = q.trim(); if (!/walla|college place|wa\b|washington/i.test(text)) text += ', Walla Walla, WA';
    try { // Nominatim, bounded to the valley. OSMF policy: user-triggered searches only, <=1/s, no autocomplete.
      const u = 'https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&bounded=1&viewbox=' + [BBOX.w, BBOX.n, BBOX.e, BBOX.s].join(',') + '&q=' + encodeURIComponent(text);
      const j = await (await fetch(u, { headers: { 'Accept': 'application/json' } })).json(); const m = j && j[0];
      if (m && inBox(+m.lon, +m.lat)) return { lng: +m.lon, lat: +m.lat, label: m.display_name.split(',').slice(0, 3).join(','), src: 'OpenStreetMap Nominatim' };
    } catch (e) { /* fall through */ }
    return null;
  }
  const inBox = (x, y) => x >= BBOX.w && x <= BBOX.e && y >= BBOX.s && y <= BBOX.n;

  // ---------- Jurisdiction ----------
  // The City's limit layer is a set of closed rings (outer boundary, exclaves, unincorporated islands). A point is inside the
  // city when an odd number of rings contain it (even-odd rule). Polygon layers (demo) are tested directly.
  function buildCityRings() {
    const rings = [];
    for (const f of (state.city && state.city.features) || []) {
      const g = f.geometry; if (!g) continue;
      if (g.type === 'Polygon' || g.type === 'MultiPolygon') { rings.push({ poly: f, direct: true }); continue; }
      const lines = g.type === 'LineString' ? [g.coordinates] : g.type === 'MultiLineString' ? g.coordinates : [];
      for (const c of lines) { if (c.length >= 4 && c[0][0] === c[c.length - 1][0] && c[0][1] === c[c.length - 1][1]) { try { rings.push({ poly: turf.polygon([c]) }); } catch {} } }
    }
    state.cityRings = rings.length ? rings : null;
  }
  function inCity(pt) {
    if (!state.cityRings) return null;
    const direct = state.cityRings.filter(r => r.direct);
    if (direct.length) return direct.some(r => pip(pt, r.poly));
    let n = 0; for (const r of state.cityRings) if (pip(pt, r.poly)) n++;
    return n % 2 === 1;
  }
  function jurisdiction(pt) { // code: ww | cp | othercity | uga | county | null (boundaries not loaded)
    const c = inCity(pt);
    if (c === true) return { code: 'ww', name: 'City of Walla Walla' };
    if (state.cityLimits) for (const f of state.cityLimits.features) if (pip(pt, f)) {
      const n = f.properties.name || '';
      if (/COLLEGE PLACE/i.test(n)) return { code: 'cp', name: 'City of College Place' };
      if (/WALLA WALLA/i.test(n)) return { code: 'ww', name: 'City of Walla Walla' };
      return { code: 'othercity', name: titleCase(n) };
    }
    if (state.uga) for (const f of state.uga.features) if (pip(pt, f)) return { code: 'uga', name: titleCase(f.properties.name) + ' (unincorporated, County rules)' };
    if (c === null && !state.cityLimits) return { code: null, name: null };
    if (c === false && !state.cityLimits) return { code: 'county', name: 'Outside Walla Walla city limits' };
    return { code: 'county', name: 'Unincorporated Walla Walla County' };
  }
  function zoningAt(pt) { if (!state.zoning || !layerOn('zon')) return null; const f = state.zoning.features.find(f => pip(pt, f)); return f ? { code: f.properties.zon_abbrev, name: f.properties.zoning, jur: f.properties.jurisdicti } : null; }
  function jurisLine(j, z) {
    if (!j || !j.name) return '<p class="juris muted">Checking jurisdiction…</p>';
    return '<p class="juris">You are in: <b>' + esc(j.name) + '</b>' + (z ? ' · zoning <b>' + esc(z.code || '') + '</b>' + (z.name ? ' (' + esc(z.name) + ')' : '') : (j.code === 'ww' || j.code === 'cp' ? ' <span class="muted">· city zoning: no public layer</span>' : '')) + '</p>';
  }

  // ---------- Evaluation ----------
  function nearestStream(pt, fc) {
    fc = fc || state.streams; if (!fc) return null; let best = null;
    for (const f of fc.features) {
      const g = f.geometry; if (!g) continue; const lines = g.type === 'LineString' ? [g.coordinates] : g.type === 'MultiLineString' ? g.coordinates : [];
      for (const coords of lines) { if (coords.length < 2) continue; const snap = turf.nearestPointOnLine(turf.lineString(coords), pt, { units: 'meters' });
        if (!best || snap.properties.dist < best.dist) best = { dist: snap.properties.dist, name: (f.properties && (f.properties.label || f.properties.name || f.properties.StreamName || f.properties.GNIS_NAME || f.properties.NAME)) || null, snap, props: f.properties || {} }; }
    }
    return best;
  }
  function insideBuffer(pt, w) { const fc = state.buffers[w]; if (!fc) return false; return fc.features.some(f => f.geometry && pip(pt, f)); }
  function parcelShare(parcel, w) { return parcelShareFC(parcel, state.buffers[w]); }
  function parcelShareFC(parcel, fc) {
    if (!fc || !parcel) return null; const pb = turf.bbox(parcel); let inter = 0;
    for (const f of fc.features) { if (!f.geometry) continue; const bb = turf.bbox(f); if (bb[0] > pb[2] || bb[2] < pb[0] || bb[1] > pb[3] || bb[3] < pb[1]) continue;
      try { const x = turf.intersect(turf.featureCollection([parcel, f])); if (x) inter += turf.area(x); } catch { try { const x = turf.intersect(parcel, f); if (x) inter += turf.area(x); } catch {} } }
    const total = turf.area(parcel); return total > 0 ? { pct: Math.min(100, 100 * inter / total), acres: inter / 4046.8564224, total_acres: total / 4046.8564224 } : null;
  }
  // Distance (ft) from the parcel boundary to the nearest line in fc; 0 if a line crosses the parcel.
  function parcelDistanceFt(parcel, fc) {
    fc = fc || state.streams;
    if (!fc || !parcel || !parcel.geometry) return null;
    try {
      for (const f of fc.features) if (f.geometry && turf.booleanIntersects(f, parcel)) return 0;
      let best = Infinity;
      for (const v of turf.explode(parcel).features) { const ns = nearestStream(v, fc); if (ns && ns.dist < best) best = ns.dist; }
      const outline = turf.polygonToLine(parcel); const rings = outline.type === 'FeatureCollection' ? outline.features : [outline];
      const pb = turf.bbox(parcel); const m = 0.003; // ~250 m search margin
      for (const f of fc.features) { if (!f.geometry) continue; const sb = turf.bbox(f); if (sb[0] > pb[2] + m || sb[2] < pb[0] - m || sb[1] > pb[3] + m || sb[3] < pb[1] - m) continue;
        for (const sp of turf.explode(f).features) for (const ring of rings) { const d = turf.nearestPointOnLine(ring, sp, { units: 'meters' }).properties.dist; if (d < best) best = d; } }
      return isFinite(best) ? best * FT_PER_M : null;
    } catch (e) { console.warn('parcel distance failed', e); return null; }
  }
  function polyEdgeDistanceFt(pt, fc) { // distance (ft) from a point to the nearest polygon edge in fc; 0 when inside
    let best = Infinity, hit = null;
    for (const f of fc.features) { if (!f.geometry) continue;
      if (pip(pt, f)) return { dist: 0, feat: f };
      try { const ol = turf.polygonToLine(f); const lines = ol.type === 'FeatureCollection' ? ol.features : [ol];
        for (const ln of lines) { const d = turf.pointToLineDistance(pt, ln, { units: 'meters' }) * FT_PER_M; if (d < best) { best = d; hit = f; } } } catch {} }
    return isFinite(best) ? { dist: best, feat: hit } : null;
  }
  function setParcelHit(parcel) { const s = map.getSource('parcel-hit'); if (s) s.setData(parcel ? turf.featureCollection([parcel]) : EMPTY); }
  const parcelLine = (pp) => 'Parcel <b>' + esc(pp.geo_id || '') + '</b>' + (pp.full_situs ? ' (' + esc(pp.full_situs) + ')' : '');
  // The County layer's `link` field points at a retired server (http://174.127.153.107, times out). Build the record URL on the
  // County's live Property Search host from prop_id, keeping the tax year the layer supplies (2026-10-12).
  const ASSESSOR = 'https://propertysearch.co.walla-walla.wa.us/PropertyAccess/Property.aspx';
  const assessorHref = (pp) => {
    const raw = String(pp.link || ''), id = String(pp.prop_id || (raw.match(/[?&]prop_id=(\d+)/) || [])[1] || '');
    const year = (raw.match(/[?&]year=(\d{4})/) || [])[1] || '2025';
    return /^\d+$/.test(id) ? ASSESSOR + '?cid=0&year=' + year + '&prop_id=' + id : '';
  };
  const assessorLink = (pp) => { const h = assessorHref(pp); return h ? '<a href="' + esc(h) + '" target="_blank" rel="noopener">County Assessor record ↗</a>. ' : ''; };
  const lookingUp = (parcelResolved) => (!DEMO && !parcelResolved ? '<span class="muted lookup"><i class="dot"></i>Looking up the County parcel at this point…</span>' : '');

  function evaluate(lnglat, label, parcel, parcelResolved) {
    state.lastPoint = lnglat; state.lastLabel = label; state.lastParcel = parcel || null; setParcelHit(state.lastParcel);
    const pt = turf.point(lnglat); const w = state.w; const r = $('result'); skeleton(false); r.classList.remove('hidden'); const key = lnglat.join(',');
    const pp = parcel ? parcel.properties || {} : {};
    const jur = jurisdiction(pt); const zone = zoningAt(pt); const head = jurisLine(jur, zone);
    const zoomBtn = (z) => '<div class="actions"><button class="btn" type="button" id="zoomTo">Zoom here</button></div>';
    const finish = (cls, faq, withMill) => { $('zoomTo').onclick = () => map.flyTo({ center: lnglat, zoom: 17, curve: 1.4 }); renderLimits(cls); renderFAQ(faq, withMill); syncURL(); pulseAsk(); };
    if (!state.buffers[w] || !state.streams) { revealCard(r, '', key); r.innerHTML = '<p class="status">Map data not loaded</p><p class="detail">' + (DEMO ? 'Demo data missing.' : 'The City’s live GIS service is not responding right now. Please try again in a minute.') + '</p>'; return; }

    // --- College Place (own code; no public buffer layer) and other incorporated cities
    if (jur.code === 'cp' || jur.code === 'othercity') {
      const cc = (state.content && state.content.college_place) || {};
      const cn = state.countyStreams ? nearestStream(pt, state.countyStreams) : null;
      revealCard(r, 'college_place', key);
      r.innerHTML = head + '<p class="status">' + esc(jur.code === 'cp' ? (cc.headline || 'This address is inside the City of College Place.') : 'This address is inside the ' + jur.name + '.') + '</p>' +
        '<p class="detail">' + esc(jur.code === 'cp' ? (cc.summary || '') : jur.name + ' has its own code; the City of Walla Walla’s proposed ordinance does not apply here and we have no buffer layer for it.') + '</p>' +
        '<p class="meta">' + (label ? '<b>' + esc(label) + '</b><br>' : '') + (parcel ? parcelLine(pp) + '. ' + assessorLink(pp) : lookingUp(parcelResolved)) +
        (cn ? 'Nearest County-mapped stream: <b>' + esc(cn.name || 'unnamed') + '</b>, about <b>' + fmt(cn.dist * FT_PER_M) + ' ft</b> (orientation only). ' : '') + '</p>' + zoomBtn();
      finish('college_place', jur.code === 'cp' ? 'college_place' : 'outside_city'); return;
    }
    // --- Outside city limits: the County's working buffer (or the plain outside-city card until it loads)
    if (jur.code === 'uga' || jur.code === 'county') {
      if (state.countyBuf && layerOn('cbuf')) {
        const cb = state.countyBuf; const cc = (state.content && state.content.county) || {};
        const hits = cb.features.filter(f => pip(pt, f));
        const edge = hits.length ? { dist: 0, feat: hits[0] } : polyEdgeDistanceFt(pt, cb);
        const share = parcel ? parcelShareFC(parcel, cb) : null;
        const pDist = parcel ? (function () { let b = Infinity; for (const v of turf.explode(parcel).features) { const e = polyEdgeDistanceFt(v, cb); if (e && e.dist < b) b = e.dist; } return isFinite(b) ? b : null; })() : null;
        const cInside = hits.length > 0 || (share && share.pct > 0.05) || (pDist != null && pDist <= 0.5);
        const d = parcel && pDist != null ? pDist : (edge ? edge.dist : null);
        const sub = cInside ? 'inside' : (d != null && d <= NEAR_FT ? 'near' : 'outside');
        const reach = (hits[0] || (edge && edge.feat) || {}).properties || {};
        const cn = state.countyStreams ? nearestStream(pt, state.countyStreams) : null;
        const paras = (cc.summary || '').split('\n\n');
        revealCard(r, 'county c-' + sub, key);
        r.innerHTML = head + '<p class="status">' + esc(cc.headline || 'This address is outside city limits. The County’s working buffer is shown.') + '</p>' +
          '<p class="detail">' + esc(paras[0] || '') + '</p>' +
          '<p class="meta">' + (label ? '<b>' + esc(label) + '</b><br>' : '') +
          '<b>' + ({ inside: 'Inside the County’s working buffer', near: 'Just outside the County’s working buffer', outside: 'Outside the County’s working buffer' })[sub] + '</b>' +
          (reach.buff_dist ? ' — the County band here is <b>' + fmt(reach.buff_dist) + ' ft</b>' + (reach.label ? ' (' + esc(reach.label) + ' reach)' : '') + '. ' : '. ') +
          (!cInside && d != null ? 'The County band edge is about <b>' + fmt(d) + ' ft</b> away. ' : '') +
          (cn ? 'Nearest County-mapped stream: <b>' + esc(cn.name || 'unnamed') + '</b>, about <b>' + fmt(cn.dist * FT_PER_M) + ' ft</b> from the point checked. ' : '') +
          (parcel ? parcelLine(pp) + ': ' + (share ? (share.pct > 0.05 ? '<b>' + fmt(share.pct, share.pct < 10 ? 1 : 0) + '%</b> of its ' + fmt(share.total_acres, 2) + ' acres falls inside the County band. ' : 'none of its ' + fmt(share.total_acres, 2) + ' acres falls inside the County band. ') : '') + assessorLink(pp) : lookingUp(parcelResolved)) +
          '<br><span class="muted">County widths are fixed per reach (35–100 ft); the width buttons above change only the City band.</span></p>' +
          (paras[1] ? '<p class="detail muted" style="font-size:12.5px">' + esc(paras[1]) + '</p>' : '') + zoomBtn();
        finish('county', 'county'); return;
      }
      const oc = (state.content && state.content.outside_city) || {};
      revealCard(r, 'outside_city', key);
      r.innerHTML = head + '<p class="status">' + esc(oc.headline || 'This address is outside Walla Walla city limits.') + '</p>' +
        '<p class="detail">' + esc(oc.summary || 'The City’s proposed ordinance applies inside city limits, and the City’s stream map stops at the boundary.') + '</p>' +
        '<p class="meta">' + (label ? '<b>' + esc(label) + '</b><br>' : '') + (parcel ? parcelLine(pp) + ' is in unincorporated Walla Walla County. ' + assessorLink(pp) : lookingUp(parcelResolved)) +
        (!DEMO && !layerOn('cbuf') ? '<span class="muted">Turn on “County working buffer” in Layers to test this point against the County’s layer.</span>' : '<span class="muted lookup"><i class="dot"></i>Loading the County’s working buffer layer…</span>') + '</p>' + zoomBtn();
      finish('outside_city', 'outside_city'); return;
    }

    // --- Inside the City of Walla Walla (or jurisdiction unknown): the proposed CAO band
    const ns = nearestStream(pt); const ptDistFt = ns ? ns.dist * FT_PER_M : null; const ptInside = insideBuffer(pt, w);
    const share = parcel ? parcelShare(parcel, w) : null; const pDist = parcel ? parcelDistanceFt(parcel) : null;
    let inside, distFt; // Classification: by the parcel when we have one (does any part of the lot fall in the band?), else by the point.
    if (parcel && pDist != null) { distFt = pDist; inside = pDist <= w || (share && share.pct > 0.05); }
    else { distFt = ptDistFt; inside = ptInside; }
    const edgeFt = distFt == null ? null : distFt - w;
    const cls = inside ? 'inside' : (edgeFt != null && edgeFt <= NEAR_FT ? 'near' : 'outside');
    const uncertain = !inside && distFt != null && distFt > w && distFt <= UNCERTAIN_FT;
    const c = (state.content && state.content[cls]) || {};
    // Mill Creek (Shoreline Master Program): when it is the nearest stream, say so and report SMP distances instead of the CAO band.
    let millNote = '';
    if (state.mill && layerOn('mill')) {
      const mDist = parcel ? parcelDistanceFt(parcel, state.mill) : (function () { const nm = nearestStream(pt, state.mill); return nm ? nm.dist * FT_PER_M : null; })();
      if (mDist != null && mDist <= 300 && (distFt == null || mDist < distFt)) {
        const mc = (state.content && state.content.millcreek) || {};
        const inBand = !!(state.millBand && (parcel ? (parcelShareFC(parcel, state.millBand) || {}).pct > 0.05 : state.millBand.features.some(f => pip(pt, f))));
        millNote = '<p class="millnote"><b>Nearest stream: Mill Creek, about ' + fmt(mDist) + ' ft away' + (parcel ? ' from the lot line' : '') + '.</b> ' +
          esc(mc.a || 'Mill Creek is regulated under the City’s Shoreline Master Program, not the proposed Critical Areas Ordinance.') +
          ' This ' + (parcel ? 'lot' : 'point') + ' is <b>' + (inBand ? 'inside' : 'outside') + '</b> the SMP 35-ft flood-channel band as drawn and <b>' + (mDist <= SHORELINE_FT ? 'inside' : 'outside') + '</b> the approximate 200-ft shoreline jurisdiction (measured here from the mapped centerline).</p>';
      }
    }
    let gapNote = '';
    if (state.countyGaps && state.countyGaps.features.length) {
      const gn = nearestStream(pt, state.countyGaps); const gd = parcel ? parcelDistanceFt(parcel, state.countyGaps) : (gn ? gn.dist * FT_PER_M : null);
      if (gn && gd != null && gd <= UNCERTAIN_FT) gapNote = '<p class="uncertain">The County maps a reach of <b>' + esc(gn.name || 'a creek') + '</b> about <b>' + fmt(gd) + ' ft</b> from here that the City\u2019s layer does not include; the City\u2019s draft would not buffer it unless the City adds it. Ask Development Services.</p>';
    }
    revealCard(r, cls, key);
    r.innerHTML = head + '<p class="status">' + esc(c.headline || ({ inside: 'Inside the proposed ' + w + '-foot buffer', near: 'Just outside the proposed ' + w + '-foot buffer', outside: 'Outside the proposed ' + w + '-foot buffer' })[cls]) + '</p>' +
      '<p class="detail">' + esc(c.summary || '') + '</p>' +
      '<p class="meta">' + (label ? '<b>' + esc(label) + '</b><br>' : '') +
      (parcel
        ? (parcelLine(pp) + ': ' +
           (pDist != null ? 'its boundary is about <b>' + fmt(pDist) + ' ft</b> from the nearest City-mapped stream' + (ns && ns.name ? ' (<b>' + esc(ns.name) + '</b>)' : '') + '. ' : '') +
           (share ? (share.pct > 0.05 ? '<b>' + fmt(share.pct, share.pct < 10 ? 1 : 0) + '%</b> of its ' + fmt(share.total_acres, 2) + ' acres (' + fmt(share.acres, 2) + ' ac) falls inside the ' + w + '-ft band. ' : 'None of its ' + fmt(share.total_acres, 2) + ' acres falls inside the ' + w + '-ft band. ') : '') +
           (!inside && edgeFt != null ? 'The band edge is about <b>' + fmt(Math.max(0, edgeFt)) + ' ft</b> from the lot line. ' : '') + assessorLink(pp))
        : ((ptDistFt != null ? 'About <b>' + fmt(ptDistFt) + ' ft</b> from the nearest City-mapped stream' + (ns && ns.name ? ' (<b>' + esc(ns.name) + '</b>)' : '') + '. ' : '') +
           (ptInside ? 'This point is <b>' + fmt(Math.max(0, w - ptDistFt)) + ' ft</b> inside the band. ' : (edgeFt != null ? 'The ' + w + '-ft band edge is about <b>' + fmt(Math.max(0, edgeFt)) + ' ft</b> away. ' : '')) +
           (lookingUp(parcelResolved) || (!DEMO ? '<span class="muted">No County tax parcel at this point (street, park, or right-of-way).</span>' : '')))) +
      '</p>' +
      (uncertain ? '<p class="uncertain"><b>Within the 150-ft uncertainty band.</b> This band is drawn from the mapped stream centerline, but the ordinance measures from the ordinary high-water mark, top of bank, or channel migration zone, whichever is greater, so the real buffer edge is likely closer than shown. Treat this property as possibly affected until a site survey says otherwise.</p>' : '') +
      (cls === 'near' && !uncertain ? '<p class="uncertain">The ordinance measures the buffer from the ordinary high-water mark, top of bank, or channel migration zone, not the stream centerline shown here, so the regulated edge may be closer than drawn.</p>' : '') +
      millNote + gapNote + zoomBtn();
    finish(cls, cls, !!millNote);
  }
  function renderLimits(cls) { // "What it would limit on this lot": inside (full) and near (softened); nothing for other states
    const L = state.content && state.content.limits; const el = $('limits'); if (!el) return;
    if (!L || !L.items || !(cls === 'inside' || cls === 'near')) { el.hidden = true; el.innerHTML = ''; return; }
    const tagText = { draft: 'per draft ordinance', typical: 'typical in WA CAOs', unknown: 'not yet confirmed', code: 'per existing city code' };
    el.hidden = false;
    el.innerHTML = '<h3>' + esc(cls === 'near' ? (L.near_title || 'Just outside as mapped: what it would limit if the line moves') : L.title) + '</h3>' +
      (cls === 'near' ? '<p class="lead">' + esc(L.near_lead || '') + '</p>' : '') +
      '<ul>' + L.items.map(i => '<li>' + esc(i.text) + '<span class="tag ' + esc(i.basis || '') + '">' + esc(tagText[i.basis] || i.basis || '') + '</span></li>').join('') + '</ul>';
  }
  function renderFAQ(cls, withMill) {
    const c = state.content && state.content[cls]; const el = $('faq'); if (!c || !c.items) { el.innerHTML = ''; el.dataset.cls = ''; return; }
    const sig = cls + (withMill ? '+mill' : '');
    if (el.dataset.cls === sig && el.childElementCount) return; // same state (width toggle, parcel resolve): keep the list, and any open item, as is
    el.dataset.cls = sig;
    const tagText = { draft: 'per draft ordinance', typical: 'typical in WA CAOs', unknown: 'not yet confirmed', code: 'per existing city code' };
    const items = (withMill && state.content.millcreek ? [state.content.millcreek] : []).concat(c.items);
    el.innerHTML = '<h3 class="faq-h">What this would mean</h3>' + items.map((i, n) => '<details class="faq" style="--i:' + (n + 1) + '"><summary><span class="q">' + esc(i.q) + '</span><span class="tag ' + esc(i.basis || '') + '">' + esc(tagText[i.basis] || i.basis || '') + '</span></summary><p>' + esc(i.a) + '</p></details>').join('');
  }
  function placeMarker(lnglat) { // custom marker element: the pin drops with a short bounce, a halo pulses at the point (CSS)
    if (state.marker) state.marker.remove();
    const el = document.createElement('div'); el.className = 'pin-wrap'; el.innerHTML = '<span class="pin-halo"></span><span class="pin-drop"><span class="pin"></span></span>';
    state.marker = new maplibregl.Marker({ element: el, anchor: 'bottom' }).setLngLat(lnglat).addTo(map);
  }

  // ---------- Events ----------
  $('searchForm').addEventListener('submit', async (e) => {
    e.preventDefault(); const q = $('q').value.trim(); if (!q) return; const btn = $('go');
    if (!homing.done || homing.pending || /^\d{5}$/.test(q)) { /* 2026-10-12 landing hook: a ZIP search takes the county → ZIP sequence (non-county ZIPs stop there); addresses go straight to the lot */ btn.disabled = true; try { await runHoming(q); } catch (err) { console.warn('homing failed', err); finishHoming(); } finally { btn.disabled = false; } return; }
    btn.disabled = true; btn.textContent = '…'; $('hint').textContent = 'Looking up the County parcel…';
    busy(true); skeleton(true);
    try {
      let found = null;
      if (!DEMO) { try { found = await findParcel(q); } catch (err) { console.warn('parcel search failed', err); } }
      if (found) {
        const p = turf.pointOnFeature(found.parcel).geometry.coordinates;
        $('hint').textContent = 'Matched County parcel ' + (found.parcel.properties.full_situs || found.parcel.properties.geo_id) + (found.count > 1 ? ' (' + found.count + ' parcels matched; showing the closest match)' : '') + '. Not your lot? Tap it on the map.';
        placeMarker(p); map.flyTo({ center: p, zoom: 17, curve: 1.4 }); evaluate(p, found.label, found.parcel, true);
        try { if (window.ccSend) { const ns0 = state.streams ? nearestStream(p, state.streams) : null; window.ccSend('lot', ns0 && ns0.name ? ns0.name : ''); } } catch (_) {} // 2026-10-12 public counter (research/12)
        return;
      }
      const g = await geocodeFallback(q);
      if (!g) { $('hint').textContent = 'No County parcel matched that address. Try "123 S 2nd Ave" (number + street name), or tap your lot on the map.'; return; }
      $('hint').textContent = 'No parcel matched; located via ' + g.src + '. Tap your lot on the map if the pin is off.';
      const p = [g.lng, g.lat]; placeMarker(p); map.flyTo({ center: p, zoom: 16.5, curve: 1.4 }); evaluate(p, g.label, null); fetchParcelAt(p);
    } finally { btn.disabled = false; btn.textContent = 'Check'; busy(false); skeleton(false); }
  });
  map.on('click', (e) => { const p = [e.lngLat.lng, e.lngLat.lat]; placeMarker(p); if (map.getZoom() < 15) map.flyTo({ center: p, zoom: 16, curve: 1.4 }); evaluate(p, 'Tapped location', null); fetchParcelAt(p); });
  map.on('moveend', syncURL);
  if ($('layersBtn')) $('layersBtn').onclick = () => toggleLayersPanel();

  // ---------- Honing-in entry sequence (first visit: ZIP or address → county → rules → ZIP → lot → measurement) ----------
  const sleep = (ms) => new Promise(r => setTimeout(r, (homing.skip || RMX) ? 0 : ms));
  function flyAsync(opts, ms) { // resolve when the camera settles (or at once when skipping / reduced motion)
    return new Promise(res => {
      const instant = homing.skip || RMX; let done = false; const fin = () => { if (!done) { done = true; res(); } };
      if (!instant) { map.once('moveend', fin); setTimeout(fin, (ms || 1600) + 400); }
      try { if (opts.bounds) map.fitBounds(opts.bounds, { padding: opts.padding || 40, duration: instant ? 0 : (ms || 1600), easing: t => 1 - Math.pow(1 - t, 3) });
            else map.flyTo({ center: opts.center, zoom: opts.zoom, duration: instant ? 0 : (ms || 1600), curve: 1.3 }); } catch (e) { console.warn(e); }
      if (instant) setTimeout(fin, 0);
    });
  }
  function setStep(step, status, cap) {
    const li = document.querySelector('#stepper li[data-step="' + step + '"]'); if (!li) return;
    li.classList.remove('active', 'done'); if (status) li.classList.add(status);
    if (cap != null) { const c = li.querySelector('.cap'); if (c) c.textContent = cap; }
  }
  function lineOpacity(id, v, ms) { if (!map.getLayer(id)) return; map.setPaintProperty(id, 'line-opacity-transition', { duration: (homing.skip || RMX) ? 0 : ms }); map.setPaintProperty(id, 'line-opacity', v); }
  const bboxCenter = (b) => [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2];
  const JURIS_CAP = { ww: 'Inside the City of Walla Walla: the proposed ordinance applies here', cp: 'Inside the City of College Place: College Place’s own code applies',
                      uga: 'Walla Walla UGA (unincorporated): County rules apply', county: 'Unincorporated county: County rules apply' };
  async function runHoming(q) {
    const st = $('stepper'); st.classList.remove('hidden'); html.classList.add('homing'); homing.active = true; homing.skip = false; busy(true);
    $('skipIntro').onclick = (e) => { e.preventDefault(); homing.skip = true; };
    const zipOnly = /^\d{5}$/.test(q); let zip = zipOnly ? q : ((q.match(/\b(\d{5})\b/) || [])[1] || null);
    let found = null;
    if (!homing.pending) {
      if (!zipOnly) { $('hint').textContent = 'Looking up the County parcel…'; try { found = await findParcel(q); } catch (e) { console.warn(e); } if (found && !zip) zip = found.parcel.properties.situs_zip || null; }
      const target = found ? turf.pointOnFeature(found.parcel).geometry.coordinates : (zip && ZIPS[zip] ? (ZIPS[zip].pt || bboxCenter(ZIPS[zip].bbox)) : null); // ZIP: a representative in-town point (ZIP areas cross city limits)
      // 1. county
      setStep('county', 'active'); $('hint').textContent = '';
      const cl = loadCountyLine(); await flyAsync({ bounds: COUNTY_BBOX, padding: 30 }, 1700); await cl; lineOpacity('county-line', 0.8, 700); await sleep(500);
      setStep('county', 'done');
      // 2. rules
      setStep('rules', 'active'); await loadBoundaries();
      ['city-line', 'cp-line', 'uga-line'].forEach(id => lineOpacity(id, 0, 0));
      for (const [i, id] of ['city-line', 'cp-line', 'uga-line'].entries()) { await sleep(i ? 450 : 150); lineOpacity(id, i === 0 ? 1 : 0.9, 600); }
      const j = target ? jurisdiction(turf.point(target)) : null;
      setStep('rules', 'active', j && j.code && JURIS_CAP[j.code] ? JURIS_CAP[j.code] : (j && j.name ? j.name : 'Three sets of rules: City of Walla Walla, College Place, and the County'));
      await sleep(900); setStep('rules', 'done');
      // 3. ZIP
      if (zip && ZIPS[zip]) { $('stepZip').textContent = 'Zooming to ZIP ' + zip + ' (' + ZIPS[zip].name + ')'; setStep('zip', 'active'); await flyAsync({ bounds: ZIPS[zip].bbox, padding: 30 }, 1500); setStep('zip', 'done'); }
      else if (zip) { // a WA ZIP outside the county: Nominatim postal lookup, then stop
        $('stepZip').textContent = 'Zooming to ZIP ' + zip; setStep('zip', 'active');
        let hit = null; try { const j2 = await (await fetch('https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&postalcode=' + encodeURIComponent(zip) + '&countrycodes=us&viewbox=-124.9,49.1,-116.9,45.5&bounded=1', { headers: { Accept: 'application/json' } })).json(); hit = j2 && j2[0]; } catch (e) { console.warn(e); }
        if (hit) { const bb = hit.boundingbox.map(Number); await flyAsync({ bounds: [bb[2], bb[0], bb[3], bb[1]], padding: 30 }, 1500); }
        setStep('zip', 'done', hit ? 'CreekChecker covers Walla Walla County today; statewide is next.' : 'ZIP not found in Washington. CreekChecker covers Walla Walla County today.');
        $('hint').textContent = 'CreekChecker covers Walla Walla County today; statewide is next. Try a Walla Walla County address or ZIP.';
        finishHoming(); return;
      } else { $('stepZip').textContent = 'ZIP skipped'; setStep('zip', 'done'); }
      if (zipOnly) { homing.pending = true; busy(false); $('q').value = ''; $('q').placeholder = 'Now your street address'; $('hint').textContent = 'Now your street address (e.g. 123 S Division St).'; $('go').textContent = 'Find out'; $('q').focus(); return; }
    } else { // second submit after a ZIP: continue with the lot
      homing.pending = false; $('hint').textContent = 'Looking up the County parcel…'; try { found = await findParcel(q); } catch (e) { console.warn(e); }
    }
    // 4. lot
    setStep('lot', 'active'); let p, label, parcel = null;
    if (found) { p = turf.pointOnFeature(found.parcel).geometry.coordinates; label = found.label; parcel = found.parcel; $('hint').textContent = 'Matched County parcel ' + (found.parcel.properties.full_situs || found.parcel.properties.geo_id) + '. Not your lot? Tap it on the map.'; }
    else { const g = await geocodeFallback(q); if (!g) { setStep('lot', 'active', 'No County parcel matched that address.'); $('hint').textContent = 'No County parcel matched that address. Try "123 S 2nd Ave" (number + street name), or tap your lot on the map.'; finishHoming(); return; }
           p = [g.lng, g.lat]; label = g.label; $('hint').textContent = 'No parcel matched; located via ' + g.src + '. Tap your lot on the map if the pin is off.'; }
    await flyAsync({ center: p, zoom: 16.5 }, 1800); placeMarker(p); if (parcel) setParcelHit(parcel); await sleep(500); setStep('lot', 'done');
    // 5. measure
    setStep('measure', 'active'); await sleep(600);
    evaluate(p, label, parcel, !!parcel); if (!parcel) fetchParcelAt(p);
    setStep('measure', 'done'); finishHoming();
  }
  function finishHoming() {
    homing.done = true; homing.active = false; homing.pending = false; busy(false); lsSet('ww_homed', '1');
    html.classList.remove('homing'); $('go').textContent = 'Check'; $('q').placeholder = 'e.g. 123 S Division St';
    $('subline').textContent = 'City of Walla Walla Critical Areas Ordinance update. Type an address or tap the map.';
    ['county-line', 'city-line', 'cp-line', 'uga-line'].forEach(id => { if (map.getLayer(id)) lineOpacity(id, id === 'county-line' ? 0.8 : (id === 'city-line' ? 1 : 0.9), 0); });
    setTimeout(() => $('stepper').classList.add('hidden'), (RMX ? 0 : 2500));
  }

  // ---------- Disclaimer modal → intro ----------
  function closeModal() { const m = $('modal'); if (RM) m.classList.add('hidden'); else { m.classList.add('closing'); setTimeout(() => m.classList.add('hidden'), 320); } runIntro(); }
  if (lsGet('ww_cao_ack') === '1') { $('modal').classList.add('hidden'); runIntro(); }
  else if (html.classList.contains('no-gate')) runIntro(); // 2026-10-12 landing hook: the disclaimer is a non-blocking notice on the landing page, so the band shows at once; "Got it" still records the acknowledgement
  $('agree').onclick = () => { lsSet('ww_cao_ack', '1'); closeModal(); };

  loadData();
})();
