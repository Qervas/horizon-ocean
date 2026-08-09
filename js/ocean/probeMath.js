/**
 * Pure math behind the GPU buoyancy probe.
 *
 * Imports nothing, so `node:test` can exercise it directly. The GLSL in
 * oceanProbe.js mirrors invertDisplacement exactly.
 */

/**
 * Inverts the horizontal displacement map.
 *
 * FFT displacement is a *forward* map: it says where a grid point moves to,
 * not what the surface height is at a given world XZ. Sampling it directly is
 * the classic wrong-buoyancy bug — the boat rides beside crests instead of on
 * them once chop is significant.
 *
 * Solves p + D(p) = target by fixed-point iteration p <- target - D(p). This
 * converges whenever |dD/dp| < 1, which is the same condition the waves must
 * satisfy to avoid self-intersecting.
 *
 * @param {[number, number]} target world XZ to find the surface at
 * @param {(x: number, z: number) => [number, number]} displacement
 * @param {number} iterations
 * @returns {[number, number]} the grid position that lands on `target`
 */
export function invertDisplacement(target, displacement, iterations = 3) {
  let x = target[0];
  let z = target[1];
  for (let i = 0; i < iterations; i++) {
    const [dx, dz] = displacement(x, z);
    x = target[0] - dx;
    z = target[1] - dz;
  }
  return [x, z];
}

/**
 * Advances a position by a velocity over a latency window.
 *
 * Probe positions are submitted extrapolated forward by the measured readback
 * latency, so results arrive already correct for the present rather than
 * describing where the boat used to be.
 */
export function extrapolate(position, velocity, latencySeconds) {
  return [
    position[0] + velocity[0] * latencySeconds,
    position[1] + velocity[1] * latencySeconds,
  ];
}

/**
 * Exponential rolling average that rejects non-finite samples, so a failed or
 * rejected readback cannot poison the latency estimate.
 */
export function rollingAverage(current, sample, alpha) {
  if (!Number.isFinite(sample)) return current;
  return current + (sample - current) * alpha;
}
