# Goal: Photo-matched open ocean

**Ground truth:** `ref/ocean-photo-target.jpg`  
**Loop:** code → `node scripts/capture.mjs <wave> title|play` → visual review → next wave

## Success criteria (title plate, calm, midday)

| # | Criterion | Status (wave-j) |
|---|-----------|-----------------|
| 1 | Single water surface, no dual z-fight | **Done** |
| 2 | Near field without diamond facets | **Done** — Gerstner retired, facets are structurally impossible now |
| 3 | Sky-dominated Fresnel surface | **Done** — double-Fresnel fixed, and reflections now share the sky dome's exposure |
| 4 | Soft horizon merge | **Done** — real 20 km horizon plus a wide haze band, no fog fudge |
| 5 | Deep navy troughs | **Improved** — slate blue; photo is still a shade more desaturated |
| 6 | Sparse glitter / silver bands | **Done** — real slope-variance glitter path, no noise mask |
| 7 | Boat not black | **Partial** — hull readable, cabin roof still dark |
| 8 | Motion stable | **Done** — loop-quantised omega, world-space sampling |

**Closest plate yet.** wave-j exposed JONSWAP fetch and peak enhancement per
sea state, which is what finally produced the reference's broad glassy swell
faces — the calm preset is now a 250 km fetch at gamma 6, a long-period swell
rather than a short confused wind sea. Combined with wave-i's exposure fix, the
form and value structure both track the photo.

Remaining gap is one axis only: the photo is more desaturated — silver-grey
where this is still blue. That is grade, not simulation.

## Wave log

### Wave J — JONSWAP fetch and peak enhancement
- Exposed `fetch` and `gamma` per sea state; both were hardcoded (100 km, 3.3)
- **Fetch runs the opposite way to intuition**: omega_p = 22 (g^2/(U F))^(1/3),
  so a *longer* fetch gives *longer* waves. Long glassy swell needs more fetch,
  not less
- `gamma` is the swell/chop knob: high values concentrate energy at the peak
  (regular swell), low values spread it (confused sea)
- calm = 250 km / gamma 6 (~7 s, ~75 m swell); storm = 60 km / gamma 2
- First attempt used 900 km, which gave physically correct 200 m waves that were
  far too tall to read as calm
- Captures: `ref/captures/wave-j-*.png`

### Wave I — colour pass on the GPU ocean
- **Sky dome and water reflections rendered at different exposures** — the dome
  applied `sun.exposure * 1.25`, the water reflected raw `atmosphereSky()`.
  Every reflection was ~1.7x too dim, which is why the sea read far darker than
  the horizon it met. Water now takes `uSkyExposure`.
- Softened the two hard blue pushes in `atmosphere.js` and widened the horizon
  haze band; both were added in waves B-F to fight washed-out grey water that
  the GPU ocean no longer produces
- Paler sky palette in `sky.js`; calm preset dropped to 4.6 m/s wind
- Aerial perspective raised to merge sea into sky across the far field
- Captures: `ref/captures/wave-i-*.png`

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
