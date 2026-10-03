import type { RingKind, RoyaleSfx, TierId } from './contracts';
import { audio } from '../audio/audio';

// Royale sounds, all synthesized. They share the game's AudioContext (src/audio/audio.ts) and
// run through their own bus: bus gain, then a brick wall limiter, then the game's master and its
// compressor. Every call is a no op until the player's first gesture created the context.
//
// Mixing rules (ART.md 5):
// - voice caps per sound (PULSE 6 local plus 10 remote, hits 6, water loops 6, knockouts 4)
// - remote PULSE shots within 25 ms merge into one voice; each voice is scaled by 1/sqrt(active)
// - distance: gain 1 / (1 + (d / 18)^2), a low pass closes with distance, silent beyond 140 m
// - 12 to 50 drones firing at once never clip: the limiter sits at -3 dB with a fast attack

const TIER_PITCH: Record<TierId, number> = { spark: 1, bolt: 0.88, storm: 0.76, nova: 0.66 };
const PENTA = [0, 2, 4, 7, 9, 12, 14, 16, 19, 21, 24, 26, 28];

type Kind = 'pulseL' | 'pulseR' | 'hit' | 'emp' | 'ko' | 'ui';
const CAP: Record<Kind, number> = { pulseL: 6, pulseR: 10, hit: 6, emp: 4, ko: 4, ui: 6 };

interface Loop { src: AudioBufferSourceNode; filt: BiquadFilterNode; gain: GainNode; }

export class RoyaleSfxImpl implements RoyaleSfx {
  private ctx: AudioContext | null = null;
  private bus!: GainNode;
  private limiter!: DynamicsCompressorNode;
  private noise!: AudioBuffer;
  private crackleBuf!: AudioBuffer;
  private active: Record<Kind, number> = { pulseL: 0, pulseR: 0, hit: 0, emp: 0, ko: 0, ui: 0 };
  private lastRemotePulse = 0;
  private waters = new Map<string, Loop>();
  private crackle: Loop | null = null;
  private disposed = false;

  /** the shared context once audio is unlocked, with our bus built on first use */
  private ready(): AudioContext | null {
    if (this.disposed) return null;
    const ctx = audio.ctx;
    if (!ctx || !audio.master) return null;
    if (ctx !== this.ctx) {
      this.ctx = ctx;
      this.bus = ctx.createGain();
      this.bus.gain.value = 0.85;
      const lim = this.limiter = ctx.createDynamicsCompressor();
      lim.threshold.value = -3; lim.knee.value = 0; lim.ratio.value = 20; lim.attack.value = 0.002; lim.release.value = 0.12;
      this.bus.connect(lim).connect(audio.master);
      const len = Math.floor(ctx.sampleRate * 1.5);
      this.noise = ctx.createBuffer(1, len, ctx.sampleRate);
      const d = this.noise.getChannelData(0);
      for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
      // crackle: sparse sharp clicks over a thin hiss, the sound of the Static
      this.crackleBuf = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
      const c = this.crackleBuf.getChannelData(0);
      let env = 0;
      for (let i = 0; i < c.length; i++) {
        if (Math.random() < 0.0009) env = 0.6 + Math.random() * 0.4;
        env *= 0.9985;
        c[i] = (Math.random() * 2 - 1) * (0.06 + env * (Math.random() < 0.5 ? 1 : 0.3));
      }
    }
    return ctx;
  }

  private att(distance: number) { return 1 / (1 + (distance / 18) ** 2); }

  private take(k: Kind) {
    if (this.active[k] >= CAP[k]) return false;
    this.active[k]++;
    return true;
  }

  /** a voice: gain envelope into a distance low pass into the bus; released when its sources end */
  private voice(ctx: AudioContext, k: Kind, peak: number, dur: number, distance = 0, attack = 0.003) {
    const t = ctx.currentTime;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0002, peak), t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = Math.min(18000, 20000 / (1 + distance / 30));
    g.connect(lp).connect(this.bus);
    setTimeout(() => { this.active[k] = Math.max(0, this.active[k] - 1); try { lp.disconnect(); } catch { /* gone */ } }, (dur + 0.1) * 1000);
    return g;
  }

  private osc(ctx: AudioContext, out: AudioNode, type: OscillatorType, f0: number, f1: number, t0: number, dur: number, level = 1) {
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(f0, t0);
    if (f1 !== f0) o.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t0 + dur);
    let node: AudioNode = o;
    if (level !== 1) { const g = ctx.createGain(); g.gain.value = level; o.connect(g); node = g; }
    node.connect(out);
    o.start(t0); o.stop(t0 + dur + 0.02);
    return o;
  }

  private burst(ctx: AudioContext, out: AudioNode, type: BiquadFilterType, f0: number, f1: number, q: number, t0: number, dur: number, level = 1) {
    const s = ctx.createBufferSource();
    s.buffer = this.noise;
    s.playbackRate.value = 0.8 + Math.random() * 0.4;
    const f = ctx.createBiquadFilter();
    f.type = type; f.Q.value = q;
    f.frequency.setValueAtTime(f0, t0);
    if (f1 !== f0) f.frequency.exponentialRampToValueAtTime(f1, t0 + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(level, t0);
    g.gain.exponentialRampToValueAtTime(0.001, t0 + dur);
    s.connect(f).connect(g).connect(out);
    s.start(t0, Math.random() * 1.0); s.stop(t0 + dur + 0.02);
  }

  // ---------------------------------------------------------------- combat

  pulse(tier: TierId, local: boolean, distance: number) {
    const ctx = this.ready(); if (!ctx) return;
    if (!local && distance > 140) return;
    const now = ctx.currentTime;
    if (!local) { if (now - this.lastRemotePulse < 0.025) return; this.lastRemotePulse = now; }
    const k: Kind = local ? 'pulseL' : 'pulseR';
    if (!this.take(k)) return;
    const crowd = 1 / Math.sqrt(Math.max(1, this.active.pulseL + this.active.pulseR));
    const peak = (local ? 0.2 : 0.15 * this.att(distance)) * crowd;
    const out = this.voice(ctx, k, peak, 0.13, local ? 0 : distance, 0.002);
    const p = TIER_PITCH[tier] ?? 1;
    // a short energy zap: two detuned falling tones plus a bright tick
    this.osc(ctx, out, 'triangle', 1850 * p, 520 * p, now, 0.11);
    this.osc(ctx, out, 'square', 1862 * p * 0.5, 300 * p, now, 0.09, 0.35);
    this.burst(ctx, out, 'highpass', 4200, 4200, 0.7, now, 0.025, 0.6);
  }

  hit(onLocalPilot: boolean) {
    const ctx = this.ready(); if (!ctx) return;
    if (!this.take('hit')) return;
    const t = ctx.currentTime;
    if (onLocalPilot) {
      // you took a hit: a body thump and a crunch you feel
      const out = this.voice(ctx, 'hit', 0.42, 0.26);
      this.osc(ctx, out, 'sine', 130, 42, t, 0.22);
      this.burst(ctx, out, 'bandpass', 1300, 500, 0.9, t, 0.14, 0.9);
      this.osc(ctx, out, 'triangle', 2600, 2300, t, 0.05, 0.25);
    } else {
      // hit marker: a crisp confirmation tick
      const out = this.voice(ctx, 'hit', 0.16, 0.09);
      this.osc(ctx, out, 'triangle', 2450, 2350, t, 0.05);
      this.osc(ctx, out, 'sine', 3300, 2950, t + 0.012, 0.06, 0.6);
    }
  }

  water(owner: string, on: boolean, distance: number) {
    const ctx = this.ready(); if (!ctx) return;
    const t = ctx.currentTime;
    let w = this.waters.get(owner);
    if (!on) {
      if (w) {
        w.gain.gain.setTargetAtTime(0, t, 0.05);
        const dead = w;
        this.waters.delete(owner);
        setTimeout(() => { try { dead.src.stop(); dead.gain.disconnect(); } catch { /* gone */ } }, 400);
      }
      return;
    }
    const level = 0.13 * this.att(distance);
    if (!w) {
      if (this.waters.size >= 6 || level < 0.004) return;
      const src = ctx.createBufferSource(); src.buffer = this.noise; src.loop = true;
      const filt = ctx.createBiquadFilter(); filt.type = 'bandpass'; filt.frequency.value = 2100; filt.Q.value = 0.55;
      const gain = ctx.createGain(); gain.gain.value = 0.0001;
      src.connect(filt).connect(gain).connect(this.bus);
      src.start(t, Math.random());
      w = { src, filt, gain };
      this.waters.set(owner, w);
      // the first burst of pressure: a short "pssh" above the hiss
      gain.gain.setTargetAtTime(level * 1.6, t, 0.01);
      gain.gain.setTargetAtTime(level, t + 0.08, 0.08);
    } else {
      w.gain.gain.setTargetAtTime(level, t, 0.06);
    }
    w.filt.frequency.setTargetAtTime(Math.min(2400, 900 + 30000 / (20 + distance)), t, 0.1);
  }

  emp(nova: boolean, distance: number) {
    const ctx = this.ready(); if (!ctx) return;
    if (distance > 160 || !this.take('emp')) return;
    const t = ctx.currentTime, a = this.att(distance * 0.6);
    const dur = nova ? 1.5 : 1.15;
    const out = this.voice(ctx, 'emp', (nova ? 0.5 : 0.4) * a, dur, distance, 0.02);
    // 0.35 s wind up: a rising whine with a trembling filter
    const whine = this.osc(ctx, out, 'sawtooth', nova ? 160 : 220, nova ? 1300 : 1700, t, 0.35, 0.22);
    const vib = ctx.createOscillator(); vib.frequency.value = 22;
    const vg = ctx.createGain(); vg.gain.value = 40; vib.connect(vg).connect(whine.frequency);
    vib.start(t); vib.stop(t + 0.36);
    // the burst: a deep boom, a wash of air and an electric crackle
    const b = t + 0.35;
    this.osc(ctx, out, 'sine', nova ? 85 : 110, 28, b, nova ? 0.9 : 0.6, 1.4);
    this.burst(ctx, out, 'lowpass', 2200, 180, 0.7, b, nova ? 0.8 : 0.55, 1.1);
    this.burst(ctx, out, 'bandpass', 5200, 2600, 1.4, b, 0.32, 0.8);
    if (nova) {
      // NOVA adds a bright chord on top: the star going off
      for (const [f, d] of [[1046, 0], [1318, 0.03], [1568, 0.06]] as const) this.osc(ctx, out, 'sine', f, f, b + d, 0.7, 0.18);
    }
  }

  evolve(tier: TierId) {
    const ctx = this.ready(); if (!ctx) return;
    if (!this.take('ui')) return;
    const t = ctx.currentTime;
    const out = this.voice(ctx, 'ui', 0.36, 1.35, 0, 0.02);
    // gather: rising whoosh into the burst at 0.3 s, then a bell chord; higher tiers ring fuller
    this.burst(ctx, out, 'bandpass', 300, 3200, 1.2, t, 0.32, 0.7);
    const b = t + 0.3;
    this.osc(ctx, out, 'sine', 70, 40, b, 0.35, 1.0);
    const root = { spark: 523.25, bolt: 587.33, storm: 659.25, nova: 783.99 }[tier] ?? 587.33;
    const steps = tier === 'nova' ? [0, 4, 7, 12, 16] : tier === 'storm' ? [0, 4, 7, 12] : [0, 4, 7];
    steps.forEach((s, i) => {
      const f = root * Math.pow(2, s / 12);
      this.osc(ctx, out, 'triangle', f, f, b + i * 0.045, 0.95, 0.32);
      this.osc(ctx, out, 'sine', f * 2.005, f * 2.005, b + i * 0.045, 0.6, 0.12);
    });
  }

  ring(kind: RingKind, laneStep: number) {
    const ctx = this.ready(); if (!ctx) return;
    if (!this.take('ui')) return;
    const t = ctx.currentTime;
    if (kind === 'shine') {
      const f = 783.99 * Math.pow(2, PENTA[Math.max(0, laneStep) % PENTA.length] / 12);
      const out = this.voice(ctx, 'ui', 0.17, 0.42);
      this.osc(ctx, out, 'sine', f, f, t, 0.4);
      this.osc(ctx, out, 'sine', f * 2.01, f * 2.01, t, 0.22, 0.35);
      this.osc(ctx, out, 'triangle', f * 1.5, f * 1.5, t + 0.05, 0.3, 0.25);
    } else if (kind === 'bigshine') {
      const out = this.voice(ctx, 'ui', 0.2, 0.7);
      [0, 7, 12, 19].forEach((s, i) => { const f = 1046.5 * Math.pow(2, s / 12); this.osc(ctx, out, 'sine', f, f, t + i * 0.045, 0.45, 0.6); });
      this.burst(ctx, out, 'highpass', 7000, 9000, 0.5, t + 0.1, 0.4, 0.25);
    } else if (kind === 'charge') {
      const out = this.voice(ctx, 'ui', 0.17, 0.32);
      this.osc(ctx, out, 'sawtooth', 330, 1320, t, 0.2, 0.35);
      this.osc(ctx, out, 'sine', 660, 1320, t, 0.26);
    } else {
      // repair: a warm major third, never alarming
      const out = this.voice(ctx, 'ui', 0.16, 0.6, 0, 0.02);
      this.osc(ctx, out, 'triangle', 440, 440, t, 0.55);
      this.osc(ctx, out, 'triangle', 554.37, 554.37, t + 0.07, 0.5);
    }
  }

  knockout(distance: number) {
    const ctx = this.ready(); if (!ctx) return;
    if (distance > 180 || !this.take('ko')) return;
    const t = ctx.currentTime;
    const out = this.voice(ctx, 'ko', 0.4 * this.att(distance * 0.7), 0.95, distance);
    // power down: the motors spool down, a pop, a last fizz
    this.burst(ctx, out, 'lowpass', 1800, 600, 0.8, t, 0.08, 1.2);
    this.osc(ctx, out, 'sawtooth', 620, 55, t, 0.8, 0.3);
    this.osc(ctx, out, 'square', 310, 40, t + 0.02, 0.7, 0.12);
    this.burst(ctx, out, 'bandpass', 4800, 3000, 2, t + 0.15, 0.35, 0.35);
  }

  // ---------------------------------------------------------------- the Signal and the match

  signalWarning() {
    const ctx = this.ready(); if (!ctx) return;
    if (!this.take('ui')) return;
    const t = ctx.currentTime;
    const out = this.voice(ctx, 'ui', 0.13, 0.9);
    // ground station alert: two tone, three times
    for (let i = 0; i < 3; i++) {
      this.osc(ctx, out, 'square', 880, 880, t + i * 0.26, 0.11, 0.5);
      this.osc(ctx, out, 'square', 660, 660, t + i * 0.26 + 0.12, 0.11, 0.5);
    }
  }

  staticCrackle(amount: number) {
    const ctx = this.ready(); if (!ctx) return;
    const t = ctx.currentTime;
    if (!this.crackle) {
      if (amount <= 0.001) return;
      const src = ctx.createBufferSource(); src.buffer = this.crackleBuf; src.loop = true;
      const filt = ctx.createBiquadFilter(); filt.type = 'bandpass'; filt.frequency.value = 2600; filt.Q.value = 0.5;
      const gain = ctx.createGain(); gain.gain.value = 0;
      src.connect(filt).connect(gain).connect(this.bus);
      src.start();
      this.crackle = { src, filt, gain };
    }
    const a = Math.max(0, Math.min(1, amount));
    this.crackle.gain.gain.setTargetAtTime(a * 0.22, t, 0.08);
    this.crackle.filt.frequency.setTargetAtTime(2000 + a * 2200, t, 0.1);
  }

  countdown(n: number) {
    const ctx = this.ready(); if (!ctx) return;
    if (!this.take('ui')) return;
    const t = ctx.currentTime;
    if (n > 0) {
      const out = this.voice(ctx, 'ui', 0.16, 0.2);
      this.osc(ctx, out, 'triangle', 660, 660, t, 0.18);
    } else {
      const out = this.voice(ctx, 'ui', 0.2, 0.55);
      this.osc(ctx, out, 'triangle', 1320, 1320, t, 0.5);
      this.osc(ctx, out, 'sine', 990, 990, t, 0.45, 0.6);
    }
  }

  victory() {
    const ctx = this.ready(); if (!ctx) return;
    this.active.ui = 0;
    const t = ctx.currentTime;
    const out = this.voice(ctx, 'ui', 0.3, 2.2, 0, 0.02);
    // a rising fanfare that settles on a wide major chord
    [523.25, 659.25, 783.99, 1046.5].forEach((f, i) => this.osc(ctx, out, 'triangle', f, f, t + i * 0.11, 0.35, 0.55));
    for (const f of [261.63, 523.25, 659.25, 783.99, 1046.5, 1318.5]) this.osc(ctx, out, 'triangle', f, f, t + 0.46, 1.6, 0.22);
    this.burst(ctx, out, 'highpass', 6000, 9000, 0.5, t + 0.46, 1.2, 0.18);
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    for (const w of this.waters.values()) { try { w.src.stop(); w.gain.disconnect(); } catch { /* gone */ } }
    this.waters.clear();
    if (this.crackle) { try { this.crackle.src.stop(); this.crackle.gain.disconnect(); } catch { /* gone */ } this.crackle = null; }
    if (this.ctx) { try { this.bus.disconnect(); this.limiter.disconnect(); } catch { /* gone */ } }
    this.ctx = null;
  }
}
