// Procedural stepping for a 3-point (head + hands) avatar while standing / shuffling / turning in place: feet
// stay planted in the world and take short arcing steps when the body moves away from them. Pure,
// engine-agnostic, allocation-free per frame; positions are [x, z] on the floor in the solver's scale-free world
// frame (world metres / avatar scale). Walking/running/strafing use the clip-driven legs (src/ik/cliploco.js);
// this module covers standing, small adjustments and turning on the spot. docs/IK.md "Legs".
import { clamp, wrapAngle, smoothstep } from './pm.js';

export const LOCO_DEFAULTS = {
  stanceScale: 0.78,      // foot x = rest foot x * this (rest foot x is wide for the A-pose)
  stepThreshold: 0.13,    // metres of foot error that trigger a step
  moveThreshold: 0.08,    // lower threshold while the body is moving
  yawThreshold: 30 * Math.PI / 180,
  followYaw: 12 * Math.PI / 180,   // after a turning step, the other foot follows if it is off by more than this
  settleDelay: 0.45,      // s of standing still before a small settle step
  settleThreshold: 0.035,
  minDur: 0.22, maxDur: 0.4,
  minHeight: 0.05, maxHeight: 0.1,
  predict: 0.18,          // s of velocity prediction for the step target
  maxStep: 0.62,          // * leg length
  resetDistance: 1.2,     // * leg length: teleport -> feet snap
};

const newFoot = () => ({ pos: [0, 0], yaw: 0, lift: 0, from: [0, 0], to: [0, 0], fromYaw: 0, toYaw: 0, t: 0, dur: 0, h: 0, stepping: false, turn: false });

/** state = createLocomotion(rig, opts); step(state, input, dt) -> feet [{ pos:[x,z], yaw, lift, stepping }]. */
export function createLocomotion(rig, opts = {}) {
  const o = { ...LOCO_DEFAULTS, ...opts };
  return { o, rig, still: 0, last: 1, initialised: false, feet: [newFoot(), newFoot()], steps: 0, home: [[0, 0], [0, 0]], err: [0, 0], errY: [0, 0], followPending: -1 };
}

/** Where foot i (0 = left) wants to be for a body at ground point g ([x,z]) with yaw psi; written into out. */
export function footHomeInto(out, st, i, g, psi, vx = 0, vz = 0, predict = 0) {
  const fx = st.rig.footX[i] * st.o.stanceScale, fz = st.rig.footZ[i] - st.rig.H.hips[2];
  const c = Math.cos(psi), s = Math.sin(psi);
  out[0] = g[0] + c * fx + s * fz + vx * predict;
  out[1] = g[1] - s * fx + c * fz + vz * predict;
  return out;
}
/** Allocating convenience wrapper (tests). */
export function footHome(st, side, g, psi, vel = [0, 0], predict = 0) {
  return footHomeInto([0, 0], st, side === 'left' ? 0 : 1, g, psi, vel[0], vel[1], predict);
}

export function resetFeet(st, g, psi) {
  for (let i = 0; i < 2; i++) {
    const f = st.feet[i];
    footHomeInto(f.pos, st, i, g, psi);
    f.yaw = psi; f.lift = 0; f.stepping = false; f.t = 0; f.turn = false;
  }
  st.initialised = true; st.still = 0; st.followPending = -1;
}

/** Put foot i at a ground position (planted), e.g. where the clip-driven legs left it. */
export function syncFoot(st, i, x, z, yaw) {
  const f = st.feet[i];
  f.pos[0] = x; f.pos[1] = z; f.yaw = yaw; f.lift = 0; f.stepping = false; f.t = 0; f.turn = false;
  st.initialised = true;
}

function startStep(st, i, g, psi, vx, vz, speed) {
  const o = st.o, leg = st.rig.legLength, f = st.feet[i];
  const dur = clamp(o.maxDur - speed * 0.12, o.minDur, o.maxDur);
  footHomeInto(f.to, st, i, g, psi, vx, vz, o.predict + dur * 0.5);
  const dx = f.to[0] - f.pos[0], dz = f.to[1] - f.pos[1], L = Math.hypot(dx, dz), maxL = o.maxStep * leg;
  if (L > maxL) { f.to[0] = f.pos[0] + dx * maxL / L; f.to[1] = f.pos[1] + dz * maxL / L; }
  f.from[0] = f.pos[0]; f.from[1] = f.pos[1];
  f.turn = Math.abs(wrapAngle(f.yaw - psi)) > o.yawThreshold * 0.8;
  f.fromYaw = f.yaw; f.toYaw = psi; f.t = 0; f.dur = dur;
  f.h = clamp(o.minHeight + speed * 0.03 + Math.min(L, maxL) * 0.05, o.minHeight, o.maxHeight);
  f.stepping = true;
  st.last = i; st.steps++;
  if (st.still > o.settleDelay) st.still = 0;
}

/**
 * input: { ground: [x,z] body ground point (pelvis projection), yaw: body yaw psi, vx, vz: body velocity,
 *          freeze: 0..1 (deep crouch/kneel/sit: suppress steps), force: bool (step now if any error) }
 */
export function stepLocomotion(st, input, dt) {
  const o = st.o, leg = st.rig.legLength;
  const g = input.ground, psi = input.yaw;
  const vx = input.vx || 0, vz = input.vz || 0;
  const speed = Math.hypot(vx, vz);
  const freeze = input.freeze || 0;
  if (!st.initialised) resetFeet(st, g, psi);

  // advance steps in flight
  for (let i = 0; i < 2; i++) {
    const f = st.feet[i];
    if (!f.stepping) continue;
    f.t += dt / f.dur;
    const t = clamp(f.t, 0, 1), e = t * t * (3 - 2 * t);
    f.pos[0] = f.from[0] + (f.to[0] - f.from[0]) * e; f.pos[1] = f.from[1] + (f.to[1] - f.from[1]) * e;
    f.yaw = f.fromYaw + wrapAngle(f.toYaw - f.fromYaw) * e;
    f.lift = Math.sin(Math.PI * t) * f.h;
    if (f.t >= 1) {
      f.stepping = false; f.lift = 0; f.pos[0] = f.to[0]; f.pos[1] = f.to[1]; f.yaw = f.toYaw;
      if (f.turn) st.followPending = 1 - i;           // step turn: the other foot follows
      f.turn = false;
    }
  }

  // teleport / big jumps: snap
  let far = false;
  for (let i = 0; i < 2; i++) {
    const h = footHomeInto(st.home[i], st, i, g, psi);
    const f = st.feet[i];
    st.err[i] = Math.hypot(f.pos[0] - h[0], f.pos[1] - h[1]);
    st.errY[i] = Math.abs(wrapAngle(f.yaw - psi));
    if (st.err[i] > o.resetDistance * leg) far = true;
  }
  if (far) { resetFeet(st, g, psi); return st.feet; }

  st.still = speed < 0.06 ? st.still + dt : 0;
  const moving = speed > 0.15;
  const thr = (moving ? o.moveThreshold : o.stepThreshold) * (1 + 2 * freeze);
  const busy = (st.feet[0].stepping && st.feet[0].t < 0.6) || (st.feet[1].stepping && st.feet[1].t < 0.6);
  if (!busy && freeze < 0.95) {
    let pick = -1, best = 0;
    for (let i = 0; i < 2; i++) {
      if (st.feet[i].stepping) continue;
      const d = st.err[i], y = st.errY[i];
      const need = d > thr || y > o.yawThreshold || (st.still > o.settleDelay && d > o.settleThreshold) || (input.force && d > 0.02)
        || (st.followPending === i && (y > o.followYaw || d > o.settleThreshold));
      if (!need) continue;
      // prefer the foot with more error; alternate on ties; a pending follow step wins
      const score = d + y * 0.2 + (i === st.last ? -0.02 : 0.02) + (st.followPending === i ? 1 : 0);
      if (score > best) { best = score; pick = i; }
    }
    if (pick >= 0) { startStep(st, pick, g, psi, vx, vz, speed); if (st.followPending === pick) st.followPending = -1; }
    else if (st.followPending >= 0 && !st.feet[st.followPending].stepping) st.followPending = -1;
  }
  return st.feet;
}

export { smoothstep };
