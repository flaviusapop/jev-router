import { accessSync, constants, statSync } from "node:fs";
import { join } from "node:path";

const WINDOWS = () => process.platform === "win32";

/**
 * Extensions that make a file runnable, in the order Windows tries them. On anything else the
 * name is the whole story, so the only candidate is the bare name.
 */
export function extensionsFor(platform = process.platform, env = process.env) {
  if (platform !== "win32") return [""];
  // PATHEXT is the authority on this machine; the list is only what Windows ships by default.
  return (env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean).concat([".ps1"]);
}

/**
 * Whether this path is something we can actually run.
 *
 * Existence is not enough on macOS or Linux. A file without the execute bit, or a *directory*
 * that happens to share the name - and every directory is executable, meaning traversable -
 * would both pass an existence check and then fail at spawn with a message about the wrong
 * thing. Windows has no execute bit, so there the extension carries that meaning instead.
 */
export function isRunnable(file) {
  try {
    if (!statSync(file).isFile()) return false;
    accessSync(file, WINDOWS() ? constants.F_OK : constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Finds a CLI on PATH and says how it has to be started.
 *
 * Resolving it here rather than leaning on the shell means arguments go as an array - no
 * quoting hazard, no DEP0190 warning - and a missing install produces a message that names
 * the CLI instead of a shell error. The two Windows shims are the exception: `.cmd` and
 * `.bat` are scripts that only cmd.exe can run, and `.ps1` needs PowerShell named explicitly.
 *
 * @returns {?{file: string, prefix: string[], shell: boolean}}
 */
export function which(name, env = process.env) {
  const separator = WINDOWS() ? ";" : ":";
  for (const dir of (env.PATH ?? env.Path ?? "").split(separator)) {
    if (!dir) continue;
    for (const ext of extensionsFor(process.platform, env)) {
      const file = join(dir.replace(/^"|"$/g, ""), `${name}${ext}`);
      if (!isRunnable(file)) continue;
      if (/\.ps1$/i.test(file)) {
        return { file: "powershell.exe", prefix: ["-NoProfile", "-File", file], shell: false };
      }
      return { file, prefix: [], shell: /\.(cmd|bat)$/i.test(file) };
    }
  }
  return null;
}

/** The message shown when a CLI this launcher wraps is not installed. */
export const missingMessage = (command, cli, url) =>
  `[jev] ${cli} is not installed, or \`${command}\` is not on your PATH.\n` +
  `[jev] jev-${command} runs the real ${cli}; install it first:\n` +
  `[jev]   ${url}\n`;
