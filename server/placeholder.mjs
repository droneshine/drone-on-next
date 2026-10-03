// Stand ins for src/royale/tuning.ts until it lands. The Royale programmer owns
// that module (GDD section 6, the only place numbers live); the protocol holds no
// game numbers. Once tuning.ts exists, the server imports it directly (it is
// import free TypeScript, Node strips the types) and this file goes away.
// Used by server/index.mjs (the Signal plan in 'start') and server/selftest.mjs.

import { mulberry32 } from '../src/net/royaleProtocol.ts';

/** RoyaleLimits from GDD 6.2, 6.3, 6.5 (vmax: GDD 2.4 acro top speeds plus margin for BOOST and dives, QA to measure) */
export const GDD_LIMITS = {
  tiers: [
    { pulseIntervalMs: 1000 / 4, pulseSpeed: 110, pulseRange: 60, hitRadius: 0.67, vmax: 45, jet: false, special: null },    // SPARK
    { pulseIntervalMs: 1000 / 5, pulseSpeed: 120, pulseRange: 70, hitRadius: 0.78, vmax: 47, jet: true, special: null },     // BOLT
    { pulseIntervalMs: 1000 / 6, pulseSpeed: 130, pulseRange: 80, hitRadius: 0.90, vmax: 49, jet: true, special: 'emp' },    // STORM
    { pulseIntervalMs: 1000 / 7, pulseSpeed: 140, pulseRange: 90, hitRadius: 0.97, vmax: 51, jet: true, special: 'nova' },   // NOVA
  ],
  pulseMinSoc: 0.03,
  jet: { range: 22, coneDeg: 5, tickMs: 100 },
  bursts: { emp: { radius: 15, cooldownMs: 16000, minSoc: 0.05 }, nova: { radius: 20, cooldownMs: 14000, minSoc: 0.05 } },
  ringPass: 0.95,
  cacheRadius: 2.5,
};

/**
 * The Signal plan of GDD 6.7 as a ZoneSchedule: C0 (-60, -60), R0 420, five
 * phases plus overtime, ceiling moves over 10 s. Centres are seeded and stay
 * inside the previous circle; the game's own plan adds the POI bias and the
 * "final two centres over land" rule, which need the terrain.
 */
export function placeholderSignal(seed) {
  const rnd = mulberry32(seed ^ 0x5a17);
  // shrink start s, shrink end s, radius after, Static per s, ceiling y
  const plan = [[60, 100, 260, 2, 120], [140, 175, 150, 4, 100], [210, 240, 80, 7, 80], [270, 295, 35, 11, 60], [315, 345, 0, 16, 45]];
  const phases = [];
  let cx = -60, cz = -60, cr = 420;
  for (const [s0, s1, nr, dps, ceil] of plan) {
    const ang = rnd() * Math.PI * 2, off = rnd() * Math.max(0, cr - nr);
    cx = Math.round((cx + Math.cos(ang) * off) * 10) / 10;
    cz = Math.round((cz + Math.sin(ang) * off) * 10) / 10;
    cr = nr;
    phases.push({ at: s0 * 1000, dur: (s1 - s0) * 1000, x: cx, z: cz, r: nr, dps, ceil });
  }
  phases.push({ at: 345000, dur: 0, x: cx, z: cz, r: 0, dps: 25, ceil: 45 });   // overtime
  return { x: -60, z: -60, r: 420, ceil: 120, ceilMs: 10000, phases };
}
