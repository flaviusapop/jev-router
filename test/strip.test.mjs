import test from "node:test";
import assert from "node:assert/strict";
import { stripLengthHints } from "../src/policy.mjs";

// How short the reply should be says nothing about how hard the question is. Measured
// 2026-09-18: "One paragraph." alone moved a design question from opus to sonnet.
const stripped = [
  ["a trailing directive sentence", "Design how a dispatcher should decide. One paragraph.", "Design how a dispatcher should decide"],
  ["a hint after a dash", "figure out why — name the cause in one sentence", "figure out why — name the cause"],
  ["a hint after a comma", "explain the auth flow, briefly", "explain the auth flow"],
  ["a count of units mid-clause", "summarise this in 3 bullets", "summarise this"],
  ["a bare adverb at the end", "why does the cache miss, concisely", "why does the cache miss"],
  ["an explicit cap", "explain the retry logic in no more than 2 sentences", "explain the retry logic"],
];

for (const [name, input, want] of stripped) {
  test(`strips ${name}`, () => assert.equal(stripLengthHints(input), want));
}

// The same words describing the work itself must survive, or the request loses its meaning.
const kept = [
  ["an output format that is the task", "write a function that returns one line per row"],
  ["a transformation into units", "split the CSV into 3 lines"],
  ["'brief' as an adjective on a noun", "give me a brief history of the auth module"],
  ["'one line' as behaviour to implement", "refactor the parser so each rule emits one line"],
  ["an unrelated 'in'", "fix the typo in README.md"],
];

for (const [name, input] of kept) {
  test(`keeps ${name}`, () => assert.equal(stripLengthHints(input), input));
}

test("a prompt that is only a length hint is left alone, so something remains to judge", () => {
  for (const only of ["in one sentence", "be brief", "answer in two words"]) {
    assert.equal(stripLengthHints(only), only);
  }
});

test("a missing or non-string prompt is returned untouched", () => {
  assert.equal(stripLengthHints(""), "");
  assert.equal(stripLengthHints(undefined), undefined);
  assert.equal(stripLengthHints(null), null);
});

test("stripping is idempotent", () => {
  const once = stripLengthHints("explain the auth flow, briefly");
  assert.equal(stripLengthHints(once), once);
});
