import type { UI } from '../ui/ui';
import { getLS, setLS } from '../game/store';
import { audio } from '../audio/audio';
import { pilotLevel, onPilotChange, MAX_LEVEL, type AwardResult } from './progression';
import { cosmetics, equippedCosmetics, equip, type Cosmetic } from './cosmetics';
import { unlocksAt, unlockLabel, type CosmeticKind } from './unlocks';
import { skillBlock } from '../academy/academy';
import { allRecords, pilotSkill } from '../academy/records';

// Pilot profile (GDD 3.3): level bar, title, Pilot Skill, cosmetics to wear, the unlock track ahead.
// Also the rail chip that opens it and the level up banner for XP earned outside a results screen.

const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
const el = (html: string) => { const t = document.createElement('template'); t.innerHTML = html.trim(); return t.content.firstElementChild as HTMLElement; };

export const pilotName = () => getLS<string>('pilotName', '').trim() || 'Pilot';

function nextUnlocks(level: number, count = 5) {
  const out: { level: number; items: string[] }[] = [];
  for (let l = level + 1; l <= MAX_LEVEL && out.length < count; l++) {
    const u = unlocksAt(l);
    if (u.length) out.push({ level: l, items: u.map(unlockLabel) });
  }
  return out;
}

export function levelBar() {
  const p = pilotLevel();
  const frac = p.level >= MAX_LEVEL ? 1 : p.xpIntoLevel / p.xpToNext;
  return { ...p, frac, text: p.level >= MAX_LEVEL ? 'TOP LEVEL' : `${p.xpIntoLevel} / ${p.xpToNext} XP` };
}

export function installPilot(ui: UI) {
  // ------------------------------------------------------------------ rail chip
  const slot = ui.rail.querySelector<HTMLElement>('.rail-pilot')!;
  const chip = el(`<button class="pilot-chip" type="button" aria-label="Pilot profile"></button>`);
  slot.append(chip);
  const renderChip = () => {
    const b = levelBar();
    chip.innerHTML = `<b class="pc-lv">${b.level}</b>
      <span class="pc-main"><strong>${esc(pilotName())}</strong><em>${esc(equippedCosmetics().title.name)}</em></span>
      <span class="pc-side"><span>LEVEL ${b.level}</span><i><b style="transform:scaleX(${b.frac.toFixed(3)})"></b></i><small>${b.text}</small></span>
      <span class="pc-skill"><small>PILOT SKILL</small><b>${Math.round(pilotSkill(allRecords()))}</b></span>`;
  };
  renderChip();
  chip.addEventListener('click', () => { audio.start(); audio.tick(); ui.openSheet('pilot'); });

  // ------------------------------------------------------------------ sheet
  ui.registerSheet('pilot', 'Pilot', body => render(body));

  function swatches(kind: CosmeticKind, list: Cosmetic[], cur: string | null, allowNone: boolean) {
    const none = allowNone ? `<button type="button" class="pp-sw none${cur ? '' : ' on'}" data-kind="${kind}" data-id="" aria-pressed="${!cur}"><i></i><span>OFF</span></button>` : '';
    return `<div class="pp-sws">${none}${list.map(c => {
      const bg = kind === 'paint' ? `linear-gradient(135deg, ${c.colors[0]} 0 55%, ${c.colors[1]} 55% 100%)`
        : c.colors.length > 1 ? `linear-gradient(90deg, ${c.colors[0]} 0 50%, ${c.colors[1]} 50% 100%)` : c.colors[0];
      return `<button type="button" class="pp-sw${c.id === cur ? ' on' : ''}${c.owned ? '' : ' locked'}" data-kind="${kind}" data-id="${c.id}" aria-pressed="${c.id === cur}" ${c.owned ? '' : 'aria-disabled="true"'}>
        <i style="background:${bg}"></i><span>${esc(c.name)}</span>${c.owned ? '' : `<em>LEVEL ${c.level}</em>`}</button>`;
    }).join('')}</div>`;
  }
  function chips(kind: CosmeticKind, list: Cosmetic[], cur: string | null, allowNone: boolean) {
    return `<div class="pp-chips">${allowNone ? `<button type="button" class="pp-chip${cur ? '' : ' on'}" data-kind="${kind}" data-id="" aria-pressed="${!cur}">NONE</button>` : ''}${list.map(c =>
      `<button type="button" class="pp-chip${c.id === cur ? ' on' : ''}${c.owned ? '' : ' locked'}" data-kind="${kind}" data-id="${c.id}" aria-pressed="${c.id === cur}" ${c.owned ? '' : 'aria-disabled="true"'}>${esc(c.name)}${c.owned ? '' : `<em>${c.level}</em>`}</button>`).join('')}</div>`;
  }

  function render(body: HTMLElement) {
    const b = levelBar();
    const eq = equippedCosmetics();
    const ahead = nextUnlocks(b.level);
    body.innerHTML = `
      <div class="pp-head">
        <div class="pp-id">
          <div class="field"><label for="pp-name">Pilot name</label><input id="pp-name" type="text" maxlength="18" value="${esc(getLS<string>('pilotName', ''))}" placeholder="Pilot" autocomplete="nickname" enterkeyhint="done" /></div>
          <p class="pp-title">${esc(eq.title.name)}</p>
        </div>
        <div class="pp-level">
          <span>LEVEL</span><b>${b.level}</b>
          <div class="pp-bar"><i><b style="transform:scaleX(${b.frac.toFixed(3)})"></b></i><small>${b.text}</small></div>
        </div>
      </div>
      ${ahead.length ? `<p class="pp-next"><span>NEXT</span>LEVEL ${ahead[0].level}: ${ahead[0].items.map(esc).join(', ')}</p>` : ''}
      ${skillBlock()}
      <p class="note pp-xpnote">XP comes from every mode: Royale matches, first drill medals and personal bests, first mission stars, your first Workshop drone, and airtime in free flight, 5 a minute up to 60 a day.</p>
      <h3 class="group-h">Title</h3>
      ${chips('title', cosmetics('title'), eq.title.id, false)}
      <h3 class="group-h">Paint</h3>
      <p class="note">Worn in Royale and given to new Workshop drones.</p>
      ${swatches('paint', cosmetics('paint'), eq.paint.id, false)}
      <h3 class="group-h">LED colour</h3>
      <p class="note">Lights up the arms of your Workshop drones.</p>
      ${swatches('led', cosmetics('led'), eq.led.id, false)}
      <h3 class="group-h">Trail</h3>
      <p class="note">Follows your drone in free flight and Royale when it flies fast.</p>
      ${swatches('trail', cosmetics('trail'), eq.trail?.id ?? null, true)}
      <h3 class="group-h">Victory flourish</h3>
      ${chips('flourish', cosmetics('flourish'), eq.flourish?.id ?? null, true)}
      <h3 class="group-h">Unlock track</h3>
      <ol class="pp-track">${ahead.concat(nextUnlocks(ahead.length ? ahead[ahead.length - 1].level : MAX_LEVEL, 5)).map(x => `<li><b>${x.level}</b><span>${x.items.map(esc).join(', ')}</span></li>`).join('') || '<li><span>Every unlock is yours.</span></li>'}</ol>`;
    body.onclick = e => {
      const t = (e.target as HTMLElement).closest<HTMLElement>('[data-kind]');
      if (!t) return;
      if (t.classList.contains('locked')) { ui.toast(`Opens at level ${t.querySelector('em')?.textContent?.replace(/\D/g, '')}`); return; }
      audio.tick();
      if (equip(t.dataset.kind as CosmeticKind, t.dataset.id || null)) { render(body); renderChip(); }
    };
    const name = body.querySelector<HTMLInputElement>('#pp-name')!;
    name.onchange = () => { setLS('pilotName', name.value.replace(/\s+/g, ' ').trim().slice(0, 18)); renderChip(); };
    name.onkeydown = e => { if (e.key === 'Enter') name.blur(); };
  }

  onPilotChange(renderChip);

  // ------------------------------------------------------------------ level up banner
  const banner = el(`<div class="lvl-up" aria-live="polite"></div>`);
  ui.root.append(banner);
  let hideT = 0;
  /** XP earned outside a results screen: a quiet toast, and a banner when a level was reached */
  function celebrate(a: AwardResult, what = '') {
    renderChip();
    if (a.levelAfter > a.levelBefore) {
      banner.innerHTML = `<b>LEVEL ${a.levelAfter}</b>${a.unlocks.length ? `<span>UNLOCKED: ${a.unlocks.map(esc).join(', ')}</span>` : ''}`;
      banner.classList.add('on');
      audio.success();
      clearTimeout(hideT);
      hideT = window.setTimeout(() => banner.classList.remove('on'), 4200);
    } else if (a.total > 0) ui.toast(`+${a.total} XP ${what || a.lines[0]?.label || ''}`.trim());
  }
  return { celebrate, renderChip };
}
