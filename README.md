# Aquatic Micturition Dispersion Study

A 3D simulation of what happens when everyone in the pool pees at once. Presented with a straight face.

Built with three.js, TypeScript and Vite. No assets: geometry, textures and sound are all generated at runtime.

## Running it

```bash
npm install
```

```bash
npm run dev
```

```bash
npm run build
```

`npm run build` type-checks and writes a static site to `dist/` that can be hosted anywhere.

## Controls

- **Tank sliders**: width, length and depth of the pool. Changing them replaces the water.
- **Subjects**: add or remove swimmers (0 to 20). They tread water where you put them.
- **Drag a swimmer** to reposition them. Drag anywhere else to orbit, scroll or pinch to zoom.
- **PEE** (or the space bar): every swimmer releases at the same time.
- **Drain and refill**: fresh water, counters reset.

## What is simulated

- **Dye transport**: a 3D stable-fluids solver (`src/sim/fluid.ts`) running in a Web Worker. Velocity is
  self-advected and pressure-projected; dye uses MacCormack advection so filaments stay sharp. Treading
  legs and sculling arms stir the water, and dragging a swimmer pushes water with them.
- **Surface**: a GPU heightfield ripple simulation (`src/water/ripples.ts`) that also drives the caustics
  on the tank floor.
- **Rendering**: the water body is raymarched (`src/water/volume.ts`) with per-channel absorption for water
  and dye, refraction through the rippling surface, and a mirrored underside when viewed from below.
- **Readout**: concentration is real arithmetic, litres released over litres in the tank. Each release is
  0.3 to 0.5 L per swimmer. The reference mark on the meter is the roughly 90 ppm estimated for a public
  pool by Blackstock et al. (2017).

The one liberty taken is the tracer gain. At realistic concentrations urine is invisible in a pool, so the
dye is rendered far more strongly than it would appear.

## Layout

```
src/
  main.ts            wiring and the frame loop
  config.ts          limits, defaults, quality tiers
  audio.ts           synthesised sound
  sim/               fluid solver, worker, main-thread client
  water/             ripples, surface reflection, raymarched volume
  scene/             renderer + camera, tank geometry
  swimmers/          figures, animation states, placement and dragging
  ui/                panel, labels, event log
```
