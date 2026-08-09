import * as THREE from "three";
import { GpuFFT, createFFTTarget } from "../../js/ocean/gpuFFT.js";
import { mulberry32 } from "../../js/ocean/spectrum.js";

const reg = (name, fn) => window.__gpuTests.register(name, fn);

/** One renderer shared by every case — context creation is the slow part. */
export const renderer = new THREE.WebGLRenderer({
  canvas: document.getElementById("c"),
  antialias: false,
});

export function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

const _blitScene = new THREE.Scene();
const _blitCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
const _blitMat = new THREE.RawShaderMaterial({
  glslVersion: THREE.GLSL3,
  vertexShader: `in vec3 position; void main(){ gl_Position = vec4(position.xy,0.0,1.0); }`,
  fragmentShader: `
    precision highp float;
    uniform sampler2D tSrc;
    out vec4 outColor;
    void main() { outColor = texelFetch(tSrc, ivec2(gl_FragCoord.xy), 0); }`,
  uniforms: { tSrc: { value: null } },
  depthTest: false,
  depthWrite: false,
});
const _blitQuad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), _blitMat);
_blitQuad.frustumCulled = false;
_blitScene.add(_blitQuad);

/**
 * Reads one attachment of an MRT target.
 *
 * three r170's readRenderTargetPixels has no textureIndex parameter — it stops
 * at activeCubeFaceIndex — so any extra argument is silently ignored and you
 * always get attachment 0. Blitting the wanted attachment to a single-
 * attachment target is the only reliable way to read the others on this
 * version.
 */
export function readAttachment(target, index, N) {
  const tmp = new THREE.WebGLRenderTarget(N, N, {
    type: THREE.FloatType,
    format: THREE.RGBAFormat,
    minFilter: THREE.NearestFilter,
    magFilter: THREE.NearestFilter,
    depthBuffer: false,
    stencilBuffer: false,
    generateMipmaps: false,
  });
  _blitMat.uniforms.tSrc.value = target.textures[index];
  const prev = renderer.getRenderTarget();
  renderer.setRenderTarget(tmp);
  renderer.render(_blitScene, _blitCam);
  renderer.setRenderTarget(prev);

  const buf = new Float32Array(N * N * 4);
  renderer.readRenderTargetPixels(tmp, 0, 0, N, N, buf);
  tmp.dispose();
  return buf;
}

reg("renderer has a WebGL2 context", async () => {
  assert(renderer.capabilities.isWebGL2 === true, "not a WebGL2 context");
});

reg("float render targets are supported", async () => {
  const gl = renderer.getContext();
  assert(gl.getExtension("EXT_color_buffer_float") !== null, "EXT_color_buffer_float missing");
});

// ---------------------------------------------------------------------------
// Reference transform
// ---------------------------------------------------------------------------

/**
 * Direct O(N^4) 2-D inverse DFT, unnormalised, matching GpuFFT's convention.
 * Deliberately the naive formula: it is the independent oracle, so it must not
 * share any structure with the implementation under test.
 */
function referenceInverseDFT2D(src, N) {
  const out = new Float32Array(N * N * 2);
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      let sumRe = 0;
      let sumIm = 0;
      for (let m = 0; m < N; m++) {
        for (let n = 0; n < N; n++) {
          const re = src[(m * N + n) * 2];
          const im = src[(m * N + n) * 2 + 1];
          const ang = (2 * Math.PI * ((n * x) / N + (m * y) / N));
          const c = Math.cos(ang);
          const s = Math.sin(ang);
          sumRe += re * c - im * s;
          sumIm += re * s + im * c;
        }
      }
      out[(y * N + x) * 2] = sumRe;
      out[(y * N + x) * 2 + 1] = sumIm;
    }
  }
  return out;
}

/** Uploads four complex fields into an MRT pair, runs the FFT, reads back. */
function runGpuFFT(fields, N) {
  const target = createFFTTarget(N);

  // A render pass is the only way to write into a render target's texture.
  const seedTex = [0, 1].map((i) => {
    const t = new THREE.DataTexture(fields[i], N, N, THREE.RGBAFormat, THREE.FloatType);
    t.minFilter = THREE.NearestFilter;
    t.magFilter = THREE.NearestFilter;
    t.colorSpace = THREE.NoColorSpace;
    t.needsUpdate = true;
    return t;
  });

  const seedMat = new THREE.RawShaderMaterial({
    glslVersion: THREE.GLSL3,
    vertexShader: `in vec3 position; void main(){ gl_Position = vec4(position.xy,0.0,1.0); }`,
    fragmentShader: `
      precision highp float;
      uniform sampler2D t0; uniform sampler2D t1;
      layout(location = 0) out vec4 o0;
      layout(location = 1) out vec4 o1;
      void main() {
        ivec2 px = ivec2(gl_FragCoord.xy);
        o0 = texelFetch(t0, px, 0);
        o1 = texelFetch(t1, px, 0);
      }`,
    uniforms: { t0: { value: seedTex[0] }, t1: { value: seedTex[1] } },
    depthTest: false,
    depthWrite: false,
  });

  const scene = new THREE.Scene();
  const cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), seedMat);
  quad.frustumCulled = false;
  scene.add(quad);

  renderer.setRenderTarget(target);
  renderer.render(scene, cam);
  renderer.setRenderTarget(null);

  const fft = new GpuFFT(renderer, N);
  fft.inverse(target);

  const out = [readAttachment(target, 0, N), readAttachment(target, 1, N)];

  fft.dispose();
  target.dispose();
  seedTex.forEach((t) => t.dispose());
  seedMat.dispose();
  quad.geometry.dispose();
  return out;
}

reg("gpuFFT matches a reference inverse DFT on all four complex lanes", async () => {
  const N = 16;
  const rng = mulberry32(7);

  // Four independent complex fields: attachment 0 rg/ba, attachment 1 rg/ba.
  // Each must transform independently — a bug that cross-wires lanes would
  // otherwise only surface later as wrong surface derivatives.
  const lanes = [];
  for (let l = 0; l < 4; l++) {
    const f = new Float32Array(N * N * 2);
    for (let i = 0; i < f.length; i++) f[i] = rng() * 2 - 1;
    lanes.push(f);
  }

  const fields = [new Float32Array(N * N * 4), new Float32Array(N * N * 4)];
  for (let i = 0; i < N * N; i++) {
    fields[0][i * 4 + 0] = lanes[0][i * 2];
    fields[0][i * 4 + 1] = lanes[0][i * 2 + 1];
    fields[0][i * 4 + 2] = lanes[1][i * 2];
    fields[0][i * 4 + 3] = lanes[1][i * 2 + 1];
    fields[1][i * 4 + 0] = lanes[2][i * 2];
    fields[1][i * 4 + 1] = lanes[2][i * 2 + 1];
    fields[1][i * 4 + 2] = lanes[3][i * 2];
    fields[1][i * 4 + 3] = lanes[3][i * 2 + 1];
  }

  const got = runGpuFFT(fields, N);

  const laneSource = [
    { buf: 0, off: 0 },
    { buf: 0, off: 2 },
    { buf: 1, off: 0 },
    { buf: 1, off: 2 },
  ];

  for (let l = 0; l < 4; l++) {
    const expected = referenceInverseDFT2D(lanes[l], N);
    const { buf, off } = laneSource[l];
    let maxErr = 0;
    let scale = 0;
    for (let i = 0; i < N * N; i++) {
      for (let c = 0; c < 2; c++) {
        const e = expected[i * 2 + c];
        const a = got[buf][i * 4 + off + c];
        maxErr = Math.max(maxErr, Math.abs(e - a));
        scale = Math.max(scale, Math.abs(e));
      }
    }
    const rel = maxErr / Math.max(scale, 1e-6);
    assert(rel < 5e-3, `lane ${l}: relative error ${rel} (abs ${maxErr}, scale ${scale})`);
  }
});

reg("gpuFFT of a single DC mode is a constant field", async () => {
  // Independent of the reference implementation: the k=0 mode alone must
  // produce a flat field equal to its amplitude everywhere.
  const N = 16;
  const fields = [new Float32Array(N * N * 4), new Float32Array(N * N * 4)];
  fields[0][0] = 3.5; // DC real part of lane 0

  const got = runGpuFFT(fields, N);
  for (let i = 0; i < N * N; i++) {
    const v = got[0][i * 4];
    assert(Math.abs(v - 3.5) < 1e-3, `texel ${i} was ${v}, expected flat 3.5`);
  }
});

reg("gpuFFT output contains no NaN or Inf", async () => {
  const N = 32;
  const rng = mulberry32(11);
  const fields = [new Float32Array(N * N * 4), new Float32Array(N * N * 4)];
  for (const f of fields) for (let i = 0; i < f.length; i++) f[i] = rng() * 2 - 1;

  const got = runGpuFFT(fields, N);
  for (const buf of got) {
    for (let i = 0; i < buf.length; i++) {
      assert(Number.isFinite(buf[i]), `non-finite value ${buf[i]} at ${i}`);
    }
  }
});
