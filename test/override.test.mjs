import test from "node:test";
import assert from "node:assert/strict";
import { detectOverride } from "../src/policy.mjs";

// An override skips Jev entirely and pins the tier, so a false positive is expensive in both
// directions: a wrong `fable` spends the deepest effort on nothing, a wrong `haiku` hands hard
// work to the cheap model. The false positives below were all measured on 2026-09-19.

test("a tier named outright is honoured", () => {
  for (const [prompt, tier] of [
    ["use opus for this", "opus"],
    ["Use Opus: refactor the auth module", "opus"],
    ["switch to haiku and fix the typo", "haiku"],
    ["run it on sonnet please", "sonnet"],
    ["do this with fable", "fable"],
  ]) {
    assert.equal(detectOverride(prompt), tier, prompt);
  }
});

test("a whole model id is read as the tier it belongs to", () => {
  assert.equal(detectOverride("use claude-opus-5"), "opus");
  assert.equal(detectOverride("switch to gpt-5.6-sol"), "opus");
  assert.equal(detectOverride("use claude-haiku-4-5-20251001"), "haiku");
});

test("an ordinary word counts only when it names a tier or a model", () => {
  assert.equal(detectOverride("use the strong model"), "opus");
  assert.equal(detectOverride("use the fast tier"), "haiku");
  assert.equal(detectOverride("run this on the long tier"), "fable");
  assert.equal(detectOverride("use the cheap model for this"), "haiku");
});

test("ordinary English about code is not a model choice", () => {
  // Each of these used to pin a tier. The first is the worst: four words of C, and the turn
  // ran at the deepest effort the account can buy.
  for (const prompt of [
    "replace the int with long",
    "migrate the column to long",
    "rewrite this with deep nesting removed",
    "refactor with deep care",
    "use strong typing here",
    "the handler runs on fast paths",
    "the cache is on fast storage",
    "balanced trees are on the syllabus",
  ]) {
    assert.equal(detectOverride(prompt), null, prompt);
  }
});

test("a name that merely starts another word is not a match", () => {
  assert.equal(detectOverride("use terraform to provision this"), null);
  assert.equal(detectOverride("deploy with lunar phase logic"), null);
});

test("naming a tier without asking for it does not count", () => {
  // No directive verb, so nothing was actually requested.
  assert.equal(detectOverride("opus, please refactor this"), null);
  assert.equal(detectOverride("use the model that fits"), null);
});

test("a missing prompt is not an override", () => {
  assert.equal(detectOverride(undefined), null);
  assert.equal(detectOverride(""), null);
});
