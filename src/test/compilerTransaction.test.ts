import * as assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { LatexCompiler, latexLogRequiresAnotherPass, publishBuild } from "../compiler";

describe("编译产物发布事务", () => {
  it("只把明确的 LaTeX 重跑警告判定为需要下一遍", () => {
    assert.equal(latexLogRequiresAnotherPass("Package rerunfilecheck Info: File `main.out' has not changed."), false);
    assert.equal(latexLogRequiresAnotherPass("LaTeX Warning: Label(s) may have changed. Rerun to get cross-references right."), true);
    assert.equal(latexLogRequiresAnotherPass("LaTeX Warning: There were undefined references."), true);
    assert.equal(latexLogRequiresAnotherPass("Package rerunfilecheck Warning: File `main.out' has changed."), true);
  });

  it("辅助文件稳定且日志无重跑要求时安全省略默认第二遍", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "circletex-convergence-test-"));
    try {
      const sourcePath = path.join(root, "main.tex");
      const project = {
        root,
        tex: sourcePath,
        pdf: path.join(root, "main.pdf"),
        syncTex: path.join(root, "main.synctex.gz")
      };
      await fs.writeFile(sourcePath, "\\documentclass{article}\n\\begin{document}\nFirst version.\n\\end{document}\n");
      const first = await new LatexCompiler().compile(project, 2, () => undefined);
      assert.equal(first.passes, 2);

      await fs.writeFile(sourcePath, "\\documentclass{article}\n\\begin{document}\nSecond version.\n\\end{document}\n");
      let output = "";
      const progressEvents: Array<{ percent: number; message: string; indeterminate?: boolean }> = [];
      const second = await new LatexCompiler().compile(project, 2, (text) => {
        output += text;
      }, undefined, (progress) => progressEvents.push(progress));
      assert.equal(second.passes, 1);
      assert.match(output, /安全省略第 2 遍 XeLaTeX/);
      assert.deepEqual(progressEvents.map((progress) => progress.percent), [8, 8, 15, 15, 55, 88, 88, 94]);
      assert.ok(progressEvents.some((progress) => progress.indeterminate && /XeLaTeX/.test(progress.message)));
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("中断后恢复旧 PDF 并删除原先不存在的新 SyncTeX", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "circletex-transaction-test-"));
    try {
      const backup = path.join(root, "backup", "circletex-build", "test");
      await fs.mkdir(backup, { recursive: true });
      await fs.writeFile(path.join(backup, "main.pdf"), "old-pdf");
      await fs.writeFile(path.join(root, "main.pdf"), "new-pdf");
      await fs.writeFile(path.join(root, "main.synctex.gz"), "new-sync");
      await fs.writeFile(path.join(root, ".circletex-build-transaction.json"), JSON.stringify({
        id: "test",
        backupDirectory: backup,
        names: ["main.pdf", "main.synctex.gz"],
        originallyExisting: ["main.pdf"]
      }));

      await new LatexCompiler().recoverInterruptedPublish(root);
      assert.equal(await fs.readFile(path.join(root, "main.pdf"), "utf8"), "old-pdf");
      await assert.rejects(fs.stat(path.join(root, "main.synctex.gz")));
      await assert.rejects(fs.stat(path.join(root, ".circletex-build-transaction.json")));
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("拒绝恢复项目备份目录之外的事务", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "circletex-transaction-test-"));
    try {
      await fs.writeFile(path.join(root, ".circletex-build-transaction.json"), JSON.stringify({
        id: "test",
        backupDirectory: os.tmpdir(),
        names: ["main.pdf"],
        originallyExisting: ["main.pdf"]
      }));
      await assert.rejects(
        new LatexCompiler().recoverInterruptedPublish(root),
        /备份目录超出项目允许范围/
      );
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("发布后源码哈希不匹配时恢复旧 PDF 与 SyncTeX", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "circletex-publish-test-"));
    const build = await fs.mkdtemp(path.join(os.tmpdir(), "circletex-build-test-"));
    try {
      await fs.writeFile(path.join(root, "main.tex"), "source-v2");
      await fs.writeFile(path.join(root, "main.pdf"), "old-pdf");
      await fs.writeFile(path.join(root, "main.synctex.gz"), "old-sync");
      await fs.writeFile(path.join(build, "main.pdf"), "new-pdf");
      await fs.writeFile(path.join(build, "main.synctex.gz"), "new-sync");

      await assert.rejects(
        publishBuild(root, build, {
          sourcePath: path.join(root, "main.tex"),
          expectedSourceHash: "not-the-current-source-hash"
        }),
        /main\.tex 在产物发布期间发生了变化/
      );

      assert.equal(await fs.readFile(path.join(root, "main.pdf"), "utf8"), "old-pdf");
      assert.equal(await fs.readFile(path.join(root, "main.synctex.gz"), "utf8"), "old-sync");
      await assert.rejects(fs.stat(path.join(root, ".circletex-build-transaction.json")));
      const rootEntries = await fs.readdir(root);
      assert.equal(rootEntries.some((name) => /^\.circletex-.*\.tmp$/.test(name)), false);

      const backupRoot = path.join(root, "backup", "circletex-build");
      const backupDirectories = await fs.readdir(backupRoot);
      assert.equal(backupDirectories.length, 1);
      const backup = path.join(backupRoot, backupDirectories[0]);
      assert.equal(await fs.readFile(path.join(backup, "main.pdf"), "utf8"), "old-pdf");
      assert.equal(await fs.readFile(path.join(backup, "main.synctex.gz"), "utf8"), "old-sync");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
      await fs.rm(build, { recursive: true, force: true });
    }
  });

  it("提交前验证在覆盖新产物后执行，失败时恢复旧产物", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "circletex-publish-test-"));
    const build = await fs.mkdtemp(path.join(os.tmpdir(), "circletex-build-test-"));
    try {
      const source = "unchanged-source";
      await fs.writeFile(path.join(root, "main.tex"), source);
      await fs.writeFile(path.join(root, "main.pdf"), "old-pdf");
      await fs.writeFile(path.join(root, "main.synctex.gz"), "old-sync");
      await fs.writeFile(path.join(build, "main.pdf"), "new-pdf");
      await fs.writeFile(path.join(build, "main.synctex.gz"), "new-sync");
      let validatorObservedNewArtifacts = false;

      await assert.rejects(
        publishBuild(root, build, {
          sourcePath: path.join(root, "main.tex"),
          expectedSourceHash: createHash("sha256").update(source).digest("hex"),
          validateBeforeCommit: async () => {
            assert.equal(await fs.readFile(path.join(root, "main.pdf"), "utf8"), "new-pdf");
            assert.equal(await fs.readFile(path.join(root, "main.synctex.gz"), "utf8"), "new-sync");
            validatorObservedNewArtifacts = true;
            throw new Error("编辑器源码在提交前发生了变化。");
          }
        }),
        /编辑器源码在提交前发生了变化/
      );

      assert.equal(validatorObservedNewArtifacts, true);
      assert.equal(await fs.readFile(path.join(root, "main.pdf"), "utf8"), "old-pdf");
      assert.equal(await fs.readFile(path.join(root, "main.synctex.gz"), "utf8"), "old-sync");
      await assert.rejects(fs.stat(path.join(root, ".circletex-build-transaction.json")));
    } finally {
      await fs.rm(root, { recursive: true, force: true });
      await fs.rm(build, { recursive: true, force: true });
    }
  });

  it("提交前验证返回后源码变化仍拒绝发布", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "circletex-publish-test-"));
    const build = await fs.mkdtemp(path.join(os.tmpdir(), "circletex-build-test-"));
    try {
      const source = "source-before-validator";
      const sourcePath = path.join(root, "main.tex");
      await fs.writeFile(sourcePath, source);
      await fs.writeFile(path.join(root, "main.pdf"), "old-pdf");
      await fs.writeFile(path.join(root, "main.synctex.gz"), "old-sync");
      await fs.writeFile(path.join(build, "main.pdf"), "new-pdf");
      await fs.writeFile(path.join(build, "main.synctex.gz"), "new-sync");

      await assert.rejects(
        publishBuild(root, build, {
          sourcePath,
          expectedSourceHash: createHash("sha256").update(source).digest("hex"),
          validateBeforeCommit: () => fs.writeFile(sourcePath, "source-after-validator")
        }),
        /main\.tex 在产物发布期间发生了变化/
      );

      assert.equal(await fs.readFile(sourcePath, "utf8"), "source-after-validator");
      assert.equal(await fs.readFile(path.join(root, "main.pdf"), "utf8"), "old-pdf");
      assert.equal(await fs.readFile(path.join(root, "main.synctex.gz"), "utf8"), "old-sync");
      await assert.rejects(fs.stat(path.join(root, ".circletex-build-transaction.json")));
    } finally {
      await fs.rm(root, { recursive: true, force: true });
      await fs.rm(build, { recursive: true, force: true });
    }
  });
});
