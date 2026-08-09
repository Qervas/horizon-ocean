import { OceanSimulation } from "../../js/ocean/oceanSimulation.js";
import { renderer, assert, readAttachment } from "./gpuTests.js";

const reg = (name, fn) => window.__gpuTests.register(name, fn);

/** RMS and peak wave height across every cascade, in metres. */
function measureHeights(sim, N) {
  let sumSq = 0;
  let peak = 0;
  let n = 0;
  const perCascade = [];
  for (let c = 0; c < sim.cascades.length; c++) {
    const buf = readAttachment(sim.outputs[c][sim.current], 0, N);
    let cs = 0;
    let cp = 0;
    for (let i = 0; i < N * N; i++) {
      const y = buf[i * 4 + 1]; // (Dx, Dy, Dz, foam)
      cs += y * y;
      cp = Math.max(cp, Math.abs(y));
    }
    perCascade.push({ rms: Math.sqrt(cs / (N * N)), peak: cp });
    sumSq += cs;
    peak = Math.max(peak, cp);
    n += N * N;
  }
  return { rms: Math.sqrt(sumSq / n), peak, perCascade };
}

reg("wave heights are physically plausible for the given wind", async () => {
  // A ~11 m/s wind over long fetch is roughly Beaufort 6: significant wave
  // height of order 2-3 m. Significant height is ~4x the surface RMS, so an
  // RMS in the 0.15-1.5 m band is the sanity window. Outside it the spectrum
  // normalisation is wrong and every downstream look decision is built on sand.
  const N = 64;
  const sim = new OceanSimulation(renderer, { N, windSpeed: 11 });
  for (let i = 0; i < 3; i++) sim.update(1 + i * 0.1, 1 / 60);
  const m = measureHeights(sim, N);
  const detail = m.perCascade
    .map((c, i) => `c${i} rms=${c.rms.toFixed(3)} peak=${c.peak.toFixed(3)}`)
    .join(", ");
  sim.dispose();

  assert(
    m.rms > 0.15 && m.rms < 1.5,
    `total RMS wave height ${m.rms.toFixed(3)} m is outside the plausible band (${detail})`,
  );
});

reg("every cascade contributes energy", async () => {
  // A dead cascade means its band was clipped away — plausible-looking water
  // that is quietly missing a whole scale of detail.
  const N = 64;
  const sim = new OceanSimulation(renderer, { N, windSpeed: 11 });
  for (let i = 0; i < 3; i++) sim.update(1 + i * 0.1, 1 / 60);
  const m = measureHeights(sim, N);
  sim.dispose();

  m.perCascade.forEach((c, i) => {
    assert(c.rms > 1e-5, `cascade ${i} is dead (rms ${c.rms})`);
  });
});

reg("coarser cascades carry more energy than finer ones", async () => {
  // Ocean spectra are red: the swell band must dominate the capillary band.
  // Inverted ordering means the band limits are wrong.
  const N = 64;
  const sim = new OceanSimulation(renderer, { N, windSpeed: 11 });
  for (let i = 0; i < 3; i++) sim.update(1 + i * 0.1, 1 / 60);
  const m = measureHeights(sim, N);
  const rms = m.perCascade.map((c) => c.rms);
  sim.dispose();

  for (let i = 1; i < rms.length; i++) {
    assert(
      rms[i] < rms[i - 1],
      `cascade ${i} (rms ${rms[i]}) carries more energy than cascade ${i - 1} (rms ${rms[i - 1]})`,
    );
  }
});

reg("stronger wind produces taller waves", async () => {
  const N = 64;
  const calm = new OceanSimulation(renderer, { N, windSpeed: 5 });
  const storm = new OceanSimulation(renderer, { N, windSpeed: 20 });
  for (let i = 0; i < 3; i++) {
    calm.update(1 + i * 0.1, 1 / 60);
    storm.update(1 + i * 0.1, 1 / 60);
  }
  const a = measureHeights(calm, N).rms;
  const b = measureHeights(storm, N).rms;
  calm.dispose();
  storm.dispose();
  assert(b > a * 1.5, `storm rms ${b} is not meaningfully above calm rms ${a}`);
});
