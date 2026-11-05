const COUNT = Number(process.argv[2] ?? 50);
const key = process.env.LTA_ACCOUNT_KEY;
if (!key) throw new Error("Set LTA_ACCOUNT_KEY");

async function page(skip) {
  const response = await fetch(`https://datamall2.mytransport.sg/ltaodataservice/BusStops?$skip=${skip}`, {
    headers: { AccountKey: key, accept: "application/json" },
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw new Error(`LTA ${response.status}`);
  return (await response.json()).value ?? [];
}

(async () => {
  const stops = [];
  for (let skip = 0; ; skip += 500) {
    const batch = await page(skip);
    stops.push(...batch.filter((stop) => stop.Latitude && stop.Longitude && stop.Latitude < 1.455));
    if (batch.length < 500) break;
  }
  const point = (stop) => [stop.Latitude * 111, stop.Longitude * 111 * Math.cos(1.35 * Math.PI / 180)];
  const points = stops.map(point);
  const distance = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
  let seed = 7;
  const random = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const order = points.map((_, i) => i).map((i) => [random(), i]).sort((a, b) => a[0] - b[0]).map(([, i]) => i);
  const spread = (radius) => {
    const picked = [];
    for (const i of order) {
      if (picked.every((j) => distance(points[i], points[j]) >= radius)) picked.push(i);
      if (picked.length > COUNT) break;
    }
    return picked;
  };
  const chosen = spread(Number(process.env.SPACING ?? 1.5)).slice(0, COUNT);
  console.error(`${stops.length} stops, picked ${chosen.length}`);
  for (const i of chosen) console.error(`${stops[i].BusStopCode} ${stops[i].Description} (${stops[i].RoadName})`);
  console.log(chosen.map((i) => stops[i].BusStopCode).join(","));
})();
