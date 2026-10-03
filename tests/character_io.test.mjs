// SPDX-License-Identifier: GPL-3.0-or-later
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeCharacter, parseCharacter, createCharacterStore, pushRecent, makeOutfitPreset, CHARACTER_KIND } from '../src/character_io.js';

const KNOWN = { sliders: ['gender', 'height', 'weight', 'breastSize'], garments: ['tshirt', 'jeans', 'bra', 'panties'], hairs: ['bob01', 'long01'] };

test('character round trip through JSON', () => {
  const ch = makeCharacter({ name: 'Test', sex: 'female', body: { gender: -1, height: 0.25, breastSize: 0.6 }, skin: '#E0AC8A', hair: 'bob01', hairColor: '#3b2a1e',
    outfit: ['tshirt', 'jeans'], colors: { tshirt: { primary: '#2f5f9e' }, jeans: { primary: '#1e1e1e', secondary: '#c0c0c0' }, skirt: { primary: '#ffffff' } } }, new Date('2026-01-02T03:04:05Z'));
  assert.equal(ch.kind, CHARACTER_KIND);
  assert.equal(ch.skin, '#e0ac8a');
  assert.deepEqual(Object.keys(ch.colors), ['tshirt', 'jeans'], 'colours only for worn garments');
  const r = parseCharacter(JSON.stringify(ch), KNOWN);
  assert.ok(r.ok);
  assert.deepEqual(r.warnings, []);
  assert.deepEqual(r.character.body, ch.body);
  assert.deepEqual(r.character.outfit, ['tshirt', 'jeans']);
  assert.equal(r.character.colors.tshirt.primary, '#2f5f9e');
  assert.equal(r.character.colors.tshirt.secondary, null);
  assert.equal(r.character.sex, 'female');
});

test('untrusted input: wrong kind / version / JSON refused; bad values clamped or dropped with warnings', () => {
  assert.equal(parseCharacter('{nope', KNOWN).ok, false);
  assert.equal(parseCharacter({ kind: 'cc-character', version: 1 }, KNOWN).ok, false);
  assert.equal(parseCharacter({ kind: CHARACTER_KIND, version: 99 }, KNOWN).ok, false);
  assert.equal(parseCharacter(null, KNOWN).ok, false);
  const r = parseCharacter({ kind: CHARACTER_KIND, version: 1, sex: 'x', body: { height: 7, weight: 'a', evil: 1, '__proto__': 1 }, skin: 'red', hair: '../x',
    outfit: ['tshirt', 'tshirt', 'gown', 5], colors: { tshirt: { primary: 'javascript:1', secondary: '#ABCDEF' } } }, KNOWN);
  assert.ok(r.ok);
  assert.equal(r.character.sex, 'male');
  assert.deepEqual(r.character.body, { height: 1 });
  assert.equal(r.character.skin, null);
  assert.equal(r.character.hair, null);
  assert.deepEqual(r.character.outfit, ['tshirt']);
  assert.deepEqual(r.character.colors.tshirt, { primary: null, secondary: '#abcdef' });
  for (const k of ['height', 'weight', 'evil', 'gown', 'red', '../x']) assert.ok(r.warnings.some(w => w.includes(k)), `warning for ${k}: ${r.warnings}`);
});

test('slot store: save / load / remove, survives a broken or missing storage', () => {
  const mem = new Map();
  const storage = { getItem: k => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, v), removeItem: k => mem.delete(k) };
  const st = createCharacterStore(storage);
  const ch = makeCharacter({ body: { height: 0.1 }, outfit: ['jeans'] });
  assert.ok(st.save('1', ch));
  assert.deepEqual(st.load('1', KNOWN).character.outfit, ['jeans']);
  assert.equal(st.load('2', KNOWN).ok, false);
  st.remove('1');
  assert.deepEqual(st.list(), {});
  const broken = createCharacterStore({ getItem() { throw new Error('denied'); }, setItem() { throw new Error('quota'); } });
  assert.equal(broken.save('1', ch), false);
  assert.deepEqual(broken.list(), {});
  mem.set('ccxr.characters.v1', '{garbage');
  assert.deepEqual(st.list(), {});
});

test('recent items and outfit presets', () => {
  let r = [];
  for (const id of ['a', 'b', 'c', 'a', 'd', 'e', 'f', 'g']) r = pushRecent(r, id);
  assert.deepEqual(r, ['g', 'f', 'e', 'd', 'a', 'c']);
  const p = makeOutfitPreset({ outfit: ['tshirt'], colors: { tshirt: { primary: '#fff' }, jeans: {} }, hair: 'bob01', hairColor: null });
  assert.deepEqual(p, { outfit: ['tshirt'], colors: { tshirt: { primary: '#fff' } }, hair: 'bob01', hairColor: null });
});
