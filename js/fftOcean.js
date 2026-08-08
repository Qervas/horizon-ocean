/**
 * Tessendorf-style FFT ocean displacement (CPU, 64² for realtime).
 * Phillips spectrum → complex amplitudes → iFFT → height + chop.
 * Used as large-scale displacement; Gerstner fills high-frequency detail in the shader.
 */

const N = 64;
const N2 = N * N;

function bitReverse(x, bits) {
  let y = 0;
  for (let i = 0; i < bits; i++) {
    y = (y << 1) | (x & 1);
    x >>= 1;
  }
  return y;
}

/** In-place radix-2 FFT on interleaved complex arrays (re[], im[]), length power of 2. */
function fft1d(re, im, inverse) {
  const n = re.length;
  const bits = Math.log2(n) | 0;
  for (let i = 0; i < n; i++) {
    const j = bitReverse(i, bits);
    if (j > i) {
      let t = re[i]; re[i] = re[j]; re[j] = t;
      t = im[i]; im[i] = im[j]; im[j] = t;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const half = len >> 1;
    const ang = ((inverse ? 2 : -2) * Math.PI) / len;
    const wlr = Math.cos(ang);
    const wli = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let wr = 1, wi = 0;
      for (let j = 0; j < half; j++) {
        const u = i + j;
        const v = u + half;
        const tr = wr * re[v] - wi * im[v];
        const ti = wr * im[v] + wi * re[v];
        re[v] = re[u] - tr;
        im[v] = im[u] - ti;
        re[u] += tr;
        im[u] += ti;
        const nwr = wr * wlr - wi * wli;
        wi = wr * wli + wi * wlr;
        wr = nwr;
      }
    }
  }
  if (inverse) {
    const inv = 1 / n;
    for (let i = 0; i < n; i++) {
      re[i] *= inv;
      im[i] *= inv;
    }
  }
}

function fft2d(re, im, inverse) {
  const rowRe = new Float32Array(N);
  const rowIm = new Float32Array(N);
  // rows
  for (let y = 0; y < N; y++) {
    const off = y * N;
    for (let x = 0; x < N; x++) {
      rowRe[x] = re[off + x];
      rowIm[x] = im[off + x];
    }
    fft1d(rowRe, rowIm, inverse);
    for (let x = 0; x < N; x++) {
      re[off + x] = rowRe[x];
      im[off + x] = rowIm[x];
    }
  }
  // cols
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

function gaussian() {
  // Box-Muller
  let u = 0, v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  const mag = Math.sqrt(-2 * Math.log(u));
  return [mag * Math.cos(2 * Math.PI * v), mag * Math.sin(2 * Math.PI * v)];
}

export class FFTOcean {
  constructor(options = {}) {
    this.N = N;
    this.patch = options.patchSize ?? 180; // meters covered by the FFT tile
    this.windSpeed = options.windSpeed ?? 12;
    this.windDir = options.windDir ?? [0.8, 0.6]; // xz
    this.A = options.A ?? 0.00035; // Phillips amplitude scale
    this.gravity = 9.81;
    this.choppiness = options.choppiness ?? 1.1;

    // Seed spectrum h̃0(k)
    this.h0Re = new Float32Array(N2);
    this.h0Im = new Float32Array(N2);
    this.h0NegRe = new Float32Array(N2); // h0(-k) conjugate partner
    this.h0NegIm = new Float32Array(N2);

    // Working buffers for time-evolved spectrum + iFFT
    this.htRe = new Float32Array(N2);
    this.htIm = new Float32Array(N2);
    this.dxRe = new Float32Array(N2);
    this.dxIm = new Float32Array(N2);
    this.dzRe = new Float32Array(N2);
    this.dzIm = new Float32Array(N2);

    // Output fields
    this.height = new Float32Array(N2);
    this.dispX = new Float32Array(N2);
    this.dispZ = new Float32Array(N2);
    this.jacobian = new Float32Array(N2);

    this._seedSpectrum();
    this.time = 0;
  }

  setSeaScale(scale) {
    // Remap wind / amplitude from weather preset
    this.windSpeed = 6 + scale * 14;
    this.A = 0.00012 + scale * 0.00045;
    this.choppiness = 0.85 + scale * 0.45;
    this._seedSpectrum();
  }

  _kVector(n, m) {
    // Wavevector indices centered
    const kx = ((n < N / 2 ? n : n - N) * (2 * Math.PI)) / this.patch;
    const kz = ((m < N / 2 ? m : m - N) * (2 * Math.PI)) / this.patch;
    return [kx, kz];
  }

  _phillips(kx, kz) {
    const k2 = kx * kx + kz * kz;
    if (k2 < 1e-12) return 0;
    const L = (this.windSpeed * this.windSpeed) / this.gravity;
    const kLen = Math.sqrt(k2);
    const wd = this.windDir;
    const wLen = Math.hypot(wd[0], wd[1]) || 1;
    const kdotw = (kx * wd[0] + kz * wd[1]) / (kLen * wLen);
    // Suppress waves against the wind
    const dir = kdotw < 0 ? 0 : kdotw * kdotw;
    const damp = Math.exp(-k2 * (L * 0.001) * (L * 0.001)); // suppress tiny ripples
    return this.A * (Math.exp(-1 / (k2 * L * L)) / (k2 * k2)) * dir * damp;
  }

  _seedSpectrum() {
    for (let m = 0; m < N; m++) {
      for (let n = 0; n < N; n++) {
        const i = m * N + n;
        const [kx, kz] = this._kVector(n, m);
        const p = this._phillips(kx, kz);
        const [xi_r, xi_i] = gaussian();
        const s = Math.sqrt(Math.max(p, 0) * 0.5);
        this.h0Re[i] = s * xi_r;
        this.h0Im[i] = s * xi_i;

        // h0(-k)
        const nn = n === 0 ? 0 : N - n;
        const mm = m === 0 ? 0 : N - m;
        // Will fill conjugate properly after full pass
      }
    }
    // Build h0*(-k) from h0(k)
    for (let m = 0; m < N; m++) {
      for (let n = 0; n < N; n++) {
        const i = m * N + n;
        const nn = n === 0 ? 0 : N - n;
        const mm = m === 0 ? 0 : N - m;
        const j = mm * N + nn;
        this.h0NegRe[i] = this.h0Re[j];
        this.h0NegIm[i] = -this.h0Im[j];
      }
    }
  }

  /** Evolve spectrum to time t and inverse-FFT into height / chop fields. */
  update(t) {
    this.time = t;
    const g = this.gravity;
    for (let m = 0; m < N; m++) {
      for (let n = 0; n < N; n++) {
        const i = m * N + n;
        const [kx, kz] = this._kVector(n, m);
        const kLen = Math.hypot(kx, kz);
        const omega = Math.sqrt(g * kLen);
        const cos = Math.cos(omega * t);
        const sin = Math.sin(omega * t);

        // h̃(k,t) = h0(k) e^{iωt} + h0*(-k) e^{-iωt}
        const h0r = this.h0Re[i], h0i = this.h0Im[i];
        const h0nr = this.h0NegRe[i], h0ni = this.h0NegIm[i];
        // h0 * (cos + i sin) + h0n * (cos - i sin)
        const re =
          h0r * cos - h0i * sin + h0nr * cos - h0ni * (-sin);
        const im =
          h0r * sin + h0i * cos + h0nr * (-sin) + h0ni * cos;
        this.htRe[i] = re;
        this.htIm[i] = im;

        // Displacement: ~ i (k/|k|) h̃
        if (kLen > 1e-6) {
          const kxnk = kx / kLen;
          const kznk = kz / kLen;
          // multiply by i => (-im, re)
          this.dxRe[i] = -im * kxnk * this.choppiness;
          this.dxIm[i] = re * kxnk * this.choppiness;
          this.dzRe[i] = -im * kznk * this.choppiness;
          this.dzIm[i] = re * kznk * this.choppiness;
        } else {
          this.dxRe[i] = this.dxIm[i] = 0;
          this.dzRe[i] = this.dzIm[i] = 0;
        }
      }
    }

    fft2d(this.htRe, this.htIm, true);
    fft2d(this.dxRe, this.dxIm, true);
    fft2d(this.dzRe, this.dzIm, true);

    // Sign-flip checkerboard (FFT centering) and store
    for (let m = 0; m < N; m++) {
      for (let n = 0; n < N; n++) {
        const i = m * N + n;
        const sign = (n + m) & 1 ? -1 : 1;
        this.height[i] = this.htRe[i] * sign;
        this.dispX[i] = this.dxRe[i] * sign;
        this.dispZ[i] = this.dzRe[i] * sign;
      }
    }

    // Approximate Jacobian for foam from finite differences of displacement
    for (let m = 0; m < N; m++) {
      for (let n = 0; n < N; n++) {
        const i = m * N + n;
        const n1 = (n + 1) % N;
        const m1 = (m + 1) % N;
        const dDx_dx = (this.dispX[m * N + n1] - this.dispX[i]) * (N / this.patch);
        const dDz_dz = (this.dispZ[m1 * N + n] - this.dispZ[i]) * (N / this.patch);
        const dDx_dz = (this.dispX[m1 * N + n] - this.dispX[i]) * (N / this.patch);
        const dDz_dx = (this.dispZ[m * N + n1] - this.dispZ[i]) * (N / this.patch);
        const jxx = 1 + dDx_dx;
        const jzz = 1 + dDz_dz;
        const jxz = dDx_dz;
        const jzx = dDz_dx;
        this.jacobian[i] = jxx * jzz - jxz * jzx;
      }
    }
  }

  /** Bilinear sample height + horizontal displacement at world xz (tiled). */
  sample(x, z) {
    const u = ((x / this.patch) % 1 + 1) % 1;
    const v = ((z / this.patch) % 1 + 1) % 1;
    const fx = u * N;
    const fz = v * N;
    const x0 = Math.floor(fx) % N;
    const z0 = Math.floor(fz) % N;
    const x1 = (x0 + 1) % N;
    const z1 = (z0 + 1) % N;
    const tx = fx - Math.floor(fx);
    const tz = fz - Math.floor(fz);

    const at = (xi, zi) => {
      const i = zi * N + xi;
      return [this.height[i], this.dispX[i], this.dispZ[i], this.jacobian[i]];
    };
    const a = at(x0, z0);
    const b = at(x1, z0);
    const c = at(x0, z1);
    const d = at(x1, z1);
    const lerp = (p, q, t) => p + (q - p) * t;
    const h0 = lerp(a[0], b[0], tx);
    const h1 = lerp(c[0], d[0], tx);
    const dx0 = lerp(a[1], b[1], tx);
    const dx1 = lerp(c[1], d[1], tx);
    const dz0 = lerp(a[2], b[2], tx);
    const dz1 = lerp(c[2], d[2], tx);
    const j0 = lerp(a[3], b[3], tx);
    const j1 = lerp(c[3], d[3], tx);
    return {
      y: lerp(h0, h1, tz),
      dx: lerp(dx0, dx1, tz),
      dz: lerp(dz0, dz1, tz),
      jacobian: lerp(j0, j1, tz),
    };
  }

  /** Pack height into RGBA8 texture data (height in R, jacobian foam in G). */
  fillTextureData(data /* Uint8Array N*N*4 */) {
    let minH = Infinity, maxH = -Infinity;
    for (let i = 0; i < N2; i++) {
      if (this.height[i] < minH) minH = this.height[i];
      if (this.height[i] > maxH) maxH = this.height[i];
    }
    const range = Math.max(maxH - minH, 1e-4);
    this._heightMin = minH;
    this._heightRange = range;
    for (let i = 0; i < N2; i++) {
      const hn = (this.height[i] - minH) / range;
      const foam = Math.max(0, Math.min(1, 1 - this.jacobian[i]));
      const dxn = this.dispX[i] * 0.05 + 0.5;
      const dzn = this.dispZ[i] * 0.05 + 0.5;
      const o = i * 4;
      data[o] = Math.max(0, Math.min(255, hn * 255));
      data[o + 1] = Math.max(0, Math.min(255, foam * 255));
      data[o + 2] = Math.max(0, Math.min(255, dxn * 255));
      data[o + 3] = Math.max(0, Math.min(255, dzn * 255));
    }
  }

  get heightMin() { return this._heightMin ?? 0; }
  get heightRange() { return this._heightRange ?? 1; }
}

export const FFT_N = N;
