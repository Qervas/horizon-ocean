/**
 * Tessendorf-style FFT ocean (CPU, 128²).
 * Phillips spectrum → complex amplitudes → iFFT → height + chop + Jacobian foam.
 * Large-scale swell; Gerstner + micro-normals fill high frequency in the shader.
 */

const N = 128;
const N2 = N * N;
const LOG_N = 7; // log2(128)

function bitReverse(x, bits) {
  let y = 0;
  for (let i = 0; i < bits; i++) {
    y = (y << 1) | (x & 1);
    x >>= 1;
  }
  return y;
}

/** Precomputed bit-reversal table for length N. */
const BR = new Uint16Array(N);
for (let i = 0; i < N; i++) BR[i] = bitReverse(i, LOG_N);

/** In-place radix-2 FFT on real/imag arrays of length power-of-two. */
function fft1d(re, im, inverse) {
  const n = re.length;
  const bits = Math.log2(n) | 0;
  for (let i = 0; i < n; i++) {
    const j = bits === LOG_N ? BR[i] : bitReverse(i, bits);
    if (j > i) {
      let t = re[i];
      re[i] = re[j];
      re[j] = t;
      t = im[i];
      im[i] = im[j];
      im[j] = t;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const half = len >> 1;
    const ang = ((inverse ? 2 : -2) * Math.PI) / len;
    const wlr = Math.cos(ang);
    const wli = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let wr = 1;
      let wi = 0;
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

function fft2d(re, im, inverse, rowRe, rowIm) {
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

function gaussian(rng) {
  let u = 0;
  let v = 0;
  while (u === 0) u = rng();
  while (v === 0) v = rng();
  const mag = Math.sqrt(-2 * Math.log(u));
  return [mag * Math.cos(2 * Math.PI * v), mag * Math.sin(2 * Math.PI * v)];
}

/** Simple mulberry32 for reproducible seas. */
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class FFTOcean {
  constructor(options = {}) {
    this.N = N;
    this.patch = options.patchSize ?? 220;
    this.windSpeed = options.windSpeed ?? 14;
    this.windDir = options.windDir ?? [0.85, 0.53];
    this.A = options.A ?? 0.00045;
    this.gravity = 9.81;
    this.choppiness = options.choppiness ?? 1.35;
    this.seed = options.seed ?? 0x0ce4a;

    this.h0Re = new Float32Array(N2);
    this.h0Im = new Float32Array(N2);
    this.h0NegRe = new Float32Array(N2);
    this.h0NegIm = new Float32Array(N2);

    this.htRe = new Float32Array(N2);
    this.htIm = new Float32Array(N2);
    this.dxRe = new Float32Array(N2);
    this.dxIm = new Float32Array(N2);
    this.dzRe = new Float32Array(N2);
    this.dzIm = new Float32Array(N2);

    this.height = new Float32Array(N2);
    this.dispX = new Float32Array(N2);
    this.dispZ = new Float32Array(N2);
    this.jacobian = new Float32Array(N2);

    // Precomputed k / omega tables
    this.kx = new Float32Array(N2);
    this.kz = new Float32Array(N2);
    this.kLen = new Float32Array(N2);
    this.omega = new Float32Array(N2);
    this.kxnk = new Float32Array(N2);
    this.kznk = new Float32Array(N2);

    this._rowRe = new Float32Array(N);
    this._rowIm = new Float32Array(N);

    this._heightMin = 0;
    this._heightRange = 1;
    this._smoothMin = 0;
    this._smoothMax = 1;
    this._smoothed = false;

    this._buildKTable();
    this._seedSpectrum();
    this.time = 0;
  }

  _buildKTable() {
    const g = this.gravity;
    for (let m = 0; m < N; m++) {
      for (let n = 0; n < N; n++) {
        const i = m * N + n;
        const kx = ((n < N / 2 ? n : n - N) * (2 * Math.PI)) / this.patch;
        const kz = ((m < N / 2 ? m : m - N) * (2 * Math.PI)) / this.patch;
        const kLen = Math.hypot(kx, kz);
        this.kx[i] = kx;
        this.kz[i] = kz;
        this.kLen[i] = kLen;
        this.omega[i] = Math.sqrt(g * kLen);
        if (kLen > 1e-8) {
          this.kxnk[i] = kx / kLen;
          this.kznk[i] = kz / kLen;
        } else {
          this.kxnk[i] = 0;
          this.kznk[i] = 0;
        }
      }
    }
  }

  setSeaScale(scale) {
    // scale ~1.0 calm (visible swell) … 1.65 storm
    this.windSpeed = 5.0 + scale * 12;
    this.A = 0.00012 + scale * 0.0005;
    this.choppiness = 0.85 + scale * 0.55;
    this._seedSpectrum();
  }

  _phillips(i) {
    const k2 = this.kx[i] * this.kx[i] + this.kz[i] * this.kz[i];
    if (k2 < 1e-12) return 0;
    const L = (this.windSpeed * this.windSpeed) / this.gravity;
    const kLen = this.kLen[i];
    const wd = this.windDir;
    const wLen = Math.hypot(wd[0], wd[1]) || 1;
    const kdotw = (this.kx[i] * wd[0] + this.kz[i] * wd[1]) / (kLen * wLen);
    // Cos^2 directionality; weak counter-wave leak for realism
    const dir = kdotw < 0 ? 0.08 * kdotw * kdotw : kdotw * kdotw;
    const l = L * 0.001;
    const damp = Math.exp(-k2 * l * l);
    // Phillips + gravity peak
    return this.A * (Math.exp(-1 / (k2 * L * L)) / (k2 * k2)) * dir * damp;
  }

  _seedSpectrum() {
    const rng = mulberry32(this.seed);
    for (let i = 0; i < N2; i++) {
      const p = this._phillips(i);
      const [xi_r, xi_i] = gaussian(rng);
      const s = Math.sqrt(Math.max(p, 0) * 0.5);
      this.h0Re[i] = s * xi_r;
      this.h0Im[i] = s * xi_i;
    }
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

  update(t) {
    this.time = t;
    const chop = this.choppiness;

    for (let i = 0; i < N2; i++) {
      const omega = this.omega[i];
      const cos = Math.cos(omega * t);
      const sin = Math.sin(omega * t);
      const h0r = this.h0Re[i];
      const h0i = this.h0Im[i];
      const h0nr = this.h0NegRe[i];
      const h0ni = this.h0NegIm[i];

      const re = h0r * cos - h0i * sin + h0nr * cos + h0ni * sin;
      const im = h0r * sin + h0i * cos - h0nr * sin + h0ni * cos;
      this.htRe[i] = re;
      this.htIm[i] = im;

      const kn = this.kLen[i];
      if (kn > 1e-6) {
        const kxnk = this.kxnk[i] * chop;
        const kznk = this.kznk[i] * chop;
        this.dxRe[i] = -im * kxnk;
        this.dxIm[i] = re * kxnk;
        this.dzRe[i] = -im * kznk;
        this.dzIm[i] = re * kznk;
      } else {
        this.dxRe[i] = this.dxIm[i] = 0;
        this.dzRe[i] = this.dzIm[i] = 0;
      }
    }

    const rowRe = this._rowRe;
    const rowIm = this._rowIm;
    fft2d(this.htRe, this.htIm, true, rowRe, rowIm);
    fft2d(this.dxRe, this.dxIm, true, rowRe, rowIm);
    fft2d(this.dzRe, this.dzIm, true, rowRe, rowIm);

    for (let m = 0; m < N; m++) {
      for (let n = 0; n < N; n++) {
        const i = m * N + n;
        const sign = (n + m) & 1 ? -1 : 1;
        this.height[i] = this.htRe[i] * sign;
        this.dispX[i] = this.dxRe[i] * sign;
        this.dispZ[i] = this.dzRe[i] * sign;
      }
    }

    const scale = N / this.patch;
    for (let m = 0; m < N; m++) {
      for (let n = 0; n < N; n++) {
        const i = m * N + n;
        const n1 = (n + 1) % N;
        const m1 = (m + 1) % N;
        const dDx_dx = (this.dispX[m * N + n1] - this.dispX[i]) * scale;
        const dDz_dz = (this.dispZ[m1 * N + n] - this.dispZ[i]) * scale;
        const dDx_dz = (this.dispX[m1 * N + n] - this.dispX[i]) * scale;
        const dDz_dx = (this.dispZ[m * N + n1] - this.dispZ[i]) * scale;
        this.jacobian[i] = (1 + dDx_dx) * (1 + dDz_dz) - dDx_dz * dDz_dx;
      }
    }
  }

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

  /**
   * Pack height / foam / chop into RGBA8.
   * Smooth min/max over time to avoid quantization flicker.
   */
  fillTextureData(data) {
    let minH = Infinity;
    let maxH = -Infinity;
    for (let i = 0; i < N2; i++) {
      const h = this.height[i];
      if (h < minH) minH = h;
      if (h > maxH) maxH = h;
    }

    if (!this._smoothed) {
      this._smoothMin = minH;
      this._smoothMax = maxH;
      this._smoothed = true;
    } else {
      const a = 0.08;
      this._smoothMin += (minH - this._smoothMin) * a;
      this._smoothMax += (maxH - this._smoothMax) * a;
    }

    // Pad range slightly so peaks don't clip
    const pad = (this._smoothMax - this._smoothMin) * 0.08 + 0.05;
    const sMin = this._smoothMin - pad;
    const sMax = this._smoothMax + pad;
    const range = Math.max(sMax - sMin, 1e-4);
    this._heightMin = sMin;
    this._heightRange = range;

    for (let i = 0; i < N2; i++) {
      const hn = (this.height[i] - sMin) / range;
      // Soft foam from folding (Jacobian < 1)
      const fold = Math.max(0, 1 - this.jacobian[i]);
      const foam = Math.min(1, fold * fold * 2.2);
      // Wider chop encode (±25 m)
      const dxn = this.dispX[i] * 0.04 + 0.5;
      const dzn = this.dispZ[i] * 0.04 + 0.5;
      const o = i * 4;
      data[o] = Math.max(0, Math.min(255, (hn * 255 + 0.5) | 0));
      data[o + 1] = Math.max(0, Math.min(255, (foam * 255 + 0.5) | 0));
      data[o + 2] = Math.max(0, Math.min(255, (dxn * 255 + 0.5) | 0));
      data[o + 3] = Math.max(0, Math.min(255, (dzn * 255 + 0.5) | 0));
    }
  }

  get heightMin() {
    return this._heightMin;
  }
  get heightRange() {
    return this._heightRange;
  }
}

export const FFT_N = N;
