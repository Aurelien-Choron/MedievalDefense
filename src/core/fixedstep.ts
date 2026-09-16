/**
 * Turns variable frame times into a fixed-rate update.
 *
 * The simulation always advances in equal steps, whatever the framerate, so
 * a build time or a unit speed tuned at 144 Hz holds at 60. What is left over
 * between steps is returned as a 0..1 fraction for render interpolation.
 */
export class FixedStep {
  readonly step: number;
  private readonly maxSteps: number;
  private accumulator = 0;

  /**
   * @param step seconds per update
   * @param maxSteps updates allowed per frame; past that the backlog is
   *   dropped, so a stalled tab does not come back to a burst of catch-up
   *   work that stalls it again
   */
  constructor(step: number, maxSteps = 8) {
    this.step = step;
    this.maxSteps = maxSteps;
  }

  advance(dt: number, update: (step: number) => void): number {
    this.accumulator += dt;
    let steps = 0;
    // The slack absorbs float drift: twenty additions of 0.05 do not quite
    // make 1.0, and without it a whole second would yield only 19 steps.
    while (this.accumulator >= this.step - 1e-9 && steps < this.maxSteps) {
      update(this.step);
      this.accumulator -= this.step;
      steps++;
    }
    if (steps === this.maxSteps) this.accumulator = 0;
    return Math.max(this.accumulator, 0) / this.step;
  }
}
