import * as THREE from "three";
import { FFTOcean, FFT_N } from "./fftOcean.js";
import { packDetailWaves } from "./gerstner.js";
import { createOceanMaterial, applyDetailWaves } from "./oceanMaterial.js";
import { createSkyMaterial, sunFromTimeOfDay } from "./sky.js";
import { Boat } from "./boat.js";

const WEATHER = {
  calm: { fft: 0.45, detail: 0.35, label: "calm" },
  moderate: { fft: 1.0, detail: 1.0, label: "moderate" },
  storm: { fft: 1.7, detail: 1.55, label: "storm" },
};

const canvas = document.getElementById("c");
const renderer = new THREE.WebGLRenderer({
  canvas,
  antialias: true,
  powerPreference: "high-performance",
});
renderer.setPixelRatio(Math.min(devicePixelRatio, 1.75));
renderer.setSize(innerWidth, innerHeight, false);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.NoToneMapping;
renderer.shadowMap.enabled = true;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x6a9bc4);

const camera = new THREE.PerspectiveCamera(58, innerWidth / innerHeight, 0.4, 8000);
camera.position.set(0, 8, 18);

// --- FFT ocean ---
const fft = new FFTOcean({ patchSize: 200, windSpeed: 16, A: 0.00055, choppiness: 1.25 });
const fftData = new Uint8Array(FFT_N * FFT_N * 4);
const fftTex = new THREE.DataTexture(fftData, FFT_N, FFT_N, THREE.RGBAFormat);
fftTex.wrapS = fftTex.wrapT = THREE.RepeatWrapping;
fftTex.magFilter = THREE.LinearFilter;
fftTex.minFilter = THREE.LinearFilter;
fftTex.needsUpdate = true;

// Persistent foam trail atlas (world XZ)
const FOAM_RES = 256;
const foamData = new Uint8Array(FOAM_RES * FOAM_RES * 4);
const foamTex = new THREE.DataTexture(foamData, FOAM_RES, FOAM_RES, THREE.RGBAFormat);
foamTex.wrapS = foamTex.wrapT = THREE.RepeatWrapping;
foamTex.magFilter = THREE.LinearFilter;
foamTex.minFilter = THREE.LinearFilter;
foamTex.needsUpdate = true;
const FOAM_WORLD = 400; // meters covered by foam atlas

const oceanMat = createOceanMaterial();
oceanMat.uniforms.uFFTMap.value = fftTex;
oceanMat.uniforms.uFoamTrail.value = foamTex;
oceanMat.uniforms.uFFTPatch.value = fft.patch;

const oceanGeo = new THREE.PlaneGeometry(480, 480, 400, 400);
oceanGeo.rotateX(-Math.PI / 2);
const oceanMesh = new THREE.Mesh(oceanGeo, oceanMat);
oceanMesh.frustumCulled = false;
scene.add(oceanMesh);

// Sky
const skyMat = createSkyMaterial();
const sky = new THREE.Mesh(new THREE.SphereGeometry(4000, 48, 32), skyMat);
sky.frustumCulled = false;
scene.add(sky);

// Lights
const amb = new THREE.AmbientLight(0x87a0c8, 0.35);
scene.add(amb);
const sunLight = new THREE.DirectionalLight(0xfff2d6, 1.6);
sunLight.castShadow = true;
sunLight.shadow.mapSize.set(1024, 1024);
scene.add(sunLight);
scene.add(new THREE.HemisphereLight(0x87a0c8, 0x0a1520, 0.35));

// Islands
function addIsland(x, z, s, h, rot) {
  const rock = new THREE.MeshStandardMaterial({
    color: 0x3a3d42,
    roughness: 0.92,
    flatShading: true,
  });
  const grass = new THREE.MeshStandardMaterial({
    color: 0x2f4a38,
    roughness: 0.95,
    flatShading: true,
  });
  const g = new THREE.Group();
  g.position.set(x, -2, z);
  g.rotation.y = rot;
  const body = new THREE.Mesh(new THREE.DodecahedronGeometry(s, 1), rock);
  body.position.y = h * 0.25;
  body.scale.set(1, h / s, 1.15);
  body.castShadow = true;
  g.add(body);
  const cap = new THREE.Mesh(new THREE.SphereGeometry(s * 0.55, 8, 6), grass);
  cap.position.y = h * 0.55;
  cap.scale.set(0.7, 0.25, 0.7);
  g.add(cap);
  scene.add(g);
}
addIsland(180, -220, 28, 22, 0.4);
addIsland(-260, 140, 36, 30, 1.2);
addIsland(320, 280, 22, 16, 2.1);
addIsland(-120, -340, 40, 35, 0.7);

const boat = new Boat(scene);

// --- State ---
let playing = false;
let weather = "moderate";
let timeOfDay = 0.42;
let simTime = 0;
let fftFrame = 0;

const keys = new Set();
const touch = { steer: 0, throttle: 0 };

const seaAPI = {
  sampleFFT: (x, z) => fft.sample(x, z),
  detailScale: WEATHER.moderate.detail,
  fftScale: WEATHER.moderate.fft,
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
setWeather("moderate");

// --- Input ---
window.addEventListener("keydown", (e) => {
  keys.add(e.code);
  if (["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Space"].includes(e.code))
    e.preventDefault();
});
window.addEventListener("keyup", (e) => keys.delete(e.code));
window.addEventListener("blur", () => keys.clear());

function readInput() {
  let steer = 0,
    throttle = 0;
  if (keys.has("KeyA") || keys.has("ArrowLeft")) steer += 1;
  if (keys.has("KeyD") || keys.has("ArrowRight")) steer -= 1;
  if (keys.has("KeyW") || keys.has("ArrowUp")) throttle += 1;
  if (keys.has("KeyS") || keys.has("ArrowDown")) throttle -= 1;
  if (Math.abs(touch.steer) > 0.05) steer = touch.steer;
  if (Math.abs(touch.throttle) > 0.05) throttle = touch.throttle;
  return { steer, throttle };
}

// Touch sticks
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

// UI
document.getElementById("btnLaunch").onclick = () => {
  playing = true;
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

// Camera
const camSmooth = { x: 0, y: 8, z: 18, init: false };
function updateCamera(dt) {
  const fx = -Math.sin(boat.yaw);
  const fz = -Math.cos(boat.yaw);
  if (!playing) {
    const t = simTime;
    const radius = 20;
    const tx = boat.x + Math.sin(t * 0.1) * radius;
    const tz = boat.z + Math.cos(t * 0.1) * radius;
    const ty = 6.5 + Math.sin(t * 0.18) * 1.2;
    camera.position.lerp(new THREE.Vector3(tx, ty, tz), 1 - Math.exp(-1.4 * dt));
    camera.lookAt(boat.x, boat.y + 0.4, boat.z);
    camSmooth.init = false;
    return;
  }
  if (!camSmooth.init) {
    camSmooth.x = boat.x - fx * 12;
    camSmooth.y = boat.y + 4.5;
    camSmooth.z = boat.z - fz * 12;
    camSmooth.init = true;
  }
  const follow = 10.5 + Math.abs(boat.speed) * 0.1;
  const height = 3.8 + Math.abs(boat.speed) * 0.035;
  const dx = boat.x - fx * follow;
  const dy = boat.y + height;
  const dz = boat.z - fz * follow;
  const a = 1 - Math.exp(-5 * dt);
  camSmooth.x += (dx - camSmooth.x) * a;
  camSmooth.y += (dy - camSmooth.y) * a;
  camSmooth.z += (dz - camSmooth.z) * a;
  camera.position.set(camSmooth.x, camSmooth.y, camSmooth.z);
  camera.lookAt(boat.x + fx * 5, boat.y + 1.1, boat.z + fz * 5);
}

function stampFoam(x, z, amount) {
  if (amount < 0.05) return;
  const u = ((x / FOAM_WORLD) % 1 + 1) % 1;
  const v = ((z / FOAM_WORLD) % 1 + 1) % 1;
  const cx = (u * FOAM_RES) | 0;
  const cy = (v * FOAM_RES) | 0;
  const radius = 2 + ((amount * 3) | 0);
  const add = (amount * 90) | 0;
  for (let dy = -radius; dy <= radius; dy++) {
    for (let dx = -radius; dx <= radius; dx++) {
      if (dx * dx + dy * dy > radius * radius) continue;
      const px = (cx + dx + FOAM_RES) % FOAM_RES;
      const py = (cy + dy + FOAM_RES) % FOAM_RES;
      const i = (py * FOAM_RES + px) * 4;
      foamData[i] = Math.min(255, foamData[i] + add);
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
      foamData[i] = Math.max(0, foamData[i] - 1);
      foamData[i + 1] = foamData[i];
      foamData[i + 2] = foamData[i];
    }
  }
  foamTex.needsUpdate = true;
}

// Resize
window.addEventListener("resize", () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight, false);
});

// Loop
let last = performance.now();
let foamDecayAcc = 0;

function frame(now) {
  const dt = Math.min((now - last) / 1000, 0.1);
  last = now;
  simTime += dt;

  // FFT update every other frame for perf
  fftFrame++;
  if (fftFrame % 2 === 0) {
    fft.update(simTime);
    fft.fillTextureData(fftData);
    fftTex.needsUpdate = true;
    oceanMat.uniforms.uHeightMin.value = fft.heightMin;
    oceanMat.uniforms.uHeightRange.value = fft.heightRange;
  }

  const cfg = WEATHER[weather];
  const pack = packDetailWaves(cfg.detail);
  applyDetailWaves(oceanMat, pack);
  oceanMat.uniforms.uTime.value = simTime;
  oceanMat.uniforms.uFFTScale.value = cfg.fft;

  const sun = sunFromTimeOfDay(timeOfDay);
  oceanMat.uniforms.uSunDir.value.copy(sun.dir);
  oceanMat.uniforms.uSunColor.value.copy(sun.sunColor);
  oceanMat.uniforms.uSkyZenith.value.copy(sun.zenith);
  oceanMat.uniforms.uSkyHorizon.value.copy(sun.horizon);
  oceanMat.uniforms.uDeepColor.value.setRGB(0.001, 0.015, 0.04);
  oceanMat.uniforms.uShallowColor.value.setRGB(0.008, 0.11, 0.15);
  oceanMat.uniforms.uExposure.value = 0.92;
  oceanMat.uniforms.uRoughness.value = 0.11;
  oceanMat.uniforms.uCameraY.value = camera.position.y;

  skyMat.uniforms.uSunDir.value.copy(sun.dir);
  skyMat.uniforms.uSunColor.value.copy(sun.sunColor);
  skyMat.uniforms.uZenith.value.copy(sun.zenith);
  skyMat.uniforms.uHorizon.value.copy(sun.horizon);
  skyMat.uniforms.uExposure.value = sun.exposure * 0.95;
  skyMat.uniforms.uTime.value = simTime;

  sunLight.position.copy(sun.dir).multiplyScalar(200);
  sunLight.color.copy(sun.sunColor);
  sunLight.intensity = THREE.MathUtils.clamp(sun.dir.y * 2.2 + 0.15, 0.08, 2.4);
  amb.intensity = THREE.MathUtils.lerp(
    0.08,
    0.45,
    THREE.MathUtils.smoothstep(sun.dir.y, -0.1, 0.5),
  );

  const input = readInput();
  const wake = boat.update(seaAPI, simTime, input, playing, dt);
  if (playing && wake) stampFoam(wake.x, wake.z, wake.foam);

  foamDecayAcc += dt;
  if (foamDecayAcc > 0.08) {
    foamDecayAcc = 0;
    decayFoam();
  }

  // Ocean follows camera XZ
  oceanMesh.position.x = camera.position.x;
  oceanMesh.position.z = camera.position.z;

  updateCamera(dt);

  // HUD
  document.getElementById("spd").textContent = (
    Math.abs(boat.speed) * 0.22
  ).toFixed(0);
  document.getElementById("hdg").textContent = (
    (((boat.yaw * 180) / Math.PI) % 360 + 360) %
    360
  ).toFixed(0);

  renderer.render(scene, camera);
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

// QA probe
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
};
