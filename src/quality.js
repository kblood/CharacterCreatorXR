// SPDX-License-Identifier: GPL-3.0-or-later
// Quality: presets, automatic preset choice (user agent + GPU string + a short GPU benchmark) and an in-session
// auto-scaler that steps the knobs that can change while presenting (mirror, foveation, shadows, cloth rate)
// when frames are missed. Pure except gpuBenchmark(). docs/DEVICE_NOTES.md "Performance".
//
// Nothing here is a device fact: the GPU / UA patterns only pick a starting preset; the auto-scaler then reacts to
// what the device actually does (measured frame period vs the session's target frame rate).

export const PRESETS = {
  high: { skinUpgrade: true, shadows: true, shadowSize: 1024, mirror: 'high', framebufferScale: 1.0, foveation: 0.3, pixelRatio: 2, clothEvery: 1 },
  medium: { skinUpgrade: true, shadows: true, shadowSize: 512, mirror: 'medium', framebufferScale: 0.9, foveation: 0.6, pixelRatio: 1.5, clothEvery: 1 },
  low: { skinUpgrade: false, shadows: false, shadowSize: 256, mirror: 'low', framebufferScale: 0.8, foveation: 1, pixelRatio: 1, clothEvery: 2 },
};

/**
 * Starting preset: { name, reason }. ua = navigator.userAgent, gpu = unmasked renderer string (may be ''),
 * benchMs = gpuBenchmark() result (ms for the fixed workload; null = not run).
 */
export function pickPreset({ ua = '', gpu = '', benchMs = null } = {}) {
  const mobileXR = /OculusBrowser|Quest|Pico|Android|SteamOS/i.test(ua);
  const g = gpu.toLowerCase();
  // standalone headsets: Adreno 6xx class -> low, newer -> medium (refined by the benchmark)
  let name = mobileXR ? 'medium' : 'high', reason = mobileXR ? 'standalone / mobile browser' : 'desktop browser';
  // Qualcomm GPUs: 'Adreno (TM) 740' (Android browsers) or Mesa freedreno's 'FD740' naming (Linux browsers; which of
  // the two a Linux browser on a Snapdragon headset reports is unverified)
  const adreno = g.match(/adreno[^0-9]*(\d{3})/) || g.match(/\bfd(\d{3})\b/);
  if (adreno) {
    const n = +adreno[1];
    name = n < 700 ? 'low' : 'medium'; reason = `Adreno ${n}`;
  } else if (/swiftshader|llvmpipe|software|basic render/i.test(g)) { name = 'low'; reason = 'software renderer'; }
  else if (!mobileXR && /intel/i.test(g) && !/arc/i.test(g)) { name = 'medium'; reason = 'integrated GPU'; }
  if (benchMs != null && Number.isFinite(benchMs)) {
    // the workload takes ~2-4 ms on a desktop GPU; > 25 ms means a slow / software GPU
    if (benchMs > 25) { name = 'low'; reason += `, benchmark ${benchMs.toFixed(1)} ms`; }
    else if (benchMs > 9 && name === 'high') { name = 'medium'; reason += `, benchmark ${benchMs.toFixed(1)} ms`; }
    else reason += `, benchmark ${benchMs.toFixed(1)} ms`;
  }
  return { name, reason };
}

/** In-session levels, best first. Each changes only things that can change while presenting. */
export const LEVELS = [
  { mirror: 'high', foveation: 0.3, shadows: true, clothEvery: 1 },
  { mirror: 'medium', foveation: 0.5, shadows: true, clothEvery: 1 },
  { mirror: 'low', foveation: 0.7, shadows: true, clothEvery: 1 },
  { mirror: 'low', foveation: 1, shadows: false, clothEvery: 2 },
];
export const levelOfPreset = name => (name === 'high' ? 0 : name === 'medium' ? 1 : 3);

/**
 * Frame-period based auto-scaler with hysteresis. update(dtSeconds, targetHz) -> null | { level, dir, reason }.
 * Down: the average period over `downWindow` s is > 1.12 x the target period (frames are being missed).
 * Up: < 1.03 x target for `upWindow` s, and never sooner than `cooldown` s after the last change.
 * Spikes (dt > 0.25 s: loading, system UI) are ignored.
 */
export function createAutoScaler({ level = 0, min = 0, max = LEVELS.length - 1, downWindow = 1.5, upWindow = 10, cooldown = 4, enabled = true } = {}) {
  const st = { level, enabled, acc: 0, n: 0, t: 0, good: 0, since: cooldown, changes: 0 };
  return {
    state: st,
    get level() { return st.level; },
    set(level) { st.level = Math.max(min, Math.min(max, level)); st.acc = st.n = st.t = st.good = 0; st.since = 0; },
    update(dt, targetHz = 72) {
      if (!st.enabled || !(dt > 0) || dt > 0.25) return null;
      const T = 1 / (targetHz || 72);
      st.since += dt; st.t += dt; st.acc += dt; st.n++;
      st.good = dt < T * 1.03 * 1.5 && st.acc / st.n < T * 1.03 ? st.good + dt : 0;
      if (st.t >= downWindow) {
        const avg = st.acc / st.n;
        st.t = st.acc = st.n = 0;
        if (avg > T * 1.12 && st.level < max && st.since > 1) {
          st.level++; st.since = 0; st.good = 0; st.changes++;
          return { level: st.level, dir: -1, reason: `avg frame ${(avg * 1000).toFixed(1)} ms > ${(T * 1120).toFixed(1)} ms` };
        }
      }
      if (st.good >= upWindow && st.level > min && st.since > cooldown) {
        st.level--; st.since = 0; st.good = 0; st.changes++;
        return { level: st.level, dir: 1, reason: `${upWindow} s at target` };
      }
      return null;
    },
  };
}

/**
 * Short GPU benchmark (browser): renders a fixed fragment-heavy workload into an offscreen target and waits for
 * the GPU (readPixels). Returns ms (median of 3) or null. ~100-300 ms total; run once at boot, not in XR.
 */
export async function gpuBenchmark(THREE, renderer) {
  try {
    const rt = new THREE.WebGLRenderTarget(512, 512);
    const mat = new THREE.ShaderMaterial({
      vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy * 2.0, 0.0, 1.0); }',
      fragmentShader: `varying vec2 vUv; void main(){ vec3 c = vec3(0.0); vec2 p = vUv;
        for (int i = 0; i < 48; i++) { p = abs(p) / dot(p, p) - 0.7; c += vec3(p, length(p)) * 0.02; }
        gl_FragColor = vec4(c, 1.0); }`,
      depthTest: false, depthWrite: false,
    });
    const scene = new THREE.Scene(), cam = new THREE.Camera();
    const quad = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), mat); quad.frustumCulled = false;
    for (let i = 0; i < 8; i++) { const q = quad.clone(); scene.add(q); }
    const px = new Uint8Array(4), prev = renderer.getRenderTarget(), xr = renderer.xr.enabled;
    renderer.xr.enabled = false;
    const times = [];
    for (let k = 0; k < 4; k++) {
      const t0 = performance.now();
      renderer.setRenderTarget(rt); renderer.render(scene, cam);
      renderer.readRenderTargetPixels(rt, 0, 0, 1, 1, px);
      if (k > 0) times.push(performance.now() - t0);          // the first run compiles the shader
    }
    renderer.setRenderTarget(prev); renderer.xr.enabled = xr;
    rt.dispose(); mat.dispose(); quad.geometry.dispose();
    times.sort((a, b) => a - b);
    return times[1];
  } catch { return null; }
}

/** Unmasked GPU string when the browser exposes it ('' otherwise). */
export function gpuString(renderer) {
  try {
    const gl = renderer.getContext();
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    return String((ext && gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)) || gl.getParameter(gl.RENDERER) || '');
  } catch { return ''; }
}
