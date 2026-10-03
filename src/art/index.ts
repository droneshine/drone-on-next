import type * as THREE from 'three';
import type { RoyaleArt, RoyaleSfx } from './contracts';
import { RoyaleArtImpl } from './royaleArt';
import { RoyaleSfxImpl } from './sfx';

// Entry point gameplay uses. The real implementations live in royaleArt.ts and sfx.ts;
// placeholder.ts stays as the minimal reference of the contract.
export function createRoyaleArt(scene: THREE.Scene, _camera: THREE.Camera): RoyaleArt { return new RoyaleArtImpl(scene); }
export function createRoyaleSfx(): RoyaleSfx { return new RoyaleSfxImpl(); }
export type * from './contracts';
/** optional: warm the shared tier geometry with gameplay's own tier specs at match load */
export { warmTierAssets } from './tierSpecs';
