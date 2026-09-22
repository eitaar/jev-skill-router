import assert from "node:assert/strict";
import test from "node:test";
import type { SlashCommandInfo } from "@earendil-works/pi-coding-agent";
import { captureRegistry, eligibleSkills, filterVisible } from "../src/registry.js";
import { collectInterpretationContext } from "../src/context.js";
import { reconstructSuppliedSkills } from "../src/state.js";
import { makeSkills } from "./helpers.js";

function skillCommand(name: string, path: string): SlashCommandInfo {
  return {
    name: `skill:${name}`,
    description: `Command for ${name}`,
    source: "skill",
    sourceInfo: { path, source: "local", scope: "user", origin: "top-level" }
  };
}

test("134 discovered and 10 visible yields 124 automatic candidates", () => {
  const registry = captureRegistry(makeSkills(134), []);
  const visible = new Set([...registry.keys()].slice(0, 10));
  assert.equal(eligibleSkills(registry, visible, new Set(), "automatic").length, 124);
  assert.equal(filterVisible(registry, [...visible]).length, 10);
});

test("manual-only skills are on-demand-only", () => {
  const registry = captureRegistry(makeSkills(2, { manualOnly: [1] }), []);
  assert.deepEqual(eligibleSkills(registry, new Set(), new Set(), "automatic").map(skill => skill.name), ["skill-000"]);
  assert.equal(eligibleSkills(registry, new Set(), new Set(), "on-demand").length, 2);
});

test("registry preserves native skill order and paths rather than trusting command-only entries", () => {
  const skills = makeSkills(2);
  const first = skills[0]!;
  const second = skills[1]!;
  const registry = captureRegistry([second, first], [
    skillCommand(first.name, "C:/wrong/SKILL.md"),
    skillCommand("orphan", "C:/orphan/SKILL.md")
  ]);

  assert.deepEqual([...registry.keys()], [second.name, first.name]);
  assert.equal(registry.get(first.name)?.filePath, first.filePath);
  assert.equal(registry.get(first.name)?.sourceInfo, first.sourceInfo);
  assert.equal(registry.has("orphan"), false);
});

test("matching native skill command fills a missing canonical path", () => {
  const skill = makeSkills(1)[0]!;
  const path = "C:/canonical/SKILL.md";
  const withoutPath = {
    ...skill,
    filePath: "",
    sourceInfo: { ...skill.sourceInfo, path: "" }
  };
  const registry = captureRegistry([withoutPath], [skillCommand(skill.name, path)]);

  assert.equal(registry.get(skill.name)?.filePath, path);
  assert.equal(registry.get(skill.name)?.sourceInfo.path, path);
});

test("visible filtering preserves registry order and excludes manual-only skills", () => {
  const registry = captureRegistry(makeSkills(3, { manualOnly: [1] }), []);
  const visible = filterVisible(registry, ["skill-002", "skill-001", "skill-000"]);
  assert.deepEqual(visible.map(skill => skill.name), ["skill-000", "skill-002"]);
});

test("eligibility excludes supplied skills and sorts candidates by name", () => {
  const skills = makeSkills(3);
  const registry = captureRegistry([skills[2]!, skills[0]!, skills[1]!], []);
  const eligible = eligibleSkills(registry, new Set(), new Set(["skill-001"]), "automatic");
  assert.deepEqual(eligible.map(skill => skill.name), ["skill-000", "skill-002"]);
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

test("context does not repeat the current user request from active history", () => {
  const entries = [
    { type: "message", message: { role: "user", content: " Fix current task ", timestamp: 1 } }
  ] as never[];
  const text = collectInterpretationContext({ current: "Fix current task", entries, projectName: "app", supplied: [], maxChars: 200, recentUserMessages: 4 });
  assert.equal(text.split("Fix current task").length - 1, 1);
});

test("context includes only user history, project basename, supplied names, and image presence", () => {
  const entries = [
    { type: "message", message: { role: "user", content: "older context", timestamp: 1 } },
    { type: "message", message: { role: "assistant", content: "assistant secret", timestamp: 2 } },
    { type: "message", message: { role: "user", content: [{ type: "image", data: "private image bytes" }], timestamp: 3 } },
    { type: "message", message: { role: "toolResult", toolName: "read", content: [{ type: "text", text: "tool secret" }], timestamp: 4 } }
  ] as never[];
  const text = collectInterpretationContext({
    current: "current request",
    entries,
    projectName: "C:/work/app",
    supplied: ["frontend-design"],
    maxChars: 300,
    recentUserMessages: 4
  });

  assert.ok(text.indexOf("current request") < text.indexOf("Project: app"));
  assert.match(text, /Supplied skills: frontend-design/);
  assert.match(text, /older context/);
  assert.match(text, /\[image attached\]/);
  assert.doesNotMatch(text, /assistant secret|tool secret|private image bytes/);
});

test("context truncates at Unicode code-point boundaries and labels truncation", () => {
  const text = collectInterpretationContext({
    current: "😀日本語の長い依頼😀日本語の長い依頼",
    entries: [],
    projectName: "project-with-a-long-name",
    supplied: [],
    maxChars: 30,
    recentUserMessages: 4
  });
  assert.ok([...text].length <= 30);
  assert.match(text, /\[truncated\]/);
  assert.ok(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(text));
});

test("supplied skills are reconstructed from active automatic and on-demand entries only", () => {
  const entries = [
    { type: "custom_message", customType: "jev-skill-router", details: { suppliedSkills: ["frontend-design"] } },
    { type: "message", message: { role: "toolResult", toolName: "jev_skill_search", details: { suppliedSkills: ["accessibility", "frontend-design"] } } },
    { type: "custom_message", customType: "other-extension", details: { suppliedSkills: ["ignored-custom"] } },
    { type: "message", message: { role: "toolResult", toolName: "read", details: { suppliedSkills: ["ignored-tool"] } } }
  ] as never[];
  assert.deepEqual([...reconstructSuppliedSkills(entries)], ["frontend-design", "accessibility"]);
});
