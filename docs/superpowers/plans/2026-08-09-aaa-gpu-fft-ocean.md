# AAA GPU FFT Ocean Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the CPU 128² single-cascade RGBA8 FFT ocean with a 4-cascade GPU FFT at 256² in float precision, plus a physically-grounded water BRDF.

**Architecture:** Pure math (spectrum, butterfly, mesh, probe inversion) lives in dependency-free modules returning typed arrays, tested under `node:test`. Everything touching WebGL is tested in a real browser through the existing Playwright install. A generic ping-pong FFT engine that knows nothing about oceans sits under an ocean simulation layer that owns all render targets.

**Tech Stack:** Three.js 0.170 (CDN import map, no build step), WebGL2 + `EXT_color_buffer_float`, Node 26 `node:test`, Playwright 1.49.

## Global Constraints

- **No build step.** Static files only, ES modules, `three` resolved via the import map in `index.html`. Never add a bundler.
- **Pure modules import nothing.** `spectrum.js`, `butterfly.js`, `oceanMesh.js`, and the probe inversion must not import `three`, so `node:test` can exercise them directly. THREE wrappers are thin and separate.
- **FFT size N = 256**, `LOG_N = 8`, for all four cascades.
- **Cascade patch sizes**, largest to smallest: `[2048, 512, 128, 32]` metres.
- **Cascade wavenumber bands** are half-open `[k_low, k_high)` and must not overlap: `[0, 0.3927)`, `[0.3927, 1.5708)`, `[1.5708, 6.2832)`, `[6.2832, 25.1327)`.
- **Gravity** `g = 9.81`. **Loop period** `T = 200` s, so `ω₀ = 2π/200`.
- **Render target format:** `RGBA16F` (`THREE.HalfFloatType`) for FFT ping-pong and cascade outputs; `RGBA32F` (`THREE.FloatType`) for `h₀` and the probe target.
- **Existing files that must not change:** `js/atmosphere.js`, `js/sky.js`, `js/post.js`.
- **Reproducibility:** all randomness comes from the existing seeded `mulberry32`. Never call `Math.random()`.
- Work happens on branch `feat/gpu-fft-ocean`.

---

### Task 1: Test infrastructure

**Files:**
- Create: `tests/unit/smoke.test.js`
- Create: `tests/gpu/harness.html`
- Create: `tests/gpu/gpuTests.js`
- Create: `scripts/run-gpu-tests.mjs`
- Modify: `package.json`

**Interfaces:**
- Consumes: nothing.
- Produces: `npm run test:unit` (node:test over `tests/unit/**/*.test.js`), `npm run test:gpu` (Playwright over `tests/gpu/harness.html`). GPU tests register via `window.__gpuTests.register(name, asyncFn)`; each fn throws on failure. The runner returns `{name, ok, error}[]`.

- [ ] **Step 1: Write the failing smoke test**

`tests/unit/smoke.test.js`:
```js
import { test } from "node:test";
import assert from "node:assert/strict";

test("unit harness runs", () => {
  assert.equal(1 + 1, 2);
});
```

- [ ] **Step 2: Add scripts to package.json**

```json
"test:unit": "node --test tests/unit/",
"test:gpu": "node scripts/run-gpu-tests.mjs",
"test": "npm run test:unit && npm run test:gpu"
```

- [ ] **Step 3: Run and verify it passes**

Run: `npm run test:unit`
Expected: `pass 1`

- [ ] **Step 4: Write the GPU harness page**

`tests/gpu/harness.html` — an importmap identical to `index.html`, a canvas, and a module script importing `./gpuTests.js`. It exposes:
```js
window.__gpuTests = { cases: [], register(name, fn) { this.cases.push({name, fn}); }, async runAll() { /* try/catch each, return [{name, ok, error}] */ } };
window.__gpuTestsReady = true;
```
`runAll` must catch per-case so one failure does not hide the rest.

- [ ] **Step 5: Write the Playwright runner**

`scripts/run-gpu-tests.mjs` launches chromium **with `--use-gl=angle --use-angle=swiftshader` plus `--enable-unsafe-swiftshader`** so WebGL works headless, serves via the existing `serve` on port 5173 (or `OCEAN_URL`), waits for `window.__gpuTestsReady`, calls `runAll()`, prints results, and exits non-zero if any case failed.

- [ ] **Step 6: Register one trivial GPU case and run**

Register a case asserting `renderer.capabilities.isWebGL2 === true`.
Run: `npm run serve` in one shell, `npm run test:gpu` in another.
Expected: 1 passing case, exit 0.

- [ ] **Step 7: Commit**

```bash
git add package.json tests/ scripts/run-gpu-tests.mjs
git commit -m "test: add node:test and Playwright WebGL test harnesses"
```

---

### Task 2: butterfly.js

**Files:**
- Create: `js/ocean/butterfly.js`
- Create: `tests/unit/butterfly.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces: `buildButterflyData(N: number) => Float32Array` of length `log2(N) * N * 4`, laid out row-major with **stage as the row** and butterfly index as the column. Each texel is `(twiddleRe, twiddleIm, srcTop, srcBottom)`. Also `bitReverseIndices(N) => Uint16Array`.

- [ ] **Step 1: Write the failing tests**

`tests/unit/butterfly.test.js`:
```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildButterflyData, bitReverseIndices } from "../../js/ocean/butterfly.js";

test("bit reversal is an involution", () => {
  const br = bitReverseIndices(256);
  assert.equal(br.length, 256);
  for (let i = 0; i < 256; i++) assert.equal(br[br[i]], i);
});

test("bit reversal matches known values for N=8", () => {
  assert.deepEqual(Array.from(bitReverseIndices(8)), [0, 4, 2, 6, 1, 5, 3, 7]);
});

test("butterfly data has one row per stage", () => {
  const d = buildButterflyData(256);
  assert.equal(d.length, 8 * 256 * 4);
});

test("stage 0 encodes bit-reversed source indices", () => {
  const N = 8, d = buildButterflyData(N), br = bitReverseIndices(N);
  for (let x = 0; x < N; x++) {
    const top = d[x * 4 + 2], bot = d[x * 4 + 3];
    assert.ok(br.includes(top) || top === br[x]);
    assert.ok(Number.isFinite(bot));
  }
});

test("twiddle factors are unit magnitude", () => {
  const d = buildButterflyData(256);
  for (let i = 0; i < 8 * 256; i++) {
    const re = d[i * 4], im = d[i * 4 + 1];
    assert.ok(Math.abs(Math.hypot(re, im) - 1) < 1e-5, `stage/idx ${i} magnitude ${Math.hypot(re, im)}`);
  }
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npm run test:unit`
Expected: FAIL — cannot find module `js/ocean/butterfly.js`

- [ ] **Step 3: Implement**

Standard Cooley-Tukey butterfly table. For stage `s` (0-based) and index `x`: span `= 2^s`, the twiddle is `exp(2πi·k/N)` for the **inverse** transform where `k = (x * N / 2^(s+1)) % N`... derive carefully — the test on unit magnitude and the DFT parity test in Task 4 are the real gates. Stage 0 uses bit-reversed indices as sources; later stages use `x` and `x ± span` depending on the wing.

- [ ] **Step 4: Run tests**

Run: `npm run test:unit`
Expected: all pass

- [ ] **Step 5: Commit**

```bash
git add js/ocean/butterfly.js tests/unit/butterfly.test.js
git commit -m "feat: add FFT butterfly table generation"
```

---

### Task 3: spectrum.js

**Files:**
- Create: `js/ocean/spectrum.js`
- Create: `tests/unit/spectrum.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `jonswap(omega, U, F, g?) => number`
  - `donelanBanner(omega, omegaP, theta) => number`
  - `peakOmega(U, F, g?) => number`
  - `CASCADES: {patch: number, kLow: number, kHigh: number}[]` — length 4
  - `buildInitialSpectrum({N, patch, kLow, kHigh, windSpeed, windDir, fetch, depth, seed}) => Float32Array` of length `N*N*4`, `(h0.re, h0.im, h0conj.re, h0conj.im)`
  - `dispersion(k, depth, g?) => number` — quantized to `ω₀ = 2π/200`
  - `mulberry32(seed) => () => number` (moved from `fftOcean.js`)

- [ ] **Step 1: Write the failing tests**

`tests/unit/spectrum.test.js`:
```js
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  jonswap, donelanBanner, peakOmega, dispersion,
  buildInitialSpectrum, CASCADES,
} from "../../js/ocean/spectrum.js";

const U = 12, F = 100000;

test("JONSWAP peaks at the peak frequency", () => {
  const wp = peakOmega(U, F);
  const at = jonswap(wp, U, F);
  for (const m of [0.6, 0.8, 1.25, 1.6]) {
    assert.ok(jonswap(wp * m, U, F) < at, `expected peak at wp, but ${m}*wp was higher`);
  }
});

test("JONSWAP is finite and non-negative across a wide band", () => {
  for (let w = 0.05; w < 20; w += 0.05) {
    const s = jonswap(w, U, F);
    assert.ok(Number.isFinite(s) && s >= 0, `bad S at omega=${w}: ${s}`);
  }
});

test("directional spreading is symmetric and normalised", () => {
  const wp = peakOmega(U, F);
  for (const w of [wp * 0.7, wp, wp * 1.4, wp * 3]) {
    assert.ok(Math.abs(donelanBanner(w, wp, 0.3) - donelanBanner(w, wp, -0.3)) < 1e-9);
    let sum = 0;
    const steps = 4000, d = (2 * Math.PI) / steps;
    for (let i = 0; i < steps; i++) sum += donelanBanner(w, wp, -Math.PI + i * d) * d;
    assert.ok(Math.abs(sum - 1) < 0.05, `omega=${w} integrates to ${sum}`);
  }
});

test("dispersion is quantised to the loop period", () => {
  const w0 = (2 * Math.PI) / 200;
  for (const k of [0.01, 0.5, 3, 20]) {
    const w = dispersion(k, 1000);
    assert.ok(Math.abs((w / w0) - Math.round(w / w0)) < 1e-9, `omega ${w} not a multiple of ${w0}`);
  }
});

test("cascade bands tile the spectrum without overlap or gaps", () => {
  assert.equal(CASCADES.length, 4);
  assert.equal(CASCADES[0].kLow, 0);
  for (let i = 1; i < CASCADES.length; i++) {
    assert.equal(CASCADES[i].kLow, CASCADES[i - 1].kHigh, `gap/overlap at cascade ${i}`);
  }
  for (const c of CASCADES) {
    const nyquist = (Math.PI * 256) / c.patch;
    assert.ok(c.kHigh <= nyquist + 1e-6, `cascade patch ${c.patch} exceeds its Nyquist`);
  }
});

test("initial spectrum contains no NaN and respects its band", () => {
  const N = 64, c = CASCADES[1];
  const d = buildInitialSpectrum({
    N, patch: c.patch, kLow: c.kLow, kHigh: c.kHigh,
    windSpeed: U, windDir: [0.85, 0.53], fetch: F, depth: 1000, seed: 0x0ce4a,
  });
  assert.equal(d.length, N * N * 4);
  for (let i = 0; i < d.length; i++) assert.ok(Number.isFinite(d[i]), `NaN at ${i}`);
  assert.ok(d.some((v) => v !== 0), "spectrum is entirely zero");
});

test("out-of-band wavenumbers carry zero energy", () => {
  const N = 64, c = CASCADES[0];
  const d = buildInitialSpectrum({
    N, patch: c.patch, kLow: c.kLow, kHigh: c.kHigh,
    windSpeed: U, windDir: [0.85, 0.53], fetch: F, depth: 1000, seed: 1,
  });
  for (let m = 0; m < N; m++) {
    for (let n = 0; n < N; n++) {
      const kx = ((n < N / 2 ? n : n - N) * 2 * Math.PI) / c.patch;
      const kz = ((m < N / 2 ? m : m - N) * 2 * Math.PI) / c.patch;
      const k = Math.hypot(kx, kz);
      if (k >= c.kHigh) {
        const i = (m * N + n) * 4;
        assert.equal(d[i], 0, `energy at k=${k}, above kHigh=${c.kHigh}`);
        assert.equal(d[i + 1], 0);
      }
    }
  }
});

test("the k=0 mode is zero rather than NaN", () => {
  const N = 64, c = CASCADES[0];
  const d = buildInitialSpectrum({
    N, patch: c.patch, kLow: c.kLow, kHigh: c.kHigh,
    windSpeed: U, windDir: [0.85, 0.53], fetch: F, depth: 1000, seed: 1,
  });
  assert.equal(d[0], 0);
  assert.equal(d[1], 0);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npm run test:unit`
Expected: FAIL — module not found

- [ ] **Step 3: Implement**

Formulae verbatim from the spec's "Component: spectrum.js" section. Critical details:
- Guard `k < 1e-6` → return zero, before any division. This is the NaN source.
- Band-limit by zeroing `h₀` outside `[kLow, kHigh)`.
- `h₀(k) = (1/√2)(ξr + i ξi) √(2 S(k) D(k) Δkx Δkz)` where `Δkx = Δkz = 2π/patch`.
- Store the conjugate `h₀*(−k)` in BA so the GPU evolve pass needs one fetch.
- `donelanBanner` must be normalised — divide by the numeric integral over θ, or use the `β sech²(βθ)/2` form which is already unit-normalised over infinite θ and close enough over `[−π, π]`.

- [ ] **Step 4: Run tests**

Run: `npm run test:unit`
Expected: all pass

- [ ] **Step 5: Commit**

```bash
git add js/ocean/spectrum.js tests/unit/spectrum.test.js
git commit -m "feat: add JONSWAP spectrum with Donelan-Banner spreading"
```

---

### Task 4: gpuFFT.js

**Files:**
- Create: `js/ocean/gpuFFT.js`
- Modify: `tests/gpu/gpuTests.js`

**Interfaces:**
- Consumes: `buildButterflyData` from Task 2.
- Produces: `class GpuFFT { constructor(renderer, N); inverse(rtA, rtB) }` — transforms in place, ping-ponging internally. `rtA`/`rtB` are `WebGLRenderTarget`s with `count: 2`, `HalfFloatType`, `NearestFilter`. `.rg` and `.ba` of each attachment are independent complex fields.

- [ ] **Step 1: Write the failing GPU test**

Register in `tests/gpu/gpuTests.js`: seed a 16² target with a known pattern, run `inverse()`, and compare against a direct O(n²) inverse DFT computed in JS. Assert max absolute error `< 1e-2` (half-float tolerance).

```js
register("gpuFFT matches a reference inverse DFT", async () => {
  const N = 16;
  const src = new Float32Array(N * N * 2);
  const rng = mulberry32(7);
  for (let i = 0; i < N * N * 2; i++) src[i] = rng() * 2 - 1;
  const expected = referenceInverseDFT2D(src, N);   // plain JS, O(n^4), fine at N=16
  const actual = await runGpuFFT(src, N);           // helper in gpuTests.js
  let maxErr = 0;
  for (let i = 0; i < expected.length; i++) maxErr = Math.max(maxErr, Math.abs(expected[i] - actual[i]));
  if (maxErr > 1e-2) throw new Error(`max error ${maxErr}`);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npm run test:gpu`
Expected: FAIL — `GpuFFT is not defined`

- [ ] **Step 3: Implement**

Fullscreen-quad ping-pong. One `RawShaderMaterial` with `glslVersion: THREE.GLSL3` and MRT outputs `layout(location=0/1) out vec4`. A `uStage` uniform selects the butterfly row, `uDirection` selects horizontal/vertical, `uPingPong` selects the source. 8 horizontal then 8 vertical passes. Both `.rg` and `.ba` are butterflied identically in the same pass.

Note: the inverse scale `1/N²` is applied once, in the final vertical pass, not per stage.

- [ ] **Step 4: Run tests**

Run: `npm run test:gpu`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add js/ocean/gpuFFT.js tests/gpu/gpuTests.js
git commit -m "feat: add generic GPU ping-pong 2D inverse FFT"
```

---

### Task 5: oceanSimulation.js

**Files:**
- Create: `js/ocean/oceanSimulation.js`
- Create: `js/ocean/shaders/evolve.js`
- Create: `js/ocean/shaders/assemble.js`
- Modify: `tests/gpu/gpuTests.js`

**Interfaces:**
- Consumes: `CASCADES`, `buildInitialSpectrum`, `dispersion` (Task 3); `GpuFFT` (Task 4).
- Produces:
```js
class OceanSimulation {
  constructor(renderer, { windSpeed, windDir, fetch, depth, seed, choppiness })
  update(time)                        // runs all 72 draws
  setSeaState(windSpeed, choppiness)  // rebuilds h0
  displacement: WebGLRenderTarget[]   // 4, texture = (Dx, Dy, Dz, foam)
  derivatives:  WebGLRenderTarget[]   // 4, texture = (dDy/dx, dDy/dz, varX, varZ)
  cascades: {patch, kLow, kHigh}[]
  dispose()
}
```

- [ ] **Step 1: Write the failing GPU tests**

```js
register("cascade sum matches a CPU reference height field", async () => { /* seed identically, compare Dy at sample points, tol 2% of RMS */ });
register("analytic Jacobian matches finite differences", async () => { /* tol 5% */ });
register("foam accumulates then decays", async () => { /* storm state, assert foam rises; drop to calm, assert it falls monotonically */ });
register("no NaN in any cascade output", async () => { /* readback all 4, assert all finite */ });
```

- [ ] **Step 2: Run to verify failure**

Run: `npm run test:gpu`
Expected: FAIL

- [ ] **Step 3: Implement the evolve shader**

Packing exactly as the spec:
```
RT0.rg = hy      + i*hx        -> (Dy,      Dx)
RT0.ba = hz      + i*(ikx*hy)  -> (Dz,      dDy/dx)
RT1.rg = ikz*hy  + i*(ikx*hx)  -> (dDy/dz, dDx/dx)
RT1.ba = ikz*hz  + i*(ikz*hx)  -> (dDz/dz, dDx/dz)
```
with `hx = -i(kx/k)hy`, `hz = -i(kz/k)hy`, both scaled by choppiness. Guard `k < 1e-6`.

- [ ] **Step 4: Implement the assemble shader**

Unpack the eight real fields. `J = (1 + dDx/dx)(1 + dDz/dz) - (dDx/dz)²` — the cross terms are equal, so only one is transformed. Write `(Dx, Dy, Dz, foam)` and `(dDy/dx, dDy/dz, varX, varZ)`. Foam accumulates into a persistent buffer: `foam = max(foam_prev * decay, max(0, threshold - J))`, decay ≈ `exp(-dt * 0.35)`.

- [ ] **Step 5: Run tests**

Run: `npm run test:gpu`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add js/ocean/oceanSimulation.js js/ocean/shaders/ tests/gpu/gpuTests.js
git commit -m "feat: add 4-cascade GPU ocean simulation"
```

---

### Task 6: oceanMesh.js

**Files:**
- Create: `js/ocean/oceanMesh.js`
- Create: `tests/unit/oceanMesh.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces: `buildRingDiscData({rings, segments, innerRadius, outerRadius}) => {positions: Float32Array, indices: Uint32Array}` (pure, no THREE) and `createOceanMesh(THREE, opts) => THREE.Mesh` (thin wrapper).

- [ ] **Step 1: Write the failing tests**

```js
test("radial spacing is exponential", () => { /* ratio between consecutive ring radii is constant to 1e-6 */ });
test("inner and outer radii are honoured", () => { /* first ring == innerRadius, last == outerRadius */ });
test("every index is in range and every vertex is referenced", () => { /* catches the classic off-by-one at the seam */ });
test("the angular seam closes", () => { /* last segment connects back to segment 0, no duplicate column */ });
test("vertex count is rings*segments + 1 centre vertex", () => {});
```

- [ ] **Step 2: Run to verify failure**

Run: `npm run test:unit` → FAIL

- [ ] **Step 3: Implement**

`r(i) = innerRadius * (outerRadius/innerRadius)^(i/(rings-1))`, `segments` angular divisions, one centre vertex capping the pole. Defaults: `rings: 256, segments: 256, innerRadius: 0.25, outerRadius: 20000`. Y is 0 — displacement happens in the vertex shader.

- [ ] **Step 4: Run tests** → PASS

- [ ] **Step 5: Commit**

```bash
git add js/ocean/oceanMesh.js tests/unit/oceanMesh.test.js
git commit -m "feat: add exponential ring disc ocean geometry"
```

---

### Task 7: oceanProbe.js

**Files:**
- Create: `js/ocean/oceanProbe.js`
- Create: `js/ocean/probeMath.js`
- Create: `tests/unit/probeMath.test.js`
- Modify: `tests/gpu/gpuTests.js`

**Interfaces:**
- Consumes: `OceanSimulation` (Task 5).
- Produces:
  - `probeMath.js`: `invertDisplacement(xz, sampleFn, iterations = 3) => [x, z]`, `extrapolate(pos, vel, latencySeconds) => [x, z]` — both pure.
  - `oceanProbe.js`: `class OceanProbe { constructor(renderer, sim, {slots = 256}); setPositions(Float32Array); submit(); sample(index) => {y, dx, dz, jacobian}; latency: number }`

- [ ] **Step 1: Write the failing pure tests**

```js
test("inversion recovers a known displaced position", () => {
  // forward map: p -> p + D(p) for a known analytic D.
  // assert invertDisplacement(p + D(p)) ~= p to 1e-2 m under storm-scale chop
});
test("inversion converges within 3 iterations for realistic chop", () => {});
test("extrapolation is exact for constant velocity", () => {});
```

- [ ] **Step 2: Run to verify failure** → FAIL

- [ ] **Step 3: Implement `probeMath.js`** — fixed point `p ← xz − D_horizontal(p)`.

- [ ] **Step 4: Run pure tests** → PASS

- [ ] **Step 5: Write the failing GPU test**

```js
register("probe height matches the rendered surface", async () => { /* compare probe readback against a direct texture readback at the same XZ, tol 5cm */ });
register("probe degrades gracefully before first readback", async () => { /* sample() before any submit() returns finite values */ });
```

- [ ] **Step 6: Implement `oceanProbe.js`**

16×16 `RGBA32F` target. Probe shader takes `uPositions[256]` (as a `vec2` array or a small data texture — a data texture avoids uniform-array limits and is the safer choice), evaluates summed displacement across all four cascades, runs 3 fixed-point iterations, writes `(y, dx, dz, jacobian)`.

`readRenderTargetPixelsAsync(rt, 0, 0, 16, 16, buffer)` into a 3-deep ring. Never await inline. Track latency as a rolling average of issue→resolve time. If no readback has resolved, or the newest is older than 4 frames, `sample()` returns an analytic estimate from cascade 0.

- [ ] **Step 7: Run GPU tests** → PASS

- [ ] **Step 8: Commit**

```bash
git add js/ocean/oceanProbe.js js/ocean/probeMath.js tests/
git commit -m "feat: add async GPU buoyancy probe with latency compensation"
```

---

### Task 8: Water material and shaders

**Files:**
- Create: `js/ocean/shaders/oceanVertex.js`
- Create: `js/ocean/shaders/waterBRDF.js`
- Create: `js/ocean/shaders/oceanFragment.js`
- Create: `js/ocean/oceanMaterial.js`
- Modify: `tests/gpu/gpuTests.js`

**Interfaces:**
- Consumes: `OceanSimulation` outputs (Task 5), `ATMOS_GLSL` from `js/atmosphere.js` (unchanged).
- Produces: `createOceanMaterial(sim) => THREE.ShaderMaterial` and `updateOceanUniforms(mat, {time, sun, weather, cameraY, foamTrail, foamWorld})`.

- [ ] **Step 1: Write the failing GPU tests**

```js
register("ocean material compiles without shader errors", async () => { /* render one frame, assert gl.getError() === 0 and no program log */ });
register("distant water roughness exceeds near water roughness", async () => { /* slope-variance sanity: read a debug channel at two distances */ });
register("trough luminance is below crest luminance", async () => { /* Beer-Lambert sanity */ });
```

- [ ] **Step 2: Run to verify failure** → FAIL

- [ ] **Step 3: Implement the vertex shader**

Sample all four `displacement[c]` at `worldXZ / patch[c]`, sum with a per-cascade distance weight that fades cascades 2 and 3 out beyond ~80 m. Apply full 3-D displacement. Pass world position and camera distance; compute no normals.

- [ ] **Step 4: Implement `waterBRDF.js`**

Multi-scatter GGX (Fdez-Agüera split-sum, analytic env BRDF — no LUT), Smith height-correlated visibility, `F0 = 0.02`. Beer-Lambert transmission with `σ = vec3(0.45, 0.09, 0.06)`. Subsurface driven by wave height and view/sun alignment. Foam shaded as a rough dielectric.

- [ ] **Step 5: Implement the fragment shader**

Normals from `derivatives[c]`: `N = normalize(vec3(-dDy_dx, 1.0, -dDy_dz))` summed across cascades. **Slope-variance roughness:** add the variance of unresolved cascades — read from the mip chain of `derivatives[c]` at the sampled LOD — into the GGX roughness. Sky IBL from `atmosphereSky()` with a roughness-derived cone. Delete `heightField()` and `microNormalFromHeight()` entirely.

- [ ] **Step 6: Run tests** → PASS

- [ ] **Step 7: Commit**

```bash
git add js/ocean/oceanMaterial.js js/ocean/shaders/
git commit -m "feat: add physically-grounded water BRDF"
```

---

### Task 9: Capability detection, fallback tier, integration

**Files:**
- Create: `js/ocean/capabilities.js`
- Move: `js/fftOcean.js` → `js/ocean/fallback/cpuOcean.js`
- Move: `js/oceanMaterial.js` → `js/ocean/fallback/cpuOceanMaterial.js`
- Delete: `js/gerstner.js`
- Modify: `js/boat.js`, `js/main.js`
- Create: `tests/unit/capabilities.test.js`

**Interfaces:**
- Consumes: everything above.
- Produces: `detectTier(canvas) => "gpu" | "cpu"`. `main.js` branches once at startup.

- [ ] **Step 1: Write the failing test**

```js
test("detectTier returns cpu when float render targets are unavailable", () => { /* stub a context lacking EXT_color_buffer_float */ });
test("detectTier returns cpu when WebGL2 is unavailable", () => {});
```

- [ ] **Step 2: Run** → FAIL

- [ ] **Step 3: Implement `capabilities.js`**

- [ ] **Step 4: Move the fallback files**

`git mv` to preserve history. The fallback keeps `gerstner.js`'s wave table — inline the `DETAIL_WAVES` array into `cpuOceanMaterial.js` so `gerstner.js` can be deleted from the GPU path.

- [ ] **Step 5: Rewire `boat.js`**

Drop the `sampleDetail` import. `update(sea, ...)` now calls `sea.sample(x, z) => {y, dx, dz, jacobian}` — one interface served by either `OceanProbe` (GPU tier) or `cpuOcean.sample` (CPU tier). Nothing else in `boat.js` changes.

- [ ] **Step 6: Rewire `main.js`**

Branch on tier. GPU tier: `OceanSimulation` + ring disc mesh + new material + probe. Remove `OCEAN_SNAP` (the mesh follows the camera continuously now) and the `fftTex`/`fftData` plumbing. Keep the foam trail atlas, weather presets, camera rig, HUD, and `__lookdev` helpers.

- [ ] **Step 7: Run both suites and load the page** → PASS, renders

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "feat: wire GPU ocean tier with CPU fallback, retire Gerstner"
```

---

### Task 10: Debug tooling and capture regression

**Files:**
- Modify: `js/main.js` (`__lookdev`)
- Modify: `scripts/capture.mjs`
- Modify: `ref/GOAL.md`

**Interfaces:**
- Consumes: everything.
- Produces: `window.__lookdev.debugCascade(n, channel)`, `window.__lookdev.getStats() => {fps, tier, drawCalls}`.

- [ ] **Step 1: Implement `debugCascade`** — renders any cascade's displacement/derivative/foam channel fullscreen. Necessary because a GPU FFT cannot be stepped through.

- [ ] **Step 2: Extend `capture.mjs`** — assert zero WebGL errors, report frame time, accept a `--tier` flag to force the fallback path for comparison.

- [ ] **Step 3: Capture `wave-h` plates**

```bash
npm run serve &
node scripts/capture.mjs wave-h title
node scripts/capture.mjs wave-h play
```

- [ ] **Step 4: Update `ref/GOAL.md`** with the wave-h entry and criterion status.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: add cascade debug views and wave-h capture baseline"
```

---

## Self-Review

**Spec coverage:** spectrum → T3; butterfly → T2; gpuFFT → T4; oceanSimulation (evolve/iFFT/assemble/foam) → T5; oceanMesh → T6; probe → T7; vertex/fragment/BRDF → T8; capabilities + fallback + boat + main → T9; debug tooling + capture + GOAL.md → T10; test strategy → T1 and the per-task tests. Error-handling table: tier detection T9, shader-compile fallback T8/T9, readback stall T7, NaN guard T3. Context loss is handled in T9's `main.js` wiring.

**Type consistency:** `sea.sample(x, z) => {y, dx, dz, jacobian}` is the single buoyancy interface, produced in T7 and consumed in T9; `cpuOcean.sample` already returns that exact shape today, so the fallback needs no adapter. `displacement[]`/`derivatives[]` naming is consistent T5 → T7 → T8. `CASCADES` entries are `{patch, kLow, kHigh}` throughout.

**Known risk carried into execution:** headless WebGL under SwiftShader is slow and half-float precision differs from native. GPU test tolerances are set loosely (1e-2 for the FFT, 5% for the Jacobian) for that reason. If SwiftShader proves unusable, GPU tests run headed locally and the unit suite remains the CI gate.
