const fs = require("node:fs");
const { APP, cases, score } = require("./interpolation");

const file = process.argv[2];
if (!file) throw new Error("usage: node calibration/sweep.js <positions.jsonl>");
const rows = fs.readFileSync(file, "utf8").trim().split("\n").map((line) => JSON.parse(line));
const services = [...new Set(rows.map((row) => row.service))].sort();
const holdout = new Set(services.filter((_, index) => index % 3 === 2));
const all = cases(services, rows);
const train = all.filter((scenario) => !holdout.has(scenario.service));
const test = all.filter((scenario) => holdout.has(scenario.service));

const cost = (result) => result.meanError + 0.3 * result.p90Error + 3 * result.arrivalP90 + 1000 * result.missed / result.cases + 300 * result.stalled;
const steps = {
  maximumBusSpeed: [50, 60, 70].map((kmh) => kmh / 3.6),
  minimumCruise: [3, 4, 6, 8],
  crawlReach: [10, 18, 30],
  driftTolerance: [20, 40, 80, 120],
  pacedDriftTolerance: [20, 30, 45, 60, 100],
  catchUpDuration: [5, 10, 15, 25],
  pacedCatchUpDuration: [20, 30, 45, 60],
  acceleration: [0.6, 0.8, 1, 1.3],
  deceleration: [0.9, 1.3, 1.8, 2.2],
  catchUpAcceleration: [1.5, 2, 3, 4],
  dwellDuration: [5, 10, 15, 20, 25, 30],
  minimumDwell: [1, 2, 3, 5],
  dwellShare: [0, 0.15, 0.25, 0.4, 0.55, 0.7],
  stopOverhead: [4, 8, 12, 16, 20, 25, 30],
  lead: [0, 30, 45, 60, 75, 90, 120],
};

const round = (value) => Number(value.toFixed(3));
const report = (label, p) => {
  const fit = score(train, p), check = score(test, p);
  console.log(label, JSON.stringify({ train: round(cost(fit)), holdout: round(cost(check)), medianError: round(check.medianError), p90Error: round(check.p90Error), arrivalMedian: round(check.arrivalMedian), arrivalP90: round(check.arrivalP90), missed: check.missed, stalled: round(check.stalled) }));
};

console.log(`cases ${all.length} (train ${train.length}, holdout ${test.length} on ${[...holdout].join(",")})`);
report("app", APP);
if (process.argv[3]) report("start", { ...APP, ...JSON.parse(process.argv[3]) });
let best = { ...APP, ...(process.argv[3] ? JSON.parse(process.argv[3]) : {}) }, bestCost = cost(score(train, best));
for (let pass = 0; pass < 2; pass++) {
  for (const [key, values] of Object.entries(steps)) {
    for (const value of values) {
      if (value === best[key]) continue;
      const candidate = { ...best, [key]: value };
      const candidateCost = cost(score(train, candidate));
      if (candidateCost < bestCost - 0.01) {
        best = candidate;
        bestCost = candidateCost;
      }
    }
  }
  report(`pass ${pass + 1}`, best);
}
console.log("best", JSON.stringify(Object.fromEntries(Object.entries(best).map(([key, value]) => [key, round(value)]))));
