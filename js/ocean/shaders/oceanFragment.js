import { ATMOS_GLSL } from "../../atmosphere.js";
import { WATER_BRDF_GLSL } from "./waterBRDF.js";
import { CASCADE_UNIFORMS_GLSL } from "./cascadeSampling.js";

/**
 * Ocean fragment stage.
 *
 * Normals come from the FFT's own derivative textures — the previous 6-octave
 * value-noise `heightField()` is gone, and with it the oily look it caused.
 *
 * Roughness is driven by mip-filtered slope variance rather than a constant,
 * so distance behaves correctly without a noise mask faking glitter.
 */

export const oceanFragmentShader = /* glsl */ `
precision highp float;
precision highp sampler2D;

${ATMOS_GLSL}
${WATER_BRDF_GLSL}
${CASCADE_UNIFORMS_GLSL}

uniform float uNormalStrength[4];
uniform float uTexSize;

uniform sampler2D uFoamTrail;
uniform float uFoamWorld;
uniform float uFoamTrailStrength;
uniform float uFoamAmount;

uniform vec3 uExtinction;
uniform vec3 uScatterAlbedo;
uniform float uBodyThickness;
uniform float uSSSStrength;
uniform vec3 uSSSColor;

uniform float uBaseRoughness;
/** Debug/lookdev scale on slope-variance roughness. 1 = physical, 0 = off. */
uniform float uSlopeVarianceScale;
/** 0 = shaded water. Non-zero renders an intermediate term instead. */
uniform int uDebugMode;
uniform float uExposure;
uniform float uCameraY;
uniform float uAerialDensity;
uniform float uWaveHeightScale;

in vec3 vWorldPos;
in vec2 vWorldXZ;
in float vCamDist;
in float vWaveHeight;
in float vFoam;

out vec4 outColor;

/** Mip level implied by this pixel's footprint in a cascade's texture. */
float cascadeLod(vec2 uv) {
  vec2 dx = dFdx(uv) * uTexSize;
  vec2 dy = dFdy(uv) * uTexSize;
  float d = max(dot(dx, dx), dot(dy, dy));
  return 0.5 * log2(max(d, 1e-12));
}

// Samplers cannot be indexed by a loop counter in ESSL 3.00.
// Variance is accumulated per cascade, not derived from summed moments — see
// cascadeSlopeVariance() for why that distinction is load-bearing.
#define ACCUMULATE_SLOPE(DERIV, DISP, IDX)                                     \\
  {                                                                            \\
    vec2 uv = vWorldXZ / uPatch[IDX];                                          \\
    float lod = cascadeLod(uv);                                                \\
    vec4 d = textureLod(DERIV, uv, lod);                                       \\
    float w = uNormalStrength[IDX];                                            \\
    slope += d.xy * w;                                                         \\
    variance += cascadeSlopeVariance(d.xy, d.zw, lod) * w * w;                      \\
    foam = max(foam, textureLod(DISP, uv, lod).w);                             \\
  }

void main() {
  vec3 V = normalize(cameraPosition - vWorldPos);

  // ---- Normals and slope statistics, accumulated across cascades ----
  vec2 slope = vec2(0.0);
  vec2 variance = vec2(0.0);
  float foam = vFoam;

  ACCUMULATE_SLOPE(uDeriv0, uDisp0, 0)
  ACCUMULATE_SLOPE(uDeriv1, uDisp1, 1)
  ACCUMULATE_SLOPE(uDeriv2, uDisp2, 2)
  ACCUMULATE_SLOPE(uDeriv3, uDisp3, 3)

  vec3 N = normalize(vec3(-slope.x, 1.0, -slope.y));
  if (dot(N, V) < 0.0) N = normalize(vec3(N.x, abs(N.y), N.z));

  vec3 L = normalize(uSunDir);
  vec3 H = normalize(L + V);

  float NoV = clamp(dot(N, V), 1e-3, 1.0);
  float NoL = clamp(dot(N, L), 0.0, 1.0);
  float NoH = clamp(dot(N, H), 0.0, 1.0);
  float LoH = clamp(dot(L, H), 0.0, 1.0);

  // ---- Roughness from sub-pixel slope variance ----
  float alpha = roughnessFromVariance(variance * uSlopeVarianceScale, uBaseRoughness);
  alpha = clamp(alpha, 0.002, 1.0);
  float perceptualRoughness = sqrt(alpha);

  // ---- Sun specular ----
  float D = D_GGX(NoH, alpha);
  float Vis = V_SmithGGXCorrelated(NoV, NoL, alpha);
  float F = F_Schlick(LoH, WATER_F0);
  vec3 specular = uSunColor * (D * Vis * F * NoL);

  // ---- Sky reflection, cone-widened by roughness ----
  vec3 R = reflect(-V, N);
  // Rays that would point below the horizon see water, not sky; bend them back
  // along the horizon rather than sampling the sky's underside.
  float horizonBlend = smoothstep(-0.15, 0.05, R.y);
  vec3 Rh = normalize(vec3(R.x, max(R.y, 0.005), R.z));
  R = normalize(mix(Rh, R, horizonBlend));

  vec3 sharpSky = atmosphereSky(R);
  vec3 wideSky = mix(
    atmosphereSky(normalize(vec3(R.x, 0.35, R.z))),
    atmosphereSky(vec3(0.0, 1.0, 0.0)),
    0.35
  );
  vec3 skyRadiance = mix(sharpSky, wideSky, clamp(perceptualRoughness * 1.6, 0.0, 1.0));

  vec3 msComp = multiScatterCompensation(NoV, perceptualRoughness, vec3(WATER_F0));
  vec3 reflection = skyRadiance * msComp;

  // ---- Volume ----
  // Troughs sit under more water than crests, so they extinguish more red.
  float thickness = clamp(uBodyThickness - vWaveHeight, 0.15, 40.0);
  vec3 transmit = waterTransmission(uExtinction, thickness, NoV);
  vec3 ambientSky = atmosphereSky(vec3(0.0, 1.0, 0.0));
  vec3 body = uScatterAlbedo * transmit * (ambientSky * 0.6 + uSunColor * NoL * 0.4);

  float sss = crestScatter(V, L, N, vWaveHeight, uWaveHeightScale) * uSSSStrength;
  body += uSSSColor * uSunColor * sss;

  // ---- Fresnel mix of body and reflection ----
  float fresnel = F_Schlick(NoV, WATER_F0);
  vec3 color = mix(body, reflection, fresnel);
  color += specular;

  // ---- Foam ----
  float foamMask;
  float trail = texture(uFoamTrail, fract(vWorldXZ / uFoamWorld)).r * uFoamTrailStrength;
  foamMask = clamp(max(foam * uFoamAmount, trail), 0.0, 1.0);
  if (foamMask > 0.001) {
    // Foam is a rough dielectric, not a white blend: it takes sun and sky
    // like any other surface, which is why real whitecaps have shape.
    vec3 foamAlbedo = vec3(0.86, 0.90, 0.93);
    vec3 foamLit = foamAlbedo * (ambientSky * 0.5 + uSunColor * (NoL * 0.6 + 0.2));
    color = mix(color, foamLit, foamMask);
  }

  // ---- Aerial perspective ----
  // A real 20 km horizon means this can be a physical falloff rather than the
  // heavy fog that used to hide a 480 m mesh edge.
  vec3 horizonColor = atmosphereSky(normalize(vec3(V.x, 0.02, V.z)));
  float aerial = 1.0 - exp(-vCamDist * uAerialDensity);
  color = mix(color, horizonColor, clamp(aerial, 0.0, 0.95));

  // Underwater tint if the camera dips below the surface.
  if (uCameraY < 0.35) {
    float submerge = clamp((0.35 - uCameraY) * 1.5, 0.0, 1.0);
    color = mix(color, uScatterAlbedo * 0.35, submerge);
  }

  // Debug views. A GPU FFT cannot be stepped through in a debugger, so the
  // only way to inspect intermediate terms is to render them.
  if (uDebugMode > 0) {
    if (uDebugMode == 1) {          // GGX alpha actually used
      outColor = vec4(vec3(alpha), 1.0);
    } else if (uDebugMode == 2) {   // accumulated slope variance
      outColor = vec4(variance.x, variance.y, 0.0, 1.0);
    } else if (uDebugMode == 3) {   // world normal
      outColor = vec4(N * 0.5 + 0.5, 1.0);
    } else if (uDebugMode == 4) {   // foam mask
      outColor = vec4(vec3(foamMask), 1.0);
    } else if (uDebugMode == 5) {   // wave height, remapped
      outColor = vec4(vec3(vWaveHeight * 0.25 + 0.5), 1.0);
    } else {                        // camera distance, log scale
      outColor = vec4(vec3(log2(max(vCamDist, 1.0)) / 16.0), 1.0);
    }
    return;
  }

  outColor = vec4(color * uExposure, 1.0);
}
`;
