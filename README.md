# Aquatic Micturition Dispersion

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

The link preview tags in `index.html` point at `https://pool.charliie.co/`, and the preview image is
`public/og.jpg`. Update both if the site moves.

## Controls

- **Pool size**: use the sliders, pick a preset (bathtub, hot tub, backyard pool, 25 m pool, Olympic pool),
  or drag the pool itself: the top edges change width and length, the base changes depth. Resizing keeps
  the urine already in the water, so a smaller pool is more concentrated and a larger one more dilute.
- **Swimmers**: up to 100, or fewer if the pool is too small to hold them. **Spread evenly** moves everyone
  to an evenly spaced spot at once.
- **Click a swimmer** to open their card: a live view of their face, how much they have released, their
  flow rate, how long they have been peeing, and the concentration of the water around them. The card has its own Pee button.
- **Drag a swimmer** (anywhere on the body) to move them. Drag empty space to orbit, scroll or pinch to zoom.
- **Simultaneous release** (or the space bar): everyone pees until you press it again.
- **Speed**: 1x to 10x. Speeds up the release and the movement of the water; swimmers keep their normal pace.
- **Drain and refill**: fresh water, everyone stops.

## What the swimmers do

- Tread water, with arms tucked in when they are crowded or near a wall. In water too shallow to tread
  they stand, crouching to stay neck-deep, and in very shallow water they sit. With their feet on the
  bottom they keep still, and show panic by bringing their hands up to their face.
- Look relaxed while peeing, and ignore the water around them until they stop.
- Panic on the spot when the water at their face is worse than a typical public pool (about 90 ppm), and
  keep going until it drops back under.

## What is simulated

- **Dye transport**: a 3D stable-fluids solver (`src/sim/fluid.ts`) running in a Web Worker. Velocity is
  self-advected and pressure-projected; dye uses MacCormack advection so filaments stay sharp. Treading
  legs, sculling arms and moving swimmers stir the water; panicking swimmers stir it harder.
- **Surface**: a GPU heightfield ripple simulation (`src/water/ripples.ts`). Swimmers disturb it with their
  hands and bodies, and it drives part of the caustic light on the floor.
- **Rendering**: the water body is raymarched (`src/water/volume.ts`) with per-channel absorption for water
  and dye, refraction through the rippling surface, and a mirrored underside when viewed from below.
  Swimmers are drawn with five instanced meshes, so a hundred cost the same draw calls as one.
- **Readout**: the pool-average concentration assumes a well-mixed pool that overflows as liquid is added.
  The meter is linear, from zero to twice the public pool figure. That figure is the roughly 90 ppm implied by Blackstock et al., *Environ. Sci.
  Technol. Lett.* 2017, 4, 149-153, who estimated 75 L of urine in a 220,000 US gallon public pool.

The one liberty taken is the colour. At realistic concentrations urine is invisible in a pool, so the dye
is rendered far more strongly than it would appear.

## Layout

```
src/
  main.ts            wiring, pointer handling and the frame loop
  config.ts          limits, packing, quality tiers
  audio.ts           synthesised sound
  sim/               fluid solver, worker, main-thread client
  water/             ripples, surface reflection, raymarched volume
  scene/             renderer + camera + portrait view, pool geometry
  swimmers/          appearance, skeleton and poses, instanced drawing, crowd management
  ui/                panel, swimmer card, dimension labels
```
