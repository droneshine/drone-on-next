// The unlock track (GDD 3.3) and the cosmetic catalogue. Data only, so progression, the
// Workshop, the Pilot panel and later Royale all read the same table.
// Cosmetics never change stats; parts only open up what the Workshop can build.

export type UnlockKind = 'paint' | 'led' | 'trail' | 'title' | 'flourish' | 'frame' | 'motor' | 'tool' | 'battery';
export type CosmeticKind = 'paint' | 'led' | 'trail' | 'title' | 'flourish';

export interface Unlock {
  id: string;
  kind: UnlockKind;
  /** short name in capitals, e.g. "EVERGREEN" */
  name: string;
  /** level it opens at; 1 means owned from the start */
  level: number;
  /** paint: body and accent; led and trail: one or two colours */
  colors?: string[];
}

const U = (id: string, kind: UnlockKind, name: string, level: number, colors?: string[]): Unlock => ({ id, kind, name, level, colors });

export const UNLOCKS: Unlock[] = [
  // owned from the start
  U('paint-field', 'paint', 'FIELD GREEN', 1, ['#26c257', '#f7f7f2']),
  U('paint-graphite', 'paint', 'GRAPHITE', 1, ['#2a2f2c', '#b5f78a']),
  U('led-nav', 'led', 'NAV LIGHTS', 1, ['#3cff7a', '#ff3030']),
  U('title-new', 'title', 'NEW PILOT', 1),
  // 2 to 10, exactly as GDD 3.3
  U('paint-evergreen', 'paint', 'EVERGREEN', 2, ['#002518', '#b5f78a']),
  U('frame-longrange7', 'frame', 'LONG RANGE 7', 3),
  U('title-ringrunner', 'title', 'RING RUNNER', 4),
  U('led-blue', 'led', 'BLUE LEDS', 5, ['#8fc2f5']),
  U('tool-thermal', 'tool', 'THERMAL CAMERA', 5),
  U('motor-m25', 'motor', 'M25', 6),
  U('trail-shine', 'trail', 'SHINE TRAIL', 7, ['#b5f78a']),
  U('frame-hex18', 'frame', 'HEX 18', 8),
  U('title-static', 'title', 'STATIC SURVIVOR', 9),
  U('paint-offwhite', 'paint', 'OFF WHITE PRO', 10, ['#f7f7f2', '#004225']),
  U('flourish-roll', 'flourish', 'BARREL ROLL', 10),
  // 11 to 50: paint, part, LED or trail, title, every fifth a paint set or frame; part levels from GDD 6.15
  U('paint-accent', 'paint', 'ACCENT GREEN', 11, ['#26c257', '#002518']),
  U('motor-m60', 'motor', 'M60', 12),
  U('battery-12', 'battery', 'PACKS TO 12 S AND 10 AH', 12),
  U('led-lightgreen', 'led', 'LIGHT GREEN LEDS', 13, ['#b5f78a']),
  U('frame-cinex8', 'frame', 'CINE X8', 14),
  U('title-ace', 'title', 'ACE', 15),
  U('paint-sky', 'paint', 'SKY BLUE', 15, ['#8fc2f5', '#002518']),
  U('tool-spray', 'tool', 'SPRAY BOOM', 16),
  U('trail-blue', 'trail', 'BLUE TRAIL', 17, ['#8fc2f5']),
  U('motor-m150', 'motor', 'M150', 18),
  U('paint-carbon', 'paint', 'CARBON', 19, ['#1c1e1d', '#26c257']),
  U('title-signal', 'title', 'SIGNAL MASTER', 20),
  U('tool-lance', 'tool', 'LANCE', 20),
  U('led-white', 'led', 'OFF WHITE LEDS', 21, ['#f7f7f2']),
  U('frame-octo32', 'frame', 'OCTO 32', 22),
  U('battery-14', 'battery', 'PACKS TO 14 S AND 30 AH', 22),
  U('paint-golden', 'paint', 'GOLDEN HOUR', 23, ['#e1b12c', '#002518']),
  U('title-hover', 'title', 'HOVER HERO', 24),
  U('motor-m400', 'motor', 'M400', 25),
  U('paint-lightgreen', 'paint', 'LIGHT GREEN', 25, ['#b5f78a', '#002518']),
  U('trail-white', 'trail', 'OFF WHITE TRAIL', 26, ['#f7f7f2']),
  U('paint-signal', 'paint', 'SIGNAL ORANGE', 27, ['#ff6a1a', '#f7f7f2']),
  U('title-wind', 'title', 'WIND READER', 28),
  U('led-accent', 'led', 'ACCENT GREEN LEDS', 29, ['#26c257']),
  U('title-nova', 'title', 'NOVA PILOT', 30),
  U('flourish-spin', 'flourish', 'VICTORY SPIN', 30),
  U('paint-glacier', 'paint', 'GLACIER', 31, ['#e6eef5', '#8fc2f5']),
  U('flourish-flip', 'flourish', 'FLIP', 32),
  U('trail-accent', 'trail', 'ACCENT TRAIL', 33, ['#26c257']),
  U('title-line', 'title', 'LINE CHASER', 34),
  U('paint-forest', 'paint', 'FOREST', 35, ['#004225', '#f7f7f2']),
  U('led-amber', 'led', 'AMBER LEDS', 36, ['#ffb259']),
  U('paint-dusk', 'paint', 'DUSK', 37, ['#6f6370', '#ffb259']),
  U('title-pad', 'title', 'PAD PRO', 38),
  U('trail-amber', 'trail', 'AMBER TRAIL', 39, ['#ffb259']),
  U('title-legend', 'title', 'FIELD LEGEND', 40),
  U('paint-midnight', 'paint', 'MIDNIGHT', 40, ['#0a1116', '#8fc2f5']),
  U('led-orange', 'led', 'SIGNAL ORANGE LEDS', 41, ['#ff6a1a']),
  U('paint-nova', 'paint', 'NOVA WHITE', 42, ['#f7f7f2', '#26c257']),
  U('trail-nova', 'trail', 'NOVA TRAIL', 43, ['#f7f7f2', '#26c257']),
  U('title-turbine', 'title', 'TURBINE TAMER', 44),
  U('paint-sunrise', 'paint', 'SUNRISE', 45, ['#ffcf96', '#004225']),
  U('flourish-salute', 'flourish', 'DIP SALUTE', 46),
  U('led-dual', 'led', 'TWO TONE LEDS', 47, ['#b5f78a', '#8fc2f5']),
  U('title-cloud', 'title', 'CLOUD CUTTER', 48),
  U('paint-ice', 'paint', 'ICE', 49, ['#f7f7f2', '#8fc2f5']),
  U('title-crew', 'title', 'DRONESHINE CREW', 50),
  U('paint-crew', 'paint', 'DRONESHINE CREW', 50, ['#002518', '#26c257']),
];

const BY_ID = new Map(UNLOCKS.map(u => [u.id, u]));
export const unlockById = (id: string) => BY_ID.get(id);
export const unlocksAt = (level: number) => UNLOCKS.filter(u => u.level === level);
export const unlocksUpTo = (level: number) => UNLOCKS.filter(u => u.level <= level);

/** what a results screen prints after "UNLOCKED:" */
export function unlockLabel(u: Unlock): string {
  switch (u.kind) {
    case 'paint': return `PAINT ${u.name}`;
    case 'title': return `TITLE ${u.name}`;
    case 'frame': return `FRAME ${u.name}`;
    case 'motor': return `MOTOR ${u.name}`;
    case 'flourish': return `FLOURISH ${u.name}`;
    default: return u.name;
  }
}

export const isCosmetic = (k: UnlockKind): k is CosmeticKind => k === 'paint' || k === 'led' || k === 'trail' || k === 'title' || k === 'flourish';
