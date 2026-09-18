import test from "node:test";
import assert from "node:assert/strict";
import { TIERS, TIER_NAMES, availableTiers, idOf, target, tierSpec } from "../src/config.mjs";

test("every tier resolves to a model and an effort on all three suppliers", () => {
  const ladder = Object.fromEntries(
    TIER_NAMES.map((name) => [
      name,
      Object.fromEntries(["claude", "codex", "grok"].map((p) => [p, target(p, name)])),
    ]),
  );
  assert.deepEqual(ladder, {
    haiku: {
      claude: { id: "claude-haiku-4-5-20251001", effort: null },
      codex: { id: "gpt-5.6-luna", effort: "low" },
      grok: { id: "grok-4.5", effort: "low" },
    },
    sonnet: {
      claude: { id: "claude-sonnet-5", effort: "high" },
      codex: { id: "gpt-5.6-terra", effort: "medium" },
      grok: { id: "grok-4.5", effort: "high" },
    },
    opus: {
      claude: { id: "claude-opus-5", effort: "high" },
      codex: { id: "gpt-5.6-sol", effort: "high" },
      grok: { id: "grok-4.6", effort: "high" },
    },
    fable: {
      claude: { id: "claude-opus-5", effort: "xhigh" },
      codex: { id: "gpt-5.6-sol", effort: "xhigh" },
      grok: { id: "grok-4.6", effort: "xhigh" },
    },
  });
});

test("no tier reaches for a model billed outside a normal subscription", () => {
  const billed = [/fable/i, /astra/i, /mythos/i];
  for (const tier of TIERS) {
    for (const provider of ["claude", "codex", "grok"]) {
      const { id } = target(provider, tier.name);
      for (const pattern of billed) {
        assert.ok(!pattern.test(id), `${tier.name}/${provider} resolves to ${id}`);
      }
    }
  }
});

test("the top tier is the strong tier thinking harder, on every supplier", () => {
  for (const provider of ["claude", "codex", "grok"]) {
    const strong = target(provider, "opus");
    const long = target(provider, "fable");
    assert.equal(long.id, strong.id, `${provider} should not change model for the long tier`);
    assert.notEqual(long.effort, strong.effort, `${provider} long tier should think harder`);
  }
});

test("a tier's family still names the model a CLI might have picked by hand", () => {
  // `fable` targets Opus now, but the family is how a manually chosen Fable is recognised.
  assert.equal(TIERS.find((t) => t.name === "fable").family, "fable");
  assert.equal(tierSpec("fable").id, "claude-opus-5");
});

test("any model or effort can be overridden from the environment", () => {
  process.env.JEV_CLAUDE_STRONG_EFFORT = "max";
  process.env.JEV_CODEX_LONG_MODEL = "gpt-6-astra";
  process.env.JEV_GROK_FAST_MODEL = "grok-4.6";
  try {
    assert.deepEqual(target("claude", "opus"), { id: "claude-opus-5", effort: "max" });
    assert.equal(idOf("opus"), "claude-opus-5");
    assert.equal(tierSpec("opus").effort, "max");
    assert.deepEqual(target("codex", "fable"), { id: "gpt-6-astra", effort: "xhigh" });
    assert.deepEqual(target("grok", "haiku"), { id: "grok-4.6", effort: "low" });
  } finally {
    delete process.env.JEV_CLAUDE_STRONG_EFFORT;
    delete process.env.JEV_CODEX_LONG_MODEL;
    delete process.env.JEV_GROK_FAST_MODEL;
  }
});

test("an unknown tier or supplier resolves to nothing rather than a guess", () => {
  assert.equal(target("claude", "nonsense"), null);
  assert.equal(target("nonsense", "opus"), null);
  assert.equal(tierSpec("nonsense"), undefined);
});

test("all four tiers are available by default and any can be switched off", () => {
  assert.deepEqual(availableTiers(), ["haiku", "sonnet", "opus", "fable"]);
  process.env.JEV_DISABLE_TIERS = "fable, HAIKU";
  try {
    assert.deepEqual(availableTiers(), ["sonnet", "opus"]);
  } finally {
    delete process.env.JEV_DISABLE_TIERS;
  }
});
