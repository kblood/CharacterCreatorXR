// SPDX-License-Identifier: GPL-3.0-or-later
// DEV ONLY: installs the Immersive Web Emulation Runtime (IWER, MIT, Meta) when the page is opened with
// ?emulate=quest3|hands|fingers. Used by tools/emulate_shots.mjs in headless Chrome. It is never loaded
// otherwise. 'fingers' is a FAKE controller ('test-finger-controller') with extra analog buttons 7..10 and an
// axis 4 carrying per-finger curls, to exercise the gamepad-finger path; it does not model any real device.
export async function installEmulation(kind) {
  let IWER;
  try { IWER = await import('../../node_modules/iwer/build/iwer.module.js'); }
  catch { IWER = await import('https://cdn.jsdelivr.net/npm/iwer@2.5.0/+esm'); }
  const { XRDevice, metaQuest3 } = IWER;
  let config = metaQuest3;
  if (kind === 'fingers') {
    const q = metaQuest3.controllerConfig;
    const extra = [7, 8, 9, 10].map(i => ({ id: `finger${i}`, type: 'analog' }));
    const layout = {};
    for (const side of ['left', 'right']) {
      const base = q.layout[side];
      layout[side] = { ...base, gamepad: { ...base.gamepad, buttons: [...base.gamepad.buttons, ...extra], axes: [...base.gamepad.axes, { id: 'thumbcurl', type: 'x-axis' }] } };
    }
    config = { ...metaQuest3, name: 'Emulated finger controller (fake)', controllerConfig: { profileId: 'test-finger-controller', fallbackProfileIds: ['generic-trigger-squeeze-thumbstick'], layout } };
  }
  const device = new XRDevice(config, { stereoEnabled: true });
  device.installRuntime({ forceInstall: true });
  device.position.set(0, 1.6, 0.4);
  // extra hand poses (open / fist / hook) generated from IWER's relaxed pose, for the finger scenarios
  try {
    const { curledHandPose, HAND_POSE_CURLS } = await import('./handposes.js');
    const P = IWER.P_HAND_INPUT;
    for (const side of ['left', 'right']) {
      const h = device.hands?.[side];
      if (!h || !P || !h[P]) continue;
      const poses = h[P].poses;
      for (const [name, curls] of Object.entries(HAND_POSE_CURLS)) poses[name] = curledHandPose(poses.default, curls);
    }
  } catch (e) { console.warn('[emulate] extra hand poses unavailable', e); }
  if (kind === 'hands') device.primaryInputMode = 'hand';
  window.__iwer = { device, IWER, kind };
  (await import('./scenario.js')).installScenarioDriver(device);
  return device;
}
