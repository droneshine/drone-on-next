import type * as THREE from 'three';

// The seam between gameplay and art. Gameplay (src/royale) only talks to these interfaces;
// art (src/art) implements them. Placeholders in src/art/placeholder.ts keep the game running
// until the real look lands. Change this file only with the production lead.

export type TierId = 'spark' | 'bolt' | 'storm' | 'nova';
export type RingKind = 'shine' | 'bigshine' | 'charge' | 'repair';

/** A pickup ring. The caller positions and orients `object` (ring plane is local XY, axis local Z). */
export interface RingVisual {
  readonly object: THREE.Object3D;
  /** ready: full glow. taken: personal ring already collected by the local pilot (15 % opacity).
   *  cooldown: shared ring respawning, thin outline; `remaining` 0..1 drives the countdown arc in its last 5 s. */
  setState(state: 'ready' | 'taken' | 'cooldown', remaining?: number): void;
  /** onboarding and lane start beacon */
  highlight(on: boolean): void;
  dispose(): void;
}

export interface CacheVisual {
  readonly object: THREE.Object3D;
  update(dt: number): void;
  dispose(): void;
}

/** The Signal: safe cylinder with a ceiling. Everything outside is the Static. */
export interface SignalVisual {
  /** centre x,z in world metres, radius m, ceiling world y */
  set(cx: number, cz: number, radius: number, ceilingY: number): void;
  update(dt: number, camera: THREE.Camera): void;
  dispose(): void;
}

/** Screen space overlays drawn above the 3D view and below the HUD. */
export interface ScreenFx {
  /** 0 = inside the Signal, 1 = deep in the Static */
  staticAmount(v: number): void;
  /** where damage came from, radians in screen space (0 = up, clockwise) */
  damageFrom(angle: number, amount: number): void;
  evolveFlash(tier: TierId): void;
  scrambled(on: boolean): void;
  lowIntegrity(on: boolean): void;
  dispose(): void;
}

export interface RoyaleArt {
  ring(kind: RingKind, radius: number): RingVisual;
  shineCache(): CacheVisual;
  signal(): SignalVisual;
  readonly screen: ScreenFx;

  /** PULSE projectiles live in an art pool; gameplay owns their physics and passes positions each frame. */
  bolt(pos: THREE.Vector3, dir: THREE.Vector3, tier: TierId, ownerColor: string): number;
  moveBolt(handle: number, pos: THREE.Vector3): void;
  removeBolt(handle: number, impact?: { pos: THREE.Vector3; hitDrone: boolean }): void;

  /** called every frame for every active jet (owner = pilot id); off when it stops */
  waterJet(owner: string, from: THREE.Vector3, dir: THREE.Vector3, range: number, on: boolean): void;
  /** EMP or NOVA BURST: 'charge' for the 0.35 s wind up, then 'burst' */
  emp(pos: THREE.Vector3, radius: number, nova: boolean, phase: 'charge' | 'burst'): void;
  /** evolve moment on a drone root: glow and burst, about 0.8 s */
  evolve(root: THREE.Object3D, tier: TierId): void;
  hit(pos: THREE.Vector3, amount: number, onLocalPilot: boolean): void;
  knockout(pos: THREE.Vector3): void;
  boost(root: THREE.Object3D, on: boolean): void;
  ringTaken(pos: THREE.Vector3, kind: RingKind): void;

  update(dt: number, camera: THREE.Camera): void;
  dispose(): void;
}

/** Royale sounds. All procedural WebAudio, no files. Every call must be safe before audio unlock. */
export interface RoyaleSfx {
  pulse(tier: TierId, local: boolean, distance: number): void;
  hit(onLocalPilot: boolean): void;
  water(owner: string, on: boolean, distance: number): void;
  emp(nova: boolean, distance: number): void;
  evolve(tier: TierId): void;
  ring(kind: RingKind, laneStep: number): void;
  knockout(distance: number): void;
  signalWarning(): void;
  staticCrackle(amount: number): void;
  countdown(n: number): void;
  victory(): void;
  dispose(): void;
}
