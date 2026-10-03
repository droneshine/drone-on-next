import * as THREE from 'three';
import type { SignalVisual } from './contracts';
import { heightAt } from '../world/terrain';
import { BRAND, shared, GLSL_NOISE } from './kit';

// The Signal: a translucent wall of Light Green scan lines and static standing on the terrain,
// with a bright line where it meets the ground, plus a static sheet under the ceiling that only
// shows when you fly within 10 m of it. Opacity follows GDD 6.7: 0.15 far away, 0.6 within 30 m.
//
// The wall is one draw call: a unit cylinder the vertex shader scales to the current centre,
// radius and ceiling, with the terrain height under every column baked into an attribute.
// Seen from outside (in the Static) the same wall is noisier, so you always know which side you are on.

const COLS = 512;

const WALL_VERT = /* glsl */`
attribute float aGround; attribute float aT;
uniform vec2 uC; uniform float uRad; uniform float uCeil;
varying vec3 vWP; varying float vH; varying float vArc; varying float vTop;
void main(){
  vec3 wp = vec3(uC.x + position.x * uRad, position.y > 0.5 ? uCeil + 0.5 : aGround - 4.0, uC.y + position.z * uRad);
  vWP = wp; vH = wp.y - aGround; vArc = aT * 6.2831853 * uRad; vTop = uCeil - wp.y;
  gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
}`;

const WALL_FRAG = /* glsl */`
uniform vec3 uColor; uniform float uTime; uniform float uThermal;
varying vec3 vWP; varying float vH; varying float vArc; varying float vTop;
${GLSL_NOISE}
float lineAA(float coord, float period, float halfW){
  float s = abs(fract(coord / period) - 0.5) * period;
  float fw = fwidth(coord);
  float l = 1.0 - smoothstep(halfW, halfW + fw, s);
  // far away the lines merge into an even tint instead of shimmering
  return mix(l, halfW * 2.0 / period, smoothstep(period * 0.2, period * 0.6, fw));
}
void main(){
  float d = distance(vWP, cameraPosition);
  float outside = gl_FrontFacing ? 1.0 : 0.0;
  float base = mix(0.6, 0.15, smoothstep(30.0, 140.0, d));
  float y = vWP.y;
  float scan = lineAA(y - uTime * 0.7, 2.0, 0.05);
  float fine = lineAA(y + uTime * 0.25, 0.5, 0.012);
  float rib = lineAA(vArc, 8.0, 0.03);
  // static: sparse blocks that flicker at 15 fps, denser on the Static side
  float fwA = fwidth(vArc) + fwidth(y);
  float step15 = floor(uTime * 15.0);
  float n = h21(floor(vec2(vArc * 1.6, y * 3.2)) + vec2(step15 * 1.7, step15 * 3.1));
  float grain = step(mix(0.955, 0.86, outside), n) * (1.0 - smoothstep(0.4, 1.6, fwA));
  float band = exp(-pow((y - mod(uTime * 9.0, 140.0) + 10.0) / 2.5, 2.0));
  float a = base * (0.22 + scan * 0.55 + fine * 0.18 + rib * 0.22 + grain * 0.75 + band * 0.45 + outside * 0.08);
  // ground line: hard bright core that blooms, soft glow above it
  float h = vH - 0.05;
  float core = smoothstep(0.22, 0.0, abs(h)) ;
  float glow = exp(-max(h, 0.0) * 1.3) * step(-0.1, h);
  float top = smoothstep(0.35, 0.0, abs(vTop - 0.5)) * 0.8;
  vec3 col = uColor;
  if (uThermal > 0.5) col = vec3(0.85, 0.95, 1.0);
  vec3 add = col * (core * 9.0 + glow * 0.9 + top * 2.0);
  a = clamp(a, 0.0, 0.85);
  if (vH < -0.25) { a *= 0.0; add *= 0.0; }
  gl_FragColor = vec4(col * a * 1.25 + add, a);
}`;

const SHEET_VERT = /* glsl */`
uniform vec2 uC; uniform float uRad; uniform float uCeil;
varying vec3 vWP;
void main(){ vec3 wp = vec3(uC.x + position.x * uRad, uCeil, uC.y + position.z * uRad); vWP = wp; gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0); }`;

const SHEET_FRAG = /* glsl */`
uniform vec3 uColor; uniform float uTime; uniform float uCeil;
varying vec3 vWP;
${GLSL_NOISE}
float grid(vec2 p, float period, float halfW){
  vec2 s = abs(fract(p / period) - 0.5) * period;
  vec2 fw = fwidth(p);
  vec2 l = 1.0 - smoothstep(vec2(halfW), vec2(halfW) + fw, s);
  return max(l.x, l.y);
}
void main(){
  float gap = uCeil - cameraPosition.y;
  float show = 1.0 - smoothstep(0.0, 10.0, gap);
  float dc = distance(vWP.xz, cameraPosition.xz);
  float local = 1.0 - smoothstep(18.0, 75.0, dc);
  float a = show * local;
  if (a < 0.004) discard;
  float g = grid(vWP.xz + vec2(0.0, uTime * 0.6), 4.0, 0.05);
  float step15 = floor(uTime * 15.0);
  float n = h21(floor(vWP.xz * 1.5) + vec2(step15 * 1.3, step15 * 2.9));
  float alpha = a * (0.12 + g * 0.5 + step(0.9, n) * 0.5 + n * 0.08);
  gl_FragColor = vec4(uColor * alpha * 1.3, alpha);
}`;

export class SignalImpl implements SignalVisual {
  readonly group = new THREE.Group();
  private wall: THREE.Mesh;
  private sheet: THREE.Mesh;
  private wallMat: THREE.ShaderMaterial;
  private sheetMat: THREE.ShaderMaterial;
  private ground: THREE.BufferAttribute;
  private last = { cx: NaN, cz: NaN, r: NaN };
  private disposed = false;

  constructor(parent: THREE.Object3D, private onDispose: (s: SignalImpl) => void) {
    // unit cylinder: COLS + 1 columns (the seam column is duplicated so arcs never wrap), 2 rows
    const pos = new Float32Array((COLS + 1) * 2 * 3), t = new Float32Array((COLS + 1) * 2), gr = new Float32Array((COLS + 1) * 2);
    const idx: number[] = [];
    for (let i = 0; i <= COLS; i++) {
      const a = i / COLS * Math.PI * 2;
      for (let r = 0; r < 2; r++) {
        const k = i * 2 + r;
        pos[k * 3] = Math.cos(a); pos[k * 3 + 1] = r; pos[k * 3 + 2] = Math.sin(a);
        t[k] = i / COLS;
      }
      if (i < COLS) {
        const a0 = i * 2, b0 = a0 + 2;
        // winding: the face looks outward, so gl_FrontFacing means "seen from the Static"
        idx.push(a0, a0 + 1, b0, b0, a0 + 1, b0 + 1);
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('aT', new THREE.BufferAttribute(t, 1));
    this.ground = new THREE.BufferAttribute(gr, 1).setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('aGround', this.ground);
    g.setIndex(idx);
    const common = { uC: { value: new THREE.Vector2() }, uRad: { value: 420 }, uCeil: { value: 120 } };
    this.wallMat = new THREE.ShaderMaterial({
      vertexShader: WALL_VERT, fragmentShader: WALL_FRAG,
      uniforms: { ...common, uColor: { value: new THREE.Color(BRAND.light) }, uTime: shared.time, uThermal: shared.thermal },
      transparent: true, depthWrite: false, side: THREE.DoubleSide, premultipliedAlpha: true,
    });
    this.wall = new THREE.Mesh(g, this.wallMat);
    this.wall.frustumCulled = false;
    this.wall.renderOrder = 8;
    this.wall.name = 'signal-wall';
    const sg = new THREE.CircleGeometry(1, 96);
    sg.rotateX(-Math.PI / 2);
    this.sheetMat = new THREE.ShaderMaterial({
      vertexShader: SHEET_VERT, fragmentShader: SHEET_FRAG,
      uniforms: { uC: common.uC, uRad: common.uRad, uCeil: common.uCeil, uColor: { value: new THREE.Color(BRAND.light) }, uTime: shared.time },
      transparent: true, depthWrite: false, side: THREE.DoubleSide, premultipliedAlpha: true,
    });
    this.sheet = new THREE.Mesh(sg, this.sheetMat);
    this.sheet.frustumCulled = false;
    this.sheet.renderOrder = 8;
    this.sheet.name = 'signal-ceiling';
    this.group.add(this.wall, this.sheet);
    this.group.traverse(o => { o.userData.noThermal = true; });
    this.group.visible = false;
    parent.add(this.group);
  }

  set(cx: number, cz: number, radius: number, ceilingY: number) {
    const u = this.wallMat.uniforms;
    u.uC.value.set(cx, cz); u.uRad.value = Math.max(0.01, radius); u.uCeil.value = ceilingY;
    this.group.visible = radius > 0.5;
    const L = this.last;
    if (!(Math.abs(cx - L.cx) < 0.5 && Math.abs(cz - L.cz) < 0.5 && Math.abs(radius - L.r) < 0.5)) {
      L.cx = cx; L.cz = cz; L.r = radius;
      const a = this.ground.array as Float32Array;
      for (let i = 0; i <= COLS; i++) {
        const t = i / COLS * Math.PI * 2;
        const h = heightAt(cx + Math.cos(t) * radius, cz + Math.sin(t) * radius);
        a[i * 2] = a[i * 2 + 1] = h;
      }
      this.ground.needsUpdate = true;
    }
  }

  update(_dt: number, _camera: THREE.Camera) { /* everything runs on the shared clock and the camera uniforms */ }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.group.removeFromParent();
    this.wall.geometry.dispose(); this.sheet.geometry.dispose();
    this.wallMat.dispose(); this.sheetMat.dispose();
    this.onDispose(this);
  }
}
