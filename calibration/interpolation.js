const fs = require("node:fs");
const path = require("node:path");

const data = path.join(__dirname, "data");
const read = (name) => JSON.parse(fs.readFileSync(path.join(data, name), "utf8"));

const APP = {
  maximumBusSpeed: 70 / 3.6,
  minimumCruise: 6,
  crawlReach: 18,
  driftTolerance: 40,
  pacedDriftTolerance: 20,
  catchUpDuration: 10,
  pacedCatchUpDuration: 45,
  acceleration: 0.6,
  deceleration: 1.3,
  catchUpAcceleration: 4,
  dwellDuration: 15,
  minimumDwell: 3,
  dwellShare: 0.25,
  stopOverhead: 16,
  stopSetback: 5,
  lead: 60,
};

const STEP = 0.1;
const REACHED = 15;
const PLACE_REACH = 120;
const LAT0 = 1.35 * Math.PI / 180;
const project = ([lat, lng]) => [lng * Math.cos(LAT0) * 111_320, lat * 110_540];

function decode(encoded) {
  const points = [];
  let index = 0, lat = 0, lng = 0;
  while (index < encoded.length) {
    for (const axis of [0, 1]) {
      let result = 0, shift = 0, byte;
      do {
        byte = encoded.charCodeAt(index++) - 63;
        result |= (byte & 0x1f) << shift;
        shift += 5;
      } while (byte >= 0x20);
      const delta = result & 1 ? ~(result >> 1) : result >> 1;
      if (axis === 0) lat += delta; else lng += delta;
    }
    points.push([lat / 1e5, lng / 1e5]);
  }
  return points;
}

function line(coordinates) {
  const points = coordinates.map(project);
  const along = [0];
  for (let i = 1; i < points.length; i++) along.push(along[i - 1] + Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1]));
  const place = (coordinate, near) => {
    const [x, y] = project(coordinate);
    let best;
    for (let i = 0; i < points.length - 1; i++) {
      const [ax, ay] = points[i], [bx, by] = points[i + 1];
      const length = along[i + 1] - along[i];
      if (length <= 0) continue;
      const t = Math.min(Math.max(((x - ax) * (bx - ax) + (y - ay) * (by - ay)) / length, 0), length);
      const gap = Math.hypot(ax + (bx - ax) * t / length - x, ay + (by - ay) * t / length - y);
      const distance = along[i] + t;
      const score = gap + (near === undefined ? 0 : Math.max(near - distance - 30, 0) * 0.5 + Math.max(distance - near - 1500, 0) * 0.05);
      if (gap < PLACE_REACH && score < (best?.score ?? Infinity)) best = { score, distance };
    }
    return best?.distance;
  };
  return { place, length: along[along.length - 1] };
}

function routes(services) {
  const polylines = read("busRoutes.json");
  const serviceStops = read("serviceStops.json");
  const stops = read("busStops.json");
  return Object.fromEntries(services.map((service) => {
    const lane = line(decode(polylines[service][0]));
    const codes = serviceStops[service][0];
    let last = 0;
    const stopDistances = codes.map((code) => {
      const distance = stops[code] ? lane.place(stops[code], last) : undefined;
      if (distance !== undefined) last = distance;
      return distance;
    });
    return [service, { ...lane, codes, stopDistances, marks: stopDistances.filter((d) => d !== undefined).sort((a, b) => a - b) }];
  }));
}

function tracks(rows, route) {
  const rounds = new Map();
  for (const row of rows) {
    const round = rounds.get(row.at) ?? new Map();
    rounds.set(row.at, round);
    for (const bus of row.buses) {
      if (!bus.lat || !bus.lng || bus.monitored !== 1) continue;
      const key = `${bus.lat},${bus.lng}`;
      const seen = round.get(key) ?? { coordinate: [bus.lat, bus.lng], etas: {} };
      seen.etas[row.index] = Date.parse(bus.eta);
      round.set(key, seen);
    }
  }
  const finished = [];
  let active = [];
  for (const at of [...rounds.keys()].sort((a, b) => a - b)) {
    const seen = [...rounds.get(at).values()];
    const candidates = [];
    seen.forEach((bus, b) => {
      const near = active.map((track) => track.points[track.points.length - 1].s);
      bus.s = route.place(bus.coordinate);
      if (bus.s === undefined) return;
      active.forEach((track, t) => {
        const last = track.points[track.points.length - 1];
        const placed = route.place(bus.coordinate, last.s) ?? bus.s;
        const progress = placed - last.s;
        const seconds = (at - last.at) / 1000;
        if (progress < -40 || progress > 25 * seconds + 60) return;
        const sharedEta = Object.entries(bus.etas).filter(([stop]) => last.etas[stop]);
        const lateness = sharedEta.length ? Math.min(...sharedEta.map(([stop, eta]) => Math.abs(eta - last.etas[stop]) / 1000)) : 60;
        candidates.push({ b, t, placed, cost: Math.abs(progress - 6 * seconds) * 0.2 + lateness });
      });
      void near;
    });
    const usedBus = new Set(), usedTrack = new Set();
    for (const c of candidates.sort((x, y) => x.cost - y.cost)) {
      if (usedBus.has(c.b) || usedTrack.has(c.t)) continue;
      usedBus.add(c.b);
      usedTrack.add(c.t);
      const bus = seen[c.b];
      const last = active[c.t].points[active[c.t].points.length - 1];
      const s = Math.max(c.placed, last.s);
      active[c.t].points.push({ at, s, etas: bus.etas, fresh: s - last.s > 3 });
    }
    seen.forEach((bus, b) => {
      if (!usedBus.has(b) && bus.s !== undefined) active.push({ points: [{ at, s: bus.s, etas: bus.etas, fresh: true }] });
    });
    const stale = active.filter((track) => at - track.points[track.points.length - 1].at > 120_000);
    finished.push(...stale);
    active = active.filter((track) => !stale.includes(track));
  }
  return [...finished, ...active].filter((track) => track.points.length >= 6);
}

function crossing(all, goal) {
  const points = all.filter((point) => point.fresh);
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1], b = points[i];
    if (a.s < goal && b.s >= goal) return a.at + (b.at - a.at) * (goal - a.s) / Math.max(b.s - a.s, 1e-6);
  }
}

function advance(bus, dt, now, goal, marks, p) {
  const distance = bus.distance;
  const paced = goal > distance && bus.eta !== undefined;
  const behind = bus.reported !== undefined && bus.reported - distance > (paced ? p.pacedDriftTolerance : p.driftTolerance);
  if (bus.dwellUntil > now && !behind) return;
  bus.dwellUntil = 0;
  const shifted = marks.map((m) => m - p.stopSetback);
  const stops = shifted.filter((m) => m > distance + 1 && m < goal - 1);
  let cruise = 0, dwell = 0;
  if (paced) {
    const next = stops[0] ?? goal;
    const previous = shifted.filter((m) => m <= distance + 1).pop() ?? 0;
    const leg = Math.max(next - previous, next - distance, 1);
    const legs = (next - distance) / leg + stops.length;
    const timeLeft = (bus.eta - now) / 1000 + p.lead;
    dwell = stops.length === 0 ? 0 : Math.min(p.dwellDuration, Math.max(p.minimumDwell, Math.max(timeLeft / legs - p.stopOverhead, 0) * p.dwellShare));
    cruise = Math.min(legs * leg / Math.max(timeLeft - stops.length * (dwell + p.stopOverhead), 1), p.maximumBusSpeed);
    if ((stops[0] ?? goal) - distance > p.crawlReach) cruise = Math.max(cruise, p.minimumCruise);
  }
  const gap = bus.reported === undefined ? 0 : bus.reported - distance;
  const correction = gap / (paced ? p.pacedCatchUpDuration : p.catchUpDuration);
  const halt = !behind && dwell >= p.minimumDwell ? stops[0] : undefined;
  const brake = Math.min(halt ?? Infinity, goal);
  let target = Math.min(Math.max(cruise + correction, 0), p.maximumBusSpeed);
  if (brake < Infinity) target = Math.min(target, Math.sqrt(2 * p.deceleration * Math.max(brake - distance, 0)));
  const acceleration = behind ? p.catchUpAcceleration : p.acceleration;
  bus.speed = target > bus.speed ? Math.min(bus.speed + acceleration * dt, target) : Math.max(bus.speed - p.deceleration * 2 * dt, target);
  bus.distance = Math.min(distance + bus.speed * dt, Math.max(brake, distance));
  if (halt !== undefined && halt - bus.distance < 0.5) {
    bus.distance = halt;
    bus.speed = 0;
    bus.dwellUntil = now + dwell * 1000;
  }
}

function cases(services, rows) {
  const lanes = routes(services);
  const all = [];
  for (const service of services) {
    const route = lanes[service];
    for (const track of tracks(rows.filter((row) => row.service === service), route)) {
      route.stopDistances.forEach((stopDistance, index) => {
        if (stopDistance === undefined) return;
        const goal = stopDistance - APP.stopSetback;
        const arrival = crossing(track.points, goal);
        if (arrival === undefined) return;
        const start = track.points.findIndex((point) => point.etas[index] && point.s < goal - 150 && goal - point.s < 6000);
        if (start < 0 || track.points[start].at > arrival - 60_000) return;
        all.push({ service, index, goal, arrival, marks: route.marks, points: track.points.slice(start).filter((point) => point.at <= arrival + 60_000) });
      });
    }
  }
  return all;
}

function replay(scenario, p) {
  const { points, goal, marks, index, arrival } = scenario;
  const bus = { distance: points[0].s, reported: points[0].s, eta: points[0].etas[index], speed: 0, dwellUntil: 0 };
  const errors = [];
  let reached, now = points[0].at, stalled = 0, moving = 0;
  for (let i = 1; i < points.length; i++) {
    const point = points[i];
    const pace = (point.s - points[i - 1].s) / ((point.at - points[i - 1].at) / 1000);
    while (now < point.at) {
      advance(bus, STEP, now, goal, marks, p);
      now += STEP * 1000;
      if (pace > 3) {
        moving += STEP;
        if (bus.speed < 0.3) stalled += STEP;
      }
      if (reached === undefined && bus.distance >= goal - REACHED) reached = now;
    }
    if (point.fresh && point.at <= arrival) errors.push(bus.distance - point.s);
    bus.reported = point.s;
    if (point.etas[index]) bus.eta = point.etas[index];
  }
  return { errors, arrivalError: reached === undefined ? undefined : (reached - arrival) / 1000, stalled, moving };
}

const quantile = (values, q) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length ? sorted[Math.min(Math.floor(q * sorted.length), sorted.length - 1)] : NaN;
};

function score(scenarios, p) {
  const errors = [], arrivals = [];
  let stalled = 0, moving = 0, missed = 0;
  for (const scenario of scenarios) {
    const result = replay(scenario, p);
    errors.push(...result.errors);
    if (result.arrivalError === undefined) missed++; else arrivals.push(result.arrivalError);
    stalled += result.stalled;
    moving += result.moving;
  }
  const absolute = errors.map(Math.abs);
  return {
    cases: scenarios.length,
    polls: errors.length,
    meanError: absolute.reduce((a, b) => a + b, 0) / absolute.length,
    medianError: quantile(absolute, 0.5),
    p90Error: quantile(absolute, 0.9),
    ahead: quantile(errors, 0.9),
    behind: quantile(errors, 0.1),
    arrivalMedian: quantile(arrivals, 0.5),
    arrivalP90: quantile(arrivals.map(Math.abs), 0.9),
    missed,
    stalled: stalled / Math.max(moving, 1),
  };
}

module.exports = { APP, cases, score, replay, tracks, routes };

if (require.main === module) {
  const file = process.argv[2] ?? path.join(data, "positions.jsonl");
  const rows = fs.readFileSync(file, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  const services = [...new Set(rows.map((row) => row.service))];
  const scenarios = cases(services, rows);
  const format = (result) => Object.fromEntries(Object.entries(result).map(([key, value]) => [key, typeof value === "number" && !Number.isInteger(value) ? Number(value.toFixed(2)) : value]));
  console.log("app constants", format(score(scenarios, APP)));
}
