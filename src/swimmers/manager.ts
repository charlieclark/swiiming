import * as THREE from 'three';
import { LIMITS, type TankDims } from '../config';
import { SUBJECT_STRIDE } from '../sim/fluid';
import type { Ripples } from '../water/ripples';
import { Swimmer } from './swimmer';

const WALL_MARGIN = 0.45;
const MIN_SPACING = 0.85;

export interface SwimmerEvents {
  onVoidComplete(s: Swimmer, litres: number): void;
  onExposed(s: Swimmer): void;
  onResigned(s: Swimmer): void;
  onSplash(strength: number): void;
}

/** Owns the subjects: placement, dragging, state updates and data for the solvers. */
export class SwimmerManager {
  readonly group = new THREE.Group();
  readonly ring: THREE.Mesh;
  readonly swimmers: Swimmer[] = [];
  totalReleased = 0;
  hovered: Swimmer | null = null;
  dragging: Swimmer | null = null;

  private leaving: Swimmer[] = [];
  private dims: TankDims = { width: 1, length: 1, depth: 2 };
  private raycaster = new THREE.Raycaster();
  private plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  private grabOffset = new THREE.Vector2();
  private tmp = new THREE.Vector3();
  private sphere = new THREE.Sphere();

  constructor(
    private ripples: Ripples,
    private events: SwimmerEvents,
  ) {
    this.ring = new THREE.Mesh(
      new THREE.RingGeometry(0.5, 0.56, 48),
      new THREE.MeshBasicMaterial({ color: 0x1b2a36, transparent: true, opacity: 0, depthWrite: false }),
    );
    this.ring.rotation.x = -Math.PI / 2;
    this.ring.position.y = 0.035;
    this.ring.renderOrder = 4;
  }

  get count() {
    return this.swimmers.length;
  }

  get anyVoiding() {
    return this.swimmers.some((s) => s.voiding);
  }

  configure(dims: TankDims) {
    this.dims = dims;
    for (const s of this.swimmers) {
      const [x, z] = this.clamp(s.targetX, s.targetZ);
      s.targetX = x;
      s.targetZ = z;
      s.pending = 0;
    }
    this.separate();
    this.totalReleased = 0;
  }

  /** Clean water: forget outstanding releases. */
  resetWater() {
    this.totalReleased = 0;
    for (const s of this.swimmers) {
      s.pending = 0;
      s.remaining = 0;
      s.exposure = 0;
      s.exposedFor = 0;
    }
  }

  private clamp(x: number, z: number): [number, number] {
    const hx = Math.max(0, this.dims.width / 2 - WALL_MARGIN);
    const hz = Math.max(0, this.dims.length / 2 - WALL_MARGIN);
    return [Math.max(-hx, Math.min(hx, x)), Math.max(-hz, Math.min(hz, z))];
  }

  /** Push overlapping subjects apart (small tanks, many subjects). */
  private separate(fixed?: Swimmer) {
    for (let iter = 0; iter < 4; iter++) {
      for (let i = 0; i < this.swimmers.length; i++) {
        for (let j = i + 1; j < this.swimmers.length; j++) {
          const a = this.swimmers[i];
          const b = this.swimmers[j];
          let dx = b.targetX - a.targetX;
          let dz = b.targetZ - a.targetZ;
          let d = Math.hypot(dx, dz);
          if (d >= MIN_SPACING) continue;
          if (d < 1e-4) {
            dx = Math.cos(i * 2.4 + j);
            dz = Math.sin(i * 2.4 + j);
            d = 1;
          }
          const push = (MIN_SPACING - d) / d;
          const wa = a === fixed ? 0 : b === fixed ? 1 : 0.5;
          const wb = 1 - wa;
          [a.targetX, a.targetZ] = this.clamp(a.targetX - dx * push * wa, a.targetZ - dz * push * wa);
          [b.targetX, b.targetZ] = this.clamp(b.targetX + dx * push * wb, b.targetZ + dz * push * wb);
        }
      }
    }
  }

  private nextId() {
    const used = new Set(this.swimmers.map((s) => s.id));
    let id = 1;
    while (used.has(id)) id++;
    return id;
  }

  /** Best-candidate placement: the free spot farthest from everyone else. */
  private findSpot(): [number, number] {
    const hx = Math.max(0, this.dims.width / 2 - WALL_MARGIN - 0.2);
    const hz = Math.max(0, this.dims.length / 2 - WALL_MARGIN - 0.2);
    // Keep new arrivals reasonably near the middle of very large tanks.
    const rx = Math.min(hx, 2.2 + this.swimmers.length * 0.5);
    const rz = Math.min(hz, 2.6 + this.swimmers.length * 0.6);
    let best: [number, number] = [0, 0];
    let bestScore = -1;
    for (let c = 0; c < 40; c++) {
      const x = (Math.random() * 2 - 1) * rx;
      const z = (Math.random() * 2 - 1) * rz;
      let score = 10;
      for (const s of this.swimmers) score = Math.min(score, Math.hypot(s.targetX - x, s.targetZ - z));
      if (score > bestScore) {
        bestScore = score;
        best = [x, z];
      }
    }
    return best;
  }

  add(instant = false) {
    if (this.swimmers.length >= LIMITS.subjects.max) return null;
    const s = new Swimmer(this.nextId());
    const [x, z] = this.findSpot();
    s.x = s.targetX = x;
    s.z = s.targetZ = z;
    // Face roughly toward the default camera side so faces are visible.
    s.facing = 0.7 + (Math.random() - 0.5) * 1.5;
    if (instant) {
      s.spawn = 1;
      s.landed = true;
    }
    this.swimmers.push(s);
    this.swimmers.sort((a, b) => a.id - b.id);
    this.group.add(s.group);
    this.separate(s);
    return s;
  }

  remove() {
    const s = this.swimmers.reduce<Swimmer | null>((m, c) => (!m || c.id > m.id ? c : m), null);
    if (!s) return null;
    this.swimmers.splice(this.swimmers.indexOf(s), 1);
    s.removing = true;
    s.remaining = 0;
    if (this.dragging === s) this.dragging = null;
    if (this.hovered === s) this.hovered = null;
    this.leaving.push(s);
    this.ripples.addDrop(s.x, s.z, 0.45, 0.03);
    this.events.onSplash(0.5);
    return s;
  }

  setCount(n: number) {
    n = Math.max(LIMITS.subjects.min, Math.min(LIMITS.subjects.max, n));
    while (this.swimmers.length < n) this.add();
    while (this.swimmers.length > n) this.remove();
  }

  voidAll() {
    for (const s of this.swimmers) s.startVoid();
  }

  // --- Picking and dragging -------------------------------------------------

  pick(ndc: THREE.Vector2, camera: THREE.Camera, touch: boolean) {
    this.raycaster.setFromCamera(ndc, camera);
    let best: Swimmer | null = null;
    let bestDist = Infinity;
    for (const s of this.swimmers) {
      this.sphere.center.set(s.x, 0.02, s.z);
      this.sphere.radius = touch ? 0.62 : 0.4;
      const hit = this.raycaster.ray.intersectSphere(this.sphere, this.tmp);
      if (!hit) continue;
      const d = hit.distanceTo(this.raycaster.ray.origin);
      if (d < bestDist) {
        bestDist = d;
        best = s;
      }
    }
    return best;
  }

  private planePoint(ndc: THREE.Vector2, camera: THREE.Camera) {
    this.raycaster.setFromCamera(ndc, camera);
    return this.raycaster.ray.intersectPlane(this.plane, this.tmp);
  }

  beginDrag(s: Swimmer, ndc: THREE.Vector2, camera: THREE.Camera) {
    this.dragging = s;
    s.grabbed = true;
    const p = this.planePoint(ndc, camera);
    if (p) this.grabOffset.set(s.x - p.x, s.z - p.z);
    else this.grabOffset.set(0, 0);
  }

  drag(ndc: THREE.Vector2, camera: THREE.Camera) {
    const s = this.dragging;
    if (!s) return;
    const p = this.planePoint(ndc, camera);
    if (!p) return;
    let [x, z] = this.clamp(p.x + this.grabOffset.x, p.z + this.grabOffset.y);
    // Slide around other subjects rather than passing through them.
    for (let iter = 0; iter < 3; iter++) {
      for (const o of this.swimmers) {
        if (o === s) continue;
        const dx = x - o.targetX;
        const dz = z - o.targetZ;
        const d = Math.hypot(dx, dz);
        if (d < MIN_SPACING && d > 1e-4) {
          x = o.targetX + (dx / d) * MIN_SPACING;
          z = o.targetZ + (dz / d) * MIN_SPACING;
        }
      }
      [x, z] = this.clamp(x, z);
    }
    s.targetX = x;
    s.targetZ = z;
  }

  endDrag() {
    if (this.dragging) this.dragging.grabbed = false;
    this.dragging = null;
  }

  // --- Per-frame ------------------------------------------------------------

  update(dt: number, time: number) {
    for (const s of this.swimmers) {
      const wasAirborne = s.spawn < 1;
      const ev = s.update(dt, time);
      this.totalReleased += ev.released;
      if (ev.voidComplete) this.events.onVoidComplete(s, s.voidedThisEvent);
      if (ev.becameExposed) this.events.onExposed(s);
      if (ev.becameResigned) this.events.onResigned(s);
      if (wasAirborne && s.spawn >= 1 && !s.landed) {
        s.markLanded();
        this.ripples.addDrop(s.x, s.z, 0.5, -0.05);
        this.events.onSplash(1);
      }

      // Surface disturbance from sculling hands, and a wake when dragged.
      if (s.spawn >= 1) {
        const fx = Math.sin(s.facing);
        const fz = Math.cos(s.facing);
        const rx = Math.cos(s.facing);
        const rz = -Math.sin(s.facing);
        const a = 0.0011 * s.vigor * Math.cos(s.phase);
        this.ripples.addDrop(s.x + rx * 0.42 + fx * 0.18, s.z + rz * 0.42 + fz * 0.18, 0.2, a);
        this.ripples.addDrop(s.x - rx * 0.42 + fx * 0.18, s.z - rz * 0.42 + fz * 0.18, 0.2, -a);
        const speed = Math.hypot(s.vx, s.vz);
        if (speed > 0.15) {
          this.ripples.addDrop(s.x + (s.vx / speed) * 0.2, s.z + (s.vz / speed) * 0.2, 0.3, Math.min(0.012, speed * 0.004));
        }
      }
    }
    for (let i = this.leaving.length - 1; i >= 0; i--) {
      const s = this.leaving[i];
      s.update(dt, time);
      if (s.spawn <= 0) {
        this.group.remove(s.group);
        s.dispose();
        this.leaving.splice(i, 1);
      }
    }

    // Selection ring
    const focus = this.dragging ?? this.hovered;
    const mat = this.ring.material as THREE.MeshBasicMaterial;
    const target = focus ? (this.dragging ? 0.75 : 0.4) : 0;
    mat.opacity += (target - mat.opacity) * Math.min(1, dt * 12);
    if (focus) this.ring.position.set(focus.x, 0.035, focus.z);
    this.ring.visible = mat.opacity > 0.01;
  }

  /** Pack subject state for the fluid solver. Consumes pending litres. */
  fillSolverState(out: Float32Array) {
    this.swimmers.forEach((s, i) => {
      const o = i * SUBJECT_STRIDE;
      out[o] = s.x;
      out[o + 1] = s.z;
      out[o + 2] = s.facing;
      out[o + 3] = s.phase;
      out[o + 4] = s.spawn >= 1 ? s.vigor : 0;
      out[o + 5] = s.vx;
      out[o + 6] = s.vz;
      out[o + 7] = s.pending;
      s.pending = 0;
    });
  }

  applyExposure(exposure: Float32Array) {
    // Exposure values are in solver order, which matches the id-sorted list at dispatch.
    const n = Math.min(exposure.length, this.swimmers.length);
    for (let i = 0; i < n; i++) this.swimmers[i].exposure = exposure[i];
  }
}
