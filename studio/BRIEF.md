# DRONE ON Next: studio brief

Owner: Luca Musiolik (DroneShine). Production lead: Claude (orchestrates the team, merges, ships).

## The mandate
Turn DRONE ON into a game with breakout potential. Two pillars:

1. **SPIELWIESE** (the sandbox, keep the name): free flight, skill training, building drones and courses, sharing. It already exists and works (live at droneshine.github.io/drone-on). Make it deeper and stickier: players must *feel* themselves getting better and want to come back tomorrow.
2. **ROYALE** (new): a drone battle royale. Everybody starts with the simplest drone. You get stronger during the match (Luca's seed idea: fly through rings to upgrade your drone; bring better ideas). Shrinking zone, last drone flying wins.

The live game must never be touched. This version deploys separately to **droneshine.github.io/drone-on-next** from repo `droneshine/drone-on-next`, local worktree `C:\Users\lucam\droneshine-next`, branch `next`.

## Locked decisions (do not reopen without a strong reason)
- **Stack:** Three.js r186, TypeScript, Vite 8, browser, PWA. No engine change, no new heavy dependencies without the production lead's OK. `npx tsc --noEmit -p .` must stay at zero errors.
- **Platforms:** desktop (keyboard, mouse, gamepad, USB RC), phones (touch, portrait and landscape), and the SIYI UniRC 7 Pro (Android Chrome, desktop site mode, about 960x600 touch screen plus its RC sticks as a gamepad). Every feature must be playable on touch. Target 60 fps on a mid range phone, 30 fps floor.
- **Flight:** the real flight model stays (src/sim/drone.ts: rigid body at 400 Hz, motors, battery, GPS/Angle/Acro). Royale drones are DroneSpecs with tuned numbers, not a separate arcade physics. Assists are allowed (GPS mode default for new players, aim assist), but a drone always flies like a drone.
- **Multiplayer:** peer to peer rooms over Trystero (Nostr signalling, WebRTC), what the game already uses (src/net/multiplayer.ts). Royale: the host is authoritative for the shared world (zone, rings, pickups, bots, damage, eliminations); every pilot simulates their own drone and streams it. Up to 12 drones per match, bots fill empty seats. **Solo Royale against bots must start instantly with no network.** A dedicated server is a later step: design it, do not depend on it.
- **Tone and audience:** all ages (PEGI 7 target). Drones knock each other out of the sky with energy, water and EMP effects. No blood, no people being hurt, no real weapons.
- **Brand:** DroneShine palette (Evergreen #002518, Green #004225, Off White #F7F7F2, Light Green #B5F78A, Accent Green #26C257, Blue #8FC2F5), Nasalization only where locally installed with Audiowide as the web face, Inter for text. **No dashes (-, –, —) in any visible copy**; ranges are written with "bis" or "to". No third party drone brand names.
- **Free to play, no payments in code.** A cosmetic only economy may be *designed* for later.
- **Saves:** this version uses its own storage namespace (`droneon2.`); it may read the live game's saves, never write them.

## Codebase map (read before you plan)
- `src/game/game.ts` game loop, states (menu, fly, mission, build, result), camera, tools, races
- `src/sim/drone.ts` flight physics; `src/sim/spec.ts` DroneSpec, FEATURED drones, validateSpec
- `src/render/droneModels.ts`, `src/render/dsolarModels.ts` procedural drone models; `src/render/effects.ts` particles, hose
- `src/world/*` terrain, sky, solar park, facade, props (rings, turbine, freestyle park), colliders (SDF hash grid)
- `src/game/builder.ts` build mode pieces; `src/game/missions.ts` 8 training missions
- `src/net/multiplayer.ts` squad rooms; `src/ui/*` menus, HUD, squad UI, CSS
- `tools/` headless QA rigs (puppeteer-core + Edge): `shot.mjs`, `mptest.mjs`, `touchtest.mjs`
- `.claude/skills/drone-3d-from-drawings` how drone models are built from dimensions

## Team
- **Game Designer:** the game. Royale loop, progression, economy of upgrades, Spielwiese depth, onboarding, retention. Writes `studio/GDD.md`.
- **Gameplay and Engine Programmer(s):** build it. Royale mode, combat, bots, zone, upgrades, Spielwiese features, performance.
- **Server Consultant:** netcode for Royale on the current P2P stack, anti cheat, and the path to dedicated servers and millions of players. Writes `studio/NETCODE.md`, prototypes in `server/`.
- **Art and Animation:** look and feel. Upgrade tier drone models, ring and zone VFX, hit and elimination effects, Royale HUD look, animation and juice. Writes `studio/ART.md`.
- **Production and Leadership:** plan, scope, milestones, acceptance criteria, risks, go/no go. Writes `studio/PRODUCTION.md`.

## Definition of done for this cycle
A player opens drone-on-next, picks ROYALE, and within 10 seconds is in a match against bots (or friends via a room code), starts as the simplest drone, gets visibly and mechanically stronger during the match, fights, survives the zone, and either wins or is knocked out and sees a results screen that makes them want another round. In the SPIELWIESE they can train skills with measurable progress and build their own drone. Everything above works on desktop, phone and the RC7, with zero console errors, and passes a QA round.
