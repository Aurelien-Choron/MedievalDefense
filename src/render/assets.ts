import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { NATURE_PALETTE, NATURE_SKINS } from '../data/palette.js';
import { RETRO_RULES, makeRetroMaterial, retroEnabled, ruleFor } from './retro.js';

/**
 * Loads Kenney GLBs once and hands out cheap clones or instanced fields.
 *
 * Materials are de-duplicated by `kit:materialName`, which matters more than it
 * looks. Every kit reuses a handful of named materials across all of its models
 * — the Castle Kit's 76 models share one "colormap" material, the Nature Kit's
 * 329 share 23 named colours — but each GLB is parsed independently, so every
 * file arrives with its own material *and its own texture object* for the same
 * image. Keying on the texture would therefore never dedupe anything; keying on
 * the name collapses a whole kit down to a few materials, which is what lets
 * InstancedMesh batch across models.
 */

export type KitName = 'castle' | 'town' | 'nature' | 'retro';

const loader = new GLTFLoader();
const cache = new Map<string, Promise<THREE.Object3D>>();
const materials = new Map<string, THREE.MeshLambertMaterial>();
/** Each kit's colormap, as first seen — what a skin repaints. */
const kitAtlas = new Map<KitName, THREE.Texture>();

/** ?raw=1 keeps Kenney's shipped palette instead of the medieval remap. */
const useRawPalette =
  typeof location !== 'undefined' && new URLSearchParams(location.search).get('raw') === '1';

function shareMaterial(
  kit: KitName,
  model: string,
  source: THREE.Material,
): THREE.MeshLambertMaterial {
  const src = source as THREE.MeshStandardMaterial;
  if (src.map && !kitAtlas.has(kit)) kitAtlas.set(kit, src.map);

  // A retro rule collapses every model it matches onto one material, so the
  // whole Castle Kit ends up sharing a single stone material rather than one
  // per model. Without a rule we fall back to the kit's own named material.
  const rule = ruleFor(kit, model);
  const key = rule ? `retro:${rule.id}` : `${kit}:${src.name || 'unnamed'}`;

  let shared = materials.get(key);
  if (!shared) {
    if (rule) {
      // Every model in a kit shares one colormap image, so whichever model
      // creates the material first supplies the atlas for all of them.
      shared = makeRetroMaterial(rule, kit, src.map ?? null);
    } else {
      const override = useRawPalette ? undefined : NATURE_PALETTE[src.name ?? ''];
      shared = new THREE.MeshLambertMaterial({
        map: src.map ?? null,
        color:
          override !== undefined
            ? new THREE.Color(override)
            : src.color
              ? src.color.clone()
              : new THREE.Color(0xffffff),
      });
      if (shared.map) shared.map.colorSpace = THREE.SRGBColorSpace;
    }
    // Kept so a Nature Kit skin can find the material by its colour name.
    shared.name = rule ? rule.id : (src.name ?? '');
    materials.set(key, shared);
  }
  return shared;
}

/**
 * The shared material for a retro rule picked by id rather than by model name.
 *
 * Skins are how one model serves several looks: the same hexagonal tower base
 * in stone or in timber, the same roof in thatch, tile or slate for each keep
 * tier. Only meaningful on the atlas kits (castle, town).
 */
function skinMaterial(kit: KitName, skin: string, fallback: THREE.Material): THREE.Material {
  // The Nature Kit has no atlas to repaint: its skins recolour named materials.
  if (kit === 'nature') {
    const color = useRawPalette ? undefined : NATURE_SKINS[skin]?.[fallback.name];
    if (color === undefined) return fallback;
    const key = `nature:${fallback.name}@${skin}`;
    let shared = materials.get(key);
    if (!shared) {
      shared = (fallback as THREE.MeshLambertMaterial).clone();
      shared.color.setHex(color);
      materials.set(key, shared);
    }
    return shared;
  }

  const rule = retroEnabled ? RETRO_RULES.find((r) => r.id === skin) : undefined;
  if (!rule) return fallback;
  const key = `retro:${rule.id}`;
  let shared = materials.get(key);
  if (!shared) {
    shared = makeRetroMaterial(rule, kit, kitAtlas.get(kit) ?? null);
    materials.set(key, shared);
  }
  return shared;
}

/** Distinct materials currently alive — surfaced in the perf readout. */
export function materialCount(): number {
  return materials.size;
}

/**
 * Every shared material, as `kit:name -> #hex (textured?)`. The P1 retexturing
 * pass is driven entirely off these keys, so being able to read them back from
 * the console (or from tools/smoke.mjs) is how that table gets written.
 */
export function describeMaterials(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, mat] of materials)
    out[key] = `#${mat.color.getHexString()}${mat.map ? ' +tex' : ''}`;
  return out;
}

export function modelPath(kit: KitName, model: string): string {
  return `assets/kenney/${kit}/${model}.glb`;
}

export function loadModel(kit: KitName, model: string): Promise<THREE.Object3D> {
  const key = `${kit}/${model}`;
  let pending = cache.get(key);
  if (!pending) {
    pending = new Promise<THREE.Object3D>((resolve, reject) => {
      loader.load(
        modelPath(kit, model),
        (gltf) => {
          gltf.scene.traverse((o) => {
            const mesh = o as THREE.Mesh;
            if (!mesh.isMesh) return;
            mesh.material = shareMaterial(kit, model, mesh.material as THREE.Material);
            mesh.castShadow = false;
            mesh.receiveShadow = false;
          });
          resolve(gltf.scene);
        },
        undefined,
        reject,
      );
    });
    cache.set(key, pending);
  }
  return pending;
}

/** A ready-to-place clone. Clones share geometry and material with the original. */
export async function instantiate(kit: KitName, model: string): Promise<THREE.Object3D> {
  return (await loadModel(kit, model)).clone(true);
}

/** Warms the cache for a batch of models in parallel, reporting progress. */
export async function preload(
  models: readonly (readonly [KitName, string])[],
  onProgress?: (done: number, total: number) => void,
): Promise<void> {
  const unique = [...new Set(models.map(([k, m]) => `${k}/${m}`))];
  let done = 0;
  await Promise.all(
    unique.map(async (key) => {
      const [kit, model] = key.split('/') as [KitName, string];
      try {
        await loadModel(kit, model);
      } catch (err) {
        console.warn(`failed to load ${key}`, err);
      }
      onProgress?.(++done, unique.length);
    }),
  );
}

export interface Placement {
  x: number;
  z: number;
  y?: number;
  /** Y rotation in degrees. */
  rotation?: number;
  /** Uniform, or per axis in the model's own frame (applied before rotation). */
  scale?: number | readonly [number, number, number];
}

export interface PlacedPiece {
  kit: KitName;
  model: string;
  placement: Placement;
  /** A retro rule id to dress the model in, instead of the one its name selects. */
  skin?: string;
}

/** One mesh of a model: its geometry, the material it renders with, and its node transform. */
export interface ModelPart {
  geometry: THREE.BufferGeometry;
  material: THREE.Material;
  matrix: THREE.Matrix4;
}

const partCache = new Map<string, Promise<ModelPart[]>>();

/** A model broken into its meshes, with an optional skin applied to all of them. */
export function partsOf(kit: KitName, model: string, skin?: string): Promise<ModelPart[]> {
  const key = `${kit}/${model}#${skin ?? ''}`;
  let pending = partCache.get(key);
  if (!pending) {
    pending = loadModel(kit, model).then((root) => {
      root.updateMatrixWorld(true);
      const parts: ModelPart[] = [];
      root.traverse((o) => {
        const mesh = o as THREE.Mesh;
        if (!mesh.isMesh) return;
        const material = mesh.material as THREE.Material;
        parts.push({
          geometry: mesh.geometry,
          material: skin ? skinMaterial(kit, skin, material) : material,
          matrix: mesh.matrixWorld.clone(),
        });
      });
      return parts;
    });
    partCache.set(key, pending);
  }
  return pending;
}

const dummy = new THREE.Object3D();

/** Writes a placement's transform into `out`. */
export function placementMatrix(placement: Placement, out: THREE.Matrix4): THREE.Matrix4 {
  dummy.position.set(placement.x, placement.y ?? 0, placement.z);
  dummy.rotation.set(0, THREE.MathUtils.degToRad(placement.rotation ?? 0), 0);
  const scale = placement.scale ?? 1;
  if (typeof scale === 'number') dummy.scale.setScalar(scale);
  else dummy.scale.set(scale[0], scale[1], scale[2]);
  dummy.updateMatrix();
  return out.copy(dummy.matrix);
}

/** Kenney GLBs carry varying attribute sets; merging needs them uniform. */
const MERGE_ATTRIBUTES = ['position', 'normal', 'uv'] as const;

function forMerging(geometry: THREE.BufferGeometry, matrix: THREE.Matrix4): THREE.BufferGeometry {
  const out = new THREE.BufferGeometry();
  for (const name of MERGE_ATTRIBUTES) {
    const attribute = geometry.getAttribute(name);
    // mergeGeometries rejects the whole batch if one geometry lacks an
    // attribute the others have, so fill in a zeroed stand-in rather than
    // dropping the piece.
    if (attribute) out.setAttribute(name, attribute.clone());
    else {
      const count = geometry.getAttribute('position')?.count ?? 0;
      const size = name === 'uv' ? 2 : 3;
      out.setAttribute(name, new THREE.BufferAttribute(new Float32Array(count * size), size));
    }
  }
  if (geometry.index) out.setIndex(geometry.index.clone());
  out.applyMatrix4(matrix);
  return out;
}

/**
 * Bakes a set of static pieces into one merged mesh **per material**.
 *
 * This is the counterpart to instancedField, and which one to reach for depends
 * on how the pieces change. Instancing wins when one model repeats many times
 * and individual copies need to appear or vanish — a felled tree just gets a
 * zero-scale matrix. Merging wins for everything static and varied: the retro
 * pass already collapses a whole kit onto a single material, so the entire
 * castle merges down to one draw call, where instancing would cost one per
 * distinct model whether it appeared once or a hundred times.
 */
export async function mergedField(pieces: readonly PlacedPiece[]): Promise<THREE.Group> {
  const group = new THREE.Group();
  if (!pieces.length) return group;

  await preload(pieces.map((p) => [p.kit, p.model] as const));

  const byMaterial = new Map<THREE.Material, THREE.BufferGeometry[]>();
  const placed = new THREE.Matrix4();

  for (const { kit, model, placement, skin } of pieces) {
    let parts: ModelPart[];
    try {
      parts = await partsOf(kit, model, skin);
    } catch {
      continue; // preload has already warned about it
    }
    placementMatrix(placement, placed);
    for (const part of parts) {
      // Keep the model's own internal node transform, or Kenney's off-origin
      // pieces land misaligned on the grid.
      const matrix = placed.clone().multiply(part.matrix);
      let list = byMaterial.get(part.material);
      if (!list) byMaterial.set(part.material, (list = []));
      list.push(forMerging(part.geometry, matrix));
    }
  }

  for (const [material, geometries] of byMaterial) {
    const merged = mergeGeometries(geometries, false);
    if (!merged) continue;
    merged.computeBoundingSphere();
    const mesh = new THREE.Mesh(merged, material);
    mesh.matrixAutoUpdate = false;
    group.add(mesh);
    for (const geometry of geometries) geometry.dispose();
  }
  return group;
}

/**
 * Merges many copies of one model into InstancedMeshes — one per sub-mesh of the
 * source model. A field of 9000 ground tiles costs a single draw call this way,
 * which is what the whole rendering budget depends on.
 */
export async function instancedField(
  kit: KitName,
  model: string,
  placements: readonly Placement[],
): Promise<THREE.Group> {
  const root = await loadModel(kit, model);
  const group = new THREE.Group();
  group.name = `${kit}/${model}`;
  if (placements.length === 0) return group;

  root.updateMatrixWorld(true);
  const parts: { geometry: THREE.BufferGeometry; material: THREE.Material; matrix: THREE.Matrix4 }[] =
    [];
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (mesh.isMesh)
      parts.push({
        geometry: mesh.geometry,
        material: mesh.material as THREE.Material,
        matrix: mesh.matrixWorld.clone(),
      });
  });

  const placed = new THREE.Matrix4();
  for (const part of parts) {
    const mesh = new THREE.InstancedMesh(part.geometry, part.material, placements.length);
    placements.forEach((p, i) => {
      // Keep the model's own internal node transform, or Kenney's off-origin
      // pieces end up misaligned on the grid.
      mesh.setMatrixAt(i, placementMatrix(p, placed).multiply(part.matrix));
    });
    mesh.instanceMatrix.needsUpdate = true;
    mesh.frustumCulled = false;
    group.add(mesh);
  }
  return group;
}
