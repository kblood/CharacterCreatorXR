// A small procedural room: floor with a standing marker, back wall with the mirror, soft lighting.
// Everything is generated (no texture downloads). The mirror wall faces +Z (the user starts at the origin
// looking toward -Z, i.e. at the mirror).
import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';

export const SHADOW_LAYER = 7;
export const ROOM = { mirrorZ: -1.6, mirrorWidth: 1.5, mirrorHeight: 2.0, mirrorBottom: 0.12, size: 7 };

function checkerTexture(a = '#6f6a64', b = '#65605a', n = 8) {
  const c = document.createElement('canvas'); c.width = c.height = 256;
  const g = c.getContext('2d');
  const s = 256 / n;
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) { g.fillStyle = (i + j) % 2 ? a : b; g.fillRect(i * s, j * s, s, s); }
  // subtle plank lines
  g.strokeStyle = 'rgba(0,0,0,0.12)'; g.lineWidth = 2;
  for (let i = 0; i <= n; i++) { g.beginPath(); g.moveTo(0, i * s); g.lineTo(256, i * s); g.stroke(); }
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping; tex.repeat.set(ROOM.size / 1, ROOM.size / 1);
  tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = 4;
  return tex;
}

function markerTexture() {
  const c = document.createElement('canvas'); c.width = c.height = 256;
  const g = c.getContext('2d');
  g.clearRect(0, 0, 256, 256);
  g.strokeStyle = 'rgba(255,255,255,0.85)'; g.lineWidth = 8;
  g.beginPath(); g.arc(128, 128, 110, 0, Math.PI * 2); g.stroke();
  // footprints hint + arrow toward the mirror (-Z = up in the texture)
  g.fillStyle = 'rgba(255,255,255,0.8)';
  g.beginPath(); g.moveTo(128, 20); g.lineTo(100, 62); g.lineTo(156, 62); g.closePath(); g.fill();
  g.fillStyle = 'rgba(255,255,255,0.35)';
  for (const x of [96, 160]) { g.beginPath(); g.ellipse(x, 140, 16, 34, 0, 0, Math.PI * 2); g.fill(); }
  const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

export function createRoom(scene, renderer, { shadows = true, shadowSize = 1024 } = {}) {
  const group = new THREE.Group(); group.name = 'Room';
  scene.add(group);
  scene.background = new THREE.Color(0x30343c);
  // sky dome (own shader: vertical gradient + soft sun glow), seen above the open walls; no texture download
  const skyMat = new THREE.ShaderMaterial({
    side: THREE.BackSide, depthWrite: false, fog: false, toneMapped: true,
    uniforms: { top: { value: new THREE.Color(0x5d86c4) }, horizon: { value: new THREE.Color(0xd8dfe8) }, ground: { value: new THREE.Color(0x3a3d44) },
      sun: { value: new THREE.Vector3(0.35, 0.55, 0.75).normalize() } },
    vertexShader: 'varying vec3 vDir; void main(){ vDir = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
    fragmentShader: `uniform vec3 top; uniform vec3 horizon; uniform vec3 ground; uniform vec3 sun; varying vec3 vDir;
      void main(){ vec3 d = normalize(vDir); float h = d.y;
        vec3 c = h > 0.0 ? mix(horizon, top, pow(h, 0.55)) : mix(horizon, ground, pow(-h, 0.4));
        c += vec3(1.0, 0.92, 0.8) * pow(max(dot(d, sun), 0.0), 64.0) * 0.6;
        gl_FragColor = vec4(c, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
  });
  const sky = new THREE.Mesh(new THREE.SphereGeometry(30, 32, 16), skyMat);
  sky.name = 'Sky'; sky.frustumCulled = false; sky.renderOrder = -10;
  scene.add(sky);
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  scene.environmentIntensity = 0.55;
  pmrem.dispose();

  const floor = new THREE.Mesh(new THREE.PlaneGeometry(ROOM.size, ROOM.size),
    new THREE.MeshStandardMaterial({ map: checkerTexture(), roughness: 0.85, metalness: 0 }));
  floor.rotation.x = -Math.PI / 2; floor.receiveShadow = shadows; floor.name = 'Floor';
  group.add(floor);

  const marker = new THREE.Mesh(new THREE.PlaneGeometry(0.7, 0.7), new THREE.MeshBasicMaterial({ map: markerTexture(), transparent: true, depthWrite: false }));
  marker.rotation.x = -Math.PI / 2; marker.position.y = 0.003; marker.name = 'FloorMarker'; marker.renderOrder = 1;
  group.add(marker);

  const wallMat = new THREE.MeshStandardMaterial({ color: 0x8b8f96, roughness: 0.95 });
  const wallH = 3;
  const back = new THREE.Mesh(new THREE.PlaneGeometry(ROOM.size, wallH), wallMat);
  back.position.set(0, wallH / 2, ROOM.mirrorZ - 0.02); back.receiveShadow = shadows; back.name = 'BackWall';
  group.add(back);
  const sideMat = new THREE.MeshStandardMaterial({ color: 0x9a9690, roughness: 0.95 });
  for (const sx of [-1, 1]) {
    const w = new THREE.Mesh(new THREE.PlaneGeometry(ROOM.size, wallH), sideMat);
    w.rotation.y = -sx * Math.PI / 2; w.position.set(sx * ROOM.size / 2, wallH / 2, ROOM.mirrorZ + ROOM.size / 2 - 0.02); w.name = 'SideWall';
    group.add(w);
  }
  const rear = new THREE.Mesh(new THREE.PlaneGeometry(ROOM.size, wallH), new THREE.MeshStandardMaterial({ color: 0x7d8a86, roughness: 0.95 }));
  rear.rotation.y = Math.PI; rear.position.set(0, wallH / 2, ROOM.mirrorZ + ROOM.size - 0.02); rear.name = 'RearWall';
  group.add(rear);
  // a few props so the mirror image reads as a room (and gives depth cues)
  const propMat = new THREE.MeshStandardMaterial({ color: 0x5a6b7c, roughness: 0.6 });
  const box = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.45, 0.5), propMat); box.position.set(1.6, 0.225, 1.2); box.castShadow = box.receiveShadow = shadows;
  const plant = new THREE.Mesh(new THREE.CylinderGeometry(0.18, 0.14, 0.4, 20), new THREE.MeshStandardMaterial({ color: 0x9c5b3b, roughness: 0.8 }));
  plant.position.set(-1.7, 0.2, 1.5);
  const leaves = new THREE.Mesh(new THREE.IcosahedronGeometry(0.35, 1), new THREE.MeshStandardMaterial({ color: 0x3f7a4a, roughness: 0.8, flatShading: true }));
  leaves.position.set(-1.7, 0.7, 1.5); leaves.castShadow = shadows;
  group.add(box, plant, leaves);

  // skirting boards (depth cue where the walls meet the floor)
  const skirtMat = new THREE.MeshStandardMaterial({ color: 0x4a4744, roughness: 0.7 });
  for (const [w, x, z, ry] of [[ROOM.size, 0, ROOM.mirrorZ + 0.0, 0], [ROOM.size, -ROOM.size / 2 + 0.01, ROOM.mirrorZ + ROOM.size / 2, Math.PI / 2], [ROOM.size, ROOM.size / 2 - 0.01, ROOM.mirrorZ + ROOM.size / 2, -Math.PI / 2]]) {
    const s = new THREE.Mesh(new THREE.BoxGeometry(w, 0.08, 0.02), skirtMat); s.position.set(x, 0.04, z); s.rotation.y = ry; group.add(s);
  }
  // lights: hemisphere (sky / floor bounce) + key (shadow) + rim + a soft fill from the open side; the key light
  // follows the avatar so its small shadow map stays sharp
  scene.add(new THREE.HemisphereLight(0xdfe8ff, 0x4a4540, 0.95));
  const fill = new THREE.DirectionalLight(0xffe6cc, 0.35); fill.position.set(-1.5, 1.6, 3); scene.add(fill);
  const key = new THREE.DirectionalLight(0xfff4e8, 2.0); key.position.set(1.5, 3.2, 1.2);
  key.castShadow = shadows;
  key.shadow.mapSize.set(shadowSize, shadowSize);
  Object.assign(key.shadow.camera, { left: -1.3, right: 1.3, top: 1.3, bottom: -1.3, near: 0.5, far: 8 });
  key.shadow.bias = -0.0004; key.shadow.normalBias = 0.02; key.shadow.radius = 3;
  scene.add(key, key.target);
  const rim = new THREE.DirectionalLight(0xdde6ff, 0.6); rim.position.set(-2, 2.5, -2.5); scene.add(rim);

  // mirror frame (the mirror surface itself is src/mirror.js)
  const frameMat = new THREE.MeshStandardMaterial({ color: 0x2b2420, roughness: 0.45, metalness: 0.2 });
  const fw = 0.06, W = ROOM.mirrorWidth, H = ROOM.mirrorHeight, cy = ROOM.mirrorBottom + H / 2, z = ROOM.mirrorZ + 0.015;
  for (const [w, h, x, y] of [[W + 2 * fw, fw, 0, cy + H / 2 + fw / 2], [W + 2 * fw, fw, 0, cy - H / 2 - fw / 2], [fw, H, -W / 2 - fw / 2, cy], [fw, H, W / 2 + fw / 2, cy]]) {
    const b = new THREE.Mesh(new THREE.BoxGeometry(w, h, 0.04), frameMat); b.position.set(x, y, z); b.castShadow = false; b.receiveShadow = shadows;
    group.add(b);
  }
  // shadow-only pass: the key light is also on layer SHADOW_LAYER; a camera that sees only that layer renders
  // no mesh but makes three.js update the shadow map (see shadowPass in src/main.js)
  key.layers.enable(SHADOW_LAYER);
  return {
    group, floor, marker, key, sky,
    setShadows(on) { key.castShadow = !!on; },
    /** keep the shadow frustum around the avatar */
    follow(p) { key.position.set(p.x + 1.5, 3.2, p.z + 1.2); key.target.position.set(p.x, 0.9, p.z); },
    mirrorRect: { center: new THREE.Vector3(0, cy, ROOM.mirrorZ + 0.02), width: W, height: H, normal: new THREE.Vector3(0, 0, 1) },
  };
}
