import assert from "node:assert/strict";
import test from "node:test";
import { interpretTask } from "../src/interpreter.js";
import { fakeAssistant, fakeInterpreterRegistry } from "./helpers.js";

test("uses exact Luna model at low reasoning without changing the main model", async () => {
  const registry = fakeInterpreterRegistry([fakeAssistant('```json\n{"task":"Polish the React screen","domain":"frontend-ui"}\n```')]);
  const activeModel = { provider: "openai-codex", id: "gpt-6-sol" };
  const result = await interpretTask({ registry, modelRef: "openai-codex/gpt-6-luna", context: "このReact画面をもっと綺麗にして", timeoutMs: 1000 });
  assert.equal(result.task, "Polish the React screen");
  assert.equal(registry.calls[0]?.model.provider, "openai-codex");
  assert.equal(registry.calls[0]?.model.id, "gpt-6-luna");
  assert.equal(registry.calls[0]?.options.reasoning, "low");
  assert.deepEqual(activeModel, { provider: "openai-codex", id: "gpt-6-sol" });
});

test("does not select an arbitrary model when Luna resolution is ambiguous", async () => {
  const registry = fakeInterpreterRegistry([fakeAssistant('{"task":"must not be used"}')]);
  const model = registry.getAvailable()[0]!;
  registry.getAvailable = () => [model, { ...model }];
  const result = await interpretTask({ registry, modelRef: "openai-codex/gpt-6-luna", context: "raw task", timeoutMs: 1000 });
  assert.equal(result.task, "raw task");
  assert.equal(result.fallbackUsed, true);
  assert.equal(result.attempts, 0);
  assert.equal(registry.calls.length, 0);
});

test("retries malformed JSON once then succeeds with a repair-only prompt", async () => {
  const registry = fakeInterpreterRegistry([fakeAssistant("not json"), fakeAssistant('{"task":"Fix keyboard accessibility"}')]);
  const result = await interpretTask({ registry, modelRef: "openai-codex/gpt-6-luna", context: "fix it", timeoutMs: 1000 });
  assert.equal(registry.calls.length, 2);
  assert.equal(result.attempts, 2);
  assert.equal(result.fallbackUsed, false);
  const retryContent = registry.calls[1]?.context.messages[0]?.role === "user" ? registry.calls[1].context.messages[0].content : "";
  assert.match(String(retryContent), /not json/);
  assert.doesNotMatch(String(retryContent), /fix it|skill catalog/i);
});

test("falls back to bounded raw context after final malformed response", async () => {
  const registry = fakeInterpreterRegistry([fakeAssistant("bad"), fakeAssistant("bad again")]);
  const result = await interpretTask({ registry, modelRef: "openai-codex/gpt-6-luna", context: "raw bounded task", timeoutMs: 1000 });
  assert.equal(result.task, "raw bounded task");
  assert.equal(result.fallbackUsed, true);
  assert.equal(result.errorCategory, "malformed");
});

test("copies provider usage unchanged as measured Pi usage", async () => {
  const usage = {
    input: 21,
    output: 8,
    cacheRead: 4,
    cacheWrite: 2,
    reasoning: 3,
    totalTokens: 29,
    cost: { input: 0.001, output: 0.002, cacheRead: 0.0001, cacheWrite: 0.0002, total: 0.0033 }
  };
  const registry = fakeInterpreterRegistry([fakeAssistant('{"task":"Summarize the request"}', { usage })]);
  const result = await interpretTask({ registry, modelRef: "openai-codex/gpt-6-luna", context: "summarize", timeoutMs: 1000 });
  assert.deepEqual(result.usage, usage);
});

test("aggregates measured usage across malformed-output repair attempts", async () => {
  const firstUsage = {
    input: 2,
    output: 3,
    cacheRead: 1,
    cacheWrite: 1,
    reasoning: 1,
    totalTokens: 5,
    cost: { input: 0.01, output: 0.02, cacheRead: 0.003, cacheWrite: 0.004, total: 0.037 }
  };
  const secondUsage = {
    input: 5,
    output: 6,
    cacheRead: 2,
    cacheWrite: 0,
    reasoning: 3,
    totalTokens: 11,
    cost: { input: 0.05, output: 0.06, cacheRead: 0.002, cacheWrite: 0, total: 0.112 }
  };
  const registry = fakeInterpreterRegistry([
    fakeAssistant("not json", { usage: firstUsage }),
    fakeAssistant('{"task":"Fix the layout"}', { usage: secondUsage })
  ]);
  const result = await interpretTask({ registry, modelRef: "openai-codex/gpt-6-luna", context: "fix the layout", timeoutMs: 1000 });
  assert.equal(result.attempts, 2);
  assert.ok(result.usage);
  assert.deepEqual({
    input: result.usage.input,
    output: result.usage.output,
    cacheRead: result.usage.cacheRead,
    cacheWrite: result.usage.cacheWrite,
    reasoning: result.usage.reasoning,
    totalTokens: result.usage.totalTokens
  }, { input: 7, output: 9, cacheRead: 3, cacheWrite: 1, reasoning: 4, totalTokens: 16 });
  assert.ok(Math.abs(result.usage.cost.input - 0.06) < 1e-12);
  assert.ok(Math.abs(result.usage.cost.output - 0.08) < 1e-12);
  assert.ok(Math.abs(result.usage.cost.cacheRead - 0.005) < 1e-12);
  assert.ok(Math.abs(result.usage.cost.cacheWrite - 0.004) < 1e-12);
  assert.ok(Math.abs(result.usage.cost.total - 0.149) < 1e-12);
});
