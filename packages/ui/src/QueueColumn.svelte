<script lang="ts">
  /**
   * The per-worktree task queue, rendered as the first column inside a
   * worktree row's `.sessions-strip` (same height as the terminal columns).
   * A backlog of named tasks a user or another agent has queued; worked off
   * by a human. No spawning yet (see plans/PLAN-tasks.md) — clicking a task
   * expands its prompt; the actions are add / mark-done / delete.
   *
   * Layout/look lives in styles/task-queue.css (a strip sibling, so its frame
   * and the row-folded display:none rules want to reach it the same way they
   * reach .session-col).
   */
  import { onMount } from "svelte";
  import {
    tasksByWorktree,
    worktreeTaskKey,
    sortTasksForDisplay,
    taskCounts,
    refreshTasks,
    createTask,
    setTaskStatus,
    deleteTask,
    type Task,
    type TaskAgent,
  } from "./tasks-store";

  export let worktreePath: string;
  export let daemonId: string | undefined = undefined;
  /** Open a live agent column for a task. Supplied by App.svelte, which
   *  owns `openSessionsByWt`; QueueColumn only flips the task status here. */
  export let onStart: ((task: Task) => void) | undefined = undefined;

  $: key = worktreeTaskKey(daemonId, worktreePath);
  $: list = sortTasksForDisplay($tasksByWorktree[key] ?? []);
  $: counts = taskCounts(list);

  let adding = false;
  let draftName = "";
  let draftAgent: TaskAgent = "claude";
  let draftPrompt = "";
  let expandedId: string | null = null;
  let busy = false;

  // Load this daemon's tasks once on mount. refreshTasks de-dupes in-flight
  // requests per daemon, so the N queue columns sharing a daemon collapse to
  // a single GET.
  onMount(() => {
    void refreshTasks(daemonId);
  });

  async function add() {
    const name = draftName.trim();
    if (!name || busy) return;
    busy = true;
    await createTask(
      {
        worktreePath,
        agent: draftAgent,
        name,
        prompt: draftPrompt.trim() || undefined,
      },
      daemonId,
    );
    busy = false;
    draftName = "";
    draftPrompt = "";
    adding = false;
  }

  async function markDone(t: Task) {
    await setTaskStatus(t.id, t.status === "done" ? "ready" : "done", daemonId);
  }

  /** Play button: spin up the agent session in this worktree (App owns the
   *  session list) and flip the task to "running". */
  async function start(t: Task) {
    onStart?.(t);
    if (t.status !== "running") {
      await setTaskStatus(t.id, "running", daemonId);
    }
  }

  async function remove(t: Task) {
    if (expandedId === t.id) expandedId = null;
    await deleteTask(t.id, daemonId);
  }

  function toggleExpand(id: string) {
    expandedId = expandedId === id ? null : id;
  }

  const AGENTS: TaskAgent[] = ["claude", "codex", "shell"];
</script>

<section class="queue-col" data-wt-queue={worktreePath}>
  <div class="queue-head">
    <span class="queue-label">QUEUE</span>
    <span class="queue-count" title="{counts.ready} ready · {counts.blocked} blocked · {counts.done} done"
      >{counts.total}</span
    >
    <span class="queue-head-spacer"></span>
    <button
      class="queue-add-btn"
      title="Queue a task"
      aria-label="Queue a task"
      on:click={() => (adding = !adding)}>{adding ? "×" : "+"}</button
    >
  </div>

  {#if adding}
    <div class="queue-composer">
      <!-- svelte-ignore a11y-autofocus -->
      <input
        class="queue-input"
        placeholder="task name…"
        bind:value={draftName}
        autofocus
        on:keydown={(e) => {
          if (e.key === "Enter") add();
          if (e.key === "Escape") adding = false;
        }}
      />
      <textarea
        class="queue-prompt"
        placeholder="prompt for the agent (optional)…"
        rows="2"
        bind:value={draftPrompt}
      ></textarea>
      <div class="queue-composer-row">
        <select class="queue-agent-select" bind:value={draftAgent}>
          {#each AGENTS as a}
            <option value={a}>{a}</option>
          {/each}
        </select>
        <button class="queue-add-confirm" disabled={!draftName.trim() || busy} on:click={add}>
          {busy ? "Adding…" : "Add"}
        </button>
      </div>
    </div>
  {/if}

  <div class="queue-list">
    {#if list.length === 0 && !adding}
      <button class="queue-empty" on:click={() => (adding = true)}>
        No tasks queued — <span class="queue-empty-cta">＋ add one</span>
      </button>
    {/if}

    {#each list as t (t.id)}
      <div
        class="queue-task queue-task-{t.status}"
        class:queue-task-selected={expandedId === t.id}
        on:click={() => toggleExpand(t.id)}
        on:keydown={(e) => {
          if (e.key === "Enter" || e.key === " ") toggleExpand(t.id);
        }}
        role="button"
        tabindex="0"
      >
        <span class="queue-dot"></span>
        <div class="queue-task-body">
          <div class="queue-task-title">{t.name}</div>
          <div class="queue-task-meta">
            <span class="queue-badge queue-badge-{t.status}">{t.status}</span>
            <span class="queue-agent-chip">{t.agent}</span>
            {#if t.createdBy === "agent"}
              <span class="queue-by-agent" title="filed by an agent">⟳ agent</span>
            {/if}
          </div>
          {#if expandedId === t.id}
            {#if t.prompt}
              <div class="queue-task-prompt">{t.prompt}</div>
            {/if}
            {#if t.blockedReason}
              <div class="queue-task-blocked">blocked: {t.blockedReason}</div>
            {/if}
            <div class="queue-task-actions">
              <button
                class="queue-task-action"
                on:click|stopPropagation={() => markDone(t)}
              >
                {t.status === "done" ? "↺ reopen" : "✓ done"}
              </button>
              <button
                class="queue-task-action queue-task-danger"
                on:click|stopPropagation={() => remove(t)}>delete</button
              >
            </div>
          {/if}
        </div>
        {#if t.status === "ready" || t.status === "blocked"}
          <button
            class="queue-play"
            title={`Start this task — opens a ${t.agent} session here`}
            aria-label="Start task"
            on:click|stopPropagation={() => start(t)}
          >▶</button>
        {/if}
      </div>
    {/each}
  </div>
</section>
