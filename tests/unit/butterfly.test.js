import { test } from "node:test";
import assert from "node:assert/strict";
import { buildButterflyData, bitReverseIndices, log2int } from "../../js/ocean/butterfly.js";

test("log2int is exact for powers of two", () => {
  assert.equal(log2int(8), 3);
  assert.equal(log2int(256), 8);
});

test("bit reversal is an involution", () => {
  const br = bitReverseIndices(256);
  assert.equal(br.length, 256);
  for (let i = 0; i < 256; i++) assert.equal(br[br[i]], i);
});

test("bit reversal matches known values for N=8", () => {
  assert.deepEqual(Array.from(bitReverseIndices(8)), [0, 4, 2, 6, 1, 5, 3, 7]);
});

test("butterfly data is one row per stage, N columns, RGBA", () => {
  const d = buildButterflyData(256);
  assert.equal(d.length, 8 * 256 * 4);
});

test("twiddle factors are unit magnitude everywhere", () => {
  const N = 256;
  const d = buildButterflyData(N);
  for (let i = 0; i < log2int(N) * N; i++) {
    const re = d[i * 4];
    const im = d[i * 4 + 1];
    assert.ok(
      Math.abs(Math.hypot(re, im) - 1) < 1e-5,
      `texel ${i} twiddle magnitude ${Math.hypot(re, im)}`,
    );
  }
});

test("source indices are always in range", () => {
  const N = 256;
  const d = buildButterflyData(N);
  for (let i = 0; i < log2int(N) * N; i++) {
    const top = d[i * 4 + 2];
    const bot = d[i * 4 + 3];
    assert.ok(Number.isInteger(top) && top >= 0 && top < N, `top index ${top} out of range`);
    assert.ok(Number.isInteger(bot) && bot >= 0 && bot < N, `bottom index ${bot} out of range`);
  }
});

// Hand-derived from the decimation-in-time butterfly for N=8. These are the
// values that make or break the transform, so they are checked literally
// rather than against a re-statement of the implementation formula.
test("stage 0 pairs bit-reversed inputs with +1/-1 twiddles", () => {
  const N = 8;
  const d = buildButterflyData(N);
  const at = (stage, x) => d.slice((stage * N + x) * 4, (stage * N + x) * 4 + 4);

  // x=0 is the top wing of the first pair: X[0] + 1*X[4]
  const t0 = at(0, 0);
  assert.ok(Math.abs(t0[0] - 1) < 1e-6 && Math.abs(t0[1]) < 1e-6, `w=${t0[0]},${t0[1]}`);
  assert.equal(t0[2], 0);
  assert.equal(t0[3], 4);

  // x=1 is the bottom wing of the same pair: X[0] + (-1)*X[4]
  const t1 = at(0, 1);
  assert.ok(Math.abs(t1[0] + 1) < 1e-6 && Math.abs(t1[1]) < 1e-6, `w=${t1[0]},${t1[1]}`);
  assert.equal(t1[2], 0);
  assert.equal(t1[3], 4);
});

test("stage 1 uses +i and -i twiddles on the odd pair", () => {
  const N = 8;
  const d = buildButterflyData(N);
  const at = (stage, x) => d.slice((stage * N + x) * 4, (stage * N + x) * 4 + 4);

  // Inverse transform uses exp(+2*pi*i*k/N), so the quarter-turn twiddle is +i.
  const t1 = at(1, 1);
  assert.ok(Math.abs(t1[0]) < 1e-6 && Math.abs(t1[1] - 1) < 1e-6, `w=${t1[0]},${t1[1]}`);
  assert.equal(t1[2], 1);
  assert.equal(t1[3], 3);

  const t3 = at(1, 3);
  assert.ok(Math.abs(t3[0]) < 1e-6 && Math.abs(t3[1] + 1) < 1e-6, `w=${t3[0]},${t3[1]}`);
  assert.equal(t3[2], 1);
  assert.equal(t3[3], 3);
});

test("both wings of a butterfly read the same operand pair", () => {
  // The wing sign lives in the twiddle, not in the indices. If this breaks,
  // the transform silently loses half its energy.
  const N = 64;
  const d = buildButterflyData(N);
  const nStages = log2int(N);
  for (let stage = 0; stage < nStages; stage++) {
    const span = 1 << stage;
    for (let x = 0; x < N; x++) {
      const i = (stage * N + x) * 4;
      const partner = (x % (span * 2)) < span ? x + span : x - span;
      const j = (stage * N + partner) * 4;
      assert.equal(d[i + 2], d[j + 2], `stage ${stage} x ${x}: top index differs from partner`);
      assert.equal(d[i + 3], d[j + 3], `stage ${stage} x ${x}: bottom index differs from partner`);
      // Twiddles must be exact negatives of each other.
      assert.ok(Math.abs(d[i] + d[j]) < 1e-5, `stage ${stage} x ${x}: twiddle re not negated`);
      assert.ok(Math.abs(d[i + 1] + d[j + 1]) < 1e-5, `stage ${stage} x ${x}: twiddle im not negated`);
    }
  }
});
