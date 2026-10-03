// Input diagnostics, opened with #debug in the URL. Shows what the device really sends
// for taps, so input problems on unusual hardware (SIYI RC7, kiosk browsers) can be read off a screenshot.
export function installDebug() {
  const box = document.createElement('pre');
  Object.assign(box.style, { position: 'fixed', right: '8px', top: '8px', zIndex: '999', maxWidth: '46vw', maxHeight: '60vh', overflow: 'hidden', background: 'rgba(0,20,12,.88)', color: '#b5f78a', font: '12px/1.35 monospace', padding: '10px', borderRadius: '8px', pointerEvents: 'none', whiteSpace: 'pre-wrap' });
  document.body.append(box);
  const lines: string[] = [];
  const log = (s: string) => { lines.unshift(s); lines.length = Math.min(lines.length, 26); box.textContent = header() + '\n' + lines.join('\n'); };
  const header = () => {
    const pads = (navigator.getGamepads?.() ?? []).filter(Boolean) as Gamepad[];
    return [
      `UA ${navigator.userAgent.slice(0, 90)}`,
      `screen ${innerWidth}x${innerHeight} dpr ${devicePixelRatio} touchPoints ${navigator.maxTouchPoints}`,
      `coarse ${matchMedia('(pointer: coarse)').matches} fine ${matchMedia('(pointer: fine)').matches} hover ${matchMedia('(hover: hover)').matches}`,
      `pads ${pads.map(p => `${p.id.slice(0, 40)} axes[${p.axes.map(a => a.toFixed(2)).join(',')}]`).join(' | ') || 'none'}`,
    ].join('\n');
  };
  const desc = (e: Event) => {
    const t = e.target as HTMLElement;
    const top = 'clientX' in e ? document.elementFromPoint((e as PointerEvent).clientX, (e as PointerEvent).clientY) as HTMLElement | null : null;
    const name = (el: HTMLElement | null) => el ? `${el.tagName.toLowerCase()}${el.id ? '#' + el.id : ''}${el.className && typeof el.className === 'string' ? '.' + el.className.split(' ').slice(0, 2).join('.') : ''}` : '-';
    return `${name(t)}  top ${name(top)}`;
  };
  for (const type of ['pointerdown', 'pointerup', 'pointercancel', 'touchstart', 'touchend', 'mousedown', 'click']) {
    addEventListener(type, e => {
      const pe = e as PointerEvent;
      log(`${type.padEnd(13)} ${pe.pointerType ?? ''} ${'clientX' in pe ? Math.round(pe.clientX) + ',' + Math.round(pe.clientY) : ''} ${desc(e)}${e.defaultPrevented ? ' PREVENTED' : ''}`);
    }, { capture: true, passive: true });
  }
  addEventListener('keydown', e => log(`keydown ${e.code} ${e.key}`), true);
  setInterval(() => { box.textContent = header() + '\n' + lines.join('\n'); }, 500);
}
