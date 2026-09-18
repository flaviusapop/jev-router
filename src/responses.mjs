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
    const prompt = cleanPrompt(textOf(item.content));
    if (prompt) return prompt;
  }
  return null;
}

/**
 * Stable per-conversation id, so a sub-agent and its parent keep separate routing state.
 * `prompt_cache_key` is what both CLIs send per session; the fallback covers a body that
 * predates it.
 */
export function conversationKey(body) {
  const stable =
    body?.prompt_cache_key ??
    body?.client_metadata?.["x-codex-turn-metadata"] ??
    `${body?.instructions ?? ""}|${textOf(body?.input?.find((item) => item?.role === "user")?.content)}`;
  return createHash("sha1").update(String(stable)).digest("hex").slice(0, 12);
}
