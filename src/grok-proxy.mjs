import http from "node:http";
import https from "node:https";
import { writeFileSync } from "node:fs";
import { brotliDecompressSync, gunzipSync, inflateSync, zstdDecompressSync } from "node:zlib";
import { AUTO_MODEL, availableTiers, target } from "./config.mjs";
import { askJev } from "./router.mjs";
import { decide } from "./policy.mjs";
import { conversationKey, isAgentSession, newTurnPrompt } from "./responses.mjs";
import { log, announceServedModel } from "./log.mjs";

/**
 * Everything the Grok CLI does - the model list, a turn, session deltas, traces, the tool
 * bundle - goes to one chat proxy, so this stands in front of all of it and rewrites exactly
 * one field on one path. An operator who already points Grok at their own gateway keeps that
 * value: it becomes our upstream rather than being replaced.
 */
export const GROK_BASE_URL = "https://cli-chat-proxy.grok.com/v1";

/**
 * Grok tiers live in `config.mjs` alongside Claude's and Codex's, so the whole ladder is
 * visible in one table. `JEV_GROK_*_MODEL` and `JEV_GROK_*_EFFORT` override any entry.
 * Grok's subscription exposes two models that both take a reasoning effort, so routing down a
 * tier there often means the same model thinking less rather than a different model.
 */
export const grokTierSpec = (tier) => {
  const spec = target("grok", tier);
  return { model: spec?.id, effort: spec?.effort };
};

export const grokModelOf = (tier) => grokTierSpec(tier).model;

const effortsOf = (info) => info?.reasoning_efforts?.map((level) => level.value ?? level.id) ?? [];

/**
 * Rewrites the model and reasoning effort for a routed turn. An effort the target model does
 * not list is replaced with that model's own default rather than dropped, because Grok treats
 * a missing effort as "use the default" but an unlisted one as an error.
 */
export function applyGrokTier(body, tier, models = new Map()) {
  const { model, effort } = grokTierSpec(tier);
  if (!model) return body;
  body.model = model;
  const info = models.get(model);
  if (info?.supports_reasoning_effort === false) {
    if (body.reasoning) delete body.reasoning.effort;
    return body;
  }
  const allowed = effortsOf(info);
  const wanted = effort ?? body.reasoning?.effort;
  if (!wanted) return body;
  const final = allowed.length && !allowed.includes(wanted) ? (info?.reasoning_effort ?? allowed[0]) : wanted;
  body.reasoning = { ...(body.reasoning ?? {}), effort: final };
  return body;
}

const debug = (line) => process.env.JEV_DEBUG && log(line);

/**
 * Grok's responses come back compressed, and the catalogue has to be read to know which
 * efforts each model accepts. Only this copy is decoded - the client is still sent the
 * original bytes with their original headers, so nothing downstream can notice.
 */
const DECODERS = {
  gzip: gunzipSync,
  "x-gzip": gunzipSync,
  deflate: inflateSync,
  br: brotliDecompressSync,
  zstd: zstdDecompressSync,
};

function decode(buffer, encoding) {
  const decoder = DECODERS[String(encoding ?? "").trim().toLowerCase()];
  return (decoder ? decoder(buffer) : buffer).toString();
}

const isModelsPath = (path = "") => /\/models(?:\?|$)/.test(path);
const isResponsesPath = (path = "") => /\/responses(?:\?|$)/.test(path);

export async function startGrokProxy({
  baseURL = process.env.JEV_GROK_UPSTREAM ?? GROK_BASE_URL,
  route = askJev,
} = {}) {
  const states = new Map();
  const models = new Map();
  const target = new URL(baseURL);
  const transport = target.protocol === "http:" ? http : https;
  const prefix = target.pathname.replace(/\/$/, "");

  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", async () => {
      let out = Buffer.concat(chunks);

      if (req.method === "POST" && isResponsesPath(req.url)) {
        try {
          const body = JSON.parse(out.toString());
          if (process.env.JEV_DUMP) {
            writeFileSync(`${process.env.JEV_DUMP}.${Date.now()}.json`, JSON.stringify(body, null, 2));
          }
          if (body.model === AUTO_MODEL && !isAgentSession(body)) {
            // A side request wearing the sentinel, because the sentinel is the session's model
            // and Grok reuses it for its own errands. It still has to name a real model - the
            // sentinel exists only in Grok's local catalogue, and xAI would reject it - so it
            // is pinned to the cheapest tier without asking Jev. Measured 2026-09-19: a
            // sub-agent's `session_title` call was costing a Jev call and a routed tier to
            // write a 100-token title.
            const cheapest =
              availableTiers().find((name) => models.size === 0 || models.has(grokModelOf(name))) ?? "haiku";
            debug(`grok side request -> ${grokModelOf(cheapest)}, not an agent turn`);
            applyGrokTier(body, cheapest, models);
          } else if (body.model === AUTO_MODEL) {
            const key = conversationKey(body);
            const current = states.get(key) ?? "sonnet";
            const prompt = newTurnPrompt(body);
            let tier = current;
            if (prompt) {
              // Once the catalogue is known, a tier whose model this account cannot run is
              // dropped rather than offered to Jev and clamped away afterwards.
              const enabled = availableTiers().filter(
                (name) => models.size === 0 || models.has(grokModelOf(name)),
              );
              const contextTokens = Math.round(JSON.stringify(body.input).length / 4);
              const jev = await route({ prompt, current, contextTokens, available: enabled });
              const decision = decide({ prompt, jev, current, available: enabled, contextTokens });
              tier = decision.tier;
              states.set(key, tier);
              const spec = grokTierSpec(tier);
              const confidence = jev?.confidence == null ? "" : `, confidence ${jev.confidence.toFixed(2)}`;
              log(`grok ${key}: ${spec.model} effort=${spec.effort} (${decision.reason}${confidence})`);
            }
            applyGrokTier(body, tier, models);
          }
          out = Buffer.from(JSON.stringify(body));
        } catch (err) {
          debug(`grok passthrough, could not process body: ${err.message}`);
        }
      }

      const headers = { ...req.headers, host: target.host };
      delete headers["content-length"];
      const upstream = transport.request(
        {
          hostname: target.hostname,
          port: target.port || undefined,
          path: `${prefix}${(req.url ?? "/").replace(/^\/v1/, "")}`,
          method: req.method,
          headers,
        },
        (response) => {
          announceServedModel(response, "grok", response.statusCode);
          res.writeHead(response.statusCode, response.headers);
          if (!(req.method === "GET" && isModelsPath(req.url))) {
            response.pipe(res);
            return;
          }
          // The catalogue says which efforts each model accepts and which tiers this account
          // can run at all, so it is read on the way past. It is the only response worth
          // watching; everything else, including SSE turns and the multi-megabyte tool
          // bundle, is piped straight through untouched.
          const body = [];
          response.on("data", (chunk) => {
            body.push(chunk);
            res.write(chunk);
          });
          response.on("end", () => {
            try {
              const catalog = JSON.parse(decode(Buffer.concat(body), response.headers["content-encoding"]));
              for (const model of catalog.data ?? []) if (model?.id) models.set(model.id, model);
            } catch (err) {
              debug(`could not read Grok model catalog: ${err.message}`);
            }
            res.end();
          });
        },
      );
      upstream.on("error", (err) => {
        debug(`grok upstream error: ${err.message}`);
        if (!res.headersSent) res.writeHead(502, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: err.message, type: "proxy_error" } }));
      });
      if (out.length) upstream.write(out);
      upstream.end();
    });
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    port: server.address().port,
    close: () => {
      server.close();
      // A keep-alive socket the CLI left open would hold the event loop after the session
      // ends, so the launcher's process would never exit.
      server.closeAllConnections?.();
    },
  };
}
