import * as THREE from 'three';
import { IsoCamera, controlsHint } from './render/camera.js';
import { describeMaterials, materialCount } from './render/assets.js';
import { buildTerrain, TERRAIN_BASE } from './render/terrain.js';
import { buildWater } from './render/water.js';
import { buildScatter } from './render/scatter.js';
import { buildLandmarks } from './render/landmarks.js';
import { retroEnabled } from './render/retro.js';
import { BuildRenderer } from './render/buildRenderer.js';
import { BuildOverlay } from './render/buildOverlay.js';
import { footprintCentre, muzzleOf, previewPieces } from './render/buildingVisuals.js';
import { renderIcons } from './render/icons.js';
import { Dust } from './render/fx.js';
import { Projectiles } from './render/projectiles.js';
import { TargetMarkers } from './render/targets.js';
import { WorkerFigures } from './render/workers.js';
import { cellToWorldX, cellToWorldZ } from './core/grid.js';
import { FixedStep } from './core/fixedstep.js';
import type { MapData } from './core/map.js';
import { BUILDINGS, KEEP_TIERS, RESOURCES, type Cost } from './data/buildings.js';
import { Game } from './sim/game.js';
import { Defenses, PracticeTargets } from './sim/defense.js';
import { Workforce } from './sim/workers.js';
import { BuildController } from './ui/buildController.js';
import { BuildMenu } from './ui/buildMenu.js';
import { ProgressBars } from './ui/progressBars.js';
import { SelectionPanel } from './ui/selection.js';
import mapJson from './data/map.json';
import manifest from './data/asset-manifest.json';

/**
 * Boot: the map, the game state and its buildings, the build interface, and
 * the loop that ties them together.
 */

const map = mapJson as unknown as MapData;

/** The simulation's fixed rate. */
const SIM_HZ = 20;

const $ = <T extends HTMLElement>(sel: string): T => {
  const el = document.querySelector<T>(sel);
  if (!el) throw new Error(`missing element ${sel}`);
  return el;
};

async function boot(): Promise<void> {
  const bar = $<HTMLElement>('#boot-bar');
  const msg = $<HTMLElement>('#boot-msg');
  const step = (label: string, progress: number): void => {
    msg.textContent = label;
    bar.style.width = `${Math.round(progress * 100)}%`;
  };

  // --- renderer -------------------------------------------------------------
  const renderer = new THREE.WebGLRenderer({
    antialias: true,
    alpha: true,
    powerPreference: 'high-performance',
  });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.setSize(innerWidth, innerHeight);
  // Transparent: the sky is a CSS gradient behind the canvas (index.html). The
  // whole board is on screen, so there is no far edge left for fog to hide.
  renderer.setClearColor(0x000000, 0);
  document.body.prepend(renderer.domElement);
  addEventListener('resize', () => renderer.setSize(innerWidth, innerHeight));

  const scene = new THREE.Scene();

  // three.js dropped its implicit x PI light scaling (r155): a Lambert surface
  // under a light of intensity 1 renders at albedo / PI. These values put a
  // sunlit top face at about its albedo, east-facing sides near 0.75 and
  // south-facing near 0.65 — the three-tone shading that makes isometric shapes
  // read at a glance, while the colours stay the ones picked in the palettes.
  scene.add(new THREE.HemisphereLight(0xdff1ff, 0x8a7a5c, 1.6));
  // The sun sits on the camera's side of the map; lighting from behind would
  // leave every face the isometric view can actually see in shadow.
  const sun = new THREE.DirectionalLight(0xfff0d6, 2.0);
  sun.position.set(60, 90, 40);
  scene.add(sun);
  // Only matters once the view is rotated to face the far sides.
  const fill = new THREE.DirectionalLight(0xb8c8e8, 0.6);
  fill.position.set(-50, 40, -40);
  scene.add(fill);

  // --- world ----------------------------------------------------------------
  step('Raising the land…', 0.1);
  const terrain = buildTerrain(map);
  scene.add(terrain.mesh);

  step('Letting the river run…', 0.25);
  const water = buildWater(map);
  scene.add(water.group);

  step('Planting the forest…', 0.4);
  const scatter = await buildScatter(map);
  scene.add(scatter.group);

  step('Bridging the river…', 0.55);
  const landmarks = await buildLandmarks(map);
  scene.add(landmarks.group);

  // --- the game -------------------------------------------------------------
  step('Raising the keep…', 0.7);
  const game = new Game(map);
  const dust = new Dust();
  scene.add(dust.mesh);
  const builds = new BuildRenderer(game, dust);
  scene.add(builds.group);
  const overlay = new BuildOverlay(game);
  scene.add(overlay.group);
  await builds.ready;

  // The defences, ready for P4's attackers. Until then the only thing they can
  // shoot at is a practice target dropped from the console with md.dummy().
  const defenses = new Defenses(game);
  const targets = new PracticeTargets();
  const arrows = new Projectiles();
  scene.add(arrows.mesh);
  const marks = new TargetMarkers(map.heights.ground);
  scene.add(marks.mesh);

  // The economy: camps hire their crews, the crews walk the map. The walking
  // grid it builds is the one P4's attackers will read their direction from.
  const workforce = new Workforce(game);
  const figures = new WorkerFigures(map.heights.ground);
  scene.add(figures.group);

  /**
   * One simulation step: the building rules, then the defences. Everything
   * that moves time forward goes through here — the fixed step in the loop and
   * md.advance() alike — so a fast-forward shoots exactly as play does.
   */
  const simStep = (seconds: number): void => {
    game.tick(seconds);
    workforce.tick(seconds);
    for (const shot of defenses.tick(seconds, targets)) {
      const b = game.building(shot.buildingId);
      if (!b) continue;
      const [mx, mz] = footprintCentre(b.x, b.z, b.size);
      arrows.fire(
        mx,
        map.heights.ground + muzzleOf(b.kind, b.level),
        mz,
        cellToWorldX(shot.x),
        map.heights.ground + 0.5,
        cellToWorldZ(shot.z),
        shot.projectile,
      );
    }
  };

  // The ground answers the buildings on it: props underneath are hidden, moat
  // is dug into the terrain, and flooded moat joins the river's surface. Only
  // rebuilt when the dug or flooded cells actually change.
  let groundShown = '';
  const syncGround = (): void => {
    const covered = new Set<number>();
    const dug: number[] = [];
    for (const b of game.state.buildings)
      for (let dz = 0; dz < b.size; dz++)
        for (let dx = 0; dx < b.size; dx++) {
          const cell = (b.z + dz) * map.size + b.x + dx;
          covered.add(cell);
          if (b.kind === 'moat') dug.push(cell);
        }
    // A felled tree hides exactly the way a prop under a building does, so
    // there is one mechanism rather than two: the renderer keeps no books of
    // its own about the wood — src/sim/forest.ts does. setHidden runs on every
    // call, above the guard below, so the wood needs nothing of that guard:
    // putting the stump count in it would re-cut the terrain and the moat water
    // every time a tree came down, several times a minute, for nothing.
    for (const stump of game.state.felled) covered.add(stump.cell);
    scatter.setHidden(covered);
    const shown = `${dug.sort((a, b) => a - b).join(',')}|${[...game.wetMoats].sort((a, b) => a - b).join(',')}`;
    if (shown === groundShown) return;
    groundShown = shown;
    terrain.setDug(new Set(dug));
    water.setMoats(game.wetMoats);
  };
  syncGround();

  step('Painting the banners…', 0.9);
  const icons = await renderIcons(renderer, [
    ...BUILDINGS.map((def) => ({ key: def.id, pieces: previewPieces(def.id, 1, 0, 0, 0) })),
    ...KEEP_TIERS.map((t) => ({ key: `keep-${t.tier}`, pieces: previewPieces('keep', t.tier, 0, 0, 0) })),
  ]);

  // --- camera and interface -------------------------------------------------
  step('Ready', 1);
  const camera = new IsoCamera(renderer.domElement, {
    ground: map.heights.ground,
    above: Math.max(...map.height) - map.heights.ground,
    below: map.heights.ground - TERRAIN_BASE,
  });
  camera.frameMap();

  const selection = new SelectionPanel($('#selection'), game, icons);
  const menu = new BuildMenu($('#build-menu'), game, icons, (id) => controller.pick(id));
  const controller = new BuildController({ game, camera, dom: renderer.domElement, overlay, menu, selection });
  const bars = new ProgressBars($('#bars'), game);

  $('#boot').remove();
  for (const id of ['#res', '#perf', '#keys']) $(id).hidden = false;
  void controlsHint().then((html) => {
    $('#keys').innerHTML = html;
  });

  // Shift+R flips the retro pass — R itself belongs to the player, who turns
  // buildings with it. Materials are chosen while GLBs are parsed and the parse
  // results are cached, so switching means reloading: cheap enough, and it
  // keeps one code path instead of a second set of materials kept in sync.
  addEventListener('keydown', (e) => {
    if (e.code !== 'KeyR' || !e.shiftKey || e.ctrlKey || e.metaKey) return;
    const url = new URL(location.href);
    if (retroEnabled) url.searchParams.set('retro', '0');
    else url.searchParams.delete('retro');
    location.href = url.toString();
  });

  const res = $('#res');
  res.innerHTML = RESOURCES.map(
    (r) => `<div class="stat ${r}"><i></i><div><b>0</b><span>${r[0]!.toUpperCase()}${r.slice(1)}</span></div></div>`,
  ).join('');
  const stock = RESOURCES.map((r) => res.querySelector<HTMLElement>(`.${r} b`)!);
  let stockShown = '';

  // --- loop -----------------------------------------------------------------
  const perf = $('#perf');
  const clock = new THREE.Clock();
  const sim = new FixedStep(1 / SIM_HZ);
  /** Simulation speed multiplier, for testing from the console. */
  let speed = 1;
  let fpsAccum = 0;
  let fpsFrames = 0;
  let fps = 0;

  function frame(): void {
    requestAnimationFrame(frame);
    const dt = Math.min(clock.getDelta(), 0.1);
    const elapsed = clock.elapsedTime;

    camera.update(dt);
    sim.advance(dt * speed, simStep);
    const events = game.drainEvents();
    if (events.length) {
      builds.handle(events);
      // A tree coming down changes the ground, not what may be built on it —
      // and the overlay is only ever rebuilt while something is being placed.
      if (events.some((e) => e.type !== 'forest')) overlay.refresh();
      syncGround();
    }
    builds.update(dt);
    dust.update(dt);
    arrows.update(dt);
    marks.sync(targets.all);
    figures.sync(workforce.all, elapsed);
    controller.update();
    overlay.update(dt);
    water.update(elapsed);
    renderer.render(scene, camera.camera);

    bars.update(camera.camera);
    selection.refresh();
    menu.refresh();
    const shown = RESOURCES.map((r) => game.state.resources[r]).join('|');
    if (shown !== stockShown) {
      stockShown = shown;
      RESOURCES.forEach((r, i) => {
        stock[i]!.textContent = String(Math.floor(game.state.resources[r]));
      });
    }

    fpsAccum += dt;
    fpsFrames++;
    if (fpsAccum >= 0.5) {
      fps = Math.round(fpsFrames / fpsAccum);
      fpsAccum = 0;
      fpsFrames = 0;
      const calls = renderer.info.render.calls;
      perf.innerHTML =
        `<b>${fps}</b> fps &middot; ` +
        `<b class="${calls > 80 ? 'over' : ''}">${calls}</b> draws &middot; ` +
        `${(renderer.info.render.triangles / 1000).toFixed(0)}k tris &middot; ` +
        `${materialCount()} mats`;
    }
  }
  frame();

  // Debug surface for tools/smoke.mjs and the browser console.
  Object.assign(globalThis, {
    md: {
      scene,
      camera,
      renderer,
      map,
      manifest,
      game,
      defenses,
      targets,
      workforce,
      controller,
      get report() {
        return {
          drawCalls: renderer.info.render.calls,
          triangles: renderer.info.render.triangles,
          terrainTriangles: terrain.triangles,
          scatterModels: scatter.models,
          landmarkModels: landmarks.models,
          buildings: game.state.buildings.length,
          targets: targets.all.length,
          workers: workforce.all.length,
          standingTrees: map.trees.length - game.state.felled.length,
          retro: retroEnabled,
          materials: materialCount(),
          sceneChildren: scene.children.length,
          tile: manifest.tile,
          mapSize: map.size,
          waterfallFaces: map.waterfall.length,
          fps,
        };
      },
      materials: describeMaterials,
      /** Frame a cell rather than a world position — easier to aim at landmarks. */
      look: (x: number, z: number, zoom?: number) =>
        camera.frame(cellToWorldX(x), cellToWorldZ(z), zoom),
      frame: (x: number, z: number, zoom?: number) => camera.frame(x, z, zoom),
      frameMap: () => camera.frameMap(),
      give: (amounts: Cost) => game.grant(amounts),
      speed: (multiplier: number) => {
        speed = multiplier;
      },
      /** Runs the simulation forward at once, e.g. to finish every construction. */
      advance: (seconds: number) => {
        for (let i = 0; i < Math.round(seconds * SIM_HZ); i++) simStep(1 / SIM_HZ);
      },
      /** Drops a practice target on a cell, for the towers to shoot at. */
      dummy: (x: number, z: number, hp = 200) => targets.add(x, z, hp),
      /** Turns the selected building, or what is being placed, a quarter turn. */
      rotate: (delta = 1) => controller.rotate(delta),
    },
  });
}

boot().catch((err: unknown) => {
  console.error(err);
  const msg = document.querySelector('#boot-msg');
  if (msg)
    msg.innerHTML = `<span style="color:#c9503f">Failed to start: ${
      err instanceof Error ? err.message : String(err)
    }</span>`;
});
