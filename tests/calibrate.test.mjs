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
  for (let i = 0; i < 200; i++) e.push(i % 5 === 0 ? 1.0 : 1.62 + (i % 3) * 0.005, i % 7 === 0 ? 0.9 : 0, 1 / 72);
  const est = e.estimate();
  assert.ok(est > 1.6 && est < 1.64, `estimate ${est}`);
});
