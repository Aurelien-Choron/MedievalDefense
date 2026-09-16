/**
 * The wood, as the simulation sees it: one tree per cell, felled by a
 * woodcutter and grown back after a while.
 *
 * Which cells carry a trunk is map data (`MapData.trees`, laid down once by
 * tools/gen-map.mjs), so the sim and the renderer cannot drift apart about
 * where the forest is. What changes during a game is only which of them are
 * standing, and that lives in the saved state — a felled wood is worth
 * remembering across a reload.
 *
 * src/render/scatter.ts holds no state of its own about this: it is told which
 * cells to show and which to hide, exactly as it already is for the props a
 * building covers.
 */

/** A stump counting down to a new tree. */
export interface Felled {
  cell: number;
  /** Seconds left before it grows back. */
  regrow: number;
}

/** How long a cleared cell takes to carry a tree again. */
export const REGROW_TIME = 60;

export class Forest {
  /** Every cell that can ever carry a tree. */
  readonly cells: ReadonlySet<number>;
  /** The live array out of GameState, so felling is saved with everything else. */
  private readonly felled: Felled[];
  private readonly down = new Set<number>();

  constructor(trees: readonly number[], felled: Felled[]) {
    this.cells = new Set(trees);
    this.felled = felled;
    for (const stump of felled) this.down.add(stump.cell);
  }

  /** Whether a cell has a tree on it right now. */
  standing(cell: number): boolean {
    return this.cells.has(cell) && !this.down.has(cell);
  }

  /** Every tree still up, in map order. */
  *standingCells(): Iterable<number> {
    for (const cell of this.cells) if (!this.down.has(cell)) yield cell;
  }

  /** Cuts one down. False if there was nothing there to cut. */
  fell(cell: number): boolean {
    if (!this.standing(cell)) return false;
    this.down.add(cell);
    this.felled.push({ cell, regrow: REGROW_TIME });
    return true;
  }

  /** Counts the stumps down by one step and returns the cells that came back. */
  tick(dt: number): number[] {
    if (this.felled.length === 0) return [];
    const grown: number[] = [];
    for (let i = this.felled.length - 1; i >= 0; i--) {
      const stump = this.felled[i]!;
      stump.regrow -= dt;
      if (stump.regrow > 0) continue;
      this.felled.splice(i, 1);
      this.down.delete(stump.cell);
      grown.push(stump.cell);
    }
    return grown;
  }
}
