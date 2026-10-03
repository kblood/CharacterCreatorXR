// SPDX-License-Identifier: GPL-3.0-or-later
// Per-frame tracking in one plain format for every source (XR, desktop simulation, replay):
//   { t, head: {pos, quat}, eyes: {L, R} | null, hands: { left|right: {pos, quat, valid, kind} },
//     snaps: [snapshotSource(...)], sources: [debug rows] }
// Hand pose convention (src/ik/rigdata.js handFrame): wrist position; quat +Z = wrist->middle knuckle (fingers),
// +Y = back of the hand. docs/HAND_TRACKING.md.
import { snapshotSource, XR_JOINTS } from '../input/fingerInput.js';
import { handFrame } from '../ik/rigdata.js';
import { qMul, qFromColumns, vAdd, vScale, qRotate } from '../ik/qx.js';
import { createPoseFilter, filterPose, resetPoseFilter } from '../ik/filters.js';

// Grip space (WebXR): origin in the fist, -Z toward the thumb along the handle, +X out of the back of the hand
// for the right hand (-X for the left). Hence fingers F = -Y, radial R = -Z, dorsal D = +-X.
// Our hand frame (+Z = F, +Y = D, X = D x F) expressed in grip coordinates:
const GRIP_TO_HAND = {
  right: qFromColumns([0, 0, -1], [1, 0, 0], [0, -1, 0]),
  left: qFromColumns([0, 0, 1], [-1, 0, 0], [0, -1, 0]),
};
// wrist joint relative to the grip origin, in our hand frame (m): behind the fist along -F, toward the back
export const GRIP_WRIST_OFFSET = [0, 0.018, -0.085];

const arr3 = p => [p.x, p.y, p.z];
const arr4 = q => [q.x, q.y, q.z, q.w];

/** Hand pose from a grip pose (arrays). */
export function handFromGrip(side, gripPos, gripQuat, offset = GRIP_WRIST_OFFSET) {
  const q = qMul(gripQuat, GRIP_TO_HAND[side]);
  return { pos: vAdd(gripPos, qRotate(q, offset)), quat: q };
}

/** Hand pose from XR hand joint positions (the wrist joint + knuckles define the frame, like the avatar's). */
export function handFromJoints(side, J) {
  const f = handFrame(side, J.wrist, J['index-finger-phalanx-proximal'], J['middle-finger-phalanx-proximal'], J['pinky-finger-phalanx-proximal']);
  return { pos: [...J.wrist], quat: f.q };
}

/**
 * opts: { gripOffset: () => [x,y,z] wrist offset from the grip origin in the hand frame (m),
 *         smoothHands: () => bool (One-Euro on hand-tracking wrist poses; controllers are not filtered) }
 */
export function createXRTracking(renderer, opts = {}) {
  const jointBuf = new Float32Array(16 * 25);
  const radiiBuf = new Float32Array(25);
  const filt = { left: createPoseFilter(), right: createPoseFilter() };
  const lastKind = { left: null, right: null };
  const last = { head: null, t: -1 };
  let t = 0;
  return {
    /** Viewer pose lost (tracking lost / system UI): the last head pose is kept and flagged. */
    get lastHead() { return last.head; },
    /** XR frame -> tracking record. Without a viewer pose the last head pose is returned with headLost = true. */
    read(frame, dt) {
      t += dt;
      const ref = renderer.xr.getReferenceSpace();
      const session = frame.session;
      const vp = frame.getViewerPose(ref);
      if (!vp) {
        if (!last.head) return null;
        return { t, head: last.head, eyes: null, hands: { left: { valid: false }, right: { valid: false } }, snaps: [], sources: [], headLost: true };
      }
      const head = { pos: arr3(vp.transform.position), quat: arr4(vp.transform.orientation), emulated: !!vp.emulatedPosition };
      last.head = head;
      const eyes = {};
      for (const v of vp.views) {
        const k = v.eye === 'left' ? 'L' : v.eye === 'right' ? 'R' : 'M';
        eyes[k] = arr3(v.transform.position);
      }
      const hands = { left: { valid: false }, right: { valid: false } };
      const snaps = [], sources = [];
      for (const src of session.inputSources) {
        const side = src.handedness;
        if (side !== 'left' && side !== 'right') { sources.push({ handedness: side, profiles: [...src.profiles], mode: src.targetRayMode }); continue; }
        let joints = null, hp = null;
        if (src.hand) {
          const spaces = XR_JOINTS.map(n => src.hand.get(n));
          let ok = spaces.every(Boolean);
          if (ok && frame.fillPoses) ok = frame.fillPoses(spaces, ref, jointBuf) && frame.fillJointRadii(spaces, radiiBuf);
          else if (ok) {
            for (let i = 0; i < 25 && ok; i++) {
              const p = frame.getJointPose(spaces[i], ref);
              if (!p) ok = false; else jointBuf.set(p.transform.matrix, i * 16);
            }
          }
          if (ok) {
            joints = {};
            XR_JOINTS.forEach((n, i) => { joints[n] = [jointBuf[i * 16 + 12], jointBuf[i * 16 + 13], jointBuf[i * 16 + 14]]; });
            hp = handFromJoints(side, joints);
          }
        }
        if (hp && opts.smoothHands?.() !== false) {
          if (lastKind[side] !== 'hand') resetPoseFilter(filt[side]);
          filterPose(filt[side], hp.pos, hp.quat, dt, hp);
        }
        if (!hp && src.gripSpace) {
          const p = frame.getPose(src.gripSpace, ref);
          if (p) hp = handFromGrip(side, arr3(p.transform.position), arr4(p.transform.orientation), opts.gripOffset?.() || GRIP_WRIST_OFFSET);
        }
        lastKind[side] = hp ? (joints ? 'hand' : 'controller') : null;
        let ray = null;
        if (src.targetRaySpace) {
          const p = frame.getPose(src.targetRaySpace, ref);
          if (p) ray = { pos: arr3(p.transform.position), quat: arr4(p.transform.orientation) };
        }
        const kind = src.hand ? 'hand' : 'controller';
        if (hp) hands[side] = { ...hp, valid: true, kind, ray };
        else hands[side] = { valid: false, kind, ray };
        const snap = snapshotSource(src, joints);
        snaps.push(snap);
        sources.push({
          handedness: side, profiles: [...src.profiles], mode: src.targetRayMode, hand: !!src.hand, handTracked: !!joints,
          gamepad: snap.gamepad ? { mapping: snap.gamepad.mapping, buttons: snap.gamepad.buttons.length, axes: snap.gamepad.axes.length } : null,
        });
      }
      return { t, head, eyes, hands, snaps, sources };
    },
  };
}

/** Pure helper for replays/tests: position + quaternion -> world matrix-less record copy. */
export const cloneRecord = r => JSON.parse(JSON.stringify(r));
export { vScale };
