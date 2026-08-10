import { CpuMirror } from "./cpuMirror.js";

/**
 * Buoyancy source with a latency floor.
 *
 * The GPU probe reads back the exact surface being drawn, but at whatever
 * latency the device happens to deliver — measured at 2 s under software
 * rendering, which puts a boat a quarter-cycle out of phase with its own wake.
 * Nothing in the async path bounds that, so it degrades silently on slow
 * hardware.
 *
 * WHY THE PROBE STAYS PRIMARY EVEN WHEN IT IS SLOW
 *
 * The obvious fix — swap to the CPU mirror when latency is bad — was built,
 * measured, and rejected. The spectrum's noise is drawn per grid cell, so the
 * mirror only reproduces the drawn sea's PHASES if it runs at the same
 * resolution and patch size as the GPU cascades: a 256^2 CPU FFT per cascade
 * per frame, which is the cost the GPU path exists to avoid. At the resolution
 * the CPU can afford, the mirror is a statistically identical but physically
 * DIFFERENT sea.
 *
 * A boat riding a different sea is worse than a boat riding the real sea a
 * little late: it sinks through crests that are drawn around it. Measured, the
 * mirror put the hull fully underwater while the probe merely lagged.
 *
 * So the probe is the only source that can agree with what is drawn, and it
 * stays primary. The mirror is a cold-start and hard-stall guard only — used
 * when there is no probe result at all, where any plausible surface beats
 * leaving the boat at zero.
 *
 * On real hardware readback is ~2 frames and none of this is visible. Slow
 * software rendering is the only case that degrades, and it degrades to "late"
 * rather than "wrong".
 *
 * Implements the interface boat.js consumes, so the boat never learns which
 * source it is riding.
 */

/**
 * Latency thresholds are retained for reporting only — see the note above on
 * why they no longer drive the choice of source.
 */
const LATENCY_DEGRADE_S = 0.12;
const LATENCY_RECOVER_S = 0.06;

export class HybridSea {
  constructor(probe, mirrorOptions = {}) {
    this.probe = probe;
    this.mirror = new CpuMirror(mirrorOptions);
    this.useProbe = false;
    this.time = 0;
    /** Exposed for diagnostics and the HUD. */
    this.source = "mirror";
  }

  setSeaState(state) {
    this.mirror.setSeaState(state);
  }

  update(time) {
    this.time = time;
    this.mirror.update(time);

    // Latency deliberately does NOT switch sources. Only the total absence of a
    // probe result does.
    const p = this.probe;
    this.useProbe = Boolean(p && p.ready);
    this.source = this.useProbe ? "probe" : "mirror";
  }

  /** Matches OceanProbe#sampleAt. */
  sampleAt(index, x, z) {
    // Always feed the probe its positions, so it stays warm and its latency
    // estimate stays current even while the mirror is driving the boat.
    const fromProbe = this.probe ? this.probe.sampleAt(index, x, z) : null;
    if (this.useProbe && fromProbe) return fromProbe;
    return this.mirror.sample(x, z);
  }

  /** Ground truth for measuring how far behind the probe is running. */
  trueSample(x, z) {
    return this.mirror.sample(x, z);
  }

  commitPositions() {
    if (this.probe) this.probe.commitPositions();
  }

  submit() {
    if (this.probe) this.probe.submit();
  }

  get latency() {
    return this.probe ? this.probe.latency : 0;
  }

  get ready() {
    return true;
  }
}

export { LATENCY_DEGRADE_S, LATENCY_RECOVER_S };
