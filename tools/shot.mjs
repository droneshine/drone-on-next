// Headless Edge screenshot rig for visual QA.
// node tools/shot.mjs <url> <out.png> [width] [height] [script.js] [waitMs]
import puppeteer from 'puppeteer-core';
import fs from 'fs';
const [url, out, w = '1440', h = '900', script, wait = '4000'] = process.argv.slice(2);
const browser = await puppeteer.launch({
  executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  headless: 'new',
  args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader', '--autoplay-policy=no-user-gesture-required'],
});
const page = await browser.newPage();
await page.setViewport({ width: +w, height: +h, deviceScaleFactor: 1 });
const logs = [];
page.on('console', m => { if (['error', 'warning'].includes(m.type())) logs.push(m.type() + ': ' + m.text().slice(0, 300)); });
page.on('pageerror', e => logs.push('pageerror: ' + e.message));
await page.goto(url, { waitUntil: 'load' });
await page.waitForFunction(() => document.getElementById('boot')?.classList.contains('gone'), { timeout: 90000 });
console.log('booted in', Math.round(performance.now()) ,'ms (node clock)');
await new Promise(r => setTimeout(r, 1500));
if (script) {
  const code = fs.readFileSync(script, 'utf8');
  const res = await page.evaluate(`(async () => { ${code} })()`);
  if (res && res.drag) { const [x1, y1, x2, y2, ms] = res.drag; await page.mouse.move(x1, y1); await page.mouse.down(); await page.mouse.move(x2, y2, { steps: 8 }); await new Promise(r => setTimeout(r, ms)); if (res.release !== false) await page.mouse.up(); }
  if (res && res.after) console.log('after:', JSON.stringify(await page.evaluate(res.after)));
  if (res !== undefined) console.log('result:', JSON.stringify(res));
}
await new Promise(r => setTimeout(r, +wait));
await page.screenshot({ path: out });
const fps = await page.evaluate(async () => { const g = window.droneon.game; const f0 = g.renderer.info.render.frame; await new Promise(r => setTimeout(r, 1000)); return g.renderer.info.render.frame - f0; });
console.log('fps', fps);
console.log(logs.filter(l => !l.includes('X4122') && !l.includes('toNonIndexed') && !l.includes('PCFSoft')).join('\n'));
await browser.close();
