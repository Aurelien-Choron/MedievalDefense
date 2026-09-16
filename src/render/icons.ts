import * as THREE from 'three';
import { mergedField, type PlacedPiece } from './assets.js';

/**
 * Menu icons, rendered from the game's own models and materials at boot.
 *
 * Kenney's preview images show his original palette, not ours; rendering the
 * pieces through the same retexturing pass and lights guarantees an icon
 * looks exactly like what lands on the map.
 *
 * Each icon is drawn into a corner of the main canvas and copied out straight
 * away. A WebGL canvas only promises its pixels until the browser composites
 * the frame, so the render and the copy must happen in the same task — which
 * is why everything after the model loading below is synchronous.
 */

export interface IconRequest {
  key: string;
  pieces: PlacedPiece[];
}

const PITCH = Math.atan(1 / Math.SQRT2);
const YAW = Math.PI / 4;

export async function renderIcons(
  renderer: THREE.WebGLRenderer,
  requests: readonly IconRequest[],
  size = 112,
): Promise<Map<string, string>> {
  const groups = await Promise.all(requests.map((r) => mergedField(r.pieces)));
  const icons = new Map<string, string>();
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const context = canvas.getContext('2d');
  if (!context) return icons;

  const scene = new THREE.Scene();
  scene.add(new THREE.HemisphereLight(0xdff1ff, 0x8a7a5c, 1.6));
  const sun = new THREE.DirectionalLight(0xfff0d6, 2.0);
  sun.position.set(60, 90, 40);
  scene.add(sun);
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 200);

  const source = renderer.domElement;
  const pixels = Math.round(size * renderer.getPixelRatio());
  const box = new THREE.Box3();
  const centre = new THREE.Vector3();
  const corner = new THREE.Vector3();

  renderer.setScissorTest(true);
  groups.forEach((group, i) => {
    scene.add(group);
    box.setFromObject(group);
    box.getCenter(centre);
    camera.position.set(
      centre.x + Math.sin(YAW) * Math.cos(PITCH) * 60,
      centre.y + Math.sin(PITCH) * 60,
      centre.z + Math.cos(YAW) * Math.cos(PITCH) * 60,
    );
    camera.lookAt(centre);
    camera.updateMatrixWorld();

    // Fit the model's bounding box, seen from the iso angle, to the square.
    let extent = 0;
    for (let c = 0; c < 8; c++) {
      corner
        .set(c & 1 ? box.max.x : box.min.x, c & 2 ? box.max.y : box.min.y, c & 4 ? box.max.z : box.min.z)
        .applyMatrix4(camera.matrixWorldInverse);
      extent = Math.max(extent, Math.abs(corner.x), Math.abs(corner.y));
    }
    extent *= 1.06;
    camera.left = -extent;
    camera.right = extent;
    camera.top = extent;
    camera.bottom = -extent;
    camera.updateProjectionMatrix();

    renderer.setViewport(0, 0, size, size);
    renderer.setScissor(0, 0, size, size);
    renderer.clear();
    renderer.render(scene, camera);

    context.clearRect(0, 0, size, size);
    // The viewport sits at the bottom-left of the drawing buffer.
    context.drawImage(source, 0, source.height - pixels, pixels, pixels, 0, 0, size, size);
    icons.set(requests[i]!.key, canvas.toDataURL());
    scene.remove(group);
  });
  renderer.setScissorTest(false);
  renderer.setViewport(0, 0, innerWidth, innerHeight);

  for (const group of groups)
    group.traverse((o) => {
      if (o instanceof THREE.Mesh) o.geometry.dispose();
    });
  return icons;
}
