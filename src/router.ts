import { performance } from "node:perf_hooks";
import { eligibleSkills, type SkillRecord } from "./registry.js";
import type { InterpretationResult } from "./interpreter.js";
import type { ClassificationResult, PreflightResult, SkillProbability } from "./jev.js";
import { createSessionMetrics } from "./metrics.js";
import { loadSkills } from "./loader.js";
import type { RouterConfig } from "./types.js";

export interface AutomaticRouteInput {
  config: RouterConfig;
  registry: readonly SkillRecord[];
  visible: ReadonlySet<string>;
  supplied: ReadonlySet<string>;
  currentPrompt: string;
  context: string;
  signal?: AbortSignal;
}

export interface OnDemandRouteInput {
  config: RouterConfig;
  registry: readonly SkillRecord[];
  visible: ReadonlySet<string>;
  supplied: ReadonlySet<string>;
  task: string;
  signal?: AbortSignal;
}

export interface RouterClassificationInput {
  task: string;
  skills: readonly SkillRecord[];
  config: RouterConfig;
  signal?: AbortSignal;
}

export interface RouterInterpreterInput {
  context: string;
  config: RouterConfig;
  signal?: AbortSignal;
}

export interface RouteDetails {
  routeKind: "automatic" | "on-demand" | "dry-run";
  suppliedSkills: string[];
  selected: Array<{ name: string; probability: number }>;
  candidateCount: number;
  evaluatedCount: number;
  coverage: "complete" | "partial" | "none";
  interpreterFallback: boolean;
  latencyMs: number;
  skippedSkills: string[];
  skipReason?: "no-skill-needed" | "preflight-failed";
  errorCategory?: string;
}

export interface RouteMessage {
  customType: "jev-skill-router";
  display: false;
  content: string;
  details: RouteDetails;
}

export interface RouteResult {
  content: string;
  details: RouteDetails;
  message?: RouteMessage;
  interpretation?: InterpretationResult;
  classification?: ClassificationResult;
  preflight?: PreflightResult;
}

export interface RouterOptions {
  preflight?: (input: AutomaticRouteInput) => Promise<PreflightResult>;
  classifier: (input: RouterClassificationInput) => Promise<ClassificationResult>;
  interpreter: (input: RouterInterpreterInput) => Promise<InterpretationResult>;
  readFile: (path: string, maxChars: number) => Promise<string>;
}

export function createRouter(options: RouterOptions) {
  const metrics = createSessionMetrics();

  const route = async (
    routeKind: RouteDetails["routeKind"],
    input: AutomaticRouteInput | OnDemandRouteInput
  ): Promise<RouteResult> => {
    const started = performance.now();
    const automaticInput = routeKind === "on-demand" ? undefined : input as AutomaticRouteInput;
    const onDemandInput = routeKind === "on-demand" ? input as OnDemandRouteInput : undefined;
    const automatic = automaticInput !== undefined;
    const context = automaticInput
      ? (automaticInput.context.trim() || automaticInput.currentPrompt)
      : "";
    const userTask = onDemandInput?.task.trim() ?? "";
    const eligible = eligibleSkills(
      new Map(input.registry.map(skill => [skill.name, skill])),
      input.visible,
      input.supplied,
      automatic ? "automatic" : "on-demand"
    );
    let interpretation: InterpretationResult | undefined;
    let classification: ClassificationResult | undefined;
    let preflight: PreflightResult | undefined;
    let selected: SkillProbability[] = [];
    let content = "";
    let loadedSkills: string[] = [];
    let skippedSkills: string[] = [];
    let errorCategory: string | undefined;
    let skipReason: RouteDetails["skipReason"];
    let skipped = false;

    const finish = (): RouteResult => {
      const details: RouteDetails = {
        routeKind,
        suppliedSkills: routeKind === "dry-run" ? [] : loadedSkills,
        selected: selected.map(item => ({ name: item.skill.name, probability: item.probability })),
        candidateCount: eligible.length,
        evaluatedCount: classification?.evaluatedCount ?? 0,
        coverage: classification?.coverage ?? "none",
        interpreterFallback: interpretation?.fallbackUsed ?? false,
        latencyMs: Math.max(0, performance.now() - started),
        skippedSkills,
        ...(skipReason === undefined ? {} : { skipReason }),
        ...(errorCategory === undefined ? {} : { errorCategory })
      };
      const result: RouteResult = {
        content,
        details,
        ...(routeKind === "automatic" && content
          ? { message: { customType: "jev-skill-router", display: false, content, details } }
          : {}),
        ...(interpretation === undefined ? {} : { interpretation }),
        ...(classification === undefined ? {} : { classification }),
        ...(preflight === undefined ? {} : { preflight })
      };
      metrics.recordRoute({
        details,
        ...(interpretation === undefined ? {} : { interpretation }),
        ...(classification === undefined ? {} : { classification }),
        ...(preflight === undefined ? {} : { preflight }),
        loaderFailures: skippedSkills,
        skipped
      }, input.config.jevPricing);
      return result;
    };

    if ((automatic && !automaticInput?.currentPrompt.trim()) || (!automatic && !userTask)) {
      skipped = true;
      errorCategory = "empty-task";
      return finish();
    }
    if (eligible.length === 0) {
      skipped = true;
      return finish();
    }

    let task = userTask;
    if (automatic) {
      if (options.preflight) {
        try {
          preflight = await options.preflight(automaticInput);
        } catch {
          preflight = { needed: false, usage: {}, requests: 0, latencyMs: 0, errorCategory: "provider" };
        }
        if (!preflight.needed || preflight.errorCategory) {
          skipped = true;
          skipReason = preflight.errorCategory ? "preflight-failed" : "no-skill-needed";
          errorCategory = preflight.errorCategory;
          return finish();
        }
      }
      try {
        interpretation = await options.interpreter({ context, config: input.config, ...(input.signal === undefined ? {} : { signal: input.signal }) });
      } catch {
        interpretation = {
          task: context,
          fallbackUsed: true,
          attempts: 0,
          latencyMs: 0,
          errorCategory: "provider"
        };
      }
      task = interpretation.priority
        ? `User priority: ${interpretation.priority}\nTask: ${interpretation.task}`
        : interpretation.task;
      if (interpretation.fallbackUsed && interpretation.errorCategory) errorCategory = interpretation.errorCategory;
    }

    try {
      classification = await options.classifier({
        task,
        skills: eligible,
        config: input.config,
        ...(input.signal === undefined ? {} : { signal: input.signal })
      });
      if (classification.errorCategory) errorCategory ??= classification.errorCategory;
      const eligibleByName = new Map(eligible.map(skill => [skill.name, skill]));
      const seen = new Set<string>();
      selected = classification.selected.flatMap(item => {
        const canonical = eligibleByName.get(item.skill.name);
        if (!canonical || canonical.filePath !== item.skill.filePath || seen.has(item.skill.name)
          || !Number.isFinite(item.probability) || item.probability < 0 || item.probability > 1) return [];
        seen.add(item.skill.name);
        return [{ skill: canonical, probability: item.probability }];
      });
    } catch {
      errorCategory ??= "provider";
      return finish();
    }

    if (selected.length > 0) {
      try {
        const loaded = await loadSkills({
          selected,
          registry: new Map(input.registry.map(skill => [skill.name, skill])),
          readFile: options.readFile,
          maxSkillChars: input.config.maxSkillChars,
          maxLoadedChars: input.config.maxLoadedChars,
          source: routeKind
        });
        content = loaded.content;
        loadedSkills = loaded.suppliedSkills;
        skippedSkills = loaded.skippedSkills;
        if (skippedSkills.length > 0) errorCategory ??= "loader";
      } catch {
        skippedSkills = selected.map(item => item.skill.name);
        errorCategory ??= "loader";
      }
    }

    return finish();
  };

  return {
    routeAutomatic: (input: AutomaticRouteInput) => route("automatic", input),
    routeOnDemand: (input: OnDemandRouteInput) => route("on-demand", input),
    routeDryRun: (input: AutomaticRouteInput) => route("dry-run", input),
    metrics
  };
}
