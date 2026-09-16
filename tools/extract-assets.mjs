// Unpacks the Kenney zips in assets-src/ into just what the game and the design
// review need:
//   Models/GLB format/**  + Models/Textures/** -> public/assets/kenney/<kit>/
//   Previews/**                                -> docs/previews/<kit>/
// The OBJ and FBX folders are most of the ~19 MB and are never loaded, so they
// are skipped. Previews are Kenney's own rendered thumbnails of every model —
// they serve as the contact sheets for mapping game pieces to models.
import AdmZip from 'adm-zip';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './paths.mjs';

/** zip basename (minus kenney_ prefix and version suffix) -> kit folder name */
const KITS = {
  'kenney_castle-kit': 'castle',
  'kenney_fantasy-town-kit_2.0': 'town',
  'kenney_nature-kit': 'nature',
  'kenney_retro-fantasy-kit': 'retro',
  'kenney_retro-textures-fantasy': 'retro-textures',
};

const SRC = path.join(ROOT, 'assets-src');
const MODELS_OUT = path.join(ROOT, 'public', 'assets', 'kenney');
const PREVIEWS_OUT = path.join(ROOT, 'docs', 'previews');

// The ZIP spec mandates forward slashes, but some packers emit backslashes.
// Normalise before matching. (Built from a char code to keep the escaping sane.)
const BACKSLASH = String.fromCharCode(92);
const norm = (p) => p.split(BACKSLASH).join('/');

/**
 * Where should this entry land, if anywhere?
 * Returns an absolute destination path, or null to skip the entry.
 */
function destinationFor(entryName, kit) {
  const p = norm(entryName);
  const base = path.basename(p);

  // Kenney's texture pack has no Models/ tree — it is a flat PNG/ folder.
  if (kit === 'retro-textures') {
    return /\.(png|jpe?g)$/i.test(base) && !/^(Preview|Sample)\./i.test(base)
      ? path.join(MODELS_OUT, kit, base)
      : null;
  }

  // Newer kits ship "Previews/"; Nature Kit (2020) instead has "Side/" for the
  // one-per-model shot and "Isometric/" for four angles each. Side/ is the one
  // that lines up with the other kits, so take that.
  if (/^(Previews|Side)\//i.test(p) && /\.(png|jpe?g)$/i.test(base))
    return path.join(PREVIEWS_OUT, kit, base);

  // Newer kits call it "GLB format", Nature Kit calls it "GLTF format" — both
  // hold plain .glb files. Textures, where present, sit in a sibling folder and
  // are referenced by relative path from the GLB.
  const inModels = /Models\/(GLB|GLTF) format\//i.test(p);
  if (!inModels) return null;

  if (/\/Textures\//i.test(p)) return path.join(MODELS_OUT, kit, 'Textures', base);
  if (/\.glb$/i.test(base)) return path.join(MODELS_OUT, kit, base);

  return null;
}

let totalModels = 0;
let totalPreviews = 0;

for (const [zipName, kit] of Object.entries(KITS)) {
  const zipPath = path.join(SRC, `${zipName}.zip`);
  if (!fs.existsSync(zipPath)) {
    console.error(`  MISSING  ${zipName}.zip — download it from kenney.nl into assets-src/`);
    process.exitCode = 1;
    continue;
  }

  let models = 0;
  let previews = 0;
  for (const entry of new AdmZip(zipPath).getEntries()) {
    if (entry.isDirectory) continue;
    const dest = destinationFor(entry.entryName, kit);
    if (!dest) continue;
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, entry.getData());
    if (dest.startsWith(PREVIEWS_OUT)) previews++;
    else models++;
  }

  totalModels += models;
  totalPreviews += previews;
  console.log(`  ${kit.padEnd(15)} ${String(models).padStart(4)} assets  ${String(previews).padStart(4)} previews`);
}

console.log(`\n${totalModels} assets -> public/assets/kenney/`);
console.log(`${totalPreviews} previews -> docs/previews/`);
