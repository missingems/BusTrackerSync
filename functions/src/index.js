const fs = require("node:fs");
const { initializeApp } = require("firebase-admin/app");
const { getDatabase, ServerValue } = require("firebase-admin/database");
const { onRequest } = require("firebase-functions/v2/https");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const { defineSecret, defineString, defineInt } = require("firebase-functions/params");
const { APNs, RecordingAPNs } = require("./apns");
const { pollFor, pollRound } = require("./poller");
const { proOwner } = require("./entitlement");
const { claim } = require("./owners");
const { makeOpsHandler } = require("./ops");
const { recordRun } = require("./stats");
const { makeSubscriptionHandler, fetchServiceAlerts, tick } = require("./serviceAlerts");

initializeApp();

const REGION = "asia-southeast1";
const LTA_ACCOUNT_KEY = defineSecret("LTA_ACCOUNT_KEY");
const APNS_KEY = defineSecret("APNS_KEY");
const APNS_KEY_ID = defineString("APNS_KEY_ID");
const APNS_TEAM_ID = defineString("APNS_TEAM_ID", { default: "25WL36ABTN" });
const APNS_TOPIC = defineString("APNS_TOPIC", { default: "sg.com.missingems.SGBusTime.push-type.liveactivity" });
const POLL_SECONDS = defineInt("POLL_SECONDS", { default: 20 });
const OPS_SECRET = defineSecret("OPS_SECRET");
const OPS_ORIGINS = defineString("OPS_ORIGINS", { default: "https://missingems.github.io" });

const emulated = process.env.FUNCTIONS_EMULATOR === "true";
const activities = () => getDatabase().ref("liveActivities");
const owners = () => getDatabase().ref("liveActivityOwners");
const pollStats = () => getDatabase().ref("liveActivityStats");
const alertSubscribers = () => getDatabase().ref("serviceAlertSubscribers");
const alertState = () => getDatabase().ref("serviceAlertState");

async function record(rounds, started, error) {
  try {
    await recordRun(pollStats(), rounds, { started, finished: Date.now(), error }, ServerValue.increment);
  } catch (failure) {
    console.warn(`Poll stats not saved: ${failure.message}`);
  }
}

function makeAPNs(pushes = "liveActivityPushes") {
  const value = APNS_KEY.value().trim();
  if (value === "mock") {
    return new RecordingAPNs((push) => getDatabase().ref(pushes).push({ ...push, at: Date.now() }));
  }
  const key = emulated && value.startsWith("/") ? fs.readFileSync(value, "utf8") : value;
  return new APNs({ key, keyId: APNS_KEY_ID.value(), teamId: APNS_TEAM_ID.value(), topic: APNS_TOPIC.value() });
}

const ID = /^[A-Za-z0-9-]{8,64}$/;
const TOKEN = /^[0-9a-f]{32,256}$/;
const STOP = /^\d{5}$/;
const SERVICE = /^[0-9A-Za-z]{1,5}$/;

exports.liveActivity = onRequest({ region: REGION, maxInstances: 5 }, async (request, response) => {
  if (request.method === "DELETE") {
    const id = String(request.query.id ?? "");
    if (!ID.test(id)) return response.status(400).send("bad id");
    await activities().child(id).remove();
    return response.status(204).end();
  }
  if (request.method !== "PUT") return response.status(405).end();

  const { id, token, service, stopCode, tracked, since, expires, environment, transaction } = request.body ?? {};
  const stop = request.body?.kind === "stop";
  const valid = ID.test(id ?? "") && TOKEN.test(token ?? "") && STOP.test(stopCode ?? "") && ["sandbox", "production"].includes(environment)
    && (stop ? Number.isFinite(expires) : SERVICE.test(service ?? "") && Number.isFinite(tracked) && Number.isFinite(since));
  if (!valid) return response.status(400).send("bad registration");
  const owner = emulated ? null : await proOwner(transaction);
  if (!emulated && !owner) return response.status(403).send("not pro");
  if (owner) await claim(owners(), activities(), owner, id);

  const ref = activities().child(id);
  const existing = (await ref.get()).val();
  const now = Date.now();
  const createdAt = existing?.createdAt ?? now;
  await ref.update(stop ? {
    kind: "stop",
    token,
    stopCode,
    environment,
    expires: Math.round(expires * 1000),
    createdAt,
    updatedAt: now,
    replaced: null,
  } : {
    token,
    service,
    stopCode,
    environment,
    tracked: existing?.last && existing.token === token ? existing.tracked : Math.round(tracked * 1000),
    since: Math.round(since * 1000),
    createdAt,
    updatedAt: now,
    replaced: null,
  });
  return response.status(204).end();
});

exports.pollLiveActivities = onSchedule(
  { region: REGION, schedule: "every 1 minutes", timeoutSeconds: 60, maxInstances: 1, secrets: [LTA_ACCOUNT_KEY, APNS_KEY] },
  async () => {
    const apns = makeAPNs();
    const started = Date.now();
    let rounds = [];
    let failure = null;
    try {
      rounds = await pollFor(58_000, POLL_SECONDS.value() * 1000, { ref: activities(), accountKey: LTA_ACCOUNT_KEY.value(), apns });
      if (rounds.some((round) => round.registrations > 0)) console.log(JSON.stringify(rounds));
    } catch (error) {
      failure = error;
      throw error;
    } finally {
      apns.close();
      await record(rounds, started, failure);
    }
  },
);

if (emulated) {
  exports.pollNow = onRequest({ region: REGION, secrets: [LTA_ACCOUNT_KEY, APNS_KEY] }, async (request, response) => {
    const apns = makeAPNs();
    const started = Date.now();
    try {
      const round = await pollRound({ ref: activities(), accountKey: LTA_ACCOUNT_KEY.value(), apns });
      await record([round], started, null);
      response.json(round);
    } finally {
      apns.close();
    }
  });
}

exports.serviceAlerts = onRequest({ region: REGION, maxInstances: 5 }, makeSubscriptionHandler({ ref: alertSubscribers }));

exports.pollServiceAlerts = onSchedule(
  { region: REGION, schedule: "every 1 minutes", timeoutSeconds: 60, maxInstances: 1, secrets: [LTA_ACCOUNT_KEY, APNS_KEY] },
  async () => {
    const apns = makeAPNs("serviceAlertPushes");
    try {
      const result = await tick({
        fetchAlerts: () => fetchServiceAlerts(LTA_ACCOUNT_KEY.value()),
        stateRef: alertState(),
        subscribersRef: alertSubscribers(),
        apns,
      });
      if (!result.idle && !result.skipped) console.log(JSON.stringify(result));
    } finally {
      apns.close();
    }
  },
);

if (emulated) {
  exports.pollServiceAlertsNow = onRequest({ region: REGION, secrets: [LTA_ACCOUNT_KEY, APNS_KEY] }, async (request, response) => {
    const fixture = request.method === "POST" && request.body?.value ? request.body : null;
    const at = Number(request.query.at);
    const apns = makeAPNs("serviceAlertPushes");
    try {
      response.json(await tick({
        fetchAlerts: fixture ? async () => fixture : () => fetchServiceAlerts(LTA_ACCOUNT_KEY.value()),
        stateRef: alertState(),
        subscribersRef: alertSubscribers(),
        apns,
        now: Number.isFinite(at) && at > 0 ? () => at : undefined,
      }));
    } finally {
      apns.close();
    }
  });
}

exports.ops = onRequest(
  { region: REGION, maxInstances: 2, cors: false, secrets: [OPS_SECRET, LTA_ACCOUNT_KEY] },
  makeOpsHandler({
    db: getDatabase,
    secret: () => OPS_SECRET.value(),
    accountKey: () => LTA_ACCOUNT_KEY.value(),
    origins: () => OPS_ORIGINS.value().split(",").map((origin) => origin.trim()).filter(Boolean),
    emulated,
  }),
);
