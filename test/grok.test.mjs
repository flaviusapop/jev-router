import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { applyGrokTier, grokTierSpec, startGrokProxy } from "../src/grok-proxy.mjs";
import { grokArgs, grokUpstream } from "../src/grok-cli.mjs";
import {
  cleanModelsCache,
  cleanSavedModel,
  registerSentinel,
  unregisterSentinel,
} from "../src/grok-cache.mjs";

/** The two models a Grok subscription exposes, in the shape `/v1/models` returns them. */
const catalogue = () => ({
  object: "list",
  data: [
    {
      id: "grok-4.6",
      object: "model",
      model: "grok-4.6",
      name: "Grok 4.6",
      context_window: 500000,
      api_backend: "responses",
      reasoning_effort: "high",
      supports_reasoning_effort: true,
      reasoning_efforts: ["xhigh", "high", "medium", "low"].map((value) => ({ id: value, value })),
    },
    {
      id: "grok-4.5",
      object: "model",
      model: "grok-4.5",
      name: "Grok 4.5",
      context_window: 500000,
      api_backend: "responses",
      reasoning_effort: "high",
      supports_reasoning_effort: true,
      reasoning_efforts: ["high", "medium", "low"].map((value) => ({ id: value, value })),
    },
  ],
});

const modelMap = () => new Map(catalogue().data.map((model) => [model.id, model]));

test("Grok starts on the sentinel unless the user named a model", () => {
  assert.deepEqual(grokArgs(["--worktree"]), ["--model", "jev-auto", "--worktree"]);
  assert.deepEqual(grokArgs(["-m", "grok-4.5"]), ["-m", "grok-4.5"]);
  assert.deepEqual(grokArgs(["--model=grok-4.6"]), ["--model=grok-4.6"]);
});

test("an existing chat proxy override becomes the upstream rather than being replaced", () => {
  assert.equal(grokUpstream({}), "https://cli-chat-proxy.grok.com/v1");
  assert.equal(
    grokUpstream({ GROK_CLI_CHAT_PROXY_BASE_URL: "https://grok.acme.com/v1" }),
    "https://grok.acme.com/v1",
  );
  assert.equal(
    grokUpstream({ JEV_GROK_UPSTREAM: "https://a/v1", GROK_CLI_CHAT_PROXY_BASE_URL: "https://b/v1" }),
    "https://a/v1",
  );
});

test("registers the sentinel in Grok's config and takes it back out again", () => {
  const dir = mkdtempSync(join(tmpdir(), "jev-grok-"));
  const file = join(dir, "config.toml");
  const before = '[cli]\ninstaller = "internal"\n\n[ui]\nyolo = false\n';
  writeFileSync(file, before);

  const first = registerSentinel(file);
  assert.equal(first.changed, true);
  const registered = readFileSync(file, "utf8");
  assert.match(registered, /\[model\.jev-auto\]/);
  assert.match(registered, /api_backend = "responses"/);
  // Everything the user had is still there, ahead of our block.
  assert.ok(registered.startsWith(before.replace(/\s*$/, "")));

  // A second session while the first is running must not add it twice, and must know it did
  // not put it there, so exiting does not pull it out from under the first.
  assert.equal(registerSentinel(file).changed, false);

  assert.equal(unregisterSentinel(file), true);
  assert.equal(readFileSync(file, "utf8"), before);
  assert.equal(unregisterSentinel(file), false);
});

test("registering into a config that does not exist yet still produces valid TOML", () => {
  const file = join(mkdtempSync(join(tmpdir(), "jev-grok-")), "config.toml");
  assert.equal(registerSentinel(file).changed, true);
  assert.match(readFileSync(file, "utf8"), /^\[model\.jev-auto\]/);
  assert.equal(unregisterSentinel(file), true);
  assert.equal(readFileSync(file, "utf8"), "");
});

test("each tier names a model and an effort, cheapest first", () => {
  assert.deepEqual(grokTierSpec("haiku"), { model: "grok-4.5", effort: "low" });
  assert.deepEqual(grokTierSpec("sonnet"), { model: "grok-4.5", effort: "high" });
  assert.deepEqual(grokTierSpec("opus"), { model: "grok-4.6", effort: "high" });
  assert.deepEqual(grokTierSpec("fable"), { model: "grok-4.6", effort: "xhigh" });
});

test("applies the tier's model and effort, clamping one the model cannot run", () => {
  const models = modelMap();
  assert.deepEqual(applyGrokTier({ model: "jev-auto", reasoning: { effort: "high" } }, "haiku", models), {
    model: "grok-4.5",
    reasoning: { effort: "low" },
  });
  // xhigh only exists on 4.6, so a 4.5 tier configured for it falls back to 4.5's default.
  process.env.JEV_GROK_FAST_EFFORT = "xhigh";
  try {
    assert.deepEqual(applyGrokTier({ model: "jev-auto" }, "haiku", models).reasoning, { effort: "high" });
  } finally {
    delete process.env.JEV_GROK_FAST_EFFORT;
  }
  // The summary Grok asks for is preserved; only the effort is ours to set.
  assert.deepEqual(
    applyGrokTier({ model: "jev-auto", reasoning: { effort: "low", summary: "concise" } }, "opus", models)
      .reasoning,
    { effort: "high", summary: "concise" },
  );
  // An unknown tier leaves the request alone rather than guessing.
  const untouched = { model: "jev-auto", reasoning: { effort: "high" } };
  assert.deepEqual(applyGrokTier({ ...untouched }, "nonsense", models), untouched);
});

test("an effort override is honoured when the model supports it", () => {
  process.env.JEV_GROK_STRONG_EFFORT = "medium";
  try {
    assert.equal(grokTierSpec("opus").effort, "medium");
    assert.equal(applyGrokTier({ model: "jev-auto" }, "opus", modelMap()).reasoning.effort, "medium");
  } finally {
    delete process.env.JEV_GROK_STRONG_EFFORT;
  }
});

test("the sentinel and a loopback origin are cleaned out of Grok's cache", () => {
  const dir = mkdtempSync(join(tmpdir(), "jev-grok-"));
  const file = join(dir, "models_cache.json");
  writeFileSync(
    file,
    JSON.stringify({
      origin: "http://127.0.0.1:53211/v1/models",
      etag: 'W/"1"',
      models: { "jev-auto": {}, "grok-4.6": { info: {} } },
    }),
  );
  assert.equal(cleanModelsCache(file, "https://cli-chat-proxy.grok.com/v1"), true);
  const cache = JSON.parse(readFileSync(file, "utf8"));
  assert.deepEqual(Object.keys(cache.models), ["grok-4.6"]);
  assert.equal(cache.origin, "https://cli-chat-proxy.grok.com/v1/models");
  assert.equal(cache.etag, undefined);
  // Nothing to do the second time, and a missing file is not an error.
  assert.equal(cleanModelsCache(file, "https://cli-chat-proxy.grok.com/v1"), false);
  assert.equal(cleanModelsCache(join(dir, "absent.json")), false);
});

test("a saved default naming the sentinel is dropped, real settings are kept", () => {
  const dir = mkdtempSync(join(tmpdir(), "jev-grok-"));
  const file = join(dir, "config.toml");
  const body = '[ui]\nfork_secondary_model = "grok-4.6"\n\n[models]\ndefault = "jev-auto"\n';
  writeFileSync(file, body);
  assert.equal(cleanSavedModel(file), true);
  assert.equal(readFileSync(file, "utf8"), '[ui]\nfork_secondary_model = "grok-4.6"\n\n[models]\n');
  assert.equal(cleanSavedModel(file), false);
});

test("proxy routes a turn, extends the picker, and passes everything else through", async (t) => {
  const seen = [];
  const upstream = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      seen.push({ url: req.url, auth: req.headers.authorization, body: Buffer.concat(chunks).toString() });
      if (req.url === "/v1/models") {
        res.writeHead(200, { "content-type": "application/json" });
        return void res.end(JSON.stringify(catalogue()));
      }
      if (req.url === "/v1/responses") {
        res.writeHead(200, { "content-type": "text/event-stream" });
        return void res.end('event: response.created\ndata: {"type":"response.created"}\n\n');
      }
      res.writeHead(204).end();
    });
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  t.after(() => upstream.close());

  const route = async ({ prompt, available }) => {
    assert.equal(prompt, "Rename the helper");
    assert.deepEqual(available, ["haiku", "sonnet", "opus", "fable"]);
    return { choice: "haiku", confidence: 0.95, probabilities: {} };
  };
  const proxy = await startGrokProxy({
    baseURL: `http://127.0.0.1:${upstream.address().port}/v1`,
    route,
  });
  t.after(() => proxy.close());
  const base = `http://127.0.0.1:${proxy.port}`;

  // The catalogue is read on the way past so efforts can be clamped, and returned unaltered:
  // Grok resolves model ids against its own list and discards a row it did not expect.
  const catalog = await (await fetch(`${base}/v1/models`)).json();
  assert.deepEqual(
    catalog.data.map((model) => model.id),
    ["grok-4.6", "grok-4.5"],
  );

  const turn = {
    model: "jev-auto",
    prompt_cache_key: "session-1",
    stream: true,
    reasoning: { effort: "high", summary: "concise" },
    input: [
      { type: "message", role: "user", content: "<user_info>windows</user_info>" },
      { type: "message", role: "user", content: "<user_query>Rename the helper</user_query>" },
    ],
  };
  const routed = await fetch(`${base}/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer session-token" },
    body: JSON.stringify(turn),
  });
  assert.equal(routed.headers.get("content-type"), "text/event-stream");
  assert.match(await routed.text(), /response\.created/);

  const sent = JSON.parse(seen.at(-1).body);
  assert.equal(sent.model, "grok-4.5");
  assert.deepEqual(sent.reasoning, { effort: "low", summary: "concise" });
  // The session credential is forwarded untouched and never read by the router.
  assert.equal(seen.at(-1).auth, "Bearer session-token");

  // A model the user picked by hand is passed through, and so is an unrelated endpoint.
  await fetch(`${base}/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...turn, model: "grok-4.6" }),
  });
  assert.equal(JSON.parse(seen.at(-1).body).model, "grok-4.6");
  await fetch(`${base}/v1/traces`, { method: "POST", body: "{}" });
  assert.equal(seen.at(-1).url, "/v1/traces");
});

test("a tool continuation keeps the tier the turn was routed to", async (t) => {
  const upstream = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      if (req.url === "/v1/models") {
        res.writeHead(200, { "content-type": "application/json" });
        return void res.end(JSON.stringify(catalogue()));
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(Buffer.concat(chunks));
    });
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  t.after(() => upstream.close());

  let calls = 0;
  const proxy = await startGrokProxy({
    baseURL: `http://127.0.0.1:${upstream.address().port}/v1`,
    route: async () => {
      calls += 1;
      return { choice: "fable", confidence: 0.99, probabilities: {} };
    },
  });
  t.after(() => proxy.close());
  const base = `http://127.0.0.1:${proxy.port}`;
  await fetch(`${base}/v1/models`);

  const post = async (input) =>
    (
      await fetch(`${base}/v1/responses`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "jev-auto", prompt_cache_key: "session-2", input }),
      })
    ).json();

  const first = await post([{ type: "message", role: "user", content: "Debug the deadlock" }]);
  assert.equal(first.model, "grok-4.6");
  assert.equal(calls, 1);

  const second = await post([
    { type: "message", role: "user", content: "Debug the deadlock" },
    { type: "function_call", call_id: "1", name: "shell", arguments: "{}" },
    { type: "function_call_output", call_id: "1", output: "done" },
  ]);
  assert.equal(second.model, "grok-4.6");
  assert.equal(calls, 1, "a tool continuation must not ask Jev again");
});

test("reads a compressed catalogue, so efforts are clamped against real model data", async (t) => {
  const encoded = gzipSync(Buffer.from(JSON.stringify(catalogue())));
  const sent = [];
  const upstream = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      if (req.url === "/v1/models") {
        res.writeHead(200, { "content-type": "application/json", "content-encoding": "gzip" });
        return void res.end(encoded);
      }
      sent.push(JSON.parse(Buffer.concat(chunks).toString()));
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
    });
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  t.after(() => upstream.close());

  const proxy = await startGrokProxy({
    baseURL: `http://127.0.0.1:${upstream.address().port}/v1`,
    route: async () => ({ choice: "haiku", confidence: 0.99, probabilities: {} }),
  });
  t.after(() => proxy.close());
  const base = `http://127.0.0.1:${proxy.port}`;

  const catalogResponse = await fetch(`${base}/v1/models`);
  // The client still receives the bytes exactly as the upstream sent them.
  assert.equal(catalogResponse.headers.get("content-encoding"), "gzip");
  assert.deepEqual(
    (await catalogResponse.json()).data.map((model) => model.id),
    ["grok-4.6", "grok-4.5"],
  );

  process.env.JEV_GROK_FAST_EFFORT = "xhigh";
  try {
    await fetch(`${base}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "jev-auto",
        prompt_cache_key: "session-3",
        input: [{ type: "message", role: "user", content: "rename a variable" }],
      }),
    });
  } finally {
    delete process.env.JEV_GROK_FAST_EFFORT;
  }
  // xhigh does not exist on 4.5; without the catalogue it would have gone out unclamped.
  assert.deepEqual(sent.at(-1).reasoning, { effort: "high" });
});

test("a session_title errand is pinned to the cheapest tier without asking Jev", async (t) => {
  // Grok fires one of these per agent, sub-agents included, and it inherits the sentinel from
  // the session. Measured 2026-09-19: routing it spent a Jev call, and a routed tier, on a
  // 100-token title. It still has to name a real model, because the sentinel exists only in
  // Grok's local catalogue.
  const upstream = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      if (req.url === "/v1/models") {
        res.writeHead(200, { "content-type": "application/json" });
        return void res.end(JSON.stringify(catalogue()));
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(Buffer.concat(chunks));
    });
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  t.after(() => upstream.close());

  let calls = 0;
  const proxy = await startGrokProxy({
    baseURL: `http://127.0.0.1:${upstream.address().port}/v1`,
    route: async () => {
      calls += 1;
      return { choice: "fable", confidence: 0.99, probabilities: {} };
    },
  });
  t.after(() => proxy.close());
  const base = `http://127.0.0.1:${proxy.port}`;
  await fetch(`${base}/v1/models`);

  const title = await (
    await fetch(`${base}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "jev-auto",
        max_output_tokens: 100,
        tool_choice: { type: "function", name: "session_title" },
        tools: [{ type: "function", name: "session_title" }],
        input: [
          { type: "message", role: "system", content: "Write a short title." },
          { type: "message", role: "user", content: "<user_query> Use a subagent </user_query>" },
        ],
      }),
    })
  ).json();

  assert.equal(calls, 0, "a title errand must not cost a Jev call");
  assert.equal(title.model, grokTierSpec("haiku").model);
  assert.notEqual(title.model, "jev-auto", "the sentinel is not a model xAI can serve");
});
