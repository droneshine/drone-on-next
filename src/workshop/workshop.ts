import type { Game } from '../game/game';
import { fmtMass, type UI } from '../ui/ui';
import { audio } from '../audio/audio';
import { saveCustomDrone } from '../game/store';
import type { DroneSpec } from '../sim/spec';
import { awardXp, firstTime, pilotLevel, type AwardResult } from '../meta/progression';
import { cosmetics, equip, partOpen, partLevel } from '../meta/cosmetics';
import {
  FRAMES, MOTORS, PROPS, TOOLS, TUNES, CAPACITIES, packLimits, compute, newBuild, builds, saveBuild, isExpertTuned,
  frameOf, motorOf, type Build,
} from './parts';
import './workshop.css';

// The Workshop parts builder (GDD 3.4): five parts plus name, paint and tune, live numbers,
// the drone updating on the pad, EXPERT NUMBERS for the raw editor. Saved drones go to the hangar.

const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
const LAYOUT_NAME: Record<string, string> = { quadX: 'QUAD', hexX: 'HEX', octoX: 'OCTO', coaxX8: 'COAX X8' };
const inch = (d: number) => `${Math.round(d / 0.0254)} IN`;

export function installWorkshop(g: Game, ui: UI, celebrate: (a: AwardResult) => void) {
  let draft: Build = newBuild();
  let previewTimer = 0;
  let sheet: HTMLElement | null = null;

  const open = (b?: Build) => {
    draft = b ? { ...b } : newBuild();
    // a fresh build starts with the paint you wear
    ui.openSheet('workshop');
  };

  ui.registerSheet('workshop', 'Build a drone', body => render(body));
  sheet = ui.sheets.workshop;

  // closing the builder: the pad shows your own drone again, and Back lands in the Workshop list
  new MutationObserver(() => {
    if (sheet!.classList.contains('open')) return;
    clearTimeout(previewTimer);
    const other = Object.values(ui.sheets).some(s => s.classList.contains('open'));
    if (g.state !== 'menu' || other) return;
    if (g.spec !== g.chosenSpec) void g.setDrone(g.chosenSpec);
    ui.openSheet('hangar');
  }).observe(sheet, { attributes: true, attributeFilter: ['class'] });

  const preview = () => {
    clearTimeout(previewTimer);
    previewTimer = window.setTimeout(() => {
      if (!sheet!.classList.contains('open') || g.state !== 'menu') return;
      void g.setDrone(compute(draft).spec);
    }, 220);
  };

  function statsHtml() {
    const c = compute(draft);
    const fact = (v: string, l: string, bad = false) => `<div class="fact"><b class="${bad ? 'bad' : ''}">${v}</b><span>${l}</span></div>`;
    return `
      ${fact(fmtMass(c.takeoff), draft.tool === 'spray' ? 'TAKE OFF MASS, FULL TANK' : 'TAKE OFF MASS')}
      ${fact(c.tw.toFixed(2), 'THRUST TO WEIGHT', c.tw < 1.5)}
      ${fact(`${c.hoverMin.toFixed(c.hoverMin < 10 ? 1 : 0)} min`, 'HOVER TIME')}
      ${fact(`${c.gps} m/s`, 'GPS TOP SPEED')}
      ${fact(c.acro > 0 ? `${Math.round(c.acro)} m/s` : 'none', 'ACRO TOP SPEED, ABOUT')}
      <div class="fact like"><b>${esc(c.fliesLike)}</b><span>FLIES LIKE</span></div>`;
  }
  function msgHtml() {
    const c = compute(draft);
    return c.problems.map(p => `<p>${esc(p)}</p>`).join('');
  }
  /** numbers, messages and the save buttons, without rebuilding the controls under a finger */
  function refresh(body: HTMLElement) {
    const c = compute(draft);
    body.querySelector('.ws-stats')!.innerHTML = statsHtml();
    const msg = body.querySelector<HTMLElement>('.ws-msg')!;
    msg.innerHTML = msgHtml(); msg.hidden = !c.problems.length;
    body.querySelectorAll<HTMLButtonElement>('[data-save]').forEach(b => { b.disabled = !c.canSave; });
    preview();
  }

  function opt(slot: string, v: string | number, on: boolean, name: string, detail: string, unlock?: string) {
    const free = !unlock || partOpen(unlock);
    return `<button type="button" class="ws-opt${on ? ' on' : ''}${free ? '' : ' locked'}" data-slot="${slot}" data-v="${v}" aria-pressed="${on}" ${free ? '' : 'aria-disabled="true"'}>
      <b>${esc(name)}</b><span>${esc(detail)}</span>${free ? '' : `<em><i class="ph ph-lock-simple"></i>LEVEL ${partLevel(unlock!)}</em>`}</button>`;
  }

  function render(body: HTMLElement) {
    const scroll = body.scrollTop;
    const lvl = pilotLevel().level;
    const lim = packLimits(lvl);
    draft.cells = Math.min(draft.cells, lim.cells); draft.ah = Math.min(draft.ah, lim.ah);
    const f = frameOf(draft.frame), mo = motorOf(draft.motor);
    const capIdx = CAPACITIES.reduce((bi, v, i) => (Math.abs(v - draft.ah) < Math.abs(CAPACITIES[bi] - draft.ah) ? i : bi), 0);
    const capMax = CAPACITIES.findIndex(v => v >= lim.ah);
    const paints = cosmetics('paint');
    const existing = !!builds()[draft.id] && ui.custom.some(d => d.id === draft.id);
    body.innerHTML = `
      <div class="ws-stats calc" aria-live="polite">${statsHtml()}</div>
      <div class="ws-msg" role="status" ${compute(draft).problems.length ? '' : 'hidden'}>${msgHtml()}</div>
      <p class="note">Pick five parts. The drone on the pad changes with every part<span class="wide-only">, so you see it at real scale next to the base</span>. Cosmetics never change the numbers.</p>
      <h3 class="group-h">Frame</h3>
      <div class="ws-opts">${FRAMES.map(x => opt('frame', x.id, x.id === draft.frame, x.name, `${LAYOUT_NAME[x.layout]} ${Math.round(x.arm * 2000)} MM, PROPS TO ${inch(x.maxProp)}`, x.unlock)).join('')}</div>
      <h3 class="group-h">Motors</h3>
      <div class="ws-opts">${MOTORS.map(x => opt('motor', x.id, x.id === draft.motor, x.name, `${x.thrust} N, ${fmtMass(x.mass).toUpperCase()}, PROPS TO ${inch(x.maxProp)}`, x.unlock)).join('')}</div>
      <h3 class="group-h">Props</h3>
      <div class="ws-opts props">${PROPS.map(x => {
        const fit = x.d <= f.maxProp + 1e-9 && x.d <= mo.maxProp + 1e-9;
        return opt('prop', x.d, Math.abs(x.d - draft.prop) < 1e-6, x.name, fit ? `${Math.round(Math.min(mo.thrust, 900 * x.d * x.d))} N EACH` : 'TOO BIG HERE');
      }).join('')}</div>
      <h3 class="group-h">Battery</h3>
      <div class="fields">
        <div class="field"><label for="ws-cells">Cells<output class="num" data-out="cells">${draft.cells} S</output></label><input id="ws-cells" type="range" min="1" max="${lim.cells}" step="1" value="${draft.cells}" data-range="cells" /></div>
        <div class="field"><label for="ws-ah">Capacity<output class="num" data-out="ah">${draft.ah} Ah</output></label><input id="ws-ah" type="range" min="0" max="${capMax}" step="1" value="${capIdx}" data-range="ah" /></div>
      </div>
      <p class="help ws-help">${lvl < 22 ? `Up to ${lim.cells} S and ${lim.ah} Ah now. ${lvl < 12 ? 'Level 12 opens 12 S and 10 Ah.' : 'Level 22 opens 14 S and 30 Ah.'}` : 'Every pack size is open.'}</p>
      <h3 class="group-h">Tool</h3>
      <div class="ws-opts">${TOOLS.map(x => opt('tool', x.id, x.id === draft.tool, x.name, x.note.toUpperCase(), x.unlock)).join('')}</div>
      ${draft.tool === 'spray' ? `<div class="fields" style="margin-top:12px"><div class="field"><label for="ws-tank">Tank<output class="num" data-out="tank">${draft.tank} L</output></label><input id="ws-tank" type="range" min="2" max="30" step="1" value="${draft.tank}" data-range="tank" /></div></div>` : ''}
      ${draft.tool === 'lance' ? `<label class="toggle"><span>Ground hose<br><span class="help dim">A pump at the take off spot feeds the lance, the hose pulls on the drone</span></span><input type="checkbox" data-hose ${draft.hose ? 'checked' : ''} /></label>` : ''}
      <h3 class="group-h">Flight tune</h3>
      <div class="seg" data-tune>${TUNES.map(t => `<button type="button" data-v="${t.id}" class="${t.id === draft.tune ? 'on' : ''}" aria-pressed="${t.id === draft.tune}">${t.name}</button>`).join('')}</div>
      <p class="help ws-help">${draft.tune === 'freestyle' ? 'Starts in Acro, fast rates.' : draft.tune === 'smooth' ? 'Soft rates for filming and inspection.' : 'Balanced rates.'} ${frameOf(draft.frame).arm < 0.2 || draft.tune === 'freestyle' ? '' : 'Big frames start in GPS hold.'}</p>
      <h3 class="group-h">Name and paint</h3>
      <div class="fields"><div class="field wide"><label for="ws-name">Name</label><input id="ws-name" type="text" maxlength="32" value="${esc(draft.name)}" data-name enterkeyhint="done" /></div></div>
      <div class="ws-paints" role="radiogroup" aria-label="Paint">${paints.map(p => `<button type="button" class="ws-paint${p.id === draft.paint ? ' on' : ''}${p.owned ? '' : ' locked'}" data-paint="${p.id}" role="radio" aria-checked="${p.id === draft.paint}" ${p.owned ? '' : 'aria-disabled="true"'} title="${esc(p.name)}${p.owned ? '' : `, level ${p.level}`}">
        <i style="background:linear-gradient(135deg, ${p.colors[0]} 0 55%, ${p.colors[1]} 55% 100%)"></i><span>${esc(p.name)}</span>${p.owned ? '' : `<em>LEVEL ${p.level}</em>`}</button>`).join('')}</div>
      <div class="ws-acts">
        <button type="button" class="btn go" data-save="hangar"><i class="ph-fill ph-floppy-disk"></i>${existing ? 'Save changes' : 'Save to hangar'}</button>
        <button type="button" class="btn line" data-save="fly"><i class="ph-fill ph-play"></i>Save and fly</button>
        <button type="button" class="btn quiet" data-expert><i class="ph ph-sliders-horizontal"></i>Expert numbers</button>
      </div>
      <p class="help ws-help">Saving needs a thrust to weight of at least 1.5. Expert numbers opens every raw value; a drone changed there is marked EXPERT TUNED.</p>`;
    refresh(body);
    body.scrollTop = scroll;

    body.onclick = e => {
      const t = e.target as HTMLElement;
      const o = t.closest<HTMLElement>('.ws-opt');
      if (o) {
        if (o.classList.contains('locked')) { ui.toast(`Opens at level ${o.querySelector('em')?.textContent?.replace(/\D/g, '')}`); return; }
        audio.tick();
        const v = o.dataset.v!;
        if (o.dataset.slot === 'frame') {
          draft.frame = v;
          // a new frame takes the biggest prop both the frame and the motors can turn
          const fit = PROPS.filter(p => p.d <= frameOf(v).maxProp + 1e-9 && p.d <= motorOf(draft.motor).maxProp + 1e-9);
          if (fit.length) draft.prop = fit[fit.length - 1].d;
        }
        if (o.dataset.slot === 'motor') draft.motor = v;
        if (o.dataset.slot === 'prop') draft.prop = Number(v);
        if (o.dataset.slot === 'tool') draft.tool = v as Build['tool'];
        render(body);
        return;
      }
      const tune = t.closest<HTMLElement>('[data-tune] button');
      if (tune) { audio.tick(); draft.tune = tune.dataset.v as Build['tune']; render(body); return; }
      const paint = t.closest<HTMLElement>('[data-paint]');
      if (paint) {
        if (paint.classList.contains('locked')) { ui.toast(`${paint.querySelector('span')?.textContent} opens at level ${paint.querySelector('em')?.textContent?.replace(/\D/g, '')}`); return; }
        audio.tick(); draft.paint = paint.dataset.paint!;
        body.querySelectorAll<HTMLElement>('[data-paint]').forEach(x => { const on = x === paint; x.classList.toggle('on', on); x.setAttribute('aria-checked', String(on)); });
        refresh(body);
        return;
      }
      const sv = t.closest<HTMLButtonElement>('[data-save]');
      if (sv && !sv.disabled) { audio.tick(); void save(sv.dataset.save === 'fly'); return; }
      if (t.closest('[data-expert]')) {
        audio.tick();
        saveBuild(draft);
        ui.openEditor(compute(draft).spec);
      }
    };
    body.oninput = e => {
      const t = e.target as HTMLInputElement;
      if (t.dataset.range === 'cells') { draft.cells = Number(t.value); body.querySelector('[data-out=cells]')!.textContent = `${draft.cells} S`; }
      if (t.dataset.range === 'ah') { draft.ah = CAPACITIES[Number(t.value)]; body.querySelector('[data-out=ah]')!.textContent = `${draft.ah} Ah`; }
      if (t.dataset.range === 'tank') { draft.tank = Number(t.value); body.querySelector('[data-out=tank]')!.textContent = `${draft.tank} L`; }
      if (t.dataset.hose !== undefined) draft.hose = t.checked;
      if (t.dataset.name !== undefined) { draft.name = t.value.slice(0, 32); }
      refresh(body);
    };
    body.querySelector<HTMLInputElement>('[data-name]')!.onkeydown = e => { if (e.key === 'Enter') (e.target as HTMLElement).blur(); };
  }

  async function save(fly: boolean) {
    const c = compute(draft);
    if (!c.canSave) return;
    const spec: DroneSpec = c.spec;
    await saveCustomDrone(spec);
    saveBuild(draft);
    // bridge to Royale: the Workshop paint is the paint you wear
    equip('paint', draft.paint);
    await ui.loadCustom();
    if (firstTime('workshop-first')) celebrate(awardXp([{ label: 'FIRST WORKSHOP DRONE', xp: 100 }], 'workshop'));
    await g.chooseDrone(spec);
    ui.toast(`${spec.name} saved to the hangar`);
    if (fly) g.startFreeFlight(); else ui.openSheet('hangar');
  }

  // ------------------------------------------------------------------ the hangar becomes the Workshop
  ui.hangarHooks.top = body => {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'ws-entry';
    b.innerHTML = `<b>BUILD FROM PARTS</b><small>Frame, motors, props, battery and tool. Live numbers, then fly it.</small><i class="ph ph-arrow-right"></i>`;
    b.addEventListener('click', () => { audio.tick(); open(); });
    body.append(b);
  };
  ui.hangarHooks.badge = d => {
    const b = builds()[d.id];
    if (!b) return '';
    return `<em class="ws-badge${isExpertTuned(d, b) ? ' expert' : ''}">${isExpertTuned(d, b) ? 'EXPERT TUNED' : 'WORKSHOP'}</em>`;
  };
  ui.hangarHooks.edit = d => {
    const b = builds()[d.id];
    if (!b || isExpertTuned(d, b)) return false;
    open({ ...b, name: d.name });
    return true;
  };
  ui.hangarHooks.actions = (d, add) => {
    const b = builds()[d.id];
    if (b && isExpertTuned(d, b)) add('ph-wrench', 'Rebuild from parts', () => { audio.tick(); open({ ...b, name: d.name }); ui.toast('Saving here replaces the expert numbers with the parts'); });
  };

  return { open };
}
