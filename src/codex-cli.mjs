import { spawn } from "node:child_process";
import { which, missingMessage, shellSafe } from "./which.mjs";
import { loadEnv, jevKey, ENV_FILE_HINT } from "./env.mjs";
import { AUTO_MODEL } from "./config.mjs";
import { startCodexProxy } from "./codex-proxy.mjs";

const PROVIDER = "jev";


export const resolveCodex = () => which("codex");

export const codexArgs = (baseURL, args) => [
  ...(args.some((arg) => arg === "--model" || arg === "-m" || arg.startsWith("--model="))
    ? []
    : ["--model", AUTO_MODEL]),
  "--config",
  `model_provider="${PROVIDER}"`,
  "--config",
  `model_providers.${PROVIDER}.name="Jev Router"`,
  "--config",
  `model_providers.${PROVIDER}.base_url="${baseURL}"`,
  "--config",
  `model_providers.${PROVIDER}.wire_api="responses"`,
  "--config",
  `model_providers.${PROVIDER}.requires_openai_auth=true`,
  "--config",
  `model_providers.${PROVIDER}.supports_websockets=false`,
  ...args,
];

export async function runCodex() {
  loadEnv();
  const command = resolveCodex();
  if (!command) {
    process.stderr.write(missingMessage("codex", "OpenAI Codex", "https://developers.openai.com/codex/cli"));
    process.exitCode = 1;
    return;
  }

  let args = process.argv.slice(2);
  let close = () => {};
  if (jevKey()) {
    const proxy = await startCodexProxy();
    close = proxy.close;
    args = codexArgs(`http://127.0.0.1:${proxy.port}`, args);
  } else {
    process.stderr.write(
      "[jev] no JEV_API_KEY found - starting Codex without routing\n" +
        `[jev] add JEV_API_KEY=... to ${ENV_FILE_HINT()} and restart jev-codex\n`,
    );
  }

  const childArgs = [...command.prefix, ...args];
  const child = spawn(
    command.file,
    shellSafe(childArgs, command.shell),
    { stdio: "inherit", shell: command.shell, env: process.env },
  );
  child.on("error", (err) => {
    close();
    process.stderr.write(`[jev] could not start Codex: ${err.message}\n`);
    process.exitCode = 1;
  });
  child.on("exit", (code, signal) => {
    close();
    process.exitCode = signal ? 1 : (code ?? 0);
  });
}
