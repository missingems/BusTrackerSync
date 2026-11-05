const fs = require("node:fs");
const path = require("node:path");
const { routes, tracks } = require("./interpolation");

const file = process.argv[2] ?? path.join(__dirname, "data", "fast.jsonl");
const rows = fs.readFileSync(file, "utf8").trim().split("\n").map((line) => JSON.parse(line));
const services = [...new Set(rows.map((row) => row.service))];
const lanes = routes(services);
const rounds = [...new Set(rows.map((row) => row.at))].sort((a, b) => a - b);
const roundIndex = new Map(rounds.map((at, i) => [at, i]));

const quantile = (values, q) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length ? sorted[Math.min(Math.floor(q * sorted.length), sorted.length - 1)] : NaN;
};
const nearStop = (s, marks) => marks.some((mark) => Math.abs(mark - s) <= 40);

const moving = [];
const stationary = [];
const coordinateEvents = [];
const updateEvents = [];
const etaGaps = [];
const trackCounts = {};
const trackMinutes = [];
let etaPairs = 0;
let etaChanges = 0;
let etaChangesWithMove = 0;

for (const service of services) {
  const route = lanes[service];
  const list = tracks(rows.filter((row) => row.service === service), route);
  trackCounts[service] = list.length;
  for (const track of list) {
    const points = track.points;
    trackMinutes.push((points[points.length - 1].at - points[0].at) / 60_000);
    const lastChange = new Map();
    let anchor = points[0];
    for (let i = 1; i < points.length; i++) {
      const a = points[i - 1];
      const b = points[i];
      if (b.fresh) {
        const gap = (b.at - anchor.at) / 1000;
        if (!nearStop(anchor.s, route.marks) && gap <= 60) moving.push(gap);
        else stationary.push(gap);
        coordinateEvents.push(b.at);
        anchor = b;
      }
      let changed = b.fresh;
      for (const stop of Object.keys(b.etas)) {
        if (a.etas[stop] === undefined) continue;
        etaPairs++;
        if (a.etas[stop] === b.etas[stop]) continue;
        changed = true;
        etaChanges++;
        if (b.fresh) etaChangesWithMove++;
        if (lastChange.has(stop)) etaGaps.push((b.at - lastChange.get(stop)) / 1000);
        lastChange.set(stop, b.at);
      }
      if (changed) updateEvents.push(b.at);
    }
  }
}

const polled = (events, k) => {
  const delays = [];
  let missing = 0;
  for (let phase = 0; phase < k; phase++) {
    for (const at of events) {
      const i = roundIndex.get(at);
      const j = i + ((phase - (i % k)) % k + k) % k;
      if (j < rounds.length) delays.push((rounds[j] - at) / 1000);
      else missing++;
    }
  }
  return { delays, missing };
};

const f = (value) => (Number.isFinite(value) ? value.toFixed(1) : "n/a");
const spanMinutes = (rounds[rounds.length - 1] - rounds[0]) / 60_000;
const medianRoundGap = quantile(rounds.slice(1).map((at, i) => (at - rounds[i]) / 1000), 0.5);

console.log(`file ${file}`);
console.log(`rows ${rows.length}, rounds ${rounds.length}, span ${f(spanMinutes)} min, median round gap ${f(medianRoundGap)} s`);
console.log(`services ${services.join(", ")}, tracks ${JSON.stringify(trackCounts)}, median track span ${f(quantile(trackMinutes, 0.5))} min`);
console.log("");
console.log(`Moving-bus gaps between coordinate changes (s): n=${moving.length}, p10=${f(quantile(moving, 0.1))}, p50=${f(quantile(moving, 0.5))}, p90=${f(quantile(moving, 0.9))}`);
console.log(`Stationary gaps between coordinate changes (s): n=${stationary.length}, p10=${f(quantile(stationary, 0.1))}, p50=${f(quantile(stationary, 0.5))}, p90=${f(quantile(stationary, 0.9))}`);
console.log(`ETA changes per observed bus-stop pair: ${etaChanges} of ${etaPairs} (${((100 * etaChanges) / Math.max(etaPairs, 1)).toFixed(1)}%)`);
console.log(`Seconds between ETA changes for one bus-stop: n=${etaGaps.length}, p10=${f(quantile(etaGaps, 0.1))}, p50=${f(quantile(etaGaps, 0.5))}, p90=${f(quantile(etaGaps, 0.9))}`);
console.log(`ETA changes landing on a coordinate-change round: ${((100 * etaChangesWithMove) / Math.max(etaChanges, 1)).toFixed(1)}%`);
console.log("");

const coordinates = coordinateEvents;
const updates = updateEvents;
console.log(`Polling simulation (coordinate events n=${coordinates.length}, coordinate-or-ETA events n=${updates.length}; delay in s from LTA update first seen in the 5 s data to the next poll that sees it, averaged over every phase)`);
console.log("poll interval | coord avg | coord p90 | coord+ETA avg | coord+ETA p90");
const table = {};
for (const seconds of [5, 10, 20]) {
  const k = seconds / 5;
  const coord = polled(coordinates, k);
  const any = polled(updates, k);
  table[seconds] = { coord, any };
  console.log(`${String(seconds).padStart(13)} s | ${f(coord.delays.reduce((a, b) => a + b, 0) / Math.max(coord.delays.length, 1)).padStart(9)} | ${f(quantile(coord.delays, 0.9)).padStart(9)} | ${f(any.delays.reduce((a, b) => a + b, 0) / Math.max(any.delays.length, 1)).padStart(13)} | ${f(quantile(any.delays, 0.9)).padStart(13)}`);
}
console.log("The 5 s row is 0 by construction: the 5 s data is the reference, so LTA's own latency before the first poll is not observable here.");
console.log(`Conclusion: median moving coordinate gap ${f(quantile(moving, 0.5))} s; going from 5 s to 10 s polling adds ${f(table[10].coord.delays.reduce((a, b) => a + b, 0) / Math.max(table[10].coord.delays.length, 1))} s average coordinate delay (p90 ${f(quantile(table[10].coord.delays, 0.9))} s), and 20 s adds ${f(table[20].coord.delays.reduce((a, b) => a + b, 0) / Math.max(table[20].coord.delays.length, 1))} s (p90 ${f(quantile(table[20].coord.delays, 0.9))} s).`);
