/**
 * Integration tests for the add/remove/rename + undo/redo state machine.
 *
 * These exercise Workspace + EventLog together using the exact payload
 * contracts the server routes write — they would have caught the
 * "redo says not found" bug we hit when --hot didn't reload the new redo
 * route. Treat each route's logic as a pure function from (workspace,
 * events, eventId, toggle) -> next state, and assert that round-trips
 * don't lose information.
 */

import { test, expect, describe } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Workspace, type Repo, type Task } from "../src/workspace";
import { EventLog } from "../src/events";
import { NotesStore } from "../src/notes";

async function tempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "supergit-integration-"));
}

// Mirror of the server's undo handler for add_repo / remove_repo / rename_repo
// and create_note / remove_note. The notes-store dep is optional so existing
// repo-only tests don't have to thread an empty notes object through.
async function undoAction(
  ws: Workspace,
  events: EventLog,
  eventId: string,
  notes?: NotesStore,
): Promise<void> {
  const ev = await events.findById(eventId);
  if (!ev) throw new Error("event not found");
  if (!ev.reversible || ev.inverse === undefined)
    throw new Error("not reversible");
  if (ev.undone) throw new Error("already undone");

  if (ev.type === "add_repo") {
    const inv = ev.inverse as { repo: { id: string } };
    const removed = await ws.removeRepo(inv.repo.id);
    if (!removed) throw new Error("inverse failed: repo no longer exists");
  } else if (ev.type === "remove_repo") {
    const inv = ev.inverse as { repo: Repo };
    await ws.restoreRepo(inv.repo);
  } else if (ev.type === "rename_repo") {
    const inv = ev.inverse as { id: string; oldName: string };
    await ws.renameRepo(inv.id, inv.oldName);
  } else if (ev.type === "create_note") {
    if (!notes) throw new Error("notes store required for create_note undo");
    const inv = ev.inverse as { note: { id: string } };
    await notes.remove(inv.note.id);
  } else if (ev.type === "remove_note") {
    if (!notes) throw new Error("notes store required for remove_note undo");
    const inv = ev.inverse as {
      note: { id: string; body: string; anchors: string[]; tags: string[] };
    };
    await notes.create({
      id: inv.note.id,
      body: inv.note.body,
      anchors: inv.note.anchors,
      tags: inv.note.tags,
    });
  } else if (ev.type === "add_task") {
    const inv = ev.inverse as { task: { id: string } };
    const removed = await ws.removeTask(inv.task.id);
    if (!removed) throw new Error("inverse failed: task no longer exists");
  } else if (ev.type === "remove_task") {
    const inv = ev.inverse as { task: Task };
    await ws.restoreTask(inv.task);
  } else if (ev.type === "update_task") {
    // Restore the exact prior record: drop the current row, re-insert the
    // snapshot stashed in the inverse.
    const inv = ev.inverse as { previous: Task };
    await ws.removeTask(inv.previous.id);
    await ws.restoreTask(inv.previous);
  } else {
    throw new Error(`no inverse handler for ${ev.type}`);
  }
  await events.append({
    type: "undo",
    actor: "user",
    payload: { eventId },
  });
}

async function redoAction(
  ws: Workspace,
  events: EventLog,
  eventId: string,
  notes?: NotesStore,
): Promise<void> {
  const ev = await events.findById(eventId);
  if (!ev) throw new Error("event not found");
  if (!ev.reversible || ev.inverse === undefined)
    throw new Error("not reversible");
  if (!ev.undone) throw new Error("nothing to redo");

  if (ev.type === "add_repo") {
    const inv = ev.inverse as { repo: Repo };
    await ws.restoreRepo(inv.repo);
  } else if (ev.type === "remove_repo") {
    const inv = ev.inverse as { repo: { id: string } };
    const removed = await ws.removeRepo(inv.repo.id);
    if (!removed) throw new Error("redo failed: repo no longer exists");
  } else if (ev.type === "rename_repo") {
    const p = ev.payload as { id: string; newName: string };
    await ws.renameRepo(p.id, p.newName);
  } else if (ev.type === "create_note") {
    if (!notes) throw new Error("notes store required for create_note redo");
    const inv = ev.inverse as {
      note: { id: string; body: string; anchors: string[]; tags: string[] };
    };
    await notes.create({
      id: inv.note.id,
      body: inv.note.body,
      anchors: inv.note.anchors,
      tags: inv.note.tags,
    });
  } else if (ev.type === "remove_note") {
    if (!notes) throw new Error("notes store required for remove_note redo");
    const inv = ev.inverse as { note: { id: string } };
    await notes.remove(inv.note.id);
  } else if (ev.type === "add_task") {
    const inv = ev.inverse as { task: Task };
    await ws.restoreTask(inv.task);
  } else if (ev.type === "remove_task") {
    const inv = ev.inverse as { task: { id: string } };
    const removed = await ws.removeTask(inv.task.id);
    if (!removed) throw new Error("redo failed: task no longer exists");
  } else if (ev.type === "update_task") {
    const p = ev.payload as { id: string; patch: Record<string, unknown> };
    await ws.updateTask(p.id, p.patch);
  } else {
    throw new Error(`no redo handler for ${ev.type}`);
  }
  await events.append({
    type: "redo",
    actor: "user",
    payload: { eventId },
  });
}

describe("add → undo → redo round-trip", () => {
  test("restores the same repo with the same id and metadata", async () => {
    const dir = await tempDir();
    const ws = await Workspace.open(dir);
    const events = await EventLog.open(dir);

    const repo = await ws.addRepo("/tmp/foo");
    const addEv = await events.append({
      type: "add_repo",
      actor: "user",
      payload: { path: "/tmp/foo" },
      inverse: { repo },
    });

    expect(await ws.listRepos()).toHaveLength(1);

    await undoAction(ws, events, addEv.id);
    expect(await ws.listRepos()).toHaveLength(0);
    expect((await events.findById(addEv.id))?.undone).toBe(true);
    expect((await events.findById(addEv.id))?.redoable).toBe(true);

    await redoAction(ws, events, addEv.id);
    const after = await ws.listRepos();
    expect(after).toHaveLength(1);
    expect(after[0]?.id).toBe(repo.id);
    expect(after[0]?.addedAt).toBe(repo.addedAt);
    expect((await events.findById(addEv.id))?.undone).toBe(false);
  });

  test("undo → redo → undo flips correctly through the chain", async () => {
    const dir = await tempDir();
    const ws = await Workspace.open(dir);
    const events = await EventLog.open(dir);

    const repo = await ws.addRepo("/tmp/foo");
    const addEv = await events.append({
      type: "add_repo",
      actor: "user",
      payload: { path: "/tmp/foo" },
      inverse: { repo },
    });

    await undoAction(ws, events, addEv.id);
    await redoAction(ws, events, addEv.id);
    await undoAction(ws, events, addEv.id);

    expect(await ws.listRepos()).toEqual([]);
    expect((await events.findById(addEv.id))?.undone).toBe(true);
  });
});

describe("remove → undo → redo round-trip", () => {
  test("restores the removed repo on undo, removes it again on redo", async () => {
    const dir = await tempDir();
    const ws = await Workspace.open(dir);
    const events = await EventLog.open(dir);

    const repo = await ws.addRepo("/tmp/foo");
    await ws.removeRepo(repo.id);
    const removeEv = await events.append({
      type: "remove_repo",
      actor: "user",
      payload: { id: repo.id },
      inverse: { repo },
    });

    expect(await ws.listRepos()).toEqual([]);

    await undoAction(ws, events, removeEv.id);
    expect((await ws.listRepos())[0]?.id).toBe(repo.id);

    await redoAction(ws, events, removeEv.id);
    expect(await ws.listRepos()).toEqual([]);
  });
});

describe("rename works correctly regardless of how many worktrees the repo has", () => {
  test("renameRepo updates the single shared repo entry; listRepos reflects it once", async () => {
    const dir = await tempDir();
    const ws = await Workspace.open(dir);
    const repo = await ws.addRepo("/Users/me/multi-wt-repo");
    // Simulating "this repo has multiple worktrees" — the workspace stores
    // ONE Repo entry per repo, regardless of git worktree count. The UI
    // renders one row per worktree but they all share the same Repo id.
    // Renaming via id must succeed without depending on row identity.
    const result = await ws.renameRepo(repo.id, "MultiWtRenamed");
    expect(result).toEqual({
      oldName: "multi-wt-repo",
      newName: "MultiWtRenamed",
    });
    const after = await ws.listRepos();
    expect(after).toHaveLength(1);
    expect(after[0]?.id).toBe(repo.id);
    expect(after[0]?.name).toBe("MultiWtRenamed");
  });
});

describe("rename → undo → redo round-trip", () => {
  test("restores the old name on undo and reapplies the new one on redo", async () => {
    const dir = await tempDir();
    const ws = await Workspace.open(dir);
    const events = await EventLog.open(dir);

    const repo = await ws.addRepo("/tmp/foo");
    const { oldName, newName } = await ws.renameRepo(repo.id, "FancyName");
    const ev = await events.append({
      type: "rename_repo",
      actor: "user",
      payload: { id: repo.id, newName },
      inverse: { id: repo.id, oldName },
    });

    expect((await ws.listRepos())[0]?.name).toBe("FancyName");

    await undoAction(ws, events, ev.id);
    expect((await ws.listRepos())[0]?.name).toBe("foo");

    await redoAction(ws, events, ev.id);
    expect((await ws.listRepos())[0]?.name).toBe("FancyName");
  });
});

// Note-create / note-remove flow exactly as the server's POST/DELETE
// routes write it: every mutation appends an event with the full note
// in `inverse` so the toggle handler can recreate or re-delete by id.
// Anchored with this contract because Ctrl+Z in the UI calls into
// /api/events/:id/undo on the latest reversible event — drift between
// route writes and toggle reads would silently break "undo my delete".
describe("create_note / remove_note → undo → redo round-trips", () => {
  test("undoing a create_note removes the note; redo restores same content", async () => {
    const dir = await tempDir();
    const ws = await Workspace.open(dir);
    const events = await EventLog.open(dir);
    const notes = await NotesStore.open(dir);

    const note = await notes.create({
      id: "n-1",
      body: "hello",
      anchors: ["worktree:/tmp/wt-a"],
      tags: ["bug"],
    });
    const ev = await events.append({
      type: "create_note",
      actor: "user",
      payload: { note },
      inverse: { note },
    });

    expect(await notes.list()).toHaveLength(1);

    await undoAction(ws, events, ev.id, notes);
    expect(await notes.list()).toHaveLength(0);
    expect((await events.findById(ev.id))?.undone).toBe(true);
    expect((await events.findById(ev.id))?.redoable).toBe(true);

    await redoAction(ws, events, ev.id, notes);
    const after = await notes.list();
    expect(after).toHaveLength(1);
    expect(after[0]?.id).toBe("n-1");
    expect(after[0]?.body).toBe("hello");
    expect(after[0]?.anchors).toEqual(["worktree:/tmp/wt-a"]);
    expect(after[0]?.tags).toEqual(["bug"]);
    expect((await events.findById(ev.id))?.undone).toBe(false);
  });

  test("undoing a remove_note restores the same note (id + content + anchors + tags)", async () => {
    const dir = await tempDir();
    const ws = await Workspace.open(dir);
    const events = await EventLog.open(dir);
    const notes = await NotesStore.open(dir);

    const note = await notes.create({
      id: "n-keep",
      body: "**important**",
      anchors: ["worktree:/tmp/wt-a", "commit:abc123"],
      tags: ["followup", "xr"],
    });

    // Server route writes the full note into inverse so the undo
    // handler can recreate it exactly.
    const removed = await notes.remove(note.id);
    expect(removed).toBe(true);
    const ev = await events.append({
      type: "remove_note",
      actor: "user",
      payload: { id: note.id },
      inverse: { note },
    });

    expect(await notes.list()).toHaveLength(0);

    await undoAction(ws, events, ev.id, notes);
    const restored = await notes.get(note.id);
    expect(restored).not.toBeNull();
    expect(restored?.body).toBe("**important**");
    expect(restored?.anchors).toEqual(["worktree:/tmp/wt-a", "commit:abc123"]);
    expect(restored?.tags).toEqual(["followup", "xr"]);

    await redoAction(ws, events, ev.id, notes);
    expect(await notes.get(note.id)).toBeNull();
  });

  test("create → delete → undo-delete brings the note back; second undo (the create) removes it again", async () => {
    const dir = await tempDir();
    const ws = await Workspace.open(dir);
    const events = await EventLog.open(dir);
    const notes = await NotesStore.open(dir);

    // Mimic POST /api/notes: create + emit event.
    const note = await notes.create({ id: "n-2", body: "first" });
    const createEv = await events.append({
      type: "create_note",
      actor: "user",
      payload: { note },
      inverse: { note },
    });

    // Mimic DELETE /api/notes/:id: capture existing, remove, emit event.
    const existing = await notes.get(note.id);
    expect(existing).not.toBeNull();
    await notes.remove(note.id);
    const removeEv = await events.append({
      type: "remove_note",
      actor: "user",
      payload: { id: note.id },
      inverse: { note: existing! },
    });

    expect(await notes.list()).toHaveLength(0);

    // Ctrl+Z target #1: the most recent reversible event is the
    // remove_note — undo it, note comes back.
    await undoAction(ws, events, removeEv.id, notes);
    expect(await notes.list()).toHaveLength(1);

    // Ctrl+Z target #2: now the latest not-undone reversible is the
    // create_note — undo that too and the note is gone for real.
    await undoAction(ws, events, createEv.id, notes);
    expect(await notes.list()).toHaveLength(0);
  });
});

describe("task add → undo → redo round-trip", () => {
  test("restores the same task with the same id and metadata", async () => {
    const dir = await tempDir();
    const ws = await Workspace.open(dir);
    const events = await EventLog.open(dir);

    const task = await ws.addTask({
      worktreePath: "/wt",
      agent: "claude",
      name: "Measure esfUsd caps",
    });
    const addEv = await events.append({
      type: "add_task",
      actor: "user",
      payload: { name: task.name },
      inverse: { task },
    });

    expect(await ws.listTasks()).toHaveLength(1);

    await undoAction(ws, events, addEv.id);
    expect(await ws.listTasks()).toHaveLength(0);
    expect((await events.findById(addEv.id))?.undone).toBe(true);
    expect((await events.findById(addEv.id))?.redoable).toBe(true);

    await redoAction(ws, events, addEv.id);
    const after = await ws.listTasks();
    expect(after).toHaveLength(1);
    expect(after[0]?.id).toBe(task.id);
    expect(after[0]?.createdAt).toBe(task.createdAt);
    expect((await events.findById(addEv.id))?.undone).toBe(false);
  });

  test("update → undo restores the previous record, redo re-applies", async () => {
    const dir = await tempDir();
    const ws = await Workspace.open(dir);
    const events = await EventLog.open(dir);

    const task = await ws.addTask({
      worktreePath: "/wt",
      agent: "claude",
      name: "triage",
    });
    const patch = { status: "done" as const };
    const res = await ws.updateTask(task.id, patch);
    const updEv = await events.append({
      type: "update_task",
      actor: "user",
      payload: { id: task.id, patch },
      inverse: { previous: res!.previous },
    });

    expect((await ws.listTasks())[0]?.status).toBe("done");

    await undoAction(ws, events, updEv.id);
    expect((await ws.listTasks())[0]?.status).toBe("ready");

    await redoAction(ws, events, updEv.id);
    expect((await ws.listTasks())[0]?.status).toBe("done");
  });

  test("an agent-filed task carries actor:agent on its event", async () => {
    const dir = await tempDir();
    const ws = await Workspace.open(dir);
    const events = await EventLog.open(dir);

    const task = await ws.addTask({
      worktreePath: "/wt",
      agent: "codex",
      name: "filed by an agent",
      createdBy: "agent",
    });
    const ev = await events.append({
      type: "add_task",
      actor: "agent",
      payload: { name: task.name },
      inverse: { task },
    });
    expect(task.createdBy).toBe("agent");
    expect((await events.findById(ev.id))?.actor).toBe("agent");
    expect((await events.findById(ev.id))?.reversible).toBe(true);
  });
});
