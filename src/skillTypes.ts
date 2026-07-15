export type SkillTaskType = "analysis" | "artifact";
export type SkillScope = "document" | "selection" | "either";
export type SkillInputPreset = "document" | "document-resources";

export interface SkillPermissionProfile {
  taskType: SkillTaskType;
  scope: SkillScope;
  inputPreset: SkillInputPreset;
  outputExtensions: string[];
  declaredCommands: string[];
  network: false;
  supportedAgents: ["codex"];
  timeoutMinutes: number;
}

export interface SkillPackageInspection {
  sourcePath: string;
  id: string;
  displayName: string;
  description: string;
  hash: string;
  fileCount: number;
  totalBytes: number;
  scriptFiles: string[];
  binaryFiles: string[];
  files: string[];
}

export interface ImportedSkill {
  id: string;
  displayName: string;
  description: string;
  sourcePath: string;
  hash: string;
  snapshotRelativePath: string;
  importedAt: string;
  updatedAt: string;
  enabled: boolean;
  inspection: Pick<SkillPackageInspection, "fileCount" | "totalBytes" | "scriptFiles" | "binaryFiles">;
  permissions: SkillPermissionProfile;
}

export interface SkillTaskProgress {
  stage: "preparing" | "running" | "validating" | "publishing";
  percent: number;
  message: string;
  indeterminate?: boolean;
}

export interface SkillTaskArtifact {
  name: string;
  relativePath: string;
  absolutePath: string;
  type: string;
  description: string;
  size: number;
  sha256: string;
}

export interface SkillTaskResult {
  taskId: string;
  skillId: string;
  skillName: string;
  status: "completed" | "cancelled" | "failed";
  summary: string;
  warnings: string[];
  artifacts: SkillTaskArtifact[];
  publishedDirectory?: string;
  startedAt: string;
  finishedAt: string;
  error?: string;
}

export interface SkillTaskHistoryEntry extends SkillTaskResult {
  agent: string;
  skillHash: string;
  prompt: string;
}
