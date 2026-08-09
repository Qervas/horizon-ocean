import * as THREE from "three";
import { FFTOcean, FFT_N } from "./fftOcean.js";
import { packDetailWaves } from "./gerstner.js";
import { createOceanMaterial, applyDetailWaves } from "./oceanMaterial.js";
import { createSkyMaterial, sunFromTimeOfDay } from "./sky.js";
import { Boat } from "./boat.js";
import { createPostStack } from "./post.js";

// Sea scales — calm needs visible long swell (photo has form, not glass flat)
const WEATHER = {
  calm: { fft: 1.0, detail: 0.85, label: "calm", turb: 0.1, sea: 0.05 },
  moderate: { fft: 1.0, detail: 1.0, label: "moderate", turb: 0.3, sea: 0.45 },
  storm: { fft: 1.65, detail: 1.5, label: "storm", turb: 0.72, sea: 1.0 },
};

const canvas = document.getElementById("c");
const renderer = new THREE.WebGLRenderer({
  canvas,
  antialias: true,
  powerPreference: "high-performance",
  stencil: false,
});
const maxPR = matchMedia("(pointer: coarse)").matches ? 1.5 : 2;
renderer.setPixelRatio(Math.min(devicePixelRatio, maxPR));
renderer.setSize(innerWidth, innerHeight, false);
// Linear working color; filmic grade in post writes display-referred result
renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
renderer.toneMapping = THREE.NoToneMapping;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;

const scene = new THREE.Scene();
// Background only shows if sky fails; match horizon
scene.background = new THREE.Color(0x6a9bc4);
scene.fog = null;

// Slightly longer FOV than games — closer to photo plate
const camera = new THREE.PerspectiveCamera(48, innerWidth / innerHeight, 0.25, 12000);
camera.position.set(0, 3.2, 6);

// --- FFT ocean (128²) ---
const fft = new FFTOcean({
  // Larger patch = less obvious tile crawl while moving
  patchSize: 340,
  windSpeed: 10,
  A: 0.00028,
  choppiness: 0.95,
  seed: 0x0ce4a,
});
const fftData = new Uint8Array(FFT_N * FFT_N * 4);
const fftTex = new THREE.DataTexture(fftData, FFT_N, FFT_N, THREE.RGBAFormat);
fftTex.wrapS = fftTex.wrapT = THREE.RepeatWrapping;
fftTex.magFilter = THREE.LinearFilter;
fftTex.minFilter = THREE.LinearFilter;
fftTex.colorSpace = THREE.NoColorSpace;
fftTex.needsUpdate = true;

// Persistent foam trail atlas (world XZ)
const FOAM_RES = 512;
const foamData = new Uint8Array(FOAM_RES * FOAM_RES * 4);
const foamTex = new THREE.DataTexture(foamData, FOAM_RES, FOAM_RES, THREE.RGBAFormat);
foamTex.wrapS = foamTex.wrapT = THREE.RepeatWrapping;
foamTex.magFilter = THREE.LinearFilter;
foamTex.minFilter = THREE.LinearMipmapLinearFilter;
foamTex.generateMipmaps = true;
foamTex.colorSpace = THREE.NoColorSpace;
foamTex.needsUpdate = true;
const FOAM_WORLD = 480;

// Single ocean mesh only — dual near/far caused z-fight facets + crawl glitches
const oceanMat = createOceanMaterial();
oceanMat.uniforms.uFFTMap.value = fftTex;
oceanMat.uniforms.uFoamTrail.value = foamTex;
oceanMat.uniforms.uFFTPatch.value = fft.patch;
oceanMat.uniforms.uFoamWorld.value = FOAM_WORLD;
oceanMat.uniforms.uChopScale.value = 0.38;

const isTouchDevice = matchMedia("(pointer: coarse)").matches;
// Dense single mesh: ~1.1–1.3 m/cell near field kills diamond facets
const OCEAN_SIZE = isTouchDevice ? 720 : 960;
const OCEAN_SEG = isTouchDevice ? 420 : 640;
const oceanGeo = new THREE.PlaneGeometry(OCEAN_SIZE, OCEAN_SIZE, OCEAN_SEG, OCEAN_SEG);
oceanGeo.rotateX(-Math.PI / 2);
const oceanMesh = new THREE.Mesh(oceanGeo, oceanMat);
oceanMesh.frustumCulled = false;
scene.add(oceanMesh);

// Snap ocean center in steps so UV/world samples don't micro-swim every frame
const OCEAN_SNAP = 16;

// Sky
const skyMat = createSkyMaterial();
const sky = new THREE.Mesh(new THREE.SphereGeometry(8000, 64, 40), skyMat);
sky.frustumCulled = false;
scene.add(sky);

// Lights — brighter for MeshStandard boat (was crushing to black)
const amb = new THREE.AmbientLight(0xb0c4de, 0.55);
scene.add(amb);
const hemi = new THREE.HemisphereLight(0xc5ddf5, 0x1a3040, 0.75);
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

// Islands — smoother rock/vegetation for scale
function addIsland(x, z, s, h, rot) {
  const rock = new THREE.MeshStandardMaterial({
    color: 0x3d4148,
    roughness: 0.94,
    metalness: 0.05,
    flatShading: false,
  });
  const grass = new THREE.MeshStandardMaterial({
    color: 0x2a4a34,
    roughness: 0.96,
    metalness: 0.0,
  });
  const sand = new THREE.MeshStandardMaterial({
    color: 0xc2b28a,
    roughness: 0.98,
  });
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
}
// Far islands (hidden on title look-dev plate so plate matches open-ocean ref)
const islandGroups = [];
function addIslandTracked(x, z, s, h, rot) {
  const before = scene.children.length;
  addIsland(x, z, s, h, rot);
  for (let i = before; i < scene.children.length; i++) {
    islandGroups.push(scene.children[i]);
  }
}
addIslandTracked(900, -1200, 40, 30, 0.4);
addIslandTracked(-1100, 900, 48, 36, 1.2);
addIslandTracked(1400, 800, 32, 24, 2.1);

const boat = new Boat(scene);
// Hidden until Launch so title matches pure-ocean photo ref
boat.group.visible = false;

// Post stack
const post = createPostStack(renderer, scene, camera);

// --- State ---
let playing = false;
let weather = "calm";
let timeOfDay = 0.42; // midday — matches photo ref
let simTime = 0;
let fftFrame = 0;

const keys = new Set();
const touch = { steer: 0, throttle: 0 };

const seaAPI = {
  sampleFFT: (x, z) => fft.sample(x, z),
  detailScale: WEATHER.calm.detail,
  fftScale: WEATHER.calm.fft,
};

function setWeather(w) {
  weather = w;
  const cfg = WEATHER[w];
  fft.setSeaScale(cfg.fft);
  seaAPI.detailScale = cfg.detail;
  seaAPI.fftScale = cfg.fft;
  document.getElementById("wxLabel").textContent = cfg.label;
  document.querySelectorAll("#wxSeg button").forEach((b) => {
    b.classList.toggle("on", b.dataset.w === w);
  });
}
setWeather("calm");

// --- Input ---
window.addEventListener("keydown", (e) => {
  keys.add(e.code);
  if (["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Space"].includes(e.code))
    e.preventDefault();
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

const isTouch = matchMedia("(pointer: coarse)").matches;

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

// Camera — title plate matches photo: low over water, looking to soft horizon
const camSmooth = { x: 0, y: 3.2, z: 6, init: false };
function updateCamera(dt) {
  const fx = -Math.sin(boat.yaw);
  const fz = -Math.cos(boat.yaw);
  if (!playing) {
    const t = simTime;
    // Slow drift over open water; gaze toward horizon (not a boat orbit)
    const tx = Math.sin(t * 0.035) * 8;
    const tz = 4 + Math.cos(t * 0.028) * 6;
    const ty = 2.6 + Math.sin(t * 0.07) * 0.35;
    camera.position.lerp(new THREE.Vector3(tx, ty, tz), 1 - Math.exp(-1.1 * dt));
    // Look far to horizon band
    const lookX = camera.position.x + Math.sin(t * 0.02) * 4;
    const lookZ = camera.position.z - 80;
    camera.lookAt(lookX, 0.4, lookZ);
    camSmooth.init = false;
    return;
  }
  if (!camSmooth.init) {
    camSmooth.x = boat.x - fx * 12;
    camSmooth.y = boat.y + 3.8;
    camSmooth.z = boat.z - fz * 12;
    camSmooth.init = true;
  }
  const follow = 10.5 + Math.abs(boat.speed) * 0.1;
  const height = 3.0 + Math.abs(boat.speed) * 0.035;
  const dx = boat.x - fx * follow;
  const dy = boat.y + height;
  const dz = boat.z - fz * follow;
  const a = 1 - Math.exp(-5.2 * dt);
  camSmooth.x += (dx - camSmooth.x) * a;
  camSmooth.y += (dy - camSmooth.y) * a;
  camSmooth.z += (dz - camSmooth.z) * a;
  camera.position.set(camSmooth.x, camSmooth.y, camSmooth.z);
  camera.lookAt(boat.x + fx * 6, boat.y + 0.9, boat.z + fz * 6);
}

function stampFoam(x, z, amount, yaw) {
  if (amount < 0.04) return;
  const u = ((x / FOAM_WORLD) % 1 + 1) % 1;
  const v = ((z / FOAM_WORLD) % 1 + 1) % 1;
  const cx = (u * FOAM_RES) | 0;
  const cy = (v * FOAM_RES) | 0;
  // Boat forward in XZ
  const fx = -Math.sin(yaw);
  const fz = -Math.cos(yaw);
  const rx = Math.cos(yaw);
  const rz = -Math.sin(yaw);
  const radius = 2 + ((amount * 4) | 0);
  const add = (amount * 100) | 0;
  // Local: lateral = right, along = forward (negative = stern wake)
  for (let along = -radius * 3; along <= radius; along++) {
    for (let lat = -radius; lat <= radius; lat++) {
      const behind = Math.max(0, -along);
      const fall = 1 - Math.min(1, (lat * lat) / (radius * radius * 1.1) + behind * 0.035);
      if (fall <= 0) continue;
      // V-wake widens behind stern
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
  // Bow splash
  const bx = (cx + Math.round(fx * 4) + FOAM_RES) % FOAM_RES;
  const by = (cy + Math.round(fz * 4) + FOAM_RES) % FOAM_RES;
  const splash = (amount * 75) | 0;
  for (let dy = -2; dy <= 2; dy++) {
    for (let dx = -2; dx <= 2; dx++) {
      if (dx * dx + dy * dy > 5) continue;
      const i =
        (((by + dy + FOAM_RES) % FOAM_RES) * FOAM_RES + ((bx + dx + FOAM_RES) % FOAM_RES)) * 4;
      foamData[i] = Math.min(255, foamData[i] + splash);
      foamData[i + 1] = foamData[i];
      foamData[i + 2] = foamData[i];
      foamData[i + 3] = 255;
    }
  }
  foamTex.needsUpdate = true;
}

function decayFoam() {
  // Soft dissolve — every pixel slightly
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

function applyOceanUniforms(mat, cfg, sun, simT) {
  mat.uniforms.uTime.value = simT;
  mat.uniforms.uFFTScale.value = cfg.fft;
  mat.uniforms.uHeightMin.value = fft.heightMin;
  mat.uniforms.uHeightRange.value = fft.heightRange;
  mat.uniforms.uSunDir.value.copy(sun.dir);
  mat.uniforms.uSunColor.value.copy(sun.sunColor);
  mat.uniforms.uSkyZenith.value.copy(sun.zenith);
  mat.uniforms.uSkyHorizon.value.copy(sun.horizon);
  mat.uniforms.uDeepColor.value.copy(sun.deep);
  mat.uniforms.uShallowColor.value.copy(sun.shallow);
  mat.uniforms.uExposure.value = 1.12;
  mat.uniforms.uRoughness.value =
    weather === "storm" ? 0.09 : weather === "calm" ? 0.028 : 0.045;
  mat.uniforms.uCameraY.value = camera.position.y;
  mat.uniforms.uTurbidity.value = cfg.turb;
  mat.uniforms.uSSSStrength.value = weather === "storm" ? 1.0 : 0.45;
  mat.uniforms.uFoamStrength.value =
    weather === "calm" ? 0.25 : weather === "storm" ? 1.2 : 0.85;
  mat.uniforms.uSeaState.value = cfg.sea;
  mat.uniforms.uWindDir.value.set(0.85, 0.53);
  applyDetailWaves(mat, packDetailWaves(cfg.detail));
}

window.addEventListener("resize", () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight, false);
  post.setSize(innerWidth, innerHeight);
  post.setPixelRatio(renderer.getPixelRatio());
});

// Warm-start FFT so first frame isn't flat
fft.update(0);
fft.fillTextureData(fftData);
fftTex.needsUpdate = true;

let last = performance.now();
let foamDecayAcc = 0;

function frame(now) {
  const dt = Math.min((now - last) / 1000, 0.1);
  last = now;
  simTime += dt;

  // 128² FFT: update every 2 frames desktop, 3 on mobile
  fftFrame++;
  const fftEvery = isTouch ? 3 : 2;
  if (fftFrame % fftEvery === 0) {
    fft.update(simTime);
    fft.fillTextureData(fftData);
    fftTex.needsUpdate = true;
  }

  const cfg = WEATHER[weather];
  const sun = sunFromTimeOfDay(timeOfDay);

  applyOceanUniforms(oceanMat, cfg, sun, simTime);

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
  amb.intensity = THREE.MathUtils.lerp(
    0.2,
    0.6,
    THREE.MathUtils.smoothstep(sun.dir.y, -0.1, 0.5),
  );
  hemi.intensity = THREE.MathUtils.lerp(
    0.35,
    0.85,
    THREE.MathUtils.smoothstep(sun.dir.y, -0.05, 0.45),
  );

  const input = readInput();
  const wake = boat.update(seaAPI, simTime, input, playing, dt);
  if (playing && wake) stampFoam(wake.x, wake.z, wake.foam, wake.yaw);

  foamDecayAcc += dt;
  if (foamDecayAcc > 0.07) {
    foamDecayAcc = 0;
    decayFoam();
  }

  // Re-center ocean under boat/camera, snapped to grid (kills dual-layer crawl)
  const followX = playing ? boat.x : camera.position.x;
  const followZ = playing ? boat.z : camera.position.z;
  oceanMesh.position.x = Math.round(followX / OCEAN_SNAP) * OCEAN_SNAP;
  oceanMesh.position.z = Math.round(followZ / OCEAN_SNAP) * OCEAN_SNAP;
  oceanMesh.position.y = 0;

  updateCamera(dt);

  // Exposure: photo plate is slightly soft / not overcooked
  post.setExposure(
    THREE.MathUtils.lerp(0.88, 1.08, THREE.MathUtils.smoothstep(sun.dir.y, -0.1, 0.4)),
  );
  // Keep bloom tight — high strength made a washed disc in sky
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
  getFftN: () => FFT_N,
};

/** Look-dev helpers for automated capture / goal loop */
window.__lookdev = {
  ready: () => simTime > 0.5 && fft.heightRange > 0,
  hideHud: () => {
    document.querySelector(".hud")?.classList.add("hidden");
  },
  showHud: () => {
    document.querySelector(".hud")?.classList.remove("hidden");
  },
  setWeather: (w) => setWeather(w),
  setTod: (t) => {
    timeOfDay = t;
    const el = document.getElementById("tod");
    if (el) el.value = String(t);
  },
  /** Title plate: pure ocean, low cam toward horizon (matches photo ref framing) */
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
    // Match photo: low over water, gaze toward mid-field swell + horizon
    camera.position.set(1.5, 2.4, 4.5);
    camera.lookAt(0.5, -0.1, -45);
    camSmooth.init = false;
  },
  /** Play plate: boat visible, follow cam */
  playPlate: () => {
    playing = true;
    boat.group.visible = true;
    for (const g of islandGroups) g.visible = true;
    boat.x = 0;
    boat.z = 0;
    boat.yaw = 0;
    boat.speed = 0;
    document.getElementById("title")?.classList.add("hidden");
    camSmooth.init = false;
  },
};
