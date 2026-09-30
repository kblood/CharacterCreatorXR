// Analytic two-bone IK (law of cosines) with a pole direction. Pure, engine-agnostic (arrays).
// Used for arms (shoulder -> elbow -> wrist) and legs (hip -> knee -> ankle). docs/IK.md.
import { clamp, vReject, vNorm, vLen, vSub, vAdd, vScale, vDot, vCross, finite3 } from './qx.js';

/**
 * root A, target T, bone lengths a (A->mid), b (mid->end), pole = preferred direction of the middle joint
 * (need not be orthogonal/unit), fallbackPole used when pole is (nearly) parallel to A->T.
 * opts.minD = minimum root->end distance (limits the fold of the middle joint), opts.maxReach = fraction of a+b.
 * Returns { mid, end, dir, bendNormal, reach, reached, clamped }:
 *   mid  = elbow/knee position, end = where the chain really ends (== T when reachable),
 *   dir  = unit A->T, bendNormal = unit (pole x dir) (hinge axis, + = flexion for the arm/leg convention),
 *   reach = |T - A| / (a + b), reached = |end - T| < 1e-6.
 * Never returns NaN: degenerate inputs (T == A, zero lengths, pole parallel) use fallbacks.
 */
export function solveTwoBone(A, T, a, b, pole, fallbackPole = [0, 0, 1], opts = {}) {
  const maxReach = opts.maxReach ?? 0.9999;
  const eps = 1e-6;
  a = Math.max(a, eps); b = Math.max(b, eps);
  let D = vSub(T, A);
  let dist = vLen(D);
  let dir;
  if (!(dist > eps) || !finite3(D)) { dir = vNorm(fallbackPole); if (vLen(dir) < 0.5) dir = [0, -1, 0]; dist = 0; }
  else dir = vScale(D, 1 / dist);
  const dMin = Math.max(Math.abs(a - b) + 1e-4, opts.minD || 0), dMax = (a + b) * maxReach;
  const d = clamp(dist, dMin, dMax);
  // pole projected onto the plane orthogonal to dir
  let p = vReject(pole, dir);
  if (vLen(p) < 1e-3 * Math.max(1, vLen(pole))) p = vReject(fallbackPole, dir);
  if (vLen(p) < 1e-6) p = vReject(Math.abs(dir[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0], dir);
  p = vNorm(p);
  const cosA = clamp((a * a + d * d - b * b) / (2 * a * d), -1, 1);
  const sinA = Math.sqrt(Math.max(0, 1 - cosA * cosA));
  const mid = vAdd(A, vAdd(vScale(dir, a * cosA), vScale(p, a * sinA)));
  const end = vAdd(A, vScale(dir, d));
  const bendNormal = vNorm(vCross(p, dir));
  return { mid, end, dir, pole: p, bendNormal, reach: dist / (a + b), reached: Math.abs(dist - d) < 1e-6, clamped: dist !== d };
}

/** Interior angle at the middle joint (rad, pi = straight). */
export function midAngle(A, M, E) {
  const u = vNorm(vSub(A, M)), v = vNorm(vSub(E, M));
  return Math.acos(clamp(vDot(u, v), -1, 1));
}
