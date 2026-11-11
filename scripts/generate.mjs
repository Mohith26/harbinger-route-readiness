// Seeded synthetic fleet for the Route Readiness demo.
// 24 Harbinger step vans at one Orange County parcel depot, one route each per weekday,
// Dec 1 2025 to Thu Nov 19 2026, plus nightly charge sessions and tomorrow's plan.
// Usage: node scripts/generate.mjs  (writes data/fleet.json)
import { writeFileSync, readFileSync } from 'node:fs';
import { mulberry32, gauss } from '../src/readiness.js';

export const SEED = 20261120;

// Hidden ground-truth physics of one route-day. Planned miles/stops/payload come from the
// route planner; the realised route deviates (detours, extra stops) and so does energy.
export function dayEnergy(climbM, driver, packs, T, planned, rng) {
  const g = () => gauss(rng);
  const miles = planned.miles * (1 + 0.04 * g()) + (rng() < 0.05 ? 4 + 10 * rng() : 0);
  const stops = planned.stops * (1 + 0.05 * g());
  const payloadT = planned.payloadT * (1 + 0.06 * g());
  const hrs = stops * 0.045 + miles / 24;
  let e = miles * (0.74 + 0.018 * (packs - 4)) + payloadT * miles * 0.046 + stops * 0.105 + climbM * 0.0105;
  e += Math.max(0, 17 - T) * hrs * 0.21 + Math.max(0, 16 - T) * miles * 0.0042;
  if (T < 9) e += (9 - T) * 1.1 + (9 - T) ** 2 * 0.08; // pack heater, mildly non-linear
  e *= driver;
  e *= Math.exp(0.035 * g()); // day-to-day noise
  if (rng() < 0.03) e *= 1 + 0.06 + 0.1 * rng(); // incidents, missed charger, AC fault
  return { kwh: e, milesActual: miles };
}

export function generate(seed = SEED) {
  const rng = mulberry32(seed);
  const N = (m = 0, s = 1) => m + s * gauss(rng);
  const U = (a, b) => a + (b - a) * rng();
  const round = (v, k = 2) => Math.round(v * 10 ** k) / 10 ** k;

  const depot = { lat: 33.7849, lon: -117.9385, name: 'Garden Grove parcel depot' };

  // ---- trucks ----
  const packPlan = [4, 4, 4, 4, 4, 4, 4, 4, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 6, 6, 6, 6, 6, 6];
  const trucks = packPlan.map((packs, i) => {
    const ageDays = Math.round(U(60, 520)); // in service before Dec 1 2025
    const soh0 = Math.min(0.995, 0.995 - ageDays * 0.000045 - Math.abs(N(0, 0.012)));
    const nominal = packs * 35;
    return {
      id: `SG0002${String(i + 1).padStart(2, '0')}`,
      vin: `7ZN6S56A7SG0002${String(i + 1).padStart(2, '0')}`,
      model: packs === 4 ? 'Step Van P700' : packs === 5 ? 'Step Van P1000' : 'Step Van P1100',
      packs,
      nominalKwh: nominal,
      // true usable capacity on Dec 1 2025 (hidden; only charge logs are observed)
      _cap0: nominal * 0.94 * soh0,
      odometer0: Math.round(ageDays * U(70, 95)),
    };
  });
  // One van has a weak module that ages faster (realistic outlier).
  trucks[5]._fade = 0.00016;
  trucks.forEach((t) => (t._fade = t._fade || U(0.00003, 0.00006)));

  // ---- routes ----
  const routes = [];
  for (let i = 0; i < 24; i++) {
    const miles = U(38, 112);
    const stops = Math.round(U(85, 175) * (miles < 60 ? 1.1 : 0.95));
    const ang = (i / 24) * 2 * Math.PI + U(-0.12, 0.12);
    routes.push({
      id: `R-${101 + i}`,
      miles: round(miles, 1),
      stops,
      payloadT: round(U(1.1, 2.6), 2),
      climbM: Math.round(U(40, 160) + (Math.cos(ang - 0.6) > 0.55 ? U(250, 650) : 0)), // hills to the NE
      _driver: N(1, 0.045),
      angle: ang,
    });
  }
  // Dispatcher's standing ("home") assignment: biggest packs on longest routes, but imperfect.
  const byNeed = [...routes].sort((a, b) => b.miles + b.stops * 0.12 + b.climbM * 0.01 - (a.miles + a.stops * 0.12 + a.climbM * 0.01));
  const bySize = [...trucks].sort((a, b) => b.packs - a.packs || rng() - 0.5);
  // Shuffle within pairs of the ranking to mimic seniority / habit rather than optimisation.
  for (let k = 0; k + 2 < bySize.length; k += 3) {
    if (rng() < 0.7) [bySize[k + 1], bySize[k + 2]] = [bySize[k + 2], bySize[k + 1]];
  }
  [bySize[3], bySize[9]] = [bySize[9], bySize[3]];
  [bySize[7], bySize[16]] = [bySize[16], bySize[7]];
  byNeed.forEach((r, k) => (r.homeTruck = bySize[k].id));

  // Display outlines: road-following paths through each route's stop clusters
  // (data/paths.json, produced once by scripts/fetch_paths.mjs from the OSRM demo server).
  const paths = JSON.parse(readFileSync(new URL('../data/paths.json', import.meta.url)));
  for (const r of routes) {
    r.path = paths[r.id].path;
    r.outlineKm = paths[r.id].km;
    delete r.angle;
  }

  // ---- weather (route-hours mean temperature, Garden Grove-like) ----
  const start = Date.UTC(2025, 11, 1); // Mon Dec 1 2025
  const end = Date.UTC(2026, 10, 19); // Thu Nov 19 2026
  const days = [];
  let cold = 0;
  for (let t = start; t <= end; t += 86400000) {
    const d = new Date(t);
    const dow = d.getUTCDay();
    const doy = Math.floor((t - Date.UTC(d.getUTCFullYear(), 0, 1)) / 86400000);
    const seasonal = 18.6 - 5.4 * Math.cos((2 * Math.PI * (doy - 20)) / 365);
    cold = cold * 0.62 + (rng() < 0.06 ? -U(3, 8) : 0); // occasional cold fronts that linger
    const temp = seasonal + cold + N(0, 1.6);
    if (dow === 0 || dow === 6) continue;
    days.push({ date: d.toISOString().slice(0, 10), t, tempC: round(temp, 1), doy });
  }

  const routeTruth0 = Object.fromEntries(routes.map((r) => [r.id, r._driver]));
  const trucksById = Object.fromEntries(trucks.map((t) => [t.id, t]));
  const trips = [];
  const sessions = [];
  const soc = Object.fromEntries(trucks.map((t) => [t.id, 0.9]));
  for (const day of days) {
    const ageD = (day.t - start) / 86400000;
    const peak = day.doy >= 314 || day.doy <= 3 ? 1.12 : 1; // Nov 10 - Jan 3 holiday peak
    for (const r of routes) {
      const truck = trucksById[r.homeTruck];
      const cap = truck._cap0 * (1 - truck._fade * ageD);
      // the route planner's numbers for the day (known the night before)
      const miles = r.miles * (1 + N(0, 0.05));
      const stops = Math.max(20, Math.round(r.stops * peak * (1 + N(0, 0.08))));
      const payloadT = Math.max(0.4, r.payloadT * peak * (1 + N(0, 0.1)));
      const { kwh, milesActual } = dayEnergy(r.climbM, routeTruth0[r.id], truck.packs, day.tempC, { miles, stops, payloadT }, rng);
      const socStart = soc[truck.id];
      const midday = kwh > cap * (socStart - 0.1);
      let socEnd = socStart - kwh / cap;
      let middayKwh = 0;
      if (midday) {
        middayKwh = cap * (0.1 - socEnd) + U(8, 20); // topped up at a public charger
        socEnd += middayKwh / cap;
      }
      trips.push({
        d: day.date, r: r.id, truck: truck.id, tempC: day.tempC,
        miles: round(miles, 1), milesActual: round(milesActual, 1), stops, payloadT: round(payloadT, 2), climbM: r.climbM,
        kwh: round(kwh, 1), socStart: round(socStart, 3), socEnd: round(socEnd, 3), midday,
      });
      // overnight depot charge: usually to 90%, sometimes 100% (Mondays / ops request)
      const target = rng() < 0.1 ? 1 : 0.9;
      const kwhIn = cap * (target - socEnd);
      const socErr = () => N(0, 0.012); // BMS SoC estimate error at plug-in / unplug
      sessions.push({
        d: day.date, truck: truck.id,
        socStart: round(socEnd + socErr(), 3), socEnd: round(target + socErr(), 3),
        kwhIn: round(kwhIn * (1 + N(0, 0.003)) + N(0, 0.4), 2),
      });
      soc[truck.id] = target;
    }
  }

  // ---- tonight + tomorrow (Fri Nov 20 2026, cold front) ----
  const tomorrow = { date: '2026-11-20', tempC: 9.0, lowC: 5.0, highC: 13.0, note: 'Cold front: 9.0 C route-hours mean, low 5 C' };
  const tRng = mulberry32(seed + 1);
  const plan = routes.map((r) => ({
    route: r.id,
    miles: round(r.miles * (1 + 0.03 * gauss(tRng)), 1),
    stops: Math.round(r.stops * 1.12 * (1 + 0.05 * gauss(tRng))),
    payloadT: round(r.payloadT * 1.12, 2),
    climbM: r.climbM,
    tempC: tomorrow.tempC,
    homeTruck: r.homeTruck,
  }));
  const ageEnd = (end - start) / 86400000;
  const nowSoc = Object.fromEntries(trucks.map((t) => [t.id, round(Math.min(0.9, 0.35 + rng() * 0.6), 2)]));

  // strip hidden fields, but keep the true end-of-history capacity for tests
  const truth = Object.fromEntries(trucks.map((t) => [t.id, round(t._cap0 * (1 - t._fade * ageEnd), 2)]));
  const routeTruth = Object.fromEntries(routes.map((r) => [r.id, r._driver]));
  const cleanTrucks = trucks.map(({ _cap0, _fade, ...t }) => ({ ...t, odometer: t.odometer0 + Math.round(ageEnd * 61), socNow: nowSoc[t.id] }));
  const cleanRoutes = routes.map(({ _driver, ...r }) => r);
  return {
    meta: { seed, generated: 'scripts/generate.mjs', depot, reserveSoc: 0.1, defaultChargeTo: 0.9, historyStart: days[0].date, historyEnd: days[days.length - 1].date },
    trucks: cleanTrucks, routes: cleanRoutes, trips, sessions, tomorrow, plan,
    _truth: { capacityKwh: truth, driverFactor: routeTruth },
  };
}

// Monte Carlo ground truth for tomorrow (used only by tests to check calibration of the
// finish probabilities on the hidden simulator; never read by the app).
export function simulateTomorrow(data, truth, routeId, truckId, socDepart, nSim = 4000, seed = 99) {
  const rng = mulberry32(seed);
  const r = data.routes.find((x) => x.id === routeId);
  const p = data.plan.find((x) => x.route === routeId);
  const truck = data.trucks.find((x) => x.id === truckId);
  const cap = truth.capacityKwh[truckId];
  const drv = truth.driverFactor[routeId];
  let ok = 0;
  for (let i = 0; i < nSim; i++) {
    const { kwh } = dayEnergy(r.climbM, drv, truck.packs, p.tempC, p, rng);
    if (kwh <= cap * (socDepart - 0.1)) ok++;
  }
  return ok / nSim;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const data = generate();
  const truth = data._truth;
  delete data._truth;
  writeFileSync(new URL('../data/fleet.json', import.meta.url), JSON.stringify(data));
  writeFileSync(new URL('../data/truth.json', import.meta.url), JSON.stringify(truth, null, 1));
  console.log(`trucks ${data.trucks.length}, routes ${data.routes.length}, trips ${data.trips.length}, sessions ${data.sessions.length}, midday ${data.trips.filter((t) => t.midday).length}`);
}
