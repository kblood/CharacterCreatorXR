// Persistent settings (localStorage, every access guarded) + URL parameters (which win over stored values).
// URL: ?outfit=a,b|none &hair=id|none &sex=female|male &mirror=0|1 &lang=da|en &desktop=1 &quality=high|medium|low
//      &emulate=quest3|hands|fingers (IWER, dev only) &replay=<fixture.json> &view=first|third &cloth=0 &shot=1
const KEY = 'ccxr.settings.v1';

export const DEFAULTS = {
  lang: 'da',
  outfit: null,               // null = catalog default
  colors: {},                 // garment id -> { primary, secondary }
  hair: undefined,            // undefined = hair.json default, null = none
  hairColor: null,            // null = hair.json defaultColor
  body: {},                   // slider id -> value (character.js SLIDERS)
  skin: null,
  mirror: true,
  handMirror: false,
  cloth: true,
  wind: 0,
  quality: 'auto',            // auto | high | medium | low
  locomotion: 'procedural',   // procedural | clips
  calibration: { mode: 'morph', userEye: null, height: null, scale: 1, armScale: 1 },
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
    return v && typeof v === 'object' ? v : {};
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
  Object.assign(s, url);
  let timer = null;
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
          const { sex, ...rest } = s;
          globalThis.localStorage?.setItem(KEY, JSON.stringify(rest));
        } catch { /* private mode / quota: settings just do not persist */ }
      }, 250);
    },
    reset() {
      try { globalThis.localStorage?.removeItem(KEY); } catch { /* ignore */ }
      Object.assign(s, structuredClone(DEFAULTS), url);
    },
  };
  return api;
}
