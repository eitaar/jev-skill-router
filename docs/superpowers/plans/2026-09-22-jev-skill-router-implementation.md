# Jev Skill Router Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Run implementation and review subagents with `openai-codex/gpt-6-luna:max`. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a Pi 0.87-compatible extension that advertises only configured visible skills and semantically supplies relevant hidden skills through Luna interpretation plus full-scan Jev classification.

**Architecture:** Preserve Pi's native skill registry and commands, mutate only `before_agent_start.systemPromptOptions.skills`, and inject selected trusted skill files before the main response. Pure modules own configuration, registry/context state, model/Jev adapters, loading, routing, and metrics; `extensions/index.ts` only binds those modules to Pi lifecycle APIs.

**Tech Stack:** TypeScript, Node.js 20+, Node native test runner, `tsx`, Pi 0.87 peer APIs, `typebox`, `@typesafe-ai/sdk` 0.6.x.

**Spec:** `docs/superpowers/specs/2026-09-22-jev-skill-router-design.md`

## Global Constraints

- Preserve native Pi discovery, precedence, trusted paths, validation, and `/skill:name` commands.
- Never edit installed `SKILL.md` files or accept model-supplied file paths.
- Never change the main Pi model or thinking level.
- Default interpreter is exact model `openai-codex/gpt-6-luna` with `low` reasoning.
- Missing `visibleSkills` preserves the complete native catalog and disables routing.
- Automatic eligibility excludes visible, supplied, and native manual-only skills.
- On-demand eligibility excludes visible and supplied skills but includes manual-only skills.
- Attempt one full Jev request before size-error chunk fallback; never use lexical prefiltering.
- Default threshold is `0.65`, default topK is `3`, and zero matches are valid.
- Provider or loader failures must not prevent normal Pi work.
- Label provider-returned usage and cost as measured; estimate cost only from explicit pricing.
- Do not install the package into active Pi settings without a separate user approval.

## File map

- `package.json`: package manifest, scripts, Pi entrypoint, runtime and peer dependencies.
- `tsconfig.json`: strict no-emit typechecking for extension, source, and tests.
- `src/types.ts`: shared domain and adapter contracts.
- `src/config.ts`: validated config merging and session overrides.
- `src/registry.ts`: canonical registry capture, visible filtering, and eligibility.
- `src/context.ts`: bounded active-branch user context collection.
- `src/state.ts`: supplied-skill reconstruction from active context entries.
- `src/interpreter.ts`: exact Luna resolution, low-reasoning side-call, JSON parsing, one repair retry, and fallback.
- `src/jev.ts`: TypeSafe adapter, stable questions, full scan, size-only chunk fallback, validation, and selection.
- `src/loader.ts`: canonical path loading, limits, and safe instruction delimiters.
- `src/metrics.ts`: session counters and measured/estimated rendering.
- `src/router.ts`: automatic, on-demand, and dry-run orchestration.
- `extensions/index.ts`: Pi hook, tool, command, lifecycle, and safe UI integration.
- `test/helpers.ts`: test factories and fake provider boundaries.
- `test/config.test.ts`: configuration semantics.
- `test/registry-context-state.test.ts`: candidate counts, context cap, manual-only rules, branch reconstruction.
- `test/interpreter.test.ts`: Luna model resolution, low reasoning, parsing, retry, and fallback.
- `test/jev.test.ts`: multilingual full scan, probability validation, ordering, chunk coverage, and usage.
- `test/loader-router.test.ts`: trusted loading, dedupe, zero match, partial failure, and same-call content.
- `test/extension.integration.test.ts`: installed Pi prompt filtering, command preservation, hook/tool flows, and model stability.
- `test/live-smoke.test.ts`: credential-gated real Luna/Jev smoke test.
- `jev-skill-router.example.json`: copyable safe configuration.
- `README.md`: setup, configuration, commands, traces, security, troubleshooting, and limitations.
- `LICENSE`: MIT license and attribution notice.

## Review Focus

- A present-but-empty `visibleSkills` array must differ from an absent property; `[]` enables routing with no advertised normal skills.
- Native manual-only skills must remain absent from automatic routing while remaining eligible for on-demand search.
- A TypeSafe 413/validation-size response may trigger chunks; authentication, timeout, cancellation, and generic 5xx responses must not.
- Compaction and branch changes must reconstruct supplied names from active context rather than stale mutable memory.
- Selected skill bodies containing XML-like closing tags must not escape their per-skill payload delimiter.

---

### Task 1: Package foundation and validated configuration

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `src/types.ts`
- Create: `src/config.ts`
- Create: `test/config.test.ts`

**Interfaces:**
- Produces: `RouterConfig`, `SessionOverrides`, `ConfigResult`, `DEFAULT_CONFIG`, and `loadConfig(options): Promise<ConfigResult>`.
- Consumes: Node filesystem and paths only; no Pi runtime objects.

- [ ] **Step 1: Write failing configuration tests**

```ts
// test/config.test.ts
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadConfig } from "../src/config.js";

test("missing visibleSkills preserves native catalog and disables routing", async () => {
  const root = await mkdtemp(join(tmpdir(), "jev-router-"));
  const result = await loadConfig({ homeDir: root, cwd: root, projectTrusted: true });
  assert.equal(result.routingConfigured, false);
  assert.equal(result.config.visibleSkills, undefined);
});

test("project config overrides user config and explicit empty visibleSkills enables routing", async () => {
  const root = await mkdtemp(join(tmpdir(), "jev-router-"));
  const homeDir = join(root, "home");
  const cwd = join(root, "project");
  await mkdir(join(homeDir, ".pi", "agent"), { recursive: true });
  await mkdir(join(cwd, ".pi"), { recursive: true });
  await writeFile(join(homeDir, ".pi", "agent", "jev-skill-router.json"), JSON.stringify({ topK: 2 }));
  await writeFile(join(cwd, ".pi", "jev-skill-router.json"), JSON.stringify({ topK: 1, visibleSkills: [] }));
  const result = await loadConfig({ homeDir, cwd, projectTrusted: true });
  assert.equal(result.routingConfigured, true);
  assert.deepEqual(result.config.visibleSkills, []);
  assert.equal(result.config.topK, 1);
});

test("untrusted projects do not load project config", async () => {
  const root = await mkdtemp(join(tmpdir(), "jev-router-"));
  await mkdir(join(root, ".pi"), { recursive: true });
  await writeFile(join(root, ".pi", "jev-skill-router.json"), JSON.stringify({ visibleSkills: [] }));
  const result = await loadConfig({ homeDir: join(root, "home"), cwd: root, projectTrusted: false });
  assert.equal(result.routingConfigured, false);
});
```

- [ ] **Step 2: Run the test and confirm the missing module failure**

Run: `npm test -- test/config.test.ts`

Expected: FAIL because `src/config.ts` does not exist.

- [ ] **Step 3: Add package metadata and strict compiler configuration**

```json
// package.json
{
  "name": "jev-skill-router",
  "version": "0.1.0",
  "type": "module",
  "private": true,
  "license": "MIT",
  "keywords": ["pi-package", "pi-extension", "jev", "skills"],
  "pi": { "extensions": ["./extensions/index.ts"] },
  "scripts": {
    "typecheck": "tsc --noEmit",
    "test": "node --test --import tsx",
    "test:unit": "node --test --import tsx test/*.test.ts",
    "smoke": "node --test --import tsx test/live-smoke.test.ts"
  },
  "dependencies": { "@typesafe-ai/sdk": "^0.6.0" },
  "peerDependencies": {
    "@earendil-works/pi-ai": "*",
    "@earendil-works/pi-coding-agent": "*",
    "typebox": "*"
  },
  "devDependencies": {
    "@earendil-works/pi-ai": "0.87.0",
    "@earendil-works/pi-coding-agent": "0.87.0",
    "@types/node": "^24.0.0",
    "tsx": "^4.20.0",
    "typebox": "^1.3.0",
    "typescript": "^5.9.0"
  }
}
```

```json
// tsconfig.json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "skipLibCheck": true,
    "types": ["node"]
  },
  "include": ["extensions/**/*.ts", "src/**/*.ts", "test/**/*.ts"]
}
```

Run: `npm install`

Expected: dependencies install and `package-lock.json` is created.

- [ ] **Step 4: Implement the minimum config contracts and loader**

```ts
// src/types.ts
export interface RouterConfig {
  enabled: boolean;
  autoRouting: boolean;
  interpreterModel: string;
  interpreterThinking: "low";
  recentUserMessages: number;
  visibleSkills?: string[];
  threshold: number;
  topK: number;
  maxContextChars: number;
  interpreterTimeoutMs: number;
  jevTimeoutMs: number;
  jevModel: string;
  debug: boolean;
  jevChunkSize: number;
  maxSkillChars: number;
  maxLoadedChars: number;
  jevPricing?: { inputPerMillion: number; outputPerMillion: number };
}

export interface SessionOverrides {
  enabled?: boolean;
  autoRouting?: boolean;
  debug?: boolean;
}

export interface ConfigResult {
  config: RouterConfig;
  routingConfigured: boolean;
  warnings: string[];
}
```

```ts
// src/config.ts — required public shape
export const DEFAULT_CONFIG = {
  enabled: true,
  autoRouting: true,
  interpreterModel: "openai-codex/gpt-6-luna",
  interpreterThinking: "low",
  recentUserMessages: 4,
  threshold: 0.65,
  topK: 3,
  maxContextChars: 5000,
  interpreterTimeoutMs: 15000,
  jevTimeoutMs: 15000,
  jevModel: "jev-latest",
  debug: false,
  jevChunkSize: 50,
  maxSkillChars: 50000,
  maxLoadedChars: 120000
} as const;

export async function loadConfig(options: {
  homeDir: string;
  cwd: string;
  projectTrusted: boolean;
  overrides?: SessionOverrides;
}): Promise<ConfigResult>;
```

Validate objects explicitly: booleans must be booleans; counts and timeouts must be bounded positive integers; threshold must be within `[0, 1]`; `visibleSkills` must be a unique string array; pricing must be nonnegative finite numbers. Ignore invalid values with a warning naming only the key and source file. Use property presence, not truthiness, to distinguish absent `visibleSkills` from `[]`.

- [ ] **Step 5: Run config tests and typecheck**

Run: `npm test -- test/config.test.ts && npm run typecheck`

Expected: PASS with zero test failures and zero TypeScript errors.

- [ ] **Step 6: Commit the package foundation**

```bash
git add package.json package-lock.json tsconfig.json src/types.ts src/config.ts test/config.test.ts
git commit -m "feat: add validated router configuration"
```

---

### Task 2: Canonical registry, bounded context, and active-branch state

**Files:**
- Create: `src/registry.ts`
- Create: `src/context.ts`
- Create: `src/state.ts`
- Create: `test/helpers.ts`
- Create: `test/registry-context-state.test.ts`

**Interfaces:**
- Consumes: Pi `Skill` values, skill command metadata, and `SessionManager.buildContextEntries()` output.
- Produces: `captureRegistry(skills, commands): Map<string, SkillRecord>`, `filterVisible(registry, names): SkillRecord[]`, `eligibleSkills(registry, visible, supplied, mode): SkillRecord[]`, `collectInterpretationContext(input): string`, and `reconstructSuppliedSkills(entries): Set<string>`.

- [ ] **Step 1: Write failing registry, multilingual-context, and state tests**

```ts
// test/registry-context-state.test.ts
import assert from "node:assert/strict";
import test from "node:test";
import { captureRegistry, eligibleSkills, filterVisible } from "../src/registry.js";
import { collectInterpretationContext } from "../src/context.js";
import { reconstructSuppliedSkills } from "../src/state.js";
import { makeSkills } from "./helpers.js";

test("134 discovered and 10 visible yields 124 automatic candidates", () => {
  const registry = captureRegistry(makeSkills(134), []);
  const visible = new Set([...registry.keys()].slice(0, 10));
  assert.equal(eligibleSkills(registry, visible, new Set(), "automatic").length, 124);
  assert.equal(filterVisible(registry, [...visible]).length, 10);
});

test("manual-only skills are on-demand-only", () => {
  const registry = captureRegistry(makeSkills(2, { manualOnly: [1] }), []);
  assert.deepEqual(eligibleSkills(registry, new Set(), new Set(), "automatic").map(s => s.name), ["skill-000"]);
  assert.equal(eligibleSkills(registry, new Set(), new Set(), "on-demand").length, 2);
});

test("context keeps Japanese current request and caps older user text", () => {
  const entries = [
    { type: "message", message: { role: "user", content: "older context", timestamp: 1 } },
    { type: "message", message: { role: "assistant", content: [], timestamp: 2 } }
  ] as never[];
  const text = collectInterpretationContext({ current: "このReact画面をもっと綺麗にして", entries, projectName: "app", supplied: [], maxChars: 80, recentUserMessages: 4 });
  assert.match(text, /このReact画面/);
  assert.ok([...text].length <= 80);
});

test("supplied skills are reconstructed only from active context entries", () => {
  const entries = [{ type: "custom_message", customType: "jev-skill-router", details: { suppliedSkills: ["frontend-design"] } }] as never[];
  assert.deepEqual([...reconstructSuppliedSkills(entries)], ["frontend-design"]);
});
```

- [ ] **Step 2: Run tests and confirm missing-module failures**

Run: `npm test -- test/registry-context-state.test.ts`

Expected: FAIL because registry/context/state modules do not exist.

- [ ] **Step 3: Implement canonical registry and eligibility**

```ts
// src/registry.ts — required domain type
export interface SkillRecord {
  name: string;
  description: string;
  filePath: string;
  baseDir: string;
  disableModelInvocation: boolean;
  sourceInfo: { path: string; source: string; scope: string; origin: string; baseDir?: string };
}

export function captureRegistry(skills: readonly Skill[], commands: readonly CommandInfo[]): Map<string, SkillRecord>;
export function filterVisible(registry: ReadonlyMap<string, SkillRecord>, names: readonly string[]): SkillRecord[];
export function eligibleSkills(
  registry: ReadonlyMap<string, SkillRecord>,
  visible: ReadonlySet<string>,
  supplied: ReadonlySet<string>,
  mode: "automatic" | "on-demand"
): SkillRecord[];
```

Preserve Pi's skill-array order and identity. Use a matching `source === "skill"` command only to verify or fill its canonical path. Never add a command-only record that lacks native skill metadata. Sort eligible output by skill name so Jev keys and chunks are deterministic.

- [ ] **Step 4: Implement bounded user-only context and supplied-state reconstruction**

Use `Array.from(text)` for Unicode-safe truncation. Serialize current request first, then project basename, supplied names, then newest prior user messages until the cap. Read textual blocks only and use `[image attached]` for image blocks. Recognize both automatic `custom_message.details.suppliedSkills` and `toolResult.details.suppliedSkills` from `jev_skill_search`.

- [ ] **Step 5: Run tests and typecheck**

Run: `npm test -- test/registry-context-state.test.ts && npm run typecheck`

Expected: PASS.

- [ ] **Step 6: Commit registry and context behavior**

```bash
git add src/registry.ts src/context.ts src/state.ts test/helpers.ts test/registry-context-state.test.ts
git commit -m "feat: derive skill candidates from active Pi context"
```

---

### Task 3: Luna interpreter side-call

**Files:**
- Create: `src/interpreter.ts`
- Create: `test/interpreter.test.ts`

**Interfaces:**
- Consumes: a small `InterpreterRegistry` adapter exposing available models and `streamSimple`.
- Produces: `interpretTask(input): Promise<InterpretationResult>` with measured Pi usage and fallback status.

- [ ] **Step 1: Write failing Luna behavior tests**

```ts
// test/interpreter.test.ts
import assert from "node:assert/strict";
import test from "node:test";
import { interpretTask } from "../src/interpreter.js";
import { fakeAssistant, fakeInterpreterRegistry } from "./helpers.js";

test("uses exact Luna model at low reasoning without changing the main model", async () => {
  const registry = fakeInterpreterRegistry([fakeAssistant('{"task":"Polish the React screen","domain":"frontend-ui"}')]);
  const activeModel = { provider: "openai-codex", id: "gpt-6-sol" };
  const result = await interpretTask({ registry, modelRef: "openai-codex/gpt-6-luna", context: "このReact画面をもっと綺麗にして", timeoutMs: 1000 });
  assert.equal(result.task, "Polish the React screen");
  assert.equal(registry.calls[0]?.options.reasoning, "low");
  assert.deepEqual(activeModel, { provider: "openai-codex", id: "gpt-6-sol" });
});

test("retries malformed JSON once then succeeds", async () => {
  const registry = fakeInterpreterRegistry([fakeAssistant("not json"), fakeAssistant('{"task":"Fix keyboard accessibility"}')]);
  const result = await interpretTask({ registry, modelRef: "openai-codex/gpt-6-luna", context: "fix it", timeoutMs: 1000 });
  assert.equal(registry.calls.length, 2);
  assert.equal(result.fallbackUsed, false);
});

test("falls back to bounded raw context after final malformed response", async () => {
  const registry = fakeInterpreterRegistry([fakeAssistant("bad"), fakeAssistant("bad again")]);
  const result = await interpretTask({ registry, modelRef: "openai-codex/gpt-6-luna", context: "raw bounded task", timeoutMs: 1000 });
  assert.equal(result.task, "raw bounded task");
  assert.equal(result.fallbackUsed, true);
});
```

- [ ] **Step 2: Run the test and confirm the missing-module failure**

Run: `npm test -- test/interpreter.test.ts`

Expected: FAIL because `src/interpreter.ts` does not exist.

- [ ] **Step 3: Implement exact model resolution and side-call parsing**

```ts
// src/interpreter.ts — required result
export interface InterpretationResult {
  task: string;
  domain?: string;
  fallbackUsed: boolean;
  attempts: number;
  latencyMs: number;
  usage?: MeasuredPiUsage;
  errorCategory?: "model-unavailable" | "timeout" | "cancelled" | "malformed" | "provider";
}
```

Split `provider/modelId` at the first slash, require an exact available match, and reject missing auth through registry availability. Build an `AbortController` combined with the caller signal and timeout. Call `stream.result()` rather than assembling deltas. Reject terminal `error` or `aborted` messages. Concatenate text blocks only, parse an optional single JSON fence, require `task.trim()` and cap returned task length. The second request contains only the invalid output and a repair instruction; it must not add the skill catalog.

- [ ] **Step 4: Prove usage is measured from the provider result**

Add a test whose fake assistant includes input/output/cache/reasoning tokens and nonzero provider cost. Assert the result copies these fields unchanged and labels them measured in the metrics adapter later.

- [ ] **Step 5: Run interpreter tests and typecheck**

Run: `npm test -- test/interpreter.test.ts && npm run typecheck`

Expected: PASS.

- [ ] **Step 6: Commit the interpreter**

```bash
git add src/interpreter.ts test/interpreter.test.ts test/helpers.ts
git commit -m "feat: interpret routing tasks with Luna low"
```

---

### Task 4: Full-scan Jev classifier with size-only chunk fallback

**Files:**
- Create: `src/jev.ts`
- Create: `test/jev.test.ts`

**Interfaces:**
- Consumes: `SkillRecord[]`, normalized task, TypeSafe client adapter, threshold, topK, model, timeout, and cancellation signal.
- Produces: `classifySkills(input): Promise<ClassificationResult>` containing scores, selection, coverage, exact token usage, and sanitized error category.

- [ ] **Step 1: Write failing full-scan, multilingual, validation, and chunk tests**

```ts
// test/jev.test.ts
import assert from "node:assert/strict";
import test from "node:test";
import { classifySkills } from "../src/jev.js";
import { fakeJev, makeSkillRecords } from "./helpers.js";

test("sends every candidate for Japanese intent without lexical filtering", async () => {
  const skills = makeSkillRecords(["database", "frontend-design", "rust-testing"]);
  const jev = fakeJev(({ questions }) => ({
    answers: Object.fromEntries(Object.keys(questions).map((key, index) => [key, { type: "noul", noul: index === 1 ? 0.9 : 0.1 }])),
    model: "jev-latest",
    usage: { input_tokens: 30, output_tokens: 3 }
  }));
  const result = await classifySkills({ client: jev, task: "このReact画面をもっと綺麗にして", skills, threshold: 0.65, topK: 3, model: "jev-latest", timeoutMs: 1000, chunkSize: 2 });
  assert.equal(Object.keys(jev.requests[0]!.questions).length, 3);
  assert.deepEqual(result.selected.map(x => x.skill.name), ["frontend-design"]);
});

test("rejects malformed and out-of-range probabilities", async () => {
  const skills = makeSkillRecords(["a", "b", "c"]);
  const jev = fakeJev(() => ({ answers: { skill_0000: { noul: 2 }, skill_0001: { noul: "0.9" }, skill_0002: { noul: 0.8 } }, model: "jev-latest", usage: { input_tokens: 1, output_tokens: 1 } }));
  const result = await classifySkills({ client: jev, task: "task", skills, threshold: 0.65, topK: 3, model: "jev-latest", timeoutMs: 1000, chunkSize: 2 });
  assert.deepEqual(result.selected.map(x => x.skill.name), ["c"]);
  assert.equal(result.invalidAnswers, 2);
});

test("size rejection chunks deterministically without omissions", async () => {
  const skills = makeSkillRecords(Array.from({ length: 134 }, (_, i) => `skill-${i}`));
  const jev = fakeJev(({ questions }, call) => {
    if (call === 0) throw Object.assign(new Error("too large"), { status: 413 });
    return { answers: Object.fromEntries(Object.keys(questions).map(key => [key, { noul: 0.1 }])), model: "jev-latest", usage: { input_tokens: 1, output_tokens: 1 } };
  });
  const result = await classifySkills({ client: jev, task: "task", skills, threshold: 0.65, topK: 3, model: "jev-latest", timeoutMs: 1000, chunkSize: 50 });
  assert.equal(jev.requests[0] && Object.keys(jev.requests[0].questions).length, 134);
  assert.deepEqual(jev.requests.slice(1).map(r => Object.keys(r.questions).length), [50, 50, 34]);
  assert.equal(result.evaluatedCount, 134);
  assert.equal(result.coverage, "complete");
});
```

- [ ] **Step 2: Run the test and confirm the missing-module failure**

Run: `npm test -- test/jev.test.ts`

Expected: FAIL because `src/jev.ts` does not exist.

- [ ] **Step 3: Implement the TypeSafe adapter and stable questions**

Use `TypeSafeClient` and `noul` from `@typesafe-ai/sdk`. Define a small injectable `JevClientLike` contract so tests do not use network. Put only `{ task }` in state. Question instructions contain name, description, and the direct-usefulness criterion. Keep one key map across full and chunk requests so scores merge correctly.

- [ ] **Step 4: Implement size-only fallback, strict parsing, and deterministic selection**

Treat HTTP 413 and explicit TypeSafe request-validation messages identifying question/request size as size errors. Do not chunk `AuthenticationError`, `PermissionDeniedError`, `RateLimitError`, `APITimeoutError`, `APIUserAbortError`, or generic 5xx errors. Sum exact `input_tokens` and `output_tokens` from completed requests. On a failed later chunk, preserve earlier valid answers and set `coverage: "partial"` with `evaluatedCount` less than candidate count.

- [ ] **Step 5: Add tie, zero-match, partial-chunk, timeout, and cancellation tests**

Assert equal probabilities sort by canonical skill name, `topK` truncates after threshold, all-below-threshold returns `[]`, partial chunks never assign scores to omitted candidates, and abort errors remain cancellation rather than size fallback.

- [ ] **Step 6: Run Jev tests and typecheck**

Run: `npm test -- test/jev.test.ts && npm run typecheck`

Expected: PASS.

- [ ] **Step 7: Commit the classifier**

```bash
git add src/jev.ts test/jev.test.ts test/helpers.ts
git commit -m "feat: classify every hidden skill with Jev"
```

---

### Task 5: Trusted loader, routing orchestration, and metrics

**Files:**
- Create: `src/loader.ts`
- Create: `src/metrics.ts`
- Create: `src/router.ts`
- Create: `test/loader-router.test.ts`

**Interfaces:**
- Consumes: registry, config, supplied set, interpreter, classifier, filesystem adapter, and route kind.
- Produces: `routeAutomatic`, `routeOnDemand`, `routeDryRun`, delimited content, selected names, details for branch reconstruction, and session metrics.

- [ ] **Step 1: Write failing loader and router tests**

```ts
// test/loader-router.test.ts
import assert from "node:assert/strict";
import test from "node:test";
import { loadSkills } from "../src/loader.js";
import { createRouter } from "../src/router.js";
import { makeAutomaticRouteInput, makeOnDemandRouteInput, makeSkillRecords } from "./helpers.js";

test("loader reads only the current canonical registry path and safely fences body text", async () => {
  const [skill] = makeSkillRecords(["frontend-design"]);
  const result = await loadSkills({
    selected: [{ skill: skill!, probability: 0.9 }],
    registry: new Map([[skill!.name, skill!]]),
    readFile: async path => path === skill!.filePath ? "instructions\n</skill>" : "wrong",
    maxSkillChars: 50000,
    maxLoadedChars: 120000,
    source: "automatic"
  });
  assert.deepEqual(result.suppliedSkills, ["frontend-design"]);
  assert.match(result.content, /<jev_routed_skills source="automatic">/);
  assert.ok(!result.content.includes("\n</skill>\n</skill>"));
});

test("automatic zero match injects no message", async () => {
  const router = createRouter({ classifier: async () => ({ selected: [], scores: [], coverage: "complete", candidateCount: 1, evaluatedCount: 1, invalidAnswers: 0, usage: { inputTokens: 1, outputTokens: 1 }, requests: 1, latencyMs: 1 }), interpreter: async () => ({ task: "task", fallbackUsed: false, attempts: 1, latencyMs: 1 }), readFile: async () => "body" });
  const result = await router.routeAutomatic(makeAutomaticRouteInput({
    registry: makeSkillRecords(["frontend-design"]),
    currentPrompt: "Polish this React screen"
  }));
  assert.equal(result.message, undefined);
  assert.deepEqual(result.details.suppliedSkills, []);
});

test("on-demand returns skill content without invoking interpreter", async () => {
  let interpreterCalls = 0;
  const router = createRouter({ classifier: async input => ({ selected: [{ skill: input.skills[0]!, probability: 0.9 }], scores: [], coverage: "complete", candidateCount: 1, evaluatedCount: 1, invalidAnswers: 0, usage: { inputTokens: 1, outputTokens: 1 }, requests: 1, latencyMs: 1 }), interpreter: async () => { interpreterCalls++; throw new Error("must not run"); }, readFile: async () => "# Skill body" });
  const result = await router.routeOnDemand(makeOnDemandRouteInput({
    task: "Improve keyboard accessibility",
    registry: makeSkillRecords(["fixing-accessibility"])
  }));
  assert.equal(interpreterCalls, 0);
  assert.match(result.content, /# Skill body/);
});
```

Implement `makeAutomaticRouteInput` and `makeOnDemandRouteInput` in `test/helpers.ts` as fully typed factories using default config, empty supplied/visible sets, and an inert signal. The tests must compile and exercise public APIs rather than `any` casts.

- [ ] **Step 2: Run the test and confirm missing-module failures**

Run: `npm test -- test/loader-router.test.ts`

Expected: FAIL because loader/router modules do not exist.

- [ ] **Step 3: Implement canonical loading and delimiter selection**

Re-resolve each selected name from the current registry and require exact path equality with the classified record. Read UTF-8 only. Reject files over `maxSkillChars` and stop before `maxLoadedChars`. Generate a deterministic fence token by hashing the skill name and body with Node `createHash("sha256")`; if the token occurs in the body, append an incrementing suffix until absent. Escape wrapper attributes and place the verbatim body between fence lines.

- [ ] **Step 4: Implement route orchestration and branch details**

```ts
export interface RouteDetails {
  routeKind: "automatic" | "on-demand" | "dry-run";
  suppliedSkills: string[];
  selected: Array<{ name: string; probability: number }>;
  candidateCount: number;
  evaluatedCount: number;
  coverage: "complete" | "partial" | "none";
  interpreterFallback: boolean;
  latencyMs: number;
  errorCategory?: string;
}
```

Automatic routing interprets context then classifies automatic-eligible skills. On-demand passes its task directly and classifies on-demand-eligible skills. Dry-run follows automatic behavior but never mutates supplied state. Catch provider and loader errors into sanitized results. Never force a fallback selection.

- [ ] **Step 5: Implement metrics with measured/estimated labels**

Store only counts, token values, latency, selected names, and error categories. Provide `recordRoute`, `reset`, `snapshot`, and `formatStats`. Copy Pi provider costs as `{ value, basis: "measured" }`. Compute Jev cost only when pricing exists and label `{ basis: "estimated" }`.

- [ ] **Step 6: Add missing-file, oversized-file, dedupe, partial coverage, and pricing tests**

Assert one bad selected file does not prevent another valid file loading; visible and supplied names never reach classifier input; partial classification loads only validated selected skills; unconfigured Jev pricing omits cost; configured pricing uses exact measured tokens.

- [ ] **Step 7: Run loader/router tests and full unit suite**

Run: `npm test -- test/loader-router.test.ts && npm run test:unit && npm run typecheck`

Expected: PASS.

- [ ] **Step 8: Commit loader, router, and metrics**

```bash
git add src/loader.ts src/router.ts src/metrics.ts test/loader-router.test.ts test/helpers.ts
git commit -m "feat: load and route trusted skill instructions"
```

---

### Task 6: Pi hook, on-demand tool, commands, and lifecycle integration

**Files:**
- Create: `extensions/index.ts`
- Create: `test/extension.integration.test.ts`

**Interfaces:**
- Consumes: Pi `ExtensionAPI`, `before_agent_start`, session events, `pi.getCommands()`, `ctx.modelRegistry`, `ctx.sessionManager`, `ctx.isProjectTrusted()`, and UI helpers.
- Produces: filtered structured prompt, hidden automatic message, `jev_skill_search`, and `/jev-skills` command family.

- [ ] **Step 1: Write a failing installed-Pi integration harness**

Use Pi's `DefaultResourceLoader`, `SessionManager.inMemory()`, and a faux provider from the installed 0.87 packages. Load fixture skills through a temporary resource directory and bind the extension. The first test must assert:

```ts
assert.equal(promptSkillNames.length, 10);
assert.equal(jevQuestionCount, 124);
assert.ok(piCommands.some(command => command.name === "skill:hidden-010" && command.source === "skill"));
assert.deepEqual(session.model, mainModelBeforeRoute);
```

A second test invokes `jev_skill_search({ task: "Improve keyboard accessibility of this React dashboard" })`, asserts zero interpreter calls, and asserts the tool result contains the matched SKILL.md body.

- [ ] **Step 2: Run the integration test and confirm the missing extension failure**

Run: `npm test -- test/extension.integration.test.ts`

Expected: FAIL because `extensions/index.ts` does not exist.

- [ ] **Step 3: Register the on-demand tool**

```ts
pi.registerTool({
  name: "jev_skill_search",
  label: "Jev Skill Search",
  description: "Search hidden Pi skills for a concise task intent and return relevant trusted SKILL.md instructions in this tool result. No match is valid.",
  promptSnippet: "Search hidden Pi skills when the current instructions are insufficient",
  promptGuidelines: ["Use jev_skill_search with a concise task intent when a useful hidden skill may exist; it returns selected instructions directly."],
  parameters: Type.Object({ task: Type.String({ minLength: 1, maxLength: 1000 }) }),
  async execute(_id, params, signal, _update, ctx) {
    const task = params.task.trim();
    if (!task) {
      return {
        content: [{ type: "text", text: "No task supplied; continue without additional skills or invoke a native /skill:name command." }],
        details: { errorCategory: "empty-task", suppliedSkills: [] }
      };
    }
    const result = await extensionState.routeOnDemand(task, signal, ctx);
    return {
      content: [{ type: "text", text: result.content || "No relevant hidden skill matched." }],
      details: result.details
    };
  }
});
```

Return Luna usage only where Luna ran; on-demand usage contains Jev metrics in details because Jev usage is not Pi `Usage`. An empty trimmed task returns a recoverable textual result with `details.errorCategory = "empty-task"`.

- [ ] **Step 4: Implement `before_agent_start` filtering and same-turn injection**

Capture the complete registry before replacing `event.systemPromptOptions.skills`. Load effective config using project trust. If `visibleSkills` is absent, leave skills untouched and return. Otherwise assign only visible native skill objects, reconstruct supplied state from `buildContextEntries()`, and route only substantive prompts. Return one hidden custom message with `customType: "jev-skill-router"`, `display: false`, selected content, and `details: RouteDetails`. Catch every error at this boundary and return no message.

- [ ] **Step 5: Implement session lifecycle and command family**

Keep session overrides and metrics in extension-instance memory, resetting naturally when Pi reloads the extension for new/resumed/forked sessions. On `session_compact` and `session_tree`, do not mutate a ledger; later calls reconstruct state from active entries. Implement exact argument parsing for:

```text
/jev-skills on
/jev-skills off
/jev-skills status
/jev-skills debug on
/jev-skills debug off
/jev-skills test <task>
/jev-skills stats
```

Use `ctx.ui.notify` only when `ctx.hasUI`; commands in print/JSON mode must still complete without UI. `/jev-skills test` calls dry-run routing and displays interpreted task, candidate/evaluated count, scores, selected names, coverage/error, and latency without appending supplied-state entries.

- [ ] **Step 6: Add failure and lifecycle integration cases**

Cover missing Luna, missing TypeSafe key, malformed Jev response, timeout, cancellation, session replacement, forked active branch, compaction that removes injection, and compaction that retains injection. Confirm prompt filtering still occurs when routing fails and native command metadata remains unchanged.

- [ ] **Step 7: Run integration tests, complete suite, and typecheck**

Run: `npm test -- test/extension.integration.test.ts && npm test && npm run typecheck`

Expected: PASS with zero failures and zero TypeScript errors.

- [ ] **Step 8: Commit Pi integration**

```bash
git add extensions/index.ts test/extension.integration.test.ts
git commit -m "feat: integrate skill routing with Pi lifecycle"
```

---

### Task 7: Documentation, attribution, and credential-gated live smoke test

**Files:**
- Create: `README.md`
- Create: `jev-skill-router.example.json`
- Create: `LICENSE`
- Create: `test/live-smoke.test.ts`
- Modify: `package.json`

**Interfaces:**
- Consumes: configured Pi model registry and `TYPESAFE_API_KEY` only when present.
- Produces: user-facing setup and a skipped-or-live smoke test with sanitized output.

- [ ] **Step 1: Write the credential-gated smoke test first**

```ts
// test/live-smoke.test.ts
import assert from "node:assert/strict";
import test from "node:test";

test("live Luna and Jev adapters return their documented shapes", { skip: !process.env.TYPESAFE_API_KEY }, async () => {
  const result = await runLiveSmoke();
  assert.ok(result.interpretedTask.length > 0);
  assert.ok(Number.isInteger(result.jevUsage.inputTokens));
  assert.ok(Number.isInteger(result.jevUsage.outputTokens));
  assert.equal(result.mainModelChanged, false);
});
```

Keep `runLiveSmoke` in the test file or a test-only helper. It must use two synthetic skills and a harmless task, print only model IDs, selected names, token counts, and latency, and never print prompts, keys, or skill bodies.

- [ ] **Step 2: Run the smoke test before helper implementation**

Run: `npm run smoke`

Expected: FAIL when credentials are present because `runLiveSmoke` is undefined; SKIP when absent. In this environment `TYPESAFE_API_KEY` is present, so observe the intended failure before implementation.

- [ ] **Step 3: Implement the live helper and run it once**

Resolve Luna through a real Pi `ModelRuntime`/registry without changing an agent session model. Call the production interpreter and Jev classifier adapters with bounded timeouts. If authentication exists but the provider rejects the request, report the exact sanitized error and keep the test failing; do not auto-retry beyond production policy.

Run: `npm run smoke`

Expected: PASS, or a recorded credential/provider failure that blocks completion and is reported accurately.

- [ ] **Step 4: Write configuration example and README**

The README must include:

- Pi 0.87 and Node 20 requirements.
- Local package installation command, clearly separated from implementation.
- `TYPESAFE_API_KEY` setup without a literal key.
- Complete configuration schema and missing-versus-empty `visibleSkills` semantics.
- Luna `openai-codex/gpt-6-luna` low model resolution and authentication troubleshooting.
- Automatic and on-demand traces showing no extra read round trip.
- Commands and possible Pi collision suffixes such as `/jev-skills:1`.
- Manual-only on-demand policy.
- Failure, privacy, cancellation, and path-trust behavior.
- Metrics labels and warning against unmeasured savings claims.
- Current limitations from the spec.

`jev-skill-router.example.json` must use placeholder visible names and omit pricing by default.

- [ ] **Step 5: Add MIT license and pi-jev attribution**

Use the standard MIT license for this package. Add a README attribution stating that the project independently adapts MIT-licensed concepts from TheoOliveira's `pi-jev`, while replacing its lexical 12-skill shortlist and old response parsing with full-scan TypeSafe SDK 0.6 behavior. Do not copy source wholesale.

- [ ] **Step 6: Run complete verification**

Run:

```bash
npm test
npm run typecheck
npm run smoke
git diff --check
git status --short
```

Expected: all automated tests pass; smoke passes because credentials are configured; typecheck has zero errors; diff check is clean. `git status --short` lists only intended documentation/test changes before commit.

- [ ] **Step 7: Commit documentation and smoke coverage**

```bash
git add README.md jev-skill-router.example.json LICENSE test/live-smoke.test.ts package.json package-lock.json
git commit -m "docs: add router setup and live verification"
```

- [ ] **Step 8: Verify the committed repository and report evidence**

Run:

```bash
npm test
npm run typecheck
npm run smoke
git status --short
git log --oneline --max-count=8
```

Expected: tests, typecheck, and credentialed smoke pass; working tree is clean. Report changed files, exact commands and counts, sanitized smoke findings, unverified API areas, and remaining limitations. Do not install into Pi settings.
