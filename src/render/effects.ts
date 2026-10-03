import * as THREE from 'three';
import { heightAt } from '../world/terrain';

// Particles (spray, mist, dust) on one pooled Points mesh, and the DShine hose
// as a verlet rope that lies on the ground, sags, and pulls on the drone.

function softDot() {
  const c = document.createElement('canvas'); c.width = c.height = 64;
  const g = c.getContext('2d')!;
  const grd = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grd.addColorStop(0, 'rgba(255,255,255,1)'); grd.addColorStop(0.4, 'rgba(255,255,255,0.5)'); grd.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grd; g.fillRect(0, 0, 64, 64);
  const t = new THREE.CanvasTexture(c);
  return t;
}

export class Particles {
  max: number;
  pos: Float32Array; vel: Float32Array; life: Float32Array; maxLife: Float32Array; size: Float32Array; col: Float32Array;
  points: THREE.Points;
  private next = 0;
  private geo: THREE.BufferGeometry;
  floorFn: (x: number, y: number, z: number) => boolean = () => false;

  constructor(max = 6000) {
    this.max = max;
    this.pos = new Float32Array(max * 3); this.vel = new Float32Array(max * 3);
    this.life = new Float32Array(max); this.maxLife = new Float32Array(max); this.size = new Float32Array(max); this.col = new Float32Array(max * 4);
    this.geo = new THREE.BufferGeometry();
    this.geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    this.geo.setAttribute('aSize', new THREE.BufferAttribute(this.size, 1).setUsage(THREE.DynamicDrawUsage));
    this.geo.setAttribute('aCol', new THREE.BufferAttribute(this.col, 4).setUsage(THREE.DynamicDrawUsage));
    const mat = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false,
      uniforms: { uTex: { value: softDot() }, uScale: { value: 600 } },
      vertexShader: `attribute float aSize; attribute vec4 aCol; varying vec4 vCol; uniform float uScale;
        void main(){ vCol = aCol; vec4 mv = modelViewMatrix * vec4(position,1.); gl_Position = projectionMatrix * mv;
          gl_PointSize = aSize * uScale / max(0.1, -mv.z); }`,
      fragmentShader: `uniform sampler2D uTex; varying vec4 vCol;
        void main(){ vec4 t = texture2D(uTex, gl_PointCoord); gl_FragColor = vec4(vCol.rgb, vCol.a * t.a); if (gl_FragColor.a < 0.01) discard; }`,
    });
    this.points = new THREE.Points(this.geo, mat);
    this.points.frustumCulled = false;
    this.points.userData.noThermal = true;
  }

  emit(p: THREE.Vector3, v: THREE.Vector3, life: number, size: number, r: number, g: number, b: number, a: number) {
    const i = this.next; this.next = (this.next + 1) % this.max;
    this.pos[i * 3] = p.x; this.pos[i * 3 + 1] = p.y; this.pos[i * 3 + 2] = p.z;
    this.vel[i * 3] = v.x; this.vel[i * 3 + 1] = v.y; this.vel[i * 3 + 2] = v.z;
    this.life[i] = life; this.maxLife[i] = life; this.size[i] = size;
    this.col[i * 4] = r; this.col[i * 4 + 1] = g; this.col[i * 4 + 2] = b; this.col[i * 4 + 3] = a;
  }

  update(dt: number, wind: THREE.Vector3, cameraFovScale: number) {
    (this.points.material as THREE.ShaderMaterial).uniforms.uScale.value = cameraFovScale;
    for (let i = 0; i < this.max; i++) {
      if (this.life[i] <= 0) { this.size[i] = 0; continue; }
      this.life[i] -= dt;
      const k = i * 3;
      const drag = this.col[i * 4 + 3] < 0.3 ? 2.5 : 0.6;   // mist drifts more than droplets
      this.vel[k] += (wind.x - this.vel[k]) * drag * dt;
      this.vel[k + 2] += (wind.z - this.vel[k + 2]) * drag * dt;
      this.vel[k + 1] -= 9.81 * dt * (drag > 1 ? 0.15 : 1);
      this.pos[k] += this.vel[k] * dt; this.pos[k + 1] += this.vel[k + 1] * dt; this.pos[k + 2] += this.vel[k + 2] * dt;
      const ground = heightAt(this.pos[k], this.pos[k + 2]);
      if (this.pos[k + 1] < ground || this.floorFn(this.pos[k], this.pos[k + 1], this.pos[k + 2])) { this.life[i] = Math.min(this.life[i], 0.08); this.vel[k] *= 0.2; this.vel[k + 1] = 0.3; this.vel[k + 2] *= 0.2; }
      const f = this.life[i] / this.maxLife[i];
      if (f < 0.25) this.size[i] *= 1 + dt * 1.5;
      this.col[i * 4 + 3] *= f < 0.3 ? 1 - dt * 3 : 1;
    }
    this.geo.attributes.position.needsUpdate = true;
    this.geo.attributes.aSize.needsUpdate = true;
    this.geo.attributes.aCol.needsUpdate = true;
  }

  clear() { this.life.fill(0); }
}

export class Hose {
  n = 48;
  pts: THREE.Vector3[] = [];
  prev: THREE.Vector3[] = [];
  length: number;
  mesh: THREE.Mesh;
  private seg: number;
  force = new THREE.Vector3();

  constructor(public anchor: THREE.Vector3, length = 50) {
    this.length = length;
    this.seg = length / (this.n - 1);
    for (let i = 0; i < this.n; i++) {
      const p = anchor.clone().add(new THREE.Vector3(0, 0, -i * this.seg * 0.3));
      p.y = heightAt(p.x, p.z) + 0.05;
      this.pts.push(p); this.prev.push(p.clone());
    }
    this.mesh = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshStandardMaterial({ color: '#e6e3d8', roughness: 0.5 }));
    this.mesh.castShadow = true;
    this.mesh.frustumCulled = false;
    this.mesh.userData.temp = 0.4;
  }

  reset(attach: THREE.Vector3) {
    for (let i = 0; i < this.n; i++) {
      const t = i / (this.n - 1);
      const p = this.anchor.clone().lerp(attach, t);
      p.y = Math.max(heightAt(p.x, p.z) + 0.05, p.y);
      this.pts[i].copy(p); this.prev[i].copy(p);
    }
  }

  update(dt: number, attach: THREE.Vector3) {
    const g = -9.81 * dt * dt;
    for (let i = 1; i < this.n - 1; i++) {
      const p = this.pts[i], q = this.prev[i];
      const vx = (p.x - q.x) * 0.98, vy = (p.y - q.y) * 0.98, vz = (p.z - q.z) * 0.98;
      q.copy(p);
      p.x += vx; p.y += vy + g; p.z += vz;
    }
    this.pts[0].copy(this.anchor);
    this.pts[this.n - 1].copy(attach);
    for (let it = 0; it < 12; it++) {
      for (let i = 0; i < this.n - 1; i++) {
        const a = this.pts[i], b = this.pts[i + 1];
        const d = b.clone().sub(a); const len = d.length() || 1e-6;
        // rope: only resists stretching
        if (len < this.seg) continue;
        const diff = (len - this.seg) / len;
        const wa = i === 0 ? 0 : 0.5, wb = i + 1 === this.n - 1 ? 0 : 0.5;
        const sum = wa + wb || 1;
        a.addScaledVector(d, diff * wa / sum);
        b.addScaledVector(d, -diff * wb / sum);
      }
      for (let i = 1; i < this.n - 1; i++) {
        const p = this.pts[i];
        const h = heightAt(p.x, p.z) + 0.04;
        if (p.y < h) { p.y = h; this.prev[i].x = p.x - (p.x - this.prev[i].x) * 0.5; this.prev[i].z = p.z - (p.z - this.prev[i].z) * 0.5; }
      }
    }
    // force on the drone: weight of the hanging hose plus tether pull when taut
    const kgPerM = 0.38;
    let hanging = 0;
    for (let i = this.n - 2; i > 0; i--) { if (this.pts[i].y - heightAt(this.pts[i].x, this.pts[i].z) > 0.15) hanging += this.seg; else break; }
    this.force.set(0, -kgPerM * 9.81 * hanging * 0.55, 0);
    const toPrev = this.pts[this.n - 2].clone().sub(attach);
    const dist = attach.distanceTo(this.anchor);
    if (dist > this.length * 0.96) {
      this.force.addScaledVector(toPrev.normalize(), (dist - this.length * 0.96) * 600);
    } else {
      this.force.addScaledVector(toPrev.normalize(), kgPerM * 9.81 * hanging * 0.25);
    }
    this.rebuild();
  }

  private rebuild() {
    const curve = new THREE.CatmullRomCurve3(this.pts);
    const old = this.mesh.geometry;
    this.mesh.geometry = new THREE.TubeGeometry(curve, this.n * 2, 0.022, 6, false);
    old.dispose();
  }
}
