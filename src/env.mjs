import { homedir } from "node:os";
import { join } from "node:path";

/**
 * User-owned files that may provide router configuration. The process environment has
 * precedence because `process.loadEnvFile` does not overwrite variables that already exist.
 *
 * All four launchers read the same list. `~/.jev-router.env` is the name the README gives
 * and the one to use; `~/.jev-claude.env` predates the other launchers and is still read
 * so an existing setup keeps working.
 */
export const ENV_FILES = () => [
  join(homedir(), ".jev-router.env"),
  join(homedir(), ".jev-claude.env"),
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
