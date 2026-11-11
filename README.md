# Route Readiness for Harbinger Telematics (concept)

**Live demo:** https://mohith26.github.io/harbinger-route-readiness/

An unofficial concept feature for Harbinger Telematics, built by Mohith Gajjela. Not affiliated with Harbinger. All data is synthetic.

## What it does

The night before, Route Readiness answers one question for every route on tomorrow's plan: **what is the chance this van gets back to the depot with at least 10% state of charge, without a midday charge?** Then it fixes the plan:

1. **Calibrated route energy.** A physically motivated linear model (miles, stops, payload, extra pack mass, climb, cab heat with doors opening, cold drivetrain, pack warm-up) is fit on the fleet's own route history. A second model scales the residual with the size of the route, and **split conformal prediction** on the last 7 weeks of normalized residuals turns the forecast into a full predictive distribution. Any quantile of it (p95, p99) holds at its stated rate on held-out days without assuming the noise is Gaussian.
2. **Each van's real capacity.** Usable pack energy is estimated from the van's own overnight charge sessions with **Deming (total least squares) regression** of kWh delivered on BMS ΔSoC. Ordinary least squares is biased low when the SoC readings are noisy; TLS is not. Bootstrap gives the uncertainty, which is integrated into the finish probability with Gauss-Hermite quadrature.
3. **Finish probability** = share of conformal outcomes that land under `capacity × (departure SoC − 10%)`.
4. **Recommended plan.** The **Hungarian algorithm** reassigns vans to routes to maximize the joint probability that every route finishes (sum of log P), with a small penalty per swap so the dispatcher's standing assignment is kept wherever it's already safe.
5. **Charge-to targets.** For each van, the lowest departure SoC (1% steps) that meets the chosen target (95 / 97.5 / 99%). Vans on light routes stop below the usual 90%, which means less time parked at high SoC. If a route can't reach the target even at 100%, it says so and estimates how many stops to move to another van.

## Demo numbers (all computed in the browser from `data/fleet.json`)

`node scripts/report.mjs` prints the same numbers from the same code:

- **Tomorrow (cold front, 9 °C route-hours mean):** the dispatcher's standing plan with everyone charged to 90% has **3 routes under 90%**, worst **42%**, 1.41 expected midday charges. The recommended plan swaps **6 vans**, lifts the worst route to **98.5%**, cuts expected midday charges to **0.19**, and lets **17 vans** charge to under 90%. One route (R-101) stays just under the 99% target even at 100%.
- **Rolling-origin backtest (Feb to Nov 2026, 5,016 route-days, refit monthly, nothing from the test month used):** the 80 / 90 / 95 / 99% energy bounds held on **79.7 / 90.6 / 95.1 / 99.3%** of route-days. The night-before check flagged **7 of 14** midday charges (19 false alarms in 5,016), while a remaining-range readout (SoC × capacity ÷ trailing 7-day kWh per mile) cleared 12 of the 14.

## Why it fits Harbinger

Harbinger Telematics already shows SoC, remaining range, average Wh/km and full capacity per vehicle, and the roadmap calls for "advanced service and analytics features." Route Readiness sits next to Vehicles and Events in the same Fleet Management app, uses only data the truck and the fleet's planner already have, and turns the per-vehicle numbers into a decision dispatchers make every night: which van takes which route, and how far to charge it.

## Novelty note

I checked Harbinger's site, telematics one-pager, product lineup, step van brochure, charging guide, blog and newsroom (Nov 2026). Harbinger Telematics lists fleet and vehicle dashboards, status and health, energy and SoC tracking, and third-party integration; I found no route-level readiness, finish probability, or assignment feature. Elsewhere: Geotab shows a per-vehicle remaining range with a 90% interval, Samsara lists EV routing and dispatch based on estimated range ("coming soon" on some pages), and charge-management tools like Flipturn set per-vehicle SoC targets. I did not find a product that combines route-level calibrated finish probabilities, charge-log capacity estimates and joint van-to-route reassignment.

## Run it

```
python3 -m http.server   # then open http://localhost:8000
node --test test/readiness.test.mjs
node scripts/report.mjs
node scripts/generate.mjs   # regenerates data/fleet.json and data/truth.json (seeded)
```

No build step; Leaflet, Inter and Material Symbols load from CDNs. Map tiles from Esri World Street Map. Route outlines were traced once through each synthetic route's stop clusters with the public OSRM demo server (`scripts/fetch_paths.mjs`) and committed.

## Tests (9, `node --test`)

Generator determinism vs committed data; Hungarian vs brute force; ridge recovery; split-conformal finite-sample coverage; Deming unbiased where OLS is attenuated; capacity within 1.5% of the hidden truth for all 24 vans; backtest coverage within 1.5 points at every level plus a PIT uniformity check; tomorrow's finish probabilities vs a Monte Carlo of the hidden simulator (same at-risk set, mean absolute difference under 3 points, recommended plan's true average above 98.5%); charge-to targets are minimal and monotone.

## Honest limitations

- Synthetic fleet: 24 step vans, one depot, one route per van per weekday, Dec 2025 to Nov 2026. The simulator's physics is simple and the energy model's features mirror it, which flatters the model. Real data will need more features (speed profile, HVAC setpoints, driver, door-open time) and probably a non-linear model; the conformal layer works on top of any model.
- Conformal coverage is marginal (averaged over routes), not per route. On individual routes the recommended plan's true finish probability ranged from about 98% to 100% against the 99% target.
- It assumes tomorrow looks like the calibration window apart from the features. A cold front colder than anything in history, or a new route type, needs a wider window or adaptive conformal updates.
- The night-before flag caught only half the midday charges in the backtest; the other half came from random incidents (detours, missed charges) that no forecast sees the night before.
- Usable capacity as a share of the pack rating assumes 94% usable, my assumption, not a Harbinger spec. Map outlines are display-only; planned miles and stops come from the generator.
