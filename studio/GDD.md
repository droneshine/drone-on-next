# DRONE ON Next: Game Design Document

Version 1.0, 03.10.2026. Owner: Game Designer. Build from this; anything not answered here goes to the production lead, not back into design debate.

**Conventions.** Player facing strings are written in "QUOTES" and obey the brand copy rule (no dashes of any kind). Every tunable number lives in section 6, which is the only place to change it; sections 2 to 4 explain the rules. World coordinates are metres: x east, z south (north is minus z), y up, as in `src/world`. Headings are compass degrees: 0 north (minus z), 90 east (plus x). "AGL" means above the terrain under that point.

---

## 1. Pitch and pillars

**Pitch.** DRONE ON is the drone battle royale you can play in a browser tab in ten seconds. Twelve pilots launch the smallest, simplest drone there is. They race through glowing rings to collect Shine, and every few rings the drone evolves in mid air: bigger, stronger, a new tool. Fights are pure drone physics: energy pulses, water jets that wash lighter drones out of the sky, EMP blasts that scramble a flight controller, and ramming where mass decides. The Signal shrinks, the Static eats the edges, and the last drone flying wins. Between matches the SPIELWIESE is where pilots get measurably better: rated drills, ghosts of their best runs, a daily challenge and a workshop where they build a drone from real parts. It runs on phones, desktops, gamepads and real RC transmitters, because it is a real flight model underneath.

**Pillars** (every feature must serve at least one; if two conflict, the higher one wins)

| # | Pillar | What it means in practice |
|---|---|---|
| 1 | **It flies like a real drone** | One flight model for everything (`src/sim/drone.ts`). Assists bend shots and hold altitude, they never fake physics. Speed costs battery, mass wins rams, wind is real. |
| 2 | **Ten seconds to fun** | No account, no download, bots fill every seat, solo starts offline. Menu to GO in under 10 s, Play again to GO in under 8 s. |
| 3 | **Grow in the air** | You start small every match and visibly evolve within the first minute. Across sessions, levels, medals and skill bars always move. |
| 4 | **Skill shows** | Floor is low (GPS mode, aim assist, auto fire on touch). Ceiling is real FPV (Angle and Acro are faster, drain harder, reward lines). Every skill has a number you can beat. |

**Target players**

1. Primary: 10 to 25 year old action gamers on phone and PC browser who play short competitive sessions (battle royale, arena, .io games). They need instant matches and a clear power curve.
2. Secondary: FPV and drone hobbyists, including RC owners. They want the real flight model, Acro, and to use their own transmitter. They create clips and courses.
3. Tertiary: DroneShine's world (trade fair booths, schools, recruiting). The game shows real DroneShine machines and real jobs in the Academy.

**Why this can break out (the hooks)**

1. **A genre nobody owns.** There is no good drone battle royale; "drone battle royale" is a pitch in three words.
2. **Evolution in mid air.** Spark to Nova in one match is a power fantasy felt in the first 40 seconds and readable to spectators.
3. **Physics moments are clips.** Washing a smaller drone into the lake, threading the Crane Drop with the Static behind you, a ram that sends a Spark tumbling: unscripted, because the physics is real.
4. **Zero friction, short matches.** A link opens a six minute match, bots fill, room codes bring friends, it runs on a phone and on a real RC.
5. **Skill ceiling borrowed from a real sport.** FPV pilots will show off in Acro; that content pulls in everyone else.

Tone is all ages (PEGI 7 target): drones are "knocked out", never killed. No blood, no people, no real weapons. Copy never says "kill".

---

## 2. ROYALE (MVP this cycle)

### 2.1 Core loop

Collect Shine (rings) → Evolve (Spark, Bolt, Storm, Nova) → Fight (Pulse, Water Jet, EMP, ram) → Survive the Signal (shrinking zone, falling ceiling) → Last drone flying → Results (placement, XP, unlocks) → Play again.

Three resources run the match: **Integrity** (health), **Battery** (the sim's real state of charge: flying fast, boosting, firing and EMP all drain it) and **Shine** (evolution progress). Water joins at Bolt.

### 2.2 Match flow (solo, offline)

| Step | Time | What happens |
|---|---|---|
| Menu | | Player taps "ROYALE" on the rail, then "PLAY" (one tap after the first visit: the sheet remembers). |
| Load | ≤ 3 s | Seed generated. Arena state, 11 bots, Signal plan built. No network call. |
| Launch intro | 5 s | Camera starts 300 m above the arena showing the Signal circle and ring clusters (2 s), swoops to the player's chase camera (1 s). Countdown "3", "2", "1", "GO". Drones already hover at their launch slots. |
| GO | 0:00 | Controls live. Phase timeline in 2.7 starts. |
| Live | 0:00 to max 6:05 | Collect, evolve, fight, rotate. |
| Knockout | | Integrity 0 → drone powers down and falls (existing crash path). KO card after 2 s (2.11). |
| End | | When one drone is left: "VICTORY" for the winner; everyone else already saw their KO card. Results screen. |
| Results | | XP, unlocks, "PLAY AGAIN" starts a fresh solo match (new seed) straight into the Launch intro. |

Target median match length 5:00 to 6:00; hard cap is the Signal collapse (about 6:05, section 6.7). Player count 12 (humans plus bots). Solo is always 1 human plus 11 bots.

**Launch.** 12 airborne slots on a circle around the arena centre (6.12). In Rookie Royale (first 3 matches) the human gets the slot closest to a Shine lane start and the lane is marked. Each drone spawns armed, in GPS hold, motors at hover (`s = sqrt(hover thrust per motor / maxThrust)`). During the intro, sticks are locked to throttle 0.5 and zero elsewhere (not throttle 0: `raceLocked` today sends throttle 0, which in GPS means descend). At GO the pilot's chosen mode applies; an RC throttle sitting low in Angle or Acro shows "THROTTLE TO MIDDLE" during the countdown.

### 2.3 Arena

The arena is the existing world, centred at **C0 = (−60, −60)** with start radius **R0 = 420 m**. Why: that circle holds every point of interest the world already has, keeps the edge hills (which start rising at |x| or |z| > 440) mostly outside, and puts the lake on the rim as a natural hazard. Distances from C0: Freestyle Park 152 m, Solar Field 125 m, Base 85 m, Office Block 240 m, Turbine 348 m, lake centre 374 m.

| POI (callout name) | Where | Royale role |
|---|---|---|
| "BASE" | (0, 0): apron, pads, container, van, masts | Safe early lane, Charge and Repair, water refill on the pads |
| "SOLAR FIELD" | (0, −170), 12 rows z −225 to −115, x ±58 | Solar perch charging (2.8), low risky lanes between rows |
| "OFFICE" | facade block x 159 to 177, z −2 to 42, roof 23 m | Vertical lane up the facade, roof lane, rooftop Big Shine |
| "FREESTYLE PARK" | (−200, 0): bando, crane, containers, 12 rings | Grand Loop (existing 12 rings), Crane Drop, bando Big Shine. Densest cover. |
| "TURBINE" | tower (−330, −280), hub y 96, blades turning | Tower Spiral lane; blades are an instant knockout |
| "LAKE" | (40, 300), r 120 | Splashdown is an instant knockout; skimming low refills water |
| Open ground and forest | everywhere else | Generated lanes, trees block shots (cover) |

**Must be added for Royale** (Royale only objects, removed on exit like mission objects): the ring sets of 6.6 including a new small ring size (R 1.4) for Big Shine; the Signal wall, ceiling and Static screen effect (2.7); Shine cache orbs; launch slots (computed, no meshes). Placement rule for every ring: if its centre has less than 1.5 m clearance from any collider or terrain, raise it in 0.5 m steps until clear.

### 2.4 Evolution: Shine and tiers

Everyone launches as **SPARK**, the simplest drone: a small 7 inch class quad. Shine evolves it.

| Tier | Shine needed (total) | Unlocks | Feel |
|---|---|---|---|
| "SPARK" | 0 | PULSE, BOOST | Light, twitchy, fragile. Out turns everything. |
| "BOLT" | 5 | WATER JET | Quicker, tougher, carries a small tank. |
| "STORM" | 15 | EMP | Hexacopter. Heavier, wins most rams against smaller drones. |
| "NOVA" | 30 | NOVA BURST (bigger EMP) | Coaxial X8. Biggest, toughest, slowest turning, biggest target. |

**Evolve moment** (0.8 s): drone glows Light Green, burst VFX, model swap, banner "BOLT" plus the new control ("NEW: WATER JET  Q"). Effects: integrity becomes min(new max, current + 40 % of new max); 1.0 s invulnerable; battery set to at least 60 %; tank to at least 50 % (Bolt and up). In solo, time scale dips to 0.6 for 0.3 s on the human's own evolve only.

**Hot swap rule (engine).** Evolution replaces the DroneSim with one built from the next tier spec and copies pos, vel, quat, w, mode and soc; sets armed = true; sets each motor's `s` to the new hover value so there is no dip. The fresh sim starts with position and altitude hold off and recaptures them by itself when the sticks centre. Acceptance: no altitude change above 1 m and no crash while evolving at 15 m/s in all three modes.

**After Nova**, every further Shine heals 4 integrity ("OVERCHARGE"), so rings stay worth flying.

Tier DroneSpecs are in **6.1** (canonical). Derived sanity numbers from the sim formulas, so programmers know what to expect:

| | Spark | Bolt | Storm | Nova |
|---|---|---|---|---|
| Span prop tip to prop tip | 0.50 m | 0.73 m | 0.98 m | 1.13 m |
| Thrust to weight, empty / full tank | 3.0 | 2.9 / 2.3 | 3.1 / 2.5 | 3.0 / 2.5 |
| Hover time, empty / full tank | 9 min | 10 / 7 min | 13 / 10 min | 12 / 9 min |
| GPS top speed / with BOOST | 12 / ~19 m/s | 14 / ~22 | 16 / ~25 | 18 / ~25 |
| Acro top speed, full throttle | ~31 m/s | ~33 | ~35 | ~37 |
| Full throttle endurance | ~2.3 min | ~2.5 min | ~3 min | ~3 min |

Acro is twice as fast as GPS and empties the pack in under three minutes: that is the balance, and it comes from the physics, not from a rule.

### 2.5 Rings and pickups

| Pickup | Look | Effect | Shared? | Respawn |
|---|---|---|---|---|
| "SHINE RING" | Light Green ring, R 2.6 | +1 Shine | **Personal**: each pilot can take each ring once; taken rings dim to 15 % for that pilot only | never |
| Lane bonus | | +2 Shine for all 5 rings of a lane in order within 15 s; Grand Loop +4 for all 12 in order within 60 s | personal | |
| "BIG SHINE" | small ring R 1.4, Light Green, sparkle, "+3" | +3 Shine | shared, first through takes it | 40 s |
| "CHARGE RING" | Blue #8FC2F5 ring, R 2.6 | +30 % battery, +0.3 L water | shared | 25 s |
| "REPAIR RING" | Off White ring, R 2.6, plus icon (not a red cross) | +35 integrity | shared | 30 s |
| "SHINE CACHE" | Light Green orb, 1 m, slow spin | dropped where a drone is knocked out: max(2, floor(victim Shine × 0.5)); fly within 2.5 m | shared | despawns after 30 s |

Why personal Shine rings: every pilot can evolve by flying well, which is the seed idea and keeps beginners progressing; conflict comes from shared Big Shine, Charge and Repair, from the Signal deleting whole lanes, and from fights at POIs.

Pass detection: plane crossing inside 0.95 × R (the existing `RingTracker` test), checked for every ring within 40 m of a drone, in any order. Lanes add an in order check for the bonus. A respawning shared ring shows a thin outline and a countdown arc for its last 5 s.

Ring budget per pilot: 11 lanes × 5 + Grand Loop 12 = 67 personal Shine plus bonuses, 8 Big Shine (24, contested). Expected pacing for an average human: Bolt at 0:30 to 0:45, Storm around 2:00, Nova around 3:30 if alive.

### 2.6 Combat

**Weapons and abilities** (numbers in 6.2, 6.3)

| Control | Name | Tier | What it does |
|---|---|---|---|
| Fire | "PULSE" | all | Light Green energy bolt, projectile (no gravity), fired from the nose toward the crosshair point. Damage, rate, speed and range grow per tier. Each shot costs 0.18 % battery. Disabled below 3 % battery. |
| Boost | "BOOST" | all | 2.0 s: GPS and Angle speed limit × 1.6, max tilt +15°, climb × 1.5, thrust × 1.15 (Acro: thrust × 1.25). Costs 3 % battery, 7 s cooldown. FOV kick +8°, speed lines. |
| Water | "WATER JET" | Bolt+ | Hold to spray a 22 m stream from the tank. Each 0.1 s on a target: 2 damage and a push force along the stream (12 / 18 / 26 N by tier) for 0.1 s. Uses 0.15 L/s. The tank is real payload (1 kg per litre) on `sim.payload`. |
| Special | "EMP" (Storm), "NOVA BURST" (Nova) | Storm+ | 0.35 s visible charge, then a radial pulse: damage plus SCRAMBLE to every enemy in radius with line of sight from the centre. Costs 5 % battery. |

**Water pushes anything smaller than you.** The push is applied by the target's own sim through `extraForce`. A GPS flight controller already subtracts `extraForce` and fights back up to its tilt limit, so the physics produces the rule by itself: a Nova in GPS shrugs off any jet, a Spark gets washed away. Pushing a drone into the lake, the Static, a wall or the turbine is the signature play.

**SCRAMBLE** (EMP): for the duration the victim's stick input is replaced by neutral sticks with throttle at hover; in Acro the controller switches to Angle for the duration so the drone self levels. Weapons and abilities of the victim are disabled. Victim HUD: static overlay plus "SCRAMBLED". A drone cannot be scrambled again within 3 s after a scramble ends.

**Aim and assist.** The crosshair is the screen centre ray from the camera. Shots leave the nose toward the first thing that ray hits (or the point at max range). Assist rules:

1. Assist bends shots, never the drone. The flight controller never receives assist input.
2. Inside the assist cone (6.9, by flight mode and device) the shot direction snaps to the predicted intercept point of the best target (smallest angle, then nearest), using the target's velocity and the projectile speed.
3. Vertical help: if a target is within 12° of the crosshair horizontally, vertical aim corrects up to ±40°. Players mostly aim by yawing, like a real drone.
4. Line of sight required; terrain, buildings, panels and trees block shots (forest is cover).
5. **Auto fire** (default on for touch and RC, optional elsewhere): fires when a target is inside the cone, in range and in line of sight, after 0.15 s of lock.
6. Bots never get assist; they have their own aim error (2.10).

**Rams and impacts.** In Royale no impact causes an instant crash while integrity is above 0.

- Drone to drone: the existing momentum share (`dv = closing speed × 1.2 × theirMass / (theirMass + myMass)`) is applied as today, and each drone takes **5 × its own dv** damage (cap 150). Below 3 m/s closing speed: push only. So a Nova ramming a Spark at 15 m/s deals about 72 and takes about 17. Contacts with another drone never use the wall formula.
- Drone to world: damage = 6 × (impact speed − 4 m/s), for ground, hard, glass and panel surfaces; trees (soft) use threshold 5 and half damage. Prop strikes use the same formula instead of crashing.
- Instant knockout, no damage roll: water contact ("Splashdown") and turbine blade contact ("Blade strike"). These stay iconic and readable.

**Knockout.** Integrity 0 → `sim.crash('Knocked out')`, existing crash FX (props fly) plus Art's power down VFX. Kill credit goes to the last enemy who damaged you within 10 s, including when you finish yourself on a wall, the water or in the Static. Knocker gets +3 Shine and +20 integrity ("SALVAGE"); the victim drops a Shine cache.

Kill feed copy (no dashes; {A} knocker, {B} victim):

| Cause | With credit | Without credit |
|---|---|---|
| Pulse | "{A} knocked out {B}" | |
| Water into lake | "{A} washed {B} into the lake" | "{B} took a swim" |
| EMP or Nova Burst | "{A} scrambled {B} out of the sky" | |
| Ram | "{A} rammed {B}" | |
| Wall or ground | "{A} knocked {B} into the ground" | "{B} hit the ground too hard" |
| Static | "{A} pushed {B} into the Static" | "{B} lost the Signal" |
| Turbine | "{A} sent {B} into the turbine" | "{B} met the turbine" |

**Eliminated pilots.** 2 s slow orbit of the falling drone, then the KO card: "KNOCKED OUT", "by {A}", "#7 OF 12", buttons "SPECTATE", "PLAY AGAIN", "RESULTS". Spectate follows the knocker in chase camera; left and right (keys, D pad, swipe) cycle through living drones. No respawn in normal Royale (Rookie reboot is P1, 2.15).

### 2.7 The Signal

The safe area is **the Signal**, a vertical cylinder with a ceiling. Outside it, and above the ceiling, is **the Static**: integrity drains every 0.5 s by the phase's damage per second.

Schedule (times from GO; full table 6.7):

| Phase | Signal holds | Signal shrinks | Radius | Static per s | Ceiling (world y) |
|---|---|---|---|---|---|
| 1 | 0:00 to 1:00 | 1:00 to 1:40 | 420 → 260 | 2 | 120 |
| 2 | 1:40 to 2:20 | 2:20 to 2:55 | 260 → 150 | 4 | 100 |
| 3 | 2:55 to 3:30 | 3:30 to 4:00 | 150 → 80 | 7 | 80 |
| 4 | 4:00 to 4:30 | 4:30 to 4:55 | 80 → 35 | 11 | 60 |
| 5 | 4:55 to 5:15 | 5:15 to 5:45 | 35 → 0 | 16 | 45 |
| Overtime | from 5:45 | | 0 | 25 | 45 |

- Next circle: centre picked by the seed so it lies fully inside the current one (distance ≤ R_now − R_next), biased toward POIs (pick a POI within reach, add a random offset of up to 40 m). The final two centres are never over water (terrain height at the centre must be above WATER_Y + 1).
- The next circle is shown on the map at the start of each hold (phase 1: at 0:20). While shrinking, radius and centre move linearly to the next circle. The ceiling changes at the start of each shrink, over 10 s.
- Visuals: a translucent wall of Light Green scan lines and noise on the cylinder, opacity 0.15 far away, 0.6 within 30 m; a bright line where the wall meets the ground; a horizontal static sheet fading in within 10 m of the ceiling. Outside: screen edge static, crackle audio, HUD "IN THE STATIC  7 PER S" and an arrow to the Signal. Minimap: current circle solid Light Green, next circle dashed Off White.
- HUD timer copy: "SIGNAL CLOSES IN 0:42", "SIGNAL MOVING 0:18", "FINAL SIGNAL".

Density: 12 drones in 554,000 m² at start (one per 215 m square); launch slots are about 140 m apart, so first contact happens inside 30 to 60 s at POIs.

### 2.8 Battery, water and solar

- **Battery** is the sim's `soc`. Flight drains it naturally; PULSE, BOOST and EMP subtract their costs directly. Low battery sags voltage, so thrust falls: a hungry drone is a slow drone.
- At 20 % the HUD warns "BATTERY 20 %. FIND A CHARGE RING". In GPS the sim auto lands below 5 %; in Royale this is not death: a landed drone recharges **1 % per s** on any ground and **4 % per s** when landed on a solar table ("CHARGING ON SOLAR"). Detection: on ground and a downward raycast within 1.5 m hits a collider tagged `solar`. Perching on the Solar Field is a deliberate risk and reward play.
- **Water** (Bolt and up): tank 0.5 / 0.7 / 0.9 L. Refill: skim the lake (inside the lake ellipse and less than 4.5 m above WATER_Y: +0.25 L/s, HUD "REFILLING"), hover or land within 4 m of a Base pad (+0.2 L/s), Charge ring +0.3 L. Empty tank: "TANK EMPTY. SKIM THE LAKE".

### 2.9 Controls

Default flight mode in Royale: **GPS** for everyone. Pros switch to Angle or Acro any time (mode key). Assists per mode in 6.9.

| Action | Keyboard "CLASSIC" | Keyboard and mouse "SHOOTER" (desktop default) | Gamepad (mode 2) | Touch | RC7 (UniRC 7 Pro) |
|---|---|---|---|---|---|
| Throttle / climb | W S | Space up, Left Ctrl down | Left stick Y | Left stick Y | Throttle stick |
| Yaw | A D | Mouse X (sets target heading) | Left stick X | Left stick X | Yaw stick |
| Pitch / roll | Arrows (or I J K L) | W S / A D | Right stick | Right stick | Right stick |
| Fire PULSE | Space | Left mouse | RT | Auto fire, plus "FIRE" button | Auto fire, plus aux channel (default the axis the live game uses for spray, axis 5) |
| BOOST | Left Shift | Left Shift | RB | "BOOST" button above left stick | Screen button at left edge |
| WATER JET | Q | Right mouse | LT | "WATER" button | Screen button at right edge |
| Special | E | E | LB | "EMP" button | Screen button at right edge |
| Aim pitch | R up, F down | Mouse Y | D pad up and down | Vertical assist only | Vertical assist only |
| Camera chase / FPV | C | V | Y | Camera button | Camera button |
| Flight mode | M | M | Back | Mode button | Mode button |
| Big map | Tab | Tab | D pad left (hold) | Tap minimap | Tap minimap |
| Pause | Esc | Esc | Start | Pause button | Pause button |

- SHOOTER scheme: mouse X accumulates a target heading; the yaw stick is driven by heading error × 4, clamped to ±1, so a 30° flick turns the drone 30° as fast as its yaw rate allows (drone feel kept). Available in GPS and Angle; Acro on keyboard uses CLASSIC. Pointer lock on first click.
- Gamepad: trigger throttle is disabled in Royale (triggers are weapons). Shoulder buttons only for combat, so thumbs never leave the sticks.
- Touch: buttons sit in an arc above the right stick (FIRE biggest, 72 px; WATER and EMP 60 px) and BOOST above the left stick. Buttons appear only once their tier unlocks them. Portrait works (sticks bottom, buttons above), landscape is suggested once: "TURN YOUR PHONE FOR A WIDER VIEW".
- RC7: physical sticks fly; the 960 × 600 screen shows 72 px buttons hugging the bottom left and right edges, reachable with a thumb tip. Auto fire on by default. Aux channel binding in Settings is P1.
- Royale replaces Spielwiese bindings for R (reset), H (thermal), F (tag) and Q E (gimbal); Spielwiese is unchanged.

### 2.10 Bots

Bots are real drones: each bot is a `DroneSim` with a tier spec, stepped at **100 Hz** (50 Hz when farther than 250 m from the camera), driven by a brain that outputs `Sticks` exactly like a player. In rooms, the host runs all bots.

**Brain**: decisions at 10 Hz, steering at 30 Hz. States:

| State | Enter when | Behaviour |
|---|---|---|
| LAUNCH | GO | Hold, then climb or descend to cruise AGL 12 to 25 m. |
| COLLECT | default | Score reachable rings by value / distance (Big Shine 3, lane 1.5 per ring, single 1), skip rings outside the next Signal. Approach 12 m before the ring along its normal, fly through. Follow lanes in order. |
| RESUPPLY | battery < 30 % or integrity < 40 % | Nearest Charge or Repair ring; if battery < 10 %, land on the Solar Field if within 150 m. |
| ENGAGE | enemy within detect range with line of sight | Yaw to aim with lead plus aim error; orbit strafe with roll at 0.6 × weapon range; fire in bursts; use specials (rules below). |
| EVADE | integrity below retreat threshold, or two or more enemies engaging it | Break line of sight (fly behind nearest building, container or treeline), BOOST away, descend toward cover. |
| ROTATE | outside the next Signal and time to shrink start < travel time + 10 s | Fly straight to a safe point 0.7 × R_next from the next centre; fight only if blocked. |
| FINISH | target integrity < 30 % (Pilot, Ace) | Chase aggressively, ram if heavier. |

Obstacle avoidance: three forward raycasts (centre, ±20°) of length speed × 1.5 + 6 m at 10 Hz; climb if blocked; keep AGL ≥ 6 m except when flying a low ring. Never fly within 60 m of the turbine hub; never below 6 m over the lake unless the bot is Ace and refilling.

Special use: WATER JET when target within 18 m and lighter, or when target is between bot and lake or Static (Pilot, Ace). EMP when 2+ enemies in radius, or 1 enemy in radius below 50 % integrity (Ace), or any enemy in radius (Pilot, 50 % chance).

**Difficulty** (numbers in 6.11): Rookie, Pilot, Ace differ in reaction time, aim error, detect range, flight mode, ring efficiency, ability use and a damage multiplier.

**Fairness rules for a beginner** (all must hold in Rookie mix):

1. In a Rookie mix every bot (Pilot bots included) holds fire for the first 30 s; at most 2 bots may engage the same human at once; Rookie bots pick a bot target over the human 70 % of the time when both are in range.
2. The human's first match spawns next to a lane; a lone Rookie bot with 60 integrity is routed past the human around 0:40 for a first knockout.
3. When the human is in the last 3, bots weight bot targets 1.5 × so the finale is a brawl, not a pile on.
4. Bots fight each other everywhere, so the alive count drops steadily. Target curve in solo: 8 flying at 2:00, 5 at 3:30, 2 to 3 at 4:30.

Bot names (pilot list, shuffled per seed): "Pixel", "Zephyr", "Nimbus", "Kestrel", "Gizmo", "Turbo Tilda", "Captain Hover", "Rotor Rosa", "Sky Juno", "Wobble", "Ace Ingrid", "Moth", "Comet", "Breeze", "Tango", "Scout". Results and the big map show a small bot icon next to bots; the HUD does not.

### 2.11 HUD and screens

Visual language follows `DESIGN.md` (ground station, hairlines, Nasalization numbers, Inter text, no boxes in boxes). Layout at desktop; phones and RC7 scale the same anchors.

| Anchor | Element |
|---|---|
| Top centre | Heading tape (existing) with markers for Signal centre, marked lane, nearest Charge and Repair. Below it: "11 FLYING", "2 KO", Signal timer. |
| Top left | Kill feed, 4 lines, 5 s each, own events in Light Green. |
| Top right | Minimap, 150 px desktop, 110 px phone, north up, 250 m radius: you (arrow), current and next Signal, lanes with remaining personal rings (dot), Big Shine (sparkle), Charge (blue), Repair (white), Shine caches; enemies only within 120 m who fired in the last 2 s (pulse dot). Tap or Tab for the full arena map with POI names. |
| Bottom left | Integrity bar (number + bar; pulses below 30 %), battery bar (Blue, %), tank bar (Bolt+). Small ALT and KM/H telemetry stays: this is still a drone. |
| Bottom centre | Tier name and segmented Shine bar: "BOLT  12 / 15", after Nova "NOVA  OVERCHARGE". |
| Bottom right (desktop, pad) | BOOST, WATER, special icons with cooldown sweep and key hint; locked ones hidden. On touch the buttons are the indicators. |
| Centre | Crosshair; lock ring when a target is in the assist cone; hit marker (80 ms); floating damage numbers; enemy plates within 60 m with line of sight: name, tier icon, integrity bar. |
| Screen edge | Damage direction arcs (Off White); Static vignette when outside; Light Green flash on evolve. |

**Screens:** Royale sheet ("PLAY" big, "PLAY WITH FRIENDS", difficulty chips "AUTO", "ROOKIE", "PILOT", "ACE", a one line controls hint for the detected device). Launch intro. KO card (2.6). Spectate bar ("SPECTATING MILA", arrows, "PLAY AGAIN"). Victory: camera orbits the winner doing its victory flourish, "VICTORY", "LAST DRONE FLYING".

**Results screen** (one screen, Play again focused):

1. Placement huge in Nasalization: "#1" or "#4 OF 12".
2. Stat row: "KNOCKOUTS 2", "DAMAGE 412", "SHINE 23", "TOP TIER STORM", "TIME 4:12".
3. XP lines animating into the level bar (6.13), level up flash, unlocks: "UNLOCKED: BLUE LEDS".
4. One near miss line, the first that applies: "3 SHINE FROM NOVA", "YOUR BEST PLACEMENT SO FAR", "120 XP TO LEVEL 6", "KNOCKED OUT 14 S BEFORE THE FINAL SIGNAL".
5. Buttons: "PLAY AGAIN" (primary, Enter, A, big on touch), "SPIELWIESE", "SHARE" (copies "I placed #2 in DRONE ON Royale with 3 knockouts" plus the game link).

### 2.12 Scoring, XP and Pilot Rating

Placement is the score. XP per match (6.13): participation, placement, knockouts, damage, Shine, highest tier, survival time. A typical mid table match gives about 350 XP; a win with 5 knockouts about 1,000.

Hidden **Pilot Rating** (starts 1000) picks the solo bot mix: below 900 or first 3 matches Rookie mix, 900 to 1200 Normal, 1200 to 1500 Hard, above 1500 Ace. The player can override with the difficulty chips; "AUTO" is default.

### 2.13 Royale with friends (rooms)

Uses the existing squad rooms (`src/net/multiplayer.ts`). In a room the host sees "START ROYALE"; every pilot in the room joins unless they are in Build or a mission (they join the next one); bots fill to 12 (host option to turn bots off is P1). The host is authoritative for the seed, Signal, shared rings, bots, damage, knockouts and match end; each pilot simulates their own drone (brief, locked). Design requirements for NETCODE.md:

- Pilots announce their tier by id (`spark`, `bolt`, `storm`, `nova`); peers look the spec up in the Royale tier table. Never send Royale specs through `validateSpec` (it turns them into generic models with renamed ids).
- Shots, water ticks and EMPs are events; the shooter claims hits, the host validates range, rate, line of sight and timing, then broadcasts damage. Pushes and scrambles are delivered to the victim like today's bumps.
- Personal ring pickups are claims the host checks for plausibility (position near the ring at that time, at most one per ring per pilot).
- Host leaves mid match: the match ends for everyone with results computed from the current placement ("HOST LEFT. MATCH ENDED"). Host migration is P1.
- After results, "PLAY AGAIN" returns to the room lobby; the host's "REMATCH" starts the next match with the same people.

### 2.14 Engine notes (what the design needs from code)

1. `DroneSim` needs a durable mode: impacts, prop strikes and mid air collisions report but do not call `crash()`; water and blade still crash. Spielwiese keeps today's rules exactly.
2. `multiplayer.ts` `onRemoteBump` must not crash on `dv > 5` in Royale; damage goes through the Royale layer.
3. Each Royale actor owns a copy of its tier spec, so BOOST can change `maxSpeed`, `maxTilt`, `maxClimb` and `maxThrust` temporarily without touching the shared table.
4. Royale forces (water push) are added to `extraForce` after the hose line that resets it each step.
5. New `ModelKind` values `spark`, `bolt`, `storm`, `nova` (Art builds them; until then `generic` with tier colours). `legHeight()` needs entries for them.
6. A new game state `royale` (sub phases intro, live, ko, spectate, over). `updateTools` stays Spielwiese only; Royale owns its water logic.

### 2.15 Royale roadmap (after this cycle)

| When | Feature |
|---|---|
| Next cycle | Rookie reboot (one respawn as Spark before 2:30 in the first 3 matches); Nova shield (Nova Burst also gives 3 s of 50 point shield); pick your launch point on the map during the intro; seeded challenge links ("beat my #2 on this exact match"); first win of the day bonus. |
| Season 1 | Duos and trios with shared Signal pings and revive by hovering over a knocked teammate for 3 s; evolution branches at Storm (STORM fighter or LIFTER tank with a bigger tank and more integrity); weekly mutators ("GUST WEEK" 8 m/s wind, "DUSK ROYALE", "ACRO ONLY", "NOVA RUSH" with half Shine costs). |
| Later | Custom Royale layouts from Build mode (your course's rings become Shine lanes in private rooms); spectator and caster camera; dedicated servers for 30 to 50 pilot matches and a bigger map; ranked with server side validation. |

---

## 3. SPIELWIESE depth (this cycle)

The rail becomes: "ROYALE", "SPIELWIESE" (free flight and course building, today's FLY and BUILD), "ACADEMY" (drills, missions, daily), "WORKSHOP" (hangar and parts builder), "SQUAD", "SETTINGS".

### 3.1 Academy drills

Drills are 20 to 60 second tests of one skill on a fixed drone, so results are comparable. Every drill has four medals ("BRONZE", "SILVER", "GOLD", "SHINE"), a personal best, the last 10 attempts, and (P1) a ghost. Instant restart with R, Back or the reset button; the clock starts when the drone arms or passes the start ring. The eight existing missions stay as the "MISSIONS" tab with their stars.

| Drill | Skill | Drone, mode | Setup | Score |
|---|---|---|---|---|
| "HOVER LOCK" | Precision | Spark, Angle forced | Hold inside a 1 m sphere at 4 m over a Base pad for 20 s, wind 4 m/s gust 0.4 | average distance from centre in cm, lower is better |
| "RING SPRINT" | Speed | Spark, any mode | 10 rings (R 2.6) from Base around the Solar Field edge and back | time |
| "SLALOM" | Control | Spark, any mode | 8 pillars 12 m apart on the apron line, pass alternately left and right, finish through a gate | time; +2 s per wrong side or touch |
| "PAD HOP" | Landing | DScan, any mode | Land on 5 platforms in order (Base pads, two built platforms at 6 and 12 m, office roof); a landing counts after 0.5 s still within 1.5 m of centre | time; +3 s per touchdown above 2 m/s |
| "TARGET RANGE" | Aim | Spark with PULSE, GPS | 15 drone shaped targets in the Freestyle Park, some moving on rails, 60 s | 100 per target, +5 per second left, −10 per shot beyond 3 × targets hit |
| "DOGFIGHT" (P1) | Combat | Spark vs one Pilot bot | 60 m sphere arena, best of 3 | rounds won, then time |

Royale tutorials hide inside drills: TARGET RANGE teaches the crosshair and assist, RING SPRINT teaches ring lines.

### 3.2 Seeing yourself improve

- **Skill bars.** Five skills (Precision, Speed, Control, Landing, Aim), each 0 to 100 from the personal best (formula 6.14). **"PILOT SKILL"** is their average, shown big on the Academy page and on the results screen of any drill: "PILOT SKILL 47, UP 6 THIS WEEK".
- **Every attempt counts.** Each drill row shows best, medal, and a 10 attempt sparkline; a new best pops "NEW BEST" with the delta ("0.84 S FASTER").
- **Ghosts (P1).** The best run of each drill is recorded at 20 Hz (position, rotation, motor) and replays as a translucent Light Green drone. Optional "GOLD GHOST" recorded by the studio for each drill.
- **Daily challenge (P1).** One drill per day, seeded by the UTC date: drill from the rotation, wind 2 to 9 m/s, wind direction, start yaw, ring offsets up to ±10 m, drone (Spark, DScan, Shine 5 or Cine 8). Unlimited attempts, best counts. Streak counter ("DAILY STREAK 4"). Share text: "DRONE ON Daily 03.10.2026: 21.84 s, GOLD" plus link. Global leaderboards need a server (section 4).

### 3.3 Pilot progression

One **pilot level** (1 to 50 this cycle) for the whole game; XP from every mode (6.13), so Spielwiese players and Royale players climb the same ladder. XP to next level = min(3000, 400 + 100 × (level − 1)): level 10 after about 18 matches, level 50 is a long term goal.

Unlock track (every level gives something; cosmetics never change stats):

| Level | Unlock |
|---|---|
| 2, 3, 4 | Paint "EVERGREEN" (Royale tiers and Workshop drones); frame "LONG RANGE 7"; title "RING RUNNER" |
| 5, 6, 7 | LED colour Blue and tool Thermal camera; motor "M25"; trail "SHINE TRAIL" (Royale and free flight) |
| 8, 9, 10 | Frame "HEX 18"; title "STATIC SURVIVOR"; paint "OFF WHITE PRO" and victory flourish "BARREL ROLL" |
| 11 to 50 | Pattern: paint, part, LED or trail, title, every 5th a paint set or frame; titles at 15 "ACE", 20 "SIGNAL MASTER", 30 "NOVA PILOT", 40 "FIELD LEGEND", 50 "DRONESHINE CREW" |

Feats (P1) give titles regardless of level: "SPARK OF GENIUS" (win without evolving past Bolt), "MAKING WAVES" (3 water knockouts), "SUN POWERED" (recharge 100 % on solar in one match).

Titles show under the pilot name on kill feed hover, results and room lists.

### 3.4 Workshop: build a drone from parts

The Workshop is the default way to build a drone; the existing raw number editor stays as **"EXPERT NUMBERS"**. Pick five parts, see the drone update live on the pad (existing preview), read the numbers, save to the hangar, fly it.

Slots: Frame, Motors (one type for all), Props, Battery, Tool, plus Name, Paint and Flight tune ("SMOOTH", "SPORT", "FREESTYLE" rate presets). Formulas and parts in 6.15. The Workshop computes a full `DroneSpec` and runs it through `validateSpec`.

Rules:
- The save button needs thrust to weight ≥ 1.5. Messages: "TOO HEAVY TO LIFT OFF. STRONGER MOTORS OR A LIGHTER PACK.", "THESE PROPS ARE TOO BIG FOR THIS FRAME.", "THESE MOTORS CANNOT SPIN PROPS THAT SIZE."
- Live stats row: take off mass, thrust to weight, hover time, GPS top speed, estimated Acro top speed, and "FLIES LIKE: DSCAN" (closest featured drone by mass and thrust to weight).
- "EXPERT NUMBERS" opens the raw editor with the computed spec. Once edited there, the drone is badged "EXPERT TUNED" and leaves parts mode ("REBUILD FROM PARTS" discards the numbers).
- Parts unlock by pilot level (P1 gating; in the first build everything at level 1 in 6.15 is open).

**Relation to Royale.** Workshop drones do not fly in Royale: tiers keep matches fair. Three bridges instead: (1) your Workshop paint and LED colour are your Royale paint; (2) levels earned in Royale unlock Workshop parts; (3) later, "GARAGE ROYALE" in private rooms normalises Workshop drones into tier envelopes (P2).

### 3.5 Onboarding: the first 60 seconds

First visit (no `droneon2.progress`): the menu loads with "ROYALE" focused and a quiet secondary line "NEW HERE? LEARN TO FLY IN THE ACADEMY". Tapping ROYALE starts **Rookie Royale** immediately (Rookie mix, coaching prompts, human spawn next to the Apron or nearest lane). Prompts appear once per profile, device specific, and disappear as soon as the action is done.

| Time | Moment | Prompt (example for touch) |
|---|---|---|
| 0 to 5 s | Launch intro shows the Signal and rings | "LAST DRONE FLYING WINS. FLY THROUGH GREEN RINGS TO EVOLVE." |
| 5 s | GO, hovering in GPS | "RIGHT STICK TO FLY. LEFT STICK TO CLIMB AND TURN." (keyboard: "ARROWS TO FLY. W S CLIMB, A D TURN." shooter: "WASD TO FLY. MOUSE TO TURN.") until moved 10 m |
| 10 s | Beam marker on the lane start | "FLY THROUGH THE RINGS" |
| first ring | chime, "+1 SHINE", tier bar fills | "SHINE EVOLVES YOUR DRONE. 4 MORE TO BOLT." |
| ~30 s | Lane done, evolve to BOLT | "NEW: WATER JET. PUSH DRONES AWAY." with the button highlighted |
| ~40 s | Routed Rookie bot comes into view | "ENEMY AHEAD. YOUR DRONE FIRES BY ITSELF WHEN THE CROSSHAIR IS ON IT." (keyboard: "AIM AND HOLD SPACE") |
| ~50 s | First knockout | "KNOCKOUT. +3 SHINE." |
| 60 s | Signal starts shrinking | "THE SIGNAL IS SHRINKING. STAY INSIDE THE LIGHT." |

The first match is tuned so a new player reaches Bolt, lands a knockout and survives past 2:00 in most runs. A beginner who loses still sees XP, a level up (level 2 is reached by almost any first match) and a near miss line.

---

## 4. Retention and growth (roadmap)

Honest priority order. Nothing below matters if 1 and 2 are weak.

1. **The match itself and the first session.** Flight feel, evolve moment, fair bots, a results screen that makes Play again the obvious tap. Goal: 50 % of new players play 2+ matches in the first session.
2. **Friends.** Room codes and invite links already exist; add "REMATCH" and one tap invite from results. For a free browser game, invites are the growth engine.
3. **Measurement.** We cannot see retention without any backend. Next cycle: a minimal anonymous event counter (match started, match finished, day 1 and day 7 return), no personal data. Fly blind no longer than one cycle.
4. **Daily habit:** daily challenge (3.2), three "DAILY ORDERS" (for example "COLLECT 40 SHINE", "WIN A FIGHT WITH THE WATER JET", "RECHARGE ON SOLAR"), first win of the day.
5. **Clips.** Auto detect highlight events (water knockout, win, ram knockout) and offer "SHARE CLIP" of the last 15 s via canvas capture (P2: needs a phone performance check).
6. Seasons and economy only after day 1 retention reaches 25 %.

| Lever | Design |
|---|---|
| Daily loop | Daily challenge, daily orders (+100 XP each), first win bonus (+200 XP), streak. |
| Weekly loop | "WEEKLY CUP": one fixed course time trial with a shared ghost of the week; weekly Royale mutator. |
| Seasons | 8 weeks. Free season track of 30 steps with cosmetics; one world change per season (a new POI built from builder pieces, a night season); season title. |
| Social | Rooms, rematch, duos and trios (2.15), spectate friends, challenge links with seeds, share cards (results as an image). |
| UGC | Share links for courses exist; add a course browser with ratings (server), Royale layouts from Build in private rooms, shared Workshop drones (file and link exist). Creator codes: featured course and drone creators get a code; when an economy exists, a share of cosmetic revenue supports them. |
| Esports | Room tournaments with brackets run by a host; caster camera (free camera, pilot cams, arena map); monthly "ACE CUP" with DroneShine prizes; Acro freestyle and time trial as spectator formats; school and university leagues (real physics is a teaching angle). |
| Economy (designed, not built) | Cosmetic only, forever: paints, LEDs, trails, prop styles, victory flourishes, name plates. Earned soft currency "CREDITS" from play; later a premium season track and a rotating shop. No loot boxes, no random paid rewards, no trading, no pay to win, no stat cosmetics. Parental friendly by design (PEGI 7). |

---

## 5. MVP scope

Owner roles: **GE** Gameplay and Engine, **ART** Art and Animation, **SRV** Server, **DES** Design. P0 must ship this cycle.

| # | Feature | Owner | Pri | Acceptance criterion |
|---|---|---|---|---|
| 1 | Royale entry: rail command, Royale sheet, instant solo | GE, ART | P0 | Menu tap on PLAY to controllable drone at GO ≤ 10 s on a mid range phone with the network off. |
| 2 | Match director: seed, intro, phases, end, results flow | GE | P0 | 20 headless bot only matches each end with one winner between 5:00 and 6:30. |
| 3 | Tier specs (6.1) and hot swap evolve | GE | P0 | Evolve at 15 m/s in GPS, Angle and Acro: altitude change < 1 m, no crash, no console error. |
| 4 | Tier models Spark, Bolt, Storm, Nova and evolve VFX | ART | P0 | Each tier identifiable by silhouette at 60 m; evolve VFX ≤ 1 s; each model within the phone triangle budget set in ART.md. |
| 5 | Durable Royale flight (no impact crashes, impact and ram damage, water and blade knockouts) | GE | P0 | Royale: no crash while integrity > 0 except water and blade. Spielwiese crash behaviour unchanged (regression run of all 8 missions). |
| 6 | Rings: Shine lanes, Big Shine, Charge, Repair, Shine caches, respawns, personal dimming | GE, DES, ART | P0 | All rings in 6.6 placed with ≥ 1.5 m clearance; pass detection works at 35 m/s; personal rings dim only for the collecting pilot. |
| 7 | PULSE: projectiles, hit detection, assist, auto fire | GE | P0 | 120 live projectiles: 60 fps desktop, ≥ 30 fps mid phone; assist cones match 6.9 per mode and device. |
| 8 | BOOST, WATER JET with tank and lake refill, EMP and Nova Burst (tier numbers) | GE, ART | P0 | Bolt jet pushes a GPS Spark ≥ 5 m in 1.5 s while a GPS Nova drifts < 1 m; scramble lasts exactly its duration; lake skim refills. |
| 9 | Kill credit, KO feed copy, Shine cache and salvage | GE | P0 | Every cause in 2.6 produces the right line; credit within 10 s works for wall, water and Static finishes. |
| 10 | Signal: schedule, centres, Static damage, ceiling, wall and screen VFX | GE, ART | P0 | Matches follow 6.7 to within 0.5 s on every screen in a room; final centres never over water. |
| 11 | Bots: brain, 3 difficulties, 100 Hz sims, avoidance, fairness rules | GE | P0 | 11 bots cost ≤ 3 ms per frame on a mid phone; a hover only human survives ≥ 90 s in Rookie mix in ≥ 80 % of runs; bots crash into scenery < 1 per match on average. |
| 12 | Solar perch and ground recharge | GE | P0 | A drone that auto landed on empty can recharge and take off again; solar rate 4 %/s verified. |
| 13 | Royale in rooms: host authority, bot fill to 12, host left ends match | SRV, GE | P0 | 2 desktops and 2 phones finish a match with identical alive counts, feed and winner on all screens. |
| 14 | HUD (2.11) on desktop, phone portrait and landscape, RC7 | GE, ART | P0 | No overlap at 375 × 812, 812 × 375, 960 × 600, 1920 × 1080. |
| 15 | KO card, spectate, results, Play again | GE, ART | P0 | Results to next GO ≤ 8 s; XP lines sum correctly; unlock shown when earned. |
| 16 | Controls: CLASSIC, SHOOTER, gamepad, touch, RC7 | GE | P0 | A full match is playable with each scheme; every action reachable on touch and RC7. |
| 17 | Rookie Royale onboarding prompts | DES, GE | P0 | All prompts in 3.5 fire once per profile in the right order; 5 first time testers all evolve before 1:00. |
| 18 | Pilot XP, levels 1 to 50, unlock track | GE, DES | P0 | XP from Royale, drills and missions saved under `droneon2.`; levels and unlocks survive reload. |
| 19 | Audio: pulse, hit, water, EMP, evolve, ring chimes, Signal warning, Static crackle | ART | P0 | Every combat event has a sound; no clipping with 12 drones. |
| 20 | Academy: 5 drills, medals, personal bests, attempt history | GE, DES | P0 | Each drill playable on all inputs; medal thresholds from 6.14; best and last 10 saved. |
| 21 | Skill bars and Pilot Skill | GE, ART | P0 | Bars update after each drill; weekly delta shown. |
| 22 | Workshop parts builder with live stats and Expert numbers | GE, ART | P0 | Every part combination yields a valid spec; T/W < 1.5 cannot be saved; saved drones fly in free flight and squads. |
| 23 | Rail and menu restructure (3) | ART, GE | P0 | Six commands, all sheets reachable on touch, RC7 and pad. |
| 24 | Performance and stability | GE | P0 | Full Royale: 60 fps desktop, ≥ 30 fps mid phone, zero console errors in a QA round. |
| 25 | Ghosts for drills | GE | P1 | Best run replays in sync within 0.1 s. |
| 26 | Daily challenge and streak | GE, DES | P1 | Same seed gives the same layout on any device that day. |
| 27 | Nova shield, Rookie reboot, first win of the day | GE | P1 | As 2.15. |
| 28 | Paint and LEDs carried into Royale; parts gated by level | GE, ART | P1 | Equipped paint visible to others in rooms. |
| 29 | Room options (bots on or off, difficulty), RC aux binding, host migration | GE, SRV | P1 | Host leaving mid match hands over without ending it. |
| 30 | Launch point pick, seeded challenge links, DOGFIGHT drill, feats | GE, DES | P1 | |
| 31 | Clips, duos, daily orders, course browser, leaderboards, analytics counter | GE, SRV | P2 | Next cycle planning. |

---

## 6. Tuning (the only place numbers live)

### 6.1 Tier DroneSpecs (canonical; trusted constants, not passed through `validateSpec`)

| Field | Spark | Bolt | Storm | Nova |
|---|---|---|---|---|
| id / name | `spark` / "SPARK" | `bolt` / "BOLT" | `storm` / "STORM" | `nova` / "NOVA" |
| model | `spark` | `bolt` | `storm` | `nova` |
| layout | quadX | quadX | hexX | coaxX8 |
| armLength m | 0.16 | 0.24 | 0.34 | 0.40 |
| propDiameter m | 0.18 | 0.254 | 0.30 | 0.33 |
| mass kg (empty tank) | 1.1 | 1.9 | 3.0 | 4.6 |
| maxThrust N per motor | 8.0 | 13.5 | 15.0 | 17.0 |
| motorTau s | 0.03 | 0.04 | 0.045 | 0.05 |
| dragArea m² | 0.03 | 0.045 | 0.07 | 0.10 |
| battery cells / Ah | 4 / 1.8 | 6 / 2.0 | 6 / 3.5 | 8 / 4.0 |
| defaultMode | gps | gps | gps | gps |
| maxTilt ° | 28 | 30 | 32 | 34 |
| maxSpeed m/s | 12 | 14 | 16 | 18 |
| maxClimb m/s | 5 | 6 | 7 | 8 |
| maxYawRate °/s | 180 | 160 | 140 | 120 |
| rates rcRate / superRate / expo | 0.9 / 0.55 / 0.3 | 0.9 / 0.55 / 0.3 | 0.85 / 0.5 / 0.3 | 0.85 / 0.5 / 0.3 |
| camUptilt ° | 20 | 15 | 10 | 5 |
| tool / flow L/min | camera | lance, hose false / 9 | lance / 9 | lance / 9 |
| default color / accent | #26C257 / #F7F7F2 | #8FC2F5 / #002518 | #004225 / #B5F78A | #F7F7F2 / #26C257 |
| legHeight m (Art may refine) | 0.06 | 0.12 | 0.18 | 0.22 |

### 6.2 Tier Royale stats

| Stat | Spark | Bolt | Storm | Nova |
|---|---|---|---|---|
| Integrity max | 100 | 130 | 165 | 200 |
| Hit sphere radius m (projectiles) | 0.67 | 0.78 | 0.90 | 0.97 |
| PULSE damage | 7 | 8 | 9 | 10 |
| PULSE shots per s | 4 | 5 | 6 | 7 |
| PULSE speed m/s | 110 | 120 | 130 | 140 |
| PULSE range m | 60 | 70 | 80 | 90 |
| PULSE DPS (reference) | 28 | 40 | 54 | 70 |
| Tank L | 0 | 0.5 | 0.7 | 0.9 |
| WATER JET push N | | 12 | 18 | 26 |
| Special | | | EMP | NOVA BURST |
| Shine to reach | 0 | 5 | 15 | 30 |

### 6.3 Abilities

| Parameter | Value |
|---|---|
| PULSE battery cost | 0.18 % per shot; disabled below 3 % |
| PULSE projectile | no gravity, no velocity inheritance, lifetime = range / speed, muzzle 0.2 m ahead of the nose |
| BOOST | 2.0 s; maxSpeed × 1.6, maxTilt + 15° (cap 60), maxClimb × 1.5, maxThrust × 1.15 (Acro × 1.25); cost 3 % battery; cooldown 7 s |
| WATER JET | range 22 m, cone 5°, tick 0.1 s, 2 damage per tick, push for 0.1 s per tick, use 0.15 L/s, 1 kg per L payload |
| EMP (Storm) | charge 0.35 s, radius 15 m, damage 20, scramble 1.5 s, cost 5 %, cooldown 16 s |
| NOVA BURST (Nova) | charge 0.35 s, radius 20 m, damage 28, scramble 2.0 s, cost 5 %, cooldown 14 s; P1: self shield 50 for 3 s |
| Scramble immunity after a scramble | 3 s |

### 6.4 Damage rules

| Rule | Value |
|---|---|
| Ram damage | 5 × own dv (existing momentum share), cap 150; no damage below 3 m/s closing speed; pair cooldown 0.3 s (existing) |
| World impact damage | 6 × (impact m/s − 4); trees: 3 × (impact − 5) |
| Instant knockout | water contact, turbine blade contact |
| Static damage tick | every 0.5 s, half the phase's per second value |
| Kill credit window | 10 s |
| Last two knocked out in the same tick | more integrity before the tick wins, then more Shine, then more damage dealt |
| Salvage on knockout | knocker +3 Shine, +20 integrity |
| Evolve | integrity = min(max, current + 40 % of new max); invulnerable 1.0 s; battery ≥ 60 %; tank ≥ 50 % |
| Overcharge after Nova | +4 integrity per Shine |

### 6.5 Shine and rings

| Item | Value |
|---|---|
| Shine ring | +1, personal, R 2.6, never respawns, taken ring opacity 15 % |
| Lane bonus | +2 for 5 in order within 15 s; Grand Loop +4 for 12 in order within 60 s |
| Big Shine | +3, shared, R 1.4, respawn 40 s |
| Charge ring | +30 % battery, +0.3 L water, shared, R 2.6, respawn 25 s |
| Repair ring | +35 integrity, shared, R 2.6, respawn 30 s |
| Shine cache | max(2, floor(0.5 × victim Shine)), pickup radius 2.5 m, lifetime 30 s; over water it floats at WATER_Y + 3 |
| Pass check radius | rings within 40 m of each drone, plane crossing inside 0.95 × R |

### 6.6 Ring layout (design intent; clearance rule in 2.3 applies)

y is absolute world height unless marked AGL. Lanes: 5 rings starting at the start point, along the heading, at the spacing; "curve" turns the heading by that many degrees per ring.

| Lane | POI | Start (x, z) | Heading | Spacing | Height | Shape |
|---|---|---|---|---|---|---|
| L1 "APRON RUN" | Base | (−40, −30) | 90 | 20 | y 5 | straight |
| L2 "ROW SKIMMER" | Solar | (−40, −165) | 90 | 20 | y 5.5 | straight, in the aisle between rows |
| L3 "SOLAR DIAGONAL" | Solar | (−50, −125) | 45 | 25 | y 12 | straight |
| L4 "FACADE CLIMB" | Office | (153, 4) | 180 | 8 | y 4, 8, 12, 16, 20 | climbing along the west wall |
| L5 "ROOF HOP" | Office | (165, −6) | 180 | 12 | y 27 | straight over the roof |
| L6 "GRAND LOOP" | Freestyle | existing 12 rings (`world.rings`) | | | | existing path |
| L7 "CRANE DROP" | Freestyle | (−185, −62) | down | 7 | y 38, 31, 24, 17, 10 | horizontal rings, vertical dive under the jib tip |
| L8 "TOWER SPIRAL" | Turbine | circle r 14 around (−330, −280) | tangent | 72° steps | y 14, 22, 30, 38, 46 | spiral; tops stay below the blade sweep (51) |
| L9 "LAKE SKIM" | Lake | (0, 300) | 90 | 20 | y 2.4 | straight, 4 m above water |
| L10 "RIDGE LINE" | Open | (−120, −120) | 300 | 20 | AGL 14 | curve 8 |
| L11 "FOREST GAP" | Open | (80, −300) | 270 | 20 | AGL 18 | curve −10 |
| L12 "MEADOW ARC" | Open | (−300, 120) | 30 | 20 | AGL 16 | curve 12 |

| Big Shine | Position (x, y, z) | Facing |
|---|---|---|
| B1 "BANDO CORE" | (−220, 2.0, 9) | 90 |
| B2 "CRANE TOP" | (−200, 49, −55) | 90 |
| B3 "TURBINE CROWN" | (−330, 70, −266) | 0 |
| B4 "ROOFTOP" | (168, 26, 10) | 180 |
| B5 "PANEL GAP" | (0, 2.4, −165) | 90 |
| B6 "LAKE EYE" | (40, 1.6, 300) | 90 |
| B7 "VAN GAP" | (5.5, 2.2, 22) | 180 |
| B8 "GATE ONE" | (−190, 1.6, −15) | 0 |

| Charge rings (x, y, z, facing) | Repair rings (x, y, z, facing) |
|---|---|
| C1 (0, 8, −10, 0) Base | R1 (15, 6, −35, 90) Base |
| C2 (−20, 10, 45, 90) Base | R2 (0, 12, −105, 180) Solar |
| C3 (−75, 10, −170, 90) Solar | R3 (125, 8, 40, 0) Office |
| C4 (75, 10, −200, 270) Solar | R4 (−200, 18, 40, 90) Freestyle |
| C5 (140, 12, −25, 0) Office | R5 (−150, 8, −45, 0) Freestyle |
| C6 (200, 30, 55, 180) Office | R6 (−365, 25, −305, 90) Turbine |
| C7 (−160, 12, 35, 270) Freestyle | R7 (−40, AGL 6, 225, 90) Lake shore |
| C8 (−255, 15, −45, 0) Freestyle | R8 (−260, AGL 12, −170, 0) Open |
| C9 (−300, 24, −245, 45) Turbine | |
| C10 (−130, AGL 15, −260, 90) Open | |

### 6.7 Signal

| Parameter | Value |
|---|---|
| Start centre C0, radius R0 | (−60, −60), 420 m |
| Phases (hold start, shrink start, shrink end, radius after, Static per s, ceiling y) | P1 0:00, 1:00, 1:40, 260, 2, 120 · P2 1:40, 2:20, 2:55, 150, 4, 100 · P3 2:55, 3:30, 4:00, 80, 7, 80 · P4 4:00, 4:30, 4:55, 35, 11, 60 · P5 4:55, 5:15, 5:45, 0, 16, 45 · Overtime from 5:45, 25 per s |
| First next circle shown | 0:20 |
| Ceiling transition | 10 s from each shrink start |
| Centre bias | random POI in reach plus offset ≤ 40 m; final two centres over land (height > WATER_Y + 1) |
| Wall opacity | 0.15 far, 0.6 within 30 m; ceiling sheet within 10 m |

### 6.8 Battery, water, charging

| Parameter | Value |
|---|---|
| Ground recharge (landed, disarmed or idle) | 1 % per s |
| Solar recharge (landed on a `solar` collider) | 4 % per s |
| Battery warnings | 20 % and 10 % (existing voice), Royale copy in 2.8 |
| Lake refill | +0.25 L/s inside the lake ellipse below WATER_Y + 4.5 |
| Pad refill | +0.2 L/s within 4 m of a Base pad, below 3 m AGL |

### 6.9 Aim assist and auto fire

| Mode or device | Assist cone (half angle) | Auto fire default |
|---|---|---|
| GPS | 10° | |
| Angle | 7° | |
| Acro (FPV camera) | 4° | |
| Touch, RC7 | + 4° on top of the mode value | on |
| Keyboard, mouse, gamepad | mode value | off (setting) |
| Vertical correction | ±40° when target within 12° horizontally | |
| Auto fire lock delay | 0.15 s | |

### 6.10 Camera

| Parameter | Value |
|---|---|
| Royale chase distance | max(3.0, L × 3.6), L = 2 × armLength + propDiameter |
| Chase height | 0.45 × distance |
| Look target | drone + heading × 8 m, pitched by aim pitch (range −35° to +25°) |
| Drone screen position | about 60 % down from the top, crosshair above it |
| BOOST FOV kick | +8°, ease 0.2 s |
| Intro | 2 s overview at 300 m, 1 s swoop |

### 6.11 Bots

| Parameter | Rookie | Pilot | Ace |
|---|---|---|---|
| Reaction time s | 0.9 | 0.5 | 0.25 |
| Aim error σ ° (re rolled every 0.4 s) | 9 | 5 | 2.5 |
| Fire when error below ° | 10 | 6 | 3 |
| Burst on / off s | 1.5 / 1.2 | 2.0 / 0.6 | continuous |
| Detect range m | 45 | 70 | 90 |
| Hold fire after GO s | 30 | 12 | 5 |
| Flight mode | GPS | GPS | Angle |
| Ring flying speed (fraction of maxSpeed) | 0.6 | 0.8 | 1.0 with BOOST |
| Retreat below integrity | 25 % | 35 % | 30 % |
| Uses BOOST / WATER / EMP | rarely / no / no | yes / yes / 50 % | yes / yes / optimal |
| Damage multiplier | 0.7 | 1.0 | 1.0 |
| Aggression range (per bot) | 0.2 to 0.5 | 0.4 to 0.7 | 0.5 to 0.9 |
| Sim rate | 100 Hz, 50 Hz beyond 250 m from camera | | |

| Solo mix (11 bots) | Rookie | Pilot | Ace |
|---|---|---|---|
| Rookie (first 3 matches, rating < 900) | 9 | 2 | 0 |
| Normal (900 to 1200) | 4 | 6 | 1 |
| Hard (1200 to 1500) | 2 | 6 | 3 |
| Ace (> 1500) | 0 | 6 | 5 |

### 6.12 Match

| Parameter | Value |
|---|---|
| Pilots | 12 (humans plus bots) |
| Load budget | ≤ 3 s; intro 5 s |
| Launch slots | circle 0.65 × R0 around C0, 25 m AGL, facing C0, random rotation, 5° nudge until 6 m clear and not over water |
| Seeded per match | Signal centres, slot rotation, bot names and personalities, wind 1.5 to 4 m/s with gust 0.3, time of day day or golden |
| Results to next GO | ≤ 8 s |

### 6.13 XP, levels, rating

| Source | XP |
|---|---|
| Royale participation | 50 |
| Placement | #1 300, #2 200, #3 150, #4 to #5 100, #6 to #8 60, #9 to #12 30 |
| Knockout | 40 each |
| Damage | 1 per 10 dealt |
| Shine | 3 each |
| Highest tier | Bolt 25, Storm 50, Nova 100 |
| Survival | 1 per 3 s alive |
| First win of the day (P1) | 200 |
| Drill medal, first time | Bronze 40, Silver 60, Gold 90, Shine 150 |
| Drill personal best | 25, max 250 per day from bests |
| Mission star, first time | 30 |
| Daily challenge (P1) | 150 first completion, +50 for Gold or better |
| Free flight airtime | 5 per minute, max 60 per day |
| First Workshop drone saved | 100 once |
| Level curve | XP to next = min(3000, 400 + 100 × (level − 1)); cap level 50 |
| Pilot Rating | start 1000; #1 +40, #2 to #3 +20, #4 to #6 +5, #7 to #9 −10, #10 to #12 −20, +5 per knockout; clamp 600 to 2000 |

### 6.14 Academy medals and skill score

| Drill | Bronze | Silver | Gold | Shine |
|---|---|---|---|---|
| HOVER LOCK (cm, lower better) | 60 | 35 | 20 | 12 |
| RING SPRINT (s) | 45 | 33 | 26 | 21 |
| SLALOM (s) | 40 | 30 | 24 | 20 |
| PAD HOP (s) | 75 | 55 | 42 | 34 |
| TARGET RANGE (points, higher better) | 600 | 1000 | 1400 | 1700 |

Skill score 0 to 100: lower better: 100 × (1.5 × Bronze − best) / (1.5 × Bronze − Shine); higher better: 100 × (best − 0.5 × Bronze) / (Shine − 0.5 × Bronze); clamp both. Untried drill counts 0 and shows "TRY IT". Pilot Skill = mean of the five. Thresholds are first guesses: retune after a playtest so Gold is what a good DroneShine pilot flies on the third try.

### 6.15 Workshop parts and formulas

| Frame | Layout | Arm m | Mass kg | Drag m² | Max prop m | maxTilt ° | GPS speed m/s | camUptilt ° | Level |
|---|---|---|---|---|---|---|---|---|---|
| "MICRO 3" | quadX | 0.07 | 0.05 | 0.006 | 0.076 | 45 | 14 | 20 | 1 |
| "FREESTYLE 5" | quadX | 0.115 | 0.12 | 0.010 | 0.127 | 55 | 24 | 30 | 1 |
| "LONG RANGE 7" | quadX | 0.16 | 0.17 | 0.016 | 0.178 | 45 | 22 | 25 | 3 |
| "SURVEY 10" | quadX | 0.33 | 0.9 | 0.05 | 0.33 | 30 | 16 | −15 | 1 |
| "HEX 18" | hexX | 0.55 | 3.0 | 0.18 | 0.46 | 28 | 15 | 0 | 8 |
| "CINE X8" | coaxX8 | 0.5 | 3.6 | 0.16 | 0.46 | 28 | 18 | 0 | 14 |
| "OCTO 32" | octoX | 1.0 | 10 | 0.45 | 0.81 | 22 | 12 | −20 | 22 |

| Motor | Max thrust N | Mass kg | Max prop m | Level |
|---|---|---|---|---|
| "M4" | 4.5 | 0.012 | 0.09 | 1 |
| "M15" | 15 | 0.033 | 0.18 | 1 |
| "M25" | 25 | 0.06 | 0.28 | 6 |
| "M60" | 60 | 0.2 | 0.5 | 12 |
| "M150" | 150 | 0.6 | 0.8 | 18 |
| "M400" | 400 | 1.8 | 1.4 | 25 |

| Part | Options |
|---|---|
| Props (diameter) | 3 in 0.076, 5 in 0.127, 7 in 0.178, 10 in 0.254, 13 in 0.33, 18 in 0.46, 24 in 0.61, 32 in 0.81 m (limited by frame and motor) |
| Battery | cells 1 to 14 (level 1: up to 6), capacity 0.3 to 30 Ah (level 1: up to 3 Ah; level 12: 10 Ah; level 22: 30 Ah) |
| Tools | Camera 0.03 kg (level 1), Thermal 0.25 kg (5), Spray boom 0.8 kg plus tank 2 to 30 L (16), Lance 1.2 kg, hose optional (20), None |
| Flight tune presets (rcRate / superRate / expo) | SMOOTH 0.7 / 0.4 / 0.2, SPORT 0.9 / 0.55 / 0.3, FREESTYLE 1.0 / 0.7 / 0.3 |

Formulas (n = motor count, D = prop diameter in m):

| Output | Formula |
|---|---|
| prop mass | 0.004 + 0.6 × D³ kg |
| battery mass | 0.0239 × cells × Ah kg (170 Wh/kg, 10 % packaging) |
| electronics mass | 0.03 + 0.015 × n kg |
| mass | frame + n × (motor + prop) + battery + electronics + tool (tank stays payload) |
| maxThrust | min(motor max thrust, 900 × D²) N per motor |
| motorTau | 0.015 + 0.08 × D s |
| dragArea | frame drag (+ 0.02 for spray boom or lance) |
| maxSpeed, maxTilt, camUptilt | from frame; maxClimb = 4 + 0.15 × GPS speed; maxYawRate = 400 for arm < 0.2 m, 150 for arm < 0.4 m, else 90 |
| defaultMode | FREESTYLE tune → acro, else angle for arm < 0.2 m, else gps |
| estimated Acro top speed | sqrt(2 × sqrt((n × maxThrust)² − (m × 9.81)²) / (1.225 × dragArea)), shown as "ABOUT" |
| hover time, T/W | existing `derive()` in `src/ui/ui.ts` |
| save allowed | T/W ≥ 1.5, prop ≤ frame and motor limits |
