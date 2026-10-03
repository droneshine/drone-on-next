import type { ScreenFx, TierId } from './contracts';

// Screen space overlays between the 3D view and the HUD (z-index 1: above #gl, below #ui at 2).
// Pure DOM and CSS, compositor friendly: only opacity and transform animate; the static noise is
// a procedural canvas made once. Nothing here takes pointer events.
//
// Motion (ART.md 4): damage arc in 60 ms, out over 700 ms; evolve flash in 60 ms, out over 600 ms;
// scrambled in 80 ms, out 220 ms; low integrity pulses like a heartbeat every 1.1 s.
// prefers-reduced-motion keeps every state readable but stops the jitter and the heartbeat.

const CSS = `
.dfx{position:fixed;inset:0;pointer-events:none;z-index:1;overflow:hidden;contain:strict}
.dfx>div{position:absolute;inset:0}
.dfx-static{opacity:0;transition:opacity 180ms linear;-webkit-mask-image:radial-gradient(ellipse at center,transparent var(--clear,58%),#000 100%);mask-image:radial-gradient(ellipse at center,transparent var(--clear,58%),#000 100%)}
.dfx-noise{position:absolute;inset:-60%;background-image:var(--noise),repeating-linear-gradient(0deg,rgba(181,247,138,.16) 0 1px,transparent 1px 4px);background-size:288px 288px,auto;image-rendering:pixelated;animation:dfx-jit .42s steps(1) infinite;will-change:transform}
.dfx-static .dfx-noise{opacity:.9}
@keyframes dfx-jit{0%{transform:translate(0,0)}14%{transform:translate(-9%,6%)}28%{transform:translate(7%,-11%)}42%{transform:translate(-13%,-4%)}57%{transform:translate(11%,9%)}71%{transform:translate(-4%,13%)}85%{transform:translate(5%,-6%)}}
.dfx-tint{background:radial-gradient(ellipse at center,transparent 45%,rgba(0,37,24,.5) 82%,rgba(0,66,37,.75) 100%)}
.dfx-dmg svg{position:absolute;left:50%;top:50%;width:min(86vw,86vh);height:min(86vw,86vh);margin:calc(min(86vw,86vh)/-2) 0 0 calc(min(86vw,86vh)/-2);opacity:0;overflow:visible}
.dfx-flash{opacity:0;background:radial-gradient(ellipse at center,rgba(181,247,138,.10) 0%,rgba(181,247,138,.16) 45%,var(--edge,rgba(181,247,138,.62)) 100%)}
.dfx-scr{opacity:0;transition:opacity 220ms ease-out}
.dfx-scr.on{opacity:1;transition-duration:80ms}
.dfx-scr .dfx-noise{opacity:.42;animation-duration:.24s;mix-blend-mode:screen}
.dfx-scr .dfx-tint{background:radial-gradient(ellipse at center,rgba(0,37,24,.12) 30%,rgba(0,37,24,.6) 100%)}
.dfx-tear{position:absolute;left:-5%;right:-5%;height:var(--h,10px);top:0;background:linear-gradient(90deg,transparent,rgba(247,247,242,.38) 18%,rgba(181,247,138,.5) 52%,rgba(247,247,242,.3) 84%,transparent);mix-blend-mode:screen;animation:dfx-tear var(--d,.9s) steps(1) infinite}
@keyframes dfx-tear{0%{transform:translate(0,12vh)}20%{transform:translate(-3%,63vh)}40%{transform:translate(2%,31vh)}60%{transform:translate(-1%,82vh)}80%{transform:translate(3%,47vh)}}
.dfx-roll{position:absolute;left:0;right:0;height:26vh;top:-26vh;background:linear-gradient(180deg,transparent,rgba(181,247,138,.07) 60%,rgba(247,247,242,.12) 96%,transparent);animation:dfx-roll 1.6s linear infinite}
@keyframes dfx-roll{to{transform:translateY(126vh)}}
.dfx-low{opacity:0;transition:opacity 300ms ease-out;box-shadow:inset 0 0 16vmin 2vmin rgba(255,107,90,.62),inset 0 0 0 2px rgba(255,107,90,.55)}
.dfx-low.on{animation:dfx-beat 1.1s cubic-bezier(.23,1,.32,1) infinite}
@keyframes dfx-beat{0%{opacity:.45}12%{opacity:1}26%{opacity:.6}38%{opacity:.92}70%,100%{opacity:.45}}
@media (prefers-reduced-motion: reduce){
  .dfx-noise,.dfx-tear,.dfx-roll{animation:none}
  .dfx-low.on{animation:none;opacity:.6}
}`;

const TIER_EDGE: Record<TierId, string> = {
  spark: 'rgba(181,247,138,.62)', bolt: 'rgba(143,194,245,.55)', storm: 'rgba(181,247,138,.66)', nova: 'rgba(247,247,242,.6)',
};

/** procedural static grain: light green and off white specks on transparent, made once per page */
let noiseUrl = '';
function noise() {
  if (noiseUrl) return noiseUrl;
    const c = document.createElement('canvas'); c.width = c.height = 96;
  const g = c.getContext('2d')!;
  const img = g.createImageData(96, 96);
  for (let i = 0; i < 96 * 96; i++) {
    const v = Math.random();
    const k = i * 4;
    const hot = v > 0.86;
    img.data[k] = hot ? 247 : 181; img.data[k + 1] = 247; img.data[k + 2] = hot ? 242 : 138;
    img.data[k + 3] = Math.floor(Math.pow(v, 3) * 200);
  }
  g.putImageData(img, 0, 0);
  // a few horizontal dropouts so it reads as signal static, not film grain
  for (let i = 0; i < 7; i++) { g.fillStyle = `rgba(181,247,138,${0.08 + Math.random() * 0.14})`; g.fillRect(0, Math.floor(Math.random() * 96), 96, 1); }
  noiseUrl = `url(${c.toDataURL()})`;
  return noiseUrl;
}

export class ScreenImpl implements ScreenFx {
  private root: HTMLDivElement;
  private style: HTMLStyleElement;
  private stat: HTMLDivElement;
  private dmg: HTMLDivElement;
  private flash: HTMLDivElement;
  private scr: HTMLDivElement;
  private low: HTMLDivElement;
  private arcs: SVGSVGElement[] = [];
  private arcNext = 0;
  private lastStatic = -1;
  private reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;

  constructor() {
    this.style = document.createElement('style');
    this.style.textContent = CSS;
    document.head.append(this.style);
    const el = (cls: string, html = '') => { const d = document.createElement('div'); d.className = cls; d.innerHTML = html; return d; };
    this.root = el('dfx');
    this.root.style.setProperty('--noise', noise());
    this.root.setAttribute('aria-hidden', 'true');
    this.stat = el('dfx-static', '<div class="dfx-tint"></div><div class="dfx-noise"></div>');
    this.dmg = el('dfx-dmg');
    this.flash = el('dfx-flash');
    this.scr = el('dfx-scr', '<div class="dfx-tint"></div><div class="dfx-noise"></div><div class="dfx-roll"></div>'
      + '<i class="dfx-tear" style="--h:7px;--d:.83s"></i><i class="dfx-tear" style="--h:13px;--d:1.17s;animation-delay:-.4s"></i><i class="dfx-tear" style="--h:4px;--d:.61s;animation-delay:-.2s"></i>');
    this.low = el('dfx-low');
    this.root.append(this.stat, this.low, this.dmg, this.flash, this.scr);
    // six damage arcs, reused round robin
    for (let i = 0; i < 6; i++) {
      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.setAttribute('viewBox', '-50 -50 100 100');
      // a 44 degree arc at the top of a circle, rotated to the hit direction
      const a = 22 * Math.PI / 180, r = 46;
      const x0 = -Math.sin(a) * r, y0 = -Math.cos(a) * r, x1 = Math.sin(a) * r;
      const d = `M ${x0.toFixed(2)} ${y0.toFixed(2)} A ${r} ${r} 0 0 1 ${x1.toFixed(2)} ${y0.toFixed(2)}`;
      // a dark under stroke keeps the Off White arc readable over sky, apron and snow bright glare
      svg.innerHTML = `<path d="${d}" fill="none" stroke="rgba(0,37,24,.42)" stroke-width="3.6" stroke-linecap="round"/>`
        + `<path d="${d}" fill="none" stroke="rgba(247,247,242,.25)" stroke-width="5.5" stroke-linecap="round"/>`
        + `<path d="${d}" fill="none" stroke="#f7f7f2" stroke-width="1.1" stroke-linecap="round"/>`;
      this.dmg.append(svg);
      this.arcs.push(svg);
    }
    document.body.append(this.root);
  }

  staticAmount(v: number) {
    v = Math.max(0, Math.min(1, v));
    if (Math.abs(v - this.lastStatic) < 0.01) return;
    this.lastStatic = v;
    this.stat.style.opacity = String(v > 0.001 ? 0.35 + v * 0.65 : 0);
    // deeper in the Static the clear centre closes in
    this.root.style.setProperty('--clear', `${Math.round(62 - v * 44)}%`);
  }

  damageFrom(angle: number, amount: number) {
    const svg = this.arcs[this.arcNext];
    this.arcNext = (this.arcNext + 1) % this.arcs.length;
    const strength = Math.max(0.35, Math.min(1, amount / 25));
    const deg = angle * 180 / Math.PI;
    svg.getAnimations().forEach(a => a.cancel());
    svg.style.strokeWidth = '';
    (svg.lastElementChild as SVGPathElement).setAttribute('stroke-width', (0.9 + strength * 1.3).toFixed(2));
    svg.animate([
      { opacity: 0, transform: `rotate(${deg}deg) scale(${this.reduce ? 1 : 1.05})` },
      { opacity: strength, transform: `rotate(${deg}deg) scale(1)`, offset: 0.08 },
      { opacity: 0, transform: `rotate(${deg}deg) scale(1)` },
    ], { duration: 760, easing: 'cubic-bezier(0.23, 1, 0.32, 1)' });
  }

  evolveFlash(tier: TierId) {
    this.flash.style.setProperty('--edge', TIER_EDGE[tier] ?? TIER_EDGE.spark);
    this.flash.getAnimations().forEach(a => a.cancel());
    this.flash.animate([{ opacity: 0 }, { opacity: 1, offset: 0.09 }, { opacity: 0 }], { duration: 660, easing: 'cubic-bezier(0.23, 1, 0.32, 1)' });
  }

  scrambled(on: boolean) { this.scr.classList.toggle('on', on); }

  lowIntegrity(on: boolean) {
    this.low.classList.toggle('on', on);
    if (!on) this.low.style.opacity = '';
  }

  dispose() {
    for (const a of this.root.getAnimations({ subtree: true })) a.cancel();
    this.root.remove();
    this.style.remove();
  }
}
