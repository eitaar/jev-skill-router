import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename } from "node:path";
import { AuthenticationError, TypeSafeClient } from "@typesafe-ai/sdk";
import { Type } from "typebox";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadConfig } from "../src/config.js";
import { collectInterpretationContext } from "../src/context.js";
import { interpretTask } from "../src/interpreter.js";
import { adaptTypeSafeClient, classifySkills, type JevClientLike } from "../src/jev.js";
import { filterVisible, captureRegistry, type SkillRecord } from "../src/registry.js";
import { createRouter, type RouteDetails, type RouteResult, type RouterOptions } from "../src/router.js";
import { reconstructSuppliedSkills } from "../src/state.js";
import type { SessionOverrides } from "../src/types.js";

export interface JevSkillRouterOptions {
  homeDir?: string;
  jevClient?: JevClientLike;
}

type Router = ReturnType<typeof createRouter>;

function textResult(text: string, details: unknown = {}): { content: [{ type: "text"; text: string }]; details: unknown } {
  return { content: [{ type: "text", text }], details };
}

function errorResult(routeKind: RouteDetails["routeKind"], errorCategory: string, message: string) {
  return textResult(message, { routeKind, suppliedSkills: [], selected: [], errorCategory });
}

function isSubstantive(text: string): boolean {
  return text.trim().length > 0;
}

function statusText(
  ctx: ExtensionContext,
  config: Awaited<ReturnType<typeof loadConfig>>["config"],
  routingConfigured: boolean,
  registry: ReadonlyMap<string, SkillRecord> | undefined,
  lastRoute: RouteDetails | undefined
): string {
  let lunaAvailable = false;
  try {
    const slash = config.interpreterModel.indexOf("/");
    const provider = config.interpreterModel.slice(0, slash);
    const modelId = config.interpreterModel.slice(slash + 1);
    lunaAvailable = ctx.modelRegistry.getAvailable().some(model => model.provider === provider && model.id === modelId);
  } catch {
    // Provider state can be unavailable during session startup.
  }

  const skills = [...(registry?.values() ?? [])];
  const advertisable = skills.filter(skill => !skill.disableModelInvocation);
  const visibleNames = config.visibleSkills;
  const visibleCount = visibleNames
    ? advertisable.filter(skill => visibleNames.includes(skill.name)).length
    : advertisable.length;
  return [
    `Configuration: ${JSON.stringify(config)}`,
    `Routing configured: ${routingConfigured ? "yes" : "no"}; enabled: ${config.enabled ? "yes" : "no"}; automatic: ${config.autoRouting ? "on" : "off"}`,
    `Skills: ${skills.length} discovered, ${visibleCount} visible, ${advertisable.length - visibleCount} hidden, ${skills.length - advertisable.length} manual-only`,
    `Interpreter ${config.interpreterModel}: ${lunaAvailable ? "available" : "unavailable"}; TypeSafe key: ${process.env.TYPESAFE_API_KEY?.trim() ? "present" : "missing"}`,
    `Last route: ${lastRoute ? `${lastRoute.routeKind}, ${lastRoute.evaluatedCount}/${lastRoute.candidateCount} evaluated, ${lastRoute.coverage}, selected ${lastRoute.selected.map(item => item.name).join(", ") || "none"}${lastRoute.errorCategory ? `, error ${lastRoute.errorCategory}` : ""}` : "none"}`
  ].join("\n");
}

function dryRunText(task: string, result: RouteResult): string {
  const scores = result.classification?.scores.map(item => `${item.skill.name} ${item.probability.toFixed(3)}`).join(", ") || "none";
  const selected = result.details.selected.map(item => item.name).join(", ") || "none";
  const interpreted = result.interpretation?.task ?? task;
  return [
    `Task: ${interpreted}`,
    `Candidates/evaluated: ${result.details.candidateCount}/${result.details.evaluatedCount}`,
    `Scores: ${scores}`,
    `Selected: ${selected}`,
    `Coverage: ${result.details.coverage}${result.details.errorCategory ? `; error: ${result.details.errorCategory}` : ""}`,
    `Latency: ${result.details.latencyMs.toFixed(1)} ms`
  ].join("\n");
}

export function registerJevSkillRouter(pi: ExtensionAPI, options: JevSkillRouterOptions = {}): void {
  const homeDir = options.homeDir ?? homedir();
  const routers = new WeakMap<object, Router>();
  let sessionOverrides: SessionOverrides = {};
  let registry: Map<string, SkillRecord> | undefined;
  let lastRoute: RouteDetails | undefined;
  let lastRouter: Router | undefined;
  let sdkClient: JevClientLike | undefined;

  const loadEffectiveConfig = async (ctx: ExtensionContext) => {
    const result = await loadConfig({
      homeDir,
      cwd: ctx.cwd,
      projectTrusted: ctx.isProjectTrusted(),
      overrides: sessionOverrides
    });
    return result;
  };

  const getJevClient = (): JevClientLike => {
    if (options.jevClient) return options.jevClient;
    const apiKey = process.env.TYPESAFE_API_KEY?.trim();
    if (!apiKey) throw new AuthenticationError(401, { error: "TYPESAFE_API_KEY is not configured" }, new Headers(), "TYPESAFE_API_KEY is not configured");
    sdkClient ??= adaptTypeSafeClient(new TypeSafeClient({ apiKey }));
    return sdkClient;
  };

  const getRouter = (ctx: ExtensionContext): Router => {
    const key = ctx.modelRegistry as object;
    let router = routers.get(key);
    if (!router) {
      const dependencies: RouterOptions = {
        interpreter: input => interpretTask({
          registry: ctx.modelRegistry,
          modelRef: input.config.interpreterModel,
          context: input.context,
          timeoutMs: input.config.interpreterTimeoutMs,
          ...(input.signal === undefined ? {} : { signal: input.signal })
        }),
        classifier: input => {
          if (!options.jevClient && !process.env.TYPESAFE_API_KEY?.trim()) {
            return Promise.resolve({
              scores: [],
              selected: [],
              coverage: "none",
              candidateCount: input.skills.length,
              evaluatedCount: 0,
              invalidAnswers: 0,
              usage: {},
              requests: 0,
              latencyMs: 0,
              errorCategory: "authentication"
            });
          }
          return classifySkills({
            client: getJevClient(),
            task: input.task,
            skills: input.skills,
            threshold: input.config.threshold,
            topK: input.config.topK,
            model: input.config.jevModel,
            timeoutMs: input.config.jevTimeoutMs,
            chunkSize: input.config.jevChunkSize,
            ...(input.signal === undefined ? {} : { signal: input.signal })
          });
        },
        readFile: path => readFile(path, "utf8")
      };
      router = createRouter(dependencies);
      routers.set(key, router);
    }
    lastRouter = router;
    return router;
  };

  const runRoute = async (
    ctx: ExtensionContext,
    task: string,
    routeKind: "automatic" | "on-demand" | "dry-run",
    signal?: AbortSignal,
    configResult?: Awaited<ReturnType<typeof loadConfig>>
  ): Promise<RouteResult | undefined> => {
    const effective = configResult ?? await loadEffectiveConfig(ctx);
    if (!effective.routingConfigured || !effective.config.visibleSkills) return undefined;
    if (!effective.config.enabled || (routeKind === "automatic" && !effective.config.autoRouting)) return undefined;
    if (!registry) return undefined;

    const entries = ctx.sessionManager.buildContextEntries();
    const supplied = reconstructSuppliedSkills(entries);
    const visible = new Set(effective.config.visibleSkills);
    const routeInput = {
      config: effective.config,
      registry: [...registry.values()],
      visible,
      supplied,
      ...(signal === undefined ? {} : { signal })
    };
    const router = getRouter(ctx);
    const result = routeKind === "on-demand"
      ? await router.routeOnDemand({ ...routeInput, task })
      : await (routeKind === "dry-run" ? router.routeDryRun : router.routeAutomatic)({
        ...routeInput,
        currentPrompt: task,
        context: collectInterpretationContext({
          current: task,
          entries,
          projectName: basename(ctx.cwd),
          supplied: [...supplied],
          maxChars: effective.config.maxContextChars,
          recentUserMessages: effective.config.recentUserMessages
        })
      });
    lastRoute = result.details;
    if (effective.config.debug && ctx.hasUI) {
      const selected = result.details.selected.map(item => item.name).join(", ") || "none";
      ctx.ui.notify(`Jev ${routeKind}: ${result.details.evaluatedCount}/${result.details.candidateCount} evaluated, ${result.details.coverage}, selected ${selected}${result.details.errorCategory ? `, error ${result.details.errorCategory}` : ""}`, "info");
    }
    return result;
  };

  pi.on("before_agent_start", async (event, ctx) => {
    try {
      const effective = await loadEffectiveConfig(ctx);
      registry = captureRegistry(event.systemPromptOptions.skills, pi.getCommands());
      if (!effective.routingConfigured || !effective.config.visibleSkills) return;
      event.systemPromptOptions.skills = filterVisible(registry, effective.config.visibleSkills);
      if (!effective.config.enabled || !effective.config.autoRouting || !isSubstantive(event.prompt)) return;
      const result = await runRoute(ctx, event.prompt, "automatic", ctx.signal, effective);
      return result?.message ? { message: result.message } : undefined;
    } catch {
      return undefined;
    }
  });

  pi.registerTool({
    name: "jev_skill_search",
    label: "Jev Skill Search",
    description: "Search hidden Pi skills for a concise task intent and return relevant trusted SKILL.md instructions in this tool result. No match is valid.",
    promptSnippet: "Search hidden Pi skills when the current instructions are insufficient",
    promptGuidelines: ["Use jev_skill_search with a concise task intent when a useful hidden skill may exist; it returns selected instructions directly."],
    parameters: Type.Object({ task: Type.String({ minLength: 1, maxLength: 1000 }) }),
    async execute(_id, params, signal, _update, ctx) {
      const task = params.task.trim();
      if (!task) return textResult(
        "No task supplied; continue without additional skills or invoke a native /skill:name command.",
        { errorCategory: "empty-task", suppliedSkills: [] }
      );
      try {
        const result = await runRoute(ctx, task, "on-demand", signal);
        if (!result) return errorResult("on-demand", "not-ready", "Skill routing is not configured or the Pi skill registry is not ready.");
        const text = result.content || (result.details.errorCategory
          ? `Skill search could not complete (${result.details.errorCategory}); continue with the current instructions or use a native /skill:name command.`
          : "No relevant hidden skill matched.");
        return textResult(text, result.details);
      } catch {
        return errorResult("on-demand", "provider", "Skill search is unavailable; continue with the current instructions or invoke a native /skill:name command.");
      }
    }
  });

  pi.registerCommand("jev-skills", {
    description: "Configure and inspect semantic skill routing",
    async handler(args, ctx: ExtensionCommandContext) {
      const [action, ...rest] = args.trim().split(/\s+/).filter(Boolean);
      const task = rest.join(" ");
      let message: string;

      if (action === "on" && rest.length === 0) {
        sessionOverrides = { ...sessionOverrides, autoRouting: true };
        message = "Automatic skill routing enabled for this session.";
      } else if (action === "off" && rest.length === 0) {
        sessionOverrides = { ...sessionOverrides, autoRouting: false };
        message = "Automatic skill routing disabled for this session.";
      } else if (action === "debug" && (rest.join(" ") === "on" || rest.join(" ") === "off")) {
        sessionOverrides = { ...sessionOverrides, debug: rest[0] === "on" };
        message = `Debug ${rest[0] === "on" ? "enabled" : "disabled"} for this session.`;
      } else if (action === "status" && rest.length === 0) {
        const effective = await loadEffectiveConfig(ctx);
        message = statusText(ctx, effective.config, effective.routingConfigured, registry, lastRoute);
      } else if (action === "stats" && rest.length === 0) {
        message = lastRouter?.metrics.formatStats() ?? "No router metrics are available yet.";
      } else if (action === "test" && task) {
        try {
          const result = await runRoute(ctx, task, "dry-run");
          message = result ? dryRunText(task, result) : "Routing is not configured or no registry is ready.";
        } catch {
          message = "Dry-run routing failed safely.";
        }
      } else {
        message = "Usage: /jev-skills on|off|status|debug on|debug off|test <task>|stats";
      }

      if (ctx.hasUI) ctx.ui.notify(message, "info");
    }
  });
}

export default function jevSkillRouterExtension(pi: ExtensionAPI): void {
  registerJevSkillRouter(pi);
}
