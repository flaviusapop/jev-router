# jev-router

![Jev Router in the Claude Code model picker](docs/model-picker.png)

Automatic model routing for Claude Code, OpenAI Codex, the Grok CLI and opencode. Each turn goes to the
cheapest model **and reasoning depth** that can actually finish it — a typo to the fast tier, an
unknown-cause bug to the strong one — with the decision made by
[Jev](https://docs.typesafe.ai), TypeSafe's System One decision model.

It runs the real CLI in every case. The interface, keybindings, tools, permission prompts,
`/compact`, `/resume` and session handling are unchanged, because they are still the CLI's own.
Only the model field on the way past is rewritten.

## Quick start

Requires Node.js 22+ and at least one of
[Claude Code](https://code.claude.com/docs/en/setup),
[Codex](https://developers.openai.com/codex/cli), [Grok](https://docs.x.ai/docs/grok-cli) or
[opencode](https://opencode.ai/docs).

```bash
npm install -g @flaviusapop/jev-router
echo "JEV_API_KEY=..." > ~/.jev-router.env
jev-claude      # or jev-codex, jev-grok, jev-opencode
```

On Windows PowerShell, create the environment file with:

```powershell
Set-Content "$HOME\.jev-router.env" "JEV_API_KEY=..."
```

Get a key from [TypeSafe](https://docs.typesafe.ai) for free. No supplier API key is needed:
each launcher reuses the login the real CLI already has, so a Claude Pro or Max, ChatGPT or
SuperGrok subscription works as-is. Without a Jev key you simply get the plain CLI.

To run from a clone instead:

```bash
git clone https://github.com/flaviusapop/jev-router.git
cd jev-router
npm install
npm link
```

## How your credentials are handled

Each launcher starts a proxy on `127.0.0.1` on a random port and points the CLI at it for the
length of the session. Your supplier token therefore passes through this process on its way
upstream. It is forwarded verbatim and never read, stored or logged, and the proxy accepts
connections from localhost only. The one field rewritten on a request is the model, plus the
reasoning effort that goes with it.

Two things do leave your machine, and only these: the text of each new user turn is sent to
Jev to be classified, and the request itself goes to the supplier it was always going to.
`JEV_DEBUG=1` logs decisions locally, and `JEV_DUMP` writes whole request bodies to disk —
useful for debugging, but they contain your prompts and code, so treat those files
accordingly.

## Provenance

This project began as a fork of [jev-router by Pratyush
Garg](https://github.com/gargpratyush/jev-router), MIT licensed, and now develops
independently. Upstream contributed the idea and the first working Claude Code and Codex
proxies; Grok support, tiers as (model, effort) pairs, sub-agent routing across all three
CLIs, length-hint stripping and the override vocabulary were built here. See
[NOTICE](NOTICE). Upstream is not affiliated with this project.

## Using it

Start whichever CLI you already use. Everything else about it is unchanged.

```bash
jev-claude      # Claude Code
jev-codex       # OpenAI Codex
jev-grok        # Grok CLI
jev-opencode    # opencode
```

Each turn is then routed on its own: a typo goes to the cheap tier, an unknown-cause bug to
the strong one. Arguments are passed straight through, so `jev-codex exec "..."`,
`jev-grok -p "..."` and `jev-opencode run "..."` all work as usual.

### Choosing the model yourself

Three ways, in order of how long they last.

**For one turn** — name a tier or a model in the prompt. Jev is skipped:

```
use opus: why does this reconnect loop drop messages?
switch to haiku and fix the typo in README
use claude-opus-5 for this
run this on the fast tier
```

Recognised names are `haiku`, `sonnet`, `opus`, `fable`, any real model id, and `fast`,
`balanced`, `strong`, `cheap`, `long` or `deep` when followed by "tier" or "model". Ordinary
English is left alone: `replace the int with long` is not a model choice.

**For the rest of the session** — pick a model in the CLI itself (`/model` in Claude Code and
Codex). Routing stands down for that conversation and your choice goes to the API untouched.
Sub-agents it spawns are still routed. Reselect **Jev Router** to resume.

**For every session** — pass a model on the command line, and nothing is routed at all:

```bash
jev-claude --model claude-opus-5
```

### Seeing what actually happened

Every CLI's UI shows the model it *asked* for, never the one the proxy routed to. Two ways to
see the truth:

```bash
JEV_DEBUG=1 jev-claude     # decisions, and the model the API says it served
```

In Claude Code there is also a status line:

```
⚡ haiku p=0.98 · my-project · 8% context        routed, Jev confidence 0.98
⏸ manual Opus 4.6 · my-project · 21% context     your own choice
```

It is installed with `--settings`, which merges rather than replaces: if you already have a
`statusLine`, yours is kept. `JEV_NO_STATUSLINE=1` turns it off. In interactive mode the log
goes to `~/.jev-claude.log`; with `-p` or `run` it goes to stderr.

### Changing what a tier means

Every model and every effort is overridable, per supplier:

```bash
JEV_CLAUDE_STRONG_MODEL=claude-opus-4-1   # what the strong tier runs
JEV_GROK_FAST_EFFORT=high                 # how hard the cheap tier thinks
JEV_DISABLE_TIERS=fable                   # never route here at all
```

Tier stems are `FAST`, `BALANCED`, `STRONG`, `LONG`. Put them in `~/.jev-router.env` beside
your key to make them permanent.

> In Claude Code and Codex, choosing a row with `Enter` saves it as your default for new
> sessions. `jev-claude` restores your previous default on exit, so a saved `jev-auto` can
> never break plain `claude`. Press `s` to switch for this session only.

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
  the prompt cache and one cheap turn does not repay the rebuild - but only until Jev has
  confidently asked for a cheaper tier three turns running, at which point a run of cheap
  turns does repay it and the session comes down. Without that release the guard was a
  one-way ratchet: nothing here blocks an *upgrade*, so one hard turn pinned a session to the
  top tier for good;
- the tier is clamped to what is enabled, stepping up rather than down, and never up into
  Fable, which bills extra usage credits.

Routing is fail-open by construction: every error path keeps the original model.

Three kinds of request are deliberately not routed:

| Request | Reason |
| --- | --- |
| Any model other than `jev-auto` | You chose it. This also covers Claude Code's internal Haiku calls for titles and summaries. |
| Tool-loop continuations | A turn spans many requests. The tier is chosen once and pinned, so the model cannot change mid-task. |
| Calls carrying no tools | Auxiliary work, not a user turn. |
| Calls belonging to no agent session | Codex and Grok fire side errands - a session title, a recap - that inherit the sentinel because it is the session's model. They carry no thread and no cache key, and are pinned to the cheapest tier rather than routed. |
| A finished sub-agent's handback | Codex returns a sub-agent's result to its parent as a `user` message, not a tool result, so it reads like a fresh turn. It is the tail of a turn already routed. |

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
| `JEV_GROK_UPSTREAM` | HTTPS chat proxy the Grok router forwards to. Defaults to an existing `GROK_CLI_CHAT_PROXY_BASE_URL`, then to xAI's. Plain HTTP is accepted only on literal loopback addresses. |

All four launchers read the real environment first, then fill missing values from
`~/.jev-router.env` and the legacy `~/.jev-claude.env`. A project-local `.env` is deliberately
not loaded: repositories are untrusted input, while these settings control destinations that
receive credentials. `TYPESAFE_API_KEY` is accepted anywhere `JEV_API_KEY` is.

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

All three CLIs spawn them, and each hides the fact somewhere different.

### Claude Code

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

A pick is remembered for the rest of the session, not for one turn. Handing the conversation
back removes it from the routed set, which on its next turn would make it look like a brand new
conversation inside a routed session - a sub-agent spawn - and the router would take it
straight back.

Sub-agents that conversation spawns are still routed. Picking a model says what *you* want to
work with; it does not say what every search and file-listing agent it spawns should cost.

```
6bc4b3247b8f          p=0.95 sonnet -> haiku  | Use the Explore agent to find where...
939390f7e6c4 subagent p=0.98 sonnet -> haiku  | Search this repository for where...
939390f7e6c4 rewrite claude-opus-5 -> claude-haiku-4-5-20251001
```

Each sub-agent keeps its own tier under its own key, so its follow-up tool-loop requests reuse
that tier without re-asking Jev, and its choice never leaks into the parent's status line.

Conversation keys ignore `<system-reminder>` blocks for this reason: Claude Code rewrites them
between requests, and a key that churns mid-conversation costs a redundant Jev call per turn.

### Codex

Codex sub-agents inherit the sentinel, so they were always routed - but under the *parent's*
key. Measured 2026-09-19: a `SpawnAgent` turn and the sub-agent it spawned shared
`prompt_cache_key` `01a0b47e-ac01-...`, so each overwrote the other's tier and each was then
told its prompt cache had been built on the other's model.

`client_metadata.thread_id` is what actually separates them - the sub-agent's was
`01a0b47e-c849-...` - so the conversation key is taken from the thread, not the cache key.
Sub-agent requests also carry `x-openai-subagent`, which is used only to name them in the log:

```
a15d2d9b0722          sonnet -> haiku | Delegate to a subagent: have it search...
62ffb5410074 subagent sonnet -> haiku | Search the repository for the definition of...
```

When the sub-agent finishes, Codex hands its result back to the parent as a `user` message
wrapped in `<subagent_notification>`. That is a continuation, not a turn, and is not routed.
A prompt where the *human* mentions sub-agents is untouched.

### Grok

Grok gives each agent its own `prompt_cache_key`, so sub-agents route correctly with no
special handling. What did need fixing is the errand beside them: Grok asks for a session
title per agent, sub-agents included, with `tool_choice` pinned to one function and a
100-token cap. It inherits the sentinel, and was costing a full Jev call and a routed tier to
write a title. It is now pinned to the cheapest tier instead - it still has to name a real
model, because the sentinel exists only in Grok's local catalogue.

Grok's own `--no-subagents` still turns the feature off entirely; nothing here overrides it.

### opencode

opencode speaks the Anthropic Messages API through its `anthropic` provider, so the same proxy
that serves Claude Code serves it unchanged. `jev-opencode` starts that proxy and points
opencode at it through `OPENCODE_CONFIG`, which **merges** over your own configuration rather
than replacing it - an MCP server you configured globally is still there. Nothing of yours is
written to, and there is nothing to put back when the session ends.

The sentinel is declared as a model beside the real ones, because opencode takes its catalogue
from models.dev, which has never heard of `jev-auto`:

```json
{
  "model": "anthropic/jev-auto",
  "provider": {
    "anthropic": {
      "options": { "baseURL": "http://127.0.0.1:PORT/v1" },
      "models": { "jev-auto": { "name": "Jev Router", "tool_call": true, "reasoning": true } }
    }
  }
}
```

Its declared context and output limits are deliberately the smallest any tier can serve.
opencode composes `max_tokens` from whatever the chosen model declares, so claiming Opus's
window and then routing a turn down to Haiku would be a hard 400 on the way out.

Sub-agents needed no special handling at all: opencode gives **every agent its own session**
and sends it as an `x-session-id` header, so a `task` spawn is a different conversation by
construction. Measured 2026-09-18 on opencode 1.18.29:

```
passthrough, user selected claude-haiku-4-5-20251001   <- the title agent, never routed
20129121b242 698ms p=0.69 sonnet -> haiku | "Use the task tool to spawn a subagent...
6af1ee1034a8 298ms p=1.00 sonnet -> haiku | Read the file probe.txt from the current...
```

`small_model` is left alone. opencode uses it for titles and summaries, those requests carry
no tools, and a call with no tools is never routed.
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
export JEV_API_KEY=...

npm test                     # 139 offline tests
node scripts/live-routing.mjs   # real Jev calls across four difficulty tiers
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
- Developed on Windows against Claude Code v2.1.101, Codex v0.60.0, Grok CLI v1.0.34 and
  opencode v1.18.29. macOS and Linux are covered by CI rather than by daily use: every
  launcher is started there against a stub CLI and has to reach it, pass its arguments
  through, and fail cleanly when the CLI is missing. Routing itself is platform-independent,
  but a report from real use on either is welcome.
  CI runs the suite on Linux, macOS and Windows against Node 22 and 24; the suite
  stands up its own local upstreams, so it never reaches a supplier or Jev.

## Contributing

Issues and pull requests are welcome. Use [Issues](https://github.com/flaviusapop/jev-router/issues)
to report bugs, request improvements, or ask questions. Please include the CLI and its
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
