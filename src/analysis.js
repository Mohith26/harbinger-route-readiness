// Orchestrates the Route Readiness computation for the app and the report script.
import {
  conformalCdf, fitEnergyModel, calibrationScores, predict, energyQuantile, estimateCapacity,
  finishProbability, chargeTarget, planAssignment, naiveRangeOk, contributions, RESERVE_SOC,
} from './readiness.js';

const byDate = (from, to) => (t) => t.d >= from && t.d <= to;

// Split: fit the energy model on older days, calibrate conformal scores on recent days.
export const LIVE_SPLIT = { trainFrom: '2025-12-01', trainTo: '2026-09-30', calFrom: '2026-10-01', calTo: '2026-11-19' };
export const BACKTEST_SPLIT = { trainFrom: '2025-12-01', trainTo: '2026-08-31', calFrom: '2026-09-01', calTo: '2026-10-09', testFrom: '2026-10-12', testTo: '2026-11-19' };

export function capacities(data, asOf, windowDays = 60) {
  const from = new Date(Date.parse(asOf) - windowDays * 86400000).toISOString().slice(0, 10);
  const out = {};
  data.trucks.forEach((t, i) => {
    const s = data.sessions.filter((x) => x.truck === t.id && x.d > from && x.d <= asOf);
    out[t.id] = estimateCapacity(s, { seed: 11 + i });
  });
  return out;
}

// Rolling-origin backtest. For each month from Feb 2026, refit on everything before the last
// 28 days, calibrate on those 28 days, and score the month that follows. Nothing from the
// test month is used to make its own forecasts.
export function backtestMonths(data) {
  const months = [];
  for (let m = 1; m <= 10; m++) {
    const first = `2026-${String(m + 1).padStart(2, '0')}-01`;
    const next = m + 2 <= 12 ? `2026-${String(m + 2).padStart(2, '0')}-01` : '2027-01-01';
    const calFrom = new Date(Date.parse(first) - 28 * 86400000).toISOString().slice(0, 10);
    months.push({ first, next, calFrom });
  }
  return months;
}
const addDays = (d, k) => new Date(Date.parse(d) + k * 86400000).toISOString().slice(0, 10);

export function backtest(data, { levels = [0.8, 0.9, 0.95, 0.99], flagThreshold = 0.9, buffer = 0.15 } = {}) {
  const trucksById = Object.fromEntries(data.trucks.map((t) => [t.id, t]));
  const tripsByTruck = {};
  for (const t of data.trips) (tripsByTruck[t.truck] ||= []).push(t);
  const res = { n: 0, cover: levels.map(() => 0), naiveCover: 0,
    midday: 0, flagged: 0, naiveCleared: 0, falseAlarms: 0, pit: new Array(10).fill(0), months: [] };
  for (const M of backtestMonths(data)) {
    const train = data.trips.filter((t) => t.d < M.calFrom);
    const cal = data.trips.filter((t) => t.d >= M.calFrom && t.d < M.first);
    const test = data.trips.filter((t) => t.d >= M.first && t.d < M.next);
    if (!test.length) continue;
    const model = fitEnergyModel(train, trucksById);
    const scores = calibrationScores(model, cal, trucksById);
    const caps = capacities(data, addDays(M.first, -1));
    let mCov = 0;
    for (const t of test) {
      const truck = trucksById[t.truck];
      res.n++;
      levels.forEach((lv, i) => {
        const q = energyQuantile(model, scores, t, truck, 1 - lv);
        if (t.kwh <= q) { res.cover[i]++; if (lv === 0.95) mCov++; }
      });
      const { mu, sigma } = predict(model, t, truck);
      const u = conformalCdf(scores, (t.kwh - mu) / sigma);
      res.pit[Math.min(9, Math.floor(u * 10))]++;
      // remaining-range style estimate: trailing 7 route-days kWh/mile x planned miles, + buffer
      const prev = tripsByTruck[t.truck].filter((x) => x.d < t.d).slice(-7);
      const avg = prev.reduce((a, x) => a + x.kwh, 0) / prev.reduce((a, x) => a + x.milesActual, 0);
      if (t.kwh <= avg * t.miles * (1 + buffer)) res.naiveCover++;
      const p = finishProbability(model, scores, t, truck, caps[t.truck], t.socStart);
      const naiveOk = naiveRangeOk(t, truck, avg, caps[t.truck].kwh, t.socStart, RESERVE_SOC);
      if (t.midday) { res.midday++; if (p < flagThreshold) res.flagged++; if (naiveOk) res.naiveCleared++; }
      else if (p < flagThreshold) res.falseAlarms++;
    }
    res.months.push({ month: M.first.slice(0, 7), n: test.length, coverage95: mCov / test.length, nCal: scores.length });
  }
  res.levels = levels; res.flagThreshold = flagThreshold; res.buffer = buffer;
  res.coverage = levels.map((lv, i) => ({ level: lv, all: res.cover[i] / res.n }));
  res.naive = { all: res.naiveCover / res.n };
  return res;
}

// Tomorrow: dispatcher plan vs recommended plan.
export function tomorrowPlan(data, { target = 0.99, defaultSoc = 0.9 } = {}) {
  const S = LIVE_SPLIT;
  const trucks = data.trucks;
  const trucksById = Object.fromEntries(trucks.map((t) => [t.id, t]));
  const model = fitEnergyModel(data.trips.filter(byDate(S.trainFrom, S.trainTo)), trucksById);
  const scores = calibrationScores(model, data.trips.filter(byDate(S.calFrom, S.calTo)), trucksById);
  const caps = capacities(data, S.calTo);
  const plan = data.plan;
  const idx = Object.fromEntries(trucks.map((t, i) => [t.id, i]));
  const home = plan.map((p) => idx[p.homeTruck]);
  // finish probability for every (route, truck) pair at 100% departure SoC: what is feasible
  const P100 = plan.map((p) => trucks.map((t) => finishProbability(model, scores, p, t, caps[t.id], 1.0)));
  const assign = planAssignment(P100, home);
  const rows = plan.map((p, r) => {
    const hTruck = trucks[home[r]], rTruck = trucks[assign[r]];
    const pred = predict(model, p, rTruck);
    const need = energyQuantile(model, scores, p, rTruck, 1 - target);
    const needHome = energyQuantile(model, scores, p, hTruck, 0.05);
    const pHome = finishProbability(model, scores, p, hTruck, caps[hTruck.id], defaultSoc);
    const chargeTo = chargeTarget(model, scores, p, rTruck, caps[rTruck.id], target);
    const soc = chargeTo ?? 1.0;
    const pRec = finishProbability(model, scores, p, rTruck, caps[rTruck.id], soc);
    return {
      route: p.route, miles: p.miles, stops: p.stops, payloadT: p.payloadT, climbM: p.climbM, tempC: p.tempC,
      homeTruck: hTruck.id, truck: rTruck.id, swapped: hTruck.id !== rTruck.id,
      pHome, pRec, chargeTo, reachable: chargeTo !== null,
      muKwh: pred.mu, needP95Home: needHome, needAtTarget: need,
      availHome: caps[hTruck.id].kwh * (defaultSoc - RESERVE_SOC),
      availRec: caps[rTruck.id].kwh * (soc - RESERVE_SOC),
      kwhToChargeDefault: caps[hTruck.id].kwh * defaultSoc,
      kwhToChargeRec: caps[rTruck.id].kwh * soc,
      contributions: contributions(model, p, rTruck),
      contributionsHome: contributions(model, p, hTruck),
    };
  });
  const sum = (f) => rows.reduce((a, r) => a + f(r), 0);
  const summary = {
    routes: rows.length,
    atRiskHome: rows.filter((r) => r.pHome < 0.9).length,
    atRiskRec: rows.filter((r) => r.pRec < 0.9).length,
    expectedMiddayHome: sum((r) => 1 - r.pHome),
    expectedMiddayRec: sum((r) => 1 - r.pRec),
    minPHome: Math.min(...rows.map((r) => r.pHome)),
    minPRec: Math.min(...rows.map((r) => r.pRec)),
    swaps: rows.filter((r) => r.swapped).length,
    allReachable: rows.every((r) => r.reachable),
    // energy both plans put into packs tonight relative to 0% (comparison only needs the difference)
    chargeKwhDefault: sum((r) => r.kwhToChargeDefault),
    chargeKwhRec: sum((r) => r.kwhToChargeRec),
    below90Rec: rows.filter((r) => r.chargeTo !== null && r.chargeTo < 0.9).length,
    target,
  };
  return { rows, summary, caps, model, nCal: scores.length, scores };
}
