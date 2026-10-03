import * as THREE from 'three';
import { DroneSpec, FlightMode, motorLayout } from './spec';
import { ColliderWorld, Contact } from '../world/colliders';

// Rigid body quadcopter model. Per motor thrust with spool lag, momentum theory
// power draw, battery sag, rotor drag, ground effect, and a real cascaded
// controller (rate PI, attitude P, velocity and position hold for GPS mode).

export interface Sticks { throttle: number; yaw: number; pitch: number; roll: number; } // throttle 0..1, others -1..1

const G = 9.81, RHO = 1.225;
const _v = new THREE.Vector3(), _v2 = new THREE.Vector3(), _v3 = new THREE.Vector3();
const _q = new THREE.Quaternion(), _q2 = new THREE.Quaternion();
const _m = new THREE.Matrix4();
const UP = new THREE.Vector3(0, 1, 0);

export interface Motor { x: number; y: number; z: number; dir: number; s: number; thrust: number; }

export class DroneSim {
  spec: DroneSpec;
  pos = new THREE.Vector3();
  vel = new THREE.Vector3();
  quat = new THREE.Quaternion();
  w = new THREE.Vector3();         // body rates rad/s
  motors: Motor[] = [];
  mode: FlightMode;
  armed = false;
  crashed = false;
  crashReason = '';
  onGround = true;
  wind = new THREE.Vector3();
  payload = 0;                     // kg extra (water)
  extraForce = new THREE.Vector3(); // world frame, e.g. hose
  // battery
  soc = 1; voltage = 0; current = 0; powerW = 0; energyWh = 0;
  // controller state
  private iRate = new THREE.Vector3();
  private holdPos = new THREE.Vector3();
  private holdAlt = 0;
  private holding = false;
  private altHolding = false;
  private yawHold = 0;
  inertia = new THREE.Vector3();
  radius: number;
  contactPts: { p: THREE.Vector3; r: number; prop: boolean }[] = [];
  lastImpact = 0;
  maxImpact = 0;
  // assists
  throttleCurveHover = true;
  sticks: Sticks = { throttle: 0, yaw: 0, pitch: 0, roll: 0 };
  agl = 0;
  impactListeners: ((speed: number, surface: string) => void)[] = [];
  private contact: Contact = { depth: 0, normal: new THREE.Vector3(), collider: null, surface: '' };

  constructor(spec: DroneSpec, private world: ColliderWorld) {
    this.spec = spec;
    this.mode = spec.defaultMode;
    this.motors = motorLayout(spec).map(m => ({ ...m, s: 0, thrust: 0 }));
    const m = spec.mass, L = spec.armLength;
    this.inertia.set(m * L * L * 0.25, m * L * L * 0.42, m * L * L * 0.25);
    this.radius = L + spec.propDiameter * 0.5;
    const pr = spec.propDiameter * 0.5;
    for (const mo of this.motors) this.contactPts.push({ p: new THREE.Vector3(mo.x, mo.y + 0.02, mo.z), r: Math.max(0.02, pr * 0.85), prop: true });
    const legH = this.legHeight();
    const legW = L * 0.45;
    for (const [x, z] of [[legW, legW], [-legW, legW], [legW, -legW], [-legW, -legW]]) this.contactPts.push({ p: new THREE.Vector3(x, -legH, z), r: 0.02 + L * 0.03, prop: false });
    this.contactPts.push({ p: new THREE.Vector3(0, 0, 0), r: L * 0.35, prop: false });
    this.voltage = this.cellOcv(1) * spec.battery.cells;
  }

  legHeight() {
    const s = this.spec;
    return s.model === 'racer' ? 0.012 : s.model === 'dsolar' ? 0.72 : s.model === 'dscan' ? 0.3 : s.model === 'cine' ? 0.335 : s.armLength * 0.6;
  }

  get totalMass() { return this.spec.mass + this.payload; }

  reset(pos: THREE.Vector3, yaw: number) {
    this.pos.copy(pos);
    this.pos.y += this.legHeight() + 0.03;
    this.vel.set(0, 0, 0); this.w.set(0, 0, 0);
    this.quat.setFromAxisAngle(UP, yaw);
    for (const m of this.motors) { m.s = 0; m.thrust = 0; }
    this.iRate.set(0, 0, 0);
    this.crashed = false; this.crashReason = '';
    this.armed = false; this.holding = false; this.altHolding = false;
    this.yawHold = yaw;
    this.soc = 1; this.energyWh = 0; this.maxImpact = 0;
    this.onGround = true;
  }

  heading() {
    _v.set(0, 0, -1).applyQuaternion(this.quat);
    return Math.atan2(-_v.x, -_v.z);
  }

  euler() { return new THREE.Euler().setFromQuaternion(this.quat, 'YXZ'); }

  private cellOcv(soc: number) {
    // LiPo open circuit voltage curve
    const s = Math.max(0, Math.min(1, soc));
    return 3.3 + 0.55 * s + 0.35 * Math.pow(s, 6) - 0.35 * Math.pow(1 - s, 10);
  }

  private hoverThrustFrac() {
    return (this.totalMass * G) / (this.motors.length * this.spec.maxThrust);
  }

  /** Main step, dt seconds. */
  step(dt: number, sticks: Sticks) {
    this.sticks = sticks;
    const spec = this.spec;
    const n = this.motors.length;
    const m = this.totalMass;
    const vFull = 4.2 * spec.battery.cells;
    const sag = Math.max(0.2, (this.voltage / vFull));
    const tMaxEff = spec.maxThrust * sag * sag * (this.soc < 0.03 ? Math.max(0, this.soc / 0.03) : 1);

    // arming: throttle up arms, crash disarms
    if (!this.armed && !this.crashed) {
      if (this.mode === 'gps' ? sticks.throttle > 0.7 : sticks.throttle > 0.08) {
        this.armed = true; this.holding = false; this.altHolding = false; this.yawHold = this.heading();
      }
    }

    // ground effect, height of rotor plane over terrain
    const groundH = this.world.heightAt(this.pos.x, this.pos.z);
    this.agl = this.pos.y - groundH - this.legHeight();
    const R = spec.propDiameter / 2;
    const zr = Math.max(this.pos.y - groundH, R * 0.6);
    const ge = Math.min(1.25, 1 / Math.max(0.8, 1 - (R / (4 * zr)) ** 2));

    // --- controller: produce desired collective (N) and body rate setpoint
    const qInv = _q.copy(this.quat).invert();
    const wDes = new THREE.Vector3();
    let collective = 0;
    const rc = spec.rates;
    const bfRate = (x: number) => {
      // Betaflight actual rate in deg/s
      const ax = Math.abs(x);
      const expoed = x * Math.pow(ax, 3) * rc.expo + x * (1 - rc.expo);
      const rate = 200 * rc.rcRate * expoed;
      return rate / (1 - Math.min(0.99, ax * rc.superRate));
    };

    if (this.mode === 'acro') {
      const D2R = Math.PI / 180;
      wDes.set(-bfRate(sticks.pitch) * D2R, -bfRate(sticks.yaw) * D2R, -bfRate(sticks.roll) * D2R);
      collective = this.throttleToThrust(sticks.throttle) * n * tMaxEff;
    } else {
      const maxTilt = spec.maxTilt * Math.PI / 180;
      const yaw = this.heading();
      let upDes = new THREE.Vector3();
      if (this.mode === 'angle') {
        // stick deflection is tilt angle in the heading frame
        const tp = sticks.pitch * maxTilt, tr = sticks.roll * maxTilt;
        const qd = new THREE.Quaternion().setFromEuler(new THREE.Euler(-tp, yaw, -tr, 'YXZ'));
        upDes.set(0, 1, 0).applyQuaternion(qd);
        collective = this.throttleToThrust(sticks.throttle) * n * tMaxEff;
        // keep altitude a little more stable when tilted, like real self level FCs do not: none
      } else {
        // GPS: velocity control in heading frame with position and altitude hold
        const fwd = new THREE.Vector3(-Math.sin(yaw), 0, -Math.cos(yaw));
        const right = new THREE.Vector3(Math.cos(yaw), 0, -Math.sin(yaw));
        const stickH = Math.hypot(sticks.pitch, sticks.roll);
        const vDes = new THREE.Vector3()
          .addScaledVector(fwd, sticks.pitch * spec.maxSpeed)
          .addScaledVector(right, sticks.roll * spec.maxSpeed);
        if (stickH < 0.04 && this.armed && !this.onGround) {
          if (!this.holding && Math.hypot(this.vel.x, this.vel.z) < 0.6) { this.holding = true; this.holdPos.copy(this.pos); }
          if (this.holding) {
            vDes.x = (this.holdPos.x - this.pos.x) * 1.2;
            vDes.z = (this.holdPos.z - this.pos.z) * 1.2;
          }
        } else this.holding = false;
        const tIn = (sticks.throttle - 0.5) * 2;
        let vzDes = Math.abs(tIn) > 0.06 ? tIn * spec.maxClimb * (tIn < 0 ? 0.8 : 1) : 0;
        if (Math.abs(tIn) <= 0.06 && this.armed) {
          if (!this.altHolding) { this.altHolding = true; this.holdAlt = this.pos.y; }
          vzDes = (this.holdAlt - this.pos.y) * 1.5;
        } else this.altHolding = false;
        // terrain safety, slow down descent close to ground
        if (vzDes < 0 && this.agl < 2) vzDes = Math.max(vzDes, -0.6 - this.agl * 0.4);
        // cascade: each outer loop must be slower than the one inside it
        const kRate = 1 / (2.2 * spec.motorTau + 0.01);
        const kAtt = Math.min(6, kRate * 0.42);
        const kv = Math.min(1.6, kAtt * 0.34);
        const aDes = new THREE.Vector3((vDes.x - this.vel.x) * kv, (vzDes - this.vel.y) * 2.5, (vDes.z - this.vel.z) * kv);
        const aH = Math.hypot(aDes.x, aDes.z), aHMax = Math.tan(maxTilt) * G;
        if (aH > aHMax) { aDes.x *= aHMax / aH; aDes.z *= aHMax / aH; }
        // wind feed forward is implicit through the integrator on velocity error
        const F = aDes.clone().add(new THREE.Vector3(0, G, 0)).multiplyScalar(m).sub(this.extraForce);
        F.y = Math.max(F.y, m * G * 0.15);
        upDes = F.clone().normalize();
        const bodyUp = _v.set(0, 1, 0).applyQuaternion(this.quat);
        collective = Math.max(0, F.length() * Math.max(0.3, bodyUp.dot(upDes)));
        if (!this.armed) collective = 0;
        // on the ground with throttle low, stay down and spool down
        if (this.onGround && sticks.throttle < 0.55 && this.vel.y <= 0.05) { collective = 0; if (sticks.throttle < 0.1) this.armed = false; }
      }
      // attitude: rotate current up to desired up, plus yaw rate
      const bodyUp = _v2.set(0, 1, 0).applyQuaternion(this.quat);
      const axis = _v3.crossVectors(bodyUp, upDes);
      const sinA = axis.length();
      const ang = Math.atan2(sinA, bodyUp.dot(upDes));
      if (sinA > 1e-6) axis.multiplyScalar(ang / sinA); else axis.set(0, 0, 0);
      axis.applyQuaternion(qInv); // body frame
      const ka = Math.min(this.mode === 'gps' ? 6 : 8, (1 / (2.2 * spec.motorTau + 0.01)) * 0.42);
      wDes.set(axis.x * ka, 0, axis.z * ka);
      wDes.y = -sticks.yaw * spec.maxYawRate * Math.PI / 180;
    }

    if (!this.armed || this.crashed) {
      collective = 0; wDes.set(0, 0, 0); this.iRate.set(0, 0, 0);
    }

    // --- rate controller PI -> torque
    const tau = spec.motorTau;
    const kp = 1 / (2.2 * tau + 0.01);
    const err = wDes.clone().sub(this.w);
    if (this.armed && !this.onGround) this.iRate.addScaledVector(err, dt * 4);
    this.iRate.clampLength(0, 3);
    const alpha = err.multiplyScalar(kp).addScaledVector(this.iRate, kp * 0.5);
    const I = this.inertia;
    const torque = new THREE.Vector3(alpha.x * I.x, alpha.y * I.y, alpha.z * I.z);

    // --- mixer with airmode style desaturation
    const kq = 0.06 * spec.propDiameter;
    let sx = 0, sz = 0;
    for (const mo of this.motors) { sx += mo.x * mo.x; sz += mo.z * mo.z; }
    const T0 = collective / n;
    const rp: number[] = [], yw: number[] = [];
    for (const mo of this.motors) {
      rp.push(-mo.z * torque.x / sz + mo.x * torque.z / sx);
      yw.push(-mo.dir * torque.y / (kq * n));
    }
    const lo = 0, hi = tMaxEff;
    const span = (a: number[]) => Math.max(...a) - Math.min(...a);
    let s1 = span(rp); if (s1 > hi - lo) { const k = (hi - lo) / s1; for (let i = 0; i < n; i++) rp[i] *= k; }
    const comb = rp.map((v, i) => v + yw[i]);
    let s2 = span(comb);
    if (s2 > hi - lo) {
      const room = (hi - lo) - span(rp);
      const sy = span(yw) || 1;
      const k = Math.max(0, room / sy);
      for (let i = 0; i < n; i++) comb[i] = rp[i] + yw[i] * Math.min(1, k);
    }
    const mn = Math.min(...comb), mx = Math.max(...comb);
    let base = T0;
    if (this.armed && !this.crashed && (collective > 0 || this.mode === 'acro')) {
      base = Math.min(Math.max(T0, lo - mn + (this.mode === 'acro' ? tMaxEff * 0.03 : 0)), hi - mx);
    }

    // --- motor dynamics, thrust ~ s^2
    let fz = 0; const bodyTorque = new THREE.Vector3();
    let powerW = 0;
    const A = Math.PI * R * R;
    const eta = 0.35 + 0.25 * Math.min(1, spec.propDiameter / 0.8);
    for (let i = 0; i < n; i++) {
      const mo = this.motors[i];
      const target = (this.armed && !this.crashed && (collective > 0 || this.mode === 'acro')) ? Math.min(hi, Math.max(lo, base + comb[i])) : 0;
      const sCmd = Math.sqrt(target / Math.max(1e-6, tMaxEff));
      mo.s += (sCmd - mo.s) * Math.min(1, dt / tau);
      const T = tMaxEff * mo.s * mo.s * ge;
      mo.thrust = T;
      fz += T;
      bodyTorque.x += -mo.z * T;
      bodyTorque.z += mo.x * T;
      bodyTorque.y += -mo.dir * kq * T;
      powerW += Math.pow(Math.max(T, 0), 1.5) / Math.sqrt(2 * RHO * A) / eta;
    }
    // coaxial losses
    if (spec.layout === 'coaxX8') powerW *= 1.18;

    // battery
    const cells = spec.battery.cells;
    const ocv = this.cellOcv(this.soc) * cells;
    const rInt = 0.004 * cells / spec.battery.capacityAh * 4;
    const avionics = 6 + spec.mass * 0.4;
    const P = powerW + avionics;
    // solve V = ocv - I R, P = V I
    const disc = ocv * ocv - 4 * rInt * P;
    const Icur = disc > 0 ? (ocv - Math.sqrt(disc)) / (2 * rInt) : ocv / (2 * rInt);
    this.current = Icur; this.voltage = ocv - Icur * rInt; this.powerW = P;
    this.soc = Math.max(0, this.soc - Icur * dt / 3600 / spec.battery.capacityAh);
    this.energyWh += P * dt / 3600;

    // --- forces in world frame
    const force = new THREE.Vector3(0, fz, 0).applyQuaternion(this.quat);
    force.y -= m * G;
    force.add(this.extraForce);
    // aero drag, body frame anisotropic
    const vRel = _v.copy(this.vel).sub(this.wind);
    const vb = vRel.clone().applyQuaternion(qInv);
    const cdA = spec.dragArea;
    const drag = new THREE.Vector3(
      -0.5 * RHO * cdA * Math.abs(vb.x) * vb.x,
      -0.5 * RHO * cdA * 2.6 * Math.abs(vb.y) * vb.y,
      -0.5 * RHO * cdA * Math.abs(vb.z) * vb.z,
    );
    // rotor H force, proportional to thrust and in plane airspeed
    const hk = 0.012;
    drag.x -= hk * fz * vb.x / Math.max(1, spec.propDiameter * 4);
    drag.z -= hk * fz * vb.z / Math.max(1, spec.propDiameter * 4);
    force.add(drag.applyQuaternion(this.quat));

    // --- angular dynamics in body frame
    const Iw = new THREE.Vector3(this.w.x * I.x, this.w.y * I.y, this.w.z * I.z);
    const gyro = new THREE.Vector3().crossVectors(this.w, Iw);
    const damp = this.w.clone().multiplyScalar(-0.02 * spec.mass * spec.armLength * spec.armLength);
    const angAcc = bodyTorque.sub(gyro).add(damp);
    angAcc.set(angAcc.x / I.x, angAcc.y / I.y, angAcc.z / I.z);

    this.vel.addScaledVector(force, dt / m);
    this.w.addScaledVector(angAcc, dt);
    this.pos.addScaledVector(this.vel, dt);
    // integrate quaternion: q += 0.5 * q * w * dt
    _q2.set(this.w.x * dt * 0.5, this.w.y * dt * 0.5, this.w.z * dt * 0.5, 0);
    const q = this.quat;
    const qw = _q2.multiplyQuaternions(q, _q2);
    q.set(q.x + qw.x, q.y + qw.y, q.z + qw.z, q.w + qw.w).normalize();

    this.collide(dt);
  }

  private throttleToThrust(t: number) {
    // returns fraction of max thrust per motor
    const c = Math.max(0, Math.min(1, t));
    if (!this.throttleCurveHover) return Math.max(0.0, c * c * 0.92 + c * 0.08);
    // curve where centre stick = hover, smooth at both ends
    const h = Math.min(0.9, this.hoverThrustFrac());
    if (c < 0.5) return h * Math.pow(c / 0.5, 1.6);
    return h + (1 - h) * Math.pow((c - 0.5) / 0.5, 1.4);
  }

  private collide(dt: number) {
    const ct = this.contact;
    const mat = _m.makeRotationFromQuaternion(this.quat);
    let grounded = false;
    let worstImpact = 0, worstSurface = '';
    const I = this.inertia;
    for (const cp of this.contactPts) {
      const rWorld = cp.p.clone().applyMatrix4(mat);
      const pw = rWorld.clone().add(this.pos);
      if (!this.world.query(pw, cp.r, ct)) continue;
      const nrm = ct.normal;
      // velocity of the contact point
      const wWorld = this.w.clone().applyQuaternion(this.quat);
      const vp = this.vel.clone().add(new THREE.Vector3().crossVectors(wWorld, rWorld));
      const vn = vp.dot(nrm);
      // positional correction
      this.pos.addScaledVector(nrm, ct.depth * 0.8);
      if (ct.surface === 'water') {
        this.vel.multiplyScalar(0.9); this.w.multiplyScalar(0.9);
        if (!this.crashed) this.crash('Splashdown');
        continue;
      }
      if (vn < 0) {
        const impact = -vn;
        if (impact > worstImpact) { worstImpact = impact; worstSurface = ct.surface; }
        const restitution = impact > 1.5 ? 0.25 : 0.0;
        // impulse magnitude with rotational term, inertia approximated in world as body diag
        const rxn = new THREE.Vector3().crossVectors(rWorld, nrm).applyQuaternion(_q.copy(this.quat).invert());
        const invI = new THREE.Vector3(rxn.x / I.x, rxn.y / I.y, rxn.z / I.z);
        const angTerm = rxn.dot(invI) * 0.6;
        const j = -(1 + restitution) * vn / (1 / this.totalMass + angTerm);
        const imp = nrm.clone().multiplyScalar(j);
        // friction
        const vt = vp.clone().addScaledVector(nrm, -vn);
        const vtl = vt.length();
        if (vtl > 1e-4) {
          const mu = ct.surface === 'ground' ? 0.7 : 0.4;
          const jt = Math.min(mu * j, vtl * this.totalMass);
          imp.addScaledVector(vt, -jt / vtl);
        }
        this.vel.addScaledVector(imp, 1 / this.totalMass);
        const angImp = new THREE.Vector3().crossVectors(rWorld, imp).applyQuaternion(_q.copy(this.quat).invert());
        this.w.x += angImp.x / I.x * 0.6; this.w.y += angImp.y / I.y * 0.6; this.w.z += angImp.z / I.z * 0.6;
        if (cp.prop && this.armed && !this.crashed) {
          const spin = this.motors.reduce((a, m) => a + m.s, 0) / this.motors.length;
          if (spin > 0.2 && impact > 2.2) this.crash('Prop strike');
        }
      }
      if (!cp.prop && nrm.y > 0.6) grounded = true;
    }
    this.onGround = grounded;
    if (grounded) {
      // rolling resistance and settling when idle on the ground
      if (!this.armed || this.motors.every(m => m.s < 0.15)) {
        this.vel.x *= 0.9; this.vel.z *= 0.9; this.w.multiplyScalar(0.85);
      }
    }
    if (worstImpact > 0.3) {
      this.lastImpact = worstImpact;
      this.maxImpact = Math.max(this.maxImpact, worstImpact);
      for (const l of this.impactListeners) l(worstImpact, worstSurface);
      const limit = this.spec.model === 'racer' ? 9 : this.spec.mass > 30 ? 2.6 : 3.6;
      if (worstImpact > limit && !this.crashed) this.crash(worstImpact > limit * 2 ? 'Hard impact' : 'Crash landing');
    }
    // keep us inside the world
    const B = 760;
    if (Math.abs(this.pos.x) > B || Math.abs(this.pos.z) > B) {
      this.pos.x = THREE.MathUtils.clamp(this.pos.x, -B, B);
      this.pos.z = THREE.MathUtils.clamp(this.pos.z, -B, B);
      this.vel.x *= -0.3; this.vel.z *= -0.3;
    }
    if (this.pos.y > 600) { this.pos.y = 600; this.vel.y = Math.min(this.vel.y, 0); }
    void dt;
  }

  crash(reason: string) {
    this.crashed = true; this.armed = false; this.crashReason = reason;
  }

  speed() { return this.vel.length(); }
}
