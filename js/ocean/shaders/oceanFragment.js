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
/**
 * Exposure the sky dome renders at. The water must reflect the sky at the same
 * exposure the sky is drawn at, or reflections come out uniformly dimmer than
 * the sky they mirror and the sea reads far darker than the horizon it meets.
 */
uniform float uSkyExposure;
uniform float uCameraY;
uniform float uAerialDensity;
uniform float uWaveHeightScale;

in vec3 vWorldPos;
in vec2 vWorldXZ;
in float vCamDist;
in float vWaveHeight;
in float vFoam;

out vec4 outColor;

/**
 * Multi-scale porosity for foam breakup.
 *
 * Real whitecaps are a broken film full of holes and thinning edges, not a
 * painted region. Without this the mask is smooth and reads as white paint.
 */
float foamPorosity(vec2 p, float t) {
  float n1 = atnoise(p * 0.6 + vec2(t * 0.02, t * 0.013));
  float n2 = atnoise(p * 2.1 - vec2(t * 0.035, t * 0.02));
  float n3 = atnoise(p * 5.7 + vec2(t * 0.06, t * 0.04));
  return n1 * 0.5 + n2 * 0.33 + n3 * 0.17;
}

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

  vec3 sharpSky = atmosphereSky(R) * uSkyExposure;
  vec3 wideSky = mix(
    atmosphereSky(normalize(vec3(R.x, 0.35, R.z))),
    atmosphereSky(vec3(0.0, 1.0, 0.0)),
    0.35
  ) * uSkyExposure;
  vec3 skyRadiance = mix(sharpSky, wideSky, clamp(perceptualRoughness * 1.6, 0.0, 1.0));

  vec3 msComp = multiScatterCompensation(NoV, perceptualRoughness, vec3(WATER_F0));
  vec3 reflection = skyRadiance * msComp;

  // ---- Volume ----
  // Troughs sit under more water than crests, so they extinguish more red.
  float thickness = clamp(uBodyThickness - vWaveHeight, 0.15, 40.0);
  vec3 transmit = waterTransmission(uExtinction, thickness, NoV);
  vec3 ambientSky = atmosphereSky(vec3(0.0, 1.0, 0.0)) * uSkyExposure;
  vec3 body = uScatterAlbedo * transmit * (ambientSky * 0.6 + uSunColor * NoL * 0.4);

  float sss = crestScatter(V, L, N, vWaveHeight, uWaveHeightScale) * uSSSStrength;
  body += uSSSColor * uSunColor * sss;

  // ---- Foam coverage ----
  // Computed before compositing: foam is a rough diffuse film, so it has to
  // extinguish the specular and the sharp sky reflection underneath it. Painted
  // over the top instead, it reads as white gloss on glass.
  float trail = texture(uFoamTrail, fract(vWorldXZ / uFoamWorld)).r * uFoamTrailStrength;
  float rawFoam = max(foam * uFoamAmount, trail);
  float porosity = foamPorosity(vWorldXZ, uTime);
  // Erode by the porosity field, then harden the edge. Dense centres survive,
  // thin margins break into islands.
  float foamMask = clamp((rawFoam * (0.5 + 0.95 * porosity) - 0.10) * 2.1, 0.0, 1.0);
  foamMask = smoothstep(0.02, 0.6, foamMask);

  // ---- Combine body and reflection ----
  // multiScatterCompensation already integrates Fresnel over the environment
  // (it is the split-sum F0*scale + bias term), so the reflection is ADDED and
  // the body is attenuated by what it reflects away. Mixing by a second
  // F_Schlick here double-counts Fresnel and dims the sky reflection by more
  // than an order of magnitude — which is what made the water read as painted
  // blue instead of sky-dominated.
  float reflectance = clamp(dot(msComp, vec3(0.2126, 0.7152, 0.0722)), 0.0, 1.0);
  float clearWater = 1.0 - foamMask;
  vec3 color = body * (1.0 - reflectance) + reflection * clearWater;
  color += specular * clearWater;

  // ---- Foam shading ----
  if (foamMask > 0.001) {
    // Near-Lambertian reflector of the whole sky hemisphere. Thin margins are
    // greyer and wetter than dense centres, which is most of what separates
    // foam from paint.
    vec3 foamAlbedo = mix(vec3(0.62, 0.68, 0.73), vec3(0.94, 0.96, 0.97), porosity);
    vec3 foamLit = foamAlbedo * (ambientSky * 1.45 + uSunColor * (NoL * 0.8 + 0.3));
    color = mix(color, foamLit, foamMask);
  }

  // ---- Aerial perspective ----
  // A real 20 km horizon means this can be a physical falloff rather than the
  // heavy fog that used to hide a 480 m mesh edge.
  vec3 horizonColor = atmosphereSky(normalize(vec3(-V.x, 0.02, -V.z))) * uSkyExposure;
  float aerial = 1.0 - exp(-vCamDist * uAerialDensity);
  color = mix(color, horizonColor, clamp(aerial, 0.0, 0.95));

  // Underwater tint if the camera dips below the surface.
  if (uCameraY < 0.35) {
    float submerge = clamp((0.35 - uCameraY) * 1.5, 0.0, 1.0);
    color = mix(color, uScatterAlbedo * 0.35, submerge);
  }

  // Debug views. A GPU FFT cannot be stepped through in a debugger, so the
  // only way to inspect intermediate terms is to render them.
  //
  // CAVEAT: these still pass through the post stack, whose contrast and lift
  // crush small values to zero. A debug channel reading 0 may mean "small",
  // not "absent" — verify against the simulation's own output before
  // concluding a term is dead.
  if (uDebugMode > 0) {
    if (uDebugMode == 1) {          // GGX alpha actually used
      outColor = vec4(vec3(alpha), 1.0);
    } else if (uDebugMode == 2) {   // accumulated slope variance
      outColor = vec4(variance.x, variance.y, 0.0, 1.0);
    } else if (uDebugMode == 3) {   // world normal
      outColor = vec4(N * 0.5 + 0.5, 1.0);
    } else if (uDebugMode == 4) {   // foam mask
      outColor = vec4(vec3(foamMask), 1.0);
    } else if (uDebugMode == 7) {   // body (transmission) term alone
      outColor = vec4(body, 1.0);
    } else if (uDebugMode == 8) {   // sky reflection term alone
      outColor = vec4(reflection, 1.0);
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
