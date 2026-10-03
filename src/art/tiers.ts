import * as THREE from 'three';
import { DroneSpec, motorLayout } from '../sim/spec';
import { TIER_LEG } from '../sim/drone';
import type { DroneVisual } from '../render/droneModels';
import { BRAND, PartSet, Finish, place, rod, tierBodyMaterial, hideWhenClear, luminance, hdr } from './kit';

// The four Royale tiers, built to GDD 6.1 so physics and visuals agree:
//
//            layout   arm m   prop m   legHeight m   span tip to tip   paint / accent
//   SPARK    quadX    0.16    0.18     0.06          0.50              #26C257 / #F7F7F2
//   BOLT     quadX    0.24    0.254    0.12          0.73              #8FC2F5 / #002518
//   STORM    hexX     0.34    0.30     0.18          0.98              #004225 / #B5F78A
//   NOVA     coaxX8   0.40    0.33     0.22          1.13              #F7F7F2 / #26C257
//
// Origin is the arm plane centre, forward is minus z, the ground is at minus legHeight.
// Silhouette signatures (ART.md 2): SPARK a flat X with a top pack and a whip antenna,
// BOLT a belly tank with a forward lance, STORM a hexacopter wearing a glowing halo coil,
// NOVA a stacked X8 carrying a glowing core orb on tall gear.
//
// Draw calls per drone: frame (paint, carbon, tank, gear) + hot parts (motors, pack) +
// lights (nav LEDs, coil, core) + one merged blur disc for all rotors. Blades are separate
// meshes so they can spin; they hide themselves once the rotor blurs (animateProps).

type V3 = THREE.Vector3;
const v3 = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);

const CARBON: Finish = { color: BRAND.carbon, rough: 0.38, metal: 0.35 };
const METAL: Finish = { color: BRAND.metal, rough: 0.3, metal: 0.85 };
const BRASS: Finish = { color: BRAND.brass, rough: 0.35, metal: 0.8 };
const GLASS: Finish = { color: BRAND.glass, rough: 0.06, metal: 0.9 };
const TANK: Finish = { color: BRAND.tank, rough: 0.55, metal: 0.0 };
const RUBBER: Finish = { color: '#151716', rough: 0.9, metal: 0.0 };
const PACK: Finish = { color: '#2a2e2c', rough: 0.5, metal: 0.1 };

const paintOf = (c: string): Finish => ({ color: c, rough: 0.42, metal: 0.12 });
const accentOf = (c: string): Finish => ({ color: c, rough: 0.5, metal: 0.05 });

/** prop tips wear the accent unless it is too dark to read at a distance, then the paint */
export function tipColor(spec: DroneSpec) { return luminance(spec.accent) > 0.25 ? spec.accent : spec.color; }

interface Kit { v: DroneVisual; frame: PartSet; hot: PartSet; glow: PartSet; spec: DroneSpec; }

function start(spec: DroneSpec, fpv: V3): Kit {
  return {
    v: { root: new THREE.Group(), props: [], nozzles: [], fpvCam: fpv, leds: [] },
    frame: new PartSet(), hot: new PartSet(), glow: new PartSet(), spec,
  };
}

/** turn the part sets into meshes: three static draw calls at most */
function finish(k: Kit) {
  const { v } = k;
  const bodyMat = tierBodyMaterial();
  const frame = new THREE.Mesh(k.frame.build(), bodyMat);
  frame.name = 'tier-frame'; frame.userData.temp = 0.7;
  v.root.add(frame);
  if (!k.hot.empty) {
    const hot = new THREE.Mesh(k.hot.build(), bodyMat);
    hot.name = 'tier-hot'; hot.userData.temp = 0.96;
    v.root.add(hot);
  }
  if (!k.glow.empty) {
    // emissive lights: transparent so they cast no shadow, HDR vertex colour so they bloom a little
    const lights = new THREE.Mesh(k.glow.build(), new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, depthWrite: true }));
    lights.name = 'tier-lights'; lights.userData.temp = 0.9;
    lights.renderOrder = 1;
    v.root.add(lights);
    v.leds.push(lights);
  }
  v.root.userData.tier = k.spec.model;
  return v;
}

// ------------------------------------------------------------------ props

function bladeGeometry(D: number, blades: number, chord: number, bladeCol: THREE.Color, tipCol: THREE.Color) {
  const geos: THREE.BufferGeometry[] = [];
  const R = D / 2, c = D * chord;
  for (let i = 0; i < blades; i++) {
    const shape = new THREE.Shape();
    shape.moveTo(0, -c * 0.3);
    shape.bezierCurveTo(R * 0.3, -c * 0.9, R * 0.75, -c * 0.6, R, -c * 0.12);
    shape.lineTo(R, c * 0.1);
    shape.bezierCurveTo(R * 0.7, c * 0.45, R * 0.3, c * 0.6, 0, c * 0.3);
    const g = new THREE.ExtrudeGeometry(shape, { depth: Math.max(0.002, D * 0.01), bevelEnabled: false, curveSegments: 6 });
    g.rotateX(-Math.PI / 2);
    const p = g.attributes.position as THREE.BufferAttribute;
    for (let k = 0; k < p.count; k++) {
      const x = p.getX(k), z = p.getZ(k);
      p.setY(k, p.getY(k) + z * 0.25 * (1 - x / R));
    }
    g.rotateY(i * Math.PI * 2 / blades);
    g.deleteAttribute('uv'); g.deleteAttribute('normal');
    geos.push(g.index ? g.toNonIndexed() : g);
  }
  let n = 0; for (const g of geos) n += g.attributes.position.count;
  const pos = new Float32Array(n * 3), col = new Float32Array(n * 3);
  let o = 0;
  for (const g of geos) {
    pos.set(g.attributes.position.array as Float32Array, o * 3);
    for (let k = 0; k < g.attributes.position.count; k++) {
      const x = g.attributes.position.getX(k), z = g.attributes.position.getZ(k);
      const c2 = Math.hypot(x, z) > R * 0.8 ? tipCol : bladeCol;
      col[(o + k) * 3] = c2.r; col[(o + k) * 3 + 1] = c2.g; col[(o + k) * 3 + 2] = c2.b;
    }
    o += g.attributes.position.count;
    g.dispose();
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  out.setAttribute('color', new THREE.BufferAttribute(col, 3));
  out.computeVertexNormals();
  return out;
}

/** flat annulus with RGBA colour stops by radius fraction */
function discGeometry(R: number, stops: [number, THREE.Color, number][], seg = 40) {
  const pos: number[] = [], col: number[] = [], idx: number[] = [];
  for (let s = 0; s < stops.length; s++) {
    const [f, c, a] = stops[s];
    for (let i = 0; i <= seg; i++) {
      const t = i / seg * Math.PI * 2;
      pos.push(Math.cos(t) * R * f, 0, Math.sin(t) * R * f);
      col.push(c.r, c.g, c.b, a);
    }
  }
  for (let s = 0; s < stops.length - 1; s++) for (let i = 0; i < seg; i++) {
    const a = s * (seg + 1) + i, b = a + seg + 1;
    idx.push(a, b, a + 1, b, b + 1, a + 1);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 4));
  g.setIndex(idx);
  return g;
}

/**
 * Spinning props in the DroneVisual format. Every rotor gets its own pivot and blades; the blur
 * discs of all rotors are ONE merged mesh (prop 0's disc), the other props carry an empty stand in
 * that shares the material, so animateProps fades them all with one write and one draw call.
 */
function addTierProps(k: Kit, hubH: number, blades: number) {
  const { v, spec } = k;
  const D = spec.propDiameter, R = D / 2;
  const tip = new THREE.Color(tipColor(spec));
  const bladeGeo = bladeGeometry(D, blades, blades === 3 ? 0.085 : 0.075, new THREE.Color('#161817'), tip);
  const bladeMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.45, metalness: 0.1, side: THREE.DoubleSide });
  const dark = new THREE.Color('#1d201f');
  const tipHi = tip.clone().multiplyScalar(1.35);
  // alpha per stop is multiplied by animateProps' opacity (max 0.32): the tip band ends near 0.8
  const discStops: [number, THREE.Color, number][] = [[0.1, dark, 0.55], [0.72, dark, 1.25], [0.8, tipHi, 2.5], [0.95, tipHi, 2.5], [1.0, tipHi, 0.0]];
  const discMat = hideWhenClear(new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, opacity: 0, depthWrite: false, side: THREE.DoubleSide }));
  const discParts: THREE.BufferGeometry[] = [];
  const layout = motorLayout(spec);
  for (const m of layout) {
    const pivot = new THREE.Group();
    const y = m.y + hubH * (m.y < 0 ? -1 : 1);
    pivot.position.set(m.x, y, m.z);
    const b = new THREE.Mesh(bladeGeo, bladeMat);
    b.userData.temp = 0.5;
    if (m.dir < 0) b.scale.x = -1;
    b.rotation.y = Math.random() * Math.PI;
    pivot.add(b);
    v.root.add(pivot);
    discParts.push(discGeometry(R, discStops).translate(m.x, y, m.z));
    v.props.push({ pivot, blades: b, disc: null as unknown as THREE.Mesh, dir: m.dir });
  }
  // one merged disc for every rotor
  const merged = mergeDiscs(discParts);
  const disc = new THREE.Mesh(merged, discMat);
  disc.userData.noThermal = true;
  disc.name = 'tier-discs';
  disc.renderOrder = 2;
  v.root.add(disc);
  const stand = new THREE.BufferGeometry();
  v.props.forEach((p, i) => {
    if (i === 0) { p.disc = disc; return; }
    const d = new THREE.Mesh(stand, discMat);
    d.visible = false; d.userData.noThermal = true;
    p.pivot.add(d);
    p.disc = d;
  });
}

function mergeDiscs(parts: THREE.BufferGeometry[]) {
  let nv = 0, ni = 0;
  for (const p of parts) { nv += p.attributes.position.count; ni += p.index!.count; }
  const pos = new Float32Array(nv * 3), col = new Float32Array(nv * 4), idx = new Uint32Array(ni);
  let ov = 0, oi = 0;
  for (const p of parts) {
    pos.set(p.attributes.position.array as Float32Array, ov * 3);
    col.set(p.attributes.color.array as Float32Array, ov * 4);
    const src = p.index!.array;
    for (let i = 0; i < src.length; i++) idx[oi + i] = src[i] + ov;
    ov += p.attributes.position.count; oi += src.length;
    p.dispose();
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.BufferAttribute(col, 4));
  g.setIndex(new THREE.BufferAttribute(idx, 1));
  g.computeBoundingSphere();
  return g;
}

// ------------------------------------------------------------------ shared pieces

/** nav lights: Light Green at the front arms, warm red at the rear, read the heading at a glance */
function navLights(k: Kit, y: number, size: number, frac = 0.82) {
  for (const m of motorLayout(k.spec)) {
    if (m.y < 0) continue;
    const front = m.z < -1e-3;
    const g = new THREE.BoxGeometry(size * 1.8, size * 0.7, size);
    place(g, m.x * frac, y, m.z * frac, 0, -Math.atan2(m.z, m.x), 0);
    k.glow.add(g, { color: front ? hdr(BRAND.light, 2.6) : hdr('#ff5040', 2.4) });
  }
}

/** motor: bell can on a mount, with a paint ring that keeps the tier colour visible from below */
function motor(k: Kit, x: number, y: number, z: number, r: number, h: number, ring: Finish, down = false) {
  const s = down ? -1 : 1;
  k.hot.add(place(new THREE.CylinderGeometry(r, r * 0.96, h, 16), x, y + s * h / 2, z), METAL);
  k.hot.add(place(new THREE.CylinderGeometry(r * 0.32, r * 0.32, h * 0.35, 8), x, y + s * (h + h * 0.15), z), { color: '#c9cac4', rough: 0.25, metal: 0.9 });
  k.frame.add(place(new THREE.CylinderGeometry(r * 1.04, r * 1.04, h * 0.22, 16, 1, true), x, y + s * h * 0.62, z), ring);
}

function skid(k: Kit, x: number, y: number, len: number, r: number, f: Finish) {
  k.frame.add(place(new THREE.CapsuleGeometry(r, len, 3, 8), x, y, 0, Math.PI / 2), f);
}

/** water lance: tube from the tank to a brass nozzle; registers the nozzle for the jet VFX */
function lance(k: Kit, from: V3, to: V3, r: number) {
  k.frame.add(rod(from, to, r, 8), METAL);
  const dir = to.clone().sub(from).normalize();
  const tipStart = to.clone(), tipEnd = to.clone().addScaledVector(dir, r * 3.2);
  k.frame.add(rod(tipStart, tipEnd, r * 1.5, 10, r * 0.9), BRASS);
  k.v.nozzles.push({ pos: tipEnd.clone(), dir });
}

// ------------------------------------------------------------------ SPARK

function buildSpark(spec: DroneSpec): DroneVisual {
  const k = start(spec, v3(0, 0.022, -0.09));
  const L = spec.armLength, legH = TIER_LEG.spark;
  const paint = paintOf(spec.color), acc = accentOf(spec.accent);
  // true X arms, flat carbon
  for (const m of motorLayout(spec)) {
    const a = Math.atan2(m.z, m.x);
    k.frame.add(place(new THREE.BoxGeometry(L + 0.03, 0.006, 0.026), Math.cos(a) * (L + 0.02) / 2, 0, Math.sin(a) * (L + 0.02) / 2, 0, -a, 0), CARBON);
    motor(k, m.x, 0.003, m.z, 0.017, 0.02, paint);
    // TPU foot under each arm, where the sim puts the contact points (0.45 L)
    const d = L * 0.45 * Math.SQRT2;
    const fx = Math.cos(a) * d, fz = Math.sin(a) * d;
    k.frame.add(place(new THREE.CylinderGeometry(0.0055, 0.007, legH - 0.012, 8), fx, -0.003 - (legH - 0.012) / 2, fz), paint);
    k.frame.add(place(new THREE.SphereGeometry(0.0072, 8, 6), fx, -legH + 0.0072, fz), RUBBER);
  }
  // plates
  k.frame.add(place(new THREE.BoxGeometry(0.062, 0.004, 0.13), 0, -0.004, 0), CARBON);
  k.frame.add(place(new THREE.BoxGeometry(0.05, 0.003, 0.105), 0, 0.036, 0.004), CARBON);
  // moulded pod around the stack: the paint carries the tier at a glance
  k.frame.add(place(new THREE.CapsuleGeometry(0.027, 0.075, 4, 12), 0, 0.017, 0.004, Math.PI / 2, 0, 0, 1, 1, 0.72), paint);
  // camera in a cage at the nose, tilted up like a real FPV quad
  const up = THREE.MathUtils.degToRad(spec.camUptilt);
  k.frame.add(place(new THREE.BoxGeometry(0.024, 0.022, 0.02), 0, 0.02, -0.07, up), { color: '#121413', rough: 0.6, metal: 0.2 });
  k.frame.add(place(new THREE.CylinderGeometry(0.0075, 0.0085, 0.01, 12), 0, 0.022, -0.082, Math.PI / 2 - up), GLASS);
  for (const s of [-1, 1]) k.frame.add(place(new THREE.BoxGeometry(0.004, 0.03, 0.03), s * 0.016, 0.02, -0.068), paint);
  // pack on top with an accent strap: the flat SPARK silhouette gets its one bump
  k.hot.add(place(new THREE.BoxGeometry(0.036, 0.03, 0.084), 0, 0.053, 0.006), PACK);
  k.frame.add(place(new THREE.BoxGeometry(0.038, 0.032, 0.012), 0, 0.053, -0.012), acc);
  k.frame.add(place(new THREE.BoxGeometry(0.038, 0.032, 0.012), 0, 0.053, 0.026), acc);
  // whip antenna, swept back, accent tip: the SPARK flag
  const aBase = v3(0, 0.035, 0.058), aTip = v3(0, 0.105, 0.098);
  k.frame.add(rod(aBase, aTip, 0.0022, 6), { color: '#202322', rough: 0.6, metal: 0.1 });
  k.frame.add(place(new THREE.SphereGeometry(0.0065, 8, 6), aTip.x, aTip.y, aTip.z), acc);
  navLights(k, -0.006, 0.007, 0.74);
  addTierProps(k, 0.026, 3);
  return finish(k);
}

// ------------------------------------------------------------------ BOLT

function buildBolt(spec: DroneSpec): DroneVisual {
  const k = start(spec, v3(0, 0.03, -0.13));
  const L = spec.armLength, legH = TIER_LEG.bolt;
  const paint = paintOf(spec.color), acc = accentOf(spec.accent);
  // fuselage: a blue capsule, long axis forward
  k.frame.add(place(new THREE.CapsuleGeometry(0.043, 0.13, 5, 16), 0, 0.012, 0, Math.PI / 2, 0, 0, 1, 1, 0.78), paint);
  // evergreen nose cap and spine
  k.frame.add(place(new THREE.SphereGeometry(0.037, 14, 8, 0, Math.PI * 2, 0, Math.PI / 2), 0, 0.012, -0.098, -Math.PI / 2, 0, 0, 1, 1, 0.78), acc);
  k.frame.add(place(new THREE.BoxGeometry(0.014, 0.008, 0.15), 0, 0.046, 0.01), acc);
  k.frame.add(place(new THREE.CylinderGeometry(0.008, 0.008, 0.006, 12), 0, 0.02, -0.132, Math.PI / 2), GLASS);
  // pack on the back, behind the spine
  k.hot.add(place(new THREE.BoxGeometry(0.05, 0.032, 0.09), 0, 0.058, 0.035), PACK);
  // arms: round carbon tubes, blue motor pods
  for (const m of motorLayout(spec)) {
    const dir = v3(m.x, 0, m.z).normalize();
    k.frame.add(rod(dir.clone().multiplyScalar(0.03), v3(m.x, 0, m.z), 0.0095, 8), CARBON);
    k.frame.add(place(new THREE.CylinderGeometry(0.026, 0.022, 0.018, 16), m.x, -0.004, m.z), paint);
    motor(k, m.x, 0.005, m.z, 0.021, 0.022, acc);
  }
  // the belly tank (0.5 L) with evergreen end bands: BOLT's silhouette
  k.frame.add(place(new THREE.CapsuleGeometry(0.039, 0.07, 4, 16), 0, -0.058, 0.01, Math.PI / 2), TANK);
  for (const z of [-0.034, 0.054]) k.frame.add(place(new THREE.CylinderGeometry(0.0405, 0.0405, 0.008, 16), 0, -0.058, z, Math.PI / 2), acc);
  k.frame.add(rod(v3(0, -0.03, 0.01), v3(0, -0.02, 0.01), 0.02, 10), CARBON);
  lance(k, v3(0, -0.06, -0.05), v3(0, -0.052, -0.2), 0.0055);
  // skids
  const sx = L * 0.45;
  for (const s of [-1, 1]) {
    for (const zz of [-1, 1]) k.frame.add(rod(v3(s * 0.034, -0.02, zz * 0.05), v3(s * sx, -legH + 0.008, zz * 0.075), 0.0045, 6), CARBON);
    skid(k, s * sx, -legH + 0.008, 0.2, 0.008, acc);
  }
  navLights(k, -0.012, 0.009);
  addTierProps(k, 0.032, 2);
  return finish(k);
}

// ------------------------------------------------------------------ STORM

function buildStorm(spec: DroneSpec): DroneVisual {
  const k = start(spec, v3(0, 0.0, -0.15));
  const L = spec.armLength, legH = TIER_LEG.storm;
  const paint = paintOf(spec.color), acc = accentOf(spec.accent);
  // hexagonal hull, flat side to the front
  k.frame.add(place(new THREE.CylinderGeometry(0.115, 0.13, 0.06, 6), 0, 0, 0, 0, Math.PI / 6), paint);
  k.frame.add(place(new THREE.CylinderGeometry(0.1, 0.116, 0.022, 6), 0, 0.041, 0, 0, Math.PI / 6), paint);
  // light green edge band: the accent line that reads STORM up close
  k.frame.add(place(new THREE.CylinderGeometry(0.1165, 0.1165, 0.008, 6, 1, true), 0, 0.028, 0, 0, Math.PI / 6), acc);
  k.frame.add(place(new THREE.CylinderGeometry(0.0125, 0.0125, 0.008, 12), 0, 0.006, -0.135, Math.PI / 2), GLASS);
  // EMP emitter: dark glass dome under a floating coil. The halo is the STORM silhouette.
  k.frame.add(place(new THREE.SphereGeometry(0.06, 16, 8, 0, Math.PI * 2, 0, Math.PI / 2), 0, 0.052, 0), GLASS);
  const coilY = 0.135, coilR = 0.125;
  k.glow.add(place(new THREE.TorusGeometry(coilR, 0.0085, 6, 48), 0, coilY, 0, Math.PI / 2), { color: hdr(spec.accent, 2.2) });
  k.glow.add(place(new THREE.TorusGeometry(coilR * 0.62, 0.005, 5, 36), 0, coilY - 0.012, 0, Math.PI / 2), { color: hdr(spec.accent, 1.6) });
  for (let i = 0; i < 3; i++) {
    const a = i * Math.PI * 2 / 3 + Math.PI / 2;
    k.frame.add(rod(v3(Math.cos(a) * 0.075, 0.05, Math.sin(a) * 0.075), v3(Math.cos(a) * coilR, coilY, Math.sin(a) * coilR), 0.004, 6), CARBON);
  }
  // pack at the rear, between two arms
  k.hot.add(place(new THREE.BoxGeometry(0.08, 0.044, 0.06), 0, -0.004, 0.13), PACK);
  // six arms
  for (const m of motorLayout(spec)) {
    const dir = v3(m.x, 0, m.z).normalize();
    k.frame.add(rod(dir.clone().multiplyScalar(0.11), v3(m.x, 0, m.z), 0.012, 8), CARBON);
    k.frame.add(place(new THREE.CylinderGeometry(0.031, 0.026, 0.022, 16), m.x, -0.006, m.z), paint);
    motor(k, m.x, 0.005, m.z, 0.026, 0.026, acc);
  }
  // 0.7 L puck tank under the hull
  k.frame.add(place(new THREE.CylinderGeometry(0.076, 0.072, 0.05, 20), 0, -0.058, 0), TANK);
  k.frame.add(place(new THREE.CylinderGeometry(0.077, 0.077, 0.008, 20, 1, true), 0, -0.05, 0), acc);
  lance(k, v3(0, -0.062, -0.07), v3(0, -0.058, -0.27), 0.0065);
  // four splayed legs to two skids
  const sx = L * 0.45;
  for (const s of [-1, 1]) {
    for (const zz of [-1, 1]) k.frame.add(rod(v3(s * 0.06, -0.03, zz * 0.06), v3(s * sx, -legH + 0.011, zz * 0.12), 0.006, 6), CARBON);
    skid(k, s * sx, -legH + 0.011, 0.28, 0.011, paint);
  }
  navLights(k, -0.016, 0.011);
  addTierProps(k, 0.036, 2);
  return finish(k);
}

// ------------------------------------------------------------------ NOVA

function buildNova(spec: DroneSpec): DroneVisual {
  const k = start(spec, v3(0, -0.02, -0.21));
  const L = spec.armLength, legH = TIER_LEG.nova;
  const paint = paintOf(spec.color), acc = accentOf(spec.accent);
  // big pebble shell over a carbon octagon
  k.frame.add(place(new THREE.SphereGeometry(1, 28, 16), 0, 0.015, 0, 0, 0, 0, 0.15, 0.075, 0.2), paint);
  k.frame.add(place(new THREE.CylinderGeometry(0.15, 0.15, 0.012, 8), 0, -0.03, 0, 0, Math.PI / 8), CARBON);
  // accent belt and chin
  k.frame.add(place(new THREE.TorusGeometry(1, 0.06, 6, 40), 0, 0.0, 0, Math.PI / 2, 0, 0, 0.152, 0.2, 0.15), acc);
  k.frame.add(place(new THREE.CylinderGeometry(0.014, 0.014, 0.01, 12), 0, 0.0, -0.198, Math.PI / 2), GLASS);
  // NOVA core: a glowing orb in a gimbal cage on a pedestal. The orb is the NOVA silhouette.
  k.frame.add(place(new THREE.CylinderGeometry(0.03, 0.045, 0.05, 12), 0, 0.09, 0), CARBON);
  k.glow.add(place(new THREE.IcosahedronGeometry(0.055, 2), 0, 0.165, 0), { color: hdr(BRAND.light, 3.2) });
  k.frame.add(place(new THREE.TorusGeometry(0.078, 0.0055, 6, 40), 0, 0.165, 0, 0, 0, 0), METAL);
  k.frame.add(place(new THREE.TorusGeometry(0.078, 0.0055, 6, 40), 0, 0.165, 0, 0, Math.PI / 2, 0), METAL);
  k.frame.add(place(new THREE.TorusGeometry(0.078, 0.0055, 6, 40), 0, 0.165, 0, Math.PI / 2, 0, 0), acc);
  // packs either side of the pedestal
  for (const s of [-1, 1]) k.hot.add(place(new THREE.BoxGeometry(0.05, 0.04, 0.15), s * 0.075, 0.065, 0.02, 0, 0, s * -0.25), PACK);
  // four heavy arms ending in coaxial motor stacks (motors at y +-0.06)
  for (const m of motorLayout(spec)) {
    if (m.y < 0) continue;
    const dir = v3(m.x, 0, m.z).normalize();
    k.frame.add(rod(dir.clone().multiplyScalar(0.13), v3(m.x, 0, m.z), 0.016, 10), CARBON);
    k.frame.add(place(new THREE.CylinderGeometry(0.03, 0.03, 0.1, 16), m.x, 0, m.z), paint);
    k.frame.add(place(new THREE.CylinderGeometry(0.031, 0.031, 0.014, 16, 1, true), m.x, 0, m.z), acc);
    motor(k, m.x, 0.05, m.z, 0.03, 0.028, acc);
    motor(k, m.x, -0.05, m.z, 0.03, 0.028, acc, true);
  }
  // 0.9 L tank across the belly in a carbon cradle
  k.frame.add(place(new THREE.CapsuleGeometry(0.048, 0.12, 4, 16), 0, -0.09, 0.0, 0, 0, Math.PI / 2), TANK);
  for (const x of [-0.06, 0.06]) k.frame.add(place(new THREE.CylinderGeometry(0.05, 0.05, 0.01, 16), x, -0.09, 0, 0, 0, Math.PI / 2), acc);
  k.frame.add(place(new THREE.BoxGeometry(0.03, 0.05, 0.03), 0, -0.055, 0), CARBON);
  lance(k, v3(0, -0.09, -0.06), v3(0, -0.085, -0.34), 0.0075);
  // tall gear: two legs per side to accent skids
  const sx = L * 0.45;
  for (const s of [-1, 1]) {
    for (const zz of [-1, 1]) k.frame.add(rod(v3(s * 0.08, -0.04, zz * 0.08), v3(s * sx, -legH + 0.013, zz * 0.14), 0.008, 8), CARBON);
    skid(k, s * sx, -legH + 0.013, 0.34, 0.013, acc);
  }
  navLights(k, -0.03, 0.013, 0.7);
  addTierProps(k, 0.036, 2);
  return finish(k);
}

export const TIER_BUILDERS = { spark: buildSpark, bolt: buildBolt, storm: buildStorm, nova: buildNova } as const;
