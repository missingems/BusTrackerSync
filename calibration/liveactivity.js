const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { cases } = require("./interpolation");

const file = process.argv[2];
if (!file) throw new Error("usage: node calibration/liveactivity.js <positions.jsonl>");
const rows = fs.readFileSync(file, "utf8").trim().split("\n").map((line) => JSON.parse(line));
const services = [...new Set(rows.map((row) => row.service))].sort();
const scenarios = cases(services, rows);
const lookup = new Map(rows.map((row) => [`${row.service}|${row.index}|${row.at}`, row]));
const rounds = [...new Set(rows.map((row) => row.at))].sort((a, b) => a - b);
const source = fs.readFileSync(path.join(__dirname, "../functions/src/state.js"), "utf8");

function load(overrides = {}) {
  let text = source;
  for (const [name, value] of Object.entries(overrides)) {
    const pattern = new RegExp(`const ${name} = [^;]+;`);
    if (!pattern.test(text)) throw new Error(`no constant ${name}`);
    text = text.replace(pattern, `const ${name} = ${value};`);
  }
  const module = { exports: {} };
  vm.runInNewContext(text, { module, exports: module.exports });
  return module.exports;
}

const service = (row) => {
  const [first, second, third] = row.buses.map((bus) => ({ EstimatedArrival: bus.eta, Load: bus.load ?? "", Type: bus.type ?? "" }));
  return { ServiceNo: row.service, NextBus: first, NextBus2: second, NextBus3: third };
};

function simulate(scenario, state, { interval, lead, ticking = false }) {
  const { index, arrival: truth, points } = scenario;
  const start = points[0].at;
  const first = points[0].etas[index];
  let registration = { tracked: first, since: start, createdAt: start, arrived: 0, nextPollAt: null };
  const renders = [{ at: start, arrival: first, staleDate: state.staleDate(first, start), hasArrived: false }];
  let pushes = 0, urgent = 0, last = -Infinity;
  for (const at of rounds) {
    if (at <= start || at > truth) continue;
    if (registration.nextPollAt && at < registration.nextPollAt) continue;
    if (at - last < interval * 1000 - 1000) continue;
    const row = lookup.get(`${scenario.service}|${index}|${at}`);
    if (!row) continue;
    last = at;
    const result = state.next(registration, service(row), at);
    const nextPollAt = result.nextPollAt > at ? result.nextPollAt : null;
    if (result.action === "none") {
      registration = { ...registration, tracked: result.tracked ?? registration.tracked, arrived: result.arrived ?? registration.arrived, nextPollAt };
      continue;
    }
    pushes += 1;
    if (result.action === "end" || result.urgent) urgent += 1;
    if (result.action === "end") {
      renders.push({ at, hasArrived: true });
      break;
    }
    registration = { ...registration, tracked: result.tracked, arrived: result.arrived, last: result.last, lastPushAt: at, nextPollAt };
    renders.push({ at, arrival: result.last.arrival, staleDate: result.staleDate, hasArrived: false });
  }

  const lta = points.filter((point) => point.etas[index]).map((point) => [point.at, point.etas[index]]);
  const seconds = { total: 0, offTruth: 0, wrong: 0, wrong2: 0, offApp: 0, stale: 0, early: 0 };
  let r = 0, l = 0;
  for (let t = start; t < truth; t += 1000) {
    while (r + 1 < renders.length && renders[r + 1].at <= t) r++;
    while (l + 1 < lta.length && lta[l + 1][0] <= t) l++;
    const render = renders[r];
    let shown = 0;
    if (!render.hasArrived) {
      const arrival = render.arrival + lead * 1000;
      const stale = t >= render.staleDate;
      if (stale) seconds.stale += 1;
      shown = Math.max(Math.floor((stale || ticking ? arrival - t : arrival - render.at) / 60_000), 0);
    }
    const actual = Math.floor((truth - t) / 60_000);
    const app = Math.max(Math.floor((lta[l][1] - t) / 60_000), 0);
    const diff = Math.abs(shown - actual);
    seconds.total += 1;
    seconds.offTruth += diff;
    if (diff >= 1) seconds.wrong += 1;
    if (diff >= 2) seconds.wrong2 += 1;
    if (shown !== app) seconds.offApp += 1;
    if (shown === 0 && actual >= 1) seconds.early += 1;
  }
  return { seconds, pushes, urgent };
}

function score(overrides, options) {
  const state = load(overrides);
  const total = { total: 0, offTruth: 0, wrong: 0, wrong2: 0, offApp: 0, stale: 0, early: 0 };
  let pushes = 0, urgent = 0;
  for (const scenario of scenarios) {
    const result = simulate(scenario, state, options);
    for (const key of Object.keys(total)) total[key] += result.seconds[key];
    pushes += result.pushes;
    urgent += result.urgent;
  }
  const hours = total.total / 3600;
  const share = (value) => Number((100 * value / total.total).toFixed(1));
  return {
    minutesOff: Number((total.offTruth / total.total).toFixed(3)),
    wrongPct: share(total.wrong),
    wrong2Pct: share(total.wrong2),
    notAppPct: share(total.offApp),
    earlyArrPct: share(total.early),
    stalePct: share(total.stale),
    pushesPerHour: Number((pushes / hours).toFixed(1)),
    urgentPerHour: Number((urgent / hours).toFixed(1)),
  };
}

const base = { interval: 20, lead: 0 };
const variants = [
  ["current", {}, base],
  ["shift 5s", { SHIFT_THRESHOLD: 5_000 }, base],
  ["shift 20s", { SHIFT_THRESHOLD: 20_000 }, base],
  ["shift 30s", { SHIFT_THRESHOLD: 30_000 }, base],
  ["shift 60s", { SHIFT_THRESHOLD: 60_000 }, base],
  ["repush 60s", { REPUSH_EVERY: 60_000 }, base],
  ["repush 5m", { REPUSH_EVERY: 300_000 }, base],
  ["repush off", { REPUSH_EVERY: 1e12 }, base],
  ["poll 40s", {}, { ...base, interval: 40 }],
  ["poll 60s", {}, { ...base, interval: 60 }],
  ["far poll 20s", { FAR_POLL: 20_000 }, base],
  ["far poll 100s", { FAR_POLL: 100_000 }, base],
  ["far 5m", { FAR: 5 * 60_000 }, base],
  ["stale 2m", { STALE_AFTER: 120_000 }, base],
  ["stale 5m", { STALE_AFTER: 300_000 }, base],
  ["countdown 0", { COUNTDOWN_LEAD: 0 }, base],
  ["countdown 2m", { COUNTDOWN_LEAD: 120_000 }, base],
  ["lead 30s", {}, { ...base, lead: 30 }],
  ["lead 60s", {}, { ...base, lead: 60 }],
  ["ticking", { ticked: "false", urgent: "!last || registration.lastPushAt == null || reached" }, { ...base, ticking: true }],
  ["ticking 30s", { ticked: "false", urgent: "!last || registration.lastPushAt == null || reached", SHIFT_THRESHOLD: 30_000 }, { ...base, ticking: true }],
  ["ticking 30s 60", { ticked: "false", urgent: "!last || registration.lastPushAt == null || reached", SHIFT_THRESHOLD: 30_000 }, { ...base, ticking: true, lead: 60 }],
];

console.log(`cases ${scenarios.length}`);
for (const [label, overrides, options] of variants) {
  console.log(label.padEnd(14), JSON.stringify(score(overrides, options)));
}
