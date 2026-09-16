// The building rules, run in node against small synthetic maps: placement,
// costs, construction time, upgrades of every kind, cancelling and
// demolishing, moats, and gatehouses.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Build, Kind, type MapData } from '../src/core/map.ts';
import { FixedStep } from '../src/core/fixedstep.ts';
import { BUILDING, KEEP_TIERS, MACHICOLATIONS, STARTING_RESOURCES } from '../src/data/buildings.ts';
import { Game, progressOf } from '../src/sim/game.ts';

const STEP = 1 / 20;

/**
 * A flat 12x12 map: castle ground everywhere except the last two rows, which
 * are woodcutter ground. The keep sits at (5, 5), so it covers 4..6. With
 * `river`, column x = 0 is river, a step below the plain.
 */
function testMap(size = 12, river = false): MapData {
  const n = size * size;
  const build = Array.from({ length: n }, (_, i) =>
    Math.floor(i / size) >= size - 2 ? Build.WOOD_CAMP : Build.CASTLE,
  );
  const kind: number[] = new Array(n).fill(Kind.GRASS);
  const height: number[] = new Array(n).fill(3);
  if (river)
    for (let z = 0; z < size; z++) {
      kind[z * size] = Kind.RIVER;
      height[z * size] = 2;
    }
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
    height,
    kind,
    build,
  };
}

/** Runs the game for a number of seconds at the fixed step. */
function run(game: Game, seconds: number): void {
  for (let i = 0; i < Math.round(seconds / STEP); i++) game.tick(STEP);
}

/** Plenty of everything, and the keep taken up to a tier. */
function reachTier(game: Game, tier: number): void {
  game.grant({ gold: 1e5, wood: 1e5, stone: 1e5 });
  while (game.tier < tier) {
    assert.ok(game.upgradeKeep(), `keep to tier ${game.tier + 1}`);
    run(game, KEEP_TIERS[game.tier]!.buildTime);
  }
}

test('a new game stands a tier-1 keep over its 3x3 footprint, with starting resources', () => {
  const game = new Game(testMap());
  assert.equal(game.tier, 1);
  assert.equal(game.keep.job, null, 'the starting keep is already built');
  for (let z = 4; z <= 6; z++) for (let x = 4; x <= 6; x++) assert.equal(game.buildingAt(x, z), game.keep);
  assert.equal(game.buildingAt(7, 5), undefined);
  assert.deepEqual(game.state.resources, STARTING_RESOURCES);
});

test('placing a palisade spends its cost and lays a foundation on the cell', () => {
  const game = new Game(testMap());
  const wood = game.state.resources.wood;
  const wall = game.place('palisade', 1, 1);
  assert.ok(wall, 'the palisade should fit');
  assert.equal(game.state.resources.wood, wood - (BUILDING.palisade.cost.wood ?? 0));
  assert.equal(game.buildingAt(1, 1), wall);
  assert.equal(wall.job?.type, 'construct');
  assert.equal(progressOf(wall), 0);
  assert.ok(wall.hp < BUILDING.palisade.hp, 'a foundation is not a finished wall');
  assert.deepEqual(
    game.drainEvents().map((e) => e.type),
    ['placed'],
  );
});

test('placement is refused, and nothing changes, when the ground or the rules say no', () => {
  const game = new Game(testMap());
  const before = JSON.stringify(game.state);
  const cases = [
    { id: 'palisade', x: -1, z: 0, problem: 'bounds' },
    { id: 'palisade', x: 5, z: 5, problem: 'occupied' }, // on the keep
    { id: 'palisade', x: 3, z: 11, problem: 'zone' }, // woodcutter ground
    { id: 'stone-wall', x: 1, z: 1, problem: 'locked' }, // needs tier 2
  ] as const;
  for (const { id, x, z, problem } of cases) {
    const check = game.check(id, x, z);
    assert.equal(check.problem, problem, `${id} at ${x},${z}`);
    assert.equal(game.place(id, x, z), null);
  }

  game.state.resources.wood = 5;
  assert.equal(game.check('palisade', 1, 1).problem, 'cost');
  assert.equal(game.place('palisade', 1, 1), null);
  game.state.resources.wood = STARTING_RESOURCES.wood;

  assert.equal(JSON.stringify(game.state), before, 'a refused placement must not touch the state');
  assert.deepEqual(game.drainEvents(), []);
});

test('the check marks exactly which footprint cells are bad', () => {
  const game = new Game(testMap());
  // A 2x2 tower straddling the keep's corner: one of its four cells is taken.
  const check = game.check('wooden-tower', 6, 6);
  assert.equal(check.problem, 'occupied');
  assert.deepEqual(
    check.cells.map((c) => `${c.x},${c.z}:${c.ok}`),
    ['6,6:false', '7,6:true', '6,7:true', '7,7:true'],
  );
});

test('a camp needs its own kind of camp ground under every cell', () => {
  const game = new Game(testMap());
  assert.equal(game.check('woodcutter-camp', 3, 9).problem, 'zone', 'half on castle ground');
  assert.equal(game.check('woodcutter-camp', 3, 10).problem, null, 'wholly on woodcutter ground');
  assert.equal(game.check('miner-camp', 3, 10).problem, 'zone', 'woodcutter ground is not a mine');
});

test('construction takes its build time at the fixed step, and finishes exactly once', () => {
  const game = new Game(testMap());
  const wall = game.place('palisade', 1, 1)!;
  game.drainEvents();

  run(game, BUILDING.palisade.buildTime - STEP);
  assert.ok(wall.job, 'still building one step before the end');
  assert.ok(progressOf(wall) > 0.9 && progressOf(wall) < 1);
  assert.deepEqual(game.drainEvents(), []);

  game.tick(STEP);
  assert.equal(wall.job, null);
  assert.equal(wall.hp, BUILDING.palisade.hp);
  assert.deepEqual(
    game.drainEvents().map((e) => e.type),
    ['completed'],
  );

  run(game, 5);
  assert.deepEqual(game.drainEvents(), [], 'a finished building does not finish again');
});

test('the keep upgrade holds the old tier until done, then unlocks tier-2 buildings', () => {
  const game = new Game(testMap());
  const next = KEEP_TIERS[1]!;
  const [option] = game.upgradesFor(game.keep);
  assert.equal(option?.type, 'tier');
  assert.equal(option?.problem, null);
  assert.ok(game.upgradeKeep());
  assert.equal(game.state.resources.stone, STARTING_RESOURCES.stone - (next.cost.stone ?? 0));

  assert.equal(game.upgradesFor(game.keep)[0]?.problem, 'busy', 'one upgrade at a time');
  assert.equal(game.upgradeKeep(), false);

  run(game, next.buildTime / 2);
  assert.equal(game.tier, 1, 'still the old hall halfway through');
  assert.equal(game.check('stone-wall', 1, 1).problem, 'locked');

  run(game, next.buildTime / 2);
  assert.equal(game.tier, 2);
  assert.equal(game.keep.hp, next.hp);
  assert.equal(game.check('stone-wall', 1, 1).problem, null, 'stone walls unlock at tier 2');
  assert.deepEqual(
    game.drainEvents().map((e) => e.type),
    ['upgrade-started', 'upgraded'],
  );
});

test('the keep cannot go past its last tier', () => {
  const game = new Game(testMap());
  reachTier(game, KEEP_TIERS.length);
  assert.equal(game.tier, KEEP_TIERS.length);
  assert.deepEqual(game.upgradesFor(game.keep), []);
});

test('a palisade is rebuilt in stone where it stands, once the Stone Hall is up', () => {
  const game = new Game(testMap());
  const wall = game.place('palisade', 1, 1)!;
  run(game, BUILDING.palisade.buildTime);
  const rebuild = () => game.upgradesFor(wall).find((o) => o.type === 'rebuild');
  assert.equal(rebuild()?.into.kind, 'stone-wall');
  assert.equal(rebuild()?.problem, 'locked');

  reachTier(game, 2);
  assert.ok(game.upgrade(wall, 'rebuild'));
  assert.equal(wall.kind, 'palisade', 'still timber while the masons work');
  run(game, BUILDING['stone-wall'].buildTime);
  assert.equal(wall.kind, 'stone-wall');
  assert.equal(game.buildingAt(1, 1), wall, 'same spot, same building');
  assert.equal(wall.hp, BUILDING['stone-wall'].hp);
  assert.deepEqual(
    game.upgradesFor(wall).map((o) => [o.type, o.problem]),
    [
      ['rebuild', 'locked'], // reinforced walls wait for the Great Keep
      ['machicolations', 'locked'], // and machicolations for the Tiled Keep
    ],
  );
});

test('a tower grows a level at a time, up to its last', () => {
  const game = new Game(testMap());
  reachTier(game, 2);
  const tower = game.place('wooden-tower', 1, 1)!;
  run(game, BUILDING['wooden-tower'].buildTime);
  const levels = BUILDING['wooden-tower'].levels!;

  for (let level = 2; level <= 1 + levels.length; level++) {
    assert.ok(game.upgrade(tower, 'level'), `to level ${level}`);
    assert.equal(game.upgradesFor(tower)[0]?.problem, 'busy');
    assert.equal(tower.level, level - 1, 'the old level stands meanwhile');
    run(game, levels[level - 2]!.buildTime);
    assert.equal(tower.level, level);
    assert.equal(tower.hp, levels[level - 2]!.hp);
  }
  assert.deepEqual(game.upgradesFor(tower), [], 'nothing past the top level');
});

test('machicolations go on stone walls only, from the Tiled Keep, and survive reinforcement', () => {
  const game = new Game(testMap());
  reachTier(game, 4);
  const timber = game.place('palisade', 1, 1)!;
  const stone = game.place('stone-wall', 2, 1)!;
  run(game, 10);

  assert.ok(!game.upgradesFor(timber).some((o) => o.type === 'machicolations'));
  assert.ok(game.upgrade(stone, 'machicolations'));
  run(game, MACHICOLATIONS.buildTime);
  assert.equal(stone.machicolations, true);
  assert.equal(stone.hp, BUILDING['stone-wall'].hp + MACHICOLATIONS.hp);

  assert.ok(game.upgrade(stone, 'rebuild'));
  run(game, BUILDING['reinforced-wall'].buildTime);
  assert.equal(stone.kind, 'reinforced-wall');
  assert.equal(stone.machicolations, true, 'the machicolations are rebuilt with the wall');
  assert.ok(!game.upgradesFor(stone).some((o) => o.type === 'machicolations'), 'only one set per wall');
});

test('cancelling a construction gives everything back and frees the ground', () => {
  const game = new Game(testMap());
  const before = { ...game.state.resources };
  const tower = game.place('wooden-tower', 1, 1)!;
  run(game, 5);
  game.drainEvents();

  assert.ok(game.cancel(tower));
  assert.deepEqual(game.state.resources, before);
  assert.equal(game.buildingAt(1, 1), undefined);
  assert.equal(game.building(tower.id), undefined);
  assert.equal(game.check('wooden-tower', 1, 1).ok, true);
  assert.deepEqual(
    game.drainEvents().map((e) => e.type),
    ['removed'],
  );
  assert.equal(game.cancel(tower), false, 'nothing left to cancel');
});

test('cancelling an upgrade refunds it and leaves the building as it was', () => {
  const game = new Game(testMap());
  const before = { ...game.state.resources };
  assert.ok(game.upgradeKeep());
  run(game, 10);
  assert.ok(game.cancel(game.keep));
  assert.deepEqual(game.state.resources, before);
  assert.equal(game.keep.job, null);
  run(game, 60);
  assert.equal(game.tier, 1, 'a cancelled upgrade never lands');
});

test('demolishing hands back half the cost; the keep stays, and work must be cancelled first', () => {
  const game = new Game(testMap());
  const wall = game.place('palisade', 1, 1)!;
  assert.equal(game.demolish(wall), false, 'still being built: cancel it instead');
  run(game, BUILDING.palisade.buildTime);

  const wood = game.state.resources.wood;
  assert.ok(game.demolish(wall));
  assert.equal(game.state.resources.wood, wood + Math.floor((BUILDING.palisade.cost.wood ?? 0) / 2));
  assert.equal(game.buildingAt(1, 1), undefined);
  assert.equal(game.demolish(game.keep), false, 'the keep cannot be pulled down');
});

test('a moat can be dug out to the river, fills when it joins it, and drains when cut off', () => {
  const game = new Game(testMap(12, true)); // river down column x = 0
  reachTier(game, 2);

  // Row 10 is woodcutter ground: no castle building goes there, but a moat can.
  assert.equal(game.check('palisade', 1, 10).problem, 'zone');
  assert.equal(game.check('moat', 0, 5).problem, 'zone', 'the river itself is not dug');
  for (const [x, z] of [
    [1, 10],
    [2, 10],
    [3, 10],
    [6, 10],
  ] as const)
    assert.ok(game.place('moat', x, z), `moat at ${x},${z}`);
  assert.equal(game.moatAt(1, 10), null, 'a moat still being dug holds nothing yet');

  run(game, BUILDING.moat.buildTime);
  assert.equal(game.moatAt(1, 10), 'wet', 'beside the river');
  assert.equal(game.moatAt(3, 10), 'wet', 'joined to it through the moat');
  assert.equal(game.moatAt(6, 10), 'dry', 'on its own, away from the water');

  assert.ok(game.demolish(game.buildingAt(2, 10)!));
  assert.equal(game.moatAt(3, 10), 'dry', 'cut off from the river, it drains');
  assert.equal(game.moatAt(1, 10), 'wet');
});

test('a gatehouse starts open, and its drawbridge and portcullis answer the player once built', () => {
  const game = new Game(testMap());
  reachTier(game, 3);
  const gate = game.place('gatehouse', 1, 1)!;
  assert.deepEqual(gate.gate, { bridgeDown: true, portcullisOpen: true });
  assert.equal(game.setGate(gate, 'bridge', false), false, 'not while it is being built');

  run(game, BUILDING.gatehouse.buildTime);
  game.drainEvents();
  assert.ok(game.setGate(gate, 'bridge', false));
  assert.ok(game.setGate(gate, 'portcullis', false));
  assert.deepEqual(gate.gate, { bridgeDown: false, portcullisOpen: false });
  assert.deepEqual(
    game.drainEvents().map((e) => e.type),
    ['gate', 'gate'],
  );
  assert.equal(game.setGate(game.keep, 'bridge', false), false, 'only gatehouses have one');
});

test('a line of wall is every segment of the same kind joined to it', () => {
  const game = new Game(testMap());
  for (const x of [1, 2, 3]) game.place('palisade', x, 1);
  game.place('palisade', 3, 2);
  game.place('palisade', 8, 1); // apart from the rest
  run(game, 5);
  const line = game.lineOf(game.buildingAt(1, 1)!);
  assert.deepEqual(line.map((b) => `${b.x},${b.z}`).sort(), ['1,1', '2,1', '3,1', '3,2']);
});

test('the state survives a JSON round trip, occupancy and work in progress included', () => {
  const map = testMap(12, true);
  const game = new Game(map);
  reachTier(game, 3);
  game.place('wooden-tower', 1, 1, 2);
  game.place('moat', 1, 9);
  game.place('gatehouse', 8, 1);
  run(game, 7);

  const loaded = Game.load(map, JSON.stringify(game.state));
  assert.deepEqual(loaded.state, game.state);
  assert.equal(loaded.buildingAt(1, 1)?.turn, 2, 'a building keeps the way it was turned');
  assert.equal(loaded.buildingAt(2, 2)?.kind, 'wooden-tower', 'occupancy is rebuilt on load');
  assert.equal(loaded.check('palisade', 2, 2).problem, 'occupied');
  assert.equal(loaded.moatAt(1, 9), 'wet', 'moat water is rebuilt on load');
  run(loaded, BUILDING['wooden-tower'].buildTime);
  assert.equal(loaded.buildingAt(1, 1)?.job, null, 'work carries on after loading');
});

test('on the real map, the keep stands on its footprint and the ring around it is buildable', () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const map = JSON.parse(
    fs.readFileSync(path.join(here, '..', 'src', 'data', 'map.json'), 'utf8'),
  ) as MapData;
  const game = new Game(map);
  assert.equal(game.buildingAt(map.keep.x, map.keep.z), game.keep);
  // The four corners of the castle ring all take a palisade.
  for (const [dx, dz] of [
    [-1, -1],
    [1, -1],
    [-1, 1],
    [1, 1],
  ] as const) {
    const x = map.keep.x + dx * map.ring;
    const z = map.keep.z + dz * map.ring;
    assert.equal(game.check('palisade', x, z).problem, null, `ring corner ${x},${z}`);
  }
  // Moats can be dug right beside the river, so a moat run out to it can fill.
  let besideRiver = 0;
  for (let z = 1; z < map.size - 1; z++)
    for (let x = 1; x < map.size - 1; x++) {
      const touches = [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ].some(([dx, dz]) => map.kind[(z + dz!) * map.size + x + dx!] === Kind.RIVER);
      if (touches && game.check('moat', x, z).problem !== 'zone') besideRiver++;
    }
  assert.ok(besideRiver > 10, `only ${besideRiver} diggable cells beside the river`);
});

test('the fixed step turns frame times into equal updates', () => {
  const clock = new FixedStep(STEP);
  let updates = 0;
  for (let frame = 0; frame < 60; frame++) clock.advance(1 / 60, () => updates++);
  assert.equal(updates, 20, 'one second at 60 fps is twenty 20 Hz steps');

  let burst = 0;
  new FixedStep(STEP, 8).advance(10, () => burst++);
  assert.equal(burst, 8, 'a long stall is capped rather than replayed');
});

// --- turning buildings ------------------------------------------------------

test('a building is laid down with the turn it was placed at, and R cycles through four', () => {
  const game = new Game(testMap());
  const barricade = game.place('spiked-barricade', 1, 1, 1);
  assert.ok(barricade);
  assert.equal(barricade.turn, 1);
  assert.equal(game.facingOf(barricade), 90);

  game.rotate(barricade);
  assert.equal(game.facingOf(barricade), 180);
  game.rotate(barricade, 2);
  assert.equal(barricade.turn, 0, 'four quarters come back round');
  game.rotate(barricade, -1);
  assert.equal(barricade.turn, 3, 'and it turns back the other way');
  assert.deepEqual(
    game.drainEvents().map((e) => e.type),
    ['placed', 'rotated', 'rotated', 'rotated'],
  );
});

test('a wall stays turnable once it is joined: the player outranks the wall line', () => {
  // The rule used to be the other way round — a bonded segment took its line
  // from its neighbours and the turn button went away. In the hand that read
  // as the game cancelling the rotation the ghost had just shown, so the
  // player wins now, and only a moat has nothing to turn.
  const game = new Game(testMap());
  reachTier(game, 2);
  const wall = game.place('palisade', 1, 1)!;
  run(game, BUILDING.palisade.buildTime);
  assert.equal(game.rotatable(wall), true, 'a lone segment has only the player to take its line from');

  game.place('palisade', 2, 1);
  run(game, BUILDING.palisade.buildTime);
  assert.equal(game.rotatable(wall), true, 'joined or not, the player may still turn it');
  assert.ok(game.rotate(wall), 'and turning it goes through');
  assert.equal(wall.turn, 1);
  assert.equal(game.facingOf(wall), 90, 'the turn is what the renderer reads');

  const moat = game.place('moat', 9, 9)!;
  assert.equal(game.rotatable(moat), false, 'a moat is a hole in the ground');
});

test('a wall laid down turned carries that turn, so a whole line can be laid across its run', () => {
  const game = new Game(testMap());
  reachTier(game, 2);
  // What dragging a line with R held does: every segment is placed turned.
  for (let x = 1; x <= 4; x++) assert.ok(game.place('palisade', x, 3, 1), `palisade at ${x},3`);
  run(game, BUILDING.palisade.buildTime);
  for (let x = 1; x <= 4; x++) {
    const segment = game.buildingAt(x, 3)!;
    assert.equal(segment.turn, 1, `segment ${x} kept its turn`);
    assert.equal(game.facingOf(segment), 90);
  }
  // And they are still one line as far as the rules go: the whole-line upgrade
  // and the flow field both work off joins, not off which way a piece points.
  assert.equal(game.lineOf(game.buildingAt(1, 3)!).length, 4);
});

test('a gatehouse opens across its wall line, and the player s turns ride on top', () => {
  const game = new Game(testMap());
  reachTier(game, 3);
  // A north-south run of wall west of the keep: the passage crosses it along x,
  // and the far side from the keep is -x.
  for (const z of [4, 6]) game.place('palisade', 2, z);
  const gate = game.place('gatehouse', 2, 5)!;
  run(game, BUILDING.gatehouse.buildTime);
  assert.equal(game.facingOf(gate), 180, 'it opens away from the keep');

  game.rotate(gate);
  assert.equal(game.facingOf(gate), 270, 'a quarter turn on top of that');
  game.rotate(gate, 3);
  assert.equal(game.facingOf(gate), 180, 'and back where it started');

  const east = game.place('gatehouse', 8, 5)!;
  assert.equal(game.facingOf(east), 0, 'on the other side it opens the other way');
});
