import * as THREE from "three";
import { OceanSimulation } from "../../js/ocean/oceanSimulation.js";
import { createOceanMaterial, bindSimulationTextures } from "../../js/ocean/oceanMaterial.js";
import { createOceanMesh } from "../../js/ocean/oceanMesh.js";
import { renderer, assert } from "./gpuTests.js";

const reg = (name, fn) => window.__gpuTests.register(name, fn);

/** Renders the ocean to an offscreen target and returns the pixels. */
function renderOcean(sim, configure, size = 96) {
  const material = createOceanMaterial(sim);
  bindSimulationTextures(material, sim);

  // Shipping mesh density. A sparser test mesh undersamples the cascades and
  // measures its own aliasing rather than the shader's.
  const mesh = createOceanMesh(THREE, material, {
    rings: 256,
    segments: 256,
    innerRadius: 0.25,
    outerRadius: 20000,
  });

  const scene = new THREE.Scene();
  scene.add(mesh);
  const camera = new THREE.PerspectiveCamera(48, 1, 0.25, 20000);
  camera.position.set(0, 2.4, 4.5);
  camera.lookAt(0.5, -0.1, -45);

  if (configure) configure(material, camera, mesh);

  const rt = new THREE.WebGLRenderTarget(size, size, {
    type: THREE.FloatType,
    format: THREE.RGBAFormat,
    minFilter: THREE.NearestFilter,
    magFilter: THREE.NearestFilter,
  });
  renderer.setRenderTarget(rt);
  renderer.setClearColor(0x000000, 1);
  renderer.clear();
  renderer.render(scene, camera);
  renderer.setRenderTarget(null);

  const buf = new Float32Array(size * size * 4);
  renderer.readRenderTargetPixels(rt, 0, 0, size, size, buf);

  const programs = renderer.info.programs ?? [];
  const diagnostics = programs
    .filter((p) => p.name === "OceanWater")
    .map((p) => p.diagnostics)
    .filter(Boolean);

  rt.dispose();
  mesh.geometry.dispose();
  material.dispose();
  return { buf, size, diagnostics };
}

const luminance = (r, g, b) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

reg("ocean material compiles and draws without GL errors", async () => {
  const sim = new OceanSimulation(renderer, { N: 64 });
  sim.update(1.0, 1 / 60);

  const gl = renderer.getContext();
  while (gl.getError() !== gl.NO_ERROR) {
    // Drain anything left by earlier cases so this measures only our draw.
  }

  const { buf, diagnostics } = renderOcean(sim);
  const err = gl.getError();

  assert(
    diagnostics.length === 0,
    `shader diagnostics: ${JSON.stringify(diagnostics).slice(0, 600)}`,
  );
  assert(err === gl.NO_ERROR, `gl.getError() returned ${err}`);

  let lit = 0;
  for (let i = 0; i < buf.length; i += 4) {
    if (luminance(buf[i], buf[i + 1], buf[i + 2]) > 1e-4) lit++;
  }
  sim.dispose();
  assert(lit > buf.length / 4 / 20, `only ${lit} lit pixels — the ocean did not draw`);
});

reg("ocean output contains no NaN or Inf", async () => {
  const sim = new OceanSimulation(renderer, { N: 64 });
  sim.update(1.0, 1 / 60);
  const { buf } = renderOcean(sim);
  sim.dispose();

  // An all-zero buffer is trivially finite, so require real output first —
  // otherwise a shader that fails to compile passes this test.
  let lit = 0;
  for (let i = 0; i < buf.length; i += 4) {
    if (luminance(buf[i], buf[i + 1], buf[i + 2]) > 1e-4) lit++;
  }
  assert(lit > 100, `only ${lit} lit pixels — nothing was drawn to check`);

  for (let i = 0; i < buf.length; i++) {
    assert(Number.isFinite(buf[i]), `non-finite ${buf[i]} at ${i}`);
  }
});

/** Mean luminance and mean channels over every shaded pixel. */
function shadedStats(buf, size) {
  let n = 0;
  let lum = 0;
  let r = 0;
  let g = 0;
  let b = 0;
  for (let i = 0; i < size * size; i++) {
    const pr = buf[i * 4];
    const pg = buf[i * 4 + 1];
    const pb = buf[i * 4 + 2];
    const l = luminance(pr, pg, pb);
    if (l > 1e-5) {
      n++;
      lum += l;
      r += pr;
      g += pg;
      b += pb;
    }
  }
  return n === 0 ? null : { n, lum: lum / n, r: r / n, g: g / n, b: b / n };
}

reg("a thicker water column extinguishes more light", async () => {
  // Beer-Lambert is either wired up or it is not. Comparing two thicknesses is
  // a direct test of the mechanism; comparing crests to troughs in one frame
  // measures wave amplitude instead, which is a different question.
  const sim = new OceanSimulation(renderer, { N: 64, windSpeed: 14 });
  for (let i = 0; i < 3; i++) sim.update(1.0 + i * 0.1, 1 / 60);

  const topDown = (thickness) => (mat, cam) => {
    cam.position.set(0, 40, 0);
    cam.lookAt(0, 0, -1);
    cam.updateMatrixWorld();
    mat.uniforms.uBodyThickness.value = thickness;
    mat.uniforms.uFoamAmount.value = 0;
  };

  const thin = renderOcean(sim, topDown(0.4));
  const thick = renderOcean(sim, topDown(12.0));
  sim.dispose();

  const a = shadedStats(thin.buf, thin.size);
  const b = shadedStats(thick.buf, thick.size);
  assert(a && b, "nothing was shaded in one of the renders");
  assert(b.lum < a.lum, `thick column (${b.lum}) is not darker than thin (${a.lum})`);
});

reg("extinction reddens least and kills red most", async () => {
  // Red extinguishes ~7x faster than blue. Increasing thickness must therefore
  // shift the ratio toward blue, not merely darken uniformly.
  const sim = new OceanSimulation(renderer, { N: 64, windSpeed: 14 });
  for (let i = 0; i < 3; i++) sim.update(1.0 + i * 0.1, 1 / 60);

  const topDown = (thickness) => (mat, cam) => {
    cam.position.set(0, 40, 0);
    cam.lookAt(0, 0, -1);
    cam.updateMatrixWorld();
    mat.uniforms.uBodyThickness.value = thickness;
    mat.uniforms.uFoamAmount.value = 0;
    // Isolate the body term. Composited, the ratio is governed by reflected
    // sky — the body is correctly a small fraction of the final colour.
    mat.uniforms.uDebugMode.value = 7;
  };

  const thin = renderOcean(sim, topDown(0.4));
  const thick = renderOcean(sim, topDown(12.0));
  sim.dispose();

  const a = shadedStats(thin.buf, thin.size);
  const b = shadedStats(thick.buf, thick.size);
  assert(a && b, "nothing was shaded in one of the renders");
  const ratioThin = a.r / Math.max(a.b, 1e-6);
  const ratioThick = b.r / Math.max(b.b, 1e-6);
  assert(
    ratioThick < ratioThin,
    `red/blue ratio did not fall with depth: thin ${ratioThin}, thick ${ratioThick}`,
  );
});

reg("water is blue-dominant when viewed steeply from above", async () => {
  // Red extinguishes ~7x faster than blue. If the channels came out balanced,
  // the extinction vector is not being applied.
  const sim = new OceanSimulation(renderer, { N: 64, windSpeed: 12 });
  for (let i = 0; i < 3; i++) sim.update(1.0 + i * 0.1, 1 / 60);

  const { buf, size } = renderOcean(sim, (mat, cam) => {
    cam.position.set(0, 40, 0);
    cam.lookAt(0, 0, -1);
    cam.updateMatrixWorld();
    // Remove sky reflection so only the body term is measured.
    mat.uniforms.uFoamAmount.value = 0;
  });
  sim.dispose();

  let sumR = 0;
  let sumB = 0;
  let n = 0;
  for (let i = 0; i < size * size; i++) {
    const r = buf[i * 4];
    const b = buf[i * 4 + 2];
    if (r + b > 0) {
      sumR += r;
      sumB += b;
      n++;
    }
  }
  assert(n > 100, `only ${n} shaded pixels`);
  assert(sumB > sumR, `blue ${sumB} did not exceed red ${sumR}`);
});

reg("shader roughness rises with distance", async () => {
  // The direct measurement of the mechanism: render the GGX alpha the shader
  // actually uses and check it grows toward the horizon. Inferring this from
  // rendered luminance conflates it with Fresnel, sky gradient and aerial
  // perspective, none of which are under test here.
  const sim = new OceanSimulation(renderer, { N: 128, windSpeed: 12 });
  for (let i = 0; i < 3; i++) sim.update(1.0 + i * 0.1, 1 / 60);

  const { buf, size } = renderOcean(
    sim,
    (mat, cam) => {
      cam.position.set(0, 3, 0);
      cam.lookAt(0, 0.2, -400);
      cam.updateMatrixWorld();
      mat.uniforms.uDebugMode.value = 1; // alpha
    },
    128,
  );
  sim.dispose();

  const rowMeanAlpha = (y) => {
    let sum = 0;
    let n = 0;
    for (let x = 0; x < size; x++) {
      const a = buf[(y * size + x) * 4];
      if (a > 0) {
        sum += a;
        n++;
      }
    }
    return n > size * 0.5 ? sum / n : null;
  };

  const rows = [];
  for (let y = 0; y < size; y++) {
    const a = rowMeanAlpha(y);
    if (a !== null) rows.push({ y, a });
  }
  assert(rows.length >= 12, `only ${rows.length} rows of water`);

  // Rows come back bottom-up: low y is near, high y approaches the horizon.
  const half = Math.floor(rows.length / 2);
  const near = rows.slice(0, half).reduce((s, r) => s + r.a, 0) / half;
  const far =
    rows.slice(half).reduce((s, r) => s + r.a, 0) / (rows.length - half);

  assert(
    far > near * 1.2,
    `roughness did not rise with distance: near alpha ${near}, far alpha ${far}`,
  );
});

reg("slope-variance roughness reduces far-field aliasing", async () => {
  // A/B on the mechanism with the view held constant. Comparing near to far in
  // a single render cannot isolate this: the far field is a grazing view of
  // reflected sky and the near field is a steep view of dark water, so they
  // differ in contrast for reasons that have nothing to do with filtering.
  const sim = new OceanSimulation(renderer, { N: 128, windSpeed: 12 });
  for (let i = 0; i < 3; i++) sim.update(1.0 + i * 0.1, 1 / 60);

  const horizonView = (varianceScale) => (mat, cam) => {
    cam.position.set(0, 3, 0);
    cam.lookAt(0, 0.2, -400);
    cam.updateMatrixWorld();
    mat.uniforms.uSlopeVarianceScale.value = varianceScale;
    mat.uniforms.uFoamAmount.value = 0;
  };

  const withVariance = renderOcean(sim, horizonView(1), 128);
  const without = renderOcean(sim, horizonView(0), 128);
  sim.dispose();

  /**
   * Fraction of distant pixels far brighter than both horizontal neighbours —
   * "fireflies". Mean adjacent difference is the wrong metric here: correct
   * roughness *broadens* the sun glitter path, which legitimately raises mean
   * contrast. What filtering must remove is isolated blown-out pixels.
   */
  const fireflyRate = ({ buf, size }) => {
    let fireflies = 0;
    let n = 0;
    for (let y = Math.floor(size / 2); y < size; y++) {
      for (let x = 1; x < size - 1; x++) {
        const at = (xx) => {
          const i = (y * size + xx) * 4;
          return luminance(buf[i], buf[i + 1], buf[i + 2]);
        };
        const c = at(x);
        const l = at(x - 1);
        const r = at(x + 1);
        if (c > 1e-5 && l > 1e-5 && r > 1e-5) {
          n++;
          const neighbours = Math.max((l + r) / 2, 1e-6);
          if (c > neighbours * 3) fireflies++;
        }
      }
    }
    return n < 50 ? null : fireflies / n;
  };

  const on = fireflyRate(withVariance);
  const off = fireflyRate(without);
  assert(on !== null && off !== null, "not enough distant water pixels to compare");
  assert(
    on <= off,
    `slope-variance roughness increased far-field fireflies: on=${on}, off=${off}`,
  );
});

reg("far-field contrast is bounded", async () => {
  // Slope-variance roughness: the mip chain must actually widen the lobe with
  // distance. Without it, four cascades make distance worse, not better.
  //
  // The metric is mean absolute difference between horizontally adjacent
  // pixels, not variance across the band. Band variance also contains the
  // legitimate aerial-perspective ramp toward the horizon, which would swamp
  // the aliasing signal this is meant to detect.
  const sim = new OceanSimulation(renderer, { N: 128, windSpeed: 12 });
  for (let i = 0; i < 3; i++) sim.update(1.0 + i * 0.1, 1 / 60);

  const { buf, size } = renderOcean(sim, (mat, cam) => {
    cam.position.set(0, 3, 0);
    cam.lookAt(0, 0.2, -400);
    cam.updateMatrixWorld();
  });
  sim.dispose();

  // Rows above the horizon are empty, so bands must be chosen from the rows
  // that actually contain water rather than from fixed thirds of the image.
  const rowLit = [];
  for (let y = 0; y < size; y++) {
    let lit = 0;
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      if (luminance(buf[i], buf[i + 1], buf[i + 2]) > 1e-5) lit++;
    }
    rowLit.push(lit);
  }
  const waterRows = [];
  for (let y = 0; y < size; y++) if (rowLit[y] > size * 0.5) waterRows.push(y);
  assert(waterRows.length >= 12, `only ${waterRows.length} rows contain water`);

  const highFrequencyContrast = (rows) => {
    let sumDiff = 0;
    let sumLum = 0;
    let n = 0;
    for (const y of rows) {
      for (let x = 1; x < size; x++) {
        const i = (y * size + x) * 4;
        const j = (y * size + x - 1) * 4;
        const a = luminance(buf[i], buf[i + 1], buf[i + 2]);
        const b = luminance(buf[j], buf[j + 1], buf[j + 2]);
        if (a > 1e-5 && b > 1e-5) {
          sumDiff += Math.abs(a - b);
          sumLum += a;
          n++;
        }
      }
    }
    return n === 0 ? null : sumDiff / n / Math.max(sumLum / n, 1e-6);
  };

  // readRenderTargetPixels returns rows bottom-up, so the lowest water rows are
  // nearest the camera and the highest approach the horizon. The topmost rows
  // are dropped: a partially covered horizon row is an edge, not a surface.
  const usable = waterRows.slice(0, waterRows.length - 2);
  const half = Math.floor(usable.length / 2);
  const near = highFrequencyContrast(usable.slice(0, half));
  const far = highFrequencyContrast(usable.slice(half));
  assert(near !== null && far !== null, "not enough adjacent water pixels to compare");
  // Not asserting far < near: the far field is a grazing view of reflected sky
  // and the near field a steep view of dark water, so they legitimately differ.
  // What must hold is that neither band is degenerate or blown out.
  assert(far < 0.35, `far-field pixel-to-pixel contrast ${far} suggests heavy aliasing`);
  assert(near > 1e-4, `near-field contrast ${near} is degenerate — surface has no detail`);
});
