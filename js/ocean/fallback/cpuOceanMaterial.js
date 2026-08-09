import * as THREE from "three";
import { WAVE_COUNT } from "./cpuGerstner.js";
import { ATMOS_GLSL } from "../../atmosphere.js";

/**
 * Reflection-first ocean — match ref/ocean-photo-target.jpg
 *
 * Real open water: Fresnel sky reflection dominates; volume body only
 * in steep-down views and troughs. Soft horizon. Wind-streaked glints.
 * Linear HDR out → post ACES.
 */

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
uniform float uChopScale;

varying vec3 vWorldPos;
varying vec3 vNormal;
varying float vFoam;
varying float vPeak;
varying vec3 vViewDir;
varying vec2 vWorldXZ;
varying float vJacobian;

// ampScale: 1 near camera, lower far — kills sub-triangle Gerstner facets
vec3 gerstnerDetail(vec3 pos, float t, float ampScale, out float foamAcc, out float Jout) {
  vec3 p = pos;
  float dPx_dx = 1.0, dPy_dx = 0.0, dPz_dx = 0.0;
  float dPx_dz = 0.0, dPy_dz = 0.0, dPz_dz = 1.0;
  foamAcc = 0.0;

  for (int i = 0; i < ${WAVE_COUNT}; i++) {
    if (float(i) >= uWaveCount) break;
    // Drop short waves early — unresolved wavelengths = diamond facets
    float lambda = uLambda[i];
    if (ampScale < 0.25 && lambda < 10.0) continue;
    if (ampScale < 0.45 && lambda < 5.0) continue;
    if (ampScale < 0.7 && lambda < 2.0) continue;

    vec2 d = normalize(uDirs[i]);
    float a = uAmp[i] * ampScale;
    float k = 6.28318530718 / max(lambda, 0.001);
    float wSpeed = sqrt(9.81 * k) * uSpeed[i];
    float Q = uSteep[i] / (k * max(a, 0.001) * max(uWaveCount, 1.0) * 0.4 + 0.0001);
    Q = min(Q, 0.85); // prevent extreme chop folding / hard facets
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
  Jout = J;
  foamAcc = smoothstep(0.15, 0.8, clamp(1.0 - J, 0.0, 1.0));
  return p - pos;
}

void main() {
  vec3 pos = position;
  vec3 worldBase = (modelMatrix * vec4(pos, 1.0)).xyz;
  float camDist = length(cameraPosition - worldBase);
  // LOD: full detail only very near; mid uses swell so mesh stays smooth
  float ampScale = mix(1.0, 0.12, smoothstep(18.0, 160.0, camDist));

  vec2 fftUV = worldBase.xz / uFFTPatch;
  vec4 fftS = texture2D(uFFTMap, fract(fftUV));
  float fftH = fftS.r * uHeightRange + uHeightMin;
  float fftFoam = fftS.g;
  float fftDx = (fftS.b - 0.5) * 25.0;
  float fftDz = (fftS.a - 0.5) * 25.0;

  float detailFoam;
  float detailJ;
  vec3 detailDisp = gerstnerDetail(worldBase, uTime, ampScale, detailFoam, detailJ);

  float eps = uFFTPatch / 72.0;
  float hL = texture2D(uFFTMap, fract((worldBase.xz + vec2(-eps, 0.0)) / uFFTPatch)).r * uHeightRange + uHeightMin;
  float hR = texture2D(uFFTMap, fract((worldBase.xz + vec2( eps, 0.0)) / uFFTPatch)).r * uHeightRange + uHeightMin;
  float hD = texture2D(uFFTMap, fract((worldBase.xz + vec2(0.0, -eps)) / uFFTPatch)).r * uHeightRange + uHeightMin;
  float hU = texture2D(uFFTMap, fract((worldBase.xz + vec2(0.0,  eps)) / uFFTPatch)).r * uHeightRange + uHeightMin;
  vec3 fftN = normalize(vec3((hL - hR) * uFFTScale, 2.0 * eps, (hD - hU) * uFFTScale));

  float foamDet;
  float jDet;
  float e2 = mix(0.55, 1.2, smoothstep(20.0, 150.0, camDist));
  vec3 ddx = gerstnerDetail(worldBase + vec3(e2, 0.0, 0.0), uTime, ampScale, foamDet, jDet) - detailDisp;
  vec3 ddz = gerstnerDetail(worldBase + vec3(0.0, 0.0, e2), uTime, ampScale, foamDet, jDet) - detailDisp;
  vec3 Tx = vec3(e2 + ddx.x, ddx.y, ddx.z);
  vec3 Tz = vec3(ddz.x, ddz.y, e2 + ddz.z);
  vec3 detN = normalize(cross(Tz, Tx));
  if (detN.y < 0.0) detN = -detN;

  // Prefer smooth FFT normals; detail only close
  float detW = mix(0.48, 0.08, smoothstep(15.0, 120.0, camDist));
  vec3 n = normalize(mix(fftN, detN, detW * ampScale));
  if (n.y < 0.0) n = -n;

  // Soften horizontal chop (choppy displacement reads as facets near cam too)
  float chopFade = mix(0.75, 0.15, smoothstep(25.0, 220.0, camDist));
  vec3 displaced = worldBase;
  displaced.y += fftH * uFFTScale + detailDisp.y;
  displaced.x += (fftDx * uFFTScale * uChopScale + detailDisp.x) * chopFade;
  displaced.z += (fftDz * uFFTScale * uChopScale + detailDisp.z) * chopFade;

  vec3 finalLocal = pos + (displaced - worldBase);
  vec4 worldPos4 = modelMatrix * vec4(finalLocal, 1.0);
  vWorldPos = worldPos4.xyz;
  vWorldXZ = worldPos4.xz;
  vNormal = n;
  vFoam = max(fftFoam * 0.7, detailFoam);
  vPeak = displaced.y;
  vJacobian = detailJ;
  vViewDir = cameraPosition - vWorldPos;
  gl_Position = projectionMatrix * viewMatrix * worldPos4;
}
`;

export const oceanFragmentShader = /* glsl */ `
precision highp float;

${ATMOS_GLSL}

uniform float uRoughness;
uniform float uExposure;
uniform float uCameraY;
uniform sampler2D uFoamTrail;
uniform float uFoamStrength;
uniform float uFoamWorld;
uniform float uSSSStrength;
uniform vec3 uDeepColor;
uniform vec3 uShallowColor;
uniform vec2 uWindDir;
uniform float uSeaState; // 0 calm .. 1 storm — drives foam / roughness

varying vec3 vWorldPos;
varying vec3 vNormal;
varying float vFoam;
varying float vPeak;
varying vec3 vViewDir;
varying vec2 vWorldXZ;
varying float vJacobian;

// ---- Multi-scale surface height field (world-locked, slow drift) ----
float heightField(vec2 p, float t) {
  vec2 W = normalize(uWindDir);
  vec2 P = vec2(-W.y, W.x);
  // Wind-stretched coords for anisotropic ripples
  vec2 q = vec2(dot(p, W), dot(p, P) * 2.6);
  float h = 0.0;
  float a = 0.5;
  // 6 octaves: long streaks → mid chop → capillary
  for (int i = 0; i < 6; i++) {
    float fi = float(i);
    float sc = exp2(fi) * 0.045;
    // Very slow phase so moving camera doesn't read as texture scroll
    vec2 drift = vec2(t * (0.012 + fi * 0.004), t * 0.006);
    h += a * (atnoise(q * sc + drift) * 2.0 - 1.0);
    // Rotate each octave slightly for less grid look
    float qx = q.x * 0.8 - q.y * 0.6;
    float qy = q.x * 0.6 + q.y * 0.8;
    q = vec2(qx, qy);
    a *= 0.52;
  }
  return h;
}

// Analytic-ish normal from finite differences of height field
vec3 microNormalFromHeight(vec3 N, vec2 xz, float t, float camDist) {
  float fade = 1.0 - smoothstep(40.0, 320.0, camDist);
  if (fade < 0.02) return N;
  // Adaptive step: larger far = smoother
  float e = mix(0.12, 0.55, smoothstep(10.0, 120.0, camDist));
  float hL = heightField(xz + vec2(-e, 0.0), t);
  float hR = heightField(xz + vec2( e, 0.0), t);
  float hD = heightField(xz + vec2(0.0, -e), t);
  float hU = heightField(xz + vec2(0.0,  e), t);
  // Strength: stronger near for oily detail, softer far
  float str = mix(0.55, 0.12, smoothstep(8.0, 100.0, camDist)) * fade;
  vec3 T = normalize(cross(N, vec3(0.0, 0.0, 1.0)));
  if (length(T) < 0.1) T = normalize(cross(N, vec3(1.0, 0.0, 0.0)));
  vec3 B = normalize(cross(N, T));
  float hx = (hR - hL) * str;
  float hz = (hU - hD) * str;
  return normalize(N - T * hx - B * hz);
}

// Anisotropic GGX (Ashikhmin-Shirley style stretch along wind)
float ggxD_aniso(float NdotH, float TdotH, float BdotH, float ax, float ay) {
  float a2 = ax * ay;
  vec3 v = vec3(ax * TdotH, ay * BdotH, a2 * NdotH);
  float v2 = dot(v, v);
  return (a2 * a2) / (3.14159265 * max(v2 * v2, 1e-7));
}

float schlickG1(float nDotX, float k) {
  return nDotX / (nDotX * (1.0 - k) + k + 1e-5);
}

// Porous foam albedo (photo foam is not solid white)
float foamPattern(vec2 xz, float t) {
  float n1 = atnoise(xz * 0.55 + t * 0.03);
  float n2 = atnoise(xz * 1.8 - t * 0.05);
  float n3 = atnoise(xz * 4.5 + t * 0.08);
  return smoothstep(0.35, 0.85, n1 * 0.5 + n2 * 0.3 + n3 * 0.2);
}

// half-Lambert wrap for soft water lighting
float wrapLight(vec3 N, vec3 L) {
  return max(dot(N, L) * 0.5 + 0.5, 0.0);
}

void main() {
  vec3 N0 = normalize(vNormal);
  vec3 V = normalize(vViewDir);
  float camDist = length(vViewDir);
  if (dot(N0, V) < 0.0) N0 = -N0;

  // Layer micro detail on geometric normal
  vec3 N = microNormalFromHeight(N0, vWorldXZ, uTime, camDist);

  vec3 L = normalize(uSunDir);
  vec3 H = normalize(L + V);

  // Tangent frame for anisotropic specular
  vec3 Tw = normalize(vec3(uWindDir.x, 0.0, uWindDir.y));
  vec3 Bw = normalize(cross(N, Tw));
  Tw = normalize(cross(Bw, N));

  float NdotV = max(dot(N, V), 0.001);
  float NdotL = max(dot(N, L), 0.0);
  float NdotH = max(dot(N, H), 0.0);
  float LdotH = max(dot(L, H), 0.0);
  float TdotH = dot(Tw, H);
  float BdotH = dot(Bw, H);

  // ---- Schlick Fresnel (water IOR ≈ 1.333 → F0 ≈ 0.02)
  float F0 = 0.02;
  float fresnel = F0 + (1.0 - F0) * pow(1.0 - NdotV, 5.0);
  // Open ocean is reflection-heavy even mid-frame
  fresnel = clamp(fresnel * 1.45 + pow(1.0 - NdotV, 1.6) * 0.38, 0.05, 0.985);

  // ---- Volume / body (Beer-ish absorption, dark troughs)
  float peak = smoothstep(-2.0, 3.0, vPeak);
  float trough = 1.0 - peak;
  float facing = pow(NdotV, 0.85);
  // Depth proxy from slope + height
  float depthProxy = mix(1.0, 0.0, facing * 0.4 + peak * 0.35);
  depthProxy = clamp(depthProxy + trough * 0.55, 0.0, 1.0);
  float optical = (0.4 + depthProxy * 2.8) * (1.0 + uTurbidity * 0.4);
  // Wavelength absorption: red dies first → navy
  vec3 absorb = exp(-vec3(1.55, 0.32, 0.11) * optical * 4.0);
  vec3 scatter = mix(uDeepColor * 0.2, uShallowColor * 1.25, facing * 0.2 + peak * 0.3);
  vec3 body = scatter * absorb;

  // Crest SSS (light bleeds through thin peaks)
  float sss = pow(max(dot(V, -L + N * 0.6), 0.0), 2.2) * uSSSStrength;
  sss *= smoothstep(0.05, 0.65, N.y) * (0.15 + peak * 0.7);
  // Subtle caustic modulation in SSS
  float caust = atnoise(vWorldXZ * 0.25 - uTime * 0.08) * 0.5 + 0.5;
  body += vec3(0.015, 0.28, 0.24) * sss * (0.7 + 0.5 * caust) * 1.6;

  // ---- Environment reflection (shared atmosphere)
  vec3 R = reflect(-V, N);
  float horizonSoft = smoothstep(-0.12, 0.15, R.y);
  R = normalize(mix(vec3(R.x, abs(R.y) * 0.12, R.z), R, horizonSoft));
  // Slight blur of reflection with roughness via multi-lobe sample
  vec3 refl = atmosphereSky(R);
  vec3 R2 = normalize(R + Tw * 0.04 + Bw * 0.02);
  vec3 R3 = normalize(R - Tw * 0.03 + Bw * 0.04);
  refl = refl * 0.6 + atmosphereSky(R2) * 0.2 + atmosphereSky(R3) * 0.2;

  float distFade = 1.0 - exp(-camDist * 0.0005);
  vec3 horizonCol = atmosphereSky(normalize(vec3(V.x, 0.03, V.z)));
  refl = mix(refl, horizonCol, distFade * 0.5);

  // ---- Anisotropic sun specular (wind-aligned glitter streaks)
  float rough = mix(uRoughness * 0.55, uRoughness * 1.8, smoothstep(30.0, 350.0, camDist));
  float ax = max(rough * rough * 0.35, 0.0004); // sharp along wind
  float ay = max(rough * rough * 2.8, 0.002);   // wide across wind
  float D = ggxD_aniso(NdotH, TdotH, BdotH, ax, ay);
  float kG = (rough + 1.0);
  kG = kG * kG / 8.0;
  float G = schlickG1(NdotV, kG) * schlickG1(NdotL, kG);
  float Fspec = F0 + (1.0 - F0) * pow(1.0 - LdotH, 5.0);
  float spec = D * G * Fspec / (4.0 * NdotV * NdotL + 1e-4);
  spec = clamp(spec, 0.0, 20.0);

  // Sparse sun pins (photo sparkle — not carpet)
  float sparkMask = atnoise(vWorldXZ * 1.1 + floor(uTime * 2.0) * 0.17);
  float sparkle = pow(NdotH, 160.0) * smoothstep(0.62, 0.9, sparkMask) * 1.2;
  sparkle *= smoothstep(180.0, 25.0, camDist);

  // Oily silver bands on faces (slope-following, multi-frequency)
  float hf = heightField(vWorldXZ, uTime);
  float face = pow(max(1.0 - NdotV, 0.0), 0.85) * smoothstep(0.0, 0.9, N.y);
  float oil = smoothstep(-0.15, 0.55, hf) * smoothstep(0.9, 0.2, abs(hf));
  float ridge = smoothstep(0.15, 0.9, peak) * face;
  float silver = (oil * 0.55 + ridge * 0.5 + face * 0.25) * (0.55 + 0.45 * atnoise(vWorldXZ * 0.12));

  // Ambient sky light on body
  float skyAmb = 0.05 + 0.28 * max(N.y, 0.0);
  vec3 ambient = mix(uDeepColor * 0.8, uSkyHorizon * 0.18, 0.55) * skyAmb;

  // ---- Compose
  vec3 col = body * (0.1 + NdotL * 0.28 + wrapLight(N, L) * 0.12) + ambient;
  // Less Fresnel in troughs so navy shows
  float Fuse = fresnel * mix(0.72, 1.0, peak * 0.55 + 0.45);
  col = mix(col, refl, Fuse);
  // Silver = brightened sky reflection on faces
  col += silver * mix(uSkyHorizon, vec3(1.2, 1.25, 1.3), 0.55) * 0.95;
  col += uSunColor * (spec * 1.85 * NdotL + sparkle * 2.2);

  // ---- Foam (wake + whitecap), porous
  float trail = texture2D(uFoamTrail, fract(vWorldXZ / uFoamWorld)).r;
  float jacFoam = smoothstep(0.2, 0.9, 1.0 - vJacobian) * uSeaState;
  float crestFoam = smoothstep(1.4, 2.8, vPeak) * uSeaState * 0.7;
  float foam = max(max(vFoam * uSeaState, trail * uFoamStrength), max(jacFoam, crestFoam));
  float porosity = foamPattern(vWorldXZ, uTime);
  float foamMask = smoothstep(0.18, 0.8, foam) * mix(0.55, 1.0, porosity);
  // Calm sea: crush foam almost fully
  foamMask *= mix(0.15, 1.0, clamp(uSeaState * 1.4 + trail * 0.8, 0.0, 1.0));
  vec3 foamCol = mix(vec3(0.65, 0.75, 0.82), vec3(0.95, 0.97, 0.99), porosity);
  foamCol *= 0.5 + NdotL * 0.5 + skyAmb * 0.4;
  col = mix(col, foamCol, foamMask * 0.88);

  // ---- Aerial perspective + soft horizon
  vec3 fogCol = atmosphereSky(normalize(vec3(V.x, max(V.y * 0.08 + 0.04, 0.03), V.z)));
  float fog = 1.0 - exp(-camDist * 0.00026);
  fog = clamp(fog * 1.05, 0.0, 0.9);
  col = mix(col, fogCol, fog);

  vec3 viewN = normalize(vViewDir);
  float graze = pow(1.0 - clamp(viewN.y * 2.5 + 0.15, 0.0, 1.0), 1.5);
  float far = smoothstep(100.0, 650.0, camDist);
  col = mix(col, fogCol, clamp(graze * 0.42 + far * 0.38, 0.0, 0.88));

  if (uCameraY < 0.4) {
    float depth = clamp((0.4 - uCameraY) * 0.5, 0.0, 1.0);
    col = mix(col, uDeepColor * 0.4 + body * 0.25, depth);
  }

  col *= uExposure;
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
      uDirs: {
        value: Array.from({ length: WAVE_COUNT }, () => new THREE.Vector2(1, 0)),
      },
      uAmp: { value: new Array(WAVE_COUNT).fill(0) },
      uLambda: { value: new Array(WAVE_COUNT).fill(10) },
      uSteep: { value: new Array(WAVE_COUNT).fill(0.2) },
      uPhase: { value: new Array(WAVE_COUNT).fill(0) },
      uSpeed: { value: new Array(WAVE_COUNT).fill(1) },
      uFFTMap: { value: null },
      uFFTPatch: { value: 220 },
      uHeightMin: { value: -2 },
      uHeightRange: { value: 4 },
      uFFTScale: { value: 1 },
      uChopScale: { value: 0.38 },
      uSunDir: { value: new THREE.Vector3(0.35, 0.75, 0.25).normalize() },
      uSunColor: { value: new THREE.Color(1.0, 0.96, 0.88) },
      uSkyZenith: { value: new THREE.Color(0.35, 0.58, 0.88) },
      uSkyHorizon: { value: new THREE.Color(0.72, 0.82, 0.92) },
      uDeepColor: { value: new THREE.Color(0.002, 0.02, 0.055) },
      uShallowColor: { value: new THREE.Color(0.01, 0.12, 0.16) },
      uRoughness: { value: 0.06 },
      uExposure: { value: 1.0 },
      uCameraY: { value: 5 },
      uFoamTrail: { value: null },
      uFoamStrength: { value: 0.85 },
      uFoamWorld: { value: 480 },
      uTurbidity: { value: 0.22 },
      uSSSStrength: { value: 0.55 },
      uWindDir: { value: new THREE.Vector2(0.85, 0.53) },
      uSeaState: { value: 0.25 },
    },
    side: THREE.DoubleSide,
    depthWrite: true,
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
