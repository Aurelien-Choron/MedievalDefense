import * as THREE from 'three';
import type { Projectile } from '../data/buildings.js';

/**
 * Everything the defences throw, in one pooled InstancedMesh — a single draw
 * call however many shafts are in the air, which is what the budget allows for
 * projectiles (see docs/brief.md).
 *
 * The flight is pure decoration: src/sim/defense.ts has already taken the hit
 * points off when the shot left. So a shaft here can be dropped, clipped or
 * skipped without the simulation ever noticing, and its arc is chosen to read
 * well from the isometric angle rather than to be ballistically true.
 *
 * Per-shaft colour rides on the instance colour buffer rather than on separate
 * materials, so arrows, bolts and dropped stones still share the one call.
 */

interface Style {
  color: number;
  /** Metres per second along the ground, and how high the arc lifts. */
  speed: number;
  arc: number;
  /** Scale of the shared shaft geometry: x and y across, z along the flight. */
  scale: readonly [number, number, number];
  /** Whether it points where it is going. A stone just falls. */
  aligns: boolean;
}

// Dark shafts against a bright board: an arrow has to read over grass, sand
// and stone alike, and at this zoom a pale one disappears into the road.
const STYLE: Readonly<Record<Projectile, Style>> = {
  arrow: { color: 0x4a3220, speed: 15, arc: 0.5, scale: [1, 1, 1], aligns: true },
  bolt: { color: 0x36404e, speed: 22, arc: 0.28, scale: [1.15, 1.15, 1.35], aligns: true },
  stone: { color: 0x6f6a62, speed: 7, arc: 0.1, scale: [2.4, 2.4, 1.3], aligns: false },
};

/** Below this the flight is not worth drawing: the shaft would flash and vanish. */
const MIN_FLIGHT = 0.06;

interface Shaft {
  from: THREE.Vector3;
  to: THREE.Vector3;
  arc: number;
  age: number;
  life: number;
  aligns: boolean;
  scale: THREE.Vector3;
}

const UP = new THREE.Vector3(0, 1, 0);
const FORWARD = new THREE.Vector3(0, 0, 1);
const scratchColor = new THREE.Color();

/** A slim four-sided shaft pointing along +z, so a lookAt-style turn aims it. */
function shaftGeometry(): THREE.BufferGeometry {
  const geometry = new THREE.CylinderGeometry(0.055, 0.012, 0.58, 4, 1);
  geometry.rotateX(-Math.PI / 2);
  return geometry;
}

export class Projectiles {
  readonly mesh: THREE.InstancedMesh;

  private readonly shafts: Shaft[] = [];
  private next = 0;
  private readonly matrix = new THREE.Matrix4();
  private readonly position = new THREE.Vector3();
  private readonly ahead = new THREE.Vector3();
  private readonly direction = new THREE.Vector3();
  private readonly quaternion = new THREE.Quaternion();
  private readonly hidden = new THREE.Matrix4().makeScale(0, 0, 0);

  constructor(capacity = 96) {
    this.mesh = new THREE.InstancedMesh(
      shaftGeometry(),
      new THREE.MeshLambertMaterial({ flatShading: true }),
      capacity,
    );
    this.mesh.name = 'projectiles';
    this.mesh.frustumCulled = false;
    this.mesh.visible = false;
    for (let i = 0; i < capacity; i++) {
      this.shafts.push({
        from: new THREE.Vector3(),
        to: new THREE.Vector3(),
        arc: 0,
        age: 1,
        life: 0,
        aligns: true,
        scale: new THREE.Vector3(1, 1, 1),
      });
      this.mesh.setMatrixAt(i, this.hidden);
      this.mesh.setColorAt(i, new THREE.Color(0xffffff));
    }
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }

  /** Looses one shaft from a muzzle to where the target stood, in world units. */
  fire(
    fromX: number,
    fromY: number,
    fromZ: number,
    toX: number,
    toY: number,
    toZ: number,
    kind: Projectile,
  ): void {
    const style = STYLE[kind];
    const shaft = this.shafts[this.next]!;
    const index = this.next;
    this.next = (this.next + 1) % this.shafts.length;

    shaft.from.set(fromX, fromY, fromZ);
    shaft.to.set(toX, toY, toZ);
    const distance = shaft.from.distanceTo(shaft.to);
    shaft.life = Math.max(MIN_FLIGHT, distance / style.speed);
    // A long shot hangs higher, the way a volley does.
    shaft.arc = style.arc * Math.max(1, distance * 0.35);
    shaft.age = 0;
    shaft.aligns = style.aligns;
    shaft.scale.set(style.scale[0], style.scale[1], style.scale[2]);
    this.mesh.setColorAt(index, scratchColor.setHex(style.color));
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
    this.mesh.visible = true;
  }

  update(dt: number): void {
    let flying = 0;
    this.shafts.forEach((shaft, i) => {
      if (shaft.age >= shaft.life) return;
      shaft.age += dt;
      const t = shaft.age / shaft.life;
      if (t >= 1) {
        this.mesh.setMatrixAt(i, this.hidden);
        return;
      }
      flying++;
      this.at(shaft, t, this.position);
      if (shaft.aligns) {
        // Aim along the flight itself, sampled a moment ahead, so a shaft noses
        // over at the top of its arc instead of pointing flat at the target.
        this.at(shaft, Math.min(1, t + 0.05), this.ahead);
        this.direction.subVectors(this.ahead, this.position);
        if (this.direction.lengthSq() < 1e-8) this.direction.copy(FORWARD);
        this.quaternion.setFromUnitVectors(FORWARD, this.direction.normalize());
      } else {
        this.quaternion.setFromAxisAngle(UP, shaft.age * 9);
      }
      this.mesh.setMatrixAt(i, this.matrix.compose(this.position, this.quaternion, shaft.scale));
    });
    this.mesh.instanceMatrix.needsUpdate = true;
    // Nothing in the air costs nothing to draw.
    this.mesh.visible = flying > 0;
  }

  private at(shaft: Shaft, t: number, out: THREE.Vector3): THREE.Vector3 {
    out.lerpVectors(shaft.from, shaft.to, t);
    out.y += shaft.arc * Math.sin(Math.PI * t);
    return out;
  }
}
