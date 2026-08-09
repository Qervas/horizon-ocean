# AAA GPU FFT Ocean — Design

**Date:** 2026-08-09
**Status:** Approved for planning
**Supersedes:** the CPU 128² single-cascade FFT in `js/fftOcean.js` and the 12-train Gerstner layer in `js/gerstner.js`

## Problem

The current ocean is structurally limited, not badly tuned. Five root causes:

1. **8-bit displacement.** `fillTextureData()` quantizes the whole field to 256 levels and renormalizes it against a drifting smoothed min/max every frame. Produces banding, terracing on gentle slopes, and low-frequency "breathing."
2. **One cascade at 340 m / 128².** 2.66 m per texel — no wavelength below ~5 m exists in the simulation. The 12 Gerstner trains exist only to fake that missing band, and sub-triangle Gerstner is what produced the diamond facets fought through waves A–F in `ref/GOAL.md`.
3. **Normals finite-differenced from a quantized texture.** Four extra fetches per vertex to approximate a quantity the FFT can produce exactly.
4. **Three 128² 2-D iFFTs per update in JS on the main thread.** A hard ceiling on resolution and a source of frame hitching.
5. **Phillips spectrum and fragment-shader value-noise micro-normals.** Phillips predates directional-spreading models; the 6-octave `heightField()` noise is a texture rather than water, and is why the surface reads *oily* instead of *wet*.

Symptoms recorded in `ref/GOAL.md` — troughs not reaching near-black (criterion 5) and glitter reading as soft bands rather than sparse pinpoints (criterion 6) — are downstream of 1, 3, and 5 and cannot be tuned away.

## Goals

- Wave simulation entirely on the GPU, in float precision, across four spectral cascades.
- Analytically exact normals and Jacobian, not finite differences.
- A physically-grounded water BRDF whose distant surface neither sparkle-aliases nor flattens to grey.
- Boat buoyancy sourced from the same displacement field the renderer draws.
- No regression on devices lacking WebGL2 float render targets.

## Non-goals

- Screen-space reflections. Considered and declined; sky IBL plus a correct BRDF carries the look, and SSR adds a prepass plus reprojection artifacts.
- A morphing geometric clipmap. Considered and declined; the finest cascades are carried by normals and slope-variance roughness, not vertex density, so the complexity does not pay for itself.
- Shoreline interaction, wave refraction, or depth-aware shoaling. The dispersion relation is written to admit finite depth so this stays open, but nothing is built for it now.
- Changes to `sky.js`, `atmosphere.js`, or `post.js`.

## Architecture

```
js/ocean/
  capabilities.js      WebGL2 + EXT_color_buffer_float probe → tier selection
  spectrum.js          JONSWAP + Donelan-Banner → h0(k) textures (CPU, once)
  butterfly.js         Cooley-Tukey butterfly lookup texture (CPU, once)
  gpuFFT.js            Generic ping-pong 2-D iFFT over RGBA16F MRT pairs
  oceanSimulation.js   Per-frame orchestration; owns all render targets
  oceanProbe.js        Async GPU readback for buoyancy
  oceanMesh.js         Concentric ring disc geometry
  oceanMaterial.js     Material construction + uniform plumbing
  shaders/
    oceanVertex.js     Cascade sampling + displacement
    oceanFragment.js   Composition
    waterBRDF.js       Multi-scatter GGX, transmission, subsurface, foam
  fallback/
    cpuOcean.js        Today's js/fftOcean.js, moved verbatim
    cpuOceanMaterial.js  Today's js/oceanMaterial.js, moved verbatim
```

`gpuFFT.js` knows nothing about oceans — it transforms RGBA16F targets. `oceanSimulation.js` is the only module that knows the cascade layout. `oceanProbe.js` exposes the shape `boat.js` already consumes.

**Unchanged:** `atmosphere.js`, `sky.js`, `post.js`.
**Deleted:** `js/gerstner.js`. Four cascades supersede all 12 trains.
**Modified:** `js/boat.js` loses its `sampleDetail` import and takes full displacement from the probe. `js/main.js` becomes tier-aware glue.

### Data flow

```
                      once at init
  spectrum.js  ──► h0[c] (RGBA32F, 256²)  ─┐
  butterfly.js ──► butterfly (RGBA32F, 8×256) ─┤
                                              │  every frame, per cascade c
                                              ▼
              ┌─────────────────────────────────────────────┐
              │ 1. evolve   h0 → ĥ(k,t)      1 draw, MRT×2  │
              │ 2. iFFT     8 horiz + 8 vert 16 draws, MRT×2│
              │ 3. assemble unpack 8 fields  1 draw, MRT×2  │
              └─────────────────────────────────────────────┘
                                              │
                        displacement[c] (Dx, Dy, Dz, J)
                        derivatives[c]  (∂Dy/∂x, ∂Dy/∂z, σ²x, σ²z)
                                              │
                            ┌─────────────────┴─────────────────┐
                            ▼                                   ▼
                     oceanMaterial                        oceanProbe
                     (vertex + fragment)          probe pass → 16×16 RGBA32F
                                                  → readRenderTargetPixelsAsync
                                                  → ring buffer → boat.js
```

## Component: spectrum.js

Builds the time-invariant initial spectrum `h₀(k)` once per cascade, on the CPU, into an RGBA32F `DataTexture` (RG = complex `h₀(k)`, BA = complex `h₀*(−k)`, so the evolution pass needs one fetch).

**JONSWAP**, parameterized by wind speed `U` and fetch `F`:

```
S(ω) = (α g² / ω⁵) · exp(−1.25 (ωp/ω)⁴) · γ^r
α    = 0.076 (U²/(F g))^0.22
ωp   = 22 (g²/(U F))^(1/3)
r    = exp(−(ω−ωp)² / (2 σ² ωp²)),  σ = 0.07 if ω ≤ ωp else 0.09
γ    = 3.3
```

**Donelan–Banner directional spreading**, which is what gives correct wind-sea directionality where Phillips gives only a `cos²` lobe:

```
D(ω,θ) = β sech²(β θ) / 2
β = 2.61 (ω/ωp)^1.3      for 0.56 < ω/ωp < 0.95
  = 2.28 (ω/ωp)^−1.3     for 0.95 ≤ ω/ωp < 1.6
  = 10^ε                 otherwise, ε = −0.4 + 0.8393 exp(−0.567 ln((ω/ωp)²))
```

Converted to a wavenumber spectrum via `ω = √(gk)`, `dω/dk = g/(2√(gk))`, giving `S(k) = S(ω)·(dω/dk)/k`. Then:

```
h₀(k) = (1/√2)(ξr + i ξi) √(2 S(k) D(k) Δkx Δkz)
```

with `ξr, ξi` Gaussian from the existing seeded `mulberry32`, so seas stay reproducible.

### Cascade band-limiting

Adjacent cascades must not carry overlapping wavenumbers or the shared band gets double energy — the most common bug in multi-cascade implementations, and it presents as water that looks plausible but too rough. Each cascade is clipped to `[k_low, k_high)` where the boundary is the Nyquist of the next-coarser cascade:

| Cascade | Patch L | k range | Wavelengths |
|---|---|---|---|
| 0 | 2048 m | [0, 0.393) | > 16 m — ocean swell |
| 1 | 512 m | [0.393, 1.571) | 4–16 m — wind sea |
| 2 | 128 m | [1.571, 6.283) | 1–4 m — chop |
| 3 | 32 m | [6.283, 25.13) | 0.25–1 m — ripple/capillary |

No overlap, no gaps. Cascade 0 tiles at 2048 m, so repetition is not visible from a 2–3 m camera.

### Loop quantization

Angular frequencies are snapped to integer multiples of `ω₀ = 2π/T` with `T = 200 s`, so the whole simulation loops seamlessly instead of drifting. Standard practice and it costs nothing.

## Component: gpuFFT.js

A generic ping-pong 2-D inverse FFT.

`butterfly.js` precomputes a `log2(256) = 8` × `256` RGBA32F texture holding, per stage and index, the twiddle factor (RG) and the two source indices (BA). Bit-reversal is baked into stage 0.

Each pass is a fullscreen quad over a 256² RGBA16F MRT pair, treating `.rg` and `.ba` as two independent complex fields. One pass therefore advances **four** complex fields across two attachments. 8 horizontal passes, then 8 vertical.

Interface:

```js
const fft = new GpuFFT(renderer, 256);
fft.inverse(targetA, targetB, pingA, pingB);  // in place, ping-pong internal
```

`gpuFFT.js` contains no ocean concepts and is separately testable against a reference DFT.

## Component: oceanSimulation.js

Owns all render targets and runs three stages per cascade per frame.

**Stage 1 — evolve** (1 draw, MRT×2). `ĥ(k,t) = h₀(k)e^{iωt} + h₀*(−k)e^{−iωt}` with `ω = √(g k tanh(k d))`, `d = 1000` (deep water; the `tanh` term is present so finite depth remains available later). Outputs four complex fields packed so a single iFFT yields all eight real fields needed:

```
RT0.rg = ĥy      + i·ĥx        → (Dy,      Dx)
RT0.ba = ĥz      + i·(ikx·ĥy)  → (Dz,      ∂Dy/∂x)
RT1.rg = ikz·ĥy  + i·(ikx·ĥx)  → (∂Dy/∂z, ∂Dx/∂x)
RT1.ba = ikz·ĥz  + i·(ikz·ĥx)  → (∂Dz/∂z, ∂Dx/∂z)
```

Horizontal displacement is `ĥx = −i (kx/k) ĥy`, `ĥz = −i (kz/k) ĥy`, scaled by a per-cascade choppiness.

**Stage 2 — iFFT** (16 draws). Delegated to `gpuFFT.js`.

**Stage 3 — assemble** (1 draw, MRT×2). Unpacks the eight real fields into two textures the material consumes directly:

- `displacement[c]` — RGBA16F — `(Dx, Dy, Dz, foam)`
- `derivatives[c]` — RGBA16F — `(∂Dy/∂x, ∂Dy/∂z, σ²x, σ²z)`

The Jacobian is computed here, exactly:

```
J = (1 + ∂Dx/∂x)(1 + ∂Dz/∂z) − (∂Dx/∂z)²
```

The cross terms are equal and only one is transformed. Both `Dx` and `Dz` derive from the same `ĥy`, so `∂Dx/∂z = ikz(−i kx/k)ĥy = (kx kz/k)ĥy = ikx(−i kz/k)ĥy = ∂Dz/∂x`. This is why eight real fields suffice rather than nine, and why the packing table has no `∂Dz/∂x` row.

Slope variance `σ²x, σ²z` is the second moment of the slope distribution, written per-texel and mip-mapped so the fragment shader can read pre-filtered sub-pixel roughness (see BRDF below).

**Foam accumulation.** Foam has memory: it persists for seconds after the fold that created it. A separate persistent RGBA16F buffer per cascade accumulates `max(0, foamThreshold − J)` and decays exponentially per frame. This replaces the current instantaneous `smoothstep(1 - J)`, which makes foam blink on and off.

**Cost:** 4 cascades × 18 draws = **72 fullscreen draws at 256²** ≈ 4.7 M pixel invocations, roughly a quarter of one 1080p frame's fill.

Four cascades are held as four separate render target pairs rather than a 2-D array, so the material takes eight `sampler2D` uniforms. Array textures would cut draw calls but complicate layered rendering in WebGL2; deferred as a possible optimization.

## Component: oceanMesh.js

Replaces the 960 m / 640² uniform plane (410 k verts, uniform 1.5 m spacing — unable to resolve near-field detail while spending most of its budget past 300 m, where the current shader hides the 480 m horizon behind a milky fog blend).

A concentric ring disc centred on the camera:

- 256 angular segments, 256 radial rings, plus a small centre cap to avoid the pole singularity.
- Radial spacing exponential: `r(i) = r₀ · (R/r₀)^(i/N)` with `r₀ = 0.25 m`, `R = 20 km`.
- ~65 k vertices — six times cheaper than today, with far higher near-field density and a true horizon.
- Translates with the camera in XZ; all sampling is world-space, so no snapping and no vertex swimming.

This removes the `OCEAN_SNAP = 16` workaround in `main.js` and lets the horizon fog in the fragment shader drop to a physically-motivated aerial-perspective term instead of the current fudge that pales the whole mid-field.

## Component: shaders — vertex

Samples all four `displacement[c]` at `worldXZ / L_c`, sums them with a per-cascade weight that fades the two finest cascades out with distance (they are below a pixel beyond ~80 m and only alias if kept geometrically). Displacement is applied in full 3-D — `Dx` and `Dz` produce the sharpened crests and flattened troughs of real gravity waves.

The vertex stage no longer computes normals. It passes world position and per-cascade UVs; normals come from the derivative textures in the fragment stage, where they can be mip-filtered.

## Component: shaders — fragment / BRDF

**Normals.** Reconstructed from `derivatives[c]`: `N = normalize(−∂Dy/∂x, 1, −∂Dy/∂z)` summed across cascades. The 6-octave value-noise `heightField()` is deleted.

**Slope-variance roughness (LEAN / Baker).** The cascades a pixel can no longer resolve are folded into the GGX roughness by adding their slope variance to the roughness term, read from the mip chain of `derivatives[c]` at the LOD the pixel actually samples. This is the single largest contributor to the target look: it is why distant water in shipped titles neither sparkle-aliases nor flattens to grey. Without it, four cascades of detail make distance *worse*, not better.

**Specular.** Multi-scatter GGX via the Fdez-Agüera split-sum, with an analytic environment-BRDF approximation so no LUT texture is needed. Water `F₀ = 0.02`, Smith height-correlated visibility.

**Transmission.** Beer–Lambert with clear-ocean extinction `σ ≈ [0.45, 0.09, 0.06] m⁻¹`, integrated over a path length derived from wave height relative to sea level and view angle. This is what produces genuinely near-black troughs — `ref/GOAL.md` criterion 5, unresolved since wave D — because red is extinguished within ~2 m of water while blue survives ~15 m.

**Subsurface.** Scattering driven by wave height and view/sun alignment, strongest on backlit crests where the water column is thin. Replaces the hand-tuned `pow(dot(V, −L + N*0.6), 2.2)`.

**Foam.** Sampled from the accumulated foam buffers, shaded as a rough dielectric rather than blended toward white. The existing wake-trail atlas from `main.js` remains an additive input, unchanged.

**Sky IBL.** `atmosphereSky()` unchanged, sampled along the reflection vector with a cone width derived from the final roughness — sharp on calm water, blurred on rough.

## Component: oceanProbe.js

Buoyancy reads back the same displacement field that is rendered.

**Probe pass.** A 16×16 RGBA32F target — 256 slots, of which `boat.js` uses 7. Each texel takes a world XZ from a uniform array and evaluates summed displacement across all four cascades.

Displacement is a *forward* map: it says where a grid point moves to, not what the height is at a given XZ. Sampling it directly is the classic wrong-buoyancy bug, visible as a boat that rides beside crests rather than on them once chop is significant. The probe therefore runs three fixed-point iterations to invert the horizontal displacement:

```
p = xz
repeat 3×:  p = xz − horizontalDisplacement(p)
height = Dy(p)
```

**Readback.** `renderer.readRenderTargetPixelsAsync(probeRT, 0, 0, 16, 16, buffer)` into a 3-deep ring of buffers. Never awaited inline — a request is issued each frame and results land 1–2 frames later. 1 KB per frame.

**Latency compensation.** Measured readback latency is tracked as a rolling average. Probe positions are submitted *extrapolated forward* by `latency × boatVelocity`, so results arrive already correct for the present position. Residual error is absorbed by the spring-damper already in `boat.js`, which is close to critically damped.

**Degradation.** Before the first readback lands, and if any readback stalls beyond 4 frames, the probe falls back to an analytic estimate from cascade 0's dominant components. The boat never freezes or falls through the surface.

## Component: capabilities.js and the fallback tier

Probes for WebGL2 and `EXT_color_buffer_float`. On failure, `main.js` instantiates `fallback/cpuOcean.js` and `fallback/cpuOceanMaterial.js` — today's code moved verbatim, no behaviour change — and skips the probe entirely, using the CPU FFT's existing `sample()` for buoyancy.

The tier is chosen once at startup and never switches. Accepted cost: the current shader stays in the tree, so look changes are a two-place edit. Explicitly chosen to avoid a black screen on unsupported hardware.

## Error handling

| Failure | Response |
|---|---|
| No WebGL2 / no float RT | Fallback tier, logged once |
| Shader compile failure in the GPU tier | Log the compile error, fall back to the CPU tier |
| Readback stalls > 4 frames | Analytic buoyancy estimate; retry next frame |
| Readback rejects | Drop the ring slot, log once, continue |
| Context loss | Rebuild targets and reseed the spectrum on restore |

`NaN` in the spectrum is the realistic silent failure — `k = 0` divides by zero in the directional term and propagates through the FFT to a black or exploding surface. `spectrum.js` guards `k < 1e-6` explicitly, and the CPU-vs-GPU parity test below would catch a regression.

## Testing

An FFT that is subtly wrong still looks like water, so correctness cannot be judged by eye.

1. **`gpuFFT` against a reference DFT.** Transform a known small input, compare against a direct O(n²) DFT in JS, assert agreement to float tolerance. Catches butterfly indexing and bit-reversal errors, which are the likeliest bugs and the hardest to see.
2. **GPU/CPU spectrum parity.** Seed the GPU pipeline and the existing CPU implementation with the same spectrum and assert the height fields agree within tolerance. Catches packing and sign errors in the evolution and assemble stages.
3. **Jacobian parity.** Compare the analytic Jacobian from the assemble pass against a finite-difference Jacobian of the displacement field.
4. **Probe inversion.** Assert the probe's fixed-point inversion recovers a known displaced position to sub-centimetre accuracy under storm-scale chop.
5. **Buoyancy under latency.** Simulate 3-frame readback latency and assert the boat's vertical position tracks the true surface within tolerance at full speed.
6. **Capture regression.** Extend `scripts/capture.mjs` to assert zero WebGL errors, report frame time, and emit `wave-h-*` plates for comparison against `ref/ocean-photo-target.jpg`.

`window.__lookdev.debugCascade(n)` renders any cascade's displacement, derivative, or foam channel fullscreen — necessary because a GPU FFT cannot be stepped through in a debugger.

## Verification against `ref/GOAL.md`

| # | Criterion | Mechanism |
|---|---|---|
| 3 | Sky-dominated Fresnel | Multi-scatter GGX + roughness-coned sky IBL |
| 5 | Deep navy troughs | Beer–Lambert extinction, red gone within ~2 m |
| 6 | Sparse glitter | Slope-variance roughness — real sub-pixel distribution, not a noise mask |
| 8 | Motion stable | Loop-quantized ω; world-space sampling on a camera-following mesh |

## Risks

- **Band-limiting errors** double-count energy across cascades and read as plausible-but-too-rough water. Mitigated by test 2.
- **Readback latency on some drivers** may exceed the 1–2 frame assumption. Mitigated by measured (not assumed) latency and the analytic degradation path.
- **72 draws/frame** is fill-cheap but draw-call-bound on weak integrated GPUs. If it measures badly, cascade 3 can be dropped to 128², or cascades can move to a texture array.
- **Fallback drift**: the two tiers will diverge cosmetically over time. Accepted.
