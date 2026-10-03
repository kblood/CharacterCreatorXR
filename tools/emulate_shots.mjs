// SPDX-License-Identifier: GPL-3.0-or-later
// Headless emulation run: IWER (Meta Quest 3 profile, emulated hands, and a FAKE per-finger controller) in a
// local Chrome/Edge via puppeteer-core. Plays the scenarios, takes screenshots (per eye, third person, mirror,
// UI, cloth), checks the finger-input paths, measures headless frame times, and writes build/shots/report.json.
// Nothing here is a real headset: everything below is EMULATED.
//   node tools/emulate_shots.mjs [--only name,name] [--headed] [--fixtures]   (npm run shots)
import { mkdir, writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from './serve.mjs';
import { launch, sleep } from './browser.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'build', 'shots');
const args = process.argv.slice(2);
const only = (args[args.indexOf('--only') + 1] || '').split(',').filter(Boolean);
const want = n => !args.includes('--only') || only.includes(n);
const W = 1600, H = 900;

// ---- poses (metres, local-floor; the mirror is at z = -1.6, the user starts at z = 0.4 facing it) ----
const HEAD = { pos: [0, 1.6, 0.4], ypr: [0, -6, 0] };
const REST = { left: { pos: [-0.2, 0.93, 0.44], ypr: [0, -25, 0] }, right: { pos: [0.2, 0.93, 0.44], ypr: [0, -25, 0] } };
const hold = (key, duration = 1.6) => ({ duration, keys: [{ t: 0, ...key }] });
const SCENARIOS = {
  standing: hold({ head: HEAD, ...REST }),
  armsUp: hold({ head: { pos: [0, 1.6, 0.4], ypr: [0, 4, 0] }, left: { pos: [-0.22, 1.95, 0.42], ypr: [0, 90, 0] }, right: { pos: [0.22, 1.95, 0.42], ypr: [0, 90, 0] } }),
  reach: hold({ head: { pos: [0, 1.6, 0.4], ypr: [0, -12, 0] }, left: REST.left, right: { pos: [0.12, 1.32, -0.12], ypr: [0, 0, 0] } }),
  crouch: { duration: 2.2, keys: [{ t: 0, head: HEAD, ...REST }, { t: 1.2, head: { pos: [0, 1.0, 0.32], ypr: [0, -22, 0] }, left: { pos: [-0.24, 0.62, 0.1], ypr: [0, -10, 0] }, right: { pos: [0.24, 0.62, 0.1], ypr: [0, -10, 0] } }] },
  deepCrouch: { duration: 2.4, keys: [{ t: 0, head: HEAD, ...REST }, { t: 1.4, head: { pos: [0, 0.72, 0.25], ypr: [0, -25, 0] }, left: { pos: [-0.24, 0.42, 0.02], ypr: [0, -10, 0] }, right: { pos: [0.24, 0.42, 0.02], ypr: [0, -10, 0] } }] },
  walk: {
    duration: 3.4, keys: [0, 0.4, 0.8, 1.2, 1.6, 2.0, 2.4, 2.8, 3.2, 3.4].map((t, i) => {
      const z = 0.4 - Math.min(t, 2.4) * 0.45, sw = Math.sin(i * Math.PI / 2) * 0.12, yaw = t > 2.4 ? (t - 2.4) * 60 : 0;
      return { t, head: { pos: [0.05 * Math.sin(i * Math.PI / 2), 1.6 - 0.02 * Math.abs(Math.sin(i * Math.PI / 2)), z], ypr: [yaw, -6, 0] },
        left: { pos: [-0.2, 0.93, z + 0.04 + sw], ypr: [yaw, -25, 0] }, right: { pos: [0.2, 0.93, z + 0.04 - sw], ypr: [yaw, -25, 0] } };
    }),
  },
};
// arms crossed over the chest (each hand at the opposite shoulder), sitting on a (virtual) chair, a tracked jump
const SCENARIOS2 = {
  acrossChest: hold({ head: { pos: [0, 1.6, 0.4], ypr: [0, -10, 0] }, left: { pos: [0.13, 1.36, 0.3], ypr: [-80, 0, 0] }, right: { pos: [-0.13, 1.33, 0.3], ypr: [80, 0, 0] } }, 1.4),
  sit: { duration: 4.2, keys: [{ t: 0, head: HEAD, ...REST }, { t: 1.2, head: { pos: [0, 1.18, 0.56], ypr: [0, -4, 0] }, left: { pos: [-0.16, 0.7, 0.3], ypr: [0, -30, 0] }, right: { pos: [0.16, 0.7, 0.3], ypr: [0, -30, 0] } }, { t: 4.2, head: { pos: [0, 1.18, 0.56], ypr: [0, -4, 0] }, left: { pos: [-0.16, 0.7, 0.3], ypr: [0, -30, 0] }, right: { pos: [0.16, 0.7, 0.3], ypr: [0, -30, 0] } }] },
  jump: { duration: 1.6, keys: [{ t: 0, head: HEAD, ...REST }, { t: 0.3, head: HEAD, ...REST }, { t: 0.42, head: { pos: [0, 1.5, 0.4], ypr: [0, -6, 0] }, ...REST },
    { t: 0.58, head: { pos: [0, 1.82, 0.4], ypr: [0, -6, 0] }, left: { pos: [-0.25, 1.2, 0.44], ypr: [0, -25, 0] }, right: { pos: [0.25, 1.2, 0.44], ypr: [0, -25, 0] } },
    { t: 0.74, head: { pos: [0, 1.6, 0.4], ypr: [0, -6, 0] }, ...REST }, { t: 0.86, head: { pos: [0, 1.54, 0.4], ypr: [0, -6, 0] }, ...REST }, { t: 1.6, head: HEAD, ...REST }] },
  // the right hand pushed into the chest: the avatar's hand stops at the body, the ghost hand shows the real one
  ghost: hold({ head: { pos: [0, 1.6, 0.4], ypr: [0, -20, 0] }, left: REST.left, right: { pos: [0.02, 1.3, 0.47], ypr: [0, 0, 0] } }, 1.2),
  tpose: hold({ head: { pos: [0, 1.6, 0.4], ypr: [0, 0, 0] }, left: { pos: [-0.8, 1.42, 0.42], ypr: [90, 0, 0] }, right: { pos: [0.8, 1.42, 0.42], ypr: [-90, 0, 0] } }, 5.6),
};
const HANDS_FRONT = { head: { pos: [0, 1.6, 0.4], ypr: [0, -18, 0] }, left: { pos: [-0.1, 1.4, 0.08], ypr: [0, 0, 0] }, right: { pos: [0.1, 1.4, 0.08], ypr: [0, 0, 0] } };

const report = { note: 'EMULATED with IWER in headless Chrome - not a real headset. Frame times here say nothing about Quest / Steam Frame GPU cost.', started: new Date().toISOString(), scenarios: {}, checks: [], shots: [], errors: [] };
const check = (name, ok, detail) => { report.checks.push({ name, ok: !!ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` - ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''}`); };

async function newPage(browser, url) {
  const ctx = await browser.createBrowserContext();          // fresh localStorage per page
  const page = await ctx.newPage();
  await page.setViewport({ width: W, height: H });
  const log = [];
  page.on('console', m => { const tx = m.text(); if (m.type() === 'error' || (m.type() === 'warn' && !/GPU stall|THREE\.WebGLRenderer: Texture marked/.test(tx))) log.push(`${m.type()}: ${tx}`); });
  page.on('pageerror', e => log.push(`pageerror: ${e.message}`));
  await page.goto(url, { waitUntil: 'load', timeout: 120000 });
  await page.waitForFunction('window.__ready === true', { timeout: 120000, polling: 250 });
  page.__log = log; page.__ctx = ctx;
  return page;
}
async function closePage(page, name) {
  if (page.__log.length) { report.errors.push({ page: name, log: page.__log.slice(0, 20) }); console.log(`  [${name}] console:`, page.__log.slice(0, 6).join(' | ')); }
  await page.__ctx.close();
}
async function enterXR(page) {
  await page.click('#enter');
  await page.waitForFunction('window.__xr.state().presenting === true', { timeout: 30000 });
  await sleep(600);
}
const state = page => page.evaluate(() => window.__xr.state());
async function shot(page, name, clip) {
  const path = join(OUT, `${name}.png`);
  await page.screenshot({ path, ...(clip ? { clip } : {}) });
  report.shots.push(`build/shots/${name}.png`);
  return path;
}
async function eyes(page, name) {
  // IWER draws both eyes side by side on the canvas
  await shot(page, `${name}_eyeL`, { x: 0, y: 0, width: W / 2, height: H });
  await shot(page, `${name}_eyeR`, { x: W / 2, y: 0, width: W / 2, height: H });
}
const play = (page, spec) => page.evaluate(s => window.__scenario.play(s), spec);
const grabRec = page => page.evaluate(() => JSON.parse(JSON.stringify(window.__app.rec)));
const summary = st => ({ lean: +(st.debug?.lean ?? 0).toFixed(3), crouch: +(st.debug?.crouch ?? 0).toFixed(3), kneel: +(st.debug?.kneel ?? 0).toFixed(3), steps: st.debug?.steps,
  reach: Object.fromEntries(['left', 'right'].map(s => [s, { reach: +(st.debug?.arms?.[s]?.reach ?? 0).toFixed(3), clamped: st.debug?.arms?.[s]?.clamped }])),
  fingers: Object.fromEntries(['left', 'right'].map(s => [s, { kind: st.fingers?.[s]?.kind, profile: st.fingers?.[s]?.profile, curls: st.fingers?.[s]?.curls, paths: st.fingers?.[s]?.paths }])) });

async function thirdPerson(browser, base, captures, query = '?shot=1&view=third&outfit=tshirt,jeans,shoes') {
  // replays captured tracking records on a desktop page with a third-person camera (same IK, same finger layer)
  const page = await newPage(browser, `${base}${query}`);
  for (const { name, rec, cam, fixture, times, extra } of captures) {
    await page.evaluate(({ rec, cam, fixture, extra }) => {
      const app = window.__app;
      if (extra) extra.split(';').filter(Boolean).forEach(x => new Function('app', x)(app));
      window.__xr.setReplay(fixture || null, 0);
      window.__xr.setManual({
        frozen: true, thirdPerson: true, ghosts: !!cam?.ghosts,
        record: fixture ? null : (() => rec),
        camera(c) {
          const av = app.avatar.root.position, s = app.scale || 1;
          const tx = av.x + (cam?.dx ?? 0), ty = (cam?.ty ?? 1.0) * s, tz = av.z + (cam?.dz ?? 0);
          c.position.set(tx + cam.off[0], ty + cam.off[1], tz + cam.off[2]); c.lookAt(tx, ty, tz);
          if (cam.fov) { c.fov = cam.fov; c.updateProjectionMatrix(); }
        },
      });
    }, { rec, cam, fixture, extra });
    const steps = times || [null];
    for (let k = 0; k < steps.length; k++) {
      // step in small chunks with real time in between, so the cloth worker keeps up
      const n = await page.evaluate(t => (t != null ? Math.max(1, Math.round((t - window.__xr.simTime) * 72)) : 150), steps[k]);
      for (let i = 0; i < n; i += 4) { await page.evaluate(m => window.__xr.step(m), Math.min(4, n - i)); await sleep(12); }
      await sleep(150);
      await page.evaluate(() => window.__xr.step(1));
      await shot(page, `${name}${steps.length > 1 ? `_${k + 1}` : ''}_3p`);
    }
  }
  await page.evaluate(() => { window.__app.camera.fov = 75; window.__app.camera.updateProjectionMatrix(); });
  await closePage(page, 'third-person');
}

async function main() {
  await mkdir(OUT, { recursive: true });
  const srv = await startServer({ port: 0, quiet: true });
  const base = srv.url;
  const browser = await launch({ width: W, height: H, headed: args.includes('--headed') });
  const captures = [];
  const CAM_FRONT = { off: [1.1, 0.25, -1.55], ty: 1.0 }, CAM_SIDE = { off: [2.0, 0.2, -0.35], ty: 0.9 };
  try {
    // ---------------- body scenarios with controllers ----------------
    if (['standing', 'armsUp', 'reach', 'crouch', 'deepCrouch', 'walk', 'mirror', 'perf', 'poses', 'calib', 'vrextras'].some(want)) {
      const page = await newPage(browser, `${base}?emulate=quest3&shot=1&outfit=tshirt,jeans,shoes`);
      await enterXR(page);
      const info = await page.evaluate(() => {
        const gl = window.__app.renderer.getContext(); const ext = gl.getExtension('WEBGL_debug_renderer_info');
        return { renderer: ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER), xrInfo: window.__xr.state().xrInfo };
      });
      report.gpu = info.renderer; report.xrInfo = info.xrInfo;
      for (const name of ['standing', 'armsUp', 'reach', 'crouch', 'deepCrouch', 'walk']) {
        if (!want(name)) continue;
        if (name === 'walk') await page.evaluate(() => window.__app.recorder.start());
        await play(page, SCENARIOS[name]);
        await sleep(350);
        if (name === 'walk') {
          const fx = await page.evaluate(() => { const r = window.__app.recorder; r.stop(); return r.fixture('walk (IWER emulated Quest 3 controllers)'); });
          captures.push({ name: 'walk', fixture: fx, cam: CAM_SIDE, times: [0.9, 1.7, 2.5] });
          if (args.includes('--fixtures')) await writeFile(join(ROOT, 'tests', 'fixtures', 'replay_walk.json'), JSON.stringify(fx));
        }
        const st = await state(page);
        report.scenarios[name] = summary(st);
        await eyes(page, name);
        if (name !== 'walk') captures.push({ name, rec: await grabRec(page), cam: name.includes('rouch') ? { off: [1.2, 0.35, -1.3], ty: 0.6 } : CAM_FRONT });
        // back to standing between scenarios
        await play(page, hold({ head: HEAD, ...REST }, 0.6));
        if (name === 'standing') {
          // height calibration (what the Calibrate button does): avatar eye height -> the user's 1.60 m
          const cal = await page.evaluate(() => { const r = window.__app.calibrate(1.6); return { r, eye: window.__app.avatar.eyeHeightFor(window.__app.avatar.values.height) * (window.__app.scale || 1) }; });
          report.calibration = cal;
          check('calibration: avatar eye height matches the user (1.60 m)', cal.r?.ok && Math.abs(cal.eye - 1.6) < 0.02, cal);
          // calibrating re-seeds the solver: no jump / walk from the scale step
          const calIk = await page.evaluate(() => ({ air: window.__app.ik.state.air, steps: window.__app.ik.state.loco.steps }));
          await play(page, hold({ head: HEAD, ...REST }, 0.8));
          const calIk2 = await page.evaluate(() => ({ air: window.__app.ik.state.air, steps: window.__app.ik.state.loco.steps, aw: window.__app.ik.state.aw }));
          check('calibration step: no jump, no steps (solver re-seeded)', calIk.air === 'ground' && calIk2.air === 'ground' && calIk2.aw === 0 && calIk2.steps - calIk.steps <= 1, { calIk, calIk2 });
          // 'own' mode scales the XR joints too (hand-debug skeleton)
          const sr = await page.evaluate(() => window.__xr.scaleRecord({ head: { pos: [0, 1, 0] }, hands: {}, snaps: [{ joints: { wrist: [1, 2, 3] } }] }, 2).snaps[0].joints.wrist);
          check('own-mode scaleRecord scales the XR hand joints', sr.join() === '2,4,6', sr);
        }
      }
      const std = report.scenarios.standing, up = report.scenarios.armsUp, cr = report.scenarios.crouch, dc = report.scenarios.deepCrouch, wk = report.scenarios.walk;
      if (std) check('standing: no lean, no crouch', Math.abs(std.lean) < 0.12 && std.crouch < 0.05, std);
      if (up) check('arms up: both hands tracked within reach', !up.reach.left.clamped && !up.reach.right.clamped, up.reach);
      if (cr) check('crouch: lean + crouch detected', cr.crouch > 0.2 && cr.lean > 0.1, { crouch: cr.crouch, lean: cr.lean });
      if (dc) check('deep crouch: kneel engaged', dc.kneel > 0.2, { kneel: dc.kneel });
      if (wk) check('walk: feet stepped', wk.steps >= 4, { steps: wk.steps });
      {
        const dn = await page.evaluate(() => { const s = window.__app.renderer.xr.getSession(); return s ? { depthNear: s.renderState.depthNear, cameraNear: window.__app.camera.near } : null; });
        check('first person: XR depthNear is 1 cm (hands close to the face do not clip)', dn && Math.abs(dn.depthNear - 0.01) < 1e-6, dn);
      }
      // mirror: close to the mirror, waving
      if (want('mirror')) {
        await play(page, { duration: 1.4, keys: [{ t: 0, head: { pos: [0, 1.6, -0.55], ypr: [0, -4, 0] }, left: { pos: [-0.3, 1.45, -0.7], ypr: [0, 70, 20] }, right: { pos: [0.28, 1.1, -0.75], ypr: [0, 0, 0] } }] });
        await sleep(300);
        await eyes(page, 'mirror_close');
        const st = await state(page);
        check('mirror renders both eyes (stereo)', st.mirror.renders > 10 && st.mirror.quality.stereo, st.mirror);
      }
      if (want('perf')) {
        const perf = {};
        for (const [label, setup] of [['mirror_on', 'app.mirror.setEnabled(true)'], ['mirror_off', 'app.mirror.setEnabled(false)'], ['mirror_low', "app.mirror.setEnabled(true); app.mirror.setQuality('low')"]]) {
          await page.evaluate(s => new Function('app', s)(window.__app), setup);
          await play(page, hold({ head: HEAD, ...REST }, 0.5));
          perf[label] = await page.evaluate(() => new Promise(res => {
            const s = window.__xr.state(); const r0 = s.info.frame; const t0 = performance.now(); const acc = { frame: [], ik: [], mirror: [], render: [], cloth: [] };
            const iv = setInterval(() => { const p = window.__app.perf; for (const k of Object.keys(acc)) acc[k].push(p[k]); }, 100);
            setTimeout(() => {
              clearInterval(iv);
              const avg = a => +(a.reduce((x, y) => x + y, 0) / a.length).toFixed(3);
              const s2 = window.__xr.state();
              res({ seconds: +((performance.now() - t0) / 1000).toFixed(2), renderCalls: s2.info.frame - r0, fpsLoop: +window.__app.perf.fps.toFixed(1),
                cpuMs: Object.fromEntries(Object.entries(acc).map(([k, v]) => [k, avg(v)])), drawCalls: s2.info.calls, triangles: s2.info.triangles });
            }, 4000);
          }));
        }
        report.perf = perf;
        await page.evaluate(() => { window.__app.mirror.setQuality(window.__app.preset.mirror); window.__app.mirror.setEnabled(true); });
        console.log('perf (headless, NOT representative):', JSON.stringify(perf));
      }
      // ---- arms across the chest, sit, jump, ghost hand ----
      if (want('poses')) {
        await play(page, SCENARIOS2.acrossChest); await sleep(300);
        let st = await state(page);
        report.scenarios.acrossChest = { reach: summary(st).reach, drift: { left: st.debug.arms.left.drift, right: st.debug.arms.right.drift } };
        await eyes(page, 'across_chest');
        captures.push({ name: 'across_chest', rec: await grabRec(page), cam: CAM_FRONT });
        await play(page, SCENARIOS2.sit); await sleep(300);
        st = await state(page);
        report.scenarios.sit = { sit: st.debug.sit, lean: st.debug.lean };
        check('sit: low, still, level gaze, head back -> sitting', st.debug.sit > 0.8, { sit: st.debug.sit });
        captures.push({ name: 'sit', rec: await grabRec(page), cam: { off: [1.6, 0.2, -1.0], ty: 0.7 } });
        await play(page, hold({ head: HEAD, ...REST }, 1.2));
        await page.evaluate(() => { window.__airLog = []; window.__airIv = setInterval(() => window.__airLog.push(window.__xr.state().debug?.loco?.air), 16); window.__app.recorder.start(); });
        await play(page, SCENARIOS2.jump); await sleep(200);
        const jump = await page.evaluate(() => { clearInterval(window.__airIv); const r = window.__app.recorder; r.stop(); return { air: [...new Set(window.__airLog)], fx: r.fixture('jump (IWER emulated)') }; });
        report.scenarios.jump = { phases: jump.air };
        check('jump: jump -> fall -> land detected from the head', ['jump', 'fall', 'land'].every(p => jump.air.includes(p)), jump.air);
        captures.push({ name: 'jump', fixture: jump.fx, cam: CAM_FRONT, times: [0.62, 0.74] });
        await play(page, SCENARIOS2.ghost); await sleep(200);
        st = await state(page);
        report.scenarios.ghost = { drift: st.debug.arms.right.drift, shown: st.ghosts };
        check('ghost hand: shown when the avatar hand is blocked by the body', st.ghosts.right && st.debug.arms.right.drift > 0.03, { drift: st.debug.arms.right.drift, shown: st.ghosts });
        await eyes(page, 'ghost_hand');
        captures.push({ name: 'ghost_hand', rec: await grabRec(page), cam: { off: [0.9, 0.15, -0.9], ty: 1.25, fov: 45, ghosts: true } });
        await play(page, hold({ head: HEAD, ...REST }, 0.6));
      }
      // ---- in-VR T-pose calibration (countdown + sampling), then the 'own' scale mode ----
      if (want('calib')) {
        await page.evaluate(() => { window.__app.resetCalibration(); window.__app.startCalibration(); });
        await play(page, hold({ head: { pos: [0, 1.6, 0.4], ypr: [0, -4, 0] }, ...REST }, 1.0));
        await eyes(page, 'calib_countdown');
        await play(page, SCENARIOS2.tpose); await sleep(200);
        let st = await state(page);
        // the span is wrist to wrist (the tracking layer moves the controller grip back to the wrist)
        const wristSpan = await page.evaluate(() => { const h = window.__app.rawRec.hands; return Math.hypot(h.left.pos[0] - h.right.pos[0], h.left.pos[1] - h.right.pos[1], h.left.pos[2] - h.right.pos[2]); });
        report.scenarios.calibration = { flow: st.calibFlow, calibration: st.calibration, wristSpan };
        check('T-pose calibration: done, eye 1.60 m, wrist span measured', st.calibFlow.phase === 'done' && Math.abs(st.calibration.userEye - 1.6) < 0.02 && Math.abs((st.calibration.span ?? 0) - wristSpan) < 0.02, { flow: st.calibFlow.phase, eye: st.calibration.userEye, span: st.calibration.span, wristSpan: +wristSpan.toFixed(3), armScale: st.calibration.armScale });
        await page.evaluate(() => { window.__app.setCalibrationMode('own'); window.__app.calibrate(1.5); });
        await play(page, hold({ head: { pos: [0, 1.5, 0.4], ypr: [0, -6, 0] }, left: { pos: [-0.2, 0.88, 0.44], ypr: [0, -25, 0] }, right: { pos: [0.2, 0.88, 0.44], ypr: [0, -25, 0] } }, 1.0));
        st = await state(page);
        const own = await page.evaluate(() => { const a = window.__app, V = a.camera.position.constructor; const hw = a.avatar.headWorld(new V()); const cam = a.renderer.xr.getCamera().getWorldPosition(new V()); return { head: hw.toArray(), xrCam: cam.toArray(), avatarEye: a.avatar.eyeHeightFor(a.avatar.values.height) }; });
        report.scenarios.ownScale = { worldScale: st.worldScale, userRigScale: st.userRigScale, ...own };
        check("'own' scale: the user's world is scaled to the avatar's eye height (camera at the avatar's eyes)", Math.abs(st.userRigScale - st.worldScale) < 1e-6 && Math.abs(own.xrCam[1] - own.avatarEye) < 0.03, { worldScale: st.worldScale, camY: own.xrCam[1], avatarEye: own.avatarEye });
        await eyes(page, 'own_scale');
        await page.evaluate(() => { window.__app.setCalibrationMode('morph'); window.__app.calibrate(1.6); });
        await play(page, hold({ head: HEAD, ...REST }, 0.6));
      }
      // ---- perf HUD + tutorial overlay + floor reflection, photo, session restart ----
      if (want('vrextras')) {
        await page.evaluate(() => { const a = window.__app; a.settings.values.perfHud = true; a.ui.hud.setVisible(true); a.ui.showTutorial(true); a.floorMirror.setEnabled(true); });
        await play(page, hold({ head: { pos: [0, 1.6, 0.4], ypr: [0, -12, 0] }, ...REST }, 1.0)); await sleep(300);
        await eyes(page, 'tutorial_hud_floor');
        let st = await state(page);
        check('floor reflection renders per eye', st.floorMirror.enabled && st.floorMirror.renders > 10, st.floorMirror);
        await page.evaluate(() => { const a = window.__app; a.ui.tutorial.setVisible(false); a.ui.hud.setVisible(false); a.floorMirror.setEnabled(false); });
        const photo = await page.evaluate(() => window.__app.photo.take({ framing: 'full', width: 960, height: 1200 }).toDataURL('image/png'));
        await writeFile(join(OUT, 'photo_full.png'), Buffer.from(photo.split(',')[1], 'base64')); report.shots.push('build/shots/photo_full.png');
        const portrait = await page.evaluate(() => window.__app.photo.take({ framing: 'portrait', width: 960, height: 1200 }).toDataURL('image/png'));
        await writeFile(join(OUT, 'photo_portrait.png'), Buffer.from(portrait.split(',')[1], 'base64')); report.shots.push('build/shots/photo_portrait.png');
        // session end -> restart: no stale state, the user rig back to scale 1, presenting again
        await page.evaluate(() => window.__xr.enterVR());
        await page.waitForFunction('window.__xr.state().presenting === false', { timeout: 10000 });
        st = await state(page);
        const ended = { mode: st.mode, userRigScale: st.userRigScale };
        await enterXR(page);
        await play(page, hold({ head: HEAD, ...REST }, 0.8));
        st = await state(page);
        check('session end + restart: desktop between, presenting again, finite pose', ended.mode === 'desktop' && ended.userRigScale === 1 && st.presenting && st.lifecycle.sessions >= 2 && Number.isFinite(st.debug?.lean), { ended, sessions: st.lifecycle.sessions, events: st.lifecycle.events.map(e => `${e.kind}:${e.detail}`) });
      }
      await closePage(page, 'controllers');
    }

    // ---------------- articulated hands (IWER hand input) ----------------
    if (want('hands')) {
      const page = await newPage(browser, `${base}?emulate=hands&shot=1&outfit=tshirt,jeans,shoes`);
      await enterXR(page);
      const res = {};
      for (const [pose, extra] of [['open', {}], ['fist', {}], ['point', {}], ['pinch', { pinch: { left: 1, right: 1 } }], ['default', {}]]) {
        await play(page, hold({ ...HANDS_FRONT, mode: 'hand', handPose: { left: pose === 'pinch' ? 'default' : pose, right: pose === 'pinch' ? 'default' : pose }, pinch: { left: 0, right: 0 }, ...extra }, 1.0));
        await sleep(300);
        const st = await state(page);
        res[pose] = { left: st.fingers.left, right: st.fingers.right };
        await eyes(page, `hands_${pose}`);
        captures.push({ name: `hands_${pose}`, rec: await grabRec(page), cam: { off: [0.25, 0.1, -0.55], ty: 1.3, dz: -0.3, fov: 40 } });
      }
      report.scenarios.hands = res;
      const c = (p, s, f) => res[p]?.[s]?.curls?.[f] ?? NaN;
      check('hands: source kind = hand', res.open?.right?.kind === 'hand' && res.open?.left?.kind === 'hand', res.open?.right?.kind);
      check('hands: open < 0.15 (index, middle)', c('open', 'right', 'Index') < 0.15 && c('open', 'right', 'Middle') < 0.15, res.open?.right?.curls);
      check('hands: fist > 0.8 (all long fingers, both hands)', ['left', 'right'].every(s => ['Index', 'Middle', 'Ring', 'Little'].every(f => c('fist', s, f) > 0.8)), { l: res.fist?.left?.curls, r: res.fist?.right?.curls });
      check('hands: point = index open, others curled', c('point', 'right', 'Index') < 0.2 && c('point', 'right', 'Middle') > 0.6, res.point?.right?.curls);
      check('hands: pinch curls the index more than relaxed', c('pinch', 'right', 'Index') > c('default', 'right', 'Index'), { pinch: c('pinch', 'right', 'Index'), relaxed: c('default', 'right', 'Index') });
      await closePage(page, 'hands');
    }

    // ---------------- fake per-finger controller + auto switch ----------------
    if (want('gamepadFingers')) {
      const page = await newPage(browser, `${base}?emulate=fingers&shot=1&outfit=tshirt,jeans,shoes&debug=1`);
      await enterXR(page);
      const vals = { finger7: 0.0, finger8: 0.5, finger9: 1.0, finger10: 1.0 };
      await play(page, hold({ ...HANDS_FRONT, mode: 'controller', buttons: { right: vals, left: { finger7: 1, finger8: 1, finger9: 1, finger10: 1 } }, axes: { right: { thumbcurl: 0.8 }, left: { thumbcurl: 0.1 } } }, 1.2));
      await sleep(300);
      let st = await state(page);
      report.scenarios.gamepadFingers = { controller: summary(st).fingers };
      const R = st.fingers.right;
      check('fake finger controller: profile matched', R.profile === 'emulated-finger-controller', R.profile);
      check('fake finger controller: per-finger paths', R.paths.index === 'controller-finger:button7' && R.paths.little === 'controller-finger:button10' && R.paths.thumb === 'controller-finger:axis4', R.paths);
      check('fake finger controller: curls follow the buttons', Math.abs(R.curls.Index - 0) < 0.08 && Math.abs(R.curls.Middle - 0.5) < 0.08 && R.curls.Ring > 0.92 && Math.abs(R.curls.Thumb - 0.8) < 0.08, R.curls);
      await eyes(page, 'gamepad_fingers');
      // the debug panel in VR: look at it
      await page.evaluate(() => { const d = window.__app.ui.debug.group; window.__dbgPos = d.position.toArray(); });
      const dp = await page.evaluate(() => window.__dbgPos);
      const hx = dp[0] - 0, hz = dp[2] - 0.4, yaw = -Math.atan2(hx, -hz) * 180 / Math.PI, pitch = Math.atan2(dp[1] - 1.6, Math.hypot(hx, hz)) * 180 / Math.PI;
      await play(page, hold({ head: { pos: [0, 1.6, 0.4], ypr: [yaw, pitch, 0] }, left: REST.left, right: { pos: [0.2, 1.2, 0.2], ypr: [yaw, pitch, 0] }, buttons: { right: vals } }, 0.8));
      await sleep(400);
      await shot(page, 'debug_panel_vr_eyeL', { x: 0, y: 0, width: W / 2, height: H });
      // controller put down -> hand tracking (inputsourceschange), and back
      await play(page, hold({ ...HANDS_FRONT, mode: 'hand', handPose: { left: 'fist', right: 'point' } }, 1.0));
      await sleep(300);
      st = await state(page);
      check('auto switch: controller -> hand on inputsourceschange', st.fingers.right.kind === 'hand' && st.fingers.left.kind === 'hand', { right: st.fingers.right.kind, sources: st.sources?.map(s => `${s.handedness}:${s.hand ? 'hand' : s.profiles?.[0]}`) });
      await play(page, hold({ ...HANDS_FRONT, mode: 'controller', buttons: { right: vals } }, 1.0));
      await sleep(300);
      st = await state(page);
      check('auto switch: hand -> controller-finger again', st.fingers.right.kind === 'controller-finger', st.fingers.right.kind);
      // diagnostics JSON is producible
      const diag = await page.evaluate(() => { const d = window.__app.diagnostics(); return { keys: Object.keys(d), snaps: d.snaps?.length, buttons: d.snaps?.[0]?.gamepad?.buttons?.length }; });
      check('diagnostics JSON has sources + gamepad snapshots', diag.snaps >= 2 && diag.buttons >= 11, diag);
      // learn wizard on the fake controller: drive each finger while the wizard samples
      const learned = await page.evaluate(async () => {
        const dev = window.__iwer.device, c = dev.controllers.right, ui = window.__app.ui;
        ui.startWizard('right');
        const map = { open: null, index: 'finger7', middle: 'finger8', ring: 'finger9', little: 'finger10', thumb: 'thumbcurl' };
        const z = () => ui.state.wizard;
        for (let guard = 0; guard < 4000 && z(); guard++) {
          const step = z().steps[z().i];
          for (const id of ['finger7', 'finger8', 'finger9', 'finger10']) c.updateButtonValue(id, map[step] === id ? 1 : 0);
          c.updateAxis('thumbcurl', 'x-axis', step === 'thumb' ? 1 : 0);
          await new Promise(r => setTimeout(r, 20));
        }
        return window.__app.settings.values.fingerOverride;
      });
      const lf = learned?.profiles?.[0]?.fingers || {};
      check('learn wizard maps the fake channels (index b7, middle b8, ring b9, little b10, thumb a4)', lf.index?.button === 7 && lf.middle?.button === 8 && lf.ring?.button === 9 && lf.little?.button === 10 && lf.thumb?.axis === 4, lf);
      report.scenarios.gamepadFingers.learned = learned;
      await closePage(page, 'gamepad-fingers');
    }

    // ---------------- UI in VR: ray click, wrist menu, poke ----------------
    if (want('ui')) {
      const page = await newPage(browser, `${base}?emulate=quest3&shot=1&outfit=tshirt,jeans,shoes`);
      await enterXR(page);
      const aim = await page.evaluate(() => {
        const ui = window.__app.ui, b = ui.board;
        const w = b.widgets.find(x => x.id === 'tab-body');
        const lx = ((w.x + w.w / 2) / b.px[0] - 0.5) * b.size[0], ly = (0.5 - (w.y + w.h / 2) / b.px[1]) * b.size[1];
        const v = b.mesh.localToWorld(new (b.mesh.position.constructor)(lx, ly, 0));
        return { target: v.toArray(), board: b.group.position.toArray() };
      });
      const from = [0.22, 1.25, 0.25];
      const d = aim.target.map((x, i) => x - from[i]), len = Math.hypot(...d);
      const yaw = Math.atan2(-d[0], -d[2]) * 180 / Math.PI, pitch = Math.asin(d[1] / len) * 180 / Math.PI;
      const hb = aim.board, hx = hb[0], hz = hb[2] - 0.4;
      const head = { pos: [0, 1.6, 0.4], ypr: [-Math.atan2(hx, -hz) * 180 / Math.PI * 0.85, -8, 0] };
      await play(page, hold({ head, left: REST.left, right: { pos: from, ypr: [yaw, pitch, 0] } }, 0.8));
      await sleep(300);
      await eyes(page, 'ui_hover');
      await play(page, hold({ head, left: REST.left, right: { pos: from, ypr: [yaw, pitch, 0] }, buttons: { right: { trigger: 1 } } }, 0.35));
      await play(page, hold({ head, left: REST.left, right: { pos: from, ypr: [yaw, pitch, 0] }, buttons: { right: { trigger: 0 } } }, 0.5));
      await sleep(300);
      let tab = await page.evaluate(() => window.__app.ui.state.tab);
      check('UI: ray + trigger (select) switches the tab', tab === 'body', tab);
      await eyes(page, 'ui_body_tab');
      // slider drag by ray: press on the height slider, move the ray, release
      const sl = await page.evaluate(() => {
        const b = window.__app.ui.board; b.update(performance.now());
        const w = b.widgets.find(x => x.id === 'slider-weight');
        const P = (px, py) => b.mesh.localToWorld(new (b.mesh.position.constructor)((px / b.px[0] - 0.5) * b.size[0], (0.5 - py / b.px[1]) * b.size[1], 0)).toArray();
        const tx = w.x + w.trackX, tw = w.w - w.trackX - w.valueW, y = w.y + w.h / 2;
        return { a: P(tx + tw * 0.5, y), b: P(tx + tw * 0.85, y), before: window.__app.avatar.values.weight };
      });
      const aimAt = p => { const dd = p.map((x, i) => x - from[i]), l = Math.hypot(...dd); return [Math.atan2(-dd[0], -dd[2]) * 180 / Math.PI, Math.asin(dd[1] / l) * 180 / Math.PI, 0]; };
      await play(page, { duration: 1.4, keys: [
        { t: 0, head, left: REST.left, right: { pos: from, ypr: aimAt(sl.a) }, buttons: { right: { trigger: 0 } } },
        { t: 0.2, head, left: REST.left, right: { pos: from, ypr: aimAt(sl.a) }, buttons: { right: { trigger: 1 } } },
        { t: 1.0, head, left: REST.left, right: { pos: from, ypr: aimAt(sl.b) }, buttons: { right: { trigger: 1 } } },
        { t: 1.2, head, left: REST.left, right: { pos: from, ypr: aimAt(sl.b) }, buttons: { right: { trigger: 0 } } },
      ] });
      await sleep(300);
      const after = await page.evaluate(() => window.__app.avatar.values.weight);
      check('UI: slider drag by ray changes the body (weight)', after > 0.4, { before: sl.before, after });
      await eyes(page, 'ui_slider');
      // wrist menu on the left hand: back of the hand toward the eyes
      await play(page, hold({ head: { pos: [0, 1.6, 0.4], ypr: [8, -35, 0] }, left: { pos: [-0.06, 1.3, 0.1], ypr: [-20, 20, 90] }, right: REST.right }, 0.8));
      await sleep(300);
      const wristVis = await page.evaluate(() => window.__app.ui.wrist.visible);
      check('UI: wrist menu shows when the left palm faces the head', wristVis, wristVis);
      await eyes(page, 'ui_wrist');
      // poke: move the right hand so the avatar index tip goes through the board's 'Hair' tab
      const poke = await page.evaluate(async () => {
        const app = window.__app, ui = app.ui, b = ui.board, V = b.mesh.position.constructor, dev = window.__iwer.device, c = dev.controllers.right;
        ui.setTab('clothes');
        b.update(performance.now());
        const w = b.widgets.find(x => x.id === 'tab-hair');
        const local = new V(((w.x + w.w / 2) / b.px[0] - 0.5) * b.size[0], (0.5 - (w.y + w.h / 2) / b.px[1]) * b.size[1], 0);
        const target = b.mesh.localToWorld(local.clone()), normal = new V(0, 0, 1).applyQuaternion(b.group.quaternion);
        // stand ~45 cm in front of the board, slightly to the left of the target, facing it
        const stand = target.clone().addScaledVector(normal, 0.3); stand.y = 1.6;
        const yawB = Math.atan2(normal.x, normal.z) * 180 / Math.PI;
        dev.position.set(stand.x - 0.12 * Math.cos(yawB * Math.PI / 180), 1.6, stand.z + 0.12 * Math.sin(yawB * Math.PI / 180));
        dev.quaternion.set(...window.__scenario.quatYPR([yawB, -25, 0]));
        const tip = new V(), wait = ms => new Promise(r => setTimeout(r, ms));
        const getTip = () => { const bn = app.avatar.humanoid.bones; const d = bn.rightIndexDistal.getWorldPosition(new V()), i = bn.rightIndexIntermediate.getWorldPosition(new V()); return d.add(d.clone().sub(i).multiplyScalar(0.9)); };
        // controller orientation: pointing into the board
        const q = window.__scenario.quatYPR([yawB, -10, 0]);
        c.quaternion.set(...q);
        let cp = target.clone().addScaledVector(normal, 0.12).add(new V(0, -0.02, 0));
        c.position.set(cp.x, cp.y, cp.z);
        // iterate: move the controller so the fingertip sits 6 cm in front of the target
        for (let k = 0; k < 12; k++) {
          await wait(120);
          tip.copy(getTip());
          const goal = target.clone().addScaledVector(normal, 0.06);
          cp.add(goal.sub(tip));
          c.position.set(cp.x, cp.y, cp.z);
        }
        const tipBefore = getTip().toArray();
        // push through the panel and back out
        let minZ = 1;
        for (let k = 0; k <= 20; k++) { const p = cp.clone().addScaledVector(normal, -0.08 * k / 20); c.position.set(p.x, p.y, p.z); await wait(25); minZ = Math.min(minZ, b.mesh.worldToLocal(getTip()).z); }
        for (let k = 0; k <= 20; k++) { const p = cp.clone().addScaledVector(normal, -0.08 + 0.1 * k / 20); c.position.set(p.x, p.y, p.z); await wait(25); }
        await wait(200);
        return { tab: ui.state.tab, tipBefore, target: target.toArray(), minZ, reach: app.res.debug.arms.right };
      });
      check('UI: index-finger poke presses a tab (Hair)', poke.tab === 'hair', poke);
      await eyes(page, 'ui_poke');
      await closePage(page, 'ui');
    }

    // ---------------- UI on the desktop (mouse) + board close-up ----------------
    if (want('desktopUI')) {
      const page = await newPage(browser, `${base}?shot=1&outfit=skirt,tshirt&debug=1`);
      await page.evaluate(() => {
        const app = window.__app, b = app.ui.board;
        window.__xr.setManual({ camera(c) { const p = b.group.position, q = b.group.quaternion; const n = new (p.constructor)(0, 0, 1).applyQuaternion(q); c.position.copy(p).addScaledVector(n, 0.95); c.quaternion.copy(q); } });
      });
      await sleep(500);
      for (const tb of ['clothes', 'body', 'hair', 'outfits', 'calib', 'scene', 'system']) {
        // click the tab with the real mouse (capture-phase handler on the canvas)
        const pt = await page.evaluate(id => {
          const app = window.__app, b = app.ui.board, w = b.widgets.find(x => x.id === id);
          const v = b.mesh.localToWorld(new (b.mesh.position.constructor)(((w.x + w.w / 2) / b.px[0] - 0.5) * b.size[0], (0.5 - (w.y + w.h / 2) / b.px[1]) * b.size[1], 0));
          v.project(app.camera);
          return [(v.x + 1) / 2 * innerWidth, (1 - v.y) / 2 * innerHeight];
        }, `tab-${tb}`);
        await page.mouse.click(pt[0], pt[1]);
        await sleep(400);
        const cur = await page.evaluate(() => window.__app.ui.state.tab);
        if (cur !== tb) check(`desktop mouse click on tab ${tb}`, false, cur);
        await shot(page, `ui_board_${tb}`);
      }
      check('desktop: mouse clicks switch all tabs', !report.checks.some(c => c.name.startsWith('desktop mouse click') && !c.ok));
      // thumbnails rendered offscreen for the clothes grid
      await page.evaluate(() => window.__app.ui.setTab('clothes', 'top')); await sleep(1500);
      const th = await page.evaluate(() => window.__xr.state().thumbs);
      check('clothes grid: garment thumbnails rendered offscreen (cached)', th.rendered >= 3 && th.failed === 0, th);
      // the JSON export/import round trip restores the character
      const io = await page.evaluate(async () => {
        const a = window.__app, ch = a.snapshotCharacter('t');
        const text = JSON.stringify(ch);
        a.avatar.setSlider('weight', -0.8); await a.avatar.clothing.setOutfit(['tshirt']);
        const r = await a.importCharacterText(text);
        return { ok: r.ok, kind: ch.kind, version: ch.version, weight: a.avatar.values.weight, outfit: a.avatar.clothing.state().outfit, before: ch.outfit };
      });
      check('character JSON export/import round trip restores body + outfit', io.ok && io.kind === 'ccxr-character' && io.version === 1 && Math.abs(io.weight - 0) < 1e-6 && JSON.stringify(io.outfit) === JSON.stringify(io.before), io);
      await closePage(page, 'desktop-ui');
      // English + female: body/breast page, bra slot, hair grid, runtime page
      const p2 = await newPage(browser, `${base}?shot=1&sex=female&lang=en&outfit=tshirt,skirt,shoes`);
      await p2.evaluate(() => {
        const app = window.__app, b = app.ui.board;
        window.__xr.setManual({ camera(c) { const p = b.group.position, q = b.group.quaternion; const n = new (p.constructor)(0, 0, 1).applyQuaternion(q); c.position.copy(p).addScaledVector(n, 0.95); c.quaternion.copy(q); } });
      });
      for (const [tb, pg] of [['body', 'breast'], ['clothes', 'bra'], ['hair'], ['outfits'], ['system', 'runtime']]) {
        await p2.evaluate((a, b) => window.__app.ui.setTab(a, b), tb, pg); await sleep(tb === 'hair' ? 2500 : 600);
        await shot(p2, `ui_en_female_${tb}${pg ? `_${pg}` : ''}`);
      }
      const fem = await p2.evaluate(() => { const s = window.__xr.state(); return { sex: s.sex, breast: s.breast?.enabled, outfit: s.outfit, ikBody: s.ikBody }; });
      check('female: underwear (panties + bra) worn, breast physics on, IK torso uses the female profile', fem.sex === 'female' && fem.breast && fem.outfit.includes('panties') && fem.outfit.includes('bra') && fem.ikBody?.male === 0, fem);
      // the breast size slider deepens the IK torso (hand-body collision); the default size is the measured profile (bust 0)
      const bust = await p2.evaluate(() => { const a = window.__app.avatar; const v0 = a.values.breastSize; a.setSlider('breastSize', 1); window.__app.syncIKBody(); const b = window.__xr.state().ikBody.bust; a.setSlider('breastSize', v0); window.__app.syncIKBody(); return { atMax: b, back: window.__xr.state().ikBody.bust }; });
      check('female: breast size slider -> deeper IK torso, and back', bust.atMax > 0.02 && Math.abs(bust.back) < 1e-6, bust);
      await closePage(p2, 'desktop-ui-en');
    }

    // ---------------- cloth: skirt + coat, wind, walking replay ----------------
    if (want('cloth')) {
      const walk = captures.find(c => c.name === 'walk')?.fixture;
      captures.push({ name: 'cloth_wind', rec: null, fixture: walk || null, cam: { off: [2.3, 0.2, -1.7], ty: 1.0 }, times: walk ? [1.2, 2.2] : null,
        extra: "app.avatar.clothing.setOutfit(['skirt','trenchcoat','shoes']);app.avatar.cloth?.setWind(0.8);" });
    }

    // ---------------- third person (desktop replay of the captured records) ----------------
    if (captures.length) {
      const needRec = captures.filter(c => c.rec || c.fixture);
      for (const c of captures) if (!c.rec && !c.fixture) c.rec = captures.find(x => x.rec)?.rec;
      await thirdPerson(browser, base, needRec.length ? captures.filter(c => c.rec || c.fixture) : []);
      // the same records on a female avatar (breasts + physics, default underwear coverage, skirt cloth)
      const fem = captures.filter(c => ['standing', 'walk', 'jump', 'across_chest'].includes(c.name) && (c.rec || c.fixture)).map(c => ({ ...c, name: `female_${c.name}` }));
      if (fem.length) await thirdPerson(browser, base, fem, '?shot=1&view=third&sex=female&outfit=tshirt,skirt,shoes');
    }
  } catch (e) {
    console.error(e); report.errors.push({ fatal: String(e?.stack || e) });
  } finally {
    await browser.close();
    await srv.close();
  }
  report.finished = new Date().toISOString();
  report.summary = { checks: report.checks.length, passed: report.checks.filter(c => c.ok).length, failed: report.checks.filter(c => !c.ok).map(c => c.name) };
  await writeFile(join(OUT, 'report.json'), JSON.stringify(report, null, 1));
  console.log(`\n${report.summary.passed}/${report.summary.checks} checks passed; ${report.shots.length} screenshots in build/shots/`);
  if (report.summary.failed.length) process.exitCode = 1;
}
main();
