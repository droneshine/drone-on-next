// Side effect module: art registers its drone model builders (Royale tiers) into
// modelRegistry from src/render/droneModels.ts here. Imported once by main.ts.
import { modelRegistry } from '../render/droneModels';
import { TIER_BUILDERS } from './tiers';

modelRegistry.spark = TIER_BUILDERS.spark;
modelRegistry.bolt = TIER_BUILDERS.bolt;
modelRegistry.storm = TIER_BUILDERS.storm;
modelRegistry.nova = TIER_BUILDERS.nova;

// dev only art review: #artgallery (see studio/ART.md). Never part of a production build.
if (import.meta.env.DEV && /artgallery/.test(location.hash)) {
  import('./gallery').then(m => m.installGallery()).catch(e => console.error(e));
}
