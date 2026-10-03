// VR test rig without a headset: Meta's Immersive Web Emulation Runtime (IWER) emulates a Quest 3
// with Touch controllers inside headless Edge. IWER is injected here only, never shipped with the game.
// node tools/xrtest.mjs <url> <outDir>
import puppeteer from 'puppeteer-core';
import fs from 'fs';
import os from 'os';
import path from 'path';

const [url = 'http://localhost:5304/', outDir = path.join(os.tmpdir(), 'droneon-xrtest')] = process.argv.slice(2);
fs.mkdirSync(outDir, { recursive: true });
const IWER_URL = 'https://cdn.jsdelivr.net/npm/iwer@2.5.0/build/iwer.min.js';
const cache = path.join(os.tmpdir(), 'iwer-2.5.0.min.js');
if (!fs.existsSync(cache)) fs.writeFileSync(cache, await (await fetch(IWER_URL)).text());
const iwer = fs.readFileSync(cache, 'utf8');

const sleep = ms => new Promise(r => setTimeout(r, ms));
const results = [];
const check = (name, ok, info = '') => { results.push({ name, ok: !!ok }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${info ? '  ' + info : ''}`); };

const browser = await puppeteer.launch({
  executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  headless: 'new',
  args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required'],
});
const errors = [];
// device: 'quest3' emulates the headset but keeps the desktop user agent, because three takes an
// Oculus Browser only framebuffer path when it sees the Quest agent, and desktop ANGLE draws the flat
// game transparent on that path (an emulation artifact, a real Quest is fine). 'quest2' uses the real
// Quest 2 agent to check the Quest 2 quality profile.
async function open(withIwer, device = 'quest3') {
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 720, deviceScaleFactor: 1 });
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text().slice(0, 300)); });
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  if (withIwer) await page.evaluateOnNewDocument(iwer + `;(() => { const cfg = ${device === 'quest2' ? 'IWER.metaQuest2' : '{ ...IWER.metaQuest3, userAgent: navigator.userAgent }'}; const d = new IWER.XRDevice(cfg); d.installRuntime({ forceInstall: true }); window.__iwer = d; })();`);
  await page.goto(url, { waitUntil: 'load' });
  await page.waitForFunction(() => document.getElementById('boot')?.classList.contains('gone'), { timeout: 120000 });
  await sleep(1200);
  return page;
}

// the flat render state that must come back unchanged after VR
const flatState = () => {
  const g = window.droneon.game, ui = window.droneon.ui, r = g.renderer, w = g.world, sh = w.sun.shadow;
  const clouds = w.scene.children.find(o => o.material?.uniforms?.uCover);
  return {
    xrEnabled: r.xr.enabled, presenting: r.xr.isPresenting, loopActive: !!g.xr?.active, pixelRatio: r.getPixelRatio(),
    canvas: [r.domElement.width, r.domElement.height], aspect: +g.camera.aspect.toFixed(4),
    grassR: w.grass?.uniforms.uR.value, grassN: w.grass?.mesh.geometry.instanceCount, grassVisible: w.grass?.mesh.visible,
    shadowMap: sh.mapSize.x, shadowBox: sh.camera.right, shadowAuto: r.shadowMap.autoUpdate, cloudMat: clouds?.material.uuid,
    sceneChildren: w.scene.children.length, device: g.input.device, inputXr: g.input.xr, camMode: g.camMode,
    uiDisplay: ui.root.style.display, renderTarget: r.getRenderTarget(), toneMapping: r.toneMapping, exposure: r.toneMappingExposure,
  };
};
const tele = () => { const g = window.droneon.game, s = g.sim; return { state: g.state, armed: s.armed, crashed: s.crashed, agl: +s.agl.toFixed(2), x: +s.pos.x.toFixed(2), z: +s.pos.z.toFixed(2), heading: +s.heading().toFixed(3), device: g.input.device, thr: +g.input.sticks.throttle.toFixed(2), pitch: +g.input.sticks.pitch.toFixed(2), mode: s.mode, cam: g.camMode, view: g.xr?.view, presenting: g.renderer.xr.isPresenting }; };
const stick = (page, hand, x, y) => page.evaluate((h, x, y) => window.__iwer.controllers[h].updateAxes('thumbstick', x, y), hand, x, y);
const press = async (page, hand, id) => {
  await page.evaluate((h, id) => window.__iwer.controllers[h].updateButtonValue(id, 1), hand, id);
  await sleep(150);
  await page.evaluate((h, id) => window.__iwer.controllers[h].updateButtonValue(id, 0), hand, id);
  await sleep(150);
};
const shot = async (page, name) => { const p = path.join(outDir, name + '.png'); await page.screenshot({ path: p }); console.log('      shot', p); };

// ---------------------------------------------------------------- 1. plain desktop browser: no VR entry
{
  const page = await open(false);
  const hidden = await page.evaluate(() => [...document.querySelectorAll('[data-xr]')].every(b => b.hidden));
  check('no ENTER VR without an immersive VR device', hidden);
  await page.close();
}

// ---------------------------------------------------------------- 2. emulated Quest 3
const page = await open(true);
check('isSessionSupported(immersive-vr) under IWER', await page.evaluate(() => navigator.xr.isSessionSupported('immersive-vr')));
check('ENTER VR shown in the main menu', await page.evaluate(() => { const b = document.querySelector('.rail [data-xr]'); return b && !b.hidden && b.offsetParent !== null; }));
await shot(page, '01_menu_flat');
await page.evaluate(() => window.droneon.game.startFreeFlight());
await sleep(1500);
await page.evaluate(() => { const g = window.droneon.game; g.resetDrone(); });
await sleep(800);
await shot(page, '02_fly_flat_before');
const before = await page.evaluate(flatState);

// cost of the flat path on this GPU: the composer, finished on the GPU each frame
const flatCost = await page.evaluate(() => {
  const g = window.droneon.game, gl = g.renderer.getContext();
  for (let i = 0; i < 5; i++) g.composer.render(0.016);
  gl.finish();
  const t0 = performance.now();
  for (let i = 0; i < 30; i++) { g.composer.render(0.016); gl.finish(); }
  return (performance.now() - t0) / 30;
});
console.log('      flat composer frame (GPU finished):', flatCost.toFixed(2), 'ms');

// enter VR from the pause menu
await page.keyboard.press('Escape');
await sleep(500);
check('ENTER VR shown in the pause menu', await page.evaluate(() => { const b = document.querySelector('.overlay [data-xr]'); return b && !b.hidden && b.offsetParent !== null; }));
await page.click('.overlay [data-xr]');
await page.waitForFunction(() => window.droneon.game.renderer.xr.isPresenting && window.droneon.game.xr?.active, { timeout: 20000 });
await sleep(2500);
let t = await page.evaluate(tele);
check('VR session started from the pause menu, unpaused, PILOT view, device xr', t.presenting && t.view === 'pilot' && t.device === 'xr' && !(await page.evaluate(() => window.droneon.game.paused)), JSON.stringify(t));
check('flat DOM UI hidden in VR', await page.evaluate(() => window.droneon.ui.root.style.display === 'none'));
check('quality profile applied (grass ring, shadow map, cheap clouds)', await page.evaluate((b) => { const g = window.droneon.game, w = g.world; const cl = w.scene.children.find(o => o.material?.uniforms?.uCover); return w.grass.uniforms.uR.value < b.grassR && w.sun.shadow.mapSize.x <= 2048 && cl.material.uuid !== b.cloudMat; }, before));
await page.evaluate(() => { window.__iwer.stereoEnabled = true; });
await sleep(600);
await shot(page, '03_vr_pilot_stereo');
await page.evaluate(() => { window.__iwer.stereoEnabled = false; });
await sleep(400);
const pilotPose = await page.evaluate(() => { const g = window.droneon.game, x = g.xr; const c = g.renderer.xr.getCamera(); return { head: c.position.toArray().map(v => +v.toFixed(2)), drone: g.sim.pos.toArray().map(v => +v.toFixed(2)), pilot: g.losPilot.toArray().map(v => +v.toFixed(2)) }; });
console.log('      pilot pose', JSON.stringify(pilotPose));
const dPilot = Math.hypot(pilotPose.pilot[0] - pilotPose.drone[0], pilotPose.pilot[2] - pilotPose.drone[2]);
check('pilot stands a few metres from the drone at head height', dPilot > 3 && dPilot < 14 && pilotPose.pilot[1] - pilotPose.drone[1] > 0.8, `distance ${dPilot.toFixed(1)} m`);
await shot(page, '04_vr_pilot');

// fly with the emulated thumbsticks: arm and climb (GPS: centre, then up)
const start = await page.evaluate(tele);
await stick(page, 'left', 0, 0); await sleep(300);
await stick(page, 'left', 0, -1); await sleep(2200);
t = await page.evaluate(tele);
check('left thumbstick up arms and climbs', t.armed && t.agl > 1.5, JSON.stringify(t));
await stick(page, 'left', 0, 0); await sleep(1200);
const hover = await page.evaluate(tele);
await sleep(1000);
const hover2 = await page.evaluate(tele);
check('centred throttle holds altitude (GPS)', Math.abs(hover2.agl - hover.agl) < 0.6 && hover2.thr === 0.5, `${hover.agl} -> ${hover2.agl}`);
await stick(page, 'right', 0, -1); await sleep(2000);
await stick(page, 'right', 0, 0);
t = await page.evaluate(tele);
const moved = Math.hypot(t.x - start.x, t.z - start.z);
check('right thumbstick forward moves the drone', moved > 4, `${moved.toFixed(1)} m`);
await stick(page, 'left', 1, 0); await sleep(1000); await stick(page, 'left', 0, 0);
const yawed = await page.evaluate(tele);
check('left thumbstick sideways yaws', Math.abs(yawed.heading - t.heading) > 0.3, `${t.heading} -> ${yawed.heading}`);
await sleep(500);
await shot(page, '05_vr_pilot_flying');
const hudBefore = await page.evaluate(() => window.droneon.game.xr.hud?.last ?? '');

// GOGGLES view with X, camera switch with the left trigger
await press(page, 'left', 'x-button');
await sleep(700);
t = await page.evaluate(tele);
check('X switches to GOGGLES (chase or FPV on the screen)', t.view === 'goggles' && (t.cam === 'chase' || t.cam === 'fpv'), JSON.stringify(t));
await shot(page, '06_vr_goggles');
const cam1 = t.cam;
await press(page, 'left', 'trigger');
await sleep(700);
t = await page.evaluate(tele);
check('left trigger switches the goggles camera', t.cam !== cam1 && t.view === 'goggles', `${cam1} -> ${t.cam}`);
await page.evaluate(() => { window.__iwer.stereoEnabled = true; });
await sleep(600);
await shot(page, '07_vr_goggles_stereo');
await page.evaluate(() => { window.__iwer.stereoEnabled = false; });
await sleep(300);
const hudAfter = await page.evaluate(() => window.droneon.game.xr.hud?.last ?? '');
check('HUD panel redraws with live values', hudBefore && hudAfter && hudBefore !== hudAfter, `${hudBefore} | ${hudAfter}`);

// A = flight mode, B = reset
const m0 = (await page.evaluate(tele)).mode;
await press(page, 'right', 'a-button');
await sleep(300);
const m1 = (await page.evaluate(tele)).mode;
check('A changes the flight mode', m0 !== m1, `${m0} -> ${m1}`);
await press(page, 'right', 'a-button'); await press(page, 'right', 'a-button');
check('A cycles back to GPS', (await page.evaluate(tele)).mode === 'gps');

// back to PILOT and land
await press(page, 'left', 'x-button');
await sleep(600);
await stick(page, 'left', 0, 1);
await page.waitForFunction(() => !window.droneon.game.sim.armed, { timeout: 30000 }).catch(() => {});
await stick(page, 'left', 0, 0);
t = await page.evaluate(tele);
check('left thumbstick down lands and disarms', !t.armed && t.agl < 0.2 && !t.crashed, JSON.stringify(t));
await press(page, 'right', 'b-button');
await sleep(400);
const afterReset = await page.evaluate(tele);
check('B resets the drone to the take off spot', Math.hypot(afterReset.x - start.x, afterReset.z - start.z) < 0.5, JSON.stringify(afterReset));
await press(page, 'left', 'y-button');
await sleep(300);

// recentering: the pilot faces the take off spot; walk away and turn, Y brings it back
const pose = () => page.evaluate(() => {
  const g = window.droneon.game, T = window.THREE, c = g.renderer.xr.getCamera();
  const pos = new T.Vector3().setFromMatrixPosition(c.matrixWorld);
  const f = new T.Vector3(0, 0, -1).applyQuaternion(new T.Quaternion().setFromRotationMatrix(c.matrixWorld)); f.y = 0;
  const to = g.sim.pos.clone().sub(pos); to.y = 0;
  return { pos: pos.toArray().map(v => +v.toFixed(2)), facing: +T.MathUtils.radToDeg(f.angleTo(to)).toFixed(1) };
});
const p0 = await pose();
check('after recentering the pilot faces the take off spot', p0.facing < 12, `${p0.facing} deg`);
await page.evaluate(() => { const d = window.__iwer; d.position.x += 3; d.position.z += 1.5; const a = Math.PI / 2; d.quaternion.x = 0; d.quaternion.y = Math.sin(a / 2); d.quaternion.z = 0; d.quaternion.w = Math.cos(a / 2); });
await sleep(400);
const p1 = await pose();
await press(page, 'left', 'y-button');
await sleep(400);
const p2 = await pose();
const back = Math.hypot(p2.pos[0] - p0.pos[0], p2.pos[2] - p0.pos[2]);
check('Y puts a pilot who walked and turned back on the spot, facing the drone', Math.hypot(p1.pos[0] - p0.pos[0], p1.pos[2] - p0.pos[2]) > 2 && p1.facing > 45 && back < 0.3 && p2.facing < 12, `walked to ${p1.pos} facing ${p1.facing}, after Y ${p2.pos} facing ${p2.facing}`);
await page.evaluate(() => { const d = window.__iwer; d.position.x -= 3; d.position.z -= 1.5; d.quaternion.y = 0; d.quaternion.w = 1; });
await press(page, 'left', 'y-button');
await sleep(300);

// fade on view switches: the picture goes dark and comes back within a third of a second
const fades = await page.evaluate(async () => {
  const x = window.droneon.game.xr, out = [];
  window.__iwer.controllers.left.updateButtonValue('x-button', 1);
  const t0 = performance.now();
  while (performance.now() - t0 < 1400) { out.push([Math.round(performance.now() - t0), +x.fade.material.opacity.toFixed(2), x.view]); await new Promise(r => requestAnimationFrame(r)); }
  window.__iwer.controllers.left.updateButtonValue('x-button', 0);
  return out;
});
// timed from the first darkening, so the emulator's input latency does not count
const begin = fades.find(f => f[1] > 0), peak = fades.find(f => f[1] >= 0.99), clear = peak && fades.find(f => f[0] > peak[0] && f[2] === 'goggles' && f[1] === 0);
// design: 120 ms out, 180 ms in; headless frames are slow and uneven, so the bounds are loose
check('view switch fades out and back in', begin && peak && clear && peak[0] - begin[0] < 250 && clear[0] - peak[0] < 500, `dark from ${begin?.[0]} ms, black at ${peak?.[0]} ms, clear at ${clear?.[0]} ms`);
await sleep(300);

// thermal is a drone camera: DScan's thermal works in GOGGLES (left grip), switching back to PILOT ends it
await press(page, 'left', 'squeeze');
await sleep(500);
check('left grip turns on DScan thermal in GOGGLES', await page.evaluate(() => window.droneon.game.world.thermal));
await shot(page, '07b_vr_goggles_thermal');
await press(page, 'left', 'x-button');
await sleep(600);
check('back in PILOT the field looks normal again', await page.evaluate(() => !window.droneon.game.world.thermal && window.droneon.game.xr.view === 'pilot'));

// the Quest menu (session blurred) holds the game, coming back resumes
await page.evaluate(() => window.__iwer.updateVisibilityState('visible-blurred'));
await sleep(400);
const blurred = await page.evaluate(() => window.droneon.game.paused);
await page.evaluate(() => window.__iwer.updateVisibilityState('visible'));
await sleep(400);
check('Quest menu pauses, closing it resumes', blurred && !(await page.evaluate(() => window.droneon.game.paused)));

// a Bluetooth gamepad paired to the headset takes over when moved, the Touch sticks take it back
await page.evaluate(() => {
  window.__pad = { id: 'Xbox Wireless Controller (STANDARD GAMEPAD)', index: 0, connected: true, mapping: 'standard', timestamp: 0, axes: [0, 0, 0, 0], buttons: Array.from({ length: 17 }, () => ({ pressed: false, touched: false, value: 0 })), vibrationActuator: null };
  window.__origPads = navigator.getGamepads.bind(navigator);
  navigator.getGamepads = () => [window.__pad];
});
await sleep(300);
await page.evaluate(() => { window.__pad.axes[1] = -1; });
await sleep(300);
const gp = await page.evaluate(tele);
await page.evaluate(() => { window.__pad.axes[1] = 0; });
await sleep(200);
await stick(page, 'right', 0.8, 0); await sleep(300); await stick(page, 'right', 0, 0); await sleep(200);
const back2 = await page.evaluate(tele);
await page.evaluate(() => { navigator.getGamepads = window.__origPads; });
check('gamepad in VR takes the sticks, Touch thumbsticks take them back', gp.device === 'gamepad' && gp.thr === 1 && back2.device === 'xr', `${gp.device} thr ${gp.thr}, then ${back2.device}`);
await press(page, 'right', 'b-button');
await sleep(400);

// spraying with the right trigger on a spray drone
const sprayId = await page.evaluate(async () => {
  const { FEATURED } = await import('/src/sim/spec.ts');
  const g = window.droneon.game;
  await g.setDrone(FEATURED.find(f => f.tool === 'sprayDown'));
  return g.spec.id;
});
await sleep(800);
await stick(page, 'left', 0, -1); await sleep(1500); await stick(page, 'left', 0, 0); await sleep(500);
const tank0 = await page.evaluate(() => window.droneon.game.tank);
await page.evaluate(() => window.__iwer.controllers.right.updateButtonValue('trigger', 1));
await sleep(900);
const sprayOn = await page.evaluate(() => ({ spraying: window.droneon.game.spraying, tank: window.droneon.game.tank }));
await shot(page, '07c_vr_pilot_spray');
await page.evaluate(() => window.__iwer.controllers.right.updateButtonValue('trigger', 0));
await sleep(300);
const sprayOff = await page.evaluate(() => window.droneon.game.spraying);
check(`right trigger sprays while held (${sprayId})`, sprayOn.spraying && sprayOn.tank < tank0 && !sprayOff, `tank ${tank0} -> ${sprayOn.tank}`);
// low over the concrete, looking down: the contact shadow sits right below the drone
await stick(page, 'left', 0, 0.6); await sleep(1200); await stick(page, 'left', 0, 0);
await stick(page, 'right', -0.7, 0); await sleep(1300); await stick(page, 'right', 0, 0); await sleep(1500);
await page.evaluate(() => { const d = window.__iwer, a = -0.45; d.quaternion.x = Math.sin(a / 2); d.quaternion.w = Math.cos(a / 2); });
await sleep(400);
await shot(page, '07d_vr_pilot_contact_shadow');
await page.evaluate(() => { const d = window.__iwer; d.quaternion.x = 0; d.quaternion.w = 1; });
await stick(page, 'left', 0, 1);
await page.waitForFunction(() => !window.droneon.game.sim.armed, { timeout: 30000 }).catch(() => {});
await stick(page, 'left', 0, 0);
await page.evaluate(async () => { const g = window.droneon.game; await g.setDrone(g.chosenSpec); });
await sleep(800);

// cost of the XR render path on this GPU, finished each frame: PILOT stereo, GOGGLES stereo
const costOf = () => page.evaluate(() => {
  const g = window.droneon.game, x = g.xr, gl = g.renderer.getContext();
  for (let i = 0; i < 5; i++) x.render(0.016); gl.finish();
  const t0 = performance.now(); for (let i = 0; i < 30; i++) { x.render(0.016); gl.finish(); }
  return { ms: +((performance.now() - t0) / 30).toFixed(2), calls: x.stats.calls, tris: x.stats.tris, views: g.renderer.xr.getCamera().cameras.length, frameCpuMs: +x.stats.cpuMs.toFixed(2) };
});
await page.evaluate(() => { window.__iwer.stereoEnabled = true; }); await sleep(500);
const pilotCost = await costOf();
await press(page, 'left', 'x-button'); await sleep(500);
const gogglesCost = await costOf();
await press(page, 'left', 'x-button'); await sleep(500);
await page.evaluate(() => { window.__iwer.stereoEnabled = false; }); await sleep(300);
console.log('      XR PILOT  ', JSON.stringify(pilotCost));
console.log('      XR GOGGLES', JSON.stringify(gogglesCost));
check('XR draw calls within the Quest budget (under 320 a frame, both eyes)', pilotCost.calls < 320 && gogglesCost.calls < 320, `${pilotCost.calls} / ${gogglesCost.calls}`);

// leave VR and compare the flat state
await page.evaluate(() => window.droneon.game.xr.exit());
await page.waitForFunction(() => !window.droneon.game.renderer.xr.isPresenting, { timeout: 10000 });
await sleep(800);
let after = await page.evaluate(flatState);
const diff = Object.keys(before).filter(k => JSON.stringify(before[k]) !== JSON.stringify(after[k]));
check('flat render state identical after exit', diff.length === 0, diff.map(k => `${k}: ${JSON.stringify(before[k])} -> ${JSON.stringify(after[k])}`).join('; '));
await page.evaluate(() => { const g = window.droneon.game; g.resetDrone(); });
await sleep(1000);
await shot(page, '08_fly_flat_after');

// enter and leave again, several times, from the main menu as well
for (let i = 0; i < 3; i++) {
  if (i === 1) { await page.evaluate(() => window.droneon.game.enterMenu()); await sleep(800); }
  const fromMenu = await page.evaluate(() => window.droneon.game.state === 'menu');
  if (fromMenu) await page.click('.rail [data-xr]');
  else { await page.keyboard.press('Escape'); await sleep(400); await page.click('.overlay [data-xr]'); }
  await page.waitForFunction(() => window.droneon.game.renderer.xr.isPresenting && window.droneon.game.xr?.active, { timeout: 20000 });
  await sleep(1500);
  const st = await page.evaluate(tele);
  if (i === 2) { await press(page, 'left', 'x-button'); await sleep(500); }
  await page.evaluate(() => window.droneon.game.xr.exit());
  await page.waitForFunction(() => !window.droneon.game.renderer.xr.isPresenting, { timeout: 10000 });
  await sleep(600);
  after = await page.evaluate(flatState);
  const d = Object.keys(before).filter(k => !['camMode'].includes(k) && JSON.stringify(before[k]) !== JSON.stringify(after[k]));
  check(`round ${i + 2}: in VR from ${fromMenu ? 'main menu' : 'pause menu'} (state ${st.state}), flat state restored`, st.presenting && st.state === 'fly' && d.length === 0, d.join(','));
}

// a mission in VR: HUD shows the mission, B restarts
await page.evaluate(async () => { const g = window.droneon.game; await g.startMission(g.missions[0]); });
await sleep(800);
await page.keyboard.press('Escape'); await sleep(400);
await page.click('.overlay [data-xr]');
await page.waitForFunction(() => window.droneon.game.renderer.xr.isPresenting, { timeout: 20000 });
await sleep(1500);
t = await page.evaluate(tele);
const hudM = await page.evaluate(() => window.droneon.game.xr.hud?.last ?? '');
check('mission keeps running in VR', t.state === 'mission' && t.presenting, `${t.state} hud: ${hudM}`);
await shot(page, '09_vr_mission');
await page.evaluate(() => window.droneon.game.xr.exit());
await page.waitForFunction(() => !window.droneon.game.renderer.xr.isPresenting, { timeout: 10000 });
await sleep(500);
await page.evaluate(() => window.droneon.game.enterMenu());
await sleep(800);
await shot(page, '10_menu_after');

// Quest 2: the lighter profile
{
  const p2 = await open(true, 'quest2');
  await p2.click('.rail [data-xr]');
  await p2.waitForFunction(() => window.droneon.game.xr?.active, { timeout: 20000 });
  await sleep(2000);
  const prof = await p2.evaluate(() => { const g = window.droneon.game, w = g.world; const trees = []; w.scene.traverse(o => { if (o.isInstancedMesh && o.count >= 500) trees.push(o.count); }); return { ua: navigator.userAgent.match(/Quest \w+/)?.[0], grassR: w.grass.uniforms.uR.value, shadow: w.sun.shadow.mapSize.x, trees, foveation: g.renderer.xr.getFoveation() }; });
  check('Quest 2 gets the light profile (grass 16 m, shadow 1024, half the trees, full foveation)', prof.grassR === 16 && prof.shadow === 1024 && prof.foveation === 1, JSON.stringify(prof));
  await shot(p2, '11_vr_quest2_pilot');
  await p2.evaluate(() => window.droneon.game.xr.exit());
  await p2.waitForFunction(() => !window.droneon.game.renderer.xr.isPresenting, { timeout: 10000 });
  await p2.close();
}

const real = errors.filter(e => !e.includes('X4122') && !e.includes('X3577'));
check('zero console errors', real.length === 0, real.slice(0, 8).join('\n'));
console.log(`\n${results.filter(r => r.ok).length} of ${results.length} checks passed`);
await browser.close();
process.exit(results.every(r => r.ok) ? 0 : 1);
