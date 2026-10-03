// Royale wire protocol, version 1. Pure TypeScript: no imports, no DOM, no Three.js.
//
// One file, three users: the browser game (P2P host and guests over Trystero, see
// studio/NETCODE.md), the solo loopback (bots, no network) and the Node server
// (server/index.mjs imports this file directly; Node 22.18+ strips the types, so
// this file must stay erasable TypeScript: no enum, no namespace, no parameter
// properties, no runtime imports).
//
// Rules of the road
//  * Nothing that arrives is trusted. Every message goes through a validateX()
//    that type checks, clamps, drops unknown fields, builds a fresh object and
//    returns null for junk. Validators never throw and never mutate their input.
//  * Streams (pilot state, bot batch, world snapshot) are flat number arrays,
//    latest wins, stale samples are dropped. They tolerate loss and reordering.
//  * Claims go pilot to host, batched per frame, each with a per sender id.
//    Host verdicts go out batched per host tick and carry (ep, seq): ep is the
//    host term, seq orders the verdicts so every screen applies them exactly
//    once, in the same order.
//  * Times on the wire are the SENDER's own clock in ms (performance.now()).
//    Receivers map them with OffsetFilter. Verdicts and the world snapshot also
//    carry match time (ms since GO).
//  * No game numbers live here. Fire intervals, ranges, radii, the Signal plan
//    and every other tunable come from the Royale tuning module (GDD section 6);
//    the host checks below take them as a RoyaleLimits argument, and the Signal
//    plan travels as data in the start message. The numbers in this file are
//    netcode: rates, windows, tolerances and wire sanity bounds.

// ------------------------------------------------------------------ netcode constants

export const PROTO_VERSION = 1;
export const MAX_SEATS = 12;
/** the world is 1600 m square around the origin (src/world/terrain.ts WORLD) */
export const WORLD_HALF = 800;
export const Y_MIN = -60;
export const Y_MAX = 650;
/** m/s; anything faster is junk before any game rule looks at it */
export const MAX_SPEED_WIRE = 120;
/** sanity bounds for numbers whose real limits live in the tuning module */
const WIRE_MAX_TIER = 15, WIRE_MAX_HP = 9999, WIRE_MAX_SHINE = 9999, WIRE_MAX_TANK = 10, WIRE_MAX_FORCE = 1000;

export const STATE_HZ = 20;
/** pilots further than FAR_M from a receiver get this rate instead */
export const STATE_FAR_HZ = 5;
export const FAR_M = 350;
export const BOTS_HZ = 10;
export const WORLD_HZ = 5;
export const SPECTATE_HZ = 1;
/** the host flushes at most one verdict batch per tick */
export const HOST_TICK_HZ = 30;

/** remote drones render this far in the past (same as multiplayer.ts DELAY) */
export const INTERP_DELAY_MS = 100;
/** oldest moment the host will rewind to for a hit, interpolation delay included */
export const REWIND_MAX_MS = 350;
export const EXTRAPOLATE_MAX_MS = 150;
/** guests end the match ("HOST LEFT. MATCH ENDED") after hearing nothing from the host this long */
export const HOST_LOST_MS = 3000;
/** server phase: a dropped pilot can reclaim its seat with its token this long */
export const SEAT_HOLD_MS = 60000;

/**
 * Trystero action names. They share the squad room with multiplayer.ts, which
 * already uses st hi bd rc ch bp, so control is 'rx', not 'rc'.
 */
export const ACTIONS = { state: 'rs', bots: 'rb', world: 'rw', claims: 'rq', events: 're', ctl: 'rx' } as const;
export type ActionKey = typeof ACTIONS[keyof typeof ACTIONS];
const ACTION_KEYS: readonly string[] = Object.values(ACTIONS);
export function isActionKey(v: unknown): v is ActionKey { return typeof v === 'string' && ACTION_KEYS.includes(v); }

/** JSON size caps in characters, checked before parsing */
export const MAX_JSON = { claims: 4000, events: 16000, ctl: 48000 } as const;
export const MAX_CLAIMS_PER_BATCH = 16;
export const MAX_EVENTS_PER_BATCH = 64;

/** per sender: messages per second (sustained, burst) for each action */
export const RATE_LIMITS: Record<ActionKey, { rate: number; burst: number }> = {
  rs: { rate: 30, burst: 45 },
  rb: { rate: 15, burst: 25 },
  rw: { rate: 10, burst: 20 },
  rq: { rate: 40, burst: 60 },     // one batch per frame that has claims, split to all and to the host
  re: { rate: 35, burst: 45 },     // one batch per host tick (HOST_TICK_HZ)
  rx: { rate: 6, burst: 24 },
};
/** per sender: items inside batches per second. 80 verdicts per second covers a 12 drone brawl with jet damage merged per target at 5 Hz */
export const ITEM_LIMITS = { rq: { rate: 40, burst: 60 }, re: { rate: 80, burst: 160 } } as const;

// ------------------------------------------------------------------ limits the host checks need (from the tuning module)

/** what a tier allows; index in RoyaleLimits.tiers = tier number (0 = the launch tier) */
export interface TierLimits {
  /** minimum ms between PULSE shots (1000 / shots per second) */
  pulseIntervalMs: number;
  /** PULSE bolt speed, m/s */
  pulseSpeed: number;
  /** PULSE range, m (bolt life = range / speed) */
  pulseRange: number;
  /** hit sphere radius of a drone of this tier, m */
  hitRadius: number;
  /** motion guard envelope: top speed including BOOST and dives, m/s (QA measures) */
  vmax: number;
  /** this tier carries the WATER JET */
  jet: boolean;
  /** this tier's special ability, if any */
  special: AbilityId | null;
}
/**
 * Everything the host validators need from the Royale tuning module. The Royale
 * programmer builds one from the tuning table and hands it to the checks; this
 * file never holds the numbers itself.
 */
export interface RoyaleLimits {
  tiers: readonly TierLimits[];
  /** PULSE needs at least this battery state of charge (0 to 1) */
  pulseMinSoc: number;
  jet: { range: number; coneDeg: number; tickMs: number };
  bursts: Readonly<Record<AbilityId, { radius: number; cooldownMs: number; minSoc: number }>>;
  /** a ring pass counts inside this fraction of the ring radius */
  ringPass: number;
  /** touch radius of a Shine cache, m */
  cacheRadius: number;
}
const tierLimits = (L: RoyaleLimits, tier: number): TierLimits => L.tiers[Math.max(0, Math.min(L.tiers.length - 1, tier | 0))];

// ------------------------------------------------------------------ vocabulary and flags

export type Vec3 = [number, number, number];
export type Quat = [number, number, number, number];

export type AbilityId = 'emp' | 'nova';
/** shared pickups this cycle (no weapon or shield pickups); personal Shine rings are claimed with 'ring' */
export type ItemKind = 'bigshine' | 'charge' | 'repair' | 'cache';
const ITEM_KINDS: readonly ItemKind[] = ['bigshine', 'charge', 'repair', 'cache'];
/** what a 'got' verdict hands out */
export type Give = 'shine' | 'lane' | ItemKind | 'salvage';
const GIVES: readonly Give[] = ['shine', 'lane', 'bigshine', 'charge', 'repair', 'cache', 'salvage'];
/** damage and knockout causes, one per kill feed line (GDD 2.6) */
export type Cause = 'pulse' | 'jet' | 'emp' | 'nova' | 'ram' | 'ground' | 'tree' | 'static' | 'lake' | 'blade' | 'left';
const CAUSES: readonly Cause[] = ['pulse', 'jet', 'emp', 'nova', 'ram', 'ground', 'tree', 'static', 'lake', 'blade', 'left'];
/** what a pilot's own flight model reports; lake and blade are instant knockouts */
export type ImpactKind = 'ground' | 'tree' | 'lake' | 'blade' | 'ram';
const IMPACT_KINDS: readonly ImpactKind[] = ['ground', 'tree', 'lake', 'blade', 'ram'];
export type DenyReason = 'unknown' | 'taken' | 'far' | 'late' | 'cooldown' | 'range' | 'blocked' | 'dead' | 'dup' | 'rate' | 'phase' | 'tier' | 'battery' | 'empty';
const DENY_REASONS: readonly DenyReason[] = ['unknown', 'taken', 'far', 'late', 'cooldown', 'range', 'blocked', 'dead', 'dup', 'rate', 'phase', 'tier', 'battery', 'empty'];

/** pilot and bot state flags */
export const SF = {
  ARMED: 1, CRASHED: 2,
  /** WATER JET stream on: every screen draws it */
  JET: 4,
  BOOST: 8, PARKED: 16, SPECTATE: 32,
  /** EMP or NOVA BURST charging */
  CHARGING: 64,
  /** hit by an EMP: sticks neutral, weapons off */
  SCRAMBLED: 128,
  /** landed and recharging */
  LANDED: 256,
  /** evolve invulnerability */
  INVULN: 512,
} as const;
const SF_ALL = 1023;

/** seat status in the world snapshot; AUTOPILOT is server phase (P1), unused by P2P rooms this cycle */
export const SEAT = { EMPTY: 0, HUMAN: 1, BOT: 2, AUTOPILOT: 3, OUT: 4 } as const;
export type SeatStatus = 0 | 1 | 2 | 3 | 4;
export const PHASE = { LOBBY: 0, COUNTDOWN: 1, LIVE: 2, ENDED: 3 } as const;
export type Phase = 0 | 1 | 2 | 3;

/** damage source that is not a seat */
export const SRC_STATIC = -1;
export const SRC_WORLD = -2;

// ------------------------------------------------------------------ primitive checks

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const fin = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);
const round = (v: number, k: number) => Math.round(v * k) / k;

/** finite number clamped into range, or null */
function num(v: unknown, lo: number, hi: number): number | null { return fin(v) ? clamp(v, lo, hi) : null; }
/** integer inside the range, or null: ids and seats are never clamped into meaning */
function int(v: unknown, lo: number, hi: number): number | null { return fin(v) && Number.isInteger(v) && v >= lo && v <= hi ? v : null; }
function oneOf<T extends string>(v: unknown, list: readonly T[]): T | null { return typeof v === 'string' && (list as readonly string[]).includes(v) ? v as T : null; }

function pos3(v: unknown): Vec3 | null {
  if (!Array.isArray(v) || v.length !== 3 || !fin(v[0]) || !fin(v[1]) || !fin(v[2])) return null;
  return [clamp(v[0], -WORLD_HALF, WORLD_HALF), clamp(v[1], Y_MIN, Y_MAX), clamp(v[2], -WORLD_HALF, WORLD_HALF)];
}
/** unit direction; zero length is junk */
function dir3(v: unknown): Vec3 | null {
  if (!Array.isArray(v) || v.length !== 3 || !fin(v[0]) || !fin(v[1]) || !fin(v[2])) return null;
  const l = Math.hypot(v[0], v[1], v[2]);
  if (l < 1e-6 || l > 1e6) return null;
  return [v[0] / l, v[1] / l, v[2] / l];
}
/** printable text: control and bidi override characters removed, whitespace collapsed */
function text(v: unknown, max: number, fallback: string): string {
  if (typeof v !== 'string') return fallback;
  const s = v.slice(0, max * 4).replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩]/g, '').replace(/\s+/g, ' ').trim().slice(0, max);
  return s || fallback;
}
const ID_RE = /^[A-Za-z0-9_-]{0,32}$/;
const SKIN_RE = /^[a-z0-9-]{1,24}$/;
const TOKEN_RE = /^[A-Za-z0-9]{0,32}$/;
const MATCH_RE = /^[A-Za-z0-9-]{1,40}$/;
const peerId = (v: unknown): string | null => (typeof v === 'string' && ID_RE.test(v) ? v : null);

/** a JSON string within the size cap, or an already parsed plain object */
function obj(raw: unknown, max: number): Record<string, unknown> | null {
  if (typeof raw === 'string') {
    if (raw.length > max) return null;
    try { const v: unknown = JSON.parse(raw); return isObj(v) ? v : null; } catch { return null; }
  }
  return isObj(raw) ? raw : null;
}

/** wraps a validator so that nothing, not even a hostile getter, escapes as an exception */
function safe<T>(f: (raw: unknown) => T | null): (raw: unknown) => T | null {
  return (raw: unknown) => { try { return f(raw); } catch { return null; } };
}

// ------------------------------------------------------------------ stream: pilot state

/**
 * Each pilot streams its own drone at STATE_HZ. Wire layout, 19 numbers:
 * [seq, ms, x, y, z, qx, qy, qz, qw, vx, vy, vz, motor, flags, aim, soc, tank, shine, ack]
 * ms is the sender's clock; soc (0 to 1) and tank (litres) are the pilot's own
 * battery and water; shine is the pilot's own count (the host's world snapshot
 * is the authority, the pilot snaps to it); ack is the last host verdict seq applied.
 */
export interface PilotState {
  seq: number; ms: number; pos: Vec3; quat: Quat; vel: Vec3;
  motor: number; flags: number; aim: number; soc: number; tank: number; shine: number; ack: number;
}
export const PILOT_STATE_LEN = 19;
const MAX_MS = 1e11;          // performance.now() of a tab open for three years
const SEQ_MAX = 2 ** 31 - 1;

export function encodePilotState(s: PilotState): number[] {
  return [s.seq, Math.round(s.ms), round(s.pos[0], 100), round(s.pos[1], 100), round(s.pos[2], 100),
    round(s.quat[0], 1e4), round(s.quat[1], 1e4), round(s.quat[2], 1e4), round(s.quat[3], 1e4),
    round(s.vel[0], 100), round(s.vel[1], 100), round(s.vel[2], 100),
    round(s.motor, 100), s.flags & SF_ALL, Math.round(s.aim), round(s.soc, 1000), round(s.tank, 100), s.shine | 0, s.ack];
}

function quatFrom(a: number, b: number, c: number, d: number): Quat | null {
  const l = Math.hypot(a, b, c, d);
  if (l < 1e-3 || l > 1e3) return null;
  return [a / l, b / l, c / l, d / l];
}
function velFrom(x: number, y: number, z: number): Vec3 {
  const l = Math.hypot(x, y, z);
  const k = l > MAX_SPEED_WIRE ? MAX_SPEED_WIRE / l : 1;
  return [x * k, y * k, z * k];
}

/** pos, quat, vel, motor, flags, aim at index i of a flat array; null if any is junk */
function kinematics(a: unknown[], i: number) {
  for (let k = i; k < i + 13; k++) if (!fin(a[k])) return null;
  const n = a as number[];
  const quat = quatFrom(n[i + 3], n[i + 4], n[i + 5], n[i + 6]);
  if (!quat) return null;
  return {
    pos: [clamp(n[i], -WORLD_HALF, WORLD_HALF), clamp(n[i + 1], Y_MIN, Y_MAX), clamp(n[i + 2], -WORLD_HALF, WORLD_HALF)] as Vec3,
    quat,
    vel: velFrom(n[i + 7], n[i + 8], n[i + 9]),
    motor: clamp(n[i + 10], 0, 1),
    flags: (n[i + 11] | 0) & SF_ALL,
    aim: clamp(n[i + 12], -90, 30),
  };
}

export const validatePilotState = safe((raw: unknown): PilotState | null => {
  // a longer array is a newer client: read what we know, ignore the rest
  if (!Array.isArray(raw) || raw.length < PILOT_STATE_LEN || raw.length > 32) return null;
  const seq = int(raw[0], 0, SEQ_MAX);
  const ms = num(raw[1], 0, MAX_MS);
  const k = kinematics(raw, 2);
  const soc = num(raw[15], 0, 1), tank = num(raw[16], 0, WIRE_MAX_TANK);
  const shine = fin(raw[17]) ? clamp(Math.floor(raw[17]), 0, WIRE_MAX_SHINE) : null;
  const ack = fin(raw[18]) ? clamp(Math.floor(raw[18]), 0, SEQ_MAX) : null;
  if (seq === null || ms === null || !k || soc === null || tank === null || shine === null || ack === null) return null;
  return { seq, ms, ...k, soc, tank, shine, ack };
});

// Binary form for the server phase (and optionally P2P: Trystero sends typed arrays raw).
// 52 bytes instead of about 110 characters of JSON. Little endian:
// u8 version | u32 seq | f64 ms | f32 x y z | i16 quat x4 (/32767) | i16 vel x3 (cm/s)
// | u8 motor | u16 flags | i8 aim | u8 soc (/255) | u16 tank (cl) | u16 shine | u32 ack
export const PILOT_STATE_BYTES = 52;
export function packPilotState(s: PilotState): Uint8Array {
  const b = new Uint8Array(PILOT_STATE_BYTES);
  const v = new DataView(b.buffer);
  v.setUint8(0, PROTO_VERSION);
  v.setUint32(1, s.seq >>> 0, true);
  v.setFloat64(5, s.ms, true);
  v.setFloat32(13, s.pos[0], true); v.setFloat32(17, s.pos[1], true); v.setFloat32(21, s.pos[2], true);
  for (let i = 0; i < 4; i++) v.setInt16(25 + i * 2, Math.round(clamp(s.quat[i], -1, 1) * 32767), true);
  for (let i = 0; i < 3; i++) v.setInt16(33 + i * 2, Math.round(clamp(s.vel[i] * 100, -32767, 32767)), true);
  v.setUint8(39, Math.round(clamp(s.motor, 0, 1) * 255));
  v.setUint16(40, s.flags & SF_ALL, true);
  v.setInt8(42, Math.round(clamp(s.aim, -90, 30)));
  v.setUint8(43, Math.round(clamp(s.soc, 0, 1) * 255));
  v.setUint16(44, Math.round(clamp(s.tank, 0, WIRE_MAX_TANK) * 100), true);
  v.setUint16(46, clamp(s.shine | 0, 0, WIRE_MAX_SHINE), true);
  v.setUint32(48, s.ack >>> 0, true);
  return b;
}
export const unpackPilotState = safe((raw: unknown): PilotState | null => {
  let b: Uint8Array;
  if (raw instanceof Uint8Array) b = raw;
  else if (raw instanceof ArrayBuffer) b = new Uint8Array(raw);
  else return null;
  if (b.byteLength !== PILOT_STATE_BYTES) return null;
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  if (v.getUint8(0) !== PROTO_VERSION) return null;
  const q = (i: number) => v.getInt16(25 + i * 2, true) / 32767;
  const w = (i: number) => v.getInt16(33 + i * 2, true) / 100;
  // through the same checks as the JSON form, so clamps live in one place
  return validatePilotState([v.getUint32(1, true), v.getFloat64(5, true), v.getFloat32(13, true), v.getFloat32(17, true), v.getFloat32(21, true),
    q(0), q(1), q(2), q(3), w(0), w(1), w(2), v.getUint8(39) / 255, v.getUint16(40, true), v.getInt8(42),
    v.getUint8(43) / 255, v.getUint16(44, true) / 100, v.getUint16(46, true), v.getUint32(48, true)]);
});

// ------------------------------------------------------------------ stream: bot batch (host only)

/**
 * The host flies the bots and streams them in one message at BOTS_HZ.
 * [seq, ms, n, then n x (seat, x, y, z, qx, qy, qz, qw, vx, vy, vz, motor, flags, aim)]
 * Bot tier, Shine and integrity travel in the world snapshot like everyone's.
 */
export interface BotState { seat: number; pos: Vec3; quat: Quat; vel: Vec3; motor: number; flags: number; aim: number }
export interface BotBatch { seq: number; ms: number; bots: BotState[] }
export const BOT_STRIDE = 14;

export function encodeBotBatch(b: BotBatch): number[] {
  const out: number[] = [b.seq, Math.round(b.ms), b.bots.length];
  for (const s of b.bots) out.push(s.seat, round(s.pos[0], 100), round(s.pos[1], 100), round(s.pos[2], 100),
    round(s.quat[0], 1e4), round(s.quat[1], 1e4), round(s.quat[2], 1e4), round(s.quat[3], 1e4),
    round(s.vel[0], 100), round(s.vel[1], 100), round(s.vel[2], 100), round(s.motor, 100), s.flags & SF_ALL, Math.round(s.aim));
  return out;
}

export const validateBotBatch = safe((raw: unknown): BotBatch | null => {
  if (!Array.isArray(raw) || raw.length < 3) return null;
  const seq = int(raw[0], 0, SEQ_MAX), ms = num(raw[1], 0, MAX_MS), n = int(raw[2], 0, MAX_SEATS - 1);
  if (seq === null || ms === null || n === null || raw.length !== 3 + n * BOT_STRIDE) return null;
  const bots: BotState[] = [];
  const seen = new Set<number>();
  for (let i = 0; i < n; i++) {
    const at = 3 + i * BOT_STRIDE;
    const seat = int(raw[at], 0, MAX_SEATS - 1);
    const k = kinematics(raw, at + 1);
    if (seat === null || !k || seen.has(seat)) return null;
    seen.add(seat);
    bots.push({ seat, ...k });
  }
  return { seq, ms, bots };
});

// ------------------------------------------------------------------ stream: world snapshot (host only)

/**
 * Host heartbeat and correction at WORLD_HZ. Integrity, tier and Shine are
 * authoritative here; verdicts make changes instant, the snapshot repairs
 * anything missed and is what late joiners and spectators render.
 * [ep, seq, matchMs, phase, alive, n, then n x (seat, hp, tier, shine, status)]
 */
export interface SeatState { seat: number; hp: number; tier: number; shine: number; status: SeatStatus }
export interface WorldSnapshot { ep: number; seq: number; matchMs: number; phase: Phase; alive: number; seats: SeatState[] }
export const SEAT_STRIDE = 5;

export function encodeWorldSnapshot(w: WorldSnapshot): number[] {
  const out: number[] = [w.ep, w.seq, Math.round(w.matchMs), w.phase, w.alive, w.seats.length];
  for (const s of w.seats) out.push(s.seat, Math.round(s.hp), s.tier, s.shine, s.status);
  return out;
}

export const validateWorldSnapshot = safe((raw: unknown): WorldSnapshot | null => {
  if (!Array.isArray(raw) || raw.length < 6) return null;
  const ep = int(raw[0], 0, SEQ_MAX), seq = int(raw[1], 0, SEQ_MAX), matchMs = num(raw[2], -60000, 36e5);
  const phase = int(raw[3], 0, 3) as Phase | null, alive = int(raw[4], 0, MAX_SEATS), n = int(raw[5], 0, MAX_SEATS);
  if (ep === null || seq === null || matchMs === null || phase === null || alive === null || n === null) return null;
  if (raw.length !== 6 + n * SEAT_STRIDE) return null;
  const seats: SeatState[] = [];
  const seen = new Set<number>();
  for (let i = 0; i < n; i++) {
    const at = 6 + i * SEAT_STRIDE;
    const seat = int(raw[at], 0, MAX_SEATS - 1);
    const hp = num(raw[at + 1], 0, WIRE_MAX_HP), tier = int(raw[at + 2], 0, WIRE_MAX_TIER), shine = int(raw[at + 3], 0, WIRE_MAX_SHINE);
    const status = int(raw[at + 4], 0, 4) as SeatStatus | null;
    if (seat === null || hp === null || tier === null || shine === null || status === null || seen.has(seat)) return null;
    seen.add(seat);
    seats.push({ seat, hp, tier, shine, status });
  }
  return { ep, seq, matchMs, phase, alive, seats };
});

// ------------------------------------------------------------------ claims (pilot to host), batched per frame

/** PULSE shot; broadcast so every screen draws the bolt at once */
export interface FireClaim { t: 'fire'; id: number; ms: number; o: Vec3; d: Vec3 }
/** the shooter's screen saw its PULSE hit a drone; host only */
export interface HitClaim { t: 'hit'; id: number; ms: number; shot: number; target: number; p: Vec3 }
/** one WATER JET tick on a target, with nozzle and stream direction; host only */
export interface JetClaim { t: 'jet'; id: number; ms: number; target: number; o: Vec3; d: Vec3 }
/** EMP or NOVA BURST went off at o (end of the charge); broadcast for the effect, the host decides who is hit */
export interface BurstClaim { t: 'burst'; id: number; ms: number; a: AbilityId; o: Vec3 }
/** flew through a personal Shine ring; host only */
export interface RingClaim { t: 'ring'; id: number; ms: number; ring: number }
/** took a shared item: Big Shine, Charge or Repair ring, or a Shine cache; host only */
export interface PickClaim { t: 'pick'; id: number; ms: number; item: number }
/** the pilot's own flight model hit something; speed is the impact (or closing) speed; other = rammed seat or -1 */
export interface ImpactClaim { t: 'impact'; id: number; ms: number; kind: ImpactKind; speed: number; other: number }
export type Claim = FireClaim | HitClaim | JetClaim | BurstClaim | RingClaim | PickClaim | ImpactClaim;
/** claims every peer receives (they draw them); the rest go to the host only */
export const CLAIM_BROADCAST: readonly Claim['t'][] = ['fire', 'burst'];
export const isBroadcastClaim = (c: Claim) => (CLAIM_BROADCAST as readonly string[]).includes(c.t);

const claimId = (v: unknown) => int(v, 1, SEQ_MAX);
const claimMs = (v: unknown) => num(v, 0, MAX_MS);
const seatOf = (v: unknown) => int(v, 0, MAX_SEATS - 1);
const itemId = (v: unknown) => int(v, 0, 65535);

function claimMsg(raw: unknown, t: Claim['t']): { m: Record<string, unknown>; id: number; ms: number } | null {
  const m = obj(raw, MAX_JSON.claims);
  if (!m || m.t !== t) return null;
  const id = claimId(m.id), ms = claimMs(m.ms);
  return id !== null && ms !== null ? { m, id, ms } : null;
}
export const validateFire = safe((raw: unknown): FireClaim | null => {
  const c = claimMsg(raw, 'fire');
  if (!c) return null;
  const o = pos3(c.m.o), d = dir3(c.m.d);
  return o && d ? { t: 'fire', id: c.id, ms: c.ms, o, d } : null;
});
export const validateHit = safe((raw: unknown): HitClaim | null => {
  const c = claimMsg(raw, 'hit');
  if (!c) return null;
  const shot = claimId(c.m.shot), target = seatOf(c.m.target), p = pos3(c.m.p);
  return shot !== null && target !== null && p ? { t: 'hit', id: c.id, ms: c.ms, shot, target, p } : null;
});
export const validateJet = safe((raw: unknown): JetClaim | null => {
  const c = claimMsg(raw, 'jet');
  if (!c) return null;
  const target = seatOf(c.m.target), o = pos3(c.m.o), d = dir3(c.m.d);
  return target !== null && o && d ? { t: 'jet', id: c.id, ms: c.ms, target, o, d } : null;
});
export const validateBurst = safe((raw: unknown): BurstClaim | null => {
  const c = claimMsg(raw, 'burst');
  if (!c) return null;
  const a = oneOf(c.m.a, ['emp', 'nova'] as const), o = pos3(c.m.o);
  return a && o ? { t: 'burst', id: c.id, ms: c.ms, a, o } : null;
});
export const validateRing = safe((raw: unknown): RingClaim | null => {
  const c = claimMsg(raw, 'ring');
  if (!c) return null;
  const ring = itemId(c.m.ring);
  return ring !== null ? { t: 'ring', id: c.id, ms: c.ms, ring } : null;
});
export const validatePick = safe((raw: unknown): PickClaim | null => {
  const c = claimMsg(raw, 'pick');
  if (!c) return null;
  const item = itemId(c.m.item);
  return item !== null ? { t: 'pick', id: c.id, ms: c.ms, item } : null;
});
export const validateImpact = safe((raw: unknown): ImpactClaim | null => {
  const c = claimMsg(raw, 'impact');
  if (!c) return null;
  const kind = oneOf(c.m.kind, IMPACT_KINDS), speed = num(c.m.speed, 0, MAX_SPEED_WIRE), other = int(c.m.other ?? -1, -1, MAX_SEATS - 1);
  if (!kind || speed === null || other === null) return null;
  if (kind === 'ram' && other < 0) return null;       // a ram names the other drone
  return { t: 'impact', id: c.id, ms: c.ms, kind, speed, other: kind === 'ram' ? other : -1 };
});

const CLAIMS: Record<Claim['t'], (raw: unknown) => Claim | null> = {
  fire: validateFire, hit: validateHit, jet: validateJet, burst: validateBurst, ring: validateRing, pick: validatePick, impact: validateImpact,
};
export const validateClaim = safe((raw: unknown): Claim | null => {
  const m = obj(raw, MAX_JSON.claims);
  if (!m || typeof m.t !== 'string' || !Object.prototype.hasOwnProperty.call(CLAIMS, m.t)) return null;
  return CLAIMS[m.t as Claim['t']](m);
});

/**
 * One frame's claims: {"ms": frame time, "c": [claims without ms]}. Send the
 * broadcast ones (fire, burst) to everybody and the rest to the host, so a
 * frame costs at most two messages.
 */
export function encodeClaimBatch(ms: number, claims: readonly Claim[]): { ms: number; c: Record<string, unknown>[] } {
  return { ms: Math.round(ms), c: claims.map(cl => { const o: Record<string, unknown> = { ...cl }; delete o.ms; return o; }) };
}
/** a batch of claims, each stamped with the batch time. Junk claims are dropped one by one; a junk batch is null */
export const validateClaimBatch = safe((raw: unknown): Claim[] | null => {
  const m = obj(raw, MAX_JSON.claims);
  if (!m) return null;
  const ms = claimMs(m.ms);
  if (ms === null || !Array.isArray(m.c) || m.c.length < 1 || m.c.length > MAX_CLAIMS_PER_BATCH) return null;
  const out: Claim[] = [];
  const ids = new Set<number>();
  for (const body of m.c) {
    if (!isObj(body)) continue;
    const cl = validateClaim({ ...body, ms });
    if (cl && !ids.has(cl.id)) { ids.add(cl.id); out.push(cl); }
  }
  return out;
});

/** host side key for a claim: unique per seat */
export function claimRef(seat: number, id: number): number { return seat * 2 ** 24 + (id % 2 ** 24); }
export function refSeat(ref: number): number { return Math.floor(ref / 2 ** 24); }

// ------------------------------------------------------------------ host verdicts, batched per host tick

interface EvBase { ep: number; seq: number; at: number }
/** integrity loss; src is a seat, SRC_STATIC or SRC_WORLD; hp is the integrity after it; ref = the claim it answers (0 if none) */
export interface DmgEvent extends EvBase { t: 'dmg'; target: number; src: number; amt: number; hp: number; cause: Cause; ref: number }
/** one Static tick for every drone outside the Signal: same amount, integrity after per seat */
export interface ZapEvent extends EvBase { t: 'zap'; amt: number; seats: number[]; hp: number[] }
/** applied by the victim to its OWN drone (each pilot owns its flight): a water push (force, N) or a scramble */
export interface FxEvent extends EvBase { t: 'fx'; kind: 'push' | 'scramble'; src: number; targets: number[]; dir: Vec3; force: number; dur: number }
/** a pickup, lane bonus or salvage: Shine, tier and integrity after it; a tier change is the evolve moment */
export interface GotEvent extends EvBase { t: 'got'; seat: number; give: Give; item: number; shine: number; tier: number; hp: number; ref: number }
/** a claim the host refused: the claimant rolls its prediction back */
export interface DenyEvent extends EvBase { t: 'deny'; seat: number; ref: number; why: DenyReason }
/** a shared item that exists only now (Shine cache) */
export interface SpawnItem { id: number; kind: ItemKind; pos: Vec3; value: number }
export interface SpawnEvent extends EvBase { t: 'spawn'; items: SpawnItem[] }
/** knockout: by is the credited seat or -1; place counts down from 12 */
export interface ElimEvent extends EvBase { t: 'elim'; victim: number; by: number; cause: Cause; place: number }
/** seat ownership changed (server phase: a dropped pilot's seat on autopilot, or back) */
export interface SeatEvent extends EvBase { t: 'seat'; seat: number; status: SeatStatus }
/** match over; order lists seats from first to last place; why 'host' = HOST LEFT. MATCH ENDED */
export interface EndEvent extends EvBase { t: 'end'; winner: number; order: number[]; why: 'last' | 'host' | 'abort' }
export type HostEvent = DmgEvent | ZapEvent | FxEvent | GotEvent | DenyEvent | SpawnEvent | ElimEvent | SeatEvent | EndEvent;

/** the parsed event (never mutated) and its checked (ep, seq, at) */
function evMsg(raw: unknown, t: HostEvent['t']): { m: Record<string, unknown>; b: EvBase } | null {
  const m = obj(raw, MAX_JSON.events);
  if (!m || m.t !== t) return null;
  const ep = int(m.ep, 1, SEQ_MAX), seq = int(m.seq, 1, SEQ_MAX), at = num(m.at, -60000, 36e5);
  if (ep === null || seq === null || at === null) return null;
  return { m, b: { ep, seq, at } };
}
const srcOf = (v: unknown) => int(v, SRC_WORLD, MAX_SEATS - 1);
const refOf = (v: unknown) => int(v, 0, MAX_SEATS * 2 ** 24);
function seatList(v: unknown, max = MAX_SEATS): number[] | null {
  if (!Array.isArray(v) || v.length > max) return null;
  const out: number[] = [];
  for (const s of v) { const k = seatOf(s); if (k === null || out.includes(k)) return null; out.push(k); }
  return out;
}

export const validateDmg = safe((raw: unknown): DmgEvent | null => {
  const e = evMsg(raw, 'dmg');
  if (!e) return null;
  const { m, b } = e;
  const target = seatOf(m.target), src = srcOf(m.src), amt = num(m.amt, 0, WIRE_MAX_HP), hp = num(m.hp, 0, WIRE_MAX_HP), cause = oneOf(m.cause, CAUSES), ref = refOf(m.ref ?? 0);
  return target !== null && src !== null && amt !== null && hp !== null && cause && ref !== null ? { t: 'dmg', ...b, target, src, amt, hp, cause, ref } : null;
});
export const validateZap = safe((raw: unknown): ZapEvent | null => {
  const e = evMsg(raw, 'zap');
  if (!e) return null;
  const { m, b } = e;
  const amt = num(m.amt, 0, WIRE_MAX_HP), seats = seatList(m.seats);
  if (amt === null || !seats || !Array.isArray(m.hp) || m.hp.length !== seats.length) return null;
  const hp: number[] = [];
  for (const h of m.hp) { const v = num(h, 0, WIRE_MAX_HP); if (v === null) return null; hp.push(v); }
  return { t: 'zap', ...b, amt, seats, hp };
});
export const validateFx = safe((raw: unknown): FxEvent | null => {
  const e = evMsg(raw, 'fx');
  if (!e) return null;
  const { m, b } = e;
  const kind = oneOf(m.kind, ['push', 'scramble'] as const), src = srcOf(m.src), targets = seatList(m.targets);
  const zero = Array.isArray(m.dir) && m.dir.length === 3 && m.dir.every(x => x === 0);
  const dir: Vec3 | null = zero ? [0, 0, 0] : dir3(m.dir);
  const force = num(m.force ?? 0, 0, WIRE_MAX_FORCE), dur = num(m.dur, 0, 10000);
  if (!kind || src === null || !targets || !dir || force === null || dur === null) return null;
  if (kind === 'push' && zero) return null;           // a push needs a direction
  return { t: 'fx', ...b, kind, src, targets, dir, force, dur };
});
export const validateGot = safe((raw: unknown): GotEvent | null => {
  const e = evMsg(raw, 'got');
  if (!e) return null;
  const { m, b } = e;
  const seat = seatOf(m.seat), give = oneOf(m.give, GIVES), item = itemId(m.item ?? 0);
  const shine = int(m.shine, 0, WIRE_MAX_SHINE), tier = int(m.tier, 0, WIRE_MAX_TIER), hp = num(m.hp, 0, WIRE_MAX_HP), ref = refOf(m.ref ?? 0);
  return seat !== null && give && item !== null && shine !== null && tier !== null && hp !== null && ref !== null
    ? { t: 'got', ...b, seat, give, item, shine, tier, hp, ref } : null;
});
export const validateDeny = safe((raw: unknown): DenyEvent | null => {
  const e = evMsg(raw, 'deny');
  if (!e) return null;
  const { m, b } = e;
  const seat = seatOf(m.seat), ref = refOf(m.ref), why = oneOf(m.why, DENY_REASONS);
  return seat !== null && ref !== null && why ? { t: 'deny', ...b, seat, ref, why } : null;
});
function spawnItem(v: unknown): SpawnItem | null {
  if (!isObj(v)) return null;
  const id = itemId(v.id), kind = oneOf(v.kind, ITEM_KINDS), pos = pos3(v.pos), value = int(v.value ?? 0, 0, WIRE_MAX_SHINE);
  return id !== null && kind && pos && value !== null ? { id, kind, pos, value } : null;
}
function spawnItems(v: unknown, max: number): SpawnItem[] | null {
  if (!Array.isArray(v) || v.length > max) return null;
  const items: SpawnItem[] = [];
  for (const r of v) { const it = spawnItem(r); if (!it) return null; items.push(it); }
  return items;
}
export const validateSpawn = safe((raw: unknown): SpawnEvent | null => {
  const e = evMsg(raw, 'spawn');
  if (!e) return null;
  const items = spawnItems(e.m.items, 64);
  return items ? { t: 'spawn', ...e.b, items } : null;
});
export const validateElim = safe((raw: unknown): ElimEvent | null => {
  const e = evMsg(raw, 'elim');
  if (!e) return null;
  const { m, b } = e;
  const victim = seatOf(m.victim), by = int(m.by, -1, MAX_SEATS - 1), cause = oneOf(m.cause, CAUSES), place = int(m.place, 1, MAX_SEATS);
  return victim !== null && by !== null && cause && place !== null && by !== victim ? { t: 'elim', ...b, victim, by, cause, place } : null;
});
export const validateSeatEvent = safe((raw: unknown): SeatEvent | null => {
  const e = evMsg(raw, 'seat');
  if (!e) return null;
  const seat = seatOf(e.m.seat), status = int(e.m.status, 0, 4) as SeatStatus | null;
  return seat !== null && status !== null ? { t: 'seat', ...e.b, seat, status } : null;
});
export const validateEnd = safe((raw: unknown): EndEvent | null => {
  const e = evMsg(raw, 'end');
  if (!e) return null;
  const { m, b } = e;
  const winner = int(m.winner, -1, MAX_SEATS - 1), order = seatList(m.order), why = oneOf(m.why ?? 'last', ['last', 'host', 'abort'] as const);
  return winner !== null && order && why ? { t: 'end', ...b, winner, order, why } : null;
});

const EVENTS: Record<HostEvent['t'], (raw: unknown) => HostEvent | null> = {
  dmg: validateDmg, zap: validateZap, fx: validateFx, got: validateGot, deny: validateDeny, spawn: validateSpawn, elim: validateElim, seat: validateSeatEvent, end: validateEnd,
};
export const validateHostEvent = safe((raw: unknown): HostEvent | null => {
  const m = obj(raw, MAX_JSON.events);
  if (!m || typeof m.t !== 'string' || !Object.prototype.hasOwnProperty.call(EVENTS, m.t)) return null;
  return EVENTS[m.t as HostEvent['t']](m);
});

/**
 * One host tick of verdicts: {"ep", "seq" (of the first), "at" (match ms), "ev": [verdicts without ep, seq, at]}.
 * Verdict i gets seq + i. Pass the events of one tick, already numbered consecutively.
 */
export function encodeEventBatch(events: readonly HostEvent[]): { ep: number; seq: number; at: number; ev: Record<string, unknown>[] } | null {
  if (!events.length || events.length > MAX_EVENTS_PER_BATCH) return null;
  const { ep, seq, at } = events[0];
  for (let i = 0; i < events.length; i++) if (events[i].ep !== ep || events[i].seq !== seq + i) return null;
  return { ep, seq, at: Math.round(at), ev: events.map(e => { const o: Record<string, unknown> = { ...e }; delete o.ep; delete o.seq; delete o.at; return o; }) };
}
/** a verdict batch, expanded and numbered; all or nothing, so the seq stream never gets holes from junk */
export const validateEventBatch = safe((raw: unknown): HostEvent[] | null => {
  const m = obj(raw, MAX_JSON.events);
  if (!m) return null;
  const ep = int(m.ep, 1, SEQ_MAX), seq = int(m.seq, 1, SEQ_MAX - MAX_EVENTS_PER_BATCH), at = num(m.at, -60000, 36e5);
  if (ep === null || seq === null || at === null || !Array.isArray(m.ev) || m.ev.length < 1 || m.ev.length > MAX_EVENTS_PER_BATCH) return null;
  const out: HostEvent[] = [];
  for (let i = 0; i < m.ev.length; i++) {
    const body: unknown = m.ev[i];
    if (!isObj(body)) return null;
    const e = validateHostEvent({ ...body, ep, seq: seq + i, at });
    if (!e) return null;
    out.push(e);
  }
  return out;
});

// ------------------------------------------------------------------ control

/** lvl: bot difficulty 0 Rookie, 1 Pilot, 2 Ace (GDD 6.11); -1 for humans */
export interface LobbySeat { seat: number; peer: string; name: string; bot: boolean; skin: string; lvl: number }
/**
 * The Signal plan, built by the host from the tuning module and sent in 'start'.
 * Phase i shrinks the previous circle to (x, z, r) between at and at + dur (ms
 * from GO); dps is the Static per second during that phase's hold and shrink;
 * ceil (world y) is reached ceilMs after at.
 */
export interface ZonePhase { at: number; dur: number; x: number; z: number; r: number; dps: number; ceil: number }
export interface ZoneSchedule { x: number; z: number; r: number; ceil: number; ceilMs: number; phases: ZonePhase[] }

/** who I am and what I want; token reclaims a seat after a drop (server phase) */
export interface HelloCtl { t: 'hello'; v: number; name: string; skin: string; want: 'play' | 'watch'; token: string }
/** host: who sits where before the start; startIn 0 means waiting */
export interface LobbyCtl { t: 'lobby'; ep: number; host: number; seats: LobbySeat[]; startIn: number }
/** server phase, to ONE pilot: your seat and the private token to reclaim it */
export interface YouCtl { t: 'you'; ep: number; seat: number; token: string }
/** host: GO is inMs from now; seed, seats and the Signal plan build the same match on every screen */
export interface StartCtl { t: 'start'; ep: number; match: string; seed: number; inMs: number; host: number; seats: LobbySeat[]; zone: ZoneSchedule; rules: number }
/**
 * Server phase only: the relay names a new host when the old one drops. P2P rooms
 * never send or accept it this cycle (host left ends the match); the P2P takeover
 * design is P1 in NETCODE.md.
 */
export interface HostCtl { t: 'host'; ep: number; seat: number; last: number }
/** pilot to host: I have a gap after seq from, send me everything */
export interface SyncCtl { t: 'sync'; from: number }
/**
 * host to one pilot or spectator: the complete replica (late join, spectators, gaps).
 * rings: (ring, seat) pairs of personal Shine rings already taken; shared:
 * (item, readyAtMatchMs) pairs for shared items waiting to respawn; caches: Shine caches lying around.
 */
export interface FullCtl {
  t: 'full'; ep: number; seq: number; match: string; seed: number; phase: Phase; host: number;
  seats: LobbySeat[]; world: WorldSnapshot; rings: number[]; shared: number[]; caches: SpawnItem[]; zone: ZoneSchedule; order: number[];
}
export interface PingCtl { t: 'ping'; n: number; ms: number }
/** echo of a ping; at is the host's match ms when a host answers, else -1 */
export interface PongCtl { t: 'pong'; n: number; ms: number; at: number }
/** server phase: a seat's pilot dropped or came back */
export interface GoneCtl { t: 'gone'; seat: number; why: 'left' | 'timeout' | 'kicked' }
export interface BackCtl { t: 'back'; seat: number }
export interface ByeCtl { t: 'bye' }
export type Ctl = HelloCtl | LobbyCtl | YouCtl | StartCtl | HostCtl | SyncCtl | FullCtl | PingCtl | PongCtl | GoneCtl | BackCtl | ByeCtl;
/** control messages only the current host (or the relay server) may send */
export const HOST_ONLY_CTL: readonly Ctl['t'][] = ['lobby', 'you', 'start', 'full', 'gone', 'back', 'host'];

function lobbySeats(v: unknown): LobbySeat[] | null {
  if (!Array.isArray(v) || v.length > MAX_SEATS) return null;
  const out: LobbySeat[] = [];
  for (const r of v) {
    if (!isObj(r)) return null;
    const seat = seatOf(r.seat), peer = peerId(r.peer ?? '');
    if (seat === null || peer === null || out.some(s => s.seat === seat)) return null;
    const bot = r.bot === true;
    out.push({
      seat, peer: bot ? '' : peer, name: text(r.name, 18, bot ? 'Bot' : 'Pilot'), bot,
      skin: typeof r.skin === 'string' && SKIN_RE.test(r.skin) ? r.skin : 'default',
      lvl: bot ? (int(r.lvl, 0, 2) ?? 1) : -1,
    });
  }
  return out;
}
export const validateZone = safe((raw: unknown): ZoneSchedule | null => {
  if (!isObj(raw)) return null;
  const x = num(raw.x, -WORLD_HALF, WORLD_HALF), z = num(raw.z, -WORLD_HALF, WORLD_HALF), r = num(raw.r, 1, 2 * WORLD_HALF);
  const ceil = num(raw.ceil, 0, Y_MAX), ceilMs = num(raw.ceilMs ?? 0, 0, 60000);
  if (x === null || z === null || r === null || ceil === null || ceilMs === null || !Array.isArray(raw.phases) || raw.phases.length > 12) return null;
  const phases: ZonePhase[] = [];
  for (const p of raw.phases) {
    if (!isObj(p)) return null;
    const at = num(p.at, 0, 36e5), dur = num(p.dur, 0, 6e5), px = num(p.x, -WORLD_HALF, WORLD_HALF), pz = num(p.z, -WORLD_HALF, WORLD_HALF);
    const pr = num(p.r, 0, 2 * WORLD_HALF), dps = num(p.dps, 0, 1000), pc = num(p.ceil, 0, Y_MAX);
    if (at === null || dur === null || px === null || pz === null || pr === null || dps === null || pc === null) return null;
    phases.push({ at, dur, x: px, z: pz, r: pr, dps, ceil: pc });
  }
  phases.sort((a, b) => a.at - b.at);
  return { x, z, r, ceil, ceilMs, phases };
});
function ctlMsg(raw: unknown, t: Ctl['t']): Record<string, unknown> | null {
  const m = obj(raw, MAX_JSON.ctl);
  return m && m.t === t ? m : null;
}
const matchId = (v: unknown) => (typeof v === 'string' && MATCH_RE.test(v) ? v : null);

export const validateHello = safe((raw: unknown): HelloCtl | null => {
  const m = ctlMsg(raw, 'hello');
  if (!m) return null;
  const v = int(m.v, 1, 1000), want = oneOf(m.want ?? 'play', ['play', 'watch'] as const);
  if (v === null || !want) return null;
  return {
    t: 'hello', v, name: text(m.name, 18, 'Pilot'), want,
    skin: typeof m.skin === 'string' && SKIN_RE.test(m.skin) ? m.skin : 'default',
    token: typeof m.token === 'string' && TOKEN_RE.test(m.token) ? m.token : '',
  };
});
export const validateLobby = safe((raw: unknown): LobbyCtl | null => {
  const m = ctlMsg(raw, 'lobby');
  if (!m) return null;
  const ep = int(m.ep, 0, SEQ_MAX), host = int(m.host, -1, MAX_SEATS - 1), seats = lobbySeats(m.seats), startIn = num(m.startIn, 0, 120000);
  return ep !== null && host !== null && seats && startIn !== null ? { t: 'lobby', ep, host, seats, startIn } : null;
});
export const validateYou = safe((raw: unknown): YouCtl | null => {
  const m = ctlMsg(raw, 'you');
  if (!m) return null;
  const ep = int(m.ep, 0, SEQ_MAX), seat = seatOf(m.seat), token = typeof m.token === 'string' && TOKEN_RE.test(m.token) ? m.token : null;
  return ep !== null && seat !== null && token !== null ? { t: 'you', ep, seat, token } : null;
});
export const validateStart = safe((raw: unknown): StartCtl | null => {
  const m = ctlMsg(raw, 'start');
  if (!m) return null;
  const ep = int(m.ep, 1, SEQ_MAX), match = matchId(m.match), seed = int(m.seed, 0, 2 ** 32 - 1), inMs = num(m.inMs, 0, 30000);
  const host = seatOf(m.host), seats = lobbySeats(m.seats), zone = validateZone(m.zone), rules = int(m.rules, 0, SEQ_MAX);
  if (ep === null || !match || seed === null || inMs === null || host === null || !seats || !zone || rules === null) return null;
  if (!seats.some(s => s.seat === host && !s.bot)) return null;    // the host must be a human in the roster
  return { t: 'start', ep, match, seed, inMs, host, seats, zone, rules };
});
export const validateHostCtl = safe((raw: unknown): HostCtl | null => {
  const m = ctlMsg(raw, 'host');
  if (!m) return null;
  const ep = int(m.ep, 1, SEQ_MAX), seat = seatOf(m.seat), last = int(m.last, 0, SEQ_MAX);
  return ep !== null && seat !== null && last !== null ? { t: 'host', ep, seat, last } : null;
});
export const validateSync = safe((raw: unknown): SyncCtl | null => {
  const m = ctlMsg(raw, 'sync');
  if (!m) return null;
  const from = int(m.from, 0, SEQ_MAX);
  return from !== null ? { t: 'sync', from } : null;
});
/** flat (id, value) pairs: ids 0 to 65535, values validated by the given check */
function pairs(v: unknown, max: number, second: (x: unknown) => number | null): number[] | null {
  if (!Array.isArray(v) || v.length > max * 2 || v.length % 2) return null;
  const out: number[] = [];
  for (let i = 0; i < v.length; i += 2) {
    const a = itemId(v[i]), b = second(v[i + 1]);
    if (a === null || b === null) return null;
    out.push(a, b);
  }
  return out;
}
export const validateFull = safe((raw: unknown): FullCtl | null => {
  const m = ctlMsg(raw, 'full');
  if (!m) return null;
  const ep = int(m.ep, 1, SEQ_MAX), seq = int(m.seq, 0, SEQ_MAX), match = matchId(m.match), seed = int(m.seed, 0, 2 ** 32 - 1);
  const phase = int(m.phase, 0, 3) as Phase | null, host = seatOf(m.host), seats = lobbySeats(m.seats);
  const world = validateWorldSnapshot(m.world), zone = validateZone(m.zone), caches = spawnItems(m.caches, 64), order = seatList(m.order);
  const rings = pairs(m.rings, 1024, seatOf), shared = pairs(m.shared, 256, x => num(x, -60000, 36e5));
  if (ep === null || seq === null || !match || seed === null || phase === null || host === null || !seats || !world || !zone || !caches || !order || !rings || !shared) return null;
  return { t: 'full', ep, seq, match, seed, phase, host, seats, world: { ...world, ep, seq }, rings, shared, caches, zone, order };
});
export const validatePing = safe((raw: unknown): PingCtl | null => {
  const m = ctlMsg(raw, 'ping');
  if (!m) return null;
  const n = int(m.n, 0, SEQ_MAX), ms = num(m.ms, 0, MAX_MS);
  return n !== null && ms !== null ? { t: 'ping', n, ms } : null;
});
export const validatePong = safe((raw: unknown): PongCtl | null => {
  const m = ctlMsg(raw, 'pong');
  if (!m) return null;
  const n = int(m.n, 0, SEQ_MAX), ms = num(m.ms, 0, MAX_MS), at = num(m.at ?? -1, -60000, 36e5);
  return n !== null && ms !== null && at !== null ? { t: 'pong', n, ms, at } : null;
});
export const validateGone = safe((raw: unknown): GoneCtl | null => {
  const m = ctlMsg(raw, 'gone');
  if (!m) return null;
  const seat = seatOf(m.seat), why = oneOf(m.why, ['left', 'timeout', 'kicked'] as const);
  return seat !== null && why ? { t: 'gone', seat, why } : null;
});
export const validateBack = safe((raw: unknown): BackCtl | null => {
  const m = ctlMsg(raw, 'back');
  if (!m) return null;
  const seat = seatOf(m.seat);
  return seat !== null ? { t: 'back', seat } : null;
});
export const validateBye = safe((raw: unknown): ByeCtl | null => (ctlMsg(raw, 'bye') ? { t: 'bye' } : null));

const CTLS: Record<Ctl['t'], (raw: unknown) => Ctl | null> = {
  hello: validateHello, lobby: validateLobby, you: validateYou, start: validateStart, host: validateHostCtl, sync: validateSync,
  full: validateFull, ping: validatePing, pong: validatePong, gone: validateGone, back: validateBack, bye: validateBye,
};
export const validateCtl = safe((raw: unknown): Ctl | null => {
  const m = obj(raw, MAX_JSON.ctl);
  if (!m || typeof m.t !== 'string' || !Object.prototype.hasOwnProperty.call(CTLS, m.t)) return null;
  return CTLS[m.t as Ctl['t']](m);
});

/**
 * Authority per action, the same on every peer and on the relay server: bot
 * batches, world snapshots, verdicts and host only control come from the host
 * that sent 'start' (P2P: its Trystero peer id, which comes from the DTLS
 * connection and cannot be forged in a payload), and from nobody else.
 */
export function senderMayUse(action: ActionKey, msg: { t?: unknown } | null, senderIsHost: boolean): boolean {
  if (action === 'rb' || action === 'rw' || action === 're') return senderIsHost;
  if (action === 'rx' && msg && (HOST_ONLY_CTL as readonly unknown[]).includes(msg.t)) return senderIsHost;
  return true;
}

// ------------------------------------------------------------------ sequence numbers, dedupe, ordering

export const SEQ_MOD = 2 ** 31;
/** serial number arithmetic: true when a is newer than b, wrap safe */
export function seqNewer(a: number, b: number): boolean {
  const d = (((a - b) % SEQ_MOD) + SEQ_MOD) % SEQ_MOD;
  return d !== 0 && d < SEQ_MOD / 2;
}
export class SeqCounter {
  private n: number;
  constructor(start = 0) { this.n = start; }
  next(): number { this.n = (this.n % (SEQ_MOD - 1)) + 1; return this.n; }
  get last(): number { return this.n; }
}

/** bounded set of seen keys, oldest forgotten first; add() is true the first time only */
export class DedupeSet {
  private seen = new Map<string | number, true>();
  private cap: number;
  constructor(cap = 4096) { this.cap = Math.max(16, cap | 0); }
  add(key: string | number): boolean {
    if (this.seen.has(key)) return false;
    this.seen.set(key, true);
    if (this.seen.size > this.cap) {
      const first = this.seen.keys().next();
      if (!first.done) this.seen.delete(first.value);
    }
    return true;
  }
  has(key: string | number): boolean { return this.seen.has(key); }
  get size(): number { return this.seen.size; }
  clear() { this.seen.clear(); }
}

/**
 * Applies host verdicts exactly once and in order. Duplicates and other terms
 * are dropped, early arrivals wait for the gap to fill, a gap older than gapMs
 * means: ask the host for a full sync.
 */
export class OrderedInbox<T extends { ep: number; seq: number }> {
  ep = 0;
  last = 0;
  private held = new Map<number, T>();
  private gapSince: number | null = null;
  private cap: number;
  constructor(cap = 256) { this.cap = cap; }
  /** the start of a match or a full sync: continue after `last` */
  reset(ep: number, last: number) { this.ep = ep; this.last = last; this.gapSince = null; for (const k of [...this.held.keys()]) if (!seqNewer(k, last)) this.held.delete(k); }
  /** returns the events now ready, in order */
  push(ev: T, nowMs: number): T[] {
    if (ev.ep !== this.ep) return [];
    if (!seqNewer(ev.seq, this.last)) return [];
    if (ev.seq !== (this.last % (SEQ_MOD - 1)) + 1) {
      if (this.held.size < this.cap) this.held.set(ev.seq, ev);
      if (this.gapSince === null) this.gapSince = nowMs;
      return [];
    }
    const out = [ev];
    this.last = ev.seq;
    for (;;) {
      const nxt = (this.last % (SEQ_MOD - 1)) + 1;
      const h = this.held.get(nxt);
      if (!h) break;
      this.held.delete(nxt); out.push(h); this.last = nxt;
    }
    if (!this.held.size) this.gapSince = null;      // a gap that is still open keeps its age
    return out;
  }
  /** a whole batch, in order */
  pushAll(evs: readonly T[], nowMs: number): T[] { const out: T[] = []; for (const e of evs) out.push(...this.push(e, nowMs)); return out; }
  needsSync(nowMs: number, gapMs = 1000): boolean { return this.gapSince !== null && nowMs - this.gapSince > gapMs; }
}

/** personal Shine rings: the host tracks who took which ring; each pilot takes each ring once */
export class PersonalRings {
  private takers = new Map<number, Set<number>>();
  /** true the first time this seat takes this ring */
  take(ring: number, seat: number): boolean {
    let s = this.takers.get(ring);
    if (!s) { s = new Set(); this.takers.set(ring, s); }
    if (s.has(seat)) return false;
    s.add(seat);
    return true;
  }
  has(ring: number, seat: number): boolean { return !!this.takers.get(ring)?.has(seat); }
  /** flat (ring, seat) pairs for the 'full' replica */
  toPairs(): number[] { const out: number[] = []; for (const [r, s] of this.takers) for (const seat of s) out.push(r, seat); return out; }
  static fromPairs(p: readonly number[]): PersonalRings { const r = new PersonalRings(); for (let i = 0; i + 1 < p.length; i += 2) r.take(p[i], p[i + 1]); return r; }
}

// ------------------------------------------------------------------ clocks

/**
 * Maps a remote clock onto ours. Follows the smallest observed delay at once and
 * drifts up slowly, so jitter never pulls a drone backwards (multiplayer.ts does
 * the same per pilot).
 */
export class OffsetFilter {
  offset: number | null = null;
  private drift: number;
  constructor(drift = 0.01) { this.drift = drift; }
  observe(remoteMs: number, localMs: number): number {
    const off = localMs - remoteMs;
    this.offset = this.offset === null || off < this.offset ? off : this.offset + (off - this.offset) * this.drift;
    return this.offset;
  }
  toLocal(remoteMs: number): number | null { return this.offset === null ? null : remoteMs + this.offset; }
}

// ------------------------------------------------------------------ rewind buffer and host checks

/**
 * Per drone history on the HOST's clock (sample times already mapped with that
 * pilot's OffsetFilter). 32 samples at 20 Hz keep 1.6 s, plenty for REWIND_MAX_MS.
 */
export class RewindBuffer {
  private d: Float64Array;
  private cap: number;
  private head = 0;           // next write slot
  private n = 0;
  constructor(cap = 32) { this.cap = Math.max(4, cap | 0); this.d = new Float64Array(this.cap * 7); }
  get size() { return this.n; }
  clear() { this.n = 0; this.head = 0; }
  /** i = 0 is the oldest kept sample */
  private slot(i: number) { return ((this.head - this.n + i + this.cap) % this.cap) * 7; }
  newestT(): number | null { return this.n ? this.d[this.slot(this.n - 1)] : null; }
  oldestT(): number | null { return this.n ? this.d[this.slot(0)] : null; }
  push(t: number, pos: Vec3, vel: Vec3): boolean {
    const last = this.newestT();
    if (last !== null && t <= last) return false;
    const o = this.head * 7;
    this.d[o] = t; this.d[o + 1] = pos[0]; this.d[o + 2] = pos[1]; this.d[o + 3] = pos[2]; this.d[o + 4] = vel[0]; this.d[o + 5] = vel[1]; this.d[o + 6] = vel[2];
    this.head = (this.head + 1) % this.cap;
    if (this.n < this.cap) this.n++;
    return true;
  }
  /** state at host time t into pos (and vel): interpolated, or extrapolated up to EXTRAPOLATE_MAX_MS past the newest sample */
  at(t: number, pos: Vec3, vel?: Vec3): boolean {
    if (!this.n) return false;
    const d = this.d;
    const first = this.slot(0), lastS = this.slot(this.n - 1);
    if (t < d[first] - 1) return false;
    if (t >= d[lastS]) {
      const dt = Math.min(t - d[lastS], EXTRAPOLATE_MAX_MS) / 1000;
      for (let j = 0; j < 3; j++) pos[j] = d[lastS + 1 + j] + d[lastS + 4 + j] * dt;
      if (vel) for (let j = 0; j < 3; j++) vel[j] = d[lastS + 4 + j];
      return true;
    }
    for (let i = this.n - 2; i >= 0; i--) {
      const a = this.slot(i);
      if (d[a] <= t || i === 0) {
        const b = this.slot(i + 1);
        const span = d[b] - d[a];
        const k = span > 1e-6 ? clamp((t - d[a]) / span, 0, 1) : 1;
        for (let j = 0; j < 3; j++) pos[j] = d[a + 1 + j] + (d[b + 1 + j] - d[a + 1 + j]) * k;
        if (vel) for (let j = 0; j < 3; j++) vel[j] = d[a + 4 + j] + (d[b + 4 + j] - d[a + 4 + j]) * k;
        return true;
      }
    }
    return false;
  }
  /** speed of the newest sample, for tolerances */
  speed(): number {
    if (!this.n) return 0;
    const s = this.slot(this.n - 1);
    return Math.hypot(this.d[s + 4], this.d[s + 5], this.d[s + 6]);
  }
  /** smallest distance between this drone and a fixed point over [t0, t1] */
  minDistance(p: Vec3, t0: number, t1: number, stepMs = 10): number {
    const q: Vec3 = [0, 0, 0];
    let best = Infinity;
    for (let t = t0; t <= t1 + 1e-6; t += stepMs) if (this.at(t, q)) best = Math.min(best, Math.hypot(q[0] - p[0], q[1] - p[1], q[2] - p[2]));
    return best;
  }
  /** visits consecutive sample pairs whose span touches [t0, t1] */
  segments(t0: number, t1: number, fn: (a: Vec3, b: Vec3) => boolean): boolean {
    const d = this.d;
    for (let i = 0; i < this.n - 1; i++) {
      const a = this.slot(i), b = this.slot(i + 1);
      if (d[b] < t0 || d[a] > t1) continue;
      if (fn([d[a + 1], d[a + 2], d[a + 3]], [d[b + 1], d[b + 2], d[b + 3]])) return true;
    }
    return false;
  }
}

export type Verdict = { ok: true } | { ok: false; why: DenyReason };
const OK: Verdict = { ok: true };
const no = (why: DenyReason): Verdict => ({ ok: false, why });
const dist3 = (a: Vec3, b: Vec3) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
/** a terrain, building and tree raycast from the host's world; optional everywhere */
export type Blocked = (a: Vec3, b: Vec3) => boolean;

/** PULSE path: straight line, no gravity, no velocity inheritance; every screen computes the same point */
export function projectileAt(o: Vec3, d: Vec3, speed: number, tauMs: number, out: Vec3 = [0, 0, 0]): Vec3 {
  const s = speed * Math.max(0, tauMs) / 1000;
  out[0] = o[0] + d[0] * s; out[1] = o[1] + d[1] * s; out[2] = o[2] + d[2] * s;
  return out;
}

export interface FireCheck {
  fire: FireClaim;
  /** fire.ms mapped to host time */
  fireT: number;
  shooter: RewindBuffer;
  /** the previous accepted fire.ms of this shooter, or null */
  lastFireMs: number | null;
  tier: number;
  /** shooter's streamed battery, 0 to 1 */
  soc: number;
  scrambled: boolean;
}
/** PULSE fire: not scrambled, battery, fire interval of the tier on the shooter's own clock, muzzle near its stream */
export function checkFire(c: FireCheck, L: RoyaleLimits): Verdict {
  if (c.scrambled) return no('phase');
  if (c.soc < L.pulseMinSoc) return no('battery');
  if (c.lastFireMs !== null && c.fire.ms - c.lastFireMs < tierLimits(L, c.tier).pulseIntervalMs * 0.85) return no('cooldown');
  if (c.shooter.minDistance(c.fire.o, c.fireT - 80, c.fireT + 80) > 4 + c.shooter.speed() * 0.1) return no('far');
  return OK;
}

export interface HitCheck {
  fire: FireClaim;
  hit: HitClaim;
  /** shooter tier when the shot left (bolt speed and range) */
  shooterTier: number;
  /** target tier (hit sphere) */
  targetTier: number;
  /** hit.ms mapped to host time with the shooter's OffsetFilter */
  hitT: number;
  hostNow: number;
  /** shooter round trip to the host, ms */
  shooterRttMs: number;
  target: RewindBuffer;
  blocked?: Blocked;
}
/**
 * Favor the shooter, within limits. The shooter saw the target INTERP_DELAY_MS in
 * the past plus its own one way latency, so the host rewinds the target that far
 * (never further than REWIND_MAX_MS) and checks the deterministic bolt against
 * it over a small window.
 */
export function checkHit(c: HitCheck, L: RoyaleLimits): Verdict {
  const { fire, hit } = c;
  const sl = tierLimits(L, c.shooterTier);
  if (hit.shot !== fire.id) return no('unknown');
  const tau = hit.ms - fire.ms;                       // both on the shooter's clock: exact
  if (tau < -5 || tau > (sl.pulseRange / sl.pulseSpeed) * 1000 + 60) return no('range');
  const p = projectileAt(fire.o, fire.d, sl.pulseSpeed, tau);
  // the reported impact point must lie on the path
  if (dist3(p, hit.p) > 1.5 + sl.pulseSpeed * 0.02) return no('far');
  const view = Math.max(c.hitT - INTERP_DELAY_MS - clamp(c.shooterRttMs, 0, 600) / 2, c.hostNow - REWIND_MAX_MS);
  const oldest = c.target.oldestT();
  if (oldest === null || view < oldest) return no('late');
  const reach = tierLimits(L, c.targetTier).hitRadius + 0.35 + c.target.speed() * 0.03;
  const q: Vec3 = [0, 0, 0], pp: Vec3 = [0, 0, 0];
  let near = false;
  for (let s = -60; s <= 60 && !near; s += 10) {
    if (!c.target.at(view + s, q)) continue;
    projectileAt(fire.o, fire.d, sl.pulseSpeed, tau + s, pp);
    near = dist3(q, pp) <= reach;
  }
  if (!near) return no('far');
  if (c.blocked && c.blocked(fire.o, p)) return no('blocked');
  return OK;
}

export interface JetCheck {
  jet: JetClaim;
  /** jet.ms mapped to host time */
  jetT: number;
  hostNow: number;
  shooterRttMs: number;
  shooterTier: number;
  targetTier: number;
  shooter: RewindBuffer;
  target: RewindBuffer;
  /** previous accepted jet tick on the shooter's clock, or null */
  lastJetMs: number | null;
  /** the shooter's streamed tank, litres */
  tank: number;
  scrambled: boolean;
  blocked?: Blocked;
}
/** one WATER JET tick: tier carries the jet, tick spacing, water in the tank, nozzle at the drone, target inside the stream */
export function checkJet(c: JetCheck, L: RoyaleLimits): Verdict {
  if (c.scrambled) return no('phase');
  if (!tierLimits(L, c.shooterTier).jet) return no('tier');
  if (c.tank <= 0) return no('empty');
  if (c.lastJetMs !== null && c.jet.ms - c.lastJetMs < L.jet.tickMs * 0.8) return no('cooldown');
  const t = c.jetT;
  if (c.shooter.minDistance(c.jet.o, t - 80, t + 80) > 3 + c.shooter.speed() * 0.1) return no('far');
  const view = Math.max(t - INTERP_DELAY_MS - clamp(c.shooterRttMs, 0, 600) / 2, c.hostNow - REWIND_MAX_MS);
  const oldest = c.target.oldestT();
  if (oldest === null || view < oldest) return no('late');
  const r = tierLimits(L, c.targetTier).hitRadius;
  const q: Vec3 = [0, 0, 0];
  let inside = false;
  for (let s = -60; s <= 60 && !inside; s += 20) {
    if (!c.target.at(view + s, q)) continue;
    const to: Vec3 = [q[0] - c.jet.o[0], q[1] - c.jet.o[1], q[2] - c.jet.o[2]];
    const dist = Math.hypot(to[0], to[1], to[2]);
    if (dist > L.jet.range + r + 1) continue;
    const cos = dist > 1e-3 ? (to[0] * c.jet.d[0] + to[1] * c.jet.d[1] + to[2] * c.jet.d[2]) / dist : 1;
    const half = (L.jet.coneDeg * Math.PI) / 180 + Math.atan2(r + 0.5, Math.max(dist, 0.5));
    inside = cos >= Math.cos(half);
  }
  if (!inside) return no('far');
  if (c.blocked && c.target.at(view, q) && c.blocked(c.jet.o, q)) return no('blocked');
  return OK;
}

export interface BurstCastCheck {
  burst: BurstClaim;
  /** burst.ms mapped to host time */
  burstT: number;
  caster: RewindBuffer;
  /** previous accepted burst.ms of this caster, or null */
  lastBurstMs: number | null;
  tier: number;
  soc: number;
  scrambled: boolean;
}
/** EMP or NOVA BURST cast: the caster's tier has this ability, cooldown, battery, centre at the caster */
export function checkBurstCast(c: BurstCastCheck, L: RoyaleLimits): Verdict {
  if (c.scrambled) return no('phase');
  if (tierLimits(L, c.tier).special !== c.burst.a) return no('tier');
  const b = L.bursts[c.burst.a];
  if (c.soc < b.minSoc) return no('battery');
  if (c.lastBurstMs !== null && c.burst.ms - c.lastBurstMs < b.cooldownMs * 0.95) return no('cooldown');
  if (c.caster.minDistance(c.burst.o, c.burstT - 80, c.burstT + 80) > 3 + c.caster.speed() * 0.1) return no('far');
  return OK;
}
/** is this drone inside an accepted burst at host time t, with line of sight from the centre */
export function checkBurstTarget(a: AbilityId, o: Vec3, t: number, target: RewindBuffer, targetTier: number, L: RoyaleLimits, blocked?: Blocked): Verdict {
  const q: Vec3 = [0, 0, 0];
  if (!target.at(t, q)) return no('late');
  if (dist3(o, q) > L.bursts[a].radius + tierLimits(L, targetTier).hitRadius) return no('range');
  if (blocked && blocked(o, q)) return no('blocked');
  return OK;
}

/**
 * Ram plausibility from both streams: the drones touched around host time t
 * (reach = sum of their sizes) and the closing speed the host sees. The host's
 * damage rule then uses min(claimed, seen + 3 m/s) as closing speed.
 */
export function checkRam(a: RewindBuffer, b: RewindBuffer, t: number, reach: number): { ok: boolean; closing: number } {
  const pa: Vec3 = [0, 0, 0], pb: Vec3 = [0, 0, 0], va: Vec3 = [0, 0, 0], vb: Vec3 = [0, 0, 0];
  let best = Infinity, closing = 0;
  for (let s = -150; s <= 100; s += 10) {
    if (!a.at(t + s, pa, va) || !b.at(t + s, pb, vb)) continue;
    const dd = dist3(pa, pb);
    best = Math.min(best, dd);
    if (dd > reach + 1) continue;
    const rv: Vec3 = [va[0] - vb[0], va[1] - vb[1], va[2] - vb[2]];
    // relative velocity along the line of centres; when the centres coincide, all of it
    const along = dd > 0.05 ? (rv[0] * (pb[0] - pa[0]) + rv[1] * (pb[1] - pa[1]) + rv[2] * (pb[2] - pa[2])) / dd : Math.hypot(rv[0], rv[1], rv[2]);
    closing = Math.max(closing, along);
  }
  return { ok: best <= reach + 1, closing };
}

/** Shine caches: the stream came within radius of the point around time t */
export function checkProximity(buf: RewindBuffer, t: number, point: Vec3, radius: number, windowMs = 200): Verdict {
  if (buf.oldestT() === null) return no('late');
  const slack = 0.75 + buf.speed() * 0.05;
  return buf.minDistance(point, t - windowMs, t + windowMs / 2) <= radius + slack ? OK : no('far');
}

/** rings: the streamed path crossed the ring's plane inside L.ringPass x radius around time t (either direction) */
export function checkRingPass(buf: RewindBuffer, t: number, center: Vec3, normal: Vec3, radius: number, L: RoyaleLimits): Verdict {
  const nl = Math.hypot(normal[0], normal[1], normal[2]) || 1;
  const n: Vec3 = [normal[0] / nl, normal[1] / nl, normal[2] / nl];
  const side = (p: Vec3) => (p[0] - center[0]) * n[0] + (p[1] - center[1]) * n[1] + (p[2] - center[2]) * n[2];
  // 20 Hz samples are coarse at 30 m/s (1.5 m apart): the slack covers the chord
  const slack = 0.75;
  const through = buf.segments(t - 400, t + 150, (a, b) => {
    const sa = side(a), sb = side(b);
    if ((sa > 0) === (sb > 0) || sa === sb) return false;
    const k = sa / (sa - sb);
    const x = a[0] + (b[0] - a[0]) * k, y = a[1] + (b[1] - a[1]) * k, z = a[2] + (b[2] - a[2]) * k;
    return Math.hypot(x - center[0], y - center[1], z - center[2]) <= radius * L.ringPass + slack;
  });
  return through ? OK : no('far');
}

// ------------------------------------------------------------------ motion guard (anti speed hack, anti teleport)

export interface MotionVerdict { ok: boolean; why: '' | 'teleport' | 'speed' | 'clock'; kick: boolean }

/**
 * Host side plausibility of one pilot's stream. maxSpeed is the envelope of the
 * pilot's CURRENT tier (RoyaleLimits.tiers[tier].vmax). Strikes decay over time;
 * a kick knocks the drone out (cause 'left' this cycle).
 */
export class MotionGuard {
  strikes = 0;
  private last: { ms: number; local: number; x: number; y: number; z: number } | null = null;
  private anchor: { ms: number; local: number } | null = null;
  private jumpOk = true;
  private rejects = 0;
  kickAt: number;
  constructor(kickAt = 8) { this.kickAt = kickAt; }
  /** call after the host itself moves the drone (launch slot) */
  allowJump() { this.jumpOk = true; }
  check(s: PilotState, localMs: number, maxSpeed: number): MotionVerdict {
    if (this.last) this.strikes = Math.max(0, this.strikes - (localMs - this.last.local) / 2000);
    let why: MotionVerdict['why'] = '';
    // a sender clock running fast makes every jump look slow: compare against ours
    if (!this.anchor || localMs - this.anchor.local > 10000) this.anchor = { ms: s.ms, local: localMs };
    else if ((s.ms - this.anchor.ms) - (localMs - this.anchor.local) > 0.08 * (localMs - this.anchor.local) + 500) {
      why = 'clock'; this.strikes += 3; this.anchor = { ms: s.ms, local: localMs };
    }
    const accept = () => { this.last = { ms: s.ms, local: localMs, x: s.pos[0], y: s.pos[1], z: s.pos[2] }; this.rejects = 0; };
    if (!this.last || this.jumpOk) { this.jumpOk = false; accept(); return { ok: true, why, kick: this.strikes >= this.kickAt }; }
    // elapsed time: the sender's word, but never more than really passed here plus jitter
    const dt = clamp((s.ms - this.last.ms) / 1000, 0.03, (localMs - this.last.local) / 1000 + 0.25);
    const dist = Math.hypot(s.pos[0] - this.last.x, s.pos[1] - this.last.y, s.pos[2] - this.last.z);
    const allowed = maxSpeed * 1.25 * dt + 2.5;
    const v = Math.hypot(s.vel[0], s.vel[1], s.vel[2]);
    let ok = true;
    if (dist > allowed * 2 + 5) {
      why = 'teleport'; this.strikes += 3; ok = false;
      // a real desync must not fail forever: after a few rejects the new place is taken (and paid for in strikes)
      if (++this.rejects >= 3) accept();
    } else {
      if (dist > allowed || v > maxSpeed * 1.3 + 3) { why = why || 'speed'; this.strikes += 1; }
      accept();
    }
    return { ok, why, kick: this.strikes >= this.kickAt };
  }
}

// ------------------------------------------------------------------ rate limiting

export class TokenBucket {
  private tokens: number;
  private lastMs: number | null = null;
  private rate: number;
  private burst: number;
  constructor(rate: number, burst: number) { this.rate = rate; this.burst = burst; this.tokens = burst; }
  take(nowMs: number, n = 1): boolean {
    if (this.lastMs !== null) this.tokens = Math.min(this.burst, this.tokens + (Math.max(0, nowMs - this.lastMs) / 1000) * this.rate);
    this.lastMs = nowMs;
    if (this.tokens < n) return false;
    this.tokens -= n;
    return true;
  }
}
export interface Limiter { msg: Record<ActionKey, TokenBucket>; claims: TokenBucket; events: TokenBucket }
/** buckets for one sender: messages per action plus items inside claim and verdict batches */
export function makeLimiter(): Limiter {
  const msg = {} as Record<ActionKey, TokenBucket>;
  for (const k of ACTION_KEYS as ActionKey[]) msg[k] = new TokenBucket(RATE_LIMITS[k].rate, RATE_LIMITS[k].burst);
  return { msg, claims: new TokenBucket(ITEM_LIMITS.rq.rate, ITEM_LIMITS.rq.burst), events: new TokenBucket(ITEM_LIMITS.re.rate, ITEM_LIMITS.re.burst) };
}

// ------------------------------------------------------------------ the Signal (interpreting the plan) and seeded randomness

/** small fast seeded RNG; the host sends the seed, every screen derives the same layout */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface ZoneNow { x: number; z: number; r: number; ceil: number; dps: number; phase: number; shrinking: boolean }
/** the Signal at a match time, computed locally on every screen from the plan in 'start': no per frame zone traffic */
export function zoneAt(z: ZoneSchedule, matchMs: number): ZoneNow {
  let x = z.x, zz = z.z, r = z.r, ceil = z.ceil, shrinking = false;
  const ph = z.phases;
  // current phase: the first whose shrink has not ended; after the last one, the last (overtime)
  let cur = ph.length - 1;
  for (let i = 0; i < ph.length; i++) if (matchMs < ph[i].at + ph[i].dur) { cur = i; break; }
  for (let i = 0; i < ph.length; i++) {
    const p = ph[i];
    if (matchMs < p.at) break;
    ceil += (p.ceil - ceil) * (z.ceilMs > 0 ? clamp((matchMs - p.at) / z.ceilMs, 0, 1) : 1);
    const k = p.dur > 0 ? clamp((matchMs - p.at) / p.dur, 0, 1) : 1;
    if (k < 1) { shrinking = true; x += (p.x - x) * k; zz += (p.z - zz) * k; r += (p.r - r) * k; break; }
    x = p.x; zz = p.z; r = p.r;
  }
  return { x, z: zz, r, ceil, dps: ph.length ? ph[Math.max(0, cur)].dps : 0, phase: cur, shrinking };
}
/** in the Signal: inside the cylinder and below the ceiling */
export function inSignal(z: ZoneNow, p: Vec3): boolean {
  return Math.hypot(p[0] - z.x, p[2] - z.z) <= z.r && p[1] <= z.ceil;
}
