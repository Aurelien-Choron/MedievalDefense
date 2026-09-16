import * as THREE from 'three';

/**
 * Dust: the puffs thrown up while something is being built, and the burst
 * when it is done. A single pooled InstancedMesh — one draw call however
 * many sites are busy. A spent puff is scaled to zero rather than removed.
 */

interface Puff {
  position: THREE.Vector3;
  velocity: THREE.Vector3;
  spin: THREE.Quaternion;
  age: number;
  life: number;
  size: number;
}

const DRAG = 2.2; // per second
const RISE = 0.35; // gentle buoyancy, units per second squared

export class Dust {
  readonly mesh: THREE.InstancedMesh;
  private readonly puffs: Puff[] = [];
  private next = 0;
  private readonly matrix = new THREE.Matrix4();
  private readonly scale = new THREE.Vector3();

  constructor(capacity = 160) {
    this.mesh = new THREE.InstancedMesh(
      new THREE.IcosahedronGeometry(0.2, 0),
      new THREE.MeshLambertMaterial({ color: 0xf0e4cf, flatShading: true }),
      capacity,
    );
    this.mesh.name = 'dust';
    this.mesh.frustumCulled = false;
    for (let i = 0; i < capacity; i++) {
      this.puffs.push({
        position: new THREE.Vector3(),
        velocity: new THREE.Vector3(),
        spin: new THREE.Quaternion(),
        age: 1,
        life: 0,
        size: 0,
      });
      this.mesh.setMatrixAt(i, this.matrix.makeScale(0, 0, 0));
    }
  }

  /** Throws `count` puffs out from a point, across a footprint of `radius`. */
  burst(x: number, y: number, z: number, radius: number, count: number, strength = 1): void {
    for (let n = 0; n < count; n++) {
      const puff = this.puffs[this.next]!;
      this.next = (this.next + 1) % this.puffs.length;
      const angle = Math.random() * Math.PI * 2;
      const r = radius * (0.6 + Math.random() * 0.4);
      puff.position.set(x + Math.cos(angle) * r, y + Math.random() * 0.2, z + Math.sin(angle) * r);
      const out = (0.8 + Math.random() * 1.2) * strength;
      puff.velocity.set(Math.cos(angle) * out, (0.6 + Math.random() * 1.2) * strength, Math.sin(angle) * out);
      puff.spin.setFromEuler(new THREE.Euler(Math.random() * 3, Math.random() * 3, Math.random() * 3));
      puff.age = 0;
      puff.life = 0.55 + Math.random() * 0.5;
      puff.size = (0.7 + Math.random() * 0.8) * Math.min(1.4, 0.7 + radius * 0.3);
    }
  }

  update(dt: number): void {
    const damping = Math.exp(-DRAG * dt);
    this.puffs.forEach((puff, i) => {
      if (puff.age >= puff.life) return;
      puff.age += dt;
      const t = puff.age / puff.life;
      if (t >= 1) {
        this.mesh.setMatrixAt(i, this.matrix.makeScale(0, 0, 0));
        return;
      }
      puff.velocity.multiplyScalar(damping);
      puff.velocity.y += RISE * dt;
      puff.position.addScaledVector(puff.velocity, dt);
      // Swell fast, then shrink away: reads as dust settling without needing
      // per-instance transparency.
      const s = puff.size * (t < 0.2 ? t / 0.2 : 1 - (t - 0.2) / 0.8);
      this.mesh.setMatrixAt(i, this.matrix.compose(puff.position, puff.spin, this.scale.setScalar(s)));
    });
    this.mesh.instanceMatrix.needsUpdate = true;
  }
}
