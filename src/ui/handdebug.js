// Hand-tracking debug skeleton: the raw XR joints (spheres + bones) of each tracked hand, drawn on the UI layer
// (not in the mirror). One InstancedMesh + one LineSegments, no per-frame allocations.
import * as THREE from 'three';
import { LAYERS } from '../avatar.js';
import { XR_JOINTS } from '../input/fingerInput.js';

const BONES = [];
{
  const idx = n => XR_JOINTS.indexOf(n);
  const chains = [['wrist', 'thumb-metacarpal', 'thumb-phalanx-proximal', 'thumb-phalanx-distal', 'thumb-tip']];
  for (const f of ['index', 'middle', 'ring', 'pinky']) chains.push(['wrist', ...['metacarpal', 'phalanx-proximal', 'phalanx-intermediate', 'phalanx-distal', 'tip'].map(s => `${f}-finger-${s}`)]);
  for (const c of chains) for (let i = 1; i < c.length; i++) BONES.push([idx(c[i - 1]), idx(c[i])]);
}

export function createHandDebug(scene) {
  const n = 50;
  const spheres = new THREE.InstancedMesh(new THREE.SphereGeometry(0.006, 8, 6), new THREE.MeshBasicMaterial({ color: 0x33ddff, depthTest: false, transparent: true, opacity: 0.85 }), n);
  spheres.layers.set(LAYERS.UI); spheres.frustumCulled = false; spheres.renderOrder = 10; spheres.count = 0;
  const pos = new Float32Array(BONES.length * 2 * 2 * 3);
  const lineGeo = new THREE.BufferGeometry(); lineGeo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  const lines = new THREE.LineSegments(lineGeo, new THREE.LineBasicMaterial({ color: 0xffcc33, depthTest: false, transparent: true }));
  lines.layers.set(LAYERS.UI); lines.frustumCulled = false; lines.renderOrder = 10;
  scene.add(spheres, lines);
  const m = new THREE.Matrix4();
  return {
    update(rec) {
      let k = 0, l = 0;
      if (rec) for (const snap of rec.snaps || []) {
        if (!snap.joints) continue;
        const J = XR_JOINTS.map(nm => snap.joints[nm]);
        for (const p of J) { if (p && k < n) { m.makeTranslation(p[0], p[1], p[2]); spheres.setMatrixAt(k++, m); } }
        for (const [a, b] of BONES) { if (!J[a] || !J[b] || l + 6 > pos.length) continue; pos.set(J[a], l); pos.set(J[b], l + 3); l += 6; }
      }
      spheres.count = k; spheres.instanceMatrix.needsUpdate = true;
      lineGeo.setDrawRange(0, l / 3); lineGeo.attributes.position.needsUpdate = true;
      spheres.visible = lines.visible = k > 0;
    },
  };
}
