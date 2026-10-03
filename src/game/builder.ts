import * as THREE from 'three';
import { World } from '../world/world';
import { Collider, Shape } from '../world/colliders';
import { COL } from '../world/props';

// Creative mode. Pieces are data first ({type, position, yaw, scale}) so a whole
// map fits into a share link. Rings and gates double as race checkpoints in the
// order you place them.

export type PieceType = 'ring' | 'bigring' | 'gate' | 'cube' | 'platform' | 'ramp' | 'pillar' | 'wall' | 'container' | 'panels' | 'tree' | 'flag';

export interface Piece { t: PieceType; x: number; y: number; z: number; r: number; s: number; id?: string; }
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
      // arrow on the pad: the drone starts facing this way
      const arrow = new THREE.Mesh(new THREE.ConeGeometry(0.45, 1.1, 3), mat('startarrow', () => new THREE.MeshBasicMaterial({ color: COL.light })));
      add(arrow, null, new THREE.Vector3(3.4, 0.14, -0.6), new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -Math.PI / 2));
      arrow.castShadow = false;
      break;
    }
  }
  g.position.set(p.x, p.y, p.z); g.quaternion.copy(q); g.scale.setScalar(s);
  return { obj: g, shapes, checkpoint };
}

const TYPES = new Set<PieceType>(PIECES.map(p => p.t));
const WORLD_HALF = 740;
const num = (v: unknown) => (typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN);
const uid = () => Math.random().toString(36).slice(2, 10);

/** Validate one piece from any untrusted source (share link, file, peer). Null when unusable. */
export function sanitizePiece(raw: unknown): Piece | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (!TYPES.has(r.t as PieceType)) return null;
  const x = num(r.x), y = num(r.y), z = num(r.z), rot = num(r.r ?? 0), sc = num(r.s ?? 1);
  if (![x, y, z, rot, sc].every(Number.isFinite)) return null;
  if (Math.abs(x) > WORLD_HALF || Math.abs(z) > WORLD_HALF || y < -20 || y > 400) return null;
  return {
    t: r.t as PieceType, x: Math.round(x * 100) / 100, y: Math.round(y * 100) / 100, z: Math.round(z * 100) / 100,
    r: ((Math.round(rot) % 360) + 360) % 360, s: Math.min(4, Math.max(0.4, sc)),
    id: typeof r.id === 'string' && /^[a-z0-9]{1,16}$/i.test(r.id) ? r.id : uid(),
  };
}

/** Validate a whole map. Bad pieces are dropped; null when the data is not a map at all. */
export function sanitizeMap(raw: unknown): MapData | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (!Array.isArray(r.pieces)) return null;
  const pieces: Piece[] = [];
  const seen = new Set<string>();
  for (const p of r.pieces.slice(0, 2000)) {
    const sp = sanitizePiece(p);
    if (!sp) continue;
    if (seen.has(sp.id!)) sp.id = uid();
    seen.add(sp.id!);
    pieces.push(sp);
  }
  const str = (v: unknown, d: string) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, 40) : d);
  return { v: 1, name: str(r.name, 'Untitled course'), author: str(r.author, 'Pilot'), race: r.race !== false, pieces };
}

type UndoOp = { kind: 'placed'; id: string } | { kind: 'removed'; piece: Piece; index: number } | { kind: 'snapshot'; map: MapData };
export type BuildOp = { op: 'place'; p: Piece; index?: number } | { op: 'remove'; id: string } | { op: 'clear' } | { op: 'map'; map: MapData } | { op: 'race'; on: boolean };

function disposeObject(o: THREE.Object3D) {
  o.traverse(c => {
    const m = c as THREE.Mesh;
    if (m.isMesh) m.geometry?.dispose();
  });
}

export class Builder {
  map: MapData = { v: 1, name: 'My Spielwiese', author: 'Pilot', pieces: [], race: true };
  /** where the loaded map came from: only your own course is ever saved over your own slot */
  origin: 'own' | 'shared' | 'room' = 'own';
  private built = new Map<string, { obj: THREE.Object3D; cols: Collider[]; checkpoint?: Built['checkpoint'] }>();
  ghost: THREE.Object3D | null = null;
  private hover: THREE.BoxHelper | null = null;
  private hoverId: string | null = null;
  selected: PieceType = 'ring';
  yaw = 0; lift = 0; scale = 1;
  active = false;
  private undo: UndoOp[] = [];
  /** fired for user edits only, multiplayer mirrors them */
  onOp: ((op: BuildOp) => void) | null = null;
  /** fired after any change, local or remote */
  onChanged: (() => void) | null = null;

  constructor(private world: World) {}

  private drop(id: string) {
    const b = this.built.get(id);
    if (!b) return;
    this.world.buildGroup.remove(b.obj);
    disposeObject(b.obj);
    for (const c of b.cols) this.world.colliders.remove(c);
    this.built.delete(id);
    if (this.hoverId === id) this.setHover(null);
  }

  private add(p: Piece, index?: number) {
    const b = buildPiece(p);
    b.obj.userData.temp = 0.45;
    this.world.buildGroup.add(b.obj);
    const cols = b.shapes.map(s => this.world.colliders.add(s.shape, s.pos, s.quat, { tag: 'build', data: p.id }));
    this.built.set(p.id!, { obj: b.obj, cols, checkpoint: b.checkpoint });
    if (index == null || index >= this.map.pieces.length) this.map.pieces.push(p);
    else this.map.pieces.splice(Math.max(0, index), 0, p);
  }

  /** Remove everything. With record, Ctrl+Z brings the course back. */
  clear(emit = false, record = false) {
    if (record && this.map.pieces.length) this.undo.push({ kind: 'snapshot', map: { ...this.map, pieces: this.map.pieces.slice() } });
    else if (!record) this.undo = [];
    if (emit) this.onOp?.({ op: 'clear' });
    for (const id of [...this.built.keys()]) this.drop(id);
    this.map.pieces = [];
    this.onChanged?.();
  }

  /** Load a map. Returns false and keeps the current map when the data is invalid. */
  load(raw: unknown, opts: { emit?: boolean; origin?: Builder['origin'] } = {}): boolean {
    const m = sanitizeMap(raw);
    if (!m) return false;
    if (opts.emit) this.onOp?.({ op: 'map', map: m });
    for (const id of [...this.built.keys()]) this.drop(id);
    this.map = { ...m, pieces: [] };
    for (const p of m.pieces) this.add(p);
    if (opts.origin) this.origin = opts.origin;
    this.undo = [];
    this.onChanged?.();
    return true;
  }

  /** Place a piece. User edits record undo and broadcast; remote edits do neither. */
  place(raw: Piece, opts: { record?: boolean; emit?: boolean; index?: number } = {}): Piece | null {
    const p = sanitizePiece(raw);
    if (!p || this.map.pieces.length >= 2000) return null;
    if (this.built.has(p.id!)) p.id = uid();
    this.add(p, opts.index);
    if (opts.record !== false) this.undo.push({ kind: 'placed', id: p.id! });
    if (opts.emit !== false) this.onOp?.({ op: 'place', p, index: opts.index });
    this.onChanged?.();
    return p;
  }

  removeId(id: string, opts: { record?: boolean; emit?: boolean } = {}) {
    const index = this.map.pieces.findIndex(p => p.id === id);
    if (index < 0) return;
    const piece = this.map.pieces[index];
    this.drop(id);
    this.map.pieces.splice(index, 1);
    if (opts.record !== false) this.undo.push({ kind: 'removed', piece, index });
    if (opts.emit !== false) this.onOp?.({ op: 'remove', id });
    this.onChanged?.();
  }

  undoLast() {
    const op = this.undo.pop();
    if (!op) return;
    if (op.kind === 'placed') this.removeId(op.id, { record: false });
    else if (op.kind === 'removed') this.place(op.piece, { record: false, index: op.index });
    else this.load(op.map, { emit: true });
  }

  /** Apply an edit that came from another pilot. */
  applyRemote(op: BuildOp) {
    if (!op || typeof op !== 'object') return;
    if (op.op === 'place') this.place(op.p, { record: false, emit: false, index: typeof op.index === 'number' ? op.index : undefined });
    else if (op.op === 'remove' && typeof op.id === 'string') this.removeId(op.id, { record: false, emit: false });
    else if (op.op === 'clear') this.clear(false);
    else if (op.op === 'map') this.load(op.map, { origin: 'room' });
    else if (op.op === 'race') { this.map.race = !!op.on; this.onChanged?.(); }
  }

  checkpoints() {
    const out: NonNullable<Built['checkpoint']>[] = [];
    for (const p of this.map.pieces) { const c = this.built.get(p.id!)?.checkpoint; if (c) out.push(c); }
    return out;
  }

  /** identifies the course layout, so best laps never mix between different courses */
  signature() {
    let h = 2166136261;
    const cps = this.checkpoints();
    for (const c of cps) for (const v of [c.pos.x, c.pos.y, c.pos.z]) { h ^= Math.round(v * 2); h = Math.imul(h, 16777619); }
    return (h >>> 0).toString(36) + '-' + cps.length;
  }

  startPad(): { pos: THREE.Vector3; yaw: number } | null {
    const p = this.map.pieces.find(q => q.t === 'flag');
    if (!p) return null;
    const off = new THREE.Vector3(3.4 * (p.s || 1), 0, 0).applyAxisAngle(new THREE.Vector3(0, 1, 0), THREE.MathUtils.degToRad(p.r));
    const pos = new THREE.Vector3(p.x, p.y, p.z).add(off);
    // the pad may sit on a slope: never spawn inside the hill
    pos.y = Math.max(pos.y + 0.1, this.world.colliders.heightAt(pos.x, pos.z) + 0.1);
    // the drone faces the way the start arrow points
    return { pos, yaw: THREE.MathUtils.degToRad(p.r) };
  }

  setGhost(type: PieceType) {
    this.selected = type;
    this.hideGhost();
    const b = buildPiece({ t: type, x: 0, y: 0, z: 0, r: 0, s: this.scale });
    const ghostMat = new THREE.MeshBasicMaterial({ color: COL.light, transparent: true, opacity: 0.35, depthWrite: false });
    b.obj.traverse(o => {
      const m = o as THREE.Mesh;
      if (m.isMesh) { m.material = ghostMat; m.castShadow = false; }
    });
    this.ghost = b.obj;
    this.ghost.userData.noThermal = true;
    this.ghost.userData.ghostMat = ghostMat;
    this.world.scene.add(this.ghost);
  }

  hideGhost() {
    this.setHover(null);
    if (!this.ghost) return;
    this.world.scene.remove(this.ghost);
    disposeObject(this.ghost);
    (this.ghost.userData.ghostMat as THREE.Material | undefined)?.dispose();
    this.ghost = null;
  }

  /** outline the piece the crosshair is on, so X deletes what you expect */
  setHover(id: string | null) {
    if (id === this.hoverId) { this.hover?.update(); return; }
    if (this.hover) { this.world.scene.remove(this.hover); this.hover.geometry.dispose(); (this.hover.material as THREE.Material).dispose(); this.hover = null; }
    this.hoverId = id;
    const b = id ? this.built.get(id) : null;
    if (!b) return;
    this.hover = new THREE.BoxHelper(b.obj, 0xff6b5a);
    this.hover.userData.noThermal = true;
    this.world.scene.add(this.hover);
  }

  /** Aim from the camera: snapped placement position and the id of the piece under the crosshair. */
  aim(cam: THREE.Camera): { pos: THREE.Vector3; hitId: string | null } {
    const o = cam.getWorldPosition(new THREE.Vector3());
    const d = new THREE.Vector3(0, 0, -1).applyQuaternion(cam.getWorldQuaternion(new THREE.Quaternion()));
    const hit = this.world.colliders.raycast(o, d, 160);
    const t = isFinite(hit.t) ? hit.t : 40;
    const p = o.clone().addScaledVector(d, Math.min(t, 160));
    const snap = 0.5;
    p.x = THREE.MathUtils.clamp(Math.round(p.x / snap) * snap, -WORLD_HALF, WORLD_HALF);
    p.z = THREE.MathUtils.clamp(Math.round(p.z / snap) * snap, -WORLD_HALF, WORLD_HALF);
    p.y = Math.max(this.world.colliders.heightAt(p.x, p.z), Math.round((p.y - 0.05) / snap) * snap) + this.lift;
    const hitId = hit.c && hit.c.tag === 'build' ? String(hit.c.data) : null;
    if (this.ghost) {
      this.ghost.position.copy(p);
      this.ghost.rotation.y = THREE.MathUtils.degToRad(this.yaw);
      this.ghost.scale.setScalar(this.scale);
    }
    this.setHover(this.ghost ? hitId : null);
    return { pos: p, hitId };
  }
}

/** A starter course so the Spielwiese is never empty. */
export function starterMap(): MapData {
  const pieces: Piece[] = [
    { t: 'flag', x: -138, y: 0, z: 38, r: 180, s: 1 },
  ];
  const n = 10;
  for (let i = 0; i < n; i++) {
    const a = i / n * Math.PI * 2;
    pieces.push({ t: i % 3 === 2 ? 'gate' : 'ring', x: -150 + Math.sin(a) * 34, y: 0, z: 70 - Math.cos(a) * 26, r: -THREE.MathUtils.radToDeg(a) + 90, s: 1 });
  }
  pieces.push({ t: 'ramp', x: -150, y: 0, z: 72, r: 0, s: 1 }, { t: 'container', x: -132, y: 0, z: 68, r: 30, s: 1 }, { t: 'pillar', x: -165, y: 0, z: 75, r: 0, s: 1 });
  return sanitizeMap({ v: 1, name: 'Starter loop', author: 'DroneShine', pieces, race: true })!;
}
