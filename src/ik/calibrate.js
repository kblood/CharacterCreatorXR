// SPDX-License-Identifier: GPL-3.0-or-later
// Height / arm calibration. Pure. docs/IK.md "Calibration".
// The avatar is fitted to the user in two steps: the CharacterCreator 'height' slider (a real body change, so the
// cloth colliders, proportions and sidecar joints stay consistent), then a uniform scale for the residual
// (only outside the slider range; the cloth colliders ignore the avatar scale, so the scale stays 1 when possible).
// Modes: 'morph' (slider, residual -> scale), 'scale' (uniform avatar scale), 'own' (the avatar keeps its own height;
// the user's world is scaled instead: src/main.js scales the camera rig and the tracking by avatarEye / userEye),
// 'off'.

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
  if (mode === 'off') return { height: current, scale: 1, worldScale: 1, avatarEye: eyeAt(current), mode, ok: true };
  if (mode === 'own') {
    // the avatar keeps its height; the user's tracked world is scaled so their eyes land on the avatar's eyes
    const avatarEye = eyeAt(current);
    return { height: current, scale: 1, worldScale: Math.min(maxScale, Math.max(minScale, avatarEye / userEye)), avatarEye, mode, ok: true };
  }
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
  return { height: +h.toFixed(4), scale, worldScale: 1, avatarEye, mode, ok: true };
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

/**
 * Automatic eye-height estimate while the user moves around freely (no explicit calibration):
 *  - only samples with a roughly level gaze (|pitch| < 0.35 rad), an upright head (|roll| < 0.3 rad) and a still
 *    head height (|vertical speed| < 0.2 m/s) count - looking down, tilting and bobbing lower the eyes;
 *  - the estimate is the median of the upper plateau (samples within `plateau` m of the 95th percentile): robust
 *    to crouching / sitting (below the plateau) and to the odd tip-toe or tracking spike (above the 95th pct);
 *  - stable = the plateau holds most of the recent samples (the user mostly stood) -> confidence 0..1.
 * push(eyeY, pitch, dt, { roll, vy }) ; estimate() -> eye | null ; result() -> { eye, confidence, n } | null.
 */
export function createHeightEstimator({ minSamples = 144, plateau = 0.06, max = 1800 } = {}) {
  const st = { samples: [], t: 0, lastY: null };
  const api = {
    push(eyeY, pitch, dt, extra = {}) {
      st.t += dt;
      const vy = extra.vy ?? (st.lastY != null && dt > 0 ? (eyeY - st.lastY) / dt : 0);
      st.lastY = eyeY;
      if (!(eyeY > 0.3 && eyeY < 2.6)) return;
      if (Math.abs(pitch) > 0.35 || Math.abs(extra.roll ?? 0) > 0.3 || Math.abs(vy) > 0.2) return;
      st.samples.push(eyeY);
      if (st.samples.length > max) st.samples.shift();
    },
    result() {
      const n = st.samples.length;
      if (n < minSamples) return null;
      const s = [...st.samples].sort((a, b) => a - b);
      const p95 = s[Math.min(n - 1, Math.floor(n * 0.95))];
      const top = s.filter(v => v >= p95 - plateau && v <= p95);
      const eye = top[Math.floor(top.length / 2)];
      return { eye, confidence: Math.min(1, top.length / (n * 0.5)), n };
    },
    /** Eye height (null until enough data). */
    estimate() { return api.result()?.eye ?? null; },
    reset() { st.samples.length = 0; st.t = 0; st.lastY = null; },
  };
  return api;
}

/** Typical eye height / body height of adults (anthropometric tables give ~0.93-0.94). */
export const EYE_TO_HEIGHT = 0.936;

/**
 * T-pose check for one tracking record: both wrists valid, about shoulder height (0.1-0.45 m below the eyes),
 * spread wide (> 1.0 m), the wrist-to-wrist line roughly horizontal (< 15 deg) and passing near the head.
 * Returns { ok, span, reason }.
 */
export function detectTPose(head, left, right) {
  if (!head || !left?.valid || !right?.valid) return { ok: false, reason: 'hands' };
  const e = head.pos[1], L = left.pos, Rp = right.pos;
  const dx = Rp[0] - L[0], dy = Rp[1] - L[1], dz = Rp[2] - L[2];
  const span = Math.hypot(dx, dy, dz), flat = Math.hypot(dx, dz);
  if (span < 1.0) return { ok: false, span, reason: 'span' };
  for (const p of [L, Rp]) if (e - p[1] < 0.1 || e - p[1] > 0.45) return { ok: false, span, reason: 'height' };
  if (Math.abs(Math.atan2(dy, flat)) > 15 * Math.PI / 180) return { ok: false, span, reason: 'tilt' };
  // distance of the head (xz) from the wrist line
  const hx = head.pos[0] - L[0], hz = head.pos[2] - L[2];
  const tt = Math.max(0, Math.min(1, (hx * dx + hz * dz) / (flat * flat || 1)));
  const off = Math.hypot(hx - dx * tt, hz - dz * tt);
  if (off > 0.3 || tt < 0.25 || tt > 0.75) return { ok: false, span, reason: 'centre' };
  return { ok: true, span };
}

/**
 * Explicit calibration flow (UI: "Calibrate" -> stand in a T-pose): countdown, then sampling; pure.
 * flow = createCalibrationFlow({ countdown, sample }); flow.start(); each frame flow.update(rec, dt) ->
 *   { phase: 'countdown'|'sample'|'done'|'failed'|'idle', left (s), result? }
 * result: { eye (median eye height), span (median T-pose wrist span or null), tposeFrames, frames, height (est.) }
 * The eye height alone is enough; the span needs >= 30 % T-pose frames.
 */
export function createCalibrationFlow({ countdown = 3, sample = 1.5 } = {}) {
  const st = { phase: 'idle', left: 0, eyes: [], spans: [], frames: 0, result: null, reason: '' };
  const median = a => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
  return {
    get state() { return st; },
    start() { Object.assign(st, { phase: 'countdown', left: countdown, eyes: [], spans: [], frames: 0, result: null, reason: '' }); return st; },
    cancel() { st.phase = 'idle'; },
    update(rec, dt) {
      if (st.phase === 'countdown') {
        st.left -= dt;
        if (st.left <= 0) { st.phase = 'sample'; st.left = sample; }
      } else if (st.phase === 'sample') {
        st.left -= dt;
        if (rec?.head && !rec.headLost) {
          st.frames++;
          st.eyes.push(rec.head.pos[1]);
          const tp = detectTPose(rec.head, rec.hands?.left, rec.hands?.right);
          if (tp.ok) st.spans.push(tp.span);
        }
        if (st.left <= 0) {
          if (st.eyes.length < 10) { st.phase = 'failed'; st.reason = 'tracking'; return st; }
          const eye = median(st.eyes);
          const spread = Math.max(...st.eyes) - Math.min(...st.eyes);
          if (spread > 0.08) { st.phase = 'failed'; st.reason = 'moved'; return st; }
          const span = st.spans.length >= Math.max(5, st.frames * 0.3) ? median(st.spans) : null;
          st.result = { eye, span, tposeFrames: st.spans.length, frames: st.frames, height: eye / EYE_TO_HEIGHT };
          st.phase = 'done';
        }
      }
      return st;
    },
  };
}
