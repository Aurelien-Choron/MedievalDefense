// Builds docs/previews/index.html: every Kenney preview thumbnail in one
// searchable page, so the piece-to-model mapping can be decided by looking
// rather than by guessing at filenames.
//
// Kenney ships its own rendered thumbnail for every model, which is why this
// tool only has to lay them out — no headless rendering needed.
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './paths.mjs';

const PREVIEWS = path.join(ROOT, 'docs', 'previews');
const kits = fs
  .readdirSync(PREVIEWS, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => d.name)
  .sort();

const escape = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');

let total = 0;
const sections = kits.map((kit) => {
  const files = fs
    .readdirSync(path.join(PREVIEWS, kit))
    .filter((f) => /\.(png|jpe?g)$/i.test(f))
    .sort();
  total += files.length;

  const cards = files
    .map((file) => {
      const name = file.replace(/\.(png|jpe?g)$/i, '');
      return `<figure data-name="${escape(`${kit} ${name}`.toLowerCase())}">
  <img src="${escape(kit)}/${escape(file)}" alt="${escape(name)}" loading="lazy">
  <figcaption>${escape(name)}</figcaption>
</figure>`;
    })
    .join('\n');

  return `<section id="${escape(kit)}">
<h2>${escape(kit)} <small>${files.length} models</small></h2>
<div class="grid">
${cards}
</div>
</section>`;
});

const html = `<!doctype html>
<meta charset="utf-8">
<title>Medieval Defense — Kenney contact sheets</title>
<style>
  :root { --bg:#14100c; --panel:#201a14; --line:#3d3225; --ink:#f0e6d6; --muted:#a2937c; --gold:#e8c15a; }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--ink);
    font:13px/1.5 ui-sans-serif, system-ui, "Segoe UI", sans-serif; }
  header { position:sticky; top:0; z-index:5; display:flex; gap:16px; align-items:center; flex-wrap:wrap;
    padding:12px 20px; background:rgba(20,16,12,.97); border-bottom:1px solid var(--line); }
  h1 { margin:0; font-size:15px; letter-spacing:.1em; text-transform:uppercase; }
  input { flex:1; min-width:200px; padding:7px 12px; border-radius:7px; border:1px solid var(--line);
    background:var(--panel); color:var(--ink); font:inherit; }
  nav a { color:var(--muted); text-decoration:none; margin-right:12px; }
  nav a:hover { color:var(--gold); }
  h2 { margin:28px 20px 10px; font-size:14px; text-transform:uppercase; letter-spacing:.08em; }
  h2 small { color:var(--muted); text-transform:none; letter-spacing:0; font-weight:400; }
  .grid { display:grid; grid-template-columns:repeat(auto-fill, minmax(120px, 1fr)); gap:10px; padding:0 20px; }
  figure { margin:0; padding:8px; background:var(--panel); border:1px solid var(--line); border-radius:8px;
    text-align:center; }
  figure.hidden { display:none; }
  img { width:100%; height:76px; object-fit:contain; image-rendering:auto; }
  figcaption { margin-top:6px; font-size:10px; color:var(--muted); word-break:break-all; line-height:1.3; }
  section:empty, section.hidden { display:none; }
  footer { padding:32px 20px; color:var(--muted); }
</style>

<header>
  <h1>Kenney contact sheets</h1>
  <input id="q" type="search" placeholder="filter — try: wall, siege, tower, river, cliff, tent" autofocus>
  <nav>${kits.map((k) => `<a href="#${escape(k)}">${escape(k)}</a>`).join('')}</nav>
</header>

${sections.join('\n')}

<footer>${total} previews across ${kits.length} kits &middot; regenerate with <code>npm run sheets</code></footer>

<script>
  const q = document.getElementById('q');
  const figures = [...document.querySelectorAll('figure')];
  const sections = [...document.querySelectorAll('section')];
  q.addEventListener('input', () => {
    const terms = q.value.toLowerCase().split(/\\s+/).filter(Boolean);
    for (const f of figures)
      f.classList.toggle('hidden', !terms.every((t) => f.dataset.name.includes(t)));
    for (const s of sections)
      s.classList.toggle('hidden', !s.querySelector('figure:not(.hidden)'));
  });
</script>
`;

fs.writeFileSync(path.join(PREVIEWS, 'index.html'), html);
console.log(`${total} previews across ${kits.length} kits -> docs/previews/index.html`);
