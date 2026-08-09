# Goal: Photo-matched open ocean

**Ground truth:** `ref/ocean-photo-target.jpg`  
**Loop:** code → `node scripts/capture.mjs <wave> title|play` → visual review → next wave

## Success criteria (title plate, calm, midday)

| # | Criterion | Status (wave-h) |
|---|-----------|-----------------|
| 1 | Single water surface, no dual z-fight | **Done** |
| 2 | Near field without diamond facets | **Done** — Gerstner retired, facets are structurally impossible now |
| 3 | Sky-dominated Fresnel surface | **Improved** — double-Fresnel bug fixed, reflection now added not mixed |
| 4 | Soft horizon merge | **Improved** — real 20 km horizon, aerial perspective instead of fog fudge |
| 5 | Deep navy troughs | **Improved** — Beer-Lambert extinction; still reads more saturated than the photo |
| 6 | Sparse glitter / silver bands | **Done** — real slope-variance glitter path, no noise mask |
| 7 | Boat not black | **Partial** — hull readable, cabin roof still dark |
| 8 | Motion stable | **Done** — loop-quantised omega, world-space sampling |

**Form solved, colour not.** wave-h transforms the wave structure: four FFT
cascades, exact normals, a true horizon. The remaining gap is the grade — the
water still reads as a saturated blue where the photo is a paler,
sky-dominated surface. That is a look-dev problem now, not a structural one.

## Wave log

### Wave H — GPU FFT rewrite
- Replaced the CPU 128² single-cascade RGBA8 FFT with a 4-cascade GPU FFT at
  256² in float; retired `gerstner.js` entirely
- JONSWAP + Donelan-Banner spectrum, band-limited so cascades tile without
  overlap; exact analytic normals and Jacobian; accumulated foam
- Concentric ring disc mesh (65k verts, 0.25 m → 20 km) replacing the 960 m /
  410k-vert uniform plane
- Multi-scatter GGX, Beer-Lambert transmission, slope-variance (LEAN) roughness
- Boat buoyancy via async GPU readback of the same displacement field
- Captures: `ref/captures/wave-h-*.png`
- Review: wave form and horizon transformed; colour grade still too saturated

### Wave A
- Single dense mesh, LOD, boat materials, stronger Fresnel
- Captures: `ref/captures/wave-a-*.png`
- Result: facets gone, boat readable; flat grey water

### Wave B
- Bluer sky uniforms, more swell, hide islands on title, silver bands
- Captures: `ref/captures/wave-b-*.png`
- Result: still overcast milky; island off title plate

### Wave C
- Thinner atmosphere haze, horizon wash, grade contrast
- Captures: `ref/captures/wave-c-*.png`
- Result: soft oily reflections; soft horizon; still pale

### Wave D
- Darker troughs, less mid-field fog wash, more calm FFT amp
- Captures: `ref/captures/wave-d-*.png`
- Review: soft oily plate; still pale

### Wave E
- Richer blue sky/chroma, more swell amp, trough residual, grade punch
- Captures: `ref/captures/wave-e-*.png`
- Review: real blue returns; swell form clear

### Wave F
- Deeper zenith blue, near-black trough residual, silver ridges, lower cam
- Captures: `ref/captures/wave-f-*.png`
- Review: **best so far** — clear blue sky + sea; soft horizon; boat lit

## How to run the loop

```bash
npx --yes serve . -l 5173
node scripts/capture.mjs wave-x title
node scripts/capture.mjs wave-x play
```

Helpers on `window.__lookdev`: `titlePlate()`, `playPlate()`, `hideHud()`, `setWeather()`.

## Next waves (if continuing)

1. Richer sky blue / sun path (match photo blue zenith)
2. Stronger multi-scale swell without reintroducing facets
3. Optional: real HDRI env for reflections (largest remaining leap)
