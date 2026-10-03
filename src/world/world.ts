import * as THREE from 'three';
import { Sky } from 'three/examples/jsm/objects/Sky.js';
import { ColliderWorld } from './colliders';
import { buildTerrain, heightAt, heightTexture, WATER_Y } from './terrain';
import { SolarPark } from './solar';
import { FacadeBlock } from './facade';
import { buildBase, buildFreestyle, buildTurbine, buildForest, buildWater, buildClouds, Ring } from './props';
import { buildGrass } from './grass';

export type TimeOfDay = 'day' | 'golden' | 'overcast' | 'dusk';

export class World {
  scene = new THREE.Scene();
  colliders = new ColliderWorld();
  solar: SolarPark;
  facade: FacadeBlock;
  rings: Ring[];
  pads: THREE.Vector3[];
  pilotPos: THREE.Vector3;
  sun = new THREE.DirectionalLight('#fff4e0', 3.2);
  hemi = new THREE.HemisphereLight('#bcd7ff', '#4a5a32', 0.9);
  sky = new Sky();
  sunDir = new THREE.Vector3();
  wind = new THREE.Vector3(2, 0, 1);
  windBase = new THREE.Vector3(2, 0, 1);
  gustiness = 0.35;
  private turbine: ReturnType<typeof buildTurbine>;
  private forest: ReturnType<typeof buildForest>;
  private water: ReturnType<typeof buildWater>;
  private clouds: ReturnType<typeof buildClouds>;
  grass: ReturnType<typeof buildGrass> | null = null;
  private sock: THREE.Object3D;
  private pmrem: THREE.PMREMGenerator;
  private envRT: THREE.WebGLRenderTarget | null = null;
  thermal = false;
  private thermalSwap = new Map<THREE.Mesh, THREE.Material | THREE.Material[]>();
  buildGroup = new THREE.Group();
  time = 0;
  /** grass free spot around the take off point */
  clearSpot = new THREE.Vector3(0, 0, 0);

  constructor(private renderer: THREE.WebGLRenderer, quality: 'low' | 'high') {
    const s = this.scene;
    this.colliders.heightAt = heightAt;
    this.colliders.waterLevel = WATER_Y;
    s.fog = new THREE.FogExp2('#b9cbd8', 0.0011);

    this.sky.scale.setScalar(10000);
    s.add(this.sky);
    s.add(this.hemi);
    this.sun.castShadow = true;
    const sh = this.sun.shadow;
    sh.mapSize.set(quality === 'high' ? 4096 : 2048, quality === 'high' ? 4096 : 2048);
    sh.camera.left = -70; sh.camera.right = 70; sh.camera.top = 70; sh.camera.bottom = -70;
    sh.camera.near = 1; sh.camera.far = 600;
    sh.bias = -0.0004; sh.normalBias = 0.04;
    s.add(this.sun, this.sun.target);

    s.add(buildTerrain());
    const base = buildBase(this.colliders);
    s.add(base.group);
    this.pads = base.pads; this.pilotPos = base.pilotPos; this.sock = base.sockPivot;

    this.solar = new SolarPark(this.colliders);
    s.add(this.solar.group);
    this.facade = new FacadeBlock(this.colliders);
    s.add(this.facade.group);
    const fs = buildFreestyle(this.colliders);
    s.add(fs.group);
    this.rings = fs.rings;
    this.turbine = buildTurbine(this.colliders);
    s.add(this.turbine.group);
    this.forest = buildForest(this.colliders, quality === 'high' ? 2200 : 1300);
    s.add(this.forest.group);
    this.water = buildWater();
    s.add(this.water.mesh);
    this.clouds = buildClouds();
    s.add(this.clouds.mesh);
    if (quality === 'high') {
      this.grass = buildGrass(heightTexture(512), 110000, 75);
      s.add(this.grass.mesh);
    } else {
      this.grass = buildGrass(heightTexture(512), 40000, 50);
      s.add(this.grass.mesh);
    }
    s.add(this.buildGroup);

    this.pmrem = new THREE.PMREMGenerator(renderer);
    this.setTime('golden');
  }

  setTime(t: TimeOfDay) {
    // env: sky reflection strength; grass: tint so the blades sit in the same light as the ground
    const presets: Record<TimeOfDay, { el: number; az: number; turb: number; ray: number; mie: number; sun: string; si: number; hemi: number; fog: string; fogD: number; cover: number; exp: number; env: number; grass: string }> = {
      day: { el: 52, az: 160, turb: 2.6, ray: 1.0, mie: 0.002, sun: '#fff4e4', si: 2.7, hemi: 0.42, fog: '#9fb4c4', fogD: 0.00045, cover: 0.4, exp: 0.44, env: 0.5, grass: '#ffffff' },
      golden: { el: 16, az: 235, turb: 6, ray: 2.0, mie: 0.005, sun: '#ffcf96', si: 2.5, hemi: 0.45, fog: '#b4aa96', fogD: 0.00055, cover: 0.42, exp: 0.48, env: 0.5, grass: '#fff0d8' },
      overcast: { el: 40, az: 180, turb: 10, ray: 0.5, mie: 0.012, sun: '#eef0ee', si: 1.7, hemi: 0.45, fog: '#8f9699', fogD: 0.0011, cover: 0.85, exp: 0.46, env: 0.22, grass: '#d8dcd2' },
      dusk: { el: 4, az: 250, turb: 8, ray: 3.0, mie: 0.008, sun: '#ffa063', si: 2.2, hemi: 0.8, fog: '#6f6370', fogD: 0.0009, cover: 0.38, exp: 1.05, env: 0.45, grass: '#b89a8a' },
    };
    const p = presets[t];
    const u = this.sky.material.uniforms;
    u.turbidity.value = p.turb; u.rayleigh.value = p.ray; u.mieCoefficient.value = p.mie; u.mieDirectionalG.value = 0.85;
    // the stock sun disc is about 60000 in HDR, close to the half float limit: with bloom on top it
    // overflows to Infinity and the frame turns black. A dimmer disc still reads as the sun.
    u.showSunDisc.value = 0.05;
    const phi = THREE.MathUtils.degToRad(90 - p.el), theta = THREE.MathUtils.degToRad(p.az);
    this.sunDir.setFromSphericalCoords(1, phi, theta);
    u.sunPosition.value.copy(this.sunDir);
    this.sun.color.set(p.sun); this.sun.intensity = p.si;
    this.hemi.intensity = p.hemi;
    (this.scene.fog as THREE.FogExp2).color.set(p.fog);
    (this.scene.fog as THREE.FogExp2).density = p.fogD;
    this.clouds.mat.uniforms.uCover.value = p.cover;
    this.renderer.toneMappingExposure = p.exp;
    // environment from the sky for real reflections on modules and glass
    const tmp = new THREE.Scene();
    const skyCopy = new Sky(); skyCopy.scale.setScalar(10000);
    const su = skyCopy.material.uniforms;
    for (const k of Object.keys(u)) (su as Record<string, { value: unknown }>)[k].value = (u as Record<string, { value: { clone?: () => unknown } }>)[k].value?.clone ? (u as Record<string, { value: { clone: () => unknown } }>)[k].value.clone() : (u as Record<string, { value: unknown }>)[k].value;
    tmp.add(skyCopy);
    this.envRT?.dispose();
    this.envRT = this.pmrem.fromScene(tmp, 0.02);
    skyCopy.geometry.dispose(); skyCopy.material.dispose();
    this.scene.environment = this.envRT.texture;
    this.scene.environmentIntensity = p.env;
    if (this.grass) { this.grass.uniforms.uSun.value.copy(this.sunDir); this.grass.uniforms.uTint.value.set(p.grass); }
  }

  setWind(speed: number, dirDeg: number, gust: number) {
    const a = THREE.MathUtils.degToRad(dirDeg);
    // dirDeg is where the wind comes FROM (0 north, 90 east). North is -z, east is +x.
    this.windBase.set(-Math.sin(a) * speed, 0, Math.cos(a) * speed);
    this.gustiness = gust;
  }

  update(dt: number, focus: THREE.Vector3, cam: THREE.Camera, rotor?: { pos: THREE.Vector3; strength: number; radius: number }) {
    this.time += dt;
    const t = this.time;
    // gusts: layered sines feel organic and stay deterministic
    const g = this.gustiness;
    const gust = 1 + g * (Math.sin(t * 0.37) * 0.5 + Math.sin(t * 1.13 + 1.7) * 0.3 + Math.sin(t * 2.9 + 0.4) * 0.2);
    const veer = g * 0.35 * Math.sin(t * 0.21);
    this.wind.copy(this.windBase).multiplyScalar(gust).applyAxisAngle(new THREE.Vector3(0, 1, 0), veer);
    this.wind.y = g * 0.6 * Math.sin(t * 0.9);
    // shadow box follows the action
    const snap = 4;
    const fx = Math.round(focus.x / snap) * snap, fz = Math.round(focus.z / snap) * snap;
    this.sun.target.position.set(fx, focus.y * 0.5, fz);
    this.sun.position.set(fx, focus.y * 0.5, fz).addScaledVector(this.sunDir, 250);
    this.sun.target.updateMatrixWorld();
    this.turbine.update(dt);
    this.forest.uTime.value = t;
    this.water.update(t);
    this.clouds.mat.uniforms.uTime.value = t;
    this.clouds.mesh.position.x = cam.position.x; this.clouds.mesh.position.z = cam.position.z;
    this.solar.update(t);
    this.facade.update();
    // windsock points downwind and lifts with speed
    const ws = Math.hypot(this.wind.x, this.wind.z);
    this.sock.rotation.y = Math.atan2(-this.wind.z, this.wind.x);
    this.sock.rotation.z = -Math.PI / 2 + Math.min(1, ws / 8) * (Math.PI / 2) + Math.sin(t * 7) * 0.04;
    if (this.grass) {
      const u = this.grass.uniforms;
      u.uCam.value.copy(cam.position);
      u.uTime.value = t;
      u.uClear.value.set(this.clearSpot.x, this.clearSpot.z, this.clearSpot.y);
      u.uWind.value.set(this.wind.x, this.wind.z).multiplyScalar(0.12);
      const f = this.scene.fog as THREE.FogExp2;
      u.fogColor.value.copy(f.color); u.fogDensity.value = f.density;
      if (rotor) u.uRotor.value.set(rotor.pos.x, rotor.pos.z, rotor.radius, rotor.strength);
      else u.uRotor.value.w = 0;
    }
  }

  // --------------------------------------------------------------- thermal camera
  setThermal(on: boolean, extra: THREE.Object3D[] = []) {
    if (on === this.thermal) return;
    this.thermal = on;
    this.solar.uniforms.uThermal.value = on ? 1 : 0;
    if (on) {
      const cache = new Map<number, THREE.Material>();
      const thermalMat = (temp: number) => {
        const k = Math.round(temp * 50);
        let m = cache.get(k);
        if (!m) {
          const c = ironbow(temp);
          m = new THREE.MeshLambertMaterial({ color: '#000', emissive: c, emissiveIntensity: 1 });
          cache.set(k, m);
        }
        return m;
      };
      const visit = (o: THREE.Object3D, inherited?: number) => {
        const temp = o.userData.temp ?? inherited;
        const mesh = o as THREE.Mesh;
        if (mesh.isMesh && !o.userData.thermalSelf && !o.userData.noThermal) {
          const mat = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material;
          let t = temp;
          if (t == null) {
            const col = (mat as THREE.MeshStandardMaterial).color;
            t = col ? 0.35 + 0.15 * (1 - (col.r + col.g + col.b) / 3) : 0.4;
          }
          if (o.name === 'terrain') t = 0.33;
          if (!this.thermalSwap.has(mesh)) this.thermalSwap.set(mesh, mesh.material);
          mesh.material = thermalMat(t);
        }
        for (const c of o.children) visit(c, temp);
      };
      visit(this.scene);
      for (const e of extra) visit(e, e.userData.temp);
      this.sky.visible = false; this.clouds.mesh.visible = false;
      if (this.grass) this.grass.mesh.visible = false;
      this.scene.background = new THREE.Color('#0b0820');
      this.scene.fog = new THREE.FogExp2('#120c2a', 0.004);
    } else {
      for (const [m, mat] of this.thermalSwap) m.material = mat;
      this.thermalSwap.clear();
      this.sky.visible = true; this.clouds.mesh.visible = true;
      if (this.grass) this.grass.mesh.visible = true;
      this.scene.background = null;
      this.scene.fog = new THREE.FogExp2('#b9cbd8', 0.0011);
      this.setTime(this.currentTime);
    }
  }
  currentTime: TimeOfDay = 'golden';
}

export function ironbow(t: number) {
  t = Math.max(0, Math.min(1, t));
  const r = Math.min(1, Math.max(0, 1.5 * t - 0.1));
  const g = Math.min(1, Math.max(0, t * t * 1.4 - 0.25 + (t > 0.85 ? (t - 0.85) * 1.3 : 0)));
  const b = Math.min(1, Math.max(0, 0.5 * Math.sin(t * 3.6) + (t > 0.85 ? (t - 0.85) * 5 : 0)));
  return new THREE.Color(r, g, b);
}
