/**
 * The building catalogue and the keep's tiers, as pure data.
 *
 * Shared by the simulation (costs, footprints, build times) and the interface
 * (names, blurbs). No three.js and no model names: how a building looks is the
 * renderer's business (src/render/buildingVisuals.ts), so a building can be
 * re-skinned without touching the rules.
 */

export type Resource = 'gold' | 'wood' | 'stone';
export type Cost = Partial<Record<Resource, number>>;
export const RESOURCES: readonly Resource[] = ['gold', 'wood', 'stone'];
/**
 * What a camp can bring in. Gold is never harvested — it comes off the
 * attackers, which is the loop the whole economy turns on.
 */
export type Harvest = Extract<Resource, 'wood' | 'stone'>;

/**
 * Which ground a building needs under its whole footprint. `dig` is any open,
 * dry ground on the plain or the river banks — a moat has to be able to reach
 * the river, which lies outside the castle ground.
 */
export type Zone = 'castle' | 'wood' | 'stone' | 'dig';

/** Groups in the build menu. */
export type Category = 'walls' | 'defences' | 'economy';

/** What leaves a defence when it shoots. Only the renderer cares which. */
export type Projectile = 'arrow' | 'bolt' | 'stone';

/**
 * What a building throws at attackers.
 *
 * The numbers are a first pass, to be balanced in P4 against the fifteen
 * waves. What matters here is that everything the combat loop reads is data:
 * src/sim/defense.ts holds the rule, this file holds the figures.
 */
export interface AttackDef {
  /** Reach from the footprint centre, in cells. */
  range: number;
  /** Hit points taken off per shaft. */
  damage: number;
  /** Seconds between volleys. */
  reload: number;
  /** Shafts loosed per volley: a taller tower holds more archers. */
  shots: number;
  projectile: Projectile;
}

/**
 * A camp and its crew.
 *
 * The crew *is* the yield: the brief asks for 2 / 3 / 5 workers and, in the
 * same breath, for +50 % and +150 % of output, which is exactly what going
 * from two workers to three and then to five gives. So there is no separate
 * multiplier to keep in step with the head count — a level adds bodies, and
 * the top level also puts an edge on their tools.
 */
export interface CampDef {
  /** What its workers bring home. */
  resource: Harvest;
  /** Crew size at level 1, 2 and 3. */
  crew: readonly number[];
  /** Units carried home per trip. */
  load: number;
  /** Seconds spent working a node, per level. */
  harvest: readonly number[];
  /** Cells walked per second. */
  speed: number;
  /** Seconds spent at the keep putting a load down. */
  unload: number;
}

export type BuildingId =
  | 'palisade'
  | 'stone-wall'
  | 'reinforced-wall'
  | 'gatehouse'
  | 'moat'
  | 'wooden-tower'
  | 'stone-tower'
  | 'spiked-barricade'
  | 'woodcutter-camp'
  | 'miner-camp';

/** A level above the first: what reaching it costs, and what it brings. */
export interface LevelDef {
  cost: Cost;
  buildTime: number;
  hp: number;
  /** Keep tier needed to start it. */
  tier: number;
  /** Replaces the building's own attack while it stands at this level. */
  attack?: AttackDef;
}

export interface BuildingDef {
  id: BuildingId;
  name: string;
  blurb: string;
  category: Category;
  /** Side of the square footprint, in cells. */
  size: number;
  zone: Zone;
  cost: Cost;
  /** Seconds from placement to standing. */
  buildTime: number;
  hp: number;
  /** Keep tier that unlocks it. */
  tier: number;
  /** Joins up with neighbouring walls, and stays selected so a line can be laid. */
  wall?: true;
  /**
   * Walls run up to it and bond with it. Shared by the rules — which read it to
   * work out which way a gatehouse opens — and by the renderer's auto-tiling.
   */
  joins?: true;
  /** Shoots at attackers in reach. Levels may replace it with a stronger one. */
  attack?: AttackDef;
  /** Levels 2 and up, in order. Without them a building has a single level. */
  levels?: readonly LevelDef[];
  /** What it can be rebuilt as where it stands, once at its top level. */
  upgradesTo?: BuildingId;
  /** Can carry machicolations. */
  machicolations?: true;
  /** Has a drawbridge and a portcullis for the player to work. */
  gate?: true;
  /** Dug rather than raised: it lowers the ground and needs no scaffold. */
  dug?: true;
  /** Sends workers out to a resource. */
  camp?: CampDef;
}

export const BUILDINGS: readonly BuildingDef[] = [
  // --- walls and gates -------------------------------------------------------
  {
    id: 'palisade',
    name: 'Palisade',
    blurb: 'Cheap timber wall. Rebuild it in stone once the Stone Hall stands.',
    category: 'walls',
    size: 1,
    zone: 'castle',
    cost: { wood: 10 },
    buildTime: 4,
    hp: 150,
    tier: 1,
    wall: true,
    joins: true,
    upgradesTo: 'stone-wall',
  },
  {
    id: 'stone-wall',
    name: 'Stone Wall',
    blurb: 'Solid masonry that can carry machicolations.',
    category: 'walls',
    size: 1,
    zone: 'castle',
    cost: { stone: 12 },
    buildTime: 8,
    hp: 600,
    tier: 2,
    wall: true,
    joins: true,
    upgradesTo: 'reinforced-wall',
    machicolations: true,
  },
  {
    id: 'reinforced-wall',
    name: 'Reinforced Wall',
    blurb: 'Taller, thicker stone. The strongest wall there is.',
    category: 'walls',
    size: 1,
    zone: 'castle',
    cost: { stone: 25, gold: 5 },
    buildTime: 12,
    hp: 1200,
    tier: 4,
    wall: true,
    joins: true,
    machicolations: true,
  },
  {
    id: 'gatehouse',
    name: 'Gatehouse',
    blurb: 'A gate in the wall, with a drawbridge and a portcullis you control.',
    category: 'walls',
    size: 1,
    zone: 'castle',
    cost: { stone: 40, wood: 20 },
    buildTime: 20,
    hp: 900,
    tier: 3,
    joins: true,
    gate: true,
  },
  {
    id: 'moat',
    name: 'Moat',
    blurb: 'Nothing crosses it. Dig it out to the river and it fills with water.',
    category: 'walls',
    size: 1,
    zone: 'dig',
    cost: { gold: 6 },
    buildTime: 6,
    hp: 1000,
    tier: 2,
    dug: true,
  },

  // --- defences --------------------------------------------------------------
  {
    id: 'wooden-tower',
    name: 'Wooden Tower',
    blurb: 'Archers shoot at anything in range. Grows taller as you upgrade it.',
    category: 'defences',
    size: 2,
    zone: 'castle',
    cost: { wood: 45 },
    buildTime: 15,
    hp: 300,
    tier: 1,
    joins: true,
    attack: { range: 6, damage: 10, reload: 1.4, shots: 1, projectile: 'arrow' },
    levels: [
      {
        cost: { wood: 60 },
        buildTime: 20,
        hp: 450,
        tier: 1,
        attack: { range: 6.5, damage: 12, reload: 1.2, shots: 1, projectile: 'arrow' },
      },
      {
        cost: { wood: 90, stone: 20 },
        buildTime: 30,
        hp: 650,
        tier: 2,
        attack: { range: 7, damage: 14, reload: 1.1, shots: 2, projectile: 'arrow' },
      },
    ],
  },
  {
    id: 'stone-tower',
    name: 'Stone Tower',
    blurb: 'Taller and sturdier, with a longer reach. Grows as you upgrade it.',
    category: 'defences',
    size: 2,
    zone: 'castle',
    cost: { stone: 60, wood: 15 },
    buildTime: 25,
    hp: 900,
    tier: 2,
    joins: true,
    attack: { range: 8, damage: 18, reload: 1.6, shots: 1, projectile: 'bolt' },
    levels: [
      {
        cost: { stone: 90 },
        buildTime: 35,
        hp: 1300,
        tier: 2,
        attack: { range: 8.5, damage: 22, reload: 1.5, shots: 2, projectile: 'bolt' },
      },
      {
        cost: { stone: 140, gold: 40 },
        buildTime: 50,
        hp: 1800,
        tier: 3,
        attack: { range: 9.5, damage: 26, reload: 1.4, shots: 3, projectile: 'bolt' },
      },
    ],
  },
  {
    id: 'spiked-barricade',
    name: 'Spiked Barricade',
    blurb: 'Slows and wounds attackers. Cavalry hate it.',
    category: 'defences',
    size: 1,
    zone: 'castle',
    cost: { wood: 15 },
    buildTime: 5,
    hp: 80,
    tier: 1,
  },

  // --- economy ---------------------------------------------------------------
  {
    id: 'woodcutter-camp',
    name: 'Woodcutter Camp',
    blurb: 'Fells trees for wood. Pitch it at the edge of the forest.',
    category: 'economy',
    size: 2,
    zone: 'wood',
    cost: { wood: 30 },
    buildTime: 12,
    hp: 200,
    tier: 1,
    levels: [
      { cost: { gold: 40 }, buildTime: 20, hp: 300, tier: 1 },
      { cost: { gold: 100 }, buildTime: 35, hp: 400, tier: 2 },
    ],
    camp: { resource: 'wood', crew: [2, 3, 5], load: 8, harvest: [5, 5, 3.2], speed: 2, unload: 0.6 },
  },
  {
    id: 'miner-camp',
    name: 'Miner Camp',
    blurb: 'Quarries stone. Pitch it at the foot of the mine.',
    category: 'economy',
    size: 2,
    zone: 'stone',
    cost: { wood: 40 },
    buildTime: 15,
    hp: 200,
    tier: 1,
    levels: [
      { cost: { gold: 50 }, buildTime: 20, hp: 300, tier: 1 },
      { cost: { gold: 120 }, buildTime: 35, hp: 400, tier: 2 },
    ],
    camp: { resource: 'stone', crew: [2, 3, 5], load: 6, harvest: [6, 6, 4], speed: 1.8, unload: 0.6 },
  },
];

export const BUILDING = Object.fromEntries(BUILDINGS.map((def) => [def.id, def])) as Readonly<
  Record<BuildingId, BuildingDef>
>;

/**
 * Built along the top of a stone wall, on the side facing away from the keep.
 * The overhang is there to drop things through: a wall that carries one hurts
 * whatever comes up against it, which is the reason to pay for the add-on.
 */
export const MACHICOLATIONS: Readonly<{
  name: string;
  cost: Cost;
  buildTime: number;
  tier: number;
  hp: number;
  attack: AttackDef;
}> = {
  name: 'Machicolations',
  cost: { stone: 15, wood: 5 },
  buildTime: 10,
  tier: 3,
  hp: 150,
  attack: { range: 1.6, damage: 9, reload: 1, shots: 1, projectile: 'stone' },
};

/**
 * What a building shoots with as it stands: its level's weapon if it has one,
 * its own otherwise, and failing both whatever an add-on lends it.
 */
export function attackOf(def: BuildingDef, level: number, machicolations = false): AttackDef | null {
  const own = (level > 1 ? def.levels?.[level - 2]?.attack : undefined) ?? def.attack;
  if (own) return own;
  return machicolations && def.machicolations ? MACHICOLATIONS.attack : null;
}

export interface KeepTier {
  tier: number;
  name: string;
  blurb: string;
  /** Cost and time to reach this tier from the one below it. */
  cost: Cost;
  buildTime: number;
  hp: number;
}

/**
 * The keep is the tech tree: each tier changes how it looks and unlocks
 * buildings. Index 0 is tier 1, the starting hall.
 */
export const KEEP_TIERS: readonly KeepTier[] = [
  { tier: 1, name: 'Wooden Hall', blurb: 'Timber and thatch. Where it all begins.', cost: {}, buildTime: 0, hp: 800 },
  {
    tier: 2,
    name: 'Stone Hall',
    blurb: 'Unlocks stone walls, stone towers and moats.',
    cost: { wood: 80, stone: 60 },
    buildTime: 30,
    hp: 1400,
  },
  {
    tier: 3,
    name: 'Tiled Keep',
    blurb: 'Unlocks gatehouses and machicolations.',
    cost: { stone: 150, gold: 100 },
    buildTime: 45,
    hp: 2200,
  },
  {
    tier: 4,
    name: 'Great Keep',
    blurb: 'Unlocks reinforced walls.',
    cost: { stone: 250, wood: 120, gold: 200 },
    buildTime: 60,
    hp: 3200,
  },
];

/** Side of the keep's square footprint, centred on MapData.keep. */
export const KEEP_SIZE = 3;

export const STARTING_RESOURCES: Readonly<Record<Resource, number>> = { gold: 50, wood: 250, stone: 100 };
