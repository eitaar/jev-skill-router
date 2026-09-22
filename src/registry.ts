import type { Skill, SlashCommandInfo } from "@earendil-works/pi-coding-agent";

export type SkillRecord = Skill;

export function captureRegistry(skills: readonly Skill[], commands: readonly SlashCommandInfo[]): Map<string, SkillRecord> {
  const skillCommands = new Map<string, SlashCommandInfo>();
  for (const command of commands) {
    if (command.source === "skill" && !skillCommands.has(command.name)) {
      skillCommands.set(command.name, command);
    }
  }

  const registry = new Map<string, SkillRecord>();
  for (const skill of skills) {
    const command = skillCommands.get(`skill:${skill.name}`);
    const canonicalPath = skill.filePath || skill.sourceInfo.path || command?.sourceInfo.path;
    if (canonicalPath) {
      if (!skill.filePath) skill.filePath = canonicalPath;
      if (!skill.sourceInfo.path) skill.sourceInfo.path = canonicalPath;
    }
    registry.set(skill.name, skill);
  }
  return registry;
}

export function filterVisible(registry: ReadonlyMap<string, SkillRecord>, names: readonly string[]): SkillRecord[] {
  const visibleNames = new Set(names);
  return [...registry.values()].filter(skill => visibleNames.has(skill.name) && !skill.disableModelInvocation);
}

export function resolveVisibleSkills(registry: ReadonlyMap<string, SkillRecord>, configured: readonly string[]) {
  const normalSkills = [...registry.values()].filter(skill => !skill.disableModelInvocation).map(skill => skill.name);
  const knownNames = new Set(normalSkills);
  const visibleNames = configured.filter(name => knownNames.has(name));
  const unknownNames = configured.filter(name => !knownNames.has(name));
  const fallbackToNative = configured.length > 0 && visibleNames.length === 0;
  return {
    visibleNames: fallbackToNative ? normalSkills : visibleNames,
    unknownNames,
    fallbackToNative
  };
}

export function eligibleSkills(
  registry: ReadonlyMap<string, SkillRecord>,
  visible: ReadonlySet<string>,
  supplied: ReadonlySet<string>,
  mode: "automatic" | "on-demand"
): SkillRecord[] {
  return [...registry.values()]
    .filter(skill => !visible.has(skill.name) && !supplied.has(skill.name) && (mode === "on-demand" || !skill.disableModelInvocation))
    .sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
}
