// Every routing decision knob lives here, so the whole policy is reviewable in one file.
import { choice } from "@typesafe-ai/sdk";

/**
 * The four tiers, cheapest first, and what each one means on each supplier.
 *
 * A tier is a (model, effort) pair, not a model alone. Every supplier now sells reasoning
 * depth separately from model choice, so the top tier is usually the strong model thinking
 * harder rather than a different, pricier model - which is also why no tier bills anything
 * a normal subscription does not already cover.
 *
 * `family` is unrelated to the targets: it is the substring used to recognise whatever model
 * a CLI asked for, which may be an older version within the same tier such as
 * `claude-sonnet-4-6`, or a model the user picked by hand.
 *
 * `thinking` is a Claude capability flag. Haiku supports neither thinking nor effort, so both
 * are stripped when routing down to it; sending `effort` to Haiku 4.5 is a hard 400.
 */
export const TIERS = [
  {
    name: "haiku",
    family: "haiku",
    thinking: false,
    claude: { id: "claude-haiku-4-5-20251001", effort: null },
    codex: { id: "gpt-5.6-luna", effort: "low" },
    grok: { id: "grok-4.5", effort: "low" },
  },
  {
    name: "sonnet",
    family: "sonnet",
    thinking: true,
    claude: { id: "claude-sonnet-5", effort: "high" },
    codex: { id: "gpt-5.6-terra", effort: "medium" },
    grok: { id: "grok-4.5", effort: "high" },
  },
  {
    name: "opus",
    family: "opus",
    thinking: true,
    claude: { id: "claude-opus-5", effort: "high" },
    codex: { id: "gpt-5.6-sol", effort: "high" },
    grok: { id: "grok-4.6", effort: "high" },
  },
  {
    name: "fable",
    family: "fable",
    thinking: true,
    // The top tier is the strong model at a deeper effort, not a costlier model. Fable and
    // gpt-6-astra used to sit here; both bill extra credits on top of a subscription, so
    // neither is worth reaching for when the strong model can simply think longer.
    claude: { id: "claude-opus-5", effort: "xhigh" },
    codex: { id: "gpt-5.6-sol", effort: "xhigh" },
    grok: { id: "grok-4.6", effort: "xhigh" },
  },
];

export const TIER_NAMES = TIERS.map((t) => t.name);

export const rankOf = (name) => TIER_NAMES.indexOf(name);

/** Env var stem for a tier, kept in the vocabulary of the README rather than the tier ids. */
const ENV_LABEL = { haiku: "FAST", sonnet: "BALANCED", opus: "STRONG", fable: "LONG" };

/**
 * What a tier resolves to on one supplier, after environment overrides. Only the account
 * holder can see what their plan actually charges, so every model and every effort is
 * overridable: `JEV_CLAUDE_STRONG_EFFORT=max`, `JEV_CODEX_LONG_MODEL=gpt-6-astra`, and so on.
 *
 * @param {"claude"|"codex"|"grok"} provider
 * @param {string} tierName
 * @returns {?{id: string, effort: ?string}}
 */
export function target(provider, tierName) {
  const base = TIERS.find((t) => t.name === tierName)?.[provider];
  if (!base) return null;
  const stem = `JEV_${provider.toUpperCase()}_${ENV_LABEL[tierName]}`;
  return {
    id: process.env[`${stem}_MODEL`] ?? base.id,
    effort: process.env[`${stem}_EFFORT`] ?? base.effort,
  };
}

/** Claude's view of a tier: the capability flags plus the resolved model and effort. */
export const tierSpec = (name) => {
  const tier = TIERS.find((t) => t.name === name);
  return tier ? { ...tier, ...target("claude", name) } : undefined;
};

export const idOf = (name) => target("claude", name)?.id;

/**
 * Sentinel model id offered as an extra row in each CLI's model picker. Claude Code and Codex
 * send it verbatim because neither validates model names behind a custom base URL, so its
 * presence in a request is an exact signal that the user wants this turn routed. Any other
 * model means the user picked one themselves and it must be passed straight through. Grok
 * resolves ids against its own catalogue, so there the sentinel is registered in its config
 * instead - see `grok-cache.mjs`.
 */
export const AUTO_MODEL = "jev-auto";

/** Whether a request should be routed, or passed through as the user's own choice. */
export const isAuto = (model) => model === AUTO_MODEL;

/** Tier name for a model string a CLI sent, or null if we don't recognise it. */
export const tierOf = (model) =>
  TIERS.find((t) => typeof model === "string" && model.includes(t.family))?.name ?? null;

/**
 * Tiers the router may choose from. All four are on by default now that none of them reaches
 * for a model billed outside a normal subscription. `JEV_DISABLE_TIERS=fable,haiku` turns any
 * of them off, for a plan where one is not worth using.
 */
export const availableTiers = () => {
  const off = new Set(
    (process.env.JEV_DISABLE_TIERS ?? "")
      .split(",")
      .map((name) => name.trim().toLowerCase())
      .filter(Boolean),
  );
  return TIER_NAMES.filter((name) => !off.has(name));
};

export const THRESHOLDS = {
  /** Below this Jev confidence we refuse to downgrade and cap upgrades at `uncertainCeiling`. */
  minConfidence: 0.6,
  /** Safest tier to land on when Jev is unsure. */
  uncertainCeiling: "sonnet",
  /**
   * Switching models invalidates the prompt cache; the next turn re-sends the whole
   * conversation. Measured at ~23.6k cache-creation tokens switching into Opus, so a
   * downgrade only pays off while the conversation is still small.
   */
  downgradeMaxContextTokens: 20000,
  /**
   * Per-attempt Jev HTTP timeout and the hard wall-clock deadline for the whole routing
   * call. Measured: ~300-350ms warm, ~900-1000ms on the first call (TLS handshake), so the
   * deadline leaves room for one retry after a cold-start timeout.
   */
  jevTimeoutMs: 1500,
  jevDeadlineMs: 3000,
  jevMaxRetries: 1,
};

/**
 * Phrases that mean "the human already decided", checked against the raw prompt.
 *
 * Two vocabularies, because they carry very different risk. `NAMED` words are model and tier
 * ids that mean nothing else in a coding prompt, so they match on their own. `GENERIC` words
 * are ordinary English and must be followed by "tier" or "model" to count. Without that
 * guard, measured on 2026-09-19: `replace the int with long` reached for the deepest and most
 * expensive tier, `use strong typing here` reached for the strong model, and `the handler
 * runs on fast paths` quietly downgraded hard work to the cheap one.
 *
 * A named word may carry a whole model id around it, so `use claude-opus-5` and
 * `switch to gpt-5.6-sol` are read as the tier that model belongs to.
 */
const NAMED = {
  haiku: "haiku|luna",
  sonnet: "sonnet|terra",
  opus: "opus|sol",
  fable: "fable|astra",
};

const GENERIC = {
  haiku: "fast|cheap",
  sonnet: "balanced",
  opus: "strong",
  fable: "long|deep",
};

/** What a model id wraps around a name: `claude-` + `opus` + `-5`. */
const ID_PREFIX = String.raw`(?:[a-z0-9.]+-)*`;
const ID_SUFFIX = String.raw`(?:[-.][a-z0-9.\[\]]+)*`;

export const OVERRIDE_PATTERNS = TIERS.map((t) => ({
  tier: t.name,
  re: new RegExp(
    String.raw`\b(?:use|switch to|with|on)\s+(?:the\s+)?(?:` +
      `${ID_PREFIX}(?:${NAMED[t.name]})${ID_SUFFIX}` +
      "|" +
      String.raw`(?:${GENERIC[t.name]})\s+(?:tier|model)` +
      String.raw`)\b`,
    "i",
  ),
}));

export const QUESTIONS = {
  model_tier: choice(
    [
      "Pick the cheapest model tier that can fully complete this coding request in one pass, without a retry on a stronger model.",
      "Judge the reasoning the request demands, not the length of the reply it asks for. A request that wants a one-line answer to a hard debugging or design question still needs a strong model; a request for a long but mechanical edit does not.",
      "Words like 'briefly', 'in one sentence', 'one paragraph' or 'short answer' describe the output, never the difficulty. Judge the request exactly as if those words were absent.",
    ],
    {
      haiku: {
        what: "Trivial, mechanical, or purely factual work.",
        signals: [
          "Rename a symbol, fix a typo, reformat, add a comment",
          "Answer a short factual question about a known file",
          "Run one obvious command and report the output",
        ],
        not_for: "Anything requiring design judgement or multi-file reasoning.",
      },
      sonnet: {
        what: "Ordinary day-to-day engineering with a clear, bounded shape.",
        signals: [
          "Implement a well-specified function, endpoint, or component",
          "Write or fix tests for existing behaviour",
          "Localised bug fix where the cause is already understood",
        ],
        not_for: "Open-ended architecture, subtle concurrency, or deep unknown-cause debugging.",
      },
      opus: {
        what: "Hard reasoning, ambiguity, or high blast radius.",
        signals: [
          "Debug a failure whose cause is unknown",
          "Design or refactor across several modules",
          "Security, auth, concurrency, data-migration, or money-handling logic",
          "Weigh a trade-off and commit to one answer, however short that answer is asked to be",
        ],
        not_for: "Work that a competent mid-level engineer would finish without thinking hard.",
      },
      fable: {
        what: "The same strong model thinking substantially longer, for the hardest work.",
        signals: [
          "Whole-repo migration or framework upgrade",
          "A problem where a plausible-looking wrong answer would be expensive to catch",
          "Long autonomous execution across many steps that must stay coherent",
        ],
        not_for:
          "Anything the strong tier would get right at its normal depth. The extra thinking costs real tokens.",
      },
    },
  ),
};
