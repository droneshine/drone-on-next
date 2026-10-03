import * as THREE from 'three';
import { ColliderWorld } from './colliders';
import { fbm, mulberry } from './noise';

// An office block whose west facade carries a live grime map. The DShine lance
// cuts through it with a real nozzle footprint; glass and render clean differently.

export class FacadeBlock {
  group = new THREE.Group();
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  tex: THREE.CanvasTexture;
  // facade plane: x = planeX, spans z in [z0,z1], y in [0,h]
  planeX: number; z0: number; z1: number; h: number;
  private dirtyTex = false;
  private initSum = 0;
  private sampleCache: Uint8ClampedArray | null = null;
  private sampleAge = 0;
  W = 1024; H = 512;
  /** dirty work zone in texture space */
  static ZONE = { u0: 1 / 3, u1: 2 / 3, v0: 0.5 };
  zoneCenter() { return new THREE.Vector3(this.planeX - 3, this.h * (1 - (1 + FacadeBlock.ZONE.v0) / 2), this.z0 + (this.z1 - this.z0) * (FacadeBlock.ZONE.u0 + FacadeBlock.ZONE.u1) / 2); }

  constructor(private colliders: ColliderWorld, x = 168, z = 20, width = 44, depth = 18, height = 22) {
    this.planeX = x - depth / 2;
    this.z0 = z - width / 2; this.z1 = z + width / 2; this.h = height;
    this.canvas = document.createElement('canvas');
    this.canvas.width = this.W; this.canvas.height = this.H;
    this.ctx = this.canvas.getContext('2d', { willReadFrequently: true })!;
    this.paintGrime();
    this.tex = new THREE.CanvasTexture(this.canvas);
    this.tex.colorSpace = THREE.NoColorSpace;
    this.tex.anisotropy = 8;

    // body
    const bodyMat = new THREE.MeshStandardMaterial({ color: '#cfcabd', roughness: 0.9 });
    const body = new THREE.Mesh(new THREE.BoxGeometry(depth, height, width), bodyMat);
    body.position.set(x, height / 2, z);
    body.castShadow = body.receiveShadow = true;
    body.userData.temp = 0.5;
    this.group.add(body);
    colliders.add({ kind: 'box', half: new THREE.Vector3(depth / 2, height / 2, width / 2) }, body.position.clone(), undefined, { tag: 'facade', surface: 'hard' });

    // the dirty facade skin with windows, slightly in front of the body
    const skinMat = new THREE.MeshStandardMaterial({ map: facadeTexture(), roughness: 0.8, metalness: 0.0 });
    const grime = this.tex;
    skinMat.onBeforeCompile = (sh) => {
      sh.uniforms.uGrime = { value: grime };
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <common>', '#include <common>\nuniform sampler2D uGrime;')
        .replace('#include <map_fragment>', `
          #include <map_fragment>
          vec4 gm = texture2D(uGrime, vMapUv);
          float g = gm.r * gm.a;
          float glass = step(0.5, sampledDiffuseColor.a) < 0.5 ? 1.0 : 0.0;
          // grime streaks are darker under ledges and rain runs
          vec3 grimeCol = mix(vec3(0.33, 0.31, 0.26), vec3(0.20, 0.21, 0.17), gm.g);
          diffuseColor.rgb = mix(diffuseColor.rgb, grimeCol, g * mix(0.85, 0.65, glass));
          float isGlass = glass; diffuseColor.a = 1.0;
        `)
        .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\nroughnessFactor = mix(mix(0.85, 0.06, isGlass), 0.9, g);')
        .replace('#include <metalnessmap_fragment>', '#include <metalnessmap_fragment>\nmetalnessFactor = mix(0.0, 0.6, isGlass * (1.0 - g));');
    };
    const skin = new THREE.Mesh(new THREE.PlaneGeometry(width, height), skinMat);
    skin.rotation.y = -Math.PI / 2;
    skin.position.set(this.planeX - 0.02, height / 2, z);
    skin.receiveShadow = true;
    skin.userData.temp = 0.52;
    this.group.add(skin);

    // parapet, roof plant, rooftop PV
    const roofMat = new THREE.MeshStandardMaterial({ color: '#8e918c', roughness: 0.9 });
    const roof = new THREE.Mesh(new THREE.BoxGeometry(depth + 0.4, 1.0, width + 0.4), roofMat);
    roof.position.set(x, height + 0.5, z);
    roof.castShadow = true;
    this.group.add(roof);
    colliders.add({ kind: 'box', half: new THREE.Vector3(depth / 2 + 0.2, 0.5, width / 2 + 0.2) }, roof.position.clone());
    const plant = new THREE.Mesh(new THREE.BoxGeometry(4, 2.4, 6), new THREE.MeshStandardMaterial({ color: '#b9bcb6', roughness: 0.5, metalness: 0.4 }));
    plant.position.set(x + 3, height + 2.2, z + 12);
    plant.castShadow = true; plant.userData.temp = 0.75;
    this.group.add(plant);
    colliders.add({ kind: 'box', half: new THREE.Vector3(2, 1.2, 3) }, plant.position.clone());

    // second building: a glass tower behind, pure obstacle and skyline
    const towerMat = new THREE.MeshStandardMaterial({ color: '#4f6a72', roughness: 0.08, metalness: 0.9, envMapIntensity: 1.4 });
    const tower = new THREE.Mesh(new THREE.BoxGeometry(22, 64, 22), towerMat);
    tower.position.set(x + 48, 32, z - 52);
    tower.castShadow = tower.receiveShadow = true;
    this.group.add(tower);
    colliders.add({ kind: 'box', half: new THREE.Vector3(11, 32, 11) }, tower.position.clone(), undefined, { surface: 'glass' });
    const fins = new THREE.InstancedMesh(new THREE.BoxGeometry(0.25, 64, 0.6), new THREE.MeshStandardMaterial({ color: '#d4d6d2', roughness: 0.5 }), 44);
    const mm = new THREE.Matrix4();
    for (let i = 0; i < 11; i++) {
      const o = -11 + 1 + i * 2;
      mm.makeTranslation(x + 48 + o, 32, z - 52 - 11.2); fins.setMatrixAt(i, mm);
      mm.makeTranslation(x + 48 + o, 32, z - 52 + 11.2); fins.setMatrixAt(11 + i, mm);
      mm.makeTranslation(x + 48 - 11.2, 32, z - 52 + o); fins.setMatrixAt(22 + i, mm);
      mm.makeTranslation(x + 48 + 11.2, 32, z - 52 + o); fins.setMatrixAt(33 + i, mm);
    }
    fins.castShadow = true;
    this.group.add(fins);

    // ground pump trailer for the hose
    const pump = new THREE.Group();
    const trailer = new THREE.Mesh(new THREE.BoxGeometry(2.2, 1.2, 3.4), new THREE.MeshStandardMaterial({ color: '#0f4a2b', roughness: 0.5 }));
    trailer.position.y = 0.9; trailer.castShadow = true;
    pump.add(trailer);
    const tank = new THREE.Mesh(new THREE.CylinderGeometry(0.7, 0.7, 2.6, 18), new THREE.MeshStandardMaterial({ color: '#f2f2ee', roughness: 0.4 }));
    tank.rotation.x = Math.PI / 2; tank.position.set(0, 2.0, 0); tank.castShadow = true;
    pump.add(tank);
    for (const s of [-1, 1]) {
      const wheel = new THREE.Mesh(new THREE.CylinderGeometry(0.4, 0.4, 0.25, 16), new THREE.MeshStandardMaterial({ color: '#1a1a1a', roughness: 0.9 }));
      wheel.rotation.z = Math.PI / 2; wheel.position.set(s * 1.2, 0.4, 0);
      pump.add(wheel);
    }
    pump.position.set(this.planeX - 24, 0, z + 6);
    pump.userData.temp = 0.7;
    this.group.add(pump);
    colliders.add({ kind: 'box', half: new THREE.Vector3(1.1, 1.5, 1.7) }, new THREE.Vector3(pump.position.x, 1.5, pump.position.z));
    this.pumpAnchor = new THREE.Vector3(pump.position.x, 2.2, pump.position.z - 1.6);
  }

  pumpAnchor: THREE.Vector3;

  private pristine: ImageData | null = null;
  private dirty = false;

  /** fresh dirt for a new attempt: the painted original is kept, so a reset is a single copy */
  resetGrime() {
    if (!this.dirty) return;
    if (this.pristine) this.ctx.putImageData(this.pristine, 0, 0); else this.paintGrime();
    this.dirty = false;
    this.tex.needsUpdate = true;
  }

  private paintGrime() {
    const g = this.ctx, W = this.W, H = this.H;
    const img = g.createImageData(W, H);
    const rnd = mulberry(9);
    let sum = 0;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      const fy = y / H;
      // rain runs: vertical streak noise, heavier toward the bottom and under each floor ledge
      const streak = fbm(x * 0.09, y * 0.006, 3);
      const ledge = Math.pow(1 - ((fy * 6) % 1), 6) * 0.35;
      let d = 0.35 + streak * 0.5 + fy * 0.18 + ledge + fbm(x * 0.01, y * 0.01, 3) * 0.25 - 0.3;
      d = Math.min(1, Math.max(0, d + (rnd() - 0.5) * 0.06));
      // the job: four bays over the lower three floors, soft edged like real soiling
      const fx = x / W;
      const zx = Math.min(1, Math.max(0, Math.min(fx - FacadeBlock.ZONE.u0, FacadeBlock.ZONE.u1 - fx) * 40));
      const zy = Math.min(1, Math.max(0, (fy - FacadeBlock.ZONE.v0) * 40));
      d *= zx * zy;
      img.data[i] = d * 255;
      img.data[i + 1] = streak * 255;
      img.data[i + 2] = 0; img.data[i + 3] = 255;
      sum += d;
    }
    g.putImageData(img, 0, 0);
    this.pristine = img;
    this.initSum = sum;
  }

  /** world point on the facade to canvas pixel */
  private toPx(p: THREE.Vector3) {
    // plane faces -x; texture u runs along +z when viewed from the west... plane rotated -90deg: u increases toward -z
    const u = (p.z - this.z0) / (this.z1 - this.z0);
    const v = 1 - p.y / this.h;
    return { x: u * this.W, y: v * this.H };
  }

  hit(o: THREE.Vector3, d: THREE.Vector3, maxT: number): { t: number; p: THREE.Vector3 } | null {
    if (Math.abs(d.x) < 1e-4) return null;
    const t = (this.planeX - o.x) / d.x;
    if (t < 0 || t > maxT) return null;
    const p = o.clone().addScaledVector(d, t);
    if (p.z < this.z0 || p.z > this.z1 || p.y < 0 || p.y > this.h) return null;
    return { t, p };
  }

  /** Clean with a soft round footprint. radius in metres. */
  cleanAt(p: THREE.Vector3, radius: number, strength: number) {
    this.dirty = true;
    const c = this.toPx(p);
    const pxPerM = this.W / (this.z1 - this.z0);
    const r = radius * pxPerM;
    const g = this.ctx;
    g.save();
    g.globalCompositeOperation = 'destination-out';
    const grd = g.createRadialGradient(c.x, c.y, 0, c.x, c.y, r);
    grd.addColorStop(0, `rgba(0,0,0,${Math.min(1, strength)})`);
    grd.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = grd;
    g.beginPath(); g.arc(c.x, c.y, r, 0, Math.PI * 2); g.fill();
    g.restore();
    // keep alpha opaque but red reduced: re-composite onto black base
    this.dirtyTex = true;
  }

  update() {
    if (this.dirtyTex) {
      // destination-out lowers alpha, convert alpha into the red channel the shader reads
      this.tex.needsUpdate = true;
      this.dirtyTex = false;
      this.sampleAge++;
    }
  }

  cleanliness(): number {
    // sample a sparse grid of the canvas, cheap enough to call twice a second
    const data = this.ctx.getImageData(0, 0, this.W, this.H).data;
    let s = 0;
    for (let i = 0; i < data.length; i += 4 * 7) s += (data[i] / 255) * (data[i + 3] / 255);
    const est = s * 7;
    void this.sampleCache;
    return Math.max(0, Math.min(1, 1 - est / this.initSum));
  }
}

function facadeTexture() {
  // render plaster with a 6 floor window grid; alpha 0 marks glass for the shader
  const c = document.createElement('canvas');
  c.width = 1024; c.height = 512;
  const g = c.getContext('2d')!;
  g.fillStyle = '#d8d3c6'; g.fillRect(0, 0, 1024, 512);
  const floors = 6, bays = 12;
  const fh = 512 / floors, bw = 1024 / bays;
  for (let f = 0; f < floors; f++) {
    // floor ledge
    g.fillStyle = '#d6d1c4'; g.fillRect(0, f * fh + fh - 6, 1024, 6);
    for (let b = 0; b < bays; b++) {
      const x = b * bw + bw * 0.16, y = f * fh + fh * 0.18, w = bw * 0.68, h = fh * 0.6;
      if (f === floors - 1 && (b === 5 || b === 6)) {
        // entrance
        g.fillStyle = '#2d3a3e'; g.fillRect(x, y - fh * 0.1, w, h + fh * 0.22);
        continue;
      }
      g.fillStyle = '#3a4a50';
      g.fillRect(x - 3, y - 3, w + 6, h + 6);
      g.clearRect(x, y, w, h);
      // glass tint stored in rgb, alpha zero marks glass
      g.fillStyle = 'rgba(70,95,110,0.0)';
      g.fillRect(x, y, w, h);
      g.fillStyle = '#3a4a50'; g.fillRect(x + w / 2 - 2, y, 4, h);
    }
  }
  // glass pixels: give them a colour but keep alpha low (0.3) so the shader can detect
  const img = g.getImageData(0, 0, 1024, 512);
  for (let i = 0; i < img.data.length; i += 4) {
    if (img.data[i + 3] < 10) { img.data[i] = 48; img.data[i + 1] = 72; img.data[i + 2] = 86; img.data[i + 3] = 60; }
  }
  g.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.premultiplyAlpha = false;
  t.anisotropy = 8;
  return t;
}
