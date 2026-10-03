import * as THREE from 'three';

// Signed distance colliders on a uniform hash grid. Every solid thing in the
// world registers here; the drone samples a handful of contact spheres per step.

export type Shape =
  | { kind: 'box'; half: THREE.Vector3 }
  | { kind: 'torus'; R: number; r: number }          // ring in local XY plane, axis = local Z
  | { kind: 'cyl'; radius: number; halfH: number }    // axis = local Y
  | { kind: 'sphere'; radius: number };

export interface Collider {
  id: number;
  shape: Shape;
  pos: THREE.Vector3;
  quat: THREE.Quaternion;
  inv: THREE.Matrix4;
  bound: number;         // bounding sphere radius
  tag?: string;
  data?: unknown;
  surface?: 'hard' | 'glass' | 'panel' | 'soft' | 'water';
}

export interface Contact { depth: number; normal: THREE.Vector3; collider: Collider | null; surface: string; }

const CELL = 10;
const _p = new THREE.Vector3();
const _q = new THREE.Vector3();
const _one = new THREE.Vector3(1, 1, 1);

function sdfLocal(s: Shape, p: THREE.Vector3): number {
  switch (s.kind) {
    case 'box': {
      const qx = Math.abs(p.x) - s.half.x, qy = Math.abs(p.y) - s.half.y, qz = Math.abs(p.z) - s.half.z;
      const ox = Math.max(qx, 0), oy = Math.max(qy, 0), oz = Math.max(qz, 0);
      return Math.hypot(ox, oy, oz) + Math.min(Math.max(qx, Math.max(qy, qz)), 0);
    }
    case 'torus': {
      const qx = Math.hypot(p.x, p.y) - s.R;
      return Math.hypot(qx, p.z) - s.r;
    }
    case 'cyl': {
      const dx = Math.hypot(p.x, p.z) - s.radius, dy = Math.abs(p.y) - s.halfH;
      return Math.min(Math.max(dx, dy), 0) + Math.hypot(Math.max(dx, 0), Math.max(dy, 0));
    }
    case 'sphere': return p.length() - s.radius;
  }
}

export class ColliderWorld {
  list = new Set<Collider>();
  private grid = new Map<string, Collider[]>();
  /** grid cells each collider sits in, so remove and move never scan the whole grid */
  private cells = new Map<Collider, string[]>();
  private nextId = 1;
  heightAt: (x: number, z: number) => number = () => 0;
  waterLevel = -1e9;

  add(shape: Shape, pos: THREE.Vector3, quat = new THREE.Quaternion(), opts: Partial<Collider> = {}): Collider {
    const m = new THREE.Matrix4().compose(pos, quat, new THREE.Vector3(1, 1, 1));
    const bound = shape.kind === 'box' ? shape.half.length()
      : shape.kind === 'torus' ? shape.R + shape.r
      : shape.kind === 'cyl' ? Math.hypot(shape.radius, shape.halfH) : shape.radius;
    const c: Collider = { id: this.nextId++, shape, pos: pos.clone(), quat: quat.clone(), inv: m.invert(), bound, ...opts };
    this.list.add(c);
    this.insert(c);
    return c;
  }

  remove(c: Collider) {
    this.list.delete(c);
    this.unlink(c);
  }

  /** Move a collider, e.g. a turning rotor blade or a remote pilot. */
  move(c: Collider, pos: THREE.Vector3, quat: THREE.Quaternion) {
    this.unlink(c);
    c.pos.copy(pos); c.quat.copy(quat);
    c.inv.compose(pos, quat, _one).invert();
    this.insert(c);
  }

  removeWhere(fn: (c: Collider) => boolean) {
    for (const c of [...this.list]) if (fn(c)) this.remove(c);
  }

  private unlink(c: Collider) {
    const keys = this.cells.get(c);
    if (!keys) return;
    for (const k of keys) {
      const arr = this.grid.get(k);
      if (!arr) continue;
      const i = arr.indexOf(c);
      if (i >= 0) { arr.splice(i, 1); if (!arr.length) this.grid.delete(k); }
    }
    this.cells.delete(c);
  }

  private insert(c: Collider) {
    // never index anything non finite or absurdly large: a hostile map must not hang the loop
    if (!isFinite(c.pos.x) || !isFinite(c.pos.z) || !isFinite(c.bound)) return;
    const r = Math.min(c.bound + 2.5, 400);
    const x0 = Math.floor((c.pos.x - r) / CELL), x1 = Math.floor((c.pos.x + r) / CELL);
    const z0 = Math.floor((c.pos.z - r) / CELL), z1 = Math.floor((c.pos.z + r) / CELL);
    if (x1 - x0 > 100 || z1 - z0 > 100) return;
    const keys: string[] = [];
    for (let x = x0; x <= x1; x++) for (let z = z0; z <= z1; z++) {
      const k = x + ',' + z;
      let arr = this.grid.get(k);
      if (!arr) this.grid.set(k, arr = []);
      arr.push(c);
      keys.push(k);
    }
    this.cells.set(c, keys);
  }

  sdf(c: Collider, p: THREE.Vector3) {
    _p.copy(p).applyMatrix4(c.inv);
    return sdfLocal(c.shape, _p);
  }

  /** Deepest contact for a sphere of radius r at p, or null. */
  query(p: THREE.Vector3, r: number, out: Contact): boolean {
    let best = 0; let hit = false;
    // terrain, treated as a half space with local normal
    const h = this.heightAt(p.x, p.z);
    const gd = p.y - r - h;
    if (gd < 0) {
      const e = 0.5;
      out.normal.set(this.heightAt(p.x - e, p.z) - this.heightAt(p.x + e, p.z), 2 * e, this.heightAt(p.x, p.z - e) - this.heightAt(p.x, p.z + e)).normalize();
      best = -gd * out.normal.y; out.collider = null; out.surface = 'ground'; hit = true;
    }
    if (p.y - r < this.waterLevel && h < this.waterLevel) {
      const d = this.waterLevel - (p.y - r);
      if (d > best) { best = d; out.normal.set(0, 1, 0); out.collider = null; out.surface = 'water'; hit = true; }
    }
    const arr = this.grid.get(Math.floor(p.x / CELL) + ',' + Math.floor(p.z / CELL));
    if (arr) for (const c of arr) {
      if (c.pos.distanceToSquared(p) > (c.bound + r) ** 2) continue;
      const d = this.sdf(c, p) - r;
      if (d < 0 && -d > best) {
        best = -d; hit = true; out.collider = c; out.surface = c.surface ?? 'hard';
        // numerical gradient
        const e = 0.01;
        const base = this.sdf(c, p);
        _q.copy(p); _q.x += e; const dx = this.sdf(c, _q) - base;
        _q.copy(p); _q.y += e; const dy = this.sdf(c, _q) - base;
        _q.copy(p); _q.z += e; const dz = this.sdf(c, _q) - base;
        out.normal.set(dx, dy, dz);
        if (out.normal.lengthSq() < 1e-12) out.normal.set(0, 1, 0); else out.normal.normalize();
      }
    }
    out.depth = best;
    return hit;
  }

  /** Ray march against colliders and terrain. Returns distance or Infinity. */
  raycast(o: THREE.Vector3, dir: THREE.Vector3, maxDist: number, filter?: (c: Collider) => boolean): { t: number; c: Collider | null } {
    let t = 0; const p = new THREE.Vector3();
    for (let i = 0; i < 160 && t < maxDist; i++) {
      p.copy(o).addScaledVector(dir, t);
      let d = p.y - this.heightAt(p.x, p.z);
      let hitC: Collider | null = null;
      if (d < 0.02) return { t, c: null };
      d *= 0.7;
      const arr = this.grid.get(Math.floor(p.x / CELL) + ',' + Math.floor(p.z / CELL));
      if (arr) for (const c of arr) {
        if (filter && !filter(c)) continue;
        const dc = this.sdf(c, p);
        if (dc < d) { d = dc; hitC = c; }
      }
      if (d < 0.01) return { t, c: hitC };
      t += Math.max(d, 0.02);
      // do not skip over grid cells we have not looked into
      t = Math.min(t, t - Math.max(d, 0.02) + 2);
    }
    return { t: Infinity, c: null };
  }
}
