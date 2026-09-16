import * as THREE from 'three';
import { MAP_SIZE, TILE } from '../core/grid.js';

/**
 * Isometric RTS camera: an orthographic view at the classic 45deg yaw /
 * 35.264deg pitch, over a map small enough to fit on one screen.
 *
 * Orthographic is the right choice here rather than a perspective rig: it keeps
 * every wall segment the same size wherever it sits on the map, which is what
 * makes a build grid readable, and it makes the shadow camera trivial to fit.
 *
 * All panning goes through one pair of ground axes derived from the yaw —
 * screen right and screen up, flattened onto the ground — so keys, drag and
 * wheel can never disagree about which way is which.
 */

const PITCH = Math.atan(1 / Math.SQRT2); // 35.264deg — true isometric
const SIN_PITCH = Math.sin(PITCH);
const COS_PITCH = Math.cos(PITCH);
const DISTANCE = 120; // far enough that the near plane never clips the terrain

/** Pixels a press may wander and still count as a click rather than a drag. */
const CLICK_SLOP = 5;

const ZOOM_MIN = 8;
/** How far past a snug fit of the whole map the view may pull back. */
const ZOOM_OUT_SLACK = 1.12;
/** Multiplicative, so a wheel notch feels the same close in and far out. */
const WHEEL_STEP = 1.15;
/** Keyboard pan speed in view heights per second: slower when zoomed in. */
const PAN_SPEED = 0.75;

/**
 * Pan bindings by physical key position (KeyboardEvent.code), not by the
 * character typed. KeyW is the key printed Z on an AZERTY keyboard, so this one
 * table is WASD on QWERTY and ZQSD on AZERTY, with no layout detection.
 * Values are [screen right, screen up].
 */
const PAN_KEYS: Readonly<Record<string, readonly [number, number]>> = {
  KeyW: [0, 1],
  KeyA: [-1, 0],
  KeyS: [0, -1],
  KeyD: [1, 0],
  ArrowUp: [0, 1],
  ArrowLeft: [-1, 0],
  ArrowDown: [0, -1],
  ArrowRight: [1, 0],
};

/** Beside the pan keys on both layouts: Q/E on QWERTY, A/E on AZERTY. */
const ROTATE_KEYS: Readonly<Record<string, number>> = { KeyQ: -1, KeyE: 1 };

export interface CameraBounds {
  /** Height of the playable ground; the camera's target sits on it. */
  ground: number;
  /** Tallest terrain above the ground and deepest geometry below it, for fitting. */
  above: number;
  below: number;
}

export class IsoCamera {
  readonly camera: THREE.OrthographicCamera;

  /** Point on the ground the camera looks at. */
  readonly target = new THREE.Vector3(0, 0, 0);

  /** Vertical extent of the view in world units; smaller is closer in. */
  private zoom = 40;
  /** Zoom at which the whole map just fits the window. */
  private fitZoom = 40;

  /** Yaw in quarter turns, so the map can be inspected from any corner. */
  private yawStep = 0;
  private yaw = Math.PI / 4;

  /** A press on the map that never turned into a drag. */
  onClick: ((e: PointerEvent) => void) | null = null;
  /** Whether a left-button drag pans. The game turns it off while laying walls. */
  leftDragPans: () => boolean = () => true;

  private readonly offset = new THREE.Vector3();
  private readonly keys = new Set<string>();
  private drag: {
    id: number;
    button: number;
    x: number;
    y: number;
    startX: number;
    startY: number;
    panning: boolean;
  } | null = null;

  constructor(
    private readonly dom: HTMLElement,
    private readonly bounds: CameraBounds,
  ) {
    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 400);
    this.target.y = bounds.ground;
    this.resize();
    this.zoom = this.fitZoom;
    this.resize();
    this.apply();
    this.bind();
  }

  private bind(): void {
    addEventListener('resize', () => this.resize());

    // Zoom toward the cursor: the ground point under the pointer stays put.
    this.dom.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        const before = this.zoom;
        this.setZoom(before * (e.deltaY > 0 ? WHEEL_STEP : 1 / WHEEL_STEP));
        const [right, up] = this.cursorOffset(e.clientX, e.clientY, before);
        const k = 1 - this.zoom / before;
        this.panBy(right * k, up * k);
      },
      { passive: false },
    );

    addEventListener('keydown', (e) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.code in PAN_KEYS) {
        this.keys.add(e.code);
        e.preventDefault();
      }
      const turn = ROTATE_KEYS[e.code];
      if (turn !== undefined && !e.repeat) this.rotate(turn);
    });
    addEventListener('keyup', (e) => this.keys.delete(e.code));
    addEventListener('blur', () => this.keys.clear());

    // Drag grabs the ground: whatever is under the pointer follows it. A press
    // only becomes a drag once it has moved a few pixels; one that never does
    // is a click, handed to onClick. The pan then catches up the pixels spent
    // inside the slop, so the ground still ends up exactly under the cursor.
    this.dom.addEventListener('pointerdown', (e) => {
      this.drag = {
        id: e.pointerId,
        button: e.button,
        x: e.clientX,
        y: e.clientY,
        startX: e.clientX,
        startY: e.clientY,
        panning: false,
      };
      this.dom.setPointerCapture(e.pointerId);
    });
    const release = (e: PointerEvent, clicked: boolean): void => {
      const drag = this.drag;
      if (drag?.id !== e.pointerId) return;
      this.drag = null;
      if (this.dom.hasPointerCapture(e.pointerId)) this.dom.releasePointerCapture(e.pointerId);
      if (clicked && !drag.panning) this.onClick?.(e);
    };
    this.dom.addEventListener('pointerup', (e) => release(e, true));
    this.dom.addEventListener('pointercancel', (e) => release(e, false));
    this.dom.addEventListener('pointermove', (e) => {
      const drag = this.drag;
      if (drag?.id !== e.pointerId) return;
      if (!drag.panning) {
        const moved = Math.hypot(e.clientX - drag.startX, e.clientY - drag.startY) > CLICK_SLOP;
        if (!moved || (drag.button === 0 && !this.leftDragPans())) return;
        drag.panning = true;
      }
      // Client coordinates rather than movementX/Y, which some browsers report
      // in device pixels and so drift from the cursor on high-DPI screens.
      const dx = e.clientX - drag.x;
      const dy = e.clientY - drag.y;
      drag.x = e.clientX;
      drag.y = e.clientY;
      const perPixel = this.zoom / innerHeight;
      // Moving the camera opposite to the pointer is what keeps the ground
      // under it. Screen y grows downward, and a vertical screen pixel covers
      // 1/sin(pitch) world units of ground.
      this.panBy(-dx * perPixel, (dy * perPixel) / SIN_PITCH);
    });
    this.dom.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  /** A client position as a ground offset from the view centre, [right, up]. */
  private cursorOffset(clientX: number, clientY: number, zoom: number): [number, number] {
    const rect = this.dom.getBoundingClientRect();
    const perPixel = zoom / rect.height;
    const right = (clientX - rect.left - rect.width / 2) * perPixel;
    const up = ((rect.top + rect.height / 2 - clientY) * perPixel) / SIN_PITCH;
    return [right, up];
  }

  private rotate(direction: number): void {
    this.yawStep = (this.yawStep + direction + 4) % 4;
    this.yaw = Math.PI / 4 + (this.yawStep * Math.PI) / 2;
    this.apply();
  }

  /**
   * Pans along the ground, in world units along screen right and screen up.
   *
   * The camera sits at +(sin yaw, cos yaw) from its target, so looking into the
   * screen is -(sin yaw, cos yaw) on the ground and screen right is
   * (cos yaw, -sin yaw). Getting that second sign wrong rotates every control
   * by a quarter turn, which is exactly how the first version shipped.
   */
  private panBy(right: number, up: number): void {
    const sin = Math.sin(this.yaw);
    const cos = Math.cos(this.yaw);
    this.target.x += right * cos - up * sin;
    this.target.z += -right * sin - up * cos;

    const half = (MAP_SIZE * TILE) / 2;
    this.target.x = THREE.MathUtils.clamp(this.target.x, -half, half);
    this.target.z = THREE.MathUtils.clamp(this.target.z, -half, half);
    this.apply();
  }

  private setZoom(zoom: number): void {
    this.zoom = THREE.MathUtils.clamp(zoom, ZOOM_MIN, this.fitZoom * ZOOM_OUT_SLACK);
    this.resize();
  }

  private resize(): void {
    const aspect = innerWidth / Math.max(1, innerHeight);

    // The map is a square seen corner-on, so its diagonal spans the screen
    // horizontally and, foreshortened by the pitch, vertically — plus whatever
    // relief stands above or hangs below the ground.
    const diagonal = MAP_SIZE * TILE * Math.SQRT2;
    const tall = diagonal * SIN_PITCH + (this.bounds.above + this.bounds.below) * COS_PITCH;
    this.fitZoom = Math.max(tall, diagonal / aspect) * 1.02;
    this.zoom = THREE.MathUtils.clamp(this.zoom, ZOOM_MIN, this.fitZoom * ZOOM_OUT_SLACK);

    const half = this.zoom / 2;
    this.camera.left = -half * aspect;
    this.camera.right = half * aspect;
    this.camera.top = half;
    this.camera.bottom = -half;
    this.camera.updateProjectionMatrix();
  }

  private apply(): void {
    const horizontal = COS_PITCH * DISTANCE;
    this.offset.set(
      Math.sin(this.yaw) * horizontal,
      SIN_PITCH * DISTANCE,
      Math.cos(this.yaw) * horizontal,
    );
    this.camera.position.copy(this.target).add(this.offset);
    this.camera.lookAt(this.target);
  }

  update(dt: number): void {
    let right = 0;
    let up = 0;
    for (const code of this.keys) {
      const dir = PAN_KEYS[code];
      if (!dir) continue;
      right += dir[0];
      up += dir[1];
    }
    if (!right && !up) return;
    const step = (PAN_SPEED * this.zoom * dt) / Math.hypot(right, up);
    this.panBy(right * step, (up * step) / SIN_PITCH);
  }

  /** The whole map, centred, at the zoom that just fits it. */
  frameMap(): void {
    this.target.set(0, this.bounds.ground, 0);
    this.setZoom(this.fitZoom);
    this.apply();
  }

  /** Debug handle used by tools/smoke.mjs to frame a specific spot. */
  frame(x: number, z: number, zoom?: number): void {
    this.target.set(x, this.bounds.ground, z);
    if (zoom !== undefined) this.setZoom(zoom);
    this.apply();
  }
}

interface KeyboardLayout {
  keyboard?: { getLayoutMap(): Promise<Map<string, string>> };
}

/**
 * The controls hint, labelled with the keys this keyboard actually prints.
 * Chromium's keyboard API turns physical codes into labels — ZQSD and A/E on
 * AZERTY. Elsewhere both layouts are named, since the bindings follow physical
 * position either way.
 */
export async function controlsHint(): Promise<string> {
  const layout = await (navigator as Navigator & KeyboardLayout).keyboard
    ?.getLayoutMap()
    .catch(() => undefined);
  const label = (code: string): string => layout?.get(code)?.toUpperCase() ?? '?';

  const pan = layout ? ['KeyW', 'KeyA', 'KeyS', 'KeyD'].map(label).join('') : 'WASD / ZQSD';
  const rotate = layout ? `<b>${label('KeyQ')}</b>/<b>${label('KeyE')}</b>` : '<b>Q</b>/<b>E</b> (<b>A</b>/<b>E</b>)';

  const turn = layout ? `<b>${label('KeyR')}</b>` : '<b>R</b>';

  return (
    `<b>${pan}</b> / <b>arrows</b> / <b>drag</b> pan &middot; <b>scroll</b> zoom &middot; ` +
    `${rotate} turn the view &middot; <b>1</b>&ndash;<b>0</b> build &middot; ${turn} turn the building &middot; ` +
    `<b>Esc</b> cancel`
  );
}
