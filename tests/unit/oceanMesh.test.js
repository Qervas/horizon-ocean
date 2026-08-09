import { test } from "node:test";
import assert from "node:assert/strict";
import { buildRingDiscData } from "../../js/ocean/oceanMesh.js";

const opts = { rings: 16, segments: 24, innerRadius: 0.25, outerRadius: 20000 };

test("vertex count is rings*segments plus one centre vertex", () => {
  const { positions } = buildRingDiscData(opts);
  assert.equal(positions.length / 3, opts.rings * opts.segments + 1);
});

test("the centre vertex is at the origin", () => {
  const { positions } = buildRingDiscData(opts);
  assert.equal(positions[0], 0);
  assert.equal(positions[1], 0);
  assert.equal(positions[2], 0);
});

test("radial spacing is exponential", () => {
  const { positions } = buildRingDiscData(opts);
  const radii = [];
  for (let r = 0; r < opts.rings; r++) {
    const v = 1 + r * opts.segments; // first vertex of each ring
    radii.push(Math.hypot(positions[v * 3], positions[v * 3 + 2]));
  }
  const ratio = radii[1] / radii[0];
  for (let i = 1; i < radii.length; i++) {
    const got = radii[i] / radii[i - 1];
    assert.ok(Math.abs(got / ratio - 1) < 1e-5, `ring ${i} ratio ${got} != ${ratio}`);
  }
});

test("inner and outer radii are honoured", () => {
  const { positions } = buildRingDiscData(opts);
  const radiusOfRing = (r) => {
    const v = 1 + r * opts.segments;
    return Math.hypot(positions[v * 3], positions[v * 3 + 2]);
  };
  assert.ok(Math.abs(radiusOfRing(0) - opts.innerRadius) < 1e-6);
  assert.ok(Math.abs(radiusOfRing(opts.rings - 1) - opts.outerRadius) < 1e-3);
});

test("the surface is flat — displacement happens in the shader", () => {
  const { positions } = buildRingDiscData(opts);
  for (let i = 0; i < positions.length / 3; i++) {
    assert.equal(positions[i * 3 + 1], 0, `vertex ${i} has non-zero Y`);
  }
});

test("every index is within range", () => {
  const { positions, indices } = buildRingDiscData(opts);
  const vertexCount = positions.length / 3;
  for (let i = 0; i < indices.length; i++) {
    assert.ok(
      Number.isInteger(indices[i]) && indices[i] >= 0 && indices[i] < vertexCount,
      `index ${i} is ${indices[i]}, out of range for ${vertexCount} vertices`,
    );
  }
});

test("every vertex is referenced by at least one triangle", () => {
  // Catches the classic off-by-one that silently orphans the last ring.
  const { positions, indices } = buildRingDiscData(opts);
  const vertexCount = positions.length / 3;
  const seen = new Uint8Array(vertexCount);
  for (let i = 0; i < indices.length; i++) seen[indices[i]] = 1;
  for (let v = 0; v < vertexCount; v++) {
    assert.equal(seen[v], 1, `vertex ${v} is orphaned`);
  }
});

test("the angular seam closes without a duplicate column", () => {
  // The last segment must wrap to segment 0. A duplicated column produces a
  // hairline crack that only shows up at grazing angles.
  const { positions, indices } = buildRingDiscData(opts);
  const angles = new Set();
  for (let s = 0; s < opts.segments; s++) {
    const v = 1 + s;
    angles.add(Math.atan2(positions[v * 3 + 2], positions[v * 3]).toFixed(6));
  }
  assert.equal(angles.size, opts.segments, "duplicate angular positions in ring 0");

  // Triangles must exist that reference both the last and the first segment.
  let wraps = false;
  for (let i = 0; i < indices.length; i += 3) {
    const tri = [indices[i], indices[i + 1], indices[i + 2]];
    const segs = tri.filter((v) => v > 0).map((v) => (v - 1) % opts.segments);
    if (segs.includes(opts.segments - 1) && segs.includes(0)) wraps = true;
  }
  assert.ok(wraps, "no triangle bridges the last segment back to the first");
});

test("triangle count matches the ring topology", () => {
  const { indices } = buildRingDiscData(opts);
  // Centre fan plus two triangles per quad between consecutive rings.
  const expected = opts.segments + (opts.rings - 1) * opts.segments * 2;
  assert.equal(indices.length / 3, expected);
});

test("triangles wind consistently counter-clockwise seen from above", () => {
  // Inconsistent winding with backface culling on makes patches of ocean
  // vanish depending on view angle.
  const { positions, indices } = buildRingDiscData(opts);
  const p = (v) => [positions[v * 3], positions[v * 3 + 2]];
  let negative = 0;
  for (let i = 0; i < indices.length; i += 3) {
    const [ax, az] = p(indices[i]);
    const [bx, bz] = p(indices[i + 1]);
    const [cx, cz] = p(indices[i + 2]);
    const cross = (bx - ax) * (cz - az) - (bz - az) * (cx - ax);
    if (cross < 0) negative++;
  }
  assert.ok(
    negative === 0 || negative === indices.length / 3,
    `mixed winding: ${negative} of ${indices.length / 3} triangles are reversed`,
  );
});

test("a 256x256 disc stays far below the old uniform plane's vertex count", () => {
  const { positions } = buildRingDiscData({
    rings: 256,
    segments: 256,
    innerRadius: 0.25,
    outerRadius: 20000,
  });
  const count = positions.length / 3;
  assert.ok(count < 70000, `${count} vertices`);
  assert.ok(count > 60000, `${count} vertices — suspiciously few`);
});
