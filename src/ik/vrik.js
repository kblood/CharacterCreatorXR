// VRIK-style full-body solve from 3 tracked points (head + 2 hands), written from scratch for this project
// (no code from VRIK / three-vrm / other projects). Pure, engine-agnostic (arrays); output is a canonical
// humanoid pose (vendor/cc/animation/canonical.js) + a placement for the avatar's parent object.
// Algorithm and limits: docs/IK.md.
//
// Frames: WORLD = XR reference space (metres). The avatar root object is placed at `rig.position`, rotated by
// `rig.yaw` about +Y and uniformly scaled by `rig.scale`. The solver works in the "yaw frame" Y:
//     pY = Ry(-psi) * (pWorld / s)        (scale-free, facing +Z)
// which is the character frame translated; so world deltas computed in Y are directly canonical deltas.
import { worldToPose } from '../../vendor/cc/animation/canonical.js';
import {
  clamp, smoothstep, wrapAngle, lp, ry, rx, rz, yawOf, twistAngle, qAlignFrames, qFrameZY, vReject, finite3, finite4,
  qMul, qConj, qNormalize, qRotate, qAxisAngle, qFromTo, qSlerp, qMirrorX, vDot, vCross, vNorm, vLen, vSub, vScale, vAdd, vLerp,
} from './qx.js';
import { solveTwoBone } from './twobone.js';
import { createLocomotion, stepLocomotion, resetFeet } from './locomotion.js';
import { fingerWorldDeltas } from './fingers.js';

const D = Math.PI / 180;
const SIDES = ['left', 'right'];
const SPINE = ['hips', 'spine', 'chest', 'upperChest', 'neck', 'head'];

export const VRIK_DEFAULTS = {
  yawTau: 0.45,              // s, body yaw low-pass
  yawMaxTwist: 55 * D,       // head-vs-body twist beyond this is followed hard
  handYawWeight: 0.35,       // how much the hands' direction steers the body yaw
  leanShares: [0.3, 0.55, 0.78, 1.0],          // cumulative forward/side bend at hips, spine, chest, upperChest
  twistShares: [0, 0.12, 0.25, 0.4],           // cumulative head-yaw twist at hips, spine, chest, upperChest
  neckShare: 0.45,           // neck takes this fraction of the remaining head rotation
  crouchLean: 38 * D,        // spine bend at a deep crouch
  pitchLeanStart: 25 * D, pitchLeanGain: 0.35,
  offsetLeanMax: 60 * D,     // bend from the head being ahead of the feet
  maxLean: 95 * D, minLean: -25 * D, maxSide: 20 * D,
  leanTau: 0.08,
  headBack: 0.0,             // extra metres the head joint sits behind the eyes (tuning)
  elbowMinInterior: 28 * D, kneeMinInterior: 30 * D,
  poleTau: 0.07,
  forearmTwist: 0.5,         // share of the hand's twist taken by the forearm
  armScale: 1,               // proportional arm mode: hand targets scaled about the shoulder (1 = hand-match)
  shrugMax: 18 * D, protractMax: 14 * D, retractMax: 8 * D,
  wristMaxSwing: 85 * D,
  torsoRX: 0.15, torsoRZ: 0.12, torsoCZ: -0.01,   // elbow keep-out ellipse around the spine (chest frame, m)
  kneelSide: 'right',        // which knee goes to the floor in a very deep crouch (null = never kneel)
  kneelAt: 0.34,             // pelvis height (ankle + legLength * this) where kneeling starts
  heightSlack: 0.05,         // m the avatar head may sit below the tracked head before the feet leave the floor
  comShift: 0.6,             // how far the feet move from under the pelvis toward under the head in a squat
  lostBlendTau: 0.25,        // s, blend to/from the relaxed arm when tracking is lost/regained
  locomotion: {},
};

/**
 * rig = prepareRig(heads) (src/ik/rigdata.js). Returns a solver: solve(input, dt) -> result.
 * input = { head: {pos:[x,y,z], quat:[x,y,z,w]} (viewer pose, world),
 *           hands: { left|right: {pos, quat, valid} } wrist position + hand frame (+Z fingers, +Y back of hand), world,
 *           fingers: { left|right: FingerState | null } (src/ik/fingers.js),
 *           scale: avatar uniform scale (default 1) }
 */
export function createVRIK(rig, opts = {}) {
  const o = { ...VRIK_DEFAULTS, ...opts };
  const st = {
    o, rig, psi: null, lean: 0, side: 0, prevHead: null, vel: [0, 0], loco: createLocomotion(rig, o.locomotion),
    pole: { left: null, right: null }, handW: { left: 0, right: 0 }, lastHand: { left: null, right: null },
    frames: 0,
  };
  return {
    state: st,
    solve: (input, dt) => solve(st, input, dt),
    reset: () => { st.psi = null; st.prevHead = null; st.loco.initialised = false; st.pole.left = st.pole.right = null; },
    setRig: r => { st.rig = r; st.loco = createLocomotion(r, o.locomotion); st.psi = null; },
    options: o,
  };
}

const toY = (psi, s, p) => qRotate(ry(-psi), vScale(p, 1 / s));
const qToY = (psi, q) => qMul(ry(-psi), q);

/** Relaxed arm target in the Y frame (arm hanging slightly forward) when a hand is not tracked. */
function relaxedHand(rig, side, shoulderPos, Dchest) {
  const sx = side === 'left' ? 1 : -1;
  const pos = vAdd(shoulderPos, qRotate(Dchest, [sx * 0.07, -rig.armLength * 0.93, 0.05]));
  // fingers down, back of the hand outward
  const q = qMul(Dchest, qFrameZY([0, -1, 0.08], [sx, 0, 0]));
  return { pos, quat: q };
}

function solve(st, input, dt) {
  const { o } = st;
  const rig = st.rig, H = rig.H;
  const s = input.scale > 0 ? input.scale : 1;
  dt = clamp(Number.isFinite(dt) ? dt : 0, 0, 0.1);
  const head = input.head;
  if (!head || !finite3(head.pos) || !finite4(head.quat)) return null;
  st.frames++;

  // ---- 1. body yaw ------------------------------------------------------------------------------------
  const camQ = qNormalize(head.quat);
  const f = qRotate(camQ, [0, 0, -1]), u = qRotate(camQ, [0, 1, 0]);
  let v = [f[0] + u[0] * -f[1], 0, f[2] + u[2] * -f[1]];
  // hands steer the yaw a bit when they are in front of the body
  let hv = [0, 0, 0], hn = 0;
  for (const side of SIDES) {
    const h = input.hands?.[side];
    if (!h?.valid || !finite3(h.pos)) continue;
    const d = vSub(h.pos, head.pos); d[1] = 0;
    if (vLen(d) > 0.12 * s && vDot(vNorm(d), vNorm(v)) > 0) { hv = vAdd(hv, vNorm(d)); hn++; }
  }
  if (hn) v = vAdd(vNorm(v), vScale(vNorm(hv), o.handYawWeight * hn / 2));
  const target = vLen(v) > 1e-6 ? yawOf(v) : (st.psi ?? 0);
  if (st.psi == null) st.psi = target;
  else {
    let e = wrapAngle(target - st.psi);
    st.psi = wrapAngle(st.psi + e * lp(dt, o.yawTau));
    e = wrapAngle(target - st.psi);
    if (Math.abs(e) > o.yawMaxTwist) st.psi = wrapAngle(st.psi + e - Math.sign(e) * o.yawMaxTwist);
  }
  const psi = st.psi;

  // ---- 2. head (Y frame) --------------------------------------------------------------------------------
  const Dh = qMul(qToY(psi, camQ), ry(Math.PI));            // avatar head faces +Z, the camera looks down -Z
  const eyeY = toY(psi, s, head.pos);
  const eyeOff = vAdd(rig.eyeOffset, [0, 0, o.headBack]);
  const Ht = vSub(eyeY, qRotate(Dh, eyeOff));                // head JOINT target

  // body velocity from the head (horizontal, world/s units), filtered
  if (st.prevHead && dt > 0) {
    const d = vScale(vSub(head.pos, st.prevHead), 1 / (s * dt));
    const k = lp(dt, 0.15);
    st.vel = [st.vel[0] + (d[0] - st.vel[0]) * k, st.vel[1] + (d[2] - st.vel[1]) * k];
  }
  st.prevHead = [...head.pos];

  // ---- 3. spine bend ------------------------------------------------------------------------------------
  const hf = qRotate(Dh, [0, 0, 1]);
  const pitch = Math.asin(clamp(-hf[1], -1, 1));             // + = looking down
  const headYaw = twistAngle(qNormalize(Dh), [0, 1, 0]);
  const standY = H.head[1];
  const crouch = clamp((standY - Ht[1]) / standY, 0, 1);
  // feet centre in the Y frame
  const feet = st.loco.feet;
  const fc = st.loco.initialised
    ? qRotate(ry(-psi), [(feet[0].pos[0] + feet[1].pos[0]) / 2, 0, (feet[0].pos[1] + feet[1].pos[1]) / 2])
    : [Ht[0], 0, Ht[2] - (H.head[2] - H.hips[2])];
  const restHeadAhead = H.head[2] - (rig.footZ[0] + rig.footZ[1]) / 2;
  const off = Ht[2] - fc[2] - restHeadAhead, offX = Ht[0] - fc[0];
  const speed = Math.hypot(st.vel[0], st.vel[1]);
  const moveFade = 1 - smoothstep(0.25, 0.6, speed);
  let lean = smoothstep(0.04, 0.45, crouch) * o.crouchLean
    + Math.max(0, pitch - o.pitchLeanStart) * o.pitchLeanGain + Math.min(0, pitch + 35 * D) * 0.3
    // head ahead of / behind the feet beyond a +-6 cm dead zone (continuous at the zone edges)
    + clamp(Math.asin(clamp((off > 0.06 ? off - 0.06 : off < -0.06 ? off + 0.06 : 0) / rig.torsoLen, -0.4, 0.95)), -10 * D, o.offsetLeanMax) * moveFade;
  lean = clamp(lean, o.minLean, o.maxLean);
  let side = clamp(-Math.asin(clamp((Math.abs(offX) > 0.05 ? offX - Math.sign(offX) * 0.05 : 0) / rig.torsoLen, -1, 1)), -o.maxSide, o.maxSide) * moveFade;
  const k = lp(dt, o.leanTau);
  st.lean = st.frames === 1 ? lean : st.lean + (lean - st.lean) * k;
  st.side = st.frames === 1 ? side : st.side + (side - st.side) * k;

  const spineDeltas = (a) => {
    const W = {};
    for (let i = 0; i < 4; i++) W[SPINE[i]] = qMul(qMul(rx(a * o.leanShares[i]), rz(st.side * o.leanShares[i])), ry(headYaw * o.twistShares[i]));
    W.neck = qSlerp(W.upperChest, Dh, o.neckShare);
    W.head = Dh;
    return W;
  };
  const chainVec = W => {                                     // hips joint -> head joint under deltas W
    let p = [0, 0, 0];
    for (let i = 1; i < SPINE.length; i++) p = vAdd(p, qRotate(W[SPINE[i - 1]], vSub(H[SPINE[i]], H[SPINE[i - 1]])));
    return p;
  };
  let a = st.lean, W = spineDeltas(a), pelvis = vSub(Ht, chainVec(W));
  // the pelvis must not sink through the floor: bend more (bisection on the lean)
  if (pelvis[1] < rig.minPelvisY) {
    let lo = a, hi = o.maxLean;
    for (let i = 0; i < 18; i++) {
      const m = (lo + hi) / 2, P = vSub(Ht, chainVec(spineDeltas(m)));
      if (P[1] < rig.minPelvisY) lo = m; else hi = m;
    }
    a = hi; W = spineDeltas(a); pelvis = vSub(Ht, chainVec(W));
    if (pelvis[1] < rig.minPelvisY) pelvis[1] = rig.minPelvisY;       // head lower than reachable: accept
  }
  // ...and must not rise above what straight legs allow: bending over lowers the head, so a head that stays
  // high cannot be bent over (bend less). If it is still too high with no bend, the feet leave the floor.
  const maxPelvisY = H.hips[1] + 0.01;
  if (pelvis[1] > maxPelvisY && a > 0) {
    let lo = 0, hi = a;
    if (vSub(Ht, chainVec(spineDeltas(0)))[1] > maxPelvisY) hi = 0;
    else for (let i = 0; i < 18; i++) {
      const m = (lo + hi) / 2;
      if (vSub(Ht, chainVec(spineDeltas(m)))[1] > maxPelvisY) hi = m; else lo = m;
    }
    a = lo; W = spineDeltas(a); pelvis = vSub(Ht, chainVec(W));
  }
  // A few cm too high is tracking/eye-model slack (e.g. looking far down pivots the modelled eyes about the
  // head joint): keep the feet down and let the avatar head sit slightly low. Beyond the slack: feet lift.
  let headSlack = 0;
  if (pelvis[1] > maxPelvisY) {
    const e = pelvis[1] - maxPelvisY, keep = Math.min(e, o.heightSlack);
    pelvis = [pelvis[0], pelvis[1] - keep, pelvis[2]]; headSlack = keep;
  }

  // ---- 4. positions of the upper body (Y frame) ------------------------------------------------------------
  const P = { hips: pelvis };
  for (let i = 1; i < SPINE.length; i++) P[SPINE[i]] = vAdd(P[SPINE[i - 1]], qRotate(W[SPINE[i - 1]], vSub(H[SPINE[i]], H[SPINE[i - 1]])));

  // ---- 5. legs ----------------------------------------------------------------------------------------------
  const pelvisW = qRotate(ry(psi), pelvis);                  // scale-free world
  const hipDrop = clamp((H.hips[1] - pelvis[1]) / rig.legLength, 0, 1);
  const kneelY = rig.ankleHeight + rig.legLength * o.kneelAt;
  const kneel = o.kneelSide ? smoothstep(kneelY + 0.03, kneelY - 0.1, pelvis[1]) : 0;
  // support point: under the pelvis when standing, toward under the head in a squat (centre of mass)
  const cw = smoothstep(0, 0.5, hipDrop) * o.comShift;
  const HtW = qRotate(ry(psi), Ht);
  const lf = stepLocomotion(st.loco, { ground: [pelvisW[0] + (HtW[0] - pelvisW[0]) * cw, pelvisW[2] + (HtW[2] - pelvisW[2]) * cw], yaw: psi, vel: st.vel, freeze: smoothstep(0.35, 0.5, hipDrop) }, dt);
  for (let i = 0; i < 2; i++) {
    const sd = SIDES[i];
    const ft = lf[i];
    const ul = `${sd}UpperLeg`, ll = `${sd}LowerLeg`, fo = `${sd}Foot`, to = `${sd}Toes`;
    const A = vAdd(pelvis, qRotate(W.hips, vSub(H[ul], H.hips)));
    const fy = wrapAngle(ft.yaw - psi);
    const fwd = qRotate(ry(fy), [0, 0, 1]);
    const fp = qRotate(ry(-psi), [ft.pos[0], 0, ft.pos[1]]);
    // heel lift for deep squats
    const heel = smoothstep(0.3, 0.6, hipDrop) * 28 * D;
    let T = [fp[0] - fwd[0] * rig.footLength * (1 - Math.cos(heel)), rig.ankleHeight + ft.lift + rig.footLength * Math.sin(heel) * 0.85, fp[2] - fwd[2] * rig.footLength * (1 - Math.cos(heel))];
    let footPitch = heel;
    const a1 = rig.len[ul], b1 = rig.len[ll];
    // toe-off: a planted foot behind a moving pelvis would be pulled off the floor by the stretched leg -
    // instead raise the heel about the ball of the foot (bisection on the extra heel angle, max 35 deg)
    const Lmax = (a1 + b1) * 0.999;
    if (ft.lift === 0 && vLen(vSub(T, A)) > Lmax) {
      const heelAt = h => [fp[0] - fwd[0] * rig.footLength * (1 - Math.cos(h)), rig.ankleHeight + rig.footLength * Math.sin(h) * 0.85, fp[2] - fwd[2] * rig.footLength * (1 - Math.cos(h))];
      let lo = heel, hi = Math.max(heel, 35 * D);
      if (vLen(vSub(heelAt(hi), A)) <= Lmax) {
        for (let j = 0; j < 14; j++) { const m = (lo + hi) / 2; if (vLen(vSub(heelAt(m), A)) > Lmax) lo = m; else hi = m; }
        footPitch = hi; T = heelAt(hi);
      } else { footPitch = hi; T = heelAt(hi); }
    }
    // kneel: this leg's knee to the floor, shin back along the floor, toes tucked
    const kw = sd === o.kneelSide ? kneel : 0;
    if (kw > 0) {
      const kneeH = 0.07, hy = A[1] - kneeH;
      const hd = Math.sqrt(Math.max(0, a1 * a1 - hy * hy)) * 0.9;
      const K = [A[0] + fwd[0] * hd, kneeH, A[2] + fwd[2] * hd];
      const Tk = [K[0] - fwd[0] * b1 * 0.97, kneeH + 0.035, K[2] - fwd[2] * b1 * 0.97];
      T = vLerp(T, Tk, kw);
      footPitch = footPitch + (70 * D - footPitch) * kw;
    }
    const pole = vAdd(fwd, [(i === 0 ? 1 : -1) * 0.12, 0, 0]);
    const minD = Math.sqrt(a1 * a1 + b1 * b1 - 2 * a1 * b1 * Math.cos(o.kneeMinInterior));
    const r = solveTwoBone(A, T, a1, b1, pole, fwd, { minD });
    const Dul = qAlignFrames(rig.dir[ul], rig.axes[ll], vNorm(vSub(r.mid, A)), r.bendNormal);
    const Dll = qMul(qFromTo(qRotate(Dul, rig.dir[ll]), vNorm(vSub(r.end, r.mid))), Dul);
    W[ul] = Dul; W[ll] = Dll;
    W[fo] = qMul(ry(fy), rx(footPitch));
    W[to] = qMul(ry(fy), rx(footPitch * (1 - 0.95)));
    P[ul] = A; P[ll] = r.mid; P[fo] = r.end;
  }

  // ---- 6. arms ------------------------------------------------------------------------------------------------
  const Duc = W.upperChest;
  const handDeltas = {};
  const armInfo = {};
  for (const sd of SIDES) {
    const sgn = sd === 'left' ? 1 : -1;
    const sh = `${sd}Shoulder`, ua = `${sd}UpperArm`, la = `${sd}LowerArm`, hn = `${sd}Hand`;
    const Psh = vAdd(P.upperChest, qRotate(Duc, vSub(H[sh], H.upperChest)));
    const A0 = vAdd(Psh, qRotate(Duc, vSub(H[ua], H[sh])));
    const inp = input.hands?.[sd];
    const valid = !!(inp?.valid && finite3(inp.pos) && finite4(inp.quat));
    st.handW[sd] = st.frames === 1 ? (valid ? 1 : 0) : st.handW[sd] + ((valid ? 1 : 0) - st.handW[sd]) * lp(dt, o.lostBlendTau);
    const relaxed = relaxedHand(rig, sd, A0, Duc);
    let tPos, tQ;
    if (valid) { tPos = toY(psi, s, inp.pos); tQ = qNormalize(qToY(psi, inp.quat)); st.lastHand[sd] = { pos: tPos, quat: tQ }; }
    else if (st.lastHand[sd] && st.handW[sd] > 0.01) { tPos = st.lastHand[sd].pos; tQ = st.lastHand[sd].quat; }
    else { tPos = relaxed.pos; tQ = relaxed.quat; }
    const w = st.handW[sd];
    tPos = vLerp(relaxed.pos, tPos, w); tQ = qSlerp(relaxed.quat, tQ, w);
    if (o.armScale !== 1) tPos = vAdd(A0, vScale(vSub(tPos, A0), o.armScale));

    // clavicle: shrug with elevation, protract with forward reach (chest frame)
    const loc = qRotate(qConj(Duc), vSub(tPos, A0));
    const e = loc[1] / rig.armLength, fw = loc[2] / rig.armLength, across = -sgn * loc[0] / rig.armLength;
    const shrug = smoothstep(0.05, 0.9, e) * o.shrugMax;
    const prot = smoothstep(0.35, 1.0, fw) * o.protractMax + smoothstep(0.0, 0.6, across) * o.protractMax * 0.6 - smoothstep(-0.1, -0.6, fw) * o.retractMax;
    let Qsh = qMul(rz(shrug), ry(-prot));                    // left-side convention
    if (sd === 'right') Qsh = qMirrorX(Qsh);
    const Dsh = qMul(Duc, Qsh);
    const A = vAdd(Psh, qRotate(Dsh, vSub(H[ua], H[sh])));

    // elbow pole: down/out/back in the chest frame, nudged by the hand's ulnar side; never across the torso
    const Dhand = qMul(tQ, qConj(rig.hands[sd].frame.q));
    const ulnar = vScale(qRotate(Dhand, rig.hands[sd].frame.R), -1);   // little-finger side of the tracked hand
    let pc = vAdd(vNorm([sgn * 0.55, -1, -0.3]), vScale(qRotate(qConj(Duc), ulnar), 0.35));
    if (pc[0] * sgn < 0.15) pc[0] = sgn * 0.15;
    let pole = qRotate(Duc, vNorm(pc));
    if (st.pole[sd] && dt > 0) pole = vNorm(vLerp(st.pole[sd], pole, lp(dt, o.poleTau)));
    st.pole[sd] = pole;

    const a1 = rig.len[ua], b1 = rig.len[la];
    const minD = Math.sqrt(a1 * a1 + b1 * b1 - 2 * a1 * b1 * Math.cos(o.elbowMinInterior));
    let r = solveTwoBone(A, tPos, a1, b1, pole, qRotate(Duc, [sgn, -1, 0]), { minD });
    // torso avoidance: if the elbow ends up inside the chest/belly volume, swing it about the shoulder->wrist
    // axis (both ways, 10 deg steps) to the nearest outside position
    const inside = m => {
      const l = qRotate(qConj(Duc), vSub(m, P.upperChest));
      if (l[1] > 0.12 || l[1] < -0.45) return false;
      const ex = l[0] / o.torsoRX, ez = (l[2] - o.torsoCZ) / o.torsoRZ;
      return ex * ex + ez * ez < 1;
    };
    if (inside(r.mid)) {
      for (let step = 1; step <= 18; step++) {
        let hit = null;
        for (const dir of [1, -1]) {
          const pr = qRotate(qAxisAngle(r.dir, dir * step * 10 * D), r.pole);
          const r2 = solveTwoBone(A, tPos, a1, b1, pr, pr, { minD });
          if (!inside(r2.mid)) { hit = r2; break; }
        }
        if (hit) { r = hit; st.pole[sd] = r.pole; break; }
      }
    }
    const Dua = qAlignFrames(rig.dir[ua], rig.axes[la], vNorm(vSub(r.mid, A)), r.bendNormal);
    let Dla = qMul(qFromTo(qRotate(Dua, rig.dir[la]), vNorm(vSub(r.end, r.mid))), Dua);
    // hand twist relative to the forearm, partly taken by the forearm
    const rel = qMul(qConj(Dla), Dhand);
    const tw = twistAngle(rel, rig.dir[la]);
    Dla = qMul(Dla, qAxisAngle(rig.dir[la], tw * o.forearmTwist));
    // wrist swing limit (relative to the forearm), keeps broken tracking from folding the wrist
    let Dh2 = Dhand;
    const relS = qMul(qConj(Dla), Dhand);
    const ang = 2 * Math.acos(clamp(Math.abs(relS[3]), 0, 1));
    if (ang > o.wristMaxSwing + 30 * D) Dh2 = qMul(Dla, qSlerp([0, 0, 0, 1], relS[3] < 0 ? relS.map(x => -x) : relS, (o.wristMaxSwing + 30 * D) / ang));
    W[sh] = Dsh; W[ua] = Dua; W[la] = Dla; W[hn] = Dh2;
    P[sh] = Psh; P[ua] = A; P[la] = r.mid; P[hn] = r.end;
    handDeltas[sd] = Dh2;
    armInfo[sd] = { reach: r.reach, clamped: r.clamped, target: tPos, tracked: valid, weight: w };
    const fs = input.fingers?.[sd];
    if (fs) Object.assign(W, fingerWorldDeltas(rig.hands[sd], sd, fs, Dh2));
  }

  // ---- 7. output ----------------------------------------------------------------------------------------------
  const joints = worldToPose(W);
  const root = [0, pelvis[1] - H.hips[1], 0];
  const originY = [pelvis[0] - H.hips[0], 0, pelvis[2] - H.hips[2]];
  const position = vScale(qRotate(ry(psi), originY), s);
  return {
    pose: { joints, root },
    world: W, positions: P,
    rig: { position, yaw: psi, scale: s },
    debug: { lean: a, headSlack, side: st.side, crouch, kneel, hipDrop, speed, headYaw, pitch, arms: armInfo, feet: lf.map(x => ({ pos: x.pos, lift: x.lift, stepping: x.stepping })), steps: st.loco.steps },
  };
}

/** Y-frame point -> world (for tests/debug). */
export function yToWorld(result, pY) {
  const { yaw, scale } = result.rig;
  return vScale(qRotate(ry(yaw), pY), scale);
}

export { resetFeet };
