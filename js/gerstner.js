/**
 * High-frequency Gerstner detail layered on FFT swell.
 * Mid chop → short wind waves → capillary ripples for continuous surface.
 */

export const DETAIL_WAVES = [
  // Long swell first — photo has clear rounded forms
  { dx: 0.78, dz: 0.62, a: 0.62, lambda: 48, steep: 0.26, phase: 0.3, speed: 0.92 },
  { dx: -0.5, dz: 0.86, a: 0.48, lambda: 32, steep: 0.24, phase: 1.6, speed: 0.98 },
  { dx: 0.92, dz: -0.38, a: 0.34, lambda: 22, steep: 0.22, phase: 2.1, speed: 1.02 },
  { dx: -0.25, dz: 0.97, a: 0.22, lambda: 15, steep: 0.18, phase: 0.7, speed: 1.06 },
  { dx: 0.55, dz: -0.83, a: 0.15, lambda: 11, steep: 0.16, phase: 3.0, speed: 1.1 },
  // Short waves
  { dx: -0.35, dz: 0.94, a: 0.1, lambda: 7.0, steep: 0.14, phase: 0.9, speed: 1.16 },
  { dx: 0.7, dz: 0.72, a: 0.07, lambda: 4.5, steep: 0.12, phase: 2.9, speed: 1.2 },
  { dx: -0.88, dz: -0.47, a: 0.045, lambda: 3.1, steep: 0.1, phase: 1.4, speed: 1.26 },
  { dx: 0.4, dz: -0.92, a: 0.03, lambda: 2.2, steep: 0.09, phase: 2.5, speed: 1.3 },
  { dx: -0.75, dz: 0.66, a: 0.02, lambda: 1.5, steep: 0.08, phase: 0.2, speed: 1.36 },
  // Capillary
  { dx: 0.22, dz: 0.97, a: 0.014, lambda: 1.0, steep: 0.07, phase: 1.1, speed: 1.42 },
  { dx: -0.95, dz: 0.3, a: 0.01, lambda: 0.7, steep: 0.06, phase: 2.8, speed: 1.48 },
];

export const WAVE_COUNT = DETAIL_WAVES.length;

export function packDetailWaves(scale = 1) {
  const dirs = [];
  const amp = [];
  const lambda = [];
  const steep = [];
  const phase = [];
  const speed = [];
  for (const w of DETAIL_WAVES) {
    const len = Math.hypot(w.dx, w.dz) || 1;
    dirs.push(w.dx / len, w.dz / len);
    amp.push(w.a * scale);
    lambda.push(w.lambda);
    steep.push(w.steep);
    phase.push(w.phase);
    speed.push(w.speed);
  }
  return { dirs, amp, lambda, steep, phase, speed };
}

/** Sample detail Gerstner only (FFT sampled separately). Physics uses first 8 only for cost. */
export function sampleDetail(x, z, t, scale = 1) {
  let py = 0;
  let px = 0;
  let pz = 0;
  let dPx_dx = 1;
  let dPy_dx = 0;
  let dPz_dx = 0;
  let dPx_dz = 0;
  let dPy_dz = 0;
  let dPz_dz = 1;
  const n = Math.min(DETAIL_WAVES.length, 8);
  for (let wi = 0; wi < n; wi++) {
    const w = DETAIL_WAVES[wi];
    const len = Math.hypot(w.dx, w.dz) || 1;
    const dx = w.dx / len;
    const dz = w.dz / len;
    const k = (Math.PI * 2) / w.lambda;
    const wSpeed = Math.sqrt(9.81 * k) * w.speed;
    const a = w.a * scale;
    const Q = w.steep / (k * a * n * 0.5 + 1e-5);
    const theta = k * (dx * x + dz * z) - wSpeed * t + w.phase;
    const s = Math.sin(theta);
    const c = Math.cos(theta);
    px += Q * a * dx * c;
    py += a * s;
    pz += Q * a * dz * c;
    const dth_dx = k * dx;
    const dth_dz = k * dz;
    dPx_dx -= Q * a * dx * s * dth_dx;
    dPy_dx += a * c * dth_dx;
    dPz_dx -= Q * a * dz * s * dth_dx;
    dPx_dz -= Q * a * dx * s * dth_dz;
    dPy_dz += a * c * dth_dz;
    dPz_dz -= Q * a * dz * s * dth_dz;
  }
  let nx = dPy_dz * dPz_dx - dPz_dz * dPy_dx;
  let ny = dPz_dz * dPx_dx - dPx_dz * dPz_dx;
  let nz = dPx_dz * dPy_dx - dPy_dz * dPx_dx;
  const inv = 1 / (Math.hypot(nx, ny, nz) || 1);
  return { x: px, y: py, z: pz, nx: nx * inv, ny: ny * inv, nz: nz * inv };
}
