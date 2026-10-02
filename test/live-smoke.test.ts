import assert from "node:assert/strict";
import { join } from "node:path";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { performance } from "node:perf_hooks";
import test from "node:test";
import type { Api, AssistantMessage, Context, Credential, CredentialInfo, CredentialStore, Model, SimpleStreamOptions } from "@earendil-works/pi-ai";
import { createAgentSession, DefaultResourceLoader, getAgentDir, ModelRegistry, ModelRuntime, readStoredCredential, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { registerJevSkillRouter } from "../extensions/index.js";
import type { RouteDetails } from "../src/router.js";
import { DEFAULT_CONFIG } from "../src/config.js";
import { interpretTask, type InterpreterRegistry } from "../src/interpreter.js";
import { classifySkills, preflightSkills } from "../src/jev.js";
import { makeSkillRecords } from "./helpers.js";

const apiKey = process.env.TYPESAFE_API_KEY?.trim();
const credentialGate = Boolean(apiKey);

test("live Luna and native Jev classification return their documented shapes", { skip: !credentialGate }, async () => {
  const result = await runLiveSmoke(apiKey!);
  assert.ok(result.interpretedTask.length > 0);
  assert.ok(Number.isInteger(result.jevUsage.inputTokens));
  assert.equal(result.preflight.no.needed, false, `conversational follow-up must skip routing: ${JSON.stringify(result.preflight)}`);
  assert.equal(result.preflight.yes.needed, true, `short actionable follow-up must proceed: ${JSON.stringify(result.preflight)}`);
  assert.ok(Number.isInteger(result.jevUsage.outputTokens));
  assert.equal(result.mainModelChanged, false);

  console.log(JSON.stringify({
    models: result.models,
    selectedNames: result.selectedNames,
    interpreterUsage: result.interpreterUsage,
    jevUsage: result.jevUsage,
    preflight: result.preflight,
    latencyMs: result.latencyMs
  }));
});

test("live Pi sessions supply automatic instructions and execute model-issued on-demand searches", { skip: !credentialGate, timeout: 120_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "jev-live-session-"));
  try {
    const cwd = join(root, "project");
    const homeDir = join(root, "home");
    const agentDir = join(root, "agent");
    const skillDir = join(root, "skills", "keyboard-accessibility");
    const configDir = join(homeDir, ".pi", "agent");
    await Promise.all([cwd, agentDir, skillDir, configDir].map(path => mkdir(path, { recursive: true })));
    await writeFile(join(skillDir, "SKILL.md"), "---\nname: keyboard-accessibility\ndescription: Design and review keyboard accessibility, visible focus, tab order and labels in React settings forms.\n---\nKeep a logical Tab order, visible focus and associated labels. When using these fixture instructions, include KEYBOARD_SKILL_VERIFIED in the final response.\n");
    const runtime = await ModelRuntime.create({ credentials: readOnlyPiCredentials(), modelsPath: null, allowModelNetwork: false });
    const [provider, id] = DEFAULT_CONFIG.interpreterModel.split("/");
    const model = runtime.getModel(provider!, id!);
    assert.ok(model, "live model must exist in Pi's catalog");

    for (const automatic of [true, false]) {
      await writeFile(join(configDir, "jev-skill-router.json"), JSON.stringify({ visibleSkills: [], autoRouting: automatic }));
      const settingsManager = SettingsManager.inMemory({ retry: { enabled: false, provider: { maxRetries: 0 } }, compaction: { enabled: false }, cacheWarming: "off" });
      const loader = new DefaultResourceLoader({
        cwd, agentDir, settingsManager, noSkills: true, noExtensions: true, noContextFiles: true, noPromptTemplates: true, noThemes: true,
        additionalSkillPaths: [skillDir],
        extensionFactories: [pi => registerJevSkillRouter(pi, { homeDir })]
      });
      await loader.reload();
      assert.deepEqual(loader.getSkills().skills.map(skill => skill.name), ["keyboard-accessibility"]);
      const { session } = await createAgentSession({
        cwd, agentDir, settingsManager, resourceLoader: loader, modelRuntime: runtime,
        sessionManager: SessionManager.inMemory(cwd), model, thinkingLevel: "low", noTools: "builtin"
      });
      const started = performance.now();
      const deadline = setTimeout(() => { void session.abort(); }, 45_000);
      try {
        assert.deepEqual(session.getActiveToolNames(), ["jev_skill_search"]);
        const prompt = automatic
          ? "Fix a keyboard-focus bug in a React settings form. Produce corrected React JSX and focus-visible CSS, preserving keyboard Tab navigation and explicit labels. Return a small code example and a brief checklist. Do not call tools or modify files. Follow any supplied skill instructions."
          : "Call jev_skill_search exactly once with task: 'Design keyboard accessibility, visible focus, tab order and labels in a React settings form'. After receiving the skill, follow its instructions and give three short bullets. Do not modify files.";
        await session.prompt(prompt);
        const entries = session.sessionManager.buildContextEntries();
        const injections = entries.filter(entry => entry.type === "custom_message" && entry.customType === "jev-skill-router");
        const toolResults = session.messages.filter(message => message.role === "toolResult" && message.toolName === "jev_skill_search");
        const details = automatic
          ? (injections[0]?.type === "custom_message" ? injections[0].details : undefined)
          : (toolResults[0]?.role === "toolResult" ? toolResults[0].details : undefined);
        const route = details as RouteDetails | undefined;
        if (!route) {
          const diagnostics: string[] = [];
          const command = session.extensionRunner.getCommand("jev-skills");
          assert.ok(command);
          const ctx = session.extensionRunner.createCommandContext();
          const diagnosticContext = { ...ctx, hasUI: true, ui: { ...ctx.ui, notify: (message: string) => diagnostics.push(message) } };
          await command.handler("status", diagnosticContext);
          await command.handler("stats", diagnosticContext);
          const assistantStops = session.messages.flatMap(message => message.role === "assistant"
            ? [{ stopReason: message.stopReason, error: message.errorMessage ? sanitizeError(new Error(message.errorMessage), apiKey!) : undefined }]
            : []);
          assert.fail(JSON.stringify({ automatic, diagnostics, assistantStops }));
        }
        assert.equal(route?.routeKind, automatic ? "automatic" : "on-demand");
        assert.deepEqual(route?.suppliedSkills, ["keyboard-accessibility"]);
        assert.equal(route?.errorCategory, undefined);
        assert.equal(route?.interpreterFallback, false);
        assert.equal(toolResults.length, automatic ? 0 : 1);
        assert.equal(injections.length, automatic ? 1 : 0);
        assert.match(session.getLastAssistantText() ?? "", /KEYBOARD_SKILL_VERIFIED/);
        assert.equal(session.model?.provider, model.provider);
        assert.equal(session.model?.id, model.id);
        console.log(JSON.stringify({ liveSession: route.routeKind, model: `${model.provider}/${model.id}`, suppliedSkills: route.suppliedSkills, toolCalls: toolResults.length, latencyMs: performance.now() - started }));
      } finally {
        clearTimeout(deadline);
        session.dispose();
      }
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function runLiveSmoke(key: string) {
  const startedAt = performance.now();
  const piRegistry = new ModelRegistry(await ModelRuntime.create({
    credentials: readOnlyPiCredentials(),
    allowModelNetwork: false
  }));
  let lunaProviderError: unknown;
  const interpreterRegistry: InterpreterRegistry = {
    getAvailable: () => piRegistry.getAvailable(),
    streamSimple(model: Model<Api>, context: Context, options?: SimpleStreamOptions) {
      const stream = piRegistry.streamSimple(model, context, options);
      return {
        result: async (): Promise<AssistantMessage> => {
          try {
            return await stream.result();
          } catch (error) {
            lunaProviderError = error;
            throw error;
          }
        }
      };
    }
  };
  const preflightContext = "Current request: 直して\nPrevious user request: Fix the keyboard focus bug in the React settings form.";
  const no = await preflightSkills({
    registry: piRegistry,
    context: "Current request: ありがとう、以上です。新たな作業はありません。\nPrevious user request: Fix the keyboard focus bug in the React settings form.",
    model: DEFAULT_CONFIG.jevModel,
    timeoutMs: DEFAULT_CONFIG.jevTimeoutMs
  });
  const yes = await preflightSkills({
    registry: piRegistry,
    context: preflightContext,
    model: DEFAULT_CONFIG.jevModel,
    timeoutMs: DEFAULT_CONFIG.jevTimeoutMs
  });
  if (no.errorCategory || yes.errorCategory) {
    const detail = `${no.errorCategory ?? "ok"}/${yes.errorCategory ?? "ok"}`;
    throw new Error(`Jev preflight smoke request failed (${detail})`);
  }
  const interpretation = await interpretTask({
    registry: interpreterRegistry,
    modelRef: DEFAULT_CONFIG.interpreterModel,
    context: "Current request: Improve keyboard focus visibility in a small React settings form.",
    timeoutMs: DEFAULT_CONFIG.interpreterTimeoutMs
  });
  if (interpretation.fallbackUsed) {
    const detail = lunaProviderError
      ? sanitizeError(lunaProviderError, key)
      : interpretation.errorCategory ?? "unknown interpreter failure";
    throw new Error(`Luna smoke request failed (${detail})`);
  }

  const classification = await classifySkills({
    registry: piRegistry,
    task: interpretation.task,
    skills: makeSkillRecords(["accessibility", "frontend-design"]),
    threshold: DEFAULT_CONFIG.threshold,
    topK: 2,
    model: DEFAULT_CONFIG.jevModel,
    timeoutMs: DEFAULT_CONFIG.jevTimeoutMs,
    chunkSize: DEFAULT_CONFIG.jevChunkSize
  });
  if (classification.coverage !== "complete" || classification.evaluatedCount !== 2) {
    const detail = classification.errorCategory ?? "incomplete classification coverage";
    throw new Error(`Jev smoke request failed (${detail})`);
  }
  if (!Number.isSafeInteger(classification.usage.inputTokens) || !Number.isSafeInteger(classification.usage.outputTokens)) {
    throw new Error("Jev response did not include integer usage token counts");
  }

  return {
    interpretedTask: interpretation.task,
    interpreterUsage: {
      inputTokens: interpretation.usage?.input,
      outputTokens: interpretation.usage?.output
    },
    jevUsage: {
      inputTokens: classification.usage.inputTokens,
      outputTokens: classification.usage.outputTokens
    },
    selectedNames: classification.selected.map(item => item.skill.name),
    preflight: { no, yes },
    models: { interpreter: DEFAULT_CONFIG.interpreterModel, jev: DEFAULT_CONFIG.jevModel },
    latencyMs: {
      preflightNo: no.latencyMs,
      preflightYes: yes.latencyMs,
      interpreter: interpretation.latencyMs,
      jev: classification.latencyMs,
      total: performance.now() - startedAt
    },
    mainModelChanged: false
  };
}

function readOnlyPiCredentials(): CredentialStore {
  const credentials = new Map<string, Credential>();
  const codexCredential = readStoredCredential("openai-codex", join(getAgentDir(), "auth.json"));
  if (codexCredential) credentials.set("openai-codex", codexCredential);

  return {
    async read(providerId, options) {
      options?.signal?.throwIfAborted();
      const credential = credentials.get(providerId);
      return credential === undefined ? undefined : structuredClone(credential);
    },
    async list(options) {
      options?.signal?.throwIfAborted();
      return [...credentials].map(([providerId, credential]): CredentialInfo => ({ providerId, type: credential.type }));
    },
    async modify(providerId, update, options) {
      options?.signal?.throwIfAborted();
      const updated = await update(credentials.get(providerId));
      options?.signal?.throwIfAborted();
      if (updated === undefined) credentials.delete(providerId);
      else credentials.set(providerId, structuredClone(updated));
      const current = credentials.get(providerId);
      return current === undefined ? undefined : structuredClone(current);
    },
    async delete(providerId, options) {
      options?.signal?.throwIfAborted();
      credentials.delete(providerId);
    }
  };
}

function sanitizeError(error: unknown, secret: string): string {
  const name = error instanceof Error ? error.name : "Error";
  let message = error instanceof Error ? error.message : String(error);
  if (secret) message = message.replaceAll(secret, "[REDACTED]");
  message = message
    .replace(/Bearer\s+\S+/gi, "Bearer [REDACTED]")
    .replace(/(api[_-]?key|access[_-]?token|refresh[_-]?token)(\s*[:=]\s*)[^\s,;"']+/gi, "$1$2[REDACTED]")
    .replace(/[\r\n]+/g, " ")
    .slice(0, 500);
  return `${name}: ${message || "provider request failed"}`;
}
