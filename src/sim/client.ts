import { chooseGrid, SUBJECT_STRIDE, type GridDims } from './fluid';
import type { FrameMessage, ToWorker } from './worker';

export const SIM_DT = 1 / 30;

export interface SolverInput {
  count: number;
  expectedLitres: number;
  /** Writes SUBJECT_STRIDE floats per subject. Called once per dispatched step. */
  fill(out: Float32Array): void;
}

/**
 * Main-thread handle to the fluid worker. Steps are dispatched as simulated time accrues
 * and the worker is free, independent of the render frame rate.
 */
export class FluidClient {
  private worker: Worker;
  private gen = 0;
  private busy = false;
  private acc = 0;
  grid: GridDims = { nx: 1, ny: 1, nz: 1 };
  stepMs = 0;
  source: () => SolverInput = () => ({ count: 0, expectedLitres: 0, fill: () => {} });
  onFrame: (frame: FrameMessage) => void = () => {};

  constructor(private targetCells: number) {
    this.worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
    this.worker.onmessage = (ev: MessageEvent<FrameMessage>) => {
      const frame = ev.data;
      if (frame.gen !== this.gen) return;
      this.busy = false;
      this.stepMs = this.stepMs * 0.9 + frame.stepMs * 0.1;
      this.onFrame(frame);
      this.dispatch();
    };
  }

  /** Rebuild the solver for new tank dimensions. All dye is discarded. */
  configure(width: number, depth: number, length: number) {
    this.gen++;
    this.busy = false;
    this.acc = 0;
    this.grid = chooseGrid(width, depth, length, this.targetCells);
    const msg: ToWorker = { type: 'init', gen: this.gen, width, depth, length, targetCells: this.targetCells };
    this.worker.postMessage(msg);
    return this.grid;
  }

  /** Call every frame with elapsed time. */
  update(dt: number) {
    this.acc = Math.min(this.acc + dt, SIM_DT * 4);
    this.dispatch();
  }

  private dispatch() {
    if (this.busy || this.acc < SIM_DT) return;
    this.acc -= SIM_DT;
    const input = this.source();
    const subjects = new Float32Array(Math.max(1, input.count) * SUBJECT_STRIDE);
    input.fill(subjects);
    const msg: ToWorker = {
      type: 'step',
      gen: this.gen,
      dt: SIM_DT,
      subjects,
      count: input.count,
      expectedLitres: input.expectedLitres,
    };
    this.busy = true;
    this.worker.postMessage(msg, [subjects.buffer]);
  }
}
