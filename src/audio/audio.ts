// Fully synthesized sound: motors whose pitch follows real RPM, rotor wash,
// wind over the airframe, spray hiss, impacts and UI ticks. No audio files.

export class Audio {
  ctx: AudioContext | null = null;
  master!: GainNode;
  private motor: { osc: OscillatorNode; osc2: OscillatorNode; gain: GainNode; filt: BiquadFilterNode } | null = null;
  private wash!: { src: AudioBufferSourceNode; gain: GainNode; filt: BiquadFilterNode };
  private wind!: { src: AudioBufferSourceNode; gain: GainNode; filt: BiquadFilterNode };
  private spray!: { src: AudioBufferSourceNode; gain: GainNode; filt: BiquadFilterNode };
  private noise!: AudioBuffer;
  volume = 0.7;
  muted = false;

  /** must be called from a user gesture */
  start() {
    if (this.ctx) { this.ctx.resume(); return; }
    const AC = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (!AC) return;
    const ctx = this.ctx = new AC();
    this.master = ctx.createGain();
    this.master.gain.value = this.volume;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -14; comp.ratio.value = 4;
    this.master.connect(comp).connect(ctx.destination);
    const len = ctx.sampleRate * 2;
    this.noise = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = this.noise.getChannelData(0);
    let b = 0;
    for (let i = 0; i < len; i++) { const w = Math.random() * 2 - 1; b = 0.97 * b + 0.03 * w; d[i] = w * 0.6 + b * 2.5; }
    const loop = (type: BiquadFilterType, f: number) => {
      const src = ctx.createBufferSource(); src.buffer = this.noise; src.loop = true;
      const filt = ctx.createBiquadFilter(); filt.type = type; filt.frequency.value = f;
      const gain = ctx.createGain(); gain.gain.value = 0;
      src.connect(filt).connect(gain).connect(this.master);
      src.start();
      return { src, gain, filt };
    };
    this.wash = loop('bandpass', 400);
    this.wind = loop('lowpass', 500);
    this.spray = loop('highpass', 2500);
    const osc = ctx.createOscillator(); osc.type = 'sawtooth';
    const osc2 = ctx.createOscillator(); osc2.type = 'square';
    const filt = ctx.createBiquadFilter(); filt.type = 'lowpass'; filt.frequency.value = 1800; filt.Q.value = 2;
    const gain = ctx.createGain(); gain.gain.value = 0;
    const g2 = ctx.createGain(); g2.gain.value = 0.25;
    osc.connect(filt); osc2.connect(g2).connect(filt);
    filt.connect(gain).connect(this.master);
    osc.start(); osc2.start();
    this.motor = { osc, osc2, gain, filt };
  }

  setVolume(v: number) { this.volume = v; if (this.master) this.master.gain.value = this.muted ? 0 : v; }

  /**
   * rpmFrac 0..1 average motor speed, load 0..1 average thrust fraction,
   * size = prop diameter in metres (big props are deep and slow)
   */
  update(rpmFrac: number, load: number, size: number, blades: number, airspeed: number, spraying: boolean, distance: number) {
    if (!this.ctx || !this.motor) return;
    const t = this.ctx.currentTime;
    const maxRpm = Math.min(32000, 2400 / Math.max(0.05, size) * 1.6);
    const bpf = Math.max(20, rpmFrac * maxRpm / 60 * blades);
    const att = 1 / (1 + distance * distance * 0.004);
    this.motor.osc.frequency.setTargetAtTime(bpf, t, 0.03);
    this.motor.osc2.frequency.setTargetAtTime(bpf * 2.01, t, 0.03);
    this.motor.filt.frequency.setTargetAtTime(600 + rpmFrac * 4500 * Math.min(1, 0.25 / size + 0.3), t, 0.05);
    const on = rpmFrac > 0.02 ? 1 : 0;
    this.motor.gain.gain.setTargetAtTime(on * (0.05 + load * 0.16) * att, t, 0.05);
    this.wash.filt.frequency.setTargetAtTime(150 + rpmFrac * 900 * Math.min(1.5, 0.3 / size + 0.4), t, 0.05);
    this.wash.gain.gain.setTargetAtTime(on * (0.04 + load * 0.25) * att * Math.min(1.6, size * 2 + 0.4), t, 0.05);
    this.wind.gain.gain.setTargetAtTime(Math.min(0.35, airspeed * airspeed * 0.0009), t, 0.1);
    this.wind.filt.frequency.setTargetAtTime(300 + airspeed * 40, t, 0.1);
    this.spray.gain.gain.setTargetAtTime(spraying ? 0.14 * att : 0, t, 0.06);
  }

  silence() {
    if (!this.ctx || !this.motor) return;
    const t = this.ctx.currentTime;
    for (const g of [this.motor.gain, this.wash.gain, this.wind.gain, this.spray.gain]) g.gain.setTargetAtTime(0, t, 0.08);
  }

  private env(build: (ctx: AudioContext, out: GainNode) => void, dur: number, vol: number) {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const g = ctx.createGain();
    g.gain.setValueAtTime(vol, ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + dur);
    g.connect(this.master);
    build(ctx, g);
  }

  impact(strength: number) {
    this.env((ctx, out) => {
      const src = ctx.createBufferSource(); src.buffer = this.noise;
      const f = ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = 300 + strength * 200;
      src.connect(f).connect(out); src.start(); src.stop(ctx.currentTime + 0.4);
      const o = ctx.createOscillator(); o.frequency.setValueAtTime(110, ctx.currentTime); o.frequency.exponentialRampToValueAtTime(40, ctx.currentTime + 0.2);
      o.connect(out); o.start(); o.stop(ctx.currentTime + 0.25);
    }, 0.35, Math.min(0.8, 0.1 + strength * 0.08));
  }

  crash() {
    this.impact(8);
    this.env((ctx, out) => {
      const src = ctx.createBufferSource(); src.buffer = this.noise;
      const f = ctx.createBiquadFilter(); f.type = 'bandpass'; f.frequency.value = 3000; f.Q.value = 0.6;
      src.connect(f).connect(out); src.start(); src.stop(ctx.currentTime + 0.6);
    }, 0.5, 0.35);
  }

  chime(step = 0) {
    this.env((ctx, out) => {
      const base = 660 * Math.pow(2, (step % 8) / 12);
      for (const [mul, delay] of [[1, 0], [1.5, 0.06]]) {
        const o = ctx.createOscillator(); o.type = 'sine';
        o.frequency.value = base * mul;
        o.connect(out); o.start(ctx.currentTime + delay); o.stop(ctx.currentTime + 0.5);
      }
    }, 0.5, 0.18);
  }

  success() {
    if (!this.ctx) return;
    [0, 4, 7, 12].forEach((s, i) => setTimeout(() => this.chime(s), i * 110));
  }

  tick() {
    this.env((ctx, out) => {
      const o = ctx.createOscillator(); o.type = 'triangle'; o.frequency.value = 1400;
      o.connect(out); o.start(); o.stop(ctx.currentTime + 0.05);
    }, 0.05, 0.06);
  }

  warn() {
    this.env((ctx, out) => {
      const o = ctx.createOscillator(); o.type = 'square'; o.frequency.value = 880;
      o.connect(out); o.start(); o.stop(ctx.currentTime + 0.12);
    }, 0.14, 0.05);
  }
}

export const audio = new Audio();
