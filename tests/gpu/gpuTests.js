import * as THREE from "three";

const reg = (name, fn) => window.__gpuTests.register(name, fn);

/** One renderer shared by every case — context creation is the slow part. */
export const renderer = new THREE.WebGLRenderer({
  canvas: document.getElementById("c"),
  antialias: false,
});

export function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

export function assertClose(actual, expected, tol, msg) {
  if (!(Math.abs(actual - expected) <= tol)) {
    throw new Error(`${msg}: expected ${expected} ± ${tol}, got ${actual}`);
  }
}

reg("renderer has a WebGL2 context", async () => {
  assert(renderer.capabilities.isWebGL2 === true, "not a WebGL2 context");
});

reg("float render targets are supported", async () => {
  const gl = renderer.getContext();
  assert(gl.getExtension("EXT_color_buffer_float") !== null, "EXT_color_buffer_float missing");
});
