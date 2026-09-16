// The walking grid and the fields over it, in node against synthetic maps.
//
// These are the rules everything that moves will lean on — the workers of P3
// today, the attackers of P4 next — so each one is pinned here rather than
// eyeballed in the browser: what water and walls do, that a diagonal cannot
// slip through the corner where two walls meet, that a climb too steep is not
// a path, and that a keep sealed off leaves a field with no route rather than
// a hang.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Build, Kind, type MapData } from '../src/core/map.ts';
import {
  DIAGONAL,
  ORTHO,
  UNREACHABLE,
  WalkGrid,
  makeField,
} from '../src/sim/pathing.ts';

/** A flat 12x12 of open ground. */
function flat(size = 12): MapData {
  const n = size * size;
  return {
    size,
    heights: { ground: 3, riverBed: 2, lakeBed: 0 },
    water: { river: 2.45, lake: 0.45 },
    keep: { x: 5, z: 5 },
    ring: 5,
    mine: { x: 0, z: 0 },
    bridge: { x: 0, from: 0, to: 0, halfWidth: 0 },
    spawns: [],
    riverPath: [],
    bridgeCells: [],
    trees: [],
    waterfall: [],
    height: new Array(n).fill(3),
    kind: new Array(n).fill(Kind.GRASS),
    build: new Array(n).fill(Build.CASTLE),
  };
}

const at = (map: MapData, x: number, z: number): number => z * map.size + x;
const nothingBuilt = (): boolean => false;

test('open ground costs what a step costs, straight or diagonal', () => {
  const map = flat();
  const grid = new WalkGrid(map);
  grid.apply(nothingBuilt);
  const field = grid.field([at(map, 0, 0)], makeField(map.size ** 2));

  assert.equal(field.dist[at(map, 0, 0)], 0);
  assert.equal(field.dist[at(map, 3, 0)], 3 * ORTHO);
  assert.equal(field.dist[at(map, 3, 3)], 3 * DIAGONAL, 'a diagonal is 1.4 steps, not 1 and not 2');
  // Four across then one down is cheaper as three diagonals plus a straight.
  assert.equal(field.dist[at(map, 4, 3)], 3 * DIAGONAL + ORTHO);
});

test('a river is a wall, and the bridge deck is the hole in it', () => {
  const map = flat();
  for (let z = 0; z < map.size; z++) {
    map.kind[at(map, 6, z)] = Kind.RIVER;
    map.height[at(map, 6, z)] = 2;
  }

  const dry = new WalkGrid(map);
  dry.apply(nothingBuilt);
  const blocked = dry.field([at(map, 0, 5)], makeField(map.size ** 2));
  assert.equal(blocked.dist[at(map, 11, 5)], UNREACHABLE, 'nothing crosses open water');

  map.bridgeCells = [at(map, 6, 5)];
  const bridged = new WalkGrid(map);
  bridged.apply(nothingBuilt);
  const open = bridged.field([at(map, 0, 5)], makeField(map.size ** 2));
  assert.notEqual(open.dist[at(map, 11, 5)], UNREACHABLE, 'the deck is the one way over');
  // And everything really does funnel through that one cell.
  const route = bridged.route(at(map, 0, 5), at(map, 11, 5));
  assert.ok(route?.includes(at(map, 6, 5)));
});

test('a climb of more than one course is not a path', () => {
  const map = flat();
  for (let z = 0; z < map.size; z++) map.height[at(map, 6, z)] = 3 + 2;
  const grid = new WalkGrid(map);
  grid.apply(nothingBuilt);
  assert.equal(grid.route(at(map, 0, 5), at(map, 11, 5)), null, 'a two-course cliff holds');

  // One course, and it is walked up without a second thought.
  for (let z = 0; z < map.size; z++) map.height[at(map, 6, z)] = 3 + 1;
  const gentle = new WalkGrid(map);
  gentle.apply(nothingBuilt);
  assert.notEqual(gentle.route(at(map, 0, 5), at(map, 11, 5)), null);
});

test('a wall diverts the field instead of stopping it, and the gap is found', () => {
  const map = flat();
  const grid = new WalkGrid(map);
  // A wall down column 6, with one cell left open at z = 9.
  const wall = new Set<number>();
  for (let z = 0; z < map.size; z++) if (z !== 9) wall.add(at(map, 6, z));
  grid.apply((cell) => wall.has(cell));

  const route = grid.route(at(map, 2, 2), at(map, 10, 2));
  assert.ok(route, 'the gap is a way through');
  assert.ok(route.includes(at(map, 6, 9)), 'and it is the way taken');
});

test('a diagonal cannot slip through the corner where two walls meet', () => {
  const map = flat();
  const grid = new WalkGrid(map);
  // Walls meeting at a right angle around (5, 5): the only diagonal out of it
  // would cut clean between the two blocks.
  const wall = new Set([at(map, 5, 4), at(map, 4, 5)]);
  grid.apply((cell) => wall.has(cell));

  const field = grid.field([at(map, 4, 4)], makeField(map.size ** 2));
  assert.equal(field.dist[at(map, 5, 5)] === DIAGONAL, false, 'it must go the long way round');
  assert.ok((field.dist[at(map, 5, 5)] ?? 0) > DIAGONAL);
});

test('a keep sealed off leaves no route, and nothing hangs working that out', () => {
  const map = flat();
  const grid = new WalkGrid(map);
  // A ring of moat right round the keep at (5, 5).
  const ring = new Set<number>();
  for (let d = -2; d <= 2; d++)
    for (const cell of [at(map, 5 + d, 3), at(map, 5 + d, 7), at(map, 3, 5 + d), at(map, 7, 5 + d)])
      ring.add(cell);
  grid.apply((cell) => ring.has(cell));

  const field = grid.field([at(map, 0, 0)], makeField(map.size ** 2));
  assert.equal(field.dist[at(map, 5, 5)], UNREACHABLE, 'nothing reaches a sealed keep');
  assert.equal(grid.route(at(map, 0, 0), at(map, 5, 5)), null);
  // The cells inside the ring are still perfectly walkable — just cut off.
  assert.ok(grid.walkable(at(map, 5, 5)));
});

test('the field rooted on the ring around a footprint reaches every open cell', () => {
  const map = flat();
  const grid = new WalkGrid(map);
  grid.apply(nothingBuilt);
  const ring = grid.around(4, 4, 3);
  assert.equal(ring.length, 16, 'a 3x3 has sixteen cells touching it');

  const field = grid.field(ring, makeField(map.size ** 2));
  let reached = 0;
  for (let i = 0; i < map.size ** 2; i++) if (field.dist[i] !== UNREACHABLE) reached++;
  assert.equal(reached, map.size ** 2, 'open ground is open ground');
  // And tracing back down the flow really does land on the ring.
  const trace = grid.trace(field, at(map, 11, 11));
  assert.equal(field.dist[trace[trace.length - 1]!], 0);
});

test('a route is the cells to walk, the starting one excluded', () => {
  const map = flat();
  const grid = new WalkGrid(map);
  grid.apply(nothingBuilt);
  const route = grid.route(at(map, 2, 2), at(map, 5, 2));
  assert.deepEqual(route, [at(map, 3, 2), at(map, 4, 2), at(map, 5, 2)]);
  assert.deepEqual(grid.route(at(map, 2, 2), at(map, 2, 2)), [], 'already there');
});
