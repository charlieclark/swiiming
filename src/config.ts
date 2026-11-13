export interface TankDims {
  width: number;
  length: number;
  depth: number;
}

export const LIMITS = {
  width: { min: 0.7, max: 25, step: 0.1 },
  length: { min: 1.4, max: 50, step: 0.1 },
  depth: { min: 0.4, max: 5, step: 0.1 },
  swimmers: { min: 0, max: 100 },
};

export const DEFAULT_TANK: TankDims = { width: 8, length: 14, depth: 2.4 };

/** Familiar bodies of water, as simple boxes. */
export const PRESETS: { label: string; dims: TankDims }[] = [
  { label: 'Bathtub', dims: { width: 0.7, length: 1.5, depth: 0.4 } },
  { label: 'Hot tub', dims: { width: 2, length: 2, depth: 0.8 } },
  { label: 'Backyard pool', dims: { width: 4, length: 8, depth: 1.5 } },
  { label: '25 m pool', dims: { width: 12.5, length: 25, depth: 1.8 } },
  { label: 'Olympic pool', dims: { width: 25, length: 50, depth: 2 } },
];
export const DEFAULT_SWIMMERS = 6;

/** Height of the glass above the waterline (m). */
export const FREEBOARD = 0.3;
export const GLASS_THICKNESS = 0.04;
export const SLAB_THICKNESS = 0.22;

/** Closest two swimmers may be, centre to centre, with arms tucked in (m). */
export const SPACING = 0.78;
/** Closest a swimmer's centre may be to a wall (m). */
export const WALL_MARGIN = 0.4;

/** Hexagonal packing of swimmer positions inside the walls, at a given spacing. */
export function packedSlots(dims: TankDims, spacing = SPACING): [number, number][] {
  const w = dims.width - WALL_MARGIN * 2;
  const l = dims.length - WALL_MARGIN * 2;
  if (w < 0 || l < 0) return [[0, 0]];
  const rowStep = spacing * 0.866;
  const rows = Math.floor(l / rowStep + 1e-6) + 1;
  const out: [number, number][] = [];
  const z0 = -((rows - 1) * rowStep) / 2;
  for (let r = 0; r < rows; r++) {
    const shifted = r % 2 === 1;
    const span = shifted ? w - spacing : w;
    if (span < 0) continue;
    const cols = Math.floor(span / spacing + 1e-6) + 1;
    const x0 = -((cols - 1) * spacing) / 2;
    for (let c = 0; c < cols; c++) out.push([x0 + c * spacing, z0 + r * rowStep]);
  }
  return out;
}

/** How many swimmers physically fit in a tank of this footprint. */
export function capacity(dims: TankDims) {
  return Math.max(1, Math.min(LIMITS.swimmers.max, packedSlots(dims).length));
}

/**
 * Blackstock et al. (2017) estimated about 75 L of urine in a 220,000 US gallon
 * (roughly 830,000 L) public pool.
 */
export const REFERENCE_PPM = (75 / 830000) * 1e6;

/**
 * Swimmers panic when the water at their face is worse than that public pool, and calm
 * down once it is comfortably back under. In L/m^3 (1 L/m^3 == 1000 ppm).
 */
export const EXPOSURE_ON = REFERENCE_PPM / 1000;
export const EXPOSURE_OFF = EXPOSURE_ON * 0.6;

export interface Quality {
  mobile: boolean;
  pixelRatio: number;
  simCells: number;
  marchSteps: number;
  shadowMap: number;
  rippleMax: number;
  /**
   * Whether to build a reflection environment. It makes glass and steel look better, but
   * building it and compiling the longer shaders it needs is slow on phone GPUs.
   */
  reflections: boolean;
}

export function detectQuality(): Quality {
  const coarse = window.matchMedia('(pointer: coarse)').matches;
  const small = Math.min(window.innerWidth, window.innerHeight) < 700;
  const mobile = coarse && small;
  const dpr = window.devicePixelRatio || 1;
  return mobile
    ? { mobile, pixelRatio: Math.min(dpr, 1.5), simCells: 20000, marchSteps: 26, shadowMap: 1024, rippleMax: 256, reflections: false }
    : { mobile, pixelRatio: Math.min(dpr, 2), simCells: 52000, marchSteps: 44, shadowMap: 2048, rippleMax: 384, reflections: true };
}

export const COLORS = {
  background: 0xdfe5e9,
  ground: 0xb9c1c7,
  steel: 0x8f989e,
  slab: 0xc3c9cc,
};
