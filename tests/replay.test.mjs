// Regression over a recorded fixture (tests/fixtures/replay_walk.json, recorded from IWER-emulated Quest 3
// controllers by `node tools/emulate_shots.mjs --fixtures`). Emulated input only - not real headset data.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { sampleFixture } from '../src/replay.js';
import { createVRIK } from '../src/ik/vrik.js';
import { RIG, HEADS, worldJoints, allFinite, dist } from './helpers.mjs';

const FX = JSON.parse(readFileSync(new URL('./fixtures/replay_walk.json', import.meta.url), 'utf8'));
// The fixture was recorded at a 1.60 m eye height with a height-calibrated avatar; the node rig is the
// unscaled neutral body. Scale the tracking about the floor origin to the rig's eye height (what the in-app
// calibration achieves by morph/scale), otherwise the legs simply cannot reach the floor.
const rigEye = RIG.H.head[1] + RIG.eyeOffset[1];
const k = rigEye / 1.6;
const scalePose = p => p && p.pos ? { ...p, pos: p.pos.map(v => v * k) } : p;
const FXS = { ...FX, frames: FX.frames.map(fr => ({ ...fr, head: scalePose(fr.head), hands: { left: scalePose(fr.hands.left), right: scalePose(fr.hands.right) } })) };

test('sampleFixture: interpolates between frames, clamps and loops', () => {
  const F = FX.frames, T = F.at(-1).t;
  const a = sampleFixture(FX, F[10].t, false);
  assert.ok(dist(a.head.pos, F[10].head.pos) < 1e-9);
  const mid = sampleFixture(FX, (F[10].t + F[11].t) / 2, false);
  const m = F[10].head.pos.map((v, i) => (v + F[11].head.pos[i]) / 2);
  assert.ok(dist(mid.head.pos, m) < 1e-6);
  assert.ok(Math.abs(Math.hypot(...mid.head.quat) - 1) < 1e-6, 'slerped quaternion stays unit');
  const looped = sampleFixture(FX, T + F[10].t, true);
  assert.ok(dist(looped.head.pos, F[10].head.pos) < 1e-6);
  for (const s of ['left', 'right']) assert.equal(mid.hands[s].valid, true);
});

test('VRIK over the recorded walk: finite pose, planted toes on the floor, steps taken, head tracked', () => {
  const ik = createVRIK(RIG);
  const dt = 1 / 72, T = FX.frames.at(-1).t;
  let r, maxHeadErr = 0, minFoot = 9, maxPlanted = 0;
  for (let t = 0; t <= T; t += dt) {
    const rec = sampleFixture(FXS, t, false);
    r = ik.solve({ head: rec.head, hands: rec.hands }, dt);
    assert.ok(allFinite(r.pose), `non-finite pose at t=${t.toFixed(3)}`);
    const J = worldJoints(r);
    for (const s of ['left', 'right']) {
      // a planted foot keeps the ball of the foot (toes joint) on the floor; the heel may rise (toe-off)
      const toeY = J[`${s}Toes`][1];
      minFoot = Math.min(minFoot, toeY);
      const f = r.debug.feet[s === 'left' ? 0 : 1];
      if (!f.stepping) maxPlanted = Math.max(maxPlanted, Math.abs(toeY - HEADS[`${s}Toes`][1]));
    }
    if (t > 0.5) {
      // head joint is the eye minus the rotated eye offset; the neck chain may lag slightly while walking
      const eyeToHead = dist(J.head, rec.head.pos);
      maxHeadErr = Math.max(maxHeadErr, Math.abs(eyeToHead - Math.hypot(...RIG.eyeOffset)));
    }
  }
  assert.ok(r.debug.steps > 0, `steps ${r.debug.steps}`);
  assert.ok(minFoot > HEADS.leftToes[1] - 0.01, `foot below the floor: ${minFoot}`);
  assert.ok(maxPlanted < 0.01, `planted foot off the floor by ${maxPlanted}`);
  assert.ok(maxHeadErr < 0.01, `head error ${maxHeadErr}`);
});
