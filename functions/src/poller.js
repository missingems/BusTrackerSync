const { next } = require("./state");
const { payloadFor, isGone } = require("./apns");

const LTA_URL = "https://datamall2.mytransport.sg/ltaodataservice/v3/BusArrival";

async function fetchStop(stopCode, accountKey) {
  const response = await fetch(`${LTA_URL}?BusStopCode=${stopCode}`, {
    headers: { AccountKey: accountKey, accept: "application/json" },
    signal: AbortSignal.timeout(8000),
  });
  if (!response.ok) throw new Error(`LTA ${response.status} for ${stopCode}`);
  const body = await response.json();
  return body.Services ?? [];
}

async function pollRound({ ref, accountKey, apns, fetcher = fetchStop, now = () => Date.now(), log = console }) {
  const snapshot = await ref.get();
  const registrations = snapshot.val() ?? {};
  const byStop = {};
  for (const [id, registration] of Object.entries(registrations)) {
    (byStop[registration.stopCode] ??= []).push([id, registration]);
  }

  const stats = { stops: 0, activities: 0, updates: 0, ends: 0, removed: 0, ltaErrors: 0 };
  await Promise.all(Object.entries(byStop).map(async ([stopCode, entries]) => {
    let services;
    try {
      services = await fetcher(stopCode, accountKey);
      stats.stops += 1;
    } catch (error) {
      stats.ltaErrors += 1;
      log.warn?.(error.message);
      return;
    }

    await Promise.all(entries.map(async ([id, registration]) => {
      stats.activities += 1;
      const at = now();
      const service = services.find((candidate) => candidate.ServiceNo === registration.service);
      const result = next(registration, service, at);
      if (result.action === "none") {
        if (result.tracked && result.tracked !== registration.tracked) {
          await ref.child(id).update({ tracked: result.tracked });
        }
        return;
      }

      const response = await apns.send({
        token: registration.token,
        environment: registration.environment,
        payload: payloadFor(result, at),
        priority: result.action === "end" ? 10 : 5,
        id,
      });

      if (result.action === "end" || isGone(response)) {
        stats[result.action === "end" ? "ends" : "removed"] += 1;
        await ref.child(id).remove();
        return;
      }
      if (response.status !== 200) {
        log.warn?.(`APNs ${response.status} ${response.reason} for ${id}`);
        return;
      }
      stats.updates += 1;
      await ref.child(id).update({ tracked: result.tracked, last: result.last, lastPushAt: at });
    }));
  }));
  return { ...stats, registrations: Object.keys(registrations).length };
}

async function pollFor(duration, interval, options) {
  const start = Date.now();
  const rounds = [];
  while (true) {
    const stats = await pollRound(options);
    rounds.push(stats);
    if (stats.registrations === 0) break;
    const wait = interval - ((Date.now() - start) % interval);
    if (Date.now() - start + wait + 8000 > duration) break;
    await new Promise((resolve) => setTimeout(resolve, wait));
  }
  return rounds;
}

module.exports = { pollRound, pollFor, fetchStop };
