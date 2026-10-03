// SPDX-License-Identifier: GPL-3.0-or-later
// Ghost hands: when the avatar's hand cannot follow the tracked hand (blocked by the body collision, beyond the
// arm's reach, or a clamped wrist), a translucent hand at the TRACKED pose shows the user where their real hand
// is. Opacity follows the drift (IK result debug.arms[side].drift, metres): invisible below 3 cm, full at 8 cm.
// Own geometry (boxes + capsules), on the UI layer: the headset sees it, the mirror and photos do not.
import * as THREE from 'three';
import { LAYERS } from './avatar.js';

const FINGERS = [   // [x offset, length] in the hand frame (+Z fingers, +Y back of the hand, x toward the thumb side for the right hand)
  ['index', 0.025, 0.075], ['middle', 0.005, 0.082], ['ring', -0.015, 0.077], ['little', -0.033, 0.062],
];

function buildHand(side, mat) {
  const g = new THREE.Group(); g.name = `GhostHand_${side}`;
  const sx = side === 'right' ? 1 : -1;           // X = back x fingers: the right thumb is on +X, the left on -X
  const palm = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.025, 0.09), mat);
  palm.position.set(0, 0, 0.045);
  g.add(palm);
  const segs = [];
  for (const [name, x, len] of FINGERS) {
    const root = new THREE.Group(); root.position.set(x * sx, 0, 0.09);
    const a = new THREE.Mesh(new THREE.CapsuleGeometry(0.009, len * 0.45, 3, 8), mat);
    a.rotation.x = Math.PI / 2; a.position.z = len * 0.25;
    const mid = new THREE.Group(); mid.position.z = len * 0.5;
    const b = new THREE.Mesh(new THREE.CapsuleGeometry(0.008, len * 0.4, 3, 8), mat);
    b.rotation.x = Math.PI / 2; b.position.z = len * 0.22;
    mid.add(b); root.add(a, mid); g.add(root);
    segs.push({ name, root, mid });
  }
  const thumb = new THREE.Group(); thumb.position.set(0.04 * sx, -0.005, 0.02); thumb.rotation.y = 0.7 * sx;
  const tm = new THREE.Mesh(new THREE.CapsuleGeometry(0.01, 0.045, 3, 8), mat);
  tm.rotation.x = Math.PI / 2; tm.position.z = 0.03; thumb.add(tm); g.add(thumb);
  segs.push({ name: 'thumb', root: thumb, mid: null });
  g.traverse(o => { o.layers.set(LAYERS.UI); o.renderOrder = 4; });
  return { group: g, segs };
}

export function createGhostHands(scene, { on = 0.03, full = 0.08 } = {}) {
  const hands = {};
  for (const side of ['left', 'right']) {
    // depthTest off: the ghost is usually INSIDE the avatar's own body (that is why the avatar hand stopped), so it
    // is drawn through it (x-ray) - otherwise the body would hide exactly what it is meant to show
    const mat = new THREE.MeshBasicMaterial({ color: 0x9fd0ff, transparent: true, opacity: 0, depthWrite: false, depthTest: false, toneMapped: false });
    const h = buildHand(side, mat);
    h.mat = mat; h.group.visible = false; h.alpha = 0;
    scene.add(h.group);
    hands[side] = h;
  }
  const st = { enabled: true, shown: { left: false, right: false } };
  return {
    hands, state: st,
    setEnabled(v) { st.enabled = !!v; if (!v) for (const s in hands) hands[s].group.visible = false; },
    /** rec = tracking record, res = IK result, fingers = { left|right: FingerState }, dt. */
    update(rec, res, fingers, dt) {
      for (const side of ['left', 'right']) {
        const h = hands[side], tr = rec?.hands?.[side], info = res?.debug?.arms?.[side];
        const drift = st.enabled && tr?.valid && info?.tracked ? info.drift : 0;
        const target = Math.max(0, Math.min(1, (drift - on) / (full - on)));
        h.alpha += (target - h.alpha) * Math.min(1, dt / 0.08);
        const vis = h.alpha > 0.02 && !!tr?.valid;
        h.group.visible = vis; st.shown[side] = vis;
        if (!vis) continue;
        h.mat.opacity = 0.5 * h.alpha;
        h.group.position.fromArray(tr.pos); h.group.quaternion.fromArray(tr.quat);
        const fs = fingers?.[side];
        for (const s of h.segs) {
          const cap = s.name[0].toUpperCase() + s.name.slice(1);
          const c = fs?.[cap]?.curl ?? 0.15;
          if (s.mid) { s.root.rotation.x = c * 1.2; s.mid.rotation.x = c * 1.5; }
          else s.root.rotation.x = c * 0.6;
        }
      }
    },
  };
}
