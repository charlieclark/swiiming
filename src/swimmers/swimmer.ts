import * as THREE from 'three';
import { EXPOSURE_OFF, EXPOSURE_ON, RESIGNATION_SECONDS } from '../config';

export type SubjectState = 'nominal' | 'voiding' | 'exposed' | 'resigned';

const SKIN = [0xf1c9a5, 0xe3b48c, 0xc98f63, 0xa9714b, 0x7d4f33, 0x5b3a26];
const SUITS = [0x1c2f52, 0x15181d, 0x7a1f2b, 0x0f5a5e, 0x3b2a63, 0x2a4d2e];
const CAPS = [0xf2f2f0, 0x24477a, 0xb3262e, 0x1f1f22, 0x1d7f86, 0xe6e6ea];

const geo = {
  sphere: new THREE.SphereGeometry(1, 28, 20),
  cap: new THREE.SphereGeometry(1, 28, 14, 0, Math.PI * 2, 0, Math.PI * 0.54),
  box: new THREE.BoxGeometry(1, 1, 1),
  neck: new THREE.CylinderGeometry(0.05, 0.06, 0.13, 14),
  capsules: new Map<string, THREE.CapsuleGeometry>(),
};

function capsule(radius: number, length: number) {
  const key = `${radius}:${length}`;
  let g = geo.capsules.get(key);
  if (!g) {
    g = new THREE.CapsuleGeometry(radius, length, 6, 14);
    geo.capsules.set(key, g);
  }
  return g;
}

const HEAD_Y = 0.12;
const EYE = 0.0145;
const BROW_Y = 0.033;
const MOUTH_W = 0.024;
const MOUTH_H = 0.0042;

const faceDark = new THREE.MeshStandardMaterial({ color: 0x1b1614, roughness: 0.5 });
const mouthMat = new THREE.MeshStandardMaterial({ color: 0x5a2a26, roughness: 0.6 });

interface Limb {
  joint: THREE.Group;
  end: THREE.Group;
}

function makeLimb(radius: number, length: number, material: THREE.Material): Limb {
  const joint = new THREE.Group();
  const mesh = new THREE.Mesh(capsule(radius, length), material);
  mesh.position.y = -length / 2;
  mesh.castShadow = true;
  const end = new THREE.Group();
  end.position.y = -length;
  joint.add(mesh, end);
  return { joint, end };
}

/** Smoothly approach a target, frame-rate independent. */
function approach(current: number, target: number, rate: number, dt: number) {
  return current + (target - current) * (1 - Math.exp(-rate * dt));
}

export class Swimmer {
  readonly group = new THREE.Group();
  x = 0;
  z = 0;
  targetX = 0;
  targetZ = 0;
  vx = 0;
  vz = 0;
  facing = 0;
  phase = Math.random() * Math.PI * 2;
  vigor = 1;
  state: SubjectState = 'nominal';
  grabbed = false;
  removing = false;
  /** 0 while dropping in, 1 once settled. */
  spawn = 0;
  landed = false;

  // Voiding
  remaining = 0;
  flow = 0.035;
  voidElapsed = 0;
  voidedThisEvent = 0;
  /** Litres released but not yet handed to the solver. */
  pending = 0;

  // Exposure
  exposure = 0;
  exposedFor = 0;
  private exposureAnnounced = false;

  private body = new THREE.Group();
  private headPivot = new THREE.Group();
  private arms: { upper: Limb; fore: Limb; side: number }[] = [];
  private legs: { thigh: Limb; shin: Limb; foot: THREE.Mesh; side: number }[] = [];
  private eyes: THREE.Mesh[] = [];
  private brows: THREE.Mesh[] = [];
  private mouth: THREE.Mesh;
  private seed = Math.random() * 100;
  private materials: THREE.Material[] = [];

  // Blend weights for expressive poses.
  private calm = 0;
  private alarm = 0;
  private resign = 0;
  private lift = 0;
  private lookYaw = 0;

  constructor(readonly id: number) {
    const skin = new THREE.MeshStandardMaterial({ color: SKIN[(id * 5 + 2) % SKIN.length], roughness: 0.42 });
    const suit = new THREE.MeshStandardMaterial({ color: SUITS[(id * 3 + 1) % SUITS.length], roughness: 0.55 });
    const capMat = new THREE.MeshStandardMaterial({ color: CAPS[id % CAPS.length], roughness: 0.3 });
    this.materials.push(skin, suit, capMat);
    const onePiece = id % 2 === 0;

    const add = (mesh: THREE.Mesh, parent: THREE.Object3D) => {
      mesh.castShadow = true;
      parent.add(mesh);
      return mesh;
    };

    // Torso: broad chest tapering to the waist.
    const chest = add(new THREE.Mesh(geo.sphere, onePiece ? suit : skin), this.body);
    chest.position.set(0, -0.2, 0);
    chest.scale.set(onePiece ? 0.188 : 0.2, 0.17, 0.115);
    const abdomen = add(new THREE.Mesh(capsule(0.115, 0.16), onePiece ? suit : skin), this.body);
    abdomen.position.y = -0.4;
    abdomen.scale.set(onePiece ? 1.16 : 1.22, 1, 0.84);
    const pelvis = add(new THREE.Mesh(geo.sphere, suit), this.body);
    pelvis.position.y = -0.6;
    pelvis.scale.set(0.166, 0.122, 0.118);
    const neck = add(new THREE.Mesh(geo.neck, skin), this.body);
    neck.position.y = 0;

    // Head
    this.headPivot.position.set(0, 0.03, 0);
    this.body.add(this.headPivot);
    const cy = HEAD_Y;
    const cz = 0.014;
    const skull = add(new THREE.Mesh(geo.sphere, skin), this.headPivot);
    skull.position.set(0, cy, cz);
    skull.scale.set(0.105, 0.125, 0.113);
    const cap = add(new THREE.Mesh(geo.cap, capMat), this.headPivot);
    cap.position.set(0, cy + 0.003, cz - 0.004);
    cap.scale.set(0.111, 0.1315, 0.1195);
    cap.rotation.x = -0.6;
    for (let side = -1; side <= 1; side += 2) {
      const eye = add(new THREE.Mesh(geo.sphere, faceDark), this.headPivot);
      eye.position.set(0.038 * side, cy + 0.004, cz + 0.1);
      eye.scale.set(EYE, EYE, 0.008);
      this.eyes.push(eye);
      const brow = add(new THREE.Mesh(geo.box, faceDark), this.headPivot);
      brow.position.set(0.039 * side, cy + BROW_Y, cz + 0.099);
      brow.scale.set(0.036, 0.007, 0.012);
      this.brows.push(brow);
      const ear = add(new THREE.Mesh(geo.sphere, skin), this.headPivot);
      ear.position.set(0.104 * side, cy - 0.012, cz - 0.006);
      ear.scale.set(0.01, 0.026, 0.017);
      const deltoid = add(new THREE.Mesh(geo.sphere, skin), this.body);
      deltoid.position.set(0.212 * side, -0.125, 0);
      deltoid.scale.setScalar(0.06);
    }
    const nose = add(new THREE.Mesh(geo.sphere, skin), this.headPivot);
    nose.position.set(0, cy - 0.024, cz + 0.111);
    nose.scale.set(0.014, 0.022, 0.017);
    this.mouth = add(new THREE.Mesh(geo.sphere, mouthMat), this.headPivot);
    this.mouth.position.set(0, cy - 0.064, cz + 0.09);
    this.mouth.scale.set(MOUTH_W, MOUTH_H, 0.012);

    // Arms
    for (let side = -1; side <= 1; side += 2) {
      const upper = makeLimb(0.046, 0.27, skin);
      upper.joint.position.set(0.215 * side, -0.13, 0);
      const fore = makeLimb(0.037, 0.25, skin);
      upper.end.add(fore.joint);
      const hand = add(new THREE.Mesh(geo.sphere, skin), fore.end);
      hand.position.y = -0.05;
      hand.scale.set(0.04, 0.058, 0.02);
      this.body.add(upper.joint);
      this.arms.push({ upper, fore, side });
    }

    // Legs
    for (let side = -1; side <= 1; side += 2) {
      const thigh = makeLimb(0.072, 0.4, skin);
      thigh.joint.position.set(0.092 * side, -0.64, 0);
      if (!onePiece) {
        const trunk = add(new THREE.Mesh(capsule(0.079, 0.15), suit), thigh.joint);
        trunk.position.y = -0.085;
      }
      const shin = makeLimb(0.05, 0.4, skin);
      thigh.end.add(shin.joint);
      const foot = add(new THREE.Mesh(geo.sphere, skin), shin.end);
      foot.position.set(0, -0.035, 0.07);
      foot.scale.set(0.043, 0.03, 0.11);
      this.body.add(thigh.joint);
      this.legs.push({ thigh, shin, foot, side });
    }

    this.group.add(this.body);
  }

  get voiding() {
    return this.remaining > 0;
  }

  /** World position just above the cap, for labels. */
  labelAnchor(out: THREE.Vector3) {
    return out.set(this.x, this.body.position.y + 0.45, this.z);
  }

  startVoid() {
    if (this.voiding || this.removing) return;
    this.remaining = 0.3 + Math.random() * 0.2;
    this.flow = 0.028 + Math.random() * 0.016;
    this.voidElapsed = 0;
    this.voidedThisEvent = 0;
  }

  /**
   * Advance simulation state. Returns litres released this frame and flags for
   * state transitions the caller may want to log.
   */
  update(dt: number, time: number) {
    const events = { released: 0, voidComplete: false, becameExposed: false, becameResigned: false };

    // Spawn / removal animation
    if (this.removing) {
      this.spawn = Math.max(0, this.spawn - dt * 3.5);
    } else if (this.spawn < 1) {
      this.spawn = Math.min(1, this.spawn + dt * 2.2);
    }

    // Position follows drag target.
    const px = this.x;
    const pz = this.z;
    this.x = approach(this.x, this.targetX, 14, dt);
    this.z = approach(this.z, this.targetZ, 14, dt);
    if (dt > 0) {
      this.vx = approach(this.vx, (this.x - px) / dt, 12, dt);
      this.vz = approach(this.vz, (this.z - pz) / dt, 12, dt);
    }
    const speed = Math.hypot(this.vx, this.vz);
    if (this.grabbed && speed > 0.35) {
      const want = Math.atan2(this.vx, this.vz);
      let delta = want - this.facing;
      delta = Math.atan2(Math.sin(delta), Math.cos(delta));
      this.facing += delta * (1 - Math.exp(-4 * dt));
    }

    // Voiding
    if (this.remaining > 0) {
      this.voidElapsed += dt;
      const ramp = Math.min(1, this.voidElapsed / 0.8);
      const taper = Math.max(0.3, Math.min(1, this.remaining / 0.05));
      const q = Math.min(this.remaining, this.flow * ramp * taper * dt);
      this.remaining -= q;
      if (this.remaining < 1e-5) {
        this.remaining = 0;
        events.voidComplete = true;
      }
      this.pending += q;
      this.voidedThisEvent += q;
      events.released = q;
    }

    // Exposure state with hysteresis
    const wasExposed = this.exposedFor > 0;
    // The resignation clock only runs while the subject is free to react.
    if (this.exposure > EXPOSURE_ON || (wasExposed && this.exposure > EXPOSURE_OFF)) {
      const before = this.exposedFor;
      this.exposedFor = this.voiding ? Math.max(before, 1e-3) : before + dt;
      if (this.exposedFor >= RESIGNATION_SECONDS && before < RESIGNATION_SECONDS) {
        events.becameResigned = true;
      }
    } else {
      this.exposedFor = 0;
      this.exposureAnnounced = false;
    }

    this.state = this.voiding
      ? 'voiding'
      : this.exposedFor >= RESIGNATION_SECONDS
        ? 'resigned'
        : this.exposedFor > 0
          ? 'exposed'
          : 'nominal';

    if (this.state === 'exposed' && !this.exposureAnnounced && this.exposure > EXPOSURE_ON) {
      this.exposureAnnounced = true;
      events.becameExposed = true;
    }

    this.calm = approach(this.calm, this.state === 'voiding' ? 1 : 0, 3, dt);
    this.alarm = approach(this.alarm, this.state === 'exposed' ? 1 : 0, 2.5, dt);
    this.resign = approach(this.resign, this.state === 'resigned' ? 1 : 0, 1.2, dt);
    this.lift = approach(this.lift, this.grabbed ? 1 : 0, 8, dt);

    this.vigor = 1 - 0.5 * this.calm + 0.45 * this.alarm - 0.25 * this.resign + 0.5 * this.lift;
    const hz = 1.05 * (1 - 0.45 * this.calm + 0.45 * this.alarm - 0.25 * this.resign + 0.6 * this.lift);
    this.phase += dt * Math.PI * 2 * hz;

    this.pose(dt, time);
    return events;
  }

  private pose(dt: number, time: number) {
    const ph = this.phase;
    const s = Math.sin(ph);
    const { calm, alarm, resign, lift } = this;

    // Whole body
    const drop = (1 - this.spawn) * (1 - this.spawn);
    const bob = 0.012 * Math.sin(ph * 2) * (1 - 0.5 * calm);
    const sink = this.landed ? 0.05 * Math.exp(-this.landT * 4) * Math.cos(this.landT * 9) : 0;
    this.landT += dt;
    this.body.position.y =
      bob + 0.045 * alarm - 0.012 * resign + 0.11 * lift + (this.removing ? (1 - this.spawn) * 1.2 : drop * 1.5) - sink;
    const scale = this.removing ? 0.2 + 0.8 * this.spawn : 1;
    this.group.scale.setScalar(scale);
    this.group.position.set(this.x, 0, this.z);
    this.group.rotation.y = this.facing;
    const lean = Math.min(0.25, Math.hypot(this.vx, this.vz) * 0.12);
    this.body.rotation.set(0.07 + lean, 0, 0.028 * s);

    // Head: idle glances, the studied nonchalance of voiding, chin-up alarm.
    const t = time + this.seed;
    const idleYaw = 0.3 * Math.sin(t * 0.37) + 0.16 * Math.sin(t * 0.83 + 1.7);
    const searchYaw = 0.6 * Math.sin(t * 1.3);
    const awayYaw = 0.55 * Math.sign(Math.sin(this.seed * 12.9)) + 0.08 * Math.sin(t * 0.5);
    const yawTarget =
      idleYaw * (1 - calm) * (1 - alarm) * (1 - resign) + awayYaw * calm + searchYaw * alarm * (1 - calm);
    this.lookYaw = approach(this.lookYaw, yawTarget, 2.2, dt);
    const pitch = -0.07 - 0.24 * calm - 0.3 * alarm * (1 - calm) + 0.02 * resign;
    this.headPivot.rotation.set(pitch - lean, this.lookYaw, -0.028 * s);

    // Face
    const lid = 1 - 0.55 * calm - 0.4 * resign + 0.15 * alarm * (1 - calm);
    const blink = Math.sin(t * 0.9) > 0.995 ? 0.15 : 1;
    for (const eye of this.eyes) eye.scale.y = EYE * Math.max(0.12, lid * blink);
    const browLift = 0.008 * calm - 0.005 * alarm - 0.006 * resign;
    const browTilt = 0.4 * alarm * (1 - calm) - 0.1 * calm;
    this.brows.forEach((brow, i) => {
      const side = i === 0 ? -1 : 1;
      brow.position.y = HEAD_Y + BROW_Y + browLift;
      brow.rotation.z = -side * browTilt;
    });
    this.mouth.scale.set(
      MOUTH_W * (1 - 0.5 * calm + 0.2 * alarm * (1 - calm)),
      MOUTH_H * (1 + 2.0 * calm - 0.3 * alarm),
      0.012,
    );

    // Arms: sculling sweeps just under the surface.
    for (const arm of this.arms) {
      const sweep = 0.3 + 0.36 * Math.sin(ph) * (1 - 0.3 * calm);
      arm.upper.joint.rotation.set(0.06, -arm.side * sweep, arm.side * (1.3 - 0.1 * lift));
      arm.fore.joint.rotation.set(-(0.85 + 0.32 * Math.sin(ph - 0.9)), 0, arm.side * 0.14 * Math.cos(ph));
    }

    // Legs: eggbeater kick, legs half a cycle apart.
    for (const leg of this.legs) {
      const lp = ph + (leg.side > 0 ? 0 : Math.PI);
      const amp = 1 - 0.35 * calm;
      leg.thigh.joint.rotation.set(
        -(0.72 + 0.12 * Math.sin(lp) * amp),
        0,
        leg.side * (0.52 + 0.08 * Math.cos(lp) * amp),
      );
      leg.shin.joint.rotation.set(1.22 + 0.42 * Math.sin(lp) * amp, 0, leg.side * 0.46 * Math.cos(lp) * amp);
      leg.foot.rotation.x = 0.35 * Math.sin(lp + 0.6);
    }
  }

  private landT = 10;

  /** Called once when the subject hits the water after dropping in. */
  markLanded() {
    this.landed = true;
    this.landT = 0;
  }

  dispose() {
    for (const m of this.materials) m.dispose();
  }
}
