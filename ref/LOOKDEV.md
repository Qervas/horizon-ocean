# Look-dev loop

**Ground truth:** `ref/ocean-photo-target.jpg`

## Loop process

1. Open the sim title plate (before Launch) — pure open ocean, low camera.
2. Compare side-by-side with the reference image.
3. Adjust one layer only (atmosphere, Fresnel/body, waves, grade).
4. Re-check. Repeat until the plate holds next to the photo.

## Target traits (from photo)

| Trait | Target |
|-------|--------|
| Surface | Mostly sky reflection (Fresnel), not painted blue |
| Horizon | Soft merge — sea ≈ sky value |
| Near troughs | Deep navy / near black |
| Wave faces | Soft silvery curved bands |
| Glitter | Sparse pinpoints, wind-streaked |
| Foam | Almost none on calm |
| Grade | Cool daylight, low contrast haze |
| Camera | Low (~2–3 m), looking to horizon |

## Current code hooks

- Shared sky: `js/atmosphere.js` → sky + ocean reflections
- Water model: `js/oceanMaterial.js` (reflection-first)
- Default sea: **calm** in `js/main.js`
- Grade: `js/post.js` (cool, soft)

## Do not “fix” by

- Cranking bloom / saturation
- Adding more foam
- Orbiting the boat on the title plate
- Making water a brighter blue material
- Dual near/far ocean meshes (z-fight + crawl glitches)

## Mesh notes (after glitch fix)

- **One** ocean plane only (`oceanMesh` in `main.js`)
- Recenters with an 8 m snap (not every-frame dual layer)
- Gerstner LOD by camera distance; short waves culled far away
- Boat uses MeshStandard (Physical went black without env map)
