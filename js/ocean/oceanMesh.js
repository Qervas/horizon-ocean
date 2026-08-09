/**
 * Concentric ring disc ocean geometry.
 *
 * Replaces a 960 m uniform plane at 640^2 (410k vertices, uniform 1.5 m
 * spacing) that could not resolve near-field detail while spending most of its
 * budget past 300 m — where the old shader hid a 480 m horizon behind a milky
 * fog blend.
 *
 * Exponential radial spacing puts vertices where perspective needs them:
 * ~0.25 m at the camera out to a 20 km horizon, in ~65k vertices. No LOD
 * levels, no morphing, no popping — the mesh simply follows the camera and all
 * sampling is world-space.
 *
 * `buildRingDiscData` is pure so `node:test` can exercise the topology
 * directly; `createOceanMesh` is a thin THREE wrapper.
 */

const DEFAULTS = {
  rings: 256,
  segments: 256,
  innerRadius: 0.25,
  outerRadius: 20000,
};

/**
 * Returns { positions: Float32Array, indices: Uint32Array } for a disc in the
 * XZ plane, Y flat at 0. Vertex 0 is the centre; ring r occupies vertices
 * [1 + r*segments, 1 + (r+1)*segments).
 */
export function buildRingDiscData(options = {}) {
  const { rings, segments, innerRadius, outerRadius } = { ...DEFAULTS, ...options };

  const vertexCount = rings * segments + 1;
  const positions = new Float32Array(vertexCount * 3);

  // Exponential growth factor between consecutive rings.
  const growth = Math.pow(outerRadius / innerRadius, 1 / (rings - 1));

  for (let r = 0; r < rings; r++) {
    const radius = innerRadius * Math.pow(growth, r);
    for (let s = 0; s < segments; s++) {
      const theta = (s / segments) * Math.PI * 2;
      const v = 1 + r * segments + s;
      positions[v * 3] = Math.cos(theta) * radius;
      positions[v * 3 + 1] = 0;
      positions[v * 3 + 2] = Math.sin(theta) * radius;
    }
  }

  const triangleCount = segments + (rings - 1) * segments * 2;
  const indices = new Uint32Array(triangleCount * 3);
  let o = 0;

  // Centre fan. Wound so the disc faces +Y, matching the ring quads below.
  for (let s = 0; s < segments; s++) {
    const a = 1 + s;
    const b = 1 + ((s + 1) % segments);
    indices[o++] = 0;
    indices[o++] = b;
    indices[o++] = a;
  }

  for (let r = 0; r < rings - 1; r++) {
    const inner = 1 + r * segments;
    const outer = 1 + (r + 1) * segments;
    for (let s = 0; s < segments; s++) {
      const s1 = (s + 1) % segments;
      const i0 = inner + s;
      const i1 = inner + s1;
      const o0 = outer + s;
      const o1 = outer + s1;
      indices[o++] = i0;
      indices[o++] = o1;
      indices[o++] = o0;
      indices[o++] = i0;
      indices[o++] = i1;
      indices[o++] = o1;
    }
  }

  return { positions, indices };
}

/** Thin THREE wrapper. THREE is injected so this module stays testable. */
export function createOceanMesh(THREE, material, options = {}) {
  const { positions, indices } = buildRingDiscData(options);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geometry.setIndex(new THREE.BufferAttribute(indices, 1));
  // The vertex shader displaces far beyond any static bounds, and the mesh is
  // always under the camera, so culling it is never correct.
  geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), Infinity);

  const mesh = new THREE.Mesh(geometry, material);
  mesh.frustumCulled = false;
  mesh.matrixAutoUpdate = true;
  return mesh;
}
