import { FEATURED, motorCount, validateSpec, type DroneSpec, type Layout } from '../sim/spec';
import { derive } from '../ui/ui';
import { getLS, setLS } from '../game/store';
import { paintColors } from '../meta/cosmetics';

// Workshop parts and formulas (GDD 3.4, 6.15). A build is five parts plus name, paint and tune;
// compute() turns it into a DroneSpec through validateSpec, so anything saved here flies everywhere.

export interface Frame { id: string; name: string; layout: Layout; arm: number; mass: number; drag: number; maxProp: number; maxTilt: number; gps: number; uptilt: number; unlock?: string; }
export interface Motor { id: string; name: string; thrust: number; mass: number; maxProp: number; unlock?: string; }
export type ToolId = 'camera' | 'thermal' | 'spray' | 'lance' | 'none';
export type TuneId = 'smooth' | 'sport' | 'freestyle';

export const FRAMES: Frame[] = [
  { id: 'micro3', name: 'MICRO 3', layout: 'quadX', arm: 0.07, mass: 0.05, drag: 0.006, maxProp: 0.076, maxTilt: 45, gps: 14, uptilt: 20 },
  { id: 'freestyle5', name: 'FREESTYLE 5', layout: 'quadX', arm: 0.115, mass: 0.12, drag: 0.010, maxProp: 0.127, maxTilt: 55, gps: 24, uptilt: 30 },
  { id: 'longrange7', name: 'LONG RANGE 7', layout: 'quadX', arm: 0.16, mass: 0.17, drag: 0.016, maxProp: 0.178, maxTilt: 45, gps: 22, uptilt: 25, unlock: 'frame-longrange7' },
  { id: 'survey10', name: 'SURVEY 10', layout: 'quadX', arm: 0.33, mass: 0.9, drag: 0.05, maxProp: 0.33, maxTilt: 30, gps: 16, uptilt: -15 },
  { id: 'hex18', name: 'HEX 18', layout: 'hexX', arm: 0.55, mass: 3.0, drag: 0.18, maxProp: 0.46, maxTilt: 28, gps: 15, uptilt: 0, unlock: 'frame-hex18' },
  { id: 'cinex8', name: 'CINE X8', layout: 'coaxX8', arm: 0.5, mass: 3.6, drag: 0.16, maxProp: 0.46, maxTilt: 28, gps: 18, uptilt: 0, unlock: 'frame-cinex8' },
  { id: 'octo32', name: 'OCTO 32', layout: 'octoX', arm: 1.0, mass: 10, drag: 0.45, maxProp: 0.81, maxTilt: 22, gps: 12, uptilt: -20, unlock: 'frame-octo32' },
];
export const MOTORS: Motor[] = [
  { id: 'm4', name: 'M4', thrust: 4.5, mass: 0.012, maxProp: 0.09 },
  { id: 'm15', name: 'M15', thrust: 15, mass: 0.033, maxProp: 0.18 },
  { id: 'm25', name: 'M25', thrust: 25, mass: 0.06, maxProp: 0.28, unlock: 'motor-m25' },
  { id: 'm60', name: 'M60', thrust: 60, mass: 0.2, maxProp: 0.5, unlock: 'motor-m60' },
  { id: 'm150', name: 'M150', thrust: 150, mass: 0.6, maxProp: 0.8, unlock: 'motor-m150' },
  { id: 'm400', name: 'M400', thrust: 400, mass: 1.8, maxProp: 1.4, unlock: 'motor-m400' },
];
export const PROPS: { d: number; name: string }[] = [
  { d: 0.076, name: '3 IN' }, { d: 0.127, name: '5 IN' }, { d: 0.178, name: '7 IN' }, { d: 0.254, name: '10 IN' },
  { d: 0.33, name: '13 IN' }, { d: 0.46, name: '18 IN' }, { d: 0.61, name: '24 IN' }, { d: 0.81, name: '32 IN' },
];
export const TOOLS: { id: ToolId; name: string; mass: number; unlock?: string; note: string }[] = [
  { id: 'camera', name: 'CAMERA', mass: 0.03, note: 'FPV and chase' },
  { id: 'thermal', name: 'THERMAL', mass: 0.25, unlock: 'tool-thermal', note: 'Hotspot view, key H' },
  { id: 'spray', name: 'SPRAY BOOM', mass: 0.8, unlock: 'tool-spray', note: 'Tank 2 to 30 L, cleans panels' },
  { id: 'lance', name: 'LANCE', mass: 1.2, unlock: 'tool-lance', note: 'Facade jet, hose optional' },
  { id: 'none', name: 'NONE', mass: 0, note: 'Lightest' },
];
export const TUNES: { id: TuneId; name: string; rates: { rcRate: number; superRate: number; expo: number } }[] = [
  { id: 'smooth', name: 'SMOOTH', rates: { rcRate: 0.7, superRate: 0.4, expo: 0.2 } },
  { id: 'sport', name: 'SPORT', rates: { rcRate: 0.9, superRate: 0.55, expo: 0.3 } },
  { id: 'freestyle', name: 'FREESTYLE', rates: { rcRate: 1.0, superRate: 0.7, expo: 0.3 } },
];
/** capacity steps for the pack slider */
export const CAPACITIES = [0.3, 0.45, 0.65, 0.85, 1, 1.3, 1.5, 1.8, 2.2, 2.6, 3, 4, 5, 6, 8, 10, 12, 16, 22, 30];

/** pack limits by level: 6 S and 3 Ah at the start, 12 S and 10 Ah at level 12, 14 S and 30 Ah at level 22 */
export function packLimits(level: number) {
  return level >= 22 ? { cells: 14, ah: 30 } : level >= 12 ? { cells: 12, ah: 10 } : { cells: 6, ah: 3 };
}

export interface Build {
  id: string; name: string; paint: string;
  frame: string; motor: string; prop: number; cells: number; ah: number;
  tool: ToolId; tank: number; hose: boolean; tune: TuneId;
}

export const newBuild = (): Build => ({
  id: 'ws-' + Math.random().toString(36).slice(2, 8), name: 'My drone', paint: 'paint-field',
  frame: 'freestyle5', motor: 'm15', prop: 0.127, cells: 4, ah: 1.5, tool: 'camera', tank: 10, hose: false, tune: 'sport',
});

export const frameOf = (id: string) => FRAMES.find(f => f.id === id) ?? FRAMES[1];
export const motorOf = (id: string) => MOTORS.find(m => m.id === id) ?? MOTORS[1];

export const MSG = {
  heavy: 'TOO HEAVY TO LIFT OFF. STRONGER MOTORS OR A LIGHTER PACK.',
  frameProp: 'THESE PROPS ARE TOO BIG FOR THIS FRAME.',
  motorProp: 'THESE MOTORS CANNOT SPIN PROPS THAT SIZE.',
};

export interface Computed {
  spec: DroneSpec;
  /** empty mass and with a full tank */
  mass: number; takeoff: number;
  tw: number; hoverMin: number; gps: number; acro: number;
  fliesLike: string;
  problems: string[];
  canSave: boolean;
}

export function compute(b: Build): Computed {
  const f = frameOf(b.frame), mo = motorOf(b.motor);
  const n = motorCount(f.layout);
  const D = b.prop;
  const tool = TOOLS.find(t => t.id === b.tool) ?? TOOLS[0];
  const propMass = 0.004 + 0.6 * D ** 3;
  const packMass = 0.0239 * b.cells * b.ah;
  const elecMass = 0.03 + 0.015 * n;
  const mass = f.mass + n * (mo.mass + propMass) + packMass + elecMass + tool.mass;
  const tank = b.tool === 'spray' ? Math.min(30, Math.max(2, b.tank)) : 0;
  const thrust = Math.min(mo.thrust, 900 * D * D);
  const gps = f.gps;
  const tune = TUNES.find(t => t.id === b.tune) ?? TUNES[1];
  const paint = paintColors(b.paint);
  const raw: Partial<DroneSpec> = {
    id: b.id, name: b.name.trim() || 'My drone', author: 'Workshop',
    tagline: `${f.name}, ${mo.name} motors, ${PROPS.find(p => p.d === D)?.name.toLowerCase() ?? ''} props, ${b.cells} S ${b.ah} Ah, ${tune.name.toLowerCase()} tune.`,
    color: paint.color, accent: paint.accent, layout: f.layout,
    armLength: f.arm, propDiameter: D, mass, maxThrust: thrust, motorTau: 0.015 + 0.08 * D,
    dragArea: f.drag + (b.tool === 'spray' || b.tool === 'lance' ? 0.02 : 0),
    battery: { cells: b.cells, capacityAh: b.ah },
    defaultMode: b.tune === 'freestyle' ? 'acro' : f.arm < 0.2 ? 'angle' : 'gps',
    maxTilt: f.maxTilt, maxSpeed: gps, maxClimb: 4 + 0.15 * gps,
    maxYawRate: f.arm < 0.2 ? 400 : f.arm < 0.4 ? 150 : 90,
    rates: { ...tune.rates }, camUptilt: f.uptilt,
    tool: b.tool === 'spray' ? 'sprayDown' : b.tool,
    tank: b.tool === 'spray' ? tank : undefined,
    flow: b.tool === 'spray' ? Math.round((1 + tank * 0.13) * 10) / 10 : b.tool === 'lance' ? 8 : undefined,
    hose: b.tool === 'lance' && b.hose,
  };
  const spec = validateSpec(raw);
  // the numbers shown are the honest ones from the parts, before the hover safety floor in validateSpec
  const shown = derive({ ...spec, maxThrust: thrust });
  const takeoff = mass + tank;
  const lift = n * thrust, weight = takeoff * 9.81;
  const acro = lift > weight ? Math.sqrt(2 * Math.sqrt(lift * lift - weight * weight) / (1.225 * spec.dragArea)) : 0;
  const problems: string[] = [];
  if (D > f.maxProp + 1e-9) problems.push(MSG.frameProp);
  if (D > mo.maxProp + 1e-9) problems.push(MSG.motorProp);
  if (shown.tw < 1.5) problems.push(MSG.heavy);
  return { spec, mass, takeoff, tw: shown.tw, hoverMin: shown.hoverMin, gps, acro, fliesLike: fliesLike(takeoff, shown.tw), problems, canSave: problems.length === 0 };
}

/** closest featured drone by take off mass and thrust to weight, compared on a log scale */
export function fliesLike(mass: number, tw: number): string {
  let best = FEATURED[0], bd = Infinity;
  for (const f of FEATURED) {
    const d = derive(f);
    const dist = Math.log(d.weight / mass) ** 2 + Math.log(d.tw / Math.max(0.1, tw)) ** 2;
    if (dist < bd) { bd = dist; best = f; }
  }
  return best.name.toUpperCase();
}

// ------------------------------------------------------------------ builds on this device
const KEY = 'workshop';
export function builds(): Record<string, Build> {
  const raw = getLS<Record<string, Build>>(KEY, {});
  const out: Record<string, Build> = {};
  for (const [id, b] of Object.entries(raw)) if (b && typeof b === 'object' && typeof b.frame === 'string') out[id] = sanitize({ ...b, id });
  return out;
}
export function saveBuild(b: Build) { const all = builds(); all[b.id] = b; setLS(KEY, all); }
export function dropBuild(id: string) { const all = builds(); delete all[id]; setLS(KEY, all); }

function sanitize(b: Build): Build {
  const n = (v: unknown, d: number, lo: number, hi: number) => (typeof v === 'number' && isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d);
  return {
    id: String(b.id), name: typeof b.name === 'string' ? b.name.slice(0, 32) : 'My drone', paint: typeof b.paint === 'string' ? b.paint : 'paint-field',
    frame: frameOf(b.frame).id, motor: motorOf(b.motor).id, prop: PROPS.find(p => p.d === b.prop)?.d ?? 0.127,
    cells: Math.round(n(b.cells, 4, 1, 14)), ah: n(b.ah, 1.5, 0.3, 30),
    tool: TOOLS.some(t => t.id === b.tool) ? b.tool : 'camera', tank: n(b.tank, 10, 2, 30), hose: !!b.hose,
    tune: TUNES.some(t => t.id === b.tune) ? b.tune : 'sport',
  };
}

const PHYS: (keyof DroneSpec)[] = ['layout', 'armLength', 'propDiameter', 'mass', 'maxThrust', 'motorTau', 'dragArea', 'defaultMode', 'maxTilt', 'maxSpeed', 'maxClimb', 'maxYawRate', 'camUptilt', 'tool', 'tank', 'flow', 'hose'];
const same = (a: unknown, b: unknown) => typeof a === 'number' && typeof b === 'number' ? Math.abs(a - b) <= 1e-6 * Math.max(1, Math.abs(a)) : a === b;
/** a Workshop drone whose numbers were changed in EXPERT NUMBERS no longer matches its parts */
export function isExpertTuned(saved: DroneSpec, b: Build): boolean {
  const c = compute(b).spec;
  if (PHYS.some(k => !same(saved[k], c[k]))) return true;
  if (!same(saved.battery.cells, c.battery.cells) || !same(saved.battery.capacityAh, c.battery.capacityAh)) return true;
  return !same(saved.rates.rcRate, c.rates.rcRate) || !same(saved.rates.superRate, c.rates.superRate) || !same(saved.rates.expo, c.rates.expo);
}
