import { isLiveCodexAppSource } from "./storage";

/**
 * Pure session-source routing helpers extracted from App.svelte.
 * Behaviour pinned by packages/ui/test/session-source-routing.test.ts.
 *
 * None of the functions here perform side effects. All reactive state that
 * was previously closed over in App.svelte is passed as an explicit parameter.
 */

// ---------------------------------------------------------------------------
// Local type definitions
// (mirrors the inline interfaces declared in App.svelte's <script>)
// ---------------------------------------------------------------------------

export interface AgentSession {
  agent: "claude" | "codex" | "copilot" | "ollama" | "shell";
  cwd: string;
  lastActive: string;
  sessionId?: string;
  source: string;
  title?: string;
  lastUserMessage?: string;
  manualTitle?: string;
  aiTitle?: string;
  firstUserMessage?: string;
  lastUserMessages?: string[];
  userMessageCount?: number;
  messageCount?: number;
  recentMessageCount?: number;
  lastMessageTs?: string;
  contextTokens?: number;
  contextTokensExact?: boolean;
  contextWindow?: number;
  model?: string;
}

export interface ShellRecord {
  termId: string;
  wt: string;
  spawnCwd: string;
  currentCwd?: string;
  createdAt: string;
  alive: boolean;
  cmdCount?: number;
  lastCmd?: string;
  lastCmdTs?: string;
  manualTitle?: string;
}

export interface OpenSession {
  agent: AgentSession["agent"] | "shell" | "files" | "history";
  source: string;
  resumeSessionId?: string;
  transcriptSource?: string;
  preassignedSessionId?: string;
  mode?: "terminal";
  ollamaModel?: string;
  contextFilePath?: string;
  /** Prompt seeded into a brand-new agent column when the session is
   *  started from the task queue (play button). Consumed by
   *  `cmdForOpenSession` on the fresh spawn only. */
  initialPrompt?: string;
  attachTermId?: string;
  /** Claude model/effort overrides picked from the session header; passed
   *  through to a `claude --resume … --model/--effort` spawn. */
  claudeModel?: string;
  claudeEffort?: string;
  /** Explicit shell command for a plain terminal column, stamped by the
   *  new-session picker when the box offers >1 shell (Windows: PowerShell
   *  vs CMD). Overrides the daemon's default shell in cmdForOpenSession. */
  shellCmd?: string[];
}

export interface Worktree {
  path: string;
  agents?: AgentSession[];
}

export interface Repo {
  worktrees?: Worktree[];
}

export interface LiveAgentTerminal {
  id: string;
  ownerId?: string;
  cwd: string;
  agent?: string;
  exitedAt?: string;
}

export function shouldMountTerminalView(args: {
  mode: "read" | "terminal";
  hasSessionId: boolean;
  hasCwd: boolean;
  nearViewport: boolean;
}): boolean {
  return (
    args.mode === "terminal" &&
    args.hasSessionId &&
    args.hasCwd &&
    args.nearViewport
  );
}

export function shouldMountNewSessionTerminal(args: {
  hasCwd: boolean;
  nearViewport: boolean;
}): boolean {
  return args.hasCwd && args.nearViewport;
}

export function shouldHoldOffscreenAttachedTerminal(args: {
  attachTermId: string | undefined;
  terminalMounted: boolean;
}): boolean {
  return !!args.attachTermId && !args.terminalMounted;
}

// ---------------------------------------------------------------------------
// resolveTermId
//
// Resolve the daemon termId for a `__new__:` or `__attached__:` column.
// `__attached__:` sources carry it directly in the suffix;
// `__new__:` sources are looked up in `newTermIds`.
//
// Faithful copy of App.svelte `resolveTermId` (line ~970).
// Closed-over `newTermIds` is now an explicit parameter.
// ---------------------------------------------------------------------------

export function resolveTermId(
  s: { source: string },
  newTermIds: Record<string, string>,
): string | undefined {
  if (s.source.startsWith("__attached__:")) return s.source.split(":").pop();
  if (s.source.startsWith("__new__:")) return newTermIds[s.source];
  return undefined;
}

// ---------------------------------------------------------------------------
// isOpenInWt
//
// Returns true when `source` appears in the open-session list for `wtPath`.
//
// Faithful copy of App.svelte `isOpenInWt` (line ~2568).
// Closed-over `openSessionsByWt` is now an explicit parameter.
// ---------------------------------------------------------------------------

export function isOpenInWt(
  wtPath: string,
  source: string,
  openSessionsByWt: Record<string, OpenSession[]>,
): boolean {
  return (openSessionsByWt[wtPath] ?? []).some((s) => s.source === source);
}

// ---------------------------------------------------------------------------
// moveSessionStateKey
//
// Transient UI state (working / awaiting / exited / unread pulse timestamps)
// is keyed by the session source used in openSessionsByWt. When a live column
// is promoted from a synthetic source (`__new__:*`) to its canonical source
// (real JSONL path or `__attached__:shell:<termId>`), the state must move with
// it or the side dock reads a stale key and loses the real session state.
// ---------------------------------------------------------------------------

export function moveSessionStateKey<T>(
  state: Record<string, T>,
  from: string,
  to: string,
): Record<string, T> {
  if (from === to || !(from in state)) return state;
  const next = { ...state };
  if (!(to in next)) next[to] = next[from]!;
  delete next[from];
  return next;
}

export function openSessionHasLiveTerminal(
  session: Pick<OpenSession, "source" | "mode" | "attachTermId">,
  options: {
    liveTerminalIds: ReadonlySet<string>;
    newTermIds: Record<string, string>;
    transientExited?: Record<string, boolean>;
  },
): boolean {
  if (options.transientExited?.[session.source]) return false;

  if (session.source.startsWith("__new__:")) {
    const termId = options.newTermIds[session.source];
    return termId ? options.liveTerminalIds.has(termId) : true;
  }

  if (session.source.startsWith("__attached__:")) {
    const termId = resolveTermId(session, options.newTermIds);
    return !!termId && options.liveTerminalIds.has(termId);
  }

  if (session.mode !== "terminal") return false;
  return (
    !!session.attachTermId && options.liveTerminalIds.has(session.attachTermId)
  );
}

export function openSessionHasDockActivity(
  session: Pick<OpenSession, "agent" | "source" | "mode" | "attachTermId">,
  options: {
    liveTerminalIds: ReadonlySet<string>;
    newTermIds: Record<string, string>;
    transientExited?: Record<string, boolean>;
    transientWorking?: Record<string, boolean>;
    transientAwaiting?: Record<string, boolean>;
  },
): boolean {
  if (
    openSessionHasLiveTerminal(session, {
      liveTerminalIds: options.liveTerminalIds,
      newTermIds: options.newTermIds,
      transientExited: options.transientExited,
    })
  ) {
    return true;
  }
  if (
    session.agent === "shell" ||
    session.agent === "files" ||
    session.agent === "history" ||
    options.transientExited?.[session.source]
  ) {
    return false;
  }
  if (session.agent === "codex" && isLiveCodexAppSource(session.source)) {
    return true;
  }
  return (
    options.transientWorking?.[session.source] === true ||
    options.transientAwaiting?.[session.source] === true
  );
}

export function canResumeVisualSurface(options: {
  agent: string;
  liveAppSurface: boolean;
  sessionId: string | undefined | null;
  hasVisualResume: boolean;
}): boolean {
  if (options.agent !== "codex") return false;
  if (options.liveAppSurface) return false;
  return !!options.sessionId && options.hasVisualResume;
}

export function reconcileLiveAgentTerminals(
  byWt: Record<string, OpenSession[]>,
  repos: readonly Repo[],
  terminals: readonly LiveAgentTerminal[],
): Record<string, OpenSession[]> {
  const liveByOwner = new Map<string, LiveAgentTerminal>();
  for (const t of terminals) {
    if (!t.ownerId || t.exitedAt || t.agent === "shell") continue;
    liveByOwner.set(t.ownerId, t);
  }
  if (liveByOwner.size === 0) return byWt;

  const sessionIdByWtAndSource = new Map<string, string>();
  for (const repo of repos) {
    for (const wt of repo.worktrees ?? []) {
      for (const agent of wt.agents ?? []) {
        if (!agent.sessionId) continue;
        sessionIdByWtAndSource.set(
          `${wt.path}\0${agent.source}`,
          agent.sessionId,
        );
      }
    }
  }

  let changed = false;
  const next: Record<string, OpenSession[]> = { ...byWt };
  for (const [wtPath, sessions] of Object.entries(byWt)) {
    let nextSessions: OpenSession[] | null = null;
    sessions.forEach((s, index) => {
      if (s.agent === "shell" || s.agent === "files" || s.agent === "history")
        return;
      const sessionId =
        s.resumeSessionId ??
        s.preassignedSessionId ??
        sessionIdByWtAndSource.get(`${wtPath}\0${s.source}`);
      if (!sessionId) return;
      const live = liveByOwner.get(sessionId);
      if (!live || live.cwd !== wtPath) return;
      if (s.attachTermId === live.id && s.mode === "terminal") return;
      if (!nextSessions) nextSessions = sessions.slice();
      nextSessions[index] = {
        ...s,
        mode: "terminal",
        attachTermId: live.id,
      };
      changed = true;
    });
    if (nextSessions) next[wtPath] = nextSessions;
  }
  return changed ? next : byWt;
}

// ---------------------------------------------------------------------------
// selectSessionsForBackgroundSpawn
//
// After a daemon restart the helper dies with the daemon, so every
// persisted `mode:"terminal"` agent session loses its PTY. Their columns
// stay mounted (`.row-body` is `display:none`, not unmounted) but the
// xterm/TerminalView is deferred until the column scrolls into view —
// so the dock dot only lights once the user reaches the column, which
// re-spawns `claude --resume`. To make live TUIs active at startup we
// eagerly re-spawn those PTYs in the background (caller staggers them),
// then stamp `attachTermId` so the mounted SessionView's hold socket
// keeps each one alive.
//
// This is the pure selection half: which restorable sessions still need a
// background spawn right now. A session qualifies when it's a resumable
// agent (claude/codex) in terminal mode with a `resumeSessionId`, and it
// has NO live PTY yet — neither an `attachTermId` that's currently live,
// nor a column-spawned PTY (`newTermIds[source]`), nor an in-flight
// background spawn (`inFlight`). As spawns land (attachTermId set +
// liveTerminalIds grows) candidates drop out, so calling this each tick
// converges without double-spawning.
// ---------------------------------------------------------------------------

export interface BackgroundSpawnCandidate {
  wtPath: string;
  source: string;
  agent: "claude" | "codex";
  resumeSessionId: string;
  claudeModel?: string;
  claudeEffort?: string;
}

export function selectSessionsForBackgroundSpawn(
  byWt: Record<string, OpenSession[]>,
  options: {
    liveTerminalIds: ReadonlySet<string>;
    inFlight: ReadonlySet<string>;
    newTermIds: Record<string, string>;
  },
): BackgroundSpawnCandidate[] {
  const out: BackgroundSpawnCandidate[] = [];
  for (const [wtPath, sessions] of Object.entries(byWt)) {
    for (const s of sessions) {
      if (s.agent !== "claude" && s.agent !== "codex") continue;
      if (s.mode !== "terminal") continue;
      if (!s.resumeSessionId) continue;
      // Already (or about to be) backed by a PTY — skip.
      if (s.attachTermId && options.liveTerminalIds.has(s.attachTermId))
        continue;
      if (options.newTermIds[s.source]) continue;
      if (options.inFlight.has(s.source)) continue;
      out.push({
        wtPath,
        source: s.source,
        agent: s.agent,
        resumeSessionId: s.resumeSessionId,
        ...(s.claudeModel ? { claudeModel: s.claudeModel } : {}),
        ...(s.claudeEffort ? { claudeEffort: s.claudeEffort } : {}),
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// normalizeSessionForOpen
//
// Rewrite a picker-supplied OpenSession when needed. Ollama sessions
// surface from `/api/agents` with `source` set to the JSONL header
// path under `<workspace>/ollama/`; opening one directly would land
// it in the SessionView render branch (which only parses Claude/
// Codex JSONLs and would render blank). Translate to a
// `__transcript__:ollama:<termId>` source — that's the shape
// OllamaTranscriptView mounts on — and stash the model from the
// matching AgentSession so the read-only view knows what to label
// the pill and what to Resume into.
//
// Faithful copy of App.svelte `normalizeSessionForOpen` (line ~2580).
// Closed-over `repos` is now an explicit parameter.
// ---------------------------------------------------------------------------

export function normalizeSessionForOpen(
  wtPath: string,
  s: OpenSession,
  repos: Repo[],
): OpenSession {
  const wt = repos
    .flatMap((r) => r.worktrees ?? [])
    .find((w) => w.path === wtPath);
  const agents = wt?.agents ?? [];
  if (!s.resumeSessionId && (s.agent === "claude" || s.agent === "codex")) {
    const match = agents.find(
      (a) => a.agent === s.agent && a.source === s.source && a.sessionId,
    );
    if (match?.sessionId) return { ...s, resumeSessionId: match.sessionId };
  }
  if (
    s.agent !== "ollama" ||
    s.source.startsWith("__transcript__:") ||
    s.source.startsWith("__new__:") ||
    s.source.startsWith("__attached__:")
  ) {
    return s;
  }
  // Header path is `<workspace>/ollama/<termId>.jsonl`. The termId is
  // the basename without the extension.
  const base = s.source.split(/[\\/]/).pop() ?? "";
  const termId = base.endsWith(".jsonl")
    ? base.slice(0, -".jsonl".length)
    : base;
  if (!termId) return s;
  const match = agents.find(
    (a) =>
      a.agent === "ollama" && (a.sessionId === termId || a.source === s.source),
  );
  return {
    agent: "ollama",
    source: `__transcript__:ollama:${termId}`,
    ollamaModel: match?.model ?? match?.title,
  };
}

// ---------------------------------------------------------------------------
// shellToSession
//
// Map shell records into the same shape as AgentSession so the picker
// can iterate one merged list. The `source` is the synthetic
// attached/transcript token openSessionsByWt expects, so clicking a
// picker row routes through `toggleOpenSessionInWt` unchanged.
//
// Faithful copy of App.svelte `shellToSession` (line ~5310).
// No closed-over state — fully pure.
// ---------------------------------------------------------------------------

export function shellToSession(sh: ShellRecord): AgentSession {
  return {
    agent: "shell",
    cwd: sh.wt,
    // Age by most recent activity, not spawn time, so a shell the
    // user touched five minutes ago ranks above one they spawned an
    // hour ago and abandoned.
    lastActive: sh.lastCmdTs ?? sh.createdAt,
    source: sh.alive
      ? `__attached__:shell:${sh.termId}`
      : `__transcript__:shell:${sh.termId}`,
    title: sh.currentCwd ?? sh.spawnCwd,
    sessionId: sh.termId,
    // Feed the last command through `lastUserMessage` so it both
    // renders inline on the row and participates in fuzzy search
    // ("which shell did I run `bun test` in?").
    lastUserMessage: sh.lastCmd,
    messageCount: sh.cmdCount,
    manualTitle: sh.manualTitle,
  };
}

// ---------------------------------------------------------------------------
// shellSourceToDismiss
//
// Returns the source string that should be passed to `dismissShellSource`,
// or null if this session should NOT be dismissed (non-shell, or unknown form).
//
// This is the PURE DECISION part of App.svelte `dismissIfShell` (line ~2647).
// The side effect (calling dismissShellSource) remains in App.svelte's thin
// wrapper. Closed-over `newTermIds` is now an explicit parameter.
// ---------------------------------------------------------------------------

export function shellSourceToDismiss(
  source: string,
  newTermIds: Record<string, string>,
): string | null {
  if (
    source.startsWith("__attached__:shell:") ||
    source.startsWith("__transcript__:shell:")
  ) {
    return source;
  } else if (source.startsWith("__new__:shell:")) {
    const termId = newTermIds[source];
    if (termId) return `__attached__:shell:${termId}`;
  }
  return null;
}
