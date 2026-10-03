# Contributing to DRONE ON

Thank you for flying with us. The most welcome contributions are listed below.

## Community drones

1. Build your drone in the hangar (Hangar, then Upload a drone) and press **Export file**.
2. Copy the `.droneon.json` into `public/community/`.
3. Add the same object to the array in `public/community/index.json`.
4. Open a pull request with a screenshot of it flying.

Please use real numbers. Mass, thrust per motor and battery decide how it flies, and the hangar warns you if thrust to weight drops below 1.4. Embedded models must be your own work or carry a license that allows redistribution.

## Maps

Export a map from Build mode and add it to `public/community/maps/` with a pull request. Good maps have a start flag and at least six checkpoints.

## Code

Run the game with `npm install` and `npm run dev`. Run `npm run typecheck` before a pull request. Keep the physics in `src/sim` free of rendering code, so it can be tested on its own.
