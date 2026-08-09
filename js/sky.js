import * as THREE from "three";
import { ATMOS_GLSL } from "./atmosphere.js";

/**
 * Sky dome — same atmosphereSky() as ocean reflections (soft horizon match).
 */

const skyVert = /* glsl */ `
varying vec3 vWorldDir;
void main() {
  vec4 world = modelMatrix * vec4(position, 1.0);
  vWorldDir = world.xyz - cameraPosition;
  vec4 clip = projectionMatrix * viewMatrix * world;
  clip.z = clip.w;
  gl_Position = clip;
}
`;

const skyFrag = /* glsl */ `
precision highp float;
${ATMOS_GLSL}
uniform float uExposure;
varying vec3 vWorldDir;

void main() {
  vec3 rd = normalize(vWorldDir);
  vec3 col = atmosphereSky(rd);

  // Night stars only
  vec3 L = normalize(uSunDir);
  float night = smoothstep(0.08, -0.14, L.y);
  if (night > 0.01 && rd.y > 0.12) {
    float stars = step(0.9975, athash(floor(rd.xy * 300.0 + rd.z * 50.0)));
    col += vec3(0.9, 0.93, 1.0) * stars * night;
  }

  col *= uExposure;
  gl_FragColor = vec4(col, 1.0);
}
`;

export function createSkyMaterial() {
  return new THREE.ShaderMaterial({
    vertexShader: skyVert,
    fragmentShader: skyFrag,
    uniforms: {
      uSunDir: { value: new THREE.Vector3(0.35, 0.75, 0.25).normalize() },
      uSunColor: { value: new THREE.Color(1.0, 0.96, 0.88) },
      uSkyZenith: { value: new THREE.Color(0.35, 0.58, 0.88) },
      uSkyHorizon: { value: new THREE.Color(0.72, 0.82, 0.92) },
      uExposure: { value: 1.0 },
      uTime: { value: 0 },
      uTurbidity: { value: 0.25 },
    },
    side: THREE.BackSide,
    depthWrite: false,
  });
}

/**
 * Time-of-day palette tuned to the photo reference at ~midday (tod ≈ 0.42):
 * pale sky, soft haze, deep navy troughs, cool grade.
 */
export function sunFromTimeOfDay(tod) {
  const elev = Math.sin((tod - 0.25) * Math.PI * 2);
  const azim = tod * Math.PI * 2;
  const dir = new THREE.Vector3(
    Math.cos(elev) * Math.sin(azim),
    elev,
    Math.cos(elev) * Math.cos(azim),
  ).normalize();

  const day = THREE.MathUtils.smoothstep(elev, -0.12, 0.28);
  const sunset =
    THREE.MathUtils.smoothstep(elev, -0.08, 0.12) *
    (1 - THREE.MathUtils.smoothstep(elev, 0.12, 0.42));

  // Photo: cool daylight sun, not orange
  const sunColor = new THREE.Color().setRGB(
    1.0,
    THREE.MathUtils.lerp(0.55, 0.97, day),
    THREE.MathUtils.lerp(0.35, 0.9, day),
  );
  if (sunset > 0.01) sunColor.lerp(new THREE.Color(1.0, 0.48, 0.22), sunset * 0.75);

  // Photo: deep clear-day blue (keep chroma high so ACES doesn't milk it)
  const zenith = new THREE.Color().setRGB(
    THREE.MathUtils.lerp(0.01, 0.21, day),
    THREE.MathUtils.lerp(0.04, 0.40, day),
    THREE.MathUtils.lerp(0.15, 0.78, day),
  );
  const horizon = new THREE.Color().setRGB(
    THREE.MathUtils.lerp(0.08, 0.66, day) + sunset * 0.35,
    THREE.MathUtils.lerp(0.14, 0.74, day) + sunset * 0.12,
    THREE.MathUtils.lerp(0.28, 0.86, day) * (1 - sunset * 0.15),
  );

  // Deep troughs: near black-navy (photo nadir)
  const deep = new THREE.Color().setRGB(
    THREE.MathUtils.lerp(0.0005, 0.0015, day),
    THREE.MathUtils.lerp(0.008, 0.02, day),
    THREE.MathUtils.lerp(0.028, 0.065, day),
  );
  const shallow = new THREE.Color().setRGB(
    THREE.MathUtils.lerp(0.003, 0.012, day) + sunset * 0.04,
    THREE.MathUtils.lerp(0.06, 0.16, day),
    THREE.MathUtils.lerp(0.1, 0.24, day),
  );

  const exposure = THREE.MathUtils.lerp(0.6, 1.35, day) + sunset * 0.12;
  const fog = horizon.clone().multiplyScalar(0.95);

  return { dir, sunColor, zenith, horizon, deep, shallow, exposure, fog };
}
