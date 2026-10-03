// SPDX-License-Identifier: GPL-3.0-or-later
import test from 'node:test';
import assert from 'node:assert/strict';
import { createSliderDrag, hsvToHex, hexToHsv, pickColor, boardPlacement, createRecenterGesture } from '../src/ui/uilogic.js';

const TR = { x: 100, w: 400, min: -1, max: 1, step: 0.01 };
const close = (a, b, e = 1e-9) => Math.abs(a - b) <= e;

test('slider: pinch jitter inside the deadzone changes nothing; knob drag is relative', () => {
  const d = createSliderDrag();
  // knob at value 0 -> x = 300; press slightly off-centre on the knob
  d.down(TR, 312, 0, 0);
  assert.equal(d.move(TR, 318, 10), null, 'inside the deadzone');
  assert.equal(d.up(TR, 316, 20), 0, 'press + release on the knob keeps the value');
  d.down(TR, 312, 0, 100);
  const v = d.move(TR, 352, 120);           // +40 px relative -> +0.2
  assert.ok(close(v, 0.2, 1e-9), `relative ${v}`);
});

test('slider: tap on the track jumps there, drag on the track follows the pointer', () => {
  const d = createSliderDrag();
  d.down(TR, 400, 0, 0);
  assert.equal(d.up(TR, 403, 50), 0.5);
  d.down(TR, 150, 0.5, 100);
  assert.equal(d.move(TR, 140, 110), -0.8);
});

test('slider: release hysteresis drops the last ~90 ms (fingers opening)', () => {
  const d = createSliderDrag();
  d.down(TR, 300, 0, 0);
  for (let t = 10, x = 300; t <= 300; t += 10, x += 4) d.move(TR, x, t);   // steady drag to x = 416 (0.58)
  const before = d.state.value;
  d.move(TR, 480, 340); d.move(TR, 500, 360);                              // release jitter
  const v = d.up(TR, 500, 380);
  assert.ok(Math.abs(v - before) < 0.05, `committed ${v}, before jitter ${before}`);
});

test('colour conversions and the hue ring', () => {
  for (const hex of ['#ff0000', '#00ff00', '#0000ff', '#2f5f9e', '#e08a2c', '#808080', '#000000', '#ffffff']) {
    const { h, s, v } = hexToHsv(hex);
    assert.equal(hsvToHex(h, s, v), hex);
  }
  const G = { rInner: 120, rOuter: 160, half: 70 };
  assert.ok(close(pickColor(0, -140, G).h, 0), 'top of the ring = hue 0');
  assert.ok(close(pickColor(140, 0, G).h, 90));
  assert.ok(close(pickColor(0, 140, G).h, 180));
  const sq = pickColor(70, -70, G);
  assert.equal(sq.part, 'square'); assert.ok(close(sq.s, 1) && close(sq.v, 1));
  assert.equal(pickColor(85, -30, G), null);
  assert.equal(pickColor(100, 100, G).part, 'ring');
});

test('board placement: in front-right, facing the user, off the mirror line of sight', () => {
  const yawQ = a => [0, Math.sin(a / 2), 0, Math.cos(a / 2)];
  const p = boardPlacement({ pos: [0, 1.6, 0], quat: yawQ(0) });          // looking down -Z
  assert.ok(p.pos[2] < -0.5 && p.pos[0] > 0.2, JSON.stringify(p));
  assert.ok(close(p.pos[1], 1.3));
  // faces the user: +Z of the board toward the head
  const fz = [Math.sin(p.yaw), Math.cos(p.yaw)], to = [0 - p.pos[0], 0 - p.pos[2]], n = Math.hypot(...to);
  assert.ok(fz[0] * to[0] / n + fz[1] * to[1] / n > 0.99);
  // turned 90 deg left (looking down -X): board ahead (-X) and to the right (-Z)
  const q = boardPlacement({ pos: [0, 1.6, 0], quat: yawQ(Math.PI / 2) });
  assert.ok(q.pos[0] < -0.5 && q.pos[2] < -0.2, JSON.stringify(q));
  // a mirror right behind the default spot: the board moves to the left side
  const m = boardPlacement({ pos: [0, 1.6, 0], quat: yawQ(0) }, { mirror: { x: 0.6, z: -1.6, halfWidth: 0.75 } });
  assert.ok(m.pos[0] < 0, JSON.stringify(m));
  // the room's mirror (1.5 m wide at z = -1.6), user 2 m in front of it: no part of the board covers the mirror
  const r = boardPlacement({ pos: [0, 1.6, 0.4], quat: yawQ(0) }, { mirror: { x: 0, z: -1.6, halfWidth: 0.75 } });
  assert.ok(r.clear, JSON.stringify(r));
  const t = (-1.6 - 0.4) / (r.pos[2] - 0.4), inner = r.pos[0] - 0.56 * Math.sign(r.pos[0]);
  assert.ok(Math.abs(inner * t) > 0.75, `inner edge projects onto the mirror at ${inner * t}`);
  // clamped height for a seated / very tall user
  assert.ok(boardPlacement({ pos: [0, 1.0, 0], quat: yawQ(0) }).pos[1] >= 0.85);
});

test('recenter gesture: both palms up together for 1 s fires once', () => {
  const g = createRecenterGesture();
  const head = { pos: [0, 1.6, 0] };
  const palmUp = [1, 0, 0, 0];               // 180 deg about X: +Y (back of hand) points down
  const hands = { left: { valid: true, pos: [-0.1, 1.1, -0.3], quat: palmUp }, right: { valid: true, pos: [0.1, 1.1, -0.3], quat: palmUp } };
  let fired = 0;
  for (let i = 0; i < 72 * 3; i++) if (g.update(head, hands, 1 / 72)) fired++;
  assert.equal(fired, 1);
  // palms down: never
  const g2 = createRecenterGesture();
  const down = { left: { ...hands.left, quat: [0, 0, 0, 1] }, right: { ...hands.right, quat: [0, 0, 0, 1] } };
  for (let i = 0; i < 200; i++) assert.equal(g2.update(head, down, 1 / 72), false);
  // released and repeated: fires again
  g.update(head, down, 1 / 72);
  let again = 0; for (let i = 0; i < 100; i++) if (g.update(head, hands, 1 / 72)) again++;
  assert.equal(again, 1);
});
