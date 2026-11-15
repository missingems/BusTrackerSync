const crypto = require("node:crypto");
const { fetchStop, inPool } = require("./poller");

const STOP = /^\d{5}$/;
const SERVICE = /^[0-9A-Za-z]{1,5}$/;
const MAX_LIVE_STOPS = 6;
const LIVE_CACHE_MS = 20_000;
const ROUTES_CACHE_MS = 10 * 60_000;
const TOP = 25;

function secretMatches(header, secret) {
  if (typeof secret !== "string" || secret.length < 16) return false;
  const match = /^Bearer (\S+)$/.exec(String(header ?? ""));
  if (!match) return false;
  const digest = (value) => crypto.createHash("sha256").update(value).digest();
  return crypto.timingSafeEqual(digest(match[1]), digest(secret));
}

function allowsOrigin(origin, origins, emulated) {
  if (typeof origin !== "string" || origin === "") return false;
  if (origins.includes(origin)) return true;
  return emulated && /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
}

function count(map, key) {
  map[key] = (map[key] ?? 0) + 1;
}

function ranked(map) {
  return Object.entries(map)
    .sort(([a, x], [b, y]) => y - x || a.localeCompare(b))
    .slice(0, TOP)
    .map(([key, value]) => ({ key, count: value }));
}

function subscriberSummary(registrations, now) {
  const byKind = {};
  const byEnvironment = {};
  const byStop = {};
  const byService = {};
  let replaced = 0;
  let ending = 0;
  let due = 0;
  let oldest = null;
  let newest = null;
  for (const registration of Object.values(registrations ?? {})) {
    if (registration === null || typeof registration !== "object") continue;
    count(byKind, registration.kind === "stop" ? "stop" : "bus");
    count(byEnvironment, ["sandbox", "production"].includes(registration.environment) ? registration.environment : "unknown");
    if (STOP.test(registration.stopCode ?? "")) count(byStop, registration.stopCode);
    if (registration.kind !== "stop" && SERVICE.test(registration.service ?? "")) count(byService, registration.service);
    if (registration.replaced) replaced += 1;
    if (registration.endAttempts) ending += 1;
    if (!(registration.nextPollAt > now)) due += 1;
    if (Number.isFinite(registration.createdAt)) {
      const age = Math.max(0, now - registration.createdAt);
      oldest = oldest === null ? age : Math.max(oldest, age);
      newest = newest === null ? age : Math.min(newest, age);
    }
  }
  const total = Object.values(byKind).reduce((sum, value) => sum + value, 0);
  return {
    total,
    byKind,
    byEnvironment,
    topStops: ranked(byStop),
    distinctStops: Object.keys(byStop).length,
    topServices: ranked(byService),
    replaced,
    ending,
    due,
    oldestAgeMs: oldest,
    newestAgeMs: newest,
  };
}

function coordinate(latitude, longitude) {
  const lat = Number.parseFloat(latitude);
  const lng = Number.parseFloat(longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || (lat === 0 && lng === 0)) return null;
  if (lat < 1 || lat > 1.6 || lng < 103.5 || lng > 104.2) return null;
  return { lat, lng };
}

function liveBuses(services, serviceNo) {
  const service = (services ?? []).find((candidate) => candidate.ServiceNo === serviceNo);
  if (!service) return { operator: null, buses: [] };
  const buses = [];
  ["NextBus", "NextBus2", "NextBus3"].forEach((key, index) => {
    const bus = service[key];
    const eta = Date.parse(bus?.EstimatedArrival ?? "");
    if (!bus || !Number.isFinite(eta)) return;
    const visit = Number.parseInt(bus.VisitNumber, 10);
    buses.push({
      slot: index + 1,
      eta,
      position: coordinate(bus.Latitude, bus.Longitude),
      monitored: bus.Monitored === undefined || bus.Monitored === "" ? null : Number(bus.Monitored) === 1,
      visit: Number.isFinite(visit) ? visit : null,
      origin: STOP.test(bus.OriginCode ?? "") ? bus.OriginCode : null,
      destination: STOP.test(bus.DestinationCode ?? "") ? bus.DestinationCode : null,
      load: bus.Load || null,
      type: bus.Type || null,
      feature: bus.Feature || null,
    });
  });
  return { operator: service.Operator || null, buses };
}

function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function hash(value) {
  return crypto.createHash("sha256").update(stable(value ?? null)).digest("hex");
}

function routeStatus(serviceStops, busRoutes) {
  const stops = serviceStops ?? {};
  const routes = busRoutes ?? {};
  const services = Object.keys(stops);
  let directions = 0;
  const short = [];
  const blank = [];
  for (const service of services) {
    const lists = Array.isArray(stops[service]) ? stops[service] : Object.values(stops[service] ?? {});
    const lines = Array.isArray(routes[service]) ? routes[service] : Object.values(routes[service] ?? {});
    directions += lists.length;
    if (lines.length < lists.length) short.push(service);
    if (lines.slice(0, lists.length).some((line) => typeof line !== "string" || line.length < 4)) blank.push(service);
  }
  return {
    services: services.length,
    directions,
    routeServices: Object.keys(routes).length,
    routesWithoutStops: Object.keys(routes).filter((service) => !(service in stops)).length,
    shortServices: short.slice(0, TOP),
    shortCount: short.length,
    blankServices: blank.slice(0, TOP),
    blankCount: blank.length,
    stopsHash: hash(stops),
    routesHash: hash(routes),
  };
}

function parseStops(raw) {
  const stops = [...new Set(String(raw ?? "").split(",").map((stop) => stop.trim()).filter(Boolean))];
  if (stops.length === 0 || stops.length > MAX_LIVE_STOPS || !stops.every((stop) => STOP.test(stop))) return null;
  return stops;
}

function makeOpsHandler({ db, secret, accountKey, origins, emulated = false, fetcher = fetchStop, now = () => Date.now(), log = console }) {
  const boards = new Map();
  let routesCache = null;

  function board(stopCode) {
    const cached = boards.get(stopCode);
    if (cached && now() - cached.at < LIVE_CACHE_MS) return cached.promise;
    const at = now();
    const promise = fetcher(stopCode, accountKey()).then(
      (services) => ({ ok: true, at, services }),
      (error) => {
        boards.delete(stopCode);
        log.warn?.(`ops live: ${error.message}`);
        return { ok: false, at, error: /LTA \d+/.exec(error.message)?.[0] ?? "LTA unavailable" };
      },
    );
    boards.set(stopCode, { at, promise });
    return promise;
  }

  async function routes() {
    if (routesCache && now() - routesCache.at < ROUTES_CACHE_MS) return routesCache.value;
    const [stops, lines] = await Promise.all([db().ref("serviceStops").get(), db().ref("busRoutes").get()]);
    const value = { ...routeStatus(stops.val(), lines.val()), checkedAt: now() };
    routesCache = { at: now(), value };
    return value;
  }

  async function summary() {
    const at = now();
    const [registrations, last, hours] = await Promise.all([
      db().ref("liveActivities").get(),
      db().ref("liveActivityStats/last").get(),
      db().ref("liveActivityStats/hours").orderByKey().limitToLast(48).get(),
    ]);
    const buckets = Object.entries(hours.val() ?? {}).map(([hour, values]) => ({ hour, ...values }));
    return {
      now: at,
      subscribers: subscriberSummary(registrations.val(), at),
      poller: { last: last.val(), hours: buckets },
    };
  }

  async function live(query) {
    const service = String(query.service ?? "");
    const stops = parseStops(query.stops);
    if (!SERVICE.test(service) || !stops) return null;
    const result = { now: now(), service, operator: null, stops: {} };
    await inPool(stops, MAX_LIVE_STOPS, async (stopCode) => {
      const fetched = await board(stopCode);
      if (!fetched.ok) {
        result.stops[stopCode] = { ok: false, fetchedAt: fetched.at, error: fetched.error, buses: [] };
        return;
      }
      const { operator, buses } = liveBuses(fetched.services, service);
      result.operator ??= operator;
      result.stops[stopCode] = { ok: true, fetchedAt: fetched.at, buses };
    });
    return result;
  }

  return async function handle(request, response) {
    const origin = request.headers?.origin;
    response.set("Vary", "Origin");
    if (allowsOrigin(origin, origins(), emulated)) {
      response.set("Access-Control-Allow-Origin", origin);
      response.set("Access-Control-Allow-Headers", "Authorization");
      response.set("Access-Control-Allow-Methods", "GET, OPTIONS");
      response.set("Access-Control-Max-Age", "600");
    } else if (origin) {
      return response.status(403).send("origin not allowed");
    }
    if (request.method === "OPTIONS") return response.status(204).end();
    if (request.method !== "GET") return response.status(405).end();
    if (!secretMatches(request.headers?.authorization, secret())) return response.status(401).send("unauthorized");
    response.set("Cache-Control", "no-store");
    try {
      const view = request.query?.view;
      if (view === "summary") return response.json(await summary());
      if (view === "routes") return response.json(await routes());
      if (view === "live") {
        const result = await live(request.query);
        return result ? response.json(result) : response.status(400).send(`bad service or stops (at most ${MAX_LIVE_STOPS})`);
      }
      return response.status(400).send("unknown view");
    } catch (error) {
      log.error?.(`ops: ${error.message}`);
      return response.status(500).send("failed");
    }
  };
}

module.exports = { makeOpsHandler, secretMatches, allowsOrigin, subscriberSummary, liveBuses, routeStatus, stable, hash, parseStops, MAX_LIVE_STOPS };
