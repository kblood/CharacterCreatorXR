// SPDX-License-Identifier: GPL-3.0-or-later
// Extra pure math for the IK (arrays: vectors [x,y,z], quaternions [x,y,z,w], like vendor qmath.js).
// No three.js, runs in node. Builds on the synced CharacterCreator qmath.js (never edited here).
import { qMul, qConj, qNormalize, qRotate, qAxisAngle, vDot, vCross, vNorm, vLen, vSub, vScale, vAdd } from '../../vendor/cc/animation/qmath.js';

export const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
export const smoothstep = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
export const wrapAngle = a => { a = (a + Math.PI) % (2 * Math.PI); if (a < 0) a += 2 * Math.PI; return a - Math.PI; };
export const finite3 = v => Number.isFinite(v[0]) && Number.isFinite(v[1]) && Number.isFinite(v[2]);
export const finite4 = q => finite3(q) && Number.isFinite(q[3]);
export const ry = a => qAxisAngle([0, 1, 0], a);
export const rx = a => qAxisAngle([1, 0, 0], a);
export const rz = a => qAxisAngle([0, 0, 1], a);

/** Component of v orthogonal to unit n. */
export const vReject = (v, n) => vSub(v, vScale(n, vDot(v, n)));

/** Quaternion of a rotation matrix given by its columns (orthonormal, right-handed). */
export function qFromColumns(X, Y, Z) {
  const m00 = X[0], m10 = X[1], m20 = X[2], m01 = Y[0], m11 = Y[1], m21 = Y[2], m02 = Z[0], m12 = Z[1], m22 = Z[2];
  const tr = m00 + m11 + m22;
  let q;
  if (tr > 0) { const s = 0.5 / Math.sqrt(tr + 1); q = [(m21 - m12) * s, (m02 - m20) * s, (m10 - m01) * s, 0.25 / s]; }
  else if (m00 > m11 && m00 > m22) { const s = 2 * Math.sqrt(1 + m00 - m11 - m22); q = [0.25 * s, (m01 + m10) / s, (m02 + m20) / s, (m21 - m12) / s]; }
  else if (m11 > m22) { const s = 2 * Math.sqrt(1 + m11 - m00 - m22); q = [(m01 + m10) / s, 0.25 * s, (m12 + m21) / s, (m02 - m20) / s]; }
  else { const s = 2 * Math.sqrt(1 + m22 - m00 - m11); q = [(m02 + m20) / s, (m12 + m21) / s, 0.25 * s, (m10 - m01) / s]; }
  return qNormalize(q);
}

/**
 * Orthonormal frame from a primary direction `z` and a secondary direction `y` (made orthogonal to z):
 * returns the quaternion whose +Z = z and +Y = y (X = Y x Z). Degenerate inputs fall back to any perpendicular.
 */
export function qFrameZY(z, y) {
  const Z = vNorm(z);
  if (vLen(Z) < 0.5) return [0, 0, 0, 1];
  let Y = vReject(y, Z);
  if (vLen(Y) < 1e-6) Y = vReject(Math.abs(Z[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0], Z);
  Y = vNorm(Y);
  const X = vCross(Y, Z);
  return qFromColumns(X, Y, Z);
}

/** Rotation that maps the frame (a0 primary, b0 secondary) onto (a1, b1): a0 -> a1 exactly, b0 -> b1 as close as possible. */
export const qAlignFrames = (a0, b0, a1, b1) => qMul(qFrameZY(a1, b1), qConj(qFrameZY(a0, b0)));

/** Twist angle (rad, -pi..pi) of unit quaternion q about unit axis a (swing-twist decomposition). */
export function twistAngle(q, a) {
  const d = q[0] * a[0] + q[1] * a[1] + q[2] * a[2];
  return wrapAngle(2 * Math.atan2(d, q[3]));
}

/** Yaw (rad) of a horizontal heading vector about +Y, measured from +Z toward +X. */
export const yawOf = v => Math.atan2(v[0], v[2]);

/** Signed angle (rad) from u to v about axis n (u, v projected onto the plane of n). */
export function signedAngle(u, v, n) {
  const a = vReject(u, n), b = vReject(v, n);
  return Math.atan2(vDot(vCross(a, b), n), vDot(a, b));
}

/** Low-pass factor for time constant tau (s) over dt (s). */
export const lp = (dt, tau) => (tau > 0 ? 1 - Math.exp(-Math.max(0, dt) / tau) : 1);

export { qMul, qConj, qNormalize, qRotate, qAxisAngle, vDot, vCross, vNorm, vLen, vSub, vScale, vAdd };
export { qFromTo, qSlerp, qAngle, qAlign, qMirrorX, vLerp, DEG } from '../../vendor/cc/animation/qmath.js';
