import type { DroneSpec } from '../sim/spec';
import type { TierId } from './contracts';
import { tierAsset } from './tiers';

// GDD 6.1 tier specs as art knows them: the gallery flies them and the asset cache is warmed with
// them. Gameplay owns the real table in src/royale; when it differs (paint, camera uptilt), call
// warmTierAssets(itsSpecs) once at match load so no evolve ever builds geometry mid fight.

/** GDD 6.1 tier spec */
export function tierSpec(t: TierId): DroneSpec {
  const base = {
    author: 'DroneShine', tagline: '', defaultMode: 'gps' as const, rates: { rcRate: 0.9, superRate: 0.55, expo: 0.3 },
  };
  switch (t) {
    case 'spark': return { ...base, id: 'spark', name: 'SPARK', model: 'spark', layout: 'quadX', armLength: 0.16, propDiameter: 0.18, mass: 1.1, maxThrust: 8, motorTau: 0.03, dragArea: 0.03, battery: { cells: 4, capacityAh: 1.8 }, maxTilt: 28, maxSpeed: 12, maxClimb: 5, maxYawRate: 180, camUptilt: 20, tool: 'camera', color: '#26c257', accent: '#f7f7f2' };
    case 'bolt': return { ...base, id: 'bolt', name: 'BOLT', model: 'bolt', layout: 'quadX', armLength: 0.24, propDiameter: 0.254, mass: 1.9, maxThrust: 13.5, motorTau: 0.04, dragArea: 0.045, battery: { cells: 6, capacityAh: 2 }, maxTilt: 30, maxSpeed: 14, maxClimb: 6, maxYawRate: 160, camUptilt: 15, tool: 'lance', flow: 9, color: '#8fc2f5', accent: '#002518' };
    case 'storm': return { ...base, id: 'storm', name: 'STORM', model: 'storm', layout: 'hexX', armLength: 0.34, propDiameter: 0.3, mass: 3, maxThrust: 15, motorTau: 0.045, dragArea: 0.07, battery: { cells: 6, capacityAh: 3.5 }, maxTilt: 32, maxSpeed: 16, maxClimb: 7, maxYawRate: 140, camUptilt: 10, tool: 'lance', flow: 9, color: '#004225', accent: '#b5f78a' };
    default: return { ...base, id: 'nova', name: 'NOVA', model: 'nova', layout: 'coaxX8', armLength: 0.4, propDiameter: 0.33, mass: 4.6, maxThrust: 17, motorTau: 0.05, dragArea: 0.1, battery: { cells: 8, capacityAh: 4 }, maxTilt: 34, maxSpeed: 18, maxClimb: 8, maxYawRate: 120, camUptilt: 5, tool: 'lance', flow: 9, color: '#f7f7f2', accent: '#26c257' };
  }
}

/** build the shared tier geometry up front (about 50 ms per tier, once per page) */
export function warmTierAssets(specs: DroneSpec[] = (['spark', 'bolt', 'storm', 'nova'] as TierId[]).map(tierSpec)) {
  for (const s of specs) if (s.model === 'spark' || s.model === 'bolt' || s.model === 'storm' || s.model === 'nova') tierAsset(s.model, s);
}
