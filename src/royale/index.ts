import type { Game } from '../game/game';
import type { UI } from '../ui/ui';

// Royale entry point. Called once at boot after the UI exists. The Royale programmer owns src/royale.
export function installRoyale(_game: Game, _ui: UI) { /* Royale registers its sheet, state and HUD here */ }
