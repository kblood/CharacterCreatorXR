// SPDX-License-Identifier: GPL-3.0-or-later
// Blob shadows: three soft dark discs (pelvis + both feet) on the floor, from a drawn radial gradient. They cost
// almost nothing, so they stay on at every quality level (the real shadow map is off on 'low'); they are on
// the MAIN layer, so the mirror shows them too. Fade with the height above the floor (jumping, lifted feet).
import * as THREE from 'three';

function gradientTexture(n = 64) {
  const c = document.createElement('canvas'); c.width = c.height = n;
  const g = c.getContext('2d'), gr = g.createRadialGradient(n / 2, n / 2, 0, n / 2, n / 2, n / 2);
  gr.addColorStop(0, 'rgba(0,0,0,1)'); gr.addColorStop(0.45, 'rgba(0,0,0,0.6)'); gr.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = gr; g.fillRect(0, 0, n, n);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.NoColorSpace;
  return t;
}

export function createBlobShadow(scene) {
  const tex = gradientTexture();
  const geo = new THREE.PlaneGeometry(1, 1); geo.rotateX(-Math.PI / 2);
  const make = (name, opacity) => {
    const m = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ map: tex, transparent: true, opacity, depthWrite: false, toneMapped: false }));
    m.name = name; m.renderOrder = 2; m.frustumCulled = false;
    scene.add(m);
    return m;
  };
  const body = make('BlobShadow', 0.35), feet = [make('BlobShadowL', 0.4), make('BlobShadowR', 0.4)];
  const st = { enabled: true };
  return {
    meshes: [body, ...feet],
    setEnabled(v) { st.enabled = !!v; for (const m of [body, ...feet]) m.visible = st.enabled; },
    /** pelvis = [x,y,z] world, feet = [[x,y,z],[x,y,z]] world ankle positions, s = avatar scale, floor = y. */
    update(pelvis, footPos, s = 1, floor = 0) {
      if (!st.enabled) return;
      const h = Math.max(0, pelvis[1] - floor);
      body.position.set(pelvis[0], floor + 0.004, pelvis[2]);
      const k = Math.max(0.35, 1 - Math.max(0, h - 0.9 * s) / (1.2 * s));
      body.scale.set(0.62 * s * (1.4 - 0.4 * k), 1, 0.5 * s * (1.4 - 0.4 * k));
      body.material.opacity = 0.32 * k;
      footPos.forEach((p, i) => {
        const m = feet[i], fh = Math.max(0, p[1] - floor - 0.07 * s);
        m.position.set(p[0], floor + 0.005, p[2]);
        const f = Math.max(0, 1 - fh / (0.35 * s));
        m.scale.set(0.2 * s, 1, 0.3 * s);
        m.material.opacity = 0.45 * f;
      });
    },
  };
}
