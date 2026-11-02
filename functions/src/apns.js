const crypto = require("node:crypto");
const http2 = require("node:http2");

const HOSTS = {
  sandbox: "https://api.sandbox.push.apple.com",
  production: "https://api.push.apple.com",
};

function base64url(value) {
  return Buffer.from(value).toString("base64url");
}

class APNs {
  constructor({ key, keyId, teamId, topic }) {
    this.key = key;
    this.keyId = keyId;
    this.teamId = teamId;
    this.topic = topic;
    this.sessions = {};
    this.jwt = null;
    this.jwtAt = 0;
  }

  token() {
    const now = Math.floor(Date.now() / 1000);
    if (this.jwt && now - this.jwtAt < 40 * 60) return this.jwt;
    const header = base64url(JSON.stringify({ alg: "ES256", kid: this.keyId }));
    const claims = base64url(JSON.stringify({ iss: this.teamId, iat: now }));
    const signature = crypto.sign("sha256", Buffer.from(`${header}.${claims}`), {
      key: this.key,
      dsaEncoding: "ieee-p1363",
    });
    this.jwt = `${header}.${claims}.${base64url(signature)}`;
    this.jwtAt = now;
    return this.jwt;
  }

  session(environment) {
    const existing = this.sessions[environment];
    if (existing && !existing.closed && !existing.destroyed) return existing;
    const session = http2.connect(HOSTS[environment]);
    session.on("error", () => session.destroy());
    this.sessions[environment] = session;
    return session;
  }

  send({ token, environment, payload, priority }) {
    const body = JSON.stringify(payload);
    return new Promise((resolve) => {
      const request = this.session(environment).request({
        ":method": "POST",
        ":path": `/3/device/${token}`,
        authorization: `bearer ${this.token()}`,
        "apns-topic": this.topic,
        "apns-push-type": "liveactivity",
        "apns-priority": String(priority),
        "content-type": "application/json",
      });
      let status = 0;
      let data = "";
      request.setEncoding("utf8");
      request.on("response", (headers) => {
        status = headers[":status"];
      });
      request.on("data", (chunk) => {
        data += chunk;
      });
      request.on("end", () => {
        let reason = null;
        try {
          reason = data ? JSON.parse(data).reason : null;
        } catch {}
        resolve({ status, reason });
      });
      request.on("error", (error) => resolve({ status: 0, reason: error.message }));
      request.end(body);
    });
  }

  close() {
    Object.values(this.sessions).forEach((session) => session.close());
    this.sessions = {};
  }
}

class RecordingAPNs {
  constructor(record) {
    this.record = record;
  }

  async send(push) {
    await this.record(push);
    return { status: 200, reason: null };
  }

  close() {}
}

function payloadFor(result, now) {
  const aps = {
    timestamp: Math.floor(now / 1000),
    event: result.action,
    "content-state": result.contentState,
  };
  if (result.staleDate) aps["stale-date"] = Math.floor(result.staleDate / 1000);
  if (result.dismissalDate) aps["dismissal-date"] = Math.floor(result.dismissalDate / 1000);
  return { aps };
}

function isGone({ status, reason }) {
  return status === 410 || (status === 400 && ["BadDeviceToken", "DeviceTokenNotForTopic", "Unregistered"].includes(reason));
}

module.exports = { APNs, RecordingAPNs, payloadFor, isGone };
