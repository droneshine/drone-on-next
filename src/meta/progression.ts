import { getLS, setLS } from '../game/store';
import { UNLOCKS, unlockLabel, isCosmetic, type CosmeticKind } from './unlocks';

// Pilot progression: one level for the whole game, XP from every mode (GDD 3.3, 6.13).
// This is the shared API; Royale, the Academy and the missions only call these functions.
// The Spielwiese programmer owns this file and the unlock track behind it (src/meta/unlocks.ts).

export type XpSource = 'royale' | 'drill' | 'mission' | 'airtime' | 'workshop' | 'daily';
export interface XpLine { label: string; xp: number; }
/** unlocks: display labels of everything the level ups opened, e.g. "BLUE LEDS", "PAINT EVERGREEN" */
export interface AwardResult { lines: XpLine[]; total: number; levelBefore: number; levelAfter: number; xpIntoLevel: number; xpToNext: number; unlocks: string[]; }

export type Equipped = Record<CosmeticKind, string | null>;
interface PilotSave {
  xp: number; level: number; rating: number; royaleMatches: number; flags: Record<string, true>;
  /** unlock ids this pilot owns (level track and, later, feats) */
  owned: string[];
  equipped: Equipped;
  /** per day XP caps (airtime, drill bests) */
  daily: { date: string; used: Record<string, number> };
  /** title picked by hand, so a new title only auto equips while the pilot never chose one */
  titlePicked: boolean;
}

export const MAX_LEVEL = 50;
export const xpToNext = (level: number) => Math.min(3000, 400 + 100 * (level - 1));
const today = () => new Date().toISOString().slice(0, 10);

function load(): PilotSave {
  const s = getLS<Partial<PilotSave>>('pilot', {});
  const num = (v: unknown, d: number, lo: number, hi: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d);
  const level = Math.round(num(s.level, 1, 1, MAX_LEVEL));
  // everything the level already earned is owned, whatever an old or edited save says
  const owned = new Set<string>(Array.isArray(s.owned) ? s.owned.filter(x => typeof x === 'string' && UNLOCKS.some(u => u.id === x)) : []);
  for (const u of UNLOCKS) if (u.level <= level) owned.add(u.id);
  const eqIn = (s.equipped && typeof s.equipped === 'object' ? s.equipped : {}) as Partial<Equipped>;
  const eq = (k: CosmeticKind, d: string | null) => { const v = eqIn[k]; return typeof v === 'string' && owned.has(v) && UNLOCKS.find(u => u.id === v)?.kind === k ? v : d; };
  const daily = s.daily && typeof s.daily === 'object' && typeof s.daily.date === 'string' && s.daily.used && typeof s.daily.used === 'object' ? s.daily : { date: today(), used: {} };
  return {
    xp: num(s.xp, 0, 0, 1e9), level, rating: num(s.rating, 1000, 600, 2000),
    royaleMatches: Math.round(num(s.royaleMatches, 0, 0, 1e7)),
    flags: s.flags && typeof s.flags === 'object' && !Array.isArray(s.flags) ? s.flags as Record<string, true> : {},
    owned: [...owned],
    equipped: { paint: eq('paint', 'paint-field'), led: eq('led', 'led-nav'), trail: eq('trail', null), title: eq('title', 'title-new'), flourish: eq('flourish', null) },
    daily: daily.date === today() ? daily : { date: today(), used: {} },
    titlePicked: s.titlePicked === true,
  };
}
const listeners: (() => void)[] = [];
function save(p: PilotSave) { setLS('pilot', p); for (const f of listeners) { try { f(); } catch (e) { console.error(e); } } }

/** Add XP lines and return what happened (for results screens). Unlocks are owned and saved right away. */
export function awardXp(lines: XpLine[], _source: XpSource): AwardResult {
  const p = load();
  const clean = lines.filter(l => Number.isFinite(l.xp) && l.xp > 0).map(l => ({ label: l.label, xp: Math.round(l.xp) }));
  const total = clean.reduce((a, l) => a + l.xp, 0);
  const levelBefore = p.level;
  p.xp += total;
  while (p.level < MAX_LEVEL && p.xp >= xpToNext(p.level)) { p.xp -= xpToNext(p.level); p.level++; }
  if (p.level >= MAX_LEVEL) p.xp = Math.min(p.xp, xpToNext(MAX_LEVEL));
  const unlocks: string[] = [];
  for (const u of UNLOCKS) {
    if (u.level <= levelBefore || u.level > p.level) continue;
    if (!p.owned.includes(u.id)) p.owned.push(u.id);
    unlocks.push(unlockLabel(u));
    // a first trail or a new title shows up without a trip to the Pilot panel
    if (u.kind === 'trail' && !p.equipped.trail) p.equipped.trail = u.id;
    if (u.kind === 'title' && !p.titlePicked) p.equipped.title = u.id;
  }
  save(p);
  return { lines: clean, total, levelBefore, levelAfter: p.level, xpIntoLevel: p.xp, xpToNext: xpToNext(p.level), unlocks };
}

export function pilotLevel() { const p = load(); return { level: p.level, xpIntoLevel: p.xp, xpToNext: xpToNext(p.level) }; }
export function pilotRating() { return load().rating; }
export function adjustRating(delta: number) { const p = load(); p.rating = Math.min(2000, Math.max(600, p.rating + delta)); save(p); }
export function royaleMatchesPlayed() { return load().royaleMatches; }
export function countRoyaleMatch() { const p = load(); p.royaleMatches++; save(p); }

/** true exactly once per profile for this key (onboarding prompts, first time rewards) */
export function firstTime(key: string): boolean {
  const p = load();
  if (p.flags[key]) return false;
  p.flags[key] = true; save(p);
  return true;
}
export function hasFlag(key: string) { return !!load().flags[key]; }

// ------------------------------------------------------------------ Spielwiese additions

/** Grants up to `want` XP from a daily budget (airtime 60, drill bests 250) and books it. */
export function capDaily(key: string, cap: number, want: number): number {
  const p = load();
  const used = p.daily.used[key] ?? 0;
  const give = Math.max(0, Math.min(want, cap - used));
  if (give > 0) { p.daily.used[key] = used + give; save(p); }
  return give;
}

/** called after any change to the pilot save: XP, unlocks, equipped cosmetics */
export function onPilotChange(fn: () => void) { listeners.push(fn); }

/** owned unlock ids and equipped cosmetics; src/meta/cosmetics.ts is the public face of these */
export function pilotOwned(): Set<string> { return new Set(load().owned); }
export function pilotEquipped(): Equipped { return { ...load().equipped }; }
export function setEquipped(kind: CosmeticKind, id: string | null): boolean {
  const p = load();
  if (id !== null && (!p.owned.includes(id) || UNLOCKS.find(u => u.id === id)?.kind !== kind || !isCosmetic(kind))) return false;
  if (id === null && (kind === 'paint' || kind === 'led' || kind === 'title')) return false;
  p.equipped[kind] = id;
  if (kind === 'title') p.titlePicked = true;
  save(p);
  return true;
}
