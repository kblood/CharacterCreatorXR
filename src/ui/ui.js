// SPDX-License-Identifier: GPL-3.0-or-later
// In-VR / desktop UI. Panels (src/ui/panel.js, canvas textures; ray / poke / mouse via src/ui/interact.js):
//  - the main board (tabs Clothes / Body / Hair / Outfits / Calibrate / Scene / System), standing next to the
//    mirror, grabbable, placed for the user on first use;
//  - a wrist menu on the non-dominant hand (palm toward the eyes);
//  - a hint panel in front of the user (calibration countdown, photo countdown, recenter progress);
//  - an optional perf HUD; a first-run tutorial;
//  - the finger-input DEBUG panel (diagnostics download, recording, learn-mapping wizard).
// docs/UI.md.
import * as THREE from 'three';
import { createPanel, flow, btn, toggle, slider, label, swatch, tile, area, THEME, fitText } from './panel.js';
import { createInteraction } from './interact.js';
import { mergeTables, learnMapping, FINGER_KEYS } from '../input/fingerInput.js';
import { hsvToHex, hexToHsv, pickColor, boardPlacement, createRecenterGesture } from './uilogic.js';
import { createClicker } from './audio.js';
import { makeCharacter, parseCharacter, createCharacterStore, pushRecent, makeOutfitPreset } from '../character_io.js';
import { describeRuntime } from '../features.js';
import { drawSlotIcon } from '../render/thumbs.js';
import { ROOM } from '../room.js';
import { isUnderwear } from '../../vendor/cc/clothing_rules.js';

const GARMENT_COLORS = ['#f2f2f2', '#1e1e1e', '#7a7f87', '#2f5f9e', '#3d5f8c', '#8c2f39', '#2f7a4f', '#e08a2c', '#d9c29a', '#6b4a8c', '#c8558a', '#4b4b52'];
const SKIN_COLORS = ['#f6d7c3', '#eec1a4', '#c99a80', '#e0ac8a', '#c68863', '#a86b48', '#8a5236', '#6b3b25', '#4a281a'];
const HAIR_COLORS = ['#0f0c0a', '#2b1d14', '#3b2a1e', '#5a3a22', '#8a5a33', '#b8864f', '#d9b27a', '#e8d3a8', '#9a9a9a', '#e6e6e6', '#8c2f1f', '#3a4f8c'];
const TABS = ['clothes', 'body', 'hair', 'outfits', 'calib', 'scene', 'system'];
const TAB_KEYS = { clothes: 'tabClothes', body: 'tabBody', hair: 'tabHair', outfits: 'tabOutfits', calib: 'tabCalib', scene: 'tabScene', system: 'tabSystem' };
const heading = (text, w) => label(text, w, { color: THEME.fg, font: 27, bold: true, h: 44 });
const BW = 1280, BH = 900, PAD = 28, CONTENT_Y = 112, FOOT_Y = 842;

export function createUI(app) {
  const { settings, t, scene, camera, renderer } = app;
  const S = settings.values;
  const av = () => app.avatar;
  const ui = {
    tab: 'clothes', slot: null, bodyPage: 'body', colorTarget: null, colorWhich: 'primary', sysPage: 'main', resetArmed: 0, wizard: null,
    toast: '', toastT: 0, debugVisible: !!settings.flag('debug'), pick: null, pickPart: null, photo: null, photoCountdown: 0, tutorialStep: 0,
  };
  const lang = () => S.lang;
  const clicker = createClicker();
  const store = createCharacterStore();
  const recenter = createRecenterGesture();
  const label$ = (it) => it?.label?.[lang()] ?? it?.label?.da ?? it?.id ?? '';

  // ---------------------------------------------------------------- board
  let dbgPanel = null;   // the finger debug panel is created further down; toasts can happen before that
  const board = createPanel({ name: 'Board', px: [BW, BH], size: [1.12, 1.12 * BH / BW], live: 2 });
  board.grabbable = true;
  scene.add(board.group);
  let boardPlaced = false;
  /** Adaptive placement: front-right of the user's head (or a fixed spot before any tracking), off the mirror. */
  function placeBoardDefault(head = app.rec?.head) {
    if (head) {
      const p = boardPlacement(head, { eye: S.calibration.userEye ? S.calibration.userEye * (app.worldScale || 1) : null, mirror: { x: 0, z: ROOM.mirrorZ, halfWidth: ROOM.mirrorWidth / 2 } });
      board.group.position.fromArray(p.pos); board.group.rotation.set(0, p.yaw, 0);
    } else {
      const eye = S.calibration.userEye || 1.6;
      board.group.position.set(1.0, Math.max(0.9, eye - 0.32), -0.8);
      board.group.lookAt(0, Math.max(0.9, eye - 0.32), 0.4);
    }
    board.group.updateMatrixWorld();
    boardPlaced = true;
    if (ui.debugVisible && dbgPanel) placeDebug();
  }
  if (S.panel?.pos && S.panel?.quat) { board.group.position.fromArray(S.panel.pos); board.group.quaternion.fromArray(S.panel.quat); board.group.updateMatrixWorld(); boardPlaced = true; }
  else { placeBoardDefault(null); boardPlaced = false; }

  board.drawBackground = c => {
    c.textBaseline = 'middle';
    c.fillStyle = THEME.border; c.fillRect(PAD, CONTENT_Y - 14, BW - 2 * PAD, 2); c.fillRect(PAD, FOOT_Y - 8, BW - 2 * PAD, 2);
    c.textAlign = 'left'; c.fillStyle = THEME.muted; c.font = `500 24px ${THEME.font}`;
    c.fillText(fitText(c, statusLine(), BW - 2 * PAD), PAD, FOOT_Y + 28);
  };
  function statusLine() {
    const p = app.perf, mode = app.mode === 'xr' ? `XR ${app.xrInfo?.refSpace || ''}` : app.mode;
    const toastOn = ui.toast && performance.now() - ui.toastT < 6000;
    return `${mode} · ${p.fps.toFixed(0)} fps · IK ${p.ik.toFixed(2)} ms${toastOn ? ` · ${ui.toast}` : app.calibrationMsg ? ` · ${app.calibrationMsg}` : ''}`;
  }
  const toast = msg => { ui.toast = msg; ui.toastT = performance.now(); board.invalidate(); dbgPanel?.invalidate(); };
  const feedback = (kind = 'click') => { if (S.sound !== false) clicker.play(kind); };

  board.build = () => {
    const out = [];
    const L = flow(PAD, 18, BW - 220, 8);
    for (const tb of TABS) L.add({ ...btn(t(TAB_KEYS[tb]), 140, () => { ui.tab = tb; ui.resetArmed = 0; board.invalidate(true); }), id: `tab-${tb}`, kind: 'tab', active: () => ui.tab === tb, h: 72, font: 26 });
    out.push(...L.out);
    out.push({ kind: 'custom', id: 'grabbar', x: BW - 200, y: 18, w: 172, h: 72, interactive: true, grab: true, draw: (c, w, hov) => {
      c.fillStyle = hov ? THEME.buttonHover : 'rgba(255,255,255,0.05)'; c.fillRect(w.x, w.y, w.w, w.h);
      c.fillStyle = THEME.muted; for (let i = 0; i < 3; i++) c.fillRect(w.x + 36, w.y + 24 + i * 9, 100, 4);
      c.font = `500 18px ${THEME.font}`; c.textAlign = 'center'; c.fillText(t('grab'), w.x + w.w / 2, w.y + w.h - 10);
    } });
    const builders = { clothes: buildClothes, body: buildBody, hair: buildHair, outfits: buildOutfits, calib: buildCalib, scene: buildScene, system: buildSystem };
    out.push(...builders[ui.tab]());
    return out;
  };

  function persistOutfit() {
    const cs = av()?.clothing?.state?.();
    if (!cs) return;
    S.outfit = cs.outfit;
    S.colors = Object.fromEntries(cs.outfit.map(id => [id, cs.colors[id]]));
    settings.save();
  }
  const wear = id => { S.recent = pushRecent(S.recent, id); return av().clothing.wear(id).then(() => { persistOutfit(); board.invalidate(true); }); };

  // ---------------------------------------------------------------- colour picker (palette + hue ring)
  function colorPicker(x, y, getHex, setHex, palette, { ring = 236, side = false } = {}) {
    const out = [];
    const L = flow(x, y, x + 6 * 62, 10);
    for (const col of palette) L.add({ ...swatch(col, () => (getHex() || '').toLowerCase() === col, () => { setHex(col, true); ui.pick = null; feedback(); board.invalidate(true); }, 52) });
    out.push(...L.out);
    const rx = side ? x + 6 * 62 + 30 : x, ry = side ? y : L.y + L.rowH + 16, R = ring / 2, G = { rInner: R * 0.78, rOuter: R, half: R * 0.5 };
    const cur = () => ui.pick || hexToHsv(getHex() || '#808080');
    let lastApply = 0;
    out.push({ ...area(ring, ring, (c, w) => {
      const cx = w.x + R, cy = w.y + R, hsv = cur();
      if (c.createConicGradient) {
        const g = c.createConicGradient(-Math.PI / 2, cx, cy);
        for (let i = 0; i <= 12; i++) g.addColorStop(i / 12, hsvToHex(i * 30, 1, 1));
        c.beginPath(); c.arc(cx, cy, G.rOuter, 0, Math.PI * 2); c.arc(cx, cy, G.rInner, 0, Math.PI * 2, true); c.fillStyle = g; c.fill('evenodd');
      }
      const sx = cx - G.half, sy = cy - G.half, sw = 2 * G.half;
      c.fillStyle = hsvToHex(hsv.h, 1, 1); c.fillRect(sx, sy, sw, sw);
      let g2 = c.createLinearGradient(sx, 0, sx + sw, 0); g2.addColorStop(0, '#fff'); g2.addColorStop(1, 'rgba(255,255,255,0)'); c.fillStyle = g2; c.fillRect(sx, sy, sw, sw);
      g2 = c.createLinearGradient(0, sy, 0, sy + sw); g2.addColorStop(0, 'rgba(0,0,0,0)'); g2.addColorStop(1, '#000'); c.fillStyle = g2; c.fillRect(sx, sy, sw, sw);
      const a = (hsv.h - 90) * Math.PI / 180, rm = (G.rInner + G.rOuter) / 2;
      c.lineWidth = 4; c.strokeStyle = '#fff';
      c.beginPath(); c.arc(cx + Math.cos(a) * rm, cy + Math.sin(a) * rm, 11, 0, Math.PI * 2); c.stroke();
      c.beginPath(); c.arc(sx + hsv.s * sw, sy + (1 - hsv.v) * sw, 9, 0, Math.PI * 2); c.stroke();
    }, (lx, ly, phase) => {
      if (lx == null) { if (phase === 'up' && ui.pick) setHex(hsvToHex(ui.pick.h, ui.pick.s, ui.pick.v), true); ui.pickPart = null; return; }
      const p = pickColor(lx - R, ly - R, G);
      if (phase === 'down') ui.pickPart = p?.part ?? null;
      const hsv = { ...cur() };
      if (ui.pickPart === 'ring') { const q = pickColor(lx - R, ly - R, { ...G, rInner: 0, rOuter: 1e9 }); hsv.h = q.h; if (hsv.s < 0.15) hsv.s = 0.6; if (hsv.v < 0.15) hsv.v = 0.7; }
      else if (ui.pickPart === 'square') { hsv.s = Math.max(0, Math.min(1, (lx - R + G.half) / (2 * G.half))); hsv.v = Math.max(0, Math.min(1, 1 - (ly - R + G.half) / (2 * G.half))); }
      else return;
      ui.pick = hsv;
      const now = performance.now();
      if (phase === 'up' || now - lastApply > 90) { lastApply = now; setHex(hsvToHex(hsv.h, hsv.s, hsv.v), phase === 'up'); }
      if (phase === 'up') { ui.pickPart = null; feedback(); }
      board.invalidate();
    }), id: 'huering', x: rx, y: ry });
    out.push({ kind: 'custom', x: rx + ring + 20, y: ry + ring / 2 - 40, w: 110, h: 80, draw: c => {
      rr(c, rx + ring + 20, ry + ring / 2 - 40, 110, 80, 12); c.fillStyle = getHex() || '#808080'; c.fill(); c.lineWidth = 3; c.strokeStyle = THEME.border; c.stroke();
      c.fillStyle = THEME.muted; c.font = `500 20px ${THEME.font}`; c.textAlign = 'center'; c.fillText(getHex() || '', rx + ring + 75, ry + ring / 2 + 62);
    } });
    return out;
  }

  // ---------------------------------------------------------------- Clothes
  function buildClothes() {
    const out = [], a = av(), cat = a?.clothing?.catalog;
    if (!cat) { out.push({ ...label(t('clothLoading'), 600), x: PAD, y: CONTENT_Y }); return out; }
    const cs = a.clothing.state(), worn = cs.outfit, female = a.isFemale();
    const itemOf = id => cat.items.find(i => i.id === id);
    const slotOk = s => cat.items.some(i => i.slot === s && (!i.sex || i.sex === (female ? 'female' : 'male'))) || worn.some(w => itemOf(w)?.slot === s);
    const slots = cat.slots.filter(s => cat.items.some(i => i.slot === s) && slotOk(s));
    if (!slots.includes(ui.slot)) ui.slot = slots.find(s => s === 'top') || slots[0];
    const L = flow(PAD, CONTENT_Y, BW - PAD, 8);
    for (const s of slots) {
      const wornHere = worn.some(w => itemOf(w)?.slot === s);
      L.add({ ...btn(cat.slotLabels?.[s]?.[lang()] ?? t('slots')?.[s] ?? s, 150, () => { ui.slot = s; ui.pick = null; board.invalidate(true); }), id: `slot-${s}`, h: 64, font: 24, active: () => ui.slot === s,
        badge: wornHere });
    }
    // the toggle shows what is WORN (an empty outfit - 'None' everywhere, ?outfit=none - is naked by the
    // CharacterCreator contract even when the setting says on); pressing it turns default underwear on/off
    const underwearWorn = () => worn.some(w => isUnderwear(cat, w));
    L.add({ ...toggle(t('underwear'), 250, underwearWorn, () => {
      S.underwear = !underwearWorn(); a.clothing.setUnderwear(S.underwear).then(() => { persistOutfit(); board.invalidate(true); }); settings.save(); board.invalidate(true);
    }, t), id: 'tg-underwear', h: 64, font: 24 });
    out.push(...L.out);
    // badge dots on slot buttons with something worn
    for (const w of L.out) if (w.badge) out.push({ kind: 'custom', x: w.x + w.w - 18, y: w.y + 8, w: 12, h: 12, draw: c => { c.fillStyle = THEME.ok; c.beginPath(); c.arc(w.x + w.w - 14, w.y + 14, 6, 0, 7); c.fill(); } });
    // tile grid of the slot
    const gy = L.y + L.rowH + 18, TW = 184, TH = 204;
    const G = flow(PAD, gy, 820, 12);
    const cur = worn.find(id => itemOf(id)?.slot === ui.slot) ?? null;
    G.add({ ...tile(t('none'), TW, TH, null, () => { a.clothing.takeOff(ui.slot).then(() => { persistOutfit(); board.invalidate(true); }); feedback(); }), id: `cloth-${ui.slot}-none`, active: () => !cur,
      placeholder: (c, x, y, w, h) => drawSlotIcon(c, 'none', x, y, w, h, THEME.muted) });
    for (const it of cat.items.filter(i => i.slot === ui.slot)) {
      G.add({ ...tile(label$(it), TW, TH, () => app.thumbs?.requestGarment(it) ?? null, () => { ui.colorTarget = it.id; ui.pick = null; wear(it.id); feedback(); board.invalidate(true); }),
        id: `cloth-${it.id}`, active: () => a.clothing.state().outfit.includes(it.id), placeholder: (c, x, y, w, h) => drawSlotIcon(c, it.slot, x, y, w, h, it.colors?.primary || THEME.muted) });
    }
    out.push(...G.out);
    // recently worn
    const recent = (S.recent || []).filter(id => itemOf(id)).slice(0, 6);
    if (recent.length) {
      const ry = Math.max(G.y + G.rowH + 22, 600);
      out.push({ ...heading(t('recent'), 300), x: PAD, y: ry });
      const RL = flow(PAD, ry + 44, 820, 10);
      for (const id of recent) {
        const it = itemOf(id);
        RL.add({ ...tile(label$(it), 124, 140, () => app.thumbs?.get(app.thumbs.garmentKey(it)) ?? null, () => { ui.slot = it.slot; ui.colorTarget = id; wear(id); feedback(); }), id: `recent-${id}`, captionFont: 18,
          active: () => a.clothing.state().outfit.includes(id), placeholder: (c, x, y, w, h) => drawSlotIcon(c, it.slot, x, y, w, h, it.colors?.primary || THEME.muted) });
      }
      out.push(...RL.out);
    }
    // colours of the slot's worn garment (right column)
    const target = cur;
    const cx = 850;
    if (target) {
      const it = itemOf(target), col = a.clothing.state().colors[target];
      out.push({ ...heading(`${t('colour')}: ${label$(it)}`, 400), x: cx, y: gy - 4 });
      let y = gy + 40;
      if (it.colors?.secondary) {
        const CL = flow(cx, y, BW - PAD, 8);
        for (const w of ['primary', 'secondary']) CL.add({ ...btn(t(w === 'primary' ? 'clothPrimary' : 'clothSecondary'), 190, () => { ui.colorWhich = w; ui.pick = null; board.invalidate(true); }), h: 56, font: 22, active: () => ui.colorWhich === w, id: `colwhich-${w}` });
        out.push(...CL.out); y = CL.y + CL.rowH + 12;
      } else ui.colorWhich = 'primary';
      const which = ui.colorWhich;
      out.push(...colorPicker(cx, y, () => col?.[which], (hex, final) => { a.clothing.setColor(target, which, hex); if (final) persistOutfit(); }, GARMENT_COLORS));
    } else out.push({ ...label(t('pickToColour'), 400, { font: 22 }), x: cx, y: gy });
    return out;
  }

  // ---------------------------------------------------------------- Body
  const sliderLabel = s => (lang() === 'da' ? (t(s.id) !== s.id ? t(s.id) : s.label) : (t(s.id) !== s.id ? t(s.id) : s.id.replace(/([A-Z])/g, ' $1').replace(/^./, c => c.toUpperCase())));
  function buildBody() {
    const out = [], a = av();
    if (!a) return out;
    const female = a.isFemale();
    if (ui.bodyPage === 'breast' && !female) ui.bodyPage = 'body';
    const LT = flow(PAD, CONTENT_Y, BW - PAD, 10);
    const pages = ['body', 'face', ...(female && a.slidersOf('breast').length ? ['breast'] : [])];
    for (const p of pages) LT.add({ ...btn(t(p), 170, () => { ui.bodyPage = p; board.invalidate(true); }), h: 64, id: `page-${p}`, active: () => ui.bodyPage === p });
    if (a.sex) {
      LT.add({ ...label(t('sex'), 100, { color: THEME.fg, align: 'right' }), h: 64 });
      for (const o of a.sex.options) LT.add({ ...btn(t(o) !== o ? t(o) : o, 160, () => {
        a.sex.set(o).then(() => { persistOutfit(); app.syncIKBody?.(); board.invalidate(true); });
        S.body = { ...S.body, gender: a.values.gender }; settings.save(); app.syncIKBody?.(); feedback(); board.invalidate(true);
      }), h: 64, id: `sex-${o}`, active: () => a.sex.get() === o });
    }
    out.push(...LT.out);
    let y = LT.y + LT.rowH + 20;
    const list = a.slidersOf(ui.bodyPage);
    const twoCol = list.length > 7, colW = twoCol ? (BW - 2 * PAD - 30) / 2 : BW - 2 * PAD;
    const rows = twoCol ? Math.ceil(list.length / 2) : list.length;
    const rowH = Math.min(72, (FOOT_Y - 130 - y) / Math.max(1, rows));
    list.forEach((s, i) => {
      const col = twoCol ? Math.floor(i / rows) : 0, row = twoCol ? i % rows : i;
      out.push({ ...slider(sliderLabel(s), colW, -1, 1, () => a.values[s.id] ?? 0, (v, final) => {
        a.setSlider(s.id, v);
        S.body = { ...S.body, [s.id]: +v.toFixed(3) };
        if (s.group === 'breast') app.syncIKBody?.();
        if (final) { settings.save(); a.breast?.reset?.(); }
      }, { trackX: twoCol ? 210 : 260, valueW: 80, step: 0.01, throttle: 90 }), id: `slider-${s.id}`, x: PAD + col * (colW + 30), y: y + row * rowH, h: Math.min(64, rowH - 4) });
    });
    y += rows * rowH + 12;
    if (ui.bodyPage === 'body') {
      out.push({ ...heading(t('skin'), 180), x: PAD, y: y + 8, h: 52 });
      const L = flow(PAD + 190, y, BW - PAD, 10);
      for (const col of SKIN_COLORS) L.add(swatch(col, () => (a.values.skin || '').toLowerCase() === col, () => { a.setSkin(col); S.skin = col; settings.save(); feedback(); board.invalidate(); }, 56));
      out.push(...L.out);
    } else if (ui.bodyPage === 'breast') {
      const L = flow(PAD, y, BW - PAD, 12);
      L.add({ ...toggle(t('breastPhysics'), 330, () => S.breastPhysics !== false, () => { S.breastPhysics = S.breastPhysics === false; a.breast?.reset?.(); settings.save(); board.invalidate(true); }, t), id: 'tg-breastPhysics' });
      L.add({ kind: 'custom', w: 640, h: 72, draw: (c, w) => {
        const b = a.breast?.state?.() || {};
        c.fillStyle = THEME.muted; c.font = `500 22px ${THEME.font}`; c.textAlign = 'left';
        c.fillText(fitText(c, `${t('physicsScale')} ${(b.scale ?? 0).toFixed(2)} · ${t('support')} ${(b.support ?? 0).toFixed(2)}`, w.w), w.x, w.y + w.h / 2);
      } });
      out.push(...L.out);
    }
    return out;
  }

  // ---------------------------------------------------------------- Hair
  function buildHair() {
    const out = [], a = av();
    if (!a) return out;
    out.push({ ...heading(t('hairStyle'), 400), x: PAD, y: CONTENT_Y });
    const L = flow(PAD, CONTENT_Y + 46, BW - PAD, 12);
    const TW = 124, TH = 150;
    L.add({ ...tile(t('none'), TW, TH, null, () => { a.setHair(null); S.hair = null; settings.save(); feedback(); board.invalidate(true); }), id: 'hair-none', active: () => !a.hair,
      placeholder: (c, x, y, w, h) => drawSlotIcon(c, 'none', x, y, w, h, THEME.muted) });
    for (const st of a.hairManifest?.styles || []) {
      L.add({ ...tile(label$(st), TW, TH, () => app.thumbs?.requestHair(st, a.values.hairColor) ?? null, () => {
        S.hair = st.id; settings.save(); feedback();
        Promise.resolve(a.setHair(st.id)).then(() => board.invalidate(true));
        board.invalidate(true);
      }), id: `hair-${st.id}`, captionFont: 20, active: () => a.hair === st.id, placeholder: (c, x, y, w, h) => drawSlotIcon(c, 'hair', x, y, w, h, a.values.hairColor || THEME.muted) });
    }
    out.push(...L.out);
    const y = L.y + L.rowH + 24;
    out.push({ ...heading(t('hairColor'), 400), x: PAD, y });
    out.push(...colorPicker(PAD, y + 46, () => a.values.hairColor, (hex, final) => { a.setHairColor(hex); if (final) { S.hairColor = hex; settings.save(); } }, HAIR_COLORS, { ring: 250, side: true }));
    return out;
  }

  // ---------------------------------------------------------------- Outfits / character / photo
  function snapshotCharacter(name = '') {
    const a = av(), cs = a.clothing.state();
    return makeCharacter({ name, sex: a.sex?.get?.() ?? (a.isFemale() ? 'female' : 'male'), body: a.bodyValues(), skin: a.values.skin, hair: a.hair, hairColor: a.values.hairColor, outfit: cs.outfit, colors: cs.colors });
  }
  const known = () => { const a = av(); return { sliders: a.sliders.map(s => s.id), garments: a.clothing.catalog?.items.map(i => i.id), hairs: (a.hairManifest?.styles || []).map(s => s.id) }; };
  async function applyCharacter(ch) {
    const a = av();
    if (ch.sex && a.sex) await a.sex.set(ch.sex);
    for (const [k, v] of Object.entries(ch.body || {})) if (k !== 'gender') a.values[k] = v;
    a.setSlider('gender', a.values.gender);          // one update() for everything
    if (ch.skin) a.setSkin(ch.skin);
    await a.clothing.setOutfit(ch.outfit);
    for (const [id, c] of Object.entries(ch.colors || {})) { if (c.primary) a.clothing.setColor(id, 'primary', c.primary); if (c.secondary) a.clothing.setColor(id, 'secondary', c.secondary); }
    await a.setHair(ch.hair);
    if (ch.hairColor) a.setHairColor(ch.hairColor);
    S.body = a.bodyValues(); S.skin = a.values.skin; S.hair = a.hair; S.hairColor = a.values.hairColor;
    persistOutfit(); settings.save(); app.syncIKBody?.();
    if (S.calibration.userEye) app.calibrate(S.calibration.userEye, { useStoredSpan: true });
    invalidateAll();
  }
  app.applyCharacter = applyCharacter;
  app.snapshotCharacter = snapshotCharacter;
  function exportCharacter() {
    const ch = snapshotCharacter();
    const text = JSON.stringify(ch, null, 1);
    try {
      const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
      const aEl = Object.assign(document.createElement('a'), { href: url, download: `character-${stamp()}.json` });
      document.body.append(aEl); aEl.click(); aEl.remove(); setTimeout(() => URL.revokeObjectURL(url), 5000);
      toast(t('exported'));
    } catch (e) { toast(`${t('exportFailed')}: ${e.message}`); }
    return ch;
  }
  function importCharacter() {
    const inp = Object.assign(document.createElement('input'), { type: 'file', accept: '.json,application/json' });
    inp.onchange = async () => {
      const f = inp.files?.[0]; if (!f) return;
      const r = parseCharacter(await f.text(), known());
      if (!r.ok) { toast(`${t('importFailed')}: ${r.error}`); feedback('error'); return; }
      await applyCharacter(r.character);
      toast(`${t('imported')}${r.warnings.length ? ` (${r.warnings.length} ${t('warnings')})` : ''}`);
    };
    inp.click();
  }
  app.importCharacterText = async text => { const r = parseCharacter(text, known()); if (r.ok) await applyCharacter(r.character); return r; };

  /** quality.js reasons are English fragments (also logged); translate the known ones for the UI. */
  const REASONS = [['standalone / mobile browser', 'reason_mobile'], ['desktop browser', 'reason_desktop'], ['software renderer', 'reason_software'], ['integrated GPU', 'reason_igpu'], ['benchmark', 'reason_benchmark']];
  function reasonText(r) { let out = String(r || ''); for (const [en, k] of REASONS) out = out.split(en).join(t(k)); return out; }

  function takePhoto(framing) {
    const go = () => {
      try {
        const c = app.photo.take({ framing });
        ui.photo = c; feedback('shutter');
        app.photo.download(c).then(n => toast(n ? `${t('photoSaved')}: ${n}` : t('photoFailed')));
        board.invalidate(true);
      } catch (e) { toast(`${t('photoFailed')}: ${e.message}`); }
    };
    if (app.mode === 'xr') { ui.photoCountdown = 3; ui.photoGo = go; } else go();
  }
  app.takePhoto = takePhoto;

  function buildOutfits() {
    const out = [], a = av();
    if (!a?.clothing?.catalog) return out;
    out.push({ ...heading(t('outfitSlots'), 500), x: PAD, y: CONTENT_Y });
    let y = CONTENT_Y + 46;
    for (const n of ['1', '2', '3']) {
      const p = S.outfitSlots?.[n];
      const L = flow(PAD, y, 790, 10);
      L.add({ ...label(`${t('slot')} ${n}`, 110, { color: THEME.fg, font: 24 }), h: 64 });
      L.add({ ...btn(t('saveHere'), 180, () => { S.outfitSlots = { ...(S.outfitSlots || {}), [n]: makeOutfitPreset({ ...a.clothing.state(), hair: a.hair, hairColor: a.values.hairColor }) }; settings.save(); toast(`${t('saved')}: ${t('slot')} ${n}`); feedback(); board.invalidate(true); }), id: `outfit-save-${n}`, h: 64, font: 24 });
      L.add({ ...btn(t('wearThis'), 180, async () => {
        if (!p) return;
        await a.clothing.setOutfit(p.outfit);
        for (const [id, c] of Object.entries(p.colors || {})) { if (c.primary) a.clothing.setColor(id, 'primary', c.primary); if (c.secondary) a.clothing.setColor(id, 'secondary', c.secondary); }
        if (p.hair !== undefined) { await a.setHair(p.hair); S.hair = p.hair; }
        if (p.hairColor) { a.setHairColor(p.hairColor); S.hairColor = p.hairColor; }
        persistOutfit(); feedback(); board.invalidate(true);
      }), id: `outfit-wear-${n}`, h: 64, font: 24, disabled: !p });
      L.add({ ...label(p ? p.outfit.map(id => label$(a.clothing.catalog.items.find(i => i.id === id))).join(', ') : t('empty'), 230, { font: 20 }), h: 64 });
      out.push(...L.out);
      y = L.y + L.rowH + 10;
    }
    y += 16;
    out.push({ ...heading(t('character'), 500), x: PAD, y });
    y += 46;
    const list = store.list();
    for (const n of ['1', '2', '3']) {
      const L = flow(PAD, y, 790, 10);
      L.add({ ...label(`${t('slot')} ${n}`, 110, { color: THEME.fg, font: 24 }), h: 64 });
      L.add({ ...btn(t('saveHere'), 180, () => { const ok = store.save(n, snapshotCharacter(`${t('slot')} ${n}`)); toast(ok ? `${t('saved')}: ${t('character')} ${n}` : t('storageFailed')); feedback(ok ? 'click' : 'error'); board.invalidate(true); }), id: `char-save-${n}`, h: 64, font: 24 });
      L.add({ ...btn(t('load'), 180, async () => {
        const r = store.load(n, known());
        if (!r.ok) { toast(t('empty')); return; }
        await applyCharacter(r.character); toast(`${t('loaded')}: ${t('character')} ${n}`); feedback();
      }), id: `char-load-${n}`, h: 64, font: 24, disabled: !list[n] });
      L.add({ ...label(list[n] ? `${list[n].sex === 'female' ? t('female') : t('male')} · ${(list[n].created || '').slice(0, 10)}` : t('empty'), 230, { font: 20 }), h: 64 });
      out.push(...L.out);
      y = L.y + L.rowH + 10;
    }
    const E = flow(PAD, y + 6, 790, 10);
    E.add({ ...btn(t('exportJson'), 260, () => exportCharacter()), id: 'char-export', h: 64, font: 24 });
    E.add({ ...btn(t('importJson'), 260, () => importCharacter()), id: 'char-import', h: 64, font: 24 });
    out.push(...E.out);
    // photo
    const px = 800;
    out.push({ ...heading(t('photo'), 300), x: px, y: CONTENT_Y });
    const PL = flow(px, CONTENT_Y + 46, BW - PAD, 10);
    PL.add({ ...btn(t('photoFull'), 210, () => takePhoto('full')), id: 'photo-full', h: 64, font: 24 });
    PL.add({ ...btn(t('photoPortrait'), 210, () => takePhoto('portrait')), id: 'photo-portrait', h: 64, font: 24 });
    out.push(...PL.out);
    out.push({ kind: 'custom', x: px, y: PL.y + PL.rowH + 14, w: 430, h: 520, draw: (c, w) => {
      rr(c, w.x, w.y, w.w, w.h, 14); c.fillStyle = THEME.panel; c.fill();
      if (ui.photo) { const k = Math.min((w.w - 16) / ui.photo.width, (w.h - 16) / ui.photo.height), dw = ui.photo.width * k, dh = ui.photo.height * k; c.drawImage(ui.photo, w.x + (w.w - dw) / 2, w.y + (w.h - dh) / 2, dw, dh); }
      else { c.fillStyle = THEME.muted; c.font = `500 22px ${THEME.font}`; c.textAlign = 'center'; c.fillText(t('photoHint'), w.x + w.w / 2, w.y + w.h / 2); }
    } });
    return out;
  }

  // ---------------------------------------------------------------- Calibration
  function buildCalib() {
    const out = [], L = flow(PAD, CONTENT_Y, BW - PAD, 10);
    const seg = (title, opts, get, set, w = 170, idp = '') => {
      L.newline(); L.add({ ...label(title, 240, { color: THEME.fg }), h: 64 });
      for (const [v, txt] of opts) L.add({ ...btn(txt, w, () => { set(v); feedback(); board.invalidate(true); }), h: 64, font: 24, active: () => get() === v, id: `${idp}${v}` });
    };
    L.add({ ...btn(t('calibrateTPose'), 460, () => { app.startCalibration(); feedback(); board.invalidate(true); }), id: 'calibrate', h: 84, font: 30, color: THEME.accent });
    L.add({ ...label(t('calibrateHint'), 700), h: 84 });
    seg(t('profile'), ['A', 'B', 'C'].map(u => [u, u]), () => S.user, v => { app.setUser(v); toast(`${t('profile')} ${v}`); }, 100, 'user-');
    seg(t('calibMode'), [['morph', t('morph')], ['scale', t('scale')], ['own', t('own')], ['off', t('off')]], () => S.calibration.mode, v => app.setCalibrationMode(v), 190, 'cmode-');
    seg(t('armMode'), [['match', t('match')], ['proportional', t('proportional')]], () => S.armMode, v => { S.armMode = v; app.applyIKOptions(); settings.save(); }, 230, 'arm-');
    L.newline(10);
    out.push(...L.out);
    let y = L.y;
    const c = S.calibration;
    const lines = [
      `${t('calibModeHelp_' + c.mode)}`,
      c.userEye ? `${t('eye')}: ${c.userEye.toFixed(3)} m (~${(c.userEye / 0.936).toFixed(2)} m ${t('tall')}) · ${t('profile')} ${S.user}${c.time ? ` · ${c.time.slice(0, 16).replace('T', ' ')}` : ''}` : t('notCalibrated'),
      `${t('scale')} ${(c.scale ?? 1).toFixed(3)} · ${t('worldScale')} ${(c.mode === 'own' ? c.worldScale ?? 1 : 1).toFixed(3)} · ${t('span')} ${c.span ? `${c.span.toFixed(2)} m` : '-'} · ${t('armScale')} ${(c.armScale ?? 1).toFixed(3)}`,
    ];
    for (const ln of lines) { out.push({ ...label(ln, BW - 2 * PAD, { font: 24 }), x: PAD, y, h: 40 }); y += 44; }
    const R = flow(PAD, y + 16, BW - PAD, 10);
    R.add({ ...btn(t('resetCalib'), 360, () => { app.resetCalibration(); toast(t('resetCalib')); board.invalidate(true); }), id: 'reset-calib', h: 64, font: 24 });
    R.add({ ...btn(t('recenter'), 300, () => recenterPanels()), id: 'recenter', h: 64, font: 24 });
    out.push(...R.out);
    return out;
  }

  // ---------------------------------------------------------------- Scene
  function buildScene() {
    const a = av();
    const L = flow(PAD, CONTENT_Y, BW - PAD, 10);
    const tg = (key, w, get, set) => L.add({ ...toggle(t(key), w, get, () => { set(!get()); feedback('toggle'); board.invalidate(true); }, t), id: `tg-${key}`, h: 68, font: 24 });
    tg('mirror', 290, () => S.mirror, v => { S.mirror = v; app.mirror.setEnabled(v); settings.save(); });
    tg('handMirror', 290, () => S.handMirror, v => { S.handMirror = v; app.handMirror.setEnabled(v && app.mode === 'xr'); settings.save(); });
    tg('floorReflection', 290, () => !!S.floorReflection, v => { S.floorReflection = v; app.floorMirror.setEnabled(v); settings.save(); });
    tg('cloth', 290, () => S.cloth, v => { S.cloth = v; a?.cloth?.setEnabled(v); settings.save(); });
    tg('ghostHands', 290, () => S.ghostHands !== false, v => { S.ghostHands = v; app.ghosts.setEnabled(v); settings.save(); });
    tg('handCollision', 290, () => S.handCollision !== false, v => { S.handCollision = v; app.applyIKOptions(); settings.save(); });
    tg('kneel', 290, () => S.kneel, v => { S.kneel = v; app.applyIKOptions(); settings.save(); });
    tg('perfHud', 290, () => !!S.perfHud, v => { S.perfHud = v; hud.setVisible(v); settings.save(); });
    L.newline();
    L.add({ ...slider(t('wind'), 600, 0, 1, () => S.wind, (v, final) => { S.wind = v; a?.cloth?.setWind(v); if (final) settings.save(); }, { trackX: 150, valueW: 80, step: 0.05 }), id: 'slider-wind' });
    const seg = (title, opts, get, set, w = 170, idp = '') => {
      L.newline(); L.add({ ...label(title, 240, { color: THEME.fg }), h: 64 });
      for (const [v, txt] of opts) L.add({ ...btn(txt, w, () => { set(v); feedback(); board.invalidate(true); }), h: 64, font: 24, active: () => get() === v, id: `${idp}${v}` });
    };
    seg(t('locomotion'), [['clips', t('clips')], ['procedural', t('procedural')]], () => S.locomotion, v => { S.locomotion = v; app.applyIKOptions(); settings.save(); }, 220, 'loco-');
    seg(t('sit'), [['auto', t('auto')], ['off', t('off')]], () => S.sit, v => { S.sit = v; app.applyIKOptions(); settings.save(); }, 170, 'sit-');
    seg(t('quality'), [['auto', t('auto')], ['high', t('high')], ['medium', t('medium')], ['low', t('low')]], () => S.quality, v => { app.setQuality(v); toast(`${t('quality')}: ${t(app.quality)} (${reasonText(app.qualityReason)})`); }, 160, 'q-');
    L.add({ ...toggle(t('autoQuality'), 260, () => S.autoQuality !== false, () => { S.autoQuality = S.autoQuality === false; app.autoScaler.state.enabled = S.autoQuality; settings.save(); board.invalidate(true); }, t), id: 'tg-autoQuality', h: 64, font: 22 });
    L.newline();
    L.add({ ...slider(`${t('resolution')}*`, 600, 0.5, 1.2, () => S.framebufferScale ?? app.preset.framebufferScale, (v, final) => { S.framebufferScale = +v.toFixed(2); if (final) { settings.save(); toast(t('nextSession')); } }, { trackX: 230, valueW: 80, step: 0.05 }), id: 'slider-fbscale' });
    L.x += 24;                                       // keep the foveation label clear of the resolution value
    L.add({ ...slider(t('foveation'), 600, 0, 1, () => S.foveation ?? 0.5, (v, final) => { app.setFoveation(+v.toFixed(2)); }, { trackX: 200, valueW: 80, step: 0.05 }), id: 'slider-foveation' });
    L.newline();
    L.add({ ...btn(t('foveationAuto'), 300, () => { app.setFoveation(null); board.invalidate(true); }), id: 'foveation-auto', h: 56, font: 22, active: () => S.foveation == null });
    L.add({ ...label(`* ${t('nextSession')} · ${t('quality')}: ${t(app.quality)} (${reasonText(app.qualityReason)}) · ${t('level')} ${app.level}`, 860, { font: 20 }), h: 56 });
    return L.out;
  }

  // ---------------------------------------------------------------- System
  function buildSystem() {
    const L = flow(PAD, CONTENT_Y, BW - PAD, 10);
    const pages = [['main', t('general')], ['runtime', t('runtime')]];
    for (const [p, txt] of pages) L.add({ ...btn(txt, 320, () => { ui.sysPage = p; if (p === 'runtime') app.features && (app.features.time = new Date().toISOString()); board.invalidate(true); }), id: `sys-${p}`, h: 64, font: 24, active: () => ui.sysPage === p });
    if (ui.sysPage === 'runtime') { L.newline(); return [...L.out, ...runtimeRows(L.y)]; }
    const seg = (title, opts, get, set, w = 150, idp = '') => {
      L.newline(); L.add({ ...label(title, 240, { color: THEME.fg }), h: 64 });
      for (const [v, txt] of opts) L.add({ ...btn(txt, w, () => { set(v); feedback(); board.invalidate(true); }), h: 64, font: 24, active: () => get() === v, id: `${idp}${v}` });
    };
    seg(t('language'), [['da', 'Dansk'], ['en', 'English']], () => S.lang, v => { S.lang = v; settings.save(); document.documentElement.lang = v; app.updateDomText?.(); invalidateAll(); }, 180, 'lang-');
    seg(t('dominant'), [['left', t('left')], ['right', t('right')]], () => S.dominant, v => { S.dominant = v; app.applyIKOptions(); settings.save(); }, 180, 'dom-');
    L.newline();
    const tg = (key, w, get, set) => L.add({ ...toggle(t(key), w, get, () => { set(!get()); feedback('toggle'); board.invalidate(true); }, t), id: `tg-${key}`, h: 64, font: 24 });
    tg('sound', 280, () => S.sound !== false, v => { S.sound = v; settings.save(); });
    tg('haptics', 280, () => S.haptics !== false, v => { S.haptics = v; settings.save(); });
    tg('smoothHands', 300, () => S.smoothHands !== false, v => { S.smoothHands = v; settings.save(); });
    L.newline();
    L.add({ ...btn(t('showTutorial'), 280, () => showTutorial(true)), id: 'tutorial', h: 64, font: 24 });
    L.add({ ...toggle(t('fingerDebug'), 280, () => ui.debugVisible, () => { setDebugVisible(!ui.debugVisible); board.invalidate(true); }, t), id: 'tg-fingerDebug', h: 64, font: 24 });
    tg('handDebug', 280, () => S.handDebug, v => { S.handDebug = v; settings.save(); });
    L.newline(14);
    L.add({ ...btn(ui.resetArmed && performance.now() - ui.resetArmed < 4000 ? t('resetConfirm') : t('resetAll'), 460, () => {
      if (!ui.resetArmed || performance.now() - ui.resetArmed > 4000) { ui.resetArmed = performance.now(); board.invalidate(true); return; }
      ui.resetArmed = 0; resetAll();
    }), id: 'reset-all', h: 72, color: THEME.danger });
    L.add({ ...btn(t('resetBoard'), 360, () => { S.panel = null; placeBoardDefault(); settings.save(); }), id: 'reset-board', h: 72, font: 26 });
    L.newline(16);
    L.add({ ...label(t('unverified'), BW - 2 * PAD, { color: THEME.warn, font: 24 }) });
    return L.out;
  }
  function runtimeRows(y0) {
    const rows = describeRuntime(app.features);
    if (!rows.length) return [{ ...label(t('probing'), 600), x: PAD, y: y0 }];
    return [{ kind: 'custom', x: PAD, y: y0, w: BW - 2 * PAD, h: FOOT_Y - y0 - 14, draw: (c, w) => {
      c.textBaseline = 'middle'; c.textAlign = 'left';
      const lh = 34, colW = rows.length > 22 ? (w.w - 20) / 2 : w.w, per = Math.floor((w.h) / lh);
      rows.forEach((r, i) => {
        const col = Math.floor(i / per), row = i % per, x = w.x + col * (colW + 20), y = w.y + row * lh + lh / 2;
        c.fillStyle = r.ok === true ? THEME.ok : r.ok === false ? THEME.danger : THEME.muted;
        c.beginPath(); c.arc(x + 7, y, 6, 0, 7); c.fill();
        c.font = `600 23px ${THEME.font}`; c.fillStyle = THEME.fg; c.fillText(fitText(c, r.key, 290), x + 22, y);
        c.font = `500 23px ${THEME.font}`; c.fillStyle = THEME.muted; c.fillText(fitText(c, r.value, colW - 340), x + 330, y);
      });
    } }];
  }

  function resetAll() {
    const a = av();
    settings.reset();
    if (a) {
      a.resetBody();
      a.clothing?.reset?.();
      a.setHair(a.hairManifest?.default ?? null);
      if (a.hairManifest?.defaultColor) a.setHairColor(a.hairManifest.defaultColor);
      a.setSkin(a.defaultTints?.skin ?? '#e0ac8a');
      a.cloth?.setEnabled(S.cloth); a.cloth?.setWind(S.wind);
    }
    app.scale = 1; app.worldScale = 1; app.calibrationMsg = '';
    app.mirror.setEnabled(S.mirror); app.floorMirror.setEnabled(!!S.floorReflection); app.ghosts.setEnabled(true);
    placeBoardDefault();
    app.applyIKOptions(); app.syncIKBody?.();
    app.fingers?.setTable(app.fingerTableBase);
    settings.save();
    invalidateAll();
    toast(t('resetAll'));
  }

  // ---------------------------------------------------------------- wrist menu
  const wrist = createPanel({ name: 'WristMenu', px: [512, 320], size: [0.13, 0.081], radius: 22 });
  wrist.setVisible(false);
  scene.add(wrist.group);
  wrist.build = () => {
    const L = flow(16, 16, 512 - 16, 12);
    const b = (txt, id, fn, active) => L.add({ ...btn(txt, 234, fn), id, h: 132, font: 34, active });
    b(t('menu'), 'w-menu', () => toggleBoard(), () => board.visible);
    b(t('mirror'), 'w-mirror', () => { S.mirror = !S.mirror; app.mirror.setEnabled(S.mirror); settings.save(); board.invalidate(true); wrist.invalidate(); }, () => S.mirror);
    L.newline();
    b(t('calibrateShort'), 'w-calib', () => { app.startCalibration(); });
    b(t('recenter'), 'w-recenter', () => recenterPanels());
    return L.out;
  };
  let wristShown = false;
  // The menu lives on the inside of the non-dominant forearm and shows while the PALM faces the eyes. Its "up"
  // follows the viewer's up projected onto the panel, so the text stays upright however the wrist is turned.
  const hq = new THREE.Quaternion(), hp = new THREE.Vector3(), toHead = new THREE.Vector3(), nrm = new THREE.Vector3(), off = new THREE.Vector3();
  const hq2 = new THREE.Quaternion(), ax = new THREE.Vector3(), ay = new THREE.Vector3(), fw = new THREE.Vector3(), wm = new THREE.Matrix4(), UP = new THREE.Vector3(0, 1, 0);
  function updateWrist(rec) {
    const nd = S.dominant === 'right' ? 'left' : 'right';
    const h = rec?.hands?.[nd];
    wrist.ownerSide = nd;
    if (app.mode !== 'xr' || !h?.valid) { if (wrist.visible) wrist.setVisible(false); wristShown = false; return; }
    hq.fromArray(h.quat); hp.fromArray(h.pos);
    nrm.set(0, -1, 0).applyQuaternion(hq);
    fw.set(0, 0, 1).applyQuaternion(hq);
    const s = app.worldScale || 1;
    off.set(0, -0.03 * s, -0.075 * s).applyQuaternion(hq);
    wrist.group.position.copy(hp).add(off);
    wrist.group.scale.setScalar(s);
    toHead.fromArray(rec.head.pos).sub(wrist.group.position);
    const d = toHead.length() / s; toHead.normalize();
    const facing = nrm.dot(toHead);
    wristShown = wristShown ? facing > 0.45 && d < 0.8 : facing > 0.7 && d < 0.65;
    if (wrist.visible !== wristShown) { wrist.setVisible(wristShown); wrist.invalidate(true); }
    if (!wristShown) return;
    ay.set(0, 1, 0).applyQuaternion(hq2.fromArray(rec.head.quat));
    ay.addScaledVector(nrm, -nrm.dot(ay));
    if (ay.lengthSq() < 0.01) { ay.copy(UP).addScaledVector(nrm, -nrm.dot(UP)); if (ay.lengthSq() < 0.01) ay.copy(fw).addScaledVector(nrm, -nrm.dot(fw)); }
    ay.normalize();
    ax.crossVectors(ay, nrm).normalize();
    wm.makeBasis(ax, ay, nrm);
    wrist.group.quaternion.setFromRotationMatrix(wm);
    wrist.group.updateMatrixWorld();
  }
  function toggleBoard() {
    const show = !board.visible;
    board.setVisible(show);
    if (show && app.rec?.head) {
      const hpos = new THREE.Vector3().fromArray(app.rec.head.pos);
      if (hpos.distanceTo(board.group.position) > 2.2) placeBoardDefault(app.rec.head);
    }
    wrist.invalidate();
  }
  function recenterPanels() {
    if (!app.rec?.head) return;
    board.setVisible(true);
    placeBoardDefault(app.rec.head);
    S.panel = { pos: board.group.position.toArray(), quat: board.group.quaternion.toArray() }; settings.save();
    feedback('toggle'); toast(t('recentered'));
  }
  app.recenter = recenterPanels;

  // ---------------------------------------------------------------- hint panel (countdowns), perf HUD, tutorial
  const hint = createPanel({ name: 'Hint', px: [768, 176], size: [0.44, 0.1], live: 8, radius: 26 });
  hint.setVisible(false); scene.add(hint.group);
  hint.build = () => [{ kind: 'custom', x: 0, y: 0, w: 768, h: 176, draw: c => {
    c.textAlign = 'center'; c.textBaseline = 'middle'; c.fillStyle = THEME.fg;
    const fl = app.calibFlow.state;
    let a = '', b = '';
    if (fl.phase === 'countdown') { a = `${t('tposeNow')} ${Math.ceil(fl.left)}`; b = t('calibrateHint'); }
    else if (fl.phase === 'sample') { a = t('holdStill'); b = `${t('sampling')} ${Math.max(0, fl.left).toFixed(1)} s`; }
    else if (ui.photoCountdown > 0) { a = `${t('photo')} ${Math.ceil(ui.photoCountdown)}`; b = t('photoPose'); }
    else if (recenter.state.progress > 0.05) { a = t('recenter'); b = `${Math.round(recenter.state.progress * 100)} %`; }
    c.font = `700 52px ${THEME.font}`; c.fillText(fitText(c, a, 730), 384, 64);
    c.font = `500 28px ${THEME.font}`; c.fillStyle = THEME.muted; c.fillText(fitText(c, b, 730), 384, 128);
  } }];
  const hud = createPanel({ name: 'PerfHUD', px: [640, 232], size: [0.4, 0.145], live: 4, radius: 20 });
  hud.setVisible(!!S.perfHud); scene.add(hud.group);
  hud.build = () => [{ kind: 'custom', x: 0, y: 0, w: 640, h: 232, draw: c => {
    const p = app.perf, cl = app.avatar?.cloth?.stats?.();
    c.textAlign = 'left'; c.textBaseline = 'top'; c.fillStyle = THEME.fg; c.font = `600 30px ${THEME.font}`;
    c.fillText(`${p.fps.toFixed(0)} fps · ${t('level')} ${app.level} · ${t(app.quality)}`, 22, 16);
    c.font = `500 26px ${THEME.font}`; c.fillStyle = THEME.fg;
    c.fillText(`frame ${p.frame.toFixed(2)} ms · IK ${p.ik.toFixed(2)} · cloth ${p.cloth.toFixed(2)}`, 22, 62);
    c.fillText(`shadow ${p.shadow.toFixed(2)} · mirror ${p.mirror.toFixed(2)} · submit ${p.render.toFixed(2)} (CPU)`, 22, 96);
    c.fillText(`draw calls ${p.calls} · tris ${(p.tris / 1000).toFixed(1)} k${cl?.garments != null ? ` · cloth ${cl.garments}` : ''}`, 22, 130);
    c.fillStyle = app.mode === 'xr' ? THEME.muted : THEME.warn; c.font = `500 22px ${THEME.font}`;
    c.fillText(app.mode === 'xr' ? t('perfCpuNote') : t('perfDesktopNote'), 22, 176);
  } }];
  // tilt: face the eyes (not just turn about y) - for panels below eye height (tutorial, HUD)
  const follow = (P, dist, dx, dy, k, tilt = false) => {
    const h = app.rec?.head; if (!h) return;
    const s = app.worldScale || 1;
    hq.fromArray(h.quat); fw.set(0, 0, -1).applyQuaternion(hq); fw.y = 0; if (fw.lengthSq() < 1e-4) fw.set(0, 0, -1); fw.normalize();
    ax.set(-fw.z, 0, fw.x);
    hp.fromArray(h.pos).addScaledVector(fw, dist * s).addScaledVector(ax, dx * s); hp.y += dy * s;
    if (P.group.position.distanceToSquared(hp) > 0.25 * s * s || !P._placed) { P.group.position.copy(hp); P._placed = true; }
    else P.group.position.lerp(hp, k);
    P.group.scale.setScalar(s);
    toHead.fromArray(h.pos); P.group.lookAt(toHead.x, tilt ? toHead.y : P.group.position.y, toHead.z); P.group.updateMatrixWorld();
  };

  const tut = createPanel({ name: 'Tutorial', px: [960, 560], size: [0.72, 0.42], radius: 28 });
  tut.setVisible(false); scene.add(tut.group);
  const TUT = ['tut1', 'tut2', 'tut3', 'tut4', 'tut5'];
  tut.build = () => {
    const out = [{ kind: 'custom', x: 0, y: 0, w: 960, h: 420, draw: c => {
      const k = TUT[ui.tutorialStep];
      c.textAlign = 'left'; c.textBaseline = 'top'; c.fillStyle = THEME.accent; c.font = `600 26px ${THEME.font}`;
      c.fillText(`${t('tutorial')} ${ui.tutorialStep + 1}/${TUT.length}`, 40, 34);
      c.fillStyle = THEME.fg; c.font = `700 44px ${THEME.font}`; c.fillText(fitText(c, t(`${k}Title`), 880), 40, 80);
      c.font = `500 30px ${THEME.font}`; c.fillStyle = THEME.fg;
      wrapText(c, t(`${k}Text`), 40, 150, 880, 42);
    } }];
    const L = flow(40, 450, 920, 16);
    L.add({ ...btn(t('skip'), 240, () => closeTutorial()), id: 'tut-skip', h: 76 });
    L.add({ ...btn(ui.tutorialStep < TUT.length - 1 ? t('next') : t('done'), 300, () => { if (ui.tutorialStep < TUT.length - 1) { ui.tutorialStep++; tut.invalidate(true); feedback(); } else closeTutorial(); }), id: 'tut-next', h: 76, active: true });
    out.push(...L.out);
    return out;
  };
  function showTutorial(force = false) {
    if (!force && S.tutorialDone) return;
    ui.tutorialStep = 0; tut._placed = false; tut.setVisible(true); tut.invalidate(true);
    if (!app.rec?.head) { tut.group.position.set(0, 1.2, -0.45); tut.group.lookAt(0, 1.55, 0.4); tut.group.updateMatrixWorld(); tut._placed = true; }
  }
  function closeTutorial() { tut.setVisible(false); S.tutorialDone = true; settings.save(); feedback(); }
  app.showTutorial = showTutorial;

  // ---------------------------------------------------------------- finger debug panel
  const dbg = createPanel({ name: 'FingerDebug', px: [1024, 1024], size: [0.6, 0.6], live: 10 });
  scene.add(dbg.group);
  dbgPanel = dbg;
  function placeDebug() {
    dbg.group.quaternion.copy(board.group.quaternion); dbg.group.rotateY(-0.4);
    dbg.group.position.copy(board.group.position).add(new THREE.Vector3(0.9, 0, 0.05).applyQuaternion(board.group.quaternion));
    dbg.group.updateMatrixWorld();
  }
  placeDebug();
  function setDebugVisible(v) {
    ui.debugVisible = v; dbg.setVisible(v); if (v) { placeDebug(); dbg.invalidate(true); }
    const host = document.getElementById('dom-ui');
    if (host) {
      host.innerHTML = '';
      if (v) { dbg.canvas.style.width = 'min(380px, 40vw)'; dbg.canvas.style.borderRadius = '10px'; host.append(dbg.canvas); }
    }
    wrist.invalidate(); board.invalidate(true);
  }
  const bars = (c, x, y, w, h, v, color) => {
    c.fillStyle = THEME.track; c.fillRect(x, y, w, h);
    if (v > 0) { c.fillStyle = color; c.fillRect(x, y, w * Math.min(1, v), h); }
  };
  dbg.build = () => {
    const out = [];
    out.push({ kind: 'custom', x: 0, y: 0, w: 1024, h: 900, draw: drawDebug });
    const L = flow(20, 906, 1004, 10);
    L.add({ ...btn(t('save'), 235, () => downloadDiagnostics()), id: 'dbg-save', h: 64, font: 22 });
    L.add({ ...btn(app.recorder.recording ? `■ ${t('saveRecording')}` : '● REC', 235, () => {
      if (app.recorder.recording) { app.recorder.stop(); downloadRecording(); } else { app.recorder.start(); toast('REC'); }
      dbg.invalidate(true);
    }), id: 'dbg-rec', h: 64, font: 22, active: () => app.recorder.recording });
    L.add({ ...btn(`${t('learnSide')} L`, 110, () => startWizard('left')), id: 'dbg-learn-l', h: 64, font: 22 });
    L.add({ ...btn(`${t('learnSide')} R`, 110, () => startWizard('right')), id: 'dbg-learn-r', h: 64, font: 22 });
    L.add({ ...btn(t('clearLearned'), 250, () => { S.fingerOverride = null; settings.save(); app.fingers.setTable(app.fingerTableBase); toast(t('clearLearned')); }), id: 'dbg-clear', h: 64, font: 22 });
    return [...out, ...L.out];
  };
  function drawDebug(c) {
    const T = THEME, rec = app.rec, fo = app.fingerOut;
    c.textBaseline = 'top'; c.textAlign = 'left';
    c.fillStyle = T.fg; c.font = `600 30px ${T.font}`;
    c.fillText(`${t('fingerDebug')} · ${app.mode}${app.xrInfo?.refSpace ? ` · ${app.xrInfo.refSpace}` : ''} · ${app.perf.fps.toFixed(0)} fps`, 20, 16);
    c.font = `500 20px ${T.font}`; c.fillStyle = T.warn;
    c.fillText(t('unverified'), 20, 52);
    if (ui.wizard) {
      const z = ui.wizard, step = z.steps[z.i];
      c.fillStyle = T.accent; c.font = `600 26px ${T.font}`;
      const what = step === 'open' ? t('learnOpen') : `${t('learnFinger')}: ${step}`;
      c.fillText(`${t('learn')} (${z.side}) ${z.i + 1}/${z.steps.length}: ${what} - ${z.phase === 'wait' ? `${t('hold')} ${Math.ceil(z.left)}` : t('sampling')}`, 20, 80);
    } else if (ui.toast && performance.now() - ui.toastT < 6000) { c.fillStyle = T.ok; c.font = `500 22px ${T.font}`; c.fillText(fitText(c, ui.toast, 980), 20, 82); }
    ['left', 'right'].forEach((side, k) => {
      const x0 = 20 + k * 502, cw = 482;
      let y = 120;
      const snap = rec?.snaps?.find(s => s.handedness === side);
      const ev = fo?.[side];
      c.fillStyle = T.fg; c.font = `600 26px ${T.font}`;
      c.fillText(`${side === 'left' ? t('left') : t('right')}: ${ev?.kind ?? t('noSource')}${ev?.lost ? ` (${t('lost')})` : ''}`, x0, y); y += 34;
      c.font = `500 19px ${T.font}`; c.fillStyle = T.muted;
      const line = s => { c.fillText(fitText(c, s, cw), x0, y); y += 24; };
      line(`profiles: ${snap?.profiles?.join(', ') || '-'}`);
      line(`mode: ${snap?.targetRayMode || '-'} · hand: ${snap?.hasHand ? (snap.joints ? 'tracked' : 'present') : 'no'}`);
      line(`table: ${ev?.profile ?? '(fallback)'}`);
      const gp = snap?.gamepad;
      line(gp ? `gamepad '${gp.mapping}': ${gp.buttons.length} ${t('buttons')}, ${gp.axes.length} ${t('axes')}` : 'gamepad: -');
      y += 4;
      if (gp) {
        const n = Math.min(gp.buttons.length, 16);
        for (let i = 0; i < n; i++) {
          const b = gp.buttons[i], col = i % 2, row = i >> 1;
          const bx = x0 + col * 242, by = y + row * 26;
          c.fillStyle = T.muted; c.fillText(`b${i}`, bx, by + 2);
          bars(c, bx + 40, by + 5, 130, 14, b.value, T.accent);
          c.fillStyle = b.touched ? T.warn : T.disabled; c.beginPath(); c.arc(bx + 186, by + 12, 7, 0, 7); c.fill();
          c.fillStyle = b.pressed ? T.ok : T.disabled; c.beginPath(); c.arc(bx + 206, by + 12, 7, 0, 7); c.fill();
        }
        y += Math.ceil(n / 2) * 26 + 6;
        const na = Math.min(gp.axes.length, 8);
        for (let i = 0; i < na; i++) {
          const col = i % 2, row = i >> 1, bx = x0 + col * 242, by = y + row * 26, v = gp.axes[i];
          c.fillStyle = T.muted; c.fillText(`a${i}`, bx, by + 2);
          c.fillStyle = T.track; c.fillRect(bx + 40, by + 5, 160, 14);
          c.fillStyle = T.accent; const cx = bx + 120; c.fillRect(Math.min(cx, cx + v * 80), by + 5, Math.abs(v * 80), 14);
          c.fillStyle = T.fg; c.fillRect(cx - 1, by + 3, 2, 18);
        }
        y += Math.ceil(na / 2) * 26 + 8;
      } else y += 8;
      c.font = `500 19px ${T.font}`;
      for (const f of FINGER_KEYS) {
        const cap = f[0].toUpperCase() + f.slice(1);
        const fs = ev?.state?.[cap];
        c.fillStyle = T.fg; c.fillText(f, x0, y + 2);
        bars(c, x0 + 80, y + 5, 150, 14, fs?.curl ?? 0, ev?.paths?.[f]?.startsWith('controller-finger') ? T.ok : ev?.paths?.[f] === 'hand' ? '#b58cff' : T.accent);
        c.fillStyle = T.muted; c.fillText(fitText(c, ev?.paths?.[f] ?? '-', cw - 245), x0 + 245, y + 2);
        y += 27;
      }
    });
    const p = app.perf;
    c.fillStyle = T.muted; c.font = `500 19px ${T.font}`;
    c.fillText(`frame ${p.frame.toFixed(2)} ms · IK ${p.ik.toFixed(2)} · cloth ${p.cloth.toFixed(2)} · mirror ${p.mirror.toFixed(2)} · render ${p.render.toFixed(2)} (CPU submit)`, 20, 870);
  }

  function diagnostics() {
    const rec = app.rec;
    return {
      kind: 'ccxr-diagnostics', version: 2, time: new Date().toISOString(), userAgent: navigator.userAgent,
      note: 'Steam Frame behaviour is unverified on real hardware; this file exists to verify it.',
      mode: app.mode, xrInfo: app.xrInfo, xrSupport: app.xrSupport, quality: app.quality, qualityReason: app.qualityReason, level: app.level, perf: app.perf,
      runtime: app.features, lifecycle: app.lifecycle,
      sources: rec?.sources, snaps: rec?.snaps,
      fingers: app.fingerOut && Object.fromEntries(['left', 'right'].map(s => [s, { kind: app.fingerOut[s].kind, profile: app.fingerOut[s].profile, paths: app.fingerOut[s].paths, lost: app.fingerOut[s].lost,
        curls: Object.fromEntries(Object.entries(app.fingerOut[s].state || {}).map(([f, v]) => [f, v ? +v.curl.toFixed(3) : null])) }])),
      table: app.fingers?.table, override: S.fingerOverride, settings: { ...S, panel: undefined }, ikDebug: app.res?.debug,
    };
  }
  function download(obj, name) {
    const text = JSON.stringify(obj, null, 1);
    try { localStorage.setItem(`ccxr.${name.split('-')[0]}.last`, text.slice(0, 2_000_000)); } catch { /* quota */ }
    try {
      const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
      const aEl = Object.assign(document.createElement('a'), { href: url, download: name });
      document.body.append(aEl); aEl.click(); aEl.remove();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
    } catch (e) { console.warn('[ui] download failed', e); }
    toast(`${t('diagSaved')}: ${name}`);
  }
  const stamp = () => new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  function downloadDiagnostics() { download(diagnostics(), `diagnostics-${stamp()}.json`); }
  function downloadRecording() { download(app.recorder.fixture(), `recording-${stamp()}.json`); }
  app.diagnostics = diagnostics;

  // learn-mapping wizard: 3 s to get into the pose, 1.2 s of sampling, per step
  function startWizard(side) {
    ui.wizard = { side, steps: ['open', 'index', 'middle', 'ring', 'little', 'thumb'], i: 0, phase: 'wait', left: 3, samples: {} };
    dbg.invalidate(true);
  }
  function updateWizard(dt) {
    const z = ui.wizard;
    if (!z) return;
    z.left -= dt;
    if (z.phase === 'wait') { if (z.left <= 0) { z.phase = 'sample'; z.left = 1.2; } return; }
    const snap = app.rec?.snaps?.find(s => s.handedness === z.side);
    if (snap?.gamepad) (z.samples[z.steps[z.i]] ||= []).push({ buttons: snap.gamepad.buttons.map(b => ({ value: b.value })), axes: [...snap.gamepad.axes] });
    if (z.left > 0) return;
    z.i++; z.phase = 'wait'; z.left = 3;
    if (z.i < z.steps.length) return;
    ui.wizard = null;
    const prof = snap?.profiles?.[0] || 'unknown';
    const r = learnMapping(z.samples, prof);
    if (!r.entry) { toast(`${t('learnFail')} (${r.reason})`); return; }
    const prev = (S.fingerOverride?.profiles || []).filter(p => p.id !== r.entry.id);
    S.fingerOverride = { profiles: [r.entry, ...prev] };
    settings.save();
    app.fingers.setTable(mergeTables(app.fingerTableBase, S.fingerOverride));
    toast(`${t('learnDone')}: ${Object.keys(r.entry.fingers).join(', ')}`);
  }

  // ---------------------------------------------------------------- interaction + loop
  const panels = [board, wrist, dbg, tut, hint, hud];
  const tipTmp = new THREE.Vector3(), iTmp = new THREE.Vector3();
  const interaction = createInteraction({
    scene, camera, dom: renderer.domElement,
    getPanels: () => panels.filter(P => P !== hint && P !== hud),
    getTip(side, out) {
      const b = av()?.humanoid?.bones;
      const d = b?.[`${side}IndexDistal`], i = b?.[`${side}IndexIntermediate`];
      if (!d || !i) return false;
      d.getWorldPosition(out); i.getWorldPosition(iTmp);
      tipTmp.subVectors(out, iTmp);
      out.addScaledVector(tipTmp, 0.9);
      return true;
    },
    haptics: () => S.haptics !== false,
    onClickFeedback: () => feedback(),
    onGrabEnd(P) {
      if (P === board) { S.panel = { pos: board.group.position.toArray(), quat: board.group.quaternion.toArray() }; settings.save(); if (ui.debugVisible) placeDebug(); }
    },
  });
  function invalidateAll() { for (const P of panels) P.invalidate(true); }
  setDebugVisible(ui.debugVisible);
  addEventListener('pointerdown', () => clicker.unlock(), { once: true, capture: true });
  if (!settings.flag('shot')) setTimeout(() => showTutorial(false), 400);

  let lastFlowPhase = 'idle';
  return {
    board, wrist, debug: dbg, tutorial: tut, hint, hud, interaction, panels, state: ui, toast, clicker,
    update(rec, dt) {
      updateWrist(rec);
      interaction.update(rec);
      updateWizard(dt);
      // first frames of tracking: put the board where this user can reach it (unless they placed it)
      if (!boardPlaced && rec?.head && app.mode === 'xr') placeBoardDefault(rec.head);
      // chest height, tilted up: the mirror (straight ahead at eye height) stays visible while reading (visual review)
      if (tut.visible && app.mode === 'xr') follow(tut, 0.62, 0, -0.4, 0.05, true);
      // recenter gesture (both palms up for 1 s)
      if (app.mode === 'xr' && recenter.update(rec?.head, rec?.hands, dt)) recenterPanels();
      // hint panel: calibration / photo countdown / recenter progress
      if (ui.photoCountdown > 0) { ui.photoCountdown -= dt; if (ui.photoCountdown <= 0) { ui.photoCountdown = 0; ui.photoGo?.(); } }
      const fl = app.calibFlow.state.phase;
      const hintOn = (fl === 'countdown' || fl === 'sample' || ui.photoCountdown > 0 || recenter.state.progress > 0.05) && !!rec?.head;
      if (hint.visible !== hintOn) { hint.setVisible(hintOn); hint._placed = false; hint.invalidate(true); }
      if (hintOn) follow(hint, 0.9, 0, 0.12, 0.08);
      if (fl !== lastFlowPhase) { lastFlowPhase = fl; board.invalidate(true); if (fl === 'done' || fl === 'failed') feedback(fl === 'done' ? 'toggle' : 'error'); }
      if (hud.visible) follow(hud, 0.75, -0.5, -0.5, 0.04, true);   // low left, readable, off the mirror
      if (interaction.state.left.grab?.panel === board || interaction.state.right.grab?.panel === board) placeDebug();
      const now = performance.now();
      for (const P of panels) P.update(now);
    },
    onSessionStart(session) {
      interaction.attach(session);
      app.handMirror.setEnabled(!!S.handMirror);
      if (!S.panel) boardPlaced = false;          // re-place for this session's head pose
      session.addEventListener('end', () => { app.handMirror.setEnabled(false); wrist.setVisible(false); hint.setVisible(false); });
      if (!S.tutorialDone && !settings.flag('shot')) showTutorial(false);
      invalidateAll();
    },
    onInputSourcesChange(e) {
      const add = [...(e.added || [])].map(s => `${s.handedness}:${s.hand ? 'hand' : s.profiles?.[0] || '?'}`);
      if (add.length) toast(`+ ${add.join(', ')}`);
      dbg.invalidate(true);
    },
    setDebugVisible, toggleBoard, startWizard, downloadDiagnostics, invalidateAll, placeBoardDefault, showTutorial, recenter: recenterPanels,
    setTab(tb, page) { ui.tab = tb; if (page) { if (tb === 'body') ui.bodyPage = page; if (tb === 'clothes') ui.slot = page; if (tb === 'system') ui.sysPage = page; } board.invalidate(true); },
  };
}

function rr(c, x, y, w, h, r) {
  c.beginPath(); c.moveTo(x + r, y); c.arcTo(x + w, y, x + w, y + h, r); c.arcTo(x + w, y + h, x, y + h, r); c.arcTo(x, y + h, x, y, r); c.arcTo(x, y, x + w, y, r); c.closePath();
}
function wrapText(c, text, x, y, maxW, lh) {
  for (const para of String(text).split('\n')) {
    let line = '';
    for (const word of para.split(' ')) {
      const test = line ? `${line} ${word}` : word;
      if (c.measureText(test).width > maxW && line) { c.fillText(line, x, y); y += lh; line = word; } else line = test;
    }
    if (line) { c.fillText(line, x, y); y += lh; }
    y += lh * 0.35;
  }
}
