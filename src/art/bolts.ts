import * as THREE from 'three';
import type { TierId } from './contracts';
import { shared, GLSL_IRONBOW } from './kit';

// PULSE bolts: one instanced pool, one draw call for every bolt in the match.
// Each bolt is a camera facing capsule between its head and a tail that grows from the muzzle
// to the tier's tracer length; the core is HDR Light Green (it blooms), the halo wears the
// shooter's colour so you can tell your own fire from incoming fire.

const TIER_BOLT: Record<TierId, { width: number; len: number; core: number }> = {
  spark: { width: 0.05, len: 1.6, core: 7 },
  bolt: { width: 0.055, len: 1.8, core: 7.5 },
  storm: { width: 0.064, len: 2.0, core: 8 },
  nova: { width: 0.074, len: 2.3, core: 8.5 },
};

const VERT = /* glsl */`
attribute vec3 iHead; attribute vec3 iTail; attribute vec3 iGlow; attribute vec4 iP;
varying vec2 vUv; varying float vRatio; varying vec3 vGlow; varying float vCore;
void main(){
  if (iP.w < 0.5) { gl_Position = vec4(0.0, 0.0, 2.0, 1.0); return; }
  float w = iP.x * 3.2;       // quad covers the halo, three widths
  vec4 h = viewMatrix * vec4(iHead, 1.0);
  vec4 t = viewMatrix * vec4(iTail, 1.0);
  vec2 d = h.xy / max(-h.z, 0.05) - t.xy / max(-t.z, 0.05);
  vec2 axis = length(d) > 1e-5 ? normalize(d) : vec2(1.0, 0.0);
  vec2 side = vec2(-axis.y, axis.x);
  float along = position.x * 0.5 + 0.5;          // 0 tail, 1 head
  vec4 mv = mix(t, h, along);
  mv.xy += axis * position.x * w + side * position.y * w;
  gl_Position = projectionMatrix * mv;
  float len = length(h.xy - t.xy);
  vRatio = (len + 2.0 * w) / (2.0 * w);
  vUv = position.xy; vGlow = iGlow; vCore = iP.y;
}`;

const FRAG = /* glsl */`
uniform float uThermal;
varying vec2 vUv; varying float vRatio; varying vec3 vGlow; varying float vCore;
${GLSL_IRONBOW}
void main(){
  float x = max(abs(vUv.x) * vRatio - (vRatio - 1.0), 0.0);
  float r = length(vec2(x, vUv.y));
  // a tracer, not a tube: hot narrow head, the tail thins and fades behind it
  float along = clamp((vUv.x * vRatio + vRatio) / (2.0 * vRatio), 0.0, 1.0);
  float taper = mix(0.35, 1.0, smoothstep(0.0, 0.8, along));
  float core = smoothstep(0.17 * taper, 0.05 * taper, r);
  float halo = exp(-r * r / (taper * taper) * 11.0) * 0.75;
  float fade = mix(0.1, 1.0, smoothstep(0.0, 0.9, along));
  core *= fade; halo *= fade;
  if (core + halo < 0.004) discard;
  vec3 coreCol = mix(vec3(0.71, 0.97, 0.54), vec3(1.0), 0.35) * vCore;
  vec3 col = coreCol * core + vGlow * halo * 1.8;
  if (uThermal > 0.5) col = ironbow(0.97) * (core * 4.0 + halo * 1.5);
  gl_FragColor = vec4(col, 1.0);
}`;

const _d = new THREE.Vector3();
const _out = new THREE.Vector3();

export class BoltPool {
  readonly mesh: THREE.Mesh;
  private geo: THREE.InstancedBufferGeometry;
  private head: THREE.InstancedBufferAttribute;
  private tail: THREE.InstancedBufferAttribute;
  private glow: THREE.InstancedBufferAttribute;
  private par: THREE.InstancedBufferAttribute;
  private free: number[] = [];
  private slotOf = new Map<number, number>();
  private handleAt: Int32Array;
  private origin: Float32Array;
  private dir: Float32Array;
  private len: Float32Array;
  private nextHandle = 1;
  private live = 0;
  readonly capacity: number;

  /** sized for 300 live bolts (50 drones) with headroom; when full the oldest bolt is recycled */
  constructor(capacity = 512) {
    this.capacity = capacity;
    const g = this.geo = new THREE.InstancedBufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0], 3));
    g.setIndex([0, 1, 2, 0, 2, 3]);
    const mk = (n: number) => new THREE.InstancedBufferAttribute(new Float32Array(capacity * n), n).setUsage(THREE.DynamicDrawUsage);
    this.head = mk(3); this.tail = mk(3); this.glow = mk(3); this.par = mk(4);
    g.setAttribute('iHead', this.head); g.setAttribute('iTail', this.tail); g.setAttribute('iGlow', this.glow); g.setAttribute('iP', this.par);
    g.instanceCount = capacity;
    this.handleAt = new Int32Array(capacity);
    this.origin = new Float32Array(capacity * 3);
    this.dir = new Float32Array(capacity * 3);
    this.len = new Float32Array(capacity);
    for (let i = capacity - 1; i >= 0; i--) this.free.push(i);
    const mat = new THREE.ShaderMaterial({
      vertexShader: VERT, fragmentShader: FRAG, uniforms: { uThermal: shared.thermal },
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    });
    this.mesh = new THREE.Mesh(g, mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 7;
    this.mesh.userData.noThermal = true;
    this.mesh.visible = false;
  }

  get count() { return this.live; }

  spawn(pos: THREE.Vector3, dir: THREE.Vector3, tier: TierId, glow: THREE.Color): number {
    let slot = this.free.pop();
    if (slot === undefined) {
      // pool full: recycle the oldest live bolt rather than dropping the new shot
      let oldest = Infinity, pick = 0;
      for (let s = 0; s < this.capacity; s++) { const h = this.handleAt[s]; if (h > 0 && h < oldest) { oldest = h; pick = s; } }
      this.release(pick);
      slot = this.free.pop()!;
    }
    const h = this.nextHandle++;
    this.slotOf.set(h, slot);
    this.handleAt[slot] = h;
    const t = TIER_BOLT[tier] ?? TIER_BOLT.spark;
    _d.copy(dir).normalize();
    const i3 = slot * 3;
    this.origin[i3] = pos.x; this.origin[i3 + 1] = pos.y; this.origin[i3 + 2] = pos.z;
    this.dir[i3] = _d.x; this.dir[i3 + 1] = _d.y; this.dir[i3 + 2] = _d.z;
    this.len[slot] = t.len;
    this.write(this.head, slot, pos.x, pos.y, pos.z);
    this.write(this.tail, slot, pos.x - _d.x * 0.05, pos.y - _d.y * 0.05, pos.z - _d.z * 0.05);
    this.write(this.glow, slot, glow.r, glow.g, glow.b);
    const pa = this.par.array as Float32Array, i4 = slot * 4;
    pa[i4] = t.width; pa[i4 + 1] = t.core; pa[i4 + 2] = 0; pa[i4 + 3] = 1;
    this.touch(this.par, slot);
    this.live++;
    this.mesh.visible = true;
    return h;
  }

  move(handle: number, pos: THREE.Vector3) {
    const slot = this.slotOf.get(handle);
    if (slot === undefined) return;
    const o = this.origin, d = this.dir, i = slot * 3;
    const travelled = Math.hypot(pos.x - o[i], pos.y - o[i + 1], pos.z - o[i + 2]);
    const L = Math.min(travelled, this.len[slot]);
    this.write(this.head, slot, pos.x, pos.y, pos.z);
    this.write(this.tail, slot, pos.x - d[i] * L, pos.y - d[i + 1] * L, pos.z - d[i + 2] * L);
  }

  /** returns the bolt's direction (a shared scratch vector, for impact sparks) or null for a stale handle */
  remove(handle: number): THREE.Vector3 | null {
    const slot = this.slotOf.get(handle);
    if (slot === undefined) return null;
    const i = slot * 3;
    _out.set(this.dir[i], this.dir[i + 1], this.dir[i + 2]);
    this.release(slot);
    return _out;
  }

  private release(slot: number) {
    const h = this.handleAt[slot];
    this.slotOf.delete(h);
    this.handleAt[slot] = 0;
    (this.par.array as Float32Array)[slot * 4 + 3] = 0;
    this.touch(this.par, slot);
    this.free.push(slot);
    this.live--;
    if (this.live <= 0) { this.live = 0; }
  }

  private write(at: THREE.InstancedBufferAttribute, slot: number, x: number, y: number, z: number) {
    const a = at.array as Float32Array;
    a[slot * 3] = x; a[slot * 3 + 1] = y; a[slot * 3 + 2] = z;
    this.touch(at, slot);
  }

  private touch(at: THREE.InstancedBufferAttribute, _slot: number) {
    // bolts move every frame: one full upload of a few KB beats hundreds of tiny ranges
    at.needsUpdate = true;
  }

  update() { this.mesh.visible = this.live > 0; }

  clear() { for (const s of [...this.slotOf.values()]) this.release(s); }

  dispose() {
    this.mesh.removeFromParent();
    this.geo.dispose();
    (this.mesh.material as THREE.Material).dispose();
  }
}
