import type { Game } from '../game/game';
import type { UI } from '../ui/ui';
import { audio } from '../audio/audio';
import { pilotLevel } from '../meta/progression';
import {
  DRILLS, MEDALS, allRecords, deltaText, drillDef, formatValue, recordAttempt, skills, pilotSkill, weekDelta, unitLabel,
  type AttemptResult, type DrillDef, type DrillId, type DrillRec,
} from './records';
import { makeDrill, isDrill, activeRange, rangeInput, type DrillOutcome } from './drills';
import './academy.css';

// The Academy (GDD 3.1, 3.2): drills with medals, the mission logbook, skill bars and Pilot Skill,
// the in flight drill overlay (TARGET RANGE crosshair and FIRE) and the drill results screen.

const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
const el = (html: string) => { const t = document.createElement('template'); t.innerHTML = html.trim(); return t.content.firstElementChild as HTMLElement; };
const coarse = () => matchMedia('(pointer: coarse)').matches;

export const medalName = (m: number) => (m > 0 ? MEDALS[m - 1] : '');

/** last attempts as a line: up is better, the best run gets a dot */
export function sparkline(d: DrillDef, vals: number[], w = 96, h = 26) {
  if (!vals.length) return '';
  const lo = Math.min(...vals), hi = Math.max(...vals);
  const span = hi - lo || 1;
  const y = (v: number) => { const k = (v - lo) / span; return 3 + (h - 6) * (d.lower ? k : 1 - k); };
  const x = (i: number) => vals.length === 1 ? w / 2 : 3 + (w - 6) * i / (vals.length - 1);
  const pts = vals.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
  const bi = vals.indexOf(d.lower ? lo : hi);
  return `<svg class="ac-spark" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" aria-hidden="true">
    ${vals.length > 1 ? `<polyline points="${pts}" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round" />` : ''}
    <circle cx="${x(bi).toFixed(1)}" cy="${y(vals[bi]).toFixed(1)}" r="2.6" fill="#b5f78a" />
    <circle cx="${x(vals.length - 1).toFixed(1)}" cy="${y(vals[vals.length - 1]).toFixed(1)}" r="1.8" fill="#f7f7f2" /></svg>`;
}

export function weekLine(wd: number, any: boolean) {
  if (!any) return 'FLY A DRILL TO START IT';
  return wd >= 0.5 ? `UP ${Math.round(wd)} THIS WEEK` : 'NO CHANGE THIS WEEK YET';
}

/** Pilot Skill and the five skill bars, shared by the Academy and the Pilot panel */
export function skillBlock() {
  const rec = allRecords();
  const sk = skills(rec);
  const ps = pilotSkill(rec);
  const any = sk.some(s => s.tried);
  return `<div class="ac-skill">
    <div class="ac-ps"><span>PILOT SKILL</span><b>${Math.round(ps)}</b><em class="${weekDelta() >= 0.5 ? 'up' : ''}">${weekLine(weekDelta(), any)}</em></div>
    <div class="ac-bars">${sk.map(s => `<div class="ac-bar${s.tried ? '' : ' untried'}"><span>${s.def.skill}</span><i><b style="transform:scaleX(${(s.score / 100).toFixed(3)})"></b></i><em>${s.tried ? Math.round(s.score) : 'TRY IT'}</em></div>`).join('')}</div>
  </div>`;
}

export function installAcademy(g: Game, ui: UI) {
  let tab: 'drills' | 'missions' = 'drills';
  let openRow: DrillId | null = null;

  // ------------------------------------------------------------------ sheet
  ui.registerSheet('academy', 'Academy', body => render(body));

  function row(d: DrillDef, r: DrillRec) {
    const m = r.medal;
    const best = r.best;
    const next = best == null ? null : d.medals.findIndex(t => (d.lower ? best > t : best < t));
    const toNext = best != null && next != null && next >= 0 ? `${d.lower ? (best - d.medals[next]).toFixed(d.unit === 's' ? 2 : 0) : Math.round(d.medals[next] - best)} ${unitLabel(d)} TO ${MEDALS[next]}` : best != null ? 'SHINE, THE TOP MEDAL' : '';
    const open = openRow === d.id;
    return `<div class="ac-drill${open ? ' open' : ''}" data-drill="${d.id}">
      <button class="ac-head" aria-expanded="${open}">
        <h3>${d.title}</h3>
        <span class="meta">${d.skill}, ${d.drone}</span>
        <span class="ac-rec">${best == null ? '<em class="try">TRY IT</em>' : `${m ? `<em class="medal m${m}">${medalName(m)}</em>` : '<em class="medal">NO MEDAL</em>'}<b>${formatValue(d, best)}</b>`}</span>
        <span class="ac-hist">${sparkline(d, r.attempts.map(a => a.v))}</span>
      </button>
      <div class="more"><div>
        <p class="brief">${esc(d.brief)}</p>
        <ol class="ac-ladder">${d.medals.map((t, i) => `<li class="${m > i ? 'got' : ''} m${i + 1}"><span>${MEDALS[i]}</span><b>${d.unit === 's' ? t.toFixed(0) : t} ${unitLabel(d)}</b></li>`).join('')}</ol>
        <div class="row"><button class="btn go start" tabindex="${open ? 0 : -1}"><i class="ph-fill ph-play"></i>Fly drill</button><span class="dim ac-tip">${esc(toNext || 'R restarts instantly')}</span></div>
      </div></div>
    </div>`;
  }

  function render(body: HTMLElement) {
    const rec = allRecords();
    body.innerHTML = `
      ${skillBlock()}
      <div class="ac-tabs seg" role="tablist">
        <button role="tab" data-tab="drills" class="${tab === 'drills' ? 'on' : ''}" aria-selected="${tab === 'drills'}">Drills</button>
        <button role="tab" data-tab="missions" class="${tab === 'missions' ? 'on' : ''}" aria-selected="${tab === 'missions'}">Missions</button>
      </div>
      <div class="ac-list"></div>`;
    const list = body.querySelector<HTMLElement>('.ac-list')!;
    if (tab === 'drills') {
      list.innerHTML = `<p class="note">Short tests of one skill each, on a fixed drone, so every run compares. Bronze, Silver, Gold and Shine. R, Back or the reset button restarts at once.</p>`
        + DRILLS.map(d => row(d, rec[d.id])).join('');
    } else ui.renderTrain(list);
    body.onclick = e => {
      const t = e.target as HTMLElement;
      const tb = t.closest<HTMLElement>('[data-tab]');
      if (tb) { audio.tick(); tab = tb.dataset.tab as typeof tab; render(body); return; }
      const start = t.closest('.ac-drill .start');
      if (start) { audio.start(); startDrill(t.closest<HTMLElement>('[data-drill]')!.dataset.drill as DrillId); return; }
      const head = t.closest<HTMLElement>('.ac-head');
      if (head) {
        audio.tick();
        const id = head.parentElement!.dataset.drill as DrillId;
        openRow = openRow === id ? null : id;
        body.querySelectorAll<HTMLElement>('.ac-drill').forEach(x => {
          const on = x.dataset.drill === openRow;
          x.classList.toggle('open', on);
          x.querySelector('.ac-head')!.setAttribute('aria-expanded', String(on));
          x.querySelector<HTMLElement>('.start')!.tabIndex = on ? 0 : -1;
        });
      }
    };
  }

  // ------------------------------------------------------------------ runs
  let levelBefore = pilotLevel();
  function startDrill(id: DrillId) {
    hideResult();
    rangeInput.touchFire = false;
    void g.startMission(makeDrill(id, g, onEnd));
  }
  function onEnd(o: DrillOutcome) {
    levelBefore = pilotLevel();
    const res = o.status === 'success' && o.value != null ? recordAttempt(o.def, o.value) : null;
    showResult(o, res);
  }

  // ------------------------------------------------------------------ in flight overlay
  const hud = el(`<div class="ac-hud" aria-hidden="true">
    <div class="ac-cross"><i></i></div>
    <button class="ac-fire live" type="button" aria-label="Fire"><i class="ph-fill ph-lightning"></i><span>FIRE</span></button>
    <div class="ac-pops"></div>
  </div>`);
  ui.root.append(hud);
  const cross = hud.querySelector<HTMLElement>('.ac-cross')!;
  const fire = hud.querySelector<HTMLElement>('.ac-fire')!;
  const pops = hud.querySelector<HTMLElement>('.ac-pops')!;
  fire.addEventListener('pointerdown', e => {
    e.preventDefault();
    rangeInput.touchFire = true; fire.classList.add('on');
    const up = (ev: PointerEvent) => { if (ev.pointerId !== e.pointerId) return; rangeInput.touchFire = false; fire.classList.remove('on'); removeEventListener('pointerup', up); removeEventListener('pointercancel', up); };
    addEventListener('pointerup', up); addEventListener('pointercancel', up);
  });
  let lastHits = 0;

  g.on('frame', () => {
    const range = activeRange;
    const flying = g.state === 'mission' && isDrill(g.mission) && !g.paused;
    hud.classList.toggle('on', flying && !!range);
    if (resultOpen) padResult();
    if (!flying || !range || !g.sim) { lastHits = 0; return; }
    const touchish = g.input.device === 'touch' || g.input.device === 'rc' || coarse();
    hud.classList.toggle('touch', touchish);
    hud.classList.toggle('hw', g.input.device === 'rc' || g.input.device === 'gamepad');
    const p = g.project(range.aimPoint);
    cross.style.transform = `translate(${p.x.toFixed(1)}px, ${p.y.toFixed(1)}px)`;
    cross.hidden = p.behind;
    cross.classList.toggle('lock', !!range.lock);
    if (range.hits > lastHits) {
      lastHits = range.hits;
      const pop = el(`<b class="ac-pop">+100</b>`);
      pop.style.left = `${p.x}px`; pop.style.top = `${p.y - 30}px`;
      pops.append(pop);
      setTimeout(() => pop.remove(), 700);
    }
  });

  g.on('state', () => {
    if (g.state !== 'result') hideResult();
    // back from a mission lands on the mission logbook
    if (g.state === 'mission' && g.mission && !isDrill(g.mission)) tab = 'missions';
    if (g.state === 'mission' && isDrill(g.mission)) tab = 'drills';
  });

  // ------------------------------------------------------------------ results screen
  const result = el(`<div class="ac-result live" inert><div class="ac-box" role="dialog" aria-modal="true" aria-label="Drill result"></div></div>`);
  ui.root.append(result);
  const box = result.querySelector<HTMLElement>('.ac-box')!;
  let resultOpen = false;
  let current: DrillDef | null = null;

  function hideResult() { if (!resultOpen) return; resultOpen = false; result.classList.remove('open'); result.inert = true; }

  function showResult(o: DrillOutcome, r: AttemptResult | null) {
    current = o.def;
    const d = o.def;
    const lines: string[] = [];
    let html = '';
    if (!r) {
      html = `
        <p class="ac-drill-name">${d.title}</p>
        <h2 class="ac-score fail">CRASHED</h2>
        <p class="ac-line">${esc(o.reason)}</p>
        <p class="ac-line dim">Only finished runs count. Your best stays where it is.</p>`;
    } else {
      const rec = allRecords()[d.id];
      const medal = r.medal;
      const best = rec.best!;
      const headline = r.isBest && r.prevBest != null ? `NEW BEST, ${deltaText(d, r.prevBest, r.value)}` : r.isBest ? 'FIRST RUN ON RECORD' : `BEST ${formatValue(d, best)}`;
      const nextI = d.medals.findIndex(t => (d.lower ? r.value > t : r.value < t));
      const near = nextI >= 0 ? `${d.lower ? (r.value - d.medals[nextI]).toFixed(d.unit === 's' ? 2 : 0) : Math.round(d.medals[nextI] - r.value)} ${unitLabel(d)} TO ${MEDALS[nextI]}` : '';
      for (const l of r.award.lines) lines.push(`<li><b>+${l.xp} XP</b><span>${esc(l.label)}</span></li>`);
      html = `
        <p class="ac-drill-name">${d.title}</p>
        <h2 class="ac-score">${formatValue(d, r.value)}</h2>
        <p class="ac-medal ${medal ? 'm' + medal : 'none'}">${medal ? medalName(medal) : 'NO MEDAL'}${r.medal > r.medalBefore ? '<span>NEW</span>' : ''}</p>
        <p class="ac-line ${r.isBest ? 'best' : ''}">${headline}</p>
        ${near ? `<p class="ac-line dim">${near}</p>` : ''}
        <p class="ac-line dim">${esc(o.detail)}</p>
        <div class="ac-history"><span>LAST ${r.history.length}</span>${sparkline(d, r.history, 220, 40)}</div>
        <div class="ac-psline"><span>PILOT SKILL</span><b>${Math.round(r.pilotSkill)}</b><em class="${r.weekDelta >= 0.5 ? 'up' : ''}">${weekLine(r.weekDelta, true)}</em></div>
        ${lines.length ? `<ul class="ac-xp">${lines.join('')}</ul>` : ''}
        <div class="ac-level"><div class="ac-lvl"><b>LEVEL <span data-lvl>${levelBefore.level}</span></b><em data-xp></em></div><i><b data-fill></b></i></div>
        <p class="ac-unlocks" hidden></p>`;
    }
    const idx = DRILLS.findIndex(x => x.id === d.id);
    box.innerHTML = html + `
      <div class="ac-acts">
        <button class="btn go" data-a="again"><i class="ph ph-arrow-counter-clockwise"></i>Again<kbd>R</kbd></button>
        <button class="btn line" data-a="next">${DRILLS[(idx + 1) % DRILLS.length].title.toLowerCase().replace(/^\w|\s\w/g, c => c.toUpperCase())} <i class="ph ph-arrow-right"></i></button>
        <button class="btn quiet" data-a="academy">Academy</button>
      </div>`;
    resultOpen = true;
    result.inert = false;
    result.classList.add('open');
    box.querySelector<HTMLElement>('[data-a=again]')!.focus({ preventScroll: true });
    if (r) {
      if (r.medal > r.medalBefore || r.isBest) audio.success(); else audio.chime(2);
      animateXp(r);
    } else audio.warn();
  }

  function animateXp(r: AttemptResult) {
    const a = r.award;
    const fill = box.querySelector<HTMLElement>('[data-fill]')!;
    const xpEl = box.querySelector<HTMLElement>('[data-xp]')!;
    const lvlEl = box.querySelector<HTMLElement>('[data-lvl]')!;
    const frac0 = levelBefore.xpIntoLevel / levelBefore.xpToNext;
    const frac1 = a.levelAfter >= 50 ? 1 : a.xpIntoLevel / a.xpToNext;
    fill.style.transition = 'none';
    fill.style.transform = `scaleX(${frac0})`;
    xpEl.textContent = `${levelBefore.xpIntoLevel} / ${levelBefore.xpToNext} XP`;
    void fill.offsetWidth;
    const show = () => { xpEl.textContent = a.levelAfter >= 50 ? 'TOP LEVEL' : `${a.xpIntoLevel} / ${a.xpToNext} XP`; };
    if (a.total <= 0) { show(); return; }
    const go = (to: number, ms: number) => { fill.style.transition = `transform ${ms}ms cubic-bezier(0.23, 1, 0.32, 1)`; fill.style.transform = `scaleX(${to})`; };
    setTimeout(() => {
      if (a.levelAfter > a.levelBefore) {
        go(1, 420);
        setTimeout(() => {
          lvlEl.textContent = String(a.levelAfter);
          box.querySelector('.ac-level')!.classList.add('up');
          audio.success();
          fill.style.transition = 'none'; fill.style.transform = 'scaleX(0)'; void fill.offsetWidth;
          go(frac1, 520); show();
          const un = box.querySelector<HTMLElement>('.ac-unlocks')!;
          if (a.unlocks.length) { un.hidden = false; un.innerHTML = `<span>UNLOCKED</span>${a.unlocks.map(u => `<b>${esc(u)}</b>`).join('')}`; }
        }, 460);
      } else { go(frac1, 520); show(); }
    }, 260);
  }

  function act(a: string) {
    audio.tick();
    if (a === 'again') { hideResult(); g.restartMission(); }
    if (a === 'next' && current) { const i = DRILLS.findIndex(x => x.id === current!.id); startDrill(DRILLS[(i + 1) % DRILLS.length].id); }
    if (a === 'academy') { hideResult(); g.enterMenu().then(() => { tab = 'drills'; ui.openSheet('academy'); }); }
  }
  box.addEventListener('click', e => { const b = (e.target as HTMLElement).closest<HTMLElement>('[data-a]'); if (b) act(b.dataset.a!); });
  addEventListener('keydown', e => {
    if (!resultOpen) return;
    if (e.code === 'KeyR' || (e.code === 'Enter' && !(document.activeElement as HTMLElement)?.closest?.('.ac-box button'))) { e.preventDefault(); e.stopPropagation(); act('again'); }
    else if (e.code === 'Escape') { e.preventDefault(); e.stopPropagation(); act('academy'); }
    else if (e.code === 'KeyN') { e.preventDefault(); e.stopPropagation(); act('next'); }
  }, true);
  function padResult() {
    const inp = g.input;
    if (inp.padHit(0)) { const f = document.activeElement as HTMLElement | null; if (f?.closest('.ac-box') && f.dataset.a) act(f.dataset.a); else act('again'); }
    else if (inp.padHit(1)) act('academy');
    else if (inp.padHit(8)) act('again');
    else if (inp.padHit(12) || inp.padHit(13) || inp.padHit(14) || inp.padHit(15)) {
      const items = [...box.querySelectorAll<HTMLElement>('[data-a]')];
      const cur = items.indexOf(document.activeElement as HTMLElement);
      const d = inp.padHit(13) || inp.padHit(15) ? 1 : -1;
      items[(cur + d + items.length) % items.length].focus();
    }
  }

  return {
    open(t?: 'drills' | 'missions') { if (t) tab = t; ui.openSheet('academy'); },
    start: startDrill,
    def: drillDef,
  };
}

