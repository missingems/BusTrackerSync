const test = require("node:test");
const assert = require("node:assert/strict");
const { next, appleDate, staleDate, FAR_POLL } = require("../src/state");
const crypto = require("node:crypto");
const { APNs, payloadFor, isGone } = require("../src/apns");
const { pollRound, pollFor } = require("../src/poller");

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

test("pushes the earliest bus with the one after it", () => {
  const result = next(registration(), { NextBus: bus(now + 120_000), NextBus2: bus(now + 320_000, { Load: "SDA", Type: "DD" }), NextBus3: bus(now + 900_000) }, now);
  assert.equal(result.action, "update");
  assert.equal(result.tracked, now + 120_000);
  assert.deepEqual(result.contentState, {
    since: appleDate(now - 60_000),
    hasArrived: false,
    arrival: appleDate(now + 120_000),
    following: appleDate(now + 320_000),
    load: "SEA",
    vehicle: "SD",
  });
});

test("small shifts are not pushed until the re-push interval", () => {
  const last = { arrival: now + 300_000, following: null, load: "SEA", vehicle: "SD" };
  const service = { NextBus: bus(now + 303_000) };
  assert.equal(next(registration({ last, lastPushAt: now - 30_000 }), service, now).action, "none");
  assert.equal(next(registration({ last, lastPushAt: now - 130_000 }), service, now).action, "update");
  assert.equal(next(registration({ last, lastPushAt: now - 30_000 }), { NextBus: bus(now + 330_000) }, now).action, "update");
});

test("pushes when the minutes shown would change, so the Live Activity matches the app", () => {
  const last = { arrival: now + 300_000, following: null, load: "SEA", vehicle: "SD" };
  const service = { NextBus: bus(now + 300_000) };
  assert.equal(next(registration({ last, lastPushAt: now - 50_000 }), service, now).action, "none");
  assert.equal(next(registration({ last, lastPushAt: now - 70_000 }), service, now).action, "update");
  const final = { ...last, arrival: now + 50_000 };
  assert.equal(next(registration({ last: final, lastPushAt: now - 20_000, tracked: now + 50_000 }), { NextBus: bus(now + 50_000) }, now).action, "update");
  assert.equal(next(registration({ last: final, lastPushAt: now - 5_000, tracked: now + 50_000 }), { NextBus: bus(now + 50_000) }, now).action, "none");
});

test("pushes urgently once the bus reaches its arrival time, so the activity shows it has arrived", () => {
  const last = { arrival: now - 5_000, following: null, load: "SEA", vehicle: "SD" };
  const service = { NextBus: bus(now - 5_000) };
  const reached = next(registration({ last, lastPushAt: now - 70_000, tracked: now - 5_000 }), service, now);
  assert.equal(reached.action, "update");
  assert.equal(reached.urgent, true);
  assert.equal(next(registration({ last, lastPushAt: now - 3_000, tracked: now - 5_000 }), service, now).action, "none");
  const ahead = { ...last, arrival: now + 15_000 };
  assert.equal(next(registration({ last: ahead, lastPushAt: now - 40_000, tracked: now + 15_000 }), { NextBus: bus(now + 15_000) }, now).action, "none");
});

test("updates that change the minutes shown go out urgently, others don't", () => {
  const last = { arrival: now + 300_000, following: null, load: "SEA", vehicle: "SD" };
  assert.equal(next(registration({ last, lastPushAt: now - 70_000 }), { NextBus: bus(now + 300_000) }, now).urgent, true);
  assert.equal(next(registration({ last, lastPushAt: now - 30_000 }), { NextBus: bus(now + 245_000) }, now).urgent, true);
  assert.equal(next(registration({ last, lastPushAt: now - 30_000 }), { NextBus: bus(now + 303_000) }, now).urgent, false);
  assert.equal(next(registration({ last, lastPushAt: now - 30_000 }), { NextBus: bus(now + 303_000, { Load: "SDA" }) }, now).urgent, false);
});

test("moves on to the next bus once the first one has gone", () => {
  const result = next(registration({ tracked: now + 20_000 }), { NextBus: bus(now + 600_000) }, now);
  assert.equal(result.action, "update");
  assert.equal(result.tracked, now + 600_000);
  assert.equal(result.contentState.hasArrived, false);
});

test("a bus that drops off the board shows again as soon as it reappears", () => {
  const result = next(registration({ tracked: now + 740_000 }), { NextBus: bus(now + 60_000), NextBus2: bus(now + 740_000), NextBus3: bus(now + 1_520_000) }, now);
  assert.equal(result.tracked, now + 60_000);
  assert.equal(result.contentState.following, appleDate(now + 740_000));
});

test("a bus that left more than 30 s ago is skipped", () => {
  assert.equal(next(registration({ tracked: now - 20_000 }), { NextBus: bus(now - 20_000), NextBus2: bus(now + 600_000) }, now).tracked, now - 20_000);
  assert.equal(next(registration({ tracked: now - 40_000 }), { NextBus: bus(now - 40_000), NextBus2: bus(now + 600_000) }, now).tracked, now + 600_000);
});

test("a due bus whose estimate slips by a minute is still shown", () => {
  assert.equal(next(registration({ tracked: now + 10_000 }), { NextBus: bus(now + 70_000) }, now).tracked, now + 70_000);
});

test("ends as arrived when the service disappears near arrival, waits otherwise", () => {
  assert.equal(next(registration({ tracked: now + 30_000 }), undefined, now).action, "end");
  assert.equal(next(registration(), undefined, now).action, "none");
});

test("a Live Activity ends after 30 minutes", () => {
  const service = { NextBus: bus(now + 300_000) };
  assert.equal(next(registration({ createdAt: now - 29 * 60_000 }), service, now).action, "update");
  assert.equal(next(registration({ createdAt: now - 31 * 60_000 }), service, now).action, "end");
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
        remove: async () => delete ref.data[id],
        transaction: async (update) => {
          await ref.beforeWrite?.(id);
          const result = update(ref.data[id] ? structuredClone(ref.data[id]) : null);
          if (result === undefined) return;
          if (result === null) delete ref.data[id];
          else ref.data[id] = result;
        },
      };
    },
  };
  return ref;
}

test("one LTA call per stop, pushes fan out per activity", async () => {
  const ref = memoryRef({
    a: registration(),
    b: registration({ service: "16" }),
    c: registration({ stopCode: "01012", createdAt: now - 31 * 60_000 }),
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

test("missing optional fields read back from the database don't count as changes", () => {
  const last = { arrival: now + 300_000 };
  const result = next(registration({ last, lastPushAt: now - 30_000 }), { NextBus: { EstimatedArrival: iso(now + 302_000) } }, now);
  assert.equal(result.action, "none");
});

test("a registration deleted mid-round is not recreated", async () => {
  const ref = memoryRef({ a: registration() });
  ref.beforeWrite = async (id) => delete ref.data[id];
  await pollRound({ ref, accountKey: "k", apns: { send: async () => ({ status: 200 }) }, fetcher: async () => [{ ServiceNo: "15", NextBus: bus(now + 290_000) }], now: () => now });
  assert.deepEqual(ref.data, {});
});

test("a re-registration with a new token mid-round is kept", async () => {
  const ref = memoryRef({ a: registration({ tracked: now + 10_000 }) });
  ref.beforeWrite = async (id) => { ref.data[id].token = "cd".repeat(32); };
  await pollRound({ ref, accountKey: "k", apns: { send: async () => ({ status: 200 }) }, fetcher: async () => [], now: () => now });
  assert.equal(ref.data.a.token, "cd".repeat(32));
});

test("a failed end push is retried, then given up", async () => {
  const ref = memoryRef({ a: registration({ tracked: now + 10_000 }) });
  const options = { ref, accountKey: "k", apns: { send: async () => ({ status: 503, reason: "ServiceUnavailable" }) }, fetcher: async () => [], now: () => now, log: {} };
  await pollRound(options);
  assert.equal(ref.data.a.endAttempts, 1);
  await pollRound(options);
  await pollRound(options);
  assert.deepEqual(ref.data, {});
});

test("malformed registrations are removed without calling LTA", async () => {
  const ref = memoryRef({ a: { tracked: now } });
  const stats = await pollRound({ ref, accountKey: "k", apns: {}, fetcher: async () => assert.fail(), now: () => now });
  assert.equal(stats.removed, 1);
  assert.deepEqual(ref.data, {});
});

test("LTA calls are capped in flight", async () => {
  const data = {};
  for (let i = 0; i < 60; i++) data[`id-${i}`] = registration({ stopCode: String(10000 + i) });
  let inFlight = 0;
  let peak = 0;
  await pollRound({
    ref: memoryRef(data),
    accountKey: "k",
    apns: { send: async () => ({ status: 200 }) },
    fetcher: async () => {
      peak = Math.max(peak, ++inFlight);
      await new Promise((resolve) => setTimeout(resolve, 2));
      inFlight -= 1;
      return [];
    },
    now: () => now,
  });
  assert.ok(peak <= 24, `peak ${peak}`);
});

test("stops that waited longest are polled first", async () => {
  const data = {
    "id-recent": registration({ stopCode: "10001", lastPushAt: now - 5_000 }),
    "id-new": registration({ stopCode: "10002" }),
    "id-old": registration({ stopCode: "10003", lastPushAt: now - 60_000 }),
  };
  const order = [];
  await pollRound({
    ref: memoryRef(data),
    accountKey: "k",
    apns: { send: async () => ({ status: 200 }) },
    fetcher: async (stopCode) => {
      order.push(stopCode);
      return [];
    },
    now: () => now,
  });
  assert.deepEqual(order, ["10002", "10003", "10001"]);
});

test("the APNs token is reused across clients within a 30-minute window", () => {
  const { privateKey } = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
  const make = () => new APNs({ key: privateKey, keyId: "KEY", teamId: "TEAM", topic: "t" });
  const start = Date.parse("2026-11-02T08:00:00Z");
  const first = make().token(start + 1000);
  assert.equal(make().token(start + 29 * 60_000), first);
  const later = make().token(start + 31 * 60_000);
  assert.notEqual(later, first);
  const iat = JSON.parse(Buffer.from(later.split(".")[1], "base64url")).iat;
  assert.equal(iat, (start + 30 * 60_000) / 1000);
});

test("the stale date only marks three minutes without a push", () => {
  const now = Date.UTC(2026, 0, 1);
  assert.equal(staleDate(now), now + 180_000);
});

test("a bus more than ten minutes away is polled less often", () => {
  const far = next(registration({ tracked: now + 900_000 }), { NextBus: bus(now + 900_000) }, now);
  assert.equal(far.nextPollAt, now + FAR_POLL);
  const close = next(registration(), { NextBus: bus(now + 300_000) }, now);
  assert.equal(close.nextPollAt, now);
});

test("a far registration waits for its next poll without calling LTA", async () => {
  const ref = memoryRef({ a: registration({ nextPollAt: now + 30_000 }) });
  const stats = await pollRound({ ref, accountKey: "k", apns: { send: async () => assert.fail() }, fetcher: async () => assert.fail(), now: () => now });
  assert.equal(stats.waiting, 1);
  assert.equal(stats.soonest, now + 30_000);
});

test("polling a far bus schedules its next poll, and a close bus clears it", async () => {
  const ref = memoryRef({ a: registration({ tracked: now + 900_000 }) });
  const options = { ref, accountKey: "k", apns: { send: async () => ({ status: 200 }) }, now: () => now };
  const stats = await pollRound({ ...options, fetcher: async () => [{ ServiceNo: "15", NextBus: bus(now + 900_000) }] });
  assert.equal(ref.data.a.nextPollAt, now + FAR_POLL);
  assert.equal(stats.soonest, now + FAR_POLL);
  ref.data.a.nextPollAt = now;
  await pollRound({ ...options, fetcher: async () => [{ ServiceNo: "15", NextBus: bus(now + 300_000) }] });
  assert.equal(ref.data.a.nextPollAt, null);
});

test("the poller stops early when every bus is far away", async () => {
  const ref = memoryRef({ a: registration({ nextPollAt: Date.now() + 600_000 }) });
  const rounds = await pollFor(58_000, 20, { ref, accountKey: "k", apns: {}, fetcher: async () => assert.fail() });
  assert.equal(rounds.length, 1);
});

test("a bus activity replaced by the subscriber's newer one ends and dismisses at once", () => {
  const result = next(registration({ tracked: now + 300_000, replaced: now - 1_000 }), { NextBus: bus(now + 300_000) }, now);
  assert.equal(result.action, "end");
  assert.equal(result.dismissalDate, now);
});
