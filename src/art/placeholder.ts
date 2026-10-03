import * as THREE from 'three';
import type { CacheVisual, RingKind, RingVisual, RoyaleArt, RoyaleSfx, ScreenFx, SignalVisual, TierId } from './contracts';

// Plain stand ins for the Royale look, so gameplay can run before art lands. Art replaces this
// module's role by exporting createRoyaleArt and createRoyaleSfx from src/art/index.ts.

const RING_COLOR: Record<RingKind, string> = { shine: '#b5f78a', bigshine: '#b5f78a', charge: '#8fc2f5', repair: '#f7f7f2' };

function ring(kind: RingKind, radius: number): RingVisual {
  const mat = new THREE.MeshBasicMaterial({ color: RING_COLOR[kind], transparent: true });
  const mesh = new THREE.Mesh(new THREE.TorusGeometry(radius, kind === 'bigshine' ? 0.1 : 0.14, 8, 40), mat);
  return {
    object: mesh,
    setState(state) { mat.opacity = state === 'ready' ? 1 : state === 'taken' ? 0.15 : 0.3; },
    highlight() { /* placeholder */ },
    dispose() { mesh.geometry.dispose(); mat.dispose(); },
  };
}

function shineCache(): CacheVisual {
  const mat = new THREE.MeshBasicMaterial({ color: '#b5f78a' });
  const mesh = new THREE.Mesh(new THREE.IcosahedronGeometry(0.5, 1), mat);
  return { object: mesh, update(dt) { mesh.rotation.y += dt; }, dispose() { mesh.geometry.dispose(); mat.dispose(); } };
}

function signal(scene: THREE.Scene): SignalVisual {
  const mat = new THREE.MeshBasicMaterial({ color: '#b5f78a', transparent: true, opacity: 0.12, side: THREE.DoubleSide, depthWrite: false });
  const wall = new THREE.Mesh(new THREE.CylinderGeometry(1, 1, 1, 96, 1, true), mat);
  scene.add(wall);
  return {
    set(cx, cz, radius, ceilingY) { wall.position.set(cx, ceilingY / 2 - 20, cz); wall.scale.set(Math.max(0.1, radius), ceilingY + 40, Math.max(0.1, radius)); },
    update() { /* placeholder */ },
    dispose() { scene.remove(wall); wall.geometry.dispose(); mat.dispose(); },
  };
}

const screen: ScreenFx = { staticAmount() {}, damageFrom() {}, evolveFlash() {}, scrambled() {}, lowIntegrity() {}, dispose() {} };

export function createPlaceholderArt(scene: THREE.Scene): RoyaleArt {
  const bolts = new Map<number, THREE.Mesh>();
  const geo = new THREE.SphereGeometry(0.12, 6, 4);
  const mat = new THREE.MeshBasicMaterial({ color: '#b5f78a' });
  let next = 1;
  const sig = signal(scene);
  return {
    ring, shineCache, signal: () => sig, screen,
    bolt(pos) { const m = new THREE.Mesh(geo, mat); m.position.copy(pos); scene.add(m); bolts.set(next, m); return next++; },
    moveBolt(h, pos) { bolts.get(h)?.position.copy(pos); },
    removeBolt(h) { const m = bolts.get(h); if (m) { scene.remove(m); bolts.delete(h); } },
    waterJet() {}, emp() {}, evolve() {}, hit() {}, knockout() {}, boost() {}, ringTaken() {},
    update() {},
    dispose() { for (const m of bolts.values()) scene.remove(m); bolts.clear(); geo.dispose(); mat.dispose(); sig.dispose(); },
  };
}

export function createPlaceholderSfx(): RoyaleSfx {
  const n = () => {};
  return { pulse: n, hit: n, water: n, emp: n, evolve: n, ring: n, knockout: n, signalWarning: n, staticCrackle: n, countdown: n, victory: n, dispose: n };
}

export type { TierId };
