# Horizon Ocean

Photo-oriented **FFT + Gerstner** hybrid ocean with multi-point buoyancy.

## Features

- **128² Tessendorf FFT** swell (Phillips spectrum, chop, Jacobian foam)
- **12 Gerstner trains** (mid chop → capillary) in the shader
- **Dual ocean mesh** — dense near field + large far field
- **Volumetric water** — absorption, SSS crests, Schlick Fresnel, GGX sun glints
- **Multi-scale micro-normals** for wind ripples without mesh density
- **ACES filmic + bloom** post stack, soft vignette
- **Atmospheric sky** with horizon haze and clouds (HDR, shared with reflections)
- **Multi-point buoyancy**, wave drift, planing lift, V-wake foam
- **Mobile-ready** — adaptive mesh density / FFT update rate

## Play

After enabling GitHub Pages (once):

**https://qervas.github.io/horizon-ocean/**

One-time setup:
1. Open repository **Settings → Pages**
2. Source → **GitHub Actions** (or Deploy from branch **main** / root)
3. Save — the workflow deploys on every push to `main`

Locally: serve the folder over HTTP (ES modules require a server):

```bash
npx --yes serve .
```

Controls: **Launch**, then WASD / touch sticks. Settings gear for time of day and sea state.

## Stack

- Three.js `0.170` (import map / CDN)
- No build step — static files only
