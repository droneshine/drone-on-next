# DRONE ON

**A free drone flight simulator sandbox by [DroneShine](https://droneshine.de).**
It runs in the browser on desktop and phone and installs as an app.

DRONE ON is a Spielwiese for pilots. You fly the real industrial drones we operate every week, you train the missions we fly for customers, and you build your own course and share it with a link. You can also upload your own drone and fly it at real scale next to ours.

## What is in it

**Real flight physics**
- Every motor has its own thrust and spool lag.
- Power draw follows momentum theory, and the battery sags under load.
- Rotor drag, ground effect and gusting wind all act on the drone.
- Three flight modes, just like real flight controllers:
  - **GPS hold** releases the sticks and the drone stays put.
  - **Angle** levels itself.
  - **Acro** gives you Betaflight rates, with no help at all.

**Featured drones**

| Drone | What it is |
| --- | --- |
| DSolar | Solar park cleaning platform with a 50 L tank and four big drives |
| DShine | Facade and glass cleaner on a 50 m ground hose. The hose sags and pulls on the drone. |
| DScan | Our in house thermal inspection prototype |
| Shine 5 | 5 inch freestyle quad |
| Cine 8 | Coaxial X8 cinema lifter |

**Training missions**
- First Flight
- Line of Sight
- Ring Run
- Gust Front
- Solar Shift: clean a soiled PV park
- Facade Pro: clean a facade on a tether
- Hotspot Hunt: find module faults on the thermal camera
- Turbine Run: battery planning out to a wind turbine and back

**Build mode**
- Fortnite Creative style placement of rings, gates, ramps, containers, solar tables and trees.
- Rings and gates become a timed race in the order you place them.
- Share any map as a link, or export it as a file.

**Upload your drone**
- Drop in a GLB or GLTF model and set mass, arm length, props, thrust, battery, rates and tool.
- The hangar shows thrust to weight and calculated hover time live, and the drone on the pad updates as you type.
- Export it as a `.droneon.json` file and share it.

**Every controller**
- Keyboard and mouse.
- Gamepads.
- USB RC transmitters (EdgeTX, OpenTX, ELRS, DJI), with channel mapping and calibration.
- Touch.
- An on-screen dual joystick you drag with the mouse or a finger (key **J**).

**The world**
- Rolling terrain, about 2,400 PV modules each with its own soiling map, and an office block with a live grime map on its facade.
- A freestyle park with a bando and a crane, a lake, a forest of about 2,000 trees, and a turning wind turbine.
- GPU grass that bends in the rotor wash.
- Four times of day and a thermal camera mode.

## Play

The live version is published with GitHub Pages from `main`. To run it locally:

```bash
npm install
npm run dev
```

Then open http://localhost:5190.

## Controls

| Input | Action |
| --- | --- |
| W S | Throttle. In GPS mode, hold W to climb and release to hover |
| A D | Yaw |
| Arrow keys or I J K L | Pitch and roll |
| Space | Spray (DSolar, DShine) |
| Q E | Gimbal or lance tilt |
| M | Flight mode |
| C | Camera: chase, FPV, line of sight |
| H, F | Thermal camera, tag hotspot (DScan) |
| J | On-screen joystick |
| R | Reset |
| Esc | Pause |

Gamepad: the left stick is throttle and yaw, the right stick is pitch and roll. A sprays, X tags, Y switches to thermal, LB changes mode and RB changes camera.

## Add your drone for everyone

1. In the hangar, build your drone and press **Export file**.
2. Put the file in `public/community/` and add an entry to `public/community/index.json`.
3. Open a pull request. Models that embed a GLB should stay under 10 MB.

See [CONTRIBUTING.md](CONTRIBUTING.md).

## Tech

Three.js, TypeScript and Vite. There is no game engine and no backend. The physics, collisions (signed distance fields on a hash grid), audio (all synthesized) and particles are written from scratch in `src/`.

| Folder | Contents |
| --- | --- |
| `src/sim` | Drone specs and the flight model |
| `src/world` | Terrain, solar park, facade, props, grass, colliders |
| `src/render` | Drone models and effects |
| `src/game` | Game loop, missions, build mode, storage |
| `src/ui` | Menus, HUD, hangar, settings |
| `src/input` | Keyboard, gamepad, RC transmitter, touch |

## License

The code is MIT. The DroneShine name, logo and the DSolar, DShine and DScan designs are DroneShine trademarks and are not covered by the license. See [LICENSE](LICENSE).
