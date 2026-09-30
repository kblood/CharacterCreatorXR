// DEV/TEST ONLY: extra IWER hand poses (open hand, fist, custom curls) derived from IWER's own relaxed pose by
// flexing each finger chain about its hinges. IWER only ships relaxed / pinch / point; the emulation scenarios
// need open and fist too. Pure (column-major 4x4 arrays, IWER's left-hand data; IWER mirrors it for the right).
import { XR_CHAINS, fingerStateFromCurls } from '../ik/fingers.js';
import { handFrame, fingerAxes, chainAngles, FINGERS } from '../ik/rigdata.js';
import { vSub, vNorm, vCross, vReject, vLen, qAxisAngle, qRotate } from '../ik/qx.js';

const pos = m => [m[12], m[13], m[14]];

function rotateMatrixAbout(m, pivot, q) {
  const out = m.slice();
  for (let c = 0; c < 3; c++) {                         // rotate the 3 basis columns
    const r = qRotate(q, [m[c * 4], m[c * 4 + 1], m[c * 4 + 2]]);
    out[c * 4] = r[0]; out[c * 4 + 1] = r[1]; out[c * 4 + 2] = r[2];
  }
  const p = qRotate(q, vSub(pos(m), pivot));
  out[12] = pivot[0] + p[0]; out[13] = pivot[1] + p[1]; out[14] = pivot[2] + p[2];
  return out;
}

/** Hinge axis (same convention as rigdata.chainAngles): lateral D x F, perpendicular to the segment p. */
function flexAxis(ax, p) {
  const K = vReject(vNorm(vCross(ax.D, ax.F)), p);
  return vLen(K) < 1e-6 ? null : vNorm(K);
}

/**
 * pose: IWER HandPose (left-hand data). curls: { thumb, index, middle, ring, little } 0..1 (missing = keep).
 * Returns a new HandPose whose chains have the absolute angles of fingerStateFromCurls(curls).
 */
export function curledHandPose(pose, curls) {
  const jt = {};
  for (const [k, v] of Object.entries(pose.jointTransforms)) jt[k] = { offsetMatrix: Array.from(v.offsetMatrix), radius: v.radius };
  const P = n => pos(jt[n].offsetMatrix);
  const hf = handFrame('left', P('wrist'), P('index-finger-phalanx-proximal'), P('middle-finger-phalanx-proximal'), P('pinky-finger-phalanx-proximal'));
  const target = fingerStateFromCurls(curls);
  for (const f of FINGERS) {
    const key = f.toLowerCase();
    if (curls[key] == null) continue;
    const chain = XR_CHAINS[f];
    const ax = fingerAxes(f, hf);
    for (let k = 0; k < 3; k++) {
      const pts = chain.map(P);
      const cur = chainAngles(f, hf, pts);
      const name = ['pitch', 'bend1', 'bend2'][k];
      const delta = target[f][name] - cur[name];
      const seg = vNorm(vSub(pts[k + 1], pts[k]));
      const axis = flexAxis(ax, seg);
      if (!axis || Math.abs(delta) < 1e-5) continue;
      const q = qAxisAngle(axis, delta);
      // the joint at the pivot turns too (its orientation), everything distal to it moves
      for (let j = k; j < chain.length; j++) jt[chain[j]].offsetMatrix = rotateMatrixAbout(jt[chain[j]].offsetMatrix, pts[k], q);
    }
  }
  return { jointTransforms: jt, ...(pose.gripOffsetMatrix ? { gripOffsetMatrix: Array.from(pose.gripOffsetMatrix) } : {}) };
}

export const HAND_POSE_CURLS = {
  open: { thumb: 0, index: 0, middle: 0, ring: 0, little: 0 },
  fist: { thumb: 1, index: 1, middle: 1, ring: 1, little: 1 },
  hook: { thumb: 0.2, index: 0.6, middle: 0.6, ring: 0.6, little: 0.6 },
};
