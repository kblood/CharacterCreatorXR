// Thumbnails for the in-VR grids, rendered offscreen and cached (memory + localStorage as small JPEG data URLs).
//  - garments: the item's own GLB loaded separately and rendered alone in its bind pose, front view, tinted with
//    the current primary colour (the secondary mask is not applied in the thumbnail). One render per frame at
//    most, only while a grid that needs it is shown (request()); loads go through the browser HTTP cache.
//  - hair: the style's own GLB, rendered alone the same way (3/4 front view, current hair colour at first render);
//    captureHair() can instead take a portrait of the avatar wearing the style.
// Everything here is optional: a missing thumbnail shows a drawn placeholder.
import * as THREE from 'three';
import { renderToCanvas } from './snapshot.js';
import { LAYERS } from '../avatar.js';

const STORE = 'ccxr.thumbs.v1';
const MAX_STORED = 48;

export function createThumbnails({ renderer, scene, getAvatar, size = 160 }) {
  const mem = new Map();                 // key -> canvas / image
  let stored = {};
  try { stored = JSON.parse(localStorage.getItem(STORE) || '{}') || {}; } catch { stored = {}; }
  const queue = [], queued = new Set();
  let busy = false, rendered = 0, failed = 0;

  const persist = (key, canvas) => {
    try {
      stored[key] = { t: Date.now(), url: canvas.toDataURL('image/jpeg', 0.82) };
      const keys = Object.keys(stored).sort((a, b) => stored[b].t - stored[a].t);
      for (const k of keys.slice(MAX_STORED)) delete stored[k];
      localStorage.setItem(STORE, JSON.stringify(stored));
    } catch { /* quota / private mode: memory only */ }
  };
  const fromStore = key => {
    const s = stored[key];
    if (!s?.url || typeof Image === 'undefined') return null;
    const img = new Image();
    img.onload = () => { mem.set(key, img); api.onUpdate?.(key); };
    img.src = s.url;
    mem.set(key, null);                  // loading
    return null;
  };

  // ---- garment studio (own scene: two lights, transparent background) ----
  const studio = new THREE.Scene();
  studio.add(new THREE.HemisphereLight(0xffffff, 0x50505a, 1.6));
  const key = new THREE.DirectionalLight(0xffffff, 2.2); key.position.set(1, 2, 3); studio.add(key);
  const cam = new THREE.PerspectiveCamera(28, 1, 0.05, 20);
  const box = new THREE.Box3(), ctr = new THREE.Vector3(), sz = new THREE.Vector3();

  async function renderGarment(item, primary, { yaw = 0 } = {}) {
    const av = getAvatar();
    const g = await av.loader.loadAsync(`./${item.file}`);          // same URL as the clothing / hair modules (HTTP cache)
    try {
      const root = g.scene;
      root.traverse(o => {
        if (!o.isMesh) return;
        o.frustumCulled = false;
        for (const m of [].concat(o.material)) {
          const gain = Number(m.userData?.tint?.gain) > 0 ? Number(m.userData.tint.gain) : 1;
          if (primary && m.color) { m.color.set(primary); m.color.multiplyScalar(gain); }
          m.side = THREE.DoubleSide;
        }
      });
      studio.add(root);
      root.updateMatrixWorld(true);
      box.setFromObject(root, true);
      box.getCenter(ctr); box.getSize(sz);
      const r = Math.max(sz.y, sz.x) * 0.5 * 1.12;
      const dist = r / Math.tan((cam.fov * Math.PI) / 360);
      cam.position.set(ctr.x + dist * Math.sin(yaw + 0.12), ctr.y + dist * 0.06, ctr.z + dist * Math.cos(yaw + 0.12));
      cam.lookAt(ctr); cam.updateMatrixWorld();
      const c = renderToCanvas(renderer, studio, cam, size, size, { transparent: true, samples: 4 });
      studio.remove(root);
      return c;
    } finally {
      g.scene.traverse(o => { if (o.isMesh) { o.geometry.dispose(); for (const m of [].concat(o.material)) { for (const v of Object.values(m)) if (v?.isTexture) v.dispose(); m.dispose(); } } });
    }
  }

  // ---- hair portrait: the avatar's head from the front (whole scene, head layer on) ----
  const pcam = new THREE.PerspectiveCamera(30, 1, 0.05, 20);
  pcam.layers.disableAll(); pcam.layers.enable(LAYERS.MAIN); pcam.layers.enable(LAYERS.HEAD);
  const hp = new THREE.Vector3(), fwd = new THREE.Vector3();
  function renderHairPortrait() {
    const av = getAvatar();
    av.headWorld(hp);
    const s = av.root.scale.x || 1;
    fwd.set(0, 0, 1).applyQuaternion(av.root.quaternion);
    hp.y += 0.06 * s;
    pcam.position.copy(hp).addScaledVector(fwd, 0.62 * s); pcam.position.y += 0.03 * s;
    pcam.lookAt(hp); pcam.updateMatrixWorld();
    av.hideHead(false);
    return renderToCanvas(renderer, scene, pcam, size, size, { samples: 4 });
  }

  const api = {
    onUpdate: null,
    stats: () => ({ memory: mem.size, stored: Object.keys(stored).length, rendered, failed, queued: queue.length }),
    garmentKey: (item, primary) => `g:${item.id}:${(primary || item.colors?.primary || '').toLowerCase()}`,
    hairKey: id => `h:${id}`,
    /** canvas / image or null (then queue it if a job is given). */
    get(key) {
      if (mem.has(key)) return mem.get(key);
      if (stored[key]) return fromStore(key);
      return null;
    },
    request(key, job) {
      if (mem.has(key) || stored[key] || queued.has(key)) return;
      queued.add(key); queue.push({ key, job });
    },
    requestGarment(item, primary) { const k = api.garmentKey(item, primary); api.request(k, () => renderGarment(item, primary)); return api.get(k); },
    /** Hair style thumbnail (the style's GLB alone, 3/4 view, in the given colour at first render). */
    requestHair(style, color) { const k = api.hairKey(style.id); api.request(k, () => renderGarment(style, color, { yaw: 0.6 })); return api.get(k); },
    /** Take the hair portrait now (call when the style is loaded and shown). */
    captureHair(id) {
      if (!id) return;
      try { const c = renderHairPortrait(); mem.set(api.hairKey(id), c); persist(api.hairKey(id), c); rendered++; api.onUpdate?.(api.hairKey(id)); }
      catch (e) { failed++; console.warn('[thumbs] hair', e); }
    },
    /** Per frame: at most one queued job. */
    pump() {
      if (busy || !queue.length) return;
      const { key, job } = queue.shift();
      busy = true;
      Promise.resolve().then(job).then(c => {
        if (c) { mem.set(key, c); persist(key, c); rendered++; api.onUpdate?.(key); }
      }).catch(e => { failed++; mem.set(key, null); console.warn('[thumbs]', key, e?.message || e); })
        .finally(() => { busy = false; queued.delete(key); });
    },
    clear() { mem.clear(); stored = {}; try { localStorage.removeItem(STORE); } catch { /* ignore */ } },
  };
  return api;
}

/** Placeholder: a simple drawn silhouette per slot (own vector shapes). */
export function drawSlotIcon(c, slot, x, y, w, h, color = '#8a93a3') {
  c.save();
  c.translate(x + w / 2, y + h / 2);
  const s = Math.min(w, h) / 100;
  c.scale(s, s);
  c.fillStyle = color; c.strokeStyle = color; c.lineWidth = 5; c.lineJoin = 'round';
  c.beginPath();
  switch (slot) {
    case 'top': c.moveTo(-35, -30); c.lineTo(-15, -38); c.lineTo(15, -38); c.lineTo(35, -30); c.lineTo(45, -5); c.lineTo(30, 0); c.lineTo(25, -12); c.lineTo(25, 38); c.lineTo(-25, 38); c.lineTo(-25, -12); c.lineTo(-30, 0); c.lineTo(-45, -5); c.closePath(); c.fill(); break;
    case 'outerwear': c.moveTo(-30, -40); c.lineTo(30, -40); c.lineTo(45, 45); c.lineTo(5, 45); c.lineTo(0, -10); c.lineTo(-5, 45); c.lineTo(-45, 45); c.closePath(); c.fill(); break;
    case 'bottom': c.moveTo(-28, -38); c.lineTo(28, -38); c.lineTo(32, 42); c.lineTo(8, 42); c.lineTo(0, -5); c.lineTo(-8, 42); c.lineTo(-32, 42); c.closePath(); c.fill(); break;
    case 'shoes': c.moveTo(-40, 20); c.lineTo(-40, -5); c.lineTo(-15, -10); c.lineTo(5, 5); c.lineTo(40, 12); c.lineTo(40, 25); c.closePath(); c.fill(); break;
    case 'bra': c.arc(-16, 0, 16, 0, Math.PI); c.moveTo(32, 0); c.arc(16, 0, 16, 0, Math.PI); c.fill(); c.beginPath(); c.moveTo(-40, -6); c.lineTo(40, -6); c.stroke(); break;
    case 'underwear': c.moveTo(-35, -20); c.lineTo(35, -20); c.lineTo(30, 0); c.lineTo(8, 22); c.lineTo(-8, 22); c.lineTo(-30, 0); c.closePath(); c.fill(); break;
    case 'hair': c.arc(0, 4, 34, Math.PI, 0); c.lineTo(34, 36); c.lineTo(20, 36); c.lineTo(20, 8); c.lineTo(-20, 8); c.lineTo(-20, 36); c.lineTo(-34, 36); c.closePath(); c.fill(); break;
    case 'none': c.arc(0, 0, 30, 0, Math.PI * 2); c.moveTo(-21, 21); c.lineTo(21, -21); c.stroke(); break;
    default: c.arc(0, 0, 30, 0, Math.PI * 2); c.fill();
  }
  c.restore();
}
