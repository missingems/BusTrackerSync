const fs = require("node:fs");
const path = require("node:path");

const CAP = Number(process.env.CAP ?? 30) * 60_000;

const files = process.argv.slice(2);
if (!files.length) {
  const dir = path.join(__dirname, "data");
  files.push(...fs.readdirSync(dir).filter((name) => name.endsWith(".jsonl")).map((name) => path.join(dir, name)));
}

const sequences = {};
for (const file of files) {
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    if (!line) continue;
    const row = JSON.parse(line);
    for (const service of row.services) {
      const eta = Date.parse(service.NextBus?.EstimatedArrival ?? "");
      if (Number.isFinite(eta)) (sequences[`${file}|${row.stop}|${service.ServiceNo}`] ??= []).push([row.at, eta]);
    }
  }
}

let crossings = 0, bounces = 0, early = 0;
const gaps = [], departures = {};
for (const [key, items] of Object.entries(sequences)) {
  items.sort((a, b) => a[0] - b[0]);
  let crossed = null;
  for (let i = 0; i + 1 < items.length; i++) {
    const [at, eta] = items[i], [nextAt, nextEta] = items[i + 1];
    if (nextAt - at > 60_000) { crossed = null; continue; }
    if (crossed === null && eta <= at) { crossed = at; crossings += 1; }
    if (crossed !== null && Math.abs(nextEta - eta) < 90_000 && nextEta > nextAt + 60_000) { bounces += 1; crossed = null; continue; }
    if (nextEta - eta > 90_000) {
      if (crossed !== null) gaps.push(nextAt - crossed);
      else if (eta - at > 60_000) early += 1;
      (departures[key] ??= []).push(nextAt);
      crossed = null;
    }
  }
}

let starts = 0, capped = 0;
for (const [key, items] of Object.entries(sequences)) {
  const leaving = departures[key] ?? [];
  const last = items[items.length - 1][0];
  for (let i = 0; i < items.length; i += 18) {
    const [at, eta] = items[i];
    if (eta < at + 60_000 || at + CAP > last) continue;
    starts += 1;
    const gone = leaving.find((time) => time > at);
    if (gone === undefined || gone - at > CAP) capped += 1;
  }
}

gaps.sort((a, b) => a - b);
const seconds = (p) => gaps.length ? Math.round(gaps[Math.min(Math.floor(gaps.length * p), gaps.length - 1)] / 1000) : null;
console.table([{
  "countdown hit 0": crossings,
  "bounced back >1 min": bounces,
  "bounce %": +(100 * bounces / Math.max(crossings, 1)).toFixed(1),
  "left board after 0": gaps.length,
  "median s after 0": seconds(0.5),
  "90th pct s": seconds(0.9),
  "max s": seconds(1),
  "left board before 0": early,
}]);
console.table([{
  "simulated starts": starts,
  [`cap ${CAP / 60_000}m ends before first bus`]: capped,
  "%": +(100 * capped / Math.max(starts, 1)).toFixed(1),
}]);
