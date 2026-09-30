// Height / arm calibration. Pure. docs/IK.md "Calibration".
// The avatar is fitted to the user in two steps: the CharacterCreator 'height' slider (a real body change, so the
// cloth colliders, proportions and sidecar joints stay consistent), then a uniform scale for the residual
// (only outside the slider range; the cloth colliders ignore the avatar scale, so the scale stays 1 when possible).

/**
 * samples: [{ h, eye }] avatar eye height (m, scale 1) for some 'height' slider values (e.g. h = -1, 0, 1),
 * userEye: measured eye height (m). mode: 'morph' (slider, then scale), 'scale' (scale only), 'off'.
 * Returns { height, scale, avatarEye, mode }.
 */
export function solveHeight(samples, userEye, { mode = 'morph', current = 0, minScale = 0.6, maxScale = 1.6 } = {}) {
  const pts = [...samples].filter(p => Number.isFinite(p.h) && Number.isFinite(p.eye)).sort((a, b) => a.h - b.h);
  const eyeAt = h => {
    if (!pts.length) return 1.553;
    if (h <= pts[0].h) return pts[0].eye;
    for (let i = 1; i < pts.length; i++) if (h <= pts[i].h) { const a = pts[i - 1], b = pts[i]; return a.eye + (b.eye - a.eye) * (h - a.h) / (b.h - a.h); }
    return pts[pts.length - 1].eye;
  };
  if (!(userEye > 0.3 && userEye < 3)) return { height: current, scale: 1, avatarEye: eyeAt(current), mode, ok: false };
  if (mode === 'off') return { height: current, scale: 1, avatarEye: eyeAt(current), mode, ok: true };
  let h = current;
  if (mode === 'morph' && pts.length >= 2) {
    // eye(h) is monotonic increasing: invert piecewise
    const lo = pts[0], hi = pts[pts.length - 1];
    if (userEye <= lo.eye) h = lo.h;
    else if (userEye >= hi.eye) h = hi.h;
    else for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1], b = pts[i];
      if (userEye <= b.eye) { h = a.h + (b.h - a.h) * (userEye - a.eye) / (b.eye - a.eye); break; }
    }
  }
  const avatarEye = eyeAt(h);
  const scale = Math.min(maxScale, Math.max(minScale, userEye / avatarEye));
  return { height: +h.toFixed(4), scale, avatarEye, mode, ok: true };
}

/**
 * Arm ratio from a T-pose: hands (wrist positions, world) and the avatar's wrist-to-wrist span at scale s.
 * Returns armScale for the proportional arm mode (avatar arm / user arm), clamped.
 */
export function solveArmScale(leftWrist, rightWrist, avatarSpan, s = 1, { min = 0.8, max = 1.25 } = {}) {
  const span = Math.hypot(leftWrist[0] - rightWrist[0], leftWrist[1] - rightWrist[1], leftWrist[2] - rightWrist[2]);
  if (!(span > 0.8)) return { ok: false, span, armScale: 1 };
  const r = (avatarSpan * s) / span;
  return { ok: true, span, armScale: Math.min(max, Math.max(min, r)) };
}

/** Auto estimate: a running maximum-ish of the head height while the user stands (robust to crouching). */
export function createHeightEstimator({ window = 4, minSamples = 90 } = {}) {
  const st = { samples: [], t: 0 };
  return {
    push(eyeY, pitch, dt) {
      st.t += dt;
      if (Math.abs(pitch) > 0.35) return;             // only while looking roughly level
      st.samples.push(eyeY);
      if (st.samples.length > 900) st.samples.shift();
    },
    /** 90th percentile of the level-gaze samples (null until enough data). */
    estimate() {
      if (st.samples.length < minSamples) return null;
      const s = [...st.samples].sort((a, b) => a - b);
      return s[Math.floor(s.length * 0.9)];
    },
    reset() { st.samples.length = 0; st.t = 0; },
  };
}
