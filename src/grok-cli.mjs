import { spawn } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { join } from "node:path";
import { loadEnv, jevKey, ENV_FILE_HINT } from "./env.mjs";
import { AUTO_MODEL } from "./config.mjs";
import { startGrokProxy, GROK_BASE_URL } from "./grok-proxy.mjs";
import { cleanModelsCache, cleanSavedModel, registerSentinel, unregisterSentinel } from "./grok-cache.mjs";
import { LOG_FILE, log } from "./log.mjs";


export function resolveGrok() {
  const win = process.platform === "win32";
  const exts = win ? [".exe", ".ps1", ".cmd", ".bat"] : [""];
  for (const dir of (process.env.PATH ?? "").split(win ? ";" : ":")) {
    if (!dir) continue;
    for (const ext of exts) {
      const file = join(dir.replace(/^"|"$/g, ""), `grok${ext}`);
      try {
        accessSync(file, constants.F_OK);
        if (/\.ps1$/i.test(file)) {
          return { file: "powershell.exe", prefix: ["-NoProfile", "-File", file], shell: false };
        }
        return { file, prefix: [], shell: /\.(cmd|bat)$/i.test(file) };
      } catch {
        // Not here; keep looking.
      }
    }
  }
  return null;
}

/**
 * Starts the session on the sentinel unless the user named a model themselves, in which case
 * their choice is passed through and nothing is routed.
 */
export const grokArgs = (args) =>
  args.some((arg) => arg === "--model" || arg === "-m" || arg.startsWith("--model="))
    ? [...args]
    : ["--model", AUTO_MODEL, ...args];

/**
 * An operator who already points Grok at a corporate gateway keeps it: that value becomes
 * the proxy's upstream, so routing composes with their deployment instead of bypassing it.
 */
export const grokUpstream = (env = process.env) =>
  env.JEV_GROK_UPSTREAM ?? env.GROK_CLI_CHAT_PROXY_BASE_URL ?? GROK_BASE_URL;

export async function runGrok() {
  loadEnv();
  const command = resolveGrok();
  if (!command) {
    process.stderr.write(
      "[jev] Grok CLI is not installed, or `grok` is not on your PATH.\n" +
        "[jev] jev-grok runs the real Grok CLI; install it first:\n" +
        "[jev]   https://docs.x.ai/docs/grok-cli\n",
    );
    process.exitCode = 1;
    return;
  }

  let args = process.argv.slice(2);
  const env = { ...process.env };
  let close = () => {};
  if (jevKey()) {
    const upstream = grokUpstream();
    const proxy = await startGrokProxy({ baseURL: upstream });
    // The sentinel has to exist in Grok's config before the CLI starts, because Grok resolves
    // the model id against its own catalogue rather than passing an unknown one through.
    const { changed } = registerSentinel();
    let cleaned = false;
    close = () => {
      if (cleaned) return;
      cleaned = true;
      proxy.close();
      // Order matters: the block is removed first, otherwise clearing a saved default would
      // strip the `model = "jev-auto"` line out of the middle of it.
      if (changed) unregisterSentinel();
      cleanSavedModel();
      cleanModelsCache(undefined, upstream);
    };
    // A session killed with Ctrl-C or closed from the window manager must still put the
    // user's config back, or plain `grok` is left offering a model xAI cannot run.
    process.on("exit", close);
    for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
      process.on(signal, () => {
        close();
        process.exit(130);
      });
    }
    env.GROK_CLI_CHAT_PROXY_BASE_URL = `http://127.0.0.1:${proxy.port}/v1`;
    args = grokArgs(args);
    // Grok's TUI has no hook for a status line and no commentary channel that renders
    // reliably, so the decision log is the only place a routed turn is visible.
    if (process.stdout.isTTY) process.stderr.write(`[jev] routing decisions -> ${LOG_FILE}\n`);
  } else {
    process.stderr.write(
      "[jev] no JEV_API_KEY found - starting Grok without routing\n" +
        `[jev] add JEV_API_KEY=... to ${ENV_FILE_HINT()} and restart jev-grok\n`,
    );
  }

  const childArgs = [...command.prefix, ...args];
  const child = spawn(
    command.file,
    command.shell ? childArgs.map((arg) => (/\s/.test(arg) ? `"${arg}"` : arg)) : childArgs,
    { stdio: "inherit", shell: command.shell, env },
  );
  child.on("error", (err) => {
    close();
    process.stderr.write(`[jev] could not start Grok: ${err.message}\n`);
    process.exitCode = 1;
  });
  child.on("exit", (code, signal) => {
    close();
    log(`grok session ended (${signal ?? code ?? 0})`);
    process.exitCode = signal ? 1 : (code ?? 0);
  });
}
