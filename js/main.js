import * as THREE from "three";
import { createSkyMaterial, sunFromTimeOfDay } from "./sky.js";
import { Boat } from "./boat.js";
import { createPostStack } from "./post.js";
import { detectTier, tierReason, TIER_GPU } from "./ocean/capabilities.js";
import { OceanSimulation } from "./ocean/oceanSimulation.js";
import { OceanProbe } from "./ocean/oceanProbe.js";
import { createOceanMesh } from "./ocean/oceanMesh.js";
import {
  createOceanMaterial,
  bindSimulationTextures,
  updateOceanUniforms,
} from "./ocean/oceanMaterial.js";
import { extrapolate } from "./ocean/probeMath.js";
import { HybridSea } from "./ocean/hybridSea.js";

/**
 * Scene glue. Chooses an ocean tier once at startup and wires it to the boat,
 * camera, HUD and post stack.
 */

// Sea states. windSpeed and choppiness drive the spectrum; the rest are look.
const WEATHER = {
  calm: {
    label: "calm",
    // Long fetch plus high peak enhancement: energy concentrated in long,
    // regular swell rather than spread across a confused wind sea. That is what
    // the reference photo shows — broad glassy faces, almost no chop.
    // 250 km fetch puts the peak near a 7 s / 75 m swell — broad faces at the
    // scale the reference shows. 900 km gave 200 m waves: correct physics for a
    // fully developed sea, but far too tall to read as calm.
    windSpeed: 5.5,
    fetch: 250000,
    gamma: 6.0,
    choppiness: 0.5,
    turb: 0.12,
    foam: 0.08,
    roughness: 0.018,
    sss: 0.45,
    thickness: 3.8,
    // Legacy CPU-tier scalars, unused on the GPU tier.
    fft: 1.0,
    detail: 0.85,
  },
  moderate: {
    label: "moderate",
    windSpeed: 12,
    fetch: 200000,
    gamma: 3.3,
    choppiness: 1.15,
    turb: 0.18,
    foam: 0.55,
    roughness: 0.055,
    sss: 0.8,
    thickness: 3.0,
    fft: 1.0,
    detail: 1.0,
  },
  storm: {
    label: "storm",
    // Short fetch, broad spectrum: a steep confused sea rather than swell.
    windSpeed: 20,
    fetch: 60000,
    gamma: 2.0,
    choppiness: 1.4,
    turb: 0.4,
    foam: 1.0,
    roughness: 0.1,
    sss: 1.0,
    thickness: 2.4,
    fft: 1.65,
    detail: 1.5,
  },
};

const canvas = document.getElementById("c");
const renderer = new THREE.WebGLRenderer({
  canvas,
  antialias: true,
  powerPreference: "high-performance",
  stencil: false,
});
const isTouch = matchMedia("(pointer: coarse)").matches;
renderer.setPixelRatio(Math.min(devicePixelRatio, isTouch ? 1.5 : 2));
renderer.setSize(innerWidth, innerHeight, false);
// Linear working colour; the filmic grade in post writes display-referred.
renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
renderer.toneMapping = THREE.NoToneMapping;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
// Accumulate stats across every pass in a frame. With autoReset on, info only
// ever describes the last render call — which is the post stack's fullscreen
// quad, not the scene.
renderer.info.autoReset = false;

const tier = detectTier({ getContext: () => renderer.getContext() });
console.info(`[ocean] tier=${tier} — ${tierReason(tier)}`);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x6a9bc4);
scene.fog = null;

const camera = new THREE.PerspectiveCamera(48, innerWidth / innerHeight, 0.25, 30000);
camera.position.set(0, 3.2, 6);

// --- Persistent wake foam atlas (world XZ) ---
const FOAM_RES = 512;
const FOAM_WORLD = 480;
const foamData = new Uint8Array(FOAM_RES * FOAM_RES * 4);
const foamTex = new THREE.DataTexture(foamData, FOAM_RES, FOAM_RES, THREE.RGBAFormat);
foamTex.wrapS = foamTex.wrapT = THREE.RepeatWrapping;
foamTex.magFilter = THREE.LinearFilter;
foamTex.minFilter = THREE.LinearMipmapLinearFilter;
foamTex.generateMipmaps = true;
foamTex.colorSpace = THREE.NoColorSpace;
foamTex.needsUpdate = true;

// --- Ocean ---
let sim = null;
let probe = null;
let sea = null;
let oceanMat = null;
let oceanMesh = null;
let cpuFallback = null;

if (tier === TIER_GPU) {
  sim = new OceanSimulation(renderer, {
    windSpeed: WEATHER.calm.windSpeed,
    choppiness: WEATHER.calm.choppiness,
    fetch: WEATHER.calm.fetch,
    gamma: WEATHER.calm.gamma,
    windDir: [0.85, 0.53],
    seed: 0x0ce4a,
  });
  probe = new OceanProbe(renderer, sim);
  // Buoyancy needs a latency floor the async probe cannot promise on its own.
  sea = new HybridSea(probe, {
    windSpeed: WEATHER.calm.windSpeed,
    windDir: [0.85, 0.53],
    fetch: WEATHER.calm.fetch,
    gamma: WEATHER.calm.gamma,
    choppiness: WEATHER.calm.choppiness,
    seed: 0x0ce4a,
  });

  oceanMat = createOceanMaterial(sim);
  oceanMat.uniforms.uFoamTrail.value = foamTex;
  oceanMat.uniforms.uFoamWorld.value = FOAM_WORLD;
  bindSimulationTextures(oceanMat, sim);

  oceanMesh = createOceanMesh(THREE, oceanMat, {
    rings: isTouch ? 160 : 256,
    segments: isTouch ? 160 : 256,
    innerRadius: 0.25,
    outerRadius: 20000,
  });
  scene.add(oceanMesh);
} else {
  // CPU tier: the previous implementation, unchanged.
  const [{ FFTOcean }, { createOceanMaterial: createCpuMaterial, applyDetailWaves }, gerstner, adapter] =
    await Promise.all([
      import("./ocean/fallback/cpuOcean.js"),
      import("./ocean/fallback/cpuOceanMaterial.js"),
      import("./ocean/fallback/cpuGerstner.js"),
      import("./ocean/fallback/cpuSeaAdapter.js"),
    ]);
  const { FFT_N } = await import("./ocean/fallback/cpuOcean.js");

  const fft = new FFTOcean({ patchSize: 340, windSpeed: 10, A: 0.00028, choppiness: 0.95 });
  const fftData = new Uint8Array(FFT_N * FFT_N * 4);
  const fftTex = new THREE.DataTexture(fftData, FFT_N, FFT_N, THREE.RGBAFormat);
  fftTex.wrapS = fftTex.wrapT = THREE.RepeatWrapping;
  fftTex.colorSpace = THREE.NoColorSpace;
  fftTex.needsUpdate = true;

  oceanMat = createCpuMaterial();
  oceanMat.uniforms.uFFTMap.value = fftTex;
  oceanMat.uniforms.uFoamTrail.value = foamTex;
  oceanMat.uniforms.uFFTPatch.value = fft.patch;
  oceanMat.uniforms.uFoamWorld.value = FOAM_WORLD;

  const geo = new THREE.PlaneGeometry(960, 960, isTouch ? 420 : 640, isTouch ? 420 : 640);
  geo.rotateX(-Math.PI / 2);
  oceanMesh = new THREE.Mesh(geo, oceanMat);
  oceanMesh.frustumCulled = false;
  scene.add(oceanMesh);

  sea = new adapter.CpuSeaAdapter(fft);
  cpuFallback = { fft, fftData, fftTex, applyDetailWaves, gerstner, frame: 0 };
  fft.update(0);
  fft.fillTextureData(fftData);
  fftTex.needsUpdate = true;
}

// --- Sky ---
const skyMat = createSkyMaterial();
const sky = new THREE.Mesh(new THREE.SphereGeometry(25000, 64, 40), skyMat);
sky.frustumCulled = false;
scene.add(sky);

// --- Lights ---
// These light only the boat and islands; the ocean has its own shader and
// ignores them entirely, so they can be raised for hull readability without
// touching the water. Criterion 7 in ref/GOAL.md: the boat must not read black.
const amb = new THREE.AmbientLight(0xb0c4de, 0.9);
scene.add(amb);
const hemi = new THREE.HemisphereLight(0xc5ddf5, 0x2a4055, 1.15);
scene.add(hemi);
const sunLight = new THREE.DirectionalLight(0xfff5e6, 2.4);
sunLight.castShadow = true;
sunLight.shadow.mapSize.set(2048, 2048);
sunLight.shadow.camera.near = 1;
sunLight.shadow.camera.far = 600;
sunLight.shadow.camera.left = -80;
sunLight.shadow.camera.right = 80;
sunLight.shadow.camera.top = 80;
sunLight.shadow.camera.bottom = -80;
sunLight.shadow.bias = -0.00015;
scene.add(sunLight);
scene.add(sunLight.target);

// --- Islands ---
const islandGroups = [];
function addIsland(x, z, s, h, rot) {
  const rock = new THREE.MeshStandardMaterial({ color: 0x3d4148, roughness: 0.94, metalness: 0.05 });
  const grass = new THREE.MeshStandardMaterial({ color: 0x2a4a34, roughness: 0.96 });
  const sand = new THREE.MeshStandardMaterial({ color: 0xc2b28a, roughness: 0.98 });
  const g = new THREE.Group();
  g.position.set(x, -1.5, z);
  g.rotation.y = rot;

  const body = new THREE.Mesh(new THREE.IcosahedronGeometry(s, 2), rock);
  body.position.y = h * 0.28;
  body.scale.set(1.05, h / s, 1.2);
  body.castShadow = true;
  body.receiveShadow = true;
  g.add(body);

  const shore = new THREE.Mesh(new THREE.CylinderGeometry(s * 1.15, s * 1.35, 2.2, 16), sand);
  shore.position.y = 0.2;
  shore.receiveShadow = true;
  g.add(shore);

  const cap = new THREE.Mesh(new THREE.SphereGeometry(s * 0.6, 12, 8), grass);
  cap.position.y = h * 0.58;
  cap.scale.set(0.85, 0.28, 0.85);
  cap.castShadow = true;
  g.add(cap);

  scene.add(g);
  islandGroups.push(g);
}
addIsland(900, -1200, 40, 30, 0.4);
addIsland(-1100, 900, 48, 36, 1.2);
addIsland(1400, 800, 32, 24, 2.1);

const boat = new Boat(scene);
boat.group.visible = false;

const post = createPostStack(renderer, scene, camera);

// --- State ---
let playing = false;
let weather = "calm";
let timeOfDay = 0.42;
let simTime = 0;
let lastBoat = { x: 0, z: 0 };
/** When set, updateCamera leaves the camera where boatPlate() put it. */
let boatPlateLock = false;

const keys = new Set();
const touch = { steer: 0, throttle: 0 };

function setWeather(w) {
  weather = w;
  const cfg = WEATHER[w];
  if (sim) {
    const state = {
      windSpeed: cfg.windSpeed,
      choppiness: cfg.choppiness,
      fetch: cfg.fetch,
      gamma: cfg.gamma,
    };
    sim.setSeaState(state);
    sea.setSeaState(state);
  } else if (cpuFallback) {
    cpuFallback.fft.setSeaScale(cfg.fft);
    sea.detailScale = cfg.detail;
    sea.fftScale = cfg.fft;
  }
  document.getElementById("wxLabel").textContent = cfg.label;
  document.querySelectorAll("#wxSeg button").forEach((b) => {
    b.classList.toggle("on", b.dataset.w === w);
  });
}
setWeather("calm");

// --- Input ---
window.addEventListener("keydown", (e) => {
  keys.add(e.code);
  if (["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Space"].includes(e.code)) {
    e.preventDefault();
  }
});
window.addEventListener("keyup", (e) => keys.delete(e.code));
window.addEventListener("blur", () => keys.clear());

function readInput() {
  let steer = 0;
  let throttle = 0;
  if (keys.has("KeyA") || keys.has("ArrowLeft")) steer += 1;
  if (keys.has("KeyD") || keys.has("ArrowRight")) steer -= 1;
  if (keys.has("KeyW") || keys.has("ArrowUp")) throttle += 1;
  if (keys.has("KeyS") || keys.has("ArrowDown")) throttle -= 1;
  if (Math.abs(touch.steer) > 0.05) steer = touch.steer;
  if (Math.abs(touch.throttle) > 0.05) throttle = touch.throttle;
  return { steer, throttle };
}

function bindStick(el, horizontal) {
  let pid = null;
  const apply = (e) => {
    const r = el.getBoundingClientRect();
    const dx = (e.clientX - (r.left + r.width / 2)) / (r.width * 0.45);
    const dy = (e.clientY - (r.top + r.height / 2)) / (r.height * 0.45);
    if (horizontal) touch.steer = Math.max(-1, Math.min(1, -dx));
    else touch.throttle = Math.max(-1, Math.min(1, -dy));
  };
  el.addEventListener("pointerdown", (e) => {
    pid = e.pointerId;
    el.setPointerCapture(pid);
    apply(e);
  });
  el.addEventListener("pointermove", (e) => {
    if (pid !== null && e.pointerId === pid) apply(e);
  });
  const end = (e) => {
    if (pid !== null && e.pointerId === pid) {
      pid = null;
      if (horizontal) touch.steer = 0;
      else touch.throttle = 0;
    }
  };
  el.addEventListener("pointerup", end);
  el.addEventListener("pointercancel", end);
}
bindStick(document.getElementById("stickSteer"), true);
bindStick(document.getElementById("stickThrottle"), false);

document.getElementById("btnLaunch").onclick = () => {
  playing = true;
  boat.group.visible = true;
  document.getElementById("title").classList.add("hidden");
  document.getElementById("foot").classList.toggle("hidden", isTouch);
  document.getElementById("touch").classList.toggle("hidden", !isTouch);
};
document.getElementById("btnSettings").onclick = () => {
  document.getElementById("settings").classList.toggle("open");
};
document.getElementById("tod").oninput = (e) => {
  timeOfDay = Number(e.target.value);
  const h = Math.floor(timeOfDay * 24);
  const m = Math.floor((timeOfDay * 24 - h) * 60);
  document.getElementById("todLabel").textContent =
    `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
};
document.querySelectorAll("#wxSeg button").forEach((b) => {
  b.onclick = () => setWeather(b.dataset.w);
});

// --- Camera ---
const camSmooth = { x: 0, y: 3.2, z: 6, init: false };
/**
 * Probe slot reserved for the camera. Slots 0-6 belong to the boat's hull
 * points; 7 lets the camera ask the same question the boat does.
 */
const CAMERA_PROBE_SLOT = 7;
/** Never let the camera get closer than this to the surface. */
const CAMERA_WATER_CLEARANCE = 1.6;

/**
 * Keeps the camera above the water.
 *
 * Without this a passing crest simply engulfs it: the shot fills with the
 * underside of a wave and the boat disappears behind a wall of water.
 */
function liftCameraAboveWater() {
  if (!sea || !sea.sampleAt) return;
  const s = sea.sampleAt(CAMERA_PROBE_SLOT, camera.position.x, camera.position.z);
  if (!Number.isFinite(s.y)) return;
  const floor = s.y + CAMERA_WATER_CLEARANCE;
  if (camera.position.y < floor) camera.position.y = floor;
}

function updateCamera(dt) {
  if (boatPlateLock) {
    liftCameraAboveWater();
    return;
  }
  const fx = -Math.sin(boat.yaw);
  const fz = -Math.cos(boat.yaw);
  if (!playing) {
    const t = simTime;
    const tx = Math.sin(t * 0.035) * 8;
    const tz = 4 + Math.cos(t * 0.028) * 6;
    const ty = 3.4 + Math.sin(t * 0.07) * 0.35;
    camera.position.lerp(new THREE.Vector3(tx, ty, tz), 1 - Math.exp(-1.1 * dt));
    camera.lookAt(camera.position.x + Math.sin(t * 0.02) * 4, 0.4, camera.position.z - 80);
    liftCameraAboveWater();
    camSmooth.init = false;
    return;
  }
  if (!camSmooth.init) {
    camSmooth.x = boat.x - fx * 12;
    camSmooth.y = boat.y + 3.8;
    camSmooth.z = boat.z - fz * 12;
    camSmooth.init = true;
  }
  const follow = 13.5 + Math.abs(boat.speed) * 0.12;
  const height = 5.2 + Math.abs(boat.speed) * 0.04;
  const a = 1 - Math.exp(-5.2 * dt);
  camSmooth.x += (boat.x - fx * follow - camSmooth.x) * a;
  camSmooth.y += (boat.y + height - camSmooth.y) * a;
  camSmooth.z += (boat.z - fz * follow - camSmooth.z) * a;
  camera.position.set(camSmooth.x, camSmooth.y, camSmooth.z);
  camera.lookAt(boat.x + fx * 6, boat.y + 1.4, boat.z + fz * 6);
  liftCameraAboveWater();
}

// --- Wake foam ---
function stampFoam(x, z, amount, yaw) {
  if (amount < 0.04) return;
  const u = ((x / FOAM_WORLD) % 1 + 1) % 1;
  const v = ((z / FOAM_WORLD) % 1 + 1) % 1;
  const cx = (u * FOAM_RES) | 0;
  const cy = (v * FOAM_RES) | 0;
  const fx = -Math.sin(yaw);
  const fz = -Math.cos(yaw);
  const rx = Math.cos(yaw);
  const rz = -Math.sin(yaw);
  const radius = 2 + ((amount * 4) | 0);
  const add = (amount * 100) | 0;
  for (let along = -radius * 3; along <= radius; along++) {
    for (let lat = -radius; lat <= radius; lat++) {
      const behind = Math.max(0, -along);
      const fall = 1 - Math.min(1, (lat * lat) / (radius * radius * 1.1) + behind * 0.035);
      if (fall <= 0) continue;
      const half = 0.6 + behind * 0.45;
      const arm = Math.abs(Math.abs(lat) - half);
      const vMask = Math.max(0.12, 1 - arm * 0.55) * (behind > 0 || along >= 0 ? 1 : 0.3);
      const wx = Math.round(rx * lat + fx * along);
      const wz = Math.round(rz * lat + fz * along);
      const px = (cx + wx + FOAM_RES) % FOAM_RES;
      const py = (cy + wz + FOAM_RES) % FOAM_RES;
      const i = (py * FOAM_RES + px) * 4;
      const a = (add * fall * vMask) | 0;
      if (a < 1) continue;
      foamData[i] = Math.min(255, foamData[i] + a);
      foamData[i + 1] = foamData[i];
      foamData[i + 2] = foamData[i];
      foamData[i + 3] = 255;
    }
  }
  foamTex.needsUpdate = true;
}

function decayFoam() {
  for (let i = 0; i < foamData.length; i += 4) {
    if (foamData[i] > 0) {
      const d = foamData[i] > 40 ? 2 : 1;
      foamData[i] = Math.max(0, foamData[i] - d);
      foamData[i + 1] = foamData[i];
      foamData[i + 2] = foamData[i];
    }
  }
  foamTex.needsUpdate = true;
}

window.addEventListener("resize", () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight, false);
  post.setSize(innerWidth, innerHeight);
  post.setPixelRatio(renderer.getPixelRatio());
});

// --- Frame ---
let last = performance.now();
let foamDecayAcc = 0;
let frameMs = 16;

function frame(now) {
  renderer.info.reset();
  const dt = Math.min((now - last) / 1000, 0.1);
  frameMs += ((now - last) - frameMs) * 0.05;
  last = now;
  simTime += dt;

  const cfg = WEATHER[weather];
  const sun = sunFromTimeOfDay(timeOfDay);

  if (sim) {
    sim.update(simTime, dt);
    sea.update(simTime);
    bindSimulationTextures(oceanMat, sim);
    updateOceanUniforms(oceanMat, {
      time: simTime,
      sun,
      weather: cfg,
      cameraY: camera.position.y,
      skyExposure: sun.exposure * 1.25,
    });
  } else {
    const f = cpuFallback;
    f.frame++;
    if (f.frame % (isTouch ? 3 : 2) === 0) {
      f.fft.update(simTime);
      f.fft.fillTextureData(f.fftData);
      f.fftTex.needsUpdate = true;
    }
    sea.setTime(simTime);
    const u = oceanMat.uniforms;
    u.uTime.value = simTime;
    u.uFFTScale.value = cfg.fft;
    u.uHeightMin.value = f.fft.heightMin;
    u.uHeightRange.value = f.fft.heightRange;
    u.uSunDir.value.copy(sun.dir);
    u.uSunColor.value.copy(sun.sunColor);
    u.uSkyZenith.value.copy(sun.zenith);
    u.uSkyHorizon.value.copy(sun.horizon);
    u.uDeepColor.value.copy(sun.deep);
    u.uShallowColor.value.copy(sun.shallow);
    u.uCameraY.value = camera.position.y;
    u.uTurbidity.value = cfg.turb;
    u.uSeaState.value = cfg.foam;
    f.applyDetailWaves(oceanMat, f.gerstner.packDetailWaves(cfg.detail));
  }

  skyMat.uniforms.uSunDir.value.copy(sun.dir);
  skyMat.uniforms.uSunColor.value.copy(sun.sunColor);
  skyMat.uniforms.uSkyZenith.value.copy(sun.zenith);
  skyMat.uniforms.uSkyHorizon.value.copy(sun.horizon);
  skyMat.uniforms.uExposure.value = sun.exposure * 1.25;
  skyMat.uniforms.uTime.value = simTime;
  skyMat.uniforms.uTurbidity.value = cfg.turb;
  scene.background.copy(sun.horizon);

  sunLight.position.copy(sun.dir).multiplyScalar(250);
  sunLight.target.position.set(boat.x, 0, boat.z);
  sunLight.target.updateMatrixWorld();
  sunLight.color.copy(sun.sunColor);
  sunLight.intensity = THREE.MathUtils.clamp(sun.dir.y * 2.8 + 0.25, 0.2, 3.0);
  amb.intensity = THREE.MathUtils.lerp(0.3, 0.95, THREE.MathUtils.smoothstep(sun.dir.y, -0.1, 0.5));
  hemi.intensity = THREE.MathUtils.lerp(
    0.5,
    1.2,
    THREE.MathUtils.smoothstep(sun.dir.y, -0.05, 0.45),
  );

  const input = readInput();
  const wake = boat.update(sea, simTime, input, playing, dt);
  if (playing && wake) stampFoam(wake.x, wake.z, wake.foam, wake.yaw);

  if (probe) {
    // Probe positions are submitted extrapolated forward by the measured
    // readback latency, so results arrive correct for the present rather than
    // describing where the boat used to be.
    const vx = (boat.x - lastBoat.x) / Math.max(dt, 1e-4);
    const vz = (boat.z - lastBoat.z) / Math.max(dt, 1e-4);
    // Clamp before extrapolating. A pathological readback (software rendering,
    // a wedged driver) reports latency in seconds, which would fling probe
    // positions hundreds of metres from the hull.
    const probeLatency = Math.min(probe.latency, 0.1);
    for (let i = 0; i < probe.pendingCount; i++) {
      const [ex, ez] = extrapolate(
        [probe.pending[i * 2], probe.pending[i * 2 + 1]],
        [vx, vz],
        probeLatency,
      );
      probe.pending[i * 2] = ex;
      probe.pending[i * 2 + 1] = ez;
    }
    probe.commitPositions();
    probe.submit();
  }
  lastBoat.x = boat.x;
  lastBoat.z = boat.z;

  foamDecayAcc += dt;
  if (foamDecayAcc > 0.07) {
    foamDecayAcc = 0;
    decayFoam();
  }

  // Ocean follows the camera. The ring disc is world-sampled, so this needs no
  // snapping — the old OCEAN_SNAP workaround is gone.
  const followX = playing ? boat.x : camera.position.x;
  const followZ = playing ? boat.z : camera.position.z;
  oceanMesh.position.set(followX, 0, followZ);
  sky.position.set(camera.position.x, 0, camera.position.z);

  updateCamera(dt);

  post.setExposure(
    THREE.MathUtils.lerp(0.88, 1.08, THREE.MathUtils.smoothstep(sun.dir.y, -0.1, 0.4)),
  );
  post.bloom.strength = weather === "storm" ? 0.22 : 0.16;
  post.bloom.threshold = weather === "calm" ? 0.86 : 0.82;
  post.bloom.radius = 0.35;

  document.getElementById("spd").textContent = (Math.abs(boat.speed) * 0.22).toFixed(0);
  document.getElementById("hdg").textContent = (
    (((boat.yaw * 180) / Math.PI) % 360 + 360) %
    360
  ).toFixed(0);

  post.render();
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

// --- Test and look-dev hooks ---
window.__controlsTest = {
  getYaw: () => boat.yaw,
  getSpeed: () => boat.speed,
  setKeys: (codes) => {
    keys.clear();
    for (const c of codes) keys.add(c);
  },
};
window.__oceanSim = {
  getTime: () => simTime,
  getBoat: () => ({ x: boat.x, y: boat.y, z: boat.z, yaw: boat.yaw, speed: boat.speed }),
  getTier: () => tier,
  getProbe: () => probe,
};

window.__lookdev = {
  ready: () => simTime > 0.5,
  tier: () => tier,
  getStats: () => ({
    tier,
    fps: 1000 / Math.max(frameMs, 0.001),
    frameMs,
    drawCalls: renderer.info.render.calls,
    triangles: renderer.info.render.triangles,
    probeLatency: probe ? probe.latency : 0,
    buoyancySource: sea && sea.source ? sea.source : "cpu-tier",
    boatY: boat.y,
  }),
  hideHud: () => document.querySelector(".hud")?.classList.add("hidden"),
  showHud: () => document.querySelector(".hud")?.classList.remove("hidden"),
  setWeather: (w) => setWeather(w),
  setTod: (t) => {
    timeOfDay = t;
    const el = document.getElementById("tod");
    if (el) el.value = String(t);
  },
  /** Per-frame trace of the buoyancy integrator's own state. */
  buoyancyTrace: async (frames = 8) => {
    const out = [];
    for (let i = 0; i < frames; i++) {
      await new Promise((r) => requestAnimationFrame(r));
      out.push({
        meanY: Number(boat.debugMeanY?.toFixed(3)),
        targetY: Number(boat.debugTargetY?.toFixed(3)),
        y: Number(boat.y.toFixed(3)),
        vy: Number(boat.vy.toFixed(3)),
        dt: Number(boat.debugDt?.toFixed(4)),
        samples: boat.debugSampleY?.map((v) => Number(v.toFixed(2))),
      });
    }
    return out;
  },

  /**
   * Is the boat actually riding the waves?
   *
   * Samples over `frames` frames, comparing the hull's height against a
   * zero-latency synchronous read of the surface beneath it. Returns the RMS
   * and peak error in metres, plus the surface's own range over the window —
   * error small relative to that range means the boat is tracking; error
   * comparable to it means it is not.
   */
  buoyancyCheck: async (frames = 90) => {
    if (!sea || !sea.trueSample) {
      return { tier, note: "CPU tier samples the surface directly — no latency" };
    }
    const samples = [];
    for (let i = 0; i < frames; i++) {
      await new Promise((r) => requestAnimationFrame(r));
      // Ground truth must be the surface the boat is ACTUALLY riding. When the
      // probe is driving, comparing against the CPU mirror measures the phase
      // difference between two different seas, not the boat's tracking error.
      const ridden =
        sea.source === "probe" && sea.probe
          // Slot 4 is the centreline point (x=0, z=0). Slot 0 is the bow, 2.6 m
          // forward, whose surface height differs from the hull origin's by the
          // pitch of the wave — comparing against it reports a constant bias
          // that has nothing to do with buoyancy.
          ? sea.probe.sample(4).y
          : sea.trueSample(boat.x, boat.z).y;
      const hullY = boat.y;
      samples.push({ trueY: ridden, hullY, err: hullY - ridden });
    }
    const errs = samples.map((s) => s.err);
    const trues = samples.map((s) => s.trueY);
    const rms = Math.sqrt(errs.reduce((a, e) => a + e * e, 0) / errs.length);
    return {
      tier,
      frames,
      latencyMs: Number((sea.latency * 1000).toFixed(1)),
      source: sea.source,
      // Latency turns into position error through the wave's own motion:
      // a swell of period T and amplitude A is displaced by roughly
      // A * sin(2*pi*latency/T) over the readback delay.
      latencyPhaseErrorM: (() => {
        const amplitude = (Math.max(...trues) - Math.min(...trues)) / 2;
        const period = 7.0; // calm preset peak period, seconds
        return Number((amplitude * Math.sin((2 * Math.PI * sea.latency) / period)).toFixed(3));
      })(),
      surfaceRange: Number((Math.max(...trues) - Math.min(...trues)).toFixed(3)),
      rmsErrorM: Number(rms.toFixed(3)),
      peakErrorM: Number(Math.max(...errs.map(Math.abs)).toFixed(3)),
      meanErrorM: Number((errs.reduce((a, e) => a + e, 0) / errs.length).toFixed(3)),
    };
  },

  /**
   * Renders an intermediate shading term instead of water.
   * 0 off, 1 roughness, 2 slope variance, 3 normals, 4 foam, 5 wave height,
   * 6 camera distance. A GPU FFT cannot be stepped through in a debugger, so
   * this is the only way to inspect it.
   */
  debugCascade: (mode = 0) => {
    if (!oceanMat.uniforms.uDebugMode) return "debug views are GPU-tier only";
    oceanMat.uniforms.uDebugMode.value = mode;
    return mode;
  },
  titlePlate: () => {
    playing = false;
    boat.group.visible = false;
    for (const g of islandGroups) g.visible = false;
    document.getElementById("title")?.classList.add("hidden");
    document.getElementById("foot")?.classList.add("hidden");
    document.getElementById("touch")?.classList.add("hidden");
    document.getElementById("settings")?.classList.remove("open");
    setWeather("calm");
    timeOfDay = 0.42;
    camera.position.set(1.5, 2.4, 4.5);
    camera.lookAt(0.5, -0.1, -45);
    camSmooth.init = false;
  },
  playPlate: () => {
    playing = true;
    boat.group.visible = true;
    for (const g of islandGroups) g.visible = true;
    boat.x = 0;
    boat.z = 0;
    boat.yaw = 0;
    boat.speed = 0;
    boat.resetHeave();
    document.getElementById("title")?.classList.add("hidden");
    camSmooth.init = false;
  },
  /**
   * Three-quarter hero view of the boat. The follow camera sits dead astern,
   * where a hull reads as a flat transom and nothing about its shape is
   * legible — useless for judging the model.
   */
  boatPlate: () => {
    playing = false;
    boat.group.visible = true;
    for (const g of islandGroups) g.visible = false;
    boat.x = 0;
    boat.z = 0;
    boat.yaw = 0.5;
    boat.speed = 0;
    boat.resetHeave();
    document.getElementById("title")?.classList.add("hidden");
    // High enough to clear the swell in front of the boat — at deck height the
    // nearest crest simply occludes the hull.
    camera.position.set(-8.4, 5.4, -9.0);
    camera.lookAt(0, 1.1, 0);
    camSmooth.init = false;
    boatPlateLock = true;
  },
};
