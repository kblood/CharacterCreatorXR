#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
// IK micro-benchmark: time per solve and bytes allocated per solve for a fixed, deterministic motion
// (walk in a circle, wave both arms, crouch, turn). Node on a desktop CPU: NOT representative of a headset browser,
// only useful for before/after comparisons on the same machine.
//
//   node --expose-gc --min-semi-space-size=256 --max-semi-space-size=256 tools/bench_ik.mjs [--src <dir>] [--frames 3000] [--json]
//   (npm run bench)
//
// Allocation, two measurements on the warmed solver:
//   heapDelta  = heapUsed growth over 400 solves with a big young generation; runs during which a GC happened
//                (PerformanceObserver 'gc') are discarded (includes some harness/JIT noise);
//   sampled    = V8 sampling heap profiler (64 B interval) over 3 x frames solves, bytes per solve whose
//                allocation stack contains the solver (closest to what the solver itself allocates).
import { readFileSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { PerformanceObserver } from 'node:perf_hooks';
import { Session } from 'node:inspector/promises';

const here = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const base = resolve(arg('--src', join(here, '..')));
const frames = Number(arg('--frames', 3000));
const imp = p => import(pathToFileURL(join(base, p)).href);

const { createVRIK } = await imp('src/ik/vrik.js');
const { prepareRig } = await imp('src/ik/rigdata.js');
const { fingerStateFromCurls } = await imp('src/ik/fingers.js');
const heads = JSON.parse(readFileSync(join(here, '..', 'tests', 'fixtures', 'rest_heads.json'), 'utf8')).heads;
const rig = prepareRig(heads);

function qYaw(a) { return [0, Math.sin(a / 2), 0, Math.cos(a / 2)]; }
function qFrame(F, D) {             // +Z = F, +Y = D (orthonormalised), columns -> quaternion
  const n = v => { const l = Math.hypot(...v); return v.map(x => x / l); };
  const z = n(F); let y = [D[0] - z[0] * (D[0] * z[0] + D[1] * z[1] + D[2] * z[2]), D[1] - z[1] * (D[0] * z[0] + D[1] * z[1] + D[2] * z[2]), D[2] - z[2] * (D[0] * z[0] + D[1] * z[1] + D[2] * z[2])];
  y = n(y); const x = [y[1] * z[2] - y[2] * z[1], y[2] * z[0] - y[0] * z[2], y[0] * z[1] - y[1] * z[0]];
  const m00 = x[0], m11 = y[1], m22 = z[2], tr = m00 + m11 + m22;
  let q;
  if (tr > 0) { const s = Math.sqrt(tr + 1) * 2; q = [(y[2] - z[1]) / s, (z[0] - x[2]) / s, (x[1] - y[0]) / s, 0.25 * s]; }
  else if (m00 > m11 && m00 > m22) { const s = Math.sqrt(1 + m00 - m11 - m22) * 2; q = [0.25 * s, (y[0] + x[1]) / s, (z[0] + x[2]) / s, (y[2] - z[1]) / s]; }
  else if (m11 > m22) { const s = Math.sqrt(1 + m11 - m00 - m22) * 2; q = [(y[0] + x[1]) / s, 0.25 * s, (z[1] + y[2]) / s, (z[0] - x[2]) / s]; }
  else { const s = Math.sqrt(1 + m22 - m00 - m11) * 2; q = [(z[0] + x[2]) / s, (z[1] + y[2]) / s, 0.25 * s, (x[1] - y[0]) / s]; }
  return q;
}

/** Deterministic input for frame i (72 Hz). Inputs are prebuilt so the measurement only sees the solver. */
function input(i) {
  const t = i / 72, R = 0.8, w = 0.35;
  const cx = R * Math.sin(w * t), cz = -R * Math.cos(w * t) + R, yaw = -w * t + 0.3 * Math.sin(t);
  const crouch = Math.max(0, Math.sin(t * 0.5)) ** 4 * 0.5;
  const hy = 1.62 - crouch;
  const fwd = [-Math.sin(yaw), 0, -Math.cos(yaw)], left = [-Math.cos(yaw), 0, Math.sin(yaw)];
  const hand = (sgn, ph) => {
    const a = Math.sin(t * 2.1 + ph);
    const p = [cx + left[0] * sgn * (0.25 + 0.15 * a) + fwd[0] * (0.25 + 0.2 * Math.cos(t * 1.7 + ph)), hy - 0.45 + 0.5 * Math.sin(t * 1.3 + ph),
      cz + left[2] * sgn * (0.25 + 0.15 * a) + fwd[2] * (0.25 + 0.2 * Math.cos(t * 1.7 + ph))];
    return { pos: p, quat: qFrame(fwd, [0, 1, 0]), valid: true, fingers: null };
  };
  const curls = { thumb: 0.5 + 0.5 * Math.sin(t), index: 0.5 + 0.5 * Math.sin(t * 1.3), middle: 0.5, ring: 0.6, little: 0.7 };
  return {
    head: { pos: [cx, hy, cz], quat: qYaw(yaw) },
    hands: { left: hand(1, 0), right: hand(-1, 1.3) },
    fingers: { left: fingerStateFromCurls(curls), right: fingerStateFromCurls(curls) },
  };
}

const inputs = Array.from({ length: frames }, (_, i) => input(i));
function run(ik) { let r; for (let i = 0; i < frames; i++) r = ik.solve(inputs[i], 1 / 72); return r; }

// warm up (JIT); the allocation is measured on this warmed instance (a fresh instance re-tiers the JIT)
const warm = createVRIK(rig);
for (let k = 0; k < 3; k++) run(warm);

let gcs = 0;
const obs = new PerformanceObserver(list => { gcs += list.getEntries().length; });
obs.observe({ entryTypes: ['gc'] });
const tick = () => new Promise(r => setImmediate(r));       // let the observer deliver

let best = Infinity, alloc = Infinity;
for (let rep = 0; rep < 5; rep++) {
  const ik = createVRIK(rig);
  const t0 = process.hrtime.bigint();
  run(ik);
  best = Math.min(best, Number(process.hrtime.bigint() - t0) / 1e6 / frames);
}
const N = Math.min(400, frames);
for (let rep = 0; rep < 8; rep++) {
  const ik = warm;
  for (let i = 0; i < 20; i++) ik.solve(inputs[i], 1 / 72);
  globalThis.gc?.(); await tick(); await tick(); await new Promise(r => setTimeout(r, 5)); gcs = 0;
  const h0 = process.memoryUsage().heapUsed;
  for (let i = 20; i < 20 + N; i++) ik.solve(inputs[i % frames], 1 / 72);
  const h1 = process.memoryUsage().heapUsed;
  await new Promise(r => setTimeout(r, 5));
  if (gcs === 0) alloc = Math.min(alloc, Math.max(0, h1 - h0) / N);
}
obs.disconnect();
// sampling heap profiler: bytes whose stack contains a solve() frame of the solver under test
let sampled = null;
try {
  const ses = new Session(); ses.connect();
  await ses.post('HeapProfiler.startSampling', { samplingInterval: 64, includeObjectsCollectedByMajorGC: true, includeObjectsCollectedByMinorGC: true });
  for (let k = 0; k < 3; k++) run(warm);
  const { profile } = await ses.post('HeapProfiler.stopSampling');
  ses.disconnect();
  let bytes = 0;
  const srcUrl = pathToFileURL(join(base, 'src', 'ik')).href;
  (function walk(n, inSolver) {
    const here = inSolver || (n.callFrame.url.startsWith(srcUrl) && n.callFrame.functionName === 'solve');
    if (here) bytes += n.selfSize;
    for (const c of n.children) walk(c, here);
  })(profile.head, false);
  sampled = Math.round(bytes / (3 * frames));
} catch { /* inspector not available */ }
const out = { src: base.replace(/\\/g, '/').split('/').slice(-2).join('/'), frames, msPerSolve: +best.toFixed(4), bytesPerSolve: Number.isFinite(alloc) ? Math.round(alloc) : null, sampledBytesPerSolve: sampled, gcExposed: !!globalThis.gc };
console.log(argv.includes('--json') ? JSON.stringify(out) : `IK bench (node, not representative of a headset): ${out.msPerSolve} ms/solve, heap delta ~${out.bytesPerSolve} B/solve, sampled ~${out.sampledBytesPerSolve} B/solve in the solver (${frames} frames)`);
