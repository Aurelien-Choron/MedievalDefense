// Checks the camera controls in a real browser by watching where the keep lands
// on screen: every pan key moves the view the way its arrow says, a drag keeps
// the ground under the pointer to the pixel, the wheel zooms about the cursor,
// rotating keeps directions right, and the opening view shows the whole map.
//
// Written after the first camera shipped with every direction turned a quarter.
//
//   npm run check:controls        (starts Vite if nothing is serving the game)
import { HEIGHT, WIDTH, openGame, sleep, verdict } from './browser.mjs';

const { page, errors, close } = await openGame();
const result = verdict();
const { check } = result;

/** The keep's centre on screen. */
const keepOnScreen = () =>
  page.evaluate(
    ({ width, height }) => {
      const { camera, map } = window.md;
      camera.camera.updateMatrixWorld();
      const v = camera.target
        .clone()
        .set(map.keep.x - map.size / 2 + 0.5, map.heights.ground, map.keep.z - map.size / 2 + 0.5)
        .project(camera.camera);
      return { x: ((v.x + 1) / 2) * width, y: ((1 - v.y) / 2) * height };
    },
    { width: WIDTH, height: HEIGHT },
  );
const closeUp = () =>
  page.evaluate(() => {
    window.md.frameMap();
    window.md.frame(0, 0, 30);
  });
const fmt = (p) => `${p.x.toFixed(0)},${p.y.toFixed(0)}`;

try {
  // Keys: a key that pans the camera one way moves the scene the other way.
  // Physical codes, so KeyW is Z and KeyA is Q on an AZERTY keyboard.
  const expected = {
    ArrowUp: [0, 1],
    ArrowDown: [0, -1],
    ArrowLeft: [1, 0],
    ArrowRight: [-1, 0],
    KeyW: [0, 1],
    KeyS: [0, -1],
    KeyA: [1, 0],
    KeyD: [-1, 0],
  };
  for (const [code, [ex, ey]] of Object.entries(expected)) {
    await closeUp();
    const before = await keepOnScreen();
    await page.keyboard.down(code);
    await sleep(500);
    await page.keyboard.up(code);
    const after = await keepOnScreen();
    const dx = after.x - before.x;
    const dy = after.y - before.y;
    const moved = Math.hypot(dx, dy);
    const cos = moved > 0 ? (dx * ex + dy * ey) / moved : 0;
    check(`key ${code} pans the right way`, moved > 20 && cos > 0.96, `${fmt(before)} -> ${fmt(after)}`);
  }

  // Drag: the ground under the pointer follows it exactly.
  await closeUp();
  {
    const before = await keepOnScreen();
    await page.mouse.move(800, 500);
    await page.mouse.down();
    for (let i = 1; i <= 10; i++) await page.mouse.move(800 + 15 * i, 500 + 9 * i);
    await page.mouse.up();
    const after = await keepOnScreen();
    const dx = after.x - before.x;
    const dy = after.y - before.y;
    check('a drag keeps the ground under the pointer', Math.abs(dx - 150) < 4 && Math.abs(dy - 90) < 4, `moved ${dx.toFixed(1)},${dy.toFixed(1)} for 150,90`);
  }

  // Wheel: zooming in holds the point under the cursor.
  await closeUp();
  {
    const before = await keepOnScreen();
    await page.mouse.move(before.x, before.y);
    const zoomBefore = await page.evaluate(() => window.md.camera.zoom);
    await page.mouse.wheel({ deltaY: -100 });
    await sleep(200);
    const after = await keepOnScreen();
    const zoomAfter = await page.evaluate(() => window.md.camera.zoom);
    check('wheel up zooms in', zoomAfter < zoomBefore, `${zoomBefore.toFixed(1)} -> ${zoomAfter.toFixed(1)}`);
    check('the zoom holds the point under the cursor', Math.hypot(after.x - before.x, after.y - before.y) < 3, `${fmt(before)} -> ${fmt(after)}`);
  }

  // Rotation: after a quarter turn, right still pans right.
  await closeUp();
  await page.keyboard.press('KeyE');
  {
    const before = await keepOnScreen();
    await page.keyboard.down('ArrowRight');
    await sleep(500);
    await page.keyboard.up('ArrowRight');
    const after = await keepOnScreen();
    const dx = after.x - before.x;
    const dy = after.y - before.y;
    check('after rotating, right still pans right', -dx / Math.hypot(dx, dy) > 0.96, `${fmt(before)} -> ${fmt(after)}`);
  }
  await page.keyboard.press('KeyQ');

  // The opening view shows the whole map: all four ground corners on screen.
  await page.evaluate(() => window.md.frameMap());
  const corners = await page.evaluate(
    ({ width, height }) => {
      const { camera, map } = window.md;
      camera.camera.updateMatrixWorld();
      const half = map.size / 2;
      return [
        [-half, -half],
        [half, -half],
        [half, half],
        [-half, half],
      ].map(([x, z]) => {
        const v = camera.target.clone().set(x, map.heights.ground, z).project(camera.camera);
        return { x: ((v.x + 1) / 2) * width, y: ((1 - v.y) / 2) * height };
      });
    },
    { width: WIDTH, height: HEIGHT },
  );
  check(
    'the whole map fits the opening view',
    corners.every((c) => c.x >= 0 && c.x <= WIDTH && c.y >= 0 && c.y <= HEIGHT),
    corners.map(fmt).join(' '),
  );
} catch (err) {
  check('the check ran to the end', false, err.message);
}

check('no console errors, page errors or failed requests', errors.length === 0, [...new Set(errors)].slice(0, 5).join(' | '));
await close();
process.exit(result.failures ? 1 : 0);
