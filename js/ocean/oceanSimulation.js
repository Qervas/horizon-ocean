import * as THREE from "three";
import { GpuFFT, createFFTTarget } from "./gpuFFT.js";
import { buildInitialSpectrum, CASCADES, FFT_N, LOOP_PERIOD } from "./spectrum.js";
import { evolveVertexShader, evolveFragmentShader } from "./shaders/evolve.js";
import { assembleVertexShader, assembleFragmentShader } from "./shaders/assemble.js";

/**
 * Four-cascade GPU ocean simulation.
 *
 * Per cascade per frame: 1 evolve draw, 16 FFT draws, 1 assemble draw.
 * 72 fullscreen draws at 256^2 in total — roughly a quarter of one 1080p
 * frame's fill.
 *
 * Outputs, per cascade:
 *   displacementTexture(c) — RGBA16F (Dx, Dy, Dz, foam)
 *   derivativesTexture(c)  — RGBA16F (sx, sz, sx^2, sz^2)
 *
 * The output targets ping-pong because foam reads its own previous value, and
 * WebGL cannot sample a texture it is writing.
 */

const DEFAULTS = {
  windSpeed: 11,
  windDir: [0.85, 0.53],
  fetch: 100000,
  depth: 1000,
  seed: 0x0ce4a,
  choppiness: 1.1,
  foamThreshold: 0.6,
  foamGain: 1.4,
  foamDecayRate: 0.35,
  amplitude: 1,
};

function makeOutputTarget(N) {
  const rt = new THREE.WebGLRenderTarget(N, N, {
    count: 2,
    type: THREE.HalfFloatType,
    format: THREE.RGBAFormat,
    minFilter: THREE.LinearMipmapLinearFilter,
    magFilter: THREE.LinearFilter,
    wrapS: THREE.RepeatWrapping,
    wrapT: THREE.RepeatWrapping,
    depthBuffer: false,
    stencilBuffer: false,
    generateMipmaps: true,
  });
  // Slope-variance roughness reads these through the mip chain, so mips are
  // required rather than an optimisation.
  for (const t of rt.textures) {
    t.generateMipmaps = true;
    t.minFilter = THREE.LinearMipmapLinearFilter;
    t.magFilter = THREE.LinearFilter;
    t.wrapS = THREE.RepeatWrapping;
    t.wrapT = THREE.RepeatWrapping;
    t.colorSpace = THREE.NoColorSpace;
  }
  return rt;
}

export class OceanSimulation {
  constructor(renderer, options = {}) {
    const opts = { ...DEFAULTS, ...options };
    this.renderer = renderer;
    this.N = opts.N ?? FFT_N;
    this.opts = opts;
    this.cascades = (opts.cascades ?? CASCADES).map((c) => ({ ...c }));
    this.time = 0;

    this.fft = new GpuFFT(renderer, this.N);

    this.scene = new THREE.Scene();
    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), null);
    this.quad.frustumCulled = false;
    this.scene.add(this.quad);

    this.evolveMaterial = new THREE.RawShaderMaterial({
      name: "OceanEvolve",
      glslVersion: THREE.GLSL3,
      vertexShader: evolveVertexShader,
      fragmentShader: evolveFragmentShader,
      uniforms: {
        uH0: { value: null },
        uTime: { value: 0 },
        uPatch: { value: 1 },
        uN: { value: this.N },
        uDepth: { value: opts.depth },
        uChoppiness: { value: opts.choppiness },
        uOmega0: { value: (2 * Math.PI) / LOOP_PERIOD },
      },
      depthTest: false,
      depthWrite: false,
    });

    this.assembleMaterial = new THREE.RawShaderMaterial({
      name: "OceanAssemble",
      glslVersion: THREE.GLSL3,
      vertexShader: assembleVertexShader,
      fragmentShader: assembleFragmentShader,
      uniforms: {
        uFFT0: { value: null },
        uFFT1: { value: null },
        uPrev: { value: null },
        uFoamDecay: { value: 1 },
        uFoamThreshold: { value: opts.foamThreshold },
        uFoamGain: { value: opts.foamGain },
        uHasPrev: { value: 0 },
      },
      depthTest: false,
      depthWrite: false,
    });

    this.fftTargets = [];
    this.outputs = [];
    this.h0 = [];
    this.current = 0;
    this.warm = false;

    for (let c = 0; c < this.cascades.length; c++) {
      this.fftTargets.push(createFFTTarget(this.N));
      this.outputs.push([makeOutputTarget(this.N), makeOutputTarget(this.N)]);
      this.h0.push(null);
    }
    this._buildSpectra();
  }

  _buildSpectra() {
    const o = this.opts;
    for (let c = 0; c < this.cascades.length; c++) {
      const cas = this.cascades[c];
      const data = buildInitialSpectrum({
        N: this.N,
        patch: cas.patch,
        kLow: cas.kLow,
        kHigh: cas.kHigh,
        windSpeed: o.windSpeed,
        windDir: o.windDir,
        fetch: o.fetch,
        depth: o.depth,
        // Per-cascade seed offset: identical noise across cascades would
        // correlate the bands and produce visible structure.
        seed: o.seed + c * 7919,
      });
      if (o.amplitude !== 1) {
        for (let i = 0; i < data.length; i++) data[i] *= o.amplitude;
      }
      if (this.h0[c]) this.h0[c].dispose();
      const tex = new THREE.DataTexture(data, this.N, this.N, THREE.RGBAFormat, THREE.FloatType);
      tex.minFilter = THREE.NearestFilter;
      tex.magFilter = THREE.NearestFilter;
      tex.colorSpace = THREE.NoColorSpace;
      tex.needsUpdate = true;
      this.h0[c] = tex;
    }
  }

  /** Rebuilds the spectrum. Costs a few ms — call on sea-state change only. */
  setSeaState({ windSpeed, choppiness, amplitude }) {
    if (windSpeed !== undefined) this.opts.windSpeed = windSpeed;
    if (amplitude !== undefined) this.opts.amplitude = amplitude;
    if (choppiness !== undefined) {
      this.opts.choppiness = choppiness;
      this.evolveMaterial.uniforms.uChoppiness.value = choppiness;
    }
    this._buildSpectra();
    this.warm = false;
  }

  displacementTexture(c) {
    return this.outputs[c][this.current].textures[0];
  }

  derivativesTexture(c) {
    return this.outputs[c][this.current].textures[1];
  }

  update(time, dt = 1 / 60) {
    const r = this.renderer;
    const prevTarget = r.getRenderTarget();
    this.time = time;

    const next = 1 - this.current;
    const decay = Math.exp(-dt * this.opts.foamDecayRate);

    for (let c = 0; c < this.cascades.length; c++) {
      const cas = this.cascades[c];

      // 1. evolve
      this.quad.material = this.evolveMaterial;
      const eu = this.evolveMaterial.uniforms;
      eu.uH0.value = this.h0[c];
      eu.uTime.value = time;
      eu.uPatch.value = cas.patch;
      r.setRenderTarget(this.fftTargets[c]);
      r.render(this.scene, this.camera);

      // 2. inverse FFT (16 passes, result back in fftTargets[c])
      this.fft.inverse(this.fftTargets[c]);

      // 3. assemble into the ping-pong output
      this.quad.material = this.assembleMaterial;
      const au = this.assembleMaterial.uniforms;
      au.uFFT0.value = this.fftTargets[c].textures[0];
      au.uFFT1.value = this.fftTargets[c].textures[1];
      au.uPrev.value = this.outputs[c][this.current].textures[0];
      au.uFoamDecay.value = decay;
      au.uHasPrev.value = this.warm ? 1 : 0;
      r.setRenderTarget(this.outputs[c][next]);
      r.render(this.scene, this.camera);
    }

    this.current = next;
    this.warm = true;
    r.setRenderTarget(prevTarget);
  }

  dispose() {
    this.fft.dispose();
    this.evolveMaterial.dispose();
    this.assembleMaterial.dispose();
    this.quad.geometry.dispose();
    for (const t of this.fftTargets) t.dispose();
    for (const pair of this.outputs) for (const t of pair) t.dispose();
    for (const t of this.h0) if (t) t.dispose();
  }
}
