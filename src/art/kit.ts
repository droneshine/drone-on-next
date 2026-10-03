import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

// Shared art kit: brand palette, merged part sets for one draw call per material,
// the tier body material with per vertex roughness and metalness, and the shared clocks
// every Royale shader reads.

export const BRAND = {
  evergreen: '#002518',
  green: '#004225',
  off: '#f7f7f2',
  light: '#b5f78a',
  accent: '#26c257',
  blue: '#8fc2f5',
  bad: '#ff6b5a',
  carbon: '#1c1e1d',
  metal: '#1b1c1c',
  brass: '#c79b2c',
  glass: '#0b1014',
  tank: '#ecece6',
} as const;

/** linear colour scaled into HDR, so it can reach the bloom threshold (8) where we want glow */
export function hdr(hex: string, k: number) { return new THREE.Color(hex).multiplyScalar(k); }

export function luminance(hex: string) {
  const c = new THREE.Color(hex);
  return 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
}

/** clocks shared by every art shader: one uniform object, updated once per frame */
export const shared = {
  time: { value: 0 },
  thermal: { value: 0 },
  /** metres per CSS pixel at 1 m distance for the current camera, keeps thin lines at least a pixel wide */
  px: { value: 0.0015 },
};

/** the world swaps to its thermal look by changing the background, read it instead of reaching into World */
export function sceneIsThermal(scene: THREE.Scene) {
  const b = scene.background as THREE.Color | null;
  return !!b && (b as THREE.Color).isColor && b.getHex() === 0x0b0820;
}

const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _e = new THREE.Euler(), _s = new THREE.Vector3(), _p = new THREE.Vector3();
const _up = new THREE.Vector3(0, 1, 0);

/** place a geometry: translate, rotate (XYZ radians), scale, in that order of meaning */
export function place(geo: THREE.BufferGeometry, x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0, sx = 1, sy = 1, sz = 1) {
  _e.set(rx, ry, rz);
  _q.setFromEuler(_e);
  _m.compose(_p.set(x, y, z), _q, _s.set(sx, sy, sz));
  geo.applyMatrix4(_m);
  return geo;
}

/** cylinder from a to b */
export function rod(a: THREE.Vector3, b: THREE.Vector3, r: number, seg = 8, r2 = r) {
  const len = a.distanceTo(b);
  const g = new THREE.CylinderGeometry(r2, r, len, seg, 1);
  _q.setFromUnitVectors(_up, _p.subVectors(b, a).normalize());
  _m.compose(_s.copy(a).add(b).multiplyScalar(0.5), _q, new THREE.Vector3(1, 1, 1));
  g.applyMatrix4(_m);
  return g;
}

export interface Finish {
  color: string | THREE.Color; rough?: number; metal?: number;
  /** self light, multiplies the vertex colour */ emit?: number;
  /** thermal camera temperature 0..1 (defaults to the part set's) */ temp?: number;
}

/**
 * Collects static parts and merges them into ONE geometry with vertex colour plus per vertex
 * roughness, metalness, emission and thermal temperature (attribute aRMET). One mesh, one draw
 * call, several finishes, and a thermal image with hot motors and a cold water tank.
 */
export class PartSet {
  private geos: THREE.BufferGeometry[] = [];
  constructor(private temp = 0.7) {}

  add(geo: THREE.BufferGeometry, f: Finish) {
    let g = geo.index ? geo.toNonIndexed() : geo;
    if (g !== geo) geo.dispose();
    for (const k of Object.keys(g.attributes)) if (k !== 'position' && k !== 'normal') g.deleteAttribute(k);
    if (!g.attributes.normal) g.computeVertexNormals();
    const n = g.attributes.position.count;
    const c = f.color instanceof THREE.Color ? f.color : new THREE.Color(f.color);
    const col = new Float32Array(n * 3), rm = new Float32Array(n * 4);
    for (let i = 0; i < n; i++) {
      col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b;
      rm[i * 4] = f.rough ?? 0.5; rm[i * 4 + 1] = f.metal ?? 0.1; rm[i * 4 + 2] = f.emit ?? 0; rm[i * 4 + 3] = f.temp ?? this.temp;
    }
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    g.setAttribute('aRMET', new THREE.BufferAttribute(rm, 4));
    this.geos.push(g);
    return this;
  }

  get empty() { return this.geos.length === 0; }

  build(): THREE.BufferGeometry {
    const merged = mergeGeometries(this.geos, false) ?? new THREE.BufferGeometry();
    for (const g of this.geos) g.dispose();
    this.geos = [];
    merged.computeBoundingSphere();
    return merged;
  }
}

/** merge already built PartSet geometries (same attributes) into one, sources untouched */
export function mergeBuilt(geos: THREE.BufferGeometry[]) {
  const g = mergeGeometries(geos.filter(x => x.attributes.position?.count), false) ?? new THREE.BufferGeometry();
  g.computeBoundingSphere();
  return g;
}

/**
 * The tier body material: one MeshStandardMaterial that reads colour, roughness, metalness, self
 * light and thermal temperature per vertex. In the thermal view it draws its own ironbow image (the
 * meshes opt out of the world's material swap with userData.thermalSelf). Every tier drone shares the compiled program (same cache key), each drone owns its
 * instance so the evolve glow can light one drone without touching the others.
 */
export function tierBodyMaterial() {
  const m = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1, metalness: 1 });
  m.onBeforeCompile = (sh) => {
    sh.uniforms.uThermal = shared.thermal;
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nattribute vec4 aRMET;\nvarying vec4 vRMET;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvRMET = aRMET;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec4 vRMET;\nuniform float uThermal;\n' + GLSL_IRONBOW)
      .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\nroughnessFactor = vRMET.x;')
      .replace('#include <metalnessmap_fragment>', '#include <metalnessmap_fragment>\nmetalnessFactor = vRMET.y;')
      .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance += vColor.rgb * vRMET.z;')
      .replace('#include <dithering_fragment>', '#include <dithering_fragment>\nif (uThermal > 0.5) gl_FragColor.rgb = ironbow(vRMET.w);');
  };
  m.customProgramCacheKey = () => 'droneon-tier-body';
  m.userData.tierPaint = true;
  return m;
}

/** a material that drops out of the render list entirely while its opacity is zero (no empty draw calls) */
export function hideWhenClear<T extends THREE.Material>(m: T): T {
  Object.defineProperty(m, 'visible', { get(this: THREE.Material) { return this.opacity > 0.004; }, set() { /* driven by opacity */ }, configurable: true });
  return m;
}

/** grey value noise on a canvas, the raw material of static, scan noise and water streaks */
export function noiseCanvas(size = 128, seed = 1, alpha = false) {
  const c = document.createElement('canvas'); c.width = c.height = size;
  const g = c.getContext('2d')!;
  const img = g.createImageData(size, size);
  let s = seed * 9301 + 49297;
  const rnd = () => { s = (s * 9301 + 49297) % 233280; return s / 233280; };
  for (let i = 0; i < size * size; i++) {
    const v = rnd();
    const k = i * 4;
    if (alpha) { img.data[k] = img.data[k + 1] = img.data[k + 2] = 255; img.data[k + 3] = Math.floor(v * v * 255); }
    else { img.data[k] = img.data[k + 1] = img.data[k + 2] = Math.floor(v * 255); img.data[k + 3] = 255; }
  }
  g.putImageData(img, 0, 0);
  return c;
}

/** count triangles of everything under an object (visible or not) */
export function triangles(o: THREE.Object3D) {
  let n = 0;
  o.traverse(x => {
    const m = x as THREE.Mesh;
    if (!m.isMesh || !m.geometry?.attributes.position) return;
    n += (m.geometry.index ? m.geometry.index.count : m.geometry.attributes.position.count) / 3;
  });
  return Math.round(n);
}

/** shared GLSL: hash and value noise */
export const GLSL_NOISE = /* glsl */`
float h21(vec2 p){ p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
float vnoise(vec2 p){ vec2 i = floor(p), f = fract(p); vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(h21(i), h21(i + vec2(1.0, 0.0)), u.x), mix(h21(i + vec2(0.0, 1.0)), h21(i + vec2(1.0, 1.0)), u.x), u.y); }
`;

/** thermal camera palette in GLSL, same curve as world.ts ironbow() */
export const GLSL_IRONBOW = /* glsl */`
vec3 ironbow(float t){ t = clamp(t, 0.0, 1.0);
  float r = clamp(1.5 * t - 0.1, 0.0, 1.0);
  float g = clamp(t * t * 1.4 - 0.25 + (t > 0.85 ? (t - 0.85) * 1.3 : 0.0), 0.0, 1.0);
  float b = clamp(0.5 * sin(t * 3.6) + (t > 0.85 ? (t - 0.85) * 5.0 : 0.0), 0.0, 1.0);
  return vec3(r, g, b); }
`;
