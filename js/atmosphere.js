/**
 * Shared atmosphere / sky model for sky dome + ocean reflections.
 * GLSL source strings kept in one place so horizon never mismatches.
 */

export const ATMOS_GLSL = /* glsl */ `
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform vec3 uSkyZenith;
uniform vec3 uSkyHorizon;
uniform float uTime;
uniform float uTurbidity;

float athash(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
}
float atnoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  float a = athash(i);
  float b = athash(i + vec2(1.0, 0.0));
  float c = athash(i + vec2(0.0, 1.0));
  float d = athash(i + vec2(1.0, 1.0));
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(a, b, u.x) + (c - a) * u.y * (1.0 - u.x) + (d - b) * u.x * u.y;
}
float atfbm(vec2 p) {
  float v = 0.0;
  float a = 0.5;
  for (int i = 0; i < 5; i++) {
    v += a * atnoise(p);
    p = p * 2.05 + vec2(11.2, 3.7);
    a *= 0.5;
  }
  return v;
}

// Linear HDR sky for any ray direction. Used by sky dome and water reflections.
vec3 atmosphereSky(vec3 rd) {
  rd = normalize(rd);
  float h = rd.y;
  vec3 L = normalize(uSunDir);

  // Stronger zenith blue curve (photo clear day)
  float elev = pow(clamp(h * 0.5 + 0.5, 0.0, 1.0), 0.48);
  vec3 col = mix(uSkyHorizon, uSkyZenith, elev);
  // Gentle blue lift. The hard push here was compensating for washed-out grey
  // water; against the GPU ocean it drives the whole frame into royal blue.
  col = mix(col, uSkyZenith * vec3(0.9, 0.97, 1.1), pow(max(h, 0.0), 0.9) * 0.45);
  col.b = max(col.b, col.g * 1.03);

  // Wide horizon haze band — the photo's sea and sky meet at nearly the same
  // value, and that merge comes from haze, not from fogging the water.
  float haze = exp(-max(h, 0.0) * 4.2) * (0.58 + uTurbidity * 0.12);
  col = mix(col, uSkyHorizon * 1.05, haze);

  if (h < 0.0) {
    float g = smoothstep(0.0, -0.55, h);
    col = mix(uSkyHorizon * 0.55, vec3(0.008, 0.02, 0.04), g);
  }

  float mu = max(dot(rd, L), 0.0);
  col += uSunColor * (
    smoothstep(0.9994, 0.99997, mu) * 16.0 +
    pow(mu, 40.0) * 0.7 +
    pow(mu, 6.0) * 0.35 +
    pow(mu, 2.0) * 0.18
  );

  // Sparse thin cirrus
  float band = smoothstep(0.05, 0.2, h) * smoothstep(0.5, 0.12, h);
  vec2 cp = rd.xz / max(abs(h) + 0.06, 0.08) * 1.35 + vec2(uTime * 0.004, uTime * 0.002);
  float clouds = smoothstep(0.55, 0.8, atfbm(cp));
  col = mix(col, mix(col, vec3(1.1, 1.12, 1.15), 0.5), band * clouds * 0.22);

  return col;
}
`;
