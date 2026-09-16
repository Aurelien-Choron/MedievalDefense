import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { cellToWorldX, cellToWorldZ } from '../core/grid.js';
import type { Worker } from '../sim/workers.js';

/**
 * The woodcutters and miners, drawn.
 *
 * Three draw calls for the whole workforce, however many there are: one
 * InstancedMesh per trade, plus one for what they carry home. Nobody on the
 * map costs nothing — an empty mesh hides itself, the same rule the projectile
 * pool and the practice targets already follow.
 *
 * Why not one mesh per body part, as the budget note suggests? Because at this
 * zoom a worker stands about twenty pixels tall, and a swinging leg is a pixel
 * of it. A bob and a sway carry the walk far better than jointed limbs would,
 * and they let the whole figure be one merged, vertex-coloured geometry rather
 * than five meshes to keep in step. The same matrix then carries the load, so
 * a shouldered log rides along for free.
 *
 * No Kenney model is involved: the four kits contain no characters at all
 * (see CLAUDE.md, "Faits mesurés"), so the figures are built here — which also
 * means there is nothing for the build's asset pruning to miss.
 */

/** Room for a dozen camps at their top level. Beyond that the rest go undrawn. */
const CAPACITY = 72;

const UP = new THREE.Vector3(0, 1, 0);
/** The figure faces +x, so this is the axis a walking sway rocks it about. */
const FORWARD = new THREE.Vector3(1, 0, 0);
/** And this is the one a swung axe tips it over. */
const SIDE = new THREE.Vector3(0, 0, 1);

/** Steps per cell walked: how fast the bob and the sway cycle. */
const CADENCE = 2;

const SKIN = 0xe0ae72;
const BOOT = 0x43301f;
const BELT = 0x5a3b22;

interface Trade {
  tunic: number;
  sleeve: number;
  hat: number;
}

const TRADES: Readonly<Record<'wood' | 'stone', Trade>> = {
  // Foresters in russet under a green hood, miners in slate under a pale
  // helmet. Neither tunic is green: a worker spends its life crossing grass
  // and sand, and the first try dressed the woodcutters in exactly the colour
  // of the ground they walk on — at playing zoom they vanished into it.
  wood: { tunic: 0xa0603a, sleeve: 0x8a5130, hat: 0x3f5a2c },
  stone: { tunic: 0x5f7186, sleeve: 0x4f6174, hat: 0xd4d2c6 },
};

/** What a load looks like, by what it is. */
const LOAD: Readonly<Record<'wood' | 'stone', number>> = { wood: 0x8a6a3f, stone: 0x9a9a95 };

/** A coloured box, placed in the model's own frame. */
function block(
  width: number,
  height: number,
  depth: number,
  x: number,
  y: number,
  z: number,
  color: number,
): THREE.BufferGeometry {
  const box = new THREE.BoxGeometry(width, height, depth);
  box.translate(x, y + height / 2, z);
  const tint = new THREE.Color(color);
  const count = box.getAttribute('position').count;
  const colors = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    colors[i * 3] = tint.r;
    colors[i * 3 + 1] = tint.g;
    colors[i * 3 + 2] = tint.b;
  }
  box.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  return box;
}

/**
 * One figure, facing +x — the convention the simulation's `facing` already
 * uses, so the angle goes straight into the matrix.
 */
function figure(trade: Trade): THREE.BufferGeometry {
  // Proportioned for the isometric pitch rather than for anatomy: the
  // shoulders have to be the widest thing and the hat the narrowest, or the
  // figure reads hat-first and turns into a dark blob at playing zoom.
  const parts = [
    block(0.09, 0.24, 0.2, 0, 0, 0.075, BOOT),
    block(0.09, 0.24, 0.2, 0, 0, -0.075, BOOT),
    block(0.26, 0.05, 0.27, 0, 0.24, 0, BELT),
    block(0.26, 0.29, 0.28, 0, 0.29, 0, trade.tunic),
    block(0.09, 0.26, 0.09, 0.02, 0.3, 0.185, trade.sleeve),
    block(0.09, 0.26, 0.09, 0.02, 0.3, -0.185, trade.sleeve),
    block(0.17, 0.18, 0.17, 0.01, 0.58, 0, SKIN),
    block(0.21, 0.05, 0.21, 0, 0.74, 0, trade.hat),
  ];
  const merged = mergeGeometries(parts, false);
  for (const part of parts) part.dispose();
  if (!merged) throw new Error('could not build a worker figure');
  return merged;
}

/** The load on a shoulder, already sitting where it rides. */
function bundle(): THREE.BufferGeometry {
  const box = new THREE.BoxGeometry(0.3, 0.14, 0.16);
  box.translate(-0.01, 0.78, 0.18);
  return box;
}

export class WorkerFigures {
  readonly group = new THREE.Group();

  private readonly ground: number;
  private readonly bodies: Record<'wood' | 'stone', THREE.InstancedMesh>;
  private readonly loads: THREE.InstancedMesh;
  private readonly matrix = new THREE.Matrix4();
  private readonly position = new THREE.Vector3();
  private readonly quaternion = new THREE.Quaternion();
  private readonly yaw = new THREE.Quaternion();
  private readonly roll = new THREE.Quaternion();
  private readonly unit = new THREE.Vector3(1, 1, 1);
  private readonly color = new THREE.Color();
  private readonly swing = new THREE.Quaternion();

  constructor(ground: number) {
    this.ground = ground;
    this.group.name = 'workers';

    // One material for both trades: the colours ride on the geometry, so the
    // two meshes differ only in their vertices.
    const skin = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true });
    this.bodies = {
      wood: new THREE.InstancedMesh(figure(TRADES.wood), skin, CAPACITY),
      stone: new THREE.InstancedMesh(figure(TRADES.stone), skin, CAPACITY),
    };
    this.loads = new THREE.InstancedMesh(
      bundle(),
      new THREE.MeshLambertMaterial({ flatShading: true }),
      CAPACITY,
    );
    this.loads.name = 'worker-loads';

    for (const [trade, mesh] of Object.entries(this.bodies)) {
      mesh.name = `workers-${trade}`;
      mesh.frustumCulled = false;
      mesh.visible = false;
      mesh.count = 0;
      this.group.add(mesh);
    }
    this.loads.frustumCulled = false;
    this.loads.visible = false;
    this.loads.count = 0;
    for (let i = 0; i < CAPACITY; i++) this.loads.setColorAt(i, this.color.setHex(LOAD.wood));
    this.group.add(this.loads);
  }

  /**
   * Redraws every worker. Cheap enough per frame: a handful of matrices, and
   * the figures are read straight off the simulation rather than interpolated
   * — at 20 Hz over this little ground the step is already below a pixel.
   */
  sync(workers: readonly Worker[], time: number): void {
    const counts = { wood: 0, stone: 0 };
    let carried = 0;

    for (const worker of workers) {
      const mesh = this.bodies[worker.resource];
      const slot = counts[worker.resource];
      if (slot >= CAPACITY) continue;

      // A worker rocks as it walks and tips forward into a swing while it
      // works. Both are quarter turns folded into the one matrix it already
      // needs, so the animation costs nothing but the sines.
      const walking = worker.phase === 'toNode' || worker.phase === 'toCamp';
      const cycle = worker.stride * Math.PI * 2 * CADENCE;
      const bob = walking ? Math.abs(Math.sin(cycle)) * 0.045 : 0;
      const sway = walking ? Math.sin(cycle) * 0.1 : 0;
      // The chop runs off the clock rather than the stride: a worker standing
      // at a tree covers no ground, so there is no stride to drive it.
      const chop =
        worker.phase === 'harvest' ? Math.max(0, Math.sin(time * 7 + worker.id)) * -0.55 : 0;

      this.position.set(
        cellToWorldX(worker.x),
        this.ground + bob,
        cellToWorldZ(worker.z),
      );
      this.yaw.setFromAxisAngle(UP, THREE.MathUtils.degToRad(worker.facing));
      this.roll.setFromAxisAngle(FORWARD, sway);
      this.swing.setFromAxisAngle(SIDE, chop);
      this.quaternion.copy(this.yaw).multiply(this.roll).multiply(this.swing);
      this.matrix.compose(this.position, this.quaternion, this.unit);
      mesh.setMatrixAt(slot, this.matrix);
      counts[worker.resource] = slot + 1;

      if (worker.carrying > 0 && carried < CAPACITY) {
        this.loads.setMatrixAt(carried, this.matrix);
        this.loads.setColorAt(carried, this.color.setHex(LOAD[worker.resource]));
        carried++;
      }
    }

    for (const trade of ['wood', 'stone'] as const) {
      const mesh = this.bodies[trade];
      // A trade nobody works costs no draw call at all.
      mesh.count = counts[trade];
      mesh.visible = counts[trade] > 0;
      mesh.instanceMatrix.needsUpdate = true;
    }
    this.loads.count = carried;
    this.loads.visible = carried > 0;
    this.loads.instanceMatrix.needsUpdate = true;
    if (this.loads.instanceColor) this.loads.instanceColor.needsUpdate = true;
  }
}
