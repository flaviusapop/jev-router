import test from "node:test";
import assert from "node:assert/strict";
import { isSubagentSpawn } from "../src/proxy.mjs";

// Claude Code resolves a sub-agent's model at spawn time and sends that id, so a sub-agent and
// a /model pick are indistinguishable at the model field. The conversation tells them apart.
const scene = (over = {}) => ({
  session: "s1",
  key: "new-key",
  routedSessions: new Set(["s1"]),
  convos: new Map([["main-key", { tier: "haiku" }]]),
  prompt: "Search the repository for where stripLengthHints is defined",
  ...over,
});

test("a new conversation inside a routed session is a sub-agent", () => {
  assert.equal(isSubagentSpawn(scene()), true);
});

test("the conversation the user picked a model in is not a sub-agent", () => {
  // Measured live: this is the case that must keep beating the router.
  assert.equal(isSubagentSpawn(scene({ key: "main-key" })), false);
});

test("a session we never routed is left alone entirely", () => {
  // Plain `claude` against this proxy, or a session that never sent the sentinel.
  assert.equal(isSubagentSpawn(scene({ routedSessions: new Set() })), false);
});

test("an auxiliary call is not a sub-agent, however new its conversation", () => {
  // Titles, summaries and typeahead carry no tools, so newTurnPrompt gives null. Routing them
  // would pin Claude Code's own cheap Haiku calls up to a tier.
  assert.equal(isSubagentSpawn(scene({ prompt: null })), false);
  assert.equal(isSubagentSpawn(scene({ prompt: "" })), false);
});

test("a sub-agent in one session is not confused with another session", () => {
  assert.equal(isSubagentSpawn(scene({ session: "s2" })), false);
});

test("the answer is always a boolean, never a Set or a Map", () => {
  // The caller uses it in a condition beside isAuto(); a truthy Map would silently pass.
  for (const over of [{}, { prompt: null }, { key: "main-key" }]) {
    assert.equal(typeof isSubagentSpawn(scene(over)), "boolean");
  }
});
