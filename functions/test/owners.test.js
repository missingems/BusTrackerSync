const test = require("node:test");
const assert = require("node:assert/strict");
const { claim } = require("../src/owners");

function store(data = {}) {
  const ref = (path) => ({
    child: (key) => ref(`${path}/${key}`),
    transaction: async (update) => {
      data[path] = update(data[path] ?? null);
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

test("a new registration replaces the subscriber's previous one", async () => {
  const { data, owners, activities } = store({ "owners/a": "one", "activities/one": {}, "activities/two": {} });
  assert.equal(await claim(owners, activities, "a", "three"), "one");
  assert.equal(data["owners/a"], "three");
  assert.equal("activities/one" in data, false);
  assert.equal("activities/two" in data, true);
});

test("registering the same activity again keeps it", async () => {
  const { data, owners, activities } = store({ "owners/a": "one", "activities/one": {} });
  await claim(owners, activities, "a", "one");
  assert.equal("activities/one" in data, true);
});

test("other subscribers are untouched", async () => {
  const { data, owners, activities } = store({ "owners/a": "one", "owners/b": "two", "activities/one": {}, "activities/two": {} });
  await claim(owners, activities, "a", "three");
  assert.equal(data["owners/b"], "two");
  assert.equal("activities/two" in data, true);
});
