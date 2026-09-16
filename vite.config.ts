import fs from 'node:fs';
import path from 'node:path';
import { defineConfig, type Plugin } from 'vite';

/**
 * Ships only the Kenney models and retro textures the game actually names.
 *
 * public/assets/kenney holds all 677 extracted models (11 MB), and Vite copies
 * public/ wholesale. Every model and texture the game loads is named by a
 * string literal somewhere in the source — a model path is always
 * `assets/kenney/<kit>/<name>.glb` with <name> written out in full — so after
 * bundling, any GLB or retro texture whose name appears in no emitted script
 * is removed from dist. The kits' own Textures/ folders stay: GLBs reference
 * them internally.
 *
 * Dev is untouched and keeps every model available for exploration.
 */
function pruneUnusedAssets(): Plugin {
  let outDir = 'dist';
  return {
    name: 'prune-unused-kenney-assets',
    apply: 'build',
    configResolved(config) {
      outDir = path.resolve(config.root, config.build.outDir);
    },
    closeBundle() {
      const scripts = path.join(outDir, 'assets');
      const kenney = path.join(outDir, 'assets', 'kenney');
      if (!fs.existsSync(kenney) || !fs.existsSync(scripts)) return;

      const named = new Set<string>();
      for (const file of fs.readdirSync(scripts).filter((f) => f.endsWith('.js'))) {
        const code = fs.readFileSync(path.join(scripts, file), 'utf8');
        for (const match of code.matchAll(/["'`]([^"'`\n]{1,160})["'`]/g))
          for (const part of match[1]!.split(/[/${}]/)) if (part) named.add(part);
      }

      let kept = 0;
      let removed = 0;
      let freed = 0;
      for (const kit of fs.readdirSync(kenney)) {
        const dir = path.join(kenney, kit);
        if (!fs.statSync(dir).isDirectory()) continue;
        for (const file of fs.readdirSync(dir)) {
          const isModel = file.endsWith('.glb');
          const isRetroTexture = kit === 'retro-textures' && file.endsWith('.png');
          if (!isModel && !isRetroTexture) continue;
          const name = isModel ? file.slice(0, -4) : file;
          if (named.has(name)) {
            kept++;
            continue;
          }
          const full = path.join(dir, file);
          freed += fs.statSync(full).size;
          fs.rmSync(full);
          removed++;
        }
      }
      console.log(
        `\n  kenney assets: kept ${kept}, removed ${removed} unused (${(freed / 1024 / 1024).toFixed(1)} MB)`,
      );
    },
  };
}

export default defineConfig({
  server: { port: 5173 },
  plugins: [pruneUnusedAssets()],
  build: {
    target: 'es2022',
    // three is the bulk of the bundle; keeping it in its own chunk means gameplay
    // edits don't invalidate it in the browser cache on every deploy.
    rollupOptions: {
      output: {
        manualChunks: (id) => (id.includes('node_modules/three') ? 'three' : undefined),
      },
    },
  },
});
