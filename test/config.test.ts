import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DEFAULT_CONFIG, loadConfig } from "../src/config.js";

async function createConfigFile(path: string, value: unknown): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, JSON.stringify(value));
}

test("missing visibleSkills preserves native catalog and disables routing", async () => {
  const root = await mkdtemp(join(tmpdir(), "jev-router-"));
  const result = await loadConfig({ homeDir: root, cwd: root, projectTrusted: true });
  assert.equal(result.routingConfigured, false);
  assert.equal(result.config.visibleSkills, undefined);
});

test("project config overrides user config and explicit empty visibleSkills enables routing", async () => {
  const root = await mkdtemp(join(tmpdir(), "jev-router-"));
  const homeDir = join(root, "home");
  const cwd = join(root, "project");
  await createConfigFile(join(homeDir, ".pi", "agent", "jev-skill-router.json"), { topK: 2 });
  await createConfigFile(join(cwd, ".pi", "jev-skill-router.json"), { topK: 1, visibleSkills: [] });
  const result = await loadConfig({ homeDir, cwd, projectTrusted: true });
  assert.equal(result.routingConfigured, true);
  assert.deepEqual(result.config.visibleSkills, []);
  assert.equal(result.config.topK, 1);
});

test("untrusted projects do not load project config", async () => {
  const root = await mkdtemp(join(tmpdir(), "jev-router-"));
  await createConfigFile(join(root, ".pi", "jev-skill-router.json"), { visibleSkills: [] });
  const result = await loadConfig({ homeDir: join(root, "home"), cwd: root, projectTrusted: false });
  assert.equal(result.routingConfigured, false);
});

test("configuration rejects invalid values without discarding valid values", async () => {
  const root = await mkdtemp(join(tmpdir(), "jev-router-"));
  await createConfigFile(join(root, ".pi", "agent", "jev-skill-router.json"), {
    enabled: "false",
    threshold: 1.1,
    topK: 2,
    visibleSkills: ["alpha", "alpha"],
    jevPricing: { inputPerMillion: -1, outputPerMillion: 0.4 },
    unknownSetting: true
  });
  const result = await loadConfig({ homeDir: root, cwd: root, projectTrusted: false });
  assert.equal(result.config.enabled, true);
  assert.equal(result.config.threshold, 0.65);
  assert.equal(result.config.topK, 2);
  assert.equal(result.config.visibleSkills, undefined);
  assert.equal(result.config.jevPricing, undefined);
  assert.ok(result.warnings.some(warning => warning.includes('"enabled"') && warning.includes("jev-skill-router.json")));
  assert.ok(result.warnings.some(warning => warning.includes('"threshold"') && warning.includes("jev-skill-router.json")));
  assert.ok(result.warnings.some(warning => warning.includes('"visibleSkills"') && warning.includes("jev-skill-router.json")));
  assert.ok(result.warnings.some(warning => warning.includes('"jevPricing"') && warning.includes("jev-skill-router.json")));
  assert.ok(result.warnings.some(warning => warning.includes('"unknownSetting"') && warning.includes("jev-skill-router.json")));
  assert.ok(result.warnings.every(warning => !warning.includes("false") && !warning.includes("-1")));
});

test("configuration accepts integer limits and ignores values above them", async () => {
  const root = await mkdtemp(join(tmpdir(), "jev-router-"));
  const values = {
    recentUserMessages: 100,
    topK: 100,
    maxContextChars: 100_000,
    interpreterTimeoutMs: 120_000,
    jevTimeoutMs: 120_000,
    jevChunkSize: 500,
    maxSkillChars: 1_000_000,
    maxLoadedChars: 5_000_000
  };
  await createConfigFile(join(root, ".pi", "agent", "jev-skill-router.json"), values);
  const result = await loadConfig({ homeDir: root, cwd: root, projectTrusted: false });
  assert.deepEqual(Object.fromEntries(Object.keys(values).map(key => [key, result.config[key as keyof typeof result.config]])), values);

  await createConfigFile(join(root, ".pi", "agent", "jev-skill-router.json"), Object.fromEntries(Object.keys(values).map(key => [key, (values as Record<string, number>)[key]! + 1])));
  const overLimit = await loadConfig({ homeDir: root, cwd: root, projectTrusted: false });
  for (const [key, value] of Object.entries(values)) {
    const configKey = key as keyof typeof DEFAULT_CONFIG;
    assert.equal(overLimit.config[configKey], DEFAULT_CONFIG[configKey]);
    assert.ok(overLimit.warnings.some(warning => warning.includes(`"${key}"`)));
    assert.ok(value > 0);
  }
});

test("session overrides apply after file configuration", async () => {
  const root = await mkdtemp(join(tmpdir(), "jev-router-"));
  await createConfigFile(join(root, ".pi", "agent", "jev-skill-router.json"), { enabled: true, debug: false });
  const result = await loadConfig({
    homeDir: root,
    cwd: root,
    projectTrusted: false,
    overrides: { enabled: false, debug: true }
  });
  assert.equal(result.config.enabled, false);
  assert.equal(result.config.debug, true);
});
