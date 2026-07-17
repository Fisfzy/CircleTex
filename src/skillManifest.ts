import * as fs from "node:fs/promises";
import * as path from "node:path";
import { SkillInputPreset, SkillPermissionProfile, SkillScope, SkillTaskType } from "./skillTypes";

interface SkillManifestFile {
  version: 1;
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

export async function readSkillPermissionManifest(sourcePath: string): Promise<SkillPermissionProfile | undefined> {
  const filePath = path.join(sourcePath, "circletex.skill.json");
  let value: unknown;
  try {
    value = JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return undefined;
    throw new Error(`CircleTeX Skill 清单无法读取：${error instanceof Error ? error.message : String(error)}`);
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("circletex.skill.json 格式无效。");
  }
  const manifest = value as Partial<SkillManifestFile>;
  if (
    manifest.version !== 1 ||
    !["analysis", "artifact"].includes(String(manifest.taskType)) ||
    !["document", "selection", "either"].includes(String(manifest.scope)) ||
    !["document", "document-resources", "document-workspace"].includes(String(manifest.inputPreset)) ||
    manifest.network !== false ||
    !Array.isArray(manifest.outputExtensions) ||
    manifest.outputExtensions.some((item) => typeof item !== "string") ||
    !Array.isArray(manifest.declaredCommands) ||
    manifest.declaredCommands.some((item) => typeof item !== "string") ||
    !Array.isArray(manifest.supportedAgents) || manifest.supportedAgents.length !== 1 || manifest.supportedAgents[0] !== "codex" ||
    !Number.isInteger(manifest.timeoutMinutes) ||
    (manifest.writableWorkDirectory !== undefined && typeof manifest.writableWorkDirectory !== "boolean") ||
    (manifest.agentIndependent !== undefined && typeof manifest.agentIndependent !== "boolean")
  ) {
    throw new Error("circletex.skill.json 缺少必需字段或包含不支持的权限。");
  }
  return {
    taskType: manifest.taskType as SkillTaskType,
    scope: manifest.scope as SkillScope,
    inputPreset: manifest.inputPreset as SkillInputPreset,
    outputExtensions: [...manifest.outputExtensions],
    declaredCommands: [...manifest.declaredCommands],
    network: false,
    supportedAgents: ["codex"],
    timeoutMinutes: manifest.timeoutMinutes as number,
    writableWorkDirectory: Boolean(manifest.writableWorkDirectory),
    agentIndependent: Boolean(manifest.agentIndependent)
  };
}

function isNodeError(value: unknown): value is NodeJS.ErrnoException {
  return value instanceof Error && "code" in value;
}
