// Shared helpers for the node tests: the neutral rig and synthetic tracking input.
import { readFileSync } from 'node:fs';
import { prepareRig } from '../src/ik/rigdata.js';
import { qAxisAngle, qMul, qNormalize, qRotate, qFrameZY } from '../src/ik/qx.js';
import { fkPositions } from '../vendor/cc/animation/canonical.js';

export const HEADS = JSON.parse(readFileSync(new URL('./fixtures/rest_heads.json', import.meta.url), 'utf8')).heads;
export const RIG = prepareRig(HEADS);
export const DEG = Math.PI / 180;
export const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

/** Viewer pose for a person facing yaw (rad, 0 = +Z... the camera looks along -Z, so yaw 0 faces -Z world). */
export function viewer(pos, { yaw = 0, pitch = 0, roll = 0 } = {}) {
  const q = qMul(qAxisAngle([0, 1, 0], yaw), qMul(qAxisAngle([1, 0, 0], -pitch), qAxisAngle([0, 0, 1], roll)));
  return { pos, quat: qNormalize(q) };
}

/** Hand frame quaternion (+Z fingers, +Y back of the hand). */
export const handQ = (fingers, dorsal) => qFrameZY(fingers, dorsal);

/** Posed joint positions in WORLD from a solve result (FK of the pose on the rest heads + the root placement). */
export function worldJoints(res) {
  const P = fkPositions(HEADS, res.pose);
  const { position, yaw, scale } = res.rig;
  const q = qAxisAngle([0, 1, 0], yaw);
  const out = {};
  for (const [k, v] of Object.entries(P)) { const r = qRotate(q, v); out[k] = [position[0] + r[0] * scale, position[1] + r[1] * scale, position[2] + r[2] * scale]; }
  return out;
}

export function allFinite(obj) {
  if (typeof obj === 'number') return Number.isFinite(obj);
  if (Array.isArray(obj)) return obj.every(allFinite);
  if (obj && typeof obj === 'object') return Object.values(obj).every(allFinite);
  return true;
}

/** Deterministic PRNG (mulberry32) so randomised tests are reproducible. */
export function rng(seed = 1) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
