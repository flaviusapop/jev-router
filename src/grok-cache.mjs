import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { AUTO_MODEL } from "./config.mjs";

export const GROK_HOME = () => process.env.GROK_HOME ?? join(homedir(), ".grok");
export const MODELS_CACHE = () => join(GROK_HOME(), "models_cache.json");
export const GROK_CONFIG = () => join(GROK_HOME(), "config.toml");

/**
 * Grok's registration for the sentinel. Claude Code and Codex both accept an unknown model id
 * behind a custom base URL, but Grok resolves ids against its own catalogue and drops a row it
 * did not expect, so an extra entry in the `/v1/models` response is discarded. A `[model.*]`
 * block is the documented way to add one, and it outranks both the prefetched list and the
 * built-in defaults. No `base_url` is set: the entry inherits the chat proxy, which for this
 * process tree is the router.
 */
const SENTINEL_BLOCK = [
  `[model.${AUTO_MODEL}]`,
  `model = "${AUTO_MODEL}"`,
  `name = "Jev Router"`,
  `api_backend = "responses"`,
  `context_window = 500000`,
].join("\n");

const BLOCK_PATTERN = new RegExp(`(?:^|\\n)\\s*\\[model\\.${AUTO_MODEL}\\][^\\[]*`, "i");

export const hasSentinel = (text) => BLOCK_PATTERN.test(text);

/**
 * Adds the sentinel to Grok's config, returning what was there before so the caller can put
 * the file back exactly as it found it. A config that already declares it is left untouched,
 * which is what makes a second session started while the first is running harmless.
 */
export function registerSentinel(file = GROK_CONFIG()) {
  let before = "";
  try {
    before = readFileSync(file, "utf8");
  } catch {
    // No config yet; one holding only our entry is still valid TOML.
  }
  if (hasSentinel(before)) return { changed: false, before };
  try {
    const kept = before.replace(/\s*$/, "");
    writeFileSync(file, kept ? `${kept}\n\n${SENTINEL_BLOCK}\n` : `${SENTINEL_BLOCK}\n`);
    return { changed: true, before };
  } catch {
    return { changed: false, before };
  }
}

/**
 * Removes the sentinel block. A leftover entry would show "Jev Router" in plain `grok`, where
 * selecting it sends an id xAI has never heard of, so this runs on every exit path. Only the
 * block is cut; everything the user configured around it is preserved byte for byte.
 */
export function unregisterSentinel(file = GROK_CONFIG()) {
  try {
    const before = readFileSync(file, "utf8");
    if (!hasSentinel(before)) return false;
    const after = before.replace(BLOCK_PATTERN, "\n").replace(/\n{3,}/g, "\n\n").replace(/^\n+/, "");
    writeFileSync(file, after);
    return true;
  } catch {
    return false;
  }
}

/**
 * Points Grok's cached model list back at the real endpoint. Grok saves the origin it fetched
 * from, so a routed session leaves a loopback address behind. Plain `grok` normally refetches
 * and heals itself, but not when it starts offline, and then it would try a port that is gone.
 * A sentinel row is cleared too, in case a future Grok starts accepting one.
 */
export function cleanModelsCache(file = MODELS_CACHE(), upstream) {
  try {
    const cache = JSON.parse(readFileSync(file, "utf8"));
    const hadSentinel = cache?.models && AUTO_MODEL in cache.models;
    const staleOrigin = typeof cache?.origin === "string" && /^http:\/\/127\.0\.0\.1[:/]/.test(cache.origin);
    if (!hadSentinel && !staleOrigin) return false;
    if (hadSentinel) delete cache.models[AUTO_MODEL];
    // An etag kept from our response would let Grok accept a 304 from the real endpoint and
    // go on serving the doctored list, so it goes too.
    if (staleOrigin) {
      if (upstream) cache.origin = `${upstream.replace(/\/$/, "")}/models`;
      else delete cache.origin;
      delete cache.etag;
    }
    writeFileSync(file, `${JSON.stringify(cache, null, 2)}\n`);
    return true;
  } catch {
    return false;
  }
}

/**
 * Drops a saved default that names the sentinel. Grok can persist a model chosen in the
 * picker, and a saved "jev-auto" would break plain `grok`, which has no proxy to resolve it.
 * Only a line whose value is exactly the sentinel is removed, so a real model the user chose
 * during the session survives, and so does every other setting in the file.
 */
export function cleanSavedModel(file = GROK_CONFIG()) {
  try {
    const before = readFileSync(file, "utf8");
    const after = before.replace(new RegExp(`^\\s*\\w+\\s*=\\s*["']${AUTO_MODEL}["']\\s*$\\n?`, "gmi"), "");
    if (after === before) return false;
    writeFileSync(file, after);
    return true;
  } catch {
    return false;
  }
}
