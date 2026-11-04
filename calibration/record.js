const fs = require("node:fs");
const path = require("node:path");
const { fetchStop } = require("../functions/src/poller");

const listed = path.join(__dirname, "stops.txt");
const STOPS = (process.env.STOPS ?? (fs.existsSync(listed) ? fs.readFileSync(listed, "utf8").trim() : "01012,01019,09047,83139,52009,75009,28009,46009,10009,63139")).split(",");
const INTERVAL = Number(process.env.INTERVAL ?? 10) * 1000;
const MINUTES = Number(process.env.MINUTES ?? 180);
const key = process.env.LTA_ACCOUNT_KEY;
if (!key) throw new Error("Set LTA_ACCOUNT_KEY");

const out = process.argv[2] ?? path.join(__dirname, "data", `${new Date().toISOString().slice(0, 16).replace(/:/g, "")}.jsonl`);
fs.mkdirSync(path.dirname(out), { recursive: true });
const file = fs.createWriteStream(out, { flags: "a" });

const trim = (bus) => bus?.EstimatedArrival ? { EstimatedArrival: bus.EstimatedArrival, Load: bus.Load, Type: bus.Type } : undefined;

async function round() {
  const at = Date.now();
  await Promise.all(STOPS.map(async (stop) => {
    try {
      const services = (await fetchStop(stop, key)).map((service) => ({
        ServiceNo: service.ServiceNo,
        NextBus: trim(service.NextBus),
        NextBus2: trim(service.NextBus2),
        NextBus3: trim(service.NextBus3),
      }));
      file.write(JSON.stringify({ at, stop, services }) + "\n");
    } catch (error) {
      console.warn(new Date(at).toISOString(), stop, error.message);
    }
  }));
}

(async () => {
  const end = Date.now() + MINUTES * 60_000;
  console.log(`Recording ${STOPS.length} stops every ${INTERVAL / 1000}s for ${MINUTES} min to ${out}`);
  let rounds = 0;
  while (Date.now() < end) {
    const started = Date.now();
    await round();
    if (++rounds % 30 === 0) console.log(new Date().toISOString(), `${rounds} rounds`);
    await new Promise((resolve) => setTimeout(resolve, Math.max(INTERVAL - (Date.now() - started), 0)));
  }
  file.end();
})();
