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

/**
 * Everything mounted on the deck moves with the deck. Raising freeboard without
 * this leaves the console and T-top buried in the sole.
 */
const DECK_Y = HULL_DEFAULTS.sheerMid - 0.1;

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
    // A hull is legitimately seen from inside — over the gunwale, and through
    // the cockpit from above.
    side: THREE.DoubleSide,
    vertexColors: true,
    roughness: 0.28,
    metalness: 0.02,
    emissive: 0x0a0f16,
    emissiveIntensity: 0.1,
  });
  const teak = new THREE.MeshStandardMaterial({
    side: THREE.DoubleSide,
    color: 0x8d6a45,
    roughness: 0.58,
    metalness: 0.0,
    emissive: 0x0d0803,
    emissiveIntensity: 0.06,
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
  // Tapered: narrower at the base, as a moulded console is.
  const console_ = new THREE.Mesh(new THREE.CylinderGeometry(0.52, 0.44, 0.86, 4, 1), gel);
  console_.rotation.y = Math.PI / 4;
  console_.scale.set(1.0, 1.0, 0.86);
  console_.position.set(0, DECK_Y + 0.43, 0.15);
  console_.castShadow = true;
  group.add(console_);
  const coaming = new THREE.Mesh(new THREE.BoxGeometry(0.84, 0.05, 0.72), gel);
  coaming.position.set(0, DECK_Y + 0.87, 0.15);
  group.add(coaming);

  // Dark instrument panel, raked back like the reference.
  const dash = new THREE.Mesh(new THREE.BoxGeometry(0.62, 0.24, 0.05), carbon);
  dash.position.set(0, DECK_Y + 0.71, -0.18);
  dash.rotation.x = 0.34;
  group.add(dash);

  const wheel = new THREE.Mesh(new THREE.TorusGeometry(0.14, 0.022, 8, 20), carbon);
  wheel.position.set(0, DECK_Y + 0.77, -0.26);
  wheel.rotation.x = 1.22;
  group.add(wheel);

  // --- Windshield: low, raked, wrapping the console front ---
  const screen = new THREE.Mesh(new THREE.BoxGeometry(1.16, 0.34, 0.035), glass);
  screen.position.set(0, DECK_Y + 0.84, -0.52);
  screen.rotation.x = -0.42;
  group.add(screen);
  for (const side of [-1, 1]) {
    const wing = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.28, 0.03), glass);
    wing.position.set(side * 0.72, DECK_Y + 0.80, -0.34);
    wing.rotation.set(-0.36, side * 0.62, 0);
    group.add(wing);
  }

  // --- T-top ---
  const topY = DECK_Y + 1.73;
  const canopy = new THREE.Mesh(new THREE.BoxGeometry(1.72, 0.045, 1.46), gel);
  canopy.position.set(0, topY, 0.24);
  canopy.castShadow = true;
  group.add(canopy);
  // Shallow lip around the hardtop edge — a bare slab reads as cardboard.
  const lip = new THREE.Mesh(new THREE.BoxGeometry(1.78, 0.05, 1.52), gel);
  lip.position.set(0, topY - 0.035, 0.24);
  group.add(lip);

  // Four slim legs, splayed outboard as in the reference.
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      const leg = new THREE.Mesh(
        new THREE.CylinderGeometry(0.026, 0.038, topY - DECK_Y, 10),
        gel,
      );
      leg.position.set(sx * 0.6, DECK_Y + (topY - DECK_Y) / 2, 0.24 + sz * 0.52);
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
  bench.position.set(0, DECK_Y + 0.47, 0.72);
  bench.castShadow = true;
  group.add(bench);
  const backrest = new THREE.Mesh(new THREE.BoxGeometry(1.0, 0.36, 0.12), navy);
  backrest.position.set(0, DECK_Y + 0.67, 0.94);
  group.add(backrest);

  const leaning = new THREE.Mesh(new THREE.BoxGeometry(0.86, 0.14, 0.34), navy);
  leaning.position.set(0, DECK_Y + 0.53, -0.62);
  group.add(leaning);

  // --- Outboard on the transom ---
  const cowl = new THREE.Mesh(new THREE.BoxGeometry(0.46, 0.52, 0.42), carbon);
  cowl.position.set(0, DECK_Y + 0.12, HULL_LENGTH / 2 + 0.18);
  cowl.castShadow = true;
  group.add(cowl);
  const leg = new THREE.Mesh(new THREE.BoxGeometry(0.17, 0.66, 0.24), carbon);
  leg.position.set(0, DECK_Y - 0.42, HULL_LENGTH / 2 + 0.2);
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

  // Anchor locker hatch on the foredeck.
  const hatch = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.03, 0.62), gel);
  hatch.position.set(0, DECK_Y + 0.42, -2.05);
  group.add(hatch);

  // Cleats, port and starboard, fore and aft.
  for (const side of [-1, 1]) {
    for (const z of [-1.95, 1.9]) {
      const cleat = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.05, 0.2), chrome);
      cleat.position.set(side * 0.78, DECK_Y + 0.36, z);
      group.add(cleat);
    }
  }

  // Rod holders angled outboard from the hardtop rocket launcher.
  for (let i = 0; i < 4; i++) {
    const t = (i - 1.5) * 0.22;
    const rod = new THREE.Mesh(new THREE.CylinderGeometry(0.022, 0.022, 0.3, 6), carbon);
    rod.position.set(t, topY + 0.12, 0.86);
    rod.rotation.x = -0.42;
    group.add(rod);
  }

  // Bow eye.
  const eye = new THREE.Mesh(new THREE.TorusGeometry(0.05, 0.014, 6, 12), chrome);
  eye.position.set(0, DECK_Y + 0.3, -HULL_LENGTH / 2 + 0.12);
  eye.rotation.y = Math.PI / 2;
  group.add(eye);

  return group;
}

export { HULL_LENGTH };
