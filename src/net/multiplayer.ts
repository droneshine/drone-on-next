import * as THREE from 'three';
import { joinRoom, selfId } from 'trystero';
import type { Room, MessageAction } from 'trystero';
import type { Game } from '../game/game';
import { DroneSpec, featured, FEATURED, validateSpec } from '../sim/spec';
import type { DroneSim } from '../sim/drone';
import { buildDroneVisual, animateProps, disposeVisual, DroneVisual } from '../render/droneModels';
import { sanitizeMap, sanitizePiece } from '../game/builder';
import type { BuildOp, MapData } from '../game/builder';
import { Collider } from '../world/colliders';
import { audio } from '../audio/audio';

// Peer to peer rooms: every pilot simulates their own drone and streams its
// state at 20 Hz. Others render it interpolated 100 ms in the past on the
// sender's own clock, which hides jitter. Signalling goes over public Nostr
// relays, gameplay data goes directly between browsers (WebRTC).
//
// Trust model: nothing that arrives is trusted. Every message is type checked
// and clamped, only the host may start or stop races or hand out the course,
// and the host is the pilot who has been in the room longest.

const APP_ID = 'droneon-by-droneshine-v1';
const SEND_HZ = 20;
const PARKED_HZ = 2;
const DELAY = 0.1;              // interpolation delay in seconds
const HIDE_AFTER = 2;           // silent pilots vanish and stop colliding
const DROP_AFTER = 15;          // and leave the room for good
const RESULTS_FOR = 7;          // results stay up, then free flight timing resumes
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

const F_SPRAY = 1, F_CRASH = 2, F_ARMED = 4, F_PARKED = 8;

/** x y z qx qy qz qw motor flags raceIdx raceTime senderMs gimbal */
type State = number[];
interface Hello { name: string; spec: DroneSpec; color: string; age: number; ask?: boolean; }
type RaceMsg =
  | { op: 'start'; inMs: number; grid: string[]; spacing: number }
  | { op: 'finish'; time: number }
  | { op: 'dnf' }
  | { op: 'abort' };
type NetBuild = BuildOp | { op: 'want' };

export interface RemotePilot {
  id: string;
  name: string;
  color: string;
  spec: DroneSpec;
  visual: DroneVisual | null;
  collider: Collider | null;
  /** samples on the sender's clock, oldest first */
  samples: { t: number; s: State }[];
  /** local time minus sender time, smallest seen, so jitter never pulls a drone backwards */
  offset: number | null;
  joinedAt: number;
  raceIdx: number;
  raceTime: number;
  finished: number | null;
  dnf: boolean;
  crashed: boolean;
  spraying: boolean;
  parked: boolean;
  pos: THREE.Vector3;
  lastSeen: number;
  lastBump: number;
  buildToken: number;
}

export interface Standing { id: string; name: string; color: string; idx: number; time: number; finished: number | null; dnf: boolean; self: boolean; }

function parse<T>(s: unknown, max = 2e6): T | null {
  if (typeof s !== 'string' || s.length > max) return null;
  try { const v = JSON.parse(s); return v && typeof v === 'object' ? v as T : null; } catch { return null; }
}
const fin = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const now = () => performance.now() / 1000;
const _lq = new THREE.Quaternion();
const _x = new THREE.Vector3(1, 0, 0);

const PILOT_COLORS = ['#b5f78a', '#8fc2f5', '#ffb259', '#ff7ab6', '#f7f7f2', '#c9a2ff', '#6ff0d9', '#ffd84d'];

function hashIdx(id: string) { let h = 0; for (const c of id) h = (h * 31 + c.charCodeAt(0)) >>> 0; return h % PILOT_COLORS.length; }

/** footprint a drone needs on the grid: prop tip to prop tip plus a margin */
function footprint(s: DroneSpec) { return s.armLength * 2 + s.propDiameter + 1.5; }

export function makeCode() {
  let s = '';
  const r = crypto.getRandomValues(new Uint8Array(4));
  for (const b of r) s += CODE_CHARS[b % CODE_CHARS.length];
  return s;
}

/** apply an edit to a map that is not on screen (the course parked during a mission) */
function applyToData(map: MapData, op: BuildOp): MapData {
  if (op.op === 'map') return sanitizeMap(op.map) ?? map;
  if (op.op === 'clear') return { ...map, pieces: [] };
  if (op.op === 'race') return { ...map, race: !!op.on };
  if (op.op === 'remove') return { ...map, pieces: map.pieces.filter(p => p.id !== op.id) };
  if (op.op === 'place') {
    const p = sanitizePiece(op.p);
    if (!p || map.pieces.length >= 2000) return map;
    const pieces = map.pieces.filter(q => q.id !== p.id);
    const i = typeof op.index === 'number' ? Math.max(0, Math.min(pieces.length, op.index | 0)) : pieces.length;
    pieces.splice(i, 0, p);
    return { ...map, pieces };
  }
  return map;
}

export class Multiplayer {
  room: Room;
  code: string;
  name: string;
  color = '#f7f7f2';
  pilots = new Map<string, RemotePilot>();
  private aState: MessageAction<State>;
  // structured messages travel as JSON strings, the state stream as a number array
  private aHello: MessageAction<string>;
  private aBuild: MessageAction<string>;
  private aRace: MessageAction<string>;
  private aChat: MessageAction<string>;
  private aBump: MessageAction<number[]>;
  private sendAcc = 0;
  private joinedAt = now();
  private colors = new Map<string, string>();
  private boundSim: DroneSim | null = null;
  private bumpFn = (id: string, n: THREE.Vector3, speed: number) => this.onLocalBump(id, n, speed);
  private needsCourse = false;
  private asked = new Map<string, number>();
  private onVis = () => { if (document.hidden && this.pilots.size) this.aState.send([0, -999, 0, 0, 0, 0, 1, 0, F_PARKED, 0, 0, Math.round(performance.now()), 0]); };
  private pageHide = () => { void this.room.leave(); };
  clock = now();
  // race
  raceState: 'idle' | 'countdown' | 'running' | 'done' = 'idle';
  countdownEnd = 0;
  raceStart = 0;
  private raceDeadline = Infinity;
  private doneAt = 0;
  /** pilots on the grid for the current race, self included when racing */
  grid = new Set<string>();
  selfFinish: number | null = null;
  selfDnf = false;
  winner: string | null = null;
  feed: { text: string; t: number }[] = [];
  listeners: ((ev: string, data?: unknown) => void)[] = [];

  constructor(private game: Game, code: string, name: string) {
    this.code = code.toUpperCase();
    this.name = name.slice(0, 18) || 'Pilot';
    this.room = joinRoom({ appId: APP_ID }, 'room-' + this.code);
    this.aState = this.room.makeAction<State>('st');
    this.aHello = this.room.makeAction<string>('hi');
    this.aBuild = this.room.makeAction<string>('bd');
    this.aRace = this.room.makeAction<string>('rc');
    this.aChat = this.room.makeAction<string>('ch');
    this.aBump = this.room.makeAction<number[]>('bp');
    this.color = this.colorOf(selfId);

    this.room.onPeerJoin = (id) => { this.aHello.send(JSON.stringify(this.hello()), { target: id }); };
    this.room.onPeerLeave = (id) => {
      const p = this.pilots.get(id);
      if (p) { this.say(`${p.name} left`); this.removePilot(id); }
    };
    this.aHello.onMessage = (h, { peerId }) => { const v = parse<Hello>(h, 1e5); if (v) this.onHello(peerId, v); };
    this.aState.onMessage = (s, { peerId }) => this.onState(peerId, s);
    this.aBuild.onMessage = (op, { peerId }) => { const v = parse<NetBuild>(op); if (v) this.onBuild(v, peerId); };
    this.aRace.onMessage = (m, { peerId }) => { const v = parse<RaceMsg>(m, 1e4); if (v) this.onRace(v, peerId); };
    this.aChat.onMessage = (t, { peerId }) => {
      const p = this.pilots.get(peerId);
      if (!p || typeof t !== 'string') return;
      this.say(`${p.name}: ${t.slice(0, 120)}`);
    };
    this.aBump.onMessage = (b, { peerId }) => this.onRemoteBump(peerId, b);
    // local build edits fan out to everybody
    this.game.builder.onOp = (op) => this.aBuild.send(JSON.stringify(op));
    // a closed tab or a killed app leaves at once instead of after the ICE timeout
    addEventListener('pagehide', this.pageHide);
    document.addEventListener('visibilitychange', this.onVis);
  }

  on(fn: (ev: string, data?: unknown) => void) { this.listeners.push(fn); }
  private emit(ev: string, data?: unknown) { for (const l of this.listeners) { try { l(ev, data); } catch (e) { console.error(e); } } }
  say(text: string) { this.feed.push({ text, t: this.clock }); if (this.feed.length > 6) this.feed.shift(); this.emit('feed'); }

  get selfId() { return selfId; }

  /** everyone in the room ordered by how long they have been here, oldest first */
  private order(): string[] {
    const all: { id: string; at: number }[] = [{ id: selfId, at: this.joinedAt }];
    // a pilot whose tab went quiet cannot host or hold a seat
    for (const p of this.pilots.values()) if (this.clock - p.lastSeen <= HIDE_AFTER) all.push({ id: p.id, at: p.joinedAt });
    // half a second counts as a tie so two pilots joining together agree on a host
    return all.sort((a, b) => (Math.abs(a.at - b.at) > 0.5 ? a.at - b.at : a.id < b.id ? -1 : 1)).map(x => x.id);
  }
  hostId() { return this.order()[0]; }
  isHost() { return this.hostId() === selfId; }
  /** spawn slot in free flight: joining never moves somebody who is already here */
  seat() { return Math.max(0, this.order().indexOf(selfId)); }
  /** spacing that fits the biggest drone in the room */
  gridSpacing() {
    let f = footprint(this.game.spec);
    for (const p of this.pilots.values()) f = Math.max(f, footprint(p.spec));
    return Math.max(3, f);
  }
  inRace() { return this.grid.has(selfId); }
  raceElapsed() { return Math.max(0, this.clock - this.raceStart); }

  private hello(ask = false): Hello {
    const s = { ...this.game.spec };
    delete s.glb;                       // models can be megabytes, peers rebuild from the spec
    return { name: this.name, spec: s, color: this.color, age: now() - this.joinedAt, ask };
  }

  /** call after the local drone or name changes */
  announce() { this.aHello.send(JSON.stringify(this.hello())); }
  rename(name: string) { this.name = name.slice(0, 18) || this.name; this.announce(); }

  private async onHello(id: string, h: Hello) {
    const raw = (h.spec && typeof h.spec === 'object') ? h.spec : featured('dscan');
    const spec = FEATURED.find(f => f.id === raw.id && f.name === raw.name) ?? validateSpec(raw);
    const name = String(h.name ?? 'Pilot').replace(/\s+/g, ' ').trim().slice(0, 18) || 'Pilot';
    let p = this.pilots.get(id);
    const isNew = !p;
    if (!p) {
      const age = fin(h.age) ? Math.max(0, Math.min(86400, h.age)) : 0;
      p = {
        id, name, color: '', spec, visual: null, collider: null, samples: [], offset: null,
        joinedAt: now() - age, raceIdx: 0, raceTime: 0, finished: null, dnf: false, crashed: false, spraying: false, parked: true,
        pos: new THREE.Vector3(0, -999, 0), lastSeen: this.clock, lastBump: 0, buildToken: 0,
      };
      this.pilots.set(id, p);
      p.color = this.colorOf(id);
      // greet back so both sides know each other even if one hello was lost
      this.aHello.send(JSON.stringify(this.hello()), { target: id });
      // only the host hands out the course, and only to pilots who arrived after it
      if (this.isHost() && p.joinedAt > this.joinedAt) this.sendCourse(id);
    } else {
      p.lastSeen = this.clock;
      if (p.name !== name) { this.say(`${p.name} is now ${name}`); p.name = name; }
      if (h.ask) this.aHello.send(JSON.stringify(this.hello()), { target: id });
    }
    if (isNew || p.spec.id !== spec.id || p.spec.name !== spec.name || p.spec.layout !== spec.layout || p.spec.armLength !== spec.armLength) {
      p.spec = spec;
      const token = ++p.buildToken;
      const visual = await buildDroneVisual(spec);
      // the pilot left or changed drone again while this one was building
      if (this.pilots.get(id) !== p || token !== p.buildToken) { disposeVisual(visual); return; }
      if (p.visual) { this.game.world.scene.remove(p.visual.root); disposeVisual(p.visual); }
      p.visual = visual;
      p.visual.root.visible = false;
      this.game.world.scene.add(p.visual.root);
      if (p.collider) this.game.world.colliders.remove(p.collider);
      p.collider = this.game.world.colliders.add({ kind: 'sphere', radius: spec.armLength + spec.propDiameter * 0.35 }, new THREE.Vector3(0, -999, 0), undefined, { tag: 'player', data: id, surface: 'hard' });
    }
    if (isNew) { this.say(`${p.name} joined`); audio.chime(2); }
    this.emit('pilots');
  }

  private sendCourse(target?: string) {
    const g = this.game;
    const map = g.courseBeforeMission?.map ?? g.builder.map;
    this.aBuild.send(JSON.stringify({ op: 'map', map }), target ? { target } : undefined);
  }

  private onState(id: string, s: State) {
    const p = this.pilots.get(id);
    if (!p) {
      // a pilot we dropped (their tab slept) is back: ask who they are
      const t = this.asked.get(id) ?? -1e9;
      if (this.clock - t > 3) { this.asked.set(id, this.clock); this.aHello.send(JSON.stringify(this.hello(true)), { target: id }); }
      return;
    }
    if (!Array.isArray(s) || s.length < 12) return;
    for (let i = 0; i < 12; i++) if (!fin(s[i])) return;
    const ts = s[11] / 1000;
    const last = p.samples[p.samples.length - 1];
    if (last && ts <= last.t) return;             // out of order or replayed
    const local = now();
    const off = local - ts;
    // follow the smallest delay at once, drift up slowly when the path gets slower
    p.offset = p.offset == null || off < p.offset ? off : p.offset + (off - p.offset) * 0.01;
    p.samples.push({ t: ts, s });
    if (p.samples.length > 16) p.samples.shift();
    p.lastSeen = this.clock;
    p.raceIdx = Math.max(0, Math.min(999, s[9] | 0));
    p.raceTime = Math.max(0, Math.min(36000, s[10]));
    p.parked = !!(s[8] & F_PARKED);
  }

  private removePilot(id: string) {
    const p = this.pilots.get(id);
    if (!p) return;
    p.buildToken++;
    if (p.visual) { this.game.world.scene.remove(p.visual.root); disposeVisual(p.visual); }
    if (p.collider) this.game.world.colliders.remove(p.collider);
    this.pilots.delete(id);
    this.colors.delete(id);
    if (this.grid.delete(id)) this.checkWinner();
    this.emit('pilots');
  }

  // ------------------------------------------------------------------ build
  private onBuild(op: NetBuild, from: string) {
    if (!this.pilots.has(from)) return;
    const g = this.game;
    if (op.op === 'want') { if (this.isHost()) this.sendCourse(from); return; }
    // the course itself only ever comes from the host
    if (op.op === 'map') {
      if (from !== this.hostId()) return;
      const m = sanitizeMap(op.map);
      if (!m) return;
      if (g.courseBeforeMission) g.courseBeforeMission = { map: m, origin: 'room' };
      else { g.builder.load(m, { origin: 'room' }); if (this.raceState === 'idle') g.resetRace(); }
      this.needsCourse = false;
      this.say(`Course: ${m.name}`);
      this.emit('build');
      return;
    }
    if (op.op !== 'place' && op.op !== 'remove' && op.op !== 'clear' && op.op !== 'race') return;
    if (op.op === 'remove' && (typeof op.id !== 'string' || op.id.length > 40)) return;
    if (g.courseBeforeMission) {
      // flying a mission: keep the parked course in step so nothing is lost
      g.courseBeforeMission = { map: applyToData(g.courseBeforeMission.map, op), origin: 'room' };
    } else {
      g.builder.applyRemote(op);
      g.builder.origin = 'room';
      if (this.raceState === 'idle') g.resetRace();
    }
    this.emit('build');
  }

  // ------------------------------------------------------------------ race
  startRace() {
    const g = this.game;
    if (!this.isHost()) { g.toast('Only the host can start the race'); return; }
    if (this.raceState === 'countdown' || this.raceState === 'running') { g.toast('A race is already on'); return; }
    if (!g.builder.map.race) { g.toast('Race is switched off for this course. Turn it on in Build'); return; }
    if (g.builder.checkpoints().length < 2) { g.toast('Place at least two rings or gates first'); return; }
    // everybody who is out flying lines up; pilots in build, menus or missions sit it out
    const grid = this.order().filter(id => id === selfId ? g.state === 'fly' : !this.pilots.get(id)!.parked);
    if (!grid.length) { g.toast('Nobody is in the air to race'); return; }
    const msg: RaceMsg = { op: 'start', inMs: 4000, grid, spacing: this.gridSpacing() };
    this.aRace.send(JSON.stringify(msg));
    this.onRace(msg, selfId);
  }

  abortRace() {
    if (!this.isHost() || this.raceState === 'idle') return;
    const msg: RaceMsg = { op: 'abort' };
    this.aRace.send(JSON.stringify(msg));
    this.onRace(msg, selfId);
  }

  private onRace(m: RaceMsg, from: string) {
    const g = this.game;
    if (m.op === 'start') {
      if (from !== this.hostId()) return;
      if (!Array.isArray(m.grid) || !fin(m.inMs) || !fin(m.spacing)) return;
      const known = new Set([selfId, ...this.pilots.keys()]);
      const grid = m.grid.filter((id): id is string => typeof id === 'string' && known.has(id)).slice(0, 16);
      if (!grid.length) return;
      this.grid = new Set(grid);
      this.raceState = 'countdown';
      this.countdownEnd = this.clock + Math.max(1, Math.min(10, m.inMs / 1000));
      this.raceDeadline = Infinity;
      this.selfFinish = null; this.selfDnf = false; this.winner = null;
      for (const p of this.pilots.values()) { p.finished = null; p.dnf = false; p.raceIdx = 0; p.raceTime = 0; }
      if (this.grid.has(selfId)) {
        if (g.state !== 'fly') {
          // the race started while this pilot was busy elsewhere
          this.grid.delete(selfId);
          this.aRace.send(JSON.stringify({ op: 'dnf' }));
        } else {
          // line up on a grid behind the start pad in seat order
          const slot = grid.indexOf(selfId);
          const start = g.builder.startPad();
          const base = start?.pos ?? g.world.pads[1].clone();
          const yaw = start?.yaw ?? 0;
          const side = new THREE.Vector3(Math.cos(yaw), 0, -Math.sin(yaw));
          const back = new THREE.Vector3(Math.sin(yaw), 0, Math.cos(yaw));
          const spacing = Math.max(3, Math.min(30, m.spacing), this.gridSpacing());
          const pos = base.clone().addScaledVector(side, ((slot % 4) - 1.5) * spacing).addScaledVector(back, Math.floor(slot / 4) * spacing);
          pos.y = g.world.colliders.heightAt(pos.x, pos.z) + 0.1;
          g.setHome(pos, yaw);
          g.resetDrone();
          g.resetRace();
          g.raceLocked = true;
        }
      }
      this.emit('race');
    } else if (m.op === 'finish') {
      const p = this.pilots.get(from);
      if (!p || !this.grid.has(from) || p.finished != null || (this.raceState !== 'running' && this.raceState !== 'countdown')) return;
      if (!fin(m.time) || m.time <= 0 || m.time > 3600) return;
      p.finished = Math.round(m.time * 100) / 100;
      this.say(`${p.name} finished in ${p.finished.toFixed(2)} s`);
      this.checkWinner();
    } else if (m.op === 'dnf') {
      const p = this.pilots.get(from);
      if (!p || !this.grid.has(from)) return;
      p.dnf = true;
      this.checkWinner();
    } else if (m.op === 'abort') {
      if (from !== this.hostId()) return;
      this.endRace();
      this.say('Race called off');
    }
  }

  /** called by the game when the local pilot completes the course */
  localFinish(time: number) {
    if (this.raceState !== 'running' || this.selfFinish != null || !this.grid.has(selfId)) return;
    this.selfFinish = Math.round(time * 100) / 100;
    this.aRace.send(JSON.stringify({ op: 'finish', time: this.selfFinish }));
    this.checkWinner();
  }

  private checkWinner() {
    if (this.raceState !== 'running' && this.raceState !== 'countdown') return;
    const field = this.standings().filter(s => this.grid.has(s.id));
    const done = field.filter(s => s.finished != null).sort((a, b) => a.finished! - b.finished!);
    if (done.length && !this.winner) {
      const w = done[0];
      this.winner = w.self ? 'self' : w.name;
      // everyone else gets a fair chance to come home, then it is a did not finish
      this.raceDeadline = this.clock + Math.max(30, w.finished! * 0.6);
      this.emit('winner', w);
    }
    if (field.every(s => s.finished != null || s.dnf)) this.finishRace();
  }

  private finishRace() {
    if (this.raceState === 'done') return;
    this.raceState = 'done';
    this.doneAt = this.clock;
    this.game.raceLocked = false;
    this.emit('race');
  }

  private endRace() {
    this.raceState = 'idle';
    this.grid.clear();
    this.raceDeadline = Infinity;
    this.game.raceLocked = false;
    if (this.game.state === 'fly') this.game.resetRace();
    this.emit('race');
  }

  colorOf(id: string) {
    const have = this.colors.get(id);
    if (have) return have;
    // first come keeps its colour; later pilots take the next free one
    const used = new Set(this.colors.values());
    let i = hashIdx(id);
    for (let k = 0; k < PILOT_COLORS.length && used.has(PILOT_COLORS[i]); k++) i = (i + 1) % PILOT_COLORS.length;
    this.colors.set(id, PILOT_COLORS[i]);
    return PILOT_COLORS[i];
  }

  standings(): Standing[] {
    const racing = this.raceState !== 'idle';
    const me: Standing = { id: selfId, name: this.name, color: this.colorOf(selfId), idx: this.game.raceIdx, time: this.game.raceTime, finished: this.selfFinish, dnf: this.selfDnf, self: true };
    const others = [...this.pilots.values()].map(p => ({ id: p.id, name: p.name, color: this.colorOf(p.id), idx: p.raceIdx, time: p.raceTime, finished: p.finished, dnf: p.dnf, self: false }));
    const all = [me, ...others];
    if (!racing) return all;
    const inField = (s: Standing) => this.grid.has(s.id);
    return all.sort((a, b) => {
      if (inField(a) !== inField(b)) return inField(a) ? -1 : 1;
      if (a.dnf !== b.dnf) return a.dnf ? 1 : -1;
      if (a.finished != null || b.finished != null) return (a.finished ?? 1e9) - (b.finished ?? 1e9);
      return b.idx - a.idx || a.time - b.time;
    });
  }

  chat(text: string) {
    const t = text.replace(/\s+/g, ' ').trim().slice(0, 120);
    if (!t) return;
    this.aChat.send(t);
    this.say(`${this.name}: ${t}`);
  }

  // ------------------------------------------------------------------ bumps
  /** the local drone touched another pilot: tell them how hard */
  private onLocalBump(id: string, n: THREE.Vector3, speed: number) {
    const p = this.pilots.get(id);
    if (!p || this.clock - p.lastBump < 0.3 || speed < 0.8) return;
    p.lastBump = this.clock;
    const s = this.game.sim;
    // n points from them to us, so they get pushed along -n
    this.aBump.send([-n.x, -n.y, -n.z, Math.min(40, speed), s.totalMass], { target: id });
  }

  private onRemoteBump(from: string, b: number[]) {
    const p = this.pilots.get(from);
    const s = this.game.sim;
    if (!p || !s || !Array.isArray(b) || b.length < 5 || !b.every(fin)) return;
    if (this.clock - p.lastBump < 0.3 || this.game.state !== 'fly' || this.game.paused || s.crashed) return;
    p.lastBump = this.clock;
    const dir = new THREE.Vector3(b[0], b[1], b[2]);
    if (dir.lengthSq() < 1e-6) return;
    dir.normalize();
    const speed = Math.min(40, Math.max(0, b[3]));
    const theirMass = Math.min(200, Math.max(0.01, b[4]));
    // momentum shared by mass: a whoop barely nudges a DSolar, a DSolar flattens a whoop
    const dv = speed * 1.2 * theirMass / (theirMass + s.totalMass);
    s.vel.addScaledVector(dir, dv);
    s.w.x += (Math.random() - 0.5) * dv * 3;
    s.w.z += (Math.random() - 0.5) * dv * 3;
    if (dv > 5) s.crash('Mid air collision');
    else if (dv > 0.5) audio.impact(Math.min(5, dv * 2));
  }

  // ------------------------------------------------------------------ per frame
  update(dt: number) {
    this.clock = now();
    const g = this.game;
    if (g.sim !== this.boundSim) {
      if (this.boundSim) this.boundSim.bumpListeners = this.boundSim.bumpListeners.filter(f => f !== this.bumpFn);
      this.boundSim = g.sim ?? null;
      this.boundSim?.bumpListeners.push(this.bumpFn);
    }
    // came back from a mission while edits flowed: make sure the course matches the room
    if (g.state !== 'mission' && g.state !== 'result' && this.needsCourse && !this.isHost()) { this.needsCourse = false; this.aBuild.send(JSON.stringify({ op: 'want' }), { target: this.hostId() }); }
    if (g.state === 'mission') this.needsCourse = true;

    // race clock
    if (this.raceState === 'countdown' && this.clock >= this.countdownEnd) {
      this.raceState = 'running'; this.raceStart = this.countdownEnd; g.raceLocked = false;
      if (this.grid.has(selfId)) audio.success();
      this.emit('race');
    }
    if (this.raceState === 'running') {
      if (this.grid.has(selfId) && this.selfFinish == null && !this.selfDnf && g.state !== 'fly') {
        // left the race for build, a mission or the menu
        this.selfDnf = true; this.aRace.send(JSON.stringify({ op: 'dnf' })); this.checkWinner();
      }
      if (this.clock > this.raceDeadline || this.raceElapsed() > 600) {
        if (this.grid.has(selfId) && this.selfFinish == null && !this.selfDnf) { this.selfDnf = true; g.toast('Did not finish'); }
        for (const p of this.pilots.values()) if (this.grid.has(p.id) && p.finished == null) p.dnf = true;
        this.finishRace();
      }
    }
    if (this.raceState === 'done' && this.clock - this.doneAt > RESULTS_FOR) this.endRace();

    // send own state; a parked pilot only keeps the line warm
    const parked = !g.sim || g.state !== 'fly' || g.paused;
    this.sendAcc += dt;
    const period = 1 / (parked ? PARKED_HZ : SEND_HZ);
    if (this.sendAcc >= period && this.pilots.size) {
      this.sendAcc = Math.min(this.sendAcc - period, period);
      const s = g.sim;
      const r = (v: number, k = 1000) => Math.round(v * k) / k;
      if (s) {
        const motor = s.motors.reduce((a, m) => a + m.s, 0) / s.motors.length;
        const flags = (g.spraying && !parked ? F_SPRAY : 0) | (s.crashed ? F_CRASH : 0) | (s.armed ? F_ARMED : 0) | (parked ? F_PARKED : 0);
        this.aState.send([r(s.pos.x), r(s.pos.y), r(s.pos.z), r(s.quat.x, 1e4), r(s.quat.y, 1e4), r(s.quat.z, 1e4), r(s.quat.w, 1e4), r(motor, 100), flags, g.raceIdx, r(g.raceTime, 100), Math.round(performance.now()), Math.round(g.gimbalPitch)]);
      } else {
        this.aState.send([0, -999, 0, 0, 0, 0, 1, 0, F_PARKED, 0, 0, Math.round(performance.now()), 0]);
      }
    }

    // render remote pilots in the past on their own clock, never guessing ahead
    const qa = new THREE.Quaternion(), qb = new THREE.Quaternion();
    for (const p of [...this.pilots.values()]) {
      const silent = this.clock - p.lastSeen;
      if (silent > DROP_AFTER) { this.say(`${p.name} lost connection`); this.removePilot(p.id); continue; }
      const S = p.samples;
      const gone = !p.visual || !S.length || p.offset == null || silent > HIDE_AFTER || p.parked;
      if (gone) {
        if (p.visual) p.visual.root.visible = false;
        if (p.collider && p.collider.pos.y > -900) g.world.colliders.move(p.collider, new THREE.Vector3(0, -999, 0), p.collider.quat);
        p.pos.set(0, -999, 0);
        continue;
      }
      const v = p.visual!;
      const tr = this.clock - p.offset! - DELAY;
      let a = S[0], b = S[0];
      if (tr >= S[S.length - 1].t) { a = b = S[S.length - 1]; }
      else for (let i = 0; i < S.length - 1; i++) if (S[i].t <= tr && S[i + 1].t > tr) { a = S[i]; b = S[i + 1]; break; }
      const span = b.t - a.t;
      const k = span > 1e-4 ? THREE.MathUtils.clamp((tr - a.t) / span, 0, 1) : 1;
      p.pos.set(a.s[0] + (b.s[0] - a.s[0]) * k, a.s[1] + (b.s[1] - a.s[1]) * k, a.s[2] + (b.s[2] - a.s[2]) * k);
      qa.set(a.s[3], a.s[4], a.s[5], a.s[6]).normalize(); qb.set(b.s[3], b.s[4], b.s[5], b.s[6]).normalize();
      v.root.position.copy(p.pos);
      v.root.quaternion.copy(qa).slerp(qb, k);
      v.root.visible = true;
      const motor = Math.max(0, Math.min(1, b.s[7]));
      animateProps(v, v.props.map(() => motor), dt, Math.min(30000, 2400 / p.spec.propDiameter * 1.6));
      const gimbal = fin(b.s[12]) ? Math.max(-90, Math.min(30, b.s[12])) : -15;
      if (v.lance) v.lance.rotation.x = THREE.MathUtils.degToRad(gimbal);
      p.spraying = !!(b.s[8] & F_SPRAY); p.crashed = !!(b.s[8] & F_CRASH);
      if (p.collider) g.world.colliders.move(p.collider, p.pos, p.collider.quat);
      if (p.spraying && p.spec.tool !== 'none') this.remoteSpray(p, v);
    }
  }

  private remoteSpray(p: RemotePilot, v: DroneVisual) {
    const g = this.game;
    const lance = p.spec.tool === 'lance' && v.lance;
    const q = v.root.quaternion;
    for (const nz of v.nozzles.slice(0, 4)) {
      let o: THREE.Vector3, d: THREE.Vector3;
      if (lance) {
        // nozzle sits on the lance, which pitches with the pilot's gimbal about its mount
        const lq = _lq.setFromAxisAngle(_x, v.lance!.rotation.x);
        const pivot = v.lance!.position;
        o = nz.pos.clone().sub(pivot).applyQuaternion(lq).add(pivot).applyQuaternion(q).add(p.pos);
        d = nz.dir.clone().applyQuaternion(lq).applyQuaternion(q);
      } else {
        o = nz.pos.clone().applyQuaternion(q).add(p.pos);
        d = nz.dir.clone().applyQuaternion(q);
      }
      const n = lance ? 8 : 3, speed = lance ? 22 : 6, spread = lance ? 0.8 : 2;
      for (let i = 0; i < n; i++) g.particles.emit(o, d.clone().multiplyScalar(speed).add(new THREE.Vector3((Math.random() - 0.5) * spread, (Math.random() - 0.5) * spread * 0.5, (Math.random() - 0.5) * spread)), 0.9, lance ? 0.03 : 0.04, 0.85, 0.93, 1, 0.5);
    }
  }

  async leave() {
    removeEventListener('pagehide', this.pageHide);
    document.removeEventListener('visibilitychange', this.onVis);
    this.game.builder.onOp = null;
    if (this.boundSim) this.boundSim.bumpListeners = this.boundSim.bumpListeners.filter(f => f !== this.bumpFn);
    for (const id of [...this.pilots.keys()]) this.removePilot(id);
    this.game.raceLocked = false;
    this.raceState = 'idle';
    try { await this.room.leave(); } catch { /* already gone */ }
  }
}
