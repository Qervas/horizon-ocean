import { FFTOcean } from "./cpuOcean.js";
import { sampleDetail } from "./cpuGerstner.js";

/**
 * Adapts the CPU ocean to the same buoyancy interface the GPU probe exposes,
 * so `boat.js` never learns which tier it is running on.
 */
export class CpuSeaAdapter {
  constructor(fft) {
    this.fft = fft;
    this.detailScale = 1;
    this.fftScale = 1;
    this.time = 0;
    this.latency = 0;
    this.ready = true;
  }

  setTime(t) {
    this.time = t;
  }

  /** Matches OceanProbe#sampleAt. The index is unused — the CPU path is exact. */
  sampleAt(index, x, z) {
    const s = this.fft.sample(x, z);
    const d = sampleDetail(x, z, this.time, this.detailScale);
    return {
      y: s.y * this.fftScale + d.y,
      dx: s.dx * this.fftScale * 0.35 + d.x,
      dz: s.dz * this.fftScale * 0.35 + d.z,
      foam: Math.max(0, 1 - s.jacobian),
    };
  }

  commitPositions() {}
  submit() {}
}

export { FFTOcean };
