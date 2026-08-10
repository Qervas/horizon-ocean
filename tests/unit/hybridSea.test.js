import { test } from "node:test";
import assert from "node:assert/strict";
import { CpuMirror } from "../../js/ocean/cpuMirror.js";
import { HybridSea, LATENCY_DEGRADE_S, LATENCY_RECOVER_S } from "../../js/ocean/hybridSea.js";
import { CASCADES } from "../../js/ocean/spectrum.js";

const CASCADE_TOPS = CASCADES.map((c) => c.kHigh);

const opts = { N: 32, windSpeed: 11, fetch: 100000, gamma: 3.3, seed: 0x0ce4a };

test("mirror produces a non-flat, finite surface", () => {
  const m = new CpuMirror(opts);
  m.update(3.0);
  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i < 40; i++) {
    const s = m.sample(i * 7.3, i * 3.1);
    assert.ok(Number.isFinite(s.y), `non-finite height at sample ${i}`);
    assert.ok(Number.isFinite(s.dx) && Number.isFinite(s.dz), "non-finite displacement");
    min = Math.min(min, s.y);
    max = Math.max(max, s.y);
  }
  assert.ok(max - min > 0.05, `surface is flat (range ${max - min})`);
});

test("mirror wave heights are physically plausible", () => {
  const m = new CpuMirror({ ...opts, windSpeed: 11 });
  m.update(2.0);
  let sumSq = 0;
  let n = 0;
  for (let x = 0; x < 200; x += 7) {
    for (let z = 0; z < 200; z += 7) {
      const y = m.sample(x, z).y;
      sumSq += y * y;
      n++;
    }
  }
  const rms = Math.sqrt(sumSq / n);
  assert.ok(rms > 0.05 && rms < 3.0, `mirror RMS height ${rms} m is implausible`);
});

test("mirror evolves over time", () => {
  const m = new CpuMirror(opts);
  m.update(1.0);
  const a = m.sample(12, 34).y;
  m.update(3.5);
  const b = m.sample(12, 34).y;
  assert.notEqual(a, b, "surface did not change between updates");
});

test("mirror is deterministic for a given seed and time", () => {
  const a = new CpuMirror(opts);
  const b = new CpuMirror(opts);
  a.update(2.25);
  b.update(2.25);
  assert.equal(a.sample(9, 17).y, b.sample(9, 17).y);
});

test("mirror loops with the simulation period", () => {
  // Dispersion is quantised to 200 s, so the surface must repeat exactly.
  const m = new CpuMirror(opts);
  m.update(4.0);
  const a = m.sample(20, 30).y;
  m.update(4.0 + 200);
  const b = m.sample(20, 30).y;
  assert.ok(Math.abs(a - b) < 1e-3, `loop mismatch: ${a} vs ${b}`);
});

test("mirror mirrors only the coarse cascades", () => {
  const m = new CpuMirror(opts);
  assert.equal(m.cascades.length, 2);
});

test("mirror patches reach the top of each cascade's wavenumber band", () => {
  // The failure this guards against is silent: too large a patch simply drops
  // the high end of the band, the sea goes nearly flat, and the boat sinks
  // through waves that are being drawn around it.
  for (const N of [32, 64, 128]) {
    const m = new CpuMirror({ ...opts, N });
    m.cascades.forEach((c, i) => {
      const nyquist = (Math.PI * N) / c.patch;
      const bandTop = CASCADE_TOPS[i];
      assert.ok(
        nyquist >= bandTop * 0.98,
        `N=${N} cascade ${i}: Nyquist ${nyquist.toFixed(3)} below band top ${bandTop.toFixed(3)}`,
      );
    });
  }
});

// --- Hybrid switching ---

function fakeProbe({ latency, ready = true, stalled = false }) {
  return {
    latency,
    ready,
    stalled,
    calls: 0,
    sampleAt(index, x, z) {
      this.calls++;
      return { y: 999, dx: 0, dz: 0, foam: 0 };
    },
    commitPositions() {},
    submit() {},
  };
}

test("uses the mirror before any probe result arrives", () => {
  const h = new HybridSea(fakeProbe({ latency: 0.01, ready: false }), opts);
  h.update(1.0);
  assert.equal(h.source, "mirror");
  assert.notEqual(h.sampleAt(0, 0, 0).y, 999);
});

test("adopts the probe once latency is healthy", () => {
  const h = new HybridSea(fakeProbe({ latency: 0.02 }), opts);
  h.update(1.0);
  assert.equal(h.source, "probe");
  assert.equal(h.sampleAt(0, 0, 0).y, 999);
});

test("high latency does NOT switch away from the probe", () => {
  // Deliberate. The mirror cannot reproduce the drawn sea's phases at any
  // resolution the CPU can afford, so switching to it trades a late boat for a
  // boat in the wrong sea — measured, that put the hull fully underwater.
  const probe = fakeProbe({ latency: 0.02 });
  const h = new HybridSea(probe, opts);
  h.update(1.0);
  assert.equal(h.source, "probe");
  probe.latency = 2.5; // software rendering
  h.update(1.1);
  assert.equal(h.source, "probe", "latency alone must not change the source");
  assert.equal(h.sampleAt(0, 0, 0).y, 999);
});

test("uses the mirror only when there is no probe result at all", () => {
  const probe = fakeProbe({ latency: 0.02, ready: false });
  const h = new HybridSea(probe, opts);
  h.update(1.0);
  assert.equal(h.source, "mirror");
  probe.ready = true;
  h.update(1.1);
  assert.equal(h.source, "probe");
});

test("keeps feeding the probe positions even while the mirror drives", () => {
  // Otherwise the probe never warms up and its latency estimate never recovers,
  // so the system could never switch back.
  // High latency no longer selects the mirror, so drive the mirror the only way
  // that still does: no probe result yet.
  const probe = fakeProbe({ latency: 2.0, ready: false });
  const h = new HybridSea(probe, opts);
  h.update(1.0);
  assert.equal(h.source, "mirror");
  h.sampleAt(0, 5, 5);
  h.sampleAt(1, 6, 6);
  assert.equal(probe.calls, 2, "probe stopped receiving positions");
});

test("works with no probe at all", () => {
  const h = new HybridSea(null, opts);
  h.update(1.0);
  assert.equal(h.source, "mirror");
  assert.ok(Number.isFinite(h.sampleAt(0, 1, 2).y));
});
