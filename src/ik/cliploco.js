// SPDX-License-Identifier: GPL-3.0-or-later
// Clip-driven legs for the tracked avatar (docs/IK.md "Legs"). The CharacterCreator locomotion clips
// (vendor/cc/animation/clips.js: walk, run, walk_back, strafe_left, strafe_right, fall, jump, idle variants) are
// sampled ONCE per body into small tables (leg shape per phase), then blended per frame without allocating:
//   - which clips: a 4-direction blend (forward / back / left / right) of the tracked velocity relative to the
//     body facing, walk -> run by speed;
//   - phase: one shared normalised phase advanced by the blended cycle rate (all loop clips plant the left foot
//     at phase 0 and the right one at ~0.5, so they blend without crossing feet);
//   - stride: the horizontal swing is scaled down at low speed (the playback rate is not slowed below ~55%, so
//     slow walking keeps a natural cadence with shorter steps instead of slow motion).
// The solver (src/ik/vrik.js) only takes the leg SHAPE from the clips: the horizontal ankle offset from the hip
// joint, the ankle height above the floor, the knee direction and the foot/toe rotations. The pelvis height
// stays the tracked one (it comes from the head), and the feet are planted/locked by the solver.
import { CLIPS, makeContext } from '../../vendor/cc/animation/clips.js';
import { poseToWorld, fkPositions } from '../../vendor/cc/animation/canonical.js';
import * as M from './pm.js';

export const LOCO_CLIPS = ['walk', 'run', 'walk_back', 'strafe_left', 'strafe_right'];
export const IDLE_CLIPS = ['idle', 'idle_breathe', 'idle_look', 'idle_fidget'];
const SIDES = ['left', 'right'];
// per side: offX offZ ankleY relY kneeX kneeY kneeZ foot(4) toes(4) contact = 16
const SIDE_STRIDE = 16, SAMPLE_STRIDE = 2 * SIDE_STRIDE + 5;        // + hips quat (4) + root y (1)
const N_LOOP = 32, N_IDLE = 24, N_JUMP = 24;

/** Sample one clip into a table. Works for any rig made by restGeometry / prepareRig. */
function bake(rig, ctx, name, n, t0 = 0, t1 = null) {
  const clip = CLIPS[name];
  if (!clip) return null;
  const tm = clip.timing(ctx);
  const dur = tm.duration;
  const span = (t1 ?? dur) - t0;
  const data = new Float32Array(n * SAMPLE_STRIDE);
  const H = rig.heads;
  const mean = [[0, 0], [0, 0]];
  for (let k = 0; k < n; k++) {
    const t = t0 + span * k / (clip.loop ? n : n - 1);
    const pose = clip.sample(t, ctx);
    const D = poseToWorld(pose.joints);
    const P = fkPositions(H, pose);
    const c = clip.contacts ? clip.contacts(t, ctx) : { left: 1, right: 1 };
    const o = k * SAMPLE_STRIDE;
    for (let s = 0; s < 2; s++) {
      const sd = SIDES[s], b = o + s * SIDE_STRIDE;
      const hip = P[`${sd}UpperLeg`], knee = P[`${sd}LowerLeg`], ankle = P[`${sd}Foot`];
      data[b] = ankle[0] - hip[0]; data[b + 1] = ankle[2] - hip[2];
      data[b + 2] = ankle[1] - H[`${sd}Foot`][1];               // ankle height above its rest height
      data[b + 3] = ankle[1] - hip[1];
      const mid = [(hip[0] + ankle[0]) / 2, (hip[1] + ankle[1]) / 2, (hip[2] + ankle[2]) / 2];
      const kd = M.vNorm(M.vSub(knee, mid));
      data[b + 4] = kd[0]; data[b + 5] = kd[1]; data[b + 6] = kd[2];
      const qf = D[`${sd}Foot`], qt = D[`${sd}Toes`];
      for (let j = 0; j < 4; j++) { data[b + 7 + j] = qf[j]; data[b + 11 + j] = qt[j]; }
      data[b + 15] = c[sd] ? 1 : 0;
      mean[s][0] += data[b] / n; mean[s][1] += data[b + 1] / n;
      M.beginFrame();
    }
    const qh = D.hips;
    for (let j = 0; j < 4; j++) data[o + 2 * SIDE_STRIDE + j] = qh[j];
    data[o + 2 * SIDE_STRIDE + 4] = pose.root[1];
  }
  const v = tm.velocity || [0, 0, 0];
  return { name, n, loop: !!clip.loop, duration: dur, span, data, speed: Math.hypot(v[0], v[2]), velocity: [v[0], v[2]], stride: tm.stride || 0, mean, events: tm.events || null };
}

/** Tables for one body (≈10 ms in node; call when the body changes). */
export function buildClipTables(rig, { speedScale = 1 } = {}) {
  const ctx = makeContext(rig, { speedScale });
  const T = {};
  for (const n of LOCO_CLIPS) T[n] = bake(rig, ctx, n, N_LOOP);
  T.fall = bake(rig, ctx, 'fall', 12);
  for (const n of IDLE_CLIPS) T[n] = bake(rig, ctx, n, N_IDLE);
  const jt = CLIPS.jump?.timing(ctx);
  if (jt?.events) T.jump = bake(rig, ctx, 'jump', N_JUMP, jt.events.takeoff, jt.events.apex);    // the rising part only
  M.beginFrame();
  return T;
}

/** Accumulator for blended samples (preallocated, reused). */
export function legAccum() {
  return { w: 0, side: [0, 1].map(() => ({ off: [0, 0], ankleY: 0, relY: 0, knee: [0, 0, 0], foot: [0, 0, 0, 0], toes: [0, 0, 0, 0], contact: 0 })), hips: [0, 0, 0, 0], rootY: 0 };
}
export function clearAccum(a) {
  a.w = 0; a.rootY = 0;
  for (let j = 0; j < 4; j++) a.hips[j] = 0;
  for (let i = 0; i < 2; i++) { const s = a.side[i]; s.off[0] = s.off[1] = 0; s.ankleY = s.relY = s.contact = 0; s.knee[0] = s.knee[1] = s.knee[2] = 0; for (let j = 0; j < 4; j++) s.foot[j] = s.toes[j] = 0; }
}
const addQ = (acc, data, i, w) => {
  const sg = acc[0] * data[i] + acc[1] * data[i + 1] + acc[2] * data[i + 2] + acc[3] * data[i + 3] < 0 ? -w : w;
  acc[0] += data[i] * sg; acc[1] += data[i + 1] * sg; acc[2] += data[i + 2] * sg; acc[3] += data[i + 3] * sg;
};
const _lerpBuf = new Float32Array(SAMPLE_STRIDE);
const QOFF = [7, 11, SIDE_STRIDE + 7, SIDE_STRIDE + 11, 2 * SIDE_STRIDE];

/**
 * Add table `tab` at normalised phase u (loop) or progress u (0..1, one-shot) with weight w; stride scale k scales
 * the horizontal swing about the cycle mean.
 */
export function accumulate(acc, tab, u, w, k = 1) {
  if (!tab || !(w > 1e-4)) return;
  const n = tab.n;
  let x = tab.loop ? (u - Math.floor(u)) * n : M.clamp(u, 0, 1) * (n - 1);
  let i0 = Math.floor(x), f = x - i0;
  let i1 = i0 + 1;
  if (tab.loop) { i0 %= n; i1 %= n; } else if (i1 > n - 1) { i1 = n - 1; }
  const d = tab.data, a = i0 * SAMPLE_STRIDE, b = i1 * SAMPLE_STRIDE;
  // lerp the two samples (quaternions sign-aligned) into a scratch row
  for (let j = 0; j < SAMPLE_STRIDE; j++) _lerpBuf[j] = d[a + j] + (d[b + j] - d[a + j]) * f;
  for (let qi = 0; qi < QOFF.length; qi++) {
    const q = QOFF[qi];
    const dot = d[a + q] * d[b + q] + d[a + q + 1] * d[b + q + 1] + d[a + q + 2] * d[b + q + 2] + d[a + q + 3] * d[b + q + 3];
    if (dot < 0) for (let j = 0; j < 4; j++) _lerpBuf[q + j] = d[a + q + j] - (d[b + q + j] + d[a + q + j]) * f;
  }
  acc.w += w;
  for (let s = 0; s < 2; s++) {
    const o = s * SIDE_STRIDE, S = acc.side[s], m = tab.mean[s];
    S.off[0] += (m[0] + (_lerpBuf[o] - m[0]) * k) * w; S.off[1] += (m[1] + (_lerpBuf[o + 1] - m[1]) * k) * w;
    S.ankleY += _lerpBuf[o + 2] * w; S.relY += _lerpBuf[o + 3] * w;
    S.knee[0] += _lerpBuf[o + 4] * w; S.knee[1] += _lerpBuf[o + 5] * w; S.knee[2] += _lerpBuf[o + 6] * w;
    addQ(S.foot, _lerpBuf, o + 7, w); addQ(S.toes, _lerpBuf, o + 11, w);
    S.contact += _lerpBuf[o + 15] * w;
  }
  addQ(acc.hips, _lerpBuf, 2 * SIDE_STRIDE, w);
  acc.rootY += _lerpBuf[2 * SIDE_STRIDE + 4] * w;
}
function nq(q) { const l = Math.sqrt(q[0] * q[0] + q[1] * q[1] + q[2] * q[2] + q[3] * q[3]); if (l > 1e-9) for (let j = 0; j < 4; j++) q[j] /= l; else { q[0] = q[1] = q[2] = 0; q[3] = 1; } }
/** Normalise an accumulator (divide by the total weight, normalise quaternions). Returns false if empty. */
export function finishAccum(acc) {
  if (!(acc.w > 1e-6)) return false;
  const iw = 1 / acc.w;
  for (let i = 0; i < 2; i++) {
    const S = acc.side[i];
    S.off[0] *= iw; S.off[1] *= iw; S.ankleY *= iw; S.relY *= iw; S.contact *= iw;
    const kl = Math.hypot(S.knee[0], S.knee[1], S.knee[2]) || 1; S.knee[0] /= kl; S.knee[1] /= kl; S.knee[2] /= kl;
    nq(S.foot); nq(S.toes);
  }
  nq(acc.hips); acc.rootY *= iw;
  return true;
}

export const CLIPLOCO_DEFAULTS = {
  minRate: 0.55, maxRate: 1.7,      // playback-rate range relative to the clip's authored speed
  runFrom: 1.9, runTo: 2.6,          // m/s: walk -> run blend
  dirSharpness: 2,                   // exponent of the direction weights (higher = less diagonal mixing)
  weightTau: 0.12,                   // s, smoothing of the clip weights
};

/** Per-avatar clip locomotion state. */
export function createClipLoco(tables, opts = {}) {
  return { o: { ...CLIPLOCO_DEFAULTS, ...opts }, tables, phase: 0, w: Object.fromEntries(LOCO_CLIPS.map(n => [n, 0])), target: Object.fromEntries(LOCO_CLIPS.map(n => [n, 0])), stride: 1, rate: 0, idleT: 0, acc: legAccum() };
}

/**
 * Advance and blend: v = [vx, vz] velocity in the body (Y) frame, scale-free m/s (+x = the avatar's left,
 * +z = forward). Fills st.acc with the blended leg shape and returns it (or null if no tables).
 */
export function stepClipLoco(st, v, dt) {
  const T = st.tables, o = st.o;
  if (!T?.walk) return null;
  const speed = Math.hypot(v[0], v[1]);
  // direction weights (forward / back / left / right)
  let wf = 0, wb = 0, wl = 0, wr = 0;
  if (speed > 1e-4) {
    const c = v[1] / speed, s = v[0] / speed;
    wf = Math.max(0, c) ** o.dirSharpness; wb = Math.max(0, -c) ** o.dirSharpness;
    wl = Math.max(0, s) ** o.dirSharpness; wr = Math.max(0, -s) ** o.dirSharpness;
  } else wf = 1;
  const sum = wf + wb + wl + wr || 1;
  const run = M.smoothstep(o.runFrom, o.runTo, speed * Math.max(0, v[1]) / Math.max(speed, 1e-6));
  const target = st.target;
  target.walk = wf / sum * (1 - run); target.run = wf / sum * run; target.walk_back = wb / sum; target.strafe_left = wl / sum; target.strafe_right = wr / sum;
  const kk = M.lp(dt, o.weightTau);
  let rateSum = 0, wsum = 0, strideK = 0;
  for (let ci = 0; ci < LOCO_CLIPS.length; ci++) {
    const n = LOCO_CLIPS[ci];
    st.w[n] += (target[n] - st.w[n]) * kk;
    const tab = T[n], w = st.w[n];
    if (!tab || w < 1e-4) continue;
    const r = M.clamp(speed / Math.max(tab.speed, 0.05), o.minRate, o.maxRate);
    rateSum += w * r / tab.duration;
    strideK += w * M.clamp(speed / (r * Math.max(tab.speed, 0.05)), 0.15, 1);
    wsum += w;
  }
  if (wsum > 0) { st.rate = rateSum / wsum; st.stride = strideK / wsum; }
  st.phase = (st.phase + st.rate * dt) % 1;
  clearAccum(st.acc);
  for (let ci = 0; ci < LOCO_CLIPS.length; ci++) accumulate(st.acc, T[LOCO_CLIPS[ci]], st.phase, st.w[LOCO_CLIPS[ci]], st.stride);
  finishAccum(st.acc);
  return st.acc;
}

/** Restart the cycle (e.g. when starting to move): phase 0 = left foot lands. */
export function resetClipLoco(st, phase = 0) {
  st.phase = phase;
  for (const n of LOCO_CLIPS) st.w[n] = 0;
}

/** Air pose (jump rising part, then the fall loop) at time t since take-off; result in acc. */
export function airPose(st, acc, t, falling) {
  const T = st.tables;
  clearAccum(acc);
  if (!falling && T.jump) {
    const dur = T.jump.span;
    accumulate(acc, T.jump, M.clamp(t / Math.max(dur, 0.05), 0, 1), 1);
  } else if (T.fall) accumulate(acc, T.fall, t / Math.max(T.fall.duration, 0.1), 1);
  return finishAccum(acc) ? acc : null;
}

/** Idle variants: hips sway quaternion of idle clip `name` at time t (into out [4]); weight blending by caller. */
export function idleHips(st, out, name, t) {
  const tab = st.tables[name];
  if (!tab) { out[0] = out[1] = out[2] = 0; out[3] = 1; return out; }
  const acc = st.idleAcc || (st.idleAcc = legAccum());
  clearAccum(acc);
  accumulate(acc, tab, t / tab.duration, 1);
  finishAccum(acc);
  for (let j = 0; j < 4; j++) out[j] = acc.hips[j];
  return out;
}
