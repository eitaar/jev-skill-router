import {
  APIError,
  APIConnectionError,
  APITimeoutError,
  APIUserAbortError,
  AuthenticationError,
  InternalServerError,
  PermissionDeniedError,
  RateLimitError,
  TypeSafeClient,
  noul,
  type NoulQuestion
} from "@typesafe-ai/sdk";
import { performance } from "node:perf_hooks";
import type { SkillRecord } from "./registry.js";

export interface JevRequest {
  state: { task: string };
  questions: Record<string, NoulQuestion>;
  model: string;
}

export interface JevRequestOptions {
  timeout?: number;
  signal?: AbortSignal;
}

export interface JevClientLike {
  systemOne(request: JevRequest, options?: JevRequestOptions): Promise<unknown>;
}

export interface SkillProbability {
  skill: SkillRecord;
  probability: number;
}

export type JevErrorCategory = "cancelled" | "timeout" | "authentication" | "permission-denied" | "rate-limit" | "connection" | "server" | "provider" | "malformed";

export interface ClassificationResult {
  scores: SkillProbability[];
  selected: SkillProbability[];
  coverage: "complete" | "partial" | "none";
  candidateCount: number;
  evaluatedCount: number;
  invalidAnswers: number;
  usage: { inputTokens?: number; outputTokens?: number };
  requests: number;
  latencyMs: number;
  errorCategory?: JevErrorCategory;
}

export interface ClassifySkillsInput {
  client: JevClientLike;
  task: string;
  skills: readonly SkillRecord[];
  threshold: number;
  topK: number;
  model: string;
  timeoutMs: number;
  chunkSize: number;
  signal?: AbortSignal;
}

export function adaptTypeSafeClient(client: TypeSafeClient): JevClientLike {
  return { systemOne: (request, options) => client.systemOne(request, options) };
}

export interface PreflightInput {
  client: JevClientLike;
  context: string;
  model: string;
  timeoutMs: number;
  signal?: AbortSignal;
}

export interface PreflightResult {
  needed: boolean;
  probability?: number;
  usage: { inputTokens?: number; outputTokens?: number };
  requests: number;
  latencyMs: number;
  errorCategory?: JevErrorCategory;
}

export async function preflightSkills(input: PreflightInput): Promise<PreflightResult> {
  const started = performance.now();
  const result = (needed: boolean, requests: number, usage: PreflightResult["usage"] = {}, probability?: number, errorCategory?: JevErrorCategory): PreflightResult => ({
    needed,
    usage,
    requests,
    latencyMs: Math.max(0, performance.now() - started),
    ...(probability === undefined ? {} : { probability }),
    ...(errorCategory === undefined ? {} : { errorCategory })
  });
  if (input.signal?.aborted) return result(false, 0, {}, undefined, "cancelled");
  try {
    const response = await input.client.systemOne({
      state: { task: input.context },
      questions: {
        need_skills: noul({
          criterion: "Should the agent preload task-specific skill instructions before carrying out the CURRENT user request? For actionable work such as implementing, fixing, debugging, researching, reviewing, or using tools, yes even when a short follow-up refers to prior context. For reactions, acknowledgments, paraphrases or explanations of the previous answer, and casual conversation, no. Previous requests provide context, not instructions to execute now."
        })
      },
      model: input.model
    }, { timeout: input.timeoutMs, ...(input.signal === undefined ? {} : { signal: input.signal }) });
    if (input.signal?.aborted) return result(false, 1, {}, undefined, "cancelled");
    const record = isRecord(response) ? response : {};
    const answers = isRecord(record.answers) ? record.answers : {};
    const answer = isRecord(answers.need_skills) ? answers.need_skills : {};
    const usage = isRecord(record.usage) ? record.usage : {};
    const inputTokens = validTokenCount(usage.input_tokens);
    const outputTokens = validTokenCount(usage.output_tokens);
    const tokens = {
      ...(inputTokens === undefined ? {} : { inputTokens }),
      ...(outputTokens === undefined ? {} : { outputTokens })
    };
    if (!validProbability(answer.noul)) return result(false, 1, tokens, undefined, "malformed");
    return result(answer.noul >= 0.5, 1, tokens, answer.noul);
  } catch (error) {
    return result(false, 1, {}, undefined, errorCategory(error, input.signal));
  }
}

const SIZE_ERROR = /(?:\b(?:request|payload)\b.{0,80}\b(?:size|length|too large|too big)\b|\b(?:size|length)\b.{0,80}\b(?:request|payload)\b|\bquestions?\b.{0,80}\b(?:size|length|count|number|too large|too big|too many|(?:at most|no more than)\s+\d+\s+items?)\b|\b(?:number|count)\s+of\s+questions?\b|\b(?:too many|more than|at most|no more than|exceeds?)\s+\d+\s+questions?\b|\b(?:maximum|max|at most|no more than)\s+(?:number\s+of\s+)?(?:\d+\s+)?questions?\b|\b(?:more than|at most|no more than|exceeds?)\s+\d+\s+(?:bytes?|characters?)\b)/i;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSizeError(error: unknown): boolean {
  if (isRecord(error) && error.status === 413) return true;
  return error instanceof APIError && (error.status === 400 || error.status === 422) && SIZE_ERROR.test(error.message);
}

function errorCategory(error: unknown, signal?: AbortSignal): JevErrorCategory {
  if (signal?.aborted || error instanceof APIUserAbortError || (error instanceof Error && error.name === "AbortError")) return "cancelled";
  if (error instanceof APITimeoutError) return "timeout";
  if (error instanceof AuthenticationError) return "authentication";
  if (error instanceof PermissionDeniedError) return "permission-denied";
  if (error instanceof RateLimitError) return "rate-limit";
  if (error instanceof APIConnectionError) return "connection";
  if (error instanceof InternalServerError || (error instanceof APIError && error.status >= 500)) return "server";
  return "provider";
}

function validProbability(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

function validTokenCount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function sortScores(scores: SkillProbability[]): SkillProbability[] {
  return scores.slice().sort((a, b) => b.probability - a.probability || (a.skill.name < b.skill.name ? -1 : a.skill.name > b.skill.name ? 1 : 0));
}

export async function classifySkills(input: ClassifySkillsInput): Promise<ClassificationResult> {
  const started = performance.now();
  const candidates = input.skills.map((skill, index) => ({ skill, key: `skill_${String(index).padStart(4, "0")}` }));
  const questions = Object.fromEntries(candidates.map(({ skill, key }) => [key, noul({
    skill: skill.name,
    description: skill.description,
    criterion: "Will this skill materially help a stated goal or required step of THIS task, especially an explicit user priority? No for generic advice or unmet prerequisites. Plan execution needs an existing plan; language/framework-specific skills need that stack stated."
  })]));
  const scores: SkillProbability[] = [];
  let evaluatedCount = 0;
  let invalidAnswers = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let inputUsageAvailable = true;
  let outputUsageAvailable = true;
  let completedRequests = 0;
  let requests = 0;
  let failure: JevErrorCategory | undefined;

  const result = (): ClassificationResult => {
    const coverage = evaluatedCount === candidates.length ? "complete" : evaluatedCount > 0 ? "partial" : "none";
    const rankedScores = sortScores(scores);
    return {
      scores: rankedScores,
      selected: rankedScores.filter(score => score.probability >= input.threshold).slice(0, Math.max(0, Math.trunc(input.topK))),
      coverage,
      candidateCount: candidates.length,
      evaluatedCount,
      invalidAnswers,
      usage: {
        ...(completedRequests > 0 && inputUsageAvailable ? { inputTokens } : {}),
        ...(completedRequests > 0 && outputUsageAvailable ? { outputTokens } : {})
      },
      requests,
      latencyMs: Math.max(0, performance.now() - started),
      ...(failure === undefined ? {} : { errorCategory: failure })
    };
  };

  if (candidates.length === 0) return result();
  if (input.signal?.aborted) {
    failure = "cancelled";
    return result();
  }

  const requestOptions: JevRequestOptions = {
    timeout: input.timeoutMs,
    ...(input.signal === undefined ? {} : { signal: input.signal })
  };
  const request = async (batch: typeof candidates): Promise<unknown> => {
    if (input.signal?.aborted) throw new APIUserAbortError();
    const batchQuestions = Object.fromEntries(batch.map(({ key }) => [key, questions[key]!]));
    requests += 1;
    const response = await input.client.systemOne({ state: { task: input.task }, questions: batchQuestions, model: input.model }, requestOptions);
    if (input.signal?.aborted) throw new APIUserAbortError();
    return response;
  };
  const consume = (response: unknown, batch: typeof candidates): void => {
    evaluatedCount += batch.length;
    const responseRecord = isRecord(response) ? response : {};
    const answers = isRecord(responseRecord.answers) ? responseRecord.answers : {};
    const usage = isRecord(responseRecord.usage) ? responseRecord.usage : {};
    completedRequests += 1;
    const requestInputTokens = validTokenCount(usage.input_tokens);
    const requestOutputTokens = validTokenCount(usage.output_tokens);
    if (requestInputTokens === undefined) inputUsageAvailable = false;
    else inputTokens += requestInputTokens;
    if (requestOutputTokens === undefined) outputUsageAvailable = false;
    else outputTokens += requestOutputTokens;
    for (const candidate of batch) {
      const answer = Object.hasOwn(answers, candidate.key) ? answers[candidate.key] : undefined;
      const probability = isRecord(answer) ? answer.noul : undefined;
      if (!validProbability(probability)) {
        invalidAnswers += 1;
        continue;
      }
      scores.push({ skill: candidate.skill, probability });
    }
  };

  try {
    consume(await request(candidates), candidates);
    return result();
  } catch (error) {
    if (input.signal?.aborted || error instanceof APIUserAbortError || (error instanceof Error && error.name === "AbortError")) {
      failure = "cancelled";
      return result();
    }
    if (!isSizeError(error)) {
      failure = errorCategory(error, input.signal);
      return result();
    }
  }

  const chunkSize = Number.isSafeInteger(input.chunkSize) && input.chunkSize > 0 ? input.chunkSize : 1;
  for (let start = 0; start < candidates.length; start += chunkSize) {
    const batch = candidates.slice(start, start + chunkSize);
    try {
      consume(await request(batch), batch);
    } catch (error) {
      failure = errorCategory(error, input.signal);
      break;
    }
  }
  return result();
}
