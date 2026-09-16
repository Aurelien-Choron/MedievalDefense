import * as THREE from 'three';
import { MAP_SIZE, TILE } from '../core/grid.js';

/**
 * From a pointer to the ground under it.
 *
 * The build area is guaranteed flat (tests/map.test.ts), so a ray against the
 * ground plane is exact there — no mesh raycast against the terrain needed.
 */

const raycaster = new THREE.Raycaster();
const ndc = new THREE.Vector2();
const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
const hit = new THREE.Vector3();

export interface GroundHit {
  /** World position on the ground plane. */
  world: THREE.Vector3;
  /** Continuous cell coordinates: cell c spans [c, c + 1). */
  cx: number;
  cz: number;
}

/** The camera ray through a pointer position. Shared: copy it before keeping it. */
export function pointerRay(camera: THREE.Camera, dom: HTMLElement, clientX: number, clientY: number): THREE.Ray {
  const rect = dom.getBoundingClientRect();
  ndc.set(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
  raycaster.setFromCamera(ndc, camera);
  return raycaster.ray;
}

export function groundUnder(
  camera: THREE.Camera,
  dom: HTMLElement,
  clientX: number,
  clientY: number,
  groundY: number,
): GroundHit | null {
  const ray = pointerRay(camera, dom, clientX, clientY);
  plane.constant = -groundY;
  if (!ray.intersectPlane(plane, hit)) return null;
  return {
    world: hit.clone(),
    cx: hit.x / TILE + MAP_SIZE / 2,
    cz: hit.z / TILE + MAP_SIZE / 2,
  };
}

/**
 * The lowest cell of a size x size footprint centred as close as possible to
 * a continuous cell position — so a 2x2 tower sits under the cursor rather
 * than hanging off one corner of it.
 */
export function footprintOrigin(c: number, size: number): number {
  return Math.floor(c - size / 2 + 0.5);
}
