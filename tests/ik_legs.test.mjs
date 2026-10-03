// SPDX-License-Identifier: GPL-3.0-or-later
// Legs / posture: clip-driven walking (forward, backwards, sideways), foot locking, turning in place, sit
// heuristic, tracked jump state machine, lost-hand hold + relax, clip tables.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createVRIK } from '../src/ik/vrik.js';
import { buildClipTables, createClipLoco, stepClipLoco, LOCO_CLIPS } from '../src/ik/cliploco.js';
import { RIG, HEADS, viewer, handQ, worldJoints, dist, DEG, allFinite } from './helpers.mjs';

const DT = 1 / 72;
const EYE = RIG.H.head[1] + RIG.eyeOffset[1];
const hands = (x, z) => ({ left: { pos: [x - 0.2, 0.85, z - 0.05], quat: handQ([0, -1, 0], [-1, 0, 0]), valid: true }, right: { pos: [x + 0.2, 0.85, z - 0.05], quat: handQ([0, -1, 0], [1, 0, 0]), valid: true } });
const settle = (ik, input, n = 90) => { let r; for (let i = 0; i < n; i++) r = ik.solve(input, DT); return r; };

/** Walk the viewer (facing -z) with velocity (vx, vz) for `sec` seconds; returns per-frame records. */
function walk(ik, vx, vz, sec, { bob = 0.015 } = {}) {
  const out = [];
  let x = 0, z = 0;
  for (let i = 0; i < sec * 72; i++) {
    const t = i * DT; x += vx * DT; z += vz * DT;
    const r = ik.solve({ head: viewer([x, 1.55 - bob * Math.abs(Math.sin(t * Math.PI * 1.9)), z]), hands: hands(x, z) }, DT);
    const J = worldJoints(r);
    out.push({ t, mode: r.debug.loco.mode, w: { ...r.debug.loco.weights }, feet: r.debug.feet.map(f => ({ ...f, pos: [...f.pos], ball: [...f.ball] })), J, x, z });
  }
  return out;
}

test('clip tables: every locomotion clip is baked, quaternions are unit, contacts alternate', () => {
  const T = buildClipTables(RIG);
  for (const n of LOCO_CLIPS) {
    assert.ok(T[n] && T[n].n > 8, n);
    assert.ok(allFinite(Array.from(T[n].data)), `${n} finite`);
  }
  // walk: each foot has a swing phase (contact 0) and a stance phase
  const st = createClipLoco(T);
  const seen = { left: new Set(), right: new Set() };
  for (let i = 0; i < 200; i++) { const a = stepClipLoco(st, [0, 1.2], DT); seen.left.add(a.side[0].contact > 0.5); seen.right.add(a.side[1].contact > 0.5); }
  assert.equal(seen.left.size, 2); assert.equal(seen.right.size, 2);
});

test('walking forward: clip legs, alternating swing, locked stance feet do not slide, feet keep up', () => {
  const ik = createVRIK(RIG);
  settle(ik, { head: viewer([0, 1.55, 0]), hands: hands(0, 0) });
  const rec = walk(ik, 0, -1.1, 4);
  const late = rec.filter(f => f.t > 1);
  assert.ok(late.every(f => f.mode === 'clips'), 'clip mode while walking');
  assert.ok(late.at(-1).w.walk > 0.8, `walk weight ${late.at(-1).w.walk}`);
  // swings per foot
  const swings = [0, 1].map(i => { let n = 0; for (let k = 1; k < late.length; k++) if (late[k].feet[i].stepping && !late[k - 1].feet[i].stepping) n++; return n; });
  // 1.1 m/s plays the walk clip at ~0.82x: one 1.25 s cycle per swing per foot -> >= 2 swings each in 3 s
  assert.ok(swings[0] >= 2 && swings[1] >= 2, `swings ${swings}`);
  // never both feet in the air while walking
  assert.ok(late.every(f => !(f.feet[0].stepping && f.feet[1].stepping)), 'one foot always planted');
  // a locked foot stays put (world) while locked: the ball of the foot (toes joint; the heel may roll up over
  // it) drifts < 5 mm over its stance
  let maxSlide = 0;
  for (let i = 0; i < 2; i++) {
    let anchor = null;
    for (const f of late) {
      const b = f.feet[i].ball;
      if (f.feet[i].locked) { if (!anchor) anchor = b; maxSlide = Math.max(maxSlide, Math.hypot(b[0] - anchor[0], b[1] - anchor[1])); }
      else anchor = null;
    }
  }
  assert.ok(maxSlide < 0.005, `locked foot slid ${maxSlide}`);
  // feet stay under the body
  const lag = Math.max(...late.map(f => Math.max(...['left', 'right'].map(s => Math.hypot(f.J[`${s}Foot`][0] - f.J.hips[0], f.J[`${s}Foot`][2] - f.J.hips[2])))));
  assert.ok(lag < RIG.legLength * 0.75, `foot lag ${lag}`);
  // planted toes on the floor
  for (const f of late) for (const [i, s] of ['left', 'right'].entries()) if (!f.feet[i].stepping) assert.ok(Math.abs(f.J[`${s}Toes`][1] - HEADS[`${s}Toes`][1]) < 0.012, `${s} toes ${f.J[`${s}Toes`][1]}`);
});

test('direction blend: backwards -> walk_back, sideways -> strafe clips (relative to the body facing)', () => {
  const cases = [[0, 0.8, 'walk_back'], [-0.45, 0, 'strafe_left'], [0.45, 0, 'strafe_right']];   // facing -z: avatar left = -x
  for (const [vx, vz, clip] of cases) {
    const ik = createVRIK(RIG);
    settle(ik, { head: viewer([0, 1.55, 0]), hands: hands(0, 0) });
    const rec = walk(ik, vx, vz, 2.5);
    const w = rec.at(-1).w;
    const best = Object.entries(w).sort((a, b) => b[1] - a[1])[0][0];
    assert.equal(best, clip, `${vx},${vz}: weights ${JSON.stringify(w)}`);
    assert.ok(rec.slice(-30).every(f => allFinite(f.J)), 'finite');
  }
});

test('standing still after walking: back to stepping mode, feet settle under the body', () => {
  const ik = createVRIK(RIG);
  settle(ik, { head: viewer([0, 1.55, 0]), hands: hands(0, 0) });
  const rec = walk(ik, 0, -1.0, 2);
  const { x, z } = rec.at(-1);
  const r = settle(ik, { head: viewer([x, 1.55, z]), hands: hands(x, z) }, 200);
  assert.equal(r.debug.loco.mode, 'step');
  const J = worldJoints(r);
  for (const s of ['left', 'right']) {
    assert.ok(Math.abs(J[`${s}Toes`][1] - HEADS[`${s}Toes`][1]) < 0.01, `${s} on the floor`);
    assert.ok(Math.hypot(J[`${s}Foot`][0] - J.hips[0], J[`${s}Foot`][2] - J.hips[2]) < 0.3, `${s} under the body`);
  }
});

test('turning in place: steps follow the body yaw and both feet end up aligned with it', () => {
  const ik = createVRIK(RIG);
  settle(ik, { head: viewer([0, 1.55, 0]), hands: {} });
  const s0 = ik.state.loco.steps;
  for (let i = 0; i < 72 * 3; i++) ik.solve({ head: viewer([0, 1.55, 0], { yaw: Math.min(1, i / 144) * 100 * DEG }), hands: {} }, DT);
  const r = settle(ik, { head: viewer([0, 1.55, 0], { yaw: 100 * DEG }), hands: {} }, 150);
  assert.ok(ik.state.loco.steps - s0 >= 2, `steps ${ik.state.loco.steps - s0}`);
  for (const f of ik.state.loco.feet) {
    const e = Math.abs(((f.yaw - r.rig.yaw + Math.PI * 3) % (Math.PI * 2)) - Math.PI);
    assert.ok(e < 15 * DEG, `foot yaw error ${e / DEG}`);
  }
});

test('sit heuristic: low, still, level gaze for >1.2 s sits (thighs forward, feet on the floor); a squat with hands low does not', () => {
  const ik = createVRIK(RIG, { kneelSide: null });
  settle(ik, { head: viewer([0, 1.55, 0]), hands: hands(0, 0) });
  const seatEye = EYE * 0.74;
  const lap = { left: { pos: [-0.15, seatEye - 0.5, -0.3], quat: handQ([0, 0, -1], [0, 1, 0]), valid: true }, right: { pos: [0.15, seatEye - 0.5, -0.3], quat: handQ([0, 0, -1], [0, 1, 0]), valid: true } };
  for (let i = 0; i < 72; i++) ik.solve({ head: viewer([0, 1.55 - (1.55 - seatEye) * i / 72, 0.05 * i / 72]), hands: lap }, DT);
  const r0 = ik.solve({ head: viewer([0, seatEye, 0.05]), hands: lap }, DT);
  assert.ok(r0.debug.sit < 0.2, 'not immediately');
  const r = settle(ik, { head: viewer([0, seatEye, 0.05]), hands: lap }, 72 * 2.5);
  assert.ok(r.debug.sit > 0.9, `sit ${r.debug.sit}`);
  const J = worldJoints(r);
  for (const s of ['left', 'right']) {
    const thigh = [J[`${s}LowerLeg`][0] - J[`${s}UpperLeg`][0], J[`${s}LowerLeg`][1] - J[`${s}UpperLeg`][1], J[`${s}LowerLeg`][2] - J[`${s}UpperLeg`][2]];
    const slope = Math.abs(thigh[1]) / Math.hypot(thigh[0], thigh[2]);
    assert.ok(slope < 0.6, `${s} thigh slope ${slope}`);
    assert.ok(J[`${s}LowerLeg`][2] < J[`${s}UpperLeg`][2] - 0.2, `${s} knee in front of the hip`);
    assert.ok(Math.abs(J[`${s}Foot`][1] - RIG.ankleHeight) < 0.03, `${s} foot on the floor ${J[`${s}Foot`][1]}`);
  }
  assert.ok(Math.abs(r.debug.lean) < 8 * DEG, `upright ${r.debug.lean / DEG}`);
  // squat: same eye height but the hands near the floor -> no sit
  const ik2 = createVRIK(RIG, { kneelSide: null });
  const low = { left: { pos: [-0.2, 0.25, -0.35], quat: handQ([0, -1, 0], [0, 0, -1]), valid: true }, right: { pos: [0.2, 0.25, -0.35], quat: handQ([0, -1, 0], [0, 0, -1]), valid: true } };
  const r2 = settle(ik2, { head: viewer([0, seatEye, 0]), hands: low }, 72 * 3);
  assert.ok(r2.debug.sit < 0.05, `squat read as sit ${r2.debug.sit}`);
  // crouch with the head forward (looking down a little, hands at knee height) -> no sit either
  const ik4 = createVRIK(RIG, { kneelSide: null });
  settle(ik4, { head: viewer([0, 1.55, 0]), hands: hands(0, 0) });
  const knees = { left: { pos: [-0.24, 0.62, -0.3], quat: handQ([0, 0, -1], [0, 1, 0]), valid: true }, right: { pos: [0.24, 0.62, -0.3], quat: handQ([0, 0, -1], [0, 1, 0]), valid: true } };
  for (let i = 0; i < 72; i++) ik4.solve({ head: viewer([0, 1.55 - (1.55 - seatEye) * i / 72, -0.09 * i / 72], { pitch: 20 * DEG }), hands: knees }, DT);
  const r4 = settle(ik4, { head: viewer([0, seatEye, -0.09], { pitch: 20 * DEG }), hands: knees }, 72 * 3);
  assert.ok(r4.debug.sit < 0.05, `forward crouch read as sit ${r4.debug.sit}`);
  assert.ok(r4.debug.lean > 0.1, `forward crouch leans ${r4.debug.lean}`);
  // sit: 'off' never sits
  const r3 = settle(createVRIK(RIG, { sit: 'off' }), { head: viewer([0, seatEye, 0.05]), hands: lap }, 72 * 3);
  assert.equal(r3.debug.sit, 0);
});

test('tracked jump: jump -> fall -> land -> ground, feet leave the floor and come back', () => {
  const ik = createVRIK(RIG);
  settle(ik, { head: viewer([0, 1.55, 0]), hands: hands(0, 0) });
  const states = [], footY = [];
  // ballistic head: 0.25 m up, 0.45 s flight
  const v0 = Math.sqrt(2 * 9.81 * 0.25), T = 2 * v0 / 9.81;
  for (let i = 0; i < 72 * 1.6; i++) {
    const t = i * DT, y = t < T ? v0 * t - 4.905 * t * t : 0;
    const r = ik.solve({ head: viewer([0, 1.55 + y, 0]), hands: hands(0, 0) }, DT);
    if (states.at(-1) !== r.debug.loco.air) states.push(r.debug.loco.air);
    const J = worldJoints(r);
    footY.push(Math.min(J.leftFoot[1], J.rightFoot[1]));
    assert.ok(allFinite(r.pose));
  }
  assert.deepEqual(states.slice(0, 5), ['ground', 'jump', 'fall', 'land', 'ground'], `states ${states}`);
  assert.ok(Math.max(...footY) > RIG.ankleHeight + 0.12, `feet up ${Math.max(...footY)}`);
  assert.ok(Math.abs(footY.at(-1) - RIG.ankleHeight) < 0.02, 'back on the floor');
});

test('lost hand: held where it was for holdTime, then relaxes to the side; regained -> tracked again', () => {
  const ik = createVRIK(RIG);
  const up = { left: { pos: [-0.25, 1.5, -0.35], quat: handQ([0, 0, -1], [0, 1, 0]), valid: true }, right: hands(0, 0).right };
  settle(ik, { head: viewer([0, 1.55, 0]), hands: up });
  let r = settle(ik, { head: viewer([0, 1.55, 0]), hands: { left: { valid: false }, right: up.right } }, 18);   // 0.25 s
  assert.ok(dist(worldJoints(r).leftHand, up.left.pos) < 0.02, 'held');
  assert.ok(r.debug.arms.left.held, 'flagged as held');
  r = settle(ik, { head: viewer([0, 1.55, 0]), hands: { left: { valid: false }, right: up.right } }, 150);
  const J = worldJoints(r);
  assert.ok(J.leftHand[1] < 1.05, `relaxed hand down ${J.leftHand[1]}`);
  r = settle(ik, { head: viewer([0, 1.55, 0]), hands: up }, 90);
  assert.ok(dist(worldJoints(r).leftHand, up.left.pos) < 0.005, 'tracked again');
});

test('body change: setRig keeps solving (old clip tables until rebuilt), setBody changes the torso profile', () => {
  const ik = createVRIK(RIG);
  settle(ik, { head: viewer([0, 1.55, 0]), hands: hands(0, 0) });
  const t0 = ik.state.clipTables;
  ik.setRig(RIG);
  let r = settle(ik, { head: viewer([0, 1.55, 0]), hands: hands(0, 0) }, 60);
  assert.ok(allFinite(r.pose));
  assert.notEqual(ik.state.clipTables, t0, 'rebuilt while standing still');
  const before = Float64Array.from(ik.state.torso);
  ik.setBody({ male: 0, bust: 0.03 });
  assert.notDeepEqual(Array.from(ik.state.torso), Array.from(before));
});

test('foot lock across speeds (0.6-4 m/s, walk/run blend included): the ball of a locked foot holds < 5 mm', () => {
  for (const v of [0.6, 1.5, 2.2, 3.0, 4.0]) {
    const ik = createVRIK(RIG);
    settle(ik, { head: viewer([0, 1.55, 0]), hands: {} });
    const rec = walk(ik, 0, -v, 3, { bob: 0 }).filter(f => f.t > 1);
    let maxSlide = 0, locks = 0;
    for (let i = 0; i < 2; i++) {
      let anchor = null;
      for (const f of rec) {
        const b = f.feet[i].ball;
        if (f.feet[i].locked) { if (!anchor) { anchor = b; locks++; } maxSlide = Math.max(maxSlide, Math.hypot(b[0] - anchor[0], b[1] - anchor[1])); }
        else anchor = null;
      }
    }
    assert.ok(locks >= 2, `${v} m/s: ${locks} stances`);
    assert.ok(maxSlide < 0.005, `${v} m/s: locked ball slid ${maxSlide}`);
  }
});
