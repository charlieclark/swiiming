export interface TankDims {
  width: number;
  length: number;
  depth: number;
}

export const LIMITS = {
  width: { min: 3, max: 25, step: 0.5 },
  length: { min: 3, max: 50, step: 0.5 },
  depth: { min: 1.6, max: 5, step: 0.1 },
  subjects: { min: 0, max: 20 },
};

export const DEFAULT_TANK: TankDims = { width: 8, length: 14, depth: 2.4 };
export const DEFAULT_SUBJECTS = 5;

/** Height of the glass above the waterline (m). */
export const FREEBOARD = 0.3;
export const GLASS_THICKNESS = 0.04;
export const SLAB_THICKNESS = 0.22;

/** Reference: ~75 L of urine in an 830,000 L public pool (Blackstock et al., 2017). */
export const REFERENCE_PPM = (75 / 830000) * 1e6;

/** Local concentration (L/m^3) at which a subject notices. 1 L/m^3 == 1000 ppm. */
export const EXPOSURE_ON = 0.02;
export const EXPOSURE_OFF = 0.009;
export const RESIGNATION_SECONDS = 26;

export interface Quality {
  mobile: boolean;
  pixelRatio: number;
  simCells: number;
  marchSteps: number;
  shadowMap: number;
  rippleMax: number;
}

export function detectQuality(): Quality {
  const coarse = window.matchMedia('(pointer: coarse)').matches;
  const small = Math.min(window.innerWidth, window.innerHeight) < 700;
  const mobile = coarse && small;
  const dpr = window.devicePixelRatio || 1;
  return mobile
    ? { mobile, pixelRatio: Math.min(dpr, 1.5), simCells: 20000, marchSteps: 26, shadowMap: 1024, rippleMax: 256 }
    : { mobile, pixelRatio: Math.min(dpr, 2), simCells: 52000, marchSteps: 44, shadowMap: 2048, rippleMax: 384 };
}

export const COLORS = {
  background: 0xdfe5e9,
  ground: 0xb9c1c7,
  steel: 0x8f989e,
  slab: 0xc3c9cc,
};
