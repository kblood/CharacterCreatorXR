// SPDX-License-Identifier: GPL-3.0-or-later
// Finger / hand input quality: One-Euro filters, lost-tracking hold -> relax, rest-pose spread retargeting,
// left/right mirroring of the XRHand mapping, per-finger limits, controller grip -> wrist offset.
import test from 'node:test';
import assert from 'node:assert/strict';
import { FINGERS, fingerStateFromCurls, fingerStateFromJoints, syntheticJoints, limitFingerState, LIMITS } from '../src/ik/fingers.js';
import { createFingerInput, RELAXED_CURLS } from '../src/input/fingerInput.js';
import { createOneEuro, oneEuro, createPoseFilter, filterPose } from '../src/ik/filters.js';
import { handFromGrip, GRIP_WRIST_OFFSET } from '../src/xr/tracking.js';
import { qNormalize, qRotate, qAxisAngle, qMul } from '../src/ik/qx.js';
import { RIG, DEG, rng, allFinite } from './helpers.mjs';

const R = rng(11);
const DT = 1 / 72;
const TABLE = { profiles: [], fallback: { index: { button: 0 }, grip: { button: 1 }, thumbTouch: [3, 4] } };
const btn = (value = 0, touched = false) => ({ value, touched, pressed: value > 0.5 });
const ctl = (side, trig, grip) => ({ handedness: side, profiles: ['generic-trigger-squeeze'], targetRayMode: 'tracked-pointer', hasHand: false, joints: null, gamepad: { mapping: 'xr-standard', buttons: [btn(trig), btn(grip), btn(), btn(), btn()], axes: [0, 0, 0, 0] } });
const handSnap = (side, joints) => ({ handedness: side, profiles: ['generic-hand'], targetRayMode: 'tracked-pointer', hasHand: true, joints, gamepad: null });

test('One-Euro: removes jitter at rest, follows fast motion with little lag', () => {
  const f = createOneEuro({ minCutoff: 1, beta: 0.5 });
  let sr = 0, sf = 0, n = 0;
  for (let i = 0; i < 2000; i++) {
    const raw = 1 + (R() - 0.5) * 0.02, y = oneEuro(f, raw, DT);
    if (i > 50) { sr += (raw - 1) ** 2; sf += (y - 1) ** 2; n++; }
  }
  const ratio = Math.sqrt(sf / n) / Math.sqrt(sr / n);
  assert.ok(ratio < 0.35, `filtered / raw jitter (rms) ${ratio.toFixed(3)}`);
  // a fast ramp (2 units/s): lag stays small
  const g = createOneEuro({ minCutoff: 1, beta: 0.5 });
  let x = 0, y = 0;
  for (let i = 0; i < 72; i++) { x += 2 * DT; y = oneEuro(g, x, DT); }
  assert.ok(x - y < 0.12, `lag ${x - y}`);
  // first sample passes through, dt <= 0 resets
  const h = createOneEuro();
  assert.equal(oneEuro(h, 5, DT), 5);
  assert.equal(oneEuro(h, 7, 0), 7);
});

test('pose filter: jittery wrist pose is smoothed, a teleport (dt gap) snaps, quaternion stays unit', () => {
  const f = createPoseFilter(), out = { pos: [0, 0, 0], quat: [0, 0, 0, 1] };
  const q0 = qNormalize([0.1, 0.7, 0.1, 0.7]);
  let maxDev = 0;
  for (let i = 0; i < 300; i++) {
    const p = [0.3 + (R() - 0.5) * 0.006, 1.2 + (R() - 0.5) * 0.006, -0.4];
    const q = qNormalize(qMul(qAxisAngle([R() - 0.5, R() - 0.5, R() - 0.5], (R() - 0.5) * 2 * DEG), q0));
    filterPose(f, p, q, DT, out);
    if (i > 60) maxDev = Math.max(maxDev, Math.hypot(out.pos[0] - 0.3, out.pos[1] - 1.2));
    assert.ok(Math.abs(Math.hypot(...out.quat) - 1) < 1e-9);
  }
  assert.ok(maxDev < 0.0025, `position jitter ${maxDev} (raw +-3 mm)`);
  filterPose(f, [2, 1, 2], q0, 0.5, out);
  assert.deepEqual(out.pos, [2, 1, 2]);
});

test('lost tracking: the last finger pose is held for holdTime, then blends to the relaxed hand', () => {
  const fi = createFingerInput(TABLE);
  let o;
  for (let i = 0; i < 60; i++) o = fi.update([ctl('left', 1, 1)], DT, RIG);
  const fist = o.left.state.Middle.curl;
  assert.ok(fist > 0.9);
  for (let i = 0; i < 18; i++) o = fi.update([], DT, RIG);            // 0.25 s gone
  assert.ok(o.left.lost && o.left.held, 'flagged');
  assert.ok(Math.abs(o.left.state.Middle.curl - fist) < 1e-9, 'held unchanged');
  for (let i = 0; i < 90; i++) o = fi.update([], DT, RIG);            // +1.25 s
  assert.ok(Math.abs(o.left.state.Middle.curl - RELAXED_CURLS.middle) < 0.01, `relaxed ${o.left.state.Middle.curl}`);
  assert.equal(o.left.kind, 'rest');
  // the source comes back: blends in, no pop
  o = fi.update([ctl('left', 1, 1)], DT, RIG);
  assert.ok(o.left.state.Middle.curl < 0.5, 'no pop back to the fist');
  for (let i = 0; i < 60; i++) o = fi.update([ctl('left', 1, 1)], DT, RIG);
  assert.ok(o.left.state.Middle.curl > 0.9);
  assert.ok(allFinite(o.left.state.Index));
});

test('a hand that never had a source is simply relaxed (not "held")', () => {
  const fi = createFingerInput(TABLE);
  let o;
  for (let i = 0; i < 5; i++) o = fi.update([ctl('left', 0, 0)], DT, RIG);
  assert.equal(o.right.kind, 'rest');
  assert.equal(o.right.held, false);
});

/** World-x mirror of a joint map. */
const mirrorJoints = J => Object.fromEntries(Object.entries(J).map(([k, p]) => [k, [-p[0], p[1], p[2]]]));

test('mirroring: mirrored left-hand XR joints read as the same finger angles on the right hand', () => {
  for (let i = 0; i < 20; i++) {
    const fs = fingerStateFromCurls({ thumb: R(), index: R(), middle: R(), ring: R(), little: R() });
    const hd = qNormalize([R() - 0.5, R() - 0.5, R() - 0.5, R() - 0.5]);
    const JL = syntheticJoints(RIG.hands.left, 'left', fs, hd, [0.2, 1.1, -0.3], RIG.H.leftHand);
    const a = fingerStateFromJoints('left', JL), b = fingerStateFromJoints('right', mirrorJoints(JL));
    for (const f of FINGERS) for (const k of ['yaw', 'pitch', 'bend1', 'bend2']) {
      assert.ok(Math.abs(a.fingers[f][k] - b.fingers[f][k]) < 1e-6, `${f}.${k}: ${a.fingers[f][k]} vs ${b.fingers[f][k]}`);
    }
  }
});

test('per-finger limits: the middle finger spreads less than the index and the little finger', () => {
  assert.ok(LIMITS.Middle.yaw[1] < LIMITS.Index.yaw[1]);
  assert.ok(LIMITS.Middle.yaw[0] > LIMITS.Little.yaw[0]);
  const bad = Object.fromEntries(FINGERS.map(f => [f, { yaw: 2, pitch: 3, bend1: -1, bend2: 3, curl: 1 }]));
  const L = limitFingerState(bad, RIG.hands.right);
  for (const f of FINGERS) {
    assert.ok(L[f].pitch <= LIMITS[f].pitch[1] + 1e-12 && L[f].bend1 >= LIMITS[f].bend1[0] - 1e-12);
    assert.ok(L[f].yaw - RIG.hands.right.fingers[f].rest.yaw <= LIMITS[f].yaw[1] + 1e-12);
  }
});

test('spread retargeting: a user whose open hand is splayed gets the avatar rest spread after adaptation', () => {
  const side = 'left', hand = RIG.hands[side];
  // the user's open hand: every finger 10 deg further from the middle finger than the avatar's rest
  const extra = { Index: 10 * DEG, Middle: 0, Ring: -8 * DEG, Little: -12 * DEG };
  const fs = fingerStateFromCurls({ thumb: 0, index: 0, middle: 0, ring: 0, little: 0 });
  for (const f of ['Index', 'Middle', 'Ring', 'Little']) fs[f].yaw = hand.fingers[f].rest.yaw + extra[f];
  const J = syntheticJoints(hand, side, fs, [0, 0, 0, 1], [0, 1, 0], RIG.H.leftHand);
  const fi = createFingerInput(TABLE, { spreadAdapt: 1 });
  let o;
  for (let i = 0; i < 72 * 6; i++) o = fi.update([handSnap(side, J)], DT, RIG);
  for (const f of ['Index', 'Ring', 'Little']) {
    const err = o[side].state[f].yaw - hand.fingers[f].rest.yaw;
    assert.ok(Math.abs(err) < 1 * DEG, `${f}: ${err / DEG} deg from the avatar rest spread`);
  }
  // without retargeting the splay comes through (clamped by the limits)
  const fi2 = createFingerInput(TABLE, { retarget: false });
  for (let i = 0; i < 72; i++) o = fi2.update([handSnap(side, J)], DT, RIG);
  assert.ok(o[side].state.Index.yaw - hand.fingers.Index.rest.yaw > 8 * DEG);
});

test('grip -> wrist offset: the wrist sits behind the grip along -fingers, offset is configurable', () => {
  const q = qNormalize([0.2, -0.3, 0.1, 0.9]);
  for (const side of ['left', 'right']) {
    const h = handFromGrip(side, [0, 1, 0], q);
    const d = [h.pos[0], h.pos[1] - 1, h.pos[2]];
    assert.ok(Math.abs(Math.hypot(...d) - Math.hypot(...GRIP_WRIST_OFFSET)) < 1e-9);
    const F = qRotate(h.quat, [0, 0, 1]);
    assert.ok(d[0] * F[0] + d[1] * F[1] + d[2] * F[2] < -0.07, `${side}: wrist behind the fist`);
    const h2 = handFromGrip(side, [0, 1, 0], q, [0, 0, -0.05]);
    assert.ok(Math.abs(Math.hypot(h2.pos[0], h2.pos[1] - 1, h2.pos[2]) - 0.05) < 1e-9);
  }
});

test('hand tracking that stays connected but loses its joints settles on the RELAXED hand, not a flat one', () => {
  const fist = fingerStateFromCurls({ thumb: 1, index: 1, middle: 1, ring: 1, little: 1 });
  const joints = syntheticJoints(RIG.hands.right, 'right', fist, [0, 0, 0, 1], RIG.H.rightHand, RIG.H.rightHand);
  const fi = createFingerInput({ profiles: [], fallback: {} });
  for (let i = 0; i < 72; i++) fi.update([handSnap('right', joints)], DT, RIG);
  let o;
  for (let i = 0; i < 72 * 3; i++) o = fi.update([handSnap('right', null)], DT, RIG);
  assert.equal(o.right.kind, 'rest');
  for (const f of ['index', 'middle', 'little']) {
    const c = o.right.state[f[0].toUpperCase() + f.slice(1)].curl;
    assert.ok(Math.abs(c - RELAXED_CURLS[f]) < 0.01, `${f} curl ${c} (relaxed ${RELAXED_CURLS[f]})`);
  }
});

test('source switch (controller -> hand): the ease runs to convergence, no step when the switch blend ends', () => {
  const open = fingerStateFromCurls({ thumb: 0, index: 0, middle: 0, ring: 0, little: 0 });
  const joints = syntheticJoints(RIG.hands.left, 'left', open, [0, 0, 0, 1], RIG.H.leftHand, RIG.H.leftHand);
  const fi = createFingerInput(TABLE);
  for (let i = 0; i < 60; i++) fi.update([ctl('left', 1, 1)], DT, RIG);
  const v = [];
  for (let i = 0; i < 90; i++) v.push(fi.update([handSnap('left', joints)], DT, RIG).left.state.Middle.pitch);
  const d = v.slice(1).map((x, i) => Math.abs(x - v[i]));
  // the per-frame change decays smoothly (exponential ease): no frame moves more than 1.2x the frame before it (+0.02 deg final snap)
  for (let i = 3; i < d.length; i++) assert.ok(d[i] <= d[i - 1] * 1.2 + 0.02 * DEG, `frame ${i + 1}: step ${(d[i] / DEG).toFixed(3)} deg after ${(d[i - 1] / DEG).toFixed(3)}`);
  assert.ok(Math.abs(v.at(-1) - v.at(-2)) < 1e-6, 'settled');
});

test('fist: the thumb wraps across the index / middle middle phalanges (not a thumbs-down), both hands', () => {
  const fist = fingerStateFromCurls({ thumb: 1, index: 1, middle: 1, ring: 1, little: 1 });
  for (const side of ['left', 'right']) {
    const hand = RIG.hands[side], hf = hand.frame, W = RIG.H[`${side}Hand`];
    const J = syntheticJoints(hand, side, fist, [0, 0, 0, 1], W, W);
    // hand-frame cm: forward (to the knuckles), radial (thumb side), palm (out of the palm)
    const loc = n => { const d = [0, 1, 2].map(k => J[n][k] - W[k]); const dot = a => d[0] * a[0] + d[1] * a[1] + d[2] * a[2]; return [dot(hf.F), dot(hf.R), -dot(hf.D)].map(x => x * 100); };
    const tip = loc('thumb-tip'), idx = loc('index-finger-phalanx-intermediate'), mid = loc('middle-finger-phalanx-intermediate');
    assert.ok(tip[2] < idx[2] + 3.5, `${side}: thumb tip ${tip[2].toFixed(1)} cm out of the palm (fingers at ${idx[2].toFixed(1)}) - sticks out below the fist`);
    assert.ok(tip[2] > idx[2], `${side}: thumb tip on the outside of the curled fingers`);
    assert.ok(tip[1] < idx[1] && tip[1] > mid[1] - 2, `${side}: thumb tip across, between index and middle (radial ${tip[1].toFixed(1)} cm)`);
    assert.ok(tip[0] > 7, `${side}: thumb tip forward at the middle phalanges (${tip[0].toFixed(1)} cm)`);
  }
});
