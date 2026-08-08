import * as THREE from "three";
import { WAVE_COUNT } from "./gerstner.js";

export const oceanVertexShader = /* glsl */ `
precision highp float;

uniform float uTime;
uniform float uWaveCount;
uniform vec2 uDirs[${WAVE_COUNT}];
uniform float uAmp[${WAVE_COUNT}];
uniform float uLambda[${WAVE_COUNT}];
uniform float uSteep[${WAVE_COUNT}];
uniform float uPhase[${WAVE_COUNT}];
uniform float uSpeed[${WAVE_COUNT}];

uniform sampler2D uFFTMap;
uniform float uFFTPatch;
uniform float uHeightMin;
uniform float uHeightRange;
uniform float uFFTScale;

varying vec3 vWorldPos;
varying vec3 vNormal;
varying float vFoam;
varying float vPeak;
varying vec3 vViewDir;
varying vec2 vFFTUV;

vec3 gerstnerDetail(vec3 pos, float t, out float foamAcc) {
  vec3 p = pos;
  float dPx_dx = 1.0, dPy_dx = 0.0, dPz_dx = 0.0;
  float dPx_dz = 0.0, dPy_dz = 0.0, dPz_dz = 1.0;
  foamAcc = 0.0;

  for (int i = 0; i < ${WAVE_COUNT}; i++) {
    if (float(i) >= uWaveCount) break;
    vec2 d = normalize(uDirs[i]);
    float a = uAmp[i];
    float lambda = uLambda[i];
    float k = 6.28318530718 / max(lambda, 0.001);
    float wSpeed = sqrt(9.81 * k) * uSpeed[i];
    float Q = uSteep[i] / (k * a * uWaveCount * 0.5 + 0.0001);
    float theta = k * dot(d, pos.xz) - wSpeed * t + uPhase[i];
    float s = sin(theta);
    float c = cos(theta);
    p.x += Q * a * d.x * c;
    p.y += a * s;
    p.z += Q * a * d.y * c;
    float dth_dx = k * d.x;
    float dth_dz = k * d.y;
    dPx_dx -= Q * a * d.x * s * dth_dx;
    dPy_dx += a * c * dth_dx;
    dPz_dx -= Q * a * d.y * s * dth_dx;
    dPx_dz -= Q * a * d.x * s * dth_dz;
    dPy_dz += a * c * dth_dz;
    dPz_dz -= Q * a * d.y * s * dth_dz;
  }
  float J = dPx_dx * dPz_dz - dPx_dz * dPz_dx;
  foamAcc = smoothstep(0.05, 0.65, clamp(1.0 - J, 0.0, 1.0));

  vec3 n = normalize(vec3(
    dPy_dz * dPz_dx - dPz_dz * dPy_dx,
    dPz_dz * dPx_dx - dPx_dz * dPz_dx,
    dPx_dz * dPy_dx - dPy_dz * dPx_dx
  ));
  // encode normal via perturb later — return displacement; normal computed below
  return p - pos;
}

void main() {
  vec3 pos = position;
  vec3 worldBase = (modelMatrix * vec4(pos, 1.0)).xyz;

  // FFT large-scale displacement (tiled)
  vec2 fftUV = worldBase.xz / uFFTPatch;
  vFFTUV = fftUV;
  vec4 fftS = texture2D(uFFTMap, fract(fftUV));
  float fftH = fftS.r * uHeightRange + uHeightMin;
  float fftFoam = fftS.g;
  float fftDx = (fftS.b - 0.5) * 20.0;
  float fftDz = (fftS.a - 0.5) * 20.0;

  float detailFoam;
  vec3 detailDisp = gerstnerDetail(worldBase, uTime, detailFoam);

  // Finite-difference normal from FFT height (world XZ)
  float eps = uFFTPatch / 64.0;
  float hC = fftH;
  float hL = texture2D(uFFTMap, fract((worldBase.xz + vec2(-eps, 0.0)) / uFFTPatch)).r * uHeightRange + uHeightMin;
  float hR = texture2D(uFFTMap, fract((worldBase.xz + vec2( eps, 0.0)) / uFFTPatch)).r * uHeightRange + uHeightMin;
  float hD = texture2D(uFFTMap, fract((worldBase.xz + vec2(0.0, -eps)) / uFFTPatch)).r * uHeightRange + uHeightMin;
  float hU = texture2D(uFFTMap, fract((worldBase.xz + vec2(0.0,  eps)) / uFFTPatch)).r * uHeightRange + uHeightMin;
  vec3 fftN = normalize(vec3((hL - hR) * uFFTScale, 2.0 * eps, (hD - hU) * uFFTScale));

  // Detail Gerstner normal from displacement gradients
  float foamDet;
  float e2 = 0.5;
  vec3 ddx = gerstnerDetail(worldBase + vec3(e2, 0.0, 0.0), uTime, foamDet) - detailDisp;
  vec3 ddz = gerstnerDetail(worldBase + vec3(0.0, 0.0, e2), uTime, foamDet) - detailDisp;
  vec3 Tx = vec3(e2 + ddx.x, ddx.y, ddx.z);
  vec3 Tz = vec3(ddz.x, ddz.y, e2 + ddz.z);
  vec3 detN = normalize(cross(Tz, Tx));
  if (detN.y < 0.0) detN = -detN;
  vec3 n = normalize(mix(fftN, detN, 0.6));
  if (n.y < 0.0) n = -n;

  vec3 displaced = worldBase;
  displaced.y += fftH * uFFTScale + detailDisp.y;
  displaced.x += fftDx * uFFTScale * 0.35 + detailDisp.x;
  displaced.z += fftDz * uFFTScale * 0.35 + detailDisp.z;

  vec3 localDisp = displaced - worldBase;
  vec3 finalLocal = pos + localDisp;

  vec4 worldPos4 = modelMatrix * vec4(finalLocal, 1.0);
  vWorldPos = worldPos4.xyz;
  vNormal = n;
  vFoam = max(fftFoam, detailFoam);
  vPeak = displaced.y;
  vViewDir = cameraPosition - vWorldPos;

  gl_Position = projectionMatrix * viewMatrix * worldPos4;
}
`;

export const oceanFragmentShader = /* glsl */ `
precision highp float;

uniform float uTime;
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform vec3 uSkyZenith;
uniform vec3 uSkyHorizon;
uniform vec3 uDeepColor;
uniform vec3 uShallowColor;
uniform float uRoughness;
uniform float uExposure;
uniform float uCameraY;
uniform sampler2D uFoamTrail; // persistent foam (screen or world projected — we use world XZ atlas)
uniform float uFoamStrength;

varying vec3 vWorldPos;
varying vec3 vNormal;
varying float vFoam;
varying float vPeak;
varying vec3 vViewDir;
varying vec2 vFFTUV;

float hash(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
}
float noise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  float a = hash(i);
  float b = hash(i + vec2(1.0, 0.0));
  float c = hash(i + vec2(0.0, 1.0));
  float d = hash(i + vec2(1.0, 1.0));
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(a, b, u.x) + (c - a) * u.y * (1.0 - u.x) + (d - b) * u.x * u.y;
}

vec3 skyColor(vec3 rd, vec3 sunDir) {
  float h = rd.y * 0.5 + 0.5;
  vec3 col = mix(uSkyHorizon, uSkyZenith, pow(clamp(h, 0.0, 1.0), 0.55));
  float mu = max(dot(rd, sunDir), 0.0);
  col += uSunColor * (pow(mu, 420.0) * 4.0 + pow(mu, 6.0) * 0.45);
  col = mix(col, uSkyHorizon * 1.15, exp(-max(rd.y, 0.0) * 7.0) * 0.4);
  return col;
}

vec3 microNormal(vec3 N, vec2 xz, float t) {
  float e = 0.4;
  float n1 = noise(xz * 0.55 - t * 0.12);
  float hx = noise((xz + vec2(e, 0.0)) * 0.55 - t * 0.12) - noise((xz - vec2(e, 0.0)) * 0.55 - t * 0.12);
  float hz = noise((xz + vec2(0.0, e)) * 0.55 - t * 0.12) - noise((xz - vec2(0.0, e)) * 0.55 - t * 0.12);
  vec3 T = normalize(cross(N, vec3(0.0, 0.0, 1.0)));
  if (length(T) < 0.1) T = normalize(cross(N, vec3(1.0, 0.0, 0.0)));
  vec3 B = normalize(cross(N, T));
  return normalize(N + T * (-hx * 0.4) + B * (-hz * 0.4));
}

void main() {
  vec3 N = normalize(vNormal);
  vec3 V = normalize(vViewDir);
  if (dot(N, V) < 0.0) N = -N;
  N = microNormal(N, vWorldPos.xz, uTime);

  vec3 L = normalize(uSunDir);
  vec3 H = normalize(L + V);

  float NdotV = max(dot(N, V), 0.0);
  // Schlick Fresnel, F0 ~ 0.02 for water
  float F0 = 0.02;
  float fresnel = F0 + (1.0 - F0) * pow(1.0 - NdotV, 5.0);
  fresnel *= 0.85;

  float heightTint = smoothstep(-1.0, 3.0, vPeak);
  vec3 waterCol = mix(uDeepColor, uShallowColor, NdotV * 0.4 + heightTint * 0.3);

  // Subsurface scattering through crests
  float wrap = max(dot(N, L) * 0.5 + 0.5, 0.0);
  float sss = pow(max(dot(V, -L + N * 0.55), 0.0), 2.2) * 0.7;
  sss *= smoothstep(0.0, 0.65, N.y);
  waterCol += uShallowColor * sss * 1.7;
  waterCol += vec3(0.0, 0.14, 0.11) * wrap * 0.3;

  vec3 R = reflect(-V, N);
  R.y = max(R.y, 0.02);
  vec3 refl = skyColor(normalize(R), L);

  float NdotH = max(dot(N, H), 0.0);
  float specPower = mix(480.0, 40.0, uRoughness);
  float spec = pow(NdotH, specPower) * (1.0 - uRoughness * 0.65);
  float glitter = pow(NdotH, 18.0) * 0.25 * (0.4 + 0.6 * noise(vWorldPos.xz * 0.2 + uTime * 0.35));

  float skyAmb = 0.12 + 0.28 * max(N.y, 0.0);
  vec3 ambient = mix(uDeepColor, uSkyHorizon * 0.35, 0.4) * skyAmb;

  vec3 col = waterCol * (0.35 + wrap * 0.4) + ambient;
  col = mix(col, refl, fresnel * 0.92);
  col += uSunColor * (spec * 1.5 + glitter * 0.7);

  // Instant + persistent foam
  float micro = noise(vWorldPos.xz * 0.4 + uTime * 0.08);
  float trail = texture2D(uFoamTrail, fract(vWorldPos.xz * 0.008)).r;
  float foam = max(vFoam, trail * uFoamStrength);
  foam = max(foam, smoothstep(1.6, 3.5, vPeak) * 0.45);
  foam *= mix(0.65, 1.0, micro);
  foam = clamp(foam, 0.0, 1.0);
  vec3 foamCol = mix(vec3(0.75, 0.84, 0.9), vec3(0.95, 0.97, 0.99), micro);
  col = mix(col, foamCol, foam * 0.9);

  float dist = length(vViewDir);
  float fog = 1.0 - exp(-dist * 0.00045);
  vec3 fogCol = skyColor(normalize(vec3(V.x, max(V.y, 0.02), V.z)), L);
  col = mix(col, fogCol, clamp(fog, 0.0, 0.88));

  if (uCameraY < 0.35) {
    float depth = clamp((0.35 - uCameraY) * 0.35, 0.0, 1.0);
    col = mix(col, vec3(0.0, 0.05, 0.09) + waterCol * 0.2, depth);
  }

  col *= uExposure;
  col = clamp((col * (2.51 * col + 0.03)) / (col * (2.43 * col + 0.59) + 0.14), 0.0, 1.0);
  col = pow(col, vec3(1.0 / 2.2));
  gl_FragColor = vec4(col, 1.0);
}
`;

export function createOceanMaterial() {
  return new THREE.ShaderMaterial({
    vertexShader: oceanVertexShader,
    fragmentShader: oceanFragmentShader,
    uniforms: {
      uTime: { value: 0 },
      uWaveCount: { value: WAVE_COUNT },
      uDirs: { value: Array.from({ length: WAVE_COUNT }, () => new THREE.Vector2(1, 0)) },
      uAmp: { value: new Array(WAVE_COUNT).fill(0) },
      uLambda: { value: new Array(WAVE_COUNT).fill(10) },
      uSteep: { value: new Array(WAVE_COUNT).fill(0.2) },
      uPhase: { value: new Array(WAVE_COUNT).fill(0) },
      uSpeed: { value: new Array(WAVE_COUNT).fill(1) },
      uFFTMap: { value: null },
      uFFTPatch: { value: 180 },
      uHeightMin: { value: -2 },
      uHeightRange: { value: 4 },
      uFFTScale: { value: 1 },
      uSunDir: { value: new THREE.Vector3(0.4, 0.7, 0.3).normalize() },
      uSunColor: { value: new THREE.Color(1.0, 0.94, 0.8) },
      uSkyZenith: { value: new THREE.Color(0.15, 0.38, 0.78) },
      uSkyHorizon: { value: new THREE.Color(0.6, 0.78, 0.95) },
      uDeepColor: { value: new THREE.Color(0.004, 0.04, 0.09) },
      uShallowColor: { value: new THREE.Color(0.02, 0.28, 0.32) },
      uRoughness: { value: 0.16 },
      uExposure: { value: 1.05 },
      uCameraY: { value: 5 },
      uFoamTrail: { value: null },
      uFoamStrength: { value: 0.85 },
    },
    side: THREE.DoubleSide,
  });
}

export function applyDetailWaves(mat, pack) {
  const dirs = mat.uniforms.uDirs.value;
  for (let i = 0; i < WAVE_COUNT; i++) {
    dirs[i].set(pack.dirs[i * 2], pack.dirs[i * 2 + 1]);
    mat.uniforms.uAmp.value[i] = pack.amp[i];
    mat.uniforms.uLambda.value[i] = pack.lambda[i];
    mat.uniforms.uSteep.value[i] = pack.steep[i];
    mat.uniforms.uPhase.value[i] = pack.phase[i];
    mat.uniforms.uSpeed.value[i] = pack.speed[i];
  }
}
