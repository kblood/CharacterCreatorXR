// SPDX-License-Identifier: GPL-3.0-or-later
// DEV/TEST ONLY: keyframed driver for the IWER emulated device (headset, controllers, hands, buttons), used by
// tools/emulate_shots.mjs. window.__scenario.play(spec) -> Promise (resolves when the spec has played).
// spec = { duration, keys: [{ t, head: {pos, ypr}, left: {pos, ypr}, right: {pos, ypr}, mode: 'controller'|'hand',
//          handPose: {left, right}, pinch: {left, right}, buttons: {left|right: {id: value}},
//          touch: {left|right: {id: bool}}, axes: {left|right: {id: value}} }] }
// ypr = [yaw, pitch, roll] in degrees (yaw about +Y, pitch about +X, roll about +Z; order Y * X * Z).
const DEG = Math.PI / 180;
function quatYPR([y = 0, p = 0, r = 0]) {
  const cy = Math.cos(y * DEG / 2), sy = Math.sin(y * DEG / 2), cp = Math.cos(p * DEG / 2), sp = Math.sin(p * DEG / 2), cr = Math.cos(r * DEG / 2), sr = Math.sin(r * DEG / 2);
  // qy * qx
  const a = [cy * sp, sy * cp, -sy * sp, cy * cp];
  // (qy*qx) * qz
  return [a[0] * cr + a[1] * sr, a[1] * cr - a[0] * sr, a[2] * cr + a[3] * sr, a[3] * cr - a[2] * sr];
}
const lerp = (a, b, u) => a.map((x, i) => x + (b[i] - x) * u);

export function installScenarioDriver(device) {
  let timer = null;
  const apply = (obj, pose) => {
    if (!obj || !pose) return;
    if (pose.pos) obj.position.set(pose.pos[0], pose.pos[1], pose.pos[2]);
    if (pose.ypr) { const q = quatYPR(pose.ypr); obj.quaternion.set(q[0], q[1], q[2], q[3]); }
  };
  const lerpPose = (a, b, u) => (a && b ? { pos: a.pos && b.pos ? lerp(a.pos, b.pos, u) : a.pos, ypr: a.ypr && b.ypr ? lerp(a.ypr, b.ypr, u) : a.ypr } : a || b);
  function frameAt(spec, t) {
    const K = spec.keys;
    let i = 0;
    while (i + 1 < K.length && K[i + 1].t <= t) i++;
    const a = K[i], b = K[Math.min(i + 1, K.length - 1)];
    const u = b.t > a.t ? Math.min(1, Math.max(0, (t - a.t) / (b.t - a.t))) : 0;
    const e = u < 1 ? a : b;
    return { head: lerpPose(a.head, b.head, u), left: lerpPose(a.left, b.left, u), right: lerpPose(a.right, b.right, u),
      mode: e.mode ?? a.mode, handPose: e.handPose ?? a.handPose, pinch: e.pinch ?? a.pinch, buttons: e.buttons ?? a.buttons, touch: e.touch ?? a.touch, axes: e.axes ?? a.axes };
  }
  function applyFrame(f) {
    apply(device, f.head);
    if (f.mode && device.primaryInputMode !== f.mode) device.primaryInputMode = f.mode;
    const hand = device.primaryInputMode === 'hand';
    for (const s of ['left', 'right']) {
      const inp = hand ? device.hands?.[s] : device.controllers?.[s];
      apply(inp, f[s]);
      if (hand && inp) {
        if (f.handPose?.[s] && inp.poseId !== f.handPose[s]) inp.poseId = f.handPose[s];
        if (f.pinch?.[s] != null) inp.updatePinchValue(f.pinch[s]);
      }
      if (!hand && inp) {
        for (const [id, v] of Object.entries(f.buttons?.[s] || {})) inp.updateButtonValue(id, v);
        for (const [id, v] of Object.entries(f.touch?.[s] || {})) inp.updateButtonTouch(id, v);
        for (const [id, v] of Object.entries(f.axes?.[s] || {})) inp.updateAxis(id, 'x-axis', v);
      }
    }
  }
  const api = {
    play(spec) {
      api.stop();
      const t0 = performance.now();
      applyFrame(frameAt(spec, 0));
      return new Promise(resolve => {
        timer = setInterval(() => {
          const t = (performance.now() - t0) / 1000;
          applyFrame(frameAt(spec, Math.min(t, spec.duration)));
          if (t >= spec.duration) { api.stop(); resolve(); }
        }, 8);
      });
    },
    stop() { if (timer) clearInterval(timer); timer = null; },
    set(key) { applyFrame(frameAt({ keys: [{ t: 0, ...key }] }, 0)); },
    quatYPR,
  };
  window.__scenario = api;
  return api;
}
