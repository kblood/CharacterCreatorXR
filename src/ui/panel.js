// SPDX-License-Identifier: GPL-3.0-or-later
// CanvasTexture panel: a flat quad (layer UI) whose texture is a 2D canvas with simple widgets.
// Widgets are plain objects in canvas pixels: { id, kind, x, y, w, h, label, ... }. The panel redraws only when
// marked dirty (hover / value change) or, for live panels, at a fixed rate. Pointers talk in canvas pixels
// (pointerDown/Move/Up with a pointer id), so ray, poke and mouse all share one path (src/ui/interact.js).
import * as THREE from 'three';
import { LAYERS } from '../avatar.js';
import { createSliderDrag } from './uilogic.js';

export const THEME = {
  bg: 'rgba(24,27,33,0.92)', bgSolid: '#181b21', panel: '#232730', fg: '#eceae6', muted: '#9aa1ab', accent: '#6cb4ff', accentFg: '#0b1a2a',
  button: '#343a46', buttonHover: '#465062', disabled: '#2a2e36', danger: '#e0685c', ok: '#6fcf8a', warn: '#f0c05a', track: '#4a5160', border: '#3c4350',
  font: 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
};

function rr(ctx, x, y, w, h, r) {
  r = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
}

export function fitText(ctx, text, maxW) {
  text = String(text ?? '');
  if (ctx.measureText(text).width <= maxW) return text;
  let lo = 0, hi = text.length;
  while (lo < hi) { const m = (lo + hi + 1) >> 1; if (ctx.measureText(text.slice(0, m) + '…').width <= maxW) lo = m; else hi = m - 1; }
  return text.slice(0, lo) + '…';
}

/**
 * createPanel({ name, px:[w,h], size:[wm,hm], live:hz, radius }) -> panel
 * panel.build = () => widgets[]  (called on invalidate(true))
 */
export function createPanel({ name = 'Panel', px = [1024, 704], size = [0.9, 0.62], live = 0, radius = 28, layer = LAYERS.UI } = {}) {
  const canvas = document.createElement('canvas');
  canvas.width = px[0]; canvas.height = px[1];
  const ctx = canvas.getContext('2d');
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  tex.generateMipmaps = true; tex.minFilter = THREE.LinearMipmapLinearFilter;
  const mat = new THREE.MeshBasicMaterial({ map: tex, transparent: true, toneMapped: false, side: THREE.FrontSide, depthWrite: true });
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(size[0], size[1]), mat);
  mesh.name = name; mesh.layers.set(layer); mesh.renderOrder = 5;
  const group = new THREE.Group(); group.name = name; group.add(mesh);

  const P = {
    name, canvas, ctx, tex, mesh, group, size, px, widgets: [], hover: new Map(), pressed: new Map(), dirty: true, needsBuild: true,
    live, lastLive: 0, build: () => [], drawBackground: null, visible: true,
    invalidate(rebuild = false) { P.dirty = true; if (rebuild) P.needsBuild = true; },
    setVisible(v) { P.visible = !!v; group.visible = P.visible; },
    widgetAt(x, y) {
      for (let i = P.widgets.length - 1; i >= 0; i--) {
        const w = P.widgets[i];
        if (!w.interactive || w.disabled) continue;
        if (x >= w.x && x <= w.x + w.w && y >= w.y && y <= w.y + w.h) return w;
      }
      return null;
    },
    /** local hit point (metres, panel plane) -> canvas pixels */
    toPixels(lx, ly) { return [(lx / size[0] + 0.5) * px[0], (0.5 - ly / size[1]) * px[1]]; },
    pointerMove(pid, x, y) {
      const pr = P.pressed.get(pid);
      if (pr && pr.kind === 'slider') { sliderMove(pr, x); return pr; }
      if (pr && pr.kind === 'area') { if (x != null) { pr.onPoint?.(x - pr.x, y - pr.y, 'move'); P.dirty = true; } return pr; }
      const w = x == null ? null : P.widgetAt(x, y);
      if (P.hover.get(pid) !== w) { if (w) P.hover.set(pid, w); else P.hover.delete(pid); P.dirty = true; }
      return w;
    },
    pointerDown(pid, x, y) {
      const w = P.widgetAt(x, y);
      if (!w) return null;
      P.pressed.set(pid, w); P.dirty = true;
      if (w.kind === 'slider') { w._sd ||= createSliderDrag(); w._sd.down(track(w), x, w.value(), performance.now()); }
      if (w.kind === 'area') w.onPoint?.(x - w.x, y - w.y, 'down');
      return w;
    },
    pointerUp(pid, x, y) {
      const w = P.pressed.get(pid);
      P.pressed.delete(pid); P.dirty = true;
      if (!w) return null;
      if (w.kind === 'slider') { sliderUp(w, x); return w; }
      if (w.kind === 'area') { w.onPoint?.(x == null ? null : x - w.x, y == null ? null : y - w.y, 'up'); return w; }
      if (x != null && P.widgetAt(x, y) === w) { w.onClick?.(w); return w; }
      return null;
    },
    cancel(pid) { P.pressed.delete(pid); if (P.hover.delete(pid)) P.dirty = true; },
    update(now) {
      if (!P.visible) return;
      if (P.live && now - P.lastLive > 1000 / P.live) { P.lastLive = now; P.dirty = true; }
      if (P.needsBuild) { P.needsBuild = false; P.widgets = P.build() || []; P.dirty = true; }
      if (!P.dirty) return;
      P.dirty = false;
      draw();
      tex.needsUpdate = true;
    },
  };

  // sliders: deadzone on press, knob-relative drag, release hysteresis (src/ui/uilogic.js createSliderDrag)
  const track = w => ({ x: w.x + w.trackX, w: w.w - w.trackX - w.valueW, min: w.min, max: w.max, step: w.step });
  function sliderMove(w, x) {
    if (x == null || !w._sd) return;
    const v = w._sd.move(track(w), x, performance.now());
    if (v == null) return;
    w._drag = v; P.dirty = true;
    const now = performance.now();
    if (!w._t || now - w._t > (w.throttle ?? 60)) { w._t = now; w.onChange?.(v, false); }
  }
  function sliderUp(w, x) {
    if (!w._sd) return;
    const v = w._sd.up(track(w), x, performance.now());
    w._drag = null; P.dirty = true;
    w.onChange?.(v, true);
  }

  function draw() {
    const c = ctx, T = THEME;
    c.clearRect(0, 0, px[0], px[1]);
    rr(c, 2, 2, px[0] - 4, px[1] - 4, radius); c.fillStyle = T.bg; c.fill();
    c.lineWidth = 3; c.strokeStyle = T.border; c.stroke();
    P.drawBackground?.(c);
    const hovered = new Set(P.hover.values()), pressed = new Set(P.pressed.values());
    for (const w of P.widgets) drawWidget(c, w, hovered.has(w), pressed.has(w));
  }

  function drawWidget(c, w, hov, prs) {
    const T = THEME;
    c.textBaseline = 'middle';
    const fs = w.font || Math.round(Math.min(34, w.h * 0.46));
    c.font = `${w.bold ? 600 : 500} ${fs}px ${T.font}`;
    switch (w.kind) {
      case 'label': case 'text': {
        c.fillStyle = w.color || (w.kind === 'label' ? T.muted : T.fg);
        c.textAlign = w.align || 'left';
        const x = w.align === 'center' ? w.x + w.w / 2 : w.align === 'right' ? w.x + w.w : w.x;
        // greedy word wrap to the widget width (long sentences, e.g. Danish, would otherwise be cut off)
        const lines = [];
        for (const para of String(w.label ?? '').split('\n')) {
          let cur = '';
          for (const word of para.split(' ')) {
            const next = cur ? `${cur} ${word}` : word;
            if (cur && c.measureText(next).width > w.w) { lines.push(cur); cur = word; } else cur = next;
          }
          lines.push(cur);
        }
        const lh = fs * 1.25;
        const maxLines = Math.max(1, Math.floor((w.h + fs * 0.3) / lh));   // more lines than fit: the last one is cut
        if (lines.length > maxLines) lines.splice(maxLines - 1, lines.length, lines.slice(maxLines - 1).join(' '));
        lines.forEach((ln, i) => c.fillText(fitText(c, ln, w.w), x, w.y + w.h / 2 + (i - (lines.length - 1) / 2) * lh));
        break;
      }
      case 'button': case 'tab': case 'toggle': {
        const active = typeof w.active === 'function' ? w.active() : w.active;
        rr(c, w.x, w.y, w.w, w.h, w.r ?? 12);
        c.fillStyle = w.disabled ? T.disabled : active ? T.accent : prs ? T.accent : hov ? T.buttonHover : (w.color || T.button);
        c.fill();
        if (hov && !w.disabled) { c.lineWidth = 3; c.strokeStyle = T.accent; c.stroke(); }
        c.fillStyle = w.disabled ? T.muted : active || (w.color && !hov && !prs) ? T.accentFg : T.fg;
        c.textAlign = 'center';
        let label = w.label;
        if (w.kind === 'toggle') label = `${w.label}: ${w.value() ? w.onText : w.offText}`;
        const inset = w.kind === 'toggle' ? 30 : 0;
        c.fillText(fitText(c, label, w.w - 16 - inset), w.x + (w.w + inset) / 2, w.y + w.h / 2 + 1);
        if (w.kind === 'toggle') {
          const on = w.value();
          c.fillStyle = on ? T.ok : T.muted;
          c.beginPath(); c.arc(w.x + 18, w.y + w.h / 2, 7, 0, Math.PI * 2); c.fill();
        }
        break;
      }
      case 'swatch': {
        const active = typeof w.active === 'function' ? w.active() : w.active;
        rr(c, w.x, w.y, w.w, w.h, 10); c.fillStyle = w.color; c.fill();
        c.lineWidth = active ? 6 : hov ? 4 : 2; c.strokeStyle = active ? T.accent : hov ? '#fff' : T.border; c.stroke();
        break;
      }
      case 'slider': {
        const v = w._drag ?? w.value();
        c.fillStyle = T.fg; c.textAlign = 'left';
        c.fillText(fitText(c, w.label, w.trackX - 14), w.x, w.y + w.h / 2);
        const tx = w.x + w.trackX, tw = w.w - w.trackX - w.valueW, ty = w.y + w.h / 2;
        const f = (v - w.min) / (w.max - w.min);
        rr(c, tx, ty - 6, tw, 12, 6); c.fillStyle = T.track; c.fill();
        if (w.min < 0 && w.max > 0) { const zx = tx + (-w.min / (w.max - w.min)) * tw; c.fillStyle = T.muted; c.fillRect(zx - 1, ty - 12, 2, 24); }
        rr(c, tx, ty - 6, Math.max(12, tw * f), 12, 6); c.fillStyle = T.accent; c.fill();
        c.beginPath(); c.arc(tx + tw * f, ty, prs ? 17 : hov ? 15 : 13, 0, Math.PI * 2); c.fillStyle = prs || hov ? '#fff' : '#dde6f2'; c.fill();
        c.textAlign = 'right'; c.fillStyle = T.muted;
        c.fillText(w.format ? w.format(v) : v.toFixed(2), w.x + w.w, ty);
        break;
      }
      case 'bar': {         // read-only value bar (debug)
        const v = Math.max(0, Math.min(1, w.value()));
        rr(c, w.x, w.y, w.w, w.h, 4); c.fillStyle = T.track; c.fill();
        if (v > 0) { rr(c, w.x, w.y, Math.max(6, w.w * v), w.h, 4); c.fillStyle = w.color || T.accent; c.fill(); }
        break;
      }
      case 'tile': {          // thumbnail tile: image (canvas / bitmap / null) + caption
        const active = typeof w.active === 'function' ? w.active() : w.active;
        rr(c, w.x, w.y, w.w, w.h, 14);
        c.fillStyle = active ? '#2c4a6b' : hov ? T.buttonHover : T.button; c.fill();
        if (active || hov) { c.lineWidth = active ? 5 : 3; c.strokeStyle = T.accent; c.stroke(); }
        const capH = w.caption ? 34 : 0, pad = 8, iw = w.w - 2 * pad, ih = w.h - capH - 2 * pad;
        const img = typeof w.image === 'function' ? w.image() : w.image;
        if (img) {
          const k = Math.min(iw / img.width, ih / img.height), dw = img.width * k, dh = img.height * k;
          c.drawImage(img, w.x + pad + (iw - dw) / 2, w.y + pad + (ih - dh) / 2, dw, dh);
        } else if (w.placeholder) w.placeholder(c, w.x + pad, w.y + pad, iw, ih);
        if (w.caption) {
          c.fillStyle = active ? T.fg : T.fg; c.textAlign = 'center'; c.font = `500 ${w.captionFont || 22}px ${T.font}`;
          c.fillText(fitText(c, w.caption, w.w - 10), w.x + w.w / 2, w.y + w.h - capH / 2 - 2);
        }
        if (w.badge) { c.fillStyle = T.accent; c.beginPath(); c.arc(w.x + w.w - 16, w.y + 16, 9, 0, 7); c.fill(); }
        break;
      }
      case 'area': w.draw?.(c, w, hov, prs); break;
      case 'custom': w.draw(c, w, hov, prs); break;
      default: break;
    }
  }

  return P;
}

/** Flow layout helper: places widgets left to right and wraps. */
export function flow(x0, y0, maxX, gap = 12) {
  const L = {
    x: x0, y: y0, rowH: 0, x0, maxX, gap, out: [],
    add(w) {
      if (L.x + w.w > L.maxX && L.x > L.x0) L.newline();
      w.x = L.x; w.y = L.y; L.x += w.w + gap; L.rowH = Math.max(L.rowH, w.h);
      L.out.push(w); return w;
    },
    newline(extra = 0) { L.x = L.x0; L.y += L.rowH + gap + extra; L.rowH = 0; },
    full(w) { if (L.x > L.x0) L.newline(); w.w = L.maxX - L.x0; return L.add(w); },
  };
  return L;
}

export const btn = (label, w, onClick, extra = {}) => ({ kind: 'button', label, w, h: 72, interactive: true, onClick, ...extra });
export const toggle = (label, w, value, onClick, t) => ({ kind: 'toggle', label, w, h: 72, interactive: true, value, onClick, onText: t('on'), offText: t('off') });
export const slider = (label, w, min, max, value, onChange, extra = {}) => ({ kind: 'slider', label, w, h: 64, min, max, value, onChange, interactive: true, trackX: extra.trackX ?? 230, valueW: extra.valueW ?? 90, ...extra });
export const label = (text, w, extra = {}) => ({ kind: 'label', label: text, w, h: 40, ...extra });
export const swatch = (color, active, onClick, size = 52) => ({ kind: 'swatch', color, w: size, h: size, active, onClick, interactive: true });
export const tile = (caption, w, h, image, onClick, extra = {}) => ({ kind: 'tile', caption, w, h, image, onClick, interactive: true, ...extra });
/** Free-form interactive area: onPoint(localX, localY, 'down' | 'move' | 'up') (local px; null on 'up' outside). */
export const area = (w, h, draw, onPoint, extra = {}) => ({ kind: 'area', w, h, draw, onPoint, interactive: true, ...extra });
