import puppeteer from 'puppeteer-core';
const [url] = process.argv.slice(2);
const b = await puppeteer.launch({ executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: 'new', args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'] });
const p = await b.newPage();
await p.setViewport({ width: 1100, height: 640, isMobile: true, hasTouch: true });
await p.goto(url); await p.waitForFunction(() => document.getElementById('boot')?.classList.contains('gone'), { timeout: 90000 });
const cdp = await p.target().createCDPSession();
const swipe = async (x, y0) => {
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y: y0 }] });
  for (let i = 1; i <= 12; i++) { await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: y0 - i * 25 }] }); await new Promise(r => setTimeout(r, 16)); }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await new Promise(r => setTimeout(r, 400));
};
await p.evaluate(() => { window.__tm = []; addEventListener('touchmove', e => window.__tm.push(e.defaultPrevented + ':' + e.cancelable), { capture: false }); });
await swipe(200, 560);
console.log('A rail', await p.evaluate(() => document.querySelector('.rail').scrollTop));
await p.evaluate(() => { document.getElementById('gl').style.touchAction = 'pan-y'; });
await swipe(200, 560);
console.log('B rail (canvas pan-y)', await p.evaluate(() => document.querySelector('.rail').scrollTop));
await p.evaluate(() => { document.getElementById('gl').style.touchAction = ''; document.getElementById('ui').style.pointerEvents = 'auto'; });
await swipe(200, 560);
console.log('C rail (ui auto)', await p.evaluate(() => document.querySelector('.rail').scrollTop));
console.log('rail scrollTop', await p.evaluate(() => document.querySelector('.rail').scrollTop), 'touchmoves', await p.evaluate(() => window.__tm.slice(0, 3).join(' ') + ' n=' + window.__tm.length));
await p.evaluate(() => window.droneon.ui.openSheet('train'));
await new Promise(r => setTimeout(r, 500));
await swipe(300, 560);
console.log('train scrollTop', await p.evaluate(() => document.querySelector('[data-sheet=train] .body').scrollTop));
await b.close();
