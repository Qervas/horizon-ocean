import { test } from "node:test";
import assert from "node:assert/strict";
import { invertDisplacement, extrapolate, rollingAverage } from "../../js/ocean/probeMath.js";

/**
 * Analytic horizontal displacement standing in for the FFT's chop.
 * Amplitude is kept inside the contraction limit (A*k < 1), which is the same
 * condition real choppiness must satisfy to avoid wave self-intersection.
 */
function makeDisplacement(amp, k) {
  return (x, z) => [amp * Math.sin(k * x + 0.7), amp * Math.cos(k * z - 0.3)];
}

test("inversion recovers a known displaced position", () => {
  const D = makeDisplacement(0.8, 0.35);
  for (const [px, pz] of [[0, 0], [3.2, -7.1], [-12.5, 4.4], [100, 100]]) {
    const [dx, dz] = D(px, pz);
    const target = [px + dx, pz + dz];
    const [rx, rz] = invertDisplacement(target, D, 3);
    assert.ok(Math.hypot(rx - px, rz - pz) < 1e-2, `recovered ${rx},${rz} from ${px},${pz}`);
  }
});

test("inversion is exact for zero displacement", () => {
  const [x, z] = invertDisplacement([5, -3], () => [0, 0], 3);
  assert.equal(x, 5);
  assert.equal(z, -3);
});

test("inversion converges further with more iterations", () => {
  const D = makeDisplacement(1.4, 0.5);
  const px = 2.0;
  const pz = -1.0;
  const [dx, dz] = D(px, pz);
  const target = [px + dx, pz + dz];

  const err = (n) => {
    const [rx, rz] = invertDisplacement(target, D, n);
    return Math.hypot(rx - px, rz - pz);
  };
  const e1 = err(1);
  const e3 = err(3);
  const e6 = err(6);
  assert.ok(e3 < e1, `3 iterations (${e3}) not better than 1 (${e1})`);
  assert.ok(e6 <= e3 + 1e-12, `6 iterations (${e6}) worse than 3 (${e3})`);
});

test("three iterations suffice for storm-scale chop", () => {
  // Chop this steep is beyond what the sim produces; if 3 iterations hold here
  // they hold everywhere.
  const D = makeDisplacement(1.2, 0.45);
  let worst = 0;
  for (let i = 0; i < 200; i++) {
    const px = (i % 20) * 3.1 - 30;
    const pz = Math.floor(i / 20) * 2.7 - 25;
    const [dx, dz] = D(px, pz);
    const [rx, rz] = invertDisplacement([px + dx, pz + dz], D, 3);
    worst = Math.max(worst, Math.hypot(rx - px, rz - pz));
  }
  assert.ok(worst < 0.15, `worst-case inversion error ${worst} m`);
});

test("naive sampling without inversion is measurably wrong", () => {
  // Guards the reason inversion exists at all: if this ever became small, the
  // fixed-point loop would be dead weight.
  const D = makeDisplacement(0.8, 0.35);
  let worst = 0;
  for (let i = 0; i < 100; i++) {
    const px = i * 0.63 - 30;
    const pz = i * 0.41 - 20;
    const [dx, dz] = D(px, pz);
    worst = Math.max(worst, Math.hypot(dx, dz));
  }
  assert.ok(worst > 0.5, `displacement is too small to matter (${worst} m)`);
});

test("extrapolation is exact for constant velocity", () => {
  const [x, z] = extrapolate([10, 20], [3, -4], 0.5);
  assert.ok(Math.abs(x - 11.5) < 1e-9);
  assert.ok(Math.abs(z - 18) < 1e-9);
});

test("extrapolation is a no-op at zero latency", () => {
  const [x, z] = extrapolate([10, 20], [3, -4], 0);
  assert.equal(x, 10);
  assert.equal(z, 20);
});

test("rolling average converges toward the input", () => {
  let avg = 0;
  for (let i = 0; i < 200; i++) avg = rollingAverage(avg, 0.05, 0.1);
  assert.ok(Math.abs(avg - 0.05) < 1e-3, `converged to ${avg}`);
});

test("rolling average ignores non-finite samples", () => {
  // A rejected readback must not poison the latency estimate.
  let avg = rollingAverage(0.02, NaN, 0.2);
  assert.equal(avg, 0.02);
  avg = rollingAverage(0.02, Infinity, 0.2);
  assert.equal(avg, 0.02);
});
