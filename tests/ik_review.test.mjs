// SPDX-License-Identifier: GPL-3.0-or-later
// Regression tests for the IK review findings (state machines firing on the wrong motion, wrist pop, armScale
// consistency, reset). Each test is the reviewer's repro turned into an assertion.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createVRIK } from '../src/ik/vrik.js';
import { RIG, viewer, handQ, DEG } from './helpers.mjs';
import { qMul, qConj, qAxisAngle, qRotate, vNorm } from '../src/ik/qx.js';

const DT = 1 / 72;
const qAng = (a, b) => 2 * Math.acos(Math.min(1, Math.abs(a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3])));
const idle = (k = 1, at = [0, 0]) => ({
  left: { pos: [(at[0] - 0.2) * k, 0.8 * k, (at[1] - 0.05) * k], quat: handQ([0, -1, 0], [-1, 0, 0]), valid: true },
  right: { pos: [(at[0] + 0.2) * k, 0.8 * k, (at[1] - 0.05) * k], quat: handQ([0, -1, 0], [1, 0, 0]), valid: true },
});

test('calibration step: a world / avatar scale change + ik.reset() does not read as a jump or a walk', () => {
  const eye = 1.40, at = [0.6, -1.5];
  for (const [k, s] of [[RIG.eyeHeight / eye, 1], [1, eye / RIG.eyeHeight]]) {
    const frame = (kk, ss) => ({ head: viewer([at[0] * kk, eye * kk, at[1] * kk]), hands: idle(kk, at), scale: ss });
    // without the reset (the reviewer's repro) the step is a 'jump' and the feet walk
    const bad = createVRIK(RIG);
    for (let i = 0; i < 200; i++) bad.solve(frame(1, 1), DT);
    let badSpeed = 0;
    for (let i = 0; i < 144; i++) badSpeed = Math.max(badSpeed, bad.solve(frame(k, s), DT).debug.speed);
    // with it (main.js rebaseIK) nothing happens
    const ik = createVRIK(RIG);
    for (let i = 0; i < 200; i++) ik.solve(frame(1, 1), DT);
    ik.reset();
    const steps0 = ik.state.loco.steps;
    let maxSpeed = 0;
    for (let i = 0; i < 144; i++) {
      const r = ik.solve(frame(k, s), DT);
      assert.equal(ik.state.air, 'ground', `k ${k} s ${s}`);
      maxSpeed = Math.max(maxSpeed, r.debug.speed);
    }
    assert.ok(maxSpeed < 0.05, `speed ${maxSpeed}`);
    assert.equal(ik.state.loco.steps - steps0, 0, 'no steps');
    assert.ok(badSpeed > 0.3, `repro: without the reset the step reads as motion (${badSpeed.toFixed(2)} m/s)`);
  }
});

test('standing up fast from a squat is not a jump; a real hop still is', () => {
  for (const [lo, T] of [[1.0, 0.6], [1.2, 0.5], [1.35, 0.4]]) {
    const ik = createVRIK(RIG);
    for (let i = 0; i < 150; i++) ik.solve({ head: viewer([0, lo, 0]), hands: idle() }, DT);
    for (let i = 0; i < Math.round((T + 1) / DT); i++) {
      const t = Math.min(1, i * DT / T), m = 10 * t ** 3 - 15 * t ** 4 + 6 * t ** 5;
      ik.solve({ head: viewer([0, lo + (RIG.eyeHeight - lo) * m, 0]), hands: idle() }, DT);
      assert.equal(ik.state.air, 'ground', `stand-up from ${lo} in ${T} s read as a jump`);
    }
  }
  // a hop (head 15 cm up; the same threshold as before the fix) is still detected
  const ik = createVRIK(RIG);
  for (let i = 0; i < 150; i++) ik.solve({ head: viewer([0, RIG.eyeHeight, 0]), hands: idle() }, DT);
  const v0 = Math.sqrt(2 * 9.81 * 0.15), Tf = 2 * v0 / 9.81, seen = new Set();
  for (let i = 0; i < 72; i++) {
    const t = i * DT, y = t < Tf ? v0 * t - 4.905 * t * t : 0;
    ik.solve({ head: viewer([0, RIG.eyeHeight + y, 0]), hands: idle() }, DT);
    seen.add(ik.state.air);
  }
  assert.ok(seen.has('jump'), `15 cm hop: ${[...seen]}`);
});

test('sit: a straight-down crouch with level gaze is not sitting; sitting down (head back) is', () => {
  const run = (eyeRatio, dz) => {
    const ik = createVRIK(RIG, { kneelSide: null });
    for (let i = 0; i < 90; i++) ik.solve({ head: viewer([0, RIG.eyeHeight, 0]), hands: idle() }, DT);
    const y1 = RIG.eyeHeight * eyeRatio;
    for (let i = 0; i < 72; i++) ik.solve({ head: viewer([0, RIG.eyeHeight + (y1 - RIG.eyeHeight) * i / 72, dz * i / 72]), hands: idle(0.9) }, DT);
    let r;
    for (let i = 0; i < 72 * 3; i++) r = ik.solve({ head: viewer([0, y1, dz]), hands: idle(0.9) }, DT);
    return r.debug.sit;
  };
  assert.ok(run(0.7, 0) < 0.05, 'straight-down crouch read as sitting');
  assert.ok(run(0.8, -0.03) < 0.05, 'half squat, head 3 cm forward read as sitting');
  assert.ok(run(0.78, 0.2) > 0.9, 'sitting down onto a chair behind not detected');
});

test('wrist: rolling the hand continuously (up to 360 deg) never pops the rendered hand', () => {
  const maxStep = 1.5 * DEG;                       // per frame; the roll itself moves 0.6 deg per frame
  const POSES = [[[-0.18, 1.3, -0.5], [0, 0, -1]], [[-0.05, 1.0, -0.3], vNorm([1, 0, -1])], [[-0.22, 0.85, -0.05], [0, -1, 0]], [[-0.2, 2.0, -0.1], [0, 1, 0]]];
  for (const [pos, F] of POSES) for (const dir of [1, -1]) {
    const up = Math.abs(F[1]) > 0.9 ? [0, 0, F[1] > 0 ? 1 : -1] : [0, 1, 0];
    const ik = createVRIK(RIG);
    let prev = null, worst = 0, exactTo = null;
    for (let i = 0; i <= 600; i++) {
      const roll = dir * i * 0.6 * DEG;
      const q = handQ(F, qRotate(qAxisAngle(F, roll), up));
      const res = ik.solve({ head: viewer([0, 1.55, 0]), hands: { left: { pos, quat: q, valid: true }, right: idle().right } }, DT);
      const got = res.world.leftHand;
      const want = qMul(qMul(qAxisAngle([0, 1, 0], -ik.state.psi), q), qConj(RIG.hands.left.frame.q));
      if (exactTo == null && qAng(want, got) > 1 * DEG) exactTo = Math.abs(roll);
      if (prev) worst = Math.max(worst, qAng(prev, got));
      prev = [...got];
    }
    assert.ok(worst <= maxStep, `pose ${pos} dir ${dir}: pop ${(worst / DEG).toFixed(1)} deg`);
    assert.ok(exactTo > 95 * DEG, `pose ${pos} dir ${dir}: exact only to ${(exactTo / DEG).toFixed(0)} deg`);
  }
});

test('armScale: the reach lean uses the scaled target; the relaxed (lost) arm is not scaled', () => {
  const L = RIG.armLength, sh = [-Math.abs(RIG.H.leftUpperArm[0]), RIG.H.leftUpperArm[1]];
  const lean = armScale => {
    const ik = createVRIK(RIG, { armScale });
    let r;
    for (let i = 0; i < 120; i++) r = ik.solve({ head: viewer([0, RIG.eyeHeight, 0]), hands: { left: { pos: [sh[0], sh[1], -1.1 * L], quat: handQ([0, 0, -1], [0, 1, 0]), valid: true }, right: idle().right } }, DT);
    return r.debug.lean;
  };
  assert.ok(lean(1) > 4 * DEG, 'over-reach leans');
  assert.ok(lean(0.8) < 1 * DEG, `long-armed user (armScale 0.8), scaled target in reach, leans ${lean(0.8) / DEG}`);
  const relaxed = armScale => {
    const ik = createVRIK(RIG, { armScale });
    let r;
    for (let i = 0; i < 200; i++) r = ik.solve({ head: viewer([0, RIG.eyeHeight, 0]), hands: { right: idle().right } }, DT);
    return r.debug.arms.left;
  };
  const a = relaxed(1), b = relaxed(1.2);
  assert.ok(Math.abs(a.reach - b.reach) < 1e-6 && !b.clamped, `relaxed arm reach ${a.reach} vs ${b.reach}`);
});

test('reset() forgets every per-session state (standing ref, shoulders, sit, twist, held hands)', () => {
  const ik = createVRIK(RIG);
  const up = { left: { pos: [-0.25, 1.5, -0.35], quat: handQ([0, 0, -1], [0, 1, 0]), valid: true }, right: idle().right };
  for (let i = 0; i < 120; i++) ik.solve({ head: viewer([0.5, RIG.eyeHeight, 0.5]), hands: up }, DT);
  ik.reset();
  const st = ik.state;
  assert.equal(st.hasSh, false); assert.equal(st.hasStandRef, false); assert.equal(st.sitW, 0);
  assert.equal(st.tw.left, 0); assert.equal(st.lastHand.left.ok, false); assert.equal(st.vy, 0);
  // the first frame after a reset with the hand lost relaxes (nothing held from the old session)
  const r = ik.solve({ head: viewer([0, RIG.eyeHeight, 0]), hands: { right: idle().right } }, DT);
  assert.equal(r.debug.arms.left.held, false);
});
