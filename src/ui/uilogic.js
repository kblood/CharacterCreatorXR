// SPDX-License-Identifier: GPL-3.0-or-later
// Pure UI logic (unit-tested): slider drag with a deadzone + release hysteresis, colour conversions for the hue
// ring, adaptive board placement and the two-palms-up recenter gesture. docs/UI.md.

// ---------------------------------------------------------------- slider drag
/**
 * Pinch / trigger sliders: pressing must not move the value (a pinch moves the ray a little when the fingers
 * close), and releasing must not either (the ray jumps when the fingers open). So:
 *  - deadzone: until the pointer moved `deadzone` px from the press point nothing changes; a press on the knob
 *    then drags relative to the knob (no jump), a press on the track jumps there once the deadzone is left;
 *  - a tap (press + release inside the deadzone, not on the knob) sets the tapped value;
 *  - release hysteresis: the committed value is the one from `releaseLag` ms before the release.
 * x in canvas px; track = { x, w, min, max, step }.
 */
export function createSliderDrag({ deadzone = 10, releaseLag = 90, knobRadius = 26 } = {}) {
  const st = { active: false, x0: 0, v0: 0, onKnob: false, moved: false, hist: [], value: 0 };
  const toValue = (track, x) => {
    let v = track.min + Math.max(0, Math.min(1, (x - track.x) / track.w)) * (track.max - track.min);
    if (track.step) v = Math.round(v / track.step) * track.step;
    return Math.max(track.min, Math.min(track.max, v));
  };
  const knobX = (track, v) => track.x + ((v - track.min) / (track.max - track.min)) * track.w;
  return {
    state: st,
    /** returns null (no change yet) */
    down(track, x, value, t) {
      Object.assign(st, { active: true, x0: x, v0: value, value, moved: false, onKnob: Math.abs(x - knobX(track, value)) <= knobRadius });
      st.hist.length = 0; st.hist.push([t, value]);
      return null;
    },
    /** returns the new value or null (unchanged / inside the deadzone) */
    move(track, x, t) {
      if (!st.active) return null;
      if (!st.moved && Math.abs(x - st.x0) < deadzone) return null;
      st.moved = true;
      let v;
      if (st.onKnob) {
        v = st.v0 + ((x - st.x0) / track.w) * (track.max - track.min);
        if (track.step) v = Math.round(v / track.step) * track.step;
        v = Math.max(track.min, Math.min(track.max, v));
      } else v = toValue(track, x);
      st.value = v;
      st.hist.push([t, v]);
      while (st.hist.length > 2 && st.hist[1][0] < t - 1000) st.hist.shift();
      return v;
    },
    /** final value (always a number) */
    up(track, x, t) {
      if (!st.active) return st.value;
      st.active = false;
      if (!st.moved) {
        if (st.onKnob || x == null) return st.v0;
        return (st.value = toValue(track, st.x0));
      }
      // last value at or before t - releaseLag (the fingers-opening jitter is dropped)
      let v = st.hist[0][1];
      for (const [ht, hv] of st.hist) if (ht <= t - releaseLag) v = hv;
      return (st.value = v);
    },
  };
}

// ---------------------------------------------------------------- colour
export function hsvToHex(h, s, v) {
  h = ((h % 360) + 360) % 360;
  const c = v * s, x = c * (1 - Math.abs(((h / 60) % 2) - 1)), m = v - c;
  const [r, g, b] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  const to = u => Math.round((u + m) * 255).toString(16).padStart(2, '0');
  return `#${to(r)}${to(g)}${to(b)}`;
}
export function hexToHsv(hex) {
  const n = parseInt(String(hex).replace('#', ''), 16);
  if (!Number.isFinite(n)) return { h: 0, s: 0, v: 0.5 };
  const r = ((n >> 16) & 255) / 255, g = ((n >> 8) & 255) / 255, b = (n & 255) / 255;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
  let h = 0;
  if (d > 0) h = mx === r ? 60 * (((g - b) / d) % 6) : mx === g ? 60 * ((b - r) / d + 2) : 60 * ((r - g) / d + 4);
  return { h: (h + 360) % 360, s: mx ? d / mx : 0, v: mx };
}
/**
 * Hue ring + saturation/value square picker geometry. (dx, dy) relative to the centre (px, y down).
 * Returns { part: 'ring', h } | { part: 'square', s, v } | null.
 */
export function pickColor(dx, dy, { rInner, rOuter, half }) {
  const r = Math.hypot(dx, dy);
  if (r >= rInner && r <= rOuter) return { part: 'ring', h: ((Math.atan2(dy, dx) * 180) / Math.PI + 450) % 360 };
  if (Math.abs(dx) <= half && Math.abs(dy) <= half) return { part: 'square', s: (dx + half) / (2 * half), v: 1 - (dy + half) / (2 * half) };
  return null;
}

// ---------------------------------------------------------------- placement
/**
 * Where the main board goes for a user: in front-right of the head (yaw only), `dist` away, its centre a bit
 * below the eyes, facing the user. With `mirror` ({ x, z, halfWidth }, a mirror on a plane z = const), the board
 * must not hide the mirror: both board edges are projected from the head onto the mirror plane, and the board
 * steps further out to the side (right first, then left) until the reflection is clear. head = { pos, quat }.
 * Returns { pos: [x,y,z], yaw, clear } (the board's +Z faces the user).
 */
export function boardPlacement(head, { eye = null, dist = 0.75, side = 0.38, drop = 0.3, mirror = null, halfWidth = 0.56, maxSide = 1.1 } = {}) {
  const [qx, qy, qz, qw] = head.quat;
  // forward = -Z rotated by the head, projected on the floor
  let fx = -(2 * (qx * qz + qw * qy)), fz = -(1 - 2 * (qx * qx + qy * qy));
  const fl = Math.hypot(fx, fz);
  if (fl < 0.3) { fx = 0; fz = -1; } else { fx /= fl; fz /= fl; }
  const rx = -fz, rz = fx;                                   // right of the forward direction
  const y = Math.max(0.85, Math.min(1.9, (eye ?? head.pos[1]) - drop));
  const at = sd => [head.pos[0] + fx * dist + rx * sd, head.pos[2] + fz * dist + rz * sd];
  // does the segment between the board edges hide any part of the mirror (seen from the head)?
  const blocks = (x, z) => {
    if (!mirror) return false;
    const hits = [];
    for (const e of [-1, 1]) {
      const ex = x + rx * halfWidth * e, ez = z + rz * halfWidth * e;
      const dz = ez - head.pos[2];
      const t = Math.abs(dz) < 1e-6 ? Infinity : (mirror.z - head.pos[2]) / dz;
      if (!(t > 1)) return false;                            // the mirror is not behind this edge
      hits.push(head.pos[0] + (ex - head.pos[0]) * t);
    }
    const lo = Math.min(hits[0], hits[1]), hi = Math.max(hits[0], hits[1]), pad = 0.08;
    return hi > mirror.x - mirror.halfWidth - pad && lo < mirror.x + mirror.halfWidth + pad;
  };
  let p = at(side), clear = !blocks(p[0], p[1]);
  for (let k = 1; !clear && side + 0.05 * k <= maxSide + 1e-9; k++) {
    for (const sg of [1, -1]) {
      const q = at(sg * (side + 0.05 * k));
      if (!blocks(q[0], q[1])) { p = q; clear = true; break; }
    }
  }
  if (!clear) p = at(side);
  const yaw = Math.atan2(head.pos[0] - p[0], head.pos[2] - p[1]);
  return { pos: [p[0], y, p[1]], yaw, clear };
}

/**
 * Recenter gesture: both palms up (palm normal pointing up), both hands in front of the chest and close
 * together, held for `hold` s -> fires once (re-arms when the pose is left). hands: { left, right } records
 * with pos / quat (our hand frame: +Y = back of the hand, so the palm normal is -Y).
 */
export function createRecenterGesture({ hold = 1.0 } = {}) {
  const st = { t: 0, fired: false, progress: 0 };
  const palmUp = h => { const [x, y, z, w] = h.quat; return -(1 - 2 * (x * x + z * z)); };   // -Y axis . world up
  return {
    state: st,
    update(head, hands, dt) {
      const L = hands?.left, R = hands?.right;
      let ok = !!(head && L?.valid && R?.valid);
      if (ok) {
        const dx = L.pos[0] - R.pos[0], dz = L.pos[2] - R.pos[2];
        ok = palmUp(L) > 0.75 && palmUp(R) > 0.75 && Math.hypot(dx, dz) < 0.45
          && L.pos[1] < head.pos[1] - 0.2 && R.pos[1] < head.pos[1] - 0.2 && L.pos[1] > head.pos[1] - 0.9;
      }
      if (!ok) { st.t = 0; st.fired = false; st.progress = 0; return false; }
      st.t += dt; st.progress = Math.min(1, st.t / hold);
      if (st.t >= hold && !st.fired) { st.fired = true; return true; }
      return false;
    },
  };
}
