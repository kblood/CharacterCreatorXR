// SPDX-License-Identifier: GPL-3.0-or-later
// Pointer interaction with CanvasTexture panels: controller / hand rays (select = trigger or pinch), index-finger
// poke (the avatar's own fingertip, so it works for controllers and hand tracking alike), mouse on desktop, and
// grabbing a panel (squeeze while pointing at it, or select on its grab bar). No per-frame allocations in the
// hot path; the session events only set flags.
import * as THREE from 'three';
import { LAYERS } from '../avatar.js';

const POKE_DOWN = 0.008, POKE_UP = 0.022, POKE_NEAR = 0.07, POKE_BEHIND = -0.04;

export function createInteraction({ scene, camera, dom, getPanels, getTip, onGrabEnd, onClickFeedback, haptics = () => true }) {
  const sides = ['left', 'right'];
  const st = {};
  for (const s of sides) {
    st[s] = {
      select: false, squeeze: false, selEdges: [], sqEdges: [],
      ray: { hit: null, panel: null, px: 0, py: 0, t: 0, active: false },
      poke: { panel: null, z: 1, down: false, px: 0, py: 0, near: false, widget: null },
      grab: null, source: null,
    };
  }
  const mouse = { hit: null, panel: null, px: 0, py: 0, down: false, x: 0, y: 0, inside: false };
  const ray = new THREE.Ray(), m4 = new THREE.Matrix4(), v = new THREE.Vector3(), q = new THREE.Quaternion(), inv = new THREE.Matrix4();
  const handM = new THREE.Matrix4(), one = new THREE.Vector3(1, 1, 1);
  const ndc = new THREE.Vector2(), rc = new THREE.Raycaster();

  // ---- visuals: one line + cursor per hand ----
  const vis = {};
  for (const s of sides) {
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(6), 3));
    const line = new THREE.Line(g, new THREE.LineBasicMaterial({ color: 0x9fd0ff, transparent: true, opacity: 0.55, depthWrite: false }));
    line.layers.set(LAYERS.UI); line.frustumCulled = false; line.visible = false; line.renderOrder = 6;
    const cursor = new THREE.Mesh(new THREE.RingGeometry(0.006, 0.011, 20), new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, depthTest: false, toneMapped: false }));
    cursor.layers.set(LAYERS.UI); cursor.visible = false; cursor.renderOrder = 7;
    scene.add(line, cursor);
    vis[s] = { line, cursor, pos: g.attributes.position };
  }

  /** Ray (world origin/dir) against every visible panel -> nearest hit {panel, t, px, py} or null. */
  function castRay(origin, dir, out, side = null) {
    out.panel = null; out.t = Infinity;
    for (const P of getPanels()) {
      if (!P.visible || !P.group.visible || (side && P.ownerSide === side)) continue;
      inv.copy(P.mesh.matrixWorld).invert();
      ray.origin.copy(origin).applyMatrix4(inv);
      ray.direction.copy(dir).transformDirection(inv);
      // transformDirection normalises: distances are compared in local units, so scale t back to world
      if (Math.abs(ray.direction.z) < 1e-6) continue;
      const tl = -ray.origin.z / ray.direction.z;
      if (tl <= 0) continue;
      const lx = ray.origin.x + ray.direction.x * tl, ly = ray.origin.y + ray.direction.y * tl;
      if (Math.abs(lx) > P.size[0] / 2 || Math.abs(ly) > P.size[1] / 2) continue;
      v.set(lx, ly, 0).applyMatrix4(P.mesh.matrixWorld);
      const tw = v.distanceTo(origin);
      if (tw < out.t) { out.t = tw; out.panel = P; [out.px, out.py] = P.toPixels(lx, ly); out.wx = v.x; out.wy = v.y; out.wz = v.z; }
    }
    return out.panel ? out : null;
  }

  function haptic(side, strength = 0.35, ms = 22) {
    // haptics: none on the Steam Frame in the community Chromium build (empty hapticActuators; docs/DEVICE_NOTES.md)
    if (haptics()) { try { const a = st[side].source?.gamepad?.hapticActuators?.[0]; a?.pulse?.(strength, ms); } catch { /* optional */ } }
    onClickFeedback?.(side);
  }

  function startGrab(side, P, poseM) {
    st[side].grab = { panel: P, offset: new THREE.Matrix4().copy(poseM).invert().multiply(P.group.matrixWorld) };
    haptic(side, 0.5, 30);
  }

  // ---- XR session events ----
  let session = null;
  const onSel = down => e => { const s = e.inputSource?.handedness; if (!st[s]) return; st[s].source = e.inputSource; st[s].select = down; st[s].selEdges.push(down); };
  const onSq = down => e => { const s = e.inputSource?.handedness; if (!st[s]) return; st[s].source = e.inputSource; st[s].squeeze = down; st[s].sqEdges.push(down); };
  const handlers = { selectstart: onSel(true), selectend: onSel(false), squeezestart: onSq(true), squeezeend: onSq(false) };
  function attach(s) {
    session = s;
    for (const [k, f] of Object.entries(handlers)) s.addEventListener(k, f);
    s.addEventListener('end', () => { session = null; for (const sd of sides) { st[sd].select = st[sd].squeeze = false; st[sd].grab = null; vis[sd].line.visible = vis[sd].cursor.visible = false; } });
  }

  // ---- mouse (desktop) : capture phase, so a click on a panel never reaches the look / trigger handlers ----
  function mouseRay(e) {
    const r = dom.getBoundingClientRect();
    ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    camera.updateMatrixWorld();
    rc.setFromCamera(ndc, camera);
    return castRay(rc.ray.origin, rc.ray.direction, mouse);
  }
  const inXR = () => !!session;
  addEventListener('pointermove', e => {
    if (inXR() || e.target !== dom) return;
    const hit = mouseRay(e);
    for (const P of getPanels()) if (P !== hit?.panel) { if (P.pressed.has('mouse')) P.pointerMove('mouse', null, null); else P.pointerMove('mouse', null, null); }
    if (hit) { hit.panel.pointerMove('mouse', hit.px, hit.py); dom.style.cursor = hit.panel.widgetAt(hit.px, hit.py) ? 'pointer' : 'default'; }
    else dom.style.cursor = '';
    // a slider keeps dragging when the mouse leaves the panel
    if (mouse.down && mouse.dragPanel && mouse.dragPanel !== hit?.panel) mouse.dragPanel.pointerMove('mouse', null, null);
  }, true);
  addEventListener('pointerdown', e => {
    if (inXR() || e.target !== dom || e.button !== 0) return;
    const hit = mouseRay(e);
    if (!hit) return;
    e.stopImmediatePropagation(); e.preventDefault();
    mouse.down = true; mouse.dragPanel = hit.panel;
    hit.panel.pointerDown('mouse', hit.px, hit.py);
  }, true);
  addEventListener('pointerup', e => {
    if (!mouse.down) return;
    mouse.down = false;
    const hit = mouseRay(e);
    const P = mouse.dragPanel; mouse.dragPanel = null;
    if (P) P.pointerUp('mouse', hit?.panel === P ? hit.px : null, hit?.panel === P ? hit.py : null);
    e.stopImmediatePropagation();
  }, true);

  const rayOrigin = new THREE.Vector3(), rayDir = new THREE.Vector3(), tip = new THREE.Vector3();
  const hitTmp = { panel: null };

  return {
    attach,
    state: st,
    mouse,
    /** Per frame (XR only does work): rec = tracking record. */
    update(rec) {
      if (!session) return;
      for (const side of sides) {
        const S = st[side], V = vis[side];
        const hand = rec?.hands?.[side];
        // --- grab ---
        if (S.grab) {
          const rp = hand?.ray;
          if (rp) {
            handM.compose(rayOrigin.fromArray(rp.pos), q.fromArray(rp.quat), one);
            m4.multiplyMatrices(handM, S.grab.offset);
            m4.decompose(S.grab.panel.group.position, S.grab.panel.group.quaternion, v);
            S.grab.panel.group.updateMatrixWorld();
          }
          const endSq = S.sqEdges.includes(false) && !S.squeeze, endSel = S.grab.bySelect && !S.select;
          if (endSq || endSel) { const P = S.grab.panel; S.grab = null; onGrabEnd?.(P); }
          S.sqEdges.length = 0; S.selEdges.length = 0;
          V.line.visible = V.cursor.visible = false;
          continue;
        }
        // --- poke with the avatar's index fingertip ---
        const pk = S.poke;
        let pokeNear = false;
        if (hand?.valid && getTip(side, tip)) {
          let best = null, bz = Infinity, bx = 0, by = 0;
          for (const P of getPanels()) {
            if (!P.visible || !P.group.visible || P.ownerSide === side) continue;   // a wrist menu is not poked by its own hand
            v.copy(tip); P.mesh.worldToLocal(v);
            if (Math.abs(v.x) > P.size[0] / 2 + 0.01 || Math.abs(v.y) > P.size[1] / 2 + 0.01) continue;
            if (v.z > POKE_NEAR || v.z < POKE_BEHIND) continue;
            if (Math.abs(v.z) < Math.abs(bz)) { best = P; bz = v.z; bx = v.x; by = v.y; }
          }
          if (best) {
            pokeNear = true;
            const [px, py] = best.toPixels(bx, by);
            if (pk.panel && pk.panel !== best) { pk.panel.cancel(`${side}-poke`); pk.down = false; }
            pk.panel = best; pk.px = px; pk.py = py;
            if (!pk.down) {
              best.pointerMove(`${side}-poke`, px, py);
              // press only when crossing the surface from the front (no presses when the hand enters from behind)
              if (bz < POKE_DOWN && pk.z >= POKE_DOWN) {
                const w = best.pointerDown(`${side}-poke`, px, py);
                pk.down = true; if (w) haptic(side);
              }
            } else {
              best.pointerMove(`${side}-poke`, px, py);
              if (bz > POKE_UP) { best.pointerUp(`${side}-poke`, px, py); pk.down = false; }
            }
            pk.z = bz;
          }
        }
        if (!pokeNear && pk.panel) {
          if (pk.down) pk.panel.pointerUp(`${side}-poke`, null, null);
          pk.panel.cancel(`${side}-poke`); pk.panel = null; pk.down = false; pk.z = 1;
        }
        if (!pokeNear) pk.z = 1;
        // --- ray ---
        const R = S.ray, rp = hand?.ray;
        let hit = null;
        if (rp && !pokeNear) {
          rayOrigin.fromArray(rp.pos); q.fromArray(rp.quat); rayDir.set(0, 0, -1).applyQuaternion(q);
          hit = castRay(rayOrigin, rayDir, hitTmp, side);
        }
        const pid = `${side}-ray`;
        if (R.panel && R.panel !== hit?.panel) {
          if (R.panel.pressed.has(pid)) R.panel.pointerMove(pid, null, null);
          else R.panel.cancel(pid);
        }
        if (hit) { R.panel = hit.panel; R.px = hit.px; R.py = hit.py; hit.panel.pointerMove(pid, hit.px, hit.py); }
        else if (!R.panel?.pressed.has(pid)) R.panel = null;
        for (const down of S.selEdges) {
          if (down && hit) {
            const w = hit.panel.pointerDown(pid, hit.px, hit.py);
            if (w) haptic(side);
            if (w?.grab) { hit.panel.pointerUp(pid, null, null); handM.compose(rayOrigin, q, one); startGrab(side, hit.panel, handM); S.grab.bySelect = true; }
            else if (!w && hit.panel.grabbable) { handM.compose(rayOrigin, q, one); startGrab(side, hit.panel, handM); S.grab.bySelect = true; }
          } else if (!down && R.panel?.pressed.has(pid)) {
            R.panel.pointerUp(pid, hit?.panel === R.panel ? hit.px : null, hit?.panel === R.panel ? hit.py : null);
          }
        }
        for (const down of S.sqEdges) if (down && hit?.panel?.grabbable && !S.grab) { handM.compose(rayOrigin, q, one); startGrab(side, hit.panel, handM); }
        S.selEdges.length = 0; S.sqEdges.length = 0;
        // --- visuals ---
        if (rp && !pokeNear) {
          const len = hit ? hit.t : 0.35;
          const p = V.pos.array;
          p[0] = rayOrigin.x; p[1] = rayOrigin.y; p[2] = rayOrigin.z;
          p[3] = rayOrigin.x + rayDir.x * len; p[4] = rayOrigin.y + rayDir.y * len; p[5] = rayOrigin.z + rayDir.z * len;
          V.pos.needsUpdate = true;
          V.line.visible = true; V.line.material.opacity = hit ? 0.8 : 0.25;
          V.cursor.visible = !!hit;
          if (hit) { V.cursor.position.set(hit.wx, hit.wy, hit.wz); V.cursor.quaternion.copy(hit.panel.group.quaternion); V.cursor.translateZ(0.002); V.cursor.scale.setScalar(S.select ? 0.7 : 1); }
        } else { V.line.visible = false; V.cursor.visible = false; }
      }
    },
    /** Test hook: synthesize a click on a widget id (desktop emulation of UI tests). */
    clickWidget(P, id) {
      const w = P.widgets.find(x => x.id === id || x.label === id);
      if (!w) return false;
      P.pointerDown('test', w.x + w.w / 2, w.y + w.h / 2); P.pointerUp('test', w.x + w.w / 2, w.y + w.h / 2);
      return true;
    },
  };
}
