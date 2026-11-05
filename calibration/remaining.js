const path = require("node:path");
const { cases } = require("./interpolation");
const { load, prepare, learn, legsOf, profile } = require("./speedmodel");

const file = process.argv[2];
if (!file) throw new Error("usage: node calibration/remaining.js <island.jsonl>");
const rows = load(path.resolve(file));
const services = [...new Set(rows.map((r) => r.service))].sort();
const holdout = new Set(services.filter((_, i) => i % 3 === 2));
const prep = prepare(rows, services);
const train = services.filter((s) => !holdout.has(s));
const learned = learn(prep, legsOf(Object.fromEntries(train.map((s) => [s, prep.trackSets[s]])), prep.geos, prep.lanes, -Infinity, Infinity));
const profiles = Object.fromEntries(services.map((s) => [s, profile(s, prep.geos[s], prep.lanes[s], learned, "smear", false)]));
const all = cases(services, rows);
const G = 5;
const togo = (P, s, goal) => P.cum[Math.min(Math.max(Math.floor(goal / G), 0), P.n - 1)] - P.cum[Math.min(Math.max(Math.floor(s / G), 0), P.n - 1)];
const quantile = (v, q) => { const s = [...v].sort((a, b) => a - b); return s.length ? s[Math.min(Math.floor(q * s.length), s.length - 1)] : NaN; };

function samples(set) {
  const out = [];
  for (const c of set) {
    const P = profiles[c.service], code = prep.lanes[c.service].codes[c.index];
    let fresh = c.points[0];
    for (const point of c.points) {
      if (point.fresh) fresh = point;
      const eta = point.etas[c.index];
      if (!eta || point.at > c.arrival) continue;
      out.push({ service: c.service, code, at: point.at, truth: (c.arrival - point.at) / 1000, eta: (eta - point.at) / 1000, path: togo(P, fresh.s, c.goal), stale: (point.at - fresh.at) / 1000, left: c.goal - fresh.s });
    }
  }
  return out;
}

const trainSet = samples(all.filter((c) => !holdout.has(c.service)));
const testSet = samples(all.filter((c) => holdout.has(c.service)));
const lead = quantile(trainSet.map((x) => x.truth - x.eta), 0.5);
const fitK = () => { let best, bestE = Infinity; for (let k = 0.5; k <= 2; k += 0.05) { const e = trainSet.reduce((a, x) => a + Math.abs(Math.max(k * x.path - x.stale, 0) - x.truth), 0); if (e < bestE) { bestE = e; best = k; } } return best; };
const k = fitK();
const predictors = {
  "LTA ETA": (x) => Math.max(x.eta, 0),
  [`ETA + ${lead.toFixed(0)} s`]: (x) => Math.max(x.eta + lead, 0),
  [`path x${k.toFixed(2)}`]: (x) => Math.max(k * x.path - x.stale, 0),
  "max(ETA+lead, path)": (x) => Math.max(x.eta + lead, k * x.path - x.stale, 0),
};
for (const reach of [300, 600, 1000, 2000]) predictors[`path within ${reach} m, else ETA+lead`] = (x) => (x.left < reach ? Math.max(k * x.path - x.stale, 0) : Math.max(x.eta + lead, 0));
for (const w of [0.25, 0.5, 0.75]) predictors[`blend ${w} path`] = (x) => Math.max(w * (k * x.path - x.stale) + (1 - w) * (x.eta + lead), 0);

function order(set, f) {
  const groups = new Map();
  for (const x of set) { const key = `${x.code}|${x.at}`; groups.set(key, [...(groups.get(key) ?? []), x]); }
  let agree = 0, total = 0, close = 0, closeTotal = 0;
  for (const g of groups.values()) for (let i = 0; i < g.length; i++) for (let j = i + 1; j < g.length; j++) {
    if (Math.abs(g[i].truth - g[j].truth) < 10) continue;
    const ok = (f(g[i]) - f(g[j])) * (g[i].truth - g[j].truth) > 0;
    agree += ok; total++;
    if (Math.max(g[i].truth, g[j].truth) < 240) { close += ok; closeTotal++; }
  }
  return [agree / total, close / closeTotal, closeTotal];
}

console.log(`order over all ${trainSet.length + testSet.length} polls; errors on test ${testSet.length} polls on ${[...holdout].join(",")}; lead ${lead.toFixed(1)} s, path factor ${k.toFixed(2)}`);
console.log("predictor".padEnd(36), "med|err|", "p90", "  <2min med", " <2min p90", " order", " order<4min");
for (const [label, f] of Object.entries(predictors)) {
  const err = testSet.map((x) => Math.abs(f(x) - x.truth));
  const near = testSet.filter((x) => x.truth < 120).map((x) => Math.abs(f(x) - x.truth));
  const [o, oc, n] = order([...trainSet, ...testSet], f);
  console.log(label.padEnd(36), quantile(err, 0.5).toFixed(0).padStart(7), quantile(err, 0.9).toFixed(0).padStart(5), quantile(near, 0.5).toFixed(0).padStart(11), quantile(near, 0.9).toFixed(0).padStart(10), (100 * o).toFixed(1).padStart(6), `${(100 * oc).toFixed(1)} (${n})`.padStart(12));
}
