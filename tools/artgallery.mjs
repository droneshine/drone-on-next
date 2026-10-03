// Headless Edge rig for the Royale art gallery (#artgallery, dev server only).
// node tools/artgallery.mjs <baseUrl> <outDir> <view[:time[:thermal]]>... [--w 1440 --h 900 --wait 2500]
// Example: node tools/artgallery.mjs http://localhost:5303/ shots tiers:day rings:golden stress50
// Prints fps (animation frames in 1 s), draw calls, triangles and live counts for every shot.
import puppeteer from 'puppeteer-core';
import fs from 'fs';
import path from 'path';

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf('--' + k); if (i < 0) return d; const v = args[i + 1]; args.splice(i, 2); return v; };
const W = +opt('w', 1440), H = +opt('h', 900), WAIT = +opt('wait', 2500), HUD = opt('hud', '0'), BENCH = opt('bench', '0') === '1';
const [base, outDir, ...views] = args;
fs.mkdirSync(outDir, { recursive: true });
const browser = await puppeteer.launch({
  executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  headless: 'new',
  args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required'],
});
const page = await browser.newPage();
await page.setViewport({ width: W, height: H, deviceScaleFactor: 1 });
const logs = [];
page.on('console', m => { if (['error', 'warning'].includes(m.type())) logs.push(m.type() + ': ' + m.text().slice(0, 300)); });
page.on('pageerror', e => logs.push('pageerror: ' + e.message));
let first = true;
for (const v of views) {
  const [view, time = 'golden', thermal = '0'] = v.split(':');
  const hash = `#artgallery&view=${view}&time=${time}&thermal=${thermal === 'thermal' || thermal === '1' ? 1 : 0}&hud=${HUD}`;
  if (first) {
    await page.goto(base + hash, { waitUntil: 'load' });
    await page.waitForFunction(() => document.getElementById('boot')?.classList.contains('gone') && window.__art, { timeout: 120000 });
    first = false;
  } else {
    await page.evaluate(h => { location.hash = h; }, hash);
  }
  await new Promise(r => setTimeout(r, WAIT));
  const file = path.join(outDir, `${view}-${time}${thermal !== '0' ? '-thermal' : ''}.png`);
  await page.screenshot({ path: file });
  const fps = await page.evaluate(() => new Promise(res => { let n = 0; const t0 = performance.now(); const f = () => { n++; if (performance.now() - t0 < 1000) requestAnimationFrame(f); else res(n); }; requestAnimationFrame(f); }));
  const st = await page.evaluate(() => window.__art);
  const bench = BENCH ? await page.evaluate(() => window.__artBench(20)) : null;
  console.log(file, 'fps', fps, JSON.stringify(st), bench ? 'bench ' + JSON.stringify(bench) : '');
}
const bad = logs.filter(l => !l.includes('X4122') && !l.includes('X3577') && !l.includes('toNonIndexed') && !l.includes('PCFSoft'));
console.log(bad.length ? bad.join('\n') : 'console clean');
await browser.close();
