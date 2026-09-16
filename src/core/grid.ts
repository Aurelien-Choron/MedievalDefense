/**
 * The world grid. Pure data and arithmetic — this module never imports three.js,
 * so the simulation and its node tests can use it directly.
 *
 * All four Kenney kits turned out to be authored on the same one-unit module
 * (measured by tools/build-manifest.mjs), so one world unit is one cell and no
 * conversion is needed anywhere.
 */

export const TILE = 1;

/**
 * Cells per side. 44x44 is a Clash of Clans village: the whole map fits on one
 * screen, so the player defends without scrolling. tools/gen-map.mjs must agree
 * (tests/map.test.ts checks it).
 */
export const MAP_SIZE = 44;

export const CELL_COUNT = MAP_SIZE * MAP_SIZE;

/** Row-major index of a cell. Cheap enough to inline everywhere. */
export function cellIndex(x: number, z: number): number {
  return z * MAP_SIZE + x;
}

export function cellX(index: number): number {
  return index % MAP_SIZE;
}

export function cellZ(index: number): number {
  return (index / MAP_SIZE) | 0;
}

export function inBounds(x: number, z: number): boolean {
  return x >= 0 && z >= 0 && x < MAP_SIZE && z < MAP_SIZE;
}

/**
 * World position of a cell's centre.
 * The grid is centred on the origin so the camera and the map share a midpoint.
 */
export function cellToWorldX(x: number): number {
  return (x - MAP_SIZE / 2 + 0.5) * TILE;
}

export function cellToWorldZ(z: number): number {
  return (z - MAP_SIZE / 2 + 0.5) * TILE;
}

export function worldToCellX(wx: number): number {
  return Math.floor(wx / TILE + MAP_SIZE / 2);
}

export function worldToCellZ(wz: number): number {
  return Math.floor(wz / TILE + MAP_SIZE / 2);
}

/** Neighbour offsets, 4-way then diagonals — the order the flow field walks. */
export const NEIGHBOURS: readonly (readonly [number, number])[] = [
  [0, -1], [1, 0], [0, 1], [-1, 0],
  [1, -1], [1, 1], [-1, 1], [-1, -1],
] as const;
