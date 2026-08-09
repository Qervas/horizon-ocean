import * as THREE from "three";
import { OceanSimulation } from "../../js/ocean/oceanSimulation.js";
import { renderer, assert } from "./gpuTests.js";

const reg = (name, fn) => window.__gpuTests.register(name, fn);

/**
 * Samples a texture at an explicit LOD into a 1x1 target and reads it back.
 * If mip generation is not happening, every LOD returns level 0 and the
 * slope-variance roughness path is silently dead.
 */
function sampleAtLod(texture, lod, uv = [0.5, 0.5]) {
  const mat = new THREE.RawShaderMaterial({
    glslVersion: THREE.GLSL3,
    vertexShader: `in vec3 position; void main(){ gl_Position = vec4(position.xy,0.0,1.0); }`,
    fragmentShader: `
      precision highp float;
      uniform sampler2D tSrc;
      uniform float uLod;
      uniform vec2 uUv;
      out vec4 outColor;
      void main() { outColor = textureLod(tSrc, uUv, uLod); }`,
    uniforms: {
      tSrc: { value: texture },
      uLod: { value: lod },
      uUv: { value: new THREE.Vector2(uv[0], uv[1]) },
    },
    depthTest: false,
    depthWrite: false,
  });
  const scene = new THREE.Scene();
  const cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), mat);
  quad.frustumCulled = false;
  scene.add(quad);

  const rt = new THREE.WebGLRenderTarget(1, 1, {
    type: THREE.FloatType,
    format: THREE.RGBAFormat,
    minFilter: THREE.NearestFilter,
    magFilter: THREE.NearestFilter,
  });
  const prev = renderer.getRenderTarget();
  renderer.setRenderTarget(rt);
  renderer.render(scene, cam);
  renderer.setRenderTarget(prev);

  const buf = new Float32Array(4);
  renderer.readRenderTargetPixels(rt, 0, 0, 1, 1, buf);
  rt.dispose();
  mat.dispose();
  quad.geometry.dispose();
  return buf;
}

reg("derivative textures have a working mip chain", async () => {
  const N = 64;
  const sim = new OceanSimulation(renderer, { N, windSpeed: 14 });
  for (let i = 0; i < 3; i++) sim.update(1 + i * 0.1, 1 / 60);

  const tex = sim.derivativesTexture(3); // finest cascade: most high-frequency detail
  const lod0 = sampleAtLod(tex, 0.0);
  const lodHigh = sampleAtLod(tex, 5.0);
  sim.dispose();

  const differ =
    Math.abs(lod0[0] - lodHigh[0]) > 1e-6 || Math.abs(lod0[1] - lodHigh[1]) > 1e-6;
  assert(
    differ,
    `LOD 0 (${lod0[0]}, ${lod0[1]}) and LOD 5 (${lodHigh[0]}, ${lodHigh[1]}) are identical — ` +
      `mipmaps are not being generated, so slope-variance roughness is dead`,
  );
});

reg("slope means fall with mip level while second moments stay positive", async () => {
  // Averaging opposing slopes cancels the first moment but not the second.
  // That gap is exactly the variance the roughness term consumes.
  const N = 64;
  const sim = new OceanSimulation(renderer, { N, windSpeed: 14 });
  for (let i = 0; i < 3; i++) sim.update(1 + i * 0.1, 1 / 60);

  const tex = sim.derivativesTexture(3);
  const lod0 = sampleAtLod(tex, 0.0);
  const lodHigh = sampleAtLod(tex, 5.0);
  sim.dispose();

  const m1High = Math.hypot(lodHigh[0], lodHigh[1]);
  const m2High = lodHigh[2] + lodHigh[3];
  const varianceHigh = m2High - (lodHigh[0] * lodHigh[0] + lodHigh[1] * lodHigh[1]);

  assert(m2High > 0, `second moment at high LOD is ${m2High}`);
  assert(
    varianceHigh > 0,
    `variance at high LOD is ${varianceHigh} (m1=${m1High}, m2=${m2High}) — ` +
      `no sub-pixel slope spread survives filtering`,
  );
});
