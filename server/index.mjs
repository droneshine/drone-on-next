// DRONE ON Royale: lobby, matchmaker and relay. Prototype for the dedicated server
// phase (studio/NETCODE.md, phase 2). Run: node server/index.mjs
//
// What it does
//  * players connect over WebSocket (/play), say hello, wait in a queue
//  * the matchmaker groups up to MATCH_SIZE humans; after FILL_MS the match starts
//    with whoever is there and bots take the empty seats
//  * the match world stays host authoritative exactly like the P2P rooms (the
//    lowest seated human hosts), the server relays, but it is the referee for
//    everything a relay can referee: every message is validated with the SAME
//    validators the game uses (imported straight from src/net/royaleProtocol.ts,
//    Node 22.18+ strips the types, no build step), authority is enforced (only the
//    host sends world, bots and verdicts), rate limits apply, and the server alone
//    names the host, so forged host claims and split brain cannot happen
//  * a dropped pilot keeps the seat for SEAT_HOLD_MS and can reclaim it with its token
//
// Wire: text frames {"a": action, "d": payload, "to"?: seat}; the server adds "f"
// (the sender's seat, -1 = server) on the way out. Claims arrive batched per frame
// and verdicts batched per host tick, exactly as in P2P rooms. Binary frames are the
// 52 byte packed pilot state; the server relays them with the sender's seat as one
// prefix byte.
//
// Game numbers (the Signal plan) come from server/placeholder.mjs until the Royale
// tuning module (src/royale/tuning.ts) lands; then the server imports that instead.

import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { WebSocketServer } from 'ws';
import * as P from '../src/net/royaleProtocol.ts';
import { placeholderSignal } from './placeholder.mjs';

const env = process.env;
const intEnv = (k, lo, hi, d) => { const v = Number(env[k]); return Number.isInteger(v) && v >= lo && v <= hi ? v : d; };
const cfg = {
  port: intEnv('PORT', 0, 65535, 8790),
  // loopback by default: in production a TLS proxy (Caddy) sits in front
  host: env.HOST || '127.0.0.1',
  matchSize: intEnv('MATCH_SIZE', 1, P.MAX_SEATS, P.MAX_SEATS),
  fillMs: intEnv('FILL_MS', 0, 120000, 20000),
  minHumans: intEnv('MIN_HUMANS', 1, P.MAX_SEATS, 1),
  startInMs: intEnv('START_IN_MS', 0, 30000, 5000),
  maxPerIp: intEnv('MAX_PER_IP', 1, 1000, 16),
  region: env.REGION || 'eu-central',
  origins: (env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean),
  trustProxy: env.TRUST_PROXY === '1',
  quiet: env.LOG === 'quiet',
};

// ------------------------------------------------------------------ state and metrics

/** @type {Set<any>} */ const clients = new Set();
/** @type {any[]} */ const queue = [];
/** @type {Map<string, any>} */ const matches = new Map();
/** @type {Map<string, {match: any, seat: number}>} */ const tokens = new Map();
const perIp = new Map();
let nextClient = 1;

const metrics = {
  connections_total: 0, matches_started_total: 0, host_migrations_total: 0, rejoins_total: 0, kicks_total: 0,
  messages_in_total: Object.fromEntries(Object.values(P.ACTIONS).map(a => [a, 0])),
  relayed_total: 0, stream_skipped_total: 0,
  /** @type {Record<string, number>} */ rejected_total: {},
};
const reject = (c, why) => { metrics.rejected_total[why] = (metrics.rejected_total[why] || 0) + 1; if (c && ++c.bad > 200) kick(c, 'abuse'); };
const log = (ev, f = {}) => { if (!cfg.quiet || ev === 'listening') process.stdout.write(JSON.stringify({ t: new Date().toISOString(), ev, ...f }) + '\n'); };

const token = () => randomBytes(12).toString('hex');
// GDD 2.10 bot names; the host's game shuffles them per seed, the relay only needs placeholders
const BOT_NAMES = ['Pixel', 'Zephyr', 'Nimbus', 'Kestrel', 'Gizmo', 'Turbo Tilda', 'Captain Hover', 'Rotor Rosa', 'Sky Juno', 'Wobble', 'Ace Ingrid', 'Moth'];
const isHost = (c) => !!c.match && c.seat >= 0 && c.match.host === c.seat;

// ------------------------------------------------------------------ sending

function sendRaw(c, data, stream) {
  if (c.ws.readyState !== 1) return;
  // never queue stale state behind a slow link: drop stream frames, keep reliable ones
  if (stream && c.ws.bufferedAmount > 256 * 1024) { metrics.stream_skipped_total++; return; }
  c.ws.send(data);
}
const frame = (a, f, d) => JSON.stringify({ a, f, d });
function toMatch(m, data, { except = null, stream = false, watchers = true } = {}) {
  for (const s of m.seats) if (s.client && s.client !== except) { sendRaw(s.client, data, stream); metrics.relayed_total++; }
  if (watchers) for (const w of m.watchers) if (w !== except) sendRaw(w, data, stream);
}
const ctl = (c, d) => sendRaw(c, frame('rx', -1, d), false);

// ------------------------------------------------------------------ matchmaking

function lobbySeats(m) {
  return m.seats.map(s => ({ seat: s.seat, peer: s.bot ? '' : s.peerId, name: s.name, bot: s.bot, skin: s.skin, lvl: s.bot ? s.lvl : -1 }));
}

function broadcastLobby() {
  if (!queue.length) return;
  const wait = Math.max(0, cfg.fillMs - (Date.now() - queue[0].queuedAt));
  const msg = { t: 'lobby', ep: 0, host: -1, startIn: wait,
    seats: queue.slice(0, P.MAX_SEATS).map((c, i) => ({ seat: i, peer: c.id, name: c.name, bot: false, skin: c.skin, lvl: -1 })) };
  const data = frame('rx', -1, msg);
  for (const c of queue) sendRaw(c, data, false);
}

function formMatch(group) {
  const seed = randomBytes(4).readUInt32LE(0);
  const m = {
    id: 'm-' + Date.now().toString(36) + '-' + randomBytes(3).toString('hex'),
    ep: 1, seed, host: 0, lastSeq: 0, phase: P.PHASE.COUNTDOWN, createdAt: Date.now(),
    zone: placeholderSignal(seed), watchers: new Set(), lastState: new Map(), endTimer: null,
    seats: [],
  };
  for (let i = 0; i < P.MAX_SEATS; i++) {
    const c = group[i];
    m.seats.push(c
      ? { seat: i, client: c, peerId: c.id, name: c.name, skin: c.skin, bot: false, token: token(), status: P.SEAT.HUMAN, droppedAt: 0 }
      : { seat: i, client: null, peerId: '', name: BOT_NAMES[i % BOT_NAMES.length], skin: 'default', bot: true, lvl: 1, token: '', status: P.SEAT.BOT, droppedAt: 0 });
  }
  matches.set(m.id, m);
  metrics.matches_started_total++;
  const start = { t: 'start', ep: m.ep, match: m.id, seed, inMs: cfg.startInMs, host: m.host, seats: lobbySeats(m), zone: m.zone, rules: P.PROTO_VERSION };
  // our own output goes through the validator too: a server bug must not ship junk
  if (!P.validateStart(start)) throw new Error('server built an invalid start message');
  for (const s of m.seats) {
    if (!s.client) continue;
    const c = s.client;
    c.state = 'playing'; c.match = m; c.seat = s.seat;
    tokens.set(s.token, { match: m, seat: s.seat });
    ctl(c, { t: 'you', ep: m.ep, seat: s.seat, token: s.token });
  }
  toMatch(m, frame('rx', -1, start));
  log('match_start', { match: m.id, humans: group.length, region: cfg.region });
}

function matchmake() {
  const now = Date.now();
  let changed = false;
  while (queue.length >= cfg.matchSize) { formMatch(queue.splice(0, cfg.matchSize)); changed = true; }
  if (queue.length >= cfg.minHumans && now - queue[0].queuedAt >= cfg.fillMs) { formMatch(queue.splice(0, queue.length)); changed = true; }
  if (changed) broadcastLobby();
}

function closeMatch(m, why) {
  if (!matches.has(m.id)) return;
  matches.delete(m.id);
  clearTimeout(m.endTimer);
  for (const s of m.seats) {
    if (s.token) tokens.delete(s.token);
    if (s.client) { s.client.state = 'new'; s.client.match = null; s.client.seat = -1; }
  }
  for (const w of m.watchers) { w.state = 'new'; w.match = null; }
  log('match_close', { match: m.id, why });
}

/** the server names the host: lowest seated human still connected; every change is a new term */
function electHost(m) {
  const next = m.seats.find(s => s.client && !s.bot);
  if (!next) { closeMatch(m, 'empty'); return; }
  if (next.seat === m.host) return;
  m.host = next.seat;
  m.ep++;
  metrics.host_migrations_total++;
  toMatch(m, frame('rx', -1, { t: 'host', ep: m.ep, seat: m.host, last: m.lastSeq }));
  log('host_migrate', { match: m.id, host: m.host, ep: m.ep });
}

// ------------------------------------------------------------------ joining, leaving, rejoining

function onHello(c, h) {
  if (c.state !== 'new') return reject(c, 'hello_twice');
  if (h.v !== P.PROTO_VERSION) { ctl(c, { t: 'gone', seat: 0, why: 'kicked' }); return reject(c, 'version'); }
  c.name = h.name; c.skin = h.skin;
  const held = h.token ? tokens.get(h.token) : null;
  if (held && matches.has(held.match.id)) {
    const m = held.match, s = m.seats[held.seat];
    if (!s.client && Date.now() - s.droppedAt < P.SEAT_HOLD_MS) {
      tokens.delete(s.token);
      s.client = c; s.peerId = c.id; s.status = P.SEAT.HUMAN; s.token = token();
      tokens.set(s.token, { match: m, seat: s.seat });
      c.state = 'playing'; c.match = m; c.seat = s.seat;
      m.lastState.delete(s.seat);          // a fresh page counts its state seq from 1 again
      metrics.rejoins_total++;
      ctl(c, { t: 'you', ep: m.ep, seat: s.seat, token: s.token });
      ctl(c, { t: 'start', ep: m.ep, match: m.id, seed: m.seed, inMs: 0, host: m.host, seats: lobbySeats(m), zone: m.zone, rules: P.PROTO_VERSION });
      toMatch(m, frame('rx', -1, { t: 'back', seat: s.seat }), { except: c });
      // the host answers with a 'full' replica addressed to this seat
      const host = m.seats[m.host].client;
      if (host) sendRaw(host, frame('rx', s.seat, { t: 'sync', from: 0 }), false);
      log('rejoin', { match: m.id, seat: s.seat });
      return;
    }
  }
  if (h.want === 'watch') {
    const m = [...matches.values()].filter(x => x.phase !== P.PHASE.ENDED).pop();
    if (!m) { ctl(c, { t: 'lobby', ep: 0, host: -1, seats: [], startIn: 0 }); return; }
    c.state = 'watching'; c.match = m; c.seat = -1;
    m.watchers.add(c);
    ctl(c, { t: 'start', ep: m.ep, match: m.id, seed: m.seed, inMs: 0, host: m.host, seats: lobbySeats(m), zone: m.zone, rules: P.PROTO_VERSION });
    const host = m.seats[m.host].client;
    if (host) sendRaw(host, frame('rx', -1, { t: 'sync', from: 0 }), false);
    return;
  }
  c.state = 'queued'; c.queuedAt = Date.now();
  queue.push(c);
  broadcastLobby();
}

function drop(c, why) {
  if (c.state === 'queued') { const i = queue.indexOf(c); if (i >= 0) queue.splice(i, 1); broadcastLobby(); }
  const m = c.match;
  if (m && c.state === 'watching') m.watchers.delete(c);
  if (m && c.state === 'playing' && c.seat >= 0) {
    const s = m.seats[c.seat];
    if (s.client === c) {
      s.client = null; s.status = P.SEAT.AUTOPILOT; s.droppedAt = Date.now();
      // the host turns this into a 'seat' verdict and flies the drone on autopilot
      toMatch(m, frame('rx', -1, { t: 'gone', seat: s.seat, why }));
      if (m.host === s.seat) electHost(m);
      else if (!m.seats.some(x => x.client)) closeMatch(m, 'empty');
    }
  }
  c.state = 'gone'; c.match = null; c.seat = -1;
}

function kick(c, why) {
  metrics.kicks_total++;
  log('kick', { client: c.id, why });
  try { c.ws.close(1008, why); } catch { /* already closed */ }
}

// ------------------------------------------------------------------ relay

function onText(c, text) {
  let env;
  try { env = JSON.parse(text); } catch { return reject(c, 'json'); }
  if (!env || typeof env !== 'object' || !P.isActionKey(env.a)) return reject(c, 'action');
  const a = env.a;
  metrics.messages_in_total[a]++;
  if (!c.limiter.msg[a].take(Date.now())) return reject(c, 'rate');

  if (a === 'rx') return onCtl(c, env);
  const m = c.match;
  if (!m || c.state !== 'playing') return reject(c, 'not_playing');

  if (a === 'rs') {
    const s = P.validatePilotState(env.d);
    if (!s) return reject(c, 'invalid');
    return relayState(c, m, s, null);
  }
  if (a === 'rq') {
    const list = P.validateClaimBatch(env.d);
    if (!list || !list.length) return reject(c, 'invalid');
    if (!c.limiter.claims.take(Date.now(), list.length)) return reject(c, 'rate');
    const ms = list[0].ms;
    const toAll = list.filter(P.isBroadcastClaim), toHost = list.filter(q => !P.isBroadcastClaim(q));
    if (toAll.length) toMatch(m, frame('rq', c.seat, P.encodeClaimBatch(ms, toAll)), { except: c });
    // the host's own claims never travel: it judges them locally
    if (toHost.length && !isHost(c)) {
      const h = m.seats[m.host].client;
      if (h) { sendRaw(h, frame('rq', c.seat, P.encodeClaimBatch(ms, toHost)), false); metrics.relayed_total++; }
    }
    return;
  }
  // rb, rw, re: the host alone
  if (!P.senderMayUse(a, null, isHost(c))) return reject(c, 'authority');
  if (a === 'rb') {
    const b = P.validateBotBatch(env.d);
    if (!b) return reject(c, 'invalid');
    // bots can only sit in bot or autopilot seats
    if (b.bots.some(x => m.seats[x.seat].status === P.SEAT.HUMAN)) return reject(c, 'authority');
    return toMatch(m, frame('rb', c.seat, P.encodeBotBatch(b)), { except: c, stream: true });
  }
  if (a === 'rw') {
    const w = P.validateWorldSnapshot(env.d);
    if (!w || w.ep !== m.ep) return reject(c, 'invalid');
    m.phase = w.phase;
    return toMatch(m, frame('rw', c.seat, P.encodeWorldSnapshot(w)), { except: c, stream: true });
  }
  if (a === 're') {
    const evs = P.validateEventBatch(env.d);
    if (!evs || evs[0].ep !== m.ep) return reject(c, 'invalid');
    if (!P.seqNewer(evs[0].seq, m.lastSeq)) return reject(c, 'dup');
    if (!c.limiter.events.take(Date.now(), evs.length)) return reject(c, 'rate');
    m.lastSeq = evs[evs.length - 1].seq;
    toMatch(m, frame('re', c.seat, P.encodeEventBatch(evs)), { except: c });
    if (evs.some(e => e.t === 'end') && !m.endTimer) { m.phase = P.PHASE.ENDED; m.endTimer = setTimeout(() => closeMatch(m, 'ended'), 10000); }
  }
}

function relayState(c, m, s, packed) {
  if (c.seat < 0) return reject(c, 'not_playing');
  const last = m.lastState.get(c.seat) ?? 0;
  if (!P.seqNewer(s.seq, last)) return reject(c, 'stale');
  m.lastState.set(c.seat, s.seq);
  if (packed) {
    const out = Buffer.allocUnsafe(1 + P.PILOT_STATE_BYTES);
    out[0] = c.seat;
    Buffer.from(P.packPilotState(s)).copy(out, 1);
    toMatch(m, out, { except: c, stream: true });
  } else toMatch(m, frame('rs', c.seat, P.encodePilotState(s)), { except: c, stream: true });
}

function onBinary(c, buf) {
  metrics.messages_in_total.rs++;
  if (!c.limiter.msg.rs.take(Date.now())) return reject(c, 'rate');
  const s = P.unpackPilotState(new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength));
  if (!s) return reject(c, 'invalid');
  if (!c.match || c.state !== 'playing') return reject(c, 'not_playing');
  relayState(c, c.match, s, true);
}

function onCtl(c, env) {
  const msg = P.validateCtl(env.d);
  if (!msg) return reject(c, 'invalid');
  const m = c.match;
  switch (msg.t) {
    case 'hello': return onHello(c, msg);
    case 'ping': return ctl(c, { t: 'pong', n: msg.n, ms: msg.ms, at: m ? Date.now() - m.createdAt - cfg.startInMs : -1 });
    case 'pong': return;
    case 'bye': return drop(c, 'left');
    case 'sync': {
      if (!m || c.state === 'gone') return reject(c, 'not_playing');
      const h = m.seats[m.host].client;
      if (h && h !== c) sendRaw(h, frame('rx', c.seat, msg), false);
      return;
    }
    case 'full': {
      // the host answers a sync: to a seat, or to all watchers with to = -1
      if (!m || !isHost(c) || msg.ep !== m.ep) return reject(c, 'authority');
      const data = frame('rx', c.seat, msg);
      if (env.to === -1) for (const w of m.watchers) sendRaw(w, data, false);
      else if (Number.isInteger(env.to) && env.to >= 0 && env.to < P.MAX_SEATS && m.seats[env.to].client) sendRaw(m.seats[env.to].client, data, false);
      else return reject(c, 'invalid');
      return;
    }
    // lobby, you, start, host, gone, back belong to the server in relay mode
    default: return reject(c, 'authority');
  }
}

// ------------------------------------------------------------------ http and websocket

const server = http.createServer((req, res) => {
  const url = (req.url || '/').split('?')[0];
  if (url === '/health') {
    const players = [...matches.values()].reduce((n, m) => n + m.seats.filter(s => s.client).length, 0);
    res.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*', 'cache-control': 'no-store' });
    res.end(JSON.stringify({ ok: true, region: cfg.region, proto: P.PROTO_VERSION, clients: clients.size, queued: queue.length, matches: matches.size, players }));
    return;
  }
  if (url === '/metrics') {
    const lines = [
      `royale_clients ${clients.size}`, `royale_queued ${queue.length}`, `royale_matches_live ${matches.size}`,
      `royale_connections_total ${metrics.connections_total}`, `royale_matches_started_total ${metrics.matches_started_total}`,
      `royale_host_migrations_total ${metrics.host_migrations_total}`, `royale_rejoins_total ${metrics.rejoins_total}`,
      `royale_kicks_total ${metrics.kicks_total}`, `royale_relayed_total ${metrics.relayed_total}`, `royale_stream_skipped_total ${metrics.stream_skipped_total}`,
      ...Object.entries(metrics.messages_in_total).map(([a, n]) => `royale_messages_in_total{action="${a}"} ${n}`),
      ...Object.entries(metrics.rejected_total).map(([w, n]) => `royale_rejected_total{reason="${w}"} ${n}`),
    ];
    res.writeHead(200, { 'content-type': 'text/plain; version=0.0.4' });
    res.end(lines.join('\n') + '\n');
    return;
  }
  res.writeHead(404, { 'content-type': 'text/plain' });
  res.end('DRONE ON Royale relay. WebSocket at /play\n');
});

const ipOf = (req) => (cfg.trustProxy && typeof req.headers['x-forwarded-for'] === 'string' ? req.headers['x-forwarded-for'].split(',')[0].trim() : req.socket.remoteAddress) || '?';

const wss = new WebSocketServer({
  server, path: '/play', maxPayload: 64 * 1024,
  verifyClient: ({ origin, req }, done) => {
    if (cfg.origins.length && !cfg.origins.includes(origin)) return done(false, 403, 'origin not allowed');
    if ((perIp.get(ipOf(req)) || 0) >= cfg.maxPerIp) return done(false, 429, 'too many connections');
    done(true);
  },
});

wss.on('connection', (ws, req) => {
  const ip = ipOf(req);
  perIp.set(ip, (perIp.get(ip) || 0) + 1);
  const c = { id: 'c' + nextClient++, ws, ip, name: 'Pilot', skin: 'default', state: 'new', match: null, seat: -1, queuedAt: 0, limiter: P.makeLimiter(), alive: true, bad: 0 };
  clients.add(c);
  metrics.connections_total++;
  ws.on('pong', () => { c.alive = true; });
  ws.on('message', (data, isBinary) => {
    c.alive = true;
    try { if (isBinary) onBinary(c, data); else onText(c, data.toString('utf8')); }
    catch (e) { reject(c, 'server_error'); log('error', { client: c.id, msg: String(e && e.message || e) }); }
  });
  ws.on('close', () => {
    clients.delete(c);
    perIp.set(ip, Math.max(0, (perIp.get(ip) || 1) - 1));
    if (!perIp.get(ip)) perIp.delete(ip);
    drop(c, c.bad > 200 ? 'kicked' : c.timedOut ? 'timeout' : 'left');
  });
  ws.on('error', () => { /* close follows */ });
});

// matchmaker, lobby countdown, seat hold expiry, heartbeats
const timers = [
  setInterval(matchmake, 100),
  setInterval(broadcastLobby, 1000),
  setInterval(() => {
    const now = Date.now();
    for (const c of clients) c.bad = Math.max(0, c.bad - 50);
    for (const m of matches.values()) for (const s of m.seats) if (!s.client && !s.bot && s.token && now - s.droppedAt > P.SEAT_HOLD_MS) { tokens.delete(s.token); s.token = ''; }
  }, 5000),
  setInterval(() => {
    for (const c of clients) {
      if (!c.alive) { c.timedOut = true; c.ws.terminate(); continue; }
      c.alive = false;
      try { c.ws.ping(); } catch { /* closing */ }
    }
  }, 5000),
];

server.listen(cfg.port, cfg.host, () => {
  const addr = server.address();
  log('listening', { port: typeof addr === 'object' && addr ? addr.port : cfg.port, host: cfg.host, region: cfg.region, matchSize: cfg.matchSize, fillMs: cfg.fillMs });
});

function shutdown(sig) {
  log('shutdown', { sig });
  for (const t of timers) clearInterval(t);
  for (const c of clients) { try { c.ws.close(1001, 'server restart'); } catch { /* gone */ } }
  wss.close();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1500).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
