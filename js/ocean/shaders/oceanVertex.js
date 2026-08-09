import { CASCADE_UNIFORMS_GLSL } from "./cascadeSampling.js";

/**
 * Ocean vertex stage.
 *
 * Sums four cascades of full 3-D displacement. Horizontal displacement (Dx, Dz)
 * is what sharpens crests and flattens troughs — dropping it leaves rounded
 * sine hills that never read as ocean.
 *
 * Computes no normals. Those come from the FFT's own derivative textures in the
 * fragment stage, where they can be mip-filtered for slope-variance roughness.
 *
 * The two finest cascades fade out geometrically with distance: past ~80 m
 * their wavelengths are sub-pixel, so displacing vertices by them only aliases.
 * They keep contributing through the normal and roughness path, which is where
 * fine detail belongs anyway.
 */

export const oceanVertexShader = /* glsl */ `
precision highp float;
precision highp sampler2D;

${CASCADE_UNIFORMS_GLSL}

uniform float uCascadeFade[4];
uniform float uDisplacementScale;

out vec3 vWorldPos;
out vec2 vWorldXZ;
out float vCamDist;
out float vWaveHeight;
out float vFoam;

// Samplers cannot be indexed by a loop counter in ESSL 3.00, so each cascade
// is expanded explicitly.
#define ACCUMULATE_CASCADE(SAMPLER, IDX)                                       \\
  {                                                                            \\
    float fade = 1.0;                                                          \\
    if (uCascadeFade[IDX] > 0.0) {                                             \\
      fade = 1.0 - smoothstep(uCascadeFade[IDX] * 0.5, uCascadeFade[IDX], camDist); \\
    }                                                                          \\
    if (fade > 0.001) {                                                        \\
      vec4 s = textureLod(SAMPLER, basePos.xz / uPatch[IDX], 0.0);             \\
      disp += s.xyz * fade;                                                    \\
      foam = max(foam, s.w * fade);                                            \\
    }                                                                          \\
  }

void main() {
  vec3 basePos = (modelMatrix * vec4(position, 1.0)).xyz;
  float camDist = length(cameraPosition - basePos);

  vec3 disp = vec3(0.0);
  float foam = 0.0;

  ACCUMULATE_CASCADE(uDisp0, 0)
  ACCUMULATE_CASCADE(uDisp1, 1)
  ACCUMULATE_CASCADE(uDisp2, 2)
  ACCUMULATE_CASCADE(uDisp3, 3)

  disp *= uDisplacementScale;

  vec3 worldPos = basePos + disp;
  vWorldPos = worldPos;
  vWorldXZ = worldPos.xz;
  vWaveHeight = disp.y;
  vFoam = foam;
  vCamDist = length(cameraPosition - worldPos);

  gl_Position = projectionMatrix * viewMatrix * vec4(worldPos, 1.0);
}
`;
