import * as fs from "node:fs/promises";
import * as path from "node:path";
import { copySkillSnapshot, inspectSkillDirectory } from "./skillPackage";
import {
  ImportedSkill,
  SkillPackageInspection,
  SkillPermissionProfile,
  SkillTaskHistoryEntry
} from "./skillTypes";

interface RegistryFile {
  version: 1;
  skills: ImportedSkill[];
  history: SkillTaskHistoryEntry[];
}

export class SkillRegistry {
  private data: RegistryFile = { version: 1, skills: [], history: [] };

  public constructor(private readonly storageRoot: string) {}

  public async initialize(): Promise<void> {
    await fs.mkdir(this.storageRoot, { recursive: true });
    const filePath = this.registryPath();
    try {
      const value = JSON.parse(await fs.readFile(filePath, "utf8")) as RegistryFile;
      this.data = validateRegistryFile(value);
    } catch (error) {
      if (!isNodeError(error) || error.code !== "ENOENT") {
        throw new Error(`CircleTeX Skill 注册表无法读取：${error instanceof Error ? error.message : String(error)}`);
      }
      await this.save();
    }
  }

  public list(): ImportedSkill[] {
    return this.data.skills.map(cloneSkill);
  }

  public get(id: string): ImportedSkill | undefined {
    const skill = this.data.skills.find((item) => item.id === id);
    return skill ? cloneSkill(skill) : undefined;
  }

  public recentHistory(): SkillTaskHistoryEntry[] {
    return this.data.history.map((entry) => ({ ...entry, artifacts: entry.artifacts.map((artifact) => ({ ...artifact })) }));
  }

  public inspect(sourcePath: string): Promise<SkillPackageInspection> {
    return inspectSkillDirectory(sourcePath);
  }

  public async import(
    inspection: SkillPackageInspection,
    permissions: SkillPermissionProfile
  ): Promise<ImportedSkill> {
    validatePermissions(permissions);
    if (inspection.binaryFiles.length > 0) {
      throw new Error(`首版 CircleTeX 不导入可执行二进制文件：${inspection.binaryFiles.join("、")}`);
    }
    const now = new Date().toISOString();
    const existing = this.data.skills.find((item) => item.id === inspection.id);
    const snapshotRelativePath = normalizeRelativePath(path.join("skills", inspection.id, "versions", inspection.hash));
    const snapshotPath = this.resolveStoragePath(snapshotRelativePath);
    const snapshotExists = await fs.stat(snapshotPath).then((stat) => stat.isDirectory(), () => false);
    if (!snapshotExists) {
      const stagingPath = this.resolveStoragePath(`${snapshotRelativePath}.tmp-${Date.now()}`);
      try {
        await copySkillSnapshot(inspection.sourcePath, stagingPath);
        const stagedInspection = await inspectSkillDirectory(stagingPath);
        if (stagedInspection.hash !== inspection.hash || stagedInspection.binaryFiles.length > 0) {
          throw new Error("Skill 内容在权限确认后发生了变化，请重新检查并确认。");
        }
        await fs.mkdir(path.dirname(snapshotPath), { recursive: true });
        await fs.rename(stagingPath, snapshotPath).catch(async (error) => {
          const appeared = await fs.stat(snapshotPath).then((stat) => stat.isDirectory(), () => false);
          if (!appeared) {
            throw error;
          }
        });
      } finally {
        await fs.rm(stagingPath, { recursive: true, force: true });
      }
    }
    const imported: ImportedSkill = {
      id: inspection.id,
      displayName: inspection.displayName,
      description: inspection.description,
      sourcePath: inspection.sourcePath,
      hash: inspection.hash,
      snapshotRelativePath,
      importedAt: existing?.importedAt ?? now,
      updatedAt: now,
      enabled: true,
      inspection: {
        fileCount: inspection.fileCount,
        totalBytes: inspection.totalBytes,
        scriptFiles: [...inspection.scriptFiles],
        binaryFiles: [...inspection.binaryFiles]
      },
      permissions: clonePermissions(permissions)
    };
    this.data.skills = [...this.data.skills.filter((item) => item.id !== imported.id), imported]
      .sort((left, right) => left.displayName.localeCompare(right.displayName));
    await this.save();
    return cloneSkill(imported);
  }

  public snapshotPath(skill: ImportedSkill): string {
    return this.resolveStoragePath(skill.snapshotRelativePath);
  }

  public async remove(id: string): Promise<boolean> {
    const skill = this.data.skills.find((item) => item.id === id);
    if (!skill) {
      return false;
    }
    this.data.skills = this.data.skills.filter((item) => item.id !== id);
    await this.save();
    const skillRoot = this.resolveStoragePath(normalizeRelativePath(path.join("skills", id)));
    await fs.rm(skillRoot, { recursive: true, force: true });
    return true;
  }

  public async setEnabled(id: string, enabled: boolean): Promise<void> {
    const skill = this.data.skills.find((item) => item.id === id);
    if (!skill) {
      throw new Error("未找到需要更新的 Skill。");
    }
    skill.enabled = enabled;
    skill.updatedAt = new Date().toISOString();
    await this.save();
  }

  public async addHistory(entry: SkillTaskHistoryEntry): Promise<void> {
    this.data.history = [entry, ...this.data.history.filter((item) => item.taskId !== entry.taskId)].slice(0, 50);
    await this.save();
  }

  private async save(): Promise<void> {
    const target = this.registryPath();
    const staging = `${target}.tmp-${process.pid}-${Date.now()}`;
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(staging, JSON.stringify(this.data, null, 2), "utf8");
    await fs.rename(staging, target).catch(async (error) => {
      await fs.rm(staging, { force: true });
      throw error;
    });
  }

  private registryPath(): string {
    return path.join(this.storageRoot, "registry.json");
  }

  private resolveStoragePath(relativePath: string): string {
    const target = path.resolve(this.storageRoot, relativePath);
    const relative = path.relative(path.resolve(this.storageRoot), target);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new Error("Skill 注册表路径超出 CircleTeX 存储目录。");
    }
    return target;
  }
}

function validateRegistryFile(value: RegistryFile): RegistryFile {
  if (!value || value.version !== 1 || !Array.isArray(value.skills) || !Array.isArray(value.history)) {
    throw new Error("注册表格式无效。");
  }
  for (const skill of value.skills) {
    if (!skill || typeof skill.id !== "string" || typeof skill.hash !== "string" || typeof skill.snapshotRelativePath !== "string") {
      throw new Error("注册表包含无效 Skill 记录。");
    }
    validatePermissions(skill.permissions);
  }
  return value;
}

function validatePermissions(value: SkillPermissionProfile): void {
  if (
    !value ||
    !["analysis", "artifact"].includes(value.taskType) ||
    !["document", "selection", "either"].includes(value.scope) ||
    !["document", "document-resources", "document-workspace"].includes(value.inputPreset) ||
    value.network !== false ||
    !Array.isArray(value.outputExtensions) ||
    value.outputExtensions.length < 1 || value.outputExtensions.length > 16 ||
    value.outputExtensions.some((extension) => !/^\.[a-z0-9]{1,12}$/.test(extension)) ||
    !Array.isArray(value.declaredCommands) || value.declaredCommands.length > 32 ||
    value.declaredCommands.some((command) => !/^[A-Za-z0-9._+-]{1,80}$/.test(command)) ||
    !Array.isArray(value.supportedAgents) || value.supportedAgents.length !== 1 || value.supportedAgents[0] !== "codex" ||
    !Number.isInteger(value.timeoutMinutes) || value.timeoutMinutes < 1 || value.timeoutMinutes > 240 ||
    (value.writableWorkDirectory !== undefined && typeof value.writableWorkDirectory !== "boolean") ||
    (value.agentIndependent !== undefined && typeof value.agentIndependent !== "boolean")
  ) {
    throw new Error("Skill 权限清单格式无效。");
  }
}

function normalizeRelativePath(value: string): string {
  const normalized = value.replace(/\\/g, "/");
  if (!normalized || normalized.startsWith("../") || path.posix.isAbsolute(normalized)) {
    throw new Error("Skill 存储路径无效。");
  }
  return normalized;
}

function cloneSkill(skill: ImportedSkill): ImportedSkill {
  return {
    ...skill,
    inspection: {
      ...skill.inspection,
      scriptFiles: [...skill.inspection.scriptFiles],
      binaryFiles: [...skill.inspection.binaryFiles]
    },
    permissions: clonePermissions(skill.permissions)
  };
}

function clonePermissions(value: SkillPermissionProfile): SkillPermissionProfile {
  return {
    ...value,
    outputExtensions: [...value.outputExtensions],
    declaredCommands: [...value.declaredCommands],
    supportedAgents: ["codex"]
  };
}

function isNodeError(value: unknown): value is NodeJS.ErrnoException {
  return value instanceof Error && "code" in value;
}
