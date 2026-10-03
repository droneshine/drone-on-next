# DRONE ON Next: production plan

Version 1.0, 03.10.2026. Owner: Production. Run by the production lead (Claude), who merges and deploys. Sources: `BRIEF.md` (mandate, locked decisions), `GDD.md` (what we build; section 5 is the scope), `OWNERSHIP.md` (who edits what). This file says when something is done and how we know. Anything not P0 or P1 lives in `BACKLOG.md`.

**Roles in this file.** GE-R Royale programmer, GE-M Spielwiese programmer, ART, SRV server consultant, DES game designer, PROD production lead, QA (a fresh agent session per loop that runs the matrix), LUCA owner (real devices, real testers, go decision).

**Words.** "Feature priority" (F-P0, F-P1, F-P2) is the GDD section 5 column. "Severity" (P0, P1, P2) is a review finding. A missing F-P1 feature is never a finding above P2 this cycle.

**Baselines recorded 03.10.2026.** Live game: `droneshine/drone-on` main = `e351400`, worktree `C:\Users\lucam\droneshine-playground` clean. Next deploy: `next-origin` main = `74a08f1`. Branches `next-royale`, `next-meta`, `next-art` at `b4bff43`, no commits yet. `src/net/royaleProtocol.ts` and `server/` exist uncommitted on `next`; `studio/NETCODE.md` and `studio/ART.md` are not written yet.

---

## 1. Milestones

Order: M1 then M2, then M3 in parallel with M4 loop 1 (which reviews solo only), then M4 loops including rooms, then M5. No calendar dates: gates decide. Two things need LUCA's calendar and should be booked now: a real device session (RC7, one mid Android phone, one desktop with a real gamepad, about 45 min) at the end of M4, and 5 first time testers for GDD #17.

### M1 Parallel builds done

| Branch | GDD scope (section 5 #) | Exit criteria (all must hold) |
|---|---|---|
| `next-royale` (GE-R) | 1, 2, 3, 5 to 12, 14, 15, 16, 17 (logic), 24 (Royale share) | Solo match runs menu to results on desktop keyboard and on 390 x 844 touch with placeholder art through `src/art` contracts. 20 headless bot only matches end with one winner between 5:00 and 6:30 (#2). Evolve test passes in GPS, Angle, Acro (#3). Debug hook `window.droneon.royale` exposes state, match time, alive list, seats, a bots only switch and fake input for the QA rigs (dev builds and `#debug` only). The match director takes claims and emits verdict events even in solo (in memory loopback, no network), so M3 swaps the transport, not the logic. |
| `next-meta` (GE-M) | 18, 20, 21, 22, 23; XP hooks in missions and free flight | Rail has the six commands of GDD 3, including the "ROYALE" command that opens sheet `royale` when registered and hides otherwise. 5 drills with medals and saves; Workshop saves a flyable drone; XP and level survive reload under `droneon2.`. All 8 missions still complete as before. |
| `next-art` (ART) | 4, 19, the look of 8, 10, 14, 15, 21, 23 | `studio/ART.md` with phone triangle and draw call budgets per tier model and per VFX. Four tier models registered through `src/art/register.ts`; real `RoyaleArt` and `RoyaleSfx` behind `contracts.ts`; orthographic shots plus a 60 m silhouette sheet of all four tiers. |
| `next` (SRV) | 13 (protocol), NETCODE.md | Protocol, server and NETCODE.md committed on `next` (needed before any merge, see M2 step 0). Section 6 of this file resolved in protocol v1.1. `node server/selftest.mjs` green. |

Common to every branch: OWNERSHIP rules met (tsc zero errors, screenshots at the matrix viewports looked at, zero console errors, commits not pushed). The last commit message body is the handover note: what is done, what is stubbed, every shared file touched with line ranges, new debug hooks.

### M2 Integrated build on drone-on-next

PROD merges in a clean worktree, one branch at a time, gates after each merge, deploy at the end.

| Step | Merge | Why this position | Expected conflicts |
|---|---|---|---|
| 0 | SRV commits protocol, server, NETCODE.md on `next` | Uncommitted files in the merge worktree are a hazard; GE-R needs the protocol in its branch | none (new files) |
| 1 | `next-art` | Smallest shared surface, contract only; brings real tier models for everyone's testing | `src/sim/drone.ts` `TIER_LEG` if art refines leg heights |
| 2 | `next-meta` | The rail restructure is a structural rewrite of `ui.ts`; it lands before Royale's small hooks, which are cheap to reapply onto the new rail | `ui.ts`, `style.css` (rail), `game.ts` (drill state, XP hooks) |
| 3 | `next-royale` | Touches the most shared files; needs art and the rail to be testable as a whole | `game.ts`, `ui.ts`, `drone.ts`, `input.ts`, `multiplayer.ts`, `audio.ts` |

**Hotspots and how to resolve them**

| File | Who touches it | Resolution rule |
|---|---|---|
| `src/ui/ui.ts` | GE-M rail restructure and sheets; GE-R `syncState` for state `royale`, HUD hide, pause items | Take GE-M's rail whole. GE-R never edits rail markup: Royale only calls `registerSheet('royale', ...)`. Royale's state handling is one guarded call into `src/royale`. |
| `src/game/game.ts` | GE-R state `royale`, tick branch, intro stick lock at throttle 0.5, key exclusions R H F Q E; GE-M drill state, airtime XP | `State` union keeps every added value. Each role gets one guarded block in `tick()` that delegates to its own module (`if (this.state === 'royale') royale.tick(dt)`); no inline feature logic. Order of blocks: royale, academy. Do not reuse `raceLocked` for the intro (it sends throttle 0, GDD 2.2). |
| `src/sim/drone.ts` | GE-R durable mode and impact reports; ART `TIER_LEG` | Durable mode is one flag plus an `onImpact` callback, default off, so Spielwiese is byte for byte the old behaviour. ART wins on leg heights (GDD 6.1 "Art may refine"). |
| `src/input/input.ts` | GE-R combat actions, triggers, aux axis 5; GE-M drill restart on R and Back | New named actions, Spielwiese bindings untouched. Same key in two modes is resolved by state, never by rebinding Spielwiese. |
| `src/ui/style.css` | GE-M rail; GE-R one import of `royale.css` | Append only sections with a role header comment. |
| `src/net/multiplayer.ts` | GE-R bump guard (`dv > 5` crash off in Royale), START ROYALE hook; SRV transport | Royale room logic lives in `src/royale`; `multiplayer.ts` only exposes the room and a send hook. |
| `spec.ts`, `droneModels.ts`, `contracts.ts`, `progression.ts` API, `main.ts` | contracts | Changes only through PROD. Scaffold already added tier `ModelKind`, `modelRegistry`, install hooks. |
| `package.json`, lockfile, `vite.config.ts` | PROD | No new dependency without PROD. PROD adds the build stamp (below). |

Conflict procedure: the feature owner resolves on a fresh `git merge next` in their own worktree, reruns the gates, and hands back; PROD never resolves by dropping a side. After every integration all builders merge `next` back into their branch (merge, never rebase, never force).

**Gates after each merge:** `npx tsc --noEmit -p .` zero errors; `npm run build`; `tools/shot.mjs` menu at 1920 x 1080; `tools/touchtest.mjs`; `tools/mptest.mjs` (squad regression); QA mission regression rig (8 missions); from step 3 on, the Royale solo rig and the isolation rig (section 2.3).

**Build stamp and deploy.** PROD adds a build stamp (short commit hash and date) via `define` in `vite.config.ts`, shown in Settings and on `window.droneon.build`; every finding cites it. Deploy is `git push next-origin next:main`; the Pages workflow builds with `BASE=/drone-on-next/`. Nothing is ever pushed to `origin`.

**M2 exit:** deployed URL loads with the expected stamp; all gates green; solo Royale with real art playable start to results on D1 and P1 (section 2.3); Academy, Workshop, Spielwiese and squad reachable and working; zero console errors; live baseline unchanged (section 4 F).

### M3 Royale in rooms (SRV with GE-R)

Entry: section 6 decided, protocol v1.1 merged, M2 done. Work: Trystero transport for the protocol actions on the existing squad room; host "START ROYALE", bot fill to 12, host left ends the match, "PLAY AGAIN" back to the room lobby and host "REMATCH"; a 4 client QA rig.

Exit:
- #13: 2 desktops and 2 phones finish a match with identical alive counts, kill feed and winner on all screens: 3 runs in the headless 4 client rig, then 1 real run with LUCA (one phone on mobile data, so signalling and NAT are real).
- #10: the Signal radius and centre sampled at the same match time differ by less than 0.5 s of shrink on every screen.
- Verdict gaps and full syncs logged per match; zero full syncs on a clean run.
- Solo with the network off still reaches GO in 10 s or less and makes no network request after load.
- The game makes no request to `server/`; `node server/selftest.mjs` green.

### M4 Review loops to convergence

Protocol in section 2. Expected 3 to 5 loops. Exit: the convergence rule (2.6) holds, rooms were part of the clean loop, the real device session and the 5 first time testers are done and their findings are closed or in BACKLOG.

### M5 Release candidate

Freeze: only P0 and P1 fixes. PROD tags `rc1` on `next`, deploys, and runs the go/no go checklist (section 4) on that stamp. A fix during M5 means a new tag (`rc2`) and a rerun of the full QA matrix plus every checklist line the fix could touch. Exit: every checklist line ticked or waived in writing, then LUCA says go. This cycle ships to drone-on-next only; promotion to the live game is a separate decision by LUCA.

---

## 2. Review loop protocol

### 2.1 One loop

1. **Fix.** Builders fix their assigned findings on their branch; each commit names the finding IDs it closes.
2. **Integrate.** PROD merges in the M2 order, runs the gates, deploys, writes the stamp at the top of `studio/loops/LOOP-nn.md`.
3. **Review.** Six reviewers work in parallel on that one stamp: DES, programming, SRV, ART, PROD, QA. Programming review is done by a fresh session, or crosswise (GE-M reviews Royale, GE-R reviews Academy and Workshop); nobody reviews only their own code. Every checklist item below is covered every loop; no sampling on P0 items. Screenshots go to `C:\Users\lucam\dsn-qa\shots\LOOP-nn\` (outside the repo).
4. **Sign off.** Each reviewer ends with one line: `DES 3f2a1c9: 0 P0, 2 P1, 5 P2` or `DES 3f2a1c9: NO P0/P1`.
5. **Triage.** PROD dedupes, confirms severity, assigns the owner from OWNERSHIP, moves P2 to BACKLOG, closes the loop file.
6. **Verify.** In the next loop each reporter verifies their own fixed findings (verified or reopened) before new review.

### 2.2 Checklists per role (GDD section 5 numbers in brackets)

**DES** plays on a wiped profile first, then 3 solo matches (AUTO, PILOT, ACE) and one Academy session per loop.
- First match: every prompt of GDD 3.5 fires once, in order, in the device's wording; Rookie spawn next to a lane; routed Rookie bot near 0:40 [17].
- Pacing: Bolt 0:30 to 0:45, Storm about 2:00; alive curve near 8 at 2:00, 5 at 3:30, 2 to 3 at 4:30 [2, 11].
- Rookie fairness rules 1 to 4 of GDD 2.10 observable [11].
- Kill feed line for every cause in the GDD 2.6 table, with and without credit; tone never says "kill" [9].
- Results: placement, stat row, XP lines, the right near miss line, PLAY AGAIN focused, SHARE text [15]; level 2 after a first match, unlock shown [18].
- Five tuning spot checks per loop against GDD 6 (rotate: BOOST 2.0 s and 7 s, EMP 15 m, Static rates, ring respawns, recharge rates).
- Academy: 5 drills, medal thresholds of 6.14, "NEW BEST" with delta, Pilot Skill and weekly delta [20, 21]. Workshop messages, T/W gate, "FLIES LIKE" [22].
- Verdict on "want another round": a P1 only when a concrete cause is named.

**Programming** (engine, gameplay, code health)
- tsc zero, build green, no new dependency; shared file edits are hooks with a comment, nothing reformatted.
- Evolve at 15 m/s in GPS, Angle, Acro: altitude change under 1 m, no crash [3].
- Royale: no crash above 0 integrity except water and blade; Spielwiese crash rules unchanged, 8 missions rig green [5].
- Ring pass at 35 m/s; clearance report of every ring at 1.5 m or more; personal dimming only for the collector [6].
- 120 live projectiles: frame time at D1 and throttled P1; assist cones per mode and device as 6.9 [7].
- Jet test: Bolt jet moves a GPS Spark 5 m or more in 1.5 s, a GPS Nova under 1 m; scramble lasts exactly its duration; lake skim refills [8].
- Bots 3 ms per frame or less on the throttled phone profile; scenery crashes under 1 per match over the 20 match batch [11]. Solar 4 % per s, ground 1 % per s, take off after auto land [12].
- Leaks: five matches in a row then menu: Royale objects removed, `renderer.info` geometries and textures back to the menu baseline within 5 %, no listener growth [24].

**SRV**
- 4 client rig: identical alive counts, feed, winner; Signal within 0.5 s [13, 10]. Host closes tab mid match: "HOST LEFT. MATCH ENDED" with results everywhere.
- Cheat probes from a guest console: forged hit, hit out of range, double ring claim, fire faster than the tier rate, teleport. All denied, none crash the host.
- Message rates per action in a 12 drone final brawl stay inside the limits; verdict gaps and full syncs counted.
- Solo: zero network requests after load (network log). Trystero app id stays `droneon-next-by-droneshine`. `server/selftest.mjs` green.

**ART**
- Tier silhouettes readable at 60 m, models within the ART.md budget, evolve VFX 1 s or less [4].
- Signal wall, ground line, ceiling sheet and Static screen effect as GDD 2.7 and 6.7 [10].
- Every combat event has a sound, no clipping with 12 drones (peak meter in `#debug`) [19].
- HUD and screens against DESIGN.md: hairlines, Nasalization or Audiowide numbers, Inter text, brand palette only, no boxes in boxes; no overlap at 375 x 812, 812 x 375, 960 x 600, 1920 x 1080 [14, 15, 23].
- No full screen flash faster than 3 per second (evolve, hit, Static).

**PROD**
- Live untouched (section 4 F), isolation rig green, stamp correct, Pages workflow green, offline second launch works.
- Copy lint over every screen state plus a source grep: no dashes, no "kill", no third party drone brand names.
- Menu to GO 10 s or less with the network off on the throttled phone profile [1]; results to GO 8 s or less [15].
- Scope: every change since the last stamp maps to a GDD item or a finding; nothing unlogged.

**QA** runs the full matrix (2.3), the Spielwiese regression (free flight, missions, build, squad race, hangar, settings) and verifies every finding marked fixed this loop.

### 2.3 QA matrix

| Row | Viewport | Emulation | Inputs | Runs every loop |
|---|---|---|---|---|
| D1 | Desktop 1920 x 1080 | headless Edge, GPU flags as `tools/shot.mjs` | CLASSIC keys; SHOOTER keys and mouse; standard gamepad (fake pad, 17 buttons) | Royale solo AUTO and ACE, rooms host, Academy 5 drills, Workshop, Spielwiese regression |
| D2 | Desktop 1440 x 900 | headless Edge | SHOOTER; CLASSIC | Royale solo PILOT, rooms guest, every sheet and pause menu |
| P1 | Phone portrait 390 x 844 | `isMobile`, `hasTouch`, DPR 3, CPU throttle 4x | touch sticks and buttons | wiped profile onboarding, Royale solo, rooms guest, Academy, Workshop |
| P2 | Phone landscape 844 x 390 | as P1 | touch | Royale solo, HUD, rail, the "TURN YOUR PHONE" hint shown once |
| P3 | 375 x 812 and 812 x 375 | as P1 | touch | HUD and screens overlap check only (GDD #14 sizes) |
| R1 | RC7 960 x 600 | `hasTouch`, CPU throttle 4x, fake SIYI pad injected before load | physical sticks via fake pad, touch buttons | Royale solo full match, HOVER LOCK, RING SPRINT, Spielwiese free flight |

**Fake SIYI pad (R1).** `navigator.getGamepads` override before load: id string of the real transmitter as `#debug` reports it, 8 axes, fewer than 10 buttons (so `looksLikeRC` is true), axes resting off centre: throttle at −1, two aux axes resting at +1 and −1, sticks at 0 with ±0.01 noise. Checks: device stays `touch` until an axis really moves (more than 0.3 from rest), then `rc`; a resting throttle is not input; GPS hover with the throttle centred; "THROTTLE TO MIDDLE" during the countdown in Angle and Acro with a low throttle; aux axis 5 fires PULSE; 72 px buttons hug the bottom edges; unplugging the pad mid match leaves no stuck input.

**Coverage rule.** Every loop, each input scheme (CLASSIC, SHOOTER, gamepad, touch, RC7) plays at least one full Royale match, and GPS, Angle and Acro are each flown by at least one scheme (rotate). Rooms run on D1 host plus D2, P1 and R1 guests. Network: offline for solo, normal and "Fast 3G" for a rooms guest. Real devices (LUCA): end of M4 and at M5.

**Rigs QA adds** (new files under `tools/qa/`, existing rigs untouched): `royale-batch.mjs` (N bot only matches: winner, end time, alive curve, scenery crashes, bot ms per frame), `royale-solo.mjs` (scripted match per row and input, shots per phase, console log), `rc7.mjs` (fake SIYI pad), `rooms4.mjs` (4 pages in one room: alive, feed, winner, zone samples), `perf.mjs` (60 s brawl, p50 and p95 frame time), `missions.mjs` (8 missions), `copylint.mjs` (visits every sheet and HUD state, dumps visible text, flags dashes, "kill", brand names), `isolation.mjs` (section 4 F).

### 2.4 How a finding is written

One line, fields separated by ` | `, in the reviewer's section of `studio/loops/LOOP-nn.md`:

`ID | severity | owner | title | repro | expected | actual | file:line | status`

```
L02-Q07 | P1 | GE-R | Shine ring missed at speed on CRANE DROP | 3f2a1c9, D1, CLASSIC, solo, Acro dive through L7 ring 3 | +1 SHINE, pass works at 35 m/s (GDD 2.5, #6) | no pickup 3 of 5 tries at 33 to 36 m/s | src/royale/rings.ts:88 | open
L02-D03 | P1 | DES | Penalty shown with a minus sign | 3f2a1c9, P1, TARGET RANGE, miss 20 shots | no dashes in copy (BRIEF) | "-10" floats over the target | src/academy/range.ts:? | open
```

ID = loop, reporter letter (D design, G programming, S server, A art, P production, Q QA), number. Repro names the stamp and matrix row and is runnable by someone else. Expected cites GDD section or #, BRIEF, DESIGN.md, or "same as the live game". One defect per line. Status: `open`, `fixed <commit>`, `verified`, `reopened`, `wontfix <reason>` (PROD only), `moved B-nnn` (BACKLOG).

### 2.5 Severity

| Severity | Rule (first match wins) |
|---|---|
| **P0 blocker** | A GDD F-P0 acceptance criterion fails on any matrix row. Uncaught exception, console error, freeze, softlock, NaN in a sim. A match, drill or Workshop save cannot be completed. Solo needs the network. Any write to the live game's storage, repo or deploy. Save data lost. PEGI 7 broken (blood, people hurt, real weapons). |
| **P1 significant** | A F-P0 feature works but a player notices a deviation from GDD rules or numbers. Copy rule broken (dash, "kill", third party drone brand). Overlap or unreachable control at 1440 x 900, 390 x 844 or 844 x 390. Spielwiese behaviour differs from the live game. A warning logged every frame. A new player in their first three matches would be confused or stuck. |
| **P2 polish** | Feel, juice, wording inside the rules, small visual misalignments, missing F-P1 or F-P2 features, ideas. |

Measurement tolerances (so frame noise does not decide severity): "60 fps desktop" = p50 at 58 fps or more and p95 frame time at 20 ms or less; "30 fps phone" = p50 at 30 fps or more and p95 at 40 ms or less; timings are the median of 3 runs.

Who decides: the reporter proposes, PROD confirms at triage. Only PROD may downgrade, with a written reason on the line; the owner may contest with evidence. When unsure between P1 and P2: would a new player hit it in their first three matches? Yes means P1. When the GDD is silent, PROD decides and records it in the loop file; game rule questions go to DES, not into debate.

### 2.6 Convergence rule

- A loop is **clean** when, on one stamp, all six reviewers signed off, every matrix row ran, and the count of open, new and reopened P0 plus P1 is zero.
- M4 ends at the first clean loop that included rooms. A loop with any fix in a shared file is never a partial review: everyone reviews again.
- Ideas and new features can never be P0 or P1; they go to BACKLOG as `idea`.
- **Stall rule.** If the P0 plus P1 count does not fall for two loops in a row, or loop 6 starts without convergence, PROD stops and brings LUCA a cut or waiver proposal (cut order in risk R5).
- Waivers: only LUCA may waive a P0; PROD may waive a P1 with a written reason (for example a browser bug outside our code). Every waiver is listed in the RC notes at the end of the last loop file.

---

## 3. Risk register (top 10)

| # | Risk | L | I | Mitigation | Owner |
|---|---|---|---|---|---|
| R1 | Phone performance with 12 drones, 11 bot sims, 120 projectiles and VFX | H | H | Budgets fixed at M1 (bots 3 ms, ART.md triangles and draw calls, pooled VFX, particle caps, bots at 50 Hz beyond 250 m); `perf.mjs` every merge; automatic quality step down when p95 stays above 40 ms for 3 s; real phone run at end of M4. Early signal: p95 above 33 ms on P1 at M2. | GE-R, ART |
| R2 | Bots make solo boring or unfair (solo is the default experience) | H | H | 20 match batch every loop with alive curve, end time, crash count; hover only human survival in Rookie mix; DES plays three difficulties per loop; tuning only through the GDD 6.11 table. | GE-R, DES |
| R3 | Royale rooms unreliable on P2P: slow Nostr signalling, WebRTC failing behind mobile NAT without TURN, phone host dropping | H | H | Solo never touches the network; join timeout 15 s with a "PLAY SOLO" way out; host left ends the match (section 6, D8); 4 client rig every loop plus a real cross network run; lobby suggests a desktop host; TURN only with LUCA's OK (new service, BACKLOG). | SRV, GE-R |
| R4 | Merge conflicts in `game.ts`, `ui.ts`, `input.ts`, `drone.ts` | H | M | M2 order and hotspot rules; one guarded hook per role; back merge after every integration. Early signal: a branch changes more than 80 lines in shared files at M1, then PROD reviews before merging. | PROD |
| R5 | Scope creep: 24 F-P0 items, reviewers adding wishes each loop | H | H | P0 list frozen to GDD 5; findings must cite a rule; ideas to BACKLOG; stall rule. Cut order to propose to LUCA if M4 stalls: PAD HOP and SLALOM drills, weekly delta on skill bars, the "FLIES LIKE" line, the Signal ceiling sheet visual (damage stays). | PROD |
| R6 | Onboarding fails first time players: wrong prompt order or wording per device, no Bolt before 1:00, too much text on a phone | M | H | Prompts as one data table; wiped profile run on every row every loop; 5 real first time testers with an observation sheet (time to first ring, Bolt, first knockout, alive at 2:00, tapped PLAY AGAIN); LUCA recruits them now. | DES, GE-R, LUCA |
| R7 | RC7 input regressions: resting axes read as input, triggers or aux axis clash, device flipping between touch and rc, button reach | M | H | `rc7.mjs` on every merge; any change to input detection needs a green R1 run; LUCA on the real RC7 at end of M4 and at M5. Two earlier QA rounds already fixed RC7 issues, so treat any R1 failure as P0. | GE-R, QA |
| R8 | Storage or cache collision with the live game on the shared origin droneshine.github.io | L | H | Prefixes `droneon2.`, IndexedDB `droneon2`, caches `droneon2-` (the live worker only deletes `droneon-` caches); new code uses `getLS` and `setLS`; a raw `localStorage.setItem` outside `store.ts` and `input.ts` is a P0 finding; `isolation.mjs` every loop. | PROD, QA |
| R9 | Copy rule violations: dashes, minus signs on damage or penalty numbers, "kill" wording, a transmitter's brand name in a device hint | H | M | `copylint.mjs` and a source grep every loop; one number formatter that never prints a minus (penalties read "10 PENALTY"); DES owns all strings. | DES, QA |
| R10 | Netcode spec drift delays M3: NETCODE.md missing, protocol numbers are placeholders, section 6 open | H | H | Decide section 6 now; gameplay numbers in one pure tuning file that host, guests and server import; solo built through the loopback director from M1; M3 starts only with protocol v1.1 merged. | SRV, GE-R, PROD |

Watch list: Spielwiese regressions from durable mode or the rail rewrite (missions rig and `mptest` every merge); stale builds from the service worker or Pages cache (stamp check before every review); ART.md budgets late (M1 exit item).

---

## 4. Go/no go checklist (release candidate)

Every line ticked on the `rc` stamp, or waived in writing (P0 only by LUCA).

**A. GDD F-P0 acceptance**
- [ ] 1 Menu tap on PLAY to controllable drone at GO in 10 s or less on a mid range phone, network off.
- [ ] 2 20 headless bot only matches each end with one winner between 5:00 and 6:30.
- [ ] 3 Evolve at 15 m/s in GPS, Angle, Acro: altitude change under 1 m, no crash, no console error.
- [ ] 4 Each tier identifiable by silhouette at 60 m; evolve VFX 1 s or less; models within the ART.md phone budget.
- [ ] 5 Royale: no crash while integrity is above 0 except water and blade; Spielwiese crash behaviour unchanged in all 8 missions.
- [ ] 6 All rings of 6.6 placed with 1.5 m clearance or more; pass detection at 35 m/s; personal rings dim only for the collector.
- [ ] 7 120 live projectiles: 60 fps desktop, 30 fps or more on a mid phone; assist cones match 6.9.
- [ ] 8 Bolt jet pushes a GPS Spark 5 m or more in 1.5 s, a GPS Nova drifts under 1 m; scramble exact; lake skim refills.
- [ ] 9 Every cause of 2.6 gives the right feed line; credit within 10 s works for wall, water and Static finishes.
- [ ] 10 Matches follow 6.7 within 0.5 s on every screen in a room; final centres never over water.
- [ ] 11 11 bots cost 3 ms per frame or less on a mid phone; hover only human survives 90 s in Rookie mix in 80 % of runs; scenery crashes under 1 per match.
- [ ] 12 An auto landed empty drone recharges and takes off again; solar 4 % per s verified.
- [ ] 13 2 desktops and 2 phones finish a match with identical alive counts, feed and winner.
- [ ] 14 No HUD overlap at 375 x 812, 812 x 375, 960 x 600, 1920 x 1080.
- [ ] 15 Results to next GO 8 s or less; XP lines sum correctly; unlock shown when earned.
- [ ] 16 A full match playable with CLASSIC, SHOOTER, gamepad, touch and RC7; every action reachable on touch and RC7.
- [ ] 17 All 3.5 prompts fire once per profile in order; 5 first time testers all evolve before 1:00.
- [ ] 18 XP from Royale, drills and missions saved under `droneon2.`; levels and unlocks survive reload.
- [ ] 19 Every combat event has a sound; no clipping with 12 drones.
- [ ] 20 Each drill playable on all inputs; medal thresholds from 6.14; best and last 10 saved.
- [ ] 21 Skill bars update after each drill; weekly delta shown.
- [ ] 22 Every part combination yields a valid spec; T/W under 1.5 cannot be saved; saved drones fly in free flight and squads.
- [ ] 23 Six rail commands; all sheets reachable on touch, RC7 and pad.
- [ ] 24 Full Royale: 60 fps desktop, 30 fps or more on a mid phone, zero console errors in a QA round.

**B. Stability**
- [ ] Zero console errors and unhandled rejections over the full matrix on the rc stamp.
- [ ] Five Royale matches in a row, then menu, then free flight: no heap growth above 50 MB, `renderer.info` back to baseline within 5 %.
- [ ] 30 minute soak alternating Royale and Academy without a crash; WebGL context loss recovers.
- [ ] Tab hidden and shown mid match: solo pauses cleanly; a rooms guest resyncs within 2 s.
- [ ] Storage blocked (private window): the game still runs.
- [ ] Offline second launch works (service worker).

**C. Performance** (tolerances of 2.5)
- [ ] D1 full Royale at 60 fps; P1 throttled and the real mid phone at 30 fps or more; RC7 at 30 fps or more.
- [ ] Match load 3 s or less; first load size recorded and no more than 25 % above the live game without PROD's OK.

**D. Accessibility basics**
- [ ] Every action reachable by keyboard, pad, touch and RC7; visible focus in menus; Esc and Back close sheets.
- [ ] Touch targets 44 px or more in menus, combat buttons 60 to 72 px as GDD 2.9.
- [ ] HUD and menu text contrast 4.5 to 1 or better against the scene (backing or shadow where needed).
- [ ] Ring kinds and tiers tell apart in a greyscale screenshot, not by colour alone.
- [ ] No full screen flash faster than 3 per second; mute or volume reachable in one step; no information only by sound.

**E. Brand, copy, tone**
- [ ] Copy lint clean: no -, –, — in any visible string, numbers included; ranges read "to" or "bis".
- [ ] No "kill" and no third party drone brand names in visible copy; PEGI 7 content only.
- [ ] Brand palette and fonts only (Audiowide or Nasalization for numbers and commands, Inter for text).

**F. Live game untouched and isolated**
- [ ] `git ls-remote https://github.com/droneshine/drone-on main` equals the recorded baseline; `droneshine-playground` clean at it; no push to `origin` from any worktree.
- [ ] droneshine.github.io/drone-on loads and plays as before.
- [ ] `isolation.mjs`: seeded live keys `droneon.*`, IndexedDB `droneon` and caches `droneon-*` byte identical after a full next session; next writes only `droneon2.*`, `droneon2`, `droneon2-*`.
- [ ] Rooms never cross: app id `droneon-next-by-droneshine`.

**G. Release mechanics**
- [ ] tsc zero errors; `npm run build` green; Pages workflow green with `BASE=/drone-on-next/`; stamp in Settings equals the `rc` tag.
- [ ] No runtime request to `server/` or any new host; `node server/selftest.mjs` green.
- [ ] BACKLOG holds every open P2 and waiver; RC notes at the end of the last loop file.
- [ ] LUCA says go.

---

## 5. Backlog

`studio/BACKLOG.md` holds GDD F-P1 and F-P2 features, P2 findings from the loops, and ideas. Format and seed are in that file. PROD triages it at the end of every loop; nothing in it blocks M4 or M5.

---

## 6. Where GDD, NETCODE.md and the protocol disagree

NETCODE.md does not exist yet; this compares GDD with `src/net/royaleProtocol.ts` and `server/index.mjs` as of 03.10.2026. The protocol itself says its numbers are "netcode defaults until the Game Designer's table lands". The GDD wins on game rules; the protocol wins on wire mechanics where a GDD rule would be technically unsound.

| # | Topic | GDD | Protocol now | Resolution and why |
|---|---|---|---|---|
| D1 | PULSE numbers | Per tier (6.2): 4 to 7 shots per s, 110 to 140 m/s, 60 to 90 m, 7 to 10 damage, target sphere 0.67 to 0.97 m | One table: 220 ms cooldown, 110 m/s, 240 m range, 10 damage, projectile radius 0.5 plus target 0.6 | GDD. As is, the host denies legal Storm and Nova shots (`checkFire` floor 187 ms, Nova fires every 143 ms) and accepts 240 m hits. Protocol checks take the rule as a parameter, looked up by the shooter's tier; projectile radius 0, the tier sphere as target radius, keep the lag slack. |
| D2 | Water jet | Held 22 m stream, 5° cone, 0.1 s ticks, 2 damage, push 12, 18, 26 N by tier, tank as payload | Ballistic projectile: 38 m/s, gravity, 55 m, 3 damage, 90 ms | GDD. Jet on and off claims plus per tick hit claims checked for 22 m, cone and line of sight; push sent as `fx` `knock` with a force field (or derived from the source tier); the tank stays local to the pilot. |
| D3 | Abilities | EMP 16 s, 15 m, 20 damage, 1.5 s scramble; NOVA BURST 14 s, 20 m, 28, 2.0 s; both 0.35 s charge; BOOST 2.0 s, 7 s; shield only as Nova P1 | `emp` 15 s, 22 m, 15, 1.2 s; `boost` 8 s, 2.5 s; standalone `shield` 20 s; no Nova Burst, no charge | GDD. Ability ids `emp`, `nova`, `boost`; drop the standalone shield (keep the shield field and flag for the P1 Nova shield); the host applies the effect at charge end. |
| D4 | Progression | 4 tiers through Shine; pickups: personal Shine rings, Big Shine, Charge, Repair, Shine cache; Shine drives tie breaks, cache size, results, lane bonus | `MAX_TIER` 5; items `tier`, `shield`, `energy`, `repair`, `weapon`; no Shine anywhere | GDD. `MAX_TIER` 3 (numeric 0 spark to 3 nova is the tier id the GDD asks for, never a spec); item kinds `shine`, `bigshine`, `charge`, `repair`, `cache`; Shine in seat state and `got` events; the host owns Shine and evolution. The client starts the glow on its own ring pass and swaps the model on the host's `got`, so the round trip hides inside the 0.8 s evolve. Shared rings use ring pass checks, caches use proximity. |
| D5 | Signal | 6.7: centre (−60, −60), R0 420, closes at 5:45, Static 2, 4, 7, 11, 16, overtime 25, ceiling 120 to 45 with 10 s ramps, Static from 0:00, POI bias, last two centres on land | `defaultZone`: centre (0, 0), r 700, five closes over about 9 min, 1, 2, 4, 8, 15 per s, no ceiling, no overtime | GDD; the placeholder would also break #2 (matches end by 6:30). Zone phases gain hold start and ceiling, an overtime phase is added, the host generator implements 6.7. Only the host runs it: the schedule travels in `start`, so guests never re-derive it. |
| D6 | Causes | Feed needs pulse, water into lake, EMP or Nova Burst, ram, wall or ground, Static, turbine | `pulse`, `water`, `emp`, `zone`, `crash`, `bump`, `left` | GDD. Causes `pulse`, `jet`, `lake`, `emp`, `nova`, `ram`, `ground`, `static`, `blade`, `left`; copy mapped on the client from the 2.6 table. |
| D7 | Impacts and rams | Durable mode: nothing crashes but water and blade; world 6 x (v − 4), trees 3 x (v − 5); rams 5 x own dv, cap 150, none under 3 m/s, pair cooldown 0.3 s | `crash` claim with only an impact speed, sent after the flight model crashed; no surface, no ram claim | GDD. `impact` claim with surface (ground, hard, glass, panel, tree, water, blade) and speed; `ram` claim with the other seat and dv; the host applies 6.4. Self reported impacts are a known P2P trust gap, written down in NETCODE.md for the server phase. |
| D8 | Host leaves | F-P0: the match ends for everyone with results, "HOST LEFT. MATCH ENDED"; migration is F-P1 (#29) | Full takeover built: terms, successor rule, 2 s silence, autopilot seats | GDD this cycle. Keep `ep` and `seq` on the wire (free, forward compatible) but ship no takeover path in the client; migration goes to BACKLOG B-010. Why: takeover means moving 11 bot brains and match state to a guest mid match, the riskiest path in M3, and the definition of done does not need it. |
| D9 | Guest drops | Silent | Autopilot holds the seat, 60 s reclaim with a token | PROD ruling: a dropped guest is knocked out after 5 s with cause `left`, no credit, drops a cache; reclaim and autopilot to BACKLOG B-022. Simplest correct behaviour. |
| D10 | Event volume | Rates of 6.2 and 6.3: a 12 drone finale produces damage, knock and got events well above 80 per s | One event per message; receivers rate limit the host at 80 per s, burst 160 | Protocol mechanics must change, GDD stays. One `re` message per host tick (20 Hz) carrying an ordered array of events; limits count messages. Otherwise verdicts drop in exactly the fights that matter and every screen falls into full syncs. |
| D11 | Stream rates | Ring pass at 35 m/s (#6); spectate follows the knocker anywhere (2.6) | Pilots beyond 350 m from a receiver send 5 Hz, the host included; bots at 10 Hz | GDD. Always full rate to the host and to anyone spectating you (spectators announce their target); bots at 20 Hz within 150 m of a human. At 5 Hz a 35 m/s drone moves 7 m between samples, too coarse for ring and hit checks. |
| D12 | Battery and tank | The pilot's own sim `soc` and tank | Not in the pilot stream; the host snapshot carries `energy` | Append `soc` and tank to the pilot state (the validator already accepts longer arrays); the snapshot mirrors them for spectators only. |

Also noted for the server phase (BACKLOG B-023): the server matchmaker waits `FILL_MS` 20 s before bots fill, which breaks "ten seconds to fun"; it must start in 5 s or less. Viewports: GDD #14 names 375 x 812 and 812 x 375, the loop matrix adds 390 x 844 and 844 x 390; both run (row P3).

**Decisions needed from the production lead now**
1. D8: host leaving ends the match this cycle, and the client gets no takeover code, although the protocol already has it.
2. D1 to D5: the protocol owns no gameplay numbers. One pure tuning file from GDD 6, owned by GE-R in `src/royale` and written with no imports so the server can load it, feeds the host checks. Tell GE-R today, before the numbers get hardcoded in the Royale branch.
3. D10: event batching goes into protocol v1.1 before M3.
4. M2 step 0: SRV commits the protocol and server on `next` now and GE-R merges `next`, so the solo director can be built around claims in and verdicts out from day one.
