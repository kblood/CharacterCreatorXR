// SPDX-License-Identifier: GPL-3.0-or-later
// Upper-body IK invariants: hand-body collision, elbow pole stability (no flips across the chest, overhead,
// behind the back, at the hips), forearm twist continuity, neck limit, reach lean, left/right mirror symmetry.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createVRIK } from '../src/ik/vrik.js';
import { insideTorso } from '../src/ik/bodyvolume.js';
import { fingerStateFromCurls } from '../src/ik/fingers.js';
import { mirrorPose } from '../vendor/cc/animation/canonical.js';
import { qAxisAngle, qMul, qConj, qNormalize } from '../src/ik/qx.js';
import { RIG, viewer, handQ, worldJoints, dist, DEG, allFinite } from './helpers.mjs';

const HEAD = viewer([0, 1.55, 0]);                 // avatar faces world -Z: its left is world -x, forward is -z
const hand = (x, y, z, F = [0, 0, -1], D = [0, 1, 0]) => ({ pos: [x, y, z], quat: handQ(F, D), valid: true });
const REST_R = hand(0.2, 0.85, -0.05, [0, -1, 0], [1, 0, 0]);
const settle = (ik, input, n = 60) => { let r; for (let i = 0; i < n; i++) r = ik.solve(input, 1 / 72); return r; };
const angle = (a, b) => 2 * Math.acos(Math.min(1, Math.abs(a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3])));

test('collision: a hand target inside the belly is pushed to the surface, the drift is reported', () => {
  const ik = createVRIK(RIG, { idleSway: 0 });
  // left hand at the middle of the belly (the torso centre is ~5 cm behind the eyes here): deep inside
  const r = settle(ik, { head: HEAD, hands: { left: hand(-0.02, 1.02, 0.06, [1, 0, 0], [0, 0, -1]), right: REST_R } });
  const a = r.debug.arms.left;
  assert.ok(a.push > 0.05, `push ${a.push}`);
  assert.ok(a.drift > 0.05, `drift ${a.drift}`);
  assert.ok(!insideTorso(ik.state.torso, RIG.H, r.world, r.positions, r.positions.leftHand, 0.015), 'wrist outside the torso');
  // the same target with collision off is reached exactly (it is the collision that moved it)
  const ik2 = createVRIK(RIG, { idleSway: 0, collision: false });
  const r2 = settle(ik2, { head: HEAD, hands: { left: hand(-0.02, 1.02, 0.06, [1, 0, 0], [0, 0, -1]), right: REST_R } });
  assert.ok(dist(worldJoints(r2).leftHand, [-0.02, 1.02, 0.06]) < 1e-3);
});

test('collision: hands outside the body are untouched; a hand on the face stays on the face surface', () => {
  const ik = createVRIK(RIG, { idleSway: 0 });
  const r = settle(ik, { head: HEAD, hands: { left: hand(-0.3, 1.2, -0.35), right: hand(0.3, 1.2, -0.35) } });
  for (const s of ['left', 'right']) assert.equal(r.debug.arms[s].push, 0, `${s} push`);
  // hand right where the face is (5 cm in front of the head joint)
  const J0 = worldJoints(r);
  const face = [J0.head[0], J0.head[1] + 0.01, J0.head[2] - 0.05];
  const r2 = settle(ik, { head: HEAD, hands: { left: hand(face[0], face[1], face[2], [0, 1, 0], [0, 0, -1]), right: REST_R } });
  const J = worldJoints(r2);
  assert.ok(r2.debug.arms.left.push > 0.02, `face push ${r2.debug.arms.left.push}`);
  assert.ok(dist(J.leftHand, J.head) > 0.06, 'wrist pushed out of the head volume');
  assert.ok(dist(J.leftHand, face) < 0.2, 'but stays near the face');
});

/** Sweep the left hand along a path (1 cm steps) and return the largest elbow jump between steps. */
function sweep(path, { steps = 120, quat } = {}) {
  const ik = createVRIK(RIG, { idleSway: 0 });
  let prev = null, maxJump = 0, inside = 0;
  for (let i = 0; i <= steps; i++) {
    const t = i / steps, p = path(t);
    const r = ik.solve({ head: HEAD, hands: { left: { pos: p, quat: quat ? quat(t) : handQ([0, 0, -1], [0, 1, 0]), valid: true }, right: REST_R } }, 1 / 72);
    if (i === 0) settle(ik, { head: HEAD, hands: { left: { pos: p, quat: quat ? quat(0) : handQ([0, 0, -1], [0, 1, 0]), valid: true }, right: REST_R } }, 30);
    const e = r.positions.leftLowerArm;
    if (prev && i > 1) maxJump = Math.max(maxJump, dist(e, prev));
    if (insideTorso(ik.state.torso, RIG.H, r.world, r.positions, e, 0.03)) inside++;
    prev = [...e];
    assert.ok(allFinite(r.pose));
  }
  return { maxJump, inside };
}
const lerp = (a, b) => t => a.map((v, k) => v + (b[k] - v) * t);

test('elbow pole: no flips when the hand crosses the chest, goes overhead, behind the back and to the hips', () => {
  const paths = {
    acrossChest: lerp([-0.35, 1.25, -0.3], [0.25, 1.3, -0.12]),       // left hand from the left side to the right shoulder
    overhead: lerp([-0.3, 1.2, -0.35], [-0.12, 1.95, 0.0]),
    behindBack: lerp([-0.3, 1.0, -0.1], [-0.05, 1.05, 0.22]),
    hips: lerp([-0.3, 1.1, -0.25], [-0.22, 0.88, 0.05]),
  };
  for (const [name, p] of Object.entries(paths)) {
    const { maxJump, inside } = sweep(p);
    // the hand moves 0.6-0.8 m over 120 steps (~6 mm/step): an elbow flip would jump by >10 cm
    assert.ok(maxJump < 0.04, `${name}: elbow jumped ${maxJump.toFixed(3)} m in one step`);
    assert.equal(inside, 0, `${name}: elbow inside the torso in ${inside} frames`);
  }
});

test('forearm twist: rotating the hand 200 deg about the forearm turns the forearm smoothly (no wrap flip)', () => {
  const ik = createVRIK(RIG, { idleSway: 0 });
  const pos = [-0.25, 1.2, -0.4];
  let prevTw = null, maxStep = 0;
  for (let i = 0; i <= 200; i++) {
    const a = i * DEG;                               // roll about the pointing direction (-z)
    const q = qMul(qAxisAngle([0, 0, -1], a), handQ([0, 0, -1], [0, 1, 0]));
    const r = ik.solve({ head: HEAD, hands: { left: { pos, quat: q, valid: true }, right: REST_R } }, 1 / 72);
    const tw = ik.state.tw.left;
    if (prevTw != null) maxStep = Math.max(maxStep, Math.abs(tw - prevTw));
    prevTw = tw;
    assert.ok(allFinite(r.pose));
  }
  assert.ok(maxStep < 5 * DEG, `twist step ${maxStep / DEG} deg`);
  assert.ok(Math.abs(prevTw) <= 160 * DEG + 1e-9, 'unwrapped twist is clamped');
});

test('neck limit: the head never turns more than neckMax away from the upper chest', () => {
  const ik = createVRIK(RIG, { idleSway: 0 });
  settle(ik, { head: HEAD, hands: {} });
  for (const [yaw, pitch] of [[50, 0], [-50, 60], [0, 80], [0, -60], [40, 50]]) {
    const r = ik.solve({ head: viewer([0, 1.55, 0], { yaw: yaw * DEG, pitch: pitch * DEG }), hands: {} }, 1 / 72);
    const a = angle(r.world.upperChest, r.world.head);
    assert.ok(a <= ik.options.neckMax + 1e-6, `yaw ${yaw} pitch ${pitch}: head vs chest ${(a / DEG).toFixed(1)} deg`);
  }
});

test('reach lean: a hand beyond arm length in front bends the torso forward, within the limit', () => {
  const far = { head: HEAD, hands: { left: hand(-0.15, 1.1, -0.85), right: hand(0.15, 1.1, -0.85) } };
  const near = { head: HEAD, hands: { left: hand(-0.2, 1.1, -0.35), right: hand(0.2, 1.1, -0.35) } };
  const a = settle(createVRIK(RIG, { idleSway: 0 }), far, 90).debug.lean;
  const b = settle(createVRIK(RIG, { idleSway: 0 }), near, 90).debug.lean;
  assert.ok(a > b + 8 * DEG, `lean far ${a / DEG} vs near ${b / DEG}`);
  const c = settle(createVRIK(RIG, { idleSway: 0, handLeanMax: 0 }), far, 90).debug.lean;
  assert.ok(a - c <= 28 * DEG + 1e-6 && a > c, 'bounded by handLeanMax');
});

// mirror helpers: world reflection x -> -x
const mq = q => [q[0], -q[1], -q[2], q[3]];
const mp = p => [-p[0], p[1], p[2]];
const mHand = h => (h ? { pos: mp(h.pos), quat: mq(h.quat), valid: h.valid } : h);

test('left/right mirror symmetry: a mirrored input gives the mirrored pose (arms, fingers, legs)', () => {
  const fsL = fingerStateFromCurls({ index: 0.8, thumb: 0.3, middle: 0.2, ring: 0.5, little: 0.9 });
  const fsR = fingerStateFromCurls({ index: 0.1, thumb: 0.9, middle: 0.6, ring: 0.2, little: 0.4 });
  const inA = { head: viewer([0.05, 1.5, 0.02], { yaw: 0.3, pitch: 0.2, roll: 0.1 }), hands: { left: hand(-0.3, 1.3, -0.3, [0.2, 0.3, -1], [0, 1, 0.3]), right: hand(0.05, 1.0, -0.2, [-1, 0, -0.2], [0, 0.2, -1]) }, fingers: { left: fsL, right: fsR } };
  const inB = { head: { pos: mp(inA.head.pos), quat: mq(inA.head.quat) }, hands: { left: mHand(inA.hands.right), right: mHand(inA.hands.left) }, fingers: { left: fsR, right: fsL } };
  const ra = settle(createVRIK(RIG, { idleSway: 0, kneelSide: null }), inA, 120);
  const A = JSON.parse(JSON.stringify(ra.pose)), rigA = { ...ra.rig, position: [...ra.rig.position] };
  const rb = settle(createVRIK(RIG, { idleSway: 0, kneelSide: null }), inB, 120);
  const mA = mirrorPose(A);
  let worst = 0, wj = '';
  for (const [j, q] of Object.entries(rb.pose.joints)) {
    const e = angle(qNormalize(q), qNormalize(mA.joints[j] || [0, 0, 0, 1]));
    if (e > worst) { worst = e; wj = j; }
  }
  assert.ok(worst < 0.5 * DEG, `worst joint ${wj}: ${(worst / DEG).toFixed(3)} deg`);
  assert.ok(Math.abs(rb.rig.position[0] + rigA.position[0]) < 1e-4 && Math.abs(rb.rig.position[2] - rigA.position[2]) < 1e-4, 'placement mirrored');
  // yaw mirrors to -yaw
  assert.ok(Math.abs(Math.sin(rb.rig.yaw + rigA.yaw)) < 1e-4, `yaw ${rb.rig.yaw} vs ${rigA.yaw}`);
});

test('result object is reused and stays finite; outputs are rotations + a root placement only', () => {
  const ik = createVRIK(RIG);
  const r1 = ik.solve({ head: HEAD, hands: {} }, 1 / 72), r2 = ik.solve({ head: HEAD, hands: {} }, 1 / 72);
  assert.equal(r1, r2, 'same object');
  assert.deepEqual(Object.keys(r2.pose).sort(), ['joints', 'root']);
  for (const q of Object.values(r2.pose.joints)) assert.ok(Math.abs(Math.hypot(...q) - 1) < 1e-6, 'unit quaternions');
});
