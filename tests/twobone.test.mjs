import test from 'node:test';
import assert from 'node:assert/strict';
import { solveTwoBone, midAngle } from '../src/ik/twobone.js';
import { dist, DEG, rng } from './helpers.mjs';
const random = rng(7);

const A = [0.2, 1.3, 0];

test('reaches reachable targets exactly and keeps bone lengths', () => {
  let n = 0;
  for (let i = 0; i < 500; i++) {
    const r0 = 0.05 + random() * 0.48;
    const d = [random() - 0.5, random() - 0.5, random() - 0.5];
    const l = Math.hypot(...d);
    const T = [A[0] + d[0] / l * r0, A[1] + d[1] / l * r0, A[2] + d[2] / l * r0];
    const s = solveTwoBone(A, T, 0.28, 0.26, [random() - 0.5, -1, -0.3]);
    assert.ok(dist(s.end, T) < 1e-6, 'end at target');
    assert.ok(Math.abs(dist(A, s.mid) - 0.28) < 1e-9);
    assert.ok(Math.abs(dist(s.mid, s.end) - 0.26) < 1e-9);
    n++;
  }
  assert.equal(n, 500);
});

test('out of reach: straight towards the target, lengths kept', () => {
  const T = [A[0] + 2, A[1], A[2]];
  const s = solveTwoBone(A, T, 0.28, 0.26, [0, -1, 0]);
  assert.ok(s.clamped && !s.reached);
  assert.ok(Math.abs(dist(A, s.end) - 0.54 * 0.9999) < 1e-9);
  assert.ok(Math.abs(dist(A, s.mid) - 0.28) < 1e-9);
  assert.ok(midAngle(A, s.mid, s.end) > 178 * DEG);
});

test('mid joint lies on the pole side', () => {
  const T = [A[0] + 0.3, A[1] - 0.1, A[2] + 0.1];
  for (const pole of [[0, -1, 0], [0, 0, 1], [1, 0, -1]]) {
    const s = solveTwoBone(A, T, 0.28, 0.26, pole);
    const off = [s.mid[0] - A[0], s.mid[1] - A[1], s.mid[2] - A[2]];
    assert.ok(off[0] * s.pole[0] + off[1] * s.pole[1] + off[2] * s.pole[2] > 0);
  }
});

test('degenerate inputs never give NaN', () => {
  const cases = [
    [A, A, [0, -1, 0]], [A, [A[0], A[1] - 0.3, A[2]], [0, -1, 0]], [A, [A[0], A[1] - 0.3, A[2]], [0, 0, 0]],
    [A, [NaN, 0, 0], [0, -1, 0]], [A, [A[0] + 1e-9, A[1], A[2]], [1, 0, 0]],
  ];
  for (const [a, t, p] of cases) {
    const s = solveTwoBone(a, t, 0.28, 0.26, p);
    for (const v of [s.mid, s.end, s.dir, s.bendNormal]) assert.ok(v.every(Number.isFinite), JSON.stringify(s));
  }
});

test('minD limits the fold (interior angle)', () => {
  const a = 0.28, b = 0.26, minInt = 30 * DEG;
  const minD = Math.sqrt(a * a + b * b - 2 * a * b * Math.cos(minInt));
  const s = solveTwoBone(A, [A[0] + 0.001, A[1] - 0.01, A[2]], a, b, [0, -1, 0], [0, 0, 1], { minD });
  assert.ok(midAngle(A, s.mid, s.end) >= minInt - 1e-6);
});

test('pole stability: a small target move gives a small elbow move', () => {
  let prev = null, worst = 0;
  for (let i = 0; i <= 200; i++) {
    const t = i / 200, T = [A[0] + 0.1 + 0.3 * t, A[1] - 0.3 + 0.5 * t, A[2] + 0.35 - 0.2 * t];
    const s = solveTwoBone(A, T, 0.28, 0.26, [0.5, -1, -0.3]);
    if (prev) worst = Math.max(worst, dist(prev, s.mid));
    prev = s.mid;
  }
  assert.ok(worst < 0.02, `max elbow jump ${worst}`);
});
