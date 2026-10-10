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
  const RM = !!(window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches); // reduced motion: no animation, instant states
  const SHARED = !!(params.get('lat') && params.get('lng'));
  const DEFAULT_ZOOM = 12.6, INTRO_ZOOM_OUT = 0.9;  // intro eases from a slightly wider citywide view into the default view
  const BAND = { fill: '#d4891c', line: '#a86a10', fillOpacity: 0.35, lineOpacity: 0.8 }; // amber band
  const INK = '#15202b', CREEK = '#1d6fb8';
  const html = document.documentElement;
  const intro = { modalClosed: false, layersShown: false }; const afterIntroQ = [];
  let styleReady = false; // style JSON parsed (sources/layers can be added). Unlike map.isStyleLoaded() it does not wait for basemap tiles, which keep loading during camera moves

  // Live public services (both answer with Access-Control-Allow-Origin: *). Documented in README.md.
  const CITY_FS = 'https://services1.arcgis.com/F8n8WJgK0mEjXgtm/arcgis/rest/services/WW_Streams_Riparian_Buffer/FeatureServer';
  const COUNTY_PARCELS = 'https://services8.arcgis.com/COL6rRPkF9w28VGX/ArcGIS/rest/services/Tax_Parcels/FeatureServer/0';
  const PARCEL_FIELDS = 'geo_id,prop_id,full_situs,situs_num,situs_city,situs_zip,size_acres,link';
  const CITY_LABEL = 'City of Walla Walla GIS, Oct 6 2026';
  const COMPUTED_LABEL = 'computed in your browser from the City’s stream centerlines (' + CITY_LABEL + ')';

  const state = { w: Number(params.get('w')) || 100, wantW: null, streams: null, buffers: {}, bufferSource: {}, city: null, cityRings: null,
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
    zoom: Number(params.get('z')) || (DEFAULT_ZOOM - (RM || SHARED ? 0 : INTRO_ZOOM_OUT)),
    attributionControl: true
  });
  map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
  map.addControl(new maplibregl.GeolocateControl({ positionOptions: { enableHighAccuracy: true }, trackUserLocation: false }), 'top-right');
  map.on('error', (e) => { // style failed → raster fallback
    if (e && e.error && /style|tiles.openfreemap/i.test(String(e.error.message || e.error))) { try { styleReady = false; map.setStyle(rasterFallback); } catch {} }
  });

  function addLayers() {
    const shown = intro.layersShown; const T = { duration: RM ? 0 : 350 }; // before the intro reveal, layers start transparent and fade in
    if (state.city && !map.getSource('city')) {
      map.addSource('city', { type: 'geojson', data: state.city, attribution: DEMO ? '' : 'City limit: City of Walla Walla GIS' });
      map.addLayer({ id: 'city-line', type: 'line', source: 'city', paint: { 'line-color': INK, 'line-width': 2.8, 'line-dasharray': [3, 1.6], 'line-opacity': shown ? 1 : 0, 'line-opacity-transition': T } });
    }
    WIDTHS.forEach(w => {
      const fc = state.buffers[w]; if (!fc || map.getSource('buf' + w)) return;
      const on = shown && w === state.w; // bands are always "visible"; the selected one is opaque, the others transparent (cross-fade on toggle)
      map.addSource('buf' + w, { type: 'geojson', data: fc, attribution: (!DEMO && w === 100) ? '100-ft buffer: City of Walla Walla GIS (2026-10-06)' : '' });
      map.addLayer({ id: 'buf' + w + '-fill', type: 'fill', source: 'buf' + w, paint: { 'fill-color': BAND.fill, 'fill-opacity': on ? BAND.fillOpacity : 0, 'fill-opacity-transition': T } });
      map.addLayer({ id: 'buf' + w + '-line', type: 'line', source: 'buf' + w, paint: { 'line-color': BAND.line, 'line-width': 1.2, 'line-opacity': on ? BAND.lineOpacity : 0, 'line-opacity-transition': T } });
    });
    if (state.streams && !map.getSource('streams')) {
      map.addSource('streams', { type: 'geojson', data: state.streams, attribution: DEMO ? 'DEMO data' : 'Streams: City of Walla Walla GIS (2026-10-06)' });
      map.addLayer({ id: 'streams-line', type: 'line', source: 'streams', paint: { 'line-color': CREEK, 'line-width': ['interpolate', ['linear'], ['zoom'], 10, 1.2, 16, 3.5], 'line-opacity': shown ? 1 : 0, 'line-opacity-transition': T } });
      map.addLayer({ id: 'streams-label', type: 'symbol', source: 'streams', minzoom: 13,
        layout: { 'symbol-placement': 'line', 'text-field': ['coalesce', ['get', 'name'], ''], 'text-size': 11, 'text-font': ['Noto Sans Regular'] },
        paint: { 'text-color': CREEK, 'text-halo-color': '#fff', 'text-halo-width': 1.2, 'text-opacity': shown ? 1 : 0, 'text-opacity-transition': T } });
    }
    if (!DEMO && !map.getSource('parcels')) { // live viewport parcels (outline only, zoom >= PARCEL_ZOOM)
      map.addSource('parcels', { type: 'geojson', data: EMPTY, attribution: 'Parcels: Walla Walla County GIS / Assessor' });
      map.addLayer({ id: 'parcels-line', type: 'line', source: 'parcels', minzoom: PARCEL_ZOOM, paint: { 'line-color': '#777', 'line-width': 0.6, 'line-opacity': 0.7 } });
    }
    if (!map.getSource('parcel-hit')) { // the one parcel being checked
      map.addSource('parcel-hit', { type: 'geojson', data: state.lastParcel ? turf.featureCollection([state.lastParcel]) : EMPTY });
      map.addLayer({ id: 'parcel-hit-fill', type: 'fill', source: 'parcel-hit', paint: { 'fill-color': CREEK, 'fill-opacity': 0.14 } });
      map.addLayer({ id: 'parcel-hit-casing', type: 'line', source: 'parcel-hit', paint: { 'line-color': '#ffffff', 'line-width': 5, 'line-opacity': 0.9 } });
      map.addLayer({ id: 'parcel-hit-line', type: 'line', source: 'parcel-hit', paint: { 'line-color': INK, 'line-width': 2.2 } });
    }
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
    history.replaceState(null, '', u.toString());
  }

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
    if (!RM && !SHARED && !params.get('z')) { const go = () => map.easeTo({ zoom: DEFAULT_ZOOM, duration: 1600, easing: t => 1 - Math.pow(1 - t, 3) }); if (map.loaded()) go(); else map.once('load', go); }
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
    const slow = setTimeout(() => { if (!DEMO) banner('The City\u2019s map service is slow right now. Still loading the live stream layers\u2026'); }, 8000);
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
      (DEMO ? '' : ' Layers are read live from the City’s and County’s public map services each time this page loads; nothing is copied to this site.');
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
      '<div class="statnote">Source: ' + esc(s.source || '') + (s.method_url ? ' · <a href="' + esc(s.method_url) + '" target="_blank" rel="noopener">how we computed this</a>' : '') + '</div>' +
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
  const stat = (v, l, d, i) => '<div class=\"stat\"><b' + (v == null ? '' : ' data-v=\"' + Number(v) + '\" data-d=\"' + (d || 0) + '\" data-i=\"' + i + '\"') + '>' + (v == null ? '—' : fmt(v, d || 0)) + '</b><span>' + esc(l) + '</span></div>';
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

  // ---------- City limits test ----------
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
    if (direct.length) return direct.some(r => turf.booleanPointInPolygon(pt, r.poly));
    let n = 0; for (const r of state.cityRings) if (turf.booleanPointInPolygon(pt, r.poly)) n++;
    return n % 2 === 1;
  }

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
    const pt = turf.point(lnglat); const w = state.w; const r = $('result'); skeleton(false); r.classList.remove('hidden'); const key = lnglat.join(',');
    if (!state.buffers[w] || !state.streams) { revealCard(r, '', key); r.innerHTML = '<p class="status">Map data not loaded</p><p class="detail">' + (DEMO ? 'Demo data missing.' : 'The City’s live GIS service is not responding right now. Please try again in a minute.') + '</p>'; return; }
    const ns = nearestStream(pt); const ptDistFt = ns ? ns.dist * FT_PER_M : null; const ptInside = insideBuffer(pt, w);
    const share = parcel ? parcelShare(parcel, w) : null; const pDist = parcel ? parcelDistanceFt(parcel) : null;
    // Classification: by the parcel when we have one (does any part of the lot fall in the band?), else by the point.
    let inside, distFt;
    if (parcel && pDist != null) { distFt = pDist; inside = pDist <= w || (share && share.pct > 0.05); }
    else { distFt = ptDistFt; inside = ptInside; }
    const edgeFt = distFt == null ? null : distFt - w;
    const cityTest = inCity(pt);                      // null = unknown (limit layer not loaded)
    if (cityTest === false) {                          // outside city limits: the ordinance and the City's stream layer do not apply
      const oc = (state.content && state.content.outside_city) || {}; const pp = parcel ? parcel.properties || {} : {};
      revealCard(r, 'outside_city', key);
      r.innerHTML = '<p class="status">' + esc(oc.headline || 'This address is outside Walla Walla city limits.') + '</p>' +
        '<p class="detail">' + esc(oc.summary || 'The City\u2019s proposed ordinance applies inside city limits, and the City\u2019s stream map stops at the boundary.') + '</p>' +
        '<p class="meta">' + (label ? '<b>' + esc(label) + '</b><br>' : '') +
        (parcel ? 'Parcel <b>' + esc(pp.geo_id || '') + '</b>' + (pp.full_situs ? ' (' + esc(pp.full_situs) + ')' : '') + ' is in unincorporated Walla Walla County. ' +
                  (pp.link ? '<a href="' + esc(pp.link) + '" target="_blank" rel="noopener">County Assessor record</a>. ' : '')
                : (!DEMO && !parcelResolved ? '<span class="muted lookup"><i class="dot"></i>Looking up the County parcel at this point\u2026</span>' : 'No distance is shown because the City\u2019s stream layer stops at the city limits.')) +
        '</p><div class="actions"><button class="btn" type="button" id="zoomTo">Zoom here</button></div>';
      $('zoomTo').onclick = () => map.flyTo({ center: lnglat, zoom: 16, curve: 1.4 });
      renderFAQ('outside_city'); syncURL(); pulseAsk(); return;
    }
    const cls = inside ? 'inside' : (edgeFt != null && edgeFt <= NEAR_FT ? 'near' : 'outside');
    const uncertain = !inside && distFt != null && distFt > w && distFt <= UNCERTAIN_FT;
    const c = (state.content && state.content[cls]) || {};
    const pp = parcel ? parcel.properties || {} : {};
    revealCard(r, cls, key);
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
           (!DEMO && !parcelResolved ? '<span class="muted lookup"><i class="dot"></i>Looking up the County parcel at this point…</span>' : (!DEMO ? '<span class="muted">No County tax parcel at this point (street, park, or right-of-way).</span>' : '')))) +
      '</p>' +
      (uncertain ? '<p class="uncertain"><b>Within the 150-ft uncertainty band.</b> This band is drawn from the mapped stream centerline, but the ordinance measures from the ordinary high-water mark, top of bank, or channel migration zone, whichever is greater, so the real buffer edge is likely closer than shown. Treat this property as possibly affected until a site survey says otherwise.</p>' : '') +
      (cls === 'near' && !uncertain ? '<p class="uncertain">The ordinance measures the buffer from the ordinary high-water mark, top of bank, or channel migration zone, not the stream centerline shown here, so the regulated edge may be closer than drawn.</p>' : '') +
      '<div class="actions"><button class="btn" type="button" id="zoomTo">Zoom here</button></div>';
    $('zoomTo').onclick = () => map.flyTo({ center: lnglat, zoom: 17, curve: 1.4 });
    renderFAQ(cls);
    syncURL(); pulseAsk();
  }
  function renderFAQ(cls) {
    const c = state.content && state.content[cls]; const el = $('faq'); if (!c || !c.items) { el.innerHTML = ''; el.dataset.cls = ''; return; }
    if (el.dataset.cls === cls && el.childElementCount) return; // same state (width toggle, parcel resolve): keep the list, and any open item, as is
    el.dataset.cls = cls;
    const tagText = { draft: 'per draft ordinance', typical: 'typical in WA CAOs', unknown: 'not yet confirmed', code: 'per existing city code' };
    el.innerHTML = '<h3 class="faq-h">What this would mean</h3>' + c.items.map((i, n) => '<details class="faq" style="--i:' + (n + 1) + '"><summary><span class="q">' + esc(i.q) + '</span><span class="tag ' + esc(i.basis || '') + '">' + esc(tagText[i.basis] || i.basis || '') + '</span></summary><p>' + esc(i.a) + '</p></details>').join('');
  }
  function placeMarker(lnglat) { // custom marker element: the pin drops with a short bounce, a halo pulses at the point (CSS)
    if (state.marker) state.marker.remove();
    const el = document.createElement('div'); el.className = 'pin-wrap'; el.innerHTML = '<span class="pin-halo"></span><span class="pin-drop"><span class="pin"></span></span>';
    state.marker = new maplibregl.Marker({ element: el, anchor: 'bottom' }).setLngLat(lnglat).addTo(map);
  }

  // ---------- Events ----------
  $('searchForm').addEventListener('submit', async (e) => {
    e.preventDefault(); const q = $('q').value.trim(); if (!q) return; const btn = $('go'); btn.disabled = true; btn.textContent = '…'; $('hint').textContent = 'Looking up the County parcel…';
    busy(true); skeleton(true);
    try {
      let found = null;
      if (!DEMO) { try { found = await findParcel(q); } catch (err) { console.warn('parcel search failed', err); } }
      if (found) {
        const p = turf.pointOnFeature(found.parcel).geometry.coordinates;
        $('hint').textContent = 'Matched County parcel ' + (found.parcel.properties.full_situs || found.parcel.properties.geo_id) + (found.count > 1 ? ' (' + found.count + ' parcels matched; showing the closest match)' : '') + '. Not your lot? Tap it on the map.';
        placeMarker(p); map.flyTo({ center: p, zoom: 17, curve: 1.4 }); evaluate(p, found.label, found.parcel, true); return;
      }
      const g = await geocodeFallback(q);
      if (!g) { $('hint').textContent = 'No County parcel matched that address. Try "123 S 2nd Ave" (number + street name), or tap your lot on the map.'; return; }
      $('hint').textContent = 'No parcel matched; located via ' + g.src + '. Tap your lot on the map if the pin is off.';
      const p = [g.lng, g.lat]; placeMarker(p); map.flyTo({ center: p, zoom: 16.5, curve: 1.4 }); evaluate(p, g.label, null); fetchParcelAt(p);
    } finally { btn.disabled = false; btn.textContent = 'Check'; busy(false); skeleton(false); }
  });
  map.on('click', (e) => { const p = [e.lngLat.lng, e.lngLat.lat]; placeMarker(p); if (map.getZoom() < 15) map.flyTo({ center: p, zoom: 16, curve: 1.4 }); evaluate(p, 'Tapped location', null); fetchParcelAt(p); });
  map.on('moveend', syncURL);

  // ---------- Disclaimer modal → intro ----------
  function closeModal() { const m = $('modal'); if (RM) m.classList.add('hidden'); else { m.classList.add('closing'); setTimeout(() => m.classList.add('hidden'), 320); } runIntro(); }
  if (lsGet('ww_cao_ack') === '1') { $('modal').classList.add('hidden'); runIntro(); }
  $('agree').onclick = () => { lsSet('ww_cao_ack', '1'); closeModal(); };

  loadData();
})();
