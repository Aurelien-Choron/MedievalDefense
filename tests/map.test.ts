// Invariants the generated map has to keep. These are regression tests for
// tools/gen-map.mjs: the layout is hand-tuned and easy to break by nudging a
// river control point, so the properties the game *relies* on are asserted here
// rather than eyeballed on a screenshot.
//
// Reads map.json through fs rather than importing it, which keeps src/core/map
// free of bundler-only import syntax and node-runnable.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MAP_SIZE, NEIGHBOURS } from '../src/core/grid.ts';
import {
  Build,
  Kind,
  canBuild,
  contains,
  heightAt,
  index,
  isWater,
  kindAt,
  type MapData,
  type Spawn,
} from '../src/core/map.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const map = JSON.parse(
  fs.readFileSync(path.join(here, '..', 'src', 'data', 'map.json'), 'utf8'),
) as MapData;

test('the grid is complete, square, and the size the renderer expects', () => {
  assert.equal(map.size, MAP_SIZE, 'gen-map.mjs and src/core/grid.ts disagree on the map size');
  for (const layer of [map.height, map.kind, map.build]) assert.equal(layer.length, map.size ** 2);
});

test('the castle ring is whole, and every cell of it is flat at ground height', () => {
  // The placement code is allowed to assume this: no slope handling anywhere.
  // Counting exactly also catches the river or the lake biting into the ring.
  let cells = 0;
  for (let z = 0; z < map.size; z++)
    for (let x = 0; x < map.size; x++) {
      if (!canBuild(map, x, z, Build.CASTLE)) continue;
      cells++;
      assert.equal(
        heightAt(map, x, z),
        map.heights.ground,
        `build cell ${x},${z} is not at ground height`,
      );
    }
  const side = 2 * map.ring + 1;
  assert.equal(cells, side * side - 9, 'the build ring has holes (the 3x3 keep excepted)');
});

test('no build cell sits on water', () => {
  for (let z = 0; z < map.size; z++)
    for (let x = 0; x < map.size; x++) {
      if (!canBuild(map, x, z, Build.CASTLE | Build.CAMP)) continue;
      assert.ok(!isWater(kindAt(map, x, z)), `build cell ${x},${z} is water`);
    }
});

test('the keep footprint is occupied, not buildable', () => {
  for (let dz = -1; dz <= 1; dz++)
    for (let dx = -1; dx <= 1; dx++)
      assert.ok(
        !canBuild(map, map.keep.x + dx, map.keep.z + dz, Build.CASTLE),
        'the keep itself must not be a build cell',
      );
});

test('both spawns are on the map edge, on dry walkable ground', () => {
  assert.equal(map.spawns.length, 2, 'one river road, one eastern forest track');
  for (const spawn of map.spawns) {
    assert.ok(contains(map, spawn.x, spawn.z), `${spawn.id} is off the map`);
    assert.ok(!isWater(kindAt(map, spawn.x, spawn.z)), `${spawn.id} spawns in water`);
    const edge = [spawn.x, spawn.z].some((c) => c === 0 || c === map.size - 1);
    assert.ok(edge, `${spawn.id} should enter from the map edge`);
  }
});

test('each resource has camp ground beside it, with room for a 2x2 camp', () => {
  // A camp has to be placeable near the ore body and near the wood, or the
  // whole economy is unreachable.
  const near = (flag: number, kind: Kind, radius: number): boolean => {
    for (let z = 0; z < map.size; z++)
      for (let x = 0; x < map.size; x++) {
        if (!canBuild(map, x, z, flag)) continue;
        for (let dz = -radius; dz <= radius; dz++)
          for (let dx = -radius; dx <= radius; dx++)
            if (kindAt(map, x + dx, z + dz) === kind) return true;
      }
    return false;
  };
  const roomFor2x2 = (flag: number): boolean => {
    for (let z = 0; z < map.size - 1; z++)
      for (let x = 0; x < map.size - 1; x++)
        if ([0, 1].every((dz) => [0, 1].every((dx) => canBuild(map, x + dx, z + dz, flag)))) return true;
    return false;
  };
  assert.ok(near(Build.STONE_CAMP, Kind.ORE, 6), 'no miner camp ground within reach of the ore');
  assert.ok(near(Build.WOOD_CAMP, Kind.FOREST, 4), 'no woodcutter camp ground within reach of the forest');
  assert.ok(roomFor2x2(Build.STONE_CAMP), 'no room for a miner camp');
  assert.ok(roomFor2x2(Build.WOOD_CAMP), 'no room for a woodcutter camp');
});

/**
 * Whether an army walking from a spawn can reach the keep over dry land.
 *
 * 8-connected, corners cut freely: that is the leakiest movement any later
 * flow field could allow, so a wall of water that holds here holds for it too.
 */
function reachesKeep(spawn: Spawn, crossTheBridge: boolean): boolean {
  const bridge = new Set(map.bridgeCells);
  const walkable = (i: number): boolean =>
    !isWater((map.kind[i] ?? Kind.GRASS) as Kind) || (crossTheBridge && bridge.has(i));

  const goal = index(map, map.keep.x, map.keep.z);
  const seen = new Uint8Array(map.size ** 2);
  const queue = [index(map, spawn.x, spawn.z)];
  seen[queue[0]!] = 1;
  while (queue.length) {
    const i = queue.pop()!;
    if (i === goal) return true;
    const x = i % map.size;
    const z = Math.floor(i / map.size);
    for (const [dx, dz] of NEIGHBOURS) {
      if (!contains(map, x + dx, z + dz)) continue;
      const j = index(map, x + dx, z + dz);
      if (seen[j] || !walkable(j)) continue;
      seen[j] = 1;
      queue.push(j);
    }
  }
  return false;
}

test('the bridge is the only way across: the river road needs it', () => {
  const west = map.spawns.find((s) => s.id === 'west');
  assert.ok(west, 'no river-road spawn');
  assert.ok(reachesKeep(west, true), 'the river road cannot reach the keep even over the bridge');
  assert.ok(
    !reachesKeep(west, false),
    'the river road reaches the keep without the bridge: the river and lake leak',
  );
});

test('the eastern forest track reaches the keep without crossing water', () => {
  const east = map.spawns.find((s) => s.id === 'east');
  assert.ok(east, 'no eastern spawn');
  assert.ok(reachesKeep(east, false), 'the forest track is cut off from the keep');
});

test('the river road enters far from the keep, so an attack is seen coming', () => {
  const west = map.spawns.find((s) => s.id === 'west');
  assert.ok(west, 'no river-road spawn');
  const distance = Math.hypot(west.x - map.keep.x, west.z - map.keep.z);
  assert.ok(distance > 20, `the river road starts only ${distance.toFixed(1)} cells from the keep`);
});

test('the bridge spans the river, from dry landing to dry landing', () => {
  const { bridge } = map;
  assert.ok(map.bridgeCells.length >= 9, 'the bridge is too small to cross');
  assert.ok(
    map.bridgeCells.some((i) => isWater((map.kind[i] ?? Kind.GRASS) as Kind)),
    'the bridge crosses no water',
  );
  for (const z of [bridge.from - 1, bridge.to + 1]) {
    assert.equal(heightAt(map, bridge.x, z), map.heights.ground, `landing at row ${z} is not on dry ground`);
    assert.ok(!isWater(kindAt(map, bridge.x, z)), `landing at row ${z} is in the water`);
  }
  for (const i of map.bridgeCells)
    assert.ok((map.height[i] ?? 0) <= map.heights.ground, 'the deck cannot pass through high ground');
});

test('every waterfall face really drops', () => {
  assert.ok(map.waterfall.length > 0, 'the map has no waterfall');
  for (const face of map.waterfall) {
    assert.ok(face.drop >= 1, 'a waterfall face with no drop is just river');
    const below = heightAt(map, face.x + face.dx, face.z + face.dz);
    assert.equal(heightAt(map, face.x, face.z) - below, face.drop);
    assert.ok(isWater(kindAt(map, face.x, face.z)), 'a waterfall lip must be water');
  }
});

test('the river reaches the lake', () => {
  // If the channel stops short, the waterfall pours onto dry land.
  const lakeCells = map.kind.filter((k) => k === Kind.LAKE).length;
  const riverCells = map.kind.filter((k) => k === Kind.RIVER).length;
  assert.ok(riverCells > 40, 'the river is barely there');
  assert.ok(lakeCells > 60, 'the lake is barely there');

  const touchesLake = map.waterfall.some((face) => {
    for (let dz = -2; dz <= 2; dz++)
      for (let dx = -2; dx <= 2; dx++)
        if (kindAt(map, face.x + dx, face.z + dz) === Kind.LAKE) return true;
    return false;
  });
  assert.ok(touchesLake, 'the waterfall does not spill into the lake');
});

test('water surfaces sit above their beds', () => {
  assert.ok(map.water.river > map.heights.riverBed);
  assert.ok(map.water.lake > map.heights.lakeBed);
  assert.ok(map.water.river > map.water.lake, 'the river must stand above the lake it falls into');
});

test('the mine is in rock, and reachable ground lies beside it', () => {
  const oreNearby = (() => {
    for (let dz = -6; dz <= 6; dz++)
      for (let dx = -6; dx <= 6; dx++)
        if (kindAt(map, map.mine.x + dx, map.mine.z + dz) === Kind.ORE) return true;
    return false;
  })();
  assert.ok(oreNearby, 'no ore at the mine');
  assert.ok(index(map, map.mine.x, map.mine.z) < map.size ** 2);
});
