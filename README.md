# Jev Skill Router

A Pi 0.87-compatible extension that limits the skill metadata advertised to the main model and semantically supplies relevant hidden skill instructions. It preserves Pi's native skill discovery, `/skill:name` commands, and trusted paths.

## Requirements

- Pi 0.87.0-compatible extension APIs.
- Node.js 20 or newer for this package. The `@earendil-works/pi-coding-agent@0.87.0` package used for compatibility testing declares Node.js `>=22.19.0`; use the stricter minimum declared by your Pi installation.
- A configured Pi `openai-codex/gpt-6-luna` model for interpretation and a TypeSafe API key for Jev classification.

## Setup

Set `TYPESAFE_API_KEY` in the environment used to launch Pi. Do not put it in router configuration or commit it.

```sh
# Replace the placeholder using your secret manager or shell's secure environment setup.
export TYPESAFE_API_KEY="<your Typesafe API key>"
```

On Windows PowerShell, set `$env:TYPESAFE_API_KEY` in the Pi process environment. Luna uses Pi's normal provider authentication separately from this TypeSafe key. Configure the `openai-codex` provider with Pi's usual auth flow; the router never changes the active main model or thinking level.

Copy `jev-skill-router.example.json` to `~/.pi/agent/jev-skill-router.json` and replace the placeholder skill name with a normally advertisable skill you want to keep visible. A trusted project may instead use `.pi/jev-skill-router.json`; trusted project values override the user configuration. Session command overrides do not write configuration files.

### Optional Pi package installation

This is an opt-in activation step, separate from building or testing this repository. Review the source first: Pi packages run with full system access. From the repository directory, install it with:

```sh
pi install .
```

Pi writes the package registration to user settings by default; `pi install -l .` writes project settings. Neither command is needed to run this repository's tests, and installation was not performed as part of implementation.

## Configuration

The user file is `~/.pi/agent/jev-skill-router.json`. Project configuration is read from `<cwd>/.pi/jev-skill-router.json` only when Pi trusts that project. Project values override user values. Session overrides are in-memory only.

| Key | Default | Validation / meaning |
| --- | --- | --- |
| `enabled` | `true` | Boolean; disables both automatic and on-demand routing when false. |
| `autoRouting` | `true` | Boolean; controls automatic routing only. |
| `interpreterModel` | `"openai-codex/gpt-6-luna"` | Non-empty exact `provider/modelId`; must resolve unambiguously in Pi's available model registry. |
| `interpreterThinking` | `"low"` | Only `"low"` is accepted. |
| `recentUserMessages` | `4` | Integer from 1 to 100; older user messages considered for interpretation. |
| `visibleSkills` | absent | Optional unique array of skill names. Presence enables routing and applies prompt filtering; see below. |
| `threshold` | `0.65` | Finite number from 0 to 1, inclusive. |
| `topK` | `3` | Integer from 1 to 100; maximum Jev matches supplied. |
| `maxContextChars` | `5000` | Integer from 1 to 100,000; total interpretation context limit. |
| `interpreterTimeoutMs` | `15000` | Integer from 1 to 120,000. |
| `jevTimeoutMs` | `15000` | Integer from 1 to 120,000. |
| `jevModel` | `"jev-latest"` | Non-empty Jev model ID. |
| `debug` | `false` | Boolean; enables compact sanitized route diagnostics in the UI. |
| `jevChunkSize` | `50` | Integer from 1 to 500; only used after a request-size rejection. |
| `maxSkillChars` | `50000` | Integer from 1 to 1,000,000; per-file loading limit. |
| `maxLoadedChars` | `120000` | Integer from 1 to 5,000,000; combined loading limit. |
| `jevPricing` | absent | Optional object with nonnegative finite `inputPerMillion` and `outputPerMillion`; enables estimated Jev cost only. |

`visibleSkills` has intentional presence semantics:

- **Absent:** preserve the complete native skill catalog and disable routing.
- **Present as `[]`:** advertise no normally advertisable skills and enable routing.
- **Present with names:** advertise only matching normally advertisable skills and route among the rest.
- **Unknown names:** emit a sanitized warning. Mixed lists retain valid names and ignore unknown ones. If a nonempty list has no valid names, preserve the full native catalog and skip automatic routing for that call; `/jev-skills status` reports this fallback. This is distinct from intentional `[]`.

Manual-only skills (`disable-model-invocation: true`) are never advertised by the router. They remain available through Pi's native `/skill:name` command and are eligible for `jev_skill_search`, but not automatic routing. Invalid configuration values are ignored; `/jev-skills status` shows the effective configuration and registry counts.

## How routing works

### Automatic route

```text
substantive user turn
  -> before_agent_start captures Pi's discovered skills and filters only prompt skill metadata
  -> Luna interprets bounded active-branch user context with low reasoning
  -> Jev classifies every eligible hidden skill (size-only chunk fallback if needed)
  -> extension reads selected SKILL.md files from canonical Pi registry paths
  -> selected instructions are injected before the main model's first response
```

The local file read is performed by the extension; there is no extra filesystem-tool/read round trip before the response. The normal main-model request still happens as usual. Empty/non-substantive requests, zero matches, and routing failures do not add skill instructions.

### On-demand route

```text
main model calls jev_skill_search(task)
  -> Jev classifies eligible skills directly (no Luna call)
  -> extension reads selected trusted SKILL.md files locally
  -> full selected instructions are returned in that tool result
  -> main model continues with the result
```

The tool accepts task text, not paths. The returned skill bodies remove the need for a separate file-read tool call; as with any tool call, Pi makes the normal subsequent model request. Native `/skill:name` commands are unchanged.

## Commands

- `/jev-skills status` — effective configuration, registry counts, interpreter/key availability, and last route status.
- `/jev-skills on` / `/jev-skills off` — enable or disable automatic routing for this session.
- `/jev-skills debug on` / `/jev-skills debug off` — toggle sanitized UI diagnostics for this session.
- `/jev-skills test <task>` — dry-run interpretation, classification, and loading without injection or supplied-state mutation.
- `/jev-skills stats` — per-route-kind usage, latency, candidate/evaluation, coverage, error, and cost metrics.
- `jev_skill_search` — on-demand hidden-skill search for the main model.

Pi preserves its native command collision behavior. If another extension already registers `jev-skills`, Pi may assign an invocation suffix such as `/jev-skills:1`; use the command name Pi lists in that session.

## Authentication and troubleshooting

- `/jev-skills status` reports whether the exact interpreter model is available and whether `TYPESAFE_API_KEY` is present; it never displays the key.
- If Luna is unavailable, verify Pi's configured model is exactly `openai-codex/gpt-6-luna` and authenticate the `openai-codex` provider through Pi. The router uses a side-call and does not call `pi.setModel()` or change thinking level.
- If Jev reports authentication failure, make sure the Pi process inherited `TYPESAFE_API_KEY`, then restart Pi after changing the environment.
- The smoke test is credential-gated: `npm run smoke`. It contacts the real Luna and Jev adapters only when the TypeSafe key is set and prints model IDs, selected synthetic skill names, token counts, and latency—not prompts, API keys, or skill bodies.
- Jev full-scan is attempted first. Only an explicit request-size error triggers configured chunking; authentication, cancellation, timeouts, and generic provider failures are not treated as size errors.

## Privacy, trust, and failure behavior

- Luna receives the bounded current request and up to the configured number of earlier textual user messages from the active branch, plus the project basename and supplied skill names when relevant. Context is capped by `maxContextChars`; assistant messages, tool output, diffs, full compaction text, credentials, and full project paths are not included.
- Jev receives the interpreted task plus eligible skill names and descriptions. Skill bodies are read locally only after selection and then supplied to the main model.
- Pi's native discovered registry is the only path authority. The extension never accepts a path from tool input, never edits installed `SKILL.md` files, and applies bounded reads to canonical paths.
- User/project config follows Pi trust rules. An untrusted project's router configuration is ignored.
- Cancellation and configured timeouts stop nested requests where supported. Interpreter, Jev, or loader failures degrade without blocking ordinary Pi work; they do not cause arbitrary file reads. Active-branch context is authoritative, so compaction that removes supplied instructions can make a skill eligible again.
- Debug/status output is compact and avoids request text, credentials, and skill bodies. Treat the external Luna and Jev services as receiving the user context and skill descriptions above; do not route sensitive text unless that is acceptable for your providers.

## Metrics and limitations

`/jev-skills stats` breaks down automatic, on-demand, and dry-run routes separately, including provider usage, latency, candidate/evaluation counts, complete/partial/none coverage, no-match and loader counts, and error categories. Provider-returned usage is labeled **measured**. Interpreter provider-reported cost is measured. Jev cost is omitted unless explicit `jevPricing` is configured; that cost is labeled **estimated**. Missing usage is not invented, and the main model's own usage remains Pi's accounting.

Do not claim token or cost savings without a controlled comparison against an all-skills-visible baseline using identical tasks and accounting for the main model, Luna, Jev, and any additional main-model tool turns.

Known limitations:

- Each substantive automatic route adds Luna interpretation and at least one Jev request.
- Jev currently has lower documented accuracy for CJK than English; Luna normalization can help but does not guarantee cross-language selection.
- `threshold` and `topK` are tuning values, not accuracy guarantees. No match is valid.
- A later extension hook may change the prompt skill section after this extension; this package cannot test arbitrary third-party hook ordering.
- Compaction can remove routed instructions, causing deliberate re-supply on a later relevant request.
- On-demand search avoids an extra file-read tool round trip, not the normal model turn after the search tool.

## Attribution

This project independently adapts MIT-licensed concepts from TheoOliveira's [`pi-jev`](https://github.com/TheoOliveira/pi-jev). It replaces `pi-jev`'s lexical 12-skill shortlist and older response parsing with full-scan classification using TypeSafe SDK 0.6 behavior. No source was copied wholesale.

## Development verification

```sh
npm install
npm test
npm run typecheck
npm run smoke
```

`npm test` runs the deterministic unit and integration suite; `npm run smoke` separately runs the credential-gated live test (skipped without `TYPESAFE_API_KEY`). The live test requires the exact Luna model in the installed Pi model registry and fails clearly if it is unavailable. No Pi settings need to be changed to build or test the package.
