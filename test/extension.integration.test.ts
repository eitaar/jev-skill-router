import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type ExtensionAPI,
  type SlashCommandInfo
} from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { APITimeoutError } from "@typesafe-ai/sdk";
import { registerJevSkillRouter } from "../extensions/index.js";
import type { JevClientLike, JevRequest } from "../src/jev.js";
import type { RouteMessage } from "../src/router.js";

interface HarnessOptions {
  skillCount?: number;
  visibleCount?: number;
  manualOnly?: readonly number[];
  autoRouting?: boolean;
  interpreterModel?: string;
  jevClient?: JevClientLike;
  jevFailure?: "malformed" | "timeout";
  withClient?: boolean;
}

interface Harness {
  cwd: string;
  skills: ReturnType<DefaultResourceLoader["getSkills"]>["skills"];
  session: Awaited<ReturnType<typeof createAgentSession>>["session"];
  requests: JevRequest[];
  interpreterCalls: Array<{ model: string; reasoning: string | undefined }>;
  piCommands: SlashCommandInfo[];
}

function fakeJev(requests: JevRequest[], failure?: HarnessOptions["jevFailure"]): JevClientLike {
  return {
    async systemOne(request) {
      requests.push(request);
      if (failure === "timeout") throw new APITimeoutError(10);
      if (failure === "malformed") return { answers: {}, usage: { input_tokens: 1, output_tokens: 1 } };
      return {
        answers: Object.fromEntries(Object.keys(request.questions).map((key, index) => [key, {
          type: "noul",
          noul: index === 0 ? 0.99 : 0.1
        }])),
        usage: { input_tokens: 20, output_tokens: 4 }
      };
    }
  };
}

async function makeHarness(t: test.TestContext, options: HarnessOptions = {}): Promise<Harness> {
  const root = await mkdtemp(join(tmpdir(), "jev-router-pi-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cwd = join(root, "project");
  const homeDir = join(root, "home");
  const agentDir = join(root, "agent");
  const skillsDir = join(root, "skills");
  const configDir = join(homeDir, ".pi", "agent");
  await Promise.all([
    mkdir(cwd, { recursive: true }),
    mkdir(configDir, { recursive: true }),
    mkdir(skillsDir, { recursive: true })
  ]);

  const skillCount = options.skillCount ?? 134;
  const visibleCount = options.visibleCount ?? 10;
  const skillNames = Array.from({ length: skillCount }, (_, index) => `hidden-${String(index).padStart(3, "0")}`);
  await Promise.all(skillNames.map(async name => {
    const directory = join(skillsDir, name);
    await mkdir(directory, { recursive: true });
    const manual = options.manualOnly?.includes(Number(name.slice(-3))) ? "disable-model-invocation: true\n" : "";
    await writeFile(join(directory, "SKILL.md"), `---\nname: ${name}\ndescription: Instructions for ${name}\n${manual}---\nBody for ${name}: keyboard accessibility and React dashboard guidance.\n`);
  }));
  await writeFile(join(configDir, "jev-skill-router.json"), JSON.stringify({
    visibleSkills: skillNames.slice(0, visibleCount),
    autoRouting: options.autoRouting ?? true,
    interpreterModel: options.interpreterModel ?? "router-test/luna"
  }));

  const interpreterCalls: Array<{ model: string; reasoning: string | undefined }> = [];
  const modelRuntime = await ModelRuntime.create({
    authPath: join(root, "auth.json"),
    modelsPath: null,
    refreshOnCreate: false
  });
  modelRuntime.registerProvider("router-test", {
    api: "openai-completions",
    baseUrl: "https://router-test.invalid",
    apiKey: "test-key",
    models: ["main", "luna"].map(id => ({
      id,
      name: id,
      reasoning: id === "luna",
      input: ["text" as const],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 32_000,
      maxTokens: 2048
    })),
    streamSimple(model, _context, streamOptions) {
      interpreterCalls.push({ model: model.id, reasoning: streamOptions?.reasoning });
      const stream = createAssistantMessageEventStream();
      const response = model.id === "luna" ? '{"task":"Improve keyboard accessibility of the React dashboard"}' : "main response";
      const message = {
        role: "assistant" as const,
        content: [{ type: "text" as const, text: response }],
        api: model.api,
        provider: model.provider,
        model: model.id,
        usage: {
          input: 5,
          output: 4,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 9,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
        },
        stopReason: "stop" as const,
        timestamp: Date.now()
      };
      stream.push({ type: "done", reason: "stop", message });
      return stream;
    }
  });

  const requests: JevRequest[] = [];
  let piCommands: SlashCommandInfo[] = [];
  const settingsManager = SettingsManager.inMemory();
  const resourceLoader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager,
    additionalSkillPaths: [skillsDir],
    noSkills: true,
    noContextFiles: true,
    noPromptTemplates: true,
    noThemes: true,
    extensionFactories: [pi => {
      const recordingApi = new Proxy(pi, {
        get(target, property, receiver) {
          if (property === "getCommands") return () => {
            const commands = Reflect.get(target, property, receiver)() as SlashCommandInfo[];
            piCommands.splice(0, piCommands.length, ...commands);
            return commands;
          };
          return Reflect.get(target, property, receiver);
        }
      }) as ExtensionAPI;
      const jevClient = options.jevClient ?? (options.withClient === false
        ? undefined
        : fakeJev(requests, options.jevFailure));
      registerJevSkillRouter(recordingApi, {
        homeDir,
        ...(jevClient === undefined ? {} : { jevClient })
      });
    }]
  });
  await resourceLoader.reload();
  const sessionManager = SessionManager.inMemory(cwd);
  const mainModel = modelRuntime.getModel("router-test", "main");
  assert.ok(mainModel);
  const { session } = await createAgentSession({
    cwd,
    agentDir,
    resourceLoader,
    sessionManager,
    settingsManager,
    modelRuntime,
    model: mainModel,
    noTools: "builtin"
  });
  t.after(() => session.dispose());
  return {
    cwd,
    skills: resourceLoader.getSkills().skills,
    session,
    requests,
    interpreterCalls,
    piCommands
  };
}

async function beforeAgentStart(harness: Harness, prompt: string) {
  return harness.session.extensionRunner.emitBeforeAgentStart(prompt, undefined, {
    cwd: harness.cwd,
    skills: harness.skills
  });
}

function recordMessage(harness: Harness, message: RouteMessage): string {
  return harness.session.sessionManager.appendCustomMessageEntry(
    message.customType,
    message.content,
    message.display,
    message.details
  );
}

function toolText(result: { content: Array<{ type: string; text?: string }> }): string {
  return result.content.flatMap(block => block.type === "text" && block.text ? [block.text] : []).join("\n");
}

test("Pi filters only the structured skill section, scans all hidden skills, and keeps native commands and model", async t => {
  const harness = await makeHarness(t);
  const mainModelBeforeRoute = harness.session.model;
  const result = await beforeAgentStart(harness, "Improve keyboard accessibility of the dashboard");

  assert.equal(result.systemPromptOptions.skills.length, 10);
  assert.equal(harness.requests[0]?.questions && Object.keys(harness.requests[0].questions).length, 124);
  assert.ok(harness.piCommands.some(command => command.name === "skill:hidden-010" && command.source === "skill"));
  assert.deepEqual(harness.session.model, mainModelBeforeRoute);
  assert.equal(result.messages[0]?.customType, "jev-skill-router");
  assert.equal(harness.interpreterCalls.length, 1);
  assert.equal(harness.interpreterCalls[0]?.reasoning, "low");
});

test("on-demand tool searches Jev directly and returns the matching native skill body", async t => {
  const harness = await makeHarness(t, { autoRouting: false });
  await beforeAgentStart(harness, "");
  const tool = harness.session.getToolDefinition("jev_skill_search");
  assert.ok(tool);
  const result = await tool.execute("test-call", { task: "Improve keyboard accessibility of this React dashboard" } as never, undefined, undefined, harness.session.extensionRunner.createContext());

  assert.equal(harness.interpreterCalls.length, 0);
  assert.equal(Object.keys(harness.requests[0]?.questions ?? {}).length, 124);
  assert.match(toolText(result), /Body for hidden-010: keyboard accessibility/);
  assert.deepEqual((result.details as { suppliedSkills?: string[] } | undefined)?.suppliedSkills ?? [], ["hidden-010"]);
});

test("automatic routing degrades safely for missing Luna, missing TypeSafe credentials, malformed responses, and timeouts", async t => {
  const harness = await makeHarness(t, { skillCount: 12, visibleCount: 1, interpreterModel: "missing/luna" });
  const fallback = await beforeAgentStart(harness, "Choose relevant implementation guidance");
  assert.equal(fallback.systemPromptOptions.skills.length, 1);
  assert.equal(fallback.messages[0]?.customType, "jev-skill-router");
  assert.equal(harness.interpreterCalls.length, 0);

  const withNoClient = await makeHarness(t, { skillCount: 12, visibleCount: 1, withClient: false });
  const apiKey = process.env.TYPESAFE_API_KEY;
  delete process.env.TYPESAFE_API_KEY;
  try {
    const noAuth = await beforeAgentStart(withNoClient, "Choose relevant implementation guidance");
    assert.equal(noAuth.systemPromptOptions.skills.length, 1);
    assert.equal(noAuth.messages.length, 0);
    const tool = withNoClient.session.getToolDefinition("jev_skill_search");
    assert.ok(tool);
    const response = await tool.execute("missing-key", { task: "Search for guidance" } as never, undefined, undefined, withNoClient.session.extensionRunner.createContext());
    assert.match(toolText(response), /authentication/);
    assert.equal((response.details as { errorCategory?: string }).errorCategory, "authentication");
  } finally {
    if (apiKey === undefined) delete process.env.TYPESAFE_API_KEY;
    else process.env.TYPESAFE_API_KEY = apiKey;
  }

  const malformed = await makeHarness(t, { skillCount: 12, visibleCount: 1, jevFailure: "malformed" });
  const noAnswer = await beforeAgentStart(malformed, "Choose relevant implementation guidance");
  assert.equal(noAnswer.systemPromptOptions.skills.length, 1);
  assert.equal(noAnswer.messages.length, 0);

  const timeout = await makeHarness(t, { skillCount: 12, visibleCount: 1, jevFailure: "timeout" });
  const timedOut = await beforeAgentStart(timeout, "Choose relevant implementation guidance");
  assert.equal(timedOut.systemPromptOptions.skills.length, 1);
  assert.equal(timedOut.messages.length, 0);
});

test("native manual-only skills stay off the prompt and automatic scan but remain on-demand", async t => {
  const harness = await makeHarness(t, { skillCount: 12, visibleCount: 1, manualOnly: [1] });
  const automatic = await beforeAgentStart(harness, "Choose relevant implementation guidance");
  assert.equal(automatic.systemPromptOptions.skills.length, 1);
  assert.equal(Object.keys(harness.requests[0]!.questions).length, 10);
  assert.ok(harness.piCommands.some(command => command.name === "skill:hidden-001" && command.source === "skill"));

  const tool = harness.session.getToolDefinition("jev_skill_search");
  assert.ok(tool);
  const result = await tool.execute("manual-only", { task: "Search for accessibility guidance" } as never, undefined, undefined, harness.session.extensionRunner.createContext());
  assert.equal(Object.keys(harness.requests[1]!.questions).length, 11);
  assert.match(toolText(result), /Body for hidden-001: keyboard accessibility/);
});

test("active-branch reconstruction lets branches and compaction remove or retain supplied skills", async t => {
  const harness = await makeHarness(t, { skillCount: 12, visibleCount: 1 });
  const anchorId = harness.session.sessionManager.appendMessage({ role: "user", content: "Start a new implementation task", timestamp: Date.now() });
  const first = await beforeAgentStart(harness, "Choose relevant implementation guidance");
  const firstMessage = first.messages[0] as RouteMessage;
  const injectionId = recordMessage(harness, firstMessage);
  await beforeAgentStart(harness, "Choose relevant implementation guidance");
  assert.equal(Object.keys(harness.requests[1]!.questions).length, 10);

  harness.session.sessionManager.branch(anchorId);
  await beforeAgentStart(harness, "Choose relevant implementation guidance");
  assert.equal(Object.keys(harness.requests[2]!.questions).length, 11);

  harness.session.sessionManager.branch(injectionId);
  harness.session.sessionManager.appendCompaction("summary retaining skill message", injectionId, 1);
  await beforeAgentStart(harness, "Choose relevant implementation guidance");
  assert.equal(Object.keys(harness.requests[3]!.questions).length, 10);

  harness.session.sessionManager.appendCompaction("summary without prior skill message", null, 1);
  await beforeAgentStart(harness, "Choose relevant implementation guidance");
  assert.equal(Object.keys(harness.requests[4]!.questions).length, 11);
});

test("session replacement does not inherit supplied skills from another session", async t => {
  const original = await makeHarness(t, { skillCount: 12, visibleCount: 1, autoRouting: false });
  await beforeAgentStart(original, "");
  original.session.sessionManager.appendCustomMessageEntry("jev-skill-router", "previous injected instructions", false, { suppliedSkills: ["hidden-001"] });

  const replacement = await makeHarness(t, { skillCount: 12, visibleCount: 1, autoRouting: false });
  await beforeAgentStart(replacement, "");
  const tool = replacement.session.getToolDefinition("jev_skill_search");
  assert.ok(tool);
  await tool.execute("replacement", { task: "Search for implementation guidance" } as never, undefined, undefined, replacement.session.extensionRunner.createContext());
  assert.equal(Object.keys(replacement.requests[0]!.questions).length, 11);
});

test("/jev-skills commands work without UI and apply exact session-only overrides", async t => {
  const harness = await makeHarness(t);
  const command = harness.session.extensionRunner.getCommand("jev-skills");
  assert.ok(command);
  const ctx = harness.session.extensionRunner.createCommandContext();

  await command.handler("off", ctx);
  const disabled = await beforeAgentStart(harness, "Choose relevant implementation guidance");
  assert.equal(disabled.systemPromptOptions.skills.length, 10);
  assert.equal(harness.requests.length, 0);

  await command.handler("on invalid", ctx);
  await beforeAgentStart(harness, "Choose relevant implementation guidance");
  assert.equal(harness.requests.length, 0);

  await command.handler("on", ctx);
  const enabled = await beforeAgentStart(harness, "Choose relevant implementation guidance");
  assert.equal(enabled.systemPromptOptions.skills.length, 10);
  assert.equal(harness.requests.length, 1);

  await command.handler("stats", ctx);
  await command.handler("status", ctx);
  await command.handler("debug on", ctx);
  await command.handler("debug off", ctx);
  const entriesBeforeDryRun = harness.session.sessionManager.getEntries().length;
  await command.handler("test Improve keyboard accessibility", ctx);
  assert.equal(harness.session.sessionManager.getEntries().length, entriesBeforeDryRun);

  const notifications: string[] = [];
  const uiCtx = { ...ctx, hasUI: true, ui: { ...ctx.ui, notify: (message: string) => notifications.push(message) } };
  await command.handler("debug on", uiCtx);
  await command.handler("test Improve keyboard accessibility", uiCtx);
  assert.ok(notifications.some(message => message.includes("Jev dry-run:")));
  assert.ok(notifications.some(message => message.includes("Candidates/evaluated:")));
  assert.equal(harness.session.sessionManager.getEntries().length, entriesBeforeDryRun);
  await command.handler("debug off", uiCtx);
});

test("cancelled on-demand searches return normally without calling Jev", async t => {
  const harness = await makeHarness(t, { skillCount: 12, visibleCount: 1, autoRouting: false });
  await beforeAgentStart(harness, "");
  const tool = harness.session.getToolDefinition("jev_skill_search");
  assert.ok(tool);
  const controller = new AbortController();
  controller.abort();
  const result = await tool.execute("cancelled", { task: "Search for skills" } as never, controller.signal, undefined, harness.session.extensionRunner.createContext());
  assert.equal(harness.requests.length, 0);
  assert.match(toolText(result), /could not complete \(cancelled\)/);
});
