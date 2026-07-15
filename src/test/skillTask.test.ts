import * as assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { SkillRegistry } from "../skillRegistry";
import { SkillAgentRunContext, SkillAgentRunner, SkillAgentResult, SkillTaskService } from "../skillTask";
import { ImportedSkill, SkillPermissionProfile } from "../skillTypes";
import { ProjectPaths } from "../types";

describe("隔离 Skill 任务", () => {
  it("发布 Markdown 产物并记录历史", async () => {
    await withFixture(async (fixture) => {
      const runner = fakeRunner(async (context) => {
        await fs.writeFile(path.join(context.outputRoot, "report.md"), "# 审阅报告\n", "utf8");
        return success("report.md");
      });
      const result = await runTask(fixture, runner);
      assert.equal(result.status, "completed");
      assert.equal(result.artifacts[0].name, "report.md");
      assert.equal(await fs.readFile(result.artifacts[0].absolutePath, "utf8"), "# 审阅报告\n");
      assert.equal(fixture.registry.recentHistory()[0].taskId, result.taskId);
    });
  });

  it("拒绝路径穿越和未授权扩展名", async () => {
    await withFixture(async (fixture) => {
      const traversal = fakeRunner(async () => ({
        status: "success",
        summary: "完成",
        artifacts: [{ path: "../escape.md", type: "markdown", description: "越界" }],
        warnings: []
      }));
      assert.match((await runTask(fixture, traversal)).error ?? "", /越界/);

      const wrongType = fakeRunner(async (context) => {
        await fs.writeFile(path.join(context.outputRoot, "data.json"), "{}", "utf8");
        return success("data.json");
      });
      assert.match((await runTask(fixture, wrongType)).error ?? "", /未获批准/);

      const disguisedExecutable = fakeRunner(async (context) => {
        await fs.writeFile(path.join(context.outputRoot, "report.md"), new Uint8Array([0x4d, 0x5a, 0x90, 0x00]));
        return success("report.md");
      });
      assert.match((await runTask(fixture, disguisedExecutable)).error ?? "", /可执行二进制/);
    });
  });

  it("输入、Skill 或任务目录被修改时拒绝发布", async () => {
    await withFixture(async (fixture) => {
      const mutateInput = fakeRunner(async (context) => {
        await fs.appendFile(path.join(context.inputRoot, "main.tex"), "篡改", "utf8");
        await fs.writeFile(path.join(context.outputRoot, "report.md"), "内容", "utf8");
        return success("report.md");
      });
      assert.match((await runTask(fixture, mutateInput)).error ?? "", /修改了只读输入/);

      const outsideOutput = fakeRunner(async (context) => {
        await fs.writeFile(path.join(context.taskRoot, "extra.txt"), "越界", "utf8");
        await fs.writeFile(path.join(context.outputRoot, "report.md"), "内容", "utf8");
        return success("report.md");
      });
      assert.match((await runTask(fixture, outsideOutput)).error ?? "", /output 目录之外/);
      assert.equal(await exportsExist(fixture.project.root), false);
    });
  });

  it("取消任务后不发布半成品", async () => {
    await withFixture(async (fixture) => {
      const controller = new AbortController();
      const runner = fakeRunner(async (context) => {
        await fs.writeFile(path.join(context.outputRoot, "report.md"), "未完成", "utf8");
        controller.abort();
        return success("report.md");
      });
      const result = await runTask(fixture, runner, controller);
      assert.equal(result.status, "cancelled");
      assert.equal(await exportsExist(fixture.project.root), false);
    });
  });

  it("校验 DOCX 容器的必要部件", async () => {
    await withFixture(async (fixture) => {
      fixture.skill = await reimport(fixture, { outputExtensions: [".docx"] });
      const invalid = fakeRunner(async (context) => {
        await fs.writeFile(path.join(context.outputRoot, "paper.docx"), new Uint8Array(120));
        return success("paper.docx");
      });
      assert.match((await runTask(fixture, invalid)).error ?? "", /DOCX/);

      const valid = fakeRunner(async (context) => {
        await fs.writeFile(path.join(context.outputRoot, "paper.docx"), minimalZip([
          "[Content_Types].xml",
          "word/document.xml"
        ]));
        return success("paper.docx");
      });
      assert.equal((await runTask(fixture, valid)).status, "completed");
    });
  });
});

interface Fixture {
  root: string;
  source: string;
  registry: SkillRegistry;
  project: ProjectPaths;
  skill: ImportedSkill;
}

async function runTask(fixture: Fixture, runner: SkillAgentRunner, controller = new AbortController()) {
  const service = new SkillTaskService(fixture.registry, () => runner);
  return service.run({
    skill: fixture.skill,
    project: fixture.project,
    prompt: "根据论文生成产物。",
    codexCommand: "unused",
    signal: controller.signal,
    onProgress: () => undefined
  });
}

function fakeRunner(run: (context: SkillAgentRunContext) => Promise<SkillAgentResult>): SkillAgentRunner {
  return { id: "codex", run };
}

function success(file: string): SkillAgentResult {
  return {
    status: "success",
    summary: "任务完成",
    artifacts: [{ path: file, type: path.extname(file).slice(1), description: "测试产物" }],
    warnings: []
  };
}

async function reimport(fixture: Fixture, overrides: Partial<SkillPermissionProfile>): Promise<ImportedSkill> {
  return fixture.registry.import(await fixture.registry.inspect(fixture.source), permissions(overrides));
}

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

async function withFixture(run: (fixture: Fixture) => Promise<void>): Promise<void> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "circletex-skill-task-"));
  const source = path.join(root, "source");
  const storage = path.join(root, "storage");
  const projectRoot = path.join(root, "paper");
  await Promise.all([fs.mkdir(source), fs.mkdir(projectRoot)]);
  await fs.writeFile(path.join(source, "SKILL.md"), "---\nname: task-skill\ndescription: 生成产物。\n---\n", "utf8");
  await fs.writeFile(path.join(projectRoot, "main.tex"), "\\documentclass{article}\n", "utf8");
  await fs.writeFile(path.join(projectRoot, "main.pdf"), "%PDF-1.7\n", "utf8");
  const registry = new SkillRegistry(storage);
  await registry.initialize();
  const skill = await registry.import(await registry.inspect(source), permissions());
  const fixture: Fixture = {
    root,
    source,
    registry,
    skill,
    project: {
      root: projectRoot,
      tex: path.join(projectRoot, "main.tex"),
      pdf: path.join(projectRoot, "main.pdf"),
      syncTex: path.join(projectRoot, "main.synctex.gz")
    }
  };
  try {
    await run(fixture);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

async function exportsExist(projectRoot: string): Promise<boolean> {
  return fs.stat(path.join(projectRoot, "exports")).then(() => true, () => false);
}

function minimalZip(names: string[]): Uint8Array {
  const localParts: Uint8Array[] = [];
  const centralParts: Uint8Array[] = [];
  let offset = 0;
  for (const name of names) {
    const encoded = new TextEncoder().encode(name);
    const local = new Uint8Array(30 + encoded.length);
    const localView = new DataView(local.buffer);
    localView.setUint32(0, 0x04034b50, true);
    localView.setUint16(4, 20, true);
    localView.setUint16(26, encoded.length, true);
    local.set(encoded, 30);
    localParts.push(local);

    const central = new Uint8Array(46 + encoded.length);
    const centralView = new DataView(central.buffer);
    centralView.setUint32(0, 0x02014b50, true);
    centralView.setUint16(4, 20, true);
    centralView.setUint16(6, 20, true);
    centralView.setUint16(28, encoded.length, true);
    centralView.setUint32(42, offset, true);
    central.set(encoded, 46);
    centralParts.push(central);
    offset += local.length;
  }
  const centralDirectory = concatenate(centralParts);
  const end = new Uint8Array(22);
  const endView = new DataView(end.buffer);
  endView.setUint32(0, 0x06054b50, true);
  endView.setUint16(8, names.length, true);
  endView.setUint16(10, names.length, true);
  endView.setUint32(12, centralDirectory.length, true);
  endView.setUint32(16, offset, true);
  return concatenate([...localParts, centralDirectory, end]);
}

function concatenate(parts: readonly Uint8Array[]): Uint8Array {
  const result = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}
