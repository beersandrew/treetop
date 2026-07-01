/**
 * Rebuild the prod SPA — the "redeploy dev → local prod" action.
 *
 * The prod daemon serves `packages/ui/dist` fresh from disk on every GET
 * (see UI_DIR in server.ts), so regenerating that directory IS a full UI
 * redeploy: no daemon restart, no killed PTYs. This module owns the build
 * itself so the /api/deploy route stays a thin wrapper and the orchestration
 * (which command, which cwd, how the result maps to a response) is testable
 * without paying for a real ~30s Vite build.
 */

/** Command that rebuilds the prod SPA into `packages/ui/dist`. Matches the
 *  root package.json `build:bun` script (`cd packages/ui && bun run build`). */
export const BUILD_COMMAND = ["bun", "run", "build:bun"] as const;

export interface DeployResult {
  /** True when the build exited 0. */
  ok: boolean;
  /** Process exit code (null if the process was killed by a signal). */
  code: number | null;
  /** Tail of combined stdout+stderr — the error, or the success summary. */
  output: string;
  /** Wall-clock build time in milliseconds. */
  durationMs: number;
}

export interface CommandOutcome {
  code: number | null;
  output: string;
}

/** The one system boundary — spawning a process. Injectable so tests drive
 *  success/failure deterministically instead of running a real build. */
export type CommandRunner = (
  cmd: readonly string[],
  cwd: string,
) => Promise<CommandOutcome>;

/** Default runner: spawn the build, capture stdout+stderr, await exit. */
export const spawnRunner: CommandRunner = async (cmd, cwd) => {
  const proc = Bun.spawn([...cmd], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: process.env,
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, output: `${stdout}${stderr}` };
};

/** Keep only the last `maxLines` lines so a toast/log isn't flooded by a
 *  full build transcript — the tail carries what actually matters. */
export function tailOutput(output: string, maxLines = 40): string {
  const lines = output.replace(/\s+$/, "").split("\n");
  return lines.slice(-maxLines).join("\n");
}

/** Rebuild the prod SPA from `sourceRoot` (the repo root). */
export async function runDeploy(
  sourceRoot: string,
  run: CommandRunner = spawnRunner,
): Promise<DeployResult> {
  const start = performance.now();
  const { code, output } = await run(BUILD_COMMAND, sourceRoot);
  return {
    ok: code === 0,
    code,
    output: tailOutput(output),
    durationMs: Math.round(performance.now() - start),
  };
}
