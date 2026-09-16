// Browser plumbing shared by the scripted checks (check-controls, check-build):
// makes sure the game is being served, opens it in headless Chrome, and keeps
// every console error, page error and failed request for the verdict.
import puppeteer from 'puppeteer-core';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { ROOT } from './paths.mjs';

export const GAME_URL = process.env.URL || 'http://localhost:5173/';
export const WIDTH = 1600;
export const HEIGHT = 1000;

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const CHROME = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
].find((p) => fs.existsSync(p));

async function serving(url) {
  try {
    await fetch(url, { signal: AbortSignal.timeout(1500) });
    return true;
  } catch {
    return false;
  }
}

/** Opens the game once it has booted. Starts Vite first if nothing serves the URL. */
export async function openGame() {
  let vite = null;
  if (!(await serving(GAME_URL))) {
    console.log('starting vite...');
    vite = spawn('npm', ['run', 'dev'], { cwd: ROOT, shell: true, stdio: 'ignore' });
    for (let i = 0; i < 60 && !(await serving(GAME_URL)); i++) await sleep(500);
    if (!(await serving(GAME_URL))) {
      vite.kill();
      throw new Error(`nothing is serving ${GAME_URL}`);
    }
  }
  if (!CHROME) throw new Error('no Chrome or Edge found');

  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: 'new',
    args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox', `--window-size=${WIDTH},${HEIGHT}`],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: WIDTH, height: HEIGHT });

  const errors = [];
  page.on('pageerror', (e) => errors.push(`[pageerror] ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error' || m.type() === 'warning') errors.push(`[${m.type()}] ${m.text()}`);
  });
  page.on('requestfailed', (r) => errors.push(`[failed] ${r.url()} ${r.failure()?.errorText}`));
  page.on('response', (r) => {
    if (r.status() >= 400) errors.push(`[http ${r.status()}] ${r.url()}`);
  });

  await page.goto(GAME_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForFunction('window.md', { timeout: 180000 });
  await sleep(800);
  // window.md exists as soon as boot finishes, but the camera only answers a key
  // while frames are actually going through: a page whose loop is still throttled
  // — a second Chrome opening behind the one the previous check is closing —
  // swallows the first presses whole. Waiting for the fps readout to come up is
  // what stopped check:controls failing its first one or two assertions whenever
  // the suite ran in one go. A slow machine just carries on after the timeout.
  await page.waitForFunction('window.md.report.fps >= 5', { timeout: 20000, polling: 250 }).catch(() => {});

  return {
    page,
    errors,
    async close() {
      await browser.close();
      vite?.kill();
    },
  };
}

/** Where a cell centre, lifted `y` above the ground, lands on screen. */
export function screenOf(page, x, z, y = 0) {
  return page.evaluate(
    ({ x, z, y, width, height }) => {
      const { camera, map } = window.md;
      camera.camera.updateMatrixWorld();
      const v = camera.target
        .clone()
        .set(x - map.size / 2 + 0.5, map.heights.ground + y, z - map.size / 2 + 0.5)
        .project(camera.camera);
      return { x: ((v.x + 1) / 2) * width, y: ((1 - v.y) / 2) * height };
    },
    { x, z, y, width: WIDTH, height: HEIGHT },
  );
}

/** PASS / FAIL lines, and a running count of failures for the exit code. */
export function verdict() {
  let failures = 0;
  return {
    check(label, ok, detail = '') {
      console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  (${detail})` : ''}`);
      if (!ok) failures++;
    },
    get failures() {
      return failures;
    },
  };
}
