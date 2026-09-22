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
