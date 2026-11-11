import { tomorrowPlan, backtest } from './src/analysis.js';
import { predict, energyQuantile, finishProbability, contributions, RESERVE_SOC } from './src/readiness.js';

const $ = (s) => document.querySelector(s);
const fmt = (v, d = 0) => v.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
const pct = (p, d = 0) => (p >= 0.9995 && d === 0 ? '>99' : fmt(p * 100, d)) + '%';
const pctP = (p) => (p >= 0.95 ? fmt(Math.floor(p * 1000) / 10, 1) : fmt(p * 100, 0)) + '%';
const cls = (p) => (p >= 0.95 ? 'ok' : p >= 0.8 ? 'warn' : 'bad');

const params = new URLSearchParams(location.search);
const state = {
  plan: params.get('plan') === 'dispatcher' ? 'dispatcher' : 'recommended',
  filter: params.get('filter') || 'all',
  target: Number(params.get('target') || 0.99),
  sel: params.get('route') || null,
  view: params.get('view') === 'detail' ? 'detail' : 'list',
  q: '',
};

let data, P, BT, trucksById, map, routeLayers = {}, depotMarker, endMarker;

async function main() {
  data = await (await fetch('data/fleet.json')).json();
  trucksById = Object.fromEntries(data.trucks.map((t) => [t.id, t]));
  BT = backtest(data);
  compute();
  initMap();
  bind();
  if (!state.sel) state.sel = worstRoute();
  render();
}

function compute() {
  P = tomorrowPlan(data, { target: state.target });
}
function worstRoute() {
  return [...P.rows].sort((a, b) => a.pHome - b.pHome)[0].route;
}

// per-row view model for the selected plan
function view(r) {
  const disp = state.plan === 'dispatcher';
  const truck = trucksById[disp ? r.homeTruck : r.truck];
  const cap = P.caps[truck.id];
  const soc = disp ? data.meta.defaultChargeTo : r.chargeTo ?? 1;
  const planRow = data.plan.find((x) => x.route === r.route);
  const need = energyQuantile(P.model, P.scores, planRow, truck, 1 - state.target);
  return {
    truck, cap, soc, planRow, need,
    avail: cap.kwh * (soc - RESERVE_SOC),
    p: disp ? r.pHome : r.pRec,
    chargeLabel: disp ? fmt(soc * 100) + '%' : r.chargeTo === null ? '100%' : fmt(r.chargeTo * 100) + '%',
  };
}

function bind() {
  $('#planSeg').addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) return;
    state.plan = b.dataset.plan; render();
  });
  document.querySelectorAll('.pill').forEach((b) => b.addEventListener('click', () => { state.filter = b.dataset.f; render(); }));
  $('#target').addEventListener('change', (e) => { state.target = Number(e.target.value); compute(); render(); });
  $('#search').addEventListener('input', (e) => { state.q = e.target.value.trim().toLowerCase(); renderRows(); });
}

function render() {
  $('#target').value = String(state.target);
  document.querySelectorAll('#planSeg button').forEach((b) => b.classList.toggle('on', b.dataset.plan === state.plan));
  document.querySelectorAll('.pill').forEach((b) => b.classList.toggle('on', b.dataset.f === state.filter));
  $('#listView').hidden = state.view !== 'list';
  $('#detailView').hidden = state.view !== 'detail';
  renderHead();
  renderKpis();
  renderRows();
  if (state.view === 'detail') renderDetail();
  renderMap();
  renderDayCard();
}

function renderHead() {
  const t = data.tomorrow;
  $('#subline').innerHTML = `Tomorrow · <b>Fri, Nov 20</b> · ${P.rows.length} routes · Forecast <b>${fmt(t.tempC)}°C</b> (low ${fmt(t.lowC)}°C), cold front · return with ≥${fmt(RESERVE_SOC * 100)}% SoC`;
  $('#needHead').textContent = `Energy, expected–p${fmt(state.target * 100, state.target === 0.975 ? 1 : 0)} (kWh)`;
}

function renderKpis() {
  const s = P.summary, disp = state.plan === 'dispatcher';
  const k = (v, l, d, neutral) => `<div class="kpi"><div class="v">${v}</div><div class="l">${l}</div><div class="d ${neutral ? 'neutral' : ''}">${d}</div></div>`;
  const below = disp ? s.atRiskHome : s.atRiskRec;
  const worst = disp ? s.minPHome : s.minPRec;
  const exp = disp ? s.expectedMiddayHome : s.expectedMiddayRec;
  $('#kpis').innerHTML =
    k(`<span class="${below ? 'bad' : 'ok'}">${below}</span>`, 'Routes under 90%', disp ? `${s.atRiskClearedByReadout} of ${s.atRiskHome} look fine on range readout` : `was ${s.atRiskHome} on dispatcher plan`, disp) +
    k(`<span class="${cls(worst)}">${pctP(worst)}</span>`, 'Worst route finishes', disp ? 'route R-' + worstRoute().slice(2) : `was ${pctP(s.minPHome)}`, disp) +
    k(fmt(exp, 2), 'Expected midday charges', disp ? 'sum of (1 − P) over routes' : `was ${fmt(s.expectedMiddayHome, 2)}`, disp) +
    k(disp ? '0' : String(s.swaps), 'Vans swapped', disp ? 'standing assignment' : `${s.below90Rec} vans charge to under 90%`, disp);
}

function rowsFiltered() {
  return [...P.rows].sort((a, b) => a.pHome - b.pHome || a.route.localeCompare(b.route)).filter((r) => {
    if (state.filter === 'risk' && !(r.pHome < 0.9)) return false;
    if (state.filter === 'swapped' && !r.swapped) return false;
    if (state.q && !(`${r.route} ${r.homeTruck} ${r.truck}`.toLowerCase().includes(state.q))) return false;
    return true;
  });
}

function renderRows() {
  const all = P.rows.map((r) => view(r));
  const maxKwh = Math.max(...all.map((v) => Math.max(v.avail, v.need))) * 1.02;
  $('#rows').innerHTML = rowsFiltered().map((r) => {
    const v = view(r);
    const rec = state.plan === 'recommended';
    const mu = predict(P.model, v.planRow, v.truck).mu;
    const x0 = (mu / maxKwh) * 100, x1 = (Math.min(v.need, maxKwh) / maxKwh) * 100, xa = Math.min(99.5, (v.avail / maxKwh) * 100);
    const short = v.p < state.target - 1e-9 && v.avail < v.need;
    const changed = rec && Math.abs(r.pRec - r.pHome) > 0.005 && r.pHome < 0.95;
    return `<div class="row ${r.route === state.sel ? 'sel' : ''}" data-r="${r.route}">
      <span>${r.route}</span>
      <span class="veh">${v.truck.id}${rec && r.swapped ? `<span class="was">was ${r.homeTruck}</span>` : ''}</span>
      <span class="veh"><span class="${cls(v.p)}">${pctP(v.p)}</span>${changed ? `<span class="was">was ${pctP(r.pHome)}</span>` : ''}</span>
      <span class="need"><span class="bar"><i style="left:${x0}%;width:${Math.max(1, x1 - x0)}%"></i><b class="${short ? 'short' : ''}" style="left:${xa}%"></b></span><span class="num">${fmt(mu)}–${fmt(v.need)}</span></span>
      <span>${v.chargeLabel}${rec && r.chargeTo === null ? ' <span class="ms" style="font-size:15px;color:var(--orange);vertical-align:-3px" title="Below target even at 100%">warning</span>' : ''}</span>
      <span class="ms">chevron_right</span>
    </div>`;
  }).join('') || `<div class="mini" style="text-align:center;padding:24px">No routes match.</div>`;
  document.querySelectorAll('.row').forEach((el) => {
    el.addEventListener('mouseenter', () => { state.sel = el.dataset.r; highlight(); });
    el.addEventListener('click', () => { state.sel = el.dataset.r; state.view = 'detail'; render(); $('#panel').scrollTop = 0; });
  });
}
function highlight() {
  document.querySelectorAll('.row').forEach((el) => el.classList.toggle('sel', el.dataset.r === state.sel));
  renderMap();
}

// ---------- detail ----------
function truckSvg() {
  return `<svg class="truck" viewBox="0 0 210 112" aria-hidden="true">
    <ellipse cx="105" cy="101" rx="92" ry="6" fill="#000" opacity=".08"/>
    <path d="M14 22 h118 v66 h-118 z" fill="#fbfbfb" stroke="#c9c9c9"/>
    <path d="M132 30 h34 l22 30 v28 h-56 z" fill="#f7f7f7" stroke="#c9c9c9"/>
    <path d="M140 36 h22 l15 22 h-37 z" fill="#3a4148"/>
    <rect x="133" y="40" width="5" height="30" fill="#e3e3e3"/>
    <path d="M14 82 h174" stroke="#d8d8d8"/>
    <rect x="184" y="70" width="8" height="5" rx="1" fill="#f0b03d"/>
    <rect x="22" y="34" width="34" height="3" rx="1.5" fill="#e6e6e6"/>
    <g transform="translate(68 52)"><path d="M0 0 l9 -6 h15 l-9 6z M4 7 l9 -6 h15 l-9 6z" fill="#061824"/></g>
    <circle cx="46" cy="90" r="12" fill="#222"/><circle cx="46" cy="90" r="5" fill="#bbb"/>
    <circle cx="160" cy="90" r="12" fill="#222"/><circle cx="160" cy="90" r="5" fill="#bbb"/>
  </svg>`;
}
function gaugeSvg(p) {
  const r = 46, cx = 70, cy = 58, a0 = Math.PI * 1.1, a1 = -Math.PI * 0.1;
  const pt = (a) => [cx + r * Math.cos(a), cy - r * Math.sin(a)];
  const arc = (from, to) => { const [x0, y0] = pt(from), [x1, y1] = pt(to); return `M${x0} ${y0} A${r} ${r} 0 ${from - to > Math.PI ? 1 : 0} 1 ${x1} ${y1}`; };
  const end = a0 - (a0 - a1) * Math.max(0.001, p);
  const col = p >= 0.95 ? '#009652' : p >= 0.8 ? '#e8a93d' : '#d64556';
  return `<svg class="gauge" width="140" height="78" viewBox="0 0 140 78">
    <path d="${arc(a0, a1)}" stroke="#ececec" stroke-width="7" fill="none" stroke-linecap="round"/>
    <path d="${arc(a0, end)}" stroke="${col}" stroke-width="7" fill="none" stroke-linecap="round"/>
    <text x="70" y="62" text-anchor="middle" font-size="24" font-weight="700" fill="#111">${pctP(p).replace('%', '')}<tspan font-size="13" font-weight="600">%</tspan></text>
  </svg>`;
}
function stopsToMove(r, truck, soc) {
  const base = data.plan.find((x) => x.route === r.route);
  for (let k = 0; k <= base.stops; k += 2) {
    const trip = { ...base, stops: base.stops - k, miles: base.miles * (1 - (0.35 * k) / base.stops) };
    if (finishProbability(P.model, P.scores, trip, truck, P.caps[truck.id], soc) >= state.target) return k;
  }
  return null;
}

function renderDetail() {
  const r = P.rows.find((x) => x.route === state.sel) || P.rows[0];
  const v = view(r), disp = state.plan === 'dispatcher';
  const truck = v.truck;
  const contrib = contributions(P.model, v.planRow, truck);
  const coldKeys = ['cab heat', 'cold miles', 'pack warm-up'];
  const coldKwh = contrib.filter((c) => coldKeys.includes(c.name)).reduce((a, c) => a + c.kwh, 0);
  const warmTrip = { ...v.planRow, tempC: 17 };
  const coldDelta = predict(P.model, v.planRow, truck).mu - predict(P.model, warmTrip, truck).mu;
  const mu = predict(P.model, v.planRow, truck).mu;
  const maxC = Math.max(...contrib.map((c) => Math.abs(c.kwh)));
  const alerts = [];
  if (r.pHome < 0.9) alerts.push(`Dispatcher plan (${r.homeTruck} at 90%) finishes with ≥10% only <b>${pctP(r.pHome)}</b> of the time.`);
  if (r.pHome < 0.9 && r.rangeReadoutOk) alerts.push(`Tonight's range readout for ${r.homeTruck} says ${fmt(r.rangeReadoutMiles)} mi to 10% for a ${fmt(r.miles)} mi route, so it looks fine.`);
  if (!disp && r.swapped) {
    const other = P.rows.find((x) => x.homeTruck === r.truck);
    alerts.push(`Swap: <b>${r.truck}</b> (${trucksById[r.truck].packs} packs) takes ${r.route}; ${r.homeTruck} moves to ${P.rows.find((x) => x.truck === r.homeTruck)?.route ?? '—'}.`);
    void other;
  }
  if (!disp && r.chargeTo === null) {
    const k = stopsToMove(r, truck, 1);
    alerts.push(`Below the ${pct(state.target, 1).replace('.0', '')} target even at 100% (${pctP(r.pRec)}).${k ? ` Moving <b>${k} stops</b> to another van reaches it.` : ''}`);
  }
  if (coldDelta > 5) alerts.push(`Cold front adds <b>${fmt(coldDelta, 1)} kWh</b> versus the same route at 17°C.`);
  const nAlerts = alerts.filter((a) => !a.startsWith('Swap')).length;
  const sessions = data.sessions.filter((s) => s.truck === truck.id).slice(-60);
  const usableNominal = truck.nominalKwh * 0.94;
  $('#detailView').innerHTML = `
    <div class="back" id="back"><span class="ms" style="font-size:18px">chevron_left</span>All routes</div>
    ${truckSvg()}
    <div class="vt"><h2>${r.route} · ${truck.id}<span class="dot">i</span></h2><div class="vin">VIN: ${truck.vin}</div></div>
    <div class="upd"><span>Forecast for</span><span>11/20/2026 · depart 7:30AM</span></div>
    ${gaugeSvg(v.p)}
    <div class="gcap">${fmt(mu, 1)} kWh expected</div>
    <div class="gsub">chance to return with ≥${fmt(RESERVE_SOC * 100)}% SoC</div>
    <div class="batt"><span class="l"><span class="ms">battery_charging_80</span>Charge to ${v.chargeLabel}</span>
      ${disp ? `<span class="badge ${v.p >= 0.9 ? 'ok' : 'bad'}">${v.p >= 0.9 ? 'Ready' : 'At risk'}</span>` : r.swapped ? '<span class="badge swap">Swapped</span>' : `<span class="badge ${v.p >= 0.9 ? 'ok' : 'bad'}">${v.p >= 0.9 ? 'Ready' : 'At risk'}</span>`}</div>
    <div class="seg" id="planSeg2"><button data-plan="dispatcher" class="${disp ? 'on' : ''}">Dispatcher plan</button><button data-plan="recommended" class="${disp ? '' : 'on'}">Recommended</button></div>
    <div class="card stats">
      <div><div class="v">${fmt(v.need)} <small>kWh</small></div><div class="l">Need (p${fmt(state.target * 100, state.target === 0.975 ? 1 : 0)})</div></div>
      <div><div class="v">${fmt(v.avail)} <small>kWh</small></div><div class="l">Available</div></div>
      <div><div class="v">${fmt(v.cap.kwh, 1)} <small>kWh</small></div><div class="l">Full Capacity</div></div>
    </div>
    <div class="card"><div class="alerts"><span class="n ${nAlerts ? '' : 'zero'}">${nAlerts}</span>Readiness Alerts</div>
      ${alerts.length ? `<ul class="alist">${alerts.map((a) => `<li>${a}</li>`).join('')}</ul>` : ''}</div>
    <div class="card"><h3>Where the energy goes</h3><div class="body contrib">
      ${contrib.filter((c) => Math.abs(c.kwh) > 0.05).map((c) => `<div class="r"><span>${c.name}</span><span class="b"><i class="${coldKeys.includes(c.name) ? 'cold' : ''}" style="width:${(Math.abs(c.kwh) / maxC) * 100}%"></i></span><span class="num">${fmt(c.kwh, 1)} kWh</span></div>`).join('')}
      <div class="mini">Linear energy model fit on ${fmt(data.trips.filter((t) => t.d <= '2026-09-30').length)} route-days; cold-weather terms (blue) total ${fmt(coldKwh, 1)} kWh tomorrow.</div>
    </div></div>
    <div class="card"><h3>Pack capacity from charge logs</h3><div class="body">
      ${capSvg(sessions, v.cap)}
      <div class="mini">${fmt(v.cap.kwh, 1)} ± ${fmt(v.cap.se, 1)} kWh usable from ${v.cap.n} overnight sessions (total least squares on ΔSoC vs kWh in, so SoC noise does not bias it). ${fmt((v.cap.kwh / usableNominal) * 100, 1)}% of the ${truck.packs} × 35 kWh packs' usable rating.</div>
    </div></div>`;
  $('#back').addEventListener('click', () => { state.view = 'list'; render(); });
  $('#planSeg2').addEventListener('click', (e) => { const b = e.target.closest('button'); if (!b) return; state.plan = b.dataset.plan; render(); });
}

function capSvg(sessions, cap) {
  const W = 580, H = 130, pad = 30;
  const xs = sessions.map((s) => s.socEnd - s.socStart), ys = sessions.map((s) => s.kwhIn);
  const xmax = Math.max(...xs) * 1.05, ymax = Math.max(...ys) * 1.05;
  const X = (x) => pad + (x / xmax) * (W - pad - 8), Y = (y) => H - 18 - (y / ymax) * (H - 28);
  const pts = sessions.map((s, i) => `<circle cx="${X(xs[i]).toFixed(1)}" cy="${Y(ys[i]).toFixed(1)}" r="2.3" fill="#024c5e" opacity=".55"/>`).join('');
  return `<svg width="100%" viewBox="0 0 ${W} ${H}">
    <line x1="${pad}" y1="${H - 18}" x2="${W - 8}" y2="${H - 18}" stroke="#e2e2e2"/>
    <line x1="${pad}" y1="8" x2="${pad}" y2="${H - 18}" stroke="#e2e2e2"/>
    <line x1="${X(0)}" y1="${Y(0)}" x2="${X(xmax)}" y2="${Y(cap.kwh * xmax)}" stroke="#e5a128" stroke-width="2"/>
    ${pts}
    <text x="${W - 8}" y="${H - 4}" font-size="11" text-anchor="end" fill="#6d6d6d">ΔSoC per session</text>
    <text x="${pad + 6}" y="16" font-size="11" fill="#6d6d6d">kWh in</text>
  </svg>`;
}

// ---------- map ----------
function initMap() {
  map = L.map('map', { zoomControl: false, attributionControl: true }).setView([data.meta.depot.lat, data.meta.depot.lon], 12);
  L.control.zoom({ position: 'topright' }).addTo(map);
  L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}', {
    maxZoom: 19, attribution: 'Tiles &copy; Esri &mdash; Esri, HERE, Garmin, USGS, NGA, EPA, USDA, NPS',
  }).addTo(map);
  for (const r of data.routes) {
    routeLayers[r.id] = L.polyline(r.path, { color: '#e5a128', weight: 4.5, opacity: 1 });
  }
  depotMarker = L.marker([data.meta.depot.lat, data.meta.depot.lon], { icon: L.divIcon({ className: '', html: '<div class="depot-pin"><span class="ms">warehouse</span></div>', iconSize: [26, 26], iconAnchor: [13, 13] }) }).addTo(map);
}
let lastFit = null;
function renderMap() {
  if (!map) return;
  for (const [id, layer] of Object.entries(routeLayers)) {
    if (id === state.sel) { if (!map.hasLayer(layer)) layer.addTo(map); } else if (map.hasLayer(layer)) layer.remove();
  }
  const r = data.routes.find((x) => x.id === state.sel);
  if (!r) return;
  const far = r.path.reduce((a, p) => (Math.hypot(p[0] - data.meta.depot.lat, p[1] - data.meta.depot.lon) > Math.hypot(a[0] - data.meta.depot.lat, a[1] - data.meta.depot.lon) ? p : a), r.path[0]);
  if (endMarker) endMarker.remove();
  endMarker = L.marker(far, { icon: L.divIcon({ className: '', html: '<div class="end-pin"></div>', iconSize: [18, 18], iconAnchor: [9, 9] }) }).addTo(map);
  if (lastFit !== r.id) {
    const card = document.getElementById('daycard');
    const h = card ? card.offsetHeight + 40 : 260;
    map.fitBounds(routeLayers[r.id].getBounds(), { paddingTopLeft: [60, 60], paddingBottomRight: [60, h], maxZoom: 14 });
    lastFit = r.id;
  }
}

// ---------- bottom day card ----------
function renderDayCard() {
  const el = $('#daycard');
  if (state.view === 'detail') {
    const r = P.rows.find((x) => x.route === state.sel) || P.rows[0];
    const v = view(r);
    el.innerHTML = `<div class="top"><span class="date">Friday, November 20, 2026</span><span class="live">Cold front</span></div>
      <div class="dc-grid"><div><div class="dc-h">Energy forecast · ${r.route} on ${v.truck.id}</div>${energySvg(r, v)}</div>
      <div><div class="dc-h">Route plan</div><div class="dc-note"><b>${fmt(v.planRow.miles, 1)} mi</b> · <b>${v.planRow.stops}</b> stops · <b>${fmt(v.planRow.payloadT, 1)} t</b> payload · <b>${v.planRow.climbM} m</b> climb · ${fmt(v.planRow.tempC)}°C<br/>
      Forecast plus ${P.nCal} calibration residuals from the last 7 weeks, scaled to this route. Finish probability is the share that lands under the available energy.</div>
      <div class="legend" style="margin-top:8px"><span style="--c:#b9c9cf">forecast kWh</span><span style="--c:#024c5e">available</span><span style="--c:#e5a128">need p${fmt(state.target * 100, state.target === 0.975 ? 1 : 0)}</span></div><div class="mini">Map: outline through the route's stop clusters.</div></div></div>`;
  } else {
    const disp = state.plan === 'dispatcher';
    const lo = 0.35;
    const tick = (p, r) => { const x = Math.max(0.6, Math.min(99.4, ((p - lo) / (1 - lo)) * 100)); return `<i title="${r.route} ${pctP(p)}" style="left:${x}%;background:${p >= 0.95 ? '#22a36a' : p >= 0.8 ? '#e8a93d' : '#d64556'}"></i>`; };
    const lane = (key, label, on) => `<div class="lane ${on ? 'on' : ''}"><span>${label}</span><div class="timeline">${P.rows.map((r) => tick(r[key], r)).join('')}</div></div>`;
    const cov = BT.coverage.map((c) => `<div class="r"><span>${fmt(c.level * 100)}%</span><span class="b"><i style="width:${c.all * 100}%"></i><em style="left:${c.level * 100}%"></em></span><span>${fmt(c.all * 100, 1)}%</span></div>`).join('');
    el.innerHTML = `<div class="top"><span class="date">Friday, November 20, 2026</span><span class="live">Cold front</span></div>
      <div class="dc-grid"><div><div class="dc-h">Chance each route finishes without a midday charge</div>
        ${lane('pHome', 'Dispatcher', disp)}${lane('pRec', 'Recommended', !disp)}
        <div class="axis">${[0.35, 0.6, 0.8, 1].map((v) => `<span style="left:${((v - lo) / (1 - lo)) * 100}%">${fmt(v * 100)}%</span>`).join('')}</div>
        <div class="legend"><span style="--c:#d64556">under 80%</span><span style="--c:#e8a93d">80–95%</span><span style="--c:#22a36a">95%+</span></div></div>
      <div><div class="dc-h">Backtest · ${fmt(BT.n)} held-out route-days</div><div class="cov">${cov}</div>
        <div class="dc-note">Flagged <b>${BT.flagged} of ${BT.midday}</b> midday charges the night before (${BT.falseAlarms} false alarms). The range readout cleared <b>${BT.naiveCleared} of ${BT.midday}</b>.</div></div></div>`;
  }
}

function energySvg(r, v) {
  const W = 300, H = 112, pad = 6;
  const { mu, sigma } = predict(P.model, v.planRow, v.truck);
  const samples = P.scores.map((s) => mu + sigma * s);
  const lo = Math.min(...samples, v.avail) - 4, hi = Math.max(...samples, v.avail, v.need) + 4;
  const nb = 34, bw = (hi - lo) / nb, bins = new Array(nb).fill(0);
  samples.forEach((x) => bins[Math.min(nb - 1, Math.floor((x - lo) / bw))]++);
  const bmax = Math.max(...bins);
  const X = (x) => pad + ((x - lo) / (hi - lo)) * (W - 2 * pad);
  const bars = bins.map((b, i) => `<rect x="${X(lo + i * bw) + 0.5}" y="${H - 22 - (b / bmax) * (H - 40)}" width="${Math.max(1, X(lo + bw) - X(lo) - 1)}" height="${(b / bmax) * (H - 40)}" fill="${lo + (i + 0.5) * bw > v.avail ? '#f2a6ae' : '#b9c9cf'}"/>`).join('');
  const tick = (x) => `<text x="${X(x)}" y="${H - 6}" font-size="10" text-anchor="middle" fill="#6d6d6d">${fmt(x)}</text>`;
  const step = (hi - lo) > 80 ? 20 : 10, t0 = Math.ceil(lo / step) * step;
  let ticks = ''; for (let x = t0; x < hi; x += step) ticks += tick(x);
  return `<svg width="100%" viewBox="0 0 ${W} ${H}">${bars}
    <line x1="${pad}" x2="${W - pad}" y1="${H - 22}" y2="${H - 22}" stroke="#cfcfcf"/>
    <line x1="${X(v.avail)}" x2="${X(v.avail)}" y1="6" y2="${H - 22}" stroke="#024c5e" stroke-width="2"/>
    <line x1="${X(v.need)}" x2="${X(v.need)}" y1="6" y2="${H - 22}" stroke="#e5a128" stroke-width="2" stroke-dasharray="4 3"/>
    <text x="${X(v.avail) + (X(v.avail) > W - 60 ? -4 : 4)}" y="14" font-size="10" text-anchor="${X(v.avail) > W - 60 ? 'end' : 'start'}" fill="#024c5e">${fmt(v.avail)} kWh available</text>
    ${ticks}</svg>`;
}

main();
