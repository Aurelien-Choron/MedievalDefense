import * as THREE from 'three';
import { cellToWorldX, cellToWorldZ } from '../core/grid.js';
import { BUILDING, BUILDINGS, KEEP_TIERS, RESOURCES, type BuildingId } from '../data/buildings.js';
import type { BuildOverlay } from '../render/buildOverlay.js';
import { heightOf } from '../render/buildingVisuals.js';
import type { IsoCamera } from '../render/camera.js';
import { footprintOrigin, groundUnder, pointerRay } from '../render/picking.js';
import type { Building, Game, PlaceProblem } from '../sim/game.js';
import type { BuildMenu } from './buildMenu.js';
import type { SelectionPanel } from './selection.js';
import { toast } from './toast.js';

/**
 * The player's hands: picking a building from the menu, placing it, laying
 * walls by dragging, selecting what is already built, and backing out.
 *
 * Placement goes through Game.check and Game.place only, so anything the
 * interface lets through, the rules have already agreed to.
 */

export interface ControllerParts {
  game: Game;
  camera: IsoCamera;
  dom: HTMLElement;
  overlay: BuildOverlay;
  menu: BuildMenu;
  selection: SelectionPanel;
}

const pickBox = new THREE.Box3();
const pickPoint = new THREE.Vector3();
/** Half-width of a cell's pick box. */
const PICK_HALF = 0.38;

/** Buildings laid by dragging across cells rather than one click at a time. */
const paintable = (id: BuildingId): boolean => {
  const def = BUILDING[id];
  return def.size === 1 && (def.wall === true || def.dug === true);
};

function problemText(problem: PlaceProblem, id: BuildingId, game: Game): string {
  const def = BUILDING[id];
  switch (problem) {
    case 'bounds':
      return 'That is off the map.';
    case 'occupied':
      return 'Something already stands there.';
    case 'zone':
      switch (def.zone) {
        case 'castle':
          return 'Build inside the castle grounds.';
        case 'wood':
          return 'Woodcutter camps go at the edge of the forest.';
        case 'stone':
          return 'Miner camps go at the foot of the mine.';
        case 'dig':
          return 'Moats are dug in open ground, not in water, rock or forest.';
      }
      break;
    case 'locked':
      return `Requires the ${KEEP_TIERS[def.tier - 1]?.name ?? 'next keep tier'}.`;
    case 'cost': {
      const short = RESOURCES.find((r) => game.state.resources[r] < (def.cost[r] ?? 0));
      return `Not enough ${short ?? 'resources'}.`;
    }
  }
  return 'That cannot go there.';
}

export class BuildController {
  private readonly game: Game;
  private readonly camera: IsoCamera;
  private readonly dom: HTMLElement;
  private readonly overlay: BuildOverlay;
  private readonly menu: BuildMenu;
  private readonly selection: SelectionPanel;

  private placing: BuildingId | null = null;
  private pointer: { x: number; y: number } | null = null;
  /**
   * Quarter turns to lay the next building down with. It carries over from one
   * placement to the next, so a row of huts all face the same way without the
   * player turning each one.
   */
  private turn = 0;
  /** Laying a line of walls: the button is held and every cell crossed gets one. */
  private painting = false;
  private lastPainted: { x: number; z: number } | null = null;
  private ghostKey = '';

  constructor(parts: ControllerParts) {
    this.game = parts.game;
    this.camera = parts.camera;
    this.dom = parts.dom;
    this.overlay = parts.overlay;
    this.menu = parts.menu;
    this.selection = parts.selection;
    this.bind();
  }

  /** Enters placement for a building, or leaves it. Picking the active one again leaves too. */
  pick(id: BuildingId | null): void {
    if (id !== null && id === this.placing) id = null;
    if (id !== null) {
      const def = BUILDING[id];
      if (def.tier > this.game.tier) {
        toast(problemText('locked', id, this.game));
        return;
      }
    }
    this.placing = id;
    this.painting = false;
    this.ghostKey = '';
    this.menu.setActive(id);
    this.overlay.showZone(id ? BUILDING[id].zone : null);
    this.overlay.hideGhost();
    if (id) this.selection.select(null);
  }

  /** Esc and right click: leave placement first, then drop the selection. */
  cancel(): void {
    if (this.placing) this.pick(null);
    else {
      this.selection.select(null);
      this.overlay.highlight(null);
    }
  }

  /** Per frame: keeps the ghost under the cursor even while the camera moves beneath it. */
  update(): void {
    if (!this.placing) {
      if (!this.selection.selected) this.overlay.highlight(null);
      return;
    }
    const at = this.hover();
    if (!at) {
      if (this.ghostKey) this.overlay.hideGhost();
      this.ghostKey = '';
      return;
    }
    // Keyed on what the ghost actually looks like — where it is, which way it
    // faces, and how the check colours it — rather than on the state that feeds
    // that check. Keying on the raw stock was fine while only the player could
    // change it; since P3 the camps pay in every few seconds, and it rebuilt
    // the ghost's geometry, asynchronously, on every load that came home. Mid
    // rotation that race could leave the old ghost standing.
    const check = this.game.check(this.placing, at.x, at.z);
    const key =
      `${this.placing}|${this.turn}|${at.x},${at.z}|${check.problem ?? 'ok'}|` +
      check.cells.map((cell) => (cell.ok ? '1' : '0')).join('');
    if (key === this.ghostKey) return;
    this.ghostKey = key;
    this.overlay.showGhost(this.placing, at.x, at.z, check, this.turn);
  }

  private bind(): void {
    this.dom.addEventListener('pointermove', (e) => {
      this.pointer = { x: e.clientX, y: e.clientY };
      if (this.painting) this.paint();
    });
    this.dom.addEventListener('pointerleave', () => {
      this.pointer = null;
    });
    this.dom.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || !this.placing || !paintable(this.placing)) return;
      this.pointer = { x: e.clientX, y: e.clientY };
      this.painting = true;
      this.lastPainted = null;
      this.paint();
    });
    addEventListener('pointerup', () => {
      this.painting = false;
    });
    addEventListener('keydown', (e) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.code === 'Escape') {
        this.cancel();
        return;
      }
      // R turns what is being placed, or the building that is selected. Bound
      // by code, so it is the same physical key on AZERTY.
      if (e.code === 'KeyR' && !e.shiftKey) {
        this.rotate();
        return;
      }
      // Digit codes are physical keys: they work on AZERTY without shift.
      // 1..9 pick the first nine cards, 0 the tenth.
      const digit = /^Digit([0-9])$/.exec(e.code);
      const n = digit ? Number(digit[1]) : -1;
      const def = n >= 0 ? BUILDINGS[n === 0 ? 9 : n - 1] : undefined;
      if (def) this.pick(def.id);
    });

    this.camera.onClick = (e) => this.click(e);
    this.camera.leftDragPans = () => !(this.placing && paintable(this.placing));
  }

  /**
   * A quarter turn, on the ghost while placing and on the selected building
   * otherwise — so the same key turns a wall before it goes down and after.
   */
  rotate(delta = 1): void {
    if (this.placing) {
      this.turn = (this.turn + delta + 4) % 4;
      this.ghostKey = '';
      return;
    }
    const building = this.selection.selected;
    if (!building) return;
    if (!this.game.rotatable(building)) {
      toast(
        building.kind === 'moat'
          ? 'A moat is a hole in the ground; there is nothing to turn.'
          : 'A wall joined to its neighbours follows their line.',
      );
      return;
    }
    this.game.rotate(building, delta);
  }

  /** The footprint origin under the cursor for the building being placed. */
  private hover(): { x: number; z: number } | null {
    if (!this.pointer || !this.placing) return null;
    const hit = groundUnder(this.camera.camera, this.dom, this.pointer.x, this.pointer.y, this.game.map.heights.ground);
    if (!hit) return null;
    const size = BUILDING[this.placing].size;
    return { x: footprintOrigin(hit.cx, size), z: footprintOrigin(hit.cz, size) };
  }

  private click(e: PointerEvent): void {
    if (e.button === 2) {
      this.cancel();
      return;
    }
    if (e.button !== 0) return;

    if (this.placing) {
      // Walls and moats are laid on press, by paint(); the click that ends it
      // is not a second placement.
      if (paintable(this.placing)) return;
      const at = this.hover();
      if (!at) return;
      // Shift keeps the building selected, to place several in a row.
      if (this.tryPlace(this.placing, at.x, at.z) && !e.shiftKey) this.pick(null);
      return;
    }

    const building = this.buildingUnder(e.clientX, e.clientY);
    this.selection.select(building);
    this.overlay.highlight(building);
  }

  /**
   * The building under the pointer. Seen from the iso angle a building stands
   * in front of the cells behind it, and the player clicks on what they see —
   * so each building is hit as its whole standing volume, not the cell under
   * the cursor, and the nearest volume wins.
   */
  private buildingUnder(clientX: number, clientY: number): Building | null {
    const ray = pointerRay(this.camera.camera, this.dom, clientX, clientY);
    const ground = this.game.map.heights.ground;
    let best: Building | null = null;
    let nearest = Infinity;
    for (const b of this.game.state.buildings) {
      // A little inside the footprint: full-cell boxes overlap their neighbours'
      // silhouettes along a wall, and the one in front would steal the click.
      pickBox.min.set(cellToWorldX(b.x) - PICK_HALF, ground - 0.6, cellToWorldZ(b.z) - PICK_HALF);
      pickBox.max.set(
        cellToWorldX(b.x + b.size - 1) + PICK_HALF,
        ground + heightOf(b.kind, b.level) * 0.92,
        cellToWorldZ(b.z + b.size - 1) + PICK_HALF,
      );
      if (!ray.intersectBox(pickBox, pickPoint)) continue;
      const distance = pickPoint.distanceTo(ray.origin);
      if (distance < nearest) {
        nearest = distance;
        best = b;
      }
    }
    return best;
  }

  private tryPlace(id: BuildingId, x: number, z: number): boolean {
    const check = this.game.check(id, x, z);
    if (!check.ok) {
      if (check.problem) toast(problemText(check.problem, id, this.game));
      return false;
    }
    return this.game.place(id, x, z, this.turn) !== null;
  }

  /**
   * Lays walls along the path of the cursor. Cells between two pointer events
   * are filled in, so a fast sweep still leaves an unbroken wall; cells that
   * will not take one are skipped quietly, except the very first.
   */
  private paint(): void {
    const id = this.placing;
    const at = this.hover();
    if (!id || !at) return;
    const from = this.lastPainted;
    if (from && from.x === at.x && from.z === at.z) return;

    const steps = from ? Math.max(Math.abs(at.x - from.x), Math.abs(at.z - from.z)) : 0;
    for (let s = from ? 1 : 0; s <= steps; s++) {
      const t = steps ? s / steps : 1;
      const x = from ? Math.round(from.x + (at.x - from.x) * t) : at.x;
      const z = from ? Math.round(from.z + (at.z - from.z) * t) : at.z;
      const check = this.game.check(id, x, z);
      if (check.ok) this.game.place(id, x, z, this.turn);
      else if (check.problem === 'cost' || !from) {
        if (check.problem) toast(problemText(check.problem, id, this.game));
        if (check.problem === 'cost') {
          this.painting = false;
          break;
        }
      }
    }
    this.lastPainted = at;
  }
}
