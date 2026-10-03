// SPDX-License-Identifier: GPL-3.0-or-later
// Rest data the VR IK needs, derived from the rest joint heads of the CURRENT body (character frame: +X = the
// character's left, +Y up, +Z forward, metres; see vendor/cc/animation/canonical.js). Pure, no three.js.
//   heads: humanoid.restHeads(h) in the browser, rig.headsFromSidecar(sidecar, influences) in node.
import { restGeometry } from '../../vendor/cc/animation/rig.js';
import { vSub, vNorm, vCross, vDot, vLen, vReject, qFrameZY, clamp } from './qx.js';

export const SIDES = ['left', 'right'];
export const FINGERS = ['Thumb', 'Index', 'Middle', 'Ring', 'Little'];
export const SEGMENTS = {
  Thumb: ['Metacarpal', 'Proximal', 'Distal'],
  Index: ['Proximal', 'Intermediate', 'Distal'], Middle: ['Proximal', 'Intermediate', 'Distal'],
  Ring: ['Proximal', 'Intermediate', 'Distal'], Little: ['Proximal', 'Intermediate', 'Distal'],
};
export const fingerJoint = (side, f, k) => `${side}${f}${SEGMENTS[f][k]}`;

/**
 * Hand frame from 4 points of a real or avatar hand: F = wrist -> middle knuckle, R = radial (thumb side) from
 * the little knuckle to the index knuckle, D = dorsal (back of the hand). Chirality: left D = R x F, right
 * D = F x R (palm down, fingers forward -> D up for both hands). q = rotation whose +Z = F and +Y = D.
 */
export function handFrame(side, wrist, indexKnuckle, middleKnuckle, littleKnuckle) {
  const F = vNorm(vSub(middleKnuckle, wrist));
  const R = vNorm(vReject(vSub(indexKnuckle, littleKnuckle), F));
  const D = vNorm(side === 'left' ? vCross(R, F) : vCross(F, R));
  return { F, R, D, q: qFrameZY(F, D) };
}

/** Thumb nail-side tilt from the hand's dorsal axis D toward its radial axis R (rad); see fingerAxes. */
// 60 deg: the thumb is pronated relative to the fingers, so its flexion plane points across the palm (toward the
// little finger), not straight into it. At 45 deg a fist thumb stuck out below the fist like a thumbs-down (visual
// review, hands_fist_3p.png); 60 deg lets it wrap across the index / middle middle phalanges (tests/fingers.test).
export const THUMB_AXIS = { tilt: Math.PI / 3 };
/** Reference axes of a finger: the thumb's "dorsal" is its nail side, tilted from the hand's D toward R. */
export function fingerAxes(finger, hf) {
  if (finger !== 'Thumb') return { F: hf.F, D: hf.D, R: hf.R };
  const c = Math.cos(THUMB_AXIS.tilt), s = Math.sin(THUMB_AXIS.tilt);
  const Dt = vNorm([hf.D[0] * c + hf.R[0] * s, hf.D[1] * c + hf.R[1] * s, hf.D[2] * c + hf.R[2] * s]);
  const Rt = vNorm(vReject([hf.R[0] * c - hf.D[0] * s, hf.R[1] * c - hf.D[1] * s, hf.R[2] * c - hf.D[2] * s], Dt));
  return { F: hf.F, D: Dt, R: Rt };
}

/**
 * Absolute angles of a finger chain given its 4 points (3 segments + tip) and the hand frame:
 *   yaw   = first segment toward the radial side (rad), pitch = first segment toward the palm (flexion, rad),
 *   bend1 = second segment vs first, bend2 = third vs second (flexion about the segment's own hinge, rad).
 * This is the source-independent "finger state" (docs/HAND_TRACKING.md).
 */
export function chainAngles(finger, hf, pts) {
  const ax = fingerAxes(finger, hf);
  const v = [vNorm(vSub(pts[1], pts[0])), vNorm(vSub(pts[2], pts[1])), vNorm(vSub(pts[3], pts[2]))];
  const vr = vDot(v[0], ax.R), vd = vDot(v[0], ax.D), vf = vDot(v[0], ax.F);
  const yaw = Math.atan2(vr, vf);
  const pitch = Math.atan2(-vd, Math.hypot(vr, vf));
  // Hinge axis: the hand's lateral axis D x F (+ rotation curls toward the palm), made perpendicular to the
  // parent segment. It stays well defined in a fist, where a segment points along -D (deriving the hinge from
  // D rejected from the segment flipped sign there and read a fist as half open).
  const Kh = vNorm(vCross(ax.D, ax.F));
  const bend = k => {
    const p = v[k - 1], c = v[k];
    let K = vReject(Kh, p);
    if (vLen(K) < 1e-6) K = vReject(ax.D, p);
    K = vNorm(K);
    const a = vReject(p, K), b = vReject(c, K);
    return Math.atan2(vDot(vCross(a, b), K), vDot(a, b));
  };
  return { yaw, pitch, bend1: bend(1), bend2: bend(2) };
}

/** Everything the IK needs about the current body, from rest heads. eyeOffset = eye centre - head joint (rest). */
export function prepareRig(heads, { eyeOffset = null } = {}) {
  const geo = restGeometry(heads);
  const H = geo.heads;
  const hands = {};
  for (const s of SIDES) {
    const hf = handFrame(s, H[`${s}Hand`], H[`${s}IndexProximal`], H[`${s}MiddleProximal`], H[`${s}LittleProximal`]);
    const fingers = {};
    for (const f of FINGERS) {
      const segs = [0, 1, 2].map(k => H[fingerJoint(s, f, k)]);
      // tip: the distal bone has no child joint; extend it by the intermediate/proximal length ratio
      const d2 = vSub(segs[2], segs[1]), tip = [segs[2][0] + d2[0] * 0.8, segs[2][1] + d2[1] * 0.8, segs[2][2] + d2[2] * 0.8];
      const pts = [...segs, tip];
      fingers[f] = { rest: chainAngles(f, hf, pts), pts, len: [vLen(vSub(pts[1], pts[0])), vLen(vSub(pts[2], pts[1])), vLen(vSub(pts[3], pts[2]))] };
    }
    hands[s] = { frame: hf, fingers };
  }
  // neutral body: eye centre 1.553 m, 0.118 m forward; head joint (0, 1.515, 0.04); scale with the head height
  const headH = H.head[1];
  const eo = eyeOffset ?? [0, 0.038 * headH / 1.515, 0.078 * headH / 1.515];
  const torsoLen = vLen(vSub(H.head, H.hips));
  // head volume for the hand collision (relative to the head joint, rest frame): skull sphere from
  // assets/body_colliders.json ("head", neutral body) + a face sphere for nose/chin, scaled with the head height
  const hk = headH / 1.515;
  const headSphere = { c1: [0, 0.034 * hk, 0.012 * hk], r1: 0.078 * hk, c2: [0, 0.012 * hk, 0.062 * hk], r2: 0.062 * hk };
  return {
    ...geo, H, hands, eyeOffset: eo,
    eyeHeight: headH + eo[1], torsoLen, headSphere,
    upperLen: vLen(vSub(H.head, H.hips)),
    footX: SIDES.map(s => H[`${s}Foot`][0]), footZ: SIDES.map(s => H[`${s}Foot`][2]),
    minPelvisY: clamp(geo.ankleHeight + 0.28 * geo.legLength, 0.1, 2),
  };
}
