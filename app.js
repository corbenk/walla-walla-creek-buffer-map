/* Walla Walla "Am I in the buffer?" — static app. No backend.
   Stream centerlines, the City's 100-ft buffer polygon, and the city limit line are read LIVE from the City of Walla Walla's
   public ArcGIS feature service; parcels are read LIVE (one parcel at a time) from Walla Walla County's public parcel service.
   No City or County geometry is re-hosted on this site. See ../README.md for URLs, fields, and content schemas. */
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

  // Live public services (both answer with Access-Control-Allow-Origin: *). Documented in README.md.
  const CITY_FS = 'https://services1.arcgis.com/F8n8WJgK0mEjXgtm/arcgis/rest/services/WW_Streams_Riparian_Buffer/FeatureServer';
  const COUNTY_PARCELS = 'https://services8.arcgis.com/COL6rRPkF9w28VGX/ArcGIS/rest/services/Tax_Parcels/FeatureServer/0';
  const PARCEL_FIELDS = 'geo_id,prop_id,full_situs,situs_num,situs_city,situs_zip,size_acres,link';
  const CITY_LABEL = 'City of Walla Walla GIS, Oct 6 2026';
  const COMPUTED_LABEL = 'computed in your browser from the City’s stream centerlines (' + CITY_LABEL + ')';

  const state = { w: Number(params.get('w')) || 100, wantW: null, streams: null, buffers: {}, bufferSource: {}, city: null,
                  content: null, stats: null, marker: null, lastPoint: null, lastLabel: null, lastParcel: null };

  // ---------- Helpers ----------
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const fmt = (n, d = 0) => Number(n).toLocaleString(undefined, { maximumFractionDigits: d });
  const qs = (o) => Object.entries(o).map(([k, v]) => encodeURIComponent(k) + '=' + encodeURIComponent(v)).join('&');
  const EMPTY = { type: 'FeatureCollection', features: [] };
  async function getJSON(url, opts) { const r = await fetch(url, opts || { cache: 'no-cache' }); if (!r.ok) throw new Error(url + ' ' + r.status); return r.json(); }
  async function arcgis(layerUrl, extra) {
    const url = layerUrl + '/query?' + qs(Object.assign({ where: '1=1', outFields: '*', f: 'geojson', outSR: 4326, returnGeometry: true }, extra || {}));
    const r = await fetch(url); if (!r.ok) throw new Error('HTTP ' + r.status + ' from ' + layerUrl);
    const j = await r.json(); if (j && j.error) throw new Error('ArcGIS error ' + JSON.stringify(j.error)); return j;
  }
  function banner(msg) { const b = $('banner'); if (!msg) { b.classList.add('hidden'); return; } b.textContent = msg; b.classList.remove('hidden'); }
  function lsGet(k) { try { return localStorage.getItem(k); } catch { return null; } }
  function lsSet(k, v) { try { localStorage.setItem(k, v); } catch {} }
  const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };

  // ---------- Map ----------
  const rasterFallback = { version: 8, sources: { osm: { type: 'raster', tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'], tileSize: 256,
    attribution: '&copy; OpenStreetMap contributors' } }, layers: [{ id: 'osm', type: 'raster', source: 'osm' }] };
  const map = new maplibregl.Map({
    container: 'map',
    style: 'https://tiles.openfreemap.org/styles/liberty',
    center: [Number(params.get('lng')) || CENTER[0], Number(params.get('lat')) || CENTER[1]],
    zoom: Number(params.get('z')) || 12.6,
    attributionControl: true
  });
  map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
  map.addControl(new maplibregl.GeolocateControl({ positionOptions: { enableHighAccuracy: true }, trackUserLocation: false }), 'top-right');
  map.on('error', (e) => { // style failed → raster fallback
    if (e && e.error && /style|tiles.openfreemap/i.test(String(e.error.message || e.error))) { try { map.setStyle(rasterFallback); } catch {} }
  });

  function addLayers() {
    if (state.city && !map.getSource('city')) {
      map.addSource('city', { type: 'geojson', data: state.city, attribution: DEMO ? '' : 'City limit: City of Walla Walla GIS' });
      map.addLayer({ id: 'city-line', type: 'line', source: 'city', paint: { 'line-color': '#333', 'line-width': 2, 'line-dasharray': [3, 2] } });
    }
    WIDTHS.forEach(w => {
      const fc = state.buffers[w]; if (!fc || map.getSource('buf' + w)) return;
      map.addSource('buf' + w, { type: 'geojson', data: fc, attribution: (!DEMO && w === 100) ? '100-ft buffer: City of Walla Walla GIS (2026-10-06)' : '' });
      map.addLayer({ id: 'buf' + w + '-fill', type: 'fill', source: 'buf' + w, layout: { visibility: w === state.w ? 'visible' : 'none' },
        paint: { 'fill-color': '#b23a2a', 'fill-opacity': 0.35 } });
      map.addLayer({ id: 'buf' + w + '-line', type: 'line', source: 'buf' + w, layout: { visibility: w === state.w ? 'visible' : 'none' },
        paint: { 'line-color': '#b23a2a', 'line-width': 1.2, 'line-opacity': 0.8 } });
    });
    if (state.streams && !map.getSource('streams')) {
      map.addSource('streams', { type: 'geojson', data: state.streams, attribution: DEMO ? 'DEMO data' : 'Streams: City of Walla Walla GIS (2026-10-06)' });
      map.addLayer({ id: 'streams-line', type: 'line', source: 'streams', paint: { 'line-color': '#1d6fb8', 'line-width': ['interpolate', ['linear'], ['zoom'], 10, 1.2, 16, 3.5] } });
      map.addLayer({ id: 'streams-label', type: 'symbol', source: 'streams', minzoom: 13,
        layout: { 'symbol-placement': 'line', 'text-field': ['coalesce', ['get', 'name'], ''], 'text-size': 11, 'text-font': ['Noto Sans Regular'] },
        paint: { 'text-color': '#1d6fb8', 'text-halo-color': '#fff', 'text-halo-width': 1.2 } });
    }
    if (!DEMO && !map.getSource('parcels')) { // live viewport parcels (outline only, zoom >= PARCEL_ZOOM)
      map.addSource('parcels', { type: 'geojson', data: EMPTY, attribution: 'Parcels: Walla Walla County GIS / Assessor' });
      map.addLayer({ id: 'parcels-line', type: 'line', source: 'parcels', minzoom: PARCEL_ZOOM, paint: { 'line-color': '#777', 'line-width': 0.6, 'line-opacity': 0.7 } });
    }
    if (!map.getSource('parcel-hit')) { // the one parcel being checked
      map.addSource('parcel-hit', { type: 'geojson', data: state.lastParcel ? turf.featureCollection([state.lastParcel]) : EMPTY });
      map.addLayer({ id: 'parcel-hit-fill', type: 'fill', source: 'parcel-hit', paint: { 'fill-color': '#ffd166', 'fill-opacity': 0.35 } });
      map.addLayer({ id: 'parcel-hit-line', type: 'line', source: 'parcel-hit', paint: { 'line-color': '#b3741a', 'line-width': 2 } });
    }
  }
  map.on('style.load', addLayers);

  function setWidth(w) {
    if (!state.buffers[w]) { state.wantW = w; return; }
    state.w = w; state.wantW = null; $('legendW').textContent = w; $('legendSrc').textContent = state.bufferSource[w] || '';
    document.querySelectorAll('#widths button').forEach(b => b.classList.toggle('active', Number(b.dataset.w) === w));
    if (map.isStyleLoaded()) WIDTHS.forEach(x => ['-fill', '-line'].forEach(s => { if (map.getLayer('buf' + x + s)) map.setLayoutProperty('buf' + x + s, 'visibility', x === w ? 'visible' : 'none'); }));
    renderStats();
    if (state.lastPoint) evaluate(state.lastPoint, state.lastLabel, state.lastParcel);
    syncURL();
  }
  function syncURL() {
    const p = state.lastPoint; const u = new URL(location.href); u.search = '';
    if (p) { u.searchParams.set('lat', p[1].toFixed(6)); u.searchParams.set('lng', p[0].toFixed(6)); }
    u.searchParams.set('w', state.w); u.searchParams.set('z', map.getZoom().toFixed(1)); if (DEMO) u.searchParams.set('demo', '1');
    history.replaceState(null, '', u.toString());
  }

  // ---------- Data ----------
  async function loadData() {
    const tries = [];
    tries.push(getJSON(DATA + 'stats.json').then(d => state.stats = d).catch(() => null));
    tries.push(getJSON('content/restrictions.json').then(d => state.content = d).catch(() => null));
    if (DEMO) {
      tries.push(getJSON(DATA + 'streams.geojson').then(d => state.streams = d).catch(() => null));
      WIDTHS.forEach(w => tries.push(getJSON(DATA + 'buffer_' + w + '.geojson').then(d => { state.buffers[w] = d; state.bufferSource[w] = 'DEMO data'; }).catch(() => null)));
      tries.push(getJSON(DATA + 'city_limits.geojson').then(d => state.city = d).catch(() => null));
    } else {
      banner('Loading live City of Walla Walla GIS layers…');
      tries.push(arcgis(CITY_FS + '/0', { outFields: 'StreamName,WaterVisible,Intermittent,Subtype,Basin_Name' })
        .then(fc => { fc.features.forEach(f => { f.properties = f.properties || {}; f.properties.name = f.properties.StreamName || null; }); state.streams = fc; })
        .catch(e => console.warn('City streams layer failed', e)));
      tries.push(arcgis(CITY_FS + '/1', { outFields: 'BUFF_DIST,StreamName' })
        .then(fc => { state.buffers[100] = fc; state.bufferSource[100] = CITY_LABEL; })
        .catch(e => console.warn('City buffer layer failed', e)));
      tries.push(arcgis(CITY_FS + '/2', { outFields: 'NAME,LABEL,GIS_ACRES' })
        .then(fc => { fc.features.forEach(f => { f.properties = f.properties || {}; f.properties.name = f.properties.NAME; }); state.city = fc; })
        .catch(e => console.warn('City limit layer failed', e)));
    }
    await Promise.all(tries);

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
    $('legendW').textContent = state.w; $('legendSrc').textContent = state.bufferSource[state.w] || '';
    if (map.isStyleLoaded()) addLayers();
    renderStatic();
    if (!DEMO && state.streams) computeComparisonBuffers();
    if (params.get('lat') && params.get('lng')) { const p = [Number(params.get('lng')), Number(params.get('lat'))]; placeMarker(p); evaluate(p, 'Shared location', null); fetchParcelAt(p); }
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
        // One MultiLineString of all centerlines -> JSTS buffer returns an already-dissolved polygon (no polygon-clipping union needed).
        let fc;
        try { const b = turf.buffer(allStreamLines(), w * 0.3048, { units: 'meters' }); fc = turf.featureCollection([b]); }
        catch (e) { console.warn('dissolved buffer ' + w + ' ft failed; using per-segment polygons', e); fc = turf.buffer(state.streams, w * 0.3048, { units: 'meters' }); }
        fc.features.forEach(f => { f.properties = { buffer_ft: w, source: COMPUTED_LABEL }; });
        state.buffers[w] = fc; state.bufferSource[w] = 'comparison width, ' + COMPUTED_LABEL;
        const b = document.querySelector('#widths button[data-w="' + w + '"]'); if (b) b.disabled = false;
        if (map.isStyleLoaded()) addLayers();
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
      (DEMO ? '' : ' Layers are read live from the City’s and County’s public map services each time this page loads; nothing is copied to this site.');
    renderStats();
    if (c && c.ask) { const a = c.ask; $('ask').hidden = false; const mail = a.email_to ? 'mailto:' + encodeURIComponent(a.email_to) + '?subject=' + encodeURIComponent(a.email_subject || '') + '&body=' + encodeURIComponent(a.email_body || '') : null;
      $('ask').innerHTML = '<h3>' + esc(a.headline) + '</h3><p>' + esc(a.body) + '</p><div class="actions">' + (mail ? '<a class="btn primary" href="' + mail + '">Email the City Council</a>' : '<span class="btn" title="Council email address not yet configured">Email the City Council (coming)</span>') + '<button class="btn" id="share" type="button">Copy link to this view</button><button class="btn" type="button" onclick="window.print()">Print</button></div>';
      $('share').onclick = async () => { syncURL(); try { await navigator.clipboard.writeText(location.href); $('share').textContent = 'Link copied'; setTimeout(() => $('share').textContent = 'Copy link to this view', 1500); } catch { prompt('Copy this link', location.href); } }; }
  }
  function renderStats() {
    const s = state.stats; if (!s) return; const el = $('stats'); el.hidden = false;
    const bw = s.by_width && s.by_width[String(state.w)];
    const acres = bw ? bw.acres : (state.w === 100 ? s.buffer_acres_city : null);
    const parcels = bw ? bw.parcels : (state.w === 100 ? s.parcels_touched : null);
    const k = s.consultant;
    el.innerHTML = stat(s.stream_miles_city, 'mapped stream miles in city', 1) + stat(acres, 'acres in ' + state.w + ' ft band') + stat(parcels, 'city parcels touched (' + state.w + ' ft)') +
      '<div class="statnote">Source: ' + esc(s.source || '') + (s.method_url ? ' · <a href="' + esc(s.method_url) + '" target="_blank" rel="noopener">how we computed this</a>' : '') + '</div>' +
      (k ? '<div class="statnote">' + esc(k.label) + ': buffer area <b>' + fmt(k.acres_today, 1) + ' → ' + fmt(k.acres_proposed, 1) + ' acres</b> on ' + fmt(k.stream_miles, 1) + ' stream miles (' + fmt(k.open_miles, 1) + ' open + ' + fmt(k.piped_miles, 1) + ' piped). ' + esc(k.note || '') + '</div>' : '');
  }
  const stat = (v, l, d) => '<div class=\"stat\"><b>' + (v == null ? '—' : fmt(v, d || 0)) + '</b><span>' + esc(l) + '</span></div>';
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
    if (DEMO) return null;
    try {
      const fc = await arcgis(COUNTY_PARCELS, { geometry: lnglat[0].toFixed(7) + ',' + lnglat[1].toFixed(7), geometryType: 'esriGeometryPoint', inSR: 4326,
        spatialRel: 'esriSpatialRelIntersects', outFields: PARCEL_FIELDS, resultRecordCount: 1 });
      const p = (fc.features || []).find(f => f.geometry) || null;
      if (state.lastPoint === lnglat) evaluate(lnglat, state.lastLabel, p, true);
      return p;
    } catch (e) { console.warn('parcel lookup failed', e); if (state.lastPoint === lnglat) evaluate(lnglat, state.lastLabel, null, true); return null; }
  }
  const loadViewportParcels = debounce(async () => {
    if (DEMO || !map.getSource('parcels')) return;
    if (map.getZoom() < PARCEL_ZOOM) { map.getSource('parcels').setData(EMPTY); return; }
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

  // ---------- Evaluation ----------
  function nearestStream(pt) {
    if (!state.streams) return null; let best = null;
    for (const f of state.streams.features) {
      const g = f.geometry; if (!g) continue; const lines = g.type === 'LineString' ? [g.coordinates] : g.type === 'MultiLineString' ? g.coordinates : [];
      for (const coords of lines) { if (coords.length < 2) continue; const snap = turf.nearestPointOnLine(turf.lineString(coords), pt, { units: 'meters' });
        if (!best || snap.properties.dist < best.dist) best = { dist: snap.properties.dist, name: (f.properties && (f.properties.name || f.properties.StreamName || f.properties.GNIS_NAME || f.properties.NAME)) || null, snap }; }
    }
    return best;
  }
  function insideBuffer(pt, w) { const fc = state.buffers[w]; if (!fc) return false; return fc.features.some(f => f.geometry && turf.booleanPointInPolygon(pt, f)); }
  function parcelShare(parcel, w) {
    const fc = state.buffers[w]; if (!fc || !parcel) return null; const pb = turf.bbox(parcel); let inter = 0;
    for (const f of fc.features) { if (!f.geometry) continue; const bb = turf.bbox(f); if (bb[0] > pb[2] || bb[2] < pb[0] || bb[1] > pb[3] || bb[3] < pb[1]) continue;
      try { const x = turf.intersect(turf.featureCollection([parcel, f])); if (x) inter += turf.area(x); } catch { try { const x = turf.intersect(parcel, f); if (x) inter += turf.area(x); } catch {} } }
    const total = turf.area(parcel); return total > 0 ? { pct: Math.min(100, 100 * inter / total), acres: inter / 4046.8564224, total_acres: total / 4046.8564224 } : null;
  }
  // Distance (ft) from the parcel boundary to the nearest mapped stream centerline; 0 if a stream crosses the parcel.
  function parcelDistanceFt(parcel) {
    if (!state.streams || !parcel || !parcel.geometry) return null;
    try {
      for (const f of state.streams.features) if (f.geometry && turf.booleanIntersects(f, parcel)) return 0;
      let best = Infinity;
      for (const v of turf.explode(parcel).features) { const ns = nearestStream(v); if (ns && ns.dist < best) best = ns.dist; }
      const outline = turf.polygonToLine(parcel); const rings = outline.type === 'FeatureCollection' ? outline.features : [outline];
      const pb = turf.bbox(parcel); const m = 0.003; // ~250 m search margin
      for (const f of state.streams.features) { if (!f.geometry) continue; const sb = turf.bbox(f); if (sb[0] > pb[2] + m || sb[2] < pb[0] - m || sb[1] > pb[3] + m || sb[3] < pb[1] - m) continue;
        for (const sp of turf.explode(f).features) for (const ring of rings) { const d = turf.nearestPointOnLine(ring, sp, { units: 'meters' }).properties.dist; if (d < best) best = d; } }
      return isFinite(best) ? best * FT_PER_M : null;
    } catch (e) { console.warn('parcel distance failed', e); return null; }
  }
  function setParcelHit(parcel) { const s = map.getSource('parcel-hit'); if (s) s.setData(parcel ? turf.featureCollection([parcel]) : EMPTY); }

  function evaluate(lnglat, label, parcel, parcelResolved) {
    state.lastPoint = lnglat; state.lastLabel = label; state.lastParcel = parcel || null; setParcelHit(state.lastParcel);
    const pt = turf.point(lnglat); const w = state.w; const r = $('result'); r.classList.remove('hidden', 'inside', 'near', 'outside');
    if (!state.buffers[w] || !state.streams) { r.className = 'result'; r.innerHTML = '<p class="status">Map data not loaded</p><p class="detail">' + (DEMO ? 'Demo data missing.' : 'The City’s live GIS service is not responding right now. Please try again in a minute.') + '</p>'; return; }
    const ns = nearestStream(pt); const ptDistFt = ns ? ns.dist * FT_PER_M : null; const ptInside = insideBuffer(pt, w);
    const share = parcel ? parcelShare(parcel, w) : null; const pDist = parcel ? parcelDistanceFt(parcel) : null;
    // Classification: by the parcel when we have one (does any part of the lot fall in the band?), else by the point.
    let inside, distFt;
    if (parcel && pDist != null) { distFt = pDist; inside = pDist <= w || (share && share.pct > 0.05); }
    else { distFt = ptDistFt; inside = ptInside; }
    const edgeFt = distFt == null ? null : distFt - w;
    const cls = inside ? 'inside' : (edgeFt != null && edgeFt <= NEAR_FT ? 'near' : 'outside');
    const uncertain = !inside && distFt != null && distFt > w && distFt <= UNCERTAIN_FT;
    const c = (state.content && state.content[cls]) || {};
    const pp = parcel ? parcel.properties || {} : {};
    r.className = 'result ' + cls;
    r.innerHTML = '<p class="status">' + esc(c.headline || ({ inside: 'Inside the proposed ' + w + '-foot buffer', near: 'Just outside the proposed ' + w + '-foot buffer', outside: 'Outside the proposed ' + w + '-foot buffer' })[cls]) + '</p>' +
      '<p class="detail">' + esc(c.summary || '') + '</p>' +
      '<p class="meta">' + (label ? '<b>' + esc(label) + '</b><br>' : '') +
      (parcel
        ? ('Parcel <b>' + esc(pp.geo_id || '') + '</b>' + (pp.full_situs ? ' (' + esc(pp.full_situs) + ')' : '') + ': ' +
           (pDist != null ? 'its boundary is about <b>' + fmt(pDist) + ' ft</b> from the nearest mapped stream' + (ns && ns.name ? ' (<b>' + esc(ns.name) + '</b>)' : '') + '. ' : '') +
           (share ? (share.pct > 0.05 ? '<b>' + fmt(share.pct, share.pct < 10 ? 1 : 0) + '%</b> of its ' + fmt(share.total_acres, 2) + ' acres (' + fmt(share.acres, 2) + ' ac) falls inside the ' + w + '-ft band. ' : 'None of its ' + fmt(share.total_acres, 2) + ' acres falls inside the ' + w + '-ft band. ') : '') +
           (!inside && edgeFt != null ? 'The band edge is about <b>' + fmt(Math.max(0, edgeFt)) + ' ft</b> from the lot line. ' : '') +
           (pp.link ? '<a href="' + esc(pp.link) + '" target="_blank" rel="noopener">County Assessor record</a>. ' : ''))
        : ((ptDistFt != null ? 'About <b>' + fmt(ptDistFt) + ' ft</b> from the nearest mapped stream' + (ns && ns.name ? ' (<b>' + esc(ns.name) + '</b>)' : '') + '. ' : '') +
           (ptInside ? 'This point is <b>' + fmt(Math.max(0, w - ptDistFt)) + ' ft</b> inside the band. ' : (edgeFt != null ? 'The ' + w + '-ft band edge is about <b>' + fmt(Math.max(0, edgeFt)) + ' ft</b> away. ' : '')) +
           (!DEMO && !parcelResolved ? '<span class="muted">Looking up the County parcel at this point…</span>' : (!DEMO ? '<span class="muted">No County tax parcel at this point (street, park, or right-of-way).</span>' : '')))) +
      '</p>' +
      (uncertain ? '<p class="uncertain"><b>Within the 150-ft uncertainty band.</b> This band is drawn from the mapped stream centerline, but the ordinance measures from the ordinary high-water mark, top of bank, or channel migration zone, whichever is greater, so the real buffer edge is likely closer than shown. Treat this property as possibly affected until a site survey says otherwise.</p>' : '') +
      (cls === 'near' && !uncertain ? '<p class="uncertain">The ordinance measures the buffer from the ordinary high-water mark, top of bank, or channel migration zone, not the stream centerline shown here, so the regulated edge may be closer than drawn.</p>' : '') +
      '<div class="actions"><button class="btn" type="button" id="zoomTo">Zoom here</button></div>';
    $('zoomTo').onclick = () => map.flyTo({ center: lnglat, zoom: 17 });
    renderFAQ(cls);
    syncURL();
  }
  function renderFAQ(cls) {
    const c = state.content && state.content[cls]; const el = $('faq'); if (!c || !c.items) { el.innerHTML = ''; return; }
    const tagText = { draft: 'per draft ordinance', typical: 'typical in WA CAOs', unknown: 'not yet confirmed' };
    el.innerHTML = '<h3 style="font-size:14px;margin:16px 0 4px">What this would mean</h3>' + c.items.map(i => '<details class="faq"><summary>' + esc(i.q) + '<span class="tag ' + esc(i.basis || '') + '">' + esc(tagText[i.basis] || i.basis || '') + '</span></summary><p>' + esc(i.a) + '</p></details>').join('');
  }
  function placeMarker(lnglat) { if (state.marker) state.marker.remove(); state.marker = new maplibregl.Marker({ color: '#b23a2a' }).setLngLat(lnglat).addTo(map); }

  // ---------- Events ----------
  $('searchForm').addEventListener('submit', async (e) => {
    e.preventDefault(); const q = $('q').value.trim(); if (!q) return; const btn = $('go'); btn.disabled = true; btn.textContent = '…'; $('hint').textContent = 'Looking up the County parcel…';
    try {
      let found = null;
      if (!DEMO) { try { found = await findParcel(q); } catch (err) { console.warn('parcel search failed', err); } }
      if (found) {
        const p = turf.pointOnFeature(found.parcel).geometry.coordinates;
        $('hint').textContent = 'Matched County parcel ' + (found.parcel.properties.full_situs || found.parcel.properties.geo_id) + (found.count > 1 ? ' (' + found.count + ' parcels matched; showing the closest match)' : '') + '. Not your lot? Tap it on the map.';
        placeMarker(p); map.flyTo({ center: p, zoom: 17 }); evaluate(p, found.label, found.parcel, true); return;
      }
      const g = await geocodeFallback(q);
      if (!g) { $('hint').textContent = 'No County parcel matched that address. Try "123 S 2nd Ave" (number + street name), or tap your lot on the map.'; return; }
      $('hint').textContent = 'No parcel matched; located via ' + g.src + '. Tap your lot on the map if the pin is off.';
      const p = [g.lng, g.lat]; placeMarker(p); map.flyTo({ center: p, zoom: 16.5 }); evaluate(p, g.label, null); fetchParcelAt(p);
    } finally { btn.disabled = false; btn.textContent = 'Check'; }
  });
  map.on('click', (e) => { const p = [e.lngLat.lng, e.lngLat.lat]; placeMarker(p); evaluate(p, 'Tapped location', null); fetchParcelAt(p); });
  map.on('moveend', syncURL);

  // ---------- Disclaimer modal ----------
  if (lsGet('ww_cao_ack') === '1') $('modal').classList.add('hidden');
  $('agree').onclick = () => { lsSet('ww_cao_ack', '1'); $('modal').classList.add('hidden'); };

  loadData();
})();
