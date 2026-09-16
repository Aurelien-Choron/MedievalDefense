/**
 * Towers shooting at whatever comes.
 *
 * Pure, like the rest of src/sim: it reads the buildings out of the Game, asks
 * a TargetSource what stands within reach, and hands back the shots it loosed.
 * It knows nothing of attackers — not how they move, how they are stored, nor
 * how a shaft is drawn. P4 plugs its own TargetSource in, built on the wave
 * units and their spatial hash, and the towers start firing without a line of
 * this file changing.
 *
 * Two decisions worth keeping in mind:
 *
 * - **Damage lands the moment a shot leaves.** The flight is a cosmetic arc in
 *   the renderer (src/render/projectiles.ts). That keeps the simulation
 *   deterministic at the fixed step and testable in node, and no tower can be
 *   cheated out of a kill by a frame rate.
 * - **Aim is sticky.** A turret keeps the target it has while that target
 *   lives and stays in range, rather than swinging to whatever is nearest
 *   every volley. It stops arrows chasing a crowd and never finishing anyone.
 */
import type { Projectile } from '../data/buildings.ts';
import { centreOf, type Building, type Game } from './game.ts';

/**
 * Something a tower can shoot at. Positions are continuous cell coordinates:
 * the centre of cell (x, z) is exactly (x, z), which is the frame the flow
 * field and the walking grid of P4 will use.
 */
export interface Target {
  id: number;
  x: number;
  z: number;
  hp: number;
  /** What it started with: enough for a health bar without the renderer keeping books. */
  maxHp: number;
}

/** Where the defences find something to shoot at. P4 backs this with its units. */
export interface TargetSource {
  /** Everything attackable within `radius` cells of a point, in any order. */
  near(x: number, z: number, radius: number): Iterable<Target>;
  /** The target with this id, or undefined once it is gone. */
  byId(id: number): Target | undefined;
  /** Takes hit points off. What dying means is the source's business. */
  hurt(target: Target, damage: number): void;
}

/** One shaft on its way, for the renderer to draw and for the tests to count. */
export interface Shot {
  buildingId: number;
  targetId: number;
  /** Where the target stood when the shaft left, in cell coordinates. */
  x: number;
  z: number;
  damage: number;
  projectile: Projectile;
  /** Whether this shaft took the target's last hit point. */
  killed: boolean;
}

interface Turret {
  /** Seconds before it can loose again. */
  cooldown: number;
  /** The target it is holding, or 0 for none. */
  targetId: number;
}

/** A building only shoots once it stands; an upgrade leaves the garrison in place. */
const manned = (building: Building): boolean => building.job?.type !== 'construct';

export class Defenses {
  private readonly game: Game;
  private readonly turrets = new Map<number, Turret>();

  constructor(game: Game) {
    this.game = game;
  }

  /** What a building's turret is holding, for the interface and the tests. */
  targetOf(building: Building): number {
    return this.turrets.get(building.id)?.targetId ?? 0;
  }

  /** Advances every defence by one fixed step and returns what they loosed. */
  tick(dt: number, targets: TargetSource): Shot[] {
    const shots: Shot[] = [];
    const live = new Set<number>();

    for (const building of this.game.state.buildings) {
      const attack = this.game.attackOf(building);
      if (!attack || !manned(building)) continue;
      live.add(building.id);

      let turret = this.turrets.get(building.id);
      if (!turret) this.turrets.set(building.id, (turret = { cooldown: 0, targetId: 0 }));
      turret.cooldown = Math.max(0, turret.cooldown - dt);

      const [cx, cz] = centreOf(building);
      let target = this.aim(turret, targets, cx, cz, attack.range);
      if (!target) {
        turret.targetId = 0;
        continue;
      }
      if (turret.cooldown > 0) continue;

      for (let shaft = 0; shaft < attack.shots; shaft++) {
        // A volley that finishes its mark moves on rather than emptying itself
        // into a corpse.
        if (target.hp <= 0) {
          turret.targetId = 0;
          target = this.aim(turret, targets, cx, cz, attack.range);
          if (!target) break;
        }
        targets.hurt(target, attack.damage);
        shots.push({
          buildingId: building.id,
          targetId: target.id,
          x: target.x,
          z: target.z,
          damage: attack.damage,
          projectile: attack.projectile,
          killed: target.hp <= 0,
        });
      }
      turret.cooldown = attack.reload;
    }

    // Turrets outlive nothing: a tower pulled down or still being raised keeps
    // no aim, and neither reloads while it cannot shoot.
    for (const id of this.turrets.keys()) if (!live.has(id)) this.turrets.delete(id);
    return shots;
  }

  /**
   * The target a turret shoots at: the one it already holds while that one
   * lives and stays in reach, the nearest otherwise. Ties go to the lower id,
   * so the same map and the same inputs always give the same shots.
   */
  private aim(turret: Turret, targets: TargetSource, cx: number, cz: number, range: number): Target | null {
    const reach = range * range;
    const held = turret.targetId ? targets.byId(turret.targetId) : undefined;
    if (held && held.hp > 0 && distanceSq(held, cx, cz) <= reach) return held;

    let best: Target | null = null;
    let nearest = Infinity;
    for (const candidate of targets.near(cx, cz, range)) {
      if (candidate.hp <= 0) continue;
      const d = distanceSq(candidate, cx, cz);
      if (d > reach) continue;
      if (d < nearest || (d === nearest && best !== null && candidate.id < best.id)) {
        nearest = d;
        best = candidate;
      }
    }
    turret.targetId = best?.id ?? 0;
    return best;
  }
}

function distanceSq(target: Target, cx: number, cz: number): number {
  const dx = target.x - cx;
  const dz = target.z - cz;
  return dx * dx + dz * dz;
}

/**
 * A plain list of targets, standing in for the attackers until P4 brings its
 * own. It is what `md.dummy()` drops on the map to watch the towers work, and
 * what tests/defense.test.ts shoots at.
 */
export class PracticeTargets implements TargetSource {
  private readonly targets: Target[] = [];
  private nextId = 1;

  get all(): readonly Target[] {
    return this.targets;
  }

  /** Puts a target at a cell and returns it. */
  add(x: number, z: number, hp = 100): Target {
    const target: Target = { id: this.nextId++, x, z, hp, maxHp: hp };
    this.targets.push(target);
    return target;
  }

  clear(): void {
    this.targets.length = 0;
  }

  near(x: number, z: number, radius: number): Iterable<Target> {
    // Small enough that the whole list is cheaper than any index. P4 replaces
    // this with a lookup into the spatial hash.
    const reach = radius * radius;
    return this.targets.filter((t) => t.hp > 0 && distanceSq(t, x, z) <= reach);
  }

  byId(id: number): Target | undefined {
    return this.targets.find((t) => t.id === id);
  }

  hurt(target: Target, damage: number): void {
    target.hp -= damage;
    if (target.hp > 0) return;
    target.hp = 0;
    const index = this.targets.indexOf(target);
    if (index >= 0) this.targets.splice(index, 1);
  }
}
