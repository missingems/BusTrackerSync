const KEEP_HOURS = 48;

function hourKey(ms) {
  return new Date(ms).toISOString().slice(0, 13).replace(/[-T]/g, "");
}

function totals(rounds) {
  const sum = (key) => rounds.reduce((total, round) => total + (round[key] ?? 0), 0);
  return {
    rounds: rounds.length,
    registrations: rounds.reduce((most, round) => Math.max(most, round.registrations ?? 0), 0),
    ltaCalls: sum("stops") + sum("ltaErrors"),
    ltaErrors: sum("ltaErrors"),
    pushes: sum("updates") + sum("ends"),
    pushFailures: sum("failures"),
    ends: sum("ends"),
    removed: sum("removed"),
  };
}

function runUpdate(rounds, { started, finished, error }, increment) {
  const run = totals(rounds);
  const hour = `hours/${hourKey(started)}`;
  const update = {
    last: { at: finished, runMs: Math.max(0, finished - started), ...run, error: error ? String(error.message ?? error).slice(0, 200) : null },
    [`hours/${hourKey(started - KEEP_HOURS * 3_600_000)}`]: null,
    [`${hour}/runs`]: increment(1),
  };
  if (run.registrations > 0) update[`${hour}/activeRuns`] = increment(1);
  if (error) update[`${hour}/errors`] = increment(1);
  for (const key of ["rounds", "ltaCalls", "ltaErrors", "pushes", "pushFailures", "ends", "removed"]) {
    if (run[key] > 0) update[`${hour}/${key}`] = increment(run[key]);
  }
  return update;
}

async function recordRun(ref, rounds, info, increment) {
  const update = runUpdate(rounds, info, increment);
  const peak = update.last.registrations;
  await ref.update(update);
  if (peak > 0) {
    await ref.child(`hours/${hourKey(info.started)}/peakRegistrations`).transaction((current) => Math.max(current ?? 0, peak));
  }
}

module.exports = { hourKey, totals, runUpdate, recordRun, KEEP_HOURS };
