async function claim(owners, activities, owner, id, now = Date.now()) {
  let previous = null;
  await owners.child(owner).transaction((current) => {
    previous = current;
    return id;
  });
  if (previous && previous !== id) {
    await activities.child(previous).transaction((registration) => (registration ? { ...registration, replaced: now, nextPollAt: null } : undefined));
  }
  return previous;
}

module.exports = { claim };
