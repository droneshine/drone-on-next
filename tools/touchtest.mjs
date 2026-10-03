// Emulated touch device: pause must stay open after a tap, sheets must scroll by swipe.
import puppeteer from 'puppeteer-core';
const [url] = process.argv.slice(2);
const b = await puppeteer.launch({ executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: 'new', args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'] });
const p = await b.newPage();
await p.setViewport({ width: 1100, height: 640, isMobile: true, hasTouch: true });
p.on('pageerror', e => console.log('pageerror', e.message));
await p.goto(url); await p.waitForFunction(() => document.getElementById('boot')?.classList.contains('gone'), { timeout: 90000 });
const tapSel = async (sel) => { const e = await p.$(sel); const bb = await e.boundingBox(); await p.touchscreen.tap(bb.x + bb.width / 2, bb.y + bb.height / 2); };
// menu scroll: rail must reach SETTINGS
const railScroll = await p.evaluate(() => { const r = document.querySelector('.rail'); return { sh: r.scrollHeight, ch: r.clientHeight }; });
console.log('rail', railScroll);
await tapSel('[data-go=fly]');
await p.waitForFunction(() => window.droneon.game.state === 'fly', { timeout: 20000 });
await new Promise(r => setTimeout(r, 600));
await tapSel('.tpause');
await new Promise(r => setTimeout(r, 900));
console.log('paused after tap', await p.evaluate(() => window.droneon.game.paused && document.querySelector('.overlay').classList.contains('open')));
await tapSel('[data-p=settings]');
await new Promise(r => setTimeout(r, 500));
const body = await p.$('[data-sheet=settings] .body'); const bb = await body.boundingBox();
const cdp = await p.target().createCDPSession();
console.log('debug', await p.evaluate((x, y) => { const e = document.elementFromPoint(x, y); const body = document.querySelector('[data-sheet=settings] .body'); return { top: e?.className, sh: body.scrollHeight, ch: body.clientHeight, sheetOpen: document.querySelector('[data-sheet=settings]').className, pause: document.querySelector('.overlay').className }; }, Math.round(bb.x + bb.width / 2), Math.round(bb.y + bb.height * 0.7)));
const x = Math.round(bb.x + 40), y0 = Math.round(bb.y + bb.height * 0.8);
await p.evaluate(() => { document.querySelector('[data-sheet=settings] .body').scrollTop = 0; });
await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y: y0 }] });
for (let i = 1; i <= 12; i++) { await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: y0 - i * 25 }] }); await new Promise(r => setTimeout(r, 16)); }
await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
await new Promise(r => setTimeout(r, 600));
await body.evaluate(el => el.scrollBy(0, 0));
console.log('settings scrollTop after swipe', await p.evaluate(() => document.querySelector('[data-sheet=settings] .body').scrollTop));
await b.close();
