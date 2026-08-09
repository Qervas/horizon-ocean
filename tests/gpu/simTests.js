import { OceanSimulation } from "../../js/ocean/oceanSimulation.js";
import { buildInitialSpectrum, LOOP_PERIOD, GRAVITY } from "../../js/ocean/spectrum.js";
import { renderer, assert, readAttachment } from "./gpuTests.js";

const reg = (name, fn) => window.__gpuTests.register(name, fn);

const N = 16;
const PATCH = 128;
const DEPTH = 1000;
const CHOP = 1.0;
const SEED = 0x0ce4a;
const TIME = 3.25;

// A deliberately narrow band keeps the field smooth, so the finite-difference
// oracle below is accurate. Testing derivative correctness against a noisy
// near-Nyquist field would only measure the oracle's own truncation error.
const TEST_CASCADE = { patch: PATCH, kLow: 0, kHigh: (Math.PI * N) / PATCH / 4 };

function makeSim() {
  return new OceanSimulation(renderer, {
    N,
    cascades: [TEST_CASCADE],
    windSpeed: 12,
    windDir: [0.85, 0.53],
    fetch: 100000,
    depth: DEPTH,
    seed: SEED,
    choppiness: CHOP,
  });
}

/** The exact h0 the simulation built for cascade 0. */
function referenceH0() {
  return buildInitialSpectrum({
    N,
    patch: TEST_CASCADE.patch,
    kLow: TEST_CASCADE.kLow,
    kHigh: TEST_CASCADE.kHigh,
    windSpeed: 12,
    windDir: [0.85, 0.53],
    fetch: 100000,
    depth: DEPTH,
    seed: SEED + 0 * 7919,
  });
}

function cmul(ar, ai, br, bi) {
  return [ar * br - ai * bi, ar * bi + ai * br];
}

/**
 * Direct spatial-domain sum of the evolved spectrum. Independent of both the
 * evolve shader and the FFT — the only shared input is h0 itself.
 * Returns the packed complex field (Dy + i*Dx) so the packing is under test too.
 */
function referenceSpatial(h0, t) {
  const dk = (2 * Math.PI) / PATCH;
  const w0 = (2 * Math.PI) / LOOP_PERIOD;
  const out = new Float32Array(N * N * 2);

  for (let py = 0; py < N; py++) {
    for (let px = 0; px < N; px++) {
      let sumRe = 0;
      let sumIm = 0;
      for (let m = 0; m < N; m++) {
        for (let n = 0; n < N; n++) {
          const i = (m * N + n) * 4;
          const kxIdx = n < N / 2 ? n : n - N;
          const kzIdx = m < N / 2 ? m : m - N;
          const kx = kxIdx * dk;
          const kz = kzIdx * dk;
          const k = Math.hypot(kx, kz);
          if (k < 1e-6) continue;

          const omegaRaw = Math.sqrt(GRAVITY * k * Math.tanh(Math.min(k * DEPTH, 20)));
          const omega = Math.floor(omegaRaw / w0) * w0;
          const c = Math.cos(omega * t);
          const s = Math.sin(omega * t);

          const [a1r, a1i] = cmul(h0[i], h0[i + 1], c, s);
          const [a2r, a2i] = cmul(h0[i + 2], h0[i + 3], c, -s);
          const hyR = a1r + a2r;
          const hyI = a1i + a2i;

          // hx = -i (kx/k) hy
          const [hxR, hxI] = cmul(hyR, hyI, 0, -1);
          const sx = (kx / k) * CHOP;
          const hxRs = hxR * sx;
          const hxIs = hxI * sx;

          // packed = hy + i*hx
          const pr = hyR - hxIs;
          const pi = hyI + hxRs;

          const ang = (2 * Math.PI * (n * px + m * py)) / N;
          const cc = Math.cos(ang);
          const ss = Math.sin(ang);
          sumRe += pr * cc - pi * ss;
          sumIm += pr * ss + pi * cc;
        }
      }
      out[(py * N + px) * 2] = sumRe;
      out[(py * N + px) * 2 + 1] = sumIm;
    }
  }
  return out;
}

reg("evolve + FFT match a direct spatial-domain sum", async () => {
  const sim = makeSim();
  sim.update(TIME, 1 / 60);

  const gpu = readAttachment(sim.fftTargets[0], 0, N);
  const expected = referenceSpatial(referenceH0(), TIME);

  let maxErr = 0;
  let scale = 0;
  for (let i = 0; i < N * N; i++) {
    for (let c = 0; c < 2; c++) {
      const e = expected[i * 2 + c];
      const a = gpu[i * 4 + c];
      maxErr = Math.max(maxErr, Math.abs(e - a));
      scale = Math.max(scale, Math.abs(e));
    }
  }
  sim.dispose();
  const rel = maxErr / Math.max(scale, 1e-9);
  assert(rel < 1e-2, `relative error ${rel} (abs ${maxErr}, scale ${scale})`);
});

reg("height field is real-valued", async () => {
  // Dy comes out of the real lane. If Hermitian symmetry in h0 were wrong, the
  // imaginary residue would be non-negligible and the surface would ripple with
  // a phantom component.
  const sim = makeSim();
  sim.update(TIME, 1 / 60);
  const gpu = readAttachment(sim.fftTargets[0], 0, N);

  let maxDy = 0;
  for (let i = 0; i < N * N; i++) maxDy = Math.max(maxDy, Math.abs(gpu[i * 4]));
  sim.dispose();
  assert(maxDy > 1e-5, `height field is flat (max |Dy| = ${maxDy}) — spectrum produced nothing`);
});

reg("spectral derivatives match finite differences of the displacement", async () => {
  const sim = makeSim();
  sim.update(TIME, 1 / 60);

  const a = readAttachment(sim.fftTargets[0], 0, N); // (Dy, Dx, Dz, dDy_dx)
  const b = readAttachment(sim.fftTargets[0], 1, N); // (dDy_dz, dDx_dx, dDz_dz, dDx_dz)
  sim.dispose();

  const h = PATCH / N;
  const at = (px, py, buf, comp) => buf[(((py + N) % N) * N + ((px + N) % N)) * 4 + comp];

  let maxRelDy = 0;
  let maxRelDx = 0;
  let scaleDy = 0;
  let scaleDx = 0;
  const errsDy = [];
  const errsDx = [];

  for (let py = 0; py < N; py++) {
    for (let px = 0; px < N; px++) {
      // Central differences, second-order accurate on a smooth field.
      const fdDy = (at(px + 1, py, a, 0) - at(px - 1, py, a, 0)) / (2 * h);
      const fdDx = (at(px + 1, py, a, 1) - at(px - 1, py, a, 1)) / (2 * h);
      const specDy = at(px, py, a, 3);
      const specDx = at(px, py, b, 1);
      errsDy.push(Math.abs(fdDy - specDy));
      errsDx.push(Math.abs(fdDx - specDx));
      scaleDy = Math.max(scaleDy, Math.abs(specDy));
      scaleDx = Math.max(scaleDx, Math.abs(specDx));
    }
  }
  maxRelDy = Math.max(...errsDy) / Math.max(scaleDy, 1e-9);
  maxRelDx = Math.max(...errsDx) / Math.max(scaleDx, 1e-9);

  assert(scaleDy > 1e-9, "dDy/dx field is identically zero");
  assert(maxRelDy < 0.08, `dDy/dx relative error ${maxRelDy}`);
  assert(maxRelDx < 0.08, `dDx/dx relative error ${maxRelDx}`);
});

reg("no NaN or Inf anywhere in the cascade outputs", async () => {
  const sim = new OceanSimulation(renderer, { N: 32 });
  sim.update(1.0, 1 / 60);
  sim.update(1.5, 1 / 60);

  for (let c = 0; c < sim.cascades.length; c++) {
    for (const idx of [0, 1]) {
      const buf = readAttachment(sim.outputs[c][sim.current], idx, 32);
      for (let i = 0; i < buf.length; i++) {
        if (!Number.isFinite(buf[i])) {
          sim.dispose();
          assert(false, `cascade ${c} attachment ${idx} has ${buf[i]} at ${i}`);
        }
      }
    }
  }
  sim.dispose();
});

reg("foam accumulates under folding and decays when it stops", async () => {
  // A very low foam threshold guarantees injection regardless of sea state, so
  // this measures the accumulate/decay mechanism rather than the spectrum.
  const sim = new OceanSimulation(renderer, {
    N: 32,
    cascades: [{ patch: 128, kLow: 0, kHigh: (Math.PI * 32) / 128 }],
    foamThreshold: 5.0,
    foamGain: 1.0,
    foamDecayRate: 2.0,
  });

  let t = 0;
  for (let i = 0; i < 5; i++) sim.update((t += 1 / 60), 1 / 60);
  const grown = readAttachment(sim.outputs[0][sim.current], 0, 32);
  let maxGrown = 0;
  for (let i = 0; i < 32 * 32; i++) maxGrown = Math.max(maxGrown, grown[i * 4 + 3]);

  // Stop injection and let it decay.
  sim.assembleMaterial.uniforms.uFoamThreshold.value = -10;
  for (let i = 0; i < 60; i++) sim.update((t += 1 / 60), 1 / 60);
  const decayed = readAttachment(sim.outputs[0][sim.current], 0, 32);
  let maxDecayed = 0;
  for (let i = 0; i < 32 * 32; i++) maxDecayed = Math.max(maxDecayed, decayed[i * 4 + 3]);

  sim.dispose();
  assert(maxGrown > 0.01, `foam never accumulated (max ${maxGrown})`);
  assert(maxDecayed < maxGrown * 0.9, `foam did not decay (${maxGrown} -> ${maxDecayed})`);
});
