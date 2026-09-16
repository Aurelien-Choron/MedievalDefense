import * as THREE from 'three';
import { cellToWorldX, cellToWorldZ } from '../core/grid.js';
import { BUILDING, BUILDINGS, KEEP_TIERS } from '../data/buildings.js';
import { progressOf, type Building, type Game, type GameEvent } from '../sim/game.js';
import { mergedField, partsOf, placementMatrix, type ModelPart, type PlacedPiece } from './assets.js';
import { GATE, footprintCentre, heightOf, movingPiecesOf, piecesOf, previewPieces } from './buildingVisuals.js';
import type { Dust } from './fx.js';

/**
 * Draws every building in the game state, and animates what moves.
 *
 * Two layers, so buffers are rebuilt on construction events and never per
 * frame:
 *
 * - **Standing** buildings are baked into one merged mesh per material,
 *   rebuilt only when something is placed, finishes, changes or comes down (a
 *   new wall also changes how its neighbours join).
 * - **Dynamic** parts — foundations rising, scaffolds, the bounce of a building
 *   just finished, and every gatehouse's drawbridge and portcullis — are
 *   instanced per model part across the whole map. Laying forty palisades
 *   costs a handful of draw calls, not forty, and only instance matrices change
 *   from frame to frame.
 *
 * Both layers are rebuilt together and swapped in the same frame, so a
 * building moving from one to the other never flickers out.
 */

/** Seconds a finished building bounces before settling into the static mesh. */
const SETTLE = 0.45;
/** Mean seconds between dust puffs on a busy site. */
const PUFF_EVERY = 0.5;
/** Height a foundation starts at, as a share of the finished building. */
const FOUNDATION = 0.06;
/** Seconds for a drawbridge to swing all the way, and a portcullis to drop. */
const BRIDGE_SECONDS = 1.6;
const PORTCULLIS_SECONDS = 1.0;

type Motion =
  | { type: 'rise' }
  | { type: 'pop'; since: number }
  | { type: 'scaffold'; width: number; height: number }
  | { type: 'drawbridge'; facing: number }
  | { type: 'portcullis'; facing: number };

interface Instance {
  building: Building;
  motion: Motion;
  /** Where the part stands at rest, or its own node transform for mechanisms. */
  base: THREE.Matrix4;
  part: ModelPart;
  cx: number;
  cz: number;
}

interface Batch {
  mesh: THREE.InstancedMesh;
  instances: Instance[];
}

const DIRT_MATERIAL = new THREE.MeshLambertMaterial({ vertexColors: true });
const DIRT = new THREE.Color(0xa87c4f);

const isDug = (b: Building): boolean => b.kind !== 'keep' && BUILDING[b.kind].dug === true;
const smooth = (t: number): number => t * t * (3 - 2 * t);
const approach = (value: number, target: number, step: number): number =>
  value < target ? Math.min(value + step, target) : Math.max(value - step, target);

/** Every model a building can use, loaded up front so the first placement is instant. */
async function preloadVisuals(): Promise<void> {
  const pieces: PlacedPiece[] = [
    ...BUILDINGS.flatMap((def) =>
      Array.from({ length: 1 + (def.levels?.length ?? 0) }, (_, i) => previewPieces(def.id, i + 1, 0, 0, 0)).flat(),
    ),
    ...KEEP_TIERS.flatMap((tier) => previewPieces('keep', tier.tier, 0, 0, 0)),
  ];
  await Promise.all([
    ...pieces.map((p) => partsOf(p.kit, p.model, p.skin).catch(() => [])),
    ...['structure', 'overhang', 'battlement'].map((m) => partsOf('retro', m).catch(() => [])),
  ]);
}

/** Bare earth under the sites still being raised. */
function dirtPatches(sites: readonly Building[], y: number): THREE.BufferGeometry {
  const positions: number[] = [];
  const colors: number[] = [];
  for (const b of sites) {
    const x0 = cellToWorldX(b.x) - 0.5;
    const x1 = cellToWorldX(b.x + b.size - 1) + 0.5;
    const z0 = cellToWorldZ(b.z) - 0.5;
    const z1 = cellToWorldZ(b.z + b.size - 1) + 0.5;
    for (const [px, pz] of [
      [x0, z0],
      [x0, z1],
      [x1, z1],
      [x0, z0],
      [x1, z1],
      [x1, z0],
    ] as const) {
      positions.push(px, y, pz);
      colors.push(DIRT.r, DIRT.g, DIRT.b);
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  geometry.computeVertexNormals();
  return geometry;
}

/** Frees what a layer owns. Instanced parts share cached model geometry, which stays. */
function disposeLayer(layer: THREE.Object3D): void {
  layer.traverse((o) => {
    if (o instanceof THREE.InstancedMesh) o.dispose();
    else if (o instanceof THREE.Mesh && o.userData.owned) o.geometry.dispose();
  });
}

export class BuildRenderer {
  readonly group = new THREE.Group();
  /** Resolves once the starting buildings are on screen. */
  readonly ready: Promise<void>;

  private readonly game: Game;
  private readonly dust: Dust;
  private readonly ground: number;

  private standing = new THREE.Group();
  private dynamic = new THREE.Group();
  private batches: Batch[] = [];

  /** Buildings just finished, by the time they finished, while they bounce. */
  private readonly settling = new Map<number, number>();
  /** Construction progress as drawn: eased toward the 20 Hz simulation value. */
  private readonly shown = new Map<number, number>();
  private readonly nextPuff = new Map<number, number>();
  /** Gate mechanisms as drawn: 0..1 raised, 0..1 closed, chasing the game's state. */
  private readonly gates = new Map<number, { raised: number; closed: number }>();

  private time = 0;
  private dirty = false;
  private syncing: Promise<void> | null = null;

  private readonly matrix = new THREE.Matrix4();
  private readonly step = new THREE.Matrix4();

  constructor(game: Game, dust: Dust) {
    this.game = game;
    this.dust = dust;
    this.ground = game.map.heights.ground;
    this.group.name = 'buildings';
    this.group.add(this.standing, this.dynamic);
    this.ready = preloadVisuals().then(() => this.sync());
  }

  /** Reacts to what the simulation did: dust, bounces, and a rebuild. */
  handle(events: readonly GameEvent[]): void {
    let rebuild = false;
    for (const event of events) {
      // The wood growing back is the ground's business, not the castle's:
      // src/main.ts hands it to the scatter.
      if (event.type === 'forest') continue;
      const b = event.building;
      const [cx, cz] = footprintCentre(b.x, b.z, b.size);
      switch (event.type) {
        case 'placed':
          this.shown.set(b.id, 0);
          this.dust.burst(cx, this.ground, cz, b.size * 0.55, 5 + b.size * 4, 0.8);
          break;
        case 'upgrade-started':
          this.dust.burst(cx, this.ground, cz, b.size * 0.6, 8 + b.size * 2, 0.9);
          break;
        case 'completed':
        case 'upgraded':
          this.settling.set(b.id, this.time);
          this.dust.burst(cx, this.ground, cz, b.size * 0.6, 10 + b.size * 6, 1.3);
          break;
        case 'removed':
          this.dust.burst(cx, this.ground, cz, b.size * 0.6, 12 + b.size * 4, 1.1);
          this.gates.delete(b.id);
          break;
        case 'rotated':
          this.dust.burst(cx, this.ground, cz, b.size * 0.5, 4 + b.size * 2, 0.6);
          break;
        case 'upgrade-cancelled':
        case 'gate':
          break;
      }
      // Working a gate only moves its mechanisms: nothing to rebuild.
      if (event.type !== 'gate') rebuild = true;
    }
    if (rebuild) this.dirty = true;
  }

  update(dt: number): void {
    this.time += dt;
    for (const [id, since] of this.settling)
      if (this.time - since > SETTLE) {
        this.settling.delete(id);
        this.dirty = true;
      }
    if (this.dirty && !this.syncing) void this.sync();

    for (const b of this.game.state.buildings) {
      if (b.gate) this.moveGate(b, dt);
      if (!b.job) {
        this.shown.delete(b.id);
        this.nextPuff.delete(b.id);
        continue;
      }
      const target = progressOf(b);
      const drawn = this.shown.get(b.id) ?? target;
      this.shown.set(b.id, drawn + (target - drawn) * Math.min(1, dt * 8));
      this.puff(b);
    }
    this.animate();
  }

  private moveGate(b: Building, dt: number): void {
    const raised = b.gate!.bridgeDown ? 0 : 1;
    const closed = b.gate!.portcullisOpen ? 0 : 1;
    const drawn = this.gates.get(b.id);
    if (!drawn) {
      this.gates.set(b.id, { raised, closed });
      return;
    }
    drawn.raised = approach(drawn.raised, raised, dt / BRIDGE_SECONDS);
    drawn.closed = approach(drawn.closed, closed, dt / PORTCULLIS_SECONDS);
  }

  private sync(): Promise<void> {
    this.dirty = false;
    const run = this.rebuild().finally(() => {
      this.syncing = null;
      if (this.dirty) void this.sync();
    });
    this.syncing = run;
    return run;
  }

  private async rebuild(): Promise<void> {
    const game = this.game;
    const standingPieces: PlacedPiece[] = [];
    const busy: Building[] = [];
    const gates: Building[] = [];
    for (const b of game.state.buildings) {
      const rising = b.job?.type === 'construct' || this.settling.has(b.id);
      // An upgrading building stands as it was, with a scaffold around it.
      if (rising || b.job) busy.push(b);
      if (rising) continue;
      standingPieces.push(...piecesOf(game, b));
      if (b.gate) gates.push(b);
    }

    const [standing, dynamic] = await Promise.all([mergedField(standingPieces), this.buildDynamic(busy, gates)]);
    standing.traverse((o) => {
      o.userData.owned = true;
    });

    for (const old of [this.standing, this.dynamic]) {
      this.group.remove(old);
      disposeLayer(old);
    }
    this.standing = standing;
    this.dynamic = dynamic.group;
    this.batches = dynamic.batches;
    this.group.add(standing, dynamic.group);
    this.animate();
  }

  private async buildDynamic(
    busy: readonly Building[],
    gates: readonly Building[],
  ): Promise<{ group: THREE.Group; batches: Batch[] }> {
    const byPart = new Map<ModelPart, Instance[]>();
    const add = (instance: Instance): void => {
      let list = byPart.get(instance.part);
      if (!list) byPart.set(instance.part, (list = []));
      list.push(instance);
    };

    const placed = new THREE.Matrix4();
    const scaffold = await partsOf('retro', 'structure').catch((): ModelPart[] => []);
    for (const b of busy) {
      const [cx, cz] = footprintCentre(b.x, b.z, b.size);
      const since = this.settling.get(b.id);

      if (b.job?.type !== 'upgrade') {
        const motion: Motion = since === undefined ? { type: 'rise' } : { type: 'pop', since };
        for (const piece of piecesOf(this.game, b)) {
          const parts = await partsOf(piece.kit, piece.model, piece.skin).catch((): ModelPart[] => []);
          placementMatrix(piece.placement, placed);
          for (const part of parts)
            add({ building: b, motion, base: placed.clone().multiply(part.matrix), part, cx, cz });
        }
      }

      if (b.job && !isDug(b)) {
        const target = b.job.into ?? b;
        const motion: Motion = {
          type: 'scaffold',
          width: b.size + 0.16,
          height: heightOf(target.kind, target.level) * 0.92,
        };
        for (const part of scaffold) add({ building: b, motion, base: part.matrix, part, cx, cz });
      }
    }

    for (const b of gates)
      for (const piece of movingPiecesOf(this.game, b)) {
        const parts = await partsOf(piece.kit, piece.model).catch((): ModelPart[] => []);
        for (const part of parts)
          add({
            building: b,
            motion: { type: piece.part, facing: piece.facing },
            base: part.matrix,
            part,
            cx: piece.cx,
            cz: piece.cz,
          });
      }

    const group = new THREE.Group();
    group.name = 'dynamic';
    const batches: Batch[] = [];
    for (const [part, instances] of byPart) {
      const mesh = new THREE.InstancedMesh(part.geometry, part.material, instances.length);
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      mesh.frustumCulled = false;
      group.add(mesh);
      batches.push({ mesh, instances });
    }

    const foundations = busy.filter((b) => b.job?.type === 'construct' && !isDug(b));
    if (foundations.length) {
      const dirt = new THREE.Mesh(dirtPatches(foundations, this.ground + 0.012), DIRT_MATERIAL);
      dirt.userData.owned = true;
      dirt.frustumCulled = false;
      group.add(dirt);
    }
    return { group, batches };
  }

  private animate(): void {
    for (const batch of this.batches) {
      batch.instances.forEach((instance, i) => batch.mesh.setMatrixAt(i, this.motionMatrix(instance)));
      batch.mesh.instanceMatrix.needsUpdate = true;
    }
  }

  private motionMatrix(instance: Instance): THREE.Matrix4 {
    const g = this.ground;
    const { motion, building, cx, cz } = instance;
    const progress = this.shown.get(building.id) ?? progressOf(building);

    switch (motion.type) {
      case 'rise': {
        // Squashed toward the ground and growing: the retro pattern is mapped
        // in world space, so the masonry does not squash with it — the wall
        // simply gets taller, course by course.
        const s = FOUNDATION + (1 - FOUNDATION) * progress * (2 - progress);
        return this.matrix
          .makeTranslation(0, g, 0)
          .multiply(this.step.makeScale(1, s, 1))
          .multiply(this.step.makeTranslation(0, -g, 0))
          .multiply(instance.base);
      }
      case 'pop': {
        const t = Math.min((this.time - motion.since) / SETTLE, 1);
        const bump = Math.sin(Math.PI * t) * (1 - 0.5 * t);
        const across = 1 + 0.07 * bump;
        const up = 1 + 0.16 * bump;
        return this.matrix
          .makeTranslation(cx, g, cz)
          .multiply(this.step.makeScale(across, up, across))
          .multiply(this.step.makeTranslation(-cx, -g, -cz))
          .multiply(instance.base);
      }
      case 'scaffold': {
        // Poles go up ahead of the building they shelter.
        const height = motion.height * Math.min(1, 0.35 + progress * 1.3);
        return placementMatrix(
          { x: cx, z: cz, y: g, scale: [motion.width, height, motion.width] },
          this.matrix,
        ).multiply(instance.base);
      }
      case 'drawbridge': {
        // Swing about the hinge on the gate's outer face: turned half a turn
        // the deck runs outward along +x, and a rotation about z lifts it.
        const raised = smooth(this.gates.get(building.id)?.raised ?? 0);
        return this.matrix
          .makeTranslation(cx, g, cz)
          .multiply(this.step.makeRotationY(THREE.MathUtils.degToRad(motion.facing)))
          .multiply(this.step.makeTranslation(GATE.hinge, GATE.deckLift, 0))
          .multiply(this.step.makeRotationZ((raised * Math.PI) / 2))
          .multiply(this.step.makeRotationY(Math.PI))
          .multiply(this.step.makeScale(...GATE.bridgeScale))
          .multiply(instance.base);
      }
      case 'portcullis': {
        const open = 1 - smooth(this.gates.get(building.id)?.closed ?? 0);
        const [sx, sy, sz] = GATE.portcullisScale;
        return this.matrix
          .makeTranslation(cx, g, cz)
          .multiply(this.step.makeRotationY(THREE.MathUtils.degToRad(motion.facing)))
          .multiply(this.step.makeTranslation(GATE.portcullisAt, open * GATE.lift, 0))
          .multiply(this.step.makeScale(sx, sy * (1 - (1 - GATE.retracted) * open), sz))
          .multiply(instance.base);
      }
    }
  }

  private puff(b: Building): void {
    const due = this.nextPuff.get(b.id);
    if (due === undefined) {
      this.nextPuff.set(b.id, this.time + Math.random() * PUFF_EVERY);
      return;
    }
    if (this.time < due) return;
    const [cx, cz] = footprintCentre(b.x, b.z, b.size);
    this.dust.burst(cx, this.ground, cz, b.size * 0.5, b.size > 1 ? 2 : 1, 0.5);
    this.nextPuff.set(b.id, this.time + PUFF_EVERY * (0.6 + Math.random() * 0.8));
  }
}
