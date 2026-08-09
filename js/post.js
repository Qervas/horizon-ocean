import * as THREE from "three";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";
import { ShaderPass } from "three/addons/postprocessing/ShaderPass.js";

/**
 * Photo-oriented post stack:
 * scene (linear HDR) → bloom (sun glints) → ACES filmic + grade (display)
 *
 * Final pass outputs display-referred color; no OutputPass to avoid
 * double sRGB encoding on top of the filmic curve.
 */

const FilmGradeShader = {
  uniforms: {
    tDiffuse: { value: null },
    uExposure: { value: 1.0 },
    // The saturation and contrast boosts here were compensating for washed-out
    // grey water. The GPU ocean produces real colour, so they now over-cook it.
    uVignette: { value: 0.12 },
    uSaturation: { value: 1.04 },
    uContrast: { value: 1.08 },
    uWarmth: { value: -0.08 },
    uLift: { value: -0.035 },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: /* glsl */ `
    precision highp float;
    uniform sampler2D tDiffuse;
    uniform float uExposure;
    uniform float uVignette;
    uniform float uSaturation;
    uniform float uContrast;
    uniform float uWarmth;
    uniform float uLift;
    varying vec2 vUv;

    // ACES fitted filmic (Narkowicz)
    vec3 aces(vec3 x) {
      const float a = 2.51;
      const float b = 0.03;
      const float c = 2.43;
      const float d = 0.59;
      const float e = 0.14;
      return clamp((x * (a * x + b)) / (x * (c * x + d) + e), 0.0, 1.0);
    }

    void main() {
      vec3 col = texture2D(tDiffuse, vUv).rgb * uExposure;

      // Mild warmth / cool shadows
      col.r += uWarmth * 0.02;
      col.b -= uWarmth * 0.015;

      col = aces(col);

      // Contrast around mid-gray
      col = (col - 0.5) * uContrast + 0.5 + uLift;

      // Saturation
      float luma = dot(col, vec3(0.2126, 0.7152, 0.0722));
      col = mix(vec3(luma), col, uSaturation);

      // Soft vignette
      vec2 p = vUv * 2.0 - 1.0;
      float vig = 1.0 - dot(p, p) * uVignette;
      col *= clamp(vig, 0.0, 1.0);

      gl_FragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
    }
  `,
};

export function createPostStack(renderer, scene, camera) {
  const size = new THREE.Vector2();
  renderer.getSize(size);

  const composer = new EffectComposer(renderer);
  composer.setPixelRatio(renderer.getPixelRatio());
  composer.setSize(size.x, size.y);

  const renderPass = new RenderPass(scene, camera);
  composer.addPass(renderPass);

  const bloom = new UnrealBloomPass(
    new THREE.Vector2(size.x, size.y),
    0.38, // strength — sun glints / foam highlights
    0.55, // radius
    0.82, // threshold — only bright specular
  );
  composer.addPass(bloom);

  const grade = new ShaderPass(FilmGradeShader);
  // Last pass renders to screen
  grade.renderToScreen = true;
  composer.addPass(grade);

  return {
    composer,
    bloom,
    grade,
    setSize(w, h) {
      composer.setSize(w, h);
      bloom.setSize(w, h);
    },
    setPixelRatio(pr) {
      composer.setPixelRatio(pr);
    },
    setExposure(e) {
      grade.uniforms.uExposure.value = e;
    },
    render() {
      composer.render();
    },
  };
}
