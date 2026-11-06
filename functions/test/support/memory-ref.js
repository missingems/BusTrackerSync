function snapshot(entries) {
  return { val: () => (entries.length ? structuredClone(Object.fromEntries(entries)) : null) };
}

function query(ref, key, filter = () => true, limit = Infinity) {
  const rank = (value) => (value == null ? -Infinity : value);
  return {
    endAt: (end) => query(ref, key, (value) => rank(value) <= end, limit),
    startAfter: (start) => query(ref, key, (value) => value != null && value > start, limit),
    limitToFirst: (count) => query(ref, key, filter, count),
    async get() {
      const entries = Object.entries(ref.data)
        .filter(([, child]) => filter(child[key]))
        .sort(([, a], [, b]) => rank(a[key]) - rank(b[key]))
        .slice(0, limit);
      return snapshot(entries);
    },
  };
}

function memoryRef(data) {
  const ref = {
    data,
    async get() {
      return snapshot(Object.entries(ref.data));
    },
    orderByChild(key) {
      return query(ref, key);
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

module.exports = { memoryRef };
