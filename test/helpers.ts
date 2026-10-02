import { createAssistantMessageEventStream, type Api, type AssistantMessage, type ClassifierApi, type ClassifierContext, type ClassifierModel, type ClassifierResult, type Context, type Model, type ModelsClassifierOptions, type SimpleStreamOptions, type Usage } from "@earendil-works/pi-ai";
import type { Skill } from "@earendil-works/pi-coding-agent";
import type { JevRegistry } from "../src/jev.js";
import type { SkillRecord } from "../src/registry.js";
import { DEFAULT_CONFIG } from "../src/config.js";
import type { RouterConfig } from "../src/types.js";

const lunaModel: Model<Api> = {
  id: "gpt-6-luna",
  name: "GPT-6 Luna",
  api: "openai-codex-responses",
  provider: "openai-codex",
  baseUrl: "https://example.invalid",
  reasoning: true,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128_000,
  maxTokens: 4096
};

export function fakeAssistant(text: string, options: { usage?: Usage } = {}): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: lunaModel.api,
    provider: lunaModel.provider,
    model: lunaModel.id,
    usage: options.usage ?? {
      input: 5,
      output: 4,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 9,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
    },
    stopReason: "stop",
    timestamp: 0
  };
}

export function fakeInterpreterRegistry(responses: readonly AssistantMessage[]) {
  const calls: Array<{ model: Model<Api>; context: Context; options: SimpleStreamOptions }> = [];
  let responseIndex = 0;
  return {
    calls,
    getAvailable: () => [lunaModel],
    streamSimple(model: Model<Api>, context: Context, options: SimpleStreamOptions = {}) {
      calls.push({ model, context, options });
      const message = responses[responseIndex++] ?? fakeAssistant("unexpected extra interpreter request");
      const stream = createAssistantMessageEventStream();
      stream.push({ type: "done", reason: "stop", message });
      return stream;
    }
  };
}

export const jevModel: ClassifierModel<ClassifierApi> = {
  type: "classifier", id: "jev-latest", name: "Jev", provider: "typesafe", api: "typesafe-system-one",
  baseUrl: "https://example.invalid", input: ["text"], contextWindow: 32_000,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
};

export function fakeUsage(input: number, output: number): Usage {
  return { input, output, cacheRead: 0, cacheWrite: 0, totalTokens: input + output, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
}

export function fakeClassification(result: Partial<ClassifierResult> = {}): ClassifierResult {
  return { api: jevModel.api, provider: jevModel.provider, model: jevModel.id, answers: {}, stopReason: "stop", timestamp: 0, ...result };
}

export function fakeJev(handler: (request: ClassifierContext, call: number, options?: ModelsClassifierOptions) => Partial<ClassifierResult> | Promise<Partial<ClassifierResult>>) {
  const requests: ClassifierContext[] = [];
  const calls: Array<{ model: ClassifierModel<ClassifierApi>; request: ClassifierContext; options?: ModelsClassifierOptions }> = [];
  const registry: JevRegistry = {
    findOfType: (_type, provider, id) => provider === jevModel.provider && id === jevModel.id ? jevModel : undefined,
    async classify(model, request, options) {
      requests.push(request);
      calls.push({ model, request, ...(options === undefined ? {} : { options }) });
      return fakeClassification(await handler(request, requests.length - 1, options));
    }
  };
  return { ...registry, requests, calls };
}

export function makeSkillRecords(names: readonly string[]): SkillRecord[] {
  return names.map(name => {
    const baseDir = `C:/skills/${name}`;
    const filePath = `${baseDir}/SKILL.md`;
    return {
      name,
      description: `Instructions for ${name}`,
      filePath,
      baseDir,
      disableModelInvocation: false,
      sourceInfo: { path: filePath, source: "local", scope: "user", origin: "top-level", baseDir }
    };
  });
}

interface AutomaticRouteFixture {
  config: RouterConfig;
  registry: readonly SkillRecord[];
  visible: ReadonlySet<string>;
  supplied: ReadonlySet<string>;
  currentPrompt: string;
  context: string;
  signal: AbortSignal;
}

interface OnDemandRouteFixture {
  config: RouterConfig;
  registry: readonly SkillRecord[];
  visible: ReadonlySet<string>;
  supplied: ReadonlySet<string>;
  task: string;
  signal: AbortSignal;
}

export function makeAutomaticRouteInput(overrides: Partial<AutomaticRouteFixture> = {}): AutomaticRouteFixture {
  return {
    config: { ...DEFAULT_CONFIG, visibleSkills: [] },
    registry: [],
    visible: new Set(),
    supplied: new Set(),
    currentPrompt: "Complete the requested task",
    context: "Current request: Complete the requested task",
    signal: new AbortController().signal,
    ...overrides
  };
}

export function makeOnDemandRouteInput(overrides: Partial<OnDemandRouteFixture> = {}): OnDemandRouteFixture {
  return {
    config: { ...DEFAULT_CONFIG, visibleSkills: [] },
    registry: [],
    visible: new Set(),
    supplied: new Set(),
    task: "Complete the requested task",
    signal: new AbortController().signal,
    ...overrides
  };
}

export function makeSkills(count: number, options: { manualOnly?: readonly number[] } = {}): Skill[] {
  return Array.from({ length: count }, (_, index) => {
    const name = `skill-${String(index).padStart(3, "0")}`;
    const baseDir = `C:/skills/${name}`;
    const filePath = `${baseDir}/SKILL.md`;
    return {
      name,
      description: `Instructions for ${name}`,
      filePath,
      baseDir,
      disableModelInvocation: options.manualOnly?.includes(index) ?? false,
      sourceInfo: {
        path: filePath,
        source: "local",
        scope: "user",
        origin: "top-level",
        baseDir
      }
    };
  });
}
