// Learns a speed/dwell profile from LTA traces and animates a bus with it.
// usage: node calibration/speedmodel.js calibration/data/island.jsonl [calibration/data/fast.jsonl]
const fs = require("node:fs");
const path = require("node:path");
const { APP, cases, score, tracks, routes } = require("./interpolation");

const data = path.join(__dirname, "data");
const T0 = Date.now();
const lap = (label) => console.log(`  [${((Date.now() - T0) / 1000).toFixed(0)}s] ${label}`);

// ---------- geometry (copied helpers; interpolation.js does not export the polyline) ----------
const LAT0 = 1.35 * Math.PI / 180;
const project = ([lat, lng]) => [lng * Math.cos(LAT0) * 111_320, lat * 110_540];
function decode(encoded) {
  const points = [];
  let index = 0, lat = 0, lng = 0;
  while (index < encoded.length) {
    for (const axis of [0, 1]) {
      let result = 0, shift = 0, byte;
      do { byte = encoded.charCodeAt(index++) - 63; result |= (byte & 0x1f) << shift; shift += 5; } while (byte >= 0x20);
      const delta = result & 1 ? ~(result >> 1) : result >> 1;
      if (axis === 0) lat += delta; else lng += delta;
    }
    points.push([lat / 1e5, lng / 1e5]);
  }
  return points;
}

const G = 5; // grid cell, metres
const SETBACK = APP.stopSetback;
const DWELL_SHIFT = 12; // a stop's dwell is counted by the fix interval that crosses mark + 12 m
const SPACING = [200, 350, 600]; // block length classes: <200, <350, <600, >=600
const BBIN = [15, 40, 80, 140, 220]; // distance to the next mark
const ABIN = [15, 40, 80, 140]; // distance since the previous mark
const CBIN = [15, 40, 75]; // turn sharpness (degrees) near the position
const NB = SPACING.length + 1, NBB = BBIN.length, NAB = ABIN.length, NCB = CBIN.length;
const COL_B = NB, COL_A = COL_B + NBB, COL_C = COL_A + NAB, COL_D = COL_C + NCB, NCOL = COL_D + 1;
const binOf = (edges, value) => { for (let i = 0; i < edges.length; i++) if (value < edges[i]) return i; return -1; };

function geometry(polyline, marks, length) {
  const pts = decode(polyline).map(project);
  const along = [0];
  for (let i = 1; i < pts.length; i++) along.push(along[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
  const n = Math.ceil(length / G) + 2;
  const X = new Float64Array(n), Y = new Float64Array(n);
  let seg = 0;
  for (let k = 0; k < n; k++) {
    const s = Math.min(k * G, along[along.length - 1]);
    while (seg < pts.length - 2 && along[seg + 1] < s) seg++;
    const len = along[seg + 1] - along[seg] || 1;
    const t = Math.min(Math.max((s - along[seg]) / len, 0), 1);
    X[k] = pts[seg][0] + (pts[seg + 1][0] - pts[seg][0]) * t;
    Y[k] = pts[seg][1] + (pts[seg + 1][1] - pts[seg][1]) * t;
  }
  const curv = new Float64Array(n);
  const W = 6;
  for (let k = 0; k < n; k++) {
    const a = Math.max(k - W, 0), c = Math.min(k + W, n - 1);
    const x1 = X[k] - X[a], y1 = Y[k] - Y[a], x2 = X[c] - X[k], y2 = Y[c] - Y[k];
    const m = Math.hypot(x1, y1) * Math.hypot(x2, y2);
    curv[k] = m < 1 ? 0 : Math.acos(Math.min(Math.max((x1 * x2 + y1 * y2) / m, -1), 1)) * 180 / Math.PI;
  }
  const turn = new Float64Array(n); // sharpest bend from 30 m behind to 60 m ahead
  for (let k = 0; k < n; k++) { let m = 0; for (let j = Math.max(k - 6, 0); j <= Math.min(k + 12, n - 1); j++) if (curv[j] > m) m = curv[j]; turn[k] = m; }
  const dnext = new Float64Array(n), dprev = new Float64Array(n), gap = new Float64Array(n);
  let j = 0;
  for (let k = 0; k < n; k++) {
    const s = k * G;
    while (j < marks.length && marks[j] < s) j++;
    const next = j < marks.length ? marks[j] : Infinity, prev = j > 0 ? marks[j - 1] : -Infinity;
    dnext[k] = next - s; dprev[k] = s - prev;
    gap[k] = Number.isFinite(next - prev) ? next - prev : 600;
  }
  const cols = new Int16Array(n * 4).fill(-1);
  for (let k = 0; k < n; k++) {
    let sc = SPACING.findIndex((e) => gap[k] < e); if (sc < 0) sc = SPACING.length;
    cols[k * 4] = sc;
    const b = binOf(BBIN, dnext[k]); if (b >= 0) cols[k * 4 + 1] = COL_B + b;
    const a = binOf(ABIN, dprev[k]); if (a >= 0) cols[k * 4 + 2] = COL_A + a;
    const c = turn[k] < CBIN[0] ? -1 : (turn[k] < CBIN[1] ? 0 : (turn[k] < CBIN[2] ? 1 : 2)); if (c >= 0) cols[k * 4 + 3] = COL_C + c;
  }
  return { n, turn, dnext, dprev, gap, cols, marks, length };
}

// ---------- learning ----------
function markCount(marks, s0, s1) { // marks m with s0-12 <= m < s1-12
  const out = [];
  for (let i = 0; i < marks.length; i++) if (marks[i] >= s0 - DWELL_SHIFT && marks[i] < s1 - DWELL_SHIFT) out.push(i);
  return out;
}

function legsOf(trackSets, geos, lanes, from, to) {
  const legs = [];
  for (const [service, list] of Object.entries(trackSets)) {
    const geo = geos[service], marks = lanes[service].marks;
    for (const track of list) {
      let last;
      for (const p of track.points) {
        if (p.at < from || p.at > to) { last = undefined; continue; }
        if (last === undefined) { last = p; continue; }
        if (!p.fresh) continue;
        const dt = (p.at - last.at) / 1000, L = p.s - last.s;
        if (dt <= 120 && L > 3 && L / dt <= 22) {
          const x = new Float64Array(NCOL);
          const c0 = Math.max(Math.floor(last.s / G), 0), c1 = Math.min(Math.floor(p.s / G), geo.n - 1);
          for (let k = c0; k <= c1; k++) {
            const overlap = Math.min(p.s, (k + 1) * G) - Math.max(last.s, k * G);
            if (overlap <= 0) continue;
            for (let c = 0; c < 4; c++) { const col = geo.cols[k * 4 + c]; if (col >= 0) x[col] += overlap; }
          }
          const ms = markCount(marks, last.s, p.s);
          x[COL_D] = ms.length;
          legs.push({ service, s0: last.s, s1: p.s, dt, x, marks: ms });
        }
        last = p;
      }
    }
  }
  return legs;
}

function fit(legs, withDwell) {
  const cols = withDwell ? NCOL : NCOL - 1;
  const A = Array.from({ length: cols }, () => new Float64Array(cols)), h = new Float64Array(cols);
  for (const leg of legs) {
    const w = 1 / leg.dt;
    for (let i = 0; i < cols; i++) { if (!leg.x[i]) continue; h[i] += w * leg.x[i] * leg.dt; for (let j = 0; j < cols; j++) A[i][j] += w * leg.x[i] * leg.x[j]; }
  }
  const mean = A.reduce((a, row, i) => a + row[i], 0) / cols;
  for (let i = SPACING.length + 1; i < cols; i++) A[i][i] += 1e-3 * mean;
  const beta = new Float64Array(cols).fill(0.1);
  for (let it = 0; it < 400; it++) for (let i = 0; i < cols; i++) {
    let r = h[i];
    for (let j = 0; j < cols; j++) if (j !== i) r -= A[i][j] * beta[j];
    beta[i] = Math.max(r / A[i][i], i < NB ? 0.03 : 0);
  }
  return withDwell ? beta : Float64Array.from([...beta, 0]);
}

const dot = (beta, x, skipDwell) => { let t = 0; for (let i = 0; i < (skipDwell ? COL_D : NCOL); i++) t += beta[i] * x[i]; return t; };

// per-segment (100 m) speed ratios and per-stop dwell, for the time split only
const SEG = 100, SHRINK = 2, DWELL_SHRINK = 3;
function tables(legs, beta, stopMode, lanes) {
  const seg = {}, mark = {};
  const num = {}, den = {};
  for (const service of Object.keys(lanes)) {
    const bins = Math.ceil(lanes[service].length / SEG) + 1;
    num[service] = new Float64Array(bins); den[service] = new Float64Array(bins);
    mark[service] = { sum: new Float64Array(lanes[service].marks.length), n: new Float64Array(lanes[service].marks.length) };
  }
  const D = beta[COL_D];
  if (stopMode) for (const leg of legs) {
    if (!leg.marks.length) continue;
    const resid = leg.dt - dot(beta, leg.x, false);
    for (const m of leg.marks) { mark[leg.service].sum[m] += resid / leg.marks.length; mark[leg.service].n[m]++; }
  }
  const markD = {};
  for (const service of Object.keys(lanes)) markD[service] = Float64Array.from(mark[service].sum, (sum, i) => Math.max(D + sum / (mark[service].n[i] + DWELL_SHRINK), 0));
  for (const leg of legs) {
    const moving = stopMode ? leg.dt - leg.marks.reduce((a, m) => a + markD[leg.service][m], 0) : leg.dt;
    const pred = dot(beta, leg.x, true);
    const L = leg.s1 - leg.s0;
    for (let b = Math.floor(leg.s0 / SEG); b <= Math.floor(leg.s1 / SEG); b++) {
      const overlap = Math.min(leg.s1, (b + 1) * SEG) - Math.max(leg.s0, b * SEG);
      if (overlap <= 0) continue;
      num[leg.service][b] += Math.max(moving, 1) * overlap / L; den[leg.service][b] += pred * overlap / L;
    }
  }
  for (const service of Object.keys(lanes)) {
    const d0 = SEG * 0.12;
    seg[service] = Float64Array.from(num[service], (v, i) => Math.min(Math.max((v + SHRINK * d0) / (den[service][i] + SHRINK * d0), 0.5), 2));
  }
  return { seg, markD };
}

// ---------- profile ----------
function profile(service, geo, lane, learned, mode, useTables) {
  const beta = mode === "stop" ? learned.betaStop : learned.betaSmear;
  const slow = new Float64Array(geo.n);
  const tb = useTables ? learned[mode].tables : undefined;
  for (let k = 0; k < geo.n; k++) {
    let w = 0;
    for (let c = 0; c < 4; c++) { const col = geo.cols[k * 4 + c]; if (col >= 0) w += beta[col]; }
    if (tb) w *= tb.seg[service]?.[Math.floor(k * G / SEG)] ?? 1;
    slow[k] = Math.max(w, 1 / APP.maximumBusSpeed);
  }
  const cum = new Float64Array(geo.n + 1);
  for (let k = 0; k < geo.n; k++) cum[k + 1] = cum[k] + slow[k] * G;
  const stops = [];
  if (mode === "stop") lane.marks.forEach((m, i) => stops.push({ pos: m - SETBACK, mark: m, D: tb ? tb.markD[service]?.[i] ?? beta[COL_D] : beta[COL_D] }));
  return { n: geo.n, slow, cum, stops, marks: lane.marks };
}

function flatten(profiles, speed) {
  return Object.fromEntries(Object.entries(profiles).map(([service, P]) => {
    const slow = new Float64Array(P.n).fill(1 / speed), cum = new Float64Array(P.n + 1);
    for (let k = 0; k < P.n; k++) cum[k + 1] = cum[k] + slow[k] * G;
    return [service, { ...P, slow, cum, stops: [] }];
  }));
}

// ---------- predictor ----------
const VMAX = APP.maximumBusSpeed;
const PSTEP = 0.2;
const REACHED = 15;
const timeToGo = (P, s, goal) => {
  const k0 = Math.min(Math.floor(s / G), P.n - 1), k1 = Math.min(Math.floor(goal / G), P.n - 1);
  let t = (P.cum[k1] - P.cum[k0]) ;
  for (const stop of P.stops) if (stop.pos > s && stop.pos < goal - 1) t += stop.D;
  return t;
};

function init(point, index, kappa) {
  return { s: point.s, v: 0, dwellUntil: 0, reported: point.s, prevAt: point.at, prevS: point.s, eta: point.etas[index], scale: kappa, stopIdx: 0, pace: 1, paceAt: -1e18, show: point.s, showV: 0 };
}

// The "shadow" bus dead-reckons from the last fresh fix with the learned profile; the shown bus eases toward it.
function stepShadow(b, dt, now, goal, P, p, variant) {
  if (b.dwellUntil > now) { b.v = 0; return; }
  const s = b.s;
  const k = Math.min(Math.floor(s / G), P.n - 1);
  let mult = b.scale;
  if (variant === "c" && b.eta !== undefined && goal > s) {
    if (now - b.paceAt >= 1000) {
      b.paceAt = now;
      const desired = (b.eta - now) / 1000 + p.lead;
      if (desired > 8) {
        const f = Math.min(Math.max(timeToGo(P, s, goal) / desired, p.pmin), 2.5);
        b.pace = Math.exp((1 - p.gamma) * Math.log(Math.max(b.scale, 0.25)) + p.gamma * Math.log(f));
      } else b.pace = desired > 0 ? b.scale : p.pmin;
    }
    mult = b.pace;
  }
  let target = Math.min(mult / P.slow[k], VMAX);
  let brake = goal;
  while (b.stopIdx < P.stops.length && (P.stops[b.stopIdx].pos <= s + 0.5 || P.stops[b.stopIdx].pos < b.reported - 10)) b.stopIdx++;
  const stop = b.stopIdx < P.stops.length ? P.stops[b.stopIdx] : undefined;
  const halting = stop !== undefined && stop.pos < goal - 1 && stop.D >= p.minDwell;
  if (halting) brake = stop.pos;
  target = Math.min(target, Math.sqrt(2 * p.brake * Math.max(brake - s, 0)));
  b.v = target > b.v ? Math.min(b.v + p.accel * dt, target) : Math.max(b.v - p.follow * dt, target);
  b.s = Math.min(s + b.v * dt, Math.max(brake, s));
  if (halting && stop.pos - b.s < 0.5) { b.s = stop.pos; b.v = 0; b.dwellUntil = now + stop.D * 1000; b.stopIdx++; }
}

function stepShown(b, dt, goal, p) {
  const target = Math.min(Math.max(b.v + (b.s - b.show) / p.tau, p.floor * b.v), p.cap);
  const limited = Math.min(target, Math.sqrt(2 * p.brake * Math.max(goal - b.show, 0)));
  b.showV = limited > b.showV ? Math.min(b.showV + p.catchUp * dt, limited) : Math.max(b.showV - p.follow * 2 * dt, limited);
  b.show = Math.min(b.show + b.showV * dt, Math.max(goal, b.show));
}

function onFix(b, point, index, P, p, now) {
  const dt = (point.at - b.prevAt) / 1000;
  if (point.fresh) {
    const k0 = Math.min(Math.floor(b.prevS / G), P.n - 1), k1 = Math.min(Math.floor(point.s / G), P.n - 1);
    let expected = P.cum[k1] - P.cum[k0];
    for (const stop of P.stops) if (stop.mark - DWELL_SHIFT >= b.prevS && stop.mark - DWELL_SHIFT < point.s) expected += stop.D;
    if (dt > 0 && point.s > b.prevS + 3) b.scale = Math.min(Math.max(b.scale + p.alpha * (Math.min(Math.max(expected / dt, 0.25), 2.2) - b.scale), 0.3), 1.8);
    b.prevAt = point.at; b.prevS = point.s;
  }
  const dwelling = b.dwellUntil > now;
  if (point.fresh) {
    if (dwelling && point.s - b.s <= p.abort) {
      /* still at the stop */
    } else {
      b.dwellUntil = 0;
      const k = Math.min(Math.floor(point.s / G), P.n - 1);
      b.s = point.s + p.lag * Math.min(b.scale / P.slow[k], VMAX) * 0.5;
      b.reported = point.s;
      b.stopIdx = 0;
    }
  } else if (dwelling && Math.abs(point.s - b.s) < 35) b.dwellUntil = Math.max(b.dwellUntil, now + p.hold * 1000);
  if (point.etas[index]) b.eta = point.etas[index];
}

function replayModel(scenario, P, p, variant) {
  const { points, goal, index, arrival, dropped } = scenario;
  const b = init(points[0], index, p.kappa);
  const errors = [];
  let reached, shortfall, now = points[0].at, stalled = 0, moving = 0, stalledPre = 0, movingPre = 0;
  for (let i = 1; i < points.length; i++) {
    const point = points[i];
    const pace = (point.s - points[i - 1].s) / ((point.at - points[i - 1].at) / 1000);
    while (now < point.at) {
      stepShadow(b, PSTEP, now, goal, P, p, variant);
      stepShown(b, PSTEP, goal, p);
      now += PSTEP * 1000;
      if (pace > 3) { moving += PSTEP; if (b.showV < 0.3) stalled += PSTEP; if (reached === undefined) { movingPre += PSTEP; if (b.showV < 0.3) stalledPre += PSTEP; } }
      if (reached === undefined && b.show >= goal - REACHED) reached = now;
      if (shortfall === undefined && dropped !== undefined && now >= dropped) shortfall = Math.max(goal - b.show, 0);
    }
    if (point.fresh && point.at <= arrival) errors.push(b.show - point.s);
    onFix(b, point, index, P, p, now);
  }
  return { errors, arrivalError: reached === undefined ? undefined : (reached - arrival) / 1000, shortfall, stalled, moving, stalledPre, movingPre };
}

const quantile = (values, q) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length ? sorted[Math.min(Math.floor(q * sorted.length), sorted.length - 1)] : NaN;
};

function scoreModel(scenarios, profiles, p, variant) {
  const errors = [], arrivals = [], shortfalls = [];
  let stalled = 0, moving = 0, missed = 0, stalledPre = 0, movingPre = 0;
  for (const scenario of scenarios) {
    const r = replayModel(scenario, profiles[scenario.service], p, variant);
    errors.push(...r.errors);
    if (r.arrivalError === undefined) missed++; else arrivals.push(r.arrivalError);
    if (r.shortfall !== undefined) shortfalls.push(r.shortfall);
    stalled += r.stalled; moving += r.moving; stalledPre += r.stalledPre; movingPre += r.movingPre;
  }
  const absolute = errors.map(Math.abs);
  return {
    cases: scenarios.length, polls: errors.length,
    meanError: absolute.reduce((a, b) => a + b, 0) / absolute.length,
    medianError: quantile(absolute, 0.5), p90Error: quantile(absolute, 0.9),
    ahead: quantile(errors, 0.9), behind: quantile(errors, 0.1),
    arrivalMedian: quantile(arrivals, 0.5), arrivalP90: quantile(arrivals.map(Math.abs), 0.9),
    missed, dropped: shortfalls.length,
    leftEarly: shortfalls.filter((m) => m > 30).length / Math.max(shortfalls.length, 1),
    stalled: stalled / Math.max(moving, 1), stalledPre: stalledPre / Math.max(movingPre, 1),
  };
}

const cost = (r) => r.meanError + 0.3 * r.p90Error + 3 * r.arrivalP90 + 1000 * r.missed / r.cases + 300 * r.stalled + 1000 * r.leftEarly;

// ---------- tuning ----------
const DEFAULTS = { tau: 10, accel: 1.0, catchUp: 3, follow: 2.0, brake: 1.3, minDwell: 4, alpha: 0.35, gamma: 0.5, lead: 65, abort: 40, hold: 8, lag: 0, kappa: 1, cap: VMAX, floor: 0, pmin: 0.35 };
const GRID = {
  tau: [2, 4, 8, 15, 25, 40], accel: [0.6, 1.0, 1.6], catchUp: [1.5, 3, 5, 8], lag: [0, 5, 10, 20], kappa: [0.55, 0.7, 0.8, 0.9, 1, 1.1, 1.25], floor: [0, 0.25, 0.5], cap: [8, 11, 15, VMAX], follow: [1.3, 2.0, 3.0, 5.0], brake: [0.9, 1.3, 1.8], minDwell: [4, 8, 1e9],
  hold: [0, 8, 16], abort: [25, 40, 80],
  alpha: [0.1, 0.2, 0.35, 0.6, 0.85],
  gamma: [0.25, 0.5, 0.75, 1],
  lead: [25, 40, 50, 56.5, 65, 75, 90],
  pmin: [0.02, 0.1, 0.2, 0.35],
};

const keysFor = (mode) => mode === "stop" ? ["kappa", "tau", "catchUp", "cap", "floor", "lag", "accel", "follow", "brake", "minDwell", "hold", "abort"] : ["kappa", "tau", "catchUp", "cap", "floor", "lag", "accel", "follow", "brake"];

function tune(scenarios, profilesFor, variant, start, keys) {
  let best = { ...start }, bestCost = cost(scoreModel(scenarios, profilesFor(best), best, variant));
  for (let pass = 0; pass < 2; pass++) for (const key of keys) for (const value of GRID[key]) {
    if (value === best[key]) continue;
    const candidate = { ...best, [key]: value };
    const c = cost(scoreModel(scenarios, profilesFor(candidate), candidate, variant));
    if (c < bestCost - 0.01) { best = candidate; bestCost = c; }
  }
  return best;
}

function leadOf(scenarios) {
  const lead = [];
  for (const sc of scenarios) for (const point of sc.points) if (point.etas[sc.index] && point.at < sc.arrival) lead.push((sc.arrival - point.etas[sc.index]) / 1000);
  return quantile(lead, 0.5);
}

// reference: hold the last fresh fix and drift at a constant speed (no map knowledge)
function naive(scenarios, v) {
  const errs = [];
  for (const c of scenarios) {
    let last = c.points[0];
    for (let i = 1; i < c.points.length; i++) {
      const p = c.points[i];
      if (!p.fresh) continue;
      if (p.at <= c.arrival) errs.push(Math.abs(last.s + v * (p.at - last.at) / 1000 - p.s));
      last = p;
    }
  }
  return `median ${quantile(errs, 0.5).toFixed(0)} / p90 ${quantile(errs, 0.9).toFixed(0)}`;
}

// ---------- reporting ----------
const f = (v, d = 1) => (Number.isFinite(v) ? v.toFixed(d) : "-");
function printRow(label, r) {
  console.log(`${label.padEnd(34)} ${f(r.medianError).padStart(7)} ${f(r.p90Error).padStart(7)} ${f(r.arrivalMedian).padStart(7)} ${f(r.arrivalP90).padStart(7)} ${String(r.missed).padStart(6)} ${f(r.leftEarly * 100, 0).padStart(6)}% ${f(r.stalled * 100, 1).padStart(6)}% ${f(cost(r), 0).padStart(6)}`);
}
const header = () => console.log(`${"model".padEnd(34)} ${"medErr".padStart(7)} ${"p90Err".padStart(7)} ${"arrMed".padStart(7)} ${"arrP90".padStart(7)} ${"missed".padStart(6)} ${"early".padStart(7)} ${"stall".padStart(7)} ${"cost".padStart(6)}`);

function load(file) { return fs.readFileSync(file, "utf8").trim().split("\n").map((line) => JSON.parse(line)); }

function prepare(rows, services) {
  const lanes = routes(services);
  const polylines = JSON.parse(fs.readFileSync(path.join(data, "busRoutes.json"), "utf8"));
  const geos = Object.fromEntries(services.map((s) => [s, geometry(polylines[s][0], lanes[s].marks, lanes[s].length)]));
  const trackSets = Object.fromEntries(services.map((s) => [s, tracks(rows.filter((r) => r.service === s), lanes[s])]));
  return { lanes, geos, trackSets, services };
}

function learn(prep, legsSel, withTables) {
  const legs = legsSel;
  const betaStop = fit(legs, true), betaSmear = fit(legs, false);
  const learned = { betaStop, betaSmear, legs: legs.length };
  learned.stop = { tables: tables(legs, betaStop, true, prep.lanes) };
  learned.smear = { tables: tables(legs, betaSmear, false, prep.lanes) };
  return learned;
}

function describe(prep, legs, learned) {
  const speeds = legs.map((l) => (l.s1 - l.s0) / l.dt);
  console.log(`legs (fresh fix to next fresh fix): ${legs.length}; speed m/s p10/p25/median/p75/p90 = ${[0.1, 0.25, 0.5, 0.75, 0.9].map((q) => f(quantile(speeds, q))).join(" / ")} (km/h median ${f(quantile(speeds, 0.5) * 3.6, 0)})`);
  const b = learned.betaStop;
  const base = b.slice(0, NB);
  console.log(`free speed by block length (stop-mode fit, m/s): ${SPACING.map((e, i) => `<${e}m ${f(1 / base[i])}`).join(", ")}, >=${SPACING[SPACING.length - 1]}m ${f(1 / base[NB - 1])}`);
  const ref = base[2];
  const eff = (extra) => f(1 / (ref + extra));
  console.log(`speed approaching a mark (blocks 350-600 m), by distance to it: ${BBIN.map((e, i) => `<${e}m ${eff(b[COL_B + i])}`).join(", ")}`);
  console.log(`speed leaving a mark, by distance since it: ${ABIN.map((e, i) => `<${e}m ${eff(b[COL_A + i])}`).join(", ")}`);
  const bends = CBIN.map((lo, i) => `${lo}-${i + 1 < CBIN.length ? CBIN[i + 1] : 180}deg ${eff(b[COL_C + i])}`).join(", ");
  console.log(`speed through bends (sharpest turn within -30..+60 m of the position; free ${eff(0)}): ${bends}`);
  const lossB = BBIN.reduce((t, e, i) => t + (e - (i ? BBIN[i - 1] : 0)) * b[COL_B + i], 0), lossA = ABIN.reduce((t, e, i) => t + (e - (i ? ABIN[i - 1] : 0)) * b[COL_A + i], 0);
  console.log(`time lost per mark passed vs free speed: ${f(lossB)} s approaching + ${f(lossA)} s leaving = ${f(lossB + lossA)} s (mean over served and unserved passes); extra s/m approaching ${[...b.slice(COL_B, COL_B + NBB)].map((v) => v.toFixed(3)).join("/")}, leaving ${[...b.slice(COL_A, COL_A + NAB)].map((v) => v.toFixed(3)).join("/")}, bends ${[...b.slice(COL_C, COL_C + NCB)].map((v) => v.toFixed(3)).join("/")}`);
  console.log(`fitted expected dwell per mark crossed (all passes incl. unserved): ${f(b[COL_D])} s`);
  const md = Object.values(learned.stop.tables.markD).flatMap((a) => [...a]);
  console.log(`per-mark dwell (time-split tables): p10/median/p90 = ${[0.1, 0.5, 0.9].map((q) => f(quantile(md, q))).join(" / ")} s`);
}

// Stationary stretches (fresh fix, then polls that did not move > 3 m) at stop marks versus mid-block control points.
// A stretch >= 30 s is longer than the usual LTA position staleness, so it is the dwell evidence that survives.
function dwellStats(trackSets, lanes) {
  const out = { mark: { passes: 0, any: 0, long: 0, durs: [] }, mid: { passes: 0, any: 0, long: 0, durs: [] } };
  for (const [service, list] of Object.entries(trackSets)) {
    const marks = lanes[service].marks;
    const mids = marks.slice(1).map((m, i) => (m + marks[i]) / 2).filter((m, i) => marks[i + 1] - marks[i] > 300);
    for (const track of list) {
      const pts = track.points;
      if (!pts.length) continue;
      const runs = [];
      for (let i = 0; i < pts.length; i++) {
        if (!pts[i].fresh) continue;
        let k = i;
        while (k + 1 < pts.length && !pts[k + 1].fresh) k++;
        if (k > i) runs.push({ s: pts[i].s, dur: (pts[k].at - pts[i].at) / 1000 });
      }
      for (const [key, positions] of [["mark", marks], ["mid", mids]]) for (const m of positions) {
        if (pts[0].s > m - 30 || pts[pts.length - 1].s < m + 30) continue;
        const near = runs.filter((r) => Math.abs(r.s - m) < 30);
        const longest = near.reduce((a, r) => Math.max(a, r.dur), 0);
        out[key].passes++;
        if (longest > 0) out[key].any++;
        if (longest >= 30) { out[key].long++; out[key].durs.push(longest); }
      }
    }
  }
  return out;
}
const dwellLine = (d) => `stretch >= 30 s: ${f(d.mark.long / d.mark.passes * 100, 0)}% of ${d.mark.passes} mark passes vs ${f(d.mid.long / d.mid.passes * 100, 0)}% of ${d.mid.passes} mid-block control points (median ${f(quantile(d.mark.durs, 0.5), 0)} s, p90 ${f(quantile(d.mark.durs, 0.9), 0)} s at marks); any stationary poll: ${f(d.mark.any / d.mark.passes * 100, 0)}% vs ${f(d.mid.any / d.mid.passes * 100, 0)}%`;

function runSplits(file) {
  console.log(`== ${path.basename(file)}`);
  const rows = load(file);
  const services = [...new Set(rows.map((r) => r.service))].sort();
  const holdout = new Set(services.filter((_, i) => i % 3 === 2));
  const startAt = Math.min(...rows.map((r) => r.at));
  const splitAt = startAt + 35 * 60_000;
  const prep = prepare(rows, services);
  lap("routes, geometry, tracks");
  const all = cases(services, rows);
  lap(`${all.length} cases`);

  // ---- cross-service ----
  const trainSvc = services.filter((s) => !holdout.has(s));
  const trainTracks = Object.fromEntries(trainSvc.map((s) => [s, prep.trackSets[s]]));
  const legsCross = legsOf(trainTracks, prep.geos, prep.lanes, -Infinity, Infinity);
  const learnedCross = learn(prep, legsCross);
  const trainCases = all.filter((c) => !holdout.has(c.service)), testCross = all.filter((c) => holdout.has(c.service));
  console.log(`\n-- learned profile (cross-service training: ${trainSvc.join(",")}; ${legsCross.length} legs)`);
  describe(prep, legsCross, learnedCross);
  const leadCross = leadOf(trainCases);
  console.log(`ETA lead: GPS crossing minus LTA ETA, median ${f(leadCross)} s (train cases)`);
  console.log(`dwell evidence at 20 s polls, ${dwellLine(dwellStats(prep.trackSets, prep.lanes))}`);

  const family = (learned, useTables, mode) => {
    const cache = new Map();
    return (p) => { // profiles only depend on mode, not on tuned params
      if (!cache.has(mode)) cache.set(mode, Object.fromEntries(services.map((s) => [s, profile(s, prep.geos[s], prep.lanes[s], learned, mode, useTables)])));
      return cache.get(mode);
    };
  };
  const tuneSet = (cases_, learned, useTables, label) => {
    const out = {};
    const sub = cases_.filter((_, i) => i % 2 === 0);
    let best;
    for (const mode of ["smear", "stop"]) {
      const forMode = family(learned, useTables, mode);
      const pfor = () => forMode();
      let start = { ...DEFAULTS, lead: leadCross };
      const keysA = keysFor(mode);
      const pa = tune(sub, pfor, "a", start, keysA);
      const ca = cost(scoreModel(sub, pfor(), pa, "a"));
      if (!best || ca < best.cost) best = { mode, cost: ca, pa };
    }
    const forMode = family(learned, useTables, best.mode), pfor = () => forMode();
    const pb = tune(sub, pfor, "b", best.pa, ["alpha"]);
    const pc = tune(sub, pfor, "c", { ...pb, gamma: 0.5 }, ["gamma", "lead", "pmin", ...keysFor(best.mode), "gamma", "lead", "pmin"]);
    out.mode = best.mode; out.a = best.pa; out.b = pb; out.c = pc; out.profiles = forMode();
    lap(`${label}: tuned (mode ${best.mode})`);
    return out;
  };

  const results = {};
  const tuned = tuneSet(trainCases, learnedCross, false, "cross-service");
  const rowsOut = [];
  rowsOut.push(["app baseline (score(APP))", score(testCross, APP)]);
  rowsOut.push([`(a) pure learned profile [${tuned.mode}]`, scoreModel(testCross, tuned.profiles, tuned.a, "a")]);
  rowsOut.push(["(b) + per-bus speed ratio", scoreModel(testCross, tuned.profiles, tuned.b, "b")]);
  rowsOut.push(["(c) + ETA pacing", scoreModel(testCross, tuned.profiles, tuned.c, "c")]);
  console.log(`\n== Cross-service: train ${trainSvc.join(",")} -> test ${[...holdout].join(",")} (${testCross.length} cases)`);
  console.log(`tuned: ${JSON.stringify(tuned.c)}`);
  console.log(`reference, constant-speed dead reckoning from last fresh fix (m): stay ${naive(testCross, 0)}; 3 m/s ${naive(testCross, 3)}; 4 m/s ${naive(testCross, 4)}; 5 m/s ${naive(testCross, 5)}`);
  header();
  for (const [label, r] of rowsOut) printRow(label, r);
  const meanSpeed = legsCross.reduce((a, l) => a + (l.s1 - l.s0), 0) / legsCross.reduce((a, l) => a + l.dt, 0);
  const flat = flatten(tuned.profiles, meanSpeed);
  const flatSub = trainCases.filter((_, i) => i % 2 === 0);
  const flatC = tune(flatSub, () => flat, "c", tuned.c, ["kappa", "tau", "alpha", "gamma", "lag", "floor"]);
  printRow(`ablation: (c) flat ${f(meanSpeed)} m/s, retuned`, scoreModel(testCross, flat, flatC, "c"));
  results.cross = { learned: learnedCross, tuned, lead: leadCross };

  // ---- time split ----
  const legsTime = legsOf(prep.trackSets, prep.geos, prep.lanes, -Infinity, splitAt);
  const learnedTime = learn(prep, legsTime);
  const trainTime = all.filter((c) => c.points[c.points.length - 1].at <= splitAt);
  const testTime = all.filter((c) => c.points[0].at >= splitAt);
  const leadTime = leadOf(trainTime);
  const tunedF = tuneSet(trainTime, learnedTime, false, "time split (features)");
  const tunedT = tuneSet(trainTime, learnedTime, true, "time split (+segment tables)");
  console.log(`\n== Time split: train first 35 min (${legsTime.length} legs, ${trainTime.length} cases) -> test last 15 min (${testTime.length} cases, all ${services.length} services)`);
  console.log(`reference, constant-speed dead reckoning (m): stay ${naive(testTime, 0)}; 3 m/s ${naive(testTime, 3)}; 4 m/s ${naive(testTime, 4)}; 5 m/s ${naive(testTime, 5)}`);
  header();
  printRow("app baseline (score(APP))", score(testTime, APP));
  for (const [tag, t, tab] of [["features only", tunedF], ["+ segment/stop tables", tunedT]]) {
    printRow(`(a) ${tag} [${t.mode}]`, scoreModel(testTime, t.profiles, t.a, "a"));
    printRow(`(b) ${tag}`, scoreModel(testTime, t.profiles, t.b, "b"));
    printRow(`(c) ${tag}`, scoreModel(testTime, t.profiles, t.c, "c"));
  }
  results.time = { learned: learnedTime, tunedF, tunedT, lead: leadTime };
  return { prep, services, results, all };
}

function subsample(rows, k) {
  const ats = [...new Set(rows.map((r) => r.at))].sort((a, b) => a - b);
  const keep = new Set(ats.filter((_, i) => i % k === 0));
  return rows.filter((r) => keep.has(r.at));
}

function runFast(file, main) {
  console.log(`\n== ${path.basename(file)} refresh interval study (models learned on island, services 2 and 7 tested)`);
  const rows = load(file);
  const services = [...new Set(rows.map((r) => r.service))].sort();
  const ats = [...new Set(rows.map((r) => r.at))].sort((a, b) => a - b);
  console.log(`rounds ${ats.length}, ${((ats[ats.length - 1] - ats[0]) / 60000).toFixed(1)} min, every ${f((ats[1] - ats[0]) / 1000, 1)} s`);
  const prep = prepare(rows, services);
  // models learned on the island data: features-only learned without 2 and 7; with-tables learned on all island services
  const mp = main.prep;
  const legsFeat = legsOf(Object.fromEntries(Object.entries(mp.trackSets).filter(([s]) => !services.includes(s))), mp.geos, mp.lanes, -Infinity, Infinity);
  const legsAll = legsOf(mp.trackSets, mp.geos, mp.lanes, -Infinity, Infinity);
  const learnedF = learn(mp, legsFeat), learnedT = learn(mp, legsAll);
  const mkProfiles = (learned, useTables, mode) => Object.fromEntries(services.map((s) => [s, profile(s, mp.geos[s], mp.lanes[s], learned, mode, useTables)]));
  const cross = main.results.cross.tuned, time = main.results.time.tunedT;
  console.log(`dwell evidence at 5 s polls, ${dwellLine(dwellStats(prep.trackSets, prep.lanes))}`);
  const gaps = [];
  for (const list of Object.values(prep.trackSets)) for (const t of list) { let last; for (const pt of t.points) if (pt.fresh) { if (last) gaps.push((pt.at - last) / 1000); last = pt.at; } }
  console.log(`LTA position update cadence (gap between fresh fixes, 5 s polls): p10/p25/median/p75/p90 = ${[0.1, 0.25, 0.5, 0.75, 0.9].map((q) => f(quantile(gaps, q), 0)).join("/")} s`);
  header();
  for (const k of [1, 2, 4]) {
    const sub = subsample(rows, k);
    const scn = cases(services, sub);
    printRow(`${5 * k}s app baseline (${scn.length} cases)`, score(scn, APP));
    printRow(`${5 * k}s (c) feature model`, scoreModel(scn, mkProfiles(learnedF, false, cross.mode), cross.c, "c"));
    printRow(`${5 * k}s (b) feature model`, scoreModel(scn, mkProfiles(learnedF, false, cross.mode), cross.b, "b"));
    printRow(`${5 * k}s (c) island tables`, scoreModel(scn, mkProfiles(learnedT, true, time.mode), time.c, "c"));
    printRow(`${5 * k}s (b) island tables`, scoreModel(scn, mkProfiles(learnedT, true, time.mode), time.b, "b"));
  }
}

module.exports = { load, prepare, learn, legsOf, profile, scoreModel, replayModel, cost, DEFAULTS, tune, leadOf, geometry, subsample };

if (require.main === module) {
  const file = process.argv[2];
  if (!file) throw new Error("usage: node calibration/speedmodel.js <island.jsonl> [fast.jsonl]");
  const main = runSplits(path.resolve(file));
  if (process.argv[3]) runFast(path.resolve(process.argv[3]), main);
  lap("done");
}
