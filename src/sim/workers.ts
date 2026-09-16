/**
 * The workers: the only thing that turns a camp into an income.
 *
 * Pure, like the rest of src/sim — it walks on the grid of src/sim/pathing.ts
 * and pays through Game.grant, which stays the single door every resource comes
 * in by. The renderer reads positions off `all` and draws them; nothing here
 * knows a model exists.
 *
 * The round is the one the brief asks for: idle, out to a node, work it, carry
 * the load to the keep, put it down. Two things make it behave:
 *
 * - **A node is claimed.** Without that every woodcutter walks to the same
 *   nearest tree, bunches up, and only one of them ever swings an axe. A claim
 *   is dropped the moment the worker gives up on it, so nothing leaks.
 * - **The way out is a route, the way home is a field.** Going out, a worker
 *   wants one particular tree, so it floods the grid from where it stands —
 *   which answers "which node is nearest" and "how do I get there" in the same
 *   pass. Coming home, a whole crew wants the same place, so they read their
 *   next step out of one field per camp, rebuilt only when the ground changes.
 *   Nothing is stored per worker, so a wall raised across the way costs no
 *   re-path at all: the field changes and they all follow the new one. That is
 *   the machinery P4's attackers want, rooted on the keep instead of a camp.
 *
 * Positions are continuous cell coordinates: the centre of cell (x, z) is
 * exactly (x, z), the frame src/sim/defense.ts already aims in.
 */
import { contains, kindAt, Kind, type MapData } from '../core/map.ts';
import { NEIGHBOURS } from '../core/grid.ts';
import { BUILDING, type CampDef, type Harvest } from '../data/buildings.ts';
import { centreOf, type Building, type Game } from './game.ts';
import { makeField, NO_FLOW, UNREACHABLE, WalkGrid, type Field } from './pathing.ts';

export type Phase = 'idle' | 'toNode' | 'harvest' | 'toCamp' | 'unload';

export interface Worker {
  id: number;
  /** The camp it belongs to. It dies with it. */
  campId: number;
  resource: Harvest;
  /** Continuous cell coordinates. */
  x: number;
  z: number;
  phase: Phase;
  /** The cell it is working, or -1 for none. */
  node: number;
  /** Cells still to walk, the next one first. */
  path: number[];
  /** Seconds left on the timer the current phase runs on. */
  timer: number;
  carrying: number;
  /** Degrees about the vertical, 0 towards +x — the renderer's convention. */
  facing: number;
  /** How far through its walking cycle, 0..1. Only the renderer cares. */
  stride: number;
}

/** How close to a waypoint counts as standing on it. */
const ARRIVED = 0.06;
/** Seconds an idle worker waits before looking for a node again. */
const RETRY = 1.5;

export class Workforce {
  readonly grid: WalkGrid;

  private readonly game: Game;
  private readonly map: MapData;
  private readonly workers: Worker[] = [];
  /** Node cell -> the worker that called it. */
  private readonly claims = new Map<number, number>();
  /** Standing room beside the ore, worked out once: the mine never runs out. */
  private readonly stoneNodes: number[] = [];
  /**
   * Cost home to each camp, and the step that gets there, by camp id. A crew
   * carries its load back to its own camp, so there is one of these per camp
   * rather than one shared field — rebuilt only when the ground changes, which
   * `revision` is what tells us.
   */
  private readonly homes = new Map<number, { field: Field; revision: number }>();
  private nextId = 1;
  private applied = -1;

  constructor(game: Game) {
    this.game = game;
    this.map = game.map;
    this.grid = new WalkGrid(game.map);
    this.sync();
    this.stoneNodes = this.findStoneNodes();
  }

  get all(): readonly Worker[] {
    return this.workers;
  }

  /** Advances every worker by one fixed step. */
  tick(dt: number): void {
    this.sync();
    this.crews();
    for (const worker of this.workers) this.advance(worker, dt);
  }

  // --- the ground -------------------------------------------------------------

  /**
   * Rebuilds the walking grid and the field to the keep, but only when what
   * stands on the map has actually changed.
   */
  private sync(): void {
    if (this.applied === this.game.revision) return;
    this.applied = this.game.revision;
    const { game } = this;
    this.grid.apply((cell) => {
      const building = game.buildingAt(cell % this.map.size, (cell / this.map.size) | 0);
      if (!building) return false;
      // An open gatehouse is a hole in the wall on purpose: that is what the
      // player pays for. Everything else a worker walks round.
      if (building.kind === 'gatehouse' && !building.job && building.gate)
        return !(building.gate.bridgeDown && building.gate.portcullisOpen);
      return true;
    });
    // Any route worked out over the old ground is worthless now. The fields
    // home rebuild themselves lazily, off `revision`.
    for (const worker of this.workers)
      if (worker.phase === 'toNode') {
        worker.path = [];
        worker.timer = 0;
      }
  }

  /**
   * The field that leads home to one camp, built on demand and kept until the
   * ground changes under it. A camp is a building, so it is rooted on the ring
   * of open cells around it — where a worker actually stands to put a load down.
   */
  private homeField(campId: number): Field | null {
    const camp = this.game.building(campId);
    if (!camp) return null;
    let entry = this.homes.get(campId);
    if (!entry) {
      entry = { field: makeField(this.map.size * this.map.size), revision: -1 };
      this.homes.set(campId, entry);
    }
    if (entry.revision !== this.grid.revision) {
      this.grid.field(this.grid.around(camp.x, camp.z, camp.size), entry.field);
      entry.revision = this.grid.revision;
    }
    return entry.field;
  }

  /** Walkable standing room beside the ore body. Stone never runs out, so these never move. */
  private findStoneNodes(): number[] {
    const { map } = this;
    const nodes: number[] = [];
    for (let z = 0; z < map.size; z++)
      for (let x = 0; x < map.size; x++) {
        const cell = z * map.size + x;
        if (kindAt(map, x, z) === Kind.ORE || !this.grid.walkable(cell)) continue;
        for (let n = 0; n < NEIGHBOURS.length; n++) {
          const [dx, dz] = NEIGHBOURS[n]!;
          if (!contains(map, x + dx, z + dz) || kindAt(map, x + dx, z + dz) !== Kind.ORE) continue;
          // Only where the face is actually within reach from the ground: a
          // sheer course of the mountain is not a seam anyone works.
          if (Math.abs((map.height[(z + dz) * map.size + x + dx] ?? 0) - (map.height[cell] ?? 0)) > 1) continue;
          nodes.push(cell);
          break;
        }
      }
    return nodes;
  }

  // --- the crews --------------------------------------------------------------

  /** Hires and lays off so every standing camp has the crew its level pays for. */
  private crews(): void {
    const wanted = new Map<number, { camp: CampDef; building: Building; crew: number }>();
    for (const building of this.game.state.buildings) {
      if (building.kind === 'keep') continue;
      const camp = BUILDING[building.kind].camp;
      // A camp still going up has nobody in it; one being upgraded keeps the
      // crew it already has, because its level has not changed yet.
      if (!camp || building.job?.type === 'construct') continue;
      wanted.set(building.id, {
        camp,
        building,
        crew: camp.crew[Math.min(building.level, camp.crew.length) - 1] ?? 0,
      });
    }

    const have = new Map<number, number>();
    for (let i = this.workers.length - 1; i >= 0; i--) {
      const worker = this.workers[i]!;
      const want = wanted.get(worker.campId);
      const count = (have.get(worker.campId) ?? 0) + 1;
      // A camp pulled down, or knocked back a level, loses its workers — and
      // whatever they were carrying goes with them.
      if (!want || count > want.crew) {
        this.release(worker);
        this.workers.splice(i, 1);
        continue;
      }
      have.set(worker.campId, count);
    }

    for (const campId of this.homes.keys()) if (!wanted.has(campId)) this.homes.delete(campId);

    for (const [campId, { camp, building, crew }] of wanted) {
      for (let n = have.get(campId) ?? 0; n < crew; n++) {
        const [cx, cz] = centreOf(building);
        const gate = this.grid.around(building.x, building.z, building.size)[0];
        this.workers.push({
          id: this.nextId++,
          campId,
          resource: camp.resource,
          x: gate === undefined ? cx : gate % this.map.size,
          z: gate === undefined ? cz : (gate / this.map.size) | 0,
          phase: 'idle',
          node: -1,
          path: [],
          timer: 0,
          carrying: 0,
          facing: 0,
          stride: 0,
        });
      }
    }
  }

  private campOf(worker: Worker): { def: CampDef; building: Building } | null {
    const building = this.game.building(worker.campId);
    if (!building || building.kind === 'keep') return null;
    const def = BUILDING[building.kind].camp;
    return def ? { def, building } : null;
  }

  // --- the round --------------------------------------------------------------

  private advance(worker: Worker, dt: number): void {
    const camp = this.campOf(worker);
    if (!camp) return;
    const { def } = camp;
    const level = Math.min(camp.building.level, def.harvest.length);

    switch (worker.phase) {
      case 'idle':
        worker.timer -= dt;
        if (worker.timer > 0) return;
        if (!this.pick(worker)) worker.timer = RETRY;
        return;

      case 'toNode': {
        if (worker.path.length === 0 && !this.routeTo(worker)) return;
        if (!this.follow(worker, def.speed, dt)) return;
        worker.phase = 'harvest';
        worker.timer = def.harvest[level - 1] ?? def.harvest[0] ?? 1;
        return;
      }

      case 'harvest':
        worker.timer -= dt;
        if (worker.timer > 0) return;
        // A tree is taken; a seam is not. Either way the load is the same.
        if (worker.resource === 'wood' && !this.game.fell(worker.node)) {
          // Someone else got there first, or it grew back under another claim.
          this.release(worker);
          worker.phase = 'idle';
          return;
        }
        worker.carrying = def.load;
        this.release(worker);
        worker.phase = 'toCamp';
        return;

      case 'toCamp':
        if (!this.homeward(worker, def.speed, dt)) return;
        worker.phase = 'unload';
        worker.timer = def.unload;
        return;

      case 'unload':
        worker.timer -= dt;
        if (worker.timer > 0) return;
        if (worker.carrying > 0)
          this.game.grant(
            worker.resource === 'wood' ? { wood: worker.carrying } : { stone: worker.carrying },
          );
        worker.carrying = 0;
        worker.phase = 'idle';
        worker.timer = 0;
        return;
    }
  }

  /**
   * Calls the nearest node nobody else has. Flooding out from where the worker
   * stands answers which one is nearest and how to get there at the same time,
   * so a pick costs one pass over the grid and nothing at all in between.
   */
  private pick(worker: Worker): boolean {
    const candidates =
      worker.resource === 'wood' ? [...this.game.forest.standingCells()] : this.stoneNodes;
    if (candidates.length === 0) return false;

    const field = this.grid.reach(this.cellOf(worker));
    let best = -1;
    let nearest = UNREACHABLE;
    let shared = -1;
    let sharedAt = UNREACHABLE;
    for (const node of candidates) {
      const dist = field.dist[node] ?? UNREACHABLE;
      if (dist === UNREACHABLE) continue;
      if (this.claims.has(node)) {
        // The ore is worked shoulder to shoulder once every face is taken. A
        // wood too crowded to claim is simply one nobody has felled yet, so
        // there is nothing to share and the worker waits.
        if (worker.resource === 'stone' && dist < sharedAt) {
          shared = node;
          sharedAt = dist;
        }
        continue;
      }
      if (dist < nearest) {
        nearest = dist;
        best = node;
      }
    }
    if (best < 0) best = shared;
    if (best < 0) return false;

    worker.node = best;
    this.claims.set(best, worker.id);
    worker.phase = 'toNode';
    worker.path = this.pathTo(field, best);
    return true;
  }

  /** The cells to walk to reach a node, the starting cell excluded. */
  private pathTo(field: Field, node: number): number[] {
    return this.grid.trace(field, node).reverse().slice(1);
  }

  /** Works the route out again, over ground that has changed since. */
  private routeTo(worker: Worker): boolean {
    if (worker.node < 0) {
      worker.phase = 'idle';
      return false;
    }
    const route = this.grid.route(this.cellOf(worker), worker.node);
    if (route === null) {
      // Walled off from it — drop the claim so somebody else can have it.
      this.release(worker);
      worker.phase = 'idle';
      worker.timer = RETRY;
      return false;
    }
    worker.path = route;
    return true;
  }

  /** Walks a step of the stored route. True once the last waypoint is reached. */
  private follow(worker: Worker, speed: number, dt: number): boolean {
    let budget = speed * dt;
    while (budget > 0) {
      const next = worker.path[0];
      if (next === undefined) return true;
      const [tx, tz] = this.pointIn(worker, next);
      budget = this.stepTowards(worker, tx, tz, budget);
      if (budget <= 0) break;
      worker.path.shift();
    }
    return worker.path.length === 0;
  }

  /**
   * Walks a step down the field that leads back to the worker's own camp.
   * Nothing is stored: a wall raised across the way changes the field, and the
   * worker takes the new way on its very next step.
   */
  private homeward(worker: Worker, speed: number, dt: number): boolean {
    const home = this.homeField(worker.campId);
    if (!home) return false;
    let budget = speed * dt;
    while (budget > 0) {
      const cell = this.cellOf(worker);
      const here = home.dist[cell] ?? UNREACHABLE;
      // Walled in: stand and wait rather than wander. The load is not lost.
      if (here === UNREACHABLE) return false;
      if (here === 0) {
        const [tx, tz] = this.pointIn(worker, cell);
        if (Math.abs(worker.x - tx) < ARRIVED && Math.abs(worker.z - tz) < ARRIVED) return true;
        budget = this.stepTowards(worker, tx, tz, budget);
        continue;
      }
      const n = home.flow[cell] ?? NO_FLOW;
      if (n === NO_FLOW) return false;
      const next = this.grid.step(cell, n);
      if (next < 0) return false;
      const [tx, tz] = this.pointIn(worker, next);
      budget = this.stepTowards(worker, tx, tz, budget);
    }
    return false;
  }

  /**
   * Moves a worker towards a point and returns what is left of its budget —
   * zero while it is still on its way, the remainder once it has arrived, so
   * that one tick can cross several cells without stalling a step per tick.
   */
  private stepTowards(worker: Worker, tx: number, tz: number, budget: number): number {
    const dx = tx - worker.x;
    const dz = tz - worker.z;
    const distance = Math.hypot(dx, dz);
    if (distance <= ARRIVED) {
      worker.x = tx;
      worker.z = tz;
      return budget;
    }
    if (distance > 1e-6) worker.facing = (Math.atan2(-dz, dx) * 180) / Math.PI;
    if (budget >= distance) {
      worker.x = tx;
      worker.z = tz;
      worker.stride = (worker.stride + distance) % 1;
      return budget - distance;
    }
    worker.x += (dx / distance) * budget;
    worker.z += (dz / distance) * budget;
    worker.stride = (worker.stride + budget) % 1;
    return 0;
  }

  /**
   * Where inside a cell a given worker aims. A fixed offset per worker keeps a
   * crew from walking the same line stacked on top of each other, without a
   * separation pass — which is P4's business, once there are two hundred of
   * them.
   */
  private pointIn(worker: Worker, cell: number): [number, number] {
    const x = cell % this.map.size;
    const z = (cell / this.map.size) | 0;
    return [x + (((worker.id * 5) % 7) - 3) / 14, z + (((worker.id * 3) % 7) - 3) / 14];
  }

  private cellOf(worker: Worker): number {
    const x = Math.min(this.map.size - 1, Math.max(0, Math.round(worker.x)));
    const z = Math.min(this.map.size - 1, Math.max(0, Math.round(worker.z)));
    return z * this.map.size + x;
  }

  private release(worker: Worker): void {
    if (worker.node >= 0 && this.claims.get(worker.node) === worker.id) this.claims.delete(worker.node);
    worker.node = -1;
    worker.path = [];
  }
}
