const REFERENCE_EPOCH = 978307200;

const HANDOVER = 90_000;
const ARRIVED_WINDOW = 60_000;
const LINGERING = 120_000;
const STALE_AFTER = 180_000;
const MAX_LIFETIME = 2 * 60 * 60_000;
const REPUSH_EVERY = 120_000;
const SHIFT_THRESHOLD = 10_000;
const COUNTDOWN_LEAD = 60_000;
const MIN_FRESH = 15_000;
const MAX_BUSES = 3;

function staleDate(arrival, now) {
  return Math.min(now + STALE_AFTER, Math.max(arrival - COUNTDOWN_LEAD, now + MIN_FRESH));
}

function minutesAway(arrival, at) {
  return Math.floor((arrival - at) / 60_000);
}

function appleDate(ms) {
  return ms == null ? null : ms / 1000 - REFERENCE_EPOCH;
}

function arrivals(service) {
  return [service?.NextBus, service?.NextBus2, service?.NextBus3]
    .filter((bus) => bus && bus.EstimatedArrival)
    .map((bus) => ({ bus, time: Date.parse(bus.EstimatedArrival) }))
    .filter(({ time }) => Number.isFinite(time))
    .sort((a, b) => a.time - b.time);
}

function contentState({ arrival, following, load, vehicle, since, hasArrived }) {
  const state = { since: appleDate(since), hasArrived };
  if (arrival != null) state.arrival = appleDate(arrival);
  if (following != null) state.following = appleDate(following);
  if (load) state.load = load;
  if (vehicle) state.vehicle = vehicle;
  return state;
}

function arrivedEnd(registration, now) {
  const last = registration.last ?? {};
  return {
    action: "end",
    tracked: registration.tracked,
    contentState: contentState({ ...last, arrival: registration.tracked, since: registration.since, hasArrived: true }),
    dismissalDate: now + LINGERING,
  };
}

function next(registration, service, now) {
  const { tracked, since, createdAt } = registration;

  if (now - createdAt > MAX_LIFETIME || tracked < now - 10 * 60_000) {
    const last = registration.last ?? {};
    return {
      action: "end",
      tracked,
      contentState: contentState({ ...last, since, hasArrived: false }),
      dismissalDate: now,
    };
  }

  const list = arrivals(service);
  const near = tracked < now + ARRIVED_WINDOW;
  if (list.length === 0) {
    return near ? arrivedEnd(registration, now) : { action: "none" };
  }

  let index = 0;
  list.forEach((entry, i) => {
    if (Math.abs(entry.time - tracked) < Math.abs(list[index].time - tracked)) index = i;
  });
  const chosen = list[index];
  let arrived = registration.arrived ?? 0;
  if (near && chosen.time - tracked > HANDOVER) {
    if (arrived + 1 >= MAX_BUSES) return arrivedEnd(registration, now);
    arrived += 1;
  }

  const snapshot = {
    arrival: chosen.time,
    following: index + 1 < list.length ? list[index + 1].time : null,
    load: chosen.bus.Load || null,
    vehicle: chosen.bus.Type || null,
  };
  const last = registration.last && {
    arrival: registration.last.arrival,
    following: registration.last.following ?? null,
    load: registration.last.load ?? null,
    vehicle: registration.last.vehicle ?? null,
  };
  const changed = !last
    || Math.abs(last.arrival - snapshot.arrival) >= SHIFT_THRESHOLD
    || (last.following === null) !== (snapshot.following === null)
    || (snapshot.following !== null && Math.abs(last.following - snapshot.following) >= 30_000)
    || last.load !== snapshot.load
    || last.vehicle !== snapshot.vehicle;
  const due = now - (registration.lastPushAt ?? 0) >= REPUSH_EVERY;
  const shown = minutesAway(snapshot.arrival, now);
  const ticked = last != null && registration.lastPushAt != null
    && shown >= 1
    && shown !== minutesAway(last.arrival, registration.lastPushAt);
  const urgent = !last || registration.lastPushAt == null || ticked
    || (shown >= 1 && shown !== minutesAway(last.arrival, now));

  return {
    action: changed || due || ticked ? "update" : "none",
    urgent,
    tracked: chosen.time,
    arrived,
    last: snapshot,
    contentState: contentState({ ...snapshot, since: Math.min(since, chosen.time), hasArrived: false }),
    staleDate: staleDate(chosen.time, now),
  };
}

module.exports = { next, contentState, appleDate, staleDate, REFERENCE_EPOCH, MAX_BUSES };
