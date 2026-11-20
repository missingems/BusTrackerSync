const crypto = require("node:crypto");
const STATIONS = require("./stations.json");
const { isDeadToken } = require("./apns");

const LTA_URL = "https://datamall2.mytransport.sg/ltaodataservice/TrainServiceAlerts";
const APP_LINES = ["NSL", "EWL", "NEL", "CCL", "DTL", "TEL", "BPL", "SKL", "PGL"];
const ALIASES = { STL: "SKL", SLRT: "SKL", PTL: "PGL", PLRT: "PGL", CEL: "CCL", CGL: "EWL" };
const TOKEN = /^[0-9a-f]{64,160}$/;
const SEND_CONCURRENCY = 16;
const MAX_PER_LINE = 5000;
const CLEAR_RUNS = 2;
const PROVIDER_TOKEN_REASONS = ["InvalidProviderToken", "ExpiredProviderToken"];
const SGT_OFFSET = 8 * 60 * 60_000;
const DAY = 24 * 60 * 60_000;

function appLine(value) {
  if (typeof value !== "string") return null;
  const code = value.trim().toUpperCase();
  return APP_LINES.includes(code) ? code : ALIASES[code] ?? null;
}

function codes(value) {
  const list = Array.isArray(value) ? value : typeof value === "string" ? value.split(/[\s,;]+/) : [];
  const seen = new Set();
  for (const item of list) {
    if (typeof item !== "string") continue;
    const code = item.trim().toUpperCase();
    if (/^[A-Z0-9]{1,6}$/.test(code)) seen.add(code);
  }
  return [...seen];
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function parseSegment(segment) {
  if (!segment || typeof segment !== "object" || typeof segment.Line !== "string" || !segment.Line.trim()) return null;
  const line = appLine(segment.Line);
  const freeText = typeof segment.FreePublicBus === "string" ? segment.FreePublicBus : "";
  return {
    line,
    direction: typeof segment.Direction === "string" ? segment.Direction.trim() : "",
    stations: codes(segment.Stations),
    islandWide: /island/i.test(freeText),
    freeBus: /island/i.test(freeText) ? [] : codes(segment.FreePublicBus),
  };
}

function mergeLine(line, segments) {
  const stations = [];
  const free = new Set();
  for (const segment of segments) {
    for (const code of segment.stations) if (!stations.includes(code)) stations.push(code);
    segment.freeBus.forEach((code) => free.add(code));
  }
  const islandWide = segments.some((segment) => segment.islandWide);
  const directions = new Set(segments.map((segment) => segment.direction.toLowerCase()));
  const direction = directions.size === 1 && ![...directions][0].includes("both") && [...directions][0] !== ""
    ? segments[0].direction
    : "";
  const key = crypto.createHash("sha256")
    .update(canonical(segments.map(({ direction: d, stations: s, islandWide: w, freeBus: f }) => canonical({ d: d.toLowerCase(), s: [...s].sort(), w, f: [...f].sort() })).sort()))
    .digest("hex")
    .slice(0, 16);
  const material = crypto.createHash("sha256")
    .update(canonical({ d: direction.toLowerCase(), w: islandWide }))
    .digest("hex")
    .slice(0, 16);
  return { line, key, material, direction, stations, freeBus: islandWide ? stations.length : free.size, islandWide };
}

function parseAlerts(body) {
  const value = body?.value;
  if (!value || typeof value !== "object" || Array.isArray(value)) return { ok: false, reason: "no value" };
  const status = typeof value.Status === "number" || (typeof value.Status === "string" && value.Status.trim() !== "") ? Number(value.Status) : NaN;
  if (status !== 1 && status !== 2) return { ok: false, reason: "bad status" };
  const raw = value.AffectedSegments ?? [];
  if (!Array.isArray(raw)) return { ok: false, reason: "bad segments" };
  const byLine = {};
  for (const item of raw) {
    const segment = parseSegment(item);
    if (!segment) return { ok: false, reason: "bad segment" };
    if (segment.line) (byLine[segment.line] ??= []).push(segment);
  }
  const disruptions = {};
  for (const [line, segments] of Object.entries(byLine)) disruptions[line] = mergeLine(line, segments);
  if (status === 2 && Object.keys(disruptions).length === 0) return { ok: false, reason: "disrupted without known lines" };
  return { ok: true, status, disruptions };
}

function minutesOfDay(now) {
  return Math.floor((((now + SGT_OFFSET) % DAY) + DAY) % DAY / 60_000);
}

function inQuiet(quiet, now) {
  if (!quiet || !Number.isInteger(quiet.from) || !Number.isInteger(quiet.to) || quiet.from === quiet.to) return false;
  const minute = minutesOfDay(now);
  return quiet.from < quiet.to ? minute >= quiet.from && minute < quiet.to : minute >= quiet.from || minute < quiet.to;
}

function stationName(code) {
  return STATIONS[code] ?? code;
}

function collapseHeaders(line) {
  return { "apns-collapse-id": `service-alert-${line}` };
}

function disruptedPayload(disruption) {
  const alert = { "title-loc-key": "%@ disrupted", "title-loc-args": [disruption.line] };
  if (disruption.freeBus > 0) {
    alert["subtitle-loc-key"] = "Free bus rides at %@ stations";
    alert["subtitle-loc-args"] = [String(disruption.freeBus)];
  }
  const names = [...new Set([disruption.stations[0], disruption.stations.at(-1)].filter(Boolean).map(stationName))];
  if (names.length > 0) {
    const route = names.join(" – ");
    alert.body = disruption.direction ? `${route} → ${disruption.direction}` : route;
  }
  return {
    aps: { alert, sound: "default", "thread-id": `service-alert-${disruption.line}` },
    line: disruption.line,
    kind: "disrupted",
  };
}

function normalPayload(line) {
  return {
    aps: {
      alert: { "title-loc-key": "%@ back to normal", "title-loc-args": [line] },
      sound: "default",
      "thread-id": `service-alert-${line}`,
    },
    line,
    kind: "normal",
  };
}

function subscriberId(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

function parseToken(value) {
  const token = typeof value === "string" ? value.trim().toLowerCase() : "";
  return TOKEN.test(token) ? token : null;
}

function parseSubscription(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const token = parseToken(body.token);
  if (!token || !["sandbox", "production"].includes(body.environment) || !Array.isArray(body.lines)) return null;
  if (!body.lines.every((line) => typeof line === "string" && APP_LINES.includes(line))) return null;
  let quiet = null;
  if (body.quiet != null) {
    const { from, to } = body.quiet;
    const minute = (value) => Number.isInteger(value) && value >= 0 && value <= 1439;
    if (typeof body.quiet !== "object" || Array.isArray(body.quiet) || !minute(from) || !minute(to)) return null;
    quiet = from === to ? null : { from, to };
  }
  return { token, environment: body.environment, lines: APP_LINES.filter((line) => body.lines.includes(line)), quiet };
}

function makeSubscriptionHandler({ ref, now = () => Date.now() }) {
  return async (request, response) => {
    if (request.method === "DELETE") {
      const token = parseToken(request.body?.token);
      if (!token) return response.status(400).send("bad token");
      await ref().child(subscriberId(token)).remove();
      return response.status(204).end();
    }
    if (request.method !== "PUT") return response.status(405).end();
    const subscription = parseSubscription(request.body);
    if (!subscription) return response.status(400).send("bad subscription");
    const child = ref().child(subscriberId(subscription.token));
    if (subscription.lines.length === 0) {
      await child.remove();
      return response.status(204).end();
    }
    await child.set({
      token: subscription.token,
      environment: subscription.environment,
      lines: subscription.lines,
      quiet: subscription.quiet,
      updatedAt: now(),
    });
    return response.status(204).end();
  };
}

function readSubscribers(value) {
  const subscribers = {};
  for (const [id, record] of Object.entries(value ?? {})) {
    if (!record || !parseToken(record.token) || !["sandbox", "production"].includes(record.environment)) continue;
    const lines = Array.isArray(record.lines) ? record.lines.filter((line) => APP_LINES.includes(line)) : [];
    if (lines.length === 0) continue;
    subscribers[id] = { token: record.token, environment: record.environment, lines, quiet: record.quiet ?? null };
  }
  return subscribers;
}

function blankEntry() {
  return { key: null, material: null, since: 0, notified: {}, pending: {}, clear: 0, recovered: {} };
}

function readState(value) {
  const state = {};
  for (const [line, entry] of Object.entries(value ?? {})) {
    if (!APP_LINES.includes(line) || !entry) continue;
    const key = typeof entry.key === "string" ? entry.key : null;
    const recovered = { ...entry.recovered };
    if (key === null && Object.keys(recovered).length === 0) continue;
    state[line] = {
      key,
      material: typeof entry.material === "string" ? entry.material : null,
      since: entry.since ?? 0,
      notified: { ...entry.notified },
      pending: { ...entry.pending },
      clear: Number.isInteger(entry.clear) && entry.clear > 0 ? entry.clear : 0,
      recovered,
    };
  }
  return state;
}

function storedState(state) {
  const stored = {};
  for (const [line, entry] of Object.entries(state)) {
    stored[line] = { since: entry.since };
    if (entry.key !== null) stored[line].key = entry.key;
    if (entry.material !== null) stored[line].material = entry.material;
    if (entry.clear > 0) stored[line].clear = entry.clear;
    if (Object.keys(entry.notified).length > 0) stored[line].notified = entry.notified;
    if (Object.keys(entry.pending).length > 0) stored[line].pending = entry.pending;
    if (Object.keys(entry.recovered).length > 0) stored[line].recovered = entry.recovered;
  }
  return stored;
}

function isIdle(state, disruptions) {
  const lines = Object.keys(disruptions);
  return lines.length === Object.keys(state).length
    && lines.every((line) => {
      const entry = state[line];
      return entry?.key === disruptions[line].key
        && entry.clear === 0
        && Object.keys(entry.pending).length === 0
        && Object.keys(entry.recovered).length === 0;
    });
}

function advance({ state, disruptions, subscribers, now, limit = MAX_PER_LINE }) {
  const next = {};
  const sends = [];
  const watchers = (line) => Object.entries(subscribers).filter(([, subscriber]) => subscriber.lines.includes(line));
  const follows = (id, line) => Boolean(subscribers[id]?.lines.includes(line));
  for (const [line, disruption] of Object.entries(disruptions)) {
    const current = state[line];
    const active = current?.key != null;
    const entry = {
      key: disruption.key,
      material: disruption.material,
      since: active ? current.since : now,
      notified: { ...current?.notified },
      pending: { ...current?.pending },
      clear: 0,
      recovered: { ...current?.recovered },
    };
    const interested = new Set(watchers(line).map(([id]) => id));
    for (const field of [entry.pending, entry.notified, entry.recovered]) {
      for (const id of Object.keys(field)) if (!interested.has(id)) delete field[id];
    }
    const changed = !active || (current.material !== null && current.material !== disruption.material);
    const targets = changed ? [...interested] : Object.keys(entry.pending);
    let budget = limit;
    for (const id of targets) {
      if (inQuiet(subscribers[id].quiet, now) || budget === 0) {
        entry.pending[id] = true;
      } else {
        budget -= 1;
        const was = { notified: Boolean(entry.notified[id]), recovered: Boolean(entry.recovered[id]) };
        delete entry.pending[id];
        delete entry.recovered[id];
        entry.notified[id] = true;
        sends.push({ id, line, kind: "disrupted", payload: disruptedPayload(disruption), headers: collapseHeaders(line), was });
      }
    }
    next[line] = entry;
  }
  for (const [line, current] of Object.entries(state)) {
    if (disruptions[line]) continue;
    const entry = { ...current, notified: { ...current.notified }, pending: { ...current.pending }, recovered: { ...current.recovered } };
    if (entry.key !== null) {
      if (entry.clear + 1 < CLEAR_RUNS) {
        entry.clear += 1;
        next[line] = entry;
        continue;
      }
      Object.assign(entry.recovered, entry.notified);
      Object.assign(entry, { key: null, material: null, notified: {}, pending: {}, clear: 0 });
    }
    let budget = limit;
    for (const id of Object.keys(entry.recovered)) {
      if (!follows(id, line)) {
        delete entry.recovered[id];
      } else if (!inQuiet(subscribers[id].quiet, now) && budget > 0) {
        budget -= 1;
        delete entry.recovered[id];
        sends.push({ id, line, kind: "normal", payload: normalPayload(line), headers: collapseHeaders(line) });
      }
    }
    if (Object.keys(entry.recovered).length > 0) next[line] = entry;
  }
  return { state: next, sends };
}

function retryable({ status, reason }) {
  return status === 0 || status === 429 || status >= 500 || (status === 403 && PROVIDER_TOKEN_REASONS.includes(reason));
}

function settle(state, sends, responses) {
  const removed = new Set();
  sends.forEach((send, index) => {
    if (!isDeadToken(responses[index])) return;
    removed.add(send.id);
    for (const entry of Object.values(state)) {
      delete entry.notified[send.id];
      delete entry.pending[send.id];
      delete entry.recovered[send.id];
    }
  });
  sends.forEach((send, index) => {
    const response = responses[index];
    if (removed.has(send.id) || response.status === 200) return;
    if (send.kind === "disrupted") {
      const entry = state[send.line];
      if (!send.was?.notified) delete entry.notified[send.id];
      if (!retryable(response)) return;
      entry.pending[send.id] = true;
      if (send.was?.recovered) entry.recovered[send.id] = true;
    } else if (retryable(response)) {
      (state[send.line] ??= blankEntry()).recovered[send.id] = true;
    }
  });
  return [...removed];
}

function tallyFailures(responses) {
  const failures = {};
  for (const response of responses) {
    if (response.status === 200 || isDeadToken(response)) continue;
    const reason = response.reason ? String(response.reason).replace(/[0-9a-f]{32,}/gi, "?").slice(0, 64) : `HTTP ${response.status}`;
    failures[reason] = (failures[reason] ?? 0) + 1;
  }
  return failures;
}

async function inPool(items, size, work) {
  let index = 0;
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, async () => {
    while (index < items.length) {
      const current = index++;
      await work(items[current], current);
    }
  }));
}

async function fetchServiceAlerts(accountKey) {
  const response = await fetch(LTA_URL, {
    headers: { AccountKey: accountKey, accept: "application/json" },
    signal: AbortSignal.timeout(8000),
  });
  if (!response.ok) throw new Error(`LTA ${response.status} for TrainServiceAlerts`);
  return response.json();
}

async function tick({ fetchAlerts, stateRef, subscribersRef, apns, now = () => Date.now(), log = console, limit = MAX_PER_LINE }) {
  let body;
  try {
    body = await fetchAlerts();
  } catch (error) {
    log.warn?.(`Service alerts fetch failed: ${error.message}`);
    return { skipped: "fetch" };
  }
  const parsed = parseAlerts(body);
  if (!parsed.ok) {
    log.warn?.(`Service alerts ignored: ${parsed.reason}`);
    return { skipped: parsed.reason };
  }
  const state = readState((await stateRef.get()).val());
  if (isIdle(state, parsed.disruptions)) return { idle: true, lines: Object.keys(parsed.disruptions) };

  const at = now();
  const subscribers = readSubscribers((await subscribersRef.get()).val());
  const plan = advance({ state, disruptions: parsed.disruptions, subscribers, now: at, limit });
  const writeState = () => stateRef.set(Object.keys(plan.state).length > 0 ? storedState(plan.state) : null);
  const before = canonical(storedState(state));
  const planned = canonical(storedState(plan.state));
  if (before !== planned) await writeState();

  const responses = new Array(plan.sends.length);
  await inPool(plan.sends, SEND_CONCURRENCY, async (send, index) => {
    const subscriber = subscribers[send.id];
    try {
      responses[index] = await apns.send({
        token: subscriber.token,
        environment: subscriber.environment,
        payload: send.payload,
        priority: 10,
        pushType: "alert",
        headers: send.headers,
        id: send.id,
      });
    } catch (error) {
      responses[index] = { status: 0, reason: error.message };
    }
  });
  const removed = settle(plan.state, plan.sends, responses);
  if (removed.length > 0) await subscribersRef.update(Object.fromEntries(removed.map((id) => [id, null])));
  const after = canonical(storedState(plan.state));
  if (after !== planned) await writeState();
  const failures = tallyFailures(responses);
  const failed = Object.values(failures).reduce((total, count) => total + count, 0);
  if (failed > 0) log.warn?.(`Service alert APNs failures ${failed}/${plan.sends.length}: ${JSON.stringify(failures)}`);
  return {
    lines: Object.keys(parsed.disruptions),
    sent: plan.sends.length,
    disrupted: plan.sends.filter((send) => send.kind === "disrupted").length,
    normal: plan.sends.filter((send) => send.kind === "normal").length,
    removed: removed.length,
    failures,
    written: before !== planned || after !== planned,
  };
}

module.exports = {
  APP_LINES,
  parseAlerts,
  minutesOfDay,
  inQuiet,
  disruptedPayload,
  normalPayload,
  subscriberId,
  parseSubscription,
  makeSubscriptionHandler,
  advance,
  settle,
  isIdle,
  fetchServiceAlerts,
  tick,
};
