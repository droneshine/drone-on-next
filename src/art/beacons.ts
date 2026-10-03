import * as THREE from 'three';
import type { TierId } from './contracts';
import { tierRoots } from './tiers';
import { BRAND, shared, GLSL_IRONBOW } from './kit';

// Tier beacons: at 60 m a SPARK is six pixels tall, so the outline alone cannot carry the tier.
// Every tier drone wears a small anti collision light, coded by SHAPE and colour, that fades in
// beyond 20 m and holds a fixed pixel size out to the edge of the arena:
//   SPARK  single dot, Accent Green      BOLT  twin dots, Blue
//   STORM  ring, Light Green             NOVA  DroneShine sparkle, Off White
// One Points draw call for every drone in the match; hidden behind terrain and buildings.

const CAP = 96;
const STYLE: Record<TierId, { color: string; shape: number }> = {
  spark: { color: '#4fe07a', shape: 0 },
  bolt: { color: BRAND.blue, shape: 1 },
  storm: { color: BRAND.light, shape: 2 },
  nova: { color: BRAND.off, shape: 3 },
};

const VERT = /* glsl */`
attribute vec3 aColor; attribute vec2 aShape;
uniform float uPxRatio; uniform float uTime; uniform float uViewH;
varying vec3 vColor; varying float vShape; varying float vA;
void main(){
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  float d = -mv.z;
  vA = smoothstep(20.0, 42.0, d) * (1.0 - smoothstep(520.0, 700.0, d));
  // a slow breathing so a still drone in the distance still catches the eye
  vA *= 0.82 + 0.18 * sin(uTime * 3.0 + aShape.y);
  vColor = aColor; vShape = aShape.x;
  float px = (aShape.x > 2.5 ? 11.0 : aShape.x > 1.5 ? 9.0 : aShape.x > 0.5 ? 8.0 : 7.0) * (1.0 + 0.25 * smoothstep(120.0, 40.0, d));
  gl_PointSize = px * uPxRatio;
  gl_Position = projectionMatrix * mv;
  // ride just above the drone, so the light never hides the airframe it labels
  gl_Position.y += (px * 0.75 + 3.0) * 2.0 / uViewH * gl_Position.w;
  if (vA < 0.01) gl_Position = vec4(0.0, 0.0, 2.0, 1.0);
}`;

const FRAG = /* glsl */`
uniform float uThermal;
varying vec3 vColor; varying float vShape; varying float vA;
${GLSL_IRONBOW}
void main(){
  vec2 p = gl_PointCoord * 2.0 - 1.0;
  float a = 0.0;
  if (vShape < 0.5) a = smoothstep(0.62, 0.3, length(p));
  else if (vShape < 1.5) a = max(smoothstep(0.42, 0.18, length(p - vec2(-0.48, 0.0))), smoothstep(0.42, 0.18, length(p - vec2(0.48, 0.0))));
  else if (vShape < 2.5) a = smoothstep(0.2, 0.06, abs(length(p) - 0.7));
  else { vec2 q = abs(p); a = smoothstep(1.0, 0.8, pow(q.x, 0.55) + pow(q.y, 0.55)); }
  a *= vA;
  if (a < 0.02) discard;
  vec3 c = uThermal > 0.5 ? ironbow(0.95) : vColor;
  gl_FragColor = vec4(c * a * 2.6, a);
}`;

export class Beacons {
  readonly points: THREE.Points;
  private pos: Float32Array;
  private col: Float32Array;
  private shp: Float32Array;
  private geo: THREE.BufferGeometry;
  private mat: THREE.ShaderMaterial;
  private colors: Record<TierId, THREE.Color>;
  private v = new THREE.Vector3();

  constructor(parent: THREE.Object3D) {
    this.pos = new Float32Array(CAP * 3); this.col = new Float32Array(CAP * 3); this.shp = new Float32Array(CAP * 2);
    this.geo = new THREE.BufferGeometry();
    this.geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    this.geo.setAttribute('aColor', new THREE.BufferAttribute(this.col, 3).setUsage(THREE.DynamicDrawUsage));
    this.geo.setAttribute('aShape', new THREE.BufferAttribute(this.shp, 2).setUsage(THREE.DynamicDrawUsage));
    this.geo.setDrawRange(0, 0);
    this.mat = new THREE.ShaderMaterial({
      vertexShader: VERT, fragmentShader: FRAG,
      uniforms: { uPxRatio: { value: 1 }, uViewH: { value: 900 }, uTime: shared.time, uThermal: shared.thermal },
      transparent: true, depthWrite: false, premultipliedAlpha: true,
    });
    this.points = new THREE.Points(this.geo, this.mat);
    this.points.frustumCulled = false;
    this.points.renderOrder = 9;
    this.points.userData.noThermal = true;
    this.points.name = 'tier-beacons';
    parent.add(this.points);
    this.colors = { spark: new THREE.Color(STYLE.spark.color), bolt: new THREE.Color(STYLE.bolt.color), storm: new THREE.Color(STYLE.storm.color), nova: new THREE.Color(STYLE.nova.color) };
  }

  update(scene: THREE.Scene) {
    let n = 0;
    this.mat.uniforms.uPxRatio.value = Math.min(2, devicePixelRatio || 1);
    this.mat.uniforms.uViewH.value = Math.max(1, innerHeight);
    for (const ref of tierRoots) {
      const root = ref.deref();
      if (!root) { tierRoots.delete(ref); continue; }
      if (n >= CAP || !shownIn(root, scene)) continue;
      const tier = root.userData.tier as TierId;
      const st = STYLE[tier];
      if (!st) continue;
      root.getWorldPosition(this.v);
      this.pos[n * 3] = this.v.x; this.pos[n * 3 + 1] = this.v.y + 0.25; this.pos[n * 3 + 2] = this.v.z;
      const c = this.colors[tier];
      this.col[n * 3] = c.r; this.col[n * 3 + 1] = c.g; this.col[n * 3 + 2] = c.b;
      this.shp[n * 2] = st.shape; this.shp[n * 2 + 1] = root.id * 1.7;
      n++;
    }
    this.geo.setDrawRange(0, n);
    this.points.visible = n > 0;
    if (n) {
      for (const k of ['position', 'aColor', 'aShape']) {
        const at = this.geo.attributes[k] as THREE.BufferAttribute;
        at.clearUpdateRanges(); at.addUpdateRange(0, n * at.itemSize); at.needsUpdate = true;
      }
    }
  }

  dispose() { this.points.removeFromParent(); this.geo.dispose(); this.mat.dispose(); }
}

/** visible all the way up and hanging in this scene */
function shownIn(o: THREE.Object3D, scene: THREE.Scene) {
  let x: THREE.Object3D | null = o;
  while (x) { if (!x.visible) return false; if (x === scene) return true; x = x.parent; }
  return false;
}
