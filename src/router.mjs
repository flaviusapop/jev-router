import { TypeSafeClient } from "@typesafe-ai/sdk";
import { QUESTIONS, THRESHOLDS } from "./config.mjs";
import { stripLengthHints } from "./policy.mjs";
import { log } from "./log.mjs";

// The SDK's defaults (10s per attempt, 2 retries, no total budget) are far too slow for a
// per-prompt hot path, so the timeout, retry count and an outer deadline are all pinned.
// Built lazily because the constructor throws when no key is present, and a missing key
// should degrade to "no routing", not stop the session from starting.
let client;
export const TYPESAFE_BASE_URL = "https://api.typesafe.ai";

export function createJevClient(apiKey = process.env.JEV_API_KEY ?? process.env.TYPESAFE_API_KEY) {
  return new TypeSafeClient({
    apiKey,
    // Do not inherit TYPESAFE_BASE_URL. A classification request contains both the Jev key
    // and the user's prompt, so its destination is a security boundary rather than ordinary
    // SDK configuration.
    baseURL: TYPESAFE_BASE_URL,
    timeout: THRESHOLDS.jevTimeoutMs,
    retry: { maxRetries: THRESHOLDS.jevMaxRetries, backoffInitialMs: 150, backoffMaxMs: 400 },
    logLevel: "warn", // never "debug": request bodies contain the user's prompt
  });
}

function getClient() {
  client ??= createJevClient();
  return client;
}

/**
 * Asks Jev which tier fits this prompt. Returns null on any failure, which the policy
 * layer reads as "keep the current model" — routing must never block a prompt.
 *
 * Only the request is sent. Measured on 2026-09-18 against four prompts spanning all four
 * tiers, adding the current model, the context size or the available tiers changed no choice
 * and lowered confidence on three of the four — they read as noise, not signal. The current
 * model and context size are still used, but by `decide()`, where they are code-side gates
 * rather than hints; the available tiers are enforced there too, by `clampToAvailable`.
 *
 * `current`, `contextTokens` and `available` stay in the signature because the caller has
 * them and the policy layer needs them; they are simply no longer Jev's business.
 *
 * @returns {Promise<?{choice: string, confidence: number, probabilities: object, ms: number}>}
 */
export async function askJev({ prompt, current, contextTokens, available }) {
  const started = Date.now();
  const abort = new AbortController();
  const deadline = setTimeout(() => abort.abort(), THRESHOLDS.jevDeadlineMs);
  try {
    const result = await getClient().systemOne(
      {
        state: { request: stripLengthHints(prompt) },
        questions: QUESTIONS,
      },
      { signal: abort.signal },
    );
    const answer = result.answers.model_tier;
    return { ...answer, ms: Date.now() - started };
  } catch (err) {
    log(`routing failed, keeping ${current}: ${err.message}`);
    return null;
  } finally {
    clearTimeout(deadline);
  }
}
