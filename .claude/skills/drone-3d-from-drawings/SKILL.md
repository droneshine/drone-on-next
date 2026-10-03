---
name: drone-3d-from-drawings
description: Rebuild a real drone as a dimension-true 3D model (Three.js, DRONE ON) from spec sheets, dimension drawings or photos, and prove the match with orthographic renders and measured extents. Use when someone shares technical drawings, datasheets or photos of a drone and wants it in the game or rendered in 3D.
---

# Drone 3D from drawings

The goal is a model whose silhouette and key dimensions match the source within 2 %. It also needs flight numbers that reproduce the published endurance. Looking right is not enough. It has to be measured.

## 1. Extract a dimension table first

Read every source before you model anything, and write one table in metres:

| Key | Where to find it | Used for |
| --- | --- | --- |
| Wheelbase (motor to motor, diagonal) | top view, "wheelbase" or 轴距 | `armLength = wheelbase / 2` |
| Prop diameter | prop circle in top view, or `span = wheelbase/√2 + D` | `propDiameter` |
| Overall span with props | top view outer dimension | check value |
| Expanded frame size | spec table 展开尺寸 | body and arm proportions |
| Total height | front or side view, outermost arrow | check value |
| Arm plane height above ground | side view arrow from ground to arm tube | `legHeight()` in `src/sim/drone.ts` |
| Lowest point (tank, pump, nozzle) | side view small arrow from the ground | tank and pump placement |
| Gear track, front and side | arrows at ground level | skid positions |
| Empty mass, battery mass, payload, MTOW | spec table 整机重量 / 载重 / 起飞重量 | `mass` = frame plus batteries, `tank` = payload in litres |
| Battery | cells × Ah × pack count (packs in parallel at the same voltage) | `battery` |
| Motor type | 电机 | `maxThrust` (gives T/W 1.4 to 1.7 at MTOW for ag frames) |
| Climb, cruise, endurance empty and full | flight table | `maxClimb`, `maxSpeed`, validation |

When numbers disagree (for example a "1800 × 1800" frame versus a 2300 diagonal wheelbase), trust the wheelbase for motor positions. Treat the frame size as an outer extent that includes the motor pods.

Chinese spec sheets are common. 展开 is unfolded, 折叠 is folded, 轴距 is wheelbase, 续航 is endurance, 空载 is empty, 满载 is full load.

## 2. Validate the numbers with the flight model before modelling

Hover power from momentum theory, as `src/sim/drone.ts` uses it:
`P = n · T^1.5 / sqrt(2 ρ A) / η`, with `T = m g / n`, `A = π (D/2)²` and `η = 0.35 + 0.25 · min(1, D / 0.8)`.
Endurance is `0.85 · cells · 3.7 · Ah / P`. Check it for empty and full load against the datasheet. Within 20 % is fine. If it is further off, the mass split or the battery count is wrong.

## 3. Build the model parametrically

- Use one builder function per aircraft (see `src/render/dsolarModels.ts`). Origin is the arm plane centre, forward is −z, and the ground sits at −legHeight.
- Every number in the builder comes from the table. Put the source dimensions in a comment at the top of the file.
- Reuse the shared parts: `arm()` (tube, fold joints, motor can, ESC pod, nozzle), `canopy()`, `tank()` and `smoothTube()` from `src/render/dsolarModels.ts`, plus `addProps()`, `ledPair()`, `tube()`, `cyl()`, `bx()` and `mats` from `src/render/droneModels.ts`.
- Arms start where the real frame starts. That can be the chassis corners rather than the centre (the DSolar MT50 is like this).
- Gear: U-hoops are one `CatmullRomCurve3` tube per side. Splayed legs are straight tubes to the track width from the drawing.
- Brand rule: only the DroneShine brand appears on the model. OEM names stay out of geometry, textures and taglines.

## 4. Prove it

Run the orthographic rig against the dev server:

```bash
(echo "window.__drone='<id>';"; cat tools/ortho.js) > /tmp/o.js
node tools/shot.mjs http://localhost:5190/ out.png 1800 640 /tmp/o.js 300
```

It prints the measured `sizeMM` (x, y, z) and `topMM` and `bottomMM`, and renders the top, front and side views with prop circles and a 100 mm grid. Compare these with the drawing:
- Span with props within 1 %.
- Total height and arm plane height within 2 %.
- Lowest point matches.
- The silhouette of every view reads like the drawing: legs, tank, canopy.

Fix the builder, then re-measure. Two rounds is normal.

## 5. Prove it flies

Use the trace script pattern from `tools/`: spawn at 5 m, hold forward stick and log altitude, pitch and motor speeds every 200 ms. It passes when the pitch settles at `maxTilt` without overshooting past 1.2 × `maxTilt`, and the altitude holds within 0.3 m. Slow motors (large `motorTau`) need the cascade rule in `drone.ts`, where each outer loop runs slower than the one inside it.

## 6. Ship

Add it to `FEATURED` in `src/sim/spec.ts`. Use `featured('<id>')` lookups and never array indices. Then typecheck, commit with the source dimensions in the message, and push. Pages deploys on its own.
