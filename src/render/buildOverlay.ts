import * as THREE from 'three';
import { cellToWorldX, cellToWorldZ, TILE } from '../core/grid.js';
import { heightAt } from '../core/map.js';
import { BUILDING, type BuildingId, type Zone } from '../data/buildings.js';
import { inZone, type Building, type Game, type PlaceCheck } from '../sim/game.js';
import { mergedField } from './assets.js';
import { footprintCentre, previewPieces } from './buildingVisuals.js';

/** The four cells a wall can bond with, in the order the ghost's cache key lists them. */
const SIDES: readonly (readonly [number, number])[] = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
];
/** Nothing to bond with: what everything but a wall shows. */
const ALONE = (): boolean => false;

/**
 * Everything drawn on the ground while the player builds: which cells can take
 * a building, the footprint under the cursor in green or red, a floating ghost
 * of the building itself, and the gold outline of a selected building.
 *
 * Tile geometry is rebuilt when what it shows changes — the cursor enters a new
 * cell, something is placed — never per frame. The per-frame motion (the zone
 * pulsing, the ghost bobbing) is a uniform and a position.
 */

const FREE = new THREE.Color(0xffffff);
const OK = new THREE.Color(0x7dff6a);
const BAD = new THREE.Color(0xff4b3a);
const SELECTED = new THREE.Color(0xffd35a);

interface Tile {
  x: number;
  z: number;
  /** Ground height under the tile: moat can be dug on the lower river banks. */
  y: number;
  color: THREE.Color;
}

/** One inset quad per cell, so a set of cells reads as tiles with a grid between. */
function tileGeometry(tiles: readonly Tile[], lift: number, inset: number): THREE.BufferGeometry {
  const positions: number[] = [];
  const colors: number[] = [];
  const half = TILE / 2 - inset;
  for (const { x, z, y: ground, color } of tiles) {
    const y = ground + lift;
    const wx = cellToWorldX(x);
    const wz = cellToWorldZ(z);
    for (const [px, pz] of [
      [wx - half, wz - half],
      [wx - half, wz + half],
      [wx + half, wz + half],
      [wx - half, wz - half],
      [wx + half, wz + half],
      [wx + half, wz - half],
    ] as const) {
      positions.push(px, y, pz);
      colors.push(color.r, color.g, color.b);
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  return geometry;
}

function disposeGroup(group: THREE.Object3D): void {
  group.traverse((o) => {
    if (o instanceof THREE.Mesh) o.geometry.dispose();
  });
}

export class BuildOverlay {
  readonly group = new THREE.Group();

  private readonly game: Game;
  private readonly ground: number;
  private readonly zoneMaterial = new THREE.MeshBasicMaterial({
    vertexColors: true,
    transparent: true,
    opacity: 0.22,
    depthWrite: false,
  });
  private readonly tileMaterial = new THREE.MeshBasicMaterial({
    vertexColors: true,
    transparent: true,
    opacity: 0.6,
    depthWrite: false,
  });
  private readonly zoneMesh = new THREE.Mesh(new THREE.BufferGeometry(), this.zoneMaterial);
  private readonly tileMesh = new THREE.Mesh(new THREE.BufferGeometry(), this.tileMaterial);

  private zone: Zone | null = null;
  private ghost: THREE.Group | null = null;
  /** `<building>|<quarter turns>`: what the ghost currently shows, or is loading. */
  private ghostKey = '';
  private ghostLoading = '';
  private readonly ghostAt = new THREE.Vector3();
  private time = 0;

  constructor(game: Game) {
    this.game = game;
    this.ground = game.map.heights.ground;
    this.group.name = 'build-overlay';
    for (const mesh of [this.zoneMesh, this.tileMesh]) {
      mesh.frustumCulled = false;
      mesh.renderOrder = 2;
      mesh.visible = false;
      this.group.add(mesh);
    }
  }

  /** Lights up the free cells a building of this zone could use, or hides them. */
  showZone(zone: Zone | null): void {
    this.zone = zone;
    this.refresh();
  }

  /** Re-reads occupancy. Call after anything is placed. */
  refresh(): void {
    if (!this.zone) {
      this.zoneMesh.visible = false;
      return;
    }
    const { map } = this.game;
    const tiles: Tile[] = [];
    for (let z = 0; z < map.size; z++)
      for (let x = 0; x < map.size; x++)
        if (inZone(map, this.zone, x, z) && !this.game.buildingAt(x, z))
          tiles.push({ x, z, y: heightAt(map, x, z), color: FREE });
    this.replace(this.zoneMesh, tileGeometry(tiles, 0.02, 0.06));
  }

  /** Shows a building about to be placed with its lowest corner at (x, z). */
  showGhost(kind: BuildingId, x: number, z: number, check: PlaceCheck, turn = 0): void {
    // Ground trouble is shown cell by cell; a rule (cost, tier) turns it all red.
    const perCell = check.ok || check.problem === 'bounds' || check.problem === 'occupied' || check.problem === 'zone';
    const { map } = this.game;
    this.replace(
      this.tileMesh,
      tileGeometry(
        check.cells.map((c) => ({ x: c.x, z: c.z, y: heightAt(map, c.x, c.z), color: perCell && c.ok ? OK : BAD })),
        0.04,
        0.03,
      ),
    );

    const [cx, cz] = footprintCentre(x, z, BUILDING[kind].size);
    this.ghostAt.set(cx, 0, cz);
    // A wall bonds with what it is put next to, so the ghost has to be built
    // against the neighbours of the cell under the cursor — and re-built when
    // those change, which is why they are part of the cache key.
    const wall = BUILDING[kind].wall === true;
    const joins = wall ? (dx: number, dz: number) => this.game.joinsFrom(x, z, dx, dz) : ALONE;
    const key = wall
      ? `${kind}|${turn}|${SIDES.map(([dx, dz]) => (joins(dx, dz) ? '1' : '0')).join('')}`
      : `${kind}|${turn}`;
    if (key !== this.ghostKey) {
      if (this.ghost) this.ghost.visible = false;
      if (key !== this.ghostLoading) this.loadGhost(kind, turn, key, joins);
    } else if (this.ghost) this.ghost.visible = true;
  }

  hideGhost(): void {
    this.tileMesh.visible = false;
    this.ghostLoading = '';
    if (this.ghost) this.ghost.visible = false;
  }

  /** Outlines a selected building in gold, or clears the outline. */
  highlight(building: Building | null): void {
    if (!building) {
      this.tileMesh.visible = false;
      return;
    }
    const tiles: Tile[] = [];
    const { map } = this.game;
    for (let dz = 0; dz < building.size; dz++)
      for (let dx = 0; dx < building.size; dx++) {
        const x = building.x + dx;
        const z = building.z + dz;
        tiles.push({ x, z, y: heightAt(map, x, z), color: SELECTED });
      }
    this.replace(this.tileMesh, tileGeometry(tiles, 0.04, 0.03));
  }

  update(dt: number): void {
    this.time += dt;
    this.zoneMaterial.opacity = 0.16 + 0.1 * (0.5 + 0.5 * Math.sin(this.time * 3.5));
    if (this.ghost) this.ghost.position.set(this.ghostAt.x, 0.1 + 0.05 * Math.sin(this.time * 5), this.ghostAt.z);
  }

  private loadGhost(
    kind: BuildingId,
    turn: number,
    key: string,
    joins: (dx: number, dz: number) => boolean,
  ): void {
    this.ghostLoading = key;
    void mergedField(previewPieces(kind, 1, 0, 0, this.ground, turn, joins)).then((group) => {
      if (this.ghostLoading !== key) {
        disposeGroup(group);
        return;
      }
      if (this.ghost) {
        this.group.remove(this.ghost);
        disposeGroup(this.ghost);
      }
      this.ghost = group;
      this.ghostKey = key;
      this.ghostLoading = '';
      group.position.copy(this.ghostAt);
      this.group.add(group);
    });
  }

  private replace(mesh: THREE.Mesh, geometry: THREE.BufferGeometry): void {
    mesh.geometry.dispose();
    mesh.geometry = geometry;
    mesh.visible = true;
  }
}
