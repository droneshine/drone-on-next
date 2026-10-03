import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { ColliderWorld, Collider } from './colliders';
import { heightAt, FLATS, LAKE, WATER_Y } from './terrain';
import { mulberry, fbm } from './noise';

const BASE = import.meta.env.BASE_URL;
export const loader = new THREE.TextureLoader();

export const COL = {
  evergreen: '#002518', green: '#004225', light: '#b5f78a', accent: '#26c257', off: '#f7f7f2', blue: '#8fc2f5',
};

function shadowed<T extends THREE.Object3D>(o: T, temp?: number): T {
  o.traverse(c => { if ((c as THREE.Mesh).isMesh) { c.castShadow = true; c.receiveShadow = true; } });
  if (temp != null) o.userData.temp = temp;
  return o;
}

function box(w: number, h: number, d: number, mat: THREE.Material, x: number, y: number, z: number, cw: ColliderWorld | null, rotY = 0, surface: Collider['surface'] = 'hard') {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
  m.position.set(x, y, z); m.rotation.y = rotY;
  shadowed(m);
  if (cw) cw.add({ kind: 'box', half: new THREE.Vector3(w / 2, h / 2, d / 2) }, m.position.clone(), m.quaternion.clone(), { surface });
  return m;
}

// --------------------------------------------------------------- home base
export function buildBase(cw: ColliderWorld) {
  const g = new THREE.Group();
  const concrete = new THREE.MeshStandardMaterial({ color: '#b9b7af', roughness: 0.92 });
  const apron = new THREE.Mesh(new THREE.BoxGeometry(56, 0.2, 40), concrete);
  apron.position.set(0, 0.1, 4); apron.receiveShadow = true;
  g.add(apron);
  cw.add({ kind: 'box', half: new THREE.Vector3(28, 0.1, 20) }, apron.position.clone());

  const pads: THREE.Vector3[] = [];
  const padTex = padTexture();
  for (let i = -1; i <= 1; i++) {
    const pad = new THREE.Mesh(new THREE.CylinderGeometry(3.2, 3.2, 0.06, 48), [
      new THREE.MeshStandardMaterial({ color: '#2a2e2b', roughness: 0.8 }),
      new THREE.MeshStandardMaterial({ map: padTex, roughness: 0.75 }),
      new THREE.MeshStandardMaterial({ color: '#2a2e2b' }),
    ]);
    pad.position.set(i * 10, 0.23, 0);
    pad.receiveShadow = true;
    g.add(pad);
    pads.push(new THREE.Vector3(i * 10, 0.26, 0));
  }

  // mission control container with the brand on its flank
  const cont = new THREE.Group();
  const shell = new THREE.MeshStandardMaterial({ color: COL.green, roughness: 0.55, metalness: 0.25 });
  const body = new THREE.Mesh(new THREE.BoxGeometry(12.2, 2.9, 2.45), shell);
  body.position.y = 1.45 + 0.2;
  cont.add(body);
  // corrugation
  const rib = new THREE.InstancedMesh(new THREE.BoxGeometry(0.06, 2.6, 2.5), shell, 40);
  const mm = new THREE.Matrix4();
  for (let i = 0; i < 40; i++) { mm.makeTranslation(-6 + 0.15 + i * 0.3, 1.65, 0); rib.setMatrixAt(i, mm); }
  cont.add(rib);
  const logoTex = loader.load(BASE + 'img/lockup_white.png');
  logoTex.colorSpace = THREE.SRGBColorSpace; logoTex.anisotropy = 8;
  const logo = new THREE.Mesh(new THREE.PlaneGeometry(6.5, 2.0), new THREE.MeshStandardMaterial({ map: logoTex, transparent: true, roughness: 0.5 }));
  logo.position.set(0, 1.75, 1.29);
  cont.add(logo);
  const logoB = logo.clone(); logoB.rotation.y = Math.PI; logoB.position.z = -1.29; cont.add(logoB);
  cont.position.set(-6, 0, 22);
  shadowed(cont, 0.58);
  g.add(cont);
  cw.add({ kind: 'box', half: new THREE.Vector3(6.1, 1.6, 1.3) }, new THREE.Vector3(-6, 1.65, 22));

  // service van
  const van = buildVan();
  van.position.set(12, 0.2, 21); van.rotation.y = -0.35;
  g.add(van);
  cw.add({ kind: 'box', half: new THREE.Vector3(1.05, 1.3, 2.9) }, new THREE.Vector3(12, 1.4, 21), van.quaternion.clone());

  // windsock, honest wind indicator for the pilot
  const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.07, 6, 8), new THREE.MeshStandardMaterial({ color: '#dcdcd6', metalness: 0.6, roughness: 0.4 }));
  pole.position.set(24, 3, 18);
  g.add(shadowed(pole));
  cw.add({ kind: 'cyl', radius: 0.08, halfH: 3 }, pole.position.clone());
  const sock = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.3, 1.6, 12, 4, true), new THREE.MeshStandardMaterial({ map: sockTexture(), side: THREE.DoubleSide, roughness: 0.8 }));
  sock.geometry.rotateZ(Math.PI / 2); sock.geometry.translate(0.8, 0, 0);
  const sockPivot = new THREE.Group(); sockPivot.position.set(24, 5.9, 18); sockPivot.add(sock);
  g.add(sockPivot);

  // pilot position marker
  const pilot = new THREE.Mesh(new THREE.RingGeometry(0.5, 0.65, 40), new THREE.MeshBasicMaterial({ color: COL.light }));
  pilot.rotation.x = -Math.PI / 2; pilot.position.set(0, 0.22, 14);
  g.add(pilot);

  // flood light masts
  for (const [x, z] of [[-26, -14], [26, -14]]) {
    const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.18, 9, 8), new THREE.MeshStandardMaterial({ color: '#777', metalness: 0.7, roughness: 0.4 }));
    mast.position.set(x, 4.5, z); g.add(shadowed(mast));
    cw.add({ kind: 'cyl', radius: 0.2, halfH: 4.5 }, mast.position.clone());
    const head = box(1.6, 0.4, 0.4, new THREE.MeshStandardMaterial({ color: '#333', emissive: '#fff8e0', emissiveIntensity: 0.0 }), x, 9.1, z, cw);
    g.add(head);
  }
  return { group: g, pads, sockPivot, pilotPos: new THREE.Vector3(0, 1.7, 14) };
}

function buildVan() {
  const v = new THREE.Group();
  const white = new THREE.MeshStandardMaterial({ color: '#f2f2ee', roughness: 0.35, metalness: 0.3 });
  const green = new THREE.MeshStandardMaterial({ color: COL.green, roughness: 0.4, metalness: 0.3 });
  const glass = new THREE.MeshStandardMaterial({ color: '#1d2a30', roughness: 0.05, metalness: 0.9 });
  const tyre = new THREE.MeshStandardMaterial({ color: '#151515', roughness: 0.9 });
  const b = new THREE.Mesh(new THREE.BoxGeometry(2.0, 2.2, 4.4), white); b.position.set(0, 1.5, -0.6); v.add(b);
  const cab = new THREE.Mesh(new THREE.BoxGeometry(2.0, 1.5, 1.4), white); cab.position.set(0, 1.15, 2.2); v.add(cab);
  const hood = new THREE.Mesh(new THREE.BoxGeometry(1.96, 0.5, 0.6), white); hood.position.set(0, 0.7, 3.0); v.add(hood);
  const ws = new THREE.Mesh(new THREE.PlaneGeometry(1.8, 0.8), glass); ws.position.set(0, 1.55, 2.92); ws.rotation.x = -0.35; v.add(ws);
  const stripe = new THREE.Mesh(new THREE.BoxGeometry(2.02, 0.35, 4.4), green); stripe.position.set(0, 1.0, -0.6); v.add(stripe);
  for (const [x, z] of [[-0.9, 2.3], [0.9, 2.3], [-0.9, -1.8], [0.9, -1.8]]) {
    const w = new THREE.Mesh(new THREE.CylinderGeometry(0.38, 0.38, 0.28, 18), tyre);
    w.rotation.z = Math.PI / 2; w.position.set(x, 0.38, z); v.add(w);
  }
  return shadowed(v, 0.6);
}

function padTexture() {
  const c = document.createElement('canvas'); c.width = c.height = 512;
  const g = c.getContext('2d')!;
  g.fillStyle = '#2a2e2b'; g.fillRect(0, 0, 512, 512);
  g.strokeStyle = COL.light; g.lineWidth = 14;
  g.beginPath(); g.arc(256, 256, 226, 0, Math.PI * 2); g.stroke();
  g.lineWidth = 4; g.beginPath(); g.arc(256, 256, 196, 0, Math.PI * 2); g.stroke();
  // four point sparkle, the brand mark
  g.fillStyle = 'rgba(247,247,242,0.42)';
  g.save(); g.translate(256, 256); g.scale(0.7, 0.7);
  for (let i = 0; i < 4; i++) {
    g.rotate(Math.PI / 2);
    g.beginPath(); g.moveTo(0, -18); g.quadraticCurveTo(10, -60, 0, -120); g.quadraticCurveTo(-10, -60, 0, -18); g.fill();
  }
  g.restore();
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8;
  return t;
}

function sockTexture() {
  const c = document.createElement('canvas'); c.width = 128; c.height = 16;
  const g = c.getContext('2d')!;
  for (let i = 0; i < 5; i++) { g.fillStyle = i % 2 ? '#f7f7f2' : '#ff6a1a'; g.fillRect(i * 128 / 5, 0, 128 / 5, 16); }
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

// --------------------------------------------------------------- freestyle park
export interface Ring { pos: THREE.Vector3; quat: THREE.Quaternion; R: number; mesh: THREE.Mesh; }

export function buildFreestyle(cw: ColliderWorld) {
  const g = new THREE.Group();
  const cx = -200, cz = 0;
  const rings: Ring[] = [];
  const ringMat = new THREE.MeshStandardMaterial({ color: COL.light, emissive: COL.light, emissiveIntensity: 2.2, roughness: 0.3 });
  const ringGeo = new THREE.TorusGeometry(2.6, 0.16, 12, 64);
  // a flowing loop: low fast section, climb over the bando, dive through the crane
  const path: [number, number, number, number][] = [
    [cx + 70, 3, cz + 10, 90], [cx + 45, 4, cz + 30, 60], [cx + 15, 6, cz + 42, 90], [cx - 15, 9, cz + 40, 120],
    [cx - 42, 14, cz + 22, 160], [cx - 50, 18, cz - 8, 180], [cx - 35, 22, cz - 35, 220], [cx - 5, 26, cz - 45, 270],
    [cx + 22, 16, cz - 40, 300], [cx + 40, 8, cz - 25, 320], [cx + 55, 4, cz - 8, 350], [cx + 72, 3, cz - 2, 0],
  ];
  path.forEach(([x, y, z, yaw], i) => {
    const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, THREE.MathUtils.degToRad(yaw), 0));
    const m = new THREE.Mesh(ringGeo, ringMat.clone());
    m.position.set(x, y + heightAt(x, z), z); m.quaternion.copy(q);
    m.castShadow = true;
    m.userData.temp = 0.55;
    g.add(m);
    // posts to the ground so rings feel built, not floating
    const h = m.position.y - 2.6;
    if (h > 0.5) {
      const post = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.1, h, 8), new THREE.MeshStandardMaterial({ color: '#3b403d', metalness: 0.5, roughness: 0.5 }));
      post.position.set(x, h / 2 + heightAt(x, z), z);
      g.add(shadowed(post));
      cw.add({ kind: 'cyl', radius: 0.1, halfH: h / 2 }, post.position.clone());
    }
    cw.add({ kind: 'torus', R: 2.6, r: 0.16 }, m.position.clone(), q, { tag: 'ring', data: i });
    rings.push({ pos: m.position.clone(), quat: q, R: 2.6, mesh: m });
  });

  // the bando: two storey concrete shell with window holes
  const conc = new THREE.MeshStandardMaterial({ color: '#8d8a83', roughness: 0.95 });
  const bx = cx - 20, bz = cz + 5;
  const W = 24, D = 14, Hf = 4.2;
  for (let f = 0; f < 2; f++) {
    const y0 = f * Hf;
    // floor slab
    g.add(box(W, 0.3, D, conc, bx, y0 + Hf, bz, cw));
    // walls with openings: long walls split into piers
    for (const zs of [-1, 1]) {
      for (let k = 0; k < 6; k++) {
        const px = bx - W / 2 + 2 + k * 4;
        g.add(box(1.4, Hf, 0.3, conc, px, y0 + Hf / 2, bz + zs * D / 2, cw));
        g.add(box(2.6, 1.0, 0.3, conc, px + 2, y0 + 0.5, bz + zs * D / 2, cw));
        g.add(box(2.6, 0.7, 0.3, conc, px + 2, y0 + Hf - 0.35, bz + zs * D / 2, cw));
      }
    }
    for (const xs of [-1, 1]) {
      g.add(box(0.3, Hf, D * 0.32, conc, bx + xs * W / 2, y0 + Hf / 2, bz - D * 0.34, cw));
      g.add(box(0.3, Hf, D * 0.32, conc, bx + xs * W / 2, y0 + Hf / 2, bz + D * 0.34, cw));
      g.add(box(0.3, 1.2, D * 0.36, conc, bx + xs * W / 2, y0 + Hf - 0.6, bz, cw));
    }
    // inner columns
    for (const px of [-6, 0, 6]) g.add(box(0.5, Hf, 0.5, conc, bx + px, y0 + Hf / 2, bz, cw));
  }
  // roof hole for dives
  // stair tower
  g.add(box(4, 12, 4, conc, bx + W / 2 + 2, 6, bz - D / 2 + 2, cw));

  // container stack
  const contColors = ['#004225', '#8fc2f5', '#c94f2a', '#e7e3d6', '#26c257', '#3a4752'];
  const stack: [number, number, number, number][] = [[0, 0, 0, 0], [0, 0, 2.5, 0], [0, 1, 1.25, 0], [8, 0, -2, 0.3], [8, 1, -2, 0.1], [-9, 0, 30, 1.2]];
  stack.forEach(([dx, lvl, dz, r], i) => {
    const mat = new THREE.MeshStandardMaterial({ color: contColors[i % contColors.length], roughness: 0.6, metalness: 0.3 });
    g.add(box(6.06, 2.59, 2.44, mat, cx + 35 + dx, 1.3 + lvl * 2.59, cz - 15 + dz, cw, r));
  });

  // race gates
  const gateMat = new THREE.MeshStandardMaterial({ color: COL.off, roughness: 0.5 });
  const gateAccent = new THREE.MeshStandardMaterial({ color: COL.accent, roughness: 0.5, emissive: COL.accent, emissiveIntensity: 0.25 });
  const gates: [number, number, number][] = [[cx + 10, cz - 15, 0], [cx + 20, cz - 5, 0.8], [cx - 5, cz - 20, -0.4]];
  for (const [x, z, r] of gates) {
    const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), r);
    const parts: [number, number, number, number, number, number, THREE.Material][] = [
      [-1.6, 1.6, 0, 0.2, 3.2, 0.2, gateMat], [1.6, 1.6, 0, 0.2, 3.2, 0.2, gateMat], [0, 3.2, 0, 3.4, 0.25, 0.25, gateAccent],
    ];
    for (const [ox, oy, oz, w, h, d, mat] of parts) {
      const o = new THREE.Vector3(ox, oy, oz).applyQuaternion(q);
      g.add(box(w, h, d, mat, x + o.x, o.y, z + o.z, cw, r));
    }
  }

  // ramps and kicker cubes
  const rampMat = new THREE.MeshStandardMaterial({ color: '#5a5f5b', roughness: 0.85 });
  for (const [x, z, r, s] of [[cx + 25, cz + 18, 0.3, 1], [cx - 45, cz - 30, 2.4, 1.6]]) {
    const ramp = new THREE.Mesh(new THREE.BoxGeometry(8 * s, 0.4, 14 * s), rampMat);
    const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(-0.32, r, 0, 'YXZ'));
    ramp.quaternion.copy(q); ramp.position.set(x, 2.2 * s, z);
    g.add(shadowed(ramp));
    cw.add({ kind: 'box', half: new THREE.Vector3(4 * s, 0.2, 7 * s) }, ramp.position.clone(), q);
  }
  // tower crane
  const steel = new THREE.MeshStandardMaterial({ color: '#e1b12c', roughness: 0.5, metalness: 0.5 });
  const crane = new THREE.Group();
  const mast = new THREE.Mesh(new THREE.BoxGeometry(1.6, 44, 1.6), steel); mast.position.y = 22; crane.add(mast);
  const jib = new THREE.Mesh(new THREE.BoxGeometry(46, 1.2, 1.2), steel); jib.position.set(10, 44.6, 0); crane.add(jib);
  const counter = new THREE.Mesh(new THREE.BoxGeometry(5, 2.2, 2.4), new THREE.MeshStandardMaterial({ color: '#777', roughness: 0.8 })); counter.position.set(-10, 43.6, 0); crane.add(counter);
  const cab = new THREE.Mesh(new THREE.BoxGeometry(2.2, 2.2, 2.2), steel); cab.position.set(1.5, 42.5, 1.6); crane.add(cab);
  crane.position.set(cx - 10, 0, cz - 50);
  crane.rotation.y = 0.5;
  g.add(shadowed(crane, 0.5));
  cw.add({ kind: 'box', half: new THREE.Vector3(0.8, 22, 0.8) }, new THREE.Vector3(cx - 10, 22, cz - 50));
  const jq = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), 0.5);
  const jo = new THREE.Vector3(10, 44.6, 0).applyQuaternion(jq);
  cw.add({ kind: 'box', half: new THREE.Vector3(23, 0.6, 0.6) }, new THREE.Vector3(cx - 10 + jo.x, jo.y, cz - 50 + jo.z), jq);

  return { group: g, rings };
}

// --------------------------------------------------------------- wind turbine
export function buildTurbine(cw: ColliderWorld) {
  const g = new THREE.Group();
  const f = FLATS[4];
  const x = f.x, z = f.z, y0 = f.h;
  const white = new THREE.MeshStandardMaterial({ color: '#f1f2ef', roughness: 0.45 });
  const tower = new THREE.Mesh(new THREE.CylinderGeometry(1.4, 2.6, 90, 24), white);
  tower.position.set(x, y0 + 45, z);
  g.add(shadowed(tower, 0.5));
  cw.add({ kind: 'cyl', radius: 2.2, halfH: 45 }, tower.position.clone());
  const nac = new THREE.Mesh(new THREE.BoxGeometry(4, 4, 10), white);
  nac.position.set(x, y0 + 92, z + 1);
  g.add(shadowed(nac, 0.85));
  cw.add({ kind: 'box', half: new THREE.Vector3(2, 2, 5) }, nac.position.clone());
  const hub = new THREE.Group();
  hub.position.set(x, y0 + 92, z - 4.5);
  const blades: { c: Collider; ang: number }[] = [];
  const bladeGeo = new THREE.BoxGeometry(2.4, 44, 0.5);
  bladeGeo.translate(0, 24, 0);
  // taper the blade
  const p = bladeGeo.attributes.position as THREE.BufferAttribute;
  for (let i = 0; i < p.count; i++) { const yy = p.getY(i); p.setX(i, p.getX(i) * (1 - (yy - 2) / 46 * 0.8)); }
  bladeGeo.computeVertexNormals();
  for (let i = 0; i < 3; i++) {
    const b = new THREE.Mesh(bladeGeo, white);
    b.rotation.z = i * Math.PI * 2 / 3;
    hub.add(shadowed(b));
    const c = cw.add({ kind: 'box', half: new THREE.Vector3(0.9, 21, 0.3) }, new THREE.Vector3(), new THREE.Quaternion(), { tag: 'blade' });
    blades.push({ c, ang: i * Math.PI * 2 / 3 });
  }
  const spinner = new THREE.Mesh(new THREE.SphereGeometry(1.6, 16, 12), white);
  hub.add(spinner);
  g.add(hub);
  const tmpQ = new THREE.Quaternion(), tmpP = new THREE.Vector3();
  let rot = 0;
  return {
    group: g,
    update(dt: number) {
      rot += dt * 1.15;
      hub.rotation.z = rot;
      for (const b of blades) {
        const a = b.ang + rot;
        tmpQ.setFromAxisAngle(new THREE.Vector3(0, 0, 1), a);
        tmpP.set(0, 24, 0).applyQuaternion(tmpQ).add(hub.position);
        cw.move(b.c, tmpP, tmpQ);
      }
    },
  };
}

// --------------------------------------------------------------- forest
export function buildForest(cw: ColliderWorld, count = 1700) {
  const g = new THREE.Group();
  // conifer: trunk + 3 cones, vertex coloured
  const colorize = (geo: THREE.BufferGeometry, c: string) => {
    const col = new THREE.Color(c); const n = geo.attributes.position.count;
    const arr = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) { arr[i * 3] = col.r; arr[i * 3 + 1] = col.g; arr[i * 3 + 2] = col.b; }
    geo.setAttribute('color', new THREE.BufferAttribute(arr, 3));
    return geo;
  };
  const trunk = () => colorize(new THREE.CylinderGeometry(0.18, 0.28, 3, 6).translate(0, 1.5, 0), '#4a3423');
  const conifer = mergeGeometries([
    trunk(),
    colorize(new THREE.ConeGeometry(2.4, 4.5, 8).translate(0, 4.2, 0), '#21452a'),
    colorize(new THREE.ConeGeometry(1.9, 3.8, 8).translate(0, 6.2, 0), '#264f2f'),
    colorize(new THREE.ConeGeometry(1.3, 3.2, 8).translate(0, 8.1, 0), '#2c5a34'),
  ].map(x => x.toNonIndexed()))!;
  const leafy = mergeGeometries([
    trunk(),
    colorize(new THREE.IcosahedronGeometry(2.6, 1).translate(0, 5.2, 0), '#3d6b2c'),
    colorize(new THREE.IcosahedronGeometry(1.9, 1).translate(1.2, 6.3, 0.6), '#4a7a33'),
    colorize(new THREE.IcosahedronGeometry(1.7, 1).translate(-1.1, 6.0, -0.7), '#36612a'),
  ].map(x => x.toNonIndexed()))!;
  conifer.computeVertexNormals(); leafy.computeVertexNormals();
  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9, flatShading: true });
  const uTime = { value: 0 };
  mat.onBeforeCompile = (sh) => {
    sh.uniforms.uTime = uTime;
    sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nuniform float uTime;')
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        float sway = max(0.0, position.y - 2.5) * 0.025;
        vec4 ip = instanceMatrix * vec4(0.,0.,0.,1.);
        transformed.x += sin(uTime * 1.3 + ip.x * 0.11 + ip.z * 0.07) * sway;
        transformed.z += cos(uTime * 1.1 + ip.x * 0.05) * sway * 0.6;`);
  };
  const rnd = mulberry(1234);
  const placed: { x: number; z: number; s: number; type: number; r: number }[] = [];
  let tries = 0;
  while (placed.length < count && tries < count * 30) {
    tries++;
    const x = (rnd() - 0.5) * 1500, z = (rnd() - 0.5) * 1500;
    // clustered forest
    if (fbm(x * 0.006 + 40, z * 0.006, 3) < 0.5) continue;
    let ok = true;
    for (const f of FLATS) if (Math.abs(x - f.x) < f.rx * 1.05 && Math.abs(z - f.z) < f.rz * 1.05) { ok = false; break; }
    if (!ok) continue;
    if (Math.hypot(x - LAKE.x, (z - LAKE.z) * 1.3) < LAKE.r * 1.05) continue;
    if (Math.abs(z) < 9 && Math.abs(x) < 320) continue;
    const h = heightAt(x, z);
    if (h < WATER_Y + 0.5 || h > 60) continue;
    placed.push({ x, z, s: 0.8 + rnd() * 0.7, type: rnd() < 0.6 ? 0 : 1, r: rnd() * Math.PI * 2 });
  }
  const types = [conifer, leafy];
  for (let t = 0; t < 2; t++) {
    const list = placed.filter(p => p.type === t);
    const im = new THREE.InstancedMesh(types[t], mat, list.length);
    const m = new THREE.Matrix4();
    list.forEach((p, i) => {
      const y = heightAt(p.x, p.z) - 0.2;
      m.compose(new THREE.Vector3(p.x, y, p.z), new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), p.r), new THREE.Vector3(p.s, p.s * (0.9 + (i % 7) * 0.05), p.s));
      im.setMatrixAt(i, m);
      cw.add({ kind: 'cyl', radius: 0.3 * p.s, halfH: 2.5 * p.s }, new THREE.Vector3(p.x, y + 2.5 * p.s, p.z), undefined, { surface: 'soft', tag: 'tree' });
      cw.add({ kind: 'sphere', radius: (t === 0 ? 1.9 : 2.5) * p.s }, new THREE.Vector3(p.x, y + (t === 0 ? 5.4 : 5.6) * p.s, p.z), undefined, { surface: 'soft', tag: 'tree' });
    });
    im.castShadow = true; im.receiveShadow = true;
    im.userData.temp = 0.38;
    im.computeBoundingSphere();
    g.add(im);
  }
  return { group: g, uTime };
}

// --------------------------------------------------------------- water and clouds
export function buildWater() {
  const geo = new THREE.CircleGeometry(LAKE.r * 1.35, 96);
  geo.rotateX(-Math.PI / 2);
  const normalTex = waterNormals();
  const mat = new THREE.MeshStandardMaterial({ color: '#163f45', roughness: 0.06, metalness: 0.2, normalMap: normalTex, normalScale: new THREE.Vector2(0.35, 0.35), transparent: true, opacity: 0.93, envMapIntensity: 1.2 });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.position.set(LAKE.x, WATER_Y, LAKE.z);
  mesh.scale.z = 1 / 1.3;
  mesh.receiveShadow = true;
  mesh.userData.temp = 0.25;
  return {
    mesh, update(t: number) { normalTex.offset.set(t * 0.012, t * 0.007); },
  };
}

function waterNormals() {
  const s = 256; const d = new Uint8Array(s * s * 4);
  const hgt = (x: number, y: number) => {
    const a = x / s * Math.PI * 2, b = y / s * Math.PI * 2;
    return fbm(Math.cos(a) * 2 + Math.cos(b) * 1.3 + 5, Math.sin(a) * 2 + Math.sin(b) * 1.3, 4);
  };
  for (let y = 0; y < s; y++) for (let x = 0; x < s; x++) {
    const dx = hgt(x + 1, y) - hgt(x - 1, y), dy = hgt(x, y + 1) - hgt(x, y - 1);
    const n = new THREE.Vector3(-dx * 8, -dy * 8, 1).normalize();
    const i = (y * s + x) * 4;
    d[i] = (n.x * 0.5 + 0.5) * 255; d[i + 1] = (n.y * 0.5 + 0.5) * 255; d[i + 2] = (n.z * 0.5 + 0.5) * 255; d[i + 3] = 255;
  }
  const t = new THREE.DataTexture(d, s, s, THREE.RGBAFormat);
  t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(18, 18);
  t.generateMipmaps = true; t.minFilter = THREE.LinearMipmapLinearFilter; t.magFilter = THREE.LinearFilter;
  t.needsUpdate = true;
  return t;
}

export function buildClouds() {
  const mat = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, side: THREE.DoubleSide, fog: false,
    uniforms: { uTime: { value: 0 }, uSun: { value: new THREE.Vector3(0, 1, 0) }, uCover: { value: 0.5 } },
    vertexShader: `varying vec3 vW; void main(){ vec4 w = modelMatrix * vec4(position,1.); vW = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }`,
    fragmentShader: `
      uniform float uTime; uniform vec3 uSun; uniform float uCover; varying vec3 vW;
      float h(vec2 p){ return fract(sin(dot(p, vec2(127.1,311.7)))*43758.5453); }
      float n(vec2 p){ vec2 i=floor(p), f=fract(p); vec2 u=f*f*(3.-2.*f);
        return mix(mix(h(i),h(i+vec2(1,0)),u.x), mix(h(i+vec2(0,1)),h(i+vec2(1,1)),u.x), u.y); }
      float fbm(vec2 p){ float s=0., a=.5; for(int i=0;i<6;i++){ s+=a*n(p); p*=2.03; a*=.5; } return s; }
      void main(){
        vec2 p = vW.xz * 0.0016 + vec2(uTime * 0.004, uTime * 0.0015);
        float d = fbm(p) ; float d2 = fbm(p * 2.3 + 4.);
        float c = smoothstep(1. - uCover, 1. - uCover + 0.35, d * 0.75 + d2 * 0.35);
        float r = length(vW.xz) / 4200.; float fade = 1. - smoothstep(0.55, 1.0, r);
        float lit = 0.82 + 0.18 * smoothstep(0.0, 0.6, d2);
        vec3 col = mix(vec3(0.78,0.80,0.84), vec3(1.0, 0.99, 0.96), lit);
        gl_FragColor = vec4(col, c * fade * 0.92);
      }`,
  });
  const m = new THREE.Mesh(new THREE.PlaneGeometry(9000, 9000), mat);
  m.rotation.x = Math.PI / 2;
  m.position.y = 520;
  m.renderOrder = -1;
  m.userData.noThermal = true;
  return { mesh: m, mat };
}
