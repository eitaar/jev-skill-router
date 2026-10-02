# Pi v1.0 native API audit

## Scope agreed during interview

- Target Pi >=1.0; audit the whole extension, not just one call.
- Delegate Jev authentication to Pi; retain TypeSafe as the only classifier provider.
- Reject a classification request's answers when native validation fails; disable automatic retries (`maxRetries: 0`).
- Implementation approved after the interview; migration is on `feat/pi-v1-native-api`.

## Primary sources

Installed Pi root: `C:/Users/eitab/AppData/Roaming/npm/node_modules/@earendil-works/pi-coding-agent` (package.json: version 1.0.0, Node >=22.19.0).

- `docs/models.md`, “Use classifier models”: TypeSafe Jev is built in; extensions use `ctx.modelRegistry.classify()` without codemode. Authentication supports Pi credentials and TYPESAFE_API_KEY.
- `dist/core/model-registry.d.ts`: `findOfType("classifier", provider, modelId)` and `classify(model, context, options): Promise<ClassifierResult>`. No `clarify()` declaration was found in installed Pi public declarations or docs.
- `examples/extensions/jev-router.ts`, `choosePlanningModel`: demonstrates TypeSafe lookup, classification, cancellation and stopReason handling.
- `docs/codemode.md`, “Classify”: typed bool questions have instructions and true/false criteria; bool answers expose probability. Results expose stopReason and usage.
- `node_modules/@earendil-works/pi-ai/dist/api/typesafe-system-one.js`: public bool maps to wire-level noul.
- `node_modules/@earendil-works/pi-ai/dist/api/system-one-shared.js`: requires every answer with its expected type; parsing failure returns an error with no answers. Usage is parsed before answers. Supports timeoutMs, signal, maxRetries (default 2). HTTP failures are flattened into errorMessage, with no public status field.
- `node_modules/@earendil-works/pi-ai/dist/utils/error-body.js`: HTTP status/body may be included in formatted errorMessage. Any matching against this text is a compatibility heuristic, not a typed status contract.
- `docs/extensions.md`: existing structured before_agent_start prompt filtering and modelRegistry.streamSimple are supported; nested model usage should be included in tool results.

## Pre-migration implementation and migration candidates

- `package.json`: Pi packages pinned to 0.87.1 for development; peer ranges are unrestricted. Update dependency floor and README requirements for v1.0.
- `src/jev.ts`: SDK-specific noul questions, untyped response parsing, TypeSafe exception classes, timeout options and size-only chunk fallback. Replace transport/questions/response parsing with native classification; retain deterministic threshold/topK sorting and coverage accounting.
- `extensions/index.ts`: creates TypeSafeClient, checks TYPESAFE_API_KEY directly and caches SDK client. Delegate auth/model lookup to Pi. Status must report Pi's usable authentication, not only environment-variable presence.
- `src/interpreter.ts`: already uses native streamSimple. JSON task interpretation and repair are router-specific, not superseded by the classifier API.
- `src/registry.ts` and `extensions/index.ts`: already use native Skill metadata, getCommands and systemPromptOptions.skills; no new discovery layer needed.
- `src/context.ts`, `src/state.ts`, `src/loader.ts`: bounded user-only context, active-context supplied-state reconstruction and trusted bounded skill reads are router policy/security, not redundant provider implementations.

## Agreed error-handling trade-off

Native results do not expose typed HTTP status/error categories. Preserve size-only chunk fallback through conservative recognition of formatted HTTP status and explicit size-error text, with tests and a documented compatibility ceiling. Do not split/retry generic errors. Avoid exposing raw provider errors in router diagnostics. Fine-grained error categories are best-effort rather than a typed native contract.

## Verification

Existing deterministic checks: `npm test`, `npm run typecheck`. `npm run smoke` uses live credentials and external provider requests; do not run implicitly during fact finding. Dependencies are now pinned to v1.0.0 for development; older peer versions are excluded. Deterministic compatibility tests exercise native TypeSafe transport with mocked HTTP, stored Pi credentials, bool/noul mapping, malformed replies, chunking and retry suppression.

### Live verification

With explicit user approval, `test/live-smoke.test.ts` was extended to exercise actual providers and actual Pi SDK agent sessions:

- Real TypeSafe preflight: acknowledgment rejected, actionable follow-up accepted.
- Real `openai-codex/gpt-6-luna`: interpretation succeeded with provider-returned usage.
- Real Jev full classification: selected the synthetic accessibility/frontend skills with measured tokens.
- Automatic route in an isolated Pi session: supplied `keyboard-accessibility` without a tool call or interpreter fallback; the main model's final response contained the fixture marker.
- On-demand route in a separate isolated Pi session: the real model issued `jev_skill_search` once and received the selected fixture's full instructions; its final response contained the fixture marker.
- Both sessions retained the chosen main model. Configuration and skills were temporary, sessions and credential updates in-memory, and builtin filesystem/shell tools absent.

An initial design/explanation prompt produced `no-skill-needed` in preflight, so no automatic supply occurred. Diagnostics confirmed successful main-model execution, one Jev preflight and no API/authentication error. The implementation was not changed to force this judgment; the positive-path test uses an explicit keyboard-focus bug-fix request. This observed false negative remains a limitation, not a transport failure.

These checks cover Pi SDK agent execution, not interactive TUI rendering or every provider/third-party extension combination. External availability and classifier decisions cannot be guaranteed.
