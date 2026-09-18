import { spawn } from "node:child_process";
import { which, missingMessage, shellSafe } from "./which.mjs";
import { loadEnv, jevKey, ENV_FILE_HINT } from "./env.mjs";
import { AUTO_MODEL } from "./config.mjs";
import { startGrokProxy, GROK_BASE_URL, safeGrokUpstream } from "./grok-proxy.mjs";
import { cleanModelsCache, cleanSavedModel, registerSentinel, unregisterSentinel } from "./grok-cache.mjs";
import { LOG_FILE, log } from "./log.mjs";


export const resolveGrok = () => which("grok");

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
  safeGrokUpstream(env.JEV_GROK_UPSTREAM ?? env.GROK_CLI_CHAT_PROXY_BASE_URL ?? GROK_BASE_URL);

export async function runGrok() {
  loadEnv();
  const command = resolveGrok();
  if (!command) {
    process.stderr.write(missingMessage("grok", "the Grok CLI", "https://docs.x.ai/docs/grok-cli"));
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
    shellSafe(childArgs, command.shell),
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
