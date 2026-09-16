/**
 * The rules of building: what may stand where, what it costs, how long it
 * takes to go up, and how it can be upgraded, cancelled or pulled down.
 *
 * Pure: no three.js, no DOM, no clock. Time only moves when tick() is called at
 * the fixed step, which keeps it deterministic in the browser and testable in
 * node. Everything that matters lives in `state`, which is plain JSON — a save
 * is JSON.stringify(game.state) and Game.load() rebuilds the rest.
 */
import { Build, Kind, canBuild, contains, heightAt, isWater, kindAt, type MapData } from '../core/map.ts';
import {
  BUILDING,
  KEEP_SIZE,
  KEEP_TIERS,
  MACHICOLATIONS,
  RESOURCES,
  STARTING_RESOURCES,
  attackOf,
  type AttackDef,
  type BuildingId,
  type Cost,
  type Resource,
  type Zone,
} from '../data/buildings.ts';
import { Forest, type Felled } from './forest.ts';

export type BuildingKind = BuildingId | 'keep';

/** What an upgrade turns a building into. */
export interface UpgradeTarget {
  kind: BuildingKind;
  level: number;
  machicolations: boolean;
}

/** Work in progress on a building: raising it, or upgrading it in place. */
export interface Job {
  type: 'construct' | 'upgrade';
  /** Seconds of work in all, and done so far. */
  duration: number;
  elapsed: number;
  /** What was paid for this work. All of it comes back if it is cancelled. */
  paid: Cost;
  /** For an upgrade: what the building becomes when it is done. */
  into?: UpgradeTarget;
}

/** How the player has left a gatehouse's mechanisms. */
export interface GateState {
  bridgeDown: boolean;
  portcullisOpen: boolean;
}

export interface Building {
  id: number;
  kind: BuildingKind;
  /** Lowest-x, lowest-z cell of the footprint. */
  x: number;
  z: number;
  size: number;
  /** Keep tier for the keep; the building's level for everything else. */
  level: number;
  /**
   * Quarter turns the player has added to the way the building naturally
   * faces, 0 to 3. A delta rather than an absolute angle so that a gatehouse
   * keeps following the wall line it sits in even after being turned by hand.
   */
  turn: number;
  hp: number;
  job: Job | null;
  /** Walls that can carry them: machicolations along the top. */
  machicolations?: boolean;
  /** Gatehouses only. */
  gate?: GateState;
}

export interface GameState {
  version: 1;
  /** Simulated seconds. */
  time: number;
  resources: Record<Resource, number>;
  buildings: Building[];
  nextId: number;
  /** Trees a woodcutter has taken down, counting back up to regrowth. */
  felled: Felled[];
}

export type GameEvent =
  | { type: 'placed'; building: Building }
  | { type: 'completed'; building: Building }
  | { type: 'upgrade-started'; building: Building }
  | { type: 'upgraded'; building: Building }
  | { type: 'upgrade-cancelled'; building: Building }
  | { type: 'removed'; building: Building }
  | { type: 'gate'; building: Building }
  | { type: 'rotated'; building: Building }
  /** The wood changed: cells that went down, cells that came back. */
  | { type: 'forest'; felled: readonly number[]; grown: readonly number[] };

/** Why a building cannot go somewhere, most fundamental first. */
export type PlaceProblem = 'bounds' | 'occupied' | 'zone' | 'locked' | 'cost';
const RANK: Readonly<Record<PlaceProblem, number>> = { bounds: 0, occupied: 1, zone: 2, locked: 3, cost: 4 };

export interface FootprintCell {
  x: number;
  z: number;
  /** Whether the ground itself allows it: on the map, free, and the right zone. */
  ok: boolean;
}

export interface PlaceCheck {
  ok: boolean;
  problem: PlaceProblem | null;
  cells: FootprintCell[];
}

/**
 * The ways a standing building can be improved: the keep's next tier, a
 * building's next level, rebuilding a wall in a stronger material, or adding
 * machicolations to one.
 */
export type UpgradeType = 'tier' | 'level' | 'rebuild' | 'machicolations';
export type UpgradeProblem = 'locked' | 'busy' | 'cost';

export interface UpgradeOption {
  type: UpgradeType;
  into: UpgradeTarget;
  cost: Cost;
  buildTime: number;
  /** Keep tier needed to start it. */
  tier: number;
  problem: UpgradeProblem | null;
}

/** Share of its hit points a building has the moment work on it begins. */
const FOUNDATION_HP = 0.1;
/** Share of the building cost handed back when something is pulled down. */
const DEMOLISH_REFUND = 0.5;
/** Float slack when comparing accumulated fixed steps against a duration. */
const EPSILON = 1e-9;

const SIDES: readonly (readonly [number, number])[] = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
];

/**
 * Which way a building points, in degrees about the vertical: 0 faces +x, 90
 * faces -z, 180 faces -x, 270 faces +z. The same convention the renderer turns
 * its models by, so a facing can be handed straight to a placement.
 */
export const QUARTER = 90;

/** Walls run up to these and bond with them; everything else stands apart. */
export function joinsWalls(kind: BuildingKind): boolean {
  return kind === 'keep' || BUILDING[kind].joins === true;
}

/** Any whole number of turns, brought back into 0..3. */
const quarters = (turn: number): number => (((Math.round(turn) % 4) + 4) % 4);

/** Cell coordinates of a footprint's centre. A 2x2 sits on a corner: x + 0.5. */
export function centreOf(building: Building): [number, number] {
  const offset = (building.size - 1) / 2;
  return [building.x + offset, building.z + offset];
}

/** Whether the ground at a cell suits a zone. */
export function inZone(map: MapData, zone: Zone, x: number, z: number): boolean {
  if (!contains(map, x, z)) return false;
  switch (zone) {
    case 'castle':
      return canBuild(map, x, z, Build.CASTLE);
    case 'wood':
      return canBuild(map, x, z, Build.WOOD_CAMP);
    case 'stone':
      return canBuild(map, x, z, Build.STONE_CAMP);
    case 'dig': {
      const kind = kindAt(map, x, z);
      const h = heightAt(map, x, z);
      return (
        (kind === Kind.GRASS || kind === Kind.DIRT || kind === Kind.ROAD) &&
        h >= map.heights.riverBed &&
        h <= map.heights.ground &&
        !map.bridgeCells.includes(z * map.size + x)
      );
    }
  }
}

export function newGameState(map: MapData): GameState {
  const half = (KEEP_SIZE - 1) / 2;
  return {
    version: 1,
    time: 0,
    resources: { ...STARTING_RESOURCES },
    buildings: [
      {
        id: 1,
        kind: 'keep',
        x: map.keep.x - half,
        z: map.keep.z - half,
        size: KEEP_SIZE,
        level: 1,
        turn: 0,
        hp: KEEP_TIERS[0]!.hp,
        job: null,
      },
    ],
    nextId: 2,
    felled: [],
  };
}

/** 0 when work has just begun, 1 when standing. */
export function progressOf(building: Building): number {
  const job = building.job;
  if (!job) return 1;
  return job.duration > 0 ? Math.min(job.elapsed / job.duration, 1) : 1;
}

/** Seconds of work left on a building. */
export function remainingOf(building: Building): number {
  return building.job ? Math.max(building.job.duration - building.job.elapsed, 0) : 0;
}

export class Game {
  readonly map: MapData;
  readonly state: GameState;
  /** The trees, and which of them are standing. */
  readonly forest: Forest;
  /**
   * Bumped whenever what stands on the ground changes — a building placed or
   * pulled down, a job finished, a gate worked. Anything holding a walking
   * grid or a route rebuilds when this moves (src/sim/pathing.ts).
   */
  revision = 0;

  /** Building id per cell, 0 where free. Derived from state, never saved. */
  private readonly occupancy: Int32Array;
  private readonly byId = new Map<number, Building>();
  /** Finished moat cells joined to the river, and so full of water. */
  private readonly wet = new Set<number>();
  private events: GameEvent[] = [];

  constructor(map: MapData, state: GameState = newGameState(map)) {
    this.map = map;
    this.state = state;
    // A save written before the wood was simulated simply has no stumps.
    state.felled ??= [];
    this.forest = new Forest(map.trees ?? [], state.felled);
    this.occupancy = new Int32Array(map.size * map.size);
    for (const building of state.buildings) this.occupy(building);
    this.refreshMoats();
  }

  static load(map: MapData, json: string): Game {
    return new Game(map, JSON.parse(json) as GameState);
  }

  get keep(): Building {
    const keep = this.state.buildings.find((b) => b.kind === 'keep');
    if (!keep) throw new Error('the game has no keep');
    return keep;
  }

  /** The keep's tier: what the player has unlocked. */
  get tier(): number {
    return this.keep.level;
  }

  /** Cell indices of finished moat holding water. */
  get wetMoats(): ReadonlySet<number> {
    return this.wet;
  }

  building(id: number): Building | undefined {
    return this.byId.get(id);
  }

  buildingAt(x: number, z: number): Building | undefined {
    if (!contains(this.map, x, z)) return undefined;
    return this.byId.get(this.occupancy[z * this.map.size + x]!);
  }

  /** A finished moat at a cell, and whether it holds water. Null if there is none. */
  moatAt(x: number, z: number): 'wet' | 'dry' | null {
    const b = this.buildingAt(x, z);
    if (b?.kind !== 'moat' || b.job) return null;
    return this.wet.has(z * this.map.size + x) ? 'wet' : 'dry';
  }

  /** Whether the cell that far off holds something this building's walls bond with. */
  joinsAt(building: Building, dx: number, dz: number): boolean {
    const other = this.buildingAt(building.x + dx, building.z + dz);
    return !!other && other !== building && joinsWalls(other.kind);
  }

  /**
   * The same question for a cell nothing stands on yet: what a wall put at
   * (x, z) would bond with. The placement ghost asks this so it can show the
   * shape the wall will really take rather than the one in the catalogue.
   */
  joinsFrom(x: number, z: number, dx: number, dz: number): boolean {
    const other = this.buildingAt(x + dx, z + dz);
    return !!other && joinsWalls(other.kind);
  }

  /**
   * Which way a building points before the player has turned it: a gatehouse
   * opens across the wall line it sits in, away from the keep — with no line to
   * go by, straight away from the keep. Everything else simply faces +x.
   */
  private naturalFacing(building: Building): number {
    if (building.kind !== 'gatehouse') return 0;
    const [cx, cz] = centreOf(building);
    const fromKeepX = cx - this.map.keep.x;
    const fromKeepZ = cz - this.map.keep.z;
    const eastWest = this.joinsAt(building, 1, 0) || this.joinsAt(building, -1, 0);
    const northSouth = this.joinsAt(building, 0, 1) || this.joinsAt(building, 0, -1);
    // A gate across an east-west run of wall lets people through along z, and
    // the other way round. With walls on all sides, or none, the keep decides.
    const passageAlongX = eastWest === northSouth ? Math.abs(fromKeepX) > Math.abs(fromKeepZ) : northSouth;
    return passageAlongX ? (fromKeepX < 0 ? 180 : 0) : fromKeepZ < 0 ? 90 : 270;
  }

  /** Which way a building points, in degrees, the player's quarter turns included. */
  facingOf(building: Building): number {
    return (this.naturalFacing(building) + building.turn * QUARTER) % 360;
  }

  /**
   * Whether turning it would show. Only a moat has nothing to turn: it is a
   * hole in the ground.
   *
   * Walls used to be excluded too while they were joined to a neighbour, on
   * the grounds that the auto-tiling should decide their line. In the hand
   * that read as the game cancelling the player's rotation — the ghost showed
   * one thing and the wall came out another — so the player now wins: a
   * segment left at turn 0 still takes its line from its neighbours, and one
   * they have turned keeps the line they gave it.
   */
  rotatable(building: Building): boolean {
    return building.kind !== 'moat';
  }

  /** Turns a building a quarter at a time. Free, and allowed while it is still going up. */
  rotate(building: Building, delta = 1): boolean {
    if (this.byId.get(building.id) !== building) return false;
    building.turn = quarters(building.turn + delta);
    this.events.push({ type: 'rotated', building });
    return true;
  }

  /** What a building shoots with as it stands, or null if it has no weapon. */
  attackOf(building: Building): AttackDef | null {
    if (building.kind === 'keep') return null;
    return attackOf(BUILDING[building.kind], building.level, building.machicolations === true);
  }

  maxHp(building: Building): number {
    if (building.kind === 'keep') return KEEP_TIERS[building.level - 1]?.hp ?? 1;
    const def = BUILDING[building.kind];
    const base = building.level > 1 ? (def.levels?.[building.level - 2]?.hp ?? def.hp) : def.hp;
    return base + (building.machicolations ? MACHICOLATIONS.hp : 0);
  }

  canAfford(cost: Cost): boolean {
    return RESOURCES.every((r) => this.state.resources[r] >= (cost[r] ?? 0));
  }

  /** Whether a building fits with its lowest corner at (x, z), cell by cell. */
  check(id: BuildingId, x: number, z: number): PlaceCheck {
    const def = BUILDING[id];
    const cells: FootprintCell[] = [];
    let problem: PlaceProblem | null = null;

    for (let dz = 0; dz < def.size; dz++)
      for (let dx = 0; dx < def.size; dx++) {
        const cx = x + dx;
        const cz = z + dz;
        const here: PlaceProblem | null = !contains(this.map, cx, cz)
          ? 'bounds'
          : this.occupancy[cz * this.map.size + cx] !== 0
            ? 'occupied'
            : !inZone(this.map, def.zone, cx, cz)
              ? 'zone'
              : null;
        cells.push({ x: cx, z: cz, ok: here === null });
        if (here !== null && (problem === null || RANK[here] < RANK[problem])) problem = here;
      }

    if (problem === null && def.tier > this.tier) problem = 'locked';
    if (problem === null && !this.canAfford(def.cost)) problem = 'cost';
    return { ok: problem === null, problem, cells };
  }

  /** Pays for a building and lays its foundation. Null, and no change, if it cannot go there. */
  place(id: BuildingId, x: number, z: number, turn = 0): Building | null {
    if (!this.check(id, x, z).ok) return null;
    const def = BUILDING[id];
    this.spend(def.cost);

    const building: Building = {
      id: this.state.nextId++,
      kind: id,
      x,
      z,
      size: def.size,
      level: 1,
      turn: quarters(turn),
      hp: Math.max(1, Math.round(def.hp * FOUNDATION_HP)),
      job: { type: 'construct', duration: def.buildTime, elapsed: 0, paid: { ...def.cost } },
    };
    if (def.gate) building.gate = { bridgeDown: true, portcullisOpen: true };
    this.state.buildings.push(building);
    this.occupy(building);
    this.events.push({ type: 'placed', building });
    return building;
  }

  /** Every upgrade a building offers, with what stands in the way of each. */
  upgradesFor(building: Building): UpgradeOption[] {
    const options: UpgradeOption[] = [];
    const offer = (type: UpgradeType, into: UpgradeTarget, cost: Cost, buildTime: number, tier: number): void => {
      const problem: UpgradeProblem | null = building.job
        ? 'busy'
        : tier > this.tier
          ? 'locked'
          : !this.canAfford(cost)
            ? 'cost'
            : null;
      options.push({ type, into, cost, buildTime, tier, problem });
    };

    if (building.kind === 'keep') {
      // Tiers are numbered from 1, so the keep's level indexes the next one.
      const next = KEEP_TIERS[building.level];
      if (next) offer('tier', { kind: 'keep', level: next.tier, machicolations: false }, next.cost, next.buildTime, 1);
      return options;
    }

    const def = BUILDING[building.kind];
    const machicolations = building.machicolations === true;
    const nextLevel = def.levels?.[building.level - 1];
    if (nextLevel)
      offer(
        'level',
        { kind: def.id, level: building.level + 1, machicolations },
        nextLevel.cost,
        nextLevel.buildTime,
        nextLevel.tier,
      );
    else if (def.upgradesTo) {
      const target = BUILDING[def.upgradesTo];
      offer(
        'rebuild',
        { kind: target.id, level: 1, machicolations: machicolations && target.machicolations === true },
        target.cost,
        target.buildTime,
        target.tier,
      );
    }
    if (def.machicolations && !machicolations)
      offer(
        'machicolations',
        { kind: def.id, level: building.level, machicolations: true },
        MACHICOLATIONS.cost,
        MACHICOLATIONS.buildTime,
        MACHICOLATIONS.tier,
      );
    return options;
  }

  /** Pays for and starts an upgrade. The building stands as it was until the work is done. */
  upgrade(building: Building, type: UpgradeType): boolean {
    const option = this.upgradesFor(building).find((o) => o.type === type);
    if (!option || option.problem) return false;
    this.spend(option.cost);
    building.job = {
      type: 'upgrade',
      duration: option.buildTime,
      elapsed: 0,
      paid: { ...option.cost },
      into: option.into,
    };
    this.events.push({ type: 'upgrade-started', building });
    return true;
  }

  /** The keep's next tier. */
  upgradeKeep(): boolean {
    return this.upgrade(this.keep, 'tier');
  }

  /**
   * Stops the work on a building and hands back everything it cost. A
   * foundation is cleared away; an upgrade leaves the building as it was.
   */
  cancel(building: Building): boolean {
    const job = building.job;
    if (!job || this.byId.get(building.id) !== building) return false;
    this.refund(job.paid, 1);
    if (job.type === 'construct') {
      this.remove(building);
      this.events.push({ type: 'removed', building });
    } else {
      building.job = null;
      this.events.push({ type: 'upgrade-cancelled', building });
    }
    return true;
  }

  /** Pulls down a standing building for half its cost back. Never the keep; cancel work first. */
  demolish(building: Building): boolean {
    if (building.kind === 'keep' || building.job || this.byId.get(building.id) !== building) return false;
    this.refund(BUILDING[building.kind].cost, DEMOLISH_REFUND);
    this.remove(building);
    this.events.push({ type: 'removed', building });
    return true;
  }

  /** Works a gatehouse: lowers or raises the drawbridge, opens or closes the portcullis. */
  setGate(building: Building, part: 'bridge' | 'portcullis', open: boolean): boolean {
    if (!building.gate || building.job?.type === 'construct') return false;
    if (part === 'bridge') building.gate.bridgeDown = open;
    else building.gate.portcullisOpen = open;
    // A gate is the one building whose cell opens and closes: what walks over
    // the map has to be told.
    this.revision++;
    this.events.push({ type: 'gate', building });
    return true;
  }

  /** Every segment of the same wall joined to this one, itself included. */
  lineOf(building: Building): Building[] {
    const line = [building];
    const seen = new Set([building.id]);
    for (let i = 0; i < line.length; i++) {
      const b = line[i]!;
      for (const [dx, dz] of SIDES) {
        const next = this.buildingAt(b.x + dx, b.z + dz);
        if (!next || next.kind !== building.kind || seen.has(next.id)) continue;
        seen.add(next.id);
        line.push(next);
      }
    }
    return line;
  }

  /** Advances all work by one fixed step. */
  tick(dt: number): void {
    this.state.time += dt;
    let moats = false;
    for (const building of this.state.buildings) {
      const job = building.job;
      if (!job) continue;
      job.elapsed = Math.min(job.elapsed + dt, job.duration);

      // A rising building is as sturdy as it is finished.
      if (job.type === 'construct')
        building.hp = Math.max(
          1,
          Math.round(this.maxHp(building) * (FOUNDATION_HP + (1 - FOUNDATION_HP) * progressOf(building))),
        );
      if (job.elapsed < job.duration - EPSILON) continue;

      building.job = null;
      // What stands has changed: a finished gatehouse lets people through, a
      // finished moat stops them.
      this.revision++;
      if (job.type === 'upgrade' && job.into) {
        building.kind = job.into.kind;
        building.level = job.into.level;
        if (job.into.machicolations) building.machicolations = true;
        else delete building.machicolations;
      }
      building.hp = this.maxHp(building);
      if (building.kind === 'moat') moats = true;
      this.events.push({ type: job.type === 'construct' ? 'completed' : 'upgraded', building });
    }
    if (moats) this.refreshMoats();

    const grown = this.forest.tick(dt);
    if (grown.length) this.events.push({ type: 'forest', felled: [], grown });
  }

  /** Cuts a tree down. False if that cell had none standing. */
  fell(cell: number): boolean {
    if (!this.forest.fell(cell)) return false;
    this.events.push({ type: 'forest', felled: [cell], grown: [] });
    return true;
  }

  /** Everything that happened since the last call, oldest first. */
  drainEvents(): GameEvent[] {
    const events = this.events;
    this.events = [];
    return events;
  }

  /** Adds resources — the economy's entry point until camps produce, and a debug handle. */
  grant(amounts: Cost): void {
    for (const r of RESOURCES) this.state.resources[r] += amounts[r] ?? 0;
  }

  private spend(cost: Cost): void {
    for (const r of RESOURCES) this.state.resources[r] -= cost[r] ?? 0;
  }

  private refund(cost: Cost, share: number): void {
    for (const r of RESOURCES) this.state.resources[r] += Math.floor((cost[r] ?? 0) * share);
  }

  private occupy(building: Building): void {
    this.revision++;
    this.byId.set(building.id, building);
    for (let dz = 0; dz < building.size; dz++)
      for (let dx = 0; dx < building.size; dx++)
        this.occupancy[(building.z + dz) * this.map.size + building.x + dx] = building.id;
  }

  private remove(building: Building): void {
    this.revision++;
    const index = this.state.buildings.indexOf(building);
    if (index >= 0) this.state.buildings.splice(index, 1);
    this.byId.delete(building.id);
    for (let dz = 0; dz < building.size; dz++)
      for (let dx = 0; dx < building.size; dx++)
        this.occupancy[(building.z + dz) * this.map.size + building.x + dx] = 0;
    if (building.kind === 'moat') this.refreshMoats();
  }

  /**
   * Floods finished moat from the river: a moat cell beside river or lake
   * water fills, and so does every finished moat cell joined to a full one.
   */
  private refreshMoats(): void {
    const { map } = this;
    this.wet.clear();
    const queue: number[] = [];
    const finishedMoat = (x: number, z: number): boolean => {
      const b = this.buildingAt(x, z);
      return b?.kind === 'moat' && !b.job;
    };

    for (const b of this.state.buildings) {
      if (b.kind !== 'moat' || b.job) continue;
      const besideWater = SIDES.some(
        ([dx, dz]) => contains(map, b.x + dx, b.z + dz) && isWater(kindAt(map, b.x + dx, b.z + dz)),
      );
      const i = b.z * map.size + b.x;
      if (besideWater && !this.wet.has(i)) {
        this.wet.add(i);
        queue.push(i);
      }
    }
    while (queue.length) {
      const i = queue.pop()!;
      const x = i % map.size;
      const z = (i / map.size) | 0;
      for (const [dx, dz] of SIDES) {
        const j = (z + dz) * map.size + x + dx;
        if (!contains(map, x + dx, z + dz) || this.wet.has(j) || !finishedMoat(x + dx, z + dz)) continue;
        this.wet.add(j);
        queue.push(j);
      }
    }
  }
}
