/**
 * Lofted planing-hull geometry.
 *
 * Pure — imports nothing — so `node:test` can exercise the topology directly.
 *
 * A boat hull is defined by cross-sections ("stations") swept along its length,
 * not by a box. Three curves control the shape:
 *
 *   halfBeam(t)  how wide the hull is        — zero at the stem, full aft
 *   draft(t)     how deep the keel runs      — rocker, shallow at the bow
 *   sheer(t)     how high the deck edge sits — high at the bow, dipping amidships
 *
 * and a fourth, `sectionPower(t)`, controls the section *shape*: a deep V
 * forward that flattens into a hard chine aft. That transition is what makes a
 * hull read as a planing boat rather than a canoe.
 *
 * Convention matches js/boat.js: the bow points toward -Z.
 */

export const HULL_DEFAULTS = {
  length: 6.2,
  beam: 2.25,
  draftMax: 0.46,
  // Freeboard. A 6.2 m centre console carries roughly 0.9 m of topsides
  // amidships and 1.5 m at the bow; at the 0.30 m this started with, the hull
  // was a raft and every wave over a foot washed across the deck.
  sheerMid: 0.92,
  bowRise: 0.62,
  sternRise: 0.10,
  stations: 40,
  sectionPoints: 12,
  /** Waterline height, for the navy/white colour split. */
  waterline: 0.0,
  /** Height of the red pinstripe band above the waterline. */
  stripeTop: 0.1,
};

const lerp = (a, b, t) => a + (b - a) * t;
const clamp01 = (v) => Math.min(1, Math.max(0, v));

/** Half-width at station t. Zero at the stem, widest around three-quarters aft. */
export function halfBeamAt(t, beam) {
  const rise = 1 - Math.pow(1 - clamp01(t / 0.78), 2.1);
  // Slight tumblehome so the transom is not the widest point.
  const tumble = 1 - 0.07 * clamp01((t - 0.78) / 0.22);
  return (beam / 2) * rise * tumble;
}

/** Keel depth below y=0 at station t. Rocker: shallow forward, full aft. */
export function draftAt(t, draftMax) {
  const forward = Math.min(1, Math.pow(clamp01(t / 0.36), 0.8));
  const aftLift = 1 - 0.14 * clamp01((t - 0.72) / 0.28);
  return draftMax * forward * aftLift;
}

/** Deck-edge height at station t. High at the bow, dipping amidships. */
export function sheerAt(t, { sheerMid, bowRise, sternRise }) {
  return sheerMid + bowRise * Math.pow(1 - clamp01(t), 2.0) + sternRise * Math.pow(clamp01(t), 3);
}

/**
 * Section exponent at station t.
 * Near 1 is a straight deep-V; larger values flatten the bottom and sharpen the
 * chine. Forward sections are fine and V-shaped, aft sections are flat.
 */
export function sectionPowerAt(t) {
  return lerp(1.15, 2.9, clamp01((t - 0.1) / 0.8));
}

/**
 * Builds the hull surface as an open lofted sheet running from the port sheer,
 * down over the keel, and up to the starboard sheer.
 *
 * Returns positions, indices, and per-vertex colours banding the hull into
 * navy below the waterline, a red pinstripe, and white topsides — which is
 * cheaper and sharper than texturing it.
 */
export function buildHullData(options = {}) {
  const o = { ...HULL_DEFAULTS, ...options };
  const { length, beam, draftMax, stations, sectionPoints, waterline, stripeTop } = o;

  const cols = sectionPoints * 2 + 1; // port side + keel + starboard side
  const positions = [];
  const colors = [];

  const navy = [0.06, 0.11, 0.26];
  const red = [0.55, 0.09, 0.12];
  const white = [0.93, 0.94, 0.95];

  for (let i = 0; i <= stations; i++) {
    const t = i / stations;
    const z = -length / 2 + t * length;
    const hb = halfBeamAt(t, beam);
    const dr = draftAt(t, draftMax);
    const sh = sheerAt(t, o);
    const p = sectionPowerAt(t);

    for (let j = 0; j < cols; j++) {
      // u runs -1 (port sheer) → 0 (keel) → +1 (starboard sheer)
      const u = (j - sectionPoints) / sectionPoints;
      const a = Math.abs(u);
      const x = hb * a * Math.sign(u);
      const y = -dr + (sh + dr) * Math.pow(a, p);
      positions.push(x, y, z);

      // Colour bands. Sharp transitions read as painted stripes.
      let c;
      if (y < waterline) c = navy;
      else if (y < waterline + stripeTop) c = red;
      else c = white;
      colors.push(c[0], c[1], c[2]);
    }
  }

  const indices = [];
  for (let i = 0; i < stations; i++) {
    for (let j = 0; j < cols - 1; j++) {
      const a = i * cols + j;
      const b = a + 1;
      const c = (i + 1) * cols + j;
      const d = c + 1;
      indices.push(a, c, b);
      indices.push(b, c, d);
    }
  }

  return {
    positions: new Float32Array(positions),
    colors: new Float32Array(colors),
    indices: new Uint32Array(indices),
    cols,
    rows: stations + 1,
  };
}

/**
 * Deck surface: a cambered sheet inset from the sheer line, forming the sole
 * with raised gunwales either side.
 */
export function buildDeckData(options = {}) {
  const o = { ...HULL_DEFAULTS, ...options };
  const { length, beam, stations } = o;
  const gunwale = options.gunwale ?? 0.11;
  const drop = options.deckDrop ?? 0.1;
  const camber = options.camber ?? 0.035;
  const cols = 9;

  const positions = [];
  for (let i = 0; i <= stations; i++) {
    const t = i / stations;
    const z = -length / 2 + t * length;
    const hb = Math.max(halfBeamAt(t, beam) - gunwale, 0);
    const sh = sheerAt(t, o);
    for (let j = 0; j < cols; j++) {
      const u = (j / (cols - 1)) * 2 - 1;
      const x = hb * u;
      // Camber crowns the deck so water sheds outboard.
      const y = sh - drop + camber * (1 - u * u);
      positions.push(x, y, z);
    }
  }

  const indices = [];
  for (let i = 0; i < stations; i++) {
    for (let j = 0; j < cols - 1; j++) {
      const a = i * cols + j;
      const b = a + 1;
      const c = (i + 1) * cols + j;
      const d = c + 1;
      // Wound so the deck faces up. Reversed, it is backface-culled and you see
      // straight through the sole into the hull interior.
      indices.push(a, c, b);
      indices.push(b, c, d);
    }
  }

  return {
    positions: new Float32Array(positions),
    indices: new Uint32Array(indices),
    cols,
    rows: stations + 1,
  };
}

/** Sheer-line points along one side, for placing rails and rubbing strakes. */
export function sheerLine(side, options = {}) {
  const o = { ...HULL_DEFAULTS, ...options };
  const pts = [];
  for (let i = 0; i <= o.stations; i++) {
    const t = i / o.stations;
    pts.push([
      halfBeamAt(t, o.beam) * side,
      sheerAt(t, o),
      -o.length / 2 + t * o.length,
    ]);
  }
  return pts;
}

/**
 * Transom cap.
 *
 * Built as a fan from the hull's final station ring rather than a rectangle, so
 * it matches the curved section exactly. A flat plane sized by eye juts past the
 * topsides at the chine, which is unmistakable from astern.
 */
export function buildTransomData(options = {}) {
  const o = { ...HULL_DEFAULTS, ...options };
  const { length, beam, draftMax, sectionPoints } = o;
  const t = 1;
  const hb = halfBeamAt(t, beam);
  const dr = draftAt(t, draftMax);
  const sh = sheerAt(t, o);
  const p = sectionPowerAt(t);
  const z = length / 2;

  const cols = sectionPoints * 2 + 1;
  const positions = [];
  const colors = [];

  const navy = [0.06, 0.11, 0.26];
  const red = [0.55, 0.09, 0.12];
  const white = [0.93, 0.94, 0.95];
  const bandColour = (y) =>
    y < o.waterline ? navy : y < o.waterline + o.stripeTop ? red : white;

  // Centroid first, then the ring — a triangle fan.
  const centreY = (-dr + sh) * 0.5;
  positions.push(0, centreY, z);
  colors.push(...bandColour(centreY));

  for (let j = 0; j < cols; j++) {
    const u = (j - sectionPoints) / sectionPoints;
    const a = Math.abs(u);
    const x = hb * a * Math.sign(u);
    const y = -dr + (sh + dr) * Math.pow(a, p);
    positions.push(x, y, z);
    colors.push(...bandColour(y));
  }

  const indices = [];
  for (let j = 1; j < cols; j++) {
    indices.push(0, j, j + 1);
  }

  return {
    positions: new Float32Array(positions),
    colors: new Float32Array(colors),
    indices: new Uint32Array(indices),
  };
}
