import * as THREE from 'three';
import type { Game } from '../game/game';
import type { UI } from '../ui/ui';
import { audio } from '../audio/audio';
import { progress } from '../game/store';
import { awardXp, capDaily, pilotLevel } from './progression';
import { equippedCosmetics } from './cosmetics';
import { installPilot } from './pilot';
import { installAcademy } from '../academy/academy';
import { isDrill } from '../academy/drills';
import { installWorkshop } from '../workshop/workshop';
import { builds } from '../workshop/parts';
import './meta.css';

// Spielwiese depth entry point (GDD 3): Academy, Workshop, pilot progression and the rail around them.
// Owned by the Spielwiese programmer; main.ts calls installMeta once after the UI exists.

const el = (html: string) => { const t = document.createElement('template'); t.innerHTML = html.trim(); return t.content.firstElementChild as HTMLElement; };
const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

export function installMeta(game: Game, ui: UI) {
  const g = game;
  const pilot = installPilot(ui);
  const academy = installAcademy(g, ui);
  installWorkshop(g, ui, a => pilot.celebrate(a));

  // ------------------------------------------------------------------ SPIELWIESE: today's FLY and BUILD
  ui.registerSheet('spielwiese', 'Spielwiese', body => {
    const air = airtimeToday();
    body.innerHTML = `
      <p class="note">The field is yours. Fly free with your own drone, or build a course of rings, gates and ramps and send the link to a friend.</p>
      <div class="sw-cmds">
        <button class="cmd primary" data-sw="fly"><b>FLY</b><small>Free flight with ${esc(g.chosenSpec.name)}, your course included</small><i class="ph ph-arrow-right"></i></button>
        <button class="cmd" data-sw="build"><b>BUILD</b><small>Place rings, gates and ramps, share the link</small><i class="ph ph-arrow-right"></i></button>
      </div>
      <div class="sw-drone">
        <span>YOUR DRONE</span><b>${esc(g.chosenSpec.name)}</b>
        <button class="btn small line" data-sw="workshop"><i class="ph ph-wrench"></i>Change in the Workshop</button>
      </div>
      <p class="note sw-air">Free flight earns 5 XP for every minute in the air, up to 60 a day. Today: ${air} of 60.</p>`;
    body.onclick = e => {
      const b = (e.target as HTMLElement).closest<HTMLElement>('[data-sw]');
      if (!b) return;
      audio.start(); audio.tick();
      if (b.dataset.sw === 'fly') g.startFreeFlight();
      if (b.dataset.sw === 'build') g.enterBuild();
      if (b.dataset.sw === 'workshop') ui.openSheet('hangar');
    };
  });

  // ------------------------------------------------------------------ first visit: one quiet line under ROYALE
  const first = ui.rail.querySelector<HTMLElement>('.rail-first');
  if (first) {
    const fresh = () => {
      try { return !localStorage.getItem('droneon2.progress') && !localStorage.getItem('droneon2.academy') && pilotLevel().level === 1 && pilotLevel().xpIntoLevel === 0; } catch { return false; }
    };
    first.innerHTML = `<button type="button" class="first-hint">NEW HERE? LEARN TO FLY IN THE ACADEMY<i class="ph ph-arrow-right"></i></button>`;
    first.hidden = !fresh();
    first.querySelector('button')!.addEventListener('click', () => { audio.start(); audio.tick(); academy.open('drills'); });
    g.on('state', () => { if (g.state === 'menu') first.hidden = !fresh(); });
  }

  // ------------------------------------------------------------------ ROYALE placeholder
  // MERGE: drop this block once src/royale registers its own 'royale' sheet. It only fills in while none exists.
  setTimeout(() => {
    if (ui.sheets.royale) return;
    ui.registerSheet('royale', 'Royale', body => {
      body.innerHTML = `
        <div class="ry-soon">
          <h3>LAST DRONE FLYING</h3>
          <p>Twelve pilots launch the smallest drone there is. Fly through rings to evolve it in mid air, survive the shrinking Signal, knock the others out of the sky. Royale lands in this build soon.</p>
          <div class="ry-acts">
            <button class="btn go" data-ry="academy"><i class="ph ph-graduation-cap"></i>Train in the Academy</button>
            <button class="btn line" data-ry="target"><i class="ph ph-crosshair"></i>Practise aim on the Target Range</button>
          </div>
        </div>`;
      body.onclick = e => {
        const b = (e.target as HTMLElement).closest<HTMLElement>('[data-ry]');
        if (!b) return;
        audio.tick();
        if (b.dataset.ry === 'academy') academy.open('drills'); else academy.start('target-range');
      };
    });
  }, 0);

  // ------------------------------------------------------------------ XP: airtime in free flight
  let air = 0;
  function airtimeToday() {
    try { const raw = JSON.parse(localStorage.getItem('droneon2.pilot') || '{}'); return raw?.daily?.date === new Date().toISOString().slice(0, 10) ? (raw.daily.used?.airtime ?? 0) : 0; } catch { return 0; }
  }
  // ------------------------------------------------------------------ XP: first mission stars
  let starsBefore: { id: string; n: number } | null = null;
  g.on('state', () => {
    if (g.state === 'mission' && g.mission && !isDrill(g.mission)) starsBefore = { id: g.mission.id, n: progress().stars[g.mission.id] ?? 0 };
    if (g.state === 'result' && g.result && starsBefore && g.mission?.id === starsBefore.id) {
      const after = progress().stars[starsBefore.id] ?? 0;
      const n = after - starsBefore.n;
      starsBefore.n = after;
      if (n > 0) {
        const a = awardXp([{ label: n === 1 ? 'NEW MISSION STAR' : `${n} NEW MISSION STARS`, xp: 30 * n }], 'mission');
        const box = ui.resultEl.querySelector('.box');
        box?.querySelector('.acts')?.before(el(`<p class="mission-xp"><b>+${a.total} XP</b><span>${a.lines[0].label}</span>${a.levelAfter > a.levelBefore ? `<em>LEVEL ${a.levelAfter}</em>` : ''}</p>`));
        if (a.levelAfter > a.levelBefore) pilot.celebrate(a);
        else pilot.renderChip();
      }
    }
  });

  // ------------------------------------------------------------------ per frame: airtime, trail
  const trailCol: number[][] = [];
  let trailId = '';
  const tmp = new THREE.Vector3(), back = new THREE.Vector3();
  g.on('frame', (dt) => {
    const d = Number(dt) || 0;
    const s = g.sim;
    if (g.state !== 'fly' || g.paused || !s) return;
    if (s.armed && !s.onGround) {
      air += d;
      if (air >= 60) {
        air -= 60;
        const give = capDaily('airtime', 60, 5);
        if (give > 0) pilot.celebrate(awardXp([{ label: 'AIRTIME', xp: give }], 'airtime'), 'AIRTIME');
      }
    }
    const trail = equippedCosmetics().trail;
    if (!trail || !s.armed || s.crashed) return;
    if (trail.id !== trailId) {
      trailId = trail.id; trailCol.length = 0;
      for (const c of trail.colors) { const k = new THREE.Color(c); trailCol.push([k.r * 2.2, k.g * 2.2, k.b * 2.2]); }
    }
    const sp = s.speed();
    if (sp < 4) return;
    const L = g.spec.armLength * 2 + g.spec.propDiameter;
    back.copy(s.vel).normalize();
    for (let i = 0; i < 2; i++) {
      const c = trailCol[(Math.random() * trailCol.length) | 0];
      tmp.copy(s.pos).addScaledVector(back, -L * (0.5 + Math.random() * 0.4));
      g.particles.emit(tmp, back.clone().multiplyScalar(-0.6).add(new THREE.Vector3((Math.random() - 0.5) * 0.4, (Math.random() - 0.5) * 0.4, (Math.random() - 0.5) * 0.4)), 0.7, Math.max(0.12, L * 0.35), c[0], c[1], c[2], 0.28);
    }
  });

  // ------------------------------------------------------------------ LED colour on Workshop drones
  g.on('drone', () => {
    const spec = g.spec;
    if (!spec.id.startsWith('ws-') && !builds()[spec.id]) return;
    const led = equippedCosmetics().led;
    if (led.id === 'led-nav' || !g.visual) return;
    for (const m of g.visual.leds) {
      const mat = (m as THREE.Mesh).material as THREE.MeshBasicMaterial;
      const c = led.colors[m.position.z < 0 ? 0 : led.colors.length - 1];
      mat.color.set(c).multiplyScalar(2.2);
    }
  });
}
