const fs = require("node:fs");
const path = require("node:path");
const { fetchStop, inPool } = require("../functions/src/poller");

const SERVICES = (process.env.SERVICES ?? "106,14,190").split(",");
const DIRECTION = Number(process.env.DIRECTION ?? 0);
const INTERVAL = Number(process.env.INTERVAL ?? 20) * 1000;
const MINUTES = Number(process.env.MINUTES ?? 180);
const CONCURRENCY = Number(process.env.CONCURRENCY ?? 24);
const key = process.env.LTA_ACCOUNT_KEY;
if (!key) throw new Error("Set LTA_ACCOUNT_KEY");

const data = path.join(__dirname, "data");
const serviceStops = JSON.parse(fs.readFileSync(path.join(data, "serviceStops.json"), "utf8"));
const out = process.argv[2] ?? path.join(data, `positions-${new Date().toISOString().slice(0, 16).replace(/:/g, "")}.jsonl`);
const file = fs.createWriteStream(out, { flags: "a" });

const legs = SERVICES.flatMap((service) => (serviceStops[service]?.[DIRECTION] ?? []).map((stop, index) => ({ service, stop, index })));
const byStop = legs.reduce((stops, leg) => ({ ...stops, [leg.stop]: [...(stops[leg.stop] ?? []), leg] }), {});

const bus = (entry) => entry?.EstimatedArrival ? {
  eta: entry.EstimatedArrival,
  lat: Number(entry.Latitude) || null,
  lng: Number(entry.Longitude) || null,
  visit: entry.VisitNumber,
  monitored: entry.Monitored,
  load: entry.Load,
} : undefined;

async function saveStops() {
  const target = path.join(data, "busStops.json");
  if (fs.existsSync(target)) return;
  const stops = {};
  for (let skip = 0; ; skip += 500) {
    const response = await fetch(`https://datamall2.mytransport.sg/ltaodataservice/BusStops?$skip=${skip}`, { headers: { AccountKey: key, accept: "application/json" } });
    const page = (await response.json()).value ?? [];
    for (const stop of page) stops[stop.BusStopCode] = [stop.Latitude, stop.Longitude];
    if (page.length < 500) break;
  }
  fs.writeFileSync(target, JSON.stringify(stops));
}

async function round() {
  const at = Date.now();
  await inPool(Object.entries(byStop), CONCURRENCY, async ([stop, wanted]) => {
    try {
      const services = await fetchStop(stop, key);
      for (const { service, index } of wanted) {
        const found = services.find((entry) => entry.ServiceNo === service);
        const buses = found ? [found.NextBus, found.NextBus2, found.NextBus3].map(bus).filter(Boolean) : [];
        file.write(JSON.stringify({ at, service, stop, index, buses }) + "\n");
      }
    } catch (error) {
      console.warn(new Date(at).toISOString(), stop, error.message);
    }
  });
}

(async () => {
  await saveStops();
  const end = Date.now() + MINUTES * 60_000;
  console.log(`Recording ${SERVICES.join(", ")} (${Object.keys(byStop).length} stops) every ${INTERVAL / 1000}s for ${MINUTES} min to ${out}`);
  let rounds = 0;
  while (Date.now() < end) {
    const started = Date.now();
    await round();
    if (++rounds % 30 === 0) console.log(new Date().toISOString(), `${rounds} rounds`);
    await new Promise((resolve) => setTimeout(resolve, Math.max(INTERVAL - (Date.now() - started), 0)));
  }
  file.end();
})();
