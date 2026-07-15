import * as assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { inspectSkillDirectory } from "../skillPackage";

describe("Skill 包检查", () => {
  it("读取元数据并为相同内容生成稳定哈希", async () => {
    await withTempDirectory(async (root) => {
      await fs.writeFile(path.join(root, "SKILL.md"), "---\nname: paper-export\ndescription: 导出论文。\n---\n\n执行任务。\n", "utf8");
      await fs.mkdir(path.join(root, "references"));
      await fs.writeFile(path.join(root, "references", "rules.md"), "规则", "utf8");
      const first = await inspectSkillDirectory(root);
      const second = await inspectSkillDirectory(root);
      assert.equal(first.id, "paper-export");
      assert.equal(first.displayName, "paper-export");
      assert.equal(first.description, "导出论文。");
      assert.equal(first.hash, second.hash);
      await fs.appendFile(path.join(root, "references", "rules.md"), "已变化", "utf8");
      assert.notEqual((await inspectSkillDirectory(root)).hash, first.hash);
    });
  });

  it("识别脚本和禁止的可执行二进制", async () => {
    await withTempDirectory(async (root) => {
      await fs.writeFile(path.join(root, "SKILL.md"), "---\nname: checked\ndescription: 测试。\n---\n", "utf8");
      await fs.writeFile(path.join(root, "run.py"), "print('ok')", "utf8");
      await fs.writeFile(path.join(root, "payload.exe"), "MZ", "utf8");
      await fs.writeFile(path.join(root, "renamed.dat"), new Uint8Array([0x7f, 0x45, 0x4c, 0x46, 0x02]));
      const inspection = await inspectSkillDirectory(root);
      assert.deepEqual(inspection.scriptFiles, ["run.py"]);
      assert.deepEqual(inspection.binaryFiles, ["payload.exe", "renamed.dat"]);
    });
  });

  it("拒绝符号链接", async () => {
    await withTempDirectory(async (root) => {
      await fs.writeFile(path.join(root, "SKILL.md"), "---\nname: linked\ndescription: 测试。\n---\n", "utf8");
      const target = path.join(root, "target.txt");
      await fs.writeFile(target, "内容", "utf8");
      try {
        await fs.symlink(target, path.join(root, "link.txt"), "file");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EPERM") {
          return;
        }
        throw error;
      }
      await assert.rejects(() => inspectSkillDirectory(root), /符号链接|重解析点/);
    });
  });
});

async function withTempDirectory(run: (root: string) => Promise<void>): Promise<void> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "circletex-skill-package-"));
  try {
    await run(root);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}
