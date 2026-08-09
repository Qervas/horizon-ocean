import { test } from "node:test";
import assert from "node:assert/strict";
import { detectTier, TIER_GPU, TIER_CPU } from "../../js/ocean/capabilities.js";

const glWith = (ext) => ({ getExtension: (name) => (name === ext ? {} : null) });

test("returns gpu when WebGL2 and float render targets are present", () => {
  const tier = detectTier({ getContext: () => glWith("EXT_color_buffer_float") });
  assert.equal(tier, TIER_GPU);
});

test("returns cpu when WebGL2 is unavailable", () => {
  assert.equal(detectTier({ getContext: () => null }), TIER_CPU);
});

test("returns cpu when float render targets are unavailable", () => {
  const tier = detectTier({ getContext: () => glWith("SOMETHING_ELSE") });
  assert.equal(tier, TIER_CPU);
});

test("returns cpu when context creation throws", () => {
  const tier = detectTier({
    getContext: () => {
      throw new Error("context lost");
    },
  });
  assert.equal(tier, TIER_CPU);
});

test("returns cpu when getExtension throws", () => {
  const tier = detectTier({
    getContext: () => ({
      getExtension: () => {
        throw new Error("bad driver");
      },
    }),
  });
  assert.equal(tier, TIER_CPU);
});
