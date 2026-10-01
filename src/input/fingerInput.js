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
import { createOneEuro, oneEuro, resetOneEuro } from '../ik/filters.js';

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
      return { state: limitFingerState(r.fingers, restHand), raw: r.fingers, kind: 'hand', paths, profile: null, frame: r.frame };
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

/** Largest per-angle difference (rad) between two finger states (null fingers ignored). */
function maxAngleDiff(a, b) {
  let m = 0;
  for (const f of Object.keys(a || {})) {
    const x = a[f], y = b?.[f];
    if (!x || !y) continue;
    for (const k of ['yaw', 'dyaw', 'pitch', 'bend1', 'bend2']) if (Number.isFinite(x[k]) && Number.isFinite(y[k])) m = Math.max(m, Math.abs(x[k] - y[k]));
  }
  return m;
}

export const RELAXED_CURLS = { index: 0.15, middle: 0.2, ring: 0.22, little: 0.25, thumb: 0.1 };
const relaxedState = () => fingerStateFromCurls(RELAXED_CURLS, Object.fromEntries(FINGER_KEYS.map(k => [k, 'rest'])));
const ANGLES = ['yaw', 'dyaw', 'pitch', 'bend1', 'bend2'];
// One-Euro parameters per source: hand tracking jitters at rest (strong smoothing, little lag when moving);
// controller channels are clean analog values (light smoothing)
export const FINGER_FILTER = {
  hand: { minCutoff: 2.2, beta: 0.35, dCutoff: 1 },
  controller: { minCutoff: 6, beta: 0.05, dCutoff: 1 },
};
export const FINGER_INPUT_DEFAULTS = {
  holdTime: 0.5,        // s a lost source keeps its last finger pose
  relaxTime: 0.6,       // s to blend from the held pose to the relaxed hand afterwards
  switchTime: 0.25,     // s blend when the source kind changes (controller <-> hand)
  spreadAdapt: 6,       // s time constant of the learned open-hand spread (rest-pose retargeting)
  retarget: true,
};

/**
 * Stateful layer: createFingerInput(table, opts) -> { update(snaps, dt, rig) -> {left, right}, setTable }.
 *  - One-Euro filter on every finger angle (per source kind, FINGER_FILTER)
 *  - a source switch (controller put down -> hand tracking) blends instead of popping
 *  - lost tracking (source gone, or a hand-tracking source without tracked joints): hold the last pose for
 *    holdTime, then blend to a relaxed hand over relaxTime; out[side].lost / .held report it
 *  - rest-pose retargeting of the finger spread (XRHand only): the user's own open-hand spread per finger is
 *    learned slowly while that finger is straight, and deviations from it are applied on top of the avatar's
 *    rest spread (a user with naturally splayed fingers does not get a splayed avatar hand)
 */
export function createFingerInput(table, opts = {}) {
  const o = { ...FINGER_INPUT_DEFAULTS, ...opts };
  const mk = () => ({ prev: null, kind: null, blend: 1, lost: 0, held: null, filters: {}, fkind: null, neutral: {}, relax: relaxedState() });
  const st = { table, left: mk(), right: mk() };
  function filtered(H, state, dt, kind) {
    const fk = kind === 'hand' ? 'hand' : 'controller';
    if (H.fkind !== fk) { for (const k in H.filters) resetOneEuro(H.filters[k]); H.fkind = fk; }
    const P = FINGER_FILTER[fk], out = {};
    for (const f in state) {
      const a = state[f];
      if (!a) { out[f] = null; continue; }
      const b = { ...a };
      for (const k of ANGLES) {
        if (a[k] == null || !Number.isFinite(a[k])) continue;
        const key = f + k;
        const flt = H.filters[key] || (H.filters[key] = createOneEuro(P));
        flt.minCutoff = P.minCutoff; flt.beta = P.beta; flt.dCutoff = P.dCutoff;
        b[k] = oneEuro(flt, a[k], dt);
      }
      out[f] = b;
    }
    return out;
  }
  function retarget(H, raw, restHand, dt) {
    if (!o.retarget || !restHand) return raw;
    const out = { ...raw };
    for (const f of ['Index', 'Middle', 'Ring', 'Little']) {
      const a = raw[f], rest = restHand.fingers?.[f]?.rest;
      if (!a || a.yaw == null || !Number.isFinite(a.yaw) || !rest) continue;
      if (H.neutral[f] == null) H.neutral[f] = rest.yaw;
      if ((a.curl ?? 1) < 0.25 && dt > 0) H.neutral[f] += (a.yaw - H.neutral[f]) * (1 - Math.exp(-dt / o.spreadAdapt));
      out[f] = { ...a, yaw: rest.yaw + (a.yaw - H.neutral[f]) };
    }
    return out;
  }
  return {
    options: o,
    setTable(t) { st.table = t; },
    get table() { return st.table; },
    /** Forget the learned spread (e.g. another user). */
    resetRetarget() { st.left.neutral = {}; st.right.neutral = {}; },
    neutral: side => ({ ...st[side].neutral }),
    update(snaps, dt, rig) {
      const out = {};
      dt = Math.max(0, dt || 0);
      for (const side of ['left', 'right']) {
        const H = st[side];
        const snap = snaps.find(s => s.handedness === side);
        const restHand = rig?.hands?.[side] || null;
        let ev = snap ? evaluateSource(snap, st.table, restHand) : null;
        const hadSource = H.kind && H.kind !== 'rest';
        const lostNow = hadSource && (!ev || ev.kind === 'rest');
        if (lostNow && H.prev) {
          H.lost += dt;
          if (!H.held) H.held = H.prev;
          const k = H.lost <= o.holdTime ? 0 : Math.min(1, (H.lost - o.holdTime) / o.relaxTime);
          const state = blendFingerStates(H.held, H.relax, k * k * (3 - 2 * k));
          H.prev = state;
          const tag = k < 1 ? 'held' : 'rest';
          out[side] = { state, kind: tag, paths: Object.fromEntries(FINGER_KEYS.map(f => [f, tag])), profile: null, lost: true, held: k < 1, blend: H.blend };
          if (k >= 1) H.kind = 'rest';
          continue;
        }
        // no source, or a source with nothing to read (hand tracking without joints, no gamepad): the RELAXED hand,
        // not the flat zero-curl state evaluateSource returns for 'rest' (review finding)
        if (!ev || ev.kind === 'rest') ev = { state: H.relax, kind: 'rest', paths: Object.fromEntries(FINGER_KEYS.map(k => [k, 'rest'])), profile: null };
        if (H.lost > 0) { H.lost = 0; H.held = null; H.blend = 0; }
        if (ev.kind === 'hand' && ev.raw) ev = { ...ev, state: limitFingerState(retarget(H, ev.raw, restHand, dt), restHand) };
        if (H.kind && H.kind !== ev.kind) { H.blend = 0; H.easing = true; }
        H.kind = ev.kind;
        H.blend = Math.min(1, H.blend + dt / o.switchTime);
        const f = filtered(H, ev.state, dt, ev.kind);
        // while switching sources: ease from the previous pose (no pop)
        // (the ease runs until it has converged, not just for switchTime: cutting it there left a ~4% step)
        let state = f;
        if (H.prev && (H.blend < 1 || H.easing)) {
          state = blendFingerStates(H.prev, f, dt > 0 ? 1 - Math.exp(-dt / 0.08) : 1);
          if (H.blend >= 1 && maxAngleDiff(state, f) < 0.01 * Math.PI / 180) { state = f; H.easing = false; }
        } else H.easing = false;
        H.prev = state;
        out[side] = { ...ev, state, blend: H.blend, lost: false, held: false };
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
