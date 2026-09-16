import * as THREE from 'three';
import { Kind, contains, heightAt, isWater, kindAt, type MapData } from '../core/map.js';
import { cellToWorldX, cellToWorldZ, TILE } from '../core/grid.js';
import { LUMINANCE, meanLuminance } from './detail.js';

/**
 * River, lake and waterfall surfaces.
 *
 * The terrain already carries the river bed and the basin cliff; this only adds
 * the water planes on top, plus a vertical sheet at each waterfall lip. Motion
 * is a scrolling UV offset — three materials, three draw calls.
 *
 * Colour comes from the vertices, graded from a pale tone at the shore to a
 * deep one in open water, so every bank gets a bright rim for free. The retro
 * water texture only adds moving ripples on top, as detail (see detail.ts): on
 * its own it is a dark navy that would sink the whole palette.
 *
 * UVs come from world position, so the texture tiles continuously across cells
 * and no seam shows where two quads meet.
 */

const WATER_TEXTURE = 'assets/kenney/retro-textures/floor_ground_water.png';

/** Texture repeats per world unit: one ripple pattern every four tiles. */
const UV_SCALE = 0.25;

/** Cells of open water between the shore tone and the deep tone. */
const DEPTH_RAMP = 3;

interface Tones {
  shallow: THREE.Color;
  deep: THREE.Color;
}
const RIVER_TONES: Tones = { shallow: new THREE.Color(0xa8f2ee), deep: new THREE.Color(0x3cbde2) };
const LAKE_TONES: Tones = { shallow: new THREE.Color(0xb0f4ee), deep: new THREE.Color(0x2890d4) };
/** Falling water: clear at the lip, churned to foam at the foot. */
const FALLS_TOP = new THREE.Color(0xa9eef8);
const FALLS_FOAM = new THREE.Color(0xffffff);

const EDGES: readonly (readonly [number, number])[] = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
];

export interface Water {
  group: THREE.Group;
  update(elapsed: number): void;
  /** Floods these moat cells: they join the river's surface. */
  setMoats(wet: ReadonlySet<number>): void;
}

/** Steps from each cell to the nearest dry cell: 0 on land, 1 along the bank. */
function shoreDistance(map: MapData, flooded: ReadonlySet<number>): Float32Array {
  const dist = new Float32Array(map.size * map.size).fill(Infinity);
  const queue: number[] = [];
  for (let i = 0; i < dist.length; i++)
    if (!isWater((map.kind[i] ?? Kind.GRASS) as Kind) && !flooded.has(i)) {
      dist[i] = 0;
      queue.push(i);
    }
  for (let head = 0; head < queue.length; head++) {
    const i = queue[head]!;
    const x = i % map.size;
    const z = (i / map.size) | 0;
    for (const [dx, dz] of EDGES) {
      if (!contains(map, x + dx, z + dz)) continue;
      const j = (z + dz) * map.size + x + dx;
      if (dist[j]! <= dist[i]! + 1) continue;
      dist[j] = dist[i]! + 1;
      queue.push(j);
    }
  }
  return dist;
}

function surfaceMaterial(
  texture: THREE.Texture,
  mean: { value: number },
  detail: number,
  opacity: number,
): THREE.MeshLambertMaterial {
  const material = new THREE.MeshLambertMaterial({
    map: texture,
    vertexColors: true,
    transparent: true,
    opacity,
    depthWrite: false,
  });
  material.onBeforeCompile = (shader) => {
    shader.uniforms.mdMean = mean;
    shader.uniforms.mdDetail = { value: detail };
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
        uniform float mdMean;
        uniform float mdDetail;`,
      )
      .replace(
        '#include <map_fragment>',
        `vec4 mdTexel = texture2D( map, vMapUv );
        diffuseColor.rgb *= mix( 1.0, dot( mdTexel.rgb, ${LUMINANCE} ) / mdMean, mdDetail );`,
      );
  };
  material.customProgramCacheKey = () => 'water-detail';
  return material;
}

/** Builds a horizontal sheet covering every cell it is told to, shaded by depth. */
function horizontalSheet(
  map: MapData,
  covers: (x: number, z: number) => boolean,
  y: number,
  tones: Tones,
  shore: Float32Array,
): THREE.BufferGeometry | null {
  const positions: number[] = [];
  const colors: number[] = [];
  const uvs: number[] = [];
  const half = TILE / 2;
  const tone = new THREE.Color();

  /** Depth at a cell corner: the shallowest of the (on-map) cells meeting there. */
  const cornerDepth = (vx: number, vz: number): number => {
    let depth = Infinity;
    for (const [cx, cz] of [
      [vx - 1, vz - 1],
      [vx, vz - 1],
      [vx - 1, vz],
      [vx, vz],
    ] as const)
      if (contains(map, cx, cz)) depth = Math.min(depth, shore[cz * map.size + cx]!);
    return depth;
  };

  for (let z = 0; z < map.size; z++)
    for (let x = 0; x < map.size; x++) {
      if (!covers(x, z)) continue;
      const corners: [number, number][] = [
        [x, z],
        [x, z + 1],
        [x + 1, z + 1],
        [x + 1, z],
      ];
      for (const i of [0, 1, 2, 0, 2, 3]) {
        const [vx, vz] = corners[i]!;
        // cellToWorld gives a cell's centre; its low corner is half a tile back.
        const cx = cellToWorldX(vx) - half;
        const cz = cellToWorldZ(vz) - half;
        positions.push(cx, y, cz);
        uvs.push(cx * UV_SCALE, cz * UV_SCALE);
        tone.lerpColors(tones.shallow, tones.deep, Math.min(cornerDepth(vx, vz) / DEPTH_RAMP, 1));
        colors.push(tone.r, tone.g, tone.b);
      }
    }

  if (!positions.length) return null;
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geometry.computeVertexNormals();
  return geometry;
}

/**
 * Builds the vertical sheets where the river pours over a drop.
 *
 * Every river edge above lower ground gets one, not only the river-to-lake lips
 * listed in map.waterfall. Beside the falls the river also meets the dry basin
 * rim, and without a sheet there the water surface — which stands above its
 * bed — shows a raised edge floating in mid-air like a pane of glass.
 */
function fallSheet(map: MapData): THREE.BufferGeometry | null {
  const positions: number[] = [];
  const colors: number[] = [];
  const uvs: number[] = [];
  const half = TILE / 2;
  const top = map.water.river;

  for (let z = 0; z < map.size; z++)
    for (let x = 0; x < map.size; x++) {
      if (kindAt(map, x, z) !== Kind.RIVER) continue;
      for (const [dx, dz] of EDGES) {
        // At the map edge the terrain draws the water in cross-section instead.
        if (!contains(map, x + dx, z + dz)) continue;
        const bottom = heightAt(map, x + dx, z + dz);
        if (bottom >= heightAt(map, x, z)) continue;

        // Sit the sheet a hair beyond the lip so it never z-fights the cliff face.
        const ex = cellToWorldX(x) + dx * (half + 0.02);
        const ez = cellToWorldZ(z) + dz * (half + 0.02);
        // Same winding rule as the terrain skirts: (dz, -dx) faces the drop.
        const px = dz * half;
        const pz = -dx * half;

        const corners: [number, number, number][] = [
          [ex - px, top, ez - pz],
          [ex - px, bottom, ez - pz],
          [ex + px, bottom, ez + pz],
          [ex + px, top, ez + pz],
        ];
        const height = top - bottom;
        const vs = [0, height, height, 0];
        for (const i of [0, 1, 2, 0, 2, 3]) {
          const [cx, cy, cz] = corners[i]!;
          const tone = vs[i] ? FALLS_FOAM : FALLS_TOP;
          positions.push(cx, cy, cz);
          colors.push(tone.r, tone.g, tone.b);
          uvs.push((i === 0 || i === 1 ? 0 : 1) * TILE * UV_SCALE, vs[i]! * UV_SCALE * 2);
        }
      }
    }

  if (!positions.length) return null;
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geometry.computeVertexNormals();
  return geometry;
}

export function buildWater(map: MapData): Water {
  const group = new THREE.Group();
  group.name = 'water';

  // Each surface needs its own texture object — the offset lives on the
  // texture, and river, lake and falls all scroll differently — but they share
  // one image. The copies are only flagged for upload once that image exists.
  const mean = { value: 0.5 };
  const textures: THREE.Texture[] = [];
  const base = new THREE.TextureLoader().load(WATER_TEXTURE, (loaded) => {
    mean.value = meanLuminance(loaded.image);
    for (const texture of textures) texture.needsUpdate = true;
  });
  base.wrapS = THREE.RepeatWrapping;
  base.wrapT = THREE.RepeatWrapping;
  // Ripples are a soft overlay now, not pixel art: filtering keeps them from
  // shimmering at the zoomed-out, whole-map view.
  base.magFilter = THREE.LinearFilter;
  base.minFilter = THREE.LinearMipmapLinearFilter;
  base.colorSpace = THREE.SRGBColorSpace;
  const copy = (): THREE.Texture => {
    const texture = base.clone();
    textures.push(texture);
    return texture;
  };

  const river = surfaceMaterial(copy(), mean, 0.35, 0.82);
  const lake = surfaceMaterial(copy(), mean, 0.3, 0.9);
  const falls = surfaceMaterial(copy(), mean, 0.35, 0.95);
  // A vertical sheet catches barely two thirds of the light a flat surface
  // does, which turned white water pewter grey. A little self-lighting keeps
  // it reading as bright, churning water from any side.
  falls.emissive.setHex(0x6f98a2);

  const noMoats = new Set<number>();
  // Flooded moat shares the river's sheet: same level, same material, one
  // body of water — and no extra draw call however much moat is dug.
  const riverGeometry = (wet: ReadonlySet<number>): THREE.BufferGeometry =>
    horizontalSheet(
      map,
      (x, z) => kindAt(map, x, z) === Kind.RIVER || wet.has(z * map.size + x),
      map.water.river,
      RIVER_TONES,
      shoreDistance(map, wet),
    ) ?? new THREE.BufferGeometry();

  const riverMesh = new THREE.Mesh(riverGeometry(noMoats), river);
  const pieces: [THREE.BufferGeometry | null, THREE.Material, string][] = [
    [
      horizontalSheet(map, (x, z) => kindAt(map, x, z) === Kind.LAKE, map.water.lake, LAKE_TONES, shoreDistance(map, noMoats)),
      lake,
      'lake',
    ],
    [fallSheet(map), falls, 'waterfall'],
  ];

  riverMesh.name = 'river';
  riverMesh.matrixAutoUpdate = false;
  riverMesh.renderOrder = 1; // after opaque terrain, so blending is correct
  group.add(riverMesh);
  for (const [geometry, material, name] of pieces) {
    if (!geometry) continue;
    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = name;
    mesh.matrixAutoUpdate = false;
    mesh.renderOrder = 1;
    group.add(mesh);
  }

  return {
    group,
    setMoats(wet: ReadonlySet<number>): void {
      riverMesh.geometry.dispose();
      riverMesh.geometry = riverGeometry(wet);
    },
    update(elapsed: number): void {
      // The river drifts along its run, the lake barely stirs, and the falls
      // pour downward fast enough to read as falling water.
      river.map!.offset.set(elapsed * 0.02, elapsed * 0.03);
      lake.map!.offset.set(Math.sin(elapsed * 0.1) * 0.03, elapsed * 0.008);
      falls.map!.offset.set(0, -elapsed * 0.9);
    },
  };
}
