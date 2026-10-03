import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { DroneSpec, motorLayout } from '../sim/spec';
import { buildDSolarMT50, buildDSolarMT100 } from './dsolarModels';

// Procedural models, built to the proportions of the real aircraft. Body frame
// matches the sim: x right, y up, forward is -z. Props are separate so they can
// spin and blur with real motor speed.

export interface DroneVisual {
  root: THREE.Group;
  props: { pivot: THREE.Object3D; blades: THREE.Object3D; disc: THREE.Mesh; dir: number }[];
  nozzles: { pos: THREE.Vector3; dir: THREE.Vector3 }[];  // body frame
  fpvCam: THREE.Vector3;
  gimbal?: THREE.Object3D;
  lance?: THREE.Object3D;
  leds: THREE.Mesh[];
}

export const mats = {
  carbon: () => new THREE.MeshStandardMaterial({ color: '#1c1e1d', roughness: 0.38, metalness: 0.35 }),
  black: () => new THREE.MeshStandardMaterial({ color: '#121212', roughness: 0.6, metalness: 0.2 }),
  motor: () => new THREE.MeshStandardMaterial({ color: '#191919', roughness: 0.3, metalness: 0.85 }),
  foam: () => new THREE.MeshStandardMaterial({ color: '#141414', roughness: 0.95 }),
  white: () => new THREE.MeshStandardMaterial({ color: '#f1f1ec', roughness: 0.35, metalness: 0.05 }),
  plastic: (c: string, rough = 0.45) => new THREE.MeshStandardMaterial({ color: c, roughness: rough, metalness: 0.1 }),
  printed: (c: string) => new THREE.MeshStandardMaterial({ color: c, roughness: 0.62, metalness: 0.0, flatShading: true }),
  glass: () => new THREE.MeshStandardMaterial({ color: '#0a1116', roughness: 0.05, metalness: 0.9 }),
};

export function cyl(r1: number, r2: number, h: number, m: THREE.Material, seg = 12) { return new THREE.Mesh(new THREE.CylinderGeometry(r1, r2, h, seg), m); }
export function bx(w: number, h: number, d: number, m: THREE.Material) { return new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m); }

/** tube from a to b */
export function tube(a: THREE.Vector3, b: THREE.Vector3, r: number, m: THREE.Material, seg = 10) {
  const len = a.distanceTo(b);
  const mesh = cyl(r, r, len, m, seg);
  mesh.position.copy(a).add(b).multiplyScalar(0.5);
  mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), b.clone().sub(a).normalize());
  return mesh;
}

function propGeometry(D: number, blades: number, chord = 0.09) {
  const geos: THREE.BufferGeometry[] = [];
  for (let i = 0; i < blades; i++) {
    const shape = new THREE.Shape();
    const R = D / 2, c = D * chord;
    shape.moveTo(0, -c * 0.3);
    shape.bezierCurveTo(R * 0.3, -c * 0.9, R * 0.75, -c * 0.6, R, -c * 0.12);
    shape.lineTo(R, c * 0.1);
    shape.bezierCurveTo(R * 0.7, c * 0.45, R * 0.3, c * 0.6, 0, c * 0.3);
    const g = new THREE.ExtrudeGeometry(shape, { depth: Math.max(0.002, D * 0.008), bevelEnabled: false });
    g.rotateX(-Math.PI / 2);
    // pitch twist
    const p = g.attributes.position as THREE.BufferAttribute;
    for (let k = 0; k < p.count; k++) {
      const x = p.getX(k), z = p.getZ(k);
      p.setY(k, p.getY(k) + z * 0.25 * (1 - x / R));
    }
    g.rotateY(i * Math.PI * 2 / blades);
    geos.push(g);
  }
  const merged = geos.length > 1 ? mergeSimple(geos) : geos[0];
  merged.computeVertexNormals();
  return merged;
}

function mergeSimple(geos: THREE.BufferGeometry[]) {
  const nonIdx = geos.map(g => g.index ? g.toNonIndexed() : g);
  let n = 0; for (const g of nonIdx) n += g.attributes.position.count;
  const pos = new Float32Array(n * 3); let o = 0;
  for (const g of nonIdx) { pos.set(g.attributes.position.array as Float32Array, o); o += g.attributes.position.count * 3; }
  const out = new THREE.BufferGeometry(); out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  return out;
}

export function addProps(v: DroneVisual, spec: DroneSpec, hubH: number, bladeCount: number, bladeColor = '#141414', motorR?: number) {
  const D = spec.propDiameter;
  const geo = propGeometry(D, bladeCount);
  const bmat = new THREE.MeshStandardMaterial({ color: bladeColor, roughness: 0.4, metalness: 0.1, side: THREE.DoubleSide });
  const discMat = new THREE.MeshBasicMaterial({ color: '#202422', transparent: true, opacity: 0, depthWrite: false, side: THREE.DoubleSide });
  const discGeo = new THREE.RingGeometry(D * 0.08, D / 2, 48);
  discGeo.rotateX(-Math.PI / 2);
  for (const m of motorLayout(spec)) {
    const pivot = new THREE.Group();
    pivot.position.set(m.x, m.y + hubH * (m.y < 0 ? -1 : 1), m.z);
    const blades = new THREE.Mesh(geo, bmat);
    if (m.dir < 0) blades.scale.x = -1;
    const disc = new THREE.Mesh(discGeo, discMat.clone());
    disc.userData.noThermal = true;
    pivot.add(blades, disc);
    blades.castShadow = true;
    if (motorR) {
      const motor = cyl(motorR, motorR, hubH * 1.6, mats.motor(), 18);
      motor.position.set(m.x, m.y + (m.y < 0 ? -hubH * 0.3 : hubH * 0.2), m.z);
      motor.castShadow = true;
      v.root.add(motor);
      const bell = cyl(motorR * 0.25, motorR * 0.25, hubH * 0.6, mats.white());
      bell.position.copy(pivot.position);
      v.root.add(bell);
    }
    v.root.add(pivot);
    v.props.push({ pivot, blades, disc, dir: m.dir });
  }
}

export function ledPair(v: DroneVisual, spec: DroneSpec) {
  // nav lights on the motor arms: front green, rear red, like real aircraft
  for (const m of motorLayout(spec)) {
    if (m.y < 0) continue;
    const c = m.z < 0 ? '#3cff7a' : '#ff3030';
    const led = new THREE.Mesh(new THREE.SphereGeometry(Math.max(0.006, spec.armLength * 0.025), 8, 6), new THREE.MeshBasicMaterial({ color: c }));
    led.position.set(m.x * 0.98, -spec.armLength * 0.05, m.z * 0.98);
    v.root.add(led); v.leds.push(led);
  }
}

// --------------------------------------------------------------------- DScan (own prototype)
function buildDScan(spec: DroneSpec): DroneVisual {
  const v: DroneVisual = { root: new THREE.Group(), props: [], nozzles: [], fpvCam: new THREE.Vector3(0, -0.12, -0.18), leds: [] };
  const L = spec.armLength;
  const green = mats.printed('#1f7a45');
  const carbon = mats.carbon();
  // plate stack with green corner blocks
  for (const y of [0.0, -0.045]) {
    const plate = new THREE.Mesh(new THREE.CylinderGeometry(0.125, 0.125, 0.004, 8), carbon);
    plate.rotation.y = Math.PI / 8; plate.position.y = y; v.root.add(plate);
  }
  for (let i = 0; i < 4; i++) {
    const a = Math.PI / 4 + i * Math.PI / 2;
    const clamp = bx(0.06, 0.05, 0.05, green);
    clamp.position.set(Math.cos(a) * 0.11, -0.022, Math.sin(a) * 0.11);
    clamp.rotation.y = -a; v.root.add(clamp);
  }
  // electronics peeking out between plates
  const esc = bx(0.12, 0.03, 0.08, mats.plastic('#b33a2a', 0.6)); esc.position.y = -0.022; v.root.add(esc);
  // faceted half dome, irregular like a low poly print
  const domeGeo = new THREE.SphereGeometry(0.135, 13, 7, 0, Math.PI * 2, 0, Math.PI / 2);
  const dp = domeGeo.attributes.position as THREE.BufferAttribute;
  for (let i = 0; i < dp.count; i++) {
    const x = dp.getX(i), y = dp.getY(i), z = dp.getZ(i);
    const k = 1 + (Math.sin(x * 91 + z * 37) * 0.5 + Math.cos(z * 73 - y * 51) * 0.5) * 0.035 * (y > 0.01 ? 1 : 0);
    dp.setXYZ(i, x * k, y * k * 1.05, z * k);
  }
  domeGeo.computeVertexNormals();
  const dome = new THREE.Mesh(domeGeo, green);
  dome.position.y = 0.012;
  v.root.add(dome);
  const rim = new THREE.Mesh(new THREE.CylinderGeometry(0.142, 0.142, 0.02, 8), green);
  rim.rotation.y = Math.PI / 8; rim.position.y = 0.012; v.root.add(rim);
  // curved GPS neck and puck
  const curve = new THREE.QuadraticBezierCurve3(new THREE.Vector3(0, 0.12, 0.03), new THREE.Vector3(0, 0.19, 0.045), new THREE.Vector3(0, 0.215, -0.01));
  const neck = new THREE.Mesh(new THREE.TubeGeometry(curve, 10, 0.016, 8), green);
  v.root.add(neck);
  const puck = cyl(0.045, 0.045, 0.018, mats.black(), 20); puck.position.set(0, 0.225, -0.01); v.root.add(puck);
  const puckTop = cyl(0.042, 0.042, 0.002, mats.plastic('#2a2a2a', 0.3), 20); puckTop.position.set(0, 0.235, -0.01); v.root.add(puckTop);
  // arms: carbon tubes with green motor pods
  for (const m of motorLayout(spec)) {
    const dir = new THREE.Vector3(m.x, 0, m.z).normalize();
    v.root.add(tube(dir.clone().multiplyScalar(0.11).setY(-0.022), new THREE.Vector3(m.x, -0.022, m.z).addScaledVector(dir, -0.05), 0.011, carbon));
    const pod = bx(0.07, 0.03, 0.05, green);
    pod.position.set(m.x, -0.025, m.z).addScaledVector(dir, -0.045);
    pod.rotation.y = -Math.atan2(dir.z, dir.x);
    v.root.add(pod);
    const base = cyl(0.03, 0.03, 0.012, green, 14); base.position.set(m.x, -0.03, m.z); v.root.add(base);
  }
  addProps(v, spec, 0.028, 2, '#151515', 0.0175);
  // legs: carbon, splayed, with foam skids
  const legH = 0.3;
  for (const s of [-1, 1]) {
    const top1 = new THREE.Vector3(s * 0.07, -0.05, -0.08), top2 = new THREE.Vector3(s * 0.07, -0.05, 0.08);
    const foot1 = new THREE.Vector3(s * 0.15, -legH + 0.012, -0.1), foot2 = new THREE.Vector3(s * 0.15, -legH + 0.012, 0.1);
    v.root.add(tube(top1, foot1, 0.008, carbon), tube(top2, foot2, 0.008, carbon));
    const skid = cyl(0.013, 0.013, 0.34, mats.foam(), 10);
    skid.rotation.x = Math.PI / 2; skid.position.set(s * 0.15, -legH + 0.013, 0);
    v.root.add(skid);
    // rib texture on the foam
    for (let k = -4; k <= 4; k++) {
      const r = cyl(0.0145, 0.0145, 0.006, mats.foam(), 10); r.rotation.x = Math.PI / 2; r.position.set(s * 0.15, -legH + 0.013, k * 0.035); v.root.add(r);
    }
  }
  // payload rails and thermal gimbal under the nose
  for (const s of [-1, 1]) {
    const rail = cyl(0.007, 0.007, 0.32, carbon); rail.rotation.x = Math.PI / 2; rail.position.set(s * 0.035, -0.085, -0.04); v.root.add(rail);
    for (const z of [-0.14, 0.04]) { const c = cyl(0.014, 0.014, 0.02, mats.black()); c.rotation.x = Math.PI / 2; c.position.set(s * 0.035, -0.085, z); v.root.add(c); }
  }
  const mount = bx(0.09, 0.004, 0.08, carbon); mount.position.set(0, -0.095, -0.15); v.root.add(mount);
  const gimbal = new THREE.Group();
  gimbal.position.set(0, -0.12, -0.16);
  const yoke = bx(0.07, 0.04, 0.012, mats.black()); yoke.position.y = 0.0; gimbal.add(yoke);
  const camBody = bx(0.06, 0.05, 0.055, mats.plastic('#222', 0.4)); camBody.position.y = -0.03; gimbal.add(camBody);
  const lens1 = cyl(0.012, 0.012, 0.01, mats.glass(), 16); lens1.rotation.x = Math.PI / 2; lens1.position.set(-0.014, -0.03, -0.03); gimbal.add(lens1);
  const lens2 = cyl(0.009, 0.009, 0.01, mats.glass(), 16); lens2.rotation.x = Math.PI / 2; lens2.position.set(0.016, -0.03, -0.03); gimbal.add(lens2);
  v.root.add(gimbal); v.gimbal = gimbal;
  v.fpvCam.set(0, -0.15, -0.2);
  ledPair(v, spec);
  return v;
}

// --------------------------------------------------------------------- DShine
function buildDShine(spec: DroneSpec): DroneVisual {
  const v: DroneVisual = { root: new THREE.Group(), props: [], nozzles: [], fpvCam: new THREE.Vector3(0, 0.05, -0.32), leds: [] };
  const green = mats.plastic('#0f4a2b', 0.35);
  const carbon = mats.carbon();
  const top = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.27, 0.16, 6), green);
  top.rotation.y = Math.PI / 6; top.position.y = 0.16; v.root.add(top);
  const topCap = new THREE.Mesh(new THREE.CylinderGeometry(0.13, 0.2, 0.05, 6), green); topCap.rotation.y = Math.PI / 6; topCap.position.y = 0.265; v.root.add(topCap);
  const body = bx(0.42, 0.22, 0.42, carbon); body.position.y = -0.02; v.root.add(body);
  const label = wordmarkMesh(0.3, 0.035); label.position.set(0, 0.05, -0.212); v.root.add(label);
  const pump = bx(0.18, 0.14, 0.2, green); pump.position.set(0, -0.26, 0.02); v.root.add(pump);
  for (const m of motorLayout(spec)) {
    const dir = new THREE.Vector3(m.x, 0, m.z).normalize();
    v.root.add(tube(dir.clone().multiplyScalar(0.2).setY(0.02), new THREE.Vector3(m.x, 0.02, m.z), 0.022, carbon));
  }
  addProps(v, spec, 0.06, 2, '#121212', 0.055);
  const legH = spec.armLength * 0.6;
  for (const s of [-1, 1]) {
    v.root.add(tube(new THREE.Vector3(s * 0.15, -0.12, -0.15), new THREE.Vector3(s * 0.26, -legH + 0.03, -0.22), 0.014, mats.black()));
    v.root.add(tube(new THREE.Vector3(s * 0.15, -0.12, 0.15), new THREE.Vector3(s * 0.26, -legH + 0.03, 0.22), 0.014, mats.black()));
    const skid = cyl(0.028, 0.028, 0.56, green, 12); skid.rotation.x = Math.PI / 2; skid.position.set(s * 0.26, -legH + 0.028, 0); v.root.add(skid);
  }
  // telescopic lance pointing forward and slightly down, tilts with the gimbal input
  const lance = new THREE.Group();
  lance.position.set(0, -0.2, -0.12);
  const l1 = cyl(0.018, 0.018, 0.9, mats.white()); l1.rotation.x = Math.PI / 2; l1.position.z = -0.45; lance.add(l1);
  const l2 = cyl(0.012, 0.012, 0.7, mats.motor()); l2.rotation.x = Math.PI / 2; l2.position.z = -1.15; lance.add(l2);
  const tip = cyl(0.02, 0.012, 0.06, mats.plastic('#c43c1c')); tip.rotation.x = Math.PI / 2; tip.position.z = -1.52; lance.add(tip);
  v.root.add(lance); v.lance = lance;
  v.nozzles.push({ pos: new THREE.Vector3(0, -0.2, -1.65), dir: new THREE.Vector3(0, 0, -1) });
  ledPair(v, spec);
  return v;
}

// --------------------------------------------------------------------- 5 inch freestyle
function buildRacer(spec: DroneSpec): DroneVisual {
  const v: DroneVisual = { root: new THREE.Group(), props: [], nozzles: [], fpvCam: new THREE.Vector3(0, 0.025, -0.045), leds: [] };
  const carbon = mats.carbon();
  const tpu = mats.plastic(spec.color, 0.55);
  for (const m of motorLayout(spec)) {
    const arm = bx(0.022, 0.005, spec.armLength * 1.05, carbon);
    arm.position.set(m.x / 2, 0, m.z / 2); arm.rotation.y = Math.atan2(m.x, m.z);
    v.root.add(arm);
  }
  const bottom = bx(0.04, 0.004, 0.11, carbon); v.root.add(bottom);
  const topP = bx(0.036, 0.003, 0.09, carbon); topP.position.y = 0.032; v.root.add(topP);
  for (const [x, z] of [[-0.016, -0.04], [0.016, -0.04], [-0.016, 0.04], [0.016, 0.04]]) { const s = cyl(0.0025, 0.0025, 0.03, mats.motor()); s.position.set(x, 0.017, z); v.root.add(s); }
  const stack = bx(0.03, 0.012, 0.03, mats.plastic('#2a4', 0.5)); stack.position.y = 0.012; v.root.add(stack);
  const cam = bx(0.02, 0.02, 0.02, mats.black()); cam.position.set(0, 0.016, -0.05); cam.rotation.x = -spec.camUptilt * Math.PI / 180; v.root.add(cam);
  const lens = cyl(0.006, 0.006, 0.008, mats.glass(), 12); lens.rotation.x = Math.PI / 2 - spec.camUptilt * Math.PI / 180; lens.position.set(0, 0.018, -0.062); v.root.add(lens);
  const gopro = bx(0.04, 0.03, 0.022, mats.black()); gopro.position.set(0, 0.05, -0.02); v.root.add(gopro);
  const mount = bx(0.04, 0.012, 0.03, tpu); mount.position.set(0, 0.04, -0.02); v.root.add(mount);
  const ant = cyl(0.002, 0.002, 0.05, tpu); ant.position.set(0, 0.03, 0.065); ant.rotation.x = -0.6; v.root.add(ant);
  const batt = bx(0.035, 0.03, 0.075, mats.plastic('#222', 0.4)); batt.position.y = 0.05; batt.position.z = 0.012; v.root.add(batt);
  const strap = bx(0.037, 0.032, 0.012, mats.plastic('#d33', 0.6)); strap.position.set(0, 0.05, 0.012); v.root.add(strap);
  addProps(v, spec, 0.012, 3, spec.color, 0.0115);
  v.fpvCam.set(0, 0.018, -0.06);
  return v;
}

// --------------------------------------------------------------------- Cine X8
function buildCine(spec: DroneSpec): DroneVisual {
  const v: DroneVisual = { root: new THREE.Group(), props: [], nozzles: [], fpvCam: new THREE.Vector3(0, -0.2, -0.22), leds: [] };
  const carbon = mats.carbon();
  const plate = new THREE.Mesh(new THREE.CylinderGeometry(0.17, 0.17, 0.012, 8), carbon); v.root.add(plate);
  const hood = new THREE.Mesh(new THREE.SphereGeometry(0.15, 16, 8, 0, Math.PI * 2, 0, Math.PI / 2), mats.plastic('#2a2f2c', 0.3)); hood.scale.y = 0.6; v.root.add(hood);
  const stripe = bx(0.31, 0.01, 0.04, mats.plastic('#b5f78a', 0.4)); stripe.position.y = 0.07; v.root.add(stripe);
  for (const m of motorLayout(spec)) {
    if (m.y < 0) continue;
    const dir = new THREE.Vector3(m.x, 0, m.z).normalize();
    v.root.add(tube(dir.clone().multiplyScalar(0.15), new THREE.Vector3(m.x, 0, m.z), 0.018, carbon));
    const mm = cyl(0.03, 0.03, 0.16, mats.black(), 12); mm.position.set(m.x, 0, m.z); v.root.add(mm);
  }
  addProps(v, spec, 0.05, 2, '#111', 0.03);
  for (const s of [-1, 1]) {
    v.root.add(tube(new THREE.Vector3(s * 0.1, -0.02, 0), new THREE.Vector3(s * 0.22, -0.32, 0), 0.012, carbon));
    const skid = cyl(0.014, 0.014, 0.44, mats.black()); skid.rotation.x = Math.PI / 2; skid.position.set(s * 0.22, -0.32, 0); v.root.add(skid);
  }
  const gimbal = new THREE.Group(); gimbal.position.set(0, -0.12, -0.08);
  const cam = bx(0.14, 0.09, 0.12, mats.black()); gimbal.add(cam);
  const lens = cyl(0.04, 0.04, 0.12, mats.glass(), 20); lens.rotation.x = Math.PI / 2; lens.position.z = -0.1; gimbal.add(lens);
  v.root.add(gimbal); v.gimbal = gimbal;
  ledPair(v, spec);
  return v;
}

// --------------------------------------------------------------------- generic community drone
function buildGeneric(spec: DroneSpec): DroneVisual {
  const v: DroneVisual = { root: new THREE.Group(), props: [], nozzles: [], fpvCam: new THREE.Vector3(0, 0, -spec.armLength * 0.4), leds: [] };
  const L = spec.armLength;
  const body = mats.plastic(spec.color, 0.4), acc = mats.plastic(spec.accent, 0.5);
  const core = new THREE.Mesh(new THREE.CylinderGeometry(L * 0.35, L * 0.4, L * 0.25, 8), body); core.rotation.y = Math.PI / 8; v.root.add(core);
  const dome = new THREE.Mesh(new THREE.SphereGeometry(L * 0.28, 16, 8, 0, Math.PI * 2, 0, Math.PI / 2), acc); dome.position.y = L * 0.12; v.root.add(dome);
  for (const m of motorLayout(spec)) {
    if (m.y < 0) continue;
    const dir = new THREE.Vector3(m.x, 0, m.z).normalize();
    v.root.add(tube(dir.clone().multiplyScalar(L * 0.3), new THREE.Vector3(m.x, 0, m.z), Math.max(0.006, L * 0.05), mats.carbon()));
  }
  addProps(v, spec, Math.max(0.01, L * 0.08), 2, '#151515', Math.max(0.008, spec.propDiameter * 0.09));
  const legH = spec.armLength * 0.6;
  for (const s of [-1, 1]) {
    v.root.add(tube(new THREE.Vector3(s * L * 0.2, -L * 0.1, 0), new THREE.Vector3(s * L * 0.45, -legH + 0.01, 0), Math.max(0.004, L * 0.025), mats.black()));
    const skid = cyl(Math.max(0.005, L * 0.03), Math.max(0.005, L * 0.03), L * 0.9, acc); skid.rotation.x = Math.PI / 2; skid.position.set(s * L * 0.45, -legH + 0.01, 0); v.root.add(skid);
  }
  ledPair(v, spec);
  return v;
}

export function sparkleMesh(size: number, color: string) {
  const shape = new THREE.Shape();
  const r = size / 2, w = size * 0.09;
  shape.moveTo(0, r);
  shape.quadraticCurveTo(w, w, r, 0);
  shape.quadraticCurveTo(w, -w, 0, -r);
  shape.quadraticCurveTo(-w, -w, -r, 0);
  shape.quadraticCurveTo(-w, w, 0, r);
  const m = new THREE.Mesh(new THREE.ShapeGeometry(shape), new THREE.MeshBasicMaterial({ color, side: THREE.DoubleSide }));
  m.rotation.y = Math.PI;
  return m;
}

function wordmarkMesh(w: number, h: number) {
  const c = document.createElement('canvas'); c.width = 512; c.height = 64;
  const g = c.getContext('2d')!;
  g.fillStyle = '#f7f7f2';
  g.font = '400 44px Nasalization, Audiowide, Inter, sans-serif';
  g.textAlign = 'center'; g.textBaseline = 'middle';
  g.fillText('DRONESHINE', 256, 34);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace;
  const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ map: t, transparent: true }));
  m.rotation.y = Math.PI;
  return m;
}

const gltf = new GLTFLoader();

// parsed uploads, keyed by the whole data URL (the engine hashes a string once), so two models of the
// same size never mix up and slider tweaks in the editor never re-parse a 20 MB model
const glbCache = new Map<string, Promise<THREE.Group>>();

/** free a cached model that fell out of the cache */
function disposeCached(p: Promise<THREE.Group>) {
  p.then(scene => scene.traverse(o => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    m.geometry?.dispose();
    for (const mat of Array.isArray(m.material) ? m.material : [m.material]) {
      if (!mat) continue;
      for (const val of Object.values(mat)) if (val && (val as THREE.Texture).isTexture) (val as THREE.Texture).dispose();
      mat.dispose();
    }
  })).catch(() => { /* never parsed */ });
}

function dataUrlBytes(url: string): ArrayBuffer {
  const b64 = url.slice(url.indexOf(',') + 1);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out.buffer;
}

/** Parse a binary glTF from a data URL. Rejects anything that is not a real GLB. */
export function parseGlb(url: string): Promise<THREE.Group> {
  const key = url;
  let p = glbCache.get(key);
  if (!p) {
    p = (async () => {
      if (!url.startsWith('data:')) throw new Error('Only embedded models are supported');
      const buf = dataUrlBytes(url);
      const head = new Uint8Array(buf, 0, Math.min(4, buf.byteLength));
      if (head.length < 4 || head[0] !== 0x67 || head[1] !== 0x6c || head[2] !== 0x54 || head[3] !== 0x46) throw new Error('Not a binary glTF (.glb) file');
      const res = await gltf.parseAsync(buf, '');
      let meshes = 0;
      res.scene.traverse(o => { if ((o as THREE.Mesh).isMesh) meshes++; });
      if (!meshes) throw new Error('The file contains no meshes');
      return res.scene;
    })();
    glbCache.set(key, p);
    p.catch(() => glbCache.delete(key));
    while (glbCache.size > 4) {
      const oldest = glbCache.keys().next().value!;
      disposeCached(glbCache.get(oldest)!);
      glbCache.delete(oldest);
    }
  }
  return p;
}

/** Free GPU memory of a drone that left the scene. Shared, cached upload meshes are kept. */
export function disposeVisual(v: DroneVisual | null | undefined) {
  if (!v) return;
  v.root.traverse(o => {
    const m = o as THREE.Mesh;
    if (!m.isMesh || m.userData.sharedGlb) return;
    m.geometry?.dispose();
    const mats = Array.isArray(m.material) ? m.material : [m.material];
    for (const mat of mats) {
      if (!mat) continue;
      for (const val of Object.values(mat)) if (val && (val as THREE.Texture).isTexture) (val as THREE.Texture).dispose();
      mat.dispose();
    }
  });
}

export async function buildDroneVisual(spec: DroneSpec): Promise<DroneVisual> {
  let v: DroneVisual;
  switch (spec.model) {
    case 'dscan': v = buildDScan(spec); break;
    case 'dsolar': v = buildDSolarMT50(spec); break;
    case 'dsolarmax': v = buildDSolarMT100(spec); break;
    case 'dshine': v = buildDShine(spec); break;
    case 'racer': v = buildRacer(spec); break;
    case 'cine': v = buildCine(spec); break;
    default: v = buildGeneric(spec);
  }
  if (spec.glb) {
    try {
      const source = await parseGlb(spec.glb);
      const model = source.clone(true);
      model.traverse(o => { if ((o as THREE.Mesh).isMesh) o.userData.sharedGlb = true; });
      // auto fit to the motor span, the scale setting multiplies on top of that
      const box = new THREE.Box3().setFromObject(source);
      const size = box.getSize(new THREE.Vector3());
      const span = Math.max(size.x, size.z) || 1;
      const s = (spec.armLength * 2 + spec.propDiameter) / span * (spec.glbScale ?? 1);
      model.scale.setScalar(s);
      const c = box.getCenter(new THREE.Vector3()).multiplyScalar(s);
      model.position.set(-c.x, -c.y, -c.z);
      // rotate around the model centre, not around wherever its file origin happens to be
      const pivot = new THREE.Group();
      pivot.position.y = spec.glbOffsetY ?? 0;
      pivot.rotation.y = THREE.MathUtils.degToRad(spec.glbYaw ?? 0);
      pivot.add(model);
      // replace the procedural body, keep spinning props so it still reads as alive
      const keep = new Set(v.props.map(p => p.pivot));
      const removed = new THREE.Group();
      for (const child of [...v.root.children]) if (!keep.has(child)) { v.root.remove(child); removed.add(child); }
      disposeVisual({ ...v, root: removed });
      v.root.add(pivot);
    } catch (e) {
      console.warn('GLB failed, using procedural body', e);
    }
  }
  v.root.traverse(o => { const m = o as THREE.Mesh; if (m.isMesh) { m.castShadow = !(m.material as THREE.Material).transparent; } });
  v.root.userData.temp = 0.8;
  return v;
}

/** spin props and fade the blur disc with motor speed */
export function animateProps(v: DroneVisual, motorS: number[], dt: number, maxRpm: number) {
  v.props.forEach((p, i) => {
    const s = motorS[i] ?? 0;
    const rps = s * maxRpm / 60;
    // cap visual rate to avoid wagon wheel, then hide blades into the disc
    p.blades.rotation.y += p.dir * Math.min(rps, 9) * Math.PI * 2 * dt;
    const blur = THREE.MathUtils.smoothstep(s, 0.12, 0.45);
    (p.disc.material as THREE.MeshBasicMaterial).opacity = blur * 0.32;
    p.blades.visible = blur < 0.85;
  });
}
