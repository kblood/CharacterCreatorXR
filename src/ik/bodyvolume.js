// Body volume for the IK: the avatar's torso as a stack of horizontal ellipses (rest frame), a head sphere and
// thigh capsules, used to keep the avatar's hands and elbows OUT of its own body (docs/IK.md "Hand-body collision").
// Pure, allocation-free in the hot path (pooled vectors from ./pm.js).
//
// The torso profile was measured once from the CPU-morphed CharacterCreator base mesh (male / female default body,
// rest pose, arms excluded) by a scratch probe: slices every 4 cm with half width, front and back. It is stored
// against the body's own joint heights and re-mapped onto any rig piecewise-linearly between the spine landmarks
// (hips, spine, chest, upperChest, upperArm, neck), widths scaled by the shoulder width, depths by the torso
// length. The collider capsules in assets/body_colliders.json are round inner capsules (cloth/hair); a hand needs
// the elliptic outer surface, which is why this profile exists.
import * as M from './pm.js';

// [y, halfWidth, zBack, zFront] (metres, character frame of the measured body) + its landmarks
const PROFILES = {
  male: {
    marks: { hips: [0.923, 0.003], spine: [1.01, -0.028], chest: [1.08, -0.019], upperChest: [1.14, -0.027], upperArm: [1.379, 0.018, 0.186], neck: [1.482, 0.011] },
    slices: [[0.78, 0.166, -0.061, 0.118], [0.82, 0.169, -0.073, 0.114], [0.86, 0.17, -0.089, 0.114], [0.9, 0.165, -0.1, 0.123], [0.94, 0.157, -0.097, 0.129],
      [0.98, 0.146, -0.085, 0.126], [1.02, 0.142, -0.067, 0.135], [1.06, 0.137, -0.054, 0.134], [1.1, 0.132, -0.056, 0.132], [1.14, 0.136, -0.062, 0.136],
      [1.18, 0.142, -0.07, 0.137], [1.22, 0.151, -0.076, 0.14], [1.26, 0.164, -0.08, 0.146], [1.3, 0.168, -0.088, 0.141], [1.34, 0.165, -0.088, 0.12],
      [1.379, 0.135, -0.08, 0.1], [1.482, 0.055, -0.03, 0.07]],
  },
  female: {
    marks: { hips: [0.826, 0.023], spine: [0.898, -0.022], chest: [0.961, 0], upperChest: [1.051, 0.012], upperArm: [1.263, 0.021, 0.154], neck: [1.346, -0.001] },
    slices: [[0.7, 0.142, -0.031, 0.132], [0.74, 0.14, -0.067, 0.129], [0.78, 0.142, -0.082, 0.12], [0.82, 0.138, -0.092, 0.12], [0.86, 0.134, -0.085, 0.129],
      [0.9, 0.138, -0.057, 0.139], [0.94, 0.141, -0.038, 0.144], [0.98, 0.128, -0.025, 0.138], [1.02, 0.116, -0.02, 0.143], [1.06, 0.12, -0.022, 0.146],
      [1.1, 0.124, -0.028, 0.158], [1.14, 0.135, -0.04, 0.174], [1.18, 0.139, -0.052, 0.161], [1.22, 0.139, -0.061, 0.132], [1.263, 0.12, -0.064, 0.107],
      [1.346, 0.05, -0.02, 0.06]],
  },
};
const LANDMARKS = ['hips', 'spine', 'chest', 'upperChest', 'upperArm', 'neck'];
const BUST_Y = { male: null, female: [1.1, 1.22] };      // slices whose front gets the bust offset

/** Rig-space landmark [y, z] list for prepareRig() rigs. */
function rigMarks(rig) {
  const H = rig.H;
  return { hips: [H.hips[1], H.hips[2]], spine: [H.spine[1], H.spine[2]], chest: [H.chest[1], H.chest[2]], upperChest: [H.upperChest[1], H.upperChest[2]],
    upperArm: [H.leftUpperArm[1], H.leftUpperArm[2], Math.abs(H.leftUpperArm[0])], neck: [H.neck[1], H.neck[2]] };
}

/** Map a measured y onto the rig by the landmark chain (linear outside). Returns { y, zShift }. */
function remapY(prof, rm, y) {
  const pm = prof.marks;
  let i = 0;
  while (i < LANDMARKS.length - 2 && y > pm[LANDMARKS[i + 1]][0]) i++;
  const a = pm[LANDMARKS[i]], b = pm[LANDMARKS[i + 1]], ra = rm[LANDMARKS[i]], rb = rm[LANDMARKS[i + 1]];
  const t = (y - a[0]) / (b[0] - a[0]);
  // the z of the spine line at this height (measured and rig): the profile keeps its offset from the spine
  return { y: ra[0] + (rb[0] - ra[0]) * t, zShift: (ra[1] + (rb[1] - ra[1]) * t) - (a[1] + (b[1] - a[1]) * t) };
}

/**
 * Build the torso profile for a rig: male = 0..1 (1 = male profile, 0 = female, blended in between), bust = extra
 * forward depth (m) of the bust slices (female breast size). Returns Float64Array of [y, a, b, zc] per slice.
 */
export function buildTorso(rig, { male = 1, bust = 0 } = {}) {
  const rm = rigMarks(rig);
  const torsoRig = rm.neck[0] - rm.hips[0];
  const one = (key) => {
    const p = PROFILES[key];
    const sw = rm.upperArm[2] / p.marks.upperArm[2];
    const sd = torsoRig / (p.marks.neck[0] - p.marks.hips[0]);
    return p.slices.map(([y, hw, z0, z1]) => {
      const m = remapY(p, rm, y);
      let front = z1;
      if (BUST_Y[key] && y >= BUST_Y[key][0] && y <= BUST_Y[key][1]) front += bust;
      const zc = (z0 + front) / 2, hd = (front - z0) / 2;
      return [m.y, hw * sw, hd * sd, zc + m.zShift];
    });
  };
  const A = one('male'), B = one('female');
  // blend by normalised height position (both profiles are sampled on their own heights)
  const n = 24, out = new Float64Array(n * 4);
  const lo = Math.min(A[0][0], B[0][0]), hi = Math.max(A[A.length - 1][0], B[B.length - 1][0]);
  const at = (S, y, k) => {
    if (y <= S[0][0]) return S[0][k];
    for (let i = 1; i < S.length; i++) if (y <= S[i][0]) { const t = (y - S[i - 1][0]) / (S[i][0] - S[i - 1][0]); return S[i - 1][k] + (S[i][k] - S[i - 1][k]) * t; }
    return S[S.length - 1][k];
  };
  const w = M.clamp(male, 0, 1);
  for (let i = 0; i < n; i++) {
    const y = lo + (hi - lo) * i / (n - 1);
    out[i * 4] = y;
    for (let k = 1; k < 4; k++) out[i * 4 + k] = at(A, y, k) * w + at(B, y, k) * (1 - w);
  }
  return out;
}

/** Ellipse of the torso at rest height y (writes into e = [a, b, zc]; returns false outside the torso's y range). */
export function torsoAt(torso, y, e) {
  const n = torso.length / 4;
  if (y < torso[0] || y > torso[(n - 1) * 4]) return false;
  let i = 1;
  while (i < n - 1 && y > torso[i * 4]) i++;
  const t = (y - torso[(i - 1) * 4]) / (torso[i * 4] - torso[(i - 1) * 4] || 1);
  for (let k = 1; k < 4; k++) e[k - 1] = torso[(i - 1) * 4 + k] + (torso[i * 4 + k] - torso[(i - 1) * 4 + k]) * t;
  return true;
}

const SPINE_DOWN = ['upperChest', 'chest', 'spine', 'hips'];
const _e = [0, 0, 0];

/**
 * Push point p (solver Y frame) out of the posed torso by radius r. W/P = the solver's world deltas and joint
 * positions (spine chain filled), H = rest heads. Returns a pooled vector (p itself when outside) and writes the
 * push length into res[0].
 */
export function pushOutTorso(torso, H, W, P, p, r, res) {
  res[0] = 0;
  let bone = 'hips';
  let local = null;
  for (let i = 0; i < SPINE_DOWN.length; i++) {
    const b = SPINE_DOWN[i];
    const l = M.vAdd(H[b], M.qRotateInv(W[b], M.vSub(p, P[b])));
    if (l[1] >= H[b][1] || b === 'hips') { bone = b; local = l; break; }
  }
  if (!torsoAt(torso, local[1], _e)) return p;
  const a = _e[0] + r, b = _e[1] + r, zc = _e[2];
  const x = local[0], z = local[2] - zc;
  const v = (x / a) * (x / a) + (z / b) * (z / b);
  if (v >= 1) return p;
  let nx, nz;
  if (v < 1e-6) { nx = 0; nz = b; }                 // at the centre: out the front
  else { const k = 1 / Math.sqrt(v); nx = x * k; nz = z * k; }
  const out = M.v3(nx, local[1], nz + zc);
  const back = M.vAdd(P[bone], M.qRotate(W[bone], M.vSub(out, H[bone])));
  res[0] = M.vDist(back, p);
  return back;
}

/** Is p (Y frame) inside the posed torso inflated by r? */
export function insideTorso(torso, H, W, P, p, r) {
  for (let i = 0; i < SPINE_DOWN.length; i++) {
    const b = SPINE_DOWN[i];
    const l = M.vAdd(H[b], M.qRotateInv(W[b], M.vSub(p, P[b])));
    if (l[1] >= H[b][1] || b === 'hips') {
      if (!torsoAt(torso, l[1], _e)) return false;
      const x = l[0] / (_e[0] + r), z = (l[2] - _e[2]) / (_e[1] + r);
      return x * x + z * z < 1;
    }
  }
  return false;
}

/** Push p out of a sphere (centre c, radius R). Adds the push length to res[0]. */
export function pushOutSphere(c, R, p, res) {
  const d = M.vSub(p, c), l = M.vLen(d);
  if (l >= R) return p;
  res[0] += R - l;
  if (l < 1e-6) return M.vAdd(c, M.v3(0, 0, R));
  return M.vMad(c, d, R / l);
}

/** Push p out of a tapered capsule a->b (radii ra at a, rb at b). Adds the push length to res[0]. */
export function pushOutCapsule(a, b, ra, rb, p, res) {
  const ab = M.vSub(b, a), L2 = M.vDot(ab, ab);
  const t = L2 > 1e-12 ? M.clamp(M.vDot(M.vSub(p, a), ab) / L2, 0, 1) : 0;
  const c = M.vMad(a, ab, t), R = ra + (rb - ra) * t;
  return pushOutSphere(c, R, p, res);
}

export { PROFILES };
