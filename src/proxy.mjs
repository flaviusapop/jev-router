import http from "node:http";
import https from "node:https";
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { idOf, availableTiers, tierSpec, isAuto } from "./config.mjs";
import { askJev } from "./router.mjs";
import { decide } from "./policy.mjs";
import { log, announceServedModel } from "./log.mjs";
import { writeStatus } from "./status.mjs";

const UPSTREAM = "api.anthropic.com";
const debug = (line) => process.env.JEV_DEBUG && log(line);

/**
 * Claude Code converts draft-04 relics in MCP tool schemas before sending them first-party,
 * but skips that when ANTHROPIC_BASE_URL is set, so the API rejects the request. In draft
 * 2020-12 `exclusiveMinimum`/`exclusiveMaximum` are numbers, not booleans.
 */
export function sanitizeSchema(node) {
  if (Array.isArray(node)) return node.forEach(sanitizeSchema);
  if (!node || typeof node !== "object") return;
  for (const [key, bound] of [
    ["exclusiveMinimum", "minimum"],
    ["exclusiveMaximum", "maximum"],
  ]) {
    if (typeof node[key] === "boolean") {
      if (node[key] && typeof node[bound] === "number") {
        node[key] = node[bound];
        delete node[bound];
      } else {
        delete node[key];
      }
    }
  }
  for (const v of Object.values(node)) sanitizeSchema(v);
}

/**
 * The text of a genuinely new user turn, or null.
 *
 * A turn can continue for many requests while Claude works through tool calls, and those
 * continuations end in a `tool_result` rather than typed text. Routing them would re-ask
 * Jev on every tool call and let the model flip mid-task, so only the opening request of a
 * turn counts. Claude Code also injects `<system-reminder>` blocks into the user message,
 * which are noise to a router and measurably blunt Jev's confidence, so they are removed.
 */
export function newTurnPrompt(body) {
  if (!Array.isArray(body?.tools) || body.tools.length === 0) return null; // auxiliary call
  // Mid-conversation system messages are appended after the user's turn - hook output is one,
  // and any SessionStart hook produces one on the very first request of every session. They
  // are operator text, not a turn, so they are stepped over rather than read as the end of
  // the conversation; treating one as the last message means never routing at all.
  const messages = body?.messages;
  if (!Array.isArray(messages)) return null;
  let index = messages.length - 1;
  while (index >= 0 && messages[index]?.role === "system") index -= 1;
  const last = messages[index];
  if (!last || last.role !== "user") return null;
  let text;
  if (typeof last.content === "string") {
    text = last.content;
  } else if (Array.isArray(last.content)) {
    if (last.content.some((b) => b.type === "tool_result")) return null;
    text = last.content
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("\n");
  } else {
    return null;
  }
  return text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "").trim() || null;
}

/**
 * Points a request at a tier, setting the reasoning effort that tier asks for and removing
 * request fields that tier cannot accept. Claude Code composes the body for whatever model it
 * thinks it is talking to, so downgrading to Haiku while leaving `thinking: {type:"adaptive"}`
 * in place is a hard 400, and so is any `effort` at all.
 *
 * Effort is set rather than merely preserved because a tier is a (model, effort) pair: the top
 * tier is the same model as the strong tier, thinking longer, and that only happens if the
 * value goes out on the request. Claude Code's own choice is overridden for the same reason it
 * does not pick the model - the whole session is running on the router's judgement.
 */
export function applyTier(body, tierName) {
  const tier = tierSpec(tierName);
  if (!tier) return body;
  body.model = tier.id;
  if (!tier.thinking) {
    delete body.thinking;
    // A context-management strategy that prunes thinking blocks is itself rejected once
    // thinking is gone, so it has to go with it.
    const edits = body.context_management?.edits;
    if (Array.isArray(edits)) {
      body.context_management.edits = edits.filter((e) => !/thinking/i.test(e?.type ?? ""));
      if (body.context_management.edits.length === 0) delete body.context_management;
    }
  }
  if (tier.effort) {
    body.output_config = { ...(body.output_config ?? {}), effort: tier.effort };
  } else if (body.output_config) {
    delete body.output_config.effort;
    if (Object.keys(body.output_config).length === 0) delete body.output_config;
  }
  return body;
}

/**
 * Identifies the conversation a request belongs to. Claude Code runs sub-agents through the
 * same endpoint, so a single pinned model would let a sub-agent's choice leak into the main
 * conversation.
 *
 * Only stable fields may be used. Claude Code moves its `cache_control` breakpoint between
 * requests and rewrites message metadata, so the key is built from the session id plus the
 * text of the first message, which is fixed once a conversation starts and differs between
 * the main agent and each sub-agent.
 */
/**
 * Which session a request belongs to, or "" when nothing says.
 *
 * Claude Code puts it in the body, as a JSON string under `metadata.user_id`. opencode puts
 * it in an `x-session-id` header instead, and - unlike Claude Code - gives every agent its
 * own, so the header alone separates a sub-agent from the session that spawned it. Measured
 * 2026-09-18: a `task` spawn ran under `ses_f4b42d493ffe...` while its parent stayed on
 * `ses_f4b42dee0ffe...`.
 */
export function sessionOf(body, headers = {}) {
  try {
    const embedded = JSON.parse(body?.metadata?.user_id ?? "{}").session_id;
    if (embedded) return embedded;
  } catch {
    // Not JSON, so not Claude Code's; fall through to the header.
  }
  const header = headers["x-session-id"];
  return (Array.isArray(header) ? header[0] : header) ?? "";
}

export function conversationKey(body, headers = {}) {
  const session = sessionOf(body, headers);
  const content = body?.messages?.[0]?.content;
  const text =
    typeof content === "string"
      ? content
      : Array.isArray(content)
        ? content
            .filter((b) => b.type === "text")
            .map((b) => b.text)
            .join("")
        : "";
  // Claude Code injects `<system-reminder>` blocks into the first message too, and rewrites
  // them between requests. Leaving them in makes the key churn mid-conversation: measured
  // 2026-09-18, one Explore sub-agent produced two keys and so two Jev calls for one task.
  const stable = text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "").trim();
  return createHash("sha1").update(`${session}|${stable}`).digest("hex").slice(0, 12);
}

/**
 * Whether a request naming a concrete model is a sub-agent Claude Code just spawned, rather
 * than a model the user picked.
 *
 * Both look identical at the model field: Claude Code resolves a sub-agent's model at spawn
 * time and sends that id, never the sentinel, so a sub-agent would otherwise run unrouted on
 * whatever the parent happened to be. Measured 2026-09-18: a main agent routed to haiku spawned
 * an Explore agent that ran on `claude-opus-5`, untouched.
 *
 * What separates them is the conversation, not the model. A sub-agent opens a new conversation
 * inside a session already being routed, so its key has never been seen; a `/model` pick stays
 * in the conversation it was made in, whose key is already known. Requiring a real agent turn
 * as well keeps Claude Code's own auxiliary calls — titles, summaries, typeahead — out of it,
 * since those carry no tools.
 *
 * A conversation the user took manual control of is the exception to "never been seen": the
 * pick hands it back, so it stops being one we route, and without `manual` its very next turn
 * would look brand new inside a routed session and be routed again. Sub-agents that
 * conversation spawns are still routed - they are the router's job even when its parent
 * is not.
 */
export function isSubagentSpawn({ session, key, routedSessions, convos, prompt, manual = new Set() }) {
  return Boolean(prompt) && routedSessions.has(session) && !convos.has(key) && !manual.has(key);
}

export async function startProxy() {
  // Tier routed for each conversation's turn in flight, reused by its follow-up requests and
  // by the cache-rebuild guard, which needs to know what the prompt cache was built on.
  const convos = new Map();
  // Sessions in which the sentinel has been seen, so a concrete model arriving later can be
  // told apart: inside one of these a brand-new conversation is a sub-agent Claude Code spawned.
  const routedSessions = new Set();
  // Conversation keys known to belong to a sub-agent, so their follow-up requests keep the
  // tier chosen for them without re-asking Jev, and never touch the main agent's status line.
  const subagents = new Set();
  // Conversation keys the user took over with /model. Kept apart from `convos`, which evicts
  // its oldest entry past 50, because a choice the user made should outlast that.
  const manual = new Set();
  const stateFor = (key) => {
    let s = convos.get(key);
    if (!s) {
      if (convos.size > 50) convos.delete(convos.keys().next().value);
      convos.set(key, (s = { tier: null }));
    }
    return s;
  };

  const server = http.createServer((req, res) => {
    // Claude Code probes the base URL before its first request.
    if (req.method === "HEAD") return res.writeHead(200).end();

    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", async () => {
      let out = Buffer.concat(chunks);

      if (/^\/v1\/messages/.test(req.url ?? "")) {
        try {
          const body = JSON.parse(out.toString());
          // Claude Code's request shape is undocumented and moves; JEV_DUMP captures it.
          if (process.env.JEV_DUMP) {
            writeFileSync(`${process.env.JEV_DUMP}.${Date.now()}.json`, JSON.stringify(body, null, 2));
          }
          body.tools?.forEach((t) => sanitizeSchema(t.input_schema));

          const session = sessionOf(body, req.headers);
          const key = conversationKey(body, req.headers);
          const prompt = newTurnPrompt(body);
          // A sub-agent names a concrete model but is not a choice the user made, so it is
          // routed like any other conversation. Its tier is kept under its own key, which
          // means a sub-agent can run on a different tier from the agent that spawned it.
          // Once a conversation is known to be a sub-agent it stays one: its follow-up requests
          // name the same concrete model and must keep the tier chosen for it, not be read as
          // the user reaching for /model.
          const subagent =
            !isAuto(body.model) &&
            (subagents.has(key) ||
              isSubagentSpawn({ session, key, routedSessions, convos, prompt, manual }));

          if (!isAuto(body.model) && !subagent && !convos.has(key)) {
            // Anything that is not the sentinel is a model the user chose, and an explicit
            // choice beats the router. That also covers Claude Code's own cheap Haiku calls
            // for titles and summaries, which must never be pinned up to the session's tier.
            debug(`passthrough, user selected ${body.model}`);
            // Only a real agent turn reflects the user's choice. Claude Code's own auxiliary
            // calls carry no tools and must not flip the status line to manual mid-session.
            if (Array.isArray(body.tools)) {
              writeStatus(session, { manual: true, at: Date.now() });
            }
          } else if (!isAuto(body.model) && !subagent) {
            // A conversation we route, now naming a real model: the user picked one with
            // /model inside it. Hand the conversation back and stop routing it - for good,
            // not for one turn: dropping it from `convos` alone would make its next turn look
            // like a fresh conversation inside a routed session, which is a sub-agent spawn.
            debug(`passthrough, user selected ${body.model}`);
            convos.delete(key);
            manual.add(key);
            writeStatus(session, { manual: true, at: Date.now() });
          } else {
            if (isAuto(body.model)) routedSessions.add(session);
            const state = stateFor(key);
            // What the prompt cache was built on, which is what a downgrade would discard.
            const current = state.tier ?? "sonnet";
            let fresh = null;
            if (prompt) {
              const available = availableTiers();
              const contextTokens = Math.round(JSON.stringify(body.messages).length / 4);
              const jev = await askJev({ prompt, current, contextTokens, available });
              const { tier, reason, cheapStreak } = decide({
                prompt, jev, current, available, contextTokens, cheapStreak: state.cheapStreak ?? 0,
              });
              state.tier = tier;
              state.cheapStreak = cheapStreak;
              fresh = { confidence: jev?.confidence ?? null, reason };
              debug(
                `${key}${subagent ? " subagent" : ""} ` +
                  `${jev ? `${jev.ms}ms p=${jev.confidence.toFixed(2)}` : "no-jev"} ` +
                  `${current} -> ${tier} (${reason}) ctx~${contextTokens} | ${prompt.slice(0, 60)}`,
              );
            }
            // The sentinel is not a real model, so every routed request must be rewritten,
            // including follow-ups that reuse the tier chosen for the turn.
            const tier = state.tier ?? current;
            debug(`${key} rewrite ${body.model} -> ${idOf(tier)}`);
            applyTier(body, tier);
            // Publish what went out. Claude Code's UI shows the row you picked, not the tier
            // it resolved to, so the status line is the only place this is visible. A
            // sub-agent's tier is its own business and must not overwrite the main agent's.
            if (!subagent && !subagents.has(key)) {
              writeStatus(session, { tier, ...fresh, at: Date.now() });
            }
            if (subagent) subagents.add(key);
          }
          out = Buffer.from(JSON.stringify(body));
        } catch (err) {
          debug(`passthrough, could not process body: ${err.message}`);
        }
      }

      const headers = { ...req.headers, host: UPSTREAM };
      delete headers["content-length"];
      // Under JEV_DEBUG, ask for an uncompressed stream so the model the API reports can be
      // read back out of it. Not worth the bandwidth cost in normal operation.
      if (process.env.JEV_DEBUG) delete headers["accept-encoding"];
      const upstream = https.request(
        { hostname: UPSTREAM, path: req.url, method: req.method, headers },
        (up) => {
          res.writeHead(up.statusCode, up.headers);
          announceServedModel(up, "claude", up.statusCode);
          up.pipe(res);
        },
      );
      upstream.on("error", (e) => {
        debug(`upstream error: ${e.message}`);
        if (!res.headersSent) res.writeHead(502, { "content-type": "application/json" });
        res.end(JSON.stringify({ type: "error", error: { message: e.message } }));
      });
      if (out.length) upstream.write(out);
      upstream.end();
    });
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { port: server.address().port, close: () => server.close() };
}
