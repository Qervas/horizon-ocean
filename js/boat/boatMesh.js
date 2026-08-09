import {
  buildHullData,
  buildDeckData,
  buildTransomData,
  sheerLine,
  HULL_DEFAULTS,
} from "./hullGeometry.js";

/**
 * Assembles the boat from the concept reference in ref/concept/.
 *
 * A centre-console runabout: lofted planing hull with navy bottom and a red
 * boot stripe, teak sole inside raised gunwales, low raked windshield, console
 * under a T-top with radome and antenna, navy bench, and an outboard on the
 * transom.
 *
 * THREE is injected so the geometry module stays dependency-free and testable.
 */

const HULL_LENGTH = HULL_DEFAULTS.length;

function surface(THREE, data, material, withColors) {
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(data.positions, 3));
  if (withColors && data.colors) {
    g.setAttribute("color", new THREE.BufferAttribute(data.colors, 3));
  }
  g.setIndex(new THREE.BufferAttribute(data.indices, 1));
  g.computeVertexNormals();
  const m = new THREE.Mesh(g, material);
  m.castShadow = true;
  m.receiveShadow = true;
  return m;
}

/** Tube following a list of [x,y,z] points — bow rail, grab rails. */
function railFromPoints(THREE, points, radius, material) {
  const curve = new THREE.CatmullRomCurve3(points.map((p) => new THREE.Vector3(p[0], p[1], p[2])));
  const g = new THREE.TubeGeometry(curve, Math.max(points.length * 2, 24), radius, 8, false);
  const m = new THREE.Mesh(g, material);
  m.castShadow = true;
  return m;
}

export function buildBoatMesh(THREE) {
  const group = new THREE.Group();

  // --- Materials ---
  // Slight emissive keeps dark parts legible through the linear→ACES post grade.
  const hullMat = new THREE.MeshStandardMaterial({
    vertexColors: true,
    roughness: 0.28,
    metalness: 0.02,
    emissive: 0x0a0f16,
    emissiveIntensity: 0.1,
  });
  const teak = new THREE.MeshStandardMaterial({
    color: 0xc08a4e,
    roughness: 0.72,
    metalness: 0.0,
    emissive: 0x1a0f06,
    emissiveIntensity: 0.12,
  });
  const gel = new THREE.MeshStandardMaterial({
    color: 0xf2f5f7,
    roughness: 0.24,
    metalness: 0.03,
    emissive: 0x141a20,
    emissiveIntensity: 0.1,
  });
  const navy = new THREE.MeshStandardMaterial({
    color: 0x1d2b52,
    roughness: 0.55,
    emissive: 0x070c18,
    emissiveIntensity: 0.14,
  });
  const glass = new THREE.MeshStandardMaterial({
    color: 0x9fc2d8,
    roughness: 0.08,
    metalness: 0.2,
    transparent: true,
    opacity: 0.42,
    emissive: 0x16242e,
    emissiveIntensity: 0.16,
  });
  const chrome = new THREE.MeshStandardMaterial({
    color: 0xdfe5ea,
    roughness: 0.18,
    metalness: 0.85,
  });
  const carbon = new THREE.MeshStandardMaterial({
    color: 0x24282d,
    roughness: 0.42,
    metalness: 0.25,
    emissive: 0x0c1013,
    emissiveIntensity: 0.2,
  });

  // --- Hull and deck ---
  group.add(surface(THREE, buildHullData(), hullMat, true));
  group.add(surface(THREE, buildDeckData(), teak, false));

  // Transom cap, fanned from the hull's own final section so it cannot jut.
  group.add(surface(THREE, buildTransomData(), hullMat, true));

  // Rubbing strake along the sheer, both sides.
  for (const side of [-1, 1]) {
    group.add(railFromPoints(THREE, sheerLine(side), 0.035, gel));
  }

  // --- Console ---
  const console_ = new THREE.Mesh(new THREE.BoxGeometry(0.78, 0.86, 0.66), gel);
  console_.position.set(0, 0.62, 0.15);
  console_.castShadow = true;
  group.add(console_);

  // Dark instrument panel, raked back like the reference.
  const dash = new THREE.Mesh(new THREE.BoxGeometry(0.62, 0.24, 0.05), carbon);
  dash.position.set(0, 0.9, -0.18);
  dash.rotation.x = 0.34;
  group.add(dash);

  const wheel = new THREE.Mesh(new THREE.TorusGeometry(0.14, 0.022, 8, 20), carbon);
  wheel.position.set(0, 0.96, -0.26);
  wheel.rotation.x = 1.22;
  group.add(wheel);

  // --- Windshield: low, raked, wrapping the console front ---
  const screen = new THREE.Mesh(new THREE.BoxGeometry(1.16, 0.34, 0.035), glass);
  screen.position.set(0, 1.03, -0.52);
  screen.rotation.x = -0.42;
  group.add(screen);
  for (const side of [-1, 1]) {
    const wing = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.28, 0.03), glass);
    wing.position.set(side * 0.72, 0.99, -0.34);
    wing.rotation.set(-0.36, side * 0.62, 0);
    group.add(wing);
  }

  // --- T-top ---
  const topY = 1.92;
  const canopy = new THREE.Mesh(new THREE.BoxGeometry(1.68, 0.06, 1.42), gel);
  canopy.position.set(0, topY, 0.24);
  canopy.castShadow = true;
  group.add(canopy);

  // Four slim legs, splayed outboard as in the reference.
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.032, 0.032, topY - 0.42, 8), gel);
      leg.position.set(sx * 0.6, (topY - 0.42) / 2 + 0.4, 0.24 + sz * 0.52);
      leg.rotation.z = -sx * 0.06;
      leg.castShadow = true;
      group.add(leg);
    }
  }

  // Radome and antenna on the hardtop.
  const radome = new THREE.Mesh(new THREE.CylinderGeometry(0.17, 0.17, 0.12, 16), gel);
  radome.position.set(-0.28, topY + 0.09, 0.3);
  group.add(radome);

  const antenna = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.012, 0.72, 6), carbon);
  antenna.position.set(0.34, topY + 0.38, 0.36);
  antenna.rotation.z = -0.12;
  group.add(antenna);

  // Masthead light — also the boat's own light source at night.
  const light = new THREE.PointLight(0xd6ecff, 0.55, 12, 2);
  light.position.set(0.34, topY + 0.78, 0.36);
  group.add(light);
  const bulb = new THREE.Mesh(
    new THREE.SphereGeometry(0.035, 8, 8),
    new THREE.MeshStandardMaterial({
      color: 0xfffef0,
      emissive: 0xfff4c0,
      emissiveIntensity: 1.4,
    }),
  );
  bulb.position.copy(light.position);
  group.add(bulb);

  // --- Seating ---
  const bench = new THREE.Mesh(new THREE.BoxGeometry(1.0, 0.16, 0.5), navy);
  bench.position.set(0, 0.66, 0.72);
  bench.castShadow = true;
  group.add(bench);
  const backrest = new THREE.Mesh(new THREE.BoxGeometry(1.0, 0.36, 0.12), navy);
  backrest.position.set(0, 0.86, 0.94);
  group.add(backrest);

  const leaning = new THREE.Mesh(new THREE.BoxGeometry(0.86, 0.14, 0.34), navy);
  leaning.position.set(0, 0.72, -0.62);
  group.add(leaning);

  // --- Outboard on the transom ---
  const cowl = new THREE.Mesh(new THREE.BoxGeometry(0.46, 0.52, 0.42), carbon);
  cowl.position.set(0, 0.42, HULL_LENGTH / 2 + 0.18);
  cowl.castShadow = true;
  group.add(cowl);
  const leg = new THREE.Mesh(new THREE.BoxGeometry(0.17, 0.66, 0.24), carbon);
  leg.position.set(0, -0.02, HULL_LENGTH / 2 + 0.2);
  group.add(leg);
  const skeg = new THREE.Mesh(new THREE.CylinderGeometry(0.075, 0.055, 0.46, 10), carbon);
  skeg.rotation.x = Math.PI / 2;
  skeg.position.set(0, -0.34, HULL_LENGTH / 2 + 0.2);
  group.add(skeg);
  const prop = new THREE.Mesh(new THREE.CylinderGeometry(0.11, 0.11, 0.05, 12), chrome);
  prop.rotation.x = Math.PI / 2;
  prop.position.set(0, -0.34, HULL_LENGTH / 2 + 0.44);
  group.add(prop);

  // --- Bow rail: follows the sheer forward, then across the stem ---
  const railHeight = 0.3;
  const bowRail = [];
  const stbd = sheerLine(1);
  const port = sheerLine(-1);
  const forwardCount = Math.floor(stbd.length * 0.42);
  for (let i = forwardCount; i >= 0; i--) {
    bowRail.push([port[i][0] * 0.94, port[i][1] + railHeight, port[i][2]]);
  }
  for (let i = 1; i <= forwardCount; i++) {
    bowRail.push([stbd[i][0] * 0.94, stbd[i][1] + railHeight, stbd[i][2]]);
  }
  group.add(railFromPoints(THREE, bowRail, 0.018, chrome));

  // Stanchions carrying the rail.
  for (const side of [-1, 1]) {
    for (const idx of [Math.floor(forwardCount * 0.45), forwardCount]) {
      const p = side < 0 ? port[idx] : stbd[idx];
      const post = new THREE.Mesh(
        new THREE.CylinderGeometry(0.014, 0.014, railHeight, 6),
        chrome,
      );
      post.position.set(p[0] * 0.94, p[1] + railHeight / 2, p[2]);
      group.add(post);
    }
  }

  // Bow eye.
  const eye = new THREE.Mesh(new THREE.TorusGeometry(0.05, 0.014, 6, 12), chrome);
  eye.position.set(0, 0.2, -HULL_LENGTH / 2 + 0.12);
  eye.rotation.y = Math.PI / 2;
  group.add(eye);

  return group;
}

export { HULL_LENGTH };
