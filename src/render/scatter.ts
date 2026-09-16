import * as THREE from 'three';
import { Kind, heightAt, kindAt, type MapData } from '../core/map.js';
import { cellToWorldX, cellToWorldZ } from '../core/grid.js';
import { instancedField, preload, type KitName, type Placement } from './assets.js';

/**
 * Populates the map with Kenney props — forest, mountain rock, the mine mouth,
 * the waterfall's cliff panels, and ground cover.
 *
 * One InstancedMesh per model, built once. Every prop is addressed by the cell
 * it stands on, so a building hides what grows under it and a woodcutter takes
 * a trunk away by writing a zero-scale matrix into its instance, rather than
 * rebuilding the buffer. Which cells carry a trunk at all is map data
 * (`MapData.trees`); which of them are still standing is the simulation's
 * business (src/sim/forest.ts). Nothing about the wood is decided here.
 */

export interface Scatter {
  group: THREE.Group;
  models: number;
  /**
   * Hides the props standing on these cells, and brings back all the others.
   * This is the one way anything disappears from the decor — a building covers
   * its ground, a woodcutter takes a trunk away. src/main.ts hands it both sets
   * at once.
   */
  setHidden(cells: ReadonlySet<number>): void;
}

/** Broadleaf for the lowland wood, pine for the mountain skirts. */
const BROADLEAF = ['tree_oak', 'tree_default', 'tree_tall', 'tree_detailed', 'tree_simple', 'tree_fat'];
const PINE = ['tree_pineRoundA', 'tree_pineRoundC', 'tree_pineTallA', 'tree_pineDefaultB', 'tree_pineSmallB'];
const BOULDERS = ['rock_tallA', 'rock_tallD', 'rock_largeB', 'rock_smallC', 'stone_tallB', 'stone_largeD'];
const GROUND_COVER = ['grass_large', 'grass_leafs', 'flower_redA', 'flower_yellowB', 'mushroom_redGroup'];

/** Deterministic RNG so the forest is identical on every reload. */
function makeRandom(seed: number): () => number {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 0x100000000);
}

export async function buildScatter(map: MapData): Promise<Scatter> {
  const random = makeRandom(0x5eed);
  // Which forest cells carry a trunk is map data, not a roll made here: the
  // simulation fells those very cells and counts them back up, and this file
  // only ever shows or hides what it is told (see src/sim/forest.ts).
  const trees = new Set(map.trees);
  const group = new THREE.Group();
  group.name = 'scatter';

  // Placements are gathered per model first, then each model is instanced once.
  const byModel = new Map<string, Placement[]>();
  /** Which cell produced each placement. */
  const cellsByModel = new Map<string, number[]>();

  const add = (kit: KitName, model: string, placement: Placement, cell?: number): void => {
    const key = `${kit}/${model}`;
    let list = byModel.get(key);
    if (!list) byModel.set(key, (list = []));
    list.push(placement);
    if (cell !== undefined) {
      let cells = cellsByModel.get(key);
      if (!cells) cellsByModel.set(key, (cells = []));
      cells[list.length - 1] = cell;
    }
  };

  const pick = <T>(list: readonly T[]): T => list[Math.floor(random() * list.length)]!;

  for (let z = 0; z < map.size; z++) {
    for (let x = 0; x < map.size; x++) {
      const cell = z * map.size + x;
      const kind = kindAt(map, x, z);
      const h = heightAt(map, x, z);
      const wx = cellToWorldX(x);
      const wz = cellToWorldZ(z);
      // Jitter within the cell so the grid doesn't show through the foliage.
      const ox = (random() - 0.5) * 0.55;
      const oz = (random() - 0.5) * 0.55;

      if (kind === Kind.FOREST) {
        if (trees.has(cell)) {
          // Pines take over as the ground climbs toward the mountain.
          const conifer = h > map.heights.ground || random() < 0.18;
          add(
            'nature',
            pick(conifer ? PINE : BROADLEAF),
            { x: wx + ox, z: wz + oz, y: h, rotation: random() * 360, scale: 0.8 + random() * 0.5 },
            cell,
          );
        } else if (random() < 0.25) {
          add('nature', pick(GROUND_COVER), { x: wx + ox, z: wz + oz, y: h, rotation: random() * 360 }, cell);
        }
      } else if (kind === Kind.ROCK) {
        if (random() < 0.09)
          add(
            'nature',
            pick(BOULDERS),
            { x: wx + ox, z: wz + oz, y: h, rotation: random() * 360, scale: 0.9 + random() * 0.8 },
            cell,
          );
        // A thin pine line on the lower slopes keeps the mountain from reading bare.
        else if (h <= map.heights.ground + 2 && random() < 0.06)
          add(
            'nature',
            pick(PINE),
            { x: wx + ox, z: wz + oz, y: h, rotation: random() * 360, scale: 0.7 + random() * 0.3 },
            cell,
          );
      } else if (kind === Kind.ORE) {
        if (random() < 0.3)
          add(
            'nature',
            pick(['stone_tallC', 'stone_largeA', 'stone_smallB']),
            { x: wx + ox, z: wz + oz, y: h, rotation: random() * 360, scale: 0.8 + random() * 0.6 },
            cell,
          );
      } else if (kind === Kind.GRASS) {
        if (random() < 0.035)
          add('nature', pick(GROUND_COVER), { x: wx + ox, z: wz + oz, y: h, rotation: random() * 360 }, cell);
        else if (random() < 0.004)
          add(
            'nature',
            pick(BROADLEAF),
            { x: wx + ox, z: wz + oz, y: h, rotation: random() * 360, scale: 0.8 + random() * 0.4 },
            cell,
          );
      } else if (kind === Kind.LAKE && random() < 0.02) {
        add('nature', pick(['lily_large', 'lily_small']), {
          x: wx + ox,
          z: wz + oz,
          y: map.water.lake,
          rotation: random() * 360,
        });
      }
    }
  }

  // --- the mine mouth, set into the mountain face -----------------------------
  // Faces whichever way the ground falls away, so it reads as cut into rock.
  const mineH = heightAt(map, map.mine.x, map.mine.z);
  let mineFacing = 0;
  let lowest = Infinity;
  for (const [dx, dz, deg] of [
    [0, 1, 0],
    [1, 0, 90],
    [0, -1, 180],
    [-1, 0, 270],
  ] as const) {
    const nh = heightAt(map, map.mine.x + dx * 2, map.mine.z + dz * 2);
    if (nh < lowest) {
      lowest = nh;
      mineFacing = deg;
    }
  }
  add('nature', 'cliff_cave_rock', {
    x: cellToWorldX(map.mine.x),
    z: cellToWorldZ(map.mine.z),
    y: mineH,
    rotation: mineFacing,
  });

  // --- Kenney's own waterfall panels, dressing the basin lip -------------------
  for (const face of map.waterfall) {
    const degrees = face.dz === 1 ? 0 : face.dx === 1 ? 90 : face.dz === -1 ? 180 : 270;
    add('nature', 'cliff_waterfallTop_rock', {
      x: cellToWorldX(face.x),
      z: cellToWorldZ(face.z),
      y: heightAt(map, face.x, face.z),
      rotation: degrees,
    });
  }

  // --- instance everything ----------------------------------------------------
  const keys = [...byModel.keys()];
  await preload(keys.map((k) => k.split('/') as [KitName, string]));

  const propsAt = new Map<number, { mesh: THREE.InstancedMesh; index: number }[]>();
  for (const key of keys) {
    const [kit, model] = key.split('/') as [KitName, string];
    const placements = byModel.get(key)!;
    const field = await instancedField(kit, model, placements);
    group.add(field);

    const cells = cellsByModel.get(key);
    if (!cells) continue;
    for (const [instance, cell] of cells.entries()) {
      if (cell === undefined) continue;
      let props = propsAt.get(cell);
      if (!props) propsAt.set(cell, (props = []));
      for (const mesh of field.children) if (mesh instanceof THREE.InstancedMesh) props.push({ mesh, index: instance });
    }
  }

  // Hiding writes a zero-scale matrix and keeps the real one to put back.
  const hidden = new Set<number>();
  const saved = new Map<string, THREE.Matrix4>();
  const zero = new THREE.Matrix4().makeScale(0, 0, 0);
  const setHidden = (cells: ReadonlySet<number>): void => {
    const touched = new Set<THREE.InstancedMesh>();
    for (const cell of hidden) {
      if (cells.has(cell)) continue;
      for (const { mesh, index } of propsAt.get(cell) ?? []) {
        const key = `${mesh.id}:${index}`;
        const matrix = saved.get(key);
        if (matrix) mesh.setMatrixAt(index, matrix);
        saved.delete(key);
        touched.add(mesh);
      }
      hidden.delete(cell);
    }
    for (const cell of cells) {
      if (hidden.has(cell)) continue;
      const props = propsAt.get(cell);
      if (!props) continue;
      for (const { mesh, index } of props) {
        const matrix = new THREE.Matrix4();
        mesh.getMatrixAt(index, matrix);
        saved.set(`${mesh.id}:${index}`, matrix);
        mesh.setMatrixAt(index, zero);
        touched.add(mesh);
      }
      hidden.add(cell);
    }
    for (const mesh of touched) mesh.instanceMatrix.needsUpdate = true;
  };

  return { group, models: keys.length, setHidden };
}
