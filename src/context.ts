import { basename } from "node:path";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";

export interface InterpretationContextInput {
  current: string;
  entries: readonly SessionEntry[];
  projectName: string;
  supplied: readonly string[];
  maxChars: number;
  recentUserMessages: number;
}

function userText(entry: SessionEntry): string | undefined {
  if (entry.type !== "message" || entry.message.role !== "user") return undefined;
  const { content } = entry.message;
  if (typeof content === "string") return content;
  const blocks: string[] = [];
  for (const block of content) {
    if (block.type === "text") blocks.push(block.text);
    else if (block.type === "image") blocks.push("[image attached]");
  }
  return blocks.join(" ");
}

function truncate(text: string, maxChars: number): string {
  const chars = Array.from(text);
  const limit = Math.max(0, Math.floor(maxChars));
  if (chars.length <= limit) return text;
  const marker = "[truncated]";
  if (limit > marker.length) return `${chars.slice(0, limit - marker.length - 1).join("")} ${marker}`;
  return limit > 0 ? `${chars.slice(0, limit - 1).join("")}…` : "";
}

export function collectInterpretationContext(input: InterpretationContextInput): string {
  const sections = [`Current request: ${input.current}`];
  const project = basename(input.projectName.replaceAll("\\", "/"));
  if (project) sections.push(`Project: ${project}`);
  const supplied = [...new Set(input.supplied.filter(name => name.trim().length > 0))];
  if (supplied.length > 0) sections.push(`Supplied skills: ${supplied.join(", ")}`);

  const recent: string[] = [];
  for (let index = input.entries.length - 1; index >= 0 && recent.length < input.recentUserMessages; index--) {
    const text = userText(input.entries[index]!);
    if (text && text.trim() && text.trim() !== input.current.trim()) recent.push(text);
  }
  for (const text of recent) sections.push(`Previous user request: ${text}`);

  return truncate(sections.join("\n"), input.maxChars);
}
