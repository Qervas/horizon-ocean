import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildHullData,
  buildDeckData,
  halfBeamAt,
  draftAt,
  sheerAt,
  sectionPowerAt,
  flareAt,
  sectionX,
  sheerLine,
  HULL_DEFAULTS,
} from "../../js/boat/hullGeometry.js";

test("the stem is a point — zero beam at the bow", () => {
  assert.equal(halfBeamAt(0, 2.25), 0);
});

test("beam grows aft and peaks before the transom", () => {
  const b = 2.25;
  const widths = [0, 0.2, 0.4, 0.6, 0.78, 0.9, 1].map((t) => halfBeamAt(t, b));
  for (let i = 1; i < 5; i++) {
    assert.ok(widths[i] > widths[i - 1], `beam shrank between station ${i - 1} and ${i}`);
  }
  const max = Math.max(...widths);
  assert.ok(widths[widths.length - 1] < max, "transom is the widest section — no tumblehome");
  assert.ok(max <= b / 2 + 1e-9, `half-beam ${max} exceeds beam/2`);
});

test("the keel has rocker — shallow at the bow, full aft", () => {
  assert.equal(draftAt(0, 0.46), 0);
  assert.ok(draftAt(0.5, 0.46) > draftAt(0.15, 0.46));
  assert.ok(draftAt(0.5, 0.46) <= 0.46 + 1e-9);
});

test("the sheer peaks at the bow, dips aft, then lifts at the transom", () => {
  // A real sheer line's low point sits well aft of midships — around 80-90% —
  // not at the middle. Asserting the minimum is at 0.5 would be testing a
  // wrong idea of the curve rather than the curve.
  const s = HULL_DEFAULTS;
  const samples = [];
  for (let i = 0; i <= 40; i++) samples.push(sheerAt(i / 40, s));

  const bow = samples[0];
  const stern = samples[samples.length - 1];
  assert.ok(bow === Math.max(...samples), `bow ${bow} is not the highest point`);
  assert.ok(bow > stern, `bow ${bow} not above stern ${stern}`);

  const minIdx = samples.indexOf(Math.min(...samples));
  const minT = minIdx / 40;
  assert.ok(minT > 0.6, `sheer low point at t=${minT}, expected well aft of midships`);
  assert.ok(minT < 1, "sheer low point is the transom — no stern lift");
  assert.ok(stern > samples[minIdx], `transom ${stern} does not lift above the low point`);
});

test("sections flatten from a deep V forward to a hard chine aft", () => {
  // This transition is what makes it read as a planing hull rather than a canoe.
  assert.ok(sectionPowerAt(0.9) > sectionPowerAt(0.1) * 1.5, "sections never flatten aft");
});

test("hull vertex and index counts are consistent", () => {
  const h = buildHullData();
  assert.equal(h.positions.length / 3, h.rows * h.cols);
  assert.equal(h.colors.length / 3, h.rows * h.cols);
  assert.equal(h.indices.length / 3, (h.rows - 1) * (h.cols - 1) * 2);
});

test("every hull index is in range", () => {
  const h = buildHullData();
  const n = h.positions.length / 3;
  for (let i = 0; i < h.indices.length; i++) {
    assert.ok(h.indices[i] >= 0 && h.indices[i] < n, `index ${h.indices[i]} out of range`);
  }
});

test("the hull is symmetric about the centreline", () => {
  const h = buildHullData();
  const { cols, rows } = h;
  const mid = (cols - 1) / 2;
  for (let i = 0; i < rows; i += 7) {
    for (let j = 0; j < mid; j++) {
      const a = (i * cols + j) * 3;
      const b = (i * cols + (cols - 1 - j)) * 3;
      assert.ok(Math.abs(h.positions[a] + h.positions[b]) < 1e-6, `x not mirrored at row ${i}`);
      assert.ok(Math.abs(h.positions[a + 1] - h.positions[b + 1]) < 1e-6, `y differs at row ${i}`);
      assert.ok(Math.abs(h.positions[a + 2] - h.positions[b + 2]) < 1e-6, `z differs at row ${i}`);
    }
  }
});

test("the keel sits on the centreline", () => {
  const h = buildHullData();
  const mid = (h.cols - 1) / 2;
  for (let i = 0; i < h.rows; i += 5) {
    const x = h.positions[(i * h.cols + mid) * 3];
    assert.ok(Math.abs(x) < 1e-9, `keel off centre at row ${i}: x=${x}`);
  }
});

test("the keel is the lowest point of every section", () => {
  const h = buildHullData();
  const mid = (h.cols - 1) / 2;
  for (let i = 1; i < h.rows; i++) {
    const keelY = h.positions[(i * h.cols + mid) * 3 + 1];
    for (let j = 0; j < h.cols; j++) {
      const y = h.positions[(i * h.cols + j) * 3 + 1];
      assert.ok(y >= keelY - 1e-6, `row ${i} col ${j} sits below the keel`);
    }
  }
});

test("the hull spans exactly its stated length", () => {
  const h = buildHullData({ length: 6.2 });
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (let i = 0; i < h.positions.length; i += 3) {
    minZ = Math.min(minZ, h.positions[i + 2]);
    maxZ = Math.max(maxZ, h.positions[i + 2]);
  }
  assert.ok(Math.abs(maxZ - minZ - 6.2) < 1e-6, `spans ${maxZ - minZ}, expected 6.2`);
  assert.ok(Math.abs(minZ + 3.1) < 1e-6, "bow is not at -length/2");
});

test("colour bands split navy, red and white by height", () => {
  const h = buildHullData();
  let navy = 0;
  let red = 0;
  let white = 0;
  for (let v = 0; v < h.positions.length / 3; v++) {
    const y = h.positions[v * 3 + 1];
    const r = h.colors[v * 3];
    if (y < 0) navy++;
    else if (y < HULL_DEFAULTS.stripeTop) red++;
    else white++;
    assert.ok(r >= 0 && r <= 1, "colour out of range");
  }
  assert.ok(navy > 0 && red > 0 && white > 0, `bands missing: navy=${navy} red=${red} white=${white}`);
});

test("deck is inset from the sheer and sits below it", () => {
  const deck = buildDeckData();
  const hull = buildHullData();
  const midRow = Math.floor(deck.rows / 2);
  let deckMaxX = 0;
  for (let j = 0; j < deck.cols; j++) {
    deckMaxX = Math.max(deckMaxX, Math.abs(deck.positions[(midRow * deck.cols + j) * 3]));
  }
  let hullMaxX = 0;
  for (let j = 0; j < hull.cols; j++) {
    hullMaxX = Math.max(hullMaxX, Math.abs(hull.positions[(midRow * hull.cols + j) * 3]));
  }
  assert.ok(deckMaxX < hullMaxX, `deck (${deckMaxX}) is not inset from the hull (${hullMaxX})`);

  const deckY = deck.positions[(midRow * deck.cols + Math.floor(deck.cols / 2)) * 3 + 1];
  const sheerY = sheerAt(midRow / (deck.rows - 1), HULL_DEFAULTS);
  assert.ok(deckY < sheerY, `deck ${deckY} is not below the sheer ${sheerY}`);
});

test("deck is cambered — centre higher than the edges", () => {
  const deck = buildDeckData();
  const row = Math.floor(deck.rows / 2);
  const centre = deck.positions[(row * deck.cols + Math.floor(deck.cols / 2)) * 3 + 1];
  const edge = deck.positions[(row * deck.cols) * 3 + 1];
  assert.ok(centre > edge, `deck centre ${centre} is not above the edge ${edge}`);
});

test("every deck index is in range", () => {
  const d = buildDeckData();
  const n = d.positions.length / 3;
  for (let i = 0; i < d.indices.length; i++) {
    assert.ok(d.indices[i] >= 0 && d.indices[i] < n, `index ${d.indices[i]} out of range`);
  }
});

test("sheer line follows the hull edge on the requested side", () => {
  const stbd = sheerLine(1);
  const port = sheerLine(-1);
  assert.equal(stbd.length, HULL_DEFAULTS.stations + 1);
  for (let i = 1; i < stbd.length; i++) {
    assert.ok(stbd[i][0] >= 0, "starboard sheer crossed the centreline");
    assert.ok(Math.abs(stbd[i][0] + port[i][0]) < 1e-9, "sides not mirrored");
  }
});

test("deck triangles face upward", () => {
  // If the deck winds downward it is backface-culled and you see straight
  // through the sole into the hull interior — which reads as a hollow shell.
  const { positions, indices } = buildDeckData();
  const p = (v) => [positions[v * 3], positions[v * 3 + 1], positions[v * 3 + 2]];
  let up = 0;
  let down = 0;
  for (let i = 0; i < indices.length; i += 3) {
    const [ax, ay, az] = p(indices[i]);
    const [bx, by, bz] = p(indices[i + 1]);
    const [cx, cy, cz] = p(indices[i + 2]);
    // Y component of (b-a) x (c-a)
    const ny = (bz - az) * (cx - ax) - (bx - ax) * (cz - az);
    if (ny > 0) up++;
    else if (ny < 0) down++;
  }
  assert.equal(down, 0, `${down} of ${up + down} deck triangles face downward`);
});

test("topsides flare — sections lean outward toward the sheer", () => {
  // Straight topsides are what make a hull read slab-sided. The mid-height of a
  // flared section sits inboard of the straight line from keel to sheer.
  const hb = 1.0;
  const fl = flareAt(0.2); // forward station, strong flare
  const straight = hb * 0.5;
  assert.ok(sectionX(hb, 0.5, fl) < straight, "mid-section is not pulled inboard");
});

test("flare preserves maximum beam exactly", () => {
  // Flare must pull the middle in, not push the deck out, or the boat silently
  // grows wider than its stated beam.
  for (const t of [0, 0.25, 0.5, 0.75, 1]) {
    const fl = flareAt(t);
    assert.ok(Math.abs(sectionX(2.0, 1.0, fl) - 2.0) < 1e-9, `beam changed at t=${t}`);
  }
});

test("flare is strongest at the bow and fades aft", () => {
  assert.ok(flareAt(0) > flareAt(0.5), "flare does not fade aft");
  assert.ok(flareAt(0.5) >= flareAt(1.0), "flare increases toward the transom");
});
