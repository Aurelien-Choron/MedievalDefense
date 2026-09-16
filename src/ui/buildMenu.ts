import { BUILDINGS, KEEP_TIERS, type BuildingId } from '../data/buildings.js';
import type { Game } from '../sim/game.js';
import { attackText, costHtml, formatDuration } from './format.js';

/**
 * The mini build menu: one card per building along the bottom of the screen,
 * grouped as walls, defences and economy, each with its icon, hotkey and cost.
 * Hovering shows what it does. Cards the player cannot use say why — greyed
 * out with the keep tier that unlocks them, or with the resource they are
 * short of in red.
 */

/** Hotkey label for the card at an index: 1..9, then 0. */
export const hotkeyFor = (index: number): string | null => (index < 9 ? String(index + 1) : index === 9 ? '0' : null);

export class BuildMenu {
  private readonly game: Game;
  private readonly cards = new Map<BuildingId, HTMLButtonElement>();
  private signature = '';

  constructor(root: HTMLElement, game: Game, icons: ReadonlyMap<string, string>, onPick: (id: BuildingId) => void) {
    this.game = game;
    root.innerHTML = '';
    let category: string | null = null;
    BUILDINGS.forEach((def, i) => {
      if (category !== null && def.category !== category) {
        const separator = document.createElement('span');
        separator.className = 'sep';
        root.append(separator);
      }
      category = def.category;

      const card = document.createElement('button');
      card.className = 'card';
      card.type = 'button';
      const icon = icons.get(def.id);
      const key = hotkeyFor(i);
      card.innerHTML =
        (key ? `<kbd>${key}</kbd>` : '') +
        (icon ? `<img alt="" src="${icon}">` : '<span class="noicon"></span>') +
        `<span class="name">${def.name}</span>` +
        `<span class="cost"></span><span class="lock"></span>` +
        `<div class="tip"><b>${def.name}</b><p>${def.blurb}</p>` +
        `<div class="stats"><span class="tipcost"></span>` +
        `<span>${formatDuration(def.buildTime)} to build</span><span>${def.hp} HP</span>` +
        (def.attack ? `<span class="arms">${attackText(def.attack)}</span>` : '') +
        `</div></div>`;
      card.addEventListener('click', () => onPick(def.id));
      root.append(card);
      this.cards.set(def.id, card);
    });
    root.hidden = false;
    this.refresh();
  }

  setActive(id: BuildingId | null): void {
    for (const [key, card] of this.cards) card.classList.toggle('active', key === id);
  }

  /** Cheap to call every frame: only touches the DOM when resources or the tier change. */
  refresh(): void {
    const { resources } = this.game.state;
    const signature = `${this.game.tier}|${resources.gold}|${resources.wood}|${resources.stone}`;
    if (signature === this.signature) return;
    this.signature = signature;

    for (const def of BUILDINGS) {
      const card = this.cards.get(def.id);
      if (!card) continue;
      const locked = def.tier > this.game.tier;
      card.classList.toggle('locked', locked);
      card.classList.toggle('short', !locked && !this.game.canAfford(def.cost));
      const chips = costHtml(def.cost, resources);
      card.querySelector('.cost')!.innerHTML = chips;
      card.querySelector('.tipcost')!.innerHTML = chips;
      card.querySelector('.lock')!.textContent = locked ? `Needs ${KEEP_TIERS[def.tier - 1]?.name ?? 'a better keep'}` : '';
    }
  }
}
