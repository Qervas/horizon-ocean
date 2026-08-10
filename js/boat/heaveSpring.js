/**
 * Heave (vertical) tracking for a floating hull.
 *
 * Pure — imports nothing — so node:test can exercise the control law directly.
 *
 * THE BUG THIS EXISTS TO FIX
 *
 * The obvious spring-damper,
 *
 *     a = (target - y) * kSpring - v * kDamp
 *
 * damps toward *zero* velocity, which means it resists the wave lifting the
 * hull. Against a target that is itself moving it settles at a lag of roughly
 *
 *     lag = targetVelocity * kDamp / kSpring
 *
 * With kSpring 18, kDamp 7 and a swell surface moving ~0.7 m/s that is a ~0.3 m
 * permanent sink — which reads as a boat riding low, not as a boat lagging,
 * because the offset only varies as the wave's speed varies.
 *
 * The fix is to damp the velocity ERROR rather than the velocity:
 *
 *     a = (target - y) * kSpring + (targetVelocity - v) * kDamp
 *
 * That is a PD controller on both position and velocity, and it tracks a moving
 * target with no steady-state lag.
 */

export const HEAVE_DEFAULTS = {
  /** Position gain. Higher is stiffer and follows short waves more closely. */
  kSpring: 22,
  /** Velocity-error gain. Near-critical for kSpring: 2*sqrt(kSpring). */
  kDamp: 9,
  /**
   * Ceiling on the inferred surface velocity, m/s. A frame hitch makes
   * (target - prevTarget)/dt enormous; without this the hull is launched.
   */
  maxTargetSpeed: 12,
  /** Smoothing on the inferred surface velocity, to reject per-frame noise. */
  velocitySmoothing: 0.35,
};

export function createHeaveState() {
  return { y: 0, vy: 0, prevTarget: null, targetVel: 0 };
}

/**
 * Advances one step.
 *
 * @param {object} state from createHeaveState(); mutated in place
 * @param {number} target surface height the hull should sit at
 * @param {number} dt seconds
 * @param {object} [opts] gain overrides
 * @returns {object} the same state
 */
export function stepHeave(state, target, dt, opts = {}) {
  const { kSpring, kDamp, maxTargetSpeed, velocitySmoothing } = { ...HEAVE_DEFAULTS, ...opts };
  if (!(dt > 0)) return state;

  // Infer how fast the surface itself is moving, so the damper can follow it
  // instead of fighting it.
  if (state.prevTarget === null) {
    state.targetVel = 0;
  } else {
    const raw = (target - state.prevTarget) / dt;
    const clamped = Math.max(-maxTargetSpeed, Math.min(maxTargetSpeed, raw));
    state.targetVel += (clamped - state.targetVel) * velocitySmoothing;
  }
  state.prevTarget = target;

  const accel = (target - state.y) * kSpring + (state.targetVel - state.vy) * kDamp;
  state.vy += accel * dt;
  state.y += state.vy * dt;
  return state;
}

/** Snaps the hull to the surface, for teleports and scene resets. */
export function resetHeave(state, y) {
  state.y = y;
  state.vy = 0;
  state.prevTarget = null;
  state.targetVel = 0;
  return state;
}
