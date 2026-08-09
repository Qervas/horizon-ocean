/**
 * Ocean wave spectrum: JONSWAP with Donelan-Banner directional spreading.
 *
 * Pure — imports nothing — so `node:test` can exercise it directly.
 *
 * Replaces the Phillips spectrum, which predates directional-spreading models
 * and offers only a cos^2 lobe. JONSWAP is fetch-limited and its peak
 * enhancement produces the grouped swell that reads as real ocean.
 */

export const GRAVITY = 9.81;

/** FFT size for every cascade. */
export const FFT_N = 256;

/**
 * Simulation loop period in seconds. Angular frequencies are snapped to
 * integer multiples of 2*pi/LOOP_PERIOD so the sea repeats seamlessly instead
 * of drifting out of phase with itself.
 */
export const LOOP_PERIOD = 200;

/**
 * Cascade bands. Each cascade is clipped to [kLow, kHigh), where the boundary
 * is the Nyquist wavenumber of the next-coarser cascade. Overlapping bands
 * would double-count energy — water that looks plausible but too rough — so
 * the tiling is exact by construction rather than by hand-tuned constants.
 */
const PATCH_SIZES = [2048, 512, 128, 32];

export const CASCADES = PATCH_SIZES.map((patch, i) => {
  const nyquist = (Math.PI * FFT_N) / patch;
  const prevNyquist = i === 0 ? 0 : (Math.PI * FFT_N) / PATCH_SIZES[i - 1];
  return { patch, kLow: prevNyquist, kHigh: nyquist };
});

/** Reproducible RNG. Never use Math.random — seas must replay identically. */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function gaussianPair(rng) {
  let u = 0;
  let v = 0;
  while (u === 0) u = rng();
  while (v === 0) v = rng();
  const mag = Math.sqrt(-2 * Math.log(u));
  return [mag * Math.cos(2 * Math.PI * v), mag * Math.sin(2 * Math.PI * v)];
}

/** JONSWAP peak angular frequency for wind speed U (m/s) and fetch F (m). */
export function peakOmega(U, F, g = GRAVITY) {
  return 22 * Math.pow((g * g) / (U * F), 1 / 3);
}

/** JONSWAP energy density at angular frequency omega. */
export function jonswap(omega, U, F, g = GRAVITY) {
  if (!(omega > 1e-6)) return 0;
  const wp = peakOmega(U, F, g);
  const alpha = 0.076 * Math.pow((U * U) / (F * g), 0.22);
  const sigma = omega <= wp ? 0.07 : 0.09;
  const r = Math.exp(-((omega - wp) * (omega - wp)) / (2 * sigma * sigma * wp * wp));
  const gamma = 3.3;
  const pm = ((alpha * g * g) / Math.pow(omega, 5)) * Math.exp(-1.25 * Math.pow(wp / omega, 4));
  const s = pm * Math.pow(gamma, r);
  return Number.isFinite(s) ? s : 0;
}

/**
 * Donelan-Banner directional spreading, normalised so it integrates to 1 over
 * theta. beta is clamped: the fitted form diverges far from the peak, where it
 * would describe a lobe narrower than any grid cell (and overflow cosh).
 * Energy there is negligible, so clamping costs nothing physical.
 */
export function donelanBanner(omega, omegaP, theta) {
  if (!(omega > 1e-6) || !(omegaP > 1e-6)) return 0;
  const ratio = omega / omegaP;
  let beta;
  if (ratio > 0.56 && ratio < 0.95) {
    beta = 2.61 * Math.pow(ratio, 1.3);
  } else if (ratio >= 0.95 && ratio < 1.6) {
    beta = 2.28 * Math.pow(ratio, -1.3);
  } else {
    const eps = -0.4 + 0.8393 * Math.exp(-0.567 * Math.log(ratio * ratio));
    beta = Math.pow(10, eps);
  }
  if (!Number.isFinite(beta)) beta = 20;
  beta = Math.min(Math.max(beta, 0.3), 20);

  const x = beta * theta;
  // sech^2 via 1/cosh^2; cosh saturates to Infinity for large x, giving 0.
  const cosh = Math.cosh(x);
  const sech2 = 1 / (cosh * cosh);
  const d = (beta * sech2) / 2;
  return Number.isFinite(d) ? d : 0;
}

/**
 * Dispersion relation, quantised to the loop period.
 * tanh(k*depth) is retained so finite-depth shoaling stays available later;
 * at depth 1000 it is 1 for every wavenumber this simulation carries.
 */
export function dispersion(k, depth, g = GRAVITY) {
  const w0 = (2 * Math.PI) / LOOP_PERIOD;
  const w = Math.sqrt(g * k * Math.tanh(Math.min(k * depth, 20)));
  return Math.floor(w / w0) * w0;
}

/**
 * Initial (time-invariant) spectrum h0 for one cascade.
 *
 * Returns Float32Array of length N*N*4 laid out as
 * (h0.re, h0.im, conj(h0(-k)).re, conj(h0(-k)).im) so the GPU evolution pass
 * needs a single fetch per texel.
 */
export function buildInitialSpectrum({
  N,
  patch,
  kLow,
  kHigh,
  windSpeed,
  windDir,
  fetch,
  depth,
  seed,
}) {
  const g = GRAVITY;
  const wp = peakOmega(windSpeed, fetch, g);
  const dk = (2 * Math.PI) / patch;
  const windLen = Math.hypot(windDir[0], windDir[1]) || 1;
  const wx = windDir[0] / windLen;
  const wz = windDir[1] / windLen;

  const rng = mulberry32(seed);
  const re = new Float32Array(N * N);
  const im = new Float32Array(N * N);

  for (let m = 0; m < N; m++) {
    for (let n = 0; n < N; n++) {
      const i = m * N + n;
      const kx = (n < N / 2 ? n : n - N) * dk;
      const kz = (m < N / 2 ? m : m - N) * dk;
      const k = Math.hypot(kx, kz);

      // Draw regardless of band so the RNG stream stays aligned with the grid;
      // otherwise changing the band would reshuffle the whole sea.
      const [xr, xi] = gaussianPair(rng);

      // Guard before any division. k=0 is the DC mode and the NaN source that
      // silently blackens the entire surface.
      if (k < 1e-6 || k < kLow || k >= kHigh) continue;

      const omega = Math.sqrt(g * k * Math.tanh(Math.min(k * depth, 20)));
      // S(k) = S(omega) * (domega/dk) / k
      const dOmegaDk = g / (2 * Math.max(omega, 1e-6));
      const theta = Math.atan2(kz, kx) - Math.atan2(wz, wx);
      const sOmega = jonswap(omega, windSpeed, fetch, g);
      const spread = donelanBanner(omega, wp, Math.atan2(Math.sin(theta), Math.cos(theta)));
      const sk = (sOmega * dOmegaDk * spread) / k;

      const amp = Math.sqrt(Math.max(sk, 0) * dk * dk * 2) / Math.SQRT2;
      if (!Number.isFinite(amp)) continue;
      re[i] = xr * amp;
      im[i] = xi * amp;
    }
  }

  const out = new Float32Array(N * N * 4);
  for (let m = 0; m < N; m++) {
    for (let n = 0; n < N; n++) {
      const i = m * N + n;
      // Mirror index for -k. Row/column 0 is its own mirror.
      const mm = m === 0 ? 0 : N - m;
      const nn = n === 0 ? 0 : N - n;
      const j = mm * N + nn;
      const o = i * 4;
      out[o] = re[i];
      out[o + 1] = im[i];
      out[o + 2] = re[j];
      out[o + 3] = -im[j];
    }
  }
  return out;
}
