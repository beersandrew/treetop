import { expect, test, describe } from "bun:test";
import {
  BUILD_COMMAND,
  runDeploy,
  tailOutput,
  type CommandRunner,
} from "../src/deploy";

describe("runDeploy", () => {
  test("runs the SPA build command in the given source root", async () => {
    let seenCmd: readonly string[] | null = null;
    let seenCwd: string | null = null;
    const runner: CommandRunner = async (cmd, cwd) => {
      seenCmd = cmd;
      seenCwd = cwd;
      return { code: 0, output: "built\n" };
    };

    await runDeploy("/repo/root", runner);

    expect(seenCmd).toEqual(BUILD_COMMAND);
    expect(seenCwd).toBe("/repo/root");
  });

  test("maps a clean exit to ok:true", async () => {
    const runner: CommandRunner = async () => ({
      code: 0,
      output: "✓ built in 1.2s\n",
    });
    const result = await runDeploy("/repo", runner);
    expect(result.ok).toBe(true);
    expect(result.code).toBe(0);
    expect(result.output).toContain("built");
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  test("maps a non-zero exit to ok:false and keeps the failure output", async () => {
    const runner: CommandRunner = async () => ({
      code: 1,
      output: "error: Build failed\nTypeError: boom\n",
    });
    const result = await runDeploy("/repo", runner);
    expect(result.ok).toBe(false);
    expect(result.code).toBe(1);
    expect(result.output).toContain("Build failed");
  });

  test("a signal-killed build (code null) is not ok", async () => {
    const runner: CommandRunner = async () => ({ code: null, output: "" });
    const result = await runDeploy("/repo", runner);
    expect(result.ok).toBe(false);
    expect(result.code).toBeNull();
  });
});

describe("tailOutput", () => {
  test("keeps only the last N lines", () => {
    const output = Array.from({ length: 100 }, (_, i) => `line ${i}`).join("\n");
    const tailed = tailOutput(output, 5);
    expect(tailed.split("\n")).toEqual([
      "line 95",
      "line 96",
      "line 97",
      "line 98",
      "line 99",
    ]);
  });

  test("trims trailing whitespace before tailing so blank tail lines don't crowd out real ones", () => {
    const tailed = tailOutput("real line\n\n\n", 2);
    expect(tailed).toBe("real line");
  });

  test("returns short output unchanged", () => {
    expect(tailOutput("one\ntwo", 40)).toBe("one\ntwo");
  });
});
