// SPDX-License-Identifier: GPL-3.0-or-later
import test from 'node:test';
import assert from 'node:assert/strict';
import { mirrorFrustum, projectMirror, mirrorImagePoint } from '../src/render/mirrormath.js';
import { neutralToneMap, linearToSRGB } from '../src/render/tonemap.js';

// the room's mirror: 1.5 x 2.0 m, bottom at 0.12 m, plane z = -1.58, facing +Z
const W = 1.5, H = 2.0, Z = -1.58, B = 0.12;
const pa = [-W / 2, B, Z], pb = [W / 2, B, Z], pc = [-W / 2, B + H, Z];

// per-eye: IPD 63 mm around a head at (0.2, 1.62, 0.1), turned 25 deg to the left (eye offsets rotate too)
const yaw = 25 * Math.PI / 180, ipd = 0.063;
const head = [0.2, 1.62, 0.1];
const eyes = {
  L: [head[0] - Math.cos(yaw) * ipd / 2, head[1], head[2] + Math.sin(yaw) * ipd / 2],
  R: [head[0] + Math.cos(yaw) * ipd / 2, head[1], head[2] - Math.sin(yaw) * ipd / 2],
};
const points = [[0, 1.0, 0.3], [0.25, 1.55, 0.05], [-0.4, 0.2, -0.5], [0.6, 1.9, 0.8], [-0.1, 0.05, -1.2]];

test('mirror: per-eye reflected frustum shows each point exactly where the reflection is seen', () => {
  for (const [k, E] of Object.entries(eyes)) {
    const F = mirrorFrustum(E, pa, pb, pc);
    assert.ok(F, k);
    // reflected eye: same x/y, mirrored z about the plane
    assert.ok(Math.abs(F.eye[2] - (2 * Z - E[2])) < 1e-12 && Math.abs(F.eye[0] - E[0]) < 1e-12 && Math.abs(F.eye[1] - E[1]) < 1e-12);
    // near plane on the mirror plane
    assert.ok(Math.abs(F.near - (E[2] - Z)) < 1e-12, `${k} near ${F.near}`);
    for (const X of points) {
      const ndc = projectMirror(F, X);
      // texture coordinate the point lands on, and the surface uv that shows it (the geometry flips u)
      const uTex = (ndc[0] + 1) / 2, vTex = (ndc[1] + 1) / 2;
      const [s, t] = mirrorImagePoint(E, X, pa, pb, pc);
      assert.ok(Math.abs((1 - s) - uTex) < 1e-9, `${k} ${X}: u ${uTex} vs ${1 - s}`);
      assert.ok(Math.abs(t - vTex) < 1e-9, `${k} ${X}: v ${vTex} vs ${t}`);
      assert.ok(ndc[2] > -1 && ndc[2] < 1, `${k} ${X} depth inside`);
    }
  }
});

test('mirror: the two eyes see a point at different mirror spots (stereo disparity) and nothing behind the mirror', () => {
  const X = [0, 1.2, 0.2];
  const sL = mirrorImagePoint(eyes.L, X, pa, pb, pc), sR = mirrorImagePoint(eyes.R, X, pa, pb, pc);
  assert.ok(Math.abs(sL[0] - sR[0]) > 0.005, 'disparity');
  const FL = mirrorFrustum(eyes.L, pa, pb, pc);
  // a point behind the mirror plane (inside the wall) is in front of the near plane -> clipped (z < -1)
  const behind = projectMirror(FL, [0, 1.2, Z - 0.3]);
  assert.ok(behind[2] < -1 || !Number.isFinite(behind[2]), `behind z ${behind[2]}`);
  // eye behind the mirror: no frustum
  assert.equal(mirrorFrustum([0, 1.6, Z - 0.5], pa, pb, pc), null);
  // the mirror corners land on the NDC corners (swapped left/right)
  const c = projectMirror(FL, pa);
  assert.ok(Math.abs(c[0] - 1) < 1e-9 && Math.abs(c[1] + 1) < 1e-9, `corner ${c}`);
});

test('read-back tone mapping matches three.js NeutralToneMapping + sRGB', () => {
  const c = neutralToneMap([0.5, 0.5, 0.5]);
  assert.ok(Math.abs(c[0] - 0.46) < 1e-12);
  const hi = neutralToneMap([4, 2, 1]);
  assert.ok(hi[0] <= 1 && hi[0] > hi[1] && hi[1] > hi[2]);
  assert.ok(Math.abs(linearToSRGB(0.5) - 0.7353569830524495) < 1e-12);
  assert.equal(linearToSRGB(0), 0);
  assert.ok(Math.abs(linearToSRGB(1) - 1) < 1e-12);
});
