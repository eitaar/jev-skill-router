# Jev Skill Router Design

## Intent

Build a standalone TypeScript Pi package that reduces the skill descriptions continuously advertised to the main model while preserving Pi's native discovery, validation, precedence, trusted paths, and `/skill:name` commands. Hidden skills remain semantically searchable before a response and through an on-demand tool. The router must never change the main session model and must fail without preventing ordinary Pi work.

This design targets the installed Pi 0.87.0 API and TypeSafe SDK 0.6.0. Current local discovery reports 176 skills: 154 normally advertisable and 22 native manual-only skills. Counts are observations, never configuration constants.

## Success criteria

- An explicit visible list is the only subset advertised in Pi's ordinary skill catalog.
- Missing `visibleSkills` preserves the complete native catalog and disables routing.
- Native hidden skill commands continue to work.
- Automatic routing completes Luna interpretation, Jev classification, and skill loading before the main model's first response.
- On-demand routing returns full selected skill content in one tool call without invoking Luna.
- Jev evaluates every eligible skill without an ASCII or lexical prerequisite.
- Zero matches, provider failures, malformed data, cancellation, session changes, forks, and compaction are safe.
- Metrics distinguish measured provider usage from explicitly configured cost estimates.
- No token- or cost-saving claim is made without a controlled measurement.

## Domain language

Canonical terms are defined in [`CONTEXT.md`](../../../CONTEXT.md). In particular, “visible” means advertised metadata, “supplied” means full instructions still in the active model context, and “manual-only” preserves Pi's `disable-model-invocation` intent.

## Verified platform facts

- Pi 0.87.0 exposes `before_agent_start.event.systemPromptOptions.skills` as a mutable structured prompt input.
- Pi diffs structured prompt sections, allowing the `skills` section to change without replacing the complete system prompt.
- `pi.getCommands()` retains skill commands and canonical `sourceInfo.path` independently of prompt filtering.
- `ctx.sessionManager.buildContextEntries()` returns the active branch with compaction applied.
- `ctx.modelRegistry.streamSimple()` performs authenticated side-calls and accepts provider-neutral `reasoning` without changing `ctx.model`.
- The current authenticated interpreter is `openai-codex/gpt-6-luna`, used with `reasoning: "low"`.
- TypeSafe SDK 0.6.0 returns Noul probability at `answers[id].noul` and token usage at `usage.input_tokens` and `usage.output_tokens`.
- The existing `pi-jev` skill router uses an ASCII lexical shortlist and twelve candidates; that behavior is intentionally not reused.

## Architecture decision

Use a native hook router. Preserve the complete Pi registry, then filter only the skill list supplied to Pi's structured prompt builder. Inject automatically selected instructions as one bounded hidden custom message from `before_agent_start`. Register one on-demand tool that returns selected instructions in its tool result.

Rejected alternatives:

1. A replacement resource loader cannot be introduced safely by an ordinary already-loaded extension and risks losing native commands.
2. Rebuilding the complete system prompt is brittle, duplicates Pi internals, and creates avoidable cache misses.
3. Editing installed skill frontmatter breaks ownership, upgrades, and native semantics.

## Package layout

The repository lives at `C:\Users\eitab\Documents\js\jev-skill-router` and is a local-installable Pi package.

- `extensions/index.ts`: Pi lifecycle, command, and tool wiring only.
- `src/config.ts`: defaults, user/project config parsing, validation, and session overrides.
- `src/registry.ts`: canonical registry capture and eligibility rules.
- `src/context.ts`: deterministic bounded interpretation input.
- `src/interpreter.ts`: Luna resolution, side-call, output parsing, and fallback.
- `src/jev.ts`: TypeSafe client adapter, full-scan classification, validation, and chunk fallback.
- `src/loader.ts`: trusted-path reading and delimited instruction rendering.
- `src/state.ts`: active-branch supplied-skill reconstruction.
- `src/metrics.ts`: session metrics and safe rendering.
- `src/router.ts`: orchestration shared by automatic, on-demand, and dry-run paths.
- `test/`: unit and installed-Pi integration tests.
- `README.md`: setup, configuration, commands, traces, security, and troubleshooting.

These are responsibility boundaries, not a requirement to create empty scaffolding. Files may be combined when implementation proves a boundary trivial.

## Configuration

Configuration merges in this order:

1. Built-in defaults.
2. `~/.pi/agent/jev-skill-router.json`.
3. `<cwd>/.pi/jev-skill-router.json` when the project is trusted.
4. Session-only command overrides.

Project values override user values. Unknown keys, invalid ranges, unknown visible names, and unreadable configuration generate sanitized warnings and preserve safe behavior.

```json
{
  "enabled": true,
  "autoRouting": true,
  "interpreterModel": "openai-codex/gpt-6-luna",
  "interpreterThinking": "low",
  "recentUserMessages": 4,
  "visibleSkills": ["user-selected-core-skill"],
  "threshold": 0.65,
  "topK": 3,
  "maxContextChars": 5000,
  "interpreterTimeoutMs": 15000,
  "jevTimeoutMs": 15000,
  "jevModel": "jev-latest",
  "debug": false
}
```

Timeout values are initial implementation defaults and remain configurable. `visibleSkills` has special presence semantics:

- Missing: preserve every native skill advertisement and disable routing.
- Present but empty: advertise no normally advertisable skills and enable routing.
- Present with names: advertise the matching normally advertisable skills.

Manual-only skills are never advertised by the router.

## Registry and native compatibility

At each `before_agent_start`, capture the unfiltered `systemPromptOptions.skills` before mutating it. This is the authoritative discovered registry because it already reflects Pi discovery, precedence, trust, and deduplication. Augment or verify path provenance from `pi.getCommands()` entries whose `source === "skill"`; never infer paths from tool input or skill names.

The extension replaces `systemPromptOptions.skills` with the configured visible subset. It does not delete commands, files, or resource-loader entries. Therefore `/skill:name` expansion remains native for visible, hidden, and manual-only skills.

Registry refresh occurs naturally on every hook and after Pi reload. Commands and tools use the latest captured registry. Before a registry has been captured, status reports that routing is not ready rather than scanning the filesystem independently.

## Context collection

Build interpretation state deterministically from `buildContextEntries()`:

- Current raw user request first.
- Up to four earlier user messages from the active compacted branch, without duplicating the current request.
- Only textual user content; image blocks become a short presence marker.
- Project basename by default, never the full path unless future opt-in configuration is added.
- Names of supplied skills when useful.
- No assistant messages, tool output, diffs, credentials, or full compaction content in the initial version.

Apply `maxContextChars` across the complete payload. Preserve the current request before truncating older messages. Truncate at Unicode code-point boundaries and label truncation. A request that is empty after trimming is non-substantive and skips automatic routing.

## Interpreter

Resolve `interpreterModel` as an exact `provider/modelId` from `ctx.modelRegistry.getAvailable()`. Reject ambiguity, missing authentication, and unavailable models. Never call `pi.setModel()` or `pi.setThinkingLevel()`.

Call `ctx.modelRegistry.streamSimple()` with:

- A small fixed system instruction saying to describe the task, not name skills.
- The deterministic context payload.
- `reasoning: "low"`.
- A short output limit.
- A combined cancellation/timeout signal.

Expected output:

```json
{"task":"Improve the visual hierarchy and spacing of the React settings page currently being edited.","domain":"frontend-ui"}
```

Extract text blocks only, strip an optional Markdown fence, parse one JSON object, and require a non-empty bounded `task`; `domain` is optional. Retry malformed output at most once with a repair-only prompt. On unavailable model, timeout, cancellation, or final parse failure, use the already bounded deterministic context as Jev state and mark the route as interpreter fallback. This fallback does not invent skill names.

Interpreter usage comes from the final Pi assistant message. Tokens and provider-reported costs are measured values.

## Jev classification

Create one stable question key per eligible skill: `skill_0000`, `skill_0001`, and so on. Keep the key-to-registry mapping locally. Send the normalized task once as structured state. Each Noul question contains the canonical skill name and description and asks whether the skill supplies directly useful instructions—not merely related subject matter.

Attempt one request containing every eligible question. There is no lexical shortlist and no language-specific preprocessing. If and only if the TypeSafe API rejects request size, retry deterministic contiguous chunks. Begin with a conservative configured chunk size derived during implementation tests; cover each candidate exactly once. Do not chunk authentication, timeout, cancellation, or arbitrary server failures as though they were size errors.

Parse only `answers[key].noul`. Missing, nonnumeric, non-finite, or out-of-range values are invalid and excluded. Preserve valid answers from successful chunks if a later chunk fails, mark coverage partial, and never represent unevaluated skills as zero-confidence judgments.

Sort valid answers by descending probability and then canonical skill name. Select values at or above `threshold`, taking at most `topK`. Zero selection is valid.

Automatic eligibility is:

```text
discovered - visible - supplied - manual-only
```

On-demand eligibility is:

```text
discovered - visible - supplied
```

Thus native manual-only skills may be supplied only after the main model explicitly invokes `jev_skill_search`, matching the user's chosen policy.

## Skill loading and injection

Read files only from canonical registry paths. Tool arguments never contain paths. Before each read, confirm the requested name maps to the same current registry entry. Read UTF-8 with a bounded per-file and combined size limit. A missing, unreadable, or oversized file is skipped and reported by name.

Automatic routing returns one hidden custom message from `before_agent_start`, ensuring selected instructions reach the first main-model call. Content is delimited:

```text
<jev_routed_skills source="automatic">
<skill name="frontend-design" path="trusted registry path">
...verbatim SKILL.md...
</skill>
</jev_routed_skills>
```

XML attribute values are escaped. Skill body text remains verbatim inside an unambiguous fenced payload chosen by the loader so content cannot accidentally close the wrapper.

The `jev_skill_search` tool accepts only a non-empty concise `task` string. It calls Jev directly, loads matches, and returns the same delimited content plus compact score/status metadata in one tool result. It never invokes Luna. A recoverable routing failure returns a normal explanatory tool result rather than throwing unless the tool input itself violates the schema.

## Active-branch deduplication

Persist selected names in details attached to:

- Automatic custom messages.
- `jev_skill_search` tool results.

At session start, reload, fork, tree navigation, compaction completion, and immediately before each route, reconstruct supplied names from `buildContextEntries()`. Only entries still present in the active compacted context count. Consequences:

- A fork inherits supplied instructions only when their entries are on the forked branch.
- A new or unrelated session starts empty.
- A compaction that removes routed content makes that skill eligible again.
- A compaction retaining the routed entry preserves deduplication.
- Dry-run commands never persist or mark skills supplied.

No separate mutable session ledger is authoritative. The active branch is authoritative.

## Commands

Register one command family:

- `/jev-skills on|off`: session-only automatic-routing override.
- `/jev-skills status`: effective config, registry counts, interpreter/key availability, and last route status.
- `/jev-skills debug on|off`: session-only sanitized diagnostic output.
- `/jev-skills test <task>`: dry-run interpreter, classification, and loading without injection or state mutation.
- `/jev-skills stats`: session metrics split by route kind.

Command collision behavior remains Pi-native. If another extension owns the name, Pi adds numeric invocation suffixes; README troubleshooting explains this.

## Failure behavior

Automatic hook errors are caught at the extension boundary. Visible skills remain available and the main run continues.

- Interpreter failure: bounded raw context goes to Jev where possible.
- Jev unavailable, unauthenticated, timed out, cancelled, or malformed: supply no new skills.
- Partial size-chunk failure: use only validated successful answers and label partial coverage.
- Missing skill path: skip the affected skill.
- Empty on-demand task: clear recoverable result.
- User cancellation: stop nested work quickly and continue Pi without injection.

Nonfatal status uses `ctx.ui.setStatus` or compact notifications only when UI exists. Ordinary logs never include API keys, prompt bodies, conversation text, skill bodies, or sensitive tool output.

## Metrics and cost accounting

Session metrics record:

- Automatic, on-demand, and dry-run searches.
- Interpreter calls, input/output/cache/reasoning tokens where returned, provider-reported cost, and latency.
- Jev requests, `input_tokens`, `output_tokens`, latency, and chunk count.
- Candidate and evaluated counts, complete/partial coverage, selected names, no-match count, skipped routes, loader failures, and error category.

Measured values are labeled `measured`. Jev cost is omitted unless optional per-token pricing is explicitly configured; then it is labeled `estimated`. The extension does not estimate absent token counts. Main-model usage remains Pi's own accounting and is not relabeled as router usage.

Comparative savings require a separate benchmark using identical tasks under all-skills-visible and router configurations, including main model, interpreter, Jev, and any additional main-model tool rounds.

## Security and trust

- Honor Pi project trust before reading project config.
- Use Pi's registry as the only path authority.
- Never expose arbitrary file-read arguments through the tool.
- Keep TypeSafe credentials in `TYPESAFE_API_KEY` or SDK/provider configuration.
- Use the SDK's normal redaction and disable verbose body logging.
- Pass cancellation signals to Luna and Jev calls.
- Avoid full paths in remote interpretation state and ordinary metrics.

## Test strategy

Use Node's native test runner and dependency injection around model, TypeSafe, filesystem, clock, and Pi boundaries. Follow red-green-refactor for production behavior.

Required automated coverage:

1. 134 discovered and 10 visible yields 124 automatic Jev candidates.
2. Prompt sections advertise only configured visible skills.
3. Hidden `/skill:name` commands remain present and expandable through Pi.
4. Japanese input can select an English frontend skill without lexical filtering.
5. Automatic flow calls Luna with low reasoning, then Jev, then loader, without changing the main model.
6. On-demand flow never calls Luna and returns loaded content in one tool result.
7. Zero match injects nothing.
8. Visible and currently supplied skills are excluded.
9. Manual-only skills are excluded automatically and included on demand.
10. Invalid probabilities, partial chunks, missing files, missing auth, timeout, and cancellation are safe.
11. A full 134-question request is attempted first; size rejection chunks with no omitted or duplicated candidates.
12. Session replacement, branching, tree navigation, and compaction reconstruct supplied state from active context.
13. Usage and costs are labeled measured versus estimated correctly.
14. Installed Pi 0.87.0 integration tests prove structured skill-section filtering and native command preservation.

Run a live smoke test only when credentials are configured. It must record actual response shape and sanitized usage without printing input text or keys. A live pass demonstrates current environment compatibility, not guaranteed future accuracy.

## Delivery boundary

The package will include source, tests, configuration example, README, license attribution for any MIT-licensed `pi-jev` ideas adapted, and a Pi package manifest. It will not modify active Pi settings or install itself during implementation. Installation requires a separate explicit user approval after tests and review.

## Known limitations

- Routing adds one Luna request and at least one Jev request to substantive automatic turns.
- Jev's documentation reports lower current accuracy for CJK than English; Luna normalization mitigates but does not guarantee cross-language accuracy.
- `before_agent_start` handler ordering means a later extension may change prompt sections after this router; integration tests cover this extension's own mutation, not arbitrary third-party interference.
- Compaction may remove supplied instructions, causing deliberate re-supply on a later relevant route.
- A tool invocation necessarily creates a subsequent main-model turn; the extension removes the additional read round trip, not the tool round itself.
- Threshold and topK are tunable starting points, not guarantees.
