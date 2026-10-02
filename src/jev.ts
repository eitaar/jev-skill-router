import type { ClassifierApi, ClassifierContext, ClassifierModel, ClassifierResult, ModelsClassifierOptions } from "@earendil-works/pi-ai";
import { performance } from "node:perf_hooks";
import type { SkillRecord } from "./registry.js";

export interface JevRegistry {
  findOfType(type: "classifier", provider: string, modelId: string): ClassifierModel<ClassifierApi> | undefined;
  classify(model: ClassifierModel<ClassifierApi>, context: ClassifierContext, options?: ModelsClassifierOptions): Promise<ClassifierResult>;
}

export interface SkillProbability {
  skill: SkillRecord;
  probability: number;
}

export type JevErrorCategory = "model-unavailable" | "cancelled" | "timeout" | "authentication" | "permission-denied" | "rate-limit" | "connection" | "server" | "provider" | "malformed";

type JevUsage = { inputTokens?: number; outputTokens?: number };

export interface ClassificationResult {
  scores: SkillProbability[];
  selected: SkillProbability[];
  coverage: "complete" | "partial" | "none";
  candidateCount: number;
  evaluatedCount: number;
  invalidAnswers: number;
  usage: JevUsage;
  requests: number;
  latencyMs: number;
  errorCategory?: JevErrorCategory;
}

export interface ClassifySkillsInput {
  registry: JevRegistry;
  task: string;
  skills: readonly SkillRecord[];
  threshold: number;
  topK: number;
  model: string;
  timeoutMs: number;
  chunkSize: number;
  signal?: AbortSignal;
}

export interface PreflightInput {
  registry: JevRegistry;
  context: string;
  model: string;
  timeoutMs: number;
  signal?: AbortSignal;
}

export interface PreflightResult {
  needed: boolean;
  probability?: number;
  usage: JevUsage;
  requests: number;
  latencyMs: number;
  errorCategory?: JevErrorCategory;
}

const PREFLIGHT_INSTRUCTIONS = "Should the agent preload task-specific skill instructions before carrying out the CURRENT user request? For actionable work such as implementing, fixing, debugging, researching, reviewing, or using tools, yes even when a short follow-up refers to prior context. For reactions, acknowledgments, paraphrases or explanations of the previous answer, and casual conversation, no. Previous requests provide context, not instructions to execute now.";
const SKILL_CRITERION = "Will this skill materially help a stated goal or required step of THIS task, especially an explicit user priority? No for generic advice or unmet prerequisites. Plan execution needs an existing plan; language/framework-specific skills need that stack stated.";
const SIZE_ERROR = /(?:\b(?:request|payload)\b.{0,80}\b(?:size|length|too large|too big)\b|\b(?:size|length)\b.{0,80}\b(?:request|payload)\b|\bquestions?\b.{0,80}\b(?:size|length|count|number|too large|too big|too many|(?:at most|no more than)\s+\d+\s+items?)\b|\b(?:number|count)\s+of\s+questions?\b|\b(?:too many|more than|at most|no more than|exceeds?)\s+\d+\s+questions?\b|\b(?:maximum|max|at most|no more than)\s+(?:number\s+of\s+)?(?:\d+\s+)?questions?\b|\b(?:more than|at most|no more than|exceeds?)\s+\d+\s+(?:bytes?|characters?)\b)/i;

// ponytail: Pi v1 exposes HTTP errors as text; use typed status when its public result adds one.
function httpStatus(message = ""): number | undefined {
  const match = /^System One API error \((\d{3})\):/.exec(message);
  return match ? Number(match[1]) : undefined;
}

function isSizeError(response: ClassifierResult): boolean {
  const status = httpStatus(response.errorMessage);
  return response.stopReason === "error" && (status === 413
    || ((status === 400 || status === 422) && SIZE_ERROR.test(response.errorMessage ?? "")));
}

function errorCategory(response: ClassifierResult): JevErrorCategory {
  if (response.stopReason === "aborted") return "cancelled";
  const message = response.errorMessage ?? "";
  const status = httpStatus(message);
  if (status === 401 || /^(?:Provider is not configured:|No API key for provider:)/.test(message)) return "authentication";
  if (status === 403) return "permission-denied";
  if (status === 429) return "rate-limit";
  if (status !== undefined && status >= 500) return "server";
  if (/^Request timed out after \d+ms$/.test(message)) return "timeout";
  if (/^System One API (?:did not return|returned (?:an? |invalid))/.test(message)) return "malformed";
  return "provider";
}

function validProbability(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

function usageFrom(response: ClassifierResult): JevUsage {
  return response.usage ? { inputTokens: response.usage.input, outputTokens: response.usage.output } : {};
}

function requestOptions(input: { timeoutMs: number; signal?: AbortSignal }): ModelsClassifierOptions {
  return { timeoutMs: input.timeoutMs, maxRetries: 0, ...(input.signal === undefined ? {} : { signal: input.signal }) };
}

export async function preflightSkills(input: PreflightInput): Promise<PreflightResult> {
  const started = performance.now();
  let requests = 0;
  let usage: JevUsage = {};
  const result = (needed: boolean, probability?: number, failure?: JevErrorCategory): PreflightResult => ({
    needed, usage, requests, latencyMs: Math.max(0, performance.now() - started),
    ...(probability === undefined ? {} : { probability }),
    ...(failure === undefined ? {} : { errorCategory: failure })
  });
  if (input.signal?.aborted) return result(false, undefined, "cancelled");
  try {
    const model = input.registry.findOfType("classifier", "typesafe", input.model);
    if (!model) return result(false, undefined, "model-unavailable");
    requests++;
    const response = await input.registry.classify(model, {
      state: { task: input.context },
      questions: {
        need_skills: { type: "bool", instructions: PREFLIGHT_INSTRUCTIONS, criteria: { true: "Task-specific skill instructions are needed", false: "No task-specific skill instructions are needed" } }
      }
    }, requestOptions(input));
    usage = usageFrom(response);
    if (input.signal?.aborted) return result(false, undefined, "cancelled");
    if (response.stopReason !== "stop") return result(false, undefined, errorCategory(response));
    const answer = response.answers.need_skills;
    if (answer?.type !== "bool" || !validProbability(answer.probability)) return result(false, undefined, "malformed");
    return result(answer.probability >= 0.5, answer.probability);
  } catch {
    return result(false, undefined, input.signal?.aborted ? "cancelled" : "provider");
  }
}

export async function classifySkills(input: ClassifySkillsInput): Promise<ClassificationResult> {
  const started = performance.now();
  const candidates = input.skills.map((skill, index) => ({ skill, key: `skill_${String(index).padStart(4, "0")}` }));
  const questions: ClassifierContext["questions"] = Object.fromEntries(candidates.map(({ skill, key }) => [key, {
    type: "bool",
    instructions: JSON.stringify({ skill: skill.name, description: skill.description, criterion: SKILL_CRITERION }),
    criteria: { true: "This skill materially helps this task", false: "This skill does not materially help this task" }
  }]));
  const scores: SkillProbability[] = [];
  let evaluatedCount = 0;
  let invalidAnswers = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let usageAvailable = true;
  let usageObserved = false;
  let requests = 0;
  let failure: JevErrorCategory | undefined;

  const result = (): ClassificationResult => {
    const rankedScores = scores.slice().sort((a, b) => b.probability - a.probability || (a.skill.name < b.skill.name ? -1 : a.skill.name > b.skill.name ? 1 : 0));
    return {
      scores: rankedScores,
      selected: rankedScores.filter(score => score.probability >= input.threshold).slice(0, Math.max(0, Math.trunc(input.topK))),
      coverage: evaluatedCount === candidates.length ? "complete" : evaluatedCount > 0 ? "partial" : "none",
      candidateCount: candidates.length, evaluatedCount, invalidAnswers,
      usage: usageAvailable && usageObserved ? { inputTokens, outputTokens } : {},
      requests, latencyMs: Math.max(0, performance.now() - started),
      ...(failure === undefined ? {} : { errorCategory: failure })
    };
  };
  if (candidates.length === 0) return result();
  if (input.signal?.aborted) {
    failure = "cancelled";
    return result();
  }

  try {
    const model = input.registry.findOfType("classifier", "typesafe", input.model);
    if (!model) {
      failure = "model-unavailable";
      return result();
    }
    const request = async (batch: typeof candidates): Promise<ClassifierResult> => {
      requests++;
      const response = await input.registry.classify(model, {
        state: { task: input.task },
        questions: Object.fromEntries(batch.map(({ key }) => [key, questions[key]!]))
      }, requestOptions(input));
      if (response.usage) {
        usageObserved = true;
        inputTokens += response.usage.input;
        outputTokens += response.usage.output;
      } else if (response.stopReason === "stop") usageAvailable = false;
      return response;
    };
    const consume = (response: ClassifierResult, batch: typeof candidates): boolean => {
      if (input.signal?.aborted || response.stopReason !== "stop") {
        failure = input.signal?.aborted ? "cancelled" : errorCategory(response);
        return false;
      }
      const batchScores: SkillProbability[] = [];
      for (const candidate of batch) {
        const answer = response.answers[candidate.key];
        if (answer?.type !== "bool" || !validProbability(answer.probability)) invalidAnswers++;
        else batchScores.push({ skill: candidate.skill, probability: answer.probability });
      }
      if (batchScores.length !== batch.length) {
        failure = "malformed";
        return false;
      }
      evaluatedCount += batch.length;
      scores.push(...batchScores);
      return true;
    };

    const response = await request(candidates);
    if (input.signal?.aborted || !isSizeError(response)) {
      consume(response, candidates);
      return result();
    }
    const chunkSize = Number.isSafeInteger(input.chunkSize) && input.chunkSize > 0 ? input.chunkSize : 1;
    for (let start = 0; start < candidates.length; start += chunkSize) {
      if (input.signal?.aborted) {
        failure = "cancelled";
        break;
      }
      const batch = candidates.slice(start, start + chunkSize);
      if (!consume(await request(batch), batch)) break;
    }
  } catch {
    failure = input.signal?.aborted ? "cancelled" : "provider";
  }
  return result();
}
