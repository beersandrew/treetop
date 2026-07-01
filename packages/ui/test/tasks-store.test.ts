import { test, expect, describe } from "bun:test";
import {
  worktreeTaskKey,
  sortTasksForDisplay,
  taskCounts,
  groupTasksByWorktree,
  replaceWorktreeGroupsForDaemon,
  type Task,
} from "../src/tasks-store";

function mk(partial: Partial<Task> & { id: string }): Task {
  return {
    worktreePath: "/wt",
    agent: "claude",
    name: partial.id,
    status: "ready",
    createdBy: "user",
    createdAt: "2026-06-30T00:00:00.000Z",
    ...partial,
  };
}

describe("worktreeTaskKey", () => {
  test("disambiguates same path across daemons", () => {
    expect(worktreeTaskKey(undefined, "/wt")).not.toBe(
      worktreeTaskKey("d1", "/wt"),
    );
    expect(worktreeTaskKey(null, "/wt")).toBe(worktreeTaskKey(undefined, "/wt"));
  });
});

describe("sortTasksForDisplay", () => {
  test("orders ready → blocked → done, oldest-first within a group", () => {
    const list = [
      mk({ id: "done-old", status: "done", createdAt: "2026-06-01T00:00:00Z" }),
      mk({ id: "ready-new", status: "ready", createdAt: "2026-06-20T00:00:00Z" }),
      mk({ id: "blocked", status: "blocked", createdAt: "2026-06-10T00:00:00Z" }),
      mk({ id: "ready-old", status: "ready", createdAt: "2026-06-05T00:00:00Z" }),
    ];
    expect(sortTasksForDisplay(list).map((t) => t.id)).toEqual([
      "ready-old",
      "ready-new",
      "blocked",
      "done-old",
    ]);
  });

  test("does not mutate the input array", () => {
    const list = [mk({ id: "b", createdAt: "2026-06-02T00:00:00Z" }), mk({ id: "a", createdAt: "2026-06-01T00:00:00Z" })];
    const before = list.map((t) => t.id);
    sortTasksForDisplay(list);
    expect(list.map((t) => t.id)).toEqual(before);
  });
});

describe("taskCounts", () => {
  test("counts per status and total", () => {
    const list = [
      mk({ id: "1", status: "ready" }),
      mk({ id: "2", status: "ready" }),
      mk({ id: "3", status: "blocked" }),
      mk({ id: "4", status: "done" }),
    ];
    expect(taskCounts(list)).toEqual({
      ready: 2,
      running: 0,
      blocked: 1,
      done: 1,
      total: 4,
    });
  });
});

describe("groupTasksByWorktree", () => {
  test("buckets tasks by their worktree key", () => {
    const grouped = groupTasksByWorktree(
      [
        mk({ id: "a", worktreePath: "/wt/x" }),
        mk({ id: "b", worktreePath: "/wt/y" }),
        mk({ id: "c", worktreePath: "/wt/x" }),
      ],
      undefined,
    );
    expect(Object.keys(grouped).sort()).toEqual(
      [worktreeTaskKey(undefined, "/wt/x"), worktreeTaskKey(undefined, "/wt/y")].sort(),
    );
    expect(grouped[worktreeTaskKey(undefined, "/wt/x")]!.map((t) => t.id)).toEqual([
      "a",
      "c",
    ]);
  });
});

describe("replaceWorktreeGroupsForDaemon", () => {
  test("replaces only the named daemon's keys, leaving others intact", () => {
    const prev = {
      [worktreeTaskKey(undefined, "/wt/x")]: [mk({ id: "local-old" })],
      [worktreeTaskKey("d1", "/wt/x")]: [mk({ id: "remote-keep" })],
    };
    const fresh = groupTasksByWorktree(
      [mk({ id: "local-new", worktreePath: "/wt/x" })],
      undefined,
    );
    const next = replaceWorktreeGroupsForDaemon(prev, undefined, fresh);
    // local daemon's worktree got the fresh list…
    expect(next[worktreeTaskKey(undefined, "/wt/x")]!.map((t) => t.id)).toEqual([
      "local-new",
    ]);
    // …the remote daemon's entry is untouched.
    expect(next[worktreeTaskKey("d1", "/wt/x")]!.map((t) => t.id)).toEqual([
      "remote-keep",
    ]);
  });

  test("drops a worktree that no longer has tasks on refresh", () => {
    const prev = {
      [worktreeTaskKey(undefined, "/wt/gone")]: [mk({ id: "x" })],
    };
    const next = replaceWorktreeGroupsForDaemon(prev, undefined, {});
    expect(next[worktreeTaskKey(undefined, "/wt/gone")]).toBeUndefined();
  });
});
