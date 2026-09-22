import type { Skill } from "@earendil-works/pi-coding-agent";

export function makeSkills(count: number, options: { manualOnly?: readonly number[] } = {}): Skill[] {
  return Array.from({ length: count }, (_, index) => {
    const name = `skill-${String(index).padStart(3, "0")}`;
    const baseDir = `C:/skills/${name}`;
    const filePath = `${baseDir}/SKILL.md`;
    return {
      name,
      description: `Instructions for ${name}`,
      filePath,
      baseDir,
      disableModelInvocation: options.manualOnly?.includes(index) ?? false,
      sourceInfo: {
        path: filePath,
        source: "local",
        scope: "user",
        origin: "top-level",
        baseDir
      }
    };
  });
}
