import * as THREE from 'three';
import { XRControllerModelFactory } from 'three/examples/jsm/webxr/XRControllerModelFactory.js';
import type { Game, CamMode } from '../game/game';
import type { UI } from '../ui/ui';
import type { Device, XrPads } from '../input/input';
import type { Contact } from '../world/colliders';
import { heightAt, WATER_Y } from '../world/terrain';
import { XrHud, HudData } from './hud';
import { Goggles } from './goggles';
import { xrTier } from './caps';

// WebXR immersive VR for free flight and missions. The game keeps running exactly as on a screen:
// the same tick, the same sim, the same input layer (device 'xr'). This module only swaps the loop
// (session frames instead of window frames), the camera (your head) and the final draw.
//
// PILOT view: you stand on the field behind the take off spot at 1:1 scale, like a line of sight
// pilot. Nothing moves your head but you. GOGGLES view: a head locked screen in a dark room shows
// the FPV or chase camera, rendered flat into a texture.

type View = 'pilot' | 'goggles';
type Hand = 'left' | 'right';

const UP = new THREE.Vector3(0, 1, 0);
const DOWN = new THREE.Vector3(0, -1, 0);

/**
 * Per headset class. Budget: Quest 2 at 72 Hz has 13.9 ms per frame for both eyes, on a phone class
 * CPU that pays for every draw call twice (WebGLRenderer has no multiview). So in VR:
 * no bloom or post passes (they cannot draw into the headset anyway); the sun's shadow map is a
 * snapshot of the static world around the pilot, rendered once instead of every frame (that alone
 * saves about 220 draw calls a frame), and the drone gets a soft contact shadow right below it,
 * which also reads better as a height cue; grass only in a small circle around the pilot; a three
 * octave cloud layer instead of twelve; fewer trees on Quest 2; fixed foveation on the edges.
 */
const PROFILES = {
  low: { scale: 1.0, foveation: 1.0, grassR: 16, trees: 0.5, shadow: 1024, shadowBox: 60, rt: [1280, 720], rtSamples: 2 },
  high: { scale: 1.2, foveation: 0.5, grassR: 24, trees: 1, shadow: 2048, shadowBox: 60, rt: [1600, 900], rtSamples: 4 },
} as const;

/** cheap stand in for the cloud layer: same uniforms, one three octave noise instead of two six octave ones */
const CHEAP_CLOUDS = `
  uniform float uTime; uniform float uCover; varying vec3 vW;
  float h(vec2 p){ return fract(sin(dot(p, vec2(127.1,311.7)))*43758.5453); }
  float n(vec2 p){ vec2 i=floor(p), f=fract(p); vec2 u=f*f*(3.-2.*f);
    return mix(mix(h(i),h(i+vec2(1,0)),u.x), mix(h(i+vec2(0,1)),h(i+vec2(1,1)),u.x), u.y); }
  void main(){
    vec2 p = vW.xz * 0.0016 + vec2(uTime * 0.004, uTime * 0.0015);
    float d = 0.5 * n(p) + 0.25 * n(p * 2.03) + 0.125 * n(p * 4.12);
    float c = smoothstep(1. - uCover, 1. - uCover + 0.35, d * 1.25);
    float r = length(vW.xz) / 4200.; float fade = 1. - smoothstep(0.55, 1.0, r);
    vec3 col = mix(vec3(0.78,0.80,0.84), vec3(1.0, 0.99, 0.96), 0.82 + 0.18 * smoothstep(0.0, 0.6, d));
    gl_FragColor = vec4(col, c * fade * 0.92);
  }`;

/** frame rate control on the session (Quest Browser), not in every DOM typing */
type XrRates = XRSession & { frameRate?: number; supportedFrameRates?: Float32Array; updateTargetFrameRate?: (rate: number) => Promise<void> };

interface Saved {
  camMode: CamMode;
  device: Device;
  uiDisplay: string;
  grass: { r: number; count: number } | null;
  shadowSize: number;
  shadowBox: [number, number, number, number];
  clouds: { mesh: THREE.Mesh; mat: THREE.Material } | null;
  trees: { mesh: THREE.InstancedMesh; count: number }[];
}

export class VrMode {
  /** read by the game loop hook */
  active = false;
  view: View = 'pilot';
  session: XRSession | null = null;
  /** frame timing for the report and the adaptive quality step */
  stats = { frames: 0, cpuMs: 0, intervalMs: 0, calls: 0, tris: 0, degrade: 0 };

  private g: Game;
  private ui: UI;
  private tier = xrTier();
  private prof: (typeof PROFILES)['low' | 'high'];
  private xrCam = new THREE.PerspectiveCamera(70, 1, 0.08, 9000);
  private worldRig = new THREE.Group();
  private goggles = new Goggles();
  private hud = new XrHud();
  private fade: THREE.Mesh;
  private grips: THREE.Group[] = [];
  private gripHand: (Hand | null)[] = [null, null];
  private pads: XrPads = { lx: 0, ly: 0, rx: 0, ry: 0, hits: [], moved: false };
  private prevBtn: Record<Hand, boolean[]> = { left: [], right: [] };
  private saved: Saved | null = null;
  private rt: THREE.WebGLRenderTarget | null = null;
  private cheapClouds: THREE.ShaderMaterial | null = null;
  private floorY = 0;
  private needRecenter = true;
  private lastHome = new THREE.Vector3(Infinity, 0, 0);
  private gogglesCam: 'fpv' | 'chase' = 'chase';
  private head = new THREE.Vector3();
  private headLocal = new THREE.Vector3();
  private headYawLocal = 0;
  private losSaved = new THREE.Vector3();
  private losWritten = new THREE.Vector3(NaN, NaN, NaN);
  private status = { text: '', tone: 'info' as HudData['tone'], until: 0 };
  private fadeVal = 1;
  private fadeDir = -1;
  private fadeThen: (() => void) | null = null;
  private fadeHold = 0;
  private lastNow = 0;
  private hudT = 0;
  private lastT = 0;
  private slowT = 0;
  private blob: THREE.Mesh;
  private shadowAt: THREE.Vector3 | null = null;
  private shadowT = 0;
  private pausedByBlur = false;
  private refSpace: XRReferenceSpace | null = null;
  private rateTried = false;

  constructor(g: Game, ui: UI) {
    this.g = g; this.ui = ui;
    this.prof = PROFILES[this.tier];
    this.worldRig.name = 'xr-rig';
    this.worldRig.add(this.xrCam);
    // fade: a small black ball around the eyes, drawn over everything
    this.fade = new THREE.Mesh(new THREE.SphereGeometry(0.3, 16, 8), new THREE.MeshBasicMaterial({ color: 0x000000, side: THREE.BackSide, transparent: true, depthTest: false, depthWrite: false, toneMapped: false, fog: false }));
    this.fade.renderOrder = 1e6;
    this.fade.userData.noThermal = true;
    this.xrCam.add(this.fade);
    // contact shadow: a soft dark disc on the surface right below the drone
    const c = document.createElement('canvas'); c.width = c.height = 64;
    const cx = c.getContext('2d')!, grad = cx.createRadialGradient(32, 32, 0, 32, 32, 32);
    grad.addColorStop(0, 'rgba(0,0,0,1)'); grad.addColorStop(0.45, 'rgba(0,0,0,0.75)'); grad.addColorStop(1, 'rgba(0,0,0,0)');
    cx.fillStyle = grad; cx.fillRect(0, 0, 64, 64);
    this.blob = new THREE.Mesh(new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({
      map: new THREE.CanvasTexture(c), color: 0x000000, transparent: true, depthWrite: false, toneMapped: false, fog: false,
      polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
    }));
    this.blob.name = 'xr-contact-shadow';
    this.blob.userData.noThermal = true;
    // controllers: real Touch models where the profile can be fetched, the HUD rides on the left one
    const factory = new XRControllerModelFactory(null, (scene) => scene.traverse(o => (o.userData.noThermal = true)));
    for (let i = 0; i < 2; i++) {
      const grip = g.renderer.xr.getControllerGrip(i);
      grip.add(factory.createControllerModel(grip));
      grip.addEventListener('connected', (e) => { this.gripHand[i] = ((e as unknown as { data: XRInputSource }).data.handedness as Hand) ?? null; });
      grip.addEventListener('disconnected', () => { this.gripHand[i] = null; });
      grip.userData.noThermal = true;
      this.grips.push(grip);
      this.worldRig.add(grip);
    }
    g.on('toast', (t) => { if (this.active) this.say(String(t)); });
    g.on('crash', () => { if (this.active) this.buzz(['left', 'right'], 0.9, 260); });
    g.on('state', (st) => {
      if (!this.active) return;
      // the menus, the hangar and build mode live on the flat screen
      if (st === 'menu' || st === 'build') this.exit();
      if (st === 'mission' || st === 'fly') this.needRecenter = true;
    });
  }

  // ------------------------------------------------------------------ session
  /** session already requested inside the click (that needs the user gesture) */
  async start(session: XRSession) {
    const g = this.g, r = g.renderer;
    this.session = session;
    try {
      const floor = !session.enabledFeatures || session.enabledFeatures.includes('local-floor');
      this.floorY = floor ? 0 : 1.6;
      r.xr.enabled = true;
      r.xr.setReferenceSpaceType(floor ? 'local-floor' : 'local');
      r.xr.setFramebufferScaleFactor(this.prof.scale);
      await r.xr.setSession(session);
      r.xr.setFoveation(this.prof.foveation);
    } catch (e) {
      console.warn('VR start failed', e);
      r.xr.enabled = false;
      this.session = null;
      try { await session.end(); } catch { /* already over */ }
      g.toast('VR could not start on this device');
      return;
    }
    session.addEventListener('end', this.onEnd);
    session.addEventListener('visibilitychange', this.onVisibility);
    this.refSpace = r.xr.getReferenceSpace();
    this.refSpace?.addEventListener('reset', this.onReset);

    // remember the flat game exactly as it was
    const w = g.world;
    const sh = w.sun.shadow.camera;
    const clouds = this.findClouds();
    this.saved = {
      camMode: g.camMode, device: g.input.device, uiDisplay: this.ui.root.style.display,
      grass: w.grass ? { r: w.grass.uniforms.uR.value as number, count: (w.grass.mesh.geometry as THREE.InstancedBufferGeometry).instanceCount } : null,
      shadowSize: w.sun.shadow.mapSize.x,
      shadowBox: [sh.left, sh.right, sh.top, sh.bottom],
      clouds: clouds ? { mesh: clouds, mat: clouds.material as THREE.Material } : null,
      trees: this.findTrees().map(mesh => ({ mesh, count: mesh.count })),
    };
    this.losSaved.copy(g.losPilot);
    this.losWritten.set(NaN, NaN, NaN);
    this.applyProfile();

    // input: Touch controllers become the sticks
    g.input.xr = this.pads;
    g.input.device = 'xr';
    this.prevBtn = { left: [], right: [] };
    // the flat HUD and menus cannot be seen in the headset: leave them out of style and layout work
    this.ui.root.style.display = 'none';
    g.world.scene.add(this.worldRig);
    if (!this.rt) {
      const [rw, rh] = this.prof.rt;
      this.rt = new THREE.WebGLRenderTarget(rw, rh, { type: THREE.HalfFloatType, samples: this.prof.rtSamples });
      this.goggles.screenMat.uniforms.tMap.value = this.rt.texture;
    }
    this.gogglesCam = g.camMode === 'fpv' || g.spec.model === 'racer' ? 'fpv' : 'chase';
    this.view = 'pilot';
    this.setView('pilot');
    this.needRecenter = true;
    this.fadeVal = 1; this.fadeDir = -1; this.fadeThen = null; this.fadeHold = 3;
    this.lastNow = performance.now(); this.lastT = 0; this.slowT = 0; this.stats.degrade = 0; this.lodK = 0.004; this.rateTried = false;
    this.status.until = 0;
    if (g.paused) { g.paused = false; g.emit('pause', false); }
    this.active = true;
    r.setAnimationLoop(this.loop);
    g.emit('xr', true);
    if (g.state === 'menu' || g.state === 'build' || g.state === 'boot') await g.startFreeFlight();
    this.say('PILOT view. X switches to GOGGLES, Y puts you back at the take off spot.');
  }

  /** leave VR from code; the session end event does the restoring */
  exit() { this.session?.end().catch(() => { /* already ending */ }); }

  private onEnd = () => {
    const g = this.g, r = g.renderer;
    const s = this.session;
    s?.removeEventListener('end', this.onEnd);
    s?.removeEventListener('visibilitychange', this.onVisibility);
    this.refSpace?.removeEventListener('reset', this.onReset);
    this.refSpace = null;
    this.session = null;
    this.active = false;
    r.setAnimationLoop(null);
    r.xr.enabled = false;
    r.setRenderTarget(null);
    this.setView('pilot', true);
    g.world.scene.remove(this.worldRig);
    this.restoreProfile();
    const sv = this.saved;
    if (sv) {
      if (g.input.device === 'xr') g.input.device = sv.device === 'xr' ? 'keyboard' : sv.device;
      this.ui.root.style.display = sv.uiDisplay;
      const forced = g.mission?.forceCam;
      g.camMode = forced ?? (sv.camMode === 'orbit' || sv.camMode === 'free' || sv.camMode === 'los' ? (g.spec.model === 'racer' ? 'fpv' : 'chase') : sv.camMode);
      if (sv.camMode === 'los' && !forced) g.camMode = 'los';
    }
    if (!g.losPilot.equals(this.losWritten)) this.losSaved.copy(g.losPilot);
    g.losPilot.copy(this.losSaved);
    g.input.xr = null;
    g.input.touchSpray = false;
    if (this.pausedByBlur) { this.pausedByBlur = false; g.paused = false; g.emit('pause', false); }
    this.saved = null;
    // the window may have changed while the headset owned the canvas
    g.resize();
    g.emit('xr', false);
  };

  private onVisibility = () => {
    const g = this.g, vis = this.session?.visibilityState;
    // the Quest menu is open: hold the game, like taking your hands off a real transmitter is not an option
    if (vis !== 'visible' && !g.paused && (g.state === 'fly' || g.state === 'mission')) { g.paused = true; this.pausedByBlur = true; g.emit('pause', true); }
    if (vis === 'visible' && this.pausedByBlur) { this.pausedByBlur = false; g.paused = false; g.emit('pause', false); }
  };

  private onReset = () => { this.needRecenter = true; };

  // ------------------------------------------------------------------ quality
  private findClouds() {
    let m: THREE.Mesh | null = null;
    for (const o of this.g.world.scene.children) {
      const mat = (o as THREE.Mesh).material as THREE.ShaderMaterial | undefined;
      if ((o as THREE.Mesh).isMesh && mat?.uniforms?.uCover) { m = o as THREE.Mesh; break; }
    }
    return m;
  }

  /** the forest: big instanced meshes, thinned by drawing fewer instances (they are placed at random) */
  private findTrees() {
    const out: THREE.InstancedMesh[] = [];
    this.g.world.scene.traverse(o => { const m = o as THREE.InstancedMesh; if (m.isInstancedMesh && m.count >= 500) out.push(m); });
    return out;
  }

  private applyProfile() {
    const w = this.g.world, p = this.prof, sv = this.saved!;
    if (w.grass && sv.grass) {
      // same blade density, but only in a small circle around the pilot
      const geo = w.grass.mesh.geometry as THREE.InstancedBufferGeometry;
      w.grass.uniforms.uR.value = Math.min(sv.grass.r, p.grassR);
      geo.instanceCount = Math.round(sv.grass.count * Math.min(1, (p.grassR / sv.grass.r) ** 2));
    }
    const sh = w.sun.shadow;
    sh.mapSize.set(Math.min(sv.shadowSize, p.shadow), Math.min(sv.shadowSize, p.shadow));
    sh.camera.left = -p.shadowBox; sh.camera.right = p.shadowBox; sh.camera.top = p.shadowBox; sh.camera.bottom = -p.shadowBox;
    sh.camera.updateProjectionMatrix();
    // shadows: snapshots only, see render()
    this.g.renderer.shadowMap.autoUpdate = false;
    this.shadowAt = null; this.shadowT = 0;
    for (const t of sv.trees) t.mesh.count = Math.round(t.count * p.trees);
    this.g.world.scene.add(this.blob);
    if (sv.clouds) {
      const orig = sv.clouds.mat as THREE.ShaderMaterial;
      this.cheapClouds ??= new THREE.ShaderMaterial({
        uniforms: orig.uniforms, vertexShader: orig.vertexShader, fragmentShader: CHEAP_CLOUDS,
        transparent: true, depthWrite: false, side: THREE.DoubleSide, fog: false,
      });
      sv.clouds.mesh.material = this.cheapClouds;
    }
  }

  private restoreProfile() {
    const w = this.g.world, sv = this.saved, r = this.g.renderer;
    if (!sv) return;
    if (w.grass && sv.grass) {
      w.grass.uniforms.uR.value = sv.grass.r;
      (w.grass.mesh.geometry as THREE.InstancedBufferGeometry).instanceCount = sv.grass.count;
      w.grass.mesh.visible = !w.thermal;
    }
    const sh = w.sun.shadow;
    sh.mapSize.set(sv.shadowSize, sv.shadowSize);
    [sh.camera.left, sh.camera.right, sh.camera.top, sh.camera.bottom] = sv.shadowBox;
    sh.camera.updateProjectionMatrix();
    r.shadowMap.autoUpdate = true;
    r.shadowMap.needsUpdate = true;
    for (const t of sv.trees) t.mesh.count = t.count;
    w.scene.remove(this.blob);
    if (sv.clouds) { sv.clouds.mesh.material = sv.clouds.mat; sv.clouds.mesh.visible = !w.thermal; }
    this.lodRestore(); this.lod.root = null;
  }

  /** frames run long for two seconds: give up one more extra, in the order the eye misses least */
  private degrade() {
    const w = this.g.world, s = this.stats;
    const ss = this.session as XrRates | null;
    if (ss && (ss.frameRate ?? 72) > 72 && ss.updateTargetFrameRate) {
      ss.updateTargetFrameRate(72).catch(() => { /* stays */ });
      console.info('VR back to 72 Hz');
      return;
    }
    s.degrade++;
    if (s.degrade === 1) this.g.renderer.xr.setFoveation(1);
    else if (s.degrade === 2 && w.grass) w.grass.mesh.visible = false;
    else if (s.degrade === 3) for (const t of this.saved?.trees ?? []) t.mesh.count = Math.round(t.count * 0.3);
    else if (s.degrade === 4) this.lodK = 0.012;
    else if (s.degrade === 5 && this.saved?.clouds) this.saved.clouds.mesh.visible = false;
    console.info('VR quality step', s.degrade);
  }

  // ------------------------------------------------------------------ views
  private setView(v: View, ending = false) {
    const g = this.g;
    this.view = v;
    const rig = v === 'pilot' ? this.worldRig : this.goggles.rig;
    rig.add(this.xrCam);
    for (const grip of this.grips) rig.add(grip);
    this.goggles.floor.position.y = -this.floorY;
    if (v === 'goggles') {
      this.xrCam.add(this.goggles.head);
      this.goggles.hudSlot.add(this.hud.mesh);
      this.hud.mesh.scale.setScalar(0.75);
      this.hud.mesh.position.set(0, 0, 0); this.hud.mesh.rotation.set(0, 0, 0);
      g.camMode = this.gogglesCam;
      g.camera.aspect = 16 / 9; g.camera.updateProjectionMatrix();
    } else {
      this.xrCam.remove(this.goggles.head);
      this.worldRig.add(this.hud.mesh);
      this.hud.mesh.scale.setScalar(0.2);
      if (!ending) {
        // thermal is a camera, not your eyes: the field looks normal from the pilot spot
        if (g.world.thermal) g.world.setThermal(false);
        g.camMode = 'los';
      }
    }
  }

  private switchView() {
    if (this.view === 'pilot' && this.g.mission?.forceCam === 'los') { this.say('This mission is line of sight only'); return; }
    this.transition(() => this.setView(this.view === 'pilot' ? 'goggles' : 'pilot'));
  }

  private nextCamera() {
    if (this.view === 'pilot') { this.switchView(); return; }
    this.transition(() => {
      this.gogglesCam = this.gogglesCam === 'fpv' ? 'chase' : 'fpv';
      this.g.camMode = this.gogglesCam;
    });
  }

  private transition(fn: () => void) {
    if (this.fadeThen) return;
    this.fadeThen = fn; this.fadeDir = 1;
  }

  private stepFade(now: number) {
    const dt = Math.min(0.1, (now - this.lastNow) / 1000); this.lastNow = now;
    if (this.fadeHold > 0) { this.fadeHold--; this.fadeVal = 1; }
    else if (this.fadeDir > 0) {
      this.fadeVal = Math.min(1, this.fadeVal + dt / 0.12);
      if (this.fadeVal >= 1) { const f = this.fadeThen; this.fadeThen = null; this.fadeDir = -1; f?.(); this.fadeHold = 1; }
    } else this.fadeVal = Math.max(0, this.fadeVal - dt / 0.18);
    const m = this.fade.material as THREE.MeshBasicMaterial;
    // ease out on the way back in: the picture arrives quickly, then settles
    m.opacity = this.fadeDir > 0 ? this.fadeVal : 1 - Math.pow(1 - this.fadeVal, 2);
    this.fade.visible = m.opacity > 0.002;
  }

  // ------------------------------------------------------------------ recentering
  /** where a line of sight pilot stands: behind the take off spot, a step to the side, facing it */
  private pilotSpot() {
    const g = this.g, { pos: home, yaw } = g.takeoff;
    const L = g.spec.armLength * 2 + g.spec.propDiameter;
    const back = THREE.MathUtils.clamp(3 + L * 2.5, 4.5, 10);
    const behind = new THREE.Vector3(Math.sin(yaw), 0, Math.cos(yaw));
    const side = new THREE.Vector3(Math.cos(yaw), 0, -Math.sin(yaw));
    const p = new THREE.Vector3();
    const c: Contact = { depth: 0, normal: new THREE.Vector3(), collider: null, surface: '' };
    for (let k = 0; k < 8; k++) {
      p.copy(home).addScaledVector(behind, back + k * 2.5).addScaledVector(side, 1.2);
      p.y = this.surfaceAt(p.x, p.z) + 1;
      const blocked = g.world.colliders.query(p, 0.45, c) && c.collider !== null;
      if (!blocked && heightAt(p.x, p.z) > WATER_Y + 0.2) break;
    }
    p.y = this.surfaceAt(p.x, p.z);
    return { pos: p, yaw: Math.atan2(-(home.x - p.x), -(home.z - p.z)) };
  }

  /** ground, apron or roof under a point */
  private surfaceAt(x: number, z: number) {
    const h = heightAt(x, z);
    const top = new THREE.Vector3(x, h + 6, z);
    const hit = this.g.world.colliders.raycast(top, DOWN, 12, c => c.tag !== 'player' && c.tag !== 'tree');
    return isFinite(hit.t) ? top.y - hit.t : h;
  }

  private recenter() {
    const s = this.pilotSpot();
    const yaw = s.yaw - this.headYawLocal;
    this.worldRig.rotation.set(0, yaw, 0);
    const off = new THREE.Vector3(this.headLocal.x, 0, this.headLocal.z).applyAxisAngle(UP, yaw);
    this.worldRig.position.set(s.pos.x - off.x, s.pos.y + this.floorY, s.pos.z - off.z);
    this.worldRig.updateMatrixWorld(true);
    this.lastHome.copy(this.g.takeoff.pos);
    this.needRecenter = false;
  }

  // ------------------------------------------------------------------ per frame
  private loop = (t: number) => {
    if (!this.session) return;
    const t0 = performance.now();
    this.poll();
    this.g.step();
    // timing: CPU time of the whole frame, and the real interval between headset frames
    const st = this.stats;
    st.frames++;
    st.cpuMs += ((performance.now() - t0) - st.cpuMs) * 0.05;
    if (this.lastT) {
      const iv = t - this.lastT;
      st.intervalMs += (iv - st.intervalMs) * 0.05;
      const nominal = 1000 / ((this.session as XRSession & { frameRate?: number }).frameRate || 72);
      if (st.frames > 120 && st.intervalMs > nominal * 1.25) this.slowT += iv / 1000; else this.slowT = Math.max(0, this.slowT - iv / 2000);
      if (this.slowT > 2 && st.degrade < 5) { this.slowT = 0; this.degrade(); }
    }
    this.lastT = t;
    // Quest 3: once the first seconds run with room to spare, ask for 90 Hz (degrade() goes back to 72 first)
    if (this.tier === 'high' && !this.rateTried && st.frames > 300 && st.degrade === 0 && st.cpuMs < 7 && st.intervalMs < 15) {
      this.rateTried = true;
      const ss = this.session as XrRates;
      if (ss.supportedFrameRates && Array.from(ss.supportedFrameRates).includes(90) && (ss.frameRate ?? 72) < 90) {
        ss.updateTargetFrameRate?.(90).then(() => { this.slowT = 0; }).catch(() => { /* stays as it is */ });
      }
    }
  };

  /** controllers to sticks and buttons, head pose, pilot spot; runs before the game tick */
  private poll() {
    const g = this.g, inp = g.input, s = this.session!;
    let L: Gamepad | null = null, R: Gamepad | null = null;
    for (const src of s.inputSources) {
      if (!src.gamepad) continue;
      if (src.handedness === 'left') L = src.gamepad; else if (src.handedness === 'right') R = src.gamepad;
    }
    const axes = (gp: Gamepad | null) => {
      if (!gp) return [0, 0];
      // xr-standard puts the thumbstick on axes 2 and 3; a profile with only two axes has it on 0 and 1
      return gp.axes.length >= 4 ? [gp.axes[2], gp.axes[3]] : [gp.axes[0] ?? 0, gp.axes[1] ?? 0];
    };
    const [lx, ly] = axes(L), [rx, ry] = axes(R);
    const P = this.pads;
    P.lx = lx; P.ly = ly; P.rx = rx; P.ry = ry;
    P.hits = [];
    const edge = (hand: Hand, gp: Gamepad | null, i: number) => {
      const now = !!gp?.buttons[i]?.pressed;
      const was = this.prevBtn[hand][i] ?? false;
      this.prevBtn[hand][i] = now;
      return now && !was ? 1 : !now && was ? -1 : 0;
    };
    const flying = g.state === 'fly' || g.state === 'mission';
    // right hand: trigger sprays while held, A mode, B reset, grip tags a hotspot
    const trig = edge('right', R, 0);
    if (trig === 1) inp.touchSpray = true;
    if (trig === -1) inp.touchSpray = false;
    if (edge('right', R, 4) === 1) { P.hits.push(4); this.buzz(['right'], 0.3, 40); }
    if (edge('right', R, 5) === 1) {
      if (g.state === 'result') { if (g.mission) g.restartMission(); }
      else P.hits.push(8);
      this.buzz(['right'], 0.3, 40);
    }
    if (edge('right', R, 1) === 1) P.hits.push(2);
    // left hand: X view, trigger camera, Y recenter, grip thermal (a camera, so GOGGLES only)
    if (edge('left', L, 4) === 1 && flying) { this.switchView(); this.buzz(['left'], 0.3, 40); }
    if (edge('left', L, 0) === 1 && flying) { this.nextCamera(); this.buzz(['left'], 0.3, 40); }
    if (edge('left', L, 5) === 1) { this.needRecenter = true; this.buzz(['left'], 0.3, 40); this.say('Back at the take off spot'); }
    if (edge('left', L, 1) === 1) {
      if (this.view === 'goggles') P.hits.push(3);
      else this.say('Thermal is a drone camera: switch to GOGGLES with X');
    }
    P.moved = Math.max(Math.abs(lx), Math.abs(ly), Math.abs(rx), Math.abs(ry)) > 0.3 || P.hits.length > 0 || trig === 1;

    // head pose relative to the rig, from this frame's views
    const xc = g.renderer.xr.getCamera();
    const cams = xc.cameras;
    if (cams.length) {
      this.headLocal.set(0, 0, 0);
      for (const c of cams) this.headLocal.add(c.position);
      this.headLocal.multiplyScalar(1 / cams.length);
      this.headYawLocal = new THREE.Euler().setFromQuaternion(cams[0].quaternion, 'YXZ').y;
    }
    if (cams.length && (this.needRecenter || this.lastHome.distanceTo(g.takeoff.pos) > 1)) this.recenter();
    this.head.copy(this.headLocal).applyMatrix4(this.worldRig.matrixWorld);

    // the game's own camera follows the view: your head in PILOT, the drone camera in GOGGLES
    if (this.view === 'pilot') {
      if (!g.losPilot.equals(this.losWritten)) this.losSaved.copy(g.losPilot);
      g.losPilot.copy(this.head); this.losWritten.copy(this.head);
      if (g.camMode !== 'los') g.camMode = 'los';
    } else {
      if (g.camMode === 'fpv' || g.camMode === 'chase') this.gogglesCam = g.camMode;
      else g.camMode = this.gogglesCam;
      if (g.mission?.forceCam === 'los') this.setView('pilot');
    }
  }

  /** called by the game tick instead of the composer */
  render(_dt: number) {
    const g = this.g, r = g.renderer, w = g.world;
    if (g.contextLost || !this.session) return;
    const now = performance.now();
    this.stepFade(now);
    if (now - this.hudT > 80) { this.hudT = now; this.updateHud(); }
    this.placeHud();
    this.placeBlob();
    this.shadowSnapshot(now);
    const parts = g.particles.points.material as THREE.ShaderMaterial;
    if (this.view === 'pilot') {
      // grass and clouds around the pilot, particles sized for the eye buffer
      if (w.grass) w.grass.uniforms.uCam.value.copy(this.head);
      const cl = this.saved?.clouds?.mesh;
      if (cl) { cl.position.x = this.head.x; cl.position.z = this.head.z; }
      this.droneLod(true);
      const eye = r.xr.getCamera().cameras[0];
      if (eye?.viewport) parts.uniforms.uScale.value = eye.viewport.w * eye.projectionMatrix.elements[5] / 2;
      r.render(w.scene, this.xrCam);
      this.restoreShadowCasters();
      this.stats.calls = r.info.render.calls; this.stats.tris = r.info.render.triangles;
    } else {
      // the drone camera into the screen texture: a plain mono render, the headset camera stays out of it
      this.droneLod(false);
      const cam = g.camera, rt = this.rt!;
      parts.uniforms.uScale.value = rt.height / (2 * Math.tan(THREE.MathUtils.degToRad(cam.fov / 2)));
      const xrTarget = r.getRenderTarget();
      r.xr.enabled = false;
      r.setRenderTarget(rt);
      r.render(w.scene, cam);
      this.restoreShadowCasters();
      this.stats.calls = r.info.render.calls; this.stats.tris = r.info.render.triangles;
      r.xr.enabled = true;
      r.setRenderTarget(xrTarget);
      const u = this.goggles.screenMat.uniforms;
      u.uThermal.value = w.thermal ? 1 : 0;
      u.uTime.value = (now / 1000) % 10;
      r.render(this.goggles.scene, this.xrCam);
      this.stats.calls += r.info.render.calls; this.stats.tris += r.info.render.triangles;
    }
  }

  /**
   * The static world's shadows are rendered once around where the action is: the pilot spot in PILOT
   * view, the drone in GOGGLES view (again when it has flown 60 % of the box away, at most once a
   * second). The drone stays out of the snapshot, its contact shadow is the blob.
   */
  private shadowSnapshot(now: number) {
    const g = this.g, w = g.world, r = g.renderer;
    const focus = this.view === 'pilot' ? this.head : g.sim.pos;
    const box = this.prof.shadowBox;
    const due = !this.shadowAt || (Math.hypot(focus.x - this.shadowAt.x, focus.z - this.shadowAt.z) > box * 0.6 && now - this.shadowT > 1000);
    if (!due) return;
    this.shadowAt = focus.clone(); this.shadowT = now;
    const sun = w.sun;
    sun.target.position.set(Math.round(focus.x / 4) * 4, 0, Math.round(focus.z / 4) * 4);
    sun.position.copy(sun.target.position).addScaledVector(w.sunDir, 250);
    sun.target.updateMatrixWorld(); sun.updateMatrixWorld();
    // keep the drone out of this one render
    const casters: THREE.Object3D[] = [];
    g.visual?.root.traverse(o => { if (o.castShadow) { casters.push(o); o.castShadow = false; } });
    this.restoreCasters = casters;
    r.shadowMap.needsUpdate = true;
  }
  private restoreCasters: THREE.Object3D[] = [];
  private lod = { root: null as THREE.Object3D | null, parts: [] as { m: THREE.Object3D; r: number; mask: number }[] };

  /**
   * PILOT view: the drone's small parts (bolts, LEDs, antennas, gimbal details, under 6 % of the
   * drone's size) are left out once they would be a few pixels in the headset. Every part is one draw
   * call per eye, and a drone has 34 to 93 of them. The frame, arms and props always stay, so a far
   * drone still reads clearly. A camera layer does it, so the game's own visibility switches stay its own.
   */
  private droneLod(on: boolean) {
    const g = this.g, root = g.visual?.root ?? null;
    if (this.lod.root !== root) {
      this.lodRestore();
      this.lod.root = root; this.lod.parts = [];
      if (root) {
        root.updateMatrixWorld(true);
        const keep = new Set<THREE.Object3D>();
        for (const p of g.visual.props) p.pivot.traverse(o => keep.add(o));
        const span = g.spec.armLength * 2 + g.spec.propDiameter;
        const s = new THREE.Sphere();
        root.traverse(o => {
          const m = o as THREE.Mesh;
          if (!m.isMesh || keep.has(m)) return;
          if (!m.geometry.boundingSphere) m.geometry.computeBoundingSphere();
          s.copy(m.geometry.boundingSphere!).applyMatrix4(m.matrixWorld);
          if (s.radius < span * 0.06) this.lod.parts.push({ m, r: s.radius, mask: m.layers.mask });
        });
      }
    }
    if (!on || !root) { this.lodRestore(); return; }
    const d = Math.max(0.1, this.head.distanceTo(g.sim.pos));
    for (const p of this.lod.parts) {
      const mask = p.r / d < this.lodK ? 1 << 7 : p.mask;
      if (p.m.layers.mask !== mask) p.m.layers.mask = mask;
    }
  }
  private lodK = 0.004;
  private lodRestore() { for (const p of this.lod.parts) p.m.layers.mask = p.mask; }
  private restoreShadowCasters() {
    for (const o of this.restoreCasters) o.castShadow = true;
    this.restoreCasters = [];
  }

  private placeBlob() {
    const g = this.g, s = g.sim, b = this.blob;
    b.visible = !!s && g.visual?.root.visible !== false && !g.world.thermal;
    if (!b.visible) return;
    const span = g.spec.armLength * 2 + g.spec.propDiameter;
    const ground = s.pos.y - s.legHeight() - Math.max(0, s.agl);
    b.position.set(s.pos.x, ground + 0.015, s.pos.z);
    b.scale.setScalar(span * (1.15 + Math.max(0, s.agl) * 0.04));
    (b.material as THREE.MeshBasicMaterial).opacity = 0.55 * THREE.MathUtils.clamp(1 - s.agl / 25, 0, 1);
  }

  // ------------------------------------------------------------------ HUD
  private leftGrip() {
    const i = this.gripHand.indexOf('left');
    return i >= 0 ? this.grips[i] : null;
  }

  /** above the left controller, turned to the eyes; without a left controller, low in front */
  private placeHud() {
    if (this.view !== 'pilot') return;
    const m = this.hud.mesh, grip = this.leftGrip();
    const rigInv = new THREE.Matrix4().copy(this.worldRig.matrixWorld).invert();
    const headLocal = this.head.clone().applyMatrix4(rigInv);
    if (grip && grip.visible) {
      m.position.copy(grip.position).add(new THREE.Vector3(0, 0.11, 0));
    } else {
      const f = new THREE.Vector3(-Math.sin(this.headYawLocal), 0, -Math.cos(this.headYawLocal));
      m.position.copy(headLocal).addScaledVector(f, 0.55).add(new THREE.Vector3(0, -0.4, 0));
    }
    // face the eyes: the plane's front is its +z, which lookAt turns towards the target
    m.lookAt(this.head);
  }

  private say(text: string, tone: HudData['tone'] = 'info', ms = 3200) {
    this.status = { text, tone, until: performance.now() + ms };
  }

  private updateHud() {
    const g = this.g;
    if (!g.sim) return;
    const t = g.telemetry();
    let status = '', tone: HudData['tone'] = 'info';
    if (performance.now() < this.status.until) { status = this.status.text; tone = this.status.tone; }
    else if (g.state === 'result' && g.result) {
      const ok = g.result.stars > 0;
      status = `${ok ? 'Mission passed' : 'Mission failed'}: ${g.result.score}. Press B to fly it again.`;
      tone = ok ? 'info' : 'warn';
    } else if (g.paused) { status = 'Paused. Start or Esc resumes.'; tone = 'warn'; }
    else if (t.crashed) { status = `${t.crashReason || 'Crashed'}. Press B to reset.`; tone = 'bad'; }
    // #xrstats in the link: headset frame rate, draw calls, CPU time and quality step
    else if (location.hash.includes('xrstats')) { const st = this.stats; status = `${Math.round(1000 / Math.max(1, st.intervalMs))} fps · ${st.calls} draw calls · ${st.cpuMs.toFixed(1)} ms CPU · quality step ${st.degrade}`; }
    else if (t.missionHud) status = t.missionHud;
    else if (g.mission) status = g.mission.objectives().find(o => !o.done)?.text ?? g.mission.title;
    else status = this.view === 'pilot' ? 'X goggles · Y recenter · A mode · B reset' : 'X pilot view · left trigger camera · A mode · B reset';
    const arm = t.crashed ? 'CRASHED' : t.armed ? 'ARMED' : t.mode === 'gps' ? 'LEFT STICK UP TO ARM' : 'LEFT STICK DOWN, THEN UP';
    const view = this.view === 'pilot' ? 'PILOT' : this.gogglesCam === 'fpv' ? 'GOGGLES FPV' : 'GOGGLES CHASE';
    this.hud.update({ mode: t.mode.toUpperCase(), arm, armed: t.armed, batt: t.soc, alt: t.agl, speed: t.speed * 3.6, view, status, tone });
  }

  private buzz(hands: Hand[], intensity: number, ms: number) {
    for (const src of this.session?.inputSources ?? []) {
      if (!hands.includes(src.handedness as Hand)) continue;
      const act = (src.gamepad as (Gamepad & { hapticActuators?: { pulse?: (v: number, ms: number) => Promise<boolean> }[] }) | undefined)?.hapticActuators?.[0];
      act?.pulse?.(intensity, ms)?.catch?.(() => { /* no haptics */ });
    }
  }
}

/**
 * Compiles the VR versions of the world's shaders while the menu idles: in a headset every material
 * tone maps in its own shader, a different program from the flat game's, and compiling forty of them
 * on the first VR frame would freeze the view for a second or more.
 */
export function prewarm(g: Game) {
  const r = g.renderer;
  const rt = new THREE.WebGLRenderTarget(1, 1);
  (rt as THREE.WebGLRenderTarget & { isXRRenderTarget: boolean }).isXRRenderTarget = true;
  rt.texture.colorSpace = THREE.SRGBColorSpace;
  const prev = r.getRenderTarget();
  r.setRenderTarget(rt);
  let done: Promise<unknown> = Promise.resolve();
  try { done = r.compileAsync(g.world.scene, g.camera); } catch (e) { console.warn(e); }
  r.setRenderTarget(prev);
  done.catch(() => { /* optional */ }).finally(() => rt.dispose());
}

