import { UNLOCKS, unlockById, type CosmeticKind, type Unlock } from './unlocks';
import { pilotOwned, pilotEquipped, setEquipped, pilotLevel } from './progression';

// Cosmetics API for the Workshop, the Pilot panel and Royale (GDD 3.3, 3.4 bridge 1).
// Royale reads equippedCosmetics().paint / .led / .trail for the pilot's tier drones.

export interface Cosmetic { id: string; kind: CosmeticKind; name: string; level: number; colors: string[]; owned: boolean; }

const view = (u: Unlock, owned: Set<string>): Cosmetic => ({ id: u.id, kind: u.kind as CosmeticKind, name: u.name, level: u.level, colors: u.colors ?? [], owned: owned.has(u.id) });

/** every cosmetic of a kind, owned or not, in unlock order */
export function cosmetics(kind: CosmeticKind): Cosmetic[] {
  const owned = pilotOwned();
  return UNLOCKS.filter(u => u.kind === kind).map(u => view(u, owned));
}
export function ownedCosmetics(kind: CosmeticKind): Cosmetic[] { return cosmetics(kind).filter(c => c.owned); }
export function isOwned(id: string) { return pilotOwned().has(id); }

export interface EquippedCosmetics { paint: Cosmetic; led: Cosmetic; trail: Cosmetic | null; title: Cosmetic; flourish: Cosmetic | null; }
export function equippedCosmetics(): EquippedCosmetics {
  const e = pilotEquipped(), owned = pilotOwned();
  const get = (id: string | null, fallback: string | null) => { const u = unlockById(id ?? '') ?? (fallback ? unlockById(fallback) : undefined); return u ? view(u, owned) : null; };
  return { paint: get(e.paint, 'paint-field')!, led: get(e.led, 'led-nav')!, trail: get(e.trail, null), title: get(e.title, 'title-new')!, flourish: get(e.flourish, null) };
}
export function equip(kind: CosmeticKind, id: string | null) { return setEquipped(kind, id); }

/** the title shown under the pilot name */
export function pilotTitle(): string { return equippedCosmetics().title.name; }

/** paint id to body and accent colour */
export function paintColors(id: string): { color: string; accent: string } {
  const c = unlockById(id)?.colors ?? ['#26c257', '#f7f7f2'];
  return { color: c[0], accent: c[1] ?? c[0] };
}

/** parts gated by level (Workshop) */
export function partOpen(id: string): boolean { const u = unlockById(id); return !u || u.level <= pilotLevel().level; }
export function partLevel(id: string): number { return unlockById(id)?.level ?? 1; }
