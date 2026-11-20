# Live Activity pushes

These Cloud Functions keep SGBusTime's bus Live Activity up to date after the app is closed. The app registers each activity's push token. Every 20 s the server reads LTA's `BusArrival` once for each watched stop. It then sends an ActivityKit push (`apns-push-type: liveactivity`) to every activity watching that stop.

## Functions (`asia-southeast1`)

- **`liveActivity`** (HTTPS)
  - `PUT` with JSON `{id, token, service, stopCode, tracked, since, environment}` adds or refreshes a registration. `id` is the `Activity.id`. `token` is the hex push token. `tracked` and `since` are Unix seconds. `environment` is `sandbox` or `production`.
  - `DELETE ?id=` removes a registration.
  - Registrations are stored in Realtime Database at `/liveActivities/{id}`.
- **`pollLiveActivities`** (scheduled every minute)
  - Polls at 0, 20 and 40 s inside each run. Cloud Scheduler can't fire more often than once a minute.
  - Returns straight away when there are no registrations.
- **`pollNow`** (emulator only): runs one round when you call it, and records its stats like a scheduled run.
- **`serviceAlerts`** and **`pollServiceAlerts`**: train service-alert pushes. See [Service alerts](#service-alerts).
- **`pollServiceAlertsNow`** (emulator only): runs one service-alert tick. A `POST` body shaped like LTA's `TrainServiceAlerts` response is used instead of calling LTA, and `?at=<unix ms>` sets the clock.
- **`ops`** (HTTPS, read-only): aggregates for the NextStopOps console (`missingems/NextStopOps`). See [Ops endpoint](#ops-endpoint).

## Ops endpoint

`GET ops?view=…` with `Authorization: Bearer <OPS_SECRET>`.
- **`summary`**
  - Subscriber counts from a full read of `/liveActivities`: the total, by kind, by environment, the top 25 stops and services, and how many are replaced, retrying their end push or due.
  - Poller stats from `/liveActivityStats`.
- **`routes`**
  - Reads `/serviceStops` and `/busRoutes`.
  - Counts services and directions.
  - Lists services with fewer polylines than stop lists, or with blank polylines. The app indexes past the end of those.
  - Returns a SHA-256 of each path. The keys are sorted, so the console can compare them with its own catalog.
  - Cached for 10 min per instance.
- **`live&service=174&stops=a,b`** (1–6 stops)
  - LTA `BusArrival` for each stop, filtered to the service.
  - Each bus has its ETA (Unix ms), fix (`null` for 0,0 or outside Singapore), monitored flag, visit, origin, destination, load, type and feature.
  - Each stop is fetched at most once per 20 s per instance, with the server's LTA key.

It never returns tokens, activity ids, owners or per-registration timestamps.

**Access.**
- The secret is compared in constant time. With no secret, or one shorter than 16 characters, every request gets 401.
- CORS allows only the origins in `OPS_ORIGINS` (default `https://missingems.github.io`). In the emulator, `http://localhost:*` and `http://127.0.0.1:*` are allowed too.
- A browser request from any other origin gets 403 before anything is read.
- `cors: false` hands preflights to the handler, so the emulator answers them exactly as production does. Without it, the emulator's debug CORS allows every origin.
- `maxInstances: 2`.

**Poll stats.** After every scheduled run, idle runs included, `pollLiveActivities` writes `/liveActivityStats`:
- `last`: the run's time, duration, rounds, registrations read, LTA calls, LTA errors, pushes, push failures (non-200 responses whose token isn't gone), ends, removed, and the error if the run threw.
- `hours/<UTC yyyymmddhh>`: increments of the same counters, plus `runs`, `activeRuns`, `errors` and `peakRegistrations`. Each run deletes the bucket from 48 h earlier.
- A failed stats write is logged and never fails the run.
- The path sits outside `/liveActivities`, because the poller deletes children there that are missing required fields. The root rule already denies client access to it.

## How each round decides what to push

The logic in `src/state.js` mirrors `BusActivityController.state(for:)`.

- **Which bus.** It always shows the earliest bus on the board, skipping any whose arrival is more than 30 s past, with the one after it as `following`. When a bus arrives, the next one takes its place. If a bus drops off LTA's board and comes back, it shows again on the next poll. When no bus is left on the board within a minute of the last arrival, it sends `event: end` with `hasArrived: true` and dismisses after 2 min.
- **When to push.** It pushes only when something visible changes: the ETA moves by 10 s or more, the following bus, load or vehicle changes, or the whole minutes left drop by one. The Live Activity can't count minutes down by itself, so the minute push keeps it showing the same minutes as the app. Pushes that change the minutes shown go out at priority 10, because iOS holds back priority 5 pushes while the phone is locked. The rest stay at priority 5. Otherwise it pushes every 2 min, to move `stale-date` (3 min) forward.
- **Priority.** Updates go out at priority 5 and the end push at priority 10.
- **Who updates the activity.** Once the server has accepted a registration, the app stops updating the activity itself and the server is the only one sending updates. If the activity's `stale-date` gets within a minute (the server pushes at least every 2 min, so normally it doesn't), the app goes back to updating it while it's open. After the server's first push, a re-registration from the app doesn't overwrite the server's tracked arrival time.
- **APNs token.** The token's issue time is rounded down to the last 30-minute mark, and the token is kept for the lifetime of the server instance. Apple rejects tokens that are refreshed more than once every 20 minutes.
- **LTA calls.** At most 8 LTA requests are in flight at a time.
- **Cleanup.**
  - It ends activities older than 2 h, or ones whose tracked time is more than 10 min in the past.
  - It deletes the registration on APNs `410`, `BadDeviceToken`, `DeviceTokenNotForTopic` and `Unregistered`.
  - If the end push fails, it retries it the next round, and gives up after 3 tries.
  - It removes registrations that are missing a required field.
  - Writes use transactions on the registration's push token. A registration deleted during a round isn't recreated, and one re-registered with a new token isn't overwritten.
  - If an LTA call fails, it skips that stop for the round and doesn't end its activities.
- **Push-token changes.** iOS can give the activity a new push token while the app is suspended, and the app can't send it to the server until it runs again. APNs then rejects the old token and the registration is deleted. When the app becomes active again, it re-registers.
- **Payload format.** Dates in `content-state` are seconds since 2001-01-01, which is what ActivityKit's default `JSONDecoder` expects. The APNs `timestamp`, `stale-date` and `dismissal-date` fields are Unix seconds. `since` and `hasArrived` are always sent, because `ContentState`'s synthesized decoder requires them.

## Run locally (emulator, no production access)

```sh
cd functions
npm install
npm test
printf 'LTA_ACCOUNT_KEY=<key>\nAPNS_KEY=mock\nOPS_SECRET=%s\n' "$(openssl rand -hex 24)" > .secret.local
printf 'APNS_KEY_ID=MOCK\n' > .env.local
JAVA_HOME=/opt/homebrew/opt/openjdk@27 npx firebase emulators:start --only functions,database --project demo-sgbustime
```

- **Index rule.** The database emulator may not load `database.rules.json` for the `demo-sgbustime` namespace. Then `pollNow` fails with "Index not defined … nextPollAt". Load the rules by hand: `curl -X PUT -H 'Authorization: Bearer owner' 'http://127.0.0.1:9000/.settings/rules.json?ns=demo-sgbustime' --data-binary @../database.rules.json`.
- **Mock APNs.** `APNS_KEY=mock` records each push under `/liveActivityPushes` instead of sending it. Read them with `curl 'http://127.0.0.1:9000/liveActivityPushes.json?ns=demo-sgbustime'`.
- **Real APNs.** To push to a real device from the emulator, set `APNS_KEY` to the absolute path of the `.p8` and `APNS_KEY_ID` to its Key ID.
- **Point the app at the emulator.** Launch it with `-LiveActivityServer http://127.0.0.1:5001/demo-sgbustime/asia-southeast1/liveActivity`. With no endpoint, the app requests the activity with `pushType: nil`, exactly as before.

## Deploying (needs Jun's go-ahead)

Before deploying:
- The project must be on the Blaze plan. Scheduled functions and calls to LTA and APNs need it.
- The App ID needs the Push Notifications capability.

```sh
firebase functions:secrets:set LTA_ACCOUNT_KEY --project sgbustime-15b1c
firebase functions:secrets:set APNS_KEY --data-file AuthKey_XXXX.p8 --project sgbustime-15b1c
firebase deploy --only functions:live-activity --project sgbustime-15b1c
```

Deploy only these functions with `--only functions:live-activity`.

**Ops endpoint and poll stats.**

Set the secret first.
1. Make a long random value with `openssl rand -hex 24`.
2. Paste it at this command's prompt:

```sh
firebase functions:secrets:set OPS_SECRET --project sgbustime-15b1c
```

3. Paste the same value into the console's Connection card. Keep it in a password manager, not in a file in a repo.

Then deploy only the two functions this change touches:

```sh
firebase deploy --only functions:live-activity:ops,functions:live-activity:pollLiveActivities --project sgbustime-15b1c
```

- This replaces the live poller with this branch's poller: master's code plus the stats write and the failure counter. Check first that what's live is master.
- `ops` uses the existing `LTA_ACCOUNT_KEY` secret.
- Use the URL the deploy prints for `ops`. If the console default (`https://asia-southeast1-sgbustime-15b1c.cloudfunctions.net/ops`) differs, paste the printed URL into Connection. This `firebase.json` deliberately has no database rules, so this deploy can't overwrite the live RTDB rules.

After deploying:
- Set `LiveActivityServer.defaultEndpoint` in the app to the deployed `liveActivity` URL.
- Make sure the live RTDB rules deny client access to `/liveActivities`. The functions use the Admin SDK, so they don't need client access.
- Release builds need `aps-environment` set to `production`. Xcode's automatic signing does this when it archives.

## Service alerts

`pollServiceAlerts` pushes an ordinary alert to subscribed devices when LTA reports a train line disruption, and again when the line is back to normal.

**Endpoint** `serviceAlerts` (HTTPS, `asia-southeast1`, `maxInstances` 5).
- `PUT` JSON `{token, environment, lines, quiet}` stores or replaces the subscription. `token` is the device's APNs token (64–160 hex characters), `environment` is `sandbox` or `production`, `lines` is a subset of `NSL EWL NEL CCL DTL TEL BPL SKL PGL`, and `quiet` is `null` or `{from, to}` in minutes since midnight Singapore time (0–1439, the window may wrap midnight, `from == to` means no window). Empty `lines` deletes the subscription. Replies `204`, or `400` for any invalid field.
- `DELETE` JSON `{token}` removes it. Replies `204`, or `400`. The token is never read from the query string.
- Any other method gets `405`.

**Data stored.** `/serviceAlertSubscribers/<sha256 of the token>` holds the raw token (needed to send), `environment`, `lines`, `quiet` and `updatedAt`, and nothing else. `/serviceAlertState/<line>` holds the current disruption's `key` (a hash of its segments), `material` (a hash of its direction and island-wide flag), `since`, `clear` (consecutive all-clear runs so far) and the hashed ids in `notified`, `pending` and `recovered` (people still owed "back to normal"). The pushes themselves aren't stored.

**Each tick** (every minute, one LTA `TrainServiceAlerts` call, one read of `/serviceAlertState`):
- Segments are grouped per line, with `STL` and `PTL` mapped to the app's `SKL` and `PGL`. A new disruption, or one whose direction or island-wide free bus changes, notifies its subscribers. Edits to the station or free-bus lists only update the stored state.
- Subscribers inside their quiet window are held as `pending` and sent when the window ends, if the disruption is still active.
- A line must be missing from the feed for 2 runs in a row before it counts as back to normal, so a brief flap sends nothing. Then subscribers who were notified get "back to normal". Those in quiet hours, or whose send failed with a retryable error, stay in `recovered` and are sent it as soon as they can be. Anything still pending is dropped. If the line is disrupted again, anyone still owed "back to normal" is sent the new disrupted push instead.
- The new state is written before the pushes go out, so a timeout never repeats a "disrupted" push. Retryable failures are put back in `pending` or `recovered` afterwards. At most 5,000 subscribers per line are handled per run; the rest wait in `pending` or `recovered`.
- It reads `/serviceAlertSubscribers` only when there is something to send, so a tick with no change costs one LTA call and one small read.
- A failed or malformed LTA response, or Status 2 with no usable segments, skips the tick. It is never treated as "back to normal".
- A transient APNs failure (network, 429, 5xx, or a 403 `InvalidProviderToken` or `ExpiredProviderToken`) is retried on the next tick. A `410`, `BadDeviceToken` or `Unregistered` answer removes the subscription, all in one update. Other failures are counted by reason in the tick result and logged as one warning per run.
- Pushes are `apns-push-type: alert`, priority 10, `apns-collapse-id: service-alert-<LINE>`, on the bundle id topic (the `APNS_TOPIC` value without `.push-type.liveactivity`). Titles and subtitles are loc keys, so the device localises them. Station names come from `src/stations.json`, generated from the app's `trains.json`.

**Cost.** One LTA call a minute is about 43,200 a month. It adds one Cloud Scheduler job (3 are free per billing account, then $0.10 a month). Function time is a second or two per run. APNs is free.

**Database rules.** Both paths are server-only. The root rule already denies client access, and `database.rules.json` now also lists them with explicit `false` rules. The functions use the Admin SDK, so they need no client access. Nothing in this deploy publishes rules.

**Deploy** (needs Jun's go-ahead). Only the two new functions:

```sh
firebase deploy --only functions:live-activity:serviceAlerts,functions:live-activity:pollServiceAlerts --project sgbustime-15b1c
```

`firebase.json` names the codebase `live-activity`, so the codebase prefix is needed. `functions:serviceAlerts,functions:pollServiceAlerts` would match nothing. Don't redeploy `pollLiveActivities` from a branch that lacks `claude/ops-endpoint`: it would replace the live poller with one without the stats write. This branch has it.

**Try it locally.** Run the emulator as above. Then:

```sh
curl -X PUT -H 'content-type: application/json' http://127.0.0.1:5001/demo-sgbustime/asia-southeast1/serviceAlerts \
  -d '{"token":"'$(printf 'ab%.0s' {1..32})'","environment":"sandbox","lines":["NEL"],"quiet":null}'
curl -X POST -H 'content-type: application/json' http://127.0.0.1:5001/demo-sgbustime/asia-southeast1/pollServiceAlertsNow \
  -d '{"value":{"Status":2,"AffectedSegments":[{"Line":"NEL","Direction":"Punggol","Stations":"NE1,NE3,NE4","FreePublicBus":"NE1,NE3"}],"Message":[]}}'
curl 'http://127.0.0.1:9000/serviceAlertPushes.json?ns=demo-sgbustime'
```

With `APNS_KEY=mock` the pushes are recorded under `/serviceAlertPushes`. Post `{"value":{"Status":1,"AffectedSegments":[],"Message":[]}}` to send "back to normal".

## Cost and quota of polling

**LTA DataMall**
- **How fast data changes.** The API User Guide v6.11 (30 Oct 2026) lists `BusArrival` with an update frequency of 20 seconds. Polling faster than 20 s only returns the same data again, so `POLL_SECONDS` defaults to 20.
- **Calls.** The server makes one call per distinct stop per round, however many activities watch that stop: 3 calls a minute, or 180 an hour, per active stop.
  - 100 activities spread across 60 stops cost about 10,800 calls an hour.
  - A single activity costs 180 an hour, with a 2 h cap.
- **Limits.** The guide publishes no numeric quota. A data.gov.sg notice says rate limits started rolling out on 1 Sep 2025, with higher limits for registered users. Check the limit on the account before launch.
- **Use a separate key.** The app ships with the account key committed in `Domain.swift`, and every open app already polls with it every 10 s. Give the server its own key, so server traffic doesn't share a quota with every installed app.

**Cloud Functions (2nd gen, 256 MiB / 0.167 vCPU, asia-southeast1)**

These figures use list prices at the time of writing (CPU $0.000024/vCPU-s, memory $0.0000025/GiB-s, monthly free tier 180,000 vCPU-s and 360,000 GiB-s). Check current pricing before relying on them.
- **Idle.** About 43,200 short runs a month (one read, then return), well inside the free 2M invocations and the compute free tier.
- **Active.** While at least one activity exists, one instance runs about 41 s of every minute, whether it serves 1 activity or 500. That is about 410 vCPU-s and 615 GiB-s per active hour.
  - The free tier covers roughly 440 active hours a month.
  - Running around the clock (720 h) comes to about $3 a month.
- **Scheduler.** Cloud Scheduler gives 3 free jobs per billing account, then charges $0.10 per job per month.

**Realtime Database**
- Each round reads `/liveActivities` once, about 400 B per registration, and writes only when something changes.
- 100 concurrent activities read about 7 MB an hour, against 10 GB of free downloads a month.

**APNs** is free. Apple caps how often a Live Activity can be updated.
- The app sets `NSSupportsLiveActivitiesFrequentUpdates` for a larger budget. Users can still turn this off in Settings.
- Because the server only pushes on visible changes, a typical activity gets one push every 20–60 s, and at least one a minute until its last minute.

**Abuse**
- There is no global cap on activities. Registration needs a verified Pro purchase, and each owner holds one activity at a time; a new one ends the old.
- Each round serves the stops that have waited longest first, so if a round runs long under load, no activity is starved.
- Before launch, add App Check, or a shared secret in the app, so that strangers can't run up the LTA quota.
