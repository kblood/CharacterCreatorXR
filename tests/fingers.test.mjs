import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { FINGERS, fingerStateFromCurls, fingerStateFromJoints, syntheticJoints, limitFingerState, fingerWorldDeltas, LIMITS, XR_JOINTS } from '../src/ik/fingers.js';
import { evaluateSource, matchProfile, readChannel, mergeTables, createFingerInput, learnMapping, fallbackCurls } from '../src/input/fingerInput.js';
import { qNormalize, qRotate, qAngle } from '../src/ik/qx.js';
import { RIG, DEG, rng, allFinite } from './helpers.mjs';

const TABLE = JSON.parse(readFileSync(new URL('../src/input/finger_profiles.json', import.meta.url), 'utf8'));
const R = rng(5);
const randQ = () => qNormalize([R() - 0.5, R() - 0.5, R() - 0.5, R() - 0.5]);

test('XR joint list has the 25 WebXR joints in spec order', () => {
  assert.equal(XR_JOINTS.length, 25);
  assert.equal(XR_JOINTS[0], 'wrist');
  assert.equal(XR_JOINTS[4], 'thumb-tip');
  assert.equal(XR_JOINTS[24], 'pinky-finger-tip');
});

test('round trip: finger state -> synthetic XR joints -> finger state (both hands, any wrist pose)', () => {
  for (const side of ['left', 'right']) {
    for (let i = 0; i < 40; i++) {
      const curls = { thumb: R(), index: R(), middle: R(), ring: R(), little: R() };
      const fs = fingerStateFromCurls(curls);
      const joints = syntheticJoints(RIG.hands[side], side, fs, randQ(), [R(), 1 + R(), R()], RIG.H[`${side}Hand`]);
      const back = fingerStateFromJoints(side, joints);
      for (const f of FINGERS) for (const k of ['pitch', 'bend1', 'bend2']) {
        assert.ok(Math.abs(back.fingers[f][k] - fs[f][k]) < 0.5 * DEG, `${side} ${f}.${k}: ${back.fingers[f][k]} vs ${fs[f][k]}`);
      }
    }
  }
});

test('finger deltas reproduce the synthetic joints on the avatar hand', () => {
  const side = 'left', hd = randQ();
  const fs = fingerStateFromCurls({ thumb: 0.4, index: 0.9, middle: 0.2, ring: 0.6, little: 1 });
  const W = fingerWorldDeltas(RIG.hands[side], side, fs, hd);
  const wrist = [0.1, 1.0, 0.2];
  const J = syntheticJoints(RIG.hands[side], side, fs, hd, wrist, RIG.H.leftHand);
  // index: rotate the rest segment by its world delta and compare with the synthetic segment direction
  const rest = RIG.hands[side].fingers.Index;
  const seg = (a, b) => { const d = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], l = Math.hypot(...d); return d.map(x => x / l); };
  const want = seg(J['index-finger-phalanx-intermediate'], J['index-finger-phalanx-distal']);
  const got = qRotate(W.leftIndexIntermediate, seg(rest.pts[1], rest.pts[2]));
  assert.ok(Math.hypot(want[0] - got[0], want[1] - got[1], want[2] - got[2]) < 1e-6);
  assert.ok(allFinite(W));
});

test('joint limits clamp impossible hand-tracking angles', () => {
  const bad = {};
  for (const f of FINGERS) bad[f] = { yaw: 3, pitch: -2, bend1: 3, bend2: -1, curl: 0, src: 'hand' };
  const lim = limitFingerState(bad, RIG.hands.left);
  for (const f of FINGERS) {
    const L = f === 'Thumb' ? LIMITS.Thumb : LIMITS.finger;
    assert.ok(lim[f].pitch >= L.pitch[0] - 1e-9 && lim[f].pitch <= L.pitch[1] + 1e-9);
    assert.ok(lim[f].bend1 <= L.bend1[1] + 1e-9 && lim[f].bend2 >= L.bend2[0] - 1e-9);
    assert.ok(lim[f].yaw - RIG.hands.left.fingers[f].rest.yaw <= L.yaw[1] + 1e-9);
  }
});

// ---- input layer ----
const btn = (value = 0, touched = false) => ({ value, touched, pressed: value > 0.5 });
const snap = (profiles, buttons, axes = [0, 0, 0, 0], handedness = 'left', extra = {}) =>
  ({ handedness, profiles, targetRayMode: 'tracked-pointer', hasHand: false, joints: null, gamepad: { mapping: 'xr-standard', buttons, axes }, ...extra });

test('profile matching: exact, prefix, counts', () => {
  const s1 = snap(['test-finger-controller', 'generic-trigger'], new Array(11).fill(0).map(() => btn()), [0, 0, 0, 0, 0]);
  assert.equal(matchProfile(TABLE, s1)?.id, 'emulated-finger-controller');
  const s2 = snap(['test-finger-controller'], new Array(7).fill(0).map(() => btn()));
  assert.equal(matchProfile(TABLE, s2), null, 'too few buttons');
  const s3 = snap(['valve-frame-controller-v2'], [btn(), btn()]);
  assert.equal(matchProfile(TABLE, s3)?.id, 'valve-frame-placeholder');
  assert.equal(matchProfile(TABLE, snap(['oculus-touch-v3'], [btn()])), null);
});

test('channels: value, touched, axis ranges, invert, missing', () => {
  const gp = { buttons: [btn(0.5, true), btn(0, true)], axes: [-1, 0.5] };
  assert.equal(readChannel(gp, { button: 0 }), 0.5);
  assert.equal(readChannel(gp, { button: 1, field: 'touched' }), 1);
  assert.equal(readChannel(gp, { button: 1, touchCurl: 0.3 }), 0.3);
  assert.equal(readChannel(gp, { axis: 0, min: -1, max: 1 }), 0);
  assert.equal(readChannel(gp, { axis: 1, invert: true }), 0.5);
  assert.equal(readChannel(gp, { button: 9 }), null);
  assert.equal(readChannel(gp, { axis: 7 }), null);
});

test('gamepad-finger path drives each finger from its own channel', () => {
  const b = new Array(11).fill(0).map(() => btn());
  b[7] = btn(1); b[8] = btn(0); b[9] = btn(0.5); b[10] = btn(0.25);
  const ev = evaluateSource(snap(['test-finger-controller'], b, [0, 0, 0, 0, 0.8]), TABLE, RIG.hands.left);
  assert.equal(ev.kind, 'controller-finger');
  assert.equal(ev.paths.index, 'controller-finger:button7');
  assert.equal(ev.paths.thumb, 'controller-finger:axis4');
  assert.ok(ev.state.Index.curl > 0.95 && ev.state.Middle.curl < 0.05);
  assert.ok(Math.abs(ev.state.Ring.curl - 0.5) < 0.05);
  assert.ok(ev.state.Thumb.curl > 0.7);
  assert.equal(ev.state.Index.src, 'controller-finger');
});

test('partial mapping: unmapped fingers fall back to trigger/grip', () => {
  const table = mergeTables(TABLE, { profiles: [{ id: 'x', match: { profiles: ['my-ctrl'] }, fingers: { index: { axis: 4 } } }] });
  const b = [btn(0), btn(1), btn(), btn(), btn(), btn(), btn()];
  const ev = evaluateSource(snap(['my-ctrl'], b, [0, 0, 0, 0, 0.1]), table, RIG.hands.right);
  assert.equal(ev.paths.index, 'controller-finger:axis4');
  assert.equal(ev.paths.middle, 'controller:button1');
  assert.ok(ev.state.Middle.curl > 0.95);
  assert.ok(ev.state.Index.curl < 0.15);
});

test('plain controller fallback: trigger -> index, grip -> others, thumb touch', () => {
  const b = [btn(1), btn(0), btn(), btn(0, false), btn(0, true), btn(), btn()];
  const ev = evaluateSource(snap(['oculus-touch-v3'], b), TABLE, RIG.hands.left);
  assert.equal(ev.kind, 'controller');
  assert.ok(ev.state.Index.curl > 0.95);
  assert.ok(ev.state.Middle.curl < 0.3);
  assert.ok(ev.state.Thumb.curl > 0.8);
  const none = fallbackCurls(null, TABLE.fallback);
  assert.equal(none.paths.index, 'rest');
});

test('articulated hand wins over the gamepad; missing joints fall back', () => {
  const fs = fingerStateFromCurls({ index: 1, middle: 0, ring: 0, little: 0, thumb: 0 });
  const joints = syntheticJoints(RIG.hands.right, 'right', fs, [0, 0, 0, 1], [0, 1, 0], RIG.H.rightHand);
  const s = snap(['generic-hand'], [btn(0)], [], 'right', { hasHand: true, joints });
  const ev = evaluateSource(s, TABLE, RIG.hands.right);
  assert.equal(ev.kind, 'hand');
  assert.ok(ev.state.Index.curl > 0.9 && ev.state.Middle.curl < 0.1);
  const partial = { ...joints }; delete partial['ring-finger-phalanx-distal'];
  assert.notEqual(evaluateSource({ ...s, joints: partial }, TABLE, RIG.hands.right).kind, 'hand');
});

test('stateful layer blends on source change and never NaNs', () => {
  const fi = createFingerInput(TABLE);
  const b = new Array(11).fill(0).map(() => btn());
  let out;
  for (let i = 0; i < 30; i++) out = fi.update([snap(['oculus-touch-v3'], [btn(1), btn(1), btn(), btn(), btn(), btn(), btn()])], 1 / 72, RIG);
  assert.ok(out.left.state.Index.curl > 0.9);
  assert.equal(out.right.kind, 'rest');
  out = fi.update([snap(['test-finger-controller'], b, [0, 0, 0, 0, 0])], 1 / 72, RIG);
  assert.ok(out.left.blend < 1 && out.left.state.Index.curl > 0.5, 'blends, no pop');
  for (let i = 0; i < 60; i++) out = fi.update([snap(['test-finger-controller'], b, [0, 0, 0, 0, 0])], 1 / 72, RIG);
  assert.ok(out.left.state.Index.curl < 0.05);
  assert.ok(allFinite(out.left.state.Index));
});

test('learn wizard maps the channel that moved for each finger', () => {
  const mk = vals => ({ buttons: vals.b.map(v => btn(v)), axes: vals.a });
  const base = { b: [0, 0, 0, 0.1, 0, 0], a: [0, 0, 0.2] };
  const samples = {
    open: [mk(base), mk(base)],
    index: [mk({ ...base, b: [0, 0, 0, 0.1, 0.9, 0] })],
    middle: [mk({ ...base, b: [0, 0, 0, 0.1, 0.3, 0.95] })],
    thumb: [mk({ ...base, a: [0, 0, -0.7] })],
    ring: [mk(base)],
  };
  const { entry, report } = learnMapping(samples, 'mystery-ctrl');
  assert.deepEqual(entry.match, { profiles: ['mystery-ctrl'] });
  assert.equal(entry.fingers.index.button, 4);
  assert.equal(entry.fingers.middle.button, 5);
  assert.equal(entry.fingers.thumb.axis, 2);
  assert.equal(entry.fingers.thumb.invert, true);
  assert.equal(entry.fingers.ring, undefined);
  assert.ok(report.ring < 0.25);
  // the learned entry works through the normal path
  const table = mergeTables(TABLE, { profiles: [entry] });
  const ev = evaluateSource({ handedness: 'left', profiles: ['mystery-ctrl'], hasHand: false, gamepad: { mapping: '', buttons: [0, 0, 0, 0.1, 0.9, 0].map(v => btn(v)), axes: [0, 0, -0.7] } }, table, RIG.hands.left);
  assert.ok(ev.state.Index.curl > 0.95 && ev.state.Thumb.curl > 0.95);
});
