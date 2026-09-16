// Plays the whole build loop in a real browser and checks what the player gets:
// a full castle (keep tiers, tower levels, walls rebuilt in stone and
// reinforced, machicolations, a gatehouse, moats wet and dry), how the
// renderer draws it and within what budget, and the interface around it —
// picking a building by its body, working the gate from its panel, the whole
// line upgrade, the two-click demolish, laying walls by dragging, a refused
// placement, and a cancel that refunds everything.
//
// Every assertion here stands for a bug or a trap met while building P2.
//
//   npm run check:build                    (starts Vite if nothing is serving the game)
//   npm run check:build -- --shots=<dir>   also saves a screenshot of each stage
import fs from 'node:fs';
import path from 'node:path';
import { openGame, screenOf, sleep, verdict } from './browser.mjs';

const shotsDir = process.argv.find((a) => a.startsWith('--shots='))?.slice('--shots='.length);
if (shotsDir) fs.mkdirSync(shotsDir, { recursive: true });

const { page, errors, close } = await openGame();
const result = verdict();
const { check } = result;

const shot = async (name) => {
  if (shotsDir) await page.screenshot({ path: path.join(shotsDir, `${name}.png`) });
};
const look = (x, z, zoom) => page.evaluate(({ x, z, zoom }) => window.md.look(x, z, zoom), { x, z, zoom });
const panelTitle = () =>
  page.$eval('#selection', (el) => (el.hidden ? null : (el.querySelector('h2')?.textContent ?? null)));
const kindAt = (x, z) => page.evaluate(({ x, z }) => window.md.game.buildingAt(x, z)?.kind ?? null, { x, z });
const turnAt = (x, z) => page.evaluate(({ x, z }) => window.md.game.buildingAt(x, z)?.turn ?? null, { x, z });
/**
 * How the placement ghost's mass sits along each ground axis. A wall piece
 * fills its cell either way, so a bounding box says nothing: what a quarter
 * turn does is swap where the vertices actually are.
 */
const ghostSpread = () =>
  page.evaluate(() => {
    const ghost = window.md.scene
      .getObjectByName('build-overlay')
      ?.children.find((c) => c.isGroup && c.visible);
    if (!ghost) return null;
    let n = 0;
    let sx = 0;
    let sz = 0;
    ghost.traverse((o) => {
      if (!o.isMesh) return;
      const position = o.geometry.getAttribute('position');
      for (let i = 0; i < position.count; i++) {
        n++;
        sx += Math.abs(position.getX(i));
        sz += Math.abs(position.getZ(i));
      }
    });
    return n ? { x: Number((sx / n).toFixed(3)), z: Number((sz / n).toFixed(3)) } : null;
  });
/**
 * Waits for the renderer to stop moving, and reports the peak seen on the way.
 *
 * A building that has just gone up is animated out of the *instanced* dynamic
 * layer, which costs a draw call per model part; md.advance() finishes whole
 * batches of them in a single frame, so the moment right after a fast-forward
 * is the worst the renderer ever looks. Measuring the budget there says nothing
 * about what the game sustains — and, headless at ~10 fps, whether the
 * measurement lands inside the bounce or after it is pure chance, which made
 * this check flap.
 *
 * "Settled" is read as a draw count that has stopped changing, not as an empty
 * dynamic layer: a gatehouse keeps its drawbridge and its portcullis in that
 * layer for good, so waiting for it to empty would wait for ever.
 *
 * Stability is counted in *rendered frames*, not in samples. `info.render.calls`
 * is whatever the last frame drew, and headless rAF stalls for long stretches:
 * poll on wall-clock alone and a page that has simply stopped rendering looks
 * perfectly stable, so the check settles on the peak and fails. Watching
 * `info.render.frame` makes a sample count only when a frame really went
 * through — which is also why STABLE can stay small.
 */
const STABLE = 8;
const settledDraws = async () => {
  let peak = 0;
  let last = -1;
  let stable = 0;
  let lastFrame = -1;
  for (let i = 0; i < 200; i++) {
    const { draws, frame } = await page.evaluate(() => ({
      draws: window.md.report.drawCalls,
      frame: window.md.renderer.info.render.frame,
    }));
    peak = Math.max(peak, draws);
    if (frame !== lastFrame) {
      lastFrame = frame;
      stable = draws === last ? stable + 1 : 0;
      last = draws;
      if (stable >= STABLE) return { draws, peak };
    }
    await sleep(110);
  }
  return { draws: last, peak };
};

/**
 * Polls a read until it satisfies `ok`, and hands back the last value seen.
 *
 * Headless renders at ~10 fps, so a fixed sleep has never been a wait — and
 * since P3 there is a working economy on the board making the page busier
 * still. Every assertion below that waits on something appearing waits like
 * this instead.
 */
const until = async (read, ok, tries = 40, gap = 120) => {
  let value = await read();
  for (let i = 0; i < tries && !ok(value); i++) {
    await sleep(gap);
    value = await read();
  }
  return value;
};

const clickCell = async (x, z, lift = 0) => {
  const p = await screenOf(page, x, z, lift);
  await page.mouse.move(p.x, p.y);
  await sleep(150);
  await page.mouse.click(p.x, p.y);
  await sleep(350);
};

try {
  // --- 1. the economy: camps hire crews, and the crews bring the map home -------
  // Run first, on open ground: once the castle below is up, the ring of wall
  // and moat is exactly the obstacle P4 is meant to reason about, and that is
  // not what this stage is measuring.
  const economy = await page.evaluate(async () => {
    const { game } = window.md;
    window.md.speed(0);
    game.grant({ gold: 1e5, wood: 1e5, stone: 1e5 });
    // (34, 14) is woodcutter ground at the forest edge; (13, 5) sits at the
    // foot of the ore. Both are a good walk from the keep, which is the point.
    const wood = game.place('woodcutter-camp', 34, 14);
    const mine = game.place('miner-camp', 13, 5);
    window.md.advance(20);
    const crew = window.md.workforce.all.length;

    const before = { ...game.state.resources };
    // Sampled as time goes by rather than once at the end: a single snapshot
    // only ever catches whichever leg of the round the crew happens to be on.
    const seen = new Set();
    for (let i = 0; i < 120; i++) {
      window.md.advance(2);
      for (const worker of window.md.workforce.all) seen.add(worker.phase);
    }
    const after = { ...game.state.resources };
    const carrying = window.md.workforce.all.filter((w) => w.carrying > 0).length;
    const phases = [...seen].sort();

    game.upgrade(wood, 'level');
    window.md.advance(25);
    return {
      placed: !!wood && !!mine,
      crew,
      gainedWood: after.wood - before.wood,
      gainedStone: after.stone - before.stone,
      felled: game.state.felled.length,
      phases,
      carrying,
      upgraded: window.md.workforce.all.filter((w) => w.campId === wood.id).length,
    };
  });
  check('two camps stand and hire their crews', economy.placed && economy.crew === 4, `${economy.crew} workers`);
  check('woodcutters bring wood home', economy.gainedWood > 0, `+${economy.gainedWood} wood`);
  check('miners bring stone home', economy.gainedStone > 0, `+${economy.gainedStone} stone`);
  check('the wood is actually felled', economy.felled > 0, `${economy.felled} stumps`);
  check(
    'the crew walks the whole round: out, working, back to camp, unloaded',
    ['harvest', 'toCamp', 'toNode', 'unload'].every((phase) => economy.phases.includes(phase)),
    economy.phases.join(','),
  );
  check('and a worker on its way home is carrying something', economy.carrying > 0, `${economy.carrying} laden`);
  check('an upgraded camp puts another body on the ground', economy.upgraded === 3, `${economy.upgraded} woodcutters`);

  // The renderer has to show all of that, not just count it.
  const crews = await page.evaluate(() => {
    const read = (name) => {
      const mesh = window.md.scene.getObjectByName(name);
      return mesh ? { visible: mesh.visible, count: mesh.count } : null;
    };
    return { wood: read('workers-wood'), stone: read('workers-stone'), loads: read('worker-loads') };
  });
  check(
    'the workers are on screen, one instanced mesh per trade',
    crews.wood?.visible === true && crews.wood.count === 3 && crews.stone?.visible === true && crews.stone.count === 2,
    `${crews.wood?.count} woodcutters, ${crews.stone?.count} miners`,
  );

  // A felled tree is hidden the same way a prop under a building is: a
  // zero-scale matrix in its instanced field. So the stumps the simulation
  // holds and the trunks the scatter has taken away must be the same number.
  const stumps = await page.evaluate(() => {
    const scatter = window.md.scene.getObjectByName('scatter');
    let hidden = 0;
    scatter.traverse((o) => {
      if (!o.isInstancedMesh) return;
      const a = o.instanceMatrix.array;
      for (let i = 0; i < o.count; i++)
        if (a[i * 16] === 0 && a[i * 16 + 5] === 0 && a[i * 16 + 10] === 0) hidden++;
    });
    return { hidden, felled: window.md.game.state.felled.length, standing: window.md.report.standingTrees };
  });
  check(
    'every stump the simulation holds is a trunk the scatter has taken away',
    stumps.hidden >= stumps.felled && stumps.felled > 0,
    `${stumps.felled} stumps, ${stumps.hidden} props hidden`,
  );
  check(
    'and the rest of the wood is still standing',
    stumps.standing === 140 - stumps.felled,
    `${stumps.standing} trees left`,
  );

  await look(34, 14, 16);
  await sleep(500);
  await shot('camp');
  await page.evaluate(() => window.md.frameMap());

  // --- 2. a full castle, laid out through the game API with time frozen -------
  const terrainBefore = await page.evaluate(() => window.md.report.terrainTriangles);
  const castle = await page.evaluate(() => {
    const { game, map } = window.md;
    window.md.speed(0);
    game.grant({ gold: 1e5, wood: 1e5, stone: 1e5 });
    while (game.tier < 4 && game.upgradeKeep()) window.md.advance(70);

    const { x: kx, z: kz } = map.keep;
    const r = 5;
    for (let d = -r; d <= r; d++)
      for (const [x, z] of [
        [kx + d, kz - r],
        [kx + d, kz + r],
        [kx - r, kz + d],
        [kx + r, kz + d],
      ]) {
        if (x === kx - r && z === kz) game.place('gatehouse', x, z);
        else game.place('palisade', x, z);
      }
    // A moat from the gate's doorstep out to the river, and a stretch on its own.
    const westMoat = [];
    for (let x = kx - r - 1; x >= 0; x--) {
      if (!game.place('moat', x, kz)) break;
      westMoat.push(x);
    }
    const eastMoat = [];
    for (let z = kz - 2; z <= kz + 2; z++) if (game.place('moat', kx + r + 2, z)) eastMoat.push(z);
    const wooden = [-4, -1, 2].map((dx) => game.place('wooden-tower', kx + dx, kz + r + 2));
    const stone = [-4, -1, 2].map((dx) => game.place('stone-tower', kx + dx, kz - r - 3));
    window.md.advance(40);

    for (const row of [wooden, stone])
      row.forEach((tower, i) => {
        for (let level = 0; level < i; level++) {
          game.upgrade(tower, 'level');
          window.md.advance(60);
        }
      });

    // North wall in stone, east wall reinforced, both with machicolations.
    const north = [];
    const east = [];
    for (let d = -r; d <= r; d++) {
      north.push(game.buildingAt(kx + d, kz - r));
      east.push(game.buildingAt(kx + r, kz + d));
    }
    for (const segment of [...north, ...east]) game.upgrade(segment, 'rebuild');
    window.md.advance(20);
    for (const segment of east) game.upgrade(segment, 'rebuild');
    window.md.advance(20);
    for (const segment of [...north, ...east]) game.upgrade(segment, 'machicolations');
    window.md.advance(20);
    window.md.speed(1);

    const describe = (b) => `${b.kind}${b.machicolations ? '+m' : ''}`;
    return {
      kx,
      kz,
      r,
      tier: game.tier,
      westMoat: westMoat.length,
      westWet: westMoat.filter((x) => game.moatAt(x, kz) === 'wet').length,
      eastMoat: eastMoat.map((z) => game.moatAt(kx + r + 2, z)),
      towerLevels: [...wooden, ...stone].map((t) => t?.level ?? 0),
      north: north.map(describe),
      east: east.map(describe),
      busy: game.state.buildings.filter((b) => b.job).length,
    };
  });
  const { kx, kz, r } = castle;

  check('the keep reaches its last tier', castle.tier === 4, `tier ${castle.tier}`);
  check('a moat dug out to the river fills with water', castle.westMoat >= 6 && castle.westWet === castle.westMoat, `${castle.westWet}/${castle.westMoat} wet`);
  check('a moat cut off from the river stays dry', castle.eastMoat.length === 5 && castle.eastMoat.every((s) => s === 'dry'), castle.eastMoat.join(','));
  check('towers grow a level at a time', castle.towerLevels.join(',') === '1,2,3,1,2,3', castle.towerLevels.join(','));
  check('walls rebuilt in stone carry machicolations', castle.north.every((s) => s.endsWith('+m')), castle.north.join(','));
  check('reinforced walls keep their machicolations', castle.east.every((s) => s === 'reinforced-wall+m'), castle.east.join(','));
  check('all the work is finished', castle.busy === 0, `${castle.busy} still busy`);

  // --- 3. what the renderer made of it ------------------------------------------
  await look(kx, kz, 24);
  await sleep(1500);
  await shot('castle');
  // Settle first: while a batch of buildings is still bouncing they crowd the
  // dynamic layer, and what is left in it once they are gone — the gate's own
  // moving parts — is exactly what the next assertion is about.
  const castleDraws = await settledDraws();
  const render = await page.evaluate(() => {
    const { scene, report } = window.md;
    const materials = new Set();
    scene.getObjectByName('dynamic')?.traverse((o) => {
      if (o.isInstancedMesh && o.count > 0) materials.add(o.material?.name ?? '');
    });
    return { terrain: report.terrainTriangles, materials: [...materials] };
  });
  check('moats are dug into the terrain', render.terrain > terrainBefore, `${terrainBefore} -> ${render.terrain} triangles`);
  check('drawbridge and portcullis are animated parts', render.materials.includes('drawbridge') && render.materials.includes('portcullis'), render.materials.join(','));
  check(
    'a full castle stays under the draw-call budget',
    castleDraws.draws <= 80,
    `${castleDraws.draws} draws, peaking at ${castleDraws.peak} while the last batch settled`,
  );

  // --- 4. the gatehouse, picked by its body and worked from its panel -----------
  // Everything from here to the defences is about the interface, so the clock
  // stops: the camps above are delivering every few seconds, and a refund or a
  // stock read taken while a load comes home is not measuring what it says it
  // is. The workers stay on the board, and so stay in the draw calls.
  await page.evaluate(() => window.md.speed(0));
  await look(kx - 7, kz, 10);
  await sleep(600);
  await clickCell(kx - r, kz, 0.5);
  const gateTitle = await panelTitle();
  check('clicking a building high on its body selects that building', gateTitle === 'Gatehouse', String(gateTitle));
  await page.click('#selection [data-action="bridge"]');
  await sleep(150);
  await page.click('#selection [data-action="portcullis"]');
  await sleep(150);
  const gate = await page.evaluate(({ x, z }) => window.md.game.buildingAt(x, z)?.gate ?? null, { x: kx - r, z: kz });
  check('its panel raises the drawbridge and drops the portcullis', !!gate && !gate.bridgeDown && !gate.portcullisOpen, JSON.stringify(gate));
  if (shotsDir) {
    // The gate opens onto the far side from the default camera: turn to see it.
    await page.keyboard.press('KeyE');
    await page.keyboard.press('KeyE');
    await look(kx - r - 1, kz, 7);
    await sleep(2600);
    await shot('gate-closed-outside');
    await page.keyboard.press('KeyQ');
    await page.keyboard.press('KeyQ');
  }
  await page.keyboard.press('Escape');

  // --- 5. a palisade's panel: the whole line, then a confirmed demolish ---------
  await look(kx, kz + 3, 16);
  await sleep(500);
  await clickCell(kx + 2, kz + r, 0.6);
  const wallTitle = await panelTitle();
  check('a palisade opens its own panel', wallTitle === 'Palisade', String(wallTitle));
  const line = await page.$eval('#selection', (el) => el.querySelector('.line')?.textContent ?? '');
  check('a wall offers to upgrade its whole line', /Whole line ×\d+/.test(line), line || 'no button');
  await shot('panel');

  const wood = await page.evaluate(() => window.md.game.state.resources.wood);
  await page.click('#selection [data-action="demolish"]');
  const armed = await until(
    () => page.$eval('#selection [data-action="demolish"]', (el) => el.textContent),
    (text) => text === 'Click again to demolish',
  );
  check('the first demolish click only asks for confirmation', armed === 'Click again to demolish' && (await kindAt(kx + 2, kz + r)) === 'palisade', String(armed));
  await page.click('#selection [data-action="demolish"]');
  const gone = await until(() => kindAt(kx + 2, kz + r), (kind) => kind === null);
  const refund = (await page.evaluate(() => window.md.game.state.resources.wood)) - wood;
  check('the second click pulls down that very segment for half its cost', gone === null && refund === 5, `refund ${refund}`);

  // --- 6. laying walls by dragging, and a refused placement ---------------------
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  await look(kx - 2, kz + 3, 14);
  await sleep(400);
  await page.keyboard.press('Digit1'); // Palisade
  const cells = [
    [kx - 3, kz + 3],
    [kx - 2, kz + 3],
    [kx - 1, kz + 3],
  ];
  let p = await screenOf(page, cells[0][0], cells[0][1]);
  await page.mouse.move(p.x, p.y);
  await sleep(200);
  await page.mouse.down();
  for (const [x, z] of cells.slice(1)) {
    p = await screenOf(page, x, z);
    await page.mouse.move(p.x, p.y, { steps: 5 });
  }
  await page.mouse.up();
  await page.keyboard.press('Escape');
  const laid = await until(
    async () => Promise.all(cells.map(([x, z]) => kindAt(x, z))),
    (kinds) => kinds.every((k) => k === 'palisade'),
  );
  check('dragging lays a line of palisade', laid.every((k) => k === 'palisade'), laid.join(','));

  await page.keyboard.press('Digit6'); // Wooden Tower
  await clickCell(kx, kz);
  const toast = await until(
    () => page.$eval('#toast', (el) => el.textContent),
    (text) => text === 'Something already stands there.',
  );
  check('building onto the keep is refused, with the reason', toast === 'Something already stands there.', String(toast));
  await page.keyboard.press('Escape');

  // --- 7. turning a building, on the ghost and once it stands -------------------
  // Out in the open, well clear of the walls and towers: a lone segment has
  // nothing to take its line from, which is exactly when turning it matters.
  const lx = kx + 8;
  const lz = kz + 8;
  await page.keyboard.press('Escape');
  await look(lx, lz, 13);
  await sleep(800);
  await page.keyboard.press('Digit1'); // Palisade
  const ghostAt = await screenOf(page, lx, lz);
  await page.mouse.move(ghostAt.x, ghostAt.y);
  await sleep(500);
  const flat = await until(ghostSpread, (spread) => spread !== null);
  await page.keyboard.press('KeyR');
  // The ghost's geometry is rebuilt asynchronously, so wait for the mass to
  // have actually moved onto the other axis rather than for a fixed 700 ms.
  const turnedGhost = await until(
    ghostSpread,
    (spread) => !!spread && !!flat && Math.abs(spread.x - flat.z) < 0.01,
  );
  check(
    'R swings the ghost of a wall onto the other axis',
    !!flat && !!turnedGhost && Math.abs(flat.x - turnedGhost.z) < 0.01 && Math.abs(flat.z - turnedGhost.x) < 0.01 && flat.x !== flat.z,
    `${JSON.stringify(flat)} -> ${JSON.stringify(turnedGhost)}`,
  );

  await page.mouse.move(ghostAt.x, ghostAt.y);
  await sleep(150);
  await page.mouse.click(ghostAt.x, ghostAt.y);
  const laidTurn = await until(() => turnAt(lx, lz), (turn) => turn === 1);
  check('a wall is laid down facing the way the ghost showed', laidTurn === 1, String(laidTurn));
  await page.keyboard.press('Escape');

  await page.evaluate(() => window.md.advance(6));
  await clickCell(lx, lz, 0.4);
  check('a lone wall opens its panel with a way to turn it', await page.$eval('#selection', (el) => !el.hidden && !!el.querySelector('[data-action="rotate"]')), String(await panelTitle()));
  await page.click('#selection [data-action="rotate"]');
  const panelTurn = await until(() => turnAt(lx, lz), (turn) => turn === 2);
  check('the panel turns it another quarter', panelTurn === 2, String(panelTurn));
  await shot('rotate');

  // Bonding a neighbour on must not undo the turn the player gave it: that was
  // the bug where laying a line quietly cancelled the rotation the ghost showed.
  const joined = await page.evaluate(({ x, z }) => {
    const { game } = window.md;
    game.place('palisade', x + 1, z);
    window.md.advance(6);
    const wall = game.buildingAt(x, z);
    return { rotatable: game.rotatable(wall), turn: wall.turn, facing: game.facingOf(wall) };
  }, { x: lx, z: lz });
  check(
    'a wall keeps the turn the player gave it once a neighbour bonds onto it',
    joined.rotatable === true && joined.turn === 2 && joined.facing === 180,
    `turn ${joined.turn}, facing ${joined.facing}`,
  );
  await page.keyboard.press('Escape');

  // And the ghost has to show which of the two the player is about to get.
  // Untouched, it must take its line from the wall it is going to bond with —
  // it used to be built against no neighbours at all, so it drew the catalogue
  // piece and the wall that landed came out on the other axis. That gap is the
  // whole "laying a line cancels the rotation" bug.
  const bx = kx - 8;
  const bz = kz + 8;
  await page.evaluate(({ x, z }) => {
    window.md.game.place('palisade', x, z - 1);
    window.md.advance(6);
  }, { x: bx, z: bz });
  await look(bx, bz, 13);
  await sleep(600);
  await page.keyboard.press('Digit1');
  const bondAt = await screenOf(page, bx, bz);
  await page.mouse.move(bondAt.x, bondAt.y);
  const bonded = await until(ghostSpread, (spread) => !!spread && spread.x > spread.z);
  check(
    'the ghost takes its line from the neighbour it is about to bond with',
    !!bonded && !!flat && Math.abs(bonded.x - flat.z) < 0.01 && Math.abs(bonded.z - flat.x) < 0.01,
    `alone ${JSON.stringify(flat)} -> beside a wall ${JSON.stringify(bonded)}`,
  );
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');

  // --- 8. the defences: towers shooting at a practice target --------------------
  const battle = await page.evaluate(({ x, z }) => {
    const { game } = window.md;
    window.md.speed(0);
    const mark = window.md.dummy(x, z, 600);
    window.md.advance(2);
    const early = mark.hp;
    window.md.advance(30);
    return { early, hp: mark.hp, left: window.md.targets.all.length, towers: game.state.buildings.filter((b) => game.attackOf(b)).length };
  }, { x: kx - 0.5, z: kz + r + 5 });
  check('the castle has manned defences', battle.towers >= 6, `${battle.towers} armed buildings`);
  check('towers shoot at whatever walks into range', battle.early < 600 && battle.early > 0, `${600 - battle.early} damage in two seconds`);
  check('and they finish it off', battle.left === 0 && battle.hp === 0, `${battle.left} left on the field, ${battle.hp} hp`);

  // Now at playing speed, with a target tough enough to stand there and be shot
  // at while the renderer is watched. The volley from the fast-forward above has
  // to land first, or a leftover shaft would answer for the new ones.
  await look(kx, kz + 7, 15);

  // Headless renders at about 10 fps, so give each state a few frames to show up.
  const settle = async (read) => {
    let value = null;
    for (let i = 0; i < 40; i++) {
      value = await page.evaluate(read);
      if (value) return value;
      await sleep(80);
    }
    return value;
  };

  // The volley from the fast-forward above has to land first, or a leftover
  // shaft would answer for the new ones.
  const idle = await settle(() => window.md.scene.getObjectByName('projectiles')?.visible === false);
  await page.evaluate(({ x, z }) => {
    window.md.speed(1);
    window.md.dummy(x, z, 8000);
  }, { x: kx - 0.5, z: kz + r + 5 });
  const marks = await settle(() => window.md.scene.getObjectByName('practice-targets')?.count ?? 0);
  const inFlight = await settle(() => window.md.scene.getObjectByName('projectiles')?.visible === true);
  const draws = (await settledDraws()).draws;
  check('the pool stops drawing once every shaft has landed', idle === true);
  check('the practice target is on the field', marks === 1, `${marks} markers`);
  check('shafts are drawn on their way', inFlight === true);
  check('a battle in progress stays under the draw-call budget', draws <= 80, `${draws} draws`);
  await shot('towers');
  await page.evaluate(() => window.md.targets.clear());

  // --- 9. cancelling gives everything back --------------------------------------
  const refunded = await page.evaluate(() => {
    const { game, map } = window.md;
    const before = JSON.stringify(game.state.resources);
    const tower = game.place('wooden-tower', map.keep.x + 3, map.keep.z + 2);
    if (!tower) return false;
    game.cancel(tower);
    return JSON.stringify(game.state.resources) === before && !game.buildingAt(map.keep.x + 3, map.keep.z + 2);
  });
  check('cancelling a construction refunds it in full and frees the ground', refunded);

  await page.evaluate(() => window.md.frameMap());
  await sleep(600);
  await shot('map');
} catch (err) {
  check('the check ran to the end', false, err.message);
}

check('no console errors, page errors or failed requests', errors.length === 0, [...new Set(errors)].slice(0, 5).join(' | '));
await close();
process.exit(result.failures ? 1 : 0);
