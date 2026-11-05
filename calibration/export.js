const path = require("node:path");
const { cases } = require("./interpolation");
const { load, prepare, learn, legsOf, profile, scoreModel, cost, DEFAULTS, tune, leadOf } = require("./speedmodel");

const file = process.argv[2];
if (!file) throw new Error("usage: node calibration/export.js <island.jsonl>");
const rows = load(path.resolve(file));
const services = [...new Set(rows.map((r) => r.service))].sort();
const prep = prepare(rows, services);
const learned = learn(prep, legsOf(prep.trackSets, prep.geos, prep.lanes, -Infinity, Infinity));
const all = cases(services, rows);
const profiles = Object.fromEntries(services.map((s) => [s, profile(s, prep.geos[s], prep.lanes[s], learned, "smear", false)]));
const keys = ["kappa", "tau", "catchUp", "cap", "floor", "accel", "follow", "brake"];
const start = { ...DEFAULTS, lead: leadOf(all), gamma: 1, pmin: 0.2 };
const tuned = tune(all.filter((_, i) => i % 2 === 0), () => profiles, "c", start, ["lead", "pmin", ...keys, "lead", "pmin"]);
const beta = [...learned.betaSmear].map((v) => Number(v.toFixed(4)));
console.log(JSON.stringify({
  grid: 5,
  spacingEdges: [200, 350, 600], baseSlowness: beta.slice(0, 4),
  approachEdges: [15, 40, 80, 140, 220], approachSlowness: beta.slice(4, 9),
  leaveEdges: [15, 40, 80, 140], leaveSlowness: beta.slice(9, 13),
  turnEdges: [15, 40, 75], turnSlowness: beta.slice(13, 16),
  params: tuned,
}, null, 2));
const r = scoreModel(all.filter((_, i) => i % 2 === 1), profiles, tuned, "c");
console.log(JSON.stringify({ medianError: r.medianError, p90Error: r.p90Error, arrivalMedian: r.arrivalMedian, arrivalP90: r.arrivalP90, leftEarly: r.leftEarly, cost: cost(r) }));
const { APP, score } = require("./interpolation");
const odd = all.filter((_, i) => i % 2 === 1);
const show = (label, r) => console.log(label.padEnd(10), ["medianError", "p90Error", "arrivalMedian", "arrivalP90", "missed", "leftEarly"].map((k) => `${k} ${Number(r[k]).toFixed(k === "leftEarly" ? 3 : 1)}`).join("  "));
show("app", score(odd, APP));
for (const lead of [56.5, 65, 75]) show(`lead ${lead}`, scoreModel(odd, profiles, { ...tuned, lead }, "c"));
