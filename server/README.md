# DRONE ON Royale server (prototype)

Lobby, matchmaker and relay for the dedicated server phase of Royale (see
`studio/NETCODE.md`, phases 2 and 3). The game does **not** need it today: solo
runs offline and friend rooms are peer to peer over Trystero. This is the first
brick of the later path, small enough to read in one sitting.

## Run it locally

Needs Node 22.18 or newer (Node 24 recommended). No build step, no npm install:
the only dependency is `ws`, which is already in `node_modules`.

```
node server/index.mjs                 # ws://127.0.0.1:8790/play, http://127.0.0.1:8790/health
node server/selftest.mjs              # starts the server, 3 fake clients, exits 0 on success
```

Settings are environment variables:

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | 8790 | listen port (0 picks a free one; the first stdout line says which) |
| `HOST` | 127.0.0.1 | bind address; keep loopback behind a TLS proxy |
| `MATCH_SIZE` | 12 | humans that start a match at once |
| `FILL_MS` | 20000 | queue wait before the match starts with whoever is there; bots take the empty seats |
| `MIN_HUMANS` | 1 | smallest group the fill timer starts |
| `START_IN_MS` | 5000 | countdown in the start message (the GDD intro is 5 s) |
| `MAX_PER_IP` | 16 | open sockets per address |
| `ALLOWED_ORIGINS` | empty (all) | comma list, for example `https://droneshine.github.io` |
| `TRUST_PROXY` | off | `1` reads the client address from `X-Forwarded-For` |
| `REGION` | eu-central | reported in `/health` and logs |
| `LOG` | info | `quiet` prints only the listening line |

Endpoints: `GET /health` (JSON: clients, queue, matches, players), `GET /metrics`
(Prometheus text: connections, matches, migrations, rejoins, kicks, messages in
per action, relayed, skipped stream frames, rejections per reason), WebSocket at `/play`.

## What it does

1. A client connects to `/play` and sends `{"a":"rx","d":{"t":"hello","v":1,"name":"Mila","skin":"default","want":"play"}}`.
2. It waits in the queue and gets `lobby` updates. When 12 humans are queued, or
   `FILL_MS` passed since the oldest joined, the matchmaker builds a match: humans
   get seats 0, 1, 2 in queue order, bots the rest (GDD 2.10 names, Pilot level).
3. Every pilot gets a private `you` (seat plus rejoin token), then everybody gets
   the same `start` (match id, seed, seats, the Signal plan, host seat). The plan
   comes from `placeholder.mjs` (GDD 6.7 numbers) until the Royale tuning module
   `src/royale/tuning.ts` lands; then the server imports that module directly.
4. The lowest seated human is the host and runs the authoritative world exactly
   as in a P2P room. The server relays and referees:
   * every payload goes through the validators of `src/net/royaleProtocol.ts`
     and is re encoded from the validated object, so junk never reaches a peer;
   * authority: only the host may send bots (`rb`), the world snapshot (`rw`) and
     verdicts (`re`); bots may only sit in bot or autopilot seats; `start`,
     `lobby`, `you`, `gone`, `back` and `host` come from the server alone;
   * verdicts arrive as one batch per host tick and must carry the current host
     term (`ep`) and a newer `seq`; pilot states must carry a newer `seq` than
     that pilot's last;
   * claims arrive as one batch per frame; the server splits each batch: hit, jet,
     ring, pick and impact claims to the host only, fire and burst claims to
     everybody (they draw the shot);
   * token buckets per socket for messages per action and for items inside
     batches (40 claims, 80 verdicts per second), 64 KB frame cap; slow sockets
     skip stream frames instead of queueing stale state.
5. The host drops: the server names the next lowest connected human, bumps the
   term and broadcasts `host` with the last verdict seq. No forged claims, no
   split brain. Any pilot that drops keeps the seat for 60 s; `hello` with its
   token puts it back, and the host is asked to send that seat a `full` replica.

Wire: text frames `{"a": action, "d": payload, "to"?: seat}`; the server adds
`"f"` (sender seat, -1 = server). Binary frames carry the 52 byte packed pilot
state (`packPilotState`); the server relays them with the sender seat as one
prefix byte. Actions are the same six as the P2P rooms: `rs rb rw rq re rx`
(control is `rx` because `multiplayer.ts` already uses `rc` for races).

## Why it imports the TypeScript directly

`index.mjs` does `import * as P from '../src/net/royaleProtocol.ts'`. Node 22.18+
and 24 strip TypeScript types natively, and the protocol file is written as
erasable TypeScript only (no enums, no namespaces, no parameter properties, no
imports). So the server runs the very validators the game ships, with no build
step and no second copy that could drift. The protocol holds no game numbers:
the host checks take a `RoyaleLimits` argument (`placeholder.mjs` has the GDD
values for the selftest). If an older Node is ever needed, run
`node --experimental-strip-types server/index.mjs` (22.6 to 22.17) or bundle with
`npx rolldown src/net/royaleProtocol.ts --file server/protocol.mjs --format esm`.

## Not in the prototype (on purpose)

Bots and the authoritative world still run on the host client (P2P rooms this
cycle end the match when the host leaves; the server's host handover is the
server phase). Moving them here
is the phase 2 step in NETCODE.md: the game's Royale host module must be pure
TypeScript with a transport interface, then it runs here unchanged next to a
headless `DroneSim` (measured 3.6 to 4.0 µs per 400 Hz step in Node). Also
missing: TLS (the proxy does it), persistence, accounts, multi node queues
(Redis), spectator delay, binary batched snapshots.

## Deploying it (when the triggers in NETCODE.md fire)

One small box per region is plenty for a long time: one Node process per core,
many matches per process.

1. A Hetzner ARM box (CAX21 or CAX41, Falkenstein or Helsinki) in its **own**
   Hetzner project. DroneShine's existing tools server could host a test
   instance, but game traffic must not share a box with company tools.
2. Caddy in front for TLS and the `wss://` name, for example
   `royale-eu.droneshine.de { reverse_proxy 127.0.0.1:8790 }`, with `TRUST_PROXY=1`
   and `ALLOWED_ORIGINS=https://droneshine.github.io`. Optionally Cloudflare
   proxied DNS in front for DDoS protection (WebSockets pass through).
3. A systemd unit: `ExecStart=/usr/bin/node /opt/royale/server/index.mjs`,
   `Restart=always`, `Environment=REGION=eu-central`, plus the repo checkout
   containing `server/`, `src/net/royaleProtocol.ts` and `node_modules/ws`.
   SIGTERM closes sockets with 1001 so clients reconnect with their token.
4. Prometheus scrapes `/metrics`; an uptime check polls `/health`.
5. More regions: same unit on a box in Ashburn (x86 CPX line) and later
   Singapore; the client pings each region's `/health` once and picks the lowest.

The same file runs unchanged in a container (`FROM node:24-slim`, copy the three
paths above, `CMD ["node", "server/index.mjs"]`) for Fly.io or Edgegap if a
region is cheaper there.
