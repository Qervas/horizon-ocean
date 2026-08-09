import { OceanSimulation } from "../../js/ocean/oceanSimulation.js";
import { OceanProbe } from "../../js/ocean/oceanProbe.js";
import { renderer, assert, readAttachment } from "./gpuTests.js";

const reg = (name, fn) => window.__gpuTests.register(name, fn);

function makeSim() {
  const sim = new OceanSimulation(renderer, { N: 32, windSpeed: 14, choppiness: 1.2 });
  sim.update(2.0, 1 / 60);
  sim.update(2.1, 1 / 60);
  return sim;
}

/** Drives readbacks to completion — they resolve on later microtask turns. */
async function settle(probe, frames = 6) {
  for (let i = 0; i < frames; i++) {
    probe.submit();
    await new Promise((r) => setTimeout(r, 16));
  }
}

reg("probe reports a flat sea before the first readback lands", async () => {
  const sim = makeSim();
  const probe = new OceanProbe(renderer, sim);
  const s = probe.sample(0);
  assert(Number.isFinite(s.y), `y was ${s.y}`);
  assert(s.y === 0, `expected flat sea, got ${s.y}`);
  assert(probe.ready === false, "probe claimed ready before any readback");
  probe.dispose();
  sim.dispose();
});

reg("probe returns finite surface data after readback", async () => {
  const sim = makeSim();
  const probe = new OceanProbe(renderer, sim);
  probe.setPositions([0, 0, 10, 5, -20, 30, 100, -100]);
  await settle(probe);

  assert(probe.ready === true, "no readback ever resolved");
  for (let i = 0; i < 4; i++) {
    const s = probe.sample(i);
    assert(Number.isFinite(s.y), `slot ${i} y=${s.y}`);
    assert(Number.isFinite(s.dx) && Number.isFinite(s.dz), `slot ${i} displacement non-finite`);
    assert(Number.isFinite(s.foam), `slot ${i} foam=${s.foam}`);
  }
  probe.dispose();
  sim.dispose();
});

reg("probe height matches the rendered displacement field", async () => {
  // The whole point of the probe: agreement with what the renderer draws.
  const sim = makeSim();
  const probe = new OceanProbe(renderer, sim);

  // Probe a position, then compare against the cascade textures read directly.
  const px = 0;
  const pz = 0;
  probe.setPositions([px, pz]);
  await settle(probe);

  // Sum cascade heights at the inverted position, replicating the shader on CPU.
  const texelAt = (buf, N, u, v) => {
    const x = ((Math.round(u * N) % N) + N) % N;
    const y = ((Math.round(v * N) % N) + N) % N;
    const o = (y * N + x) * 4;
    return [buf[o], buf[o + 1], buf[o + 2], buf[o + 3]];
  };

  const N = 32;
  const disp = sim.cascades.map((_, c) => readAttachment(sim.outputs[c][sim.current], 0, N));

  const horizontal = (x, z) => {
    let dx = 0;
    let dz = 0;
    for (let c = 0; c < sim.cascades.length; c++) {
      const t = texelAt(disp[c], N, x / sim.cascades[c].patch, z / sim.cascades[c].patch);
      dx += t[0];
      dz += t[2];
    }
    return [dx, dz];
  };

  let ix = px;
  let iz = pz;
  for (let i = 0; i < 3; i++) {
    const [dx, dz] = horizontal(ix, iz);
    ix = px - dx;
    iz = pz - dz;
  }
  let expectedY = 0;
  for (let c = 0; c < sim.cascades.length; c++) {
    const t = texelAt(disp[c], N, ix / sim.cascades[c].patch, iz / sim.cascades[c].patch);
    expectedY += t[1];
  }

  const got = probe.sample(0).y;
  probe.dispose();
  sim.dispose();

  // Loose: the shader filters bilinearly while this oracle snaps to nearest,
  // so exact agreement is not expected — gross disagreement is the failure.
  assert(
    Math.abs(got - expectedY) < 0.5,
    `probe reported ${got}, direct texture read gave ${expectedY}`,
  );
});

reg("probe measures a plausible readback latency", async () => {
  const sim = makeSim();
  const probe = new OceanProbe(renderer, sim);
  probe.setPositions([0, 0]);
  await settle(probe, 8);
  assert(probe.latency > 0 && probe.latency < 1, `latency ${probe.latency}s is implausible`);
  probe.dispose();
  sim.dispose();
});

reg("probe never exceeds its in-flight budget", async () => {
  const sim = makeSim();
  const probe = new OceanProbe(renderer, sim);
  probe.setPositions([0, 0]);
  let peak = 0;
  for (let i = 0; i < 30; i++) {
    probe.submit();
    peak = Math.max(peak, probe.inFlight);
  }
  assert(peak <= 3, `in-flight readbacks peaked at ${peak}`);
  // Let them drain so the renderer is not left with pending work.
  await new Promise((r) => setTimeout(r, 200));
  probe.dispose();
  sim.dispose();
});

reg("probe holds its last result rather than zeroing on stall", async () => {
  const sim = makeSim();
  const probe = new OceanProbe(renderer, sim);
  probe.setPositions([12, -7]);
  await settle(probe);
  const before = probe.sample(0).y;

  // Simulate a wedged pipeline: many submits with no chance to resolve.
  for (let i = 0; i < 10; i++) probe.submit();
  const after = probe.sample(0).y;

  assert(after === before, `result changed on stall: ${before} -> ${after}`);
  await new Promise((r) => setTimeout(r, 200));
  probe.dispose();
  sim.dispose();
});
