import * as THREE from "three";
import { buildButterflyData, log2int } from "./butterfly.js";

/**
 * Generic GPU radix-2 inverse FFT over a pair of MRT attachments.
 *
 * Knows nothing about oceans. Each render target carries two RGBA attachments;
 * `.rg` and `.ba` of each attachment are independent complex fields, so one
 * pass advances four complex fields at once.
 *
 * CONVENTION: this is the *unnormalised* inverse transform,
 *   x[n] = sum_k X[k] exp(+2*pi*i*k*n/N)
 * with no 1/N^2 factor. That is Tessendorf's convention, and it means physical
 * wave amplitudes fall out of the spectrum without a correction constant.
 *
 * Ping-pong buffers are RGBA32F rather than RGBA16F: an unnormalised transform
 * accumulates intermediates well past half-float's 65504 ceiling, where they
 * would silently clip to infinity.
 */

const vertexShader = /* glsl */ `
in vec3 position;
void main() {
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

const fragmentShader = /* glsl */ `
precision highp float;
precision highp sampler2D;

uniform sampler2D uSrc0;
uniform sampler2D uSrc1;
uniform sampler2D uButterfly;
uniform int uStage;
uniform int uVertical;

layout(location = 0) out vec4 outColor0;
layout(location = 1) out vec4 outColor1;

vec2 cmul(vec2 a, vec2 b) {
  return vec2(a.x * b.x - a.y * b.y, a.x * b.y + a.y * b.x);
}

void main() {
  ivec2 px = ivec2(gl_FragCoord.xy);
  // Transform along x, then along y. The butterfly index is whichever axis
  // this pass is working on.
  int idx = uVertical == 0 ? px.x : px.y;

  vec4 bf = texelFetch(uButterfly, ivec2(idx, uStage), 0);
  vec2 w = bf.xy;
  int topI = int(bf.z);
  int botI = int(bf.w);

  ivec2 topCoord = uVertical == 0 ? ivec2(topI, px.y) : ivec2(px.x, topI);
  ivec2 botCoord = uVertical == 0 ? ivec2(botI, px.y) : ivec2(px.x, botI);

  vec4 p0 = texelFetch(uSrc0, topCoord, 0);
  vec4 q0 = texelFetch(uSrc0, botCoord, 0);
  vec4 p1 = texelFetch(uSrc1, topCoord, 0);
  vec4 q1 = texelFetch(uSrc1, botCoord, 0);

  // Both wings share this expression; the sign lives in the twiddle.
  outColor0 = vec4(p0.rg + cmul(w, q0.rg), p0.ba + cmul(w, q0.ba));
  outColor1 = vec4(p1.rg + cmul(w, q1.rg), p1.ba + cmul(w, q1.ba));
}
`;

export function createFFTTarget(N) {
  return new THREE.WebGLRenderTarget(N, N, {
    count: 2,
    type: THREE.FloatType,
    format: THREE.RGBAFormat,
    minFilter: THREE.NearestFilter,
    magFilter: THREE.NearestFilter,
    wrapS: THREE.RepeatWrapping,
    wrapT: THREE.RepeatWrapping,
    depthBuffer: false,
    stencilBuffer: false,
    generateMipmaps: false,
  });
}

export class GpuFFT {
  constructor(renderer, N) {
    this.renderer = renderer;
    this.N = N;
    this.stages = log2int(N);

    const data = buildButterflyData(N);
    this.butterfly = new THREE.DataTexture(
      data,
      N,
      this.stages,
      THREE.RGBAFormat,
      THREE.FloatType,
    );
    this.butterfly.minFilter = THREE.NearestFilter;
    this.butterfly.magFilter = THREE.NearestFilter;
    this.butterfly.colorSpace = THREE.NoColorSpace;
    this.butterfly.needsUpdate = true;

    this.material = new THREE.RawShaderMaterial({
      name: "GpuFFT",
      glslVersion: THREE.GLSL3,
      vertexShader,
      fragmentShader,
      uniforms: {
        uSrc0: { value: null },
        uSrc1: { value: null },
        uButterfly: { value: this.butterfly },
        uStage: { value: 0 },
        uVertical: { value: 0 },
      },
      depthTest: false,
      depthWrite: false,
    });

    this.scene = new THREE.Scene();
    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.material);
    this.quad.frustumCulled = false;
    this.scene.add(this.quad);

    this.pingpong = createFFTTarget(N);
  }

  /**
   * Transforms `target` in place. 2*log2(N) passes is always even, so the
   * result lands back in `target` rather than in the scratch buffer.
   */
  inverse(target) {
    const r = this.renderer;
    const prevTarget = r.getRenderTarget();
    const u = this.material.uniforms;

    let src = target;
    let dst = this.pingpong;

    for (let direction = 0; direction < 2; direction++) {
      u.uVertical.value = direction;
      for (let stage = 0; stage < this.stages; stage++) {
        u.uStage.value = stage;
        u.uSrc0.value = src.textures[0];
        u.uSrc1.value = src.textures[1];
        r.setRenderTarget(dst);
        r.render(this.scene, this.camera);
        const swap = src;
        src = dst;
        dst = swap;
      }
    }

    r.setRenderTarget(prevTarget);
  }

  dispose() {
    this.butterfly.dispose();
    this.material.dispose();
    this.quad.geometry.dispose();
    this.pingpong.dispose();
  }
}
