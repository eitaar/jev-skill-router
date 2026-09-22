import type { Skill, SlashCommandInfo } from "@earendil-works/pi-coding-agent";

export interface SkillRecord {
  name: string;
  description: string;
  filePath: string;
  baseDir: string;
  disableModelInvocation: boolean;
  sourceInfo: { path: string; source: string; scope: string; origin: string; baseDir?: string };
}

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
    const filePath = skill.filePath || skill.sourceInfo.path || command?.sourceInfo.path || "";
    const sourceInfo = !skill.filePath && !skill.sourceInfo.path && command?.sourceInfo.path
      ? { ...skill.sourceInfo, path: command.sourceInfo.path }
      : skill.sourceInfo;
    registry.set(skill.name, {
      name: skill.name,
      description: skill.description,
      filePath,
      baseDir: skill.baseDir,
      disableModelInvocation: skill.disableModelInvocation,
      sourceInfo
    });
  }
  return registry;
}

export function filterVisible(registry: ReadonlyMap<string, SkillRecord>, names: readonly string[]): SkillRecord[] {
  const visibleNames = new Set(names);
  return [...registry.values()].filter(skill => visibleNames.has(skill.name) && !skill.disableModelInvocation);
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
