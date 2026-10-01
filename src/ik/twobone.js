// Analytic two-bone IK (law of cosines) with a pole direction. Pure, engine-agnostic (arrays).
// Used for arms (shoulder -> elbow -> wrist) and legs (hip -> knee -> ankle). docs/IK.md.
//   solveTwoBoneInto(out, ...)  hot path: writes into a caller-owned result object; its vectors come from the
//                               per-frame pool (src/ik/pm.js), valid until the next beginFrame()
//   solveTwoBone(...)           allocating wrapper (tests, tools): plain arrays, safe to keep
import * as M from './pm.js';

/** A result object to reuse with solveTwoBoneInto. */
export const twoBoneResult = () => ({ mid: null, end: null, dir: null, pole: null, bendNormal: null, reach: 0, reached: false, clamped: false });

/**
 * root A, target T, bone lengths a (A->mid), b (mid->end), pole = preferred direction of the middle joint
 * (need not be orthogonal/unit), fallbackPole used when pole is (nearly) parallel to A->T.
 * minD = minimum root->end distance (limits the fold of the middle joint), maxReach = fraction of a+b.
 * out: { mid, end, dir, pole, bendNormal, reach, reached, clamped }:
 *   mid  = elbow/knee position, end = where the chain really ends (== T when reachable),
 *   dir  = unit A->T, pole = unit pole projected onto the plane of dir, bendNormal = unit (pole x dir),
 *   reach = |T - A| / (a + b), reached = |end - T| < 1e-6.
 * Never produces NaN: degenerate inputs (T == A, zero lengths, pole parallel) use fallbacks.
 */
export function solveTwoBoneInto(out, A, T, a, b, pole, fallbackPole, minD = 0, maxReach = 0.9999) {
  const eps = 1e-6;
  a = Math.max(a, eps); b = Math.max(b, eps);
  let dist, dir;
  const dx = T[0] - A[0], dy = T[1] - A[1], dz = T[2] - A[2];
  dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
  if (!(dist > eps) || !Number.isFinite(dist)) {
    dir = M.vNorm(fallbackPole || M.v3(0, 0, 1));
    if (M.vLen(dir) < 0.5) dir = M.v3(0, -1, 0);
    dist = 0;
  } else dir = M.v3(dx / dist, dy / dist, dz / dist);
  const dMin = Math.max(Math.abs(a - b) + 1e-4, minD || 0), dMax = (a + b) * maxReach;
  const d = M.clamp(dist, dMin, dMax);
  let p = M.vReject(pole, dir);
  if (M.vLen(p) < 1e-3 * Math.max(1, M.vLen(pole)) && fallbackPole) p = M.vReject(fallbackPole, dir);
  if (M.vLen(p) < 1e-6) p = M.vReject(Math.abs(dir[1]) < 0.9 ? M.v3(0, 1, 0) : M.v3(1, 0, 0), dir);
  p = M.vNorm(p);
  const cosA = M.clamp((a * a + d * d - b * b) / (2 * a * d), -1, 1);
  const sinA = Math.sqrt(Math.max(0, 1 - cosA * cosA));
  out.mid = M.v3(A[0] + dir[0] * a * cosA + p[0] * a * sinA, A[1] + dir[1] * a * cosA + p[1] * a * sinA, A[2] + dir[2] * a * cosA + p[2] * a * sinA);
  out.end = M.vMad(A, dir, d);
  out.dir = dir; out.pole = p;
  out.bendNormal = M.vNorm(M.vCross(p, dir));
  out.reach = dist / (a + b);
  out.reached = Math.abs(dist - d) < 1e-6;
  out.clamped = dist !== d;
  return out;
}

/** Allocating wrapper with the original signature: opts { minD, maxReach }. Returned arrays are plain copies. */
export function solveTwoBone(A, T, a, b, pole, fallbackPole = [0, 0, 1], opts = {}) {
  M.beginFrame();
  const r = solveTwoBoneInto(twoBoneResult(), A, T, a, b, pole, fallbackPole, opts.minD || 0, opts.maxReach ?? 0.9999);
  return { mid: [...r.mid], end: [...r.end], dir: [...r.dir], pole: [...r.pole], bendNormal: [...r.bendNormal], reach: r.reach, reached: r.reached, clamped: r.clamped };
}

/** Interior angle at the middle joint (rad, pi = straight). */
export function midAngle(A, Mid, E) {
  const ux = A[0] - Mid[0], uy = A[1] - Mid[1], uz = A[2] - Mid[2], vx = E[0] - Mid[0], vy = E[1] - Mid[1], vz = E[2] - Mid[2];
  const lu = Math.hypot(ux, uy, uz) || 1, lv = Math.hypot(vx, vy, vz) || 1;
  return Math.acos(M.clamp((ux * vx + uy * vy + uz * vz) / (lu * lv), -1, 1));
}
