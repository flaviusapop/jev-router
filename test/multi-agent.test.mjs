import test from "node:test";
import assert from "node:assert/strict";
import { conversationKey, isAgentSession, newTurnPrompt } from "../src/responses.mjs";

// Shapes measured on 2026-09-19 against the real CLIs, with JEV_DUMP capturing every request.
// Codex ran `jev-codex exec` on a prompt that forced a `SpawnAgent`; Grok ran `jev-grok -p`
// with `--max-turns 10` on the same task. The point of these tests is that the two CLIs
// identify a sub-agent differently, and only one of them can be trusted to change the cache key.

const codexParent = {
  model: "jev-auto",
  prompt_cache_key: "01a0b47e-ac01-73c3-9c07-8bb0e76273bf",
  client_metadata: {
    thread_id: "01a0b47e-ac01-73c3-9c07-8bb0e76273bf",
    "x-codex-window-id": "01a0b47e-ac01-73c3-9c07-8bb0e76273bf:0",
  },
  input: [{ role: "user", content: [{ type: "input_text", text: "Delegate the search to a subagent" }] }],
};

const codexSubagent = {
  model: "jev-auto",
  // Codex leaves the *parent's* cache key on a sub-agent's requests.
  prompt_cache_key: "01a0b47e-ac01-73c3-9c07-8bb0e76273bf",
  client_metadata: {
    thread_id: "01a0b47e-c849-73d2-b782-37cb913b6f05",
    "x-codex-window-id": "01a0b47e-c849-73d2-b782-37cb913b6f05:0",
    "x-openai-subagent": "true",
    "x-codex-parent-thread-id": "01a0b47e-ac01-73c3-9c07-8bb0e76273bf",
  },
  input: [{ role: "user", content: [{ type: "input_text", text: "Search for stripLengthHints" }] }],
};

test("a Codex sub-agent is a separate conversation from its parent", () => {
  // Before this, both routed under one key: the sub-agent's tier overwrote the parent's, and
  // the parent was then told its prompt cache had been built on the sub-agent's model.
  assert.notEqual(conversationKey(codexParent), conversationKey(codexSubagent));
});

test("a Codex turn that omits thread_id still keys off its window", () => {
  const { thread_id, ...rest } = codexSubagent.client_metadata;
  const windowOnly = { ...codexSubagent, client_metadata: rest };
  assert.equal(conversationKey(windowOnly), conversationKey(codexSubagent));
});

test("the parent keeps one key across the whole session", () => {
  const later = {
    ...codexParent,
    client_metadata: { ...codexParent.client_metadata, turn_id: "a-later-turn" },
  };
  assert.equal(conversationKey(later), conversationKey(codexParent));
});

test("a finished sub-agent's handback is not a new turn", () => {
  // Codex returns the result as a `user` message, not a tool result, so it arrives looking
  // like something the human typed. Routing it re-asks Jev on machine-written JSON.
  const handback = {
    ...codexParent,
    input: [
      ...codexParent.input,
      { type: "function_call", call_id: "1" },
      { type: "function_call_output", call_id: "1", output: "spawned" },
      {
        role: "user",
        content: [{
          type: "input_text",
          text: '<subagent_notification>\n{"agent_path":"01a0b47e-c849","status":{"completed":"Found it."}}\n</subagent_notification>',
        }],
      },
    ],
  };
  assert.equal(newTurnPrompt(handback), null);
});

test("a user turn that merely mentions subagents is still a turn", () => {
  assert.equal(
    newTurnPrompt({ input: [{ role: "user", content: "Use a subagent to find stripLengthHints" }] }),
    "Use a subagent to find stripLengthHints",
  );
});

test("a Grok sub-agent already arrives with its own cache key", () => {
  // Grok sends no client_metadata at all, but gives each agent its own session uuid, so the
  // parent and the sub-agent separate without any help.
  const parent = { prompt_cache_key: "01a0b47d-308c-70f3-be66-451430218bc5" };
  const sub = { prompt_cache_key: "01a0b47d-4d8f-7721-8031-c256e4786813" };
  assert.notEqual(conversationKey(parent), conversationKey(sub));
});

test("a session_title errand is not an agent session", () => {
  // Grok fires one per agent, including per sub-agent, and it inherits the sentinel. It has
  // no thread and no cache key, which is what tells it apart from a turn.
  const title = {
    model: "jev-auto",
    max_output_tokens: 100,
    tool_choice: { type: "function", name: "session_title" },
    tools: [{ name: "session_title" }],
    input: [
      { role: "system", content: "Write a short title." },
      { role: "user", content: "<user_query> Use a subagent to search this repository </user_query>" },
    ],
  };
  assert.equal(isAgentSession(title), false);
  assert.equal(isAgentSession(codexParent), true);
  assert.equal(isAgentSession(codexSubagent), true);
  assert.equal(isAgentSession({ prompt_cache_key: "01a0b47d-308c" }), true);
});
