import type { Api, AssistantMessage, Context, Model, SimpleStreamOptions, Usage } from "@earendil-works/pi-ai";

const SYSTEM_PROMPT = "Summarize the CURRENT user's task as JSON with a required task string and optional priority string. Preserve the requested action, relevant constraints, and any explicitly emphasized goal or requirement, regardless of subject. Set priority only when the user clearly emphasizes one; quote its substance without adding inferred priorities. Do not name or recommend skills.";
const MAX_TASK_CHARS = 1000;
const MAX_PRIORITY_CHARS = 300;
const MAX_OUTPUT_TOKENS = 256;

type InterpreterErrorCategory = "model-unavailable" | "timeout" | "cancelled" | "malformed" | "provider";

export type MeasuredPiUsage = Usage;

export interface InterpreterRegistry {
  getAvailable(): readonly Model<Api>[];
  streamSimple(model: Model<Api>, context: Context, options?: SimpleStreamOptions): { result(): Promise<AssistantMessage> };
}

export interface InterpretationResult {
  task: string;
  domain?: string;
  priority?: string;
  fallbackUsed: boolean;
  attempts: number;
  latencyMs: number;
  usage?: MeasuredPiUsage;
  errorCategory?: InterpreterErrorCategory;
}

export interface InterpretTaskInput {
  registry: InterpreterRegistry;
  modelRef: string;
  context: string;
  timeoutMs: number;
  signal?: AbortSignal;
}

class InterpreterFailure extends Error {
  constructor(readonly category: InterpreterErrorCategory) {
    super(category);
  }
}

function parseInterpretation(text: string): { task: string; domain?: string; priority?: string } | undefined {
  const trimmed = text.trim();
  const fence = /^```(?:json)?\s*\n?([\s\S]*?)\n?```$/i.exec(trimmed);
  const json = fence?.[1] ?? trimmed;

  try {
    const parsed: unknown = JSON.parse(json);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
    const taskValue = (parsed as { task?: unknown }).task;
    if (typeof taskValue !== "string" || !taskValue.trim()) return undefined;
    const task = Array.from(taskValue.trim()).slice(0, MAX_TASK_CHARS).join("");
    const domainValue = (parsed as { domain?: unknown }).domain;
    const priorityValue = (parsed as { priority?: unknown }).priority;
    const result = typeof domainValue === "string" && domainValue.trim()
      ? { task, domain: domainValue.trim() }
      : { task };
    return typeof priorityValue === "string" && priorityValue.trim()
      ? { ...result, priority: Array.from(priorityValue.trim()).slice(0, MAX_PRIORITY_CHARS).join("") }
      : result;
  } catch {
    return undefined;
  }
}

function textFrom(message: AssistantMessage): string {
  return message.content
    .filter((block): block is Extract<AssistantMessage["content"][number], { type: "text" }> => block.type === "text")
    .map(block => block.text)
    .join("");
}

function makePromptContext(content: string): Context {
  return {
    systemPrompt: SYSTEM_PROMPT,
    messages: [{ role: "user", content, timestamp: Date.now() }]
  };
}

function addUsage(total: Usage | undefined, next: Usage | undefined): Usage | undefined {
  if (!next) return total;
  if (!total) return { ...next, cost: { ...next.cost } };
  return {
    input: total.input + next.input,
    output: total.output + next.output,
    cacheRead: total.cacheRead + next.cacheRead,
    cacheWrite: total.cacheWrite + next.cacheWrite,
    ...(total.reasoning === undefined && next.reasoning === undefined
      ? {}
      : { reasoning: (total.reasoning ?? 0) + (next.reasoning ?? 0) }),
    totalTokens: total.totalTokens + next.totalTokens,
    cost: {
      input: total.cost.input + next.cost.input,
      output: total.cost.output + next.cost.output,
      cacheRead: total.cost.cacheRead + next.cost.cacheRead,
      cacheWrite: total.cost.cacheWrite + next.cost.cacheWrite,
      total: total.cost.total + next.cost.total
    }
  };
}

export async function interpretTask(input: InterpretTaskInput): Promise<InterpretationResult> {
  const startedAt = Date.now();
  let attempts = 0;
  let usage: Usage | undefined;
  const fallback = (errorCategory: InterpreterErrorCategory): InterpretationResult => ({
    task: input.context,
    fallbackUsed: true,
    attempts,
    latencyMs: Date.now() - startedAt,
    ...(usage ? { usage } : {}),
    errorCategory
  });

  if (input.signal?.aborted) return fallback("cancelled");

  const separator = input.modelRef.indexOf("/");
  const provider = separator < 1 ? "" : input.modelRef.slice(0, separator);
  const modelId = separator < 1 ? "" : input.modelRef.slice(separator + 1);
  let model: Model<Api> | undefined;
  try {
    if (provider && modelId) {
      const matches = input.registry.getAvailable().filter(candidate => candidate.provider === provider && candidate.id === modelId);
      if (matches.length === 1) model = matches[0];
    }
  } catch {
    return fallback("provider");
  }
  if (!model) return fallback("model-unavailable");

  const controller = new AbortController();
  let timeoutExpired = false;
  let rejectAbort!: (reason: InterpreterFailure) => void;
  const abortPromise = new Promise<never>((_resolve, reject) => {
    rejectAbort = reject;
  });
  const onCallerAbort = () => {
    controller.abort(input.signal?.reason);
    rejectAbort(new InterpreterFailure("cancelled"));
  };
  if (input.signal) input.signal.addEventListener("abort", onCallerAbort, { once: true });
  const timeout = setTimeout(() => {
    timeoutExpired = true;
    const failure = new InterpreterFailure("timeout");
    controller.abort(failure);
    rejectAbort(failure);
  }, input.timeoutMs);

  let repairText: string | undefined;
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      if (controller.signal.aborted) return fallback(timeoutExpired ? "timeout" : "cancelled");
      const prompt = repairText === undefined
        ? input.context
        : `Repair the invalid output and return valid JSON only. Invalid output:\n${repairText}`;
      attempts++;
      let message: AssistantMessage;
      try {
        const stream = input.registry.streamSimple(
          model,
          makePromptContext(prompt),
          { reasoning: "low", maxTokens: MAX_OUTPUT_TOKENS, signal: controller.signal }
        );
        message = await Promise.race([stream.result(), abortPromise]);
      } catch (error) {
        if (error instanceof InterpreterFailure) return fallback(error.category);
        if (timeoutExpired) return fallback("timeout");
        if (input.signal?.aborted) return fallback("cancelled");
        return fallback("provider");
      }

      usage = addUsage(usage, message.usage);
      if (message.stopReason === "error") return fallback("provider");
      if (message.stopReason === "aborted") return fallback(timeoutExpired ? "timeout" : "cancelled");

      const responseText = textFrom(message);
      const parsed = parseInterpretation(responseText);
      if (parsed) {
        return {
          ...parsed,
          fallbackUsed: false,
          attempts,
          latencyMs: Date.now() - startedAt,
          ...(usage === undefined ? {} : { usage })
        };
      }
      if (attempt === 1) return fallback("malformed");
      repairText = responseText;
    }
    return fallback("malformed");
  } finally {
    clearTimeout(timeout);
    input.signal?.removeEventListener("abort", onCallerAbort);
  }
}
