// SPDX-License-Identifier: GPL-3.0-or-later
// Runtime feature detection: reports exactly what THIS browser / runtime offers (no device names, no
// assumptions). probeRuntime() gathers a plain snapshot (browser), describeRuntime() turns it into rows for the UI
// and the diagnostics file (pure, unit-tested). Shown on the System tab and in diagnostics JSON. docs/DEVICE_NOTES.md.

/** Snapshot before / without a session (navigator.xr, WebGL). */
export async function probeRuntime(renderer) {
  const s = { time: new Date().toISOString(), ua: navigator.userAgent, secure: !!window.isSecureContext, xr: !!navigator.xr, modes: {}, gl: {}, session: null };
  if (navigator.xr) {
    for (const m of ['immersive-vr', 'immersive-ar', 'inline']) {
      try { s.modes[m] = await navigator.xr.isSessionSupported(m); } catch (e) { s.modes[m] = `error: ${e?.message || e}`; }
    }
  }
  try {
    const gl = renderer.getContext();
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    s.gl = {
      version: String(gl.getParameter(gl.VERSION)), renderer: ext ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)) : String(gl.getParameter(gl.RENDERER)),
      maxTexture: gl.getParameter(gl.MAX_TEXTURE_SIZE), maxSamples: gl.getParameter(gl.MAX_SAMPLES ?? 0x8D57) || null,
      multiview: !!(gl.getExtension('OCULUS_multiview') || gl.getExtension('OVR_multiview2')),
      halfFloatRT: !!gl.getExtension('EXT_color_buffer_half_float'), timerQuery: !!gl.getExtension('EXT_disjoint_timer_query_webgl2'),
    };
  } catch (e) { s.gl = { error: String(e?.message || e) }; }
  s.api = {
    XRWebGLBinding: typeof XRWebGLBinding !== 'undefined', XRMediaBinding: typeof XRMediaBinding !== 'undefined',
    XRHand: typeof XRHand !== 'undefined', vibrate: typeof navigator.vibrate === 'function', AudioContext: typeof (window.AudioContext || window.webkitAudioContext) !== 'undefined',
  };
  return s;
}

/** Add what an active session reports (call after the session started; inputs may arrive later - call again). */
export function probeSession(snapshot, session, renderer, info = {}) {
  const out = { ...snapshot };
  const src = [...(session?.inputSources || [])];
  let layer = null;
  try { layer = renderer.xr.getBaseLayer?.() || null; } catch { /* ignore */ }
  out.session = {
    enabledFeatures: (() => { try { return session.enabledFeatures ? [...session.enabledFeatures] : null; } catch { return null; } })(),
    refSpace: info.refSpace ?? null, blend: session?.environmentBlendMode ?? null, interaction: session?.interactionMode ?? null,
    visibility: session?.visibilityState ?? null, frameRate: session?.frameRate ?? null,
    supportedFrameRates: session?.supportedFrameRates ? [...session.supportedFrameRates] : null,
    fixedFoveation: layer && 'fixedFoveation' in layer ? layer.fixedFoveation : null,
    layerKind: layer ? layer.constructor?.name || 'layer' : null,
    depthNear: session?.renderState?.depthNear ?? null, depthFar: session?.renderState?.depthFar ?? null,
    inputs: src.map(s => ({
      handedness: s.handedness, mode: s.targetRayMode, profiles: [...(s.profiles || [])], hand: !!s.hand, handJoints: s.hand ? s.hand.size : 0,
      gamepad: s.gamepad ? { mapping: s.gamepad.mapping, buttons: s.gamepad.buttons.length, axes: s.gamepad.axes.length, haptics: s.gamepad.hapticActuators?.length ?? 0 } : null,
      grip: !!s.gripSpace,
    })),
  };
  return out;
}

const yn = v => (v === true ? 'yes' : v === false ? 'no' : v == null ? 'unknown' : String(v));

/** Rows [{ key, value, ok }] (ok: true = available, false = missing, null = informational). */
export function describeRuntime(s) {
  const rows = [];
  const add = (key, value, ok = null) => rows.push({ key, value: String(value), ok });
  if (!s) return rows;
  add('secure context', yn(s.secure), s.secure);
  add('navigator.xr', yn(s.xr), s.xr);
  for (const [m, v] of Object.entries(s.modes || {})) add(m, yn(v), v === true ? true : v === false ? false : null);
  if (s.gl?.renderer) add('GPU', s.gl.renderer);
  if (s.gl?.version) add('WebGL', s.gl.version);
  if (s.gl) { add('multiview ext', yn(s.gl.multiview), s.gl.multiview); add('max MSAA samples', s.gl.maxSamples ?? 'unknown'); }
  if (s.api) { add('XRWebGLBinding (layers API)', yn(s.api.XRWebGLBinding), s.api.XRWebGLBinding); add('XRHand', yn(s.api.XRHand), s.api.XRHand); }
  const ss = s.session;
  if (!ss) { add('session', 'not started'); return rows; }
  add('enabled features', ss.enabledFeatures ? ss.enabledFeatures.join(', ') || '(none)' : 'not reported');
  add('reference space', ss.refSpace ?? 'unknown', ss.refSpace ? true : false);
  add('blend mode', ss.blend ?? 'unknown');
  add('frame rate', ss.frameRate != null ? `${ss.frameRate} Hz` : 'not reported');
  add('supported frame rates', ss.supportedFrameRates?.length ? ss.supportedFrameRates.join(', ') : 'not exposed', !!ss.supportedFrameRates?.length);
  add('fixed foveation', ss.fixedFoveation != null ? ss.fixedFoveation.toFixed(2) : 'not exposed', ss.fixedFoveation != null);
  add('hand tracking (any input with .hand)', yn(ss.inputs?.some(i => i.hand)), ss.inputs?.some(i => i.hand));
  (ss.inputs || []).forEach((i, k) => {
    const g = i.gamepad;
    add(`input ${k} ${i.handedness}`, `${i.mode}; profiles ${i.profiles.join(' > ') || '-'}; ${i.hand ? `hand (${i.handJoints} joints)` : 'no hand'}; ${g ? `gamepad '${g.mapping}' ${g.buttons}b/${g.axes}a, haptics ${g.haptics}` : 'no gamepad'}`);
  });
  if (!ss.inputs?.length) add('inputs', 'none yet');
  return rows;
}
