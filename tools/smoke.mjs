// Loads the game in a real browser, fails on any console or network error, and
// saves a screenshot. Also asserts the draw-call budget, which is a design
// constraint of this project rather than a nice-to-have.
//
// Starts the Vite dev server itself if nothing is listening yet.
//   node tools/smoke.mjs [out.png] [--zoom=34] [--at=0,0]
import puppeteer from 'puppeteer-core';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './paths.mjs';

const URL_ = process.env.URL || 'http://localhost:5173/';
const DRAW_CALL_BUDGET = 80;
const OUT = process.argv[2]?.startsWith('--')
  ? path.join(ROOT, 'shot.png')
  : path.resolve(process.argv[2] ?? path.join(ROOT, 'shot.png'));

const arg = (name) => process.argv.find((a) => a.startsWith(`--${name}=`))?.split('=')[1];

const CHROME = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
].find((p) => fs.existsSync(p));
if (!CHROME) {
  console.error('no Chrome or Edge found');
  process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function serverUp() {
  try {
    await fetch(URL_, { signal: AbortSignal.timeout(1500) });
    return true;
  } catch {
    return false;
  }
}

let vite = null;
if (!(await serverUp())) {
  console.log('starting vite...');
  vite = spawn('npm', ['run', 'dev'], { cwd: ROOT, shell: true, stdio: 'ignore' });
  for (let i = 0; i < 40 && !(await serverUp()); i++) await sleep(500);
  if (!(await serverUp())) {
    vite.kill();
    console.error('vite never came up');
    process.exit(1);
  }
}

// Puppeteer's own launcher fails silently in this environment; attaching to a
// Chrome already listening on the CDP port works, and keeps the browser warm
// between runs. Fall back to launching if nothing is listening.
const PORT = process.env.CDP_PORT || 9222;
let browser;
let launched = false;
try {
  browser = await puppeteer.connect({ browserURL: `http://localhost:${PORT}` });
} catch {
  browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: 'new',
    args: [
      '--use-angle=swiftshader',
      '--enable-unsafe-swiftshader',
      '--no-sandbox',
      '--window-size=1600,1000',
    ],
  });
  launched = true;
}

const page = await browser.newPage();
await page.setViewport({ width: 1600, height: 1000 });

const errors = [];
page.on('console', (m) => {
  if (m.type() === 'error' || m.type() === 'warning') errors.push(`[${m.type()}] ${m.text()}`);
});
page.on('pageerror', (e) => errors.push(`[pageerror] ${e.message}`));
page.on('requestfailed', (r) => errors.push(`[failed] ${r.url()} ${r.failure()?.errorText}`));
page.on('response', (r) => {
  if (r.status() >= 400) errors.push(`[http ${r.status()}] ${r.url()}`);
});

await page.goto(URL_, { waitUntil: 'domcontentloaded', timeout: 60000 });

await page.waitForFunction('window.md', { timeout: 120000 }).catch(async () => {
  const boot = await page
    .$eval('#boot-msg', (el) => el.textContent)
    .catch(() => '(no boot message)');
  throw new Error(`game never became ready. boot said: ${boot}\n${errors.join('\n')}`);
});

const zoom = arg('zoom');
const at = arg('at');
if (zoom || at) {
  const [x, z] = (at ?? '0,0').split(',').map(Number);
  await page.evaluate((x, z, zoom) => window.md.frame(x, z, zoom ? Number(zoom) : undefined), x, z, zoom);
}

// Let a few frames run so instancing and the perf readout actually settle.
await sleep(2500);

const report = await page.evaluate(() => ({
  ...window.md.report,
  materialColors: window.md.materials(),
  bootGone: !document.querySelector('#boot'),
  canvas: !!document.querySelector('canvas'),
}));

await page.screenshot({ path: OUT });
await page.close();
if (launched) await browser.close();
else browser.disconnect();
vite?.kill();

console.log('report:', JSON.stringify(report, null, 2));

const unique = [...new Set(errors)];
if (unique.length) {
  console.log('\nconsole output:');
  for (const e of unique.slice(0, 25)) console.log('  ' + e);
}

console.log(`\nscreenshot -> ${OUT}`);

const fatal = unique.filter((e) => e.startsWith('[pageerror]') || e.startsWith('[http') || e.startsWith('[failed]'));
let failed = false;
if (fatal.length) {
  console.log(`FAIL: ${fatal.length} fatal error(s)`);
  failed = true;
}
if (!report.bootGone || !report.canvas) {
  console.log('FAIL: page did not finish booting');
  failed = true;
}
if (report.drawCalls > DRAW_CALL_BUDGET) {
  console.log(`FAIL: ${report.drawCalls} draw calls exceeds budget of ${DRAW_CALL_BUDGET}`);
  failed = true;
}
if (failed) process.exit(1);
console.log('smoke test passed');
