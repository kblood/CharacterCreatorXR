// The emulation hand poses (src/dev/handposes.js) read back through the real finger pipeline with the
// intended curls, for the left data and IWER's mirrored right hand. Uses IWER's own relaxed pose data.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { relaxedHandPose } from 'iwer/lib/device/configs/hand/relaxed.js';
import { pinchHandPose } from 'iwer/lib/device/configs/hand/pinch.js';
import { pointHandPose } from 'iwer/lib/device/configs/hand/point.js';
import { curledHandPose, HAND_POSE_CURLS } from '../src/dev/handposes.js';
import { fingerStateFromJoints, XR_JOINTS } from '../src/ik/fingers.js';

const joints = (pose, mirror = false) => Object.fromEntries(XR_JOINTS.map(n => {
  const m = pose.jointTransforms[n].offsetMatrix;
  return [n, [mirror ? -m[12] : m[12], m[13], m[14]]];
}));
const curls = r => Object.fromEntries(Object.entries(r.fingers).map(([k, v]) => [k.toLowerCase(), v.curl]));

test('IWER built-in poses read plausibly (relaxed < point index, pinch thumb+index)', () => {
  const rel = curls(fingerStateFromJoints('left', joints(relaxedHandPose)));
  const pt = curls(fingerStateFromJoints('left', joints(pointHandPose)));
  const pi = curls(fingerStateFromJoints('left', joints(pinchHandPose)));
  for (const f of ['index', 'middle', 'ring', 'little']) assert.ok(rel[f] < 0.6, `relaxed ${f} ${rel[f]}`);
  assert.ok(pt.index < 0.3 && pt.middle > 0.6 && pt.ring > 0.6, `point ${JSON.stringify(pt)}`);
  assert.ok(pi.index > rel.index, `pinch index ${pi.index} vs relaxed ${rel.index}`);
});

test('generated open / fist / hook poses reproduce their curls (left and mirrored right)', () => {
  for (const [name, want] of Object.entries(HAND_POSE_CURLS)) {
    const pose = curledHandPose(relaxedHandPose, want);
    for (const [side, mirror] of [['left', false], ['right', true]]) {
      const got = curls(fingerStateFromJoints(side, joints(pose, mirror)));
      for (const f of ['index', 'middle', 'ring', 'little']) assert.ok(Math.abs(got[f] - want[f] * (f === 'little' ? 1.04 : f === 'index' ? 0.98 : 1)) < 0.08, `${name} ${side} ${f}: ${got[f]} vs ${want[f]}`);
      assert.ok(Math.abs(got.thumb - want.thumb) < 0.15, `${name} ${side} thumb: ${got.thumb} vs ${want.thumb}`);
    }
  }
});

test('bone lengths are preserved by the generated poses', () => {
  const pose = curledHandPose(relaxedHandPose, HAND_POSE_CURLS.fist);
  const a = joints(relaxedHandPose), b = joints(pose);
  const d = (p, q) => Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
  for (const f of ['index', 'middle', 'ring', 'pinky']) {
    const ch = ['phalanx-proximal', 'phalanx-intermediate', 'phalanx-distal', 'tip'].map(s => `${f}-finger-${s}`);
    for (let i = 1; i < ch.length; i++) assert.ok(Math.abs(d(a[ch[i]], a[ch[i - 1]]) - d(b[ch[i]], b[ch[i - 1]])) < 1e-6);
  }
});
