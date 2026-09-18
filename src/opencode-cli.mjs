import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { which, missingMessage, shellSafe } from "./which.mjs";
import { loadEnv, jevKey, ENV_FILE_HINT } from "./env.mjs";
import { AUTO_MODEL, SMALLEST_CONTEXT_TOKENS } from "./config.mjs";
import { startProxy } from "./proxy.mjs";
import { LOG_FILE, log } from "./log.mjs";

const PROVIDER = "anthropic";

export const resolveOpencode = () => which("opencode");

/**
 * The smallest context and output any tier can serve.
 *
 * opencode composes `max_tokens` from whatever the chosen model declares, and asks the model
 * to hold whatever context it declares, so both have to be true of every tier the router might
 * pick. Claiming Opus's window and then routing down to Haiku is a hard 400 on the way out.
 */
export const sentinelLimits = () => ({ context: SMALLEST_CONTEXT_TOKENS, output: 32000 });

/**
 * The config that turns opencode into a routed session.
 *
 * `provider.anthropic.options.baseURL` points it at the proxy, and a `jev-auto` model is
 * declared beside the real ones so the sentinel survives opencode's own catalogue - it comes
 * from models.dev, which has never heard of it. `model` makes it the session default without
 * anyone having to pick it.
 *
 * `small_model` is deliberately left alone. opencode uses it for titles and summaries, those
 * requests carry no tools, and the router already refuses to route a call with no tools.
 */
export function opencodeConfig(port) {
  return {
    $schema: "https://opencode.ai/config.json",
    model: `${PROVIDER}/${AUTO_MODEL}`,
    provider: {
      [PROVIDER]: {
        options: { baseURL: `http://127.0.0.1:${port}/v1` },
        models: {
          [AUTO_MODEL]: {
            name: "Jev Router",
            tool_call: true,
            // Left on so opencode keeps composing a thinking budget for the tiers that take
            // one. `applyTier` strips it again whenever the turn lands on a tier that cannot.
            reasoning: true,
            limit: sentinelLimits(),
          },
        },
      },
    },
  };
}

/**
 * Where the config goes. `OPENCODE_CONFIG` *merges* over what the user already has rather
 * than replacing it - measured 2026-09-18, an MCP server configured globally survived - so
 * nothing of theirs is touched, and there is nothing to put back when the session ends.
 */
export function writeConfig(port, dir = join(tmpdir(), "jev-opencode")) {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "opencode.json");
  writeFileSync(file, JSON.stringify(opencodeConfig(port), null, 2));
  return file;
}

/** Whether the user named a model themselves, in which case nothing is routed. */
export const picksModel = (args) =>
  args.some((arg) => arg === "--model" || arg === "-m" || arg.startsWith("--model="));

export async function runOpencode() {
  loadEnv();
  const command = resolveOpencode();
  if (!command) {
    process.stderr.write(missingMessage("opencode", "opencode", "https://opencode.ai/docs"));
    process.exitCode = 1;
    return;
  }

  const args = process.argv.slice(2);
  const env = { ...process.env };
  let close = () => {};
  if (jevKey() && !picksModel(args)) {
    const proxy = await startProxy();
    env.OPENCODE_CONFIG = writeConfig(proxy.port);
    close = () => proxy.close?.();
    process.on("exit", close);
    for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
      process.on(signal, () => {
        close();
        process.exit(130);
      });
    }
    // opencode's TUI has no status line we can write to, so the log is where a routed turn
    // is visible. In `run` mode the log goes to stderr instead and this line is redundant.
    if (process.stdout.isTTY) process.stderr.write(`[jev] routing decisions -> ${LOG_FILE}\n`);
  } else if (!jevKey()) {
    process.stderr.write(
      "[jev] no JEV_API_KEY found - starting opencode without routing\n" +
        `[jev] add JEV_API_KEY=... to ${ENV_FILE_HINT()} and restart jev-opencode\n`,
    );
  }

  const childArgs = [...command.prefix, ...args];
  const child = spawn(
    command.file,
    shellSafe(childArgs, command.shell),
    { stdio: "inherit", shell: command.shell, env },
  );
  child.on("error", (err) => {
    close();
    process.stderr.write(`[jev] could not start opencode: ${err.message}\n`);
    process.exitCode = 1;
  });
  child.on("exit", (code, signal) => {
    close();
    log(`opencode session ended (${signal ?? code ?? 0})`);
    process.exitCode = signal ? 1 : (code ?? 0);
  });
}
