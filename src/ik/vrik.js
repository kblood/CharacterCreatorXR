// SPDX-License-Identifier: GPL-3.0-or-later
// VRIK-style full-body solve from 3 tracked points (head + 2 hands), written from scratch for this project
// (no code from VRIK / three-vrm / other projects). Pure, engine-agnostic (arrays); output is a canonical
// humanoid pose (vendor/cc/animation/canonical.js) + a placement for the avatar's parent object (bones are
// only ever rotated; the root placement goes to the parent transform). Algorithm and limits: docs/IK.md.
//
// Frames: WORLD = XR reference space (metres). The avatar root object is placed at `rig.position`, rotated by
// `rig.yaw` about +Y and uniformly scaled by `rig.scale`. The solver works in the "yaw frame" Y:
//     pY = Ry(-psi) * (pWorld / s)        (scale-free, facing +Z)
// which is the character frame translated; so world deltas computed in Y are directly canonical deltas.
//
// Allocation: the per-frame path allocates nothing once warmed up. Temporaries come from the pooled math in
// ./pm.js (rewound at the start of every solve); everything that outlives a frame is copied into arrays owned
// by the solver state. The returned result object is REUSED: it is valid until the next solve() call (copy what
// you need to keep). tests/alloc.test.mjs and tools/bench_ik.mjs measure this.
import { JOINTS } from '../../vendor/cc/animation/canonical.js';
import * as M from './pm.js';
import { solveTwoBoneInto, twoBoneResult } from './twobone.js';
import { createLocomotion, stepLocomotion, resetFeet, syncFoot } from './locomotion.js';
import { fingerWorldDeltasInto } from './fingers.js';
import { buildTorso, pushOutTorso, insideTorso, pushOutSphere, pushOutCapsule } from './bodyvolume.js';
import { buildClipTables, createClipLoco, stepClipLoco, resetClipLoco, airPose, idleHips, legAccum, IDLE_CLIPS } from './cliploco.js';

const D = Math.PI / 180;
const SIDES = ['left', 'right'];
const SPINE = ['hips', 'spine', 'chest', 'upperChest', 'neck', 'head'];
const N_JOINTS = JOINTS.length;
const J_NAME = JOINTS.map(j => j[0]), J_PARENT = JOINTS.map(j => j[1]);
const ID = [0, 0, 0, 1];
const X0 = [0, 0, 0];
// joint names per side, precomputed (template strings in the frame loop would allocate)
const NM = SIDES.map(s => Object.fromEntries(['Shoulder', 'UpperArm', 'LowerArm', 'Hand', 'UpperLeg', 'LowerLeg', 'Foot', 'Toes'].map(k => [k, s + k])));

export const VRIK_DEFAULTS = {
  yawTau: 0.45,              // s, body yaw low-pass
  yawMaxTwist: 55 * D,       // head-vs-body twist beyond this is followed hard
  handYawWeight: 0.35,       // how much the hands' direction steers the body yaw
  leanShares: [0.3, 0.55, 0.78, 1.0],          // cumulative forward/side bend at hips, spine, chest, upperChest
  twistShares: [0, 0.12, 0.25, 0.4],           // cumulative head-yaw twist at hips, spine, chest, upperChest
  neckShare: 0.45,           // neck takes this fraction of the remaining head rotation
  neckMax: 70 * D,           // head vs upper chest beyond this: the upper chest turns along
  crouchLean: 38 * D,        // spine bend at a deep crouch
  pitchLeanStart: 25 * D, pitchLeanGain: 0.35,
  offsetLeanMax: 60 * D,     // bend from the head being ahead of the feet
  maxLean: 95 * D, minLean: -25 * D, maxSide: 20 * D,
  handLeanMax: 28 * D,       // extra bend when a hand reaches beyond the arm's length (forward / sideways)
  leanTau: 0.08,
  headBack: 0.0,             // extra metres the head joint sits behind the eyes (tuning)
  elbowMinInterior: 28 * D, kneeMinInterior: 30 * D,
  poleTau: 0.07,
  forearmTwist: 0.6,         // share of the hand's twist (relative to the forearm) taken by the forearm
  twistMax: 160 * D,         // unwrapped hand twist is clamped to +-this (no 360 deg wrap flips)
  armScale: 1,               // proportional arm mode: hand targets scaled about the shoulder (1 = hand-match)
  shrugMax: 18 * D, protractMax: 14 * D, retractMax: 8 * D,
  wristMaxSwing: 85 * D,
  collision: true,           // keep the avatar's hands/elbows out of its own torso, head and thighs
  palmRadius: 0.022, wristRadius: 0.026, elbowRadius: 0.04,
  body: { male: 1, bust: 0 },  // torso profile (src/ik/bodyvolume.js)
  kneelSide: 'right',        // which knee goes to the floor in a very deep crouch (null = never kneel)
  kneelAt: 0.34,             // pelvis height (ankle + legLength * this) where kneeling starts
  heightSlack: 0.05,         // m the avatar head may sit below the tracked head before the feet leave the floor
  walkDrop: 0.06,            // m the pelvis may drop below the tracked chain while walking so the planted foot reaches
  comShift: 0.6,             // how far the feet move from under the pelvis toward under the head in a squat
  holdTime: 0.35,            // s a lost hand is held where it was before it relaxes
  lostBlendTau: 0.25,        // s, blend to/from the relaxed arm when tracking is lost/regained
  clips: true,               // walking/running/strafing legs from the CharacterCreator clips (false = steps only)
  moveOn: 0.32, moveOff: 0.16,   // m/s (scale-free) hysteresis for switching to the clip legs
  idleSway: 0.7,             // weight of the idle clips' hips sway when standing still (0 = off)
  sit: 'auto',               // 'auto' (heuristic) | 'off' | 'on' (force)
  sitBand: [0.6, 0.86],      // eye height / standing eye height range that may be sitting
  sitMaxAhead: -0.025,       // m: the head must have moved back at least 2.5 cm since standing (sitting down onto
                             // a seat behind you); in place or forward = a crouch / squat, not sitting
  sitDelay: 1.2,             // s still in the band (level gaze, hands not near the floor) before sitting
  jump: true, jumpVy: 0.9,   // m/s upward head speed (scale-free) that starts a jump ...
  jumpAbove: 0.02,           // ... once the head is this far ABOVE standing height (standing up fast is not a jump)
  locomotion: {},
};

const newVec = () => [0, 0, 0];
function newArmInfo() { return { reach: 0, clamped: false, target: newVec(), tracked: false, weight: 0, push: 0, drift: 0, held: false }; }

/**
 * rig = prepareRig(heads) (src/ik/rigdata.js). Returns a solver: solve(input, dt) -> result (reused object).
 * input = { head: {pos:[x,y,z], quat:[x,y,z,w]} (viewer pose, world),
 *           hands: { left|right: {pos, quat, valid} } wrist position + hand frame (+Z fingers, +Y back of hand), world,
 *           fingers: { left|right: FingerState | null } (src/ik/fingers.js),
 *           scale: avatar uniform scale (default 1) }
 */
export function createVRIK(rig, opts = {}) {
  const o = { ...VRIK_DEFAULTS, ...opts, body: { ...VRIK_DEFAULTS.body, ...(opts.body || {}) } };
  const W = {}, Ws = {}, joints = {}, Wd = {}, P = {};
  for (const n of J_NAME) { W[n] = [0, 0, 0, 1]; joints[n] = [0, 0, 0, 1]; Wd[n] = [0, 0, 0, 1]; }
  for (const n of SPINE) Ws[n] = [0, 0, 0, 1];
  for (const n of [...SPINE, ...SIDES.flatMap(s => ['Shoulder', 'UpperArm', 'LowerArm', 'Hand', 'UpperLeg', 'LowerLeg', 'Foot', 'Toes'].map(k => s + k))]) P[n] = newVec();
  const result = {
    pose: { joints, root: newVec() }, world: W, positions: P, rig: { position: newVec(), yaw: 0, scale: 1 },
    debug: {
      lean: 0, headSlack: 0, side: 0, crouch: 0, kneel: 0, sit: 0, hipDrop: 0, speed: 0, headYaw: 0, pitch: 0, steps: 0,
      arms: { left: newArmInfo(), right: newArmInfo() },
      feet: [{ pos: [0, 0], ball: [0, 0], lift: 0, stepping: false, locked: false }, { pos: [0, 0], ball: [0, 0], lift: 0, stepping: false, locked: false }],
      loco: { mode: 'step', move: 0, phase: 0, weights: null, air: 'ground', idle: 0 },
    },
  };
  const st = {
    o, rig, psi: null, lean: 0, side: 0, frames: 0,
    prevHt: newVec(), hasPrev: false, vel: [0, 0], vy: 0,
    loco: createLocomotion(rig, o.locomotion),
    pole: { left: newVec(), right: newVec() }, hasPole: { left: false, right: false },
    handW: { left: 0, right: 0 }, lostT: { left: 0, right: 0 },
    lastHand: { left: { pos: newVec(), quat: [0, 0, 0, 1], ok: false }, right: { pos: newVec(), quat: [0, 0, 0, 1], ok: false } },
    tw: { left: 0, right: 0 }, twU: { left: 0, right: 0 }, twFresh: { left: true, right: true }, prevSh: { left: newVec(), right: newVec() }, hasSh: false,
    torso: buildTorso(rig, o.body), palm: { left: newVec(), right: newVec() },
    clipTables: null, clip: null, clipDirty: 0, moving: false, mw: 0,
    lock: [0, 1].map(() => ({ on: false, w: 0, x: 0, z: 0 })), footW: [[0, 0], [0, 0]], ballW: [[0, 0], [0, 0]],
    air: 'ground', airT: 0, aw: 0, airAcc: legAccum(),
    drop: 0, sitT: 0, sitW: 0, standRef: [0, 0], hasStandRef: false, stillT: 0, idleClock: 0, sway: [0, 0, 0, 1], swayA: [0, 0, 0, 1], swayB: [0, 0, 0, 1],
    tb: twoBoneResult(), tb2: twoBoneResult(), pushRes: [0],
    handTmp: { left: { pos: X0, quat: ID, valid: false }, right: { pos: X0, quat: ID, valid: false } }, groundTmp: [0, 0], locoIn: { ground: null, yaw: 0, vx: 0, vz: 0, freeze: 0 }, result, W, Ws, joints, Wd, P,
  };
  setupRig(st, rig);
  return {
    state: st,
    solve: (input, dt) => solve(st, input, dt),
    /** Forget everything that depends on the previous frames (new session, recalibration, teleport). */
    reset: () => {
      st.psi = null; st.hasPrev = false; st.vel[0] = st.vel[1] = 0; st.vy = 0; st.loco.initialised = false;
      st.hasPole.left = st.hasPole.right = false; st.air = 'ground'; st.airT = 0; st.aw = 0; st.mw = 0; st.moving = false;
      st.hasSh = false; st.hasStandRef = false; st.sitT = 0; st.sitW = 0; st.tw.left = st.tw.right = 0; st.twU.left = st.twU.right = 0; st.twFresh.left = st.twFresh.right = true; st.drop = 0;
      for (const sd of SIDES) { st.lastHand[sd].ok = false; st.lostT[sd] = 0; }
      for (const l of st.lock) { l.on = false; l.w = 0; }
      st.frames = 0;
    },
    setRig: r => { setupRig(st, r); st.psi = null; },
    /** Torso profile for the hand collision: { male: 0..1, bust: m }. */
    setBody: b => { Object.assign(o.body, b); st.torso = buildTorso(st.rig, o.body); },
    /** (Re)build the clip tables now (otherwise built lazily while standing, ~0.5 s after a body change). */
    buildClips: () => buildClips(st),
    options: o,
  };
}

function setupRig(st, rig) {
  const firstRig = !st.rig || st.rig === rig;
  st.rig = rig;
  st.loco = createLocomotion(rig, st.o.locomotion);
  st.torso = buildTorso(rig, st.o.body);
  for (const s of SIDES) {
    const H = rig.H, m = H[`${s}MiddleProximal`], h = H[`${s}Hand`];
    st.palm[s][0] = (m[0] - h[0]) * 0.55; st.palm[s][1] = (m[1] - h[1]) * 0.55; st.palm[s][2] = (m[2] - h[2]) * 0.55;
  }
  // clip tables: build now the first time; after a body change keep the old ones until the body is still
  if (st.o.clips && (!st.clipTables || firstRig)) buildClips(st);
  else st.clipDirty = 0.5;
}
function buildClips(st) {
  try {
    st.clipTables = buildClipTables(st.rig);
    if (st.clip) st.clip.tables = st.clipTables; else st.clip = createClipLoco(st.clipTables);
    st.result.debug.loco.weights = st.clip.w;
  } catch (e) { st.clipTables = null; st.clip = null; st.o.clips = false; }
  st.clipDirty = 0;
}

// ---- pooled frame helpers ----
const toY = (psi, s, p) => M.qRotate(M.ry(-psi), M.v3(p[0] / s, p[1] / s, p[2] / s));
const qToY = (psi, q) => M.qMul(M.ry(-psi), q);

/** Relaxed arm target in the Y frame (arm hanging slightly forward) when a hand is not tracked. */
function relaxedPos(rig, sgn, shoulderPos, Dchest) {
  return M.vAdd(shoulderPos, M.qRotate(Dchest, M.v3(sgn * 0.07, -rig.armLength * 0.93, 0.05)));
}
function relaxedQuat(sgn, Dchest) {
  return M.qMul(Dchest, M.qFrameZY(M.v3(0, -1, 0.08), M.v3(sgn, 0, 0)));     // fingers down, back of the hand out
}

/** Spine deltas for a bend `a` (+ side bend, head yaw share, idle sway, neck limit) into Ws. */
function spineInto(st, Ws, a, Dh, headYaw) {
  const o = st.o;
  for (let i = 0; i < 4; i++) {
    let q = M.qMul(M.qMul(M.rx(a * o.leanShares[i]), M.rz(st.side * o.leanShares[i])), M.ry(headYaw * o.twistShares[i]));
    if (i === 0) q = M.qMul(q, st.sway);
    M.set4(Ws[SPINE[i]], q);
  }
  // neck limit: if the head is turned/bent too far from the upper chest, the upper chest follows the excess
  const rel = M.qMul(M.qConj(Ws.upperChest), Dh);
  const ang = M.qAngleOf(rel);
  if (ang > o.neckMax) M.set4(Ws.upperChest, M.qSlerp(Ws.upperChest, Dh, 1 - o.neckMax / ang));
  M.set4(Ws.neck, M.qSlerp(Ws.upperChest, Dh, o.neckShare));
  M.set4(Ws.head, Dh);
}
/** hips joint -> head joint vector under spine deltas Ws (pooled). */
function chainVec(H, Ws) {
  let x = 0, y = 0, z = 0;
  for (let i = 1; i < SPINE.length; i++) {
    const r = M.qRotate(Ws[SPINE[i - 1]], M.vSub(H[SPINE[i]], H[SPINE[i - 1]]));
    x += r[0]; y += r[1]; z += r[2];
  }
  return M.v3(x, y, z);
}
function pelvisFor(st, Ht, a, Dh, headYaw) {
  spineInto(st, st.Ws, a, Dh, headYaw);
  return M.vSub(Ht, chainVec(st.rig.H, st.Ws));
}

/** Elbow pole in the chest frame for a shoulder->target direction d (unit, chest frame). Pooled. */
function poleFor(sgn, d) {
  const wo = M.smoothstep(0.2, 0.75, d[1]);                       // overhead: elbows out
  const wb = M.smoothstep(-0.15, -0.6, d[2]) * (1 - wo);          // behind the back: out and back
  const wa = M.smoothstep(0.05, 0.5, -sgn * d[0]) * (1 - wo) * (1 - wb);   // across the chest: down and forward
  const wl = M.smoothstep(-0.55, -0.9, d[1]) * (1 - wb) * (1 - wa);        // low / at the hips: out and back
  const wsum = Math.min(1, wo + wb + wa + wl), w0 = 1 - wsum;
  return M.v3(
    sgn * (0.55 * w0 + 1.0 * wo + 0.8 * wb + 0.35 * wa + 0.8 * wl),
    -1 * w0 + 0.15 * wo - 0.2 * wb - 1 * wa + 0 * wl,
    -0.3 * w0 - 0.25 * wo - 1 * wb + 0.45 * wa - 0.75 * wl);
}

function solve(st, input, dt) {
  const { o } = st;
  const rig = st.rig, H = rig.H;
  const W = st.W, P = st.P, res = st.result, dbg = res.debug;
  M.beginFrame();
  const s = input && input.scale > 0 ? input.scale : 1;
  dt = M.clamp(Number.isFinite(dt) ? dt : 0, 0, 0.1);
  const head = input && input.head;
  if (!head || !M.finite3(head.pos) || !M.finite4(head.quat)) return null;
  st.frames++;
  if (st.clipDirty > 0) { st.clipDirty -= dt; if (st.clipDirty <= 0 && st.mw < 0.01 && st.aw < 0.01) buildClips(st); else if (st.clipDirty <= 0) st.clipDirty = 0.1; }

  // ---- 1. body yaw ------------------------------------------------------------------------------------
  const camQ = M.qNormalize(head.quat);
  const f = M.qRotate(camQ, M.v3(0, 0, -1)), u = M.qRotate(camQ, M.v3(0, 1, 0));
  let v = M.v3(f[0] + u[0] * -f[1], 0, f[2] + u[2] * -f[1]);
  // hands steer the yaw a bit when they are in front of the body
  let hvx = 0, hvz = 0, hn = 0;
  const vn = M.vNorm(v);
  for (let i = 0; i < 2; i++) {
    const h = input.hands && input.hands[SIDES[i]];
    if (!h || !h.valid || !M.finite3(h.pos)) continue;
    const dx = h.pos[0] - head.pos[0], dz = h.pos[2] - head.pos[2], l = Math.hypot(dx, dz);
    if (l > 0.12 * s && (dx * vn[0] + dz * vn[2]) > 0) { hvx += dx / l; hvz += dz / l; hn++; }
  }
  if (hn) { const hl = Math.hypot(hvx, hvz) || 1, k = o.handYawWeight * hn / 2; v = M.v3(vn[0] + hvx / hl * k, 0, vn[2] + hvz / hl * k); }
  const target = M.vLen(v) > 1e-6 ? M.yawOf(v) : (st.psi ?? 0);
  if (st.psi == null) st.psi = target;
  else {
    let e = M.wrapAngle(target - st.psi);
    st.psi = M.wrapAngle(st.psi + e * M.lp(dt, o.yawTau));
    e = M.wrapAngle(target - st.psi);
    if (Math.abs(e) > o.yawMaxTwist) st.psi = M.wrapAngle(st.psi + e - Math.sign(e) * o.yawMaxTwist);
  }
  const psi = st.psi;
  const qPsi = M.ry(psi);

  // ---- 2. head (Y frame), velocities ---------------------------------------------------------------------
  const Dh = M.qMul(qToY(psi, camQ), M.ry(Math.PI));        // avatar head faces +Z, the camera looks down -Z
  const eyeY = toY(psi, s, head.pos);
  const eyeOff = M.v3(rig.eyeOffset[0], rig.eyeOffset[1], rig.eyeOffset[2] + o.headBack);
  const Ht = M.vSub(eyeY, M.qRotate(Dh, eyeOff));            // head JOINT target
  const HtW = M.qRotate(qPsi, Ht);                           // scale-free world (independent of psi)
  if (st.hasPrev && dt > 0) {
    const k = M.lp(dt, 0.15), ky = M.lp(dt, 0.05);
    st.vel[0] += ((HtW[0] - st.prevHt[0]) / dt - st.vel[0]) * k;
    st.vel[1] += ((HtW[2] - st.prevHt[2]) / dt - st.vel[1]) * k;
    st.vy += ((HtW[1] - st.prevHt[1]) / dt - st.vy) * ky;
  }
  M.set3(st.prevHt, HtW); st.hasPrev = true;
  const speed = Math.hypot(st.vel[0], st.vel[1]);
  // body-frame velocity (+x = avatar's left, +z = forward)
  const cP = Math.cos(psi), sP = Math.sin(psi);
  const lvx = cP * st.vel[0] - sP * st.vel[1], lvz = sP * st.vel[0] + cP * st.vel[1];

  // hand targets (tracked, Y frame) + validity, needed by the lean and the arms
  const hp = st.handTmp;
  for (let i = 0; i < 2; i++) {
    const sd = SIDES[i], inp = input.hands && input.hands[sd], t = hp[sd];
    t.valid = !!(inp && inp.valid && M.finite3(inp.pos) && M.finite4(inp.quat));
    if (t.valid) { t.pos = toY(psi, s, inp.pos); t.quat = M.qNormalize(qToY(psi, inp.quat)); }
  }

  // ---- 3. posture state: jump / sit -------------------------------------------------------------------------
  const hf = M.qRotate(Dh, M.v3(0, 0, 1));
  const pitch = Math.asin(M.clamp(-hf[1], -1, 1));           // + = looking down
  const headYaw = M.twistAngle(M.qNormalize(Dh), M.v3(0, 1, 0));
  const standY = H.head[1];
  // jump: the head goes up fast from (about) standing height -> airborne until it is back at standing height
  st.airT += dt;
  if (o.jump && st.air === 'ground' && st.vy > o.jumpVy && Ht[1] > standY + o.jumpAbove) { st.air = 'jump'; st.airT = 0; }
  else if (st.air === 'jump' && st.vy < 0.05) { st.air = 'fall'; }
  else if ((st.air === 'jump' || st.air === 'fall') && ((Ht[1] <= standY + 0.012 && st.vy <= 0.05) || st.airT > 1.6)) { st.air = 'land'; st.airT = 0; }
  else if (st.air === 'land' && st.airT > 0.25) st.air = 'ground';
  const airborne = st.air === 'jump' || st.air === 'fall';
  st.aw += ((airborne ? 1 : 0) - st.aw) * M.lp(dt, airborne ? 0.05 : 0.08);
  if (st.aw < 1e-3) st.aw = 0;
  // feet centre in the Y frame
  const feet = st.loco.feet;
  let fcx, fcz;
  if (st.loco.initialised) {
    const gx = (feet[0].pos[0] + feet[1].pos[0]) / 2, gz = (feet[0].pos[1] + feet[1].pos[1]) / 2;
    fcx = cP * gx - sP * gz; fcz = sP * gx + cP * gz;
  } else { fcx = Ht[0]; fcz = Ht[2] - (H.head[2] - H.hips[2]); }
  const restHeadAhead = H.head[2] - (rig.footZ[0] + rig.footZ[1]) / 2;
  const off = Ht[2] - fcz - restHeadAhead, offX = Ht[0] - fcx;
  // sit: low but not squatting, level gaze, still, hands not near the floor, and the head did not move forward
  // since the user last stood (sitting down onto a seat moves the head back; a squat / crouch moves it forward)
  const eyeRatio = eyeY[1] / Math.max(0.5, rig.eyeHeight);
  if (eyeRatio > 0.9 || !st.hasStandRef) { st.standRef[0] = HtW[0]; st.standRef[1] = HtW[2]; st.hasStandRef = true; }
  const fW = M.qRotate(qPsi, hf), fl = Math.hypot(fW[0], fW[2]) || 1;
  const headFwd = ((HtW[0] - st.standRef[0]) * fW[0] + (HtW[2] - st.standRef[1]) * fW[2]) / fl * s;
  let sitCand = false;
  if (o.sit === 'on') sitCand = eyeRatio < o.sitBand[1];
  else if (o.sit === 'auto') {
    let handsLow = false;
    for (let i = 0; i < 2; i++) { const t = hp[SIDES[i]]; if (t.valid && t.pos[1] < H[NM[i].LowerLeg][1] * 0.9) handsLow = true; }
    const inBand = eyeRatio > o.sitBand[0] && eyeRatio < o.sitBand[1] && Math.abs(pitch) < 30 * D && speed < 0.12 && !handsLow && !airborne && headFwd < o.sitMaxAhead;
    st.sitT = inBand ? st.sitT + dt : 0;
    sitCand = st.sitT > o.sitDelay || (st.sitW > 0.5 && eyeRatio < o.sitBand[1] + 0.02 && speed < 0.3 && !handsLow);
  }
  st.sitW += ((sitCand ? 1 : 0) - st.sitW) * M.lp(dt, sitCand ? 0.3 : 0.15);
  if (st.sitW < 1e-3) st.sitW = 0;
  const sitW = st.sitW;

  // ---- 4. spine bend ------------------------------------------------------------------------------------
  const crouch = M.clamp((standY - Ht[1]) / standY, 0, 1);
  const moveFade = 1 - M.smoothstep(0.25, 0.6, speed);
  let lean = M.smoothstep(0.04, 0.45, crouch) * o.crouchLean
    + Math.max(0, pitch - o.pitchLeanStart) * o.pitchLeanGain + Math.min(0, pitch + 35 * D) * 0.3
    // head ahead of / behind the feet beyond a +-6 cm dead zone (continuous at the zone edges)
    + M.clamp(Math.asin(M.clamp((off > 0.06 ? off - 0.06 : off < -0.06 ? off + 0.06 : 0) / rig.torsoLen, -0.4, 0.95)), -10 * D, o.offsetLeanMax) * moveFade * (1 - sitW);
  let side = M.clamp(-Math.asin(M.clamp((Math.abs(offX) > 0.05 ? offX - Math.sign(offX) * 0.05 : 0) / rig.torsoLen, -1, 1)), -o.maxSide, o.maxSide) * moveFade * (1 - sitW);
  // reaching: a hand beyond the arm's length (from last frame's shoulder) bends the torso toward it
  if (st.hasSh) {
    let fwdEx = 0, sideEx = 0;
    for (let i = 0; i < 2; i++) {
      const t = hp[SIDES[i]];
      if (!t.valid) continue;
      const sh = st.prevSh[SIDES[i]], d = M.vScale(M.vSub(t.pos, sh), o.armScale), l = M.vLen(d);
      const ex = l - rig.armLength * 0.97;
      if (ex <= 0 || l < 1e-6) continue;
      fwdEx = Math.max(fwdEx, ex * M.clamp(d[2] / l, 0, 1) * M.clamp(1 + d[1] / l, 0, 1));
      sideEx += ex * (d[0] / l) * M.clamp(1 - Math.abs(d[2] / l), 0, 1);
    }
    lean += Math.min(o.handLeanMax, Math.atan(fwdEx * 1.3 / rig.torsoLen)) * (1 - sitW);
    side += M.clamp(-Math.atan(sideEx * 1.3 / rig.torsoLen), -o.handLeanMax * 0.6, o.handLeanMax * 0.6) * (1 - sitW);
  }
  lean = lean * (1 - sitW) + (-3 * D) * sitW;                 // sitting: upright
  lean = M.clamp(lean, o.minLean, o.maxLean);
  side = M.clamp(side, -o.maxSide, o.maxSide);
  const k = M.lp(dt, o.leanTau);
  st.lean = st.frames === 1 ? lean : st.lean + (lean - st.lean) * k;
  st.side = st.frames === 1 ? side : st.side + (side - st.side) * k;

  // idle sway (hips) from the idle clips while standing still
  st.stillT = speed < 0.06 && st.mw < 0.01 && st.aw === 0 && sitW < 0.1 ? st.stillT + dt : 0;
  const idleW = o.idleSway > 0 && st.clip ? M.smoothstep(2, 4, st.stillT) * o.idleSway : 0;
  if (idleW > 0) {
    st.idleClock += dt;
    const per = 9, n = IDLE_CLIPS.length, ci = Math.floor(st.idleClock / per) % n, tt = st.idleClock % per;
    idleHips(st.clip, st.swayA, IDLE_CLIPS[ci], tt);
    if (tt > per - 1) { idleHips(st.clip, st.swayB, IDLE_CLIPS[(ci + 1) % n], tt - per); M.set4(st.sway, M.qSlerp(st.swayA, st.swayB, M.smoothstep(per - 1, per, tt))); }
    else M.set4(st.sway, st.swayA);
    M.set4(st.sway, M.qSlerp(ID, st.sway, idleW));
  } else { st.sway[0] = st.sway[1] = st.sway[2] = 0; st.sway[3] = 1; st.idleClock = 0; }

  let a = st.lean, pelvis = pelvisFor(st, Ht, a, Dh, headYaw);
  // the pelvis must not sink through the floor: bend more (bisection on the lean)
  if (pelvis[1] < rig.minPelvisY) {
    let lo = a, hi = o.maxLean;
    for (let i = 0; i < 18; i++) {
      const m = (lo + hi) / 2;
      if (pelvisFor(st, Ht, m, Dh, headYaw)[1] < rig.minPelvisY) lo = m; else hi = m;
    }
    a = hi; pelvis = pelvisFor(st, Ht, a, Dh, headYaw);
    if (pelvis[1] < rig.minPelvisY) pelvis = M.v3(pelvis[0], rig.minPelvisY, pelvis[2]);   // head lower than reachable: accept
  }
  // ...and must not rise above what straight legs allow: bending over lowers the head, so a head that stays
  // high cannot be bent over (bend less). If it is still too high with no bend, the feet leave the floor.
  const maxPelvisY = H.hips[1] + 0.01;
  if (pelvis[1] > maxPelvisY && a > 0) {
    let lo = 0, hi = a;
    if (pelvisFor(st, Ht, 0, Dh, headYaw)[1] > maxPelvisY) hi = 0;
    else for (let i = 0; i < 18; i++) {
      const m = (lo + hi) / 2;
      if (pelvisFor(st, Ht, m, Dh, headYaw)[1] > maxPelvisY) hi = m; else lo = m;
    }
    a = lo; pelvis = pelvisFor(st, Ht, a, Dh, headYaw);
  } else spineInto(st, st.Ws, a, Dh, headYaw);
  // A few cm too high is tracking/eye-model slack (e.g. looking far down pivots the modelled eyes about the
  // head joint): keep the feet down and let the avatar head sit slightly low. Beyond the slack: feet lift
  // (not during a jump: then the body really goes up).
  let headSlack = 0;
  if (pelvis[1] > maxPelvisY) {
    const e = pelvis[1] - maxPelvisY, keep = Math.min(e, o.heightSlack) * (1 - st.aw);
    pelvis = M.v3(pelvis[0], pelvis[1] - keep, pelvis[2]); headSlack = keep;
  }

  // ---- 5. positions of the upper body (Y frame) ------------------------------------------------------------
  for (let i = 0; i < SPINE.length; i++) M.set4(W[SPINE[i]], st.Ws[SPINE[i]]);
  M.set3(P.hips, pelvis);
  for (let i = 1; i < SPINE.length; i++) M.set3(P[SPINE[i]], M.vAdd(P[SPINE[i - 1]], M.qRotate(W[SPINE[i - 1]], M.vSub(H[SPINE[i]], H[SPINE[i - 1]]))));

  // ---- 6. legs ----------------------------------------------------------------------------------------------
  const pelvisW = M.qRotate(qPsi, pelvis);                   // scale-free world
  const hipDrop = M.clamp((H.hips[1] - pelvis[1]) / rig.legLength, 0, 1);
  const kneelY = rig.ankleHeight + rig.legLength * o.kneelAt;
  const kneel = o.kneelSide ? M.smoothstep(kneelY + 0.03, kneelY - 0.1, pelvis[1]) * (1 - sitW) : 0;
  // clip legs: on/off with hysteresis, faded out by crouching, sitting and jumping
  if (speed > o.moveOn) st.moving = true; else if (speed < o.moveOff) st.moving = false;
  const mwTarget = o.clips && st.clip ? (st.moving ? 1 : 0) * (1 - M.smoothstep(0.25, 0.45, hipDrop)) * (1 - sitW) * (1 - st.aw) : 0;
  if (st.mw === 0 && mwTarget > 0 && st.clip) {
    // start the cycle with the foot that is behind (relative to the motion) swinging first
    const lf = feet[0].pos, rf = feet[1].pos;
    const back = (rf[0] - lf[0]) * st.vel[0] + (rf[1] - lf[1]) * st.vel[1];
    resetClipLoco(st.clip, back < 0 ? 0 : 0.5);
  }
  st.mw += (mwTarget - st.mw) * M.lp(dt, mwTarget > st.mw ? 0.15 : 0.25);
  if (st.mw < 1e-3) st.mw = 0;
  const mw = st.mw;
  const acc = mw > 0 ? stepClipLoco(st.clip, M.v3(lvx, lvz, 0), dt) : null;
  const air = st.aw > 0 && st.clip ? airPose(st.clip, st.airAcc, st.airT, st.air !== 'jump') : null;
  // walking with a level tracked head: if a planted (or locked) clip foot cannot reach the floor from the
  // pelvis, the pelvis (and the avatar head) may sit up to walkDrop lower - real walking bobs the head anyway
  let need = 0;
  if (acc) {
    for (let i = 0; i < 2; i++) {
      const S = acc.side[i];
      if (S.contact < 0.5) continue;
      const A = M.vAdd(pelvis, M.qRotate(W.hips, M.vSub(H[NM[i].UpperLeg], H.hips)));
      let tx = A[0] + S.off[0], tz = A[2] + S.off[1];
      const lock = st.lock[i];
      if (lock.on) { const L = M.qRotate(M.ry(-psi), M.v3(lock.x, 0, lock.z)), to = M.qRotate(S.foot, M.vSub(H[NM[i].Toes], H[NM[i].Foot])); tx = L[0] - to[0]; tz = L[2] - to[2]; }
      const Lmax = (rig.len[NM[i].UpperLeg] + rig.len[NM[i].LowerLeg]) * 0.995;
      const h2 = (tx - A[0]) ** 2 + (tz - A[2]) ** 2;
      need = Math.max(need, A[1] - (rig.ankleHeight + Math.max(0, S.ankleY)) - Math.sqrt(Math.max(0, Lmax * Lmax - h2)));
    }
  }
  st.drop += (Math.min(o.walkDrop, Math.max(0, need)) * mw - st.drop) * M.lp(dt, 0.05);
  if (st.drop > 1e-4) {
    pelvis = M.v3(pelvis[0], pelvis[1] - st.drop, pelvis[2]);
    for (let i = 0; i < SPINE.length; i++) P[SPINE[i]][1] -= st.drop;
    headSlack += st.drop;
  } else st.drop = 0;
  // support point: under the pelvis when standing, toward under the head in a squat (centre of mass)
  const cw = M.smoothstep(0, 0.5, hipDrop) * o.comShift;
  const gp = st.groundTmp;
  gp[0] = pelvisW[0] + (HtW[0] - pelvisW[0]) * cw; gp[1] = pelvisW[2] + (HtW[2] - pelvisW[2]) * cw;
  const li = st.locoIn;
  li.ground = gp; li.yaw = psi; li.vx = st.vel[0]; li.vz = st.vel[1];
  li.freeze = Math.max(M.smoothstep(0.35, 0.5, hipDrop), sitW, mw > 0.5 ? 1 : 0, st.aw > 0.3 ? 1 : 0);
  if (st.air === 'land' && st.airT < dt * 1.5) for (let i = 0; i < 2; i++) syncFoot(st.loco, i, st.footW[i][0], st.footW[i][1], psi);
  const lf = stepLocomotion(st.loco, li, dt);
  for (let i = 0; i < 2; i++) {
    const sd = SIDES[i], sgn = i === 0 ? 1 : -1;
    const ft = lf[i];
    const ul = NM[i].UpperLeg, ll = NM[i].LowerLeg, fo = NM[i].Foot, to = NM[i].Toes;
    const A = M.vAdd(pelvis, M.qRotate(W.hips, M.vSub(H[ul], H.hips)));
    const a1 = rig.len[ul], b1 = rig.len[ll];
    // procedural (standing / stepping) target
    const fy = M.wrapAngle(ft.yaw - psi);
    const fwd = M.qRotate(M.ry(fy), M.v3(0, 0, 1));
    const fp = M.qRotate(M.ry(-psi), M.v3(ft.pos[0], 0, ft.pos[1]));
    const heel = M.smoothstep(0.3, 0.6, hipDrop) * 28 * D;      // heel lift for deep squats
    const FL = rig.footLength;
    let T = M.v3(fp[0] - fwd[0] * FL * (1 - Math.cos(heel)), rig.ankleHeight + ft.lift + FL * Math.sin(heel) * 0.85, fp[2] - fwd[2] * FL * (1 - Math.cos(heel)));
    let footPitch = heel;
    // toe-off: a planted foot behind a moving pelvis would be pulled off the floor by the stretched leg -
    // instead raise the heel about the ball of the foot (bisection on the extra heel angle, max 50 deg)
    const Lmax = (a1 + b1) * 0.999;
    if (ft.lift === 0 && M.vDist(T, A) > Lmax) {
      let lo = heel, hi = Math.max(heel, 35 * D);
      if (M.vDist(heelAt(fp, fwd, FL, rig.ankleHeight, hi), A) <= Lmax) {
        for (let j = 0; j < 14; j++) { const m = (lo + hi) / 2; if (M.vDist(heelAt(fp, fwd, FL, rig.ankleHeight, m), A) > Lmax) lo = m; else hi = m; }
      }
      footPitch = hi; T = heelAt(fp, fwd, FL, rig.ankleHeight, hi);
    }
    // kneel: this leg's knee to the floor, shin back along the floor, toes tucked
    const kw = sd === o.kneelSide ? kneel : 0;
    if (kw > 0) {
      const kneeH = 0.07, hy = A[1] - kneeH;
      const hd = Math.sqrt(Math.max(0, a1 * a1 - hy * hy)) * 0.9;
      const Kx = A[0] + fwd[0] * hd, Kz = A[2] + fwd[2] * hd;
      T = M.vLerp(T, M.v3(Kx - fwd[0] * b1 * 0.97, kneeH + 0.035, Kz - fwd[2] * b1 * 0.97), kw);
      footPitch = footPitch + (70 * D - footPitch) * kw;
    }
    let pole = M.vAdd(fwd, M.v3(sgn * 0.12, 0, 0));
    let Qf = M.qMul(M.ry(fy), M.rx(footPitch)), Qt = M.qMul(M.ry(fy), M.rx(footPitch * 0.05));
    // clip legs (walking / running / strafing), feet locked while in contact
    const lock = st.lock[i];
    if (acc) {
      const S = acc.side[i];
      let Tc = M.v3(A[0] + S.off[0], rig.ankleHeight + Math.max(0, S.ankleY), A[2] + S.off[1]);
      const c = S.contact;
      // the lock holds the ball of the foot (toes joint), like a real foot rolling off it; the ankle follows
      // from the clip's foot orientation (its heel-off pitch then lifts the heel instead of sliding the toes)
      const toe = M.qRotate(S.foot, M.vSub(H[to], H[fo]));
      const BcW = M.qRotate(qPsi, M.v3(Tc[0] + toe[0], 0, Tc[2] + toe[2]));
      if (lock.on && (c < 0.4 || mw < 0.3 || Math.hypot(BcW[0] - lock.x, BcW[2] - lock.z) > 0.4 * rig.legLength)) lock.on = false;
      else if (!lock.on && mw > 0.5 && c > 0.6) { lock.on = true; lock.x = st.ballW[i][0]; lock.z = st.ballW[i][1]; }
      lock.w = lock.on ? 1 : lock.w * (1 - M.lp(dt, 0.08));
      let Qc = S.foot;
      if (lock.w > 1e-3) {
        const L = M.qRotate(M.ry(-psi), M.v3(lock.x, 0, lock.z));
        let ax = L[0] - toe[0], az = L[2] - toe[2];
        // still out of reach (end of stance, body ahead of the foot): extra toe-off about the locked ball
        // instead of dragging the foot along the floor (bisection on the extra heel angle, max 50 deg)
        if (lock.w > 0.5 && M.vDist(M.v3(ax, Tc[1], az), A) > Lmax) {
          const cfy = M.yawOf(M.qRotate(S.foot, M.v3(0, 0, 1)));
          let lo = 0, hi = 50 * D;
          if (M.vDist(ballAnkle(L, cfy, hi, S.foot, H[to], H[fo], Tc[1]), A) <= Lmax) {
            for (let j = 0; j < 14; j++) { const m = (lo + hi) / 2; if (M.vDist(ballAnkle(L, cfy, m, S.foot, H[to], H[fo], Tc[1]), A) > Lmax) lo = m; else hi = m; }
          } else lock.on = false;     // out of reach even on tiptoe: end the stance early (fades out over ~0.08 s)
          const Ab = ballAnkle(L, cfy, hi, S.foot, H[to], H[fo], Tc[1]);
          ax = Ab[0]; az = Ab[2]; Tc[1] = Ab[1];
          Qc = M.qMul(M.qMul(M.ry(cfy), M.rx(hi)), M.qMul(M.ry(-cfy), S.foot));
        }
        Tc = M.v3(Tc[0] + (ax - Tc[0]) * lock.w, Tc[1], Tc[2] + (az - Tc[2]) * lock.w);
      }
      T = M.vLerp(T, Tc, mw);
      // a locked foot owns its floor position outright (also while the clip legs are still blending in)
      if (lock.w > 1e-3) { const wl = (1 - mw) * lock.w; T[0] += (Tc[0] - T[0]) * wl; T[2] += (Tc[2] - T[2]) * wl; }
      pole = M.vLerp(pole, S.knee, mw);
      Qf = M.qSlerp(Qf, Qc, mw); Qt = M.qSlerp(Qt, S.toes, mw);
    } else { lock.on = false; lock.w = 0; }
    // airborne (tracked jump): leg shape of the jump / fall clips, hanging from the hip
    if (air) {
      const S = air.side[i];
      const Ta = M.v3(A[0] + S.off[0], Math.max(rig.ankleHeight, A[1] + S.relY), A[2] + S.off[1]);
      T = M.vLerp(T, Ta, st.aw);
      pole = M.vLerp(pole, S.knee, st.aw);
      Qf = M.qSlerp(Qf, S.foot, st.aw); Qt = M.qSlerp(Qt, S.toes, st.aw);
    }
    // sitting: thighs forward, shins down, feet flat in front of the seat
    if (sitW > 0) {
      const Ts = M.v3(A[0] + sgn * 0.03, rig.ankleHeight, A[2] + a1 * 0.95);
      T = M.vLerp(T, Ts, sitW);
      pole = M.vLerp(pole, M.v3(0, 0.6, 1), sitW);
      Qf = M.qSlerp(Qf, ID, sitW); Qt = M.qSlerp(Qt, ID, sitW);
    }
    // a planted foot keeps the ball of the foot (toes joint) on the floor whatever the blended foot pitch is
    const plantW = (acc ? mw * M.smoothstep(0.4, 0.8, acc.side[i].contact) : 0) + (1 - (acc ? mw : 0)) * (ft.stepping ? 0 : 1);
    const pw = plantW * (1 - kw) * (1 - st.aw);
    if (pw > 0) {
      const toeOff = M.qRotate(Qf, M.vSub(H[to], H[fo]));
      let y = T[1] + (Math.max(H[to][1] - toeOff[1], rig.ankleHeight * 0.85) - T[1]) * pw;
      // ...but never pulls it below what the leg reaches (the heel stays up instead); a locked foot that is
      // horizontally out of reach ends its stance
      const h2 = (T[0] - A[0]) ** 2 + (T[2] - A[2]) ** 2;
      if (h2 < Lmax * Lmax) y = Math.max(y, Math.min(T[1], A[1] - Math.sqrt(Lmax * Lmax - h2)));
      else if (lock.on) lock.on = false;
      T = M.v3(T[0], y, T[2]);
    }
    const minD = Math.sqrt(a1 * a1 + b1 * b1 - 2 * a1 * b1 * Math.cos(o.kneeMinInterior));
    const r = solveTwoBoneInto(st.tb, A, T, a1, b1, pole, fwd, minD);
    const Dul = M.qAlignFrames(rig.dir[ul], rig.axes[ll], M.vNorm(M.vSub(r.mid, A)), r.bendNormal);
    const Dll = M.qMul(M.qFromTo(M.qRotate(Dul, rig.dir[ll]), M.vNorm(M.vSub(r.end, r.mid))), Dul);
    M.set4(W[ul], Dul); M.set4(W[ll], Dll); M.set4(W[fo], Qf); M.set4(W[to], Qt);
    M.set3(P[ul], A); M.set3(P[ll], r.mid); M.set3(P[fo], r.end);
    M.set3(P[to], M.vAdd(r.end, M.qRotate(Qf, M.vSub(H[to], H[fo]))));
    const eW = M.qRotate(qPsi, r.end);
    st.footW[i][0] = eW[0]; st.footW[i][1] = eW[2];
    const bW = M.qRotate(qPsi, P[to]); st.ballW[i][0] = bW[0]; st.ballW[i][1] = bW[2];
    if (mw > 0.5 || st.aw > 0.5) syncFoot(st.loco, i, eW[0], eW[2], psi);
    const fd = dbg.feet[i];
    fd.pos[0] = eW[0]; fd.pos[1] = eW[2]; fd.ball[0] = bW[0]; fd.ball[1] = bW[2]; fd.lift = acc || air ? Math.max(0, r.end[1] - rig.ankleHeight) : ft.lift;
    fd.stepping = !!((acc && acc.side[i].contact < 0.5 && mw > 0.05) || (mw < 0.95 && ft.stepping) || st.aw > 0.05); fd.locked = lock.on;
  }

  // ---- 7. arms ------------------------------------------------------------------------------------------------
  const Duc = W.upperChest;
  for (let i = 0; i < 2; i++) {
    const sd = SIDES[i], sgn = i === 0 ? 1 : -1;
    const sh = NM[i].Shoulder, ua = NM[i].UpperArm, la = NM[i].LowerArm, hn = NM[i].Hand;
    const info = dbg.arms[sd];
    const Psh = M.vAdd(P.upperChest, M.qRotate(Duc, M.vSub(H[sh], H.upperChest)));
    const A0 = M.vAdd(Psh, M.qRotate(Duc, M.vSub(H[ua], H[sh])));
    const t = hp[sd], last = st.lastHand[sd];
    const valid = t.valid;
    st.lostT[sd] = valid ? 0 : st.lostT[sd] + dt;
    if (!valid && st.lostT[sd] > o.holdTime) st.twFresh[sd] = true;     // re-acquired later: no stale winding
    const want = valid || (last.ok && st.lostT[sd] < o.holdTime) ? 1 : 0;      // hold, then relax
    st.handW[sd] = st.frames === 1 ? want : st.handW[sd] + (want - st.handW[sd]) * M.lp(dt, o.lostBlendTau);
    const rPos = relaxedPos(rig, sgn, A0, Duc), rQ = relaxedQuat(sgn, Duc);
    let tPos, tQ;
    if (valid) { tPos = t.pos; tQ = t.quat; M.set3(last.pos, tPos); M.set4(last.quat, tQ); last.ok = true; }
    else if (last.ok && st.handW[sd] > 0.01) { tPos = last.pos; tQ = last.quat; }
    else { tPos = rPos; tQ = rQ; last.ok = false; }
    const w = st.handW[sd];
    if (o.armScale !== 1 && tPos !== rPos) tPos = M.vAdd(A0, M.vScale(M.vSub(tPos, A0), o.armScale));   // tracked/held only
    tPos = M.vLerp(rPos, tPos, w); tQ = M.qSlerp(rQ, tQ, w);
    const Dhand = M.qMul(tQ, M.qConj(rig.hands[sd].frame.q));
    M.set3(info.target, tPos);

    // hand-body collision: palm centre and wrist out of the torso, head and thighs (targets only)
    let push = 0;
    if (o.collision) {
      const pr = st.pushRes;
      for (let it = 0; it < 2; it++) {
        const palm = M.vAdd(tPos, M.qRotate(Dhand, st.palm[sd]));
        let p2 = pushOutTorso(st.torso, H, W, P, palm, o.palmRadius, pr);
        const hs = rig.headSphere;
        pr[0] = 0;
        p2 = pushOutSphere(M.vAdd(P.head, M.qRotate(W.head, hs.c1)), hs.r1, p2, pr);
        p2 = pushOutSphere(M.vAdd(P.head, M.qRotate(W.head, hs.c2)), hs.r2, p2, pr);
        for (let j = 0; j < 2; j++) p2 = pushOutCapsule(P[NM[j].UpperLeg], P[NM[j].LowerLeg], 0.075 * rig.legLength / 0.8, 0.052 * rig.legLength / 0.8, p2, pr);
        tPos = M.vAdd(tPos, M.vSub(p2, palm));
        const w2 = pushOutTorso(st.torso, H, W, P, tPos, o.wristRadius, pr);
        tPos = w2;
      }
      push = M.vDist(tPos, info.target);
    }

    // clavicle: shrug with elevation, protract with forward reach (chest frame)
    const loc = M.qRotateInv(Duc, M.vSub(tPos, A0));
    const e = loc[1] / rig.armLength, fw = loc[2] / rig.armLength, across = -sgn * loc[0] / rig.armLength;
    const shrug = M.smoothstep(0.05, 0.9, e) * o.shrugMax;
    // (reaching across the body beyond the arm's length protracts the shoulder fully: keeps the straight arm off the chest)
    const over = M.smoothstep(0.9, 1.15, M.vLen(loc) / rig.armLength);
    const prot = M.smoothstep(0.35, 1.0, fw) * o.protractMax + M.smoothstep(0.0, 0.6, across) * o.protractMax * (0.6 + 0.6 * over) - M.smoothstep(-0.1, -0.6, fw) * o.retractMax;
    let Qsh = M.qMul(M.rz(shrug), M.ry(-prot));                 // left-side convention
    if (sd === 'right') Qsh = M.qMirrorX(Qsh);
    const Dsh = M.qMul(Duc, Qsh);
    const A = M.vAdd(Psh, M.qRotate(Dsh, M.vSub(H[ua], H[sh])));

    // elbow pole: depends on where the hand is (front / overhead / behind / across / low), nudged by the hand's
    // ulnar side; never across the torso; low-passed so it cannot flip from one frame to the next
    const dl = M.vNorm(M.qRotateInv(Duc, M.vSub(tPos, A)));
    const ulnar = M.vScale(M.qRotate(Dhand, rig.hands[sd].frame.R), -1);   // little-finger side of the hand
    let pc = M.vAdd(M.vNorm(poleFor(sgn, dl)), M.vScale(M.qRotateInv(Duc, ulnar), 0.35 * w));
    if (pc[0] * sgn < 0.15) pc = M.v3(sgn * 0.15, pc[1], pc[2]);
    let pole = M.qRotate(Duc, M.vNorm(pc));
    if (st.hasPole[sd] && dt > 0) pole = M.vNorm(M.vLerp(st.pole[sd], pole, M.lp(dt, o.poleTau)));
    M.set3(st.pole[sd], pole); st.hasPole[sd] = true;

    const a1 = rig.len[ua], b1 = rig.len[la];
    const minD = Math.sqrt(a1 * a1 + b1 * b1 - 2 * a1 * b1 * Math.cos(o.elbowMinInterior));
    let r = solveTwoBoneInto(st.tb, A, tPos, a1, b1, pole, M.qRotate(Duc, M.v3(sgn, -1, 0)), minD);
    // torso avoidance: if the elbow ends up inside the torso, swing it about the shoulder->wrist axis
    // (both ways, 10 deg steps) to the nearest outside position
    if (o.collision && insideTorso(st.torso, H, W, P, r.mid, o.elbowRadius)) {
      for (let step = 1; step <= 18; step++) {
        let hit = false;
        for (let dir = 1; dir >= -1; dir -= 2) {
          const prp = M.qRotate(M.qAxisAngle(r.dir, dir * step * 10 * D), r.pole);
          const r2 = solveTwoBoneInto(st.tb2, A, tPos, a1, b1, prp, prp, minD);
          if (!insideTorso(st.torso, H, W, P, r2.mid, o.elbowRadius)) { hit = true; break; }
        }
        if (hit) { const tmp = st.tb; st.tb = st.tb2; st.tb2 = tmp; r = st.tb; M.set3(st.pole[sd], r.pole); break; }
      }
    }
    const Dua = M.qAlignFrames(rig.dir[ua], rig.axes[la], M.vNorm(M.vSub(r.mid, A)), r.bendNormal);
    let Dla = M.qMul(M.qFromTo(M.qRotate(Dua, rig.dir[la]), M.vNorm(M.vSub(r.end, r.mid))), Dua);
    // hand twist relative to the forearm, unwrapped against last frame, partly taken by the forearm
    const rel = M.qMul(M.qConj(Dla), Dhand);
    let tw = M.twistAngle(rel, rig.dir[la]);
    // unwrap against last frame's UNCLAMPED twist and never wrap it back: unwrapping against the clamped value
    // flipped the hand ~180 deg once the real twist went 180 deg past the limit (review finding), and wrapping
    // flips the forearm instead. Past the limit the hand stays at the limit until the user turns back; the
    // unwrapped value is re-seeded when the hand is (re)acquired and bounded to one extra turn.
    if (st.twFresh[sd]) { st.twU[sd] = tw; st.twFresh[sd] = false; }
    const prev = st.twU[sd];
    while (tw - prev > Math.PI) tw -= 2 * Math.PI;
    while (tw - prev < -Math.PI) tw += 2 * Math.PI;
    if (tw > o.twistMax + 2 * Math.PI) tw -= 2 * Math.PI; else if (tw < -o.twistMax - 2 * Math.PI) tw += 2 * Math.PI;
    st.twU[sd] = tw;
    tw = M.clamp(tw, -o.twistMax, o.twistMax);
    st.tw[sd] = tw;
    Dla = M.qMul(Dla, M.qAxisAngle(rig.dir[la], tw * o.forearmTwist));
    // wrist swing limit (relative to the forearm), keeps broken tracking from folding the wrist
    // swing-twist split of the hand relative to the twisted forearm: the swing is limited, the remaining twist
    // comes from the UNWRAPPED, clamped angle above (continuous) - not from the raw quaternion, whose twist
    // wraps at 180 deg and used to flip the hand by ~130 deg in one frame (review finding)
    const rel2 = M.qMul(M.qConj(Dla), Dhand);
    const twRaw = M.twistAngle(rel2, rig.dir[la]);
    let swing = M.qPos(M.qMul(rel2, M.qAxisAngle(rig.dir[la], -twRaw)));
    const ang = M.qAngleOf(swing), lim = o.wristMaxSwing + 30 * D;
    if (ang > lim) swing = M.qSlerp(ID, swing, lim / ang);
    const Dh2 = M.qNormalize(M.qMul(Dla, M.qMul(swing, M.qAxisAngle(rig.dir[la], tw * (1 - o.forearmTwist)))));
    M.set4(W[sh], Dsh); M.set4(W[ua], Dua); M.set4(W[la], Dla); M.set4(W[hn], Dh2);
    M.set3(P[sh], Psh); M.set3(P[ua], A); M.set3(P[la], r.mid); M.set3(P[hn], r.end);
    M.set3(st.prevSh[sd], A);
    info.reach = r.reach; info.clamped = r.clamped; info.tracked = valid; info.weight = w; info.held = !valid && w > 0.01 && last.ok;
    info.push = push; info.drift = M.vDist(r.end, info.target) * s;          // metres, world
    const fs = input.fingers && input.fingers[sd];
    fingerWorldDeltasInto(W, rig.hands[sd], sd, fs || null, Dh2);
  }
  st.hasSh = true;

  // ---- 8. output ----------------------------------------------------------------------------------------------
  worldToPoseInto(st, W);
  const out = res.pose.root;
  out[0] = 0; out[1] = pelvis[1] - H.hips[1]; out[2] = 0;
  const pos = M.vScale(M.qRotate(qPsi, M.v3(pelvis[0] - H.hips[0], 0, pelvis[2] - H.hips[2])), s);
  M.set3(res.rig.position, pos); res.rig.yaw = psi; res.rig.scale = s;
  dbg.lean = a; dbg.headFwd = headFwd; dbg.headSlack = headSlack; dbg.side = st.side; dbg.crouch = crouch; dbg.kneel = kneel; dbg.sit = sitW;
  dbg.hipDrop = hipDrop; dbg.speed = speed; dbg.headYaw = headYaw; dbg.pitch = pitch; dbg.steps = st.loco.steps;
  const lo = dbg.loco;
  lo.mode = st.aw > 0.5 ? 'air' : mw > 0.5 ? 'clips' : 'step'; lo.move = mw; lo.phase = st.clip ? st.clip.phase : 0; lo.air = st.air; lo.idle = idleW;
  return res;
}

/** Ankle target with the heel raised by h about the ball of the foot (pooled). */
function heelAt(fp, fwd, FL, ankleH, h) {
  return M.v3(fp[0] - fwd[0] * FL * (1 - Math.cos(h)), ankleH + FL * Math.sin(h) * 0.85, fp[2] - fwd[2] * FL * (1 - Math.cos(h)));
}

/** Ankle for a ball of the foot at L (on the floor plane) with the clip foot Qc pitched up by an extra h
 *  about the foot's lateral axis (yaw cfy); the ankle never goes below y0 (the clip's own ankle height). */
function ballAnkle(L, cfy, h, Qc, Hto, Hfo, y0) {
  const Q = M.qMul(M.qMul(M.ry(cfy), M.rx(h)), M.qMul(M.ry(-cfy), Qc));
  const t = M.qRotate(Q, M.vSub(Hto, Hfo));
  return M.v3(L[0] - t[0], Math.max(y0, Hto[1] - t[1]), L[2] - t[2]);
}

/** In-place worldToPose: parent-relative joints from the world deltas W (all canonical joints present). */
function worldToPoseInto(st, W) {
  const J = st.joints;
  for (let i = 0; i < N_JOINTS; i++) {
    const n = J_NAME[i], p = J_PARENT[i];
    const dp = p ? W[p] : ID, w = W[n], q = J[n];
    const ax = -dp[0], ay = -dp[1], az = -dp[2], aw = dp[3], bx = w[0], by = w[1], bz = w[2], bw = w[3];
    q[0] = aw * bx + ax * bw + ay * bz - az * by; q[1] = aw * by - ax * bz + ay * bw + az * bx;
    q[2] = aw * bz + ax * by - ay * bx + az * bw; q[3] = aw * bw - ax * bx - ay * by - az * bz;
  }
}

/** Y-frame point -> world (for tests/debug). */
export function yToWorld(result, pY) {
  const { yaw, scale } = result.rig;
  const c = Math.cos(yaw), s = Math.sin(yaw);
  return [(c * pY[0] + s * pY[2]) * scale, pY[1] * scale, (-s * pY[0] + c * pY[2]) * scale];
}

export { resetFeet, X0 };
