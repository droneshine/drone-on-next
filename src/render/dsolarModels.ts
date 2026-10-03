import * as THREE from 'three';
import { DroneSpec, motorLayout } from '../sim/spec';
import { DroneVisual, mats, cyl, bx, tube, addProps, ledPair, sparkleMesh } from './droneModels';

// DSolar family, rebuilt from the manufacturer drawings (Robotics\10 Research\20 HW stack).
// Units are metres, origin is the arm plane centre, forward is -z, ground is at -gear height.
//
// DSolar (MT50)       wheelbase 2330, frame 1950 x 1720, arm plane 454 above ground, total 706,
//                     props about 1320 (2968 span), gear 863 wide.
// DSolar Max (MT100)  wheelbase 2300, frame 1800 x 1800, props 1420 (3055 span), arm plane 888,
//                     total 950, gear 862 front and 941 side, lowest point 325 above ground.

function smoothTube(points: THREE.Vector3[], r: number, m: THREE.Material, seg = 48) {
  const curve = new THREE.CatmullRomCurve3(points, false, 'centripetal');
  return new THREE.Mesh(new THREE.TubeGeometry(curve, seg, r, 10, false), m);
}

/** Folding arm with clamp joints, ESC pod under the motor and a spray nozzle. */
function arm(v: DroneVisual, from: THREE.Vector3, to: THREE.Vector3, r: number, motorR: number, motorH: number, escLen: number) {
  const carbon = mats.carbon(), black = mats.black(), alu = new THREE.MeshStandardMaterial({ color: '#8d9296', metalness: 0.85, roughness: 0.35 });
  v.root.add(tube(from, to, r, carbon));
  const dir = to.clone().sub(from).normalize();
  const yaw = -Math.atan2(dir.z, dir.x);
  const len = from.distanceTo(to);
  // two folding joints, the inner one is the hinge block
  for (const [t, s] of [[0.14, 1.5], [0.46, 1.2]] as const) {
    const j = bx(r * 5 * s, r * 3.4, r * 3.4, black);
    j.position.copy(from).addScaledVector(dir, len * t); j.rotation.y = yaw;
    v.root.add(j);
    const pin = cyl(r * 0.8, r * 0.8, r * 4.2, alu, 10); pin.position.copy(j.position); v.root.add(pin);
  }
  // motor: stator can with cooling fins, mounted on a clamp
  const clamp = bx(motorR * 2.2, r * 2.6, motorR * 1.6, black); clamp.position.copy(to); clamp.rotation.y = yaw; v.root.add(clamp);
  const can = cyl(motorR, motorR * 0.94, motorH, mats.motor(), 28); can.position.set(to.x, to.y + r + motorH / 2, to.z); v.root.add(can);
  const fins = new THREE.Mesh(new THREE.CylinderGeometry(motorR * 1.03, motorR * 1.03, motorH * 0.45, 28, 1, true), new THREE.MeshStandardMaterial({ color: '#2b2e30', metalness: 0.7, roughness: 0.4, side: THREE.DoubleSide }));
  fins.position.set(to.x, to.y + r + motorH * 0.3, to.z); v.root.add(fins);
  // ESC pod hangs under the arm, inboard of the motor
  const esc = bx(escLen, motorR * 0.75, motorR * 0.95, black);
  esc.position.copy(to).addScaledVector(dir, -escLen * 0.65); esc.position.y -= r + motorR * 0.38; esc.rotation.y = yaw;
  v.root.add(esc);
  // cleaning nozzle under the motor, pointing at the glass
  const nozBody = cyl(0.018, 0.022, 0.1, mats.plastic('#c79b2c', 0.4)); nozBody.position.set(to.x, to.y - r - 0.06, to.z); v.root.add(nozBody);
  const nozTip = cyl(0.014, 0.012, 0.025, mats.plastic('#c43c1c', 0.5)); nozTip.position.set(to.x, to.y - r - 0.125, to.z); v.root.add(nozTip);
  v.nozzles.push({ pos: new THREE.Vector3(to.x, to.y - r - 0.14, to.z), dir: new THREE.Vector3(0, -1, 0) });
}

function canopy(v: DroneVisual, w: number, l: number, h: number, y: number) {
  // stepped, faceted shell like the real cover: base tray, main body, raised spine, two filler caps
  const green = mats.plastic('#1f5e2c', 0.3);
  const g = new THREE.Group();
  const base = bx(w, h * 0.38, l, green); base.position.y = h * 0.19; g.add(base);
  const mid = bx(w * 0.86, h * 0.34, l * 0.9, green); mid.position.y = h * 0.55; g.add(mid);
  const spine = bx(w * 0.56, h * 0.28, l * 0.62, green); spine.position.set(0, h * 0.86, l * 0.06); g.add(spine);
  // chamfered side panels
  for (const s of [-1, 1]) {
    const side = bx(w * 0.07, h * 0.62, l * 0.92, green);
    side.position.set(s * w * 0.47, h * 0.42, 0); side.rotation.z = s * 0.22; g.add(side);
  }
  const nose = bx(w * 0.8, h * 0.5, l * 0.08, green); nose.position.set(0, h * 0.35, -l * 0.5); nose.rotation.x = 0.35; g.add(nose);
  for (const x of [-w * 0.18, w * 0.18]) { const cap = cyl(w * 0.1, w * 0.1, h * 0.12, mats.black(), 18); cap.position.set(x, h * 1.02, -l * 0.12); g.add(cap); }
  g.position.y = y;
  v.root.add(g);
  const sp = sparkleMesh(Math.min(w, h) * 0.55, '#f7f7f2'); sp.position.set(0, y + h * 0.45, -l * 0.5 - h * 0.08); sp.rotation.x = -0.35; v.root.add(sp);
}

function tank(v: DroneVisual, w: number, d: number, h: number, top: number) {
  // rounded rectangular PE tank, translucent white with a visible fill line
  const geo = new THREE.BoxGeometry(w, h, d, 6, 6, 6);
  const p = geo.attributes.position as THREE.BufferAttribute;
  const rr = Math.min(w, d) * 0.22;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
    // pull corners in to round the edges
    const ax = Math.max(0, Math.abs(x) - (w / 2 - rr)), az = Math.max(0, Math.abs(z) - (d / 2 - rr));
    const k = Math.hypot(ax, az);
    if (k > rr) { const f = rr / k; p.setX(i, Math.sign(x) * (w / 2 - rr + ax * f)); p.setZ(i, Math.sign(z) * (d / 2 - rr + az * f)); }
    p.setY(i, y);
  }
  geo.computeVertexNormals();
  const t = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: '#efefe9', roughness: 0.55, metalness: 0 }));
  t.position.y = top - h / 2;
  v.root.add(t);
  const band = bx(w * 1.02, h * 0.05, d * 1.02, mats.black()); band.position.y = top - h * 0.15; v.root.add(band);
  const pump = bx(w * 0.42, h * 0.22, d * 0.42, mats.black()); pump.position.y = top - h - h * 0.1; v.root.add(pump);
  const hoseA = tube(new THREE.Vector3(0, top - h - h * 0.15, 0), new THREE.Vector3(w * 0.4, top - h * 0.9, 0), 0.012, mats.black()); v.root.add(hoseA);
}

// ------------------------------------------------------------------ DSolar (MT50)
export function buildDSolarMT50(spec: DroneSpec): DroneVisual {
  const v: DroneVisual = { root: new THREE.Group(), props: [], nozzles: [], fpvCam: new THREE.Vector3(0, -0.1, -0.56), leds: [] };
  const gear = 0.454;            // arm plane above ground
  const bodyW = 0.42, bodyL = 0.98;
  // long chassis: two aluminium side rails with the electronics deck on top
  const deck = bx(bodyW, 0.06, bodyL, mats.black()); v.root.add(deck);
  for (const s of [-1, 1]) { const rail = bx(0.035, 0.08, bodyL * 1.02, new THREE.MeshStandardMaterial({ color: '#8d9296', metalness: 0.85, roughness: 0.35 })); rail.position.set(s * bodyW / 2, -0.02, 0); v.root.add(rail); }
  canopy(v, bodyW * 0.96, bodyL * 0.86, 0.2, 0.03);
  // battery bay at the rear, two 18S packs side by side
  for (const s of [-1, 1]) { const b = bx(0.16, 0.16, 0.26, mats.plastic('#2a2d2b', 0.5)); b.position.set(s * 0.09, 0.1, bodyL * 0.36); v.root.add(b); }
  tank(v, 0.36, 0.48, 0.24, -0.04);
  // arms leave from the chassis corners, not the centre, like the real frame
  for (const m of motorLayout(spec)) {
    const from = new THREE.Vector3(Math.sign(m.x) * bodyW / 2, 0, Math.sign(m.z) * bodyL * 0.4);
    arm(v, from, new THREE.Vector3(m.x, 0, m.z), 0.024, 0.075, 0.07, 0.24);
  }
  addProps(v, spec, 0.13, 2, '#1a1a1a');
  // U gear: one continuous tube per side, 863 mm track
  const tubeM = mats.black();
  for (const s of [-1, 1]) {
    const x0 = s * 0.17, x1 = s * 0.4315, yb = -gear + 0.02;
    v.root.add(smoothTube([
      new THREE.Vector3(x0, -0.05, -0.3), new THREE.Vector3(s * 0.3, -0.25, -0.36), new THREE.Vector3(x1, yb + 0.06, -0.4),
      new THREE.Vector3(x1, yb, -0.3), new THREE.Vector3(x1, yb, 0.3),
      new THREE.Vector3(x1, yb + 0.06, 0.4), new THREE.Vector3(s * 0.3, -0.25, 0.36), new THREE.Vector3(x0, -0.05, 0.3),
    ], 0.016, tubeM));
    const foot = cyl(0.02, 0.02, 0.5, mats.foam(), 12); foot.rotation.x = Math.PI / 2; foot.position.set(x1, yb, 0); v.root.add(foot);
  }
  v.root.add(tube(new THREE.Vector3(-0.3, -0.25, 0.36), new THREE.Vector3(0.3, -0.25, 0.36), 0.011, tubeM));
  v.root.add(tube(new THREE.Vector3(-0.3, -0.25, -0.36), new THREE.Vector3(0.3, -0.25, -0.36), 0.011, tubeM));
  ledPair(v, spec);
  return v;
}

// ------------------------------------------------------------------ DSolar Max (MT100)
export function buildDSolarMT100(spec: DroneSpec): DroneVisual {
  const v: DroneVisual = { root: new THREE.Group(), props: [], nozzles: [], fpvCam: new THREE.Vector3(0, -0.12, -0.42), leds: [] };
  const gear = 0.8;               // arm plane: 950 total minus rotor and canopy height
  const bodyW = 0.4, bodyL = 0.5;
  const alu = new THREE.MeshStandardMaterial({ color: '#8d9296', metalness: 0.85, roughness: 0.35 });
  // square centre frame with stacked plates
  const plateTop = bx(bodyW, 0.03, bodyL, mats.carbon()); plateTop.position.y = 0.04; v.root.add(plateTop);
  const plateBot = bx(bodyW, 0.03, bodyL, mats.carbon()); plateBot.position.y = -0.05; v.root.add(plateBot);
  for (const x of [-1, 1]) for (const z of [-1, 1]) { const post = cyl(0.025, 0.025, 0.09, alu, 12); post.position.set(x * bodyW * 0.42, -0.005, z * bodyL * 0.42); v.root.add(post); }
  canopy(v, bodyW * 0.92, bodyL * 0.9, 0.12, 0.02);
  // the electronics box with cooling grille that shows in the front view
  const box = bx(0.22, 0.14, 0.2, mats.plastic('#2a2d2b', 0.5)); box.position.set(0, -0.13, -0.06); v.root.add(box);
  for (let i = 0; i < 7; i++) { const fin = bx(0.005, 0.1, 0.2, alu); fin.position.set(-0.09 + i * 0.03, -0.13, -0.06); v.root.add(fin); }
  // 100 L tank under the frame, lowest point 325 mm above ground
  tank(v, 0.5, 0.46, 0.3, -0.06);
  for (const m of motorLayout(spec)) {
    const dir = new THREE.Vector3(m.x, 0, m.z).normalize();
    arm(v, dir.clone().multiplyScalar(0.24), new THREE.Vector3(m.x, 0, m.z), 0.03, 0.105, 0.075, 0.3);
  }
  addProps(v, spec, 0.12, 2, '#1a1a1a');
  // four long legs, splayed to an 862 x 785 footprint, joined by U hoop skids (941 track)
  const black = mats.black();
  const yb = -gear + 0.025;
  for (const s of [-1, 1]) {
    for (const zs of [-1, 1]) {
      v.root.add(tube(new THREE.Vector3(s * 0.18, -0.06, zs * 0.2), new THREE.Vector3(s * 0.431, yb + 0.06, zs * 0.3925), 0.019, black));
    }
    v.root.add(smoothTube([
      new THREE.Vector3(s * 0.431, yb + 0.06, -0.3925), new THREE.Vector3(s * 0.47, yb + 0.03, -0.43), new THREE.Vector3(s * 0.4705, yb, -0.34),
      new THREE.Vector3(s * 0.4705, yb, 0.34), new THREE.Vector3(s * 0.47, yb + 0.03, 0.43), new THREE.Vector3(s * 0.431, yb + 0.06, 0.3925),
    ], 0.018, black));
    // knee brace
    v.root.add(tube(new THREE.Vector3(s * 0.32, -0.46, -0.3), new THREE.Vector3(s * 0.32, -0.46, 0.3), 0.012, black));
  }
  v.root.add(tube(new THREE.Vector3(-0.32, -0.46, 0.3), new THREE.Vector3(0.32, -0.46, 0.3), 0.012, black));
  // centre spray head below the pump, the lowest point of the aircraft
  const head = cyl(0.05, 0.035, 0.1, mats.plastic('#c79b2c', 0.4)); head.position.y = -0.425; v.root.add(head);
  v.nozzles.push({ pos: new THREE.Vector3(0, -0.48, 0), dir: new THREE.Vector3(0, -1, 0) });
  ledPair(v, spec);
  return v;
}
