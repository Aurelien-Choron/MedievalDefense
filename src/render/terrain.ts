import * as THREE from 'three';
import {
  Build,
  Kind,
  canBuild,
  contains,
  heightAt,
  kindAt,
  waterLevelAt,
  type MapData,
} from '../core/map.js';
import { cellToWorldX, cellToWorldZ, TILE } from '../core/grid.js';

/**
 * Builds the whole terrain as a single flat-shaded, vertex-coloured mesh: one
 * top quad per cell, plus a vertical skirt wherever a neighbour sits lower.
 *
 * Heights are integers, so the result is stepped rather than smooth — which is
 * deliberate. Kenney's Nature Kit speaks in one-unit cliff blocks
 * (cliff_block_*, cliff_waterfall_*), so a stepped terrain lets the kit's own
 * cliff and waterfall panels sit flush against generated ground. Building it as
 * one merged geometry instead of thousands of instanced blocks costs a single
 * draw call and leaves the instancing budget for buildings and units.
 *
 * The map fits on one screen, so its edge is always in view. It is dressed as a
 * diorama rather than hidden: cliffs show a turf lip over earth, the map edge
 * drops through a band of bedrock, and water meeting the edge is cut away in
 * cross-section. All of it is vertex colour, so none of it costs a draw call.
 *
 * Moats are dug into this mesh too: a dug cell drops to a floor below the river
 * bed, and its neighbours grow earth walls down to it. The geometry is rebuilt
 * when the set of dug cells changes — a few thousand quads, on an event, never
 * per frame.
 */

/** How far the diorama slab hangs below the lake bed. */
export const TERRAIN_BASE = -3;

/**
 * A moat's floor: half a step below the river bed, so the water in a flooded
 * moat stands at river level and reads as one body with the river.
 */
export function moatFloor(map: MapData): number {
  return map.heights.riverBed - 0.5;
}

/** Top colour per tile kind: bright, saturated board-game ground. */
const COLORS: Record<number, number> = {
  // Saturated but not neon: the first pass (0x8fce4a) read as fluorescent.
  [Kind.GRASS]: 0x7fb34f,
  [Kind.DIRT]: 0xd39d5e,
  [Kind.ROCK]: 0xb9b0a2,
  [Kind.ORE]: 0x9a8b82,
  [Kind.FOREST]: 0x6a9f46,
  // Beds are seen through the water, so they are sand: that is what makes
  // shallow water read as bright turquoise rather than as ink.
  [Kind.RIVER]: 0xe6c88c,
  [Kind.LAKE]: 0xdcbb7c,
  [Kind.ROAD]: 0xecd495,
};

/** Bare earth at the bottom of a moat. */
const MOAT_FLOOR_COLOR = 0x8a6644;

/** Depth of the turf or path layer showing at the top of a cliff. */
const LIP = 0.2;
const LIPPED = new Set<number>([Kind.GRASS, Kind.FOREST, Kind.DIRT, Kind.ROAD]);

// Cliff bands, each a vertical gradient between its low and high colour.
const EARTH_LOW = new THREE.Color(0x8c5f3c);
const EARTH_HIGH = new THREE.Color(0xc08b59);
const ROCK_LOW = new THREE.Color(0x857b70);
const ROCK_HIGH = new THREE.Color(0xc4baac);
const BEDROCK_LOW = new THREE.Color(0x46382f);
const BEDROCK_HIGH = new THREE.Color(0x77614f);
const WATER_EDGE_TOP = new THREE.Color(0x56cbe6);
const WATER_EDGE_LOW = new THREE.Color(0x2a82b8);

/** Lightness swing of the castle ring's checkerboard, which doubles as its grid. */
const CHECKER = 0.022;

const NEIGHBOURS: readonly (readonly [number, number])[] = [
  [0, -1],
  [1, 0],
  [0, 1],
  [-1, 0],
];

type V3 = readonly [number, number, number];

export interface Terrain {
  mesh: THREE.Mesh;
  /** Triangle count, for the perf readout. */
  triangles: number;
  /** Rebuilds the ground with these cells dug out as moat. */
  setDug(dug: ReadonlySet<number>): void;
}

function terrainGeometry(map: MapData, dug: ReadonlySet<number>): THREE.BufferGeometry {
  const positions: number[] = [];
  const colors: number[] = [];

  const half = TILE / 2;
  const bed = map.heights.lakeBed;
  const peak = Math.max(...map.height);
  const floor = moatFloor(map);

  const top = new THREE.Color();
  const lip = new THREE.Color();
  const upper = new THREE.Color();
  const lower = new THREE.Color();

  /** Ground height as dug: a moat cell sits at the moat floor. */
  const groundAt = (x: number, z: number): number =>
    dug.has(z * map.size + x) ? floor : heightAt(map, x, z);

  // Cheap deterministic per-cell jitter: breaks up large flat areas without
  // needing a texture or a noise import.
  const jitter = (x: number, z: number): number => {
    const n = Math.sin(x * 12.9898 + z * 78.233) * 43758.5453;
    return (n - Math.floor(n) - 0.5) * 0.05;
  };

  const push = (v: V3, c: THREE.Color): void => {
    positions.push(v[0], v[1], v[2]);
    colors.push(c.r, c.g, c.b);
  };

  /**
   * Two triangles, counter-clockwise seen from the front. a and d take the
   * first colour, b and c the second — top and bottom edge, on a skirt.
   */
  const quad = (a: V3, b: V3, c: V3, d: V3, ca: THREE.Color, cb: THREE.Color = ca): void => {
    push(a, ca);
    push(b, cb);
    push(c, cb);
    push(a, ca);
    push(c, cb);
    push(d, ca);
  };

  /** Cliff colour at height y: earth or rock above the lake bed, bedrock below it. */
  const band = (y: number, rocky: boolean, belowBed: boolean, out: THREE.Color): THREE.Color => {
    if (belowBed)
      return out.lerpColors(BEDROCK_LOW, BEDROCK_HIGH, (y - TERRAIN_BASE) / (bed - TERRAIN_BASE));
    const t = THREE.MathUtils.clamp((y - bed) / ((rocky ? peak : map.heights.ground) - bed), 0, 1);
    return rocky ? out.lerpColors(ROCK_LOW, ROCK_HIGH, t) : out.lerpColors(EARTH_LOW, EARTH_HIGH, t);
  };

  for (let z = 0; z < map.size; z++) {
    for (let x = 0; x < map.size; x++) {
      const isDug = dug.has(z * map.size + x);
      const h = groundAt(x, z);
      const kind = kindAt(map, x, z);
      const wx = cellToWorldX(x);
      const wz = cellToWorldZ(z);

      // --- top face ---------------------------------------------------------
      top.setHex(isDug ? MOAT_FLOOR_COLOR : (COLORS[kind] ?? COLORS[Kind.GRASS]!));
      top.offsetHSL(
        0,
        0,
        !isDug && canBuild(map, x, z, Build.CASTLE) ? ((x + z) & 1 ? CHECKER : -CHECKER) : jitter(x, z),
      );
      quad(
        [wx - half, h, wz - half],
        [wx - half, h, wz + half],
        [wx + half, h, wz + half],
        [wx + half, h, wz - half],
        top,
      );

      const rocky = !isDug && (kind === Kind.ROCK || kind === Kind.ORE);
      lip.copy(top).multiplyScalar(0.8);

      // --- skirts down to any lower neighbour -------------------------------
      for (const [dx, dz] of NEIGHBOURS) {
        // Off the map, the ground falls away to the bottom of the diorama.
        const onMap = contains(map, x + dx, z + dz);
        const nh = onMap ? groundAt(x + dx, z + dz) : TERRAIN_BASE;
        if (nh >= h) continue;

        // The shared edge between this cell and the lower neighbour.
        const ex = wx + dx * half;
        const ez = wz + dz * half;
        // Perpendicular to the step direction, half a tile each way.
        //
        // The sign of pz is load-bearing. quad emits (a,b,c) with a at edge-p
        // and c at edge+p, so its normal works out to (-pz, 0, px); for that to
        // face outward along (dx, 0, dz) the offset must be (dz, 0, -dx). Using
        // (dz, 0, dx) leaves north/south skirts correct but winds every
        // east/west one backwards, so they get back-face culled and the terrain
        // shows holes along those steps.
        const px = dz * half;
        const pz = -dx * half;
        const wall = (y0: number, y1: number, c0: THREE.Color, c1: THREE.Color): void =>
          quad(
            [ex - px, y0, ez - pz],
            [ex - px, y1, ez - pz],
            [ex + px, y1, ez + pz],
            [ex + px, y0, ez + pz],
            c0,
            c1,
          );

        // Water meeting the map edge, cut away like the side of an aquarium.
        const level = onMap || isDug ? null : waterLevelAt(map, x, z);
        if (level !== null) wall(level, h, WATER_EDGE_TOP, WATER_EDGE_LOW);

        let y = h;
        if (!isDug && LIPPED.has(kind)) {
          const y1 = Math.max(nh, y - LIP);
          wall(y, y1, lip, lip);
          y = y1;
        }
        if (y > bed && nh < y) {
          const y1 = Math.max(nh, bed);
          wall(y, y1, band(y, rocky, false, upper), band(y1, rocky, false, lower));
          y = y1;
        }
        if (nh < y) wall(y, nh, band(y, rocky, true, upper), band(nh, rocky, true, lower));
      }
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();
  return geometry;
}

export function buildTerrain(map: MapData): Terrain {
  const mesh = new THREE.Mesh(
    terrainGeometry(map, new Set()),
    new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true }),
  );
  mesh.name = 'terrain';
  mesh.matrixAutoUpdate = false;

  const count = (geometry: THREE.BufferGeometry): number => (geometry.getAttribute('position')?.count ?? 0) / 3;
  const terrain: Terrain = {
    mesh,
    triangles: count(mesh.geometry),
    setDug(dug) {
      const next = terrainGeometry(map, dug);
      mesh.geometry.dispose();
      mesh.geometry = next;
      terrain.triangles = count(next);
    },
  };
  return terrain;
}
