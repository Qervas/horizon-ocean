import * as THREE from "three";

/**
 * Free-fly camera for inspecting the sim.
 *
 * WASD to move, Q/E down/up, Shift to boost, mouse to look. Click the canvas to
 * capture the pointer; Escape or F releases it.
 *
 * Deliberately unclamped: unlike the chase camera it may go below the surface,
 * because looking up at the underside of the waves is one of the things a free
 * camera is for.
 */

const MIN_PITCH = -Math.PI / 2 + 0.02;
const MAX_PITCH = Math.PI / 2 - 0.02;

export class FreeCamera {
  constructor(camera, domElement, options = {}) {
    this.camera = camera;
    this.dom = domElement;
    this.enabled = false;

    this.speed = options.speed ?? 14;
    this.boost = options.boost ?? 5;
    this.lookSensitivity = options.lookSensitivity ?? 0.0022;
    /** Higher is snappier; movement is smoothed so captures are not jittery. */
    this.damping = options.damping ?? 12;

    this.yaw = 0;
    this.pitch = 0;
    this.velocity = new THREE.Vector3();

    this._onMouseMove = this._onMouseMove.bind(this);
    this._onPointerLockChange = this._onPointerLockChange.bind(this);
    this._onClick = this._onClick.bind(this);

    document.addEventListener("pointerlockchange", this._onPointerLockChange);
  }

  /** Adopts the camera's current orientation so enabling never snaps the view. */
  enable() {
    if (this.enabled) return;
    this.enabled = true;
    const e = new THREE.Euler().setFromQuaternion(this.camera.quaternion, "YXZ");
    this.yaw = e.y;
    this.pitch = e.x;
    this.velocity.set(0, 0, 0);
    this.dom.addEventListener("click", this._onClick);
    document.addEventListener("mousemove", this._onMouseMove);
  }

  disable() {
    if (!this.enabled) return;
    this.enabled = false;
    this.dom.removeEventListener("click", this._onClick);
    document.removeEventListener("mousemove", this._onMouseMove);
    if (document.pointerLockElement === this.dom) document.exitPointerLock();
  }

  toggle() {
    if (this.enabled) this.disable();
    else this.enable();
    return this.enabled;
  }

  _onClick() {
    if (this.enabled && document.pointerLockElement !== this.dom) {
      this.dom.requestPointerLock();
    }
  }

  _onPointerLockChange() {
    this.pointerLocked = document.pointerLockElement === this.dom;
  }

  _onMouseMove(e) {
    if (!this.enabled || document.pointerLockElement !== this.dom) return;
    this.yaw -= e.movementX * this.lookSensitivity;
    this.pitch -= e.movementY * this.lookSensitivity;
    this.pitch = Math.min(MAX_PITCH, Math.max(MIN_PITCH, this.pitch));
  }

  /** @param {Set<string>} keys currently-held KeyboardEvent.code values */
  update(dt, keys) {
    if (!this.enabled) return;

    const forward = new THREE.Vector3(
      -Math.sin(this.yaw) * Math.cos(this.pitch),
      Math.sin(this.pitch),
      -Math.cos(this.yaw) * Math.cos(this.pitch),
    );
    const right = new THREE.Vector3(Math.cos(this.yaw), 0, -Math.sin(this.yaw));

    const wish = new THREE.Vector3();
    if (keys.has("KeyW")) wish.add(forward);
    if (keys.has("KeyS")) wish.sub(forward);
    if (keys.has("KeyD")) wish.add(right);
    if (keys.has("KeyA")) wish.sub(right);
    if (keys.has("KeyE") || keys.has("Space")) wish.y += 1;
    if (keys.has("KeyQ")) wish.y -= 1;
    if (wish.lengthSq() > 0) wish.normalize();

    const speed = this.speed * (keys.has("ShiftLeft") || keys.has("ShiftRight") ? this.boost : 1);
    const target = wish.multiplyScalar(speed);
    const a = 1 - Math.exp(-this.damping * dt);
    this.velocity.lerp(target, a);

    this.camera.position.addScaledVector(this.velocity, dt);
    this.camera.quaternion.setFromEuler(new THREE.Euler(this.pitch, this.yaw, 0, "YXZ"));
  }

  dispose() {
    this.disable();
    document.removeEventListener("pointerlockchange", this._onPointerLockChange);
  }
}
