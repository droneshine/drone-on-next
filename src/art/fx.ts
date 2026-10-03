import * as THREE from 'three';
import type { RingKind, TierId } from './contracts';
import { ParticlePool, SHAPE } from './particles';
import { BRAND, shared, GLSL_IRONBOW, GLSL_NOISE } from './kit';
import { heightAt } from '../world/terrain';

// Combat and juice VFX. Everything that can be a GPU particle is one (two pools, two draw calls);
// meshes only where a particle cannot do it: water streams, EMP shells, the charge orb, boost
// ribbons. Every pool has a fixed size chosen for 50 drones (ART.md 6), nothing is allocated per
// frame, and far away effects spend fewer particles (detail falls off beyond 120 m and 250 m).
//
// Timings (ART.md 4): hit flash 90 ms, impact sparks 0.25 to 0.45 s, ring taken 0.35 s,
// EMP charge 0.35 s then burst 0.4 s (NOVA 0.5 s), evolve 0.8 s with the burst at 0.3 s,
// knockout 1.2 s, boost trail 0.35 s.

export const FX_BUDGET = { sparks: 8192, puffs: 2048, jets: 16, shells: 12, charges: 12, trails: 24 } as const;

/** every colour an effect uses, linear and HDR, built once */
const K = (hex: string, k: number) => new THREE.Color(hex).multiplyScalar(k);
const PAL = {
  light2: K(BRAND.light, 2), light2_5: K(BRAND.light, 2.5), light3: K(BRAND.light, 3), light3_5: K(BRAND.light, 3.5),
  light4: K(BRAND.light, 4), light5: K(BRAND.light, 5), light6: K(BRAND.light, 6), light7: K(BRAND.light, 7),
  off3: K(BRAND.off, 3), off4: K(BRAND.off, 4), off5: K(BRAND.off, 5), off7: K(BRAND.off, 7), off9: K(BRAND.off, 9), off10: K(BRAND.off, 10),
  blue2_5: K(BRAND.blue, 2.5), blue3: K(BRAND.blue, 3), blue5: K(BRAND.blue, 5), blue6: K(BRAND.blue, 6), blue7: K(BRAND.blue, 7),
  dust: new THREE.Color('#8a8578'), smoke: new THREE.Color('#25292a'), debris: new THREE.Color('#141615'),
  mist: new THREE.Color('#e9f3fb'), drop: new THREE.Color('#f2f8fd'), ground: new THREE.Color('#9a9585'),
};
const TINT: Record<string, { c2_5: THREE.Color; c3_5: THREE.Color; c5: THREE.Color; c8: THREE.Color; c1_2: THREE.Color }> = {};
for (const hex of [BRAND.light, BRAND.blue, BRAND.off]) TINT[hex] = { c2_5: K(hex, 2.5), c3_5: K(hex, 3.5), c5: K(hex, 5), c8: K(hex, 8), c1_2: K(hex, 1.2) };
const RING_TINT: Record<RingKind, string> = { shine: BRAND.light, bigshine: BRAND.light, charge: BRAND.blue, repair: BRAND.off };
const TIER_TINT: Record<TierId, string> = { spark: BRAND.light, bolt: BRAND.blue, storm: BRAND.light, nova: BRAND.off };

const _v = new THREE.Vector3(), _w = new THREE.Vector3(), _u = new THREE.Vector3(), _a = new THREE.Vector3(), _b = new THREE.Vector3();
const _q = new THREE.Quaternion();
const rnd = (a: number, b: number) => a + Math.random() * (b - a);
function randomDir(out: THREE.Vector3) {
  const u = Math.random() * 2 - 1, t = Math.random() * Math.PI * 2, s = Math.sqrt(1 - u * u);
  return out.set(s * Math.cos(t), u, s * Math.sin(t));
}

// ------------------------------------------------------------------ water jet

const JET_SEG = 40;
const JET_VERT = /* glsl */`
uniform vec3 uFrom; uniform vec3 uDir; uniform float uRange; uniform float uStart; uniform float uEnd; uniform float uDroop;
varying vec2 vUv;
vec3 pathAt(float u){ return uFrom + uDir * uRange * u + vec3(0.0, -uDroop * u * u, 0.0); }
void main(){
  float u = mix(uStart, uEnd, position.x);
  vec3 p = pathAt(u);
  vec3 tng = normalize(pathAt(u + 0.01) - p);
  vec3 side = normalize(cross(tng, normalize(cameraPosition - p)));
  float w = mix(0.03, 0.42, pow(u, 0.8));
  p += side * position.y * w;
  vUv = vec2(u, position.y);
  gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
}`;
const JET_FRAG = /* glsl */`
uniform float uTime; uniform float uRange; uniform float uSeed; uniform float uThermal;
varying vec2 vUv;
${GLSL_NOISE}
${GLSL_IRONBOW}
void main(){
  float u = vUv.x, v = vUv.y, av = abs(v);
  float core = exp(-av * av * 6.0);
  // two layers of streaks racing down the stream
  float flowA = vnoise(vec2(u * uRange * 0.9 - uTime * 30.0, v * 3.0 + uSeed));
  float flowB = vnoise(vec2(u * uRange * 2.7 - uTime * 44.0, v * 7.0 - uSeed));
  float n = flowA * 0.6 + flowB * 0.4;
  // solid at the nozzle, breaking into droplets toward the end and at the edges
  float th = smoothstep(0.4, 1.0, u) * 0.68 + av * 0.32;
  float keep = smoothstep(th - 0.07, th + 0.07, n);
  float a = keep * (0.35 + 0.65 * core) * (1.0 - smoothstep(0.88, 1.0, u)) * smoothstep(0.0, 0.025, u);
  a *= 1.0 - smoothstep(0.72, 1.0, av);
  if (a < 0.01) discard;
  float glint = smoothstep(0.8, 0.95, flowB) * core;
  vec3 col = mix(vec3(0.45, 0.66, 0.9), vec3(0.96, 0.99, 1.0), core * 0.8 + flowA * 0.2) * 1.15 + glint * 1.4;
  if (uThermal > 0.5) col = ironbow(0.16 + core * 0.06);
  gl_FragColor = vec4(col * a, a);
}`;

interface Jet { mesh: THREE.Mesh; mat: THREE.ShaderMaterial; owner: string | null; on: boolean; idle: boolean; start: number; end: number; seen: number; from: THREE.Vector3; dir: THREE.Vector3; range: number; }

// ------------------------------------------------------------------ shells (EMP, NOVA BURST, evolve)

const SHELL_VERT = /* glsl */`
varying vec3 vN; varying vec3 vWP; varying vec3 vLP;
void main(){ vLP = position; vec4 w = modelMatrix * vec4(position, 1.0); vWP = w.xyz; vN = normalize(mat3(modelMatrix) * normal); gl_Position = projectionMatrix * viewMatrix * w; }`;
const SHELL_FRAG = /* glsl */`
uniform vec3 uColor; uniform vec3 uColor2; uniform float uAlpha; uniform float uTime; uniform float uThermal; uniform float uSeed;
varying vec3 vN; varying vec3 vWP; varying vec3 vLP;
${GLSL_NOISE}
${GLSL_IRONBOW}
void main(){
  vec3 V = normalize(cameraPosition - vWP);
  float f = 1.0 - abs(dot(V, normalize(vN)));
  // a shockwave front: almost all of the light sits on the silhouette
  float rim = pow(f, 3.2);
  vec3 n = normalize(vLP);
  // electric crackle that lives only near the rim
  vec2 q = vec2(atan(n.z, n.x) * 4.0, n.y * 4.0) + uSeed;
  float crack = smoothstep(0.07, 0.0, abs(vnoise(q * 2.6 + uTime * 9.0) - 0.5)) * smoothstep(0.35, 0.9, f);
  // three faint latitude lines give the sphere its shape without filling it
  float lat = smoothstep(0.035, 0.0, abs(fract(asin(clamp(n.y, -1.0, 1.0)) * 1.2732 + 0.5) - 0.5)) * (1.0 - f) * 0.35;
  float a = (rim * 1.25 + crack * 0.9 + lat) * uAlpha;
  if (a < 0.003) discard;
  vec3 col = mix(uColor2, uColor, clamp(rim * 1.4 + crack, 0.0, 1.0)) * a;
  if (uThermal > 0.5) col = ironbow(0.9) * a * 2.0;
  gl_FragColor = vec4(col, 1.0);
}`;

interface Shell { mesh: THREE.Mesh; mat: THREE.ShaderMaterial; busy: boolean; since: number; }

// ------------------------------------------------------------------ charge orb (billboard)

const ORB_VERT = /* glsl */`
varying vec2 vUv;
void main(){ vUv = position.xy; gl_Position = projectionMatrix * (modelViewMatrix * vec4(0.0, 0.0, 0.0, 1.0) + vec4(position.xy * length(modelMatrix[0].xyz), 0.0, 0.0)); }`;
const ORB_FRAG = /* glsl */`
uniform vec3 uColor; uniform float uP; uniform float uTime; uniform float uThermal;
varying vec2 vUv;
${GLSL_NOISE}
${GLSL_IRONBOW}
void main(){
  float r = length(vUv);
  float ang = atan(vUv.y, vUv.x);
  float core = exp(-r * r * mix(60.0, 14.0, uP)) * (0.6 + uP * 2.5);
  // collapsing ring: starts wide, closes on the core as the charge completes
  float ringR = mix(0.95, 0.12, uP);
  float ring = exp(-pow((r - ringR) / 0.035, 2.0)) * (0.4 + uP);
  float arcs = smoothstep(0.06, 0.0, abs(vnoise(vec2(ang * 3.0, r * 6.0 - uTime * 9.0)) - 0.5)) * step(r, ringR) * 0.8;
  float a = core + ring + arcs * uP;
  if (a < 0.003) discard;
  vec3 col = uColor * a;
  if (uThermal > 0.5) col = ironbow(0.95) * a * 1.5;
  gl_FragColor = vec4(col, 1.0);
}`;

interface Charge { mesh: THREE.Mesh; mat: THREE.ShaderMaterial; t: number; nova: boolean; busy: boolean; pos: THREE.Vector3; }
interface Burst { shell: Shell; inner: Shell | null; t: number; dur: number; radius: number; pos: THREE.Vector3; }

// ------------------------------------------------------------------ boost ribbon

const TRAIL_N = 28;
const TRAIL_LIFE = 0.35;
interface Trail { root: THREE.Object3D | null; on: boolean; pts: THREE.Vector3[]; ts: Float32Array; head: number; count: number; mesh: THREE.Mesh; pos: Float32Array; alpha: Float32Array; width: number; }

// ------------------------------------------------------------------ evolve

interface Evolve { root: THREE.Object3D; tier: TierId; t: number; shell: Shell; radius: number; burst: boolean; mats: Set<THREE.MeshStandardMaterial>; last: THREE.Vector3; }

export class Effects {
  readonly sparks: ParticlePool;
  readonly puffs: ParticlePool;
  private group: THREE.Group;
  private jetGeo: THREE.BufferGeometry;
  private jets: Jet[] = [];
  private shellGeo: THREE.BufferGeometry;
  private shells: Shell[] = [];
  private orbGeo: THREE.BufferGeometry;
  private charges: Charge[] = [];
  private bursts: Burst[] = [];
  private trails: Trail[] = [];
  private evolves: Evolve[] = [];
  private camera: THREE.Camera | null = null;
  private camPos = new THREE.Vector3(0, 1e6, 0);

  constructor(parent: THREE.Object3D) {
    this.group = new THREE.Group();
    this.group.name = 'royale-fx';
    parent.add(this.group);
    this.sparks = new ParticlePool(FX_BUDGET.sparks, false);
    this.puffs = new ParticlePool(FX_BUDGET.puffs, true);
    this.group.add(this.puffs.mesh, this.sparks.mesh);
    const p: number[] = [], idx: number[] = [];
    for (let i = 0; i <= JET_SEG; i++) { const u = i / JET_SEG; p.push(u, -1, 0, u, 1, 0); }
    for (let i = 0; i < JET_SEG; i++) { const a = i * 2; idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3); }
    this.jetGeo = new THREE.BufferGeometry();
    this.jetGeo.setAttribute('position', new THREE.Float32BufferAttribute(p, 3));
    this.jetGeo.setIndex(idx);
    this.shellGeo = new THREE.IcosahedronGeometry(1, 3);
    this.orbGeo = new THREE.PlaneGeometry(2, 2);
    // every pool is built up front: a match never allocates an effect mesh mid fight
    for (let i = 0; i < FX_BUDGET.jets; i++) this.jets.push(this.makeJet());
    for (let i = 0; i < FX_BUDGET.shells; i++) this.shells.push(this.makeShell());
    for (let i = 0; i < FX_BUDGET.charges; i++) this.charges.push(this.makeCharge());
    for (let i = 0; i < FX_BUDGET.trails; i++) this.trails.push(this.makeTrail());
  }

  /** 1 near, fewer particles for effects far from the camera nobody can resolve anyway */
  private detail(p: THREE.Vector3) {
    const d = p.distanceTo(this.camPos);
    return d < 120 ? 1 : d < 250 ? 0.5 : 0.25;
  }

  // ---------------------------------------------------------------- PULSE
  muzzle(pos: THREE.Vector3, dir: THREE.Vector3, tier: TierId) {
    const big = tier === 'nova' ? 1.3 : tier === 'storm' ? 1.15 : 1;
    this.sparks.emit({ p: pos, life: 0.06, color: PAL.light5, size: 0.32 * big, size1: 0.12, shape: SHAPE.dot });
    if (this.detail(pos) < 1) return;
    for (let i = 0; i < 2; i++) {
      _v.copy(dir).multiplyScalar(rnd(6, 12)).add(randomDir(_w).multiplyScalar(2.5));
      this.sparks.emit({ p: pos, v: _v, life: rnd(0.06, 0.12), color: PAL.light4, size: 0.025, stretch: 0.02, drag: 8 });
    }
  }

  impact(pos: THREE.Vector3, dir: THREE.Vector3 | null, hitDrone: boolean) {
    const back = _u.copy(dir ?? _w.set(0, -1, 0)).multiplyScalar(-1);
    const det = this.detail(pos);
    if (hitDrone) {
      this.sparks.emit({ p: pos, life: 0.09, color: PAL.off7, size: 0.75, size1: 0.3, shape: SHAPE.star, spin: 4 });
      if (det === 1) this.sparks.emit({ p: pos, life: 0.16, color: PAL.light3, size: 0.3, size1: 1.4, shape: SHAPE.ring });
    } else {
      this.sparks.emit({ p: pos, life: 0.07, color: PAL.light4, size: 0.4, size1: 0.15, shape: SHAPE.dot });
      if (det === 1) this.puffs.emit({ p: pos, v: _v.copy(back).multiplyScalar(0.8).setY(0.6), life: 0.7, color: PAL.dust, alpha: 0.35, size: 0.25, size1: 1.1, shape: SHAPE.dot, drag: 2 });
    }
    const n = Math.round((hitDrone ? 11 : 6) * det);
    for (let i = 0; i < n; i++) {
      _v.copy(back).multiplyScalar(rnd(2, 6)).add(randomDir(_w).multiplyScalar(rnd(2.5, 6)));
      this.sparks.emit({ p: pos, v: _v, life: rnd(0.22, 0.42), color: Math.random() < 0.5 ? PAL.off5 : PAL.light5, size: 0.03, stretch: 0.035, gravity: 0.7, drag: 2.5 });
    }
  }

  // ---------------------------------------------------------------- hit and knockout
  hit(pos: THREE.Vector3, amount: number, local: boolean) {
    const k = THREE.MathUtils.clamp(amount / 10, 0.4, 3);
    this.sparks.emit({ p: pos, life: 0.09, color: local ? PAL.off4 : PAL.off7, size: (local ? 0.45 : 0.7) * Math.sqrt(k), size1: 0.25, shape: SHAPE.star, spin: 3 });
    const n = Math.round(THREE.MathUtils.clamp(4 + amount * 0.8, 4, local ? 10 : 22) * this.detail(pos));
    for (let i = 0; i < n; i++) {
      randomDir(_v).multiplyScalar(rnd(3.5, 9) * (0.7 + k * 0.2));
      _v.y += 1.5;
      this.sparks.emit({ p: pos, v: _v, life: rnd(0.25, 0.45), color: Math.random() < 0.6 ? PAL.off5 : PAL.light5, size: 0.03, stretch: 0.03, gravity: 0.6, drag: 2 });
    }
  }

  knockout(pos: THREE.Vector3) {
    const det = this.detail(pos);
    this.sparks.emit({ p: pos, life: 0.16, color: PAL.off9, size: 2.0, size1: 0.6, shape: SHAPE.star, spin: 2 });
    this.sparks.emit({ p: pos, life: 0.5, color: PAL.light3, size: 0.4, size1: 6, shape: SHAPE.ring });
    this.sparks.emit({ p: pos, life: 0.25, color: PAL.light2, size: 1.5, size1: 3, shape: SHAPE.dot });
    for (let i = 0; i < 36 * det; i++) {
      randomDir(_v).multiplyScalar(rnd(3, 12)); _v.y += 2;
      this.sparks.emit({ p: pos, v: _v, life: rnd(0.5, 1.1), color: Math.random() < 0.5 ? PAL.off5 : PAL.light5, size: 0.035, stretch: 0.03, gravity: 1, drag: 1.2 });
    }
    // the power down: electric fizzles while it falls, then smoke
    for (let i = 0; i < 8 * det; i++) {
      randomDir(_v).multiplyScalar(0.6);
      this.sparks.emit({ p: _w.copy(pos).add(randomDir(_u).multiplyScalar(0.4)), v: _v, life: 0.1, color: PAL.blue6, size: 0.03, stretch: 0.6, delay: rnd(0.05, 0.7) });
    }
    for (let i = 0; i < 9 * det; i++) {
      _v.set(rnd(-0.6, 0.6), rnd(0.8, 2.0), rnd(-0.6, 0.6));
      this.puffs.emit({ p: _w.copy(pos).add(randomDir(_u).multiplyScalar(0.3)), v: _v, life: rnd(1.3, 2.2), color: PAL.smoke, alpha: 0.55, size: 0.5, size1: rnd(2, 3), shape: SHAPE.dot, drag: 0.8, delay: i * 0.03 });
    }
    for (let i = 0; i < 6 * det; i++) {
      randomDir(_v).multiplyScalar(rnd(2, 5)); _v.y += 3;
      this.puffs.emit({ p: pos, v: _v, life: rnd(0.8, 1.2), color: PAL.debris, alpha: 0.9, size: 0.06, shape: SHAPE.dot, gravity: 1, drag: 0.4 });
    }
  }

  // ---------------------------------------------------------------- rings
  ringTaken(pos: THREE.Vector3, kind: RingKind) {
    const T = TINT[RING_TINT[kind]];
    const big = kind === 'bigshine';
    this.sparks.emit({ p: pos, life: 0.35, color: T.c3_5, size: 1.2, size1: big ? 9 : 7, shape: SHAPE.ring });
    this.sparks.emit({ p: pos, life: 0.12, color: big ? T.c8 : T.c5, size: big ? 2.2 : 1.4, size1: 0.4, shape: SHAPE.star, spin: 3 });
    const n = big ? 22 : 14;
    for (let i = 0; i < n; i++) {
      randomDir(_v).multiplyScalar(rnd(4, 9));
      this.sparks.emit({ p: pos, v: _v, life: rnd(0.25, 0.45), color: T.c5, size: 0.04, stretch: 0.03, drag: 3 });
    }
    if (kind === 'shine' || kind === 'bigshine') {
      for (let i = 0; i < (big ? 10 : 5); i++) {
        randomDir(_v).multiplyScalar(rnd(1, 3)); _v.y += 1.2;
        this.sparks.emit({ p: pos, v: _v, life: rnd(0.45, 0.8), color: PAL.light6, size: rnd(0.25, 0.45), size1: 0.05, shape: SHAPE.star, spin: rnd(-4, 4), drag: 2.5 });
      }
    } else if (kind === 'repair') {
      for (let i = 0; i < 8; i++) {
        _v.set(rnd(-1, 1), rnd(1, 2.5), rnd(-1, 1));
        this.sparks.emit({ p: _w.copy(pos).add(randomDir(_u).multiplyScalar(1.2)), v: _v, life: rnd(0.5, 0.8), color: PAL.off3, size: 0.3, size1: 0.05, shape: SHAPE.dot, drag: 2 });
      }
    } else {
      for (let i = 0; i < 10; i++) {
        randomDir(_v).multiplyScalar(0.4);
        this.sparks.emit({ p: _w.copy(pos).add(randomDir(_u).multiplyScalar(rnd(0.5, 2.5))), v: _v, life: 0.09, color: PAL.blue6, size: 0.03, stretch: 1.2, delay: rnd(0, 0.25) });
      }
    }
  }

  // ---------------------------------------------------------------- water
  private makeJet(): Jet {
    const mat = new THREE.ShaderMaterial({
      vertexShader: JET_VERT, fragmentShader: JET_FRAG,
      uniforms: {
        uFrom: { value: new THREE.Vector3() }, uDir: { value: new THREE.Vector3(0, 0, -1) }, uRange: { value: 22 },
        uStart: { value: 0 }, uEnd: { value: 0 }, uDroop: { value: 0.6 }, uSeed: { value: Math.random() * 50 },
        uTime: shared.time, uThermal: shared.thermal,
      },
      transparent: true, depthWrite: false, premultipliedAlpha: true, side: THREE.DoubleSide,
    });
    const mesh = new THREE.Mesh(this.jetGeo, mat);
    mesh.frustumCulled = false; mesh.renderOrder = 5; mesh.userData.noThermal = true; mesh.visible = false;
    this.group.add(mesh);
    return { mesh, mat, owner: null, on: false, idle: true, start: 0, end: 0, seen: 0, from: new THREE.Vector3(), dir: new THREE.Vector3(0, 0, -1), range: 22 };
  }

  waterJet(owner: string, from: THREE.Vector3, dir: THREE.Vector3, range: number, on: boolean) {
    let j = this.jets.find(x => x.owner === owner);
    if (!j) {
      if (!on) return;
      j = this.jets.find(x => x.idle);
      if (!j) {
        // all 16 streams busy: the one farthest from the camera gives way, if this one is closer
        let far = -1;
        for (const x of this.jets) { const d = x.from.distanceToSquared(this.camPos); if (d > far) { far = d; j = x; } }
        if (!j || from.distanceToSquared(this.camPos) >= far) return;
      }
      j.owner = owner; j.idle = true;
    }
    if (on && (j.idle || !j.on)) {
      // a fresh stream shoots out of the nozzle; one already detaching starts again from the nozzle
      if (j.idle) { j.start = 0; j.end = 0; }
      else j.start = 0;
      j.idle = false;
    }
    j.on = on;
    j.seen = shared.time.value;
    j.from.copy(from); j.dir.copy(dir).normalize(); j.range = Math.max(0.5, range);
  }

  private updateJets(dt: number) {
    const now = shared.time.value;
    for (const j of this.jets) {
      // a caller that stops calling has stopped spraying
      if (j.on && now - j.seen > 0.2) j.on = false;
      if (j.idle) continue;
      if (j.on) {
        j.end = Math.min(1, j.end + dt / 0.14);
        j.start = Math.max(0, j.start - dt / 0.1);
      } else {
        j.start = Math.min(1, j.start + dt / 0.22);
        j.end = Math.min(1, j.end + dt / 0.14);
        if (j.start >= 0.999) { j.idle = true; j.owner = null; j.mesh.visible = false; continue; }
      }
      const u = j.mat.uniforms;
      u.uFrom.value.copy(j.from); u.uDir.value.copy(j.dir); u.uRange.value = j.range;
      u.uStart.value = j.start; u.uEnd.value = j.end; u.uDroop.value = j.range * 0.028;
      j.mesh.visible = true;
      const det = this.detail(j.from);
      // mist along the stream and a splash where it ends
      if (Math.random() < 0.7 * det) {
        const t = rnd(Math.max(j.start, 0.2), j.end);
        _v.copy(j.from).addScaledVector(j.dir, j.range * t); _v.y -= u.uDroop.value * t * t;
        _w.copy(j.dir).multiplyScalar(rnd(2, 5)).add(randomDir(_u).multiplyScalar(0.8));
        this.puffs.emit({ p: _v, v: _w, life: rnd(0.4, 0.7), color: PAL.mist, alpha: 0.22, size: 0.25, size1: rnd(0.8, 1.4), shape: SHAPE.dot, drag: 2.5 });
      }
      if (j.on && j.end > 0.95 && det === 1) {
        _v.copy(j.from).addScaledVector(j.dir, j.range); _v.y -= u.uDroop.value;
        for (let i = 0; i < 2; i++) {
          _w.copy(j.dir).multiplyScalar(rnd(1, 4)).add(randomDir(_u).multiplyScalar(rnd(1.5, 3.5))); _w.y += 1;
          this.puffs.emit({ p: _v, v: _w, life: rnd(0.35, 0.6), color: PAL.drop, alpha: 0.6, size: rnd(0.04, 0.08), shape: SHAPE.dot, gravity: 1, drag: 0.5 });
        }
      }
    }
  }

  // ---------------------------------------------------------------- EMP and NOVA BURST
  private makeShell(): Shell {
    const mat = new THREE.ShaderMaterial({
      vertexShader: SHELL_VERT, fragmentShader: SHELL_FRAG,
      uniforms: { uColor: { value: new THREE.Color() }, uColor2: { value: new THREE.Color() }, uAlpha: { value: 0 }, uTime: shared.time, uThermal: shared.thermal, uSeed: { value: 0 } },
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
    });
    const mesh = new THREE.Mesh(this.shellGeo, mat);
    mesh.renderOrder = 6; mesh.userData.noThermal = true; mesh.frustumCulled = false; mesh.visible = false;
    this.group.add(mesh);
    return { mesh, mat, busy: false, since: 0 };
  }

  private shell(): Shell {
    let s = this.shells.find(x => !x.busy);
    if (!s) {
      // all busy: the oldest one is cut short (its owner simply ends early)
      const old = this.shells.reduce((a, b) => (a.since < b.since ? a : b));
      const free = (x: Shell | null) => { if (x && x !== old) { x.busy = false; x.mesh.visible = false; } };
      this.bursts = this.bursts.filter(b => { if (b.shell !== old && b.inner !== old) return true; free(b.shell); free(b.inner); return false; });
      this.evolves = this.evolves.filter(e => { if (e.shell !== old) return true; for (const m of e.mats) m.emissiveIntensity = 0; return false; });
      s = old;
    }
    s.busy = true; s.since = shared.time.value;
    s.mesh.visible = true;
    s.mat.uniforms.uSeed.value = Math.random() * 40;
    return s;
  }

  private makeCharge(): Charge {
    const mat = new THREE.ShaderMaterial({
      vertexShader: ORB_VERT, fragmentShader: ORB_FRAG,
      uniforms: { uColor: { value: new THREE.Color() }, uP: { value: 0 }, uTime: shared.time, uThermal: shared.thermal },
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    });
    const mesh = new THREE.Mesh(this.orbGeo, mat);
    mesh.renderOrder = 7; mesh.frustumCulled = false; mesh.userData.noThermal = true; mesh.visible = false;
    this.group.add(mesh);
    return { mesh, mat, t: 0, nova: false, busy: false, pos: new THREE.Vector3() };
  }

  emp(pos: THREE.Vector3, radius: number, nova: boolean, phase: 'charge' | 'burst') {
    if (phase === 'charge') {
      // a repeated charge call close to a live charge moves it with the drone
      const live = this.charges.find(c => c.busy && c.nova === nova && c.t < 0.5 && c.pos.distanceTo(pos) < 10);
      if (live) { live.pos.copy(pos); return; }
      const c = this.charges.find(x => !x.busy) ?? this.charges.reduce((a, b) => (a.t > b.t ? a : b));
      c.busy = true; c.t = 0; c.nova = nova; c.pos.copy(pos);
      c.mat.uniforms.uColor.value.copy(nova ? PAL.light3 : PAL.blue3);
      c.mesh.scale.setScalar(nova ? 3.4 : 2.6);
      c.mesh.position.copy(pos);
      c.mesh.visible = true;
      // energy pulled in from all around
      const n = Math.round((nova ? 36 : 24) * this.detail(pos));
      for (let i = 0; i < n; i++) {
        const d = randomDir(_u).multiplyScalar(rnd(2.5, nova ? 5 : 4));
        const life = rnd(0.25, 0.35);
        this.sparks.emit({ p: _w.copy(pos).add(d), v: _v.copy(d).multiplyScalar(-1 / life), life, color: i % 3 ? (nova ? PAL.light5 : PAL.blue5) : PAL.off5, size: 0.03, stretch: 0.05, drag: 0.001 });
      }
      return;
    }
    // burst: the charge collapses into the shockwave
    for (const c of this.charges) if (c.busy && c.nova === nova && c.pos.distanceTo(pos) < 12) { c.busy = false; c.mesh.visible = false; }
    const shell = this.shell();
    shell.mat.uniforms.uColor.value.copy(nova ? TINT[BRAND.light].c2_5 : TINT[BRAND.blue].c2_5);
    shell.mat.uniforms.uColor2.value.copy(nova ? TINT[BRAND.light].c1_2 : TINT[BRAND.blue].c1_2);
    const inner = nova ? this.shell() : null;
    if (inner) { inner.mat.uniforms.uColor.value.copy(TINT[BRAND.off].c2_5); inner.mat.uniforms.uColor2.value.copy(TINT[BRAND.blue].c1_2); }
    this.bursts.push({ shell, inner, t: 0, dur: nova ? 0.5 : 0.4, radius, pos: new THREE.Vector3().copy(pos) });
    const det = this.detail(pos);
    this.sparks.emit({ p: pos, life: 0.14, color: PAL.off10, size: nova ? 3.5 : 2.6, size1: 1, shape: SHAPE.star, spin: 2 });
    this.sparks.emit({ p: pos, life: 0.3, color: nova ? PAL.light2_5 : PAL.blue2_5, size: 2, size1: radius * 0.6, shape: SHAPE.dot });
    // ground shock where the burst reaches the terrain
    const gy = heightAt(pos.x, pos.z);
    if (pos.y - gy < radius && det === 1) {
      const gr = Math.sqrt(Math.max(0, radius * radius - (pos.y - gy) ** 2));
      const m = nova ? 28 : 18;
      for (let i = 0; i < m; i++) {
        const a = i / m * Math.PI * 2;
        _w.set(pos.x + Math.cos(a) * 0.5, gy + 0.2, pos.z + Math.sin(a) * 0.5);
        _v.set(Math.cos(a), 0, Math.sin(a)).multiplyScalar(gr / 0.45);
        this.puffs.emit({ p: _w, v: _v, life: 0.55, color: PAL.ground, alpha: 0.35, size: 0.6, size1: 2.4, shape: SHAPE.dot, drag: 2.2 });
      }
    }
    // lightning: jagged arcs out to the edge of the radius, drawn as chains of short streaks
    const arcs = Math.round((nova ? 10 : 7) * det);
    for (let a = 0; a < arcs; a++) {
      randomDir(_a);
      _b.copy(pos);
      const steps = 7, reach = radius * rnd(0.55, 0.95);
      for (let s = 0; s < steps; s++) {
        _w.copy(_b).addScaledVector(_a, reach / steps).add(randomDir(_u).multiplyScalar(reach / steps * 0.45));
        _v.subVectors(_w, _b);
        const len = _v.length();
        _v.multiplyScalar(0.05 / Math.max(len, 1e-4));
        this.sparks.emit({ p: _w, v: _v, life: rnd(0.12, 0.22), color: nova && a % 2 ? PAL.light7 : PAL.blue7, size: 0.05, stretch: len / 0.05, delay: s * 0.012 + rnd(0, 0.05) });
        _b.copy(_w);
      }
    }
    for (let i = 0; i < (nova ? 40 : 24) * det; i++) {
      randomDir(_v).multiplyScalar(rnd(radius * 0.8, radius * 1.6));
      this.sparks.emit({ p: pos, v: _v, life: rnd(0.3, 0.5), color: nova ? PAL.light5 : PAL.blue5, size: 0.05, stretch: 0.025, drag: 3 });
    }
    if (nova && det === 1) for (let i = 0; i < 10; i++) {
      randomDir(_v).multiplyScalar(rnd(3, 7));
      this.sparks.emit({ p: pos, v: _v, life: rnd(0.5, 0.8), color: PAL.light6, size: rnd(0.4, 0.7), size1: 0.1, shape: SHAPE.star, spin: rnd(-3, 3), drag: 2 });
    }
  }

  private updateEmp(dt: number, camera: THREE.Camera) {
    for (const c of this.charges) {
      if (!c.busy) continue;
      c.t += dt;
      c.mat.uniforms.uP.value = Math.min(1, c.t / 0.35);
      c.mesh.position.copy(c.pos);
      c.mesh.quaternion.copy(camera.quaternion);
      // the charge holds at full until the burst arrives, then gives up after a short grace
      if (c.t > 0.7) { c.busy = false; c.mesh.visible = false; }
    }
    for (let i = this.bursts.length - 1; i >= 0; i--) {
      const b = this.bursts[i];
      b.t += dt;
      const p = Math.min(1, b.t / b.dur);
      const e = 1 - Math.pow(1 - p, 3);
      b.shell.mesh.position.copy(b.pos);
      b.shell.mesh.scale.setScalar(0.3 + (b.radius - 0.3) * e);
      b.shell.mat.uniforms.uAlpha.value = Math.pow(1 - p, 1.4) * 1.1;
      if (b.inner) {
        const pi = Math.min(1, b.t / (b.dur * 0.6));
        b.inner.mesh.position.copy(b.pos);
        b.inner.mesh.scale.setScalar(0.3 + b.radius * 0.55 * (1 - Math.pow(1 - pi, 2)));
        b.inner.mat.uniforms.uAlpha.value = Math.pow(1 - pi, 1.8) * 1.2;
      }
      if (p >= 1) {
        b.shell.busy = false; b.shell.mesh.visible = false;
        if (b.inner) { b.inner.busy = false; b.inner.mesh.visible = false; }
        this.bursts.splice(i, 1);
      }
    }
  }

  // ---------------------------------------------------------------- evolve
  evolve(root: THREE.Object3D, tier: TierId) {
    const box = new THREE.Box3().setFromObject(root);
    const radius = box.isEmpty() ? 0.6 : Math.max(0.35, box.getSize(_v).length() * 0.5);
    const mats = new Set<THREE.MeshStandardMaterial>();
    // a second evolve on the same drone replaces the first
    this.evolves = this.evolves.filter(e => { if (e.root !== root) return true; e.shell.busy = false; e.shell.mesh.visible = false; return false; });
    const shell = this.shell();
    shell.mat.uniforms.uColor.value.copy(TINT[BRAND.light].c2_5);
    shell.mat.uniforms.uColor2.value.copy(TINT[TIER_TINT[tier]].c1_2);
    const last = root.getWorldPosition(new THREE.Vector3());
    this.evolves.push({ root, tier, t: 0, shell, radius, burst: false, mats, last });
    // gather: sparks drawn in toward the drone before the burst
    for (let i = 0; i < 18; i++) {
      const d = randomDir(_u).multiplyScalar(rnd(1.6, 2.6) * Math.max(1, radius * 1.4));
      this.sparks.emit({ p: _w.copy(last).add(d), v: _v.copy(d).multiplyScalar(-1 / 0.3), life: 0.3, color: PAL.light5, size: 0.035, stretch: 0.04, drag: 0.001 });
    }
  }

  private updateEvolve(dt: number) {
    for (let i = this.evolves.length - 1; i >= 0; i--) {
      const e = this.evolves[i];
      e.t += dt;
      const t = e.t;
      if (e.root.parent) e.root.getWorldPosition(e.last);
      // body glow: up in 0.15 s, hold through the swap, gone by 0.8 s. The root is scanned every
      // frame, so a model swapped in under the same root mid evolve glows too.
      const g = t < 0.15 ? t / 0.15 : t < 0.45 ? 1 : Math.max(0, 1 - (t - 0.45) / 0.35);
      e.root.traverse(o => {
        const m = (o as THREE.Mesh).material as THREE.MeshStandardMaterial | undefined;
        if (m && !Array.isArray(m) && m.userData?.tierPaint) e.mats.add(m);
      });
      for (const m of e.mats) { m.emissive.set(BRAND.light); m.emissiveIntensity = g * 1.8; }
      e.shell.mesh.position.copy(e.last);
      e.shell.mesh.scale.setScalar(e.radius * (1.05 + (t > 0.3 ? (t - 0.3) * 0.9 : 0)));
      e.shell.mat.uniforms.uAlpha.value = g * 0.9;
      if (!e.burst && t >= 0.3) {
        e.burst = true;
        const p = e.last, T = TINT[TIER_TINT[e.tier]];
        this.sparks.emit({ p, life: 0.13, color: PAL.off7, size: 1.1 + e.radius * 1.6, size1: 0.5, shape: SHAPE.star, spin: 1.5 });
        this.sparks.emit({ p, life: 0.5, color: PAL.light3_5, size: 0.6, size1: 6.5, shape: SHAPE.ring });
        this.sparks.emit({ p, life: 0.42, color: T.c2_5, size: 0.4, size1: 4.2, shape: SHAPE.ring, delay: 0.06 });
        for (let k = 0; k < 28; k++) {
          randomDir(_v).multiplyScalar(rnd(5, 11));
          this.sparks.emit({ p, v: _v, life: rnd(0.35, 0.6), color: k % 3 ? PAL.light5 : T.c5, size: 0.04, stretch: 0.03, drag: 2.6 });
        }
        for (let k = 0; k < 12; k++) {
          randomDir(_v).multiplyScalar(rnd(1.5, 4)); _v.y = Math.abs(_v.y) + 0.8;
          this.sparks.emit({ p, v: _v, life: rnd(0.55, 0.9), color: PAL.light6, size: rnd(0.25, 0.5), size1: 0.06, shape: SHAPE.star, spin: rnd(-4, 4), drag: 2 });
        }
        // a short column of light: the moment reads from far away
        for (let k = 0; k < 6; k++) {
          this.sparks.emit({ p: _w.copy(p).add(_u.set(rnd(-0.2, 0.2), 0, rnd(-0.2, 0.2))), v: _v.set(0, rnd(14, 22), 0), life: 0.35, color: PAL.light5, size: 0.08, stretch: 0.06, drag: 3 });
        }
      }
      if (t >= 0.8) {
        for (const m of e.mats) { m.emissiveIntensity = 0; m.emissive.setRGB(0, 0, 0); }
        e.shell.busy = false; e.shell.mesh.visible = false;
        this.evolves.splice(i, 1);
      }
    }
  }

  // ---------------------------------------------------------------- boost
  private makeTrail(): Trail {
    const pos = new Float32Array(TRAIL_N * 2 * 3), alpha = new Float32Array(TRAIL_N * 2), side = new Float32Array(TRAIL_N * 2);
    for (let i = 0; i < TRAIL_N; i++) { side[i * 2] = -1; side[i * 2 + 1] = 1; }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('aA', new THREE.BufferAttribute(alpha, 1).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('aS', new THREE.BufferAttribute(side, 1));
    const idx: number[] = [];
    for (let i = 0; i < TRAIL_N - 1; i++) { const a = i * 2; idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3); }
    g.setIndex(idx);
    const m = new THREE.ShaderMaterial({
      vertexShader: 'attribute float aA; attribute float aS; varying float vA; varying float vS; void main(){ vA = aA; vS = aS; gl_Position = projectionMatrix * viewMatrix * vec4(position, 1.0); }',
      fragmentShader: `uniform vec3 uColor; uniform float uThermal; varying float vA; varying float vS; ${GLSL_IRONBOW}
        void main(){ float e = 1.0 - vS * vS; float a = vA * e; vec3 c = uThermal > 0.5 ? ironbow(0.9) : mix(uColor, vec3(2.4), pow(e, 6.0) * 0.6); gl_FragColor = vec4(c * a, 1.0); }`,
      uniforms: { uColor: { value: PAL.light2.clone().multiplyScalar(1.1) }, uThermal: shared.thermal },
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
    });
    const mesh = new THREE.Mesh(g, m);
    mesh.frustumCulled = false; mesh.renderOrder = 6; mesh.userData.noThermal = true; mesh.visible = false;
    this.group.add(mesh);
    return { root: null, on: false, pts: Array.from({ length: TRAIL_N }, () => new THREE.Vector3()), ts: new Float32Array(TRAIL_N), head: 0, count: 0, mesh, pos, alpha, width: 0.5 };
  }

  boost(root: THREE.Object3D, on: boolean) {
    let tr = this.trails.find(x => x.root === root);
    if (!tr) {
      if (!on) return;
      tr = this.trails.find(x => !x.root);
      if (!tr) return;   // 24 drones already boosting: the trail is skipped, the drone still boosts
      const box = new THREE.Box3().setFromObject(root);
      const span = box.isEmpty() ? 0.6 : Math.max(box.max.x - box.min.x, box.max.z - box.min.z);
      tr.root = root; tr.count = 0; tr.head = 0; tr.on = false;
      tr.width = Math.max(0.25, span * 0.55);
    }
    if (on && !tr.on) {
      // the kick: a ring blown off the back of the drone
      root.getWorldPosition(_a);
      this.sparks.emit({ p: _a, life: 0.25, color: PAL.light3, size: tr.width * 0.6, size1: tr.width * 4.5, shape: SHAPE.ring });
      root.getWorldQuaternion(_q);
      const back = _u.set(0, 0, 1).applyQuaternion(_q);
      for (let i = 0; i < 10; i++) {
        _v.copy(back).multiplyScalar(rnd(5, 10)).add(randomDir(_w).multiplyScalar(2));
        this.sparks.emit({ p: _a, v: _v, life: rnd(0.15, 0.3), color: PAL.light5, size: 0.03, stretch: 0.03, drag: 4 });
      }
    }
    tr.on = on;
  }

  private updateTrails(dt: number) {
    const now = shared.time.value;
    const cam = this.camera;
    for (const tr of this.trails) {
      if (!tr.root) continue;
      if (tr.on && tr.root.parent && dt > 0) {
        tr.head = (tr.head + TRAIL_N - 1) % TRAIL_N;
        tr.root.getWorldPosition(tr.pts[tr.head]);
        tr.ts[tr.head] = now;
        tr.count = Math.min(TRAIL_N, tr.count + 1);
      }
      while (tr.count && now - tr.ts[(tr.head + tr.count - 1) % TRAIL_N] > TRAIL_LIFE) tr.count--;
      if (!tr.count && !tr.on) { tr.root = null; tr.mesh.visible = false; continue; }
      tr.mesh.visible = tr.count > 1;
      if (tr.count < 2 || !cam) continue;
      const P = tr.pos, A = tr.alpha;
      const at = (k: number) => tr.pts[(tr.head + Math.max(0, Math.min(tr.count - 1, k))) % TRAIL_N];
      for (let i = 0; i < TRAIL_N; i++) {
        const k = Math.min(i, tr.count - 1);
        const a = at(k);
        _v.subVectors(at(k - 1), at(k + 1)); if (_v.lengthSq() < 1e-8) _v.set(0, 0, 1);
        _w.subVectors(cam.position, a);
        _u.crossVectors(_v, _w).normalize();
        const age = (now - tr.ts[(tr.head + k) % TRAIL_N]) / TRAIL_LIFE;
        const w = tr.width * (1 - age * 0.6) * 0.5;
        const alpha = i < tr.count ? Math.max(0, 1 - age) * (i === 0 ? 0.3 : 1) * 0.8 : 0;
        const o = i * 6;
        P[o] = a.x + _u.x * w; P[o + 1] = a.y + _u.y * w; P[o + 2] = a.z + _u.z * w;
        P[o + 3] = a.x - _u.x * w; P[o + 4] = a.y - _u.y * w; P[o + 5] = a.z - _u.z * w;
        A[i * 2] = A[i * 2 + 1] = alpha;
      }
      tr.mesh.geometry.attributes.position.needsUpdate = true;
      tr.mesh.geometry.attributes.aA.needsUpdate = true;
      // a few sparks shed from the tail while boosting
      if (tr.on && Math.random() < 0.5 * this.detail(at(0))) {
        this.sparks.emit({ p: at(0), v: randomDir(_v).multiplyScalar(1.2), life: 0.25, color: PAL.light4, size: 0.025, stretch: 0.05, drag: 2 });
      }
    }
  }

  update(dt: number, camera: THREE.Camera) {
    this.camera = camera;
    camera.getWorldPosition(this.camPos);
    this.updateJets(dt);
    this.updateEmp(dt, camera);
    this.updateEvolve(dt);
    this.updateTrails(dt);
    this.sparks.update();
    this.puffs.update();
  }

  /** live counts for the gallery and the budgets */
  stats() {
    return {
      sparks: this.sparks.alive(), puffs: this.puffs.alive(),
      jets: this.jets.filter(j => !j.idle).length, shells: this.shells.filter(s => s.busy).length,
      trails: this.trails.filter(t => t.root).length,
    };
  }

  dispose() {
    for (const e of this.evolves) for (const m of e.mats) { m.emissiveIntensity = 0; }
    for (const j of this.jets) j.mat.dispose();
    for (const s of this.shells) s.mat.dispose();
    for (const c of this.charges) c.mat.dispose();
    for (const t of this.trails) { t.mesh.geometry.dispose(); (t.mesh.material as THREE.Material).dispose(); }
    this.jets = []; this.shells = []; this.charges = []; this.trails = []; this.evolves = []; this.bursts = [];
    this.jetGeo.dispose(); this.shellGeo.dispose(); this.orbGeo.dispose();
    this.sparks.dispose(); this.puffs.dispose();
    this.group.removeFromParent();
  }
}
