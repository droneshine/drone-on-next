import * as THREE from 'three';

// The TRAIL cosmetic (GDD 3.3): soft dots left behind a fast drone, fading in about half a second.
// Its own small point buffer, so it never competes with spray and dust for the shared particle pool
// and keeps its colour on bright sky as well as on grass.

const N = 240;

export class Trail {
  readonly points: THREE.Points;
  private pos = new Float32Array(N * 3);
  private col = new Float32Array(N * 3);
  private age = new Float32Array(N).fill(99);
  private size = new Float32Array(N);
  private alpha = new Float32Array(N);
  private geo = new THREE.BufferGeometry();
  private next = 0;
  private live = 0;
  life = 0.55;

  constructor() {
    this.geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    this.geo.setAttribute('aCol', new THREE.BufferAttribute(this.col, 3).setUsage(THREE.DynamicDrawUsage));
    this.geo.setAttribute('aSize', new THREE.BufferAttribute(this.size, 1).setUsage(THREE.DynamicDrawUsage));
    this.geo.setAttribute('aAlpha', new THREE.BufferAttribute(this.alpha, 1).setUsage(THREE.DynamicDrawUsage));
    const mat = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false,
      uniforms: { uScale: { value: 600 } },
      vertexShader: `attribute vec3 aCol; attribute float aSize; attribute float aAlpha; varying vec3 vCol; varying float vA; uniform float uScale;
        void main(){ vCol = aCol; vA = aAlpha; vec4 mv = modelViewMatrix * vec4(position, 1.); gl_Position = projectionMatrix * mv;
          gl_PointSize = aSize * uScale / max(0.1, -mv.z); }`,
      fragmentShader: `varying vec3 vCol; varying float vA;
        void main(){ vec2 d = gl_PointCoord - 0.5; float r = dot(d, d) * 4.; if (r > 1.) discard; gl_FragColor = vec4(vCol, vA * (1. - r)); }`,
    });
    this.points = new THREE.Points(this.geo, mat);
    this.points.frustumCulled = false;
    this.points.userData.noThermal = true;
    this.points.visible = false;
  }

  emit(p: THREE.Vector3, color: THREE.Color, size: number) {
    const i = this.next; this.next = (this.next + 1) % N;
    this.pos[i * 3] = p.x; this.pos[i * 3 + 1] = p.y; this.pos[i * 3 + 2] = p.z;
    this.col[i * 3] = color.r; this.col[i * 3 + 1] = color.g; this.col[i * 3 + 2] = color.b;
    this.size[i] = size; this.age[i] = 0;
  }

  update(dt: number, camera: THREE.PerspectiveCamera) {
    let live = 0;
    for (let i = 0; i < N; i++) {
      if (this.age[i] >= this.life) { this.alpha[i] = 0; continue; }
      this.age[i] += dt;
      const k = 1 - this.age[i] / this.life;
      this.alpha[i] = Math.max(0, k) * 0.85;
      live++;
    }
    this.points.visible = live > 0 || this.live > 0;
    this.live = live;
    if (!this.points.visible) return;
    (this.points.material as THREE.ShaderMaterial).uniforms.uScale.value = innerHeight / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)));
    for (const k of ['position', 'aCol', 'aSize', 'aAlpha']) (this.geo.getAttribute(k) as THREE.BufferAttribute).needsUpdate = true;
  }

  clear() { this.age.fill(99); this.alpha.fill(0); }
}
