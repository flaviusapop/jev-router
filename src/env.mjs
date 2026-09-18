import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Where the key is read from, in increasing order of precedence. `process.loadEnvFile`
 * overwrites what it finds, so the last file wins: a project-local `.env` beats the
 * user-level one, which is what you want when one repository needs different settings.
 *
 * All three launchers read the same list. `~/.jev-router.env` is the name the README gives
 * and the one to use; `~/.jev-claude.env` predates the other two suppliers and is still read
 * so an existing setup keeps working.
 */
export const ENV_FILES = () => [
  join(homedir(), ".jev-claude.env"),
  join(homedir(), ".jev-router.env"),
  join(process.cwd(), ".env"),
];

/** Where a user should be told to put the key when none was found. */
export const ENV_FILE_HINT = () => join(homedir(), ".jev-router.env");

export function loadEnv() {
  for (const file of ENV_FILES()) {
    try {
      process.loadEnvFile(file);
    } catch {
      // Missing or unreadable; values may still come from the real environment.
    }
  }
}

/** The routing key, under either accepted name, or undefined when routing is off. */
export const jevKey = () => process.env.JEV_API_KEY ?? process.env.TYPESAFE_API_KEY;
