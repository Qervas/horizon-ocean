import { test } from "node:test";
import assert from "node:assert/strict";
import {
  jonswap,
  donelanBanner,
  peakOmega,
  dispersion,
  buildInitialSpectrum,
  CASCADES,
  FFT_N,
  LOOP_PERIOD,
} from "../../js/ocean/spectrum.js";

const U = 12;
const F = 100000;

test("JONSWAP peaks at the peak frequency", () => {
  const wp = peakOmega(U, F);
  const at = jonswap(wp, U, F);
  for (const m of [0.6, 0.8, 0.95, 1.05, 1.25, 1.6]) {
    assert.ok(jonswap(wp * m, U, F) < at, `${m}*wp had more energy than the peak`);
  }
});

test("JONSWAP is finite and non-negative across a wide band", () => {
  for (let w = 0.01; w < 30; w += 0.01) {
    const s = jonswap(w, U, F);
    assert.ok(Number.isFinite(s) && s >= 0, `bad S at omega=${w}: ${s}`);
  }
});

test("JONSWAP is zero, not NaN, at omega=0", () => {
  assert.equal(jonswap(0, U, F), 0);
});

test("directional spreading is symmetric about the wind direction", () => {
  const wp = peakOmega(U, F);
  for (const w of [wp * 0.7, wp, wp * 1.4, wp * 3]) {
    assert.ok(Math.abs(donelanBanner(w, wp, 0.3) - donelanBanner(w, wp, -0.3)) < 1e-9);
  }
});

test("directional spreading integrates to one", () => {
  const wp = peakOmega(U, F);
  for (const w of [wp * 0.7, wp, wp * 1.4, wp * 3]) {
    let sum = 0;
    const steps = 20000;
    const d = (2 * Math.PI) / steps;
    for (let i = 0; i < steps; i++) sum += donelanBanner(w, wp, -Math.PI + i * d) * d;
    assert.ok(Math.abs(sum - 1) < 0.05, `omega=${w} integrates to ${sum}`);
  }
});

test("directional spreading is finite even for extreme frequency ratios", () => {
  // Far from the peak the fitted beta explodes; unclamped it produces a
  // delta function narrower than any grid cell, or Infinity.
  const wp = peakOmega(U, F);
  for (const w of [wp * 0.01, wp * 0.2, wp * 50, wp * 500]) {
    for (const theta of [0, 0.5, Math.PI]) {
      assert.ok(Number.isFinite(donelanBanner(w, wp, theta)), `not finite at w=${w} th=${theta}`);
    }
  }
});

test("dispersion is quantised to the loop period", () => {
  const w0 = (2 * Math.PI) / LOOP_PERIOD;
  for (const k of [0.01, 0.5, 3, 20]) {
    const w = dispersion(k, 1000);
    const n = w / w0;
    assert.ok(Math.abs(n - Math.round(n)) < 1e-9, `omega ${w} is not a multiple of ${w0}`);
  }
});

test("dispersion increases with wavenumber", () => {
  let prev = -1;
  for (const k of [0.01, 0.1, 1, 5, 25]) {
    const w = dispersion(k, 1000);
    assert.ok(w >= prev, `dispersion not monotonic at k=${k}`);
    prev = w;
  }
});

test("cascade bands tile the spectrum with no overlap and no gaps", () => {
  assert.equal(CASCADES.length, 4);
  assert.equal(CASCADES[0].kLow, 0);
  for (let i = 1; i < CASCADES.length; i++) {
    assert.equal(CASCADES[i].kLow, CASCADES[i - 1].kHigh, `gap or overlap at cascade ${i}`);
  }
});

test("each cascade band stays within its own Nyquist", () => {
  for (const c of CASCADES) {
    const nyquist = (Math.PI * FFT_N) / c.patch;
    assert.ok(c.kHigh <= nyquist + 1e-9, `patch ${c.patch} band exceeds its Nyquist`);
  }
});

test("cascade patch sizes are the agreed values", () => {
  assert.deepEqual(
    CASCADES.map((c) => c.patch),
    [2048, 512, 128, 32],
  );
});

const baseOpts = {
  N: 64,
  patch: 512,
  windSpeed: U,
  windDir: [0.85, 0.53],
  fetch: F,
  depth: 1000,
  seed: 0x0ce4a,
};

test("initial spectrum is the right size and free of NaN", () => {
  const d = buildInitialSpectrum({ ...baseOpts, kLow: 0, kHigh: 100 });
  assert.equal(d.length, 64 * 64 * 4);
  for (let i = 0; i < d.length; i++) assert.ok(Number.isFinite(d[i]), `non-finite at ${i}`);
  assert.ok(d.some((v) => v !== 0), "spectrum is entirely zero");
});

test("energy outside the band is exactly zero", () => {
  const N = 64;
  const patch = 512;
  const kLow = 0.1;
  const kHigh = 0.3;
  const d = buildInitialSpectrum({ ...baseOpts, N, patch, kLow, kHigh });
  let inBand = 0;
  for (let m = 0; m < N; m++) {
    for (let n = 0; n < N; n++) {
      const kx = ((n < N / 2 ? n : n - N) * 2 * Math.PI) / patch;
      const kz = ((m < N / 2 ? m : m - N) * 2 * Math.PI) / patch;
      const k = Math.hypot(kx, kz);
      const i = (m * N + n) * 4;
      if (k < kLow || k >= kHigh) {
        assert.equal(d[i], 0, `energy at k=${k}, outside [${kLow}, ${kHigh})`);
        assert.equal(d[i + 1], 0);
      } else if (d[i] !== 0 || d[i + 1] !== 0) {
        inBand++;
      }
    }
  }
  assert.ok(inBand > 0, "no energy anywhere inside the band");
});

test("the k=0 mode is zero rather than NaN", () => {
  const d = buildInitialSpectrum({ ...baseOpts, kLow: 0, kHigh: 100 });
  // `===` rather than assert.equal: negating a zero imaginary part yields -0,
  // which SameValue treats as distinct but which is arithmetically identical
  // everywhere downstream.
  assert.ok(d[0] === 0, `h0.re was ${d[0]}`);
  assert.ok(d[1] === 0, `h0.im was ${d[1]}`);
  assert.ok(d[2] === 0, `conj.re was ${d[2]}`);
  assert.ok(d[3] === 0, `conj.im was ${d[3]}`);
});

test("the same seed produces the same sea", () => {
  const a = buildInitialSpectrum({ ...baseOpts, kLow: 0, kHigh: 100, seed: 42 });
  const b = buildInitialSpectrum({ ...baseOpts, kLow: 0, kHigh: 100, seed: 42 });
  const c = buildInitialSpectrum({ ...baseOpts, kLow: 0, kHigh: 100, seed: 43 });
  assert.deepEqual(Array.from(a), Array.from(b));
  assert.notDeepEqual(Array.from(a), Array.from(c));
});

test("BA channels hold the conjugate of the mirrored mode", () => {
  // h(k,t) = h0(k)e^{iwt} + conj(h0(-k))e^{-iwt} needs conj(h0(-k)) available
  // in one fetch. Getting the mirror index wrong yields a plausible but
  // non-real height field.
  const N = 64;
  const d = buildInitialSpectrum({ ...baseOpts, N, kLow: 0, kHigh: 100 });
  for (const [m, n] of [[3, 5], [10, 61], [32, 32], [0, 7]]) {
    const i = (m * N + n) * 4;
    const mm = m === 0 ? 0 : N - m;
    const nn = n === 0 ? 0 : N - n;
    const j = (mm * N + nn) * 4;
    assert.ok(Math.abs(d[i + 2] - d[j]) < 1e-12, `conj re mismatch at ${m},${n}`);
    assert.ok(Math.abs(d[i + 3] + d[j + 1]) < 1e-12, `conj im mismatch at ${m},${n}`);
  }
});

test("stronger wind produces more energy", () => {
  const sumSq = (d) => d.reduce((a, v) => a + v * v, 0);
  const calm = buildInitialSpectrum({ ...baseOpts, kLow: 0, kHigh: 100, windSpeed: 5 });
  const storm = buildInitialSpectrum({ ...baseOpts, kLow: 0, kHigh: 100, windSpeed: 20 });
  assert.ok(sumSq(storm) > sumSq(calm), "storm sea is not more energetic than calm");
});
