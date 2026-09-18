import test from "node:test";
import assert from "node:assert/strict";
import { decide } from "../src/policy.mjs";
import { THRESHOLDS } from "../src/config.mjs";

const ALL = ["haiku", "sonnet", "opus", "fable"];
const BIG = THRESHOLDS.downgradeMaxContextTokens + 1;
const NEEDED = THRESHOLDS.downgradeAfterCheapTurns;

/** Runs a sequence of Jev answers through one conversation, carrying the streak. */
function session(answers, { current = "opus", contextTokens = BIG } = {}) {
  let cheapStreak = 0;
  const trace = [];
  for (const jev of answers) {
    const out = decide({ prompt: "what is the weather", jev, current, available: ALL, contextTokens, cheapStreak });
    current = out.tier;
    cheapStreak = out.cheapStreak;
    trace.push(out);
  }
  return trace;
}

const cheap = { choice: "haiku", confidence: 0.95 };
const unsure = { choice: "haiku", confidence: 0.3 };
const hard = { choice: "opus", confidence: 0.95 };

test("a run of confident cheap turns eventually brings the session down", () => {
  // Measured 2026-09-19 before this existed: one hard turn pinned a session to the top tier
  // while Jev asked for the cheapest at 0.99, four turns running, because the cache-rebuild
  // guard blocked downgrades and nothing blocked upgrades.
  const trace = session(Array(NEEDED).fill(cheap));
  assert.deepEqual(trace.map((t) => t.tier), [...Array(NEEDED - 1).fill("opus"), "haiku"]);
  assert.equal(trace.at(-1).reason, "cheap-streak");
});

test("the session does not come down before the run is long enough", () => {
  const trace = session(Array(NEEDED - 1).fill(cheap));
  assert.ok(trace.every((t) => t.tier === "opus"));
  assert.match(trace.at(-1).reason, /downgrade-not-worth-cache-rebuild/);
});

test("the refusal says how far along the run is", () => {
  const [first] = session([cheap]);
  assert.match(first.reason, new RegExp(`\(1/${NEEDED}\)`));
});

test("one hard turn in the middle breaks the run", () => {
  const trace = session([cheap, cheap, hard, cheap, cheap]);
  assert.ok(trace.every((t) => t.tier === "opus"), "never comes down");
  assert.equal(trace.at(-1).cheapStreak, 2, "the count restarted after the hard turn");
});

test("an uncertain turn neither builds the run nor breaks it", () => {
  // Low confidence is not evidence the session has gone quiet, but it is not evidence of hard
  // work either, so the count is carried across untouched.
  const trace = session([cheap, unsure, cheap]);
  assert.deepEqual(trace.map((t) => t.cheapStreak), [1, 1, 2]);
  assert.equal(trace[1].reason, "low-confidence-no-downgrade/no-change");
});

test("Jev being unreachable leaves the run exactly as it was", () => {
  const trace = session([cheap, null, cheap]);
  assert.deepEqual(trace.map((t) => t.cheapStreak), [1, 1, 2]);
});

test("a small conversation still comes down at once, with no run needed", () => {
  const [only] = session([cheap], { contextTokens: 0 });
  assert.equal(only.tier, "haiku");
  assert.equal(only.reason, "jev");
  assert.equal(only.cheapStreak, 0);
});

test("coming down clears the run, so the next rebuild has to be earned again", () => {
  const trace = session([...Array(NEEDED).fill(cheap), hard, cheap]);
  assert.equal(trace[NEEDED - 1].tier, "haiku");
  assert.equal(trace[NEEDED - 1].cheapStreak, 0);
  assert.equal(trace[NEEDED].tier, "opus", "a hard turn still goes up at once");
  assert.equal(trace[NEEDED + 1].cheapStreak, 1, "and the run starts over");
});

test("upgrades are never delayed by any of this", () => {
  const trace = session([hard], { current: "haiku" });
  assert.equal(trace[0].tier, "opus");
  assert.equal(trace[0].reason, "jev");
});
