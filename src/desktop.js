// SPDX-License-Identifier: GPL-3.0-or-later
// Desktop fallback (no headset): mouse look + WASD, simulated hands and fingers, producing the same tracking
// record as XR. Keys: W/A/S/D move, C crouch, Space arms up, F reach forward, 1..4 finger poses
// (open / fist / point / pinch), left mouse = right trigger, right mouse = right grip, T third-person view.
import * as THREE from 'three';
import { qMul, qAxisAngle, qFrameZY, qRotate, vAdd } from './ik/qx.js';

const POSES = { 1: 'open', 2: 'fist', 3: 'point', 4: 'pinch' };

export function createDesktop({ dom, camera, getEyeHeight }) {
  const st = {
    yaw: 0, pitch: -0.12, pos: [0, 0, 0.6], keys: new Set(), drag: false, lx: 0, ly: 0,
    trigger: 0, grip: 0, pose: 'relaxed', third: false, orbitYaw: 0.5, orbitPitch: 0.1, orbitDist: 2.4, crouch: 0,
    enabled: true, t: 0,
  };
  const onKey = (e, down) => {
    if (e.target?.tagName === 'INPUT' || e.target?.tagName === 'SELECT') return;
    const k = e.key.toLowerCase();
    if (down) st.keys.add(k); else st.keys.delete(k);
    if (down && POSES[k]) st.pose = st.pose === POSES[k] ? 'relaxed' : POSES[k];
    if (down && k === 't') st.third = !st.third;
  };
  addEventListener('keydown', e => onKey(e, true));
  addEventListener('keyup', e => onKey(e, false));
  dom.addEventListener('pointerdown', e => {
    if (e.button === 0) st.trigger = 1; if (e.button === 2) st.grip = 1;
    if (e.button === 1 || e.shiftKey || st.third) { st.drag = true; st.lx = e.clientX; st.ly = e.clientY; }
  });
  addEventListener('pointerup', e => { if (e.button === 0) st.trigger = 0; if (e.button === 2) st.grip = 0; st.drag = false; });
  dom.addEventListener('contextmenu', e => e.preventDefault());
  dom.addEventListener('pointermove', e => {
    if (st.third) {
      if (!st.drag) return;
      st.orbitYaw -= (e.clientX - st.lx) * 0.005; st.orbitPitch = Math.max(-0.4, Math.min(1.2, st.orbitPitch + (e.clientY - st.ly) * 0.004));
      st.lx = e.clientX; st.ly = e.clientY; return;
    }
    // look: move the mouse with any button or shift; plain hover looks gently (so the hands stay usable)
    const r = dom.getBoundingClientRect();
    if (st.drag) { st.yaw -= (e.clientX - st.lx) * 0.004; st.pitch = Math.max(-1.3, Math.min(1.3, st.pitch - (e.clientY - st.ly) * 0.004)); st.lx = e.clientX; st.ly = e.clientY; }
    st.mx = (e.clientX - r.left) / r.width * 2 - 1; st.my = -((e.clientY - r.top) / r.height * 2 - 1);
  });
  dom.addEventListener('wheel', e => { if (st.third) st.orbitDist = Math.max(0.8, Math.min(6, st.orbitDist + e.deltaY * 0.002)); }, { passive: true });

  function fingerCurls() {
    const base = { relaxed: [0.15, 0.2, 0.25, 0.28, 0.3], open: [0, 0, 0, 0, 0], fist: [0.85, 1, 1, 1, 1], point: [0.9, 0, 1, 1, 1], pinch: [0.7, 0.75, 0.3, 0.25, 0.2] }[st.pose];
    const [thumb, index, middle, ring, little] = base;
    return { thumb, index: Math.max(index, st.trigger), middle: Math.max(middle, st.grip), ring: Math.max(ring, st.grip), little: Math.max(little, st.grip) };
  }

  return {
    state: st,
    get third() { return st.third; },
    /** Advance and return a tracking record (+ simulated finger curls per hand). */
    read(dt) {
      st.t += dt;
      const k = st.keys, sp = 1.4 * dt;
      const fx = -Math.sin(st.yaw), fz = -Math.cos(st.yaw);
      if (k.has('w')) { st.pos[0] += fx * sp; st.pos[2] += fz * sp; }
      if (k.has('s')) { st.pos[0] -= fx * sp; st.pos[2] -= fz * sp; }
      if (k.has('a')) { st.pos[0] += fz * sp; st.pos[2] -= fx * sp; }
      if (k.has('d')) { st.pos[0] -= fz * sp; st.pos[2] += fx * sp; }
      if (k.has('arrowleft')) st.yaw += 1.5 * dt;
      if (k.has('arrowright')) st.yaw -= 1.5 * dt;
      st.crouch += ((k.has('c') ? 1 : 0) - st.crouch) * Math.min(1, dt * 5);
      const eyeH = getEyeHeight() * (1 - 0.42 * st.crouch);
      const headPos = [st.pos[0], eyeH, st.pos[2]];
      const hq = qMul(qAxisAngle([0, 1, 0], st.yaw), qAxisAngle([1, 0, 0], st.pitch));
      // hands in the body (yaw) frame: x right, y up, z back
      const Y = qAxisAngle([0, 1, 0], st.yaw);
      const arms = k.has(' ') ? 'up' : k.has('f') ? 'forward' : 'rest';
      const hand = side => {
        const sx = side === 'right' ? 1 : -1;
        let p, F, D;
        if (arms === 'up') { p = [0.22 * sx, 0.28, 0.02]; F = [0, 1, 0]; D = [0, 0, 1]; }
        else if (arms === 'forward') { p = [0.16 * sx, -0.2, -0.5]; F = [0, 0, -1]; D = [0, 1, 0]; }
        else { p = [0.2 * sx, -0.5 + 0.2 * st.crouch, -0.28]; F = [0, -0.35, -1]; D = [sx * 0.6, 0.8, 0]; }
        const pos = vAdd(headPos, qRotate(Y, p));
        return { pos, quat: qMul(Y, qFrameZY(F, D)), valid: true, kind: 'desktop' };
      };
      const curls = fingerCurls();
      // snapshot of a pretend xr-standard controller so the finger layer runs its normal fallback path
      const pad = side => ({
        handedness: side, profiles: ['desktop-simulated'], targetRayMode: 'screen', hasHand: false, joints: null,
        gamepad: { mapping: 'xr-standard', buttons: [{ value: side === 'right' ? st.trigger : 0, touched: false, pressed: false }, { value: side === 'right' ? st.grip : 0, touched: false, pressed: false }], axes: [0, 0, 0, 0] },
      });
      return {
        t: st.t, head: { pos: headPos, quat: hq }, eyes: null,
        hands: { left: hand('left'), right: hand('right') }, snaps: [pad('left'), pad('right')],
        sources: [{ handedness: 'both', profiles: ['desktop-simulated'], mode: 'desktop' }],
        desktopCurls: curls,
      };
    },
    /** Camera placement: first person at the head, or an orbit around the avatar. */
    placeCamera(rec, target) {
      if (!st.third) {
        camera.position.fromArray(rec.head.pos);
        camera.quaternion.fromArray(rec.head.quat);
      } else {
        const c = target || new THREE.Vector3(0, 1, 0);
        camera.position.set(c.x + Math.sin(st.orbitYaw) * Math.cos(st.orbitPitch) * st.orbitDist, c.y + Math.sin(st.orbitPitch) * st.orbitDist, c.z + Math.cos(st.orbitYaw) * Math.cos(st.orbitPitch) * st.orbitDist);
        camera.lookAt(c);
      }
    },
  };
}
