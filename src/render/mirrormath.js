// SPDX-License-Identifier: GPL-3.0-or-later
// Pure mirror camera math (src/mirror.js uses it; tests/mirror.test.mjs checks it numerically per eye).
// Kooima "generalized perspective projection" from the eye reflected in the mirror plane, through the mirror
// rectangle seen from behind (left/right swapped), with the near plane ON the mirror plane.
// Vectors are plain [x, y, z] arrays (world metres).

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const scale = (a, k) => [a[0] * k, a[1] * k, a[2] * k];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = a => scale(a, 1 / (Math.hypot(a[0], a[1], a[2]) || 1));

/**
 * pa = bottom-left, pb = bottom-right, pc = top-left corner of the mirror as seen from the FRONT (world).
 * E = eye (world). Returns null when the eye is behind / on the mirror, else
 * { eye (reflected), vr, vu, vn (camera basis: right, up, back), near, far, l, r, b, t (frustum at near) }.
 */
export function mirrorFrustum(E, pa, pb, pc, { minNear = 0.01, far = 40, minDist = 0.01 } = {}) {
  const right = norm(sub(pb, pa)), up = norm(sub(pc, pa));
  const n = norm(cross(right, up));                       // mirror front normal
  const d = dot(sub(E, pa), n);
  if (d < minDist) return null;
  const ve = sub(E, scale(n, 2 * d));                     // reflected eye (behind the mirror)
  // the screen as seen from behind: corners swapped left/right
  const pav = pb, pbv = pa, pcv = add(pb, sub(pc, pa));
  const vr = norm(sub(pbv, pav)), vu = norm(sub(pcv, pav)), vn = norm(cross(vr, vu));
  const va = sub(pav, ve), vb = sub(pbv, ve), vc = sub(pcv, ve);
  const dist = -dot(va, vn);
  const near = Math.max(minNear, dist), k = near / dist;
  return { eye: ve, vr, vu, vn, near, far, l: dot(vr, va) * k, r: dot(vr, vb) * k, b: dot(vu, va) * k, t: dot(vu, vc) * k, normal: n };
}

/** Project world point X with a frustum from mirrorFrustum -> NDC [x, y, z] (z in -1..1 inside near..far). */
export function projectMirror(F, X) {
  const p = sub(X, F.eye);
  const xc = dot(p, F.vr), yc = dot(p, F.vu), zc = dot(p, F.vn);   // camera space (looks along -vn)
  const w = -zc;
  const { l, r, b, t, near: n, far: f } = F;
  const x = ((2 * n) / (r - l)) * xc + ((r + l) / (r - l)) * zc;
  const y = ((2 * n) / (t - b)) * yc + ((t + b) / (t - b)) * zc;
  const z = (-(f + n) / (f - n)) * zc + (-2 * f * n) / (f - n);
  return [x / w, y / w, z / w];
}

/** Where on the mirror (s, t in 0..1 from the bottom-left, front view) the eye E sees the image of X. */
export function mirrorImagePoint(E, X, pa, pb, pc) {
  const right = norm(sub(pb, pa)), up = norm(sub(pc, pa)), n = norm(cross(right, up));
  const dX = dot(sub(X, pa), n);
  const Xr = sub(X, scale(n, 2 * dX));                    // reflected point
  const dE = dot(sub(E, pa), n), dR = dot(sub(Xr, pa), n);
  const u = dE / (dE - dR);                               // E + u (Xr - E) lies on the plane
  const C = add(E, scale(sub(Xr, E), u));
  const w = Math.hypot(...sub(pb, pa)), h = Math.hypot(...sub(pc, pa));
  return [dot(sub(C, pa), right) / w, dot(sub(C, pa), up) / h];
}
