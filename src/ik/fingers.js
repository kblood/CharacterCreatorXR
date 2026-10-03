// SPDX-License-Identifier: GPL-3.0-or-later
// Finger mapping: every finger source (XRHand joints, controllers with per-finger sensors, plain controllers) is
// normalised into one FINGER STATE, which is then turned into rest-relative rotations of the avatar's finger bones.
// Pure, engine-agnostic (arrays). docs/HAND_TRACKING.md.
//
// FingerState = { Thumb|Index|Middle|Ring|Little: { yaw|null, pitch, bend1, bend2, curl, src } }  (radians)
//   yaw   = first segment toward the radial (thumb) side of the hand frame; null = keep the avatar's rest spread
//   pitch = first segment toward the palm (flexion), bend1/bend2 = flexion of segment 2 vs 1 and 3 vs 2
//   curl  = 0..1 summary (for UI/debug), src = 'hand' | 'controller-finger' | 'controller' | 'rest' | 'sim'
import { FINGERS, SEGMENTS, fingerJoint, handFrame, fingerAxes, chainAngles } from './rigdata.js';
import { clamp, vReject, vNorm, vCross, vLen, vScale, vAdd, vSub, qFromTo, qMul, qRotate, qAxisAngle, finite3 } from './qx.js';
import * as PM from './pm.js';

const D = Math.PI / 180;

/** XR Hand Input joint names (WebXR Hand Input Module) per canonical finger: [seg0, seg1, seg2, tip]. */
export const XR_CHAINS = {
  Thumb: ['thumb-metacarpal', 'thumb-phalanx-proximal', 'thumb-phalanx-distal', 'thumb-tip'],
  Index: ['index-finger-phalanx-proximal', 'index-finger-phalanx-intermediate', 'index-finger-phalanx-distal', 'index-finger-tip'],
  Middle: ['middle-finger-phalanx-proximal', 'middle-finger-phalanx-intermediate', 'middle-finger-phalanx-distal', 'middle-finger-tip'],
  Ring: ['ring-finger-phalanx-proximal', 'ring-finger-phalanx-intermediate', 'ring-finger-phalanx-distal', 'ring-finger-tip'],
  Little: ['pinky-finger-phalanx-proximal', 'pinky-finger-phalanx-intermediate', 'pinky-finger-phalanx-distal', 'pinky-finger-tip'],
};
export const XR_JOINTS = ['wrist', 'thumb-metacarpal', 'thumb-phalanx-proximal', 'thumb-phalanx-distal', 'thumb-tip',
  ...['index', 'middle', 'ring', 'pinky'].flatMap(f => ['metacarpal', 'phalanx-proximal', 'phalanx-intermediate', 'phalanx-distal', 'tip'].map(s => `${f}-finger-${s}`))];

/**
 * Per-finger joint limits (rad), from common anatomical ranges (MCP flexion ~90 deg with a little
 * hyperextension, PIP ~110, DIP ~80-90; more abduction for index / little than for the middle finger).
 * yaw (+ = toward the thumb side) is relative to the avatar's rest yaw of that finger.
 * Thumb: pitch / yaw = CMC (the metacarpal), bend1 = MCP, bend2 = IP.
 */
export const LIMITS = {
  Index: { pitch: [-25 * D, 95 * D], yaw: [-15 * D, 25 * D], bend1: [-5 * D, 115 * D], bend2: [-10 * D, 90 * D] },
  Middle: { pitch: [-25 * D, 95 * D], yaw: [-15 * D, 15 * D], bend1: [-5 * D, 115 * D], bend2: [-10 * D, 90 * D] },
  Ring: { pitch: [-25 * D, 98 * D], yaw: [-20 * D, 12 * D], bend1: [-5 * D, 115 * D], bend2: [-10 * D, 90 * D] },
  Little: { pitch: [-30 * D, 100 * D], yaw: [-30 * D, 15 * D], bend1: [-5 * D, 115 * D], bend2: [-10 * D, 90 * D] },
  Thumb: { pitch: [-35 * D, 65 * D], yaw: [-55 * D, 30 * D], bend1: [-25 * D, 80 * D], bend2: [-25 * D, 95 * D] },
};
LIMITS.finger = LIMITS.Middle;                         // older name (tests, docs)
const lim = f => LIMITS[f] || LIMITS.Middle;

// Curl 0..1 -> absolute angles (open hand .. fist). Thumb: 0 = relaxed/up, 1 = pressed across the fingers.
const OPEN = { pitch: 4 * D, bend1: 6 * D, bend2: 4 * D }, FIST = { pitch: 82 * D, bend1: 100 * D, bend2: 65 * D };
const THUMB_OPEN = { pitch: 0, bend1: 0, bend2: 5 * D, dyaw: 0 }, THUMB_DOWN = { pitch: -15 * D, bend1: 75 * D, bend2: 0, dyaw: -10 * D };   // fist: across the index / middle

/** Hand frame + finger state from XR joint positions (a Map/obj name -> [x,y,z], any frame). null if unusable. */
export function fingerStateFromJoints(side, joints) {
  const P = n => (joints instanceof Map ? joints.get(n) : joints[n]);
  const w = P('wrist'), i = P('index-finger-phalanx-proximal'), m = P('middle-finger-phalanx-proximal'), l = P('pinky-finger-phalanx-proximal');
  if (![w, i, m, l].every(p => p && finite3(p))) return null;
  const frame = handFrame(side, w, i, m, l);
  const fingers = {};
  for (const f of FINGERS) {
    const pts = XR_CHAINS[f].map(P);
    if (!pts.every(p => p && finite3(p))) { fingers[f] = null; continue; }
    const a = chainAngles(f, frame, pts);
    fingers[f] = { ...a, curl: curlOf(f, a), src: 'hand' };
  }
  return { frame, fingers };
}

/** 0..1 curl summary of absolute angles. */
export function curlOf(f, a) {
  if (f === 'Thumb') return clamp(((a.bend1 ?? 0) + (a.bend2 ?? 0)) / (THUMB_DOWN.bend1 + THUMB_DOWN.bend2), 0, 1);
  return clamp(((a.pitch ?? 0) + (a.bend1 ?? 0) + (a.bend2 ?? 0) - OPEN.pitch - OPEN.bend1 - OPEN.bend2)
    / (FIST.pitch + FIST.bend1 + FIST.bend2 - OPEN.pitch - OPEN.bend1 - OPEN.bend2), 0, 1);
}

/**
 * Curls { thumb, index, middle, ring, little } in 0..1 (+ src per finger) -> finger state (yaw null = rest
 * spread; thumb yaw is relative: dyaw applied on top of the rest yaw by fingerWorldDeltas).
 */
export function fingerStateFromCurls(curls, src = {}) {
  const out = {};
  for (const f of FINGERS) {
    const c = clamp(Number(curls?.[f.toLowerCase()]) || 0, 0, 1);
    if (f === 'Thumb') {
      out[f] = { yaw: null, dyaw: THUMB_OPEN.dyaw + (THUMB_DOWN.dyaw - THUMB_OPEN.dyaw) * c,
        pitch: THUMB_OPEN.pitch + (THUMB_DOWN.pitch - THUMB_OPEN.pitch) * c,
        bend1: THUMB_OPEN.bend1 + (THUMB_DOWN.bend1 - THUMB_OPEN.bend1) * c,
        bend2: THUMB_OPEN.bend2 + (THUMB_DOWN.bend2 - THUMB_OPEN.bend2) * c, curl: c, src: src.thumb || 'controller' };
    } else {
      // the little finger curls a bit more and earlier, the index a bit less (natural fist)
      const k = f === 'Little' ? 1.06 : f === 'Index' ? 0.97 : 1;
      out[f] = { yaw: null, pitch: OPEN.pitch + (FIST.pitch - OPEN.pitch) * c * k, bend1: OPEN.bend1 + (FIST.bend1 - OPEN.bend1) * c,
        bend2: OPEN.bend2 + (FIST.bend2 - OPEN.bend2) * c, curl: c, src: src[f.toLowerCase()] || 'controller' };
    }
  }
  return out;
}

/** Clamp a finger state to the joint limits (absolute; yaw relative to the avatar rest yaw). Returns a new state. */
export function limitFingerState(fs, restHand) {
  const out = {};
  for (const f of FINGERS) {
    const a = fs?.[f];
    if (!a) { out[f] = null; continue; }
    const L = lim(f), ry = restHand?.fingers?.[f]?.rest?.yaw ?? 0;
    const val = (v, r) => (Number.isFinite(v) ? clamp(v, r[0], r[1]) : 0);
    out[f] = { ...a, pitch: val(a.pitch, L.pitch), bend1: val(a.bend1, L.bend1), bend2: val(a.bend2, L.bend2),
      yaw: a.yaw == null || !Number.isFinite(a.yaw) ? null : clamp(a.yaw, ry + L.yaw[0], ry + L.yaw[1]) };
  }
  return out;
}

/** Linear blend of two finger states (a -> b by t); null fingers take the other side. */
export function blendFingerStates(a, b, t) {
  if (!a) return b; if (!b || t <= 0) return a; if (t >= 1) return b;
  const out = {};
  for (const f of FINGERS) {
    const x = a[f], y = b[f];
    if (!x || !y) { out[f] = x || y; continue; }
    const m = (p, q) => p + (q - p) * t;
    out[f] = { yaw: x.yaw == null || y.yaw == null ? (t < 0.5 ? x.yaw : y.yaw) : m(x.yaw, y.yaw), dyaw: m(x.dyaw ?? 0, y.dyaw ?? 0),
      pitch: m(x.pitch, y.pitch), bend1: m(x.bend1, y.bend1), bend2: m(x.bend2, y.bend2), curl: m(x.curl ?? 0, y.curl ?? 0), src: t < 0.5 ? x.src : y.src };
  }
  return out;
}

/** Desired segment directions (character frame, avatar rest hand) for absolute angles. */
function chainDirs(finger, hf, a) {
  const ax = fingerAxes(finger, hf);
  const v1 = vNorm(vAdd(vAdd(vScale(ax.R, Math.sin(a.yaw) * Math.cos(a.pitch)), vScale(ax.F, Math.cos(a.yaw) * Math.cos(a.pitch))), vScale(ax.D, -Math.sin(a.pitch))));
  const Kh = vNorm(vCross(ax.D, ax.F));             // hinge convention of rigdata.chainAngles
  const next = (p, bend) => {
    let K = vReject(Kh, p);
    if (vLen(K) < 1e-6) K = vReject(ax.D, p);
    return qRotate(qAxisAngle(vNorm(K), bend), p);
  };
  const v2 = next(v1, a.bend1), v3 = next(v2, a.bend2);
  return [v1, v2, v3];
}

/**
 * World (character-frame, rest-relative) deltas of the finger joints of one hand for finger state fs.
 * handDelta = the hand's world delta. Missing fingers (null) keep the rest pose relative to the hand.
 * Returns { joint: quat }.
 */
export function fingerWorldDeltas(rigHand, side, fs, handDelta) {
  const out = {};
  const hf = rigHand.frame;
  for (const f of FINGERS) {
    const a = fs?.[f], rest = rigHand.fingers[f];
    const names = [0, 1, 2].map(k => fingerJoint(side, f, k));
    if (!a) { for (const n of names) out[n] = handDelta; continue; }
    const abs = { yaw: (a.yaw == null ? rest.rest.yaw : a.yaw) + (a.dyaw ?? 0), pitch: a.pitch, bend1: a.bend1, bend2: a.bend2 };
    const v = chainDirs(f, hf, abs);
    const c = [0, 1, 2].map(k => vNorm(vSub(rest.pts[k + 1], rest.pts[k])));
    const W1 = qFromTo(c[0], v[0]);
    const W2 = qMul(qFromTo(qRotate(W1, c[1]), v[1]), W1);
    const W3 = qMul(qFromTo(qRotate(W2, c[2]), v[2]), W2);
    out[names[0]] = qMul(handDelta, W1); out[names[1]] = qMul(handDelta, W2); out[names[2]] = qMul(handDelta, W3);
  }
  return out;
}

/**
 * Synthetic XR joint positions for a finger state on the avatar's hand proportions (tests, emulation, desktop
 * preview): the avatar rest hand moved by (handDelta about the hand joint, then to wrist position `wrist`).
 * Returns { name: [x,y,z] } for the joints used by fingerStateFromJoints (+ the 4 metacarpals approximated).
 */
export function syntheticJoints(rigHand, side, fs, handDelta, wrist, restWrist) {
  const out = {};
  const place = p => vAdd(wrist, qRotate(handDelta, vSub(p, restWrist)));
  out.wrist = [...wrist];
  const hf = rigHand.frame;
  for (const f of FINGERS) {
    const rest = rigHand.fingers[f], a = fs?.[f];
    const abs = a ? { yaw: (a.yaw == null ? rest.rest.yaw : a.yaw) + (a.dyaw ?? 0), pitch: a.pitch, bend1: a.bend1, bend2: a.bend2 } : rest.rest;
    const v = chainDirs(f, hf, abs);
    let p = place(rest.pts[0]);
    const names = XR_CHAINS[f];
    out[names[0]] = p;
    for (let k = 0; k < 3; k++) { p = vAdd(p, qRotate(handDelta, vScale(v[k], rest.len[k]))); out[names[k + 1]] = p; }
    if (f !== 'Thumb') out[names[0].replace('phalanx-proximal', 'metacarpal')] = vAdd(vScale(out.wrist, 0.6), vScale(out[names[0]], 0.4));
  }
  return out;
}

export { FINGERS, SEGMENTS };

// ---- allocation-free variant for the per-frame solve (pooled math, src/ik/pm.js) ----

function handCache(rigHand, side) {
  const hf = rigHand.frame;
  const c = { names: [], axes: [], Kh: [], rest: [] };
  for (const f of FINGERS) {
    c.names.push([0, 1, 2].map(k => fingerJoint(side, f, k)));
    const ax = fingerAxes(f, hf);
    c.axes.push({ F: [...ax.F], D: [...ax.D], R: [...ax.R] });
    c.Kh.push(vNorm(vCross(ax.D, ax.F)));
    const r = rigHand.fingers[f];
    c.rest.push([0, 1, 2].map(k => vNorm(vSub(r.pts[k + 1], r.pts[k]))));
  }
  return c;
}
function nextDirP(p, bend, Kh, D) {
  let K = PM.vReject(Kh, p);
  if (PM.vLen(K) < 1e-6) K = PM.vReject(D, p);
  return PM.qRotate(PM.qAxisAngle(PM.vNorm(K), bend), p);
}

/**
 * Same as fingerWorldDeltas, but writes the 15 finger joints of one hand into W (persistent quaternion arrays
 * per joint name) without allocating. Missing fingers (or fs = null) follow the hand (rest pose relative to it).
 */
export function fingerWorldDeltasInto(W, rigHand, side, fs, handDelta) {
  const c = rigHand._pc || (rigHand._pc = handCache(rigHand, side));
  for (let fi = 0; fi < 5; fi++) {
    const f = FINGERS[fi], names = c.names[fi], a = fs ? fs[f] : null;
    if (!a) { PM.set4(W[names[0]], handDelta); PM.set4(W[names[1]], handDelta); PM.set4(W[names[2]], handDelta); continue; }
    const rest = rigHand.fingers[f], ax = c.axes[fi];
    const yaw = (a.yaw == null ? rest.rest.yaw : a.yaw) + (a.dyaw || 0), pitch = a.pitch || 0;
    const cy = Math.cos(yaw), sy = Math.sin(yaw), cp = Math.cos(pitch), sp = Math.sin(pitch);
    const v1 = PM.vNorm(PM.v3(ax.R[0] * sy * cp + ax.F[0] * cy * cp - ax.D[0] * sp, ax.R[1] * sy * cp + ax.F[1] * cy * cp - ax.D[1] * sp, ax.R[2] * sy * cp + ax.F[2] * cy * cp - ax.D[2] * sp));
    const v2 = nextDirP(v1, a.bend1 || 0, c.Kh[fi], ax.D), v3 = nextDirP(v2, a.bend2 || 0, c.Kh[fi], ax.D);
    const r = c.rest[fi];
    const W1 = PM.qFromTo(r[0], v1);
    const W2 = PM.qMul(PM.qFromTo(PM.qRotate(W1, r[1]), v2), W1);
    const W3 = PM.qMul(PM.qFromTo(PM.qRotate(W2, r[2]), v3), W2);
    PM.set4(W[names[0]], PM.qMul(handDelta, W1)); PM.set4(W[names[1]], PM.qMul(handDelta, W2)); PM.set4(W[names[2]], PM.qMul(handDelta, W3));
  }
}
