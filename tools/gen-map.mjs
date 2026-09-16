// Generates src/data/map.json — the one map, as data.
//
// This is authored, not random: the mountain, the river, the ford, the forest
// and the lake are placed deliberately, and noise only roughens their edges so
// they don't read as geometry. Run once, commit the result, hand-edit if needed.
//
// 44x44, the size of a Clash of Clans village: the whole battlefield fits on
// one screen, so the player defends without scrolling. Everything below is
// packed accordingly — one cell of breathing room is a lot at this scale.
//
// Layout (x east, z south, north = low z):
//
//        N
//   +------------------------------+
//   |MOUNTAIN  mine        FOREST  |
//   A ~~                  T T T    |
//   #   ~   [KEEP + ring]  T ======|=== SPAWN B (east, through the wood)
//   #   ~                  T T     |
//   #    ~~~~~ bridge ~~~ WATERFALL|
//   ##########              LAKE   |
//   +------------------------------+
//   SPAWN A enters on the far bank, right below the mountain
//
// The river runs from the map edge in the mountain down to the lake, and the
// lake fills the south-east corner: together they wall off the south-west, so
// the river road has exactly one way across — the bridge. Spawn A walks the
// whole road along the far bank in plain view before it crosses: the player
// sees an attack coming. The mine sits behind the mountain on the keep's side
// of the river, while the forest straddles the eastern invasion road. Stone is
// safe, wood is risky — that asymmetry is the point.
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './paths.mjs';

const SIZE = 44; // must match MAP_SIZE in src/core/grid.ts
const N = SIZE * SIZE;

// --- heights (integer steps, matching Kenney's blocky cliff language) --------
const H_LAKE_BED = 0;
const H_RIVER_BED = 2;
const H_GROUND = 3; // the flat plain the castle sits on
const H_MOUNTAIN_MAX = 8;

// --- tile kinds -------------------------------------------------------------
export const Kind = {
  GRASS: 0,
  DIRT: 1,
  ROCK: 2,
  ORE: 3,
  FOREST: 4,
  RIVER: 5,
  LAKE: 6,
  ROAD: 7,
};

// --- buildable flags --------------------------------------------------------
const BUILD_CASTLE = 1; // walls, towers, moat, gatehouse
const BUILD_WOOD_CAMP = 2; // woodcutter camps, near the forest
const BUILD_STONE_CAMP = 4; // miner camps, near the ore

// --- landmarks --------------------------------------------------------------
const KEEP = { x: 21, z: 19 };
const RING = 9; // half-width of the castle build ring -> 19x19
const MINE = { x: 9, z: 4 };

/** Mountain radius, measured from the north-west corner. */
const MOUNTAIN_REACH = 16;
/** Lake basin radius (cliff rim included), measured from the south-east corner. */
const LAKE_BASIN = 13;
const LAKE_WATER = 11;

/**
 * River centreline. It enters from beyond the west edge, inside the mountain,
 * so there is no spring for an army to walk around: from edge to lake it is
 * one unbroken wall of water.
 */
const RIVER = [
  [-1, 4],
  [4, 9],
  [6, 18],
  [7, 27],
  [13, 32],
  [21, 34],
  [28, 34],
  [33, 37], // crosses the basin rim here — this is the waterfall
  [38, 41], // and runs on into the lake
];

const SPAWNS = [
  { id: 'west', x: 0, z: 11, label: 'River road' },
  { id: 'east', x: SIZE - 1, z: 12, label: 'Forest track' },
];

/** Where the river road crosses on a wooden bridge — the only way over. */
const BRIDGE = { x: 20, z: 34 };

// --- helpers ----------------------------------------------------------------
const idx = (x, z) => z * SIZE + x;
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const lerp = (a, b, t) => a + (b - a) * t;
const smooth = (t) => t * t * (3 - 2 * t);

let seed = 20260913;
const rand = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 0x100000000);

/** Value noise: a lattice of random values, smoothly interpolated. */
function makeNoise(cells) {
  const grid = Array.from({ length: (cells + 1) * (cells + 1) }, rand);
  const step = SIZE / cells;
  return (x, z) => {
    const gx = x / step;
    const gz = z / step;
    const x0 = Math.floor(gx);
    const z0 = Math.floor(gz);
    const tx = smooth(gx - x0);
    const tz = smooth(gz - z0);
    const at = (a, b) => grid[clamp(b, 0, cells) * (cells + 1) + clamp(a, 0, cells)] ?? 0;
    return lerp(
      lerp(at(x0, z0), at(x0 + 1, z0), tx),
      lerp(at(x0, z0 + 1), at(x0 + 1, z0 + 1), tx),
      tz,
    );
  };
}

const coarse = makeNoise(5);
const fine = makeNoise(12);

/** Distance from (x,z) to the river polyline. */
function riverDistance(x, z) {
  let best = Infinity;
  for (let i = 0; i < RIVER.length - 1; i++) {
    const [ax, az] = RIVER[i];
    const [bx, bz] = RIVER[i + 1];
    const dx = bx - ax;
    const dz = bz - az;
    const t = clamp(((x - ax) * dx + (z - az) * dz) / (dx * dx + dz * dz), 0, 1);
    best = Math.min(best, Math.hypot(x - (ax + dx * t), z - (az + dz * t)));
  }
  return best;
}

/** Chebyshev distance to the castle ring, negative inside. */
const ringDistance = (x, z) => Math.max(Math.abs(x - KEEP.x), Math.abs(z - KEEP.z)) - RING;

// --- build the grids --------------------------------------------------------
const height = new Array(N).fill(H_GROUND);
const kind = new Array(N).fill(Kind.GRASS);
const build = new Array(N).fill(0);

for (let z = 0; z < SIZE; z++) {
  for (let x = 0; x < SIZE; x++) {
    const i = idx(x, z);
    const wobble = coarse(x, z) * 3 - 1.5; // +/- 1.5 cells of organic edge
    let h = H_GROUND;
    let k = Kind.GRASS;

    // --- the lake basin, south-east corner, below the waterfall --------------
    // A sheer step, not a ramp. The whole basin is ringed by a cliff, which is
    // what makes the river's drop read as a waterfall rather than as rapids.
    // It has to reach both the south and east edges: that is what closes the
    // south off, leaving the ford as the only way across.
    const fromLake = Math.hypot(x - (SIZE - 1), z - (SIZE - 1)) + wobble;
    if (fromLake < LAKE_BASIN) {
      h = H_LAKE_BED;
      k = fromLake < LAKE_WATER ? Kind.LAKE : Kind.DIRT;
    }

    // --- the mountain, north-west corner --------------------------------------
    // Falls off with distance from the corner, so the mine sits in its foot.
    const mountain = clamp(1 - (Math.hypot(x, z) + wobble) / MOUNTAIN_REACH, 0, 1);
    if (mountain > 0) {
      const peak = Math.round(lerp(H_GROUND, H_MOUNTAIN_MAX, smooth(mountain)));
      if (peak > h) {
        h = peak;
        if (peak > H_GROUND + 1) k = Kind.ROCK;
      }
    }

    // --- the river, carved last so it cuts through whatever it crosses -------
    const bank = 1.8 + coarse(x * 2, z * 2) * 0.7;
    const river = riverDistance(x, z);
    if (river < bank) {
      const water = river < bank - 0.8;
      if (h <= H_LAKE_BED) {
        // Inside the basin the lake owns the ground. The river only opens its
        // channel through the rim; laying banks here would draw two strips of
        // dry land straight across the lake, and an army would walk them
        // around the ford (tests/map.test.ts caught exactly that).
        if (water) k = Kind.LAKE;
      } else {
        // min(), not assignment: the channel cuts down through high ground,
        // and meets the basin a step above the lake bed. That drop is the
        // waterfall.
        h = Math.min(h, H_RIVER_BED);
        k = water ? Kind.RIVER : Kind.DIRT;
      }
    }

    height[i] = h;
    kind[i] = k;
  }
}

// --- the ore body, in the mountain foot -------------------------------------
for (let z = 0; z < SIZE; z++)
  for (let x = 0; x < SIZE; x++) {
    const d = Math.hypot(x - MINE.x, z - MINE.z) + fine(x, z) * 2 - 1;
    if (d < 3 && kind[idx(x, z)] !== Kind.RIVER) kind[idx(x, z)] = Kind.ORE;
  }

// --- the forest, east, straddling the invasion road -------------------------
for (let z = 0; z < SIZE; z++)
  for (let x = 0; x < SIZE; x++) {
    const i = idx(x, z);
    if (kind[i] !== Kind.GRASS) continue;
    const inBox = x > 33 + coarse(x, z) * 3 - 1.5 && z > 0 && z < 27 + fine(x, z) * 4 - 2;
    if (inBox && ringDistance(x, z) > 1) kind[i] = Kind.FOREST;
  }

// --- roads: both spawns walk to the keep ------------------------------------
/** Stamps a road corridor along a polyline, flattening it as it goes. */
function carveRoad(points) {
  for (let i = 0; i < points.length - 1; i++) {
    const [ax, az] = points[i];
    const [bx, bz] = points[i + 1];
    const steps = Math.ceil(Math.hypot(bx - ax, bz - az) * 2);
    for (let s = 0; s <= steps; s++) {
      const x = Math.round(lerp(ax, bx, s / steps));
      const z = Math.round(lerp(az, bz, s / steps));
      for (let dz = -1; dz <= 1; dz++)
        for (let dx = -1; dx <= 1; dx++) {
          const cx = x + dx;
          const cz = z + dz;
          if (cx < 0 || cz < 0 || cx >= SIZE || cz >= SIZE) continue;
          const j = idx(cx, cz);
          // A road never bridges the river: the ford is the only crossing, and
          // it keeps the river bed height so the water still reads as water.
          if (kind[j] === Kind.RIVER || kind[j] === Kind.LAKE) continue;
          if (kind[j] !== Kind.ORE) kind[j] = Kind.ROAD;
          // Roads cut through the mountain foot rather than climbing it.
          if (height[j] > H_GROUND) height[j] = H_GROUND;
        }
    }
  }
}

// The river road hugs the far bank, then swings east to the bridge.
carveRoad([
  [SPAWNS[0].x, SPAWNS[0].z],
  [1, 26],
  [6, 38],
  [14, 39],
  [BRIDGE.x, 38],
  [BRIDGE.x, BRIDGE.z],
  [KEEP.x, KEEP.z + RING],
]);
carveRoad([
  [SPAWNS[1].x, SPAWNS[1].z],
  [36, 14],
  [KEEP.x + RING, KEEP.z],
]);

// --- the bridge: the river's only crossing -----------------------------------
// A wooden deck at ground height over the road's three lanes. It spans every
// low cell — bank and water — between the two dry landings, found by walking
// out from the river along each lane. The terrain underneath stays river, so
// the water still runs below; bridgeCells tells the simulation which of those
// cells an army may walk. Everything else about the river is a wall.
let bridgeFrom = BRIDGE.z;
let bridgeTo = BRIDGE.z;
for (let dx = -1; dx <= 1; dx++) {
  const x = BRIDGE.x + dx;
  let z0 = BRIDGE.z;
  while (z0 > 0 && height[idx(x, z0 - 1)] < H_GROUND) z0--;
  let z1 = BRIDGE.z;
  while (z1 < SIZE - 1 && height[idx(x, z1 + 1)] < H_GROUND) z1++;
  bridgeFrom = Math.min(bridgeFrom, z0);
  bridgeTo = Math.max(bridgeTo, z1);
}
const bridgeCells = [];
for (let z = bridgeFrom; z <= bridgeTo; z++)
  for (let dx = -1; dx <= 1; dx++) bridgeCells.push(idx(BRIDGE.x + dx, z));

// --- flatten the castle ring ------------------------------------------------
// Guaranteeing the whole build area sits at one height means the placement code
// never has to reason about slopes. Anything the terrain did here is overridden.
for (let z = KEEP.z - RING; z <= KEEP.z + RING; z++)
  for (let x = KEEP.x - RING; x <= KEEP.x + RING; x++) {
    if (x < 0 || z < 0 || x >= SIZE || z >= SIZE) continue;
    const i = idx(x, z);
    if (kind[i] === Kind.RIVER || kind[i] === Kind.LAKE) continue;
    height[i] = H_GROUND;
    if (kind[i] === Kind.ROCK || kind[i] === Kind.FOREST) kind[i] = Kind.GRASS;
    build[i] |= BUILD_CASTLE;
  }

// --- camp zones: flat ground within reach of a resource ---------------------
function markCampZone(kindWanted, radius, flag) {
  const sources = [];
  for (let i = 0; i < N; i++) if (kind[i] === kindWanted) sources.push(i);

  for (const src of sources) {
    const sx = src % SIZE;
    const sz = (src / SIZE) | 0;
    for (let dz = -radius; dz <= radius; dz++)
      for (let dx = -radius; dx <= radius; dx++) {
        const x = sx + dx;
        const z = sz + dz;
        if (x < 0 || z < 0 || x >= SIZE || z >= SIZE) continue;
        const i = idx(x, z);
        if (height[i] !== H_GROUND) continue;
        if (kind[i] !== Kind.GRASS && kind[i] !== Kind.DIRT && kind[i] !== Kind.ROAD) continue;
        build[i] |= flag;
      }
  }
}
// Separate flags, so a woodcutter camp cannot be pitched by the mine.
markCampZone(Kind.ORE, 6, BUILD_STONE_CAMP);
markCampZone(Kind.FOREST, 4, BUILD_WOOD_CAMP);

// --- the keep footprint is occupied, not buildable ---------------------------
const KEEP_HALF = 1; // 3x3
for (let dz = -KEEP_HALF; dz <= KEEP_HALF; dz++)
  for (let dx = -KEEP_HALF; dx <= KEEP_HALF; dx++) build[idx(KEEP.x + dx, KEEP.z + dz)] = 0;

// --- waterfall faces --------------------------------------------------------
// Any water cell with a lower water cell beside it is a lip. Derived rather
// than hand-placed, so moving the river polyline moves the waterfall with it.
const waterfall = [];
for (let z = 0; z < SIZE; z++)
  for (let x = 0; x < SIZE; x++) {
    const i = idx(x, z);
    if (kind[i] !== Kind.RIVER && kind[i] !== Kind.LAKE) continue;
    for (const [dx, dz] of [
      [0, 1],
      [1, 0],
      [0, -1],
      [-1, 0],
    ]) {
      const nx = x + dx;
      const nz = z + dz;
      if (nx < 0 || nz < 0 || nx >= SIZE || nz >= SIZE) continue;
      const j = idx(nx, nz);
      if ((kind[j] === Kind.RIVER || kind[j] === Kind.LAKE) && height[j] < height[i]) {
        waterfall.push({ x, z, dx, dz, drop: height[i] - height[j] });
        break;
      }
    }
  }

// --- the trees the woodcutters fell -----------------------------------------
// Which forest cells actually carry a trunk is game data, not decoration: the
// simulation fells them and counts them down to regrowth, and src/render/scatter
// only reflects that. Rolled last so every other layer above is untouched by it.
const trees = [];
for (let i = 0; i < N; i++) if (kind[i] === Kind.FOREST && rand() < 0.62) trees.push(i);

// --- collect what the renderer and the sim need -----------------------------
const counts = Object.fromEntries(
  Object.entries(Kind).map(([name, k]) => [name.toLowerCase(), kind.filter((v) => v === k).length]),
);

const map = {
  size: SIZE,
  heights: { ground: H_GROUND, riverBed: H_RIVER_BED, lakeBed: H_LAKE_BED },
  // Water sits just above its bed so the surface reads as water, not as terrain.
  water: { river: H_RIVER_BED + 0.45, lake: H_LAKE_BED + 0.45 },
  keep: KEEP,
  ring: RING,
  mine: MINE,
  bridge: { x: BRIDGE.x, from: bridgeFrom, to: bridgeTo, halfWidth: 1 },
  spawns: SPAWNS,
  riverPath: RIVER,
  bridgeCells,
  waterfall,
  trees,
  height,
  kind,
  build,
};

fs.mkdirSync(path.join(ROOT, 'src', 'data'), { recursive: true });
fs.writeFileSync(path.join(ROOT, 'src', 'data', 'map.json'), JSON.stringify(map));

// --- ASCII preview ----------------------------------------------------------
// Full resolution now that the map is small, two glyphs per cell so the grid
// comes out roughly square in a terminal.
const GLYPH = {
  [Kind.GRASS]: '.',
  [Kind.DIRT]: ',',
  [Kind.ROCK]: '^',
  [Kind.ORE]: 'O',
  [Kind.FOREST]: 'T',
  [Kind.RIVER]: '~',
  [Kind.LAKE]: '=',
  [Kind.ROAD]: '#',
};
const bridgeSet = new Set(bridgeCells);
const falls = new Set(waterfall.map((f) => idx(f.x, f.z)));
const spawnSet = new Set(SPAWNS.map((s) => idx(s.x, s.z)));

for (let z = 0; z < SIZE; z++) {
  let line = '';
  for (let x = 0; x < SIZE; x++) {
    const i = idx(x, z);
    let g = GLYPH[kind[i]];
    if (build[i] & BUILD_CASTLE && g === '.') g = '+';
    if (bridgeSet.has(i)) g = 'b';
    if (falls.has(i)) g = 'W';
    if (spawnSet.has(i)) g = 'S';
    if (Math.abs(x - KEEP.x) <= KEEP_HALF && Math.abs(z - KEEP.z) <= KEEP_HALF) g = 'K';
    line += g + g;
  }
  console.log(line);
}
console.log('');
console.log('  . grass  , dirt  ^ rock  O ore  T forest  ~ river  = lake  # road');
console.log('  b bridge   W waterfall   S spawn   + castle build   K keep');
console.log('');

const buildable = build.filter((b) => b & BUILD_CASTLE).length;
const camps = build.filter((b) => b & (BUILD_WOOD_CAMP | BUILD_STONE_CAMP)).length;
console.log('tiles:', counts);
console.log(`castle build cells: ${buildable}   camp cells: ${camps}   trees: ${trees.length}`);
console.log(
  `heights ${Math.min(...height)}..${Math.max(...height)}   waterfall faces: ${waterfall.length}   bridge: z ${bridgeFrom}..${bridgeTo}`,
);
console.log('-> src/data/map.json');
