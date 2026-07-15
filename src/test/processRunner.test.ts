import * as assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { clearExecutableCache, findExecutable, runProcess } from "../processRunner";

describe("外部进程控制", () => {
  it("收集标准输出与退出码", async () => {
    const result = await runProcess(process.execPath, ["-e", "process.stdout.write('ok')"], {
      cwd: process.cwd(),
      timeoutMs: 5_000
    });
    assert.equal(result.code, 0);
    assert.equal(result.stdout, "ok");
    assert.equal(result.timedOut, false);
  });

  it("超时后终止进程树并正常结算", async () => {
    const result = await runProcess(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], {
      cwd: process.cwd(),
      timeoutMs: 100
    });
    assert.equal(result.timedOut, true);
  });

  it("子进程快速退出时不会因标准输入错误崩溃", async () => {
    const result = await runProcess(process.execPath, ["-e", "process.exit(2)"], {
      cwd: process.cwd(),
      input: "x".repeat(100_000),
      timeoutMs: 5_000
    });
    assert.equal(result.code, 2);
  });

  it("收到取消信号后终止进程并正常结算", async () => {
    const controller = new AbortController();
    const task = runProcess(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], {
      cwd: process.cwd(),
      timeoutMs: 30_000,
      signal: controller.signal
    });
    controller.abort();
    const result = await task;
    assert.equal(result.timedOut, false);
  });

  it("缓存成功的可执行路径并可显式失效", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "circletex-command-cache-"));
    const executable = path.join(root, "tool.exe");
    try {
      await fs.writeFile(executable, "fixture");
      assert.equal(await findExecutable(executable), executable);
      await fs.rm(executable);
      assert.equal(await findExecutable(executable), executable);
      clearExecutableCache(executable);
      assert.equal(await findExecutable(executable), undefined);
    } finally {
      clearExecutableCache(executable);
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
