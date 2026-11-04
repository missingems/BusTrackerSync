const fs = require("node:fs");
const path = require("node:path");
const { next } = require("../functions/src/state");

const ROUND = 20_000;
const START_EVERY = Number(process.env.START_EVERY ?? 3) * 60_000;
const SAMPLE = 10_000;

const flat = (tiers) => (ahead) => (tiers.find(([limit]) => ahead > limit * 60_000)?.[1] ?? 0) * 1000;
const STRATEGIES = [
  { name: "every 20s (before)", interval: () => 0 },
  ...[5, 8, 10, 15, 20].flatMap((far) => [40, 60, 120].map((every) => ({
    name: `>${far}m every ${every}s`,
    interval: flat([[far, every]]),
  }))),
  { name: ">15m 120s, >5m 60s", interval: flat([[15, 120], [5, 60]]) },
  { name: ">20m 180s, >10m 60s", interval: flat([[20, 180], [10, 60]]) },
  { name: ">10m 60s (deployed)", interval: flat([[10, 50]]) },
];

function load(files) {
  const byStop = {};
  for (const file of files) {
    for (const line of fs.readFileSync(file, "utf8").split("\n")) {
      if (!line) continue;
      const row = JSON.parse(line);
      (byStop[row.stop] ??= []).push(row);
    }
  }
  for (const rows of Object.values(byStop)) rows.sort((a, b) => a.at - b.at);
  return byStop;
}

function snapshotAt(rows, t) {
  let low = 0, high = rows.length - 1, found = null;
  while (low <= high) {
    const middle = (low + high) >> 1;
    if (rows[middle].at <= t) { found = rows[middle]; low = middle + 1; } else high = middle - 1;
  }
  return found;
}

const times = (service) => [service?.NextBus, service?.NextBus2, service?.NextBus3]
  .map((bus) => Date.parse(bus?.EstimatedArrival ?? "")).filter(Number.isFinite);
const minutes = (ms) => Math.max(Math.floor(ms / 60_000), 0);

function scenarios(byStop) {
  const list = [];
  for (const [stop, rows] of Object.entries(byStop)) {
    const first = rows[0].at, last = rows[rows.length - 1].at;
    for (let start = first; start < last - Number(process.env.TAIL ?? 30) * 60_000; start += START_EVERY) {
      const snapshot = snapshotAt(rows, start);
      for (const service of snapshot?.services ?? []) {
        const upcoming = times(service).filter((time) => time > start + 60_000);
        if (upcoming.length) list.push({ stop, rows, service: service.ServiceNo, start, tracked: upcoming[0], end: last });
      }
    }
  }
  return list;
}

function run(scenario, strategy) {
  const { rows, service, start, end } = scenario;
  const registration = { service, stopCode: scenario.stop, tracked: scenario.tracked, since: start, createdAt: start };
  const tally = { polls: 0, pushes: 0, urgent: 0, samples: 0, off: 0, offTwo: 0, error: 0, duration: 0, near: 0 };
  let shown = null;
  let nextPoll = start;
  let t = start;
  const pushes = [];

  for (; t <= end; t += ROUND) {
    if (t < nextPoll) continue;
    tally.polls += 1;
    const snapshot = snapshotAt(rows, t);
    const result = next(registration, snapshot?.services.find((candidate) => candidate.ServiceNo === service), t);
    if (result.action === "end") {
      pushes.push({ at: t, arrival: null });
      tally.pushes += 1;
      break;
    }
    if (result.tracked) {
      registration.tracked = result.tracked;
      registration.arrived = result.arrived;
    }
    if (result.action === "update") {
      tally.pushes += 1;
      if (result.urgent) tally.urgent += 1;
      registration.last = result.last;
      registration.lastPushAt = t;
      pushes.push({ at: t, arrival: result.last.arrival, stale: result.staleDate });
    }
    const ahead = (result.tracked ?? registration.tracked) - t;
    const wait = strategy.interval(ahead);
    if (wait <= ROUND) tally.near += 1;
    nextPoll = t + wait;
  }
  const stop = Math.min(t, end);
  tally.duration = stop - start;

  let index = -1;
  for (let at = start; at < stop; at += SAMPLE) {
    while (index + 1 < pushes.length && pushes[index + 1].at <= at) index += 1;
    const push = pushes[index];
    if (!push?.arrival) continue;
    const truth = times(snapshotAt(rows, at)?.services.find((candidate) => candidate.ServiceNo === service))
      .reduce((best, time) => (best == null || Math.abs(time - push.arrival) < Math.abs(best - push.arrival) ? time : best), null);
    if (truth == null || Math.abs(truth - push.arrival) > 5 * 60_000) continue;
    const display = at >= push.stale && push.arrival > at ? minutes(push.arrival - at) : minutes(push.arrival - push.at);
    const error = Math.abs(display - minutes(truth - at));
    tally.samples += 1;
    tally.error += error;
    if (error >= 1) tally.off += 1;
    if (error >= 2) tally.offTwo += 1;
  }
  return tally;
}

const files = process.argv.slice(2);
if (!files.length) {
  const dir = path.join(__dirname, "data");
  files.push(...fs.readdirSync(dir).filter((name) => name.endsWith(".jsonl")).map((name) => path.join(dir, name)));
}
const byStop = load(files);
const list = scenarios(byStop);
console.log(`${list.length} simulated Live Activities across ${Object.keys(byStop).length} stops`);

const results = STRATEGIES.map((strategy) => {
  const total = { polls: 0, pushes: 0, urgent: 0, samples: 0, off: 0, offTwo: 0, error: 0, duration: 0, near: 0 };
  for (const scenario of list) {
    const tally = run(scenario, strategy);
    for (const key of Object.keys(total)) total[key] += tally[key];
  }
  const hours = total.duration / 3_600_000;
  return {
    strategy: strategy.name,
    "LTA/hr": +(total.polls / hours).toFixed(0),
    "push/hr": +(total.pushes / hours).toFixed(0),
    "urgent/hr": +(total.urgent / hours).toFixed(0),
    "busy %": +(100 * total.near / total.polls).toFixed(0),
    "off by 1+ %": +(100 * total.off / total.samples).toFixed(1),
    "off by 2+ %": +(100 * total.offTwo / total.samples).toFixed(2),
    "avg error min": +(total.error / total.samples).toFixed(3),
    "avg length min": +(total.duration / list.length / 60_000).toFixed(1),
  };
});
const base = results[0];
for (const row of results) row["LTA saved %"] = +(100 * (1 - row["LTA/hr"] / base["LTA/hr"])).toFixed(0);
console.table(results);
