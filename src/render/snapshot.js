// Offscreen render -> 2D canvas (thumbnails, photo mode). Works inside an XR session like the mirror does
// (xr.enabled off while rendering into the render target). three.js writes LINEAR colour into render targets,
// so the read-back pixels get the renderer's tone mapping (Khronos PBR Neutral, as renderer.toneMapping =
// NeutralToneMapping) and the sRGB transfer here, in JS, to match what the headset shows.
import * as THREE from 'three';
import { neutralToneMap, linearToSRGB } from './tonemap.js';
export { neutralToneMap, linearToSRGB };

/**
 * Render scene with camera into a w x h canvas. opts: { transparent (keep alpha, no background), background
 * (Color | null: override scene.background), samples }. Returns an HTMLCanvasElement (or OffscreenCanvas-like).
 */
export function renderToCanvas(renderer, scene, camera, w, h, opts = {}) {
  const half = renderer.capabilities.isWebGL2 && renderer.extensions.has('EXT_color_buffer_half_float');
  const rt = new THREE.WebGLRenderTarget(w, h, { type: half ? THREE.HalfFloatType : THREE.UnsignedByteType, samples: opts.samples ?? 4, colorSpace: THREE.LinearSRGBColorSpace });
  const prevRT = renderer.getRenderTarget(), prevXR = renderer.xr.enabled, prevShadow = renderer.shadowMap.autoUpdate;
  const prevBg = scene.background, prevClear = renderer.getClearAlpha(), prevColor = renderer.getClearColor(new THREE.Color());
  try {
    renderer.xr.enabled = false; renderer.shadowMap.autoUpdate = false;
    if (opts.transparent) { scene.background = null; renderer.setClearColor(0x000000, 0); }
    else if (opts.background !== undefined) scene.background = opts.background;
    renderer.info.render.frame++;                 // fresh skeleton update (see src/mirror.js)
    renderer.setRenderTarget(rt);
    renderer.clear();
    renderer.render(scene, camera);
    const n = w * h * 4;
    const buf = half ? new Uint16Array(n) : new Uint8Array(n);
    renderer.readRenderTargetPixels(rt, 0, 0, w, h, buf);
    const canvas = makeCanvas(w, h);
    const ctx = canvas.getContext('2d');
    const img = ctx.createImageData(w, h);
    const d = img.data, c = [0, 0, 0], exp = renderer.toneMappingExposure ?? 1;
    const tm = renderer.toneMapping === THREE.NeutralToneMapping;
    const from = half ? THREE.DataUtils.fromHalfFloat : v => v / 255;
    for (let y = 0; y < h; y++) {
      const src = (h - 1 - y) * w * 4, dst = y * w * 4;        // GL rows are bottom-up
      for (let x = 0; x < w * 4; x += 4) {
        c[0] = from(buf[src + x]); c[1] = from(buf[src + x + 1]); c[2] = from(buf[src + x + 2]);
        if (tm) neutralToneMap(c, exp);
        d[dst + x] = Math.round(255 * Math.min(1, Math.max(0, linearToSRGB(c[0]))));
        d[dst + x + 1] = Math.round(255 * Math.min(1, Math.max(0, linearToSRGB(c[1]))));
        d[dst + x + 2] = Math.round(255 * Math.min(1, Math.max(0, linearToSRGB(c[2]))));
        d[dst + x + 3] = opts.transparent ? Math.round(255 * Math.min(1, Math.max(0, from(buf[src + x + 3])))) : 255;
      }
    }
    ctx.putImageData(img, 0, 0);
    return canvas;
  } finally {
    renderer.setRenderTarget(prevRT);
    renderer.xr.enabled = prevXR; renderer.shadowMap.autoUpdate = prevShadow;
    scene.background = prevBg; renderer.setClearColor(prevColor, prevClear);
    rt.dispose();
  }
}

function makeCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return c;
}
