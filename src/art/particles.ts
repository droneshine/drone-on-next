import * as THREE from 'three';
import { shared, GLSL_IRONBOW } from './kit';

// GPU particle pools. A particle is written once when it is born (position, velocity, birth time,
// life, colour, size); the vertex shader integrates gravity and drag analytically, so the CPU never
// touches it again. One pool is one draw call no matter how many particles are alive.
//
// Shapes: 0 streak (velocity aligned capsule), 1 soft dot, 2 ring, 3 DroneShine sparkle (four point star).

export const SHAPE = { streak: 0, dot: 1, ring: 2, star: 3 } as const;

export interface Emit {
  p: THREE.Vector3;
  v?: THREE.Vector3;
  life: number;
  color: THREE.Color;      // linear, may be HDR
  alpha?: number;          // 0..1 opacity scale
  size: number;            // m at birth
  size1?: number;          // m at death (default size)
  stretch?: number;        // streak length in seconds of velocity
  gravity?: number;        // 1 = full g
  drag?: number;           // 1/s
  shape?: number;
  spin?: number;           // rad/s for stars
  delay?: number;          // s before it appears
}

const VERT = /* glsl */`
attribute vec3 iP0; attribute vec3 iV0; attribute vec4 iT; attribute vec4 iC; attribute vec4 iS; attribute vec2 iX;
uniform float uTime;
varying vec2 vUv; varying vec4 vC; varying float vF; varying float vRatio; varying float vShape;
void main(){
  float t = uTime - iT.x;
  if (t < 0.0 || t > iT.y) { gl_Position = vec4(0.0, 0.0, 2.0, 1.0); return; }
  float k = max(iT.w, 1e-3);
  float e = exp(-k * t);
  vec3 g = vec3(0.0, -9.81 * iT.z, 0.0);
  vec3 pos = iP0 + iV0 * (1.0 - e) / k + g * (t / k - (1.0 - e) / (k * k));
  vec3 vel = iV0 * e + g * (1.0 - e) / k;
  float f = t / iT.y;
  float size = mix(iS.x, iS.y, f);
  vec4 mv = viewMatrix * vec4(pos, 1.0);
  vec2 corner = position.xy;
  float shape = iS.w;
  vec2 axis = vec2(1.0, 0.0), side = vec2(0.0, 1.0);
  float len = size;
  if (shape < 0.5) {
    vec3 vv = (viewMatrix * vec4(vel, 0.0)).xyz;
    // perspective correct screen direction of the motion
    vec2 d2 = vv.xy - mv.xy * (vv.z / min(mv.z, -0.01));
    float sp = length(d2);
    if (sp > 1e-4) axis = d2 / sp;
    side = vec2(-axis.y, axis.x);
    len = size + length(vel) * iS.z;
    // the streak trails behind the head
    mv.xy -= axis * (len - size) * 0.5;
  } else {
    float a = iX.x * t + iX.y;
    axis = vec2(cos(a), sin(a)); side = vec2(-axis.y, axis.x);
  }
  mv.xy += axis * corner.x * len * 0.5 + side * corner.y * size * 0.5;
  gl_Position = projectionMatrix * mv;
  vUv = corner; vC = iC; vF = f; vRatio = len / size; vShape = shape;
}`;

const FRAG = /* glsl */`
uniform float uThermal;
varying vec2 vUv; varying vec4 vC; varying float vF; varying float vRatio; varying float vShape;
${GLSL_IRONBOW}
void main(){
  float a = 0.0, core = 0.0;
  if (vShape < 0.5) {
    float x = max(abs(vUv.x) * vRatio - (vRatio - 1.0), 0.0);
    float r = length(vec2(x, vUv.y));
    a = smoothstep(1.0, 0.15, r);
    core = smoothstep(0.55, 0.0, r);
  } else if (vShape < 1.5) {
    float r = length(vUv);
    a = smoothstep(1.0, 0.0, r); a *= a;
    core = smoothstep(0.4, 0.0, r);
  } else if (vShape < 2.5) {
    float r = length(vUv);
    float w = mix(0.11, 0.03, vF);
    a = smoothstep(w, 0.0, abs(r - (1.0 - w)));
    core = a * 0.5;
  } else {
    // DroneShine sparkle: concave four point star
    vec2 q = abs(vUv);
    float s = pow(q.x, 0.55) + pow(q.y, 0.55);
    a = smoothstep(1.0, 0.82, s);
    float glow = smoothstep(0.9, 0.0, length(vUv)) * 0.35;
    core = smoothstep(0.75, 0.3, s);
    a = max(a, glow);
  }
  if (a < 0.003) discard;
  float fade = vC.a * (1.0 - vF * vF);
  vec3 col = vC.rgb * (1.0 + core * 1.5);
  #ifdef ALPHA_POOL
    if (uThermal > 0.5) col = ironbow(0.22 + 0.1 * fade);     // smoke and mist read cool
  #else
    if (uThermal > 0.5) col = ironbow(0.55 + 0.45 * fade) * 2.0;   // sparks read hot
  #endif
  #ifdef ALPHA_POOL
    gl_FragColor = vec4(col, a * fade);
  #else
    gl_FragColor = vec4(col * a * fade, 1.0);
  #endif
}`;

export class ParticlePool {
  readonly mesh: THREE.Mesh;
  private geo: THREE.InstancedBufferGeometry;
  private a: { p0: THREE.InstancedBufferAttribute; v0: THREE.InstancedBufferAttribute; t: THREE.InstancedBufferAttribute; c: THREE.InstancedBufferAttribute; s: THREE.InstancedBufferAttribute; x: THREE.InstancedBufferAttribute };
  private next = 0;
  private lastDeath = -1;
  private dirtyLo = Infinity;
  private dirtyHi = -1;
  readonly capacity: number;

  constructor(capacity: number, alpha: boolean) {
    this.capacity = capacity;
    const g = this.geo = new THREE.InstancedBufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0], 3));
    g.setIndex([0, 1, 2, 0, 2, 3]);
    const mk = (n: number) => new THREE.InstancedBufferAttribute(new Float32Array(capacity * n), n).setUsage(THREE.DynamicDrawUsage);
    this.a = { p0: mk(3), v0: mk(3), t: mk(4), c: mk(4), s: mk(4), x: mk(2) };
    // everything starts dead: birth far in the future
    for (let i = 0; i < capacity; i++) { this.a.t.array[i * 4] = 1e9; this.a.t.array[i * 4 + 1] = 0; }
    g.setAttribute('iP0', this.a.p0); g.setAttribute('iV0', this.a.v0); g.setAttribute('iT', this.a.t);
    g.setAttribute('iC', this.a.c); g.setAttribute('iS', this.a.s); g.setAttribute('iX', this.a.x);
    g.instanceCount = capacity;
    const mat = new THREE.ShaderMaterial({
      vertexShader: VERT, fragmentShader: FRAG,
      uniforms: { uTime: shared.time, uThermal: shared.thermal },
      transparent: true, depthWrite: false,
      blending: alpha ? THREE.NormalBlending : THREE.AdditiveBlending,
      defines: alpha ? { ALPHA_POOL: 1 } : {},
    });
    this.mesh = new THREE.Mesh(g, mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = alpha ? 5 : 6;
    this.mesh.userData.noThermal = true;
    this.mesh.visible = false;
  }

  emit(o: Emit) {
    const i = this.next;
    this.next = (this.next + 1) % this.capacity;
    const now = shared.time.value;
    const p = this.a.p0.array as Float32Array, v = this.a.v0.array as Float32Array, t = this.a.t.array as Float32Array;
    const c = this.a.c.array as Float32Array, s = this.a.s.array as Float32Array, x = this.a.x.array as Float32Array;
    p[i * 3] = o.p.x; p[i * 3 + 1] = o.p.y; p[i * 3 + 2] = o.p.z;
    v[i * 3] = o.v?.x ?? 0; v[i * 3 + 1] = o.v?.y ?? 0; v[i * 3 + 2] = o.v?.z ?? 0;
    const birth = now + (o.delay ?? 0);
    t[i * 4] = birth; t[i * 4 + 1] = o.life; t[i * 4 + 2] = o.gravity ?? 0; t[i * 4 + 3] = o.drag ?? 0.001;
    c[i * 4] = o.color.r; c[i * 4 + 1] = o.color.g; c[i * 4 + 2] = o.color.b; c[i * 4 + 3] = o.alpha ?? 1;
    s[i * 4] = o.size; s[i * 4 + 1] = o.size1 ?? o.size; s[i * 4 + 2] = o.stretch ?? 0; s[i * 4 + 3] = o.shape ?? 0;
    x[i * 2] = o.spin ?? 0; x[i * 2 + 1] = Math.random() * 6.283;
    this.dirtyLo = Math.min(this.dirtyLo, i); this.dirtyHi = Math.max(this.dirtyHi, i);
    this.lastDeath = Math.max(this.lastDeath, birth + o.life);
    this.mesh.visible = true;
  }

  /** upload what was born this frame, hide the pool when nothing is alive */
  update() {
    if (this.dirtyHi >= 0) {
      // one contiguous range covers everything born this frame (a wrap simply widens it)
      const lo = this.dirtyLo, n = this.dirtyHi - lo + 1;
      for (const at of Object.values(this.a)) {
        // ranges pile up only while nothing renders; past a handful a full upload is cheaper anyway
        if (at.updateRanges.length > 32) at.clearUpdateRanges();
        else at.addUpdateRange(lo * at.itemSize, n * at.itemSize);
        at.needsUpdate = true;
      }
      this.dirtyLo = Infinity; this.dirtyHi = -1;
    }
    if (shared.time.value > this.lastDeath) this.mesh.visible = false;
  }

  /** how many are alive right now (CPU side count for budgets and the gallery) */
  alive() {
    const now = shared.time.value, t = this.a.t.array as Float32Array;
    let n = 0;
    for (let i = 0; i < this.capacity; i++) { const b = t[i * 4]; if (now >= b && now <= b + t[i * 4 + 1]) n++; }
    return n;
  }

  clear() {
    const t = this.a.t.array as Float32Array;
    for (let i = 0; i < this.capacity; i++) t[i * 4] = 1e9;
    this.a.t.clearUpdateRanges(); this.a.t.needsUpdate = true;
    this.lastDeath = -1; this.mesh.visible = false;
  }

  dispose() {
    this.mesh.removeFromParent();
    this.geo.dispose();
    (this.mesh.material as THREE.Material).dispose();
  }
}
