/**
 * Map types and pure accessors.
 *
 * Deliberately does NOT import src/data/map.json: the simulation takes a MapData
 * as a parameter instead. That keeps this module runnable in node with no
 * bundler and no import attributes, and it lets the flow-field and economy tests
 * build tiny synthetic 10x10 maps rather than loading the real one.
 */

export const Kind = {
  GRASS: 0,
  DIRT: 1,
  ROCK: 2,
  ORE: 3,
  FOREST: 4,
  RIVER: 5,
  LAKE: 6,
  ROAD: 7,
} as const;

export type Kind = (typeof Kind)[keyof typeof Kind];

/** Bit flags in MapData.build. */
export const Build = {
  CASTLE: 1,
  /** Near the forest: woodcutter camps. */
  WOOD_CAMP: 2,
  /** Near the ore: miner camps. */
  STONE_CAMP: 4,
  /** Either kind of camp ground. */
  CAMP: 6,
} as const;

export interface Spawn {
  id: string;
  x: number;
  z: number;
  label: string;
}

export interface WaterfallFace {
  x: number;
  z: number;
  /** Direction the water spills, as a unit cell step. */
  dx: number;
  dz: number;
  drop: number;
}

export interface MapData {
  size: number;
  heights: { ground: number; riverBed: number; lakeBed: number };
  water: { river: number; lake: number };
  keep: { x: number; z: number };
  ring: number;
  mine: { x: number; z: number };
  /** The wooden bridge: `halfWidth` lanes either side of column x, spanning rows from..to. */
  bridge: { x: number; from: number; to: number; halfWidth: number };
  spawns: Spawn[];
  riverPath: [number, number][];
  /** Cells under the bridge deck: walkable, although the terrain there is river. */
  bridgeCells: number[];
  /**
   * Forest cells that actually carry a trunk — the woodcutters' nodes. A
   * subset of the forest, so the wood keeps its clearings: which cells they
   * are is game data, decided once by tools/gen-map.mjs, felled by the
   * simulation and merely reflected by src/render/scatter.ts.
   */
  trees: number[];
  waterfall: WaterfallFace[];
  height: number[];
  kind: number[];
  build: number[];
}

export function index(map: MapData, x: number, z: number): number {
  return z * map.size + x;
}

export function contains(map: MapData, x: number, z: number): boolean {
  return x >= 0 && z >= 0 && x < map.size && z < map.size;
}

export function heightAt(map: MapData, x: number, z: number): number {
  return contains(map, x, z) ? (map.height[index(map, x, z)] ?? 0) : 0;
}

export function kindAt(map: MapData, x: number, z: number): Kind {
  return contains(map, x, z) ? ((map.kind[index(map, x, z)] ?? Kind.GRASS) as Kind) : Kind.GRASS;
}

export function isWater(kind: Kind): boolean {
  return kind === Kind.RIVER || kind === Kind.LAKE;
}

export function canBuild(map: MapData, x: number, z: number, flag: number): boolean {
  return contains(map, x, z) && ((map.build[index(map, x, z)] ?? 0) & flag) !== 0;
}

/** Surface height of the water covering a cell, or null if it is dry land. */
export function waterLevelAt(map: MapData, x: number, z: number): number | null {
  const kind = kindAt(map, x, z);
  if (kind === Kind.RIVER) return map.water.river;
  if (kind === Kind.LAKE) return map.water.lake;
  return null;
}

/** Every cell of a given kind, as flat indices. */
export function cellsOfKind(map: MapData, kind: Kind): number[] {
  const out: number[] = [];
  for (let i = 0; i < map.kind.length; i++) if (map.kind[i] === kind) out.push(i);
  return out;
}
