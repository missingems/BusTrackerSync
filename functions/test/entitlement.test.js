const test = require("node:test");
const assert = require("node:assert/strict");
const { entitled, hasPro, PRO_PRODUCT_ID } = require("../src/entitlement");

const now = Date.parse("2026-11-02T08:00:00Z");
const transaction = (extra = {}) => ({
  bundleId: "sg.com.missingems.SGBusTime",
  productId: PRO_PRODUCT_ID,
  expiresDate: now + 86_400_000,
  ...extra,
});

test("an active Pro subscription is entitled", () => {
  assert.equal(entitled(transaction(), now), true);
});

test("expired, revoked, other products and other apps are not entitled", () => {
  assert.equal(entitled(transaction({ expiresDate: now - 1 }), now), false);
  assert.equal(entitled(transaction({ revocationDate: now - 1 }), now), false);
  assert.equal(entitled(transaction({ productId: "other" }), now), false);
  assert.equal(entitled(transaction({ bundleId: "com.example.app" }), now), false);
  assert.equal(entitled(undefined, now), false);
});

test("missing, oversized and unsigned transactions are rejected", async () => {
  assert.equal(await hasPro(undefined, now), false);
  assert.equal(await hasPro("x".repeat(20_000), now), false);
  const unsigned = [{ alg: "none" }, transaction()].map((part) => Buffer.from(JSON.stringify(part)).toString("base64url")).join(".") + ".";
  assert.equal(await hasPro(unsigned, now), false);
});
