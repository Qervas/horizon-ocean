/**
 * Assemble pass — unpacks the eight real fields the inverse FFT produced into
 * the two textures the water material consumes.
 *
 * Also computes the Jacobian exactly (no finite differences) and advances the
 * persistent foam buffer. Foam has memory: it lingers for seconds after the
 * fold that created it, so it is accumulated and decayed rather than recomputed
 * per frame. Instantaneous foam blinks.
 *
 * The derivatives texture stores first *and* second slope moments rather than a
 * precomputed variance. Mip filtering averages them correctly, and the shader
 * recovers variance at any LOD as E[s^2] - E[s]^2 — which is what makes
 * slope-variance (LEAN) roughness work.
 */

export const assembleVertexShader = /* glsl */ `
in vec3 position;
void main() {
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

export const assembleFragmentShader = /* glsl */ `
precision highp float;
precision highp sampler2D;

uniform sampler2D uFFT0;
uniform sampler2D uFFT1;
uniform sampler2D uPrev;
uniform float uFoamDecay;
uniform float uFoamThreshold;
uniform float uFoamGain;
uniform float uHasPrev;

layout(location = 0) out vec4 outColor0;
layout(location = 1) out vec4 outColor1;

void main() {
  ivec2 px = ivec2(gl_FragCoord.xy);

  vec4 a = texelFetch(uFFT0, px, 0);
  vec4 b = texelFetch(uFFT1, px, 0);

  float Dy     = a.x;
  float Dx     = a.y;
  float Dz     = a.z;
  float dDy_dx = a.w;

  float dDy_dz = b.x;
  float dDx_dx = b.y;
  float dDz_dz = b.z;
  float dDx_dz = b.w;

  // Exact Jacobian. The cross terms are equal because Dx and Dz share hy,
  // so the off-diagonal product is a square.
  float J = (1.0 + dDx_dx) * (1.0 + dDz_dz) - dDx_dz * dDx_dz;

  float prevFoam = uHasPrev > 0.5 ? texelFetch(uPrev, px, 0).a : 0.0;
  float inject = max(0.0, uFoamThreshold - J) * uFoamGain;
  float foam = clamp(max(prevFoam * uFoamDecay, inject), 0.0, 1.0);

  outColor0 = vec4(Dx, Dy, Dz, foam);
  outColor1 = vec4(dDy_dx, dDy_dz, dDy_dx * dDy_dx, dDy_dz * dDy_dz);
}
`;
