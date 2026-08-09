# Goal: Photo-matched open ocean

**Ground truth:** `ref/ocean-photo-target.jpg`  
**Loop:** code → `node scripts/capture.mjs <wave> title|play` → visual review → next wave

## Success criteria (title plate, calm, midday)

| # | Criterion | Status (wave-f) |
|---|-----------|-----------------|
| 1 | Single water surface, no dual z-fight | **Done** |
| 2 | Near field without diamond facets | **Done** |
| 3 | Sky-dominated Fresnel surface | **Improved** — clear blue reflections |
| 4 | Soft horizon merge | **Done** (soft join) |
| 5 | Deep navy troughs | **Partial** — bluer, not yet near-black like photo |
| 6 | Sparse glitter / silver bands | **Partial** — soft bands, less pin glitter |
| 7 | Boat not black | **Done** (play plate) |
| 8 | Motion stable | **Done** |

**Closer, not closed** — wave-f is the best plate; photo still has darker troughs + richer silver face detail.

## Wave log

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
