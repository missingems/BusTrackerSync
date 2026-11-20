const test = require("node:test");
const assert = require("node:assert/strict");
const http2 = require("node:http2");
const { EventEmitter } = require("node:events");
const crypto = require("node:crypto");
const { APNs, isDeadToken } = require("../src/apns");
const { memoryRef } = require("./support/memory-ref");
const {
  parseAlerts, minutesOfDay, inQuiet, disruptedPayload, normalPayload, subscriberId,
  parseSubscription, makeSubscriptionHandler, tick,
} = require("../src/serviceAlerts");

const NORMAL = { value: { Status: 1, AffectedSegments: [], Message: [] } };
const nel = (extra = {}) => ({
  Line: "NEL",
  Direction: "Punggol",
  Stations: "NE1,NE3,NE4,NE5,NE6",
  FreePublicBus: "NE1,NE3,NE4,NE5,NE6",
  FreeMRTShuttle: "NE1,NE3",
  MRTShuttleDirection: "Both",
  ...extra,
});
const alerts = (...segments) => ({ value: { Status: 2, AffectedSegments: segments, Message: [{ Content: "1710hrs: NEL – No train service", CreatedDate: "2017-12-01 17:54:21" }] } });

const TOKEN_A = "a1".repeat(32);
const TOKEN_B = "b2".repeat(32);
const idA = subscriberId(TOKEN_A);
const idB = subscriberId(TOKEN_B);
const subscriber = (token, lines, quiet = null, environment = "sandbox") => ({ token, environment, lines, quiet, updatedAt: 1 });

const SGT_NOON = Date.parse("2026-11-20T04:00:00Z");
const SGT_2330 = Date.parse("2026-11-20T15:30:00Z");

const silent = { warn() {}, info() {}, log() {} };

function harness({ subscribers = {}, state = {}, status = 200 } = {}) {
  const calls = [];
  const apns = {
    async send(push) {
      calls.push(push);
      return typeof status === "function" ? status(push) : { status, reason: null };
    },
  };
  const stateRef = memoryRef(state);
  const subscribersRef = memoryRef(subscribers);
  let writes = 0;
  const set = stateRef.set;
  stateRef.set = async (value) => { writes += 1; return set(value); };
  let reads = 0;
  const get = subscribersRef.get;
  subscribersRef.get = async () => { reads += 1; return get(); };
  return {
    calls, stateRef, subscribersRef,
    writes: () => writes,
    subscriberReads: () => reads,
    run: (body, at = SGT_NOON) => tick({
      fetchAlerts: async () => { if (body instanceof Error) throw body; return body; },
      stateRef, subscribersRef, apns, now: () => at, log: silent,
    }),
  };
}

test("parses normal service as no disruptions", () => {
  assert.deepEqual(parseAlerts(NORMAL), { ok: true, status: 1, disruptions: {} });
  assert.equal(parseAlerts({ value: { Status: "1" } }).ok, true);
});

test("parses a disruption with direction, ordered stations and free buses", () => {
  const parsed = parseAlerts(alerts(nel()));
  assert.equal(parsed.ok, true);
  const disruption = parsed.disruptions.NEL;
  assert.equal(disruption.line, "NEL");
  assert.equal(disruption.direction, "Punggol");
  assert.deepEqual(disruption.stations, ["NE1", "NE3", "NE4", "NE5", "NE6"]);
  assert.equal(disruption.freeBus, 5);
  assert.equal(disruption.islandWide, false);
  assert.match(disruption.key, /^[0-9a-f]{16}$/);
});

test("merges segments of the same line and keeps feed station order", () => {
  const parsed = parseAlerts(alerts(
    nel({ Stations: "NE12, NE13", FreePublicBus: "NE12", Direction: "Both" }),
    nel({ Stations: " ne3,NE4,NE3 ", FreePublicBus: "NE4", Direction: "Both" }),
    { Line: "EWL", Direction: "Both", Stations: "EW1" },
  ));
  assert.deepEqual(Object.keys(parsed.disruptions).sort(), ["EWL", "NEL"]);
  assert.deepEqual(parsed.disruptions.NEL.stations, ["NE12", "NE13", "NE3", "NE4"]);
  assert.equal(parsed.disruptions.NEL.freeBus, 2);
  assert.equal(parsed.disruptions.NEL.direction, "");
});

test("merged segments with differing directions drop the direction", () => {
  const same = parseAlerts(alerts(nel(), nel({ Stations: "NE7" }))).disruptions.NEL;
  assert.equal(same.direction, "Punggol");
  const mixed = parseAlerts(alerts(nel(), nel({ Direction: "HarbourFront" }))).disruptions.NEL;
  assert.equal(mixed.direction, "");
});

test("island-wide free bus counts every affected station", () => {
  const parsed = parseAlerts(alerts(nel({ FreePublicBus: "Free bus service island wide" })));
  assert.equal(parsed.disruptions.NEL.islandWide, true);
  assert.equal(parsed.disruptions.NEL.freeBus, 5);
});

test("maps LTA's STL and PTL to the app's SKL and PGL", () => {
  const parsed = parseAlerts(alerts(
    { Line: "STL", Direction: "Both", Stations: "SE1,SE2" },
    { Line: "PTL", Direction: "Both", Stations: "PE1" },
  ));
  assert.deepEqual(Object.keys(parsed.disruptions).sort(), ["PGL", "SKL"]);
});

test("the key ignores messages and segment order but follows what the push shows", () => {
  const a = alerts(nel(), { Line: "EWL", Direction: "Both", Stations: "EW1" });
  const b = alerts({ Line: "EWL", Direction: "Both", Stations: "EW1" }, nel());
  b.value.Message = [{ Content: "different", CreatedDate: "2017-12-01 18:00:00" }];
  assert.equal(parseAlerts(a).disruptions.NEL.key, parseAlerts(b).disruptions.NEL.key);
  assert.notEqual(parseAlerts(alerts(nel())).disruptions.NEL.key, parseAlerts(alerts(nel({ Stations: "NE1,NE3,NE4" }))).disruptions.NEL.key);
  assert.notEqual(parseAlerts(alerts(nel())).disruptions.NEL.key, parseAlerts(alerts(nel({ FreePublicBus: "" }))).disruptions.NEL.key);
});

test("tolerates missing, empty and oddly typed optional fields", () => {
  const parsed = parseAlerts(alerts({ Line: "CCL", Direction: null, Stations: ["CC1", 7, "CC2"], FreePublicBus: null }));
  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.disruptions.CCL.stations, ["CC1", "CC2"]);
  assert.equal(parsed.disruptions.CCL.freeBus, 0);
  assert.equal(parseAlerts(alerts({ Line: "DTL" })).disruptions.DTL.stations.length, 0);
});

test("ignores well-formed lines the app does not know", () => {
  const parsed = parseAlerts(alerts(nel(), { Line: "XYZ", Stations: "X1" }));
  assert.deepEqual(Object.keys(parsed.disruptions), ["NEL"]);
});

test("malformed responses fail closed", () => {
  const bad = [
    null, {}, [], "x", { value: null }, { value: [] }, { value: {} },
    { value: { Status: 3, AffectedSegments: [] } },
    { value: { Status: "", AffectedSegments: [] } },
    { value: { Status: null } },
    { value: { Status: 1, AffectedSegments: "none" } },
    { value: { Status: 1, AffectedSegments: [null] } },
    { value: { Status: 2, AffectedSegments: [{ Stations: "NE1" }] } },
    { value: { Status: 2, AffectedSegments: [nel(), { Line: 5 }] } },
    { value: { Status: 2, AffectedSegments: [] } },
    { value: { Status: 2 } },
    { value: { Status: 2, AffectedSegments: [{ Line: "XYZ" }] } },
  ];
  for (const body of bad) assert.equal(parseAlerts(body).ok, false, JSON.stringify(body));
});

test("quiet window maths in Singapore time", () => {
  assert.equal(minutesOfDay(Date.parse("2026-11-20T16:00:00Z")), 0);
  assert.equal(minutesOfDay(Date.parse("2026-11-20T15:59:00Z")), 1439);
  assert.equal(minutesOfDay(SGT_NOON), 12 * 60);
  const day = { from: 9 * 60, to: 17 * 60 };
  assert.equal(inQuiet(day, SGT_NOON), true);
  assert.equal(inQuiet(day, Date.parse("2026-11-20T09:00:00Z")), false);
  assert.equal(inQuiet(day, Date.parse("2026-11-20T01:00:00Z")), true);
  assert.equal(inQuiet(day, Date.parse("2026-11-20T09:00:00Z") - 60_000), true);
  assert.equal(inQuiet(day, Date.parse("2026-11-20T01:00:00Z") - 60_000), false);
  assert.equal(inQuiet(null, SGT_NOON), false);
  assert.equal(inQuiet({ from: 600, to: 600 }, SGT_NOON), false);
});

test("quiet window wrapping past midnight", () => {
  const night = { from: 22 * 60 + 30, to: 7 * 60 };
  assert.equal(inQuiet(night, SGT_2330), true);
  assert.equal(inQuiet(night, Date.parse("2026-11-20T16:00:00Z")), true);
  assert.equal(inQuiet(night, Date.parse("2026-11-20T22:59:00Z")), true);
  assert.equal(inQuiet(night, Date.parse("2026-11-20T23:00:00Z")), false);
  assert.equal(inQuiet(night, SGT_NOON), false);
  assert.equal(inQuiet(night, Date.parse("2026-11-20T14:29:00Z")), false);
  assert.equal(inQuiet(night, Date.parse("2026-11-20T14:30:00Z")), true);
});

test("disrupted payload", () => {
  const { disruptions } = parseAlerts(alerts(nel()));
  assert.deepEqual(disruptedPayload(disruptions.NEL), {
    aps: {
      alert: {
        "title-loc-key": "%@ disrupted",
        "title-loc-args": ["NEL"],
        "subtitle-loc-key": "Free bus rides at %@ stations",
        "subtitle-loc-args": ["5"],
        body: "HarbourFront – Dhoby Ghaut → Punggol",
      },
      sound: "default",
      "thread-id": "service-alert-NEL",
    },
    line: "NEL",
    kind: "disrupted",
  });
});

test("payload body names first and last stations, with direction only when it is one way", () => {
  const body = (segment) => disruptedPayload(parseAlerts(alerts(segment)).disruptions[segment.Line]).aps.alert;
  assert.equal(body(nel({ Stations: "NE1,NE3,NE6", Direction: "Both" })).body, "HarbourFront – Dhoby Ghaut");
  assert.equal(body(nel({ Stations: "NE1,NE3,NE6", Direction: "" })).body, "HarbourFront – Dhoby Ghaut");
  assert.equal(body(nel({ Stations: "NE6,NE3,NE1", Direction: "HarbourFront" })).body, "Dhoby Ghaut – HarbourFront → HarbourFront");
  assert.equal(body(nel({ Stations: "NE6", Direction: "Both" })).body, "Dhoby Ghaut");
  assert.equal(body(nel({ Stations: "NE6,ZZ9", Direction: "Both" })).body, "Dhoby Ghaut – ZZ9");
  assert.equal(body({ Line: "NEL", Direction: "Both", Stations: "" }).body, undefined);
});

test("payload omits the subtitle without free buses and counts stations when island-wide", () => {
  const none = disruptedPayload(parseAlerts(alerts(nel({ FreePublicBus: "" }))).disruptions.NEL).aps.alert;
  assert.equal("subtitle-loc-key" in none, false);
  assert.equal("subtitle-loc-args" in none, false);
  const island = disruptedPayload(parseAlerts(alerts(nel({ FreePublicBus: "Free bus service island wide", Stations: "NE1,NE3,NE4" }))).disruptions.NEL).aps.alert;
  assert.deepEqual(island["subtitle-loc-args"], ["3"]);
});

test("back to normal payload", () => {
  assert.deepEqual(normalPayload("NEL"), {
    aps: {
      alert: { "title-loc-key": "%@ back to normal", "title-loc-args": ["NEL"] },
      sound: "default",
      "thread-id": "service-alert-NEL",
    },
    line: "NEL",
    kind: "normal",
  });
});

test("station names cover every code of an interchange", () => {
  const names = (codes) => disruptedPayload({ line: "NSL", stations: codes, direction: "", freeBus: 0 }).aps.alert.body;
  assert.equal(names(["NS17", "CC15"]), "Bishan");
  assert.equal(names(["NS24", "NE6", "CC1"]), "Dhoby Ghaut");
});

test("subscription validation", () => {
  const good = { token: TOKEN_A, environment: "sandbox", lines: ["NEL", "SKL"], quiet: null };
  assert.deepEqual(parseSubscription(good), { token: TOKEN_A, environment: "sandbox", lines: ["NEL", "SKL"], quiet: null });
  assert.deepEqual(parseSubscription({ ...good, lines: ["PGL", "NSL", "NSL"], quiet: { from: 1350, to: 420 } }), {
    token: TOKEN_A, environment: "sandbox", lines: ["NSL", "PGL"], quiet: { from: 1350, to: 420 },
  });
  assert.equal(parseSubscription({ token: TOKEN_A.toUpperCase(), environment: "production", lines: [] }).token, TOKEN_A);
  assert.equal(parseSubscription({ ...good, quiet: { from: 5, to: 5 } }).quiet, null);
  assert.equal(parseSubscription({ token: "ab".repeat(80), environment: "production", lines: ["EWL"] }).token.length, 160);
  const invalid = [
    null, "x", [], {},
    { ...good, token: "ab".repeat(31) },
    { ...good, token: "ab".repeat(81) },
    { ...good, token: "zz".repeat(32) },
    { ...good, token: undefined },
    { ...good, environment: "staging" },
    { ...good, environment: undefined },
    { ...good, lines: "NEL" },
    { ...good, lines: undefined },
    { ...good, lines: ["STL"] },
    { ...good, lines: ["nel"] },
    { ...good, lines: [1] },
    { ...good, quiet: { from: -1, to: 5 } },
    { ...good, quiet: { from: 0, to: 1440 } },
    { ...good, quiet: { from: 1.5, to: 5 } },
    { ...good, quiet: { from: "1", to: 5 } },
    { ...good, quiet: { from: 1 } },
    { ...good, quiet: "night" },
    { ...good, quiet: [] },
  ];
  for (const body of invalid) assert.equal(parseSubscription(body), null, JSON.stringify(body));
});

function call(handler, method, body) {
  const response = { statusCode: 200, sent: undefined };
  response.status = (code) => { response.statusCode = code; return response; };
  response.send = (value) => { response.sent = value; return response; };
  response.end = () => response;
  return Promise.resolve(handler({ method, body }, response)).then(() => response);
}

test("subscription endpoint stores, replaces and removes by hashed token", async () => {
  const ref = memoryRef({});
  const handler = makeSubscriptionHandler({ ref: () => ref, now: () => 1234 });
  const body = { token: TOKEN_A.toUpperCase(), environment: "production", lines: ["NEL"], quiet: { from: 60, to: 120 }, extra: "ignored" };
  assert.equal((await call(handler, "PUT", body)).statusCode, 204);
  const id = crypto.createHash("sha256").update(TOKEN_A).digest("hex");
  assert.deepEqual(ref.data[id], { token: TOKEN_A, environment: "production", lines: ["NEL"], quiet: { from: 60, to: 120 }, updatedAt: 1234 });
  assert.deepEqual(Object.keys(ref.data), [id]);

  assert.equal((await call(handler, "PUT", { ...body, lines: ["EWL", "CCL"], quiet: null })).statusCode, 204);
  assert.deepEqual(ref.data[id].lines, ["EWL", "CCL"]);
  assert.equal(ref.data[id].quiet, null);

  assert.equal((await call(handler, "PUT", { ...body, lines: [] })).statusCode, 204);
  assert.deepEqual(ref.data, {});

  await call(handler, "PUT", body);
  assert.equal((await call(handler, "DELETE", { token: TOKEN_A })).statusCode, 204);
  assert.deepEqual(ref.data, {});
});

test("subscription endpoint rejects bad input and other methods", async () => {
  const ref = memoryRef({});
  const handler = makeSubscriptionHandler({ ref: () => ref });
  assert.equal((await call(handler, "PUT", { token: "nope", environment: "sandbox", lines: ["NEL"] })).statusCode, 400);
  assert.equal((await call(handler, "PUT", undefined)).statusCode, 400);
  assert.equal((await call(handler, "DELETE", {})).statusCode, 400);
  assert.equal((await call(handler, "DELETE", undefined)).statusCode, 400);
  assert.equal((await call(handler, "GET")).statusCode, 405);
  assert.equal((await call(handler, "POST", {})).statusCode, 405);
  assert.deepEqual(ref.data, {});
});

test("a new disruption notifies subscribers of that line only", async () => {
  const h = harness({ subscribers: {
    [idA]: subscriber(TOKEN_A, ["NEL", "EWL"]),
    [idB]: subscriber(TOKEN_B, ["CCL"], null, "production"),
  } });
  const result = await h.run(alerts(nel()));
  assert.equal(result.disrupted, 1);
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].token, TOKEN_A);
  assert.equal(h.calls[0].environment, "sandbox");
  assert.equal(h.calls[0].pushType, "alert");
  assert.equal(h.calls[0].priority, 10);
  assert.equal(h.calls[0].payload.kind, "disrupted");
  const stored = h.stateRef.data.NEL;
  assert.equal(stored.since, SGT_NOON);
  assert.deepEqual(stored.notified, { [idA]: true });
  assert.equal(stored.pending, undefined);
});

test("an unchanged disruption does nothing and stays cheap", async () => {
  const h = harness({ subscribers: { [idA]: subscriber(TOKEN_A, ["NEL"]) } });
  await h.run(alerts(nel()));
  const writes = h.writes();
  const reads = h.subscriberReads();
  const again = await h.run(alerts(nel(), ), SGT_NOON + 60_000);
  assert.equal(again.idle, true);
  assert.equal(h.calls.length, 1);
  assert.equal(h.writes(), writes);
  assert.equal(h.subscriberReads(), reads);
});

test("normal service with empty state reads no subscribers", async () => {
  const h = harness({ subscribers: { [idA]: subscriber(TOKEN_A, ["NEL"]) } });
  const result = await h.run(NORMAL);
  assert.equal(result.idle, true);
  assert.equal(h.subscriberReads(), 0);
  assert.equal(h.calls.length, 0);
  assert.equal(h.writes(), 0);
});

test("a changed disruption notifies again", async () => {
  const h = harness({ subscribers: { [idA]: subscriber(TOKEN_A, ["NEL"]) } });
  await h.run(alerts(nel()));
  await h.run(alerts(nel({ Stations: "NE1,NE3,NE4,NE5,NE6,NE7" })), SGT_NOON + 60_000);
  assert.equal(h.calls.length, 2);
  assert.equal(h.calls[1].payload.aps.alert.body, "HarbourFront – Little India → Punggol");
  assert.equal(h.stateRef.data.NEL.since, SGT_NOON);
  assert.deepEqual(h.stateRef.data.NEL.notified, { [idA]: true });
});

test("quiet hours hold the push as pending, then flush when the window ends", async () => {
  const night = { from: 22 * 60, to: 7 * 60 };
  const h = harness({ subscribers: {
    [idA]: subscriber(TOKEN_A, ["NEL"], night),
    [idB]: subscriber(TOKEN_B, ["NEL"]),
  } });
  await h.run(alerts(nel()), SGT_2330);
  assert.deepEqual(h.calls.map((call) => call.token), [TOKEN_B]);
  assert.deepEqual(h.stateRef.data.NEL.pending, { [idA]: true });
  assert.deepEqual(h.stateRef.data.NEL.notified, { [idB]: true });

  const stillNight = await h.run(alerts(nel()), SGT_2330 + 60_000);
  assert.equal(h.calls.length, 1);
  assert.equal(stillNight.sent, 0);
  assert.equal(h.writes(), 1);

  const morning = Date.parse("2026-11-20T23:00:00Z");
  await h.run(alerts(nel()), morning);
  assert.equal(h.calls.length, 2);
  assert.equal(h.calls[1].token, TOKEN_A);
  assert.equal(h.stateRef.data.NEL.pending, undefined);
  assert.deepEqual(h.stateRef.data.NEL.notified, { [idA]: true, [idB]: true });
  const idle = await h.run(alerts(nel()), morning + 60_000);
  assert.equal(idle.idle, true);
});

test("pending is dropped when the disruption ends in quiet hours, with no notice", async () => {
  const night = { from: 22 * 60, to: 7 * 60 };
  const h = harness({ subscribers: { [idA]: subscriber(TOKEN_A, ["NEL"], night) } });
  await h.run(alerts(nel()), SGT_2330);
  await h.run(NORMAL, SGT_2330 + 60_000);
  assert.equal(h.calls.length, 0);
  assert.deepEqual(h.stateRef.data, {});
});

test("pending is dropped for subscribers who unsubscribe from the line", async () => {
  const night = { from: 22 * 60, to: 7 * 60 };
  const h = harness({ subscribers: { [idA]: subscriber(TOKEN_A, ["NEL"], night) } });
  await h.run(alerts(nel()), SGT_2330);
  h.subscribersRef.data[idA].lines = ["EWL"];
  await h.run(alerts(nel()), Date.parse("2026-11-20T23:00:00Z"));
  assert.equal(h.calls.length, 0);
  assert.equal(h.stateRef.data.NEL.pending, undefined);
});

test("resolving sends back to normal to notified subscribers who still follow the line", async () => {
  const idC = subscriberId("c3".repeat(32));
  const idD = subscriberId("d4".repeat(32));
  const h = harness({ subscribers: {
    [idA]: subscriber(TOKEN_A, ["NEL"]),
    [idB]: subscriber(TOKEN_B, ["NEL"]),
    [idC]: subscriber("c3".repeat(32), ["NEL"]),
    [idD]: subscriber("d4".repeat(32), ["NEL"]),
  } });
  await h.run(alerts(nel()));
  h.calls.length = 0;
  h.subscribersRef.data[idB].lines = ["CCL"];
  h.subscribersRef.data[idC].quiet = { from: 11 * 60, to: 13 * 60 };
  delete h.subscribersRef.data[idD];
  const result = await h.run(NORMAL, SGT_NOON + 60_000);
  assert.equal(result.normal, 1);
  assert.deepEqual(h.calls.map((call) => call.token), [TOKEN_A]);
  assert.equal(h.calls[0].payload.kind, "normal");
  assert.deepEqual(h.stateRef.data, {});
});

test("a subscriber who joined after the alert is not sent a back to normal", async () => {
  const h = harness({ subscribers: { [idA]: subscriber(TOKEN_A, ["NEL"]) } });
  await h.run(alerts(nel()));
  h.subscribersRef.data[idB] = subscriber(TOKEN_B, ["NEL"]);
  h.calls.length = 0;
  await h.run(NORMAL, SGT_NOON + 60_000);
  assert.deepEqual(h.calls.map((call) => call.token), [TOKEN_A]);
});

test("lines resolve independently", async () => {
  const h = harness({ subscribers: { [idA]: subscriber(TOKEN_A, ["NEL", "EWL"]) } });
  await h.run(alerts(nel(), { Line: "EWL", Direction: "Both", Stations: "EW1,EW2" }));
  h.calls.length = 0;
  await h.run(alerts(nel()), SGT_NOON + 60_000);
  assert.deepEqual(h.calls.map((call) => call.payload.line), ["EWL"]);
  assert.deepEqual(h.calls.map((call) => call.payload.kind), ["normal"]);
  assert.deepEqual(Object.keys(h.stateRef.data), ["NEL"]);
});

test("a failed or malformed fetch changes nothing", async () => {
  const h = harness({ subscribers: { [idA]: subscriber(TOKEN_A, ["NEL"]) } });
  await h.run(alerts(nel()));
  const snapshot = structuredClone(h.stateRef.data);
  const writes = h.writes();
  const reads = h.subscriberReads();
  h.calls.length = 0;
  for (const body of [new Error("LTA 503"), {}, { value: { Status: 1, AffectedSegments: "oops" } }, { value: { Status: 2, AffectedSegments: [] } }, null]) {
    const result = await h.run(body, SGT_NOON + 60_000);
    assert.ok(result.skipped);
  }
  assert.equal(h.calls.length, 0);
  assert.equal(h.writes(), writes);
  assert.equal(h.subscriberReads(), reads);
  assert.deepEqual(h.stateRef.data, snapshot);
});

test("subscribers whose token APNs reports dead are removed", async () => {
  const h = harness({
    subscribers: { [idA]: subscriber(TOKEN_A, ["NEL"]), [idB]: subscriber(TOKEN_B, ["NEL"]) },
    status: (push) => (push.token === TOKEN_A ? { status: 410, reason: "Unregistered" } : { status: 400, reason: "BadDeviceToken" }),
  });
  await h.run(alerts(nel()));
  assert.deepEqual(h.subscribersRef.data, {});
  assert.equal(h.stateRef.data.NEL.notified, undefined);
});

test("only 410, BadDeviceToken and Unregistered count as a dead token", () => {
  assert.equal(isDeadToken({ status: 410, reason: "ExpiredToken" }), true);
  assert.equal(isDeadToken({ status: 400, reason: "BadDeviceToken" }), true);
  assert.equal(isDeadToken({ status: 400, reason: "Unregistered" }), true);
  assert.equal(isDeadToken({ status: 400, reason: "DeviceTokenNotForTopic" }), false);
  assert.equal(isDeadToken({ status: 403, reason: "InvalidProviderToken" }), false);
  assert.equal(isDeadToken({ status: 200, reason: null }), false);
});

test("a transient APNs failure retries on the next tick", async () => {
  let failing = true;
  const h = harness({
    subscribers: { [idA]: subscriber(TOKEN_A, ["NEL"]) },
    status: () => (failing ? { status: 503, reason: "ServiceUnavailable" } : { status: 200, reason: null }),
  });
  await h.run(alerts(nel()));
  assert.deepEqual(h.stateRef.data.NEL.pending, { [idA]: true });
  assert.equal(h.stateRef.data.NEL.notified, undefined);
  failing = false;
  await h.run(alerts(nel()), SGT_NOON + 60_000);
  assert.equal(h.calls.length, 2);
  assert.deepEqual(h.stateRef.data.NEL.notified, { [idA]: true });
  assert.equal(h.stateRef.data.NEL.pending, undefined);
});

test("a permanent APNs rejection is not retried", async () => {
  const h = harness({ subscribers: { [idA]: subscriber(TOKEN_A, ["NEL"]) }, status: { status: 403, reason: "InvalidProviderToken" } });
  await h.run(alerts(nel()));
  await h.run(alerts(nel()), SGT_NOON + 60_000);
  assert.equal(h.calls.length, 1);
  assert.deepEqual(h.subscribersRef.data[idA].lines, ["NEL"]);
});

test("invalid stored subscribers are ignored", async () => {
  const h = harness({ subscribers: {
    junk: { token: "x", environment: "sandbox", lines: ["NEL"] },
    [idB]: { token: TOKEN_B, environment: "sandbox", lines: "NEL" },
    [idA]: subscriber(TOKEN_A, ["NEL"]),
  } });
  await h.run(alerts(nel()));
  assert.deepEqual(h.calls.map((call) => call.token), [TOKEN_A]);
});

function fakeHTTP2(t) {
  const requests = [];
  t.mock.method(http2, "connect", () => {
    const session = new EventEmitter();
    session.closed = false;
    session.destroyed = false;
    session.close = () => { session.closed = true; };
    session.request = (headers) => {
      const request = new EventEmitter();
      request.setEncoding = () => {};
      request.end = (body) => {
        requests.push({ headers, body });
        request.emit("response", { ":status": 200 });
        request.emit("end");
      };
      return request;
    };
    return session;
  });
  return requests;
}

test("APNs sends alerts on the plain bundle topic and keeps live activity headers unchanged", async (t) => {
  const requests = fakeHTTP2(t);
  const { privateKey } = crypto.generateKeyPairSync("ec", { namedCurve: "P-256", privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } });
  const apns = new APNs({ key: privateKey, keyId: "KEYAL", teamId: "TEAMAL", topic: "sg.com.example.App.push-type.liveactivity" });
  await apns.send({ token: "ab".repeat(32), environment: "sandbox", payload: { aps: { alert: "x" } }, priority: 10, pushType: "alert" });
  await apns.send({ token: "cd".repeat(32), environment: "sandbox", payload: { aps: {} }, priority: 5 });
  apns.close();
  const [alert, live] = requests.map(({ headers }) => headers);
  assert.equal(alert["apns-push-type"], "alert");
  assert.equal(alert["apns-topic"], "sg.com.example.App");
  assert.equal(alert["apns-priority"], "10");
  assert.equal(alert[":path"], `/3/device/${"ab".repeat(32)}`);
  assert.equal(live["apns-push-type"], "liveactivity");
  assert.equal(live["apns-topic"], "sg.com.example.App.push-type.liveactivity");
  assert.equal(live["apns-priority"], "5");
  assert.deepEqual(Object.keys(live), [":method", ":path", "authorization", "apns-topic", "apns-push-type", "apns-priority", "content-type"]);
});
