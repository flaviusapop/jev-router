import { appendFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const LOG_FILE = join(homedir(), ".jev-claude.log");

// Claude Code owns the terminal in interactive mode and redraws over anything we print, so
// writing to stderr there corrupts its UI. Log to a file instead and leave stderr alone.
// In print mode (`-p`) there is no TUI to damage, so stderr stays convenient for piping.
const interactive = process.stdout.isTTY;

export function log(line) {
  const text = `[jev] ${line}\n`;
  if (!interactive) return void process.stderr.write(text);
  try {
    appendFileSync(LOG_FILE, `${new Date().toISOString()} ${text}`);
  } catch {
    // A broken log file must never take down the session.
  }
}

export const debug = (line) => process.env.JEV_DEBUG && log(line);

/**
 * Reports the model the supplier itself says it used, read off the response as it streams past.
 * Every CLI's UI shows the model it asked for, never the one we rewrote to, and our own decision
 * log only records what we intended — so this is the one place the routing is confirmed from the
 * wire rather than trusted. Debug-only: it fires on the first chunk naming a model and then
 * detaches, so a turn costs one regex, not one per chunk.
 */
export function announceServedModel(stream, label, statusCode) {
  if (!process.env.JEV_DEBUG) return;
  const onData = (chunk) => {
    const match = /"model"\s*:\s*"([^"]+)"/.exec(chunk.toString("utf8"));
    if (!match) return;
    stream.off("data", onData);
    log(`${statusCode} ${label} served by ${match[1]}`);
  };
  stream.on("data", onData);
}
