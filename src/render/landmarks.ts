import * as THREE from 'three';
import type { MapData } from '../core/map.js';
import { cellToWorldX, cellToWorldZ } from '../core/grid.js';
import { mergedField, type PlacedPiece } from './assets.js';

/**
 * Fixed features of the map that are neither terrain nor scatter — for now,
 * the wooden bridge on the river road.
 *
 * Buildings, the keep included, are not landmarks: they belong to the game
 * state and are drawn by buildRenderer.ts.
 */

export interface Landmarks {
  group: THREE.Group;
  models: number;
}

export async function buildLandmarks(map: MapData): Promise<Landmarks> {
  const pieces: PlacedPiece[] = [];

  // --- the wooden bridge on the river road -----------------------------------
  // The deck top sits just above the road on both landings. Kenney's bridge
  // pieces run along their local x, so they turn a quarter to span the river
  // road, and the railing pieces turn to face outward. The kit paints its
  // planks with its "stone" colour, hence the skin.
  const { bridge } = map;
  const deck = map.heights.ground - 0.22;
  for (let z = bridge.from; z <= bridge.to; z++)
    for (let dx = -bridge.halfWidth; dx <= bridge.halfWidth; dx++)
      pieces.push({
        kit: 'nature',
        model: dx === 0 ? 'bridge_center_wood' : 'bridge_side_wood',
        skin: 'bridge-planks',
        placement: {
          x: cellToWorldX(bridge.x + dx),
          z: cellToWorldZ(z),
          y: deck,
          rotation: dx > 0 ? 270 : 90,
        },
      });

  const group = await mergedField(pieces);
  group.name = 'landmarks';
  return { group, models: new Set(pieces.map((p) => p.model)).size };
}
