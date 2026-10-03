import * as THREE from 'three';
import type { CacheVisual, RingKind, RingVisual, RoyaleArt, SignalVisual, TierId } from './contracts';
import { BRAND, shared, sceneIsThermal } from './kit';
import { RingImpl, CacheImpl } from './rings';
import { SignalImpl } from './signal';
import { BoltPool } from './bolts';
import { Effects } from './fx';
import { ScreenImpl } from './screen';
import { Beacons } from './beacons';

// The real Royale look behind createRoyaleArt (src/art/index.ts). One group in the scene holds
// every art object; update() advances the shared clock once per frame and drives everything.
// dispose() removes all of it, frees GPU memory and takes the screen overlays out of the DOM.

export class RoyaleArtImpl implements RoyaleArt {
  readonly screen: ScreenImpl;
  readonly group = new THREE.Group();
  private rings = new Set<RingImpl>();
  private caches = new Set<CacheImpl>();
  private signals = new Set<SignalImpl>();
  private bolts: BoltPool;
  readonly fx: Effects;
  private beacons: Beacons;
  private colors = new Map<string, THREE.Color>();
  private disposed = false;

  constructor(private scene: THREE.Scene) {
    this.group.name = 'royale-art';
    this.group.userData.noThermal = true;
    scene.add(this.group);
    this.bolts = new BoltPool(512);
    this.group.add(this.bolts.mesh);
    this.fx = new Effects(this.group);
    this.beacons = new Beacons(this.group);
    this.screen = new ScreenImpl();
  }

  ring(kind: RingKind, radius: number): RingVisual {
    const r = new RingImpl(kind, radius, x => this.rings.delete(x), this.group);
    this.rings.add(r);
    return r;
  }

  shineCache(): CacheVisual {
    const c = new CacheImpl(x => this.caches.delete(x));
    this.caches.add(c);
    return c;
  }

  signal(): SignalVisual {
    const s = new SignalImpl(this.group, x => this.signals.delete(x));
    this.signals.add(s);
    return s;
  }

  /** owner colours parse once, then live in a small cache (no allocation per shot) */
  private glowOf(c: string) {
    let col = this.colors.get(c);
    if (!col) {
      col = new THREE.Color();
      try { col.set(c || BRAND.light); } catch { col.set(BRAND.light); }
      // the shooter's colour as a halo: keep it bright enough to read on grass and sky
      const hsl = { h: 0, s: 0, l: 0 };
      col.getHSL(hsl);
      col.setHSL(hsl.h, Math.min(1, hsl.s * 1.1), Math.max(0.55, hsl.l));
      if (this.colors.size > 64) this.colors.clear();
      this.colors.set(c, col);
    }
    return col;
  }

  bolt(pos: THREE.Vector3, dir: THREE.Vector3, tier: TierId, ownerColor: string): number {
    const h = this.bolts.spawn(pos, dir, tier, this.glowOf(ownerColor));
    this.fx.muzzle(pos, dir, tier);
    return h;
  }

  moveBolt(handle: number, pos: THREE.Vector3) { this.bolts.move(handle, pos); }

  removeBolt(handle: number, impact?: { pos: THREE.Vector3; hitDrone: boolean }) {
    const dir = this.bolts.remove(handle);
    if (impact) this.fx.impact(impact.pos, dir, impact.hitDrone);
  }

  waterJet(owner: string, from: THREE.Vector3, dir: THREE.Vector3, range: number, on: boolean) { this.fx.waterJet(owner, from, dir, range, on); }
  emp(pos: THREE.Vector3, radius: number, nova: boolean, phase: 'charge' | 'burst') { this.fx.emp(pos, radius, nova, phase); }
  evolve(root: THREE.Object3D, tier: TierId) { this.fx.evolve(root, tier); }
  hit(pos: THREE.Vector3, amount: number, onLocalPilot: boolean) { this.fx.hit(pos, amount, onLocalPilot); }
  knockout(pos: THREE.Vector3) { this.fx.knockout(pos); }
  boost(root: THREE.Object3D, on: boolean) { this.fx.boost(root, on); }
  ringTaken(pos: THREE.Vector3, kind: RingKind) { this.fx.ringTaken(pos, kind); }

  update(dt: number, camera: THREE.Camera) {
    if (this.disposed) return;
    shared.time.value += dt;
    shared.thermal.value = sceneIsThermal(this.scene) ? 1 : 0;
    const pc = camera as THREE.PerspectiveCamera;
    if (pc.isPerspectiveCamera) shared.px.value = 2 * Math.tan(THREE.MathUtils.degToRad(pc.fov) / 2) / Math.max(1, innerHeight);
    for (const r of this.rings) r.tick(dt, isShown(r.object));
    for (const s of this.signals) s.update(dt, camera);
    this.bolts.update();
    this.fx.update(dt, camera);
    this.beacons.update(this.scene);
  }

  /** live numbers for the gallery and the performance budget */
  stats() { return { bolts: this.bolts.count, rings: this.rings.size, ...this.fx.stats() }; }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    for (const r of [...this.rings]) r.dispose();
    for (const c of [...this.caches]) c.dispose();
    for (const s of [...this.signals]) s.dispose();
    this.bolts.dispose();
    this.fx.dispose();
    this.beacons.dispose();
    this.screen.dispose();
    this.group.removeFromParent();
  }
}

/** visible and actually in a scene graph */
function isShown(o: THREE.Object3D) {
  let x: THREE.Object3D | null = o;
  while (x) { if (!x.visible) return false; if ((x as THREE.Scene).isScene) return true; x = x.parent; }
  return false;
}
