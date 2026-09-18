#!/usr/bin/env node
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, accessSync, constants } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { startProxy } from "../src/proxy.mjs";
import { AUTO_MODEL, SMALLEST_CONTEXT_TOKENS } from "../src/config.mjs";
import { readSavedModel, restoreSavedModel } from "../src/settings.mjs";
import { LOG_FILE } from "../src/log.mjs";
import { which, missingMessage, shellSafe } from "../src/which.mjs";
import { loadEnv, jevKey, ENV_FILE_HINT } from "../src/env.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * Registers "Jev Router" as an extra row in Claude Code's /model picker and starts the session
 * on it. Claude Code sends the id verbatim because it does not validate model names behind a
 * custom base URL, which is what lets the proxy tell "route this" from "the user picked a
 * model". Capabilities are declared so Claude Code still composes thinking and effort for
 * the tiers that support them; the proxy strips what the routed model cannot accept.
 */
function autoModelEnv() {
  const env = {
    ANTHROPIC_CUSTOM_MODEL_OPTION: AUTO_MODEL,
    ANTHROPIC_CUSTOM_MODEL_OPTION_NAME: "Jev Router",
    ANTHROPIC_CUSTOM_MODEL_OPTION_DESCRIPTION: "Route each turn to the cheapest model that can do it",
    ANTHROPIC_CUSTOM_MODEL_OPTION_SUPPORTED_CAPABILITIES:
      "thinking,adaptive_thinking,interleaved_thinking,effort,max_effort",
  };
  // ANTHROPIC_MODEL applies to this session only and is never written to settings, so the
  // default costs the user nothing permanent. A model they set themselves still wins.
  if (!process.env.ANTHROPIC_MODEL) env.ANTHROPIC_MODEL = AUTO_MODEL;
  // Claude Code cannot look the sentinel up in its catalogue, so from v2.1.277 it says so on
  // every start and assumes 200k. That assumption is right - a turn can land on Haiku at any
  // point - but it is worth stating rather than being guessed, which also settles the warning.
  if (!process.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS) {
    env.CLAUDE_CODE_MAX_CONTEXT_TOKENS = String(SMALLEST_CONTEXT_TOKENS);
  }
  return env;
}

/**
 * Claude Code saves a picker row chosen with Enter as the default for new sessions, so the
 * value from before this session is captured now and put back on the way out.
 */
const savedModelBefore = readSavedModel();

/**
 * Claude Code's UI shows the model it asked for, never the one the proxy routed to, so a
 * status line is the only way to surface the decision. `--settings` merges rather than
 * replaces, but a status line the user configured themselves still takes priority: theirs
 * is a deliberate choice and silently overwriting it would be worse than showing nothing.
 */
function statusLineArgs() {
  if (process.env.JEV_NO_STATUSLINE) return [];
  for (const dir of [join(process.cwd(), ".claude"), join(homedir(), ".claude")]) {
    try {
      if (JSON.parse(readFileSync(join(dir, "settings.json"), "utf8")).statusLine) return [];
    } catch {
      // No settings file, or unreadable; nothing to preserve.
    }
  }
  // Passed as a file rather than inline JSON: on Windows the args go through a shell, and a
  // JSON string containing its own quotes does not survive that.
  const command = `"${process.execPath}" "${join(HERE, "jev-statusline.mjs")}"`;
  const file = join(tmpdir(), "jev-claude", "settings.json");
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify({ statusLine: { type: "command", command } }));
  } catch {
    return [];
  }
  return ["--settings", file];
}

loadEnv();

const resolveClaude = () => which("claude");

const args = process.argv.slice(2);
const env = { ...process.env };

const claude = resolveClaude();
if (!claude) {
  process.stderr.write(missingMessage("claude", "Claude Code", "https://code.claude.com/docs/en/setup"));
  process.exit(1);
}

if (jevKey()) {
  const { port, close } = await startProxy();
  env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${port}`;
  Object.assign(env, autoModelEnv());
  process.on("exit", () => {
    close();
    restoreSavedModel(savedModelBefore);
  });
  args.push(...statusLineArgs());
  if (process.env.JEV_DEBUG && process.stdout.isTTY) {
    process.stderr.write(`[jev] routing decisions -> ${LOG_FILE}\n`);
  }
} else {
  process.stderr.write(
    `[jev] no JEV_API_KEY found - starting Claude Code without routing\n` +
      `[jev] set it in ${join(homedir(), ".jev-claude.env")} to enable routing\n`,
  );
}

// On Windows a `.cmd` shim still needs a shell; a real executable does not.
const childArgs = [...claude.prefix, ...args];
const child = spawn(
  claude.file,
  shellSafe(childArgs, claude.shell),
  { stdio: "inherit", shell: claude.shell, env },
);

child.on("error", (err) => {
  process.stderr.write(`[jev] could not start Claude Code: ${err.message}\n`);
  process.exit(1);
});
child.on("exit", (code, signal) => process.exit(signal ? 1 : (code ?? 0)));
