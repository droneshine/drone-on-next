import { getLS, setLS } from '../game/store';

// Pilot progression: one level for the whole game, XP from every mode (GDD 3.3, 6.13).
// This is the shared API; Royale, the Academy and the missions only call these functions.
// The Spielwiese programmer owns this file and the unlock track behind it.

export type XpSource = 'royale' | 'drill' | 'mission' | 'airtime' | 'workshop' | 'daily';
export interface XpLine { label: string; xp: number; }
export interface AwardResult { lines: XpLine[]; total: number; levelBefore: number; levelAfter: number; xpIntoLevel: number; xpToNext: number; unlocks: string[]; }

interface PilotSave { xp: number; level: number; rating: number; royaleMatches: number; flags: Record<string, true>; }

const MAX_LEVEL = 50;
export const xpToNext = (level: number) => Math.min(3000, 400 + 100 * (level - 1));

function load(): PilotSave {
  const s = getLS<Partial<PilotSave>>('pilot', {});
  const num = (v: unknown, d: number, lo: number, hi: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d);
  return {
    xp: num(s.xp, 0, 0, 1e9), level: Math.round(num(s.level, 1, 1, MAX_LEVEL)), rating: num(s.rating, 1000, 600, 2000),
    royaleMatches: Math.round(num(s.royaleMatches, 0, 0, 1e7)),
    flags: s.flags && typeof s.flags === 'object' && !Array.isArray(s.flags) ? s.flags as Record<string, true> : {},
  };
}
function save(p: PilotSave) { setLS('pilot', p); }

/** Add XP lines and return what happened (for results screens). */
export function awardXp(lines: XpLine[], _source: XpSource): AwardResult {
  const p = load();
  const clean = lines.filter(l => Number.isFinite(l.xp) && l.xp > 0).map(l => ({ label: l.label, xp: Math.round(l.xp) }));
  const total = clean.reduce((a, l) => a + l.xp, 0);
  const levelBefore = p.level;
  p.xp += total;
  while (p.level < MAX_LEVEL && p.xp >= xpToNext(p.level)) { p.xp -= xpToNext(p.level); p.level++; }
  save(p);
  return { lines: clean, total, levelBefore, levelAfter: p.level, xpIntoLevel: p.xp, xpToNext: xpToNext(p.level), unlocks: [] };
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
