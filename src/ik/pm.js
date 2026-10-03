// SPDX-License-Identifier: GPL-3.0-or-later
// Pooled vector/quaternion math for the per-frame IK hot path (same conventions and semantics as
// vendor/cc/animation/qmath.js + src/ik/qx.js: vectors [x,y,z], quaternions [x,y,z,w], Hamilton product).
//
// Every function that returns a vector/quaternion returns an array taken from a module-level pool instead of a
// new one. The pool is rewound by beginFrame() at the start of every solve, so a returned array is valid until the
// next beginFrame(): anything that must survive a frame (filter state, last tracked pose, output) is copied into
// arrays owned by the caller (set3 / set4). The pools grow on demand (the first frames), then a solve allocates
// nothing. Not re-entrant: one solve at a time (JS is single-threaded; nested solvers would share the pool).
const V = [], Q = [];
let iv = 0, iq = 0;
export const poolStats = { vecs: 0, quats: 0, peakVecs: 0, peakQuats: 0 };

/** Rewind the pools (start of a solve). */
export function beginFrame() {
  if (iv > poolStats.peakVecs) poolStats.peakVecs = iv;
  if (iq > poolStats.peakQuats) poolStats.peakQuats = iq;
  iv = 0; iq = 0;
}
export const poolUsage = () => ({ vecs: iv, quats: iq, capacityVecs: V.length, capacityQuats: Q.length });

export function v3(x, y, z) {
  let a = V[iv];
  if (!a) { a = V[iv] = [0, 0, 0]; poolStats.vecs = V.length; }
  iv++;
  a[0] = x; a[1] = y; a[2] = z;
  return a;
}
export function q4(x, y, z, w) {
  let a = Q[iq];
  if (!a) { a = Q[iq] = [0, 0, 0, 1]; poolStats.quats = Q.length; }
  iq++;
  a[0] = x; a[1] = y; a[2] = z; a[3] = w;
  return a;
}

/** Copy into a caller-owned array (persistent state / output). Returns dst. */
export const set3 = (dst, s) => { dst[0] = s[0]; dst[1] = s[1]; dst[2] = s[2]; return dst; };
export const set4 = (dst, s) => { dst[0] = s[0]; dst[1] = s[1]; dst[2] = s[2]; dst[3] = s[3]; return dst; };

export const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
export const smoothstep = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
export const wrapAngle = a => { a = (a + Math.PI) % (2 * Math.PI); if (a < 0) a += 2 * Math.PI; return a - Math.PI; };
export const lp = (dt, tau) => (tau > 0 ? 1 - Math.exp(-Math.max(0, dt) / tau) : 1);
export const finite3 = v => !!v && Number.isFinite(v[0]) && Number.isFinite(v[1]) && Number.isFinite(v[2]);
export const finite4 = q => finite3(q) && Number.isFinite(q[3]);

// ---- vectors ----
export const vAdd = (a, b) => v3(a[0] + b[0], a[1] + b[1], a[2] + b[2]);
export const vSub = (a, b) => v3(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
export const vScale = (a, s) => v3(a[0] * s, a[1] * s, a[2] * s);
/** a + b * k */
export const vMad = (a, b, k) => v3(a[0] + b[0] * k, a[1] + b[1] * k, a[2] + b[2] * k);
export const vDot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const vCross = (a, b) => v3(a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]);
export const vLen = a => Math.sqrt(a[0] * a[0] + a[1] * a[1] + a[2] * a[2]);
export const vDist = (a, b) => Math.sqrt((a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2);
export function vNorm(a) { const l = vLen(a); return l > 1e-12 ? v3(a[0] / l, a[1] / l, a[2] / l) : v3(0, 0, 0); }
export const vLerp = (a, b, t) => v3(a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t);
/** Component of v orthogonal to unit n. */
export function vReject(v, n) { const d = vDot(v, n); return v3(v[0] - n[0] * d, v[1] - n[1] * d, v[2] - n[2] * d); }
export const vCopy = a => v3(a[0], a[1], a[2]);

// ---- quaternions ----
export const qId = () => q4(0, 0, 0, 1);
export const qConj = a => q4(-a[0], -a[1], -a[2], a[3]);
export const qDot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];
export function qNormalize(a) {
  const l = Math.sqrt(a[0] * a[0] + a[1] * a[1] + a[2] * a[2] + a[3] * a[3]);
  return l > 1e-12 ? q4(a[0] / l, a[1] / l, a[2] / l, a[3] / l) : q4(0, 0, 0, 1);
}
export function qMul(a, b) {
  const ax = a[0], ay = a[1], az = a[2], aw = a[3], bx = b[0], by = b[1], bz = b[2], bw = b[3];
  return q4(aw * bx + ax * bw + ay * bz - az * by, aw * by - ax * bz + ay * bw + az * bx,
    aw * bz + ax * by - ay * bx + az * bw, aw * bw - ax * bx - ay * by - az * bz);
}
export function qRotate(q, v) {
  const x = q[0], y = q[1], z = q[2], w = q[3];
  const cx = y * v[2] - z * v[1], cy = z * v[0] - x * v[2], cz = x * v[1] - y * v[0];
  const c2x = y * cz - z * cy, c2y = z * cx - x * cz, c2z = x * cy - y * cx;
  return v3(v[0] + 2 * (w * cx + c2x), v[1] + 2 * (w * cy + c2y), v[2] + 2 * (w * cz + c2z));
}
/** Rotate by the inverse of unit q. */
export function qRotateInv(q, v) {
  const x = -q[0], y = -q[1], z = -q[2], w = q[3];
  const cx = y * v[2] - z * v[1], cy = z * v[0] - x * v[2], cz = x * v[1] - y * v[0];
  const c2x = y * cz - z * cy, c2y = z * cx - x * cz, c2z = x * cy - y * cx;
  return v3(v[0] + 2 * (w * cx + c2x), v[1] + 2 * (w * cy + c2y), v[2] + 2 * (w * cz + c2z));
}
export function qAxisAngle(axis, rad) {
  const l = vLen(axis);
  if (!(l > 1e-12)) return q4(0, 0, 0, Math.cos(rad / 2));     // vendor: zero axis -> [0,0,0,cos]
  const s = Math.sin(rad / 2) / l;
  return q4(axis[0] * s, axis[1] * s, axis[2] * s, Math.cos(rad / 2));
}
export const rx = a => q4(Math.sin(a / 2), 0, 0, Math.cos(a / 2));
export const ry = a => q4(0, Math.sin(a / 2), 0, Math.cos(a / 2));
export const rz = a => q4(0, 0, Math.sin(a / 2), Math.cos(a / 2));
/** Minimal-arc rotation u -> v (vendor qFromTo semantics). */
export function qFromTo(u, v) {
  const a = vNorm(u), b = vNorm(v), d = vDot(a, b);
  if (d < -0.999999) {
    const p = Math.abs(a[0]) < 0.9 ? v3(1, 0, 0) : v3(0, 1, 0);
    return qAxisAngle(vCross(a, p), Math.PI);
  }
  const c = vCross(a, b);
  return qNormalize(q4(c[0], c[1], c[2], 1 + d));
}
/** Shortest-path slerp (vendor semantics). */
export function qSlerp(a, b, t) {
  let d = qDot(a, b), s0 = 1;
  if (d < 0) { d = -d; s0 = -1; }
  if (d > 0.9995) {
    return qNormalize(q4(a[0] + (s0 * b[0] - a[0]) * t, a[1] + (s0 * b[1] - a[1]) * t, a[2] + (s0 * b[2] - a[2]) * t, a[3] + (s0 * b[3] - a[3]) * t));
  }
  const th = Math.acos(d), s = Math.sin(th), wa = Math.sin((1 - t) * th) / s, wb = s0 * Math.sin(t * th) / s;
  return q4(a[0] * wa + b[0] * wb, a[1] * wa + b[1] * wb, a[2] * wa + b[2] * wb, a[3] * wa + b[3] * wb);
}
export const qMirrorX = q => q4(q[0], -q[1], -q[2], q[3]);
/** Angle (rad, 0..pi) of a unit quaternion. */
export const qAngleOf = q => 2 * Math.acos(clamp(Math.abs(q[3]), 0, 1));

export function qFromColumns(X, Y, Z) {
  const m00 = X[0], m10 = X[1], m20 = X[2], m01 = Y[0], m11 = Y[1], m21 = Y[2], m02 = Z[0], m12 = Z[1], m22 = Z[2];
  const tr = m00 + m11 + m22;
  let x, y, z, w;
  if (tr > 0) { const s = 0.5 / Math.sqrt(tr + 1); x = (m21 - m12) * s; y = (m02 - m20) * s; z = (m10 - m01) * s; w = 0.25 / s; }
  else if (m00 > m11 && m00 > m22) { const s = 2 * Math.sqrt(1 + m00 - m11 - m22); x = 0.25 * s; y = (m01 + m10) / s; z = (m02 + m20) / s; w = (m21 - m12) / s; }
  else if (m11 > m22) { const s = 2 * Math.sqrt(1 + m11 - m00 - m22); x = (m01 + m10) / s; y = 0.25 * s; z = (m12 + m21) / s; w = (m02 - m20) / s; }
  else { const s = 2 * Math.sqrt(1 + m22 - m00 - m11); x = (m02 + m20) / s; y = (m12 + m21) / s; z = 0.25 * s; w = (m10 - m01) / s; }
  return qNormalize(q4(x, y, z, w));
}
/** Quaternion whose +Z = z and +Y = y (made orthogonal to z); degenerate inputs fall back (qx.qFrameZY). */
export function qFrameZY(z, y) {
  const Z = vNorm(z);
  if (vLen(Z) < 0.5) return q4(0, 0, 0, 1);
  let Y = vReject(y, Z);
  if (vLen(Y) < 1e-6) Y = vReject(Math.abs(Z[1]) < 0.9 ? v3(0, 1, 0) : v3(1, 0, 0), Z);
  Y = vNorm(Y);
  return qFromColumns(vCross(Y, Z), Y, Z);
}
export const qAlignFrames = (a0, b0, a1, b1) => qMul(qFrameZY(a1, b1), qConj(qFrameZY(a0, b0)));
/** Twist angle (rad, -pi..pi) of unit q about unit axis a. */
export function twistAngle(q, a) {
  const d = q[0] * a[0] + q[1] * a[1] + q[2] * a[2];
  return wrapAngle(2 * Math.atan2(d, q[3]));
}
export const yawOf = v => Math.atan2(v[0], v[2]);
/** q with w >= 0 (same rotation). */
export const qPos = q => (q[3] < 0 ? q4(-q[0], -q[1], -q[2], -q[3]) : q);
