import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { ClassifierContext } from "@earendil-works/pi-ai";
import { classifySkills, preflightSkills, type JevRegistry } from "../src/jev.js";
import { fakeJev, fakeUsage, makeSkillRecords } from "./helpers.js";

const classify = (registry: ReturnType<typeof fakeJev>, names: string[], options: { threshold?: number; topK?: number; chunkSize?: number } = {}) => classifySkills({
  registry, task: "このReact画面をもっと綺麗にして", skills: makeSkillRecords(names),
  threshold: options.threshold ?? 0.65, topK: options.topK ?? 3,
  model: "jev-latest", timeoutMs: 1000, chunkSize: options.chunkSize ?? 50
});

const httpFailure = (status: number, message: string) => ({ stopReason: "error" as const, errorMessage: `System One API error (${status}): ${message}` });

const answersFor = (questions: Record<string, unknown>, probability = 0.1) => Object.fromEntries(
  Object.keys(questions).map(key => [key, { type: "bool" as const, probability }])
);

test("native TypeSafe transport uses stored Pi auth, maps bool/noul, fails closed and only chunks size errors", async t => {
  const root = await mkdtemp(join(tmpdir(), "jev-native-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const authPath = join(root, "auth.json");
  await writeFile(authPath, JSON.stringify({ typesafe: { type: "api_key", key: "stored-test-key" } }));
  const native = new ModelRegistry(await ModelRuntime.create({ authPath, modelsPath: null, refreshOnCreate: false, allowModelNetwork: false }));
  const key = process.env.TYPESAFE_API_KEY;
  delete process.env.TYPESAFE_API_KEY;
  t.after(() => { if (key === undefined) delete process.env.TYPESAFE_API_KEY; else process.env.TYPESAFE_API_KEY = key; });

  const requests: ClassifierContext[] = [];
  let mode: "ok" | "malformed" | "size" | "server" = "ok";
  const registry: JevRegistry = {
    findOfType: native.findOfType.bind(native),
    classify: (model, context, options) => native.classify(model, context, {
      ...options,
      fetch: async (_url, init) => {
        assert.equal(new Headers(init?.headers).get("authorization"), "Bearer stored-test-key");
        const request = JSON.parse(String(init?.body)) as ClassifierContext;
        requests.push(request);
        if (mode === "server") return new Response("service unavailable", { status: 503 });
        if (mode === "size" && requests.length === 1) return new Response("payload too large", { status: 413 });
        return Response.json({
          answers: Object.fromEntries(Object.keys(request.questions).filter((_key, i) => mode !== "malformed" || i === 0).map(id => [id, { type: "noul", noul: 0.9 }])),
          usage: { input_tokens: 4, output_tokens: 2 }
        });
      }
    })
  };
  const input = { registry, task: "Find useful instructions", skills: makeSkillRecords(["a", "b"]), threshold: 0.65, topK: 3, model: "jev-latest", timeoutMs: 1000, chunkSize: 1 };
  const ok = await classifySkills(input);
  assert.deepEqual(ok.selected.map(item => item.skill.name), ["a", "b"]);
  assert.equal(requests[0]!.questions.skill_0000!.type, "noul");
  assert.deepEqual(ok.usage, { inputTokens: 4, outputTokens: 2 });

  mode = "malformed";
  requests.length = 0;
  const malformed = await classifySkills(input);
  assert.deepEqual(malformed.selected, []);
  assert.equal(malformed.errorCategory, "malformed");
  assert.deepEqual(malformed.usage, { inputTokens: 4, outputTokens: 2 });
  assert.equal(requests.length, 1);

  mode = "size";
  requests.length = 0;
  const chunked = await classifySkills(input);
  assert.deepEqual(requests.map(request => Object.keys(request.questions).length), [2, 1, 1]);
  assert.equal(chunked.coverage, "complete");

  mode = "server";
  requests.length = 0;
  assert.equal((await classifySkills(input)).errorCategory, "server");
  assert.equal(requests.length, 1);
});

test("sends every candidate for Japanese intent through native bool questions", async () => {
  const jev = fakeJev(({ questions }) => ({
    answers: Object.fromEntries(Object.keys(questions).map((key, index) => [key, { type: "bool", probability: index === 1 ? 0.9 : 0.1 }])),
    usage: fakeUsage(30, 3)
  }));
  const result = await classify(jev, ["database", "frontend-design", "rust-testing"]);
  assert.equal(Object.keys(jev.requests[0]!.questions).length, 3);
  assert.equal(jev.calls[0]!.model.provider, "typesafe");
  assert.equal(jev.calls[0]!.model.id, "jev-latest");
  assert.deepEqual(result.selected.map(x => x.skill.name), ["frontend-design"]);
});

test("rejects an entire request containing malformed or out-of-range probabilities", async () => {
  const jev = fakeJev(() => ({
    answers: { skill_0000: { type: "bool", probability: 2 }, skill_0001: { type: "bool", probability: NaN }, skill_0002: { type: "bool", probability: 0.8 } },
    usage: fakeUsage(1, 1)
  }));
  const result = await classify(jev, ["a", "b", "c"]);
  assert.deepEqual(result.selected, []);
  assert.deepEqual(result.scores, []);
  assert.equal(result.invalidAnswers, 2);
  assert.equal(result.evaluatedCount, 0);
  assert.equal(result.coverage, "none");
  assert.equal(result.errorCategory, "malformed");
  assert.deepEqual(result.usage, { inputTokens: 1, outputTokens: 1 });
});

test("counts billed usage when native answer validation fails", async () => {
  const jev = fakeJev(() => ({ stopReason: "error", errorMessage: "System One API did not return an answer for skill_0001", usage: fakeUsage(4, 2) }));
  const result = await classify(jev, ["a", "b"]);
  assert.deepEqual(result.selected, []);
  assert.equal(result.errorCategory, "malformed");
  assert.equal(jev.requests.length, 1);
  assert.deepEqual(result.usage, { inputTokens: 4, outputTokens: 2 });
});

test("attempts all candidates before deterministic size-only chunks", async () => {
  const jev = fakeJev(({ questions }, call) => call === 0
    ? httpFailure(413, "payload too large")
    : { answers: answersFor(questions), usage: fakeUsage(1, 1) });
  const result = await classify(jev, Array.from({ length: 134 }, (_, i) => `skill-${i}`));
  assert.equal(Object.keys(jev.requests[0]!.questions).length, 134);
  assert.deepEqual(jev.requests.slice(1).map(r => Object.keys(r.questions).length), [50, 50, 34]);
  assert.equal(result.evaluatedCount, 134);
  assert.equal(result.coverage, "complete");
  assert.deepEqual(result.usage, { inputTokens: 3, outputTokens: 3 });
});

test("accepts explicit 400/422 question-size validation errors as chunk fallback signals", async () => {
  for (const status of [400, 422]) {
    const jev = fakeJev(({ questions }, call) => call === 0
      ? httpFailure(status, "question size exceeds maximum")
      : { answers: answersFor(questions), usage: fakeUsage(1, 2) });
    const result = await classify(jev, ["one", "two"], { chunkSize: 1 });
    assert.equal(jev.requests.length, 3);
    assert.equal(result.coverage, "complete");
  }
});

test("sorts probability ties by skill name and applies threshold before topK", async () => {
  const jev = fakeJev(({ questions }) => ({
    answers: Object.fromEntries(Object.keys(questions).map((key, index) => [key, { type: "bool", probability: [0.8, 0.9, 0.9, 0.64][index]! }])),
    usage: fakeUsage(4, 2)
  }));
  const result = await classify(jev, ["zulu", "bravo", "alpha", "below"], { topK: 2 });
  assert.deepEqual(result.selected.map(x => x.skill.name), ["alpha", "bravo"]);
  assert.deepEqual(result.scores.map(x => x.skill.name), ["alpha", "bravo", "zulu", "below"]);
});

test("zero matches return no selection and never fabricate unevaluated scores", async () => {
  const jev = fakeJev(({ questions }) => ({ answers: answersFor(questions), usage: fakeUsage(2, 1) }));
  const result = await classify(jev, ["a", "b"]);
  assert.deepEqual(result.selected, []);
  assert.equal(result.scores.length, 2);
  assert.equal(result.coverage, "complete");
});

test("keeps completed chunk answers and marks later failure partial", async () => {
  const jev = fakeJev(({ questions }, call) => call === 0 ? httpFailure(413, "payload too large")
    : call === 3 ? { stopReason: "error", errorMessage: "provider unavailable" }
    : { answers: answersFor(questions, 0.9), usage: fakeUsage(2, 1) });
  const result = await classify(jev, Array.from({ length: 134 }, (_, i) => `skill-${i}`));
  assert.equal(result.coverage, "partial");
  assert.equal(result.evaluatedCount, 100);
  assert.equal(result.scores.length, 100);
  assert.equal(result.scores.some(score => score.skill.name === "skill-100"), false);
  assert.deepEqual(result.usage, { inputTokens: 4, outputTokens: 2 });
  assert.equal(result.errorCategory, "provider");
});

test("does not chunk ambiguous text, unrelated validation, timeouts, auth, cancellation or server errors", async () => {
  const failures = [
    [httpFailure(422, "request maximum tokens must be positive"), "provider"],
    [{ stopReason: "error" as const, errorMessage: "payload too large (413)" }, "provider"],
    [httpFailure(429, "request size exceeds maximum"), "rate-limit"],
    [{ stopReason: "error" as const, errorMessage: "Request timed out after 1000ms" }, "timeout"],
    [httpFailure(401, "unauthorized"), "authentication"],
    [httpFailure(403, "forbidden"), "permission-denied"],
    [{ stopReason: "error" as const, errorMessage: "Provider is not configured: typesafe" }, "authentication"],
    [{ stopReason: "aborted" as const }, "cancelled"],
    [httpFailure(503, "payload too large"), "server"]
  ] as const;
  for (const [failure, category] of failures) {
    const jev = fakeJev(() => failure);
    const result = await classify(jev, ["a", "b"], { chunkSize: 1 });
    assert.equal(jev.requests.length, 1);
    assert.equal(result.coverage, "none");
    assert.equal(result.errorCategory, category);
  }
});

test("an already-aborted signal makes no Jev request", async () => {
  const controller = new AbortController();
  controller.abort();
  const jev = fakeJev(() => { throw new Error("must not run"); });
  const result = await classifySkills({ registry: jev, task: "task", skills: makeSkillRecords(["a"]), threshold: 0.65, topK: 3, model: "jev-latest", timeoutMs: 1000, chunkSize: 50, signal: controller.signal });
  assert.equal(jev.requests.length, 0);
  assert.equal(result.errorCategory, "cancelled");
});

test("caller cancellation after a size failure prevents chunk requests", async () => {
  const controller = new AbortController();
  const jev = fakeJev(() => { controller.abort(); return httpFailure(413, "too large"); });
  const result = await classifySkills({ registry: jev, task: "task", skills: makeSkillRecords(["a", "b"]), threshold: 0.65, topK: 3, model: "jev-latest", timeoutMs: 1000, chunkSize: 1, signal: controller.signal });
  assert.equal(jev.requests.length, 1);
  assert.equal(result.errorCategory, "cancelled");
});

test("passes timeoutMs and cancellation to Pi and disables automatic retries", async () => {
  const controller = new AbortController();
  const jev = fakeJev(({ questions }) => ({ answers: answersFor(questions), usage: fakeUsage(1, 1) }));
  await classifySkills({ registry: jev, task: "task", skills: makeSkillRecords(["a"]), threshold: 0.65, topK: 3, model: "jev-latest", timeoutMs: 1234, chunkSize: 50, signal: controller.signal });
  assert.equal(jev.calls[0]!.options?.timeoutMs, 1234);
  assert.equal(jev.calls[0]!.options?.signal, controller.signal);
  assert.equal(jev.calls[0]!.options?.maxRetries, 0);
});

test("routing asks whether a skill helps a stated goal or task step, without domain restrictions", async () => {
  const jev = fakeJev(() => ({}));
  const task = "Build a responsive accessible ToDo app with localStorage and verify it";
  await classifySkills({ registry: jev, task, skills: makeSkillRecords(["frontend-design"]), threshold: 0.65, topK: 3, model: "jev-latest", timeoutMs: 1000, chunkSize: 50 });
  assert.deepEqual(jev.requests[0]!.state, { task });
  const question = jev.requests[0]!.questions.skill_0000!;
  assert.equal(question.type, "bool");
  assert.deepEqual(JSON.parse(question.instructions), {
    skill: "frontend-design", description: "Instructions for frontend-design",
    criterion: "Will this skill materially help a stated goal or required step of THIS task, especially an explicit user priority? No for generic advice or unmet prerequisites. Plan execution needs an existing plan; language/framework-specific skills need that stack stated."
  });
});

test("an empty candidate set skips the provider", async () => {
  const jev = fakeJev(() => { throw new Error("must not run"); });
  const result = await classify(jev, []);
  assert.equal(jev.requests.length, 0);
  assert.equal(result.coverage, "complete");
});

test("an unavailable classifier fails safely without a provider call", async () => {
  const jev = fakeJev(() => { throw new Error("must not run"); });
  jev.findOfType = () => undefined;
  const result = await classify(jev, ["a"]);
  assert.equal(result.errorCategory, "model-unavailable");
  assert.equal(jev.requests.length, 0);
  assert.equal((await preflightSkills({ registry: jev, context: "task", model: "jev-latest", timeoutMs: 1000 })).errorCategory, "model-unavailable");
});

test("does not invent zero Jev token counts when usage is missing", async () => {
  const jev = fakeJev(({ questions }) => ({ answers: answersFor(questions, 0.9) }));
  const result = await classify(jev, ["a"]);
  assert.deepEqual(result.usage, {});
});

test("preflight asks one native bool question and fails closed on invalid answers", async () => {
  const jev = fakeJev((_request, call) => ({
    answers: { need_skills: { type: "bool", probability: call === 0 ? 0.1 : call === 1 ? 0.8 : NaN } },
    usage: fakeUsage(3, 1)
  }));
  const input = { registry: jev, context: "Current request: つまり？\nPrevious user request: 調べて", model: "jev-latest", timeoutMs: 1000 };
  const no = await preflightSkills(input);
  const yes = await preflightSkills({ ...input, context: "Current request: 直して\nPrevious user request: 調べて" });
  const invalid = await preflightSkills(input);
  assert.equal(no.needed, false);
  assert.equal(yes.needed, true);
  assert.equal(invalid.needed, false);
  assert.equal(invalid.errorCategory, "malformed");
  assert.deepEqual(jev.requests[0]?.state, { task: input.context });
  assert.deepEqual(jev.requests.map(request => Object.keys(request.questions)), [["need_skills"], ["need_skills"], ["need_skills"]]);
  assert.equal(jev.calls[0]!.options?.maxRetries, 0);
  assert.deepEqual(no.usage, { inputTokens: 3, outputTokens: 1 });
});
