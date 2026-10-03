// Emulated touch phone: tap FLY, drag the left stick up with a finger, check the drone climbs.
import puppeteer from 'puppeteer-core';
const [url, out] = process.argv.slice(2);
const b = await puppeteer.launch({ executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: 'new', args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'] });
const p = await b.newPage();
await p.setViewport({ width: 1200, height: 750, isMobile: true, hasTouch: true, deviceScaleFactor: 1 });
p.on('pageerror', e => console.log('pageerror', e.message));
// pretend a SIYI RC is plugged in with throttle resting at the bottom
await p.evaluateOnNewDocument(() => {
  const pad = { id: 'SIYI UniRC 7 Pro Joystick', connected: true, axes: [0, 0, -1, 0], buttons: Array.from({ length: 8 }, () => ({ pressed: false, value: 0 })), index: 0, mapping: '' };
  navigator.getGamepads = () => [pad];
});
await p.goto(url); await p.waitForFunction(() => document.getElementById('boot')?.classList.contains('gone'), { timeout: 90000 });
const fly = await p.$('[data-go=fly]'); const fb = await fly.boundingBox();
await p.touchscreen.tap(fb.x + 40, fb.y + 20);
await p.waitForFunction(() => window.droneon.game.state === 'fly', { timeout: 20000 });
await new Promise(r => setTimeout(r, 800));
const base = await p.$('.joy.l .joy-base'); const bb = await base.boundingBox();
const cx = bb.x + bb.width / 2, cy = bb.y + bb.height / 2;
const cdp = await p.target().createCDPSession();
const tp = (type, x, y) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y }] });
await tp('touchStart', cx, cy);
for (let i = 1; i <= 8; i++) { await tp('touchMove', cx, cy - i * 9); await new Promise(r => setTimeout(r, 30)); }
await new Promise(r => setTimeout(r, 2500));
console.log(JSON.stringify(await p.evaluate(() => { const g = window.droneon.game; return { dev: g.input.device, thr: +g.input.sticks.throttle.toFixed(2), agl: +g.sim.agl.toFixed(2), armed: g.sim.armed, joy: document.querySelector('.touch').className }; })));
await p.screenshot({ path: out });
await tp('touchEnd');
await b.close();
