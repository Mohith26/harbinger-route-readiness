// One-time helper: turns each synthetic route's seeded stop clusters into a road-following
// outline using the public OSRM demo server, saved to data/paths.json (committed).
// The outline is for display only; planned miles/stops come from scripts/generate.mjs.
// Usage: node scripts/fetch_paths.mjs
import { writeFileSync } from 'node:fs';
import { mulberry32 } from '../src/readiness.js';

const depot = { lat: 33.7849, lon: -117.9385 };
const rng = mulberry32(4242);
const out = {};
for (let i = 0; i < 24; i++) {
  const ang = (i / 24) * 2 * Math.PI + (rng() - 0.5) * 0.2;
  const reach = 3 + rng() * 9; // km from depot to the delivery area
  const cx = depot.lon + (Math.cos(ang) * reach) / 92.5, cy = depot.lat + (Math.sin(ang) * reach) / 111;
  const side = 2.5 + rng() * 3; // km
  const pts = [];
  for (let k = 0; k < 9; k++) pts.push([cy + ((rng() - 0.5) * side) / 111, cx + ((rng() - 0.5) * side) / 92.5]);
  pts.sort((a, b) => Math.atan2(a[0] - cy, a[1] - cx) - Math.atan2(b[0] - cy, b[1] - cx));
  const all = [[depot.lat, depot.lon], ...pts, [depot.lat, depot.lon]];
  const coords = all.map(([la, lo]) => `${lo.toFixed(5)},${la.toFixed(5)}`).join(';');
  const res = await fetch(`https://router.project-osrm.org/route/v1/driving/${coords}?overview=simplified&geometries=geojson`);
  const j = await res.json();
  if (j.code !== 'Ok') throw new Error('osrm ' + j.code);
  const id = `R-${101 + i}`;
  out[id] = { km: Math.round(j.routes[0].distance / 100) / 10, path: j.routes[0].geometry.coordinates.map(([lo, la]) => [Math.round(la * 1e5) / 1e5, Math.round(lo * 1e5) / 1e5]) };
  console.log(id, out[id].km, 'km', out[id].path.length, 'pts');
  await new Promise((r) => setTimeout(r, 400));
}
writeFileSync(new URL('../data/paths.json', import.meta.url), JSON.stringify(out));
