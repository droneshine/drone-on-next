import type { Game } from '../game/game';
import type { UI } from '../ui/ui';
import { audio } from '../audio/audio';
import { standaloneHeadset } from './caps';

// VR entry point, called once at boot after the UI exists. Adds ENTER VR to the main menu and the
// pause menu, but only where the browser can really open an immersive VR session (Quest Browser,
// a PC headset). Phones stay as they are, even where Chrome offers a Cardboard session: their
// players fly with touch sticks that a VR view would hide. Everything heavy (controller models,
// the VR loop) loads on demand.

type VrModule = typeof import('./vr');

export function installXR(game: Game, ui: UI) {
  const xr = (navigator as Navigator & { xr?: XRSystem }).xr;
  if (!xr || typeof xr.isSessionSupported !== 'function') return;

  let mod: Promise<VrModule> | null = null;
  const load = () => (mod ??= import('./vr'));
  let mode: InstanceType<VrModule['VrMode']> | null = null;
  let supported = false;
  let pending = false;
  let warmed = false;

  const el = (html: string) => { const t = document.createElement('template'); t.innerHTML = html.trim(); return t.content.firstElementChild as HTMLButtonElement; };
  const cmd = el(`<button class="cmd" data-xr="enter" hidden><b>ENTER VR</b><small>Stand on the field and fly it in your headset</small><i class="ph ph-virtual-reality"></i></button>`);
  // right under FLY: on a headset this is the way to play
  const fly = ui.rail.querySelector('[data-go=fly]');
  if (fly) fly.after(cmd); else (ui.rail.querySelector('.cmds') ?? ui.rail).append(cmd);
  const pauseBtn = el(`<button data-xr="enter" hidden>Enter VR <i class="ph ph-virtual-reality"></i></button>`);
  const list = ui.pauseEl.querySelector('.list') ?? ui.pauseEl;
  const before = list.querySelector('[data-p=hangar]');
  if (before) before.before(pauseBtn); else list.append(pauseBtn);

  // build mode stays on the flat screen
  const sync = () => { cmd.hidden = !supported; pauseBtn.hidden = !supported || game.state === 'build'; };
  game.on('pause', sync);
  game.on('state', sync);

  const phone = !standaloneHeadset() && matchMedia('(pointer: coarse)').matches;
  const check = () => xr.isSessionSupported('immersive-vr').then(ok => {
    supported = ok && !phone; sync();
    if (supported && !warmed) {
      warmed = true;
      // fetch the VR code now and compile its shaders while the menu idles, so the first VR frame is quick
      load().then(m => setTimeout(() => m.prewarm(game), 1500)).catch(() => { /* loads again on click */ });
    }
  }).catch(() => { supported = false; sync(); });
  xr.addEventListener?.('devicechange', check);
  check();

  const enter = (e: Event) => {
    e.preventDefault();
    if (pending || mode?.session) return;
    pending = true;
    audio.start(); audio.tick();
    // the session request has to happen inside the click, before anything else is awaited
    const request = xr.requestSession('immersive-vr', { optionalFeatures: ['local-floor', 'layers'] });
    Promise.all([request, load()]).then(async ([session, m]) => {
      if (!mode) { mode = new m.VrMode(game, ui); game.xr = mode; }
      await mode.start(session);
    }).catch(err => {
      console.warn('VR session refused', err);
      game.toast('VR did not start. Check that the headset is on, then try ENTER VR again.');
    }).finally(() => { pending = false; });
  };
  cmd.addEventListener('click', enter);
  pauseBtn.addEventListener('click', enter);
}
