// SPDX-License-Identifier: GPL-3.0-or-later
import test from 'node:test';
import assert from 'node:assert/strict';
import { pickPreset, createAutoScaler, LEVELS, levelOfPreset, PRESETS } from '../src/quality.js';

test('preset choice from UA / GPU string / benchmark', () => {
  assert.equal(pickPreset({ ua: 'Mozilla/5.0 (Windows NT 10.0) Chrome/130', gpu: 'ANGLE (NVIDIA GeForce RTX 3070)' }).name, 'high');
  assert.equal(pickPreset({ ua: 'Mozilla/5.0 (X11; Linux x86_64; Quest 3) OculusBrowser/35', gpu: 'Adreno (TM) 740' }).name, 'medium');
  assert.equal(pickPreset({ ua: 'Mozilla/5.0 (X11; Linux x86_64; Quest 2) OculusBrowser/35', gpu: 'Adreno (TM) 650' }).name, 'low');
  assert.equal(pickPreset({ ua: 'Chrome', gpu: 'Google SwiftShader' }).name, 'low');
  assert.equal(pickPreset({ ua: 'Chrome', gpu: 'Intel(R) UHD Graphics 620' }).name, 'medium');
  assert.equal(pickPreset({ ua: 'Chrome', gpu: 'NVIDIA', benchMs: 40 }).name, 'low');
  assert.equal(pickPreset({ ua: 'Chrome', gpu: 'NVIDIA', benchMs: 12 }).name, 'medium');
  assert.equal(pickPreset({ ua: 'Chrome', gpu: '', benchMs: 3 }).name, 'high');
  assert.match(pickPreset({ ua: 'x', gpu: 'Adreno (TM) 740', benchMs: 5 }).reason, /Adreno 740.*benchmark 5\.0 ms/);
  for (const n of Object.keys(PRESETS)) assert.ok(levelOfPreset(n) >= 0 && levelOfPreset(n) < LEVELS.length);
  assert.equal(pickPreset({ ua: 'Mozilla/5.0 (X11; Linux aarch64)', gpu: 'ANGLE (Mesa, FD750, OpenGL ES 3.2)' }).name, 'medium');
});

const run = (as, dt, sec, hz = 72) => { const ev = []; for (let t = 0; t < sec; t += dt) { const e = as.update(dt, hz); if (e) ev.push(e); } return ev; };

test('auto-scaler: steps down when frames are missed, back up after a stable period, with hysteresis', () => {
  const as = createAutoScaler({ level: 0 });
  assert.deepEqual(run(as, 1 / 72, 5), [], 'at target: nothing');
  // every other frame missed at 72 Hz -> average 1.5 x the period
  const down = []; for (let i = 0; i < 72 * 3; i++) { const e = as.update(i % 2 ? 2 / 72 : 1 / 72, 72); if (e) down.push(e); }
  assert.ok(down.length >= 1 && down[0].dir === -1, JSON.stringify(down));
  const lvl = as.level;
  // slightly slow (5 % over): no change in either direction (hysteresis band)
  assert.deepEqual(run(as, 1.05 / 72, 20), []);
  assert.equal(as.level, lvl);
  // at target for a long time: steps back up, one level per >= upWindow
  const up = run(as, 1 / 72, 12);
  assert.equal(up.length, 1); assert.equal(up[0].dir, 1);
  assert.equal(as.level, lvl - 1);
  // spikes (loading, system menu) are ignored
  assert.equal(as.update(0.5, 72), null);
  // bounds
  const b = createAutoScaler({ level: LEVELS.length - 1 });
  for (let i = 0; i < 72 * 10; i++) b.update(3 / 72, 72);
  assert.equal(b.level, LEVELS.length - 1);
  // disabled
  const d = createAutoScaler({ enabled: false });
  assert.deepEqual(run(d, 3 / 72, 5), []);
});

test('auto-scaler respects the session frame rate (90 Hz target)', () => {
  const as = createAutoScaler({ level: 0 });
  // 72 Hz frames are fine for a 72 Hz target but missed frames for a 90 Hz target
  assert.deepEqual(run(as, 1 / 72, 3, 72), []);
  assert.ok(run(as, 1 / 72, 3, 90).length >= 1);
});
