import { buildInitialSpectrum, dispersion, CASCADES, GRAVITY } from "./spectrum.js";

/**
 * Zero-latency CPU mirror of the two coarse ocean cascades.
 *
 * Buoyancy cannot tolerate readback latency: a boat that rides where the water
 * was is worse than a boat riding a slightly coarser approximation of where the
 * water is. This runs the same spectrum, the same seed, and the same quantised
 * dispersion as the GPU simulation, so the surfaces agree by construction
 * rather than by tuning.
 *
 * Only cascades 0 and 1 are mirrored — wavelengths above 4 m. Finer cascades
 * are shorter than the hull and a boat does not respond to them individually,
 * so simulating them on the CPU would cost time to produce motion no one sees.
 *
 * Imports only spectrum.js (itself dependency-free), so node:test can run it.
 */

const DEFAULT_N = 64;

/** In-place radix-2 FFT on real/imag pairs. */
function fft1d(re, im, inverse) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      let t = re[i];
      re[i] = re[j];
      re[j] = t;
      t = im[i];
      im[i] = im[j];
      im[j] = t;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = ((inverse ? 2 : -2) * Math.PI) / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1;
      let ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const u = i + k;
        const v = u + len / 2;
        const tr = cr * re[v] - ci * im[v];
        const ti = cr * im[v] + ci * re[v];
        re[v] = re[u] - tr;
        im[v] = im[u] - ti;
        re[u] += tr;
        im[u] += ti;
        const ncr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = ncr;
      }
    }
  }
}

function fft2d(re, im, N, inverse) {
  const rowRe = new Float32Array(N);
  const rowIm = new Float32Array(N);
  for (let y = 0; y < N; y++) {
    const o = y * N;
    for (let x = 0; x < N; x++) {
      rowRe[x] = re[o + x];
      rowIm[x] = im[o + x];
    }
    fft1d(rowRe, rowIm, inverse);
    for (let x = 0; x < N; x++) {
      re[o + x] = rowRe[x];
      im[o + x] = rowIm[x];
    }
  }
  for (let x = 0; x < N; x++) {
    for (let y = 0; y < N; y++) {
      rowRe[y] = re[y * N + x];
      rowIm[y] = im[y * N + x];
    }
    fft1d(rowRe, rowIm, inverse);
    for (let y = 0; y < N; y++) {
      re[y * N + x] = rowRe[y];
      im[y * N + x] = rowIm[y];
    }
  }
}

class MirrorCascade {
  constructor({ N, patch, kLow, kHigh, windSpeed, windDir, fetch, gamma, depth, seed }) {
    this.N = N;
    this.patch = patch;
    this.depth = depth;
    this.h0 = buildInitialSpectrum({
      N,
      patch,
      kLow,
      kHigh,
      windSpeed,
      windDir,
      fetch,
      gamma,
      depth,
      seed,
    });

    const n2 = N * N;
    this.hRe = new Float32Array(n2);
    this.hIm = new Float32Array(n2);
    this.dxRe = new Float32Array(n2);
    this.dxIm = new Float32Array(n2);
    this.dzRe = new Float32Array(n2);
    this.dzIm = new Float32Array(n2);
    this.height = new Float32Array(n2);
    this.dispX = new Float32Array(n2);
    this.dispZ = new Float32Array(n2);

    // Precompute wavenumbers and frequencies — identical to the GPU evolve pass.
    this.kx = new Float32Array(n2);
    this.kz = new Float32Array(n2);
    this.omega = new Float32Array(n2);
    const dk = (2 * Math.PI) / patch;
    for (let m = 0; m < N; m++) {
      for (let n = 0; n < N; n++) {
        const i = m * N + n;
        const kx = (n < N / 2 ? n : n - N) * dk;
        const kz = (m < N / 2 ? m : m - N) * dk;
        this.kx[i] = kx;
        this.kz[i] = kz;
        const k = Math.hypot(kx, kz);
        this.omega[i] = k < 1e-6 ? 0 : dispersion(k, depth, GRAVITY);
      }
    }
  }

  update(t, choppiness) {
    const { N, hRe, hIm, dxRe, dxIm, dzRe, dzIm } = this;
    const n2 = N * N;
    for (let i = 0; i < n2; i++) {
      const o = this.omega[i];
      const c = Math.cos(o * t);
      const s = Math.sin(o * t);
      const h0r = this.h0[i * 4];
      const h0i = this.h0[i * 4 + 1];
      const cr = this.h0[i * 4 + 2];
      const ci = this.h0[i * 4 + 3];

      // h(k,t) = h0 e^{iwt} + conj(h0(-k)) e^{-iwt}
      const re = h0r * c - h0i * s + (cr * c + ci * s);
      const im = h0r * s + h0i * c + (ci * c - cr * s);
      hRe[i] = re;
      hIm[i] = im;

      const kx = this.kx[i];
      const kz = this.kz[i];
      const k = Math.hypot(kx, kz);
      if (k < 1e-6) {
        dxRe[i] = dxIm[i] = dzRe[i] = dzIm[i] = 0;
        continue;
      }
      // D = -i (k/|k|) h
      const sx = (kx / k) * choppiness;
      const sz = (kz / k) * choppiness;
      dxRe[i] = im * sx;
      dxIm[i] = -re * sx;
      dzRe[i] = im * sz;
      dzIm[i] = -re * sz;
    }

    fft2d(hRe, hIm, N, true);
    fft2d(dxRe, dxIm, N, true);
    fft2d(dzRe, dzIm, N, true);

    // fft1d applies no 1/n factor, so this is already the unnormalised inverse
    // transform the GPU path uses. Scaling by N^2 here would inflate heights by
    // three orders of magnitude.
    for (let i = 0; i < n2; i++) {
      this.height[i] = hRe[i];
      this.dispX[i] = dxRe[i];
      this.dispZ[i] = dzRe[i];
    }
  }

  /** Bilinear sample of a field at world XZ. */
  _sample(field, x, z) {
    const N = this.N;
    const u = (((x / this.patch) % 1) + 1) % 1;
    const v = (((z / this.patch) % 1) + 1) % 1;
    const fx = u * N;
    const fz = v * N;
    const x0 = Math.floor(fx) % N;
    const z0 = Math.floor(fz) % N;
    const x1 = (x0 + 1) % N;
    const z1 = (z0 + 1) % N;
    const tx = fx - Math.floor(fx);
    const tz = fz - Math.floor(fz);
    const a = field[z0 * N + x0];
    const b = field[z0 * N + x1];
    const c = field[z1 * N + x0];
    const d = field[z1 * N + x1];
    return a + (b - a) * tx + (c - a) * tz + (a - b - c + d) * tx * tz;
  }

  sample(x, z) {
    return {
      y: this._sample(this.height, x, z),
      dx: this._sample(this.dispX, x, z),
      dz: this._sample(this.dispZ, x, z),
    };
  }
}

export class CpuMirror {
  constructor(options = {}) {
    const N = options.N ?? DEFAULT_N;
    this.N = N;
    this.choppiness = options.choppiness ?? 1.0;
    this.cascadeCount = options.cascadeCount ?? 2;
    this.options = options;
    this._build();
  }

  _build() {
    const o = this.options;
    this.cascades = [];
    for (let c = 0; c < this.cascadeCount; c++) {
      const cas = CASCADES[c];
      // The mirror must cover the same WAVENUMBER BAND as the GPU cascade, but
      // at N=64 it cannot do that with the GPU's patch size: patch 2048 at N=64
      // reaches only k=0.098 while the band runs to 0.393, losing most of the
      // energy and leaving the boat riding a near-flat sea. Shrinking the patch
      // to match this N covers the band fully.
      //
      // TRADE-OFF: the spectrum's noise is drawn per grid cell, so a different
      // patch means different phases. The mirror is statistically identical to
      // the drawn sea but not phase-identical. That is acceptable only because
      // it is the degraded path — riding a plausible sea beats riding the real
      // sea as it was two seconds ago.
      const patch = Math.floor((Math.PI * this.N) / cas.kHigh);
      this.cascades.push(
        new MirrorCascade({
          N: this.N,
          patch,
          kLow: cas.kLow,
          kHigh: cas.kHigh,
          windSpeed: o.windSpeed ?? 11,
          windDir: o.windDir ?? [0.85, 0.53],
          fetch: o.fetch ?? 100000,
          gamma: o.gamma ?? 3.3,
          depth: o.depth ?? 1000,
          // Must match OceanSimulation's per-cascade seed offset exactly, or the
          // mirror describes a different sea from the one being drawn.
          seed: (o.seed ?? 0x0ce4a) + c * 7919,
        }),
      );
    }
  }

  setSeaState({ windSpeed, choppiness, fetch, gamma }) {
    if (windSpeed !== undefined) this.options.windSpeed = windSpeed;
    if (fetch !== undefined) this.options.fetch = fetch;
    if (gamma !== undefined) this.options.gamma = gamma;
    if (choppiness !== undefined) this.choppiness = choppiness;
    this._build();
  }

  update(t) {
    for (const c of this.cascades) c.update(t, this.choppiness);
  }

  /** Summed surface state at world XZ. Exact for this frame — no latency. */
  sample(x, z) {
    let y = 0;
    let dx = 0;
    let dz = 0;
    for (const c of this.cascades) {
      const s = c.sample(x, z);
      y += s.y;
      dx += s.dx;
      dz += s.dz;
    }
    return { y, dx, dz, foam: 0 };
  }
}
