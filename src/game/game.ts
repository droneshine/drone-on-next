import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { World, TimeOfDay } from '../world/world';
import { DroneSim, Sticks } from '../sim/drone';
import { DroneSpec, FEATURED, FlightMode, featured } from '../sim/spec';
import { buildDroneVisual, animateProps, disposeVisual, DroneVisual } from '../render/droneModels';
import { Particles, Hose } from '../render/effects';
import { Input } from '../input/input';
import { audio } from '../audio/audio';
import { Builder, MapData, PIECES, starterMap } from './builder';
import { allMissions, Mission, MissionCtx, MissionResult, RingTracker } from './missions';
import { getLS, setLS, progress, saveProgress } from './store';
import { heightAt } from '../world/terrain';
import type { Multiplayer } from '../net/multiplayer';

export type State = 'boot' | 'menu' | 'fly' | 'mission' | 'build' | 'result';
export type CamMode = 'chase' | 'fpv' | 'los' | 'orbit' | 'free';

export interface Settings {
  quality: 'low' | 'high';
  time: TimeOfDay;
  windSpeed: number; windDir: number; gust: number;
  fov: number; fpvFov: number;
  volume: number;
  throttleHover: boolean;
  showSticks: boolean;
  joystick: boolean;
  camUptilt: number | null;
  crashes: boolean;
  invertLook: boolean;
}

const DEFAULT_SETTINGS: Settings = {
  quality: matchMedia('(pointer: coarse)').matches ? 'low' : 'high',
  time: 'golden', windSpeed: 3, windDir: 70, gust: 0.35,
  fov: 62, fpvFov: 110, volume: 0.7, throttleHover: true, showSticks: true, joystick: true, camUptilt: null, crashes: true, invertLook: false,
};

/** stored settings are untrusted: unknown keys dropped, wrong types and ranges replaced by defaults */
function sanitizeSettings(raw: unknown): Settings {
  const s = { ...DEFAULT_SETTINGS };
  if (!raw || typeof raw !== 'object') return s;
  const r = raw as Record<string, unknown>;
  const n = (k: keyof Settings, lo: number, hi: number) => { const v = r[k]; if (typeof v === 'number' && isFinite(v)) (s as unknown as Record<string, number>)[k] = Math.min(hi, Math.max(lo, v)); };
  const b = (k: keyof Settings) => { if (typeof r[k] === 'boolean') (s as unknown as Record<string, boolean>)[k] = r[k] as boolean; };
  if (r.quality === 'low' || r.quality === 'high') s.quality = r.quality;
  if (['day', 'golden', 'overcast', 'dusk'].includes(r.time as string)) s.time = r.time as TimeOfDay;
  n('windSpeed', 0, 14); n('windDir', 0, 360); n('gust', 0, 1); n('fov', 40, 100); n('fpvFov', 70, 140); n('volume', 0, 1);
  b('throttleHover'); b('showSticks'); b('joystick'); b('crashes'); b('invertLook');
  s.camUptilt = typeof r.camUptilt === 'number' && isFinite(r.camUptilt) ? Math.min(60, Math.max(-30, r.camUptilt)) : null;
  return s;
}

export interface Telemetry {
  alt: number; agl: number; speed: number; vz: number; heading: number; soc: number; volt: number; amps: number; watts: number;
  mode: FlightMode; armed: boolean; crashed: boolean; crashReason: string; sticks: Sticks; wind: number; windDir: number;
  dist: number; flightTime: number; tank: number | null; thermal: boolean; cam: CamMode; spraying: boolean; gimbal: number;
  missionHud: string; tilt: number; device: string;
}

// Keeps HDR values in a range the half float targets and bloom can handle. The sky's sun can
// reach the float16 limit, and Infinity or NaN would spread through the bloom chain and black out the frame.
const clampShader = {
  uniforms: { tDiffuse: { value: null }, uMax: { value: 16 } },
  vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.); }',
  fragmentShader: `
    uniform sampler2D tDiffuse; uniform float uMax; varying vec2 vUv;
    void main(){
      vec4 c = texture2D(tDiffuse, vUv);
      if (any(isnan(c.rgb)) || any(isinf(c.rgb))) c.rgb = vec3(uMax);
      gl_FragColor = vec4(min(c.rgb, vec3(uMax)), c.a);
    }`,
};

const thermalShader = {
  uniforms: { tDiffuse: { value: null }, uOn: { value: 0 }, uTime: { value: 0 } },
  vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.); }',
  fragmentShader: `
    uniform sampler2D tDiffuse; uniform float uOn; uniform float uTime; varying vec2 vUv;
    float h(vec2 p){ return fract(sin(dot(p, vec2(12.9898,78.233)) + uTime) * 43758.5453); }
    void main(){
      vec4 c = texture2D(tDiffuse, vUv);
      if (uOn > 0.5) {
        // sensor look: soft, grainy, 640 class resolution
        vec2 px = floor(vUv * vec2(640., 512.)) / vec2(640., 512.);
        c = texture2D(tDiffuse, px);
        c.rgb += (h(vUv * 800.) - 0.5) * 0.06;
        float v = smoothstep(1.1, 0.35, length(vUv - 0.5));
        c.rgb *= mix(0.75, 1.0, v);
      }
      if (any(isnan(c.rgb)) || any(isinf(c.rgb))) c.rgb = vec3(1.0);
      gl_FragColor = c;
    }`,
};

/** a stored best lap, only when it is a real positive number */
function goodLap(v: unknown) { return typeof v === 'number' && Number.isFinite(v) && v > 0 && v < 36000 ? v : 0; }

export class Game {
  renderer: THREE.WebGLRenderer;
  composer: EffectComposer;
  camera: THREE.PerspectiveCamera;
  world: World;
  input = new Input();
  settings: Settings;
  state: State = 'boot';
  camMode: CamMode = 'orbit';
  spec: DroneSpec = featured('dscan');
  /** the drone the pilot picked in the hangar; missions borrow others and give this one back */
  chosenSpec: DroneSpec = featured('dscan');
  sim!: DroneSim;
  visual!: DroneVisual;
  particles = new Particles(7000);
  hose: Hose | null = null;
  builder: Builder;
  missions = allMissions();
  mission: Mission | null = null;
  mctx: MissionCtx | null = null;
  missionTime = 0;
  missionStarted = false;
  result: MissionResult | null = null;
  tank: number | null = null;
  gimbalPitch = -15;
  spraying = false;
  flightTime = 0;
  private acc = 0;
  private last = performance.now();
  private bloom: UnrealBloomPass;
  clampPass!: ShaderPass;
  private thermalPass: ShaderPass;
  private camPos = new THREE.Vector3(10, 5, 14);
  private camLook = new THREE.Vector3();
  private orbitT = 0;
  freeYaw = 0; freePitch = -0.3;
  private markerObj: THREE.Group;
  markerPos: THREE.Vector3 | null = null;
  markerLabel = '';
  private raceTracker: RingTracker | null = null;
  raceTime = 0; raceBest = 0; raceRunning = false; raceIdx = 0; raceCount = 0;
  private home = new THREE.Vector3();
  private homeYaw = 0;
  mp: Multiplayer | null = null;
  /** true during a multiplayer countdown: motors stay off */
  raceLocked = false;
  private tagPressed = false;
  listeners: { [k: string]: ((...a: unknown[]) => void)[] } = {};
  paused = false;
  visualLoaded = false;
  private debris: { m: THREE.Mesh; v: THREE.Vector3; w: THREE.Vector3 }[] = [];
  losPilot = new THREE.Vector3(0, 1.7, 14);
  private droneToken = 0;
  courseBeforeMission: { map: MapData; origin: Builder['origin'] } | null = null;
  private batteryWarned = 1;
  private autosaveTimer = 0;
  contextLost = false;
  private resizeQueued = false;
  private lastDevice = '';

  constructor(canvas: HTMLCanvasElement) {
    this.settings = sanitizeSettings(getLS<Partial<Settings>>('settings', {}));
    const r = this.renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance', stencil: false });
    r.setPixelRatio(this.pixelRatio());
    r.setSize(innerWidth, innerHeight);
    r.shadowMap.enabled = true;
    r.shadowMap.type = THREE.PCFShadowMap;
    r.toneMapping = THREE.ACESFilmicToneMapping;
    r.outputColorSpace = THREE.SRGBColorSpace;
    this.camera = new THREE.PerspectiveCamera(this.settings.fov, innerWidth / innerHeight, 0.03, 9000);
    this.world = new World(r, this.settings.quality);
    this.world.currentTime = this.settings.time;
    this.world.setTime(this.settings.time);
    this.world.setWind(this.settings.windSpeed, this.settings.windDir, this.settings.gust);
    this.world.scene.add(this.particles.points);
    this.particles.floorFn = (x, y, z) => {
      const s = this.world.solar;
      const row = s.rowAt(z);
      if (row >= 0 && x > s.rows[row].x0 && x < s.rows[row].x1 && y < 2.8 && y > 0.6) return true;
      const f = this.world.facade;
      return x > f.planeX && x < f.planeX + 18 && z > f.z0 && z < f.z1 && y < f.h;
    };
    const rt = new THREE.WebGLRenderTarget(innerWidth, innerHeight, { type: THREE.HalfFloatType, samples: this.settings.quality === 'high' ? 4 : 2 });
    this.composer = new EffectComposer(r, rt);
    this.composer.addPass(new RenderPass(this.world.scene, this.camera));
    this.clampPass = new ShaderPass(clampShader);
    this.composer.addPass(this.clampPass);
    this.bloom = new UnrealBloomPass(new THREE.Vector2(innerWidth, innerHeight), 0.25, 0.05, 8);
    this.composer.addPass(this.bloom);
    this.thermalPass = new ShaderPass(thermalShader);
    this.composer.addPass(this.thermalPass);
    this.composer.addPass(new OutputPass());
    this.builder = new Builder(this.world);
    this.builder.onChanged = () => { this.scheduleAutosave(); this.emit('build-changed'); };
    this.markerObj = makeMarker();
    this.markerObj.visible = false;
    this.world.scene.add(this.markerObj);
    // resize once now so every target is sized with the pixel ratio, then debounce to one per frame
    this.resize();
    addEventListener('resize', () => {
      if (this.resizeQueued) return;
      this.resizeQueued = true;
      requestAnimationFrame(() => { this.resizeQueued = false; this.resize(); });
    });
    canvas.addEventListener('webglcontextlost', e => { e.preventDefault(); this.contextLost = true; audio.silence(); this.emit('gl', 'lost'); });
    canvas.addEventListener('webglcontextrestored', () => {
      this.contextLost = false;
      const thermal = this.world.thermal;
      try {
        if (thermal) this.world.setThermal(false);
        this.world.setTime(this.world.currentTime);
        if (thermal) this.world.setThermal(true, this.visual ? [this.visual.root] : []);
      } catch (e) { console.error(e); }
      this.resize();
      this.emit('gl', 'restored');
    });
    audio.setVolume(this.settings.volume);
    // the last edit survives a closed tab or a reload right after it
    addEventListener('pagehide', () => this.flushAutosave());
    document.addEventListener('visibilitychange', () => { if (document.hidden) this.flushAutosave(); });
  }

  private pixelRatio() { return Math.min(devicePixelRatio, this.settings.quality === 'high' ? 1.75 : 1.25); }

  on(ev: string, fn: (...a: unknown[]) => void) { (this.listeners[ev] ??= []).push(fn); }
  emit(ev: string, ...a: unknown[]) {
    for (const f of this.listeners[ev] ?? []) {
      try { f(...a); } catch (e) { console.error(e); }
    }
  }
  toast(t: string) { this.emit('toast', t); }

  saveSettings() { setLS('settings', this.settings); }

  applySettings() {
    this.world.currentTime = this.settings.time;
    if (!this.world.thermal) this.world.setTime(this.settings.time);
    if (!this.mission?.wind) this.world.setWind(this.settings.windSpeed, this.settings.windDir, this.settings.gust);
    audio.setVolume(this.settings.volume);
    if (this.sim) this.sim.throttleCurveHover = this.settings.throttleHover;
    this.saveSettings();
  }

  resize() {
    this.renderer.setPixelRatio(this.pixelRatio());
    this.renderer.setSize(innerWidth, innerHeight);
    this.composer.setPixelRatio(this.pixelRatio());
    this.composer.setSize(innerWidth, innerHeight);
    this.camera.aspect = innerWidth / innerHeight;
    this.camera.updateProjectionMatrix();
  }

  /** compile shaders behind the boot screen instead of freezing on first use */
  async warmup() {
    try { await this.renderer.compileAsync(this.world.scene, this.camera); } catch { /* optional */ }
  }

  // ------------------------------------------------------------------ drone management
  /** the pilot's own pick in the hangar: remembered across visits */
  async chooseDrone(spec: DroneSpec) {
    this.chosenSpec = spec;
    setLS('lastDrone', spec.id);
    await this.setDrone(spec);
  }

  async setDrone(spec: DroneSpec, spawn?: { pos: THREE.Vector3; yaw: number }) {
    const token = ++this.droneToken;
    const sp = spawn ?? { pos: this.world.pads[1].clone(), yaw: 0 };
    // same drone again: keep the model, just move it
    const reuse = this.visualLoaded && spec === this.spec && this.visual;
    let visual = this.visual;
    if (!reuse) {
      visual = await buildDroneVisual(spec);
      // a newer call won the race while this model was loading: throw this one away
      if (token !== this.droneToken) { disposeVisual(visual); return; }
      if (this.visual) { this.world.scene.remove(this.visual.root); disposeVisual(this.visual); }
      this.world.scene.add(visual.root);
    }
    if (this.hose) { this.world.scene.remove(this.hose.mesh); this.hose.mesh.geometry.dispose(); (this.hose.mesh.material as THREE.Material).dispose(); this.hose = null; }
    this.spec = spec;
    this.visual = visual;
    this.sim = new DroneSim(spec, this.world.colliders);
    this.sim.throttleCurveHover = this.settings.throttleHover;
    this.visualLoaded = true;
    this.input.throttleSprings = this.sim.mode === 'gps';
    if (spec.hose) {
      this.hose = new Hose(this.world.facade.pumpAnchor.clone(), 50);
      this.hose.maxForce = spec.mass * 9.81 * 1.5;
      this.world.scene.add(this.hose.mesh);
    }
    this.gimbalPitch = spec.tool === 'lance' ? -5 : spec.tool === 'thermal' ? -35 : -15;
    this.home.copy(sp.pos); this.homeYaw = sp.yaw;
    this.world.clearSpot.set(sp.pos.x, Math.max(3, spec.armLength * 2 + spec.propDiameter + 1), sp.pos.z);
    this.resetDrone();
    this.mp?.announce();
    this.emit('drone');
  }

  private portablePump: THREE.Group | null = null;
  private setPortablePump(at: THREE.Vector3 | null) {
    if (!at) { if (this.portablePump) this.portablePump.visible = false; return; }
    if (!this.portablePump) {
      const g = new THREE.Group();
      const body = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.7, 1.2), new THREE.MeshStandardMaterial({ color: '#0f4a2b', roughness: 0.5 }));
      body.position.y = 0.35; g.add(body);
      const drum = new THREE.Mesh(new THREE.CylinderGeometry(0.32, 0.32, 0.5, 20), new THREE.MeshStandardMaterial({ color: '#e6e3d8', roughness: 0.5 }));
      drum.rotation.z = Math.PI / 2; drum.position.set(0, 0.85, 0.2); g.add(drum);
      g.traverse(o => { (o as THREE.Mesh).castShadow = true; });
      g.userData.temp = 0.7;
      this.world.scene.add(g); this.portablePump = g;
    }
    this.portablePump.visible = true;
    this.portablePump.position.set(at.x, at.y - 0.9, at.z);
  }

  setHome(pos: THREE.Vector3, yaw: number) { this.home.copy(pos); this.homeYaw = yaw; }

  resetDrone() {
    this.sim.reset(this.home, this.homeYaw);
    this.input.touchSpray = false;
    this.tank = this.spec.tool === 'sprayDown' ? (this.spec.tank ?? 10) : null;
    this.sim.payload = this.tank ?? 0;
    this.input.setThrottleRest(this.input.throttleSprings);
    this.flightTime = 0;
    this.batteryWarned = 1;
    this.particles.clear();
    for (const d of this.debris) { this.world.scene.remove(d.m); }
    this.debris = [];
    this.visual.root.visible = true;
    for (const p of this.visual.props) p.blades.visible = true;
    let nearFacade = false;
    if (this.hose) {
      // the hose runs from the facade pump when DShine starts there, otherwise a mobile
      // pump stands next to the take off spot, like the trailer on a real job
      const fixed = this.world.facade.pumpAnchor;
      nearFacade = Math.hypot(this.home.x - fixed.x, this.home.z - fixed.z) < this.hose.length * 0.8;
      if (nearFacade) { this.hose.anchor.copy(fixed); this.setPortablePump(null); }
      else {
        const off = new THREE.Vector3(-3.2, 0, 2.4).applyAxisAngle(new THREE.Vector3(0, 1, 0), this.homeYaw);
        const a = this.home.clone().add(off);
        a.y = heightAt(a.x, a.z) + 0.9;
        this.hose.anchor.copy(a);
        this.setPortablePump(a);
      }
      this.hose.reset(this.attachPoint());
    } else this.setPortablePump(null);
    // the pilot stands behind the take off spot, at the facade pump for facade work
    const behind = new THREE.Vector3(Math.sin(this.homeYaw), 0, Math.cos(this.homeYaw));
    if (nearFacade) this.losPilot.copy(this.world.facade.pumpAnchor).add(new THREE.Vector3(-6, -0.5, 4));
    else this.losPilot.copy(this.home).addScaledVector(behind, 12);
    this.losPilot.y = heightAt(this.losPilot.x, this.losPilot.z) + 1.7;
    // chase camera starts behind the drone, not swinging in from the old spot
    const L = this.spec.armLength * 2 + this.spec.propDiameter;
    const dist = Math.max(2.4, L * (L > 2 ? 2.3 : 3.2));
    this.camPos.copy(this.home).addScaledVector(behind, dist).add(new THREE.Vector3(0, dist * 0.38 + 0.3, 0));
    this.camLook.copy(this.home);
  }

  private attachPoint() {
    return new THREE.Vector3(0, -0.25, 0.05).applyQuaternion(this.sim.quat).add(this.sim.pos);
  }

  setMode(m: FlightMode) {
    this.sim.setMode(m);
    this.input.throttleSprings = m === 'gps';
    // switching in the air: throttle continues at hover, on the ground it rests at the bottom
    if (m !== 'gps') this.input.setKeyboardThrottle(this.sim.armed ? 0.5 : 0);
    this.input.setThrottleRest(m === 'gps', this.sim.armed);
    this.emit('mode');
    this.toast(m === 'gps' ? 'GPS hold. Release the sticks and it stays put.' : m === 'angle' ? 'Angle mode. Self levelling, you hold altitude.' : 'Acro mode. No self levelling. This is real flying.');
  }

  // ------------------------------------------------------------------ states
  async enterMenu() {
    this.endMission();
    this.builder.active = false; this.builder.hideGhost();
    this.flushAutosave();
    this.paused = false;
    this.state = 'menu';
    this.camMode = 'orbit';
    this.world.setThermal(false);
    this.world.setWind(this.settings.windSpeed, this.settings.windDir, this.settings.gust);
    this.setMarker(null);
    if (!this.visualLoaded || this.spec !== this.chosenSpec) await this.setDrone(this.chosenSpec);
    else { this.home.copy(this.world.pads[1]); this.homeYaw = 0; this.resetDrone(); }
    audio.silence();
    document.exitPointerLock?.();
    this.emit('state', this.state);
  }

  /** Free flight. A map passed in (share link) is validated and never overwrites the pilot's own course. */
  async startFreeFlight(map?: unknown) {
    this.endMission();
    this.flushAutosave();
    this.paused = false;
    this.state = 'fly';
    this.builder.active = false; this.builder.hideGhost();
    if (map !== undefined) {
      if (!this.builder.load(map, { origin: 'shared' })) { this.toast('That course link is damaged, loading your own course'); this.loadOwnCourse(); }
    } else if (!this.builder.loaded || (!this.mp && this.builder.origin !== 'own')) {
      // FLY from the menu is your own course; a friend's link only lasts for that flight
      this.loadOwnCourse();
    }
    const spawn = this.spawnPoint();
    await this.setDrone(this.spec === this.chosenSpec ? this.spec : this.chosenSpec, spawn);
    this.world.setWind(this.settings.windSpeed, this.settings.windDir, this.settings.gust);
    this.camMode = this.spec.model === 'racer' ? 'fpv' : 'chase';
    this.resetRace();
    progressBump('flights');
    this.emit('state', this.state);
  }

  private loadOwnCourse() {
    const own = getLS<MapData | null>('map', null);
    if (!own || !this.builder.load(own, { origin: 'own' })) this.builder.load(starterMap(), { origin: 'own' });
  }

  /** start pad, spread out per seat in a squad so nobody spawns inside another drone */
  /** back to this pilot's start slot, e.g. when the squad seat is known */
  respawn() { const sp = this.spawnPoint(); this.setHome(sp.pos, sp.yaw); this.resetDrone(); }

  spawnPoint(): { pos: THREE.Vector3; yaw: number } {
    const start = this.builder.startPad() ?? { pos: this.world.pads[1].clone(), yaw: 0 };
    if (!this.mp) return start;
    const slot = this.mp.seat();
    const spacing = this.mp.gridSpacing();
    const side = new THREE.Vector3(Math.cos(start.yaw), 0, -Math.sin(start.yaw));
    const back = new THREE.Vector3(Math.sin(start.yaw), 0, Math.cos(start.yaw));
    const pos = start.pos.clone().addScaledVector(side, ((slot % 4) - 1.5) * spacing).addScaledVector(back, Math.floor(slot / 4) * spacing);
    pos.y = heightAt(pos.x, pos.z) + 0.1;
    return { pos, yaw: start.yaw };
  }

  resetRace() {
    const cps = this.builder.checkpoints();
    this.raceTracker = this.builder.map.race && cps.length >= 2 ? new RingTracker(cps) : null;
    this.raceRunning = false; this.raceTime = 0; this.raceIdx = 0; this.raceCount = cps.length;
    this.raceBest = goodLap(getLS<Record<string, unknown>>('raceBest', {})[this.builder.signature()]);
    if (this.state === 'fly') this.setMarker(this.raceTracker ? cps[0].pos : null, this.raceTracker ? 'Gate 1' : '');
  }

  async startMission(m: Mission) {
    if (this.state === 'mission' && this.mission === m) return;
    this.endMission();
    this.mission = m;
    this.paused = false;
    this.state = 'mission';
    // missions fly in a clean world: park the course and bring it back afterwards
    if (this.builder.map.pieces.length) {
      this.flushAutosave();
      this.courseBeforeMission = { map: { ...this.builder.map, pieces: this.builder.map.pieces.slice() }, origin: this.builder.origin };
    }
    this.builder.clear();
    this.world.setThermal(false);
    // every mission is scored on its own drone
    const spec = FEATURED.find(f => f.id === m.drone) ?? featured('dscan');
    await this.setDrone(spec, m.spawn(this.world));
    if (this.mission !== m) return;
    if (m.wind) this.world.setWind(m.wind.speed, m.wind.dir, m.wind.gust);
    else this.world.setWind(1.5, 70, 0.2);
    this.camMode = m.forceCam ?? (this.spec.model === 'racer' ? 'fpv' : 'chase');
    this.missionTime = 0; this.missionStarted = false;
    this.mctx = {
      world: this.world, sim: this.sim, time: 0, spraying: false, cleaned: 0, tagPressed: false,
      aimRay: { o: new THREE.Vector3(), d: new THREE.Vector3() },
      marker: (p, label) => this.setMarker(p, label),
      toast: (t) => this.toast(t),
      chime: (i) => audio.chime(i),
    };
    m.start(this.mctx);
    this.emit('state', this.state);
  }

  restartMission() {
    if (!this.mission) return;
    const id = this.mission.id;
    this.endMission();
    this.missions = allMissions();
    const m = this.missions.find(x => x.id === id)!;
    this.startMission(m);
  }

  private endMission() {
    if (this.mission) {
      try { this.mission.cleanup?.(this.world); } catch (e) { console.error(e); }
      if (this.sim) this.sim.impactListeners = [];
      this.world.solar.soil(1, 3);
      this.world.facade.resetGrime();
      this.world.solar.hotspots.forEach(h => (h.found = false));
      this.world.rings.forEach(r => ((r.mesh.material as THREE.MeshStandardMaterial).emissiveIntensity = 2.2));
      this.world.setThermal(false);
      this.world.setWind(this.settings.windSpeed, this.settings.windDir, this.settings.gust);
    }
    this.mission = null; this.mctx = null; this.setMarker(null);
    if (this.courseBeforeMission) {
      this.builder.load(this.courseBeforeMission.map, { origin: this.courseBeforeMission.origin });
      this.courseBeforeMission = null;
    }
  }

  async enterBuild() {
    this.endMission();
    this.paused = false;
    this.state = 'build';
    // your own island: shared courses are for flying, building always happens on your own course
    if (!this.builder.loaded || (!this.mp && this.builder.origin !== 'own')) this.loadOwnCourse();
    if (!this.visualLoaded) await this.setDrone(this.spec);
    this.builder.active = true;
    this.builder.setGhost(this.builder.selected);
    this.camMode = 'free';
    const fp = this.builder.startPad()?.pos ?? new THREE.Vector3(-150, 0, 60);
    this.camPos.set(fp.x, heightAt(fp.x, fp.z + 30) + 14, fp.z + 30);
    this.freeYaw = 0; this.freePitch = -0.35;
    this.emit('state', this.state);
  }

  /** your own course is saved automatically a moment after every edit */
  private scheduleAutosave() {
    if (this.builder.origin !== 'own' || this.mp || this.mission) return;
    clearTimeout(this.autosaveTimer);
    this.autosaveTimer = window.setTimeout(() => this.saveMap(true), 600);
  }
  private flushAutosave() {
    if (!this.autosaveTimer) return;
    clearTimeout(this.autosaveTimer); this.autosaveTimer = 0;
    this.saveMap(true);
  }

  saveMap(silent = false) {
    if (this.builder.origin !== 'own' || this.mp) return;
    setLS('map', this.builder.map);
    if (!silent) this.toast('Course saved on this device');
  }

  setMarker(p: THREE.Vector3 | null, label = '') {
    this.markerPos = p ? p.clone() : null; this.markerLabel = label;
    this.markerObj.visible = !!p;
    if (p) this.markerObj.position.copy(p);
  }

  // ------------------------------------------------------------------ loop
  start() {
    const frame = () => {
      requestAnimationFrame(frame);
      const now = performance.now();
      // real time down to 10 fps; below that the sim slows rather than tunnelling
      let dt = Math.min(0.1, (now - this.last) / 1000);
      this.last = now;
      if (document.hidden || this.contextLost) dt = 0;
      try { this.tick(dt); } catch (e) { console.error(e); this.input.endFrame(); }
    };
    requestAnimationFrame(frame);
  }

  private tick(dt: number) {
    const inp = this.input;
    inp.update(dt);
    if (inp.device !== this.lastDevice) { this.lastDevice = inp.device; this.sim?.requireLowThrottle(); }
    const flying = this.state === 'fly' || this.state === 'mission';
    if (flying && !this.paused) this.handleFlightKeys();
    if (this.state === 'build' && !this.paused) this.handleBuild(dt);
    if (inp.hit('Escape') || inp.padHit(9)) {
      if (flying || this.state === 'build') { this.paused = !this.paused; this.emit('pause', this.paused); }
    }

    if (this.sim && this.visualLoaded) {
      const physicsOn = flying && !this.paused;
      if (physicsOn) {
        this.sim.wind.copy(this.world.wind);
        const h = 1 / 400;
        this.acc += dt;
        let steps = 0;
        while (this.acc >= h && steps < 48) {
          if (this.hose) this.sim.extraForce.copy(this.hose.force); else this.sim.extraForce.set(0, 0, 0);
          this.sim.step(h, this.raceLocked ? { throttle: 0, yaw: 0, pitch: 0, roll: 0 } : inp.sticks);
          this.acc -= h; steps++;
        }
        if (steps >= 48) this.acc = 0;
        if (!this.sim.onGround && this.sim.armed) this.flightTime += dt;
        if (this.hose) this.hose.update(dt, this.attachPoint());
        this.updateTools(dt);
        this.updateBattery();
        this.updateRace(dt);
        this.updateMission(dt);
        if (this.sim.crashed && !this.visual.root.userData.crashFx) { this.visual.root.userData.crashFx = true; this.crashFx(); }
        if (!this.sim.crashed) this.visual.root.userData.crashFx = false;
      } else if (this.state === 'menu' || this.state === 'boot') {
        // idle display: motors ticking over on the pad
        for (const m of this.sim.motors) m.s = 0.12;
      }
      this.visual.root.position.copy(this.sim.pos);
      this.visual.root.quaternion.copy(this.sim.quat);
      animateProps(this.visual, this.sim.motors.map(m => m.s), dt, Math.min(30000, 2400 / this.spec.propDiameter * 1.6));
      if (this.visual.lance) this.visual.lance.rotation.x = THREE.MathUtils.degToRad(this.gimbalPitch);
      if (this.visual.gimbal) {
        // gimbal stays level with the horizon, only follows heading and pitch command
        const e = new THREE.Euler().setFromQuaternion(this.sim.quat, 'YXZ');
        const inv = this.sim.quat.clone().invert();
        const want = new THREE.Quaternion().setFromEuler(new THREE.Euler(THREE.MathUtils.degToRad(this.gimbalPitch), e.y, 0, 'YXZ'));
        this.visual.gimbal.quaternion.copy(inv.multiply(want));
      }
      const blink = (performance.now() % 1200) < 90;
      for (const l of this.visual.leds) l.visible = this.sim.armed ? true : blink;
      this.updateDebris(dt);
    }

    this.mp?.update(dt);
    this.updateCamera(dt);
    const focus = this.sim ? this.sim.pos : new THREE.Vector3();
    const avgS = this.sim ? this.sim.motors.reduce((a, m) => a + m.s, 0) / this.sim.motors.length : 0;
    this.world.update(dt, this.state === 'build' ? this.camPos : focus, this.camera,
      this.sim ? { pos: this.sim.pos, strength: avgS * avgS * Math.max(0, 1 - this.sim.agl / (this.spec.propDiameter * 10 + 2)), radius: this.spec.propDiameter * 3 + 1.5 } : undefined);
    this.particles.update(dt, this.world.wind, innerHeight / (2 * Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2))));
    if (this.markerObj.visible) { this.markerObj.rotation.y += dt; this.markerObj.children[1].position.y = Math.sin(performance.now() / 400) * 0.3 + 2.5; }

    // sound
    if (this.sim && (this.state === 'fly' || this.state === 'mission') && !this.paused) {
      const load = this.sim.motors.reduce((a, m) => a + m.thrust, 0) / (this.sim.motors.length * this.spec.maxThrust);
      const blades = this.spec.model === 'racer' ? 3 : 2;
      audio.update(avgS, load, this.spec.propDiameter, blades, this.camMode === 'fpv' ? this.sim.speed() : 0, this.spraying, this.camera.position.distanceTo(this.sim.pos));
    } else audio.silence();

    this.thermalPass.uniforms.uOn.value = this.world.thermal ? 1 : 0;
    this.thermalPass.uniforms.uTime.value = performance.now() / 1000 % 10;
    this.bloom.enabled = !this.world.thermal;
    if (!this.contextLost) this.composer.render(dt);
    try { this.emit('frame', dt); } finally { inp.endFrame(); }
  }

  private handleFlightKeys() {
    const inp = this.input;
    if (inp.hit('KeyR') || inp.padHit(8)) {
      if (this.state === 'mission' && this.mission) this.restartMission();
      else if (this.mp && this.mp.raceState !== 'idle') this.resetDrone(); // respawn, race clock keeps running
      else { this.resetDrone(); this.resetRace(); }
    }
    if (inp.hit('KeyC') || inp.padHit(5)) {
      const order: CamMode[] = ['chase', 'fpv', 'los'];
      if (this.mission?.forceCam === 'los') this.toast('This mission is line of sight only');
      else { this.camMode = order[(order.indexOf(this.camMode) + 1) % order.length]; this.toast(camName(this.camMode)); }
    }
    if (inp.hit('KeyM') || inp.padHit(4)) {
      const modes: FlightMode[] = ['gps', 'angle', 'acro'];
      this.setMode(modes[(modes.indexOf(this.sim.mode) + 1) % 3]);
    }
    if (inp.hit('KeyH') || inp.padHit(3)) {
      if (this.spec.tool === 'thermal' || this.spec.model === 'dscan') this.world.setThermal(!this.world.thermal, [this.visual.root]);
      else this.toast('Only DScan carries a thermal camera');
    }
    const up = inp.keys.has('KeyE') || (inp.activePad()?.buttons[12]?.pressed ?? false);
    const dn = inp.keys.has('KeyQ') || (inp.activePad()?.buttons[13]?.pressed ?? false);
    if (up) this.gimbalPitch = Math.min(this.spec.tool === 'lance' ? 35 : 20, this.gimbalPitch + 1.2);
    if (dn) this.gimbalPitch = Math.max(-90, this.gimbalPitch - 1.2);
    const pad = inp.activePad();
    const wants = inp.keys.has('Space') || (pad?.buttons[0]?.pressed ?? false) || (inp.device === 'rc' && (pad?.axes[5] ?? -1) > 0.3) || inp.touchSpray;
    // only a drone with a working sprayer sprays: no tank, no hiss
    const canSpray = this.spec.tool === 'lance' || (this.spec.tool === 'sprayDown' && (this.tank ?? 0) > 0);
    if (inp.touchSpray && (this.sim.crashed || !canSpray)) {
      inp.touchSpray = false;
      if (this.spec.tool === 'sprayDown' && !this.sim.crashed) this.toast('Tank empty. Land on the start pad to refill');
    }
    this.spraying = wants && canSpray && this.sim.armed && !this.sim.crashed;
    this.tagPressed = inp.hit('KeyF') || inp.padHit(2) || inp.touchTag;
    inp.touchTag = false;
  }

  // ------------------------------------------------------------------ tools: spray, lance, thermal tag
  private updateTools(dt: number) {
    const s = this.sim, spec = this.spec;
    if (spec.tool === 'sprayDown' && this.state === 'fly') {
      // refill on any base pad or the course start pad
      const pads = [...this.world.pads];
      const sp = this.builder.startPad(); if (sp) pads.push(sp.pos);
      if (s.onGround && pads.some(p => Math.hypot(p.x - s.pos.x, p.z - s.pos.z) < 4) && (this.tank ?? 0) < (spec.tank ?? 0)) {
        this.tank = Math.min(spec.tank ?? 0, (this.tank ?? 0) + dt * 10); s.payload = this.tank;
      }
    }
    if (!this.spraying) return;
    if (spec.tool === 'sprayDown') { this.tank = Math.max(0, (this.tank ?? 0) - (spec.flow ?? 4) / 60 * dt); s.payload = this.tank; }
    const m = new THREE.Matrix4().makeRotationFromQuaternion(s.quat);
    for (const nz of this.visual.nozzles) {
      let dirLocal = nz.dir.clone();
      let posLocal = nz.pos.clone();
      if (spec.tool === 'lance') {
        const rx = THREE.MathUtils.degToRad(this.gimbalPitch);
        const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), rx);
        const pivot = new THREE.Vector3(0, -0.2, -0.12);
        posLocal = posLocal.sub(pivot).applyQuaternion(q).add(pivot);
        dirLocal = dirLocal.applyQuaternion(q);
      }
      const o = posLocal.applyMatrix4(m).add(s.pos);
      const d = dirLocal.applyMatrix4(m).normalize();
      // particles
      const n = spec.tool === 'lance' ? 10 : 7;
      for (let i = 0; i < n; i++) {
        const spread = spec.tool === 'lance' ? 0.06 : 0.35;
        const v = d.clone().add(new THREE.Vector3((Math.random() - 0.5) * spread, (Math.random() - 0.5) * spread, (Math.random() - 0.5) * spread)).normalize()
          .multiplyScalar(spec.tool === 'lance' ? 24 + Math.random() * 6 : 5 + Math.random() * 3).add(s.vel);
        const mist = Math.random() < 0.35;
        this.particles.emit(o, v, mist ? 1.6 : 0.9, mist ? 0.12 : 0.035, 0.85, 0.93, 1, mist ? 0.18 : 0.6);
      }
      // cleaning with a few rays across the spray cone
      for (let k = 0; k < 3; k++) {
        const jitter = spec.tool === 'lance' ? 0.04 : 0.22;
        const rd = d.clone().add(new THREE.Vector3((Math.random() - 0.5) * jitter, 0, (Math.random() - 0.5) * jitter)).normalize();
        if (spec.tool === 'sprayDown') {
          const hit = this.world.solar.raycast(o, rd, 7);
          if (hit) {
            const dist = hit.t;
            const eff = dist < 0.6 ? 0.3 : dist < 1.2 ? 0.8 : dist < 3.5 ? 1 : Math.max(0, 1 - (dist - 3.5) / 3.5);
            this.world.solar.cleanAt(hit.p, 0.5 + dist * 0.12, eff * dt * 1.6);
          }
        } else {
          const hf = this.world.facade.hit(o, rd, 5);
          if (hf) {
            const dist = hf.t;
            const eff = dist < 0.4 ? 0.5 : dist < 2.2 ? 1 : Math.max(0, 1 - (dist - 2.2) / 2.8);
            this.world.facade.cleanAt(hf.p, 0.55 + dist * 0.18, eff * dt * 5);
          }
          const hs = this.world.solar.raycast(o, rd, 5);
          if (hs) this.world.solar.cleanAt(hs.p, 0.35, dt * 2.5);
        }
      }
    }
  }

  /** spoken warnings before the pack runs out, like a real ground station */
  private updateBattery() {
    const soc = this.sim.soc;
    if (!this.sim.armed) return;
    if (soc < 0.2 && this.batteryWarned > 0.2) { this.batteryWarned = 0.2; audio.warn(); this.toast('Battery 20 %. Time to head home.'); }
    if (soc < 0.1 && this.batteryWarned > 0.1) { this.batteryWarned = 0.1; audio.warn(); this.toast('Battery critical. Land now.'); }
    if (this.sim.autoLanding && soc >= 0.05 && this.batteryWarned > 0.06) {
      this.batteryWarned = 0.06; audio.warn();
      this.toast('The pack can no longer carry this weight. Landing now.');
    }
    if (soc < 0.05 && this.batteryWarned > 0.05) {
      this.batteryWarned = 0.05; audio.warn();
      this.toast(this.sim.mode === 'gps' ? 'Battery empty. Landing automatically.' : 'Battery empty. Motors are fading.');
    }
  }

  private updateRace(dt: number) {
    if (this.state !== 'fly' || !this.raceTracker) return;
    const mp = this.mp;
    const multi = !!mp && mp.raceState !== 'idle';
    if (multi) {
      // one shared clock from GO, so crashes and resets cost real time
      if (mp!.raceState === 'running' && mp!.selfFinish == null && mp!.inRace()) { this.raceRunning = true; this.raceTime = mp!.raceElapsed(); }
      else this.raceRunning = false;
    } else {
      if (!this.raceRunning && !this.sim.onGround && this.sim.agl > 0.5) { this.raceRunning = true; this.raceTime = 0; }
      if (this.raceRunning) this.raceTime += dt;
    }
    if (multi && (mp!.raceState !== 'running' || mp!.selfFinish != null || !mp!.inRace())) return;
    if (this.raceTracker.update(this.sim.pos)) {
      audio.chime(this.raceTracker.idx);
      this.raceIdx = this.raceTracker.idx;
      const cps = this.raceTracker.rings;
      if (!this.raceTracker.done) this.setMarker(cps[this.raceTracker.idx].pos, `Gate ${this.raceTracker.idx + 1}`);
      if (this.raceTracker.done && multi) {
        mp!.localFinish(this.raceTime);
        this.raceRunning = false;
        this.setMarker(null);
        this.toast(`Finished in ${this.raceTime.toFixed(2)} s`);
        audio.success();
        return;
      }
      if (this.raceTracker.done) {
        const t = this.raceTime;
        const key = this.builder.signature();
        const bests = getLS<Record<string, number>>('raceBest', {});
        const prev = goodLap(bests[key]);
        if (!prev || t < prev) { bests[key] = t; setLS('raceBest', bests); this.raceBest = t; this.toast(`New best lap ${t.toFixed(2)} s`); audio.success(); }
        else this.toast(`Lap ${t.toFixed(2)} s. Best ${prev.toFixed(2)} s`);
        this.raceTracker = new RingTracker(this.builder.checkpoints());
        this.raceRunning = true; this.raceTime = 0; this.raceIdx = 0;
        this.setMarker(cps[0].pos, 'Gate 1');
      }
    }
  }

  private updateMission(dt: number) {
    if (this.state !== 'mission' || !this.mission || !this.mctx) return;
    // the clock starts when the motors arm, not when the drone settles on its gear
    if (!this.missionStarted && this.sim.armed) this.missionStarted = true;
    if (this.missionStarted) this.missionTime += dt;
    const c = this.mctx;
    c.time = this.missionTime; c.spraying = this.spraying; c.tagPressed = this.tagPressed;
    c.aimRay.o.copy(this.camera.position);
    c.aimRay.d.set(0, 0, -1).applyQuaternion(this.camera.quaternion);
    const st = this.mission.update(c, dt);
    if (st !== 'running') {
      const res = st === 'success' ? this.mission.result(c) : { stars: 0, score: 'Failed', detail: this.mission.failReason || this.sim.crashReason || 'Mission failed', time: this.missionTime };
      if (st === 'success') {
        const p = progress();
        p.stars[this.mission.id] = Math.max(p.stars[this.mission.id] ?? 0, res.stars);
        if (this.mission.scored !== 'percent') {
          const prevBest = p.best[this.mission.id];
          if (res.time > 0 && (!prevBest || res.time < prevBest)) p.best[this.mission.id] = res.time;
          res.best = p.best[this.mission.id];
        }
        saveProgress(p);
        audio.success();
      } else if (!this.sim.crashed) audio.warn();
      this.result = res;
      this.state = 'result';
      setTimeout(() => this.emit('state', 'result'), st === 'fail' && this.sim.crashed ? 1200 : 400);
    }
  }

  private crashFx() {
    audio.crash();
    if (!this.settings.crashes) { this.emit('crash', this.sim.crashReason); return; }
    // a few parts break away
    const parts = this.visual.props.slice(0, 2);
    for (const p of parts) {
      const m = (p.blades as THREE.Mesh).clone();
      m.position.copy(p.pivot.getWorldPosition(new THREE.Vector3()));
      this.world.scene.add(m);
      p.blades.visible = false;
      this.debris.push({ m, v: new THREE.Vector3((Math.random() - 0.5) * 6, 3 + Math.random() * 3, (Math.random() - 0.5) * 6).add(this.sim.vel.clone().multiplyScalar(0.5)), w: new THREE.Vector3(Math.random() * 20, Math.random() * 20, Math.random() * 20) });
    }
    for (let i = 0; i < 40; i++) this.particles.emit(this.sim.pos, new THREE.Vector3((Math.random() - 0.5) * 6, Math.random() * 4, (Math.random() - 0.5) * 6), 1.5, 0.25, 0.45, 0.4, 0.33, 0.5);
    this.emit('crash', this.sim.crashReason);
  }

  private updateDebris(dt: number) {
    for (const d of this.debris) {
      d.v.y -= 9.81 * dt;
      d.m.position.addScaledVector(d.v, dt);
      d.m.rotation.x += d.w.x * dt; d.m.rotation.y += d.w.y * dt;
      const h = heightAt(d.m.position.x, d.m.position.z);
      if (d.m.position.y < h + 0.02) { d.m.position.y = h + 0.02; d.v.multiplyScalar(0.3); d.v.y = Math.abs(d.v.y) * 0.3; d.w.multiplyScalar(0.5); }
    }
  }

  // ------------------------------------------------------------------ build mode
  private handleBuild(dt: number) {
    const inp = this.input, b = this.builder;
    const k = inp.keys;
    // look: hold the right mouse button, or the right on screen stick
    const locked = document.pointerLockElement != null;
    if (locked || inp.mouseButtons.has(2)) {
      this.freeYaw -= inp.mouseDX * 0.0025;
      this.freePitch = THREE.MathUtils.clamp(this.freePitch - inp.mouseDY * 0.0025 * (this.settings.invertLook ? -1 : 1), -1.5, 1.5);
    }
    const pad = inp.device === 'gamepad' ? inp.activePad() : null;
    const dz = (v: number | undefined) => (v != null && Math.abs(v) > 0.15 ? v : 0);
    if (pad) {
      this.freeYaw -= dz(inp.axis(2)) * dt * 2;
      this.freePitch = THREE.MathUtils.clamp(this.freePitch - dz(inp.axis(3)) * dt * 2, -1.5, 1.5);
    }
    const T = inp.touch;
    if (inp.device === 'touch' && T.right.active) {
      this.freeYaw -= T.right.x * dt * 1.8;
      this.freePitch = THREE.MathUtils.clamp(this.freePitch + T.right.y * dt * 1.4, -1.5, 1.5);
    }
    const fwd = new THREE.Vector3(-Math.sin(this.freeYaw), 0, -Math.cos(this.freeYaw));
    const right = new THREE.Vector3(-fwd.z, 0, fwd.x);
    const fast = k.has('ShiftLeft') || k.has('ShiftRight');
    const sp = (fast ? 40 : 14) * dt;
    const mv = new THREE.Vector3();
    if (k.has('KeyW')) mv.add(fwd); if (k.has('KeyS')) mv.sub(fwd);
    if (k.has('KeyD')) mv.add(right); if (k.has('KeyA')) mv.sub(right);
    if (k.has('KeyE') || k.has('Space')) mv.y += 1; if (k.has('KeyQ')) mv.y -= 1;
    if (pad) { mv.addScaledVector(fwd, -dz(inp.axis(1))); mv.addScaledVector(right, dz(inp.axis(0))); }
    if (inp.device === 'touch' && T.left.active) { mv.addScaledVector(fwd, T.left.y); mv.addScaledVector(right, T.left.x); }
    if (inp.touchBuildLift) mv.y += inp.touchBuildLift;
    this.camPos.addScaledVector(mv, sp);
    this.camPos.y = Math.min(400, Math.max(heightAt(this.camPos.x, this.camPos.z) + 1, this.camPos.y));
    this.camPos.x = THREE.MathUtils.clamp(this.camPos.x, -760, 760); this.camPos.z = THREE.MathUtils.clamp(this.camPos.z, -760, 760);
    // piece selection, letters and digits including the number pad
    for (const p of PIECES) {
      const isDigit = /[0-9]/.test(p.key);
      if (inp.hit(isDigit ? 'Digit' + p.key : 'Key' + p.key) || (isDigit && inp.hit('Numpad' + p.key))) {
        b.setGhost(p.t); this.emit('build-select', p.t);
      }
    }
    if (inp.hit('KeyR')) { b.yaw = (b.yaw + (k.has('ShiftLeft') || k.has('ShiftRight') ? 345 : 15)) % 360; this.emit('build-select', b.selected); }
    if (inp.wheel) {
      const alt = k.has('AltLeft') || k.has('AltRight');
      if (alt) b.scale = THREE.MathUtils.clamp(b.scale - inp.wheel * 0.1, 0.4, 4);
      else b.lift = THREE.MathUtils.clamp(b.lift - inp.wheel * 0.5, 0, 80);
      this.emit('build-select', b.selected);
    }
    if (inp.undoPressed) { inp.undoPressed = false; b.undoLast(); audio.tick(); }
    const camYawDeg = Math.round(THREE.MathUtils.radToDeg(this.freeYaw) / 15) * 15;
    b.ghostExtraYaw = b.selected === 'flag' ? camYawDeg : 0;
    const aim = b.aim(this.camera);
    const clickPlace = inp.uiClick === 0 || inp.padHit(0);
    const clickDel = inp.uiClick === 1 || inp.hit('KeyX') || inp.hit('Delete') || inp.padHit(1);
    inp.uiClick = -1;
    if (clickPlace) {
      // the start flag faces the way you are looking
      const r = b.selected === 'flag' ? camYawDeg + b.yaw : b.yaw;
      if (b.place({ t: b.selected, x: aim.pos.x, y: aim.pos.y, z: aim.pos.z, r, s: b.scale })) audio.tick();
      else this.toast(b.map.pieces.length >= 2000 ? 'This course is full: 2000 pieces is the limit' : 'That spot is outside the world');
    }
    if (clickDel && aim.hitId) { b.removeId(aim.hitId); audio.tick(); }
    if (inp.hit('KeyF') || inp.padHit(3)) { this.flushAutosave(); this.startFreeFlight(); }
  }

  // ------------------------------------------------------------------ camera
  private updateCamera(dt: number) {
    const cam = this.camera;
    const s = this.sim;
    let fov = this.settings.fov;
    if (this.state === 'build' || this.camMode === 'free') {
      cam.position.copy(this.camPos);
      cam.quaternion.setFromEuler(new THREE.Euler(this.freePitch, this.freeYaw, 0, 'YXZ'));
    } else if (!s) {
      return;
    } else if (this.camMode === 'orbit') {
      this.orbitT += dt * 0.12;
      const L = Math.max(0.5, this.spec.armLength * 2 + this.spec.propDiameter);
      const r = L * 2.6 + 1.2;
      const target = s.pos.clone().add(new THREE.Vector3(0, L * 0.15, 0));
      // composition: drone sits right of centre, menu lives on the left
      const a = this.orbitT;
      cam.position.set(target.x + Math.sin(a) * r, target.y + L * 0.55 + 0.3, target.z + Math.cos(a) * r);
      cam.lookAt(target);
      const offset = new THREE.Vector3(-1, 0, 0).applyQuaternion(cam.quaternion).multiplyScalar(r * 0.32 * Math.min(1, innerWidth / 900));
      cam.position.add(offset);
      fov = 40;
    } else if (this.camMode === 'fpv') {
      const v = this.visual;
      if (s.mode === 'acro' || this.spec.model === 'racer') {
        const up = THREE.MathUtils.degToRad(this.settings.camUptilt ?? this.spec.camUptilt);
        cam.position.copy(v.fpvCam).applyQuaternion(s.quat).add(s.pos);
        cam.quaternion.copy(s.quat).multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), up));
        fov = this.settings.fpvFov;
      } else {
        // stabilised gimbal camera, follows heading, pitch from Q and E
        const e = new THREE.Euler().setFromQuaternion(s.quat, 'YXZ');
        cam.position.copy(v.fpvCam).applyQuaternion(s.quat).add(s.pos);
        cam.quaternion.setFromEuler(new THREE.Euler(THREE.MathUtils.degToRad(this.gimbalPitch), e.y, 0, 'YXZ'));
        fov = Math.min(this.settings.fpvFov, 82);
      }
      // camera shake from vibration and impacts
      if (s.armed) {
        const sh = 0.0015 * (s.motors[0]?.s ?? 0);
        cam.rotateX((Math.random() - 0.5) * sh); cam.rotateY((Math.random() - 0.5) * sh);
      }
    } else if (this.camMode === 'los') {
      cam.position.lerp(this.losPilot, 1 - Math.exp(-dt * 4));
      this.camLook.lerp(s.pos, 1 - Math.exp(-dt * 10));
      cam.lookAt(this.camLook);
      const d = cam.position.distanceTo(s.pos);
      fov = THREE.MathUtils.clamp(70 - d * 0.35, 18, 70);
    } else {
      const L = this.spec.armLength * 2 + this.spec.propDiameter;
      const dist = Math.max(2.4, L * (L > 2 ? 2.3 : 3.2));
      const yaw = s.heading();
      const behind = new THREE.Vector3(Math.sin(yaw), 0, Math.cos(yaw));
      const want = s.pos.clone().addScaledVector(behind, dist).add(new THREE.Vector3(0, dist * 0.38 + 0.3, 0));
      // keep camera out of the ground and buildings
      const gh = heightAt(want.x, want.z) + 0.6;
      if (want.y < gh) want.y = gh;
      const dir = want.clone().sub(s.pos); const len = dir.length(); dir.normalize();
      const hit = this.world.colliders.raycast(s.pos.clone().addScaledVector(dir, L * 0.6), dir, len, c => c.tag !== 'tree' && c.tag !== 'player');
      if (isFinite(hit.t) && hit.t < len) want.copy(s.pos).addScaledVector(dir, Math.max(L * 0.6, hit.t + L * 0.6 - 0.3));
      const k = 1 - Math.exp(-dt * 5);
      this.camPos.lerp(want, k);
      cam.position.copy(this.camPos);
      this.camLook.lerp(s.pos.clone().add(new THREE.Vector3(0, L * 0.15, 0)), 1 - Math.exp(-dt * 14));
      cam.lookAt(this.camLook);
    }
    if (Math.abs(cam.fov - fov) > 0.01) { cam.fov += (fov - cam.fov) * Math.min(1, dt * 6); cam.updateProjectionMatrix(); }
    cam.near = this.spec.model === 'racer' || this.camMode === 'fpv' ? 0.02 : 0.08;
  }

  // ------------------------------------------------------------------ hud data
  telemetry(): Telemetry {
    const s = this.sim;
    const e = s.euler();
    let hud = '';
    if (this.state === 'mission' && this.mission?.hud && this.mctx) hud = this.mission.hud(this.mctx);
    if (this.state === 'fly' && this.raceTracker) hud = `Lap ${this.raceTime.toFixed(2)} s   Gate ${Math.min(this.raceCount, this.raceIdx + 1)} / ${this.raceCount}${this.raceBest ? `   Best ${this.raceBest.toFixed(2)} s` : ''}`;
    const w = this.world.wind;
    return {
      alt: s.pos.y, agl: Math.max(0, s.agl), speed: s.speed(), vz: s.vel.y, heading: ((-THREE.MathUtils.radToDeg(s.heading()) % 360) + 360) % 360,
      soc: s.soc, volt: s.voltage, amps: s.current, watts: s.powerW,
      mode: s.mode, armed: s.armed, crashed: s.crashed, crashReason: s.crashReason, sticks: this.input.sticks,
      // where the wind comes from, as a compass bearing
      wind: Math.hypot(w.x, w.z), windDir: (THREE.MathUtils.radToDeg(Math.atan2(-w.x, w.z)) + 360) % 360,
      dist: Math.hypot(s.pos.x - this.home.x, s.pos.z - this.home.z), flightTime: this.state === 'mission' ? this.missionTime : this.flightTime,
      tank: this.tank, thermal: this.world.thermal, cam: this.camMode, spraying: this.spraying, gimbal: this.gimbalPitch,
      missionHud: hud, tilt: THREE.MathUtils.radToDeg(Math.hypot(e.x, e.z)), device: this.input.device,
    };
  }

  /** world to screen for HUD labels */
  project(p: THREE.Vector3): { x: number; y: number; behind: boolean } {
    const v = p.clone().project(this.camera);
    return { x: (v.x * 0.5 + 0.5) * innerWidth, y: (-v.y * 0.5 + 0.5) * innerHeight, behind: v.z > 1 };
  }
}

function camName(c: CamMode) { return c === 'chase' ? 'Chase camera' : c === 'fpv' ? 'FPV camera' : c === 'los' ? 'Line of sight from the pilot spot' : c; }

function makeMarker() {
  const g = new THREE.Group();
  const beam = new THREE.Mesh(new THREE.CylinderGeometry(0.25, 0.25, 300, 12, 1, true), new THREE.MeshBasicMaterial({ color: '#b5f78a', transparent: true, opacity: 0.12, depthWrite: false, side: THREE.DoubleSide }));
  beam.position.y = 150;
  g.add(beam);
  const gem = new THREE.Mesh(new THREE.OctahedronGeometry(0.7), new THREE.MeshBasicMaterial({ color: '#b5f78a', transparent: true, opacity: 0.85 }));
  gem.position.y = 2.5;
  g.add(gem);
  g.userData.noThermal = true;
  g.traverse(o => (o.userData.noThermal = true));
  return g;
}

function progressBump(k: 'flights') { const p = progress(); p[k]++; saveProgress(p); }
