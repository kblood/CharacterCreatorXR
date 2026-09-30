// Planar mirror with a correct per-eye (stereo) reflection. For every eye:
//   virtual eye E' = E reflected in the mirror plane; the scene is rendered from E' through the mirror rectangle
//   with an off-axis (Kooima "generalized perspective") frustum whose near plane IS the mirror plane, so nothing
//   behind the mirror can show up (the same effect as oblique near-plane clipping) and no geometry is mirrored
//   (no winding flip). Seen from behind, the rectangle is left-right swapped, so the mirror surface samples the
//   image at u' = 1 - u.
// Stereo: one render target per eye; the left-eye surface is on layer 1 (only the XR left camera renders it),
// the right-eye surface on layer 2; a mono surface (layer 3) is used outside XR. Cost: one extra scene render
// per eye per frame (docs/DEVICE_NOTES.md has the numbers). docs/IK.md is unrelated; see README "Mirror".
import * as THREE from 'three';
import { LAYERS } from './avatar.js';

export const MIRROR_QUALITY = {
  high: { stereo: true, size: 1024, samples: 4, every: 1 },
  medium: { stereo: true, size: 768, samples: 0, every: 1 },
  low: { stereo: false, size: 512, samples: 0, every: 2 },
};

export function createMirror({ renderer, scene, width, height, quality = 'high', name = 'Mirror', tint = 0.93 }) {
  let Q = MIRROR_QUALITY[quality] || MIRROR_QUALITY.high;
  const group = new THREE.Group(); group.name = name;
  const geo = new THREE.PlaneGeometry(width, height);
  const uv = geo.attributes.uv;
  for (let i = 0; i < uv.count; i++) uv.setX(i, 1 - uv.getX(i));          // seen from behind: left-right swapped
  const halfFloat = renderer.capabilities.isWebGL2 && renderer.extensions.has('EXT_color_buffer_half_float');
  const makeRT = () => {
    const aspect = width / height;
    const h = Q.size, w = Math.max(64, Math.round(Q.size * aspect));
    return new THREE.WebGLRenderTarget(w, h, { type: halfFloat ? THREE.HalfFloatType : THREE.UnsignedByteType, samples: Q.samples, colorSpace: THREE.LinearSRGBColorSpace });
  };
  const rts = { L: null, R: null, M: null };
  const mats = { L: null, R: null, M: null };
  const meshes = {};
  for (const [k, layer] of [['L', LAYERS.EYE_L], ['R', LAYERS.EYE_R], ['M', LAYERS.MONO]]) {
    mats[k] = new THREE.MeshBasicMaterial({ color: new THREE.Color(tint, tint, tint) });
    const m = new THREE.Mesh(geo, mats[k]);
    m.layers.set(layer); m.name = `${name}_${k}`; m.frustumCulled = false;
    group.add(m); meshes[k] = m;
  }
  function allocate() {
    for (const k of ['L', 'R', 'M']) rts[k]?.dispose();
    rts.M = makeRT();
    rts.L = Q.stereo ? makeRT() : null;
    rts.R = Q.stereo ? makeRT() : null;
    mats.M.map = rts.M.texture;
    mats.L.map = (rts.L || rts.M).texture;
    mats.R.map = (rts.R || rts.M).texture;
    for (const k of ['L', 'R', 'M']) mats[k].needsUpdate = true;
  }
  allocate();

  const cam = new THREE.PerspectiveCamera();
  cam.matrixAutoUpdate = false; cam.matrixWorldAutoUpdate = false;
  cam.layers.disableAll(); cam.layers.enable(LAYERS.MAIN); cam.layers.enable(LAYERS.HEAD);

  const pa = new THREE.Vector3(), pb = new THREE.Vector3(), pc = new THREE.Vector3(), n = new THREE.Vector3();
  const vr = new THREE.Vector3(), vu = new THREE.Vector3(), vn = new THREE.Vector3(), ve = new THREE.Vector3();
  const va = new THREE.Vector3(), vb = new THREE.Vector3(), vc = new THREE.Vector3(), tmp = new THREE.Vector3();
  const pav = new THREE.Vector3(), pbv = new THREE.Vector3(), pcv = new THREE.Vector3();
  const M = new THREE.Matrix4();
  let frame = 0, enabled = true;
  const stats = { renders: 0, ms: 0, skipped: 0 };

  /** Set up cam for eye E (world). Returns false when the eye is behind the mirror. */
  function setupCamera(E) {
    const mw = group.matrixWorld;
    pa.set(-width / 2, -height / 2, 0).applyMatrix4(mw);
    pb.set(width / 2, -height / 2, 0).applyMatrix4(mw);
    pc.set(-width / 2, height / 2, 0).applyMatrix4(mw);
    n.set(0, 0, 1).transformDirection(mw);
    const d = tmp.subVectors(E, pa).dot(n);
    if (d < 0.01) return false;
    ve.copy(E).addScaledVector(n, -2 * d);                  // reflected eye
    // screen as seen from behind: corners swapped left/right
    pav.copy(pb); pbv.copy(pa); pcv.copy(pb).add(tmp.subVectors(pc, pa));
    vr.subVectors(pbv, pav).normalize(); vu.subVectors(pcv, pav).normalize(); vn.crossVectors(vr, vu).normalize();
    va.subVectors(pav, ve); vb.subVectors(pbv, ve); vc.subVectors(pcv, ve);
    const dist = -va.dot(vn);
    const near = Math.max(0.01, dist), far = 40;
    const k = near / dist;
    const l = vr.dot(va) * k, r = vr.dot(vb) * k, b = vu.dot(va) * k, t = vu.dot(vc) * k;
    cam.projectionMatrix.makePerspective(l, r, t, b, near, far);
    cam.projectionMatrixInverse.copy(cam.projectionMatrix).invert();
    M.makeBasis(vr, vu, vn).setPosition(ve);
    cam.matrix.copy(M); cam.matrixWorld.copy(M); cam.matrixWorldInverse.copy(M).invert();
    cam.near = near; cam.far = far;
    return true;
  }

  function renderTo(rt, E) {
    if (!setupCamera(E)) { stats.skipped++; return; }
    renderer.setRenderTarget(rt);
    renderer.clear();
    renderer.render(scene, cam);
    stats.renders++;
  }

  return {
    group, meshes, camera: cam, stats,
    get quality() { return Q; },
    setQuality(qn) { const nq = MIRROR_QUALITY[qn] || Q; if (nq !== Q) { Q = nq; allocate(); } },
    setEnabled(on) { enabled = !!on; group.visible = enabled; },
    get enabled() { return enabled; },
    /**
     * eyes: { L?: Vector3, R?: Vector3, M?: Vector3 } world eye positions for this frame. Call BEFORE the main
     * render (and with the avatar head visible). Handles xr.enabled / shadow auto-update / render target.
     */
    update(eyes) {
      if (!enabled) return;
      if (Q.every > 1 && (frame++ % Q.every) !== 0) return;
      const t0 = performance.now();
      const prevRT = renderer.getRenderTarget(), prevXR = renderer.xr.enabled, prevShadow = renderer.shadowMap.autoUpdate;
      renderer.xr.enabled = false; renderer.shadowMap.autoUpdate = false;
      scene.updateMatrixWorld();
      // three updates each skeleton once per info.render.frame; the shadow pass of the previous main render
      // runs after that counter was bumped, so the first mirror pass would otherwise reuse the bone matrices of
      // the collapsed first-person head. A fresh frame id forces skeleton.update() with the restored head.
      renderer.info.render.frame++;
      if (Q.stereo && eyes.L && eyes.R) { renderTo(rts.L, eyes.L); renderTo(rts.R, eyes.R); }
      const mono = eyes.M || (eyes.L && eyes.R ? tmp.clone().addVectors(eyes.L, eyes.R).multiplyScalar(0.5) : null);
      if (mono && (!Q.stereo || !(eyes.L && eyes.R))) renderTo(rts.M, mono);
      else if (mono && eyes.M) renderTo(rts.M, mono);
      renderer.setRenderTarget(prevRT);
      renderer.xr.enabled = prevXR; renderer.shadowMap.autoUpdate = prevShadow;
      stats.ms = stats.ms * 0.9 + (performance.now() - t0) * 0.1;
    },
    dispose() { for (const k of ['L', 'R', 'M']) rts[k]?.dispose(); geo.dispose(); },
  };
}
