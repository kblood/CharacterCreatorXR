// One-Euro filters (Casiez, Roussel, Vogel, CHI 2012: "1 Euro Filter: A Simple Speed-based Low-pass Filter for
// Noisy Input in Interactive Systems"): a low-pass whose cutoff rises with the signal's speed, so slow motion is
// smoothed strongly (no jitter) and fast motion has little lag. Implemented from the paper's description.
// Pure, allocation-free per sample. Used for hand-tracking wrist poses and finger angles (docs/HAND_TRACKING.md).

const alphaOf = (cutoff, dt) => { const tau = 1 / (2 * Math.PI * cutoff); return 1 / (1 + tau / dt); };

/** Scalar One-Euro filter. minCutoff (Hz) = smoothing at rest, beta = speed coefficient, dCutoff = derivative cutoff. */
export function createOneEuro({ minCutoff = 1.0, beta = 0.0, dCutoff = 1.0 } = {}) {
  const f = { minCutoff, beta, dCutoff, x: 0, dx: 0, init: false };
  return f;
}

/** Filter sample x taken dt seconds after the previous one. Returns the filtered value. */
export function oneEuro(f, x, dt) {
  if (!f.init || !(dt > 0)) { f.x = x; f.dx = 0; f.init = true; return x; }
  const dx = (x - f.x) / dt;
  f.dx += (dx - f.dx) * alphaOf(f.dCutoff, dt);
  const cutoff = f.minCutoff + f.beta * Math.abs(f.dx);
  f.x += (x - f.x) * alphaOf(cutoff, dt);
  return f.x;
}
export const resetOneEuro = f => { f.init = false; f.dx = 0; };

/**
 * Pose filter (position + quaternion) for a tracked hand: position with a One-Euro per axis (shared speed),
 * orientation by slerp with the One-Euro alpha of the angular speed. Writes into out { pos:[3], quat:[4] }.
 */
export function createPoseFilter({ minCutoff = 1.2, beta = 6, dCutoff = 1.0, rotMinCutoff = 1.5, rotBeta = 0.6 } = {}) {
  return { minCutoff, beta, dCutoff, rotMinCutoff, rotBeta, p: [0, 0, 0], q: [0, 0, 0, 1], v: 0, w: 0, init: false };
}

export function filterPose(f, pos, quat, dt, out) {
  if (!f.init || !(dt > 0) || dt > 0.25) {
    f.p[0] = pos[0]; f.p[1] = pos[1]; f.p[2] = pos[2];
    f.q[0] = quat[0]; f.q[1] = quat[1]; f.q[2] = quat[2]; f.q[3] = quat[3];
    f.v = 0; f.w = 0; f.init = true;
  } else {
    // position: speed of the raw signal vs the filtered one, low-passed
    const dx = pos[0] - f.p[0], dy = pos[1] - f.p[1], dz = pos[2] - f.p[2];
    const speed = Math.sqrt(dx * dx + dy * dy + dz * dz) / dt;
    f.v += (speed - f.v) * alphaOf(f.dCutoff, dt);
    const a = alphaOf(f.minCutoff + f.beta * f.v, dt);
    f.p[0] += dx * a; f.p[1] += dy * a; f.p[2] += dz * a;
    // orientation: shortest-arc slerp toward the raw quaternion
    let d = f.q[0] * quat[0] + f.q[1] * quat[1] + f.q[2] * quat[2] + f.q[3] * quat[3];
    const s = d < 0 ? -1 : 1; d = Math.min(1, Math.abs(d));
    const ang = 2 * Math.acos(d);
    f.w += (ang / dt - f.w) * alphaOf(f.dCutoff, dt);
    const b = alphaOf(f.rotMinCutoff + f.rotBeta * f.w, dt);
    slerpInto(f.q, f.q, quat[0] * s, quat[1] * s, quat[2] * s, quat[3] * s, b);
  }
  out.pos[0] = f.p[0]; out.pos[1] = f.p[1]; out.pos[2] = f.p[2];
  out.quat[0] = f.q[0]; out.quat[1] = f.q[1]; out.quat[2] = f.q[2]; out.quat[3] = f.q[3];
  return out;
}
export const resetPoseFilter = f => { f.init = false; };

function slerpInto(o, a, bx, by, bz, bw, t) {
  const ax = a[0], ay = a[1], az = a[2], aw = a[3];
  const c = ax * bx + ay * by + az * bz + aw * bw;
  let k0, k1;
  if (c > 0.9995) { k0 = 1 - t; k1 = t; }
  else { const th = Math.acos(Math.min(1, c)), sn = Math.sin(th); k0 = Math.sin((1 - t) * th) / sn; k1 = Math.sin(t * th) / sn; }
  let x = ax * k0 + bx * k1, y = ay * k0 + by * k1, z = az * k0 + bz * k1, w = aw * k0 + bw * k1;
  const l = Math.hypot(x, y, z, w) || 1;
  o[0] = x / l; o[1] = y / l; o[2] = z / l; o[3] = w / l;
}
