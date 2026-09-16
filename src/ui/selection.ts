import { BUILDING, KEEP_TIERS, MACHICOLATIONS, RESOURCES, type BuildingId } from '../data/buildings.js';
import { remainingOf, type Building, type Game, type UpgradeOption, type UpgradeType } from '../sim/game.js';
import { attackText, costHtml, crewText, formatDuration } from './format.js';
import { toast } from './toast.js';

/**
 * The panel for a clicked building: what it is, how far along its work is,
 * its hit points, and everything the player can do with it — upgrade it (or a
 * whole line of wall at once), work a gatehouse, cancel the work in progress,
 * or pull it down.
 *
 * Every action goes straight to the Game; the panel only decides what to offer.
 */

/** A demolish click has to be repeated within this long to go through. */
const CONFIRM_MS = 2500;

function describe(option: UpgradeOption): { caption: string; title: string; blurb: string } {
  switch (option.type) {
    case 'tier': {
      const tier = KEEP_TIERS[option.into.level - 1];
      return { caption: 'Next tier', title: tier?.name ?? 'Next tier', blurb: tier?.blurb ?? '' };
    }
    case 'level': {
      const def = BUILDING[option.into.kind as BuildingId];
      const hp = def.levels?.[option.into.level - 2]?.hp ?? def.hp;
      // On a camp the level is the crew, so say so: the hit points are the
      // least of what the player is buying.
      const blurb = def.camp
        ? `${crewText(def.camp, option.into.level)}. ${hp} HP.`
        : `Grows to ${hp} HP.`;
      return { caption: 'Next level', title: `Level ${option.into.level}`, blurb };
    }
    case 'rebuild': {
      const def = BUILDING[option.into.kind as BuildingId];
      return { caption: 'Rebuild in place', title: def.name, blurb: def.blurb };
    }
    case 'machicolations':
      return {
        caption: 'Add-on',
        title: MACHICOLATIONS.name,
        blurb: `A parapet overhanging the outer face. +${MACHICOLATIONS.hp} HP.`,
      };
  }
}

export class SelectionPanel {
  private readonly root: HTMLElement;
  private readonly game: Game;
  private readonly icons: ReadonlyMap<string, string>;
  private building: Building | null = null;
  private signature = '';
  private demolishArmedAt = -Infinity;

  constructor(root: HTMLElement, game: Game, icons: ReadonlyMap<string, string>) {
    this.root = root;
    this.game = game;
    this.icons = icons;
    root.addEventListener('click', (e) => {
      const button = (e.target as HTMLElement).closest<HTMLElement>('[data-action]');
      if (button) this.act(button.dataset.action ?? '', button.dataset.type as UpgradeType | undefined);
    });
  }

  get selected(): Building | null {
    return this.building;
  }

  select(building: Building | null): void {
    this.building = building;
    this.signature = '';
    this.demolishArmedAt = -Infinity;
    this.refresh();
  }

  /** Cheap to call every frame: rebuilds the panel only when something it shows changed. */
  refresh(): void {
    const b = this.building;
    if (!b || this.game.building(b.id) !== b) {
      this.building = null;
      this.root.hidden = true;
      return;
    }
    this.root.hidden = false;

    const wall = b.kind !== 'keep' && BUILDING[b.kind].wall === true;
    const signature = [
      b.id,
      b.kind,
      b.level,
      b.job?.type ?? '',
      b.machicolations ?? '',
      b.turn,
      this.game.rotatable(b),
      b.gate?.bridgeDown ?? '',
      b.gate?.portcullisOpen ?? '',
      this.game.tier,
      // What the stock changes about this panel, rather than the stock itself.
      // Since P3 the camps pay in every few seconds, and keying on the raw
      // numbers rebuilt the whole panel each time a load came home — which
      // dropped the "click again to demolish" prompt, and pulled the buttons
      // out from under the mouse.
      this.affordability(b),
      wall ? this.game.lineOf(b).filter((s) => !s.job).length : 0,
      b.kind === 'moat' ? this.game.moatAt(b.x, b.z) : '',
    ].join('|');
    if (signature !== this.signature) {
      this.signature = signature;
      this.render(b);
    }

    const status = this.root.querySelector<HTMLElement>('.status');
    if (status) status.textContent = this.status(b);
    const hp = this.root.querySelector<HTMLElement>('.hp i');
    if (hp) hp.style.width = `${Math.round((100 * b.hp) / this.game.maxHp(b))}%`;
  }

  /**
   * Everything the player's stock decides here: whether each upgrade can be
   * started, and which of its cost chips shows as short. It only moves when
   * one of those actually flips.
   */
  private affordability(b: Building): string {
    const { resources } = this.game.state;
    return this.game
      .upgradesFor(b)
      .map(
        (option) =>
          `${option.type}${option.problem ?? ''}` +
          RESOURCES.map((r) => {
            const amount = option.cost[r] ?? 0;
            return amount > 0 ? (resources[r] < amount ? '!' : '.') : '';
          }).join(''),
      )
      .join(',');
  }

  private act(action: string, type: UpgradeType | undefined): void {
    const b = this.building;
    if (action === 'close' || !b) {
      this.select(null);
      return;
    }
    switch (action) {
      case 'upgrade':
        if (type && !this.game.upgrade(b, type)) toast('That cannot be started right now.');
        break;
      case 'upgrade-line':
        if (type) this.upgradeLine(b, type);
        break;
      case 'cancel':
        this.game.cancel(b);
        break;
      case 'rotate':
        this.game.rotate(b);
        break;
      case 'bridge':
        this.game.setGate(b, 'bridge', !b.gate?.bridgeDown);
        break;
      case 'portcullis':
        this.game.setGate(b, 'portcullis', !b.gate?.portcullisOpen);
        break;
      case 'demolish': {
        if (performance.now() - this.demolishArmedAt > CONFIRM_MS) {
          this.demolishArmedAt = performance.now();
          const button = this.root.querySelector<HTMLElement>('[data-action="demolish"]');
          if (button) button.textContent = 'Click again to demolish';
          return;
        }
        this.game.demolish(b);
        break;
      }
    }
    this.signature = '';
    this.refresh();
  }

  /** Starts the same upgrade on every idle segment of the wall, as far as resources go. */
  private upgradeLine(b: Building, type: UpgradeType): void {
    const segments = this.game.lineOf(b).filter((s) => !s.job && this.game.upgradesFor(s).some((o) => o.type === type));
    let started = 0;
    for (const segment of segments) if (this.game.upgrade(segment, type)) started++;
    if (started === 0) toast('Not enough resources.');
    else if (started < segments.length) toast(`Resources ran out: ${started} of ${segments.length} segments started.`);
  }

  private status(b: Building): string {
    const left = formatDuration(remainingOf(b));
    if (b.job?.type === 'construct') return `Under construction · ${left} left`;
    if (b.job?.type === 'upgrade') return `Upgrading · ${left} left`;
    if (b.kind === 'moat')
      return this.game.moatAt(b.x, b.z) === 'wet' ? 'Full of water' : 'Dry — join it to the river to flood it';
    return `${b.hp} / ${this.game.maxHp(b)} HP`;
  }

  private optionHtml(b: Building, option: UpgradeOption): string {
    const { caption, title, blurb } = describe(option);
    const why =
      option.problem === 'locked'
        ? `Needs the ${KEEP_TIERS[option.tier - 1]?.name ?? 'next keep tier'}`
        : option.problem === 'cost'
          ? 'Not enough resources'
          : option.problem === 'busy'
            ? 'Work under way'
            : '';
    const verb = option.type === 'rebuild' ? 'Rebuild' : option.type === 'machicolations' ? 'Build' : 'Upgrade';

    let line = '';
    const wall = b.kind !== 'keep' && BUILDING[b.kind].wall === true;
    if (wall && option.type !== 'level' && option.problem !== 'locked' && option.problem !== 'busy') {
      const segments = this.game
        .lineOf(b)
        .filter((s) => !s.job && this.game.upgradesFor(s).some((o) => o.type === option.type));
      if (segments.length > 1)
        line = `<button type="button" class="upgrade line" data-action="upgrade-line" data-type="${option.type}">Whole line ×${segments.length}</button>`;
    }

    return (
      `<div class="option">` +
      `<div class="row"><span class="label">${caption}</span><span class="time">${formatDuration(option.buildTime)}</span></div>` +
      `<div class="row"><b>${title}</b><span>${costHtml(option.cost, option.problem === 'busy' ? undefined : this.game.state.resources)}</span></div>` +
      `<p>${blurb}</p>` +
      `<div class="actions"><button type="button" class="upgrade" data-action="upgrade" data-type="${option.type}"${option.problem ? ' disabled' : ''}>${why || verb}</button>${line}</div>` +
      `</div>`
    );
  }

  private render(b: Building): void {
    const def = b.kind === 'keep' ? null : BUILDING[b.kind];
    const name = def ? def.name : (KEEP_TIERS[b.level - 1]?.name ?? 'Keep');
    let sub = def
      ? def.levels
        ? `Level ${b.level} of ${def.levels.length + 1}`
        : def.blurb
      : `Your keep · tier ${b.level} of ${KEEP_TIERS.length}`;
    if (b.machicolations) sub += ' · with machicolations';
    const icon = this.icons.get(def ? b.kind : `keep-${b.level}`);

    let body = '';
    const attack = this.game.attackOf(b);
    if (attack) body += `<div class="arms">${attackText(attack)}</div>`;
    // A camp being raised has nobody in it yet — the crew turns up with the
    // camp, which is exactly what src/sim/workers.ts does.
    if (def?.camp && b.job?.type !== 'construct')
      body += `<div class="arms">${crewText(def.camp, b.level)}</div>`;
    if (b.job)
      body += `<div class="actions"><button type="button" class="secondary" data-action="cancel">Cancel · refund ${costHtml(b.job.paid)}</button></div>`;
    if (b.gate && b.job?.type !== 'construct')
      body +=
        `<div class="actions">` +
        `<button type="button" class="secondary" data-action="bridge">${b.gate.bridgeDown ? 'Raise drawbridge' : 'Lower drawbridge'}</button>` +
        `<button type="button" class="secondary" data-action="portcullis">${b.gate.portcullisOpen ? 'Close portcullis' : 'Open portcullis'}</button>` +
        `</div>`;
    // Only where a turn would show: a joined wall takes its line from its
    // neighbours, and a moat has nothing standing up to turn.
    if (this.game.rotatable(b))
      body += `<div class="actions"><button type="button" class="secondary" data-action="rotate">Turn a quarter &middot; <b>R</b></button></div>`;
    for (const option of this.game.upgradesFor(b)) body += this.optionHtml(b, option);
    if (def && !b.job)
      body += `<div class="actions"><button type="button" class="danger" data-action="demolish">Demolish · refund half</button></div>`;

    this.root.innerHTML =
      `<header>${icon ? `<img alt="" src="${icon}">` : ''}` +
      `<div><h2>${name}</h2><div class="sub">${sub}</div></div>` +
      `<button type="button" class="close" data-action="close" aria-label="Close">&times;</button></header>` +
      `<div class="status"></div><div class="hp"><i></i></div>${body}`;
  }
}
