import * as THREE from 'three';
import { cellToWorldX, cellToWorldZ } from '../core/grid.js';
import type { Target } from '../sim/defense.js';

/**
 * Practice targets: the straw men `md.dummy()` drops on the map so the towers
 * have something to shoot at before P4 brings real attackers.
 *
 * Deliberately plain — one pooled InstancedMesh, one draw call, no model from
 * the kits — because none of it survives P4. What does survive is the seam it
 * exercises: sim targets in cell coordinates, drawn here, shot at by
 * src/sim/defense.ts. A target's post reddens as its hit points go.
 */

const HEALTHY = new THREE.Color(0xc8b48a);
const HURT = new THREE.Color(0xc4412f);

export class TargetMarkers {
  readonly mesh: THREE.InstancedMesh;

  private readonly ground: number;
  private readonly matrix = new THREE.Matrix4();
  private readonly position = new THREE.Vector3();
  private readonly quaternion = new THREE.Quaternion();
  private readonly scale = new THREE.Vector3(1, 1, 1);
  private readonly color = new THREE.Color();

  constructor(ground: number, capacity = 64) {
    const geometry = new THREE.CapsuleGeometry(0.22, 0.55, 2, 6);
    geometry.translate(0, 0.5, 0);
    this.ground = ground;
    this.mesh = new THREE.InstancedMesh(geometry, new THREE.MeshLambertMaterial({ flatShading: true }), capacity);
    this.mesh.name = 'practice-targets';
    this.mesh.frustumCulled = false;
    this.mesh.visible = false;
    this.mesh.count = 0;
    for (let i = 0; i < capacity; i++) this.mesh.setColorAt(i, HEALTHY);
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }

  /** Redraws the markers. Cheap enough to call every frame: there are a handful. */
  sync(targets: readonly Target[]): void {
    const count = Math.min(targets.length, this.mesh.instanceMatrix.count);
    for (let i = 0; i < count; i++) {
      const target = targets[i]!;
      const share = target.maxHp > 0 ? Math.max(0, Math.min(1, target.hp / target.maxHp)) : 0;
      this.position.set(cellToWorldX(target.x), this.ground, cellToWorldZ(target.z));
      // A wounded target sags a little as well as reddening.
      this.scale.set(1, 0.75 + 0.25 * share, 1);
      this.mesh.setMatrixAt(i, this.matrix.compose(this.position, this.quaternion, this.scale));
      this.mesh.setColorAt(i, this.color.copy(HURT).lerp(HEALTHY, share));
    }
    this.mesh.count = count;
    this.mesh.visible = count > 0;
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }
}
