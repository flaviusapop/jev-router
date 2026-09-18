# jev-router (43% less ⬇️ tokens consumption for Claude Code)

![Jev Router in the Claude Code model picker](docs/model-picker.png)

Automatic model routing for Claude Code, OpenAI Codex and the Grok CLI. Each turn goes to the cheapest model that can
actually handle it — trivial edits to the fast tier, hard debugging to the strong tier — with the decision made
by [Jev](https://docs.typesafe.ai), TypeSafe's System One decision model.

It runs the real Claude Code CLI. The interface, keybindings, tools, permission prompts,
`/compact`, `/resume` and session handling are unchanged, because they are still Claude
Code's.

## Quick start

Requires [Claude Code](https://code.claude.com/docs/en/setup) and Node.js 20.12+.

```bash
git clone https://github.com/gargpratyush/jev-router.git
cd jev-router
npm install
npm link
echo "JEV_API_KEY=..." > ~/.jev-claude.env
jev-claude
```

On Windows PowerShell, create the environment file with:

```powershell
Set-Content "$HOME\.jev-claude.env" "JEV_API_KEY=..."
```

`npm link` makes the `jev-claude` command available globally, so after this one-time setup
you can run `jev-claude` from any repository. The home-level environment file is also loaded
regardless of which repository you run it from. Without `npm link`, run
`node bin/jev-claude.mjs` from the cloned directory.

Get a key from [TypeSafe](https://docs.typesafe.ai) for free. The npm package is not published
yet, so the repository is run directly with Node.js. No `ANTHROPIC_API_KEY` is needed:
`jev-claude` reuses your existing `claude login`, so a Claude Pro or Max subscription works
as-is. Without a Jev key you simply get plain Claude Code.

Every argument is forwarded to `claude`, so `jev-claude -p "..."`, `jev-claude --resume` and
the rest behave exactly as you expect.

For Codex, keep your existing `codex login` and run:

```bash
jev-codex
```

`jev-codex` launches the real Codex CLI with a temporary **Jev Router** provider. It reuses
Codex's own ChatGPT subscription or API-key authentication; Jev never reads or stores the
credential. The native `/model` picker includes **Jev Router** alongside the models available
to your account. Selecting another model pauses routing, and selecting **Jev Router** resumes it.
Each fresh Jev decision appears in Codex as a commentary line before the model's response.
If Jev is unavailable, the line names the fallback model and points to
`~/.jev-router.env`, where `JEV_API_KEY=...` should be set before restarting `jev-codex`.

For Grok, keep your existing `grok login` and run:

```bash
jev-grok
```

`jev-grok` launches the real Grok CLI against a loopback chat proxy, reusing the session
credential Grok already holds; Jev never reads or stores it. Grok resolves model ids against
its own catalogue and discards one it does not recognise, so the sentinel is registered the
documented way instead: a `[model.jev-auto]` block is added to `~/.grok/config.toml` before
the CLI starts and removed again on exit, including after Ctrl-C. Everything else in that
file is preserved byte for byte. Naming a model yourself (`jev-grok -m grok-4.6`) passes it
straight through and routes nothing.

Grok exposes two models that both take a reasoning effort, so a tier there is a model *and*
an effort rather than a model alone, and routing down a tier can mean the same model thinking
less. The ladder is `grok-4.5` at low effort, `grok-4.5` at high, `grok-4.6` at high, then
`grok-4.6` at extra-high for the opt-in long tier. Grok's TUI has no status line hook, so
each decision is written to `~/.jev-claude.log` instead.

## Using it

Sessions start on a **Jev Router** entry added to the `/model` picker
([pictured above](docs/model-picker.png)). While it is selected,
every turn is routed. Pick any other model and routing stands down entirely: your choice goes
to the API untouched and Jev is not consulted. Reselect Jev Router to resume routing
mid-session.

A status line shows which mode you are in and what the last turn actually used:

```
⚡ haiku p=0.98 · my-project · 8% context        routed, Jev confidence 0.98
⏸ manual Opus 4.6 · my-project · 21% context     your own choice
```

This matters because Claude Code's own UI reports the model it *requested*, not the one the
proxy routed to. It has no way to know the request was rewritten.

The status line is installed with `--settings`, which merges rather than replaces. If you
already have a `statusLine` configured, yours is kept and nothing is injected. Set
`JEV_NO_STATUSLINE=1` to disable it.

> Choosing any row with `Enter` makes Claude Code save it as your default for new sessions.
> `jev-claude` restores your previous default on exit, so a saved `jev-auto` can never break
> plain `claude`. Press `s` instead to switch for the current session only.

## How it works

`jev-claude` starts a proxy on a loopback port and launches the real `claude` with
`ANTHROPIC_BASE_URL` pointing at it. Claude Code sends its normal requests; the proxy
rewrites one field and forwards everything upstream.

```
you -> claude (real CLI, real UI) -> jev-claude proxy -> api.anthropic.com
                                            |
                                            +-> Jev: which tier does this turn need?
```

Claude Code does not validate model names behind a custom base URL, so the `jev-auto`
sentinel reaches the proxy as an exact "route this turn" signal rather than something to
infer.

Your credentials are never read, stored or modified. The proxy forwards the `authorization`
header it receives without inspecting it.

## Routing rules

One Jev call per user turn selects a tier. `src/policy.mjs` then applies, in order:

- an explicit `use opus` in your message wins outright;
- a Jev failure, timeout or unrecognised answer keeps the current model;
- a low-confidence answer never downgrades, and caps upgrades at Sonnet;
- a downgrade is refused once the conversation is large, since switching models invalidates
  the prompt cache and the rebuild costs more than the downgrade saves;
- the tier is clamped to what is enabled, stepping up rather than down, and never up into
  Fable, which bills extra usage credits.

Routing is fail-open by construction: every error path keeps the original model.

Three kinds of request are deliberately not routed:

| Request | Reason |
| --- | --- |
| Any model other than `jev-auto` | You chose it. This also covers Claude Code's internal Haiku calls for titles and summaries. |
| Tool-loop continuations | A turn spans many requests. The tier is chosen once and pinned, so the model cannot change mid-task. |
| Calls carrying no tools | Auxiliary work, not a user turn. |

Sub-agents are routed, but pinned separately, so a sub-agent's choice cannot leak into the
main conversation.

## Configuration

| Variable | Effect |
| --- | --- |
| `JEV_API_KEY` | Required for routing. `TYPESAFE_API_KEY` also works. |
| `JEV_NO_STATUSLINE` | Set to `1` to stop injecting the status line. |
| `JEV_DEBUG` | Logs every decision and rewrite. Interactive sessions write to `~/.jev-claude.log`, since stderr would corrupt Claude Code's UI; `-p` mode writes to stderr. |
| `JEV_DUMP` | Path prefix for dumping request bodies, for debugging wire-format changes. |
| `JEV_<SUPPLIER>_<TIER>_MODEL` | Override one tier's model. Supplier is `CLAUDE`, `CODEX` or `GROK`; tier is `FAST`, `BALANCED`, `STRONG` or `LONG`. |
| `JEV_<SUPPLIER>_<TIER>_EFFORT` | Override one tier's reasoning effort, same naming. |
| `JEV_DISABLE_TIERS` | Comma-separated tier names to take out of play, e.g. `JEV_DISABLE_TIERS=fable`. All four are on by default. |
| `JEV_GROK_UPSTREAM` | Chat proxy the Grok router forwards to. Defaults to an existing `GROK_CLI_CHAT_PROXY_BASE_URL`, then to xAI's. |

All three launchers read the same files, in increasing order of precedence: the real
environment, then `~/.jev-claude.env`, then `~/.jev-router.env`, then a `.env` in the launch
directory. Since the commands are installed globally, `~/.jev-router.env` is the usual place;
`~/.jev-claude.env` is still read so an older setup keeps working. `TYPESAFE_API_KEY` is
accepted anywhere `JEV_API_KEY` is.

### The tier table

Every model and effort for every supplier is one table at the top of `src/config.mjs`. Edit
that and you have changed the router; nothing else needs touching.

| Tier | Claude | Codex | Grok |
| --- | --- | --- | --- |
| `haiku` - trivial, mechanical | `claude-haiku-4-5` (no effort) | `gpt-5.6-luna` low | `grok-4.5` low |
| `sonnet` - ordinary, bounded | `claude-sonnet-5` high | `gpt-5.6-terra` medium | `grok-4.5` high |
| `opus` - hard, ambiguous | `claude-opus-5` high | `gpt-5.6-sol` high | `grok-4.6` high |
| `fable` - hardest, deepest | `claude-opus-5` **xhigh** | `gpt-5.6-sol` **xhigh** | `grok-4.6` **xhigh** |

A tier is a *(model, effort)* pair, not a model. Every supplier now sells reasoning depth
separately from model choice, so the top tier is the strong model thinking harder rather than
a pricier model - which is why no tier reaches for `claude-fable-5-1` or `gpt-6-astra`, both of
which bill extra credits on top of a subscription. All four tiers are therefore on by default.

Haiku 4.5 is the one model with no effort at all: sending `output_config.effort` to it is a
hard 400, so the fast tier strips it.

The tier names are internal ids kept for continuity, and `family` (the substring used to
recognise a model a CLI asked for) is deliberately separate from what a tier routes *to* - a
Fable model you pick by hand is still recognised as the `fable` tier.

The Jev question, confidence thresholds and timeouts live in the same file, which is the
entire policy surface.

## What Jev is asked

One question, `model_tier`, and one field of state: the request.

```js
state: { request: stripLengthHints(prompt) }
```

Jev is a classifier, not a generator — it returns a probability over four labels and nothing
else, which is why a decision costs ~300 ms warm. The four tiers, their signals and the
instruction are all in `src/config.mjs`.

Everything else the caller knows is deliberately withheld. Measured on 2026-09-18 across four
prompts spanning all four tiers, adding the current model, the context size or the list of
available tiers changed **no** choice and *lowered* confidence on three of the four:

| prompt | full state | request only |
|---|---|---|
| fix a typo | haiku 1.00 | haiku 1.00 |
| add a unit test | sonnet 0.90 | sonnet 0.98 |
| debug unknown-cause logouts | opus 0.93 | opus 0.98 |
| whole-repo migration | fable 0.98 | fable 0.99 |

The current model, the context size and the available tiers are still used — by `decide()` in
`src/policy.mjs`, where they are code-side gates rather than hints, and where
`clampToAvailable` enforces what the account can actually run.

### Length hints are stripped first

How short a reply should be says nothing about how hard the question is. The instruction says
so explicitly, and it is not enough: appending `"One paragraph."` to a dispatcher design
question moved it from **opus 0.54 to sonnet 0.37** — a full tier, for four words that changed
nothing about the thinking required. So `stripLengthHints()` removes them before Jev sees the
prompt, and the instruction stays as a second line of defence. With both in place that same
prompt reads **opus 0.89**.

Stripping is anchored to directives, never to the words alone, so the work survives:

| stripped | kept |
|---|---|
| `Design how X should decide. One paragraph.` | `write a function that returns one line per row` |
| `figure out why — name the cause in one sentence` | `split the CSV into 3 lines` |
| `explain the auth flow, briefly` | `a brief history of the auth module` |
| `summarise this in 3 bullets` | `refactor the parser so each rule emits one line` |

A prompt that is *only* a length hint is left alone, so there is always something to judge.

## Sub-agents

A sub-agent is routed independently of the agent that spawned it, on the text of its own task.
A search sub-agent lands on the cheap tier while its parent is working at the expensive one,
and a design sub-agent lands on the expensive tier while its parent sits cheap.

Claude Code spawns them two different ways, and both are handled:

- **Inheriting the sentinel.** The request arrives as `jev-auto` and routes like any other
  conversation.
- **Naming a resolved model.** Claude Code resolves some agents' models at spawn time and
  sends a concrete id. Measured 2026-09-18: a main agent routed to Haiku spawned an Explore
  agent that ran on `claude-opus-5`, completely unrouted.

The second case is indistinguishable from a `/model` pick at the model field, so the
conversation is what separates them. A sub-agent opens a **new** conversation inside a session
already being routed; a `/model` pick stays in the conversation it was made in, whose key is
already known. An explicit pick still beats the router, exactly as before.

```
6bc4b3247b8f          p=0.95 sonnet -> haiku  | Use the Explore agent to find where...
939390f7e6c4 subagent p=0.98 sonnet -> haiku  | Search this repository for where...
939390f7e6c4 rewrite claude-opus-5 -> claude-haiku-4-5-20251001
```

Each sub-agent keeps its own tier under its own key, so its follow-up tool-loop requests reuse
that tier without re-asking Jev, and its choice never leaks into the parent's status line.

Conversation keys ignore `<system-reminder>` blocks for this reason: Claude Code rewrites them
between requests, and a key that churns mid-conversation costs a redundant Jev call per turn.

## Compatibility notes

Three things the proxy has to handle, none of them documented:

- **MCP tool schemas.** Claude Code normalises draft-04 JSON Schema relics before sending
  them first-party, but skips that step when `ANTHROPIC_BASE_URL` is set. An MCP server
  emitting `"exclusiveMinimum": true` would have the entire request rejected, so the proxy
  performs the conversion itself.
- **Model capabilities.** Claude Code composes each body for the model it believes it is
  using. Routing down to Haiku while leaving `thinking`, `output_config.effort` or a
  `clear_thinking` context-management strategy in place is a hard 400, so those fields are
  stripped for tiers that do not support them.
- **`HEAD /`.** Claude Code probes the base URL before its first request.

## Development

```bash
npm install
echo "JEV_API_KEY=..." > .env

npm test                     # 96 offline tests
node test/live-routing.mjs   # real Jev calls across four difficulty tiers
node bin/jev-claude.mjs -p "what is 2+2?"

npm link                     # try the globally installed form
```

`npm test` covers the policy decision table with synthetic Jev answers, plus the proxy's pure
functions: schema sanitising, turn detection, capability stripping, conversation keying,
length-hint stripping, sub-agent detection and settings restoration.

`JEV_DEBUG=1` logs each decision, the rewrite it produced, and the model the supplier says it
actually served — read off the response body, so routing is confirmed from the wire rather
than trusted from the decision log. In interactive mode that goes to `~/.jev-claude.log`,
because the CLI owns the terminal.

The wording of the Jev question matters more than expected. Instructing Jev to judge the
reasoning a request demands rather than the length of the reply it asks for moved a hard
debugging prompt ending in "answer in one sentence" from 0.21 confidence on Haiku to 0.81 on
Opus.

## Limitations

- Your prompt text is sent to TypeSafe for the routing decision. Nothing else is.
- Jev adds roughly 300 ms to the first request of a turn, and about a second on the first
  call of a session while TLS is established. Tool-loop requests add nothing.
- Claude Code's request format is not a public contract. If a future version moves things
  around, `JEV_DUMP` is how you find out.
- Effort is set on every routed turn, overriding what the CLI asked for. That is the point of
  a tier being a (model, effort) pair, but it does mean an effort you pick in the CLI's own UI
  is ignored while routing is on.
- Codex workspace-specific enterprise routing is internal to its built-in provider. The
  wrapper forwards the same bearer token and account headers to the standard ChatGPT Codex
  endpoint, but cannot reproduce a private workspace origin that Codex does not expose.
- Grok and Codex both fire unrouted side requests on their default model — Grok one per turn
  for its dashboard line, Codex one either side of the routed turn. Measured on 2026-09-17, a
  single trivial `jev-codex exec` was served three times: `gpt-5.6-luna` for the routed turn
  and `gpt-5.6-sol` twice around it. Claude Code does the same for its own internal features —
  conversation recaps and typeahead suggestions each cost a routed turn. This is each CLI's own
  behaviour, present with or without the router, and those requests are passed through
  untouched because they name a model explicitly. It does mean the cheapest tier never makes a
  whole session cheap.
- Under the Grok sentinel the system prompt Grok builds says "Grok 4.6" whichever model the
  turn is finally routed to, because the CLI composes it before the proxy sees the request.
- Developed and tested on Windows against Claude Code v2.1.101 and Grok CLI v1.0.34.

## Contributing

Issues and pull requests are welcome. Use [Issues](https://github.com/gargpratyush/jev-router/issues)
to report bugs, request improvements, or ask questions. Please include the relevant Claude Code
version, reproduction steps, expected behavior, and any useful logs with secrets removed.

For a pull request:

1. Fork the repository and create a focused branch from `master`.
2. Make the smallest change that solves the problem.
3. Run `npm test` and include tests for non-trivial behavior changes.
4. Explain the problem, the approach, and validation in the pull request description.

Please do not commit API keys or other secrets. All contributions require review, and only the
repository owner can merge pull requests.

## License

MIT
