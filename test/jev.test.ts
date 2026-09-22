import assert from "node:assert/strict";
import { APIError, APITimeoutError, APIUserAbortError, AuthenticationError, InternalServerError } from "@typesafe-ai/sdk";
import test from "node:test";
import { classifySkills } from "../src/jev.js";
import { fakeJev, makeSkillRecords } from "./helpers.js";

const classify = (client: ReturnType<typeof fakeJev>, names: string[], options: { threshold?: number; topK?: number; chunkSize?: number } = {}) => classifySkills({
  client,
  task: "このReact画面をもっと綺麗にして",
  skills: makeSkillRecords(names),
  threshold: options.threshold ?? 0.65,
  topK: options.topK ?? 3,
  model: "jev-latest",
  timeoutMs: 1000,
  chunkSize: options.chunkSize ?? 50
});

test("sends every candidate for Japanese intent without lexical filtering", async () => {
  const skills = ["database", "frontend-design", "rust-testing"];
  const jev = fakeJev(({ questions }) => ({
    answers: Object.fromEntries(Object.keys(questions).map((key, index) => [key, { type: "noul", noul: index === 1 ? 0.9 : 0.1 }])),
    model: "jev-latest",
    usage: { input_tokens: 30, output_tokens: 3 }
  }));
  const result = await classifySkills({ client: jev, task: "このReact画面をもっと綺麗にして", skills: makeSkillRecords(skills), threshold: 0.65, topK: 3, model: "jev-latest", timeoutMs: 1000, chunkSize: 2 });
  assert.equal(Object.keys(jev.requests[0]!.questions).length, 3);
  assert.deepEqual(result.selected.map(x => x.skill.name), ["frontend-design"]);
});

test("rejects malformed and out-of-range probabilities", async () => {
  const jev = fakeJev(() => ({ answers: { skill_0000: { noul: 2 }, skill_0001: { noul: "0.9" }, skill_0002: { noul: 0.8 } }, model: "jev-latest", usage: { input_tokens: 1, output_tokens: 1 } }));
  const result = await classify(jev, ["a", "b", "c"]);
  assert.deepEqual(result.selected.map(x => x.skill.name), ["c"]);
  assert.equal(result.invalidAnswers, 2);
  assert.equal(result.evaluatedCount, 3);
});

test("attempts all candidates before deterministic size-only chunks", async () => {
  const jev = fakeJev(({ questions }, call) => {
    if (call === 0) throw Object.assign(new Error("too large"), { status: 413 });
    return { answers: Object.fromEntries(Object.keys(questions).map(key => [key, { noul: 0.1 }])), model: "jev-latest", usage: { input_tokens: 1, output_tokens: 1 } };
  });
  const result = await classify(jev, Array.from({ length: 134 }, (_, i) => `skill-${i}`));
  assert.equal(Object.keys(jev.requests[0]!.questions).length, 134);
  assert.deepEqual(jev.requests.slice(1).map(r => Object.keys(r.questions).length), [50, 50, 34]);
  assert.equal(result.evaluatedCount, 134);
  assert.equal(result.coverage, "complete");
  assert.deepEqual(result.usage, { inputTokens: 3, outputTokens: 3 });
});

test("accepts TypeSafe question-size validation errors as chunk fallback signals", async () => {
  const jev = fakeJev(({ questions }, call) => {
    if (call === 0) throw new APIError(422, { message: "question size exceeds maximum" }, new Headers(), "question size exceeds maximum");
    return { answers: Object.fromEntries(Object.keys(questions).map(key => [key, { noul: 0.1 }])), model: "jev-latest", usage: { input_tokens: 1, output_tokens: 2 } };
  });
  const result = await classify(jev, ["one", "two"], { chunkSize: 1 });
  assert.equal(jev.requests.length, 3);
  assert.equal(result.coverage, "complete");
});

test("sorts probability ties by skill name and applies threshold before topK", async () => {
  const jev = fakeJev(({ questions }) => ({
    answers: Object.fromEntries(Object.keys(questions).map((key, index) => [key, { noul: [0.8, 0.9, 0.9, 0.64][index] }])),
    model: "jev-latest",
    usage: { input_tokens: 4, output_tokens: 2 }
  }));
  const result = await classify(jev, ["zulu", "bravo", "alpha", "below"], { topK: 2 });
  assert.deepEqual(result.selected.map(x => x.skill.name), ["alpha", "bravo"]);
  assert.deepEqual(result.scores.map(x => x.skill.name), ["alpha", "bravo", "zulu", "below"]);
});

test("zero matches return no selection and never fabricate unevaluated scores", async () => {
  const jev = fakeJev(({ questions }) => ({
    answers: Object.fromEntries(Object.keys(questions).map(key => [key, { noul: 0.1 }])),
    model: "jev-latest",
    usage: { input_tokens: 2, output_tokens: 1 }
  }));
  const result = await classify(jev, ["a", "b"]);
  assert.deepEqual(result.selected, []);
  assert.equal(result.scores.length, 2);
  assert.equal(result.coverage, "complete");
});

test("keeps completed chunk answers and marks later failure partial", async () => {
  const jev = fakeJev(({ questions }, call) => {
    if (call === 0) throw Object.assign(new Error("too large"), { status: 413 });
    if (call === 3) throw new Error("provider unavailable");
    return { answers: Object.fromEntries(Object.keys(questions).map(key => [key, { noul: 0.9 }])), model: "jev-latest", usage: { input_tokens: 2, output_tokens: 1 } };
  });
  const names = Array.from({ length: 134 }, (_, i) => `skill-${i}`);
  const result = await classify(jev, names);
  assert.equal(result.coverage, "partial");
  assert.equal(result.evaluatedCount, 100);
  assert.equal(result.scores.length, 100);
  assert.equal(result.scores.some(score => score.skill.name === "skill-100"), false);
  assert.deepEqual(result.usage, { inputTokens: 4, outputTokens: 2 });
  assert.equal(result.errorCategory, "provider");
});

test("does not chunk unrelated TypeSafe request validation errors", async () => {
  const jev = fakeJev(() => { throw new APIError(422, { message: "request maximum tokens must be positive" }, new Headers()); });
  const result = await classify(jev, ["a", "b"], { chunkSize: 1 });
  assert.equal(jev.requests.length, 1);
  assert.equal(result.coverage, "none");
  assert.equal(result.errorCategory, "provider");
});

test("does not chunk TypeSafe timeouts", async () => {
  const jev = fakeJev(() => { throw new APITimeoutError(1000); });
  const result = await classify(jev, ["a", "b"], { chunkSize: 1 });
  assert.equal(jev.requests.length, 1);
  assert.equal(result.coverage, "none");
  assert.equal(result.errorCategory, "timeout");
});

test("does not fall back to chunks for authentication, cancellation, or server errors", async () => {
  const failures = [
    [new AuthenticationError(401, {}, new Headers()), "authentication"],
    [new APIUserAbortError(), "cancelled"],
    [new InternalServerError(503, {}, new Headers()), "server"]
  ] as const;
  for (const [failure, category] of failures) {
    const jev = fakeJev(() => { throw failure; });
    const result = await classify(jev, ["a", "b"]);
    assert.equal(jev.requests.length, 1);
    assert.equal(result.coverage, "none");
    assert.equal(result.errorCategory, category);
  }
});

test("an already-aborted signal makes no Jev request", async () => {
  const controller = new AbortController();
  controller.abort();
  const jev = fakeJev(() => { throw new Error("must not run"); });
  const result = await classifySkills({ client: jev, task: "task", skills: makeSkillRecords(["a"]), threshold: 0.65, topK: 3, model: "jev-latest", timeoutMs: 1000, chunkSize: 50, signal: controller.signal });
  assert.equal(jev.requests.length, 0);
  assert.equal(result.errorCategory, "cancelled");
});

test("passes the configured timeout and cancellation signal to TypeSafe", async () => {
  const controller = new AbortController();
  const jev = fakeJev(({ questions }) => ({ answers: Object.fromEntries(Object.keys(questions).map(key => [key, { noul: 0.1 }])), usage: { input_tokens: 1, output_tokens: 1 }, model: "jev-latest" }));
  await classifySkills({ client: jev, task: "task", skills: makeSkillRecords(["a"]), threshold: 0.65, topK: 3, model: "jev-latest", timeoutMs: 1234, chunkSize: 50, signal: controller.signal });
  assert.equal(jev.calls[0]!.options?.timeout, 1234);
  assert.equal(jev.calls[0]!.options?.signal, controller.signal);
});

test("sends only normalized task state and includes canonical skill metadata in each question", async () => {
  const jev = fakeJev(() => ({ answers: {}, usage: { input_tokens: 1, output_tokens: 1 }, model: "jev-latest" }));
  await classify(jev, ["frontend-design"]);
  assert.deepEqual(jev.requests[0]!.state, { task: "このReact画面をもっと綺麗にして" });
  assert.deepEqual(jev.requests[0]!.questions.skill_0000!.instructions, {
    skill: "frontend-design",
    description: "Instructions for frontend-design",
    criterion: "Does this skill supply instructions directly useful for completing the task?"
  });
});

test("an empty candidate set skips the provider", async () => {
  const jev = fakeJev(() => { throw new Error("must not run"); });
  const result = await classify(jev, []);
  assert.equal(jev.requests.length, 0);
  assert.equal(result.coverage, "complete");
  assert.equal(result.evaluatedCount, 0);
});

test("does not invent zero Jev token counts when usage is missing", async () => {
  const jev = fakeJev(({ questions }) => ({
    answers: Object.fromEntries(Object.keys(questions).map(key => [key, { noul: 0.9 }])),
    model: "jev-latest"
  }));
  const result = await classify(jev, ["a"]);
  assert.deepEqual(result.usage, {});
});
