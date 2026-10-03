// SPDX-License-Identifier: GPL-3.0-or-later
import test from 'node:test';
import assert from 'node:assert/strict';
import { solveHeight, solveArmScale, createHeightEstimator } from '../src/ik/calibrate.js';

const S = [{ h: -1, eye: 1.42 }, { h: 0, eye: 1.553 }, { h: 1, eye: 1.64 }];

test('morph mode inverts the slider curve, scale 1 inside the range', () => {
  const r = solveHeight(S, 1.6);
  assert.ok(r.height > 0 && r.height < 1);
  assert.ok(Math.abs(r.scale - 1) < 1e-9);
  assert.ok(Math.abs(r.avatarEye - 1.6) < 1e-9);
});

test('outside the slider range the residual goes to the scale', () => {
  const r = solveHeight(S, 1.8);
  assert.equal(r.height, 1);
  assert.ok(Math.abs(r.scale - 1.8 / 1.64) < 1e-9);
  const k = solveHeight(S, 1.0);
  assert.equal(k.height, -1);
  assert.ok(k.scale < 1);
});

test('scale mode keeps the body, off keeps everything; garbage input is refused', () => {
  const r = solveHeight(S, 1.7, { mode: 'scale', current: 0.2 });
  assert.equal(r.height, 0.2);
  assert.ok(r.scale > 1);
  assert.equal(solveHeight(S, 1.7, { mode: 'off' }).scale, 1);
  assert.equal(solveHeight(S, NaN).ok, false);
  assert.equal(solveHeight(S, 0.1).ok, false);
});

test('arm scale from a T-pose, clamped', () => {
  const r = solveArmScale([-0.8, 1.4, 0], [0.8, 1.4, 0], 1.5);
  assert.ok(r.ok && Math.abs(r.armScale - 1.5 / 1.6) < 1e-9);
  assert.equal(solveArmScale([0, 1, 0], [0.2, 1, 0], 1.5).ok, false);
  assert.equal(solveArmScale([-2, 1, 0], [2, 1, 0], 1.5).armScale, 0.8);
});

test('height estimator ignores crouching and looking down', () => {
  const e = createHeightEstimator({ minSamples: 10 });
  for (let i = 0; i < 200; i++) e.push(i % 5 === 0 ? 1.0 : 1.62 + (i % 3) * 0.005, i % 7 === 0 ? 0.9 : 0, 1 / 72, { vy: 0 });
  const est = e.estimate();
  assert.ok(est > 1.6 && est < 1.64, `estimate ${est}`);
});

import { detectTPose, createCalibrationFlow, EYE_TO_HEIGHT } from '../src/ik/calibrate.js';
import { RIG as RIG2 } from './helpers.mjs';

test("'own' mode keeps the avatar and scales the user's world instead", () => {
  const r = solveHeight(S, 1.75, { mode: 'own', current: 0 });
  assert.equal(r.scale, 1);
  assert.equal(r.height, 0);
  assert.ok(Math.abs(r.worldScale - 1.553 / 1.75) < 1e-9);
  assert.equal(solveHeight(S, 1.6).worldScale, 1);
});

test('height estimator v2: plateau median, ignores crouch / sit / tilted head / bobbing, reports confidence', () => {
  const e = createHeightEstimator({ minSamples: 50 });
  const R = (() => { let a = 7; return () => { a = (a * 16807) % 2147483647; return a / 2147483647; }; })();
  for (let i = 0; i < 1500; i++) {
    const k = i % 10;
    let y = 1.63 + (R() - 0.5) * 0.01, pitch = 0, roll = 0;
    if (k === 0) y = 1.0;               // crouching
    if (k === 1) y = 1.2;               // sitting
    if (k === 2) { y = 1.55; pitch = 0.6; }   // looking down (eyes lower)
    if (k === 3) { y = 1.58; roll = 0.5; }    // tilted head
    e.push(y, pitch, 1 / 72, { roll, vy: 0 });
  }
  e.push(1.9, 0, 1 / 72, { vy: 0 });     // one spike
  const r = e.result();
  assert.ok(Math.abs(r.eye - 1.63) < 0.01, `eye ${r.eye}`);
  assert.ok(r.confidence > 0.9, `confidence ${r.confidence}`);
  // bobbing (fast vertical motion) is ignored
  const b = createHeightEstimator({ minSamples: 10 });
  for (let i = 0; i < 100; i++) b.push(1.3 + i * 0.01, 0, 1 / 72);
  assert.equal(b.estimate(), null);
});

test('T-pose detection: wide, level, centred, about shoulder height', () => {
  const head = { pos: [0, 1.6, 0], quat: [0, 0, 0, 1] };
  const v = p => ({ pos: p, valid: true });
  assert.ok(detectTPose(head, v([-0.8, 1.35, 0]), v([0.8, 1.35, 0])).ok);
  assert.equal(detectTPose(head, v([-0.3, 1.35, -0.3]), v([0.3, 1.35, -0.3])).reason, 'span');
  assert.equal(detectTPose(head, v([-0.8, 0.9, 0]), v([0.8, 0.9, 0])).reason, 'height');
  assert.equal(detectTPose(head, v([-0.5, 1.18, 0]), v([0.5, 1.48, 0])).reason, 'tilt');
  assert.equal(detectTPose(head, v([-0.8, 1.35, -0.6]), v([0.8, 1.35, -0.6])).reason, 'centre');
  assert.equal(detectTPose(head, { valid: false }, v([0.8, 1.35, 0])).reason, 'hands');
});

test('calibration flow: countdown -> sample -> median eye + T-pose span; moving or lost tracking fails', () => {
  const f = createCalibrationFlow({ countdown: 1, sample: 1 });
  f.start();
  const rec = (y, span) => ({ head: { pos: [0, y, 0], quat: [0, 0, 0, 1] }, hands: { left: { pos: [-span / 2, y - 0.25, 0], valid: true }, right: { pos: [span / 2, y - 0.25, 0], valid: true } } });
  let s;
  for (let i = 0; i < 74; i++) s = f.update(rec(1.62, 1.66), 1 / 72);
  assert.equal(s.phase, 'sample');
  for (let i = 0; i < 80; i++) s = f.update(rec(1.62 + (i % 2) * 0.004, 1.66), 1 / 72);
  assert.equal(s.phase, 'done');
  assert.ok(Math.abs(s.result.eye - 1.62) < 0.005);
  assert.ok(Math.abs(s.result.span - 1.66) < 1e-9);
  assert.ok(Math.abs(s.result.height - 1.62 / EYE_TO_HEIGHT) < 0.01);
  // arms down: eye only, no span
  f.start();
  for (let i = 0; i < 160; i++) s = f.update({ head: { pos: [0, 1.6, 0] }, hands: {} }, 1 / 72);
  assert.equal(s.phase, 'done'); assert.equal(s.result.span, null);
  // moving during sampling
  f.start();
  for (let i = 0; i < 160; i++) s = f.update(rec(1.3 + i * 0.003, 1.6), 1 / 72);
  assert.equal(s.phase, 'failed'); assert.equal(s.reason, 'moved');
  // tracking lost
  f.start();
  for (let i = 0; i < 160; i++) s = f.update(null, 1 / 72);
  assert.equal(s.phase, 'failed'); assert.equal(s.reason, 'tracking');
  // avatar T-pose span from the rig is in a sensible range
  const tspan = RIG2.armLength * 2 + RIG2.shoulderWidth;
  assert.ok(tspan > 1.2 && tspan < 1.9, `rig span ${tspan}`);
});
