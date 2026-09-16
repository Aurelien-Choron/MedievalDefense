// Proves the load-bearing architectural claim: modules under src/core and
// src/sim import no three.js, so node runs them directly (via its built-in type
// stripping) with no build step. Every flow-field and economy test in P3/P4
// depends on this staying true.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MAP_SIZE,
  CELL_COUNT,
  cellIndex,
  cellX,
  cellZ,
  inBounds,
  cellToWorldX,
  cellToWorldZ,
  worldToCellX,
  worldToCellZ,
  NEIGHBOURS,
} from '../src/core/grid.ts';

test('cell index round-trips', () => {
  for (const [x, z] of [[0, 0], [1, 0], [0, 1], [MAP_SIZE - 1, MAP_SIZE - 1], [21, 12]] as const) {
    const i = cellIndex(x, z);
    assert.equal(cellX(i), x);
    assert.equal(cellZ(i), z);
  }
});

test('indices cover exactly the grid', () => {
  assert.equal(cellIndex(0, 0), 0);
  assert.equal(cellIndex(MAP_SIZE - 1, MAP_SIZE - 1), CELL_COUNT - 1);
});

test('bounds reject off-grid cells', () => {
  assert.ok(inBounds(0, 0));
  assert.ok(inBounds(MAP_SIZE - 1, MAP_SIZE - 1));
  for (const [x, z] of [[-1, 0], [0, -1], [MAP_SIZE, 0], [0, MAP_SIZE]] as const)
    assert.ok(!inBounds(x, z));
});

test('world coordinates round-trip back to the same cell', () => {
  for (let c = 0; c < MAP_SIZE; c++) {
    assert.equal(worldToCellX(cellToWorldX(c)), c);
    assert.equal(worldToCellZ(cellToWorldZ(c)), c);
  }
});

test('the grid is centred on the origin', () => {
  // Centring matters because the camera clamps its pan against +/- MAP_SIZE/2.
  assert.equal(cellToWorldX(0) + cellToWorldX(MAP_SIZE - 1), 0);
  assert.equal(cellToWorldZ(0) + cellToWorldZ(MAP_SIZE - 1), 0);
});

test('neighbours are the 4 orthogonals first, then the 4 diagonals', () => {
  assert.equal(NEIGHBOURS.length, 8);
  const orthogonal = NEIGHBOURS.slice(0, 4);
  const diagonal = NEIGHBOURS.slice(4);
  assert.ok(orthogonal.every(([dx, dz]) => Math.abs(dx) + Math.abs(dz) === 1));
  assert.ok(diagonal.every(([dx, dz]) => Math.abs(dx) === 1 && Math.abs(dz) === 1));
  // No duplicates, and no zero offset.
  assert.equal(new Set(NEIGHBOURS.map(String)).size, 8);
});
