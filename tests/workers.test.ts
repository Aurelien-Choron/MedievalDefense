// The economy, run in node with no renderer: camps hiring their crews, the
// round from camp to node to keep, trees felled and grown back, and the walk
// itself — a worker that meets a wall goes round it, and one that cannot get
// there at all does not wander off or spin.
//
// Everything here is what P3 promised, so a regression in the round shows up
// as a number of loads rather than as a screenshot that looks wrong.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Build, Kind, type MapData } from '../src/core/map.ts';
import { BUILDING, KEEP_TIERS } from '../src/data/buildings.ts';
import { Game } from '../src/sim/game.ts';
import { REGROW_TIME } from '../src/sim/forest.ts';
import { Workforce } from '../src/sim/workers.ts';

const STEP = 1 / 20;
const SIZE = 20;
const at = (x: number, z: number): number => z * SIZE + x;

/**
 * A flat 20x20 with the keep at (10, 10):
 *
 * - x 16..19 is forest, every cell carrying a tree;
 * - x 0..1 is ore, one course up, so a miner walks to the foot of it;
 * - x 13..15 is woodcutter ground, x 2..4 is miner ground, and the whole
 *   middle is castle ground so a wall can be thrown across either.
 */
function testMap(): MapData {
  const n = SIZE * SIZE;
  const kind: number[] = new Array(n).fill(Kind.GRASS);
  const height: number[] = new Array(n).fill(3);
  const build: number[] = new Array(n).fill(0);
  const trees: number[] = [];

  for (let z = 0; z < SIZE; z++)
    for (let x = 0; x < SIZE; x++) {
      const i = at(x, z);
      if (x >= 16) {
        kind[i] = Kind.FOREST;
        trees.push(i);
      } else if (x <= 1) {
        kind[i] = Kind.ORE;
        height[i] = 4;
      }
      if (x >= 2 && x <= 18) build[i] = Build.CASTLE;
      if (x >= 13 && x <= 15) build[i] |= Build.WOOD_CAMP;
      if (x >= 2 && x <= 4) build[i] |= Build.STONE_CAMP;
    }
  for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) build[at(10 + dx, 10 + dz)] = 0;

  return {
    size: SIZE,
    heights: { ground: 3, riverBed: 2, lakeBed: 0 },
    water: { river: 2.45, lake: 0.45 },
    keep: { x: 10, z: 10 },
    ring: 8,
    mine: { x: 0, z: 10 },
    bridge: { x: 0, from: 0, to: 0, halfWidth: 0 },
    spawns: [],
    riverPath: [],
    bridgeCells: [],
    trees,
    waterfall: [],
    height,
    kind,
    build,
  };
}

interface Field {
  game: Game;
  work: Workforce;
  run(seconds: number): void;
}

function field(): Field {
  const game = new Game(testMap());
  const work = new Workforce(game);
  game.grant({ gold: 1e5, wood: 1e5, stone: 1e5 });
  return {
    game,
    work,
    run(seconds: number) {
      for (let i = 0; i < Math.round(seconds / STEP); i++) {
        game.tick(STEP);
        work.tick(STEP);
      }
    },
  };
}

/** Takes the keep up, which is what unlocks a camp's top level. */
function reachTier(f: Field, tier: number): void {
  while (f.game.tier < tier) {
    assert.ok(f.game.upgradeKeep(), `keep to tier ${f.game.tier + 1}`);
    f.run(KEEP_TIERS[f.game.tier]!.buildTime);
  }
}

/** A camp of a kind, finished and taken up to `level`. */
function camp(f: Field, kind: 'woodcutter-camp' | 'miner-camp', x: number, z: number, level = 1) {
  const top = BUILDING[kind].levels?.[level - 2]?.tier ?? 1;
  if (top > f.game.tier) reachTier(f, top);
  const built = f.game.place(kind, x, z);
  assert.ok(built, `${kind} at ${x},${z}`);
  f.run(BUILDING[kind].buildTime);
  for (let l = 1; l < level; l++) {
    assert.ok(f.game.upgrade(built, 'level'), `camp to level ${l + 1}`);
    f.run(BUILDING[kind].levels![l - 1]!.buildTime);
  }
  assert.equal(built.level, level);
  return built;
}

const crewOf = (f: Field, id: number): number => f.work.all.filter((w) => w.campId === id).length;

test('a camp still going up has nobody in it; a finished one has the crew its level pays for', () => {
  const f = field();
  reachTier(f, 2);
  const built = f.game.place('woodcutter-camp', 13, 12)!;
  f.run(BUILDING['woodcutter-camp'].buildTime - 2);
  assert.equal(f.work.all.length, 0, 'a building site is not a camp');

  f.run(3);
  assert.equal(crewOf(f, built.id), 2, 'level 1 is two woodcutters');

  assert.ok(f.game.upgrade(built, 'level'));
  f.run(1);
  assert.equal(crewOf(f, built.id), 2, 'an upgrade in progress changes nothing yet');
  f.run(BUILDING['woodcutter-camp'].levels![0]!.buildTime);
  assert.equal(crewOf(f, built.id), 3, 'level 2 is three');

  assert.ok(f.game.upgrade(built, 'level'));
  f.run(BUILDING['woodcutter-camp'].levels![1]!.buildTime + 1);
  assert.equal(crewOf(f, built.id), 5, 'level 3 is five');
});

test('woodcutters bring wood in, and Game.grant is still the only door it comes by', () => {
  const f = field();
  camp(f, 'woodcutter-camp', 13, 12);
  const start = f.game.state.resources.wood;
  f.run(6);
  assert.equal(f.game.state.resources.wood, start, 'nothing arrives before the first trip is walked');

  f.run(120);
  const gained = f.game.state.resources.wood - start;
  assert.ok(gained > 0, 'a camp that produces nothing is the P2 stub, not P3');
  assert.equal(gained % BUILDING['woodcutter-camp'].camp!.load, 0, 'wood arrives by whole loads');
});

test('a worker carries its load back to its own camp, not to the keep', () => {
  const f = field();
  // Pitched well away from the keep, so "went home" and "went to the keep"
  // cannot be confused for one another.
  const built = camp(f, 'woodcutter-camp', 13, 17);
  const doorstep = new Set(f.work.grid.around(built.x, built.z, built.size));

  let caught: { x: number; z: number } | null = null;
  for (let i = 0; i < 20000 && !caught; i++) {
    f.game.tick(STEP);
    f.work.tick(STEP);
    const home = f.work.all.find((w) => w.phase === 'unload');
    if (home) caught = { x: Math.round(home.x), z: Math.round(home.z) };
  }
  assert.ok(caught, 'no worker ever came home to unload');
  assert.ok(
    doorstep.has(caught.z * SIZE + caught.x),
    `unloaded at ${caught.x},${caught.z}, which is not the camp's doorstep`,
  );
  const toKeep = Math.max(Math.abs(caught.x - 10), Math.abs(caught.z - 10));
  assert.ok(toKeep > 1, `unloaded next to the keep instead (${caught.x},${caught.z})`);
  assert.ok(f.game.state.resources.wood > 0);
});

test('a bigger crew brings in more, level for level', () => {
  const measure = (level: number): number => {
    const f = field();
    camp(f, 'woodcutter-camp', 13, 12, level);
    const start = f.game.state.resources.wood;
    f.run(180);
    return f.game.state.resources.wood - start;
  };
  const one = measure(1);
  const three = measure(3);
  assert.ok(one > 0 && three > one, `level 3 (${three}) should beat level 1 (${one})`);
  // Two workers to five, with a faster swing on top: comfortably more than double.
  assert.ok(three >= one * 2, `level 3 brought ${three} against ${one}`);
});

test('a felled tree leaves a stump, and the stump grows back on its own', () => {
  const f = field();
  const cell = f.game.map.trees[0]!;
  assert.ok(f.game.fell(cell));
  assert.equal(f.game.fell(cell), false, 'it cannot be felled twice');
  assert.equal(f.game.forest.standing(cell), false);

  f.run(REGROW_TIME - 5);
  assert.equal(f.game.forest.standing(cell), false, 'it came back early');
  f.run(10);
  assert.equal(f.game.forest.standing(cell), true, 'the wood never grows back');
  assert.equal(f.game.state.felled.length, 0, 'a stump that grew back is not a stump');
});

test('a crew works the wood down, and the stumps match what is missing', () => {
  const f = field();
  camp(f, 'woodcutter-camp', 13, 12);
  const trees = f.game.map.trees.length;
  assert.equal([...f.game.forest.standingCells()].length, trees);

  f.run(40);
  const standing = [...f.game.forest.standingCells()].length;
  assert.ok(standing < trees, 'nothing was felled');
  assert.equal(f.game.state.felled.length, trees - standing, 'the books do not balance');
});

test('two woodcutters do not queue up at the same tree', () => {
  const f = field();
  camp(f, 'woodcutter-camp', 13, 12, 3);
  // Let the crew get out to the wood and settle on their nodes.
  f.run(12);
  const nodes = f.work.all.filter((w) => w.node >= 0).map((w) => w.node);
  assert.ok(nodes.length >= 2, 'the crew should be out working');
  assert.equal(new Set(nodes).size, nodes.length, 'two of them called the same tree');
});

test('a worker meets a wall and goes round it, through the one gap left open', () => {
  const f = field();
  camp(f, 'woodcutter-camp', 13, 12);

  // A palisade down column 15, sealing the wood off but for one cell.
  const gap = 4;
  for (let z = 0; z < SIZE; z++) {
    if (z === gap) continue;
    assert.ok(f.game.place('palisade', 15, z), `palisade at 15,${z}`);
  }
  f.run(BUILDING.palisade.buildTime + 1);

  const start = f.game.state.resources.wood;
  f.run(200);
  assert.ok(f.game.state.resources.wood > start, 'the gap should still let the wood through');

  // From open ground beside the camp — the camp itself is a building, and
  // nothing walks through one.
  const route = f.work.grid.route(at(13, 10), at(17, 12));
  assert.ok(route, 'there is a way to the wood');
  assert.ok(route.includes(at(15, gap)), 'and it is the gap, not straight through the palisade');
});

test('a wood walled off outright stops the work without anything spinning', () => {
  const f = field();
  camp(f, 'woodcutter-camp', 13, 12);
  for (let z = 0; z < SIZE; z++) assert.ok(f.game.place('palisade', 15, z), `palisade at 15,${z}`);
  f.run(BUILDING.palisade.buildTime + 1);

  const start = f.game.state.resources.wood;
  f.run(120);
  assert.equal(f.game.state.resources.wood, start, 'no wood can cross a solid wall');
  assert.ok(
    f.work.all.every((w) => w.phase === 'idle' || w.phase === 'toCamp' || w.phase === 'unload'),
    'a worker with nowhere to go waits rather than wandering',
  );
});

test('a camp pulled down takes its workers with it', () => {
  const f = field();
  const built = camp(f, 'woodcutter-camp', 13, 12);
  f.run(10);
  assert.ok(f.work.all.length > 0);

  assert.ok(f.game.demolish(built));
  f.run(STEP * 2);
  assert.equal(f.work.all.length, 0, 'workers outliving their camp');
  // And the ground they had called is free again for whoever comes next.
  const next = camp(f, 'woodcutter-camp', 13, 12);
  f.run(20);
  assert.ok(crewOf(f, next.id) > 0);
});

test('miners work the foot of the ore and bring stone in', () => {
  const f = field();
  camp(f, 'miner-camp', 3, 10);
  const start = f.game.state.resources.stone;
  f.run(160);
  const gained = f.game.state.resources.stone - start;
  assert.ok(gained > 0, 'the mine produced nothing');
  assert.equal(gained % BUILDING['miner-camp'].camp!.load, 0, 'stone arrives by whole loads');
  // The seam is not consumed: no stumps, and the ore is all still there.
  assert.equal(f.game.state.felled.length, 0);
});

test('a game reloaded from its own JSON remembers which trees are down', () => {
  const f = field();
  camp(f, 'woodcutter-camp', 13, 12);
  f.run(40);
  const felled = f.game.state.felled.length;
  assert.ok(felled > 0, 'nothing was felled to remember');

  const loaded = Game.load(f.game.map, JSON.stringify(f.game.state));
  assert.equal(loaded.state.felled.length, felled);
  assert.equal(
    [...loaded.forest.standingCells()].length,
    [...f.game.forest.standingCells()].length,
  );
});
