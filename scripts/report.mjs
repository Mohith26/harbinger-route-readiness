// Prints every headline number shown on the page, computed by the same code on the same data.
import { readFileSync } from 'node:fs';
import { backtest, tomorrowPlan } from '../src/analysis.js';
const data = JSON.parse(readFileSync(new URL('../data/fleet.json', import.meta.url)));
const truth = JSON.parse(readFileSync(new URL('../data/truth.json', import.meta.url)));
const bt = backtest(data);
console.log('BACKTEST rolling months', bt.months.map((m) => m.month + ':' + (m.coverage95 * 100).toFixed(1)).join(' '), 'route-days', bt.n);
for (const c of bt.coverage) console.log(' level', c.level, 'coverage', (c.all * 100).toFixed(1));
console.log(' trailing-avg +15% buffer coverage', (bt.naive.all * 100).toFixed(1));
console.log(' midday', bt.midday, 'flagged', bt.flagged, 'range readout cleared', bt.naiveCleared, 'false alarms', bt.falseAlarms);
console.log(' PIT deciles', bt.pit.join(' '));
const t = tomorrowPlan(data);
const s = t.summary;
console.log('TOMORROW', data.tomorrow.date, data.tomorrow.note, 'cal n', t.nCal);
console.log(' at risk (<90%) dispatcher', s.atRiskHome, 'recommended', s.atRiskRec, 'at-risk cleared by range readout', s.atRiskClearedByReadout);
console.log(' expected midday charges', s.expectedMiddayHome.toFixed(2), '->', s.expectedMiddayRec.toFixed(3));
console.log(' min P', s.minPHome.toFixed(3), '->', s.minPRec.toFixed(3), 'swaps', s.swaps, 'reachable', s.allReachable);
console.log(' charge kWh tonight default', s.chargeKwhDefault.toFixed(0), 'recommended', s.chargeKwhRec.toFixed(0), 'below 90%:', s.below90Rec);
for (const r of t.rows) console.log(' ', r.route, r.homeTruck, r.truck, r.swapped ? 'SWAP' : '    ', 'pHome', r.pHome.toFixed(3), 'pRec', r.pRec.toFixed(3), 'chargeTo', r.chargeTo, 'mu', r.muKwh.toFixed(1), 'availHome', r.availHome.toFixed(1), 'miles', r.miles, 'stops', r.stops, 'readout mi', r.rangeReadoutMiles.toFixed(0), r.rangeReadoutOk);
for (const tr of data.trucks) { const c = t.caps[tr.id]; console.log(' cap', tr.id, tr.packs, c.kwh.toFixed(1), '+-', c.se.toFixed(2), 'true', truth.capacityKwh[tr.id]); }
