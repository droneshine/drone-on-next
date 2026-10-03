// What the device can do for VR, read before the renderer exists. No three.js in here, game.ts imports it.

/** Quest, Pico and similar headsets run the browser on the headset itself. */
export function standaloneHeadset() {
  return typeof navigator !== 'undefined' && /OculusBrowser|Quest|Pico|Wolvic/i.test(navigator.userAgent);
}

/**
 * Performance tier for the VR session. Quest 3, 3S and Pro have roughly twice the GPU of a Quest 2,
 * a desktop browser with a PC headset gets the high tier too. Unknown standalone headsets stay low.
 */
export function xrTier(): 'low' | 'high' {
  const ua = typeof navigator !== 'undefined' ? navigator.userAgent : '';
  if (/Quest 3|Quest Pro/i.test(ua)) return 'high';
  if (standaloneHeadset()) return 'low';
  return 'high';
}

/**
 * Builds the renderer so a VR session gets 4x MSAA in the headset while the canvas keeps antialias
 * off (the flat game has MSAA in its composer target, and an MSAA canvas would change the flat look).
 * three's WebXRManager reads the context's antialias flag exactly once, inside the renderer
 * constructor, and only uses it for the headset framebuffer: during that call it reads true.
 */
export function withHeadsetAntialias<T>(make: () => T): T {
  if (typeof navigator === 'undefined' || !('xr' in navigator) || typeof WebGL2RenderingContext === 'undefined') return make();
  const proto = WebGL2RenderingContext.prototype;
  const orig = proto.getContextAttributes;
  proto.getContextAttributes = function (this: WebGL2RenderingContext) {
    const a = orig.call(this);
    return a ? { ...a, antialias: true } : a;
  };
  try { return make(); } finally { proto.getContextAttributes = orig; }
}
