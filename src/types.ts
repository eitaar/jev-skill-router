export interface RouterConfig {
  enabled: boolean;
  autoRouting: boolean;
  interpreterModel: string;
  interpreterThinking: "low";
  recentUserMessages: number;
  visibleSkills?: string[];
  threshold: number;
  topK: number;
  maxContextChars: number;
  interpreterTimeoutMs: number;
  jevTimeoutMs: number;
  jevModel: string;
  debug: boolean;
  jevChunkSize: number;
  maxSkillChars: number;
  maxLoadedChars: number;
  jevPricing?: { inputPerMillion: number; outputPerMillion: number };
}

export interface SessionOverrides {
  enabled?: boolean;
  autoRouting?: boolean;
  debug?: boolean;
}

export interface ConfigResult {
  config: RouterConfig;
  routingConfigured: boolean;
  warnings: string[];
}
