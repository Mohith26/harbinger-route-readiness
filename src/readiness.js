// Route Readiness core: calibrated route-energy forecasts, pack capacity from
// charge logs, finish probabilities, truck-to-route assignment and charge-to targets.
// Pure functions, no dependencies. Runs in the browser and under `node --test`.

export const RESERVE_SOC = 0.10; // arrive back at the depot with at least 10% SoC

// ---------- seeded randomness ----------
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
export function gauss(rng) {
  let u = 0, v = 0;
  while (u === 0) u = rng();
  while (v === 0) v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

// ---------- linear algebra ----------
export function solve(A, b) {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    [M[c], M[p]] = [M[p], M[c]];
    const d = M[c][c];
    if (Math.abs(d) < 1e-12) throw new Error('singular system');
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = M[r][c] / d;
      for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
    }
  }
  return M.map((row, i) => row[n] / row[i]);
}

// Ridge least squares (intercept, column 0, unpenalised). Columns are scaled
// internally so one lambda works for features with different units.
export function fitRidge(X, y, lambda = 1e-3) {
  const p = X[0].length, n = X.length;
  const scale = new Array(p).fill(0);
  for (const row of X) row.forEach((v, j) => (scale[j] += v * v));
  for (let j = 0; j < p; j++) scale[j] = Math.sqrt(scale[j] / n) || 1;
  const A = Array.from({ length: p }, () => new Array(p).fill(0));
  const b = new Array(p).fill(0);
  for (let i = 0; i < n; i++) {
    const z = X[i].map((v, j) => v / scale[j]);
    for (let j = 0; j < p; j++) {
      b[j] += z[j] * y[i];
      for (let k = 0; k < p; k++) A[j][k] += z[j] * z[k];
    }
  }
  for (let j = 1; j < p; j++) A[j][j] += lambda * n;
  const w = solve(A, b);
  return w.map((v, j) => v / scale[j]);
}
export const dot = (a, b) => a.reduce((s, v, i) => s + v * b[i], 0);

// ---------- route energy model ----------
// Physically motivated features of a route-day for a given truck.
export function hoursOnRoute(trip) {
  return trip.stops * 0.045 + trip.miles / 24;
}
export function features(trip, truck) {
  const T = trip.tempC;
  const h = hoursOnRoute(trip);
  return [
    1,
    trip.miles, // rolling + aero at urban speeds
    trip.stops, // stop-and-go accelerations
    trip.payloadT * trip.miles, // mass
    (truck.packs - 4) * trip.miles, // each extra 35 kWh pack adds mass
    trip.climbM, // net climbing energy
    Math.max(0, 17 - T) * h, // cab heat with doors opening
    Math.max(0, 15 - T) * trip.miles, // cold drivetrain and tyres
    Math.max(0, 8 - T), // pack warm-up on cold mornings
  ];
}
export const FEATURE_NAMES = ['base', 'miles', 'stops', 'payload x miles', 'extra packs x miles', 'climb', 'cab heat', 'cold miles', 'pack warm-up'];

// Fit mean model, then a scale model on |residual| so the conformal score is a
// normalised residual (locally adaptive split conformal).
export function fitEnergyModel(trips, trucksById) {
  const X = trips.map((t) => features(t, trucksById[t.truck]));
  const y = trips.map((t) => t.kwh);
  const beta = fitRidge(X, y, 1e-4);
  const mus = X.map((x) => dot(x, beta));
  const absR = y.map((v, i) => Math.abs(v - mus[i]));
  const Z = mus.map((m) => [1, m]);
  let gamma = fitRidge(Z, absR, 1e-6);
  return { beta, gamma };
}
export function predict(model, trip, truck) {
  const x = features(trip, truck);
  const mu = dot(x, model.beta);
  const sigma = Math.max(1.5, model.gamma[0] + model.gamma[1] * mu);
  return { mu, sigma, x };
}
export function contributions(model, trip, truck) {
  const x = features(trip, truck);
  return FEATURE_NAMES.map((name, j) => ({ name, kwh: x[j] * model.beta[j] }));
}

export function calibrationScores(model, trips, trucksById) {
  return trips
    .map((t) => {
      const { mu, sigma } = predict(model, t, trucksById[t.truck]);
      return (t.kwh - mu) / sigma;
    })
    .sort((a, b) => a - b);
}

// Number of sorted scores <= z (binary search).
export function countLE(sorted, z) {
  let lo = 0, hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid] <= z) lo = mid + 1; else hi = mid;
  }
  return lo;
}
// Conservative conformal predictive CDF: P(score <= z) >= count/(n+1).
export function conformalCdf(sorted, z) {
  return countLE(sorted, z) / (sorted.length + 1);
}
// Upper (1-alpha) conformal quantile of route energy; Infinity if n is too small.
export function energyQuantile(model, sorted, trip, truck, alpha) {
  const n = sorted.length;
  const k = Math.ceil((n + 1) * (1 - alpha));
  const { mu, sigma } = predict(model, trip, truck);
  if (k > n) return Infinity;
  return mu + sigma * sorted[k - 1];
}

// ---------- pack capacity from charge sessions ----------
// Deming (total least squares) regression through the origin:
// kWh_in = C * dSoC, with noise in both the metered energy and the BMS SoC delta.
export function demingThroughOrigin(xs, ys, lambda) {
  let sxx = 0, syy = 0, sxy = 0;
  for (let i = 0; i < xs.length; i++) {
    sxx += xs[i] * xs[i];
    syy += ys[i] * ys[i];
    sxy += xs[i] * ys[i];
  }
  const d = syy - lambda * sxx;
  return (d + Math.sqrt(d * d + 4 * lambda * sxy * sxy)) / (2 * sxy);
}
export function estimateCapacity(sessions, { sigmaSoc = 0.017, sigmaKwh = 0.6, boot = 200, seed = 7 } = {}) {
  const xs = sessions.map((s) => s.socEnd - s.socStart);
  const ys = sessions.map((s) => s.kwhIn);
  const lambda = (sigmaKwh * sigmaKwh) / (sigmaSoc * sigmaSoc);
  const C = demingThroughOrigin(xs, ys, lambda);
  const rng = mulberry32(seed);
  const reps = [];
  for (let b = 0; b < boot; b++) {
    const bx = [], by = [];
    for (let i = 0; i < xs.length; i++) {
      const j = Math.floor(rng() * xs.length);
      bx.push(xs[j]);
      by.push(ys[j]);
    }
    reps.push(demingThroughOrigin(bx, by, lambda));
  }
  const m = reps.reduce((a, b) => a + b, 0) / reps.length;
  const se = Math.sqrt(reps.reduce((a, b) => a + (b - m) * (b - m), 0) / (reps.length - 1));
  return { kwh: C, se, n: xs.length };
}

// ---------- finish probability ----------
// Gauss-Hermite (probabilists') nodes/weights to integrate over capacity uncertainty.
const GH = [
  [-2.856970013872806, 0.011257411327720691],
  [-1.355626179974266, 0.2220759220056126],
  [0, 0.5333333333333333],
  [1.355626179974266, 0.2220759220056126],
  [2.856970013872806, 0.011257411327720691],
];
export function finishProbability(model, sorted, trip, truck, cap, socDepart, reserve = RESERVE_SOC) {
  const { mu, sigma } = predict(model, trip, truck);
  let p = 0;
  for (const [z, w] of GH) {
    const avail = (cap.kwh + z * cap.se) * (socDepart - reserve);
    p += w * conformalCdf(sorted, (avail - mu) / sigma);
  }
  return p;
}
// Lowest departure SoC (1% steps) whose finish probability meets the target.
export function chargeTarget(model, sorted, trip, truck, cap, target, reserve = RESERVE_SOC) {
  for (let s = 30; s <= 100; s++) {
    if (finishProbability(model, sorted, trip, truck, cap, s / 100, reserve) >= target) return s / 100;
  }
  return null;
}

// ---------- assignment (Hungarian algorithm, min-cost perfect matching) ----------
export function hungarian(cost) {
  const n = cost.length;
  const INF = 1e18;
  const u = new Array(n + 1).fill(0), v = new Array(n + 1).fill(0);
  const p = new Array(n + 1).fill(0), way = new Array(n + 1).fill(0);
  for (let i = 1; i <= n; i++) {
    p[0] = i;
    let j0 = 0;
    const minv = new Array(n + 1).fill(INF);
    const used = new Array(n + 1).fill(false);
    do {
      used[j0] = true;
      const i0 = p[j0];
      let delta = INF, j1 = 0;
      for (let j = 1; j <= n; j++) {
        if (used[j]) continue;
        const cur = cost[i0 - 1][j - 1] - u[i0] - v[j];
        if (cur < minv[j]) { minv[j] = cur; way[j] = j0; }
        if (minv[j] < delta) { delta = minv[j]; j1 = j; }
      }
      for (let j = 0; j <= n; j++) {
        if (used[j]) { u[p[j]] += delta; v[j] -= delta; } else minv[j] -= delta;
      }
      j0 = j1;
    } while (p[j0] !== 0);
    do {
      const j1 = way[j0];
      p[j0] = p[j1];
      j0 = j1;
    } while (j0);
  }
  const assign = new Array(n);
  for (let j = 1; j <= n; j++) assign[p[j] - 1] = j - 1;
  return assign; // assign[row] = column
}

// Assign trucks to tomorrow's routes to maximise the probability that every
// route finishes without a midday charge (sum of log P), with a tiny penalty
// per swap so the dispatcher's plan is kept wherever it is already safe.
export function planAssignment(probMatrix, homeTruckIdx, { swapPenalty = 0.003, compatible } = {}) {
  const n = probMatrix.length;
  const cost = probMatrix.map((row, r) =>
    row.map((p, t) => {
      if (compatible && !compatible(r, t)) return 1e6;
      return -Math.log(Math.max(p, 1e-9)) + (t === homeTruckIdx[r] ? 0 : swapPenalty);
    })
  );
  return hungarian(cost);
}

// ---------- backtest helpers ----------
export function naiveRangeOk(trip, truck, avgKwhPerMile, capKwh, socDepart, reserve = RESERVE_SOC) {
  // What a remaining-range readout implies: SoC x capacity / recent average efficiency.
  const rangeMiles = (capKwh * (socDepart - reserve)) / avgKwhPerMile;
  return rangeMiles >= trip.miles;
}
export function needsMiddayCharge(trip, capTrueKwh, reserve = RESERVE_SOC) {
  return trip.kwh > capTrueKwh * (trip.socStart - reserve);
}
