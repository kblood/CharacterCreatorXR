import test from 'node:test';
import assert from 'node:assert/strict';
import { describeRuntime } from '../src/features.js';

test('runtime description: no xr / no session / full session', () => {
  const none = describeRuntime({ secure: false, xr: false, modes: {}, gl: {}, api: {} });
  assert.equal(none.find(r => r.key === 'navigator.xr').ok, false);
  assert.equal(none.find(r => r.key === 'session').value, 'not started');
  const full = describeRuntime({
    secure: true, xr: true, modes: { 'immersive-vr': true, 'immersive-ar': false }, gl: { renderer: 'Adreno (TM) 740', version: 'WebGL 2.0', multiview: true, maxSamples: 4 },
    api: { XRWebGLBinding: true, XRHand: true },
    session: { enabledFeatures: ['local-floor', 'hand-tracking'], refSpace: 'local-floor', blend: 'opaque', frameRate: 90, supportedFrameRates: [72, 90], fixedFoveation: 0.6,
      inputs: [{ handedness: 'left', mode: 'tracked-pointer', profiles: ['generic-hand'], hand: true, handJoints: 25, gamepad: null },
        { handedness: 'right', mode: 'tracked-pointer', profiles: ['oculus-touch-v3', 'generic-trigger'], hand: false, gamepad: { mapping: 'xr-standard', buttons: 7, axes: 4, haptics: 1 } }] },
  });
  const get = k => full.find(r => r.key === k);
  assert.equal(get('immersive-vr').ok, true);
  assert.equal(get('immersive-ar').ok, false);
  assert.equal(get('supported frame rates').value, '72, 90');
  assert.equal(get('fixed foveation').value, '0.60');
  assert.equal(get('hand tracking (any input with .hand)').ok, true);
  assert.match(get('input 1 right').value, /oculus-touch-v3 > generic-trigger.*7b\/4a, haptics 1/);
  // a runtime that reports nothing optional
  const bare = describeRuntime({ secure: true, xr: true, modes: {}, session: { enabledFeatures: null, refSpace: 'local', inputs: [] } });
  assert.equal(bare.find(r => r.key === 'enabled features').value, 'not reported');
  assert.equal(bare.find(r => r.key === 'supported frame rates').ok, false);
  assert.equal(bare.find(r => r.key === 'inputs').value, 'none yet');
  assert.equal(describeRuntime(null).length, 0);
});
