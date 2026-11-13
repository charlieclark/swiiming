import * as THREE from 'three';
import { EXPOSURE_OFF, EXPOSURE_ON, RESIGNATION_SECONDS } from '../config';
import { CAPSULE_LENGTH, Shape, type SwimmerBatch } from './batch';
import { BASE_HEIGHT_M, makeLook, type Look } from './look';

export type Mood = 'calm' | 'exposed' | 'resigned';

interface Part {
  node: THREE.Object3D;
  shape: Shape;
  color: THREE.Color;
}

interface Limb {
  joint: THREE.Group;
  end: THREE.Group;
}

// Pose vector layout.
const PITCH = 0, RISE = 1, ROLL = 2, HEAD_PITCH = 3, HEAD_YAW = 4, SHIFT = 5;
const ARM = [6, 11]; // upper x, y, z, fore x, z
const LEG = [16, 21]; // thigh x, z, shin x, z, foot x
const POSE_SIZE = 26;

const HEAD_Y = 0.12;
const HEAD_Z = 0.014;
const BROW_Y = 0.034;
const MOUTH_W = 0.024;
const MOUTH_H = 0.0042;

const FACE_DARK = new THREE.Color(0x1b1614);
const EYE_WHITE = new THREE.Color(0xf4f1ec);
const MOUTH = new THREE.Color(0x5a2a26);
const LENS = new THREE.Color(0x1a2633);

/** Smoothly approach a target, frame-rate independent. */
function approach(current: number, target: number, rate: number, dt: number) {
  return current + (target - current) * (1 - Math.exp(-rate * dt));
}

function smoothstep(a: number, b: number, x: number) {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

const scratch = new Float32Array(POSE_SIZE);
const tmpV = new THREE.Vector3();

export class Swimmer {
  readonly look: Look;
  readonly root = new THREE.Group();

  x = 0;
  z = 0;
  /** Where the user is dragging this swimmer to. */
  targetX = 0;
  targetZ = 0;
  /** Where the swimmer is swimming to on their own (e.g. spreading out), if anywhere. */
  goalX: number | null = null;
  goalZ = 0;
  /** Measured velocity, after collisions. */
  vx = 0;
  vz = 0;
  facing = 0;
  phase = Math.random() * Math.PI * 2;
  vigor = 1;
  grabbed = false;
  removing = false;
  /** 0 while dropping in, 1 once settled. */
  spawn = 0;
  landed = false;

  // Peeing
  peeing = false;
  /** Current flow, litres per second. */
  flowNow = 0;
  /** Lifetime total, litres. */
  released = 0;
  /** Litres released but not yet handed to the solver. */
  pending = 0;

  // Exposure
  mood: Mood = 'calm';
  /** Local concentration, L/m^3. */
  exposure = 0;
  escapeX = 0;
  escapeZ = 0;
  exposedFor = 0;
  /** Accumulated time in bad water, decaying slowly in clean water. */
  stress = 0;
  private givenUp = false;
  private clearFor = 0;

  /** Free radius around the swimmer (m), set by the manager each frame. */
  space = 1;
  /** How active the swimmer is at the surface right now (drives ripples). */
  splash = 0;

  private body = new THREE.Group();
  private headPivot = new THREE.Group();
  private head = new THREE.Group();
  private parts: Part[] = [];
  private arms: { upper: Limb; fore: Limb }[] = [];
  private legs: { thigh: Limb; shin: Limb; foot: THREE.Object3D }[] = [];
  private whites: THREE.Object3D[] = [];
  private pupils: THREE.Object3D[] = [];
  private brows: THREE.Object3D[] = [];
  private mouth: THREE.Object3D;
  private skull: THREE.Object3D;
  private pelvis: THREE.Object3D;
  private seed = Math.random() * 100;
  private pose = new Float32Array(POSE_SIZE);

  // Autonomous swimming velocity.
  private ax = 0;
  private az = 0;
  private fleeX = 0;
  private fleeZ = 0;
  private prevX = 0;
  private prevZ = 0;

  // Blend weights.
  private wSwim = 0;
  private wPanic = 0;
  private wFloat = 0;
  private wSlump = 0;
  private panicFace = 0;
  private relief = 0;
  private lift = 0;
  private reach = 0.8;
  private lookYaw = 0;
  private landT = 10;

  constructor(readonly id: number) {
    const look = (this.look = makeLook(id));
    const skin = new THREE.Color(look.skin);
    const suit = new THREE.Color(look.suitColor);
    const suit2 = new THREE.Color(look.suitColor2);
    const hair = new THREE.Color(look.hair);
    const cap = new THREE.Color(look.capColor);

    const part = (
      parent: THREE.Object3D,
      shape: Shape,
      color: THREE.Color,
      px: number, py: number, pz: number,
      sx: number, sy: number, sz: number,
    ) => {
      const node = new THREE.Object3D();
      node.position.set(px, py, pz);
      node.scale.set(sx, sy, sz);
      parent.add(node);
      this.parts.push({ node, shape, color });
      return node;
    };
    const limb = (radius: number, length: number, color: THREE.Color): Limb => {
      const joint = new THREE.Group();
      part(joint, Shape.Capsule, color, 0, -length / 2, 0, radius, length / CAPSULE_LENGTH, radius);
      const end = new THREE.Group();
      end.position.y = -length;
      joint.add(end);
      return { joint, end };
    };
    const sleeve = (parent: THREE.Object3D, radius: number, length: number, color: THREE.Color) =>
      part(parent, Shape.Capsule, color, 0, -length / 2 - 0.01, 0, radius, length / CAPSULE_LENGTH, radius);

    const b = look.build;
    const heavy = Math.max(0, b);
    const bw = 1 + 0.13 * b;
    const bd = 1 + 0.24 * Math.max(b, -0.6);
    const lr = 1 + 0.15 * b;
    const sh = look.shoulders;
    const covered = look.suit === 'onepiece' || look.suit === 'rashguard';
    const torso = look.suit === 'onepiece' ? suit : look.suit === 'rashguard' ? suit2 : skin;

    // Torso: broad chest tapering to the waist.
    part(this.body, Shape.Sphere, torso, 0, -0.2, 0, (covered ? 0.19 : 0.2) * bw * sh, 0.17, 0.115 * bd);
    part(this.body, Shape.Sphere, torso, 0, -0.42, 0.012 * heavy, 0.148 * bw, 0.2, 0.104 * bd * (1 + 0.32 * heavy));
    this.pelvis = part(this.body, Shape.Sphere, suit, 0, -0.6, 0, 0.166 * bw, 0.122, 0.118 * bd);
    part(this.body, Shape.Capsule, skin, 0, 0, 0, 0.052 * lr, 0.1 / CAPSULE_LENGTH, 0.052 * lr);
    if (look.suit === 'twopiece') {
      part(this.body, Shape.Sphere, suit, 0, -0.225, 0.004, 0.203 * bw * sh, 0.07, 0.121 * bd);
    }

    // Head
    this.headPivot.position.set(0, 0.03, 0);
    this.body.add(this.headPivot);
    this.head.scale.set(look.headWidth, look.headHeight, look.headWidth);
    this.headPivot.add(this.head);
    const cy = HEAD_Y;
    const cz = HEAD_Z;
    this.skull = part(this.head, Shape.Sphere, skin, 0, cy, cz, 0.105, 0.125, 0.113);
    if (look.headwear !== 'bald') {
      const isCap = look.headwear === 'cap';
      const dome = part(
        this.head, Shape.Dome, isCap ? cap : hair,
        0, cy + 0.003, cz - 0.004,
        isCap ? 0.115 : 0.118, isCap ? 0.136 : 0.14, isCap ? 0.1235 : 0.127,
      );
      dome.rotation.x = isCap ? -0.6 : -0.5;
      if (look.headwear === 'bun') part(this.head, Shape.Bead, hair, 0, cy + 0.1, cz - 0.085, 0.048, 0.045, 0.048);
      if (look.headwear === 'long') part(this.head, Shape.Sphere, hair, 0, cy - 0.045, cz - 0.075, 0.1, 0.14, 0.062);
    }
    if (look.goggles) {
      for (let side = -1; side <= 1; side += 2) {
        const lens = part(this.head, Shape.Bead, LENS, 0.036 * side, cy + 0.082, cz + 0.089, 0.024, 0.017, 0.012);
        lens.rotation.x = -0.75;
      }
    }
    for (let side = -1; side <= 1; side += 2) {
      this.whites.push(part(this.head, Shape.Bead, EYE_WHITE, 0.038 * side, cy + 0.004, cz + 0.097, 0.02, 0.016, 0.008));
      this.pupils.push(part(this.head, Shape.Bead, FACE_DARK, 0.038 * side, cy + 0.004, cz + 0.103, 0.0105, 0.0105, 0.005));
      this.brows.push(
        part(this.head, Shape.Box, look.headwear === 'cap' || look.headwear === 'bald' ? FACE_DARK : hair,
          0.039 * side, cy + BROW_Y, cz + 0.1, 0.036, 0.007, 0.012),
      );
      part(this.head, Shape.Bead, skin, 0.104 * side, cy - 0.012, cz - 0.006, 0.01, 0.026, 0.017);
      // Shoulder caps
      part(this.body, Shape.Bead, look.suit === 'rashguard' ? suit2 : skin, 0.212 * bw * sh * side, -0.125, 0, 0.06 * lr, 0.06 * lr, 0.06 * lr);
    }
    part(this.head, Shape.Bead, skin, 0, cy - 0.024, cz + 0.111, 0.014, 0.022, 0.017);
    this.mouth = part(this.head, Shape.Bead, MOUTH, 0, cy - 0.064, cz + 0.091, MOUTH_W, MOUTH_H, 0.012);
    if (look.facial === 'moustache') part(this.head, Shape.Box, hair, 0, cy - 0.046, cz + 0.103, 0.05, 0.011, 0.012);
    if (look.facial === 'beard') part(this.head, Shape.Sphere, hair, 0, cy - 0.094, cz + 0.045, 0.078, 0.046, 0.06);

    // Arms
    for (let side = -1; side <= 1; side += 2) {
      const upper = limb(0.046 * lr, 0.27, skin);
      upper.joint.position.set(0.215 * bw * sh * side, -0.13, 0);
      if (look.suit === 'rashguard') sleeve(upper.joint, 0.05 * lr, 0.15, suit2);
      const fore = limb(0.037 * lr, 0.25, skin);
      upper.end.add(fore.joint);
      part(fore.end, Shape.Bead, skin, 0, -0.05, 0, 0.04, 0.058, 0.02);
      this.body.add(upper.joint);
      this.arms.push({ upper, fore });
    }

    // Legs
    for (let side = -1; side <= 1; side += 2) {
      const thigh = limb(0.072 * lr, 0.4, skin);
      thigh.joint.position.set(0.092 * bw * side, -0.64, 0);
      if (look.suit === 'trunks') sleeve(thigh.joint, 0.08 * lr, 0.15, suit);
      if (look.suit === 'jammers') sleeve(thigh.joint, 0.077 * lr, 0.3, suit);
      const shin = limb(0.05 * lr, 0.4, skin);
      thigh.end.add(shin.joint);
      const foot = part(shin.end, Shape.Bead, skin, 0, -0.035, 0.07, 0.043, 0.03, 0.11);
      this.body.add(thigh.joint);
      this.legs.push({ thigh, shin, foot });
    }

    this.root.add(this.body);
    this.root.matrixWorldAutoUpdate = false;
  }

  get name() {
    return `Swimmer ${this.id}`;
  }

  get heightM() {
    return BASE_HEIGHT_M * this.look.height;
  }

  /** Short description of what the swimmer is doing. */
  get status() {
    const base =
      this.mood === 'resigned'
        ? 'Given up'
        : this.mood === 'exposed'
          ? this.wSwim > 0.5
            ? 'Fleeing'
            : 'Panicking'
          : this.goalX !== null
            ? 'Swimming'
            : 'Treading water';
    return this.peeing ? `${base}, peeing` : base;
  }

  /** Advance state and position. Returns litres released this frame. */
  update(dt: number, time: number) {
    if (this.removing) this.spawn = Math.max(0, this.spawn - dt * 3.5);
    else if (this.spawn < 1) this.spawn = Math.min(1, this.spawn + dt * 2.2);

    // Exposure, with hysteresis so the mood does not flicker.
    // A swimmer who is peeing is in no position to object: they ignore the water around
    // them until they have finished.
    const oblivious = this.peeing || this.flowNow > 0.002;
    const exposedNow =
      !oblivious && (this.exposure > EXPOSURE_ON || (this.exposedFor > 0 && this.exposure > EXPOSURE_OFF));
    if (exposedNow) {
      this.exposedFor += dt;
      this.clearFor = 0;
      // Stress builds while in bad water and fades only slowly, so a swimmer who keeps
      // getting caught eventually stops trying.
      this.stress = Math.min(RESIGNATION_SECONDS + 4, this.stress + dt);
    } else {
      this.clearFor += dt;
      if (this.clearFor > 0.7 || oblivious) this.exposedFor = 0;
      this.stress = Math.max(0, this.stress - dt * 0.3);
    }
    if (oblivious) this.givenUp = false;
    else if (this.stress >= RESIGNATION_SECONDS) this.givenUp = true;
    else if (this.stress < RESIGNATION_SECONDS * 0.6) this.givenUp = false;
    this.mood = this.givenUp ? 'resigned' : this.exposedFor > 0 ? 'exposed' : 'calm';

    // Decide where to go.
    this.prevX = this.x;
    this.prevZ = this.z;
    let wantX = 0;
    let wantZ = 0;
    if (this.grabbed) {
      this.goalX = null;
      this.x = approach(this.x, this.targetX, 14, dt);
      this.z = approach(this.z, this.targetZ, 14, dt);
      this.ax = this.az = 0;
    } else {
      if (this.goalX !== null) {
        const dx = this.goalX - this.x;
        const dz = this.goalZ - this.z;
        const dist = Math.hypot(dx, dz);
        if (dist < 0.08) {
          this.goalX = null;
        } else {
          const speed = Math.min(1.05, 0.12 + dist * 1.4);
          wantX = (dx / dist) * speed;
          wantZ = (dz / dist) * speed;
        }
      } else if (this.mood === 'exposed') {
        // Head for cleaner water, if the solver found any nearby.
        this.fleeX = approach(this.fleeX, this.escapeX, 3, dt);
        this.fleeZ = approach(this.fleeZ, this.escapeZ, 3, dt);
        const len = Math.hypot(this.fleeX, this.fleeZ);
        if (len > 0.3) {
          wantX = (this.fleeX / len) * 0.62;
          wantZ = (this.fleeZ / len) * 0.62;
        }
      } else {
        this.fleeX = this.fleeZ = 0;
      }
      this.ax = approach(this.ax, wantX, 2.6, dt);
      this.az = approach(this.az, wantZ, 2.6, dt);
      this.x += this.ax * dt;
      this.z += this.az * dt;
    }

    // Peeing
    this.flowNow = approach(this.flowNow, this.peeing && !this.removing ? this.look.flow : 0, 1.6, dt);
    if (this.flowNow < 1e-5) this.flowNow = 0;
    const q = this.flowNow * dt;
    this.released += q;
    this.pending += q;

    // Blend weights
    const autoSpeed = Math.hypot(this.ax, this.az);
    const swimming = this.grabbed ? 0 : smoothstep(0.1, 0.32, autoSpeed);
    const resigned = this.mood === 'resigned';
    const exposed = this.mood === 'exposed';
    const room = smoothstep(0.62, 0.8, this.space / this.look.height);
    this.wSwim = approach(this.wSwim, resigned ? 0 : swimming, 4, dt);
    this.wPanic = approach(this.wPanic, exposed ? 1 - swimming : 0, 4, dt);
    this.wFloat = approach(this.wFloat, resigned ? room : 0, 1.3, dt);
    this.wSlump = approach(this.wSlump, resigned ? 1 - room : 0, 1.6, dt);
    this.panicFace = approach(this.panicFace, exposed ? 1 : 0, 6, dt);
    this.relief = approach(this.relief, this.peeing && this.mood === 'calm' ? 1 : 0, 3, dt);
    this.lift = approach(this.lift, this.grabbed ? 1 : 0, 8, dt);
    this.reach = approach(this.reach, Math.max(0.42, Math.min(0.8, this.space / this.look.height)), 5, dt);

    const still = 1 - 0.85 * this.wFloat - 0.6 * this.wSlump;
    const hz =
      (1.05 * (1 - 0.4 * this.relief) * (1 + 0.95 * this.wPanic + (0.2 + 0.5 * this.panicFace) * this.wSwim) + 0.5 * this.lift) * still;
    this.phase += dt * Math.PI * 2 * hz;
    this.vigor =
      this.spawn < 1 ? 0 : (1 - 0.4 * this.relief + 0.8 * this.wPanic) * (1 - 0.9 * this.wFloat - 0.7 * this.wSlump) * (1 - 0.6 * this.wSwim);
    this.splash = this.wPanic * 1.0 + this.wSwim * (0.45 + 0.4 * this.panicFace);

    // Face the way we are going; floaters turn slowly with the water.
    if (!this.grabbed && autoSpeed > 0.12) this.turnToward(Math.atan2(this.ax, this.az), 5, dt);
    else if (this.grabbed && Math.hypot(this.vx, this.vz) > 0.35) this.turnToward(Math.atan2(this.vx, this.vz), 4, dt);
    this.facing += dt * 0.07 * this.wFloat * (this.seed > 50 ? 1 : -1);
    void time;
    return q;
  }

  private turnToward(want: number, rate: number, dt: number) {
    let delta = want - this.facing;
    delta = Math.atan2(Math.sin(delta), Math.cos(delta));
    this.facing += delta * (1 - Math.exp(-rate * dt));
  }

  /** Call after collisions have been resolved for this frame. */
  measureVelocity(dt: number) {
    if (dt <= 0) return;
    this.vx = approach(this.vx, (this.x - this.prevX) / dt, 12, dt);
    this.vz = approach(this.vz, (this.z - this.prevZ) / dt, 12, dt);
  }

  private fillTread(p: Float32Array, time: number, k: number) {
    const ph = this.phase;
    const t = time + this.seed;
    p[PITCH] = 0.07;
    p[RISE] = 0.012 * Math.sin(ph * 2) * (1 - 0.5 * this.relief);
    p[ROLL] = 0.028 * Math.sin(ph);
    p[HEAD_PITCH] = -0.07 - 0.2 * this.relief;
    // Idle glances; while peeing, a studied look at nothing in particular.
    const idle = 0.3 * Math.sin(t * 0.37) + 0.16 * Math.sin(t * 0.83 + 1.7);
    const away = 0.55 * (this.seed > 50 ? 1 : -1) + 0.08 * Math.sin(t * 0.5);
    p[HEAD_YAW] = idle * (1 - this.relief) + away * this.relief;
    p[SHIFT] = 0;
    const raise = 0.42 + (1.3 - 0.42) * k - 0.1 * this.lift;
    const bend = 1.4 + (0.85 - 1.4) * k;
    const splay = 0.2 + 0.32 * k;
    const circle = 0.2 + 0.26 * k;
    for (let i = 0; i < 2; i++) {
      const side = i === 0 ? -1 : 1;
      const a = ARM[i];
      const sweep = (0.3 + 0.36 * Math.sin(ph) * (1 - 0.3 * this.relief)) * (0.45 + 0.55 * k);
      p[a] = 0.06;
      p[a + 1] = -side * sweep;
      p[a + 2] = side * raise;
      p[a + 3] = -(bend + 0.32 * Math.sin(ph - 0.9));
      p[a + 4] = side * 0.14 * Math.cos(ph);
      const l = LEG[i];
      const lp = ph + (side > 0 ? 0 : Math.PI);
      const amp = 1 - 0.35 * this.relief;
      p[l] = -(0.72 + 0.12 * Math.sin(lp) * amp);
      p[l + 1] = side * (splay + 0.08 * Math.cos(lp) * amp);
      p[l + 2] = 1.22 + 0.42 * Math.sin(lp) * amp;
      p[l + 3] = side * circle * Math.cos(lp) * amp;
      p[l + 4] = 0.35 * Math.sin(lp + 0.6);
    }
  }

  /** Head-up front crawl, used both for calm travel and for fleeing. */
  private fillSwim(p: Float32Array) {
    const ph = this.phase;
    p[PITCH] = 1.1;
    p[RISE] = -0.03;
    p[ROLL] = 0.2 * Math.sin(ph);
    p[HEAD_PITCH] = -0.95;
    p[HEAD_YAW] = 0.12 * Math.sin(ph);
    p[SHIFT] = 0;
    for (let i = 0; i < 2; i++) {
      const side = i === 0 ? -1 : 1;
      const cycle = ph + (side > 0 ? 0 : Math.PI);
      const wrapped = Math.atan2(Math.sin(cycle), Math.cos(cycle));
      const a = ARM[i];
      p[a] = wrapped + Math.PI;
      p[a + 1] = 0;
      p[a + 2] = side * 0.16;
      p[a + 3] = -(0.3 + 0.28 * Math.sin(cycle));
      p[a + 4] = 0;
      const l = LEG[i];
      const kick = ph * 2 + (side > 0 ? 0 : Math.PI);
      p[l] = 0.32 * Math.sin(kick) - 0.05;
      p[l + 1] = side * 0.07;
      p[l + 2] = 0.34 + 0.3 * Math.sin(kick - 0.8);
      p[l + 3] = 0;
      p[l + 4] = 0.6;
    }
  }

  /** Thrashing on the spot with arms in the air. */
  private fillPanic(p: Float32Array, time: number) {
    const ph = this.phase;
    const t = time + this.seed;
    p[PITCH] = -0.04;
    p[RISE] = 0.12 + 0.05 * Math.sin(ph * 2);
    p[ROLL] = 0.12 * Math.sin(ph * 1.3);
    p[HEAD_PITCH] = -0.3;
    p[HEAD_YAW] = 0.6 * Math.sin(t * 7.3);
    p[SHIFT] = 0;
    for (let i = 0; i < 2; i++) {
      const side = i === 0 ? -1 : 1;
      const a = ARM[i];
      p[a] = 0.35 * Math.sin(ph * 1.7 + side);
      p[a + 1] = -side * 0.25;
      p[a + 2] = side * (2.45 + 0.5 * Math.sin(ph * 2 + side * 1.3));
      p[a + 3] = -(0.45 + 0.4 * Math.sin(ph * 2.3 + side));
      p[a + 4] = 0;
      const l = LEG[i];
      const lp = ph + (side > 0 ? 0 : Math.PI);
      p[l] = -(0.6 + 0.3 * Math.sin(lp));
      p[l + 1] = side * (0.3 + 0.1 * Math.cos(lp));
      p[l + 2] = 1.1 + 0.6 * Math.sin(lp);
      p[l + 3] = side * 0.3 * Math.cos(lp);
      p[l + 4] = 0.4 * Math.sin(lp);
    }
  }

  /** Flat on the back, arms out, looking at the ceiling. */
  private fillFloat(p: Float32Array) {
    const ph = this.phase;
    p[PITCH] = -1.5;
    p[RISE] = -0.055 + 0.012 * Math.sin(ph * 2);
    p[ROLL] = 0.03 * Math.sin(ph);
    p[HEAD_PITCH] = 0.1;
    p[HEAD_YAW] = 0;
    p[SHIFT] = -0.62;
    for (let i = 0; i < 2; i++) {
      const side = i === 0 ? -1 : 1;
      const a = ARM[i];
      p[a] = 0;
      p[a + 1] = 0;
      p[a + 2] = side * (1.5 + 0.03 * Math.sin(ph + side));
      p[a + 3] = -0.15;
      p[a + 4] = 0;
      const l = LEG[i];
      p[l] = -0.06;
      p[l + 1] = side * 0.2;
      p[l + 2] = 0.12;
      p[l + 3] = 0;
      p[l + 4] = 0.2;
    }
  }

  /** No room to float: hang in the water, head bowed, arms limp. */
  private fillSlump(p: Float32Array) {
    const ph = this.phase;
    p[PITCH] = 0.14;
    p[RISE] = -0.05 + 0.008 * Math.sin(ph * 2);
    p[ROLL] = 0.02 * Math.sin(ph);
    p[HEAD_PITCH] = 0.42;
    p[HEAD_YAW] = 0;
    p[SHIFT] = 0;
    for (let i = 0; i < 2; i++) {
      const side = i === 0 ? -1 : 1;
      const a = ARM[i];
      p[a] = 0.12;
      p[a + 1] = 0;
      p[a + 2] = side * 0.16;
      p[a + 3] = -0.28;
      p[a + 4] = 0;
      const l = LEG[i];
      const lp = ph + (side > 0 ? 0 : Math.PI);
      p[l] = -(0.22 + 0.06 * Math.sin(lp));
      p[l + 1] = side * 0.12;
      p[l + 2] = 0.5 + 0.12 * Math.sin(lp);
      p[l + 3] = 0;
      p[l + 4] = 0.5;
    }
  }

  private blend(weight: number) {
    if (weight <= 0.001) return;
    const p = this.pose;
    for (let i = 0; i < POSE_SIZE; i++) p[i] += (scratch[i] - p[i]) * weight;
  }

  /** Write the current pose into the skeleton and update world matrices. */
  applyPose(dt: number, time: number) {
    const p = this.pose;
    const k = (this.reach - 0.42) / (0.8 - 0.42);
    this.fillTread(p, time, k);
    // Sequential blends: later poses take over from earlier ones as their weight rises.
    if (this.wSwim > 0.001) {
      this.fillSwim(scratch);
      this.blend(this.wSwim);
    }
    if (this.wPanic > 0.001) {
      this.fillPanic(scratch, time);
      this.blend(this.wPanic);
    }
    if (this.wSlump > 0.001) {
      this.fillSlump(scratch);
      this.blend(this.wSlump);
    }
    if (this.wFloat > 0.001) {
      this.fillFloat(scratch);
      this.blend(this.wFloat);
    }

    // Whole body
    const drop = (1 - this.spawn) * (1 - this.spawn);
    const sink = this.landed ? 0.05 * Math.exp(-this.landT * 4) * Math.cos(this.landT * 9) : 0;
    this.landT += dt;
    const lean = Math.min(0.25, Math.hypot(this.vx, this.vz) * 0.12) * this.lift;
    this.root.position.set(this.x, 0, this.z);
    this.root.rotation.y = this.facing;
    this.root.scale.setScalar(this.look.height * (this.removing ? 0.2 + 0.8 * this.spawn : 1));
    this.body.position.set(
      0,
      p[RISE] + 0.11 * this.lift + (this.removing ? (1 - this.spawn) * 1.2 : drop * 1.5) - sink,
      p[SHIFT],
    );
    this.body.rotation.set(p[PITCH] + lean, 0, p[ROLL]);
    this.lookYaw = approach(this.lookYaw, p[HEAD_YAW], this.wPanic > 0.5 ? 30 : 2.5, dt);
    this.headPivot.rotation.set(p[HEAD_PITCH] - lean, this.lookYaw, -p[ROLL]);

    for (let i = 0; i < 2; i++) {
      const arm = this.arms[i];
      const a = ARM[i];
      arm.upper.joint.rotation.set(p[a], p[a + 1], p[a + 2]);
      arm.fore.joint.rotation.set(p[a + 3], 0, p[a + 4]);
      const leg = this.legs[i];
      const l = LEG[i];
      leg.thigh.joint.rotation.set(p[l], 0, p[l + 1]);
      leg.shin.joint.rotation.set(p[l + 2], 0, p[l + 3]);
      leg.foot.rotation.x = p[l + 4];
    }

    // Face
    const t = time + this.seed;
    const panic = this.panicFace;
    const relief = this.relief;
    const flat = Math.min(1, this.wFloat + this.wSlump);
    const blink = panic < 0.5 && Math.sin(t * 0.9) > 0.995 ? 0.12 : 1;
    const open = Math.max(0.1, (1 - 0.55 * relief + 0.5 * panic - 0.42 * flat) * blink);
    const pupil = 0.0105 * (1 - 0.28 * panic);
    for (let i = 0; i < 2; i++) {
      const side = i === 0 ? -1 : 1;
      this.whites[i].scale.set(0.02 * (1 + 0.12 * panic), 0.016 * open, 0.008);
      this.pupils[i].scale.set(pupil, Math.min(pupil, 0.015 * open), 0.005);
      const brow = this.brows[i];
      brow.position.y = HEAD_Y + BROW_Y + 0.008 * relief + 0.015 * panic - 0.005 * flat;
      brow.rotation.z = -side * (0.5 * panic - 0.1 * relief + 0.1 * flat);
    }
    const scream = 0.78 + 0.22 * Math.sin(t * 11);
    this.mouth.scale.set(
      MOUTH_W * (1 - 0.5 * relief + 0.3 * panic),
      MOUTH_H * (1 + 2.0 * relief + 7.5 * panic * scream - 0.2 * flat),
      0.012,
    );
    this.mouth.position.y = HEAD_Y - 0.064 - 0.012 * panic;

    this.root.updateMatrix();
    this.root.matrixWorld.copy(this.root.matrix);
    for (const child of this.root.children) child.updateMatrixWorld(true);
  }

  /** Called once when the swimmer hits the water after dropping in. */
  markLanded() {
    this.landed = true;
    this.landT = 0;
  }

  emit(batch: SwimmerBatch) {
    for (const part of this.parts) batch.push(part.shape, part.node.matrixWorld, part.color);
  }

  /** World position of the centre of the head. */
  headPosition(out: THREE.Vector3) {
    return out.setFromMatrixPosition(this.skull.matrixWorld);
  }

  /** World matrix of the head (for the portrait camera). */
  get headMatrix() {
    return this.head.matrixWorld;
  }

  /** World position where urine enters the water. */
  releasePoint(out: THREE.Vector3) {
    return out.setFromMatrixPosition(this.pelvis.matrixWorld);
  }

  /** World position of a hand (0 = left, 1 = right). */
  handPosition(index: number, out: THREE.Vector3) {
    return out.setFromMatrixPosition(this.arms[index].fore.end.matrixWorld);
  }

  /** Approximate body axis for picking: from the head to the feet. */
  bodySegment(head: THREE.Vector3, feet: THREE.Vector3) {
    this.headPosition(head);
    this.releasePoint(tmpV);
    feet.copy(tmpV).sub(head).multiplyScalar(2.05).add(head);
  }
}
