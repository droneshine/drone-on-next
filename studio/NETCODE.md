# DRONE ON Next: Royale netcode

Version 1.1, 03.10.2026. Owner: Server Consultant.
Aligned with `studio/GDD.md` v1.0 (2.6 to 2.13, 6.1 to 6.7) and the production lead's decisions of 03.10.

Code that ships with this document:

- `src/net/royaleProtocol.ts`: wire protocol, one validator per message, batching, host checks, helpers.
  Pure TypeScript, no imports, no game numbers.
- `server/`: lobby, matchmaker and relay prototype for the later phase. `node server/selftest.mjs` proves it.

## 0. Decisions in one screen

1. **Solo never touches the network.** The Royale host module talks to a small transport interface.
   Solo plugs in an in process loopback, rooms plug in Trystero, the later server plugs in WebSocket.
2. **Rooms stay peer to peer** (Trystero, Nostr signalling, WebRTC full mesh), as the brief locks.
   The room's settled host presses START and is authoritative for the whole match.
3. **The host owns every number that decides the match**: Signal, Static, rings and pickups, Shine, tier,
   integrity, knockouts, kill credit, placement, bots, match clock. Pilots own only their flight
   (pose, velocity, battery, tank) and send **claims**, never numbers.
4. **Hits favor the shooter, within 350 ms.** The shooter's screen detects the hit and claims it;
   the host rewinds the target by what the shooter saw and checks the deterministic bolt against it.
5. **Every message is validated** (`validateX(raw): X | null`, never throws, never mutates its input;
   304,000 fuzzed calls in the selftest, zero throws). The relay server runs the same file.
6. **No game numbers in the protocol.** The host checks take a `RoyaleLimits` argument built from the
   Royale tuning module (`src/royale/tuning.ts`, owned by the Royale programmer, GDD section 6).
   The Signal plan travels as data in the start message.
7. **Batching.** The host sends at most one verdict message per tick (30 Hz) holding an array of verdicts.
   Pilots send their claims batched per frame. Receivers enforce 80 verdicts per second (burst 160).
8. **Host left ends the match this cycle** ("HOST LEFT. MATCH ENDED", GDD 2.13). Takeover is P1 (section 8).
9. **Bandwidth is fine for 12**: 0.42 Mbit/s up and 0.45 Mbit/s down per guest at worst, 0.7 Mbit/s up
   for the host, about half that with distance based rates.
10. **Dedicated servers when strangers play together**, not before. Then Hetzner boxes running this same
    code: about €140 per month at 100k daily players, €1.2k to 2k at 1M.

## 1. What the stack does today

| Fact | Consequence |
|---|---|
| Trystero 0.25, Nostr relays for signalling, full WebRTC mesh | 12 humans means 66 links; every pilot sends its state to 11 others |
| One data channel per link with defaults: **reliable and ordered** | a lost packet stalls everything behind it for one retransmit (about 1 RTT, often 50 to 300 ms), then a burst arrives; nothing is ever dropped |
| Every Trystero message carries a 36 byte header (action name padded to 32 bytes); arrays and objects travel as JSON | with SCTP, DTLS, UDP and IP that is about 129 bytes per message before payload |
| ICE: Google and Cloudflare STUN only, **no TURN** | pairs behind symmetric or carrier grade NAT never connect; a full 12 mesh is complete with probability (1 − p)^66: 52 % at a 1 % pair failure rate, 13 % at 3 % |
| `room.getPeers()` exposes the RTCPeerConnections; `turnConfig`, `rtcConfig` and `password` are options | TURN, relay only mode, an extra unreliable channel and encrypted SDP are possible without forking Trystero |
| `multiplayer.ts` uses actions `st hi bd rc ch bp`; 20 Hz state with sender timestamps, smallest offset clock filter, render 100 ms in the past, validate everything, host only race control | Royale reuses the clock filter (`OffsetFilter`) and the 100 ms delay; its control action is `rx` because `rc` is taken by races |

## 2. Who is authoritative for what

| Owner | Decides | Others learn it from |
|---|---|---|
| **Host** | seed, seats, bot levels, Signal plan (centres with the GDD 6.7 POI bias and land rule) | `start` |
| **Host** | Static every 0.5 s; integrity and all damage: Pulse, Water Jet, EMP, Nova Burst, rams, world impacts | `dmg`, `zap`; world snapshot at 5 Hz repairs |
| **Host** | personal Shine ring takers (each pilot each ring once), shared Big Shine, Charge, Repair and their respawn, Shine caches | `got`, `deny`, `spawn` |
| **Host** | Shine total, tier and the evolve moment, salvage, overcharge, lane bonus | `got` carries Shine, tier and integrity after |
| **Host** | knockout, kill credit (last enemy within 10 s), placement, ties (GDD 6.4), match end | `elim`, `end` |
| **Host** | bots: a `DroneSim` per tier at 100 Hz (50 Hz beyond 250 m) with the GDD brains | `rb` at 10 Hz; bot integrity in the snapshot |
| **Host** | match clock (ms since GO) | `at` on every verdict batch, `matchMs` in the snapshot |
| **Each pilot** | its own `DroneSim`: pose, velocity, motors, flight mode, battery `soc`, water `tank` | `rs` at 20 Hz |
| **Each pilot** | applying pushes, scrambles and Charge ring battery and water to its own sim | gets `fx` and `got`; shows `SCRAMBLED` in its flags |
| **Each pilot** | detecting its hits, jet ticks, ring passes, pickups and impacts (the real flight model reports them) | claims `rq` |
| **Nobody** | tier specs (GDD 6.1 constants by tier id), ring layout (GDD 6.6), tuning | the tuning module, same on every screen |

GDD 2.13 asks that pilots announce their tier by id. The tier does travel, but **from the host**
(in `got` and the snapshot), because a tier announced by the pilot is a free Nova.
Peers then look the spec up by id exactly as the GDD says.
The pilot's own Shine count travels in its state for display and spectating; the host's count wins.

## 3. Transports and rooms

A Royale match runs inside the existing squad room with six new actions next to `st hi bd rc ch bp`:
`rs` pilot state, `rb` bots, `rw` world, `rq` claim batches, `re` verdict batches, `rx` control.
During a match pilots stream `rs` and pause `st`.

| Transport | Used by | Notes |
|---|---|---|
| Loopback | solo against 11 bots | in process calls, no serialization, starts with the network off (GDD P0 item 1) |
| Trystero | friend rooms | `rq`, `re`, `rx` as JSON strings (size capped before parse, as `multiplayer.ts` does), streams as number arrays; add `password: code` to `joinRoom` so relay observers cannot read SDP |
| WebSocket | dedicated server (phase 2 and later) | the prototype in `server/`; the same validators run on both ends |

## 4. Messages

Sizes are measured JSON characters for realistic values.
"Wire" adds the 129 bytes of Trystero, SCTP, DTLS, UDP and IP overhead per message.

| Action | Content | From, to | Rate | Payload | Wire |
|---|---|---|---|---|---|
| `rs` | `[seq, ms, x, y, z, qx, qy, qz, qw, vx, vy, vz, motor, flags, aim, soc, tank, shine, ack]` | pilot to all | 20 Hz; 5 Hz beyond 350 m; 1 Hz spectating | 110 B (binary form 52 B) | 239 B |
| `rb` | `[seq, ms, n, n × (seat, pose, velocity, motor, flags, aim)]` | host to all | 10 Hz | 890 B for 11 bots | 1,019 B |
| `rw` | `[ep, seq, matchMs, phase, alive, n, n × (seat, hp, tier, shine, status)]` | host to all | 5 Hz | 167 B | 296 B |
| `rq` | `{ms, c: [claims]}`, one per frame with claims: `fire` and `burst` to all, the rest to the host | pilot | ≤ 2 per frame, 40 claims per s | 96 B for one shot, 172 B for hit plus jet | 225 B, 301 B |
| `re` | `{ep, seq, at, ev: [verdicts]}`, verdict i gets seq + i | host to all | ≤ 1 per host tick (30 Hz), 80 verdicts per s | 115 B for one, about 82 B per verdict in a full batch | 244 B for one |
| `rx` | `hello lobby you start host sync full ping pong gone back bye` | mixed | rare | `start` 1.6 KB, `full` 2.7 KB | |

Claims: `fire` (Pulse shot: origin, direction), `hit` (shot id, target seat, impact point),
`jet` (one Water Jet tick on a target: nozzle, stream direction), `burst` (EMP or Nova Burst at the end of the charge),
`ring` (personal Shine ring), `pick` (Big Shine, Charge, Repair or a Shine cache),
`impact` (own sim hit `ground`, `tree`, `lake`, `blade`, or `ram` with the other seat).

Verdicts: `dmg` (target, source, amount, integrity after, cause, answered claim), `zap` (one Static tick for all
drones outside), `fx` (`push` with force or `scramble`, applied by the victim), `got` (Shine, lane bonus, Big Shine,
Charge, Repair, cache or salvage, with Shine, tier and integrity after), `deny`, `spawn` (Shine caches), `elim`
(victim, credited seat, cause, place), `seat` (server phase), `end` (winner, order, why: `last`, `host`, `abort`).

Causes map one to one onto the GDD 2.6 kill feed: `pulse jet emp nova ram ground tree static lake blade left`.
State flags: ARMED, CRASHED, JET (others draw the stream), BOOST, PARKED, SPECTATE, CHARGING, SCRAMBLED, LANDED, INVULN.
Pickups are exactly those of GDD 2.5: no weapon or shield pickups exist in the protocol.

## 5. Limits the host checks need (from the tuning module)

The protocol defines `RoyaleLimits`; the Royale programmer builds one from `tuning.ts` and passes it to every check.
Values below are GDD section 6 for reference only; the code never hardcodes them.

| `RoyaleLimits` field | GDD | SPARK / BOLT / STORM / NOVA |
|---|---|---|
| `tiers[i].pulseIntervalMs` | 6.2 shots per s | 250 / 200 / 167 / 143 |
| `tiers[i].pulseSpeed`, `pulseRange` | 6.2 | 110 to 140 m/s, 60 / 70 / 80 / 90 m |
| `tiers[i].hitRadius` | 6.2 hit sphere | 0.67 / 0.78 / 0.90 / 0.97 m |
| `tiers[i].jet`, `special` | 6.2 tank, special | no, yes, yes, yes; none, none, `emp`, `nova` |
| `tiers[i].vmax` | 2.4 acro top speed plus margin, QA measures | placeholder 45 / 47 / 49 / 51 m/s |
| `pulseMinSoc` | 6.3 disabled below 3 % | 0.03 |
| `jet.range`, `coneDeg`, `tickMs` | 6.3 | 22 m, 5°, 100 ms |
| `bursts.emp`, `bursts.nova` (radius, cooldown, battery) | 6.3 | 15 m, 16 s, 5 %; 20 m, 14 s, 5 % |
| `ringPass`, `cacheRadius` | 6.5 | 0.95, 2.5 m |
| Signal plan (not a limit: data in `start`) | 6.7 | `ZoneSchedule`: centre, radius, ceiling, `ceilMs` 10 s, five phases plus overtime |

`server/placeholder.mjs` mirrors these numbers until `tuning.ts` lands; the server then imports the module instead.

## 6. Clocks, interpolation, lag compensation

**Clocks.** Every stream sample and claim batch carries the sender's `performance.now()`.
Receivers map it with `OffsetFilter`: follow the smallest observed offset at once, drift up 1 % per sample.
Remote drones render 100 ms in the past on their own clock, as today.
Match time: guests set `matchZero` from the `start` countdown and correct it with `matchMs` (5 Hz).
The Signal is computed locally from the plan (`zoneAt`), so every wall moves within one way latency of the host's:
the GDD's "within 0.5 s on every screen" holds with room to spare.

**Own drone.** Never corrected: each pilot flies its real sim with zero input lag.
That is what makes P2P feel right for a flight game, and why speed hacks stay possible (section 10).

**Shooter side prediction.** The shooter spawns the bolt at once, runs the deterministic path (`projectileAt`:
straight, no gravity, no inherited velocity, life = range / speed) against the drones as it renders them,
and on contact shows the hit marker, plays the sound and adds `hit` to this frame's claim batch.
Floating damage numbers wait for the host's `dmg` (one RTT, 30 to 150 ms in rooms).
Other screens draw the bolt from the broadcast `fire`, fast forwarded by its age so it does not trail.

**Host validation with rewind.** The host keeps a `RewindBuffer` per drone (32 samples on the host clock, 1.6 s).
For a hit claimed at shooter time `t` it rewinds the target to `t` mapped, minus 100 ms, minus half the shooter RTT,
never further than 350 ms before now, and accepts when bolt and target come within the target tier's hit sphere
plus 0.35 m plus 3 % of target speed, scanning ±60 ms.
Before that: the shot exists and belongs to the shooter, is younger than its range allows, the impact point lies
on the path, line of sight holds (the host's terrain and building raycast, `blocked`), one hit per bolt.
Above about 250 ms one way latency a pilot is no longer fully compensated and must lead its shots;
in exchange nobody is ever hit "behind cover" by more than 350 ms of history.

## 7. Every mechanic, end to end

| Mechanic | Detected by | Claim | Host check (`royaleProtocol.ts`) | Verdict |
|---|---|---|---|---|
| PULSE | shooter | `fire` to all | `checkFire`: not scrambled, battery, tier fire interval on the shooter's clock, muzzle within 4 m of its stream | silent if fine; `deny` removes the bolt |
| PULSE hit | shooter's screen | `hit` | `checkHit`: rewind, path, range, line of sight, one hit per bolt | `dmg pulse` with the tier damage |
| WATER JET | shooter; JET flag draws the stream | `jet` per 0.1 s tick | `checkJet`: tier carries a jet, tick spacing, tank > 0 in the stream, target inside range and cone at the rewound time, line of sight | per target at most 5 Hz: one `dmg jet` (two ticks summed) and one `fx push` for 0.2 s |
| EMP, NOVA BURST | caster; CHARGING flag during the charge | `burst` to all | `checkBurstCast` (tier, cooldown, battery, centre at the caster), then `checkBurstTarget` per drone (radius plus hit sphere, line of sight), scramble immunity | one `dmg` per target, one `fx scramble` listing all targets |
| Ram | both sims (the existing bump) | `impact ram` from each pilot | `checkRam` on both streams; closing speed = min(claimed, seen + 3 m/s) | `dmg ram` to each, GDD 6.4 formula |
| World impact | own sim in durable mode | `impact ground` or `tree` | impact speed ≤ streamed speed + 3 m/s | `dmg ground` or `dmg tree`, GDD 6.4 |
| Lake, turbine | own sim | `impact lake` or `blade` | stream at the water surface or the blade disc | `elim lake` or `elim blade` (credit if an enemy hit within 10 s) |
| Shine ring | pilot | `ring` | `PersonalRings.take` (each pilot each ring once) and `checkRingPass` | `got shine`; `got lane` for a lane in order |
| Big Shine, Charge, Repair | pilot | `pick` | available now (host respawn timers), plane crossing; first valid claim wins | `got` to the winner, `deny taken` to the rest; respawn derived from `at` |
| Shine cache | host on knockout | `pick` | `checkProximity` with `cacheRadius`, lifetime | `spawn`, then `got cache` |
| Static | host every 0.5 s | none | `inSignal` (wall and ceiling) on each stream | one `zap` for all drones outside |
| Knockout | host at integrity 0 | none | credit window, same tick ties | `elim`, `got salvage` to the knocker, `spawn` cache |
| Evolve | host when Shine crosses a tier | inside `got` | | the pilot hot swaps its sim (GDD 2.4); the 0.8 s evolve moment hides the RTT |

Prediction where it pays: personal rings dim and the Shine bar ticks at once on the pilot's own screen
(the host only refuses an implausible pass, which an honest pilot never sees).
Shared items show "taken" only on `got`, because two pilots can reach a Big Shine in the same frame.

## 8. Ordering, idempotency, joining and leaving

**Exactly once, in order.**

- Streams: per sender `seq`; anything not newer than the last sample is dropped (`seqNewer`, wrap safe).
- Claims: per sender `id`; the host keys them as `claimRef(seat, id)` in a bounded `DedupeSet`,
  so a resent claim gets the same answer. Junk claims inside a batch are dropped one by one.
- Verdicts: `(ep, seq)`, numbered `seq + i` inside a batch. A verdict batch is all or nothing,
  so junk can never punch a hole into the sequence. Guests apply them through `OrderedInbox`:
  duplicates and other terms dropped, early ones held, a gap older than 1 s triggers `sync`, answered by `full`.
- Pilots echo the last applied verdict as `ack` in their state, so the host sees who lags.
- Every verdict is broadcast, so every guest holds a complete replica of the world.
  That keeps late join, spectating and the later takeover cheap.

**Joining and leaving, this cycle.**

| Situation | This cycle (GDD 2.13) |
|---|---|
| Joins the room during a match | spectates (it receives everything already), plays the next match |
| Guest leaves, or is silent 10 s | the host knocks the drone out, cause `left`, no credit |
| Host leaves gracefully | the host sends `end` with why `host` |
| Host vanishes (`onPeerLeave`, or no `rw` for `HOST_LOST_MS` = 3 s) | each guest ends locally from the last snapshot: "HOST LEFT. MATCH ENDED" |
| Rematch | `start` again with a new seed |

**P1: host takeover (designed, not in the client path).** The protocol already carries what it needs:
the term `ep` on every verdict, `full` replicas and `sync`. The rule:

1. The successor is the lowest seated human that still hears the room and has not heard the host for 2 s.
2. It announces itself with a new term (`ep + 1`) and its last verdict `seq`.
3. Others accept a claim only if the term is newer and the claimant is the lowest seat they still hear
   (old host excluded); equal terms go to the lower seat. An old host that is still alive steps down.
4. The new host continues from its replica, broadcasts `full`, restarts the bots from their last streamed
   states, and pilots resend unanswered claims (deduped by `ref`). Verdicts that reached some guests but not
   the new host are rolled back by `full`; rare, accepted.
5. Dropped pilots keep their seat on autopilot for 60 s and reclaim it with a private token (`you`, `hello`).

The relay prototype already does steps 4 and 5 with the server as the referee, which also removes split brain.

## 9. Packet loss and bad links

- The reliable ordered channel turns loss into a stall. Streams absorb it with the 100 ms buffer, then extrapolate
  along velocity for at most 150 ms, then hold; after 2 s of silence the drone hides (as today).
- Never queue stale state: if the previous `rs` send has not resolved, skip this frame.
- Claims carry their frame time, so a claim that waited 200 ms in a stall is judged at the moment it happened.
- Verdict batches arrive whole or not at all; a guest that misses one asks for `full`.
- P1: move `rs` and `rb` to a second data channel created on each `getPeers()` connection with
  `{negotiated: true, id: 7, ordered: false, maxRetransmits: 0}` on both sides (no renegotiation needed).
  Loss then drops one sample instead of stalling the verdicts behind it.
- P1: host relay fallback. When a guest hears the host but not pilot X while the snapshot says X flies,
  the host forwards X's state to that guest. Fixes most broken mesh links without TURN.

## 10. Bandwidth per peer, 12 drones

| Case | Guest up | Guest down | Host up | Packets |
|---|---|---|---|---|
| 12 humans, all within 350 m, 20 Hz JSON | 53 KB/s (0.42 Mbit/s) | 56 KB/s (0.45 Mbit/s) | 86 KB/s (0.69 Mbit/s) | 220 per s each way |
| 12 humans, distance rates (3 near, 8 far) | 24 KB/s | 27 KB/s | 52 KB/s | 100 per s |
| 4 humans, 8 bots | 14 KB/s | 25 KB/s | 45 KB/s | 60 per s |
| big fight in view (4 Novas firing, 2 jets on) | +19 KB/s while firing (7 shots per s to 11 peers, jet ticks to the host) | +14 KB/s | +80 KB/s (1.3 to 1.5 Mbit/s total at the peak) | +80 per s |
| binary `rs` (52 B; Trystero sends typed arrays raw) | −25 % on states | −25 % | −20 % | |
| dedicated server (star, batched binary snapshot) | 2 to 3 KB/s | 6 to 12 KB/s, plan with 8 | none | 20 per s |

The verdict budget: a 12 drone brawl peaks around 40 to 85 verdicts per second (Pulse hits, jet damage and pushes
merged per target at 5 Hz, Static, pickups). Receivers allow 80 per second with a burst of 160.
The host keeps under it by merging jet and Static damage per target; above 60 per second it merges Pulse damage
per target per tick too. A batch rejected by the limit shows up as a gap and costs one `full`.

Mobile data for a 6 minute match at worst: about 40 MB in a full human mesh, 20 MB with distance rates,
4 MB against a server. Fine on Wi Fi and 4G, and a reason to prefer servers for public play on phones.
The host carries the most: prefer a desktop or a phone on Wi Fi as room host.

## 11. Cheating

| Vector | Mitigation now (P2P) | Only a dedicated server fixes |
|---|---|---|
| Speed hack, modified flight model | specs never travel (tier constants by id); `MotionGuard`: speed and teleport envelope per tier (`vmax`), elapsed time capped by the host's own clock, sender clock skew above 8 % strikes; strikes decay, 8 strikes knock the drone out | input authoritative flight: the server simulates, the client predicts and reconciles |
| Teleport | rejected samples; hits and rings are judged on the host's buffer, which only holds accepted samples | same |
| Fake hits, made up damage | clients never send damage; every hit references a broadcast `fire`; fire interval per tier, muzzle near the stream, rewind ≤ 350 ms, path, range, line of sight, one hit per bolt | aimbots inside legal geometry (server side statistics); aim assist exists anyway (GDD 6.9) |
| Fake rings, pickups, Shine | Shine, tier and integrity only from the host; `PersonalRings` plus plane crossing on the stream; shared items first valid claim wins, host timers | none needed |
| Ignoring push, scramble, impacts, battery | integrity is host owned, so damage cannot be ignored; scrambled drones get weapons denied; the host flags acceleration during a scramble and missing impacts (stream stops dead at terrain height with no claim: the host applies the damage); `soc` may only rise at recharge rates or after a Charge `got` | movement during a scramble stays possible until input authority |
| Forged verdicts or host claims | authority by Trystero peer id, which comes from the DTLS connection and cannot be forged in a payload; verdicts, bots, world and host only control accepted only from the peer that sent `start` (`senderMayUse`); no takeover this cycle | the server names the host (the prototype does) |
| A malicious host | its own claims run through the same checks (fair for honest hosts); rooms are friends only; results feed nothing persistent | everything: never let strangers host |
| Replays, duplicates, injection | stream seq, claim ids and dedupe, `(ep, seq)` verdicts, `password: code` on the room | |
| Floods and junk | token buckets per sender for messages and for items in batches (`RATE_LIMITS`, `ITEM_LIMITS`), size caps before `JSON.parse`, validators that clamp or reject; abusive peers are ignored | kicking at the edge, IP based limits |
| Peer IP addresses visible (streamer harassment) | optional "hide my IP": `iceTransportPolicy: 'relay'` through TURN | servers hide every player's IP |
| Positions of everyone visible | low value in open sky | interest management: do not send what a pilot cannot see |
| Local XP and level edits | irrelevant while progress is local | server recorded results before any leaderboard or reward |

Top three to build first: host owned numbers with rewind checked claims; `MotionGuard` per tier;
authority by peer id plus token buckets and size caps.

## 12. The path to scale

**What runs where.**
Client: input, its own `DroneSim`, rendering, audio, UI; later reconciliation.
Match server (Node 24, one process per core, many matches per process): the Royale host module unchanged,
the bots' `DroneSim`s, validation, Static, snapshots.
Matchmaker: queues per region and mode, fill timer, party tickets, assigns a match server, signs a join ticket;
stateless, with Redis once there is more than one node.
Edge: Caddy for TLS, optionally Cloudflare proxied DNS against DDoS.

**Headless.** `DroneSim`, `ColliderWorld` and `heightAt` are pure three.js math. Bundled with rolldown and run
in Node 24 on this dev machine: **3.6 to 4.0 µs per 400 Hz step**. A GDD bot at 100 Hz costs 0.04 % of a core;
re simulating 9 humans at 400 Hz (phase 3) costs 1.4 %. The world builders create meshes and textures, so the
server needs a colliders only path (`buildRoyaleColliders()`, about a day). `royaleProtocol.ts` and an import
free `tuning.ts` run in Node unchanged.

**Tick rates.** World tick 30 Hz (claims, Static every 0.5 s, verdict batches). Snapshots 20 Hz near, 5 Hz far,
one binary frame per client per tick. Bots 100 / 50 Hz per GDD.
Phase 3: client input at 60 Hz, server physics at 400 Hz substeps, the client reconciles its own drone.

**Transport.** WebSocket first: works everywhere, stalls like today's channel. Then unreliable snapshots:
WebRTC data channels terminated on the server, or WebTransport datagrams once Safari support is dependable.

**Matchmaking and regions.** The client pings each region's `/health` once and picks the lowest.
Start with eu central (Falkenstein, Nuremberg, Helsinki); add us east when more than 15 % of players come from
the Americas; ap southeast later. Fill timer 20 s, then bots fill (GDD: bots fill every seat).
Skill bands by Pilot Rating only once a region's queue holds more than about 200 players.

**TURN for P2P.** About 10 % of players (more on mobile carrier networks) need TURN. A relayed pilot in a full mesh
pushes about 100 KB/s through it, 360 MB per hour. Mint short lived credentials from a tiny endpoint, never ship
static ones. Cloudflare Realtime TURN costs $0.05 per GB after 1 TB free per month: free at 1k daily players,
about $2.1k per month at 100k (43 TB). Self hosted coturn on Hetzner (20 TB included per box) does it for €50 to 100.
**At 100k daily players, P2P plus managed TURN costs more than dedicated servers.**

**Observability.** The prototype exposes `/metrics` (Prometheus) and `/health`. Track tick time p99 (target under
10 ms), snapshot jitter, RTT p50 and p95 per region, connect success, matches started and abandoned, rejections per
reason, motion guard strikes, host migrations, queue wait. In the P2P phase add one anonymous beacon per match end
(no names, no ids: connect failures, RTT, stalls, TURN use, abandoned) to a tiny endpoint; otherwise there is no
visibility at all. JSON logs, Prometheus and Grafana, client error reporting.

**Hosting cost per month.** Assumptions: 24 Royale minutes per daily player (4 matches), peak concurrency 4.2 % of
daily players (2.5 × the average), 9 humans per match plus bots, 15 matches per vCPU (conservative against the
measured sim cost), 30 % headroom, 8 KB/s egress per player (29 MB per player hour), Hetzner prices after the
June 2026 increase.

| Daily players | Peak players / matches | vCPU | Egress | Hetzner ARM (CAX41: 16 vCPU, €41, 20 TB) | Fly.io ($31 per dedicated vCPU, $0.02/GB) | Cloudflare Durable Objects (one per match) | Edgegap ($0.069 per vCPU hour, $0.10/GB) |
|---|---|---|---|---|---|---|---|
| 1k | 42 / 5 | 1 | 0.35 TB | ~€18 (three small boxes incl. TURN) | ~$70 | ~$20 | ~$60 |
| 100k | 4,200 / 470 | 41 | 35 TB | ~€140 (3 × CAX41 plus control) | ~$2.0k | ~$1.4k | ~$5.7k |
| 1M | 42,000 / 4,700 | 405 | 350 TB | ~€1.2k EU only, ~€2k with a US region on x86 | ~$19.5k | ~$14k | ~$57k |

- Hetzner bills per box per month and includes traffic in the EU; ARM boxes are EU only and allowances outside
  the EU are smaller, check before ordering.
- Fly and Edgegap bill by use, so off peak scaling cuts 30 to 50 %; Edgegap has the most locations.
- Durable Objects bill wall clock duration at 128 MB plus incoming messages (20 count as one request) and have no
  egress fees. They fit the relay and the host logic; a 400 Hz authoritative sim inside one is unproven.
- Hathora reportedly stopped game server hosting in 2026: never build on a vendor SDK; keep the server a plain
  Node process plus a container.
- DroneShine already runs a Hetzner box for its tools. Fine for an internal test of `server/`; production game
  traffic gets its own boxes in its own project. Nothing here depends on it.

## 13. Phases and triggers

| Phase | Scope | Start when |
|---|---|---|
| **0, this cycle** | loopback solo; friend rooms P2P with the started host authoritative; protocol v1 with validators and batching; host left ends the match; `password: code`; distance rates | now |
| **1, next cycle** | host takeover and autopilot seat hold (section 8); unreliable state channel; host relay fallback; TURN with short lived credentials and "hide my IP"; anonymous match beacon | rooms with 4 or more humans are common, or connect failures above 3 % of joins, or host left ends above 5 % of room matches |
| **2, dedicated servers** | public quick match with strangers: `server/` grows from relay to authoritative host (same module, headless sim), one Hetzner box per region, Caddy plus Cloudflare | any of: players ask for quick match or solo only players churn faster; more than about 300 concurrent Royale players in a region (queues fill in under 20 s); TURN bill above €200 per month; cheating reports above 1 % of matches; leaderboards, ranked or rewards planned |
| **3, scale and ranked** | input authoritative flight for ranked, autoscaling with Fly or Edgegap burst capacity for far regions, unreliable transport, 30 to 50 pilot matches (GDD 2.15) | more than 50k daily players, or ranked launches |

**Recommendation.** Ship phase 0 exactly as the GDD scopes it; it costs nothing to run.
What matters now is structure: write the Royale host as a pure TypeScript module behind the transport interface,
feed it `RoyaleLimits` from `tuning.ts`, and send every message through `royaleProtocol.ts`.
Then phase 2 is a deployment, not a rewrite. When servers come, Hetzner is about ten times cheaper than the
alternatives at every scale for European players.

## 14. Verify

- `npx tsc --noEmit -p .` in `C:\Users\lucam\droneshine-next`: zero errors.
- `node server/selftest.mjs`: 89 checks. Protocol: round trips, clamps, claim and verdict batches, fuzz,
  ordering, rewind checks for every weapon with GDD limits passed in, the Signal plan interpreter, motion guard.
  Server: three clients matched into one game of 12 (9 bots), state relayed, junk and forged authority dropped,
  claim batches routed, verdict batches relayed, host migrated, seat reclaimed with the token. Exit 0.
