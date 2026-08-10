/**
 * Renderer tier detection.
 *
 * The GPU ocean needs WebGL2 with float render targets. Everything else falls
 * back to the original CPU FFT path, which is kept working rather than deleted
 * so an unsupported device sees water instead of a blank canvas.
 *
 * Pure enough for node:test — takes a context factory so a stub can stand in
 * for a real canvas.
 */

export const TIER_GPU = "gpu";
export const TIER_CPU = "cpu";

/**
 * @param {object} [options]
 * @param {() => (WebGL2RenderingContext|null)} [options.getContext]
 *   Returns a WebGL2 context, or null if unavailable.
 * @returns {"gpu"|"cpu"}
 */
export function detectTier({ getContext, forcedTier } = {}) {
  // ?tier=cpu forces the fallback path. Without this the CPU tier is
  // unreachable on any machine that supports the GPU one, which is how it went
  // untested through an entire rewrite.
  if (forcedTier === TIER_CPU || forcedTier === TIER_GPU) return forcedTier;
  let gl = null;
  try {
    gl = getContext ? getContext() : defaultGetContext();
  } catch {
    return TIER_CPU;
  }
  if (!gl) return TIER_CPU;

  // Rendering to float targets is the hard requirement: the FFT ping-pong and
  // every cascade output are float.
  let ext = null;
  try {
    ext = gl.getExtension("EXT_color_buffer_float");
  } catch {
    return TIER_CPU;
  }
  return ext ? TIER_GPU : TIER_CPU;
}

function defaultGetContext() {
  if (typeof document === "undefined") return null;
  const canvas = document.createElement("canvas");
  return canvas.getContext("webgl2");
}

/** Human-readable reason, for the one-line console note on fallback. */
export function tierReason(tier) {
  return tier === TIER_GPU
    ? "WebGL2 + EXT_color_buffer_float available"
    : "WebGL2 float render targets unavailable — using CPU ocean";
}
