// The CharacterCreator character as a VR avatar: body + hair + clothing catalog + cloth + eyes, loaded from the
// synced assets (assets/, tools/sync_assets.mjs) with the synced CharacterCreator modules (vendor/cc/, never
// edited here). Update order and ownership follow CharacterCreator: applySliders -> applySkeleton -> re-measure;
// bones are written rotation-only by humanoid.applyPose; the avatar is placed only through gltf.scene
// (position / yaw / uniform scale).
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import * as CC from '../vendor/cc/character.js';
import { createHumanoid, applyPose, restHeads } from '../vendor/cc/humanoid.js';
import { headsFromSidecar } from '../vendor/cc/animation/rig.js';
import { createEyeLife, applyMorphWeights } from '../vendor/cc/eyelife.js';
import { upgradeSkin, upgradeHair, upgradeCornea, setSkinParams, hairUniforms, createHairCollider } from '../vendor/cc/materials.js';
import { createClothing } from '../vendor/cc/clothing.js';
import { createClothRuntime } from '../vendor/cc/cloth/runtime.js';
import { prepareRig } from './ik/rigdata.js';

export const LAYERS = { MAIN: 0, EYE_L: 1, EYE_R: 2, MONO: 3, HEAD: 4, UI: 5, DEBUG: 6 };
const DEFAULT_TINTS = { skin: '#c99a80', hairColor: '#3b2a1e', browColor: '#3b2a1e', eyeColor: '#4a2f19', lashes: '#1c1510' };
const FACE_PART = /^(Eyebrows|Eyelashes|Eyes|Teeth|Tongue)(_\d+)?$/;
const fetchJson = url => fetch(url).then(r => (r.ok ? r.json() : null)).catch(() => null);

/**
 * opts: { scene, settings (createSettings), t, lang(), setStatus, quality: { skinUpgrade, shadows }, useWorker }
 * Resolves to the avatar controller once the body is ready (hair/clothes may still be loading).
 */
export async function createAvatar(opts) {
  const { scene, settings, t, setStatus = () => {} } = opts;
  const S = settings.values;
  const loader = new GLTFLoader().setPath('./assets/');
  const jointsP = fetchJson('./assets/base_body.joints.json');
  const hairP = fetchJson('./assets/hair.json');
  const clothingP = fetchJson('./assets/clothing.json');
  const collidersP = fetchJson('./assets/body_colliders.json');

  setStatus(t('loading'));
  const g = await loader.loadAsync('base_body.glb', xhr => {
    if (xhr.lengthComputable) setStatus(`${t('loading')} ${Math.round(100 * xhr.loaded / xhr.total)}%`);
  });
  const root = g.scene;
  root.name = 'AvatarRoot';
  scene.add(root);
  const meshes = CC.characterMeshes(root);
  let body = meshes.find(m => m.name === 'Body') ?? meshes.find(m => /skin/i.test([].concat(m.material)[0]?.name || '')) ?? meshes[0];
  if (!body) throw new Error('base_body.glb: no skinned body mesh');
  const parts = [body];
  const values = { ...DEFAULT_TINTS, hair: null };
  for (const s of CC.SLIDERS) values[s.id] = Number(S.body?.[s.id]) || 0;
  if (S.skin) values.skin = S.skin;
  applySexParam(values, S.sex);
  const colliders = new Map();
  const eyeLife = createEyeLife({ blink: true });
  const q = opts.quality || {};

  const attach = m => {
    if (m !== body) CC.bindToSkeleton(m, body.skeleton, body.bindMatrix);
    m.frustumCulled = false;
    if (!parts.includes(m)) parts.push(m);
  };
  for (const m of meshes) attach(m);
  await upgradeMaterials(root, g.parser, q);
  setupMaterials(root, q);
  markHeadParts(root);

  const joints = await jointsP;
  const bodyValues = () => Object.fromEntries(CC.SLIDERS.map(s => [s.id, values[s.id]]));
  const tints = () => ({ skin: values.skin, hair: values.hairColor, brows: values.browColor, eyes: values.eyeColor, lashes: values.lashes });

  let humanoid = null, rig = null, rigListeners = [];
  const headBone = body.skeleton.bones.find(b => b.name === 'head');

  function update() {
    for (const m of parts) CC.applySliders(m, values);
    if (joints) CC.applySkeleton(body, joints, values);
    CC.applyTints(body.parent || body, tints());
    setSkinParams({ gender: values.gender });
    for (const c of colliders.values()) c.calibrate();
    hairUniforms.ccCollide.value = 1;
    if (humanoid) remeasure();
  }
  function remeasure() {
    rig = prepareRig(restHeads(humanoid), { eyeOffset: eyeOffset() });
    for (const f of rigListeners) f(rig);
  }

  // eye centre relative to the head joint at rest (neutral body), scaled with the head height later
  root.updateMatrixWorld(true);
  const eyeMid = (() => {
    const eyes = parts.filter(m => /^Eyes(_\d+)?$/.test(m.name));
    if (!eyes.length) return new THREE.Vector3(0, 1.553, 0.118);
    const box = new THREE.Box3();
    for (const m of eyes) { m.geometry.computeBoundingBox(); box.union(m.geometry.boundingBox.clone().applyMatrix4(m.matrixWorld)); }
    return box.getCenter(new THREE.Vector3());
  })();
  const headRest0 = new THREE.Vector3();
  headBone?.getWorldPosition(headRest0);
  const eyeOffset0 = [eyeMid.x - headRest0.x, eyeMid.y - headRest0.y, eyeMid.z - headRest0.z];
  let headH0 = headRest0.y || 1.515;
  function eyeOffset() {
    const h = humanoid ? restHeads(humanoid).head[1] : headH0;
    const k = h / headH0;
    return [0, eyeOffset0[1] * k, eyeOffset0[2] * k];
  }

  update();                                           // first applySkeleton at rest
  humanoid = createHumanoid(body, { root });          // snapshots rest rotations (must be at rest)
  remeasure();

  // ---- hair ----
  const hairManifest = await hairP;
  const hairCache = new Map();
  let hairToken = 0;
  if (!S.hairColor && hairManifest?.defaultColor) values.hairColor = hairManifest.defaultColor;
  if (S.hairColor) values.hairColor = S.hairColor;
  values.browColor = values.hairColor;
  async function loadHair(id) {
    if (hairCache.has(id)) return hairCache.get(id);
    const style = hairManifest?.styles?.find(s => s.id === id);
    if (!style) throw new Error(`unknown hair style ${id}`);
    const hg = await loader.loadAsync(style.file);
    const ms = CC.characterMeshes(hg.scene);
    if (!ms.length) throw new Error(`${style.file}: no skinned mesh`);
    for (const m of ms) {
      m.removeFromParent();
      m.position.copy(body.position); m.quaternion.copy(body.quaternion); m.scale.copy(body.scale);
      body.parent.add(m);
      const r = CC.bindToSkeleton(m, body.skeleton, body.bindMatrix);
      if (r.missing.length) throw new Error(`${style.file}: bones missing in the body skeleton`);
      m.frustumCulled = false;
    }
    const group = { traverse: f => ms.forEach(m => m.traverse(f)) };
    await upgradeMaterials(group, hg.parser, q);
    setupMaterials(group, q);
    for (const m of ms) {
      m.layers.set(LAYERS.HEAD);
      const c = createHairCollider(m);
      if (c.ok && c.weightedVertices) colliders.set(m, c);
    }
    hairCache.set(id, ms);
    return ms;
  }
  function showHair(id) { for (const [k, ms] of hairCache) for (const m of ms) m.visible = k === id; }
  async function setHair(id) {
    id = id || null;
    values.hair = id;
    const token = ++hairToken;
    if (!id || !hairManifest) { showHair(null); return; }
    try {
      const ms = await loadHair(id);
      if (token !== hairToken) return;
      for (const m of ms) if (!parts.includes(m)) parts.push(m);
      showHair(id);
      update();
    } catch (e) {
      console.error('[avatar] hair failed', e);
      if (token === hairToken) { showHair(null); setStatus(`hair ${id}: ${e.message}`, true); }
    }
  }

  // ---- clothing (vendor module; its DOM UI goes into a detached element, the VR UI calls its API) ----
  const clothing = createClothing({
    loader, lang: opts.lang(), t, setStatus,
    getBody: () => body,
    addPart: m => { if (!parts.includes(m)) parts.push(m); },
    onChange: () => { update(); cloth?.reset(); markHeadParts(root); },
  });

  // ---- cloth ----
  let cloth = null;
  const fwd = new THREE.Vector3();
  try {
    cloth = createClothRuntime({
      THREE, scene, colliders: await collidersP, getBody: () => body,
      getInfluences: () => CC.sliderInfluences(bodyValues()),
      getRootSpeed: () => 0,                          // the avatar really moves in the world: air drag comes from motion
      getForward: () => { fwd.set(0, 0, 1).applyQuaternion(root.quaternion); return [fwd.x, fwd.y, fwd.z]; },
      useWorker: opts.useWorker !== false,
    });
    cloth.setEnabled(S.cloth); cloth.setWind(S.wind);
  } catch (e) { console.error('[avatar] cloth disabled', e); cloth = null; }

  const hairWant = S.hair === undefined ? hairManifest?.default : S.hair;
  const hairDone = setHair(hairWant && hairWant !== 'none' ? hairWant : null);
  const clothDone = clothing.init(clothingP, document.createElement('div'), S.outfit ?? null).then(() => {
    for (const [id, c] of Object.entries(S.colors || {})) {
      if (c?.primary) clothing.setColor(id, 'primary', c.primary);
      if (c?.secondary) clothing.setColor(id, 'secondary', c.secondary);
    }
  }).catch(e => console.error('[avatar] clothing failed', e));

  // ---- per frame ----
  let lastWeights = {};
  let headHidden = false;
  const placement = { position: [0, 0, 0], yaw: 0, scale: 1 };
  const _q = new THREE.Quaternion(), _v = new THREE.Vector3(), up = new THREE.Vector3(0, 1, 0);

  /** Write an IK result: rotations via applyPose, placement via gltf.scene (position/yaw/scale). */
  function applyIK(res) {
    if (!res) return;
    applyPose(humanoid, res.pose);
    const { position, yaw, scale } = res.rig;
    _q.setFromAxisAngle(up, yaw);
    root.quaternion.copy(_q);
    root.scale.setScalar(scale);
    _v.fromArray(res.pose.root).multiplyScalar(scale).applyQuaternion(_q);
    root.position.set(position[0] + _v.x, position[1] + _v.y, position[2] + _v.z);
    placement.position = position; placement.yaw = yaw; placement.scale = scale;
  }

  /** Eyes (blink + gaze), hair capsules, cloth. Call after applyIK. */
  function tick(dt, gaze = null) {
    root.updateMatrixWorld(true);
    lastWeights = eyeLife.update(dt, gaze);
    for (const m of parts) applyMorphWeights(m, lastWeights);
    for (const [m, c] of colliders) if (m.visible) c.update();
    cloth?.update(dt, parts);
  }

  /** First-person: collapse the head bone (the Body mesh's own head) around the main (headset) render only. */
  function hideHead(on) {
    if (!headBone || headHidden === on) return;
    headHidden = on;
    headBone.scale.setScalar(on ? 1e-3 : 1);
    headBone.updateMatrixWorld(true);
  }

  // Sex: CharacterCreator is adding a binary sex value; until the synced character.js exposes one, the 'gender'
  // slider (female -1 .. male +1) is used. Detected generically so an upstream change needs no code change here.
  const sexApi = detectSex();

  return {
    root, body, parts, values, clothing, get cloth() { return cloth; }, get humanoid() { return humanoid; }, get rig() { return rig; },
    hairManifest, placement, eyeLife, loader, sex: sexApi, defaultTints: DEFAULT_TINTS,
    ready: Promise.all([hairDone, clothDone]),
    onRig(f) { rigListeners.push(f); if (rig) f(rig); },
    update, applyIK, tick, hideHead,
    setHair, get hair() { return values.hair; },
    setHairColor(hex) { values.hairColor = hex; values.browColor = hex; update(); },
    setSkin(hex) { values.skin = hex; update(); },
    setSlider(id, v) { values[id] = Math.max(-1, Math.min(1, +v || 0)); update(); cloth?.reset(); },
    sliders: CC.SLIDERS,
    bodyValues,
    weights: () => ({ ...lastWeights }),
    /** Avatar eye height (m, scale 1) for 'height' slider value h, other sliders as now (sidecar FK, no mesh work). */
    eyeHeightFor(h) {
      if (!joints) return null;
      const heads = headsFromSidecar(joints, CC.sliderInfluences({ ...bodyValues(), height: h }));
      return heads.head[1] + eyeOffset()[1] * (heads.head[1] / (restHeads(humanoid).head[1] || 1));
    },
    headWorld(out = new THREE.Vector3()) { return headBone ? headBone.getWorldPosition(out) : out.set(0, 1.5, 0); },
  };

  function detectSex() {
    const opt = CC.SEX_OPTIONS || CC.SEXES || null;               // future upstream export (array of ids)
    const setter = CC.applySex || null;
    if (Array.isArray(opt) && typeof setter === 'function') {
      return { kind: 'upstream', options: opt, get: () => values.sex ?? opt[0], set: v => { values.sex = v; setter(body, v, values); update(); } };
    }
    const hasGender = CC.SLIDERS.some(s => s.id === 'gender');
    if (!hasGender) return null;
    return { kind: 'gender-slider', options: ['female', 'male'], get: () => (values.gender >= 0 ? 'male' : 'female'),
      set: v => { values.gender = v === 'male' ? 1 : -1; update(); cloth?.reset(); } };
  }
}

function applySexParam(values, sex) {
  if (!sex) return;
  if (sex === 'female') values.gender = -1;
  else if (sex === 'male') values.gender = 1;
}

/** Face parts that must not be seen by the user's own eyes (first person) but must be in the mirror. */
function markHeadParts(root) {
  root.traverse(o => {
    if (!o.isMesh) return;
    if (FACE_PART.test(o.name) || [].concat(o.material).some(m => /^(Eyebrow|Eyelash|Eye|Iris|Cornea|Teeth|Tongue)$/.test(m?.name || ''))) o.layers.set(LAYERS.HEAD);
  });
}

async function upgradeMaterials(root, parser, q) {
  const jobs = [];
  root.traverse(o => {
    if (!o.isMesh) return;
    const mats = [].concat(o.material);
    mats.forEach((m, k) => {
      if (!m) return;
      const role = CC.materialRole(m.name);
      const swap = nm => { if (Array.isArray(o.material)) o.material[k] = nm; else o.material = nm; };
      try {
        if (role === 'skin') {
          if (q.skinUpgrade === false) return;                     // low quality: keep the glTF material
          const ri = m.userData?.ccRegions?.index;
          jobs.push((ri !== undefined && parser ? parser.getDependency('texture', ri) : Promise.resolve(null))
            .catch(() => null).then(tex => swap(upgradeSkin(m, tex))));
        } else if (role === 'hair') swap(upgradeHair(m, o.geometry));
        else if (m.name === 'Cornea') upgradeCornea(m);
      } catch (e) { console.warn('[avatar] material upgrade failed for', m.name, e); }
    });
  });
  await Promise.all(jobs);
}

function setupMaterials(root, q) {
  root.traverse(o => {
    if (!o.isMesh) return;
    o.castShadow = q.shadows !== false; o.receiveShadow = q.shadows !== false;
    for (const m of [].concat(o.material)) {
      if (!m) continue;
      const role = CC.materialRole(m.name);
      if (role === 'hair' || role === 'brows' || role === 'lashes') {
        m.alphaToCoverage = true; m.transparent = false; m.depthWrite = true; m.side = THREE.DoubleSide;
        if (role !== 'hair') o.castShadow = false;
      }
      if (m.name === 'Cornea') { m.envMapIntensity = 0.7; o.castShadow = false; o.receiveShadow = false; o.renderOrder = 2; }
      if (m.name === 'Eye' || m.name === 'Iris') o.castShadow = false;
      m.needsUpdate = true;
    }
  });
}
