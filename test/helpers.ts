import { createAssistantMessageEventStream, type Api, type AssistantMessage, type Context, type Model, type SimpleStreamOptions, type Usage } from "@earendil-works/pi-ai";
import type { Skill } from "@earendil-works/pi-coding-agent";
import type { JevClientLike, JevRequest, JevRequestOptions } from "../src/jev.js";
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

export function fakeJev(handler: (request: JevRequest, call: number, options?: JevRequestOptions) => unknown | Promise<unknown>) {
  const requests: JevRequest[] = [];
  const calls: Array<{ request: JevRequest; options?: JevRequestOptions }> = [];
  const client: JevClientLike = {
    async systemOne(request, options) {
      requests.push(request);
      calls.push({ request, ...(options === undefined ? {} : { options }) });
      return handler(request, requests.length - 1, options);
    }
  };
  return { ...client, requests, calls };
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
