// Shared helpers for CLIs that speak the OpenAI Responses API. Codex and Grok send the same
// request shape - `input` items, `prompt_cache_key`, `reasoning.effort` - so the logic that
// decides *whether* a request is a fresh user turn, and which conversation it belongs to, is
// identical for both. Only the model catalogue and the tier table differ per provider.
import { createHash } from "node:crypto";

/** Plain text of an input item's content, whether it is a string or typed blocks. */
export const textOf = (content) => {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((item) => item?.type === "text" || item?.type === "input_text")
    .map((item) => item.text)
    .join("\n");
};

/**
 * Strips the scaffolding a CLI wraps around what the human actually typed. Reminders and
 * environment blocks are injected on every turn, so leaving them in would make each prompt
 * look alike to Jev; `<user_query>` is Grok's wrapper around the real request and only its
 * tags are removed, never its contents.
 */
export const cleanPrompt = (text) =>
  text
    .replace(/<system[-_]reminder>[\s\S]*?<\/system[-_]reminder>/gi, "")
    .replace(/<current_datetime>[\s\S]*?<\/current_datetime>/gi, "")
    .replace(/<user_info>[\s\S]*?<\/user_info>/gi, "")
    .replace(/<environment_context>[\s\S]*?<\/environment_context>/gi, "")
    .replace(/<\/?user_query>/gi, "")
    .trim();

/**
 * User text that starts a new turn, or null for a tool continuation. Scanning backwards
 * stops at the first tool result, because everything after one belongs to a turn that was
 * already routed: switching models mid tool-loop would hand a half-finished job to a
 * different model.
 */
export function newTurnPrompt(body) {
  if (!Array.isArray(body?.input)) return null;
  for (const item of [...body.input].reverse()) {
    if (item?.type === "function_call_output" || item?.type === "custom_tool_call_output") return null;
    if (item?.role !== "user") continue;
    const text = textOf(item.content);
    // Codex hands a finished sub-agent's result back to its parent as a `user` message rather
    // than a tool result, so it reaches here looking like something the human typed. It is the
    // tail of the parent's own turn, already routed; measured 2026-09-19, routing it spent a
    // second Jev call on machine-written JSON and could move the parent mid-task.
    if (/<subagent_notification>/i.test(text)) return null;
    const prompt = cleanPrompt(text);
    if (prompt) return prompt;
  }
  return null;
}

/**
 * The conversation a request belongs to, which for these CLIs means the agent: a sub-agent
 * must not share its parent's routing state, or each would overwrite the other's tier and
 * each would be told the wrong model its prompt cache was built on.
 *
 * `thread_id` is preferred over `prompt_cache_key` because Codex gives a sub-agent its own
 * thread but leaves the cache key set to the parent's. Measured 2026-09-19: a sub-agent and
 * its parent shared `01a0b47e-ac01-...` as a cache key while their threads were `...-ac01-...`
 * and `...-c849-...`. Grok sends no `client_metadata` at all and already gives each agent its
 * own cache key, so it falls through to the next source untouched.
 */
export function conversationKey(body) {
  const meta = body?.client_metadata;
  // The window id is the thread id with a pane suffix, and is sent on turns that omit `thread_id`.
  const window = String(meta?.["x-codex-window-id"] ?? "").split(":")[0];
  const stable =
    meta?.thread_id ||
    window ||
    body?.prompt_cache_key ||
    meta?.["x-codex-turn-metadata"] ||
    `${body?.instructions ?? ""}|${textOf(body?.input?.find((item) => item?.role === "user")?.content)}`;
  return createHash("sha1").update(String(stable)).digest("hex").slice(0, 12);
}

/**
 * Whether this request belongs to an agent session at all.
 *
 * Both CLIs fire small side requests on the side of a session - Grok asks for a session title
 * with `tool_choice` pinned to one function and a 100-token cap - and those carry neither a
 * thread nor a cache key. They are not turns and must not be routed: measured 2026-09-19, a
 * sub-agent's title call inherited the sentinel and spent a full Jev call, and a routed tier,
 * on writing a title.
 */
export function isAgentSession(body) {
  const meta = body?.client_metadata;
  return Boolean(meta?.thread_id || meta?.["x-codex-window-id"] || body?.prompt_cache_key);
}
