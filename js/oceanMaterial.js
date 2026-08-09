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
varying vec2 vWorldXZ;

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
    float Q = uSteep[i] / (k * a * uWaveCount * 0.45 + 0.0001);
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
  foamAcc = smoothstep(0.08, 0.55, clamp(1.0 - J, 0.0, 1.0));

  return p - pos;
}

void main() {
  vec3 pos = position;
  vec3 worldBase = (modelMatrix * vec4(pos, 1.0)).xyz;

  vec2 fftUV = worldBase.xz / uFFTPatch;
  vec4 fftS = texture2D(uFFTMap, fract(fftUV));
  float fftH = fftS.r * uHeightRange + uHeightMin;
  float fftFoam = fftS.g;
  float fftDx = (fftS.b - 0.5) * 20.0;
  float fftDz = (fftS.a - 0.5) * 20.0;

  float detailFoam;
  vec3 detailDisp = gerstnerDetail(worldBase, uTime, detailFoam);

  // Smoother FFT normals — larger epsilon to reduce faceting
  float eps = uFFTPatch / 48.0;
  float hL = texture2D(uFFTMap, fract((worldBase.xz + vec2(-eps, 0.0)) / uFFTPatch)).r * uHeightRange + uHeightMin;
  float hR = texture2D(uFFTMap, fract((worldBase.xz + vec2( eps, 0.0)) / uFFTPatch)).r * uHeightRange + uHeightMin;
  float hD = texture2D(uFFTMap, fract((worldBase.xz + vec2(0.0, -eps)) / uFFTPatch)).r * uHeightRange + uHeightMin;
  float hU = texture2D(uFFTMap, fract((worldBase.xz + vec2(0.0,  eps)) / uFFTPatch)).r * uHeightRange + uHeightMin;
  vec3 fftN = normalize(vec3((hL - hR) * uFFTScale, 2.0 * eps, (hD - hU) * uFFTScale));

  // Analytic-ish detail normal via finite differences of Gerstner
  float foamDet;
  float e2 = 0.35;
  vec3 ddx = gerstnerDetail(worldBase + vec3(e2, 0.0, 0.0), uTime, foamDet) - detailDisp;
  vec3 ddz = gerstnerDetail(worldBase + vec3(0.0, 0.0, e2), uTime, foamDet) - detailDisp;
  vec3 Tx = vec3(e2 + ddx.x, ddx.y, ddx.z);
  vec3 Tz = vec3(ddz.x, ddz.y, e2 + ddz.z);
  vec3 detN = normalize(cross(Tz, Tx));
  if (detN.y < 0.0) detN = -detN;

  // Prefer detail normals close-up feel; blend FFT for large structure
  vec3 n = normalize(mix(fftN, detN, 0.72));
  if (n.y < 0.0) n = -n;

  vec3 displaced = worldBase;
  displaced.y += fftH * uFFTScale + detailDisp.y;
  displaced.x += fftDx * uFFTScale * 0.35 + detailDisp.x;
  displaced.z += fftDz * uFFTScale * 0.35 + detailDisp.z;

  vec3 localDisp = displaced - worldBase;
  vec3 finalLocal = pos + localDisp;

  vec4 worldPos4 = modelMatrix * vec4(finalLocal, 1.0);
  vWorldPos = worldPos4.xyz;
  vWorldXZ = worldPos4.xz;
  vNormal = n;
  vFoam = max(fftFoam * 0.85, detailFoam);
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
uniform sampler2D uFoamTrail;
uniform float uFoamStrength;

varying vec3 vWorldPos;
varying vec3 vNormal;
varying float vFoam;
varying float vPeak;
varying vec3 vViewDir;
varying vec2 vWorldXZ;

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
float fbm(vec2 p) {
  float v = 0.0;
  float a = 0.5;
  for (int i = 0; i < 5; i++) {
    v += a * noise(p);
    p *= 2.07;
    a *= 0.5;
  }
  return v;
}

vec3 skyColor(vec3 rd, vec3 sunDir) {
  float h = clamp(rd.y * 0.5 + 0.5, 0.0, 1.0);
  vec3 col = mix(uSkyHorizon, uSkyZenith, pow(h, 0.65));
  float mu = max(dot(rd, sunDir), 0.0);
  col += uSunColor * (smoothstep(0.9995, 0.99995, mu) * 8.0 + pow(mu, 32.0) * 0.55 + pow(mu, 4.0) * 0.25);
  col = mix(col, uSkyHorizon * 1.1, exp(-max(rd.y, 0.0) * 6.0) * 0.45);
  return col;
}

// Multi-scale micro normals to kill low-poly look
vec3 microNormal(vec3 N, vec2 xz, float t) {
  float s1 = 0.22;
  float e1 = 0.55;
  float hx1 = noise((xz + vec2(e1, 0.0)) * s1 - t * 0.07) - noise((xz - vec2(e1, 0.0)) * s1 - t * 0.07);
  float hz1 = noise((xz + vec2(0.0, e1)) * s1 - t * 0.07) - noise((xz - vec2(0.0, e1)) * s1 - t * 0.07);
  float s2 = 0.85;
  float e2 = 0.18;
  float hx2 = noise((xz + vec2(e2, 0.0)) * s2 + t * 0.15) - noise((xz - vec2(e2, 0.0)) * s2 + t * 0.15);
  float hz2 = noise((xz + vec2(0.0, e2)) * s2 + t * 0.15) - noise((xz - vec2(0.0, e2)) * s2 + t * 0.15);
  float s3 = 2.8;
  float e3 = 0.06;
  float hx3 = noise((xz + vec2(e3, 0.0)) * s3 - t * 0.4) - noise((xz - vec2(e3, 0.0)) * s3 - t * 0.4);
  float hz3 = noise((xz + vec2(0.0, e3)) * s3 - t * 0.4) - noise((xz - vec2(0.0, e3)) * s3 - t * 0.4);

  float hx = hx1 * 0.55 + hx2 * 0.32 + hx3 * 0.13;
  float hz = hz1 * 0.55 + hz2 * 0.32 + hz3 * 0.13;

  vec3 T = normalize(cross(N, vec3(0.0, 0.0, 1.0)));
  if (length(T) < 0.1) T = normalize(cross(N, vec3(1.0, 0.0, 0.0)));
  vec3 B = normalize(cross(N, T));
  return normalize(N + T * (-hx * 0.85) + B * (-hz * 0.85));
}

void main() {
  vec3 N = normalize(vNormal);
  vec3 V = normalize(vViewDir);
  if (dot(N, V) < 0.0) N = -N;
  N = microNormal(N, vWorldXZ, uTime);

  vec3 L = normalize(uSunDir);
  vec3 H = normalize(L + V);

  float NdotV = max(dot(N, V), 0.001);
  float NdotL = max(dot(N, L), 0.0);
  float NdotH = max(dot(N, H), 0.0);
  float VdotH = max(dot(V, H), 0.0);

  float F0 = 0.02;
  float fresnel = F0 + (1.0 - F0) * pow(1.0 - NdotV, 5.0);
  fresnel = mix(fresnel, 1.0, pow(1.0 - NdotV, 3.0) * 0.35);

  float heightTint = smoothstep(-0.8, 2.2, vPeak);
  float facing = pow(NdotV, 0.65);
  vec3 waterCol = mix(uDeepColor, uShallowColor, facing * 0.35 + heightTint * 0.25);

  float wrap = max(dot(N, L) * 0.5 + 0.5, 0.0);
  float sss = pow(max(dot(V, -L + N * 0.65), 0.0), 2.5) * 0.85;
  sss *= smoothstep(0.05, 0.7, N.y) * (0.4 + heightTint * 0.6);
  waterCol += vec3(0.02, 0.22, 0.18) * sss * 2.2;
  waterCol += vec3(0.0, 0.08, 0.1) * wrap * 0.25;

  vec3 R = reflect(-V, N);
  R.y = abs(R.y) * 0.85 + 0.15;
  vec3 refl = skyColor(normalize(R), L);

  float alpha = max(uRoughness * uRoughness, 0.002);
  float a2 = alpha * alpha;
  float dnh = NdotH * NdotH * (a2 - 1.0) + 1.0;
  float D = a2 / (3.14159265 * dnh * dnh + 1e-5);
  float k = (uRoughness + 1.0) * (uRoughness + 1.0) / 8.0;
  float Gv = NdotV / (NdotV * (1.0 - k) + k);
  float Gl = NdotL / (NdotL * (1.0 - k) + k);
  float G = Gv * Gl;
  float Fspec = F0 + (1.0 - F0) * pow(1.0 - VdotH, 5.0);
  float spec = D * G * Fspec / (4.0 * NdotV * NdotL + 1e-4);
  spec = clamp(spec, 0.0, 8.0);

  float glitter = pow(NdotH, 48.0) * 0.35 * (0.3 + 0.7 * noise(vWorldXZ * 0.35 + uTime * 0.5));

  float skyAmb = 0.08 + 0.32 * max(N.y, 0.0);
  vec3 ambient = mix(uDeepColor * 1.4, uSkyHorizon * 0.25, 0.5) * skyAmb;

  vec3 col = waterCol * (0.28 + NdotL * 0.45 + wrap * 0.2) + ambient;
  col = mix(col, refl, clamp(fresnel * 0.95, 0.0, 0.92));
  col += uSunColor * (spec * 1.8 * NdotL + glitter);

  float micro = fbm(vWorldXZ * 0.35 + uTime * 0.06);
  float trail = texture2D(uFoamTrail, fract(vWorldXZ * 0.007)).r;
  float crestFoam = smoothstep(1.2, 2.8, vPeak) * 0.55;
  float foam = max(max(vFoam, trail * uFoamStrength), crestFoam);
  foam *= mix(0.55, 1.0, micro);
  foam = clamp(foam, 0.0, 1.0);
  float foamMask = smoothstep(0.15, 0.75, foam);
  vec3 foamCol = mix(vec3(0.55, 0.68, 0.75), vec3(0.92, 0.95, 0.98), micro);
  col = mix(col, foamCol, foamMask * 0.88);

  float dist = length(vViewDir);
  float fog = 1.0 - exp(-dist * 0.00038);
  vec3 fogCol = skyColor(normalize(vec3(V.x, max(V.y, 0.05), V.z)), L);
  col = mix(col, fogCol, clamp(fog, 0.0, 0.82));

  if (uCameraY < 0.4) {
    float depth = clamp((0.4 - uCameraY) * 0.4, 0.0, 1.0);
    col = mix(col, vec3(0.0, 0.04, 0.08) + waterCol * 0.15, depth);
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
      uSkyZenith: { value: new THREE.Color(0.12, 0.32, 0.7) },
      uSkyHorizon: { value: new THREE.Color(0.45, 0.62, 0.82) },
      uDeepColor: { value: new THREE.Color(0.002, 0.02, 0.05) },
      uShallowColor: { value: new THREE.Color(0.015, 0.16, 0.2) },
      uRoughness: { value: 0.12 },
      uExposure: { value: 0.95 },
      uCameraY: { value: 5 },
      uFoamTrail: { value: null },
      uFoamStrength: { value: 0.9 },
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
