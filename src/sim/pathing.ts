/**
 * The walking grid, and the fields computed over it.
 *
 * Pure, like the rest of src/sim: numbers and typed arrays, no three.js, no
 * clock. Everything that moves on the map — the workers of P3 and the
 * attackers of P4 — reads its direction out of a field built here.
 *
 * Three decisions carry the whole thing:
 *
 * - **A cell costs, it does not simply block.** `cost` holds a multiplier per
 *   cell, and BLOCKED is the one absolute. P3 only ever blocks (a worker does
 *   not smash walls), but P4 derives the cost of a wall from its hit points and
 *   gets the siege behaviour out of Dijkstra rather than out of an AI.
 * - **Steps are checked, not just cells.** A move is legal only if the drop
 *   between the two cells is small enough, and a diagonal needs both of the
 *   cells it cuts past. Without the second rule anything walks clean through
 *   the corner where two walls meet.
 * - **One field serves many movers.** A multi-source Dijkstra from the keep is
 *   computed once per grid change, and every worker carrying a load home reads
 *   its next step out of it. No path is stored, so nothing has to be recomputed
 *   when a wall goes up — the field is, and they all follow the new one.
 *
 * Costs are scaled so a diagonal is the 1.4 it really is while staying whole
 * numbers: an orthogonal step is 10, a diagonal 14. Whole numbers are what let
 * the queue be a ring of buckets (Dial's algorithm) instead of a heap, which is
 * what keeps the whole field inside the 2 ms budget of docs/brief.md.
 */
import { NEIGHBOURS } from '../core/grid.ts';
import { contains, isWater, kindAt, type MapData } from '../core/map.ts';

/** Nothing may enter this cell. */
export const BLOCKED = 0;
/** Cost multiplier of plain open ground. */
export const OPEN = 1;

/** Step costs, scaled by 10 so a diagonal stays a whole number. */
export const ORTHO = 10;
export const DIAGONAL = 14;

/** No route from here. */
export const UNREACHABLE = 0xffffffff;
/** This cell has no onward step: it is a source, or cut off. */
export const NO_FLOW = 255;

/**
 * The tallest step anything climbs in one move. One height unit is one of
 * Kenney's cliff courses, so this lets a worker walk up to the foot of the ore
 * body while the mountain proper stays a wall.
 */
export const MAX_STEP = 1;

/** For each neighbour index, the one pointing back the other way. */
const OPPOSITE: readonly number[] = [2, 3, 0, 1, 6, 7, 4, 5];

/** The cost of a step to neighbour `n`, before the cell's own multiplier. */
export const stepCost = (n: number): number => (n < 4 ? ORTHO : DIAGONAL);

/** Integrated cost to the nearest source, and the step that gets there. */
export interface Field {
  /** Cost from each cell to the nearest source, UNREACHABLE where there is none. */
  dist: Uint32Array;
  /** Index into NEIGHBOURS of the step towards the source, NO_FLOW if there is none. */
  flow: Uint8Array;
}

export function makeField(cells: number): Field {
  return { dist: new Uint32Array(cells), flow: new Uint8Array(cells) };
}

/** What a mover is allowed to walk over. P4 adds its classes here. */
export interface Blocked {
  /** Whether a building standing on a cell stops this mover. */
  (cell: number): boolean;
}

/**
 * The ground as something that walks sees it.
 *
 * Built from the map once, then `apply` lays the buildings over it — which is
 * the only part that changes during a game. `revision` goes up every time, so
 * anything holding a route knows to throw it away.
 */
export class WalkGrid {
  readonly map: MapData;
  readonly size: number;
  /** Cost multiplier of entering each cell, BLOCKED where nothing may. */
  readonly cost: Uint16Array;
  /** Cost of the bare terrain, before anything was built on it. */
  private readonly terrain: Uint16Array;
  private readonly height: Int16Array;
  revision = 0;

  private readonly scratch: Field;
  private buckets: number[][] = [];

  constructor(map: MapData) {
    this.map = map;
    this.size = map.size;
    const cells = map.size * map.size;
    this.terrain = new Uint16Array(cells);
    this.height = new Int16Array(cells);
    const bridge = new Set(map.bridgeCells);

    for (let z = 0; z < map.size; z++)
      for (let x = 0; x < map.size; x++) {
        const i = z * map.size + x;
        this.height[i] = map.height[i] ?? 0;
        // The bridge deck is the one place an army walks over water, and the
        // reason the river road has exactly one crossing.
        this.terrain[i] = isWater(kindAt(map, x, z)) && !bridge.has(i) ? BLOCKED : OPEN;
      }
    this.cost = Uint16Array.from(this.terrain);
    this.scratch = makeField(cells);
    this.sizeBuckets();
  }

  /** Lays the standing buildings over the bare terrain. */
  apply(blocked: Blocked): void {
    for (let i = 0; i < this.cost.length; i++)
      this.cost[i] = this.terrain[i] === BLOCKED ? BLOCKED : blocked(i) ? BLOCKED : OPEN;
    this.sizeBuckets();
    this.revision++;
  }

  /**
   * Dial's queue holds every distance still in flight at once, and one step
   * spans at most the dearest edge on the board — so the ring has to be as wide
   * as that edge. It is DIAGONAL today, when nothing costs more than open
   * ground; P4 charges a wall by its hit points and the ring grows with it.
   */
  private sizeBuckets(): void {
    let dearest = OPEN;
    for (const cost of this.cost) if (cost > dearest) dearest = cost;
    const width = DIAGONAL * dearest + 1;
    if (this.buckets.length === width) return;
    this.buckets = Array.from({ length: width }, () => [] as number[]);
  }

  walkable(cell: number): boolean {
    return this.cost[cell] !== BLOCKED;
  }

  /**
   * Whether a mover may step from one cell to the neighbour at index `n`.
   *
   * A diagonal also needs the two cells it brushes past: without that check
   * anything slips through the corner where two walls meet, which would make a
   * wall line something you walk round rather than through.
   */
  step(from: number, n: number): number {
    const size = this.size;
    const x = from % size;
    const z = (from / size) | 0;
    const offset = NEIGHBOURS[n]!;
    const nx = x + offset[0];
    const nz = z + offset[1];
    if (nx < 0 || nz < 0 || nx >= size || nz >= size) return -1;
    const to = nz * size + nx;
    if (this.cost[to] === BLOCKED) return -1;
    if (Math.abs(this.height[to]! - this.height[from]!) > MAX_STEP) return -1;
    if (n >= 4) {
      const side = nz * size + x;
      const other = z * size + nx;
      if (this.cost[side] === BLOCKED || this.cost[other] === BLOCKED) return -1;
      if (Math.abs(this.height[side]! - this.height[from]!) > MAX_STEP) return -1;
      if (Math.abs(this.height[other]! - this.height[from]!) > MAX_STEP) return -1;
    }
    return to;
  }

  /**
   * Multi-source Dijkstra from every source cell at once, by buckets.
   *
   * Edge costs are small whole numbers, so the queue is a ring of buckets
   * rather than a heap: each cell leaves the queue once and the whole thing is
   * linear in the grid. `into` is reused between calls so a rebuild allocates
   * nothing.
   */
  field(sources: Iterable<number>, into: Field = makeField(this.cost.length)): Field {
    const { dist, flow } = into;
    dist.fill(UNREACHABLE);
    flow.fill(NO_FLOW);

    const buckets = this.buckets;
    for (const bucket of buckets) bucket.length = 0;
    const width = buckets.length;
    let queued = 0;
    let head = 0;

    for (const source of sources) {
      if (source < 0 || source >= dist.length || !this.walkable(source) || dist[source] === 0) continue;
      dist[source] = 0;
      buckets[0]!.push(source);
      queued++;
    }
    if (queued === 0) return into;

    // Distances only ever grow, and never by more than one edge at a time, so
    // the ring always holds everything still waiting.
    for (; queued > 0; head++) {
      const bucket = buckets[head % width]!;
      if (bucket.length === 0) continue;
      const here = head;
      // Take the bucket whole: anything pushed into it while we work belongs
      // to a later distance and lands in another bucket.
      const batch = bucket.slice();
      bucket.length = 0;
      queued -= batch.length;
      for (const from of batch) {
        // A cell reached again more cheaply was requeued; the stale copy skips.
        if (dist[from] !== here) continue;
        for (let n = 0; n < NEIGHBOURS.length; n++) {
          const to = this.step(from, n);
          if (to < 0) continue;
          const next = here + stepCost(n) * this.cost[to]!;
          if (next >= dist[to]!) continue;
          dist[to] = next;
          flow[to] = OPPOSITE[n]!;
          buckets[next % width]!.push(to);
          queued++;
        }
      }
    }
    return into;
  }

  /**
   * The cells from `cell` down to the source it flows to, `cell` first and the
   * source last. Empty if there is no way through.
   */
  trace(field: Field, cell: number): number[] {
    if (field.dist[cell] === UNREACHABLE) return [];
    const path = [cell];
    let at = cell;
    // The field strictly decreases along the flow, so this cannot loop; the
    // cap is there so a corrupted field fails loudly rather than hanging.
    for (let guard = 0; guard < this.cost.length; guard++) {
      const n = field.flow[at]!;
      if (n === NO_FLOW) return path;
      const next = this.step(at, n);
      if (next < 0) return path;
      path.push(next);
      at = next;
    }
    return path;
  }

  /**
   * A route from one cell to another, the starting cell excluded, or null if
   * there is none. Built by flooding out from `from`, which also answers "how
   * far is every candidate node" in the same pass — see src/sim/workers.ts.
   */
  route(from: number, to: number): number[] | null {
    const field = this.field([from], this.scratch);
    if (field.dist[to] === UNREACHABLE) return null;
    return this.trace(field, to).reverse().slice(1);
  }

  /** Floods out from a cell into the shared scratch field. Valid until the next call. */
  reach(from: number): Field {
    return this.field([from], this.scratch);
  }

  /** Walkable cells touching a footprint — where something standing in it is reached from. */
  around(x: number, z: number, size: number): number[] {
    const cells: number[] = [];
    for (let dz = -1; dz <= size; dz++)
      for (let dx = -1; dx <= size; dx++) {
        if (dx >= 0 && dx < size && dz >= 0 && dz < size) continue;
        const cx = x + dx;
        const cz = z + dz;
        if (!contains(this.map, cx, cz)) continue;
        const cell = cz * this.size + cx;
        if (this.walkable(cell)) cells.push(cell);
      }
    return cells;
  }
}
