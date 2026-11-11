import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  mulberry32, gauss, hungarian, conformalCdf, countLE, estimateCapacity, demingThroughOrigin,
  finishProbability, chargeTarget, fitRidge, RESERVE_SOC,
} from '../src/readiness.js';
import { backtest, tomorrowPlan } from '../src/analysis.js';
import { generate, simulateTomorrow } from '../scripts/generate.mjs';

const data = JSON.parse(readFileSync(new URL('../data/fleet.json', import.meta.url)));
const truth = JSON.parse(readFileSync(new URL('../data/truth.json', import.meta.url)));

test('generator is deterministic and matches the committed data', () => {
  const g = generate();
  delete g._truth;
  assert.equal(JSON.stringify(g), JSON.stringify(data));
});

test('hungarian matches brute force on random 6x6 matrices', () => {
  const rng = mulberry32(3);
  const perms = (a) => (a.length <= 1 ? [a] : a.flatMap((x, i) => perms([...a.slice(0, i), ...a.slice(i + 1)]).map((p) => [x, ...p])));
  const all = perms([0, 1, 2, 3, 4, 5]);
  for (let rep = 0; rep < 40; rep++) {
    const C = Array.from({ length: 6 }, () => Array.from({ length: 6 }, () => rng() * 10));
    const best = Math.min(...all.map((p) => p.reduce((s, c, r) => s + C[r][c], 0)));
    const a = hungarian(C);
    assert.equal(new Set(a).size, 6);
    assert.ok(Math.abs(a.reduce((s, c, r) => s + C[r][c], 0) - best) < 1e-9);
  }
});

test('ridge with tiny lambda recovers a known linear model', () => {
  const rng = mulberry32(5);
  const X = [], y = [];
  for (let i = 0; i < 400; i++) {
    const a = rng() * 100, b = rng() * 10;
    X.push([1, a, b]);
    y.push(3 + 0.8 * a - 2 * b + 0.01 * gauss(rng));
  }
  const w = fitRidge(X, y, 1e-9);
  assert.ok(Math.abs(w[0] - 3) < 0.01 && Math.abs(w[1] - 0.8) < 1e-3 && Math.abs(w[2] + 2) < 1e-3);
});

test('split-conformal bound has finite-sample coverage on exchangeable data', () => {
  // 1-alpha bound from n calibration scores covers a fresh draw with prob >= 1-alpha
  const alpha = 0.1, n = 49, reps = 3000;
  let covered = 0;
  const rng = mulberry32(17);
  for (let r = 0; r < reps; r++) {
    const s = Array.from({ length: n }, () => Math.exp(gauss(rng))).sort((a, b) => a - b);
    const k = Math.ceil((n + 1) * (1 - alpha));
    if (Math.exp(gauss(rng)) <= s[k - 1]) covered++;
  }
  const cov = covered / reps;
  assert.ok(cov >= 0.88 && cov <= 0.93, `coverage ${cov}`);
  assert.equal(countLE([1, 2, 2, 3], 2), 3);
  assert.equal(conformalCdf([1, 2, 3], 10), 0.75);
});

test('Deming capacity estimate is unbiased where OLS through the origin is not', () => {
  const rng = mulberry32(8);
  const C = 160, xs = [], ys = [];
  for (let i = 0; i < 300; i++) {
    const d = 0.03 + rng() * 0.12; // short top-ups make SoC noise matter
    xs.push(d + 0.017 * gauss(rng));
    ys.push(C * d + 0.5 * gauss(rng));
  }
  const ols = xs.reduce((a, x, i) => a + x * ys[i], 0) / xs.reduce((a, x) => a + x * x, 0);
  const dem = demingThroughOrigin(xs, ys, (0.5 * 0.5) / (0.017 * 0.017));
  assert.ok(Math.abs(dem - C) / C < 0.015, `deming ${dem}`);
  assert.ok(ols < C * 0.985, `ols ${ols} should be attenuated`);
});

test('pack capacity from 60 days of charge logs is within 1.5% of the hidden truth for every van', () => {
  for (const t of data.trucks) {
    const s = data.sessions.filter((x) => x.truck === t.id && x.d > '2026-09-20');
    const est = estimateCapacity(s);
    const err = Math.abs(est.kwh - truth.capacityKwh[t.id]) / truth.capacityKwh[t.id];
    assert.ok(err < 0.015, `${t.id} err ${err}`);
  }
});

test('rolling backtest: energy bounds hold at their stated levels', () => {
  const bt = backtest(data);
  assert.ok(bt.n > 4000);
  for (const c of bt.coverage) assert.ok(Math.abs(c.all - c.level) < 0.015, `level ${c.level} got ${c.all}`);
  // PIT deciles roughly uniform (chi-square, 9 dof, p ~ 0.001 cutoff 27.9)
  const e = bt.n / 10;
  const chi = bt.pit.reduce((a, o) => a + ((o - e) ** 2) / e, 0);
  assert.ok(chi < 27.9, `chi2 ${chi}`);
  assert.ok(bt.flagged > bt.midday - bt.naiveCleared, 'flags more midday charges than the range readout');
});

test("tomorrow's finish probabilities agree with the hidden simulator", () => {
  const plan = tomorrowPlan(data);
  let sumAbs = 0;
  for (const r of plan.rows) {
    const pt = simulateTomorrow(data, truth, r.route, r.homeTruck, 0.9);
    sumAbs += Math.abs(pt - r.pHome);
    assert.equal(pt < 0.9, r.pHome < 0.9, `${r.route} at-risk flag disagrees (${r.pHome} vs ${pt})`);
  }
  assert.ok(sumAbs / plan.rows.length < 0.03, `mean abs diff ${sumAbs / plan.rows.length}`);
  // recommended plan: average true finish probability meets the 99% target within MC error
  const recTrue = plan.rows.map((r) => simulateTomorrow(data, truth, r.route, r.truck, r.chargeTo ?? 1));
  assert.ok(recTrue.reduce((a, b) => a + b, 0) / recTrue.length > 0.985);
  assert.ok(Math.min(...recTrue) > 0.97);
});

test('recommended plan: fewer at-risk routes, minimal charge-to targets, swaps only where they help', () => {
  const plan = tomorrowPlan(data);
  const s = plan.summary;
  assert.ok(s.atRiskRec <= s.atRiskHome && s.minPRec > s.minPHome && s.expectedMiddayRec < s.expectedMiddayHome);
  const trucksById = Object.fromEntries(data.trucks.map((t) => [t.id, t]));
  const assigned = new Set(plan.rows.map((r) => r.truck));
  assert.equal(assigned.size, data.trucks.length);
  for (const r of plan.rows) {
    const p = data.plan.find((x) => x.route === r.route);
    const truck = trucksById[r.truck], cap = plan.caps[r.truck];
    if (r.chargeTo !== null) {
      assert.ok(finishProbability(plan.model, plan.scores, p, truck, cap, r.chargeTo) >= 0.99);
      if (r.chargeTo > 0.3) assert.ok(finishProbability(plan.model, plan.scores, p, truck, cap, r.chargeTo - 0.01) < 0.99);
    } else {
      assert.ok(finishProbability(plan.model, plan.scores, p, truck, cap, 1) < 0.99);
    }
  }
  // monotone in departure SoC
  const r0 = data.plan[2], t0 = trucksById[r0.homeTruck]; // R-103, reachable
  let prev = -1;
  for (let soc = 0.5; soc <= 1.0001; soc += 0.05) {
    const pr = finishProbability(plan.model, plan.scores, r0, t0, plan.caps[t0.id], soc);
    assert.ok(pr >= prev); prev = pr;
  }
  assert.ok(chargeTarget(plan.model, plan.scores, r0, t0, plan.caps[t0.id], 0.5) <= chargeTarget(plan.model, plan.scores, r0, t0, plan.caps[t0.id], 0.99));
  assert.equal(RESERVE_SOC, 0.1);
});
