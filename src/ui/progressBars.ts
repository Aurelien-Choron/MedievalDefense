import * as THREE from 'three';
import { footprintCentre, heightOf } from '../render/buildingVisuals.js';
import { progressOf, remainingOf, type Game } from '../sim/game.js';
import { formatDuration } from './format.js';

/**
 * A progress bar and countdown floating over every building at work.
 *
 * HTML rather than 3D: crisp text at any zoom, no draw calls, and a handful of
 * elements is nothing to reposition each frame.
 */

interface Bar {
  el: HTMLElement;
  fill: HTMLElement;
  label: HTMLElement;
}

export class ProgressBars {
  private readonly root: HTMLElement;
  private readonly game: Game;
  private readonly bars = new Map<number, Bar>();
  private readonly point = new THREE.Vector3();

  constructor(root: HTMLElement, game: Game) {
    this.root = root;
    this.game = game;
  }

  update(camera: THREE.Camera): void {
    const seen = new Set<number>();
    const ground = this.game.map.heights.ground;

    for (const b of this.game.state.buildings) {
      if (!b.job) continue;
      seen.add(b.id);
      let bar = this.bars.get(b.id);
      if (!bar) {
        const el = document.createElement('div');
        // A line of walls is a row of one-cell sites: full bars with timers
        // would stack into an unreadable pile, so those get a slim bar alone.
        el.className = `job ${b.job.type}${b.size === 1 ? ' compact' : ''}`;
        el.innerHTML = '<div><span></span><div class="track"><div class="fill"></div></div></div>';
        this.root.append(el);
        bar = { el, fill: el.querySelector<HTMLElement>('.fill')!, label: el.querySelector<HTMLElement>('span')! };
        this.bars.set(b.id, bar);
      }

      const [cx, cz] = footprintCentre(b.x, b.z, b.size);
      const level = b.job.type === 'upgrade' ? b.level + 1 : b.level;
      this.point.set(cx, ground + heightOf(b.kind, level) + 0.35, cz).project(camera);
      const x = ((this.point.x + 1) / 2) * innerWidth;
      const y = ((1 - this.point.y) / 2) * innerHeight;
      bar.el.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px)`;
      bar.fill.style.width = `${(progressOf(b) * 100).toFixed(1)}%`;
      bar.label.textContent = formatDuration(remainingOf(b));
    }

    for (const [id, bar] of this.bars)
      if (!seen.has(id)) {
        bar.el.remove();
        this.bars.delete(id);
      }
  }
}
