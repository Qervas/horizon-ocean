import * as THREE from "three";
import { oceanVertexShader } from "./shaders/oceanVertex.js";
import { oceanFragmentShader } from "./shaders/oceanFragment.js";
import { DISP_UNIFORM_NAMES, DERIV_UNIFORM_NAMES } from "./shaders/cascadeSampling.js";

/**
 * Water material construction and uniform plumbing.
 *
 * Shading lives in shaders/; this file only wires it up.
 */

/**
 * Distance in metres at which each cascade stops contributing *geometry*.
 *
 * Only cascade 0 (wavelengths above 16 m, patch 2048 m) never fades — the mesh
 * can still resolve it at any distance the horizon allows. Every finer cascade
 * eventually outruns the ring spacing available to it and, past that point,
 * displacing vertices by it produces aliasing rather than detail. Cascade 1's
 * 4-16 m waves undersample once ring spacing passes ~100 m, which happens
 * around 1.5 km on the shipping mesh.
 *
 * Fading geometry costs nothing visually: every cascade keeps contributing
 * through the normal and slope-variance path, which is where sub-pixel detail
 * belongs.
 */
const CASCADE_GEOMETRY_FADE = [0, 1500, 260, 90];

/** Per-cascade weight on the normal/slope contribution. */
const CASCADE_NORMAL_STRENGTH = [1.0, 1.0, 1.0, 0.85];

export function createOceanMaterial(sim) {
  const count = sim.cascades.length;
  const pick = (c) => Math.min(c, count - 1);

  const material = new THREE.ShaderMaterial({
    name: "OceanWater",
    glslVersion: THREE.GLSL3,
    vertexShader: oceanVertexShader,
    fragmentShader: oceanFragmentShader,
    uniforms: {
      uDisp0: { value: null },
      uDisp1: { value: null },
      uDisp2: { value: null },
      uDisp3: { value: null },
      uDeriv0: { value: null },
      uDeriv1: { value: null },
      uDeriv2: { value: null },
      uDeriv3: { value: null },
      uPatch: { value: [0, 1, 2, 3].map((c) => sim.cascades[pick(c)].patch) },
      uCascadeFade: { value: CASCADE_GEOMETRY_FADE.slice() },
      uNormalStrength: { value: CASCADE_NORMAL_STRENGTH.slice() },
      uDisplacementScale: { value: 1 },
      uTexSize: { value: sim.N },

      // Atmosphere — shared with the sky dome so the horizon cannot mismatch.
      uSunDir: { value: new THREE.Vector3(0.35, 0.75, 0.25).normalize() },
      uSunColor: { value: new THREE.Color(1.0, 0.96, 0.88) },
      uSkyZenith: { value: new THREE.Color(0.12, 0.38, 0.92) },
      uSkyHorizon: { value: new THREE.Color(0.35, 0.58, 0.85) },
      uTime: { value: 0 },
      uTurbidity: { value: 0.1 },

      uFoamTrail: { value: null },
      uFoamWorld: { value: 480 },
      uFoamTrailStrength: { value: 0.85 },
      uFoamAmount: { value: 0.6 },

      // Clear ocean water extinction, per metre. Red dies in ~2 m, blue lasts
      // ~15 m — this is what makes troughs read as near-black navy.
      uExtinction: { value: new THREE.Vector3(0.45, 0.09, 0.06) },
      uScatterAlbedo: { value: new THREE.Color(0.08, 0.28, 0.32) },
      uBodyThickness: { value: 3.2 },
      uSSSStrength: { value: 0.8 },
      uSSSColor: { value: new THREE.Color(0.04, 0.42, 0.36) },

      uBaseRoughness: { value: 0.06 },
      uSlopeVarianceScale: { value: 1 },
      uDebugMode: { value: 0 },
      uExposure: { value: 1.0 },
      uCameraY: { value: 5 },
      uAerialDensity: { value: 0.00018 },
      uWaveHeightScale: { value: 1.5 },
    },
    side: THREE.FrontSide,
    depthWrite: true,
  });

  material.userData.sim = sim;
  return material;
}

/** Copies the simulation's current cascade textures into the material. */
export function bindSimulationTextures(material, sim) {
  const count = sim.cascades.length;
  for (let c = 0; c < 4; c++) {
    const idx = Math.min(c, count - 1);
    material.uniforms[DISP_UNIFORM_NAMES[c]].value = sim.displacementTexture(idx);
    material.uniforms[DERIV_UNIFORM_NAMES[c]].value = sim.derivativesTexture(idx);
  }
}

/**
 * Per-frame uniform update.
 * `sun` is the object returned by sunFromTimeOfDay() in js/sky.js.
 */
export function updateOceanUniforms(material, { time, sun, weather, cameraY, exposure }) {
  const u = material.uniforms;
  u.uTime.value = time;
  u.uCameraY.value = cameraY;
  u.uSunDir.value.copy(sun.dir);
  u.uSunColor.value.copy(sun.sunColor);
  u.uSkyZenith.value.copy(sun.zenith);
  u.uSkyHorizon.value.copy(sun.horizon);
  if (exposure !== undefined) u.uExposure.value = exposure;

  if (weather) {
    u.uTurbidity.value = weather.turb;
    u.uFoamAmount.value = weather.foam;
    u.uBaseRoughness.value = weather.roughness;
    u.uSSSStrength.value = weather.sss;
    u.uBodyThickness.value = weather.thickness;
  }
}

export { CASCADE_GEOMETRY_FADE, CASCADE_NORMAL_STRENGTH };
