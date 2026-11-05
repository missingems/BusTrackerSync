const REFERENCE_EPOCH = 978307200;

const ARRIVED_WINDOW = 60_000;
const LINGERING = 120_000;
const STALE_AFTER = 180_000;
const MAX_LIFETIME = 30 * 60_000;
const REPUSH_EVERY = 120_000;
const SHIFT_THRESHOLD = 10_000;
const FAR = 10 * 60_000;
const FAR_POLL = 50_000;
const STOP_BUSES = 5;
const STOP_WINDOW = 20 * 60_000;
const DEPARTED_AFTER = 30_000;
const BLANK_TOLERANCE = 90_000;
const STOP_SHIFT = 30_000;

function staleDate(now) {
  return now + STALE_AFTER;
}

function nextPollAt(arrival, now) {
  return arrival - now > FAR ? now + FAR_POLL : now;
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

  if (registration.replaced || now - createdAt > MAX_LIFETIME || tracked < now - 10 * 60_000) {
    const last = registration.last ?? {};
    return {
      action: "end",
      tracked,
      contentState: contentState({ ...last, since, hasArrived: false }),
      dismissalDate: now,
    };
  }

  const list = arrivals(service).filter(({ time }) => time >= now - DEPARTED_AFTER);
  if (list.length === 0) {
    return tracked < now + ARRIVED_WINDOW ? arrivedEnd(registration, now) : { action: "none" };
  }

  const [chosen, after] = list;
  const snapshot = {
    arrival: chosen.time,
    following: after?.time ?? null,
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
    && shown >= 0
    && shown !== minutesAway(last.arrival, registration.lastPushAt);
  const reached = registration.lastPushAt != null
    && registration.lastPushAt < snapshot.arrival
    && now >= snapshot.arrival;
  const urgent = !last || registration.lastPushAt == null || ticked || reached
    || (shown >= 0 && shown !== minutesAway(last.arrival, now));

  return {
    action: changed || due || ticked || reached ? "update" : "none",
    urgent,
    nextPollAt: nextPollAt(chosen.time, now),
    tracked: chosen.time,
    last: snapshot,
    contentState: contentState({ ...snapshot, since: Math.min(since, chosen.time), hasArrived: false }),
    staleDate: staleDate(now),
  };
}

function stopArrivals(services, now) {
  return (services ?? [])
    .flatMap((service) => arrivals(service).map(({ time }) => ({ service: service.ServiceNo, operatorCode: service.Operator || null, time })))
    .filter(({ time }) => time >= now - DEPARTED_AFTER && time - now <= STOP_WINDOW)
    .sort((a, b) => a.time - b.time)
    .slice(0, STOP_BUSES);
}

function stopState(list) {
  return {
    arrivals: list.map(({ service, operatorCode, time }) => (operatorCode ? { service, operatorCode, time: appleDate(time) } : { service, time: appleDate(time) })),
  };
}

function storedArrivals(last) {
  return Object.values(last ?? {}).map(({ service, operatorCode, time }) => ({ service, operatorCode: operatorCode ?? null, time }));
}

function nextStop(registration, services, now) {
  const { createdAt, expires, lastPushAt } = registration;
  const last = registration.last != null ? storedArrivals(registration.last) : lastPushAt != null ? [] : null;
  if (registration.replaced || now >= expires || now - createdAt > MAX_LIFETIME) {
    return { action: "end", contentState: stopState(last ?? []), dismissalDate: now };
  }

  const list = stopArrivals(services, now);
  if (list.length === 0 && last?.length && now - (lastPushAt ?? 0) < BLANK_TOLERANCE) {
    return { action: "none", nextPollAt: null };
  }

  const first = list[0];
  const poll = first ? nextPollAt(first.time, now) : now + FAR_POLL;
  const changed = !last
    || last.length !== list.length
    || list.some((entry, i) => entry.service !== last[i].service
      || entry.operatorCode !== last[i].operatorCode
      || Math.abs(entry.time - last[i].time) >= STOP_SHIFT);
  const due = now - (lastPushAt ?? 0) >= REPUSH_EVERY;
  const shownChanged = (count) => last != null && lastPushAt != null
    && list.slice(0, count).some((entry, i) => last[i] != null
      && minutesAway(entry.time, now) >= 0
      && minutesAway(entry.time, now) !== minutesAway(last[i].time, lastPushAt));
  const ticked = shownChanged(2);
  const reached = first != null && lastPushAt != null && lastPushAt < first.time && now >= first.time;
  const urgent = !last || lastPushAt == null || reached || shownChanged(1) || first?.service !== last[0]?.service;

  return {
    action: changed || due || ticked || reached ? "update" : "none",
    urgent,
    nextPollAt: poll,
    last: list,
    contentState: stopState(list),
    staleDate: staleDate(now),
  };
}

module.exports = { next, nextStop, contentState, appleDate, staleDate, REFERENCE_EPOCH, FAR_POLL };
