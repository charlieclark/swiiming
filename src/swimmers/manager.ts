import * as THREE from 'three';
import { capacity, LIMITS, SPACING, WALL_MARGIN, type TankDims } from '../config';
import { SUBJECT_STRIDE } from '../sim/fluid';
import type { Ripples } from '../water/ripples';
import { SwimmerBatch } from './batch';
import { Swimmer } from './swimmer';

export interface SwimmerEvents {
  onSplash(strength: number): void;
}

/** Owns the swimmers: placement, crowding, dragging, state updates and data for the solvers. */
export class SwimmerManager {
  readonly batch = new SwimmerBatch(LIMITS.swimmers.max + 12);
  readonly ring: THREE.Mesh;
  readonly swimmers: Swimmer[] = [];
  /** Litres released into the current tank of water. */
  totalReleased = 0;
  hovered: Swimmer | null = null;
  dragging: Swimmer | null = null;
  selected: Swimmer | null = null;
  capacity = 1;
  /** Distance from the camera to the swimmer found by the last successful pick(). */
  pickDistance = Infinity;

  private leaving: Swimmer[] = [];
  private dims: TankDims = { width: 1, length: 1, depth: 2 };
  private raycaster = new THREE.Raycaster();
  private plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  private grabOffset = new THREE.Vector2();
  private tmp = new THREE.Vector3();
  private tmp2 = new THREE.Vector3();
  private tmp3 = new THREE.Vector3();
  private segment = new THREE.Line3();
  /** Ids in the order last sent to the solver, to match results back up. */
  private sentIds: number[] = [];

  constructor(
    private ripples: Ripples,
    private events: SwimmerEvents,
  ) {
    this.ring = new THREE.Mesh(
      new THREE.RingGeometry(0.56, 0.62, 56),
      new THREE.MeshBasicMaterial({ color: 0x1b2a36, transparent: true, opacity: 0, depthWrite: false }),
    );
    this.ring.rotation.x = -Math.PI / 2;
    this.ring.position.y = 0.035;
    this.ring.renderOrder = 4;
  }

  get count() {
    return this.swimmers.length;
  }

  get peeingCount() {
    let n = 0;
    for (const s of this.swimmers) if (s.peeing) n++;
    return n;
  }

  /**
   * New tank size. The urine already released stays in the water. Returns how many
   * swimmers no longer fit and were removed.
   */
  configure(dims: TankDims) {
    this.dims = dims;
    this.capacity = capacity(dims);
    let removed = 0;
    while (this.swimmers.length > this.capacity) {
      this.remove();
      removed++;
    }
    for (const s of this.swimmers) {
      [s.x, s.z] = this.clamp(s.x, s.z);
      [s.targetX, s.targetZ] = this.clamp(s.targetX, s.targetZ);
      s.depth = dims.depth;
    }
    return removed;
  }

  /** Clean water: forget what is in the tank, but not who is peeing. */
  resetWater() {
    this.totalReleased = 0;
    for (const s of this.swimmers) {
      s.pending = 0;
      s.exposure = 0;
      s.exposedFor = 0;
    }
  }

  private clamp(x: number, z: number): [number, number] {
    const hx = Math.max(0, this.dims.width / 2 - WALL_MARGIN);
    const hz = Math.max(0, this.dims.length / 2 - WALL_MARGIN);
    return [Math.max(-hx, Math.min(hx, x)), Math.max(-hz, Math.min(hz, z))];
  }

  private nextId() {
    const used = new Set(this.swimmers.map((s) => s.id));
    for (const s of this.leaving) used.add(s.id);
    let id = 1;
    while (used.has(id)) id++;
    return id;
  }

  /** Best-candidate placement: the free spot farthest from everyone else. */
  private findSpot(): [number, number] {
    const hx = Math.max(0, this.dims.width / 2 - WALL_MARGIN - 0.1);
    const hz = Math.max(0, this.dims.length / 2 - WALL_MARGIN - 0.1);
    // Keep new arrivals reasonably near the middle of very large tanks.
    const rx = Math.min(hx, 2.2 + this.swimmers.length * 0.35);
    const rz = Math.min(hz, 2.6 + this.swimmers.length * 0.45);
    let best: [number, number] = [0, 0];
    let bestScore = -1;
    for (let c = 0; c < 30; c++) {
      const x = (Math.random() * 2 - 1) * rx;
      const z = (Math.random() * 2 - 1) * rz;
      let score = 10;
      for (const s of this.swimmers) score = Math.min(score, Math.hypot(s.x - x, s.z - z));
      if (score > bestScore) {
        bestScore = score;
        best = [x, z];
      }
    }
    return best;
  }

  add(instant = false) {
    if (this.swimmers.length >= this.capacity) return null;
    const s = new Swimmer(this.nextId());
    s.depth = this.dims.depth;
    const [x, z] = this.findSpot();
    s.x = s.targetX = x;
    s.z = s.targetZ = z;
    // Face roughly toward the default camera side so faces are visible.
    s.facing = 0.7 + (Math.random() - 0.5) * 1.6;
    if (instant) {
      s.spawn = 1;
      s.landed = true;
    }
    this.swimmers.push(s);
    this.swimmers.sort((a, b) => a.id - b.id);
    return s;
  }

  remove() {
    const s = this.swimmers.reduce<Swimmer | null>((m, c) => (!m || c.id > m.id ? c : m), null);
    if (!s) return null;
    this.swimmers.splice(this.swimmers.indexOf(s), 1);
    s.removing = true;
    s.grabbed = false;
    if (this.dragging === s) this.dragging = null;
    if (this.hovered === s) this.hovered = null;
    if (this.selected === s) this.selected = null;
    this.leaving.push(s);
    this.ripples.addDrop(s.x, s.z, 0.45, 0.03);
    this.events.onSplash(0.5);
    return s;
  }

  setCount(n: number, peeing: boolean) {
    n = Math.max(LIMITS.swimmers.min, Math.min(this.capacity, Math.round(n)));
    while (this.swimmers.length < n) {
      const s = this.add();
      if (!s) break;
      s.peeing = peeing;
    }
    while (this.swimmers.length > n) this.remove();
  }

  /** Cut every release off at once (used when the pool is drained). */
  stopAll() {
    for (const s of this.swimmers) {
      s.peeing = false;
      s.flowNow = 0;
    }
  }

  setAllPeeing(on: boolean) {
    for (const s of this.swimmers) s.peeing = on;
  }

  /**
   * Move every swimmer to an evenly spaced position, instantly. Uses Lloyd relaxation
   * starting from where they are now, so each swimmer ends up near where they began.
   */
  spreadEvenly() {
    const n = this.swimmers.length;
    if (n === 0) return;
    const hx = Math.max(0.01, this.dims.width / 2 - WALL_MARGIN);
    const hz = Math.max(0.01, this.dims.length / 2 - WALL_MARGIN);
    const px = new Float32Array(n);
    const pz = new Float32Array(n);
    this.swimmers.forEach((s, i) => {
      // A little jitter separates swimmers that start on top of each other.
      px[i] = Math.max(-hx, Math.min(hx, s.x + (Math.random() - 0.5) * 0.05));
      pz[i] = Math.max(-hz, Math.min(hz, s.z + (Math.random() - 0.5) * 0.05));
    });
    const samples = Math.max(900, Math.min(3600, n * 36));
    const aspect = hx / hz;
    const gx = Math.max(6, Math.round(Math.sqrt(samples * aspect)));
    const gz = Math.max(6, Math.round(samples / gx));
    const sumX = new Float32Array(n);
    const sumZ = new Float32Array(n);
    const cnt = new Uint32Array(n);
    for (let iter = 0; iter < 50; iter++) {
      sumX.fill(0);
      sumZ.fill(0);
      cnt.fill(0);
      for (let j = 0; j < gz; j++) {
        const z = -hz + ((j + 0.5) / gz) * 2 * hz;
        for (let i = 0; i < gx; i++) {
          const x = -hx + ((i + 0.5) / gx) * 2 * hx;
          let best = 0;
          let bd = Infinity;
          for (let k = 0; k < n; k++) {
            const dx = px[k] - x;
            const dz = pz[k] - z;
            const d = dx * dx + dz * dz;
            if (d < bd) {
              bd = d;
              best = k;
            }
          }
          sumX[best] += x;
          sumZ[best] += z;
          cnt[best]++;
        }
      }
      for (let k = 0; k < n; k++) {
        if (cnt[k] > 0) {
          px[k] = sumX[k] / cnt[k];
          pz[k] = sumZ[k] / cnt[k];
        } else {
          // Starved of samples (hidden under a neighbour): restart somewhere random.
          px[k] = (Math.random() * 2 - 1) * hx;
          pz[k] = (Math.random() * 2 - 1) * hz;
        }
      }
    }
    // Swimmers do not swim: they simply appear at their new spots.
    this.swimmers.forEach((s, i) => {
      if (s.grabbed) return;
      s.x = s.targetX = px[i];
      s.z = s.targetZ = pz[i];
      this.ripples.addDrop(s.x, s.z, 0.4, -0.02);
    });
  }

  // --- Picking and dragging -------------------------------------------------

  /** Find the swimmer under the pointer, testing against the whole body. */
  pick(ndc: THREE.Vector2, camera: THREE.Camera, touch: boolean) {
    this.raycaster.setFromCamera(ndc, camera);
    const ray = this.raycaster.ray;
    let best: Swimmer | null = null;
    let bestDist = Infinity;
    for (const s of this.swimmers) {
      s.bodySegment(this.segment.start, this.segment.end);
      const radius = (touch ? 0.5 : 0.36) * s.look.height;
      const d2 = ray.distanceSqToSegment(this.segment.start, this.segment.end, this.tmp, this.tmp2);
      if (d2 > radius * radius) continue;
      const along = this.tmp.distanceTo(ray.origin);
      if (along < bestDist) {
        bestDist = along;
        best = s;
      }
    }
    this.pickDistance = bestDist;
    return best;
  }

  private planePoint(ndc: THREE.Vector2, camera: THREE.Camera) {
    this.raycaster.setFromCamera(ndc, camera);
    return this.raycaster.ray.intersectPlane(this.plane, this.tmp);
  }

  beginDrag(s: Swimmer, ndc: THREE.Vector2, camera: THREE.Camera) {
    this.dragging = s;
    s.grabbed = true;
    s.targetX = s.x;
    s.targetZ = s.z;
    const p = this.planePoint(ndc, camera);
    if (p) this.grabOffset.set(s.x - p.x, s.z - p.z);
    else this.grabOffset.set(0, 0);
  }

  drag(ndc: THREE.Vector2, camera: THREE.Camera) {
    const s = this.dragging;
    if (!s) return;
    const p = this.planePoint(ndc, camera);
    if (!p) return;
    [s.targetX, s.targetZ] = this.clamp(p.x + this.grabOffset.x, p.z + this.grabOffset.y);
  }

  endDrag() {
    if (this.dragging) this.dragging.grabbed = false;
    this.dragging = null;
  }

  // --- Per-frame ------------------------------------------------------------

  /** Keep swimmers apart and inside the walls, and measure how much room each has. */
  private resolveCrowding() {
    const list = this.swimmers;
    const n = list.length;
    for (let iter = 0; iter < 2; iter++) {
      for (let i = 0; i < n; i++) {
        const a = list[i];
        for (let j = i + 1; j < n; j++) {
          const b = list[j];
          let dx = b.x - a.x;
          let dz = b.z - a.z;
          if (dx > SPACING || dx < -SPACING || dz > SPACING || dz < -SPACING) continue;
          let d = Math.hypot(dx, dz);
          if (d >= SPACING) continue;
          if (d < 1e-4) {
            dx = Math.cos(i * 2.4 + j);
            dz = Math.sin(i * 2.4 + j);
            d = 1;
          }
          const push = ((SPACING - d) / d) * 0.5;
          // A swimmer in the user's hand does not get pushed; the other one gives way.
          const wa = a.grabbed ? 0 : b.grabbed ? 2 : 1;
          const wb = 2 - wa;
          a.x -= dx * push * wa;
          a.z -= dz * push * wa;
          b.x += dx * push * wb;
          b.z += dz * push * wb;
        }
      }
      for (const s of list) [s.x, s.z] = this.clamp(s.x, s.z);
    }
    const hw = this.dims.width / 2;
    const hl = this.dims.length / 2;
    for (let i = 0; i < n; i++) {
      const a = list[i];
      let nearest = 4;
      for (let j = 0; j < n; j++) {
        if (j === i) continue;
        const b = list[j];
        const dx = b.x - a.x;
        const dz = b.z - a.z;
        if (dx > 2 || dx < -2 || dz > 2 || dz < -2) continue;
        const d = Math.hypot(dx, dz);
        if (d < nearest) nearest = d;
      }
      const wall = Math.min(hw - Math.abs(a.x), hl - Math.abs(a.z));
      a.space = Math.min(nearest / 2, wall - 0.04);
    }
  }

  /** Distance from (x, z) to the nearest wall along a heading. */
  private roomAlong(x: number, z: number, heading: number) {
    const dx = Math.sin(heading);
    const dz = Math.cos(heading);
    const hw = this.dims.width / 2;
    const hl = this.dims.length / 2;
    const tx = dx > 1e-6 ? (hw - x) / dx : dx < -1e-6 ? (-hw - x) / dx : Infinity;
    const tz = dz > 1e-6 ? (hl - z) / dz : dz < -1e-6 ? (-hl - z) / dz : Infinity;
    return Math.min(tx, tz);
  }

  /**
   * Tell each swimmer how much room they have in front of them. Someone sitting in a
   * cramped tub turns to face the way with the most legroom.
   */
  private findLegroom(dt: number) {
    for (const s of this.swimmers) {
      s.ahead = this.roomAlong(s.x, s.z, s.facing);
      const sitting = this.dims.depth / s.look.height < 0.9;
      if (!sitting || s.grabbed || s.ahead >= 0.78 * s.look.height) continue;
      let best = s.facing;
      let bestRoom = s.ahead + 0.05;
      for (let i = 0; i < 8; i++) {
        const heading = (i / 8) * Math.PI * 2;
        const room = this.roomAlong(s.x, s.z, heading);
        if (room > bestRoom) {
          bestRoom = room;
          best = heading;
        }
      }
      const delta = Math.atan2(Math.sin(best - s.facing), Math.cos(best - s.facing));
      s.facing += delta * (1 - Math.exp(-3 * dt));
    }
  }

  update(dt: number, time: number, timeScale = 1) {
    for (const s of this.swimmers) {
      const wasAirborne = s.spawn < 1;
      this.totalReleased += s.update(dt, time, timeScale);
      if (wasAirborne && s.spawn >= 1 && !s.landed) {
        s.markLanded();
        this.ripples.addDrop(s.x, s.z, 0.5, -0.05);
        this.events.onSplash(1);
      }
    }
    this.resolveCrowding();
    this.findLegroom(dt);

    this.batch.begin();
    const hand = this.tmp3;
    const rate = Math.min(dt, 0.05) * 60;
    for (const s of this.swimmers) {
      s.measureVelocity(dt);
      s.applyPose(dt, time);
      s.emit(this.batch);
      if (s.spawn < 1) continue;

      // Ripples: sculling hands, the bobbing body, a wake when dragged, splashes when
      // thrashing. Amounts are per 1/60 s, scaled by `rate` so they do not depend on the
      // display's frame rate.
      const speed = Math.hypot(s.vx, s.vz);
      const calm = Math.max(0, 1 - s.splash);
      const pulse = Math.cos(s.phase);
      for (let i = 0; i < 2; i++) {
        s.handPosition(i, hand);
        if (hand.y < -0.45) continue;
        const side = i === 0 ? -1 : 1;
        const strength = 0.0016 * s.vigor * calm * pulse * side + s.splash * 0.011 * (Math.random() - 0.5);
        this.ripples.addDrop(hand.x, hand.z, 0.17, strength * rate, hand.y > -0.1 ? 0.035 * s.splash * rate : 0);
      }
      s.headPosition(hand);
      // A faint collar of foam where the neck meets the surface.
      this.ripples.addDrop(
        hand.x,
        hand.z,
        (0.25 + 0.06 * s.splash) * s.look.height,
        (0.0009 + 0.0014 * s.splash) * Math.sin(s.phase * 2) * (0.4 + s.vigor) * rate,
        (0.1 + 0.05 * s.splash) * rate,
      );
      if (speed > 0.12) {
        this.ripples.addDrop(
          hand.x + (s.vx / speed) * 0.22,
          hand.z + (s.vz / speed) * 0.22,
          0.3,
          Math.min(0.014, speed * 0.008) * rate,
        );
      }
    }
    for (let i = this.leaving.length - 1; i >= 0; i--) {
      const s = this.leaving[i];
      s.update(dt, time);
      s.applyPose(dt, time);
      if (s.spawn <= 0) this.leaving.splice(i, 1);
      else s.emit(this.batch);
    }
    this.batch.end();

    // Selection ring
    const focus = this.dragging ?? this.selected ?? this.hovered;
    const mat = this.ring.material as THREE.MeshBasicMaterial;
    const target = focus ? (this.dragging || this.selected === focus ? 0.8 : 0.4) : 0;
    mat.opacity += (target - mat.opacity) * Math.min(1, dt * 12);
    if (focus) {
      focus.headPosition(this.tmp);
      this.ring.position.set(this.tmp.x, 0.035, this.tmp.z);
    }
    this.ring.visible = mat.opacity > 0.01;
  }

  /** Roughly how many swimmers are thrashing, for sound. */
  get commotion() {
    let sum = 0;
    for (const s of this.swimmers) sum += s.splash;
    return sum;
  }

  /** Pack swimmer state for the fluid solver. Consumes pending litres. */
  fillSolverState(out: Float32Array) {
    this.sentIds.length = 0;
    this.swimmers.forEach((s, i) => {
      const o = i * SUBJECT_STRIDE;
      this.sentIds.push(s.id);
      s.releasePoint(this.tmp);
      out[o] = s.x;
      out[o + 1] = s.z;
      out[o + 2] = s.facing;
      out[o + 3] = s.phase;
      out[o + 4] = s.vigor;
      out[o + 5] = s.vx;
      out[o + 6] = s.vz;
      out[o + 7] = s.pending;
      out[o + 8] = this.tmp.x + Math.sin(s.facing) * 0.08;
      out[o + 9] = this.tmp.y - 0.1;
      out[o + 10] = this.tmp.z + Math.cos(s.facing) * 0.08;
      s.pending = 0;
    });
  }

  applySolverResults(exposure: Float32Array) {
    const byId = new Map<number, Swimmer>();
    for (const s of this.swimmers) byId.set(s.id, s);
    const n = Math.min(exposure.length, this.sentIds.length);
    for (let i = 0; i < n; i++) {
      const s = byId.get(this.sentIds[i]);
      if (!s) continue;
      s.exposure = exposure[i];
    }
  }
}
