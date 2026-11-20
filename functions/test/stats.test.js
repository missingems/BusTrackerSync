const test = require("node:test");
const assert = require("node:assert/strict");
const { hourKey, runUpdate, recordRun } = require("../src/stats");
const { pollRound } = require("../src/poller");
const { memoryRef } = require("./support/memory-ref");

const started = Date.parse("2026-11-15T08:30:00Z");
const increment = (value) => ({ increment: value });
const round = (extra) => ({ stops: 0, activities: 0, waiting: 0, updates: 0, ends: 0, removed: 0, ltaErrors: 0, failures: 0, registrations: 0, ...extra });

test("hour keys are UTC hours", () => {
  assert.equal(hourKey(started), "2026111508");
});

test("an idle run still records a heartbeat and prunes the bucket from 48 h ago", () => {
  const update = runUpdate([round()], { started, finished: started + 120 }, increment);
  assert.deepEqual(update.last, { at: started + 120, runMs: 120, rounds: 1, registrations: 0, ltaCalls: 0, ltaErrors: 0, pushes: 0, pushFailures: 0, ends: 0, removed: 0, error: null });
  assert.deepEqual(update["hours/2026111508/runs"], { increment: 1 });
  assert.equal(update["hours/2026111308"], null);
  assert.equal("hours/2026111508/activeRuns" in update, false);
});

test("an active run adds its LTA calls, pushes and failures to the hour", () => {
  const rounds = [round({ registrations: 4, stops: 2, ltaErrors: 1, updates: 3, failures: 1 }), round({ registrations: 5, stops: 3, ends: 1, removed: 2 })];
  const update = runUpdate(rounds, { started, finished: started + 41_000, error: new Error("boom") }, increment);
  assert.equal(update.last.registrations, 5);
  assert.equal(update.last.ltaCalls, 6);
  assert.equal(update.last.pushes, 4);
  assert.equal(update.last.error, "boom");
  assert.deepEqual(update["hours/2026111508/ltaCalls"], { increment: 6 });
  assert.deepEqual(update["hours/2026111508/pushFailures"], { increment: 1 });
  assert.deepEqual(update["hours/2026111508/activeRuns"], { increment: 1 });
  assert.deepEqual(update["hours/2026111508/errors"], { increment: 1 });
});

test("recordRun keeps the hour's peak registrations", async () => {
  const written = [];
  let peak = 7;
  const ref = {
    update: async (value) => written.push(value),
    child: () => ({ transaction: async (change) => { peak = change(peak); } }),
  };
  await recordRun(ref, [round({ registrations: 5 })], { started, finished: started }, increment);
  assert.equal(written.length, 1);
  assert.equal(peak, 7);
  await recordRun(ref, [round({ registrations: 9 })], { started, finished: started }, increment);
  assert.equal(peak, 9);
});

test("the poller counts APNs failures that are not gone tokens", async () => {
  const now = Date.parse("2026-11-02T08:00:00Z");
  const iso = (ms) => new Date(ms).toISOString().replace("Z", "+00:00");
  const ref = memoryRef({
    one: { token: "ab".repeat(32), service: "15", stopCode: "83139", environment: "sandbox", tracked: now + 130_000, since: now - 60_000, createdAt: now - 60_000 },
  });
  const stats = await pollRound({
    ref,
    accountKey: "key",
    apns: { send: async () => ({ status: 500, reason: "InternalServerError" }) },
    fetcher: async () => [{ ServiceNo: "15", NextBus: { EstimatedArrival: iso(now + 130_000), Load: "SEA", Type: "SD" } }],
    now: () => now,
    log: {},
  });
  assert.equal(stats.failures, 1);
  assert.equal(stats.updates, 0);
});
