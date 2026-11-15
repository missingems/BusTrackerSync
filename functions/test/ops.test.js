const test = require("node:test");
const assert = require("node:assert/strict");
const { makeOpsHandler, secretMatches, allowsOrigin, subscriberSummary, liveBuses, routeStatus, stable, parseStops } = require("../src/ops");

const SECRET = "s3cret-for-tests-only-0123456789";
const ORIGIN = "https://missingems.github.io";
const now = Date.parse("2026-11-15T08:00:00Z");
const TOKEN = "deadbeef".repeat(8);
const ID = "11111111-2222-3333-4444-555555555555";

const registrations = {
  [ID]: { token: TOKEN, service: "174", stopCode: "12101", environment: "production", tracked: now + 60_000, since: now - 10_000, createdAt: now - 600_000, nextPollAt: now + 5_000 },
  "aaaaaaaa-0000-0000-0000-000000000001": { token: "ab".repeat(32), service: "174", stopCode: "12101", environment: "sandbox", tracked: now, since: now, createdAt: now - 60_000, replaced: now - 1 },
  "aaaaaaaa-0000-0000-0000-000000000002": { kind: "stop", token: "cd".repeat(32), stopCode: "83139", environment: "production", expires: now + 1, createdAt: now - 30_000, endAttempts: 1 },
};

function fakeDB(tree) {
  const at = (path) => path.split("/").reduce((node, key) => node?.[key], tree) ?? null;
  return () => ({
    ref: (path) => ({
      get: async () => ({ val: () => structuredClone(at(path)) }),
      orderByKey: () => ({
        limitToLast: (count) => ({
          get: async () => ({ val: () => Object.fromEntries(Object.entries(at(path) ?? {}).sort(([a], [b]) => a.localeCompare(b)).slice(-count)) }),
        }),
      }),
    }),
  });
}

function call(handler, { method = "GET", query = {}, origin = ORIGIN, auth = `Bearer ${SECRET}` } = {}) {
  const headers = {};
  if (origin) headers.origin = origin;
  if (auth) headers.authorization = auth;
  const response = { statusCode: 200, headers: {}, body: undefined };
  response.set = (key, value) => { response.headers[key.toLowerCase()] = value; return response; };
  response.status = (code) => { response.statusCode = code; return response; };
  response.send = (body) => { response.body = body; return response; };
  response.json = (body) => { response.body = JSON.parse(JSON.stringify(body)); return response; };
  response.end = () => response;
  return Promise.resolve(handler({ method, query, headers }, response)).then(() => response);
}

const iso = (ms) => new Date(ms).toISOString().replace("Z", "+08:00");
const board = [{
  ServiceNo: "174",
  Operator: "SBST",
  NextBus: { OriginCode: "10009", DestinationCode: "44009", EstimatedArrival: iso(now + 120_000), Monitored: 1, Latitude: "1.3", Longitude: "103.8", VisitNumber: "1", Load: "SEA", Feature: "WAB", Type: "DD" },
  NextBus2: { OriginCode: "10009", DestinationCode: "44009", EstimatedArrival: iso(now + 600_000), Monitored: 0, Latitude: "0.0", Longitude: "0.0", VisitNumber: "1", Load: "SEA", Feature: "", Type: "SD" },
  NextBus3: { EstimatedArrival: "", Latitude: "", Longitude: "" },
}];

function handler(overrides = {}) {
  const fetched = [];
  const made = makeOpsHandler({
    db: fakeDB({ liveActivities: registrations, liveActivityStats: { last: { at: now - 30_000, rounds: 3 }, hours: { 2026111507: { runs: 60 }, 2026111508: { runs: 1 } } }, serviceStops: { 174: [["1", "2"], ["2", "1"]], 10: [["3"]] }, busRoutes: { 174: ["abcd", "efgh"] } }),
    secret: () => SECRET,
    accountKey: () => "lta-key",
    origins: () => [ORIGIN],
    fetcher: async (stop) => { fetched.push(stop); return board; },
    now: () => now,
    log: {},
    ...overrides,
  });
  made.fetched = fetched;
  return made;
}

test("the secret has to match exactly and be long enough", () => {
  assert.equal(secretMatches(`Bearer ${SECRET}`, SECRET), true);
  assert.equal(secretMatches(`Bearer ${SECRET}x`, SECRET), false);
  assert.equal(secretMatches(SECRET, SECRET), false);
  assert.equal(secretMatches(undefined, SECRET), false);
  assert.equal(secretMatches("Bearer short", "short"), false);
  assert.equal(secretMatches("Bearer anything-long-enough-here", undefined), false);
});

test("only the Pages origin is allowed, plus localhost in the emulator", () => {
  assert.equal(allowsOrigin(ORIGIN, [ORIGIN], false), true);
  assert.equal(allowsOrigin(`${ORIGIN}.evil.com`, [ORIGIN], false), false);
  assert.equal(allowsOrigin("http://localhost:8000", [ORIGIN], false), false);
  assert.equal(allowsOrigin("http://localhost:8000", [ORIGIN], true), true);
  assert.equal(allowsOrigin("http://localhost.evil.com", [ORIGIN], true), false);
});

test("subscriber summary counts by kind, environment, stop and service", () => {
  const summary = subscriberSummary(registrations, now);
  assert.equal(summary.total, 3);
  assert.deepEqual(summary.byKind, { bus: 2, stop: 1 });
  assert.deepEqual(summary.byEnvironment, { production: 2, sandbox: 1 });
  assert.deepEqual(summary.topStops, [{ key: "12101", count: 2 }, { key: "83139", count: 1 }]);
  assert.deepEqual(summary.topServices, [{ key: "174", count: 2 }]);
  assert.equal(summary.replaced, 1);
  assert.equal(summary.ending, 1);
  assert.equal(summary.due, 2);
  assert.equal(summary.oldestAgeMs, 600_000);
  assert.equal(summary.newestAgeMs, 30_000);
  assert.deepEqual(subscriberSummary(null, now).total, 0);
});

test("live buses keep ETA, fix, monitoring and visit, and drop 0,0 fixes and blank slots", () => {
  const { operator, buses } = liveBuses(board, "174");
  assert.equal(operator, "SBST");
  assert.equal(buses.length, 2);
  assert.deepEqual(buses[0], { slot: 1, eta: now + 120_000 - 8 * 3_600_000, position: { lat: 1.3, lng: 103.8 }, monitored: true, visit: 1, origin: "10009", destination: "44009", load: "SEA", type: "DD", feature: "WAB" });
  assert.equal(buses[1].position, null);
  assert.equal(buses[1].monitored, false);
  assert.deepEqual(liveBuses(board, "999"), { operator: null, buses: [] });
});

test("route status finds services with fewer polylines than stop lists", () => {
  const status = routeStatus({ 174: [["1", "2"], ["2", "1"]], 10: [["3"]], 12: [["4"]] }, { 174: ["abcd", ""], 12: ["wxyz"], 99: ["zzzz"] });
  assert.equal(status.services, 3);
  assert.equal(status.directions, 4);
  assert.deepEqual(status.shortServices, ["10"]);
  assert.deepEqual(status.blankServices, ["174"]);
  assert.equal(status.routesWithoutStops, 1);
  assert.match(status.stopsHash, /^[0-9a-f]{64}$/);
  assert.equal(stable({ b: [1, { d: 2, c: 3 }], a: "x" }), '{"a":"x","b":[1,{"c":3,"d":2}]}');
});

test("stops must be 1 to 6 five-digit codes", () => {
  assert.deepEqual(parseStops("12101, 12101,83139"), ["12101", "83139"]);
  assert.equal(parseStops(""), null);
  assert.equal(parseStops("1234"), null);
  assert.equal(parseStops("11111,22222,33333,44444,55555,66666,77777"), null);
});

test("preflight from the Pages origin passes without the secret", async () => {
  const response = await call(handler(), { method: "OPTIONS", auth: null });
  assert.equal(response.statusCode, 204);
  assert.equal(response.headers["access-control-allow-origin"], ORIGIN);
  assert.equal(response.headers["access-control-allow-headers"], "Authorization");
});

test("other origins are refused before anything is read", async () => {
  const preflight = await call(handler(), { method: "OPTIONS", origin: "https://evil.example", auth: null });
  assert.equal(preflight.statusCode, 403);
  assert.equal(preflight.headers["access-control-allow-origin"], undefined);
  const get = await call(handler(), { origin: "https://evil.example", query: { view: "summary" } });
  assert.equal(get.statusCode, 403);
  assert.equal(get.body, "origin not allowed");
});

test("requests without the right secret get 401", async () => {
  assert.equal((await call(handler(), { auth: null, query: { view: "summary" } })).statusCode, 401);
  assert.equal((await call(handler(), { auth: "Bearer wrong-secret-0123456789", query: { view: "summary" } })).statusCode, 401);
  assert.equal((await call(handler({ secret: () => "" }), { auth: "Bearer ", query: { view: "summary" } })).statusCode, 401);
  assert.equal((await call(handler(), { method: "POST", query: { view: "summary" } })).statusCode, 405);
});

test("summary returns aggregates and never a token or activity id", async () => {
  const response = await call(handler(), { query: { view: "summary" } });
  assert.equal(response.statusCode, 200);
  assert.equal(response.headers["cache-control"], "no-store");
  assert.equal(response.body.subscribers.total, 3);
  assert.equal(response.body.poller.last.rounds, 3);
  assert.deepEqual(response.body.poller.hours.map((hour) => hour.hour), ["2026111507", "2026111508"]);
  const text = JSON.stringify(response.body);
  for (const secret of [TOKEN, ID, "ab".repeat(32), "cd".repeat(32), "aaaaaaaa-0000"]) assert.equal(text.includes(secret), false, secret);
});

test("routes view reports pairing problems", async () => {
  const response = await call(handler(), { query: { view: "routes" } });
  assert.equal(response.body.services, 2);
  assert.deepEqual(response.body.shortServices, ["10"]);
  assert.equal(response.body.checkedAt, now);
});

test("live view fetches each stop once per 20 s and filters to the service", async () => {
  const ops = handler();
  const first = await call(ops, { query: { view: "live", service: "174", stops: "12101,12109" } });
  assert.equal(first.statusCode, 200);
  assert.equal(first.body.operator, "SBST");
  assert.equal(first.body.stops["12101"].buses.length, 2);
  await call(ops, { query: { view: "live", service: "174", stops: "12101" } });
  assert.deepEqual(ops.fetched.sort(), ["12101", "12109"]);
  assert.equal((await call(ops, { query: { view: "live", service: "17;4", stops: "12101" } })).statusCode, 400);
  assert.equal((await call(ops, { query: { view: "nope" } })).statusCode, 400);
});

test("an LTA failure is reported per stop without leaking the error text", async () => {
  const ops = handler({ fetcher: async () => { throw new Error("LTA 503 for 12101 key=lta-key"); } });
  const response = await call(ops, { query: { view: "live", service: "174", stops: "12101" } });
  assert.deepEqual(response.body.stops["12101"], { ok: false, fetchedAt: now, error: "LTA 503", buses: [] });
});
