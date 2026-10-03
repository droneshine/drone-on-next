import { getLS, setLS } from '../game/store';
import { awardXp, capDaily, type AwardResult, type XpLine } from '../meta/progression';

// Academy records: medals, personal bests, the last ten attempts, skill bars and Pilot Skill
// (GDD 3.1, 3.2, 6.13, 6.14). Saved under droneon2.academy.

export type DrillId = 'hover-lock' | 'ring-sprint' | 'slalom' | 'pad-hop' | 'target-range';
export type Unit = 's' | 'cm' | 'pts';

export interface DrillDef {
  id: DrillId;
  title: string;
  /** the skill bar it feeds */
  skill: string;
  unit: Unit;
  lower: boolean;
  /** BRONZE, SILVER, GOLD, SHINE thresholds (GDD 6.14) */
  medals: [number, number, number, number];
  drone: string;
  brief: string;
}

export const DRILLS: DrillDef[] = [
  { id: 'hover-lock', title: 'HOVER LOCK', skill: 'PRECISION', unit: 'cm', lower: true, medals: [60, 35, 20, 12], drone: 'SPARK, ANGLE',
    brief: 'Hold the Spark inside the one metre sphere four metres over the pad for 20 seconds, in a gusting 4 m/s wind. Angle mode only. Your score is the average distance from the centre.' },
  { id: 'ring-sprint', title: 'RING SPRINT', skill: 'SPEED', unit: 's', lower: true, medals: [45, 33, 26, 21], drone: 'SPARK, ANY MODE',
    brief: 'Ten rings from the base, around the solar field edge, through the aisle and back. The clock starts when the motors arm. GPS gets you round, Angle and Acro get you a medal.' },
  { id: 'slalom', title: 'SLALOM', skill: 'CONTROL', unit: 's', lower: true, medals: [40, 30, 24, 20], drone: 'SPARK, ANY MODE',
    brief: 'Eight pillars twelve metres apart down the apron line. Pass them on the marked side, left and right in turn, then fly through the gate. Each wrong side or touch adds 2 seconds.' },
  { id: 'pad-hop', title: 'PAD HOP', skill: 'LANDING', unit: 's', lower: true, medals: [75, 55, 42, 34], drone: 'DSCAN, ANY MODE',
    brief: 'Land on five platforms in order: two base pads, the 6 m and 12 m towers, then the office roof. A landing counts after half a second still within 1.5 m of the centre. Touching down faster than 2 m/s adds 3 seconds.' },
  { id: 'target-range', title: 'TARGET RANGE', skill: 'AIM', unit: 'pts', lower: false, medals: [600, 1000, 1400, 1700], drone: 'SPARK, GPS, PULSE',
    brief: 'Fifteen drone targets around the freestyle park, some on rails, 60 seconds. Aim by turning the drone, the shot bends onto a target near the crosshair. 100 per target, 5 per second left, minus 10 for every shot beyond three per hit.' },
];
export const drillDef = (id: string) => DRILLS.find(d => d.id === id);

export const MEDALS = ['BRONZE', 'SILVER', 'GOLD', 'SHINE'] as const;
const MEDAL_XP = [40, 60, 90, 150];

/** 0 none, 1 bronze, 2 silver, 3 gold, 4 shine */
export function medalFor(d: DrillDef, v: number): number {
  let m = 0;
  d.medals.forEach((t, i) => { if (d.lower ? v <= t : v >= t) m = i + 1; });
  return m;
}

/** GDD 6.14: 0 to 100 from the personal best */
export function skillScore(d: DrillDef, best: number | null): number {
  if (best == null) return 0;
  const [b, , , sh] = d.medals;
  const v = d.lower ? 100 * (1.5 * b - best) / (1.5 * b - sh) : 100 * (best - 0.5 * b) / (sh - 0.5 * b);
  return Math.max(0, Math.min(100, v));
}

export function formatValue(d: DrillDef, v: number): string {
  if (d.unit === 's') return `${v.toFixed(2)} S`;
  if (d.unit === 'cm') return `${Math.round(v)} CM`;
  return String(Math.round(v));
}
export function formatShort(d: DrillDef, v: number): string {
  if (d.unit === 's') return v.toFixed(1);
  return String(Math.round(v));
}
export const unitLabel = (d: DrillDef) => d.unit === 's' ? 'S' : d.unit === 'cm' ? 'CM' : 'POINTS';

/** "0.84 S FASTER", "6 CM CLOSER", "120 POINTS MORE" */
export function deltaText(d: DrillDef, prev: number, now: number): string {
  const diff = Math.abs(prev - now);
  if (d.unit === 's') return `${diff.toFixed(2)} S FASTER`;
  if (d.unit === 'cm') return `${Math.max(1, Math.round(diff))} CM CLOSER`;
  return `${Math.round(diff)} POINTS MORE`;
}

export interface Attempt { v: number; t: number; }
export interface DrillRec { best: number | null; attempts: Attempt[]; medal: number; }
interface Save { drills: Partial<Record<DrillId, DrillRec>>; week: { key: string; base: number } | null; }

function load(): Save {
  const s = getLS<Partial<Save>>('academy', {});
  const out: Save = { drills: {}, week: null };
  const raw = s.drills && typeof s.drills === 'object' ? s.drills as Record<string, Partial<DrillRec>> : {};
  for (const d of DRILLS) {
    const r = raw[d.id];
    if (!r || typeof r !== 'object') continue;
    const ok = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v < 1e6;
    const attempts = Array.isArray(r.attempts) ? r.attempts.filter(a => a && ok(a.v) && typeof a.t === 'number' && Number.isFinite(a.t)).slice(-10) as Attempt[] : [];
    out.drills[d.id] = { best: ok(r.best) ? r.best : null, attempts, medal: ok(r.medal) ? Math.min(4, Math.round(r.medal)) : 0 };
  }
  if (s.week && typeof s.week.key === 'string' && typeof s.week.base === 'number' && Number.isFinite(s.week.base)) out.week = s.week;
  return out;
}
function save(s: Save) { setLS('academy', s); }

export function drillRecord(id: DrillId): DrillRec { return load().drills[id] ?? { best: null, attempts: [], medal: 0 }; }
export function allRecords(): Record<DrillId, DrillRec> {
  const s = load();
  return Object.fromEntries(DRILLS.map(d => [d.id, s.drills[d.id] ?? { best: null, attempts: [], medal: 0 }])) as Record<DrillId, DrillRec>;
}

export function skills(rec = allRecords()) { return DRILLS.map(d => ({ def: d, score: skillScore(d, rec[d.id].best), tried: rec[d.id].best != null })); }
export function pilotSkill(rec = allRecords()) { const s = skills(rec); return s.reduce((a, x) => a + x.score, 0) / s.length; }

/** ISO week, so "this week" starts on Monday everywhere */
function weekKey(d = new Date()) {
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const y0 = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  return `${t.getUTCFullYear()}-${Math.ceil(((t.getTime() - y0.getTime()) / 864e5 + 1) / 7)}`;
}
/** the Pilot Skill the week started with is stored before the first change of the week */
function rollWeek(s: Save) {
  const k = weekKey();
  if (!s.week || s.week.key !== k) { s.week = { key: k, base: pilotSkillOf(s) }; save(s); }
}
function pilotSkillOf(s: Save) { return DRILLS.reduce((a, d) => a + skillScore(d, s.drills[d.id]?.best ?? null), 0) / DRILLS.length; }

export function weekDelta(): number {
  const s = load();
  rollWeek(s);
  return pilotSkillOf(s) - (s.week?.base ?? 0);
}

export interface AttemptResult {
  value: number; medal: number; medalBefore: number; prevBest: number | null; isBest: boolean;
  skillBefore: number; skillAfter: number; pilotSkill: number; weekDelta: number;
  history: number[]; award: AwardResult;
}

/** a finished run: saved, rewarded and summarised for the results screen */
export function recordAttempt(d: DrillDef, value: number): AttemptResult {
  const s = load();
  rollWeek(s);
  const rec = s.drills[d.id] ?? { best: null, attempts: [], medal: 0 };
  const prevBest = rec.best;
  const skillBefore = skillScore(d, prevBest);
  const isBest = prevBest == null || (d.lower ? value < prevBest : value > prevBest);
  const medal = medalFor(d, value);
  const medalBefore = rec.medal;
  if (isBest) rec.best = value;
  rec.medal = Math.max(rec.medal, medal);
  rec.attempts = [...rec.attempts, { v: value, t: Date.now() }].slice(-10);
  s.drills[d.id] = rec;
  save(s);
  const lines: XpLine[] = [];
  for (let m = medalBefore + 1; m <= medal; m++) lines.push({ label: `FIRST ${MEDALS[m - 1]}`, xp: MEDAL_XP[m - 1] });
  if (isBest) { const xp = capDaily('drill-best', 250, 25); if (xp > 0) lines.push({ label: 'PERSONAL BEST', xp }); }
  const award = awardXp(lines, 'drill');
  return {
    value, medal, medalBefore, prevBest, isBest,
    skillBefore, skillAfter: skillScore(d, rec.best), pilotSkill: pilotSkillOf(s), weekDelta: pilotSkillOf(s) - (s.week?.base ?? 0),
    history: rec.attempts.map(a => a.v), award,
  };
}
