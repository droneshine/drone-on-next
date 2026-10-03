import * as THREE from 'three';
import { joinRoom, selfId } from 'trystero';
import type { Room, MessageAction } from 'trystero';
import type { Game } from '../game/game';
import { DroneSpec, FEATURED, validateSpec } from '../sim/spec';
import { buildDroneVisual, animateProps, DroneVisual } from '../render/droneModels';
import type { MapData, Piece } from '../game/builder';
import { Collider } from '../world/colliders';
import { audio } from '../audio/audio';

// Peer to peer rooms: every pilot simulates their own drone and streams its
// state at 20 Hz. Others render it interpolated 100 ms in the past, which hides
// jitter. Signalling goes over public Nostr relays, gameplay data goes
// directly between browsers (WebRTC).

const APP_ID = 'droneon-by-droneshine-v1';
const SEND_HZ = 20;
const DELAY = 0.1;              // interpolation delay in seconds
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

type State = number[];          // x y z qx qy qz qw motor flags raceIdx raceTime
interface Hello { name: string; spec: DroneSpec; color: string; }
type BuildOp = { op: 'place'; p: Piece } | { op: 'remove'; i: number } | { op: 'clear' } | { op: 'map'; map: MapData };
type RaceMsg = { op: 'start'; inMs: number; seed: number } | { op: 'finish'; time: number } | { op: 'abort' };

export interface RemotePilot {
  id: string;
  name: string;
  color: string;
  spec: DroneSpec;
  visual: DroneVisual | null;
  collider: Collider | null;
  samples: { t: number; s: State }[];
  raceIdx: number;
  raceTime: number;
  finished: number | null;
  crashed: boolean;
  spraying: boolean;
  pos: THREE.Vector3;
  lastSeen: number;
}

export interface Standing { id: string; name: string; color: string; idx: number; time: number; finished: number | null; self: boolean; }

function parse<T>(s: unknown): T | null { try { return typeof s === 'string' && s.length < 2e6 ? JSON.parse(s) as T : null; } catch { return null; } }

const PILOT_COLORS = ['#b5f78a', '#8fc2f5', '#ffb259', '#ff7ab6', '#f7f7f2', '#c9a2ff', '#6ff0d9', '#ffd84d'];

export function makeCode() {
  let s = '';
  const r = crypto.getRandomValues(new Uint8Array(4));
  for (const b of r) s += CODE_CHARS[b % CODE_CHARS.length];
  return s;
}

export class Multiplayer {
  room: Room;
  code: string;
  name: string;
  color: string;
  pilots = new Map<string, RemotePilot>();
  private aState: MessageAction<State>;
  // structured messages travel as JSON strings, the state stream as a number array
  private aHello: MessageAction<string>;
  private aBuild: MessageAction<string>;
  private aRace: MessageAction<string>;
  private aChat: MessageAction<string>;
  private sendAcc = 0;
  clock = 0;
  // race
  raceState: 'idle' | 'countdown' | 'running' | 'done' = 'idle';
  countdownEnd = 0;
  raceStart = 0;
  selfFinish: number | null = null;
  winner: string | null = null;
  private applyingRemote = false;
  feed: { text: string; t: number }[] = [];
  listeners: ((ev: string, data?: unknown) => void)[] = [];

  constructor(private game: Game, code: string, name: string) {
    this.code = code.toUpperCase();
    this.name = name.slice(0, 18) || 'Pilot';
    this.color = PILOT_COLORS[parseInt(selfId.slice(0, 6), 36) % PILOT_COLORS.length];
    this.room = joinRoom({ appId: APP_ID }, 'room-' + this.code);
    this.aState = this.room.makeAction<State>('st');
    this.aHello = this.room.makeAction<string>('hi');
    this.aBuild = this.room.makeAction<string>('bd');
    this.aRace = this.room.makeAction<string>('rc');
    this.aChat = this.room.makeAction<string>('ch');

    this.room.onPeerJoin = (id) => {
      this.aHello.send(JSON.stringify(this.hello()), { target: id });
      // the host brings newcomers up to date with the shared course
      if (this.isHost()) this.aBuild.send(JSON.stringify({ op: 'map', map: this.game.builder.map }), { target: id });
    };
    this.room.onPeerLeave = (id) => {
      const p = this.pilots.get(id);
      if (p) { this.say(`${p.name} left`); this.removePilot(id); }
    };
    this.aHello.onMessage = (h, { peerId }) => { const v = parse<Hello>(h); if (v) this.onHello(peerId, v); };
    this.aState.onMessage = (s, { peerId }) => {
      const p = this.pilots.get(peerId);
      if (!p || !Array.isArray(s) || s.length < 11) return;
      p.samples.push({ t: this.clock, s });
      if (p.samples.length > 12) p.samples.shift();
      p.lastSeen = this.clock;
      p.raceIdx = s[9]; p.raceTime = s[10];
    };
    this.aBuild.onMessage = (op) => { const v = parse<BuildOp>(op); if (v) this.onBuild(v); };
    this.aRace.onMessage = (m, { peerId }) => { const v = parse<RaceMsg>(m); if (v) this.onRace(v, peerId); };
    this.aChat.onMessage = (t, { peerId }) => {
      const p = this.pilots.get(peerId);
      this.say(`${p?.name ?? 'Pilot'}: ${String(t).slice(0, 120)}`);
    };
    // local build edits fan out to everybody
    this.game.builder.onOp = (op) => { if (!this.applyingRemote) this.aBuild.send(JSON.stringify(op)); };
  }

  on(fn: (ev: string, data?: unknown) => void) { this.listeners.push(fn); }
  private emit(ev: string, data?: unknown) { for (const l of this.listeners) l(ev, data); }
  say(text: string) { this.feed.push({ text, t: this.clock }); if (this.feed.length > 6) this.feed.shift(); this.emit('feed'); }

  get selfId() { return selfId; }
  isHost() {
    // deterministic: the lowest id in the room hosts, no election traffic needed
    const ids = [selfId, ...this.pilots.keys()].sort();
    return ids[0] === selfId;
  }

  private hello(): Hello {
    const s = { ...this.game.spec };
    delete s.glb;                       // models can be megabytes, peers rebuild from the spec
    return { name: this.name, spec: s, color: this.color };
  }

  /** call after the local drone changes */
  announce() { this.aHello.send(JSON.stringify(this.hello())); }

  private async onHello(id: string, h: Hello) {
    const spec = FEATURED.find(f => f.id === h.spec?.id) ?? validateSpec(h.spec);
    let p = this.pilots.get(id);
    const isNew = !p;
    if (!p) {
      p = { id, name: String(h.name || 'Pilot').slice(0, 18), color: String(h.color || '#f7f7f2'), spec, visual: null, collider: null, samples: [], raceIdx: 0, raceTime: 0, finished: null, crashed: false, spraying: false, pos: new THREE.Vector3(), lastSeen: this.clock };
      this.pilots.set(id, p);
      // greet back so both sides know each other even if one hello was lost
      this.aHello.send(JSON.stringify(this.hello()), { target: id });
    } else {
      p.name = String(h.name || p.name).slice(0, 18);
    }
    if (isNew || p.spec.id !== spec.id || p.spec.name !== spec.name) {
      p.spec = spec;
      if (p.visual) this.game.world.scene.remove(p.visual.root);
      p.visual = await buildDroneVisual(spec);
      p.visual.root.visible = false;
      this.game.world.scene.add(p.visual.root);
      if (p.collider) this.game.world.colliders.remove(p.collider);
      p.collider = this.game.world.colliders.add({ kind: 'sphere', radius: spec.armLength + spec.propDiameter * 0.35 }, new THREE.Vector3(0, -999, 0), undefined, { tag: 'player', data: id, surface: 'hard' });
    }
    if (isNew) { this.say(`${p.name} joined`); audio.chime(2); }
    this.emit('pilots');
  }

  private removePilot(id: string) {
    const p = this.pilots.get(id);
    if (!p) return;
    if (p.visual) this.game.world.scene.remove(p.visual.root);
    if (p.collider) this.game.world.colliders.remove(p.collider);
    this.pilots.delete(id);
    this.emit('pilots');
  }

  private onBuild(op: BuildOp) {
    const b = this.game.builder;
    this.applyingRemote = true;
    try {
      if (op.op === 'place') b.place(op.p);
      else if (op.op === 'remove') b.removeAt(op.i);
      else if (op.op === 'clear') b.clear();
      else if (op.op === 'map' && op.map && Array.isArray(op.map.pieces)) { b.load(op.map); this.game.resetRace(); this.say(`Course loaded: ${op.map.name}`); }
    } finally { this.applyingRemote = false; }
    this.emit('build');
  }

  // ------------------------------------------------------------------ race
  startRace() {
    if (!this.isHost()) { this.game.toast('Only the host can start the race'); return; }
    if (this.game.builder.checkpoints().length < 2) { this.game.toast('Place at least two rings or gates first'); return; }
    const msg: RaceMsg = { op: 'start', inMs: 4000, seed: Math.random() };
    this.aRace.send(JSON.stringify(msg));
    this.onRace(msg, selfId);
  }

  private onRace(m: RaceMsg, from: string) {
    if (m.op === 'start') {
      this.raceState = 'countdown';
      this.countdownEnd = this.clock + m.inMs / 1000;
      this.selfFinish = null; this.winner = null;
      for (const p of this.pilots.values()) { p.finished = null; p.raceIdx = 0; p.raceTime = 0; }
      // line up on a grid behind the start pad, ordered by id so nobody overlaps
      const ids = [selfId, ...this.pilots.keys()].sort();
      const slot = ids.indexOf(selfId);
      const start = this.game.builder.startPad();
      const base = start?.pos ?? this.game.world.pads[1].clone();
      const yaw = start?.yaw ?? 0;
      const side = new THREE.Vector3(Math.cos(yaw), 0, -Math.sin(yaw));
      const back = new THREE.Vector3(Math.sin(yaw), 0, Math.cos(yaw));
      const spacing = Math.max(3, this.game.spec.armLength * 2 + this.game.spec.propDiameter + 1.5);
      const pos = base.clone().addScaledVector(side, ((slot % 4) - 1.5) * spacing).addScaledVector(back, Math.floor(slot / 4) * spacing);
      pos.y = this.game.world.colliders.heightAt(pos.x, pos.z) + 0.1;
      this.game.setHome(pos, yaw);
      this.game.resetDrone();
      this.game.resetRace();
      this.game.raceLocked = true;
      this.emit('race');
    } else if (m.op === 'finish') {
      const p = this.pilots.get(from);
      if (p) { p.finished = m.time; this.say(`${p.name} finished in ${m.time.toFixed(2)} s`); }
      this.checkWinner();
    } else if (m.op === 'abort') {
      this.raceState = 'idle'; this.game.raceLocked = false; this.emit('race');
    }
  }

  /** called by the game when the local pilot completes the course */
  localFinish(time: number) {
    if (this.raceState !== 'running' || this.selfFinish != null) return;
    this.selfFinish = time;
    this.aRace.send(JSON.stringify({ op: 'finish', time }));
    this.checkWinner();
  }

  private checkWinner() {
    const all = this.standings();
    const done = all.filter(s => s.finished != null);
    if (!done.length) return;
    if (!this.winner) {
      const w = done.sort((a, b) => a.finished! - b.finished!)[0];
      this.winner = w.self ? 'self' : w.name;
      this.emit('winner', w);
    }
    if (done.length === all.length) { this.raceState = 'done'; this.emit('race'); }
  }

  /** colours by seat, so two pilots never share one */
  colorOf(id: string) { const ids = [selfId, ...this.pilots.keys()].sort(); return PILOT_COLORS[Math.max(0, ids.indexOf(id)) % PILOT_COLORS.length]; }

  standings(): Standing[] {
    const me: Standing = { id: selfId, name: this.name, color: this.colorOf(selfId), idx: this.game.raceIdx, time: this.game.raceTime, finished: this.selfFinish, self: true };
    const others = [...this.pilots.values()].map(p => ({ id: p.id, name: p.name, color: this.colorOf(p.id), idx: p.raceIdx, time: p.raceTime, finished: p.finished, self: false }));
    return [me, ...others].sort((a, b) => {
      if (a.finished != null || b.finished != null) return (a.finished ?? 1e9) - (b.finished ?? 1e9);
      return b.idx - a.idx || a.time - b.time;
    });
  }

  chat(text: string) {
    const t = text.trim().slice(0, 120);
    if (!t) return;
    this.aChat.send(t);
    this.say(`${this.name}: ${t}`);
  }

  // ------------------------------------------------------------------ per frame
  update(dt: number) {
    this.clock += dt;
    const g = this.game;
    if (this.raceState === 'countdown' && this.clock >= this.countdownEnd) {
      this.raceState = 'running'; this.raceStart = this.clock; g.raceLocked = false; audio.success(); this.emit('race');
    }
    // send own state
    this.sendAcc += dt;
    if (g.sim && this.sendAcc >= 1 / SEND_HZ && this.pilots.size) {
      this.sendAcc = 0;
      const s = g.sim;
      const motor = s.motors.reduce((a, m) => a + m.s, 0) / s.motors.length;
      const flags = (g.spraying ? 1 : 0) | (s.crashed ? 2 : 0) | (s.armed ? 4 : 0);
      const r = (v: number, k = 1000) => Math.round(v * k) / k;
      this.aState.send([r(s.pos.x), r(s.pos.y), r(s.pos.z), r(s.quat.x, 1e4), r(s.quat.y, 1e4), r(s.quat.z, 1e4), r(s.quat.w, 1e4), r(motor, 100), flags, g.raceIdx, r(g.raceTime, 100)]);
    }
    // render remote pilots in the past, interpolated
    const tRender = this.clock - DELAY;
    const qa = new THREE.Quaternion(), qb = new THREE.Quaternion();
    for (const p of this.pilots.values()) {
      if (!p.visual) continue;
      const S = p.samples;
      if (!S.length || this.clock - p.lastSeen > 5) { p.visual.root.visible = false; continue; }
      let a = S[0], b = S[S.length - 1];
      for (let i = 0; i < S.length - 1; i++) if (S[i].t <= tRender && S[i + 1].t >= tRender) { a = S[i]; b = S[i + 1]; break; }
      const span = b.t - a.t;
      const k = span > 1e-4 ? THREE.MathUtils.clamp((tRender - a.t) / span, 0, 1.3) : 1;
      p.pos.set(a.s[0] + (b.s[0] - a.s[0]) * k, a.s[1] + (b.s[1] - a.s[1]) * k, a.s[2] + (b.s[2] - a.s[2]) * k);
      qa.set(a.s[3], a.s[4], a.s[5], a.s[6]).normalize(); qb.set(b.s[3], b.s[4], b.s[5], b.s[6]).normalize();
      p.visual.root.position.copy(p.pos);
      p.visual.root.quaternion.copy(qa).slerp(qb, Math.min(1, k));
      p.visual.root.visible = true;
      const motor = b.s[7];
      animateProps(p.visual, p.visual.props.map(() => motor), dt, Math.min(30000, 2400 / p.spec.propDiameter * 1.6));
      p.spraying = !!(b.s[8] & 1); p.crashed = !!(b.s[8] & 2);
      if (p.collider) g.world.colliders.move(p.collider, p.pos, p.collider.quat);
      if (p.spraying) {
        for (const nz of p.visual.nozzles.slice(0, 4)) {
          const o = nz.pos.clone().applyQuaternion(p.visual.root.quaternion).add(p.pos);
          const d = nz.dir.clone().applyQuaternion(p.visual.root.quaternion);
          for (let i = 0; i < 3; i++) g.particles.emit(o, d.clone().multiplyScalar(6).add(new THREE.Vector3((Math.random() - 0.5) * 2, 0, (Math.random() - 0.5) * 2)), 0.9, 0.04, 0.85, 0.93, 1, 0.5);
        }
      }
    }
  }

  async leave() {
    this.game.builder.onOp = null;
    for (const id of [...this.pilots.keys()]) this.removePilot(id);
    this.game.raceLocked = false;
    await this.room.leave();
  }
}
