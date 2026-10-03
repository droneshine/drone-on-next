import * as THREE from 'three';
import type { World } from '../world/world';
import type { DroneSim } from '../sim/drone';

// Training missions. Each one teaches one real skill, scored in stars. The
// three DroneShine missions are the actual jobs: clean a park, clean a facade,
// find hotspots.

export interface Objective { text: string; done: boolean; }

export interface MissionCtx {
  world: World;
  sim: DroneSim;
  time: number;            // seconds since start
  spraying: boolean;
  cleaned: number;         // running cleaning score for this frame
  tagPressed: boolean;
  aimRay: { o: THREE.Vector3; d: THREE.Vector3 };
  marker(pos: THREE.Vector3 | null, label?: string): void;
  toast(text: string): void;
  chime(i: number): void;
  setCamera?(mode: 'los'): void;
}

export interface MissionResult { stars: number; score: string; detail: string; time: number; best?: number; }

export interface Mission {
  id: string;
  title: string;
  skill: string;
  brief: string;
  drone: string;                       // featured drone id
  lockDrone?: boolean;
  wind?: { speed: number; dir: number; gust: number };
  forceCam?: 'los' | 'chase' | 'fpv';
  spawn(world: World): { pos: THREE.Vector3; yaw: number };
  start(ctx: MissionCtx): void;
  update(ctx: MissionCtx, dt: number): 'running' | 'success' | 'fail';
  objectives(): Objective[];
  result(ctx: MissionCtx): MissionResult;
  failReason?: string;
  hud?(ctx: MissionCtx): string;
}

/** ring pass detection: crossing the ring plane inside the radius */
export class RingTracker {
  idx = 0;
  private prevLocal: THREE.Vector3 | null = null;
  constructor(public rings: { pos: THREE.Vector3; quat: THREE.Quaternion; R: number }[]) {}
  update(p: THREE.Vector3): boolean {
    if (this.idx >= this.rings.length) return false;
    const r = this.rings[this.idx];
    const local = p.clone().sub(r.pos).applyQuaternion(r.quat.clone().invert());
    let passed = false;
    if (this.prevLocal && Math.sign(local.z) !== Math.sign(this.prevLocal.z) && Math.hypot(local.x, local.y) < r.R * 0.95 && Math.abs(local.z) < 3) {
      passed = true; this.idx++; this.prevLocal = null;
    } else this.prevLocal = local;
    return passed;
  }
  get done() { return this.idx >= this.rings.length; }
}

const starsBy = (v: number, a: number, b: number, c: number, lowerIsBetter = false) =>
  lowerIsBetter ? (v <= a ? 3 : v <= b ? 2 : v <= c ? 1 : 0) : (v >= a ? 3 : v >= b ? 2 : v >= c ? 1 : 0);

const fmt = (s: number) => `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, '0')}`;

// ------------------------------------------------------------------ 1
function firstFlight(): Mission {
  let step = 0, hoverT = 0, landT = 0;
  const box = new THREE.Vector3(0, 5, -14);
  const objs: Objective[] = [
    { text: 'Push throttle up to arm and lift off', done: false },
    { text: 'Climb into the marker at 5 m', done: false },
    { text: 'Hold position inside the marker for 5 s', done: false },
    { text: 'Land on the right hand pad', done: false },
  ];
  return {
    id: 'first-flight', title: 'First Flight', skill: 'Hover and land', drone: 'dscan',
    brief: 'Every pilot starts here. Lift off, hold a steady hover inside the marker, then put it down softly on the next pad.',
    spawn: (w) => ({ pos: w.pads[1].clone(), yaw: 0 }),
    start(ctx) { step = 0; hoverT = 0; landT = 0; objs.forEach(o => o.done = false); ctx.marker(box, '5 m'); },
    update(ctx, dt) {
      const s = ctx.sim;
      if (s.crashed) { this.failReason = 'The drone crashed. Smooth inputs win.'; return 'fail'; }
      if (step === 0 && s.agl > 1) { objs[0].done = true; step = 1; ctx.chime(0); }
      if (step === 1 && s.pos.distanceTo(box) < 2.5) { objs[1].done = true; step = 2; ctx.chime(2); }
      if (step === 2) {
        if (s.pos.distanceTo(box) < 2.5) hoverT += dt; else hoverT = Math.max(0, hoverT - dt * 2);
        if (hoverT >= 5) { objs[2].done = true; step = 3; ctx.chime(4); ctx.marker(ctx.world.pads[2].clone().setY(1.5), 'Land'); }
      }
      if (step === 3) {
        const pad = ctx.world.pads[2];
        if (s.onGround && Math.hypot(s.pos.x - pad.x, s.pos.z - pad.z) < 3 && s.speed() < 0.3) { landT += dt; if (landT > 1) { objs[3].done = true; return 'success'; } }
        else landT = 0;
      }
      return 'running';
    },
    objectives: () => objs,
    hud: () => step === 2 ? `Hover ${hoverT.toFixed(1)} / 5.0 s` : '',
    result(ctx) { const t = ctx.time; const st = starsBy(t, 40, 75, 1e9, true); return { stars: Math.max(1, st), score: fmt(t), detail: `Max impact ${ctx.sim.maxImpact.toFixed(1)} m/s`, time: t }; },
  };
}

// ------------------------------------------------------------------ 2
function ringRun(): Mission {
  let tr: RingTracker;
  const objs: Objective[] = [{ text: 'Fly through all 12 rings in order', done: false }];
  return {
    id: 'ring-run', title: 'Ring Run', skill: 'Acro lines', drone: 'shine5',
    brief: 'Twelve rings through the freestyle park, around the bando and down from the crane. Acro mode. The clock starts when you take off.',
    spawn: () => ({ pos: new THREE.Vector3(-118, 0.3, 14), yaw: Math.PI / 2 }),
    start(ctx) { tr = new RingTracker(ctx.world.rings); objs[0].done = false; ctx.marker(ctx.world.rings[0].pos, '1'); ctx.world.rings.forEach((r, i) => ((r.mesh.material as THREE.MeshStandardMaterial).emissiveIntensity = i === 0 ? 5 : 1.4)); },
    update(ctx) {
      if (ctx.sim.crashed) { this.failReason = 'Crashed. Press R to try again from the start.'; return 'fail'; }
      if (tr.update(ctx.sim.pos)) {
        ctx.chime(tr.idx);
        const rings = ctx.world.rings;
        rings.forEach((r, i) => ((r.mesh.material as THREE.MeshStandardMaterial).emissiveIntensity = i === tr.idx ? 5 : i < tr.idx ? 0.2 : 1.4));
        if (tr.done) { objs[0].done = true; ctx.marker(null); rings.forEach(r => ((r.mesh.material as THREE.MeshStandardMaterial).emissiveIntensity = 2.2)); return 'success'; }
        ctx.marker(rings[tr.idx].pos, String(tr.idx + 1));
      }
      return 'running';
    },
    objectives: () => objs,
    hud: () => `Ring ${Math.min(12, (tr?.idx ?? 0) + 1)} / 12`,
    result(ctx) { const t = ctx.time; return { stars: Math.max(1, starsBy(t, 38, 55, 1e9, true)), score: fmt(t), detail: `Top speed matters less than clean lines`, time: t }; },
  };
}

// ------------------------------------------------------------------ 3
function solarShift(): Mission {
  const rows = [9, 10, 11];
  let litres = 30, clean = 0;
  const objs: Objective[] = [
    { text: 'Fly to rows J, K and L of the solar park', done: false },
    { text: 'Clean at least 80 % of the three rows', done: false },
    { text: 'Land back at base', done: false },
  ];
  let phase = 0;
  return {
    id: 'solar-shift', title: 'Solar Shift', skill: 'Contactless cleaning', drone: 'dsolar', lockDrone: true,
    brief: 'The real DSolar job. 30 litres of demineralised water, three soiled rows. Hold Space or A to spray. Two to three metres above the glass cleans best, any lower and the downwash turns into a hazard.',
    wind: { speed: 2.5, dir: 60, gust: 0.25 },
    spawn: (w) => ({ pos: w.pads[0].clone(), yaw: Math.PI }),
    start(ctx) {
      litres = 30; clean = 0; phase = 0; objs.forEach(o => o.done = false);
      ctx.world.solar.soil(1, 11);
      ctx.sim.payload = litres;
      const r = ctx.world.solar.rows[10];
      ctx.marker(new THREE.Vector3((r.x0 + r.x1) / 2, 6, r.z), 'J K L');
    },
    update(ctx, dt) {
      const s = ctx.sim;
      if (s.crashed) { this.failReason = 'DSolar went down. In a real park that is a six figure repair.'; return 'fail'; }
      if (ctx.spraying && litres > 0) { litres = Math.max(0, litres - 5 / 60 * dt); s.payload = litres; }
      if (phase === 0) {
        const r = ctx.world.solar.rows[10];
        if (Math.abs(s.pos.z - r.z) < 18 && s.pos.x > r.x0 - 5 && s.pos.x < r.x1 + 5) { phase = 1; objs[0].done = true; ctx.marker(null); ctx.chime(1); }
      }
      clean = ctx.world.solar.cleanliness(rows);
      if (phase === 1 && clean >= 0.8) { phase = 2; objs[1].done = true; ctx.chime(4); ctx.marker(ctx.world.pads[0].clone().setY(2), 'Base'); }
      if (phase === 2 && s.onGround && s.pos.distanceTo(ctx.world.pads[0]) < 5 && s.speed() < 0.3) { objs[2].done = true; return 'success'; }
      if (litres <= 0 && clean < 0.8 && !ctx.spraying) { this.failReason = 'Tank empty before 80 percent. Overlap less, fly a steady lane.'; return 'fail'; }
      if (s.soc <= 0.02) { this.failReason = 'Battery empty. Watch the voltage, plan the return.'; return 'fail'; }
      return 'running';
    },
    objectives: () => objs,
    hud: () => `Tank ${litres.toFixed(1)} L   Clean ${(clean * 100).toFixed(0)} %`,
    result(ctx) {
      const t = ctx.time;
      return { stars: Math.max(1, starsBy(clean, 0.95, 0.88, 0.8)), score: `${(clean * 100).toFixed(1)} %`, detail: `${(30 - litres).toFixed(1)} L water used in ${fmt(t)}`, time: t };
    },
  };
}

// ------------------------------------------------------------------ 4
function facadePro(): Mission {
  let clean = 0, timer = 0, sample = 0;
  const objs: Objective[] = [{ text: 'Clean 70 % of the dirty work zone', done: false }, { text: 'No more than 3 touches on the building', done: true }];
  let touches = 0;
  let lastTouch = 0;
  return {
    id: 'facade-pro', title: 'Facade Pro', skill: 'Tethered precision', drone: 'dshine', lockDrone: true,
    brief: 'DShine on a 50 metre hose from the ground pump. The lance cleans best at one to two metres from the wall. Hold Space or A to spray, Q and E tilt the lance. Feel the hose pull as you climb.',
    wind: { speed: 2, dir: 270, gust: 0.3 },
    spawn: (w) => ({ pos: w.facade.pumpAnchor.clone().add(new THREE.Vector3(6, -2.2, 0)), yaw: -Math.PI / 2 }),
    start(ctx) {
      clean = 0; timer = 0; touches = 0; objs[0].done = false; objs[1].done = true;
      const f = ctx.world.facade;
      ctx.marker(f.zoneCenter(), 'Work zone');
      ctx.sim.impactListeners = [(sp, surf) => {
        if (surf === 'hard' && sp > 0.6 && ctx.time - lastTouch > 1) { touches++; lastTouch = ctx.time; ctx.toast(`Touch ${touches} of 3`); }
      }];
    },
    update(ctx, dt) {
      if (ctx.sim.crashed) { this.failReason = 'DShine crashed into the building.'; return 'fail'; }
      timer += dt; sample += dt;
      if (sample > 0.5) { sample = 0; clean = ctx.world.facade.cleanliness(); }
      if (touches > 3) { objs[1].done = false; this.failReason = 'Too many touches. A real client would call that damage.'; return 'fail'; }
      if (clean >= 0.7) { objs[0].done = true; return 'success'; }
      if (timer > 600) { this.failReason = 'Out of time.'; return 'fail'; }
      return 'running';
    },
    objectives: () => objs,
    hud: () => `Clean ${(clean * 100).toFixed(0)} %   Touches ${touches}/3`,
    result(ctx) { const t = ctx.time; return { stars: Math.max(1, starsBy(t, 240, 360, 1e9, true)), score: fmt(t), detail: `${touches} touches, ${(clean * 100).toFixed(0)} % clean`, time: t }; },
  };
}

// ------------------------------------------------------------------ 5
function hotspotHunt(): Mission {
  let found = 0;
  const need = 6;
  const objs: Objective[] = [{ text: 'Switch to thermal with H', done: false }, { text: `Tag ${need} hotspots: aim the crosshair and press F or X`, done: false }];
  return {
    id: 'hotspot-hunt', title: 'Hotspot Hunt', skill: 'Thermal inspection', drone: 'dscan', lockDrone: true,
    brief: 'Half of all module faults show up as hotspots. Fly the DScan over the park, switch to the thermal camera and tag what glows. Twenty to forty metres altitude gives the best overview.',
    spawn: (w) => ({ pos: w.pads[2].clone(), yaw: Math.PI }),
    start(ctx) { found = 0; objs.forEach(o => o.done = false); ctx.world.solar.hotspots.forEach(h => h.found = false); ctx.marker(new THREE.Vector3(0, 25, -170), 'Park'); },
    update(ctx) {
      if (ctx.sim.crashed) { this.failReason = 'DScan crashed.'; return 'fail'; }
      if (ctx.world.thermal && !objs[0].done) { objs[0].done = true; ctx.marker(null); }
      if (ctx.tagPressed) {
        const hit = ctx.world.solar.raycast(ctx.aimRay.o, ctx.aimRay.d, 120);
        if (hit) {
          const h = ctx.world.solar.hotspots.find(h => !h.found && h.world.distanceTo(hit.p) < 1.4);
          if (h && ctx.world.thermal) { h.found = true; found++; ctx.chime(found); ctx.toast(`Hotspot ${found} of ${need} tagged`); }
          else ctx.toast(ctx.world.thermal ? 'Nothing hot there' : 'Switch to thermal first (H)');
        }
      }
      if (found >= need) { objs[1].done = true; return 'success'; }
      if (ctx.time > 420) { this.failReason = 'Out of time.'; return 'fail'; }
      return 'running';
    },
    objectives: () => objs,
    hud: () => `Hotspots ${found} / ${need}`,
    result(ctx) { const t = ctx.time; return { stars: Math.max(1, starsBy(t, 120, 200, 1e9, true)), score: fmt(t), detail: `${found} hotspots documented`, time: t }; },
  };
}

// ------------------------------------------------------------------ 6
function gustLanding(): Mission {
  const target = new THREE.Vector3(168, 23.1, 20);
  let t2 = 0;
  const objs: Objective[] = [{ text: 'Land on the office roof in gusting wind', done: false }];
  return {
    id: 'gust-landing', title: 'Gust Front', skill: 'Wind correction', drone: 'dscan',
    brief: 'Nine metres per second with gusts from the west. Get onto the office roof and stay there. Watch the windsock before you go.',
    wind: { speed: 9, dir: 90, gust: 0.7 },
    spawn: (w) => ({ pos: w.pads[2].clone(), yaw: -Math.PI / 2 }),
    start(ctx) { t2 = 0; objs[0].done = false; ctx.marker(target.clone().setY(26), 'Roof'); },
    update(ctx, dt) {
      const s = ctx.sim;
      if (s.crashed) { this.failReason = 'The gust won this time.'; return 'fail'; }
      const onRoof = s.onGround && Math.abs(s.pos.x - 168) < 9 && Math.abs(s.pos.z - 20) < 22 && s.pos.y > 20;
      if (onRoof && s.speed() < 0.4) { t2 += dt; if (t2 > 2) { objs[0].done = true; return 'success'; } } else t2 = 0;
      return 'running';
    },
    objectives: () => objs,
    result(ctx) { const t = ctx.time; return { stars: Math.max(1, starsBy(t, 50, 90, 1e9, true)), score: fmt(t), detail: `Max impact ${ctx.sim.maxImpact.toFixed(1)} m/s`, time: t }; },
  };
}

// ------------------------------------------------------------------ 7
function lineOfSight(): Mission {
  let tr: RingTracker;
  const gates = [
    new THREE.Vector3(-22, 4, -16), new THREE.Vector3(22, 6, -26), new THREE.Vector3(30, 4, 10), new THREE.Vector3(-26, 5, 6),
  ].map((p, i) => ({ pos: p, quat: new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), i * Math.PI / 2 + Math.PI / 4), R: 2.6 }));
  const meshes: THREE.Mesh[] = [];
  const objs: Objective[] = [{ text: 'Pass all four rings around the base', done: false }, { text: 'Land on any pad', done: false }];
  let step = 0;
  return {
    id: 'los', title: 'Line of Sight', skill: 'Orientation', drone: 'dscan', forceCam: 'los',
    brief: 'No camera, just your eyes from the pilot spot, like the A2 practical. When the drone flies toward you, left is right. Four rings, then land.',
    spawn: (w) => ({ pos: w.pads[1].clone(), yaw: 0 }),
    start(ctx) {
      step = 0; objs.forEach(o => o.done = false);
      tr = new RingTracker(gates);
      for (const m of meshes) ctx.world.scene.remove(m);
      meshes.length = 0;
      for (const g of gates) {
        const m = new THREE.Mesh(new THREE.TorusGeometry(2.6, 0.15, 10, 48), new THREE.MeshStandardMaterial({ color: '#b5f78a', emissive: '#b5f78a', emissiveIntensity: 0.7 }));
        m.position.copy(g.pos); m.quaternion.copy(g.quat); ctx.world.scene.add(m); meshes.push(m);
      }
      ctx.marker(gates[0].pos, '1');
    },
    update(ctx) {
      const s = ctx.sim;
      if (s.crashed) { this.failReason = 'Lost orientation. It happens to everyone once.'; return 'fail'; }
      if (step === 0 && tr.update(s.pos)) {
        ctx.chime(tr.idx);
        meshes.forEach((m, i) => ((m.material as THREE.MeshStandardMaterial).emissiveIntensity = i < tr.idx ? 0.05 : 0.7));
        if (tr.done) { step = 1; objs[0].done = true; ctx.marker(null); } else ctx.marker(gates[tr.idx].pos, String(tr.idx + 1));
      }
      if (step === 1 && s.onGround && s.speed() < 0.3 && ctx.world.pads.some(p => Math.hypot(p.x - s.pos.x, p.z - s.pos.z) < 3)) { objs[1].done = true; return 'success'; }
      return 'running';
    },
    objectives: () => objs,
    result(ctx) { for (const m of meshes) ctx.world.scene.remove(m); const t = ctx.time; return { stars: Math.max(1, starsBy(t, 60, 100, 1e9, true)), score: fmt(t), detail: 'Line of sight, the way the exam does it', time: t }; },
  };
}

// ------------------------------------------------------------------ 8
function turbineRun(): Mission {
  let reached = false;
  const objs: Objective[] = [{ text: 'Inspect the wind turbine nacelle from within 15 m', done: false }, { text: 'Return home with more than 20 % battery', done: false }];
  const nacelle = new THREE.Vector3(-330, 96, -279);
  return {
    id: 'turbine', title: 'Turbine Run', skill: 'Battery planning', drone: 'dscan',
    brief: 'The turbine is half a kilometre away and the blades are turning. Get close to the nacelle, then come home before the pack runs low. Distance is easy, discipline is not.',
    wind: { speed: 5, dir: 45, gust: 0.4 },
    spawn: (w) => ({ pos: w.pads[0].clone(), yaw: Math.PI * 0.8 }),
    start(ctx) { reached = false; objs.forEach(o => o.done = false); ctx.marker(nacelle, 'Nacelle'); },
    update(ctx) {
      const s = ctx.sim;
      if (s.crashed) { this.failReason = s.pos.distanceTo(nacelle) < 60 ? 'Blade strike. Keep clear of the rotor disc.' : 'Crashed.'; return 'fail'; }
      if (!reached && s.pos.distanceTo(nacelle) < 15) { reached = true; objs[0].done = true; ctx.chime(3); ctx.marker(ctx.world.pads[0].clone().setY(3), 'Home'); }
      if (reached && s.onGround && Math.hypot(s.pos.x, s.pos.z) < 30) {
        if (s.soc > 0.2) { objs[1].done = true; return 'success'; }
        this.failReason = 'Home, but below 20 percent. In real ops that is a write up.'; return 'fail';
      }
      if (s.soc < 0.03) { this.failReason = 'Battery empty in the field.'; return 'fail'; }
      return 'running';
    },
    objectives: () => objs,
    result(ctx) { const t = ctx.time; const soc = ctx.sim.soc; return { stars: starsBy(soc, 0.5, 0.35, 0.2), score: `${(soc * 100).toFixed(0)} % left`, detail: `${fmt(t)} flight, ${ctx.sim.energyWh.toFixed(0)} Wh used`, time: t }; },
  };
}

export function allMissions(): Mission[] {
  return [firstFlight(), lineOfSight(), ringRun(), gustLanding(), solarShift(), facadePro(), hotspotHunt(), turbineRun()];
}
