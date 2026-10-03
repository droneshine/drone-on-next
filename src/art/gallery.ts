import * as THREE from 'three';
import type { Game } from '../game/game';
import type { DroneSpec } from '../sim/spec';
import { buildDroneVisual, animateProps, disposeVisual, DroneVisual } from '../render/droneModels';
import { TIER_LEG } from '../sim/drone';
import { heightAt } from '../world/terrain';
import { audio } from '../audio/audio';
import type { RingKind, TierId } from './contracts';
import { RoyaleArtImpl } from './royaleArt';
import { RoyaleSfxImpl } from './sfx';
import { RingImpl } from './rings';
import { triangles } from './kit';

// Dev only art review, opened with #artgallery (see studio/ART.md 8). It borrows the running game:
// same renderer, world, light, bloom and thermal camera, so what you judge here is what ships.
// Hash parameters: view=tiers|hover|silhouette|rings|fx|emp|signalin|signalout|ceiling|screen|stress|stress50
//                  time=day|golden  thermal=1  hud=0 (hide the panel for clean screenshots)

const TIERS: TierId[] = ['spark', 'bolt', 'storm', 'nova'];

/** GDD 6.1 tier specs, local to the gallery (gameplay owns the real table in src/royale) */
function tierSpec(t: TierId): DroneSpec {
  const base = {
    author: 'DroneShine', tagline: '', defaultMode: 'gps' as const, rates: { rcRate: 0.9, superRate: 0.55, expo: 0.3 },
  };
  switch (t) {
    case 'spark': return { ...base, id: 'spark', name: 'SPARK', model: 'spark', layout: 'quadX', armLength: 0.16, propDiameter: 0.18, mass: 1.1, maxThrust: 8, motorTau: 0.03, dragArea: 0.03, battery: { cells: 4, capacityAh: 1.8 }, maxTilt: 28, maxSpeed: 12, maxClimb: 5, maxYawRate: 180, camUptilt: 20, tool: 'camera', color: '#26c257', accent: '#f7f7f2' };
    case 'bolt': return { ...base, id: 'bolt', name: 'BOLT', model: 'bolt', layout: 'quadX', armLength: 0.24, propDiameter: 0.254, mass: 1.9, maxThrust: 13.5, motorTau: 0.04, dragArea: 0.045, battery: { cells: 6, capacityAh: 2 }, maxTilt: 30, maxSpeed: 14, maxClimb: 6, maxYawRate: 160, camUptilt: 15, tool: 'lance', flow: 9, color: '#8fc2f5', accent: '#002518' };
    case 'storm': return { ...base, id: 'storm', name: 'STORM', model: 'storm', layout: 'hexX', armLength: 0.34, propDiameter: 0.3, mass: 3, maxThrust: 15, motorTau: 0.045, dragArea: 0.07, battery: { cells: 6, capacityAh: 3.5 }, maxTilt: 32, maxSpeed: 16, maxClimb: 7, maxYawRate: 140, camUptilt: 10, tool: 'lance', flow: 9, color: '#004225', accent: '#b5f78a' };
    default: return { ...base, id: 'nova', name: 'NOVA', model: 'nova', layout: 'coaxX8', armLength: 0.4, propDiameter: 0.33, mass: 4.6, maxThrust: 17, motorTau: 0.05, dragArea: 0.1, battery: { cells: 8, capacityAh: 4 }, maxTilt: 34, maxSpeed: 18, maxClimb: 8, maxYawRate: 120, camUptilt: 5, tool: 'lance', flow: 9, color: '#f7f7f2', accent: '#26c257' };
  }
}
const SPEC_LINE: Record<TierId, string> = {
  spark: 'QUAD X  7 IN',
  bolt: 'QUAD X  10 IN  TANK',
  storm: 'HEX X  12 IN  EMP',
  nova: 'COAX X8  13 IN  NOVA BURST',
};
const TIER_FIRE: Record<TierId, { rate: number; speed: number; range: number }> = {
  spark: { rate: 4, speed: 110, range: 60 }, bolt: { rate: 5, speed: 120, range: 70 }, storm: { rate: 6, speed: 130, range: 80 }, nova: { rate: 7, speed: 140, range: 90 },
};

const VIEWS = [
  ['tiers', 'TIERS'], ['hover', 'HOVER'], ['silhouette', '60 M'], ['rings', 'RINGS'], ['fx', 'EFFECTS'], ['emp', 'EMP'],
  ['signalin', 'SIGNAL IN'], ['signalout', 'SIGNAL OUT'], ['ceiling', 'CEILING'], ['screen', 'SCREEN'], ['stress', '12 DRONES'], ['stress50', '50 DRONES'],
  ['close', 'CLOSE UP'], ['empty', 'EMPTY'],
] as const;

interface Pilot { v: DroneVisual; tier: TierId; spec: DroneSpec; c: THREE.Vector3; r: number; w: number; ph: number; h: number; fireT: number; id: string; jet: boolean; boost: boolean; }
interface LiveBolt { h: number; p: THREE.Vector3; d: THREE.Vector3; speed: number; t: number; life: number; hit: boolean; }
interface Label { el: HTMLElement; at: THREE.Vector3; }

/** true once per period when the phase point falls inside this frame (also on the very first frame) */
const crossed = (t: number, dt: number, P: number, ph: number) => Math.floor((t - dt - ph - 1e-6) / P) !== Math.floor((t - ph) / P);

function params() {
  const out: Record<string, string> = {};
  for (const part of location.hash.replace(/^#/, '').split('&')) { const [k, v] = part.split('='); if (k) out[k] = v ?? '1'; }
  return out;
}

export async function installGallery() {
  const w = window as unknown as { droneon?: { game: Game } };
  for (let i = 0; i < 400 && !w.droneon; i++) await new Promise(r => setTimeout(r, 50));
  if (!w.droneon) { console.error('art gallery: game did not boot'); return; }
  await new Promise(r => setTimeout(r, 300));
  new Gallery(w.droneon.game);
}

class Gallery {
  private art: RoyaleArtImpl;
  private sfx = new RoyaleSfxImpl();
  private group = new THREE.Group();
  private pilots: Pilot[] = [];
  private bolts: LiveBolt[] = [];
  private labels: Label[] = [];
  private rings: RingImpl[] = [];
  private cacheObjs: { update(dt: number): void; dispose(): void; object: THREE.Object3D }[] = [];
  private signal: ReturnType<RoyaleArtImpl['signal']> | null = null;
  private view = 'tiers';
  private t = 0;
  private freezeAt = -1;
  private fov = 0;
  private cpuArt = 0; private cpuSim = 0; private cpuN = 0;
  private panel: HTMLElement;
  private labelLayer: HTMLElement;
  private statsEl: HTMLElement;
  private camPos = new THREE.Vector3();
  private camLook = new THREE.Vector3();
  private focus = new THREE.Vector3();
  private building = 0;
  private fpsT = 0; private fpsN = 0; private fps = 0;
  private calls = 0; private tris = 0;
  private loops: ((dt: number, t: number) => void)[] = [];

  constructor(private game: Game) {
    const scene = game.world.scene;
    scene.add(this.group);
    this.group.name = 'art-gallery';
    this.art = new RoyaleArtImpl(scene);
    (document.getElementById('ui') as HTMLElement).style.display = 'none';
    game.camMode = 'free';
    game.renderer.info.autoReset = false;
    this.labelLayer = document.createElement('div');
    this.labelLayer.className = 'agal-labels';
    this.panel = document.createElement('div');
    this.panel.className = 'agal';
    this.statsEl = document.createElement('div');
    this.statsEl.className = 'agal-stats num';
    this.buildPanel();
    document.body.append(this.labelLayer, this.panel);
    game.on('frame', (dt) => this.frame(dt as number));
    // GPU cost of the art, independent of vsync: render n frames back to back, wait for the GPU,
    // once with everything and once with the gallery drones and all Royale art hidden
    (window as unknown as { __artBench: unknown }).__artBench = (n = 20) => {
      const gl = game.renderer.getContext();
      const run = () => { gl.finish(); const t0 = performance.now(); for (let i = 0; i < n; i++) game.composer.render(0.016); gl.finish(); return (performance.now() - t0) / n; };
      run();
      const show = (on: boolean) => { this.group.visible = on; this.art.group.visible = on; };
      // alternate five times and keep the best of each: robust against other work on the GPU
      let f = Infinity, w = Infinity;
      for (let i = 0; i < 5; i++) { f = Math.min(f, run()); show(false); w = Math.min(w, run()); show(true); }
      return { fullMs: +f.toFixed(2), worldOnlyMs: +w.toFixed(2), artMs: +(f - w).toFixed(2) };
    };
    addEventListener('hashchange', () => this.apply());
    this.apply();
  }

  // ---------------------------------------------------------------- panel

  private buildPanel() {
    const style = document.createElement('style');
    style.textContent = `
.agal{position:fixed;left:20px;top:20px;z-index:5;width:250px;padding:16px 18px 14px;background:rgba(0,28,18,.88);border:1px solid rgba(247,247,242,.1);border-radius:6px;color:#f7f7f2;font:500 12px/1.4 Inter,system-ui,sans-serif;backdrop-filter:blur(6px)}
.agal h1{font:400 15px/1 Nasalization,Audiowide,Inter,sans-serif;letter-spacing:.06em;margin:0 0 12px;color:#b5f78a}
.agal .row{display:flex;flex-wrap:wrap;gap:4px;margin:0 0 10px}
.agal button{font:400 11px/1 Nasalization,Audiowide,Inter,sans-serif;letter-spacing:.05em;color:rgba(247,247,242,.72);padding:7px 8px;border:1px solid rgba(247,247,242,.12);border-radius:4px;background:none;cursor:pointer;transition:color 120ms ease-out,border-color 120ms ease-out,transform 120ms ease-out}
.agal button:hover{color:#f7f7f2;border-color:rgba(247,247,242,.3)}
.agal button:active{transform:scale(.97)}
.agal button.on{color:#002518;background:#b5f78a;border-color:#b5f78a}
.agal .k{color:rgba(247,247,242,.5);font-size:10px;letter-spacing:.08em;margin:12px 0 6px;text-transform:uppercase}
.agal-stats{margin-top:10px;padding-top:10px;border-top:1px solid rgba(247,247,242,.1);font:400 11px/1.6 Nasalization,Audiowide,Inter,sans-serif;color:#b5f78a;white-space:pre;font-variant-numeric:tabular-nums}
.agal-labels{position:fixed;inset:0;pointer-events:none;z-index:4}
.agal-label{position:absolute;transform:translate(-50%,0);text-align:center;white-space:nowrap}
.agal-label b{display:block;font:400 15px/1 Nasalization,Audiowide,Inter,sans-serif;letter-spacing:.06em;color:#f7f7f2;text-shadow:0 1px 8px rgba(0,37,24,.8)}
.agal-label i{display:block;margin-top:5px;font:500 10px/1 Inter,system-ui,sans-serif;font-style:normal;letter-spacing:.08em;color:rgba(247,247,242,.78);text-shadow:0 1px 6px rgba(0,37,24,.9)}
.agal.hide{display:none}`;
    document.head.append(style);
    this.panel.innerHTML = `<h1>ROYALE ART</h1><div class="k">View</div><div class="row" data-g="view"></div><div class="k">Light</div><div class="row" data-g="time"></div><div class="k">Sound check</div><div class="row" data-g="sfx"></div>`;
    const vr = this.panel.querySelector('[data-g="view"]')!;
    for (const [id, name] of VIEWS) vr.append(this.button(name, () => this.setHash({ view: id }), 'v-' + id));
    const tr = this.panel.querySelector('[data-g="time"]')!;
    tr.append(this.button('DAY', () => this.setHash({ time: 'day' }), 't-day'), this.button('GOLDEN', () => this.setHash({ time: 'golden' }), 't-golden'),
      this.button('THERMAL', () => this.setHash({ thermal: params().thermal === '1' ? '0' : '1' }), 't-thermal'));
    const sr = this.panel.querySelector('[data-g="sfx"]')!;
    const s = this.sfx;
    const sounds: [string, () => void][] = [
      ['PULSE', () => s.pulse('spark', true, 0)], ['HIT', () => s.hit(true)], ['MARKER', () => s.hit(false)],
      ['WATER', () => { s.water('me', true, 0); setTimeout(() => s.water('me', false, 0), 1200); }],
      ['EMP', () => s.emp(false, 10)], ['NOVA', () => s.emp(true, 10)], ['EVOLVE', () => s.evolve('bolt')],
      ['SHINE', () => { for (let i = 0; i < 5; i++) setTimeout(() => s.ring('shine', i), i * 180); }], ['BIG', () => s.ring('bigshine', 0)],
      ['CHARGE', () => s.ring('charge', 0)], ['REPAIR', () => s.ring('repair', 0)], ['KO', () => s.knockout(20)],
      ['ALERT', () => s.signalWarning()], ['COUNT', () => { [3, 2, 1, 0].forEach((n, i) => setTimeout(() => s.countdown(n), i * 700)); }],
      ['VICTORY', () => s.victory()], ['STATIC', () => { let a = 0; const id = setInterval(() => { a += 0.05; s.staticCrackle(a < 1 ? a : 2 - a); if (a > 2) { clearInterval(id); s.staticCrackle(0); } }, 60); }],
      ['50 FIRING', () => this.fireStorm(50)],
    ];
    for (const [n, fn] of sounds) sr.append(this.button(n, () => { audio.start(); setTimeout(fn, 30); }));
    this.panel.append(this.statsEl);
  }

  private button(text: string, fn: () => void, key = '') {
    const b = document.createElement('button');
    b.type = 'button'; b.textContent = text;
    if (key) b.dataset.key = key;
    b.addEventListener('click', fn);
    return b;
  }

  private setHash(p: Record<string, string>) {
    const cur = { ...params(), ...p };
    delete cur.artgallery;
    location.hash = 'artgallery&' + Object.entries(cur).map(([k, v]) => `${k}=${v}`).join('&');
  }

  /** 50 drones firing for 3 s through the real mix: the limiter must hold */
  fireStorm(n: number) {
    const s = this.sfx;
    const tiers = TIERS;
    let k = 0;
    const id = setInterval(() => {
      for (let i = 0; i < n; i++) if (Math.random() < 0.3) s.pulse(tiers[i % 4], i === 0, 5 + i * 3);
      if (++k > 50) clearInterval(id);
    }, 60);
  }

  // ---------------------------------------------------------------- views

  private async apply() {
    const p = params();
    const g = this.game;
    this.panel.classList.toggle('hide', p.hud === '0');
    this.freezeAt = p.at ? parseFloat(p.at) : -1;
    g.settings.fov = 62 / Math.max(1, parseFloat(p.zoom ?? '1') || 1);
    const time = p.time === 'day' ? 'day' : 'golden';
    if (g.world.thermal) g.world.setThermal(false);
    g.world.currentTime = time;
    g.world.setTime(time);
    this.view = VIEWS.some(v => v[0] === p.view) ? p.view : 'tiers';
    for (const b of this.panel.querySelectorAll<HTMLButtonElement>('button[data-key]')) {
      const k = b.dataset.key!;
      b.classList.toggle('on', k === 'v-' + this.view || k === 't-' + time || (k === 't-thermal' && p.thermal === '1'));
    }
    const token = ++this.building;
    this.fov = 0;
    await this.build(this.view);
    if (token !== this.building) return;
    if (this.fov) g.settings.fov = this.fov / Math.max(1, parseFloat(p.zoom ?? '1') || 1);
    if (p.thermal === '1') g.world.setThermal(true, []);
  }

  private clear() {
    for (const p of this.pilots) { this.art.boost(p.v.root, false); p.v.root.removeFromParent(); disposeVisual(p.v); }
    this.pilots = [];
    for (const b of this.bolts) this.art.removeBolt(b.h);
    this.bolts = [];
    for (const r of this.rings) r.dispose();
    this.rings = [];
    for (const c of this.cacheObjs) c.dispose();
    this.cacheObjs = [];
    this.signal?.dispose(); this.signal = null;
    for (const l of this.labels) l.el.remove();
    this.labels = [];
    this.loops = [];
    this.art.screen.staticAmount(0); this.art.screen.scrambled(false); this.art.screen.lowIntegrity(false);
    this.art.fx.sparks.clear(); this.art.fx.puffs.clear();
    for (const c of [...this.group.children]) { c.removeFromParent(); c.traverse(o => { const m = o as THREE.Mesh; if (m.isMesh) { m.geometry.dispose(); (m.material as THREE.Material).dispose(); } }); }
  }

  private label(at: THREE.Vector3, title: string, sub = '') {
    const el = document.createElement('div');
    el.className = 'agal-label';
    el.innerHTML = `<b>${title}</b>${sub ? `<i>${sub}</i>` : ''}`;
    this.labelLayer.append(el);
    this.labels.push({ el, at: at.clone() });
  }

  private async pilot(tier: TierId, pos: THREE.Vector3, yaw = 0, id = ''): Promise<Pilot> {
    const spec = tierSpec(tier);
    const v = await buildDroneVisual(spec);
    v.root.position.copy(pos);
    v.root.rotation.y = yaw;
    this.group.add(v.root);
    const p: Pilot = { v, tier, spec, c: pos.clone(), r: 0, w: 0, ph: 0, h: pos.y, fireT: Math.random(), id: id || tier + Math.random(), jet: false, boost: false };
    this.pilots.push(p);
    return p;
  }

  private look(pos: THREE.Vector3, target: THREE.Vector3) { this.camPos.copy(pos); this.camLook.copy(target); }

  private async build(view: string) {
    this.clear();
    this.t = 0;
    const pad = this.game.world.pads[1];
    const ground = (x: number, z: number) => heightAt(x, z);
    this.focus.set(0, 0, 0);
    if (view === 'close') {
      const t = (TIERS as string[]).includes(params().tier) ? params().tier as TierId : 'storm';
      const spec = tierSpec(t);
      const span = spec.armLength * 2 + spec.propDiameter;
      const pos = new THREE.Vector3(pad.x, pad.y + TIER_LEG[t] + 0.004, pad.z);
      await this.pilot(t, pos, Math.PI * 0.8);
      this.look(new THREE.Vector3(pad.x + span * 0.42, pad.y + span * 0.5, pad.z + span * 0.95), new THREE.Vector3(pad.x, pad.y + TIER_LEG[t] * 0.75, pad.z));
      this.loops.push((dt) => { for (const p of this.pilots) animateProps(p.v, p.v.props.map(() => 0.08), dt, 8000); });
    } else if (view === 'empty') {
      this.look(new THREE.Vector3(pad.x + 0.1, 1.0, pad.z + 3.4), new THREE.Vector3(pad.x + 0.1, 0.3, pad.z));
    } else if (view === 'tiers' || view === 'screen') {
      const xs = [-1.75, -0.7, 0.55, 1.95];
      for (let i = 0; i < 4; i++) {
        const t = TIERS[i];
        const pos = new THREE.Vector3(pad.x + xs[i], pad.y + TIER_LEG[t] + 0.004, pad.z);
        await this.pilot(t, pos, Math.PI);
        this.label(new THREE.Vector3(pos.x, pad.y - 0.02, pos.z + 0.75), t.toUpperCase(), SPEC_LINE[t]);
      }
      this.look(new THREE.Vector3(pad.x + 0.1, 1.55, pad.z + 6.4), new THREE.Vector3(pad.x + 0.1, 0.22, pad.z));
      this.fov = 34;
      this.loops.push((dt) => { for (const p of this.pilots) animateProps(p.v, p.v.props.map(() => 0.1), dt, 8000); });
      if (view === 'screen') this.screenDemo();
    } else if (view === 'hover') {
      const xs = [-2.3, -0.85, 0.75, 2.5];
      for (let i = 0; i < 4; i++) {
        const t = TIERS[i];
        const pos = new THREE.Vector3(pad.x + xs[i], 1.7, pad.z);
        const p = await this.pilot(t, pos, Math.PI * 0.82);
        p.ph = i;
        this.label(new THREE.Vector3(pos.x, 0.62, pos.z), t.toUpperCase());
      }
      this.look(new THREE.Vector3(pad.x + 0.3, 2.55, pad.z + 4.0), new THREE.Vector3(pad.x + 0.1, 1.55, pad.z));
      this.loops.push((dt, time) => {
        for (const p of this.pilots) {
          p.v.root.position.y = p.h + Math.sin(time * 1.3 + p.ph) * 0.05;
          p.v.root.rotation.set(Math.sin(time * 0.9 + p.ph) * 0.05, Math.PI * 0.82 + Math.sin(time * 0.3 + p.ph) * 0.25, Math.cos(time * 0.8 + p.ph) * 0.05);
          animateProps(p.v, p.v.props.map(() => 0.55), dt, 8000);
        }
      });
    } else if (view === 'silhouette') {
      // the GDD readability test: four tiers at 60 m, game field of view, against sky and field
      const y = 24;
      for (let i = 0; i < 4; i++) {
        const t = TIERS[i];
        const pos = new THREE.Vector3(-7.5 + i * 5, y, -20);
        const p = await this.pilot(t, pos, Math.PI * 0.75);
        p.ph = i;
      }
      for (let i = 0; i < 4; i++) {
        const t = TIERS[i];
        const pos = new THREE.Vector3(-7.5 + i * 5, y - 7, -20);
        const p = await this.pilot(t, pos, Math.PI * 0.25);
        p.ph = i + 4;
      }
      this.look(new THREE.Vector3(0, y + 2, 39), new THREE.Vector3(0, y - 3.5, -20));
      this.loops.push((dt, time) => {
        for (const p of this.pilots) {
          p.v.root.position.y = p.h + Math.sin(time * 1.1 + p.ph) * 0.15;
          p.v.root.rotation.z = Math.sin(time * 0.7 + p.ph) * 0.12;
          animateProps(p.v, p.v.props.map(() => 0.55), dt, 8000);
        }
      });
    } else if (view === 'rings') {
      const R = 2.6;
      const cols: [RingKind, 'ready' | 'taken' | 'cooldown', string, string, boolean?][] = [
        ['shine', 'ready', 'SHINE', 'READY'], ['shine', 'taken', 'SHINE', 'TAKEN'], ['shine', 'cooldown', 'SHINE', 'COOLDOWN'],
        ['shine', 'ready', 'LANE START', 'HIGHLIGHT', true], ['bigshine', 'ready', 'BIG SHINE', '+3'], ['bigshine', 'cooldown', 'BIG SHINE', 'COOLDOWN'],
        ['charge', 'ready', 'CHARGE', 'READY'], ['charge', 'cooldown', 'CHARGE', 'COOLDOWN'], ['repair', 'ready', 'REPAIR', 'READY'], ['repair', 'cooldown', 'REPAIR', 'COOLDOWN'],
      ];
      cols.forEach(([kind, state, title, sub, hl], i) => {
        const row = i < 5 ? 0 : 1, col = i % 5;
        const r = this.art.ring(kind, kind === 'bigshine' ? 1.4 : R) as RingImpl;
        const x = -16 + col * 8, z = -14;
        const y = ground(x, z) + (row === 0 ? 10.6 : 3.4);
        r.object.position.set(x, y, z);
        r.setState(state, state === 'cooldown' ? 0.5 : undefined);
        if (hl) r.highlight(true);
        this.group.add(r.object);
        this.rings.push(r);
        this.label(new THREE.Vector3(x, y - R - 0.45, z), title, sub);
        if (state === 'cooldown') this.loops.push((_dt, t) => r.setState('cooldown', 1 - ((t * 0.2) % 1)));
      });
      const cache = this.art.shineCache();
      cache.object.position.set(24, ground(24, -14) + 7, -14);
      this.group.add(cache.object);
      this.cacheObjs.push(cache);
      this.label(new THREE.Vector3(24, ground(24, -14) + 5.6, -14), 'SHINE CACHE');
      this.look(new THREE.Vector3(4, 7.4, 19), new THREE.Vector3(4, 6.8, -14));
      this.focus.set(0, 0, -20);
    } else if (view === 'fx') {
      await this.fxView();
    } else if (view === 'emp') {
      const a = await this.pilot('storm', new THREE.Vector3(-18, 6, -30), 0);
      const b = await this.pilot('nova', new THREE.Vector3(18, 6, -30), 0);
      this.label(new THREE.Vector3(-18, 0.3, -30), 'EMP', 'STORM  RADIUS 15 M');
      this.label(new THREE.Vector3(18, 0.3, -30), 'NOVA BURST', 'NOVA  RADIUS 20 M');
      const cell = params().cell;
      if (cell === 'storm') this.look(new THREE.Vector3(-14, 9, -8), new THREE.Vector3(-18, 6, -30));
      else if (cell === 'nova') this.look(new THREE.Vector3(22, 10, -2), new THREE.Vector3(18, 6, -30));
      else this.look(new THREE.Vector3(0, 12, 14), new THREE.Vector3(0, 5, -30));
      this.focus.set(0, 0, -30);
      let last = -1;
      this.loops.push((dt, t) => {
        for (const p of [a, b]) animateProps(p.v, p.v.props.map(() => 0.55), dt, 8000);
        const cyc = Math.floor(t / 2.4), ph = t % 2.4;
        if (cyc !== last && ph > 0.2) { last = cyc; this.art.emp(a.v.root.position, 15, false, 'charge'); this.art.emp(b.v.root.position, 20, true, 'charge'); this.sfx.emp(false, 30); }
        if (crossed(t, dt, 2.4, 0.55)) { this.art.emp(a.v.root.position, 15, false, 'burst'); this.art.emp(b.v.root.position, 20, true, 'burst'); }
      });
    } else if (view === 'signalin' || view === 'signalout' || view === 'ceiling') {
      this.signal = this.art.signal();
      const c = new THREE.Vector3(-20, 0, -60);
      this.signal.set(c.x, c.z, 90, view === 'ceiling' ? 22 : 60);
      if (view === 'signalin') { this.look(new THREE.Vector3(-8, 7, 4), new THREE.Vector3(10, 9, 40)); this.focus.set(0, 0, 10); }
      else if (view === 'signalout') { this.look(new THREE.Vector3(30, 26, 110), new THREE.Vector3(-20, 8, 10)); this.focus.set(10, 0, 60); }
      else { this.look(new THREE.Vector3(-10, 15, -40), new THREE.Vector3(-10, 22, -95)); this.focus.set(-10, 0, -40); }
      const p = await this.pilot('bolt', view === 'ceiling' ? new THREE.Vector3(-10, 16, -46) : view === 'signalin' ? new THREE.Vector3(-3, 6, 12) : new THREE.Vector3(10, 18, 70), Math.PI);
      this.loops.push((dt) => animateProps(p.v, p.v.props.map(() => 0.55), dt, 8000));
      if (view === 'signalout') { this.art.screen.staticAmount(0.55); }
    } else if (view === 'stress' || view === 'stress50') {
      await this.stress(view === 'stress50' ? 50 : 12, view === 'stress50' ? 300 : 120);
    }
    this.game.sim.pos.copy(this.focus);
    this.game.visual.root.visible = false;
  }

  private async fxView() {
    const g = (x: number, z: number) => heightAt(x, z);
    const H = 4;
    // PULSE duel
    const a = await this.pilot('spark', new THREE.Vector3(-22, H, -10), -Math.PI / 2, 'duelA');
    const b = await this.pilot('bolt', new THREE.Vector3(-8, H, -10), Math.PI / 2, 'duelB');
    this.label(new THREE.Vector3(-15, g(-15, -10) + 0.2, -10), 'PULSE', 'BOLTS AND IMPACTS');
    // water jet
    const wj = await this.pilot('storm', new THREE.Vector3(2, H, -10), -Math.PI / 2, 'jet');
    this.label(new THREE.Vector3(8, g(8, -10) + 0.2, -10), 'WATER JET');
    // hit and knockout
    const hp = await this.pilot('nova', new THREE.Vector3(18, H, -10), Math.PI, 'hit');
    this.label(new THREE.Vector3(18, g(18, -10) + 0.2, -10), 'HIT');
    const ko = await this.pilot('bolt', new THREE.Vector3(26, H + 2, -10), Math.PI, 'ko');
    this.label(new THREE.Vector3(26, g(26, -10) + 0.2, -10), 'KNOCKOUT');
    // evolve: one slot that steps through the tiers
    const slot = new THREE.Group(); slot.position.set(-18, H, -24); this.group.add(slot);
    let evoTier = 0;
    let evoVisual: DroneVisual = await buildDroneVisual(tierSpec('spark'));
    slot.add(evoVisual.root);
    this.label(new THREE.Vector3(-18, g(-18, -24) + 0.2, -24), 'EVOLVE', '0.8 S');
    // boost: a drone on a circle
    const bo = await this.pilot('spark', new THREE.Vector3(0, H + 1, -26), 0, 'boost');
    bo.c.set(0, H + 1, -26); bo.r = 5; bo.w = 1.6;
    this.label(new THREE.Vector3(0, g(0, -26) + 0.2, -26), 'BOOST');
    // ring taken
    const ring = this.art.ring('shine', 2.6) as RingImpl;
    ring.object.position.set(16, H, -26); this.group.add(ring.object); this.rings.push(ring);
    const big = this.art.ring('bigshine', 1.4) as RingImpl;
    big.object.position.set(25, H, -26); this.group.add(big.object); this.rings.push(big);
    this.label(new THREE.Vector3(20, g(20, -26) + 0.2, -26), 'RING TAKEN');
    const cams: Record<string, [number, number, number, number, number, number]> = {
      pulse: [-15, 6.2, 3, -15, 4, -10], water: [8, 7.5, 3, 8, 3.2, -10], hit: [18.6, 4.8, -7.2, 18, 4, -10],
      ko: [23, 6.5, -1, 26, 3.6, -10], evolve: [-16.8, 5.3, -20.6, -18, 4, -24], boost: [0, 10, -13, 0, 4.5, -26],
      rings: [20.5, 5.5, -15.5, 20.5, 4, -26], overview: [2, 9, 10, 2, 3.5, -18],
    };
    const c = cams[params().cell ?? 'overview'] ?? cams.overview;
    this.look(new THREE.Vector3(c[0], c[1], c[2]), new THREE.Vector3(c[3], c[4], c[5]));
    this.focus.set(2, 0, -16);
    const duel = [a, b];
    let koT = 0;
    this.loops.push((dt, t) => {
      for (const p of this.pilots) if (p !== ko || koT < 0.05) animateProps(p.v, p.v.props.map(() => 0.55), dt, 8000);
      // duel: both fire at each other
      for (const [s, d] of [[duel[0], duel[1]], [duel[1], duel[0]]] as const) {
        s.fireT -= dt;
        if (s.fireT <= 0) {
          s.fireT = 1 / TIER_FIRE[s.tier].rate;
          const from = s.v.root.position.clone().add(new THREE.Vector3(0, -0.02, 0));
          const to = d.v.root.position.clone().add(new THREE.Vector3((Math.random() - 0.5) * 0.6, (Math.random() - 0.5) * 0.4, 0));
          const dir = to.clone().sub(from).normalize();
          const f = TIER_FIRE[s.tier];
          const h = this.art.bolt(from, dir, s.tier, s.spec.color);
          this.bolts.push({ h, p: from, d: dir, speed: f.speed * 0.25, t: 0, life: from.distanceTo(to) / (f.speed * 0.25), hit: true });
        }
      }
      // water jet: 1.6 s on, 0.8 s off
      const on = (t % 2.4) < 1.6;
      const nz = wj.v.nozzles[0];
      const from = nz.pos.clone().applyQuaternion(wj.v.root.quaternion).add(wj.v.root.position);
      const dir = nz.dir.clone().applyQuaternion(wj.v.root.quaternion);
      if (on || wj.jet) this.art.waterJet('jet', from, dir, 12, on);
      wj.jet = on;
      // hits on the Nova every 0.6 s
      if (Math.floor(t / 0.6) !== Math.floor((t - dt) / 0.6)) this.art.hit(hp.v.root.position.clone().add(new THREE.Vector3((Math.random() - 0.5) * 0.4, 0.1, 0.3)), 8 + Math.random() * 20, false);
      // knockout every 2.4 s: pop, power down, fall, respawn
      koT += dt;
      if (koT > 2.4) { koT = 0; ko.v.root.position.set(26, H + 2, -10); ko.v.root.rotation.set(0, Math.PI, 0); }
      if (koT > 0.05 && koT - dt <= 0.05) this.art.knockout(ko.v.root.position);
      if (koT > 0.05) { const f = koT - 0.05; ko.v.root.position.y = Math.max(g(26, -10) + 0.15, H + 2 - 4.9 * f * f); ko.v.root.rotation.x += dt * 4; ko.v.root.rotation.z += dt * 2.5; }
      // evolve every 2.4 s, model swap at 0.3 s under the same root
      const ec = Math.floor(t / 2.4), eph = t % 2.4;
      if (crossed(t, dt, 2.4, 0)) this.art.evolve(slot, TIERS[(evoTier + 1) % 4]);
      if (crossed(t, dt, 2.4, 0.3)) {
        evoTier = (evoTier + 1) % 4;
        slot.remove(evoVisual.root); disposeVisual(evoVisual);
        buildDroneVisual(tierSpec(TIERS[evoTier])).then(v => { evoVisual = v; slot.add(v.root); });
      }
      void ec;
      if (evoVisual) animateProps(evoVisual, evoVisual.props.map(() => 0.55), dt, 8000);
      slot.rotation.y = t * 0.4;
      // boost on the circle: 1.2 s on, 1.2 s off
      const ang = t * bo.w;
      bo.v.root.position.set(bo.c.x + Math.cos(ang) * bo.r, bo.c.y, bo.c.z + Math.sin(ang) * bo.r);
      bo.v.root.rotation.set(0, -ang, 0.35);
      const bon = (t % 2.4) < 1.2;
      if (bon !== bo.boost) { this.art.boost(bo.v.root, bon); bo.boost = bon; }
      // rings taken and respawned
      const rp = t % 2.4;
      if (crossed(t, dt, 2.4, 0)) { ring.setState('ready'); big.setState('ready'); }
      if (crossed(t, dt, 2.4, 1.2)) { ring.setState('taken'); this.art.ringTaken(ring.object.position, 'shine'); big.setState('cooldown', 1); this.art.ringTaken(big.object.position, 'bigshine'); }
    });
  }

  /** the screen overlays: cycle all, or hold one with &fx=static|low|dmg|scramble|flash for review */
  private screenDemo() {
    const s = this.art.screen;
    const only = params().fx;
    this.loops.push((dt, t) => {
      if (only) {
        s.staticAmount(only === 'static' ? 0.6 + 0.4 * Math.sin(t * 0.5) ** 2 : 0);
        s.lowIntegrity(only === 'low' || only === 'dmg');
        s.scrambled(only === 'scramble');
        if (only === 'dmg' && crossed(t, dt, 0.3, 0)) s.damageFrom(Math.random() * Math.PI * 2, 10 + Math.random() * 20);
        if (only === 'flash' && crossed(t, dt, 1.2, 0)) s.evolveFlash('bolt');
        return;
      }
      const ph = t % 10;
      s.staticAmount(ph < 2.5 ? Math.min(1, ph / 1.5) : 0);
      s.lowIntegrity(ph > 2.5 && ph < 5);
      if (ph > 2.6 && ph < 5 && crossed(t, dt, 0.45, 0)) s.damageFrom(Math.random() * Math.PI * 2, 10 + Math.random() * 20);
      s.scrambled(ph > 5.2 && ph < 7.4);
      if (crossed(t, dt, 10, 8)) s.evolveFlash('bolt');
    });
  }

  private async stress(n: number, liveBolts: number) {
    const mix: TierId[] = [];
    const share = n === 12 ? [5, 4, 2, 1] : [20, 14, 10, 6];
    share.forEach((k, i) => { for (let j = 0; j < k; j++) mix.push(TIERS[i]); });
    const area = n === 12 ? 45 : 110;
    for (let i = 0; i < n; i++) {
      const t = mix[i];
      // a third of the field fights close to the camera, the rest spreads over the arena
      const close = i % 3 === 0;
      const c = close ? new THREE.Vector3((Math.random() - 0.5) * 50, 0, -10 + (Math.random() - 0.5) * 40)
        : new THREE.Vector3((Math.random() - 0.5) * area * 2, 0, -area * 0.6 + (Math.random() - 0.5) * area * 1.6);
      const h = heightAt(c.x, c.z) + 6 + Math.random() * 18;
      const p = await this.pilot(t, new THREE.Vector3(c.x, h, c.z), 0, 'p' + i);
      p.c.set(c.x, h, c.z); p.r = 4 + Math.random() * 14; p.w = (Math.random() < 0.5 ? -1 : 1) * (0.25 + Math.random() * 0.4); p.ph = Math.random() * 6.28; p.h = h;
      p.jet = i % 9 === 0 && t !== 'spark';
    }
    this.look(new THREE.Vector3(0, 21, 34), new THREE.Vector3(0, 9, -30));
    this.focus.set(0, 0, -10);
    const tmp = new THREE.Vector3(), q = new THREE.Quaternion();
    this.loops.push((dt, t) => {
      for (const p of this.pilots) {
        const a = p.ph + t * p.w;
        p.v.root.position.set(p.c.x + Math.cos(a) * p.r, p.h + Math.sin(t * 0.8 + p.ph) * 1.5, p.c.z + Math.sin(a) * p.r);
        p.v.root.rotation.set(0.12, -a - Math.sign(p.w) * Math.PI / 2, Math.sign(p.w) * 0.3, 'YXZ');
        animateProps(p.v, p.v.props.map(() => 0.55), dt, 8000);
        if (p.jet) {
          const nz = p.v.nozzles[0];
          if (nz) { q.copy(p.v.root.quaternion); this.art.waterJet(p.id, nz.pos.clone().applyQuaternion(q).add(p.v.root.position), nz.dir.clone().applyQuaternion(q), 22, (t + p.ph) % 3 < 1.8); }
        }
        const boostOn = ((t + p.ph * 2) % 6) < 1.2;
        if (boostOn !== p.boost) { this.art.boost(p.v.root, boostOn); p.boost = boostOn; }
      }
      // keep the live bolt count at the target: the shooter is any drone, the target another one
      while (this.bolts.length < liveBolts) {
        const s = this.pilots[Math.floor(Math.random() * this.pilots.length)];
        const d = this.pilots[Math.floor(Math.random() * this.pilots.length)];
        const f = TIER_FIRE[s.tier];
        const from = s.v.root.position.clone();
        tmp.copy(d.v.root.position).sub(from);
        if (tmp.lengthSq() < 4) tmp.set(Math.random() - 0.5, 0, -1);
        const dir = tmp.normalize().clone();
        const life = (f.range / f.speed) * (0.5 + Math.random() * 0.5);
        const h = this.art.bolt(from, dir, s.tier, s.spec.color);
        this.bolts.push({ h, p: from, d: dir, speed: f.speed, t: Math.random() * life * 0.5, life, hit: Math.random() < 0.35 });
      }
    });
  }

  // ---------------------------------------------------------------- frame

  private frame(dt: number) {
    const g = this.game;
    // measure the frame that was just rendered, then start counting the next one
    const info = g.renderer.info;
    this.calls = info.render.calls; this.tris = info.render.triangles;
    info.reset();
    this.fpsN++; this.fpsT += dt;
    let slow = false;
    if (this.fpsT >= 0.5) { this.fps = this.fpsN / this.fpsT; this.fpsN = 0; this.fpsT = 0; slow = true; }
    // &at=<s> freezes every effect at that moment of its 2.4 s cycle, for clean review shots
    if (this.freezeAt >= 0 && this.t >= this.freezeAt) dt = 0;
    this.t += dt;
    const c0 = performance.now();
    if (dt > 0) for (const l of this.loops) l(dt, this.t);
    // bolts in flight
    for (let i = this.bolts.length - 1; i >= 0; i--) {
      const b = this.bolts[i];
      b.t += dt;
      b.p.addScaledVector(b.d, b.speed * dt);
      if (b.t >= b.life) {
        this.art.removeBolt(b.h, { pos: b.p, hitDrone: b.hit });
        this.bolts.splice(i, 1);
      } else this.art.moveBolt(b.h, b.p);
    }
    for (const c of this.cacheObjs) c.update(dt);
    const c1 = performance.now();
    this.art.update(dt, g.camera);
    this.cpuArt += performance.now() - c1; this.cpuSim += c1 - c0; this.cpuN++;
    // camera for the next frame (free camera mode reads camPos, yaw and pitch)
    const gg = g as unknown as { camPos: THREE.Vector3 };
    g.camMode = 'free';
    gg.camPos.copy(this.camPos);
    const d = this.camLook.clone().sub(this.camPos);
    g.freeYaw = Math.atan2(-d.x, -d.z);
    g.freePitch = Math.atan2(d.y, Math.hypot(d.x, d.z));
    g.visual.root.visible = false;
    // labels
    const cam = g.camera;
    const v = new THREE.Vector3();
    for (const l of this.labels) {
      v.copy(l.at).project(cam);
      const hide = v.z > 1;
      l.el.style.display = hide ? 'none' : '';
      if (!hide) l.el.style.transform = `translate(${((v.x * 0.5 + 0.5) * innerWidth).toFixed(1)}px, ${((-v.y * 0.5 + 0.5) * innerHeight).toFixed(1)}px) translate(-50%, 0)`;
    }
    if (!slow) return;
    const st = this.art.stats();
    let dtris = 0; for (const p of this.pilots) dtris += triangles(p.v.root);
    const lod = [st.crowd.near, st.crowd.mid, st.crowd.far];
    const artMs = this.cpuArt / Math.max(1, this.cpuN), simMs = this.cpuSim / Math.max(1, this.cpuN);
    this.cpuArt = this.cpuSim = this.cpuN = 0;
    this.statsEl.textContent = `FPS ${this.fps.toFixed(0)}\nDRAW CALLS ${this.calls}\nTRIANGLES ${(this.tris / 1000).toFixed(0)} K\nDRONES ${this.pilots.length}\nBOLTS ${st.bolts}\nSPARKS ${st.sparks}  PUFFS ${st.puffs}`;
    (window as unknown as { __art: unknown }).__art = { fps: +this.fps.toFixed(1), calls: this.calls, tris: this.tris, drones: this.pilots.length, lodNearMidFar: lod, artCpuMs: +artMs.toFixed(2), galleryCpuMs: +simMs.toFixed(2), ...st };
  }
}
