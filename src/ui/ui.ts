import * as THREE from 'three';
import { LIMITS, REFERENCE_PPM, type TankDims } from '../config';
import type { Stage } from '../scene/stage';
import type { Tank } from '../scene/tank';
import type { Swimmer } from '../swimmers/swimmer';

export interface UICallbacks {
  onDims(dims: TankDims): void;
  onCount(n: number): void;
  onPee(): void;
  onDrain(): void;
  onSound(on: boolean): void;
  onLayout(): void;
}

const METER_MIN = 0.1; // ppm
const METER_DECADES = 6;

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

export function formatConcentration(ppm: number): { value: string; unit: string } {
  if (ppm >= 10000) return { value: (ppm / 10000).toFixed(ppm >= 100000 ? 1 : 2), unit: '%' };
  if (ppm >= 100) return { value: Math.round(ppm).toLocaleString('en-US'), unit: 'ppm' };
  if (ppm >= 10) return { value: ppm.toFixed(1), unit: 'ppm' };
  return { value: ppm.toFixed(2), unit: 'ppm' };
}

export function assess(ppm: number): string {
  if (ppm <= 0) return 'Baseline. No analyte detected.';
  if (ppm < 5) return 'Trace. Below the threshold of suspicion.';
  if (ppm < 55) return 'Below a typical public pool.';
  if (ppm < 150) return 'Comparable to a typical public pool.';
  if (ppm < 1000) return 'Exceeds a typical public pool.';
  if (ppm < 10000) return 'Swimming not advised.';
  if (ppm < 250000) return 'No longer meaningfully a pool.';
  return 'Reclassify tank as specimen container.';
}

export function formatClock(seconds: number) {
  const s = Math.max(0, Math.floor(seconds));
  const m = Math.floor(s / 60);
  return `${String(m).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

interface Tag {
  el: HTMLDivElement;
  id: HTMLElement;
  status: HTMLElement;
  text: string;
}

export class UI {
  private dims: TankDims;
  private tags = new Map<number, Tag>();
  private dimLabels: Record<'width' | 'length' | 'depth', HTMLDivElement>;
  private labels = $('labels');
  private panel = $('panel');
  private pee = $<HTMLButtonElement>('pee');
  private peeText = this.pee.querySelector('.text') as HTMLElement;
  private peeFill = this.pee.querySelector('.fill') as HTMLElement;
  private peeSub = $('pee-sub');
  private logEl = $('log');
  private soundOn = true;
  private tmp = new THREE.Vector3();
  private screen = { x: 0, y: 0 };
  private last = { ppm: '', released: '', events: '', elapsed: '', assess: '', pee: '' };

  constructor(
    private cb: UICallbacks,
    dims: TankDims,
  ) {
    this.dims = { ...dims };

    const bindDim = (key: keyof TankDims) => {
      const input = $<HTMLInputElement>(`dim-${key}`);
      const out = $(`out-${key}`);
      const lim = LIMITS[key];
      input.min = String(lim.min);
      input.max = String(lim.max);
      input.step = String(lim.step);
      input.value = String(this.dims[key]);
      const show = () => (out.textContent = `${this.dims[key].toFixed(1)} m`);
      show();
      input.addEventListener('input', () => {
        this.dims[key] = Number(input.value);
        show();
        this.showVolume();
        this.cb.onDims({ ...this.dims });
      });
    };
    bindDim('width');
    bindDim('length');
    bindDim('depth');
    this.showVolume();

    $('sub-minus').addEventListener('click', () => this.cb.onCount(-1));
    $('sub-plus').addEventListener('click', () => this.cb.onCount(1));
    this.pee.addEventListener('click', () => this.cb.onPee());
    $('drain').addEventListener('click', () => this.cb.onDrain());
    const sound = $('sound');
    sound.addEventListener('click', () => {
      this.soundOn = !this.soundOn;
      sound.textContent = this.soundOn ? 'Sound on' : 'Sound off';
      sound.setAttribute('aria-pressed', String(this.soundOn));
      this.cb.onSound(this.soundOn);
    });

    const toggle = $('sheet-toggle');
    toggle.addEventListener('click', () => {
      const collapsed = this.panel.classList.toggle('collapsed');
      toggle.setAttribute('aria-expanded', String(!collapsed));
      toggle.querySelector('.chev')!.textContent = collapsed ? 'Parameters' : 'Close';
      document.body.classList.toggle('sheet-open', !collapsed && this.isSheet);
      this.cb.onLayout();
    });

    $('meter-ref').style.left = `${this.meterFraction(REFERENCE_PPM) * 100}%`;

    const mk = () => {
      const el = document.createElement('div');
      el.className = 'dim';
      this.labels.appendChild(el);
      return el;
    };
    this.dimLabels = { width: mk(), length: mk(), depth: mk() };
  }

  /** True when the panel is laid out as a bottom sheet (small screens). */
  get isSheet() {
    return window.matchMedia('(max-width: 760px)').matches;
  }

  /** How far the 3D view should shift so the tank sits in the uncovered area. */
  viewShift() {
    if (this.isSheet) {
      // Keep the tank in the area above the sheet (and above the button when collapsed).
      const open = !this.panel.classList.contains('collapsed');
      return { x: 0, y: open ? -this.panel.offsetHeight / 2 : -70 };
    }
    return { x: (this.panel.offsetWidth + 16) / 2, y: -26 };
  }

  private meterFraction(ppm: number) {
    if (ppm <= METER_MIN) return 0;
    return Math.min(1, Math.log10(ppm / METER_MIN) / METER_DECADES);
  }

  private showVolume() {
    const litres = this.dims.width * this.dims.length * this.dims.depth * 1000;
    $('volume').textContent = `${Math.round(litres).toLocaleString('en-US')} L`;
  }

  setCount(n: number) {
    $('sub-count').textContent = String(n);
    $<HTMLButtonElement>('sub-minus').disabled = n <= LIMITS.subjects.min;
    $<HTMLButtonElement>('sub-plus').disabled = n >= LIMITS.subjects.max;
  }

  setReadout(ppm: number, releasedLitres: number, events: number, elapsed: number) {
    const c = formatConcentration(ppm);
    const key = c.value + c.unit;
    if (key !== this.last.ppm) {
      this.last.ppm = key;
      $('ppm').textContent = c.value;
      $('ppm-unit').textContent = c.unit;
      $('summary-ppm').textContent = `${c.value} ${c.unit}`;
      $('meter-fill').style.width = `${this.meterFraction(ppm) * 100}%`;
    }
    const a = assess(ppm);
    if (a !== this.last.assess) {
      this.last.assess = a;
      $('assessment').textContent = a;
      $('summary-text').textContent = a;
    }
    const r = `${releasedLitres.toFixed(2)} L`;
    if (r !== this.last.released) $('released').textContent = this.last.released = r;
    const e = String(events);
    if (e !== this.last.events) $('events').textContent = this.last.events = e;
    const t = formatClock(elapsed);
    if (t !== this.last.elapsed) $('elapsed').textContent = this.last.elapsed = t;
  }

  /** progress: 0..1 while a release is under way, otherwise ignored. */
  setPeeState(count: number, voiding: boolean, progress: number) {
    const key = `${count}:${voiding}`;
    if (voiding) this.peeFill.style.transform = `scaleX(${progress.toFixed(3)})`;
    if (key === this.last.pee) return;
    this.last.pee = key;
    this.pee.classList.toggle('busy', voiding);
    this.pee.classList.toggle('empty', count === 0);
    this.pee.disabled = voiding || count === 0;
    if (!voiding) this.peeFill.style.transform = 'scaleX(0)';
    this.peeText.textContent = voiding ? 'VOIDING' : 'PEE';
    this.peeSub.textContent =
      count === 0
        ? 'No subjects in tank'
        : voiding
          ? 'Release in progress'
          : `Initiate simultaneous release (n = ${count})`;
  }

  log(elapsed: number, text: string, warn = false) {
    const li = document.createElement('li');
    if (warn) li.className = 'warn';
    const time = document.createElement('time');
    time.textContent = `T+${formatClock(elapsed)}`;
    li.append(time, text);
    this.logEl.appendChild(li);
    while (this.logEl.children.length > 8) this.logEl.firstElementChild!.remove();
  }

  /** Position the floating subject tags and dimension labels. */
  updateLabels(swimmers: Swimmer[], stage: Stage, tank: Tank, dims: TankDims) {
    const seen = new Set<number>();
    for (const s of swimmers) {
      seen.add(s.id);
      let tag = this.tags.get(s.id);
      if (!tag) {
        const el = document.createElement('div');
        el.className = 'tag';
        const id = document.createElement('b');
        id.textContent = `S-${String(s.id).padStart(2, '0')}`;
        const status = document.createElement('span');
        el.append(id, status);
        this.labels.appendChild(el);
        tag = { el, id, status, text: '' };
        this.tags.set(s.id, tag);
      }
      let text: string;
      switch (s.state) {
        case 'voiding':
          text = 'VOIDING';
          break;
        case 'exposed':
          text = `EXPOSED ${Math.round(s.exposure * 1000)} ppm`;
          break;
        case 'resigned':
          text = 'RESIGNED';
          break;
        default:
          text = 'NOMINAL';
      }
      if (text !== tag.text) {
        tag.text = text;
        tag.status.textContent = text;
        tag.el.dataset.state = s.state;
      }
      const visible = stage.project(s.labelAnchor(this.tmp), this.screen) && s.spawn > 0.6;
      tag.el.style.opacity = visible ? '1' : '0';
      tag.el.style.transform = `translate(${this.screen.x.toFixed(1)}px, ${this.screen.y.toFixed(1)}px) translate(-50%, -100%) translateY(-9px)`;
    }
    for (const [id, tag] of this.tags) {
      if (!seen.has(id)) {
        tag.el.remove();
        this.tags.delete(id);
      }
    }

    (['width', 'length', 'depth'] as const).forEach((key) => {
      const el = this.dimLabels[key];
      const visible = stage.project(tank.anchors[key], this.screen);
      const text = `${dims[key].toFixed(1)} m`;
      if (el.textContent !== text) el.textContent = text;
      el.style.opacity = visible ? '1' : '0';
      el.style.transform = `translate(${this.screen.x.toFixed(1)}px, ${this.screen.y.toFixed(1)}px) translate(-50%, -50%)`;
    });
  }
}
