// Procedural stepping for a 3-point (head + hands) avatar: feet stay planted in the world and take short
// arcing steps when the body moves away from them. Pure, engine-agnostic; positions are [x, z] on the floor
// in the solver's scale-free world frame (world metres / avatar scale). docs/IK.md "Legs".
import { clamp, wrapAngle, smoothstep } from './qx.js';

const SIDES = ['left', 'right'];

export const LOCO_DEFAULTS = {
  stanceScale: 0.78,      // foot x = rest foot x * this (rest foot x is wide for the A-pose)
  stepThreshold: 0.13,    // metres of foot error that trigger a step
  moveThreshold: 0.08,    // lower threshold while the body is moving
  yawThreshold: 35 * Math.PI / 180,
  settleDelay: 0.45,      // s of standing still before a small settle step
  settleThreshold: 0.035,
  minDur: 0.22, maxDur: 0.4,
  minHeight: 0.05, maxHeight: 0.1,
  predict: 0.18,          // s of velocity prediction for the step target
  maxStep: 0.62,          // * leg length
  resetDistance: 1.2,     // * leg length: teleport -> feet snap
};

/** state = createLocomotion(rig, opts); step(state, input, dt) -> feet [{ pos:[x,z], yaw, lift, stepping, phase }]. */
export function createLocomotion(rig, opts = {}) {
  const o = { ...LOCO_DEFAULTS, ...opts };
  return {
    o, rig, still: 0, last: 1, initialised: false,
    feet: SIDES.map(() => ({ pos: [0, 0], yaw: 0, lift: 0, from: [0, 0], to: [0, 0], fromYaw: 0, toYaw: 0, t: 0, dur: 0, h: 0, stepping: false })),
    steps: 0,
  };
}

/** Where a foot wants to be for a body at ground point g ([x,z]) with yaw psi. */
export function footHome(st, side, g, psi, vel = [0, 0], predict = 0) {
  const i = side === 'left' ? 0 : 1;
  const fx = st.rig.footX[i] * st.o.stanceScale, fz = st.rig.footZ[i] - st.rig.H.hips[2];
  const c = Math.cos(psi), s = Math.sin(psi);
  return [g[0] + c * fx + s * fz + vel[0] * predict, g[1] - s * fx + c * fz + vel[1] * predict];
}

export function resetFeet(st, g, psi) {
  SIDES.forEach((side, i) => {
    const f = st.feet[i], h = footHome(st, side, g, psi);
    f.pos = h; f.yaw = psi; f.lift = 0; f.stepping = false; f.t = 0;
  });
  st.initialised = true; st.still = 0;
}

/**
 * input: { ground: [x,z] body ground point (pelvis projection), yaw: body yaw psi, vel: [vx,vz] body velocity,
 *          freeze: 0..1 (deep crouch/kneel: suppress steps), force: bool (step now if any error) }
 */
export function stepLocomotion(st, input, dt) {
  const o = st.o, leg = st.rig.legLength;
  const { ground: g, yaw: psi } = input;
  const vel = input.vel || [0, 0];
  const speed = Math.hypot(vel[0], vel[1]);
  if (!st.initialised) resetFeet(st, g, psi);

  // advance steps in flight
  for (const f of st.feet) {
    if (!f.stepping) continue;
    f.t += dt / f.dur;
    const t = clamp(f.t, 0, 1), e = t * t * (3 - 2 * t);
    f.pos = [f.from[0] + (f.to[0] - f.from[0]) * e, f.from[1] + (f.to[1] - f.from[1]) * e];
    f.yaw = f.fromYaw + wrapAngle(f.toYaw - f.fromYaw) * e;
    f.lift = Math.sin(Math.PI * t) * f.h;
    if (f.t >= 1) { f.stepping = false; f.lift = 0; f.pos = [...f.to]; f.yaw = f.toYaw; }
  }

  // teleport / big jumps: snap
  const homeNow = SIDES.map(s => footHome(st, s, g, psi));
  const far = st.feet.some((f, i) => Math.hypot(f.pos[0] - homeNow[i][0], f.pos[1] - homeNow[i][1]) > o.resetDistance * leg);
  if (far) { resetFeet(st, g, psi); return st.feet; }

  st.still = speed < 0.06 ? st.still + dt : 0;
  const moving = speed > 0.15;
  const thr = (moving ? o.moveThreshold : o.stepThreshold) * (1 + 2 * (input.freeze || 0));
  const errs = SIDES.map((s, i) => {
    const f = st.feet[i], h = homeNow[i];
    return { d: Math.hypot(f.pos[0] - h[0], f.pos[1] - h[1]), y: Math.abs(wrapAngle(f.yaw - psi)) };
  });
  const busy = st.feet.some(f => f.stepping && f.t < 0.6);
  if (!busy && (input.freeze || 0) < 0.95) {
    let pick = -1, best = 0;
    for (let i = 0; i < 2; i++) {
      if (st.feet[i].stepping) continue;
      const e = errs[i];
      const need = e.d > thr || e.y > o.yawThreshold || (st.still > o.settleDelay && e.d > o.settleThreshold) || (input.force && e.d > 0.02);
      if (!need) continue;
      // prefer the foot with more error; alternate on ties
      const score = e.d + e.y * 0.2 + (i === st.last ? -0.02 : 0.02);
      if (score > best) { best = score; pick = i; }
    }
    if (pick >= 0) {
      const f = st.feet[pick];
      const dur = clamp(o.maxDur - speed * 0.12, o.minDur, o.maxDur);
      let to = footHome(st, SIDES[pick], g, psi, vel, o.predict + dur * 0.5);
      // limit the step length
      const dx = to[0] - f.pos[0], dz = to[1] - f.pos[1], L = Math.hypot(dx, dz), maxL = o.maxStep * leg;
      if (L > maxL) to = [f.pos[0] + dx * maxL / L, f.pos[1] + dz * maxL / L];
      Object.assign(f, { from: [...f.pos], to, fromYaw: f.yaw, toYaw: psi, t: 0, dur,
        h: clamp(o.minHeight + speed * 0.03 + Math.min(L, maxL) * 0.05, o.minHeight, o.maxHeight), stepping: true });
      st.last = pick; st.steps++;
      if (st.still > o.settleDelay) st.still = 0;
    }
  }
  return st.feet;
}

export { smoothstep };
