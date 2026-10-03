import * as THREE from 'three';
import { DroneSpec, motorLayout } from '../sim/spec';
import { TIER_LEG } from '../sim/drone';
import type { DroneVisual } from '../render/droneModels';
import { BRAND, PartSet, Finish, place, rod, tierBodyMaterial, hideWhenClear, luminance, mergeBuilt, shared, sceneIsThermal } from './kit';

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
// Geometry is built ONCE per tier and paint and shared by every drone that wears it (a model swap
// on evolve costs about a millisecond, 50 drones cost the memory of four). Each drone owns only its
// materials, so the evolve glow lights one drone. Level of detail inside the root (THREE.LOD):
//   NEAR  under 80 m: body (paint, carbon, tank, gear, motors, packs) + lights (nav LEDs, coil,
//         core) + ONE merged blur disc for all rotors: 3 draw calls in flight, 1 in the shadow pass;
//         blades are separate meshes so they spin, and hide once the rotor blurs (animateProps)
//   MID   80 to 250 m: the model rebuilt at 40 % tessellation in one mesh, rotors as lit rings
//   FAR   beyond 250 m: a minimal silhouette (arms, body, rotor rings, beacon, signature)
// While a Royale art system runs, mid and far drones of the whole match are drawn instanced
// (src/art/crowd.ts): one draw call per tier and level, no matter how many drones.

type V3 = THREE.Vector3;
const v3 = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);

/** tessellation factor: 1 for the near model, 0.4 for the mid model */
let Q = 1;
const sg = (n: number) => Math.max(3, Math.round(n * Q));

const CARBON: Finish = { color: BRAND.carbon, rough: 0.38, metal: 0.35 };
const METAL: Finish = { color: BRAND.metal, rough: 0.3, metal: 0.85 };
const BRASS: Finish = { color: BRAND.brass, rough: 0.35, metal: 0.8 };
const GLASS: Finish = { color: BRAND.glass, rough: 0.06, metal: 0.9, temp: 0.6 };
// water reads cold in the thermal view, packs warm, motors hottest (their part set)
const TANK: Finish = { color: BRAND.tank, rough: 0.55, metal: 0.0, temp: 0.3 };
const RUBBER: Finish = { color: '#151716', rough: 0.9, metal: 0.0, temp: 0.55 };
const PACK: Finish = { color: '#2a2e2c', rough: 0.5, metal: 0.1, temp: 0.86 };

const paintOf = (c: string): Finish => ({ color: c, rough: 0.42, metal: 0.12 });
const accentOf = (c: string): Finish => ({ color: c, rough: 0.5, metal: 0.05 });

/** prop tips wear the accent unless it is too dark to read at a distance, then the paint */
export function tipColor(spec: DroneSpec) { return luminance(spec.accent) > 0.25 ? spec.accent : spec.color; }

export const LOD_MID = 80, LOD_FAR = 250;

/** every tier drone ever built, weakly held: the beacon and crowd layers draw the live ones */
export const tierRoots = new Set<WeakRef<THREE.Object3D>>();

interface PropSlot { x: number; y: number; z: number; dir: number; }
interface Kit {
  spec: DroneSpec;
  frame: PartSet; hot: PartSet; glow: PartSet; mid: PartSet; far: PartSet;
  props: PropSlot[]; blades: number;
  nozzles: { pos: V3; dir: V3 }[];
  fpv: V3;
}

/** everything a tier drone needs that does not change per drone: shared, never disposed by a drone */
export interface TierAsset {
  key: string;
  body: THREE.BufferGeometry; glow: THREE.BufferGeometry;
  mid: THREE.BufferGeometry; far: THREE.BufferGeometry;
  blade: THREE.BufferGeometry; disc: THREE.BufferGeometry;
  props: PropSlot[];
  nozzles: { pos: V3; dir: V3 }[];
  fpv: V3;
}

function start(spec: DroneSpec, fpv: V3): Kit {
  return { spec, frame: new PartSet(0.68), hot: new PartSet(0.97), glow: new PartSet(0.9), mid: new PartSet(0.6), far: new PartSet(0.72), props: [], blades: 2, nozzles: [], fpv };
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
  out.computeBoundingSphere();
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

/** rotor slots: one pivot per motor, at the hub height above (or below, for coax lower rotors) */
function addTierProps(k: Kit, hubH: number, blades: number) {
  k.blades = blades;
  k.props = motorLayout(k.spec).map(m => ({ x: m.x, y: m.y + hubH * (m.y < 0 ? -1 : 1), z: m.z, dir: m.dir }));
}

/** rotor tip rings for the mid level, where the blur discs are gone */
function midRotors(k: Kit, hubH: number) {
  const { spec } = k;
  const R = spec.propDiameter / 2;
  for (const m of motorLayout(spec)) {
    const y = m.y + hubH * (m.y < 0 ? -1 : 1);
    k.mid.add(place(new THREE.TorusGeometry(R * 0.88, Math.max(0.006, R * 0.05), 3, 20), m.x, y, m.z, Math.PI / 2), { color: tipColor(spec), emit: 0.7, rough: 0.5 });
  }
}

/**
 * The far silhouette: what is left of a drone at 250 m and beyond (a few pixels): arms, body,
 * rotor rings in the tip colour, a beacon on top and the tier's signature shape.
 */
function farSilhouette(k: Kit, body: [number, number, number], bodyY: number, signature?: (p: PartSet) => void) {
  const { spec } = k;
  const R = spec.propDiameter / 2;
  const tip = tipColor(spec);
  k.far.add(place(new THREE.BoxGeometry(...body), 0, bodyY, 0), paintOf(spec.color));
  for (const m of motorLayout(spec)) {
    if (m.y < 0) continue;
    const a = Math.atan2(m.z, m.x), L = Math.hypot(m.x, m.z);
    k.far.add(place(new THREE.BoxGeometry(L, 0.02, 0.025), Math.cos(a) * L / 2, 0, Math.sin(a) * L / 2, 0, -a, 0), { color: '#2a2d2c', rough: 0.6 });
    for (const y of spec.layout === 'coaxX8' ? [0.096, -0.096] : [0.03]) {
      k.far.add(place(new THREE.TorusGeometry(R * 0.86, Math.max(0.012, R * 0.09), 3, 10), m.x, y, m.z, Math.PI / 2), { color: tip, emit: 0.9, rough: 0.5 });
    }
  }
  k.far.add(place(new THREE.OctahedronGeometry(0.035 + spec.armLength * 0.06, 0), 0, bodyY + body[1] * 0.5 + 0.03, 0), { color: BRAND.light, emit: 3 });
  signature?.(k.far);
}

// ------------------------------------------------------------------ shared pieces

/** nav lights: Light Green at the front arms, warm red at the rear, read the heading at a glance */
function navLights(k: Kit, y: number, size: number, frac = 0.82) {
  for (const m of motorLayout(k.spec)) {
    if (m.y < 0) continue;
    const front = m.z < -1e-3;
    const g = new THREE.BoxGeometry(size * 1.8, size * 0.7, size);
    place(g, m.x * frac, y, m.z * frac, 0, -Math.atan2(m.z, m.x), 0);
    k.glow.add(g, { color: front ? BRAND.light : '#ff5040', emit: front ? 2.6 : 2.4, rough: 0.4, metal: 0 });
  }
}

/** motor: bell can on a mount, with a paint ring that keeps the tier colour visible from below */
function motor(k: Kit, x: number, y: number, z: number, r: number, h: number, ring: Finish, down = false) {
  const s = down ? -1 : 1;
  k.hot.add(place(new THREE.CylinderGeometry(r, r * 0.96, h, sg(16)), x, y + s * h / 2, z), METAL);
  k.hot.add(place(new THREE.CylinderGeometry(r * 0.32, r * 0.32, h * 0.35, sg(8)), x, y + s * (h + h * 0.15), z), { color: '#c9cac4', rough: 0.25, metal: 0.9 });
  k.frame.add(place(new THREE.CylinderGeometry(r * 1.04, r * 1.04, h * 0.22, sg(16), 1, true), x, y + s * h * 0.62, z), ring);
}

function skid(k: Kit, x: number, y: number, len: number, r: number, f: Finish) {
  k.frame.add(place(new THREE.CapsuleGeometry(r, len, sg(3), sg(8)), x, y, 0, Math.PI / 2), f);
}

/** water lance: tube from the tank to a brass nozzle; registers the nozzle for the jet VFX */
function lance(k: Kit, from: V3, to: V3, r: number) {
  k.frame.add(rod(from, to, r, sg(8)), METAL);
  const dir = to.clone().sub(from).normalize();
  const tipStart = to.clone(), tipEnd = to.clone().addScaledVector(dir, r * 3.2);
  k.frame.add(rod(tipStart, tipEnd, r * 1.5, sg(10), r * 0.9), BRASS);
  k.nozzles.push({ pos: tipEnd.clone(), dir });
}

// ------------------------------------------------------------------ SPARK

function buildSpark(spec: DroneSpec): Kit {
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
    k.frame.add(place(new THREE.CylinderGeometry(0.0055, 0.007, legH - 0.012, sg(8)), fx, -0.003 - (legH - 0.012) / 2, fz), paint);
    k.frame.add(place(new THREE.SphereGeometry(0.0072, sg(8), sg(6)), fx, -legH + 0.0072, fz), RUBBER);
  }
  // plates
  k.frame.add(place(new THREE.BoxGeometry(0.062, 0.004, 0.13), 0, -0.004, 0), CARBON);
  k.frame.add(place(new THREE.BoxGeometry(0.05, 0.003, 0.105), 0, 0.036, 0.004), CARBON);
  // moulded pod around the stack: the paint carries the tier at a glance
  k.frame.add(place(new THREE.CapsuleGeometry(0.027, 0.075, sg(4), sg(12)), 0, 0.017, 0.004, Math.PI / 2, 0, 0, 1, 1, 0.72), paint);
  // camera in a cage at the nose, tilted up like a real FPV quad
  const up = THREE.MathUtils.degToRad(spec.camUptilt);
  k.frame.add(place(new THREE.BoxGeometry(0.024, 0.022, 0.02), 0, 0.02, -0.07, up), { color: '#121413', rough: 0.6, metal: 0.2 });
  k.frame.add(place(new THREE.CylinderGeometry(0.0075, 0.0085, 0.01, sg(12)), 0, 0.022, -0.082, Math.PI / 2 - up), GLASS);
  for (const s of [-1, 1]) k.frame.add(place(new THREE.BoxGeometry(0.004, 0.03, 0.03), s * 0.016, 0.02, -0.068), paint);
  // pack on top with an accent strap: the flat SPARK silhouette gets its one bump
  k.hot.add(place(new THREE.BoxGeometry(0.036, 0.03, 0.084), 0, 0.053, 0.006), PACK);
  k.frame.add(place(new THREE.BoxGeometry(0.038, 0.032, 0.012), 0, 0.053, 0.026), acc);
  // whip antenna, swept back, accent tip: the SPARK flag
  const aBase = v3(0, 0.035, 0.058), aTip = v3(0, 0.105, 0.098);
  k.frame.add(rod(aBase, aTip, 0.0022, sg(6)), { color: '#202322', rough: 0.6, metal: 0.1 });
  k.frame.add(place(new THREE.SphereGeometry(0.0065, sg(8), sg(6)), aTip.x, aTip.y, aTip.z), acc);
  navLights(k, -0.006, 0.007, 0.74);
  addTierProps(k, 0.026, 3);
  midRotors(k, 0.026);
  farSilhouette(k, [0.06, 0.05, 0.14], 0.025);
  return k;
}

// ------------------------------------------------------------------ BOLT

function buildBolt(spec: DroneSpec): Kit {
  const k = start(spec, v3(0, 0.03, -0.13));
  const L = spec.armLength, legH = TIER_LEG.bolt;
  const paint = paintOf(spec.color), acc = accentOf(spec.accent);
  // fuselage: a blue capsule, long axis forward
  k.frame.add(place(new THREE.CapsuleGeometry(0.043, 0.13, sg(5), sg(16)), 0, 0.012, 0, Math.PI / 2, 0, 0, 1, 1, 0.78), paint);
  // evergreen nose cap and spine
  k.frame.add(place(new THREE.SphereGeometry(0.037, sg(14), sg(8), 0, Math.PI * 2, 0, Math.PI / 2), 0, 0.012, -0.098, -Math.PI / 2, 0, 0, 1, 1, 0.78), acc);
  k.frame.add(place(new THREE.BoxGeometry(0.014, 0.008, 0.15), 0, 0.046, 0.01), acc);
  k.frame.add(place(new THREE.CylinderGeometry(0.008, 0.008, 0.006, sg(12)), 0, 0.02, -0.132, Math.PI / 2), GLASS);
  // pack on the back, behind the spine
  k.hot.add(place(new THREE.BoxGeometry(0.05, 0.032, 0.09), 0, 0.058, 0.035), PACK);
  // arms: round carbon tubes, blue motor pods
  for (const m of motorLayout(spec)) {
    const dir = v3(m.x, 0, m.z).normalize();
    k.frame.add(rod(dir.clone().multiplyScalar(0.03), v3(m.x, 0, m.z), 0.0095, sg(8)), CARBON);
    k.frame.add(place(new THREE.CylinderGeometry(0.026, 0.022, 0.018, sg(16)), m.x, -0.004, m.z), paint);
    motor(k, m.x, 0.005, m.z, 0.021, 0.022, acc);
  }
  // the belly tank (0.5 L) with evergreen end bands: BOLT's silhouette
  k.frame.add(place(new THREE.CapsuleGeometry(0.039, 0.07, sg(4), sg(16)), 0, -0.058, 0.01, Math.PI / 2), TANK);
  for (const z of [-0.034, 0.054]) k.frame.add(place(new THREE.CylinderGeometry(0.0405, 0.0405, 0.008, sg(16)), 0, -0.058, z, Math.PI / 2), acc);
  k.frame.add(rod(v3(0, -0.03, 0.01), v3(0, -0.02, 0.01), 0.02, sg(10)), CARBON);
  lance(k, v3(0, -0.06, -0.05), v3(0, -0.052, -0.2), 0.0055);
  // skids
  const sx = L * 0.45;
  for (const s of [-1, 1]) {
    for (const zz of [-1, 1]) k.frame.add(rod(v3(s * 0.034, -0.02, zz * 0.05), v3(s * sx, -legH + 0.008, zz * 0.075), 0.0045, sg(6)), CARBON);
    skid(k, s * sx, -legH + 0.008, 0.2, 0.008, acc);
  }
  navLights(k, -0.012, 0.009);
  addTierProps(k, 0.032, 2);
  midRotors(k, 0.032);
  farSilhouette(k, [0.09, 0.09, 0.24], -0.01, p => p.add(place(new THREE.CapsuleGeometry(0.04, 0.07, 2, 6), 0, -0.058, 0.01, Math.PI / 2), TANK));
  return k;
}

// ------------------------------------------------------------------ STORM

function buildStorm(spec: DroneSpec): Kit {
  const k = start(spec, v3(0, 0.0, -0.15));
  const L = spec.armLength, legH = TIER_LEG.storm;
  const paint = paintOf(spec.color), acc = accentOf(spec.accent);
  // hexagonal hull, flat side to the front
  k.frame.add(place(new THREE.CylinderGeometry(0.115, 0.13, 0.06, 6), 0, 0, 0, 0, Math.PI / 6), paint);
  k.frame.add(place(new THREE.CylinderGeometry(0.1, 0.116, 0.022, 6), 0, 0.041, 0, 0, Math.PI / 6), paint);
  // light green edge band: the accent line that reads STORM up close
  k.frame.add(place(new THREE.CylinderGeometry(0.1165, 0.1165, 0.008, 6, 1, true), 0, 0.028, 0, 0, Math.PI / 6), acc);
  k.frame.add(place(new THREE.CylinderGeometry(0.0125, 0.0125, 0.008, sg(12)), 0, 0.006, -0.135, Math.PI / 2), GLASS);
  // EMP emitter: dark glass dome under a floating coil. The halo is the STORM silhouette.
  k.frame.add(place(new THREE.SphereGeometry(0.06, sg(16), sg(8), 0, Math.PI * 2, 0, Math.PI / 2), 0, 0.052, 0), GLASS);
  const coilY = 0.135, coilR = 0.125;
  k.glow.add(place(new THREE.TorusGeometry(coilR, 0.0085, sg(6), sg(48)), 0, coilY, 0, Math.PI / 2), { color: spec.accent, emit: 2.2, rough: 0.4, metal: 0 });
  k.glow.add(place(new THREE.TorusGeometry(coilR * 0.62, 0.005, sg(5), sg(36)), 0, coilY - 0.012, 0, Math.PI / 2), { color: spec.accent, emit: 1.6, rough: 0.4, metal: 0 });
  for (let i = 0; i < 3; i++) {
    const a = i * Math.PI * 2 / 3 + Math.PI / 2;
    k.frame.add(rod(v3(Math.cos(a) * 0.075, 0.05, Math.sin(a) * 0.075), v3(Math.cos(a) * coilR, coilY, Math.sin(a) * coilR), 0.004, sg(6)), CARBON);
  }
  // pack at the rear, between two arms
  k.hot.add(place(new THREE.BoxGeometry(0.08, 0.044, 0.06), 0, -0.004, 0.13), PACK);
  // six arms
  for (const m of motorLayout(spec)) {
    const dir = v3(m.x, 0, m.z).normalize();
    k.frame.add(rod(dir.clone().multiplyScalar(0.11), v3(m.x, 0, m.z), 0.012, sg(8)), CARBON);
    k.frame.add(place(new THREE.CylinderGeometry(0.031, 0.026, 0.022, sg(16)), m.x, -0.006, m.z), paint);
    motor(k, m.x, 0.005, m.z, 0.026, 0.026, acc);
  }
  // 0.7 L puck tank under the hull
  k.frame.add(place(new THREE.CylinderGeometry(0.076, 0.072, 0.05, sg(20)), 0, -0.058, 0), TANK);
  k.frame.add(place(new THREE.CylinderGeometry(0.077, 0.077, 0.008, sg(20), 1, true), 0, -0.05, 0), acc);
  lance(k, v3(0, -0.062, -0.07), v3(0, -0.058, -0.27), 0.0065);
  // four splayed legs to two skids
  const sx = L * 0.45;
  for (const s of [-1, 1]) {
    for (const zz of [-1, 1]) k.frame.add(rod(v3(s * 0.06, -0.03, zz * 0.06), v3(s * sx, -legH + 0.011, zz * 0.12), 0.006, sg(6)), CARBON);
    skid(k, s * sx, -legH + 0.011, 0.28, 0.011, paint);
  }
  navLights(k, -0.016, 0.011);
  addTierProps(k, 0.036, 2);
  midRotors(k, 0.036);
  farSilhouette(k, [0.22, 0.08, 0.22], 0, p => p.add(place(new THREE.TorusGeometry(0.125, 0.014, 3, 12), 0, 0.135, 0, Math.PI / 2), { color: spec.accent, emit: 2.2 }));
  return k;
}

// ------------------------------------------------------------------ NOVA

function buildNova(spec: DroneSpec): Kit {
  const k = start(spec, v3(0, -0.02, -0.21));
  const L = spec.armLength, legH = TIER_LEG.nova;
  const paint = paintOf(spec.color), acc = accentOf(spec.accent);
  // big pebble shell over a carbon octagon
  k.frame.add(place(new THREE.SphereGeometry(1, sg(28), sg(16)), 0, 0.015, 0, 0, 0, 0, 0.15, 0.075, 0.2), paint);
  k.frame.add(place(new THREE.CylinderGeometry(0.15, 0.15, 0.012, 8), 0, -0.03, 0, 0, Math.PI / 8), CARBON);
  // accent belt and chin
  k.frame.add(place(new THREE.TorusGeometry(1, 0.06, sg(6), sg(40)), 0, 0.0, 0, Math.PI / 2, 0, 0, 0.152, 0.2, 0.15), acc);
  k.frame.add(place(new THREE.CylinderGeometry(0.014, 0.014, 0.01, sg(12)), 0, 0.0, -0.198, Math.PI / 2), GLASS);
  // NOVA core: a glowing orb in a gimbal cage on a pedestal. The orb is the NOVA silhouette.
  k.frame.add(place(new THREE.CylinderGeometry(0.03, 0.045, 0.05, sg(12)), 0, 0.09, 0), CARBON);
  k.glow.add(place(new THREE.IcosahedronGeometry(0.055, Q < 1 ? 1 : 2), 0, 0.165, 0), { color: BRAND.light, emit: 3.2, rough: 0.3, metal: 0 });
  k.frame.add(place(new THREE.TorusGeometry(0.078, 0.0055, sg(6), sg(40)), 0, 0.165, 0, 0, 0, 0), METAL);
  k.frame.add(place(new THREE.TorusGeometry(0.078, 0.0055, sg(6), sg(40)), 0, 0.165, 0, 0, Math.PI / 2, 0), METAL);
  k.frame.add(place(new THREE.TorusGeometry(0.078, 0.0055, sg(6), sg(40)), 0, 0.165, 0, Math.PI / 2, 0, 0), acc);
  // packs either side of the pedestal
  for (const s of [-1, 1]) k.hot.add(place(new THREE.BoxGeometry(0.05, 0.04, 0.15), s * 0.075, 0.065, 0.02, 0, 0, s * -0.25), PACK);
  // four heavy arms ending in coaxial motor stacks (motors at y +-0.06)
  for (const m of motorLayout(spec)) {
    if (m.y < 0) continue;
    const dir = v3(m.x, 0, m.z).normalize();
    k.frame.add(rod(dir.clone().multiplyScalar(0.13), v3(m.x, 0, m.z), 0.016, sg(10)), CARBON);
    k.frame.add(place(new THREE.CylinderGeometry(0.03, 0.03, 0.1, sg(16)), m.x, 0, m.z), paint);
    k.frame.add(place(new THREE.CylinderGeometry(0.031, 0.031, 0.014, sg(16), 1, true), m.x, 0, m.z), acc);
    motor(k, m.x, 0.05, m.z, 0.03, 0.028, acc);
    motor(k, m.x, -0.05, m.z, 0.03, 0.028, acc, true);
  }
  // 0.9 L tank across the belly in a carbon cradle
  k.frame.add(place(new THREE.CapsuleGeometry(0.048, 0.12, sg(4), sg(16)), 0, -0.09, 0.0, 0, 0, Math.PI / 2), TANK);
  for (const x of [-0.06, 0.06]) k.frame.add(place(new THREE.CylinderGeometry(0.05, 0.05, 0.01, sg(16)), x, -0.09, 0, 0, 0, Math.PI / 2), acc);
  k.frame.add(place(new THREE.BoxGeometry(0.03, 0.05, 0.03), 0, -0.055, 0), CARBON);
  lance(k, v3(0, -0.09, -0.06), v3(0, -0.085, -0.34), 0.0075);
  // tall gear: two legs per side to accent skids
  const sx = L * 0.45;
  for (const s of [-1, 1]) {
    for (const zz of [-1, 1]) k.frame.add(rod(v3(s * 0.08, -0.04, zz * 0.08), v3(s * sx, -legH + 0.013, zz * 0.14), 0.008, sg(8)), CARBON);
    skid(k, s * sx, -legH + 0.013, 0.34, 0.013, acc);
  }
  navLights(k, -0.03, 0.013, 0.7);
  addTierProps(k, 0.036, 2);
  midRotors(k, 0.036);
  farSilhouette(k, [0.28, 0.14, 0.36], 0.0, p => p.add(place(new THREE.OctahedronGeometry(0.07, 1), 0, 0.165, 0), { color: BRAND.light, emit: 3.2 }));
  return k;
}

const KITS = { spark: buildSpark, bolt: buildBolt, storm: buildStorm, nova: buildNova } as const;
export type TierKind = keyof typeof KITS;

// ------------------------------------------------------------------ asset cache and assembly

const assets = new Map<string, TierAsset>();

export function assetKey(spec: DroneSpec) {
  return [spec.model, spec.color, spec.accent, spec.layout, spec.armLength, spec.propDiameter, spec.camUptilt].join('|');
}

/** build (once) the shared geometry for this tier and paint */
export function tierAsset(kind: TierKind, spec: DroneSpec): TierAsset {
  const key = assetKey(spec);
  const hit = assets.get(key);
  if (hit) return hit;
  Q = 1;
  const k = KITS[kind](spec);
  Q = 0.4;
  const lo = KITS[kind](spec);
  Q = 1;
  const frame = k.frame.build(), hot = k.hot.build(), glow = k.glow.build();
  // frame and hot parts are one mesh: the thermal contrast now lives in the vertex temperature
  const body = mergeBuilt([frame, hot]);
  frame.dispose(); hot.dispose();
  lo.far.build().dispose();
  const mid = mergeBuilt([lo.frame.build(), lo.hot.build(), lo.glow.build(), lo.mid.build()]);
  k.mid.build().dispose();
  const far = k.far.build();
  const D = spec.propDiameter, R = D / 2;
  const tip = new THREE.Color(tipColor(spec));
  const blade = bladeGeometry(D, k.blades, k.blades === 3 ? 0.085 : 0.075, new THREE.Color('#161817'), tip);
  const dark = new THREE.Color('#1d201f');
  const tipHi = tip.clone().multiplyScalar(1.35);
  // alpha per stop is multiplied by animateProps' opacity (max 0.32): the tip band ends near 0.8
  const stops: [number, THREE.Color, number][] = [[0.1, dark, 0.55], [0.72, dark, 1.25], [0.8, tipHi, 2.5], [0.95, tipHi, 2.5], [1.0, tipHi, 0.0]];
  const disc = mergeDiscs(k.props.map(p => discGeometry(R, stops).translate(p.x, p.y, p.z)));
  const a: TierAsset = { key, body, glow, mid, far, blade, disc, props: k.props, nozzles: k.nozzles, fpv: k.fpv };
  for (const g of [body, glow, mid, far, blade, disc]) g.userData.shared = true;
  assets.set(key, a);
  return a;
}

const stand = new THREE.BufferGeometry();
stand.userData.shared = true;

function discMaterial() {
  const m = hideWhenClear(new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, opacity: 0, depthWrite: false, side: THREE.DoubleSide }));
  // the blur discs keep their own material through the thermal swap, so they go cool by themselves
  m.onBeforeCompile = (sh) => {
    sh.uniforms.uThermal = shared.thermal;
    sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\nuniform float uThermal;')
      .replace('#include <opaque_fragment>', '#include <opaque_fragment>\ngl_FragColor.rgb = mix(gl_FragColor.rgb, vec3(0.16, 0.05, 0.26), uThermal);');
  };
  m.customProgramCacheKey = () => 'droneon-tier-disc';
  return m;
}

/** a drone from its shared asset: only objects and materials are new */
function assemble(a: TierAsset, spec: DroneSpec): DroneVisual {
  const v: DroneVisual = { root: new THREE.Group(), props: [], nozzles: a.nozzles.map(n => ({ pos: n.pos.clone(), dir: n.dir.clone() })), fpvCam: a.fpv.clone(), leds: [] };
  const bodyMat = tierBodyMaterial();
  const near = new THREE.Group(); near.name = 'tier-near';
  const mesh = (g: THREE.BufferGeometry, m: THREE.Material, name: string, temp: number) => { const x = new THREE.Mesh(g, m); x.name = name; x.userData.temp = temp; return x; };
  // the body draws its own thermal image from vertex temperatures; keep the world's swap off it
  const own = (x: THREE.Mesh) => { x.userData.thermalSelf = true; return x; };
  const body = own(mesh(a.body, bodyMat, 'tier-body', 0.75));
  body.onBeforeRender = (_r, scene) => { shared.thermal.value = sceneIsThermal(scene as THREE.Scene) ? 1 : 0; };
  near.add(body);
  const lights = own(mesh(a.glow, bodyMat, 'tier-lights', 0.9));
  // lights never cast shadows (one draw call saved per drone in the shadow pass)
  Object.defineProperty(lights, 'castShadow', { get: () => false, set: () => { /* fixed */ }, configurable: true });
  near.add(lights);
  v.leds.push(lights);
  // spinning props: own pivot and blades per rotor; ONE merged blur disc for all rotors (prop 0's),
  // the others carry an empty stand in sharing the material, so animateProps fades all with one draw
  const bladeMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.45, metalness: 0.1, side: THREE.DoubleSide });
  const discMat = discMaterial();
  const disc = mesh(a.disc, discMat, 'tier-discs', 0.5);
  disc.userData.noThermal = true; disc.renderOrder = 2;
  near.add(disc);
  a.props.forEach((p, i) => {
    const pivot = new THREE.Group();
    pivot.position.set(p.x, p.y, p.z);
    const b = mesh(a.blade, bladeMat, 'tier-blades', 0.5);
    if (p.dir < 0) b.scale.x = -1;
    b.rotation.y = Math.random() * Math.PI;
    pivot.add(b);
    near.add(pivot);
    let d = disc;
    if (i > 0) { d = new THREE.Mesh(stand, discMat); d.visible = false; d.userData.noThermal = true; pivot.add(d); }
    v.props.push({ pivot, blades: b, disc: d, dir: p.dir });
  });
  // mid and far live in wrappers: the LOD toggles the wrapper, the crowd layer toggles the mesh
  const midMesh = own(mesh(a.mid, bodyMat, 'tier-mid', 0.75)), farMesh = own(mesh(a.far, bodyMat, 'tier-far', 0.75));
  const mid = new THREE.Group(), far = new THREE.Group();
  mid.add(midMesh); far.add(farMesh);
  const lod = new THREE.LOD();
  lod.name = 'tier-lod';
  lod.addLevel(near, 0, 0);
  lod.addLevel(mid, LOD_MID, 0.08);
  lod.addLevel(far, LOD_FAR, 0.08);
  v.root.add(lod);
  v.root.userData.tier = spec.model;
  v.root.userData.lod = lod;
  v.root.userData.tierAsset = a;
  v.root.userData.lodMeshes = [midMesh, farMesh];
  v.root.userData.bodyMesh = body;
  tierRoots.add(new WeakRef(v.root));
  return v;
}

function builder(kind: TierKind) { return (spec: DroneSpec) => assemble(tierAsset(kind, spec), spec); }

export const TIER_BUILDERS = { spark: builder('spark'), bolt: builder('bolt'), storm: builder('storm'), nova: builder('nova') } as const;
