import * as THREE from 'three';
import { tierRoots, TierAsset } from './tiers';
import { tierBodyMaterial } from './kit';

// The crowd: with 50 drones in a match most of them are mid or far away. While a Royale art system
// runs it takes over the LOD of every live tier drone, hides their own mid and far meshes and draws
// all of them as instances: one draw call per tier and paint and level, never a shadow.
// When the art system is disposed every drone gets its own LOD back, nothing else changes.

const CAP = 96;
const _p = new THREE.Vector3(), _c = new THREE.Vector3();

interface Set { asset: TierAsset; mid: THREE.InstancedMesh; far: THREE.InstancedMesh; nMid: number; nFar: number; }


export class Crowd {
  private sets = new Map<string, Set>();
  private group = new THREE.Group();
  private managed = new Set<THREE.Object3D>();
  private body = tierBodyMaterial();
  private live = { near: 0, mid: 0, far: 0 };

  constructor(parent: THREE.Object3D) {
    this.group.name = 'tier-crowd';
    this.group.userData.noThermal = true;
    this.body.userData.tierPaint = false;   // the evolve glow never lights a whole crowd
    parent.add(this.group);
  }

  private setFor(a: TierAsset): Set {
    let s = this.sets.get(a.key);
    if (!s) {
      const mk = (g: THREE.BufferGeometry, name: string) => {
        const m = new THREE.InstancedMesh(g, this.body, CAP);
        m.name = name; m.count = 0; m.frustumCulled = false; m.castShadow = false;
        m.userData.noThermal = true;
        m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
        this.group.add(m);
        return m;
      };
      s = { asset: a, mid: mk(a.mid, 'crowd-mid'), far: mk(a.far, 'crowd-far'), nMid: 0, nFar: 0 };
      this.sets.set(a.key, s);
    }
    return s;
  }

  update(camera: THREE.Camera, scene: THREE.Scene) {
    for (const s of this.sets.values()) { s.nMid = 0; s.nFar = 0; }
    this.live.near = this.live.mid = this.live.far = 0;
    for (const ref of tierRoots) {
      const root = ref.deref();
      if (!root) continue;
      const lod = root.userData.lod as THREE.LOD | undefined;
      const a = root.userData.tierAsset as TierAsset | undefined;
      const meshes = root.userData.lodMeshes as THREE.Mesh[] | undefined;
      if (!lod || !a || !meshes || !shownIn(root, scene)) continue;
      if (!this.managed.has(root)) {
        this.managed.add(root);
        lod.autoUpdate = false;
        for (const m of meshes) m.visible = false;
      }
      // pick the level now, before the render, so the instances and the drone never disagree
      root.updateWorldMatrix(true, false);
      lod.update(camera);
      const level = lod.getCurrentLevel();
      if (level === 0) {
        this.live.near++;
        // near drones cast shadows only where the shadow map can resolve them
        const body = root.userData.bodyMesh as THREE.Mesh | undefined;
        if (body) body.castShadow = _p.setFromMatrixPosition(lod.matrixWorld).distanceTo(_c.setFromMatrixPosition(camera.matrixWorld)) < 45;
        continue;
      }
      const s = this.setFor(a);
      if (level === 1) {
        if (s.nMid < CAP) s.mid.setMatrixAt(s.nMid++, lod.matrixWorld);
        this.live.mid++;
      } else {
        if (s.nFar < CAP) s.far.setMatrixAt(s.nFar++, lod.matrixWorld);
        this.live.far++;
      }
    }
    for (const s of this.sets.values()) {
      for (const [m, n] of [[s.mid, s.nMid], [s.far, s.nFar]] as const) {
        m.count = n;
        m.visible = n > 0;
        if (n) m.instanceMatrix.needsUpdate = true;
      }
    }
    // forget drones that left the scene: they get their own LOD back
    for (const root of this.managed) if (!shownIn(root, scene)) this.release(root);
  }

  private release(root: THREE.Object3D) {
    this.managed.delete(root);
    const lod = root.userData.lod as THREE.LOD | undefined;
    if (lod) lod.autoUpdate = true;
    for (const m of (root.userData.lodMeshes as THREE.Mesh[] | undefined) ?? []) m.visible = true;
    const body = root.userData.bodyMesh as THREE.Mesh | undefined;
    if (body) body.castShadow = true;
  }

  stats() { return { ...this.live, calls: [...this.sets.values()].reduce((n, s) => n + (s.nMid ? 1 : 0) + (s.nFar ? 1 : 0), 0) }; }

  dispose() {
    for (const root of [...this.managed]) this.release(root);
    for (const s of this.sets.values()) { s.mid.dispose(); s.far.dispose(); }
    this.sets.clear();
    this.body.dispose();
    this.group.removeFromParent();
  }
}

/** visible all the way up and hanging in this scene */
function shownIn(o: THREE.Object3D, scene: THREE.Scene) {
  let x: THREE.Object3D | null = o;
  while (x) { if (!x.visible) return false; if (x === scene) return true; x = x.parent; }
  return false;
}
