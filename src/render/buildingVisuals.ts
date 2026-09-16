import { cellToWorldX, cellToWorldZ } from '../core/grid.js';
import type { Building, BuildingKind, Game } from '../sim/game.js';
import type { KitName, PlacedPiece } from './assets.js';

/**
 * What each building looks like, as Kenney pieces placed around its footprint.
 *
 * The rules (src/data/buildings.ts) know footprints and costs; this knows
 * models. Keeping the two apart means a building can be re-skinned — or swapped
 * for supplied models later — without touching the simulation.
 *
 * Offsets are relative to the footprint centre, on the ground, in world axes.
 * A piece's rotation turns the piece itself, not its offset.
 */

interface Local {
  kit: KitName;
  model: string;
  skin?: string;
  x?: number;
  y?: number;
  z?: number;
  rotation?: number;
  scale?: number | readonly [number, number, number];
}

/** A gatehouse mechanism: animated by the renderer, never baked into a mesh. */
export interface MovingPiece {
  kit: KitName;
  model: string;
  part: 'drawbridge' | 'portcullis';
  /** Footprint centre in the world. */
  cx: number;
  cz: number;
  /** Which way the gate opens onto, in degrees: 0 faces +x, 270 faces +z. */
  facing: number;
}

/**
 * Gatehouse geometry shared by the resting pose and the animation, measured
 * from the footprint centre toward the outside. castle/bridge-draw hinges at
 * its own origin with its deck along -x; castle/metal-gate is a thin grille
 * across x.
 */
export const GATE = {
  hinge: 0.5,
  deckLift: 0.02,
  bridgeScale: [1, 1, 1.1] as const,
  portcullisAt: 0.3,
  portcullisScale: [1, 1.55, 1.3] as const,
  /**
   * An open portcullis rises this far and folds to this share of its height,
   * tucked under the lintel: the tower's pyramid roof is too low at the
   * doorway to hide a grille raised at full height.
   */
  lift: 0.95,
  retracted: 0.35,
};

interface Context {
  connects: (dx: number, dz: number) => boolean;
  /** Offset of the footprint centre from the keep, in cells: which way is outside. */
  fromKeepX: number;
  fromKeepZ: number;
  machicolations: boolean;
  /**
   * Which way the building points, in degrees, as Game.facingOf works it out:
   * its natural bearing plus the quarter turns the player has given it.
   */
  facing: number;
  /**
   * Whether the player has turned this one by hand. A wall reads it to know
   * whether to take its line from its neighbours (turn 0) or from them.
   */
  turned: boolean;
}

const outwardSign = (v: number): 1 | -1 => (v < 0 ? -1 : 1);

interface WallStyle {
  model: string;
  skin?: string;
  /** Vertical scale: a reinforced wall stands taller. */
  height?: number;
}

/** Castle Kit wall pieces stand this tall. */
const WALL_TOP = 1.31;

/**
 * Auto-tiled wall: one full length along a run, or half lengths reaching out
 * to each neighbour where two runs meet.
 *
 * The Castle Kit's wall pieces span a whole cell along their local x. Halving
 * one and pushing it a quarter cell toward a neighbour lets corners, T-joins
 * and crossings all come out of the same single piece: each cell only draws
 * the arms it actually has.
 *
 * Machicolations ride along each arm on the face away from the keep: corbels
 * (retro/overhang) under a projecting parapet (retro/battlement). Both pieces
 * project toward their own -z, so turning them is what puts that face outside.
 */
function wallPieces(style: WallStyle, ctx: Context): Local[] {
  const east = ctx.connects(1, 0);
  const west = ctx.connects(-1, 0);
  const south = ctx.connects(0, 1);
  const north = ctx.connects(0, -1);
  const alongX = east || west;
  const alongZ = north || south;

  const arms: { x: number; z: number; alongX: boolean; half: boolean }[] = [];
  // A wall the player has turned keeps the line they gave it, whatever it
  // stands next to: the rotation they set on the ghost is the one they get.
  // Left alone, a wall takes its line from its neighbours instead, which is
  // what makes corners and T-joins come out right without a thought.
  if (ctx.turned) arms.push({ x: 0, z: 0, alongX: ctx.facing % 180 === 0, half: false });
  else if (!alongX && !alongZ) arms.push({ x: 0, z: 0, alongX: ctx.facing % 180 === 0, half: false });
  else if (!alongZ) arms.push({ x: 0, z: 0, alongX: true, half: false });
  else if (!alongX) arms.push({ x: 0, z: 0, alongX: false, half: false });
  else {
    if (east) arms.push({ x: 0.25, z: 0, alongX: true, half: true });
    if (west) arms.push({ x: -0.25, z: 0, alongX: true, half: true });
    if (south) arms.push({ x: 0, z: 0.25, alongX: false, half: true });
    if (north) arms.push({ x: 0, z: -0.25, alongX: false, half: true });
  }

  const height = style.height ?? 1;
  const top = WALL_TOP * height;
  const pieces: Local[] = [];
  for (const arm of arms) {
    const length = arm.half ? 0.5 : 1;
    const wall: Local = {
      kit: 'castle',
      model: style.model,
      x: arm.x,
      z: arm.z,
      rotation: arm.alongX ? 0 : 90,
      scale: [length, height, 1],
    };
    if (style.skin) wall.skin = style.skin;
    pieces.push(wall);
    if (!ctx.machicolations) continue;

    const out = arm.alongX ? outwardSign(ctx.fromKeepZ) : outwardSign(ctx.fromKeepX);
    const rotation = arm.alongX ? (out < 0 ? 0 : 180) : out < 0 ? 90 : 270;
    const at = (offset: number): { x: number; z: number } =>
      arm.alongX ? { x: arm.x, z: arm.z + out * offset } : { x: arm.x + out * offset, z: arm.z };
    pieces.push(
      { kit: 'retro', model: 'overhang', ...at(0.55), y: top - 0.31, rotation, scale: [length, 1, 1] },
      { kit: 'retro', model: 'battlement', ...at(0.15), y: top, rotation, scale: [length, 1, 1] },
    );
  }
  return pieces;
}

/**
 * Turns a whole building on the spot: every piece swings around the footprint
 * centre and turns on itself by the same angle. Walls and gatehouses work out
 * their own bearing from the wall line they sit in, so this is for everything
 * that has nothing to take its line from.
 */
function turned(pieces: readonly Local[], facing: number): Local[] {
  if (facing % 360 === 0) return pieces as Local[];
  const rad = (facing * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  return pieces.map((p) => {
    const x = p.x ?? 0;
    const z = p.z ?? 0;
    // A turn about y maps (x, z) to (x cos + z sin, -x sin + z cos); the scale
    // stays in the model's own frame, where it was authored.
    return { ...p, x: x * cos + z * sin, z: -x * sin + z * cos, rotation: (p.rotation ?? 0) + facing };
  });
}

function gatehousePieces(facing: number): Local[] {
  return [
    { kit: 'castle', model: 'tower-square-arch', rotation: facing, scale: [1.06, 1.35, 1.06] },
    { kit: 'castle', model: 'tower-square-top-roof', y: 1.36, rotation: facing, scale: 1.06 },
    { kit: 'castle', model: 'flag-pennant', y: 2.42 },
  ];
}

/** The mechanisms at rest — bridge down — for previews and icons. */
function gateAtRest(facing: number): Local[] {
  const rad = (facing * Math.PI) / 180;
  const along = (d: number): { x: number; z: number } => ({ x: Math.cos(rad) * d, z: -Math.sin(rad) * d });
  return [
    {
      kit: 'castle',
      model: 'bridge-draw',
      ...along(GATE.hinge),
      y: GATE.deckLift,
      rotation: facing + 180,
      scale: GATE.bridgeScale,
    },
    { kit: 'castle', model: 'metal-gate', ...along(GATE.portcullisAt), rotation: facing, scale: GATE.portcullisScale },
  ];
}

/** Town Kit wall panels sit on a cell's +x edge (x 0.4..0.5); rotated 270 they face +z. */
const panelX = (model: string, face: number, z: number, y: number, height: number): Local => ({
  kit: 'town',
  model,
  x: face - 0.4,
  y,
  z,
  scale: [1, height, 1],
});
const panelZ = (model: string, face: number, x: number, y: number, height: number): Local => ({
  kit: 'town',
  model,
  x,
  y,
  z: face - 0.4,
  rotation: 270,
  scale: [1, height, 1],
});

/** A solid storey: a scaled wall block, the core the panels dress. */
const storey = (model: string, width: number, y: number, height: number): Local => ({
  kit: 'town',
  model,
  y,
  scale: [width, height, width],
});

/**
 * The keep grows with every tier — taller, heavier, better roofed — so the
 * tech tree is readable from across the map.
 */
function keepPieces(tier: number): Local[] {
  switch (tier) {
    case 1:
      return [
        storey('wall-wood-block', 2.8, 0, 1.2),
        panelZ('wall-wood-door', 1.4, 0, 0, 1.2),
        panelX('wall-wood-window-shutters', 1.4, -0.75, 0, 1.2),
        panelX('wall-wood-window-shutters', 1.4, 0.75, 0, 1.2),
        { kit: 'town', model: 'roof-high-point', y: 1.2, scale: [2.9, 1.5, 2.9] },
        { kit: 'castle', model: 'flag-banner-short', y: 2.55 },
      ];
    case 2:
      return [
        storey('wall-block', 2.8, 0, 1.1),
        panelZ('wall-door', 1.4, 0, 0, 1.1),
        storey('wall-wood-block', 2.6, 1.1, 1.0),
        panelX('wall-wood-window-shutters', 1.3, -0.7, 1.1, 1.0),
        panelX('wall-wood-window-shutters', 1.3, 0.7, 1.1, 1.0),
        panelZ('wall-wood-window-shutters', 1.3, 0, 1.1, 1.0),
        { kit: 'town', model: 'roof-high-point', y: 2.1, scale: [2.9, 1.5, 2.9] },
        { kit: 'castle', model: 'flag-banner-short', y: 3.45 },
      ];
    case 3:
      return [
        storey('wall-block', 2.8, 0, 1.1),
        panelZ('wall-door', 1.4, 0, 0, 1.1),
        storey('wall-block', 2.6, 1.1, 1.1),
        panelX('wall-window-stone', 1.3, -0.7, 1.1, 1.1),
        panelX('wall-window-stone', 1.3, 0.7, 1.1, 1.1),
        panelZ('wall-window-stone', 1.3, 0, 1.1, 1.1),
        { kit: 'town', model: 'roof-high-point', skin: 'roof-tile', y: 2.2, scale: [2.9, 1.7, 2.9] },
        // Short banners sit on the ridge; a long one would spear up through the roof.
        { kit: 'castle', model: 'flag-banner-short', y: 3.75 },
      ];
    default: {
      const corners: Local[] = [];
      for (const [cx, cz] of [
        [-1.25, -1.25],
        [1.25, -1.25],
        [-1.25, 1.25],
        [1.25, 1.25],
      ] as const)
        corners.push(
          { kit: 'castle', model: 'tower-square-base', x: cx, z: cz, scale: 0.75 },
          { kit: 'castle', model: 'tower-square-mid', x: cx, z: cz, y: 0.76, scale: 0.75 },
          { kit: 'castle', model: 'tower-square-top-roof', x: cx, z: cz, y: 1.51, scale: 0.75 },
        );
      return [
        storey('wall-block', 2.9, 0, 1.3),
        panelZ('wall-door', 1.45, 0, 0, 1.3),
        storey('wall-block', 2.7, 1.3, 1.2),
        panelX('wall-window-stone', 1.35, 0, 1.3, 1.2),
        panelZ('wall-window-stone', 1.35, 0, 1.3, 1.2),
        { kit: 'town', model: 'roof-high-point', skin: 'roof-slate', y: 2.5, scale: [3.0, 1.9, 3.0] },
        { kit: 'castle', model: 'flag-banner-short', y: 4.25 },
        ...corners,
      ];
    }
  }
}

/** Timber tower: a hexagonal base, one extra storey per level, a timber crown. */
function woodenTower(level: number): Local[] {
  const scale = 1.7;
  const base = 1.31 * scale;
  const storeyHeight = 0.46 * scale;
  const pieces: Local[] = [{ kit: 'castle', model: 'tower-hexagon-base', skin: 'palisade', scale }];
  for (let i = 1; i < level; i++)
    pieces.push({
      kit: 'castle',
      model: 'tower-hexagon-mid',
      skin: 'palisade',
      y: base + (i - 1) * storeyHeight,
      scale,
    });
  const top = base + (level - 1) * storeyHeight;
  pieces.push(
    { kit: 'castle', model: 'tower-hexagon-top-wood', skin: 'palisade', y: top, scale },
    { kit: 'castle', model: 'flag-pennant', y: top + 0.67 },
  );
  return pieces;
}

/** Stone tower: a square base, as many middle storeys as its level, a roof. */
function stoneTower(level: number): Local[] {
  const scale = 1.35;
  const storeyHeight = 1.01 * scale;
  const pieces: Local[] = [{ kit: 'castle', model: 'tower-square-base', scale }];
  for (let i = 1; i <= level; i++)
    pieces.push({ kit: 'castle', model: 'tower-square-mid', y: storeyHeight * i, scale });
  pieces.push({ kit: 'castle', model: 'tower-square-top-roof', y: storeyHeight * (level + 1), scale });
  return pieces;
}

/** Camps fill out as they level up: more tents, more stock. */
function woodcutterCamp(level: number): Local[] {
  const pieces: Local[] = [
    { kit: 'nature', model: 'tent_detailedOpen', x: -0.45, z: -0.45, rotation: 200 },
    { kit: 'nature', model: 'log_stack', x: 0.55, z: 0.5, rotation: 30 },
    { kit: 'nature', model: 'campfire_stones', x: -0.5, z: 0.5 },
  ];
  if (level >= 2)
    pieces.push(
      { kit: 'nature', model: 'log_large', x: 0.5, z: -0.5, rotation: 70 },
      { kit: 'nature', model: 'stump_round', x: 0.05, z: 0.1 },
    );
  if (level >= 3)
    pieces.push(
      { kit: 'nature', model: 'tent_smallOpen', x: 0.05, z: 0.6, rotation: 160 },
      { kit: 'nature', model: 'stump_oldTall', x: 0.8, z: 0.05 },
    );
  return pieces;
}

function minerCamp(level: number): Local[] {
  const pieces: Local[] = [
    { kit: 'nature', model: 'tent_smallClosed', x: -0.45, z: -0.45, rotation: 140 },
    { kit: 'retro', model: 'detail-crate', x: 0.5, z: 0.5 },
    { kit: 'nature', model: 'campfire_stones', x: -0.5, z: 0.5 },
  ];
  if (level >= 2)
    pieces.push(
      { kit: 'retro', model: 'barrels', x: 0.55, z: -0.45, rotation: 40 },
      { kit: 'retro', model: 'detail-crate-small', x: 0.1, z: 0.1 },
    );
  if (level >= 3)
    pieces.push(
      { kit: 'nature', model: 'tent_smallOpen', x: 0.05, z: 0.6, rotation: 200 },
      { kit: 'retro', model: 'detail-crate-ropes', x: 0.1, z: -0.5 },
    );
  return pieces;
}

function localPieces(kind: BuildingKind, level: number, ctx: Context, preview: boolean): Local[] {
  switch (kind) {
    case 'keep':
      return turned(keepPieces(level), ctx.facing);
    case 'palisade':
      return wallPieces({ model: 'wall-narrow-wood' }, ctx);
    case 'stone-wall':
      return wallPieces({ model: 'wall' }, ctx);
    case 'reinforced-wall':
      return wallPieces({ model: 'wall', skin: 'reinforced', height: 1.15 }, ctx);
    case 'gatehouse':
      return preview
        ? [...gatehousePieces(ctx.facing), ...gateAtRest(ctx.facing)]
        : gatehousePieces(ctx.facing);
    case 'moat':
      // In play a moat is dug into the terrain; this tile only stands in for
      // it on the menu icon and the placement ghost.
      return preview ? [{ kit: 'nature', model: 'ground_riverTile', y: 0.1 }] : [];
    case 'wooden-tower':
      return turned(woodenTower(level), ctx.facing);
    case 'stone-tower':
      return turned(stoneTower(level), ctx.facing);
    case 'spiked-barricade':
      return [{ kit: 'retro', model: 'structure-cross', rotation: 45 + ctx.facing, scale: 0.9 }];
    case 'woodcutter-camp':
      return turned(woodcutterCamp(level), ctx.facing);
    case 'miner-camp':
      return turned(minerCamp(level), ctx.facing);
  }
}

/** How tall a building stands, for its scaffold and the bar floating above it. */
export function heightOf(kind: BuildingKind, level: number): number {
  switch (kind) {
    case 'keep':
      return [3.3, 4.2, 4.4, 5.0][level - 1] ?? 5;
    case 'wooden-tower':
      return 2.33 + level * 0.78;
    case 'stone-tower':
      return 1.36 * (level + 1) + 1.35;
    case 'gatehouse':
      return 2.8;
    case 'reinforced-wall':
      return 1.6;
    case 'palisade':
    case 'stone-wall':
      return 1.4;
    case 'moat':
      return 0.3;
    default:
      return 1.2;
  }
}

/**
 * How high above the ground a defence looses its shots: the fighting platform,
 * a little below the roof. Machicolations drop theirs from just over the
 * parapet, so a wall that carries them shoots from its own top.
 */
export function muzzleOf(kind: BuildingKind, level: number): number {
  return heightOf(kind, level) * 0.82;
}

function place(pieces: readonly Local[], cx: number, cz: number, ground: number): PlacedPiece[] {
  return pieces.map((p) => {
    const piece: PlacedPiece = {
      kit: p.kit,
      model: p.model,
      placement: {
        x: cx + (p.x ?? 0),
        z: cz + (p.z ?? 0),
        y: ground + (p.y ?? 0),
        rotation: p.rotation ?? 0,
        scale: p.scale ?? 1,
      },
    };
    if (p.skin) piece.skin = p.skin;
    return piece;
  });
}

/** World position of a footprint's centre. */
export function footprintCentre(x: number, z: number, size: number): [number, number] {
  const offset = (size - 1) / 2;
  return [cellToWorldX(x) + offset, cellToWorldZ(z) + offset];
}

function contextOf(game: Game, building: Building): Context {
  const offset = (building.size - 1) / 2;
  return {
    connects: (dx, dz) => game.joinsAt(building, dx, dz),
    fromKeepX: building.x + offset - game.map.keep.x,
    fromKeepZ: building.z + offset - game.map.keep.z,
    machicolations: building.machicolations === true,
    facing: game.facingOf(building),
    turned: building.turn !== 0,
  };
}

/** Every still piece of a building as it stands, walls joined to their neighbours. */
export function piecesOf(game: Game, building: Building): PlacedPiece[] {
  const [cx, cz] = footprintCentre(building.x, building.z, building.size);
  return place(
    localPieces(building.kind, building.level, contextOf(game, building), false),
    cx,
    cz,
    game.map.heights.ground,
  );
}

/** A gatehouse's drawbridge and portcullis; nothing for any other building. */
export function movingPiecesOf(game: Game, building: Building): MovingPiece[] {
  if (building.kind !== 'gatehouse') return [];
  const facing = game.facingOf(building);
  const [cx, cz] = footprintCentre(building.x, building.z, building.size);
  return [
    { kit: 'castle', model: 'bridge-draw', part: 'drawbridge', cx, cz, facing },
    { kit: 'castle', model: 'metal-gate', part: 'portcullis', cx, cz, facing },
  ];
}

/**
 * Which way a building points when it stands on its own, with no wall line to
 * read: a gatehouse opens toward the camera, so its icon and its ghost show
 * the drawbridge rather than the back of a tower.
 */
const PREVIEW_FACING: Partial<Record<BuildingKind, number>> = { gatehouse: 270 };

/**
 * A building on its own, centred on a world point — for the placement ghost
 * and for the build menu's icons.
 *
 * `connects` is what tells the two apart. An icon stands in a void and passes
 * nothing, so it always shows the piece whole. The ghost passes the neighbours
 * of the cell under the cursor, so what it shows is what will actually be
 * built: without that it drew the player's rotation while the wall that landed
 * took its line from the wall beside it, and the rotation looked cancelled.
 */
export function previewPieces(
  kind: BuildingKind,
  level: number,
  cx: number,
  cz: number,
  ground: number,
  turn = 0,
  connects: (dx: number, dz: number) => boolean = () => false,
): PlacedPiece[] {
  const quarters = ((turn % 4) + 4) % 4;
  const ctx: Context = {
    connects,
    fromKeepX: 0,
    fromKeepZ: 1,
    machicolations: false,
    facing: ((PREVIEW_FACING[kind] ?? 0) + quarters * 90) % 360,
    turned: quarters !== 0,
  };
  return place(localPieces(kind, level, ctx, true), cx, cz, ground);
}
