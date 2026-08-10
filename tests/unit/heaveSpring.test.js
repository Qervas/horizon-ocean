import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createHeaveState,
  stepHeave,
  resetHeave,
  HEAVE_DEFAULTS,
} from "../../js/boat/heaveSpring.js";

const DT = 1 / 120;

/** Runs the controller against a target function and reports tracking error. */
function track(targetFn, seconds, opts) {
  const s = createHeaveState();
  s.y = targetFn(0);
  let t = 0;
  let maxErr = 0;
  let sumSq = 0;
  let n = 0;
  // Discard the first second so the measurement is of steady state.
  while (t < seconds) {
    t += DT;
    const target = targetFn(t);
    stepHeave(s, target, DT, opts);
    if (t > 1.0) {
      const err = s.y - target;
      maxErr = Math.max(maxErr, Math.abs(err));
      sumSq += err * err;
      n++;
    }
  }
  return { state: s, maxErr, rms: Math.sqrt(sumSq / n) };
}

test("settles exactly on a constant target", () => {
  const r = track(() => 3.0, 4);
  assert.ok(Math.abs(r.state.y - 3.0) < 1e-3, `settled at ${r.state.y}`);
  assert.ok(Math.abs(r.state.vy) < 1e-2, `residual velocity ${r.state.vy}`);
});

test("tracks a linear ramp with no steady-state lag", () => {
  // This is the case the old controller failed: a target moving at constant
  // speed produced a permanent offset of targetSpeed * kDamp / kSpring.
  const speed = 0.7;
  const r = track((t) => speed * t, 6);
  assert.ok(r.maxErr < 0.05, `lag against a ${speed} m/s ramp was ${r.maxErr} m`);
});

test("the naive damper it replaces does show that lag", () => {
  // Guards the reason this module exists. If someone reverts to damping
  // absolute velocity, this documents what breaks.
  const kSpring = HEAVE_DEFAULTS.kSpring;
  const kDamp = HEAVE_DEFAULTS.kDamp;
  const speed = 0.7;
  let y = 0;
  let vy = 0;
  for (let t = 0; t < 6; t += DT) {
    const target = speed * t;
    const accel = (target - y) * kSpring - vy * kDamp; // the old, wrong form
    vy += accel * DT;
    y += vy * DT;
  }
  const lag = Math.abs(6 * speed - y);
  const predicted = (speed * kDamp) / kSpring;
  assert.ok(lag > 0.15, `expected a visible lag, got ${lag}`);
  assert.ok(
    Math.abs(lag - predicted) < 0.05,
    `lag ${lag} does not match the predicted ${predicted}`,
  );
});

test("tracks a swell closely", () => {
  // 7 s period, 0.8 m amplitude — the calm preset.
  const r = track((t) => 0.8 * Math.sin((2 * Math.PI * t) / 7), 20);
  assert.ok(r.rms < 0.05, `rms error on a 7 s swell was ${r.rms} m`);
  assert.ok(r.maxErr < 0.1, `peak error on a 7 s swell was ${r.maxErr} m`);
});

test("tracks short chop with acceptable attenuation", () => {
  // A 1.5 s wave is near the controller's bandwidth; some attenuation is
  // correct — a real hull does not follow every ripple.
  const r = track((t) => 0.3 * Math.sin((2 * Math.PI * t) / 1.5), 20);
  assert.ok(r.maxErr < 0.3, `peak error on 1.5 s chop was ${r.maxErr} m`);
});

test("survives a frame hitch without launching the hull", () => {
  // (target - prevTarget)/dt explodes when dt collapses; the speed clamp is
  // what stops that becoming a vertical takeoff.
  const s = createHeaveState();
  for (let i = 0; i < 60; i++) stepHeave(s, Math.sin(i * 0.1), DT);
  stepHeave(s, 5.0, 0.0001); // huge jump, tiny dt
  for (let i = 0; i < 240; i++) stepHeave(s, 0, DT);
  assert.ok(Number.isFinite(s.y), `y went non-finite: ${s.y}`);
  assert.ok(Math.abs(s.y) < 1.0, `hull did not recover, y=${s.y}`);
});

test("ignores non-positive dt", () => {
  const s = createHeaveState();
  s.y = 1;
  stepHeave(s, 5, 0);
  assert.equal(s.y, 1);
  stepHeave(s, 5, -1);
  assert.equal(s.y, 1);
});

test("stays finite under a violently discontinuous target", () => {
  const s = createHeaveState();
  for (let i = 0; i < 500; i++) {
    stepHeave(s, i % 2 === 0 ? 8 : -8, DT);
    assert.ok(Number.isFinite(s.y), `non-finite at step ${i}`);
  }
});

test("reset snaps to the surface and clears momentum", () => {
  const s = createHeaveState();
  for (let i = 0; i < 100; i++) stepHeave(s, 3, DT);
  resetHeave(s, 0);
  assert.equal(s.y, 0);
  assert.equal(s.vy, 0);
  assert.equal(s.prevTarget, null);
  assert.equal(s.targetVel, 0);
});

test("does not overshoot badly on a step input", () => {
  const s = createHeaveState();
  let peak = 0;
  for (let i = 0; i < 600; i++) {
    stepHeave(s, 1.0, DT);
    peak = Math.max(peak, s.y);
  }
  assert.ok(peak < 1.35, `overshoot to ${peak} — damping is too light`);
  assert.ok(Math.abs(s.y - 1.0) < 1e-3, `did not settle, y=${s.y}`);
});
