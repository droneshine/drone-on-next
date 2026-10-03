import * as THREE from 'three';
import { Game } from '../game/game';
import { DroneSpec, FEATURED, featured, looksLikeDrone, motorCount, validateSpec } from '../sim/spec';
import { listCustomDrones, saveCustomDrone, deleteCustomDrone, progress, downloadFile, readFileAs, encodeShare, decodeShare, getLS } from '../game/store';
import { PIECES, MapData, starterMap } from '../game/builder';
import { rawAxes } from '../input/input';
import { parseGlb } from '../render/droneModels';
import { audio } from '../audio/audio';
import { SquadUI } from './mpui';

const BASE = import.meta.env.BASE_URL;
const REPO = 'https://github.com/droneshine/drone-on';

const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
const $ = <T extends HTMLElement = HTMLElement>(sel: string, root: ParentNode = document) => root.querySelector(sel) as T;
const $$ = <T extends HTMLElement = HTMLElement>(sel: string, root: ParentNode = document) => [...root.querySelectorAll(sel)] as T[];
const el = (html: string) => { const t = document.createElement('template'); t.innerHTML = html.trim(); return t.content.firstElementChild as HTMLElement; };
const isField = (t: EventTarget | null) => !!(t as HTMLElement | null)?.closest?.('input,textarea,select,[contenteditable]');
const coarse = () => matchMedia('(pointer: coarse)').matches;

const PIECE_ICON: Record<string, string> = {
  ring: 'ph-circle', bigring: 'ph-circle-dashed', gate: 'ph-door', cube: 'ph-cube', platform: 'ph-square', ramp: 'ph-trend-up', pillar: 'ph-cylinder',
  wall: 'ph-wall', container: 'ph-package', panels: 'ph-solar-panel', tree: 'ph-tree-evergreen', flag: 'ph-flag-checkered',
};

/** derived numbers for a spec, shown in hangar and editor */
export function derive(s: DroneSpec) {
  const n = motorCount(s.layout);
  const payload = s.tool === 'sprayDown' ? (s.tank ?? 0) : 0;
  const tw = (n * s.maxThrust) / ((s.mass + payload) * 9.81);
  const R = s.propDiameter / 2, A = Math.PI * R * R;
  const T = (s.mass + payload) * 9.81 / n;
  const eta = 0.35 + 0.25 * Math.min(1, s.propDiameter / 0.8);
  const P = n * Math.pow(T, 1.5) / Math.sqrt(2 * 1.225 * A) / eta * (s.layout === 'coaxX8' ? 1.18 : 1) + 6 + s.mass * 0.4;
  const wh = s.battery.cells * 3.7 * s.battery.capacityAh * 0.85;
  const hoverMin = wh / P * 60;
  return { tw, hoverMin, motors: n, weight: s.mass + payload };
}

/** 22 g reads as grams, a 90 kg sprayer as kilograms */
export function fmtMass(kg: number) { return kg < 1 ? `${Math.round(kg * 1000)} g` : kg < 10 ? `${kg.toFixed(1)} kg` : `${kg.toFixed(0)} kg`; }

export class UI {
  root = $('#ui');
  rail!: HTMLElement; specLine!: HTMLElement;
  sheets: Record<string, HTMLElement> = {};
  hud!: HTMLElement; build!: HTMLElement; touch!: HTMLElement;
  pauseEl!: HTMLElement; resultEl!: HTMLElement; crashEl!: HTMLElement;
  toastsEl!: HTMLElement;
  custom: DroneSpec[] = [];
  community: DroneSpec[] = [];
  private calib: { min: number[]; max: number[]; center: number[] } | null = null;
  private editing: DroneSpec | null = null;
  private previewTimer = 0;
  private settingsLoop = 0;
  private settingsDevice = '';
  private lastTape = -1;
  private lastDevice = '';
  private pauseOpenedAt = 0;
  squad!: SquadUI;

  constructor(private g: Game) {
    this.buildDom();
    g.on('state', () => this.syncState());
    g.on('toast', (t) => this.toast(String(t)));
    g.on('pause', (p) => this.showPause(!!p));
    g.on('frame', () => { this.frame(); this.squad.frame(); this.padNav(); this.watchDevice(); });
    g.on('crash', () => { this.crashEl.classList.add('on'); });
    g.on('build-select', () => this.syncBuildBar());
    g.on('build-changed', () => { if (g.state === 'build') this.syncBuildBar(); });
    g.on('drone', () => { this.syncToolButtons(); this.renderSpecLine(); this.renderHint(); this.syncKnobs(); });
    g.on('mode', () => this.syncKnobs());
    this.loadCustom();
    fetch(BASE + 'community/index.json').then(r => r.ok ? r.json() : []).then((list: unknown) => {
      this.community = (Array.isArray(list) ? list : []).filter(looksLikeDrone).map(validateSpec);
      this.renderHangar();
    }).catch(() => { /* offline */ });
    const canvas = $('#gl');
    // build mode: a mouse click places, a finger on the field only looks around (touch has its own buttons)
    canvas.addEventListener('pointerdown', e => { if (g.state === 'build' && e.pointerType !== 'touch') g.input.uiClick = e.button === 0 ? 0 : e.button === 1 ? 1 : -1; });
    canvas.addEventListener('contextmenu', e => e.preventDefault());
    // capture runs before the game sees the key, so a sheet can take Esc for itself
    addEventListener('keydown', e => this.onKey(e), true);
  }

  async loadCustom() { this.custom = await listCustomDrones(); this.renderHangar(); }

  private onKey(e: KeyboardEvent) {
    const g = this.g;
    if ((e.target as HTMLElement)?.closest?.('.chat')) return;
    if (e.code === 'F1') {
      e.preventDefault();
      if (g.state === 'fly' || g.state === 'mission') $('.hint', this.hud).toggleAttribute('hidden');
      return;
    }
    if (e.code === 'KeyO' && !isField(e.target) && !e.ctrlKey && !e.metaKey && (g.state === 'fly' || g.state === 'mission') && !coarse()) {
      g.settings.joystick = !g.settings.joystick; g.saveSettings(); this.syncJoystick();
      this.toast(g.settings.joystick ? 'On screen joystick on' : 'On screen joystick off, O brings it back');
      return;
    }
    if (e.code === 'Escape') {
      const open = Object.entries(this.sheets).find(([, s]) => s.classList.contains('open'));
      if (open) {
        e.preventDefault(); e.stopPropagation();
        audio.tick();
        if (open[0] === 'editor') this.leaveEditor(); else this.closeSheets();
        return;
      }
      if (isField(e.target)) {
        // a slider or field had focus: Esc still pauses
        (e.target as HTMLElement).blur();
        if (g.state === 'fly' || g.state === 'mission' || g.state === 'build') g.input.pressed.add('Escape');
      }
    }
  }

  // ================================================================ DOM
  private buildDom() {
    const g = this.g;
    this.rail = el(`
      <nav class="rail live" aria-label="Main menu">
        <img class="lockup" src="${BASE}img/lockup_white.png" alt="DroneShine" />
        <h1 class="title">DRONE<br><span>ON</span></h1>
        <p class="lede">A free drone sim sandbox. Fly real industrial drones, train real missions, build your own Spielwiese.</p>
        <div class="cmds">
          <button class="cmd primary" data-go="fly"><b>FLY</b><small>Free flight on the field, your course included</small><i class="ph ph-arrow-right"></i></button>
          <button class="cmd" data-go="squad"><b>SQUAD</b><small>Fly, race and build with friends in one room</small><i class="ph ph-arrow-right"></i></button>
          <button class="cmd" data-go="train"><b>TRAIN</b><small>Eight missions from first hover to turbine inspection</small><i class="ph ph-arrow-right"></i></button>
          <button class="cmd" data-go="build"><b>BUILD</b><small>Place rings, gates and ramps, share the link</small><i class="ph ph-arrow-right"></i></button>
          <button class="cmd" data-go="hangar"><b>HANGAR</b><small>Pick a drone or upload your own</small><i class="ph ph-arrow-right"></i></button>
          <button class="cmd" data-go="settings"><b>SETTINGS</b><small>Controller, RC transmitter, rates, world</small><i class="ph ph-arrow-right"></i></button>
        </div>
        <div class="rail-foot"><span>Free for every pilot</span><a href="${REPO}" target="_blank" rel="noopener">Open source on GitHub</a><a href="https://droneshine.de" target="_blank" rel="noopener">droneshine.de</a></div>
      </nav>`);
    this.specLine = el(`<div class="spec-line"></div>`);
    this.root.append(this.rail, this.specLine);
    this.rail.addEventListener('click', e => {
      const b = (e.target as HTMLElement).closest<HTMLElement>('[data-go]');
      if (!b) return;
      audio.start(); audio.tick();
      const go = b.dataset.go!;
      if (go === 'fly') g.startFreeFlight();
      else if (go === 'build') g.enterBuild();
      else this.openSheet(go);
    });

    // sheets
    for (const [id, title] of [['squad', 'Squad'], ['train', 'Train'], ['hangar', 'Hangar'], ['settings', 'Settings'], ['editor', 'Upload a drone']]) {
      const s = el(`<section class="sheet live" data-sheet="${id}" aria-label="${title}" inert><header><button class="back" aria-label="Back"><i class="ph ph-arrow-left"></i></button><h2>${title}</h2><div class="grow"></div></header><div class="body"></div></section>`);
      $('.back', s).addEventListener('click', () => { audio.tick(); id === 'editor' ? this.leaveEditor() : this.closeSheets(); });
      this.root.append(s); this.sheets[id] = s;
    }

    // hud
    this.hud = el(`
      <div class="hud">
        <div class="tl"><div class="mode-chip"><b class="m">GPS</b><span class="a">DISARMED</span></div><div class="mission-name"></div><div class="objectives"></div></div>
        <div class="tc"><div class="big"></div><div class="tape"><div class="strip"></div></div></div>
        <div class="tr"><div class="batt"><b>100%</b><div class="v"></div><div class="tank"></div></div></div>
        <div class="bl">
          <div class="tel"><b class="t-alt">0.0</b><span>ALT M</span></div>
          <div class="tel"><b class="t-spd">0</b><span>KM/H</span></div>
          <div class="tel"><b class="t-vz">0.0</b><span>V/S M/S</span></div>
          <div class="tel"><b class="t-dst">0</b><span>HOME M</span></div>
          <div class="tel"><b class="t-wnd">0.0 <i class="ph ph-arrow-up wind-arrow"></i></b><span>WIND M/S</span></div>
        </div>
        <div class="hint"></div>
        <div class="br"><div class="stick s-l"><i></i></div><div class="stick s-r"><i></i></div></div>
        <div class="cross"></div>
        <div class="thermal-bar"><div class="grad"></div><div class="lbl"><span class="num">68 °C</span><span class="num">40 °C</span><span class="num">12 °C</span></div></div>
        <div class="marker-label" hidden></div>
      </div>`);
    this.crashEl = el(`<div class="crash"><h2>CRASH</h2><p class="why"></p><p class="dim how"></p></div>`);
    this.build = el(`
      <div class="build" inert>
        <div class="top live">
          <input class="map-name" type="text" maxlength="40" aria-label="Map name" enterkeyhint="done" />
          <div class="grow"></div>
          <button class="btn small line" data-b="race"><i class="ph ph-flag-checkered"></i><span>Race on</span></button>
          <button class="btn small line" data-b="share"><i class="ph ph-link"></i>Share link</button>
          <button class="btn small line" data-b="export"><i class="ph ph-download-simple"></i>Export</button>
          <button class="btn small line" data-b="import"><i class="ph ph-upload-simple"></i>Import</button>
          <button class="btn small line" data-b="clear"><i class="ph ph-trash"></i>Clear</button>
          <button class="btn small go" data-b="fly"><i class="ph-fill ph-play"></i>Test fly</button>
          <button class="btn small line" data-b="menu" aria-label="Menu"><i class="ph ph-list"></i></button>
        </div>
        <div class="help"><kbd>Click</kbd> place &nbsp; <kbd>X</kbd> or middle click delete &nbsp; <kbd>R</kbd> rotate<br><kbd>Wheel</kbd> height &nbsp; <kbd>Alt</kbd> + <kbd>Wheel</kbd> size &nbsp; <kbd>Ctrl</kbd> + <kbd>Z</kbd> undo<br><kbd>WASD</kbd> move &nbsp; <kbd>Q</kbd> <kbd>E</kbd> down, up &nbsp; hold right mouse to look &nbsp; <kbd>Shift</kbd> fast<br>Rings and gates become the race course in the order you place them</div>
        <div class="count"></div>
        <div class="bar live"></div>
        <div class="cross on"></div>
      </div>`);
    this.touch = el(`
      <div class="touch" inert>
        <div class="joy l live" aria-label="Left stick, up down and turn"><div class="joy-base"><i class="ph ph-caret-up a-n"></i><i class="ph ph-caret-down a-s"></i><i class="ph ph-arrow-counter-clockwise a-w"></i><i class="ph ph-arrow-clockwise a-e"></i><b class="knob"></b></div><span class="lbl-fly">UP, DOWN, TURN</span><span class="lbl-build">MOVE</span></div>
        <div class="joy r live" aria-label="Right stick, forward back and sideways"><div class="joy-base"><i class="ph ph-caret-up a-n"></i><i class="ph ph-caret-down a-s"></i><i class="ph ph-caret-left a-w"></i><i class="ph ph-caret-right a-e"></i><b class="knob"></b></div><span class="lbl-fly">FORWARD, BACK, SIDEWAYS</span><span class="lbl-build">LOOK</span></div>
        <div class="tbtns">
          <button data-t="spray" aria-label="Spray"><i class="ph ph-drop"></i></button>
          <button data-t="cam" aria-label="Camera"><i class="ph ph-video-camera"></i></button>
          <button data-t="mode" aria-label="Flight mode"><i class="ph ph-gauge"></i></button>
          <button data-t="thermal" aria-label="Thermal"><i class="ph ph-thermometer-hot"></i></button>
          <button data-t="tag" aria-label="Tag hotspot"><i class="ph ph-crosshair"></i></button>
          <button data-t="reset" aria-label="Reset"><i class="ph ph-arrow-counter-clockwise"></i></button>
        </div>
        <div class="tbuild">
          <button data-tb="place" class="go" aria-label="Place piece"><i class="ph ph-plus"></i></button>
          <button data-tb="delete" aria-label="Delete piece"><i class="ph ph-eraser"></i></button>
          <button data-tb="rotate" aria-label="Rotate piece"><i class="ph ph-arrow-clockwise"></i></button>
          <button data-tb="undo" aria-label="Undo"><i class="ph ph-arrow-u-up-left"></i></button>
          <button data-tb="higher" aria-label="Piece higher"><i class="ph ph-arrow-line-up"></i></button>
          <button data-tb="lower" aria-label="Piece lower"><i class="ph ph-arrow-line-down"></i></button>
          <button data-tb="up" aria-label="Camera up"><i class="ph ph-caret-double-up"></i></button>
          <button data-tb="down" aria-label="Camera down"><i class="ph ph-caret-double-down"></i></button>
        </div>
        <button class="tpause" data-t="pause" aria-label="Pause"><i class="ph ph-pause"></i></button>
      </div>`);
    this.pauseEl = el(`<div class="overlay live" inert><div class="box" role="dialog" aria-modal="true" aria-label="Paused"><h2>Paused</h2><div class="list">
      <button data-p="resume">Resume <i class="ph ph-play"></i></button>
      <button data-p="restart">Restart <i class="ph ph-arrow-counter-clockwise"></i></button>
      <button data-p="invite" class="mp-only">Invite friends <i class="ph ph-link"></i></button>
      <button data-p="race" class="mp-only">Start race <i class="ph ph-flag-checkered"></i></button>
      <button data-p="hangar">Change drone <i class="ph ph-drone"></i></button>
      <button data-p="settings">Settings <i class="ph ph-sliders"></i></button>
      <button data-p="menu">Main menu <i class="ph ph-house"></i></button></div></div></div>`);
    this.resultEl = el(`<div class="overlay live" inert><div class="box" role="dialog" aria-modal="true" aria-label="Result"></div></div>`);
    this.toastsEl = el(`<div class="toasts" aria-live="polite"></div>`);
    this.root.append(this.hud, this.crashEl, this.build, this.touch, this.pauseEl, this.resultEl, this.toastsEl);

    this.pauseEl.addEventListener('click', e => {
      const b = (e.target as HTMLElement).closest<HTMLElement>('[data-p]');
      // a tap on the backdrop closes the menu, but never the same tap that opened it
      if (!b) { if (e.target === this.pauseEl && performance.now() - this.pauseOpenedAt > 450) this.resume(); return; }
      audio.tick();
      const p = b.dataset.p;
      if (p === 'resume') this.resume();
      if (p === 'restart') { this.resume(); if (g.state === 'mission' || g.mission) g.restartMission(); else { g.resetDrone(); g.resetRace(); } }
      if (p === 'menu') { this.resume(); g.enterMenu(); }
      if (p === 'hangar') { this.resume(); g.enterMenu().then(() => this.openSheet('hangar')); }
      if (p === 'settings') { this.openSheet('settings'); }
      if (p === 'invite') this.squad.copyInvite();
      if (p === 'race') { this.resume(); g.mp?.startRace(); }
    });

    this.squad = new SquadUI(g, this.root, t => this.toast(t), () => { this.closeSheets(); if (g.state !== 'fly') g.startFreeFlight(); });
    this.wireBuild();
    this.wireTouch();
    this.renderTrain();
    this.renderSettings();
    this.syncToolButtons();
  }

  private resume() { this.g.paused = false; this.showPause(false); }

  showPause(on: boolean) {
    const g = this.g;
    if (on) this.pauseOpenedAt = performance.now();
    this.pauseEl.classList.toggle('open', on);
    for (const b of $$('.mp-only', this.pauseEl)) b.hidden = !g.mp;
    // restarting a build session means nothing
    $('[data-p=restart]', this.pauseEl).hidden = g.state === 'build';
    $('[data-p=race]', this.pauseEl).hidden = !g.mp || g.state !== 'fly' || !g.mp.isHost();
    if (!on) this.closeSheets();
    this.syncInert();
    if (on && (g.input.device === 'keyboard' || g.input.device === 'gamepad')) $<HTMLButtonElement>('[data-p=resume]', this.pauseEl).focus();
  }

  openSheet(id: string) {
    for (const [k, s] of Object.entries(this.sheets)) s.classList.toggle('open', k === id);
    this.rail.classList.add('hide');
    // a sheet opened from the pause menu sits in front of it, the pause menu comes back on close
    this.pauseEl.classList.remove('open');
    this.specLine.style.opacity = id === 'hangar' || id === 'editor' ? '1' : '0';
    if (id === 'squad') this.squad.renderLobby($('.body', this.sheets.squad));
    if (id === 'train') this.renderTrain();
    if (id === 'hangar') this.renderHangar();
    if (id === 'settings') this.renderSettings();
    this.syncInert();
    $<HTMLElement>('.back', this.sheets[id]).focus({ preventScroll: true });
  }

  closeSheets() {
    for (const s of Object.values(this.sheets)) s.classList.remove('open');
    cancelAnimationFrame(this.settingsLoop);
    if (this.g.paused && (this.g.state === 'fly' || this.g.state === 'mission' || this.g.state === 'build')) this.pauseEl.classList.add('open');
    if (this.g.state === 'menu') { this.rail.classList.remove('hide'); this.specLine.style.opacity = '1'; }
    this.syncInert();
  }

  /** hidden layers leave the tab order and the accessibility tree, and give up focus */
  private syncInert() {
    const st = this.g.state;
    const set = (e: HTMLElement, off: boolean) => { e.inert = off; };
    set(this.rail, this.rail.classList.contains('hide') || st !== 'menu');
    for (const s of Object.values(this.sheets)) set(s, !s.classList.contains('open'));
    set(this.pauseEl, !this.pauseEl.classList.contains('open'));
    set(this.resultEl, !this.resultEl.classList.contains('open'));
    set(this.build, st !== 'build');
    set(this.touch, !this.touch.classList.contains('on'));
    const a = document.activeElement as HTMLElement | null;
    if (a && a !== document.body && a.closest('[inert]')) a.blur();
  }

  syncState() {
    const st = this.g.state;
    const menu = st === 'menu';
    this.rail.classList.toggle('hide', !menu);
    this.specLine.style.display = menu ? '' : 'none';
    if (menu) this.specLine.style.opacity = '1';
    if (!menu) for (const s of Object.values(this.sheets)) s.classList.remove('open');
    if (!menu) cancelAnimationFrame(this.settingsLoop);
    this.hud.classList.toggle('on', st === 'fly' || st === 'mission');
    this.build.classList.toggle('on', st === 'build');
    if ((st === 'fly' || st === 'mission' || st === 'build') && coarse() && this.g.input.device === 'keyboard') this.g.input.device = 'touch';
    this.syncJoystick();
    this.crashEl.classList.remove('on');
    this.resultEl.classList.toggle('open', st === 'result');
    this.pauseEl.classList.toggle('open', this.g.paused);
    if (st === 'result') this.renderResult();
    if (st === 'build') { ($('.map-name', this.build) as HTMLInputElement).value = this.g.builder.map.name; this.syncBuildBar(); }
    this.renderSpecLine();
    this.renderHint();
    this.syncToolButtons();
    this.syncInert();
    // nothing keeps keyboard focus across a screen change, so Enter never fires a hidden button
    if (st !== 'menu') (document.activeElement as HTMLElement | null)?.blur?.();
    if (st === 'result') $<HTMLElement>('.box [data-r]', this.resultEl)?.focus({ preventScroll: true });
  }

  // ================================================================ menu spec line
  renderSpecLine() {
    const s = this.g.spec;
    const d = derive(s);
    this.specLine.innerHTML = `
      <div class="name">${esc(s.name)}</div>
      <p class="tag">${esc(s.tagline)}</p>
      <div class="facts">
        <div class="fact"><b>${fmtMass(d.weight)}</b><span>TAKE OFF MASS</span></div>
        <div class="fact"><b>${d.tw.toFixed(1)}</b><span>THRUST TO WEIGHT</span></div>
        <div class="fact"><b>${d.hoverMin.toFixed(0)} min</b><span>HOVER, CALCULATED</span></div>
        <div class="fact"><b>${s.defaultMode.toUpperCase()}</b><span>DEFAULT MODE</span></div>
      </div>`;
  }

  // ================================================================ train
  renderTrain() {
    const body = $('.body', this.sheets.train);
    const p = progress();
    const total = Object.values(p.stars).reduce((a, b) => a + b, 0);
    body.innerHTML = `<p class="note">Each mission trains one real skill. Solar Shift, Facade Pro and Hotspot Hunt are the jobs DroneShine pilots fly every week. ${total} of ${this.g.missions.length * 3} stars earned.</p>`;
    for (const m of this.g.missions) {
      const st = p.stars[m.id] ?? 0;
      const best = p.best[m.id];
      const spec = featured(m.drone);
      const row = el(`
        <div class="mission">
          <button aria-expanded="false"><h3>${esc(m.title)}</h3><span class="meta">${esc(m.skill)}, ${esc(spec.name)}${best ? `, best ${best.toFixed(1)} s` : ''}</span>
            <span class="stars" aria-label="${st} of 3 stars">${[0, 1, 2].map(i => `<i class="${i < st ? 'ph-fill ph-star on' : 'ph ph-star'}"></i>`).join('')}</span></button>
          <div class="more"><div><p class="brief">${esc(m.brief)}</p><div class="row"><button class="btn go start" tabindex="-1"><i class="ph-fill ph-play"></i>Start mission</button></div></div></div>
        </div>`);
      $('button', row).addEventListener('click', () => {
        const open = !row.classList.contains('open');
        $$('.mission', body).forEach(x => { x.classList.remove('open'); $('button', x).setAttribute('aria-expanded', 'false'); $('.start', x).tabIndex = -1; });
        row.classList.toggle('open', open);
        $('button', row).setAttribute('aria-expanded', String(open));
        $('.start', row).tabIndex = open ? 0 : -1;
        audio.tick();
      });
      $('.start', row).addEventListener('click', () => { audio.start(); this.g.startMission(m); });
      body.append(row);
    }
  }

  // ================================================================ hangar
  renderHangar() {
    const s = this.sheets.hangar;
    if (!s) return;
    const g = this.g;
    const body = $('.body', s);
    const cur = g.chosenSpec.id;
    const row = (d: DroneSpec, kind: 'featured' | 'custom' | 'community') => {
      const dv = derive(d);
      const r = el(`
        <div class="drone-row ${d.id === cur ? 'sel' : ''}">
          <button class="pick" aria-pressed="${d.id === cur}"><h3><span>${esc(d.name)}</span> <small>${esc(d.author)}</small></h3><p>${esc(d.tagline)}</p>
          <p class="num stats">${fmtMass(dv.weight)} &nbsp; ${dv.motors} motors &nbsp; T/W ${dv.tw.toFixed(1)} &nbsp; ${dv.hoverMin.toFixed(0)} min</p></button>
          <div class="acts"></div>
        </div>`);
      $('.pick', r).addEventListener('click', async () => {
        audio.tick();
        await g.chooseDrone(d);
        this.renderHangar(); this.renderSpecLine();
        $<HTMLElement>('.drone-row.sel .pick', body)?.focus({ preventScroll: true });
      });
      const acts = $('.acts', r);
      const act = (icon: string, label: string, fn: () => void) => { const b = el(`<button class="icon-btn" aria-label="${label}" title="${label}"><i class="ph ${icon}"></i></button>`); b.addEventListener('click', fn); acts.append(b); };
      if (kind === 'custom') {
        act('ph-pencil-simple', 'Edit', () => this.openEditor(d));
        act('ph-download-simple', 'Export', () => downloadFile(`${d.id}.droneon.json`, JSON.stringify(d, null, 2)));
        act('ph-trash', 'Delete', async () => {
          if (!confirm(`Delete ${d.name}?`)) return;
          await deleteCustomDrone(d.id);
          // the drone on the pad goes with it
          if (g.chosenSpec.id === d.id) await g.chooseDrone(featured('dscan'));
          await this.loadCustom(); this.renderSpecLine();
        });
      } else if (kind === 'community') {
        act('ph-plus', 'Add to my hangar', async () => {
          if (this.custom.some(c => c.id === d.id + '-c')) { this.toast(`${d.name} is already in your hangar`); return; }
          await saveCustomDrone({ ...d, id: d.id + '-c' }); this.loadCustom(); this.toast(`${d.name} added`);
        });
      } else {
        act('ph-copy', 'Use as template', () => this.openEditor({ ...d, id: 'custom-' + Math.random().toString(36).slice(2, 7), name: (d.name + ' custom').slice(0, 32), author: 'Pilot', featured: false, model: 'generic' }, true));
      }
      return r;
    };
    body.innerHTML = '';
    body.append(el(`<p class="note">Selecting a drone puts it on the pad behind this panel. DSolar, DShine and DScan fly with the real masses and tools of our machines.</p>`));
    body.append(el(`<h3 class="group-h">Featured</h3>`));
    for (const d of FEATURED) body.append(row(d, 'featured'));
    body.append(el(`<h3 class="group-h">Your drones</h3>`));
    if (!this.custom.length) body.append(el(`<p class="note">Nothing here yet. Upload a GLB model with its specs, or start from a featured drone with the copy button.</p>`));
    for (const d of this.custom) body.append(row(d, 'custom'));
    const actions = el(`<div class="row" style="display:flex;gap:10px;margin-top:16px;flex-wrap:wrap"><button class="btn go"><i class="ph ph-upload-simple"></i>Upload a drone</button><button class="btn line imp"><i class="ph ph-file-arrow-up"></i>Import drone file</button></div>`);
    $('.go', actions).addEventListener('click', () => this.openEditor(null));
    $('.imp', actions).addEventListener('click', () => this.pickFile('.json,.droneon', async f => {
      try {
        if (f.size > 40e6) throw 0;
        const raw = JSON.parse(await readFileAs(f, 'text'));
        if (!looksLikeDrone(raw)) throw 0;
        const spec = validateSpec(raw);
        if (spec.glb) { try { await parseGlb(spec.glb); } catch { spec.glb = undefined; this.toast('The model inside could not be read, using a built body'); } }
        if (this.custom.some(c => c.id === spec.id) && !confirm(`${spec.name} is already in your hangar. Replace it?`)) return;
        await saveCustomDrone(spec); await this.loadCustom(); this.toast(`${spec.name} imported`);
      } catch { this.toast('That file is not a DRONE ON drone'); }
    }));
    body.append(actions);
    if (this.community.length) {
      body.append(el(`<h3 class="group-h">Community</h3>`));
      for (const d of this.community) body.append(row(d, 'community'));
    }
    body.append(el(`<p class="note" style="margin-top:22px">Want your drone featured for everyone? Open a pull request with your drone file on <a href="${REPO}" target="_blank" rel="noopener" style="color:var(--lg)">GitHub</a>.</p>`));
  }

  private pickFile(accept: string, fn: (f: File) => void) {
    const i = document.createElement('input'); i.type = 'file'; i.accept = accept;
    i.onchange = () => { if (i.files?.[0]) fn(i.files[0]); };
    i.click();
  }

  // ================================================================ editor
  openEditor(spec: DroneSpec | null, fromTemplate = false) {
    const base = spec ?? { name: 'My drone', author: 'Pilot', tagline: 'Built at home.', layout: 'quadX', mass: 1.2, armLength: 0.22, propDiameter: 0.23, maxThrust: 9, battery: { cells: 4, capacityAh: 4 }, defaultMode: 'angle', tool: 'camera' };
    // the editor always starts from clean, valid numbers, so what you see is what flies
    const clean = validateSpec(base);
    if (spec?.id) clean.id = spec.id;
    clean.glb = spec?.glb;
    this.editing = clean;
    $('h2', this.sheets.editor).textContent = spec && !fromTemplate ? 'Edit drone' : 'Upload a drone';
    this.openSheet('editor');
    this.renderEditor();
  }

  /** back out of the editor: an unsaved preview never stays on the pad */
  private leaveEditor() {
    clearTimeout(this.previewTimer);
    this.editing = null;
    if (this.g.spec !== this.g.chosenSpec) this.g.setDrone(this.g.chosenSpec);
    this.openSheet('hangar');
  }

  private renderEditor() {
    const s = this.editing!;
    const body = $('.body', this.sheets.editor);
    const num = (k: string, label: string, v: number, min: number, max: number, step: number, unit = '', help = '') =>
      `<div class="field"><label for="f-${k}">${label}<output data-u="${unit}">${v}${unit}</output></label><input id="f-${k}" type="range" data-k="${k}" min="${min}" max="${max}" step="${step}" value="${v}" />${help ? `<span class="help" data-help="${k}">${help}</span>` : ''}</div>`;
    body.innerHTML = `
      <p class="note">Every value drives the physics. The drone on the pad updates as you change it, so you can see your model at real scale next to ours.</p>
      <h3 class="group-h">Identity</h3>
      <div class="fields">
        <div class="field"><label for="f-name">Name</label><input id="f-name" type="text" data-k="name" maxlength="32" value="${esc(s.name)}" /></div>
        <div class="field"><label for="f-author">Builder</label><input id="f-author" type="text" data-k="author" maxlength="40" value="${esc(s.author)}" /></div>
        <div class="field wide"><label for="f-tag">One line about it</label><input id="f-tag" type="text" data-k="tagline" maxlength="140" value="${esc(s.tagline)}" /></div>
        <div class="field"><label for="f-color">Body colour</label><input id="f-color" type="color" data-k="color" value="${s.color}" /></div>
        <div class="field"><label for="f-accent">Accent colour</label><input id="f-accent" type="color" data-k="accent" value="${s.accent}" /></div>
      </div>
      <h3 class="group-h">3D model</h3>
      <div class="fields">
        <div class="drop" tabindex="0" role="button"><i class="ph ph-cube" style="font-size:26px"></i><br>${s.glb ? 'Model loaded. Drop another GLB to replace it.' : 'Drop a GLB file here, or click to choose. Without a model we build one from your specs.'}</div>
        ${s.glb ? `
        ${num('glbScale', 'Model size', s.glbScale ?? 1, 0.05, 20, 0.01, '×', '1 fits the model to the motor span')}
        ${num('glbYaw', 'Model rotation', s.glbYaw ?? 0, -180, 180, 5, '°', 'Turn until the nose points away from the camera')}
        ${num('glbOffsetY', 'Model height offset', s.glbOffsetY ?? 0, -2, 2, 0.01, ' m')}
        <div class="field"><label>&nbsp;</label><button class="btn line small rm-glb" type="button"><i class="ph ph-x"></i>Remove model</button></div>` : ''}
      </div>
      <h3 class="group-h">Airframe</h3>
      <div class="fields">
        <div class="field"><label for="f-layout">Motor layout</label><select id="f-layout" data-k="layout">${[['quadX', 'Quad X'], ['hexX', 'Hex X'], ['octoX', 'Octo X'], ['coaxX8', 'Coaxial X8']].map(([v, l]) => `<option value="${v}" ${s.layout === v ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
        ${num('mass', 'Take off mass, empty', s.mass, 0.015, 200, 0.005, ' kg')}
        ${num('armLength', 'Arm length, centre to motor', s.armLength, 0.02, 2, 0.005, ' m')}
        ${num('propDiameter', 'Prop diameter', s.propDiameter, 0.02, 2, 0.005, ' m', `${(s.propDiameter / 0.0254).toFixed(1)} inch`)}
        ${num('dragArea', 'Drag area', s.dragArea, 0.001, 2, 0.001, ' m²')}
      </div>
      <h3 class="group-h">Power</h3>
      <div class="fields">
        ${num('maxThrust', 'Max thrust per motor', s.maxThrust, 0.05, 2000, 0.05, ' N', `${(s.maxThrust / 9.81).toFixed(2)} kg per motor`)}
        ${num('motorTau', 'Motor spool time', s.motorTau, 0.01, 0.4, 0.005, ' s', 'Big props spin up slowly')}
        ${num('battery.cells', 'Battery cells', s.battery.cells, 1, 24, 1, ' S')}
        ${num('battery.capacityAh', 'Battery capacity', s.battery.capacityAh, 0.1, 100, 0.1, ' Ah')}
      </div>
      <h3 class="group-h">Flight</h3>
      <div class="fields">
        <div class="field"><label for="f-mode">Default mode</label><select id="f-mode" data-k="defaultMode">${[['gps', 'GPS hold'], ['angle', 'Angle'], ['acro', 'Acro']].map(([v, l]) => `<option value="${v}" ${s.defaultMode === v ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
        <div class="field"><label for="f-tool">Tool</label><select id="f-tool" data-k="tool">${[['camera', 'Camera'], ['thermal', 'Thermal camera'], ['sprayDown', 'Spray boom with tank'], ['lance', 'Lance on a ground hose'], ['none', 'None']].map(([v, l]) => `<option value="${v}" ${s.tool === v ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
        ${num('maxTilt', 'Max tilt', s.maxTilt, 10, 80, 1, '°')}
        ${num('maxSpeed', 'GPS max speed', s.maxSpeed, 2, 60, 0.5, ' m/s')}
        ${num('maxClimb', 'GPS max climb', s.maxClimb, 0.5, 20, 0.5, ' m/s')}
        ${num('maxYawRate', 'Yaw rate', s.maxYawRate, 20, 900, 5, '°/s')}
        ${num('rates.rcRate', 'Acro RC rate', s.rates.rcRate, 0.1, 2.5, 0.01)}
        ${num('rates.superRate', 'Acro super rate', s.rates.superRate, 0, 0.95, 0.01)}
        ${num('rates.expo', 'Acro expo', s.rates.expo, 0, 1, 0.01)}
        ${num('camUptilt', 'FPV camera uptilt', s.camUptilt, -60, 60, 1, '°')}
        ${s.tool === 'sprayDown' ? num('tank', 'Tank', s.tank ?? 10, 0.5, 100, 0.5, ' L') + num('flow', 'Flow', s.flow ?? 4, 0.1, 30, 0.1, ' L/min') : ''}
        ${s.tool === 'lance' ? num('flow', 'Flow', s.flow ?? 4, 0.1, 30, 0.1, ' L/min') + `<label class="toggle"><span>Ground hose<br><span class="help dim" style="font-size:12.5px">Fed from a pump at the take off spot, the hose pulls on the drone</span></span><input type="checkbox" data-k="hose" ${s.hose ? 'checked' : ''} /></label>` : ''}
      </div>
      <div class="calc" aria-live="polite"></div>
      <div style="display:flex;gap:10px;flex-wrap:wrap">
        <button class="btn go save"><i class="ph-fill ph-floppy-disk"></i>Save to hangar</button>
        <button class="btn line savefly"><i class="ph-fill ph-play"></i>Save and fly</button>
        <button class="btn line export"><i class="ph ph-download-simple"></i>Export file</button>
      </div>`;
    const calc = $('.calc', body);
    const updateCalc = () => {
      // show the numbers of the drone that will really fly, after the hover safety floor
      const v = validateSpec({ ...s, glb: undefined });
      const d = derive(v);
      const raised = v.maxThrust > s.maxThrust + 1e-6;
      calc.innerHTML = `
        <div class="fact"><b class="${d.tw < 1.5 ? 'bad' : ''}">${d.tw.toFixed(2)}</b><span>THRUST TO WEIGHT${raised ? ', RAISED SO IT CAN HOVER' : d.tw < 1.5 ? ', LOW' : ''}</span></div>
        <div class="fact"><b>${d.hoverMin.toFixed(1)} min</b><span>HOVER TIME, CALCULATED</span></div>
        <div class="fact"><b>${(v.armLength * 2000).toFixed(0)} mm</b><span>WHEELBASE, MOTOR TO MOTOR</span></div>
        <div class="fact"><b>${fmtMass(d.weight)}</b><span>TAKE OFF MASS${v.tool === 'sprayDown' ? ', FULL TANK' : ''}</span></div>`;
    };
    updateCalc();
    const set = (k: string, t: HTMLInputElement) => {
      const path = k.split('.');
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let o: any = s; for (let i = 0; i < path.length - 1; i++) o = o[path[i]];
      const v = t.type === 'checkbox' ? t.checked : ['name', 'author', 'tagline', 'color', 'accent', 'layout', 'defaultMode', 'tool'].includes(k) ? t.value : Number(t.value);
      o[path[path.length - 1]] = v;
    };
    // one handler, replaced on every render, so nothing ever stacks up
    body.oninput = e => {
      const t = e.target as HTMLInputElement;
      const k = t.dataset.k; if (!k) return;
      set(k, t);
      const out = t.parentElement?.querySelector('output');
      if (out) out.textContent = t.value + (out.dataset.u ?? '');
      const help = body.querySelector<HTMLElement>(`[data-help="${k}"]`);
      if (help && k === 'propDiameter') help.textContent = `${(Number(t.value) / 0.0254).toFixed(1)} inch`;
      if (help && k === 'maxThrust') help.textContent = `${(Number(t.value) / 9.81).toFixed(2)} kg per motor`;
      if (k === 'tool') {
        if (s.tool === 'sprayDown') { s.tank ??= 10; s.flow ??= 4; }
        if (s.tool === 'lance') s.flow ??= 4;
        this.renderEditor();
        $<HTMLElement>('#f-tool', body)?.focus({ preventScroll: true });
        return;
      }
      updateCalc();
      clearTimeout(this.previewTimer);
      this.previewTimer = window.setTimeout(() => this.previewEditing(), 250);
    };
    body.onchange = null;
    const drop = $('.drop', body);
    const loadGlb = async (f: File) => {
      if (!/\.glb$/i.test(f.name)) { this.toast('Use a binary .glb file. Blender and most CAD tools export it'); return; }
      if (f.size > 25e6) { this.toast('Keep models under 25 MB'); return; }
      const url = await readFileAs(f, 'dataURL');
      try { await parseGlb(url); }
      catch (err) { this.toast(`That model could not be read. ${(err as Error)?.message ?? ''}`.trim()); return; }
      if (this.editing !== s) return;
      s.glb = url; s.glbScale = 1; s.glbYaw = 0; s.glbOffsetY = 0;
      this.toast('Model loaded');
      this.renderEditor();
    };
    drop.addEventListener('click', () => this.pickFile('.glb', loadGlb));
    drop.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); this.pickFile('.glb', loadGlb); } });
    drop.addEventListener('dragover', e => { e.preventDefault(); drop.classList.add('over'); });
    drop.addEventListener('dragleave', () => drop.classList.remove('over'));
    drop.addEventListener('drop', e => { e.preventDefault(); drop.classList.remove('over'); const f = e.dataTransfer?.files[0]; if (f) loadGlb(f); });
    $('.rm-glb', body)?.addEventListener('click', () => { s.glb = undefined; this.renderEditor(); });
    const save = async () => {
      clearTimeout(this.previewTimer);
      const clean = validateSpec({ ...s, glb: undefined });
      clean.id = s.id; clean.glb = s.glb;
      await saveCustomDrone(clean); await this.loadCustom();
      return clean;
    };
    $('.save', body).addEventListener('click', async () => { const c = await save(); this.editing = null; await this.g.chooseDrone(c); this.toast(`${c.name} saved`); this.openSheet('hangar'); });
    $('.savefly', body).addEventListener('click', async () => { const c = await save(); this.editing = null; await this.g.chooseDrone(c); this.g.startFreeFlight(); });
    $('.export', body).addEventListener('click', () => { const c = validateSpec({ ...s, glb: undefined }); c.id = s.id; c.glb = s.glb; downloadFile(`${c.id}.droneon.json`, JSON.stringify(c, null, 2)); });
    this.previewEditing();
  }

  private async previewEditing() {
    if (!this.editing || !this.sheets.editor.classList.contains('open') || this.g.state !== 'menu') return;
    const spec = validateSpec({ ...this.editing, glb: undefined });
    spec.id = this.editing.id;
    spec.glb = this.editing.glb;
    await this.g.setDrone(spec);
    this.renderSpecLine();
  }

  // ================================================================ settings
  renderSettings() {
    const g = this.g, st = g.settings, inp = g.input;
    const body = $('.body', this.sheets.settings);
    const seg = (key: string, opts: [string, string][], cur: string) => `<div class="seg" data-seg="${key}">${opts.map(([v, l]) => `<button data-v="${v}" class="${cur === v ? 'on' : ''}" aria-pressed="${cur === v}">${l}</button>`).join('')}</div>`;
    const range = (k: string, label: string, v: number, min: number, max: number, step: number, unit = '') =>
      `<div class="field"><label for="s-${k}">${label}<output data-u="${unit}">${v}${unit}</output></label><input id="s-${k}" type="range" data-s="${k}" min="${min}" max="${max}" step="${step}" value="${v}" /></div>`;
    const tog = (k: string, label: string, v: boolean, help = '') => `<label class="toggle"><span>${label}${help ? `<br><span class="help dim" style="font-size:12.5px">${help}</span>` : ''}</span><input type="checkbox" data-t="${k}" ${v ? 'checked' : ''} /></label>`;
    const devName = inp.device === 'rc' ? 'RC transmitter' : inp.device === 'gamepad' ? 'Gamepad' : inp.device === 'touch' ? 'Touch' : 'Keyboard';
    this.settingsDevice = inp.device;
    const map = inp.settings.rcMap;
    const used = (['throttle', 'yaw', 'pitch', 'roll'] as const).map(a => map[a]);
    const clash = new Set(used).size < used.length;
    body.innerHTML = `
      <h3 class="group-h">Controls</h3>
      <p class="note">Active: <b>${devName}</b>${inp.gamepadName ? `, ${esc(inp.gamepadName.slice(0, 60))}` : ''}. Plug in a gamepad or an RC transmitter in USB joystick mode (EdgeTX, OpenTX, ELRS, DJI, SIYI) and move a stick.</p>
      <div style="display:flex;gap:10px;margin:14px 0;flex-wrap:wrap">${seg('device', [['keyboard', 'Keyboard'], ['gamepad', 'Gamepad'], ['rc', 'RC'], ['touch', 'Touch']], inp.device)}</div>
      ${coarse() ? '' : tog('joystick', 'On screen joystick', st.joystick, 'Two sticks you drag with the mouse or a finger. Key O toggles it in flight.')}
      ${tog('throttleHover', 'Hover at centre stick', st.throttleHover, 'Gamepads and keyboards: centre throttle hovers. Turn off for a real transmitter with a non centring throttle.')}
      <div class="rcbox" ${inp.device === 'rc' ? '' : 'hidden'}>
        <h3 class="group-h">RC transmitter</h3>
        <p class="note">Calibrate once: press Start, move both sticks to every corner, then centre them and press Save.</p>
        <div class="fields" style="margin-top:12px">
          ${(['throttle', 'yaw', 'pitch', 'roll'] as const).map(a => `<div class="field"><label for="m-${a}">${a[0].toUpperCase() + a.slice(1)} channel</label><select id="m-${a}" data-map="${a}">${[0, 1, 2, 3, 4, 5, 6, 7].map(i => `<option value="${i}" ${map[a] === i ? 'selected' : ''}>Axis ${i + 1}</option>`).join('')}</select>
          <label class="toggle" style="padding:2px 0"><span class="help">Invert</span><input type="checkbox" data-inv="${a}" ${map.invert[a] ? 'checked' : ''} /></label></div>`).join('')}
        </div>
        ${clash ? '<p class="note warn" style="margin-top:8px">Two functions share one axis. Give each stick its own channel.</p>' : ''}
        <div class="axes"></div>
        <div style="display:flex;gap:10px;margin-top:12px"><button class="btn line small cal-start">Start calibration</button><button class="btn go small cal-save" disabled>Save calibration</button></div>
      </div>
      <h3 class="group-h">Camera</h3>
      <div class="fields">
        ${range('fpvFov', 'FPV field of view', st.fpvFov, 70, 140, 1, '°')}
        ${range('fov', 'Chase field of view', st.fov, 40, 100, 1, '°')}
        ${range('camUptilt', 'FPV uptilt override', st.camUptilt ?? g.spec.camUptilt, -30, 60, 1, '°')}
      </div>
      <h3 class="group-h">World</h3>
      <div style="margin:6px 0 14px">${seg('time', [['day', 'Midday'], ['golden', 'Golden hour'], ['overcast', 'Overcast'], ['dusk', 'Dusk']], st.time)}</div>
      <div class="fields">
        ${range('windSpeed', 'Wind', st.windSpeed, 0, 14, 0.5, ' m/s')}
        ${range('windDir', 'Wind from', st.windDir, 0, 355, 5, '°')}
        ${range('gust', 'Gusts', st.gust, 0, 1, 0.05)}
        ${range('volume', 'Volume', st.volume, 0, 1, 0.05)}
      </div>
      ${tog('crashes', 'Crash effects', st.crashes)}
      ${tog('showSticks', 'Show stick inputs', st.showSticks, 'Great for training, watch what your thumbs really do')}
      <h3 class="group-h">Graphics</h3>
      <div style="margin:6px 0">${seg('quality', [['low', 'Fast'], ['high', 'Beautiful']], st.quality)}</div>
      <p class="note">Changing quality reloads the game.</p>
      <h3 class="group-h">Keys</h3>
      <div class="keys">
        <kbd>W S</kbd><span>Throttle, climb and descend</span><kbd>A D</kbd><span>Yaw</span>
        <kbd>Arrow keys</kbd><span>Pitch and roll, or I J K L</span><kbd>Space</kbd><span>Spray, DSolar and DShine</span>
        <kbd>Q E</kbd><span>Gimbal or lance tilt</span><kbd>M</kbd><span>Flight mode GPS, Angle, Acro</span>
        <kbd>C</kbd><span>Camera chase, FPV, line of sight</span><kbd>H</kbd><span>Thermal view on DScan</span>
        <kbd>F</kbd><span>Tag a hotspot</span><kbd>R</kbd><span>Reset</span><kbd>X</kbd><span>Throttle cut on keyboard acro</span>
        <kbd>O</kbd><span>On screen joystick</span><kbd>F1</kbd><span>Hide the key hints</span><kbd>Esc</kbd><span>Pause, or back out of a panel</span>
        <kbd>Gamepad</kbd><span>Left stick throttle and yaw, right stick pitch and roll, A spray, X tag, Y thermal, LB mode, RB camera, Start pause</span>
      </div>`;
    body.onclick = (e) => {
      const b = (e.target as HTMLElement).closest<HTMLElement>('.seg button');
      if (!b) return;
      const key = b.parentElement!.dataset.seg!, v = b.dataset.v!;
      audio.tick();
      if (key === 'quality') {
        if (v === st.quality) return;
        if (g.state !== 'menu' && !confirm('Changing quality reloads the game. Continue?')) return;
        st.quality = v as never; g.saveSettings(); location.reload(); return;
      }
      $$('button', b.parentElement!).forEach(x => { x.classList.toggle('on', x === b); x.setAttribute('aria-pressed', String(x === b)); });
      if (key === 'device') { inp.device = v as never; this.syncJoystick(); this.renderHint(); this.renderSettings(); }
      if (key === 'time') { st.time = v as never; g.applySettings(); }
    };
    body.oninput = (e) => {
      const t = e.target as HTMLInputElement;
      if (t.dataset.s) {
        const k = t.dataset.s as keyof typeof st;
        (st as unknown as Record<string, number>)[k] = Number(t.value);
        const out = t.parentElement?.querySelector('output'); if (out) out.textContent = t.value + (out.dataset.u ?? '');
        g.applySettings();
      }
      if (t.dataset.t) {
        (st as unknown as Record<string, boolean>)[t.dataset.t] = t.checked; g.applySettings();
        if (t.dataset.t === 'joystick') this.syncJoystick();
      }
      if (t.dataset.map) { inp.settings.rcMap[t.dataset.map as 'yaw'] = Number(t.value); inp.save(); this.renderSettings(); }
      if (t.dataset.inv) { inp.settings.rcMap.invert[t.dataset.inv as 'yaw'] = t.checked; inp.save(); }
    };
    const axesEl = $('.axes', body);
    cancelAnimationFrame(this.settingsLoop);
    if (axesEl && inp.device === 'rc') {
      const draw = () => {
        if (!this.sheets.settings.classList.contains('open')) return;
        const ax = rawAxes();
        if (this.calib) ax.forEach((v, i) => { this.calib!.min[i] = Math.min(this.calib!.min[i] ?? v, v); this.calib!.max[i] = Math.max(this.calib!.max[i] ?? v, v); this.calib!.center[i] = v; });
        const html = ax.slice(0, 8).map((v, i) => `<div class="axis"><span>Axis ${i + 1}</span><div class="bar"><i style="left:${(v + 1) * 50}%"></i></div><span class="num">${v.toFixed(2)}</span></div>`).join('') || '<p class="note">No transmitter detected yet. Move a stick.</p>';
        if (axesEl.innerHTML !== html) axesEl.innerHTML = html;
        this.settingsLoop = requestAnimationFrame(draw);
      };
      this.settingsLoop = requestAnimationFrame(draw);
      const saveBtn = $<HTMLButtonElement>('.cal-save', body);
      $('.cal-start', body).addEventListener('click', () => { this.calib = { min: [], max: [], center: [] }; saveBtn.disabled = false; this.toast('Move both sticks to every corner, then centre them'); });
      saveBtn.addEventListener('click', () => { if (this.calib) { inp.settings.rcCalib = this.calib; inp.save(); this.calib = null; saveBtn.disabled = true; this.toast('Calibration saved'); } });
    }
  }

  /** the Settings panel follows the controller that is really in use */
  private watchDevice() {
    if (this.sheets.settings.classList.contains('open') && this.g.input.device !== this.settingsDevice && !isField(document.activeElement)) this.renderSettings();
  }

  // ================================================================ result
  renderResult() {
    const g = this.g, r = g.result!, m = g.mission!;
    if (!r || !m) return;
    const box = $('.box', this.resultEl);
    const ok = r.stars > 0;
    const idx = g.missions.findIndex(x => x.id === m.id);
    box.innerHTML = `
      <h2>${ok ? 'Mission complete' : 'Mission failed'}</h2>
      <p class="dim" style="margin-top:6px">${esc(m.title)}</p>
      ${ok ? `<div class="result-stars" aria-label="${r.stars} of 3 stars">${[0, 1, 2].map(i => `<i class="${i < r.stars ? 'ph-fill ph-star on' : 'ph ph-star'}"></i>`).join('')}</div>` : ''}
      <div class="score">${esc(r.score)}</div>
      <p class="result-detail">${esc(r.detail)}</p>
      <div class="acts">
        <button class="btn go" data-r="retry"><i class="ph ph-arrow-counter-clockwise"></i>Retry</button>
        ${ok && idx < g.missions.length - 1 ? '<button class="btn line" data-r="next">Next mission <i class="ph ph-arrow-right"></i></button>' : ''}
        <button class="btn quiet" data-r="menu">Menu</button>
      </div>`;
    box.onclick = (e) => {
      const b = (e.target as HTMLElement).closest<HTMLElement>('[data-r]'); if (!b) return;
      audio.tick();
      this.resultEl.classList.remove('open');
      if (b.dataset.r === 'retry') g.restartMission();
      if (b.dataset.r === 'next') g.startMission(g.missions[idx + 1]);
      if (b.dataset.r === 'menu') g.enterMenu().then(() => this.openSheet('train'));
    };
  }

  // ================================================================ build
  private wireBuild() {
    const g = this.g, b = this.build;
    const bar = $('.bar', b);
    bar.innerHTML = PIECES.map(p => `<button data-piece="${p.t}" title="${p.label}"><i class="ph ${PIECE_ICON[p.t]}"></i>${p.label}<kbd>${p.key}</kbd></button>`).join('');
    bar.addEventListener('click', e => {
      const btn = (e.target as HTMLElement).closest<HTMLElement>('[data-piece]'); if (!btn) return;
      g.builder.setGhost(btn.dataset.piece as never); this.syncBuildBar(); audio.tick();
      btn.blur();
    });
    const nameEl = $<HTMLInputElement>('.map-name', b);
    nameEl.addEventListener('input', () => { g.builder.map.name = nameEl.value.trim().slice(0, 40) || 'Untitled'; });
    nameEl.addEventListener('keydown', e => { if (e.key === 'Enter') nameEl.blur(); });
    nameEl.addEventListener('change', () => g.builder.onChanged?.());
    $('.top', b).addEventListener('click', async e => {
      const btn = (e.target as HTMLElement).closest<HTMLElement>('[data-b]'); if (!btn) return;
      audio.tick();
      btn.blur();
      const k = btn.dataset.b;
      if (k === 'fly') { g.saveMap(true); g.startFreeFlight(); }
      if (k === 'menu') { g.saveMap(true); g.enterMenu(); }
      if (k === 'clear' && confirm('Remove every piece from this map? Ctrl+Z brings them back.')) { g.builder.clear(true, true); this.syncBuildBar(); }
      if (k === 'race') {
        g.builder.map.race = !g.builder.map.race;
        g.builder.onOp?.({ op: 'race', on: g.builder.map.race });
        g.builder.onChanged?.();
        this.syncBuildBar();
      }
      if (k === 'export') downloadFile(`${(g.builder.map.name || 'map').replace(/[^a-z0-9]+/gi, '-').toLowerCase()}.droneon-map.json`, JSON.stringify(g.builder.map));
      if (k === 'import') {
        if (g.mp && !g.mp.isHost()) { this.toast('In a squad room only the host loads courses'); return; }
        this.pickFile('.json', async f => {
          try {
            if (f.size > 5e6) throw 0;
            const m = JSON.parse(await readFileAs(f, 'text'));
            if (!g.builder.load(m, { emit: true, origin: g.mp ? 'room' : 'own' })) throw 0;
            g.resetRace();
            this.syncBuildBar(); nameEl.value = g.builder.map.name;
            this.toast(`${g.builder.map.pieces.length} pieces loaded`);
          } catch { this.toast('That file is not a DRONE ON map'); }
        });
      }
      if (k === 'share') {
        const code = await encodeShare(g.builder.map);
        const url = `${location.origin}${location.pathname}#map=${code}`;
        try { await navigator.clipboard.writeText(url); this.toast('Link copied. Anyone who opens it flies your course.'); }
        catch { prompt('Copy this link', url); }
      }
    });
  }

  syncBuildBar() {
    const g = this.g;
    $$('[data-piece]', this.build).forEach(x => x.classList.toggle('on', x.dataset.piece === g.builder.selected));
    const race = $('[data-b=race] span', this.build); if (race) race.textContent = g.builder.map.race ? 'Race on' : 'Race off';
    $('.count', this.build).innerHTML = `${g.builder.map.pieces.length} pieces<br>${g.builder.checkpoints().length} checkpoints<br>height ${g.builder.lift.toFixed(1)} m, size ${g.builder.scale.toFixed(1)}`;
    const nameEl = $<HTMLInputElement>('.map-name', this.build);
    if (document.activeElement !== nameEl && nameEl.value !== g.builder.map.name) nameEl.value = g.builder.map.name;
  }

  // ================================================================ touch
  private wireTouch() {
    const g = this.g;
    const joys = $$('.joy', this.touch);
    joys.forEach((j, idx) => {
      const base = $('.joy-base', j), knob = $('.knob', j);
      let id: number | null = null;
      const side = idx === 0 ? g.input.touch.left : g.input.touch.right;
      const radius = () => base.getBoundingClientRect().width / 2 - 18;
      const move = (e: PointerEvent) => {
        const r = base.getBoundingClientRect();
        const R = radius();
        let dx = e.clientX - (r.left + r.width / 2), dy = e.clientY - (r.top + r.height / 2);
        const l = Math.hypot(dx, dy); if (l > R) { dx *= R / l; dy *= R / l; }
        knob.style.transform = `translate(${dx}px, ${dy}px)`;
        side.x = dx / R; side.y = -dy / R;
      };
      base.addEventListener('pointerdown', e => {
        if (id != null) return;
        e.preventDefault();
        id = e.pointerId; base.setPointerCapture(id);
        side.active = true; g.input.device = 'touch'; audio.start();
        j.classList.add('held'); move(e);
      });
      base.addEventListener('pointermove', e => { if (e.pointerId === id) move(e); });
      const end = (e: PointerEvent) => {
        if (e.pointerId !== id) return;
        id = null; side.active = false; j.classList.remove('held');
        side.x = 0;
        // the throttle stick only springs back in GPS mode, like a real transmitter; building always centres
        if (idx === 1 || g.input.throttleSprings || g.state === 'build') side.y = 0;
        knob.style.transform = `translate(0px, ${-side.y * radius()}px)`;
      };
      base.addEventListener('pointerup', end); base.addEventListener('pointercancel', end);
    });
    this.touch.addEventListener('pointerdown', e => {
      const b = (e.target as HTMLElement).closest<HTMLElement>('[data-t],[data-tb]'); if (!b) return;
      const t = b.dataset.t, tb = b.dataset.tb;
      const key = (code: string) => { g.input.pressed.add(code); };
      const hold = (on: () => void, off: () => void) => {
        on(); b.classList.add('on');
        const up = (ev: PointerEvent) => { if (ev.pointerId !== e.pointerId) return; off(); b.classList.remove('on'); removeEventListener('pointerup', up); removeEventListener('pointercancel', up); };
        addEventListener('pointerup', up); addEventListener('pointercancel', up);
      };
      if (t === 'spray') hold(() => { g.input.touchSpray = true; }, () => { g.input.touchSpray = false; });
      if (t === 'cam') key('KeyC'); if (t === 'mode') key('KeyM'); if (t === 'thermal') key('KeyH'); if (t === 'reset') key('KeyR');
      if (t === 'tag') g.input.touchTag = true;
      if (tb === 'place') g.input.uiClick = 0;
      if (tb === 'delete') key('KeyX');
      if (tb === 'rotate') key('KeyR');
      if (tb === 'undo') g.input.undoPressed = true;
      if (tb === 'higher') g.input.wheel -= 2;
      if (tb === 'lower') g.input.wheel += 2;
      if (tb === 'up') hold(() => { g.input.touchBuildLift = 1; }, () => { g.input.touchBuildLift = 0; });
      if (tb === 'down') hold(() => { g.input.touchBuildLift = -1; }, () => { g.input.touchBuildLift = 0; });
      if (tb) audio.tick();
    });
    // pause acts on release, so the lifting finger cannot land on the menu it just opened
    this.touch.addEventListener('click', e => { const b = (e.target as HTMLElement).closest<HTMLElement>('[data-t=pause]'); if (b) g.input.pressed.add('Escape'); });
  }

  /** knobs show where the sticks really are: throttle low before arming in Angle and Acro */
  private syncKnobs() {
    const T = this.g.input.touch;
    $$('.joy', this.touch).forEach((j, idx) => {
      const side = idx === 0 ? T.left : T.right;
      if (side.active) return;
      const R = $('.joy-base', j).getBoundingClientRect().width / 2 - 18;
      $('.knob', j).style.transform = `translate(${side.x * R}px, ${-side.y * R}px)`;
    });
  }

  syncJoystick() {
    const g = this.g, st = g.state;
    const flying = st === 'fly' || st === 'mission';
    const hw = g.input.device === 'gamepad' || g.input.device === 'rc';
    const want = coarse() || g.settings.joystick;
    const on = !hw && want && (flying || (st === 'build' && coarse()));
    this.touch.classList.toggle('on', on);
    this.touch.classList.toggle('building', st === 'build');
    this.hud.classList.toggle('joy-on', on && flying);
    if (st === 'build' && on) { g.input.touch.left.y = 0; g.input.touch.left.x = 0; }
    this.syncKnobs();
    this.touch.inert = !on;
  }

  /** only the buttons this drone can use */
  private syncToolButtons() {
    const tool = this.g.spec.tool;
    const show = (t: string, on: boolean) => { const b = $(`[data-t=${t}]`, this.touch); if (b) b.hidden = !on; };
    show('spray', tool === 'sprayDown' || tool === 'lance');
    show('thermal', tool === 'thermal');
    show('tag', tool === 'thermal');
  }

  // ================================================================ gamepad menus
  private padNav() {
    const g = this.g, inp = g.input;
    if (inp.device !== 'gamepad' || !inp.padPressed.size) return;
    const layer = [this.resultEl, this.pauseEl].find(l => l.classList.contains('open'))
      ?? Object.values(this.sheets).find(s => s.classList.contains('open'))
      ?? (g.state === 'menu' ? this.rail : null);
    if (!layer || layer.inert) return;
    const items = $$<HTMLElement>('button:not([hidden]):not([disabled]),[tabindex="0"],input,select', layer).filter(x => x.offsetParent !== null && x.tabIndex >= 0);
    if (!items.length) return;
    const cur = items.indexOf(document.activeElement as HTMLElement);
    const go = (d: number) => {
      const i = cur < 0 ? (d > 0 ? 0 : items.length - 1) : (cur + d + items.length) % items.length;
      items[i].focus(); items[i].scrollIntoView({ block: 'nearest' });
    };
    if (inp.padHit(12)) go(-1);
    if (inp.padHit(13)) go(1);
    if (inp.padHit(0) && cur >= 0) items[cur].click();
    if (inp.padHit(1)) {
      if (layer === this.sheets.editor) this.leaveEditor();
      else if (layer.classList.contains('sheet')) this.closeSheets();
      else if (layer === this.pauseEl) this.resume();
    }
  }

  // ================================================================ toasts
  toast(text: string) {
    const t = el(`<div class="toast enter">${esc(text)}</div>`);
    this.toastsEl.append(t);
    while (this.toastsEl.children.length > 2) this.toastsEl.firstElementChild!.remove();
    requestAnimationFrame(() => requestAnimationFrame(() => t.classList.remove('enter')));
    setTimeout(() => { t.classList.add('leave'); setTimeout(() => t.remove(), 200); }, 2600);
  }

  renderHint() {
    const g = this.g;
    const h = $('.hint', this.hud);
    const dev = g.input.device;
    const tool = g.spec.tool;
    const lines: string[] = [];
    if (dev === 'keyboard') {
      lines.push(g.sim?.mode === 'gps' ? '<kbd>W</kbd> hold to climb, release to hover' : '<kbd>W</kbd> <kbd>S</kbd> set throttle, it stays');
      lines.push('<kbd>A</kbd> <kbd>D</kbd> yaw &nbsp; <kbd>Arrows</kbd> pitch and roll');
      if (tool === 'sprayDown' || tool === 'lance') lines.push('<kbd>Space</kbd> spray &nbsp; <kbd>Q</kbd> <kbd>E</kbd> tilt');
      if (tool === 'thermal') lines.push('<kbd>H</kbd> thermal &nbsp; <kbd>F</kbd> tag &nbsp; <kbd>Q</kbd> <kbd>E</kbd> gimbal');
      lines.push('<kbd>M</kbd> mode &nbsp; <kbd>C</kbd> camera &nbsp; <kbd>R</kbd> reset &nbsp; <kbd>O</kbd> joystick &nbsp; <kbd>F1</kbd> hide');
    } else if (dev === 'gamepad') {
      lines.push('Left stick throttle and yaw, right stick pitch and roll');
      lines.push('A spray &nbsp; X tag &nbsp; Y thermal &nbsp; LB mode &nbsp; RB camera');
    } else if (dev === 'rc') {
      lines.push('Throttle low to arm, then fly it like the real thing');
    }
    h.innerHTML = lines.join('<br>');
    const how = $('.how', this.crashEl);
    how.textContent = dev === 'touch' ? 'Tap the reset button to try again' : dev === 'gamepad' ? 'Press Back to reset' : dev === 'rc' ? 'Tap reset or press R' : 'Press R to reset';
  }

  // ================================================================ per frame HUD
  private frame() {
    const g = this.g;
    if (!(g.state === 'fly' || g.state === 'mission') || !g.sim) return;
    const t = g.telemetry();
    const hud = this.hud;
    if (t.device !== this.lastDevice) { this.lastDevice = t.device; this.syncJoystick(); this.renderHint(); }
    $('.m', hud).textContent = t.mode.toUpperCase();
    const a = $('.a', hud);
    a.textContent = t.crashed ? 'CRASHED' : t.armed ? 'ARMED' : t.device === 'keyboard' && t.mode === 'gps' ? 'HOLD W TO ARM' : 'THROTTLE UP TO ARM';
    a.classList.toggle('armed', t.armed);
    const bt = $('.batt b', hud);
    const pct = Math.round(t.soc * 100);
    bt.textContent = pct + '%';
    bt.className = pct < 15 ? 'crit' : pct < 30 ? 'low' : '';
    $('.batt .v', hud).textContent = `${t.volt.toFixed(1)} V  ${t.amps.toFixed(0)} A  ${(t.watts / 1000).toFixed(t.watts < 1000 ? 2 : 1)} kW  ${fmtTime(t.flightTime)}`;
    $('.batt .tank', hud).textContent = t.tank != null ? `Tank ${t.tank.toFixed(1)} L` : t.thermal ? 'Thermal' : '';
    $('.t-alt', hud).textContent = t.agl.toFixed(1);
    $('.t-spd', hud).textContent = (t.speed * 3.6).toFixed(0);
    $('.t-vz', hud).textContent = (t.vz >= 0 ? '+' : '') + t.vz.toFixed(1);
    $('.t-dst', hud).textContent = t.dist.toFixed(0);
    const w = $('.t-wnd', hud);
    w.firstChild!.textContent = t.wind.toFixed(1) + ' ';
    // arrow shows where the wind blows to, relative to the drone heading
    ($('.wind-arrow', hud) as HTMLElement).style.transform = `rotate(${t.windDir + 180 - t.heading}deg)`;
    const big = $('.tc .big', hud);
    if (big.textContent !== t.missionHud) big.textContent = t.missionHud;
    // heading tape: labels on the 10 degree grid, the strip slides by the remainder
    const hd = Math.round(t.heading);
    if (hd !== this.lastTape) {
      this.lastTape = hd;
      const strip = $('.strip', hud);
      const rem = ((hd % 10) + 10) % 10;
      const d0 = hd - 90 - rem;
      let s = '';
      for (let d = d0; d <= d0 + 180; d += 10) {
        const v = ((d % 360) + 360) % 360;
        const lab = v === 0 ? 'N' : v === 90 ? 'E' : v === 180 ? 'S' : v === 270 ? 'W' : String(v);
        s += `<span class="${lab.length === 1 ? 'card' : ''}">${lab}</span>`;
      }
      strip.innerHTML = s;
      strip.style.transform = `translateX(${-(9.5 * 30) - (rem / 10) * 30}px)`;
    }
    // sticks
    const showS = g.settings.showSticks;
    $('.br', hud).style.display = showS ? '' : 'none';
    if (showS) {
      const sl = $('.s-l i', hud), sr = $('.s-r i', hud);
      sl.style.transform = `translate(${t.sticks.yaw * 27}px, ${(0.5 - t.sticks.throttle) * 54}px)`;
      sr.style.transform = `translate(${t.sticks.roll * 27}px, ${-t.sticks.pitch * 27}px)`;
    }
    $('.cross', hud).classList.toggle('on', t.thermal || (t.cam === 'fpv' && g.spec.tool === 'thermal'));
    $('.thermal-bar', hud).classList.toggle('on', t.thermal);
    // mission objectives
    const objEl = $('.objectives', hud);
    const mn = $('.mission-name', hud);
    if (g.mission) {
      mn.textContent = g.mission.title;
      const objs = g.mission.objectives();
      const html = objs.map(o => `<div class="${o.done ? 'done' : ''}"><i class="ph${o.done ? '-fill ph-check-circle' : ' ph-circle'}"></i>${esc(o.text)}</div>`).join('');
      if (objEl.innerHTML !== html) objEl.innerHTML = html;
    } else { mn.textContent = g.builder.map.pieces.length ? g.builder.map.name : ''; if (objEl.innerHTML) objEl.innerHTML = ''; }
    // marker label, kept clear of the top HUD band and the screen edges
    const ml = $('.marker-label', hud);
    if (g.markerPos) {
      const p = g.project(g.markerPos.clone().add(new THREE.Vector3(0, 3.6, 0)));
      ml.hidden = p.behind;
      if (!p.behind) {
        const topBand = innerWidth < 761 ? 150 : 120;
        ml.style.left = Math.max(70, Math.min(innerWidth - 70, p.x)) + 'px';
        ml.style.top = Math.max(topBand, Math.min(innerHeight - 140, p.y)) + 'px';
        ml.innerHTML = `<b>${esc(g.markerLabel)}</b>${g.sim.pos.distanceTo(g.markerPos).toFixed(0)} m`;
      }
    } else ml.hidden = true;
    if (!t.crashed) this.crashEl.classList.remove('on');
    else $('.why', this.crashEl).textContent = t.crashReason;
  }
}

function fmtTime(s: number) { const m = Math.floor(s / 60); return `${m}:${String(Math.floor(s % 60)).padStart(2, '0')}`; }

/** shared map link support */
export async function mapFromHash(): Promise<MapData | null> {
  const m = location.hash.match(/map=([A-Za-z0-9_-]+)/);
  if (!m) return null;
  const data = await decodeShare<MapData>(m[1]);
  if (!data || typeof data !== 'object' || !Array.isArray(data.pieces)) return null;
  return data;
}

export function lastDroneId() { return getLS<string>('lastDrone', 'dscan'); }
export { starterMap };
