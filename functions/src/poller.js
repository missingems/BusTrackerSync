const { next, nextStop } = require("./state");
const { payloadFor, isGone } = require("./apns");

const LTA_URL = "https://datamall2.mytransport.sg/ltaodataservice/v3/BusArrival";
const LTA_CONCURRENCY = 8;
const END_ATTEMPTS = 3;
const REQUIRED = {
  bus: ["token", "service", "stopCode", "environment", "tracked", "since", "createdAt"],
  stop: ["token", "stopCode", "environment", "expires", "createdAt"],
};

async function fetchStop(stopCode, accountKey) {
  const response = await fetch(`${LTA_URL}?BusStopCode=${stopCode}`, {
    headers: { AccountKey: accountKey, accept: "application/json" },
    signal: AbortSignal.timeout(8000),
  });
  if (!response.ok) throw new Error(`LTA ${response.status} for ${stopCode}`);
  const body = await response.json();
  return body.Services ?? [];
}

async function inPool(items, size, work) {
  let index = 0;
  const workers = Array.from({ length: Math.min(size, items.length) }, async () => {
    while (index < items.length) {
      await work(items[index++]);
    }
  });
  await Promise.all(workers);
}

function patch(ref, id, token, values) {
  return ref.child(id).transaction((current) => {
    if (current === null) return null;
    if (current.token !== token) return;
    return values === null ? null : { ...current, ...values };
  });
}

async function pollRound({ ref, accountKey, apns, fetcher = fetchStop, now = () => Date.now(), log = console }) {
  const snapshot = await ref.get();
  const registrations = snapshot.val() ?? {};
  const stats = { stops: 0, activities: 0, waiting: 0, updates: 0, ends: 0, removed: 0, ltaErrors: 0 };
  const byStop = {};
  const started = now();
  let soonest = Infinity;
  const due = (at) => { soonest = Math.min(soonest, at); };
  for (const [id, registration] of Object.entries(registrations)) {
    const required = REQUIRED[registration.kind ?? "bus"] ?? REQUIRED.bus;
    if (required.some((field) => registration[field] == null)) {
      log.warn?.(`Removing ${id}: missing ${required.filter((field) => registration[field] == null).join(", ")}`);
      stats.removed += 1;
      await ref.child(id).remove();
      continue;
    }
    if (registration.nextPollAt > started) {
      stats.waiting += 1;
      due(registration.nextPollAt);
      continue;
    }
    (byStop[registration.stopCode] ??= []).push([id, registration]);
  }

  await inPool(Object.entries(byStop), LTA_CONCURRENCY, async ([stopCode, entries]) => {
    let services;
    try {
      services = await fetcher(stopCode, accountKey);
      stats.stops += 1;
    } catch (error) {
      stats.ltaErrors += 1;
      log.warn?.(error.message);
      due(started);
      return;
    }

    await Promise.all(entries.map(async ([id, registration]) => {
      stats.activities += 1;
      const at = now();
      const stop = registration.kind === "stop";
      const result = stop
        ? nextStop(registration, services, at)
        : next(registration, services.find((candidate) => candidate.ServiceNo === registration.service), at);
      const nextPollAt = result.nextPollAt > at ? result.nextPollAt : null;
      if (result.action === "none") {
        due(nextPollAt ?? at);
        if (stop) {
          if (nextPollAt !== (registration.nextPollAt ?? null)) await patch(ref, id, registration.token, { nextPollAt });
        } else if (result.tracked && (nextPollAt || registration.nextPollAt || result.tracked !== registration.tracked || result.arrived !== (registration.arrived ?? 0))) {
          await patch(ref, id, registration.token, { tracked: result.tracked, arrived: result.arrived, nextPollAt });
        }
        return;
      }

      const response = await apns.send({
        token: registration.token,
        environment: registration.environment,
        payload: payloadFor(result, at),
        priority: result.action === "end" || result.urgent ? 10 : 5,
        id,
      });

      log.info?.(`APNs ${response.status} ${response.reason ?? ""} ${result.action} ${id} ${registration.service ?? "stop"}@${registration.stopCode} ${registration.environment}`);
      if (isGone(response)) {
        stats.removed += 1;
        await patch(ref, id, registration.token, null);
        return;
      }
      if (response.status !== 200) {
        log.warn?.(`APNs ${response.status} ${response.reason} for ${id}`);
        due(at);
        const attempts = (registration.endAttempts ?? 0) + 1;
        if (result.action === "end") {
          await patch(ref, id, registration.token, attempts >= END_ATTEMPTS ? null : { endAttempts: attempts });
        }
        return;
      }
      if (result.action === "end") {
        stats.ends += 1;
        await patch(ref, id, registration.token, null);
        return;
      }
      stats.updates += 1;
      due(nextPollAt ?? at);
      const saved = stop ? { last: result.last } : { tracked: result.tracked, arrived: result.arrived, last: result.last };
      await patch(ref, id, registration.token, { ...saved, lastPushAt: at, nextPollAt });
    }));
  });
  return { ...stats, registrations: Object.keys(registrations).length, soonest: Number.isFinite(soonest) ? soonest : null };
}

async function pollFor(duration, interval, options) {
  const start = Date.now();
  const rounds = [];
  while (true) {
    const stats = await pollRound(options);
    rounds.push(stats);
    if (stats.registrations === 0 || stats.soonest === null) break;
    const wait = interval - ((Date.now() - start) % interval);
    if (Date.now() - start + wait + 8000 > duration || stats.soonest > start + duration - 8000) break;
    await new Promise((resolve) => setTimeout(resolve, wait));
  }
  return rounds;
}

module.exports = { pollRound, pollFor, fetchStop };
