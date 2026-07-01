# PLAN-tasks.md — in-row task queue + agent ingress

Living plan for the **task queue**: a per-worktree backlog of named, queued
agent sessions, embedded as a column inside each project row (same height as
the terminal windows beside it). Users *and* other agents can file tasks into
it. Mockup that set the direction:
`scratchpad/task-drawers-mockup.html` (in the session scratchpad).

## What it is

Each project row (worktree) owns a small queue of **tasks**. A task is a named
unit of intended agent work — `name`, target `agent`, an optional `prompt`,
and a `status`. The queue is shared state (browser + native app see the same
list), so it lives in the workspace and is served by the daemon, never in
localStorage (CLAUDE.md rule 11).

The headline interaction: a user or an agent **queues** a task; it sits in the
backlog until a human works it off. A **user** can then hit the ▶ play button
to turn a queued task into a live agent session (see "Start" below).
Agent-initiated starts remain out of scope — humans pull tasks off the queue,
so no agent can cause another agent to spawn.

## Scope decisions

- **Queueing is the main flow.** CLI/agent verbs: `add`, `list`, `done`.
- **User-initiated start.** A user can ▶-start a queued task from the UI
  (see "Start" below). This is client-side and rides the existing
  new-session path — no `POST /api/tasks/:id/start` route was needed.
- **Agents can fill the queue, never drain it into new agents.** Only a
  human clicks ▶, so no agent can cause another agent to spawn — no runaway
  fan-out. Humans triage.
- **Status** — `ready`/`blocked` are the actionable backlog; ▶ flips a task
  to `running`; the user marks `done`.

## Data model — `tasks.json` in the workspace

Stored in its own file (not `prefs.json` — prefs is a flat string KV; tasks are
structured records that need filtering by worktree/status and event/undo
inverses). Mirrors the `repos.json` / `remote-daemons.json` collections.

```ts
export type TaskStatus = "ready" | "blocked" | "done";
export type TaskAgent  = "claude" | "codex" | "shell";

export interface Task {
  id: string;
  worktreePath: string;   // the worktree (cwd) this task is queued against
  agent: TaskAgent;
  name: string;
  prompt?: string;        // the work for the agent; surfaced on start (later)
  status: TaskStatus;     // default "ready"
  createdBy: "user" | "agent";
  createdAt: string;      // ISO
  blockedReason?: string;
}
```

`Workspace` methods (mirror remote-daemon CRUD; atomic temp+rename write):
`listTasks()`, `addTask(input)`, `updateTask(id, patch)`, `removeTask(id)`,
`restoreTask(task)`.

## Daemon routes (mirror `/api/repos`)

- `GET    /api/tasks[?worktree=…]` → list (optionally filtered)
- `POST   /api/tasks` → add; event `add_task` (`actor` = user|agent), broadcast
- `PATCH  /api/tasks/:id` → update (`status`/`name`/`prompt`/`blockedReason`);
  event `update_task` with `inverse:{ previous }`
- `DELETE /api/tasks/:id` → remove; event `remove_task` with `inverse:{ task }`

Each mutation appends to `events.jsonl` with an `inverse` and
`broadcast("change", {kind})`; undo/redo handlers added to the existing switch
in `server.ts`. Agent-filed tasks use `actor:"agent"` (already a valid Actor),
so they're attributable and badge-able in the UI.

## Agent ingress

The bridge so an agent *inside* a treetop terminal can reach the daemon:

1. **Additive env injection** into spawned PTYs — `SUPERGIT_DAEMON_URL`,
   `SUPERGIT_WORKSPACE`, `SUPERGIT_WORKTREE` (the spawn cwd). Purely additive in
   `helper.mjs`; the existing `PORT`/`PORTLESS_URL`/`NODE_EXTRA_CA_CERTS` scrub
   stays untouched (CLAUDE.md rule).
2. **A tiny `supergit` CLI** (`bin/` + package.json `"bin"`): `task add`,
   `task list`, `task done`. Reads the env, POSTs `/api/tasks`. Defaults the
   target worktree to its cwd, so an agent just runs
   `supergit task add --agent claude --prompt "…"`.
3. **System-prompt hint** — append one line to the spawn-time system prompt
   (the `--append-system-prompt-file` path already in `cmdForOpenSession`) so
   agents know the capability exists.

## Phasing

1. **Workspace `tasks` collection + `/api/tasks` CRUD + undo + tests.**
2. **Queue column UI** — per-worktree backlog: render, add, mark-done, live
   `change` updates. Clicking a task expands its detail.
3. **Start (▶)** — user-initiated: open a seeded agent column + flip to
   `running` (see "Start" below).
4. **Agent ingress** — env injection + `supergit task add/list/done` CLI +
   system-prompt hint.

## Start (implemented — user-initiated ▶ play button)

Each actionable task (`ready`/`blocked`) shows a ▶ play button in its
`QueueColumn` row. Clicking it opens a live agent column in the task's
worktree, seeded with the task's prompt, and flips the task to `running`.

Chosen implementation is **client-side**, not the daemon-route design
originally sketched below — every other "new session" in the app is created by
adding an entry to `openSessionsByWt` (the daemon spawns the PTY when
`TerminalView` connects), so start rides the same path instead of inventing a
`POST /api/tasks/:id/start`:

- `QueueColumn` gains an `onStart(task)` prop. App.svelte's `startTask` opens
  the session (`openNewAgentSession(wt, agent, prompt)`, or
  `openNewTerminalInWt` for a `shell` task); `QueueColumn` then flips the
  status to `running` via the existing `PATCH /api/tasks/:id`.
- The prompt reaches the agent through the **cmd array**, matching the
  context-handoff path: `cmdForOpenSession` gained an `initialPrompt` that
  appends the prompt as a trailing positional plus
  `--allow-dangerously-skip-permissions` (claude) / a positional (codex). It
  only fires on the *fresh* spawn — the `--resume`/`resume <sid>` branch
  returns first, so a reload after the agent minted its id never re-sends the
  prompt. `initialPrompt` is stamped on the `OpenSession` entry.
- Shell tasks open a plain terminal (no positional prompt).

Not (yet) done: a CLI `task start` verb, and detecting session-end to
auto-flip `running → done` (the user marks done manually for now).

## Tests (TDD, temp dirs, no mocks)

- `workspace.test.ts`: task CRUD — empty, add (id/createdAt/default status),
  persist across reopen, update, remove.
- `integration.test.ts`: `add → undo → redo` round-trip (preserves id +
  createdAt), mirroring the repo round-trip; `update → undo` restores the
  previous record.
- Route/contract test for `POST /api/tasks` incl. `actor:"agent"` once the
  route harness is in play.
