/* CreekChecker statewide what-if map (creekchecker.com/wa/), 2026-10-15.
   Static, no backend. Every layer is read live in the browser from public state services
   (data/sources/statewide-layers.md): WaTech parcels and city/UGA limits, WSDOT county boundaries,
   WA DNR Forest Practices watercourses, WDFW estimated riparian management zones. The Esri World
   Geocoder is used only when an API key is configured (forStorage=false; results are never stored).
   No activity counter and no other endpoint is called.
   PERFORMANCE (2026-10-15): all geometry runs in short tasks. Distances and shares use planar math in
   local metres with bbox prefilters; the what-if band is buffered cell by cell (turf) with a time budget
   per task (TASK_MS) and yields between tasks, so the main thread is never blocked for long.
   LOADING (2026-10-15): this file is deferred and runs before maplibre-gl.js (also deferred), so the form works first; the map
   starts when MapLibre arrives. The OpenFreeMap style and its TileJSON were fetched by an inline script in <head> (window.wmBoot);
   buildStyle() drops the Natural Earth relief raster (over 1 MB of PNG at the statewide view), inlines the TileJSON and puts the
   imagery in the style from the start, so there is one style load and no street-to-aerial switch. @turf/turf (band drawing only)
   is never loaded with the page: it is fetched when someone starts a lookup (focus in the form, the tap-to-zoom step, or a lookup
   itself), and buildBand waits for it. The creek loader (#wmLoader) covers the map until its first 'idle' and during each lookup.
   PHASE A (2026-10-16, prompts/13): DNR Water Bodies (layer 1: lakes, ponds, reservoirs, wide rivers, marine water) are read with
   each lookup; the result names any within the chosen width and says their rules are separate and not checked. Every result ends
   with next steps: a share link (?lat&lng&width, copy and native share), the official county or city page from
   content/washington.json, and who to contact (the optional "contact" field, else a council/commission link, else the county's
   card on washington.html); all local. County cards show "Checked <date>" beside each chip, "may be out of date" after 21 days,
   and drop "Next" lines whose next_date has passed. */
(function () {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const RMQ = window.matchMedia ? matchMedia('(prefers-reduced-motion: reduce)') : { matches: false };
  const params = new URLSearchParams(location.search);
  let CFG = {};
  try { CFG = JSON.parse(($('wmConfig') || {}).textContent || '{}'); } catch (_) { CFG = {}; }
  const ESRI_KEY = String(CFG.esriKey || '').trim();

  // ---------- Services (verified 2026-10-15; data/sources/statewide-layers.md) ----------
  const SVC = {
    parcels: 'https://services.arcgis.com/jsIt88o09Q0r1j8h/ArcGIS/rest/services/Current_Parcels/FeatureServer/0',
    cityUga: 'https://services.arcgis.com/jsIt88o09Q0r1j8h/ArcGIS/rest/services/Washington_State_City_Urban_Growth_Areas/FeatureServer/0',
    counties: 'https://data.wsdot.wa.gov/arcgis/rest/services/Shared/CountyBoundaries/MapServer/0',
    dnr: 'https://gis.dnr.wa.gov/site2/rest/services/Public_Forest_Practices/WADNR_PUBLIC_FP_Hydro/MapServer/0',
    water: 'https://gis.dnr.wa.gov/site2/rest/services/Public_Forest_Practices/WADNR_PUBLIC_FP_Hydro/MapServer/1', // 2026-10-16: Water Bodies (FP), verified live (statewide-layers.md §2.3a)
    rmz: 'https://geodataservices.wdfw.wa.gov/arcgis/rest/services/PHSOnTheWeb/RDE_RMZ/MapServer/0',
    geocode: 'https://geocode-api.arcgis.com/arcgis/rest/services/World/GeocodeServer/findAddressCandidates'
  };
  const PARCEL_FIELDS = 'PARCEL_ID_NR,SITUS_ADDRESS,SUB_ADDRESS,SITUS_CITY_NM,SITUS_ZIP_NR,FIPS_NR,DATA_LINK';
  const DNR_FIELDS = 'WC_GNIS_NM,FP_WTRTY_CD,WC_PERIOD_LABEL_NM,WC_HYDR_FTR_LABEL_NM';
  // 2026-10-16 (Phase A): DNR Water Bodies. Only these cartographic kinds are asked for and kept (marshes, glaciers, sewage, industrial,
  // hatchery, tailing ponds, ditches, pipes and the like are left out). The service's fields are untrusted: kinds and types are
  // whitelisted, names are cleaned and escaped, geometry must be a polygon with numeric rings.
  const WATER_FIELDS = 'WB_GNIS_NM,FP_WTRTY_CD,WB_CART_FTR_LABEL_NM';
  const WATER_KIND = { 'Lake/pond': 'lake', 'Flooded pit': 'lake', 'Reservoir': 'reservoir', 'Stream/river': 'river', 'Rapids': 'river', 'Falls': 'river', 'Channel': 'river', 'Bay/estuary': 'marine' };
  const WATER_WHERE = 'WB_CART_FTR_LABEL_NM IN (' + Object.keys(WATER_KIND).map((k) => "'" + k + "'").join(',') + ')';
  const WATER_WORD = { lake: 'lake or pond', reservoir: 'reservoir', river: 'wide river', marine: 'marine water' };
  const MAX_WATER = 150;
  const STALE_DAYS = 21; // county cards: a check older than this says "may be out of date" (same rule as washington.html)
  const COUNTY_NAMES = ['Adams', 'Asotin', 'Benton', 'Chelan', 'Clallam', 'Clark', 'Columbia', 'Cowlitz', 'Douglas', 'Ferry', 'Franklin', 'Garfield', 'Grant',
    'Grays Harbor', 'Island', 'Jefferson', 'King', 'Kitsap', 'Kittitas', 'Klickitat', 'Lewis', 'Lincoln', 'Mason', 'Okanogan', 'Pacific', 'Pend Oreille', 'Pierce',
    'San Juan', 'Skagit', 'Skamania', 'Snohomish', 'Spokane', 'Stevens', 'Thurston', 'Wahkiakum', 'Walla Walla', 'Whatcom', 'Whitman', 'Yakima'];
  const FIPS = {}; const NAME_BY_FIPS = {};
  COUNTY_NAMES.forEach((n, i) => { const f = String(2 * i + 1).padStart(3, '0'); FIPS[n] = f; NAME_BY_FIPS[f] = n; }); // WSDOT JURFIPSDSG 53001..53077, alphabetical
  const WA_EXTENT = { xmin: -124.85, ymin: 45.54, xmax: -116.91, ymax: 49.01 };
  const WA_CENTER = [-120.55, 47.3], WA_ZOOM = 5.7;
  const WIDTHS = [35, 50, 75, 100, 150];
  const FT = 0.3048, M2FT = 3.280839895;
  const SEARCH_M = 600;          // streams and RMZ are loaded for the lot's bbox plus this margin (a ~1.2 km envelope)
  const NEAR_LOT_M = 40;         // nearest parcel within 40 m when the point is in a street
  const MAX_W_M = 150 * FT;
  const TASK_MS = 16;            // time budget per main-thread task
  const MAX_DNR = 700, MAX_RMZ = 600;
  const TYPE = { S: 'Type S, shoreline of the state', F: 'Type F, fish-bearing', N: 'Type N, non-fish', U: 'Type U, type unknown', X: 'Type X, no type designation' };
  const STATUS = { adopted: ['Adopted', 'The update is adopted.'], hearing: ['Hearing set', 'A draft is out and a hearing date is set.'],
    draft: ['Draft out', 'A draft of the critical areas update is public.'], started: ['Underway', 'The update has started; no public critical areas draft found yet.'],
    none_found: ['No draft found', 'No public critical areas draft found on official pages.'], unchecked: ['Not checked yet', 'We have not checked this county yet.'] };

  // 2026-10-16: shared links carry the width as "width" (a "w" parameter is reserved for the Walla Walla map's routing); "w" is still read
  const W0 = Number(params.get('width') || params.get('w'));
  const S = { seq: 0, w: WIDTHS.includes(W0) ? W0 : 100, lot: null, pt: null, env: null, geo: null,
    dnr: null, rmz: null, water: null, bands: {}, bandJob: 0, juris: null, content: null, basemap: 'aerial', asotinEnv: null, picks: [] };
  try { if (localStorage.getItem('cc_basemap') === 'street') S.basemap = 'street'; } catch (_) {}

  // ---------- Small helpers ----------
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const qs = (o) => Object.keys(o).filter((k) => o[k] != null).map((k) => encodeURIComponent(k) + '=' + encodeURIComponent(o[k])).join('&');
  const now = () => (window.performance ? performance.now() : Date.now());
  const pause = () => new Promise((r) => setTimeout(r, 0));
  const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  // 2026-10-16: freshness (local calendar date, YYYY-MM-DD), the same rules as washington.html's view-time script
  const isoDay = (s) => (/^\d{4}-\d{2}-\d{2}$/.test(String(s || '')) ? String(s) : '');
  const today = () => { const d = new Date(), p = (n) => (n < 10 ? '0' : '') + n; return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()); };
  const daysOld = (s) => { const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s), d = new Date(); return m ? (Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) - Date.UTC(+m[1], m[2] - 1, +m[3])) / 864e5 : 0; };
  const nextLive = (x) => !!(x && x.next) && !(isoDay(x.next_date) && x.next_date < today());
  const EMPTY = { type: 'FeatureCollection', features: [] };
  const fc = (features) => ({ type: 'FeatureCollection', features: features });
  function status(msg, kind) { const el = $('wmStatus'); if (!el) return; el.textContent = msg || ''; el.className = 'wm-status' + (kind ? ' is-' + kind : '');
    const box = $('wmMsg'); if (box) box.classList.toggle('has-status', !!msg); } // the status takes the hint's slot (no layout shift)

  // ---------- Loading: lazy turf, early connections, the creek loader ----------
  const TURF_SRC = 'https://cdn.jsdelivr.net/npm/@turf/turf@7.1.0/turf.min.js';
  let turfP = null;
  function loadTurf() { // resolves to window.turf, or null if it could not load (the band note says so; the shares are still computed)
    if (window.turf) return Promise.resolve(window.turf);
    if (!turfP) turfP = new Promise((res) => { const sc = document.createElement('script'); sc.src = TURF_SRC; sc.async = true;
      sc.onload = () => res(window.turf || null); sc.onerror = () => { turfP = null; sc.remove(); res(null); }; document.head.appendChild(sc); });
    return turfP;
  }
  let hostsWarm = false;
  function warmHosts() { // someone is starting a lookup (focus in the form, tap-to-zoom, or submit): open the services' connections, fetch turf
    loadTurf(); if (hostsWarm) return; hostsWarm = true;
    ['https://services.arcgis.com', 'https://gis.dnr.wa.gov', 'https://geodataservices.wdfw.wa.gov', 'https://data.wsdot.wa.gov'].concat(ESRI_KEY ? ['https://geocode-api.arcgis.com'] : [])
      .forEach((h) => { const l = document.createElement('link'); l.rel = 'preconnect'; l.href = h; l.crossOrigin = 'anonymous'; document.head.appendChild(l); });
  }
  const LD = { map: true, text: '', t: 0 };
  function loaderSync() { // shown while the map is first loading or a lookup is running; fades out (CSS) when neither
    const el = $('wmLoader'); if (!el) return;
    const text = LD.text || (LD.map ? 'Loading the map…' : ''); clearTimeout(LD.t);
    if (text) { const t = el.querySelector('.cl-text'); if (t && t.textContent !== text) t.textContent = text; el.hidden = false; el.classList.remove('cl-done'); return; }
    if (el.hidden) return; el.classList.add('cl-done');
    LD.t = setTimeout(() => { el.hidden = true; el.setAttribute('aria-hidden', 'true'); el.removeAttribute('role'); el.removeAttribute('aria-live'); }, RMQ.matches ? 0 : 260); // later lookups are announced by #wmStatus
  }
  function mapLoaded() { if (LD.map) { LD.map = false; loaderSync(); } }
  function lookupLoader(my, text) { if (my !== S.seq) return; LD.text = text || '';
    if (text) { const el = $('wmLoader'); if (el) el.setAttribute('aria-hidden', 'true'); } // #wmStatus already announces each lookup step
    loaderSync(); }
  function beginLookup(my, text) { warmHosts(); lookupLoader(my, text); }
  const RESP = new Map(); // 2026-10-15: in memory, this page view only: the same public-layer query (a lot checked again) is not sent twice
  function getJSON(url, ms) {
    const keep = url.indexOf(SVC.geocode) !== 0; // geocoder results are shown, never kept
    if (keep && RESP.has(url)) return RESP.get(url);
    const p = getJSONRetry(url, ms);
    if (keep) { RESP.set(url, p); p.catch(() => RESP.delete(url)); if (RESP.size > 60) RESP.delete(RESP.keys().next().value); }
    return p;
  }
  async function getJSONRetry(url, ms) { // one quiet retry: these public services occasionally drop a request
    try { return await getJSONOnce(url, ms); } catch (e) { await new Promise((r) => setTimeout(r, 700)); return getJSONOnce(url, ms); }
  }
  async function getJSONOnce(url, ms) {
    const ctl = typeof AbortController === 'function' ? new AbortController() : null;
    const t = setTimeout(() => { if (ctl) ctl.abort(); }, ms || 20000);
    try {
      const r = await fetch(url, Object.assign({ referrerPolicy: 'strict-origin-when-cross-origin' }, ctl ? { signal: ctl.signal } : {})); // 2026-10-15: the Esri key needs a referrer; never inherit a no-referrer page policy
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const j = await r.json();
      if (j && j.error) throw new Error('Service error ' + (j.error.code || '') + ' ' + (j.error.message || ''));
      return j;
    } finally { clearTimeout(t); }
  }
  async function queryGeo(layer, p, ms) { // GeoJSON features in WGS84
    const j = await getJSON(layer + '/query?' + qs(Object.assign({ f: 'geojson', inSR: 4326, outSR: 4326, returnGeometry: true }, p)), ms);
    j.features = (j.features || []).filter((f) => f && f.geometry && f.geometry.coordinates);
    return j;
  }
  async function queryAttrs(layer, p, ms) { // attributes only
    const j = await getJSON(layer + '/query?' + qs(Object.assign({ f: 'json', inSR: 4326, returnGeometry: false }, p)), ms);
    return (j.features || []).map((f) => f.attributes || {});
  }
  const envStr = (e) => e.join(',');
  const ptParams = (pt) => ({ geometry: pt[0] + ',' + pt[1], geometryType: 'esriGeometryPoint', spatialRel: 'esriSpatialRelIntersects' });
  const envParams = (e) => ({ geometry: envStr(e), geometryType: 'esriGeometryEnvelope', spatialRel: 'esriSpatialRelIntersects' });
  function ftLabel(m) {
    const f = m * M2FT; if (f < 1) return 'less than 1 ft';
    const r = f < 100 ? 5 : f < 1000 ? 10 : 50;
    return 'about ' + (Math.max(r, Math.round(f / r) * r)).toLocaleString('en-US') + ' ft';
  }
  const titleCase = (s) => String(s || '').toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase());

  // ---------- Planar geometry in local metres (accurate to well under 1% across a few km) ----------
  function makeProj(lng0, lat0) {
    const r = lat0 * Math.PI / 180;
    const ky = 111132.92 - 559.82 * Math.cos(2 * r) + 1.175 * Math.cos(4 * r);
    const kx = 111412.84 * Math.cos(r) - 93.5 * Math.cos(3 * r);
    return { kx: kx, ky: ky, lng0: lng0, lat0: lat0, f: (c) => [(c[0] - lng0) * kx, (c[1] - lat0) * ky], inv: (x, y) => [lng0 + x / kx, lat0 + y / ky] };
  }
  function polysOf(g) { return g.type === 'Polygon' ? [g.coordinates] : g.type === 'MultiPolygon' ? g.coordinates : []; }
  function linesOf(g) { return g.type === 'LineString' ? [g.coordinates] : g.type === 'MultiLineString' ? g.coordinates : []; }
  function bboxOfCoords(cs, b) { b = b || [Infinity, Infinity, -Infinity, -Infinity]; for (let i = 0; i < cs.length; i++) { const c = cs[i]; if (c[0] < b[0]) b[0] = c[0]; if (c[1] < b[1]) b[1] = c[1]; if (c[0] > b[2]) b[2] = c[0]; if (c[1] > b[3]) b[3] = c[1]; } return b; }
  function geomBbox(g) { const b = [Infinity, Infinity, -Infinity, -Infinity]; polysOf(g).forEach((p) => p.forEach((r) => bboxOfCoords(r, b))); linesOf(g).forEach((l) => bboxOfCoords(l, b)); return b; }
  const boxGap2 = (a, b) => { const dx = Math.max(0, a[0] - b[2], b[0] - a[2]), dy = Math.max(0, a[1] - b[3], b[1] - a[3]); return dx * dx + dy * dy; };
  function psd2(px, py, ax, ay, bx, by) {
    const dx = bx - ax, dy = by - ay, L = dx * dx + dy * dy;
    let t = L ? ((px - ax) * dx + (py - ay) * dy) / L : 0; t = t < 0 ? 0 : t > 1 ? 1 : t;
    const ex = ax + t * dx - px, ey = ay + t * dy - py; return ex * ex + ey * ey;
  }
  const orient = (ax, ay, bx, by, cx, cy) => (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
  function segCross(ax, ay, bx, by, cx, cy, dx, dy) {
    const d1 = orient(cx, cy, dx, dy, ax, ay), d2 = orient(cx, cy, dx, dy, bx, by), d3 = orient(ax, ay, bx, by, cx, cy), d4 = orient(ax, ay, bx, by, dx, dy);
    return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
  }
  function segSeg2(ax, ay, bx, by, cx, cy, dx, dy) {
    if (segCross(ax, ay, bx, by, cx, cy, dx, dy)) return 0;
    return Math.min(psd2(ax, ay, cx, cy, dx, dy), psd2(bx, by, cx, cy, dx, dy), psd2(cx, cy, ax, ay, bx, by), psd2(dx, dy, ax, ay, bx, by));
  }
  function inRings(x, y, rings) { // even-odd over outer ring + holes
    let inside = false;
    for (let k = 0; k < rings.length; k++) { const r = rings[k];
      for (let i = 0, j = r.length - 1; i < r.length; j = i++) { const xi = r[i][0], yi = r[i][1], xj = r[j][0], yj = r[j][1];
        if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside; } }
    return inside;
  }
  const inPolys = (x, y, polys) => { for (let i = 0; i < polys.length; i++) if (inRings(x, y, polys[i])) return true; return false; };
  function edgesOf(polys) { // flat edge list [ax,ay,bx,by,...]
    const out = []; polys.forEach((p) => p.forEach((r) => { for (let i = 1; i < r.length; i++) out.push(r[i - 1][0], r[i - 1][1], r[i][0], r[i][1]); }));
    return new Float64Array(out);
  }
  function planarLot(feature) {
    const g = feature.geometry, b = geomBbox(g);
    const P = makeProj((b[0] + b[2]) / 2, (b[1] + b[3]) / 2);
    const polys = polysOf(g).map((p) => p.map((r) => r.map(P.f)));
    const pb = [Infinity, Infinity, -Infinity, -Infinity]; polys.forEach((p) => bboxOfCoords(p[0], pb));
    const edges = edgesOf(polys);
    // interior sample grid (~1,000 cells over the bbox; finer for thin lots)
    let samples = [], step = Math.max(0.3, Math.sqrt(Math.max(1, (pb[2] - pb[0]) * (pb[3] - pb[1])) / 1000));
    for (let pass = 0; pass < 3; pass++) {
      samples = [];
      for (let y = pb[1] + step / 2; y < pb[3]; y += step) for (let x = pb[0] + step / 2; x < pb[2]; x += step) if (inPolys(x, y, polys)) samples.push(x, y);
      if (samples.length / 2 >= 120) break; step /= 2;
    }
    const bnd = []; // boundary points: vertices + edge midpoints
    for (let i = 0; i < edges.length; i += 4) bnd.push(edges[i], edges[i + 1], (edges[i] + edges[i + 2]) / 2, (edges[i + 1] + edges[i + 3]) / 2);
    let area = 0; polys.forEach((p) => p.forEach((r, ri) => { let a = 0; for (let i = 0, j = r.length - 1; i < r.length; j = i++) a += (r[j][0] + r[i][0]) * (r[j][1] - r[i][1]); area += (ri === 0 ? 1 : -1) * Math.abs(a / 2); }));
    // an interior point near the middle (for jurisdiction and links)
    let best = null, bd = Infinity; const cx = (pb[0] + pb[2]) / 2, cy = (pb[1] + pb[3]) / 2;
    for (let i = 0; i < samples.length; i += 2) { const d = (samples[i] - cx) ** 2 + (samples[i + 1] - cy) ** 2; if (d < bd) { bd = d; best = [samples[i], samples[i + 1]]; } }
    const inner = best ? P.inv(best[0], best[1]) : [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2];
    return { P: P, bbox: b, pb: pb, polys: polys, edges: edges, samples: new Float64Array(samples), bnd: new Float64Array(bnd), area: area, inner: inner };
  }
  function buildSegs(lines, P) { // lines: [{c:[[lng,lat]..], f:index}]
    let n = 0; lines.forEach((l) => { n += Math.max(0, l.c.length - 1); });
    const A = new Float64Array(n * 4), F = new Int32Array(n), B = new Float64Array(n * 4); let k = 0;
    lines.forEach((l) => { let p = P.f(l.c[0]); for (let i = 1; i < l.c.length; i++) { const q = P.f(l.c[i]);
      A[k * 4] = p[0]; A[k * 4 + 1] = p[1]; A[k * 4 + 2] = q[0]; A[k * 4 + 3] = q[1];
      B[k * 4] = Math.min(p[0], q[0]); B[k * 4 + 1] = Math.min(p[1], q[1]); B[k * 4 + 2] = Math.max(p[0], q[0]); B[k * 4 + 3] = Math.max(p[1], q[1]);
      F[k] = l.f; k++; p = q; } });
    return { n: n, A: A, B: B, F: F };
  }
  // exact minimum distance from the lot (inside counts as 0) to segments passing keep(featureIndex)
  function lotDistance(L, SG, keep) {
    const idx = [], lb = [];
    for (let k = 0; k < SG.n; k++) { if (keep && !keep(SG.F[k])) continue; idx.push(k); lb.push(boxGap2(L.pb, [SG.B[k * 4], SG.B[k * 4 + 1], SG.B[k * 4 + 2], SG.B[k * 4 + 3]])); }
    const order = idx.map((_, i) => i).sort((a, b) => lb[a] - lb[b]);
    let best = Infinity, bestF = -1, bestK = -1; const E = L.edges;
    for (let oi = 0; oi < order.length; oi++) {
      const i = order[oi]; if (lb[i] >= best) break; const k = idx[i], o = k * 4;
      const ax = SG.A[o], ay = SG.A[o + 1], bx = SG.A[o + 2], by = SG.A[o + 3];
      if (lb[i] === 0 && (inPolys(ax, ay, L.polys) || inPolys(bx, by, L.polys))) return { d: 0, f: SG.F[k], k: k };
      for (let e = 0; e < E.length; e += 4) { const d = segSeg2(ax, ay, bx, by, E[e], E[e + 1], E[e + 2], E[e + 3]); if (d < best) { best = d; bestF = SG.F[k]; bestK = k; if (d === 0) return { d: 0, f: bestF, k: k }; } }
    }
    return { d: Math.sqrt(best), f: bestF, k: bestK };
  }
  // distance from every interior sample and boundary point to the nearest banded segment (capped at MAX_W_M + 1)
  async function sampleDistances(L, SG, keep, my) {
    const cap = MAX_W_M + 1, cap2 = cap * cap, near = [];
    const grow = [L.pb[0] - cap, L.pb[1] - cap, L.pb[2] + cap, L.pb[3] + cap];
    for (let k = 0; k < SG.n; k++) { if (keep && !keep(SG.F[k])) continue; if (boxGap2(grow, [SG.B[k * 4], SG.B[k * 4 + 1], SG.B[k * 4 + 2], SG.B[k * 4 + 3]]) === 0) near.push(k); }
    async function run(pts) {
      const out = new Float64Array(pts.length / 2).fill(cap); let t0 = now();
      for (let i = 0; i < pts.length; i += 2) {
        const x = pts[i], y = pts[i + 1]; let best = cap2;
        for (let j = 0; j < near.length; j++) { const o = near[j] * 4; const d = psd2(x, y, SG.A[o], SG.A[o + 1], SG.A[o + 2], SG.A[o + 3]); if (d < best) best = d; }
        out[i / 2] = Math.sqrt(best);
        if ((i & 63) === 0 && now() - t0 > TASK_MS) { await pause(); if (my !== S.seq) return null; t0 = now(); }
      }
      return out;
    }
    const inner = await run(L.samples); if (!inner) return null;
    const bnd = await run(L.bnd); if (!bnd) return null;
    return { inner: inner, bnd: bnd };
  }

  // ---------- Address search ----------
  const ABBR = { STREET: 'ST', STR: 'ST', AVENUE: 'AVE', AV: 'AVE', ROAD: 'RD', DRIVE: 'DR', BOULEVARD: 'BLVD', LANE: 'LN', COURT: 'CT', PLACE: 'PL', CIRCLE: 'CIR',
    HIGHWAY: 'HWY', PARKWAY: 'PKWY', TERRACE: 'TER', TRAIL: 'TRL', SQUARE: 'SQ', NORTH: 'N', SOUTH: 'S', EAST: 'E', WEST: 'W', NORTHEAST: 'NE', NORTHWEST: 'NW',
    SOUTHEAST: 'SE', SOUTHWEST: 'SW', FIRST: '1ST', SECOND: '2ND', THIRD: '3RD', FOURTH: '4TH', FIFTH: '5TH', SIXTH: '6TH', SEVENTH: '7TH', EIGHTH: '8TH', NINTH: '9TH', TENTH: '10TH' };
  const DIRS = { N: 1, S: 1, E: 1, W: 1, NE: 1, NW: 1, SE: 1, SW: 1 };
  const SUFFIX = { ST: 1, AVE: 1, RD: 1, DR: 1, BLVD: 1, LN: 1, CT: 1, PL: 1, CIR: 1, HWY: 1, PKWY: 1, TER: 1, TRL: 1, SQ: 1, WAY: 1, LOOP: 1 };
  function normAddr(raw) {
    let s = String(raw || '').toUpperCase().split(',')[0];
    s = s.replace(/\s(APT|UNIT|STE|SUITE|#)\s*[A-Z0-9-]*\s*$/, ' ').replace(/#\s*[A-Z0-9-]+/g, ' ');
    s = s.replace(/[^A-Z0-9 /&-]/g, ' ').replace(/\s+/g, ' ').trim();
    s = s.replace(/\s(WA|WASHINGTON)(\s\d{5}(-\d{4})?)?$/, '').replace(/\s\d{5}(-\d{4})?$/, '').trim();
    return s.split(' ').filter(Boolean).map((w) => ABBR[w] || w).join(' ');
  }
  const sq = (s) => String(s).replace(/'/g, "''").replace(/[%_]/g, '');
  const squash = (s) => String(s || '').toUpperCase().replace(/\s+/g, ' ').trim();
  const countyEnvs = {};
  async function countyEnv(name) { // WSDOT county envelope (cached): Asotin's parcel filter, and a sanity check on geocoder matches
    if (!countyEnvs[name]) {
      const j = await getJSON(SVC.counties + '/query?' + qs({ where: "JURLBL='" + sq(name) + "'", returnExtentOnly: true, outSR: 4326, f: 'json' }), 15000);
      const e = j.extent; if (!e || !isFinite(e.xmin)) throw new Error('No extent for ' + name + ' County');
      countyEnvs[name] = [e.xmin, e.ymin, e.xmax, e.ymax];
    }
    return countyEnvs[name];
  }
  const asotinWhere = () => countyEnv('Asotin'); // Asotin parcels have a null FIPS_NR: filter by null + the county envelope
  async function situsSearch(text, county) {
    const norm = normAddr(text); const toks = norm.split(' ');
    if (!/^\d/.test(toks[0] || '')) throw new Error('needs-number');
    const variants = [];
    for (let n = toks.length; n >= 2 && variants.length < 3; n--) variants.push(toks.slice(0, n).join(' '));
    let base = "FIPS_NR='" + FIPS[county] + "'", extra = {};
    if (county === 'Asotin') { base = 'FIPS_NR IS NULL'; extra = envParams(await asotinWhere()); }
    const run = (likes) => queryGeo(SVC.parcels, Object.assign({ where: base + ' AND (' + likes.map((v) => "UPPER(SITUS_ADDRESS) LIKE '" + sq(v) + "%'").join(' OR ') + ')',
      outFields: PARCEL_FIELDS, resultRecordCount: 12, geometryPrecision: 7 }, extra), 25000);
    let res = await run(variants);
    if (!res.features.length) { // relaxed: house number + the most distinctive street word anywhere
      const word = toks.slice(1).filter((w) => !DIRS[w] && !SUFFIX[w]).sort((a, b) => b.length - a.length)[0];
      if (word) res = await queryGeo(SVC.parcels, Object.assign({ where: base + " AND UPPER(SITUS_ADDRESS) LIKE '" + sq(toks[0]) + ' %' + sq(word) + "%'", outFields: PARCEL_FIELDS, resultRecordCount: 12, geometryPrecision: 7 }, extra), 25000);
    }
    // keep only the parcels that match the most specific prefix (e.g. "128 N 2ND ST" beats "128 N 2ND AVE" for "128 N 2nd St")
    const level = (f) => { const a = squash(f.properties.SITUS_ADDRESS); if (a === norm) return 99; for (let i = 0; i < variants.length; i++) if (a.startsWith(variants[i])) return variants.length - i; return 0; };
    const lv = res.features.map(level), top = Math.max.apply(null, lv.concat([0]));
    return res.features.filter((f, i) => lv[i] === top).sort((a, b) => squash(a.properties.SITUS_ADDRESS).localeCompare(squash(b.properties.SITUS_ADDRESS))).slice(0, 8);
  }
  async function esriGeocode(text) {
    const p = { f: 'json', singleLine: text, forStorage: 'false', sourceCountry: 'USA', outSR: 4326, maxLocations: 5, outFields: 'Match_addr,Addr_type,Score',
      searchExtent: JSON.stringify(Object.assign({}, WA_EXTENT, { spatialReference: { wkid: 4326 } })), token: ESRI_KEY };
    const j = await getJSON(SVC.geocode + '?' + qs(p), 15000);
    const ok = /^(PointAddress|Subaddress|StreetAddress|StreetAddressExt|StreetInt|BuildingName)$/;
    const c = (j.candidates || []).filter((c) => c && c.location && Number(c.score != null ? c.score : (c.attributes || {}).Score) >= 88 && ok.test((c.attributes || {}).Addr_type || '') &&
      c.location.x >= WA_EXTENT.xmin && c.location.x <= WA_EXTENT.xmax && c.location.y >= WA_EXTENT.ymin && c.location.y <= WA_EXTENT.ymax &&
      (!(c.attributes || {}).Match_addr || /,\s*Washington\b/i.test(c.attributes.Match_addr) || /,\s*WA\b/.test(c.attributes.Match_addr))); // the WA bbox also covers Lewiston, Portland and BC
    return c[0] || null;
  }
  async function onSubmit(ev) {
    ev.preventDefault();
    const text = $('wmQ').value.trim(), county = $('wmCounty').value;
    $('wmPicks').innerHTML = '';
    if (!text) { status('Type a street address, or tap your lot on the map.', 'warn'); $('wmQ').focus(); return; }
    const my = ++S.seq; setBusy(true); beginLookup(my, ESRI_KEY ? 'Finding your address…' : 'Searching parcel addresses…');
    try {
      if (ESRI_KEY) {
        status('Looking up the address…');
        let c = null; try { c = await esriGeocode(text); } catch (e) { console.warn('geocoder', e); }
        if (my !== S.seq) return;
        if (c && county) { // a county was picked: ignore a match that falls outside it and search that county's parcels instead
          try { const e = await countyEnv(county); if (c.location.x < e[0] || c.location.x > e[2] || c.location.y < e[1] || c.location.y > e[3]) c = null; } catch (_) {}
          if (my !== S.seq) return;
        }
        if (c) { S.geocoded = 'esri'; await lookupPoint([c.location.x, c.location.y], my); return; }
        if (!county) { status('We could not place that address. Pick your county and try again; we will search its parcel addresses.', 'warn'); $('wmCounty').focus(); return; }
      }
      if (!county) { status('Pick your county first. We search that county’s parcel addresses.', 'warn'); $('wmCounty').focus(); return; }
      status('Searching ' + county + ' County parcel addresses…'); lookupLoader(my, 'Searching parcel addresses…');
      let list;
      try { list = await situsSearch(text, county); }
      catch (e) {
        if (my !== S.seq) return;
        if (e.message === 'needs-number') { status('Start with the house number, for example 128 N 2nd St.', 'warn'); $('wmQ').focus(); return; }
        console.warn('situs search', e); status('The statewide parcel service did not answer. Try again in a minute, or tap your lot on the map.', 'error'); return;
      }
      if (my !== S.seq) return;
      if (!list.length) { status('No parcel in ' + county + ' County has that address on file. Some parcels have no address in the statewide data. Try fewer words, or tap your lot on the map.', 'warn'); return; }
      if (list.length === 1) { S.geocoded = 'parcel'; await runLot(list[0], null, my); return; }
      S.picks = list; renderPicks(list, county);
    } finally { if (my === S.seq) { setBusy(false); lookupLoader(my, ''); } }
  }
  function renderPicks(list, county) {
    status(list.length + ' parcels match in ' + county + ' County. Pick yours below.');
    $('wmPicks').innerHTML = '<ul class="wm-picks" aria-label="Matching parcels">' + list.map((f, i) => { const p = f.properties;
      return '<li><button type="button" data-pick="' + i + '"><b>' + esc(realAddr(p.SITUS_ADDRESS) || 'No street address') + (p.SUB_ADDRESS ? ' ' + esc(p.SUB_ADDRESS) : '') + '</b><span>' +
        esc([p.SITUS_CITY_NM ? titleCase(p.SITUS_CITY_NM) : '', 'Parcel ' + p.PARCEL_ID_NR].filter(Boolean).join(' · ')) + '</span></button></li>'; }).join('') + '</ul>';
    const first = $('wmPicks').querySelector('button'); if (first) first.focus({ preventScroll: true });
  }
  function setBusy(b) { const g = $('wmGo'); if (g) { g.disabled = b; g.setAttribute('aria-busy', String(b)); } }

  // ---------- Lot → everything ----------
  async function tapLookup(pt) { // a tap on the map, the locate button or a ?lat=&lng= link
    const my = ++S.seq; beginLookup(my, 'Finding your lot…');
    try { await lookupPoint(pt, my); } finally { lookupLoader(my, ''); }
  }
  async function pickLookup(f) { const my = ++S.seq; S.geocoded = 'parcel'; beginLookup(my, 'Reading the creeks…');
    try { await runLot(f, null, my); } finally { lookupLoader(my, ''); } }
  async function lookupPoint(pt, my) {
    my = my || ++S.seq;
    status('Finding the tax parcel at that spot…'); lookupLoader(my, 'Finding your lot…'); placePoint(pt);
    const base = Object.assign(ptParams(pt), { outFields: PARCEL_FIELDS, geometryPrecision: 7 });
    let lot = null;
    try {
      let r = await queryGeo(SVC.parcels, base, 20000);
      if (my !== S.seq) return;
      if (r.features.length) lot = r.features.map((f) => [f, planarLot(f).area]).sort((a, b) => a[1] - b[1])[0][0]; // stacked parcels: the smallest
      else {
        r = await queryGeo(SVC.parcels, Object.assign({}, base, { distance: NEAR_LOT_M, units: 'esriSRUnit_Meter', resultRecordCount: 30 }), 20000);
        if (my !== S.seq) return;
        let bd = Infinity;
        r.features.forEach((f) => { const L = planarLot(f), p = L.P.f(pt); let d = Infinity; const E = L.edges;
          for (let e = 0; e < E.length; e += 4) d = Math.min(d, psd2(p[0], p[1], E[e], E[e + 1], E[e + 2], E[e + 3])); if (d < bd) { bd = d; lot = f; } });
      }
    } catch (e) { if (my !== S.seq) return; console.warn('parcel', e); status('The statewide parcel service did not answer. Try again in a minute.', 'error'); return; }
    if (!lot) { status('No tax parcel found within ' + Math.round(NEAR_LOT_M * M2FT) + ' ft of that spot. Zoom in and tap inside your lot.', 'warn'); return; }
    await runLot(lot, pt, my);
  }

  async function runLot(lot, pt, my) {
    if (my !== S.seq) return;
    const L = planarLot(lot);
    // 2026-10-15 (review): lots in the Walla Walla map's area (app.js AREA_BBOX) get the Walla Walla map, which uses the City's and County's own buffer layers — never a second, statewide answer for the same lot
    { const c = L.inner; if (c && c[0] >= -118.52 && c[0] <= -118.14 && c[1] >= 45.96 && c[1] <= 46.16) {
      status('This lot is in the Walla Walla area. Opening the detailed Walla Walla map for it…');
      location.assign('/?lat=' + c[1].toFixed(6) + '&lng=' + c[0].toFixed(6) + '&w=100'); return; } }
    S.lot = lot; S.geo = L; S.pt = pt || L.inner; S.nearLL = null; S.dnr = null; S.rmz = null; S.water = null; S.bands = {}; S.juris = null; S.dist = null; S.sd = null;
    const b = L.bbox, dLng = SEARCH_M / L.P.kx, dLat = SEARCH_M / L.P.ky;
    S.env = [b[0] - dLng, b[1] - dLat, b[2] + dLng, b[3] + dLat];
    $('wmPicks').innerHTML = '';
    renderShell(lot);
    S.userMoved = false; drawLot(); fitLot();
    status('Lot found. Reading streams, the WDFW estimate and who sets the rules…'); lookupLoader(my, 'Reading the creeks…');
    await pause(); if (my !== S.seq) return;
    const jP = jurisdiction(L.inner, lot).then((j) => { if (my !== S.seq) return; S.juris = j; renderJuris(); return j; })
      .catch((e) => { console.warn('jurisdiction', e); if (my === S.seq) { S.juris = { error: true }; renderJuris(); } });
    const cP = loadContent().catch((e) => { console.warn('content', e); return null; });
    const dP = loadStreams(S.env).then((d) => analyseStreams(d, my)).catch((e) => { console.warn('dnr', e); if (my === S.seq) renderStreamsError(); });
    const rP = loadRmz(S.env).then((r) => analyseRmz(r, my)).catch((e) => { console.warn('rmz', e); if (my === S.seq) renderRmzError(); });
    const wP = loadWater(S.env).then((w) => analyseWater(w, my)).catch((e) => { console.warn('water', e); if (my === S.seq) renderWaterError(); });
    await Promise.all([jP, cP]); if (my !== S.seq) return;
    renderCounty(); renderNext();
    await Promise.all([dP, rP, wP]); if (my !== S.seq) return;
    status('Done. Your lot, nearby mapped streams and the what-if band are on the map.', 'ok');
    document.documentElement.classList.add('wm-has-result');
  }

  async function jurisdiction(pt, lot) {
    const p = ptParams(pt);
    const [cu, co] = await Promise.allSettled([queryAttrs(SVC.cityUga, Object.assign({ outFields: 'CITY_NM,UGA_NM,COUNTY_NM' }, p), 20000),
      queryAttrs(SVC.counties, Object.assign({ outFields: 'JURLBL,JURNM' }, p), 20000)]);
    let county = co.status === 'fulfilled' && co.value[0] ? co.value[0].JURLBL : '';
    const rows = cu.status === 'fulfilled' ? cu.value : [];
    if (!county && rows[0] && rows[0].COUNTY_NM && COUNTY_NAMES.includes(rows[0].COUNTY_NM)) county = rows[0].COUNTY_NM;
    if (!county) { const f = (lot.properties || {}).FIPS_NR; if (f && NAME_BY_FIPS[f]) county = NAME_BY_FIPS[f]; else if (String((lot.properties || {}).PARCEL_ID_NR || '').startsWith('003-')) county = 'Asotin'; }
    const city = rows.find((r) => r.CITY_NM), uga = rows.find((r) => r.UGA_NM);
    if (cu.status !== 'fulfilled') return { county: county, kind: 'unknown', label: county ? county + ' County (city limits did not load)' : 'Could not load' };
    if (city) return { county: county, kind: 'city', city: city.CITY_NM, label: city.CITY_NM + ' (inside city or town limits)' };
    const ugaName = uga ? String(uga.UGA_NM).replace(/\s*UGA$/i, '') : '';
    if (uga) return { county: county, kind: 'uga', uga: ugaName, label: 'Unincorporated ' + county + ' County (' + ugaName + ' urban growth area)' };
    return { county: county, kind: 'county', label: 'Unincorporated ' + county + ' County' };
  }
  async function loadContent() {
    if (S.content) return S.content;
    const r = await fetch('content/washington.json', { cache: 'no-cache' }); if (!r.ok) throw new Error('HTTP ' + r.status);
    S.content = await r.json(); return S.content;
  }
  async function loadStreams(env) {
    const j = await queryGeo(SVC.dnr, Object.assign(envParams(env), { where: '1=1', outFields: DNR_FIELDS, maxAllowableOffset: 0.00002, geometryPrecision: 6, resultRecordCount: 1000 }), 25000);
    return j;
  }
  async function loadRmz(env) {
    const j = await queryGeo(SVC.rmz, Object.assign(envParams(env), { where: "Zone='RMZ'", outFields: 'Zone', maxAllowableOffset: 0.00002, geometryPrecision: 6, resultRecordCount: 2000 }), 25000);
    return j;
  }
  function kindOf(p) { const h = String(p.WC_HYDR_FTR_LABEL_NM || ''); if (!h || h === 'Streams' || h === 'Side channel') return 'stream'; if (h === 'Ditches') return 'ditch'; if (h === 'Pipelines') return 'pipe'; return 'other'; }

  async function analyseStreams(j, my) {
    if (my !== S.seq) return;
    const L = S.geo, lb = L.bbox;
    let feats = j.features.map((f) => { const p = f.properties || {}; const t = /^[FNSUX]$/.test(p.FP_WTRTY_CD || '') ? p.FP_WTRTY_CD : 'X';
      return { type: 'Feature', geometry: f.geometry, properties: { t: t, k: kindOf(p), n: p.WC_GNIS_NM || '', per: p.WC_PERIOD_LABEL_NM || '', h: p.WC_HYDR_FTR_LABEL_NM || '' }, _b: geomBbox(f.geometry) }; });
    if (feats.length > MAX_DNR) feats = feats.map((f) => [f, boxGap2(f._b, lb)]).sort((a, b) => a[1] - b[1]).slice(0, MAX_DNR).map((a) => a[0]);
    S.dnr = { feats: feats, capped: j.features.length >= 1000 || j.exceededTransferLimit };
    drawStreams();
    await pause(); if (my !== S.seq) return;
    const lines = []; feats.forEach((f, i) => linesOf(f.geometry).forEach((c) => { if (c.length > 1) lines.push({ c: c, f: i }); }));
    const SG = buildSegs(lines, L.P);
    const isStream = (i) => feats[i].properties.k === 'stream';
    const dS = lotDistance(L, SG, isStream), dAny = lotDistance(L, SG, null);
    S.dist = { stream: dS, any: dAny };
    if (dS.k >= 0 && dS.d > 0 && dS.d <= 450) { const o = dS.k * 4, c = L.P.f(L.inner), ax = SG.A[o], ay = SG.A[o + 1], dx = SG.A[o + 2] - ax, dy = SG.A[o + 3] - ay, ll = dx * dx + dy * dy;
      let t = ll ? ((c[0] - ax) * dx + (c[1] - ay) * dy) / ll : 0; t = Math.max(0, Math.min(1, t)); S.nearLL = L.P.inv(ax + t * dx, ay + t * dy); fitWith(S.nearLL); }
    await pause(); if (my !== S.seq) return;
    S.sd = await sampleDistances(L, SG, isStream, my); if (my !== S.seq || !S.sd) return;
    S.bandLines = lines.filter((l) => isStream(l.f)).map((l) => l.c);
    renderStreams(); renderBandShare();
    if (!S.bands[S.w]) lookupLoader(my, 'Drawing the what-if band…');
    await buildBand(S.w, my); // 2026-10-15: awaited, so "Done … the what-if band are on the map" is true when it shows (turf now loads lazily)
  }

  async function analyseRmz(j, my) {
    if (my !== S.seq) return;
    const L = S.geo; let polys = j.features;
    if (polys.length > MAX_RMZ) polys = polys.map((f) => [f, boxGap2(geomBbox(f.geometry), L.bbox)]).sort((a, b) => a[1] - b[1]).slice(0, MAX_RMZ).map((a) => a[0]);
    S.rmz = { feats: polys };
    drawRmz();
    await pause(); if (my !== S.seq) return;
    const cand = polys.filter((f) => boxGap2(geomBbox(f.geometry), L.bbox) === 0).map((f) => polysOf(f.geometry).map((p) => p.map((r) => r.map(L.P.f))));
    let inS = 0, inB = 0, touch = false; const nS = L.samples.length / 2, nB = L.bnd.length / 2;
    if (cand.length) {
      const inAny = (x, y) => { for (let c = 0; c < cand.length; c++) if (inPolys(x, y, cand[c])) return true; return false; };
      let t0 = now();
      for (let i = 0; i < L.samples.length; i += 2) { if (inAny(L.samples[i], L.samples[i + 1])) inS++; if ((i & 63) === 0 && now() - t0 > TASK_MS) { await pause(); if (my !== S.seq) return; t0 = now(); } }
      for (let i = 0; i < L.bnd.length; i += 2) if (inAny(L.bnd[i], L.bnd[i + 1])) inB++;
      if (!inS && !inB) { // a sliver: test edge crossings
        const E = L.edges;
        outer: for (let c = 0; c < cand.length; c++) { const RE = edgesOf(cand[c]);
          for (let a = 0; a < RE.length; a += 4) { const sb = [Math.min(RE[a], RE[a + 2]), Math.min(RE[a + 1], RE[a + 3]), Math.max(RE[a], RE[a + 2]), Math.max(RE[a + 1], RE[a + 3])];
            if (boxGap2(sb, L.pb) > 0) continue;
            for (let e = 0; e < E.length; e += 4) if (segCross(RE[a], RE[a + 1], RE[a + 2], RE[a + 3], E[e], E[e + 1], E[e + 2], E[e + 3])) { touch = true; break outer; } } }
      }
    }
    const share = nS ? inS / nS : 0;
    S.rmzRes = { none: !polys.length, state: (inS === nS && inB === nB && nS) ? 'yes' : (inS || inB || touch) ? 'partly' : 'no', share: share };
    renderRmz();
  }

  // ---------- 2026-10-16 (Phase A): DNR Water Bodies (lakes, ponds, reservoirs, wide rivers, marine water) ----------
  // Distance is measured from the lot to each mapped water edge (exact, planar), inside counts as 0. Big polygons (Puget Sound,
  // Hood Canal, the Columbia) come back whole, so only their edges near the checked area are measured, and the map draws them
  // clipped to that area. 3 m generalization: Hood Canal, the largest case tried, is about 110 KB gzipped (378 KB raw).
  async function loadWater(env) {
    return queryGeo(SVC.water, Object.assign(envParams(env), { where: WATER_WHERE, outFields: WATER_FIELDS, maxAllowableOffset: 0.00003, geometryPrecision: 6, resultRecordCount: 200 }), 25000);
  }
  const cleanName = (s) => (typeof s === 'string' ? s.replace(/[\u0000-\u001f\u007f<>]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80) : '');
  const goodRing = (r) => Array.isArray(r) && r.length >= 4 && r.every((c) => Array.isArray(c) && isFinite(c[0]) && isFinite(c[1]));
  function clipRing(r, b) { // Sutherland–Hodgman against [xmin, ymin, xmax, ymax] (drawing only); null if nothing is left
    let pts = r.slice(0, -1);
    const sides = [[0, b[0], 1], [0, b[2], -1], [1, b[1], 1], [1, b[3], -1]];
    for (let s = 0; s < 4 && pts.length; s++) { const ax = sides[s][0], bd = sides[s][1], sg = sides[s][2], out = [];
      for (let i = 0; i < pts.length; i++) { const p = pts[i], q = pts[(i + 1) % pts.length], pin = sg * (p[ax] - bd) >= 0, qin = sg * (q[ax] - bd) >= 0;
        if (pin) out.push(p);
        if (pin !== qin) { const t = (bd - p[ax]) / (q[ax] - p[ax]); out.push(ax === 0 ? [bd, p[1] + t * (q[1] - p[1])] : [p[0] + t * (q[0] - p[0]), bd]); } }
      pts = out; }
    if (pts.length < 3) return null; pts.push(pts[0]); return pts;
  }
  async function analyseWater(j, my) {
    if (my !== S.seq) return;
    const L = S.geo, P = L.P, e = S.env, gx = (e[2] - e[0]) * 0.1, gy = (e[3] - e[1]) * 0.1, grow = [e[0] - gx, e[1] - gy, e[2] + gx, e[3] + gy];
    const g0 = P.f([grow[0], grow[1]]), g1 = P.f([grow[2], grow[3]]), gp = [g0[0], g0[1], g1[0], g1[1]];
    let feats = [];
    (j.features || []).forEach((f) => { const p = f.properties || {}, cart = p.WB_CART_FTR_LABEL_NM;
      if (typeof cart !== 'string' || !Object.prototype.hasOwnProperty.call(WATER_KIND, cart)) return;
      const polys = polysOf(f.geometry || {}).map((pl) => (Array.isArray(pl) ? pl.filter(goodRing) : [])).filter((pl) => pl.length);
      if (!polys.length) return;
      const b = [Infinity, Infinity, -Infinity, -Infinity]; polys.forEach((pl) => bboxOfCoords(pl[0], b));
      feats.push({ polys: polys, b: b, props: { k: WATER_KIND[cart], t: /^[FNSUX]$/.test(p.FP_WTRTY_CD || '') ? p.FP_WTRTY_CD : 'X', n: cleanName(p.WB_GNIS_NM) } }); });
    if (feats.length > MAX_WATER) feats = feats.map((f) => [f, boxGap2(f.b, L.bbox)]).sort((x, y) => x[1] - y[1]).slice(0, MAX_WATER).map((x) => x[0]);
    const dist = []; let t0 = now();
    for (let i = 0; i < feats.length; i++) {
      const pr = feats[i].polys.map((pl) => pl.map((r) => r.map(P.f)));
      const A = [], B = [];
      pr.forEach((pl) => pl.forEach((r) => { for (let k = 1; k < r.length; k++) { const a = r[k - 1], c = r[k], x0 = Math.min(a[0], c[0]), y0 = Math.min(a[1], c[1]), x1 = Math.max(a[0], c[0]), y1 = Math.max(a[1], c[1]);
        if (x1 < gp[0] || x0 > gp[2] || y1 < gp[1] || y0 > gp[3]) continue; A.push(a[0], a[1], c[0], c[1]); B.push(x0, y0, x1, y1); } }));
      const n = A.length / 4, SG = { n: n, A: new Float64Array(A), B: new Float64Array(B), F: new Int32Array(n).fill(i) };
      let d = n ? lotDistance(L, SG, null).d : Infinity, inside = false;
      if (d > 0) { // no edge touches the lot: it is wholly inside the water or wholly outside (test one point per lot part)
        const c = P.f(L.inner); if (inPolys(c[0], c[1], pr) || L.polys.some((lp) => inPolys(lp[0][0][0], lp[0][0][1], pr))) { d = 0; inside = true; } }
      dist.push({ i: i, d: d, inside: inside });
      if (now() - t0 > TASK_MS) { await pause(); if (my !== S.seq) return; t0 = now(); }
    }
    dist.sort((x, y) => x.d - y.d);
    const shown = feats.map((f) => { const polys = [];
      f.polys.forEach((pl) => { const outer = clipRing(pl[0], grow); if (!outer) return; polys.push([outer].concat(pl.slice(1).map((r) => clipRing(r, grow)).filter(Boolean))); });
      return polys.length ? { type: 'Feature', properties: { k: f.props.k, t: f.props.t }, geometry: { type: 'MultiPolygon', coordinates: polys } } : null; }).filter(Boolean);
    S.water = { props: feats.map((f) => f.props), dist: dist, shown: shown, capped: !!j.exceededTransferLimit || (j.features || []).length >= 200 };
    drawWater(); renderWater(); renderBandShare();
  }
  const waterName = (p) => p.n || (p.k === 'marine' ? 'Marine water' : 'Unnamed ' + WATER_WORD[p.k]);
  const waterNear = () => (S.water ? S.water.dist.filter((x) => x.d <= S.w * FT) : []);
  function renderWater() {
    const el = $('wmWater'); if (!el || !S.water) return; el.classList.remove('wm-loading', 'wm-err');
    const W = S.water, near = waterNear(), first = W.dist[0], inArea = first && first.d <= SEARCH_M;
    const head = (x) => { const p = W.props[x.i]; return '<b>' + esc(waterName(p)) + '</b> <span class="wm-type t-' + p.t + '">' + esc(TYPE[p.t]) + '</span>' + (p.n ? ' <span class="wm-per">' + esc(WATER_WORD[p.k]) + '</span>' : ''); };
    let html;
    if (near.length) {
      const x = near[0], p = W.props[x.i];
      html = head(x) + '<span class="wm-dist">' + (x.inside ? 'This lot lies inside the mapped water area.' : x.d === 0 ? 'The mapped water edge touches this lot.' : ftLabel(x.d) + ' from the lot line to the mapped water edge, within ' + S.w + ' ft.') + '</span>';
      if (near.length > 1) html += '<span class="wm-note">Also within ' + S.w + ' ft: ' + near.slice(1, 4).map((y) => esc(waterName(W.props[y.i]))).join(', ') + (near.length > 4 ? ' and ' + (near.length - 4) + ' more' : '') + '.</span>';
      html += '<span class="wm-note">The ' + esc(WATER_WORD[p.k]) + ' is shown on the map. Rules for lakes, ponds and shorelines are separate from the stream buffer and are not checked here.</span>';
      if (near.some((y) => W.props[y.i].t === 'S')) html += '<span class="wm-note">Type S waters are usually under the local Shoreline Master Program rather than the critical areas stream buffer.</span>';
    } else if (inArea) {
      const fp = W.props[first.i];
      html = 'None within ' + S.w + ' ft of this lot.<span class="wm-note">Nearest: ' + (fp.n ? esc(fp.n) + ' (' + esc(WATER_WORD[fp.k]) + ')' : fp.k === 'marine' ? 'marine water' : 'an unnamed ' + esc(WATER_WORD[fp.k])) + ', ' + ftLabel(first.d) + ' from the lot line.</span>';
    } else html = 'No DNR-mapped lake, pond, wide river or marine water in the area checked around this lot.';
    if (near.length || inArea) html += '<span class="wm-note">Measured to DNR’s mapped water edge, which is approximate.</span>';
    if (W.capped) html += '<span class="wm-note">Dense area: we read the first 200 water bodies DNR returned, so some small ponds may be missing.</span>';
    el.innerHTML = html;
  }
  function renderWaterError() { const el = $('wmWater'); if (el) { el.classList.remove('wm-loading'); el.classList.add('wm-err'); el.textContent = 'The DNR water body service did not answer. Try again in a minute.'; } }

  // ---------- 2026-10-16 (Phase A): next steps (share link, official page, who to contact; all local) ----------
  function shareUrl() { const c = S.geo && S.geo.inner; if (!c) return '';
    try { return new URL('wa/?lat=' + c[1].toFixed(6) + '&lng=' + c[0].toFixed(6) + '&width=' + S.w, document.baseURI).href; } catch (_) { return ''; } }
  const httpUrl = (u) => /^https?:\/\//i.test(String(u || ''));
  const firstOfficial = (x) => ((x && Array.isArray(x.links)) ? x.links : []).find((l) => l && l.label && httpUrl(l.url)) || null;
  const COUNCIL = /\b(council|commissioners|county commission|board of county commissioners)\b/i;
  function contactOf(x) { // the optional "contact" field (county commission or city council page), else a link that names one
    if (!x) return null; const k = x.contact;
    if (k && typeof k === 'object' && k.label && httpUrl(k.url)) return k;
    return (Array.isArray(x.links) ? x.links : []).find((l) => l && l.label && httpUrl(l.url) && COUNCIL.test(String(l.label)) && !/planning commission/i.test(String(l.label))) || null;
  }
  function setShare() { const u = shareUrl(), i = $('wmShareUrl'); if (i && u) i.value = u; }
  function renderNext() {
    const off = $('wmOfficial'), con = $('wmContact'); if (!off || !con) return; off.classList.remove('wm-loading'); con.classList.remove('wm-loading');
    const j = S.juris || {}, name = j.county, data = S.content, c = name && data && data.counties ? data.counties[name] : null, pl = placeMatch(c, j), s = name ? slug(name) : '';
    const o = firstOfficial(pl) ? { who: pl.name, l: firstOfficial(pl) } : firstOfficial(c) ? { who: name + ' County', l: firstOfficial(c) } : null;
    if (name && !c) off.innerHTML = '<b>Find the official page.</b> Our county list did not load. <a href="county/' + esc(s) + '.html">' + esc(name) + ' County page →</a>';
    else if (o) off.innerHTML = '<b>Read the official page.</b> ' + linkHtml({ label: o.who + ': ' + o.l.label, url: o.l.url }) +
      (j.kind === 'city' && !pl ? '<span class="wm-note">' + esc(j.city) + ' sets the rules inside its limits; its planning office can tell you which apply.</span>' : '');
    else if (name) off.innerHTML = '<b>Find the official page.</b> We have not added one for ' + esc(name) + ' County yet. Its planning or community development department is the place to start. <a href="county/' + esc(s) + '.html">' + esc(name) + ' County page →</a>';
    else off.innerHTML = '<b>Find the official page.</b> Your city or county planning office can tell you which rules apply.';
    const k = j.kind === 'city' ? contactOf(pl) : contactOf(c);
    con.innerHTML = '<b>Who to contact.</b> ' + (k ? linkHtml(k) : name ? '<a href="washington.html#c-' + esc(s) + '">' + esc(name) + ' County on Where does your county stand? →</a>' : '<a href="washington.html">Where does your county stand? →</a>');
  }
  async function copyShare() {
    const u = shareUrl(), msg = $('wmShareMsg'), i = $('wmShareUrl'); if (!u) return; let ok = false;
    try { if (navigator.clipboard && navigator.clipboard.writeText) { await navigator.clipboard.writeText(u); ok = true; } } catch (_) { ok = false; }
    if (!ok && i) { try { i.focus(); i.select(); ok = document.execCommand && document.execCommand('copy'); } catch (_) { ok = false; } }
    if (msg) msg.textContent = ok ? 'Link copied.' : 'Select the link above and copy it.';
  }
  async function nativeShare() {
    const u = shareUrl(); if (!u || !navigator.share) return;
    try { await navigator.share({ title: 'CreekChecker', text: 'Mapped creeks near this Washington lot', url: u }); } catch (_) {} // a closed share sheet is not an error
  }

  // ---------- What-if band: cell-by-cell turf buffers, clipped to disjoint cells (no overlaps, no long tasks) ----------
  function clipLine(c, bb) { // Liang–Barsky per segment; returns runs inside bb
    const runs = []; let cur = null;
    for (let i = 1; i < c.length; i++) {
      let x0 = c[i - 1][0], y0 = c[i - 1][1], x1 = c[i][0], y1 = c[i][1], t0 = 0, t1 = 1; const dx = x1 - x0, dy = y1 - y0; let ok = true;
      const pq = [[-dx, x0 - bb[0]], [dx, bb[2] - x0], [-dy, y0 - bb[1]], [dy, bb[3] - y0]];
      for (let k = 0; k < 4 && ok; k++) { const p = pq[k][0], q = pq[k][1];
        if (p === 0) { if (q < 0) ok = false; } else { const r = q / p; if (p < 0) { if (r > t1) ok = false; else if (r > t0) t0 = r; } else { if (r < t0) ok = false; else if (r < t1) t1 = r; } } }
      if (!ok) { cur = null; continue; }
      const a = [x0 + t0 * dx, y0 + t0 * dy], b = [x0 + t1 * dx, y0 + t1 * dy];
      if (cur && t0 === 0) cur.push(b); else { cur = [a, b]; runs.push(cur); }
      if (t1 < 1) cur = null;
    }
    return runs;
  }
  function outlineOf(geom, cb) { // polygon ring segments not lying on the cell's edges
    const out = []; const onEdge = (a, b) => (a[0] === b[0] && (a[0] === cb[0] || a[0] === cb[2])) || (a[1] === b[1] && (a[1] === cb[1] || a[1] === cb[3]));
    polysOf(geom).forEach((p) => p.forEach((r) => { let run = null;
      for (let i = 1; i < r.length; i++) { if (onEdge(r[i - 1], r[i])) { run = null; continue; } if (!run) { run = [r[i - 1]]; out.push(run); } run.push(r[i]); } }));
    return out;
  }
  async function buildBand(w, my) {
    if (S.bands[w]) { drawBand(); return; }
    if (!S.bandLines) return;
    if (!window.turf) { await loadTurf(); if (my !== S.seq) return; } // turf is fetched when a lookup starts; usually here already
    if (S.bands[w]) { if (w === S.w) drawBand(); return; }
    if (!window.turf) { const n = $('wmBandNote'); if (n) n.textContent = 'The band drawing library did not load; the share above is still computed.'; return; }
    const job = ++S.bandJob, m = w * FT, P = S.geo.P, env = S.env;
    const lines = S.bandLines.map((c) => ({ c: c, b: bboxOfCoords(c) }));
    const spanX = (env[2] - env[0]) * P.kx, spanY = (env[3] - env[1]) * P.ky;
    const cellM = Math.max(300, Math.max(spanX, spanY) / 8), nx = Math.ceil(spanX / cellM), ny = Math.ceil(spanY / cellM);
    const cw = (env[2] - env[0]) / nx, ch = (env[3] - env[1]) / ny, mx = (m + 2) / P.kx, myy = (m + 2) / P.ky;
    const cells = [];
    for (let iy = 0; iy < ny; iy++) for (let ix = 0; ix < nx; ix++) {
      const cb = [env[0] + ix * cw, env[1] + iy * ch, ix === nx - 1 ? env[2] : env[0] + (ix + 1) * cw, iy === ny - 1 ? env[3] : env[1] + (iy + 1) * ch];
      cells.push(cb);
    }
    const fills = [], edges = []; let t0 = now();
    const doCell = (cb, depth) => {
      const gb = [cb[0] - mx, cb[1] - myy, cb[2] + mx, cb[3] + myy]; const parts = []; let nv = 0;
      lines.forEach((l) => { if (boxGap2(l.b, gb) > 0) return; clipLine(l.c, gb).forEach((r) => { parts.push(r); nv += r.length; }); });
      if (!parts.length) return;
      if (nv > 300 && depth < 3) { const xm = (cb[0] + cb[2]) / 2, ym = (cb[1] + cb[3]) / 2;
        [[cb[0], cb[1], xm, ym], [xm, cb[1], cb[2], ym], [cb[0], ym, xm, cb[3]], [xm, ym, cb[2], cb[3]]].forEach((s) => queue.push([s, depth + 1])); return; }
      let buf = null; try { buf = turf.buffer(turf.multiLineString(parts), m, { units: 'meters', steps: 6 }); } catch (e) { console.warn('band cell', e); return; }
      if (!buf || !buf.geometry) return;
      const clip = turf.bboxClip(buf, cb); if (!clip || !clip.geometry || !polysOf(clip.geometry).length) return;
      fills.push({ type: 'Feature', properties: {}, geometry: clip.geometry });
      const o = outlineOf(clip.geometry, cb); if (o.length) edges.push({ type: 'Feature', properties: {}, geometry: { type: 'MultiLineString', coordinates: o } });
    };
    // cells nearest the lot first, so the part that matters draws first
    const lc = [(S.geo.bbox[0] + S.geo.bbox[2]) / 2, (S.geo.bbox[1] + S.geo.bbox[3]) / 2];
    const queue = cells.map((cb) => [cb, 0]).sort((a, b) => boxGap2(a[0], [lc[0], lc[1], lc[0], lc[1]]) - boxGap2(b[0], [lc[0], lc[1], lc[0], lc[1]]));
    let drawn = 0;
    while (queue.length) {
      const [cb, depth] = queue.shift(); doCell(cb, depth);
      if (now() - t0 > TASK_MS) {
        if (fills.length - drawn > 0 && drawn === 0 && w === S.w) { S.bands[w] = { fill: fc(fills.slice()), line: fc(edges.slice()), partial: true }; drawBand(); drawn = fills.length; }
        await pause(); if (my !== S.seq || job !== S.bandJob) return; t0 = now();
      }
    }
    S.bands[w] = { fill: fc(fills), line: fc(edges) };
    if (w === S.w) drawBand();
  }
  function setWidth(w) {
    if (!WIDTHS.includes(w)) return; S.w = w;
    document.querySelectorAll('[data-wm-w]').forEach((b) => b.setAttribute('aria-pressed', String(Number(b.dataset.wmW) === w)));
    const lg = $('wmLegendBand'); if (lg) lg.textContent = 'What-if ' + w + ' ft — a width you pick, not an official buffer';
    renderBandShare(); renderWater(); setShare(); // 2026-10-16: the water row and the share link follow the width
    if (S.geo && S.bandLines) { drawBand(); buildBand(w, S.seq); }
  }

  // ---------- Rendering: result card ----------
  const realAddr = (a) => { a = squash(String(a || '').replace(/\s{2,}[^,]*,\s*WA\b.*$/i, '')); // Asotin appends '   CITY, WA ZIP'
    return (!a || /UNDETERMINED|UNKNOWN|NO SITUS|^0+(\s|$)/.test(a)) ? '' : a; };
  function renderShell(lot) {
    const p = lot.properties || {}; const addr = realAddr(p.SITUS_ADDRESS);
    const link = /^https?:\/\//i.test(p.DATA_LINK || '') ? '<a href="' + esc(p.DATA_LINK) + '" target="_blank" rel="noopener">County assessor page ↗</a>' : '';
    $('wmEmpty').hidden = true; const r = $('wmResult'); r.hidden = false;
    r.innerHTML =
      '<div id="wmWW"></div>' +
      '<article class="wm-card wm-lotcard" aria-labelledby="wmLotTitle"><p class="wm-kicker">Lot</p>' +
      '<h2 id="wmLotTitle" class="wm-addr">' + (addr ? esc(addr) + (p.SUB_ADDRESS ? ' ' + esc(p.SUB_ADDRESS) : '') : 'No street address on file') + '</h2>' +
      '<p class="wm-sub">Parcel <span class="wm-id">' + esc(p.PARCEL_ID_NR || 'unknown') + '</span>' + (link ? ' · ' + link : '') + '</p>' +
      '<div class="wm-confirm" id="wmConfirm" role="group" aria-labelledby="wmConfirmQ"><span id="wmConfirmQ">Is this your lot?</span>' +
      '<button type="button" class="btn" id="wmYes">Yes</button><button type="button" class="btn" id="wmNo">No, let me tap it</button></div></article>' +
      '<dl class="wm-facts">' +
      '<div><dt>Who sets the rules here</dt><dd id="wmJuris" class="wm-loading">Checking city limits and urban growth areas…</dd></div>' +
      '<div><dt>Nearest mapped stream</dt><dd id="wmStream" class="wm-loading">Reading DNR watercourses…</dd></div>' +
      '<div><dt>Mapped lakes, ponds, wide rivers and marine water</dt><dd id="wmWater" class="wm-loading">Reading DNR water bodies…</dd></div>' +
      '<div><dt>Inside WDFW’s estimated riparian management zone?</dt><dd id="wmRmz" class="wm-loading">Reading the WDFW estimate…</dd></div>' +
      '<div class="wm-band-row"><dt>What-if band</dt><dd><div class="wm-pills" role="group" aria-label="What-if width in feet">' +
      WIDTHS.map((w) => '<button type="button" data-wm-w="' + w + '" aria-pressed="' + (w === S.w) + '" aria-label="' + w + ' feet">' + w + '</button>').join('') +
      '</div><p class="wm-pill-unit">feet from the mapped stream line</p><p id="wmBand" class="wm-loading">Measuring…</p>' +
      '<p class="wm-note" id="wmBandNote">A width you pick, not an official buffer. Drawn from DNR’s mapped stream centerlines; ditches, canals and pipes get no band here.</p></dd></div>' +
      '</dl>' +
      '<p class="wm-notchecked"><b>Not checked here:</b> wetlands, steep slopes, flood areas, and the shoreline rules for lakes and marine water. Each has its own rules; your city or county planning office can tell you which apply. Lakes, ponds and marine water are shown only where DNR maps them.</p>' +
      '<section class="wm-card wm-county" id="wmCountyCard" aria-labelledby="wmCountyTitle"><p class="wm-kicker">Your county</p><h2 id="wmCountyTitle">Loading…</h2></section>' +
      '<p class="wm-fine"><b>An awareness tool, not a legal determination.</b> Streams and water bodies: WA DNR data; DNR says its water types are “intended for DNR Forest Practices regulatory purposes only.” Lots: WaTech statewide parcels, “for informational purposes only.” The WDFW zone is an estimate; site-scale delineation “requires field verification.” Only your county or city can say what applies to this property. <a href="wa/#wmAbout">About the data</a></p>' +
      '<section class="wm-card wm-next" id="wmNext" aria-labelledby="wmNextTitle"><h2 id="wmNextTitle">Next steps for this lot</h2><ol class="wm-steps">' +
      '<li><b>Share this lot.</b> The link opens this same lot and width.<div class="wm-share"><input id="wmShareUrl" type="url" readonly aria-label="Link to this lot" spellcheck="false">' +
      '<button type="button" class="btn" id="wmCopy">Copy link</button><button type="button" class="btn" id="wmShareBtn" hidden>Share…</button></div><p class="wm-note" id="wmShareMsg" role="status" aria-live="polite"></p></li>' +
      '<li id="wmOfficial" class="wm-loading">Finding the official page…</li><li id="wmContact" class="wm-loading">Finding who to contact…</li></ol></section>' +
      '<div class="actions wm-again"><button type="button" class="btn" id="wmAgain">Check another address</button></div>';
    r.querySelectorAll('[data-wm-w]').forEach((b) => b.addEventListener('click', () => setWidth(Number(b.dataset.wmW))));
    $('wmYes').addEventListener('click', () => { $('wmConfirm').innerHTML = '<span>Thanks. The checks below use this lot.</span>'; });
    $('wmNo').addEventListener('click', () => { status('Tap your lot on the map. Zoom in first if you need to.'); scrollToMap(); });
    $('wmAgain').addEventListener('click', () => { const q = $('wmQ'); q.value = ''; q.focus({ preventScroll: true }); $('wmSearch').scrollIntoView({ block: 'start', behavior: RMQ.matches ? 'auto' : 'smooth' }); });
    setShare(); $('wmCopy').addEventListener('click', copyShare); $('wmShareUrl').addEventListener('focus', (e) => { try { e.target.select(); } catch (_) {} });
    if (navigator.share) { const b = $('wmShareBtn'); b.hidden = false; b.addEventListener('click', nativeShare); }
  }
  function renderJuris() {
    const el = $('wmJuris'); if (!el) return; el.classList.remove('wm-loading'); const j = S.juris;
    if (!j || j.error) { el.textContent = 'The city-limits service did not answer. Try again in a minute.'; el.classList.add('wm-err'); return; }
    let extra = '';
    if (j.kind === 'city') extra = 'Inside city limits, the city’s critical areas rules apply (some small cities adopt their county’s rules instead).';
    else if (j.kind === 'uga') extra = 'Unincorporated land, including urban growth areas, is generally under the county’s rules.';
    else if (j.kind === 'county') extra = 'Outside city limits, the county’s rules generally apply.';
    el.innerHTML = '<b>' + esc(j.label) + '</b>' + (extra ? '<span class="wm-note">' + esc(extra) + '</span>' : '');
    const ww = $('wmWW');
    if (ww && j.kind === 'city' && /^walla walla$/i.test(j.city || '')) {
      const ll = S.geo.inner;
      ww.innerHTML = '<a class="wm-ww" href="./?lat=' + ll[1].toFixed(6) + '&amp;lng=' + ll[0].toFixed(6) + '"><b>For Walla Walla city lots, use the detailed City map →</b><span>It uses the City’s own 100-ft buffer layer and the current draft.</span></a>';
    }
  }
  function renderStreams() {
    const el = $('wmStream'); if (!el) return; el.classList.remove('wm-loading'); const d = S.dist, F = S.dnr.feats;
    if (!d || d.stream.f < 0 || d.stream.d > SEARCH_M) {
      el.innerHTML = 'No DNR-mapped stream within about ' + (Math.round(SEARCH_M * M2FT / 10) * 10).toLocaleString('en-US') + ' ft of this lot.' + '<span class="wm-note">Mapped lakes, ponds and marine water are in the next row. Wetlands are not checked here.</span>' +
        (d && d.any.f >= 0 && d.any.d <= SEARCH_M ? '<span class="wm-note">A mapped ' + esc(kindWord(F[d.any.f].properties)) + ' is ' + ftLabel(d.any.d) + ' away.</span>' : '');
      return;
    }
    const p = F[d.stream.f].properties;
    let html = '<b>' + esc(p.n ? titleCase(p.n) : 'Unnamed stream') + '</b> <span class="wm-type t-' + p.t + '">' + esc(TYPE[p.t]) + '</span>' + (/^(perennial|intermittent)$/i.test(p.per) ? ' <span class="wm-per">' + esc(p.per.toLowerCase()) + '</span>' : '') +
      '<span class="wm-dist">' + (d.stream.d === 0 ? 'The mapped stream line crosses this lot.' : ftLabel(d.stream.d) + ' from the lot line to the mapped stream line.') + '</span>';
    if (p.t === 'S') html += '<span class="wm-note">Type S waters are usually under the local Shoreline Master Program rather than the critical areas stream buffer.</span>';
    if (d.any.f >= 0 && d.any.f !== d.stream.f && d.any.d < d.stream.d - 1 && F[d.any.f].properties.k !== 'stream') html += '<span class="wm-note">A mapped ' + esc(kindWord(F[d.any.f].properties)) + ' is closer: ' + ftLabel(d.any.d) + '.</span>';
    html += '<span class="wm-note">Measured to DNR’s mapped centerline. Local rules usually measure from the stream’s edge (the ordinary high water mark or top of bank), and mapped lines are approximate, so the real distance can differ.</span>';
    if (S.dnr.capped) html += '<span class="wm-note">Dense area: DNR returned its maximum of 1,000 lines, so some small channels may be missing.</span>';
    el.innerHTML = html;
  }
  function kindWord(p) { return p.k === 'ditch' ? 'ditch or canal' : p.k === 'pipe' ? 'pipe' : p.h ? p.h.toLowerCase().replace(/s$/, '') : 'water feature'; }
  function renderStreamsError() { const el = $('wmStream'); if (el) { el.classList.remove('wm-loading'); el.classList.add('wm-err'); el.textContent = 'The DNR stream service did not answer. Try again in a minute.'; }
    const b = $('wmBand'); if (b) { b.classList.remove('wm-loading'); b.textContent = 'Needs the DNR stream lines, which did not load.'; } }
  function renderRmzError() { const el = $('wmRmz'); if (el) { el.classList.remove('wm-loading'); el.classList.add('wm-err'); el.textContent = 'The WDFW service did not answer. Try again in a minute.'; } }
  function renderRmz() {
    const el = $('wmRmz'); if (!el) return; el.classList.remove('wm-loading'); const r = S.rmzRes;
    const word = r.state === 'yes' ? 'Yes' : r.state === 'partly' ? 'Partly' : 'No';
    const pct = r.state === 'partly' ? (r.share >= 0.005 ? ', about ' + Math.max(1, Math.round(r.share * 100)) + '% of the lot' : ', a sliver of the lot') : '';
    el.innerHTML = '<b>' + word + pct + '</b> <span class="wm-est">estimate</span>' +
      (r.none ? '<span class="wm-note">WDFW maps no estimated zone in the area checked around this lot.</span>' : '') +
      '<span class="wm-note">WDFW’s map shows estimated locations; site-scale delineation “requires field verification.” It is a flagging tool, not a city or county rule. Source: Washington Department of Fish and Wildlife.</span>';
  }
  function renderBandShare() {
    const el = $('wmBand'); if (!el || !S.sd) return; el.classList.remove('wm-loading');
    const m = S.w * FT, a = S.sd.inner, b = S.sd.bnd; let n = 0; for (let i = 0; i < a.length; i++) if (a[i] <= m) n++;
    let allB = true; for (let i = 0; i < b.length; i++) if (b[i] > m) { allB = false; break; }
    const minD = S.dist ? S.dist.stream.d : Infinity; let txt;
    if (!a.length) txt = 'This lot is too small to measure.';
    else if (n === a.length && allB) txt = 'All of this lot is within ' + S.w + ' ft of a DNR-mapped stream line.';
    else if (n === 0) txt = minD < m ? 'Less than 1% of this lot is within ' + S.w + ' ft of a DNR-mapped stream line.' : 'None of this lot is within ' + S.w + ' ft of a DNR-mapped stream line.';
    else txt = 'About ' + Math.min(99, Math.max(1, Math.round(100 * n / a.length))) + '% of this lot is within ' + S.w + ' ft of a DNR-mapped stream line.';
    const wn = waterNear(); // 2026-10-16: a lake or shore within the width is named above; say the band does not include it
    el.innerHTML = '<b>' + esc(txt) + '</b>' + (wn.length ? '<span class="wm-note wm-band-water">The band is drawn from stream lines only. The mapped ' + esc(WATER_WORD[S.water.props[wn[0].i].k]) + ' above is within ' + S.w + ' ft of this lot and is not part of it.</span>' : '');
  }
  function chip(st, group, checked) { // 2026-10-16: the checked date sits beside the chip; older than 21 days says "may be out of date"
    let label = (STATUS[st] || STATUS.unchecked)[0];
    if (st === 'unchecked' && (group === 'a' || group === 'b')) label = 'Deadline passed · not checked yet';
    const d = isoDay(checked);
    return '<span class="wm-st"><span class="wm-chip st-' + esc(st) + '">' + esc(label) + '</span>' +
      (d ? '<span class="wm-chk">Checked ' + esc(d) + (daysOld(d) > STALE_DAYS ? '<span class="wm-stale"> · may be out of date</span>' : '') + '</span>' : '') + '</span>';
  }
  function linkHtml(l) { const u = String(l.url || ''); const out = /^https?:\/\//i.test(u);
    return '<a href="' + esc(u) + '"' + (out ? ' target="_blank" rel="noopener"' : '') + '>' + esc(l.label) + (out ? ' ↗' : ' →') + '</a>'; }
  function placeMatch(c, j) {
    if (!c || !j || j.kind !== 'city') return null; const want = String(j.city || '').toLowerCase().trim();
    return (c.places || []).find((p) => String(p.name || '').toLowerCase().replace(/^(city|town) of\s+/, '').trim() === want) || null;
  }
  function renderCounty() {
    const box = $('wmCountyCard'); if (!box) return; const j = S.juris || {}; const name = j.county; const data = S.content;
    if (!name) { box.innerHTML = '<p class="wm-kicker">Your county</p><h2 id="wmCountyTitle">County not found</h2><p>See <a href="washington.html">all 39 counties →</a></p>'; return; }
    const c = data && data.counties ? data.counties[name] : null; const s = slug(name);
    let html = '<p class="wm-kicker">Your county</p><div class="wm-county-head"><h2 id="wmCountyTitle">' + esc(name) + ' County</h2>' + (c ? chip(c.status, c.group, c.checked) : '') + '</div>';
    if (c) {
      const grp = (data.groups || {})[c.group] || {};
      const passed = (c.group === 'a' || c.group === 'b');
      const body = c.summary || ((STATUS[c.status] || STATUS.unchecked)[1] + (passed && c.status === 'unchecked' ? ' Its deadline has passed; we have not checked whether it adopted.' : ''));
      html += '<p class="wm-meta"><span>Deadline</span> ' + esc(grp.label || '') + (passed ? ' (passed)' : '') + '</p>' + '<p>' + esc(body) + '</p>' +
        (c.riparian ? '<p class="wm-meta"><span>Creek buffers</span> ' + esc(c.riparian) + '</p>' : '') +
        (nextLive(c) ? '<p class="wm-meta wm-next"><span>Next</span> ' + esc(c.next) + '</p>' : '') +
        ((c.links || []).length ? '<p class="wm-links">' + c.links.map(linkHtml).join('') + '</p>' : '');
      const pl = placeMatch(c, j);
      if (pl) html += '<div class="wm-place"><div class="wm-county-head"><h3>' + esc(pl.name) + '</h3>' + chip(pl.status, 'c', pl.checked) + '</div>' + (pl.summary ? '<p>' + esc(pl.summary) + '</p>' : '') +
        (pl.riparian ? '<p class="wm-meta"><span>Creek buffers</span> ' + esc(pl.riparian) + '</p>' : '') + (nextLive(pl) ? '<p class="wm-meta wm-next"><span>Next</span> ' + esc(pl.next) + '</p>' : '') +
        ((pl.links || []).length ? '<p class="wm-links">' + pl.links.map(linkHtml).join('') + '</p>' : '') + '</div>';
      else if (j.kind === 'city') html += '<p class="wm-note">We have not added ' + esc(j.city) + '’s critical areas update yet. Inside city limits, the city’s rules apply.</p>';
    } else html += '<p class="wm-note">The county status list did not load. See the statewide page.</p>';
    html += '<p class="wm-links wm-more"><a href="county/' + esc(s) + '.html">More on ' + esc(name) + ' County →</a><a href="washington.html">All 39 counties →</a></p>';
    box.innerHTML = html;
  }

  // ---------- Map ----------
  let map = null, styleReady = false, hasGlyphs = false;
  const PAINT = {
    aerial: { band: '#ff5a4f', bandO: 0.34, edge: '#ffd0c9', rmz: '#b8f0a0', rmzO: 0.30, rmzE: '#e2ffd4', lot: '#fff7c2', env: '#ffffff', casing: 'rgba(255,255,255,.85)', water: '#5fc4ff', waterO: 0.30, waterE: '#c9eeff' },
    street: { band: '#cc3e36', bandO: 0.30, edge: '#982b25', rmz: '#6f9f5f', rmzO: 0.26, rmzE: '#3f6b33', lot: '#1d2420', env: '#62695c', casing: 'rgba(255,255,255,.9)', water: '#3d8fd1', waterO: 0.26, waterE: '#2a6fa8' }
  };
  const TYPE_COLOR = ['match', ['get', 't'], 'S', '#0d4fa8', 'F', '#1f78e0', 'N', '#2aa6c4', 'U', '#7a8ea8', '#9a9a9a'];
  const STYLE_URL = 'https://tiles.openfreemap.org/styles/liberty', PLANET_URL = 'https://tiles.openfreemap.org/planet';
  const AERIAL_SRC = () => ({ type: 'raster', tiles: ['https://basemap.nationalmap.gov/arcgis/rest/services/USGSImageryOnly/MapServer/tile/{z}/{y}/{x}'], tileSize: 256, maxzoom: 16,
    attribution: 'Imagery: USDA / <a href="https://basemap.nationalmap.gov/arcgis/rest/services/USGSImageryOnly/MapServer" target="_blank" rel="noopener">USGS The National Map</a> (dates vary)' });
  const AERIAL_LAYER = () => ({ id: 'wm-aerial', type: 'raster', source: 'wm-aerial', layout: { visibility: S.basemap === 'aerial' ? 'visible' : 'none' }, paint: { 'raster-fade-duration': RMQ.matches ? 0 : 180 } });
  const ORIG_VIS = {}; // basemap layer id -> its visibility in the published style (restored for the street map)
  const AERIAL_BG = '#5a5c4c'; // aerial mode: behind the imagery while it loads, an imagery-like tone (the light street background made the pale lot outline vanish and flashed light-dark)
  const vis = (l) => (l.layout || {}).visibility || 'visible';
  function baseLists(layers) { // base fills/lines/rasters under the imagery (invisible in aerial mode), and the POI symbol layers
    const idx = layers.findIndex((l) => l.id === 'wm-aerial');
    S.baseBelow = layers.slice(0, idx < 0 ? 0 : idx).filter((l) => l.type !== 'background' && l.type !== 'fill-extrusion' && l.type !== 'symbol').map((l) => [l.id, ORIG_VIS[l.id] || vis(l)]);
    S.poiIds = layers.filter((l) => l['source-layer'] === 'poi').map((l) => l.id);
  }
  // The OpenFreeMap "liberty" style (fetched by the inline script in <head>), edited before the map starts so there is one style load
  // and nothing switches on screen. Returns the style URL instead if the prefetch failed (MapLibre then loads it, with the raster fallback).
  async function buildStyle() {
    const boot = window.wmBoot || {};
    let st = null; try { st = await boot.style; } catch (_) { st = null; }
    if (!st) try { st = await getJSONOnce(STYLE_URL, 15000); } catch (_) { st = null; } // the early fetch failed or is missing: one direct try
    if (!st || typeof st !== 'object' || !Array.isArray(st.layers) || !st.sources || typeof st.sources !== 'object') return STYLE_URL;
    // 1. No Natural Earth shaded relief (or any other basemap raster): over 1 MB of PNG at the statewide view, and hidden under the imagery anyway
    const drop = Object.keys(st.sources).filter((id) => st.sources[id] && st.sources[id].type === 'raster');
    drop.forEach((id) => { delete st.sources[id]; });
    const layers = st.layers.filter((l) => !(l && l.source && drop.indexOf(l.source) >= 0));
    // 2. Inline the vector TileJSON fetched in parallel: one round trip fewer before the first tile
    const om = st.sources.openmaptiles;
    if (om && om.url === PLANET_URL && boot.planet) { let tj = null; try { tj = await boot.planet; } catch (_) { tj = null; }
      if (tj && Array.isArray(tj.tiles) && tj.tiles.length) { const v = { type: 'vector', tiles: tj.tiles };
        ['minzoom', 'maxzoom', 'bounds', 'attribution', 'scheme'].forEach((k) => { if (tj[k] != null) v[k] = tj[k]; }); st.sources.openmaptiles = v; } }
    // 3. The imagery goes under the first label layer, and its source first, so its tiles are requested before the vector tiles
    st.sources = Object.assign({ 'wm-aerial': AERIAL_SRC() }, st.sources);
    const fsym = layers.findIndex((l) => l.type === 'symbol'); layers.splice(fsym < 0 ? layers.length : fsym, 0, AERIAL_LAYER());
    // 4. Pitch is off, so 3D extrusions (always hidden here) are left out. Aerial mode also hides the base under the imagery and the POIs
    const keep = layers.filter((l) => l.type !== 'fill-extrusion');
    keep.forEach((l) => { ORIG_VIS[l.id] = vis(l); });
    baseLists(keep);
    const bg = keep.find((l) => l.type === 'background');
    if (bg) { S.bgId = bg.id; S.bgStreet = (bg.paint || {})['background-color'] || '#f8f4f0'; if (S.basemap === 'aerial') bg.paint = Object.assign({}, bg.paint, { 'background-color': AERIAL_BG }); }
    if (S.basemap === 'aerial') { const hide = {}; S.baseBelow.forEach(([id]) => { hide[id] = 1; }); S.poiIds.forEach((id) => { hide[id] = 1; });
      keep.forEach((l) => { if (hide[l.id]) l.layout = Object.assign({}, l.layout, { visibility: 'none' }); }); }
    // 5. The overlay sources (empty until a lookup) and layers are part of the style, so nothing is added one by one after it loads
    hasGlyphs = !!st.glyphs;
    OVERLAY_SRC.forEach(([id, attribution]) => { st.sources[id] = { type: 'geojson', data: EMPTY, attribution: attribution() }; });
    st.layers = keep.concat(overlaySpecs());
    S.builtStyle = true; S.builtBase = S.basemap;
    return st;
  }
  const OVERLAY_SRC = [['wm-env', () => ''], ['wm-water', () => ''], ['wm-rmz', () => 'Estimated riparian management zones: Washington Department of Fish and Wildlife'], ['wm-band', () => ''], ['wm-band-edge', () => ''],
    ['wm-streams', () => 'Watercourses and water bodies: WA DNR Forest Practices Division'], ['wm-lot', () => 'Parcels: WaTech, Washington State Counties'], ['wm-pt', () => (ESRI_KEY ? 'Address search: Powered by Esri' : '')]];
  function initMap() {
    const box = $('wmMap'); if (!box || map || S.mapStarted) return; S.mapStarted = true;
    if (!window.maplibregl) { mapNote('The map library could not load. You can still search an address; the results appear without the map.'); mapLoaded(); return; }
    setTimeout(mapLoaded, 45000); // never leave the loader spinning if the map stalls
    // The map starts in its own task after a frame: not stacked onto MapLibre's script evaluation, and the page's layout is clean by then
    buildStyle().catch((e) => { console.warn('style', e); S.builtStyle = false; return STYLE_URL; })
      .then((style) => requestAnimationFrame(() => setTimeout(() => createMap(box, style), 0)));
  }
  function createMap(box, style) {
    const stacked = innerWidth < 900, start = S.startView || { center: WA_CENTER, zoom: WA_ZOOM };
    try {
      map = new maplibregl.Map({ container: box, style: style, center: start.center, zoom: start.zoom, minZoom: 4, validateStyle: false, // a fixed, known style: skip ~50 ms of spec checks
        attributionControl: { compact: true }, pixelRatio: Math.min(window.devicePixelRatio || 1, 2), cooperativeGestures: stacked, dragRotate: false, pitchWithRotate: false, touchPitch: false, fadeDuration: RMQ.matches ? 0 : 300 });
    } catch (e) { console.warn('map', e); map = null; mapNote('This browser could not start the map (WebGL). You can still search an address; the results appear without the map.'); mapLoaded(); return; }
    if (map.touchZoomRotate) map.touchZoomRotate.disableRotation();
    map.on('movestart', (e) => { if (e && e.originalEvent) S.userMoved = true; });
    const attrib = box.querySelector('.maplibregl-ctrl-attrib'); let attribUsed = false;
    if (attrib) attrib.addEventListener('click', () => { attribUsed = true; }, true);
    const collapse = () => { if (!attribUsed && attrib && (attrib.hasAttribute('open') || attrib.classList.contains('maplibregl-compact-show'))) { attrib.removeAttribute('open'); attrib.classList.remove('maplibregl-compact-show'); } };
    map.on('styledata', collapse); map.on('sourcedata', collapse); collapse();
    setTimeout(() => { // controls in their own short task, after the map itself
      if (!map) return; map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
      try { const geo = new maplibregl.GeolocateControl({ positionOptions: { enableHighAccuracy: true }, trackUserLocation: false, fitBoundsOptions: { maxZoom: 17 } });
        map.addControl(geo, 'top-right'); geo.on('geolocate', (e) => { if (e && e.coords) tapLookup([e.coords.longitude, e.coords.latitude]); }); } catch (_) {} }, 0);
    const raster = { version: 8, sources: { osm: { type: 'raster', tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'], tileSize: 256, attribution: '&copy; OpenStreetMap contributors' } }, layers: [{ id: 'osm', type: 'raster', source: 'osm' }] };
    let fellBack = false;
    map.on('error', (e) => { const m = String((e && e.error && (e.error.message || e.error)) || '');
      if (!fellBack && !styleReady && /style|openfreemap/i.test(m)) { fellBack = true; S.builtStyle = false; try { map.setStyle(raster); } catch (_) {} }
      if (e && e.sourceId === 'wm-aerial' && S.basemap === 'aerial') { setBasemap('street', false); mapNote('Aerial imagery could not load; the street map is shown.'); } });
    map.on('style.load', () => { styleReady = true;
      if (!S.builtStyle) { const st = map.getStyle() || {}; hasGlyphs = !!st.glyphs; addAerial(st.layers || []); } // a style that did not come from buildStyle (fallbacks)
      else if (S.builtBase !== S.basemap) { applyBase(); paintLayers(); } // the basemap was switched while the map was starting
      ensureLayers();
      if (S.geo) { fitLot(true); if (S.nearLL) fitWith(S.nearLL, true); } // a lookup got there before the map was ready
      map.once('idle', () => { mapLoaded(); idleTask(warmUp, 400); }); });
    map.on('click', (e) => {
      if (map.getZoom() < 14) { warmHosts(); map.easeTo({ center: e.lngLat, zoom: 16.5, duration: RMQ.matches || map.getZoom() < 10 ? 0 : 600 }); status('Zoomed in. Now tap inside your lot.'); return; }
      tapLookup([e.lngLat.lng, e.lngLat.lat]);
    });
  }
  const idleTask = (fn, wait) => setTimeout(() => (window.requestIdleCallback ? requestIdleCallback(fn, { timeout: 1500 }) : fn()), wait || 0);
  function mapNote(msg) { const n = $('wmMapNote'); if (n) { n.textContent = msg; n.hidden = !msg; } }
  function addAerial(layers) { // for a style that came without the imagery (the raster fallback); otherwise only records the layer lists
    if (!map.getSource('wm-aerial')) map.addSource('wm-aerial', AERIAL_SRC());
    if (!map.getLayer('wm-aerial')) { const fsym = layers.find((l) => l.type === 'symbol'); map.addLayer(AERIAL_LAYER(), fsym ? fsym.id : undefined); layers = (map.getStyle() || {}).layers || []; }
    layers.forEach((l) => { if (l.type === 'fill-extrusion' && vis(l) !== 'none') map.setLayoutProperty(l.id, 'visibility', 'none'); });
    baseLists(layers); // 2026-10-15: was computed from a list taken before wm-aerial was added, so it was always empty and the base drew under the imagery
    applyBase();
  }
  function applyBase() {
    if (!map || !styleReady) return; const aerial = S.basemap === 'aerial';
    const setVis = (id, v) => { if (map.getLayer(id) && map.getLayoutProperty(id, 'visibility') !== v) map.setLayoutProperty(id, 'visibility', v); };
    setVis('wm-aerial', aerial ? 'visible' : 'none');
    (S.baseBelow || []).forEach(([id, v]) => setVis(id, aerial ? 'none' : v));
    (S.poiIds || []).forEach((id) => setVis(id, aerial ? 'none' : (ORIG_VIS[id] || 'visible')));
    if (S.bgId && map.getLayer(S.bgId)) try { map.setPaintProperty(S.bgId, 'background-color', aerial ? AERIAL_BG : S.bgStreet); } catch (_) {}
  }
  // Cold-start WebGL: MapLibre compiles a shader program the first time each kind of overlay layer draws, and that blocks the main thread.
  // After the first 'idle', copies of the overlay layers are drawn from a temporary source at 0.4% opacity (invisible), one per idle moment,
  // then removed; the compiled programs stay cached for the first lookup. Stops the moment a lookup starts. (2026-10-15: the old stand-ins
  // used the real sources at full opacity under the basemap switch and could show if the map was panned during warm-up.)
  function warmUp() {
    if (!map || S.warmed || S.seq > 0 || !styleReady) return; S.warmed = true;
    const c = map.getCenter(), d = 0.01, A = [c.lng, c.lat], B = [c.lng + d, c.lat], C = [c.lng + d, c.lat + d];
    const data = fc([{ type: 'Feature', properties: { t: 'F', k: 'stream', n: '' }, geometry: { type: 'LineString', coordinates: [A, B] } },
      { type: 'Feature', properties: { t: 'N', k: 'ditch', n: '' }, geometry: { type: 'LineString', coordinates: [B, C] } },
      { type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [[A, B, C, A]] } }, { type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: A } }]);
    const GHOST = { line: ['line-opacity'], fill: ['fill-opacity'], circle: ['circle-opacity', 'circle-stroke-opacity'] };
    const ghosts = overlaySpecs().filter((l) => GHOST[l.type]).map((l, i) => { const g = JSON.parse(JSON.stringify(l)); g.id = 'wm-warm-' + i; g.source = 'wm-warm';
      GHOST[l.type].forEach((p) => { g.paint[p] = 0.004; }); return g; });
    const done = () => { try { ghosts.forEach((g) => { if (map.getLayer(g.id)) map.removeLayer(g.id); }); if (map.getSource('wm-warm')) map.removeSource('wm-warm'); } catch (_) {} };
    try { map.addSource('wm-warm', { type: 'geojson', data: data }); } catch (_) { return; }
    let i = 0;
    const next = () => { if (!map || S.seq > 0 || i >= ghosts.length) { done(); return; }
      try { map.addLayer(ghosts[i++]); } catch (_) {} map.once('idle', () => idleTask(next, 30)); };
    next();
  }
  function setBasemap(choice, save) {
    S.basemap = choice; document.documentElement.dataset.wmBasemap = choice;
    document.querySelectorAll('[data-wm-base]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.wmBase === choice)));
    if (save !== false) try { localStorage.setItem('cc_basemap', choice); } catch (_) {}
    if (!map || !styleReady) return;
    applyBase(); paintLayers();
  }
  function src(id, data, attribution) { if (!map.getSource(id)) map.addSource(id, { type: 'geojson', data: data || EMPTY, attribution: attribution || '' });
    else if (data && data.features && data.features.length) map.getSource(id).setData(data); } // at style load: only the sources a lookup has already filled
  function ensureLayers() {
    if (!map || !styleReady) return;
    src('wm-env', envFeature()); src('wm-water', waterData()); src('wm-rmz', rmzData(), 'Estimated riparian management zones: Washington Department of Fish and Wildlife');
    src('wm-band', bandData('fill')); src('wm-band-edge', bandData('line'));
    src('wm-streams', streamData(), 'Watercourses and water bodies: WA DNR Forest Practices Division'); src('wm-lot', S.lot ? fc([S.lot]) : EMPTY, 'Parcels: WaTech, Washington State Counties');
    src('wm-pt', S.pt ? fc([{ type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: S.pt } }]) : EMPTY, ESRI_KEY ? 'Address search: Powered by Esri' : '');
    overlaySpecs().forEach((l) => { if (!map.getLayer(l.id)) map.addLayer(l); });
    if (!S.builtStyle) paintLayers();
  }
  function overlaySpecs() { // the overlay layers, painted for the current basemap (also cloned by warmUp)
    const c = PAINT[S.basemap] || PAINT.street;
    const out = [
      { id: 'wm-env-line', type: 'line', source: 'wm-env', paint: { 'line-width': 1.2, 'line-dasharray': [3, 3], 'line-opacity': 0.8, 'line-color': c.env } },
      { id: 'wm-water-fill', type: 'fill', source: 'wm-water', paint: { 'fill-color': c.water, 'fill-opacity': c.waterO } }, // 2026-10-16: DNR water bodies
      { id: 'wm-water-line', type: 'line', source: 'wm-water', paint: { 'line-width': 1.4, 'line-color': c.waterE } },
      { id: 'wm-rmz-fill', type: 'fill', source: 'wm-rmz', paint: { 'fill-color': c.rmz, 'fill-opacity': c.rmzO } },
      { id: 'wm-rmz-line', type: 'line', source: 'wm-rmz', paint: { 'line-width': 1, 'line-dasharray': [2, 2], 'line-color': c.rmzE } },
      { id: 'wm-band-fill', type: 'fill', source: 'wm-band', paint: { 'fill-antialias': false, 'fill-color': c.band, 'fill-opacity': c.bandO } },
      { id: 'wm-band-line', type: 'line', source: 'wm-band-edge', layout: { 'line-join': 'round' }, paint: { 'line-width': 1.6, 'line-color': c.edge } },
      { id: 'wm-streams-casing', type: 'line', source: 'wm-streams', layout: { 'line-join': 'round', 'line-cap': 'round' }, paint: { 'line-width': ['match', ['get', 't'], 'S', 6, 'F', 5, 4], 'line-opacity': 0.7, 'line-color': c.casing } },
      { id: 'wm-streams-line', type: 'line', source: 'wm-streams', filter: ['==', ['get', 'k'], 'stream'], layout: { 'line-join': 'round', 'line-cap': 'round' }, paint: { 'line-color': TYPE_COLOR, 'line-width': ['match', ['get', 't'], 'S', 3.6, 'F', 2.8, 2.2] } },
      { id: 'wm-ditch-line', type: 'line', source: 'wm-streams', filter: ['!=', ['get', 'k'], 'stream'], paint: { 'line-color': TYPE_COLOR, 'line-width': 1.8, 'line-dasharray': [2, 1.5] } },
      { id: 'wm-lot-casing', type: 'line', source: 'wm-lot', paint: { 'line-color': '#111511', 'line-width': 5, 'line-opacity': 0.55 } },
      { id: 'wm-lot-fill', type: 'fill', source: 'wm-lot', paint: { 'fill-opacity': 0.14, 'fill-color': c.lot } },
      { id: 'wm-lot-line', type: 'line', source: 'wm-lot', paint: { 'line-width': 2.6, 'line-color': c.lot } },
      { id: 'wm-pt', type: 'circle', source: 'wm-pt', paint: { 'circle-radius': 5, 'circle-color': '#ffffff', 'circle-stroke-color': '#111511', 'circle-stroke-width': 2 } }];
    if (hasGlyphs) out.push({ id: 'wm-streams-label', type: 'symbol', source: 'wm-streams', filter: ['all', ['==', ['get', 'k'], 'stream'], ['!=', ['get', 'n'], '']], minzoom: 13,
      layout: { 'symbol-placement': 'line', 'text-field': ['get', 'n'], 'text-font': ['Noto Sans Regular'], 'text-size': 12, 'text-letter-spacing': 0.04 },
      paint: { 'text-color': '#0d3f80', 'text-halo-color': '#ffffff', 'text-halo-width': 1.6 } });
    return out;
  }
  function paintLayers() {
    if (!map || !styleReady || !map.getLayer('wm-band-fill')) return; const c = PAINT[S.basemap] || PAINT.street;
    const set = (id, p, v) => { try { map.setPaintProperty(id, p, v); } catch (_) {} };
    set('wm-band-fill', 'fill-color', c.band); set('wm-band-fill', 'fill-opacity', c.bandO); set('wm-band-line', 'line-color', c.edge);
    set('wm-water-fill', 'fill-color', c.water); set('wm-water-fill', 'fill-opacity', c.waterO); set('wm-water-line', 'line-color', c.waterE);
    set('wm-rmz-fill', 'fill-color', c.rmz); set('wm-rmz-fill', 'fill-opacity', c.rmzO); set('wm-rmz-line', 'line-color', c.rmzE);
    set('wm-lot-fill', 'fill-color', c.lot); set('wm-lot-line', 'line-color', c.lot); set('wm-env-line', 'line-color', c.env); set('wm-streams-casing', 'line-color', c.casing);
  }
  const envFeature = () => S.env ? fc([{ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: [[S.env[0], S.env[1]], [S.env[2], S.env[1]], [S.env[2], S.env[3]], [S.env[0], S.env[3]], [S.env[0], S.env[1]]] } }]) : EMPTY;
  const streamData = () => S.dnr ? fc(S.dnr.feats.map((f) => ({ type: 'Feature', properties: f.properties, geometry: f.geometry }))) : EMPTY;
  const waterData = () => (S.water ? fc(S.water.shown) : EMPTY);
  const rmzData = () => S.rmz ? fc(S.rmz.feats.map((f) => ({ type: 'Feature', properties: {}, geometry: f.geometry }))) : EMPTY;
  const bandData = (k) => (S.bands[S.w] ? S.bands[S.w][k] : EMPTY);
  function placePoint(pt) { S.pt = pt; if (map && styleReady && map.getSource('wm-pt')) map.getSource('wm-pt').setData(fc([{ type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: pt } }])); }
  function drawLot() { if (!map || !styleReady) return; ['wm-band', 'wm-band-edge', 'wm-streams', 'wm-rmz', 'wm-water'].forEach((id) => map.getSource(id) && map.getSource(id).setData(EMPTY));
    map.getSource('wm-lot') && map.getSource('wm-lot').setData(fc([S.lot])); map.getSource('wm-env') && map.getSource('wm-env').setData(envFeature()); placePoint(S.pt); }
  function drawStreams() { if (map && styleReady && map.getSource('wm-streams')) map.getSource('wm-streams').setData(streamData()); }
  function drawWater() { if (map && styleReady && map.getSource('wm-water')) map.getSource('wm-water').setData(waterData()); }
  function drawRmz() { if (map && styleReady && map.getSource('wm-rmz')) map.getSource('wm-rmz').setData(rmzData()); }
  function drawBand() { if (!map || !styleReady || !map.getSource('wm-band')) return; map.getSource('wm-band').setData(bandData('fill')); map.getSource('wm-band-edge').setData(bandData('line')); }
  function fitLot(instant) {
    if (!map || !S.geo) return; const b = S.geo.bbox;
    const pad = Math.min(60, Math.round(Math.min(map.getContainer().clientWidth, map.getContainer().clientHeight) / 5));
    const lng = 220 / S.geo.P.kx, lat = 220 / S.geo.P.ky; // show ~220 m around the lot so nearby streams are in view
    // 2026-10-15: from a far-out view, jump: a long fly-in asks for tiles at every zoom on the way (megabytes on a phone) and shows blank tiles meanwhile
    const jump = instant || RMQ.matches || map.getZoom() < 12;
    try { map.fitBounds([[b[0] - lng, b[1] - lat], [b[2] + lng, b[3] + lat]], { padding: pad, maxZoom: 18, duration: jump ? 0 : 900 }); } catch (_) {}
  }
  function fitWith(ll, instant) { // keep the lot in view and add the nearest stream, unless the person already moved the map
    if (!map || !S.geo || S.userMoved) return; const b = map.getBounds();
    if (b.contains(ll)) return; const lb = S.geo.bbox, m = 60 / S.geo.P.kx, n = 60 / S.geo.P.ky;
    const pad = Math.min(50, Math.round(Math.min(map.getContainer().clientWidth, map.getContainer().clientHeight) / 6));
    try { map.fitBounds([[Math.min(lb[0], ll[0]) - m, Math.min(lb[1], ll[1]) - n], [Math.max(lb[2], ll[0]) + m, Math.max(lb[3], ll[1]) + n]], { padding: pad, maxZoom: 18, duration: instant || RMQ.matches ? 0 : 700 }); } catch (_) {}
  }
  function scrollToMap() { const c = $('wmMapCol'); if (c && innerWidth < 900) c.scrollIntoView({ block: 'center', behavior: RMQ.matches ? 'auto' : 'smooth' }); }

  // ---------- Page wiring ----------
  function init() {
    const form = $('wmForm'); if (form) form.addEventListener('submit', onSubmit);
    $('wmPicks').addEventListener('click', (e) => { const b = e.target.closest('[data-pick]'); if (!b) return; const f = S.picks[Number(b.dataset.pick)]; if (!f) return; pickLookup(f); });
    document.querySelectorAll('[data-wm-base]').forEach((b) => b.addEventListener('click', () => setBasemap(b.dataset.wmBase)));
    setBasemap(S.basemap, false);
    // The page has <base href="../">: keep in-page links (wa/#id) on this page without a reload
    document.addEventListener('click', (e) => { const a = e.target.closest && e.target.closest('a[href^="wa/#"]'); if (!a) return; const t = document.getElementById(a.getAttribute('href').slice(4)); if (!t) return;
      e.preventDefault(); t.scrollIntoView({ block: 'start', behavior: RMQ.matches ? 'auto' : 'smooth' }); if (!/^(INPUT|SELECT|TEXTAREA|BUTTON|A)$/.test(t.tagName)) t.setAttribute('tabindex', '-1'); t.focus({ preventScroll: true }); });
    if (form) form.addEventListener('focusin', warmHosts, { once: true });
    const lat = Number(params.get('lat')), lng = Number(params.get('lng'));
    const linked = isFinite(lat) && isFinite(lng) && lat && lng && lng >= WA_EXTENT.xmin && lng <= WA_EXTENT.xmax && lat >= WA_EXTENT.ymin && lat <= WA_EXTENT.ymax;
    if (linked) S.startView = { center: [lng, lat], zoom: 16 }; // a link to a spot: start the map there, not at the statewide view
    // maplibre-gl.js is deferred after this file: start the map when it has run (or say so if it failed)
    const gl = $('wmGL');
    if (window.maplibregl || !gl) initMap();
    else { gl.addEventListener('load', initMap, { once: true }); gl.addEventListener('error', initMap, { once: true }); window.addEventListener('load', initMap, { once: true }); }
    // Stop painting the WebGL map while it is scrolled out of view (as landing.js does on the home page)
    try { const col = $('wmMapCol'); if (col && 'IntersectionObserver' in window) new IntersectionObserver(([e]) => col.classList.toggle('wm-offscreen', !e.isIntersecting), { rootMargin: '200px 0px' }).observe(col); } catch (_) {}
    if (linked) tapLookup([lng, lat]);
    window.creekWA = { state: S, get map() { return map; }, lookupPoint: tapLookup, setWidth: setWidth };
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
