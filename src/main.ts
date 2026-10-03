import './ui/style.css';
import * as THREE from 'three';
import { Game } from './game/game';
import { UI, mapFromHash, lastDroneId } from './ui/ui';
import { FEATURED, featured } from './sim/spec';
import { listCustomDrones } from './game/store';
import { audio } from './audio/audio';

const bar = document.querySelector<HTMLElement>('.boot-bar i')!;
const step = (p: number) => { bar.style.setProperty('--p', String(p)); };

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
    document.getElementById('boot')!.innerHTML = `<div style="max-width:420px;text-align:center;line-height:1.6;padding:24px"><h2 style="font-family:Nasalization,Audiowide,sans-serif;font-weight:400;font-size:28px;margin-bottom:10px">WebGL is not available</h2><p style="color:rgba(247,247,242,.7)">DRONE ON needs hardware accelerated graphics. Turn on hardware acceleration in your browser settings, or try Chrome, Edge, Firefox or Safari on a recent device.</p></div>`;
    console.error(e);
    return;
  }
  step(0.7);
  const id = lastDroneId();
  const custom = await listCustomDrones();
  const spec = [...FEATURED, ...custom].find(s => s.id === id) ?? featured('dscan');
  await game.setDrone(spec);
  step(0.9);
  const ui = new UI(game);
  (window as unknown as { droneon: unknown }).droneon = { game, ui };
  // dev only: QA rigs in tools/ render with the same THREE instance
  if (import.meta.env.DEV) (window as unknown as { THREE: unknown }).THREE = THREE;
  game.start();
  const shared = await mapFromHash();
  const { roomFromHash } = await import('./ui/mpui');
  if (roomFromHash()) setTimeout(() => ui.openSheet('squad'), 200);
  await game.enterMenu();
  if (shared) {
    game.toast(`Shared course: ${shared.name}`);
    const go = () => { audio.start(); removeEventListener('pointerdown', go); removeEventListener('keydown', go); };
    addEventListener('pointerdown', go); addEventListener('keydown', go);
    game.startFreeFlight(shared);
  }
  step(1);
  setTimeout(() => document.getElementById('boot')!.classList.add('gone'), 120);
  // audio needs a gesture
  const unlock = () => { audio.start(); removeEventListener('pointerdown', unlock); removeEventListener('keydown', unlock); };
  addEventListener('pointerdown', unlock); addEventListener('keydown', unlock);
  if ('serviceWorker' in navigator && import.meta.env.PROD) navigator.serviceWorker.register(import.meta.env.BASE_URL + 'sw.js').catch(() => { /* offline mode optional */ });
}

boot();
