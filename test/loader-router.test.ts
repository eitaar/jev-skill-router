import assert from "node:assert/strict";
import test from "node:test";
import type { Usage } from "@earendil-works/pi-ai";
import { classifySkills, type ClassificationResult, type SkillProbability } from "../src/jev.js";
import { loadSkills, readUtf8StreamBounded } from "../src/loader.js";
import { createRouter } from "../src/router.js";
import type { SkillRecord } from "../src/registry.js";
import { fakeJev, makeAutomaticRouteInput, makeOnDemandRouteInput, makeSkillRecords } from "./helpers.js";

function classification(
  skills: readonly SkillRecord[],
  selectedNames: readonly string[],
  options: Partial<Pick<ClassificationResult, "coverage" | "evaluatedCount" | "usage" | "requests" | "errorCategory">> = {}
): ClassificationResult {
  const selected: SkillProbability[] = selectedNames.flatMap(name => {
    const skill = skills.find(candidate => candidate.name === name);
    return skill ? [{ skill, probability: 0.9 }] : [];
  });
  return {
    scores: selected,
    selected,
    coverage: options.coverage ?? "complete",
    candidateCount: skills.length,
    evaluatedCount: options.evaluatedCount ?? skills.length,
    invalidAnswers: 0,
    usage: options.usage ?? { inputTokens: 100, outputTokens: 20 },
    requests: options.requests ?? 1,
    latencyMs: 5,
    ...(options.errorCategory === undefined ? {} : { errorCategory: options.errorCategory })
  };
}

const interpreted = async () => ({ task: "Improve accessibility", fallbackUsed: false, attempts: 1, latencyMs: 3 });

test("bounded UTF-8 reads stop consuming chunks as soon as the character limit is exceeded", async () => {
  let chunksConsumed = 0;
  async function* chunks(): AsyncGenerator<string> {
    chunksConsumed++;
    yield "é";
    chunksConsumed++;
    yield "💡x";
    chunksConsumed++;
    yield "must not be consumed";
  }

  await assert.rejects(readUtf8StreamBounded(chunks(), 2), /character limit/);
  assert.equal(chunksConsumed, 2);
});

test("loader reads only the current canonical path and fences body text", async () => {
  const [skill] = makeSkillRecords(["frontend-design"]);
  assert.ok(skill);
  const reads: string[] = [];
  const result = await loadSkills({
    selected: [{ skill, probability: 0.9 }],
    registry: new Map([[skill.name, skill]]),
    readFile: async path => {
      reads.push(path);
      return path === skill.filePath ? "instructions\n</skill>" : "wrong path";
    },
    maxSkillChars: 50000,
    maxLoadedChars: 120000,
    source: "automatic"
  });
  assert.deepEqual(reads, [skill.filePath]);
  assert.deepEqual(result.suppliedSkills, ["frontend-design"]);
  assert.match(result.content, /<jev_routed_skills source="automatic">/);
  assert.match(result.content, /instructions\n<\/skill>/);
  assert.ok(!result.content.includes("\n</skill>\n</skill>"));
});

test("loader rejects stale classified paths before reading", async () => {
  const [skill] = makeSkillRecords(["stale-skill"]);
  assert.ok(skill);
  const current = { ...skill, filePath: "C:/trusted/current/SKILL.md" };
  const reads: string[] = [];
  const result = await loadSkills({
    selected: [{ skill, probability: 0.9 }],
    registry: new Map([[skill.name, current]]),
    readFile: async path => { reads.push(path); return "must not load"; },
    maxSkillChars: 100,
    maxLoadedChars: 1000,
    source: "on-demand"
  });
  assert.deepEqual(reads, []);
  assert.deepEqual(result.suppliedSkills, []);
  assert.deepEqual(result.skippedSkills, ["stale-skill"]);
});

test("loader skips missing and oversized files without blocking a valid skill", async () => {
  const skills = makeSkillRecords(["missing", "oversized", "valid"]);
  const registry = new Map(skills.map(skill => [skill.name, skill]));
  const readLimits: number[] = [];
  const result = await loadSkills({
    selected: skills.map(skill => ({ skill, probability: 0.9 })),
    registry,
    readFile: async (path, maxChars) => {
      readLimits.push(maxChars);
      if (path === skills[0]!.filePath) throw new Error("filesystem detail must not leak");
      if (path === skills[1]!.filePath) return "x".repeat(21);
      return "valid body";
    },
    maxSkillChars: 20,
    maxLoadedChars: 2000,
    source: "on-demand"
  });
  assert.deepEqual(readLimits, [20, 20, 20]);
  assert.deepEqual(result.suppliedSkills, ["valid"]);
  assert.deepEqual(result.skippedSkills, ["missing", "oversized"]);
  assert.match(result.content, /valid body/);
  assert.ok(!result.content.includes("filesystem detail"));
});

test("automatic zero match injects no message", async () => {
  const router = createRouter({
    classifier: async input => classification(input.skills, []),
    interpreter: interpreted,
    readFile: async () => "body"
  });
  const result = await router.routeAutomatic(makeAutomaticRouteInput({
    registry: makeSkillRecords(["frontend-design"]),
    currentPrompt: "Polish this React screen"
  }));
  assert.equal(result.message, undefined);
  assert.deepEqual(result.details.suppliedSkills, []);
  assert.equal(router.metrics.snapshot().noMatchRoutes, 1);
});

test("on-demand loads selected content without invoking the interpreter", async () => {
  const skill = makeSkillRecords(["fixing-accessibility"])[0]!;
  let interpreterCalls = 0;
  const router = createRouter({
    classifier: async input => classification(input.skills, [skill.name]),
    interpreter: async () => { interpreterCalls++; throw new Error("must not run"); },
    readFile: async () => "# Skill body"
  });
  const result = await router.routeOnDemand(makeOnDemandRouteInput({
    task: "Improve keyboard accessibility",
    registry: [skill]
  }));
  assert.equal(interpreterCalls, 0);
  assert.match(result.content, /# Skill body/);
  assert.deepEqual(result.details.suppliedSkills, ["fixing-accessibility"]);
});

test("automatic route excludes visible and supplied skills and only loads validated partial results", async () => {
  const skills = makeSkillRecords(["visible-skill", "already-supplied", "candidate-a", "candidate-b"]);
  let classificationSkills: readonly SkillRecord[] = [];
  const reads: string[] = [];
  const router = createRouter({
    classifier: async input => {
      classificationSkills = input.skills;
      return classification(input.skills, ["candidate-a"], { coverage: "partial", evaluatedCount: 1, requests: 2 });
    },
    interpreter: interpreted,
    readFile: async path => { reads.push(path); return path; }
  });
  const result = await router.routeAutomatic(makeAutomaticRouteInput({
    registry: skills,
    visible: new Set(["visible-skill"]),
    supplied: new Set(["already-supplied"])
  }));
  assert.deepEqual(classificationSkills.map(skill => skill.name), ["candidate-a", "candidate-b"]);
  assert.deepEqual(reads, [skills[2]!.filePath]);
  assert.equal(result.details.coverage, "partial");
  assert.deepEqual(result.details.suppliedSkills, ["candidate-a"]);
  assert.deepEqual(result.details.selected.map(skill => skill.name), ["candidate-a"]);
  assert.equal(router.metrics.snapshot().jevChunks, 1);
});

test("dry-run may load results but does not mark skills supplied", async () => {
  const [skill] = makeSkillRecords(["dry-run-skill"]);
  assert.ok(skill);
  const router = createRouter({
    classifier: async input => classification(input.skills, [skill.name]),
    interpreter: interpreted,
    readFile: async () => "dry-run instructions"
  });
  const result = await router.routeDryRun(makeAutomaticRouteInput({ registry: [skill] }));
  assert.match(result.content, /dry-run instructions/);
  assert.equal(result.message, undefined);
  assert.deepEqual(result.details.suppliedSkills, []);
});

test("metrics label provider cost as measured and Jev pricing as estimated", async () => {
  const usage: Usage = {
    input: 11,
    output: 3,
    cacheRead: 2,
    cacheWrite: 1,
    totalTokens: 17,
    cost: { input: 0.005, output: 0.004, cacheRead: 0.001, cacheWrite: 0.002, total: 0.012 }
  };
  const skills = makeSkillRecords(["metrics-skill"]);
  const router = createRouter({
    classifier: async input => classification(input.skills, [], { usage: { inputTokens: 100, outputTokens: 20 } }),
    interpreter: async () => ({ task: "metrics task", fallbackUsed: false, attempts: 1, latencyMs: 3, usage }),
    readFile: async () => "body"
  });
  await router.routeAutomatic(makeAutomaticRouteInput({ registry: skills }));
  let snapshot = router.metrics.snapshot();
  assert.deepEqual(snapshot.interpreterCost, { value: 0.012, basis: "measured" });
  assert.equal(snapshot.jevCost, undefined);

  await router.routeOnDemand(makeOnDemandRouteInput({
    registry: skills,
    config: { ...makeOnDemandRouteInput().config, jevPricing: { inputPerMillion: 2, outputPerMillion: 10 } }
  }));
  snapshot = router.metrics.snapshot();
  assert.deepEqual(snapshot.jevCost, { value: 0.0004, basis: "estimated" });
  assert.match(router.metrics.formatStats(), /estimated/);
  router.metrics.reset();
  assert.equal(router.metrics.snapshot().routes.automatic, 0);
  assert.equal(router.metrics.snapshot().routes["on-demand"], 0);
});

test("session stats split usage, coverage, and errors by route kind", async () => {
  const skillsByRoute = [
    makeSkillRecords(["automatic-a", "automatic-b"]),
    makeSkillRecords(["on-demand"]),
    makeSkillRecords(["dry-run-a", "dry-run-b"])
  ];
  const classifications = [
    classification(skillsByRoute[0]!, [], { coverage: "partial", evaluatedCount: 1, requests: 2, usage: { inputTokens: 100, outputTokens: 20 }, errorCategory: "timeout" }),
    classification(skillsByRoute[1]!, [], { coverage: "complete", evaluatedCount: 1, usage: { inputTokens: 5, outputTokens: 1 } }),
    classification(skillsByRoute[2]!, [], { coverage: "none", evaluatedCount: 0, requests: 0, usage: {}, errorCategory: "authentication" })
  ];
  let call = 0;
  const usage: Usage = {
    input: 7,
    output: 3,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 10,
    cost: { input: 0.01, output: 0.02, cacheRead: 0, cacheWrite: 0, total: 0.03 }
  };
  const router = createRouter({
    classifier: async () => classifications[call++]!,
    interpreter: async () => ({ task: "stats task", fallbackUsed: false, attempts: 1, latencyMs: 4, usage }),
    readFile: async () => "body"
  });

  await router.routeAutomatic(makeAutomaticRouteInput({ registry: skillsByRoute[0]! }));
  await router.routeOnDemand(makeOnDemandRouteInput({ registry: skillsByRoute[1]! }));
  await router.routeDryRun(makeAutomaticRouteInput({ registry: skillsByRoute[2]! }));

  const lines = router.metrics.formatStats().split("\n");
  const lineFor = (kind: string) => lines.find(line => line.startsWith(`${kind}:`)) ?? "";
  assert.match(lineFor("automatic"), /100\/20 tokens/);
  assert.match(lineFor("automatic"), /candidates\/evaluated 2\/1/);
  assert.match(lineFor("automatic"), /coverage complete 0, partial 1, none 0/);
  assert.match(lineFor("automatic"), /errors timeout 1/);
  assert.match(lineFor("on-demand"), /5\/1 tokens/);
  assert.match(lineFor("on-demand"), /coverage complete 1, partial 0, none 0/);
  assert.match(lineFor("on-demand"), /errors none/);
  assert.match(lineFor("dry-run"), /unavailable tokens/);
  assert.match(lineFor("dry-run"), /coverage complete 0, partial 0, none 1/);
  assert.match(lineFor("dry-run"), /errors authentication 1/);
});

test("route details retain Jev selections when loading skips one file", async () => {
  const skills = makeSkillRecords(["unreadable", "readable"]);
  const router = createRouter({
    classifier: async input => classification(input.skills, ["unreadable", "readable"]),
    interpreter: interpreted,
    readFile: async path => {
      if (path === skills[0]!.filePath) throw new Error("not available");
      return "readable instructions";
    }
  });
  const result = await router.routeOnDemand(makeOnDemandRouteInput({ registry: skills }));
  assert.deepEqual(result.details.selected.map(skill => skill.name), ["unreadable", "readable"]);
  assert.deepEqual(result.details.suppliedSkills, ["readable"]);
  assert.deepEqual(result.details.skippedSkills, ["unreadable"]);
  assert.deepEqual(router.metrics.snapshot().selectedNames, ["unreadable", "readable"]);
});

test("loader escapes skill name and trusted path in wrapper attributes", async () => {
  const original = makeSkillRecords(["attribute-skill"])[0]!;
  const skill = { ...original, name: 'name" & <x>', filePath: "C:/trusted/a&b/SKILL.md" };
  const result = await loadSkills({
    selected: [{ skill, probability: 0.9 }],
    registry: new Map([[skill.name, skill]]),
    readFile: async () => "body",
    maxSkillChars: 100,
    maxLoadedChars: 1000,
    source: "on-demand"
  });
  assert.match(result.content, /name="name&quot; &amp; &lt;x&gt;"/);
  assert.match(result.content, /path="C:\/trusted\/a&amp;b\/SKILL\.md"/);
});

test("automatic routing falls back to bounded context when Luna throws", async () => {
  const skills = makeSkillRecords(["fallback-skill"]);
  let classifiedTask = "";
  const router = createRouter({
    classifier: async input => {
      classifiedTask = input.task;
      return classification(input.skills, []);
    },
    interpreter: async () => { throw new Error("sensitive provider detail"); },
    readFile: async () => "body"
  });
  const routeInput = makeAutomaticRouteInput({ registry: skills, context: "bounded context" });
  const result = await router.routeAutomatic(routeInput);
  assert.equal(classifiedTask, "bounded context");
  assert.equal(result.details.interpreterFallback, true);
  assert.equal(result.details.errorCategory, "provider");
  assert.equal(result.message, undefined);
  assert.ok(!JSON.stringify(result.details).includes("sensitive provider detail"));
});

test("loader deduplicates repeated selected skills", async () => {
  const skill = makeSkillRecords(["repeated-skill"])[0]!;
  let reads = 0;
  const result = await loadSkills({
    selected: [{ skill, probability: 0.9 }, { skill, probability: 0.8 }],
    registry: new Map([[skill.name, skill]]),
    readFile: async () => { reads++; return "one copy"; },
    maxSkillChars: 100,
    maxLoadedChars: 2000,
    source: "on-demand"
  });
  assert.equal(reads, 1);
  assert.deepEqual(result.suppliedSkills, ["repeated-skill"]);
  assert.equal(result.content.match(/<skill name="repeated-skill"/g)?.length, 1);
});

test("metrics omit Jev estimates when the provider omits token counts", async () => {
  const jev = fakeJev(({ questions }) => ({
    answers: Object.fromEntries(Object.keys(questions).map(key => [key, { noul: 0.9 }])),
    model: "jev-latest"
  }));
  const skill = makeSkillRecords(["unmetered-skill"])[0]!;
  const router = createRouter({
    classifier: input => classifySkills({
      client: jev,
      task: input.task,
      skills: input.skills,
      threshold: input.config.threshold,
      topK: input.config.topK,
      model: input.config.jevModel,
      timeoutMs: input.config.jevTimeoutMs,
      chunkSize: input.config.jevChunkSize,
      ...(input.signal === undefined ? {} : { signal: input.signal })
    }),
    interpreter: interpreted,
    readFile: async () => "body"
  });
  const result = await router.routeOnDemand(makeOnDemandRouteInput({
    registry: [skill],
    config: { ...makeOnDemandRouteInput().config, jevPricing: { inputPerMillion: 2, outputPerMillion: 10 } }
  }));
  assert.deepEqual(result.classification?.usage, {});
  assert.equal(router.metrics.snapshot().jevCost, undefined);
  assert.deepEqual(router.metrics.snapshot().jevTokens, {});
});

test("session Jev estimates are omitted if any priced route lacks token counts", async () => {
  const skill = makeSkillRecords(["incomplete-cost-skill"])[0]!;
  const pricing = { inputPerMillion: 2, outputPerMillion: 10 };
  let routeCount = 0;
  const router = createRouter({
    classifier: async input => classification(input.skills, [], {
      usage: routeCount++ === 0 ? { inputTokens: 100, outputTokens: 20 } : {}
    }),
    interpreter: interpreted,
    readFile: async () => "body"
  });
  const input = () => makeOnDemandRouteInput({
    registry: [skill],
    config: { ...makeOnDemandRouteInput().config, jevPricing: pricing }
  });
  await router.routeOnDemand(input());
  assert.deepEqual(router.metrics.snapshot().jevCost, { value: 0.0004, basis: "estimated" });
  await router.routeOnDemand(input());
  assert.equal(router.metrics.snapshot().jevCost, undefined);
});

test("loader stops before the combined size limit and reports later skills", async () => {
  const skills = makeSkillRecords(["first", "second"]);
  const result = await loadSkills({
    selected: skills.map(skill => ({ skill, probability: 0.9 })),
    registry: new Map(skills.map(skill => [skill.name, skill])),
    readFile: async () => "body",
    maxSkillChars: 100,
    maxLoadedChars: 400,
    source: "on-demand"
  });
  assert.deepEqual(result.suppliedSkills, ["first"]);
  assert.deepEqual(result.skippedSkills, ["second"]);
  assert.ok(Array.from(result.content).length <= 400);
});
