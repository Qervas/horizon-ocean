/**
 * Water BRDF building blocks.
 *
 * Kept separate from composition so each term can be reasoned about — and
 * debugged — on its own.
 */

export const WATER_BRDF_GLSL = /* glsl */ `

const float PI = 3.14159265359;

// Water at normal incidence reflects about 2% — IOR 1.333.
const float WATER_F0 = 0.02;

// ---------------------------------------------------------------------------
// Specular
// ---------------------------------------------------------------------------

float D_GGX(float NoH, float alpha) {
  float a2 = alpha * alpha;
  float d = (NoH * a2 - NoH) * NoH + 1.0;
  return a2 / max(PI * d * d, 1e-8);
}

/** Smith height-correlated visibility (includes the 1/(4 NoL NoV) term). */
float V_SmithGGXCorrelated(float NoV, float NoL, float alpha) {
  float a2 = alpha * alpha;
  float lambdaV = NoL * sqrt((NoV - a2 * NoV) * NoV + a2);
  float lambdaL = NoV * sqrt((NoL - a2 * NoL) * NoL + a2);
  return 0.5 / max(lambdaV + lambdaL, 1e-6);
}

float F_Schlick(float u, float f0) {
  float f = pow(1.0 - u, 5.0);
  return f0 + (1.0 - f0) * f;
}

/**
 * Karis's analytic split-sum environment BRDF. Replaces the usual lookup
 * texture; the fit is well within what water shading can resolve.
 * Returns (scale, bias) applied as F0 * scale + bias.
 */
vec2 envBRDFApprox(float NoV, float roughness) {
  const vec4 c0 = vec4(-1.0, -0.0275, -0.572, 0.022);
  const vec4 c1 = vec4(1.0, 0.0425, 1.04, -0.04);
  vec4 r = roughness * c0 + c1;
  float a004 = min(r.x * r.x, exp2(-9.28 * NoV)) * r.x + r.y;
  return vec2(-1.04, 1.04) * a004 + r.zw;
}

/**
 * Multiple-scattering energy compensation (Fdez-Aguera). Single-scattering GGX
 * loses energy at high roughness; without this, rough water goes subtly dark
 * exactly where whitecaps should be brightening it.
 */
vec3 multiScatterCompensation(float NoV, float roughness, vec3 F0) {
  vec2 ab = envBRDFApprox(NoV, roughness);
  vec3 FssEss = F0 * ab.x + ab.y;
  float Ess = ab.x + ab.y;
  float Ems = 1.0 - Ess;
  vec3 Favg = F0 + (1.0 - F0) / 21.0;
  vec3 Fms = FssEss * Favg / (1.0 - Ems * Favg);
  return FssEss + Fms * Ems;
}

// ---------------------------------------------------------------------------
// Slope variance (LEAN mapping)
// ---------------------------------------------------------------------------

/**
 * Per-cascade slope variance from mip-filtered first and second moments.
 *
 * MUST be evaluated per cascade and summed, not computed from summed moments.
 * Var(sum of independent fields) = sum of Var, whereas
 * sum(E[s^2]) - (sum(E[s]))^2 subtracts spurious cross terms and can clamp to
 * zero — which silently disables the whole roughness-with-distance effect.
 */
vec2 cascadeSlopeVariance(vec2 m1, vec2 m2, float lod) {
  vec2 variance = max(m2 - m1 * m1, vec2(0.0));
  // Only minification hides detail. Below LOD 0 the pixel is smaller than a
  // texel, so there is no unresolved slope to fold into roughness — yet
  // bilinear filtering still makes E[s^2] exceed E[s]^2 there. Weighting by LOD
  // suppresses that artifact, which otherwise roughens near water by 4x and
  // leaves nothing left to vary with distance.
  return variance * clamp(lod, 0.0, 1.0);
}

/**
 * Roughness from the sub-pixel slope distribution.
 *
 * Folding accumulated slope variance into GGX roughness is what stops distant
 * water from either sparkle-aliasing or flattening to grey — the single largest
 * contributor to the look, and the reason four cascades help at distance
 * instead of hurting.
 */
float roughnessFromVariance(vec2 variance, float baseAlpha) {
  float sigma2 = variance.x + variance.y;
  // alpha^2 adds linearly in slope-space variance.
  return sqrt(baseAlpha * baseAlpha + 2.0 * sigma2);
}

// ---------------------------------------------------------------------------
// Volume
// ---------------------------------------------------------------------------

/**
 * Beer-Lambert transmission through the water column.
 *
 * Clear ocean extinction is roughly (0.45, 0.09, 0.06) per metre: red is gone
 * within ~2 m while blue survives ~15 m. That asymmetry, not a painted colour,
 * is what makes troughs read as near-black navy.
 */
vec3 waterTransmission(vec3 extinction, float thickness, float NoV) {
  // Grazing views look through more water than head-on views.
  float pathLength = thickness / max(NoV, 0.12);
  return exp(-extinction * pathLength);
}

/**
 * Subsurface scattering through thin backlit crests. Strongest when looking
 * toward the sun through the top of a wave.
 */
float crestScatter(vec3 V, vec3 L, vec3 N, float waveHeight, float heightScale) {
  float backlight = pow(max(dot(V, -L), 0.0), 4.0);
  float thin = smoothstep(0.0, heightScale, waveHeight);
  float upward = smoothstep(-0.1, 0.4, N.y);
  return backlight * thin * upward;
}
`;
