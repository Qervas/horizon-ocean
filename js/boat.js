import * as THREE from "three";
import { sampleDetail } from "./gerstner.js";

/**
 * Multi-point buoyancy + torque, wave drift, quadratic drag, planing lift.
 * Mesh upgraded for higher visual fidelity against photo-grade water.
 */

const SAMPLE_POINTS = [
  { x: 0, z: -1.65, w: 1.15 },
  { x: 0, z: 1.55, w: 1.0 },
  { x: -0.58, z: 0.1, w: 0.88 },
  { x: 0.58, z: 0.1, w: 0.88 },
  { x: 0, z: 0, w: 1.0 },
  { x: -0.4, z: -0.7, w: 0.7 },
  { x: 0.4, z: -0.7, w: 0.7 },
];

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

    this.group = new THREE.Group();
    scene.add(this.group);
    this._buildMesh();
  }

  _buildMesh() {
    // Bright MeshStandard + slight emissive so cabin survives linear→ACES post
    const hull = new THREE.MeshStandardMaterial({
      color: 0xf7fafc,
      roughness: 0.4,
      metalness: 0.04,
      emissive: 0x1a2228,
      emissiveIntensity: 0.08,
    });
    const accent = new THREE.MeshStandardMaterial({
      color: 0x3a7a96,
      roughness: 0.48,
      metalness: 0.08,
      emissive: 0x0a2030,
      emissiveIntensity: 0.12,
    });
    const stripe = new THREE.MeshStandardMaterial({
      color: 0xe07040,
      roughness: 0.52,
      metalness: 0.04,
    });
    const glass = new THREE.MeshStandardMaterial({
      color: 0xc8e8f8,
      roughness: 0.15,
      metalness: 0.1,
      transparent: true,
      opacity: 0.65,
      emissive: 0x204050,
      emissiveIntensity: 0.15,
    });
    const chrome = new THREE.MeshStandardMaterial({
      color: 0xe8ecf0,
      roughness: 0.3,
      metalness: 0.45,
    });
    const dark = new THREE.MeshStandardMaterial({
      color: 0x4a5560,
      roughness: 0.6,
      metalness: 0.1,
      emissive: 0x101418,
      emissiveIntensity: 0.1,
    });

    // Hull body with slight taper via scaled boxes
    const body = new THREE.Mesh(new THREE.BoxGeometry(1.6, 0.48, 3.7), hull);
    body.position.set(0, 0.1, 0.12);
    body.castShadow = true;
    body.receiveShadow = true;
    this.group.add(body);

    // Lower hull / waterline stripe
    const keel = new THREE.Mesh(new THREE.BoxGeometry(1.45, 0.14, 3.5), accent);
    keel.position.set(0, -0.12, 0.1);
    keel.castShadow = true;
    this.group.add(keel);

    const waterline = new THREE.Mesh(new THREE.BoxGeometry(1.62, 0.06, 3.65), stripe);
    waterline.position.set(0, 0.02, 0.1);
    this.group.add(waterline);

    // Pointed bow
    const bow = new THREE.Mesh(new THREE.ConeGeometry(0.85, 1.65, 6), hull);
    bow.rotation.x = -Math.PI / 2;
    bow.position.set(0, 0.12, -1.95);
    bow.scale.set(0.92, 1.15, 0.72);
    bow.castShadow = true;
    this.group.add(bow);

    // Deck
    const deck = new THREE.Mesh(new THREE.BoxGeometry(1.42, 0.06, 2.95), accent);
    deck.position.set(0, 0.36, 0.22);
    deck.receiveShadow = true;
    this.group.add(deck);

    // Cabin
    const cabin = new THREE.Mesh(new THREE.BoxGeometry(1.12, 0.68, 1.3), accent);
    cabin.position.set(0, 0.74, 0.62);
    cabin.castShadow = true;
    this.group.add(cabin);

    // Cabin roof
    const roof = new THREE.Mesh(new THREE.BoxGeometry(1.18, 0.06, 1.36), dark);
    roof.position.set(0, 1.1, 0.62);
    this.group.add(roof);

    // Windshield
    const wind = new THREE.Mesh(new THREE.BoxGeometry(1.02, 0.42, 0.08), glass);
    wind.position.set(0, 0.84, -0.05);
    wind.rotation.x = -0.12;
    this.group.add(wind);

    // Side windows
    const sideL = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.32, 0.9), glass);
    sideL.position.set(-0.57, 0.78, 0.62);
    this.group.add(sideL);
    const sideR = sideL.clone();
    sideR.position.x = 0.57;
    this.group.add(sideR);

    // Outboard motor
    const motor = new THREE.Mesh(new THREE.BoxGeometry(0.38, 0.55, 0.34), dark);
    motor.position.set(0, 0.08, 2.12);
    motor.castShadow = true;
    this.group.add(motor);
    const prop = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.12, 0.06, 12), chrome);
    prop.rotation.x = Math.PI / 2;
    prop.position.set(0, -0.12, 2.28);
    this.group.add(prop);

    // Rails
    const railGeo = new THREE.CylinderGeometry(0.02, 0.02, 1.4, 6);
    for (const side of [-1, 1]) {
      const rail = new THREE.Mesh(railGeo, chrome);
      rail.rotation.z = Math.PI / 2;
      rail.position.set(side * 0.72, 0.55, -0.4);
      this.group.add(rail);
    }

    // Mast light
    const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.025, 0.55, 6), chrome);
    mast.position.set(0, 1.4, 0.5);
    this.group.add(mast);
    const light = new THREE.PointLight(0xd0e8ff, 0.7, 14, 2);
    light.position.set(0, 1.65, 0.5);
    this.group.add(light);
    const bulb = new THREE.Mesh(
      new THREE.SphereGeometry(0.05, 8, 8),
      new THREE.MeshStandardMaterial({ color: 0xffffee, emissive: 0xffffcc, emissiveIntensity: 0.8 }),
    );
    bulb.position.copy(light.position);
    this.group.add(bulb);
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
    for (const sp of SAMPLE_POINTS) {
      const wx = this.x + rx * sp.x + fx * sp.z;
      const wz = this.z + rz * sp.x + fz * sp.z;
      const fft = sea.sampleFFT(wx, wz);
      const det = sampleDetail(wx, wz, t, sea.detailScale);
      const y = fft.y * sea.fftScale + det.y;
      const dx = fft.dx * sea.fftScale * 0.35 + det.x;
      const dz = fft.dz * sea.fftScale * 0.35 + det.z;
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
    const targetPitch = Math.atan2(stern - bow, 3.2) * 0.85;
    const targetRoll = Math.atan2(star - port, 1.15) * 0.85;

    const waterline = 0.38;
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
