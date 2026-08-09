import * as THREE from "three";
import { rollingAverage } from "./probeMath.js";

/**
 * Async GPU buoyancy readback.
 *
 * The boat floats on the same displacement field the renderer draws, rather
 * than on a parallel CPU approximation that would drift out of agreement.
 *
 * A 16x16 RGBA32F target gives 256 probe slots (the boat uses 7). Readback is
 * 1 KB per frame, issued with readRenderTargetPixelsAsync and never awaited
 * inline, so results land 1-2 frames late. Probe positions are submitted
 * extrapolated forward by the *measured* latency, so they arrive already
 * correct for the present.
 *
 * The target is deliberately single-attachment: three r170's readback has no
 * textureIndex parameter and always returns attachment 0.
 *
 * KNOWN LIMIT: compensation covers the boat's own motion, not the wave field
 * evolving during the delay. At the ~2-frame latency real hardware delivers
 * (~33 ms, ~5 degrees of phase on a 7 s swell) that is invisible. Under
 * software rendering, where readback can take 450 ms or more, the boat visibly
 * rides where the water was half a second ago — so headless captures of the
 * boat misrepresent buoyancy even though the probe itself is correct.
 */

const PROBE_DIM = 16;
const MAX_IN_FLIGHT = 3;
/** Beyond this, assume the readback pipeline is wedged and stop queueing. */
const STALL_FRAMES = 4;

const probeVertexShader = /* glsl */ `
in vec3 position;
void main() {
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

const probeFragmentShader = /* glsl */ `
precision highp float;
precision highp sampler2D;

uniform sampler2D uPositions;
uniform sampler2D uDisp0;
uniform sampler2D uDisp1;
uniform sampler2D uDisp2;
uniform sampler2D uDisp3;
uniform float uPatch[4];

out vec4 outColor;

// ESSL 3.00 forbids indexing a sampler array with a loop counter, so the
// cascades are expanded explicitly here as they are in the water shader.
vec2 horizontalDisplacement(vec2 p) {
  vec2 d = vec2(0.0);
  d += texture(uDisp0, p / uPatch[0]).xz;
  d += texture(uDisp1, p / uPatch[1]).xz;
  d += texture(uDisp2, p / uPatch[2]).xz;
  d += texture(uDisp3, p / uPatch[3]).xz;
  return d;
}

void main() {
  ivec2 px = ivec2(gl_FragCoord.xy);
  vec2 target = texelFetch(uPositions, px, 0).xy;

  // Displacement is a forward map. Invert it so we get the height *at* this
  // world XZ, not the height of the grid point that happens to land near it.
  vec2 p = target;
  for (int i = 0; i < 3; i++) {
    p = target - horizontalDisplacement(p);
  }

  float y = 0.0;
  vec2 dxz = vec2(0.0);
  float foam = 0.0;

  #define PROBE_CASCADE(SAMPLER, IDX)         \\
    {                                         \\
      vec4 s = texture(SAMPLER, p / uPatch[IDX]); \\
      y += s.y;                               \\
      dxz += s.xz;                            \\
      foam = max(foam, s.w);                  \\
    }

  PROBE_CASCADE(uDisp0, 0)
  PROBE_CASCADE(uDisp1, 1)
  PROBE_CASCADE(uDisp2, 2)
  PROBE_CASCADE(uDisp3, 3)

  outColor = vec4(y, dxz.x, dxz.y, foam);
}
`;

export class OceanProbe {
  constructor(renderer, sim) {
    this.renderer = renderer;
    this.sim = sim;
    this.slots = PROBE_DIM * PROBE_DIM;

    this.positionData = new Float32Array(this.slots * 4);
    this.positionTex = new THREE.DataTexture(
      this.positionData,
      PROBE_DIM,
      PROBE_DIM,
      THREE.RGBAFormat,
      THREE.FloatType,
    );
    this.positionTex.minFilter = THREE.NearestFilter;
    this.positionTex.magFilter = THREE.NearestFilter;
    this.positionTex.colorSpace = THREE.NoColorSpace;
    this.positionTex.needsUpdate = true;

    this.target = new THREE.WebGLRenderTarget(PROBE_DIM, PROBE_DIM, {
      type: THREE.FloatType,
      format: THREE.RGBAFormat,
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
      depthBuffer: false,
      stencilBuffer: false,
      generateMipmaps: false,
    });

    this.material = new THREE.RawShaderMaterial({
      name: "OceanProbe",
      glslVersion: THREE.GLSL3,
      vertexShader: probeVertexShader,
      fragmentShader: probeFragmentShader,
      uniforms: {
        uPositions: { value: this.positionTex },
        uDisp0: { value: null },
        uDisp1: { value: null },
        uDisp2: { value: null },
        uDisp3: { value: null },
        uPatch: {
          value: [0, 1, 2, 3].map(
            (c) => sim.cascades[Math.min(c, sim.cascades.length - 1)].patch,
          ),
        },
      },
      depthTest: false,
      depthWrite: false,
    });

    this.scene = new THREE.Scene();
    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.material);
    this.quad.frustumCulled = false;
    this.scene.add(this.quad);

    this.buffers = Array.from({ length: MAX_IN_FLIGHT }, () => new Float32Array(this.slots * 4));
    this.bufferBusy = new Array(MAX_IN_FLIGHT).fill(false);

    /** Last successfully read result. Held on stall so the boat never freezes. */
    this.results = new Float32Array(this.slots * 4);
    this.pending = new Float32Array(this.slots * 2);
    this.pendingCount = 0;
    this.ready = false;
    this.inFlight = 0;
    this.framesSinceResult = 0;
    this.latency = 1 / 30;
    this.stalled = false;
  }

  /**
   * The buoyancy interface `boat.js` consumes, shared with the CPU fallback.
   *
   * Records where slot `index` should be probed *next* frame and returns the
   * most recent result for it. The one-frame offset is inherent to async
   * readback; `extrapolate()` at the call site is what keeps it from lagging.
   */
  sampleAt(index, x, z) {
    if (index < this.slots) {
      this.pending[index * 2] = x;
      this.pending[index * 2 + 1] = z;
      this.pendingCount = Math.max(this.pendingCount, index + 1);
    }
    return this.sample(index);
  }

  /** Uploads whatever sampleAt() collected this frame. */
  commitPositions() {
    if (this.pendingCount > 0) this.setPositions(this.pending.subarray(0, this.pendingCount * 2));
  }

  /** Writes probe world positions. `positions` is a flat [x0,z0,x1,z1,...]. */
  setPositions(positions) {
    const n = Math.min(positions.length / 2, this.slots);
    for (let i = 0; i < n; i++) {
      this.positionData[i * 4] = positions[i * 2];
      this.positionData[i * 4 + 1] = positions[i * 2 + 1];
    }
    this.positionTex.needsUpdate = true;
  }

  /** Renders the probe pass and issues a non-blocking readback. */
  submit() {
    const r = this.renderer;
    const u = this.material.uniforms;
    const last = this.sim.cascades.length - 1;
    u.uDisp0.value = this.sim.displacementTexture(Math.min(0, last));
    u.uDisp1.value = this.sim.displacementTexture(Math.min(1, last));
    u.uDisp2.value = this.sim.displacementTexture(Math.min(2, last));
    u.uDisp3.value = this.sim.displacementTexture(Math.min(3, last));

    const prev = r.getRenderTarget();
    r.setRenderTarget(this.target);
    r.render(this.scene, this.camera);
    r.setRenderTarget(prev);

    this.framesSinceResult++;
    this.stalled = this.framesSinceResult > STALL_FRAMES;

    if (this.inFlight >= MAX_IN_FLIGHT) return;
    const slot = this.bufferBusy.indexOf(false);
    if (slot < 0) return;

    this.bufferBusy[slot] = true;
    this.inFlight++;
    const issued = performance.now();

    r.readRenderTargetPixelsAsync(this.target, 0, 0, PROBE_DIM, PROBE_DIM, this.buffers[slot])
      .then((data) => {
        this.results.set(data);
        this.ready = true;
        this.framesSinceResult = 0;
        this.stalled = false;
        this.latency = rollingAverage(this.latency, (performance.now() - issued) / 1000, 0.15);
      })
      .catch(() => {
        // Drop this sample. Holding the previous result is strictly better than
        // snapping the boat to a flat sea.
      })
      .finally(() => {
        this.bufferBusy[slot] = false;
        this.inFlight--;
      });
  }

  /**
   * Latest known surface state at probe `index`.
   * Before the first readback lands this reports a flat sea, which reads as the
   * boat sitting at its waterline for a frame or two rather than falling.
   */
  sample(index) {
    const o = index * 4;
    return {
      y: this.results[o],
      dx: this.results[o + 1],
      dz: this.results[o + 2],
      foam: this.results[o + 3],
    };
  }

  dispose() {
    this.material.dispose();
    this.quad.geometry.dispose();
    this.target.dispose();
    this.positionTex.dispose();
  }
}

export { PROBE_DIM };
