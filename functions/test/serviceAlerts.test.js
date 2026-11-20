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
const TOKEN_C = "c3".repeat(32);
const idB = subscriberId(TOKEN_B);
const idC = subscriberId(TOKEN_C);
const subscriber = (token, lines, quiet = null, environment = "sandbox") => ({ token, environment, lines, quiet, updatedAt: 1 });

const SGT_NOON = Date.parse("2026-11-20T04:00:00Z");
const SGT_2330 = Date.parse("2026-11-20T15:30:00Z");

const silent = { warn() {}, info() {}, log() {} };

const MINUTE = 60_000;
const MORNING = Date.parse("2026-11-20T23:00:00Z");

function harness({ subscribers = {}, state = {}, status = 200, limit } = {}) {
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
  const updates = [];
  const update = subscribersRef.update;
  subscribersRef.update = async (values) => { updates.push(values); return update(values); };
  return {
    calls, stateRef, subscribersRef, updates,
    writes: () => writes,
    subscriberReads: () => reads,
    run: (body, at = SGT_NOON) => tick({
      fetchAlerts: async () => { if (body instanceof Error) throw body; return body; },
      stateRef, subscribersRef, apns, now: () => at, log: silent, ...(limit ? { limit } : {}),
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

async function clearTwice(h, at = SGT_NOON + MINUTE) {
  const first = await h.run(NORMAL, at);
  assert.equal(first.sent, 0);
  return h.run(NORMAL, at + MINUTE);
}

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

test("a changed direction notifies again", async () => {
  const h = harness({ subscribers: { [idA]: subscriber(TOKEN_A, ["NEL"]) } });
  await h.run(alerts(nel()));
  await h.run(alerts(nel({ Direction: "HarbourFront" })), SGT_NOON + 60_000);
  assert.equal(h.calls.length, 2);
  assert.equal(h.calls[1].payload.aps.alert.body, "HarbourFront – Dhoby Ghaut → HarbourFront");
  assert.equal(h.stateRef.data.NEL.since, SGT_NOON);
  assert.deepEqual(h.stateRef.data.NEL.notified, { [idA]: true });
});

test("island-wide free bus appearing notifies again, and so does a second line appearing", async () => {
  const h = harness({ subscribers: { [idA]: subscriber(TOKEN_A, ["NEL", "EWL"]) } });
  await h.run(alerts(nel()));
  await h.run(alerts(nel({ FreePublicBus: "Free bus service island wide" })), SGT_NOON + 60_000);
  assert.equal(h.calls.length, 2);
  assert.deepEqual(h.calls[1].payload.aps.alert["subtitle-loc-args"], ["5"]);
  await h.run(alerts(nel({ FreePublicBus: "Free bus service island wide" }), { Line: "EWL", Direction: "Both", Stations: "EW1" }), SGT_NOON + 120_000);
  assert.deepEqual(h.calls.slice(2).map((call) => call.payload.line), ["EWL"]);
});

test("station and free bus edits update the stored state without a new push", async () => {
  const h = harness({ subscribers: { [idA]: subscriber(TOKEN_A, ["NEL"]) } });
  await h.run(alerts(nel()));
  const first = h.stateRef.data.NEL.key;
  const edited = await h.run(alerts(nel({ Stations: "NE1,NE3,NE4,NE5,NE6,NE7", FreePublicBus: "NE1" })), SGT_NOON + 60_000);
  assert.equal(edited.sent, 0);
  assert.equal(h.calls.length, 1);
  assert.notEqual(h.stateRef.data.NEL.key, first);
  assert.equal(h.stateRef.data.NEL.since, SGT_NOON);
  assert.deepEqual(h.stateRef.data.NEL.notified, { [idA]: true });
  const again = await h.run(alerts(nel({ Stations: "NE1,NE3,NE4,NE5,NE6,NE7", FreePublicBus: "NE1" })), SGT_NOON + 120_000);
  assert.equal(again.idle, true);
});

test("a silent edit still delivers a push that was held in quiet hours", async () => {
  const night = { from: 22 * 60, to: 7 * 60 };
  const h = harness({ subscribers: { [idA]: subscriber(TOKEN_A, ["NEL"], night) } });
  await h.run(alerts(nel()), SGT_2330);
  const edited = alerts(nel({ Stations: "NE1,NE3" }));
  await h.run(edited, MORNING);
  assert.equal(h.calls.length, 1);
  assert.deepEqual(h.calls[0].payload, disruptedPayload(parseAlerts(edited).disruptions.NEL));
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
  await h.run(NORMAL, SGT_2330 + 120_000);
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
  const idD = subscriberId("d4".repeat(32));
  const h = harness({ subscribers: {
    [idA]: subscriber(TOKEN_A, ["NEL"]),
    [idB]: subscriber(TOKEN_B, ["NEL"]),
    [idC]: subscriber(TOKEN_C, ["NEL"]),
    [idD]: subscriber("d4".repeat(32), ["NEL"]),
  } });
  await h.run(alerts(nel()));
  h.calls.length = 0;
  h.subscribersRef.data[idB].lines = ["CCL"];
  h.subscribersRef.data[idC].quiet = { from: 11 * 60, to: 13 * 60 };
  delete h.subscribersRef.data[idD];
  const result = await clearTwice(h);
  assert.equal(result.normal, 1);
  assert.deepEqual(h.calls.map((call) => call.token), [TOKEN_A]);
  assert.equal(h.calls[0].payload.kind, "normal");
  assert.deepEqual(h.stateRef.data.NEL.recovered, { [idC]: true });
});

test("a subscriber who joined after the alert is not sent a back to normal", async () => {
  const h = harness({ subscribers: { [idA]: subscriber(TOKEN_A, ["NEL"]) } });
  await h.run(alerts(nel()));
  h.subscribersRef.data[idB] = subscriber(TOKEN_B, ["NEL"]);
  h.calls.length = 0;
  await clearTwice(h);
  assert.deepEqual(h.calls.map((call) => call.token), [TOKEN_A]);
});

test("lines resolve independently", async () => {
  const h = harness({ subscribers: { [idA]: subscriber(TOKEN_A, ["NEL", "EWL"]) } });
  await h.run(alerts(nel(), { Line: "EWL", Direction: "Both", Stations: "EW1,EW2" }));
  h.calls.length = 0;
  await h.run(alerts(nel()), SGT_NOON + 60_000);
  assert.equal(h.calls.length, 0);
  await h.run(alerts(nel()), SGT_NOON + 120_000);
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
  const h = harness({ subscribers: { [idA]: subscriber(TOKEN_A, ["NEL"]) }, status: () => ({ status: 400, reason: "PayloadEmpty" }) });
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

function many(count, lines = ["NEL"]) {
  const subscribers = {};
  const tokens = [];
  for (let n = 1; n <= count; n++) {
    const token = n.toString(16).padStart(4, "0").repeat(16);
    tokens.push(token);
    subscribers[subscriberId(token)] = subscriber(token, lines);
  }
  return { subscribers, tokens };
}

test("the new state is written before any push is sent", async () => {
  const seen = [];
  const h = harness({ subscribers: { [idA]: subscriber(TOKEN_A, ["NEL"]), [idB]: subscriber(TOKEN_B, ["NEL"], { from: 11 * 60, to: 13 * 60 }) } });
  const send = h.calls.push.bind(h.calls);
  h.calls.push = (push) => {
    seen.push(structuredClone(h.stateRef.data.NEL));
    return send(push);
  };
  await h.run(alerts(nel()));
  assert.equal(seen.length, 1);
  assert.deepEqual(seen[0].notified, { [idA]: true });
  assert.deepEqual(seen[0].pending, { [idB]: true });
});

test("a run that dies after sending does not push disrupted again", async () => {
  const h = harness({
    subscribers: { [idA]: subscriber(TOKEN_A, ["NEL"]), [idB]: subscriber(TOKEN_B, ["NEL"]) },
    status: (push) => (push.token === TOKEN_B ? { status: 410, reason: "Unregistered" } : { status: 200, reason: null }),
  });
  h.subscribersRef.update = async () => { throw new Error("timeout"); };
  await assert.rejects(h.run(alerts(nel())), /timeout/);
  assert.equal(h.calls.length, 2);
  assert.deepEqual(h.stateRef.data.NEL.notified, { [idA]: true, [idB]: true });
  await h.run(alerts(nel()), SGT_NOON + MINUTE);
  assert.equal(h.calls.length, 2);
});

test("dead tokens go in one multi-path update and leave every line's state", async () => {
  const { subscribers, tokens } = many(4, ["NEL", "EWL"]);
  const live = tokens[0];
  const h = harness({
    subscribers,
    status: (push) => (push.token === live ? { status: 200, reason: null } : { status: 410, reason: "Unregistered" }),
  });
  const result = await h.run(alerts(nel(), { Line: "EWL", Direction: "Both", Stations: "EW1" }));
  assert.equal(h.updates.length, 1);
  assert.deepEqual(Object.keys(h.updates[0]).sort(), tokens.slice(1).map(subscriberId).sort());
  assert.ok(Object.values(h.updates[0]).every((value) => value === null));
  assert.deepEqual(Object.keys(h.subscribersRef.data), [subscriberId(live)]);
  assert.equal(result.removed, 3);
  assert.deepEqual(h.stateRef.data.NEL.notified, { [subscriberId(live)]: true });
  assert.deepEqual(h.stateRef.data.EWL.notified, { [subscriberId(live)]: true });
});

test("a run sends to at most the per-line limit and carries the rest over as pending", async () => {
  const { subscribers, tokens } = many(5);
  const h = harness({ subscribers, limit: 2 });
  const first = await h.run(alerts(nel()));
  assert.equal(first.disrupted, 2);
  assert.equal(h.calls.length, 2);
  assert.equal(Object.keys(h.stateRef.data.NEL.notified).length, 2);
  assert.equal(Object.keys(h.stateRef.data.NEL.pending).length, 3);
  await h.run(alerts(nel()), SGT_NOON + MINUTE);
  await h.run(alerts(nel()), SGT_NOON + 2 * MINUTE);
  assert.deepEqual(h.calls.map((call) => call.token).sort(), [...tokens].sort());
  assert.equal(h.stateRef.data.NEL.pending, undefined);
  assert.equal((await h.run(alerts(nel()), SGT_NOON + 3 * MINUTE)).idle, true);
});

test("the default per-line limit is 5000", async () => {
  const { subscribers } = many(5003);
  const h = harness({ subscribers });
  const result = await h.run(alerts(nel()), SGT_NOON);
  assert.equal(result.sent, 5000);
  assert.equal(Object.keys(h.stateRef.data.NEL.pending).length, 3);
});

test("back to normal respects the per-line limit too", async () => {
  const { subscribers, tokens } = many(5);
  const h = harness({ subscribers, limit: 2 });
  for (let n = 0; n < 3; n++) await h.run(alerts(nel()), SGT_NOON + n * MINUTE);
  h.calls.length = 0;
  const at = SGT_NOON + 10 * MINUTE;
  await h.run(NORMAL, at);
  const second = await h.run(NORMAL, at + MINUTE);
  assert.equal(second.normal, 2);
  assert.equal(Object.keys(h.stateRef.data.NEL.recovered).length, 3);
  await h.run(NORMAL, at + 2 * MINUTE);
  await h.run(NORMAL, at + 3 * MINUTE);
  assert.deepEqual(h.calls.map((call) => call.token).sort(), [...tokens].sort());
  assert.deepEqual(h.stateRef.data, {});
});

test("people in quiet hours at the end of a disruption are owed back to normal until it can be sent", async () => {
  const night = { from: 22 * 60, to: 7 * 60 };
  const h = harness({ subscribers: { [idA]: subscriber(TOKEN_A, ["NEL"]), [idB]: subscriber(TOKEN_B, ["NEL"]) } });
  await h.run(alerts(nel()), SGT_2330 - 60 * MINUTE);
  h.calls.length = 0;
  h.subscribersRef.data[idA].quiet = night;
  await h.run(NORMAL, SGT_2330);
  const cleared = await h.run(NORMAL, SGT_2330 + MINUTE);
  assert.equal(cleared.normal, 1);
  assert.deepEqual(h.calls.map((call) => call.token), [TOKEN_B]);
  assert.deepEqual(h.stateRef.data, { NEL: { since: SGT_2330 - 60 * MINUTE, recovered: { [idA]: true } } });

  const stillQuiet = await h.run(NORMAL, SGT_2330 + 2 * MINUTE);
  assert.equal(stillQuiet.idle, undefined);
  assert.equal(stillQuiet.sent, 0);
  assert.equal(h.calls.length, 1);

  await h.run(NORMAL, MORNING);
  assert.deepEqual(h.calls.map((call) => call.token), [TOKEN_B, TOKEN_A]);
  assert.equal(h.calls[1].payload.kind, "normal");
  assert.deepEqual(h.stateRef.data, {});
  assert.equal((await h.run(NORMAL, MORNING + MINUTE)).idle, true);
});

test("a retryable failure on back to normal keeps the person owed until it goes through", async () => {
  let reason = { status: 503, reason: "ServiceUnavailable" };
  const h = harness({
    subscribers: { [idA]: subscriber(TOKEN_A, ["NEL"]) },
    status: (push) => (push.payload.kind === "normal" ? reason : { status: 200, reason: null }),
  });
  await h.run(alerts(nel()));
  await clearTwice(h);
  assert.deepEqual(h.stateRef.data.NEL.recovered, { [idA]: true });
  for (const failing of [{ status: 429, reason: "TooManyRequests" }, { status: 0, reason: "socket hang up" }, { status: 403, reason: "ExpiredProviderToken" }]) {
    reason = failing;
    await h.run(NORMAL, SGT_NOON + 10 * MINUTE);
    assert.deepEqual(h.stateRef.data.NEL.recovered, { [idA]: true });
  }
  reason = { status: 200, reason: null };
  await h.run(NORMAL, SGT_NOON + 11 * MINUTE);
  assert.deepEqual(h.stateRef.data, {});
  assert.equal(h.calls.filter((call) => call.payload.kind === "normal").length, 5);
});

test("a permanent failure on back to normal is not retried", async () => {
  const h = harness({
    subscribers: { [idA]: subscriber(TOKEN_A, ["NEL"]) },
    status: (push) => (push.payload.kind === "normal" ? { status: 400, reason: "PayloadEmpty" } : { status: 200, reason: null }),
  });
  await h.run(alerts(nel()));
  await clearTwice(h);
  assert.deepEqual(h.stateRef.data, {});
  assert.equal(h.calls.length, 2);
});

test("someone owed back to normal who unsubscribes or dies is dropped", async () => {
  const night = { from: 22 * 60, to: 7 * 60 };
  const h = harness({ subscribers: { [idA]: subscriber(TOKEN_A, ["NEL"]), [idB]: subscriber(TOKEN_B, ["NEL"]) } });
  await h.run(alerts(nel()), SGT_2330 - 60 * MINUTE);
  h.subscribersRef.data[idA].quiet = night;
  h.subscribersRef.data[idB].quiet = night;
  await h.run(NORMAL, SGT_2330);
  await h.run(NORMAL, SGT_2330 + MINUTE);
  assert.deepEqual(h.stateRef.data.NEL.recovered, { [idA]: true, [idB]: true });
  h.subscribersRef.data[idA].lines = ["EWL"];
  delete h.subscribersRef.data[idB];
  await h.run(NORMAL, SGT_2330 + 2 * MINUTE);
  assert.deepEqual(h.stateRef.data, {});
  assert.equal(h.calls.length, 2);
});

test("a dead token owed back to normal leaves the state and the subscribers", async () => {
  const h = harness({
    subscribers: { [idA]: subscriber(TOKEN_A, ["NEL"]) },
    status: (push) => (push.payload.kind === "normal" ? { status: 410, reason: "Unregistered" } : { status: 200, reason: null }),
  });
  await h.run(alerts(nel()));
  await clearTwice(h);
  assert.deepEqual(h.stateRef.data, {});
  assert.deepEqual(h.subscribersRef.data, {});
});

test("if the line is disrupted again, people owed back to normal get the new disrupted push instead", async () => {
  const night = { from: 22 * 60, to: 7 * 60 };
  const h = harness({ subscribers: {
    [idA]: subscriber(TOKEN_A, ["NEL"]),
    [idB]: subscriber(TOKEN_B, ["NEL"]),
    [idC]: subscriber(TOKEN_C, ["NEL"]),
  } });
  await h.run(alerts(nel()), SGT_2330 - 60 * MINUTE);
  h.subscribersRef.data[idA].quiet = night;
  h.subscribersRef.data[idB].quiet = night;
  await h.run(NORMAL, SGT_2330);
  await h.run(NORMAL, SGT_2330 + MINUTE);
  assert.deepEqual(h.stateRef.data.NEL.recovered, { [idA]: true, [idB]: true });
  h.calls.length = 0;
  h.subscribersRef.data[idA].quiet = null;
  h.subscribersRef.data[idB].lines = ["EWL"];
  await h.run(alerts(nel()), SGT_2330 + 2 * MINUTE);
  assert.deepEqual(h.calls.map((call) => [call.token, call.payload.kind]), [[TOKEN_A, "disrupted"], [TOKEN_C, "disrupted"]]);
  const entry = h.stateRef.data.NEL;
  assert.equal(entry.recovered, undefined);
  assert.equal(entry.since, SGT_2330 + 2 * MINUTE);
  assert.deepEqual(entry.notified, { [idA]: true, [idC]: true });
  assert.equal((await h.run(alerts(nel()), SGT_2330 + 3 * MINUTE)).idle, true);
});

test("someone owed back to normal stays owed while the new disrupted push is held in quiet hours", async () => {
  const night = { from: 22 * 60, to: 7 * 60 };
  const h = harness({ subscribers: { [idA]: subscriber(TOKEN_A, ["NEL"]) } });
  await h.run(alerts(nel()), SGT_2330 - 60 * MINUTE);
  h.subscribersRef.data[idA].quiet = night;
  await h.run(NORMAL, SGT_2330);
  await h.run(NORMAL, SGT_2330 + MINUTE);
  h.calls.length = 0;
  await h.run(alerts(nel()), SGT_2330 + 2 * MINUTE);
  assert.equal(h.calls.length, 0);
  assert.deepEqual(h.stateRef.data.NEL.recovered, { [idA]: true });
  assert.deepEqual(h.stateRef.data.NEL.pending, { [idA]: true });
  await h.run(NORMAL, SGT_2330 + 3 * MINUTE);
  await h.run(NORMAL, SGT_2330 + 4 * MINUTE);
  assert.equal(h.calls.length, 0);
  assert.deepEqual(h.stateRef.data.NEL.recovered, { [idA]: true });
  await h.run(NORMAL, MORNING);
  assert.deepEqual(h.calls.map((call) => call.payload.kind), ["normal"]);
  assert.deepEqual(h.stateRef.data, {});
});

test("an unchanged disruption is not idle while someone is still owed back to normal", async () => {
  const night = { from: 22 * 60, to: 7 * 60 };
  const h = harness({ subscribers: { [idA]: subscriber(TOKEN_A, ["NEL"]) }, state: { NEL: { since: 1, recovered: { [idA]: true } } } });
  h.subscribersRef.data[idA].quiet = night;
  const result = await h.run(NORMAL, SGT_2330);
  assert.equal(result.idle, undefined);
  assert.equal(h.subscriberReads(), 1);
});

test("a brief all-clear does not send back to normal or disrupted again", async () => {
  const h = harness({ subscribers: { [idA]: subscriber(TOKEN_A, ["NEL"]) } });
  await h.run(alerts(nel()));
  const once = await h.run(NORMAL, SGT_NOON + MINUTE);
  assert.equal(once.sent, 0);
  assert.equal(h.stateRef.data.NEL.clear, 1);
  const back = await h.run(alerts(nel()), SGT_NOON + 2 * MINUTE);
  assert.equal(back.sent, 0);
  assert.equal(h.calls.length, 1);
  assert.equal(h.stateRef.data.NEL.clear, undefined);
  assert.equal(h.stateRef.data.NEL.since, SGT_NOON);
  assert.equal((await h.run(alerts(nel()), SGT_NOON + 3 * MINUTE)).idle, true);
  await h.run(NORMAL, SGT_NOON + 4 * MINUTE);
  await h.run(NORMAL, SGT_NOON + 5 * MINUTE);
  assert.deepEqual(h.calls.map((call) => call.payload.kind), ["disrupted", "normal"]);
});

test("a feed that skips a run does not count towards the all-clear", async () => {
  const h = harness({ subscribers: { [idA]: subscriber(TOKEN_A, ["NEL"]) } });
  await h.run(alerts(nel()));
  await h.run(NORMAL, SGT_NOON + MINUTE);
  await h.run(new Error("LTA 503"), SGT_NOON + 2 * MINUTE);
  assert.equal(h.calls.length, 1);
  await h.run(NORMAL, SGT_NOON + 3 * MINUTE);
  assert.equal(h.calls.length, 2);
});

test("a flap that returns with a changed direction notifies about the change", async () => {
  const h = harness({ subscribers: { [idA]: subscriber(TOKEN_A, ["NEL"]) } });
  await h.run(alerts(nel()));
  await h.run(NORMAL, SGT_NOON + MINUTE);
  await h.run(alerts(nel({ Direction: "HarbourFront" })), SGT_NOON + 2 * MINUTE);
  assert.equal(h.calls.length, 2);
  assert.equal(h.calls[1].payload.kind, "disrupted");
});

test("alert pushes collapse per line so a newer one replaces the older", async () => {
  const h = harness({ subscribers: { [idA]: subscriber(TOKEN_A, ["NEL", "EWL"]) } });
  await h.run(alerts(nel(), { Line: "EWL", Direction: "Both", Stations: "EW1" }));
  await clearTwice(h);
  const ids = Object.fromEntries(h.calls.map((call) => [`${call.payload.line} ${call.payload.kind}`, call.headers["apns-collapse-id"]]));
  assert.deepEqual(ids, {
    "NEL disrupted": "service-alert-NEL", "EWL disrupted": "service-alert-EWL",
    "NEL normal": "service-alert-NEL", "EWL normal": "service-alert-EWL",
  });
});

test("provider token errors are retried and other failures are counted by reason in one warning", async () => {
  const { subscribers, tokens } = many(7);
  const outcomes = [
    { status: 403, reason: "InvalidProviderToken" },
    { status: 403, reason: "ExpiredProviderToken" },
    { status: 400, reason: "PayloadEmpty" },
    { status: 400, reason: "PayloadEmpty" },
    { status: 503, reason: null },
    { status: 410, reason: "Unregistered" },
    { status: 200, reason: null },
  ];
  const h = harness({ subscribers, status: (push) => outcomes[tokens.indexOf(push.token)] });
  const warnings = [];
  const infos = [];
  const result = await tick({
    fetchAlerts: async () => alerts(nel()),
    stateRef: h.stateRef, subscribersRef: h.subscribersRef,
    apns: { send: async (push) => { h.calls.push(push); return outcomes[tokens.indexOf(push.token)]; } },
    now: () => SGT_NOON,
    log: { warn: (line) => warnings.push(line), info: (line) => infos.push(line) },
  });
  assert.deepEqual(result.failures, { InvalidProviderToken: 1, ExpiredProviderToken: 1, PayloadEmpty: 2, "HTTP 503": 1 });
  assert.equal(result.removed, 1);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /5\/7/);
  assert.equal(infos.length, 0);
  assert.equal(JSON.stringify([warnings, result]).includes(tokens[0]), false);
  assert.deepEqual(Object.keys(h.stateRef.data.NEL.pending).sort(), [tokens[0], tokens[1], tokens[4]].map(subscriberId).sort());
});

test("a clean run logs no warning and reports no failures", async () => {
  const h = harness({ subscribers: { [idA]: subscriber(TOKEN_A, ["NEL"]) } });
  const warnings = [];
  const result = await tick({
    fetchAlerts: async () => alerts(nel()), stateRef: h.stateRef, subscribersRef: h.subscribersRef,
    apns: { send: async () => ({ status: 200, reason: null }) }, now: () => SGT_NOON, log: { warn: (line) => warnings.push(line) },
  });
  assert.deepEqual(result.failures, {});
  assert.deepEqual(warnings, []);
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

test("APNs passes extra headers on alert pushes only when given", async (t) => {
  const requests = fakeHTTP2(t);
  const { privateKey } = crypto.generateKeyPairSync("ec", { namedCurve: "P-256", privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } });
  const apns = new APNs({ key: privateKey, keyId: "KEYAH", teamId: "TEAMAH", topic: "sg.com.example.App.push-type.liveactivity" });
  await apns.send({ token: "ab".repeat(32), environment: "sandbox", payload: { aps: {} }, priority: 10, pushType: "alert", headers: { "apns-collapse-id": "service-alert-NEL" } });
  await apns.send({ token: "ab".repeat(32), environment: "sandbox", payload: { aps: {} }, priority: 10, pushType: "alert" });
  apns.close();
  assert.equal(requests[0].headers["apns-collapse-id"], "service-alert-NEL");
  assert.equal(requests[0].headers["apns-topic"], "sg.com.example.App");
  assert.equal("apns-collapse-id" in requests[1].headers, false);
});

test("a failed re-push for a changed direction still leaves the person owed back to normal", async () => {
  let failing = false;
  const h = harness({
    subscribers: { [idA]: subscriber(TOKEN_A, ["NEL"]) },
    status: (push) => (failing && push.payload.kind === "disrupted" ? { status: 503, reason: null } : { status: 200, reason: null }),
  });
  await h.run(alerts(nel()));
  failing = true;
  await h.run(alerts(nel({ Direction: "HarbourFront" })), SGT_NOON + MINUTE);
  assert.deepEqual(h.stateRef.data.NEL.notified, { [idA]: true });
  assert.deepEqual(h.stateRef.data.NEL.pending, { [idA]: true });
  failing = false;
  h.calls.length = 0;
  await clearTwice(h, SGT_NOON + 2 * MINUTE);
  assert.deepEqual(h.calls.map((call) => call.payload.kind), ["normal"]);
  assert.deepEqual(h.stateRef.data, {});
});

test("a failed new disrupted push keeps someone owed back to normal", async () => {
  const night = { from: 22 * 60, to: 7 * 60 };
  let failing = false;
  const h = harness({
    subscribers: { [idA]: subscriber(TOKEN_A, ["NEL"]) },
    status: (push) => (failing && push.payload.kind === "disrupted" ? { status: 503, reason: null } : { status: 200, reason: null }),
  });
  await h.run(alerts(nel()), SGT_2330 - 60 * MINUTE);
  h.subscribersRef.data[idA].quiet = night;
  await h.run(NORMAL, SGT_2330);
  await h.run(NORMAL, SGT_2330 + MINUTE);
  assert.deepEqual(h.stateRef.data.NEL.recovered, { [idA]: true });
  h.subscribersRef.data[idA].quiet = null;
  failing = true;
  await h.run(alerts(nel()), SGT_2330 + 2 * MINUTE);
  assert.deepEqual(h.stateRef.data.NEL.pending, { [idA]: true });
  assert.deepEqual(h.stateRef.data.NEL.recovered, { [idA]: true });
  failing = false;
  h.calls.length = 0;
  await clearTwice(h, SGT_2330 + 3 * MINUTE);
  assert.deepEqual(h.calls.map((call) => call.payload.kind), ["normal"]);
  assert.deepEqual(h.stateRef.data, {});
});

test("a permanently rejected first disrupted push is not followed by a back to normal", async () => {
  const h = harness({
    subscribers: { [idA]: subscriber(TOKEN_A, ["NEL"]) },
    status: (push) => (push.payload.kind === "disrupted" ? { status: 400, reason: "PayloadEmpty" } : { status: 200, reason: null }),
  });
  await h.run(alerts(nel()));
  assert.equal(h.stateRef.data.NEL.notified, undefined);
  await clearTwice(h);
  assert.equal(h.calls.length, 1);
  assert.deepEqual(h.stateRef.data, {});
});

test("a send that throws is treated as a retryable failure", async () => {
  const h = harness({ subscribers: { [idA]: subscriber(TOKEN_A, ["NEL"]) } });
  const result = await tick({
    fetchAlerts: async () => alerts(nel()), stateRef: h.stateRef, subscribersRef: h.subscribersRef,
    apns: { send: async () => { throw new Error("socket closed"); } },
    now: () => SGT_NOON, log: silent,
  });
  assert.deepEqual(result.failures, { "socket closed": 1 });
  assert.deepEqual(h.stateRef.data.NEL.pending, { [idA]: true });
});
