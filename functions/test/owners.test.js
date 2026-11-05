const test = require("node:test");
const assert = require("node:assert/strict");
const { claim } = require("../src/owners");

function store(data = {}) {
  const ref = (path) => ({
    child: (key) => ref(`${path}/${key}`),
    transaction: async (update) => {
      const value = update(data[path] ?? null);
      if (value !== undefined) data[path] = value;
    },
    remove: async () => {
      delete data[path];
    },
  });
  return { data, owners: ref("owners"), activities: ref("activities") };
}

test("the first registration claims the subscriber's slot", async () => {
  const { data, owners, activities } = store();
  assert.equal(await claim(owners, activities, "a", "one"), null);
  assert.equal(data["owners/a"], "one");
});

test("a new registration marks the subscriber's previous one replaced so the poller ends it", async () => {
  const { data, owners, activities } = store({ "owners/a": "one", "activities/one": { token: "t", nextPollAt: 99 }, "activities/two": {} });
  assert.equal(await claim(owners, activities, "a", "three", 42), "one");
  assert.equal(data["owners/a"], "three");
  assert.deepEqual(data["activities/one"], { token: "t", replaced: 42, nextPollAt: null });
  assert.deepEqual(data["activities/two"], {});
});

test("a previous registration that is already gone is not recreated", async () => {
  const { data, owners, activities } = store({ "owners/a": "one" });
  await claim(owners, activities, "a", "two");
  assert.equal("activities/one" in data, false);
});

test("registering the same activity again keeps it", async () => {
  const { data, owners, activities } = store({ "owners/a": "one", "activities/one": {} });
  await claim(owners, activities, "a", "one");
  assert.deepEqual(data["activities/one"], {});
});

test("other subscribers are untouched", async () => {
  const { data, owners, activities } = store({ "owners/a": "one", "owners/b": "two", "activities/one": {}, "activities/two": {} });
  await claim(owners, activities, "a", "three");
  assert.equal(data["owners/b"], "two");
  assert.deepEqual(data["activities/two"], {});
});
