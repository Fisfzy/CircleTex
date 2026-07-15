import * as assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { SkillRegistry } from "../skillRegistry";
import { SkillPermissionProfile } from "../skillTypes";

describe("Skill 注册表", () => {
  it("导入内容哈希快照并可重新加载", async () => {
    await withFixture(async ({ source, storage }) => {
      const registry = new SkillRegistry(storage);
      await registry.initialize();
      const inspection = await registry.inspect(source);
      const imported = await registry.import(inspection, permissions());
      assert.equal(imported.hash, inspection.hash);
      assert.equal((await fs.stat(path.join(registry.snapshotPath(imported), "SKILL.md"))).isFile(), true);

      const reloaded = new SkillRegistry(storage);
      await reloaded.initialize();
      assert.equal(reloaded.get(imported.id)?.permissions.scope, "document");
      await reloaded.setEnabled(imported.id, false);
      assert.equal(reloaded.get(imported.id)?.enabled, false);
    });
  });

  it("内容或权限变化会写入新的确认结果", async () => {
    await withFixture(async ({ source, storage }) => {
      const registry = new SkillRegistry(storage);
      await registry.initialize();
      const firstInspection = await registry.inspect(source);
      const first = await registry.import(firstInspection, permissions());
      await fs.appendFile(path.join(source, "SKILL.md"), "\n新增规则。\n", "utf8");
      const secondInspection = await registry.inspect(source);
      const changedPermissions = permissions({ taskType: "analysis", scope: "either", outputExtensions: [".md", ".json"] });
      const second = await registry.import(secondInspection, changedPermissions);
      assert.notEqual(second.hash, first.hash);
      assert.deepEqual(second.permissions.outputExtensions, [".md", ".json"]);
      assert.equal((await fs.stat(registry.snapshotPath(first))).isDirectory(), true);
    });
  });

  it("拒绝包含可执行二进制和无效权限的导入", async () => {
    await withFixture(async ({ source, storage }) => {
      const registry = new SkillRegistry(storage);
      await registry.initialize();
      await fs.writeFile(path.join(source, "tool.exe"), "MZ", "utf8");
      const inspection = await registry.inspect(source);
      await assert.rejects(() => registry.import(inspection, permissions()), /二进制/);
      await assert.rejects(() => registry.import(inspection, permissions({ network: true as false })), /权限清单/);
    });
  });
});

function permissions(overrides: Partial<SkillPermissionProfile> = {}): SkillPermissionProfile {
  return {
    taskType: "artifact",
    scope: "document",
    inputPreset: "document",
    outputExtensions: [".md"],
    declaredCommands: [],
    network: false,
    supportedAgents: ["codex"],
    timeoutMinutes: 5,
    ...overrides
  };
}

async function withFixture(run: (fixture: { source: string; storage: string }) => Promise<void>): Promise<void> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "circletex-skill-registry-"));
  const source = path.join(root, "source");
  const storage = path.join(root, "storage");
  await fs.mkdir(source);
  await fs.writeFile(path.join(source, "SKILL.md"), "---\nname: sample-skill\ndescription: 生成审阅产物。\n---\n", "utf8");
  try {
    await run({ source, storage });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}
