// Two headless pilots join one room and verify sync. node tools/mptest.mjs <url> <outdir>
import puppeteer from 'puppeteer-core';
const [url, out] = process.argv.slice(2);
const launch = () => puppeteer.launch({ executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: 'new', args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required'] });
const bA = await launch(), bB = await launch();
const open = async (b) => {
  const p = await b.newPage(); await p.setViewport({ width: 1280, height: 760 });
  p.on('pageerror', e => console.log('pageerror', e.message));
  await p.goto(url); await p.waitForFunction(() => document.getElementById('boot')?.classList.contains('gone'), { timeout: 90000 }); return p;
};
const [A, B] = await Promise.all([open(bA), open(bB)]);
const code = 'T' + Math.random().toString(36).slice(2, 5).toUpperCase();
await A.evaluate(c => window.droneon.ui.squad.join(c, 'Luca'), code);
await B.evaluate(c => window.droneon.ui.squad.join(c, 'Fabian'), code);
const t0 = Date.now();
await Promise.all([A, B].map(p => p.waitForFunction(() => window.droneon.game.mp?.pilots.size === 1, { timeout: 60000 })));
console.log('connected after', Date.now() - t0, 'ms');
// Fabian flies next to Luca
await B.evaluate(() => { const g = window.droneon.game; g.sim.pos.x += 4; g.sim.pos.y += 3; g.sim.armed = true; g.sim.onGround = false; for (const m of g.sim.motors) m.s = 0.6; });
// Luca places a ring, Fabian should receive it
const before = await B.evaluate(() => window.droneon.game.builder.map.pieces.length);
await A.evaluate(() => { const g = window.droneon.game; g.builder.place({ t: 'bigring', x: g.sim.pos.x, y: 0, z: g.sim.pos.z - 14, r: 0, s: 1 }); });
await new Promise(r => setTimeout(r, 1500));
const after = await B.evaluate(() => window.droneon.game.builder.map.pieces.length);
console.log('build sync', before, '->', after);
await A.screenshot({ path: out + '/mpA.png' });
// race countdown from the host
const host = await A.evaluate(() => window.droneon.game.mp.isHost());
const H = host ? A : B, O = host ? B : A;
await H.evaluate(() => window.droneon.game.mp.startRace());
await new Promise(r => setTimeout(r, 1200));
console.log('race states', await H.evaluate(() => window.droneon.game.mp.raceState), await O.evaluate(() => window.droneon.game.mp.raceState));
await O.screenshot({ path: out + '/mpB_countdown.png' });
await new Promise(r => setTimeout(r, 3500));
console.log('after GO', await O.evaluate(() => ({ s: window.droneon.game.mp.raceState, locked: window.droneon.game.raceLocked })));
await Promise.all([bA.close(), bB.close()]);
