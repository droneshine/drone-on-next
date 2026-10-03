# DRONE ON in VR (Meta Quest)

Branch `next-vr`. Code in `src/xr/`, test rig `tools/xrtest.mjs`.

## How to play on a Quest

1. Put the headset on, open the **Quest Browser** and go to the game link (droneshine.github.io/drone-on-next once this branch is merged and deployed). WebXR needs HTTPS: a plain `http://192.168...` address from a laptop does **not** offer VR. For a local build use `adb reverse tcp:5304 tcp:5304` with the Quest on USB (developer mode) and open `http://localhost:5304`.
2. In the main menu press **ENTER VR** (right under FLY). During a flight it is also in the pause menu as **Enter VR**. The entry only appears where the browser can open an immersive VR session, so desktops without a headset and phones never see it.
3. If the Quest asks for permission to use VR, allow it. The game starts free flight (or keeps the flight or mission you paused) and you stand on the field.
4. To leave: press the Meta button on the right controller and choose to exit or quit the immersive view. The flat game comes back exactly as it was.

Add `#xrstats` to the link to see frame rate, draw calls, CPU time per frame and the quality step on the HUD panel.

## The two views

**PILOT** (start view). You stand a few metres behind the take off spot, a step to the side, facing it, at real 1:1 scale, like a line of sight pilot. Only your own head moves the view. The HUD hangs above your left controller and always turns to face you. The drone has a soft contact shadow right below it, which helps judging height.

**GOGGLES**. A dark room with a faint floor grid and a large screen fixed to your head, like FPV goggles. The screen shows the drone camera (FPV or chase) as a flat picture, so your head never moves inside the drone. The HUD sits under the screen. DScan's thermal camera works here.

Switching views fades to black and back in about a third of a second.

## Controls (Touch controllers, mode 2)

| Control | Action |
|---|---|
| Left thumbstick up and down | Throttle. In GPS mode the centre holds altitude: push up to arm and climb, let go to hover |
| Left thumbstick left and right | Yaw |
| Right thumbstick | Pitch and roll |
| Right trigger (hold) | Spray (spray drones) |
| Right grip | Tag a hotspot (thermal missions) |
| A | Flight mode: GPS, Angle, Acro |
| B | Reset the drone to the take off spot. After a mission result: fly it again |
| X | Switch view: PILOT or GOGGLES |
| Left trigger | Camera: FPV or chase on the goggles screen (from PILOT it opens GOGGLES) |
| Left grip | Thermal on or off (GOGGLES only, DScan) |
| Y | Recenter: back on the pilot spot, facing the take off spot |
| Meta button | Quest menu. The game holds while it is open and continues when you return |

Arming in Angle or Acro: left stick fully down, then up, like a real transmitter. Landing: hold the left stick down until the motors stop.

A Bluetooth gamepad paired with the Quest also works in VR: move one of its sticks and it takes over, move a thumbstick on the Touch controllers and they take over again. Its buttons work as on the desktop (A spray, LB mode, RB camera, Back reset, Start pause).

## What VR changes, and why (performance budget)

Target: 72 fps on Quest 2, better on Quest 3. Quest 2 has 13.9 ms per frame for both eyes, a phone class CPU, and three.js draws every object once per eye (WebGLRenderer has no multiview). The flat game's extras are reduced only while in VR and restored on exit:

| | Flat game | VR |
|---|---|---|
| Post effects (bloom, clamp, thermal grain) | composer | none (the composer cannot draw into the headset). Thermal grain is done in the goggles screen shader |
| Sun shadows | rendered every frame, drone included | one snapshot of the static world around the pilot (around the drone in GOGGLES, refreshed when it has flown far), the drone gets a contact shadow instead. Saves about 220 draw calls a frame |
| Drone small parts | always drawn | in PILOT, parts under 6 % of the drone's size are left out when they would be a few pixels (34 to 93 parts per drone) |
| Grass | 75 m around the camera | same density, 16 m (Quest 2) or 24 m (Quest 3) around the pilot |
| Trees | all | half on Quest 2 |
| Clouds | two six octave noise layers | one three octave layer |
| Antialiasing | composer MSAA | 4x MSAA in the headset framebuffer, fixed foveation (full on Quest 2, half on Quest 3) |
| Resolution and frame rate | window size | Quest 2: recommended eye buffer (scale 1.0), 72 Hz. Quest 3: scale 1.2 for a sharper picture, and after the first seconds it asks for 90 Hz when the frame has room |

If frames still run long for two seconds, the game steps down on its own, in the order the eye misses least: back to 72 Hz, full foveation, no grass, fewer trees, more small drone parts left out, no clouds.

Measured on the studio laptop (Snapdragon X, Adreno X1 45 GPU) through the emulator, GPU work finished every frame:

| | Draw calls per frame | Triangles | GPU time |
|---|---|---|---|
| Flat game, composer, 1280 x 720 | about 260 + 220 shadow | | 2.8 to 5.6 ms |
| VR PILOT, Quest 2 profile, 2 x 1440 x 1584 | 170 to 190 | 0.8 M | 2.5 to 3.8 ms |
| VR PILOT, Quest 3 profile, 2 x 2016 x 2112 | 190 | 1.2 M | 2.7 to 3.6 ms |
| VR GOGGLES, both profiles | 60 to 140 | 0.3 to 0.6 M | 1.4 to 4.5 ms |

(The spread is the laptop GPU changing its clock between runs.)

The laptop GPU is roughly 1.5 to 2 times a Quest 2 GPU and below a Quest 3 GPU, so PILOT should land around 5 to 8 ms GPU on a Quest 2 including the MSAA resolve, inside 13.9 ms, and well inside 11.1 ms (90 Hz) on a Quest 3. The CPU is the tighter side: a VR frame costs 2 to 5 ms of main thread time on the laptop, and a Quest 2 core is about three to four times slower. That is why the draw call count was the main target. Only a real headset can confirm this.

## Known limits

* Not tested on a real headset yet: performance, comfort, reading distance of the HUD and stick feel are all to be judged on Monday.
* Menus, hangar, settings, build mode and the squad lobby stay on the flat screen. Going to the main menu or build mode ends VR. To pick another drone or mission: leave VR, choose, enter VR again.
* Missions run in VR (HUD shows the mission line, B restarts after a result), but have not been played through in VR. The Line of Sight mission keeps you in PILOT view.
* Squad (multiplayer) in VR is untested. The flight code is unchanged, so it should work.
* The controller models load from cdn.jsdelivr.net. Offline you fly without visible controllers, the HUD still floats where your left hand is.
* Gimbal tilt has no Touch controller binding (a Bluetooth gamepad's D pad works).
* Thermal look in GOGGLES only: from the pilot spot the field always looks normal.
* Phones do not get the VR entry, even where Chrome offers a Cardboard session.
* Turbine blades and other moving parts keep the shadow from the snapshot moment.

## Testing without a headset

`node tools/xrtest.mjs http://localhost:5304/ <outDir>` with the dev server running. It loads Meta's Immersive Web Emulation Runtime (IWER 2.5, fetched from jsdelivr, only in the test) into headless Edge, emulates a Quest 3 (and a Quest 2 for the light profile) with Touch controllers, and checks: entry visibility, entering and leaving VR repeatedly from both menus, flying with the emulated thumbsticks (arm, climb, hover, move, yaw, land), both views, the HUD, all buttons, recentering, the fade, thermal, the Quest menu pause, a gamepad taking over, spraying, a mission, the draw call budget, the flat render state after exit, and zero console errors. Screenshots land in the output folder.

## Monday: first test, 10 minutes

1. **Open** the link in the Quest Browser. Is **ENTER VR** under FLY? (If not: HTTPS? Quest Browser up to date?)
2. **Enter VR** from the main menu. Expect: black, then the field fades in, you stand behind the drone on its pad, controllers visible, HUD above the left controller. Note how long the black lasts.
3. **Look around** a full turn and walk a step. The world must stay perfectly still. Any swimming, judder or stutter? Is the drone where you expect it, at a believable size?
4. **Fly** in GPS: left stick up until it lifts, let go (it must hover), fly a circle around yourself with the right stick, yaw with the left. Does mode 2 feel right? Too sensitive, too dull, dead zone okay?
5. **Read the HUD**: battery, altitude, speed, mode. Readable without bringing the controller close?
6. **X** for GOGGLES: fade, dark room, screen with the chase camera. **Left trigger** for FPV. Any discomfort? Screen too big or too small? Back with **X**.
7. **A** to Angle, fly a bit, **A** twice back to GPS. **B** to reset. Walk two steps away, **Y**: back on the spot facing the drone?
8. **Land**: left stick down until the motors stop.
9. **Meta button**: the game must hold, and continue when you return. Then exit VR: the flat game must look and work as before (pause menu, HUD).
10. **Enter VR again** from the pause menu, once more, to confirm it works every time. Optional: open the link with `#xrstats` and note the fps in PILOT and GOGGLES, and try DSolar with the right trigger.

Please send back: comfort (any nausea), smoothness, HUD readability, stick feel, pilot distance to the pad, and anything that looked wrong.
