import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { World, TimeOfDay } from '../world/world';
import { DroneSim, Sticks } from '../sim/drone';
import { DroneSpec, FEATURED, FlightMode, featured } from '../sim/spec';
import { buildDroneVisual, animateProps, DroneVisual } from '../render/droneModels';
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

export interface Telemetry {
  alt: number; agl: number; speed: number; vz: number; heading: number; soc: number; volt: number; amps: number; watts: number;
  mode: FlightMode; armed: boolean; crashed: boolean; crashReason: string; sticks: Sticks; wind: number; windDir: number;
  dist: number; flightTime: number; tank: number | null; thermal: boolean; cam: CamMode; spraying: boolean; gimbal: number;
  missionHud: string; tilt: number; device: string;
}

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
      gl_FragColor = c;
    }`,
};

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
  private thermalPass: ShaderPass;
  private camPos = new THREE.Vector3(10, 5, 14);
  private camLook = new THREE.Vector3();
  private orbitT = 0;
  private freeYaw = 0; private freePitch = -0.3;
  private markerObj: THREE.Group;
  markerPos: THREE.Vector3 | null = null;
  markerLabel = '';
  private ghost: { t: number; p: number[] }[] = [];
  private raceTracker: RingTracker | null = null;
  raceTime = 0; raceBest = 0; raceRunning = false; raceIdx = 0; raceCount = 0;
  private home = new THREE.Vector3();
  private homeYaw = 0;
  mp: Multiplayer | null = null;
  /** true during a multiplayer countdown: motors stay off */
  raceLocked = false;
  private tagPressed = false;
  private flightLog = { dist: 0 };
  listeners: { [k: string]: ((...a: unknown[]) => void)[] } = {};
  paused = false;
  visualLoaded = false;
  private debris: { m: THREE.Mesh; v: THREE.Vector3; w: THREE.Vector3 }[] = [];
  losPilot = new THREE.Vector3(0, 1.7, 14);

  constructor(canvas: HTMLCanvasElement) {
    this.settings = { ...DEFAULT_SETTINGS, ...getLS<Partial<Settings>>('settings', {}) };
    const r = this.renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance', stencil: false });
    r.setPixelRatio(Math.min(devicePixelRatio, this.settings.quality === 'high' ? 2 : 1.25));
    r.setSize(innerWidth, innerHeight);
    r.shadowMap.enabled = true;
    r.shadowMap.type = THREE.PCFSoftShadowMap;
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
    this.bloom = new UnrealBloomPass(new THREE.Vector2(innerWidth, innerHeight), 0.35, 0.45, 3.2);
    this.composer.addPass(this.bloom);
    this.thermalPass = new ShaderPass(thermalShader);
    this.composer.addPass(this.thermalPass);
    this.composer.addPass(new OutputPass());
    this.builder = new Builder(this.world);
    this.markerObj = makeMarker();
    this.markerObj.visible = false;
    this.world.scene.add(this.markerObj);
    addEventListener('resize', () => this.resize());
    audio.setVolume(this.settings.volume);
  }

  on(ev: string, fn: (...a: unknown[]) => void) { (this.listeners[ev] ??= []).push(fn); }
  emit(ev: string, ...a: unknown[]) { for (const f of this.listeners[ev] ?? []) f(...a); }
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
    this.renderer.setSize(innerWidth, innerHeight);
    this.composer.setSize(innerWidth, innerHeight);
    this.camera.aspect = innerWidth / innerHeight;
    this.camera.updateProjectionMatrix();
  }

  // ------------------------------------------------------------------ drone management
  async setDrone(spec: DroneSpec, spawn?: { pos: THREE.Vector3; yaw: number }) {
    if (this.visual) { this.world.scene.remove(this.visual.root); }
    if (this.hose) { this.world.scene.remove(this.hose.mesh); this.hose = null; }
    this.spec = spec;
    this.sim = new DroneSim(spec, this.world.colliders);
    this.sim.throttleCurveHover = this.settings.throttleHover;
    this.visual = await buildDroneVisual(spec);
    this.world.scene.add(this.visual.root);
    this.visualLoaded = true;
    this.input.throttleSprings = this.sim.mode === 'gps';
    if (spec.hose) {
      this.hose = new Hose(this.world.facade.pumpAnchor.clone(), 50);
      this.hose.maxForce = spec.mass * 9.81 * 1.5;
      this.world.scene.add(this.hose.mesh);
    }
    this.gimbalPitch = spec.tool === 'lance' ? -5 : spec.tool === 'thermal' ? -35 : -15;
    const sp = spawn ?? { pos: this.world.pads[1].clone(), yaw: 0 };
    this.home.copy(sp.pos); this.homeYaw = sp.yaw;
    this.world.clearSpot.set(sp.pos.x, Math.max(3, spec.armLength * 2 + spec.propDiameter + 1), sp.pos.z);
    this.resetDrone();
    setLS('lastDrone', spec.id);
    this.mp?.announce();
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
    this.tank = this.spec.tool === 'sprayDown' ? (this.spec.tank ?? 20) : null;
    this.sim.payload = this.tank ?? 0;
    this.input.setKeyboardThrottle(0);
    this.flightTime = 0;
    this.particles.clear();
    for (const d of this.debris) this.world.scene.remove(d.m);
    this.debris = [];
    this.visual.root.visible = true;
    if (this.hose) {
      // the hose runs from the facade pump when DShine starts there, otherwise a mobile
      // pump stands next to the take off spot, like the trailer on a real job
      const fixed = this.world.facade.pumpAnchor;
      const nearFacade = Math.hypot(this.home.x - fixed.x, this.home.z - fixed.z) < this.hose.length * 0.8;
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
    if (this.spec.hose) {
      // DShine lives next to the pump
      this.losPilot.copy(this.world.facade.pumpAnchor).add(new THREE.Vector3(-6, -0.5, 4));
    } else this.losPilot.copy(this.home).add(new THREE.Vector3(0, 1.7, 14));
    this.losPilot.y = heightAt(this.losPilot.x, this.losPilot.z) + 1.7;
    this.camPos.copy(this.home).add(new THREE.Vector3(0, 3, 8));
  }

  private attachPoint() {
    return new THREE.Vector3(0, -0.25, 0.05).applyQuaternion(this.sim.quat).add(this.sim.pos);
  }

  setMode(m: FlightMode) {
    this.sim.mode = m;
    this.input.throttleSprings = m === 'gps';
    if (m !== 'gps' && this.input.device === 'keyboard') this.input.setKeyboardThrottle(this.sim.armed ? 0.45 : 0);
    this.toast(m === 'gps' ? 'GPS hold. Release the sticks and it stays put.' : m === 'angle' ? 'Angle mode. Self levelling, you hold altitude.' : 'Acro mode. No self levelling. This is real flying.');
  }

  // ------------------------------------------------------------------ states
  async enterMenu() {
    this.endMission();
    this.builder.active = false; this.builder.hideGhost();
    this.state = 'menu';
    this.camMode = 'orbit';
    this.world.setThermal(false);
    if (!this.visualLoaded) await this.setDrone(this.spec);
    else { this.home.copy(this.world.pads[1]); this.homeYaw = 0; this.resetDrone(); }
    audio.silence();
    document.exitPointerLock?.();
    this.emit('state', this.state);
  }

  async startFreeFlight(map?: MapData) {
    this.endMission();
    this.state = 'fly';
    this.builder.active = false; this.builder.hideGhost();
    if (map) this.builder.load(map);
    else if (!this.builder.map.pieces.length) this.builder.load(getLS<MapData>('map', starterMap()));
    const start = this.builder.startPad();
    const spawn = start ?? { pos: this.world.pads[1].clone(), yaw: 0 };
    await this.setDrone(this.spec, spawn);
    this.world.setWind(this.settings.windSpeed, this.settings.windDir, this.settings.gust);
    this.camMode = this.spec.model === 'racer' ? 'fpv' : 'chase';
    this.resetRace();
    progressBump('flights');
    this.emit('state', this.state);
  }

  resetRace() {
    const cps = this.builder.checkpoints();
    this.raceTracker = this.builder.map.race && cps.length >= 2 ? new RingTracker(cps) : null;
    this.raceRunning = false; this.raceTime = 0; this.raceIdx = 0; this.raceCount = cps.length;
    this.raceBest = getLS<Record<string, number>>('raceBest', {})[this.builder.map.name] ?? 0;
  }

  async startMission(m: Mission) {
    this.endMission();
    this.mission = m;
    this.state = 'mission';
    this.builder.clear();
    const spec = FEATURED.find(f => f.id === m.drone) ?? featured('dscan');
    const useSpec = m.lockDrone || !this.spec ? spec : this.spec.featured || this.spec.model === 'generic' ? (m.lockDrone ? spec : this.spec) : spec;
    await this.setDrone(m.lockDrone ? spec : useSpec, m.spawn(this.world));
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

  restartMission() { if (this.mission) { const id = this.mission.id; this.missions = allMissions(); const m = this.missions.find(x => x.id === id)!; this.startMission(m); } }

  private endMission() {
    if (this.mission && this.mctx) this.sim.impactListeners = [];
    this.mission = null; this.mctx = null; this.setMarker(null);
    if (this.world.solar) this.world.solar.soil(1, 3);
    this.world.rings.forEach(r => ((r.mesh.material as THREE.MeshStandardMaterial).emissiveIntensity = 2.2));
  }

  async enterBuild() {
    this.endMission();
    this.state = 'build';
    if (!this.builder.map.pieces.length) this.builder.load(getLS<MapData>('map', starterMap()));
    if (!this.visualLoaded) await this.setDrone(this.spec);
    this.builder.active = true;
    this.builder.setGhost(this.builder.selected);
    this.camMode = 'free';
    const fp = this.builder.startPad()?.pos ?? new THREE.Vector3(-150, 0, 60);
    this.camPos.set(fp.x, 14, fp.z + 30);
    this.freeYaw = 0; this.freePitch = -0.35;
    this.emit('state', this.state);
  }

  saveMap() { setLS('map', this.builder.map); this.toast('Map saved on this device'); }

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
      let dt = Math.min(0.05, (now - this.last) / 1000);
      this.last = now;
      if (document.hidden) dt = 0;
      this.tick(dt);
    };
    requestAnimationFrame(frame);
  }

  private tick(dt: number) {
    const inp = this.input;
    inp.update(dt);
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
        while (this.acc >= h && steps < 40) {
          if (this.hose) this.sim.extraForce.copy(this.hose.force); else this.sim.extraForce.set(0, 0, 0);
          this.sim.step(h, this.raceLocked ? { throttle: 0, yaw: 0, pitch: 0, roll: 0 } : inp.sticks);
          this.acc -= h; steps++;
        }
        if (!this.sim.onGround) this.flightTime += dt;
        if (this.hose) this.hose.update(dt, this.attachPoint());
        this.flightLog.dist += this.sim.speed() * dt;
        this.updateTools(dt);
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
    this.composer.render(dt);
    this.emit('frame', dt);
    inp.endFrame();
  }

  private handleFlightKeys() {
    const inp = this.input;
    if (inp.hit('KeyR') || inp.padHit(8)) {
      if (this.state === 'mission' && this.mission) this.restartMission(); else { this.resetDrone(); this.resetRace(); }
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
    this.spraying = (inp.keys.has('Space') || (pad?.buttons[0]?.pressed ?? false) || (inp.device === 'rc' && (pad?.axes[5] ?? -1) > 0.3) || inp.touchSpray) && !this.sim.crashed;
    this.tagPressed = inp.hit('KeyF') || inp.padHit(2) || inp.touchTag;
    inp.touchTag = false;
  }

  // ------------------------------------------------------------------ tools: spray, lance, thermal tag
  private updateTools(dt: number) {
    const s = this.sim, spec = this.spec;
    const canSpray = spec.tool === 'sprayDown' ? (this.tank ?? 0) > 0 : spec.tool === 'lance';
    if (spec.tool === 'sprayDown' && this.state === 'fly') {
      // refill on any base pad
      if (s.onGround && this.world.pads.some(p => p.distanceTo(s.pos) < 4) && (this.tank ?? 0) < (spec.tank ?? 0)) {
        this.tank = Math.min(spec.tank ?? 0, (this.tank ?? 0) + dt * 10); s.payload = this.tank;
      }
    }
    if (!this.spraying || !canSpray || !s.armed) return;
    if (spec.tool === 'sprayDown' && this.state === 'fly') { this.tank = Math.max(0, (this.tank ?? 0) - (spec.flow ?? 5) / 60 * dt); s.payload = this.tank; }
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

  private updateRace(dt: number) {
    if (this.state !== 'fly' || !this.raceTracker) return;
    if (this.mp && this.mp.raceState === 'running' && this.raceTracker.idx < this.raceTracker.rings.length) {
      // in a multiplayer race the clock starts at GO, not at take off
      if (!this.raceRunning) { this.raceRunning = true; this.raceTime = 0; }
    } else if (!this.mp || this.mp.raceState === 'idle') {
      if (!this.raceRunning && !this.sim.onGround && this.sim.agl > 0.5) { this.raceRunning = true; this.raceTime = 0; }
    }
    if (this.raceRunning) this.raceTime += dt;
    if (this.raceTracker.update(this.sim.pos)) {
      audio.chime(this.raceTracker.idx);
      this.raceIdx = this.raceTracker.idx;
      if (this.raceTracker.done && this.mp && this.mp.raceState !== 'idle') {
        this.mp.localFinish(this.raceTime);
        this.raceRunning = false;
        this.toast(`Finished in ${this.raceTime.toFixed(2)} s`);
        audio.success();
        return;
      }
      if (this.raceTracker.done) {
        const t = this.raceTime;
        const bests = getLS<Record<string, number>>('raceBest', {});
        const prev = bests[this.builder.map.name];
        if (!prev || t < prev) { bests[this.builder.map.name] = t; setLS('raceBest', bests); this.raceBest = t; this.toast(`New best lap ${t.toFixed(2)} s`); audio.success(); }
        else this.toast(`Lap ${t.toFixed(2)} s. Best ${prev.toFixed(2)} s`);
        this.raceTracker = new RingTracker(this.builder.checkpoints());
        this.raceRunning = true; this.raceTime = 0; this.raceIdx = 0;
      }
    }
  }

  private updateMission(dt: number) {
    if (this.state !== 'mission' || !this.mission || !this.mctx) return;
    if (!this.missionStarted && (this.sim.armed || !this.sim.onGround)) this.missionStarted = true;
    if (this.missionStarted) this.missionTime += dt;
    const c = this.mctx;
    c.time = this.missionTime; c.spraying = this.spraying; c.tagPressed = this.tagPressed;
    c.aimRay.o.copy(this.camera.position);
    c.aimRay.d.set(0, 0, -1).applyQuaternion(this.camera.quaternion);
    const st = this.mission.update(c, dt);
    if (st !== 'running') {
      const res = st === 'success' ? this.mission.result(c) : { stars: 0, score: 'Failed', detail: this.mission.failReason ?? '', time: this.missionTime };
      if (st === 'success') {
        const p = progress();
        p.stars[this.mission.id] = Math.max(p.stars[this.mission.id] ?? 0, res.stars);
        const prevBest = p.best[this.mission.id];
        if (!prevBest || res.time < prevBest) p.best[this.mission.id] = res.time;
        res.best = p.best[this.mission.id];
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
    if (!this.settings.crashes) return;
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
    // free camera: right mouse or pointer lock to look, WASD to move, Q/E down/up
    const locked = document.pointerLockElement != null;
    if (locked || inp.mouseButtons.has(2)) {
      this.freeYaw -= inp.mouseDX * 0.0025;
      this.freePitch = THREE.MathUtils.clamp(this.freePitch - inp.mouseDY * 0.0025 * (this.settings.invertLook ? -1 : 1), -1.5, 1.5);
    }
    const pad = inp.activePad();
    if (pad && inp.device !== 'keyboard') {
      this.freeYaw -= (Math.abs(pad.axes[2]) > 0.12 ? pad.axes[2] : 0) * dt * 2;
      this.freePitch = THREE.MathUtils.clamp(this.freePitch - (Math.abs(pad.axes[3]) > 0.12 ? pad.axes[3] : 0) * dt * 2, -1.5, 1.5);
    }
    const fwd = new THREE.Vector3(-Math.sin(this.freeYaw), 0, -Math.cos(this.freeYaw));
    const right = new THREE.Vector3(-fwd.z, 0, fwd.x);
    const sp = (inp.keys.has('ShiftLeft') ? 40 : 14) * dt;
    const k = inp.keys;
    const mv = new THREE.Vector3();
    if (k.has('KeyW')) mv.add(fwd); if (k.has('KeyS')) mv.sub(fwd);
    if (k.has('KeyD')) mv.add(right); if (k.has('KeyA')) mv.sub(right);
    if (k.has('KeyE') || k.has('Space')) mv.y += 1; if (k.has('KeyQ') || k.has('ControlLeft')) mv.y -= 1;
    if (pad && inp.device !== 'keyboard') { mv.addScaledVector(fwd, -(Math.abs(pad.axes[1]) > 0.12 ? pad.axes[1] : 0)); mv.addScaledVector(right, Math.abs(pad.axes[0]) > 0.12 ? pad.axes[0] : 0); }
    this.camPos.addScaledVector(mv, sp);
    this.camPos.y = Math.max(heightAt(this.camPos.x, this.camPos.z) + 1, this.camPos.y);
    // piece selection
    for (const p of PIECES) {
      const code = p.key.length === 1 && /[0-9]/.test(p.key) ? 'Digit' + p.key : 'Key' + p.key;
      if (inp.hit(code)) { b.setGhost(p.t); this.emit('build-select', p.t); }
    }
    if (inp.hit('KeyR')) b.yaw = (b.yaw + 15) % 360;
    if (inp.wheel) { if (k.has('AltLeft')) b.scale = THREE.MathUtils.clamp(b.scale - inp.wheel * 0.1, 0.4, 4); else b.lift = THREE.MathUtils.clamp(b.lift - inp.wheel * 0.5, -10, 80); this.emit('build-select', b.selected); }
    if (inp.hit('KeyZ') && (k.has('ControlLeft') || k.has('MetaLeft'))) b.undoLast();
    const aim = b.aim(this.camera);
    this.emit('build-aim', aim.hitPiece);
    const clickPlace = inp.uiClick === 0 || inp.padHit(0);
    const clickDel = inp.uiClick === 1 || inp.hit('KeyX') || inp.hit('Delete') || inp.padHit(1);
    inp.uiClick = -1;
    if (clickPlace) { b.place({ t: b.selected, x: aim.pos.x, y: aim.pos.y, z: aim.pos.z, r: b.yaw, s: b.scale }); audio.tick(); }
    if (clickDel && aim.hitPiece >= 0) { b.removeAt(aim.hitPiece); audio.tick(); }
    if (inp.hit('KeyF') || inp.padHit(3)) { this.saveMap(); this.startFreeFlight(); }
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
      } else {
        // stabilised gimbal camera, follows heading, pitch from Q and E
        const e = new THREE.Euler().setFromQuaternion(s.quat, 'YXZ');
        cam.position.copy(v.fpvCam).applyQuaternion(s.quat).add(s.pos);
        cam.quaternion.setFromEuler(new THREE.Euler(THREE.MathUtils.degToRad(this.gimbalPitch), e.y, 0, 'YXZ'));
      }
      fov = this.spec.model === 'racer' || s.mode === 'acro' ? this.settings.fpvFov : 78;
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
      const hit = this.world.colliders.raycast(s.pos.clone().addScaledVector(dir, L * 0.6), dir, len, c => c.tag !== 'tree');
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
      wind: Math.hypot(w.x, w.z), windDir: (THREE.MathUtils.radToDeg(Math.atan2(w.x, w.z)) + 360) % 360,
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
