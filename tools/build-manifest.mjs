// Measures every extracted GLB and writes src/data/asset-manifest.json.
// The game needs each model's real footprint to place it on the grid, and the
// whole tile size of the project is derived from the Castle Kit wall — so this
// runs before any placement code is written.
import fs from 'node:fs';
import path from 'node:path';
import { bounds } from './glb.mjs';
import { ROOT } from './paths.mjs';

const KITS = ['castle', 'town', 'nature', 'retro'];
const MODELS = path.join(ROOT, 'public', 'assets', 'kenney');
const r3 = (v) => Math.round(v * 1000) / 1000;

const manifest = { tile: null, kits: {} };

for (const kit of KITS) {
  const dir = path.join(MODELS, kit);
  if (!fs.existsSync(dir)) continue;

  const models = {};
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.glb')).sort()) {
    const b = bounds(path.join(dir, file));
    models[file.replace(/\.glb$/, '')] = {
      size: b.size.map(r3),
      // y offset of the model's base, so pieces can be seated on the ground
      base: r3(b.min[1]),
      meshes: b.meshes,
    };
  }
  manifest.kits[kit] = models;
  console.log(`  ${kit.padEnd(8)} ${String(Object.keys(models).length).padStart(4)} models`);
}

// --- derive the tile size ---------------------------------------------------
// Every wall piece in the Castle Kit is authored on one square module. Reading
// it here means no magic number ever gets hand-typed into the game code.
const wall = manifest.kits.castle?.wall;
if (!wall) throw new Error('castle/wall.glb missing — run `npm run extract` first');
manifest.tile = Math.max(wall.size[0], wall.size[2]);

fs.mkdirSync(path.join(ROOT, 'src', 'data'), { recursive: true });
fs.writeFileSync(
  path.join(ROOT, 'src', 'data', 'asset-manifest.json'),
  JSON.stringify(manifest, null, 1),
);

// --- report the pieces the design actually hangs on -------------------------
const show = (kit, ...names) => {
  for (const n of names) {
    const m = manifest.kits[kit]?.[n];
    console.log(
      `  ${(kit + '/' + n).padEnd(34)} ${m ? m.size.map((v) => v.toFixed(2).padStart(6)).join(' ') : '  MISSING'}`,
    );
  }
};

console.log(`\nTILE = ${manifest.tile}  (from castle/wall)\n`);
console.log('key pieces                            X      Y      Z');
show('castle', 'wall', 'wall-corner', 'wall-half', 'wall-narrow', 'wall-narrow-wood', 'wall-doorway');
show('castle', 'tower-square-base', 'tower-square-mid', 'tower-square-top', 'gate', 'metal-gate', 'bridge-draw');
show('castle', 'siege-ram', 'siege-catapult', 'siege-tower', 'siege-trebuchet');
show('nature', 'ground_riverStraight', 'ground_grass', 'cliff_waterfall_rock', 'cliff_cave_rock');
show('town', 'wall', 'wall-wood', 'roof', 'stairs-wood');
show('retro', 'battlement', 'overhang', 'tower', 'structure-poles');
console.log('\n-> src/data/asset-manifest.json');
