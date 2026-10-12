/* Activity bubble client (research/12). Vanilla JS, no libraries. Any failure leaves the bubble hidden. */
(function () {
  var API = 'https://cc-api.corbenk.workers.dev';             // Cloudflare Worker + D1 (corbenk account; research/12)
  var SHOW = { lot: 1, email: 10, pledge: 10, creek: 10 };    // Corben 2026-10-12: show the bubble right away; sub-lines wait for 10
  var PLEDGE_ENDS = Date.parse('2026-10-15T00:00:00-07:00');  // pledge UI hides after the hearing
  var root = document.getElementById('ccCount');
  if (!root || !window.fetch || !window.JSON) return;
  function $(x) { return document.getElementById(x); }
  function ls(k, v) { try { if (v === undefined) return localStorage.getItem(k); localStorage.setItem(k, v); } catch (e) { return null; } }
  function fmt(n) { return Number(n).toLocaleString('en-US'); }
  var id = ls('cc_id');
  if (!id) { id = (window.crypto && crypto.randomUUID) ? crypto.randomUUID() : String(Date.now()) + String(Math.random()).slice(2); ls('cc_id', id); }
  var reduce = !!(window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches);
  var pledgeOpen = Date.now() < PLEDGE_ENDS;
  var last = null;

  function countUp(el, n) {
    if (reduce || root.dataset.compact === 'true') { el.textContent = fmt(n); return; }
    var t0 = performance.now();
    (function step(t) { var p = Math.min(1, (t - t0) / 700); el.textContent = fmt(Math.round(n * (1 - Math.pow(1 - p, 3)))); if (p < 1) requestAnimationFrame(step); })(t0);
  }
  function row(rowId, numId, n, min) { var ok = typeof n === 'number' && n >= min; if (ok) $(numId).textContent = fmt(n); $(rowId).hidden = !ok; }
  function pledgeText(n) { var others = n - 1; return others >= SHOW.pledge ? '✓ You + ' + fmt(others) + ' others' : '✓ You’re in'; }
  function creekRow() {
    var c = ls('cc_creek'), n = last && last.creeks && c ? last.creeks[c] : 0;
    if (c) $('ccCreekName').textContent = c;
    row('ccCreekRow', 'ccCreek', n || 0, SHOW.creek);
  }
  function renderPledge(d) {
    // The home-page attendance control lives in the hearing disclosure, independently of a dismissed count.
    var b = $('ccPledgeBtn');
    if (!pledgeOpen) b.hidden = true;
    else if (ls('cc_pledged') === '1') { b.disabled = true; b.textContent = pledgeText(d && d.pledge || 1); }
  }
  renderPledge(null); // saved attendance and expiry still apply if totals cannot be loaded
  function render(d) {
    last = d;
    renderPledge(d);
    if (!d || typeof d.lot !== 'number' || d.lot < SHOW.lot || ls('cc_count_closed') === '1') { root.hidden = true; return; }
    root.hidden = false;
    countUp($('ccLots'), d.lot);
    row('ccEmailRow', 'ccEmail', d.email, SHOW.email);
    row('ccPledgeRow', 'ccPledge', pledgeOpen ? d.pledge : -1, SHOW.pledge);
    creekRow();
  }
  function post(m, creek) {
    return fetch(API + '/add', { method: 'POST', keepalive: true, headers: { 'Content-Type': 'text/plain' },
      body: JSON.stringify({ m: m, id: id, c: creek || '' }) })
      .then(function (r) { return r.ok ? r.json() : null; }).catch(function () { return null; });
  }
  // Called by app.js after an address lookup resolves a Walla Walla County parcel, and by the mailto listener below.
  window.ccSend = function (m, creek) {
    try {
      if (m === 'lot' && creek) { ls('cc_creek', creek); creekRow(); }
      if (ls('cc_sent_' + m) === '1') return;   // the server dedupes too; this just saves requests
      ls('cc_sent_' + m, '1');
      post(m, creek);
    } catch (e) {}
  };

  $('ccPill').addEventListener('click', function () {
    var open = this.getAttribute('aria-expanded') === 'true';
    this.setAttribute('aria-expanded', open ? 'false' : 'true');
    $('ccMore').hidden = open;
  });
  $('ccClose').addEventListener('click', function () { ls('cc_count_closed', '1');
    if (root.dataset.compact === 'true') { root.hidden = true; var q = $('q'); if (q) q.focus({ preventScroll: true }); return; }
    if (reduce) { root.hidden = true; return; }
    root.style.height = root.offsetHeight + 'px'; void root.offsetHeight; root.classList.add('bn-leave');
    setTimeout(function () { root.hidden = true; root.classList.remove('bn-leave'); root.style.height = ''; }, 520); });
  $('ccPledgeBtn').addEventListener('click', function () {
    var b = this; if (ls('cc_pledged') === '1') return;
    b.disabled = true; $('ccSaved').textContent = '';
    post('pledge').then(function (res) {
      if (res && res.ok) {
        ls('cc_pledged', '1'); b.textContent = pledgeText(res.n);
        $('ccSaved').textContent = 'Saved. Make it a plan:'; $('ccCal').hidden = false;
      } else { b.disabled = false; $('ccSaved').textContent = 'Couldn’t save that. Please try again.'; }
    });
  });
  document.addEventListener('click', function (e) {
    var a = e.target && e.target.closest && e.target.closest('a[href^="mailto:CityClerk@"]');
    if (a) window.ccSend('email');
  }, true);

  var ctl = window.AbortController ? new AbortController() : null;
  if (ctl) setTimeout(function () { ctl.abort(); }, 4000);
  fetch(API + '/totals', ctl ? { signal: ctl.signal } : {})
    .then(function (r) { if (!r.ok) throw new Error('http ' + r.status); return r.json(); })
    .then(render)
    .catch(function () { root.hidden = true; });
})();
