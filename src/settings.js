// Persistent settings (localStorage, every access guarded) + URL parameters (which win over stored values).
// URL: ?outfit=a,b|none &hair=id|none &sex=female|male|f|m|0|1 &underwear=0 &breast=0 &mirror=0|1 &lang=da|en &desktop=1
//      &quality=high|medium|low &locomotion=procedural|clips &emulate=quest3|hands|fingers (IWER, dev only)
//      &replay=<fixture.json> &view=first|third &cloth=0 &tutorial=0 &floor=1 &shot=1
const KEY = 'ccxr.settings.v1';

export const DEFAULTS = {
  version: 2,                 // 1 = first release (procedural locomotion default, fractional gender)
  lang: 'da',
  outfit: null,               // null = catalog default + the default underwear of the sex
  colors: {},                 // garment id -> { primary, secondary }
  hair: undefined,            // undefined = hair.json default, null = none
  hairColor: null,            // null = hair.json defaultColor
  body: {},                   // slider id -> value (character.js SLIDERS; gender +1 male / -1 female)
  underwear: true,            // default underwear of the sex (briefs / panties + bra)
  breastPhysics: true,
  skin: null,
  mirror: true,
  handMirror: false,
  cloth: true,
  wind: 0,
  quality: 'auto',            // auto | high | medium | low
  locomotion: 'clips',        // clips (walk/run/strafe/back/jump clips driven by tracked motion) | procedural (steps only)
  sit: 'auto',                // auto (sit heuristic) | off
  handCollision: true,        // keep the avatar's hands out of its own body (+ ghost hand when they drift)
  // calibration.mode: morph (height slider matches the user) | scale (uniform scale) | own (keep the character's own
  // height, the tracking is scaled instead) | off
  calibration: { mode: 'morph', userEye: null, height: null, scale: 1, worldScale: 1, armScale: 1, span: null, time: null },
  user: 'A',                  // calibration profile (several people sharing a headset)
  users: {},                  // profile id -> calibration
  outfitSlots: {},            // slot 1..3 -> { outfit, colors, hair, hairColor }
  recent: [],                 // recently worn garment ids (newest first)
  tutorialDone: false,
  sound: true,                // WebAudio click on press
  haptics: true,
  perfHud: false,
  autoQuality: true,          // in-session auto-scaler (mirror / foveation / shadows / cloth rate when frames are missed)
  floorReflection: false,     // faint per-eye floor reflection (one more scene pass per eye)
  ghostHands: true,           // translucent hand at the tracked pose when the avatar's hand cannot follow
  smoothHands: true,          // One-Euro filter on hand-tracking wrist poses
  gripOffset: null,           // [x,y,z] wrist offset from the controller grip (hand frame, m); null = built-in
  framebufferScale: null,     // null = quality preset
  foveation: null,            // null = quality preset
  armMode: 'match',           // match (hands exactly on the controllers) | proportional
  dominant: 'right',
  handDebug: false,
  kneel: true,
  panel: null,                // { pos:[x,y,z], quat:[x,y,z,w] } of the main board
  fingerOverride: null,       // user mapping-table entries ({ profiles: [...] }), see finger_profiles.json
};

function load() {
  try {
    const raw = globalThis.localStorage?.getItem(KEY);
    if (!raw) return {};
    const v = JSON.parse(raw);
    if (!v || typeof v !== 'object') return {};
    if ((v.version ?? 1) < 2) { delete v.locomotion; v.version = 2; }   // v1 stored its default, not a choice
    return v;
  } catch { return {}; }
}

export function createSettings(search = globalThis.location?.search || '') {
  const params = new URLSearchParams(search);
  const s = structuredClone({ ...DEFAULTS, ...load() });
  s.calibration = { ...DEFAULTS.calibration, ...(s.calibration || {}) };
  const url = {};
  if (params.has('lang') && ['da', 'en'].includes(params.get('lang'))) url.lang = params.get('lang');
  if (params.has('outfit')) url.outfit = params.get('outfit') === 'none' ? [] : params.get('outfit').split(',').filter(Boolean);
  if (params.has('hair')) url.hair = params.get('hair') === 'none' ? null : params.get('hair');
  if (params.has('mirror')) url.mirror = params.get('mirror') !== '0';
  if (params.has('cloth')) url.cloth = params.get('cloth') !== '0';
  if (params.has('quality') && ['auto', 'high', 'medium', 'low'].includes(params.get('quality'))) url.quality = params.get('quality');
  if (params.has('sex')) url.sex = params.get('sex');
  if (params.has('underwear')) url.underwear = params.get('underwear') !== '0';
  if (params.has('breast')) url.breastPhysics = params.get('breast') !== '0';
  if (params.has('locomotion') && ['procedural', 'clips'].includes(params.get('locomotion'))) url.locomotion = params.get('locomotion');
  if (params.has('tutorial')) url.tutorialDone = params.get('tutorial') === '0';
  if (params.has('floor')) url.floorReflection = params.get('floor') !== '0';
  const stored = structuredClone(s);                 // what localStorage had (+ defaults), before the URL overrides
  Object.assign(s, url);
  let timer = null;
  /** The values to persist: a key still holding its URL override keeps the stored value (a URL is not a choice). */
  const persistable = () => {
    const out = {};
    for (const [k, v] of Object.entries(s)) {
      if (k === 'sex') continue;
      out[k] = k in url && JSON.stringify(v) === JSON.stringify(url[k]) ? stored[k] : v;
    }
    return out;
  };
  const api = {
    values: s,
    params,
    flag: k => params.has(k) && params.get(k) !== '0',
    get: k => s[k],
    set(k, v) { s[k] = v; api.save(); },
    save() {
      clearTimeout(timer);
      timer = setTimeout(() => {
        try {
          globalThis.localStorage?.setItem(KEY, JSON.stringify(persistable()));
        } catch { /* private mode / quota: settings just do not persist */ }
      }, 250);
    },
    /** For tests: the object save() writes. */
    persistable,
    /** Write now (no debounce), e.g. before an export or on pagehide. */
    flush() { clearTimeout(timer); try { globalThis.localStorage?.setItem(KEY, JSON.stringify(persistable())); } catch { /* ignore */ } },
    reset() {
      try { globalThis.localStorage?.removeItem(KEY); } catch { /* ignore */ }
      Object.assign(s, structuredClone(DEFAULTS), url);
    },
  };
  return api;
}
