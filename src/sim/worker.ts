/// <reference lib="webworker" />
import { FluidSim, SUBJECT_STRIDE } from './fluid';

export type ToWorker =
  | { type: 'init'; gen: number; width: number; depth: number; length: number; targetCells: number; keepDye: boolean }
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
  stepMs: number;
}

let sim: FluidSim | null = null;
let gen = -1;

const ctx = self as unknown as DedicatedWorkerGlobalScope;

ctx.onmessage = (ev: MessageEvent<ToWorker>) => {
  const msg = ev.data;
  if (msg.type === 'init') {
    const next = new FluidSim(msg.width, msg.depth, msg.length, msg.targetCells);
    if (msg.keepDye && sim) next.adoptDye(sim);
    sim = next;
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
      exposure[i] = Math.max(face, chest * 0.85, waist * 0.3, legs * 0.12);
    }
    const frame: FrameMessage = {
      type: 'frame',
      gen,
      nx: sim.nx,
      ny: sim.ny,
      nz: sim.nz,
      density,
      exposure,
      stepMs: performance.now() - t0,
    };
    ctx.postMessage(frame, [density.buffer, exposure.buffer]);
  }
};
