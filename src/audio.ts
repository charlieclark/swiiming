/** Synthesised sound: no audio assets. Everything hangs off one master gain. */
export class Sound {
  enabled = true;
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private noise: AudioBuffer | null = null;
  private streamGain: GainNode | null = null;
  private streamLevel = 0;
  private bubbleTimer = 0;

  /** Must be called from a user gesture. Safe to call repeatedly. */
  unlock() {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') void this.ctx.resume();
      return;
    }
    const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return;
    const ctx = new Ctor();
    this.ctx = ctx;
    this.master = ctx.createGain();
    this.master.gain.value = this.enabled ? 0.9 : 0;
    this.master.connect(ctx.destination);

    const len = ctx.sampleRate * 2;
    this.noise = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = this.noise.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;

    // Room tone: the hum and slosh of an indoor tank.
    const room = this.loop();
    const roomFilter = ctx.createBiquadFilter();
    roomFilter.type = 'lowpass';
    roomFilter.frequency.value = 320;
    const roomGain = ctx.createGain();
    roomGain.gain.value = 0.05;
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 0.23;
    const lfoGain = ctx.createGain();
    lfoGain.gain.value = 0.02;
    lfo.connect(lfoGain).connect(roomGain.gain);
    lfo.start();
    room.connect(roomFilter).connect(roomGain).connect(this.master);

    // Release: a soft, steady hiss, as heard through a hydrophone.
    const stream = this.loop();
    const streamFilter = ctx.createBiquadFilter();
    streamFilter.type = 'bandpass';
    streamFilter.frequency.value = 1500;
    streamFilter.Q.value = 0.7;
    this.streamGain = ctx.createGain();
    this.streamGain.gain.value = 0;
    stream.connect(streamFilter).connect(this.streamGain).connect(this.master);
  }

  private loop() {
    const src = this.ctx!.createBufferSource();
    src.buffer = this.noise;
    src.loop = true;
    src.start(0, Math.random() * 2);
    return src;
  }

  setEnabled(on: boolean) {
    this.enabled = on;
    if (this.master && this.ctx) this.master.gain.setTargetAtTime(on ? 0.9 : 0, this.ctx.currentTime, 0.05);
  }

  /** Call every frame with the number of subjects currently voiding. */
  update(dt: number, voiding: number) {
    if (!this.ctx || !this.streamGain) return;
    const target = voiding > 0 ? 0.035 + 0.012 * Math.min(8, voiding) : 0;
    this.streamLevel += (target - this.streamLevel) * Math.min(1, dt * 4);
    this.streamGain.gain.value = this.streamLevel;
    if (voiding > 0) {
      this.bubbleTimer -= dt;
      if (this.bubbleTimer <= 0) {
        this.bubbleTimer = (0.08 + Math.random() * 0.4) / Math.sqrt(voiding);
        this.bubble();
      }
    }
  }

  private tone(freq: number, endFreq: number, duration: number, gain: number, type: OscillatorType = 'sine', delay = 0) {
    if (!this.ctx || !this.master) return;
    const t = this.ctx.currentTime + delay;
    const osc = this.ctx.createOscillator();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t);
    osc.frequency.exponentialRampToValueAtTime(Math.max(20, endFreq), t + duration);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(gain, t + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, t + duration);
    osc.connect(g).connect(this.master);
    osc.start(t);
    osc.stop(t + duration + 0.05);
  }

  private bubble() {
    const f = 280 + Math.random() * 520;
    this.tone(f, f * (1.5 + Math.random() * 0.6), 0.05 + Math.random() * 0.05, 0.035);
  }

  /** Instrument acknowledgement when a release is initiated. */
  initiate() {
    this.tone(160, 70, 0.22, 0.25, 'sine');
    this.tone(660, 660, 0.09, 0.05, 'sine', 0.02);
  }

  /** Two-note alert when a subject crosses the exposure threshold. */
  alert() {
    this.tone(880, 880, 0.09, 0.05, 'triangle');
    this.tone(660, 660, 0.14, 0.05, 'triangle', 0.11);
  }

  /** Single soft confirmation tone. */
  confirm() {
    this.tone(520, 520, 0.12, 0.04, 'sine');
  }

  tick() {
    this.tone(1200, 900, 0.03, 0.03, 'square');
  }

  splash(strength: number) {
    if (!this.ctx || !this.master || !this.noise) return;
    const t = this.ctx.currentTime;
    const src = this.ctx.createBufferSource();
    src.buffer = this.noise;
    const filter = this.ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.Q.value = 0.9;
    filter.frequency.setValueAtTime(2600, t);
    filter.frequency.exponentialRampToValueAtTime(380, t + 0.45);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.22 * strength, t + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.6);
    src.connect(filter).connect(g).connect(this.master);
    src.start(t, Math.random());
    src.stop(t + 0.7);
    this.tone(140, 60, 0.18, 0.12 * strength, 'sine');
  }

  drain() {
    if (!this.ctx || !this.master || !this.noise) return;
    const t = this.ctx.currentTime;
    const src = this.ctx.createBufferSource();
    src.buffer = this.noise;
    const filter = this.ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.Q.value = 2.5;
    filter.frequency.setValueAtTime(1400, t);
    filter.frequency.exponentialRampToValueAtTime(180, t + 1.1);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.16, t + 0.1);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 1.2);
    src.connect(filter).connect(g).connect(this.master);
    src.start(t);
    src.stop(t + 1.3);
  }
}
