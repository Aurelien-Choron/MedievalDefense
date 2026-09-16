import { RESOURCES, type AttackDef, type CampDef, type Cost, type Resource } from '../data/buildings.js';

/** "45s", "2m 05s" — short enough for a bar over a building. */
export function formatDuration(seconds: number): string {
  const s = Math.max(0, Math.ceil(seconds));
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
}

/**
 * Cost chips, one per resource the cost uses. With the player's stock given,
 * the ones they cannot cover are flagged so CSS can turn them red.
 */
export function costHtml(cost: Cost, stock?: Readonly<Record<Resource, number>>): string {
  const chips = RESOURCES.filter((r) => (cost[r] ?? 0) > 0).map((r) => {
    const amount = cost[r] ?? 0;
    const short = stock !== undefined && stock[r] < amount;
    return `<span class="chip ${r}${short ? ' short' : ''}"><i></i>${amount}</span>`;
  });
  return chips.length ? chips.join('') : '<span class="chip free">Free</span>';
}

/** What the trade is called, rather than what it carries. */
const TRADE: Readonly<Record<string, string>> = { wood: 'woodcutter', stone: 'miner' };

/** "3 woodcutters carrying 8 wood a trip" — a camp's crew in one line. */
export function crewText(camp: CampDef, level: number): string {
  const crew = camp.crew[Math.min(level, camp.crew.length) - 1] ?? 0;
  const trade = TRADE[camp.resource] ?? camp.resource;
  return `${crew} ${trade}${crew === 1 ? '' : 's'} carrying ${camp.load} ${camp.resource} a trip`;
}

/** "14 damage every 1.1s, reaching 7 cells" — a weapon in one line. */
export function attackText(attack: AttackDef): string {
  const volley = attack.shots > 1 ? `${attack.shots} x ${attack.damage}` : `${attack.damage}`;
  return `${volley} damage every ${attack.reload}s, reaching ${attack.range} cells`;
}
