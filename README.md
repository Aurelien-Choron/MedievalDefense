# Medieval Defense

Castle defense in the browser: hold a single keep against waves of medieval besiegers
while mining stone, felling timber, and growing a wooden palisade into a stone castle.

Isometric view over a one-screen map (44×44, the size of a Clash of Clans village),
mouse-driven building, three.js + TypeScript, Kenney CC0 art.

**Status:** building is playable (milestone P2) and the economy runs (P3) — camps hire
woodcutters and miners who walk the map, fell trees, and carry their loads back to camp. The towers
already shoot, so the combat layer of P4 is in place, waiting on attackers to aim at, and
so is the walking grid they will move on. The siege engine (P4) and polish (P5) come next —
see `docs/brief.md`, and `CLAUDE.md` for the handover notes.

## Getting started

The art is five Kenney kits, all CC0. They are not kept in this repository — download
them from [kenney.nl/assets](https://kenney.nl/assets) and drop the zips, unopened, into
`assets-src/`:

| Kit | Expected file |
|---|---|
| Castle Kit | `kenney_castle-kit.zip` |
| Fantasy Town Kit | `kenney_fantasy-town-kit_2.0.zip` |
| Nature Kit | `kenney_nature-kit.zip` |
| Retro Fantasy Kit | `kenney_retro-fantasy-kit.zip` |
| Retro Texture Pack: Fantasy | `kenney_retro-textures-fantasy.zip` |

A script unpacks them — don't unzip by hand, it only takes the GLB, the textures and the
preview renders and leaves the OBJ and FBX folders alone.

```bash
npm install
npm run extract        # assets-src/*.zip -> public/assets/kenney/ + docs/previews/
npm run build:assets   # measure every GLB -> src/data/asset-manifest.json
npm run build:map      # generate the map -> src/data/map.json
npm run dev            # http://localhost:5173
```

`src/data/asset-manifest.json` and `src/data/map.json` are committed, so the last two are
only needed if you change the kits or the map generator.

## Playing

| Input | Action |
|---|---|
| WASD / ZQSD / arrows, or drag | Pan (keys follow their physical position, so AZERTY works as is) |
| Mouse wheel | Zoom toward the cursor |
| Q / E (A / E on AZERTY) | Rotate the view a quarter turn |
| 1–9, 0, or the bottom menu | Pick a building |
| Click / drag | Place it / lay a line of walls or moat — hold Shift to place several |
| Click a building | Its panel: upgrades, the whole wall line at once, gate controls, a camp's crew, turn, cancel, demolish |
| R | Turn a quarter — what you are placing, or the building you have selected |
| Esc / right click | Leave placement, then drop the selection |
| Shift + R | Toggle the retexturing pass |

A wall you leave alone takes its line from its neighbours, so corners and T-joins come out
right on their own. Turn one with **R** and it keeps the line you gave it instead, even in
the middle of a run — and the placement ghost shows you which of the two you are about to
get. Only a moat has nothing to turn.

Browser console helpers for testing: `md.give({ wood: 500, stone: 500, gold: 500 })`,
`md.advance(30)` to run the simulation 30 seconds ahead, `md.speed(4)`, `md.game`,
`md.workforce.all` to inspect the workers, and `md.dummy(x, z, hp)` to drop a practice
target for the towers to shoot at.

## Scripts

| Command | What it does |
|---|---|
| `npm run dev` | Vite dev server |
| `npm run build` | Typecheck, production bundle in `dist/`, then prune every Kenney asset the code never names |
| `npm run preview` | Serve `dist/` on :4173 |
| `npm run typecheck` | `tsc --noEmit` |
| `npm test` | Map, rules, defence, pathing, economy and purity tests, in node, no browser |
| `npm run smoke` | Headless Chrome: boots, zero errors, draw-call budget, screenshot |
| `npm run check:controls` | Headless Chrome: every pan key, drag, wheel and rotation moves the view the right way |
| `npm run check:build` | Headless Chrome: plays the build loop end to end and asserts on it (`-- --shots=dir` for screenshots) |
| `npm run check` | All of the above, in order |
| `npm run extract` | Unpack the Kenney zips (GLB + textures + preview thumbnails) |
| `npm run build:assets` | Measure model footprints, derive `TILE`, write the manifest |
| `npm run build:map` | Generate the map, printing an ASCII preview of the layout |
| `npm run sheets` | Build `docs/previews/index.html` — searchable contact sheet |

The browser scripts start Vite on their own if nothing is serving the game. Point them at
another server with `URL=http://localhost:4173/`.

## Layout

```
assets-src/     the Kenney zips you downloaded         (not versioned)
public/assets/  extracted GLB + textures              (generated, gitignored)
docs/previews/  Kenney's own preview renders           (generated, gitignored)
src/core/       grid, map accessors, fixed step        — pure, no three.js
src/sim/        game.ts: the rules of building          — pure, no three.js
                defense.ts: what the towers shoot at    — pure, no three.js
                pathing.ts: the walking grid and its flow fields
                forest.ts, workers.ts: trees, camps, the harvesting round
src/data/       building catalogue, palettes, generated map and asset manifest
src/render/     everything that touches three.js: terrain, water, props, buildings,
                construction and gate animation, projectiles, workers, placement
                overlay, camera, icons
src/ui/         DOM: build menu, building panel, progress bars, input controller
tools/          node scripts: extract, measure, map, smoke test, browser checks
tests/          node tests: map layout regressions, building rules, defences,
                pathing, the economy, purity
```

**The simulation never imports three.js.** `src/core`, `src/sim` and `src/data` are plain
data and arithmetic, so node runs them directly via its built-in type stripping — no build
step for tests, deterministic replay, and saving is just JSON serialisation. A test enforces
it.

## Budget

60 fps with 200 units, under 80 draw calls. `npm run smoke` fails if the draw-call budget is
exceeded, so it can't drift unnoticed. A fresh map sits at 54 today, a complete castle with
two camps working at 71: every shaft in the air shares one instanced pass, the whole
workforce shares three, and neither is drawn when there is nothing to draw. `CLAUDE.md`
has the full table, including the half-second spike a batch of finished buildings still
causes.

## Docs

The design brief, the asset inventory and the handover notes are working documents in
French, kept out of this repository. What you need to read the code is here: every module
carries a header comment explaining what it does and why it is shaped that way, and the
tests in `tests/` are written to be read as the specification of the rules.

- `docs/previews/index.html` — every Kenney model as a searchable thumbnail grid, built by
  `npm run sheets` once the kits are unpacked
- `docs/shot-*.png` — reference screenshots of each milestone

## Flags

| URL | Effect |
|---|---|
| `?retro=0` | Skip the retexturing pass and show Kenney's own colormaps. Also bound to **Shift + R**. |
| `?raw=1` | Keep the Nature Kit's shipped turquoise-and-salmon palette instead of the remap. |
