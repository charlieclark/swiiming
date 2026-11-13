import * as THREE from 'three';
import { Sound } from './audio';
import { DEFAULT_SWIMMERS, DEFAULT_TANK, detectQuality, type TankDims } from './config';
import { Stage } from './scene/stage';
import { Tank } from './scene/tank';
import { FluidClient } from './sim/client';
import { SwimmerManager } from './swimmers/manager';
import type { Swimmer } from './swimmers/swimmer';
import { UI } from './ui/ui';
import { Ripples } from './water/ripples';
import { WaterSurface } from './water/surface';
import { WaterVolume } from './water/volume';

const quality = detectQuality();
const canvas = document.getElementById('scene') as HTMLCanvasElement;
const stage = new Stage(canvas, quality);
const sound = new Sound();

const ripples = new Ripples(stage.renderer, quality.rippleMax);
const tank = new Tank(stage.renderer, ripples);
const surface = new WaterSurface(ripples, stage.sunDir);
const volume = new WaterVolume(ripples, quality.marchSteps, stage.sunDir);
const fluid = new FluidClient(quality.simCells);

let dims: TankDims = { ...DEFAULT_TANK };
/** True while the main button is holding everyone's release open. */
let releasing = false;

const swimmers = new SwimmerManager(ripples, {
  onSplash: (strength) => sound.splash(strength),
});

const ui = new UI(
  {
    onDims: (next) => {
      dims = next;
      configure(false);
    },
    onCount: (n) => {
      sound.unlock();
      const before = swimmers.count;
      swimmers.setCount(n, releasing);
      if (swimmers.count !== before) sound.tick();
      ui.setCount(swimmers.count, swimmers.capacity);
    },
    onRelease: () => {
      sound.unlock();
      if (swimmers.count === 0) return;
      releasing = !releasing;
      swimmers.setAllPeeing(releasing);
      sound.press();
    },
    onSpread: () => {
      sound.unlock();
      swimmers.spreadEvenly();
      sound.tick();
    },
    onDrain: () => {
      sound.unlock();
      releasing = false;
      swimmers.setAllPeeing(false);
      resetWater();
      sound.drain();
    },
    onSound: (on) => {
      sound.unlock();
      sound.setEnabled(on);
    },
    onLayout: () => {
      layout();
      stage.configure(dims, false);
    },
    onCardPee: () => {
      sound.unlock();
      const s = swimmers.selected;
      if (!s) return;
      s.peeing = !s.peeing;
      sound.tick();
    },
    onCardClose: () => {
      swimmers.selected = null;
    },
  },
  dims,
);

stage.scene.add(tank.opaque, swimmers.batch.group);
stage.transparent.add(volume.mesh, surface.mesh, tank.glass, swimmers.ring);

fluid.source = () => ({
  count: swimmers.count,
  expectedLitres: swimmers.totalReleased,
  fill: (out) => swimmers.fillSolverState(out),
});
fluid.onFrame = (frame) => {
  volume.setDensity(frame.density, frame.nx, frame.ny, frame.nz);
  swimmers.applySolverResults(frame.exposure, frame.escape);
};

function resetWater() {
  swimmers.resetWater();
  volume.clear();
  fluid.configure(dims.width, dims.depth, dims.length);
}

function configure(snap: boolean) {
  ripples.configure(dims);
  tank.configure(dims);
  surface.configure(dims);
  volume.configure(dims);
  swimmers.configure(dims);
  fluid.configure(dims.width, dims.depth, dims.length);
  stage.configure(dims, snap);
  ui.setCount(swimmers.count, swimmers.capacity);
}

function layout() {
  const shift = ui.viewShift();
  stage.setViewShift(shift.x, shift.y);
  stage.resize();
}

layout();
configure(true);
for (let i = 0; i < DEFAULT_SWIMMERS; i++) swimmers.add(true);
ui.setCount(swimmers.count, swimmers.capacity);

window.addEventListener('resize', () => {
  layout();
  stage.configure(dims, false);
});

// --- Pointer: click a swimmer to select, drag to move, otherwise orbit -------

const ndc = new THREE.Vector2();
function toNdc(ev: PointerEvent) {
  const rect = canvas.getBoundingClientRect();
  ndc.set(((ev.clientX - rect.left) / rect.width) * 2 - 1, -((ev.clientY - rect.top) / rect.height) * 2 + 1);
  return ndc;
}

const DRAG_THRESHOLD = 6; // px
let activePointer = -1;
let pressed: Swimmer | null = null;
let pressX = 0;
let pressY = 0;
let moved = false;
let emptyPress: { x: number; y: number; id: number } | null = null;

canvas.addEventListener(
  'pointerdown',
  (ev) => {
    sound.unlock();
    if (ev.button !== 0 || activePointer !== -1) return;
    const hit = swimmers.pick(toNdc(ev), stage.camera, ev.pointerType !== 'mouse');
    if (!hit) {
      emptyPress = { x: ev.clientX, y: ev.clientY, id: ev.pointerId };
      return;
    }
    // Take the gesture away from the orbit controls.
    ev.stopImmediatePropagation();
    ev.preventDefault();
    activePointer = ev.pointerId;
    canvas.setPointerCapture(ev.pointerId);
    stage.controls.enabled = false;
    pressed = hit;
    pressX = ev.clientX;
    pressY = ev.clientY;
    moved = false;
  },
  { capture: true },
);

canvas.addEventListener('pointermove', (ev) => {
  if (ev.pointerId === activePointer && pressed) {
    if (!moved && Math.hypot(ev.clientX - pressX, ev.clientY - pressY) > DRAG_THRESHOLD) {
      moved = true;
      swimmers.beginDrag(pressed, toNdc(ev), stage.camera);
      canvas.style.cursor = 'grabbing';
    }
    if (moved) swimmers.drag(toNdc(ev), stage.camera);
    return;
  }
  if (ev.pointerType === 'mouse' && activePointer === -1) {
    swimmers.hovered = ev.buttons === 0 ? swimmers.pick(toNdc(ev), stage.camera, false) : null;
    canvas.style.cursor = swimmers.hovered ? 'pointer' : '';
  }
});

function endPress(ev: PointerEvent, cancelled: boolean) {
  if (emptyPress && ev.pointerId === emptyPress.id) {
    // A click on empty water (not an orbit drag) closes the card.
    if (!cancelled && Math.hypot(ev.clientX - emptyPress.x, ev.clientY - emptyPress.y) < DRAG_THRESHOLD) {
      swimmers.selected = null;
    }
    emptyPress = null;
  }
  if (ev.pointerId !== activePointer) return;
  activePointer = -1;
  if (canvas.hasPointerCapture(ev.pointerId)) canvas.releasePointerCapture(ev.pointerId);
  if (moved) swimmers.endDrag();
  else if (pressed && !cancelled) {
    swimmers.selected = swimmers.selected === pressed ? null : pressed;
    sound.tick();
  }
  pressed = null;
  stage.controls.enabled = true;
  canvas.style.cursor = '';
}
canvas.addEventListener('pointerup', (ev) => endPress(ev, false));
canvas.addEventListener('pointercancel', (ev) => endPress(ev, true));
canvas.addEventListener('pointerleave', () => {
  if (activePointer === -1) swimmers.hovered = null;
});

window.addEventListener('keydown', (ev) => {
  if (ev.code === 'Space' && !(ev.target instanceof HTMLButtonElement) && !(ev.target instanceof HTMLInputElement)) {
    ev.preventDefault();
    (document.getElementById('pee') as HTMLButtonElement).click();
  }
  if (ev.code === 'Escape') swimmers.selected = null;
});

// --- Main loop -------------------------------------------------------------

let last = performance.now();
let time = 0;
let cardShown = false;

function frame(now: number) {
  const dt = Math.min(0.1, Math.max(0.001, (now - last) / 1000));
  last = now;
  time += dt;

  swimmers.update(dt, time);
  ripples.update(dt);
  fluid.update(dt);

  const peeing = swimmers.peeingCount;
  if (releasing && swimmers.count === 0) releasing = false;
  sound.update(dt, peeing, swimmers.commotion);

  // Well-mixed concentration in a pool that overflows as liquid is added.
  const tankLitres = dims.width * dims.length * dims.depth * 1000;
  const ppm = (1 - Math.exp(-swimmers.totalReleased / tankLitres)) * 1e6;
  ui.setReadout(ppm, swimmers.totalReleased, peeing, swimmers.count);
  ui.setRelease(releasing, swimmers.count);
  ui.setCard(swimmers.selected);
  if ((swimmers.selected !== null) !== cardShown) {
    cardShown = swimmers.selected !== null;
    if (ui.isSheet) layout();
  }

  stage.update();
  tank.update(time);
  surface.update(time);
  volume.update(stage.camera, stage.sceneColor, stage.sceneDepth, stage.resolution, time);
  stage.render();
  const portrait = swimmers.selected ? ui.portraitRect() : null;
  if (portrait && swimmers.selected) stage.renderPortrait(portrait, swimmers.selected.headMatrix);
  ui.updateLabels(stage, tank, dims);

  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

document.addEventListener('visibilitychange', () => {
  last = performance.now();
});

// Handy for debugging in the console.
Object.assign(window, { __sim: { stage, swimmers, fluid, ui, quality } });
