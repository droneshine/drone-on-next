import * as THREE from 'three';
import type { Game } from '../game/game';
import { RingTracker, type Mission, type MissionCtx, type Objective } from '../game/missions';
import { buildPiece, type Piece } from '../game/builder';
import type { Collider } from '../world/colliders';
import type { World } from '../world/world';
import type { DroneSpec } from '../sim/spec';
import { heightAt } from '../world/terrain';
import { drillDef, formatShort, MEDALS, type DrillDef, type DrillId } from './records';
import { PulseRange } from './pulse';

// The five P0 Academy drills (GDD 3.1, 6.14). Each one is a Mission so the game runs it like a
// training mission (HUD, pause, crash, reset), with the drill hooks from missions.ts on top.

/** GDD 6.1 Spark. A local copy for the drills; the Royale branch keeps its own tier table and the merge unifies them. */
export const SPARK: DroneSpec = {
  id: 'spark', name: 'Spark', author: 'DroneShine', tagline: 'The Academy drone. A small 7 inch class quad, light and honest.',
  model: 'spark', color: '#26c257', accent: '#f7f7f2', layout: 'quadX',
  armLength: 0.16, propDiameter: 0.18, mass: 1.1, maxThrust: 8.0, motorTau: 0.03, dragArea: 0.03,
  battery: { cells: 4, capacityAh: 1.8 }, defaultMode: 'gps', maxTilt: 28, maxSpeed: 12, maxClimb: 5, maxYawRate: 180,
  rates: { rcRate: 0.9, superRate: 0.55, expo: 0.3 }, camUptilt: 20, tool: 'camera',
};
const SPARK_ANGLE: DroneSpec = { ...SPARK, defaultMode: 'angle' };

export interface DrillOutcome { def: DrillDef; status: 'success' | 'fail'; value: number | null; detail: string; reason: string; }
export type DrillEnd = (o: DrillOutcome) => void;

const LG = '#b5f78a', OFF = '#f7f7f2';

/** everything a run puts into the world, removed again on cleanup */
class Stage {
  private objs: THREE.Object3D[] = [];
  private cols: Collider[] = [];
  private own = new Set<THREE.Material>();
  private after: (() => void)[] = [];
  constructor(readonly world: World) {}
  onClear(fn: () => void) { this.after.push(fn); }
  add<T extends THREE.Object3D>(o: T): T { o.traverse(c => { c.userData.noThermal = true; }); this.world.scene.add(o); this.objs.push(o); return o; }
  mat<T extends THREE.Material>(m: T): T { this.own.add(m); return m; }
  collider(...a: Parameters<World['colliders']['add']>) { const c = this.world.colliders.add(a[0], a[1], a[2], { tag: 'drill', ...a[3] }); this.cols.push(c); return c; }
  /** a builder piece with its colliders (shared builder materials stay alive) */
  piece(p: Piece) {
    const b = buildPiece(p);
    this.add(b.obj);
    for (const s of b.shapes) this.collider(s.shape, s.pos, s.quat);
    return b;
  }
  clear() {
    for (const o of this.objs) {
      this.world.scene.remove(o);
      o.traverse(c => { const m = c as THREE.Mesh; if (m.isMesh) m.geometry?.dispose(); });
    }
    for (const m of this.own) m.dispose();
    for (const c of this.cols) this.world.colliders.remove(c);
    for (const f of this.after) f();
    this.objs = []; this.cols = []; this.own.clear(); this.after = [];
  }
}

interface Impl {
  drone: string; spec?: DroneSpec; lockMode?: boolean; wind?: { speed: number; dir: number; gust: number };
  spawn(w: World): { pos: THREE.Vector3; yaw: number };
  start(ctx: MissionCtx, stage: Stage): void;
  update(ctx: MissionCtx, dt: number): 'running' | 'success' | 'fail';
  objectives(): Objective[];
  hud(): string;
  value(): number;
  detail(): string;
  failReason?: string;
}

const t2 = (s: number) => s.toFixed(1);
/** the best medal this run can still reach, for the HUD line (lower is better drills) */
function chase(def: DrillDef, v: number) {
  for (let k = 3; k >= 0; k--) if (v < def.medals[k]) return `${MEDALS[k]} ${formatShort(def, def.medals[k])}`;
  return '';
}

function wrap(id: DrillId, g: Game, end: DrillEnd, impl: Impl): Mission {
  const def = drillDef(id)!;
  let stage: Stage | null = null;
  const m: Mission = {
    id: 'drill-' + id, title: def.title, skill: def.skill, brief: def.brief, drone: impl.drone,
    spec: impl.spec, lockMode: impl.lockMode, wind: impl.wind,
    spawn: w => impl.spawn(w),
    start(ctx) { stage?.clear(); stage = new Stage(ctx.world); impl.start(ctx, stage); },
    update(ctx, dt) {
      const st = impl.update(ctx, dt);
      if (st === 'fail') this.failReason = impl.failReason;
      return st;
    },
    objectives: () => impl.objectives(),
    hud: () => impl.hud(),
    result: ctx => ({ stars: 0, score: '', detail: '', time: ctx.time }),
    cleanup() { stage?.clear(); stage = null; },
    again: () => makeDrill(id, g, end),
    finish(status, ctx) {
      end({ def, status, value: status === 'success' ? impl.value() : null, detail: impl.detail(), reason: status === 'fail' ? (impl.failReason || ctx.sim.crashReason || 'The run ended') : '' });
    },
  };
  return m;
}

const crashed = (impl: Impl, ctx: MissionCtx) => {
  if (!ctx.sim.crashed) return false;
  impl.failReason = ctx.sim.crashReason === 'Splashdown' ? 'Splashdown. Press R to fly it again.' : `${ctx.sim.crashReason}. Press R to fly it again.`;
  return true;
};

// ------------------------------------------------------------------ HOVER LOCK (precision)
function hoverLock(): Impl {
  const HOLD = 20, R = 1;
  let centre = new THREE.Vector3();
  let phase: 'climb' | 'hold' = 'climb';
  let held = 0, sum = 0, dist = 0;
  let shell!: THREE.MeshBasicMaterial, core!: THREE.MeshBasicMaterial, band!: THREE.MeshBasicMaterial;
  const objs: Objective[] = [{ text: 'Climb into the sphere 4 m over the pad', done: false }, { text: 'Hold it there for 20 s', done: false }];
  const impl: Impl = {
    drone: 'spark', spec: SPARK_ANGLE, lockMode: true, wind: { speed: 4, dir: 250, gust: 0.4 },
    spawn: w => ({ pos: w.pads[1].clone(), yaw: 0 }),
    start(ctx, st) {
      phase = 'climb'; held = 0; sum = 0; dist = 0; objs.forEach(o => (o.done = false));
      centre = ctx.world.pads[1].clone().add(new THREE.Vector3(0, 4, 0));
      shell = st.mat(new THREE.MeshBasicMaterial({ color: OFF, transparent: true, opacity: 0.1, depthWrite: false, side: THREE.DoubleSide }));
      const ball = st.add(new THREE.Mesh(new THREE.SphereGeometry(R, 40, 24), shell)); ball.position.copy(centre);
      band = st.mat(new THREE.MeshBasicMaterial({ color: LG, transparent: true, opacity: 0.6 }));
      const ring = st.add(new THREE.Mesh(new THREE.TorusGeometry(R, 0.012, 6, 64), band)); ring.position.copy(centre); ring.rotation.x = Math.PI / 2;
      const ring2 = st.add(new THREE.Mesh(new THREE.TorusGeometry(R, 0.008, 6, 64), band)); ring2.position.copy(centre);
      core = st.mat(new THREE.MeshBasicMaterial({ color: new THREE.Color(LG).multiplyScalar(4) }));
      const dot = st.add(new THREE.Mesh(new THREE.SphereGeometry(0.05, 12, 8), core)); dot.position.copy(centre);
    },
    update(ctx, dt) {
      if (crashed(impl, ctx)) return 'fail';
      dist = ctx.sim.pos.distanceTo(centre);
      const inside = dist <= R;
      shell.opacity = inside ? 0.16 : 0.08;
      shell.color.set(inside ? LG : OFF);
      if (phase === 'climb' && inside) { phase = 'hold'; objs[0].done = true; ctx.chime(2); }
      if (phase === 'hold') {
        // an excursion counts, but one wild second cannot wreck the whole average
        sum += Math.min(dist, 3) * dt;
        held += dt;
        if (held >= HOLD) { objs[1].done = true; return 'success'; }
      }
      return 'running';
    },
    objectives: () => objs,
    hud: () => phase === 'climb' ? `CLIMB INTO THE SPHERE   ${Math.round(dist * 100)} CM` : `${Math.round(dist * 100)} CM   AVG ${Math.round(sum / Math.max(0.01, held) * 100)}   ${t2(Math.max(0, HOLD - held))} S LEFT`,
    value: () => Math.round(sum / Math.max(0.01, held) * 1000) / 10,
    detail: () => `Average distance from the centre over ${HOLD} s, Angle mode, wind 4 m/s with gusts`,
  };
  return impl;
}

// ------------------------------------------------------------------ RING SPRINT (speed)
const SPRINT: [number, number, number, number?][] = [
  [-35, 5, -60], [-68, 6, -105], [-70, 6, -150], [-35, 3.4, -170, 90], [35, 3.4, -170, 90],
  [70, 6, -150], [70, 6, -110], [45, 5, -70], [20, 4.5, -40], [0, 4, -14],
];
function ringSprint(): Impl {
  let tr: RingTracker;
  let t = 0, running = false;
  const mats: THREE.MeshStandardMaterial[] = [];
  const objs: Objective[] = [{ text: 'Fly through all 10 rings in order', done: false }];
  let rings: { pos: THREE.Vector3; quat: THREE.Quaternion; R: number }[] = [];
  const paint = (idx: number) => mats.forEach((m, i) => { m.emissiveIntensity = i === idx ? 5 : i < idx ? 0.15 : 1.2; m.opacity = i < idx ? 0.35 : 1; });
  const impl: Impl = {
    drone: 'spark', spec: SPARK,
    spawn: w => ({ pos: w.pads[1].clone(), yaw: 0 }),
    start(ctx, st) {
      t = 0; running = false; objs[0].done = false; mats.length = 0;
      const geo = new THREE.TorusGeometry(2.6, 0.16, 12, 64);
      rings = SPRINT.map(([x, y, z, hd], i) => {
        const [px, , pz] = SPRINT[Math.max(0, i - 1)], [nx, , nz] = SPRINT[Math.min(SPRINT.length - 1, i + 1)];
        const yaw = hd != null ? THREE.MathUtils.degToRad(hd) : Math.atan2(nx - (i === 0 ? 0 : px), nz - (i === 0 ? 0 : pz));
        const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw);
        const pos = new THREE.Vector3(x, y + heightAt(x, z), z);
        const m = st.mat(new THREE.MeshStandardMaterial({ color: LG, emissive: LG, emissiveIntensity: 1.2, roughness: 0.3, transparent: true }));
        mats.push(m);
        const mesh = st.add(new THREE.Mesh(i === 0 ? geo : geo.clone(), m)); mesh.position.copy(pos); mesh.quaternion.copy(q); mesh.castShadow = true;
        st.collider({ kind: 'torus', R: 2.6, r: 0.16 }, pos.clone(), q.clone());
        return { pos, quat: q, R: 2.6 };
      });
      tr = new RingTracker(rings);
      paint(0);
      ctx.marker(rings[0].pos, '1');
    },
    update(ctx, dt) {
      if (crashed(impl, ctx)) return 'fail';
      if (!running && ctx.sim.armed) running = true;
      if (running) t += dt;
      if (tr.update(ctx.sim.pos)) {
        ctx.chime(tr.idx);
        paint(tr.idx);
        if (tr.done) { objs[0].done = true; ctx.marker(null); return 'success'; }
        ctx.marker(rings[tr.idx].pos, String(tr.idx + 1));
      }
      return 'running';
    },
    objectives: () => objs,
    hud: () => `${t2(t)} S   RING ${Math.min(10, (tr?.idx ?? 0) + 1)} / 10   ${chase(drillDef('ring-sprint')!, t)}`,
    value: () => Math.round(t * 100) / 100,
    detail: () => 'Ten rings around the solar field edge, clock from arming',
  };
  return impl;
}

// ------------------------------------------------------------------ SLALOM (control)
function slalom(): Impl {
  const N = 8, GAP = 12, Z0 = -14, PEN = 2;
  let t = 0, running = false, next = 0, penalty = 0, lastTouch = -9, prevZ = 0, done = false;
  let gate: RingTracker;
  const bands: THREE.MeshStandardMaterial[] = [];
  const pillars: THREE.Vector3[] = [];
  const objs: Objective[] = [{ text: 'Pass every pillar on the marked side', done: false }, { text: 'Fly through the gate', done: false }];
  // even pillars on the left (west, minus x) as seen flying north from the pad, odd on the right
  const sideOf = (k: number) => (k % 2 === 0 ? -1 : 1);
  const paint = () => bands.forEach((b, i) => { b.emissiveIntensity = i === next ? 4 : i < next ? 0.1 : 0.8; });
  const impl: Impl = {
    drone: 'spark', spec: SPARK,
    spawn: w => ({ pos: w.pads[1].clone(), yaw: 0 }),
    start(ctx, st) {
      t = 0; running = false; next = 0; penalty = 0; lastTouch = -9; done = false; prevZ = ctx.sim.pos.z;
      objs.forEach(o => (o.done = false)); bands.length = 0; pillars.length = 0;
      const stripeGeo = new THREE.PlaneGeometry(4.2, 1.1);
      const arrowGeo = new THREE.ConeGeometry(0.55, 1.3, 3);
      for (let k = 0; k < N; k++) {
        const z = Z0 - k * GAP, y = heightAt(0, z);
        st.piece({ t: 'pillar', x: 0, y, z, r: 0, s: 1 });
        pillars.push(new THREE.Vector3(0, y, z));
        const b = st.mat(new THREE.MeshStandardMaterial({ color: LG, emissive: LG, emissiveIntensity: 0.8 }));
        bands.push(b);
        for (const h of [2.2, 4.6]) { const band = st.add(new THREE.Mesh(new THREE.CylinderGeometry(0.63, 0.63, 0.35, 20, 1, true), b)); band.position.set(0, y + h, z); }
        // the side to pass: a glowing stripe on the ground and an arrow pointing the way
        const s = sideOf(k);
        const sm = st.mat(new THREE.MeshBasicMaterial({ color: LG, transparent: true, opacity: 0.45, depthWrite: false }));
        const stripe = st.add(new THREE.Mesh(stripeGeo.clone(), sm)); stripe.rotation.x = -Math.PI / 2; stripe.position.set(s * 2.9, y + 0.06, z);
        const arrow = st.add(new THREE.Mesh(arrowGeo.clone(), sm)); arrow.rotation.x = -Math.PI / 2; arrow.position.set(s * 2.9, y + 0.08, z - 1.2);
      }
      const gz = Z0 - N * GAP - 6;
      const g = st.piece({ t: 'gate', x: 0, y: heightAt(0, gz), z: gz, r: 0, s: 1.2 });
      gate = new RingTracker([g.checkpoint!]);
      paint();
      ctx.marker(pillars[0].clone().setY(pillars[0].y + 7).setX(sideOf(0) * 3), `${sideOf(0) < 0 ? 'LEFT' : 'RIGHT'} OF 1`);
      ctx.sim.impactListeners = [(sp, surf) => {
        if (surf !== 'hard' || sp < 0.3 || t - lastTouch < 1) return;
        const p = ctx.sim.pos;
        if (!pillars.some(q => Math.hypot(p.x - q.x, p.z - q.z) < 1.6)) return;
        lastTouch = t; penalty += PEN; ctx.toast('Touch. Plus 2 s');
      }];
    },
    update(ctx, dt) {
      if (crashed(impl, ctx)) return 'fail';
      if (!running && ctx.sim.armed) running = true;
      if (running) t += dt;
      const p = ctx.sim.pos;
      // pillar lines are crossed flying north (minus z); judge the side at the moment of crossing
      while (next < N && p.z < pillars[next].z && prevZ >= pillars[next].z - 0.001) {
        const s = Math.sign(p.x - pillars[next].x) || 1;
        const near = Math.abs(p.x - pillars[next].x) < 9;
        if (s !== sideOf(next) || !near) { penalty += PEN; ctx.toast(near ? `Wrong side of pillar ${next + 1}. Plus 2 s` : `Missed pillar ${next + 1}. Plus 2 s`); }
        else ctx.chime(next);
        next++;
        paint();
        if (next < N) ctx.marker(pillars[next].clone().setY(pillars[next].y + 7).setX(sideOf(next) * 3), `${sideOf(next) < 0 ? 'LEFT' : 'RIGHT'} OF ${next + 1}`);
        else { objs[0].done = true; ctx.marker(gate.rings[0].pos, 'GATE'); }
      }
      prevZ = p.z;
      if (next >= N && gate.update(p)) { objs[1].done = true; done = true; ctx.chime(8); return 'success'; }
      return 'running';
    },
    objectives: () => objs,
    hud: () => `${t2(t + penalty)} S   PILLAR ${Math.min(N, next + 1)} / ${N}${penalty ? `   PLUS ${penalty} S` : ''}`,
    value: () => Math.round((t + penalty) * 100) / 100,
    detail: () => done ? `${t2(t)} s flying, ${penalty} s penalties` : '',
  };
  return impl;
}

// ------------------------------------------------------------------ PAD HOP (landing)
function padHop(): Impl {
  let t = 0, running = false, idx = 0, still = 0, penalty = 0, lastHard = -9;
  let pads: { pos: THREE.Vector3; label: string }[] = [];
  let decals: THREE.MeshBasicMaterial[] = [];
  const objs: Objective[] = [];
  const impl: Impl = {
    drone: 'dscan',
    spawn: w => ({ pos: w.pads[1].clone(), yaw: -Math.PI / 2 }),
    start(ctx, st) {
      t = 0; running = false; idx = 0; still = 0; penalty = 0; lastHard = -9; decals = [];
      const w = ctx.world;
      const tower = (x: number, z: number, h: number) => {
        const g = heightAt(x, z);
        st.piece({ t: 'platform', x, y: g + h - 0.4, z, r: 20, s: 1 });
        const legMat = st.mat(new THREE.MeshStandardMaterial({ color: '#3b403d', metalness: 0.5, roughness: 0.5 }));
        for (const [dx, dz] of [[-2, -2], [2, -2], [-2, 2], [2, 2]]) {
          const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), THREE.MathUtils.degToRad(20));
          const o = new THREE.Vector3(dx, 0, dz).applyQuaternion(q);
          const leg = st.add(new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.14, h - 0.4, 8), legMat));
          leg.position.set(x + o.x, g + (h - 0.4) / 2, z + o.z); leg.castShadow = true;
          st.collider({ kind: 'cyl', radius: 0.14, halfH: (h - 0.4) / 2 }, leg.position.clone());
        }
        return new THREE.Vector3(x, g + h, z);
      };
      // the office roof: wherever the block's top really is
      const roofHit = w.colliders.raycast(new THREE.Vector3(168, 80, 20), new THREE.Vector3(0, -1, 0), 80);
      const roof = new THREE.Vector3(168, isFinite(roofHit.t) ? 80 - roofHit.t : 22, 20);
      pads = [
        { pos: w.pads[0].clone(), label: 'PAD 1' },
        { pos: w.pads[2].clone(), label: 'PAD 2' },
        { pos: tower(42, -24, 6), label: 'PAD 3, 6 M' },
        { pos: tower(100, 8, 12), label: 'PAD 4, 12 M' },
        { pos: roof, label: 'PAD 5, ROOF' },
      ];
      objs.length = 0;
      const names = ['Land on base pad 1', 'Land on base pad 2', 'Land on the 6 m tower', 'Land on the 12 m tower', 'Land on the office roof'];
      pads.forEach((p, i) => {
        objs.push({ text: names[i], done: false });
        const m = st.mat(new THREE.MeshBasicMaterial({ color: LG, transparent: true, opacity: 0.25, depthWrite: false }));
        decals.push(m);
        const d = st.add(new THREE.Mesh(new THREE.RingGeometry(1.25, 1.5, 48), m));
        d.rotation.x = -Math.PI / 2; d.position.copy(p.pos).add(new THREE.Vector3(0, 0.03, 0));
      });
      decals[0].opacity = 0.9;
      ctx.marker(pads[0].pos.clone().setY(pads[0].pos.y + 1.5), pads[0].label);
      ctx.sim.impactListeners = [(sp) => {
        if (sp > 2 && t - lastHard > 0.8 && running) { lastHard = t; penalty += 3; ctx.toast(`Hard touchdown, ${sp.toFixed(1)} m/s. Plus 3 s`); }
      }];
    },
    update(ctx, dt) {
      if (crashed(impl, ctx)) return 'fail';
      const s = ctx.sim;
      if (!running && s.armed) running = true;
      if (running) t += dt;
      const target = pads[idx];
      const flat = Math.hypot(s.pos.x - target.pos.x, s.pos.z - target.pos.z);
      const onIt = s.onGround && flat < 1.5 && Math.abs(s.pos.y - s.legHeight() - target.pos.y) < 0.6 && s.speed() < 0.4;
      // the start pad does not count as a landing before the drone has flown
      still = onIt && running ? still + dt : 0;
      if (still >= 0.5) {
        objs[idx].done = true; ctx.chime(idx * 2);
        decals[idx].opacity = 0.12;
        idx++; still = 0;
        if (idx >= pads.length) { ctx.marker(null); return 'success'; }
        decals[idx].opacity = 0.9;
        ctx.marker(pads[idx].pos.clone().setY(pads[idx].pos.y + 1.5), pads[idx].label);
        ctx.toast(`${idx} of 5 down`);
      }
      return 'running';
    },
    objectives: () => objs,
    hud: () => `${t2(t + penalty)} S   PAD ${Math.min(5, idx + 1)} / 5${penalty ? `   PLUS ${penalty} S` : ''}`,
    value: () => Math.round((t + penalty) * 100) / 100,
    detail: () => `${t2(t)} s flying, ${penalty} s for hard touchdowns`,
  };
  return impl;
}

// ------------------------------------------------------------------ TARGET RANGE (aim)
const TARGETS: [number, number, number, ('x' | 'y' | 'z')?, number?, number?][] = [
  [-140, 7, 18], [-165, 5, 10, 'z', 5, 0.6], [-170, 9, 55], [-200, 12, 58, 'x', 6, 0.5], [-230, 6, 30],
  [-262, 8, 40, 'y', 2, 0.7], [-268, 12, 5], [-262, 20, -30, 'x', 5, 0.45], [-225, 30, -55], [-195, 18, -25],
  [-172, 7, -55, 'z', 5, 0.55], [-150, 12, -40], [-130, 5, -25], [-215, 4, 25], [-185, 7, 0, 'x', 4, 0.65],
];
export const RANGE_TIME = 60;
/** fire and auto fire inputs for TARGET RANGE, set by the Academy HUD (touch FIRE button) */
export const rangeInput = { touchFire: false };
export let activeRange: PulseRange | null = null;

function targetRange(g: Game): Impl {
  let range: PulseRange | null = null;
  let t = 0, running = false, clock = 0;
  const objs: Objective[] = [{ text: 'Hit all 15 targets', done: false }, { text: 'Turn the drone to aim, the shot bends onto targets near the crosshair', done: false }];
  const left = () => Math.max(0, RANGE_TIME - t);
  const score = () => {
    if (!range) return 0;
    const extra = Math.max(0, range.shots - 3 * range.hits);
    return range.hits * 100 + (range.alive === 0 ? Math.floor(left()) * 5 : 0) - extra * 10;
  };
  const impl: Impl = {
    drone: 'spark', spec: SPARK, lockMode: true,
    wind: { speed: 2, dir: 70, gust: 0.25 },
    spawn: () => ({ pos: new THREE.Vector3(-118, 0.3, 14), yaw: Math.PI / 2 }),
    start(ctx, st) {
      t = 0; running = false; clock = 0; objs[0].done = false; objs[1].done = false;
      range = new PulseRange(ctx.world, g.particles);
      activeRange = range;
      const axes = { x: new THREE.Vector3(1, 0, 0), y: new THREE.Vector3(0, 1, 0), z: new THREE.Vector3(0, 0, 1) };
      for (const [x, y, z, ax, amp, sp] of TARGETS) {
        const p = new THREE.Vector3(x, y + heightAt(x, z), z);
        // GDD 2.3 clearance rule: raise in 0.5 m steps until 1.5 m clear of everything
        const c = { depth: 0, normal: new THREE.Vector3(), collider: null, surface: '' };
        for (let k = 0; k < 30 && ctx.world.colliders.query(p, 1.5, c); k++) p.y += 0.5;
        range.addTarget(p, ax ? { axis: axes[ax], amp: amp!, speed: sp! } : undefined);
      }
      range.onHit = () => { ctx.chime(Math.min(12, range!.hits)); };
      // the range goes with the stage
      const r = range;
      st.onClear(() => { r.dispose(); if (activeRange === r) activeRange = null; });
    },
    update(ctx, dt) {
      if (crashed(impl, ctx)) return 'fail';
      const s = ctx.sim;
      if (!running && s.armed) running = true;
      if (running) t += dt;
      clock += dt;
      const inp = g.input, pad = inp.activePad();
      const touch = inp.device === 'touch', rc = inp.device === 'rc';
      const fire = inp.keys.has('Space') || (inp.mouseButtons.has(0) && document.pointerLockElement == null && !touch)
        || (inp.device === 'gamepad' && !!pad?.buttons[0]?.pressed) || (rc && (pad?.axes[5] ?? -1) > 0.3) || rangeInput.touchFire;
      const cone = THREE.MathUtils.degToRad(10 + (touch || rc ? 4 : 0));
      range!.update(dt, clock, s, { fire: fire && running, auto: (touch || rc) && running, cone, armed: s.armed });
      if (range!.alive === 0) { objs[0].done = true; return 'success'; }
      if (t >= RANGE_TIME) return 'success';
      return 'running';
    },
    objectives: () => objs,
    hud: () => `${t2(left())} S   ${range ? 15 - range.alive : 0} / 15   ${score()}`,
    value: () => score(),
    detail: () => range ? `${range.hits} of 15 hit with ${range.shots} shots${range.alive === 0 ? `, ${Math.floor(left())} s to spare` : ''}` : '',
  };
  return impl;
}

export function makeDrill(id: DrillId, g: Game, end: DrillEnd): Mission {
  const impl = id === 'hover-lock' ? hoverLock() : id === 'ring-sprint' ? ringSprint() : id === 'slalom' ? slalom() : id === 'pad-hop' ? padHop() : targetRange(g);
  return wrap(id, g, end, impl);
}

export const isDrill = (m: Mission | null | undefined) => !!m && m.id.startsWith('drill-');
