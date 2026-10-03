# DRONE ON Next: backlog

Owner: production lead. Everything that is not a P0 or P1 finding of the current loop lives here: GDD feature priority P1 and P2 (F-P1, F-P2), P2 findings from the review loops, technical follow ups and ideas. Nothing in this file blocks M4 or M5 (see `PRODUCTION.md`). PROD triages it at the end of every loop. Longer term roadmap items stay in GDD 2.15 and 4 and are not copied here.

## Format

One table row per item.

| Field | Values |
|---|---|
| ID | `B-nnn`, never reused |
| Kind | `feature` (from the GDD), `finding` (P2 from a loop, keep the loop ID), `tech` (engineering follow up), `idea` (new proposal, never P0 or P1 this cycle) |
| Pri | `F-P1`, `F-P2` for features and tech; `P2` for findings; `idea` |
| Title | short, what the player or the team gets |
| Source | GDD section or # in section 5, loop finding ID, or `PRODUCTION 6 Dn` |
| Owner | GE-R, GE-M, ART, SRV, DES, PROD |
| Acceptance or note | the GDD acceptance criterion where one exists, else what done means |
| Status | `open`, `planned <cycle>`, `in progress`, `done <commit>`, `dropped <reason>` |

## Features and tech from GDD section 5 and PRODUCTION section 6

| ID | Kind | Pri | Title | Source | Owner | Acceptance or note | Status |
|---|---|---|---|---|---|---|---|
| B-001 | feature | F-P1 | Ghosts for drills | #25, GDD 3.2 | GE-M | Best run replays in sync within 0.1 s; recorded at 20 Hz (position, rotation, motor); optional studio "GOLD GHOST" per drill | open |
| B-002 | feature | F-P1 | Daily challenge and streak | #26, GDD 3.2, 6.13 | GE-M, DES | Same seed gives the same layout on any device that day (UTC date seed); "DAILY STREAK"; share text; 150 XP first completion, +50 for Gold or better | open |
| B-003 | feature | F-P1 | Nova shield | #27, GDD 2.15, 6.3 | GE-R | NOVA BURST also gives a 50 point shield for 3 s; protocol keeps the shield field and flag for it | open |
| B-004 | feature | F-P1 | Rookie reboot | #27, GDD 2.15 | GE-R | One respawn as Spark before 2:30 in the first 3 matches | open |
| B-005 | feature | F-P1 | First win of the day | #27, GDD 6.13 | GE-R, GE-M | +200 XP on the first Royale win per UTC day | open |
| B-006 | feature | F-P1 | Paint and LEDs carried into Royale | #28, GDD 3.4 | GE-R, ART | Equipped Workshop paint and LED colour are the Royale paint; visible to others in rooms | open |
| B-007 | feature | F-P1 | Workshop parts gated by pilot level | #28, GDD 3.4, 6.15 | GE-M | Parts unlock at the levels of 6.15; this cycle everything at level 1 is open | open |
| B-008 | feature | F-P1 | Room options: bots on or off, difficulty | #29, GDD 2.13 | GE-R, SRV | Host can turn bot fill off and pick the bot difficulty | open |
| B-009 | feature | F-P1 | RC aux channel binding in Settings | #29, GDD 2.9 | GE-R | Fire can be bound to any aux axis or switch; default stays axis 5 | open |
| B-010 | feature | F-P1 | Host migration in Royale rooms | #29, PRODUCTION 6 D8 | SRV, GE-R | Host leaving mid match hands over without ending it; protocol v1 already has terms, succession rule and full sync; needs bot brains and match state to move to the new host | open |
| B-011 | feature | F-P1 | Pick your launch point during the intro | #30, GDD 2.15 | GE-R | Player picks a slot on the map during the launch intro | open |
| B-012 | feature | F-P1 | Seeded challenge links | #30, GDD 2.15 | GE-R | "Beat my #2 on this exact match": a link carries the seed | open |
| B-013 | feature | F-P1 | DOGFIGHT drill | #30, GDD 3.1 | GE-M | Spark against one Pilot bot in a 60 m sphere, best of 3; score rounds won, then time | open |
| B-014 | feature | F-P1 | Feats with titles | #30, GDD 3.3 | GE-M, DES | "SPARK OF GENIUS", "MAKING WAVES", "SUN POWERED" give titles regardless of level | open |
| B-015 | feature | F-P2 | Clips: "SHARE CLIP" of the last 15 s | #31, GDD 4 | GE-R | Auto detected highlight (water knockout, win, ram knockout), canvas capture; needs a phone performance check first | open |
| B-016 | feature | F-P2 | Duos and trios | #31, GDD 2.15 | GE-R, SRV | Shared Signal pings, revive by hovering 3 s over a knocked teammate | open |
| B-017 | feature | F-P2 | Daily orders | #31, GDD 4 | GE-M, DES | Three daily tasks, +100 XP each | open |
| B-018 | feature | F-P2 | Course browser with ratings | #31, GDD 4 | GE-M, SRV | Needs a server | open |
| B-019 | feature | F-P2 | Leaderboards | #31, GDD 3.2 | SRV | Global daily challenge boards; needs a server | open |
| B-020 | feature | F-P2 | Anonymous analytics counter | #31, GDD 4 | SRV | Match started, match finished, day 1 and day 7 return; no personal data; next cycle, fly blind for one cycle at most | open |
| B-021 | feature | F-P2 | "GARAGE ROYALE" in private rooms | GDD 3.4 | GE-R, DES | Workshop drones normalised into tier envelopes | open |
| B-022 | tech | F-P1 | Guest seat reclaim and autopilot | PRODUCTION 6 D9 | SRV, GE-R | This cycle a dropped guest is knocked out after 5 s with cause `left`; later the protocol's autopilot and 60 s token reclaim | open |
| B-023 | tech | F-P2 | Server matchmaking fills with bots fast | PRODUCTION 6 | SRV | `server/index.mjs` waits `FILL_MS` 20 s; must start in 5 s or less to keep "ten seconds to fun" | open |
| B-024 | tech | F-P2 | TURN relay for rooms behind strict NAT | PRODUCTION 3 R3 | SRV | Only with Luca's OK (new external service); measure the share of failed joins first | open |

## P2 findings from the review loops

PROD moves P2 findings here at triage, keeping the loop ID in Source. Example of a row:

| ID | Kind | Pri | Title | Source | Owner | Acceptance or note | Status |
|---|---|---|---|---|---|---|---|
| B-1nn | finding | P2 | (title as in the loop file) | L02-A04 | ART | (expected behaviour from the finding) | open |

## Ideas

New proposals from any role. An idea never becomes P0 or P1 this cycle; DES and PROD review the list when the next cycle is planned.

| ID | Kind | Pri | Title | Source | Owner | Acceptance or note | Status |
|---|---|---|---|---|---|---|---|
