# Who owns what, and how we merge

Production lead merges every branch into `next` and deploys to droneshine.github.io/drone-on-next. Nobody pushes, deploys or touches the live game (`C:\Users\lucam\droneshine-playground`, repo droneshine/drone-on).

| Role | Worktree | Branch | Dev port | Owns (free to change) |
|---|---|---|---|---|
| Royale programmer | `C:\Users\lucam\dsn-royale` | `next-royale` | 5301 | `src/royale/**` (mode, director, tiers, rings, combat, Signal logic, bots, HUD DOM and `src/royale/royale.css`), `src/royale/index.ts` install hook |
| Spielwiese programmer | `C:\Users\lucam\dsn-meta` | `next-meta` | 5302 | `src/meta/**` (progression, pilot profile), `src/academy/**` (drills), `src/workshop/**` (parts builder), `src/meta/index.ts` install hook, the rail restructure in `src/ui/ui.ts` |
| Art and Animation | `C:\Users\lucam\dsn-art` | `next-art` | 5303 | `src/art/**` except `contracts.ts` (tier models registered in `src/art/register.ts`, FX, Signal look, screen overlays, `src/art/sfx.ts` sounds), `studio/ART.md` |
| Server Consultant | `C:\Users\lucam\droneshine-next` | `next` | none | `src/net/royaleProtocol.ts`, `server/**`, `studio/NETCODE.md` |

**Shared files** (`src/game/game.ts`, `src/ui/ui.ts`, `src/ui/style.css`, `src/main.ts`, `src/sim/drone.ts`, `src/sim/spec.ts`, `src/net/multiplayer.ts`, `src/render/droneModels.ts`, `src/audio/audio.ts`): change them only where your feature truly needs a hook, keep the change small and in one place, and say in a comment what it is for. Never reformat or reorder code you do not own. That keeps merges clean.

**Contracts** (change only with the production lead): `src/art/contracts.ts` (gameplay to art), `src/meta/progression.ts` exported API (everyone calls `awardXp`, `firstTime`, `pilotRating`), `src/ui/ui.ts` `registerSheet(id, title, render)`, `src/render/droneModels.ts` `modelRegistry`.

**Rules for every change**
- `npx tsc --noEmit -p .` at zero errors before you report.
- Test in a real browser with the headless Edge rigs in `tools/` (puppeteer-core is in node_modules) on your own dev port: `npx vite --port 53xx --strictPort` started in the background from your worktree. Look at screenshots before you judge anything visual. Zero console errors.
- Desktop, phone (390 x 844 and 844 x 390 with touch) and the RC7 (960 x 600 touch) for anything with UI.
- Visible copy: no dashes (-, –, —). Brand palette and fonts from BRIEF.md.
- Commit on your branch with clear messages ending in `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Do not push.
- Spielwiese behaviour that already works must keep working (free flight, missions, build, squad).
