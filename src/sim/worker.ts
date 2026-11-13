/// <reference lib="webworker" />
import { FluidSim, SUBJECT_STRIDE } from './fluid';

export type ToWorker =
  | { type: 'init'; gen: number; width: number; depth: number; length: number; targetCells: number }
  | { type: 'step'; gen: number; dt: number; subjects: Float32Array; count: number; expectedLitres: number };

export interface FrameMessage {
  type: 'frame';
  gen: number;
  nx: number;
  ny: number;
  nz: number;
  density: Uint8Array;
  /** Per swimmer: concentration they are in contact with (L/m^3). */
  exposure: Float32Array;
  /** Per swimmer: unit direction (x, z) toward cleaner water, or (0, 0) if there is none. */
  escape: Float32Array;
  stepMs: number;
}

let sim: FluidSim | null = null;
let gen = -1;

const ctx = self as unknown as DedicatedWorkerGlobalScope;

const DIRS = 8;
const dirX: number[] = [];
const dirZ: number[] = [];
for (let i = 0; i < DIRS; i++) {
  dirX.push(Math.cos((i / DIRS) * Math.PI * 2));
  dirZ.push(Math.sin((i / DIRS) * Math.PI * 2));
}

/** Concentration near the surface at a point: what a swimmer there would be sitting in. */
function nearSurface(s: FluidSim, x: number, z: number) {
  return Math.max(s.sample(x, -0.1, z), s.sample(x, -0.4, z) * 0.85);
}

ctx.onmessage = (ev: MessageEvent<ToWorker>) => {
  const msg = ev.data;
  if (msg.type === 'init') {
    sim = new FluidSim(msg.width, msg.depth, msg.length, msg.targetCells);
    gen = msg.gen;
    return;
  }
  if (msg.type === 'step') {
    if (!sim || msg.gen !== gen) return;
    const t0 = performance.now();
    sim.step(msg.dt, msg.subjects, msg.count);
    const density = new Uint8Array(sim.n);
    sim.encode(density, msg.expectedLitres);
    const exposure = new Float32Array(msg.count);
    const escape = new Float32Array(msg.count * 2);
    const hx = sim.width / 2 - 0.5;
    const hz = sim.length / 2 - 0.5;
    for (let i = 0; i < msg.count; i++) {
      const o = i * SUBJECT_STRIDE;
      const x = msg.subjects[o];
      const z = msg.subjects[o + 1];
      const facing = msg.subjects[o + 2];
      const fx = Math.sin(facing);
      const fz = Math.cos(facing);
      // Contact concentration, weighted toward the face: what the swimmer would notice.
      const face = sim.sample(x + fx * 0.22, -0.08, z + fz * 0.22);
      const chest = sim.sample(x + fx * 0.12, -0.3, z + fz * 0.12);
      const waist = sim.sample(x + fx * 0.1, -0.6, z + fz * 0.1);
      const legs = sim.sample(x + fx * 0.15, -1.05, z + fz * 0.15);
      const here = Math.max(face, chest * 0.85, waist * 0.3, legs * 0.12);
      exposure[i] = here;

      // Look around for cleaner water.
      let best = here * 0.6;
      let bx = 0;
      let bz = 0;
      for (let d = 0; d < DIRS; d++) {
        const x1 = x + dirX[d] * 1.3;
        const z1 = z + dirZ[d] * 1.3;
        if (x1 < -hx || x1 > hx || z1 < -hz || z1 > hz) continue;
        const x2 = Math.max(-hx, Math.min(hx, x + dirX[d] * 2.8));
        const z2 = Math.max(-hz, Math.min(hz, z + dirZ[d] * 2.8));
        const score = 0.6 * nearSurface(sim, x1, z1) + 0.4 * nearSurface(sim, x2, z2);
        if (score < best) {
          best = score;
          bx = dirX[d];
          bz = dirZ[d];
        }
      }
      escape[i * 2] = bx;
      escape[i * 2 + 1] = bz;
    }
    const frame: FrameMessage = {
      type: 'frame',
      gen,
      nx: sim.nx,
      ny: sim.ny,
      nz: sim.nz,
      density,
      exposure,
      escape,
      stepMs: performance.now() - t0,
    };
    ctx.postMessage(frame, [density.buffer, exposure.buffer, escape.buffer]);
  }
};
