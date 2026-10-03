// Spielwiese QA rig: clicks through the real menus, flies the Academy drills with the touch stick
// autopilot (tools/qa-autopilot.js), builds a Workshop drone and flies it, screenshots every step.
// node tools/spielwiese-qa.mjs url=http://localhost:5302/ w=1440 h=900 touch=0 out=qa steps=menu,academy,drills,pilot,workshop
import puppeteer from 'puppeteer-core';
import fs from 'fs';
import path from 'path';

const A = Object.fromEntries(process.argv.slice(2).map(a => a.split('=')));
const PAGE = A.url ?? 'http://localhost:5302/';
const W = +(A.w ?? 1440), H = +(A.h ?? 900), TOUCH = A.touch === '1';
const OUT = A.out ?? 'qa';
const STEPS = (A.steps ?? 'menu,academy,drills,pilot,workshop,sheets').split(',');
const DRILLS = (A.drills ?? 'hover-lock,ring-sprint,slalom,pad-hop,target-range').split(',');
fs.mkdirSync(OUT, { recursive: true });
const tag = `${W}x${H}${TOUCH ? 't' : ''}`;

const browser = await puppeteer.launch({
  executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  headless: 'new',
  args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required'],
});
const page = await browser.newPage();
await page.setViewport({ width: W, height: H, deviceScaleFactor: 1, isMobile: TOUCH, hasTouch: TOUCH });
const logs = [];
page.on('console', m => { if (['error', 'warning'].includes(m.type())) logs.push(m.type() + ': ' + m.text().slice(0, 300)); });
page.on('pageerror', e => logs.push('pageerror: ' + e.message));
await page.goto(PAGE, { waitUntil: 'load' });
try { await page.waitForFunction(() => document.getElementById('boot')?.classList.contains('gone'), { timeout: 90000 }); }
catch { console.log(['BOOT TIMEOUT', ...logs].join('\n')); await page.screenshot({ path: `${OUT}/${tag}-boot.png` }); await browser.close(); process.exit(1); }
await page.evaluate(fs.readFileSync(new URL('./qa-autopilot.js', import.meta.url), 'utf8'));
const sleep = ms => new Promise(r => setTimeout(r, ms));
await sleep(1200);

const shot = async name => { await page.screenshot({ path: `${OUT}/${tag}-${name}.png` }); console.log('shot', name); };
const tap = async (sel, opts = {}) => {
  const el = typeof sel === 'string' ? await page.waitForSelector(sel, { visible: true, timeout: 15000 }) : sel;
  await el.evaluate(e => e.scrollIntoView({ block: 'center', behavior: 'instant' }));
  await sleep(opts.settle ?? 300);
  const bb = await el.boundingBox();
  if (!bb) throw new Error('no box for ' + sel);
  // the point we tap must really be this element, not a panel sliding over it
  const hit = await el.evaluate((e, x, y) => { const h = document.elementFromPoint(x, y); return !h || h === e || e.contains(h) ? '' : `${h.tagName}.${h.className}`; }, bb.x + bb.width / 2, bb.y + bb.height / 2);
  if (hit) throw new Error(`covered: ${sel} by ${hit}`);
  if (TOUCH) await page.touchscreen.tap(bb.x + bb.width / 2, bb.y + bb.height / 2);
  else await page.mouse.click(bb.x + bb.width / 2, bb.y + bb.height / 2);
  await sleep(opts.after ?? 350);
};
const state = () => page.evaluate(() => window.droneon.game.state);
const results = {};

async function openAcademy() {
  if ((await state()) !== 'menu') { await page.evaluate(() => window.droneon.game.enterMenu()); await sleep(600); }
  await page.evaluate(() => window.droneon.ui.closeSheets());
  await sleep(300);
  await tap('[data-go=academy]');
}

async function flyDrill(id, { shotMid = false } = {}) {
  await openAcademy();
  if (!(await page.$eval(`[data-drill=${id}]`, e => e.classList.contains('open')))) await tap(`[data-drill=${id}] .ac-head`);
  await tap(`[data-drill=${id}] .start`, { after: 900 });
  await page.waitForFunction(() => window.droneon.game.state === 'mission', { timeout: 20000 });
  await sleep(500);
  await page.evaluate(i => window.__ap.fly(i), id);
  const t0 = Date.now();
  let mid = false;
  while (Date.now() - t0 < 140000) {
    await sleep(500);
    const st = await page.evaluate(() => ({ s: window.droneon.game.state, open: document.querySelector('.ac-result')?.classList.contains('open'), hud: document.querySelector('.hud .tc .big')?.textContent }));
    if (shotMid && !mid && Date.now() - t0 > 9000) { mid = true; await shot(`fly-${id}`); }
    if (st.open) break;
  }
  await page.evaluate(() => window.__ap.stop());
  await sleep(1400);
  const r = await page.evaluate(() => ({ score: document.querySelector('.ac-score')?.textContent, medal: document.querySelector('.ac-medal')?.textContent, line: document.querySelector('.ac-line')?.textContent, level: document.querySelector('[data-lvl]')?.textContent }));
  if (r.score === 'CRASHED') r.at = await page.evaluate(() => { const s = window.droneon.game.sim, p = s.pos; const near = [...window.droneon.game.world.colliders.list].filter(c => c.pos.distanceTo(p) < c.bound + 3).map(c => `${c.tag ?? c.shape.kind}@${c.pos.x.toFixed(1)},${c.pos.y.toFixed(1)},${c.pos.z.toFixed(1)}`).slice(0, 6); return { p: [p.x.toFixed(1), p.y.toFixed(1), p.z.toFixed(1)], agl: s.agl.toFixed(2), v: s.speed().toFixed(1), near }; });
  results[id] = r;
  console.log('result', id, JSON.stringify(r));
  await shot(`result-${id}`);
}

try {
  if (STEPS.includes('menu')) {
    await shot('menu');
  }
  if (STEPS.includes('academy')) {
    await openAcademy();
    await sleep(400);
    await shot('academy');
    await tap('[data-drill=hover-lock] .ac-head');
    await shot('academy-row');
    await tap('[data-tab=missions]');
    await shot('academy-missions');
    await tap('[data-tab=drills]');
  }
  if (STEPS.includes('drills')) {
    for (const d of DRILLS) await flyDrill(d, { shotMid: true });
    // instant restart from the results screen with R and a second run of the shortest drill
    if (!TOUCH && DRILLS.includes('slalom')) {
      await page.keyboard.press('KeyR');
      await sleep(1500);
      console.log('after R', await state());
    }
  }
  if (STEPS.includes('mission')) {
    await openAcademy();
    await tap('[data-tab=missions]');
    const first = await page.$('.ac-list .mission > button');
    await tap(first);
    await tap('.ac-list .mission.open .start', { after: 900 });
    await page.waitForFunction(() => window.droneon.game.state === 'mission', { timeout: 20000 });
    await sleep(400);
    await page.evaluate(() => window.__ap.fly('first-flight'));
    await page.waitForFunction(() => window.droneon.game.state === 'result' && document.querySelector('.overlay.open .box [data-r]'), { timeout: 150000 }).catch(() => console.log('mission did not finish'));
    await page.evaluate(() => window.__ap.stop());
    await sleep(900);
    console.log('mission', JSON.stringify(await page.evaluate(() => ({ score: document.querySelector('.overlay.open .score')?.textContent, xp: document.querySelector('.mission-xp')?.textContent }))));
    await shot('mission-result');
    await tap('.overlay.open [data-r=menu]', { after: 1200 });
    await shot('mission-back');
  }
  if (STEPS.includes('airtime')) {
    await page.evaluate(() => { window.droneon.ui.closeSheets(); window.droneon.game.startFreeFlight(); });
    await sleep(1500);
    await page.evaluate(() => window.__ap.sticks(0.5, 0, 0, 0));
    await sleep(300);
    await page.evaluate(() => window.__ap.sticks(0.85, 0, 0, 0));
    await sleep(1500);
    await page.evaluate(() => window.__ap.sticks(0.5, 0, 0, 0));
    // a minute of sim time in the air (the sim slows down when the machine is busy)
    await page.waitForFunction(() => window.droneon.game.flightTime > 61, { timeout: 180000, polling: 500 }).catch(() => {});
    await sleep(800);
    console.log('airtime', await page.evaluate(() => JSON.parse(localStorage.getItem('droneon2.pilot') || '{}').daily?.used?.airtime), await page.evaluate(() => [...document.querySelectorAll('.toast')].map(t => t.textContent).join(' | ')));
    await shot('airtime');
  }
  if (STEPS.includes('keyboard')) {
    // TARGET RANGE with real key presses: W to arm and climb, A and D to aim, Space held to fire
    await openAcademy();
    if (!(await page.$eval('[data-drill=target-range]', e => e.classList.contains('open')))) await tap('[data-drill=target-range] .ac-head');
    await tap('[data-drill=target-range] .start', { after: 900 });
    await page.waitForFunction(() => window.droneon.game.state === 'mission', { timeout: 20000 });
    await page.mouse.click(W / 2, H / 2);
    await page.keyboard.down('KeyW'); await sleep(2200); await page.keyboard.up('KeyW');
    let fire = false;
    const t0 = Date.now();
    while (Date.now() - t0 < 62000) {
      const st = await page.evaluate(() => {
        const g = window.droneon.game; if (g.state !== 'mission') return null;
        const s = g.sim, tg = g.mission.probe().targets; if (!tg.length) return null;
        let best = tg[0], bd = 1e9; for (const t of tg) { const d = Math.hypot(t.x - s.pos.x, t.z - s.pos.z); if (d < bd) { bd = d; best = t; } }
        const b = Math.atan2(-(best.x - s.pos.x), -(best.z - s.pos.z)); let e = b - s.heading(); while (e > Math.PI) e -= 2 * Math.PI; while (e < -Math.PI) e += 2 * Math.PI;
        return { e, d: bd, dy: best.y - s.pos.y, locked: g.mission.probe().locked };
      });
      if (!st) break;
      // like a pilot: squeeze the trigger only with the crosshair locked on
      if (st.locked && !fire) { await page.keyboard.down('Space'); fire = true; }
      if (!st.locked && fire) { await page.keyboard.up('Space'); fire = false; }
      const key = st.e > 0 ? 'KeyA' : 'KeyD';
      if (Math.abs(st.e) > 0.05) { await page.keyboard.down(key); await sleep(Math.min(400, Math.abs(st.e) * 300)); await page.keyboard.up(key); }
      if (st.d > 45) { await page.keyboard.down('ArrowUp'); await sleep(350); await page.keyboard.up('ArrowUp'); }
      if (st.dy > 3) { await page.keyboard.down('KeyW'); await sleep(250); await page.keyboard.up('KeyW'); }
      if (st.dy < -3) { await page.keyboard.down('KeyS'); await sleep(200); await page.keyboard.up('KeyS'); }
      await sleep(60);
    }
    if (fire) await page.keyboard.up('Space');
    await page.waitForFunction(() => document.querySelector('.ac-result')?.classList.contains('open'), { timeout: 30000 }).catch(() => {});
    await sleep(1200);
    console.log('keyboard range', JSON.stringify(await page.evaluate(() => ({ score: document.querySelector('.ac-score')?.textContent, medal: document.querySelector('.ac-medal')?.textContent, detail: [...document.querySelectorAll('.ac-line.dim')].map(x => x.textContent).join(' | ') }))));
    await shot('keyboard-range');
    await page.keyboard.press('KeyR');
    await sleep(1500);
    console.log('R from results ->', await state(), await page.evaluate(() => window.droneon.game.mission?.id));
  }
  if (STEPS.includes('pilot')) {
    await page.evaluate(() => window.droneon.game.enterMenu());
    await sleep(700);
    await page.evaluate(() => window.droneon.ui.closeSheets());
    await sleep(300);
    await shot('menu-after');
    await tap('.pilot-chip');
    await shot('pilot');
  }
  if (STEPS.includes('workshop')) {
    if ((await state()) !== 'menu') { await page.evaluate(() => window.droneon.game.enterMenu()); await sleep(700); }
    await page.evaluate(() => window.droneon.ui.closeSheets());
    await sleep(300);
    await tap('[data-go=hangar]');
    await shot('workshop-hangar');
    await tap('.ws-entry', { after: 800 });
    await shot('workshop-parts');
    await tap('[data-slot=frame][data-v=survey10]');
    await tap('[data-slot=motor][data-v=m4]');
    await sleep(500);
    await shot('workshop-heavy');
    await tap('[data-slot=motor][data-v=m15]');
    await tap('[data-slot=prop][data-v="0.178"]');
    await page.$eval('#ws-cells', e => { e.value = '6'; e.dispatchEvent(new Event('input', { bubbles: true })); });
    await page.$eval('#ws-ah', e => { e.value = '10'; e.dispatchEvent(new Event('input', { bubbles: true })); });
    await page.$eval('#ws-name', e => { e.value = 'Field Scout'; e.dispatchEvent(new Event('input', { bubbles: true })); });
    await tap('[data-paint=paint-graphite]');
    await sleep(700);
    await shot('workshop-ready');
    await tap('[data-save=hangar]', { after: 1200 });
    await shot('workshop-saved');
    const saved = await page.evaluate(() => ({ spec: window.droneon.game.chosenSpec.name, id: window.droneon.game.chosenSpec.id }));
    console.log('saved', JSON.stringify(saved));
    await page.evaluate(() => window.droneon.ui.closeSheets());
    await sleep(400);
    await tap('[data-go=spielwiese]');
    await shot('spielwiese');
    await tap('[data-sw=fly]', { after: 1500 });
    await page.evaluate(() => window.__ap.sticks(0.5, 0, 0, 0));
    await sleep(300);
    await page.evaluate(() => window.__ap.sticks(0.95, 0, 0, 0));
    await sleep(3200);
    await page.evaluate(() => window.__ap.sticks(0.55, 0, 0.8, 0));
    await sleep(2500);
    const fly = await page.evaluate(() => ({ state: window.droneon.game.state, spec: window.droneon.game.spec.name, armed: window.droneon.game.sim.armed, alt: window.droneon.game.sim.agl.toFixed(1), v: window.droneon.game.sim.speed().toFixed(1) }));
    console.log('flying', JSON.stringify(fly));
    await shot('workshop-flying');
    await page.evaluate(() => window.__ap.sticks(0.5, 0, 0, 0));
  }
  if (STEPS.includes('cosmetics')) {
    // jump the profile to level 8 (dev module import, same instance as the app), then equip and fly with real taps
    await page.evaluate(async () => { const p = await import('/src/meta/progression.ts'); return p.awardXp([{ label: 'QA', xp: 5000 }], 'daily'); });
    await page.evaluate(() => window.droneon.game.enterMenu());
    await sleep(700);
    await page.evaluate(() => window.droneon.ui.closeSheets());
    await sleep(300);
    await shot('menu-level');
    await tap('.pilot-chip');
    await tap('[data-kind=led][data-id=led-blue]');
    await tap('[data-kind=trail][data-id=trail-shine]');
    await tap('[data-kind=title][data-id=title-static]');
    await page.evaluate(() => { document.querySelector('[data-sheet=pilot] .body').scrollTop = 0; });
    await shot('pilot-level');
    await page.evaluate(() => window.droneon.ui.closeSheets());
    await sleep(300);
    await tap('[data-go=hangar]');
    await tap('.ws-entry', { after: 800 });
    await tap('[data-slot=frame][data-v=longrange7]');
    await tap('[data-slot=motor][data-v=m25]');
    await sleep(600);
    await shot('workshop-level');
    await tap('[data-save=fly]', { after: 2000 });
    // this frame starts in Angle: throttle all the way down first, then up to arm
    await page.evaluate(() => window.__ap.sticks(0, 0, 0, 0));
    await sleep(500);
    await page.evaluate(() => window.__ap.sticks(0.95, 0, 0, 0));
    await sleep(2500);
    await page.evaluate(() => window.__ap.sticks(0.6, 0.15, 1, 0));
    await sleep(2200);
    console.log('trail flight', JSON.stringify(await page.evaluate(() => ({ spec: window.droneon.game.spec.name, v: window.droneon.game.sim.speed().toFixed(1), leds: window.droneon.game.visual.leds.map(l => '#' + l.material.color.getHexString()) }))));
    await shot('trail');
    await page.evaluate(() => window.__ap.sticks(0.5, 0, 0, 0));
  }
  if (STEPS.includes('regress')) {
    // what worked before must still work: build mode from the Spielwiese, a shared course link, the squad lobby, the pause menu
    await page.evaluate(() => window.droneon.game.enterMenu());
    await sleep(600);
    await page.evaluate(() => window.droneon.ui.closeSheets());
    await sleep(300);
    await tap('[data-go=spielwiese]');
    await tap('[data-sw=build]', { after: 1500 });
    console.log('build state', await state());
    await shot('build');
    await tap('.build [data-b=menu]', { after: 900 });
    console.log('back to', await state());
    await tap('[data-go=squad]');
    await shot('squad');
    await page.evaluate(() => window.droneon.ui.closeSheets());
    await sleep(300);
    await tap('[data-go=spielwiese]');
    await tap('[data-sw=fly]', { after: 1500 });
    await page.keyboard.press('Escape');
    await sleep(500);
    await shot('pause');
    const code = await page.evaluate(async () => { const st = await import('/src/game/store.ts'); const b = await import('/src/game/builder.ts'); return st.encodeShare(b.starterMap()); });
    await page.goto('about:blank'); await page.goto(PAGE + '#map=' + code, { waitUntil: 'load' });
    await page.waitForFunction(() => document.getElementById('boot')?.classList.contains('gone'), { timeout: 90000 });
    await sleep(1500);
    console.log('shared link', JSON.stringify(await page.evaluate(() => ({ state: window.droneon.game.state, origin: window.droneon.game.builder.origin, pieces: window.droneon.game.builder.map.pieces.length }))));
    await shot('shared');
  }
  if (STEPS.includes('expert')) {
    // parts to EXPERT NUMBERS: change a raw value, save, the hangar marks it EXPERT TUNED and offers a rebuild
    await page.evaluate(() => window.droneon.game.enterMenu());
    await sleep(600);
    await page.evaluate(() => window.droneon.ui.closeSheets());
    await sleep(300);
    await tap('[data-go=hangar]');
    await tap('.ws-entry', { after: 800 });
    await page.$eval('#ws-name', e => { e.value = 'Tuned One'; e.dispatchEvent(new Event('input', { bubbles: true })); });
    await tap('[data-save=hangar]', { after: 1200 });
    const badge1 = await page.evaluate(() => [...document.querySelectorAll('[data-sheet=hangar] .drone-row')].map(r => r.querySelector('h3')?.textContent?.replace(/\s+/g, ' ').trim()).filter(t => /Tuned One/.test(t)));
    console.log('after parts save', JSON.stringify(badge1));
    // Edit on a parts drone opens the parts builder again
    const row = await page.evaluateHandle(() => [...document.querySelectorAll('[data-sheet=hangar] .drone-row')].find(r => /Tuned One/.test(r.textContent)));
    await tap(await row.asElement().$('[aria-label=Edit]'), { after: 700 });
    console.log('edit opens', await page.evaluate(() => Object.entries(window.droneon.ui.sheets).find(([, s]) => s.classList.contains('open'))?.[0]));
    await tap('[data-expert]', { after: 900 });
    console.log('expert opens', await page.evaluate(() => Object.entries(window.droneon.ui.sheets).find(([, s]) => s.classList.contains('open'))?.[0]));
    await shot('expert-editor');
    await page.$eval('#f-maxTilt', e => { e.value = '62'; e.dispatchEvent(new Event('input', { bubbles: true })); });
    await tap('[data-sheet=editor] .save', { after: 1500 });
    const badge2 = await page.evaluate(() => { const r = [...document.querySelectorAll('[data-sheet=hangar] .drone-row')].find(r => /Tuned One/.test(r.textContent)); return { badge: r?.querySelector('.ws-badge')?.textContent, actions: [...(r?.querySelectorAll('.acts button') ?? [])].map(b => b.getAttribute('aria-label')) }; });
    console.log('after expert save', JSON.stringify(badge2));
    await page.evaluate(() => { const r = [...document.querySelectorAll('[data-sheet=hangar] .drone-row')].find(r => /Tuned One/.test(r.textContent)); r?.scrollIntoView({ block: 'center' }); });
    await sleep(300);
    await shot('expert-hangar');
    // instant restart in flight: R puts a drill back to its start at once
    await openAcademy();
    if (!(await page.$eval('[data-drill=slalom]', e => e.classList.contains('open')))) await tap('[data-drill=slalom] .ac-head');
    await tap('[data-drill=slalom] .start', { after: 900 });
    await page.evaluate(() => window.__ap.fly('slalom'));
    await sleep(6000);
    const before = await page.evaluate(() => ({ z: window.droneon.game.sim.pos.z.toFixed(1), t: window.droneon.game.mission.hud() }));
    await page.evaluate(() => window.__ap.stop());
    const t0 = Date.now();
    await page.keyboard.press('KeyR');
    await page.waitForFunction(() => window.droneon.game.state === 'mission' && Math.abs(window.droneon.game.sim.pos.z) < 1, { timeout: 5000 });
    console.log('R in flight', JSON.stringify(before), '->', JSON.stringify(await page.evaluate(() => ({ z: window.droneon.game.sim.pos.z.toFixed(1), t: window.droneon.game.mission.hud(), id: window.droneon.game.mission.id }))), `${Date.now() - t0} ms`);
  }
  if (STEPS.includes('sheets')) {
    await page.evaluate(() => window.droneon.game.enterMenu());
    await sleep(700);
    await page.evaluate(() => window.droneon.ui.closeSheets());
    await sleep(300);
    await tap('[data-go=royale]');
    await shot('royale');
    await page.evaluate(() => window.droneon.ui.closeSheets());
    await sleep(300);
    await tap('[data-go=settings]');
    await shot('settings');
  }
} catch (e) {
  console.log('FAILED', e.message);
  await shot('failure');
}
const pilot = await page.evaluate(() => localStorage.getItem('droneon2.pilot'));
console.log('pilot', pilot);
console.log('logs:\n' + logs.filter(l => !l.includes('X4122') && !l.includes('toNonIndexed') && !l.includes('PCFSoft')).join('\n'));
await browser.close();
