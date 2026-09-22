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

interface MetricValues {
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

export interface RouteMetricsSnapshot extends MetricValues {
  routes: number;
  interpreterUsage: "measured" | "unavailable";
}

export interface MetricsSnapshot extends MetricValues {
  routes: Record<MetricRouteKind, number>;
  byRoute: Record<MetricRouteKind, RouteMetricsSnapshot>;
}

interface MetricBucket {
  routes: number;
  interpreterCalls: number;
  interpreterTokens: { input: number; output: number; cacheRead: number; cacheWrite: number; reasoning: number };
  interpreterTokensAvailable: boolean;
  interpreterTokensObserved: boolean;
  interpreterLatencyMs: number;
  jevRequests: number;
  jevChunks: number;
  jevTokens: { input: number; output: number };
  jevInputTokensAvailable: boolean;
  jevOutputTokensAvailable: boolean;
  jevInputTokensObserved: boolean;
  jevOutputTokensObserved: boolean;
  jevLatencyMs: number;
  candidateCount: number;
  evaluatedCount: number;
  coverage: { complete: number; partial: number; none: number };
  noMatchRoutes: number;
  skippedRoutes: number;
  loaderFailures: number;
  selectedNames: Set<string>;
  errorCategories: Map<string, number>;
  interpreterCost?: CostMetric;
  jevCost?: CostMetric;
  jevCostUnavailable: boolean;
}

function nonnegative(value: number | undefined): number {
  return value !== undefined && Number.isFinite(value) && value >= 0 ? value : 0;
}

function tokenCount(value: number | undefined): number {
  return value !== undefined && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function createMetricBucket(): MetricBucket {
  return {
    routes: 0,
    interpreterCalls: 0,
    interpreterTokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
    interpreterTokensAvailable: true,
    interpreterTokensObserved: false,
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
    selectedNames: new Set(),
    errorCategories: new Map(),
    jevCostUnavailable: false
  };
}

function createRouteBuckets(): Record<MetricRouteKind, MetricBucket> {
  return {
    automatic: createMetricBucket(),
    "on-demand": createMetricBucket(),
    "dry-run": createMetricBucket()
  };
}

function recordInto(bucket: MetricBucket, input: RouteMetricInput, pricing?: RouterConfig["jevPricing"]): void {
  const { details, classification, interpretation } = input;
  bucket.routes++;
  bucket.candidateCount += tokenCount(details.candidateCount);
  bucket.evaluatedCount += tokenCount(details.evaluatedCount);
  bucket.coverage[details.coverage]++;
  if (input.skipped) bucket.skippedRoutes++;
  if (classification && details.selected.length === 0) bucket.noMatchRoutes++;
  bucket.loaderFailures += input.loaderFailures?.length ?? 0;
  for (const selected of details.selected) bucket.selectedNames.add(selected.name);
  if (details.errorCategory) {
    bucket.errorCategories.set(details.errorCategory, (bucket.errorCategories.get(details.errorCategory) ?? 0) + 1);
  }

  if (interpretation) {
    bucket.interpreterCalls += tokenCount(interpretation.attempts);
    bucket.interpreterLatencyMs += nonnegative(interpretation.latencyMs);
    const usage = interpretation.usage;
    if (usage) {
      bucket.interpreterTokensObserved = true;
      bucket.interpreterTokens.input += tokenCount(usage.input);
      bucket.interpreterTokens.output += tokenCount(usage.output);
      bucket.interpreterTokens.cacheRead += tokenCount(usage.cacheRead);
      bucket.interpreterTokens.cacheWrite += tokenCount(usage.cacheWrite);
      bucket.interpreterTokens.reasoning += tokenCount(usage.reasoning);
      const totalCost = usage.cost.total;
      if (Number.isFinite(totalCost) && totalCost >= 0) {
        bucket.interpreterCost = {
          value: (bucket.interpreterCost?.value ?? 0) + totalCost,
          basis: "measured"
        };
      }
    } else {
      bucket.interpreterTokensAvailable = false;
    }
  }

  if (classification) {
    bucket.jevRequests += tokenCount(classification.requests);
    bucket.jevChunks += classification.requests > 1 ? tokenCount(classification.requests - 1) : 0;
    bucket.jevLatencyMs += nonnegative(classification.latencyMs);
    const { inputTokens, outputTokens } = classification.usage;
    if (inputTokens === undefined) bucket.jevInputTokensAvailable = false;
    else {
      bucket.jevInputTokensObserved = true;
      bucket.jevTokens.input += tokenCount(inputTokens);
    }
    if (outputTokens === undefined) bucket.jevOutputTokensAvailable = false;
    else {
      bucket.jevOutputTokensObserved = true;
      bucket.jevTokens.output += tokenCount(outputTokens);
    }
    if (pricing && (inputTokens === undefined || outputTokens === undefined)) {
      bucket.jevCostUnavailable = true;
      delete bucket.jevCost;
    } else if (pricing && !bucket.jevCostUnavailable) {
      const cost = inputTokens! * pricing.inputPerMillion / 1_000_000
        + outputTokens! * pricing.outputPerMillion / 1_000_000;
      if (Number.isFinite(cost) && cost >= 0) {
        bucket.jevCost = { value: (bucket.jevCost?.value ?? 0) + cost, basis: "estimated" };
      }
    }
  }
}

function metricValues(bucket: MetricBucket): MetricValues {
  return {
    interpreterCalls: bucket.interpreterCalls,
    interpreterTokens: { ...bucket.interpreterTokens },
    interpreterLatencyMs: bucket.interpreterLatencyMs,
    jevRequests: bucket.jevRequests,
    jevChunks: bucket.jevChunks,
    jevTokens: {
      ...(bucket.jevInputTokensAvailable && bucket.jevInputTokensObserved ? { input: bucket.jevTokens.input } : {}),
      ...(bucket.jevOutputTokensAvailable && bucket.jevOutputTokensObserved ? { output: bucket.jevTokens.output } : {})
    },
    jevLatencyMs: bucket.jevLatencyMs,
    candidateCount: bucket.candidateCount,
    evaluatedCount: bucket.evaluatedCount,
    coverage: { ...bucket.coverage },
    noMatchRoutes: bucket.noMatchRoutes,
    skippedRoutes: bucket.skippedRoutes,
    loaderFailures: bucket.loaderFailures,
    selectedNames: [...bucket.selectedNames],
    errorCategories: Object.fromEntries(bucket.errorCategories),
    ...(bucket.interpreterCost === undefined ? {} : { interpreterCost: { ...bucket.interpreterCost } }),
    ...(bucket.jevCost === undefined ? {} : { jevCost: { ...bucket.jevCost } })
  };
}

function routeSnapshot(bucket: MetricBucket): RouteMetricsSnapshot {
  return {
    routes: bucket.routes,
    interpreterUsage: bucket.interpreterTokensAvailable && bucket.interpreterTokensObserved ? "measured" : "unavailable",
    ...metricValues(bucket)
  };
}

function tokenSummary(tokens: { input?: number; output?: number }): string {
  return tokens.input === undefined || tokens.output === undefined
    ? "unavailable tokens"
    : `${tokens.input}/${tokens.output} tokens measured`;
}

export function createSessionMetrics() {
  let totals = createMetricBucket();
  let byRoute = createRouteBuckets();

  const reset = (): void => {
    totals = createMetricBucket();
    byRoute = createRouteBuckets();
  };

  const recordRoute = (input: RouteMetricInput, pricing?: RouterConfig["jevPricing"]): void => {
    recordInto(totals, input, pricing);
    recordInto(byRoute[input.details.routeKind], input, pricing);
  };

  const snapshot = (): MetricsSnapshot => ({
    routes: {
      automatic: byRoute.automatic.routes,
      "on-demand": byRoute["on-demand"].routes,
      "dry-run": byRoute["dry-run"].routes
    },
    ...metricValues(totals),
    byRoute: {
      automatic: routeSnapshot(byRoute.automatic),
      "on-demand": routeSnapshot(byRoute["on-demand"]),
      "dry-run": routeSnapshot(byRoute["dry-run"])
    }
  });

  const formatStats = (): string => {
    const current = snapshot();
    const routeCounts = `automatic ${current.routes.automatic}, on-demand ${current.routes["on-demand"]}, dry-run ${current.routes["dry-run"]}`;
    const routeLines = (Object.keys(current.byRoute) as MetricRouteKind[]).map(kind => {
      const route = current.byRoute[kind];
      const errors = Object.entries(route.errorCategories).sort(([a], [b]) => a.localeCompare(b));
      const errorSummary = errors.length > 0 ? errors.map(([category, count]) => `${category} ${count}`).join(", ") : "none";
      const costs = [route.interpreterCost, route.jevCost]
        .filter((cost): cost is CostMetric => cost !== undefined)
        .map(cost => `${cost.value} ${cost.basis}`);
      const interpreterTokens = route.interpreterUsage === "measured"
        ? `${route.interpreterTokens.input}/${route.interpreterTokens.output} tokens measured`
        : "unavailable tokens";
      return `${kind}: ${route.routes} routes; candidates/evaluated ${route.candidateCount}/${route.evaluatedCount}; coverage complete ${route.coverage.complete}, partial ${route.coverage.partial}, none ${route.coverage.none}; Jev ${route.jevRequests} requests, ${route.jevChunks} chunks, ${tokenSummary(route.jevTokens)}, ${route.jevLatencyMs.toFixed(1)} ms; interpreter ${route.interpreterCalls} calls, ${interpreterTokens}, ${route.interpreterLatencyMs.toFixed(1)} ms; no matches ${route.noMatchRoutes}; skipped ${route.skippedRoutes}; loader failures ${route.loaderFailures}; errors ${errorSummary}; selected ${route.selectedNames.join(", ") || "none"}${costs.length > 0 ? `; costs ${costs.join(", ")}` : ""}`;
    });
    return [
      `Routes: ${routeCounts}`,
      ...routeLines,
      `Selected overall: ${current.selectedNames.join(", ") || "none"}; loader failures: ${current.loaderFailures}`
    ].join("\n");
  };

  return { recordRoute, reset, snapshot, formatStats };
}
