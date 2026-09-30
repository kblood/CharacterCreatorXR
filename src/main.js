// CharacterCreator XR: boot, frame loop, glue. Per frame:
//   tracking (XR | desktop | replay) -> finger input layer -> VRIK solve -> avatar pose + placement ->
//   eyes / hair / cloth -> UI -> mirror passes (head visible) -> main render (own head hidden) .
import * as THREE from 'three';
import { createSettings } from './settings.js';
import { makeT } from './i18n.js';
import { createAvatar, LAYERS } from './avatar.js';
import { createRoom, ROOM } from './room.js';
import { createMirror } from './mirror.js';
import { createVRIK } from './ik/vrik.js';
import { solveHeight, createHeightEstimator, solveArmScale } from './ik/calibrate.js';
import { fingerStateFromCurls } from './ik/fingers.js';
import { createFingerInput, mergeTables } from './input/fingerInput.js';
import { createXRTracking } from './xr/tracking.js';
import { xrSupport, startSession } from './xr/session.js';
import { createDesktop } from './desktop.js';
import { sampleFixture, createRecorder } from './replay.js';
import { createUI } from './ui/ui.js';
import { createHandDebug } from './ui/handdebug.js';

const settings = createSettings();
const S = settings.values;
const P = settings.params;
const t = makeT(() => S.lang);
if (settings.flag("shot")) document.body.classList.add("shot");
const statusEl = document.getElementById('status');
const setStatus = (msg, err = false) => { if (statusEl) { statusEl.textContent = msg || ''; statusEl.className = err ? 'error' : ''; } };

// ---- quality presets ----
const isMobileXR = /OculusBrowser|Quest|Pico|Android|SteamOS|Linux; Android/i.test(navigator.userAgent);
const PRESETS = {
  high: { skinUpgrade: true, shadows: true, shadowSize: 1024, mirror: 'high', framebufferScale: 1.0, foveation: 0.3, pixelRatio: 2 },
  medium: { skinUpgrade: true, shadows: true, shadowSize: 512, mirror: 'medium', framebufferScale: 0.9, foveation: 0.6, pixelRatio: 1.5 },
  low: { skinUpgrade: false, shadows: false, shadowSize: 256, mirror: 'low', framebufferScale: 0.8, foveation: 1, pixelRatio: 1 },
};
const qualityName = S.quality === 'auto' ? (isMobileXR ? 'medium' : 'high') : S.quality;
const Q = PRESETS[qualityName];

// ---- renderer / scene ----
const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: settings.flag('shot'), powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(devicePixelRatio || 1, Q.pixelRatio));
renderer.setSize(innerWidth, innerHeight);
renderer.toneMapping = THREE.NeutralToneMapping;
renderer.shadowMap.enabled = Q.shadows;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.xr.enabled = true;
document.body.prepend(renderer.domElement);
const scene = new THREE.Scene();
// near 1 cm: three's WebXRManager passes camera.near to the session (depthNear), so hands close to the face do not
// clip; far 60 m keeps enough depth precision at that near plane for this small room
const camera = new THREE.PerspectiveCamera(75, innerWidth / innerHeight, 0.01, 60);
camera.layers.enable(LAYERS.MONO); camera.layers.enable(LAYERS.UI);
scene.add(camera);
addEventListener('resize', () => { if (renderer.xr.isPresenting) return; camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix(); renderer.setSize(innerWidth, innerHeight); });

const room = createRoom(scene, renderer, { shadows: Q.shadows, shadowSize: Q.shadowSize });
const mirror = createMirror({ renderer, scene, width: ROOM.mirrorWidth, height: ROOM.mirrorHeight, quality: Q.mirror });
mirror.group.position.copy(room.mirrorRect.center);
scene.add(mirror.group);
mirror.setEnabled(S.mirror);
const handMirror = createMirror({ renderer, scene, width: 0.16, height: 0.22, quality: 'low', name: 'HandMirror', tint: 0.95 });
handMirror.setEnabled(false);
scene.add(handMirror.group);

// ---- state ----
const app = {
  settings, t, renderer, scene, camera, room, mirror, handMirror, quality: qualityName, preset: Q,
  avatar: null, ik: null, fingers: null, rec: null, res: null, fingerOut: null, mode: 'desktop', xrInfo: null, xrSupport: null,
  scale: S.calibration.scale || 1, perf: { frame: 0, ik: 0, cloth: 0, mirror: 0, render: 0, fps: 0 }, replay: null, recorder: createRecorder(),
  view: P.get('view') || 'first', fingerTable: null, calibrationMsg: '',
};
window.__app = app;

const desktop = createDesktop({ dom: renderer.domElement, camera, getEyeHeight: () => (S.calibration.userEye || 1.62) });
if (app.view === 'third') desktop.state.third = true;
const xrTracking = createXRTracking(renderer);
const estimator = createHeightEstimator();

async function boot() {
  const [support, table] = await Promise.all([xrSupport(), fetch('./src/input/finger_profiles.json').then(r => r.json()).catch(() => ({ profiles: [], fallback: {} }))]);
  app.xrSupport = support;
  app.fingerTableBase = table;
  app.fingerTable = mergeTables(table, S.fingerOverride);
  app.fingers = createFingerInput(app.fingerTable);
  if (P.has('replay')) {
    try { app.replay = await fetch(P.get('replay')).then(r => r.json()); app.mode = 'replay'; }
    catch (e) { setStatus(`replay: ${e.message}`, true); }
  }
  const avatar = await createAvatar({ scene, settings, t, lang: () => S.lang, setStatus, quality: Q, useWorker: P.get('clothWorker') !== '0' });
  app.avatar = avatar;
  app.ik = createVRIK(avatar.rig, { kneelSide: S.kneel ? (S.dominant === 'right' ? 'right' : 'left') : null, armScale: S.armMode === 'proportional' ? (S.calibration.armScale || 1) : 1 });
  avatar.onRig(r => app.ik?.setRig(r));
  if (S.calibration.height != null && S.calibration.mode === 'morph') avatar.setSlider('height', S.calibration.height);
  app.ui = createUI(app);
  app.handDebug = createHandDebug(scene);
  setupEnterButton(support);
  await avatar.ready;
  setStatus('');
  window.__ready = true;
}

// ---- calibration ----
app.calibrate = (eyeY = app.rec?.head?.pos?.[1]) => {
  const av = app.avatar;
  if (!av || !(eyeY > 0.5)) return null;
  const mode = S.calibration.mode;
  const samples = [-1, -0.5, 0, 0.5, 1].map(h => ({ h, eye: av.eyeHeightFor(h) })).filter(s => s.eye != null);
  const r = solveHeight(samples, eyeY, { mode, current: av.values.height });
  if (!r.ok) return r;
  if (mode === 'morph') av.setSlider('height', r.height);
  app.scale = r.scale;
  // arm span if the hands are spread wide (T-pose)
  const h = app.rec?.hands;
  if (h?.left?.valid && h?.right?.valid) {
    const tpose = av.rig.armLength * 2 + av.rig.shoulderWidth;          // avatar wrist-to-wrist span, arms out
    const a = solveArmScale(h.left.pos, h.right.pos, tpose, r.scale);
    if (a.ok) { S.calibration.armScale = a.armScale; if (S.armMode === 'proportional') app.ik.options.armScale = a.armScale; }
  }
  Object.assign(S.calibration, { userEye: +eyeY.toFixed(3), height: mode === 'morph' ? r.height : S.calibration.height, scale: r.scale });
  settings.save();
  app.calibrationMsg = `${t('calibrated')}: ${eyeY.toFixed(2)} m -> height ${r.height.toFixed(2)}, scale ${r.scale.toFixed(3)}`;
  return r;
};

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
async function enterVR() {
  if (xrSession) { xrSession.end(); return; }
  try {
    const { session, info } = await startSession(renderer, { framebufferScale: Q.framebufferScale, foveation: Q.foveation, frameRate: 90 }, () => {
      xrSession = null; app.mode = app.replay ? 'replay' : 'desktop'; app.xrInfo = { ...app.xrInfo, ended: true };
      camera.layers.enable(LAYERS.MONO);
    });
    xrSession = session; app.xrInfo = info; app.mode = 'xr';
    camera.layers.disable(LAYERS.MONO);
    session.addEventListener('inputsourceschange', e => app.ui?.onInputSourcesChange?.(e));
    app.ui?.onSessionStart?.(session);
  } catch (e) {
    console.error('[xr] session failed', e);
    setStatus(`WebXR: ${e.message || e}`, true);
  }
}
app.enterVR = enterVR;

// ---- frame loop ----
const clock = new THREE.Clock();
const eyeL = new THREE.Vector3(), eyeR = new THREE.Vector3(), eyeM = new THREE.Vector3(), camPos = new THREE.Vector3();
let simTime = 0, manual = null, autoCalibrated = S.calibration.userEye != null;

function frameStep(dt, frame) {
  const av = app.avatar;
  if (!av) return;
  const t0 = performance.now();
  simTime += dt;
  // 1. tracking
  let rec;
  if (frame && renderer.xr.isPresenting) rec = xrTracking.read(frame, dt);
  else if (app.replay) rec = sampleFixture(app.replay, simTime);
  else rec = desktop.read(dt);
  if (manual?.record) rec = manual.record(rec, simTime) || rec;
  if (!rec) return;
  app.rec = rec;
  app.recorder.push(rec);
  // 2. fingers
  const fo = app.fingers.update(rec.snaps || [], dt, av.rig);
  if (rec.desktopCurls) {           // desktop simulation drives the right hand's curls directly, the left mirrors poses
    const src = Object.fromEntries(['thumb', 'index', 'middle', 'ring', 'little'].map(k => [k, 'sim']));
    fo.right = { ...fo.right, state: fingerStateFromCurls(rec.desktopCurls, src), kind: 'sim', paths: src };
    fo.left = { ...fo.left, state: fingerStateFromCurls({ ...rec.desktopCurls, index: Math.min(rec.desktopCurls.index, 0.9) }, src), kind: 'sim', paths: src };
  }
  app.fingerOut = fo;
  // 3. auto height estimate (first seconds in XR, only when never calibrated)
  if (app.mode === 'xr' && !autoCalibrated) {
    const fwdY = new THREE.Vector3(0, 0, -1).applyQuaternion(new THREE.Quaternion().fromArray(rec.head.quat)).y;
    estimator.push(rec.head.pos[1], Math.asin(Math.max(-1, Math.min(1, fwdY))), dt);
    const est = estimator.estimate();
    if (est) { app.calibrate(est); autoCalibrated = true; }
  }
  // 4. IK
  const t1 = performance.now();
  const res = app.ik.solve({ head: rec.head, hands: rec.hands, fingers: { left: fo.left.state, right: fo.right.state }, scale: app.scale }, dt);
  app.res = res;
  av.applyIK(res);
  const t2 = performance.now();
  // 5. eyes, hair, cloth
  av.tick(dt, null);
  const t3 = performance.now();
  room.follow(av.root.position);
  app.ui?.update(rec, dt, frame);
  app.handDebug?.update(S.handDebug ? rec : null);
  // hand mirror follows the non-dominant hand
  if (handMirror.enabled && rec.hands) {
    const h = rec.hands[S.dominant === 'right' ? 'left' : 'right'];
    if (h?.valid) {
      handMirror.group.position.fromArray(h.pos); handMirror.group.quaternion.fromArray(h.quat);
      handMirror.group.rotateX(-Math.PI / 2); handMirror.group.translateZ(0.03); handMirror.group.translateY(0.06);
    }
  }
  // 6. mirror passes (avatar head visible)
  const t4 = performance.now();
  if (renderer.xr.isPresenting && rec.eyes?.L) {
    eyeL.fromArray(rec.eyes.L); eyeR.fromArray(rec.eyes.R || rec.eyes.L);
    mirror.update({ L: eyeL, R: eyeR });
    handMirror.update({ L: eyeL, R: eyeR });
  } else {
    if (!desktop.third || app.replay) desktop.placeCamera(rec, av.headWorld(camPos));
    if (desktop.third) { camPos.set(av.root.position.x, 1.0 * app.scale, av.root.position.z); desktop.placeCamera(rec, camPos); }
    if (manual?.camera) manual.camera(camera, app);
    camera.updateMatrixWorld();
    eyeM.setFromMatrixPosition(camera.matrixWorld);
    mirror.update({ M: eyeM });
    handMirror.update({ M: eyeM });
  }
  const t5 = performance.now();
  // 7. main render: first person hides the own head (layers for face parts + collapsed head bone for the body)
  const firstPerson = renderer.xr.isPresenting || (!desktop.third && !manual?.thirdPerson);
  if (firstPerson) camera.layers.disable(LAYERS.HEAD); else camera.layers.enable(LAYERS.HEAD);
  av.hideHead(firstPerson);
  renderer.render(scene, camera);
  av.hideHead(false);
  const t6 = performance.now();
  const k = 0.05, pf = app.perf;
  pf.frame += ((t6 - t0) - pf.frame) * k; pf.ik += ((t2 - t1) - pf.ik) * k; pf.cloth += ((t3 - t2) - pf.cloth) * k;
  pf.mirror += ((t5 - t4) - pf.mirror) * k; pf.render += ((t6 - t5) - pf.render) * k;
  pf.fps += ((dt > 0 ? 1 / dt : 0) - pf.fps) * k;
}

renderer.setAnimationLoop((time, frame) => {
  const dt = Math.min(clock.getDelta(), 0.1);
  if (manual?.frozen) return;
  frameStep(dt, frame);
});

// ---- test hooks (headless emulation / screenshots) ----
window.__xr = {
  state: () => ({
    ready: !!window.__ready, mode: app.mode, presenting: renderer.xr.isPresenting, quality: app.quality, xrInfo: app.xrInfo, xrSupport: app.xrSupport,
    scale: app.scale, calibration: S.calibration, perf: app.perf, mirror: { ...mirror.stats, quality: mirror.quality }, debug: app.res?.debug,
    fingers: app.fingerOut && Object.fromEntries(['left', 'right'].map(s => [s, { kind: app.fingerOut[s].kind, profile: app.fingerOut[s].profile, paths: app.fingerOut[s].paths,
      curls: Object.fromEntries(Object.entries(app.fingerOut[s].state || {}).map(([f, v]) => [f, v ? +v.curl.toFixed(3) : null])) }])),
    sources: app.rec?.sources, cloth: app.avatar?.cloth?.stats?.(), outfit: app.avatar?.clothing?.state?.().outfit, hair: app.avatar?.hair,
    info: renderer.info.render,
  }),
  enterVR, calibrate: app.calibrate,
  /** Manual control for tests: { record(rec, t) -> rec, camera(cam, app), thirdPerson, frozen } */
  setManual(m) { manual = m; },
  step(n = 1, dt = 1 / 72) { for (let i = 0; i < n; i++) frameStep(dt, null); },
  setView(v) { desktop.state.third = v === 'third'; },
  /** Play a fixture (replay mode) from time t0; with setManual({frozen:true}) + step() it is deterministic. */
  setReplay(fx, t0 = 0) { app.replay = fx; app.mode = fx ? 'replay' : 'desktop'; simTime = t0; },
  get simTime() { return simTime; },
};

boot().catch(e => { console.error(e); setStatus(`${e.message || e}`, true); });
