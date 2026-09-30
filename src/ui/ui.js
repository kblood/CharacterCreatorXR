// In-VR / desktop UI: the main board (tabs Clothes / Body / Hair / Scene / Reset) standing next to the mirror
// (grabbable), a wrist menu on the non-dominant hand, and the finger-input DEBUG panel (also shown on screen on
// desktop) with diagnostics download and the learn-mapping wizard. docs/UI.md.
import * as THREE from 'three';
import { createPanel, flow, btn, toggle, slider, label, swatch, THEME, fitText } from './panel.js';
import { createInteraction } from './interact.js';
import { mergeTables, learnMapping, FINGER_KEYS } from '../input/fingerInput.js';

const GARMENT_COLORS = ['#f2f2f2', '#1e1e1e', '#7a7f87', '#2f5f9e', '#3d5f8c', '#8c2f39', '#2f7a4f', '#e08a2c', '#d9c29a', '#6b4a8c', '#c8558a', '#4b4b52'];
const SKIN_COLORS = ['#f6d7c3', '#eec1a4', '#c99a80', '#e0ac8a', '#c68863', '#a86b48', '#8a5236', '#6b3b25', '#4a281a'];
const HAIR_COLORS = ['#0f0c0a', '#2b1d14', '#3b2a1e', '#5a3a22', '#8a5a33', '#b8864f', '#d9b27a', '#e8d3a8', '#9a9a9a', '#e6e6e6', '#8c2f1f', '#3a4f8c'];
const TABS = ['clothes', 'body', 'hair', 'scene', 'reset'];
const TAB_KEYS = { clothes: 'tabClothes', body: 'tabBody', hair: 'tabHair', scene: 'tabScene', reset: 'reset' };

export function createUI(app) {
  const { settings, t, scene, camera, renderer } = app;
  const S = settings.values;
  const av = () => app.avatar;
  const ui = { tab: 'clothes', bodyPage: 'body', colorTarget: null, resetArmed: 0, wizard: null, toast: '', toastT: 0, debugVisible: !!settings.flag('debug') };
  const lang = () => S.lang;

  // ---------------------------------------------------------------- board
  const board = createPanel({ name: 'Board', px: [1024, 736], size: [0.92, 0.66], live: 2 });
  board.grabbable = true;
  scene.add(board.group);
  function placeBoardDefault() {
    const eye = S.calibration.userEye || 1.6;
    board.group.position.set(1.0, Math.max(0.9, eye - 0.32), -0.8);
    board.group.lookAt(0, Math.max(0.9, eye - 0.32), 0.4);
    board.group.updateMatrixWorld();
  }
  if (S.panel?.pos && S.panel?.quat) { board.group.position.fromArray(S.panel.pos); board.group.quaternion.fromArray(S.panel.quat); board.group.updateMatrixWorld(); }
  else placeBoardDefault();

  const W = 1024, PAD = 28, CONTENT_Y = 104, FOOT_Y = 672;
  board.drawBackground = c => {
    c.fillStyle = THEME.fg; c.font = `600 34px ${THEME.font}`; c.textBaseline = 'middle'; c.textAlign = 'left';
    c.fillStyle = THEME.muted; c.font = `500 22px ${THEME.font}`;
    c.textAlign = 'right'; c.fillText(t('grab'), W - PAD, 30);
    c.fillStyle = THEME.border; c.fillRect(PAD, CONTENT_Y - 14, W - 2 * PAD, 2); c.fillRect(PAD, FOOT_Y - 8, W - 2 * PAD, 2);
    c.textAlign = 'left'; c.fillStyle = THEME.muted; c.font = `500 22px ${THEME.font}`;
    c.fillText(fitText(c, statusLine(), W - 2 * PAD), PAD, FOOT_Y + 26);
  };
  function statusLine() {
    const p = app.perf, mode = app.mode === 'xr' ? `XR ${app.xrInfo?.refSpace || ''}` : app.mode;
    const toast = ui.toast && performance.now() - ui.toastT < 5000 ? ` · ${ui.toast}` : app.calibrationMsg ? ` · ${app.calibrationMsg}` : '';
    return `${mode} · ${p.fps.toFixed(0)} fps · IK ${p.ik.toFixed(2)} ms · ${t('mirror').toLowerCase()} ${p.mirror.toFixed(1)} ms${toast}`;
  }
  const toast = msg => { ui.toast = msg; ui.toastT = performance.now(); board.invalidate(); };

  board.build = () => {
    const out = [];
    // tab row
    const L = flow(PAD, 18, W - 236, 8);
    for (const tb of TABS) {
      L.add({ ...btn(t(TAB_KEYS[tb]), 140, () => { ui.tab = tb; ui.resetArmed = 0; board.invalidate(true); }), id: `tab-${tb}`, kind: 'tab', active: () => ui.tab === tb, h: 58 });
    }
    out.push(...L.out);
    out.push({ kind: 'custom', id: 'grabbar', x: W - 240, y: 12, w: 212, h: 64, interactive: true, grab: true, draw: (c, w, hov) => {
      c.fillStyle = hov ? THEME.buttonHover : 'rgba(255,255,255,0.04)'; c.fillRect(w.x, w.y, w.w, w.h);
      c.fillStyle = THEME.muted; for (let i = 0; i < 3; i++) c.fillRect(w.x + 60, w.y + 40 + i * 7, 92, 3);
    } });
    const tabBuilders = { clothes: buildClothes, body: buildBody, hair: buildHair, scene: buildScene, reset: buildReset };
    out.push(...tabBuilders[ui.tab]());
    return out;
  };

  function persistOutfit() {
    const cs = av()?.clothing?.state?.();
    if (!cs) return;
    S.outfit = cs.outfit;
    S.colors = Object.fromEntries(cs.outfit.map(id => [id, cs.colors[id]]));
    settings.save();
  }

  function buildClothes() {
    const out = [], a = av(), cat = a?.clothing?.catalog;
    if (!cat) { out.push({ ...label(t('clothLoading'), 600), x: PAD, y: CONTENT_Y }); return out; }
    const worn = a.clothing.state().outfit;
    let y = CONTENT_Y;
    for (const slot of cat.slots) {
      const items = cat.items.filter(i => i.slot === slot);
      if (!items.length) continue;
      const L = flow(PAD + 170, y, W - PAD, 10);
      out.push({ ...label(t('slots')?.[slot] ?? cat.slotLabels?.[slot]?.[lang()] ?? slot, 160, { color: THEME.fg }), x: PAD, y: y + 10 });
      const cur = worn.find(id => cat.items.find(i => i.id === id)?.slot === slot) ?? null;
      L.add({ ...btn(t('none'), 130, () => { a.clothing.takeOff(slot).then(() => { persistOutfit(); board.invalidate(true); }); }), id: `cloth-${slot}-none`, active: () => !cur });
      for (const it of items) {
        L.add({ ...btn(it.label?.[lang()] ?? it.label?.da ?? it.id, 170, () => {
          ui.colorTarget = it.id;
          a.clothing.wear(it.id).then(() => { persistOutfit(); board.invalidate(true); });
          board.invalidate(true);
        }), id: `cloth-${it.id}`, active: () => a.clothing.state().outfit.includes(it.id) });
      }
      out.push(...L.out);
      y = L.y + L.rowH + 16;
    }
    // colours of one worn garment
    const target = worn.includes(ui.colorTarget) ? ui.colorTarget : worn[0];
    if (target) {
      const it = cat.items.find(i => i.id === target), cs = a.clothing.state().colors[target];
      y += 6;
      out.push({ ...label(`${t('clothPrimary')}: ${it.label?.[lang()] ?? it.id}`, 400, { color: THEME.fg }), x: PAD, y });
      // choose which worn garment to colour
      const LT = flow(PAD + 420, y - 6, W - PAD, 8);
      for (const id of worn) LT.add({ ...btn(cat.items.find(i => i.id === id)?.label?.[lang()] ?? id, 120, () => { ui.colorTarget = id; board.invalidate(true); }), h: 46, font: 22, active: id === target });
      out.push(...LT.out);
      y = Math.max(y + 48, LT.y + LT.rowH + 10);
      const L1 = flow(PAD, y, W - PAD, 10);
      for (const col of GARMENT_COLORS) L1.add(swatch(col, () => cs?.primary?.toLowerCase() === col, () => { a.clothing.setColor(target, 'primary', col); persistOutfit(); board.invalidate(true); }, 50));
      out.push(...L1.out);
      y = L1.y + L1.rowH + 10;
      if (it.colors?.secondary) {
        out.push({ ...label(t('clothSecondary'), 300, { color: THEME.fg }), x: PAD, y });
        const L2 = flow(PAD, y + 44, W - PAD, 10);
        for (const col of GARMENT_COLORS) L2.add(swatch(col, () => cs?.secondary?.toLowerCase() === col, () => { a.clothing.setColor(target, 'secondary', col); persistOutfit(); board.invalidate(true); }, 50));
        out.push(...L2.out);
      }
    }
    return out;
  }

  const sliderLabel = s => (lang() === 'da' ? (t(s.id) !== s.id ? t(s.id) : s.label) : (t(s.id) !== s.id ? t(s.id) : s.id.replace(/([A-Z])/g, ' $1').replace(/^./, c => c.toUpperCase())));

  function buildBody() {
    const out = [], a = av();
    if (!a) return out;
    const LT = flow(PAD, CONTENT_Y, W - PAD, 10);
    LT.add({ ...btn(t('body'), 150, () => { ui.bodyPage = 'body'; board.invalidate(true); }), h: 50, active: ui.bodyPage === 'body' });
    LT.add({ ...btn(t('face'), 150, () => { ui.bodyPage = 'face'; board.invalidate(true); }), h: 50, active: ui.bodyPage === 'face' });
    if (a.sex) {
      LT.add({ ...label(t('sex'), 90, { color: THEME.fg }), h: 50 });
      for (const o of a.sex.options) LT.add({ ...btn(t(o) !== o ? t(o) : o, 130, () => { a.sex.set(o); S.body = { ...S.body, gender: a.values.gender }; settings.save(); board.invalidate(true); }), h: 50, id: `sex-${o}`, active: () => a.sex.get() === o });
    }
    out.push(...LT.out);
    let y = LT.y + LT.rowH + 18;
    const list = a.sliders.filter(s => (s.group || 'body') === ui.bodyPage);
    const twoCol = list.length > 8, colW = twoCol ? (W - 2 * PAD - 30) / 2 : W - 2 * PAD;
    const rows = twoCol ? Math.ceil(list.length / 2) : list.length;
    const rowH = Math.min(62, (FOOT_Y - 90 - y) / rows);
    list.forEach((s, i) => {
      const col = twoCol ? Math.floor(i / rows) : 0, row = twoCol ? i % rows : i;
      out.push({ ...slider(sliderLabel(s), colW, -1, 1, () => a.values[s.id] ?? 0, (v, final) => {
        a.setSlider(s.id, v);
        S.body = { ...S.body, [s.id]: +v.toFixed(3) };
        if (final) settings.save();
      }, { trackX: twoCol ? 190 : 240, valueW: 70, step: 0.01, throttle: 90 }), id: `slider-${s.id}`, x: PAD + col * (colW + 30), y: y + row * rowH, h: Math.min(56, rowH - 4) });
    });
    y += rows * rowH + 8;
    if (ui.bodyPage === 'body') {
      out.push({ ...label(t('skin'), 180, { color: THEME.fg }), x: PAD, y: y + 6, h: 50 });
      const L = flow(PAD + 190, y, W - PAD, 10);
      for (const col of SKIN_COLORS) L.add(swatch(col, () => (a.values.skin || '').toLowerCase() === col, () => { a.setSkin(col); S.skin = col; settings.save(); board.invalidate(); }, 50));
      out.push(...L.out);
    }
    return out;
  }

  function buildHair() {
    const out = [], a = av();
    if (!a) return out;
    out.push({ ...label(t('hairStyle'), 400, { color: THEME.fg }), x: PAD, y: CONTENT_Y });
    const L = flow(PAD, CONTENT_Y + 50, W - PAD, 10);
    L.add({ ...btn(t('none'), 170, () => { a.setHair(null); S.hair = null; settings.save(); board.invalidate(true); }), id: 'hair-none', active: () => !a.hair });
    for (const st of a.hairManifest?.styles || []) {
      L.add({ ...btn(st.label?.[lang()] ?? st.label?.da ?? st.id, 170, () => {
        Promise.resolve(a.setHair(st.id)).then(() => board.invalidate(true)); S.hair = st.id; settings.save(); board.invalidate(true);
      }), id: `hair-${st.id}`, active: () => a.hair === st.id });
    }
    out.push(...L.out);
    const y = L.y + L.rowH + 28;
    out.push({ ...label(t('hairColor'), 400, { color: THEME.fg }), x: PAD, y });
    const L2 = flow(PAD, y + 50, W - PAD, 10);
    for (const col of HAIR_COLORS) L2.add(swatch(col, () => (a.values.hairColor || '').toLowerCase() === col, () => { a.setHairColor(col); S.hairColor = col; settings.save(); board.invalidate(); }, 58));
    out.push(...L2.out);
    return out;
  }

  function seg(L, title, options, get, set, w = 150) {
    L.newline(); L.add({ ...label(title, 230, { color: THEME.fg }), h: 54 });
    for (const [val, txt, extra] of options) L.add({ ...btn(txt, w, () => { set(val); board.invalidate(true); }), h: 54, active: () => get() === val, ...(extra || {}) });
  }

  function buildScene() {
    const a = av(), ik = app.ik;
    const L = flow(PAD, CONTENT_Y, W - PAD, 10);
    const tg = (key, w, get, set) => L.add({ ...toggle(t(key), w, get, () => { set(!get()); board.invalidate(true); }, t), id: `tg-${key}`, h: 54 });
    tg('mirror', 225, () => S.mirror, v => { S.mirror = v; app.mirror.setEnabled(v); settings.save(); });
    tg('handMirror', 225, () => S.handMirror, v => { S.handMirror = v; app.handMirror.setEnabled(v && app.mode === 'xr'); settings.save(); });
    tg('cloth', 225, () => S.cloth, v => { S.cloth = v; a?.cloth?.setEnabled(v); settings.save(); });
    tg('handDebug', 225, () => S.handDebug, v => { S.handDebug = v; settings.save(); });
    L.newline();
    L.add({ ...slider(t('wind'), 470, 0, 1, () => S.wind, (v, final) => { S.wind = v; a?.cloth?.setWind(v); if (final) settings.save(); }, { trackX: 120, valueW: 70, step: 0.05 }), id: 'slider-wind' });
    L.add({ ...toggle(t('fingerDebug'), 225, () => ui.debugVisible, () => { setDebugVisible(!ui.debugVisible); board.invalidate(true); }, t), id: 'tg-fingerDebug', h: 54 });
    L.add({ ...toggle(t('kneel'), 225, () => S.kneel, () => { S.kneel = !S.kneel; if (ik) ik.options.kneelSide = S.kneel ? S.dominant : null; settings.save(); board.invalidate(true); }, t), id: 'tg-kneel', h: 54 });
    L.newline();
    L.add({ ...btn(t('calibrate'), 300, () => { const r = app.calibrate(); toast(r?.ok ? app.calibrationMsg : t('calibrateHint')); board.invalidate(true); }), id: 'calibrate', h: 54 });
    L.add({ ...label(t('calibrateHint'), 600), h: 54 });
    seg(L, t('calibMode'), [['morph', t('morph')], ['scale', t('scale')], ['off', t('off')]], () => S.calibration.mode, v => { S.calibration.mode = v; if (v === 'off') { app.scale = 1; } settings.save(); }, 130);
    seg(L, t('armMode'), [['match', t('match')], ['proportional', t('proportional')]], () => S.armMode, v => { S.armMode = v; if (ik) ik.options.armScale = v === 'proportional' ? (S.calibration.armScale || 1) : 1; settings.save(); }, 200);
    seg(L, t('locomotion'), [['procedural', t('procedural')], ['clips', `${t('clips')} (${t('notImplemented')})`, { disabled: true, w: 330 }]], () => S.locomotion, v => { S.locomotion = v; settings.save(); }, 200);
    seg(L, t('dominant'), [['left', t('left')], ['right', t('right')]], () => S.dominant, v => { S.dominant = v; if (ik && S.kneel) ik.options.kneelSide = v; settings.save(); }, 130);
    L.add({ ...label(t('language'), 120, { color: THEME.fg, align: 'right' }), h: 54 });
    for (const lg of ['da', 'en']) L.add({ ...btn(lg.toUpperCase(), 80, () => { S.lang = lg; settings.save(); invalidateAll(); document.documentElement.lang = lg; }), h: 54, active: () => S.lang === lg, id: `lang-${lg}` });
    seg(L, t('quality'), [['high', t('high')], ['medium', t('medium')], ['low', t('low')], ['auto', t('auto')]], () => S.quality, v => {
      S.quality = v; settings.save();
      const q = v === 'auto' ? app.quality : v;
      app.mirror.setQuality(q === 'high' ? 'high' : q === 'medium' ? 'medium' : 'low');
      toast(`${t('quality')}: ${t(v)} (VR restart for resolution)`);
    }, 130);
    return L.out;
  }

  function buildReset() {
    const a = av();
    const L = flow(PAD, CONTENT_Y, W - PAD, 14);
    L.add({ ...btn(ui.resetArmed && performance.now() - ui.resetArmed < 4000 ? t('resetConfirm') : t('resetAll'), 460, () => {
      if (!ui.resetArmed || performance.now() - ui.resetArmed > 4000) { ui.resetArmed = performance.now(); board.invalidate(true); return; }
      ui.resetArmed = 0;
      resetAll();
    }), id: 'reset-all', h: 70, color: THEME.danger });
    L.newline();
    L.add({ ...btn(t('resetCalib'), 460, () => { Object.assign(S.calibration, { userEye: null, height: null, scale: 1, armScale: 1 }); app.scale = 1; a?.setSlider('height', S.body?.height ?? 0); app.calibrationMsg = ''; settings.save(); toast(t('resetCalib')); }), id: 'reset-calib', h: 64 });
    L.newline();
    L.add({ ...btn(t('resetBoard'), 460, () => { S.panel = null; placeBoardDefault(); settings.save(); }), id: 'reset-board', h: 64 });
    L.newline(20);
    L.add({ ...label(t('unverified'), W - 2 * PAD, { color: THEME.warn }) });
    return L.out;
  }

  function resetAll() {
    const a = av();
    settings.reset();
    if (a) {
      for (const s of a.sliders) a.values[s.id] = 0;
      a.setSlider('height', 0);
      a.clothing?.reset?.();
      a.setHair(a.hairManifest?.default ?? null);
      if (a.hairManifest?.defaultColor) a.setHairColor(a.hairManifest.defaultColor);
      a.setSkin(a.defaultTints?.skin ?? '#e0ac8a');
      a.cloth?.setEnabled(S.cloth); a.cloth?.setWind(S.wind);
    }
    app.scale = 1; app.calibrationMsg = '';
    app.mirror.setEnabled(S.mirror);
    placeBoardDefault();
    if (app.ik) { app.ik.options.armScale = 1; app.ik.options.kneelSide = S.kneel ? S.dominant : null; }
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
    b(t('calibrate'), 'w-calib', () => { const r = app.calibrate(); toast(r?.ok ? app.calibrationMsg : t('calibrateHint')); });
    b(t('fingerDebug'), 'w-debug', () => setDebugVisible(!ui.debugVisible), () => ui.debugVisible);
    return L.out;
  };
  let wristShown = false;
  // The menu lives on the inside of the non-dominant forearm and shows while the PALM faces the eyes (the back
  // of the hand faces the eyes all the time when using the hands in front of you). Its "up" follows the
  // viewer's up projected onto the panel, so the text stays upright however the wrist is turned.
  const hq = new THREE.Quaternion(), hp = new THREE.Vector3(), toHead = new THREE.Vector3(), nrm = new THREE.Vector3(), off = new THREE.Vector3();
  const hq2 = new THREE.Quaternion(), ax = new THREE.Vector3(), ay = new THREE.Vector3(), fw = new THREE.Vector3(), wm = new THREE.Matrix4(), UP = new THREE.Vector3(0, 1, 0);
  function updateWrist(rec) {
    const nd = S.dominant === 'right' ? 'left' : 'right';
    const h = rec?.hands?.[nd];
    wrist.ownerSide = nd;
    if (app.mode !== 'xr' || !h?.valid) { if (wrist.visible) wrist.setVisible(false); wristShown = false; return; }
    hq.fromArray(h.quat); hp.fromArray(h.pos);
    nrm.set(0, -1, 0).applyQuaternion(hq);                  // palm normal
    fw.set(0, 0, 1).applyQuaternion(hq);                    // fingers
    off.set(0, -0.03, -0.075).applyQuaternion(hq);          // palm side of the forearm, behind the wrist
    wrist.group.position.copy(hp).add(off);
    toHead.fromArray(rec.head.pos).sub(wrist.group.position);
    const d = toHead.length(); toHead.multiplyScalar(1 / (d || 1));
    const facing = nrm.dot(toHead);
    wristShown = wristShown ? facing > 0.45 && d < 0.8 : facing > 0.7 && d < 0.65;
    if (wrist.visible !== wristShown) { wrist.setVisible(wristShown); wrist.invalidate(true); }
    if (!wristShown) return;
    // up = the viewer's up (head orientation) projected onto the panel: upright as seen from the eyes
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
      // bring it in front of the user when it is far away / behind
      const hpos = new THREE.Vector3().fromArray(app.rec.head.pos);
      if (hpos.distanceTo(board.group.position) > 2.2) {
        const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(new THREE.Quaternion().fromArray(app.rec.head.quat)); fwd.y = 0; fwd.normalize();
        board.group.position.copy(hpos).addScaledVector(fwd, 0.75); board.group.position.y -= 0.25;
        board.group.lookAt(hpos.x, board.group.position.y, hpos.z); board.group.updateMatrixWorld();
      }
    }
    wrist.invalidate();
  }

  // ---------------------------------------------------------------- finger debug panel
  const dbg = createPanel({ name: 'FingerDebug', px: [1024, 1024], size: [0.6, 0.6], live: 10 });
  scene.add(dbg.group);
  function placeDebug() {
    // right of the board (away from the mirror), same facing
    dbg.group.quaternion.copy(board.group.quaternion); dbg.group.rotateY(-0.4);
    dbg.group.position.copy(board.group.position).add(new THREE.Vector3(0.8, 0, 0.05).applyQuaternion(board.group.quaternion));
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
    const L = flow(20, 910, 1004, 10);
    L.add({ ...btn(t('save'), 235, () => downloadDiagnostics()), id: 'dbg-save', h: 50, font: 22 });
    L.add({ ...btn(app.recorder.recording ? `■ ${t('saveRecording')}` : '● REC', 235, () => {
      if (app.recorder.recording) { app.recorder.stop(); downloadRecording(); } else { app.recorder.start(); toast('REC'); }
      dbg.invalidate(true);
    }), id: 'dbg-rec', h: 50, font: 22, active: () => app.recorder.recording });
    L.add({ ...btn(`${t('learnSide')} L`, 110, () => startWizard('left')), id: 'dbg-learn-l', h: 50, font: 22 });
    L.add({ ...btn(`${t('learnSide')} R`, 110, () => startWizard('right')), id: 'dbg-learn-r', h: 50, font: 22 });
    L.add({ ...btn(t('clearLearned'), 250, () => { S.fingerOverride = null; settings.save(); app.fingers.setTable(app.fingerTableBase); toast(t('clearLearned')); }), id: 'dbg-clear', h: 50, font: 22 });
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
    } else if (ui.toast && performance.now() - ui.toastT < 6000) { c.fillStyle = T.ok; c.font = `500 22px ${T.font}`; c.fillText(ui.toast, 20, 82); }
    const sides = ['left', 'right'];
    sides.forEach((side, k) => {
      const x0 = 20 + k * 502, cw = 482;
      let y = 120;
      const snap = rec?.snaps?.find(s => s.handedness === side);
      const ev = fo?.[side];
      c.fillStyle = T.fg; c.font = `600 26px ${T.font}`;
      c.fillText(`${side === 'left' ? t('left') : t('right')}: ${ev?.kind ?? t('noSource')}`, x0, y); y += 34;
      c.font = `500 19px ${T.font}`; c.fillStyle = T.muted;
      const line = s => { c.fillText(fitText(c, s, cw), x0, y); y += 24; };
      line(`profiles: ${snap?.profiles?.join(', ') || '-'}`);
      line(`mode: ${snap?.targetRayMode || '-'} · hand: ${snap?.hasHand ? (snap.joints ? 'tracked' : 'present') : 'no'}`);
      line(`table: ${ev?.profile ?? '(fallback)'}`);
      const gp = snap?.gamepad;
      line(gp ? `gamepad '${gp.mapping}': ${gp.buttons.length} ${t('buttons')}, ${gp.axes.length} ${t('axes')}` : 'gamepad: -');
      y += 4;
      if (gp) {
        // buttons: index, value bar, touched / pressed dots
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
      // per finger: path + curl
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
    // perf block
    const p = app.perf;
    c.fillStyle = T.muted; c.font = `500 19px ${T.font}`;
    c.fillText(`frame ${p.frame.toFixed(2)} ms · IK ${p.ik.toFixed(2)} · cloth ${p.cloth.toFixed(2)} · mirror ${p.mirror.toFixed(2)} · render ${p.render.toFixed(2)} (CPU submit)`, 20, 870);
  }

  function diagnostics() {
    const rec = app.rec;
    return {
      kind: 'ccxr-diagnostics', version: 1, time: new Date().toISOString(), userAgent: navigator.userAgent,
      note: 'Steam Frame behaviour is unverified on real hardware; this file exists to verify it.',
      mode: app.mode, xrInfo: app.xrInfo, xrSupport: app.xrSupport, quality: app.quality, perf: app.perf,
      sources: rec?.sources, snaps: rec?.snaps,
      fingers: app.fingerOut && Object.fromEntries(['left', 'right'].map(s => [s, { kind: app.fingerOut[s].kind, profile: app.fingerOut[s].profile, paths: app.fingerOut[s].paths,
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
    console.log(`[ui] ${name}`, obj);
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
    console.log('[ui] learned mapping', r);
  }

  // ---------------------------------------------------------------- interaction + loop
  const panels = [board, wrist, dbg];
  const tipTmp = new THREE.Vector3(), iTmp = new THREE.Vector3();
  const interaction = createInteraction({
    scene, camera, dom: renderer.domElement,
    getPanels: () => panels,
    getTip(side, out) {
      const b = av()?.humanoid?.bones;
      const d = b?.[`${side}IndexDistal`], i = b?.[`${side}IndexIntermediate`];
      if (!d || !i) return false;
      d.getWorldPosition(out); i.getWorldPosition(iTmp);
      tipTmp.subVectors(out, iTmp);
      out.addScaledVector(tipTmp, 0.9);          // distal bone head -> approximate fingertip
      return true;
    },
    onGrabEnd(P) {
      if (P === board) { S.panel = { pos: board.group.position.toArray(), quat: board.group.quaternion.toArray() }; settings.save(); if (ui.debugVisible) placeDebug(); }
    },
  });
  function invalidateAll() { for (const P of panels) P.invalidate(true); }
  setDebugVisible(ui.debugVisible);

  return {
    board, wrist, debug: dbg, interaction, panels, state: ui, toast,
    update(rec, dt) {
      updateWrist(rec);
      interaction.update(rec);
      updateWizard(dt);
      if (interaction.state.left.grab?.panel === board || interaction.state.right.grab?.panel === board) placeDebug();
      const now = performance.now();
      for (const P of panels) P.update(now);
    },
    onSessionStart(session) {
      interaction.attach(session);
      app.handMirror.setEnabled(!!S.handMirror);
      session.addEventListener('end', () => { app.handMirror.setEnabled(false); wrist.setVisible(false); });
      invalidateAll();
    },
    onInputSourcesChange(e) {
      const add = [...(e.added || [])].map(s => `${s.handedness}:${s.hand ? 'hand' : s.profiles?.[0] || '?'}`);
      if (add.length) toast(`+ ${add.join(', ')}`);
      dbg.invalidate(true);
    },
    setDebugVisible, toggleBoard, startWizard, downloadDiagnostics, invalidateAll, placeBoardDefault,
    setTab(tb, page) { ui.tab = tb; if (page) ui.bodyPage = page; board.invalidate(true); },
  };
}
