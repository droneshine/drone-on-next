import * as THREE from 'three';
import { World } from '../world/world';
import { Collider, Shape } from '../world/colliders';
import { COL } from '../world/props';

// Creative mode. Pieces are data first ({type, position, yaw, scale}) so a whole
// map fits into a share link. Rings and gates double as race checkpoints in the
// order you place them.

export type PieceType = 'ring' | 'bigring' | 'gate' | 'cube' | 'platform' | 'ramp' | 'pillar' | 'wall' | 'container' | 'panels' | 'tree' | 'flag';

export interface Piece { t: PieceType; x: number; y: number; z: number; r: number; s: number; }
export interface MapData { v: 1; name: string; author: string; pieces: Piece[]; race: boolean; }

export const PIECES: { t: PieceType; label: string; key: string }[] = [
  { t: 'ring', label: 'Ring', key: '1' },
  { t: 'gate', label: 'Gate', key: '2' },
  { t: 'bigring', label: 'Big ring', key: '3' },
  { t: 'cube', label: 'Cube', key: '4' },
  { t: 'platform', label: 'Platform', key: '5' },
  { t: 'ramp', label: 'Ramp', key: '6' },
  { t: 'pillar', label: 'Pillar', key: '7' },
  { t: 'wall', label: 'Wall', key: '8' },
  { t: 'container', label: 'Container', key: '9' },
  { t: 'panels', label: 'Solar table', key: '0' },
  { t: 'tree', label: 'Tree', key: 'T' },
  { t: 'flag', label: 'Start', key: 'G' },
];

const matCache: Record<string, THREE.Material> = {};
function mat(key: string, make: () => THREE.Material) { return matCache[key] ??= make(); }

interface Built { obj: THREE.Object3D; shapes: { shape: Shape; pos: THREE.Vector3; quat: THREE.Quaternion }[]; checkpoint?: { pos: THREE.Vector3; quat: THREE.Quaternion; R: number }; }

export function buildPiece(p: Piece): Built {
  const g = new THREE.Group();
  const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), THREE.MathUtils.degToRad(p.r));
  const s = p.s || 1;
  const shapes: Built['shapes'] = [];
  const add = (mesh: THREE.Mesh, shape: Shape | null, local = new THREE.Vector3(), lq = new THREE.Quaternion()) => {
    mesh.position.copy(local); mesh.quaternion.copy(lq);
    mesh.castShadow = mesh.receiveShadow = true;
    g.add(mesh);
    if (shape) shapes.push({ shape, pos: local.clone().multiplyScalar(s).applyQuaternion(q).add(new THREE.Vector3(p.x, p.y, p.z)), quat: q.clone().multiply(lq) });
  };
  const sc = (v: THREE.Vector3) => v.multiplyScalar(s);
  let checkpoint: Built['checkpoint'];
  switch (p.t) {
    case 'ring': case 'bigring': {
      const R = p.t === 'ring' ? 2.6 : 5;
      const m = new THREE.Mesh(new THREE.TorusGeometry(R, 0.18, 12, 64), mat('ring', () => new THREE.MeshStandardMaterial({ color: COL.light, emissive: COL.light, emissiveIntensity: 2.2, roughness: 0.3 })));
      add(m, { kind: 'torus', R: R * s, r: 0.18 * s }, new THREE.Vector3(0, R + 0.4, 0));
      checkpoint = { pos: new THREE.Vector3(p.x, p.y + (R + 0.4) * s, p.z), quat: q, R: R * s };
      break;
    }
    case 'gate': {
      const w = mat('gateW', () => new THREE.MeshStandardMaterial({ color: COL.off, roughness: 0.5 }));
      const a = mat('gateA', () => new THREE.MeshStandardMaterial({ color: COL.accent, emissive: COL.accent, emissiveIntensity: 0.3 }));
      add(new THREE.Mesh(new THREE.BoxGeometry(0.2, 3.2, 0.2), w), { kind: 'box', half: sc(new THREE.Vector3(0.1, 1.6, 0.1)) }, new THREE.Vector3(-1.6, 1.6, 0));
      add(new THREE.Mesh(new THREE.BoxGeometry(0.2, 3.2, 0.2), w), { kind: 'box', half: sc(new THREE.Vector3(0.1, 1.6, 0.1)) }, new THREE.Vector3(1.6, 1.6, 0));
      add(new THREE.Mesh(new THREE.BoxGeometry(3.4, 0.25, 0.25), a), { kind: 'box', half: sc(new THREE.Vector3(1.7, 0.125, 0.125)) }, new THREE.Vector3(0, 3.2, 0));
      checkpoint = { pos: new THREE.Vector3(p.x, p.y + 1.6 * s, p.z), quat: q, R: 1.5 * s };
      break;
    }
    case 'cube': add(new THREE.Mesh(new THREE.BoxGeometry(2, 2, 2), mat('cube', () => new THREE.MeshStandardMaterial({ color: '#d9d6cc', roughness: 0.8 }))), { kind: 'box', half: sc(new THREE.Vector3(1, 1, 1)) }, new THREE.Vector3(0, 1, 0)); break;
    case 'platform': add(new THREE.Mesh(new THREE.BoxGeometry(6, 0.4, 6), mat('plat', () => new THREE.MeshStandardMaterial({ color: '#53605a', roughness: 0.7 }))), { kind: 'box', half: sc(new THREE.Vector3(3, 0.2, 3)) }, new THREE.Vector3(0, 0.2, 0)); break;
    case 'ramp': {
      const lq = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -0.38);
      add(new THREE.Mesh(new THREE.BoxGeometry(5, 0.3, 9), mat('ramp', () => new THREE.MeshStandardMaterial({ color: '#6a706b', roughness: 0.85 }))), { kind: 'box', half: sc(new THREE.Vector3(2.5, 0.15, 4.5)) }, new THREE.Vector3(0, 1.7, 0), lq);
      break;
    }
    case 'pillar': add(new THREE.Mesh(new THREE.CylinderGeometry(0.6, 0.6, 12, 16), mat('pillar', () => new THREE.MeshStandardMaterial({ color: '#c9c5ba', roughness: 0.7 }))), { kind: 'cyl', radius: 0.6 * s, halfH: 6 * s }, new THREE.Vector3(0, 6, 0)); break;
    case 'wall': add(new THREE.Mesh(new THREE.BoxGeometry(8, 4, 0.4), mat('wall', () => new THREE.MeshStandardMaterial({ color: '#8d8a83', roughness: 0.9 }))), { kind: 'box', half: sc(new THREE.Vector3(4, 2, 0.2)) }, new THREE.Vector3(0, 2, 0)); break;
    case 'container': {
      const c = ['#004225', '#8fc2f5', '#c94f2a', '#e7e3d6'][Math.abs(Math.round(p.x + p.z)) % 4];
      add(new THREE.Mesh(new THREE.BoxGeometry(6.06, 2.59, 2.44), mat('cont' + c, () => new THREE.MeshStandardMaterial({ color: c, roughness: 0.6, metalness: 0.3 }))), { kind: 'box', half: sc(new THREE.Vector3(3.03, 1.3, 1.22)) }, new THREE.Vector3(0, 1.3, 0));
      break;
    }
    case 'panels': {
      const lq = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), 0.44);
      add(new THREE.Mesh(new THREE.BoxGeometry(7, 0.05, 4.6), mat('pv', () => new THREE.MeshStandardMaterial({ color: '#13264a', roughness: 0.15, metalness: 0.4 }))), { kind: 'box', half: sc(new THREE.Vector3(3.5, 0.06, 2.3)) }, new THREE.Vector3(0, 1.75, 0), lq);
      add(new THREE.Mesh(new THREE.BoxGeometry(7, 1.2, 0.1), mat('rack', () => new THREE.MeshStandardMaterial({ color: '#9aa1a3', metalness: 0.8, roughness: 0.45 }))), null, new THREE.Vector3(0, 0.6, 0));
      break;
    }
    case 'tree': {
      add(new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.3, 3, 6), mat('trunk', () => new THREE.MeshStandardMaterial({ color: '#4a3423', roughness: 0.9 }))), { kind: 'cyl', radius: 0.3 * s, halfH: 1.5 * s }, new THREE.Vector3(0, 1.5, 0));
      add(new THREE.Mesh(new THREE.ConeGeometry(2.2, 6, 8), mat('crown', () => new THREE.MeshStandardMaterial({ color: '#264f2f', roughness: 0.9, flatShading: true }))), { kind: 'sphere', radius: 1.8 * s }, new THREE.Vector3(0, 5.5, 0));
      break;
    }
    case 'flag': {
      add(new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 5, 8), mat('pole', () => new THREE.MeshStandardMaterial({ color: '#ddd', metalness: 0.6 }))), { kind: 'cyl', radius: 0.08 * s, halfH: 2.5 * s }, new THREE.Vector3(0, 2.5, 0));
      add(new THREE.Mesh(new THREE.PlaneGeometry(1.6, 1), mat('flagc', () => new THREE.MeshStandardMaterial({ color: COL.accent, side: THREE.DoubleSide, emissive: COL.accent, emissiveIntensity: 0.2 }))), null, new THREE.Vector3(0.8, 4.4, 0));
      const pad = new THREE.Mesh(new THREE.CylinderGeometry(2, 2, 0.08, 32), mat('startpad', () => new THREE.MeshStandardMaterial({ color: '#2a2e2b', roughness: 0.8 })));
      add(pad, { kind: 'box', half: sc(new THREE.Vector3(1.6, 0.04, 1.6)) }, new THREE.Vector3(3.4, 0.04, 0));
      break;
    }
  }
  g.position.set(p.x, p.y, p.z); g.quaternion.copy(q); g.scale.setScalar(s);
  return { obj: g, shapes, checkpoint };
}

export class Builder {
  map: MapData = { v: 1, name: 'My Spielwiese', author: 'Pilot', pieces: [], race: true };
  private built: { obj: THREE.Object3D; cols: Collider[]; checkpoint?: Built['checkpoint'] }[] = [];
  ghost: THREE.Object3D | null = null;
  selected: PieceType = 'ring';
  yaw = 0; lift = 0; scale = 1;
  active = false;
  undo: MapData['pieces'][] = [];

  constructor(private world: World) {}

  clear() {
    for (const b of this.built) { this.world.buildGroup.remove(b.obj); for (const c of b.cols) this.world.colliders.remove(c); }
    this.built = [];
    this.map.pieces = [];
  }

  load(m: MapData) {
    this.clear();
    this.map = { ...m, pieces: [] };
    for (const p of m.pieces.slice(0, 2000)) this.place(p, false);
  }

  place(p: Piece, record = true) {
    if (record) this.undo.push(this.map.pieces.slice());
    const b = buildPiece(p);
    this.world.buildGroup.add(b.obj);
    const idx = this.map.pieces.length;
    const cols = b.shapes.map(s => this.world.colliders.add(s.shape, s.pos, s.quat, { tag: 'build', data: idx }));
    this.built.push({ obj: b.obj, cols, checkpoint: b.checkpoint });
    this.map.pieces.push(p);
    // thermal pass of a later toggle should treat build pieces as ambient
    b.obj.userData.temp = 0.45;
  }

  removeAt(i: number) {
    if (i < 0 || i >= this.map.pieces.length) return;
    this.undo.push(this.map.pieces.slice());
    const pieces = this.map.pieces.filter((_, k) => k !== i);
    const meta = { ...this.map };
    this.clear();
    this.map = { ...meta, pieces: [] };
    for (const p of pieces) this.place(p, false);
  }

  undoLast() {
    const prev = this.undo.pop();
    if (!prev) return;
    const meta = { ...this.map };
    this.clear();
    this.map = { ...meta, pieces: [] };
    for (const p of prev) this.place(p, false);
  }

  checkpoints() { return this.built.map(b => b.checkpoint).filter(Boolean) as NonNullable<Built['checkpoint']>[]; }

  startPad(): { pos: THREE.Vector3; yaw: number } | null {
    const i = this.map.pieces.findIndex(p => p.t === 'flag');
    if (i < 0) return null;
    const p = this.map.pieces[i];
    const off = new THREE.Vector3(3.4 * (p.s || 1), 0.1, 0).applyAxisAngle(new THREE.Vector3(0, 1, 0), THREE.MathUtils.degToRad(p.r));
    return { pos: new THREE.Vector3(p.x, p.y, p.z).add(off), yaw: THREE.MathUtils.degToRad(p.r) + Math.PI };
  }

  setGhost(type: PieceType) {
    this.selected = type;
    if (this.ghost) this.world.scene.remove(this.ghost);
    const b = buildPiece({ t: type, x: 0, y: 0, z: 0, r: 0, s: this.scale });
    b.obj.traverse(o => {
      const m = o as THREE.Mesh;
      if (m.isMesh) { m.material = new THREE.MeshBasicMaterial({ color: COL.light, transparent: true, opacity: 0.35, depthWrite: false }); m.castShadow = false; }
    });
    this.ghost = b.obj;
    this.ghost.userData.noThermal = true;
    this.world.scene.add(this.ghost);
  }

  hideGhost() { if (this.ghost) { this.world.scene.remove(this.ghost); this.ghost = null; } }

  /** Aim from the camera: returns snapped placement or the index of the piece under the cursor. */
  aim(cam: THREE.Camera): { pos: THREE.Vector3; hitPiece: number } {
    const o = cam.getWorldPosition(new THREE.Vector3());
    const d = new THREE.Vector3(0, 0, -1).applyQuaternion(cam.getWorldQuaternion(new THREE.Quaternion()));
    const hit = this.world.colliders.raycast(o, d, 160);
    const t = isFinite(hit.t) ? hit.t : 40;
    const p = o.clone().addScaledVector(d, Math.min(t, 160));
    const snap = 0.5;
    p.x = Math.round(p.x / snap) * snap; p.z = Math.round(p.z / snap) * snap;
    p.y = Math.max(this.world.colliders.heightAt(p.x, p.z), Math.round((p.y - 0.05) / snap) * snap) + this.lift;
    const hitPiece = hit.c && hit.c.tag === 'build' ? (hit.c.data as number) : -1;
    if (this.ghost) {
      this.ghost.position.copy(p);
      this.ghost.rotation.y = THREE.MathUtils.degToRad(this.yaw);
      this.ghost.scale.setScalar(this.scale);
    }
    return { pos: p, hitPiece };
  }
}

/** A starter course so the Spielwiese is never empty. */
export function starterMap(): MapData {
  const pieces: Piece[] = [
    { t: 'flag', x: -150, y: 0, z: 34, r: 180, s: 1 },
  ];
  const n = 10;
  for (let i = 0; i < n; i++) {
    const a = i / n * Math.PI * 2;
    pieces.push({ t: i % 3 === 2 ? 'gate' : 'ring', x: -150 + Math.sin(a) * 34, y: 0, z: 70 - Math.cos(a) * 26, r: -THREE.MathUtils.radToDeg(a) + 90, s: 1 });
  }
  pieces.push({ t: 'ramp', x: -150, y: 0, z: 72, r: 0, s: 1 }, { t: 'container', x: -132, y: 0, z: 68, r: 30, s: 1 }, { t: 'pillar', x: -165, y: 0, z: 75, r: 0, s: 1 });
  return { v: 1, name: 'Starter loop', author: 'DroneShine', pieces, race: true };
}
