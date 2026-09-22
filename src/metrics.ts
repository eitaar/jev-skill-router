import type { ClassificationResult } from "./jev.js";
import type { InterpretationResult } from "./interpreter.js";
import type { RouterConfig } from "./types.js";

export type MetricRouteKind = "automatic" | "on-demand" | "dry-run";

export interface RouteMetricDetails {
  routeKind: MetricRouteKind;
  selected: readonly { name: string; probability: number }[];
  candidateCount: number;
  evaluatedCount: number;
  coverage: "complete" | "partial" | "none";
  errorCategory?: string;
}

export interface RouteMetricInput {
  details: RouteMetricDetails;
  interpretation?: InterpretationResult;
  classification?: ClassificationResult;
  loaderFailures?: readonly string[];
  skipped?: boolean;
}

export interface CostMetric {
  value: number;
  basis: "measured" | "estimated";
}

export interface MetricsSnapshot {
  routes: Record<MetricRouteKind, number>;
  interpreterCalls: number;
  interpreterTokens: { input: number; output: number; cacheRead: number; cacheWrite: number; reasoning: number };
  interpreterLatencyMs: number;
  jevRequests: number;
  jevChunks: number;
  jevTokens: { input?: number; output?: number };
  jevLatencyMs: number;
  candidateCount: number;
  evaluatedCount: number;
  coverage: { complete: number; partial: number; none: number };
  noMatchRoutes: number;
  skippedRoutes: number;
  loaderFailures: number;
  selectedNames: string[];
  errorCategories: Record<string, number>;
  interpreterCost?: CostMetric;
  jevCost?: CostMetric;
}

function nonnegative(value: number | undefined): number {
  return value !== undefined && Number.isFinite(value) && value >= 0 ? value : 0;
}

function tokenCount(value: number | undefined): number {
  return value !== undefined && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

export function createSessionMetrics() {
  const state = {
    routes: { automatic: 0, "on-demand": 0, "dry-run": 0 } satisfies Record<MetricRouteKind, number>,
    interpreterCalls: 0,
    interpreterTokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
    interpreterLatencyMs: 0,
    jevRequests: 0,
    jevChunks: 0,
    jevTokens: { input: 0, output: 0 },
    jevInputTokensAvailable: true,
    jevOutputTokensAvailable: true,
    jevInputTokensObserved: false,
    jevOutputTokensObserved: false,
    jevLatencyMs: 0,
    candidateCount: 0,
    evaluatedCount: 0,
    coverage: { complete: 0, partial: 0, none: 0 },
    noMatchRoutes: 0,
    skippedRoutes: 0,
    loaderFailures: 0,
    selectedNames: new Set<string>(),
    errorCategories: new Map<string, number>(),
    interpreterCost: undefined as CostMetric | undefined,
    jevCost: undefined as CostMetric | undefined,
    jevCostUnavailable: false
  };

  const reset = (): void => {
    state.routes.automatic = 0;
    state.routes["on-demand"] = 0;
    state.routes["dry-run"] = 0;
    state.interpreterCalls = 0;
    Object.assign(state.interpreterTokens, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 });
    state.interpreterLatencyMs = 0;
    state.jevRequests = 0;
    state.jevChunks = 0;
    Object.assign(state.jevTokens, { input: 0, output: 0 });
    state.jevInputTokensAvailable = true;
    state.jevOutputTokensAvailable = true;
    state.jevInputTokensObserved = false;
    state.jevOutputTokensObserved = false;
    state.jevLatencyMs = 0;
    state.candidateCount = 0;
    state.evaluatedCount = 0;
    Object.assign(state.coverage, { complete: 0, partial: 0, none: 0 });
    state.noMatchRoutes = 0;
    state.skippedRoutes = 0;
    state.loaderFailures = 0;
    state.selectedNames.clear();
    state.errorCategories.clear();
    state.interpreterCost = undefined;
    state.jevCost = undefined;
    state.jevCostUnavailable = false;
  };

  const recordRoute = (input: RouteMetricInput, pricing?: RouterConfig["jevPricing"]): void => {
    const { details, classification, interpretation } = input;
    state.routes[details.routeKind] += 1;
    state.candidateCount += tokenCount(details.candidateCount);
    state.evaluatedCount += tokenCount(details.evaluatedCount);
    state.coverage[details.coverage] += 1;
    if (input.skipped) state.skippedRoutes += 1;
    if (classification && details.selected.length === 0) state.noMatchRoutes += 1;
    state.loaderFailures += input.loaderFailures?.length ?? 0;
    for (const selected of details.selected) state.selectedNames.add(selected.name);
    if (details.errorCategory) {
      state.errorCategories.set(details.errorCategory, (state.errorCategories.get(details.errorCategory) ?? 0) + 1);
    }

    if (interpretation) {
      state.interpreterCalls += tokenCount(interpretation.attempts);
      state.interpreterLatencyMs += nonnegative(interpretation.latencyMs);
      const usage = interpretation.usage;
      if (usage) {
        state.interpreterTokens.input += tokenCount(usage.input);
        state.interpreterTokens.output += tokenCount(usage.output);
        state.interpreterTokens.cacheRead += tokenCount(usage.cacheRead);
        state.interpreterTokens.cacheWrite += tokenCount(usage.cacheWrite);
        state.interpreterTokens.reasoning += tokenCount(usage.reasoning);
        const totalCost = usage.cost.total;
        if (Number.isFinite(totalCost) && totalCost >= 0) {
          state.interpreterCost = {
            value: (state.interpreterCost?.value ?? 0) + totalCost,
            basis: "measured"
          };
        }
      }
    }

    if (classification) {
      state.jevRequests += tokenCount(classification.requests);
      state.jevChunks += classification.requests > 1 ? tokenCount(classification.requests - 1) : 0;
      state.jevLatencyMs += nonnegative(classification.latencyMs);
      const { inputTokens, outputTokens } = classification.usage;
      if (inputTokens === undefined) state.jevInputTokensAvailable = false;
      else {
        state.jevInputTokensObserved = true;
        state.jevTokens.input += tokenCount(inputTokens);
      }
      if (outputTokens === undefined) state.jevOutputTokensAvailable = false;
      else {
        state.jevOutputTokensObserved = true;
        state.jevTokens.output += tokenCount(outputTokens);
      }
      if (pricing && (inputTokens === undefined || outputTokens === undefined)) {
        state.jevCostUnavailable = true;
        state.jevCost = undefined;
      } else if (pricing && !state.jevCostUnavailable) {
        const cost = inputTokens! * pricing.inputPerMillion / 1_000_000
          + outputTokens! * pricing.outputPerMillion / 1_000_000;
        if (Number.isFinite(cost) && cost >= 0) {
          state.jevCost = { value: (state.jevCost?.value ?? 0) + cost, basis: "estimated" };
        }
      }
    }
  };

  const snapshot = (): MetricsSnapshot => ({
    routes: { ...state.routes },
    interpreterCalls: state.interpreterCalls,
    interpreterTokens: { ...state.interpreterTokens },
    interpreterLatencyMs: state.interpreterLatencyMs,
    jevRequests: state.jevRequests,
    jevChunks: state.jevChunks,
    jevTokens: {
      ...(state.jevInputTokensAvailable && state.jevInputTokensObserved ? { input: state.jevTokens.input } : {}),
      ...(state.jevOutputTokensAvailable && state.jevOutputTokensObserved ? { output: state.jevTokens.output } : {})
    },
    jevLatencyMs: state.jevLatencyMs,
    candidateCount: state.candidateCount,
    evaluatedCount: state.evaluatedCount,
    coverage: { ...state.coverage },
    noMatchRoutes: state.noMatchRoutes,
    skippedRoutes: state.skippedRoutes,
    loaderFailures: state.loaderFailures,
    selectedNames: [...state.selectedNames],
    errorCategories: Object.fromEntries(state.errorCategories),
    ...(state.interpreterCost === undefined ? {} : { interpreterCost: { ...state.interpreterCost } }),
    ...(state.jevCost === undefined ? {} : { jevCost: { ...state.jevCost } })
  });

  const formatStats = (): string => {
    const current = snapshot();
    const routeCounts = `automatic ${current.routes.automatic}, on-demand ${current.routes["on-demand"]}, dry-run ${current.routes["dry-run"]}`;
    const costs = [current.interpreterCost, current.jevCost]
      .filter((cost): cost is CostMetric => cost !== undefined)
      .map(cost => `${cost.value} ${cost.basis}`);
    return [
      `Routes: ${routeCounts}`,
      `Jev: ${current.jevRequests} requests, ${current.jevTokens.input ?? "unavailable"}/${current.jevTokens.output ?? "unavailable"} tokens, ${current.evaluatedCount}/${current.candidateCount} evaluated`,
      `Interpreter: ${current.interpreterCalls} calls, ${current.interpreterTokens.input}/${current.interpreterTokens.output} tokens`,
      ...(costs.length === 0 ? [] : [`Costs: ${costs.join(", ")}`]),
      `Selected: ${current.selectedNames.join(", ") || "none"}; loader failures: ${current.loaderFailures}`
    ].join("\n");
  };

  return { recordRoute, reset, snapshot, formatStats };
}
