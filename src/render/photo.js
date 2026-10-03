// SPDX-License-Identifier: GPL-3.0-or-later
// Photo mode: a "photographer" camera in front of the avatar (full body or portrait), rendered offscreen with
// the head visible (src/render/snapshot.js), returned as a canvas; download() saves a PNG. In XR the shot is
// taken after a countdown so the user can pose; the preview is shown on the board.
import * as THREE from 'three';
import { renderToCanvas } from './snapshot.js';
import { LAYERS } from '../avatar.js';

export function createPhoto({ renderer, scene, getAvatar }) {
  const cam = new THREE.PerspectiveCamera(32, 0.8, 0.05, 40);
  cam.layers.disableAll(); cam.layers.enable(LAYERS.MAIN); cam.layers.enable(LAYERS.HEAD);
  const head = new THREE.Vector3(), fwd = new THREE.Vector3(), target = new THREE.Vector3();
  return {
    camera: cam,
    /** framing: 'full' | 'portrait'. Returns a canvas. */
    take({ framing = 'full', width = 960, height = 1200 } = {}) {
      const av = getAvatar();
      av.root.updateMatrixWorld(true);
      av.headWorld(head);
      const s = av.root.scale.x || 1;
      fwd.set(0, 0, 1).applyQuaternion(av.root.quaternion); fwd.y = 0; fwd.normalize();
      cam.aspect = width / height;
      if (framing === 'portrait') {
        target.copy(head); target.y -= 0.12 * s;
        cam.position.copy(target).addScaledVector(fwd, 1.25 * s); cam.position.y += 0.05 * s;
      } else {
        const p = av.root.position;
        // feet to head + a margin on both ends (visual review: the old crop cut close at the head and feet)
        const top = head.y + 0.3 * s, bottom = p.y - 0.08 * s;
        target.set(p.x, (top + bottom) / 2, p.z);
        const dist = ((top - bottom) * 0.6) / Math.tan((cam.fov * Math.PI) / 360);
        cam.position.copy(target).addScaledVector(fwd, dist); cam.position.y = bottom + (top - bottom) * 0.55;
      }
      cam.updateProjectionMatrix();
      cam.lookAt(target); cam.updateMatrixWorld();
      av.hideHead(false);
      // the floor marker is a UI aid, not part of the picture (ghost hands / rays / panels are on the UI layer)
      const marker = scene.getObjectByName('FloorMarker'), was = marker?.visible;
      if (marker) marker.visible = false;
      try { return renderToCanvas(renderer, scene, cam, width, height, { samples: 4 }); }
      finally { if (marker) marker.visible = was; }
    },
    download(canvas, name = `ccxr-photo-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.png`) {
      return new Promise(resolve => {
        canvas.toBlob(blob => {
          if (!blob) return resolve(false);
          const url = URL.createObjectURL(blob);
          const a = Object.assign(document.createElement('a'), { href: url, download: name });
          document.body.append(a); a.click(); a.remove();
          setTimeout(() => URL.revokeObjectURL(url), 10000);
          resolve(name);
        }, 'image/png');
      });
    },
  };
}
