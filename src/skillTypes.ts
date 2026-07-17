export type SkillTaskType = "analysis" | "artifact";
export type SkillScope = "document" | "selection" | "either";
export type SkillInputPreset = "document" | "document-resources" | "document-workspace";

export interface SkillPermissionProfile {
  taskType: SkillTaskType;
  scope: SkillScope;
  inputPreset: SkillInputPreset;
  outputExtensions: string[];
  declaredCommands: string[];
  network: false;
  supportedAgents: ["codex"];
  timeoutMinutes: number;
  writableWorkDirectory?: boolean;
  agentIndependent?: boolean;
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
  detail?: SkillProgressStage;
  elapsedSeconds?: number;
  estimatedRemainingSeconds?: number;
  metrics?: Record<string, number>;
}

export interface SkillProgressStage {
  id: string;
  label: string;
  state: "pending" | "running" | "completed" | "failed";
  current?: number;
  total?: number;
  unit?: string;
}

export interface SkillRunnerProgress extends Omit<SkillTaskProgress, "stage"> {}

export interface SkillTaskQualityGate {
  id: string;
  label: string;
  status: "passed" | "failed";
  value: string;
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
  qualityGates?: SkillTaskQualityGate[];
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
