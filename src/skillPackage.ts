import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { SkillPackageInspection } from "./skillTypes";

const MAX_SKILL_FILES = 512;
const MAX_SKILL_FILE_BYTES = 10 * 1024 * 1024;
const MAX_SKILL_TOTAL_BYTES = 50 * 1024 * 1024;
const SCRIPT_EXTENSIONS = new Set([".js", ".mjs", ".cjs", ".ts", ".py", ".ps1", ".sh", ".cmd", ".bat"]);
const BINARY_EXTENSIONS = new Set([".exe", ".dll", ".com", ".msi", ".scr", ".sys"]);
const IGNORED_DIRECTORIES = new Set([".git", ".svn", "node_modules", "__pycache__"]);

interface ScannedSkillFile {
  relativePath: string;
  absolutePath: string;
  size: number;
}

export async function inspectSkillDirectory(sourcePath: string): Promise<SkillPackageInspection> {
  const root = path.resolve(sourcePath);
  const rootStat = await fs.lstat(root).catch(() => undefined);
  if (!rootStat?.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error("所选路径不是可导入的普通 Skill 文件夹。");
  }
  const skillPath = path.join(root, "SKILL.md");
  const skillStat = await fs.lstat(skillPath).catch(() => undefined);
  if (!skillStat?.isFile() || skillStat.isSymbolicLink() || skillStat.size > 1024 * 1024) {
    throw new Error("Skill 文件夹必须包含不超过 1 MB 的普通文件 SKILL.md。");
  }
  const files = await scanSkillFiles(root);
  const totalBytes = files.reduce((sum, file) => sum + file.size, 0);
  const binaryFiles: string[] = [];
  for (const file of files) {
    if (
      BINARY_EXTENSIONS.has(path.extname(file.relativePath).toLowerCase()) ||
      await isExecutableBinaryFile(file.absolutePath)
    ) {
      binaryFiles.push(file.relativePath);
    }
  }
  const skillText = await fs.readFile(skillPath, "utf8");
  const metadata = parseSkillMetadata(skillText, path.basename(root));
  const hash = await hashSkillFiles(files);
  return {
    sourcePath: root,
    id: normalizeSkillId(metadata.name, hash),
    displayName: metadata.name,
    description: metadata.description,
    hash,
    fileCount: files.length,
    totalBytes,
    scriptFiles: files
      .filter((file) => SCRIPT_EXTENSIONS.has(path.extname(file.relativePath).toLowerCase()))
      .map((file) => file.relativePath),
    binaryFiles,
    files: files.map((file) => file.relativePath)
  };
}

export async function copySkillSnapshot(sourcePath: string, targetPath: string): Promise<void> {
  const source = path.resolve(sourcePath);
  const target = path.resolve(targetPath);
  const files = await scanSkillFiles(source);
  await fs.mkdir(target, { recursive: true });
  for (const file of files) {
    const destination = safeJoin(target, file.relativePath);
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.copyFile(file.absolutePath, destination);
  }
}

export async function isExecutableBinaryFile(filePath: string): Promise<boolean> {
  const handle = await fs.open(filePath, "r");
  try {
    const header = new Uint8Array(8);
    const { bytesRead } = await handle.read(header, 0, header.length, 0);
    if (bytesRead >= 2 && header[0] === 0x4d && header[1] === 0x5a) return true;
    if (bytesRead >= 4 && bytesEqual(header, [0x7f, 0x45, 0x4c, 0x46])) return true;
    if (bytesRead >= 4 && bytesEqual(header, [0x00, 0x61, 0x73, 0x6d])) return true;
    if (bytesRead < 4) return false;
    return new Set([
      0xfeedface, 0xcefaedfe, 0xfeedfacf, 0xcffaedfe, 0xcafebabe, 0xbebafeca
    ]).has(new DataView(header.buffer).getUint32(0, false));
  } finally {
    await handle.close();
  }
}

function bytesEqual(value: Uint8Array, expected: readonly number[]): boolean {
  return expected.every((item, index) => value[index] === item);
}

function parseSkillMetadata(text: string, fallbackName: string): { name: string; description: string } {
  let name = fallbackName;
  let description = "未提供 Skill 说明。";
  if (text.startsWith("---")) {
    const end = text.indexOf("\n---", 3);
    if (end > 0) {
      const frontmatter = text.slice(3, end).split(/\r?\n/);
      for (let index = 0; index < frontmatter.length; index += 1) {
        const line = frontmatter[index];
        const nameMatch = /^name:\s*(.+)\s*$/.exec(line);
        if (nameMatch) {
          name = unquote(nameMatch[1]).trim() || fallbackName;
        }
        const descriptionMatch = /^description:\s*(.*)\s*$/.exec(line);
        if (descriptionMatch) {
          const inline = unquote(descriptionMatch[1]).trim();
          if (inline && inline !== "|" && inline !== ">") {
            description = inline;
          } else if (inline === "|" || inline === ">") {
            const parts: string[] = [];
            for (let next = index + 1; next < frontmatter.length && /^\s+/.test(frontmatter[next]); next += 1) {
              parts.push(frontmatter[next].trim());
              index = next;
            }
            description = parts.filter(Boolean).join(inline === ">" ? " " : "\n") || description;
          }
        }
      }
    }
  }
  if (name.length > 120 || description.length > 2_000 || /[\u0000-\u001F\u007F]/u.test(name)) {
    throw new Error("SKILL.md 的名称或说明格式无效。");
  }
  return { name, description };
}

async function scanSkillFiles(root: string): Promise<ScannedSkillFile[]> {
  const files: ScannedSkillFile[] = [];
  let totalBytes = 0;
  const visit = async (directory: string): Promise<void> => {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (entry.name.includes("\0")) {
        throw new Error("Skill 包含非法文件名。");
      }
      if (entry.isSymbolicLink()) {
        throw new Error(`Skill 包含不允许的符号链接或重解析点：${entry.name}`);
      }
      if (entry.isDirectory() && IGNORED_DIRECTORIES.has(entry.name)) {
        continue;
      }
      const absolutePath = path.join(directory, entry.name);
      const relativePath = normalizeRelativePath(path.relative(root, absolutePath));
      if (entry.isDirectory()) {
        await visit(absolutePath);
        continue;
      }
      if (!entry.isFile()) {
        throw new Error(`Skill 包含不支持的文件类型：${relativePath}`);
      }
      const stat = await fs.lstat(absolutePath);
      if (stat.isSymbolicLink() || stat.size > MAX_SKILL_FILE_BYTES) {
        throw new Error(`Skill 文件过大或类型不安全：${relativePath}`);
      }
      totalBytes += stat.size;
      files.push({ relativePath, absolutePath, size: stat.size });
      if (files.length > MAX_SKILL_FILES || totalBytes > MAX_SKILL_TOTAL_BYTES) {
        throw new Error("Skill 超过 512 个文件或 50 MB 的导入限制。");
      }
    }
  };
  await visit(root);
  if (!files.some((file) => file.relativePath.toLowerCase() === "skill.md")) {
    throw new Error("Skill 文件夹缺少 SKILL.md。");
  }
  return files;
}

async function hashSkillFiles(files: readonly ScannedSkillFile[]): Promise<string> {
  const hash = createHash("sha256");
  for (const file of files) {
    hash.update(file.relativePath, "utf8");
    hash.update("\0");
    hash.update(new Uint8Array(await fs.readFile(file.absolutePath)));
    hash.update("\0");
  }
  return hash.digest("hex");
}

function normalizeSkillId(value: string, hash: string): string {
  const normalized = value.normalize("NFKC").toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  return normalized || `skill-${hash.slice(0, 12)}`;
}

function normalizeRelativePath(value: string): string {
  const normalized = value.replace(/\\/g, "/");
  if (!normalized || normalized.startsWith("../") || path.posix.isAbsolute(normalized)) {
    throw new Error("Skill 文件路径超出根目录。");
  }
  return normalized;
}

function safeJoin(root: string, relativePath: string): string {
  const target = path.resolve(root, relativePath);
  const relative = path.relative(path.resolve(root), target);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("Skill 快照路径超出目标目录。");
  }
  return target;
}

function unquote(value: string): string {
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  return value;
}
