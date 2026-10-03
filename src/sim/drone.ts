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
const DOWN = new THREE.Vector3(0, -1, 0);

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
  private vFilt = 0;
  // controller state
  private iRate = new THREE.Vector3();
  private holdPos = new THREE.Vector3();
  private holdAlt = 0;
  private holding = false;
  private altHolding = false;
  /** a stick must be seen low once before the motors may arm, like a real flight controller */
  private armReady = false;
  private lowThrottleT = 0;
  inertia = new THREE.Vector3();
  radius: number;
  contactPts: { p: THREE.Vector3; r: number; prop: boolean }[] = [];
  lastImpact = 0;
  maxImpact = 0;
  // assists
  throttleCurveHover = true;
  sticks: Sticks = { throttle: 0, yaw: 0, pitch: 0, roll: 0 };
  /** height of the landing gear above whatever surface is below: terrain, roof or platform */
  agl = 0;
  private surfaceY = 0;
  private surfaceAge = 1;
  autoLanding = false;
  private landT = 0;
  private satT = 0;
  impactListeners: ((speed: number, surface: string) => void)[] = [];
  /** contact with another pilot's drone: their id and our velocity along the contact normal */
  bumpListeners: ((peerId: string, normal: THREE.Vector3, speed: number) => void)[] = [];
  private contact: Contact = { depth: 0, normal: new THREE.Vector3(), collider: null, surface: '' };

  constructor(spec: DroneSpec, private world: ColliderWorld) {
    this.spec = spec;
    this.mode = spec.defaultMode;
    this.motors = motorLayout(spec).map(m => ({ ...m, s: 0, thrust: 0 }));
    const m = spec.mass, L = spec.armLength;
    this.inertia.set(m * L * L * 0.25, m * L * L * 0.42, m * L * L * 0.25);
    this.radius = L + spec.propDiameter * 0.5;
    const pr = spec.propDiameter * 0.5;
    const legH = this.legHeight();
    const footR = Math.min(0.02 + L * 0.03, legH * 0.5 + 0.01);
    // feet: sphere bottoms sit exactly at the skid line, so the drone rests on its gear, not above it
    const legW = L * 0.45;
    for (const [x, z] of [[legW, legW], [-legW, legW], [legW, -legW], [-legW, -legW]]) this.contactPts.push({ p: new THREE.Vector3(x, -legH + footR, z), r: footR, prop: false });
    // props: never reach below the feet, otherwise a parked drone stands on its rotors
    for (const mo of this.motors) {
      const py = mo.y + 0.02;
      const r = Math.max(0.015, Math.min(pr * 0.85, py + legH - 0.01));
      this.contactPts.push({ p: new THREE.Vector3(mo.x, py, mo.z), r, prop: true });
    }
    this.contactPts.push({ p: new THREE.Vector3(0, 0, 0), r: Math.min(L * 0.35, legH * 0.9 + 0.02), prop: false });
    this.voltage = this.vFilt = this.cellOcv(1) * spec.battery.cells;
  }

  legHeight() {
    const s = this.spec;
    return s.model === 'racer' ? 0.012 : s.model === 'dsolar' ? 0.454 : s.model === 'dsolarmax' ? 0.8 : s.model === 'dscan' ? 0.3 : s.model === 'cine' ? 0.335 : s.armLength * 0.6;
  }

  get totalMass() { return this.spec.mass + this.payload; }

  reset(pos: THREE.Vector3, yaw: number) {
    this.pos.copy(pos);
    this.pos.y += this.legHeight() + 0.004;
    this.vel.set(0, 0, 0); this.w.set(0, 0, 0);
    this.quat.setFromAxisAngle(UP, yaw);
    for (const m of this.motors) { m.s = 0; m.thrust = 0; }
    this.iRate.set(0, 0, 0);
    this.crashed = false; this.crashReason = '';
    this.armed = false; this.holding = false; this.altHolding = false;
    this.armReady = false; this.lowThrottleT = 0; this.autoLanding = false; this.landT = 0; this.satT = 0;
    this.soc = 1; this.energyWh = 0; this.maxImpact = 0;
    this.voltage = this.vFilt = this.cellOcv(1) * this.spec.battery.cells;
    this.onGround = true;
    this.surfaceAge = 1;
  }

  /** A new mode or controller never inherits an old low stick: arming needs a fresh one. */
  setMode(m: FlightMode) {
    if (m === this.mode) return;
    this.mode = m;
    if (!this.armed) this.armReady = false;
    this.holding = false; this.altHolding = false;
  }
  requireLowThrottle() { if (!this.armed) this.armReady = false; }

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

  /** Main step, dt seconds. */
  step(dt: number, sticks: Sticks) {
    this.sticks = sticks;
    const spec = this.spec;
    const n = this.motors.length;
    const m = this.totalMass;
    const vFull = 4.2 * spec.battery.cells;
    const sag = Math.max(0.2, (this.vFilt / vFull));
    const tMaxEff = spec.maxThrust * sag * sag * (this.soc < 0.03 ? Math.max(0, this.soc / 0.03) : 1);

    // arming: needs a low stick first, then throttle up arms. Crash disarms.
    const lowGate = this.mode === 'gps' ? 0.56 : 0.08;
    if (sticks.throttle <= lowGate) this.armReady = true;
    if (!this.armed && !this.crashed && this.armReady) {
      if (this.mode === 'gps' ? sticks.throttle > 0.7 : sticks.throttle > 0.1) {
        this.armed = true; this.holding = false; this.altHolding = false;
      }
    }

    // surface below: terrain, roofs and build pieces, refreshed at 20 Hz
    this.surfaceAge += dt;
    if (this.surfaceAge > 0.05) {
      this.surfaceAge = 0;
      const from = _v.copy(this.pos);
      const hit = this.world.raycast(from, DOWN, 80, c => c.tag !== 'player' && c.tag !== 'tree');
      this.surfaceY = isFinite(hit.t) ? this.pos.y - hit.t : this.world.heightAt(this.pos.x, this.pos.z);
    }
    this.agl = this.pos.y - this.surfaceY - this.legHeight();
    const R = spec.propDiameter / 2;
    const zr = Math.max(this.pos.y - this.surfaceY, R * 0.6);
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
    const kRate = 1 / (2.2 * spec.motorTau + 0.01);

    if (this.mode === 'acro') {
      const D2R = Math.PI / 180;
      wDes.set(-bfRate(sticks.pitch) * D2R, -bfRate(sticks.yaw) * D2R, -bfRate(sticks.roll) * D2R);
      collective = this.throttleToThrust(sticks.throttle, tMaxEff) * n * tMaxEff;
    } else {
      const maxTilt = spec.maxTilt * Math.PI / 180;
      const yaw = this.heading();
      let upDes = new THREE.Vector3();
      if (this.mode === 'angle') {
        // stick deflection is tilt angle in the heading frame
        const tp = sticks.pitch * maxTilt, tr = sticks.roll * maxTilt;
        const qd = new THREE.Quaternion().setFromEuler(new THREE.Euler(-tp, yaw, -tr, 'YXZ'));
        upDes.set(0, 1, 0).applyQuaternion(qd);
        collective = this.throttleToThrust(sticks.throttle, tMaxEff) * n * tMaxEff;
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
        if (Math.abs(tIn) <= 0.06 && this.armed && !this.autoLanding) {
          // capture the height where the drone will actually stop, not where the stick was released
          if (!this.altHolding) {
            // hold where the drone can actually stop: braking distance from the current climb or sink rate
            const vy = this.vel.y;
            const aStop = vy > 0 ? 0.55 * G : Math.max(2, ((n * tMaxEff) / (m * G) - 1) * G * 0.6);
            this.altHolding = true;
            this.holdAlt = this.pos.y + Math.sign(vy) * Math.min(25, (vy * vy) / (2 * aStop));
          }
          vzDes = (this.holdAlt - this.pos.y) * 1.5;
        } else this.altHolding = false;
        // nearly empty battery: GPS drones land themselves, like real ones do
        // or earlier, when a sagging pack can no longer carry the weight with margin
        if (this.armed && !this.autoLanding && (this.soc < 0.05 || this.satT > 1.2 || ((m * G - this.extraForce.y) / (n * tMaxEff) > 0.86 && this.soc < 0.4))) this.autoLanding = true;
        if (this.autoLanding) vzDes = Math.min(vzDes, -1.2);
        // descent limited by what the motors can brake, then a slow final approach over any surface
        if (vzDes < 0) {
          const twEff = (n * tMaxEff) / (m * G);
          const aBrake = Math.max(1, (twEff - 1) * G * 0.45);
          const vSafe = Math.sqrt(2 * aBrake * Math.max(0, this.agl - 1.2)) + 0.5;
          vzDes = Math.max(vzDes, -vSafe);
          if (this.agl < 1.5) vzDes = Math.max(vzDes, -0.45 - this.agl * 0.35);
        }
        // cascade: each outer loop must be slower than the one inside it
        const kAtt = Math.min(6, kRate * 0.42);
        const kv = Math.min(1.6, kAtt * 0.34);
        const aDes = new THREE.Vector3((vDes.x - this.vel.x) * kv, (vzDes - this.vel.y) * 2.5, (vDes.z - this.vel.z) * kv);
        aDes.y = Math.max(aDes.y, -0.6 * G);
        const F = aDes.clone().add(new THREE.Vector3(0, G, 0)).multiplyScalar(m).sub(this.extraForce);
        F.y = Math.max(F.y, m * G * 0.3);
        // tilt limit applied to the final thrust vector, so wind and climbs never exceed maxTilt
        const fH = Math.hypot(F.x, F.z), fHMax = Math.tan(maxTilt) * F.y;
        if (fH > fHMax) { F.x *= fHMax / fH; F.z *= fHMax / fH; }
        upDes = F.clone().normalize();
        const bodyUp = _v.set(0, 1, 0).applyQuaternion(this.quat);
        collective = Math.max(0, F.length() * Math.max(0.3, bodyUp.dot(upDes)));
        if (!this.armed) collective = 0;
        if (this.armed && collective > 0.96 * n * tMaxEff) this.satT += dt; else this.satT = Math.max(0, this.satT - dt);
        // touchdown: ground effect can float a heavy drone a few cm over the pad, so low and still counts as landed
        if (this.armed && (sticks.throttle < 0.35 || this.autoLanding) && this.agl < 0.12 && Math.abs(this.vel.y) < 0.25) {
          this.landT += dt;
          if (this.landT > 0.6) { this.armed = false; collective = 0; }
        } else this.landT = 0;
        // on the ground with throttle low, stay down, spool down and disarm
        if (this.onGround && (sticks.throttle < 0.55 || this.autoLanding) && this.vel.y <= 0.05) {
          collective = 0;
          if (sticks.throttle < 0.1 || this.autoLanding) this.armed = false;
        }
      }
      // attitude: rotate current up to desired up, plus yaw rate
      const bodyUp = _v2.set(0, 1, 0).applyQuaternion(this.quat);
      const axis = _v3.crossVectors(bodyUp, upDes);
      const sinA = axis.length();
      const ang = Math.atan2(sinA, bodyUp.dot(upDes));
      if (sinA > 1e-6) axis.multiplyScalar(ang / sinA); else axis.set(0, 0, 0);
      axis.applyQuaternion(qInv); // body frame
      const ka = Math.min(this.mode === 'gps' ? 6 : 8, kRate * 0.42);
      wDes.set(axis.x * ka, 0, axis.z * ka);
      wDes.y = -sticks.yaw * spec.maxYawRate * Math.PI / 180;
    }

    // angle and acro: throttle at zero on the ground for a moment disarms
    if (this.mode !== 'gps' && this.armed && this.onGround && sticks.throttle < 0.05) {
      this.lowThrottleT += dt;
      if (this.lowThrottleT > 0.8) this.armed = false;
    } else this.lowThrottleT = 0;

    if (!this.armed || this.crashed) {
      collective = 0; wDes.set(0, 0, 0); this.iRate.set(0, 0, 0);
    }

    // --- rate controller PI -> torque
    const tau = spec.motorTau;
    const err = wDes.clone().sub(this.w);
    const alpha = err.clone().multiplyScalar(kRate).addScaledVector(this.iRate, kRate * 0.5);
    // yaw on big props is slow by nature: a gentler loop avoids saturating the motors
    alpha.y = err.y * kRate * 0.6 + this.iRate.y * kRate * 0.3;
    const I = this.inertia;
    const torque = new THREE.Vector3(alpha.x * I.x, alpha.y * I.y, alpha.z * I.z);

    // --- mixer. Priority: roll and pitch, then collective (altitude), then yaw.
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
    let saturated = false;
    const rpMax = Math.max(...rp), rpMin = Math.min(...rp);
    if (rpMax - rpMin > hi - lo) { const k = (hi - lo) / (rpMax - rpMin); for (let i = 0; i < n; i++) rp[i] *= k; saturated = true; }
    const active = this.armed && !this.crashed && (collective > 0 || this.mode === 'acro');
    let base = T0;
    if (active) {
      const idle = this.mode === 'acro' ? tMaxEff * 0.03 : 0;
      base = Math.min(Math.max(T0, lo + idle - Math.min(...rp)), hi - Math.max(...rp));
    }
    // yaw only gets the headroom left around the collective
    let kYaw = 1;
    for (let i = 0; i < n; i++) {
      const v = base + rp[i];
      if (yw[i] > 0) kYaw = Math.min(kYaw, (hi - v) / yw[i]);
      else if (yw[i] < 0) kYaw = Math.min(kYaw, (lo - v) / yw[i]);
    }
    kYaw = Math.max(0, Math.min(1, kYaw));
    if (kYaw < 1) saturated = true;
    // integrate only while the motors can still follow, so nothing winds up and overshoots
    if (this.armed && !this.onGround && !saturated) this.iRate.addScaledVector(err, dt * 4);
    this.iRate.clampLength(0, 2);

    // --- motor dynamics, thrust ~ s^2
    let fz = 0; const bodyTorque = new THREE.Vector3();
    let powerW = 0;
    const A = Math.PI * R * R;
    const eta = 0.35 + 0.3 * Math.min(1, spec.propDiameter / 1.0);
    for (let i = 0; i < n; i++) {
      const mo = this.motors[i];
      const target = active ? Math.min(hi, Math.max(lo, base + rp[i] + yw[i] * kYaw)) : 0;
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

    // battery: internal resistance scales with pack size, voltage smoothed like a real pack responds
    const cells = spec.battery.cells;
    const ocv = this.cellOcv(this.soc) * cells;
    const rInt = 0.0032 * cells / Math.pow(Math.max(0.3, spec.battery.capacityAh), 0.85);
    const avionics = 6 + spec.mass * 0.4;
    const P = powerW + avionics;
    const disc = ocv * ocv - 4 * rInt * P;
    const Icur = disc > 0 ? (ocv - Math.sqrt(disc)) / (2 * rInt) : ocv / (2 * rInt);
    this.current = Icur;
    const vInst = Math.max(ocv * 0.5, ocv - Icur * rInt);
    this.vFilt += (vInst - this.vFilt) * Math.min(1, dt / 0.08);
    this.voltage = this.vFilt; this.powerW = P;
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

  /** stick to thrust fraction per motor; with the hover curve, centre stick is exactly hover */
  private throttleToThrust(t: number, tMaxEff: number) {
    const c = Math.max(0, Math.min(1, t));
    if (!this.throttleCurveHover) return Math.max(0.0, c * c * 0.92 + c * 0.08);
    // centre stick hovers with everything that pulls the drone down, the hose included
    const h = Math.min(0.9, (this.totalMass * G - Math.min(0, this.extraForce.y)) / (this.motors.length * Math.max(1e-6, tMaxEff)));
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
      // a turning rotor blade is never survivable
      if (ct.collider?.tag === 'blade' && !this.crashed && (this.armed || !this.onGround)) this.crash('Blade strike');
      if (ct.collider?.tag === 'player') for (const l of this.bumpListeners) l(String(ct.collider.data), nrm.clone(), -vn);
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
      const limit = this.spec.model === 'racer' ? 9 : this.totalMass > 30 ? 2.6 : 3.6;
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
