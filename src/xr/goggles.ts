import * as THREE from 'three';

// GOGGLES view: a dark room with a faint floor grid that stays put when the head turns (a calm rest
// frame for the inner ear), and a large screen locked to the head, like real FPV goggles. The screen
// shows the drone camera as a flat, mono picture, so the head never moves inside the drone.

/** screen size and distance: 52 degrees wide, about what a good pair of FPV goggles shows */
export const SCREEN = { dist: 2.0, width: 2 * 2.0 * Math.tan(THREE.MathUtils.degToRad(26)) };

export class Goggles {
  scene = new THREE.Scene();
  rig = new THREE.Group();
  /** head locked parts: screen, bezel, HUD slot. Hung under the XR camera while the view is on. */
  head = new THREE.Group();
  screenMat: THREE.ShaderMaterial;
  hudSlot = new THREE.Group();
  /** the floor grid; sits 1.6 m under the eyes when the headset gives no floor height */
  floor: THREE.Mesh;

  constructor() {
    this.scene.background = new THREE.Color('#010d08');
    this.scene.add(this.rig);
    this.scene.add(new THREE.HemisphereLight('#e8f5e0', '#0b2015', 1.6));
    const key = new THREE.DirectionalLight('#ffffff', 1.2); key.position.set(1, 3, 2); this.scene.add(key);

    // floor grid: world locked, fades out after a few metres
    const grid = this.floor = new THREE.Mesh(new THREE.PlaneGeometry(30, 30), new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, toneMapped: false,
      vertexShader: 'varying vec3 vW; void main(){ vec4 w = modelMatrix * vec4(position, 1.); vW = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }',
      fragmentShader: `varying vec3 vW;
        void main(){
          vec2 p = vW.xz;
          vec2 g = abs(fract(p - 0.5) - 0.5) / fwidth(p);
          float line = 1.0 - min(min(g.x, g.y), 1.0);
          float fade = 1.0 - smoothstep(1.5, 9.0, length(p));
          gl_FragColor = vec4(0.149, 0.761, 0.341, line * fade * 0.28);
        }`,
    }));
    grid.rotation.x = -Math.PI / 2;
    this.rig.add(grid);

    const w = SCREEN.width, h = w * 9 / 16;
    this.screenMat = new THREE.ShaderMaterial({
      uniforms: { tMap: { value: null }, uThermal: { value: 0 }, uTime: { value: 0 } },
      vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.); }',
      fragmentShader: `
        uniform sampler2D tMap; uniform float uThermal; uniform float uTime; varying vec2 vUv;
        float h(vec2 p){ return fract(sin(dot(p, vec2(12.9898, 78.233)) + uTime) * 43758.5453); }
        void main(){
          vec2 uv = vUv;
          // thermal sensor look: 640 class resolution, grain and a soft vignette
          if (uThermal > 0.5) uv = (floor(uv * vec2(640., 512.)) + 0.5) / vec2(640., 512.);
          vec3 c = texture2D(tMap, uv).rgb;
          // the sun can reach the half float limit: keep Infinity and NaN out of the tone curve
          if (any(isnan(c)) || any(isinf(c))) c = vec3(16.);
          gl_FragColor = vec4(min(c, vec3(16.)), 1.);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
          if (uThermal > 0.5) {
            gl_FragColor.rgb += (h(vUv * 800.) - 0.5) * 0.06;
            gl_FragColor.rgb *= mix(0.75, 1.0, smoothstep(1.1, 0.35, length(vUv - 0.5)));
          }
        }`,
    });
    const screen = new THREE.Mesh(new THREE.PlaneGeometry(w, h), this.screenMat);
    screen.position.z = -SCREEN.dist;
    screen.name = 'xr-screen';
    const bezel = new THREE.Mesh(new THREE.PlaneGeometry(w + 0.05, h + 0.05), new THREE.MeshBasicMaterial({ color: '#0d2e20', toneMapped: false }));
    bezel.position.z = -SCREEN.dist - 0.01;
    this.head.add(bezel, screen);
    // the HUD panel hangs just under the screen, tilted towards the eyes
    this.hudSlot.position.set(0, -h / 2 - 0.3, -SCREEN.dist + 0.15);
    this.hudSlot.rotation.x = 0.22;
    this.head.add(this.hudSlot);
    this.head.traverse(o => (o.userData.noThermal = true));
  }
}
