// SPDX-License-Identifier: GPL-3.0-or-later
// Save / load a character: this app's own JSON format (not the CharacterCreator desktop format)
//   { kind: 'ccxr-character', version: 1, app: 'CharacterCreatorXR', name, created, sex: 'male'|'female',
//     body: { sliderId: -1..1 }, skin: '#rrggbb', hair: id|null, hairColor: '#rrggbb'|null,
//     outfit: [garmentId], colors: { garmentId: { primary, secondary } } }
// Pure (no DOM): parseCharacter validates untrusted input (an imported file) against what this build knows
// (sliders / garments / hair styles), clamps numbers and drops unknown ids with a warning. docs/UI.md.

export const CHARACTER_KIND = 'ccxr-character';
export const CHARACTER_VERSION = 1;
export const STORE_KEY = 'ccxr.characters.v1';
const HEX = /^#[0-9a-f]{6}$/i;
const ID = /^[a-z0-9_-]{1,40}$/i;

/** Character snapshot from the app state (plain values). */
export function makeCharacter({ name = '', sex = 'male', body = {}, skin = null, hair = null, hairColor = null, outfit = [], colors = {} }, now = new Date()) {
  const b = {};
  for (const [k, v] of Object.entries(body)) if (Number.isFinite(+v)) b[k] = +(+v).toFixed(4);
  return {
    kind: CHARACTER_KIND, version: CHARACTER_VERSION, app: 'CharacterCreatorXR', name: String(name).slice(0, 40), created: now.toISOString(),
    sex: sex === 'female' ? 'female' : 'male', body: b, skin: HEX.test(skin || '') ? skin.toLowerCase() : null,
    hair: hair || null, hairColor: HEX.test(hairColor || '') ? hairColor.toLowerCase() : null,
    outfit: [...outfit], colors: Object.fromEntries(Object.entries(colors).filter(([id]) => outfit.includes(id)).map(([id, c]) => [id, { primary: c?.primary ?? null, secondary: c?.secondary ?? null }])),
  };
}

/**
 * Validate an imported / stored character. known = { sliders: [ids], garments: [ids], hairs: [ids] } (missing
 * lists accept anything of the right shape). Returns { ok, character, warnings: [..], error }.
 */
export function parseCharacter(input, known = {}) {
  let o = input;
  if (typeof o === 'string') { try { o = JSON.parse(o); } catch (e) { return { ok: false, error: 'json', warnings: [] }; } }
  if (!o || typeof o !== 'object') return { ok: false, error: 'not an object', warnings: [] };
  if (o.kind !== CHARACTER_KIND) return { ok: false, error: `kind '${o.kind}' is not '${CHARACTER_KIND}'`, warnings: [] };
  if (!(o.version >= 1) || o.version > CHARACTER_VERSION) return { ok: false, error: `version ${o.version} not supported`, warnings: [] };
  const w = [];
  const has = (list, id) => !list || list.includes(id);
  const body = {};
  for (const [k, v] of Object.entries(o.body || {})) {
    if (!ID.test(k) || !has(known.sliders, k)) { w.push(`slider '${k}' unknown`); continue; }
    const n = +v;
    if (!Number.isFinite(n)) { w.push(`slider '${k}' not a number`); continue; }
    if (n < -1 || n > 1) w.push(`slider '${k}' clamped`);
    body[k] = Math.max(-1, Math.min(1, n));
  }
  const outfit = [];
  for (const id of Array.isArray(o.outfit) ? o.outfit : []) {
    if (typeof id !== 'string' || !ID.test(id) || !has(known.garments, id)) { w.push(`garment '${id}' unknown`); continue; }
    if (!outfit.includes(id)) outfit.push(id);
  }
  const colors = {};
  for (const id of outfit) {
    const c = o.colors?.[id];
    if (!c) continue;
    colors[id] = { primary: HEX.test(c.primary || '') ? c.primary.toLowerCase() : null, secondary: HEX.test(c.secondary || '') ? c.secondary.toLowerCase() : null };
  }
  let hair = o.hair ?? null;
  if (hair != null && (typeof hair !== 'string' || !ID.test(hair) || !has(known.hairs, hair))) { w.push(`hair '${hair}' unknown`); hair = null; }
  const pick = (v, key) => { if (v == null) return null; if (HEX.test(v)) return v.toLowerCase(); w.push(`${key} '${v}' is not #rrggbb`); return null; };
  return {
    ok: true, warnings: w,
    character: {
      kind: CHARACTER_KIND, version: CHARACTER_VERSION, app: o.app || 'CharacterCreatorXR', name: String(o.name ?? '').slice(0, 40), created: String(o.created ?? ''),
      sex: o.sex === 'female' ? 'female' : 'male', body, skin: pick(o.skin, 'skin'), hair, hairColor: pick(o.hairColor, 'hairColor'), outfit, colors,
    },
  };
}

/** Slot store in localStorage (every access guarded): { slots: { '1': character, ... } }. */
export function createCharacterStore(storage = globalThis.localStorage) {
  const read = () => { try { const v = JSON.parse(storage?.getItem(STORE_KEY) || 'null'); return v && typeof v === 'object' && v.slots ? v : { slots: {} }; } catch { return { slots: {} }; } };
  const write = v => { try { storage?.setItem(STORE_KEY, JSON.stringify(v)); return true; } catch { return false; } };
  return {
    list: () => read().slots,
    save(slot, ch) { const v = read(); v.slots[slot] = ch; return write(v); },
    load(slot, known) { const ch = read().slots[slot]; return ch ? parseCharacter(ch, known) : { ok: false, error: 'empty', warnings: [] }; },
    remove(slot) { const v = read(); delete v.slots[slot]; return write(v); },
  };
}

/** Recently used ids, newest first, unique, at most max. Returns a new array. */
export function pushRecent(list, id, max = 6) {
  return [id, ...(list || []).filter(x => x !== id)].slice(0, max);
}

/** Outfit preset (a slot on the Clothes tab): what is worn + its colours + hair. */
export function makeOutfitPreset({ outfit = [], colors = {}, hair = null, hairColor = null }) {
  return { outfit: [...outfit], colors: Object.fromEntries(outfit.filter(id => colors[id]).map(id => [id, { ...colors[id] }])), hair, hairColor };
}
