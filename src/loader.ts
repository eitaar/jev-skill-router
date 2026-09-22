import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import type { SkillProbability } from "./jev.js";
import type { SkillRecord } from "./registry.js";

export interface LoadSkillsInput {
  selected: readonly SkillProbability[];
  registry: ReadonlyMap<string, SkillRecord>;
  readFile: (path: string, maxChars: number) => Promise<string>;
  maxSkillChars: number;
  maxLoadedChars: number;
  source: "automatic" | "on-demand" | "dry-run";
}

export interface LoadSkillsResult {
  content: string;
  suppliedSkills: string[];
  skippedSkills: string[];
}

function charCount(text: string): number {
  return Array.from(text).length;
}

export async function readUtf8StreamBounded(chunks: AsyncIterable<string>, maxChars: number): Promise<string> {
  if (!Number.isSafeInteger(maxChars) || maxChars < 0) throw new RangeError("Invalid character limit");

  const parts: string[] = [];
  let characters = 0;
  for await (const chunk of chunks) {
    const chunkCharacters = Array.from(chunk).length;
    if (characters + chunkCharacters > maxChars) throw new RangeError("Skill file exceeds the character limit");
    parts.push(chunk);
    characters += chunkCharacters;
  }
  return parts.join("");
}

export function readUtf8FileBounded(path: string, maxChars: number): Promise<string> {
  if (!Number.isSafeInteger(maxChars) || maxChars < 0) throw new RangeError("Invalid character limit");
  const highWaterMark = Math.min(64 * 1024, Math.max(4, (maxChars + 1) * 4));
  return readUtf8StreamBounded(createReadStream(path, { encoding: "utf8", highWaterMark }), maxChars);
}

function escapeAttribute(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("'", "&apos;");
}

function fenceToken(name: string, body: string): string {
  const digest = createHash("sha256").update(name).update("\0").update(body).digest("hex");
  const base = `jev-skill-${digest}`;
  let token = base;
  let suffix = 0;
  while (body.includes(token)) token = `${base}-${++suffix}`;
  return token;
}

function skillBlock(skill: SkillRecord, body: string): string {
  const token = fenceToken(skill.name, body);
  return `<skill name="${escapeAttribute(skill.name)}" path="${escapeAttribute(skill.filePath)}">\n<<<${token}>>>\n${body}\n<<<${token}>>>\n</skill>`;
}

export async function loadSkills(input: LoadSkillsInput): Promise<LoadSkillsResult> {
  const suppliedSkills: string[] = [];
  const skippedSkills: string[] = [];
  const blocks: string[] = [];
  const visited = new Set<string>();
  const wrapperStart = `<jev_routed_skills source="${input.source}">`;
  const wrapperEnd = "</jev_routed_skills>";

  for (let index = 0; index < input.selected.length; index++) {
    const candidate = input.selected[index]!;
    const name = candidate.skill.name;
    if (visited.has(name)) continue;
    visited.add(name);

    const skill = input.registry.get(name);
    if (!skill || skill.filePath !== candidate.skill.filePath) {
      skippedSkills.push(name);
      continue;
    }

    let body: string;
    try {
      body = await input.readFile(skill.filePath, input.maxSkillChars);
      if (typeof body !== "string" || charCount(body) > input.maxSkillChars) {
        skippedSkills.push(name);
        continue;
      }
    } catch {
      skippedSkills.push(name);
      continue;
    }

    const block = skillBlock(skill, body);
    const nextContent = [wrapperStart, ...blocks, block, wrapperEnd].join("\n");
    if (charCount(nextContent) > input.maxLoadedChars) {
      skippedSkills.push(name);
      for (const remaining of input.selected.slice(index + 1)) {
        if (!visited.has(remaining.skill.name)) {
          visited.add(remaining.skill.name);
          skippedSkills.push(remaining.skill.name);
        }
      }
      break;
    }
    blocks.push(block);
    suppliedSkills.push(name);
  }

  return {
    content: blocks.length > 0 ? [wrapperStart, ...blocks, wrapperEnd].join("\n") : "",
    suppliedSkills,
    skippedSkills
  };
}
