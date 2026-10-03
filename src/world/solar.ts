import * as THREE from 'three';
import { ColliderWorld } from './colliders';
import { mulberry, fbm } from './noise';

// A real looking ground mounted PV park. Every module carries its own soiling
// map in a shared atlas, so cleaning leaves actual wet, clean lanes behind.

export const PANEL_W = 1.134, PANEL_H = 2.278, GAP = 0.02;
const TILT = THREE.MathUtils.degToRad(25);
const TEX_U = 8, TEX_V = 16;          // soiling texels per module
const ATLAS_COLS = 128;

export interface Hotspot { panel: number; u: number; v: number; world: THREE.Vector3; found: boolean; }

export class SolarPark {
  group = new THREE.Group();
  rows: { z: number; x0: number; x1: number; zone: string }[] = [];
  panels: { row: number; col: number; tier: number; center: THREE.Vector3 }[] = [];
  atlas: THREE.DataTexture;
  atlasData: Uint8Array;
  atlasW: number; atlasH: number;
  hotspots: Hotspot[] = [];
  mesh!: THREE.InstancedMesh;
  material!: THREE.MeshStandardMaterial;
  uniforms = { uAtlas: { value: null as THREE.Texture | null }, uThermal: { value: 0 }, uTime: { value: 0 }, uAtlasSize: { value: new THREE.Vector2() } };
  private dirty = false;
  private initialDirt: Float32Array;
  normal = new THREE.Vector3(0, Math.cos(TILT), Math.sin(TILT));
  slope = new THREE.Vector3(0, -Math.sin(TILT), Math.cos(TILT)); // down the module, toward the low edge
  cx = 0; cz = -170;

  constructor(private colliders: ColliderWorld, opts: { rows?: number; cols?: number; cx?: number; cz?: number } = {}) {
    const nRows = opts.rows ?? 12, nCols = opts.cols ?? 100;
    this.cx = opts.cx ?? 0; this.cz = opts.cz ?? -170;
    const spacing = 10;
    const z0 = this.cz - (nRows - 1) * spacing / 2;
    for (let r = 0; r < nRows; r++) {
      const len = nCols * (PANEL_W + GAP);
      this.rows.push({ z: z0 + r * spacing, x0: this.cx - len / 2, x1: this.cx + len / 2, zone: String.fromCharCode(65 + r) });
    }
    const total = nRows * nCols * 2;
    this.atlasW = ATLAS_COLS * TEX_U;
    this.atlasH = Math.ceil(total / ATLAS_COLS) * TEX_V;
    this.atlasData = new Uint8Array(this.atlasW * this.atlasH);
    this.initialDirt = new Float32Array(total);
    this.atlas = new THREE.DataTexture(this.atlasData, this.atlasW, this.atlasH, THREE.RedFormat, THREE.UnsignedByteType);
    this.atlas.magFilter = THREE.LinearFilter; this.atlas.minFilter = THREE.LinearFilter;
    this.atlas.needsUpdate = true;
    this.uniforms.uAtlas.value = this.atlas;
    this.uniforms.uAtlasSize.value.set(this.atlasW, this.atlasH);
    this.build(nCols);
    this.soil(1);
  }

  /** Low edge height of the table above ground. */
  static LOW = 0.75;

  private tableCenterY() { return SolarPark.LOW + Math.sin(TILT) * (PANEL_H + GAP / 2); }

  private build(nCols: number) {
    const geo = new THREE.BoxGeometry(PANEL_W, 0.035, PANEL_H);
    // only the top face gets uv 0..1 meaning, others are fine as is
    const mat = new THREE.MeshStandardMaterial({ map: panelTexture(), roughness: 0.18, metalness: 0.25, envMapIntensity: 1.25 });
    const u = this.uniforms;
    mat.onBeforeCompile = (sh) => {
      Object.assign(sh.uniforms, u);
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', '#include <common>\nattribute vec2 aAtlas; attribute vec4 aHot; varying vec2 vAtlasUv; varying vec2 vPUv; varying vec4 vHot; varying float vTop;')
        .replace('#include <uv_vertex>', '#include <uv_vertex>\nvPUv = uv; vHot = aHot; vTop = step(0.5, normal.y); vAtlasUv = aAtlas;');
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <common>', `#include <common>
          uniform sampler2D uAtlas; uniform float uThermal; uniform float uTime; uniform vec2 uAtlasSize;
          varying vec2 vAtlasUv; varying vec2 vPUv; varying vec4 vHot; varying float vTop;
          vec3 ironbow(float t){ t=clamp(t,0.,1.);
            return clamp(vec3(1.5*t-0.1, t*t*1.4-0.25+0.2*smoothstep(0.85,1.,t), 0.5*sin(t*3.6)+ (t>0.85?(t-0.85)*5.:0.)), 0., 1.); }
          float hash12(vec2 p){ return fract(sin(dot(p, vec2(41.3, 289.1))) * 43758.5); }`)
        .replace('#include <map_fragment>', `
          #include <map_fragment>
          vec2 auv = (vAtlasUv + vec2(vPUv.x, 1.0 - vPUv.y) * vec2(${TEX_U}.0, ${TEX_V}.0)) / uAtlasSize;
          float dirt = vTop * texture2D(uAtlas, auv).r;
          // dust is not uniform: heavier toward the low edge and along the frame
          float grain = hash12(floor(vPUv * vec2(90., 180.)));
          float d = clamp(dirt * (0.75 + 0.35 * grain) * (0.7 + 0.5 * (1.0 - vPUv.y)), 0., 1.);
          vec3 dust = mix(vec3(0.55, 0.47, 0.36), vec3(0.42, 0.38, 0.30), grain);
          diffuseColor.rgb = mix(diffuseColor.rgb, dust, d * 0.88);
          float soilRough = d;
        `)
        .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\nroughnessFactor = mix(roughnessFactor, 0.95, soilRough);')
        .replace('#include <dithering_fragment>', `#include <dithering_fragment>
          if (uThermal > 0.5) {
            float t = 0.42 + 0.06 * hash12(floor(vPUv * vec2(6., 10.)));
            t += d * 0.1;
            // hotspot: one hot cell, bright core
            vec2 hc = vHot.xy;
            float hd = length((vPUv - hc) * vec2(1.0, 2.0));
            // a failed bypass diode heats one substring, a third of the module, plus the hot cell itself
            float sub = step(0.001, vHot.z) * step(floor(hc.x * 3.0), floor(vPUv.x * 3.0)) * step(floor(vPUv.x * 3.0), floor(hc.x * 3.0));
            t += sub * 0.22 + vHot.z * (smoothstep(0.16, 0.0, hd) * 0.5 + smoothstep(0.55, 0.0, hd) * 0.15);
            t = mix(0.15, t, vTop);
            gl_FragColor = vec4(ironbow(t), 1.0);
          }`);
    };
    this.material = mat;

    const count = this.rows.length * nCols * 2;
    const mesh = new THREE.InstancedMesh(geo, mat, count);
    const aAtlas = new Float32Array(count * 2);
    const aHot = new Float32Array(count * 4);
    const m = new THREE.Matrix4(), q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), TILT);
    const cy = this.tableCenterY();
    let i = 0;
    const rnd = mulberry(77);
    for (let r = 0; r < this.rows.length; r++) {
      const row = this.rows[r];
      for (let c = 0; c < nCols; c++) {
        for (let tier = 0; tier < 2; tier++) {
          const x = row.x0 + (c + 0.5) * (PANEL_W + GAP);
          // tier 0 = upper module, tier 1 = lower module along the slope
          const off = (tier === 0 ? -0.5 : 0.5) * (PANEL_H + GAP);
          const p = new THREE.Vector3(x, cy, row.z).addScaledVector(this.slope, off);
          m.compose(p, q, new THREE.Vector3(1, 1, 1));
          mesh.setMatrixAt(i, m);
          aAtlas[i * 2] = (i % ATLAS_COLS) * TEX_U;
          aAtlas[i * 2 + 1] = Math.floor(i / ATLAS_COLS) * TEX_V;
          this.panels.push({ row: r, col: c, tier, center: p });
          i++;
        }
      }
    }
    // hotspots
    const picks = new Set<number>();
    while (picks.size < 10) picks.add(Math.floor(rnd() * count));
    for (const pi of picks) {
      const hu = 0.15 + rnd() * 0.7, hv = 0.1 + rnd() * 0.8;
      aHot[pi * 4] = hu; aHot[pi * 4 + 1] = hv; aHot[pi * 4 + 2] = 0.8 + rnd() * 0.4;
      const pc = this.panels[pi].center;
      const w = pc.clone().add(new THREE.Vector3((hu - 0.5) * PANEL_W, 0, 0)).addScaledVector(this.slope, (hv - 0.5) * PANEL_H);
      this.hotspots.push({ panel: pi, u: hu, v: hv, world: w, found: false });
    }
    geo.setAttribute('aAtlas', new THREE.InstancedBufferAttribute(aAtlas, 2));
    geo.setAttribute('aHot', new THREE.InstancedBufferAttribute(aHot, 4));
    mesh.castShadow = true; mesh.receiveShadow = true;
    mesh.instanceMatrix.needsUpdate = true;
    mesh.computeBoundingSphere();
    mesh.userData.thermalSelf = true;
    this.mesh = mesh;
    this.group.add(mesh);

    // racks: posts and torque tube
    const postGeo = new THREE.BoxGeometry(0.09, 1, 0.09);
    const steel = new THREE.MeshStandardMaterial({ color: '#9aa1a3', metalness: 0.8, roughness: 0.45 });
    const perRow = Math.ceil(nCols / 4);
    const posts = new THREE.InstancedMesh(postGeo, steel, this.rows.length * perRow * 2);
    let pi = 0;
    const lowZ = Math.cos(TILT) * (PANEL_H + GAP) * 0.8, highY = cy + Math.sin(TILT) * PANEL_H * 0.8;
    for (const row of this.rows) {
      for (let k = 0; k < perRow; k++) {
        const x = row.x0 + (k * 4 + 2) * (PANEL_W + GAP);
        m.compose(new THREE.Vector3(x, SolarPark.LOW * 0.5 + 0.1, row.z + lowZ), new THREE.Quaternion(), new THREE.Vector3(1, SolarPark.LOW + 0.2, 1));
        posts.setMatrixAt(pi++, m);
        m.compose(new THREE.Vector3(x, highY * 0.5, row.z - lowZ), new THREE.Quaternion(), new THREE.Vector3(1, highY, 1));
        posts.setMatrixAt(pi++, m);
      }
      // collider for the full table
      const len = row.x1 - row.x0;
      this.colliders.add({ kind: 'box', half: new THREE.Vector3(len / 2, 0.06, PANEL_H + GAP) },
        new THREE.Vector3((row.x0 + row.x1) / 2, cy, row.z), q, { surface: 'panel', tag: 'solar' });
      this.colliders.add({ kind: 'box', half: new THREE.Vector3(len / 2, cy * 0.45, 0.6) },
        new THREE.Vector3((row.x0 + row.x1) / 2, cy * 0.45, row.z), new THREE.Quaternion(), { surface: 'hard', tag: 'rack' });
    }
    posts.castShadow = true;
    this.group.add(posts);

    // inverter stations and a fence line
    const inv = new THREE.MeshStandardMaterial({ color: '#e7e8e3', roughness: 0.6 });
    for (let k = -1; k <= 1; k += 2) {
      const b = new THREE.Mesh(new THREE.BoxGeometry(6, 2.6, 2.6), inv);
      b.position.set(this.cx + k * 72, 1.3, this.cz);
      b.castShadow = b.receiveShadow = true;
      this.group.add(b);
      this.colliders.add({ kind: 'box', half: new THREE.Vector3(3, 1.3, 1.3) }, b.position.clone());
      b.userData.temp = 0.62;
    }
    this.buildFence(nCols);
  }

  private buildFence(nCols: number) {
    const len = nCols * (PANEL_W + GAP) + 30;
    const depth = (this.rows.length - 1) * 10 + 26;
    const pts: [number, number][] = [];
    const per = (a: number, b: number) => Math.max(2, Math.round(Math.abs(b - a) / 3));
    const x0 = this.cx - len / 2, x1 = this.cx + len / 2, z0 = this.cz - depth / 2, z1 = this.cz + depth / 2;
    for (const [ax, az, bx, bz] of [[x0, z0, x1, z0], [x1, z0, x1, z1], [x1, z1, x0, z1], [x0, z1, x0, z0]]) {
      const n = per(ax === bx ? az : ax, ax === bx ? bz : bx);
      for (let i = 0; i < n; i++) {
        const t = i / n;
        const x = ax + (bx - ax) * t, z = az + (bz - az) * t;
        // gate gap at the south side facing base
        if (az === z1 && bz === z1 && Math.abs(x - this.cx) < 6) continue;
        pts.push([x, z]);
      }
    }
    const geo = new THREE.CylinderGeometry(0.04, 0.04, 2, 5);
    const mat = new THREE.MeshStandardMaterial({ color: '#6f7472', metalness: 0.6, roughness: 0.5 });
    const posts = new THREE.InstancedMesh(geo, mat, pts.length);
    const m = new THREE.Matrix4();
    pts.forEach(([x, z], i) => { m.makeTranslation(x, 1, z); posts.setMatrixAt(i, m); });
    this.group.add(posts);
    // mesh panels as one transparent ribbon per side
    const wireMat = new THREE.MeshStandardMaterial({ color: '#808784', transparent: true, opacity: 0.35, alphaMap: meshTexture(), side: THREE.DoubleSide, depthWrite: false });
    const sides: [number, number, number, number][] = [[x0, z0, x1, z0], [x1, z0, x1, z1], [x0, z1, this.cx - 6, z1], [this.cx + 6, z1, x1, z1], [x0, z0, x0, z1]];
    for (const [ax, az, bx, bz] of sides) {
      const l = Math.hypot(bx - ax, bz - az);
      const g = new THREE.PlaneGeometry(l, 1.9);
      const uv = g.attributes.uv as THREE.BufferAttribute;
      for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * l / 0.8, uv.getY(i) * 2.4);
      const w = new THREE.Mesh(g, wireMat);
      w.position.set((ax + bx) / 2, 1.05, (az + bz) / 2);
      w.rotation.y = -Math.atan2(bz - az, bx - ax);
      this.group.add(w);
      this.colliders.add({ kind: 'box', half: new THREE.Vector3(l / 2, 1, 0.05) }, w.position.clone(), w.quaternion.clone(), { surface: 'soft', tag: 'fence' });
    }
  }

  /** Paint soiling, level 0..1 with natural variation. */
  soil(level: number, seed = 3) {
    const rnd = mulberry(seed);
    for (let i = 0; i < this.panels.length; i++) {
      const base = level * (0.55 + 0.45 * fbm(this.panels[i].center.x * 0.05, this.panels[i].center.z * 0.05, 3) + (rnd() - 0.5) * 0.15);
      const ax = (i % ATLAS_COLS) * TEX_U, ay = Math.floor(i / ATLAS_COLS) * TEX_V;
      let sum = 0;
      for (let v = 0; v < TEX_V; v++) for (let u = 0; u < TEX_U; u++) {
        const d = Math.min(1, Math.max(0, base * (0.8 + 0.35 * (v / TEX_V)) + (rnd() - 0.5) * 0.08));
        this.atlasData[(ay + v) * this.atlasW + ax + u] = d * 255;
        sum += d;
      }
      this.initialDirt[i] = sum;
    }
    this.atlas.needsUpdate = true;
  }

  /** Clean around a world point on module surface. Returns grams of dust removed, roughly. */
  cleanAt(p: THREE.Vector3, radius: number, strength: number): number {
    const row = this.rowAt(p.z);
    if (row < 0) return 0;
    const r = this.rows[row];
    const cy = this.tableCenterY();
    const local = p.clone().sub(new THREE.Vector3(0, cy, r.z));
    const along = local.dot(this.slope);            // -H..H, upper tier negative
    if (Math.abs(local.dot(this.normal)) > 0.5) return 0;
    let removed = 0;
    const texel = PANEL_W / TEX_U;
    const rad = Math.ceil(radius / texel) + 1;
    const nCols = Math.round((r.x1 - r.x0) / (PANEL_W + GAP));
    for (let dv = -rad; dv <= rad; dv++) for (let du = -rad; du <= rad; du++) {
      const wx = p.x + du * texel, ws = along + dv * texel;
      const dist = Math.hypot(du * texel, dv * texel);
      if (dist > radius) continue;
      const col = Math.floor((wx - r.x0) / (PANEL_W + GAP));
      if (col < 0 || col >= nCols) continue;
      const tier = ws < 0 ? 0 : 1;
      const vInPanel = (ws - (tier === 0 ? -(PANEL_H + GAP) : 0)) / PANEL_H;
      if (vInPanel < 0 || vInPanel >= 1) continue;
      const uInPanel = (wx - r.x0 - col * (PANEL_W + GAP)) / PANEL_W;
      if (uInPanel < 0 || uInPanel >= 1) continue;
      const pi = (row * nCols + col) * 2 + tier;
      const ax = (pi % ATLAS_COLS) * TEX_U + Math.floor(uInPanel * TEX_U);
      const ay = Math.floor(pi / ATLAS_COLS) * TEX_V + Math.floor(vInPanel * TEX_V);
      const idx = ay * this.atlasW + ax;
      const cur = this.atlasData[idx];
      if (cur === 0) continue;
      const fall = 1 - dist / radius;
      const next = Math.max(0, cur - strength * 255 * fall);
      removed += (cur - next) / 255;
      this.atlasData[idx] = next;
    }
    if (removed > 0) this.dirty = true;
    return removed;
  }

  rowAt(z: number) {
    for (let i = 0; i < this.rows.length; i++) if (Math.abs(z - this.rows[i].z) < 3.2) return i;
    return -1;
  }

  /** Analytic ray hit against module planes. */
  raycast(o: THREE.Vector3, d: THREE.Vector3, maxT: number): { t: number; p: THREE.Vector3; row: number } | null {
    const cy = this.tableCenterY();
    let best: { t: number; p: THREE.Vector3; row: number } | null = null;
    const denom = d.dot(this.normal);
    if (Math.abs(denom) < 1e-4) return null;
    for (let i = 0; i < this.rows.length; i++) {
      const r = this.rows[i];
      const c = new THREE.Vector3(0, cy, r.z);
      const t = c.clone().sub(o).dot(this.normal) / denom;
      if (t < 0 || t > maxT || (best && t > best.t)) continue;
      const p = o.clone().addScaledVector(d, t);
      const s = p.clone().sub(c).dot(this.slope);
      if (Math.abs(s) > PANEL_H + GAP || p.x < r.x0 || p.x > r.x1) continue;
      best = { t, p, row: i };
    }
    return best;
  }

  /** Fraction clean, optionally restricted to rows. */
  cleanliness(rows?: number[]): number {
    let cur = 0, init = 0;
    const nCols = this.panels.length / this.rows.length / 2;
    for (let i = 0; i < this.panels.length; i++) {
      const row = Math.floor(i / (nCols * 2));
      if (rows && !rows.includes(row)) continue;
      init += this.initialDirt[i];
      const ax = (i % ATLAS_COLS) * TEX_U, ay = Math.floor(i / ATLAS_COLS) * TEX_V;
      for (let v = 0; v < TEX_V; v++) for (let u = 0; u < TEX_U; u++) cur += this.atlasData[(ay + v) * this.atlasW + ax + u] / 255;
    }
    return init > 0 ? 1 - cur / init : 1;
  }

  update(t: number) {
    this.uniforms.uTime.value = t;
    if (this.dirty) { this.atlas.needsUpdate = true; this.dirty = false; }
  }
}

function panelTexture() {
  const c = document.createElement('canvas');
  c.width = 256; c.height = 512;
  const g = c.getContext('2d')!;
  g.fillStyle = '#d9dcdc'; g.fillRect(0, 0, 256, 512);
  const cols = 6, rows = 12, m = 8;
  const cw = (256 - m * 2) / cols, ch = (512 - m * 2) / rows;
  for (let r = 0; r < rows; r++) for (let k = 0; k < cols; k++) {
    const x = m + k * cw, y = m + r * ch;
    const grd = g.createLinearGradient(x, y, x + cw, y + ch);
    grd.addColorStop(0, '#0d1a33'); grd.addColorStop(1, '#13264a');
    g.fillStyle = grd; g.fillRect(x + 1, y + 1, cw - 2, ch - 2);
    // busbars
    g.fillStyle = 'rgba(190,200,210,0.55)';
    for (let b = 1; b <= 3; b++) g.fillRect(x + cw * b / 4 - 0.6, y + 1, 1.2, ch - 2);
    g.fillStyle = 'rgba(255,255,255,0.06)';
    g.fillRect(x + 1, y + ch / 2, cw - 2, 0.8);
  }
  // half cut divider
  g.fillStyle = '#c7cbcc'; g.fillRect(m, 255, 256 - m * 2, 2);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}

function meshTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d')!;
  g.fillStyle = '#000'; g.fillRect(0, 0, 64, 64);
  g.strokeStyle = '#fff'; g.lineWidth = 3;
  g.beginPath(); g.moveTo(0, 0); g.lineTo(64, 64); g.moveTo(64, 0); g.lineTo(0, 64); g.stroke();
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
}
