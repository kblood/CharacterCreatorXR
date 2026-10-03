// SPDX-License-Identifier: GPL-3.0-or-later
// WebXR session start with generous optional features and graceful fallbacks. Nothing here is required except
// 'immersive-vr' itself: hand tracking, floor-level spaces, layers etc. are all optional and reported in the
// status panel (enabledFeatures when the browser exposes it, otherwise what was actually obtained).
export const OPTIONAL_FEATURES = ['local-floor', 'bounded-floor', 'hand-tracking', 'layers'];
const REF_SPACES = ['local-floor', 'bounded-floor', 'local'];

export async function xrSupport() {
  const out = { api: !!navigator.xr, secure: !!window.isSecureContext, vr: false, error: null };
  if (!out.api) return out;
  try { out.vr = await navigator.xr.isSessionSupported('immersive-vr'); } catch (e) { out.error = e?.message || String(e); }
  return out;
}

/**
 * Starts an immersive-vr session on the three.js renderer.
 * quality: { framebufferScale, foveation (0..1), frameRate (preferred) }.
 * Returns { session, info } where info lists what is active.
 */
export async function startSession(renderer, quality = {}, onEnd = () => {}) {
  const session = await navigator.xr.requestSession('immersive-vr', { optionalFeatures: OPTIONAL_FEATURES });
  const info = { features: null, refSpace: null, frameRate: null, supportedFrameRates: null, foveation: null, framebufferScale: null, blend: session.environmentBlendMode || null };
  try { info.features = session.enabledFeatures ? [...session.enabledFeatures] : null; } catch { /* older browsers */ }
  // first reference space type that works (Quest: local-floor; bounded-floor has had bugs, local as last resort)
  for (const type of REF_SPACES) {
    try { await session.requestReferenceSpace(type); info.refSpace = type; break; } catch { /* next */ }
  }
  renderer.xr.setReferenceSpaceType(info.refSpace || 'local');
  if (quality.framebufferScale) { renderer.xr.setFramebufferScaleFactor(quality.framebufferScale); info.framebufferScale = quality.framebufferScale; }
  session.addEventListener('end', onEnd);
  await renderer.xr.setSession(session);
  if (quality.foveation != null) {
    try { renderer.xr.setFoveation(quality.foveation); info.foveation = renderer.xr.getFoveation?.() ?? quality.foveation; } catch { info.foveation = 'unsupported'; }
  }
  // frame rate: Quest Browser exposes supportedFrameRates / updateTargetFrameRate
  try {
    const rates = session.supportedFrameRates ? [...session.supportedFrameRates] : null;
    info.supportedFrameRates = rates;
    if (rates?.length && session.updateTargetFrameRate) {
      const want = quality.frameRate || 90;
      const pick = rates.filter(r => r <= want).sort((a, b) => b - a)[0] || rates[0];
      await session.updateTargetFrameRate(pick);
      info.frameRate = pick;
    } else info.frameRate = session.frameRate ?? null;
  } catch (e) { info.frameRate = `error: ${e?.message || e}`; }
  if (!info.features) {
    // infer what we got
    info.features = [info.refSpace, ...[...session.inputSources].some(s => s.hand) ? ['hand-tracking(seen)'] : []].filter(Boolean);
    info.featuresInferred = true;
  }
  return { session, info };
}
