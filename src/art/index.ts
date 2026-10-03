import type * as THREE from 'three';
import type { RoyaleArt, RoyaleSfx } from './contracts';
import { createPlaceholderArt, createPlaceholderSfx } from './placeholder';

// Entry point gameplay uses. Art swaps the placeholders for the real implementations here.
export function createRoyaleArt(scene: THREE.Scene, _camera: THREE.Camera): RoyaleArt { return createPlaceholderArt(scene); }
export function createRoyaleSfx(): RoyaleSfx { return createPlaceholderSfx(); }
export type * from './contracts';
