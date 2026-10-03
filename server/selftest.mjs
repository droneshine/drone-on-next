// node server/selftest.mjs
// 1. protocol: round trips, clamps, junk, a fuzz run (validators must never throw),
//    claim and verdict batches, ordering, dedupe, personal rings, rewind checks for
//    PULSE, WATER JET, EMP and rams with GDD limits passed in, the Signal plan
//    interpreter, motion guard.
// 2. a real server process (node server/index.mjs) with three fake clients using the
//    browser standard WebSocket: matched into one game, state relayed, junk and
//    authority violations dropped, claim batches routed, verdict batches relayed,
//    host migration on drop (server phase), seat reclaimed with the token. Exits 0
//    when everything passes.

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import * as P from '../src/net/royaleProtocol.ts';
import { GDD_LIMITS as L, placeholderSignal } from './placeholder.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
let failures = 0;
let child = null;
const ok = (cond, label) => { if (cond) console.log('  ok    ' + label); else { failures++; console.log('  FAIL  ' + label); } };
const finish = (code) => { if (child) { try { child.kill(); } catch { /* gone */ } } setTimeout(() => process.exit(code), 50); };
const watchdog = setTimeout(() => { console.log('FAIL  selftest timed out'); finish(1); }, 30000);

// ------------------------------------------------------------------ 1. protocol

function protocolChecks() {
  console.log('protocol');
  ok(!('TIER_RULES' in P) && !('signalPlan' in P) && !('WEAPONS' in P) && !('acceptHostClaim' in P), 'no game numbers and no P2P takeover logic in the protocol');
  const s = { seq: 7, ms: 123456.7, pos: [12.345, 40.5, -300.25], quat: [0, 0.7071, 0, 0.7071], vel: [10, -1, 3], motor: 0.62, flags: P.SF.ARMED | P.SF.SCRAMBLED, aim: -15, soc: 0.734, tank: 0.42, shine: 17, ack: 3 };
  const wire = P.encodePilotState(s);
  const back = P.validatePilotState(wire);
  ok(wire.length === P.PILOT_STATE_LEN && back && back.pos[0] === 12.35 && back.flags === 129 && back.shine === 17 && back.soc === 0.734 && back.ack === 3, 'pilot state round trip with Shine and the SCRAMBLED flag (' + JSON.stringify(wire).length + ' chars JSON)');
  const row = (over) => { const a = [1, 1, 0, 10, 0, 0, 0, 0, 1, 0, 0, 0, 0.5, 1, 0, 1, 0, 0, 0]; for (const [i, v] of Object.entries(over)) a[i] = v; return a; };
  const clamped = P.validatePilotState(row({ 2: 5000, 3: 9999, 4: -5000, 8: 2, 9: 1000, 12: 7, 13: 4095, 14: -400, 15: 3, 16: 99, 17: 50000 }));
  ok(clamped && clamped.pos[0] === 800 && clamped.pos[1] === 650 && clamped.pos[2] === -800 && Math.abs(Math.hypot(...clamped.vel) - P.MAX_SPEED_WIRE) < 1e-9 && clamped.motor === 1 && clamped.flags === 1023 && clamped.aim === -90 && clamped.quat[3] === 1 && clamped.soc === 1 && clamped.tank === 10 && clamped.shine === 9999, 'pilot state clamps position, speed, motor, flags, aim, battery, tank, Shine; normalises quat');
  ok(P.validatePilotState(row({ 2: NaN })) === null, 'NaN rejected');
  ok(P.validatePilotState(row({ 5: 0, 6: 0, 7: 0, 8: 0 })) === null, 'zero quaternion rejected');
  ok(P.validatePilotState(row({ 17: 'x' })) === null && P.validatePilotState('[1,2,3]') === null && P.validatePilotState({}) === null && P.validatePilotState(null) === null, 'wrong types rejected');
  const packed = P.packPilotState(s);
  const unpacked = P.unpackPilotState(packed);
  ok(packed.byteLength === P.PILOT_STATE_BYTES && unpacked && Math.abs(unpacked.pos[2] + 300.25) < 1e-3 && unpacked.seq === 7 && unpacked.shine === 17 && unpacked.flags === 129 && unpacked.tank === 0.42, 'binary state round trip, ' + packed.byteLength + ' bytes');

  // claims, one frame per batch
  const fire = P.validateClaim(JSON.stringify({ t: 'fire', id: 1, ms: 10, o: [0, 10, 0], d: [0, 0, 5], extra: 'dropped' }));
  ok(fire && fire.d[2] === 1 && !('extra' in fire), 'fire claim: direction normalised, unknown fields dropped');
  ok(P.validateClaim('{"t":"burst","id":1,"a":"laser","ms":1,"o":[0,0,0]}') === null, 'unknown ability rejected');
  ok(P.validateClaim('{"t":"impact","id":1,"ms":1,"kind":"ram","speed":9}') === null && P.validateClaim('{"t":"impact","id":1,"ms":1,"kind":"lake","speed":9}')?.other === -1, 'impact: a ram must name the other drone; lake needs none');
  ok(P.validateClaim('{"t":"hit","id":1,"shot":1,"target":12,"ms":1,"p":[0,0,0]}') === null, 'seat out of range rejected, not clamped');
  const polluted = P.validateClaim('{"__proto__":{"admin":true},"t":"pick","id":3,"item":4,"ms":5}');
  ok(polluted && polluted.admin === undefined && ({}).admin === undefined, 'prototype pollution has no effect');
  const frameClaims = [{ t: 'fire', id: 5, ms: 900, o: [0, 10, 0], d: [1, 0, 0] }, { t: 'ring', id: 6, ms: 900, ring: 12 }, { t: 'jet', id: 7, ms: 900, target: 3, o: [0, 10, 0], d: [1, 0, 0] }];
  const cb = P.encodeClaimBatch(900, frameClaims);
  const cbBack = P.validateClaimBatch(JSON.stringify(cb));
  ok(cbBack && cbBack.length === 3 && cbBack.every(c => c.ms === 900) && !('ms' in cb.c[0]), `claim batch: one frame, ${JSON.stringify(cb).length} chars for 3 claims, time hoisted`);
  const mixed = P.validateClaimBatch({ ms: 900, c: [cb.c[0], { t: 'hit', id: 'x' }, cb.c[0], 'junk', cb.c[1]] });
  ok(mixed && mixed.map(c => c.id).join() === '5,6', 'claim batch: junk and duplicate ids dropped one by one');
  ok(P.validateClaimBatch({ ms: 900, c: Array.from({ length: 17 }, (_, i) => ({ t: 'ring', id: i + 1, ring: i })) }) === null && P.validateClaimBatch('x'.repeat(P.MAX_JSON.claims + 1)) === null, 'claim batch: more than 16 claims, or oversized JSON, rejected before work');

  // verdicts, one tick per batch
  const evRaw = { t: 'elim', ep: 1, seq: 4, at: 1000, victim: 3, by: 5, cause: 'lake', place: 9 };
  ok(P.validateHostEvent(evRaw)?.cause === 'lake' && P.validateHostEvent({ ...evRaw, cause: 'blade' })?.cause === 'blade' && P.validateHostEvent({ ...evRaw, by: 3 }) === null && Object.keys(evRaw).length === 8, 'elim: lake and blade causes; self credit rejected; input not mutated');
  ok(P.validateHostEvent({ t: 'zap', ep: 1, seq: 5, at: 1000, amt: 1, seats: [1, 2], hp: [50] }) === null, 'zap: integrity list must match the seats');
  ok(P.validateHostEvent({ t: 'got', ep: 1, seq: 6, at: 1000, seat: 2, give: 'shield', item: 1, shine: 5, tier: 1, hp: 90 }) === null, 'got: no shield or weapon pickups this cycle');
  const tick = [
    { t: 'dmg', ep: 2, seq: 41, at: 125000, target: 4, src: 1, amt: 8, hp: 92, cause: 'pulse', ref: P.claimRef(1, 77) },
    { t: 'fx', ep: 2, seq: 42, at: 125000, kind: 'push', src: 2, targets: [5], dir: [1, 0, 0], force: 18, dur: 200 },
    { t: 'zap', ep: 2, seq: 43, at: 125000, amt: 2, seats: [6, 7], hp: [40, 12] },
    { t: 'got', ep: 2, seq: 44, at: 125000, seat: 3, give: 'shine', item: 23, shine: 5, tier: 1, hp: 130, ref: P.claimRef(3, 9) },
  ];
  const eb = P.encodeEventBatch(tick);
  const ebBack = P.validateEventBatch(JSON.stringify(eb));
  ok(eb && ebBack && ebBack.length === 4 && ebBack.map(e => e.seq).join() === '41,42,43,44' && ebBack.every(e => e.ep === 2 && e.at === 125000), `verdict batch: one tick, ${JSON.stringify(eb).length} chars for 4 verdicts, numbered seq + i`);
  ok(P.encodeEventBatch([tick[0], tick[2]]) === null, 'verdict batch: encoder refuses non consecutive seq');
  ok(P.validateEventBatch({ ...eb, ev: [...eb.ev.slice(0, 2), { t: 'dmg', target: 99 }] }) === null, 'verdict batch: one junk verdict rejects the whole batch (no holes in the seq stream)');
  const hello = P.validateHello({ t: 'hello', v: 1, name: '  Ace‮\u0007  Pilot   with a very long name ', skin: 'BAD SKIN', want: 'play' });
  ok(hello && hello.name === 'Ace Pilot with a v' && hello.skin === 'default' && hello.token === '', 'hello: control and bidi chars stripped, name capped, bad skin replaced');

  // the Signal: the plan is data from the tuning module; the protocol only interprets it
  const zone = placeholderSignal(42);
  ok(P.validateZone(zone) !== null, 'Signal plan (GDD 6.7 stand in) passes the zone validator');
  const at = (sec) => P.zoneAt(zone, sec * 1000);
  ok(at(0).r === 420 && at(0).ceil === 120 && at(50).dps === 2 && !at(50).shrinking, 'Signal: 420 m, ceiling 120, Static 2 per s while phase 1 holds');
  ok(at(80).shrinking && at(80).r < 420 && at(80).r > 260 && at(120).r === 260 && at(120).dps === 4, 'Signal: shrinks 1:00 to 1:40 to 260 m, phase 2 Static 4 per s');
  ok(Math.abs(at(145).ceil - 110) < 1e-9 && at(150).ceil === 100, 'Signal: ceiling moves 120 to 100 over ceilMs (10 s) from 2:20');
  ok(at(346).r === 0 && at(346).dps === 25 && at(346).ceil === 45, 'Signal: overtime from 5:45, radius 0, 25 per s');
  ok(P.inSignal(at(0), [-60, 50, -60]) && !P.inSignal(at(0), [-60, 130, -60]) && !P.inSignal(at(0), [400, 50, 400]), 'inSignal: inside, above the ceiling, outside the wall');
  const start = { t: 'start', ep: 1, match: 'm-1', seed: 42, inMs: 3000, host: 0, rules: 1, zone,
    seats: [{ seat: 0, peer: 'abc', name: 'A', bot: false, skin: 'default' }, { seat: 1, peer: '', name: 'Pixel', bot: true, skin: 'default', lvl: 2 }] };
  const vs = P.validateStart(start);
  ok(vs && vs.seats[1].lvl === 2 && vs.seats[0].lvl === -1 && vs.zone.ceilMs === 10000 && P.validateStart({ ...start, host: 1 }) === null, 'start: bot difficulty and plan kept, host must be a human in the roster');

  // fuzz: random junk and mutated valid messages through every validator
  const validators = Object.entries(P).filter(([k, v]) => (k.startsWith('validate') || k === 'unpackPilotState') && typeof v === 'function');
  const rnd = P.mulberry32(1234);
  const pick = (a) => a[Math.floor(rnd() * a.length)];
  const junkAtoms = [null, undefined, true, 0, -1, 1e308, -1e308, NaN, Infinity, '', 'x', '{}', '[]', '{"t":"fire"', [], {}, [NaN], { t: 'hit' }, '__proto__', 2 ** 53, -0, new Uint8Array(52), new ArrayBuffer(3)];
  const T = ['fire', 'hit', 'jet', 'burst', 'pick', 'ring', 'impact', 'dmg', 'zap', 'fx', 'got', 'deny', 'spawn', 'elim', 'seat', 'end', 'hello', 'lobby', 'you', 'start', 'host', 'sync', 'full', 'ping', 'pong', 'gone', 'back', 'bye', 'zzz'];
  const junk = (d = 0) => {
    const r = rnd();
    if (d > 3 || r < 0.4) return pick(junkAtoms);
    if (r < 0.65) return Array.from({ length: Math.floor(rnd() * 40) }, () => (rnd() < 0.8 ? (rnd() - 0.5) * 10 ** Math.floor(rnd() * 8) : junk(d + 1)));
    if (r < 0.9) { const o = { t: pick(T) }; for (const k of ['id', 'ms', 'o', 'd', 'p', 'ep', 'seq', 'at', 'seats', 'zone', 'items', 'world', 'name', 'v', 'hp', 'kind', 'target', 'c', 'ev']) if (rnd() < 0.5) o[k] = junk(d + 1); return o; }
    return JSON.stringify(junk(d + 1)) ?? 'null';
  };
  const samples = [wire, JSON.stringify(start), start, zone, evRaw, cb, eb, tick[1], frameClaims[2]];
  const mutate = (v) => { const c = JSON.parse(JSON.stringify(typeof v === 'string' ? JSON.parse(v) : v)); const keys = Object.keys(c); if (keys.length) c[pick(keys)] = junk(); return c; };
  let throws = 0, runs = 0;
  for (let i = 0; i < 4000; i++) {
    const inputs = [junk(), mutate(pick(samples))];
    for (const input of inputs) for (const [, fn] of validators) { runs++; try { fn(input); } catch { throws++; } }
  }
  ok(throws === 0, `fuzz: ${runs} validator calls over ${validators.length} validators, ${throws} throws`);

  // sequence numbers, dedupe, ordering, personal rings
  ok(P.seqNewer(5, P.SEQ_MOD - 5) && !P.seqNewer(P.SEQ_MOD - 5, 5) && !P.seqNewer(3, 3), 'seqNewer is wrap safe');
  const dd = new P.DedupeSet(16);
  ok(dd.add('1:7') && !dd.add('1:7'), 'dedupe: first add true, repeat false');
  for (let i = 0; i < 40; i++) dd.add(i);
  ok(dd.size === 16 && !dd.has('1:7'), 'dedupe set stays bounded');
  const inbox = new P.OrderedInbox();
  inbox.reset(1, 0);
  const ev = (seq, ep = 1) => ({ ep, seq });
  const a1 = inbox.push(ev(2), 0), a2 = inbox.push(ev(3), 10), a3 = inbox.push(ev(1), 20), a4 = inbox.push(ev(2), 30);
  ok(a1.length === 0 && a2.length === 0 && a3.map(e => e.seq).join() === '1,2,3' && a4.length === 0, 'inbox: holds early events, releases in order, drops duplicates');
  ok(inbox.pushAll([ev(6), ev(4), ev(5)], 40).map(e => e.seq).join() === '4,5,6', 'inbox: a batch arriving out of order is applied in order');
  inbox.push(ev(8), 100);
  ok(!inbox.needsSync(600) && inbox.needsSync(1200), 'inbox: a gap older than a second asks for a sync');
  ok(inbox.push(ev(9, 0), 0).length === 0, 'inbox: verdicts from another term are dropped');
  const pr = new P.PersonalRings();
  const takes = [pr.take(3, 1), pr.take(3, 1), pr.take(3, 2)];
  const pr2 = P.PersonalRings.fromPairs(pr.toPairs());
  ok(takes.join() === 'true,false,true' && pr2.has(3, 2) && !pr2.has(4, 1), 'personal rings: each pilot takes each ring once; replica round trip');

  // rewind and PULSE validation: target flies along x at 10 m/s, sampled every 50 ms on the host clock
  const target = new P.RewindBuffer();
  for (let t = 0; t <= 1000; t += 50) target.push(t, [-20 + t / 100, 10, 0], [10, 0, 0]);
  const o = [0, 10, -50];
  const hitT = 800, rtt = 60, view = hitT - P.INTERP_DELAY_MS - rtt / 2;
  const seen = [-20 + view / 100, 10, 0];
  const dir = [seen[0] - o[0], seen[1] - o[1], seen[2] - o[2]];
  const dist = Math.hypot(...dir);
  const speed = L.tiers[0].pulseSpeed;
  const tau = dist / speed * 1000;
  const fc = { t: 'fire', id: 11, ms: 50000, o, d: dir.map(x => x / dist) };
  const hc = { t: 'hit', id: 12, ms: 50000 + tau, shot: 11, target: 3, p: P.projectileAt(fc.o, fc.d, speed, tau) };
  const H = (over) => P.checkHit({ fire: fc, hit: hc, shooterTier: 0, targetTier: 0, hitT, hostNow: 820, shooterRttMs: rtt, target, ...over }, L);
  ok(H({}).ok, `hit: honest SPARK shot at ${dist.toFixed(1)} m accepted after rewinding the target`);
  const dodged = new P.RewindBuffer();
  for (let t = 0; t <= 1000; t += 50) dodged.push(t, [-20 + t / 100, 15, 0], [10, 0, 0]);
  const v1 = H({ target: dodged });
  ok(!v1.ok && v1.why === 'far', 'hit: target that was 5 m away is denied (far)');
  ok(!H({ hit: { ...hc, p: [hc.p[0] + 20, hc.p[1], hc.p[2]] } }).ok, 'hit: impact point off the bolt path is denied');
  const v3 = H({ hit: { ...hc, ms: fc.ms + 700 } });
  ok(!v3.ok && v3.why === 'range', 'hit: a SPARK bolt older than 60 m of flight is denied (range)');
  const v4 = H({ blocked: () => true });
  ok(!v4.ok && v4.why === 'blocked', 'hit: terrain, buildings or trees in the way are denied');
  ok(!H({ hostNow: 820 + 600 }).ok, 'hit: claims older than the rewind window are not rewound');
  const shooter = new P.RewindBuffer();
  for (let t = 0; t <= 1000; t += 50) shooter.push(t, [0, 10, -50], [0, 0, 0]);
  const F = (over) => P.checkFire({ fire: fc, fireT: hitT - tau, shooter, lastFireMs: null, tier: 0, soc: 0.8, scrambled: false, ...over }, L);
  ok(F({}).ok && F({ lastFireMs: fc.ms - 200 }).why === 'cooldown' && F({ lastFireMs: fc.ms - 200, tier: 3 }).ok, 'fire: SPARK 4 shots per s refuses 200 ms spacing, NOVA 7 per s allows it');
  ok(F({ fire: { ...fc, o: [40, 10, -50] } }).why === 'far' && F({ scrambled: true }).why === 'phase' && F({ soc: 0.02 }).why === 'battery', 'fire: muzzle 40 m off, scrambled, or under 3 % battery denied');

  // WATER JET: 22 m stream, 5 degree cone, BOLT and up
  const jetShooter = new P.RewindBuffer(), jetTarget = new P.RewindBuffer(), farTarget = new P.RewindBuffer();
  for (let t = 0; t <= 1000; t += 50) { jetShooter.push(t, [0, 10, 0], [0, 0, 0]); jetTarget.push(t, [12, 10, 0], [0, 0, 0]); farTarget.push(t, [40, 10, 0], [0, 0, 0]); }
  const jc = { t: 'jet', id: 21, ms: 9000, target: 4, o: [0.3, 10, 0], d: [1, 0, 0] };
  const J = (over) => P.checkJet({ jet: jc, jetT: 600, hostNow: 620, shooterRttMs: 60, shooterTier: 1, targetTier: 0, shooter: jetShooter, target: jetTarget, lastJetMs: null, tank: 0.4, scrambled: false, ...over }, L);
  ok(J({}).ok, 'jet: BOLT on a SPARK 12 m ahead inside the stream accepted');
  ok(J({ shooterTier: 0 }).why === 'tier' && J({ tank: 0 }).why === 'empty' && J({ lastJetMs: jc.ms - 40 }).why === 'cooldown', 'jet: SPARK has no jet; empty tank and over fast ticks denied');
  ok(J({ target: farTarget }).why === 'far' && J({ jet: { ...jc, d: [0, 0, 1] } }).why === 'far', 'jet: target at 40 m, or 90 degrees off the stream, denied');
  const caster = jetShooter;
  const B = (over) => P.checkBurstCast({ burst: { t: 'burst', id: 31, ms: 40000, a: 'emp', o: [0, 10, 0] }, burstT: 500, caster, lastBurstMs: null, tier: 2, soc: 0.5, scrambled: false, ...over }, L);
  ok(B({}).ok && B({ tier: 1 }).why === 'tier' && B({ tier: 3 }).why === 'tier' && B({ lastBurstMs: 40000 - 10000 }).why === 'cooldown' && B({ soc: 0.04 }).why === 'battery', 'burst cast: EMP is STORM only, 16 s cooldown, 5 % battery');
  ok(P.checkBurstTarget('emp', [0, 10, 0], 500, jetTarget, 0, L).ok && !P.checkBurstTarget('emp', [0, 10, 0], 500, farTarget, 0, L).ok && P.checkBurstTarget('nova', [22, 10, 0], 500, farTarget, 3, L).ok, 'burst targets: EMP 15 m reaches 12 m, not 40 m; NOVA BURST 20 m reaches 18 m');
  const ra = new P.RewindBuffer(), rb = new P.RewindBuffer();
  for (let t = 0; t <= 1000; t += 50) { ra.push(t, [-5 + t / 100, 10, 0], [10, 0, 0]); rb.push(t, [5 - t / 100, 10, 0], [-10, 0, 0]); }
  const ram = P.checkRam(ra, rb, 500, 1.6);
  ok(ram.ok && Math.abs(ram.closing - 20) < 0.5 && !P.checkRam(ra, jetTarget, 500, 1.6).ok, `ram: head on contact seen with ${ram.closing.toFixed(1)} m/s closing; no contact, no ram`);
  ok(P.checkProximity(target, 500, [-15, 10, 1], L.cacheRadius).ok && !P.checkProximity(target, 500, [-15, 30, 1], L.cacheRadius).ok, 'Shine cache: within 2.5 m accepted, 20 m above denied');
  ok(P.checkRingPass(target, 800, [0, 10, 0], [1, 0, 0], 2.6, L).ok === false && P.checkRingPass(target, 2000, [-12, 10, 0], [1, 0, 0], 2.6, L).ok === false && P.checkRingPass(target, 800, [-12, 10, 0], [1, 0, 0], 2.6, L).ok, 'ring: pass through the plane inside 0.95 R near the claimed time');
  ok(!P.checkRingPass(target, 800, [-12, 14, 0], [1, 0, 0], 2.6, L).ok, 'ring: crossing the plane 4 m off a 2.6 m ring is denied');

  // motion guard: honest flight, a teleport, a speed hacker, a fast clock
  const vmax = L.tiers[0].vmax;
  const g = new P.MotionGuard();
  let allOk = true;
  for (let i = 0; i < 40; i++) allOk = g.check({ ...s, ms: i * 50, pos: [i * 1.5, 10, 0], vel: [30, 0, 0] }, i * 50, vmax).ok && allOk;
  ok(allOk && g.strikes === 0, 'motion: a SPARK at 30 m/s (acro top speed) never strikes');
  const tp = g.check({ ...s, ms: 40 * 50, pos: [300, 10, 0], vel: [30, 0, 0] }, 40 * 50, vmax);
  ok(!tp.ok && tp.why === 'teleport', 'motion: 240 m in 50 ms is a teleport');
  const h = new P.MotionGuard();
  let kicked = false;
  for (let i = 0; i < 60 && !kicked; i++) kicked = h.check({ ...s, ms: i * 50, pos: [i * 6, 10, 0], vel: [120, 0, 0] }, i * 50, vmax).kick;
  ok(kicked, 'motion: sustained 120 m/s on a SPARK ends in a kick');
  const ck = new P.MotionGuard();
  let clockStrike = false;
  for (let i = 0; i < 60; i++) if (ck.check({ ...s, ms: i * 100, pos: [i, 10, 0], vel: [1, 0, 0] }, i * 50, vmax).why === 'clock') clockStrike = true;
  ok(clockStrike, 'motion: a sender clock running twice as fast is caught');

  ok(P.senderMayUse('re', null, true) && !P.senderMayUse('re', null, false) && !P.senderMayUse('rx', { t: 'start' }, false) && !P.senderMayUse('rx', { t: 'host' }, false) && P.senderMayUse('rx', { t: 'hello' }, false), 'authority table');
  ok(P.ACTIONS.ctl === 'rx' && !Object.values(P.ACTIONS).some(a => ['st', 'hi', 'bd', 'rc', 'ch', 'bp'].includes(a)), 'action names do not collide with multiplayer.ts');
  const lim = P.makeLimiter();
  let got = 0;
  for (let i = 0; i < 300; i++) if (lim.events.take(0)) got++;
  ok(got === P.ITEM_LIMITS.re.burst && lim.events.take(1000, 80) && !lim.events.take(1000, 1), 'limiter: 160 verdict burst, then 80 per s');
}

// ------------------------------------------------------------------ 2. server

function startServer() {
  return new Promise((resolve, reject) => {
    child = spawn(process.execPath, [path.join(here, 'index.mjs')], {
      env: { ...process.env, PORT: '0', HOST: '127.0.0.1', FILL_MS: '400', START_IN_MS: '1000', MATCH_SIZE: '12', REGION: 'selftest' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let buf = '';
    child.stdout.on('data', d => {
      buf += d;
      for (;;) {
        const i = buf.indexOf('\n');
        if (i < 0) break;
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        try { const j = JSON.parse(line); if (j.ev === 'listening') resolve(j.port); } catch { /* not ours */ }
      }
    });
    child.stderr.on('data', d => process.stderr.write('  [server] ' + d));
    child.on('exit', code => reject(new Error('server exited early with ' + code)));
  });
}

function connect(port, label) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/play`);
    ws.binaryType = 'arraybuffer';
    const c = {
      label, ws, inbox: [], waiters: [],
      send(a, d, extra = {}) { ws.send(JSON.stringify({ a, d, ...extra })); },
      sendBinary(u8) { ws.send(u8); },
      /** first message matching pred, already received or arriving within ms */
      next(pred, ms = 2000) {
        const i = c.inbox.findIndex(pred);
        if (i >= 0) return Promise.resolve(c.inbox.splice(i, 1)[0]);
        return new Promise(res => {
          const w = { pred, res, timer: setTimeout(() => { c.waiters.splice(c.waiters.indexOf(w), 1); res(null); }, ms) };
          c.waiters.push(w);
        });
      },
      /** true when nothing matching pred arrives within ms */
      async none(pred, ms = 300) { return (await c.next(pred, ms)) === null; },
    };
    ws.onmessage = (e) => {
      let msg;
      if (typeof e.data === 'string') { try { msg = JSON.parse(e.data); } catch { return; } }
      else { const u = new Uint8Array(e.data); msg = { a: 'rs-bin', f: u[0], d: u.slice(1) }; }
      const w = c.waiters.find(x => x.pred(msg));
      if (w) { clearTimeout(w.timer); c.waiters.splice(c.waiters.indexOf(w), 1); w.res(msg); }
      else c.inbox.push(msg);
    };
    ws.onopen = () => resolve(c);
    ws.onerror = () => reject(new Error(label + ' could not connect'));
  });
}

const isCtl = (t) => (m) => m.a === 'rx' && m.d && m.d.t === t;

async function serverChecks() {
  console.log('server');
  const port = await startServer();
  ok(port > 0, `server listening on 127.0.0.1:${port}`);
  const base = `http://127.0.0.1:${port}`;

  const A = await connect(port, 'A'), B = await connect(port, 'B'), C = await connect(port, 'C');
  A.send('rx', { t: 'hello', v: P.PROTO_VERSION, name: 'Alpha', skin: 'default', want: 'play' });
  B.send('rx', { t: 'hello', v: P.PROTO_VERSION, name: 'Bravo', skin: 'default', want: 'play' });
  C.send('rx', { t: 'hello', v: P.PROTO_VERSION, name: 'Charlie', skin: 'default', want: 'play' });
  const lobby = await A.next(isCtl('lobby'));
  ok(lobby && P.validateLobby(lobby.d) !== null, 'queued players get a lobby update');

  const yous = await Promise.all([A, B, C].map(c => c.next(isCtl('you'), 3000)));
  const starts = await Promise.all([A, B, C].map(c => c.next(isCtl('start'), 3000)));
  ok(yous.every(Boolean) && starts.every(Boolean), 'all three got a seat and a start');
  if (!yous.every(Boolean) || !starts.every(Boolean)) return;
  const seats = yous.map(y => y.d.seat);
  const st = P.validateStart(starts[0].d);
  ok(new Set(seats).size === 3 && seats.join() === '0,1,2', 'seats 0, 1, 2 in queue order');
  ok(st && new Set(starts.map(x => x.d.match)).size === 1 && st.seats.length === 12 && st.seats.filter(x => x.bot).length === 9 && st.host === 0 && st.zone.r === 420, 'one match of 12: 3 pilots, 9 bots, seat 0 hosts, Signal plan in the start');
  ok(yous.every(y => P.validateYou(y.d) !== null && y.d.token.length >= 16), 'every pilot has a private rejoin token');

  // state relay
  const sB = { seq: 1, ms: 1000, pos: [10, 20, 30], quat: [0, 0, 0, 1], vel: [1, 0, 0], motor: 0.5, flags: 1, aim: 0, soc: 0.9, tank: 0, shine: 2, ack: 0 };
  B.send('rs', P.encodePilotState(sB));
  const [ra, rc] = await Promise.all([A.next(m => m.a === 'rs'), C.next(m => m.a === 'rs')]);
  const va = ra && P.validatePilotState(ra.d);
  ok(ra && rc && ra.f === 1 && rc.f === 1 && va && va.pos[2] === 30 && va.shine === 2, 'B state relayed to A and C, stamped with seat 1');
  ok(await B.none(m => m.a === 'rs', 200), 'B does not get its own state back');
  B.send('rs', P.encodePilotState(sB));
  ok(await A.none(m => m.a === 'rs', 200), 'replayed state (same seq) dropped');
  B.send('rs', [2, 1050, 'x', 0, 0]);
  B.send('rs', [3, 1100, NaN, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0]);
  ok(await A.none(m => m.a === 'rs', 250), 'junk state never reaches other pilots');
  B.sendBinary(P.packPilotState({ ...sB, seq: 4, ms: 1150, pos: [11, 20, 30] }));
  const bin = await A.next(m => m.a === 'rs-bin');
  const vb = bin && P.unpackPilotState(bin.d);
  ok(bin && bin.f === 1 && vb && Math.abs(vb.pos[0] - 11) < 1e-3 && vb.shine === 2, `binary ${P.PILOT_STATE_BYTES} byte state relayed with the seat prefix`);

  // verdicts: one batch per host tick, from the host alone
  const got = (seq, ep = 1) => ({ t: 'got', ep, seq, at: 1000, seat: 1, give: 'shine', item: 3, shine: 5, tier: 1, hp: 100, ref: P.claimRef(1, 5) });
  const zap = (seq, ep = 1) => ({ t: 'zap', ep, seq, at: 1000, amt: 1, seats: [4, 5], hp: [99, 99] });
  const batch = (seq, ep = 1) => P.encodeEventBatch([got(seq, ep), zap(seq + 1, ep)]);
  B.send('re', batch(1));
  ok(await C.none(m => m.a === 're', 250), 'a verdict batch from a non host is dropped');
  B.send('rx', { t: 'start', ep: 9, match: 'fake', seed: 1, inMs: 0, host: 1, seats: [], zone: placeholderSignal(1), rules: 1 });
  ok(await C.none(isCtl('start'), 250), 'a forged start from a pilot is dropped');
  B.send('rx', { t: 'host', ep: 99, seat: 1, last: 0 });
  ok(await C.none(isCtl('host'), 250), 'a forged host claim is dropped (only the server names hosts)');
  A.send('re', batch(1));
  const [eb, ec] = await Promise.all([B.next(m => m.a === 're'), C.next(m => m.a === 're')]);
  const ebv = eb && P.validateEventBatch(eb.d);
  ok(eb && ec && eb.f === 0 && ebv && ebv.map(e => e.t + e.seq).join() === 'got1,zap2', 'host verdict batch relayed to everybody, numbered 1 and 2');
  A.send('re', batch(1));
  ok(await B.none(m => m.a === 're', 250), 'a replayed verdict batch is dropped at the relay');

  // claims: one batch per frame; hit, jet, ring, pick, impact to the host only; fire and burst to all
  C.send('rq', P.encodeClaimBatch(5000, [{ t: 'fire', id: 1, ms: 5000, o: [0, 10, 0], d: [0, 0, 1] }, { t: 'hit', id: 2, ms: 5000, shot: 1, target: 1, p: [0, 10, 3] }, { t: 'ring', id: 3, ms: 5000, ring: 7 }]));
  const [qa, qb] = await Promise.all([
    (async () => { const x = await A.next(m => m.a === 'rq' && m.d.c.some(q => q.t === 'hit')); return x; })(),
    B.next(m => m.a === 'rq'),
  ]);
  const qaList = qa && P.validateClaimBatch(qa.d), qbList = qb && P.validateClaimBatch(qb.d);
  ok(qaList && qa.f === 2 && qaList.map(q => q.t).join() === 'hit,ring' && qaList.every(q => q.ms === 5000), 'the host gets the frame’s hit and ring claims from seat 2');
  ok(qbList && qbList.map(q => q.t).join() === 'fire' && await B.none(m => m.a === 'rq', 250), 'other pilots get only the fire claim, to draw the bolt');

  A.send('rx', { t: 'ping', n: 1, ms: 123 });
  const pong = await A.next(isCtl('pong'));
  ok(pong && P.validatePong(pong.d)?.ms === 123, 'ping answered');
  const health = await (await fetch(base + '/health')).json();
  ok(health.ok && health.matches === 1 && health.players === 3, '/health reports 1 match, 3 players');

  // server phase: the host drops, the server names seat 1 in a new term
  const tokenA = yous[0].d.token;
  A.ws.close();
  const [gone, hostB] = await Promise.all([C.next(isCtl('gone')), B.next(isCtl('host'))]);
  ok(gone && gone.d.seat === 0, 'everybody hears that seat 0 dropped');
  ok(hostB && hostB.d.seat === 1 && hostB.d.ep === 2 && hostB.d.last === 2, 'seat 1 hosts from term 2, continuing after verdict 2');
  B.send('re', batch(3, 1));
  ok(await C.none(m => m.a === 're', 250), 'a verdict batch with the old term is dropped');
  B.send('re', batch(3, 2));
  const ec2 = await C.next(m => m.a === 're');
  ok(ec2 && ec2.f === 1, 'the new host’s verdicts flow');

  // rejoin with the token: seat back, the host is asked to send a full replica
  const A2 = await connect(port, 'A2');
  A2.send('rx', { t: 'hello', v: P.PROTO_VERSION, name: 'Alpha', skin: 'default', want: 'play', token: tokenA });
  const [you2, back, sync] = await Promise.all([A2.next(isCtl('you')), C.next(isCtl('back')), B.next(isCtl('sync'))]);
  ok(you2 && you2.d.seat === 0 && you2.d.token !== tokenA, 'A reclaims seat 0 with its token and gets a fresh one');
  ok(back && back.d.seat === 0 && sync && sync.f === 0, 'pilots hear seat 0 is back; the host is asked for a full sync');

  const metrics = await (await fetch(base + '/metrics')).text();
  const rejected = [...metrics.matchAll(/royale_rejected_total\{reason="([a-z_]+)"\} (\d+)/g)].map(m => `${m[1]}=${m[2]}`);
  ok(/royale_host_migrations_total 1/.test(metrics) && /royale_rejoins_total 1/.test(metrics) && rejected.length > 0, '/metrics: 1 migration, 1 rejoin, rejections ' + rejected.join(' '));

  for (const c of [A2, B, C]) c.ws.close();
}

try {
  protocolChecks();
  await serverChecks();
} catch (e) {
  failures++;
  console.log('FAIL  ' + (e && e.stack || e));
}
clearTimeout(watchdog);
console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
finish(failures ? 1 : 0);
