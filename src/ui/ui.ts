import { LIMITS, PRESETS, REFERENCE_PPM, type TankDims } from '../config';
import type { Stage } from '../scene/stage';
import type { Tank } from '../scene/tank';
import type { Swimmer } from '../swimmers/swimmer';

export interface UICallbacks {
  onDims(dims: TankDims): void;
  onCount(n: number): void;
  onRelease(): void;
  onSpeed(multiplier: number): void;
  onSpread(): void;
  onDrain(): void;
  onSound(on: boolean): void;
  onLayout(): void;
  onCardPee(): void;
  onCardClose(): void;
}

/** The meter is linear and runs from zero to this many times the public pool estimate. */
const METER_SPAN = 2;

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

export function formatConcentration(ppm: number): { value: string; unit: string } {
  if (ppm >= 10000) return { value: (ppm / 10000).toFixed(ppm >= 100000 ? 1 : 2), unit: '%' };
  if (ppm >= 100) return { value: Math.round(ppm).toLocaleString('en-US'), unit: 'ppm' };
  if (ppm >= 10) return { value: ppm.toFixed(1), unit: 'ppm' };
  return { value: ppm.toFixed(2), unit: 'ppm' };
}

/** A literal comparison with the public pool estimate. */
export function assess(ppm: number): string {
  if (ppm <= 0) return 'No urine in the pool.';
  const ratio = ppm / REFERENCE_PPM;
  if (ratio < 0.01) return 'Under 1% of a typical public pool.';
  if (ratio < 0.95) return `${Math.round(ratio * 100)}% of a typical public pool.`;
  if (ratio < 1.05) return 'About the same as a typical public pool.';
  if (ratio < 10) return `${ratio.toFixed(1)} times a typical public pool.`;
  return `${Math.round(ratio).toLocaleString('en-US')} times a typical public pool.`;
}

function formatLitres(litres: number) {
  if (litres >= 100) return `${Math.round(litres).toLocaleString('en-US')} L`;
  if (litres >= 10) return `${litres.toFixed(1)} L`;
  return `${litres.toFixed(2)} L`;
}

/** Seconds as m:ss, or h:mm:ss once past an hour. */
function formatDuration(seconds: number) {
  const s = Math.floor(seconds);
  const pad = (n: number) => String(n).padStart(2, '0');
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h > 0 ? `${h}:${pad(m)}:${pad(s % 60)}` : `${m}:${pad(s % 60)}`;
}

/** Sets text only when it changed, to avoid needless layout work every frame. */
class Text {
  private last = '';
  constructor(private el: HTMLElement) {}
  set(value: string) {
    if (value === this.last) return;
    this.last = value;
    this.el.textContent = value;
  }
}

export class UI {
  private dims: TankDims;
  private dimLabels: Record<'width' | 'length' | 'depth', HTMLDivElement>;
  private labels = $('labels');
  private panel = $('panel');
  private pee = $<HTMLButtonElement>('pee');
  private peeText = new Text(this.pee.querySelector('.text') as HTMLElement);
  private countInput = $<HTMLInputElement>('count');
  private card = $('card');
  private portrait = $('portrait');
  private cardPee = $<HTMLButtonElement>('card-pee');
  private soundOn = true;
  private presetButtons: HTMLButtonElement[] = [];
  private screen = { x: 0, y: 0 };
  private text = {
    ppm: new Text($('ppm')),
    unit: new Text($('ppm-unit')),
    summary: new Text($('summary-ppm')),
    summaryText: new Text($('summary-text')),
    assess: new Text($('assessment')),
    released: new Text($('released')),
    peeing: new Text($('peeing')),
    count: new Text($('sub-count')),
    cap: new Text($('cap')),
    cardName: new Text($('card-name')),
    cardStatus: new Text($('card-status')),
    cardReleased: new Text($('card-released')),
    cardFlow: new Text($('card-flow')),
    cardTime: new Text($('card-time')),
    cardTimeLabel: new Text($('card-time-label')),
    cardLocal: new Text($('card-local')),
    cardHeight: new Text($('card-height')),
    cardPee: new Text(this.cardPee),
  };
  private lastMeter = -1;

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

    const presets = $('presets');
    for (const preset of PRESETS) {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = preset.label;
      button.addEventListener('click', () => {
        this.setDims(preset.dims);
        this.cb.onDims({ ...preset.dims });
      });
      presets.appendChild(button);
      this.presetButtons.push(button);
    }
    this.markPreset();

    this.countInput.addEventListener('input', () => this.cb.onCount(Number(this.countInput.value)));
    $('sub-minus').addEventListener('click', () => this.cb.onCount(Number(this.countInput.value) - 1));
    $('sub-plus').addEventListener('click', () => this.cb.onCount(Number(this.countInput.value) + 1));
    $('spread').addEventListener('click', () => this.cb.onSpread());
    this.pee.addEventListener('click', () => this.cb.onRelease());
    const speedButtons = Array.from(document.querySelectorAll<HTMLButtonElement>('#speed button'));
    for (const button of speedButtons) {
      button.addEventListener('click', () => {
        for (const other of speedButtons) {
          other.classList.toggle('on', other === button);
          other.setAttribute('aria-pressed', String(other === button));
        }
        this.cb.onSpeed(Number(button.dataset.speed));
      });
    }
    $('drain').addEventListener('click', () => this.cb.onDrain());
    const sound = $('sound');
    sound.addEventListener('click', () => {
      this.soundOn = !this.soundOn;
      sound.textContent = this.soundOn ? 'Sound on' : 'Sound off';
      sound.setAttribute('aria-pressed', String(this.soundOn));
      this.cb.onSound(this.soundOn);
    });
    this.cardPee.addEventListener('click', () => this.cb.onCardPee());
    $('card-close').addEventListener('click', () => this.cb.onCardClose());

    const toggle = $('sheet-toggle');
    toggle.addEventListener('click', () => {
      const collapsed = this.panel.classList.toggle('collapsed');
      toggle.setAttribute('aria-expanded', String(!collapsed));
      toggle.querySelector('.chev')!.textContent = collapsed ? 'Settings' : 'Close';
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

  /** How far the 3D view should shift so the pool sits in the uncovered area. */
  viewShift() {
    if (this.isSheet) {
      // Keep the pool in the area above the sheet (and above the button when collapsed).
      const open = !this.panel.classList.contains('collapsed');
      if (open) return { x: 0, y: -this.panel.offsetHeight / 2 };
      // With the swimmer card showing at the top, sit the pool lower so both are visible.
      return { x: 0, y: this.card.hidden ? -88 : 14 };
    }
    return { x: (this.panel.offsetWidth + 16) / 2, y: -40 };
  }

  private meterFraction(ppm: number) {
    return Math.max(0, Math.min(1, ppm / (REFERENCE_PPM * METER_SPAN)));
  }

  /** Highlight the preset that matches the current size, if any. */
  private markPreset() {
    PRESETS.forEach((preset, i) => {
      const match =
        preset.dims.width === this.dims.width &&
        preset.dims.length === this.dims.length &&
        preset.dims.depth === this.dims.depth;
      this.presetButtons[i]?.classList.toggle('on', match);
    });
  }

  private showVolume() {
    this.markPreset();
    const litres = this.dims.width * this.dims.length * this.dims.depth * 1000;
    $('volume').textContent = `${Math.round(litres).toLocaleString('en-US')} L`;
  }

  /** Reflect dimensions changed elsewhere (dragging the pool's edges) in the sliders. */
  setDims(dims: TankDims) {
    this.dims = { ...dims };
    for (const key of ['width', 'length', 'depth'] as const) {
      $<HTMLInputElement>(`dim-${key}`).value = String(dims[key]);
      $(`out-${key}`).textContent = `${dims[key].toFixed(1)} m`;
    }
    this.showVolume();
  }

  setCount(n: number, capacity: number) {
    this.text.count.set(String(n));
    this.text.cap.set(String(capacity));
    if (this.countInput.max !== String(capacity)) this.countInput.max = String(capacity);
    if (this.countInput.value !== String(n)) this.countInput.value = String(n);
    $<HTMLButtonElement>('sub-minus').disabled = n <= LIMITS.swimmers.min;
    $<HTMLButtonElement>('sub-plus').disabled = n >= capacity;
    $<HTMLButtonElement>('spread').disabled = n < 2;
  }

  setReadout(ppm: number, releasedLitres: number, peeing: number, count: number) {
    const c = formatConcentration(ppm);
    this.text.ppm.set(c.value);
    this.text.unit.set(c.unit);
    this.text.summary.set(`${c.value} ${c.unit}`);
    const fraction = Math.round(this.meterFraction(ppm) * 1000) / 10;
    if (fraction !== this.lastMeter) {
      this.lastMeter = fraction;
      $('meter-fill').style.width = `${fraction}%`;
    }
    const a = assess(ppm);
    this.text.assess.set(a);
    this.text.summaryText.set(a);
    this.text.released.set(formatLitres(releasedLitres));
    this.text.peeing.set(`${peeing} of ${count}`);
  }

  setRelease(active: boolean, count: number) {
    this.pee.classList.toggle('on', active);
    this.pee.disabled = count === 0;
    this.pee.setAttribute('aria-pressed', String(active));
    this.peeText.set(active ? 'Stop release' : 'Simultaneous release');
  }

  /** Show, update or hide the card for the selected swimmer. */
  setCard(s: Swimmer | null) {
    if (!s) {
      if (!this.card.hidden) this.card.hidden = true;
      return;
    }
    if (this.card.hidden) this.card.hidden = false;
    this.text.cardName.set(s.name);
    this.text.cardStatus.set(s.status);
    this.text.cardReleased.set(formatLitres(s.released));
    this.text.cardFlow.set(`${Math.round(s.flowNow * 1000)} mL/s`);
    this.text.cardTimeLabel.set(s.peeing || s.peeSeconds === 0 ? 'Peeing for' : 'Last pee');
    this.text.cardTime.set(formatDuration(s.peeSeconds));
    const local = formatConcentration(s.exposure * 1000);
    this.text.cardLocal.set(`${local.value} ${local.unit}`);
    this.text.cardHeight.set(`${s.heightM.toFixed(2)} m`);
    this.text.cardPee.set(s.peeing ? 'Stop peeing' : 'Pee');
    this.cardPee.classList.toggle('on', s.peeing);
  }

  /** Where on screen the swimmer's face should be drawn, or null if the card is hidden. */
  portraitRect() {
    if (this.card.hidden) return null;
    const rect = this.portrait.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0 ? rect : null;
  }

  /** Position the dimension labels. */
  updateLabels(stage: Stage, tank: Tank, dims: TankDims) {
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
