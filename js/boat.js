import * as THREE from "three";
import { buildBoatMesh, HULL_LENGTH } from "./boat/boatMesh.js";

/**
 * Multi-point buoyancy + torque, wave drift, quadratic drag, planing lift.
 *
 * Sample points span the 6.2 m lofted hull. Indices are stable and are used as
 * GPU probe slots, so the order here must not change without updating nothing
 * else — the probe allocates by index.
 */

const BOW_Z = -HULL_LENGTH / 2 + 0.5;
const STERN_Z = HULL_LENGTH / 2 - 0.4;

const SAMPLE_POINTS = [
  { x: 0, z: BOW_Z, w: 1.15 },
  { x: 0, z: STERN_Z, w: 1.0 },
  { x: -0.92, z: 0.15, w: 0.88 },
  { x: 0.92, z: 0.15, w: 0.88 },
  { x: 0, z: 0, w: 1.0 },
  { x: -0.68, z: -1.3, w: 0.7 },
  { x: 0.68, z: -1.3, w: 0.7 },
];

/** Longitudinal and transverse spans, for turning height differences into trim. */
const PITCH_SPAN = STERN_Z - BOW_Z;
const ROLL_SPAN = 1.84;

export class Boat {
  constructor(scene) {
    this.x = 0;
    this.y = 1;
    this.z = 0;
    this.yaw = 0;
    this.pitch = 0;
    this.roll = 0;
    this.speed = 0;
    this.vy = 0;
    this.vpitch = 0;
    this.vroll = 0;

    this.group = buildBoatMesh(THREE);
    scene.add(this.group);
  }

  update(sea, t, input, active, dt) {
    dt = Math.min(dt, 0.05);
    const fx = -Math.sin(this.yaw);
    const fz = -Math.cos(this.yaw);
    const rx = Math.cos(this.yaw);
    const rz = -Math.sin(this.yaw);

    if (active) {
      const maxSpeed = 28;
      const accel = 16;
      const reverseAccel = 10;
      // Quadratic water drag — ALWAYS opposes velocity (never multiplies by sign again)
      // Bug was: dragForce * Math.sign(speed) flipped reverse drag into reverse thrust,
      // so after one S press you locked at max reverse and W couldn't overcome it.
      const drag = 0.045;
      if (input.throttle > 0) this.speed += input.throttle * accel * dt;
      else if (input.throttle < 0) this.speed += input.throttle * reverseAccel * dt;
      else {
        // Coast: light linear damping so you can stop without holding reverse
        this.speed *= Math.exp(-0.8 * dt);
      }
      // F_drag = -c * v * |v|  →  Δv = -c * v * |v| * k * dt
      this.speed -= drag * this.speed * Math.abs(this.speed) * dt * 18;
      // Snap tiny residual to zero so direction flips cleanly
      if (Math.abs(this.speed) < 0.02 && input.throttle === 0) this.speed = 0;
      this.speed = THREE.MathUtils.clamp(this.speed, -maxSpeed * 0.4, maxSpeed);

      const speedFactor = THREE.MathUtils.clamp(Math.abs(this.speed) / maxSpeed, 0.15, 1);
      // Steer always relative to throttle intent when nearly stopped
      const reverse =
        Math.abs(this.speed) < 0.5
          ? input.throttle < 0
            ? -1
            : 1
          : this.speed >= 0
            ? 1
            : -1;
      this.yaw += input.steer * 1.4 * speedFactor * reverse * dt;
    } else {
      this.speed *= Math.exp(-1.5 * dt);
      if (Math.abs(this.speed) < 0.02) this.speed = 0;
    }

    this.x += fx * this.speed * dt;
    this.z += fz * this.speed * dt;

    let sumY = 0;
    let sumW = 0;
    let sumDx = 0;
    let sumDz = 0;
    const heights = [];
    for (let i = 0; i < SAMPLE_POINTS.length; i++) {
      const sp = SAMPLE_POINTS[i];
      const wx = this.x + rx * sp.x + fx * sp.z;
      const wz = this.z + rz * sp.x + fz * sp.z;
      // One interface, two implementations: the GPU probe reads back the same
      // displacement field the renderer draws, the CPU fallback evaluates its
      // own FFT. Neither detail belongs here.
      const s = sea.sampleAt(i, wx, wz);
      const y = s.y;
      const dx = s.dx;
      const dz = s.dz;
      heights.push({ y, dx, dz, w: sp.w, lx: sp.x, lz: sp.z });
      sumY += y * sp.w;
      sumW += sp.w;
      sumDx += dx * sp.w;
      sumDz += dz * sp.w;
    }
    const meanY = sumY / sumW;
    const meanDx = sumDx / sumW;
    const meanDz = sumDz / sumW;

    this.x += meanDx * 0.15 * dt;
    this.z += meanDz * 0.15 * dt;

    const bow = heights[0].y;
    const stern = heights[1].y;
    const port = heights[2].y;
    const star = heights[3].y;
    const targetPitch = Math.atan2(stern - bow, PITCH_SPAN) * 0.85;
    const targetRoll = Math.atan2(star - port, ROLL_SPAN) * 0.85;

    const waterline = -0.03;
    const targetY = meanY + waterline + Math.abs(this.speed) * 0.012;
    const kSpring = 18;
    const kDamp = 7;
    const ay = (targetY - this.y) * kSpring - this.vy * kDamp;
    this.vy += ay * dt;
    this.y += this.vy * dt;

    const kAng = 12;
    const kAngD = 5;
    this.vpitch += ((targetPitch - this.pitch) * kAng - this.vpitch * kAngD) * dt;
    this.vroll += ((targetRoll - this.roll) * kAng - this.vroll * kAngD) * dt;
    if (active) this.vroll += -input.steer * 0.8 * Math.min(1, Math.abs(this.speed) / 20) * dt;
    this.pitch += this.vpitch * dt;
    this.roll += this.vroll * dt;
    this.pitch = THREE.MathUtils.clamp(this.pitch, -0.55, 0.55);
    this.roll = THREE.MathUtils.clamp(this.roll, -0.55, 0.55);

    this.group.position.set(this.x, this.y, this.z);
    this.group.rotation.order = "YXZ";
    this.group.rotation.y = this.yaw;
    this.group.rotation.x = this.pitch;
    this.group.rotation.z = this.roll;

    return {
      foam: Math.min(1, Math.abs(this.speed) / 18),
      x: this.x,
      z: this.z,
      yaw: this.yaw,
    };
  }
}
