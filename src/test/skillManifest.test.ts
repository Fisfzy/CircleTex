import * as assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { readSkillPermissionManifest } from "../skillManifest";

describe("CircleTeX Skill 权限清单", () => {
  it("读取无底稿 Word 工作副本权限", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "circletex-skill-manifest-"));
    try {
      await fs.writeFile(path.join(root, "circletex.skill.json"), JSON.stringify({
        version: 1,
        taskType: "artifact",
        scope: "document",
        inputPreset: "document-workspace",
        writableWorkDirectory: true,
        outputExtensions: [".docx", ".json"],
        declaredCommands: ["python", "pandoc"],
        network: false,
        supportedAgents: ["codex"],
        timeoutMinutes: 60
      }), "utf8");
      const permissions = await readSkillPermissionManifest(root);
      assert.equal(permissions?.inputPreset, "document-workspace");
      assert.equal(permissions?.writableWorkDirectory, true);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
