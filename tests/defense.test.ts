// The towers shooting, run in node with no renderer and no attackers: a
// PracticeTargets list stands in for the units P4 will bring. Every rule the
// combat loop leans on is checked here — reach, reload, volleys, sticky aim,
// and who is allowed to shoot at all — so that when real attackers arrive the
// only thing left to get right is how they move.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Build, Kind, type MapData } from '../src/core/map.ts';
import { BUILDING, MACHICOLATIONS } from '../src/data/buildings.ts';
import { Game } from '../src/sim/game.ts';
import { Defenses, PracticeTargets, type Shot } from '../src/sim/defense.ts';

const STEP = 1 / 20;

/** A flat 14x14 of castle ground with the keep at (7, 7). Room to shoot across. */
function testMap(size = 14): MapData {
  const n = size * size;
  return {
    size,
    heights: { ground: 3, riverBed: 2, lakeBed: 0 },
    water: { river: 2.45, lake: 0.45 },
    keep: { x: 7, z: 7 },
    ring: 6,
    mine: { x: 0, z: 0 },
    bridge: { x: 0, from: 0, to: 0, halfWidth: 0 },
    spawns: [],
    riverPath: [],
    bridgeCells: [],
    trees: [],
    waterfall: [],
    height: new Array(n).fill(3),
    kind: new Array(n).fill(Kind.GRASS),
    build: new Array(n).fill(Build.CASTLE | Build.CAMP),
  };
}

interface Field {
  game: Game;
  defenses: Defenses;
  targets: PracticeTargets;
  /** Runs both the building rules and the defences, and returns what was loosed. */
  run(seconds: number): Shot[];
}

function field(tier = 1): Field {
  const game = new Game(testMap());
  const defenses = new Defenses(game);
  const targets = new PracticeTargets();
  const run = (seconds: number): Shot[] => {
    const shots: Shot[] = [];
    for (let i = 0; i < Math.round(seconds / STEP); i++) {
      game.tick(STEP);
      shots.push(...defenses.tick(STEP, targets));
    }
    return shots;
  };

  game.grant({ gold: 1e5, wood: 1e5, stone: 1e5 });
  while (game.tier < tier) {
    game.upgradeKeep();
    run(70);
  }
  return { game, defenses, targets, run };
}

/** A finished tower with its lowest corner at (x, z), taken up to `level`. */
function tower(f: Field, kind: 'wooden-tower' | 'stone-tower', x: number, z: number, level = 1) {
  const built = f.game.place(kind, x, z)!;
  assert.ok(built, `${kind} at ${x},${z}`);
  f.run(BUILDING[kind].buildTime);
  for (let l = 1; l < level; l++) {
    assert.ok(f.game.upgrade(built, 'level'), `upgrade to level ${l + 1}`);
    f.run(BUILDING[kind].levels![l - 1]!.buildTime);
  }
  assert.equal(built.level, level);
  return built;
}

test('a finished tower shoots what comes into reach, and nothing beyond it', () => {
  const f = field();
  // A 2x2 tower at (1, 1) is centred on (1.5, 1.5); the wooden tower reaches 6.
  tower(f, 'wooden-tower', 1, 1);
  const far = f.targets.add(9, 1.5, 500);
  assert.equal(f.run(3).length, 0, 'out of reach by a cell and a half');

  const near = f.targets.add(4, 1.5, 500);
  const shots = f.run(0.05);
  assert.equal(shots.length, 1, 'one shaft the moment something walks in');
  assert.equal(shots[0]!.targetId, near.id);
  assert.equal(shots[0]!.projectile, 'arrow');
  assert.equal(near.hp, 500 - BUILDING['wooden-tower'].attack!.damage);
  assert.equal(far.hp, 500, 'the far one is untouched');
});

test('reload paces the volleys', () => {
  const f = field();
  tower(f, 'wooden-tower', 1, 1);
  const target = f.targets.add(4, 1.5, 5000);
  const reload = BUILDING['wooden-tower'].attack!.reload;

  assert.equal(f.run(0.05).length, 1, 'it opens fire at once');
  assert.equal(f.run(reload - 0.3).length, 0, 'and holds while it reloads');
  assert.equal(f.run(0.6).length, 1, 'then looses again');
  assert.equal(target.hp, 5000 - 2 * BUILDING['wooden-tower'].attack!.damage);
});

test('a tower holds its fire until it stands', () => {
  const f = field();
  const built = f.game.place('wooden-tower', 1, 1)!;
  f.targets.add(4, 1.5, 500);
  const raising = BUILDING['wooden-tower'].buildTime;
  assert.equal(f.run(raising - 2).length, 0, 'a building site has no garrison');
  assert.ok(f.run(4).length > 0, 'once it is up, it shoots');

  // An upgrade leaves the tower standing, so the archers stay at their posts.
  assert.ok(f.game.upgrade(built, 'level'));
  assert.ok(f.run(3).length > 0, 'and it keeps shooting while it is improved');
});

test('every level reaches further and looses more', () => {
  const range1 = BUILDING['wooden-tower'].attack!.range;
  const range3 = BUILDING['wooden-tower'].levels![1]!.attack!.range;
  assert.ok(range3 > range1, 'the catalogue has to grow the reach for this to mean anything');

  const short = field(2);
  tower(short, 'wooden-tower', 1, 1);
  short.targets.add(1.5 + (range1 + range3) / 2, 1.5, 500);
  assert.equal(short.run(3).length, 0, 'level 1 cannot reach that far');

  const tall = field(2);
  tower(tall, 'wooden-tower', 1, 1, 3);
  const target = tall.targets.add(1.5 + (range1 + range3) / 2, 1.5, 500);
  const volley = tall.run(0.05);
  assert.equal(volley.length, BUILDING['wooden-tower'].levels![1]!.attack!.shots, 'a full volley');
  assert.ok(volley.every((s) => s.targetId === target.id));
});

test('a turret holds the target it has, and only takes a new one when it loses it', () => {
  const f = field();
  const built = tower(f, 'wooden-tower', 1, 1);
  const held = f.targets.add(3.5, 1.5, 500);
  const other = f.targets.add(5, 1.5, 500);
  assert.equal(f.run(0.05)[0]!.targetId, held.id, 'the nearest to begin with');

  // The other one walks right up to the wall: aim stays where it was.
  other.x = 2;
  assert.equal(f.run(1.5)[0]!.targetId, held.id, 'it does not swing to whatever is closest');
  assert.equal(f.defenses.targetOf(built), held.id);

  f.targets.hurt(held, held.hp);
  assert.equal(f.run(1.5)[0]!.targetId, other.id, 'it picks a new one once that one is down');
});

test('a volley that finishes its mark carries on to the next, rather than into a corpse', () => {
  const f = field(2);
  tower(f, 'wooden-tower', 1, 1, 3);
  const attack = BUILDING['wooden-tower'].levels![1]!.attack!;
  assert.equal(attack.shots, 2, 'this test needs a tower that looses more than one shaft');

  const dying = f.targets.add(3.5, 1.5, 1);
  const next = f.targets.add(4.5, 1.5, 500);
  const volley = f.run(0.05);
  assert.equal(volley.length, 2);
  assert.equal(volley[0]!.targetId, dying.id);
  assert.equal(volley[0]!.killed, true);
  assert.equal(volley[1]!.targetId, next.id, 'the second shaft goes to someone still standing');
  assert.equal(next.hp, 500 - attack.damage);
  assert.deepEqual([...f.targets.all].map((t) => t.id), [next.id], 'the dead are off the field');
});

test('machicolations turn a wall into a weapon, and a bare wall has none', () => {
  const f = field(3);
  const bare = f.game.place('stone-wall', 1, 1)!;
  f.run(BUILDING['stone-wall'].buildTime);
  f.targets.add(2, 1, 500);
  assert.equal(f.game.attackOf(bare), null);
  assert.equal(f.run(3).length, 0, 'masonry on its own does nothing');

  assert.ok(f.game.upgrade(bare, 'machicolations'));
  f.run(MACHICOLATIONS.buildTime + 1);
  // Longer than one reload, so the window is bound to hold a shot wherever the
  // overhang happened to finish.
  const shots = f.run(MACHICOLATIONS.attack.reload + 0.2);
  assert.ok(shots.length >= 1, 'an overhang drops things on whatever is beneath it');
  assert.equal(shots[0]!.projectile, 'stone', 'what falls through an overhang is a stone');

  // The reach is the length of the drop, not a bowshot.
  f.targets.clear();
  f.targets.add(5, 1, 500);
  assert.equal(f.run(3).length, 0, 'nothing it can drop on');
});

test('camps, moats and the keep never shoot', () => {
  const f = field(2);
  const camp = f.game.place('woodcutter-camp', 1, 1)!;
  const moat = f.game.place('moat', 5, 1)!;
  f.run(20);
  f.targets.add(2, 3, 500);
  f.targets.add(5, 2, 500);
  for (const b of [camp, moat, f.game.keep]) assert.equal(f.game.attackOf(b), null, b.kind);
  assert.equal(f.run(5).length, 0);
});

test('a tower pulled down stops shooting and forgets its aim', () => {
  const f = field();
  const built = tower(f, 'wooden-tower', 1, 1);
  const target = f.targets.add(4, 1.5, 5000);
  assert.equal(f.run(0.05).length, 1);
  assert.equal(f.defenses.targetOf(built), target.id);

  assert.ok(f.game.demolish(built));
  assert.equal(f.run(5).length, 0, 'rubble does not loose arrows');
  assert.equal(f.defenses.targetOf(built), 0, 'and the turret is forgotten');
});
