# DRONE ON Next: Art bible for ROYALE

Owner: Art and Animation. Version 1.0, 03.10.2026. Code lives in `src/art/**` (contract `src/art/contracts.ts` unchanged). Review route: `#artgallery` on a dev server (section 8).

## 1. Direction

The Royale look extends the game's thesis (DESIGN.md): **a ground station watching a real field**, not an esports arena. Everything Royale adds to the world must read as an instrument or as physics, never as a video game power up.

- **Light means information.** Light Green is live telemetry (Shine, PULSE, the Signal, evolve). Blue is energy coming in (Charge, EMP). Off White is structure and repair (Repair ring, hit flashes, damage arcs). Red appears only as low integrity and rear nav lights. Accent Green #26C257 stays the SPARK paint and the armed state; it never becomes an effect colour.
- **Thin lines, not neon tubes.** Rings are slim lit tubes with a gauge bezel of ticks; the Signal is scan lines on a transparent curtain; bolts are tracers. Glow is a halo around a line, never a blob.
- **Shape before colour.** Every gameplay object differs by shape as well as hue (colour blind safe): continuous ring, broken ring, plus glyph, sparkle; dot, pair, ring, star beacons.
- **The brand mark is the particle.** Celebrations (evolve, Shine taken, NOVA BURST) use the DroneShine four point sparkle as their star particle.
- **Physical first.** Water is white and breaks into droplets, smoke rises, sparks fall with gravity, a knocked out drone fizzles and powers down. PEGI 7: nothing burns, nothing bleeds.

## 2. Tier drones

Built to GDD 6.1 (`src/art/tiers.ts`). Origin at the arm plane, forward minus z, ground at minus legHeight. Feet sit where the sim puts its contact points (0.45 × arm length).

| | SPARK | BOLT | STORM | NOVA |
|---|---|---|---|---|
| Layout, arm, prop, legHeight | quadX, 0.16, 0.18, 0.06 m | quadX, 0.24, 0.254, 0.12 m | hexX, 0.34, 0.30, 0.18 m | coaxX8, 0.40, 0.33, 0.22 m |
| Span tip to tip | 0.50 m | 0.73 m | 0.98 m | 1.13 m |
| Paint / accent | #26C257 / #F7F7F2 | #8FC2F5 / #002518 | #004225 / #B5F78A | #F7F7F2 / #26C257 |
| Silhouette signature | flat true X, top pack with strap, swept whip antenna | blue capsule fuselage, white belly tank, forward lance | hex hull wearing a floating Light Green halo coil | white pebble shell, glowing core orb in a gimbal cage, stacked rotors, tall gear |
| Prop tips (blur ring) | Off White | Blue | Light Green | Accent Green |
| Beacon (60 m and beyond) | single dot, green | twin dots, Blue | ring, Light Green | sparkle, Off White |
| Water nozzle | none | lance tip (0, -0.05, -0.22) | lance tip (0, -0.06, -0.29) | lance tip (0, -0.08, -0.36) |

Rule for prop tips: the accent, unless the accent is too dark to read at distance (luminance under 0.25), then the paint.

**Materials.** One `tierBodyMaterial` per drone: a MeshStandardMaterial that reads colour, roughness, metalness, self light and thermal temperature per vertex (`aRMET`), so carbon, satin paint, metal motors, glass and the lit coil share one mesh and one draw call. Nav lights are self lit (Light Green front, warm red rear, heading at a glance). In the thermal view the body draws its own ironbow image from vertex temperatures: motors 0.97, packs 0.86, frame 0.68, water tank 0.30 (the tank reads cold), blades 0.5; blur discs go dark violet.

**Levels of detail** (THREE.LOD in the root; while a Royale art system runs, `src/art/crowd.ts` drives it):

| Level | Range | What | Draw calls |
|---|---|---|---|
| NEAR | under 80 m | body + lights + one merged blur disc for all rotors; blades spin until the rotor blurs | 3 in flight (+1 shadow inside 45 m), plus 1 per rotor only while idling |
| MID | 80 to 250 m | the model rebuilt at 40 % tessellation, rotors as lit tip rings, instanced across the match | 1 per tier and paint for all mid drones |
| FAR | beyond 250 m | arms, body, rotor rings, beacon and the tier signature, instanced | 1 per tier and paint for all far drones |

Geometry is built once per tier and paint and shared (flagged `userData.shared`; `disposeVisual` keeps it). Each drone owns only its materials and objects.

| Measured | SPARK | BOLT | STORM | NOVA |
|---|---|---|---|---|
| Triangles NEAR (incl. blades and discs) | 3,412 | 4,122 | 5,840 | 8,952 |
| Triangles MID | 1,062 | 1,330 | 1,860 | 2,574 |
| Triangles FAR | 308 | 368 | 524 | 580 |
| First build (both passes, cached for the page) | 29 ms | 51 ms | 64 ms | 46 ms |
| Every later build (evolve swap) | 0.2 ms | 0.2 ms | 0.4 ms | 0.1 ms |

`RoyaleArt` warms all four GDD paints when it is created; call `warmTierAssets(yourSpecs)` from `src/art` if gameplay's table differs.

## 3. VFX language

| Effect | Look | Colour | Timing | Built from |
|---|---|---|---|---|
| SHINE ring | slim lit tube, halo, 36 tick gauge bezel, a highlight sweeping round like a radar trace | Light Green | sweep 2.6 s, state change eases in 0.1 s | one mesh per ring (core, halo, glyph in one geometry) |
| BIG SHINE | small ring, spinning sparkle that blooms, "+3" above | Light Green | sparkle 0.9 rad/s | same, plus a sprite |
| CHARGE ring | ring broken into 12 cells like a battery gauge, lightning glyph | Blue | | same |
| REPAIR ring | continuous ring, plus glyph (never a red cross) | Off White | | same |
| taken | 15 % opacity, desaturated, no halo, no sweep | | 0.1 s ease | uniform |
| cooldown | thin outline at 40 % width; arc fills clockwise from 12 o'clock, glinting leading edge | ring colour | `remaining` 1 to 0 | uniform |
| highlight | beam of light 46 m straight up, pulses travelling up, ring pulse | ring colour | 0.6 s pulse | one beam mesh, created on demand |
| Shine cache | faceted Light Green core in two gyro rings, soft glow, bobbing | Light Green | bob 1.6 rad/s | 3 meshes and a sprite |
| Signal wall | curtain of scan lines rising from a bright ground line, 12 m ribs, sparse 15 fps static dashes, denser static on the outside | Light Green | lines rise 0.7 m/s, a band sweeps up every 15 s | one cylinder, terrain height baked per column |
| Signal ceiling | 4 m grid with static, only around the pilot, only within 10 m of the ceiling | Light Green | | one disc |
| PULSE bolt | tracer: hot narrow head, tail thins and fades, halo in the shooter's colour | core Light Green to white, halo owner colour | 1.6 to 2.3 m streak by tier | one instanced pool of 512 |
| Muzzle | small flash and two sparks | Light Green | 60 ms | particles |
| Impact | on a drone: white sparkle 90 ms, ring 160 ms, 11 sparks; on the world: flash, 6 sparks, dust puff | Off White and Light Green | 0.25 to 0.45 s | particles |
| Water jet | white stream with racing streaks, breaks into droplets toward its end, mist and splash | white, blue edges | shoots out in 0.14 s, detaches and flies on 0.22 s after release | one strip per stream (pool 16), particles |
| EMP charge | collapsing ring, crackling arcs, energy pulled in | Blue (NOVA: Light Green) | 0.35 s | billboard orb (pool 12), particles |
| EMP burst | shockwave shell (light on the rim, crackle near the edge, three faint latitude lines), lightning arcs, ground dust ring | Blue; NOVA adds an Off White inner shell and sparkles | 0.4 s, NOVA 0.5 s, ease out cubic | shells (pool 12), particles |
| Evolve | body glows Light Green, gather sparks, shell; burst at 0.3 s: star flash, two rings (Light Green and tier tint), sparkles, a short column of light | Light Green | 0.8 s total | shell, particles |
| Hit | white sparkle and sparks, scaled by damage | Off White | 90 ms flash | particles |
| Knockout | star flash, ring, sparks with gravity, blue fizzles while it falls, rising smoke, debris | Off White, Light Green, smoke #25292a | 1.2 s, smoke 2.2 s | particles |
| Boost | a ring blown off the back, a comet ribbon behind the drone | Light Green with a white core | kick 0.25 s, trail 0.35 s | ribbon (pool 24), particles |
| Ring taken | expanding ring, star flash, radial sparks; Shine adds sparkles, Charge electric ticks, Repair rising motes | ring colour | 0.35 s | particles |
| Tier beacons | small anti collision light above every tier drone, fades in beyond 20 m | per tier (section 2) | slow breathing | one Points draw for all drones |

**Screen overlays** (`ScreenFx`, DOM between the canvas and the HUD, `src/art/screen.ts`):

| Overlay | Look | Motion |
|---|---|---|
| Static vignette | chunky Light Green signal static and scan lines, dense at the edges; the clear centre closes as `staticAmount` rises | jitters at about 16 fps in steps |
| Damage arcs | 44 degree Off White arc on a ring at about 40 % of the short side, with a dark under stroke so it reads on sky and on the apron; width grows with damage | in 60 ms, out 700 ms, 6 reused |
| Evolve flash | soft Light Green wash with a stronger edge in the tier tint | in 60 ms, out 600 ms |
| Scrambled | static, three tear bands jumping, a slow roll bar, darkened edges | in 80 ms, out 220 ms |
| Low integrity | warm red inner edge glow and hairline | heartbeat every 1.1 s |

`prefers-reduced-motion`: jitter, tears and the heartbeat stop; every state stays readable.

## 4. Motion and juice rules

1. **Every hit has three beats:** flash (under 100 ms), debris (0.25 to 0.5 s), settle (smoke or dust, up to 2 s). Never one long effect.
2. **Fast in, slow out.** Flashes and screen overlays enter in 60 to 80 ms and leave over 200 to 700 ms with a strong ease out (`cubic-bezier(0.23, 1, 0.32, 1)`).
3. **Anticipation for big moves.** EMP and NOVA BURST charge 0.35 s (energy pulled in, ring closing) before the burst; evolve gathers for 0.3 s before it bursts.
4. **Things that happen often stay small.** PULSE muzzle and impact are tiny and short; the large moments are rare (evolve, knockout, NOVA BURST).
5. **Gravity and drag on everything physical.** Sparks fall, smoke rises and slows, water droplets arc.
6. **No camera shake from art.** The flight camera belongs to gameplay; screen effects are overlays only.
7. **Distance thins effects.** Beyond 120 m effects spend half their particles, beyond 250 m a quarter. Nobody can count sparks at 200 m.
8. **Persistent loops are slow:** ring sweep 2.6 s, beacon breathing 2 s, cache bob 4 s. Nothing blinks faster than 15 fps except muzzle flashes.

## 5. Sound (`src/art/sfx.ts`)

All synthesized on the game's AudioContext. Bus: gain 0.85, then a limiter (-3 dB, ratio 20, 2 ms attack), then the game's master and compressor. Calls before the first gesture do nothing.

| Call | Sound |
|---|---|
| `pulse` | short energy zap, two detuned falling tones and a tick, pitch drops with the tier |
| `hit(true)` / `hit(false)` | body thump and crunch / crisp hit marker tick |
| `water` | looping pressure hiss per owner, a pressure "pssh" on start |
| `emp` | 0.35 s rising whine, then boom, air wash and crackle (NOVA lower, plus a bright chord) |
| `evolve` | whoosh into a bell chord at 0.3 s, fuller per tier |
| `ring` | Shine: pentatonic chime rising with `laneStep`; Big Shine: sparkle arpeggio; Charge: electric rise; Repair: warm major third |
| `knockout` | motors spooling down, a pop, a last fizz |
| `signalWarning`, `countdown`, `victory` | ground station two tone; beeps and a GO; rising fanfare to a wide chord |
| `staticCrackle(amount)` | crackle loop whose level and brightness follow `amount` |

Mixing: voice caps (PULSE 6 local plus 10 remote, hits 6, EMP 4, knockouts 4, water loops 6), remote PULSE shots within 25 ms merge, each PULSE voice scaled by 1/√active, gain 1/(1 + (d/18)²), a low pass that closes with distance, silent beyond 140 m. **Measured worst case** (50 drones firing for 3 s, 12 water jets, NOVA bursts, knockouts and hits on top): peak 0.556 at the game master (-5.1 dBFS), no clipping.

## 6. Readability: 12 (or 50) drones at 60 m

Pixel math at 1080 p and the 62 degree field of view: 1 m at 60 m is about 15 px; SPARK is 7 px, NOVA 17 px. On a phone in landscape SPARK is 3 px. An outline alone cannot carry the tier at that size, so readability is layered:

1. **Size** (0.50 to 1.13 m span) and the **signature shape** (flat X, belly tank, halo, orb with stacked rotors) carry the tier inside about 40 m.
2. **Blur rings in the tip colour** (Off White, Blue, Light Green, Accent Green) and **nav lights** (Light Green front, red rear) carry tier and heading to about 80 m.
3. **Tier beacons** carry it at 60 m and beyond: dot, twin dots, ring, sparkle, 7 to 11 px, riding just above the airframe so they never hide it, fading in only beyond 20 m.
4. **Rings never shimmer:** the tube widens with distance so it stays at least 1.6 px wide; ring kinds differ by shape (continuous, cells, plus, sparkle).
5. **The Signal tells inside from outside:** clean scan lines inside, dense static outside, a ground line that blooms.
6. **Thermal keeps the hierarchy:** motors brightest, tanks darkest, bolts and sparks hot white, water and smoke cool.

The `60 M` gallery view shows four tiers at 60 m at the game's field of view (add `&zoom=4` to inspect).

## 7. Performance budgets

Mid range phone target 60 fps, floor 30 fps (BRIEF). Desktop target 60 fps with 50 drones.

| Item | Phone budget | Desktop budget | Measured |
|---|---|---|---|
| Tier drone NEAR | ≤ 9 k triangles, ≤ 4 draws | same | 3.4 k to 9.0 k, 3 draws flying (+1 shadow inside 45 m) |
| Tier drone MID / FAR | ≤ 3 k / ≤ 0.6 k triangles | same | 1.1 k to 2.6 k / 0.3 k to 0.6 k, instanced |
| All drones in a 12 drone match | ≤ 45 draws | ≤ 60 draws | about 36 near, 4 for the crowd |
| All drones in a 50 drone match | not a phone target | ≤ 120 draws | 20 to 26 near drones: about 110 to 125 draws including all effects |
| Rings | 1 draw each, visible ones only | same | 1 draw, about 1.7 k triangles each |
| Signal | 2 draws, overdraw ≤ 2 layers of transparent fullscreen | same | 1,024 triangle wall + ceiling disc |
| PULSE | 1 draw for all bolts, 120 live | 1 draw, 300 live | pool 512, no allocation per shot |
| Spark particles (additive) | ≤ 1,500 alive | ≤ 4,000 alive | pool 8,192, about 2,100 alive in the 50 drone test |
| Puff particles (alpha) | ≤ 300 alive | ≤ 800 alive | pool 2,048, about 450 alive |
| Water streams | ≤ 6 | ≤ 16 | pool 16 |
| Shells, charge orbs, trails | ≤ 4, 4, 8 | 12, 12, 24 | fixed pools, no allocation in a fight |
| Beacons | 1 draw | 1 draw | 96 capacity |
| Art CPU per frame | ≤ 1 ms | ≤ 1 ms | 0.1 to 0.4 ms (12 to 50 drones) |
| Screen overlays | opacity and transform only | | compositor layers, one noise canvas |

Measured on this machine (headless Edge, ANGLE D3D11, 1440 × 900, the art bench renders 20 frames back to back with and without the art and keeps the best of five):

| Scene | Draw calls (whole frame) | Art cost per frame | fps in the live loop |
|---|---|---|---|
| world only, same camera | 76 | | 60 |
| 12 drones (9 near), 110 bolts, 900 sparks | 132 to 138 | 1.2 ms | 60 |
| 50 drones (20 to 26 near, rest instanced), 270 to 285 bolts, 2,100 sparks, jets, trails | 188 to 203 | 2.1 to 3.6 ms | 60 (40 while other sessions loaded the GPU) |

Before the crowd layer the same 50 drone scene cost 5.6 ms of art and 210 to 284 draws. Real phones are not measured here; the phone column is the budget gameplay and QA must hold on a device.

## 8. Gallery and QA tools

- `#artgallery` (dev server only; `src/art/register.ts` imports it lazily, a production build never contains it). Views: TIERS, HOVER, 60 M, RINGS, EFFECTS (cells: `&cell=pulse|water|hit|ko|evolve|boost|rings`), EMP (`&cell=storm|nova`), SIGNAL IN, SIGNAL OUT, CEILING, SCREEN (`&fx=static|low|dmg|scramble|flash`), 12 DRONES, 50 DRONES, CLOSE UP (`&tier=`), EMPTY. Light: `&time=day|golden`, `&thermal=1`. `&at=<s>` freezes effects at that moment of their 2.4 s cycle, `&zoom=4` narrows the lens, `&hud=0` hides the panel. The panel's SOUND CHECK row plays every sfx, including 50 FIRING.
- `node tools/artgallery.mjs http://localhost:5303/ <outDir> tiers:day stress50:golden "rings:golden:thermal" --bench 1` shoots views and prints fps, draw calls, LOD counts, live pools and the art bench.
- In the page: `__artBench()`, `__artDisposeTest()` (creates a RoyaleArt, exercises every call, disposes; geometries, textures, programs, scene children and overlays return to their baseline), `__sfxPeak()` (the worst case mix, peak level).

## 9. Notes for gameplay (how to call the contract)

- **Call `art.update(dt, camera)` once per frame before rendering.** It runs the shared clock, picks every tier drone's LOD, fills the crowd and beacons, and animates rings. Call `signal.update` and `cache.update` as the contract says (the Signal also runs on the shared clock).
- **Rings:** add `ring.object` to the scene yourself and orient it (ring plane local XY, axis local Z). `setState('cooldown', remaining)`: `remaining` is the fraction of the last 5 s still to go (1 = 5 s left, 0 = respawn); outside the last 5 s pass `1` or omit it for a plain thin outline.
- **Bolts:** `bolt()` then `moveBolt()` every frame; the streak length comes from the tier and the distance flown, so sub stepping is fine. `ownerColor` is any CSS colour (the pilot's paint); it becomes the halo. 512 slots, the oldest is recycled if a match ever exceeds it.
- **Water:** call `waterJet(owner, from, dir, range, true)` every frame while spraying; pass the actual hit distance as `range` when the stream hits something. A stream not refreshed for 0.2 s detaches by itself. Use `visual.nozzles[0]` (body frame) for `from` and `dir`.
- **EMP:** call `emp(pos, r, nova, 'charge')` at wind up; calling it again each frame with the drone's position moves the charge with the drone. Then `'burst'` at release.
- **Evolve:** call `evolve(root)` with a root that stays in the scene through the swap (the drone's own group, or a parent you swap the model under). The glow follows any tier model found under that root at each frame; burst at 0.3 s is the right moment to swap.
- **Boost:** `boost(root, true)` at start, `false` at end.
- **ScreenFx:** `damageFrom(angle)` uses screen radians, 0 = up, clockwise. `staticAmount` is cheap to call every frame (it ignores changes under 1 %).
- **Sfx:** `emp()` contains its own 0.35 s wind up: call it at charge start. `water()` every frame while on, with the current distance. `staticCrackle(amount)` every frame.
- **Shader warm up:** the first tier drone and the first effects compile shaders. At match load, put the tier drones in the scene for one `renderer.compileAsync` (the game's `warmup()` does this for the menu scene).
- **Shared file touched:** `src/render/droneModels.ts` `disposeVisual` keeps geometry flagged `userData.shared` (one line, commented). Nothing else outside `src/art` changed.

## 10. Contract notes (no change made)

The current contract is implemented as is. Proposals for the production lead, none blocking:

1. `RoyaleSfx.emp(nova, distance)` has no phase, so the sound assumes it is called at charge start and times its own burst. Adding `phase` would keep sound and picture locked if gameplay ever changes the 0.35 s charge.
2. Sounds receive only a distance. A world position (or a pan value) would allow stereo placement of enemy fire, which helps pilots find a shooter.
3. `RingVisual.setState('cooldown', remaining)` would be clearer as seconds left; today the meaning is documented above.

## 11. Review checklist

Before any art change ships:

- [ ] `npx tsc --noEmit -p .` is clean; `tools/artgallery.mjs` prints "console clean".
- [ ] TIERS, HOVER, 60 M, RINGS, EFFECTS cells, EMP, SIGNAL IN, SIGNAL OUT, CEILING, SCREEN shot in day, golden and thermal, and looked at.
- [ ] Each tier is identifiable at 60 m in the `60 M` view (shape near, beacon far); beacons do not hide the airframe.
- [ ] Ring kinds differ by shape, not only colour; taken is 15 %, cooldown arc fills clockwise from 12 o'clock.
- [ ] Signal: 0.6 near, 0.15 far, ground line blooms, inside and outside read differently, no moire at 300 m.
- [ ] No effect lasts longer than its row in section 3; flashes under 100 ms; evolve 0.8 s.
- [ ] Colours from the brand palette only, each with its meaning (section 1); no red outside low integrity and rear lights.
- [ ] Visible copy has no dashes; ranges use "to" or "bis".
- [ ] 50 DRONES view: 60 fps desktop, draw calls and art cost inside section 7; no allocation in pools (`__art` counts stay at pool sizes).
- [ ] `__artDisposeTest()` returns to baseline; `__sfxPeak()` stays under 0 dBFS.
- [ ] Existing Spielwiese visuals unchanged (menu and free flight screenshots match).
