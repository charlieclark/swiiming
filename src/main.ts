import * as THREE from 'three';
import { Sound } from './audio';
import { DEFAULT_SUBJECTS, DEFAULT_TANK, detectQuality, type TankDims } from './config';
import { Stage } from './scene/stage';
import { Tank } from './scene/tank';
import { FluidClient } from './sim/client';
import { SwimmerManager } from './swimmers/manager';
import type { Swimmer } from './swimmers/swimmer';
import { formatConcentration, UI } from './ui/ui';
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
let elapsed = 0;
let eventCount = 0;
let eventTotal = 0; // litres expected from the release in progress
let eventStartReleased = 0;
let wasVoiding = false;

const subjectName = (s: Swimmer) => `S-${String(s.id).padStart(2, '0')}`;

const swimmers = new SwimmerManager(ripples, {
  onVoidComplete: (s, litres) => ui.log(elapsed, `${subjectName(s)} voiding complete. ${litres.toFixed(2)} L.`),
  onExposed: (s) => {
    const c = formatConcentration(s.exposure * 1000);
    ui.log(elapsed, `${subjectName(s)} exposure threshold exceeded (${c.value} ${c.unit} local).`, true);
    sound.alert();
  },
  onResigned: (s) => ui.log(elapsed, `${subjectName(s)} no longer reacting. Classified: resigned.`),
  onSplash: (strength) => sound.splash(strength),
});

const ui = new UI(
  {
    onDims: (next) => {
      const hadAnalyte = swimmers.totalReleased > 0;
      dims = next;
      configure(false);
      if (hadAnalyte && !reconfigLogged) {
        ui.log(elapsed, 'Tank reconfigured. Water replaced.');
        reconfigLogged = true;
      }
    },
    onCount: (delta) => {
      sound.unlock();
      if (delta > 0) {
        const s = swimmers.add();
        if (s) ui.log(elapsed, `${subjectName(s)} entered the tank.`);
      } else {
        const s = swimmers.remove();
        if (s) ui.log(elapsed, `${subjectName(s)} withdrawn from the study.`);
      }
      sound.tick();
      ui.setCount(swimmers.count);
    },
    onPee: () => {
      sound.unlock();
      if (swimmers.count === 0 || swimmers.anyVoiding) return;
      swimmers.voidAll();
      eventCount++;
      eventStartReleased = swimmers.totalReleased;
      eventTotal = swimmers.swimmers.reduce((sum, s) => sum + s.remaining, 0);
      reconfigLogged = false;
      ui.log(elapsed, `Release event ${eventCount} initiated. n = ${swimmers.count}.`);
      sound.initiate();
    },
    onDrain: () => {
      sound.unlock();
      resetWater();
      ui.log(elapsed, 'Tank drained and refilled. Counters reset.');
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
  },
  dims,
);
let reconfigLogged = false;

stage.scene.add(tank.opaque, swimmers.group);
stage.transparent.add(volume.mesh, surface.mesh, tank.glass, swimmers.ring);

fluid.source = () => ({
  count: swimmers.count,
  expectedLitres: swimmers.totalReleased,
  fill: (out) => swimmers.fillSolverState(out),
});
fluid.onFrame = (frame) => {
  volume.setDensity(frame.density, frame.nx, frame.ny, frame.nz);
  swimmers.applyExposure(frame.exposure);
};

function resetWater() {
  swimmers.resetWater();
  volume.clear();
  fluid.configure(dims.width, dims.depth, dims.length);
  elapsed = 0;
  eventCount = 0;
  eventTotal = 0;
  wasVoiding = false;
}

function configure(snap: boolean) {
  ripples.configure(dims);
  tank.configure(dims);
  surface.configure(dims);
  volume.configure(dims);
  swimmers.configure(dims);
  swimmers.resetWater();
  wasVoiding = false;
  fluid.configure(dims.width, dims.depth, dims.length);
  stage.configure(dims, snap);
  eventCount = 0;
  eventTotal = 0;
}

function layout() {
  const shift = ui.viewShift();
  stage.setViewShift(shift.x, shift.y);
  stage.resize();
}

layout();
configure(true);
for (let i = 0; i < DEFAULT_SUBJECTS; i++) swimmers.add(true);
ui.setCount(swimmers.count);
ui.log(0, `Tank filled. ${Math.round(dims.width * dims.length * dims.depth * 1000).toLocaleString('en-US')} L.`);

window.addEventListener('resize', () => {
  layout();
  stage.configure(dims, false);
});

// --- Pointer: drag subjects, otherwise orbit --------------------------------

const ndc = new THREE.Vector2();
function toNdc(ev: PointerEvent) {
  const rect = canvas.getBoundingClientRect();
  ndc.set(((ev.clientX - rect.left) / rect.width) * 2 - 1, -((ev.clientY - rect.top) / rect.height) * 2 + 1);
  return ndc;
}

let activePointer = -1;

canvas.addEventListener(
  'pointerdown',
  (ev) => {
    sound.unlock();
    if (ev.button !== 0 || activePointer !== -1) return;
    const hit = swimmers.pick(toNdc(ev), stage.camera, ev.pointerType !== 'mouse');
    if (!hit) return;
    // Take the gesture away from the orbit controls.
    ev.stopImmediatePropagation();
    ev.preventDefault();
    activePointer = ev.pointerId;
    canvas.setPointerCapture(ev.pointerId);
    stage.controls.enabled = false;
    swimmers.beginDrag(hit, ndc, stage.camera);
    canvas.style.cursor = 'grabbing';
  },
  { capture: true },
);

canvas.addEventListener('pointermove', (ev) => {
  if (ev.pointerId === activePointer) {
    swimmers.drag(toNdc(ev), stage.camera);
    return;
  }
  if (ev.pointerType === 'mouse' && activePointer === -1) {
    swimmers.hovered = ev.buttons === 0 ? swimmers.pick(toNdc(ev), stage.camera, false) : null;
    canvas.style.cursor = swimmers.hovered ? 'grab' : '';
  }
});

function endDrag(ev: PointerEvent) {
  if (ev.pointerId !== activePointer) return;
  activePointer = -1;
  if (canvas.hasPointerCapture(ev.pointerId)) canvas.releasePointerCapture(ev.pointerId);
  swimmers.endDrag();
  stage.controls.enabled = true;
  canvas.style.cursor = '';
}
canvas.addEventListener('pointerup', endDrag);
canvas.addEventListener('pointercancel', endDrag);
canvas.addEventListener('pointerleave', () => {
  if (activePointer === -1) swimmers.hovered = null;
});

window.addEventListener('keydown', (ev) => {
  if (ev.code === 'Space' && !(ev.target instanceof HTMLButtonElement) && !(ev.target instanceof HTMLInputElement)) {
    ev.preventDefault();
    (document.getElementById('pee') as HTMLButtonElement).click();
  }
});

// --- Main loop -------------------------------------------------------------

let last = performance.now();
let time = 0;

function frame(now: number) {
  const dt = Math.min(0.1, Math.max(0.001, (now - last) / 1000));
  last = now;
  time += dt;
  elapsed += dt;

  swimmers.update(dt, time);
  ripples.update(dt);
  fluid.update(dt);

  const voiding = swimmers.anyVoiding;
  if (wasVoiding && !voiding && eventCount > 0) {
    const litres = swimmers.totalReleased - eventStartReleased;
    ui.log(elapsed, `Release event ${eventCount} complete. ${litres.toFixed(2)} L total.`);
    sound.confirm();
  }
  wasVoiding = voiding;
  const voidingCount = voiding ? swimmers.swimmers.filter((s) => s.voiding).length : 0;
  sound.update(dt, voidingCount);

  const litresInTank = dims.width * dims.length * dims.depth * 1000;
  const ppm = (swimmers.totalReleased / litresInTank) * 1e6;
  ui.setReadout(ppm, swimmers.totalReleased, eventCount, elapsed);
  const progress = eventTotal > 0 ? (swimmers.totalReleased - eventStartReleased) / eventTotal : 0;
  ui.setPeeState(swimmers.count, voiding, Math.min(1, progress));

  stage.update();
  tank.update(time);
  surface.update(time);
  volume.update(stage.camera, stage.sceneColor, stage.sceneDepth, stage.resolution, time);
  stage.render();
  ui.updateLabels(swimmers.swimmers, stage, tank, dims);

  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

document.addEventListener('visibilitychange', () => {
  last = performance.now();
});

// Handy for debugging in the console.
Object.assign(window, { __sim: { stage, swimmers, fluid, ui, quality } });
