/**
 * 3D stable-fluids solver on a collocated grid, used for dye (analyte) transport.
 *
 * Units: metres, seconds. Dye density is litres of analyte per cubic metre of water,
 * so 1.0 == 1000 ppm (v/v).
 *
 * Grid layout: index = i + nx * (j + ny * k)
 *   i -> x (tank width), j -> y (floor to surface), k -> z (tank length)
 * The water surface is y = 0, the floor is y = -depth.
 */

/** Per-subject input, packed as SUBJECT_STRIDE floats. */
export const SUBJECT_STRIDE = 8;
// [x, z, facing, phase, vigor, vx, vz, litresToInject]

/** Maximum encodable dye density (L/m^3). Encoding is sqrt for precision at low values. */
export const DYE_ENCODE_MAX = 16;

export interface GridDims {
  nx: number;
  ny: number;
  nz: number;
}

export function chooseGrid(width: number, depth: number, length: number, targetCells: number): GridDims {
  const volume = width * depth * length;
  const h = Math.cbrt(volume / targetCells);
  const clampDim = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, Math.round(v)));
  let nx = clampDim(width / h, 10, 144);
  let ny = clampDim(depth / h, 8, 64);
  let nz = clampDim(length / h, 10, 144);
  // Clamping can blow the budget on extreme aspect ratios; trim the long axes.
  while (nx * ny * nz > targetCells * 1.35) {
    if (nx >= nz && nx > 10) nx--;
    else if (nz > 10) nz--;
    else break;
  }
  return { nx, ny, nz };
}

export class FluidSim {
  readonly nx: number;
  readonly ny: number;
  readonly nz: number;
  readonly n: number;
  readonly hx: number;
  readonly hy: number;
  readonly hz: number;
  readonly cellVolume: number;

  private u: Float32Array;
  private v: Float32Array;
  private w: Float32Array;
  private u0: Float32Array;
  private v0: Float32Array;
  private w0: Float32Array;
  private p: Float32Array;
  private div: Float32Array;
  private d: Float32Array;
  private d0: Float32Array;

  private massScale = 1;
  time = 0;

  readonly width: number;
  readonly depth: number;
  readonly length: number;

  constructor(width: number, depth: number, length: number, targetCells: number) {
    this.width = width;
    this.depth = depth;
    this.length = length;
    const g = chooseGrid(width, depth, length, targetCells);
    this.nx = g.nx;
    this.ny = g.ny;
    this.nz = g.nz;
    this.n = g.nx * g.ny * g.nz;
    this.hx = width / g.nx;
    this.hy = depth / g.ny;
    this.hz = length / g.nz;
    this.cellVolume = this.hx * this.hy * this.hz;
    const mk = () => new Float32Array(this.n);
    this.u = mk();
    this.v = mk();
    this.w = mk();
    this.u0 = mk();
    this.v0 = mk();
    this.w0 = mk();
    this.p = mk();
    this.div = mk();
    this.d = mk();
    this.d0 = mk();
  }

  /** World position to continuous grid coordinates (cell centres at integers). */
  private gx(x: number) {
    return (x + this.width * 0.5) / this.hx - 0.5;
  }
  private gy(y: number) {
    return (y + this.depth) / this.hy - 0.5;
  }
  private gz(z: number) {
    return (z + this.length * 0.5) / this.hz - 0.5;
  }

  /**
   * Accelerate water inside a soft sphere. If `relax` is set, the blob instead pulls the
   * local velocity toward (ax, ay, az) treated as a target velocity.
   */
  private blob(
    cx: number,
    cy: number,
    cz: number,
    radius: number,
    ax: number,
    ay: number,
    az: number,
    dt: number,
    relax = 0,
  ) {
    const { nx, ny, nz, hx, hy, hz } = this;
    const fx = this.gx(cx);
    const fy = this.gy(cy);
    const fz = this.gz(cz);
    const rx = Math.max(radius / hx, 1.2);
    const ry = Math.max(radius / hy, 1.2);
    const rz = Math.max(radius / hz, 1.2);
    const i0 = Math.max(0, Math.floor(fx - rx));
    const i1 = Math.min(nx - 1, Math.ceil(fx + rx));
    const j0 = Math.max(0, Math.floor(fy - ry));
    const j1 = Math.min(ny - 1, Math.ceil(fy + ry));
    const k0 = Math.max(0, Math.floor(fz - rz));
    const k1 = Math.min(nz - 1, Math.ceil(fz + rz));
    const { u, v, w } = this;
    for (let k = k0; k <= k1; k++) {
      const dz = (k - fz) / rz;
      for (let j = j0; j <= j1; j++) {
        const dy = (j - fy) / ry;
        const base = nx * (j + ny * k);
        for (let i = i0; i <= i1; i++) {
          const dx = (i - fx) / rx;
          const r2 = dx * dx + dy * dy + dz * dz;
          if (r2 >= 1) continue;
          const f = (1 - r2) * (1 - r2);
          const idx = base + i;
          if (relax > 0) {
            const a = Math.min(1, relax * f * dt);
            u[idx] += (ax - u[idx]) * a;
            v[idx] += (ay - v[idx]) * a;
            w[idx] += (az - w[idx]) * a;
          } else {
            u[idx] += ax * f * dt;
            v[idx] += ay * f * dt;
            w[idx] += az * f * dt;
          }
        }
      }
    }
  }

  /** Deposit `litres` of dye in a soft sphere, conserving the total. */
  private deposit(cx: number, cy: number, cz: number, radius: number, litres: number) {
    const { nx, ny, nz, hx, hy, hz, d } = this;
    const fx = this.gx(cx);
    const fy = this.gy(cy);
    const fz = this.gz(cz);
    const rx = Math.max(radius / hx, 1.3);
    const ry = Math.max(radius / hy, 1.3);
    const rz = Math.max(radius / hz, 1.3);
    const i0 = Math.max(0, Math.floor(fx - rx));
    const i1 = Math.min(nx - 1, Math.ceil(fx + rx));
    const j0 = Math.max(0, Math.floor(fy - ry));
    const j1 = Math.min(ny - 1, Math.ceil(fy + ry));
    const k0 = Math.max(0, Math.floor(fz - rz));
    const k1 = Math.min(nz - 1, Math.ceil(fz + rz));
    let sum = 0;
    for (let pass = 0; pass < 2; pass++) {
      const scale = pass === 1 && sum > 0 ? litres / (sum * this.cellVolume) : 0;
      if (pass === 1 && sum <= 0) {
        // Degenerate footprint: put everything in the nearest cell.
        const ci = Math.max(0, Math.min(nx - 1, Math.round(fx)));
        const cj = Math.max(0, Math.min(ny - 1, Math.round(fy)));
        const ck = Math.max(0, Math.min(nz - 1, Math.round(fz)));
        d[ci + nx * (cj + ny * ck)] += litres / this.cellVolume;
        return;
      }
      for (let k = k0; k <= k1; k++) {
        const dz = (k - fz) / rz;
        for (let j = j0; j <= j1; j++) {
          const dy = (j - fy) / ry;
          const base = nx * (j + ny * k);
          for (let i = i0; i <= i1; i++) {
            const dx = (i - fx) / rx;
            const r2 = dx * dx + dy * dy + dz * dz;
            if (r2 >= 1) continue;
            const f = (1 - r2) * (1 - r2);
            if (pass === 0) sum += f;
            else d[base + i] += f * scale;
          }
        }
      }
    }
  }

  private applySubjects(subjects: Float32Array, count: number, dt: number) {
    const minY = -this.depth + this.hy * 0.6;
    for (let s = 0; s < count; s++) {
      const o = s * SUBJECT_STRIDE;
      const x = subjects[o];
      const z = subjects[o + 1];
      const facing = subjects[o + 2];
      const phase = subjects[o + 3];
      const vigor = subjects[o + 4];
      const vx = subjects[o + 5];
      const vz = subjects[o + 6];
      const litres = subjects[o + 7];
      // Forward and right vectors in the horizontal plane.
      const fxd = Math.sin(facing);
      const fzd = Math.cos(facing);
      const rxd = Math.cos(facing);
      const rzd = -Math.sin(facing);
      const sp = Math.sin(phase);
      const cp = Math.cos(phase);

      // Eggbeater kick: net downward thrust plus alternating swirl from each leg.
      const legY = Math.max(minY, -1.15);
      for (let side = -1; side <= 1; side += 2) {
        const lx = x + rxd * 0.2 * side + fxd * 0.12;
        const lz = z + rzd * 0.2 * side + fzd * 0.12;
        const swirl = 0.75 * vigor * (side > 0 ? sp : -sp);
        const out = 0.45 * vigor * cp * side;
        this.blob(
          lx,
          legY,
          lz,
          0.3,
          fxd * swirl + rxd * out,
          -0.6 * vigor,
          fzd * swirl + rzd * out,
          dt,
        );
      }
      // Sculling arms: alternating lateral push just below the surface.
      for (let side = -1; side <= 1; side += 2) {
        const ax = x + rxd * 0.48 * side + fxd * 0.16;
        const az = z + rzd * 0.48 * side + fzd * 0.16;
        const push = 0.6 * vigor * cp * side;
        const fwd = 0.4 * vigor * sp;
        this.blob(ax, -0.25, az, 0.26, rxd * push + fxd * fwd, -0.25 * vigor, rzd * push + fzd * fwd, dt);
      }
      // Body drag when the subject is being repositioned.
      const speed = Math.hypot(vx, vz);
      if (speed > 0.02) {
        this.blob(x, Math.max(minY, -0.55), z, 0.42, vx * 0.85, 0, vz * 0.85, dt, 9);
      }
      // Analyte release at the pelvis, with a slight forward-down drift.
      if (litres > 0) {
        const py = Math.max(minY, -0.74);
        const px = x + fxd * 0.1;
        const pz = z + fzd * 0.1;
        this.deposit(px, py, pz, 0.1, litres);
        this.blob(px, py, pz, 0.16, fxd * 0.22, -0.2, fzd * 0.22, dt, 6);
      }
    }
  }

  /** Slow tank-scale circulation (as from filtration returns) so dye keeps wandering. */
  private applyCirculation(dt: number) {
    const { nx, ny, nz, u, w } = this;
    const amp = 0.012 * dt;
    const s1 = Math.sin(this.time * 0.07);
    const s2 = Math.cos(this.time * 0.045 + 1.3);
    const sinX = new Float32Array(nx);
    const cosX = new Float32Array(nx);
    const sin2X = new Float32Array(nx);
    const cos2X = new Float32Array(nx);
    for (let i = 0; i < nx; i++) {
      const X = ((i + 0.5) / nx) * Math.PI;
      sinX[i] = Math.sin(X);
      cosX[i] = Math.cos(X);
      sin2X[i] = Math.sin(2 * X);
      cos2X[i] = Math.cos(2 * X);
    }
    const aspect = this.width / this.length;
    for (let k = 0; k < nz; k++) {
      const Z = ((k + 0.5) / nz) * Math.PI;
      const sinZ = Math.sin(Z);
      const cosZ = Math.cos(Z);
      const sin2Z = Math.sin(2 * Z);
      const cos2Z = Math.cos(2 * Z);
      for (let j = 0; j < ny; j++) {
        const yMod = Math.cos(((j + 0.5) / ny) * Math.PI);
        const a1 = amp * s1 * yMod;
        const a2 = amp * s2 * 0.6;
        const base = nx * (j + ny * k);
        for (let i = 0; i < nx; i++) {
          const idx = base + i;
          u[idx] += a1 * sinX[i] * cosZ * aspect + a2 * sin2X[i] * cos2Z * aspect;
          w[idx] -= a1 * cosX[i] * sinZ + a2 * cos2X[i] * sin2Z;
        }
      }
    }
  }

  private applyBuoyancyAndDamping(dt: number) {
    const { n, u, v, w, d } = this;
    const damp = Math.exp(-0.22 * dt);
    const sink = 0.0025 * dt;
    for (let i = 0; i < n; i++) {
      const di = d[i];
      u[i] *= damp;
      w[i] *= damp;
      v[i] = v[i] * damp - sink * (di > 3 ? 3 : di);
    }
  }

  /** Vorticity confinement keeps small eddies alive on a coarse grid. */
  private confineVorticity(dt: number, strength: number) {
    const { nx, ny, nz, u, v, w } = this;
    const cx = this.u0;
    const cy = this.v0;
    const cz = this.w0;
    const mag = this.div;
    const sxy = nx * ny;
    const ihx = 0.5 / this.hx;
    const ihy = 0.5 / this.hy;
    const ihz = 0.5 / this.hz;
    for (let k = 0; k < nz; k++) {
      const kb = k > 0 ? -sxy : 0;
      const kf = k < nz - 1 ? sxy : 0;
      for (let j = 0; j < ny; j++) {
        const jd = j > 0 ? -nx : 0;
        const ju = j < ny - 1 ? nx : 0;
        const base = nx * (j + ny * k);
        for (let i = 0; i < nx; i++) {
          const idx = base + i;
          const l = i > 0 ? idx - 1 : idx;
          const r = i < nx - 1 ? idx + 1 : idx;
          const dn = idx + jd;
          const up = idx + ju;
          const bk = idx + kb;
          const ft = idx + kf;
          const ox = (w[up] - w[dn]) * ihy - (v[ft] - v[bk]) * ihz;
          const oy = (u[ft] - u[bk]) * ihz - (w[r] - w[l]) * ihx;
          const oz = (v[r] - v[l]) * ihx - (u[up] - u[dn]) * ihy;
          cx[idx] = ox;
          cy[idx] = oy;
          cz[idx] = oz;
          mag[idx] = Math.sqrt(ox * ox + oy * oy + oz * oz);
        }
      }
    }
    const hAvg = (this.hx + this.hy + this.hz) / 3;
    const eps = strength * hAvg * dt;
    for (let k = 1; k < nz - 1; k++) {
      for (let j = 1; j < ny - 1; j++) {
        const base = nx * (j + ny * k);
        for (let i = 1; i < nx - 1; i++) {
          const idx = base + i;
          let gx = (mag[idx + 1] - mag[idx - 1]) * ihx;
          let gy = (mag[idx + nx] - mag[idx - nx]) * ihy;
          let gz = (mag[idx + sxy] - mag[idx - sxy]) * ihz;
          const len = Math.sqrt(gx * gx + gy * gy + gz * gz) + 1e-5;
          gx /= len;
          gy /= len;
          gz /= len;
          const ox = cx[idx];
          const oy = cy[idx];
          const oz = cz[idx];
          u[idx] += eps * (gy * oz - gz * oy);
          v[idx] += eps * (gz * ox - gx * oz);
          w[idx] += eps * (gx * oy - gy * ox);
        }
      }
    }
  }

  private enforceWalls() {
    const { nx, ny, nz, u, v, w } = this;
    const sxy = nx * ny;
    for (let k = 0; k < nz; k++) {
      for (let j = 0; j < ny; j++) {
        const base = nx * (j + ny * k);
        if (u[base] < 0) u[base] = 0;
        if (u[base + nx - 1] > 0) u[base + nx - 1] = 0;
      }
    }
    for (let k = 0; k < nz; k++) {
      const lo = sxy * k;
      const hi = lo + nx * (ny - 1);
      for (let i = 0; i < nx; i++) {
        if (v[lo + i] < 0) v[lo + i] = 0;
        if (v[hi + i] > 0) v[hi + i] = 0;
      }
    }
    const last = sxy * (nz - 1);
    for (let i = 0; i < sxy; i++) {
      if (w[i] < 0) w[i] = 0;
      if (w[last + i] > 0) w[last + i] = 0;
    }
  }

  private advectVelocity(dt: number) {
    // Swap so (u0, v0, w0) hold the field being advected.
    let t = this.u;
    this.u = this.u0;
    this.u0 = t;
    t = this.v;
    this.v = this.v0;
    this.v0 = t;
    t = this.w;
    this.w = this.w0;
    this.w0 = t;
    const { nx, ny, nz, u, v, w, u0, v0, w0 } = this;
    const sxy = nx * ny;
    const cxs = dt / this.hx;
    const cys = dt / this.hy;
    const czs = dt / this.hz;
    const mx = nx - 1.001;
    const my = ny - 1.001;
    const mz = nz - 1.001;
    for (let k = 0; k < nz; k++) {
      for (let j = 0; j < ny; j++) {
        const base = nx * (j + ny * k);
        for (let i = 0; i < nx; i++) {
          const idx = base + i;
          let x = i - u0[idx] * cxs;
          let y = j - v0[idx] * cys;
          let z = k - w0[idx] * czs;
          x = x < 0 ? 0 : x > mx ? mx : x;
          y = y < 0 ? 0 : y > my ? my : y;
          z = z < 0 ? 0 : z > mz ? mz : z;
          const xi = x | 0;
          const yi = y | 0;
          const zi = z | 0;
          const tx = x - xi;
          const ty = y - yi;
          const tz = z - zi;
          const a = xi + nx * (yi + ny * zi);
          const b = a + nx;
          const c = a + sxy;
          const e = c + nx;
          const w000 = (1 - tx) * (1 - ty) * (1 - tz);
          const w100 = tx * (1 - ty) * (1 - tz);
          const w010 = (1 - tx) * ty * (1 - tz);
          const w110 = tx * ty * (1 - tz);
          const w001 = (1 - tx) * (1 - ty) * tz;
          const w101 = tx * (1 - ty) * tz;
          const w011 = (1 - tx) * ty * tz;
          const w111 = tx * ty * tz;
          u[idx] =
            u0[a] * w000 + u0[a + 1] * w100 + u0[b] * w010 + u0[b + 1] * w110 +
            u0[c] * w001 + u0[c + 1] * w101 + u0[e] * w011 + u0[e + 1] * w111;
          v[idx] =
            v0[a] * w000 + v0[a + 1] * w100 + v0[b] * w010 + v0[b + 1] * w110 +
            v0[c] * w001 + v0[c + 1] * w101 + v0[e] * w011 + v0[e + 1] * w111;
          w[idx] =
            w0[a] * w000 + w0[a + 1] * w100 + w0[b] * w010 + w0[b + 1] * w110 +
            w0[c] * w001 + w0[c + 1] * w101 + w0[e] * w011 + w0[e + 1] * w111;
        }
      }
    }
  }

  private project(iterations: number) {
    const { nx, ny, nz, u, v, w, p, div } = this;
    const sxy = nx * ny;
    const ihx = 0.5 / this.hx;
    const ihy = 0.5 / this.hy;
    const ihz = 0.5 / this.hz;
    for (let k = 0; k < nz; k++) {
      const kb = k > 0 ? -sxy : 0;
      const kf = k < nz - 1 ? sxy : 0;
      for (let j = 0; j < ny; j++) {
        const jd = j > 0 ? -nx : 0;
        const ju = j < ny - 1 ? nx : 0;
        const base = nx * (j + ny * k);
        for (let i = 0; i < nx; i++) {
          const idx = base + i;
          const l = i > 0 ? idx - 1 : idx;
          const r = i < nx - 1 ? idx + 1 : idx;
          div[idx] =
            (u[r] - u[l]) * ihx + (v[idx + ju] - v[idx + jd]) * ihy + (w[idx + kf] - w[idx + kb]) * ihz;
        }
      }
    }
    // Compact Laplacian paired with central-difference gradients (as in Stam's solver).
    const ax = 1 / (this.hx * this.hx);
    const ay = 1 / (this.hy * this.hy);
    const az = 1 / (this.hz * this.hz);
    const inv = 1 / (2 * (ax + ay + az));
    const omega = 1.6;
    for (let it = 0; it < iterations; it++) {
      for (let k = 0; k < nz; k++) {
        const kb = k > 0 ? -sxy : 0;
        const kf = k < nz - 1 ? sxy : 0;
        for (let j = 0; j < ny; j++) {
          const jd = j > 0 ? -nx : 0;
          const ju = j < ny - 1 ? nx : 0;
          const base = nx * (j + ny * k);
          for (let i = 0; i < nx; i++) {
            const idx = base + i;
            const l = i > 0 ? idx - 1 : idx;
            const r = i < nx - 1 ? idx + 1 : idx;
            const target =
              (ax * (p[l] + p[r]) + ay * (p[idx + jd] + p[idx + ju]) + az * (p[idx + kb] + p[idx + kf]) - div[idx]) *
              inv;
            p[idx] += omega * (target - p[idx]);
          }
        }
      }
    }
    for (let k = 0; k < nz; k++) {
      const kb = k > 0 ? -sxy : 0;
      const kf = k < nz - 1 ? sxy : 0;
      for (let j = 0; j < ny; j++) {
        const jd = j > 0 ? -nx : 0;
        const ju = j < ny - 1 ? nx : 0;
        const base = nx * (j + ny * k);
        for (let i = 0; i < nx; i++) {
          const idx = base + i;
          const l = i > 0 ? idx - 1 : idx;
          const r = i < nx - 1 ? idx + 1 : idx;
          u[idx] -= (p[r] - p[l]) * ihx;
          v[idx] -= (p[idx + ju] - p[idx + jd]) * ihy;
          w[idx] -= (p[idx + kf] - p[idx + kb]) * ihz;
        }
      }
    }
  }

  /**
   * MacCormack advection for dye: a forward and a reverse semi-Lagrangian pass, with the
   * error estimate added back and clamped. Keeps filaments much sharper on a coarse grid.
   */
  private advectDye(dt: number) {
    const t = this.d;
    this.d = this.d0;
    this.d0 = t;
    const { nx, ny, nz, u, v, w, d, d0 } = this;
    const fwd = this.div;
    const lo = this.u0;
    const hi = this.v0;
    const sxy = nx * ny;
    const cxs = dt / this.hx;
    const cys = dt / this.hy;
    const czs = dt / this.hz;
    const mx = nx - 1.001;
    const my = ny - 1.001;
    const mz = nz - 1.001;
    for (let k = 0; k < nz; k++) {
      for (let j = 0; j < ny; j++) {
        const base = nx * (j + ny * k);
        for (let i = 0; i < nx; i++) {
          const idx = base + i;
          let x = i - u[idx] * cxs;
          let y = j - v[idx] * cys;
          let z = k - w[idx] * czs;
          x = x < 0 ? 0 : x > mx ? mx : x;
          y = y < 0 ? 0 : y > my ? my : y;
          z = z < 0 ? 0 : z > mz ? mz : z;
          const xi = x | 0;
          const yi = y | 0;
          const zi = z | 0;
          const tx = x - xi;
          const ty = y - yi;
          const tz = z - zi;
          const a = xi + nx * (yi + ny * zi);
          const b = a + nx;
          const c = a + sxy;
          const e = c + nx;
          const v0 = d0[a], v1 = d0[a + 1], v2 = d0[b], v3 = d0[b + 1];
          const v4 = d0[c], v5 = d0[c + 1], v6 = d0[e], v7 = d0[e + 1];
          const l = (v0 * (1 - tx) + v1 * tx) * (1 - ty) + (v2 * (1 - tx) + v3 * tx) * ty;
          const h = (v4 * (1 - tx) + v5 * tx) * (1 - ty) + (v6 * (1 - tx) + v7 * tx) * ty;
          fwd[idx] = l * (1 - tz) + h * tz;
          lo[idx] = Math.min(v0, v1, v2, v3, v4, v5, v6, v7);
          hi[idx] = Math.max(v0, v1, v2, v3, v4, v5, v6, v7);
        }
      }
    }
    for (let k = 0; k < nz; k++) {
      for (let j = 0; j < ny; j++) {
        const base = nx * (j + ny * k);
        for (let i = 0; i < nx; i++) {
          const idx = base + i;
          let x = i + u[idx] * cxs;
          let y = j + v[idx] * cys;
          let z = k + w[idx] * czs;
          x = x < 0 ? 0 : x > mx ? mx : x;
          y = y < 0 ? 0 : y > my ? my : y;
          z = z < 0 ? 0 : z > mz ? mz : z;
          const xi = x | 0;
          const yi = y | 0;
          const zi = z | 0;
          const tx = x - xi;
          const ty = y - yi;
          const tz = z - zi;
          const a = xi + nx * (yi + ny * zi);
          const b = a + nx;
          const c = a + sxy;
          const e = c + nx;
          const l = (fwd[a] * (1 - tx) + fwd[a + 1] * tx) * (1 - ty) + (fwd[b] * (1 - tx) + fwd[b + 1] * tx) * ty;
          const h = (fwd[c] * (1 - tx) + fwd[c + 1] * tx) * (1 - ty) + (fwd[e] * (1 - tx) + fwd[e + 1] * tx) * ty;
          const back = l * (1 - tz) + h * tz;
          let r = fwd[idx] + 0.5 * (d0[idx] - back);
          const mn = lo[idx];
          const mxv = hi[idx];
          r = r < mn ? mn : r > mxv ? mxv : r;
          d[idx] = r;
        }
      }
    }
  }

  /** Small explicit turbulent diffusion so the tank homogenises eventually. */
  private diffuseDye(dt: number, kappa: number) {
    const t = this.d;
    this.d = this.d0;
    this.d0 = t;
    const { nx, ny, nz, d, d0 } = this;
    const sxy = nx * ny;
    const lim = 0.15;
    const ax = Math.min(lim, (kappa * dt) / (this.hx * this.hx));
    const ay = Math.min(lim, (kappa * dt) / (this.hy * this.hy));
    const az = Math.min(lim, (kappa * dt) / (this.hz * this.hz));
    for (let k = 0; k < nz; k++) {
      const kb = k > 0 ? -sxy : 0;
      const kf = k < nz - 1 ? sxy : 0;
      for (let j = 0; j < ny; j++) {
        const jd = j > 0 ? -nx : 0;
        const ju = j < ny - 1 ? nx : 0;
        const base = nx * (j + ny * k);
        for (let i = 0; i < nx; i++) {
          const idx = base + i;
          const l = i > 0 ? idx - 1 : idx;
          const r = i < nx - 1 ? idx + 1 : idx;
          const c = d0[idx];
          d[idx] =
            c +
            ax * (d0[l] + d0[r] - 2 * c) +
            ay * (d0[idx + jd] + d0[idx + ju] - 2 * c) +
            az * (d0[idx + kb] + d0[idx + kf] - 2 * c);
        }
      }
    }
  }

  step(dt: number, subjects: Float32Array, count: number) {
    this.time += dt;
    this.applySubjects(subjects, count, dt);
    this.applyCirculation(dt);
    this.applyBuoyancyAndDamping(dt);
    this.confineVorticity(dt, 2.4);
    this.enforceWalls();
    this.advectVelocity(dt);
    this.enforceWalls();
    this.project(12);
    this.enforceWalls();
    this.advectDye(dt);
    this.diffuseDye(dt, 0.0012);
  }

  /**
   * Encode dye into bytes for the volume texture. Also nudges total dye mass toward
   * `expectedLitres`, because semi-Lagrangian advection is not exactly conservative.
   */
  encode(out: Uint8Array, expectedLitres: number) {
    const { n, d } = this;
    const scale = this.massScale;
    const k = 255 / Math.sqrt(DYE_ENCODE_MAX);
    let sum = 0;
    for (let i = 0; i < n; i++) {
      let v = d[i] * scale;
      if (v < 0) v = 0;
      d[i] = v;
      sum += v;
      const e = Math.sqrt(v) * k;
      out[i] = e > 255 ? 255 : e + 0.5;
    }
    const litres = sum * this.cellVolume;
    if (litres > 1e-7 && expectedLitres > 0) {
      const ratio = expectedLitres / litres;
      this.massScale = ratio < 0.97 ? 0.97 : ratio > 1.03 ? 1.03 : ratio;
    } else {
      this.massScale = 1;
    }
    return litres;
  }

  /** Trilinear dye sample at a world position (L/m^3). */
  sample(x: number, y: number, z: number) {
    const { nx, ny, nz, d } = this;
    let gx = this.gx(x);
    let gy = this.gy(y);
    let gz = this.gz(z);
    gx = gx < 0 ? 0 : gx > nx - 1.001 ? nx - 1.001 : gx;
    gy = gy < 0 ? 0 : gy > ny - 1.001 ? ny - 1.001 : gy;
    gz = gz < 0 ? 0 : gz > nz - 1.001 ? nz - 1.001 : gz;
    const xi = gx | 0;
    const yi = gy | 0;
    const zi = gz | 0;
    const tx = gx - xi;
    const ty = gy - yi;
    const tz = gz - zi;
    const a = xi + nx * (yi + ny * zi);
    const b = a + nx;
    const c = a + nx * ny;
    const e = c + nx;
    const lo = (d[a] * (1 - tx) + d[a + 1] * tx) * (1 - ty) + (d[b] * (1 - tx) + d[b + 1] * tx) * ty;
    const hi = (d[c] * (1 - tx) + d[c + 1] * tx) * (1 - ty) + (d[e] * (1 - tx) + d[e + 1] * tx) * ty;
    return lo * (1 - tz) + hi * tz;
  }

  maxSpeed() {
    const { n, u, v, w } = this;
    let m = 0;
    for (let i = 0; i < n; i++) {
      const s = u[i] * u[i] + v[i] * v[i] + w[i] * w[i];
      if (s > m) m = s;
    }
    return Math.sqrt(m);
  }
}
