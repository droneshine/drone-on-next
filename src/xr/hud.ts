import * as THREE from 'three';

// The in world HUD for VR: one canvas panel, redrawn only when what it shows changes.
// It hangs above the left controller in PILOT view and under the screen in GOGGLES view.

export interface HudData {
  mode: string;
  arm: string;
  armed: boolean;
  batt: number;      // 0..1
  alt: number;       // m above ground
  speed: number;     // km/h
  view: string;
  status: string;
  tone: 'info' | 'warn' | 'bad';
}

const W = 640, H = 360;
const C = { ev: '#002518', gr: '#004225', off: '#f7f7f2', lg: '#b5f78a', dim: 'rgba(247,247,242,0.62)', hair: 'rgba(181,247,138,0.28)', warn: '#ffb259', bad: '#ff6b5a' };
const DISPLAY = "'Nasalization', 'Audiowide', 'Inter', sans-serif";
const TEXT = "'Inter', system-ui, sans-serif";

export class XrHud {
  mesh: THREE.Mesh;
  private canvas = document.createElement('canvas');
  private ctx: CanvasRenderingContext2D;
  private tex: THREE.CanvasTexture;
  private last = '';

  constructor() {
    this.canvas.width = W; this.canvas.height = H;
    this.ctx = this.canvas.getContext('2d')!;
    this.tex = new THREE.CanvasTexture(this.canvas);
    this.tex.colorSpace = THREE.SRGBColorSpace;
    this.tex.generateMipmaps = false;
    this.tex.minFilter = THREE.LinearFilter;
    // exact brand colours: no tone mapping, no fog, always drawn over the world it floats in
    const mat = new THREE.MeshBasicMaterial({ map: this.tex, transparent: true, toneMapped: false, fog: false, depthWrite: false });
    this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, H / W), mat);
    this.mesh.renderOrder = 10;
    this.mesh.userData.noThermal = true;
    this.mesh.name = 'xr-hud';
    document.fonts?.load(`600 20px Inter`).catch(() => { /* optional */ });
  }

  /** draws only when a shown value changed, so the texture upload stays rare */
  update(d: HudData) {
    const key = `${d.mode}|${d.arm}|${Math.round(d.batt * 100)}|${d.alt.toFixed(1)}|${Math.round(d.speed)}|${d.view}|${d.status}|${d.tone}`;
    if (key === this.last) return;
    this.last = key;
    const g = this.ctx;
    g.clearRect(0, 0, W, H);
    // panel
    g.fillStyle = 'rgba(0,37,24,0.9)';
    rr(g, 3, 3, W - 6, H - 6, 26); g.fill();
    g.strokeStyle = C.hair; g.lineWidth = 3; g.stroke();
    // top row: flight mode chip, arm state, view
    g.font = `400 30px ${DISPLAY}`;
    const mw = g.measureText(d.mode).width + 34;
    g.fillStyle = C.lg; rr(g, 28, 26, mw, 50, 12); g.fill();
    g.fillStyle = C.ev; g.textBaseline = 'middle'; g.fillText(d.mode, 45, 53);
    g.font = `600 20px ${TEXT}`;
    const vw = g.measureText(d.view).width;
    // the arm hint matters more than the view name (you can see which view you are in): when both do
    // not fit at a readable size, the view name steps aside
    const x0 = 28 + mw + 20;
    const fits = (room: number, px: number) => { g.font = `600 ${px}px ${TEXT}`; return g.measureText(d.arm).width <= room; };
    const showView = fits(W - 30 - vw - 22 - x0, 21);
    const room = showView ? W - 30 - vw - 22 - x0 : W - 30 - x0;
    let size = 24;
    while (!fits(room, size) && size > 15) size--;
    g.fillStyle = d.armed ? C.lg : C.off;
    g.fillText(d.arm, x0, 52);
    if (showView) {
      g.font = `600 20px ${TEXT}`; g.fillStyle = C.dim; g.textAlign = 'right';
      g.fillText(d.view, W - 30, 52);
    }
    g.textAlign = 'left';
    // numbers
    const pct = Math.round(d.batt * 100);
    const cols: [string, string, string][] = [
      [`${pct}%`, 'BATTERY', pct < 15 ? C.bad : pct < 30 ? C.warn : C.off],
      [d.alt < 100 ? d.alt.toFixed(1) : String(Math.round(d.alt)), 'ALT M', C.off],
      [String(Math.round(d.speed)), 'KM/H', C.off],
    ];
    cols.forEach(([v, lab, col], i) => {
      const x = 28 + i * 200;
      g.font = `400 66px ${DISPLAY}`; g.fillStyle = col; g.textBaseline = 'alphabetic';
      g.fillText(v, x, 182);
      g.font = `600 17px ${TEXT}`; g.fillStyle = C.dim;
      g.fillText(lab, x + 2, 214);
    });
    // status: toast, mission line or the controls
    g.fillStyle = 'rgba(247,247,242,0.08)'; g.fillRect(28, 246, W - 56, 2);
    g.font = `500 23px ${TEXT}`; g.textBaseline = 'middle';
    g.fillStyle = d.tone === 'bad' ? C.bad : d.tone === 'warn' ? C.warn : C.off;
    wrap(g, d.status, 28, 288, W - 56, 30, 2);
    this.tex.needsUpdate = true;
  }

  dispose() { this.tex.dispose(); (this.mesh.material as THREE.Material).dispose(); this.mesh.geometry.dispose(); }
}

function rr(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  g.beginPath();
  g.moveTo(x + r, y); g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r); g.closePath();
}

/** word wrap into at most maxLines; what does not fit ends in an ellipsis */
function wrap(g: CanvasRenderingContext2D, text: string, x: number, y: number, maxW: number, lh: number, maxLines: number) {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let line = '', i = 0;
  for (; i < words.length; i++) {
    const t = line ? line + ' ' + words[i] : words[i];
    if (g.measureText(t).width > maxW && line) {
      lines.push(line); line = words[i];
      if (lines.length === maxLines) break;
    } else line = t;
  }
  if (lines.length < maxLines && line) { lines.push(line); i = words.length; }
  if (i < words.length) {
    let last = lines[maxLines - 1];
    while (last && g.measureText(last + '…').width > maxW) last = last.slice(0, last.lastIndexOf(' ') > 0 ? last.lastIndexOf(' ') : last.length - 1);
    lines[maxLines - 1] = last + '…';
  }
  lines.forEach((l, n) => g.fillText(l, x, y + n * lh));
}
