import { readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import type { ConfigResult, RouterConfig, SessionOverrides } from "./types.js";

export const DEFAULT_CONFIG = {
  enabled: true,
  autoRouting: true,
  interpreterModel: "openai-codex/gpt-6-luna",
  interpreterThinking: "low",
  recentUserMessages: 4,
  threshold: 0.65,
  topK: 3,
  maxContextChars: 5000,
  interpreterTimeoutMs: 15000,
  jevTimeoutMs: 15000,
  jevModel: "jev-latest",
  debug: false,
  jevChunkSize: 50,
  maxSkillChars: 50000,
  maxLoadedChars: 120000
} as const;

const CONFIG_FILE = "jev-skill-router.json";

const INTEGER_LIMITS = {
  recentUserMessages: [1, 100],
  topK: [1, 100],
  maxContextChars: [1, 100_000],
  interpreterTimeoutMs: [1, 120_000],
  jevTimeoutMs: [1, 120_000],
  jevChunkSize: [1, 500],
  maxSkillChars: [1, 1_000_000],
  maxLoadedChars: [1, 5_000_000]
} as const;

type IntegerConfigKey = keyof typeof INTEGER_LIMITS;

const CONFIG_KEYS = new Set([
  "enabled",
  "autoRouting",
  "interpreterModel",
  "interpreterThinking",
  "recentUserMessages",
  "visibleSkills",
  "threshold",
  "topK",
  "maxContextChars",
  "interpreterTimeoutMs",
  "jevTimeoutMs",
  "jevModel",
  "debug",
  "jevChunkSize",
  "maxSkillChars",
  "maxLoadedChars",
  "jevPricing"
]);

const BOOLEAN_KEYS = new Set(["enabled", "autoRouting", "debug"]);
const SESSION_OVERRIDE_KEYS = ["enabled", "autoRouting", "debug"] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function warningSource(source: string): string {
  return `${source} (${CONFIG_FILE})`;
}

function warningKey(key: string): string {
  return JSON.stringify(key.slice(0, 100));
}

function applyFileValue(config: RouterConfig, key: string, value: unknown): boolean {
  if (BOOLEAN_KEYS.has(key)) {
    if (typeof value !== "boolean") return false;
    config[key as "enabled" | "autoRouting" | "debug"] = value;
    return true;
  }

  if (Object.hasOwn(INTEGER_LIMITS, key)) {
    const integerKey = key as IntegerConfigKey;
    const [minimum, maximum] = INTEGER_LIMITS[integerKey];
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum || value > maximum) return false;
    config[integerKey] = value;
    return true;
  }

  if (key === "interpreterModel" || key === "jevModel") {
    if (typeof value !== "string" || value.trim().length === 0) return false;
    config[key] = value;
    return true;
  }

  if (key === "interpreterThinking") {
    if (value !== "low") return false;
    config.interpreterThinking = value;
    return true;
  }

  if (key === "threshold") {
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) return false;
    config.threshold = value;
    return true;
  }

  if (key === "visibleSkills") {
    if (!Array.isArray(value) || !value.every(skill => typeof skill === "string" && skill.trim().length > 0)) return false;
    if (new Set(value).size !== value.length) return false;
    config.visibleSkills = [...value];
    return true;
  }

  if (key === "jevPricing") {
    if (!isRecord(value) || Object.keys(value).some(priceKey => priceKey !== "inputPerMillion" && priceKey !== "outputPerMillion")) return false;
    const inputPerMillion = value.inputPerMillion;
    const outputPerMillion = value.outputPerMillion;
    if (typeof inputPerMillion !== "number" || !Number.isFinite(inputPerMillion) || inputPerMillion < 0) return false;
    if (typeof outputPerMillion !== "number" || !Number.isFinite(outputPerMillion) || outputPerMillion < 0) return false;
    config.jevPricing = { inputPerMillion, outputPerMillion };
    return true;
  }

  return false;
}

async function loadFile(config: RouterConfig, filePath: string, source: string, warnings: string[]): Promise<void> {
  let text: string;
  try {
    text = await readFile(filePath, "utf8");
  } catch (error) {
    if (isRecord(error) && error.code === "ENOENT") return;
    warnings.push(`could not read ${warningSource(source)}`);
    return;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    warnings.push(`invalid JSON in ${warningSource(source)}`);
    return;
  }

  if (!isRecord(parsed)) {
    warnings.push(`invalid configuration object in ${warningSource(source)}`);
    return;
  }

  for (const [key, value] of Object.entries(parsed)) {
    if (!CONFIG_KEYS.has(key)) {
      warnings.push(`ignored unknown key ${warningKey(key)} in ${warningSource(source)}`);
    } else if (!applyFileValue(config, key, value)) {
      warnings.push(`ignored invalid ${warningKey(key)} in ${warningSource(source)}`);
    }
  }
}

function applySessionOverrides(config: RouterConfig, overrides: SessionOverrides | undefined, warnings: string[]): void {
  if (overrides === undefined) return;
  if (!isRecord(overrides)) {
    warnings.push("ignored invalid session overrides");
    return;
  }

  for (const key of SESSION_OVERRIDE_KEYS) {
    if (!Object.hasOwn(overrides, key)) continue;
    const value = overrides[key];
    if (typeof value !== "boolean") {
      warnings.push(`ignored invalid ${warningKey(key)} in session overrides`);
      continue;
    }
    config[key] = value;
  }
}

export async function loadConfig(options: {
  homeDir: string;
  cwd: string;
  projectTrusted: boolean;
  overrides?: SessionOverrides;
}): Promise<ConfigResult> {
  const config: RouterConfig = { ...DEFAULT_CONFIG };
  const warnings: string[] = [];

  await loadFile(config, join(options.homeDir, ".pi", "agent", CONFIG_FILE), "user config", warnings);
  if (options.projectTrusted) {
    await loadFile(config, join(options.cwd, ".pi", CONFIG_FILE), "project config", warnings);
  }
  applySessionOverrides(config, options.overrides, warnings);

  return { config, routingConfigured: Object.hasOwn(config, "visibleSkills"), warnings };
}
