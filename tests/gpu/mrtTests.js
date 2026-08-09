import * as THREE from "three";
import { createFFTTarget } from "../../js/ocean/gpuFFT.js";
import { renderer, assert, readAttachment } from "./gpuTests.js";

const reg = (name, fn) => window.__gpuTests.register(name, fn);

/** Seed both MRT attachments with distinct constants, read back, no FFT. */
reg("MRT: both attachments round-trip through seed and readback", async () => {
  const N = 8;
  const f0 = new Float32Array(N * N * 4);
  const f1 = new Float32Array(N * N * 4);
  for (let i = 0; i < N * N; i++) {
    f0[i * 4 + 0] = 1;
    f0[i * 4 + 1] = 2;
    f0[i * 4 + 2] = 3;
    f0[i * 4 + 3] = 4;
    f1[i * 4 + 0] = 5;
    f1[i * 4 + 1] = 6;
    f1[i * 4 + 2] = 7;
    f1[i * 4 + 3] = 8;
  }

  const mk = (d) => {
    const t = new THREE.DataTexture(d, N, N, THREE.RGBAFormat, THREE.FloatType);
    t.minFilter = THREE.NearestFilter;
    t.magFilter = THREE.NearestFilter;
    t.colorSpace = THREE.NoColorSpace;
    t.needsUpdate = true;
    return t;
  };
  const t0 = mk(f0);
  const t1 = mk(f1);

  const mat = new THREE.RawShaderMaterial({
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
    uniforms: { t0: { value: t0 }, t1: { value: t1 } },
    depthTest: false,
    depthWrite: false,
  });

  const scene = new THREE.Scene();
  const cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), mat);
  quad.frustumCulled = false;
  scene.add(quad);

  const target = createFFTTarget(N);
  renderer.setRenderTarget(target);
  renderer.render(scene, cam);
  renderer.setRenderTarget(null);

  const a0 = readAttachment(target, 0, N);
  const a1 = readAttachment(target, 1, N);

  assert(
    a0[0] === 1 && a0[1] === 2 && a0[2] === 3 && a0[3] === 4,
    `attachment 0 round-trip gave ${a0.slice(0, 4)}`,
  );
  assert(
    a1[0] === 5 && a1[1] === 6 && a1[2] === 7 && a1[3] === 8,
    `attachment 1 round-trip gave ${a1.slice(0, 4)}`,
  );
});

/** Same, but through the FFT: DC mode only, on attachment 1 lane rg. */
reg("MRT: attachment 1 survives the FFT independently", async () => {
  const { GpuFFT } = await import("../../js/ocean/gpuFFT.js");
  const N = 8;
  const f0 = new Float32Array(N * N * 4);
  const f1 = new Float32Array(N * N * 4);
  f1[0] = 2.5; // DC on attachment 1, lane rg

  const mk = (d) => {
    const t = new THREE.DataTexture(d, N, N, THREE.RGBAFormat, THREE.FloatType);
    t.minFilter = THREE.NearestFilter;
    t.magFilter = THREE.NearestFilter;
    t.colorSpace = THREE.NoColorSpace;
    t.needsUpdate = true;
    return t;
  };
  const mat = new THREE.RawShaderMaterial({
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
    uniforms: { t0: { value: mk(f0) }, t1: { value: mk(f1) } },
    depthTest: false,
    depthWrite: false,
  });
  const scene = new THREE.Scene();
  const cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), mat);
  quad.frustumCulled = false;
  scene.add(quad);

  const target = createFFTTarget(N);
  renderer.setRenderTarget(target);
  renderer.render(scene, cam);
  renderer.setRenderTarget(null);

  const fft = new GpuFFT(renderer, N);
  fft.inverse(target);

  const a1 = readAttachment(target, 1, N);
  let bad = -1;
  for (let i = 0; i < N * N; i++) {
    if (Math.abs(a1[i * 4] - 2.5) > 1e-3) { bad = i; break; }
  }
  assert(bad < 0, `attachment 1 texel ${bad} was ${a1[bad * 4]}, expected flat 2.5`);
});
