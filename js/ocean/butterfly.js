/**
 * Cooley-Tukey butterfly lookup table for a GPU radix-2 FFT.
 *
 * Pure — imports nothing — so `node:test` can exercise it directly.
 *
 * The table is consumed as a texture of width N (butterfly index) and height
 * log2(N) (stage). Each texel is (twiddleRe, twiddleIm, srcTop, srcBottom).
 *
 * Both wings of a butterfly read the *same* operand pair; the +/- of the
 * butterfly lives entirely in the twiddle, which comes out negated for the
 * lower wing. That is what lets the shader be a single unconditional
 * `p + w*q` with no branch.
 *
 * Twiddles use exp(+2*pi*i*k/N) — the positive exponent — because every
 * transform in this project is an *inverse* FFT (spectrum to spatial domain).
 */

/** log2 for exact powers of two. */
export function log2int(n) {
  return Math.round(Math.log2(n));
}

/** Bit-reversal permutation table for length N. */
export function bitReverseIndices(N) {
  const bits = log2int(N);
  const out = new Uint16Array(N);
  for (let i = 0; i < N; i++) {
    let x = i;
    let y = 0;
    for (let b = 0; b < bits; b++) {
      y = (y << 1) | (x & 1);
      x >>= 1;
    }
    out[i] = y;
  }
  return out;
}

/**
 * Butterfly table as a Float32Array of length log2(N) * N * 4,
 * row-major with stage as the row.
 */
export function buildButterflyData(N) {
  const stages = log2int(N);
  const reverse = bitReverseIndices(N);
  const data = new Float32Array(stages * N * 4);

  for (let stage = 0; stage < stages; stage++) {
    const span = 1 << stage;
    for (let x = 0; x < N; x++) {
      // k walks the twiddle around the unit circle at the rate this stage needs.
      // The lower wing lands exactly half a turn away, which is the sign flip.
      const k = (x * (N / (span * 2))) % N;
      const angle = (2 * Math.PI * k) / N;
      const topWing = x % (span * 2) < span;

      let top;
      let bottom;
      if (stage === 0) {
        // First stage reads the bit-reversed input, so the permutation costs
        // no separate pass.
        top = topWing ? reverse[x] : reverse[x - 1];
        bottom = topWing ? reverse[x + 1] : reverse[x];
      } else {
        top = topWing ? x : x - span;
        bottom = topWing ? x + span : x;
      }

      const o = (stage * N + x) * 4;
      data[o] = Math.cos(angle);
      data[o + 1] = Math.sin(angle);
      data[o + 2] = top;
      data[o + 3] = bottom;
    }
  }
  return data;
}
