import test from "node:test";
import assert from "node:assert/strict";
import { opencodeConfig, picksModel, sentinelLimits, writeConfig } from "../src/opencode-cli.mjs";
import { conversationKey, newTurnPrompt, sessionOf } from "../src/proxy.mjs";
import { readFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Shapes measured on 2026-09-18 against opencode 1.18.29, with a recording proxy in front of
// its Anthropic provider. opencode speaks the Anthropic Messages API - `llm.runtime=ai-sdk
// llm.provider=anthropic` in its own logs - so the Claude proxy serves it unchanged. What
// differs is where the session lives: a header, not the body.

test("opencode's session id comes from the header, not the body", () => {
  assert.equal(
    sessionOf({}, { "x-session-id": "ses_f4b42dee0ffeAq6pqOOkcBASvH" }),
    "ses_f4b42dee0ffeAq6pqOOkcBASvH",
  );
  assert.equal(sessionOf({}, {}), "");
});

test("Claude Code's embedded session still wins over a header", () => {
  const body = { metadata: { user_id: JSON.stringify({ session_id: "from-body" }) } };
  assert.equal(sessionOf(body, { "x-session-id": "from-header" }), "from-body");
});

test("a header that arrives as a list is still one session", () => {
  assert.equal(sessionOf({}, { "x-session-id": ["ses_a", "ses_b"] }), "ses_a");
});

test("an opencode sub-agent is a separate conversation from its parent", () => {
  // opencode gives every agent its own session, so no heuristic is needed: the `task` spawn
  // ran under ses_f4b42d49... while its parent stayed on ses_f4b42dee...
  const body = { messages: [{ role: "user", content: "same opening text" }] };
  const parent = conversationKey(body, { "x-session-id": "ses_f4b42dee0ffeAq6pqOOkcBASvH" });
  const child = conversationKey(body, { "x-session-id": "ses_f4b42d493ffecUr3qkhQJVPBK8" });
  assert.notEqual(parent, child);
});

test("opencode's title errand is already excluded", () => {
  // It carries no tools, which is the rule that was already there for Claude Code's own
  // auxiliary calls. Nothing extra was needed.
  const title = {
    model: "claude-haiku-4-5-20251001",
    max_tokens: 48000,
    system: [{ type: "text", text: "You are a title generator." }],
    messages: [{ role: "user", content: "say hi" }],
  };
  assert.equal(newTurnPrompt(title), null);
});

test("a real opencode turn is read as one", () => {
  const turn = {
    model: "jev-auto",
    tools: [{ name: "bash" }, { name: "read" }],
    messages: [{ role: "user", content: [{ type: "text", text: "say hi" }] }],
  };
  assert.equal(newTurnPrompt(turn), "say hi");
});

test("the config points opencode at the proxy and declares the sentinel", () => {
  const cfg = opencodeConfig(4242);
  assert.equal(cfg.model, "anthropic/jev-auto");
  assert.equal(cfg.provider.anthropic.options.baseURL, "http://127.0.0.1:4242/v1");
  const model = cfg.provider.anthropic.models["jev-auto"];
  assert.equal(model.tool_call, true);
  assert.equal(model.reasoning, true);
  assert.deepEqual(model.limit, sentinelLimits());
  // small_model is left alone on purpose: its calls carry no tools and are never routed.
  assert.equal(cfg.small_model, undefined);
});

test("the declared limits fit the smallest tier the router may pick", () => {
  // Claiming a window Haiku cannot serve is a hard 400 the moment a turn routes down to it.
  const { context, output } = sentinelLimits();
  assert.ok(context <= 200000, "Haiku 4.5 tops out at a 200k context");
  assert.ok(output <= 64000, "Haiku 4.5 tops out at 64k of output");
});

test("the config is written where OPENCODE_CONFIG can find it", () => {
  const dir = mkdtempSync(join(tmpdir(), "jev-oc-"));
  const file = writeConfig(7777, dir);
  assert.equal(file, join(dir, "opencode.json"));
  assert.equal(JSON.parse(readFileSync(file, "utf8")).provider.anthropic.options.baseURL,
    "http://127.0.0.1:7777/v1");
});

test("a model the user named themselves stands the router down", () => {
  assert.equal(picksModel(["--model", "anthropic/claude-opus-5"]), true);
  assert.equal(picksModel(["-m", "openai/gpt-5.6-sol"]), true);
  assert.equal(picksModel(["--model=anthropic/claude-opus-5"]), true);
  assert.equal(picksModel(["run", "fix the bug"]), false);
});

test("every CLI that must be told a window is told the same one", async () => {
  // A turn can be routed down to Haiku at any point, so the smallest window is the only one a
  // routed session may assume. Two CLIs need the number; it is stated once.
  const { SMALLEST_CONTEXT_TOKENS } = await import("../src/config.mjs");
  assert.equal(sentinelLimits().context, SMALLEST_CONTEXT_TOKENS);
  const source = await import("node:fs").then((fs) =>
    fs.readFileSync(new URL("../bin/jev-claude.mjs", import.meta.url), "utf8"));
  assert.match(source, /CLAUDE_CODE_MAX_CONTEXT_TOKENS/, "Claude Code has to be told too");
  assert.match(source, /SMALLEST_CONTEXT_TOKENS/, "and told the shared number, not a literal");
});

test("a window the user set themselves is left alone", async () => {
  const source = await import("node:fs").then((fs) =>
    fs.readFileSync(new URL("../bin/jev-claude.mjs", import.meta.url), "utf8"));
  assert.match(source, /if \(!process\.env\.CLAUDE_CODE_MAX_CONTEXT_TOKENS\)/);
});
