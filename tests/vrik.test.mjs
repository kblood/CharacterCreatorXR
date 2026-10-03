// SPDX-License-Identifier: GPL-3.0-or-later
import test from 'node:test';
import assert from 'node:assert/strict';
import { createVRIK } from '../src/ik/vrik.js';
import { insideTorso } from '../src/ik/bodyvolume.js';
import { fingerStateFromCurls } from '../src/ik/fingers.js';
import { RIG, viewer, handQ, worldJoints, dist, DEG, allFinite, rng } from './helpers.mjs';

const H = (x, y, z, F, D) => ({ pos: [x, y, z], quat: handQ(F, D), valid: true });
const STAND = { left: H(-0.2, 0.85, -0.05, [0, -1, 0], [-1, 0, 0]), right: H(0.2, 0.85, -0.05, [0, -1, 0], [1, 0, 0]) };
function settle(ik, input, n = 90) { let r; for (let i = 0; i < n; i++) r = ik.solve(input, 1 / 72); return r; }

test('standing: head lands on the tracked head, feet on the floor, pelvis at rest height', () => {
  const ik = createVRIK(RIG);
  const r = settle(ik, { head: viewer([0, 1.55, 0]), hands: STAND });
  const J = worldJoints(r);
  // head joint = eye - eye offset (avatar faces world -Z here, so the offset points to +Z)
  assert.ok(dist(J.head, [0, 1.55 - RIG.eyeOffset[1], RIG.eyeOffset[2]]) < 1e-3, `head ${J.head}`);
  assert.ok(Math.abs(J.hips[1] - RIG.H.hips[1]) < 0.02);
  for (const s of ['left', 'right']) assert.ok(Math.abs(J[`${s}Foot`][1] - RIG.ankleHeight) < 0.005, `${s} foot ${J[`${s}Foot`]}`);
  assert.ok(allFinite(r.pose));
});

test('hands reach reachable targets within 1 mm, with wrist orientation', () => {
  const ik = createVRIK(RIG);
  const targets = [
    [-0.25, 1.1, -0.25], [-0.1, 1.4, -0.3], [-0.2, 1.75, -0.05], [0.05, 1.2, -0.3], [-0.35, 1.35, -0.1], [-0.15, 0.95, 0.05],
  ];
  for (const t of targets) {
    const hands = { left: H(t[0], t[1], t[2], [0, 0, -1], [0, 1, 0]), right: H(-t[0], t[1], t[2], [0, 0, -1], [0, 1, 0]) };
    const r = settle(ik, { head: viewer([0, 1.55, 0]), hands }, 40);
    const J = worldJoints(r);
    for (const s of ['left', 'right']) {
      const e = dist(J[`${s}Hand`], hands[s].pos);
      if (r.debug.arms[s].reach < 0.97) assert.ok(e < 1e-3, `${s} ${t}: err ${e} reach ${r.debug.arms[s].reach}`);
      else assert.ok(e < 0.1, `${s} ${t}: out of reach err ${e}`);
    }
  }
});

test('bone lengths are preserved (FK of the pose on the rest skeleton)', () => {
  const ik = createVRIK(RIG);
  const r = settle(ik, { head: viewer([0.1, 1.2, 0.2], { yaw: 0.7, pitch: 0.4 }), hands: { left: H(0, 1.0, -0.2, [0, 0, -1], [0, 1, 0]), right: H(0.4, 1.4, 0, [1, 0, 0], [0, 1, 0]) } });
  const J = worldJoints(r);
  for (const [a, b] of [['leftUpperArm', 'leftLowerArm'], ['leftLowerArm', 'leftHand'], ['rightUpperLeg', 'rightLowerLeg'], ['rightLowerLeg', 'rightFoot'], ['spine', 'chest']]) {
    const rest = dist(RIG.H[a], RIG.H[b]);
    assert.ok(Math.abs(dist(J[a], J[b]) - rest) < 1e-6, `${a}-${b}`);
  }
});

test('elbows never go through the torso; knees point forward', () => {
  const ik = createVRIK(RIG);
  const R = rng(3);
  for (let i = 0; i < 300; i++) {
    const hands = {
      left: H(-0.5 + R() * 0.7, 0.7 + R() * 1.2, -0.6 + R() * 0.6, [R() - 0.5, R() - 0.5, R() - 0.5], [R() - 0.5, R() - 0.5, R() - 0.5]),
      right: H(-0.2 + R() * 0.7, 0.7 + R() * 1.2, -0.6 + R() * 0.6, [R() - 0.5, R() - 0.5, R() - 0.5], [R() - 0.5, R() - 0.5, R() - 0.5]),
    };
    const r = ik.solve({ head: viewer([0, 1.55, 0]), hands }, 1 / 72);
    const P = r.positions;   // yaw frame (character frame + translation)
    for (const s of ['left', 'right']) {
      // the measured torso profile (src/ik/bodyvolume.js) inflated by 3 cm (the solver keeps 4 cm)
      if (r.debug.arms[s].reach < 0.98) assert.ok(!insideTorso(ik.state.torso, RIG.H, r.world, P, P[`${s}LowerArm`], 0.03), `${s} elbow inside the torso: ${P[`${s}LowerArm`]} target ${r.debug.arms[s].target}`);
    }
    for (const s of ['left', 'right']) {
      const k = P[`${s}LowerLeg`], hip = P[`${s}UpperLeg`], ft = P[`${s}Foot`];
      const lineZ = hip[2] + (ft[2] - hip[2]) * ((hip[1] - k[1]) / Math.max(1e-6, hip[1] - ft[1]));
      assert.ok(k[2] >= lineZ - 1e-6, `${s} knee behind the hip-ankle line`);
    }
  }
});

test('fuzz: 3000 random/degenerate frames never produce NaN', () => {
  const ik = createVRIK(RIG);
  const R = rng(11);
  const rq = () => { const q = [R() - 0.5, R() - 0.5, R() - 0.5, R() - 0.5]; return q; };
  for (let i = 0; i < 3000; i++) {
    const head = { pos: [R() * 4 - 2, R() * 2.2, R() * 4 - 2], quat: i % 97 === 0 ? [0, 0, 0, 0] : rq() };
    const hand = () => (R() < 0.15 ? { valid: false } : { pos: i % 53 === 0 ? [...head.pos] : [head.pos[0] + R() * 2 - 1, R() * 2.2, head.pos[2] + R() * 2 - 1], quat: rq(), valid: true });
    const dt = i % 31 === 0 ? 0 : i % 29 === 0 ? 5 : R() / 30;
    const fingers = { left: fingerStateFromCurls({ index: R(), middle: R(), thumb: R() }), right: null };
    const r = ik.solve({ head, hands: { left: hand(), right: hand() }, fingers, scale: 0.8 + R() * 0.4 }, dt);
    if (!r) continue;
    assert.ok(allFinite(r.pose) && allFinite(r.rig), `NaN at frame ${i}`);
  }
});

test('body yaw: small head turns are absorbed by neck/spine, large ones turn the body', () => {
  const ik = createVRIK(RIG);
  settle(ik, { head: viewer([0, 1.55, 0]), hands: {} });
  const psi0 = ik.state.psi;
  const r1 = ik.solve({ head: viewer([0, 1.55, 0], { yaw: 40 * DEG }), hands: {} }, 1 / 72);
  assert.ok(Math.abs(r1.rig.yaw - psi0) < 5 * DEG, 'body does not snap to a quick head turn');
  const r2 = settle(ik, { head: viewer([0, 1.55, 0], { yaw: 120 * DEG }), hands: {} }, 5);
  const twist = Math.abs(((r2.rig.yaw - psi0 - 120 * DEG + Math.PI * 3) % (Math.PI * 2)) - Math.PI);
  assert.ok(twist <= 55 * DEG + 1e-6, `head-body twist ${twist / DEG}`);
  const r3 = settle(ik, { head: viewer([0, 1.55, 0], { yaw: 120 * DEG }), hands: {} }, 300);
  const t3 = Math.abs(((r3.rig.yaw - psi0 - 120 * DEG + Math.PI * 3) % (Math.PI * 2)) - Math.PI);
  assert.ok(t3 < 3 * DEG, 'body catches up');
});

test('crouch: pelvis goes down, knees bend, feet stay on the floor', () => {
  const ik = createVRIK(RIG, { kneelSide: null });
  settle(ik, { head: viewer([0, 1.55, 0]), hands: STAND });
  const r = settle(ik, { head: viewer([0, 1.05, 0]), hands: {} }, 120);
  const J = worldJoints(r);
  assert.ok(J.hips[1] < RIG.H.hips[1] - 0.25, `pelvis ${J.hips[1]}`);
  for (const s of ['left', 'right']) {
    assert.ok(J[`${s}Foot`][1] < RIG.ankleHeight + 0.07, `${s} foot ${J[`${s}Foot`][1]}`);
    assert.ok(J[`${s}LowerLeg`][1] > J[`${s}Foot`][1] + 0.2);
  }
  assert.ok(J.hips[1] >= RIG.minPelvisY - 1e-6);
});

test('walking without clips (procedural steps): feet take alternating steps and keep up with the body', () => {
  const ik = createVRIK(RIG, { clips: false });
  settle(ik, { head: viewer([0, 1.55, 0]), hands: STAND });
  let lastSteps = ik.state.loco.steps, maxLag = 0, r;
  for (let i = 0; i < 72 * 4; i++) {
    const t = i / 72, z = -1.1 * t, bob = 0.02 * Math.sin(t * 2 * Math.PI * 1.8);
    r = ik.solve({ head: viewer([0, 1.55 + bob, z]), hands: { left: H(-0.2, 0.85, z - 0.05, [0, -1, 0], [-1, 0, 0]), right: H(0.2, 0.85, z - 0.05, [0, -1, 0], [1, 0, 0]) } }, 1 / 72);
    if (i > 72) {
      const J = worldJoints(r);
      for (const s of ['left', 'right']) maxLag = Math.max(maxLag, Math.hypot(J[`${s}Foot`][0] - J.hips[0], J[`${s}Foot`][2] - J.hips[2]));
    }
  }
  const steps = ik.state.loco.steps - lastSteps;
  assert.ok(steps >= 6, `steps ${steps}`);
  assert.ok(maxLag < RIG.legLength * 0.75, `foot lag ${maxLag}`);
  assert.ok(allFinite(r.pose));
});

test('scale: a scaled avatar still puts its head on the tracked head', () => {
  const ik = createVRIK(RIG);
  const r = settle(ik, { head: viewer([0.3, 1.8, 0.4], { yaw: 1 }), hands: {}, scale: 1.8 / 1.553 });
  const J = worldJoints(r);
  const expect = [0.3, 1.8, 0.4];
  const eye = [J.head[0], J.head[1], J.head[2]];
  assert.ok(Math.abs(dist(eye, expect) - Math.hypot(RIG.eyeOffset[1], RIG.eyeOffset[2]) * 1.8 / 1.553) < 2e-3);
});
