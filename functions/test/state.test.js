const test = require("node:test");
const assert = require("node:assert/strict");
const { next, appleDate } = require("../src/state");
const { payloadFor, isGone } = require("../src/apns");
const { pollRound } = require("../src/poller");

const now = Date.parse("2026-11-02T08:00:00Z");
const iso = (ms) => new Date(ms).toISOString().replace("Z", "+00:00");
const bus = (ms, extra = {}) => ({ EstimatedArrival: iso(ms), Load: "SEA", Type: "SD", ...extra });
const registration = (extra = {}) => ({
  token: "ab".repeat(32),
  service: "15",
  stopCode: "83139",
  environment: "sandbox",
  tracked: now + 300_000,
  since: now - 60_000,
  createdAt: now - 60_000,
  ...extra,
});

test("dates use Apple's reference epoch", () => {
  assert.equal(appleDate(Date.parse("2001-01-01T00:00:00Z")), 0);
});

test("first poll pushes the bus nearest to the tracked one", () => {
  const result = next(registration(), { NextBus: bus(now + 120_000), NextBus2: bus(now + 320_000, { Load: "SDA", Type: "DD" }), NextBus3: bus(now + 900_000) }, now);
  assert.equal(result.action, "update");
  assert.equal(result.tracked, now + 320_000);
  assert.deepEqual(result.contentState, {
    since: appleDate(now - 60_000),
    hasArrived: false,
    arrival: appleDate(now + 320_000),
    following: appleDate(now + 900_000),
    load: "SDA",
    vehicle: "DD",
  });
});

test("small shifts are not pushed until the re-push interval", () => {
  const last = { arrival: now + 300_000, following: null, load: "SEA", vehicle: "SD" };
  const service = { NextBus: bus(now + 303_000) };
  assert.equal(next(registration({ last, lastPushAt: now - 30_000 }), service, now).action, "none");
  assert.equal(next(registration({ last, lastPushAt: now - 130_000 }), service, now).action, "update");
  assert.equal(next(registration({ last, lastPushAt: now - 30_000 }), { NextBus: bus(now + 330_000) }, now).action, "update");
});

test("ends as arrived when the tracked bus drops off the board", () => {
  const result = next(registration({ tracked: now + 20_000 }), { NextBus: bus(now + 600_000) }, now);
  assert.equal(result.action, "end");
  assert.equal(result.contentState.hasArrived, true);
  assert.equal(result.contentState.arrival, appleDate(now + 20_000));
  assert.equal(result.dismissalDate, now + 120_000);
});

test("ends as arrived when the service disappears near arrival, waits otherwise", () => {
  assert.equal(next(registration({ tracked: now + 30_000 }), undefined, now).action, "end");
  assert.equal(next(registration(), undefined, now).action, "none");
});

test("ends stale registrations", () => {
  const result = next(registration({ createdAt: now - 3 * 3600_000 }), { NextBus: bus(now + 300_000) }, now);
  assert.equal(result.action, "end");
  assert.equal(result.dismissalDate, now);
  assert.equal(result.contentState.hasArrived, false);
});

test("payload follows ActivityKit's push format", () => {
  const payload = payloadFor({ action: "update", contentState: { since: 1, hasArrived: false }, staleDate: now + 180_000 }, now);
  assert.deepEqual(payload, { aps: { timestamp: now / 1000, event: "update", "content-state": { since: 1, hasArrived: false }, "stale-date": now / 1000 + 180 } });
});

test("gone tokens are recognised", () => {
  assert.ok(isGone({ status: 410 }));
  assert.ok(isGone({ status: 400, reason: "BadDeviceToken" }));
  assert.ok(!isGone({ status: 429, reason: "TooManyRequests" }));
});

function memoryRef(data) {
  const ref = {
    data,
    async get() {
      return { val: () => (Object.keys(ref.data).length ? structuredClone(ref.data) : null) };
    },
    child(id) {
      return {
        update: async (values) => Object.assign(ref.data[id], values),
        remove: async () => delete ref.data[id],
      };
    },
  };
  return ref;
}

test("one LTA call per stop, pushes fan out per activity", async () => {
  const ref = memoryRef({
    a: registration(),
    b: registration({ service: "16" }),
    c: registration({ stopCode: "01012", tracked: now + 10_000 }),
  });
  const calls = [];
  const pushes = [];
  const stats = await pollRound({
    ref,
    accountKey: "k",
    apns: { send: async (push) => { pushes.push(push); return { status: push.id === "b" ? 410 : 200 }; } },
    fetcher: async (stop) => {
      calls.push(stop);
      return stop === "83139"
        ? [{ ServiceNo: "15", NextBus: bus(now + 290_000) }, { ServiceNo: "16", NextBus: bus(now + 310_000) }]
        : [{ ServiceNo: "15", NextBus: bus(now + 700_000) }];
    },
    now: () => now,
  });
  assert.deepEqual(calls.sort(), ["01012", "83139"]);
  assert.equal(pushes.length, 3);
  assert.deepEqual(Object.keys(ref.data), ["a"]);
  assert.equal(ref.data.a.tracked, now + 290_000);
  assert.equal(stats.removed, 1);
  assert.equal(stats.ends, 1);
});

test("an LTA failure skips the stop instead of ending its activities", async () => {
  const ref = memoryRef({ a: registration({ tracked: now + 10_000 }) });
  const stats = await pollRound({ ref, accountKey: "k", apns: { send: async () => assert.fail() }, fetcher: async () => { throw new Error("down"); }, now: () => now, log: {} });
  assert.equal(stats.ltaErrors, 1);
  assert.ok(ref.data.a);
});
