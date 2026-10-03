// SPDX-License-Identifier: GPL-3.0-or-later
// CharacterCreator XR: boot, frame loop, glue. Per frame:
//   tracking (XR | desktop | replay) -> ('own' scale: tracked world scaled) -> calibration -> finger input layer ->
//   VRIK solve -> avatar pose + placement -> eyes / hair / breast / cloth -> blob shadows, ghost hands, UI ->
//   shadow-map pass and mirror passes (head visible) -> main render (own head hidden in first person).
import * as THREE from 'three';
import { createSettings, DEFAULTS } from './settings.js';
import { makeT } from './i18n.js';
import { createAvatar, LAYERS } from './avatar.js';
import { createRoom, ROOM, SHADOW_LAYER } from './room.js';
import { createMirror } from './mirror.js';
import { createVRIK } from './ik/vrik.js';
import { solveHeight, createHeightEstimator, solveArmScale, createCalibrationFlow, detectTPose } from './ik/calibrate.js';
import { fingerStateFromCurls } from './ik/fingers.js';
import { createFingerInput, mergeTables } from './input/fingerInput.js';
import { createXRTracking, GRIP_WRIST_OFFSET } from './xr/tracking.js';
import { xrSupport, startSession } from './xr/session.js';
import { createDesktop } from './desktop.js';
import { sampleFixture, createRecorder } from './replay.js';
import { createUI } from './ui/ui.js';
import { createHandDebug } from './ui/handdebug.js';
import { PRESETS, pickPreset, createAutoScaler, LEVELS, levelOfPreset, gpuBenchmark, gpuString } from './quality.js';
import { probeRuntime, probeSession } from './features.js';
import { createBlobShadow } from './render/blobshadow.js';
import { createGhostHands } from './ghosthands.js';
import { createThumbnails } from './render/thumbs.js';
import { createPhoto } from './render/photo.js';

const settings = createSettings();
const S = settings.values;
const P = settings.params;
const t = makeT(() => S.lang);
const SHOT = settings.flag('shot');
if (SHOT) document.body.classList.add('shot');
document.documentElement.lang = S.lang;
/** Static DOM text in the current language (desktop help line). */
function updateDomText() { const h = document.getElementById('help'); if (h) h.textContent = t('desktopHelp'); }
const statusEl = document.getElementById('status');
const setStatus = (msg, err = false) => { if (statusEl) { statusEl.textContent = msg || ''; statusEl.className = err ? 'error' : ''; } };

// ---- renderer / quality ----
const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: SHOT, powerPreference: 'high-performance' });
const gpu = gpuString(renderer);
let qualityPick = S.quality === 'auto' ? pickPreset({ ua: navigator.userAgent, gpu }) : { name: S.quality, reason: 'chosen' };
const Q = { ...PRESETS[qualityPick.name] };
renderer.setPixelRatio(Math.min(devicePixelRatio || 1, Q.pixelRatio));
renderer.setSize(innerWidth, innerHeight);
renderer.toneMapping = THREE.NeutralToneMapping;
// the shadow map is always enabled; shadows are switched with the key light's castShadow (no program rebuilds of
// every material), and it is rendered by shadowPass() with the head visible, never during the main render
renderer.shadowMap.enabled = true;
renderer.shadowMap.autoUpdate = false;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.info.autoReset = false;            // totals over all passes of a frame (perf HUD)
renderer.xr.enabled = true;
document.body.prepend(renderer.domElement);
const scene = new THREE.Scene();
// near 1 cm: three's WebXRManager passes camera.near to the session (depthNear), so hands close to the face do not
// clip; far 60 m keeps enough depth precision at that near plane for this small room (+ the 30 m sky dome)
const camera = new THREE.PerspectiveCamera(75, innerWidth / innerHeight, 0.01, 60);
camera.layers.enable(LAYERS.MONO); camera.layers.enable(LAYERS.UI);
// 'own' scale mode: the camera's parent is scaled; three's WebXRManager multiplies the XR camera poses by the
// parent's matrixWorld, and the tracking records are scaled the same way (scaleRecord), so everything matches
const userRig = new THREE.Group(); userRig.name = 'UserRig';
userRig.add(camera); scene.add(userRig);
addEventListener('resize', () => { if (renderer.xr.isPresenting) return; camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix(); renderer.setSize(innerWidth, innerHeight); });

const room = createRoom(scene, renderer, { shadows: true, shadowSize: Q.shadowSize });
room.setShadows(Q.shadows);
const mirror = createMirror({ renderer, scene, width: ROOM.mirrorWidth, height: ROOM.mirrorHeight, quality: Q.mirror });
mirror.group.position.copy(room.mirrorRect.center);
scene.add(mirror.group);
mirror.setEnabled(S.mirror);
const handMirror = createMirror({ renderer, scene, width: 0.16, height: 0.22, quality: 'low', name: 'HandMirror', tint: 0.95 });
handMirror.setEnabled(false);
scene.add(handMirror.group);
// optional floor reflection: the same per-eye mirror lying on the floor, faint (one more scene pass per eye)
const floorMirror = createMirror({ renderer, scene, width: 3.2, height: 2.8, quality: 'medium', name: 'FloorReflection', tint: 1, opacity: 0.22 });
floorMirror.group.rotation.x = -Math.PI / 2; floorMirror.group.position.set(0, 0.006, ROOM.mirrorZ + 1.5);
scene.add(floorMirror.group);
floorMirror.setEnabled(!!S.floorReflection);
const blob = createBlobShadow(scene);
const ghosts = createGhostHands(scene);
ghosts.setEnabled(S.ghostHands !== false);
// shadow-only pass: a camera that sees only the key light's extra layer renders no mesh into a 1x1 target
const shadowCam = new THREE.PerspectiveCamera();
shadowCam.layers.disableAll(); shadowCam.layers.enable(SHADOW_LAYER);
const shadowRT = new THREE.WebGLRenderTarget(1, 1);

// ---- state ----
const app = {
  settings, t, renderer, scene, camera, userRig, room, mirror, handMirror, floorMirror, blob, ghosts,
  quality: qualityPick.name, qualityReason: qualityPick.reason, preset: Q, gpu,
  avatar: null, ik: null, fingers: null, rec: null, rawRec: null, res: null, fingerOut: null, mode: 'desktop', xrInfo: null, xrSupport: null,
  scale: S.calibration.scale || 1, worldScale: S.calibration.mode === 'own' ? (S.calibration.worldScale || 1) : 1,
  perf: { frame: 0, ik: 0, cloth: 0, mirror: 0, render: 0, shadow: 0, fps: 0, calls: 0, tris: 0, level: 0 }, replay: null, recorder: createRecorder(),
  view: P.get('view') || 'first', fingerTable: null, calibrationMsg: '', calibFlow: createCalibrationFlow(), features: null,
  lifecycle: { visibility: 'visible', headLost: false, contextLost: false, sessions: 0, events: [] },
  level: 0,
};
window.__app = app;
app.updateDomText = updateDomText; updateDomText();
const logEvent = (kind, detail = '') => { const e = app.lifecycle.events; e.push({ t: +(performance.now() / 1000).toFixed(2), kind, detail }); if (e.length > 40) e.shift(); };

const desktop = createDesktop({ dom: renderer.domElement, camera, getEyeHeight: () => (S.calibration.userEye || 1.62) });
if (app.view === 'third') desktop.state.third = true;
const xrTracking = createXRTracking(renderer, {
  gripOffset: () => (Array.isArray(S.gripOffset) ? S.gripOffset : GRIP_WRIST_OFFSET),
  smoothHands: () => S.smoothHands !== false,
});
const estimator = createHeightEstimator();

// ---- quality: preset -> in-session level (auto-scaler) ----
app.autoScaler = createAutoScaler({ level: levelOfPreset(qualityPick.name), enabled: S.autoQuality !== false && !SHOT });
function applyLevel(level) {
  const L = LEVELS[Math.max(0, Math.min(LEVELS.length - 1, level))];
  app.level = level; app.perf.level = level;
  mirror.setQuality(L.mirror);
  room.setShadows(L.shadows);
  if (app.avatar) app.avatar.clothEvery = L.clothEvery;
  if (renderer.xr.isPresenting && S.foveation == null) { try { renderer.xr.setFoveation(L.foveation); } catch { /* not supported */ } }
}
app.applyLevel = applyLevel;
applyLevel(levelOfPreset(qualityPick.name));
app.setQuality = name => {
  S.quality = name; settings.save();
  qualityPick = name === 'auto' ? pickPreset({ ua: navigator.userAgent, gpu, benchMs: app.benchMs }) : { name, reason: 'chosen' };
  app.quality = qualityPick.name; app.qualityReason = qualityPick.reason;
  Object.assign(Q, PRESETS[qualityPick.name]);
  const lv = levelOfPreset(qualityPick.name);
  app.autoScaler.set(lv); applyLevel(lv);
};

// ---- IK body profile (hand collision torso) from sex + breast sliders ----
function syncIKBody() {
  const av = app.avatar, ik = app.ik;
  if (!av || !ik) return;
  const female = av.isFemale();
  const v = av.values;
  const bust = female ? Math.max(-0.01, Math.min(0.06, ((v.breastSize ?? 0.35) - 0.35) * 0.045 + (v.breastProjection ?? 0) * 0.012)) : 0;
  ik.setBody({ male: female ? 0 : 1, bust });
}
app.syncIKBody = syncIKBody;
app.ikOptions = () => ({
  kneelSide: S.kneel ? (S.dominant === 'right' ? 'right' : 'left') : null,
  armScale: S.armMode === 'proportional' ? (S.calibration.armScale || 1) : 1,
  clips: S.locomotion === 'clips', sit: S.sit === 'off' ? 'off' : 'auto', collision: S.handCollision !== false,
});
app.applyIKOptions = () => { if (app.ik) Object.assign(app.ik.options, app.ikOptions()); };

async function boot() {
  const [support, table] = await Promise.all([xrSupport(), fetch('./src/input/finger_profiles.json').then(r => r.json()).catch(() => ({ profiles: [], fallback: {} }))]);
  app.xrSupport = support;
  app.fingerTableBase = table;
  app.fingerTable = mergeTables(table, S.fingerOverride);
  app.fingers = createFingerInput(app.fingerTable);
  probeRuntime(renderer).then(f => { app.features = f; app.ui?.invalidateAll?.(); }).catch(() => {});
  if (P.has('replay')) {
    try { app.replay = await fetch(P.get('replay')).then(r => r.json()); app.mode = 'replay'; }
    catch (e) { setStatus(`replay: ${e.message}`, true); }
  }
  const avatar = await createAvatar({ scene, settings, t, lang: () => S.lang, setStatus, quality: Q, useWorker: P.get('clothWorker') !== '0' });
  app.avatar = avatar;
  avatar.clothEvery = LEVELS[app.level].clothEvery;
  app.ik = createVRIK(avatar.rig, app.ikOptions());
  avatar.onRig(r => { app.ik?.setRig(r); syncIKBody(); });
  syncIKBody();
  if (S.calibration.height != null && S.calibration.mode === 'morph') avatar.setSlider('height', S.calibration.height);
  app.thumbs = createThumbnails({ renderer, scene, getAvatar: () => app.avatar });
  app.photo = createPhoto({ renderer, scene, getAvatar: () => app.avatar });
  app.ui = createUI(app);
  app.thumbs.onUpdate = () => app.ui?.board?.invalidate(true);
  app.handDebug = createHandDebug(scene);
  setupEnterButton(support);
  await avatar.ready;
  // GPU benchmark refines the automatic preset (desktop page load only; never in XR, never for screenshots)
  if (S.quality === 'auto' && !SHOT) {
    app.benchMs = await gpuBenchmark(THREE, renderer);
    const pick = pickPreset({ ua: navigator.userAgent, gpu, benchMs: app.benchMs });
    app.qualityReason = pick.reason;
    if (pick.name !== app.quality) app.setQuality('auto');
  }
  setStatus('');
  window.__ready = true;
}

// ---- calibration ----
/** A scale change moves the head / feet in the solver frame in one frame: re-seed the solver instead of letting the
 *  velocity filter read it as a jump / walk (review finding: calibrating mid-session made the avatar jump + walk). */
function rebaseIK(scale0, world0) {
  if (Math.abs((app.scale ?? 1) - scale0) > 1e-6 || Math.abs((app.worldScale ?? 1) - world0) > 1e-6) app.ik?.reset();
}
function avatarSpan() { const r = app.avatar.rig; return r.armLength * 2 + r.shoulderWidth; }
/**
 * eyeY: user eye height (m, real world). opts.span: measured T-pose wrist span (m) or null; otherwise a T-pose in
 * the current record is used if there is one. Stores the result in the active user profile.
 */
app.calibrate = (eyeY = app.rawRec?.head?.pos?.[1], opts = {}) => {
  const av = app.avatar;
  if (!av || !(eyeY > 0.5)) return null;
  const mode = S.calibration.mode;
  const samples = [-1, -0.5, 0, 0.5, 1].map(h => ({ h, eye: av.eyeHeightFor(h) })).filter(s => s.eye != null);
  const current = mode === 'morph' ? av.values.height : (S.body?.height ?? av.values.height);
  if (mode !== 'morph' && av.values.height !== current) av.setSlider('height', current);
  const r = solveHeight(samples, eyeY, { mode, current });
  if (!r.ok) return r;
  if (mode === 'morph') av.setSlider('height', r.height);
  const scale0 = app.scale ?? 1, world0 = app.worldScale ?? 1;
  app.scale = r.scale;
  app.worldScale = r.worldScale ?? 1;
  rebaseIK(scale0, world0);
  let span = opts.span ?? null;
  if (span == null && app.rawRec?.hands) { const tp = detectTPose(app.rawRec.head, app.rawRec.hands.left, app.rawRec.hands.right); if (tp.ok) span = tp.span; }
  if (span == null && opts.useStoredSpan) span = S.calibration.span;
  if (span) {
    const a = solveArmScale([-span / 2, 0, 0], [span / 2, 0, 0], avatarSpan(), r.scale / (app.worldScale || 1));
    if (a.ok) S.calibration.armScale = +a.armScale.toFixed(4);
  }
  Object.assign(S.calibration, {
    userEye: +eyeY.toFixed(3), height: mode === 'morph' ? r.height : S.calibration.height, scale: r.scale, worldScale: +(app.worldScale).toFixed(4),
    span: span ? +span.toFixed(3) : S.calibration.span ?? null, time: new Date().toISOString(),
  });
  app.applyIKOptions();
  saveUserProfile();
  const userH = eyeY / 0.936;
  app.calibrationMsg = `${t('calibrated')}: ${t('eye')} ${eyeY.toFixed(2)} m (~${userH.toFixed(2)} m)` +
    (mode === 'own' ? ` · ${t('worldScale')} ${app.worldScale.toFixed(3)}` : mode === 'morph' ? ` · ${t('height')} ${r.height.toFixed(2)}` : '') +
    (r.scale !== 1 ? ` · ${t('scale')} ${r.scale.toFixed(3)}` : '') + (span ? ` · ${t('span')} ${span.toFixed(2)} m` : '');
  return r;
};
function saveUserProfile() {
  S.users = { ...(S.users || {}), [S.user]: { ...S.calibration } };
  settings.save();
}
/** Switch calibration profile (several people sharing a headset). */
app.setUser = id => {
  const scale0 = app.scale ?? 1, world0 = app.worldScale ?? 1;
  saveUserProfile();
  S.user = id;
  const stored = S.users?.[id];
  S.calibration = { ...DEFAULTS.calibration, mode: S.calibration.mode, ...(stored || {}) };
  if (stored?.userEye) app.calibrate(stored.userEye, { span: stored.span });
  else { app.scale = 1; app.worldScale = 1; autoCalibrated = false; estimator.reset(); app.calibrationMsg = ''; if (S.calibration.mode === 'morph') app.avatar?.setSlider('height', S.body?.height ?? 0); }
  rebaseIK(scale0, world0);
  app.applyIKOptions();
  settings.save();
};
app.setCalibrationMode = mode => {
  const scale0 = app.scale ?? 1, world0 = app.worldScale ?? 1;
  S.calibration.mode = mode;
  if (mode !== 'morph') app.avatar?.setSlider('height', S.body?.height ?? 0);
  if (S.calibration.userEye) app.calibrate(S.calibration.userEye, { useStoredSpan: true });
  else { app.scale = 1; app.worldScale = 1; }
  if (mode === 'off') { app.scale = 1; app.worldScale = 1; }
  rebaseIK(scale0, world0);
  settings.save();
};
app.resetCalibration = () => {
  Object.assign(S.calibration, { userEye: null, height: null, scale: 1, worldScale: 1, armScale: 1, span: null, time: null });
  const scale0 = app.scale ?? 1, world0 = app.worldScale ?? 1;
  app.scale = 1; app.worldScale = 1; autoCalibrated = false; estimator.reset();
  app.avatar?.setSlider('height', S.body?.height ?? 0);
  rebaseIK(scale0, world0);
  app.calibrationMsg = ''; app.applyIKOptions(); saveUserProfile();
};
app.startCalibration = () => { app.calibFlow.start(); logEvent('calibration', 'start'); };

/** 'own' mode: the tracked world scaled by k about the origin (copies; the source records are not touched). */
function scaleRecord(rec, k) {
  if (k === 1 || !rec) return rec;
  const sp = p => (p ? [p[0] * k, p[1] * k, p[2] * k] : p);
  const hand = h => (h ? { ...h, pos: sp(h.pos), ray: h.ray ? { ...h.ray, pos: sp(h.ray.pos) } : h.ray } : h);
  return {
    ...rec, head: { ...rec.head, pos: sp(rec.head.pos) },
    eyes: rec.eyes ? Object.fromEntries(Object.entries(rec.eyes).map(([e, p]) => [e, sp(p)])) : rec.eyes,
    hands: { left: hand(rec.hands?.left), right: hand(rec.hands?.right) },
    // the XR joints too (the hand-debug skeleton draws them in world space; finger angles are scale-free)
    snaps: rec.snaps?.map(sn => (sn?.joints ? { ...sn, joints: Object.fromEntries([...(sn.joints instanceof Map ? sn.joints : Object.entries(sn.joints))].map(([n, p]) => [n, sp(p)])) } : sn)),
  };
}

// ---- XR ----
let xrSession = null;
function setupEnterButton(support) {
  const btn = document.getElementById('enter');
  const msg = document.getElementById('xrmsg');
  if (!btn) return;
  btn.textContent = t('enterVR');
  if (!support.vr) {
    btn.disabled = true;
    msg.textContent = !support.secure ? t('xrNeedsHttps') : t('noXR');
    return;
  }
  btn.disabled = false; msg.textContent = '';
  btn.onclick = enterVR;
}
function onSessionEnd() {
  xrSession = null; app.mode = app.replay ? 'replay' : 'desktop'; app.xrInfo = { ...app.xrInfo, ended: true };
  camera.layers.enable(LAYERS.MONO);
  userRig.scale.setScalar(1);
  app.lifecycle.visibility = 'visible'; app.lifecycle.headLost = false;
  // fresh start next time: no stale filters / poles / held hands from the old session
  app.ik?.reset(); app.fingers?.resetRetarget?.(); estimator.reset();
  const btn = document.getElementById('enter'); if (btn) btn.textContent = t('enterVR');
  settings.flush();
  logEvent('session', 'end');
}
async function enterVR() {
  if (xrSession) { xrSession.end(); return; }
  app.ui?.clicker?.unlock?.();
  try {
    const fov = S.foveation ?? LEVELS[app.level].foveation;
    const { session, info } = await startSession(renderer, { framebufferScale: S.framebufferScale ?? Q.framebufferScale, foveation: fov, frameRate: 90 }, onSessionEnd);
    xrSession = session; app.xrInfo = info; app.mode = 'xr'; app.lifecycle.sessions++;
    camera.layers.disable(LAYERS.MONO);
    app.ik?.reset();
    session.addEventListener('inputsourceschange', e => { app.ui?.onInputSourcesChange?.(e); if (app.features) app.features = probeSession(app.features, session, renderer, info); });
    session.addEventListener('visibilitychange', () => {
      app.lifecycle.visibility = session.visibilityState; logEvent('visibility', session.visibilityState);
      if (session.visibilityState === 'visible') { app.ik?.reset(); app.avatar?.breast.reset(); }
    });
    if (app.features) app.features = probeSession(app.features, session, renderer, info);
    app.ui?.onSessionStart?.(session);
    const btn = document.getElementById('enter'); if (btn) btn.textContent = t('exitVR');
    logEvent('session', `start ${info.refSpace}`);
  } catch (e) {
    console.error('[xr] session failed', e);
    setStatus(`WebXR: ${e.message || e}`, true);
    logEvent('session', `failed ${e.message || e}`);
  }
}
app.enterVR = enterVR;
app.setFoveation = v => { S.foveation = v; settings.save(); if (renderer.xr.isPresenting) { try { renderer.xr.setFoveation(v ?? LEVELS[app.level].foveation); } catch { /* unsupported */ } } };

// ---- page / context lifecycle ----
document.addEventListener('visibilitychange', () => { logEvent('page', document.visibilityState); if (document.visibilityState === 'hidden') settings.flush(); clock.getDelta(); });
addEventListener('pagehide', () => settings.flush());
addEventListener('blur', () => logEvent('page', 'blur'));
renderer.domElement.addEventListener('webglcontextlost', e => {
  e.preventDefault(); app.lifecycle.contextLost = true; logEvent('webgl', 'context lost'); settings.flush();
  setStatus(t('contextLost'), true);
});
renderer.domElement.addEventListener('webglcontextrestored', () => {
  logEvent('webgl', 'context restored');
  // GPU resources (textures of canvases, render targets, morph textures) are simplest to rebuild by reloading;
  // every setting is persisted, so the character comes back as it was
  setTimeout(() => location.reload(), 300);
});

// ---- frame loop ----
const clock = new THREE.Clock();
const eyeL = new THREE.Vector3(), eyeR = new THREE.Vector3(), eyeM = new THREE.Vector3(), camPos = new THREE.Vector3();
const fq = new THREE.Quaternion(), fv = new THREE.Vector3(), rv = new THREE.Vector3();
const hipsW = new THREE.Vector3(), footLW = new THREE.Vector3(), footRW = new THREE.Vector3();
const pel = [0, 0, 0], feet = [[0, 0, 0], [0, 0, 0]];
let simTime = 0, manual = null, autoCalibrated = S.calibration.userEye != null;

function shadowPass() {
  if (!room.key.castShadow) return;
  const prevRT = renderer.getRenderTarget(), prevXR = renderer.xr.enabled;
  renderer.xr.enabled = false; renderer.shadowMap.autoUpdate = true;
  renderer.info.render.frame++;
  app.avatar.body.skeleton.update();          // the shadow camera sees no mesh, so three would not update it
  renderer.setRenderTarget(shadowRT); renderer.render(scene, shadowCam);
  renderer.shadowMap.autoUpdate = false;
  renderer.setRenderTarget(prevRT); renderer.xr.enabled = prevXR;
}

function frameStep(dt, frame) {
  const av = app.avatar;
  if (!av) return;
  const t0 = performance.now();
  renderer.info.reset();
  simTime += dt;
  const presenting = renderer.xr.isPresenting;
  // 1. tracking
  let rec;
  if (frame && presenting) rec = xrTracking.read(frame, dt);
  else if (app.replay) rec = sampleFixture(app.replay, simTime);
  else rec = desktop.read(dt);
  if (manual?.record) rec = manual.record(rec, simTime) || rec;
  if (!rec) return;
  app.rawRec = rec;
  app.lifecycle.headLost = !!rec.headLost;
  const blurred = presenting && app.lifecycle.visibility !== 'visible';
  // 2. calibration (real-world units): explicit T-pose flow, else the automatic estimate (once per profile)
  const fl = app.calibFlow.state;
  if (fl.phase === 'countdown' || fl.phase === 'sample') {
    const s = app.calibFlow.update(rec, dt);
    if (s.phase === 'done') { app.calibrate(s.result.eye, { span: s.result.span }); autoCalibrated = true; app.ui?.toast?.(app.calibrationMsg); logEvent('calibration', 'done'); }
    else if (s.phase === 'failed') { app.ui?.toast?.(`${t('calibFailed')}: ${t(`calibFail_${s.reason}`)}`); logEvent('calibration', `failed ${s.reason}`); }
  } else if (app.mode === 'xr' && !autoCalibrated && !rec.headLost && !rec.head.emulated && S.calibration.mode !== 'off') {
    fq.fromArray(rec.head.quat);
    fv.set(0, 0, -1).applyQuaternion(fq); rv.set(1, 0, 0).applyQuaternion(fq);
    estimator.push(rec.head.pos[1], Math.asin(Math.max(-1, Math.min(1, fv.y))), dt, { roll: Math.asin(Math.max(-1, Math.min(1, rv.y))) });
    const est = estimator.result();
    if (est && est.confidence > 0.6) { app.calibrate(est.eye); autoCalibrated = true; logEvent('calibration', `auto ${est.eye.toFixed(3)}`); }
  }
  // 3. 'own' scale mode: scale the tracked world (XR only)
  const k = presenting && S.calibration.mode === 'own' ? app.worldScale || 1 : 1;
  if (userRig.scale.x !== k) { userRig.scale.setScalar(k); userRig.updateMatrixWorld(true); }
  rec = scaleRecord(rec, k);
  app.rec = rec;
  app.recorder.push(rec);
  // 4. fingers
  const fo = app.fingers.update(rec.snaps || [], dt, av.rig);
  if (rec.desktopCurls) {           // desktop simulation drives the right hand's curls directly, the left mirrors poses
    const src = Object.fromEntries(['thumb', 'index', 'middle', 'ring', 'little'].map(f => [f, 'sim']));
    fo.right = { ...fo.right, state: fingerStateFromCurls(rec.desktopCurls, src), kind: 'sim', paths: src };
    fo.left = { ...fo.left, state: fingerStateFromCurls({ ...rec.desktopCurls, index: Math.min(rec.desktopCurls.index, 0.9) }, src), kind: 'sim', paths: src };
  }
  app.fingerOut = fo;
  // 5. IK (head lost: keep the last pose instead of solving from a stale head)
  const t1 = performance.now();
  if (!rec.headLost || !app.res) {
    app.res = app.ik.solve({ head: rec.head, hands: rec.hands, fingers: { left: fo.left.state, right: fo.right.state }, scale: app.scale }, dt);
    av.applyIK(app.res);
  }
  const res = app.res;
  const t2 = performance.now();
  // 6. eyes, hair, breast, cloth (physics held while the session is blurred or the head is lost)
  av.tick(dt, null, { physics: !blurred && !rec.headLost });
  const t3 = performance.now();
  room.follow(av.root.position);
  // blob shadows from the avatar's bones
  const b = av.humanoid?.bones;
  if (b?.hips) {
    b.hips.getWorldPosition(hipsW); b.leftFoot?.getWorldPosition(footLW); b.rightFoot?.getWorldPosition(footRW);
    pel[0] = hipsW.x; pel[1] = hipsW.y; pel[2] = hipsW.z;
    feet[0][0] = footLW.x; feet[0][1] = footLW.y; feet[0][2] = footLW.z; feet[1][0] = footRW.x; feet[1][1] = footRW.y; feet[1][2] = footRW.z;
    blob.update(pel, feet, av.root.scale.x || 1);
  }
  ghosts.update(presenting || manual?.ghosts ? rec : null, res, { left: fo.left.state, right: fo.right.state }, dt);
  app.ui?.update(rec, dt, frame);
  app.thumbs?.pump();
  app.handDebug?.update(S.handDebug ? rec : null);
  // hand mirror follows the non-dominant hand
  if (handMirror.enabled && rec.hands) {
    const h = rec.hands[S.dominant === 'right' ? 'left' : 'right'];
    if (h?.valid) {
      handMirror.group.position.fromArray(h.pos); handMirror.group.quaternion.fromArray(h.quat);
      handMirror.group.rotateX(-Math.PI / 2); handMirror.group.translateZ(0.03); handMirror.group.translateY(0.06);
    }
  }
  // 7. shadow map + mirror passes (avatar head visible)
  const t4 = performance.now();
  if (!presenting || !rec.eyes?.L) {
    if (!desktop.third || app.replay) desktop.placeCamera(rec, av.headWorld(camPos));
    if (desktop.third) { camPos.set(av.root.position.x, 1.0 * app.scale, av.root.position.z); desktop.placeCamera(rec, camPos); }
    if (manual?.camera) manual.camera(camera, app);
    camera.updateMatrixWorld();
  }
  scene.updateMatrixWorld();
  shadowPass();
  const t4b = performance.now();
  if (presenting && rec.eyes?.L) {
    eyeL.fromArray(rec.eyes.L); eyeR.fromArray(rec.eyes.R || rec.eyes.L);
    const eyes = { L: eyeL, R: eyeR };
    mirror.update(eyes); handMirror.update(eyes); floorMirror.update(eyes);
  } else {
    eyeM.setFromMatrixPosition(camera.matrixWorld);
    const eyes = { M: eyeM };
    mirror.update(eyes); handMirror.update(eyes); floorMirror.update(eyes);
  }
  const t5 = performance.now();
  // 8. main render: first person hides the own head (layers for face parts + collapsed head bone for the body)
  const firstPerson = presenting || (!desktop.third && !manual?.thirdPerson);
  if (firstPerson) camera.layers.disable(LAYERS.HEAD); else camera.layers.enable(LAYERS.HEAD);
  av.hideHead(firstPerson);
  renderer.info.render.frame++;               // info.autoReset is off: a new frame id makes three re-skin with the collapsed head
  renderer.render(scene, camera);
  av.hideHead(false);
  const t6 = performance.now();
  const kf = 0.05, pf = app.perf;
  pf.frame += ((t6 - t0) - pf.frame) * kf; pf.ik += ((t2 - t1) - pf.ik) * kf; pf.cloth += ((t3 - t2) - pf.cloth) * kf;
  pf.shadow += ((t4b - t4) - pf.shadow) * kf; pf.mirror += ((t5 - t4b) - pf.mirror) * kf; pf.render += ((t6 - t5) - pf.render) * kf;
  pf.fps += ((dt > 0 ? 1 / dt : 0) - pf.fps) * kf;
  pf.calls = renderer.info.render.calls; pf.tris = renderer.info.render.triangles;
  // 9. quality auto-scaler (XR only: the desktop loop's rate says nothing about a headset)
  if (presenting && !blurred) {
    const ev = app.autoScaler.update(dt, typeof app.xrInfo?.frameRate === 'number' ? app.xrInfo.frameRate : 72);
    if (ev) { applyLevel(ev.level); logEvent('quality', `level ${ev.level}: ${ev.reason}`); }
  }
}

renderer.setAnimationLoop((time, frame) => {
  const dt = Math.min(clock.getDelta(), 0.1);
  if (manual?.frozen || app.lifecycle.contextLost) return;
  frameStep(dt, frame);
});

// ---- test hooks (headless emulation / screenshots) ----
window.__xr = {
  state: () => ({
    ready: !!window.__ready, mode: app.mode, presenting: renderer.xr.isPresenting, quality: app.quality, qualityReason: app.qualityReason, level: app.level,
    xrInfo: app.xrInfo, xrSupport: app.xrSupport, lifecycle: app.lifecycle,
    scale: app.scale, worldScale: app.worldScale, userRigScale: userRig.scale.x, calibration: S.calibration, user: S.user, calibFlow: { phase: app.calibFlow.state.phase, left: app.calibFlow.state.left, result: app.calibFlow.state.result, reason: app.calibFlow.state.reason },
    perf: app.perf, mirror: { ...mirror.stats, quality: mirror.quality }, floorMirror: { enabled: floorMirror.enabled, ...floorMirror.stats }, debug: app.res?.debug,
    fingers: app.fingerOut && Object.fromEntries(['left', 'right'].map(s => [s, { kind: app.fingerOut[s].kind, profile: app.fingerOut[s].profile, paths: app.fingerOut[s].paths, lost: app.fingerOut[s].lost,
      curls: Object.fromEntries(Object.entries(app.fingerOut[s].state || {}).map(([f, v]) => [f, v ? +v.curl.toFixed(3) : null])) }])),
    sources: app.rec?.sources, cloth: app.avatar?.cloth?.stats?.(), outfit: app.avatar?.clothing?.state?.().outfit, hair: app.avatar?.hair,
    sex: app.avatar?.sex?.get?.(), breast: app.avatar?.breast?.state?.(), ikBody: app.ik?.options.body, ikOptions: app.ik && { clips: app.ik.options.clips, sit: app.ik.options.sit, collision: app.ik.options.collision },
    ghosts: ghosts.state.shown, memory: app.avatar?.memoryStats?.(), thumbs: app.thumbs?.stats?.(), features: app.features,
    info: renderer.info.render,
  }),
  enterVR, calibrate: app.calibrate,
  /** Manual control for tests: { record(rec, t) -> rec, camera(cam, app), thirdPerson, frozen, ghosts } */
  setManual(m) { manual = m; },
  step(n = 1, dt = 1 / 72) { for (let i = 0; i < n; i++) frameStep(dt, null); },
  setView(v) { desktop.state.third = v === 'third'; },
  /** Play a fixture (replay mode) from time t0; with setManual({frozen:true}) + step() it is deterministic. */
  setReplay(fx, t0 = 0) { app.replay = fx; app.mode = fx ? 'replay' : 'desktop'; simTime = t0; },
  get simTime() { return simTime; },
  scaleRecord,
};

boot().catch(e => { console.error(e?.stack || e); setStatus(`${e.message || e}`, true); });
