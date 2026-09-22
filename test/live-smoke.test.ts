import assert from "node:assert/strict";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import test from "node:test";
import type { Api, AssistantMessage, Context, Credential, CredentialInfo, CredentialStore, Model, SimpleStreamOptions } from "@earendil-works/pi-ai";
import { getAgentDir, ModelRegistry, ModelRuntime, readStoredCredential } from "@earendil-works/pi-coding-agent";
import { TypeSafeClient } from "@typesafe-ai/sdk";
import { DEFAULT_CONFIG } from "../src/config.js";
import { interpretTask, type InterpreterRegistry } from "../src/interpreter.js";
import { adaptTypeSafeClient, classifySkills, type JevClientLike } from "../src/jev.js";
import { makeSkillRecords } from "./helpers.js";

const apiKey = process.env.TYPESAFE_API_KEY?.trim();
const credentialGate = Boolean(apiKey);

test("live Luna and Jev adapters return their documented shapes", { skip: !credentialGate }, async () => {
  const result = await runLiveSmoke(apiKey!);
  assert.ok(result.interpretedTask.length > 0);
  assert.ok(Number.isInteger(result.jevUsage.inputTokens));
  assert.ok(Number.isInteger(result.jevUsage.outputTokens));
  assert.equal(result.mainModelChanged, false);

  console.log(JSON.stringify({
    models: result.models,
    selectedNames: result.selectedNames,
    interpreterUsage: result.interpreterUsage,
    jevUsage: result.jevUsage,
    latencyMs: result.latencyMs
  }));
});

async function runLiveSmoke(key: string) {
  const startedAt = performance.now();
  const piRegistry = new ModelRegistry(await ModelRuntime.create({
    credentials: readOnlyPiCredentials(),
    allowModelNetwork: false
  }));
  let lunaProviderError: unknown;
  const interpreterRegistry: InterpreterRegistry = {
    getAvailable: () => piRegistry.getAvailable(),
    streamSimple(model: Model<Api>, context: Context, options?: SimpleStreamOptions) {
      const stream = piRegistry.streamSimple(model, context, options);
      return {
        result: async (): Promise<AssistantMessage> => {
          try {
            return await stream.result();
          } catch (error) {
            lunaProviderError = error;
            throw error;
          }
        }
      };
    }
  };
  const interpretation = await interpretTask({
    registry: interpreterRegistry,
    modelRef: DEFAULT_CONFIG.interpreterModel,
    context: "Current request: Improve keyboard focus visibility in a small React settings form.",
    timeoutMs: DEFAULT_CONFIG.interpreterTimeoutMs
  });
  if (interpretation.fallbackUsed) {
    const detail = lunaProviderError
      ? sanitizeError(lunaProviderError, key)
      : interpretation.errorCategory ?? "unknown interpreter failure";
    throw new Error(`Luna smoke request failed (${detail})`);
  }

  let jevProviderError: unknown;
  const typeSafeClient = adaptTypeSafeClient(new TypeSafeClient({ apiKey: key }));
  const client: JevClientLike = {
    systemOne(request, options) {
      return typeSafeClient.systemOne(request, options).catch(error => {
        jevProviderError = error;
        throw error;
      });
    }
  };
  const classification = await classifySkills({
    client,
    task: interpretation.task,
    skills: makeSkillRecords(["accessibility", "frontend-design"]),
    threshold: DEFAULT_CONFIG.threshold,
    topK: 2,
    model: DEFAULT_CONFIG.jevModel,
    timeoutMs: DEFAULT_CONFIG.jevTimeoutMs,
    chunkSize: DEFAULT_CONFIG.jevChunkSize
  });
  if (classification.coverage !== "complete" || classification.evaluatedCount !== 2) {
    const detail = jevProviderError
      ? sanitizeError(jevProviderError, key)
      : classification.errorCategory ?? "incomplete classification coverage";
    throw new Error(`Jev smoke request failed (${detail})`);
  }
  if (!Number.isSafeInteger(classification.usage.inputTokens) || !Number.isSafeInteger(classification.usage.outputTokens)) {
    throw new Error("Jev response did not include integer usage token counts");
  }

  return {
    interpretedTask: interpretation.task,
    interpreterUsage: {
      inputTokens: interpretation.usage?.input,
      outputTokens: interpretation.usage?.output
    },
    jevUsage: {
      inputTokens: classification.usage.inputTokens,
      outputTokens: classification.usage.outputTokens
    },
    selectedNames: classification.selected.map(item => item.skill.name),
    models: { interpreter: DEFAULT_CONFIG.interpreterModel, jev: DEFAULT_CONFIG.jevModel },
    latencyMs: {
      interpreter: interpretation.latencyMs,
      jev: classification.latencyMs,
      total: performance.now() - startedAt
    },
    mainModelChanged: false
  };
}

function readOnlyPiCredentials(): CredentialStore {
  const credentials = new Map<string, Credential>();
  const codexCredential = readStoredCredential("openai-codex", join(getAgentDir(), "auth.json"));
  if (codexCredential) credentials.set("openai-codex", codexCredential);

  return {
    async read(providerId, options) {
      options?.signal?.throwIfAborted();
      const credential = credentials.get(providerId);
      return credential === undefined ? undefined : structuredClone(credential);
    },
    async list(options) {
      options?.signal?.throwIfAborted();
      return [...credentials].map(([providerId, credential]): CredentialInfo => ({ providerId, type: credential.type }));
    },
    async modify(providerId, update, options) {
      options?.signal?.throwIfAborted();
      const updated = await update(credentials.get(providerId));
      options?.signal?.throwIfAborted();
      if (updated === undefined) credentials.delete(providerId);
      else credentials.set(providerId, structuredClone(updated));
      const current = credentials.get(providerId);
      return current === undefined ? undefined : structuredClone(current);
    },
    async delete(providerId, options) {
      options?.signal?.throwIfAborted();
      credentials.delete(providerId);
    }
  };
}

function sanitizeError(error: unknown, secret: string): string {
  const name = error instanceof Error ? error.name : "Error";
  let message = error instanceof Error ? error.message : String(error);
  if (secret) message = message.replaceAll(secret, "[REDACTED]");
  message = message
    .replace(/Bearer\s+\S+/gi, "Bearer [REDACTED]")
    .replace(/(api[_-]?key|access[_-]?token|refresh[_-]?token)(\s*[:=]\s*)[^\s,;"']+/gi, "$1$2[REDACTED]")
    .replace(/[\r\n]+/g, " ")
    .slice(0, 500);
  return `${name}: ${message || "provider request failed"}`;
}
