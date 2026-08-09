/**
 * Spectrum evolution pass.
 *
 * Takes the time-invariant h0 and produces the four complex fields whose
 * single inverse FFT yields all eight real fields the surface needs:
 * displacement in three axes, the two height slopes, and the three
 * displacement derivatives that form the Jacobian.
 *
 * Two real fields ride in one complex field: for real A and B, the spectrum
 * A_hat + i*B_hat inverse-transforms to A + iB, so the real part is A and the
 * imaginary part is B. `pack()` builds that combination.
 */

export const evolveVertexShader = /* glsl */ `
in vec3 position;
void main() {
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

export const evolveFragmentShader = /* glsl */ `
precision highp float;
precision highp sampler2D;

uniform sampler2D uH0;
uniform float uTime;
uniform float uPatch;
uniform float uN;
uniform float uDepth;
uniform float uChoppiness;
uniform float uOmega0;

layout(location = 0) out vec4 outColor0;
layout(location = 1) out vec4 outColor1;

const float G = 9.81;

vec2 cmul(vec2 a, vec2 b) {
  return vec2(a.x * b.x - a.y * b.y, a.x * b.y + a.y * b.x);
}

/** Combine two real-valued spectra into one complex field: A + i*B. */
vec2 pack(vec2 a, vec2 b) {
  return vec2(a.x - b.y, a.y + b.x);
}

void main() {
  ivec2 px = ivec2(gl_FragCoord.xy);
  float N = uN;

  // Signed wavenumber indices: the second half of the grid is negative k.
  float nIdx = float(px.x);
  float mIdx = float(px.y);
  float kxIdx = nIdx < N * 0.5 ? nIdx : nIdx - N;
  float kzIdx = mIdx < N * 0.5 ? mIdx : mIdx - N;

  float dk = 6.28318530718 / uPatch;
  float kx = kxIdx * dk;
  float kz = kzIdx * dk;
  float k = sqrt(kx * kx + kz * kz);

  if (k < 1e-6) {
    // DC mode. Dividing by k here is the classic NaN that blackens everything.
    outColor0 = vec4(0.0);
    outColor1 = vec4(0.0);
    return;
  }

  // Quantised to the loop period so the sea repeats seamlessly. Must match
  // spectrum.js dispersion() exactly or CPU/GPU parity tests drift.
  float omegaRaw = sqrt(G * k * tanh(min(k * uDepth, 20.0)));
  float omega = floor(omegaRaw / uOmega0) * uOmega0;

  vec4 h0 = texelFetch(uH0, px, 0);
  vec2 h0k = h0.xy;      // h0(k)
  vec2 h0mkC = h0.zw;    // conj(h0(-k))

  float c = cos(omega * uTime);
  float s = sin(omega * uTime);

  // h(k,t) = h0(k) e^{i w t} + conj(h0(-k)) e^{-i w t}
  vec2 hy = cmul(h0k, vec2(c, s)) + cmul(h0mkC, vec2(c, -s));

  // Horizontal displacement: D = -i (k/|k|) h
  vec2 minusI = vec2(0.0, -1.0);
  vec2 hx = cmul(hy, minusI) * (kx / k) * uChoppiness;
  vec2 hz = cmul(hy, minusI) * (kz / k) * uChoppiness;

  // Spatial derivatives are multiplication by i*k in the spectral domain.
  vec2 ikx = vec2(0.0, kx);
  vec2 ikz = vec2(0.0, kz);

  vec2 dHy_dx = cmul(hy, ikx);
  vec2 dHy_dz = cmul(hy, ikz);
  vec2 dHx_dx = cmul(hx, ikx);
  vec2 dHx_dz = cmul(hx, ikz);
  vec2 dHz_dz = cmul(hz, ikz);

  // dDz/dx is omitted deliberately: both Dx and Dz derive from the same hy,
  // so dDx/dz == dDz/dx identically. Eight real fields, not nine.
  outColor0 = vec4(pack(hy, hx), pack(hz, dHy_dx));
  outColor1 = vec4(pack(dHy_dz, dHx_dx), pack(dHz_dz, dHx_dz));
}
`;
