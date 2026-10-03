import * as THREE from 'three';
import { WORLD } from './terrain';

// GPU grass: a fixed pool of blades that wraps around the camera on a grid, so
// the field is dense wherever you fly low. Heights come from the terrain map,
// work zones and the lake are masked out in the shader.

export function buildGrass(heightTex: THREE.Texture, count = 90000, radius = 70) {
  const blade = new THREE.BufferGeometry();
  // 5 vertex tapered blade
  const pos = new Float32Array([-0.05, 0, 0, 0.05, 0, 0, -0.035, 0.45, 0, 0.035, 0.45, 0, 0, 0.9, 0]);
  blade.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  blade.setIndex([0, 1, 2, 2, 1, 3, 2, 3, 4]);
  const geo = new THREE.InstancedBufferGeometry();
  geo.index = blade.index; geo.attributes.position = blade.attributes.position;
  const offs = new Float32Array(count * 4);
  for (let i = 0; i < count; i++) {
    offs[i * 4] = (Math.random() * 2 - 1) * radius;
    offs[i * 4 + 1] = (Math.random() * 2 - 1) * radius;
    offs[i * 4 + 2] = Math.random() * Math.PI * 2;
    offs[i * 4 + 3] = 0.5 + Math.random() * 0.9;
  }
  geo.setAttribute('aOff', new THREE.InstancedBufferAttribute(offs, 4));
  geo.instanceCount = count;
  const uniforms = {
    uCam: { value: new THREE.Vector3() }, uTime: { value: 0 }, uH: { value: heightTex }, uWorld: { value: WORLD }, uR: { value: radius },
    uSun: { value: new THREE.Vector3(0.5, 0.8, 0.3) }, uWind: { value: new THREE.Vector2(1, 0) }, uRotor: { value: new THREE.Vector4(0, -999, 0, 0) },
    fogColor: { value: new THREE.Color() }, fogNear: { value: 1 }, fogFar: { value: 1000 }, fogDensity: { value: 0.0008 },
  };
  const mat = new THREE.ShaderMaterial({
    uniforms, side: THREE.DoubleSide, fog: true,
    vertexShader: `
      #include <common>
      #include <fog_pars_vertex>
      uniform vec3 uCam; uniform float uTime; uniform sampler2D uH; uniform float uWorld; uniform float uR;
      uniform vec2 uWind; uniform vec4 uRotor;
      attribute vec4 aOff;
      varying float vY; varying float vShade; varying float vFade;
      float zone(vec2 p, vec2 c, vec2 r){ vec2 d = abs(p - c) / r; return step(max(d.x, d.y), 1.0); }
      void main(){
        // wrap blade around camera
        vec2 span = vec2(uR * 2.0);
        vec2 wp = aOff.xy + uCam.xz;
        wp = uCam.xz + mod(aOff.xy - uCam.xz + uR, span) - uR;
        vec2 huv = wp / uWorld + 0.5;
        float gy = texture2D(uH, huv).r;
        float s = aOff.w;
        // masks: base apron, rows, roads, lake
        float mask = 1.0;
        mask *= 1.0 - zone(wp, vec2(0., 4.), vec2(30., 22.));
        mask *= 1.0 - step(abs(wp.y), 4.5) * step(abs(wp.x), 300.);
        mask *= step(-1.0, gy);
        vec3 p = position * vec3(1.0, s, 1.0);
        float c = cos(aOff.z), sn = sin(aOff.z);
        p = vec3(p.x * c, p.y, p.x * sn);
        // wind and rotor wash bend the tip
        float tip = position.y / 0.9;
        float gust = sin(uTime * 2.1 + wp.x * 0.35 + wp.y * 0.2) * 0.5 + 0.5;
        vec2 bend = uWind * (0.12 + 0.18 * gust) * tip * tip;
        vec2 toR = wp - uRotor.xy; float dr = length(toR);
        float wash = uRotor.w * smoothstep(uRotor.z, 0.0, dr);
        bend += normalize(toR + 1e-4) * wash * tip * 0.9;
        p.xz += bend; p.y -= length(bend) * 0.4 * tip;
        vec3 world = vec3(wp.x, gy - 0.05, wp.y) + p * mask;
        float d = length(wp - uCam.xz);
        vFade = 1.0 - smoothstep(uR * 0.7, uR, d);
        world.y -= (1.0 - vFade) * 1.0;
        vY = tip; vShade = fract(sin(dot(aOff.xy, vec2(12.9898,78.233))) * 43758.5);
        vec4 mvPosition = viewMatrix * vec4(world, 1.0);
        gl_Position = projectionMatrix * mvPosition;
        #include <fog_vertex>
      }`,
    fragmentShader: `
      #include <common>
      #include <fog_pars_fragment>
      uniform vec3 uSun;
      varying float vY; varying float vShade; varying float vFade;
      void main(){
        vec3 base = mix(vec3(0.16, 0.27, 0.09), vec3(0.36, 0.52, 0.19), vY);
        base = mix(base, vec3(0.45, 0.48, 0.22), vShade * 0.35 * vY);
        float light = 0.55 + 0.6 * clamp(uSun.y, 0., 1.);
        gl_FragColor = vec4(base * light, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
        #include <fog_fragment>
      }`,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.frustumCulled = false;
  mesh.userData.noThermal = true;
  return { mesh, uniforms };
}
