import * as THREE from 'three';
import { fbm, vnoise } from './noise';

// The field. Flat working zones (base, solar park, facade block, freestyle park)
// blend into rolling hills, a lake to the south and a ridge to the far north.

export const WORLD = 1600;          // metres, square
export const LAKE = { x: 40, z: 300, r: 120 };
export const WATER_Y = -1.6;

interface Flat { x: number; z: number; rx: number; rz: number; h: number; }
export const FLATS: Flat[] = [
  { x: 0, z: 0, rx: 70, rz: 60, h: 0 },          // home base
  { x: 0, z: -170, rx: 120, rz: 95, h: 0 },      // solar park
  { x: 190, z: 0, rx: 95, rz: 110, h: 0 },       // facade block
  { x: -200, z: 0, rx: 120, rz: 120, h: 0 },     // freestyle park
  { x: -330, z: -280, rx: 50, rz: 50, h: 4 },    // wind turbine pad
];

const ss = (a: number, b: number, x: number) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

export function heightAt(x: number, z: number) {
  let h = (fbm(x * 0.0035 + 11, z * 0.0035 - 7, 5) - 0.45) * 46;
  h += (vnoise(x * 0.02, z * 0.02) - 0.5) * 2.2;
  // rise toward the edges so the world feels like a valley
  const edge = Math.max(Math.abs(x), Math.abs(z)) / (WORLD / 2);
  h += ss(0.55, 1.0, edge) * 70;
  // lake bowl
  const dl = Math.hypot(x - LAKE.x, (z - LAKE.z) * 1.3);
  const lakeW = 1 - ss(LAKE.r * 0.55, LAKE.r * 1.25, dl);
  h = h * (1 - lakeW) + (-6 + dl / LAKE.r * 3.5) * lakeW;
  // flatten work zones
  for (const f of FLATS) {
    const d = Math.max(Math.abs(x - f.x) / f.rx, Math.abs(z - f.z) / f.rz);
    const w = 1 - ss(0.85, 1.35, d);
    h = h * (1 - w) + f.h * w;
  }
  return h;
}

export function buildTerrain(): THREE.Mesh {
  const seg = 320;
  const geo = new THREE.PlaneGeometry(WORLD, WORLD, seg, seg);
  geo.rotateX(-Math.PI / 2);
  const pos = geo.attributes.position as THREE.BufferAttribute;
  const col = new Float32Array(pos.count * 3);
  const c = new THREE.Color();
  const grassA = new THREE.Color('#3f6b2a'), grassB = new THREE.Color('#5b8a35'), dry = new THREE.Color('#8b8a4e');
  const dirt = new THREE.Color('#6e5a3f'), rock = new THREE.Color('#77786f'), sand = new THREE.Color('#b9a77f');
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), z = pos.getZ(i);
    const h = heightAt(x, z);
    pos.setY(i, h);
    const n = fbm(x * 0.02, z * 0.02, 3);
    c.copy(grassA).lerp(grassB, n);
    c.lerp(dry, Math.max(0, fbm(x * 0.006 + 3, z * 0.006, 3) - 0.5) * 1.4);
    if (h > 30) c.lerp(rock, ss(30, 55, h));
    if (h < WATER_Y + 1.2) c.lerp(sand, ss(WATER_Y + 1.2, WATER_Y - 0.5, h));
    // gravel tracks between zones
    const track = Math.min(
      Math.abs(z - 0) < 5 && Math.abs(x) < 300 ? Math.abs(z) / 5 : 1,
      Math.abs(x - 0) < 5 && z < 0 && z > -270 ? Math.abs(x) / 5 : 1,
    );
    if (track < 1) c.lerp(dirt, (1 - track) * 0.85);
    col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  geo.computeVertexNormals();

  const detail = groundDetailTexture();
  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95, metalness: 0, map: detail });
  mat.onBeforeCompile = (sh) => {
    // world space tiling of the detail map, two scales to kill repetition
    sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nvarying vec3 vWP;')
      .replace('#include <worldpos_vertex>', '#include <worldpos_vertex>\nvWP = (modelMatrix * vec4(transformed,1.0)).xyz;');
    sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\nvarying vec3 vWP;')
      .replace('#include <map_fragment>', `
        vec4 d1 = texture2D(map, vWP.xz * 0.21);
        vec4 d2 = texture2D(map, vWP.xz * 0.037 + 0.37);
        diffuseColor.rgb *= mix(0.78, 1.22, d1.r) * mix(0.85, 1.15, d2.g);
      `);
  };
  const mesh = new THREE.Mesh(geo, mat);
  mesh.receiveShadow = true;
  mesh.name = 'terrain';
  return mesh;
}

function groundDetailTexture() {
  const s = 256;
  const data = new Uint8Array(s * s * 4);
  for (let y = 0; y < s; y++) for (let x = 0; x < s; x++) {
    const i = (y * s + x) * 4;
    // tileable noise via torus mapping
    const a = x / s * Math.PI * 2, b = y / s * Math.PI * 2;
    const nx = Math.cos(a) * 3, ny = Math.sin(a) * 3, nz = Math.cos(b) * 3, nw = Math.sin(b) * 3;
    const n1 = fbm(nx + nz * 1.7 + 10, ny + nw * 1.3, 4);
    const n2 = vnoise(nx * 6 + nz * 5, ny * 6 + nw * 5);
    data[i] = Math.min(255, (n1 * 0.6 + n2 * 0.4) * 255);
    data[i + 1] = Math.min(255, n1 * 255);
    data[i + 2] = Math.min(255, n2 * 255);
    data[i + 3] = 255;
  }
  const tex = new THREE.DataTexture(data, s, s, THREE.RGBAFormat);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.anisotropy = 8;
  tex.needsUpdate = true;
  return tex;
}

/** Height map texture of the whole world, used by the grass shader. */
export function heightTexture(size = 512) {
  const data = new Uint16Array(size * size);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const wx = (x / (size - 1) - 0.5) * WORLD, wz = (y / (size - 1) - 0.5) * WORLD;
    data[y * size + x] = THREE.DataUtils.toHalfFloat(heightAt(wx, wz));
  }
  const t = new THREE.DataTexture(data, size, size, THREE.RedFormat, THREE.HalfFloatType);
  t.magFilter = THREE.LinearFilter; t.minFilter = THREE.LinearFilter;
  t.needsUpdate = true;
  return t;
}
