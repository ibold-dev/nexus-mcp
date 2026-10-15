import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createStubModel, resolveTestPaths, runTests, TestRunNotAllowedError } from "../src/index.js";

/**
 * The test runner is the only part of the harness that executes anything, so
 * these tests are about what it refuses: absolute paths, traversal, files that
 * are not tests, a missing file, and being off unless turned on.
 */
describe("allowlisted test runner", () => {
  let root: string;

  beforeAll(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "nexus-runner-"));
    await mkdir(path.join(root, "src", "nested"), { recursive: true });
    await writeFile(path.join(root, "src", "a.test.ts"), "export {};\n", "utf8");
    await writeFile(path.join(root, "src", "nested", "b.test.ts"), "export {};\n", "utf8");
    await writeFile(path.join(root, "src", "b.ts"), "export {};\n", "utf8");
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("accepts test files under the root and resolves them", async () => {
    expect(await resolveTestPaths(root, ["src/a.test.ts", "src/nested/b.test.ts"])).toEqual([
      "src/a.test.ts",
      "src/nested/b.test.ts",
    ]);
  });

  it("refuses absolute paths, traversal, non-test files, missing files, and nothing at all", async () => {
    await expect(resolveTestPaths(root, ["/etc/passwd.test.ts"])).rejects.toThrow(/is absolute/);
    await expect(resolveTestPaths(root, ["../outside.test.ts"])).rejects.toThrow(/leaves the repository root/);
    await expect(resolveTestPaths(root, ["src/b.ts"])).rejects.toThrow(/not a test file/);
    await expect(resolveTestPaths(root, ["src/missing.test.ts"])).rejects.toThrow(/does not exist/);
    await expect(resolveTestPaths(root, [])).rejects.toThrow(/at least one test file/);
    await expect(resolveTestPaths(root, ["src/a.test.ts\0"])).rejects.toThrow(/null byte/);
  });

  it("runs nothing unless the operator turned it on", async () => {
    await expect(runTests({ root }, { paths: ["src/a.test.ts"] })).rejects.toThrow(TestRunNotAllowedError);
    await expect(runTests({ root }, { paths: ["src/a.test.ts"] })).rejects.toThrow(/NEXUS_ALLOW_TESTS=1/);
  });

  it("runs the allowlisted command and reports its exit code", async () => {
    const passing = await runTests(
      { root, enabled: true, runner: ["node", "-e", "process.exit(0)"] },
      { paths: ["src/a.test.ts"] },
    );
    expect(passing.exitCode).toBe(0);
    expect(passing.paths).toEqual(["src/a.test.ts"]);
    expect(passing.command).toContain("src/a.test.ts");
    expect(passing.timedOut).toBe(false);

    const failing = await runTests(
      { root, enabled: true, runner: ["node", "-e", "process.exit(3)"] },
      { paths: ["src/a.test.ts"] },
    );
    expect(failing.exitCode).toBe(3);
  });

  it("kills a runner that overruns its timeout", async () => {
    const result = await runTests(
      { root, enabled: true, timeoutMs: 250, runner: ["node", "-e", "setTimeout(() => {}, 10000)"] },
      { paths: ["src/a.test.ts"] },
    );
    expect(result.timedOut).toBe(true);
    expect(result.exitCode).toBeNull();
  });

  it("actually runs the default command, which is the one nobody overrides", async () => {
    // The default runner is only used in production, so a broken flag in it is
    // invisible to every other test here — which is exactly how it shipped with
    // `--reporter=basic`, a reporter Vitest 5 had removed. This runs the real
    // command over a test file that touches no database, and checks it ran.
    const workspace = path.resolve(fileURLToPath(new URL("../../..", import.meta.url)));
    const result = await runTests(
      { root: workspace, enabled: true, timeoutMs: 120_000 },
      { paths: ["packages/agent/test/model.test.ts"] },
    );

    expect(result.command).toContain("vitest");
    expect(result.timedOut).toBe(false);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/Test Files\s+1 passed/);
    // A reporter that does not exist is reported as a missing module, and the
    // run ends before any test does.
    expect(result.stderr).not.toMatch(/Cannot find module|loadCustomReporterModule/);
  }, 180_000);
});

describe("stub model", () => {
  it("calls each scripted tool in order and then reports", async () => {
    const model = createStubModel({
      steps: [{ toolName: "nexus_locate", input: () => ({ query: "helper" }) }],
      report: () => "done",
    });

    const first = await model.doGenerate({ prompt: [{ role: "user", content: [{ type: "text", text: "go" }] }] });
    expect(first.finishReason).toBe("tool-calls");
    expect(first.content[0]).toMatchObject({
      type: "tool-call",
      toolName: "nexus_locate",
      input: JSON.stringify({ query: "helper" }),
    });

    const second = await model.doGenerate({
      prompt: [
        { role: "user", content: [{ type: "text", text: "go" }] },
        {
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolCallId: "stub-call-1",
              toolName: "nexus_locate",
              output: { type: "json", value: { results: [] } },
            },
          ],
        },
      ],
    });
    expect(second.finishReason).toBe("stop");
    expect(second.content[0]).toEqual({ type: "text", text: "done" });
  });

  it("refuses to stream rather than pretending to", async () => {
    const model = createStubModel({ steps: [], report: () => "done" });
    await expect(model.doStream({ prompt: [] })).rejects.toThrow(/streaming/);
  });
});
