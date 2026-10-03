import * as THREE from 'three';
import type { CacheVisual, RingKind, RingVisual } from './contracts';
import { BRAND, shared, GLSL_IRONBOW, GLSL_NOISE } from './kit';

// Pickup rings read like instruments, not neon: a slim lit tube, a soft halo with a gauge
// bezel of ticks, and a highlight that sweeps round the ring like a radar trace. Every kind is
// coded by shape AND colour so colour blind pilots never guess:
//   SHINE      Light Green, continuous ring, 36 bezel ticks
//   BIG SHINE  Light Green, small ring, spinning DroneShine sparkle, "+3"
//   CHARGE     Blue, ring broken into 12 cells like a battery gauge, lightning glyph
//   REPAIR     Off White, continuous ring, plus glyph (never a red cross)
// One draw call per ring (core, halo and glyph are one geometry); the +3 label is a sprite.

const KIND_COLOR: Record<RingKind, string> = { shine: BRAND.light, bigshine: BRAND.light, charge: BRAND.blue, repair: BRAND.off };
const KIND_ID: Record<RingKind, number> = { shine: 0, bigshine: 1, charge: 2, repair: 3 };

const VERT = /* glsl */`
attribute float aPart;
uniform float uR; uniform float uTube; uniform float uThin; uniform float uPx; uniform float uTime; uniform float uSpin;
varying float vPart; varying vec3 vN; varying vec3 vWP; varying vec2 vLocal; varying vec3 vAxis;
#include <fog_pars_vertex>
void main(){
  vec3 p = position;
  if (aPart < 0.5) {
    vec3 c = vec3(normalize(p.xy) * uR, 0.0);
    vec3 off = p - c;
    float d = distance((modelMatrix * vec4(c, 1.0)).xyz, cameraPosition);
    // never thinner than about 1.6 px, so a ring 300 m away is still a crisp line, not shimmer
    float s = max(uThin, d * uPx * 0.8 / uTube);
    p = c + off * s;
  } else if (aPart > 1.5) {
    float a = uTime * uSpin;
    p.xy = mat2(cos(a), sin(a), -sin(a), cos(a)) * p.xy;
  }
  vec4 w = modelMatrix * vec4(p, 1.0);
  vWP = w.xyz; vLocal = position.xy; vPart = aPart;
  vN = normalize(mat3(modelMatrix) * normal);
  vAxis = normalize(mat3(modelMatrix) * vec3(0.0, 0.0, 1.0));
  vec4 mvPosition = viewMatrix * w;
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}`;

const FRAG = /* glsl */`
uniform vec3 uColor; uniform float uR; uniform float uKind; uniform float uState; uniform float uRemaining;
uniform float uOpacity; uniform float uHalo; uniform float uHighlight; uniform float uPhase; uniform float uTime; uniform float uThermal;
varying float vPart; varying vec3 vN; varying vec3 vWP; varying vec2 vLocal; varying vec3 vAxis;
#include <fog_pars_fragment>
${GLSL_IRONBOW}
${GLSL_NOISE}
void main(){
  vec3 V = normalize(cameraPosition - vWP);
  float dist = distance(cameraPosition, vWP);
  float a01 = fract(atan(vLocal.x, vLocal.y) / 6.2831853 + 1.0);   // 0 at 12 o'clock, clockwise
  vec3 base = uColor;
  if (uThermal > 0.5) base = ironbow(0.8);
  // a taken ring loses its colour as well as its light
  base = mix(base, vec3(dot(base, vec3(0.33))), step(0.5, uState) * step(uState, 1.5) * 0.6);
  float sweep = pow(max(0.0, cos((a01 - fract(uTime * 0.38 + uPhase)) * 6.2831853)), 18.0) * step(uState, 0.5);
  float pulse = 0.5 + 0.5 * sin(uTime * 3.2 + uPhase * 6.28);
  vec3 col = vec3(0.0); float cover = 0.0; vec3 add = vec3(0.0);
  if (vPart < 0.5) {
    if (uKind > 1.5 && uKind < 2.5 && fract(a01 * 12.0) > 0.8) discard;   // CHARGE cells
    float rim = 1.0 - abs(dot(V, vN));
    float lit = 1.1 + rim * 1.4 + sweep * 3.5 + uHighlight * pulse * 1.2;
    col = base * lit;
    cover = uOpacity;
    if (uState > 1.5) cover *= 0.45;
  } else if (vPart < 1.5) {
    float r = length(vLocal);
    float facing = smoothstep(0.08, 0.45, abs(dot(V, vAxis)));
    float glow = exp(-pow((r - uR) / (uR * 0.075), 2.0)) * 0.45 * uHalo;
    float tick = 0.0;
    if (uKind < 0.5) {
      float band = smoothstep(uR * 1.095, uR * 1.105, r) * smoothstep(uR * 1.175, uR * 1.165, r);
      float t = fract(a01 * 36.0);
      tick = band * smoothstep(0.08, 0.0, abs(t - 0.5) - 0.06) * (0.55 + 0.45 * step(0.5, fract(a01 * 4.0 + 0.125) * 2.0 - 0.5));
    }
    float arc = 0.0;
    if (uState > 1.5 && uRemaining < 1.0) {
      float band = smoothstep(uR * 0.86, uR * 0.9, r) * smoothstep(uR * 1.14, uR * 1.1, r);
      arc = band * step(a01, 1.0 - uRemaining) * 1.6;
      // the leading edge glints so the countdown reads as moving
      arc += band * smoothstep(0.02, 0.0, abs(a01 - (1.0 - uRemaining))) * 2.5;
    }
    float beacon = uHighlight * exp(-pow((r - uR * (1.0 + fract(uTime * 0.7) * 0.25)) / (uR * 0.05), 2.0)) * (1.0 - fract(uTime * 0.7)) * 0.9;
    add = base * (glow + tick * 0.9 * uHalo + beacon) * facing * uOpacity + base * arc * facing;
    if (dot(add, add) < 1e-5) discard;
  } else {
    // glyph: sparkle, plus or lightning
    float rim = 1.0 - abs(dot(V, vN));
    col = (uKind > 0.5 && uKind < 1.5 ? vec3(1.0) * 7.5 + base * 3.0 : base * (1.6 + rim * 0.8 + pulse * 0.25));
    cover = uOpacity * step(uState, 0.5);
    if (cover < 0.01) discard;
  }
  #ifdef USE_FOG
    float fogF = 1.0 - exp(-fogDensity * fogDensity * dist * dist);
    col = mix(col, fogColor, fogF * 0.7);
    add *= 1.0 - fogF * 0.8;
  #endif
  gl_FragColor = vec4(col * cover + add, cover);
}`;

interface GeoEntry { geo: THREE.BufferGeometry; refs: number; tube: number; }
const geoCache = new Map<string, GeoEntry>();

function sparkleShape(size: number) {
  const s = new THREE.Shape(), r = size / 2, w = size * 0.09;
  s.moveTo(0, r); s.quadraticCurveTo(w, w, r, 0); s.quadraticCurveTo(w, -w, 0, -r);
  s.quadraticCurveTo(-w, -w, -r, 0); s.quadraticCurveTo(-w, w, 0, r);
  return s;
}

function boltShape(h: number) {
  const s = new THREE.Shape(), k = h / 2;
  s.moveTo(0.12 * k, k); s.lineTo(-0.42 * k, -0.08 * k); s.lineTo(-0.02 * k, -0.08 * k);
  s.lineTo(-0.18 * k, -k); s.lineTo(0.42 * k, 0.14 * k); s.lineTo(0.02 * k, 0.14 * k); s.closePath();
  return s;
}

function withPart(g: THREE.BufferGeometry, part: number) {
  const ng = g.index ? g.toNonIndexed() : g;
  if (ng !== g) g.dispose();
  if (ng.attributes.uv) ng.deleteAttribute('uv');
  if (!ng.attributes.normal) ng.computeVertexNormals();
  ng.setAttribute('aPart', new THREE.BufferAttribute(new Float32Array(ng.attributes.position.count).fill(part), 1));
  return ng;
}

function concat(geos: THREE.BufferGeometry[]) {
  let n = 0; for (const g of geos) n += g.attributes.position.count;
  const pos = new Float32Array(n * 3), nor = new Float32Array(n * 3), part = new Float32Array(n);
  let o = 0;
  for (const g of geos) {
    pos.set(g.attributes.position.array as Float32Array, o * 3);
    nor.set(g.attributes.normal.array as Float32Array, o * 3);
    part.set(g.attributes.aPart.array as Float32Array, o);
    o += g.attributes.position.count; g.dispose();
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  out.setAttribute('aPart', new THREE.BufferAttribute(part, 1));
  out.computeBoundingSphere();
  return out;
}

function ringGeometry(kind: RingKind, R: number): GeoEntry {
  const key = kind + ':' + R.toFixed(3);
  const hit = geoCache.get(key);
  if (hit) { hit.refs++; return hit; }
  const tube = kind === 'bigshine' ? Math.max(0.05, R * 0.05) : Math.max(0.06, R * 0.042);
  const parts = [withPart(new THREE.TorusGeometry(R, tube, 8, kind === 'bigshine' ? 64 : 96), 0)];
  parts.push(withPart(new THREE.RingGeometry(R * 0.78, R * 1.24, 96, 1), 1));
  if (kind === 'bigshine') {
    const g = new THREE.ExtrudeGeometry(sparkleShape(R * 0.95), { depth: 0.04, bevelEnabled: false, curveSegments: 10 });
    g.translate(0, 0, -0.02);
    parts.push(withPart(g, 2));
  } else if (kind === 'repair') {
    const a = R * 0.46, t = R * 0.13;
    parts.push(withPart(new THREE.BoxGeometry(a, t, 0.06), 2), withPart(new THREE.BoxGeometry(t, a, 0.06), 2));
  } else if (kind === 'charge') {
    const g = new THREE.ExtrudeGeometry(boltShape(R * 0.5), { depth: 0.05, bevelEnabled: false });
    g.translate(0, 0, -0.025);
    parts.push(withPart(g, 2));
  }
  const e = { geo: concat(parts), refs: 1, tube };
  geoCache.set(key, e);
  return e;
}

function releaseGeometry(kind: RingKind, R: number) {
  const key = kind + ':' + R.toFixed(3);
  const e = geoCache.get(key);
  if (!e) return;
  if (--e.refs <= 0) { e.geo.dispose(); geoCache.delete(key); }
}

let plusThreeTex: THREE.CanvasTexture | null = null;
let plusThreeRefs = 0;
function plusThree() {
  plusThreeRefs++;
  if (plusThreeTex) return plusThreeTex;
  const c = document.createElement('canvas'); c.width = 256; c.height = 128;
  const g = c.getContext('2d')!;
  g.font = '400 92px Nasalization, Audiowide, Inter, sans-serif';
  g.textAlign = 'center'; g.textBaseline = 'middle';
  g.shadowColor = 'rgba(0,37,24,0.85)'; g.shadowBlur = 14;
  g.fillStyle = '#b5f78a';
  g.fillText('+3', 128, 70);
  plusThreeTex = new THREE.CanvasTexture(c);
  plusThreeTex.colorSpace = THREE.SRGBColorSpace;
  return plusThreeTex;
}
function releasePlusThree() { if (--plusThreeRefs <= 0 && plusThreeTex) { plusThreeTex.dispose(); plusThreeTex = null; } }

const BEAM_VERT = /* glsl */`
varying float vY; varying vec3 vN; varying vec3 vWP;
void main(){ vY = uv.y; vec4 w = modelMatrix * vec4(position, 1.0); vWP = w.xyz; vN = normalize(mat3(modelMatrix) * normal); gl_Position = projectionMatrix * viewMatrix * w; }`;
const BEAM_FRAG = /* glsl */`
uniform vec3 uColor; uniform float uTime; uniform float uOn;
varying float vY; varying vec3 vN; varying vec3 vWP;
void main(){
  vec3 V = normalize(cameraPosition - vWP);
  float core = pow(abs(dot(V, vN)), 2.0);
  float fade = pow(1.0 - vY, 1.6);
  float pulse = smoothstep(0.08, 0.0, abs(fract(vY * 3.0 - uTime * 0.6) - 0.5) - 0.42);
  float a = (core * 0.55 + pulse * 0.35) * fade * uOn;
  gl_FragColor = vec4(uColor * a * 1.6, 1.0);
}`;

export interface RingEntry { vis: RingImpl; }

/** the ring and the bookkeeping the art system animates every frame */
export class RingImpl implements RingVisual {
  readonly object = new THREE.Group();
  readonly mesh: THREE.Mesh;
  readonly mat: THREE.ShaderMaterial;
  private label: THREE.Sprite | null = null;
  private beam: THREE.Mesh | null = null;
  private target = 1;
  private haloTarget = 1;
  private hl = 0;
  private hlTarget = 0;
  private disposed = false;

  constructor(readonly kind: RingKind, readonly radius: number, private onDispose: (r: RingImpl) => void, private beamParent: THREE.Object3D) {
    const e = ringGeometry(kind, radius);
    this.mat = new THREE.ShaderMaterial({
      vertexShader: VERT, fragmentShader: FRAG,
      uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, {
        uColor: { value: new THREE.Color(KIND_COLOR[kind]) }, uR: { value: radius }, uTube: { value: e.tube },
        uKind: { value: KIND_ID[kind] }, uState: { value: 0 }, uRemaining: { value: 1 }, uOpacity: { value: 1 },
        uHalo: { value: 1 }, uHighlight: { value: 0 }, uThin: { value: 1 }, uPhase: { value: Math.random() },
        uSpin: { value: kind === 'bigshine' ? 0.9 : 0 },
      }]),
      transparent: true, depthWrite: false, premultipliedAlpha: true, side: THREE.DoubleSide, fog: true,
    });
    // shared clocks: the same objects for every ring
    this.mat.uniforms.uTime = shared.time;
    this.mat.uniforms.uThermal = shared.thermal;
    this.mat.uniforms.uPx = shared.px;
    this.mesh = new THREE.Mesh(e.geo, this.mat);
    this.mesh.renderOrder = 3;
    this.mesh.userData.noThermal = true;
    this.object.add(this.mesh);
    this.object.userData.noThermal = true;
    this.object.userData.ringKind = kind;
    if (kind === 'bigshine') {
      const sm = new THREE.SpriteMaterial({ map: plusThree(), transparent: true, depthWrite: false });
      this.label = new THREE.Sprite(sm);
      this.label.scale.set(1.3, 0.65, 1);
      this.label.position.set(0, radius + 0.75, 0);
      this.label.userData.noThermal = true;
      this.object.add(this.label);
    }
  }

  setState(state: 'ready' | 'taken' | 'cooldown', remaining?: number) {
    const u = this.mat.uniforms;
    u.uState.value = state === 'ready' ? 0 : state === 'taken' ? 1 : 2;
    u.uRemaining.value = remaining === undefined ? 1 : THREE.MathUtils.clamp(remaining, 0, 1);
    this.target = state === 'ready' ? 1 : state === 'taken' ? 0.15 : 0.55;
    this.haloTarget = state === 'ready' ? 1 : 0;
    u.uThin.value = state === 'cooldown' ? 0.4 : 1;
    if (this.label) this.label.visible = state === 'ready';
  }

  highlight(on: boolean) {
    this.hlTarget = on ? 1 : 0;
    if (on && !this.beam) {
      const g = new THREE.CylinderGeometry(this.radius * 0.16, this.radius * 0.16, 46, 16, 1, true);
      g.translate(0, 23, 0);
      const m = new THREE.ShaderMaterial({
        vertexShader: BEAM_VERT, fragmentShader: BEAM_FRAG,
        uniforms: { uColor: { value: new THREE.Color(KIND_COLOR[this.kind]) }, uTime: shared.time, uOn: { value: 0 } },
        transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
      });
      this.beam = new THREE.Mesh(g, m);
      this.beam.userData.noThermal = true;
      this.beam.renderOrder = 4;
      this.beamParent.add(this.beam);
    }
  }

  /** per frame: ease opacity and highlight, keep the beacon standing straight up over the ring */
  tick(dt: number, shown: boolean) {
    const u = this.mat.uniforms;
    const k = 1 - Math.exp(-dt * 10);
    u.uOpacity.value += (this.target - u.uOpacity.value) * k;
    u.uHalo.value += (this.haloTarget - u.uHalo.value) * k;
    this.hl += (this.hlTarget - this.hl) * (1 - Math.exp(-dt * 6));
    u.uHighlight.value = this.hl;
    if (this.beam) {
      const on = shown && this.hl > 0.01;
      this.beam.visible = on;
      if (on) {
        this.object.getWorldPosition(this.beam.position);
        (this.beam.material as THREE.ShaderMaterial).uniforms.uOn.value = this.hl;
      }
    }
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.object.removeFromParent();
    this.mat.dispose();
    releaseGeometry(this.kind, this.radius);
    if (this.label) { (this.label.material as THREE.SpriteMaterial).dispose(); releasePlusThree(); }
    if (this.beam) { this.beam.removeFromParent(); this.beam.geometry.dispose(); (this.beam.material as THREE.Material).dispose(); }
    this.onDispose(this);
  }
}

// ------------------------------------------------------------------ Shine cache orb

const ORB_VERT = /* glsl */`
varying vec3 vN; varying vec3 vWP;
void main(){ vec4 w = modelMatrix * vec4(position, 1.0); vWP = w.xyz; vN = normalize(mat3(modelMatrix) * normal); gl_Position = projectionMatrix * viewMatrix * w; }`;
const ORB_FRAG = /* glsl */`
uniform vec3 uColor; uniform float uTime; uniform float uGain; uniform float uThermal;
varying vec3 vN; varying vec3 vWP;
${GLSL_IRONBOW}
void main(){
  vec3 V = normalize(cameraPosition - vWP);
  float f = 1.0 - abs(dot(V, normalize(vN)));
  float facet = 0.55 + 0.45 * abs(dot(normalize(vN), normalize(vec3(0.3, 1.0, 0.2))));
  vec3 c = uColor * (facet * 2.2 + pow(f, 2.0) * 4.0) * uGain;
  if (uThermal > 0.5) c = ironbow(0.85) * (1.0 + f);
  gl_FragColor = vec4(c, 1.0);
}`;

let dotTex: THREE.CanvasTexture | null = null;
let dotRefs = 0;
export function softDotTexture() {
  dotRefs++;
  if (dotTex) return dotTex;
  const c = document.createElement('canvas'); c.width = c.height = 64;
  const g = c.getContext('2d')!;
  const grd = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grd.addColorStop(0, 'rgba(255,255,255,1)'); grd.addColorStop(0.35, 'rgba(255,255,255,0.35)'); grd.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grd; g.fillRect(0, 0, 64, 64);
  dotTex = new THREE.CanvasTexture(c);
  return dotTex;
}
export function releaseSoftDot() { if (--dotRefs <= 0 && dotTex) { dotTex.dispose(); dotTex = null; } }

export class CacheImpl implements CacheVisual {
  readonly object = new THREE.Group();
  private core: THREE.Mesh;
  private ringA: THREE.Mesh;
  private ringB: THREE.Mesh;
  private glow: THREE.Sprite;
  private t = Math.random() * 10;
  private disposed = false;

  constructor(private onDispose: (c: CacheImpl) => void) {
    const coreMat = new THREE.ShaderMaterial({
      vertexShader: ORB_VERT, fragmentShader: ORB_FRAG,
      uniforms: { uColor: { value: new THREE.Color(BRAND.light) }, uTime: shared.time, uGain: { value: 1 }, uThermal: shared.thermal },
    });
    const ico = new THREE.IcosahedronGeometry(0.3, 0);
    this.core = new THREE.Mesh(ico.toNonIndexed(), coreMat);
    ico.dispose();
    this.core.geometry.computeVertexNormals();
    const ringMat = new THREE.MeshStandardMaterial({ color: '#d9dcd6', metalness: 0.9, roughness: 0.25, emissive: new THREE.Color(BRAND.light), emissiveIntensity: 0.35 });
    const ringGeo = new THREE.TorusGeometry(0.47, 0.02, 6, 48);
    this.ringA = new THREE.Mesh(ringGeo, ringMat);
    this.ringB = new THREE.Mesh(ringGeo, ringMat);
    this.glow = new THREE.Sprite(new THREE.SpriteMaterial({ map: softDotTexture(), color: new THREE.Color(BRAND.light).multiplyScalar(1.6), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }));
    this.glow.scale.setScalar(2.4);
    this.object.add(this.core, this.ringA, this.ringB, this.glow);
    this.object.traverse(o => { o.userData.noThermal = true; });
  }

  update(dt: number) {
    this.t += dt;
    const t = this.t;
    this.core.rotation.set(t * 0.35, t * 0.6, 0);
    this.ringA.rotation.set(t * 0.9, 0.3, 0);
    this.ringB.rotation.set(1.2, t * 0.7, t * 0.4);
    const bob = Math.sin(t * 1.6) * 0.12;
    this.core.position.y = this.ringA.position.y = this.ringB.position.y = this.glow.position.y = bob;
    (this.core.material as THREE.ShaderMaterial).uniforms.uGain.value = 1 + Math.sin(t * 3.1) * 0.15;
    (this.glow.material as THREE.SpriteMaterial).opacity = 0.55 + Math.sin(t * 3.1) * 0.15;
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.object.removeFromParent();
    this.core.geometry.dispose(); (this.core.material as THREE.Material).dispose();
    this.ringA.geometry.dispose(); (this.ringA.material as THREE.Material).dispose();
    (this.glow.material as THREE.Material).dispose(); releaseSoftDot();
    this.onDispose(this);
  }
}
