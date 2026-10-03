import * as THREE from 'three';
import type { World } from '../world/world';
import type { Particles } from '../render/effects';
import type { DroneSim } from '../sim/drone';

// A PULSE style shot for TARGET RANGE only (GDD 2.6, 6.2, 6.3 Spark numbers, 6.9 assist).
// Self contained on purpose: the Royale combat module lives in its own branch and the merge unifies them.

export const PULSE = { rate: 4, speed: 110, range: 60, cost: 0.0018, minSoc: 0.03 };
const VERTICAL_HELP = THREE.MathUtils.degToRad(12);
const VERTICAL_MAX = THREE.MathUtils.degToRad(40);
const LOCK_DELAY = 0.15;
const HIT_R = 1.1;
/** targets read at 50 m: half again the size of a Spark */
const TARGET_SCALE = 1.5;

export interface Target {
  base: THREE.Vector3; pos: THREE.Vector3; vel: THREE.Vector3;
  axis: THREE.Vector3 | null; amp: number; speed: number; phase: number;
  alive: boolean; pop: number; obj: THREE.Group; rotors: THREE.Object3D[];
}

interface Bolt { pos: THREE.Vector3; dir: THREE.Vector3; life: number; mesh: THREE.Mesh; }

export class PulseRange {
  targets: Target[] = [];
  shots = 0; hits = 0;
  /** where the crosshair points this frame, and the target the assist locked onto */
  aimPoint = new THREE.Vector3();
  lock: Target | null = null;
  onHit: ((t: Target) => void) | null = null;
  private bolts: Bolt[] = [];
  private cooldown = 0;
  private lockT = 0;
  private losT = 0;
  private los = new Map<Target, boolean>();
  private geo = {
    body: new THREE.BoxGeometry(0.46, 0.14, 0.46),
    arm: new THREE.BoxGeometry(1.2, 0.05, 0.07),
    rotor: new THREE.TorusGeometry(0.22, 0.03, 6, 20),
    eye: new THREE.SphereGeometry(0.07, 10, 8),
    bolt: new THREE.CylinderGeometry(0.05, 0.05, 1.1, 6),
  };
  private mat = {
    body: new THREE.MeshStandardMaterial({ color: '#f7f7f2', roughness: 0.45, metalness: 0.1 }),
    arm: new THREE.MeshStandardMaterial({ color: '#1c1e1d', roughness: 0.5 }),
    rotor: new THREE.MeshStandardMaterial({ color: '#8fc2f5', emissive: '#8fc2f5', emissiveIntensity: 3 }),
    eye: new THREE.MeshBasicMaterial({ color: new THREE.Color('#8fc2f5').multiplyScalar(6) }),
    // bright enough to bloom: the bolt reads as energy, not as a solid
    bolt: new THREE.MeshBasicMaterial({ color: new THREE.Color('#b5f78a').multiplyScalar(10) }),
  };
  private root = new THREE.Group();

  constructor(private world: World, private particles: Particles) {
    this.root.userData.noThermal = true;
    world.scene.add(this.root);
  }

  /** a drone shaped target; axis and amp make it travel on a rail */
  addTarget(pos: THREE.Vector3, rail?: { axis: THREE.Vector3; amp: number; speed: number }) {
    const g = new THREE.Group();
    g.add(new THREE.Mesh(this.geo.body, this.mat.body));
    const a1 = new THREE.Mesh(this.geo.arm, this.mat.arm); a1.rotation.y = Math.PI / 4; g.add(a1);
    const a2 = new THREE.Mesh(this.geo.arm, this.mat.arm); a2.rotation.y = -Math.PI / 4; g.add(a2);
    const rotors: THREE.Object3D[] = [];
    for (let i = 0; i < 4; i++) {
      const a = Math.PI / 4 + i * Math.PI / 2;
      const r = new THREE.Mesh(this.geo.rotor, this.mat.rotor);
      r.rotation.x = Math.PI / 2; r.position.set(Math.cos(a) * 0.42, 0.06, Math.sin(a) * 0.42);
      g.add(r); rotors.push(r);
    }
    const eye = new THREE.Mesh(this.geo.eye, this.mat.eye); eye.position.set(0, 0, -0.24); g.add(eye);
    g.traverse(o => { (o as THREE.Mesh).castShadow = true; o.userData.noThermal = true; });
    g.position.copy(pos);
    g.scale.setScalar(TARGET_SCALE);
    this.root.add(g);
    this.targets.push({
      base: pos.clone(), pos: pos.clone(), vel: new THREE.Vector3(), axis: rail?.axis.clone().normalize() ?? null, amp: rail?.amp ?? 0,
      speed: rail?.speed ?? 0, phase: this.targets.length * 1.7, alive: true, pop: 0, obj: g, rotors,
    });
  }

  get alive() { return this.targets.filter(t => t.alive).length; }

  /** nose direction on the horizon: the drone aims by yawing, like a real one */
  private forward(sim: DroneSim, out: THREE.Vector3) { const h = sim.heading(); return out.set(-Math.sin(h), 0, -Math.cos(h)); }

  update(dt: number, time: number, sim: DroneSim, input: { fire: boolean; auto: boolean; cone: number; armed: boolean }) {
    // targets: rails, spinning rotors, pop on hit
    for (const t of this.targets) {
      if (t.axis) {
        const w = t.speed;
        t.pos.copy(t.base).addScaledVector(t.axis, Math.sin(time * w + t.phase) * t.amp);
        t.vel.copy(t.axis).multiplyScalar(Math.cos(time * w + t.phase) * t.amp * w);
      }
      t.obj.position.copy(t.pos);
      t.obj.position.y += Math.sin(time * 2.1 + t.phase) * 0.08;
      t.obj.rotation.y += dt * 0.4;
      for (const r of t.rotors) r.rotation.z += dt * 30;
      if (!t.alive) {
        t.pop = Math.min(1, t.pop + dt / 0.16);
        const s = 1 - t.pop;
        t.obj.scale.setScalar(Math.max(0.001, s) * TARGET_SCALE);
        t.obj.visible = s > 0.01;
      }
    }
    // assist: inside the cone the shot bends onto the target, within 12 degrees it only corrects height
    const fwd = this.forward(sim, new THREE.Vector3());
    const muzzle = sim.pos.clone().addScaledVector(fwd, sim.spec.armLength + 0.2);
    this.losT -= dt;
    const refreshLos = this.losT <= 0;
    if (refreshLos) { this.losT = 0.1; this.los.clear(); }
    let best: { t: Target; h: number; d: number } | null = null;
    let vHelp: { t: Target; h: number; d: number } | null = null;
    for (const t of this.targets) {
      if (!t.alive) continue;
      const to = t.pos.clone().sub(muzzle);
      const d = to.length();
      if (d > PULSE.range) continue;
      const hAng = Math.abs(Math.atan2(fwd.x * to.z - fwd.z * to.x, fwd.x * to.x + fwd.z * to.z));
      const vAng = Math.abs(Math.atan2(to.y, Math.hypot(to.x, to.z)));
      if (hAng > Math.max(input.cone, VERTICAL_HELP) || vAng > VERTICAL_MAX) continue;
      let seen = this.los.get(t);
      if (seen === undefined) {
        if (!refreshLos && this.lock !== t) continue;
        seen = this.clearLine(muzzle, t.pos, d);
        this.los.set(t, seen);
      }
      if (!seen) continue;
      if (hAng <= input.cone) { if (!best || hAng < best.h - 0.01 || (Math.abs(hAng - best.h) <= 0.01 && d < best.d)) best = { t, h: hAng, d }; }
      else if (!vHelp || hAng < vHelp.h) vHelp = { t, h: hAng, d };
    }
    if (best?.t !== this.lock) this.lockT = 0;
    this.lock = best?.t ?? null;
    if (this.lock) this.lockT += dt;
    let dir: THREE.Vector3;
    if (this.lock) {
      // predicted intercept with the target's rail velocity
      const p = this.lock.pos.clone();
      for (let k = 0; k < 2; k++) { const tt = p.distanceTo(muzzle) / PULSE.speed; p.copy(this.lock.pos).addScaledVector(this.lock.vel, tt); }
      dir = p.sub(muzzle).normalize();
      this.aimPoint.copy(this.lock.pos);
    } else if (vHelp) {
      const to = vHelp.t.pos.clone().sub(muzzle);
      const pitch = Math.atan2(to.y, Math.hypot(to.x, to.z));
      dir = fwd.clone().multiplyScalar(Math.cos(pitch)).setY(Math.sin(pitch)).normalize();
      this.aimPoint.copy(muzzle).addScaledVector(fwd, 40);
    } else {
      dir = fwd.clone();
      this.aimPoint.copy(muzzle).addScaledVector(fwd, 40);
    }
    // fire
    this.cooldown = Math.max(0, this.cooldown - dt);
    const autoFire = input.auto && !!this.lock && this.lockT >= LOCK_DELAY;
    if ((input.fire || autoFire) && input.armed && this.cooldown <= 0 && sim.soc > PULSE.minSoc && !sim.crashed) {
      this.cooldown = 1 / PULSE.rate;
      this.shots++;
      sim.soc = Math.max(0, sim.soc - PULSE.cost);
      const mesh = new THREE.Mesh(this.geo.bolt, this.mat.bolt);
      mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
      mesh.position.copy(muzzle);
      this.root.add(mesh);
      this.bolts.push({ pos: muzzle.clone(), dir: dir.clone(), life: PULSE.range / PULSE.speed, mesh });
      for (let i = 0; i < 4; i++) this.particles.emit(muzzle, dir.clone().multiplyScalar(4).add(new THREE.Vector3((Math.random() - 0.5) * 2, Math.random(), (Math.random() - 0.5) * 2)), 0.18, 0.08, 0.71, 0.97, 0.54, 0.9);
    }
    // bolts: straight, no gravity, hit spheres and the world
    for (let i = this.bolts.length - 1; i >= 0; i--) {
      const b = this.bolts[i];
      const step = Math.min(b.life, dt) * PULSE.speed;
      b.life -= dt;
      let end = false;
      let hitT: Target | null = null, hitS = step;
      for (const t of this.targets) {
        if (!t.alive) continue;
        const rel = t.pos.clone().sub(b.pos);
        const along = THREE.MathUtils.clamp(rel.dot(b.dir), 0, step);
        if (rel.addScaledVector(b.dir, -along).length() < HIT_R && along < hitS) { hitS = along; hitT = t; }
      }
      const wall = this.world.colliders.raycast(b.pos, b.dir, hitS, c => c.tag !== 'player');
      if (isFinite(wall.t) && wall.t < hitS) { hitT = null; hitS = wall.t; end = true; }
      b.pos.addScaledVector(b.dir, hitS);
      b.mesh.position.copy(b.pos);
      if (hitT) { this.hit(hitT); end = true; }
      else if (end) this.spark(b.pos, 6, [0.97, 0.97, 0.95]);
      if (end || b.life <= 0) { this.root.remove(b.mesh); this.bolts.splice(i, 1); }
    }
  }

  private clearLine(from: THREE.Vector3, to: THREE.Vector3, d: number) {
    const dir = to.clone().sub(from).normalize();
    const r = this.world.colliders.raycast(from, dir, Math.max(0, d - HIT_R), c => c.tag !== 'player');
    return !isFinite(r.t);
  }

  private hit(t: Target) {
    t.alive = false; this.hits++;
    this.spark(t.pos, 26, [0.71, 0.97, 0.54]);
    this.spark(t.pos, 10, [0.56, 0.76, 0.96]);
    this.onHit?.(t);
  }

  private spark(p: THREE.Vector3, n: number, c: number[]) {
    for (let i = 0; i < n; i++) {
      const v = new THREE.Vector3(Math.random() - 0.5, Math.random() - 0.3, Math.random() - 0.5).normalize().multiplyScalar(3 + Math.random() * 5);
      this.particles.emit(p, v, 0.35 + Math.random() * 0.3, 0.09, c[0], c[1], c[2], 0.95);
    }
  }

  dispose() {
    this.world.scene.remove(this.root);
    for (const g of Object.values(this.geo)) g.dispose();
    for (const m of Object.values(this.mat)) m.dispose();
    this.targets = []; this.bolts = [];
  }
}
