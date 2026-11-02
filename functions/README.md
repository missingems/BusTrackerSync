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
- **`pollNow`** (emulator only): runs one round when you call it.

## How each round decides what to push

The logic in `src/state.js` mirrors `BusActivityController.state(for:)`.

- **Which bus.** It follows the bus whose arrival is closest to the one it is tracking. When the tracked bus drops off the board within a minute of arriving, it sends `event: end` with `hasArrived: true` and dismisses after 2 min.
- **When to push.** It pushes only when something visible changes: the ETA moves by 10 s or more, or the following bus, load or vehicle changes. Otherwise it pushes every 2 min, to move `stale-date` (3 min) forward.
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
printf 'LTA_ACCOUNT_KEY=<key>\nAPNS_KEY=mock\n' > .secret.local
printf 'APNS_KEY_ID=MOCK\n' > .env.local
JAVA_HOME=/opt/homebrew/opt/openjdk@27 npx firebase emulators:start --only functions,database --project demo-sgbustime
```

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

Deploy only these functions with `--only functions:live-activity`. This `firebase.json` deliberately has no database rules, so this deploy can't overwrite the live RTDB rules.

After deploying:
- Set `LiveActivityServer.defaultEndpoint` in the app to the deployed `liveActivity` URL.
- Make sure the live RTDB rules deny client access to `/liveActivities`. The functions use the Admin SDK, so they don't need client access.
- Release builds need `aps-environment` set to `production`. Xcode's automatic signing does this when it archives.

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
- Because the server only pushes on visible changes, a typical activity gets one push every 20–60 s.

**Abuse**
- The register endpoint is unauthenticated. Abuse is capped by input validation, `MAX_ACTIVITIES` (default 500) and the 2 h lifetime.
- Before launch, add App Check, or a shared secret in the app, so that strangers can't run up the LTA quota.
