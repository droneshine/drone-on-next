// One input layer for keyboard, gamepads, USB RC transmitters (they show up as
// gamepads with 4 to 8 axes) and touch sticks. Mode 2 by default.

import { Sticks } from '../sim/drone';

export type Device = 'keyboard' | 'gamepad' | 'rc' | 'touch';

export interface AxisMap { throttle: number; yaw: number; pitch: number; roll: number; invert: { throttle: boolean; yaw: boolean; pitch: boolean; roll: boolean }; }
export interface Calib { min: number[]; max: number[]; center: number[]; }

const LS = 'droneon.input.v1';

export interface InputSettings {
  rcMap: AxisMap;
  rcCalib: Calib | null;
  deadband: number;
  expo: number;          // extra stick expo for gamepads in all modes
  mode: 1 | 2;           // stick mode
  keyboardRate: number;  // how fast keys ramp sticks
}

const DEFAULTS: InputSettings = {
  rcMap: { throttle: 2, yaw: 3, pitch: 1, roll: 0, invert: { throttle: false, yaw: false, pitch: true, roll: false } },
  rcCalib: null,
  deadband: 0.04,
  expo: 0.25,
  mode: 2,
  keyboardRate: 4,
};

function loadSettings(): InputSettings {
  let s: Partial<InputSettings> = {};
  try { const v = JSON.parse(localStorage.getItem(LS) || '{}'); if (v && typeof v === 'object' && !Array.isArray(v)) s = v; } catch { /* storage blocked or corrupt */ }
  const map = s.rcMap && typeof s.rcMap === 'object' ? s.rcMap : {} as Partial<AxisMap>;
  const axis = (v: unknown, d: number) => (typeof v === 'number' && Number.isInteger(v) && v >= 0 && v < 16 ? v : d);
  const inv = (map.invert && typeof map.invert === 'object' ? map.invert : {}) as Partial<AxisMap['invert']>;
  const calib = s.rcCalib && Array.isArray(s.rcCalib.min) && Array.isArray(s.rcCalib.max) && Array.isArray(s.rcCalib.center) ? s.rcCalib : null;
  const num = (v: unknown, d: number, lo: number, hi: number) => (typeof v === 'number' && isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d);
  return {
    rcMap: {
      throttle: axis(map.throttle, 2), yaw: axis(map.yaw, 3), pitch: axis(map.pitch, 1), roll: axis(map.roll, 0),
      invert: { throttle: !!inv.throttle, yaw: !!inv.yaw, pitch: inv.pitch ?? true, roll: !!inv.roll },
    },
    rcCalib: calib,
    deadband: num(s.deadband, DEFAULTS.deadband, 0, 0.3),
    expo: num(s.expo, DEFAULTS.expo, 0, 1),
    mode: s.mode === 1 ? 1 : 2,
    keyboardRate: num(s.keyboardRate, DEFAULTS.keyboardRate, 1, 20),
  };
}

const FLIGHT_KEYS = ['KeyW', 'KeyA', 'KeyS', 'KeyD', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'];

export class Input {
  settings: InputSettings;
  device: Device = 'keyboard';
  keys = new Set<string>();
  pressed = new Set<string>();   // edge triggered this frame
  sticks: Sticks = { throttle: 0, yaw: 0, pitch: 0, roll: 0 };
  throttleSprings = true;        // gps mode: centre holds altitude
  private kbThrottle = 0;
  private kb = { yaw: 0, pitch: 0, roll: 0, climb: 0 };
  gamepadName = '';
  private padButtonsPrev: boolean[] = [];
  /** resting value of every axis when the pad was first seen: a throttle parked at the bottom is not "movement" */
  private padRest: number[] | null = null;
  private padPrev: number[] = [];
  padPressed = new Set<number>();
  touch = { left: { x: 0, y: 0, active: false }, right: { x: 0, y: 0, active: false } };
  mouseDX = 0; mouseDY = 0; wheel = 0;
  private wheelAcc = 0;
  mouseButtons = new Set<number>();
  enabled = true;
  touchSpray = false;
  touchTag = false;
  /** build mode on touch: up and down buttons */
  touchBuildLift = 0;
  undoPressed = false;
  uiClick = -1;      // canvas click for build mode, 0 left, 1 middle

  constructor() {
    this.settings = loadSettings();
    addEventListener('keydown', e => {
      const t = e.target as HTMLElement | null;
      if (t?.closest?.('input,textarea,select,[contenteditable]')) return;
      if (!this.enabled) return;
      if ((e.ctrlKey || e.metaKey) && e.code === 'KeyZ') { e.preventDefault(); this.undoPressed = true; return; }
      if (e.ctrlKey || e.metaKey || e.altKey && e.code !== 'AltLeft' && e.code !== 'AltRight') return;
      if (!this.keys.has(e.code)) this.pressed.add(e.code);
      this.keys.add(e.code);
      // only swallow keys aimed at the game, so Tab, Space and Enter still work on menu buttons
      const onGame = !t || t === document.body || t.id === 'gl' || t === document.documentElement;
      if (onGame && ['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.code)) e.preventDefault();
      if (this.device !== 'keyboard' && !this.touch.left.active && !this.touch.right.active && FLIGHT_KEYS.includes(e.code)) this.device = 'keyboard';
    });
    addEventListener('keyup', e => this.keys.delete(e.code));
    addEventListener('blur', () => this.keys.clear());
    addEventListener('mousemove', e => { this.mouseDX += e.movementX; this.mouseDY += e.movementY; });
    addEventListener('mousedown', e => this.mouseButtons.add(e.button));
    addEventListener('mouseup', e => this.mouseButtons.delete(e.button));
    addEventListener('wheel', e => {
      // trackpads send many tiny deltas: one notch is about 100 pixels
      this.wheelAcc += e.deltaY * (e.deltaMode === 1 ? 33 : e.deltaMode === 2 ? 300 : 1);
      const steps = Math.trunc(this.wheelAcc / 100);
      if (steps) { this.wheel += steps; this.wheelAcc -= steps * 100; }
    }, { passive: true });
    addEventListener('gamepadconnected', e => { this.gamepadName = (e as GamepadEvent).gamepad.id; this.padRest = null; });
    addEventListener('gamepaddisconnected', () => { this.padRest = null; if (this.device === 'rc' || this.device === 'gamepad') this.device = matchMedia('(pointer: coarse)').matches ? 'touch' : 'keyboard'; });
  }

  save() { try { localStorage.setItem(LS, JSON.stringify(this.settings)); } catch { /* ignore */ } }

  looksLikeRC(g: Gamepad) {
    const id = g.id.toLowerCase();
    return /siyi|unirc|radiomaster|frsky|taranis|jumper|edgetx|opentx|tx16|boxer|zorro|pocket|tbs|tango|betafpv|literadio|spektrum|dji.*fpv|flysky|ghost|crossfire|joystick.*rc|elrs/.test(id)
      || (g.buttons.length < 10 && g.axes.length >= 4 && !/xbox|playstation|dualsense|dualshock|wireless controller|8bitdo|switch/.test(id));
  }

  activePad(): Gamepad | null {
    const pads = navigator.getGamepads?.() ?? [];
    for (const p of pads) if (p && p.connected) return p;
    return null;
  }

  private shape(v: number, expo: number, db: number) {
    const a = Math.abs(v);
    if (a < db) return 0;
    const n = (a - db) / (1 - db);
    return Math.sign(v) * (n * (1 - expo) + n * n * n * expo);
  }

  /** where the throttle rests: centre (hover) in GPS mode, bottom otherwise unless already flying */
  setThrottleRest(springs: boolean, armed = false) {
    if (!this.touch.left.active) this.touch.left.y = springs ? 0 : armed ? 0 : -1;
    if (!springs) this.kbThrottle = armed ? 0.5 : 0;
    this.kb.climb = 0;
  }

  /** Call once per frame. */
  update(dt: number) {
    this.padPressed.clear();
    const pad = this.activePad();
    if (pad) {
      pad.buttons.forEach((b, i) => {
        if (b.pressed && !this.padButtonsPrev[i]) this.padPressed.add(i);
        this.padButtonsPrev[i] = b.pressed;
      });
      if (!this.padRest || this.padRest.length !== pad.axes.length) { this.padRest = [...pad.axes]; this.padPrev = [...pad.axes]; }
      // a controller only takes over when a stick really moves or a button is pressed
      const rest = this.padRest, prev = this.padPrev;
      const moved = this.padPressed.size > 0 || pad.axes.some((a, i) => Math.abs(a - rest[i]) > 0.3 && Math.abs(a - prev[i]) > 0.02);
      this.padPrev = [...pad.axes];
      const screenSticks = this.touch.left.active || this.touch.right.active;
      if (moved && !screenSticks && (this.device === 'keyboard' || this.device === 'touch')) this.device = this.looksLikeRC(pad) ? 'rc' : 'gamepad';
      this.gamepadName = pad.id;
    }
    if (!this.enabled) {
      // chat or a text field has the keys: let go of every stick so nothing keeps flying on its own
      this.kb.yaw = this.kb.pitch = this.kb.roll = this.kb.climb = 0;
      this.sticks.yaw = this.sticks.pitch = this.sticks.roll = 0;
      if (this.throttleSprings) this.sticks.throttle = 0.5;
      return;
    }
    const s = this.settings;
    if (this.device === 'rc' && pad) {
      const m = s.rcMap, c = s.rcCalib;
      const read = (i: number, inv: boolean, centred: boolean) => {
        let v = pad.axes[i] ?? 0;
        if (c) {
          const lo = c.min[i] ?? -1, hi = c.max[i] ?? 1, mid = centred ? (c.center[i] ?? 0) : (lo + hi) / 2;
          v = v >= mid ? (v - mid) / Math.max(1e-3, hi - mid) : (v - mid) / Math.max(1e-3, mid - lo);
        }
        v = Math.max(-1, Math.min(1, v));
        return inv ? -v : v;
      };
      this.sticks.throttle = (read(m.throttle, m.invert.throttle, false) + 1) / 2;
      this.sticks.yaw = this.shape(read(m.yaw, m.invert.yaw, true), 0, s.deadband * 0.5);
      this.sticks.pitch = this.shape(read(m.pitch, m.invert.pitch, true), 0, s.deadband * 0.5);
      this.sticks.roll = this.shape(read(m.roll, m.invert.roll, true), 0, s.deadband * 0.5);
      return;
    }
    if (this.device === 'gamepad' && pad) {
      // standard mapping, mode 2: left stick throttle/yaw, right stick pitch/roll
      const lx = pad.axes[0] ?? 0, ly = pad.axes[1] ?? 0, rx = pad.axes[2] ?? 0, ry = pad.axes[3] ?? 0;
      const left = { x: lx, y: -ly }, right = { x: rx, y: -ry };
      const [tStick, cStick] = s.mode === 2 ? [left, right] : [{ x: left.x, y: right.y }, { x: right.x, y: left.y }];
      // triggers give an alternative throttle for people who like it
      const rt = pad.buttons[7]?.value ?? 0, lt = pad.buttons[6]?.value ?? 0;
      let thr = this.shape(tStick.y, 0, s.deadband);
      if (rt > 0.05 || lt > 0.05) thr = rt - lt;
      this.sticks.throttle = (thr + 1) / 2;
      this.sticks.yaw = this.shape(tStick.x, s.expo, s.deadband);
      this.sticks.pitch = this.shape(cStick.y, s.expo, s.deadband);
      this.sticks.roll = this.shape(cStick.x, s.expo, s.deadband);
      return;
    }
    if (this.device === 'touch') {
      const L = this.touch.left, R = this.touch.right;
      this.sticks.throttle = (L.y + 1) / 2;
      this.sticks.yaw = this.shape(L.x, 0.2, 0.06);
      this.sticks.pitch = this.shape(R.y, 0.2, 0.06);
      this.sticks.roll = this.shape(R.x, 0.2, 0.06);
      return;
    }
    // keyboard: WASD = throttle/yaw, arrows = pitch/roll (mode 2 layout on keys)
    const k = this.keys;
    const target = (pos: boolean, neg: boolean) => (pos ? 1 : 0) - (neg ? 1 : 0);
    const r = s.keyboardRate * dt;
    const approach = (cur: number, tgt: number) => cur + Math.max(-r, Math.min(r, tgt - cur));
    this.kb.yaw = approach(this.kb.yaw, target(k.has('KeyD'), k.has('KeyA')));
    this.kb.pitch = approach(this.kb.pitch, target(k.has('ArrowUp') || k.has('KeyI'), k.has('ArrowDown') || k.has('KeyK')));
    this.kb.roll = approach(this.kb.roll, target(k.has('ArrowRight') || k.has('KeyL'), k.has('ArrowLeft') || k.has('KeyJ')));
    const climb = target(k.has('KeyW'), k.has('KeyS'));
    if (this.throttleSprings) {
      this.kb.climb = approach(this.kb.climb, climb);
      this.sticks.throttle = (this.kb.climb + 1) / 2;
    } else {
      // acro and angle on keys: hold W or S to move the throttle, it stays where you leave it
      this.kbThrottle = Math.max(0, Math.min(1, this.kbThrottle + climb * dt * 0.55));
      if (k.has('KeyX')) this.kbThrottle = 0;
      this.sticks.throttle = this.kbThrottle;
    }
    this.sticks.yaw = this.kb.yaw;
    this.sticks.pitch = this.kb.pitch;
    this.sticks.roll = this.kb.roll;
  }

  setKeyboardThrottle(v: number) { this.kbThrottle = v; }

  /** end of frame: clear edge state */
  endFrame() { this.pressed.clear(); this.mouseDX = 0; this.mouseDY = 0; this.wheel = 0; this.undoPressed = false; }

  hit(code: string) { return this.pressed.has(code); }
  padHit(i: number) { return this.padPressed.has(i); }
}

/** Live raw axes for the calibration screen. */
export function rawAxes(): number[] {
  const pads = navigator.getGamepads?.() ?? [];
  for (const p of pads) if (p && p.connected) return [...p.axes];
  return [];
}
