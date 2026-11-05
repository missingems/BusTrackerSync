const test = require("node:test");
const assert = require("node:assert/strict");
const { nextStop, appleDate } = require("../src/state");
const { pollRound } = require("../src/poller");

const now = Date.parse("2026-11-02T08:00:00Z");
const iso = (ms) => new Date(ms).toISOString().replace("Z", "+00:00");
const bus = (ms) => ({ EstimatedArrival: iso(ms), Load: "SEA", Type: "SD" });
const stop = (extra = {}) => ({
  kind: "stop",
  token: "ab".repeat(32),
  stopCode: "83139",
  environment: "sandbox",
  expires: now + 600_000,
  createdAt: now - 60_000,
  ...extra,
});
const board = [
  { ServiceNo: "15", Operator: "SBST", NextBus: bus(now + 130_000), NextBus2: bus(now + 900_000) },
  { ServiceNo: "43", Operator: "GAS", NextBus: bus(now + 300_000), NextBus2: bus(now + 2_000_000) },
  { ServiceNo: "62", Operator: "", NextBus: bus(now - 45_000) },
];
const pushed = (at, extra = {}) => ({
  last: [
    { service: "15", operatorCode: "SBST", time: now + 130_000 },
    { service: "43", operatorCode: "GAS", time: now + 300_000 },
    { service: "15", operatorCode: "SBST", time: now + 900_000 },
  ],
  lastPushAt: at,
  ...extra,
});

test("first poll pushes the next buses at the stop, soonest first, within 20 minutes", () => {
  const result = nextStop(stop(), board, now);
  assert.equal(result.action, "update");
  assert.equal(result.urgent, true);
  assert.deepEqual(result.contentState, {
    arrivals: [
      { service: "15", operatorCode: "SBST", time: appleDate(now + 130_000) },
      { service: "43", operatorCode: "GAS", time: appleDate(now + 300_000) },
      { service: "15", operatorCode: "SBST", time: appleDate(now + 900_000) },
    ],
  });
});

test("keeps at most five buses", () => {
  const services = Array.from({ length: 8 }, (_, i) => ({ ServiceNo: String(i + 1), NextBus: bus(now + (i + 1) * 60_000) }));
  assert.equal(nextStop(stop(), services, now).contentState.arrivals.length, 5);
});

test("a bus that just left drops off, one still due stays", () => {
  const services = [{ ServiceNo: "15", NextBus: bus(now - 20_000) }, { ServiceNo: "16", NextBus: bus(now - 40_000) }];
  assert.deepEqual(nextStop(stop(), services, now).last.map((entry) => entry.service), ["15"]);
});

test("small shifts wait, but the minutes shown changing pushes", () => {
  assert.equal(nextStop(stop(pushed(now - 20_000)), board, now).action, "none");
  const later = now + 15_000;
  const result = nextStop(stop(pushed(now - 20_000)), board, later);
  assert.equal(result.action, "update");
  assert.equal(result.urgent, true);
});

test("only the first two buses' minutes trigger a push", () => {
  const services = [{ ServiceNo: "15", NextBus: bus(now + 130_000) }, { ServiceNo: "43", NextBus: bus(now + 330_000) }, { ServiceNo: "62", NextBus: bus(now + 425_000) }];
  const last = [{ service: "15", time: now + 130_000 }, { service: "43", time: now + 330_000 }, { service: "62", time: now + 425_000 }];
  assert.equal(nextStop(stop({ last, lastPushAt: now - 10_000 }), services, now + 10_000).action, "none");
});

test("a bus reaching its arrival time pushes urgently, so the activity shows it has arrived", () => {
  const services = [{ ServiceNo: "15", NextBus: bus(now - 5_000) }];
  const result = nextStop(stop({ last: [{ service: "15", time: now - 5_000 }], lastPushAt: now - 10_000 }), services, now);
  assert.equal(result.action, "update");
  assert.equal(result.urgent, true);
});

test("a new bus at the front pushes urgently", () => {
  const services = [{ ServiceNo: "7", NextBus: bus(now + 60_000) }, ...board];
  const result = nextStop(stop(pushed(now - 10_000)), services, now);
  assert.equal(result.action, "update");
  assert.equal(result.urgent, true);
});

test("re-pushes every two minutes so the timeline keeps moving", () => {
  assert.equal(nextStop(stop(pushed(now - 120_000)), board, now - 1).action, "update");
});

test("a blank board is held briefly before it's pushed", () => {
  assert.equal(nextStop(stop(pushed(now - 30_000)), [], now).action, "none");
  const result = nextStop(stop(pushed(now - 100_000)), [], now);
  assert.equal(result.action, "update");
  assert.deepEqual(result.contentState, { arrivals: [] });
});

test("an empty board already pushed isn't pushed again every poll", () => {
  assert.equal(nextStop(stop({ lastPushAt: now - 20_000 }), [], now).action, "none");
});

test("ends at its expiry, and never lives past 30 minutes", () => {
  const ended = nextStop(stop(pushed(now - 20_000, { expires: now })), board, now);
  assert.equal(ended.action, "end");
  assert.equal(ended.dismissalDate, now);
  assert.equal(ended.contentState.arrivals.length, 3);
  assert.equal(nextStop(stop({ expires: now + 3_600_000, createdAt: now - 31 * 60_000 }), board, now).action, "end");
});

test("a far first bus is polled less often", () => {
  const services = [{ ServiceNo: "15", NextBus: bus(now + 15 * 60_000) }];
  assert.ok(nextStop(stop(), services, now).nextPollAt > now);
  assert.equal(nextStop(stop(), board, now).nextPollAt, now);
});

function memoryRef(data) {
  const ref = {
    data,
    async get() {
      return { val: () => structuredClone(ref.data) };
    },
    child(id) {
      return {
        remove: async () => delete ref.data[id],
        transaction: async (update) => {
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

test("a stop and a bus at the same stop share one LTA call", async () => {
  const ref = memoryRef({
    s: stop(),
    b: { token: "cd".repeat(32), service: "15", stopCode: "83139", environment: "sandbox", tracked: now + 130_000, since: now - 60_000, createdAt: now - 60_000 },
  });
  const calls = [];
  const pushes = [];
  await pollRound({
    ref,
    accountKey: "k",
    apns: { send: async (push) => { pushes.push(push); return { status: 200 }; } },
    fetcher: async (code) => { calls.push(code); return board; },
    now: () => now,
    log: {},
  });
  assert.deepEqual(calls, ["83139"]);
  assert.equal(pushes.length, 2);
  const payload = pushes.find((push) => push.id === "s").payload;
  assert.equal(payload.aps.event, "update");
  assert.equal(payload.aps["content-state"].arrivals[0].service, "15");
  assert.equal(ref.data.s.lastPushAt, now);
  assert.equal(ref.data.s.last.length, 3);
  assert.equal(ref.data.s.tracked, undefined);
});

test("an expired stop activity is ended and removed", async () => {
  const ref = memoryRef({ s: stop(pushed(now - 20_000, { expires: now - 1 })) });
  const pushes = [];
  await pollRound({ ref, accountKey: "k", apns: { send: async (push) => { pushes.push(push); return { status: 200 }; } }, fetcher: async () => board, now: () => now, log: {} });
  assert.equal(pushes[0].payload.aps.event, "end");
  assert.equal(pushes[0].priority, 10);
  assert.deepEqual(ref.data, {});
});

test("a stop registration missing its expiry is removed", async () => {
  const ref = memoryRef({ s: stop({ expires: undefined }) });
  const stats = await pollRound({ ref, accountKey: "k", apns: {}, fetcher: async () => assert.fail(), now: () => now, log: {} });
  assert.equal(stats.removed, 1);
});

test("a stop activity replaced by the subscriber's newer one is ended and dismissed at once", async () => {
  const ref = memoryRef({ s: stop(pushed(now - 20_000, { replaced: now - 1_000 })) });
  const pushes = [];
  await pollRound({ ref, accountKey: "k", apns: { send: async (push) => { pushes.push(push); return { status: 200 }; } }, fetcher: async () => board, now: () => now, log: {} });
  assert.equal(pushes[0].payload.aps.event, "end");
  assert.equal(pushes[0].payload.aps["dismissal-date"], Math.floor(now / 1000));
  assert.equal(pushes[0].payload.aps["content-state"].arrivals[0].service, "15");
  assert.equal(ref.data.s, undefined);
});
