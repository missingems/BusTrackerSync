async function claim(owners, activities, owner, id) {
  let previous = null;
  await owners.child(owner).transaction((current) => {
    previous = current;
    return id;
  });
  if (previous && previous !== id) await activities.child(previous).remove();
  return previous;
}

module.exports = { claim };
