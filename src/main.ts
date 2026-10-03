import './ui/style.css';
import * as THREE from 'three';
import { Game } from './game/game';
import { UI, mapFromHash, lastDroneId } from './ui/ui';
import { FEATURED, featured, looksLikeDrone, validateSpec } from './sim/spec';
import type { DroneSpec } from './sim/spec';
import { listCustomDrones } from './game/store';
import { audio } from './audio/audio';
import { roomFromHash } from './ui/mpui';
import { sanitizeMap } from './game/builder';

const bar = document.querySelector<HTMLElement>('.boot-bar i')!;
const step = (p: number) => { bar.style.setProperty('--p', String(p)); };
const bootEl = () => document.getElementById('boot')!;

function fail(title: string, text: string, err?: unknown, offerReset = false) {
  if (err) console.error(err);
  bootEl().classList.remove('gone');
  bootEl().innerHTML = `<div class="boot-fail"><h2>${title}</h2><p>${text}</p>${offerReset ? '<button class="btn go" type="button">Reset saved data and reload</button>' : ''}</div>`;
  bootEl().querySelector('button')?.addEventListener('click', () => {
    try { for (const k of Object.keys(localStorage)) if (k.startsWith('droneon.')) localStorage.removeItem(k); } catch { /* storage blocked */ }
    try { indexedDB.deleteDatabase('droneon'); } catch { /* ignore */ }
    location.hash = ''; location.reload();
  });
}

/** the drone picked last time, wherever it came from: featured, your hangar or the community list */
async function rememberedDrone(): Promise<DroneSpec> {
  const id = lastDroneId();
  const own = FEATURED.find(s => s.id === id);
  if (own) return own;
  try { const c = (await listCustomDrones()).find(s => s.id === id); if (c) return c; } catch { /* storage blocked */ }
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 2500);
    const list = await fetch(import.meta.env.BASE_URL + 'community/index.json', { signal: ctl.signal }).then(r => r.ok ? r.json() : []);
    clearTimeout(t);
    const hit = (Array.isArray(list) ? list : []).filter(looksLikeDrone).map(validateSpec).find(s => s.id === id);
    if (hit) return hit;
  } catch { /* offline */ }
  return featured('dscan');
}

async function boot() {
  if (location.hash.includes('debug')) (await import('./debug')).installDebug();
  step(0.1);
  try { await document.fonts.load('40px Audiowide'); } catch { /* font optional */ }
  step(0.25);
  await new Promise(r => setTimeout(r, 30));
  const canvas = document.getElementById('gl') as HTMLCanvasElement;
  let game: Game;
  try {
    game = new Game(canvas);
  } catch (e) {
    fail('WebGL is not available', 'DRONE ON needs hardware accelerated graphics. Turn on hardware acceleration in your browser settings, or try Chrome, Edge, Firefox or Safari on a recent device.', e);
    return;
  }
  try {
    step(0.5);
    const spec = await rememberedDrone();
    game.chosenSpec = spec;
    await game.setDrone(spec);
    step(0.75);
    await game.warmup();
    step(0.9);
    const ui = new UI(game);
    (window as unknown as { droneon: unknown }).droneon = { game, ui };
    // dev only: QA rigs in tools/ render with the same THREE instance
    if (import.meta.env.DEV) (window as unknown as { THREE: unknown }).THREE = THREE;
    game.start();
    const raw = await mapFromHash();
    // a friend's course only counts when at least one piece survives the checks
    const shared = raw ? sanitizeMap(raw) : null;
    await game.enterMenu();
    if (roomFromHash()) setTimeout(() => ui.openSheet('squad'), 200);
    else if (shared && shared.pieces.length) {
      game.toast(`Shared course: ${shared.name}`);
      await game.startFreeFlight(shared);
    } else if (/map=/.test(location.hash)) game.toast('That course link is damaged');
  } catch (e) {
    fail('Something went wrong while loading', 'Saved data on this device might be damaged. Resetting clears your own drones and courses on this device, then the game loads fresh.', e, true);
    return;
  }
  step(1);
  setTimeout(() => bootEl().classList.add('gone'), 120);
  // audio needs a gesture
  const unlock = () => { audio.start(); removeEventListener('pointerdown', unlock); removeEventListener('keydown', unlock); };
  addEventListener('pointerdown', unlock); addEventListener('keydown', unlock);
  if ('serviceWorker' in navigator && import.meta.env.PROD) navigator.serviceWorker.register(import.meta.env.BASE_URL + 'sw.js').catch(() => { /* offline mode optional */ });
}

boot();
