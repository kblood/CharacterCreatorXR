// Generic finger-tracking input layer. Every source is normalised into the same per-finger representation
// (src/ik/fingers.js FingerState: flexion angles + curl 0..1 + a source tag per finger):
//   (a) 'hand'              XRHand, 25 joints (WebXR Hand Input)
//   (b) 'controller-finger' controllers that report per-finger values in gamepad buttons/axes, found through a
//                           JSON mapping table (src/input/finger_profiles.json + a user override from the headset)
//   (c) 'controller'        plain trigger / grip / thumb-touch (xr-standard) -> procedural fingers
//   'rest'                  nothing usable -> relaxed hand
// Pure and engine-agnostic: the browser snapshots each XRInputSource into a plain object (snapshotSource) and
// this module never touches WebXR objects, so it is unit-tested in node. docs/HAND_TRACKING.md.
import { fingerStateFromJoints, fingerStateFromCurls, limitFingerState, blendFingerStates, XR_JOINTS } from '../ik/fingers.js';

export const FINGER_KEYS = ['thumb', 'index', 'middle', 'ring', 'little'];
const CAP = { thumb: 'Thumb', index: 'Index', middle: 'Middle', ring: 'Ring', little: 'Little' };
const clamp01 = v => (v < 0 ? 0 : v > 1 ? 1 : v);

/**
 * Plain snapshot of an XRInputSource (+ optional hand joint positions already resolved by the caller):
 * { handedness, profiles: [..], targetRayMode, hasHand, joints: {name:[x,y,z]} | null,
 *   gamepad: { mapping, buttons: [{value, touched, pressed}], axes: [..] } | null }
 */
export function snapshotSource(src, joints = null) {
  const gp = src?.gamepad;
  return {
    handedness: src?.handedness || 'none',
    profiles: [...(src?.profiles || [])],
    targetRayMode: src?.targetRayMode || '',
    hasHand: !!src?.hand,
    joints,
    gamepad: gp ? {
      mapping: gp.mapping || '',
      buttons: Array.from(gp.buttons || [], b => ({ value: +b?.value || 0, touched: !!b?.touched, pressed: !!b?.pressed })),
      axes: Array.from(gp.axes || [], a => +a || 0),
    } : null,
  };
}

/** Merge the shipped table with a user override ({profiles:[...]} entries first, same shape). */
export function mergeTables(base, override) {
  if (!override?.profiles?.length) return base;
  const ids = new Set(override.profiles.map(p => p.id));
  return { ...base, profiles: [...override.profiles, ...(base.profiles || []).filter(p => !ids.has(p.id))], fallback: { ...base.fallback, ...(override.fallback || {}) } };
}

/** First table entry that matches the snapshot (or null). */
export function matchProfile(table, snap) {
  const gp = snap.gamepad;
  for (const p of table?.profiles || []) {
    const m = p.match || {};
    const prof = snap.profiles || [];
    if (m.profiles && !m.profiles.some(id => prof.includes(id))) continue;
    if (m.profilesAny && !m.profilesAny.some(id => prof.some(x => x === id || x.startsWith(id)))) continue;
    if (!m.profiles && !m.profilesAny) continue;
    if (m.mapping != null && (gp?.mapping ?? '') !== m.mapping) continue;
    if (m.minButtons && (gp?.buttons.length ?? 0) < m.minButtons) continue;
    if (m.minAxes && (gp?.axes.length ?? 0) < m.minAxes) continue;
    if (m.handedness && m.handedness !== snap.handedness) continue;
    return p;
  }
  return null;
}

/** Value 0..1 of one channel spec, or null when the channel does not exist on this gamepad. */
export function readChannel(gp, ch) {
  if (!gp || !ch) return null;
  let v;
  if (ch.button != null) {
    const b = gp.buttons[ch.button];
    if (!b) return null;
    const f = ch.field || 'value';
    v = f === 'touched' ? (b.touched ? 1 : 0) : f === 'pressed' ? (b.pressed ? 1 : 0) : b.value;
    if (f === 'value' && ch.touchCurl != null && b.touched) v = Math.max(v, ch.touchCurl);
  } else if (ch.axis != null) {
    if (ch.axis >= gp.axes.length) return null;
    v = gp.axes[ch.axis];
  } else return null;
  const min = ch.min ?? 0, max = ch.max ?? 1;
  v = clamp01((v - min) / ((max - min) || 1));
  if (ch.invert) v = 1 - v;
  if (ch.gamma) v = Math.pow(v, ch.gamma);
  return v;
}

/** Trigger / grip / thumb-touch fallback curls: { curls, paths }. */
export function fallbackCurls(gp, fb) {
  const curls = { thumb: 0, index: 0, middle: 0, ring: 0, little: 0 }, paths = {};
  if (!gp) { for (const k of FINGER_KEYS) paths[k] = 'rest'; return { curls, paths }; }
  const idx = readChannel(gp, fb.index);
  const grip = readChannel(gp, fb.grip);
  // relaxed hand holding a controller: a light curl even with nothing pressed
  curls.index = 0.12 + 0.88 * (idx ?? 0);
  const g = 0.22 + 0.78 * (grip ?? 0);
  curls.middle = g; curls.ring = Math.min(1, g * 1.02); curls.little = Math.min(1, g * 1.05);
  let thumb = 0.1;
  (fb.thumbTouch || []).forEach((bi, k) => {
    const b = gp.buttons[bi];
    if (!b) return;
    const isRest = k === (fb.thumbTouch.length - 1);
    if (b.touched || b.pressed) thumb = Math.max(thumb, isRest ? (fb.thumbRestCurl ?? 0.55) : (fb.thumbCurl ?? 0.85));
  });
  curls.thumb = thumb;
  paths.index = idx != null ? `controller:button${fb.index.button}` : 'controller:none';
  for (const k of ['middle', 'ring', 'little']) paths[k] = grip != null ? `controller:button${fb.grip.button}` : 'controller:none';
  paths.thumb = 'controller:thumb-touch';
  return { curls, paths };
}

/**
 * One hand: snapshot -> { state: FingerState, kind, paths: {finger: 'hand'|'controller-finger:button7'|...}, profile }.
 * restHand = rig.hands[side] (for limits).
 */
export function evaluateSource(snap, table, restHand = null) {
  const side = snap.handedness === 'right' ? 'right' : 'left';
  // (a) articulated hand
  if (snap.hasHand && snap.joints) {
    const r = fingerStateFromJoints(side, snap.joints);
    if (r && Object.values(r.fingers).every(Boolean)) {
      const paths = Object.fromEntries(FINGER_KEYS.map(k => [k, 'hand']));
      return { state: limitFingerState(r.fingers, restHand), kind: 'hand', paths, profile: null, frame: r.frame };
    }
  }
  const gp = snap.gamepad;
  const fb = table?.fallback || {};
  const base = fallbackCurls(gp, fb);
  const prof = matchProfile(table, snap);
  const curls = { ...base.curls }, paths = { ...base.paths }, src = {};
  let any = false;
  if (prof && gp) {
    for (const k of FINGER_KEYS) {
      const ch = prof.fingers?.[k];
      const v = readChannel(gp, ch);
      if (v == null) continue;
      curls[k] = v; any = true;
      paths[k] = `controller-finger:${ch.button != null ? `button${ch.button}` : `axis${ch.axis}`}`;
      src[k] = 'controller-finger';
    }
  }
  for (const k of FINGER_KEYS) if (!src[k]) src[k] = gp ? 'controller' : 'rest';
  const state = fingerStateFromCurls(curls, src);
  return { state: limitFingerState(state, restHand), kind: any ? 'controller-finger' : gp ? 'controller' : 'rest', paths, profile: prof?.id ?? null, curls };
}

/**
 * Stateful smoothing wrapper: createFingerInput(table) -> { update(snaps, dt, rig) -> {left, right}, setTable }.
 * Keeps the last state per hand and blends when the source kind changes (no pops on inputsourceschange).
 */
export function createFingerInput(table) {
  const st = { table, prev: { left: null, right: null }, kind: { left: null, right: null }, blend: { left: 1, right: 1 } };
  return {
    setTable(t) { st.table = t; },
    get table() { return st.table; },
    update(snaps, dt, rig) {
      const out = {};
      for (const side of ['left', 'right']) {
        const snap = snaps.find(s => s.handedness === side);
        const restHand = rig?.hands?.[side] || null;
        const ev = snap ? evaluateSource(snap, st.table, restHand) : { state: fingerStateFromCurls({ index: 0.15, middle: 0.2, ring: 0.22, little: 0.25, thumb: 0.1 }, Object.fromEntries(FINGER_KEYS.map(k => [k, 'rest']))), kind: 'rest', paths: Object.fromEntries(FINGER_KEYS.map(k => [k, 'rest'])), profile: null };
        // a source switch (controller put down -> hand tracking) blends over ~0.25 s instead of popping
        if (st.kind[side] && st.kind[side] !== ev.kind) st.blend[side] = 0;
        st.kind[side] = ev.kind;
        st.blend[side] = Math.min(1, st.blend[side] + Math.max(0, dt || 0) / 0.25);
        const tau = st.blend[side] < 1 ? 0.12 : ev.kind === 'hand' ? 0.025 : 0.045;
        const a = dt > 0 ? 1 - Math.exp(-dt / tau) : 1;
        const state = st.prev[side] ? blendFingerStates(st.prev[side], ev.state, a) : ev.state;
        st.prev[side] = state;
        out[side] = { ...ev, state, blend: st.blend[side] };
      }
      return out;
    },
  };
}

/**
 * Learn wizard (headset-side mapping without code changes): feed it snapshots while the user holds poses.
 * steps: 'open', then one per finger ('index','middle','ring','little','thumb'). Each finger is assigned the
 * button value / axis channel that moved most from the 'open' baseline and is not taken yet.
 * Returns a profile entry for the mapping table (or null + reason).
 */
export function learnMapping(samples, profileId) {
  const open = samples.open;
  if (!open?.length) return { entry: null, reason: 'no open-hand samples' };
  const mean = arr => {
    const n = arr.length, b = arr[0].buttons.length, a = arr[0].axes.length;
    const mb = new Array(b).fill(0), ma = new Array(a).fill(0);
    for (const g of arr) { g.buttons.forEach((x, i) => { mb[i] += x.value / n; }); g.axes.forEach((x, i) => { ma[i] += x / n; }); }
    return { b: mb, a: ma };
  };
  const base = mean(open);
  const taken = new Set(), fingers = {}, report = {};
  for (const k of ['index', 'middle', 'ring', 'little', 'thumb']) {
    if (!samples[k]?.length) continue;
    const m = mean(samples[k]);
    let best = null;
    m.b.forEach((v, i) => { const d = Math.abs(v - (base.b[i] ?? 0)); const key = `b${i}`; if (!taken.has(key) && (!best || d > best.d)) best = { d, key, ch: { button: i, field: 'value', min: base.b[i] ?? 0, max: v } }; });
    m.a.forEach((v, i) => { const d = Math.abs(v - (base.a[i] ?? 0)); const key = `a${i}`; if (!taken.has(key) && (!best || d > best.d)) best = { d, key, ch: { axis: i, min: base.a[i] ?? 0, max: v } }; });
    report[k] = best ? +best.d.toFixed(3) : 0;
    if (best && best.d > 0.25) {
      taken.add(best.key);
      const ch = best.ch;
      if (ch.max < ch.min) { const t = ch.min; ch.min = ch.max; ch.max = t; ch.invert = true; }
      ch.min = +ch.min.toFixed(3); ch.max = +ch.max.toFixed(3);
      fingers[k] = ch;
    }
  }
  if (!Object.keys(fingers).length) return { entry: null, reason: 'no channel changed by more than 0.25', report };
  return { entry: { id: `learned-${profileId}`, verified: `learned on the device ${new Date().toISOString().slice(0, 10)}`, match: { profiles: [profileId] }, fingers }, report };
}

export { XR_JOINTS, CAP };
