import { TIER_NAMES, THRESHOLDS, OVERRIDE_PATTERNS, rankOf } from "./config.mjs";

/**
 * How short the reply should be, which says nothing about how hard the question is. Jev is
 * told to ignore these (see `QUESTIONS` in config.mjs) and mostly does, but the instruction
 * does not always win: measured on 2026-09-18, appending "One paragraph." to a dispatcher
 * design question moved it from opus 0.54 to sonnet 0.37 — a full tier, for four words that
 * changed nothing about the thinking required. Removing them beats arguing with them.
 *
 * Each pattern is anchored to a directive, not to the words alone, so "return one line per
 * row" and "a brief history of the auth module" survive: a hint only matches as its own
 * clause or at the very end, which is where an instruction to the model actually lives.
 */
const LENGTH_HINTS = [
  /(?:^|[.,;—-]\s*)(?:please\s+)?(?:answer|reply|respond|explain|describe|summari[sz]e)\s+(?:me\s+)?(?:in|with|using)\s+(?:just\s+|only\s+|no\s+more\s+than\s+|at\s+most\s+|under\s+)?(?:a\s+|one\s+|two\s+|three\s+|\d+\s+)?(?:short\s+|single\s+|brief\s+)?(?:words?|lines?|sentences?|paragraphs?|bullets?)\b[^.]*\.?/gi,
  /(?:^|[.,;—-]\s*)(?:in|keep\s+it\s+to|no\s+more\s+than|at\s+most|under|max(?:imum)?(?:\s+of)?)\s+(?:a\s+|one\s+|two\s+|three\s+|\d+\s+)(?:short\s+|single\s+|brief\s+)?(?:words?|lines?|sentences?|paragraphs?|bullets?)\b[^.]*\.?/gi,
  /(?:^|[.,;—-]\s*)(?:one|a\s+single|two|three|\d+)\s+(?:short\s+|brief\s+)?(?:words?|lines?|sentences?|paragraphs?|bullets?)\s*(?:only|max|maximum)?\s*\.?\s*$/gi,
  /(?:^|[.,;—-]\s*)(?:please\s+)?(?:be\s+(?:brief|concise|short|terse)|keep\s+it\s+(?:brief|concise|short|terse)|briefly|concisely|tl;?dr|short\s+answer|in\s+short)\b[^.]*\.?/gi,
  // A count of units trailing the real request ("...name the cause in one sentence"), which the
  // patterns above miss because the hint starts mid-clause rather than after a delimiter. Only
  // "in", and only at the very end: "split the CSV into 3 lines" is the work, not the reply.
  /\s+in\s+(?:no\s+more\s+than\s+|at\s+most\s+|under\s+|about\s+|around\s+|roughly\s+)?(?:a|one|two|three|\d+)\s+(?:short\s+|single\s+|brief\s+)?(?:words?|lines?|sentences?|paragraphs?|bullets?)\s*(?:only|max|maximum)?\s*\.?\s*$/gi,
];

/**
 * The prompt as Jev should see it: the work, without instructions about the shape of the
 * reply. Returns the original whenever stripping would leave nothing meaningful behind, so a
 * prompt that is *only* a length instruction is still judged on something.
 */
export function stripLengthHints(prompt) {
  if (typeof prompt !== "string" || !prompt) return prompt;
  let out = prompt;
  for (const re of LENGTH_HINTS) out = out.replace(re, " ");
  out = out.replace(/\s+/g, " ").replace(/\s+([.,;!?])/g, "$1").trim();
  return out.length >= 8 ? out : prompt;
}

/** The tier the user named explicitly in the prompt, or null. */
export function detectOverride(prompt) {
  const hit = OVERRIDE_PATTERNS.find((p) => p.re.test(prompt ?? ""));
  return hit ? hit.tier : null;
}

/**
 * Nearest tier the account can actually run. Prefers stepping up rather than down so we
 * never silently hand a hard task to a weaker model, but never steps up into `fable`
 * (which bills extra usage credits) unless that is what was asked for.
 */
function clampToAvailable(tier, available) {
  if (available.includes(tier)) return tier;
  const rank = rankOf(tier);
  const up = TIER_NAMES.filter(
    (t, i) => i > rank && available.includes(t) && (t !== "fable" || tier === "fable"),
  );
  if (up.length) return up[0];
  const down = TIER_NAMES.filter((t, i) => i < rank && available.includes(t));
  return down.length ? down[down.length - 1] : null;
}

/**
 * Turns a Jev answer into the model we will actually run. Pure and total: any missing,
 * malformed, or unavailable input falls back to the model already in use.
 *
 * @param {object} input
 * @param {string} input.prompt        raw user prompt, for explicit-override detection
 * @param {?{choice: string, confidence: number}} input.jev  null when Jev failed
 * @param {string} input.current       tier currently active in the session
 * @param {string[]} input.available   tier names the account can run
 * @param {number} input.contextTokens approximate size of the conversation so far
 * @returns {{tier: string, reason: string, changed: boolean}}
 */
export function decide({ prompt, jev, current, available, contextTokens = 0 }) {
  const settle = (tier, reason) => {
    const final = clampToAvailable(tier, available) ?? current;
    const why = final === tier ? reason : `${reason}+unavailable`;
    return { tier: final, reason: final === current ? `${why}/no-change` : why, changed: final !== current };
  };

  const override = detectOverride(prompt);
  if (override) return settle(override, "override");

  if (!jev || !TIER_NAMES.includes(jev.choice)) return settle(current, "jev-unavailable");

  let target = jev.choice;

  if (jev.confidence < THRESHOLDS.minConfidence) {
    if (rankOf(target) < rankOf(current)) return settle(current, "low-confidence-no-downgrade");
    const ceiling = Math.max(rankOf(current), rankOf(THRESHOLDS.uncertainCeiling));
    if (rankOf(target) > ceiling) return settle(TIER_NAMES[ceiling], "low-confidence-capped");
  }

  if (rankOf(target) < rankOf(current) && contextTokens > THRESHOLDS.downgradeMaxContextTokens) {
    return settle(current, "downgrade-not-worth-cache-rebuild");
  }

  return settle(target, "jev");
}
