import type { SessionEntry } from "@earendil-works/pi-coding-agent";

function addSupplied(details: unknown, supplied: Set<string>): void {
  if (!details || typeof details !== "object" || !("suppliedSkills" in details)) return;
  const names = details.suppliedSkills;
  if (!Array.isArray(names)) return;
  for (const name of names) {
    if (typeof name === "string" && name.trim()) supplied.add(name);
  }
}

export function reconstructSuppliedSkills(entries: readonly SessionEntry[]): Set<string> {
  const supplied = new Set<string>();
  for (const entry of entries) {
    if (entry.type === "custom_message" && entry.customType === "jev-skill-router") {
      addSupplied(entry.details, supplied);
    } else if (entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolName === "jev_skill_search") {
      addSupplied(entry.message.details, supplied);
    }
  }
  return supplied;
}
