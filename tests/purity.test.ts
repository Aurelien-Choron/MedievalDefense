// The rule the whole project leans on: src/core, src/sim and src/data never
// import three.js or reach for the browser. That is what lets every test run
// in plain node, and what will make a save a plain JSON dump.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');

test('core, sim and data import no three.js and touch no DOM', () => {
  let files = 0;
  for (const dir of ['core', 'sim', 'data']) {
    const full = path.join(root, dir);
    if (!fs.existsSync(full)) continue;
    for (const name of fs.readdirSync(full).filter((f) => f.endsWith('.ts'))) {
      const source = fs.readFileSync(path.join(full, name), 'utf8');
      files++;
      assert.doesNotMatch(source, /from\s+['"]three/, `src/${dir}/${name} imports three.js`);
      assert.doesNotMatch(source, /\b(document|window|localStorage)\s*\./, `src/${dir}/${name} uses the DOM`);
    }
  }
  assert.ok(files >= 4, 'the scan found nothing to check');
});
