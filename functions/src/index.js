const fs = require("node:fs");
const { initializeApp } = require("firebase-admin/app");
const { getDatabase } = require("firebase-admin/database");
const { onRequest } = require("firebase-functions/v2/https");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const { defineSecret, defineString, defineInt } = require("firebase-functions/params");
const { APNs, RecordingAPNs } = require("./apns");
const { pollFor, pollRound } = require("./poller");

initializeApp();

const REGION = "asia-southeast1";
const LTA_ACCOUNT_KEY = defineSecret("LTA_ACCOUNT_KEY");
const APNS_KEY = defineSecret("APNS_KEY");
const APNS_KEY_ID = defineString("APNS_KEY_ID");
const APNS_TEAM_ID = defineString("APNS_TEAM_ID", { default: "25WL36ABTN" });
const APNS_TOPIC = defineString("APNS_TOPIC", { default: "sg.com.missingems.SGBusTime.push-type.liveactivity" });
const POLL_SECONDS = defineInt("POLL_SECONDS", { default: 20 });
const MAX_ACTIVITIES = defineInt("MAX_ACTIVITIES", { default: 500 });

const emulated = process.env.FUNCTIONS_EMULATOR === "true";
const activities = () => getDatabase().ref("liveActivities");

function makeAPNs() {
  const value = APNS_KEY.value().trim();
  if (value === "mock") {
    return new RecordingAPNs((push) => getDatabase().ref("liveActivityPushes").push({ ...push, at: Date.now() }));
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

  const { id, token, service, stopCode, tracked, since, environment } = request.body ?? {};
  const valid = ID.test(id ?? "") && TOKEN.test(token ?? "") && STOP.test(stopCode ?? "") && SERVICE.test(service ?? "")
    && Number.isFinite(tracked) && Number.isFinite(since) && ["sandbox", "production"].includes(environment);
  if (!valid) return response.status(400).send("bad registration");

  const ref = activities().child(id);
  const existing = (await ref.get()).val();
  if (!existing) {
    const count = Object.keys((await activities().orderByKey().limitToFirst(MAX_ACTIVITIES.value()).get()).val() ?? {}).length;
    if (count >= MAX_ACTIVITIES.value()) return response.status(503).send("full");
  }
  const now = Date.now();
  await ref.update({
    token,
    service,
    stopCode,
    environment,
    tracked: Math.round(tracked * 1000),
    since: Math.round(since * 1000),
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  });
  return response.status(204).end();
});

exports.pollLiveActivities = onSchedule(
  { region: REGION, schedule: "every 1 minutes", timeoutSeconds: 60, maxInstances: 1, secrets: [LTA_ACCOUNT_KEY, APNS_KEY] },
  async () => {
    const apns = makeAPNs();
    try {
      const rounds = await pollFor(58_000, POLL_SECONDS.value() * 1000, { ref: activities(), accountKey: LTA_ACCOUNT_KEY.value(), apns });
      if (rounds.some((round) => round.registrations > 0)) console.log(JSON.stringify(rounds));
    } finally {
      apns.close();
    }
  },
);

if (emulated) {
  exports.pollNow = onRequest({ region: REGION, secrets: [LTA_ACCOUNT_KEY, APNS_KEY] }, async (request, response) => {
    const apns = makeAPNs();
    try {
      response.json(await pollRound({ ref: activities(), accountKey: LTA_ACCOUNT_KEY.value(), apns }));
    } finally {
      apns.close();
    }
  });
}
