// Page side autopilot for the Spielwiese QA rig (tools/spielwiese-qa.mjs).
// It flies the Academy drills through the same input path as a finger on the on screen sticks:
// it only writes game.input.touch (and taps the FIRE button), never the sim.
(() => {
  const g = window.droneon.game;
  const ui = window.droneon.ui;
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const wrap = a => { while (a > Math.PI) a -= 2 * Math.PI; while (a < -Math.PI) a += 2 * Math.PI; return a; };
  // undo the touch stick shaping (deadband 0.06, expo 0.2) so a command means what it says
  const unshape = u => {
    const a = Math.min(1, Math.abs(u));
    if (a < 1e-4) return 0;
    let n = a;
    for (let i = 0; i < 6; i++) n -= (n * 0.8 + n * n * n * 0.2 - a) / (0.8 + 0.6 * n * n);
    return Math.sign(u) * clamp(0.06 + 0.94 * n, 0, 1);
  };
  const set = (thr, yaw, pitch, roll) => {
    const t = g.input.touch;
    g.input.device = 'touch';
    t.left.y = clamp(thr, 0, 1) * 2 - 1; t.left.x = unshape(clamp(yaw, -1, 1));
    t.right.y = unshape(clamp(pitch, -1, 1)); t.right.x = unshape(clamp(roll, -1, 1));
  };
  const frame = (s) => { const h = s.heading(); return { h, f: { x: -Math.sin(h), z: -Math.cos(h) }, r: { x: Math.cos(h), z: -Math.sin(h) } }; };
  const bearing = (s, x, z) => Math.atan2(-(x - s.pos.x), -(z - s.pos.z));

  let hook = null;
  let state = {};
  g.on('frame', dt => { if (hook) { try { hook(Number(dt) || 0.016); } catch (e) { console.error('autopilot', e); hook = null; } } });

  /** GPS: fly toward (x, y, z) at up to `v` m/s, turning the nose to it */
  function gpsTo(x, y, z, v, opts = {}) {
    const s = g.sim, sp = s.spec, fr = frame(s);
    const dx = x - s.pos.x, dz = z - s.pos.z, dist = Math.hypot(dx, dz);
    const e = wrap(bearing(s, x, z) - fr.h);
    const yaw = dist > 1.5 ? clamp(-e * 2.2, -1, 1) : 0;
    const want = Math.min(v, dist * (opts.k ?? 1.0)) * (Math.abs(e) > 1.2 && !opts.strafe ? 0.25 : 1);
    const vx = dist > 0.01 ? dx / dist * want : 0, vz = dist > 0.01 ? dz / dist * want : 0;
    const pitch = (vx * fr.f.x + vz * fr.f.z) / sp.maxSpeed, roll = (vx * fr.r.x + vz * fr.r.z) / sp.maxSpeed;
    const vzDes = clamp((y - s.pos.y) * 1.4, -sp.maxClimb * 0.8, sp.maxClimb);
    const thr = Math.abs(y - s.pos.y) < 0.25 ? 0.5 : 0.5 + vzDes / sp.maxClimb / 2 * (vzDes < 0 ? 1.25 : 1);
    set(thr, opts.yaw ?? yaw, pitch, roll);
    return dist;
  }

  /** Angle: hold a velocity vector and a height with tilt and throttle, wind handled by an integral */
  function angleVel(vx, vy, vz, dt, yawCmd = 0) {
    const s = g.sim, sp = s.spec, fr = frame(s);
    const I = state.I ??= { x: 0, z: 0, y: 0 };
    const ax = (vx - s.vel.x) * 2.2, az = (vz - s.vel.z) * 2.2;
    I.x = clamp(I.x + (vx - s.vel.x) * dt * 0.8, -3, 3); I.z = clamp(I.z + (vz - s.vel.z) * dt * 0.8, -3, 3);
    const af = (ax + I.x) * fr.f.x + (az + I.z) * fr.f.z, ar = (ax + I.x) * fr.r.x + (az + I.z) * fr.r.z;
    const maxT = sp.maxTilt * Math.PI / 180;
    const tp = Math.atan2(af, 9.81), tr = Math.atan2(ar, 9.81);
    const tilt = Math.min(maxT, Math.hypot(tp, tr));
    I.y = clamp(I.y + (vy - s.vel.y) * dt * 0.15, -0.2, 0.2);
    // centre stick hovers when level: lean further, push more
    const thr = clamp(0.5 + (vy - s.vel.y) * 0.09 + I.y + (1 / Math.cos(tilt) - 1) * 0.55, 0.12, 0.95);
    set(thr, yawCmd, clamp(tp / maxT, -1, 1), clamp(tr / maxT, -1, 1));
  }

  const drills = {
    'hover-lock': () => {
      const c = g.world.pads[1].clone(); c.y += 4;
      state = { t: 0 };
      return dt => {
        const s = g.sim; state.t += dt;
        if (!s.armed) { set(state.t < 0.5 ? 0 : 0.7, 0, 0, 0); return; }
        const vx = clamp((c.x - s.pos.x) * 1.1, -2.5, 2.5), vz = clamp((c.z - s.pos.z) * 1.1, -2.5, 2.5);
        const vy = clamp((c.y - s.pos.y) * 1.3, -2, 2.5);
        angleVel(vx, vy, vz, dt);
      };
    },
    'ring-sprint': () => {
      state = { t: 0, phase: 'arm' };
      return dt => {
        const s = g.sim; state.t += dt;
        const m = g.mission; if (!m) return;
        const ANGLE = window.__apAngle === true;
        if (state.phase === 'arm') {
          if (ANGLE && s.mode !== 'angle') { state.mt = (state.mt ?? 0) - dt; if (state.mt <= 0) { state.mt = 0.5; setTimeout(() => document.querySelector('[data-t=mode]').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 9 })), 0); } set(0, 0, 0, 0); return; }
          if (!s.armed) { set(state.t < 0.6 ? (ANGLE ? 0 : 0.5) : (ANGLE ? 0.75 : 0.9), 0, 0, 0); return; }
          state.phase = 'fly';
        }
        const pr = m.probe();
        const r = pr.rings[pr.idx];
        if (!r) { angleVel(0, 0, 0, dt); return; }
        // aim a little before the ring along its axis, then through it
        const n = { x: Math.sin(r.yaw), z: Math.cos(r.yaw) };
        const side = Math.sign((s.pos.x - r.x) * n.x + (s.pos.z - r.z) * n.z) || 1;
        const along = Math.abs((s.pos.x - r.x) * n.x + (s.pos.z - r.z) * n.z);
        // line up on the ring axis first, then go through it
        const lat = Math.abs((s.pos.x - r.x) * n.z - (s.pos.z - r.z) * n.x);
        const pre = along > 9 ? 9 : lat > 1.1 ? Math.max(1.5, along) : -4;
        const tx = r.x + n.x * side * pre, tz = r.z + n.z * side * pre;
        const dx = tx - s.pos.x, dz = tz - s.pos.z, dist = Math.hypot(dx, dz);
        const ringDist = Math.hypot(r.x - s.pos.x, r.z - s.pos.z);
        const speed = lat > 1.1 && along < (ANGLE ? 12 : 7) ? (ANGLE ? 4 : 6) : Math.min(16, 8 + ringDist * 0.4);
        const fr = frame(s);
        const e = wrap(bearing(s, tx, tz) - fr.h);
        if (ANGLE) angleVel(dx / Math.max(0.1, dist) * speed, clamp((r.y - s.pos.y) * 1.6, -3, 3), dz / Math.max(0.1, dist) * speed, dt, clamp(-e * 2, -1, 1));
        else {
          // GPS: pursue the ring centre at full speed, aim a few metres past it once close
          const through = along < 3;
          const gx = through ? r.x - n.x * side * 6 : r.x, gz = through ? r.z - n.z * side * 6 : r.z;
          const vdir = Math.atan2(s.vel.x, s.vel.z), nd = Math.atan2(n.x * -side, n.z * -side);
          const skew = Math.abs(wrap(vdir - nd));
          gpsTo(gx, r.y, gz, along < 14 && skew > 0.8 ? 8 : 12, { k: 3, strafe: true, yaw: clamp(-wrap(bearing(s, gx, gz) - fr.h) * 2, -1, 1) });
        }
      };
    },
    'slalom': () => {
      state = { t: 0 };
      return dt => {
        const s = g.sim; state.t += dt;
        if (!s.armed) { set(state.t < 0.5 ? 0.5 : 0.85, 0, 0, 0); return; }
        // weave: line up 3.5 m to the marked side before each pillar, hold that line past it, then the gate
        const next = g.mission?.probe?.().next ?? 0;
        const z0 = -14, gap = 12;
        let tx, tz, ty = 2.4;
        if (next < 8) {
          const pz = z0 - next * gap, side = next % 2 === 0 ? -1 : 1;
          tx = side * 3.5;
          tz = Math.abs(s.pos.x - tx) > 1.2 && s.pos.z > pz + 2 ? pz + 3 : pz - 4;
        } else { const gz = z0 - 7 * gap - 8; tx = 0; ty = 1.95; tz = Math.abs(s.pos.x) > 0.35 && s.pos.z > gz + 2.5 ? gz + 6 : gz - 4; }
        gpsTo(tx, ty, tz, 7, { k: 1.4, strafe: true, yaw: clamp(-wrap(Math.atan2(0, 1) - s.heading()) * 2, -1, 1) });
      };
    },
    'pad-hop': () => {
      state = { t: 0, rearm: 0 };
      return dt => {
        const s = g.sim; state.t += dt;
        const target = g.mission?.probe?.().target; if (!target) return;
        const dx = target.x - s.pos.x, dz = target.z - s.pos.z, dist = Math.hypot(dx, dz);
        if (!s.armed) {
          // re arm: centre then up, like a thumb on a spring loaded throttle
          state.rearm += dt;
          set(state.rearm < 0.4 ? 0.5 : 0.9, 0, 0, 0);
          return;
        }
        state.rearm = 0;
        const cruise = target.y + 4;
        // over the pad (with some hysteresis) it lets the drone sink, otherwise it travels at cruise height
        if (dist < 0.9) state.down = true; else if (dist > 2) state.down = false;
        if (!state.down) gpsTo(target.x, Math.max(cruise, s.pos.y > cruise ? s.pos.y - 0.5 : cruise), target.z, dist > 12 ? 14 : Math.max(1, dist * 0.8), { k: 1.0 });
        else {
          gpsTo(target.x, target.y - 2, target.z, 0.5, { k: 1.4, yaw: 0 });
          const t = g.input.touch; t.left.y = -0.6;
        }
      };
    },
    'target-range': () => {
      state = { t: 0 };
      return dt => {
        const s = g.sim; state.t += dt;
        if (!s.armed) { set(state.t < 0.5 ? 0.5 : 0.85, 0, 0, 0); return; }
        const tg = g.mission?.probe?.().targets ?? [];
        if (!tg.length) { set(0.5, 0, 0, 0); return; }
        // nearest live target; fly to 25 m of it at its height, nose on it
        let best = tg[0], bd = Infinity;
        for (const t of tg) { const d = Math.hypot(t.x - s.pos.x, t.z - s.pos.z) + Math.abs(t.y - s.pos.y) * 0.5; if (d < bd) { bd = d; best = t; } }
        const dx = best.x - s.pos.x, dz = best.z - s.pos.z, d = Math.hypot(dx, dz);
        const stand = 22;
        const tx = d > stand ? best.x - dx / d * stand : s.pos.x, tz = d > stand ? best.z - dz / d * stand : s.pos.z;
        const yaw = clamp(-wrap(bearing(s, best.x, best.z) - s.heading()) * 3, -1, 1);
        gpsTo(tx, Math.max(3, best.y), tz, 12, { yaw, strafe: true });
      };
    },
  };

  // the first training mission, for the mission star XP check
  drills['first-flight'] = () => {
    state = { t: 0 };
    return dt => {
      const s = g.sim; state.t += dt;
      if (!s.armed && !state.landing) { set(state.t < 0.5 ? 0.5 : 0.9, 0, 0, 0); return; }
      const objs = g.mission?.objectives?.() ?? [];
      if (objs[2]?.done) state.landing = true;
      if (!state.landing) { gpsTo(0, 5, -14, 3, { k: 1.2 }); return; }
      const pad = g.world.pads[2];
      const d = Math.hypot(pad.x - s.pos.x, pad.z - s.pos.z);
      if (d > 0.8) gpsTo(pad.x, 4, pad.z, 3, { k: 1.0 });
      else { gpsTo(pad.x, 0, pad.z, 0.4, { k: 1.4, yaw: 0 }); g.input.touch.left.y = -0.6; }
    };
  };

  window.__ap = {
    fly(id) { hook = drills[id](); },
    stop() { hook = null; const t = g.input.touch; t.left.x = 0; t.right.x = 0; t.right.y = 0; },
    sticks: set,
  };
})();
