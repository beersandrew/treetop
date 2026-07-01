<script lang="ts">
  import {
    resolveTermId,
    normalizeSessionForOpen,
    shellToSession,
    shellSourceToDismiss,
    moveSessionStateKey,
    openSessionHasLiveTerminal,
    openSessionHasDockActivity,
    reconcileLiveAgentTerminals,
    selectSessionsForBackgroundSpawn,
    type BackgroundSpawnCandidate,
  } from "./session-source-routing";
  import {
    createUnreadPulseManager,
    FINISH_DEBOUNCE_MS,
    READ_GRACE_MS,
    MIN_WORKING_FOR_PULSE_MS,
  } from "./unread-pulse-manager";
  import { apiUrl } from "./api";
  import {
    daemonRepoKey,
    upsertRepo,
    replaceDaemonRepos,
    daemonIdForWorktreePath,
    daemonIdForRepoId,
    repoPrefsKey,
    planRepoRemoval,
    sortReposByKeys,
  } from "./repo-fanout";
  import { onMount, onDestroy, tick } from "svelte";
  import { flip } from "svelte/animate";
  import {
    DismissedSessionsStore,
    ExpandedStore,
    StarredSessionsStore,
    CommandTermStore,
  } from "./storage";
  import { getDaemonKV } from "./daemon-kv";
  import { openUrl } from "./open-url";
  import { createResizeCoalescer } from "./terminal-resize";
  import { restoreScrollAfterDelay } from "./scroll-restore";
  import { msSinceScroll, SCROLL_QUIET_MS } from "./scroll-activity";
  import { animateValue, centerScrollTarget } from "./scroll-util";
  import { singleFlight } from "./single-flight";
  import { record, time, timeAsync } from "./timings";
  import {
    changeKindRequiresDaemonsReload,
    changeKindRequiresEventsReload,
    changeKindRequiresReposReload,
    createFsChangeBatcher,
  } from "./sse-change-kinds";
  import {
    installIdleTracker,
    installTypingTracker,
    isUiIdle,
    onResume,
  } from "./ui-idle";
  import DiffViewer from "./DiffViewer.svelte";
  import AddRemoteDaemonDialog, {
    type ProvisionApi,
    type ProvisionStreamHandlers,
  } from "./AddRemoteDaemonDialog.svelte";
  import DaemonInfoDialog from "./DaemonInfoDialog.svelte";
  import AddRemoteFolderDialog from "./AddRemoteFolderDialog.svelte";
  import type {
    DaemonFormPayload,
    ProvisionFormPayload,
  } from "./remote-daemon-form";
  import SessionView from "./SessionView.svelte";
  import ShellView from "./ShellView.svelte";
  import OllamaTranscriptView from "./OllamaTranscriptView.svelte";
  import Popover from "./Popover.svelte";
  import EventsPopover from "./EventsPopover.svelte";
  import DebugPanel from "./DebugPanel.svelte";
  import { colVisibility, syncOffscreenClass } from "./col-visibility";
  import { fetchOllamaModels } from "./ollama-models";
  import { randomUUID } from "./random-id";
  import Tooltip from "./Tooltip.svelte";
  import ChangedFilesTooltipBody from "./ChangedFilesTooltipBody.svelte";
  import NewSessionCol from "./NewSessionCol.svelte";
  import FileBrowser from "./FileBrowser.svelte";
  import {
    resolveTermIdFromSource,
    parseRemoteSource,
  } from "./file-browser-utils";
  import GitHistory from "./GitHistory.svelte";
  import ProcessList from "./ProcessList.svelte";
  import StatusBadge from "./StatusBadge.svelte";
  import { aheadAged, BLINK_AHEAD_MINUTES } from "./ahead-age";
  import { statusSummary, type FileStatus } from "./status-summary";
  import {
    dockEntryExistsInLoadedRepos,
    planReveal,
    type RevealMode,
  } from "./reveal-session";
  import StickyNotesLayer from "./StickyNotesLayer.svelte";
  import AttachmentIcon from "./AttachmentIcon.svelte";
  import NoteIcon from "./NoteIcon.svelte";
  import AgentIcon from "./AgentIcon.svelte";
  import AgentUsageChip from "./AgentUsageChip.svelte";
  import { spawnNote, flyRestoreNote } from "./StickyNotesLayer.svelte";
  import { notesCountByAnchor, notesAll, type NoteShape } from "./notes-counts";
  import { sessionFocusRequest } from "./session-focus-store";
  import EmojiPicker from "./EmojiPicker.svelte";
  import AnchorPicker from "./AnchorPicker.svelte";
  import OpenInButton from "./OpenInButton.svelte";
  import OpenInActions from "./OpenInActions.svelte";
  import ConfirmDialog from "./ConfirmDialog.svelte";
  import { choiceDialog, confirmDialog } from "./confirm-dialog";
  import SummarizeDialog from "./SummarizeDialog.svelte";
  import ShareSessionDialog from "./ShareSessionDialog.svelte";
  import ReceiveInviteDialog from "./ReceiveInviteDialog.svelte";
  import CopySessionDialog from "./CopySessionDialog.svelte";
  import RepoReorderDialog from "./RepoReorderDialog.svelte";
  import RepairSessionDialog from "./RepairSessionDialog.svelte";
  import SettingsDialog from "./SettingsDialog.svelte";
  import { registerSettings, settingValue } from "./settings-registry";
  import { openInvite } from "./receive-invite-dialog";
  import MessagesInbox from "./MessagesInbox.svelte";
  import { refreshMessages } from "./messages-store";
  import { refreshTasks } from "./tasks-store";
  import QueueColumn from "./QueueColumn.svelte";
  import RepoRecentSummary from "./RepoRecentSummary.svelte";
  import { marked } from "marked";
  import DOMPurify from "dompurify";
  import OnboardingWalkthrough from "./OnboardingWalkthrough.svelte";
  import {
    WALKTHROUGH_STEPS,
    walkthroughSeen,
    markWalkthroughSeen,
    clearWalkthroughSeen,
    clearAllWalkthroughSeen,
  } from "./onboarding-walkthrough";
  import LoadingSpinner from "./LoadingSpinner.svelte";
  import SessionSearchList from "./SessionSearchList.svelte";
  import SessionDock from "./SessionDock.svelte";
  import { filterSessions } from "./sessionSearch";
  import {
    computeStripFilterByWt,
    createStripSearchManager,
    type StripFilter,
  } from "./strip-search-manager";
  import { relativeAge } from "./mention-providers";
  import {
    LINK_TARGET_DRAG_MIME,
    SESSION_LINK_DRAG_MIME,
    sessionIdFromValue,
  } from "./note-inline-attachments";
  import { updateTabIndicator } from "./awaitingBadge";
  import {
    createAttentionChimeState,
    syncAttention,
    dueForChime,
  } from "./attention-chime";
  import { mergeLiveShells, mergePersistedTerminals } from "./shell-restore";
  import {
    OpenSessionsStore,
    SessionSurfaceStore,
    VisibleWorktreesStore,
    SYNTHETIC_SOURCE_PREFIXES,
    applySessionSurfacePreference,
    codexAppSource,
    cmdForOpenSession,
    effectiveVisibleWorktrees,
    filterToExistingSessions,
    hideVisibleWorktree,
    dockSessionHiddenAsForeign,
    openSessionRenderKey,
    rememberedSessionSurface,
    reconcileOpenSessionsWithSurfacePreferences,
    sessionMatchesKnownKeys,
    sessionSurfacePreference,
    sessionSurfaceKeys,
    setSessionMode,
    setSessionAttachTermId,
    showVisibleWorktree,
    stampDiscoveredSessionIdWithDetail,
    toggleVisibleWorktree,
    transientDiscoverySources,
    resolveTitleSource,
    type PersistedSession,
    type SessionSurface,
  } from "./storage";
  import {
    installFetchTracking,
    installGlobalErrorHandlers,
    subscribeErrors,
    hydrateFromServer,
    pushError,
    clearErrors,
    type FrontendErrorEntry,
  } from "./errors";
  import { anchorLabel, eventLabel, type Event } from "./event-format";
  import { play, setEnabled, setMasterVolume } from "./sound";
  import { createToastManager, type Toast } from "./toast-manager";
  import { subscribeToasts } from "./toast-bus";
  import {
    sortBranches,
    wtHasRecentActivity,
    formatRelativeTime,
    repoChipFg,
    targetGlyph,
    notesListDisplay,
    noteExcerpt,
    relTime,
    COMMIT_SUBJECT_MAX,
    clampSubject,
    sessionTooltip,
    pushCount,
    pushBadgeDanger,
    duplicateRepoNotice,
  } from "./display-helpers";
  import { parseNDJSONLines } from "./ndjson-client";
  import {
    formatTerminalIoRate,
    isTerminalRecentlyActive,
    terminalIoStatsByKey,
  } from "./terminal-write-buffer";

  // Wire fetch + global handlers as early as possible — before the first
  // load() fires — so even the initial /api/repos failure ends up in
  // the Events popover.
  installFetchTracking();
  installGlobalErrorHandlers();

  interface BranchStatus {
    branch: string;
    upstream: string | null;
    ahead: number;
    behind: number;
    aheadOldestTime: string | null;
    // Commits reachable from HEAD but from no remote-tracking ref.
    // Filled by the daemon only for branches with no upstream (where
    // `ahead` is always 0); null otherwise. See pushCount().
    unpushed: number | null;
  }
  interface LastCommit {
    sha: string;
    shortSha: string;
    subject: string;
    author: string;
    time: string;
  }
  interface AgentSession {
    /** "shell" is synthetic — produced client-side from `/api/shells`
     *  so we can render Terminal sessions in the same worktree picker
     *  alongside Claude/Codex/Copilot. "ollama" is also synthetic —
     *  live PTYs only, no on-disk JSONL scan. The daemon only ever
     *  returns "claude" / "codex" / "copilot" here. */
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
  interface ShellRecord {
    termId: string;
    wt: string;
    spawnCwd: string;
    currentCwd?: string;
    createdAt: string;
    alive: boolean;
    /** Number of Enter-terminated command lines captured for this shell.
     *  Drives the "hide empty saved shells" filter in the picker. */
    cmdCount?: number;
    /** Most recent Enter-terminated command line captured for this
     *  shell, surfaced as a muted inline snippet on the picker row. */
    lastCmd?: string;
    /** Timestamp of `lastCmd` (ISO string). Used as the row's
     *  `lastActive` so shells age by their most recent use, not by
     *  spawn time. */
    lastCmdTs?: string;
    /** User-set title keyed by `shell:<termId>` in the workspace's
     *  session-title store; takes precedence over the inline last-cmd. */
    manualTitle?: string;
  }
  interface ActivityEvent {
    agent: "claude" | "codex" | "copilot";
    cwd: string;
    sessionId: string;
    summary: string;
    timestamp: string;
    source: string;
  }
  interface Worktree {
    path: string;
    branch: string;
    head: string;
    bare: boolean;
    detached: boolean;
    fileStatus: FileStatus;
    branchStatus: BranchStatus | null;
    lastCommit: LastCommit | null;
    agents?: AgentSession[];
    nonGit?: boolean;
  }
  interface RemoteRef {
    name: string;
    url: string;
    webUrl: string | null;
    provider: string | null;
    host: string | null;
  }
  /** A user-defined "open in" link. URL links open in a new browser
   *  tab; file / folder links go through `/api/open-default` which
   *  hands the path to the platform's default app (Finder, Explorer,
   *  xdg-open). */
  type CommandRunMode = "internal" | "external" | "shell";
  type CustomLink =
    | { id: string; kind?: "url"; url: string; name?: string }
    | { id: string; kind: "file"; path: string; name?: string }
    | { id: string; kind: "folder"; path: string; name?: string }
    | {
        id: string;
        kind: "command";
        cmd: string;
        cwd?: string;
        runMode: CommandRunMode;
        name?: string;
      };
  interface Repo {
    id: string;
    path: string;
    name: string;
    addedAt: string;
    /** Owning remote daemon (undefined ⇒ local). Set during repo-list
     *  fan-out when the repo came from a remote daemon's
     *  `/api/daemons/<id>/repos`; threaded into row-scoped calls via
     *  `apiUrl(path, daemonId)` so they hit the right daemon. */
    daemonId?: string;
    /** Optional accent colour (#rrggbb) — applied wherever the repo
     *  name renders so the user can tell repos apart at a glance. */
    color?: string;
    worktrees: Worktree[];
    /** True only while this is a manifest skeleton whose git fan-out
     *  hasn't streamed in yet. Drives the row's loading spinner (vs. a
     *  misleading "no worktrees" — both have worktrees: []). Cleared
     *  when the enriched `repo` line upserts over the skeleton. */
    pending?: boolean;
    /** Git remotes for this repo (empty for non-git folders). */
    remotes?: RemoteRef[];
    /** User-defined "open in <X>" links (Coolify dashboards, staging
     *  URLs, anything web). Render as extra chips alongside the
     *  editor / Fork / remote buttons in the worktree row's action
     *  strip. */
    customLinks?: CustomLink[];
  }
  type AddRepoResponse = Repo & { alreadyRegistered?: boolean };
  interface EditorDescriptor {
    name: string;
    cmd: string;
  }

  let repos: Repo[] = [];
  /** User-defined cross-daemon row order, as a list of `daemonRepoKey`s,
   *  persisted in LOCAL daemon prefs (it's a "how I arrange MY window"
   *  concern, not state of any one daemon). Empty until the user reorders;
   *  applied on top of the fan-out so local + remote rows can interleave
   *  (replaceDaemonRepos otherwise keeps each daemon's rows in one block).
   *  See reorderRepos + the load() merge. */
  const REPO_ORDER_KEY = "supergit:repoOrder";
  let savedRepoOrder: string[] = readSavedRepoOrder();
  function readSavedRepoOrder(): string[] {
    try {
      const raw = getDaemonKV().getItem(REPO_ORDER_KEY);
      const arr = raw ? JSON.parse(raw) : [];
      return Array.isArray(arr) ? (arr as string[]) : [];
    } catch {
      return [];
    }
  }
  // daemonId -> reachable? Rebuilt each load() from the fan-out: a remote
  // whose /api/daemons/<id>/repos fetch rejects (tunnel down) is offline.
  // Drives the online/offline dot in ProcessList. Reassigned (new Map) each
  // load so Svelte reactivity fires.
  let daemonsOnline = new Map<string, boolean>();
  /** Registered remote daemons (the GET /api/daemons registry), kept
   *  reactive so the menubar's "Remote daemons" list reflects adds/removes
   *  immediately. Populated each load(). */
  let remoteDaemons: Array<{
    id: string;
    label: string;
    host: string;
    port: number;
    color?: string;
    /** The SSH/run-as user the box reports (root vs the sandboxed service
     *  user) — surfaced so it's clear when a daemon runs as root. */
    user?: string;
  }> = [];
  /** Label for a repo's owning remote daemon, or "" for a local repo —
   *  used to prefix a remote row's worktree path so it's clear the path
   *  lives on another box (e.g. "needle-playground · /home/supergit/app"). */
  function daemonLabelForRepo(daemonId: string | undefined): string {
    if (!daemonId) return "";
    return remoteDaemons.find((d) => d.id === daemonId)?.label ?? daemonId;
  }
  let events: Event[] = [];
  let editors: EditorDescriptor[] = [];
  let runningCommandIds: Set<string> = new Set();
  let commandUrls: Record<string, string[]> = {};
  let commandEditRequest: {
    repoId: string;
    linkId: string;
    nonce: number;
  } | null = null;
  /** Shells (Terminal columns the daemon is hosting / has hosted). Used
   *  by the worktree session picker so past + live shells appear next
   *  to Claude/Codex agent sessions instead of hiding under a separate
   *  affordance. Refreshed alongside /api/repos in `load()`. */
  let allShells: ShellRecord[] = [];
  let loading = false;
  let loadingSlow = false;
  let loadingSlowTimer: ReturnType<typeof setTimeout> | null = null;
  let loadingTotal = 0;
  let loadingDone = 0;
  // Legacy single-string error slot — kept for code paths that still set
  // it directly. New code should call `addToast({ kind: "error", ... })`
  // instead. Anything assigned to `error` is mirrored into the toast
  // stack via a reactive watcher below.
  let error = "";

  /** Toast stack. Errors and notices both render as floating cards in
   *  the bottom-right; each auto-dismisses on its own timer and can be
   *  closed manually. Designed to coexist with the stash banner that
   *  was wired earlier (which now uses this same machinery). */
  let toasts: Toast[] = [];
  const { addToast, dismissToast } = createToastManager({
    onChange: (t) => (toasts = t),
    // play() from sound.ts accepts a narrow SoundTag literal union; the manager
    // dep is typed as (sound: string) => void so the wrapper bridges the gap.
    play: (s) => play(s as Parameters<typeof play>[0]),
  });
  /** Svelte action: focus the element as soon as it mounts. Used so an
   *  expanding search input grabs the caret without a follow-up click. */
  function focusOnMount(node: HTMLInputElement) {
    queueMicrotask(() => node.focus());
  }
  // Mirror any direct `error = "…"` assignment into the toast stack so
  // we don't have to chase every call site at once. Cleared as soon as
  // it's surfaced.
  $: if (error) {
    addToast({ kind: "error", message: error });
    error = "";
  }
  let streamConnected = false;

  /** Source of the session the user most recently focused via the
   *  side dock (or a direct session-column click). Drives the small
   *  triangle marker in SessionDock — purely a visual indicator of
   *  "the column you just navigated to is this one". Resets to null
   *  when that session is closed, and stays in memory only (a reload
   *  starts unfocused). */
  let focusedSource: string | null = null;
  let composerFocusSeqBySource: Record<string, number> = {};

  function requestComposerFocus(source: string): void {
    composerFocusSeqBySource = {
      ...composerFocusSeqBySource,
      [source]: (composerFocusSeqBySource[source] ?? 0) + 1,
    };
  }

  function focusOpenSessionColumn(source: string): void {
    const wasFocused = focusedSource === source;
    focusedSource = source;
    if (!wasFocused) {
      requestAnimationFrame(() => {
        const col = document.querySelector<HTMLElement>(
          `.session-col[data-session-source="${CSS.escape(source)}"]`,
        );
        if (col) stickSessionColumnToTail(col);
      });
    }
  }

  // The unique row key (repoId + worktree path) whose repo-edit popover
  // (name + color + reorder) is currently open. Keyed by row rather than
  // repo id because repos with multiple worktrees produce multiple rows
  // for the same repo — a repo-id match would open two popovers at once
  // and the bind:value + focus() race would break typing.
  let editingRowKey: string | null = null;
  let editingRepoId: string | null = null;
  let editRepoName = "";
  // Whether the drag-to-reorder-repos dialog is open (reached from the
  // repo-edit popover). Global — reorders the whole repo list.
  let reorderDialogOpen = false;
  let addDaemonOpen = false;
  // Settings dialog (menubar gear). Settings are contributed via
  // registerSettings() — see settings-registry.ts; the dialog renders
  // whatever any subsystem registers, no per-setting UI needed.
  let settingsDialogOpen = false;
  // The settings catalog. Each subsystem's tunables are declared here
  // once; SettingsDialog renders them — no per-setting UI. Reads are
  // reactive via settingValue(); see settings-registry.ts.
  registerSettings({
    id: "appearance",
    title: "Appearance",
    order: 0,
    settings: [
      {
        key: "appearance.showGreeting",
        label: "Show build greeting",
        description:
          "The “Welcome to the jungle” version line above the menubar.",
        type: "boolean",
        default: true,
      },
      {
        key: "appearance.showVines",
        label: "Show vines",
        description:
          "Decorative vines that grow between session windows, sized by how long the sessions have been open.",
        type: "boolean",
        default: true,
      },
    ],
  });
  registerSettings({
    id: "terminal",
    title: "Terminal",
    order: 10,
    settings: [
      {
        // Enum (named sizes) rather than a raw number — values are the
        // pixel sizes as strings. "Normal" is 12px, the size terminals
        // already render at, and is the default so nothing resizes on
        // upgrade.
        key: "terminal.fontSize",
        label: "Font size",
        description: "Text size in terminal sessions.",
        type: "enum",
        default: "12",
        options: [
          { value: "10", label: "Tiny" },
          { value: "11", label: "Small" },
          { value: "12", label: "Normal" },
          { value: "14", label: "Large" },
        ],
      },
      {
        key: "terminal.showIoDebug",
        label: "Show I/O debug",
        description:
          "Show tiny per-terminal input and output throughput counters.",
        type: "boolean",
        default: false,
      },
      {
        key: "terminal.imagePasteBehavior",
        label: "Image paste",
        description:
          "Auto picks per agent: Codex reads image bytes from the OS clipboard (Direct), Claude and the rest get the saved file path (Attachment). Attachment always resizes, saves, and pastes the path. Direct forwards a native paste keystroke — only apps that read clipboard image bytes (Codex) handle it; Claude's TUI ignores it.",
        type: "enum",
        default: "auto",
        options: [
          { value: "auto", label: "Auto (per agent)" },
          { value: "direct", label: "Direct" },
          { value: "attachment", label: "Attachment path" },
        ],
      },
    ],
  });
  registerSettings({
    id: "sound",
    title: "Sound",
    order: 20,
    settings: [
      {
        key: "sound.enabled",
        label: "Sound effects",
        description: "Play chimes for sessions, messages, pushes, and alerts.",
        type: "boolean",
        default: true,
      },
      {
        key: "sound.volume",
        label: "Volume",
        description: "Master volume for all sound effects.",
        type: "slider",
        default: 100,
        min: 0,
        max: 100,
        step: 5,
        unit: "%",
      },
    ],
  });
  registerSettings({
    id: "maintenance",
    title: "Maintenance",
    order: 100,
    settings: [
      {
        key: "maintenance.resetWalkthrough",
        label: "Onboarding walkthrough",
        description: "Replay the guided tour on every worktree.",
        type: "action",
        buttonLabel: "Reset walkthrough",
        onInvoke: () => {
          clearAllWalkthroughSeen();
          addToast({ kind: "success", message: "Walkthrough reset." });
        },
      },
    ],
  });
  const showGreeting = settingValue("appearance.showGreeting");
  const showTerminalIoDebug = settingValue("terminal.showIoDebug");

  // Vines overlay (decorative; self-contained in ./vines). The "Show
  // vines" setting is the single source of truth — mount/unmount react to
  // it. Lazy import so it's zero-cost when off. Demo URL params
  // (?vinesgrow/?vinesspeed/?vinesdebug) are read inside the module.
  const showVines = settingValue("appearance.showVines");
  let vinesModule: typeof import("./vines") | null = null;
  $: void applyVines($showVines !== false);
  async function applyVines(on: boolean) {
    if (on) {
      vinesModule = vinesModule ?? (await import("./vines"));
      vinesModule.initVines();
    } else {
      vinesModule?.destroyVines();
    }
  }

  // Bridge the sound settings into the sound engine's module state.
  // Reactive so changes in the dialog take effect immediately; runs
  // once on mount with the persisted values.
  const soundEnabled = settingValue("sound.enabled");
  const soundVolume = settingValue("sound.volume");
  $: setEnabled($soundEnabled !== false);
  $: setMasterVolume(typeof $soundVolume === "number" ? $soundVolume / 100 : 1);
  /** When set, the Add-daemon dialog opens in attach mode (live-log only) for
   *  an already-started job — currently used for "Uninstall on box". */
  let provisionAttachJob: { jobId: string; title: string } | null = null;
  // "Add a folder on a remote daemon" dialog (#3) + the daemon it opened
  // against (preselected target).
  let addRemoteFolderOpen = false;
  let addRemoteFolderDaemonId = "";
  // The repo whose popover opened the reorder dialog — highlighted in
  // the list so the user can find where they started.
  let reorderHighlightRepoId: string | null = null;

  let actionsOpen = false;
  let eventsOpen = false;
  let daemonsMenuOpen = false;
  let projectsMenuOpen = false;
  /** Hover-intent close timer for the Projects dropdown. A short delay
   *  bridges the 0.4rem gap between the button and the popover so moving
   *  the cursor from one to the other doesn't dismiss it. */
  let projectsCloseTimer: ReturnType<typeof setTimeout> | null = null;
  function openProjectsMenu() {
    if (projectsCloseTimer) {
      clearTimeout(projectsCloseTimer);
      projectsCloseTimer = null;
    }
    projectsMenuOpen = true;
  }
  function scheduleCloseProjectsMenu() {
    if (projectsCloseTimer) clearTimeout(projectsCloseTimer);
    projectsCloseTimer = setTimeout(() => {
      projectsMenuOpen = false;
      projectsCloseTimer = null;
    }, 140);
  }
  /** Which daemon's "manage" dialog is open (its id), or null. */
  let daemonDialogId: string | null = null;
  /** True while a "Redeploy prod" build is in flight (disables the button). */
  let redeploying = false;

  /** Rebuild the prod SPA (packages/ui/dist) from the current source. Prod
   *  serves that dir fresh from disk, so a rebuild is a full UI redeploy —
   *  no daemon restart, no killed PTYs. The user reloads their prod tab to
   *  see it. Ships UI changes only, not daemon-code changes. */
  async function redeployProd(): Promise<void> {
    if (redeploying) return;
    redeploying = true;
    addToast({ kind: "info", message: "Rebuilding prod SPA…" });
    try {
      const res = await fetch("/api/deploy", { method: "POST" });
      const body = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        code?: number | null;
        output?: string;
        durationMs?: number;
      };
      if (res.ok && body.ok) {
        const secs = ((body.durationMs ?? 0) / 1000).toFixed(1);
        addToast({
          kind: "success",
          message: `Prod rebuilt in ${secs}s — reload your prod tab to see it.`,
        });
      } else {
        const tail = (body.output ?? "").split("\n").slice(-2).join(" ").trim();
        addToast({
          kind: "error",
          message: `Redeploy failed (exit ${body.code ?? "?"}). ${tail || res.statusText}`,
        });
      }
    } catch (e) {
      addToast({
        kind: "error",
        message: `Redeploy failed: ${e instanceof Error ? e.message : String(e)}`,
      });
    } finally {
      redeploying = false;
    }
  }
  /** Daemon ids with an in-flight DELETE — drives the per-row spinner +
   *  disables the remove button so a double-click can't double-delete. */
  let daemonRemoving = new Set<string>();
  let peerDiscoveryEnabled = false;
  let peerToggleBusy = false;
  async function togglePeerDiscovery() {
    if (peerToggleBusy) return;
    peerToggleBusy = true;
    try {
      const res = await fetch(apiUrl("/api/peer-discovery"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: !peerDiscoveryEnabled }),
      });
      if (res.ok) {
        const data = await res.json();
        peerDiscoveryEnabled = data.enabled === true;
      }
    } catch {}
    peerToggleBusy = false;
  }
  /** Orphan-notes tray: header button + popover listing notes whose
   *  anchor doesn't match any currently-registered repo or worktree.
   *  Only renders the button when there's at least one orphan. */
  let notesTrayOpen = false;
  let orphanReanchorFor: string | null = null;
  /** Per-row "notes hidden" toggle state. When true, all notes
   *  anchored to that row vanish via `.row-notes-hidden` (CSS
   *  display: none) — the StickyNote components stay mounted so
   *  their local edit state survives a hide/show round-trip. Keyed
   *  by the row's stable key (worktree path or "<repoId>|none"). */
  let notesHiddenByRow: Record<string, boolean> = {};
  {
    try {
      const raw = getDaemonKV().getItem("supergit:notesHidden");
      if (raw) notesHiddenByRow = JSON.parse(raw) ?? {};
    } catch {
      notesHiddenByRow = {};
    }
  }
  $: {
    try {
      getDaemonKV().setItem(
        "supergit:notesHidden",
        JSON.stringify(notesHiddenByRow),
      );
    } catch {}
  }
  function toggleNotesHidden(key: string): void {
    notesHiddenByRow = { ...notesHiddenByRow, [key]: !notesHiddenByRow[key] };
  }
  /** Per-row "notes list" popover. Keyed by the same row.key the rest
   *  of the row state uses. Opens off the small count badge sitting to
   *  the left of the `notes` toggle and lists everything pinned to
   *  this anchor plus recently-deleted notes (from events.jsonl) so
   *  the user can undo a delete without hunting the global Undo
   *  tray. */
  let notesListOpen: Record<string, boolean> = {};
  /** Per-row "zen" focus — one worktree row takes over the viewport,
   *  hiding the top bar and all other rows. `null` = no row focused.
   *  Toggled from the row-head; Esc exits. Purely cosmetic, no state
   *  persisted to workspace. */
  let zenRowKey: string | null = null;
  /** Zen-mode override for notes visibility. Notes hide by default in
   *  zen (the whole point of zen is a clean focus surface) regardless
   *  of `notesHiddenByRow`; this flag lets the user explicitly show
   *  them again via the row's `notes` toggle while in zen. Resets to
   *  `false` on every zen entry/exit so the next zen session starts
   *  clean. */
  let notesShownInZen = false;
  /** Zen menu-pill reveal. In zen the top menubar pill is retracted
   *  above the viewport; this flag slides it back in. It's armed by a
   *  non-blocking pointermove listener (no overlay → nothing near the
   *  top edge is click-blocked) when the cursor reaches the top edge,
   *  and disarms ~2s after the cursor last touched that edge. CSS
   *  :hover/:focus-within keep it open while you actually interact, so
   *  the timer expiring mid-use can't snap it shut. */
  let zenMenuArmed = false;
  let zenMenuDisarmTimer: ReturnType<typeof setTimeout> | null = null;
  /** Cursor must be within this many px of the top to reveal the pill. */
  const ZEN_MENU_REVEAL_PX = 6;
  /** Linger after the cursor last touched the top edge before retracting. */
  const ZEN_MENU_LINGER_MS = 2000;
  function armZenMenu() {
    zenMenuArmed = true;
    if (zenMenuDisarmTimer) clearTimeout(zenMenuDisarmTimer);
    zenMenuDisarmTimer = setTimeout(() => {
      zenMenuArmed = false;
      zenMenuDisarmTimer = null;
    }, ZEN_MENU_LINGER_MS);
  }
  function resetZenMenu() {
    zenMenuArmed = false;
    if (zenMenuDisarmTimer) {
      clearTimeout(zenMenuDisarmTimer);
      zenMenuDisarmTimer = null;
    }
  }
  function toggleZenRow(key: string) {
    const exiting = zenRowKey === key;
    zenRowKey = exiting ? null : key;
    notesShownInZen = false;
    resetZenMenu();
    if (!exiting) {
      // Entering zen on this row → it's the active worktree; give its dirty
      // state the priority refresh poll.
      const wtPath = key.split("|").slice(1).join("|");
      if (wtPath) activeWorktreePath = wtPath;
    }
    if (exiting) {
      const wtPath = key.split("|").slice(1).join("|");
      if (wtPath) tick().then(() => jumpToWorktreeRow(wtPath));
    }
  }
  // toggleFullscreen() lives in NewSessionCol.svelte now (it's only
  // called from inside the new-session-column header).
  /** Recent diagnostics: daemon 5xx, frontend fetch failures, browser
   *  uncaught/unhandledrejection. Populated reactively via the
   *  errors store (which is the source of truth — this is just a
   *  Svelte-reactive mirror). */
  let errorEntries: FrontendErrorEntry[] = [];
  async function clearAllErrors() {
    await clearErrors();
  }

  let systemMemBytes: number | null = null;
  let processListRef: ProcessList;
  /** Force the folded-row StatusBadge area to render BOTH the push
   *  (↑) and pull (↓) variants at every folded row, so you can
   *  preview both border-ring animations side-by-side without
   *  needing the worktree to actually be ahead or behind. Set
   *  `?badgeanim=1` in the URL. */
  const badgeAnimDebug =
    typeof location !== "undefined" &&
    new URLSearchParams(location.search).get("badgeanim") === "1";
  /** Apply the `.pulsate` modifier to every push StatusBadge so the
   *  stale-unpushed opacity oscillation can be eyeballed without
   *  wiring it up to the real staleness threshold yet. Pairs with
   *  `?badgeanim=1` (so both ↑ and ↓ render); the pulsate effect
   *  only shows on the ↑ badge by design. */
  const pulsateDebug =
    typeof location !== "undefined" &&
    new URLSearchParams(location.search).get("pulsate") === "1";
  /** Force-render the "no repos registered yet" empty state even when
   *  repos are loaded — for previewing the onboarding CTA. Set
   *  `?emptyrepos=1` in the URL. */
  const emptyReposDebug =
    typeof location !== "undefined" &&
    new URLSearchParams(location.search).get("emptyrepos") === "1";
  // Per worktree: is the "all sessions" popover next to the agent badge open?
  let agentsPopoverOpen: Record<string, boolean> = {};
  /** Per worktree: is the badge's "active TUIs" popover open? Distinct
   *  from `agentsPopoverOpen` (the count-chip picker over every known
   *  session) — this one lists only sessions currently mounted as
   *  columns, used as a fast jumper when several TUIs are live. */
  let activeTuisPopoverOpen: Record<string, boolean> = {};
  // Per worktree: inline session-strip search. `open` controls whether
  // the search input is expanded next to the count badge; `query` is
  // the current text. Closed + empty query = strip renders unfiltered.
  let stripSearchOpen: Record<string, boolean> = {};
  let stripSearchQuery: Record<string, string> = {};
  // Per row.key: did opening the strip search auto-unfold this row?
  // We re-fold on close *only* if no session was picked while open;
  // picking clears the flag so the row stays expanded around the now-
  // visible session column.
  let stripSearchAutoUnfolded: Record<string, boolean> = {};
  // Per wt.path: the last query the user *committed* (by clicking a
  // matched column in the strip). Re-opening the search restores this
  // text so the user can re-find what they were looking at; an
  // explicit cancel (× / ESC) drops it.
  let lastStripSearchQuery: Record<string, string> = {};

  // The four strip-search actions live in strip-search-manager.ts; the
  // reactive `let`s above stay here so Svelte tracks them. The get/set
  // bridges below let the extracted closures read/reassign those lets
  // (every reassign triggers reactivity, same as the inline versions),
  // and getStripFilterByWt feeds commit the current derived value.
  const {
    openStripSearch,
    closeStripSearch,
    commitStripSearch,
    pinRowOpenAfterPick,
  } = createStripSearchManager({
    getStripSearchOpen: () => stripSearchOpen,
    setStripSearchOpen: (v) => (stripSearchOpen = v),
    getStripSearchQuery: () => stripSearchQuery,
    setStripSearchQuery: (v) => (stripSearchQuery = v),
    getStripSearchAutoUnfolded: () => stripSearchAutoUnfolded,
    setStripSearchAutoUnfolded: (v) => (stripSearchAutoUnfolded = v),
    getLastStripSearchQuery: () => lastStripSearchQuery,
    setLastStripSearchQuery: (v) => (lastStripSearchQuery = v),
    getRowFolded: () => rowFolded,
    setRowFolded: (v) => (rowFolded = v),
    getStripFilterByWt: () => stripFilterByWt,
    scrollToAndFlashSession,
  });

  // clampToViewport (the popover-viewport-edge Svelte action) lives in
  // packages/ui/src/popover.ts now; Popover.svelte applies it
  // automatically unless the caller passes `unclamped`.

  // Per repo id: is the "new worktree" inline form open? (legacy — kept
  // for the createWorktree() flow which still reads/writes
  // newWtBranch[repo.id]; the inline-form rendering has been replaced
  // by the worktree-picker popover.)
  let newWtOpen: Record<string, boolean> = {};
  // Per wt.path (or repo.id when no worktrees exist yet): is the
  // unified worktree picker open? The picker lets you jump to a
  // worktree row, remove one, or create a new one.
  let wtPickerOpen: Record<string, boolean> = {};
  // Per-row: is the emoji sticker picker open?
  let emojiPickerOpen: Record<string, boolean> = {};
  // One pickable interactive shell on a box (from /api/shells/available).
  interface ShellOption {
    shell: string;
    args: string[];
    label: string;
  }
  // Agent CLIs we detected on PATH at the daemon. Loaded once on mount.
  let installedAgents: { name: string; path: string }[] = [];
  // Per-daemon caches for the "Start a new session" dropdown, keyed by
  // daemonId; "local" = the local daemon. A remote row must list the
  // remote box's agents/shells (it runs sessions there), not ours.
  let agentsByDaemon: Record<string, { name: string; path: string }[]> = {};
  let shellByDaemon: Record<string, string> = {};
  // Shell login args per daemon (e.g. ["-l"] / ["/k"]) — paired with
  // shellByDaemon so a remote terminal spawns the REMOTE box's shell with
  // ITS flags, not the local machine's.
  let shellArgsByDaemon: Record<string, string[]> = {};
  // Every interactive shell the box can spawn, per daemon (from
  // /api/shells/available). On Windows that's PowerShell + CMD as two
  // entries so the picker can offer each; on POSIX a single login shell.
  // When a daemon lists >1 the picker fans out one Terminal entry per shell.
  let shellsByDaemon: Record<string, ShellOption[]> = {};
  // Per-worktree: is the "+ new agent" popover open?
  let newAgentPopoverOpen: Record<string, boolean> = {};
  // Per-worktree: is the Ollama models submenu inside the picker expanded?
  // Reset when the picker closes so the next open starts collapsed.
  let ollamaSubmenuOpen: Record<string, boolean> = {};
  // Cached list of installed Ollama models for the picker submenu.
  // Lazy-loaded the first time the user expands the Ollama row.
  let ollamaModels: { name: string; size?: number; parameterSize?: string }[] =
    [];
  let ollamaModelsLoaded = false;
  let ollamaModelsLoading = false;
  let ollamaModelsError: string | null = null;

  async function ensureOllamaModelsLoaded(force = false) {
    if (ollamaModelsLoading) return;
    if (ollamaModelsLoaded && !force) return;
    ollamaModelsLoading = true;
    ollamaModelsError = null;
    const r = await fetchOllamaModels(fetch, apiUrl("/api/ollama/models"));
    if (r.ok) {
      ollamaModels = r.models;
      ollamaModelsLoaded = true;
    } else {
      ollamaModelsError = r.error;
      ollamaModels = [];
      // Daemon answered (non-OK) → don't retry; a thrown request leaves
      // `loaded` false so the next open retries. Mirrors the original.
      if (r.reached) ollamaModelsLoaded = true;
    }
    ollamaModelsLoading = false;
  }

  // Per transient session source: is the agent paused on a prompt
  // waiting for user input? Surfaced as an outlined column + a small
  // "needs input" pill in the header. Cleared when the agent emits
  // any output that no longer matches the prompt pattern, or when
  // the user types something.
  let transientAwaiting: Record<string, boolean> = {};
  /** Mirror of `transientAwaiting` for the live "working" flag. Driven
   *  by NewSessionCol's on:workingChange (which TerminalView raises on
   *  PTY frames). Drives the rotating-gradient border on the agent pill. */
  let transientWorking: Record<string, boolean> = {};
  let liveTerminalIds: ReadonlySet<string> = new Set();
  function markTerminalLive(id: string): void {
    liveTerminalIds = new Set([...liveTerminalIds, id]);
  }
  function markTerminalExited(id: string | undefined): void {
    if (!id || !liveTerminalIds.has(id)) return;
    const next = new Set(liveTerminalIds);
    next.delete(id);
    liveTerminalIds = next;
  }
  /** Sources being promoted from `__new__:*` to a real JSONL path.
   *  Checked by `closeColumn` to skip the outro — the column isn't
   *  closing, it's upgrading to SessionView. */
  const promotedSources = new Set<string>();
  /** Sources whose ManualTitle is currently being edited. Promotions
   *  are deferred while the user is mid-edit so the input isn't ripped
   *  away. Queued promotions fire when editing stops. */
  const editingTitleSources = new Set<string>();
  type DeferredPromotion = {
    stampedSource: string;
    realSource: string;
    cwd: string;
  };
  let deferredPromotions: DeferredPromotion[] = [];

  function executePromotion(
    stampedSource: string,
    realSource: string,
    cwd: string,
  ) {
    promotedSources.add(stampedSource);
    const termId = newTermIds[stampedSource];
    openSessionsByWt = {
      ...openSessionsByWt,
      [cwd]: (openSessionsByWt[cwd] ?? []).map((x) =>
        x.source === stampedSource
          ? {
              ...x,
              source: realSource,
              mode: "terminal" as const,
              attachTermId: termId,
            }
          : x,
      ),
    };
    transientWorking = moveSessionStateKey(
      transientWorking,
      stampedSource,
      realSource,
    );
    transientAwaiting = moveSessionStateKey(
      transientAwaiting,
      stampedSource,
      realSource,
    );
    transientExited = moveSessionStateKey(
      transientExited,
      stampedSource,
      realSource,
    );
    transientFinishedAt = moveSessionStateKey(
      transientFinishedAt,
      stampedSource,
      realSource,
    );
    workingStartedAt = moveSessionStateKey(
      workingStartedAt,
      stampedSource,
      realSource,
    );
    void migrateSessionTitleOnServer(stampedSource, realSource);
  }

  function flushDeferredPromotions(source: string) {
    const pending = deferredPromotions.filter(
      (p) => p.stampedSource === source,
    );
    deferredPromotions = deferredPromotions.filter(
      (p) => p.stampedSource !== source,
    );
    for (const p of pending) {
      executePromotion(p.stampedSource, p.realSource, p.cwd);
    }
  }
  /** ms timestamp of when each source last entered the "working" state.
   *  Used to filter out brief PTY output bursts (status-bar redraws,
   *  resize-triggered re-renders) that don't represent real agent work
   *  — only working periods longer than MIN_WORKING_FOR_PULSE_MS arm
   *  the "unread" pulse in the dock. */
  let workingStartedAt: Record<string, number | undefined> = {};
  /** Sources whose PTY has exited (TerminalView.onExit fired). The
   *  column stays in the page in read mode; the side dock uses this
   *  to render the row's dot smaller so the user can see at a
   *  glance which TUIs are still live vs which have wound down. */
  let transientExited: Record<string, boolean> = {};
  /** ms timestamp of the working→idle transition for each TUI.
   *  Drives the dock's "unread" pulse on the row's dot — a quiet
   *  reminder that the AI just finished and you haven't looked
   *  at it yet. Cleared when the user re-focuses the session
   *  (handlePick / revealSession) or when the PTY exits; the
   *  dock also auto-clears the pulse after 20 min so a long-
   *  ignored finish doesn't keep nagging. */
  let transientFinishedAt: Record<string, number | undefined> = {};
  function isSessionFocused(source: string): boolean {
    if (typeof document === "undefined") return false;
    const col = document.querySelector(
      `.session-col[data-session-source="${CSS.escape(source)}"]`,
    );
    if (!col) return false;
    return col.contains(document.activeElement);
  }
  const {
    scheduleFinished,
    cancelFinishedTimer,
    clearFinishedFor,
    startReadGrace,
    cancelReadGrace,
  } = createUnreadPulseManager({
    getFinishedAt: () => transientFinishedAt,
    setFinishedAt: (v) => (transientFinishedAt = v),
    isSessionFocused,
  });
  function handleFocusInForUnread(ev: FocusEvent): void {
    const t = ev.target as Element | null;
    if (!t) return;
    const col = t.closest?.(
      ".session-col[data-session-source]",
    ) as HTMLElement | null;
    if (!col) return;
    const src = col.getAttribute("data-session-source");
    if (!src) return;
    startReadGrace(src);
    // Remember which worktree the user is actively in so its git/dirty state
    // gets the priority refresh poll (see startActiveWorktreePoll) — otherwise
    // a busy background repo can starve its dirty badge for tens of seconds.
    const wt = col.closest("[data-wt-row]")?.getAttribute("data-wt-row");
    if (wt) activeWorktreePath = wt;
  }
  /** Worktree the user is currently interacting with (focused column, or the
   *  zen row). Polled every few seconds via /api/worktree-details so its dirty
   *  state stays live independent of the shared enrich queue. */
  let activeWorktreePath: string | null = null;
  function handleFocusOutForUnread(ev: FocusEvent): void {
    const t = ev.target as Element | null;
    if (!t) return;
    const col = t.closest?.(
      ".session-col[data-session-source]",
    ) as HTMLElement | null;
    if (!col) return;
    const src = col.getAttribute("data-session-source");
    if (!src) return;
    // Only cancel if focus actually left this column (not just
    // moved between children inside it).
    const next = ev.relatedTarget as Element | null;
    if (next && col.contains(next)) return;
    cancelReadGrace(src);
  }
  /** `__new__:<agent>:<id>` source → daemon-assigned termId. Set by
   *  NewSessionCol's `on:spawn` for every agent (shell, claude, codex,
   *  copilot). Used by the Dispose button to DELETE /api/terminals/:id.
   *  Shell columns additionally flip to `__transcript__:` so ShellView
   *  takes over; claude/codex/copilot just kill the PTY and leave the
   *  column showing final output until the user clicks ×. */
  let newTermIds: Record<string, string> = {};
  /** Per-terminal SSH cwd, updated by prompt parsing in TerminalView. */
  let sshCwdByTermId: Record<string, string> = {};

  /** Unified Dispose handler for live new-session columns.
   *
   *  Shell flips to a `__transcript__:shell:` source so ShellView takes
   *  over (command history + Resume).
   *
   *  Claude / Codex / Copilot flip to the canonical activity source
   *  (the on-disk JSONL path) when the activity tail has already
   *  surfaced this session's sid — so the column transitions to the
   *  read-only chat view (SessionView initialMode="read"). When the
   *  sid hasn't been surfaced yet (very early dispose, JSONL not on
   *  disk), we leave the column as-is so the user can still read the
   *  final TUI output until they × the column. */
  async function disposeNewSessionColumn(
    wtPath: string,
    s: OpenSession,
    agents: AgentSession[],
  ): Promise<void> {
    const termId = resolveTermId(s, newTermIds);
    if (!termId) {
      // PTY hasn't been spawned yet (no daemon termId to DELETE). Fall
      // back to plain close — the grace timer disposes the half-spawned
      // PTY soon enough.
      closeSessionInWt(wtPath, s);
      return;
    }
    try {
      play("session-stop");
      await fetch(
        apiUrl(
          `/api/terminals/${encodeURIComponent(termId)}`,
          daemonIdForWorktreePath(repos, wtPath),
        ),
        {
          method: "DELETE",
        },
      ).catch(() => {});
    } finally {
      // Drop the now-stale termId mapping.
      const next = { ...newTermIds };
      delete next[s.source];
      newTermIds = next;
      clearTransientDiscovery(s.source);
      if (s.agent === "shell") {
        // Command PTYs (spawned via custom-link commands) have no
        // shell header on disk — skip the transcript flip and just
        // close the column.
        let isCommandPty = false;
        for (const [, entry] of commandTermSources) {
          if (entry.source === s.source) {
            isCommandPty = true;
            break;
          }
        }
        if (isCommandPty) {
          closeSessionInWt(wtPath, s);
          return;
        }
        // Shell: replace the source in place so the column survives
        // and flips to ShellView (command history + Resume).
        const transcriptSource = `__transcript__:shell:${termId}`;
        promotedSources.add(s.source);
        openSessionsByWt = {
          ...openSessionsByWt,
          [wtPath]: (openSessionsByWt[wtPath] ?? []).map((x) =>
            x.source === s.source
              ? { agent: "shell", source: transcriptSource }
              : x,
          ),
        };
        void migrateSessionTitleOnServer(s.source, transcriptSource);
        dismissShellSource(`__attached__:shell:${termId}`);
      } else {
        // Claude / Codex / Copilot: flip to the read-only chat view by
        // adopting the source the activity-tail entry uses (the JSONL
        // path). The `:else` render branch then picks SessionView with
        // initialMode="read". Requires that resumeSessionId has been
        // stamped (the activity SSE has surfaced this sid) — without
        // it we have no way to map `__new__:claude:<random>` to a real
        // session on disk, so keep the dead xterm visible as before.
        const sid = s.resumeSessionId;
        const match = sid
          ? agents.find((a) => a.agent === s.agent && a.sessionId === sid)
          : undefined;
        if (match) {
          promotedSources.add(s.source);
          openSessionsByWt = {
            ...openSessionsByWt,
            [wtPath]: (openSessionsByWt[wtPath] ?? []).map((x) =>
              x.source === s.source
                ? {
                    agent: s.agent as OpenSession["agent"],
                    source: match.source,
                  }
                : x,
            ),
          };
          // Move the user's manual title from the synthetic source to
          // the real JSONL path so SessionView's header (which reads
          // titles[realPath] via /api/repos) keeps showing it.
          void migrateSessionTitleOnServer(s.source, match.source);
        }
      }
    }
  }

  // Per-worktree branch picker state (the dropdown that opens when the
  // user clicks the branch chip).
  interface BranchListing {
    current: string | null;
    local: string[];
    remote: string[];
  }
  let branchPickerOpen: Record<string, boolean> = {};
  let branchesByWt: Record<string, BranchListing> = {};
  let branchesLoading: Record<string, boolean> = {};
  let branchSortMode: "recency" | "alpha" = "recency";
  const SELECTED_REMOTE_KEY = "supergit:selectedRemoteByRepo";
  let selectedRemoteByRepo: Record<string, string> = (() => {
    try {
      const raw = getDaemonKV().getItem(SELECTED_REMOTE_KEY);
      return raw ? (JSON.parse(raw) as Record<string, string>) : {};
    } catch {
      return {};
    }
  })();

  function selectedRemoteFor(repo: Repo): string | null {
    const remotes = repo.remotes ?? [];
    if (remotes.length === 0) return null;
    const saved = selectedRemoteByRepo[repoPrefsKey(repo)];
    if (saved && remotes.some((r) => r.name === saved)) return saved;
    return remotes.find((r) => r.name === "origin")?.name ?? remotes[0]!.name;
  }

  function selectedRemotesForDaemon(
    daemonId: string | undefined,
  ): Record<string, string> {
    const out: Record<string, string> = {};
    const prefix = daemonId ? `${daemonId}:` : "";
    for (const [key, remote] of Object.entries(selectedRemoteByRepo)) {
      if (daemonId) {
        if (key.startsWith(prefix)) out[key.slice(prefix.length)] = remote;
      } else if (!key.includes(":")) {
        out[key] = remote;
      }
    }
    return out;
  }

  function selectedRemotesQuery(daemonId: string | undefined): string {
    const selected = selectedRemotesForDaemon(daemonId);
    return Object.keys(selected).length > 0
      ? `?selectedRemotes=${encodeURIComponent(JSON.stringify(selected))}`
      : "";
  }

  function setSelectedRemote(repo: Repo, remote: string): void {
    const key = repoPrefsKey(repo);
    selectedRemoteByRepo = { ...selectedRemoteByRepo, [key]: remote };
    getDaemonKV().setItem(
      SELECTED_REMOTE_KEY,
      JSON.stringify(selectedRemoteByRepo),
    );
    void load();
  }

  function persistedSelectedRemoteForRepoId(repoId: string): string | null {
    const repo = repos.find((r) => r.id === repoId);
    if (!repo) return null;
    const saved = selectedRemoteByRepo[repoPrefsKey(repo)];
    return saved && (repo.remotes ?? []).some((r) => r.name === saved)
      ? saved
      : null;
  }

  async function loadBranchesFor(repoId: string, wtPath: string) {
    branchesLoading = { ...branchesLoading, [wtPath]: true };
    try {
      const res = await fetch(
        `/api/repos/${repoId}/branches?path=${encodeURIComponent(wtPath)}`,
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as BranchListing;
      branchesByWt = { ...branchesByWt, [wtPath]: body };
    } catch {
      branchesByWt = {
        ...branchesByWt,
        [wtPath]: { current: null, local: [], remote: [] },
      };
    } finally {
      branchesLoading = { ...branchesLoading, [wtPath]: false };
    }
  }

  type DirtyCheckoutContext = {
    repoId: string;
    wtPath: string;
    branch: string;
    message: string;
  };
  type DirtyCheckoutAction = "stash" | "force" | "cancel";

  /** Surface a successful "stash & switch" as a toast. Uses the generic
   *  toast stack so dismiss + ttl behave consistently with errors. */
  function showStashToast(_wtPath: string, message: string) {
    addToast({
      kind: "info",
      title: "Stashed.",
      message,
      ttlMs: 12_000,
    });
  }

  async function doCheckout(
    repoId: string,
    wtPath: string,
    branch: string,
    options: { force?: boolean; preStash?: boolean } = {},
  ): Promise<{
    ok: boolean;
    dirty?: boolean;
    error?: string;
    stashed?: boolean;
  }> {
    try {
      const res = await fetch(
        apiUrl(
          `/api/repos/${repoId}/checkout`,
          daemonIdForRepoId(repos, repoId),
        ),
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ path: wtPath, branch, ...options }),
        },
      );
      if (res.ok) {
        const body = (await res.json().catch(() => ({}))) as {
          stashed?: boolean;
        };
        return { ok: true, stashed: body.stashed };
      }
      const body = (await res.json().catch(() => ({}))) as {
        error?: string;
        dirty?: boolean;
      };
      return {
        ok: false,
        dirty: body.dirty,
        error: body.error ?? `HTTP ${res.status}`,
      };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  /** Branch-picker entrypoint: try a clean checkout; if it fails because
   *  of dirty state, surface the dirty-checkout dialog so the user
   *  picks Stash / Force / Cancel. */
  async function tryCheckout(repoId: string, wtPath: string, branch: string) {
    branchPickerOpen = { ...branchPickerOpen, [wtPath]: false };
    const result = await doCheckout(repoId, wtPath, branch);
    if (result.ok) {
      if (result.stashed) {
        showStashToast(
          wtPath,
          "Your changes are stashed. Run `git stash pop` (or use Fork) to restore.",
        );
      }
      await load();
      return;
    }
    if (result.dirty) {
      const ctx: DirtyCheckoutContext = {
        repoId,
        wtPath,
        branch,
        message: result.error ?? "worktree has uncommitted changes",
      };
      const action = await choiceDialog<DirtyCheckoutAction>({
        title: "Worktree has uncommitted changes",
        message: `Switching to ${branch} in ${wtPath} is blocked because the worktree is dirty. How would you like to handle your local changes?`,
        detail: ctx.message,
        choices: [
          {
            value: "stash",
            label: "Stash & switch",
            hint: "git stash push (recoverable with stash pop)",
            recommended: true,
          },
          {
            value: "force",
            label: "Force & switch",
            hint: "discards uncommitted changes - cannot be undone",
            danger: true,
          },
          { value: "cancel", label: "Cancel" },
        ],
        cancelValue: "cancel",
      });
      await resolveDirty(ctx, action ?? "cancel");
      return;
    }
    error = result.error ?? "checkout failed";
  }

  async function resolveDirty(
    ctx: DirtyCheckoutContext,
    action: DirtyCheckoutAction,
  ) {
    if (action === "cancel") return;
    if (action === "force") {
      const confirmed = await confirmDialog({
        title: "Discard uncommitted changes?",
        message: `Force-checkout will discard your uncommitted changes in ${ctx.wtPath}. This cannot be undone.`,
        confirmLabel: "Discard & switch",
        danger: true,
      });
      if (!confirmed) return;
    }
    const result = await doCheckout(ctx.repoId, ctx.wtPath, ctx.branch, {
      preStash: action === "stash",
      force: action === "force",
    });
    if (result.ok) {
      if (result.stashed) {
        showStashToast(
          ctx.wtPath,
          `Stashed your changes before switching to \`${ctx.branch}\`. Run \`git stash pop\` to restore.`,
        );
      }
      await load();
    } else {
      error = result.error ?? "checkout failed";
    }
  }

  /** Per-worktree busy flags for the pull/push badges. Keyed by wt
   *  path; presence means "request in flight" — used to disable the
   *  badge buttons so a double-click can't queue a second pull. */
  let pullBusy: Record<string, boolean> = {};
  let pushBusy: Record<string, boolean> = {};

  type DirtyPullContext = { repoId: string; wtPath: string; message: string };
  type DirtyPullAction = "stash" | "cancel";

  async function doPull(
    repoId: string,
    wtPath: string,
    options: { preStash?: boolean } = {},
  ): Promise<{
    ok: boolean;
    kind?: string;
    stashed?: boolean;
    stashRestored?: boolean;
    stashConflict?: boolean;
    error?: string;
  }> {
    try {
      const res = await fetch(
        apiUrl(`/api/repos/${repoId}/pull`, daemonIdForRepoId(repos, repoId)),
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            path: wtPath,
            remote: persistedSelectedRemoteForRepoId(repoId),
            ...options,
          }),
          signal: AbortSignal.timeout(90_000),
        },
      );
      const body = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        kind?: string;
        stashed?: boolean;
        stashRestored?: boolean;
        stashConflict?: boolean;
        error?: string;
      };
      if (res.ok && body.ok) {
        return {
          ok: true,
          kind: body.kind,
          stashed: body.stashed,
          stashRestored: body.stashRestored,
          stashConflict: body.stashConflict,
        };
      }
      return {
        ok: false,
        kind: body.kind,
        error: body.error ?? `HTTP ${res.status}`,
      };
    } catch (e) {
      const msg =
        e instanceof DOMException && e.name === "TimeoutError"
          ? "Pull timed out — the remote may be unreachable."
          : e instanceof Error
            ? e.message
            : String(e);
      return { ok: false, error: msg };
    }
  }

  /** Behind-badge click entrypoint. Tries a fast-forward pull; on
   *  kind=dirty surfaces a Stash & pull dialog; on kind=diverged or
   *  any other failure, surfaces an error toast (the user has to
   *  resolve diverged branches in Fork / their editor — supergit
   *  doesn't try to drive an interactive rebase/merge). */
  async function tryPull(repoId: string, wtPath: string) {
    if (pullBusy[wtPath]) return;
    pullBusy = { ...pullBusy, [wtPath]: true };
    try {
      const result = await doPull(repoId, wtPath);
      if (result.ok) {
        if (result.kind === "up_to_date") {
          addToast({
            kind: "info",
            message: "Already up to date.",
            ttlMs: 4_000,
          });
        } else {
          play("git-pull");
          addToast({
            kind: "success",
            message: "Pulled latest from upstream.",
            ttlMs: 6_000,
          });
        }
        await load();
        await load();
        return;
      }
      if (result.kind === "auth") {
        addToast({
          kind: "error",
          title: "Git can't authenticate.",
          message:
            "Run `git config --global credential.helper osxkeychain` then `git fetch` in a terminal to store your credentials.",
          ttlMs: 20_000,
        });
        return;
      }
      if (result.kind === "auth") {
        addToast({
          kind: "error",
          title: "Git can't authenticate.",
          message:
            "Run `git config --global credential.helper osxkeychain` then `git fetch` in a terminal to store your credentials.",
          ttlMs: 20_000,
        });
        return;
      }
      if (result.kind === "dirty") {
        const ctx: DirtyPullContext = {
          repoId,
          wtPath,
          message: result.error ?? "worktree has uncommitted changes",
        };
        pullBusy = { ...pullBusy, [wtPath]: false };
        const action = await choiceDialog<DirtyPullAction>({
          title: "Pull would clobber uncommitted changes",
          message: `Fast-forwarding ${wtPath} is blocked because your local edits overlap the incoming commits. How would you like to handle your local changes?`,
          detail: ctx.message,
          choices: [
            {
              value: "stash",
              label: "Stash & pull",
              hint: "git stash push (recoverable with stash pop)",
              recommended: true,
            },
            { value: "cancel", label: "Cancel" },
          ],
          cancelValue: "cancel",
        });
        await resolveDirtyPull(ctx, action ?? "cancel");
        return;
      }
      if (result.kind === "diverged") {
        addToast({
          kind: "error",
          title: "Branch has diverged.",
          message:
            "Local commits aren't on upstream — resolve in Fork / your editor (rebase or merge), then try again.",
          ttlMs: 12_000,
        });
        return;
      }
      if (result.kind === "no_upstream") {
        addToast({
          kind: "error",
          title: "No upstream.",
          message: "This branch has no remote tracking ref.",
          ttlMs: 8_000,
        });
        return;
      }
      addToast({
        kind: "error",
        title: "Pull failed.",
        message: result.error ?? "git pull failed",
        ttlMs: 12_000,
      });
    } finally {
      pullBusy = { ...pullBusy, [wtPath]: false };
    }
  }

  async function resolveDirtyPull(
    ctx: DirtyPullContext,
    action: DirtyPullAction,
  ) {
    if (action === "cancel") return;
    pullBusy = { ...pullBusy, [ctx.wtPath]: true };
    try {
      const result = await doPull(ctx.repoId, ctx.wtPath, { preStash: true });
      if (result.ok) {
        play("git-pull");
        if (result.stashed && result.stashConflict) {
          addToast({
            kind: "error",
            title: "Pulled — but your changes conflict.",
            message:
              "Stashed and pulled, but reapplying your changes hit a conflict. Resolve the conflict markers, or run `git stash pop` again after fixing.",
            ttlMs: 20_000,
          });
        } else if (result.stashed && result.stashRestored) {
          showStashToast(
            ctx.wtPath,
            "Stashed your local changes, pulled, and reapplied them on top.",
          );
        } else if (result.stashed) {
          showStashToast(
            ctx.wtPath,
            "Stashed your local changes before pulling. Run `git stash pop` to restore.",
          );
        } else {
          addToast({
            kind: "success",
            message: "Pulled latest from upstream.",
            ttlMs: 6_000,
          });
        }
        await load();
        await load();
      } else {
        addToast({
          kind: "error",
          title: "Pull failed.",
          message: result.error ?? "git pull failed",
          ttlMs: 12_000,
        });
      }
    } finally {
      pullBusy = { ...pullBusy, [ctx.wtPath]: false };
    }
  }

  /** Ahead-badge click entrypoint. Plain `git push` to the tracked
   *  upstream. Never forces; failures (non-fast-forward, hook abort,
   *  auth) surface as an error toast with the git error verbatim so
   *  the user can decide what to do (usually: pull first, then push). */
  async function tryPush(repoId: string, wtPath: string) {
    if (pushBusy[wtPath]) return;
    pushBusy = { ...pushBusy, [wtPath]: true };
    try {
      const res = await fetch(
        apiUrl(`/api/repos/${repoId}/push`, daemonIdForRepoId(repos, repoId)),
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            path: wtPath,
            remote: persistedSelectedRemoteForRepoId(repoId),
          }),
          signal: AbortSignal.timeout(90_000),
        },
      );
      const body = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        error?: string;
        message?: string;
        kind?: string;
      };
      if (res.ok && body.ok) {
        play("git-push");
        addToast({
          kind: "success",
          message: "Pushed to upstream.",
          ttlMs: 6_000,
        });
        await load();
        await load();
        return;
      }
      if (body.kind === "auth") {
        addToast({
          kind: "error",
          title: "Git can't authenticate.",
          message:
            "Run `git config --global credential.helper osxkeychain` then `git fetch` in a terminal to store your credentials.",
          ttlMs: 20_000,
        });
        return;
      }
      if (body.kind === "auth") {
        addToast({
          kind: "error",
          title: "Git can't authenticate.",
          message:
            "Run `git config --global credential.helper osxkeychain` then `git fetch` in a terminal to store your credentials.",
          ttlMs: 20_000,
        });
        return;
      }
      addToast({
        kind: "error",
        title: "Push failed.",
        message: body.error ?? `HTTP ${res.status}`,
        ttlMs: 14_000,
      });
    } catch (e) {
      const msg =
        e instanceof DOMException && e.name === "TimeoutError"
          ? "Push timed out — the remote may be unreachable."
          : e instanceof Error
            ? e.message
            : String(e);
      addToast({
        kind: "error",
        title: "Push failed.",
        message: msg,
        ttlMs: 12_000,
      });
    } finally {
      pushBusy = { ...pushBusy, [wtPath]: false };
    }
  }

  async function loadInstalledAgents() {
    try {
      const res = await fetch(apiUrl("/api/agents/installed"));
      if (!res.ok) return;
      const body = (await res.json()) as {
        installed: { name: string; path: string }[];
      };
      installedAgents = body.installed ?? [];
      agentsByDaemon = { ...agentsByDaemon, local: installedAgents };
    } catch {
      installedAgents = [];
    }
  }

  /** Find the array index, in the worktree's current open-sessions list,
   *  where a new session should be inserted so it lands in a visible
   *  spot. If the leftmost visible column is cut off on the left edge,
   *  insert *after* it (so the new column appears between the cutoff
   *  column and the next fully visible one). Otherwise insert at that
   *  column's index. Falls back to 0 when the strip isn't laid out yet
   *  (e.g. row currently folded). */
  function visibleLeftInsertIndex(wtPath: string, list: OpenSession[]): number {
    const strip = document.querySelector(
      `[data-wt-strip="${CSS.escape(wtPath)}"]`,
    ) as HTMLElement | null;
    if (!strip) return 0;
    const scrollLeft = strip.scrollLeft;
    const cols = strip.querySelectorAll<HTMLElement>(".session-col");
    for (const col of cols) {
      const colRight = col.offsetLeft + col.offsetWidth;
      if (colRight - scrollLeft >= 50) {
        const targetSource = col.dataset.sessionSource;
        if (targetSource) {
          const u = list.findIndex((x) => x.source === targetSource);
          if (u >= 0) {
            // If this column's left edge is before the scroll offset,
            // it's partially cut off — insert after it so the new
            // session lands in the visible area, not off-screen.
            if (col.offsetLeft < scrollLeft) return u + 1;
            return u;
          }
        }
        break;
      }
    }
    return 0;
  }

  /** After inserting `source` into the strip, smooth-scroll the strip so
   *  the new column sits at the viewport's left edge, AND vertically
   *  scroll the page so the row is visible (centered when possible,
   *  closest-edge when not — e.g. row is already partially visible).
   *  Without the vertical bit, creating a new session on a row below the
   *  fold gives no feedback: the column exists, but the user can't see it.
   *
   *  Delay before measuring: two concurrent CSS animations distort the
   *  column geometry for ~250ms after insert —
   *    1. `animate:flip` on `.session-col` (220ms) — existing siblings
   *       slide to their new positions when the new column splices in.
   *    2. `.session-col` width transitions on flex-basis/min/max-width
   *       (250ms) — read-mode siblings can snap to their narrower size
   *       when a live TUI is added.
   *  Measuring at the next rAF lands on mid-animation offsets, which
   *  parks the strip / page on a target that drifts under it as the
   *  animation finishes. Wait ~280ms so layout has settled before we
   *  compute scrollTo()'s target. */
  const NEW_COL_SCROLL_DELAY_MS = 280;
  function scrollNewColIntoView(wtPath: string, source: string): void {
    setTimeout(() => {
      const strip = document.querySelector(
        `[data-wt-strip="${CSS.escape(wtPath)}"]`,
      ) as HTMLElement | null;
      if (!strip) return;
      const newCol = strip.querySelector<HTMLElement>(
        `.session-col[data-session-source="${CSS.escape(source)}"]`,
      );
      if (!newCol) return;
      // Skip BOTH axes when the column is already in view: TerminalView's
      // xterm.focus() (fired from the WS-onopen handler) already triggers
      // the browser's built-in "scroll focused element into view" — it
      // typically lands the column nicely centered. Issuing our own
      // strip.scrollTo + scrollIntoView on top of that competes with
      // xterm's scroll and the user sees a second jump that yanks the
      // column off the position xterm just put it in.
      //
      // Per-axis skips so each axis only moves if it actually needs to:
      //   - horizontal: only flush-left the strip if the column isn't
      //     fully inside the strip's visible width.
      //   - vertical: only scrollIntoView if the column isn't fully in
      //     the viewport's vertical extent.
      //
      // When we do step in vertically, anchor on the column itself (not
      // the row-body): centering a tall row-body parks its middle in the
      // viewport and pushes the column off-screen, which was the prior
      // bug. `block: "center"` centers when the column fits, falls back
      // to nearest-edge for columns taller than the viewport — that's
      // the "center if possible / closest view" semantics.
      const r = newCol.getBoundingClientRect();
      const stripR = strip.getBoundingClientRect();
      const vh = window.innerHeight;
      const horizontallyVisible =
        r.left >= stripR.left && r.right <= stripR.right;
      const verticallyVisible = r.top >= 0 && r.bottom <= vh;
      if (!horizontallyVisible) {
        // Scroll just enough to reveal the column's right edge, keeping
        // as much of the strip's prior scroll position as possible.
        // Only flush-left when the column is entirely off to the left.
        const colRight = newCol.offsetLeft + newCol.offsetWidth;
        const stripWidth = strip.clientWidth;
        if (newCol.offsetLeft < strip.scrollLeft) {
          strip.scrollTo({ left: newCol.offsetLeft, behavior: "smooth" });
        } else {
          strip.scrollTo({ left: colRight - stripWidth, behavior: "smooth" });
        }
      }
      if (!verticallyVisible) {
        newCol.scrollIntoView({
          block: "center",
          inline: "nearest",
          behavior: "smooth",
        });
      }
    }, NEW_COL_SCROLL_DELAY_MS);
  }

  /** Open a brand-new agent session in this worktree. Adds a transient
   *  open-session entry whose source is sentinel-prefixed with
   *  `__new__:` — the column rendering branches on that to render
   *  TerminalView directly instead of the read-mode SessionView. */
  function openNewAgentSession(
    wtPath: string,
    agent: "claude" | "codex",
    initialPrompt?: string,
  ) {
    const id = `t_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
    const synthetic = `__new__:${agent}:${id}`;
    const existing = openSessionsByWt[wtPath] ?? [];
    // Preassign a UUID for Claude so we can pass `--session-id <uuid>`
    // on spawn. Without it, recent Claude versions auto-load the cwd's
    // most-recent conversation when invoked as bare `claude`, which
    // makes "+ new session" silently resume the wrong thing. Codex has
    // no equivalent flag and isn't affected.
    const entry: {
      agent: "claude" | "codex";
      source: string;
      preassignedSessionId?: string;
      initialPrompt?: string;
    } = { agent, source: synthetic };
    if (agent === "claude") {
      entry.preassignedSessionId = randomUUID();
    }
    // Seeded when the column is started from the task queue (play button);
    // cmdForOpenSession consumes it on the fresh spawn only.
    if (initialPrompt) entry.initialPrompt = initialPrompt;
    const insertAt = visibleLeftInsertIndex(wtPath, existing);
    const next = [...existing];
    next.splice(insertAt, 0, entry);
    openSessionsByWt = { ...openSessionsByWt, [wtPath]: next };
    markTransientDiscovery(synthetic);
    scrollNewColIntoView(wtPath, synthetic);
  }

  /** Open a Codex app-server session as a normal chat/history column.
   *  This is separate from the Codex CLI option above, which still
   *  spawns the terminal TUI. The live column is keyed by the app-server
   *  thread id; Codex's transcript path is kept only as transcript metadata. */
  async function openNewCodexAppSession(wtPath: string): Promise<void> {
    try {
      const daemonId = daemonIdForWorktreePath(repos, wtPath);
      const res = await fetch(apiUrl("/api/session/start", daemonId), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agent: "codex", cwd: wtPath }),
      });
      const body = (await res.json().catch(() => null)) as {
        error?: string;
        sessionId?: string;
        source?: string;
        model?: string;
      } | null;
      if (!res.ok) {
        addToast({
          kind: "warning",
          message:
            body?.error ?? `Codex App failed to start (HTTP ${res.status})`,
        });
        return;
      }
      if (!body?.sessionId) {
        addToast({
          kind: "warning",
          message: "Codex App started but did not return a thread id.",
        });
        return;
      }
      const liveSource = codexAppSource(body.sessionId);
      const existing = openSessionsByWt[wtPath] ?? [];
      const insertAt = visibleLeftInsertIndex(wtPath, existing);
      const entry: OpenSession = {
        agent: "codex",
        source: liveSource,
        resumeSessionId: body.sessionId,
        transcriptSource: body.source,
      };
      rememberSessionSurface(entry, "read");
      const next = [...existing];
      next.splice(insertAt, 0, entry);
      openSessionsByWt = { ...openSessionsByWt, [wtPath]: next };
      scrollNewColIntoView(wtPath, liveSource);
      void load("codex-app-start");
    } catch (e) {
      addToast({
        kind: "warning",
        message: `Codex App failed to start: ${
          e instanceof Error ? e.message : String(e)
        }`,
      });
    }
  }

  /** Source-path fallback for freshly-created Ollama chat sessions,
   *  keyed by `__transcript__:ollama:<termId>` source. Set in
   *  `openNewOllamaChat` from the POST response so OllamaTranscriptView
   *  has a sourcePath before the next /api/repos rescan picks the new
   *  file up into `wt.agents`. Cleared on close. */
  let ollamaSourcePathOverride: Record<string, string> = {};

  /** Open a fresh API-driven Ollama chat column. POSTs to
   *  /api/ollama/sessions to create the JSONL with header, then routes
   *  through the same `__transcript__:ollama:<termId>` rendering path
   *  the picker already uses for past sessions — except now there's a
   *  composer at the bottom of SessionView and the conversation is
   *  driven via /api/ollama/chat instead of a PTY. See
   *  plans/ollama.md "Plan: API-driven chat mode". */
  async function openNewOllamaChat(
    wtPath: string,
    model: string,
  ): Promise<void> {
    try {
      const res = await fetch(apiUrl("/api/ollama/sessions"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model, wt: wtPath, cwd: wtPath }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        console.error(
          `openNewOllamaChat: daemon returned ${res.status} ${body?.error ?? ""}`,
        );
        return;
      }
      const body = (await res.json()) as {
        termId?: string;
        source?: string;
        model?: string;
      };
      const termId = body.termId;
      const sourcePath = body.source;
      if (!termId) return;
      const transcriptSource = `__transcript__:ollama:${termId}`;
      if (sourcePath) {
        ollamaSourcePathOverride = {
          ...ollamaSourcePathOverride,
          [transcriptSource]: sourcePath,
        };
      }
      const existing = openSessionsByWt[wtPath] ?? [];
      const insertAt = visibleLeftInsertIndex(wtPath, existing);
      const next = [...existing];
      next.splice(insertAt, 0, {
        agent: "ollama",
        source: transcriptSource,
        ollamaModel: model,
      });
      openSessionsByWt = { ...openSessionsByWt, [wtPath]: next };
      scrollNewColIntoView(wtPath, transcriptSource);
      // Refresh /api/repos so wt.agents picks up the new JSONL — needed
      // by the OllamaTranscriptView render branch's ollamaMeta lookup
      // on a subsequent reload (the immediate render uses the override
      // above).
      void load("ollama-start");
    } catch (e) {
      console.error("openNewOllamaChat:", e);
    }
  }

  /** Open a brand-new "Terminal" column in this worktree — a plain PTY
   *  running the user's $SHELL. Mirrors `openNewAgentSession` but uses
   *  agent="shell"; the render branch picks `defaultShell` as the cmd. */
  function openNewTerminalInWt(wtPath: string, shell?: ShellOption) {
    const id = `t_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
    const synthetic = `__new__:shell:${id}`;
    const existing = openSessionsByWt[wtPath] ?? [];
    // When the box offered >1 shell (Windows: PowerShell vs CMD) stamp the
    // exact pick so cmdForOpenSession spawns it instead of the default shell.
    const entry: OpenSession = {
      agent: "shell",
      source: synthetic,
      ...(shell ? { shellCmd: [shell.shell, ...shell.args] } : {}),
    };
    const insertAt = visibleLeftInsertIndex(wtPath, existing);
    const next = [...existing];
    next.splice(insertAt, 0, entry);
    openSessionsByWt = { ...openSessionsByWt, [wtPath]: next };
    scrollNewColIntoView(wtPath, synthetic);
  }

  /** Start a queued task (QueueColumn play button): open a live agent
   *  column in the task's worktree seeded with its prompt. Shell tasks get
   *  a plain terminal (no positional prompt). The status flip to "running"
   *  is done by QueueColumn, which owns task mutations. */
  function startTask(task: {
    worktreePath: string;
    agent: "claude" | "codex" | "shell";
    prompt?: string;
  }) {
    if (task.agent === "shell") {
      openNewTerminalInWt(task.worktreePath);
    } else {
      openNewAgentSession(task.worktreePath, task.agent, task.prompt);
    }
  }

  // --- Onboarding: "Get Started" inline AI description ----------------

  const newlyAddedRepoPaths = new Set<string>();

  interface OnboardingState {
    status: "loading" | "streaming" | "done" | "error";
    text: string;
    provider?: string;
    model?: string;
    error?: string;
  }
  let onboardingByWt: Record<string, OnboardingState> = {};
  let walkthroughByWt: Record<string, number | null> = {};

  $: tourRunning = Object.values(walkthroughByWt).some((v) => v != null);

  async function restartTutorial(): Promise<void> {
    if (tourRunning) {
      walkthroughByWt = {};
      return;
    }
    const ok = await confirmDialog({
      title: "Start the UI walkthrough?",
      message: "Highlights each part of the dashboard step by step.",
      confirmLabel: "Start tour",
    });
    if (!ok) return;
    const firstWt = rows.find((r) => r.wt && !r.wt.nonGit)?.wt;
    if (!firstWt) return;
    clearWalkthroughSeen(firstWt.path);
    walkthroughByWt = { [firstWt.path]: 0 };
  }

  async function startOnboarding(wtPath: string): Promise<void> {
    newlyAddedRepoPaths.delete(wtPath);
    onboardingByWt = {
      ...onboardingByWt,
      [wtPath]: { status: "loading", text: "" },
    };
    try {
      const res = await fetch(apiUrl("/api/onboarding/describe"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: wtPath }),
      });
      if (!res.ok || !res.body) {
        const body = await res.json().catch(() => null);
        throw new Error(
          (body as { error?: string })?.error ?? `HTTP ${res.status}`,
        );
      }
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      let collected = "";
      let provider = "";
      let model = "";

      onboardingByWt = {
        ...onboardingByWt,
        [wtPath]: { status: "streaming", text: "" },
      };

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let frameEnd: number;
        while ((frameEnd = buf.indexOf("\n\n")) !== -1) {
          const frame = buf.slice(0, frameEnd);
          buf = buf.slice(frameEnd + 2);
          let event = "message";
          let dataLine = "";
          for (const line of frame.split("\n")) {
            if (line.startsWith("event:")) event = line.slice(6).trim();
            else if (line.startsWith("data:")) dataLine += line.slice(5).trim();
          }
          if (!dataLine) continue;
          let payload: Record<string, unknown>;
          try {
            payload = JSON.parse(dataLine) as Record<string, unknown>;
          } catch {
            continue;
          }
          if (event === "meta") {
            provider = (payload.provider as string) ?? "";
            model = (payload.model as string) ?? "";
            onboardingByWt = {
              ...onboardingByWt,
              [wtPath]: {
                status: "streaming",
                text: collected,
                provider,
                model,
              },
            };
          } else if (event === "chunk" && typeof payload.delta === "string") {
            collected += payload.delta;
            onboardingByWt = {
              ...onboardingByWt,
              [wtPath]: {
                status: "streaming",
                text: collected,
                provider,
                model,
              },
            };
          } else if (event === "error") {
            throw new Error((payload.message as string) ?? "stream error");
          } else if (event === "done") {
            // done
          }
        }
      }

      onboardingByWt = {
        ...onboardingByWt,
        [wtPath]: { status: "done", text: collected, provider, model },
      };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      onboardingByWt = {
        ...onboardingByWt,
        [wtPath]: { status: "error", text: "", error: msg },
      };
    }
  }

  async function continueSessionWith(
    wtPath: string,
    sessionSource: string,
    targetAgent: "claude" | "codex" | "ollama",
    ollamaModel?: string,
  ): Promise<void> {
    let contextPath: string;
    let contextText: string | undefined;
    try {
      const res = await fetch(
        `/api/session/context?source=${encodeURIComponent(sessionSource)}`,
      );
      if (!res.ok) return;
      const body = (await res.json()) as {
        contextPath?: string;
        context?: string;
      };
      contextPath = body.contextPath ?? "";
      contextText = body.context;
    } catch {
      return;
    }
    if (!contextPath) return;

    if (targetAgent === "ollama") {
      await ensureOllamaModelsLoaded();
      const model = ollamaModel ?? ollamaModels[0]?.name ?? "gemma3:4b";
      await openNewOllamaChat(wtPath, model);
      const lastWt = openSessionsByWt[wtPath] ?? [];
      const ollamaEntry = [...lastWt]
        .reverse()
        .find(
          (s) =>
            s.agent === "ollama" &&
            s.source.startsWith("__transcript__:ollama:"),
        );
      if (ollamaEntry) {
        const termId = ollamaEntry.source.replace("__transcript__:ollama:", "");
        const prompt =
          "I'm continuing a conversation from another agent. " +
          "Pick up where it left off:\n\n" +
          (contextText ?? `(see ${contextPath})`);
        void fetch(apiUrl("/api/ollama/chat"), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ termId, content: prompt }),
        });
      }
      return;
    }

    const id = `t_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
    const synthetic = `__new__:${targetAgent}:${id}`;
    const entry: OpenSession = {
      agent: targetAgent,
      source: synthetic,
      contextFilePath: contextPath,
    };
    if (targetAgent === "claude") {
      (entry as { preassignedSessionId?: string }).preassignedSessionId =
        randomUUID();
    }
    const existing = openSessionsByWt[wtPath] ?? [];
    const insertAt = visibleLeftInsertIndex(wtPath, existing);
    const next = [...existing];
    next.splice(insertAt, 0, entry);
    openSessionsByWt = { ...openSessionsByWt, [wtPath]: next };
    scrollNewColIntoView(wtPath, synthetic);
  }

  function openFileBrowser(wtPath: string) {
    const id = `fb_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
    const synthetic = `__files__:${id}`;
    const existing = openSessionsByWt[wtPath] ?? [];
    const entry: OpenSession = { agent: "files", source: synthetic };
    const insertAt = visibleLeftInsertIndex(wtPath, existing);
    const next = [...existing];
    next.splice(insertAt, 0, entry);
    openSessionsByWt = { ...openSessionsByWt, [wtPath]: next };
    scrollNewColIntoView(wtPath, synthetic);
  }

  function openRemoteBrowser(wtPath: string, termId: string, sshHost: string) {
    const id = `rb_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
    const synthetic = `__remote__:${termId}:${id}`;
    const existing = openSessionsByWt[wtPath] ?? [];
    // Don't open a duplicate for the same terminal
    if (existing.some((s) => s.source.startsWith(`__remote__:${termId}:`))) {
      scrollNewColIntoView(
        wtPath,
        existing.find((s) => s.source.startsWith(`__remote__:${termId}:`))!
          .source,
      );
      return;
    }
    const entry: OpenSession = { agent: "files", source: synthetic };
    // Insert right after the terminal column that spawned us
    const termSource = `__attached__:shell:${termId}`;
    const termIdx = existing.findIndex((s) => s.source === termSource);
    const insertAt = termIdx >= 0 ? termIdx + 1 : existing.length;
    const next = [...existing];
    next.splice(insertAt, 0, entry);
    openSessionsByWt = { ...openSessionsByWt, [wtPath]: next };
    scrollNewColIntoView(wtPath, synthetic);
  }

  function openGitHistory(wtPath: string) {
    const id = `gh_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
    const synthetic = `__history__:${id}`;
    const existing = openSessionsByWt[wtPath] ?? [];
    const entry: OpenSession = { agent: "history", source: synthetic };
    const insertAt = visibleLeftInsertIndex(wtPath, existing);
    const next = [...existing];
    next.splice(insertAt, 0, entry);
    openSessionsByWt = { ...openSessionsByWt, [wtPath]: next };
    scrollNewColIntoView(wtPath, synthetic);
  }

  async function loadDefaultShell() {
    try {
      const res = await fetch(apiUrl("/api/shell-default"));
      if (!res.ok) return;
      const body = (await res.json()) as { shell?: unknown; args?: unknown };
      if (typeof body.shell === "string" && body.shell.length > 0) {
        defaultShell = body.shell;
        shellByDaemon = { ...shellByDaemon, local: defaultShell };
      }
      if (Array.isArray(body.args)) {
        defaultShellArgs = body.args as string[];
      }
    } catch {
      // best-effort — keeps the platform fallback
    }
    try {
      const res = await fetch(apiUrl("/api/shells/available"));
      if (!res.ok) return;
      const body = (await res.json()) as { shells?: unknown };
      if (Array.isArray(body.shells)) {
        shellsByDaemon = {
          ...shellsByDaemon,
          local: body.shells as ShellOption[],
        };
      }
    } catch {
      // best-effort — picker falls back to the single default-shell entry
    }
  }

  /** Per-source cwd override for shell columns spawned via Resume.
   *  When the user Resumes a past shell, we want the new PTY at the
   *  *last* known cwd of that shell, not the worktree root. Keyed by
   *  the `__new__:shell:<id>` source the Resume action created. */
  let shellResumeCwd: Record<string, string> = {};

  /** Restore shell columns from the workspace. Live shells (PTY still
   *  alive) get an `__attached__:shell:<termId>` source so TerminalView
   *  reattaches via WS. Dead shells get `__transcript__:shell:<termId>`
   *  — ShellView fetches the JSONL and renders the command history with
   *  a Resume button. */
  /** Sources the user explicitly closed (× on a shell column, or toggled-
   *  off via the picker). Persisted so the close decision survives a
   *  reload — otherwise `restoreLiveShells` would re-add any live PTY
   *  inside the grace window and the close button would feel broken. */
  const DISMISSED_KEY = "supergit:dismissedShells";
  let dismissedShells: Set<string> = (() => {
    try {
      const raw = getDaemonKV().getItem(DISMISSED_KEY);
      if (!raw) return new Set();
      const arr = JSON.parse(raw);
      return new Set(
        Array.isArray(arr) ? arr.filter((x) => typeof x === "string") : [],
      );
    } catch {
      return new Set();
    }
  })();
  function saveDismissedShells() {
    try {
      getDaemonKV().setItem(
        DISMISSED_KEY,
        JSON.stringify([...dismissedShells]),
      );
    } catch {}
  }
  function dismissShellSource(source: string): void {
    if (
      !source.startsWith("__attached__:shell:") &&
      !source.startsWith("__transcript__:shell:")
    )
      return;
    if (dismissedShells.has(source)) return;
    dismissedShells = new Set([...dismissedShells, source]);
    saveDismissedShells();
  }
  function undismissShellSource(source: string): void {
    if (!dismissedShells.has(source)) return;
    const next = new Set(dismissedShells);
    next.delete(source);
    dismissedShells = next;
    saveDismissedShells();
  }

  type LiveShell = {
    termId: string;
    wt: string;
    spawnCwd: string;
    currentCwd?: string;
    alive: boolean;
  };

  async function restoreLiveShells() {
    // Restore open shells from the LOCAL daemon AND every remote daemon.
    // A remote daemon's shells live in ITS workspace (the box that spawned
    // them), keyed by the remote worktree path — which matches the remote
    // repo's wt paths in openSessionsByWt, so they merge the same way. The
    // render branch resolves each row's daemonId via the worktree path, so
    // the reconnecting WS routes back to the right daemon automatically.
    // Without this, a remote row's terminals were lost on reload.
    //
    // CRUCIAL: collect every daemon's live shells into ONE list and call
    // mergeLiveShells ONCE. mergeLiveShells PRUNES attached-shell rows
    // whose termId isn't in the list it's given — so calling it per-daemon
    // would have each call prune the other daemons' shells.
    const sources: Array<string | undefined> = [
      undefined,
      ...remoteDaemons.map((d) => d.id),
    ];
    const all: LiveShell[] = [];
    for (const daemonId of sources) {
      try {
        const res = await fetch(apiUrl("/api/shells", daemonId));
        if (!res.ok) continue;
        const list = (await res.json()) as LiveShell[];
        all.push(...list);
      } catch {
        // best-effort per daemon — a down remote just means its Terminal
        // columns aren't restored; local + other daemons still work.
      }
    }
    openSessionsByWt = mergeLiveShells(
      openSessionsByWt,
      all,
      dismissedShells,
    ) as typeof openSessionsByWt;
  }

  /** Persisted terminal info for __restore__: columns. */
  let persistedTerminals: Record<
    string,
    {
      cmd: string[];
      cwd: string;
      title?: string;
      firstCmd?: string;
      lastCmd?: string;
    }
  > = {};

  async function restorePersistedTerminals() {
    // Like restoreLiveShells: pull persisted (dead-but-resumable) terminals
    // from the LOCAL daemon AND each remote daemon, so a remote row's
    // __restore__ cards survive a reload.
    const sources: Array<string | undefined> = [
      undefined,
      ...remoteDaemons.map((d) => d.id),
    ];
    for (const daemonId of sources) {
      try {
        const res = await fetch(apiUrl("/api/terminals/persisted", daemonId));
        if (!res.ok) continue;
        const list = (await res.json()) as Array<{
          termId: string;
          cmd: string[];
          cwd: string;
          wtPath: string;
          title?: string;
          firstCmd?: string;
          lastCmd?: string;
        }>;
        if (list.length === 0) continue;
        // Stash metadata for each persisted termId so the __restore__
        // render branch can show the right title / cmd. We do this even
        // for entries that get deduped out below — harmless and the data
        // becomes useful if the live attachment ever drops.
        const nextMeta = { ...persistedTerminals };
        for (const entry of list) {
          const source = `__restore__:${entry.termId}`;
          nextMeta[source] = {
            cmd: entry.cmd,
            cwd: entry.cwd,
            title: entry.title,
            firstCmd: entry.firstCmd,
            lastCmd: entry.lastCmd,
          };
        }
        persistedTerminals = nextMeta;
        openSessionsByWt = mergePersistedTerminals(
          openSessionsByWt,
          list,
        ) as typeof openSessionsByWt;
      } catch {
        // best-effort per daemon
      }
    }
  }

  function resumePersistedTerminal(wtPath: string, restoreSource: string) {
    const info = persistedTerminals[restoreSource];
    if (!info) return;
    const termId = restoreSource.replace("__restore__:", "");
    // Replace the __restore__: column with a __new__:shell: column
    const id = `t_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
    const newSource = `__new__:shell:${id}`;
    shellResumeCwd = { ...shellResumeCwd, [newSource]: info.cwd };
    const prefill = info.firstCmd || info.lastCmd || info.cmd.join(" ");
    shellPrefillCmd = { ...shellPrefillCmd, [newSource]: prefill };
    const existing = openSessionsByWt[wtPath] ?? [];
    openSessionsByWt = {
      ...openSessionsByWt,
      [wtPath]: existing.map((s) =>
        s.source === restoreSource ? { ...s, source: newSource } : s,
      ),
    };
    delete persistedTerminals[restoreSource];
    // Route the remove to the daemon that OWNS this worktree — a remote
    // restored terminal's record lives on the remote box.
    void fetch(
      apiUrl(
        "/api/terminals/persisted/remove",
        daemonIdForWorktreePath(repos, wtPath),
      ),
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ termId }),
      },
    ).catch(() => {});
  }

  function dismissPersistedTerminal(wtPath: string, restoreSource: string) {
    const termId = restoreSource.replace("__restore__:", "");
    const existing = openSessionsByWt[wtPath] ?? [];
    openSessionsByWt = {
      ...openSessionsByWt,
      [wtPath]: existing.filter((s) => s.source !== restoreSource),
    };
    delete persistedTerminals[restoreSource];
    void fetch(
      apiUrl(
        "/api/terminals/persisted/remove",
        daemonIdForWorktreePath(repos, wtPath),
      ),
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ termId }),
      },
    ).catch(() => {});
  }

  /** Map of __new__:shell: sources to a command string to prefill. */
  let shellPrefillCmd: Record<string, string> = {};

  /** Click handler for a past-shell's "Resume" button. Replaces the
   *  `__transcript__:` column with a `__new__:shell:<id>` one and
   *  remembers `lastCwd` so the render branch can pass it to TerminalView
   *  as the spawn cwd. */
  function resumePastShell(
    wtPath: string,
    transcriptSource: string,
    lastCwd: string,
  ) {
    const id = `t_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
    const newSource = `__new__:shell:${id}`;
    shellResumeCwd = { ...shellResumeCwd, [newSource]: lastCwd };
    // Extract the prior termId from the `__transcript__:shell:<termId>`
    // source so the daemon can carry the prior cmd history forward
    // into the resumed shell's JSONL. ShellView mounts at this format
    // (see App.svelte's __transcript__: branch), so the termId is the
    // last colon-separated chunk.
    const previousTermId = transcriptSource.startsWith("__transcript__:shell:")
      ? transcriptSource.slice("__transcript__:shell:".length)
      : undefined;
    if (previousTermId) {
      shellResumeFromTermId = {
        ...shellResumeFromTermId,
        [newSource]: previousTermId,
      };
    }
    const existing = openSessionsByWt[wtPath] ?? [];
    openSessionsByWt = {
      ...openSessionsByWt,
      [wtPath]: existing.map((x) =>
        x.source === transcriptSource
          ? { agent: "shell", source: newSource }
          : x,
      ),
    };
  }
  /** Synthetic-source → prior termId map. Populated by `resumePastShell`
   *  and consumed by NewSessionCol via the `resumeFromTermId` prop
   *  (which it forwards to TerminalView's spawn POST). Pruned in
   *  `disposeNewSessionColumn` when the column finally closes. */
  let shellResumeFromTermId: Record<string, string> = {};

  /** Restart a transient `__new__:` session IN PLACE. Replaces its
   *  entry with a fresh synthetic source so Svelte's {#each (s.source)}
   *  key change unmounts the old TerminalView (closing its WS, which
   *  triggers the daemon's grace-then-dispose for the dead PTY) and
   *  mounts a new one with the same cmd[]. Used when an agent
   *  self-updates and exits — codex prints "restart Codex" and we
   *  want a one-click rerun without losing the user's column slot. */
  function restartNewAgentSession(
    wtPath: string,
    current: { agent: string; source: string },
  ) {
    const existing = openSessionsByWt[wtPath] ?? [];
    const id = `t_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
    const replacement: {
      agent: "claude" | "codex" | "copilot";
      source: string;
      preassignedSessionId?: string;
    } = {
      agent: current.agent as "claude" | "codex" | "copilot",
      source: `__new__:${current.agent}:${id}`,
    };
    // Restart means a fresh conversation, not a continuation — mint a
    // new UUID for Claude so `--session-id` lands on a new file rather
    // than colliding with the dying PTY's id.
    if (current.agent === "claude") {
      replacement.preassignedSessionId = randomUUID();
    }
    openSessionsByWt = {
      ...openSessionsByWt,
      [wtPath]: existing.map((x) =>
        x.source === current.source ? replacement : x,
      ),
    };
    clearTransientDiscovery(current.source);
    markTransientDiscovery(replacement.source);
  }

  /** Per-source remount counter for Claude columns. Bumped whenever the
   *  user switches model/effort so the `{#key}` wrapping the column tears
   *  down its TerminalView and spawns a fresh one — which, because the
   *  session already has a resumeSessionId, comes back as
   *  `claude --resume <sid> --model <new>` and continues the same thread.
   *  This is the exact lifecycle a page reload of a live TUI already
   *  uses (unmount closes the WS → daemon grace-reaps the old PTY → the
   *  remount resumes), so no extra PTY-kill plumbing is needed. */
  let claudeColGen: Record<string, number> = {};

  /** Persist a Claude model/effort choice onto the open-session entry and
   *  remount the column so the change takes effect immediately. */
  function setClaudeSessionFlag(
    wtPath: string,
    source: string,
    patch: { claudeModel?: string; claudeEffort?: string },
  ) {
    const list = openSessionsByWt[wtPath];
    if (!list) return;
    const idx = list.findIndex((s) => s.source === source);
    if (idx === -1) return;
    const next = list.slice();
    next[idx] = {
      ...next[idx]!,
      ...(patch.claudeModel !== undefined
        ? { claudeModel: patch.claudeModel as PersistedSession["claudeModel"] }
        : {}),
      ...(patch.claudeEffort !== undefined
        ? {
            claudeEffort:
              patch.claudeEffort as PersistedSession["claudeEffort"],
          }
        : {}),
    };
    openSessionsByWt = { ...openSessionsByWt, [wtPath]: next };
    claudeColGen = {
      ...claudeColGen,
      [source]: (claudeColGen[source] ?? 0) + 1,
    };
  }

  /** Per-synthetic-source manual title (the saved value). Edit-buffer
   *  state + the editing/draft flags moved into NewSessionCol.svelte;
   *  this map is the persistence-facing side that survives column
   *  remounts and the flip to the real SessionView once the JSONL
   *  appears on disk. */
  let newSessionTitles: Record<string, string> = {};

  /** Update the local `newSessionTitles` map after NewSessionCol's
   *  ManualTitle component POSTed successfully. The POST itself lives
   *  inside ManualTitle.svelte; this callback just mirrors the
   *  server-confirmed value into the in-memory map so the prop
   *  binding re-renders the header, and triggers a /api/repos refresh
   *  so the worktree row reflects the title once its real JSONL takes
   *  over from the synthetic source. */
  function saveNewSessionTitle(source: string, next: string) {
    newSessionTitles = next
      ? { ...newSessionTitles, [source]: next }
      : (({ [source]: _, ...rest }) => rest)(newSessionTitles);
    void load();
  }

  /** Ask the daemon to rename a saved title's key from `oldSource` to
   *  `newSource`, and update `newSessionTitles` to match. Called on every
   *  source-flip a transient column can undergo: shell spawn (`__new__:shell:`
   *  → `__attached__:shell:`) and agent dispose (`__new__:<agent>:` → real
   *  JSONL path). Without it the user's typed title is silently orphaned
   *  the moment the column's source changes. */
  async function migrateSessionTitleOnServer(
    oldSource: string,
    newSource: string,
  ): Promise<void> {
    if (oldSource === newSource) return;
    const existing = newSessionTitles[oldSource];
    try {
      const res = await fetch(apiUrl("/api/session/title/migrate"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ oldSource, newSource }),
      });
      if (!res.ok) return;
      const next = { ...newSessionTitles };
      delete next[oldSource];
      if (existing && !next[newSource]) next[newSource] = existing;
      newSessionTitles = next;
    } catch {
      // best-effort
    }
  }

  /** Faster poll cadence while a freshly spawned agent TUI is discoverable.
   *  The agent may be in the short window between PTY spawn and the first
   *  JSONL/source showing up in `/api/repos`; polling full dashboard state
   *  helps promote the `__new__:` column quickly.
   *
   *  Crucially, this is tied to a live terminal id and a bounded discovery
   *  window. A persisted stale `__new__:` entry must not keep `/api/repos`
   *  hammering forever after its PTY has gone idle or disappeared. */
  const TRANSIENT_DISCOVERY_POLL_MS = 3_000;
  const TRANSIENT_DISCOVERY_WINDOW_MS = 30_000;
  let newSessionPollTimer: ReturnType<typeof setInterval> | null = null;
  let transientDiscoveryDeadlineMs: Record<string, number> = {};

  function markTransientDiscovery(source: string): void {
    if (!source.startsWith("__new__:")) return;
    if (source.startsWith("__new__:shell:")) return;
    transientDiscoveryDeadlineMs = {
      ...transientDiscoveryDeadlineMs,
      [source]: Date.now() + TRANSIENT_DISCOVERY_WINDOW_MS,
    };
  }

  function clearTransientDiscovery(source: string): void {
    if (!(source in transientDiscoveryDeadlineMs)) return;
    const next = { ...transientDiscoveryDeadlineMs };
    delete next[source];
    transientDiscoveryDeadlineMs = next;
  }

  function currentTransientDiscoverySources(): string[] {
    return transientDiscoverySources(openSessionsByWt, {
      newTermIds,
      liveTerminalIds,
      discoveryDeadlineMs: transientDiscoveryDeadlineMs,
      nowMs: Date.now(),
    });
  }

  $: hasTransientSessions = Object.values(openSessionsByWt).some((arr) =>
    arr.some((s) => s.source.startsWith("__new__:")),
  );
  $: hasTransientDiscoverySessions =
    currentTransientDiscoverySources().length > 0;
  $: if (hasTransientDiscoverySessions && !newSessionPollTimer) {
    newSessionPollTimer = setInterval(() => {
      if (currentTransientDiscoverySources().length === 0) {
        clearInterval(newSessionPollTimer!);
        newSessionPollTimer = null;
        return;
      }
      // Skip while idle/hidden — the user isn't looking and the
      // transient session will still be promoted on the next
      // wake-up load() (registered via onResume).
      if (isUiIdle()) return;
      void load("transient-discovery");
    }, TRANSIENT_DISCOVERY_POLL_MS);
  } else if (!hasTransientDiscoverySessions && newSessionPollTimer) {
    clearInterval(newSessionPollTimer);
    newSessionPollTimer = null;
  }

  $: void promoteTransientSessions(hasTransientSessions, repos);
  function promoteTransientSessions(hasTransient: boolean, repoList: Repo[]) {
    if (!hasTransient || repoList.length === 0) return;
    let promoted = false;
    let next = openSessionsByWt;
    for (const [wtPath, sessions] of Object.entries(next)) {
      for (const s of sessions) {
        if (!s.source.startsWith("__new__:") || !s.resumeSessionId) continue;
        for (const repo of repoList) {
          for (const wt of repo.worktrees ?? []) {
            if (wt.path !== wtPath) continue;
            const match = (wt.agents ?? []).find(
              (a: { agent: string; sessionId?: string; source: string }) =>
                a.agent === s.agent && a.sessionId === s.resumeSessionId,
            );
            if (!match) continue;
            const termId = newTermIds[s.source];
            next = {
              ...next,
              [wtPath]: next[wtPath]!.map((x) =>
                x.source === s.source
                  ? {
                      ...x,
                      source: match.source,
                      mode: "terminal" as const,
                      attachTermId: termId,
                    }
                  : x,
              ),
            };
            transientWorking = moveSessionStateKey(
              transientWorking,
              s.source,
              match.source,
            );
            transientAwaiting = moveSessionStateKey(
              transientAwaiting,
              s.source,
              match.source,
            );
            transientExited = moveSessionStateKey(
              transientExited,
              s.source,
              match.source,
            );
            transientFinishedAt = moveSessionStateKey(
              transientFinishedAt,
              s.source,
              match.source,
            );
            workingStartedAt = moveSessionStateKey(
              workingStartedAt,
              s.source,
              match.source,
            );
            clearTransientDiscovery(s.source);
            void migrateSessionTitleOnServer(s.source, match.source);
            promoted = true;
          }
        }
      }
    }
    if (promoted) openSessionsByWt = next;
  }

  // ----------------------------------------------------------------------
  // Background TUI stagger-spawn (offscreen-deferral regression #4, Part B)
  //
  // After a daemon restart the PTY helper dies with it, so every persisted
  // `mode:"terminal"` agent session loses its live PTY. Their columns stay
  // mounted (`.row-body` is `display:none`, not unmounted) but TerminalView
  // is deferred until the column scrolls into view — so the dock dot only
  // lights once the user reaches a column, which re-spawns `claude --resume`
  // on mount. To show live TUIs as active at startup, eagerly re-spawn those
  // PTYs in the background at a gentle cadence (NOT a thundering herd), then
  // stamp `attachTermId` so the already-mounted SessionView's hold socket
  // keeps each one alive and the dock dot flips active immediately.
  //
  // Selection (which sources still need a spawn) is the pure, unit-tested
  // `selectSessionsForBackgroundSpawn`; this owns the side effects: a
  // per-source in-flight guard (so we never double-spawn), the POST, and
  // the optimistic state stamp on success. Onscreen columns mount and spawn
  // themselves (their `onSpawn` sets attachTermId + marks the id live), so
  // the initial grace below lets those exclude themselves before we start —
  // avoiding a duplicate `claude --resume` for the same session.
  const BG_SPAWN_INTERVAL_MS = 400; // ~2.5 spawns/sec
  const BG_SPAWN_START_GRACE_MS = 1_500; // let onscreen columns mount first
  const BG_SPAWN_IDLE_STOP_TICKS = 6; // stop after this many empty ticks
  let bgSpawnTimer: ReturnType<typeof setInterval> | null = null;
  let bgSpawnStarted = false;
  let bgSpawnInFlight: Set<string> = new Set();
  let bgSpawnIdleTicks = 0;

  /** Kick off the staggered background spawner once, after the initial
   *  load. Idempotent — safe to call from every `load("mount")` resolve. */
  function ensureBackgroundTuiSpawn(): void {
    if (bgSpawnStarted) return;
    bgSpawnStarted = true;
    setTimeout(() => {
      if (bgSpawnTimer) return;
      bgSpawnTimer = setInterval(
        () => void spawnNextBackgroundTui(),
        BG_SPAWN_INTERVAL_MS,
      );
    }, BG_SPAWN_START_GRACE_MS);
  }

  function stopBackgroundTuiSpawn(): void {
    if (bgSpawnTimer) clearInterval(bgSpawnTimer);
    bgSpawnTimer = null;
  }

  function spawnNextBackgroundTui(): void {
    const candidates = selectSessionsForBackgroundSpawn(openSessionsByWt, {
      liveTerminalIds,
      inFlight: bgSpawnInFlight,
      newTermIds,
    });
    if (candidates.length === 0) {
      // Drain finished (and nothing landing) → stop the timer. A later
      // reload's `ensureBackgroundTuiSpawn` is gated by `bgSpawnStarted`,
      // so this only stops the one startup pass.
      if (++bgSpawnIdleTicks >= BG_SPAWN_IDLE_STOP_TICKS && !bgSpawnInFlight.size)
        stopBackgroundTuiSpawn();
      return;
    }
    bgSpawnIdleTicks = 0;
    void spawnBackgroundTui(candidates[0]!);
  }

  async function spawnBackgroundTui(
    c: BackgroundSpawnCandidate,
  ): Promise<void> {
    bgSpawnInFlight = new Set(bgSpawnInFlight).add(c.source);
    try {
      const cmd =
        c.agent === "codex"
          ? ["codex", "resume", c.resumeSessionId]
          : [
              "claude",
              "--resume",
              c.resumeSessionId,
              "--allow-dangerously-skip-permissions",
              ...(c.claudeModel ? ["--model", c.claudeModel] : []),
              ...(c.claudeEffort ? ["--effort", c.claudeEffort] : []),
            ];
      const daemonId = daemonIdForWorktreePath(repos, c.wtPath);
      const res = await fetch(apiUrl("/api/terminals", daemonId), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          cmd,
          cwd: c.wtPath,
          // Floor size; SessionView's TerminalView re-fits once it mounts.
          cols: 80,
          rows: 24,
          ownerId: c.resumeSessionId,
          procName: `supergit-tui-${c.resumeSessionId.slice(0, 8)}-${c.agent}`,
        }),
      });
      if (!res.ok) return;
      const body = (await res.json().catch(() => null)) as {
        id?: string;
      } | null;
      const id = body?.id;
      if (typeof id !== "string") return;
      // Stamp the live PTY onto the session so (a) the dock dot reads active
      // via the liveTerminalIds path and (b) the mounted SessionView's hold
      // socket reattaches to this PTY instead of spawning a duplicate.
      markTerminalLive(id);
      newTermIds = { ...newTermIds, [c.source]: id };
      const list = openSessionsByWt[c.wtPath];
      if (list) {
        openSessionsByWt = {
          ...openSessionsByWt,
          [c.wtPath]: list.map((s) =>
            s.source === c.source
              ? { ...s, mode: "terminal" as const, attachTermId: id }
              : s,
          ),
        };
      }
    } catch {
      // best-effort — the candidate is reconsidered on the next tick
      // (still in `inFlight` until the finally clears it).
    } finally {
      const next = new Set(bgSpawnInFlight);
      next.delete(c.source);
      bgSpawnInFlight = next;
    }
  }

  // ----------------------------------------------------------------------
  // Active-worktree priority refresh poll (dirty-state starvation fix)
  //
  // With many repos open, chatty background repos (dev servers firing fs_change)
  // saturate the daemon's shared git limiter, so a quiet repo's dirty badge can
  // lag ~30s. The daemon now (a) coalesces per-worktree recomputes so the herd
  // can't monopolize the limiter, and (b) exposes /api/worktree-details on a
  // dedicated priority lane. This poll hits that lane every few seconds for the
  // worktree the user is actually in, so its dirty/ahead state stays live
  // regardless of how busy everything else is. The daemon recompute broadcasts
  // an fs_change, which the existing SSE handler folds into the dashboard.
  const ACTIVE_WT_POLL_MS = 5_000;
  let activeWtPollTimer: ReturnType<typeof setInterval> | null = null;
  function startActiveWorktreePoll(): void {
    if (activeWtPollTimer) return;
    activeWtPollTimer = setInterval(() => {
      const wt = activeWorktreePath;
      if (!wt || isUiIdle()) return;
      void fetch(
        apiUrl(
          `/api/worktree-details?path=${encodeURIComponent(wt)}`,
          daemonIdForWorktreePath(repos, wt),
        ),
      ).catch(() => {});
    }, ACTIVE_WT_POLL_MS);
  }
  function stopActiveWorktreePoll(): void {
    if (activeWtPollTimer) clearInterval(activeWtPollTimer);
    activeWtPollTimer = null;
  }

  function repoName(repo: Repo): string {
    return (
      (repo as { name?: string }).name ??
      repo.path.split("/").filter(Boolean).pop() ??
      repo.path
    );
  }

  /** Smooth-scroll the dashboard to the row representing this worktree
   *  and pulse it briefly so the user can locate it. */
  function jumpToWorktreeRow(path: string) {
    const sel = `[data-wt-row="${CSS.escape(path)}"]`;
    const el = document.querySelector<HTMLElement>(sel);
    if (!el) return;
    el.scrollIntoView({ behavior: "smooth", block: "center" });
    el.classList.add("wt-row-pulse");
    setTimeout(() => el.classList.remove("wt-row-pulse"), 1200);
  }
  let newWtBranch: Record<string, string> = {};
  let newWtBusy: Record<string, boolean> = {};

  async function createWorktree(repoId: string, originPath?: string | null) {
    const branch = (newWtBranch[repoId] ?? "").trim();
    if (!branch) return;
    error = "";
    newWtBusy = { ...newWtBusy, [repoId]: true };
    try {
      const res = await fetch(
        apiUrl(
          `/api/repos/${repoId}/worktrees`,
          daemonIdForRepoId(repos, repoId),
        ),
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ branch }),
        },
      );
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      const body = (await res.json().catch(() => ({}))) as {
        branch?: string;
        path?: string;
        created?: boolean;
      };
      // Tell the user whether we created a fresh branch or reused an
      // existing one. (Daemon's createWorktree now auto-detects.)
      addToast({
        kind: "success",
        title: body.created
          ? "Worktree created."
          : "Worktree for existing branch.",
        message: body.created
          ? `New branch \`${body.branch ?? branch}\` and worktree at ${body.path ?? ""}`
          : `Checked out existing \`${body.branch ?? branch}\` into ${body.path ?? ""}`,
      });
      const repo = repos.find((r) => r.id === repoId);
      if (repo && body.path) {
        visibleWorktreesByRepo = showVisibleWorktree(
          repoPrefsKey(repo),
          [...repo.worktrees.map((w) => w.path), body.path],
          visibleWorktreesByRepo,
          body.path,
          originPath,
        );
      }
      newWtBranch = { ...newWtBranch, [repoId]: "" };
      newWtOpen = { ...newWtOpen, [repoId]: false };
      await load();
      if (body.path) {
        await tick();
        jumpToWorktreeRow(body.path);
      }
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      newWtBusy = { ...newWtBusy, [repoId]: false };
    }
  }

  // Live activity stream keyed by the agent's cwd (≈ worktree path).
  // Capped to MAX_ACTIVITY entries per cwd; newest first.
  const MAX_ACTIVITY = 8;
  let activityByCwd: Record<string, ActivityEvent[]> = {};

  // Sessions live anchored to their worktree (so the connection to the
  // repo stays visually obvious) but can be opened side-by-side as a
  // horizontal strip below the row.
  interface OpenSession {
    /** Includes `"shell"` for plain-terminal columns (no JSONL transcript;
     *  the daemon spawns the user's $SHELL as a PTY). */
    agent: AgentSession["agent"] | "shell" | "files" | "history";
    source: string;
    /** Optional. Stamped on `__new__:claude:` / `__new__:codex:` columns
     *  by the activity-SSE handler once the daemon surfaces a real
     *  agent-side session id for this (cwd, agent). Survives reload via
     *  `OpenSessionsStore`. On remount, `cmdForOpenSession` uses it to
     *  spawn `claude --resume <sid>` instead of bare `claude`. */
    resumeSessionId?: string;
    /** Provider id as reported by picker/search rows before the entry is
     *  normalized into open-session state. Copied to resumeSessionId for
     *  Claude/Codex so remembered terminal surfaces can actually resume. */
    sessionId?: string;
    /** Optional. UUID generated when this column was opened via the
     *  "+ new session" button, passed as `claude --session-id <uuid>`
     *  on spawn to force a fresh conversation. Once `resumeSessionId`
     *  is stamped (the activity tail surfaced the real agent-side id —
     *  same UUID, just observed via JSONL) the resume path takes
     *  over. Claude-only; codex has no equivalent flag. */
    preassignedSessionId?: string;
    /** Optional. `"terminal"` means SessionView should hydrate into live
     *  terminal output on remount. This is process state, not the
     *  visual-vs-terminal transcript display preference. Absent ⇒ stopped
     *  transcript/read mode. */
    mode?: "terminal";
    /** Optional. For ollama columns: the model tag picked at spawn
     *  time (e.g. `qwen3-coder:30b`). Persisted so a reload re-spawns
     *  `ollama run <model>`, and surfaced in the agent pill. */
    ollamaModel?: string;
    /** Optional. For live native app sessions, `source` is synthetic
     *  and this is the provider transcript path for stopped/history
     *  rendering and file-oriented actions. */
    transcriptSource?: string;
    /** Absolute path to the context handoff file written by the daemon.
     *  Claude gets `--append-system-prompt-file <path>`, Codex gets it
     *  as a positional prompt reference. Ephemeral — not persisted. */
    contextFilePath?: string;
    /** Daemon-side PTY id to reattach to when a `__new__:` column
     *  migrates to SessionView mid-flight. Set during the source swap
     *  so SessionView reattaches instead of spawning a duplicate. */
    attachTermId?: string;
    /** UI-only key that keeps a mounted column alive when its persisted
     *  source is canonicalized (e.g. shell `__new__` → `__attached__`). */
    renderKey?: string;
    /** Explicit shell command for a plain terminal column, stamped by
     *  openNewTerminalInWt when the box offered >1 shell (Windows:
     *  PowerShell vs CMD). cmdForOpenSession prefers it over the
     *  daemon's default shell. */
    shellCmd?: string[];
  }
  let openSessionsByWt: Record<string, OpenSession[]> = {};

  /** The user's default login shell + args, fetched once on mount from
   *  /api/shell-default. The daemon resolves $SHELL / COMSPEC with
   *  platform-appropriate flags so the UI doesn't need to know about
   *  powershell vs zsh vs cmd. */
  let defaultShell: string = navigator.platform?.startsWith("Win")
    ? "powershell.exe"
    : "/bin/zsh";
  let defaultShellArgs: string[] = navigator.platform?.startsWith("Win")
    ? ["-NoLogo"]
    : ["-l"];

  /** Rewrite a picker-supplied OpenSession when needed. Ollama sessions
   *  surface from `/api/agents` with `source` set to the JSONL header
   *  path under `<workspace>/ollama/`; opening one directly would land
   *  it in the SessionView render branch (which only parses Claude/
   *  Codex JSONLs and would render blank). Translate to a
   *  `__transcript__:ollama:<termId>` source — that's the shape
   *  OllamaTranscriptView mounts on — and stash the model from the
   *  matching AgentSession so the read-only view knows what to label
   *  the pill and what to Resume into. */
  function toggleOpenSessionInWt(wtPath: string, s: OpenSession): void {
    s = normalizeSessionForOpen(wtPath, s, repos);
    s = applySessionSurfacePreference(s, sessionSurfaces);
    const list = openSessionsByWt[wtPath] ?? [];
    const i = list.findIndex((x) => x.source === s.source);
    if (i >= 0) {
      // Already open — close it. Same dismiss semantics as ×.
      dismissIfShell(s);
      openSessionsByWt = {
        ...openSessionsByWt,
        [wtPath]: [...list.slice(0, i), ...list.slice(i + 1)],
      };
      return;
    }
    // Opening (or re-opening) — undo any prior dismissal so the column
    // sticks across the next reload.
    if (s.agent === "shell") undismissShellSource(s.source);

    // Opening a new session: insert it just left of the column the user is
    // currently looking at, so it appears on the left of their *visible*
    // strip (not just the array order). Then smooth-scroll so the new
    // column sits at the viewport's left edge.
    const insertAt = visibleLeftInsertIndex(wtPath, list);
    const next = [...list];
    next.splice(insertAt, 0, s);
    openSessionsByWt = { ...openSessionsByWt, [wtPath]: next };
    scrollNewColIntoView(wtPath, s.source);
  }

  function sessionSurfaceForPicker(
    s: AgentSession,
  ): SessionSurface | undefined {
    if (s.agent !== "claude" && s.agent !== "codex") return undefined;
    const subject: {
      agent: "claude" | "codex";
      source: string;
      sessionId?: string;
      mode?: "terminal";
    } = {
      agent: s.agent,
      source: s.source,
      sessionId: s.sessionId,
    };
    const normalized = applySessionSurfacePreference(subject, sessionSurfaces);
    const surface = sessionSurfacePreference(normalized, sessionSurfaces);
    return surface === "terminal" ? "terminal" : undefined;
  }

  function isSessionOpenInWt(
    wtPath: string,
    s: Pick<
      OpenSession,
      "agent" | "source" | "resumeSessionId" | "transcriptSource"
    > & { sessionId?: string },
  ): boolean {
    const keys = new Set(sessionSurfaceKeys(s));
    return (openSessionsByWt[wtPath] ?? []).some((open) =>
      sessionMatchesKnownKeys(open, keys),
    );
  }

  /** Mark a shell column as user-dismissed so `restoreLiveShells` won't
   *  re-add it on the next page load. Handles both the synthetic
   *  `__new__:` and the termId-based `__attached__:` forms: if the user
   *  × a fresh column, we also dismiss the attached-form (looked up via
   *  newTermIds) so the live PTY's own listing entry stays away.
   *
   *  Decision logic lives in `shellSourceToDismiss` (session-source-routing.ts);
   *  this wrapper owns the side effect (updating dismissedShells + persisting). */
  function dismissIfShell(s: OpenSession): void {
    if (s.agent !== "shell") return;
    const src = shellSourceToDismiss(s.source, newTermIds);
    if (src) dismissShellSource(src);
  }

  function closeSessionInWt(wtPath: string, s: OpenSession): void {
    // X-ing a column with a live PTY (resolveTermId returns a termId
    // for `__new__:` and `__attached__:` sources) feels like
    // "stopping" the session to the user — play the stop sound. The
    // swoosh stays for read-only transcript columns and other
    // already-dead sessions.
    play(resolveTermId(s, newTermIds) ? "session-stop" : "session-close");
    dismissIfShell(s);
    for (const [linkId, entry] of commandTermSources) {
      if (entry.source === s.source) {
        commandTermSources.delete(linkId);
        persistCommandTermSources();
        if (runningCommandIds.has(linkId)) {
          const next = new Set(runningCommandIds);
          next.delete(linkId);
          runningCommandIds = next;
        }
        break;
      }
    }
    openSessionsByWt = {
      ...openSessionsByWt,
      [wtPath]: (openSessionsByWt[wtPath] ?? []).filter(
        (x) => x.source !== s.source,
      ),
    };
    clearTransientDiscovery(s.source);
    if (focusedSource === s.source) focusedSource = null;
    if (ollamaSourcePathOverride[s.source]) {
      const next = { ...ollamaSourcePathOverride };
      delete next[s.source];
      ollamaSourcePathOverride = next;
    }
  }

  // Drag-to-reorder for sessions inside one worktree's strip. We don't
  // (yet) move sessions between worktrees — that's a bigger UX choice.
  let dragSource: { wtPath: string; index: number } | null = null;
  /** Live drop preview — drives the dashed insertion-line on the
   *  hovered column. `side: "left"` means the dragged column will
   *  land BEFORE this column; `"right"` means AFTER. Cleared on
   *  drop, dragend, and dragleave-from-strip. */
  let dragOverTarget: {
    wtPath: string;
    index: number;
    side: "left" | "right";
  } | null = null;

  function sessionDragLinkTarget(
    wtPath: string,
    index: number,
  ): {
    type: "session";
    value: string;
    label: string;
    agent?: string;
    subtitle?: string;
    meta?: string;
  } | null {
    const session = openSessionsByWt[wtPath]?.[index];
    if (!session || session.agent === "files" || session.agent === "history") {
      return null;
    }
    let label = "(session)";
    let agent = session.agent;
    let subtitle = "";
    let meta = "";
    const row = rows.find((r) => r.wt?.path === wtPath);
    const found = row?.wt?.agents?.find((a) => a.source === session.source);
    if (found) {
      agent = found.agent;
      label =
        found.manualTitle?.trim() ||
        found.aiTitle?.trim() ||
        found.title?.trim() ||
        found.firstUserMessage?.trim() ||
        (found.sessionId ? `session ${found.sessionId.slice(0, 8)}` : label);
      subtitle = found.messageCount ? `${found.messageCount} msg` : "";
      meta = relativeAge(found.lastActive);
    }
    // Store the session id, not the source path. The path moves when a
    // worktree/repo is renamed or relocated; the id baked into the
    // JSONL filename is stable, so a note linking the session keeps
    // resolving after the move. StickyNote re-resolves the id back to
    // the current live source when the chip is clicked.
    return {
      type: "session",
      value: found?.sessionId || sessionIdFromValue(session.source),
      label,
      ...(agent ? { agent } : {}),
      ...(subtitle ? { subtitle } : {}),
      ...(meta ? { meta } : {}),
    };
  }

  function handleSessionDragStart(
    e: DragEvent,
    wtPath: string,
    index: number,
  ): void {
    dragSource = { wtPath, index };
    if (e.dataTransfer) {
      e.dataTransfer.effectAllowed = "copyMove";
      // Must set some data for Firefox to honour the drag.
      e.dataTransfer.setData("text/plain", `${wtPath}|${index}`);
      const target = sessionDragLinkTarget(wtPath, index);
      if (target) {
        e.dataTransfer.setData(
          LINK_TARGET_DRAG_MIME,
          JSON.stringify({ target }),
        );
        e.dataTransfer.setData(
          SESSION_LINK_DRAG_MIME,
          JSON.stringify({ target }),
        );
      }
    }
  }

  /** Called on dragover of a `.session-col`. Computes which side of
   *  the hovered column the cursor sits on so the dashed preview
   *  line lands on that edge — and so the drop math knows whether
   *  the user is aiming BEFORE or AFTER the target column. */
  function handleSessionDragOver(
    e: DragEvent,
    wtPath: string,
    index: number,
  ): void {
    if (!dragSource || dragSource.wtPath !== wtPath) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
    const el = e.currentTarget as HTMLElement | null;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const side: "left" | "right" =
      e.clientX < r.left + r.width / 2 ? "left" : "right";
    if (
      !dragOverTarget ||
      dragOverTarget.wtPath !== wtPath ||
      dragOverTarget.index !== index ||
      dragOverTarget.side !== side
    ) {
      dragOverTarget = { wtPath, index, side };
    }
  }

  /** Strip-level dragleave so the dashed preview disappears only
   *  when the cursor leaves the whole strip, not on per-column
   *  dragleaves (which fire as the cursor crosses between
   *  neighbouring columns). */
  function handleStripDragLeave(e: DragEvent, wtPath: string): void {
    if (!dragOverTarget || dragOverTarget.wtPath !== wtPath) return;
    const strip = e.currentTarget as HTMLElement | null;
    const rel = e.relatedTarget as Node | null;
    if (strip && rel && strip.contains(rel)) return;
    dragOverTarget = null;
  }

  function handleSessionDragEnd(): void {
    dragSource = null;
    dragOverTarget = null;
  }

  function handleSessionDrop(
    e: DragEvent,
    wtPath: string,
    targetIndex: number,
  ): void {
    e.preventDefault();
    const src = dragSource;
    const hover = dragOverTarget;
    dragSource = null;
    dragOverTarget = null;
    if (!src || src.wtPath !== wtPath) return;
    // Translate "drop on column N, left/right half" into an
    // insertion index. Without this the drop always lands AT the
    // target column's index — surprising when the user aimed for
    // the gap on the other side.
    let insertAt = targetIndex;
    if (hover && hover.wtPath === wtPath && hover.index === targetIndex) {
      insertAt = hover.side === "right" ? targetIndex + 1 : targetIndex;
    }
    // Splicing the source out shifts everything after src.index down
    // by one, so adjust the post-source insertion index accordingly.
    if (insertAt > src.index) insertAt--;
    if (insertAt === src.index) return;
    const list = openSessionsByWt[wtPath] ?? [];
    const item = list[src.index];
    if (!item) return;
    const next = [...list];
    next.splice(src.index, 1);
    next.splice(insertAt, 0, item);
    openSessionsByWt = { ...openSessionsByWt, [wtPath]: next };
  }

  // Source-control state per worktree moved into SourceControlPane.svelte
  // (Phase 2 of the App.svelte refactor). The only piece that stays here
  // is `commitsExpanded`, since it persists to localStorage.
  let commitsExpanded: Record<string, boolean> = {};
  /** Bumped per-worktree by the SSE handler when the daemon's FS watcher
   *  broadcasts a `fs_change` event. SourceControlPane reads this as a
   *  prop and refetches its cached diff when the value increments. */
  let fsChangeKey: Record<string, number> = {};

  /** Bumped every time the daemon broadcasts a note_create / note_update
   *  / note_delete SSE event. Passed to <StickyNotesLayer> so it
   *  refetches /api/notes — picks up notes created in another tab or
   *  edited by hand on disk. */
  let notesChangeKey = 0;

  const expandedStore = new ExpandedStore(
    getDaemonKV(),
    "supergit:commitsExpanded",
  );
  const dismissedSessionsStore = new DismissedSessionsStore(
    getDaemonKV(),
    "supergit:dismissedSessions",
  );
  /** Sources the user has dismissed from session pickers. Mutated via
   *  `dismissSession` / `restoreSession` — both reassign a new Set so
   *  Svelte triggers reactivity and the persisted JSON stays in sync. */
  let dismissedSessions: Set<string> = dismissedSessionsStore.load();
  function dismissSession(source: string): void {
    if (dismissedSessions.has(source)) return;
    const next = new Set(dismissedSessions);
    next.add(source);
    dismissedSessions = next;
    dismissedSessionsStore.save(next);
  }
  function restoreSession(source: string): void {
    if (!dismissedSessions.has(source)) return;
    const next = new Set(dismissedSessions);
    next.delete(source);
    dismissedSessions = next;
    dismissedSessionsStore.save(next);
  }
  const starredSessionsStore = new StarredSessionsStore(
    getDaemonKV(),
    "supergit:starredSessions",
  );
  let starredSessions: Set<string> = starredSessionsStore.load();
  function toggleStarSession(source: string): void {
    const next = new Set(starredSessions);
    if (next.has(source)) next.delete(source);
    else next.add(source);
    starredSessions = next;
    starredSessionsStore.save(next);
  }
  const openSessionsPersistence = new OpenSessionsStore(
    getDaemonKV(),
    "supergit:openSessions",
  );
  const sessionSurfaceStore = new SessionSurfaceStore(
    getDaemonKV(),
    "supergit:sessionSurfaces",
  );
  let sessionSurfaces: Record<string, SessionSurface> =
    sessionSurfaceStore.load();
  function rememberSessionSurface(
    s: OpenSession,
    surface: SessionSurface,
  ): void {
    const keys = sessionSurfaceKeys(s);
    if (keys.length === 0) return;
    const next = { ...sessionSurfaces };
    for (const key of keys) next[key] = surface;
    sessionSurfaces = next;
    sessionSurfaceStore.save(next);
  }

  function transcriptSurfaceForSession(s: OpenSession): SessionSurface {
    return sessionSurfacePreference(s, sessionSurfaces);
  }

  function isExplicitVisualSurface(s: OpenSession): boolean {
    return rememberedSessionSurface(s, sessionSurfaces) === "read";
  }

  function resumeCodexVisualSession(
    wtPath: string,
    s: OpenSession,
    sessionId: string | undefined,
    transcriptSource: string | undefined,
  ): void {
    const sid = sessionId ?? s.resumeSessionId;
    if (s.agent !== "codex" || !sid) return;
    const liveSource = codexAppSource(sid);
    const nextEntry: OpenSession = {
      ...s,
      source: liveSource,
      resumeSessionId: sid,
      transcriptSource: transcriptSource ?? s.transcriptSource ?? s.source,
    };
    delete nextEntry.mode;
    rememberSessionSurface(nextEntry, "read");
    const existing = openSessionsByWt[wtPath] ?? [];
    openSessionsByWt = {
      ...openSessionsByWt,
      [wtPath]: existing.map((x) => (x.source === s.source ? nextEntry : x)),
    };
    scrollNewColIntoView(wtPath, liveSource);
  }

  function stopCodexVisualSession(
    wtPath: string,
    s: OpenSession,
    transcriptSource: string | undefined,
  ): void {
    const source = transcriptSource ?? s.transcriptSource;
    if (s.agent !== "codex" || !source || source.startsWith("__codex_app__:")) {
      return;
    }
    const nextEntry: OpenSession = {
      ...s,
      source,
      transcriptSource: undefined,
    };
    delete nextEntry.mode;
    rememberSessionSurface(nextEntry, "read");
    const existing = openSessionsByWt[wtPath] ?? [];
    openSessionsByWt = {
      ...openSessionsByWt,
      [wtPath]: existing.map((x) => (x.source === s.source ? nextEntry : x)),
    };
    transientWorking = { ...transientWorking, [s.source]: false };
    transientAwaiting = { ...transientAwaiting, [s.source]: false };
    clearFinishedFor(s.source);
    scrollNewColIntoView(wtPath, source);
  }
  const visibleWorktreesPersistence = new VisibleWorktreesStore(
    getDaemonKV(),
    "supergit:visibleWorktrees",
  );
  let visibleWorktreesByRepo: Record<string, string[]> = {};
  let visibleHydrated = false;

  // Per-row "fold this worktree row to a minimal one-line format". Keyed
  // by row.key (`${repo.id}|${wt.path}`) so each worktree of a multi-
  // worktree repo can be folded independently. Persisted in localStorage
  // so a folded row stays folded across reloads. Reuses ExpandedStore —
  // it's just a Set<string>.
  // Storage key was renamed from `foldedRepos` (repo-keyed) so stale
  // repo-id entries don't accidentally collapse rows on first load.
  const foldedRowsStore = new ExpandedStore(
    getDaemonKV(),
    "supergit:foldedRows",
  );
  let rowFolded: Record<string, boolean> = {};
  let foldedHydrated = false;
  /** Per-row latch: true once a row's session columns have been
   *  shown with real layout at least once this page load. Drives the
   *  first-unfold scroll-to-bottom in toggleRowFolded — rows that
   *  started expanded already had their SessionView mount-time scroll
   *  work, rows that started folded got `clientHeight = 0` and need
   *  a re-scroll on first unfold. Subsequent fold/unfold cycles
   *  preserve whatever scroll position the user left. */
  let rowHasBeenShown: Record<string, boolean> = {};
  let initialShownDone = false;
  /** Wall-clock tick (ms). Bumped every 3s in onMount. Used by the
   *  folded-row activity indicator to re-evaluate "any agent in this
   *  worktree had output in the last 10s?" without needing the daemon
   *  to push a discrete "still active" signal. */
  let nowMs = Date.now();
  // Don't persist until the initial restore has run, otherwise the first
  // reactive write wipes saved state with our empty starting value.
  let sessionsHydrated = false;

  function restoreExpanded() {
    const paths = expandedStore.load();
    if (paths.size === 0) return;
    const next: Record<string, boolean> = {};
    for (const p of paths) next[p] = true;
    commitsExpanded = next;
  }
  function persistExpanded() {
    const paths = Object.entries(commitsExpanded)
      .filter(([, v]) => v)
      .map(([k]) => k);
    expandedStore.save(paths);
  }

  function restoreOpenSessions() {
    openSessionsByWt = reconcileOpenSessionsWithSurfacePreferences(
      openSessionsPersistence.load(),
      sessionSurfaces,
    );
    let seeded = false;
    const nextSurfaces = { ...sessionSurfaces };
    for (const sessions of Object.values(openSessionsByWt)) {
      for (const s of sessions) {
        if (s.mode !== "terminal") continue;
        for (const key of sessionSurfaceKeys(s)) {
          if (nextSurfaces[key]) continue;
          nextSurfaces[key] = "terminal";
          seeded = true;
        }
      }
    }
    if (seeded) {
      sessionSurfaces = nextSurfaces;
      sessionSurfaceStore.save(nextSurfaces);
    }
    sessionsHydrated = true;
  }
  $: if (sessionsHydrated) openSessionsPersistence.save(openSessionsByWt);

  function restoreVisibleWorktrees() {
    visibleWorktreesByRepo = visibleWorktreesPersistence.load();
    visibleHydrated = true;
  }
  $: if (visibleHydrated)
    visibleWorktreesPersistence.save(visibleWorktreesByRepo);

  function restoreFoldedRepos() {
    const keys = foldedRowsStore.load();
    if (keys.size > 0) {
      const next: Record<string, boolean> = {};
      for (const k of keys) next[k] = true;
      rowFolded = next;
    }
    foldedHydrated = true;
  }
  $: if (foldedHydrated) {
    foldedRowsStore.save(
      Object.entries(rowFolded)
        .filter(([, v]) => v)
        .map(([k]) => k),
    );
  }
  /** Once hydration + the first `rows` snapshot are both in hand,
   *  seed rowHasBeenShown for rows that are already unfolded:
   *  SessionView's mount-time scroll-to-bottom worked for those, so
   *  later fold→unfold toggles should preserve whatever scroll
   *  position the user left. Rows that were folded at load time
   *  stay un-marked, so their first unfold triggers a scroll-to-
   *  bottom. One-shot via `initialShownDone`. */
  $: if (foldedHydrated && rows.length > 0 && !initialShownDone) {
    const next = { ...rowHasBeenShown };
    for (const row of rows) {
      if (!rowFolded[row.key]) next[row.key] = true;
    }
    rowHasBeenShown = next;
    initialShownDone = true;
  }
  function toggleRowFolded(rowKey: string, wtPath?: string | null) {
    const wasFolded = !!rowFolded[rowKey];
    rowFolded = { ...rowFolded, [rowKey]: !wasFolded };
    // First-time unfold of a row that started folded at page load:
    // any session columns inside it mounted with `display: none`, so
    // their initial scroll-to-bottom ran against `clientHeight = 0`
    // and parked at the top. Force-stick each .messages to the bottom
    // now that the row has real layout. Subsequent
    // toggles see rowHasBeenShown = true and leave scroll alone.
    if (wasFolded && wtPath && !rowHasBeenShown[rowKey]) {
      rowHasBeenShown = { ...rowHasBeenShown, [rowKey]: true };
      void stickAllSessionsInWtToBottom(wtPath);
    }
  }
  /** Auto-expand a folded row. Called from any session-opening
   *  affordance (new agent, new terminal, latest-session button,
   *  picker entries) so the resulting session column has room to
   *  render instead of being hidden behind the folded chrome.
   *  No-op if the row is already expanded. */
  function unfoldRowIfFolded(rowKey: string) {
    if (rowFolded[rowKey]) {
      rowFolded = { ...rowFolded, [rowKey]: false };
    }
  }
  /** Apply a plan from `planReveal()`: drives the imperative helpers
   *  off the boolean fields. The decision matrix itself lives in
   *  `./reveal-session` so it's unit-testable. `toggleOpenSessionInWt`
   *  handles both directions, so when the plan asks for either `open`
   *  or `close` we call it; pre-state guards in `planReveal` ensure we
   *  never ask for a no-op direction. */
  function applyRevealPlan(
    rowKey: string,
    wtPath: string,
    s: OpenSession,
    mode: RevealMode,
  ): void {
    const plan = planReveal({
      rowFolded: !!rowFolded[rowKey],
      isOpen: isSessionOpenInWt(wtPath, s),
      mode,
    });
    if (plan.unfold) {
      unfoldRowIfFolded(rowKey);
      // Reveal-from-folded counts as the row's first showing — mark it
      // so later chevron-toggle fold/unfold cycles preserve the user's
      // scroll position instead of re-snapping every session to the
      // bottom. scrollToAndFlashSession below handles the *clicked*
      // column's scroll; this latch covers any sibling columns the
      // user later reveals via toggle.
      if (!rowHasBeenShown[rowKey]) {
        rowHasBeenShown = { ...rowHasBeenShown, [rowKey]: true };
      }
    }
    if (plan.open || plan.close) toggleOpenSessionInWt(wtPath, s);
    if (plan.scrollAndFlash) void scrollToAndFlashSession(wtPath, s.source);
  }
  /** Click handler for picker entries. Folded rows: never close on
   *  first click (the user can't see what's open); expanded rows:
   *  classic toggle. */
  function revealOrToggleSession(
    rowKey: string,
    wtPath: string,
    s: OpenSession,
  ): void {
    applyRevealPlan(rowKey, wtPath, s, "reveal-or-toggle");
  }
  /** Click handler for the row-head "most recent session" badge. Never
   *  closes the session — always brings it into view. The `×` on the
   *  session column is the only path to close it; the badge is a
   *  one-way "show me this" affordance. */
  function revealSession(rowKey: string, wtPath: string, s: OpenSession): void {
    applyRevealPlan(
      rowKey,
      wtPath,
      normalizeSessionForOpen(wtPath, s, repos),
      "reveal",
    );
  }

  /** Dock click handler. The scroll-and-flash path silently returns
   *  when its `[data-wt-strip]` / `.session-col` queries miss, so we
   *  first force-clear every condition that could hide the target
   *  row from the DOM (hidden worktree, zen-mask on another row, a
   *  folded row — the existing reveal plan already handles folded).
   *  Then we attempt the reveal.
   *
   *  If the column STILL can't be located after a tick, the dock
   *  entry is pointing at something the rest of the UI can't render.
   *  We only treat that as "stale, clean up" when the daemon is
   *  reachable AND confirms the source/worktree is gone — an
   *  unreachable daemon could just be a restart in progress and
   *  must not trigger any state mutation. */
  async function onDockPick(entry: {
    rowKey: string;
    wtPath: string;
    agent: OpenSession["agent"];
    source: string;
    repoId: string;
    title?: string;
    manualTitle?: string;
  }): Promise<void> {
    const repo = repos.find((r) => r.id === entry.repoId);
    if (repo) {
      const diskPaths = (repo.worktrees ?? []).map((w) => w.path);
      const visible = effectiveVisibleWorktrees(
        repoPrefsKey(repo),
        diskPaths,
        visibleWorktreesByRepo,
      );
      if (!visible.includes(entry.wtPath)) {
        // Worktree row is hidden from the dashboard — the strip
        // element won't exist in the DOM until we restore it.
        visibleWorktreesByRepo = {
          ...visibleWorktreesByRepo,
          [repoPrefsKey(repo)]: [...visible, entry.wtPath],
        };
      }
    }
    if (zenRowKey && zenRowKey !== entry.rowKey) {
      zenRowKey = entry.rowKey;
      notesShownInZen = false;
    }
    revealSession(entry.rowKey, entry.wtPath, {
      agent: entry.agent,
      source: entry.source,
    });
    startReadGrace(entry.source);
    focusedSource = entry.source;
    requestComposerFocus(entry.source);

    // After one Svelte flush + a paint, check whether the column
    // actually landed in the DOM. If not, warn the user, but never
    // mutate openSessionsByWt from this automatic verification path:
    // a render/filtering regression must not become persisted layout
    // data loss.
    await tick();
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => resolve()),
    );
    const stripEl = document.querySelector(
      `[data-wt-strip="${CSS.escape(entry.wtPath)}"]`,
    );
    const colEl = stripEl?.querySelector(
      `.session-col[data-session-source="${CSS.escape(entry.source)}"]`,
    );
    if (colEl) return;
    if (!dockEntryExistsInLoadedRepos(repos, entry)) {
      const label = entry.manualTitle ?? entry.title ?? "this session";
      addToast({
        kind: "warning",
        title: "Session could not be revealed",
        message: `${label} did not render, but it was left open so your layout is preserved.`,
      });
    }
  }
  /** Duration (ms) of the dock-pick scroll animations — short and
   *  snappy, versus the browser's sluggish native smooth-scroll. */
  const DOCK_SCROLL_MS = 220;
  /** After unfold (and any state mutation), wait for Svelte to flush
   *  DOM + one rAF for `.row-body` to flip from `display:none` to
   *  laid-out, then scroll the strip so the target column is horizontally
   *  *centered* in the visible strip (the user reads its messages in the
   *  middle, not pushed against the left edge). When the column is wider
   *  than the strip we fall back to aligning its left edge inside the
   *  leading pad so the start of the column is still on screen.
   *  Also adds `.session-col-flash` for ~2s so the eye lands on it.
   *
   *  Uses bounding-rect math (not `col.offsetLeft`) because the column's
   *  offsetParent isn't reliably the strip — the row's positioned
   *  ancestors threw offsets off by ~50–100px and parked the leftmost
   *  column under the viewport edge. */
  async function scrollToAndFlashSession(
    wtPath: string,
    source: string,
  ): Promise<void> {
    await tick();
    requestAnimationFrame(() => {
      const strip = document.querySelector(
        `[data-wt-strip="${CSS.escape(wtPath)}"]`,
      ) as HTMLElement | null;
      if (!strip) return;
      const col = strip.querySelector<HTMLElement>(
        `.session-col[data-session-source="${CSS.escape(source)}"]`,
      );
      if (!col) return;
      const stripRect = strip.getBoundingClientRect();
      const colRect = col.getBoundingClientRect();
      const colOffsetInStrip =
        strip.scrollLeft + (colRect.left - stripRect.left);
      let target: number;
      if (colRect.width >= stripRect.width) {
        // Column is wider than the visible strip: keep its left edge
        // just inside the strip's `padding-left` so the user sees the
        // beginning with the same breathing room a normal column gets.
        const padW = parseFloat(getComputedStyle(strip).paddingLeft) || 0;
        target = colOffsetInStrip - padW;
      } else {
        // Center horizontally in the visible strip.
        target = colOffsetInStrip - (stripRect.width - colRect.width) / 2;
      }
      const fromX = strip.scrollLeft;
      const toX = Math.max(
        0,
        Math.min(target, strip.scrollWidth - strip.clientWidth),
      );
      // Also vertically center the column in the viewport so a click
      // on a side-dock dot brings the row into view, not just the
      // (already laid out but possibly off-screen) column. Use the
      // column's row-body ancestor as the scroll anchor when present so
      // a short column doesn't park the row's chrome (header, etc.)
      // above the fold. Custom-animated (not scrollIntoView) so the
      // jump shares the dock's short, tunable duration.
      const anchor = (col.closest(".row-body") as HTMLElement | null) ?? col;
      const aRect = anchor.getBoundingClientRect();
      const maxY = document.documentElement.scrollHeight - window.innerHeight;
      const fromY = window.scrollY;
      const toY = centerScrollTarget(
        aRect.top,
        aRect.height,
        window.innerHeight,
        fromY,
        maxY,
      );
      animateValue({
        from: 0,
        to: 1,
        duration: DOCK_SCROLL_MS,
        apply: (t) => {
          if (Math.abs(toX - fromX) > 0.5) {
            strip.scrollLeft = fromX + (toX - fromX) * t;
          }
          if (Math.abs(toY - fromY) > 0.5) {
            window.scrollTo(0, fromY + (toY - fromY) * t);
          }
        },
      });
      col.classList.add("session-col-flash");
      setTimeout(() => col.classList.remove("session-col-flash"), 2000);
      stickSessionColumnToTail(col);
    });
  }
  /** Park a SessionView's messages list at the bottom, then re-stick
   *  as markdown / code-block renders flow in.
   *
   *  SessionView's first-render scroll-to-bottom runs with
   *  `clientHeight = 0` when the row is `display:none` at the time
   *  the column mounts, so the list stays parked at scrollTop=0. Once
   *  the row has real layout we force a bottom scroll, but async
   *  markdown rendering keeps growing the content for a few
   *  hundred ms — so we also observe each .msg child and re-stick on
   *  every resize, then disconnect after 1.5s so we don't fight the
   *  user once they start scrolling manually. ResizeObserver on
   *  `.messages` itself wouldn't fire (the container is capped at
   *  max-height: 50vh); the children are where the height changes
   *  actually land. */
  function stickScrollerToBottom(scroller: HTMLElement): void {
    let raf = 0;
    const stick = () => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        // Let the browser clamp. Reading scrollHeight here forced layout,
        // and doing that inside ResizeObserver can trip RO loop warnings.
        scroller.scrollTop = 1_000_000_000;
      });
    };
    stick();
    const ro = new ResizeObserver(stick);
    for (const child of Array.from(scroller.children)) {
      ro.observe(child as Element);
    }
    setTimeout(() => {
      if (raf) cancelAnimationFrame(raf);
      ro.disconnect();
    }, 1500);
  }

  function stickSessionColumnToTail(col: HTMLElement): void {
    const messages = col.querySelector<HTMLElement>(".messages");
    if (messages) stickScrollerToBottom(messages);
    for (const body of col.querySelectorAll<HTMLElement>(
      ".work-foldout-live > .work-foldout-body",
    )) {
      stickScrollerToBottom(body);
    }
  }

  /** First-unfold-after-load path: scroll every session column in
   *  this worktree's strip to the bottom. Used by `toggleRowFolded`
   *  when the row transitions from folded → unfolded for the first
   *  time this page load. Same `stickMessagesToBottom` trick as
   *  the single-session reveal path; covers every column at once. */
  async function stickAllSessionsInWtToBottom(wtPath: string): Promise<void> {
    await tick();
    requestAnimationFrame(() => {
      const strip = document.querySelector(
        `[data-wt-strip="${CSS.escape(wtPath)}"]`,
      ) as HTMLElement | null;
      if (!strip) return;
      const cols = strip.querySelectorAll<HTMLElement>(".session-col");
      for (const col of cols) {
        stickSessionColumnToTail(col);
      }
    });
  }

  /** Hide a worktree row from the dashboard. Disk is untouched; the
   *  worktree still exists, just not displayed. Re-show via the
   *  worktrees picker. */
  function hideWorktreeRow(
    repo: { id: string; daemonId?: string },
    wtPath: string,
    diskPaths: string[],
  ) {
    visibleWorktreesByRepo = hideVisibleWorktree(
      repoPrefsKey(repo),
      diskPaths,
      visibleWorktreesByRepo,
      wtPath,
    );
  }

  /** Toggle a worktree's visibility in the dashboard from the picker. */
  function toggleWorktreeVisibility(
    repo: { id: string; daemonId?: string },
    wtPath: string,
    diskPaths: string[],
  ) {
    visibleWorktreesByRepo = toggleVisibleWorktree(
      repoPrefsKey(repo),
      diskPaths,
      visibleWorktreesByRepo,
      wtPath,
    );
  }

  /** Refetch only `/api/events` and republish. Same effect on the
   *  reactive `events` array as a full `load()`, but skips the
   *  `/api/repos` git-status scan that dominates `load()`'s wall
   *  time (especially on workspaces with many worktrees or slow
   *  drives). Called from the SSE handler when a `change` event
   *  arrives so the per-row notes-list popover ("Recently deleted"
   *  + reactive undo) and the global Undo tray pick up the new
   *  event within one network round-trip instead of waiting on the
   *  full repos refresh. */
  async function refreshEvents(): Promise<void> {
    try {
      const e = await fetch(apiUrl("/api/events"));
      if (!e.ok) return;
      events = await e.json();
    } catch {
      // Network errors are non-fatal — the next load() catches up.
    }
  }

  /** Stream /api/repos as NDJSON: one manifest line listing repo
   *  skeletons (id + name + path + color, no worktrees yet) followed
   *  by one full enriched-repo line as each repo's git fan-out
   *  completes on the server. Callers usually use `onManifest` to
   *  paint placeholder rows and `onRepo` to fill them in as each
   *  arrives — that way the dashboard stops blocking on the slowest
   *  worktree before showing anything. The returned promise resolves
   *  with the full final array, in the original workspace order. */
  async function fetchReposNDJSON(
    opts?: {
      onManifest?: (skeletons: Repo[]) => void;
      onRepo?: (repo: Repo) => void;
    },
    daemonId?: string,
  ): Promise<Repo[]> {
    const r = await fetch(
      apiUrl(`/api/repos${selectedRemotesQuery(daemonId)}`, daemonId),
      { cache: "no-cache" },
    );
    if (!r.ok) throw new Error(`/api/repos: ${r.status}`);
    if (!r.body) throw new Error("/api/repos: response had no body");
    const reader = r.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    const out: Repo[] = [];
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let nl = buf.indexOf("\n");
      while (nl >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (line.length > 0) {
          for (const r of parseNDJSONLines([line], {
            onManifest: opts?.onManifest,
            onRepo: opts?.onRepo,
            daemonId,
          })) {
            out.push(r as Repo);
          }
        }
        nl = buf.indexOf("\n");
      }
    }
    return out;
  }

  /** Coalesced via singleFlight: the dashboard's many refresh paths
   *  (initial mount, SSE change/error bursts, the new-session poll
   *  timer, every mutation's optimistic refresh) all funnel through
   *  here. Without the wrapper an `fs_change` storm or two mutations
   *  landing in the same tick would issue concurrent /api/repos NDJSON
   *  streams that race each other writing into `repos`. */
  function loadReasonLabel(reason: string | undefined): string {
    const raw =
      reason ??
      new Error().stack
        ?.split("\n")
        .find((line) => line.includes("App.svelte"))
        ?.trim() ??
      "unknown";
    return raw
      .replace(/^at\s+/, "")
      .replace(/\?.*$/, "")
      .replace(/[^a-zA-Z0-9_.:-]+/g, "-")
      .slice(0, 80);
  }

  const load = singleFlight((reason?: string) =>
    timeAsync("load", async () => {
      const loadReason = loadReasonLabel(reason);
      loading = true;
      loadingSlow = false;
      loadingTotal = 0;
      loadingDone = 0;
      if (loadingSlowTimer) clearTimeout(loadingSlowTimer);
      loadingSlowTimer = setTimeout(() => {
        loadingSlow = true;
      }, 5000);
      error = "";
      // Browser-side timing for the initial dashboard load. Pair with the
      // daemon's `/api/repos total=…` line — together they tell you
      // whether a slow load is server-side (git fan-out) or client-side
      // (rendering / network).
      const tStart = performance.now();
      let tManifest = 0;
      let tFirstRepo = 0;
      let repoCount = 0;
      try {
        // Kick off /api/repos NDJSON first so its manifest lands and
        // paints skeleton rows before the other fetches resolve. The
        // sibling fetches still run in parallel — we just don't await
        // them inside the stream pump.
        // Build NDJSON handlers scoped to one daemon (undefined ⇒ local).
        // The same handlers drive the local stream and every remote-daemon
        // stream; each writes only its own repos into the merged `repos`
        // array, keyed by [daemonId, id] so a remote repo never clobbers a
        // local one that shares a git id.
        const makeRepoHandlers = (daemonId?: string) => ({
          onManifest: (skel: Repo[]) => {
            time("load.manifest-apply", () => {
              if (!daemonId && tManifest === 0)
                tManifest = performance.now() - tStart;
              loadingTotal += skel.length;
              const filtered =
                pendingRemoval.size > 0
                  ? skel.filter((s) => !pendingRemoval.has(s.id))
                  : skel;
              // Preserve already-enriched repos for repos we've seen before
              // (manifest skeletons carry no worktrees yet); replaceDaemonRepos
              // swaps in this daemon's block in place, leaving other daemons'
              // rows untouched.
              const existing = new Map(repos.map((r) => [daemonRepoKey(r), r]));
              const merged = filtered.map(
                (s) => existing.get(daemonRepoKey(s)) ?? s,
              );
              // Apply the user's cross-daemon row order on top of the per-daemon
              // block layout so local + remote rows can interleave (no-op until
              // the user reorders — savedRepoOrder is empty by default).
              repos = sortReposByKeys(
                replaceDaemonRepos(repos, daemonId, merged),
                savedRepoOrder,
              );
              loading = false;
            });
          },
          onRepo: (full: Repo) => {
            time("load.repo-upsert", () => {
              repoCount += 1;
              loadingDone = repoCount;
              if (tFirstRepo === 0) tFirstRepo = performance.now() - tStart;
              // If a color save is still in flight for this repo, the daemon's
              // snapshot of `color` is stale (the POST hasn't persisted yet).
              // Preserve the optimistic local value so the UI doesn't flicker
              // back to the old color. Keyed by daemonRepoKey (daemonId+id), not
              // bare id, so two rows for the same repo on different daemons don't
              // share a guard. (`full` is daemonId-stamped by parseNDJSONLines.)
              if (pendingRemoval.has(full.id)) return;
              const colorKey = daemonRepoKey(full);
              if (pendingRepoColor.has(colorKey)) {
                const pending = pendingRepoColor.get(colorKey);
                if (pending === null) delete (full as { color?: string }).color;
                else full.color = pending;
              }
              repos = upsertRepo(repos, full);
            });
          },
        });
        const reposStream = fetchReposNDJSON(makeRepoHandlers());
        // Keep bootstrap fetch fan-out below the browser's same-origin
        // HTTP/1 connection budget while /api/repos and SSE streams are open.
        const [e, s] = await Promise.all([
          fetch(apiUrl("/api/events")),
          fetch(apiUrl("/api/shells")),
        ]);
        const [t, liveTermsResp, dResp] = await Promise.all([
          fetch(apiUrl("/api/session-titles")),
          fetch(apiUrl("/api/terminals")).catch(() => null),
          // Cheap local read of the remote-daemon registry; null if it
          // ever fails so fan-out is simply skipped (local path unaffected).
          fetch(apiUrl("/api/daemons")).catch(() => null),
        ]);
        if (!e.ok) throw new Error(`/api/events: ${e.status}`);
        // Wait for the stream to finish before reading sibling responses,
        // but DON'T reassign `repos` from the stream's return value — that
        // array is in completion order, while `repos` is already in
        // canonical workspace order (manifest seeds order, `onRepo` does
        // in-place updates by id). Reassigning would reorder the dashboard
        // on every refresh.
        // Mark live TUIs active in the dock as soon as /api/terminals is in —
        // BEFORE awaiting the (cold, bounded) repos stream. reconcile's
        // resumeSessionId→ownerId match needs no repo data, so gating this on
        // the full stream meant the dock showed nothing as active until every
        // repo finished enriching — the user saw dots appear only as they
        // scrolled (mounting a column populated activity the other way).
        let liveTerms: any[] | null = null;
        if (liveTermsResp && liveTermsResp.ok) {
          const parsed = await timeAsync("load.terminals-json", () =>
            liveTermsResp.json().catch(() => []),
          );
          if (Array.isArray(parsed)) {
            liveTerms = parsed;
            liveTerminalIds = new Set(
              parsed
                .filter((t) => !t?.exitedAt && typeof t?.id === "string")
                .map((t) => t.id),
            );
            openSessionsByWt = reconcileLiveAgentTerminals(
              openSessionsByWt,
              repos,
              parsed,
            ) as typeof openSessionsByWt;
          }
        }
        await reposStream;
        // Re-reconcile once every worktree's agents have streamed in, so
        // sessions matchable only via the per-worktree agent scan (no
        // persisted resumeSessionId) also attach to their live PTY.
        if (liveTerms) {
          openSessionsByWt = reconcileLiveAgentTerminals(
            openSessionsByWt,
            repos,
            liveTerms,
          ) as typeof openSessionsByWt;
        }
        // Fan out to any registered remote daemons. Each contributes its
        // repos (tagged with its daemonId) into the merged `repos` array,
        // appearing as folder rows beside the local ones. Best-effort: a
        // daemon whose tunnel is down is skipped this cycle (Phase C adds
        // per-row online/offline state). When none are registered this is a
        // pure no-op, so the local-only path is unchanged.
        const online = new Map<string, boolean>();
        if (dResp && dResp.ok) {
          let daemons: {
            id: string;
            label: string;
            host: string;
            port: number;
            color?: string;
          }[] = [];
          try {
            daemons = (await timeAsync("load.daemons-json", () =>
              dResp.json(),
            )) as typeof daemons;
          } catch {
            daemons = [];
          }
          remoteDaemons = Array.isArray(daemons) ? daemons : [];
          if (Array.isArray(daemons) && daemons.length > 0) {
            await Promise.all(
              daemons.map((d) =>
                fetchReposNDJSON(makeRepoHandlers(d.id), d.id)
                  .then(() => online.set(d.id, true))
                  .catch(() => online.set(d.id, false)),
              ),
            );
          }
          // Populate per-daemon agent/shell caches so the "Start a new session"
          // dropdown shows the remote box's CLIs, not the local machine's.
          // Build into temp maps and assign ONCE at the end. Assigning the live
          // `agentsByDaemon = { local }` up front would, on every reload,
          // momentarily drop the remote entries — a remote row's "+" menu then
          // flips to the LOCAL agents until the async fetches refill it (the
          // "Claude here / Claude there" flip-flop).
          const nextAgents: Record<string, { name: string; path: string }[]> = {
            local: installedAgents,
          };
          const nextShell: Record<string, string> = { local: defaultShell };
          const nextShellArgs: Record<string, string[]> = {
            local: defaultShellArgs,
          };
          const nextShells: Record<string, ShellOption[]> = {
            local: shellsByDaemon.local ?? [],
          };
          for (const d of remoteDaemons) {
            try {
              const [aRes, sRes, lsRes] = await Promise.all([
                fetch(apiUrl("/api/agents/installed", d.id)),
                fetch(apiUrl("/api/shell-default", d.id)),
                fetch(apiUrl("/api/shells/available", d.id)),
              ]);
              if (aRes.ok) {
                const body = (await aRes.json()) as {
                  installed?: { name: string; path: string }[];
                };
                nextAgents[d.id] = Array.isArray(body?.installed)
                  ? body.installed
                  : [];
              }
              if (sRes.ok) {
                const body = (await sRes.json()) as {
                  shell?: unknown;
                  args?: unknown;
                };
                if (typeof body.shell === "string" && body.shell.length > 0) {
                  nextShell[d.id] = body.shell;
                }
                if (Array.isArray(body.args)) {
                  nextShellArgs[d.id] = body.args.filter(
                    (a): a is string => typeof a === "string",
                  );
                }
              }
              if (lsRes.ok) {
                const body = (await lsRes.json()) as { shells?: unknown };
                if (Array.isArray(body.shells)) {
                  nextShells[d.id] = body.shells as ShellOption[];
                }
              }
            } catch {
              // Offline daemon — keep its prior entries so the row doesn't flap
              // to local agents just because one refresh couldn't reach it.
              if (agentsByDaemon[d.id]) nextAgents[d.id] = agentsByDaemon[d.id];
              if (shellByDaemon[d.id]) nextShell[d.id] = shellByDaemon[d.id];
              if (shellArgsByDaemon[d.id])
                nextShellArgs[d.id] = shellArgsByDaemon[d.id];
              if (shellsByDaemon[d.id]) nextShells[d.id] = shellsByDaemon[d.id];
            }
          }
          // Single atomic assignment — no intermediate wipe, no flip-flop.
          agentsByDaemon = nextAgents;
          shellByDaemon = nextShell;
          shellArgsByDaemon = nextShellArgs;
          shellsByDaemon = nextShells;
        } else {
          remoteDaemons = [];
        }
        daemonsOnline = online;
        events = await timeAsync("load.events-json", () => e.json());
        // /api/shells failing is non-fatal — empty list just means no
        // shell entries surface in the worktree picker this cycle.
        if (s.ok)
          allShells = (await timeAsync("load.shells-json", () =>
            s.json(),
          )) as ShellRecord[];
        // Pre-populate `newSessionTitles` for every saved synthetic-source
        // title. Titles for real JSONL sources already flow through
        // /api/repos -> agent.manualTitle, so we only adopt the entries
        // whose key matches a synthetic prefix — keeps the in-memory map
        // tight and avoids confusing two state sources for the same source.
        if (t.ok) {
          const allTitles = (await timeAsync("load.session-titles-json", () =>
            t.json(),
          )) as Record<string, string>;
          const synthetic: Record<string, string> = {};
          for (const [src, title] of Object.entries(allTitles)) {
            if (SYNTHETIC_SOURCE_PREFIXES.some((p) => src.startsWith(p))) {
              synthetic[src] = title;
            }
          }
          // Merge: anything the user just typed locally wins over the
          // server snapshot (they may have an unflushed save in flight).
          newSessionTitles = { ...synthetic, ...newSessionTitles };
        }
      } catch (e) {
        error = e instanceof Error ? e.message : String(e);
      } finally {
        loading = false;
        loadingSlow = false;
        if (loadingSlowTimer) {
          clearTimeout(loadingSlowTimer);
          loadingSlowTimer = null;
        }
        const totalMs = performance.now() - tStart;
        record("load.total", totalMs);
        record(`load.reason.${loadReason}`, totalMs);
        if (totalMs > 200) {
          console.log(
            `[load] slow ${loadReason}: ${totalMs.toFixed(0)}ms ` +
              `(manifest=${tManifest.toFixed(0)}ms firstRepo=${tFirstRepo.toFixed(0)}ms repos=${repoCount})`,
          );
        }
      }
    }),
    // Bound how long a stalled load can be shared. A /api/repos fetch that
    // hangs while the machine sleeps never settles; without this the
    // singleFlight wrapper would hand that dead promise to every later
    // caller (onResume's catch-up load included), so dirty/ahead badges
    // stayed frozen until a full page reload. A real load finishes in well
    // under 30s, so this only ever trips on a wedged one.
    { maxPendingMs: 30_000 },
  );

  const FS_CHANGE_BATCH_MS = 250;
  // Upper bound so a never-quiet fs_change stream (many active TUIs / dev
  // servers writing < 250ms apart) can't starve the trailing debounce and
  // freeze the worktree dirty state — flush at least every 2s during a burst.
  const FS_CHANGE_MAX_BATCH_MS = 2000;
  const fsChangeBatcher = createFsChangeBatcher({
    delayMs: FS_CHANGE_BATCH_MS,
    maxDelayMs: FS_CHANGE_MAX_BATCH_MS,
    onFlush(paths) {
      const nextFsChangeKey = { ...fsChangeKey };
      let nextWtSummaryStale: typeof wtSummaryStale | null = null;
      for (const wtPath of paths) {
        nextFsChangeKey[wtPath] = (nextFsChangeKey[wtPath] ?? 0) + 1;
        // Mark the cached summary stale rather than deleting it, so an open
        // (or next-hovered) tooltip/dock preview keeps showing the prior
        // changed-files list and refreshes it in place instead of blanking to
        // "Loading…". loadWtSummary refetches stale entries on the next hover.
        if (wtSummaryByPath[wtPath]) {
          nextWtSummaryStale ??= { ...wtSummaryStale };
          nextWtSummaryStale[wtPath] = true;
        }
      }
      fsChangeKey = nextFsChangeKey;
      if (nextWtSummaryStale) wtSummaryStale = nextWtSummaryStale;
      void load("fs-change-batch");
    },
  });

  /** Persisted page scroll offset. Remembered like the window size so a
   *  reload lands where the user left off (rule 11: daemon prefs, not
   *  raw localStorage). */
  const SCROLL_KEY = "supergit:scrollY";

  /** Trailing-edge save: persist scrollY once the user stops scrolling
   *  for 250ms. Reuses the resize coalescer's debounce — a scroll burst
   *  collapses to a single write. */
  const scrollSaver = createResizeCoalescer(() => {
    try {
      getDaemonKV().setItem(SCROLL_KEY, String(Math.round(window.scrollY)));
    } catch {}
  }, 250);

  /** Subscribe to user-initiated scroll intent (wheel / touch / arrow &
   *  page keys). Used by the restore to bail the instant the user takes
   *  over after a reload. Returns an unsubscribe fn. */
  function onUserScrollIntent(cb: () => void): () => void {
    const handler = () => cb();
    const SCROLL_KEYS = new Set([
      "ArrowUp",
      "ArrowDown",
      "PageUp",
      "PageDown",
      "Home",
      "End",
      " ",
      "Spacebar",
    ]);
    const keyHandler = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      const tag = t?.tagName;
      // Typing in a field isn't a page scroll — ignore so an early
      // keystroke in search doesn't cancel the restore.
      if (
        tag === "INPUT" ||
        tag === "TEXTAREA" ||
        tag === "SELECT" ||
        t?.isContentEditable
      ) {
        return;
      }
      if (SCROLL_KEYS.has(e.key)) cb();
    };
    window.addEventListener("wheel", handler, { passive: true });
    window.addEventListener("touchmove", handler, { passive: true });
    window.addEventListener("keydown", keyHandler);
    return () => {
      window.removeEventListener("wheel", handler);
      window.removeEventListener("touchmove", handler);
      window.removeEventListener("keydown", keyHandler);
    };
  }

  /** After the initial load resolves (repos streamed in), wait a beat for
   *  rows to lay out, then restore the saved scroll offset — unless the
   *  user already started scrolling, in which case we leave them be. */
  function restoreScrollPosition(): void {
    const raw = getDaemonKV().getItem(SCROLL_KEY);
    if (!raw) return;
    const target = parseInt(raw, 10);
    if (!Number.isFinite(target) || target <= 0) return;
    cancelScrollRestore = restoreScrollAfterDelay(target, 400, {
      timer: {
        set: (cb, ms) => setTimeout(cb, ms),
        clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
      },
      scrollTo: (y) => window.scrollTo({ top: y }),
      onUserScroll: onUserScrollIntent,
    });
  }
  let cancelScrollRestore: (() => void) | null = null;

  /** Scroll to the bottom of the page so the just-added repo (which
   *  appends to the end of the list) AND the footer CTAs below it are
   *  in view. `load()` returns when its NDJSON stream finishes, but
   *  Svelte still has to render the new row and the daemon may stream
   *  one more enrichment frame after. The 150ms delay lets all of
   *  that settle before we measure `scrollHeight`. */
  async function scrollToNewRepo() {
    await tick();
    setTimeout(() => {
      window.scrollTo({
        top: document.documentElement.scrollHeight,
        behavior: "smooth",
      });
    }, 150);
  }

  async function noteAndFocusExistingRepo(repo: AddRepoResponse) {
    const notice = duplicateRepoNotice(repo);
    addToast({
      kind: "info",
      title: notice.title,
      message: notice.message,
      onClick: () => void focusRepoRow(repo.id),
    });
    await load();
    await focusRepoRow(repo.id);
  }

  let addFolderBusy = false;

  async function pickAndAdd() {
    error = "";
    addFolderBusy = true;
    try {
      const pick = await fetch(apiUrl("/api/pick-folder"), { method: "POST" });
      if (pick.status === 204) return;
      if (!pick.ok) {
        const body = await pick.json().catch(() => ({}));
        throw new Error(body.error ?? `HTTP ${pick.status}`);
      }
      const { path } = (await pick.json()) as { path: string };
      const add = await fetch(apiUrl("/api/repos"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path }),
      });
      if (!add.ok) {
        const body = await add.json().catch(() => ({}));
        throw new Error(body.error ?? `HTTP ${add.status}`);
      }
      const added = (await add.json()) as AddRepoResponse;
      if (added.alreadyRegistered) {
        await noteAndFocusExistingRepo(added);
        return;
      }
      play(repos.length === 0 ? "folder-add-first" : "folder-add");
      newlyAddedRepoPaths.add(path);
      await load();
      // Focus the freshly added repo — in zen this jumps zen to it, otherwise
      // it scrolls the row into view and flashes it (see focusRepoRow).
      projectsMenuOpen = false;
      await focusRepoRow(added.id);
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      addFolderBusy = false;
    }
  }

  /** Add a folder that already exists ON a remote daemon's box (#3). POSTs
   *  the same /api/repos contract as the local add, but routed to the owning
   *  daemon so the remote registers it against its own filesystem. Throws on
   *  failure so the dialog surfaces the daemon's 409 (path missing / not a
   *  git repo) and stays open. */
  async function addRemoteFolder(payload: {
    daemonId: string;
    path: string;
  }): Promise<void> {
    const add = await fetch(apiUrl("/api/repos", payload.daemonId), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: payload.path }),
    });
    if (!add.ok) {
      const body = (await add.json().catch(() => ({}))) as { error?: string };
      throw new Error(body.error ?? `HTTP ${add.status}`);
    }
    const added = (await add.json()) as AddRepoResponse;
    if (added.alreadyRegistered) {
      await noteAndFocusExistingRepo(added);
      return;
    }
    play(repos.length === 0 ? "folder-add-first" : "folder-add");
    newlyAddedRepoPaths.add(payload.path);
    await load();
    await scrollToNewRepo();
  }

  /** POST that registers a remote daemon and returns the created record.
   *  Validates the response is the expected daemon JSON (`{id,...}`) rather
   *  than trusting `res.ok` alone: an OLD/un-rebuilt local daemon that
   *  doesn't know the route can answer 2xx with HTML (SPA fallback) or an
   *  empty body, which would otherwise read as a false success and close
   *  the dialog with nothing registered. Throws a clear, actionable error
   *  in every failure case so the dialog can surface it. */
  async function postRegisterDaemon(
    apiPath: string,
    body: unknown,
  ): Promise<{ id: string; label?: string }> {
    // `apiPath` is already resolved by the caller (via a literal
    // `apiUrl("/api/daemons…")` so the routing guard can see + allowlist
    // it). The daemon registry is always local, so no daemonId is involved.
    let res: Response;
    try {
      res = await fetch(apiPath, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    } catch (e) {
      throw new Error(
        `couldn't reach the local daemon — is it running? (${e instanceof Error ? e.message : String(e)})`,
      );
    }
    const ct = res.headers.get("content-type") ?? "";
    if (!ct.includes("application/json")) {
      // HTML/empty ⇒ the route doesn't exist on this daemon build.
      throw new Error(
        `unexpected response (HTTP ${res.status}, ${ct || "no content-type"}). ` +
          `Your local daemon may be an older build without this endpoint — rebuild + restart it.`,
      );
    }
    const json = (await res.json().catch(() => null)) as {
      id?: string;
      label?: string;
      error?: string;
    } | null;
    if (!res.ok) throw new Error(json?.error ?? `HTTP ${res.status}`);
    if (!json || typeof json.id !== "string") {
      throw new Error("daemon accepted the request but returned no record");
    }
    return json as { id: string; label?: string };
  }

  /** Register a remote daemon (manual form), reload so its repos fan in,
   *  and confirm with a toast. Throws on failure so the dialog surfaces the
   *  error and stays open. The registry is always local (not daemon-routed). */
  async function addRemoteDaemon(payload: DaemonFormPayload): Promise<void> {
    const d = await postRegisterDaemon(apiUrl("/api/daemons"), payload);
    await load();
    addToast({
      kind: "success",
      message: `Remote daemon "${d.label ?? payload.host}" added.`,
    });
  }

  /** One-paste onboarding: hand the connection string to the local daemon,
   *  which decodes it, stores the key server-side, registers the remote, and
   *  opens the tunnel. Confirms with a toast; throws on failure so the
   *  dialog shows the error and stays open. */
  async function connectRemoteDaemon(connectionString: string): Promise<void> {
    const d = await postRegisterDaemon(apiUrl("/api/daemons/connect"), {
      connectionString,
    });
    await load();
    addToast({
      kind: "success",
      message: `Remote daemon "${d.label ?? "remote"}" connected.`,
    });
  }

  // ── Auto-provision ("connect a daemon"): ship the bundled source to a box
  // over the user's own ssh, run the installer with live progress, register
  // when it prints its token. All endpoints are workspace-global (local
  // daemon owns the ssh), so no daemonId routing. ──
  /** Whether this build can auto-provision (payload bundled + ssh present).
   *  Probed when the Add-daemon dialog opens; default true → provision-first,
   *  and a failed POST surfaces the real reason if the probe was wrong. */
  let provisionCapable = true;
  /** Human reason the provision section is hidden, shown in the dialog so it's
   *  not a silent absence. Empty when provisioning is available. */
  let provisionUnavailableReason = "";
  async function refreshProvisionCapability(): Promise<void> {
    try {
      const r = await fetch(apiUrl("/api/daemons/provision/capability"));
      if (!r.ok) return;
      const j = (await r.json()) as {
        available?: boolean;
        mode?: string;
        sshAvailable?: boolean;
      };
      provisionCapable = !!j.available && j.sshAvailable !== false;
      if (provisionCapable) {
        provisionUnavailableReason = "";
      } else if (j.sshAvailable === false) {
        provisionUnavailableReason =
          "The local app can't find the ssh client. Install / enable OpenSSH " +
          "Client and make sure ssh is on PATH, then reopen this dialog.";
      } else {
        // mode "none": no installer payload bundled in this build.
        provisionUnavailableReason =
          "This build doesn't include the installer payload, so it can't set " +
          "up a box for you. Update / rebuild supergit to enable one-click " +
          "provisioning. You can still connect a daemon manually below.";
      }
    } catch {
      // keep the default; the POST path reports the real error if needed.
    }
  }
  $: if (addDaemonOpen) void refreshProvisionCapability();

  const provisionApi: ProvisionApi = {
    start: async (payload: ProvisionFormPayload): Promise<string> => {
      const res = await fetch(apiUrl("/api/daemons/provision"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const j = (await res.json().catch(() => null)) as {
        jobId?: string;
        error?: string;
      } | null;
      if (!res.ok || !j?.jobId) {
        throw new Error(j?.error || `provision failed (${res.status})`);
      }
      return j.jobId;
    },
    stream: (
      jobId: string,
      handlers: ProvisionStreamHandlers,
    ): (() => void) => {
      const es = new EventSource(
        apiUrl(`/api/daemons/provision/${jobId}/stream`),
      );
      es.addEventListener("output", (e) => {
        try {
          handlers.onOutput(
            (JSON.parse((e as MessageEvent).data) as { chunk: string }).chunk,
          );
        } catch {
          /* malformed frame — skip */
        }
      });
      es.addEventListener("status", (e) => {
        try {
          const d = JSON.parse((e as MessageEvent).data) as {
            status: string;
            daemonId?: string;
            error?: string;
          };
          handlers.onStatus(d.status, {
            daemonId: d.daemonId,
            error: d.error,
          });
        } catch {
          /* malformed frame — skip */
        }
      });
      es.addEventListener("done", () => {
        es.close();
        handlers.onEnd();
      });
      es.onerror = () => {
        // The daemon also sends an explicit `done`; ignore transient SSE
        // hiccups rather than tearing the stream down prematurely.
      };
      return () => es.close();
    },
    abort: async (jobId: string): Promise<void> => {
      await fetch(apiUrl(`/api/daemons/provision/${jobId}/abort`), {
        method: "POST",
      }).catch(() => {});
    },
  };

  /** Suggestion returned by /api/sessions/folder-suggestions — a folder
   *  the user might want to import as a repo, derived from cwds the
   *  agents (Claude, Codex, Copilot, Ollama) have been observed in.
   *  Sorted newest-first by the daemon; already-registered repos +
   *  their worktrees are filtered out server-side. */
  interface FolderSuggestion {
    path: string;
    name: string;
    repoUrl?: string;
    sessionCount: number;
    lastActive: string;
    agents: string[];
    exists: boolean;
  }

  /** "Import from sessions" popover state. Anchored from the trigger
   *  button (one of two CTAs depending on whether the dashboard is in
   *  the empty-onboarding view or the populated-with-footer view).
   *  Outside clicks close it via `handleDocClick`, keyed off the
   *  `.import-sessions-anchor` ancestor. */
  let importSessionsOpen = false;
  let importSuggestions: FolderSuggestion[] = [];
  let importLoading = false;
  let importError = "";
  let importQuery = "";
  $: importFiltered = (() => {
    const q = importQuery.trim().toLowerCase();
    if (!q) return importSuggestions;
    return importSuggestions.filter(
      (s) =>
        s.name.toLowerCase().includes(q) ||
        s.path.toLowerCase().includes(q) ||
        (s.repoUrl && s.repoUrl.toLowerCase().includes(q)) ||
        s.agents.some((a) => a.toLowerCase().includes(q)),
    );
  })();
  /** Paths currently being added — prevents double-clicks from spamming
   *  the daemon and lets the row render a spinner while the request is
   *  in flight. */
  let importAdding = new Set<string>();
  /** When the trigger button sits in the lower half of the viewport,
   *  flip the popover above the button so the dropdown doesn't extend
   *  past the bottom of the screen. Decided once on each open, from
   *  the click event's currentTarget — works equally for the empty-
   *  state CTA (top of screen) and the footer CTA (bottom of long
   *  list). */
  let importFlipUp = false;
  /** Which trigger owns the currently-open import popover. The same
   *  `importSessionsOpen` state backs three triggers (empty-state CTA,
   *  footer CTA, and the Projects dropdown row), and in the populated
   *  view the footer CTA and the dropdown row coexist in the DOM — so we
   *  gate each `{#if}` on this discriminator to render exactly one. */
  let importMenuSource: "inline" | "projects" = "inline";

  async function openImportSessions() {
    importSessionsOpen = true;
    if (importLoading) return;
    importLoading = true;
    importError = "";
    try {
      const r = await fetch(apiUrl("/api/sessions/folder-suggestions"));
      if (!r.ok) {
        const body = await r.json().catch(() => ({}));
        throw new Error(body.error ?? `HTTP ${r.status}`);
      }
      importSuggestions = (await r.json()) as FolderSuggestion[];
    } catch (e) {
      importError = e instanceof Error ? e.message : String(e);
      importSuggestions = [];
    } finally {
      importLoading = false;
    }
  }

  function toggleImportSessions(
    e: MouseEvent,
    source: "inline" | "projects" = "inline",
  ) {
    // Re-clicking the same trigger closes; clicking a different trigger
    // re-targets the popover to it.
    if (importSessionsOpen && importMenuSource === source) {
      importSessionsOpen = false;
    } else {
      importMenuSource = source;
      // Decide flip direction from the click event's button before
      // we render the popover, so the dropdown opens upward if the
      // button is in the lower half of the viewport.
      const btn = e.currentTarget as HTMLElement | null;
      if (btn) {
        const rect = btn.getBoundingClientRect();
        importFlipUp = rect.top + rect.height / 2 > window.innerHeight / 2;
      }
      importQuery = "";
      void openImportSessions();
    }
  }

  async function addRepoFromSuggestion(path: string) {
    if (importAdding.has(path)) return;
    importAdding = new Set(importAdding).add(path);
    importError = "";
    try {
      const r = await fetch(apiUrl("/api/repos"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path }),
      });
      if (!r.ok) {
        const body = await r.json().catch(() => ({}));
        throw new Error(body.error ?? `HTTP ${r.status}`);
      }
      const added = (await r.json()) as AddRepoResponse;
      if (added.alreadyRegistered) {
        importSuggestions = importSuggestions.filter((s) => s.path !== path);
        if (importSuggestions.length === 0) importSessionsOpen = false;
        await noteAndFocusExistingRepo(added);
        return;
      }
      // Drop the just-added entry from the suggestions list so the
      // popover reflects the new state without a refetch round-trip,
      // then refresh the dashboard so the new row appears.
      play(repos.length === 0 ? "folder-add-first" : "folder-add");
      importSuggestions = importSuggestions.filter((s) => s.path !== path);
      newlyAddedRepoPaths.add(path);
      await load();
      // Close the popover when the list is empty — nothing left to do.
      if (importSuggestions.length === 0) importSessionsOpen = false;
      // Focus the freshly added repo — zen jumps to it, otherwise the row
      // scrolls into view and flashes (see focusRepoRow).
      projectsMenuOpen = false;
      await focusRepoRow(added.id);
    } catch (e) {
      importError = e instanceof Error ? e.message : String(e);
    } finally {
      const next = new Set(importAdding);
      next.delete(path);
      importAdding = next;
    }
  }

  /** Open the repo-edit popover (name + color + reorder) for a row. */
  function openRepoEdit(repo: Repo, rowKey: string) {
    editingRowKey = rowKey;
    editingRepoId = repo.id;
    editRepoName = repo.name;
  }
  /** Close the popover without persisting the name. Colour edits are
   *  saved live (on the picker's `change`), so only the pending name is
   *  dropped here. */
  function cancelRenameRepo() {
    editingRowKey = null;
    editingRepoId = null;
    editRepoName = "";
  }
  /** Persist the pending name (no-op if blank/unchanged) then close. */
  async function commitRenameRepo(id: string) {
    const name = editRepoName.trim();
    const current = repos.find((r) => r.id === id)?.name;
    if (!name || name === current) {
      cancelRenameRepo();
      return;
    }
    error = "";
    try {
      const res = await fetch(
        apiUrl(`/api/repos/${id}/rename`, daemonIdForRepoId(repos, id)),
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name }),
        },
      );
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      editingRowKey = null;
      editingRepoId = null;
      editRepoName = "";
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
  }
  /** Persist a new global repo display order. The daemon broadcasts
   *  `repos_reorder`, which round-trips a fresh `/api/repos` and
   *  re-derives the row order — no optimistic mutation needed here. */
  async function reorderRepos(orderedIds: string[]) {
    error = "";
    // The dialog hands back the MERGED order across all daemons as bare repo
    // ids. Two things happen:
    //   1. Cross-daemon interleave (local + remote rows mixed): persist the
    //      full order as `daemonRepoKey`s in LOCAL prefs and apply it now.
    //      This is what makes "drag a remote repo above a local one" stick —
    //      it's a local-window concern no single daemon can own.
    //   2. Within-daemon order: still POST each daemon its own id slice so the
    //      box's repos.json reflects the order for its other clients.
    // Map ids → keys by consuming matches, so two repos that share a git id
    // across daemons map positionally rather than colliding.
    const remaining = repos.slice();
    const orderedKeys: string[] = [];
    for (const id of orderedIds) {
      const i = remaining.findIndex((r) => r.id === id);
      if (i >= 0) {
        const [r] = remaining.splice(i, 1);
        orderedKeys.push(daemonRepoKey(r!));
      }
    }
    savedRepoOrder = orderedKeys;
    try {
      getDaemonKV().setItem(REPO_ORDER_KEY, JSON.stringify(orderedKeys));
    } catch {}
    repos = sortReposByKeys(repos, savedRepoOrder); // instant feedback

    const byDaemon = new Map<string | undefined, string[]>();
    for (const repoId of orderedIds) {
      const dId = daemonIdForRepoId(repos, repoId);
      const arr = byDaemon.get(dId) ?? [];
      arr.push(repoId);
      byDaemon.set(dId, arr);
    }
    try {
      for (const [dId, ids] of byDaemon) {
        const res = await fetch(apiUrl(`/api/repos/order`, dId), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ order: ids }),
        });
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error(body.error ?? `HTTP ${res.status}`);
        }
      }
      // Re-fetch so the new order shows. The local daemon's `repos_reorder`
      // SSE broadcast would refresh a LOCAL reorder, but a REMOTE daemon's
      // broadcast fires on ITS stream, which this UI isn't subscribed to —
      // so without an explicit reload a remote reorder persisted on the box
      // but never re-rendered here. load() re-runs the fan-out and picks up
      // each daemon's new order.
      await load();
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
  }

  /** Default colour shown in the swatch (and used to seed the picker)
   *  when a repo has no accent set. Read live from --chip-default-bg
   *  on :root so a theme change to that token automatically flows
   *  here — no second source of truth to keep in sync. Falls back to
   *  the historical blue while the DOM is still booting. */
  let defaultChipHex = "#1a3a5a";
  onMount(() => {
    const v = getComputedStyle(document.documentElement)
      .getPropertyValue("--chip-default-bg")
      .trim();
    if (/^#[0-9a-f]{6}$/i.test(v)) defaultChipHex = v.toLowerCase();
  });

  /** Per-repo "color save in flight" guard. Any SSE-triggered
   *  /api/repos refresh that lands while a POST /color is still in
   *  flight (or before the daemon has persisted + rebroadcast) would
   *  otherwise overwrite the user's just-picked color with the stale
   *  on-disk value. `fetchReposNDJSON.onRepo` checks this set and
   *  preserves the local optimistic color for repos it contains. */
  const pendingRepoColor = new Map<string, string | null>();

  /** Repo IDs whose DELETE is in flight. Stale NDJSON streams (started
   *  before the deletion) would otherwise re-inject the removed repo via
   *  onManifest / onRepo because singleFlight coalesces the post-delete
   *  load() with the pre-delete one. Same guard pattern as pendingRepoColor. */
  const pendingRemoval = new Set<string>();

  /** Live preview while the colour picker is open (on:input). Sets the
   *  optimistic colour AND the in-flight guard — WITHOUT POSTing (on:change
   *  does that) — so a `load()` landing mid-edit (the dashboard refreshes
   *  often) can't repaint the pre-edit colour and snap the picker back. This
   *  is the actual "colour resets while editing" fix. */
  function previewRepoColor(
    repo: { id: string; daemonId?: string; color?: string },
    color: string,
  ): void {
    repo.color = color;
    repos = repos;
    pendingRepoColor.set(daemonRepoKey(repo), color);
  }

  /** Push a new accent colour for the given repo to the daemon. The
   *  optimistic local mutation here is just for snappy UI; the SSE
   *  `change → repo_color` broadcast triggers a full /api/repos
   *  refresh which re-syncs whatever the daemon now has on disk. */
  async function setRepoColor(
    repo: { id: string; daemonId?: string; color?: string },
    color: string | null,
  ) {
    // Operate on the EXACT repo passed in (the row's own object) — NOT
    // repos.find(id), which returns the first id-match and misroutes /
    // mutates the wrong row when the same repo is tracked on two daemons (the
    // duplicate-row case). Route by the repo's own daemonId and key the
    // in-flight guard by daemonRepoKey so the two rows can't clobber each
    // other's pending colour.
    const key = daemonRepoKey(repo);
    if (color === null) delete repo.color;
    else repo.color = color;
    repos = repos;
    pendingRepoColor.set(key, color);
    try {
      const res = await fetch(
        apiUrl(`/api/repos/${repo.id}/color`, repo.daemonId),
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ color }),
        },
      );
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      // Clear the guard a beat AFTER the POST resolves, not instantly. For a
      // REMOTE repo the confirming `change → repo_color` SSE and its
      // /api/repos reload round-trip back over the (possibly slow) tunnel and
      // can land just after the POST returns; dropping the guard immediately
      // lets that late reload repaint the pre-save colour. The supersession
      // check still applies — a newer save for the same id keeps its entry.
      setTimeout(() => {
        if (pendingRepoColor.get(key) === color) pendingRepoColor.delete(key);
      }, 2500);
    }
  }

  /** Append a user-defined "open in" link to a repo. The daemon
   *  validates the URL and assigns the link id; on success we splice
   *  the returned link into the local repo so the UI updates without
   *  waiting for the SSE-triggered refresh. */
  async function addCustomLink(
    repoId: string,
    input:
      | { url: string; name?: string }
      | { kind: "url"; url: string; name?: string }
      | { kind: "file"; path: string; name?: string }
      | { kind: "folder"; path: string; name?: string }
      | {
          kind: "command";
          cmd: string;
          cwd?: string;
          runMode?: string;
          name?: string;
        },
  ): Promise<boolean> {
    try {
      const res = await fetch(
        apiUrl(
          `/api/repos/${repoId}/custom-links`,
          daemonIdForRepoId(repos, repoId),
        ),
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(input),
        },
      );
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      const body = (await res.json()) as { link: CustomLink };
      const repo = repos.find((r) => r.id === repoId);
      if (repo) {
        repo.customLinks = [...(repo.customLinks ?? []), body.link];
        repos = repos;
      }
      return true;
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
      return false;
    }
  }

  /** Rewrite the repo's custom-link order to match `orderedIds`.
   *  Optimistic: we splice the local array immediately so animate:flip
   *  in OpenInActions can run its transition without waiting for the
   *  SSE round-trip. The daemon validates the permutation and emits a
   *  `change` broadcast on success. */
  async function reorderCustomLinks(
    repoId: string,
    orderedIds: string[],
  ): Promise<void> {
    const repo = repos.find((r) => r.id === repoId);
    if (repo && repo.customLinks) {
      const byId = new Map(repo.customLinks.map((l) => [l.id, l]));
      const reordered: CustomLink[] = [];
      for (const lid of orderedIds) {
        const link = byId.get(lid);
        if (link) reordered.push(link);
      }
      if (reordered.length === repo.customLinks.length) {
        repo.customLinks = reordered;
        repos = repos;
      }
    }
    try {
      const res = await fetch(
        apiUrl(
          `/api/repos/${repoId}/custom-links/order`,
          daemonIdForRepoId(repos, repoId),
        ),
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ order: orderedIds }),
        },
      );
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
  }

  /** Edit an existing custom link's URL and/or label. Same optimistic
   *  pattern as add/remove — we splice the updated link into the
   *  local repo immediately so the chip's favicon + label update
   *  without waiting for the SSE round-trip. */
  async function updateCustomLink(
    repoId: string,
    linkId: string,
    input: {
      url?: string;
      path?: string;
      cmd?: string;
      cwd?: string;
      runMode?: string;
      kind?: "url" | "file" | "folder" | "command";
      name?: string;
    },
  ): Promise<boolean> {
    try {
      const res = await fetch(
        apiUrl(
          `/api/repos/${repoId}/custom-links/${linkId}`,
          daemonIdForRepoId(repos, repoId),
        ),
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(input),
        },
      );
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      const body = (await res.json()) as { link: CustomLink };
      const repo = repos.find((r) => r.id === repoId);
      if (repo && repo.customLinks) {
        repo.customLinks = repo.customLinks.map((l) =>
          l.id === linkId ? body.link : l,
        );
        repos = repos;
      }
      return true;
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
      return false;
    }
  }

  async function removeCustomLink(
    repoId: string,
    linkId: string,
  ): Promise<void> {
    try {
      const res = await fetch(
        apiUrl(
          `/api/repos/${repoId}/custom-links/${linkId}`,
          daemonIdForRepoId(repos, repoId),
        ),
        {
          method: "DELETE",
        },
      );
      if (!res.ok && res.status !== 204) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      const repo = repos.find((r) => r.id === repoId);
      if (repo && repo.customLinks) {
        repo.customLinks = repo.customLinks.filter((l) => l.id !== linkId);
        repos = repos;
      }
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
  }

  const commandTermStore = new CommandTermStore(
    getDaemonKV(),
    "supergit:commandTermSources",
  );
  const commandTermSources: Map<string, { wtPath: string; source: string }> =
    (() => {
      const m = new Map<string, { wtPath: string; source: string }>();
      for (const [k, v] of Object.entries(commandTermStore.load())) m.set(k, v);
      return m;
    })();
  function persistCommandTermSources() {
    const map: Record<string, { wtPath: string; source: string }> = {};
    for (const [k, v] of commandTermSources) map[k] = v;
    commandTermStore.save(map);
  }

  async function commandTermAlive(source: string): Promise<boolean> {
    const termId = source.replace("__attached__:shell:", "");
    if (!termId || termId === source) return false;
    try {
      const r = await fetch(apiUrl("/api/terminals"));
      if (!r.ok) return false;
      const list = (await r.json()) as { id: string; exitedAt?: string }[];
      return list.some((t) => t.id === termId && !t.exitedAt);
    } catch {
      return false;
    }
  }

  function forgetCommandTerm(
    linkId: string,
    entry: { wtPath: string; source: string },
  ): void {
    commandTermSources.delete(linkId);
    persistCommandTermSources();
    const nextSet = new Set(runningCommandIds);
    nextSet.delete(linkId);
    runningCommandIds = nextSet;
    openSessionsByWt = {
      ...openSessionsByWt,
      [entry.wtPath]: (openSessionsByWt[entry.wtPath] ?? []).filter(
        (s) => s.source !== entry.source,
      ),
    };
  }

  async function revealInternalCommand(entry: {
    wtPath: string;
    source: string;
  }): Promise<void> {
    undismissShellSource(entry.source);
    const existing = openSessionsByWt[entry.wtPath] ?? [];
    if (!existing.some((s) => s.source === entry.source)) {
      const next = [...existing];
      next.splice(visibleLeftInsertIndex(entry.wtPath, existing), 0, {
        agent: "shell",
        source: entry.source,
      });
      openSessionsByWt = { ...openSessionsByWt, [entry.wtPath]: next };
    }
    scrollNewColIntoView(entry.wtPath, entry.source);
  }

  async function handleCommandClick(
    wtPath: string,
    link: CustomLink,
    opts: {
      revealInternalTerminal?: boolean;
    } = {},
  ) {
    if (link.kind !== "command") return;
    const cmdLink = link as {
      cmd: string;
      cwd?: string;
      runMode: string;
      id: string;
    };
    const isRunning = runningCommandIds.has(link.id);
    const revealInternalTerminal = opts.revealInternalTerminal ?? true;

    if (isRunning && cmdLink.runMode === "shell") {
      // Don't stop on re-click — the process keeps running in the background.
      return;
    }

    if (cmdLink.runMode === "internal") {
      const prev = commandTermSources.get(link.id);
      if (prev) {
        const alive = await commandTermAlive(prev.source);
        if (alive) {
          await revealInternalCommand(prev);
          return;
        }
        forgetCommandTerm(link.id, prev);
      }
    }

    const repoId = repos.find((r) =>
      (r.customLinks ?? []).some((l) => l.id === link.id),
    )?.id;

    try {
      const res = await fetch(
        apiUrl("/api/command/run", daemonIdForWorktreePath(repos, wtPath)),
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ linkId: link.id, repoId, repoPath: wtPath }),
        },
      );
      const body = await res.json();
      if (!res.ok) {
        addToast({
          kind: "error",
          message: `Command failed: ${body.error ?? `HTTP ${res.status}`}`,
        });
        return;
      }

      if (body.mode === "internal" && body.termId) {
        const source = `__attached__:shell:${body.termId}`;
        commandTermSources.set(link.id, { wtPath, source });
        persistCommandTermSources();
        runningCommandIds = new Set([...runningCommandIds, link.id]);
        const title = link.name?.trim() || cmdLink.cmd;
        void fetch(apiUrl("/api/session/title"), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ source, title }),
        });
        newSessionTitles = { ...newSessionTitles, [source]: title };
        if (revealInternalTerminal) {
          await revealInternalCommand({ wtPath, source });
        } else {
          dismissShellSource(source);
        }
      } else if (body.mode === "shell") {
        void refreshRunningCommands();
      }
    } catch (e) {
      addToast({
        kind: "error",
        message: `Command failed: ${e instanceof Error ? e.message : String(e)}`,
      });
    }
  }

  function handleCommandLinkOpen(payload: {
    linkId: string;
    repoId?: string;
    wtPath?: string;
    revealTerminal?: boolean;
  }): void {
    const repo = payload.repoId
      ? repos.find((r) => r.id === payload.repoId)
      : repos.find((r) =>
          (r.customLinks ?? []).some((l) => l.id === payload.linkId),
        );
    const link = repo?.customLinks?.find((l) => l.id === payload.linkId);
    if (!repo || !link || link.kind !== "command") {
      addToast({
        kind: "error",
        message: "Command reference no longer exists",
      });
      return;
    }
    const wtPath =
      payload.wtPath ||
      repo.worktrees.find((wt) => !wt.nonGit)?.path ||
      repo.worktrees[0]?.path ||
      repo.path;
    void handleCommandClick(wtPath, link, {
      revealInternalTerminal: payload.revealTerminal ?? false,
    });
  }

  function handleCommandLinkEdit(payload: {
    linkId: string;
    repoId?: string;
  }): void {
    const repo = payload.repoId
      ? repos.find((r) => r.id === payload.repoId)
      : repos.find((r) =>
          (r.customLinks ?? []).some((l) => l.id === payload.linkId),
        );
    const link = repo?.customLinks?.find((l) => l.id === payload.linkId);
    if (!repo || !link || link.kind !== "command") {
      addToast({
        kind: "error",
        message: "Command reference no longer exists",
      });
      return;
    }
    commandEditRequest = {
      repoId: repo.id,
      linkId: link.id,
      nonce: Date.now(),
    };
  }

  async function removeRepo(id: string) {
    error = "";
    pendingRemoval.add(id);
    // Resolve the owning daemon BEFORE the optimistic removal — otherwise the
    // repo is already gone from `repos` and the DELETE loses its daemonId,
    // hitting the LOCAL daemon and 404'ing for a remote repo. planRepoRemoval
    // captures both in lockstep so the order can't regress.
    const { daemonId, nextRepos } = planRepoRemoval(repos, id);
    repos = nextRepos;
    try {
      const res = await fetch(apiUrl(`/api/repos/${id}`, daemonId), {
        method: "DELETE",
      });
      if (!res.ok && res.status !== 204) throw new Error(`HTTP ${res.status}`);
      await load();
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      pendingRemoval.delete(id);
    }
  }

  /** Unregister a remote daemon (DELETE /api/daemons/<id>). The registry
   *  is always local, so NOT daemon-routed (no daemonId arg). Optimistically
   *  drop the daemon's repos from the row list, then reload. */
  async function removeDaemon(daemonId: string): Promise<boolean> {
    // Confirm first — removing a daemon drops all its rows + tears down the
    // tunnel + deletes the stored key. The custom dialog (confirm-dialog.ts
    // / ConfirmDialog.svelte) names the daemon so the user sees exactly
    // which one. danger:true styles the confirm button as destructive.
    const label = daemonLabelForRepo(daemonId) || daemonId;
    const ok = await confirmDialog({
      title: `Remove remote daemon "${label}"?`,
      message:
        "Its folder rows disappear from this window and the SSH tunnel + " +
        "stored key are removed. The remote box and its repos are left " +
        "untouched — you can re-add it later with the connection string.",
      confirmLabel: "Remove daemon",
      cancelLabel: "Cancel",
      danger: true,
    });
    if (!ok) return false;
    // Second, deliberate confirmation — removal is destructive and easy to
    // trigger by accident, so it's gated behind a double confirm (replacing
    // the old one-click "×" on the row).
    const reallyOk = await confirmDialog({
      title: `Really remove "${label}"?`,
      message:
        "Confirm once more to remove this remote daemon from the window. " +
        "You can re-add it later with its connection string.",
      confirmLabel: "Yes, remove it",
      cancelLabel: "Keep it",
      danger: true,
    });
    if (!reallyOk) return false;
    error = "";
    // Optimistically drop the daemon from BOTH the repo rows AND the
    // menubar daemon list (the list iterates `remoteDaemons` — filtering
    // only `repos` left the menu row visible until load() finished). Mark
    // it pending so the row can show a spinner. Reassign each (new
    // array/Set) so Svelte reactivity fires.
    daemonRemoving = new Set(daemonRemoving).add(daemonId);
    const prevDaemons = remoteDaemons;
    repos = repos.filter((r) => r.daemonId !== daemonId);
    remoteDaemons = remoteDaemons.filter((d) => d.id !== daemonId);
    let removed = false;
    try {
      const res = await fetch(apiUrl(`/api/daemons/${daemonId}`), {
        method: "DELETE",
      });
      if (!res.ok && res.status !== 204) throw new Error(`HTTP ${res.status}`);
      await load();
      removed = true;
      play("daemon-remove");
    } catch (e) {
      // Roll back the optimistic removal so the daemon doesn't vanish on a
      // failed delete.
      remoteDaemons = prevDaemons;
      error = e instanceof Error ? e.message : String(e);
    } finally {
      const next = new Set(daemonRemoving);
      next.delete(daemonId);
      daemonRemoving = next;
    }
    return removed;
  }

  /** Uninstall the daemon ON the box: SSH in as admin (root) and run the
   *  uninstaller, then drop it locally. The registry call is always local
   *  (not daemon-routed). Returns true when the box was uninstalled. */
  async function uninstallDaemonOnBox(daemonId: string): Promise<boolean> {
    const label = daemonLabelForRepo(daemonId) || daemonId;
    const ok = await confirmDialog({
      title: `Uninstall "${label}" on the box?`,
      message:
        "This SSHes into the box as root and runs the supergit uninstaller " +
        "(stops + removes the daemon service), then removes it from this " +
        "window. Your repos on the box are left untouched.",
      confirmLabel: "Uninstall on box",
      cancelLabel: "Cancel",
      danger: true,
    });
    if (!ok) return false;
    // Start the streaming uninstall job, then open the same live-log dialog
    // (attach mode) the install uses. The job's manager unregisters the daemon
    // on success; the dialog's onDone refreshes + toasts.
    try {
      const res = await fetch(apiUrl(`/api/daemons/${daemonId}/uninstall`), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ user: "root" }),
      });
      const j = (await res.json().catch(() => null)) as {
        jobId?: string;
        error?: string;
      } | null;
      if (!res.ok || !j?.jobId) {
        throw new Error(j?.error || `uninstall failed (${res.status})`);
      }
      provisionAttachJob = {
        jobId: j.jobId,
        title: `Uninstalling "${label}"`,
      };
      addDaemonOpen = true;
      return true;
    } catch (e) {
      addToast({
        kind: "error",
        message: `Uninstall failed: ${e instanceof Error ? e.message : String(e)}`,
      });
      return false;
    }
  }

  type ConnectionDiagnosis = {
    ok: boolean;
    daemon: { label: string; host: string; port: number };
    localPort: number | null;
    reachable: boolean;
    latencyMs: number | null;
    steps: Array<{ label: string; ok: boolean; detail: string }>;
    summary: string;
  };

  /** Force-reconnect a remote daemon's SSH tunnel (POST .../reconnect). The
   *  daemon registry/tunnel is local, so NOT daemon-routed. Refreshes the
   *  row list on success so the online badge flips. */
  async function reconnectDaemon(
    daemonId: string,
  ): Promise<{ ok: boolean; error?: string }> {
    let res: Response;
    try {
      res = await fetch(apiUrl(`/api/daemons/${daemonId}/reconnect`), {
        method: "POST",
      });
    } catch (e) {
      // A bare fetch throw is a network-level failure (the browser's terse
      // "Load failed"/"NetworkError") — name what it actually means.
      return {
        ok: false,
        error: `couldn't reach the local daemon — is it running? (${e instanceof Error ? e.message : String(e)})`,
      };
    }
    const ct = res.headers.get("content-type") ?? "";
    if (!ct.includes("application/json")) {
      // HTML/empty ⇒ the route doesn't exist on this daemon build.
      return {
        ok: false,
        error: `unexpected response (HTTP ${res.status}${ct ? `, ${ct}` : ""}). Your local daemon may be an older build without the reconnect route — rebuild + restart it.`,
      };
    }
    const j = (await res.json().catch(() => null)) as {
      ok?: boolean;
      localPort?: number;
      error?: string;
    } | null;
    if (res.ok && j?.ok) {
      // The tunnel is back up, so flip this daemon's badge online NOW —
      // don't wait on load()'s fan-out. singleFlight() can coalesce our
      // refresh into a load() that started while the daemon was still
      // offline (its probe recorded online=false), which would otherwise
      // clobber the badge straight back to offline. Reassign a new Map so
      // Svelte sees the change, and re-assert after the refresh settles to
      // win against any such stale run. A genuinely-still-down tunnel is
      // corrected by the next organic load().
      const flipOnline = () => {
        const next = new Map(daemonsOnline);
        next.set(daemonId, true);
        daemonsOnline = next;
      };
      flipOnline();
      void load().then(flipOnline, flipOnline); // refresh rows; keep badge online
      return { ok: true };
    }
    return {
      ok: false,
      error: j?.error || `reconnect failed (HTTP ${res.status})`,
    };
  }

  /** Diagnose a remote daemon's connection (GET .../connection): ssh present
   *  → tunnel up → health probe, as an ordered checklist. Local route. */
  async function diagnoseDaemonConnection(
    daemonId: string,
  ): Promise<ConnectionDiagnosis> {
    let res: Response;
    try {
      res = await fetch(apiUrl(`/api/daemons/${daemonId}/connection`));
    } catch (e) {
      throw new Error(
        `couldn't reach the local daemon — is it running? (${e instanceof Error ? e.message : String(e)})`,
      );
    }
    const ct = res.headers.get("content-type") ?? "";
    if (!ct.includes("application/json")) {
      throw new Error(
        `unexpected response (HTTP ${res.status}${ct ? `, ${ct}` : ""}). Your local daemon may be an older build without this route — rebuild + restart it.`,
      );
    }
    const j = (await res.json().catch(() => null)) as
      | (Partial<ConnectionDiagnosis> & { error?: string })
      | null;
    if (!res.ok || !j || !Array.isArray(j.steps)) {
      throw new Error(j?.error || `diagnose failed (HTTP ${res.status})`);
    }
    return j as ConnectionDiagnosis;
  }

  /** Close the manage-daemon dialog and scroll the dashboard to a repo's
   *  row (rows carry data-repo-id). Two ticks so the dialog has unmounted
   *  and layout settled before scrollIntoView reads geometry. */
  /** Switch the zen-focused row to another repo while staying in zen.
   *  Used by the Projects menu and the dock's git-status arrow row:
   *  both normally scroll the page to a repo, which is a no-op in zen
   *  (every other row is hidden), so instead we re-point zen at that
   *  repo's primary worktree row. Restores the target worktree's
   *  visibility first (mirrors onDockPick) so its row element exists.
   *  No-op — returns false — when not in zen or the repo is unknown. */
  function switchZenToRepo(repoId: string): boolean {
    if (zenRowKey === null) return false;
    const repo = repos.find((r) => r.id === repoId);
    const wts = repo?.worktrees ?? [];
    if (!repo || wts.length === 0) return false;
    const diskPaths = wts.map((w) => w.path);
    const visible = effectiveVisibleWorktrees(
      repoPrefsKey(repo),
      diskPaths,
      visibleWorktreesByRepo,
    );
    // Prefer an already-visible worktree so its row is in the DOM; fall
    // back to the primary (first) worktree and restore its visibility.
    const targetPath =
      wts.find((w) => visible.includes(w.path))?.path ?? wts[0].path;
    if (!visible.includes(targetPath)) {
      visibleWorktreesByRepo = {
        ...visibleWorktreesByRepo,
        [repoPrefsKey(repo)]: [...visible, targetPath],
      };
    }
    const targetKey = `${repo.id}|${targetPath}`;
    if (zenRowKey !== targetKey) {
      zenRowKey = targetKey;
      notesShownInZen = false;
      resetZenMenu();
    }
    return true;
  }

  async function focusRepoRow(repoId: string): Promise<void> {
    // In zen, jump zen to the chosen project instead of scrolling — the
    // page scroll below is pointless when every other row is hidden.
    if (switchZenToRepo(repoId)) return;
    daemonDialogId = null;
    await tick();
    await tick();
    const el = document.querySelector(
      `[data-repo-id="${CSS.escape(repoId)}"]`,
    ) as HTMLElement | null;
    if (!el) return;
    el.scrollIntoView({ behavior: "smooth", block: "center" });
    el.classList.add("row-focus-flash");
    // Cover the 1s animation-delay + 0.8s animation before removing.
    setTimeout(() => el.classList.remove("row-focus-flash"), 2000);
  }

  /** Remove a worktree (the directory + git's per-worktree state slot).
   *  Defaults to refusing on dirty state — the daemon returns
   *  {dirty: true} in that case so we can offer a forced retry behind
   *  an extra confirm. Branch itself is never deleted; just the
   *  on-disk working tree. */
  async function removeWorktreeInRow(
    repoId: string,
    wt: { path: string; branch: string },
  ) {
    error = "";
    if (
      !confirm(
        `Remove worktree on branch \`${wt.branch}\`?\n\n${wt.path}\n\nThe directory will be deleted. The branch ref is kept and can be checked out again later.`,
      )
    ) {
      return;
    }
    async function call(force: boolean) {
      const res = await fetch(
        apiUrl(
          `/api/repos/${repoId}/worktrees`,
          daemonIdForRepoId(repos, repoId),
        ),
        {
          method: "DELETE",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ path: wt.path, force }),
        },
      );
      if (res.ok) return { ok: true as const };
      const body = (await res.json().catch(() => ({}))) as {
        error?: string;
        dirty?: boolean;
      };
      return { ok: false as const, ...body };
    }
    try {
      let result = await call(false);
      if (!result.ok && result.dirty) {
        if (
          !confirm(
            `${result.error}\n\nDiscard uncommitted/untracked changes and remove anyway?`,
          )
        ) {
          return;
        }
        result = await call(true);
      }
      if (!result.ok) throw new Error(result.error ?? "remove failed");
      // Drop any session columns / terminal state pointed at this worktree
      // from local state so the UI doesn't try to resume into a path that
      // no longer exists. (The reactive watcher persists this back to
      // storage; we don't need to call .save directly.)
      const repo = repos.find((r) => r.id === repoId);
      if (repo) {
        visibleWorktreesByRepo = hideVisibleWorktree(
          repoPrefsKey(repo),
          repo.worktrees.map((w) => w.path),
          visibleWorktreesByRepo,
          wt.path,
        );
      }
      const next = { ...openSessionsByWt };
      delete next[wt.path];
      openSessionsByWt = next;
      await load();
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
  }

  /** Cmd+Z / Cmd+Shift+Z target lookup. Pulls a fresh `/api/events`
   *  snapshot before picking, so a Ctrl+Z pressed in the gap between
   *  a POST/DELETE response and the SSE-triggered refresh still hits
   *  the latest event instead of an older sibling. */
  async function runWorkspaceUndoRedo(
    direction: "undo" | "redo",
  ): Promise<void> {
    let liveEvents: Event[];
    try {
      const res = await fetch(apiUrl("/api/events"));
      if (!res.ok) return;
      liveEvents = (await res.json()) as Event[];
    } catch {
      liveEvents = events;
    }
    const target =
      direction === "redo"
        ? liveEvents.find((ev) => ev.reversible && ev.undone)
        : liveEvents.find((ev) => ev.reversible && !ev.undone);
    if (!target) return;
    await toggleEvent(target.id, direction);
  }

  async function toggleEvent(id: string, toggle: "undo" | "redo") {
    error = "";
    try {
      const res = await fetch(apiUrl(`/api/events/${id}/${toggle}`), {
        method: "POST",
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      // Fast path: refresh just the events array (the "Recently
      // deleted" filter + Undo tray both read from it). Then kick
      // the full `load()` for repos/shells/titles in the
      // background — no need to await it before returning to the
      // caller, the SSE handler does the same thing redundantly.
      await refreshEvents();
      void load();
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
  }

  /** Restore a deleted note from a `remove_note` event and fly it
   *  back into its pin slot. Two cooperating moves: this function
   *  prepares App-level state (un-hide the destination row, capture
   *  the trigger button's rect), then hands off to the layer's
   *  `flyRestoreNote` so the same staging→pinned animation that
   *  powers `+ note` / `+ link` plays in reverse-of-delete. The
   *  origin rect is the Undo button itself, so the user's eye
   *  follows the chip from the popover row down to its pin. */
  async function undoNoteDelete(
    ev: Event,
    triggerEl: HTMLElement,
  ): Promise<void> {
    const note = ev.inverse?.note as
      | { id?: string; anchors?: string[] }
      | undefined;
    const noteId = note?.id;
    const anchor = note?.anchors?.[0];
    if (anchor) {
      const wtPath = anchor.startsWith("worktree:")
        ? anchor.slice("worktree:".length)
        : null;
      const repoPath = anchor.startsWith("repo:")
        ? anchor.slice("repo:".length)
        : null;
      for (const r of rows) {
        const matches = wtPath
          ? r.wt?.path === wtPath
          : repoPath
            ? !r.wt && r.repo.path === repoPath
            : false;
        if (!matches) continue;
        if (notesHiddenByRow[r.key]) {
          notesHiddenByRow = { ...notesHiddenByRow, [r.key]: false };
        }
        if (zenRowKey === r.key && !notesShownInZen) {
          notesShownInZen = true;
        }
        break;
      }
    }
    // Snapshot the trigger's rect *before* the await — the popover
    // may close (or reflow) by the time toggleEvent + the SSE
    // refetch resolve, at which point the live element's rect would
    // be wrong or zero. Then register the fly-in intent *before*
    // toggleEvent so the layer's refresh (driven by the same SSE
    // round-trip we're about to kick off) can stage the note at
    // this rect in the first render pass — otherwise the note
    // renders at its pin slot, the await chain unblocks 1-2s later,
    // and the fly teleports back to origin before animating.
    const originRect = triggerEl.getBoundingClientRect();
    if (noteId) {
      flyRestoreNote({ id: noteId, originRect });
    }
    await toggleEvent(ev.id, "undo");
  }

  /** Apps that count as a "git client" — when the user clicks one,
   *  remember it as their preferred client so commit-link chips
   *  reuse it. Today this is just Fork (the single dedicated git
   *  GUI in OpenInActions); SourceTree / Tower / GitKraken slot in
   *  here when they're added, no commit-chip code changes needed. */
  const GIT_CLIENT_APPS = new Set(["fork"]);
  const GIT_CLIENT_PREF_KEY = "supergit:preferred-git-client";

  async function openIn(path: string, app: string) {
    error = "";
    // Side-effect: remember the user's last git-client choice. The
    // commit-link chip's openTarget reads the same key.
    if (GIT_CLIENT_APPS.has(app)) {
      try {
        localStorage.setItem(GIT_CLIENT_PREF_KEY, app);
      } catch {
        // Quota / private mode — non-essential, ignore.
      }
    }
    try {
      const res = await fetch(apiUrl("/api/open"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path, app }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
  }

  function openRemote(remote: RemoteRef) {
    if (!remote.webUrl) return;
    openUrl(remote.webUrl);
  }

  /** Toggle the persisted "is the source-control foldout open" flag for
   *  a worktree. Loading the actual diffs + commits is the
   *  SourceControlPane's job — it reacts to the `expanded` prop. */
  function toggleCommits(wtPath: string) {
    error = "";
    commitsExpanded = {
      ...commitsExpanded,
      [wtPath]: !commitsExpanded[wtPath],
    };
    persistExpanded();
  }

  async function loadEditors() {
    try {
      const res = await fetch(apiUrl("/api/editors"));
      if (!res.ok) return;
      editors = await res.json();
    } catch {
      // ignore
    }
  }

  async function refreshRunningCommands(): Promise<void> {
    try {
      const res = await fetch(apiUrl("/api/commands/running"));
      if (!res.ok) return;
      const body = (await res.json()) as { running: { linkId: string }[] };
      runningCommandIds = new Set(body.running.map((r) => r.linkId));
    } catch {}
  }

  async function refreshCommandUrls(): Promise<void> {
    try {
      const res = await fetch(apiUrl("/api/commands/urls"));
      if (!res.ok) return;
      const body = (await res.json()) as { urls: Record<string, string[]> };
      commandUrls = body.urls;
    } catch {}
  }

  /** A REMOTE daemon's `change` event. We deliberately handle ONLY the two
   *  things that affect how a remote row renders: a repos refresh (so the
   *  row's worktrees/counters update — load() fans out to all daemons) and
   *  a notes-key bump (remote notes are merged in #17). Everything else in
   *  the local handler (sound_play, toasts, fs_change tooltips, messages,
   *  peerDiscovery, commands) is LOCAL-MACHINE UX that must NOT fire from a
   *  remote stream — firing it would double-toast / play sounds for another
   *  box's activity. Keeping this narrow is what makes #15a low-risk. */
  function handleRemoteStreamChange(rawData: unknown): void {
    if (typeof rawData !== "string") return;
    let payload: { kind?: string } = {};
    try {
      payload = JSON.parse(rawData);
    } catch {
      return;
    }
    if (changeKindRequiresReposReload(payload.kind))
      void load(`remote-sse:${payload.kind ?? "unknown"}`);
    if (
      payload.kind === "note_create" ||
      payload.kind === "note_update" ||
      payload.kind === "note_delete" ||
      payload.kind === "undo" ||
      payload.kind === "redo"
    ) {
      notesChangeKey++;
    }
  }

  /** Open one EventSource per ONLINE remote daemon so remote-side changes
   *  live-refresh the UI (no manual reload). /api/daemons/<id>/stream
   *  already proxies SSE incrementally through the tunnel. Idempotent +
   *  reactive: re-running opens streams for newly-online daemons and closes
   *  them for ones that went offline / were removed. Returns a teardown. */
  let remoteStreams = new Map<string, EventSource>();
  function syncRemoteStreams(): void {
    const online = new Set(
      remoteDaemons
        .filter((d) => daemonsOnline.get(d.id) !== false)
        .map((d) => d.id),
    );
    // Close streams for daemons no longer online/registered.
    for (const [id, es] of remoteStreams) {
      if (!online.has(id)) {
        es.close();
        remoteStreams.delete(id);
      }
    }
    // Open streams for newly-online daemons.
    for (const id of online) {
      if (remoteStreams.has(id)) continue;
      const es = new EventSource(apiUrl("/api/stream", id));
      es.addEventListener("change", (e: MessageEvent) =>
        handleRemoteStreamChange(e?.data),
      );
      // No activity/error/sound wiring — those are local-machine concerns.
      remoteStreams.set(id, es);
    }
  }
  function closeRemoteStreams(): void {
    for (const es of remoteStreams.values()) es.close();
    remoteStreams.clear();
  }

  // Keep the remote SSE streams in lockstep with the daemon set + their
  // online state: adding a daemon opens its stream, removing one (or it
  // going offline) closes it. Referencing both reactive sources here makes
  // Svelte re-run syncRemoteStreams() on any change. Before the first
  // load() populates remoteDaemons it's a no-op (empty set). EventSource is
  // browser-only, which is fine — supergit's UI is a client-only SPA.
  $: if (remoteDaemons || daemonsOnline) syncRemoteStreams();

  function subscribeToStream(): () => void {
    const es = new EventSource(apiUrl("/api/stream"));
    es.addEventListener("change", (rawEvt: MessageEvent) => {
      time("sse-change", () => {
        // Parse first so we can gate the two expensive refetches on the
        // payload kind. Before this gate `load()` ran for every "change"
        // event including chatty notifications (sound_play, note_*,
        // undo/redo, peerDiscovery, command_*, message_*,
        // session_invite_*), each one triggering a fresh `/api/repos`
        // streaming response — easily 500–1000 ms server-side. See
        // `sse-change-kinds.ts` for the kind taxonomy.
        const data = rawEvt?.data;
        let payload: { kind?: string; path?: string } = {};
        if (typeof data === "string") {
          try {
            payload = JSON.parse(data);
          } catch {
            // Non-JSON payload — treat as "kind unknown" so the gates
            // both skip; pre-fix we always called load(), but a payload
            // we can't parse can't be a real mutation either.
          }
        }
        // Cheap events-only refetch so the notes-list popover ("Recently
        // deleted" + Undo) and the Undo tray pick up the new event
        // within one round-trip. Gated to skip notifications that don't
        // write to events.jsonl.
        if (changeKindRequiresEventsReload(payload.kind)) {
          void refreshEvents();
        }
        // Refresh /api/repos so worktree-row counters reflect the change.
        // Gated to skip kinds that don't affect repo enrichment.
        if (
          changeKindRequiresReposReload(payload.kind) &&
          payload.kind !== "fs_change"
        ) {
          void load(`sse:${payload.kind ?? "unknown"}`);
        }
        // A remote daemon was added/removed (registry edit, provision, or
        // uninstall success). load() re-reads /api/daemons and re-fans-out,
        // so the Daemons list + that daemon's repo rows update reactively —
        // independent of the add/uninstall dialog's lifecycle. These are rare
        // user-driven events, so the load() cost is a non-issue.
        else if (changeKindRequiresDaemonsReload(payload.kind)) {
          void load(`daemon:${payload.kind ?? "unknown"}`);
        }

        // Daemon-side FS-change broadcast: `{ kind: "fs_change", path }`.
        // SourceControlPane owns the diff cache per row; we just bump the
        // worktree's fsChangeKey counter so it reacts and refetches.
        if (typeof data !== "string") return;
        if (payload.kind === "sound_play") {
          const tag = (payload as { tag?: string }).tag;
          const tid = (payload as { termId?: string }).termId;
          if (!tag) return;
          if (!document.hasFocus()) return;
          if (tid) {
            const col = document.querySelector(
              `.session-col[data-session-source*="${CSS.escape(tid)}"]`,
            );
            if (!col) return;
            const rect = col.getBoundingClientRect();
            if (rect.right < 0 || rect.left > window.innerWidth) return;
          }
          play(tag as any);
          return;
        }
        if (
          payload.kind === "note_create" ||
          payload.kind === "note_update" ||
          payload.kind === "note_delete"
        ) {
          notesChangeKey++;
          return;
        }
        // Undo / redo toggles re-broadcast as `{ kind: "undo"|"redo",
        // eventId }`. We don't know from the payload whether the
        // underlying event was a note operation, so just bump the
        // change key on every toggle — re-fetching /api/notes is cheap
        // and avoids the "undo works after reload but UI doesn't
        // update" bug where a restored note stayed invisible until
        // the next page load.
        if (payload.kind === "undo" || payload.kind === "redo") {
          notesChangeKey++;
          return;
        }
        if (payload.kind === "session_invite_received") {
          // Persistent toast — stays until the user clicks the body
          // (which opens the accept/decline dialog) or the × close button.
          const offerId = (payload as { offerId?: unknown }).offerId;
          if (typeof offerId === "string") {
            addToast({
              kind: "invite",
              title: "Session invite",
              message: "click to review",
              onClick: () => openInvite(offerId),
              persist: true,
            });
          }
          return;
        }
        if (payload.kind === "message_received") {
          // Refresh the inbox snapshot, then surface a toast unless the
          // sender is currently muted. The toast is auto-dismiss so it
          // doesn't pile up; the badge on the Inbox pill is the
          // persistent surface.
          const muted = (payload as { muted?: unknown }).muted === true;
          const from = (payload as { from?: { label?: unknown } }).from;
          const label =
            from && typeof from.label === "string" ? from.label : "a peer";
          const rawPreview = (payload as { preview?: unknown }).preview;
          const preview =
            typeof rawPreview === "string" && rawPreview.trim()
              ? rawPreview.trim()
              : "";
          void refreshMessages();
          if (!muted) {
            play("message-receive");
            addToast({
              kind: "info",
              title: `Message from ${label}`,
              message: preview
                ? `“${preview}”`
                : "click the Inbox pill to read",
              messageItalic: true,
            });
          }
          return;
        }
        if (
          payload.kind === "message_mute" ||
          payload.kind === "message_unmute" ||
          payload.kind === "message_deleted"
        ) {
          void refreshMessages();
          return;
        }
        // Task queue mutated (by this client, another browser, or an agent via
        // the CLI). Refetch this daemon's tasks; refreshTasks de-dupes a burst
        // of these into a single GET, and each QueueColumn reads its own slice.
        if (
          payload.kind === "add_task" ||
          payload.kind === "update_task" ||
          payload.kind === "remove_task"
        ) {
          void refreshTasks();
          return;
        }
        if (payload.kind === "peerDiscovery") {
          peerDiscoveryEnabled =
            (payload as { enabled?: unknown }).enabled === true;
          return;
        }
        if (
          payload.kind === "command_start" ||
          payload.kind === "command_exit"
        ) {
          void refreshRunningCommands();
          return;
        }
        if (payload.kind === "command_url") {
          const { linkId, urls } = payload as {
            linkId?: string;
            urls?: string[];
          };
          if (linkId && urls) {
            commandUrls = { ...commandUrls, [linkId]: urls };
          }
          return;
        }
        if (
          payload.kind === "session_copied" ||
          payload.kind === "session_imported"
        ) {
          void load();
          return;
        }
        if (payload.kind !== "fs_change" || typeof payload.path !== "string")
          return;
        fsChangeBatcher.push(payload.path);
      }); // end time("sse-change", ...)
    });
    es.addEventListener("activity", (rawEvt: MessageEvent) => {
      try {
        const ev = JSON.parse(rawEvt.data) as ActivityEvent;
        const existing = activityByCwd[ev.cwd] ?? [];
        const next = [ev, ...existing].slice(0, MAX_ACTIVITY);
        activityByCwd = { ...activityByCwd, [ev.cwd]: next };
        // Stamp the real agent-side session id onto any matching
        // `__new__:` column so a subsequent reload spawns
        // `claude --resume <sid>` (resp. `codex resume <sid>`) instead
        // of bare `claude`. No-op when the column is already stamped or
        // the cwd has no transient column for this agent.
        const { byWt: stamped, stampedSource } =
          stampDiscoveredSessionIdWithDetail(openSessionsByWt, ev);
        if (stamped !== openSessionsByWt) openSessionsByWt = stamped;
        // Once stamped AND we have a real JSONL source, promote the
        // column from `__new__:` to the real source so it renders as
        // SessionView. Carry the daemon termId so SessionView
        // reattaches to the live PTY via attachTermId.
        if (stampedSource && ev.source) {
          const realSource = ev.source!;
          if (editingTitleSources.has(stampedSource)) {
            deferredPromotions.push({ stampedSource, realSource, cwd: ev.cwd });
          } else {
            executePromotion(stampedSource, realSource, ev.cwd);
          }
        }
      } catch {
        // ignore malformed
      }
    });
    es.addEventListener("error", (rawEvt: MessageEvent) => {
      // Custom "error" event from the daemon (a recorded ErrorEntry).
      // EventSource also fires `error` for transport errors but those
      // arrive as plain Events without a `data` field, so the try/parse
      // guards us either way.
      const data = (rawEvt as MessageEvent).data;
      if (typeof data !== "string") return;
      try {
        const entry = JSON.parse(data) as FrontendErrorEntry;
        if (entry?.id && entry?.message) pushError(entry);
      } catch {
        // ignore malformed
      }
    });
    es.addEventListener("error_clear", () => {
      errorEntries = [];
    });
    es.onopen = () => {
      streamConnected = true;
      // After a daemon restart (bun --watch, crash, prod upgrade) the
      // FS watchers were torn down and any git changes during the gap
      // were missed. Re-fetch everything on reconnect so the UI always
      // catches up to reality.
      void load();
    };
    es.onerror = () => {
      streamConnected = false;
    };
    return () => es.close();
  }

  /** Notes whose first usable anchor doesn't resolve to any
   *  currently-registered repo / worktree. These are the rows that
   *  show up in the orphan-notes tray so the user can re-anchor or
   *  delete them. */
  $: orphanNotes = $notesAll.filter((n) => {
    const a = n.anchors[0];
    if (!a) return true;
    if (a.startsWith("worktree:")) {
      const path = a.slice("worktree:".length);
      return !repos.some((r) => r.worktrees?.some((w) => w.path === path));
    }
    if (a.startsWith("repo:")) {
      const path = a.slice("repo:".length);
      return !repos.some((r) => r.path === path);
    }
    return false;
  });

  async function reassignOrphan(noteId: string, anchor: string): Promise<void> {
    const note = $notesAll.find((n) => n.id === noteId);
    if (!note) return;
    // Keep auxiliary anchors (commit:..., session:...) when rewriting
    // the primary placement.
    const others = note.anchors.filter(
      (a) => !a.startsWith("worktree:") && !a.startsWith("repo:"),
    );
    const nextAnchors = [anchor, ...others];
    try {
      const res = await fetch(
        apiUrl(`/api/notes/${encodeURIComponent(noteId)}`, note.daemonId),
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ anchors: nextAnchors }),
        },
      );
      if (!res.ok) return;
      orphanReanchorFor = null;
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
  }

  async function deleteOrphan(noteId: string): Promise<void> {
    const orphanNote = $notesAll.find((n) => n.id === noteId);
    try {
      const res = await fetch(
        apiUrl(
          `/api/notes/${encodeURIComponent(noteId)}`,
          orphanNote?.daemonId,
        ),
        {
          method: "DELETE",
        },
      );
      if (!res.ok) return;
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
  }

  // BLINK_AHEAD_MINUTES + aheadAged() live in ./ahead-age (imported
  // above) so the threshold math is unit-testable without standing up
  // the component.

  function aheadTooltip(b: BranchStatus): string {
    const count = pushCount(b);
    const noun = count === 1 ? "commit" : "commits";
    // No upstream → these commits are on no remote-tracking ref at all,
    // so there's no "→ origin/x" target to name; say so plainly.
    const base = b.upstream
      ? `${count} ${noun} to push → ${b.upstream}`
      : `${count} ${noun} on no remote`;
    if (!b.aheadOldestTime) return base;
    return `${base} · oldest ${relTime(b.aheadOldestTime)}`;
  }

  /** Per-worktree fetched detail for the row-status / ↑N hover
   *  tooltips. Populated lazily on first hover via /api/wt-summary.
   *  Sentinel `"loading"` is set synchronously when the request goes
   *  out so a second hover during the round-trip doesn't re-fire. */
  interface WtCommit {
    sha: string;
    subject: string;
    /** Author name (`%an`). Empty string when the daemon couldn't read it
     *  (e.g. legacy-format response from a stale prod build). */
    author?: string;
    /** Relative date string (`%ar`, e.g. "2 hours ago"). Empty string in
     *  the same legacy/error case as `author`. */
    date?: string;
  }
  interface NumstatEntry {
    added: number;
    removed: number;
    binary: boolean;
  }
  interface WtSummary {
    staged: string[];
    unstaged: string[];
    untracked: string[];
    /** Local commits ahead of upstream (↑N tooltip). */
    unpushedCommits: WtCommit[];
    /** Upstream commits ahead of local (↓N tooltip). Capped server-side
     *  at 20; the tooltip further caps display at the first 10. Optional
     *  for backwards-compat with older daemon builds. */
    unfetchedCommits?: WtCommit[];
    /** Per-path added/removed line counts for working-tree files
     *  (unstaged + synthesised untracked). Misses render as no count.
     *  Optional for back-compat with older daemon builds. */
    stats?: Record<string, NumstatEntry>;
    /** Per-path added/removed line counts for staged files (index vs
     *  HEAD). Optional for back-compat. */
    stagedStats?: Record<string, NumstatEntry>;
  }
  /** Hard cap on commits rendered per tooltip. The daemon already caps at
   *  20; this trims further to keep the hover overlay glanceable. */
  const COMMIT_TOOLTIP_LIMIT = 10;
  let wtSummaryByPath: Record<string, WtSummary | "loading"> = {};
  /** Worktrees whose cached summary is known-stale (an fs_change landed) but
   *  still worth showing until a hover refreshes it in place. We mark stale
   *  instead of deleting so the tooltip/dock preview keeps showing the prior
   *  changed-files list rather than blanking to "Loading…". */
  let wtSummaryStale: Record<string, boolean> = {};
  /** Worktrees with a refresh fetch in flight that already have data shown —
   *  drives a small inline spinner alongside the existing content. */
  let wtSummaryRefreshing: Record<string, boolean> = {};

  async function loadWtSummary(
    path: string,
    opts: { force?: boolean } = {},
  ): Promise<void> {
    const cur = wtSummaryByPath[path];
    const stale = !!wtSummaryStale[path];
    // A fetch is already in flight for this path — don't pile on.
    if (cur === "loading" || wtSummaryRefreshing[path]) return;
    // Fresh cached data and no reason to refetch → serve it instantly.
    if (!opts.force && cur && !stale) return;
    if (!cur) {
      // First load, no prior data — the only time we show a bare "Loading…".
      wtSummaryByPath = { ...wtSummaryByPath, [path]: "loading" };
    } else {
      // Refresh in place: keep the existing content visible and flag a spinner
      // instead of flickering through an empty state.
      wtSummaryRefreshing = { ...wtSummaryRefreshing, [path]: true };
    }
    try {
      const qs = new URLSearchParams({ path });
      const res = await fetch(
        apiUrl(
          `/api/wt-summary?${qs.toString()}`,
          daemonIdForWorktreePath(repos, path),
        ),
      );
      if (!res.ok) {
        // Drop the "loading" sentinel so the next hover retries. Don't
        // wipe real cached data on a transient failure — better to
        // show slightly-stale numbers than nothing.
        if (wtSummaryByPath[path] === "loading") {
          const next = { ...wtSummaryByPath };
          delete next[path];
          wtSummaryByPath = next;
        }
        return;
      }
      const data = (await res.json()) as WtSummary;
      wtSummaryByPath = { ...wtSummaryByPath, [path]: data };
      if (wtSummaryStale[path]) {
        const next = { ...wtSummaryStale };
        delete next[path];
        wtSummaryStale = next;
      }
    } catch {
      if (wtSummaryByPath[path] === "loading") {
        const next = { ...wtSummaryByPath };
        delete next[path];
        wtSummaryByPath = next;
      }
    } finally {
      if (wtSummaryRefreshing[path]) {
        const next = { ...wtSummaryRefreshing };
        delete next[path];
        wtSummaryRefreshing = next;
      }
    }
  }

  // Flat list of rendered rows. Each repo contributes ONE row per
  // worktree the user has chosen to show (via the worktrees picker),
  // not one per worktree on disk. A repo with no checked worktrees
  // still appears as a placeholder so the user can find it via its
  // picker. Placeholder also covers the "registered path has no
  // worktrees yet" edge case.
  $: rawRows = repos.flatMap((repo) => {
    const diskPaths = repo.worktrees.map((w) => w.path);
    const visiblePaths = effectiveVisibleWorktrees(
      repoPrefsKey(repo),
      diskPaths,
      visibleWorktreesByRepo,
    );
    if (visiblePaths.length === 0) {
      // Non-git folders only ever have a single synthetic worktree — the
      // folder itself. Hiding it via the picker would leave the user with
      // no row to start a terminal/agent from (and no way to un-hide it
      // since the picker lives on a worktree row). Always render the
      // synthetic so the row stays interactive.
      const synthetic = repo.worktrees.find((w) => w.nonGit);
      if (synthetic) {
        return [
          {
            repo,
            wt: synthetic,
            key: `${repoPrefsKey(repo)}|${synthetic.path}`,
          },
        ];
      }
      return [
        {
          repo,
          wt: null as Worktree | null,
          key: `${repoPrefsKey(repo)}|none`,
        },
      ];
    }
    return visiblePaths.map((path) => {
      const wt = repo.worktrees.find((w) => w.path === path)!;
      return { repo, wt, key: `${repoPrefsKey(repo)}|${wt.path}` };
    });
  });
  // Drop duplicate row keys (e.g. the same repo accidentally tracked twice).
  // The keyed {#each rows (row.key)} mis-reconciles on duplicate keys — it
  // recreates the row's DOM on every reactive tick, which tears down the
  // color <input> mid-edit and snaps the picker back to the old value.
  $: rows = (() => {
    const seen = new Set<string>();
    return rawRows.filter((r) => {
      if (seen.has(r.key)) return false;
      seen.add(r.key);
      return true;
    });
  })();

  // Only "real" actions in the dropdown; toggle events are hidden.
  $: visibleEvents = events.filter(
    (e) => e.type !== "undo" && e.type !== "redo",
  );

  /** Reactive index of pending (not-yet-undone) `remove_note` events
   *  bucketed by their first anchor. Drives the per-row notes-list
   *  popover's "Recently deleted" section. Computed at script scope
   *  rather than inline `{@const}` inside the popover so Svelte's
   *  dep tracking on `events` is unambiguous — the inline version
   *  was losing reactivity on certain SSE round-trips. */
  $: removeNoteEventsByAnchor = (() => {
    const out: Record<string, Event[]> = {};
    for (const e of events) {
      if (e.type !== "remove_note") continue;
      if (e.undone) continue;
      if (!e.reversible) continue;
      const anchor = (e.inverse?.note?.anchors as string[] | undefined)?.[0];
      if (!anchor) continue;
      (out[anchor] ??= []).push(e);
    }
    return out;
  })();

  /** Per worktree: which session sources are currently matched by the
   *  inline strip search, and which matches are *not* yet open as a
   *  column (those become the synthetic "more matches" pseudo-column).
   *  Absent entry / empty query → strip renders without filtering. */
  // StripFilter + the pure derive now live in strip-search-manager.ts.
  // Referencing all three inputs directly in the `$:` keeps Svelte's
  // reactive dependency tracking intact.
  let stripFilterByWt: Record<string, StripFilter> = {};
  $: stripFilterByWt = computeStripFilterByWt(
    stripSearchQuery,
    pickerSessionsByWt,
    openSessionsByWt,
  );

  /** wt.path → agents + shells merged, sorted by lastActive desc.
   *  Drives the "+N sessions in this worktree" picker. Dead shells with
   *  zero captured commands are hidden — they're empty terminals that
   *  were opened and closed without typing anything, just visual noise.
   *  Alive shells are always kept (user may be mid-type). */
  $: pickerSessionsByWt = ((): Record<string, AgentSession[]> => {
    const m: Record<string, AgentSession[]> = {};
    for (const repo of repos) {
      for (const wt of repo.worktrees ?? []) {
        const merged: AgentSession[] = [...(wt.agents ?? [])];
        for (const sh of allShells) {
          if (sh.wt !== wt.path) continue;
          if (!sh.alive && (sh.cmdCount ?? 0) === 0) continue;
          merged.push(shellToSession(sh));
        }
        merged.sort(
          (a, b) => Date.parse(b.lastActive) - Date.parse(a.lastActive),
        );
        m[wt.path] = merged;
      }
    }
    return m;
  })();

  /** Currently-active TUIs per worktree: the subset of
   *  `pickerSessionsByWt` whose mounted column has live terminal evidence
   *  from `/api/terminals`. Persisted `mode: "terminal"` only says which
   *  surface to reopen; it is not a liveness signal. */
  $: activeTuisByWt = ((): Record<string, AgentSession[]> => {
    const m: Record<string, AgentSession[]> = {};
    for (const wtPath of Object.keys(pickerSessionsByWt)) {
      const openKeys = new Set<string>();
      for (const o of openSessionsByWt[wtPath] ?? []) {
        if (
          openSessionHasLiveTerminal(o, {
            liveTerminalIds,
            newTermIds,
            transientExited,
          })
        ) {
          for (const key of sessionSurfaceKeys(o)) openKeys.add(key);
        }
      }
      if (openKeys.size === 0) {
        m[wtPath] = [];
        continue;
      }
      m[wtPath] = (pickerSessionsByWt[wtPath] ?? []).filter((s) =>
        sessionMatchesKnownKeys(s, openKeys),
      );
    }
    return m;
  })();

  /** Side-dock entries: one per currently-open session column, with the
   *  colors / metadata SessionDock needs to render the dot + hover
   *  tooltip. Pulls `working`/`awaiting` from per-source transient maps;
   *  those may come from a terminal PTY or a visual/API-backed session.
   *
   *  `exited` means "inactive for the dock" rather than "no live terminal
   *  transport"; visual sessions can report working/awaiting without owning
   *  a PTY and must still survive the active-only dock filter. */
  type DockAgent = "claude" | "codex" | "copilot" | "ollama" | "shell";
  $: dockEntries = time(
    "dockEntries",
    (): Array<{
      source: string;
      wtPath: string;
      rowKey: string;
      repoId: string;
      agent: DockAgent;
      repoColor?: string;
      repoName: string;
      branch?: string;
      title?: string;
      manualTitle?: string;
      aiTitle?: string;
      lastUserMessage?: string;
      lastActive?: string;
      lastMessageTs?: string;
      /** JSONL path the dock can fetch via `/api/session?source=…` to
       *  show the last few user/assistant messages on hover. Undefined
       *  for shells and for `__new__:` columns that haven't been
       *  stamped with a `resumeSessionId` yet. */
      transcriptSource?: string;
      resumeSessionId?: string;
      working: boolean;
      awaiting: boolean;
      /** True once this column has no live PTY transport. The side dock
       *  dims these rows without changing marker size. */
      exited: boolean;
      terminalActive: boolean;
      /** ms timestamp of the most recent working→idle transition.
       *  Drives the dock dot's "unread" pulse — set when the AI
       *  just finished a turn the user hasn't focused yet. Cleared
       *  by the dock's 20-min auto-expiry or by App's on:pick
       *  handler when the user opens the session. */
      finishedAt?: number;
      ioDebugLabel?: string;
    }> => {
      const out: ReturnType<typeof Array> = [] as any;
      for (const repo of repos) {
        for (const wt of repo.worktrees ?? []) {
          const opens = openSessionsByWt[wt.path];
          if (!opens || opens.length === 0) continue;
          const known = pickerSessionsByWt[wt.path] ?? [];
          const bySource = new Map<string, (typeof known)[number]>();
          for (const a of known) bySource.set(a.source, a);
          const knownSources = new Set<string>();
          for (const a of known) {
            for (const key of sessionSurfaceKeys(a)) knownSources.add(key);
          }
          const rowKey = `${repo.id}|${wt.path}`;
          for (const s of opens) {
            // Live TUI means the column can point at an actual live PTY
            // from `/api/terminals`. Persisted terminal mode alone is only
            // a surface preference, not proof that the agent is still
            // running.
            const isLiveTui = openSessionHasLiveTerminal(s, {
              liveTerminalIds,
              newTermIds,
              transientExited,
            });
            // Skip real (file-backed) sessions the daemon doesn't associate
            // with THIS worktree. A session whose JSONL belongs to another
            // repo but got filed under this worktree's open-sessions list
            // would otherwise render as a phantom dot labelled with this
            // worktree's branch (e.g. a needle-logs-view session showing as
            // "supergit main"). The sessions-strip already drops these via
            // filterToExistingSessions; this is the same per-worktree gate.
            // A live TUI is exempt: its PTY cwd is reconcile-matched to this
            // worktree, so it is authoritative even before the deferred
            // per-worktree agent scan has populated `knownSources`. A session
            // the user explicitly opened as a terminal (mode + resumeSessionId)
            // is likewise theirs for this worktree and must show at startup
            // before its PTY is (re-)spawned — without these exemptions,
            // restored agents stay absent from the dock until their row is
            // scrolled into view and the scan lands.
            const isRestorableTui = s.mode === "terminal" && !!s.resumeSessionId;
            if (
              dockSessionHiddenAsForeign(s, knownSources, {
                isLiveTui,
                isRestorableTui,
              })
            )
              continue;
            // Utility panels (file browser, git history) are browsing
            // views, not sessions — skip them in the activity dock.
            // Agent and shell sessions appear regardless of mode
            // (terminal or read-only).
            if (
              s.agent === "files" ||
              s.agent === "history" ||
              s.source.startsWith("__files__:") ||
              s.source.startsWith("__remote__:") ||
              s.source.startsWith("__restore__:") ||
              s.source.startsWith("__history__:")
            )
              continue;
            const hasDockActivity = openSessionHasDockActivity(s, {
              liveTerminalIds,
              newTermIds,
              transientExited,
              transientWorking,
              transientAwaiting,
            });
            // Same lookup precedence as the NewSessionCol render: once a
            // sid is stamped onto a `__new__:` column, prefer the matched
            // real-source agent's metadata so the dock shows the title
            // bound to the live conversation rather than whatever landed
            // on the disposable synthetic key.
            const realMeta = s.resumeSessionId
              ? known.find(
                  (a) =>
                    a.agent === s.agent && a.sessionId === s.resumeSessionId,
                )
              : undefined;
            const meta = realMeta ?? bySource.get(s.source);
            const titleSource = resolveTitleSource(s, known);
            const terminalIoStats = $terminalIoStatsByKey[s.source];
            const ioStats =
              $showTerminalIoDebug === true ? terminalIoStats : undefined;
            out.push({
              source: s.source,
              wtPath: wt.path,
              rowKey,
              repoId: repo.id,
              agent: s.agent,
              repoColor: repo.color,
              repoName: repo.name ?? repoName(repo),
              branch: wt.branch,
              title: meta?.title,
              manualTitle:
                meta?.manualTitle ??
                newSessionTitles[titleSource] ??
                newSessionTitles[s.source],
              aiTitle: meta?.aiTitle,
              lastUserMessage: meta?.lastUserMessage,
              lastActive: meta?.lastActive,
              lastMessageTs: meta?.lastMessageTs,
              recentMessageCount: meta?.recentMessageCount,
              resumeSessionId: s.resumeSessionId,
              transcriptSource:
                meta?.source && !meta.source.startsWith("__")
                  ? meta.source
                  : undefined,
              // Shells emit output continuously (log tails, dev-server
              // streams, REPLs) — none of that is "thinking", so we
              // never surface a working/awaiting state for them in the
              // dock. The shell dot stays static; its live-PTY state
              // is conveyed by its dedicated terminal-style square
              // (vs. the round agent dot).
              working:
                s.agent === "shell" ? false : !!transientWorking[s.source],
              awaiting:
                s.agent === "shell" ? false : !!transientAwaiting[s.source],
              // Inactive covers sessions with neither a live terminal
              // transport nor live visual/API activity. A visual
              // app-server turn can be active without a PTY, so don't
              // dim/filter it merely because it is displayed as chat.
              exited: !hasDockActivity,
              terminalActive:
                isLiveTui &&
                isTerminalRecentlyActive(terminalIoStats, Date.now()),
              finishedAt: transientFinishedAt[s.source],
              ioDebugLabel: ioStats
                ? `in ${formatTerminalIoRate(ioStats.rxBytesPerSec)}`
                : undefined,
            });
          }
        }
      }
      // No sort — the iteration order (repos × worktrees × open
      // sessions) already mirrors the dashboard's vertical layout and
      // the user's manual session ordering. Reordering within a repo
      // group causes the dock dots to jump around and is disorienting.
      return out as any;
    },
  );

  $: projectMenuEntries = repos.map((repo) => {
    const dock = dockEntries.filter((entry) => entry.repoId === repo.id);
    const sessions = (repo.worktrees ?? []).flatMap(
      (wt) => pickerSessionsByWt[wt.path] ?? [],
    );
    let latestActivity: string | undefined;
    for (const session of sessions) {
      const ts = session.lastMessageTs ?? session.lastActive;
      if (
        ts &&
        (!latestActivity || Date.parse(ts) > Date.parse(latestActivity))
      ) {
        latestActivity = ts;
      }
    }
    let liveCount = 0;
    let working = false;
    let awaiting = false;
    for (const entry of dock) {
      if (entry.exited) continue;
      liveCount += 1;
      working = working || entry.working || entry.terminalActive;
      awaiting = awaiting || entry.awaiting;
    }
    return {
      repo,
      latestActivity,
      liveCount,
      working,
      awaiting,
    };
  });

  /** Per-repo push/pull/dirty status for the dock's arrow indicators.
   *  Aggregates across all worktrees in each repo. Only repos with
   *  ahead > 0 or behind > 0 render an arrow; the dirty/staged/
   *  unstaged counts surface in the hover label. */
  $: dockRepoStatuses = repos.map((repo) => {
    const diskPaths = (repo.worktrees ?? []).map((w) => w.path);
    const visible = new Set(
      effectiveVisibleWorktrees(
        repoPrefsKey(repo),
        diskPaths,
        visibleWorktreesByRepo,
      ),
    );
    let ahead = 0;
    let behind = 0;
    let aheadDanger = false;
    let staged = 0;
    let unstaged = 0;
    let untracked = 0;
    let submoduleChanges = 0;
    for (const wt of repo.worktrees ?? []) {
      if (!visible.has(wt.path)) continue;
      if (wt.branchStatus) {
        ahead += pushCount(wt.branchStatus);
        behind += wt.branchStatus.behind;
        aheadDanger = aheadDanger || pushBadgeDanger(wt.branchStatus);
      }
      if (wt.fileStatus) {
        staged += wt.fileStatus.staged;
        unstaged += wt.fileStatus.unstaged;
        untracked += wt.fileStatus.untracked;
        submoduleChanges += wt.fileStatus.submoduleChanges ?? 0;
      }
    }
    return {
      repoId: repo.id,
      repoColor: repo.color,
      repoName: repo.name ?? repoName(repo),
      ahead,
      behind,
      aheadDanger,
      staged,
      unstaged,
      untracked,
      submoduleChanges,
    };
  });

  /** Per-repo breakdown of visible worktrees with their individual
   *  push/pull/dirty signals. Feeds the dock's arrow-row hover
   *  preview so it can list each worktree's unpushed/unfetched
   *  commits and changed files (same content as the worktree-row
   *  tooltips, grouped by worktree). Computed alongside
   *  dockRepoStatuses so the visibility filter stays in sync. */
  $: dockRepoWorktrees = (() => {
    const out: Record<
      string,
      Array<{
        path: string;
        branch: string;
        ahead: number;
        behind: number;
        dirty: number;
        upstream: string | null;
        aheadDanger: boolean;
        daemonId: string | undefined;
      }>
    > = {};
    for (const repo of repos) {
      const diskPaths = (repo.worktrees ?? []).map((w) => w.path);
      const visible = new Set(
        effectiveVisibleWorktrees(
          repoPrefsKey(repo),
          diskPaths,
          visibleWorktreesByRepo,
        ),
      );
      const rows: Array<{
        path: string;
        branch: string;
        ahead: number;
        behind: number;
        dirty: number;
        upstream: string | null;
        aheadDanger: boolean;
        daemonId: string | undefined;
      }> = [];
      for (const wt of repo.worktrees ?? []) {
        if (!visible.has(wt.path)) continue;
        const ahead = pushCount(wt.branchStatus);
        const behind = wt.branchStatus?.behind ?? 0;
        const fs = wt.fileStatus;
        const dirty = fs
          ? Math.max(
              0,
              fs.staged +
                fs.unstaged +
                fs.untracked -
                (fs.submoduleChanges ?? 0),
            )
          : 0;
        if (ahead === 0 && behind === 0 && dirty === 0) continue;
        rows.push({
          path: wt.path,
          branch: wt.branch ?? "",
          ahead,
          behind,
          dirty,
          upstream: wt.branchStatus?.upstream ?? null,
          aheadDanger: pushBadgeDanger(wt.branchStatus),
          daemonId: daemonIdForWorktreePath(repos, wt.path),
        });
      }
      if (rows.length > 0) out[repo.id] = rows;
    }
    return out;
  })();

  /** Browser-tab indicator: animates the favicon (pulsing dot when
   *  waiting, rotating arc when working) and sets the title + meta
   *  description to a per-session breakdown (with names + agents)
   *  that the hover tooltip can show. Picks up changes via the
   *  reactive dependency on `dockEntries`. Inactive columns don't count,
   *  but visual app-server sessions that are working/awaiting do. */
  $: updateTabIndicator(
    dockEntries
      .filter((e) => !e.exited)
      .map((e) => ({
        // Priority: awaiting > working > unread (= AI finished a turn
        // the user hasn't focused yet, signalled by `finishedAt`) > idle.
        state: e.awaiting
          ? ("awaiting" as const)
          : e.working
            ? ("working" as const)
            : e.finishedAt !== undefined
              ? ("unread" as const)
              : ("idle" as const),
        name: (e.manualTitle || e.aiTitle || e.title || e.branch || "").trim(),
        agent: e.agent,
      })),
  );

  /** Audible "an agent has needed me for a while" nudge. Fires once a
   *  session has continuously needed attention for the grace period —
   *  either an explicit prompt left unanswered (`awaiting`, the dock's
   *  `dot-awaiting` pulse) or a finished turn left unread (`finishedAt`,
   *  the dock's `dot-unread-pulse`). See attention-chime.ts. The
   *  reactive block keeps the per-source episode clock in sync with the
   *  live dock entries; the interval (started in onMount) does the
   *  threshold check so the chime still fires when nothing re-renders. */
  const attentionChime = createAttentionChimeState();
  $: chimeInputs = dockEntries
    .filter((e) => !e.exited && (e.awaiting || e.finishedAt !== undefined))
    .map((e) => ({
      source: e.source,
      awaiting: e.awaiting,
      finishedAt: e.finishedAt,
    }));
  $: syncAttention(attentionChime, chimeInputs, Date.now());

  function handleDocClick(e: MouseEvent) {
    const target = e.target as HTMLElement | null;
    if (actionsOpen && !target?.closest(".actions-anchor")) {
      actionsOpen = false;
    }
    if (eventsOpen && !target?.closest(".events-anchor")) {
      eventsOpen = false;
    }
    if (daemonsMenuOpen && !target?.closest(".daemons-anchor")) {
      daemonsMenuOpen = false;
    }
    if (projectsMenuOpen && !target?.closest(".projects-anchor")) {
      projectsMenuOpen = false;
    }
    if (!target?.closest(".tuis-anchor")) {
      processListRef?.closeIfOpen();
    }
    if (importSessionsOpen && !target?.closest(".import-sessions-anchor")) {
      importSessionsOpen = false;
    }
    // Close any open "new agent" picker the click landed outside of.
    for (const key of Object.keys(newAgentPopoverOpen)) {
      if (!newAgentPopoverOpen[key]) continue;
      const anchor = target?.closest(
        `[data-new-agent-anchor="${CSS.escape(key)}"]`,
      );
      if (!anchor) {
        newAgentPopoverOpen = { ...newAgentPopoverOpen, [key]: false };
      }
    }
    // Close any open branch picker the click landed outside of.
    for (const key of Object.keys(branchPickerOpen)) {
      if (!branchPickerOpen[key]) continue;
      const anchor = target?.closest(
        `[data-branch-anchor="${CSS.escape(key)}"]`,
      );
      if (!anchor) {
        branchPickerOpen = { ...branchPickerOpen, [key]: false };
      }
    }
    // Close the repo-edit popover if the click landed outside of it,
    // committing any pending name first (colour saves live).
    if (
      editingRowKey &&
      !target?.closest(`[data-repo-edit-anchor="${CSS.escape(editingRowKey)}"]`)
    ) {
      if (editingRepoId) void commitRenameRepo(editingRepoId);
      else cancelRenameRepo();
    }
    // Close any open worktree-picker popover the click landed outside of.
    for (const key of Object.keys(wtPickerOpen)) {
      if (!wtPickerOpen[key]) continue;
      const anchor = target?.closest(
        `[data-wt-picker-anchor="${CSS.escape(key)}"]`,
      );
      if (!anchor) {
        wtPickerOpen = { ...wtPickerOpen, [key]: false };
      }
    }
    // Per-row notes-list popover — close on outside click. Treat
    // clicks on any sticky note (including its delete X button) as
    // "in flow" so the popover stays open while the user is acting on
    // notes; otherwise the 3-second delete grace + SSE round-trip
    // races the popover close and the deleted entry never appears
    // until the user re-opens.
    for (const key of Object.keys(notesListOpen)) {
      if (!notesListOpen[key]) continue;
      const anchor = target?.closest(
        `[data-notes-list-anchor="${CSS.escape(key)}"]`,
      );
      const inSticky = target?.closest(".sticky");
      if (!anchor && !inSticky) {
        notesListOpen = { ...notesListOpen, [key]: false };
      }
    }
    // Close any open emoji picker the click landed outside of.
    for (const key of Object.keys(emojiPickerOpen)) {
      if (!emojiPickerOpen[key]) continue;
      const anchor = target?.closest(
        `[data-emoji-picker-anchor="${CSS.escape(key)}"]`,
      );
      if (!anchor) {
        emojiPickerOpen = { ...emojiPickerOpen, [key]: false };
      }
    }
    // Any open agents popovers that the click landed outside of: close them.
    for (const key of Object.keys(agentsPopoverOpen)) {
      if (!agentsPopoverOpen[key]) continue;
      const anchor = target?.closest(
        `[data-agents-anchor="${CSS.escape(key)}"]`,
      );
      if (!anchor) {
        agentsPopoverOpen = { ...agentsPopoverOpen, [key]: false };
      }
    }
    // Same dance for the badge's active-TUIs jump popover.
    for (const key of Object.keys(activeTuisPopoverOpen)) {
      if (!activeTuisPopoverOpen[key]) continue;
      const anchor = target?.closest(
        `[data-active-tuis-anchor="${CSS.escape(key)}"]`,
      );
      if (!anchor) {
        activeTuisPopoverOpen = { ...activeTuisPopoverOpen, [key]: false };
      }
    }
  }

  /** Svelte out-transition for `.session-col`. Two-phase:
   *
   *   1. Hold full width, fade opacity 1 → 0 over the first half.
   *   2. Hold opacity 0, shrink width + horizontal margin to 0 over
   *      the second half, then remove.
   *
   *  This only fires when a column actually leaves the each-block,
   *  i.e. when the user clicks **close** (`closeSessionInWt` removes
   *  the entry from `openSessionsByWt`). Clicking **dispose** flips
   *  SessionView's mode back to read without unmounting the column,
   *  so the transition is skipped — exactly what we want.
   *
   *  Width is captured in px from the live element so the column
   *  doesn't snap to a flex-default at the start of phase 2.
   *  `prefers-reduced-motion: reduce` short-circuits to a 0-duration
   *  removal — instant, but still semantically a transition. */
  function closeColumn(node: HTMLElement) {
    const src = node.dataset.sessionSource ?? "";
    if (promotedSources.delete(src)) {
      return { duration: 0 };
    }
    if (
      typeof window !== "undefined" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches
    ) {
      return { duration: 0 };
    }
    const rect = node.getBoundingClientRect();
    const fullWidth = rect.width;
    const cs = getComputedStyle(node);
    const ml = parseFloat(cs.marginLeft) || 0;
    const mr = parseFloat(cs.marginRight) || 0;
    return {
      duration: 360,
      css: (t: number) => {
        // Svelte out-transitions run `t` from 1 (start) -> 0 (gone).
        // Convert to forward progress so the phase boundaries read
        // naturally.
        const p = 1 - t;
        const opacity = p < 0.5 ? 1 - p * 2 : 0;
        const sizeT = p < 0.5 ? 1 : 1 - (p - 0.5) * 2;
        const w = sizeT * fullWidth;
        return `
          opacity: ${opacity};
          width: ${w}px;
          min-width: ${w}px;
          max-width: ${w}px;
          flex: 0 0 ${w}px;
          margin-left: ${sizeT * ml}px;
          margin-right: ${sizeT * mr}px;
          overflow: hidden;
        `;
      },
    };
  }

  // Svelte action: focus + select the node when it's mounted. Used on the
  // rename input so clicking the repo chip drops you straight into typing.
  function focusAndSelect(node: HTMLInputElement) {
    node.focus();
    node.select();
    return {};
  }

  /** Visibility-driven per-repo fetch loop.
   *
   *  Daemon also runs a 5-minute auto-fetch for the whole workspace.
   *  This loop layers on top: while a repo's row is visible in the
   *  viewport, the dashboard tells the daemon to re-fetch that repo
   *  every 30 s so ahead/behind stays current for the rows you can
   *  actually see. Repos scrolled off-screen drop out of the loop.
   *
   *  Debounce: when a row first becomes visible we wait 3 s before the
   *  first fetch. That keeps a quick scroll past 20 repos from firing
   *  20 fetches; only the ones the user lingers on count.
   *
   *  Granularity is per-repo (not per-row): a repo with multiple
   *  worktrees has multiple rows, and we want one fetch loop shared
   *  across them. We track the set of visible rows per repo and only
   *  stop the loop when *every* row for that repo goes off-screen. */
  const VISIBLE_FETCH_DEBOUNCE_MS = 3_000;
  const VISIBLE_FETCH_INTERVAL_MS = 30_000;
  // Cold-start spawn-storm guard. On restart every column respawns its
  // PTY at once; a visible repo firing /api/fetch (→ git fetch +
  // /api/repos rebuild) at the same moment piles onto the single daemon
  // event loop, which is exactly when a visible repo's own terminal can
  // miss its 10s spawn guard. Hold the FIRST visible-fetch until this
  // grace elapses — the initial load() already populated repo state, so
  // this only delays the first remote refresh by a few seconds.
  const STARTUP_FETCH_GRACE_MS = 12_000;
  const APP_START_MS = Date.now();
  type RepoVisibleFetchState = {
    visibleRows: Set<string>;
    debounceTimer: ReturnType<typeof setTimeout> | null;
    intervalTimer: ReturnType<typeof setInterval> | null;
    quietTimer: ReturnType<typeof setTimeout> | null;
  };
  const repoFetchStates = new Map<string, RepoVisibleFetchState>();
  const rowNodeMeta = new WeakMap<
    Element,
    { repoId: string; rowKey: string }
  >();

  async function fetchVisibleRepo(repoId: string): Promise<void> {
    // Skip while the UI is idle/hidden. Each `git fetch` triggers a
    // worktree-watcher fs_change burst + a /api/repos rebuild — the
    // dominant source of the daemon's "idle 20% CPU" before this gate.
    // On resume we fire load() once which catches up via cache.
    if (isUiIdle()) return;
    const quietInMs = SCROLL_QUIET_MS - msSinceScroll();
    if (quietInMs > 0) {
      const s = ensureRepoFetchState(repoId);
      if (s.visibleRows.size === 0 || s.quietTimer !== null) return;
      s.quietTimer = setTimeout(() => {
        s.quietTimer = null;
        void fetchVisibleRepo(repoId);
      }, quietInMs + 20);
      return;
    }
    try {
      await fetch(apiUrl("/api/fetch", daemonIdForRepoId(repos, repoId)), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ repos: [repoId] }),
      });
      // Daemon broadcasts `change { kind: "fetch_complete" }` on
      // success and the SSE handler already triggers load() — no
      // explicit refresh needed here.
    } catch {
      // Network blip; the next 30 s tick (or the daemon's own 5-min
      // cycle) will try again.
    }
  }

  function ensureRepoFetchState(repoId: string): RepoVisibleFetchState {
    let s = repoFetchStates.get(repoId);
    if (!s) {
      s = {
        visibleRows: new Set(),
        debounceTimer: null,
        intervalTimer: null,
        quietTimer: null,
      };
      repoFetchStates.set(repoId, s);
    }
    return s;
  }

  function startVisibleFetchLoop(repoId: string): void {
    const s = ensureRepoFetchState(repoId);
    if (s.debounceTimer !== null || s.intervalTimer !== null) return;
    // Push the first fetch out to the end of the startup grace window if
    // we're still inside it (otherwise just the normal debounce). The
    // 30s interval that follows is unaffected.
    const graceLeft = APP_START_MS + STARTUP_FETCH_GRACE_MS - Date.now();
    const firstDelay = Math.max(VISIBLE_FETCH_DEBOUNCE_MS, graceLeft);
    s.debounceTimer = setTimeout(() => {
      s.debounceTimer = null;
      void fetchVisibleRepo(repoId);
      s.intervalTimer = setInterval(
        () => void fetchVisibleRepo(repoId),
        VISIBLE_FETCH_INTERVAL_MS,
      );
    }, firstDelay);
  }

  function stopVisibleFetchLoop(repoId: string): void {
    const s = repoFetchStates.get(repoId);
    if (!s) return;
    if (s.debounceTimer !== null) {
      clearTimeout(s.debounceTimer);
      s.debounceTimer = null;
    }
    if (s.intervalTimer !== null) {
      clearInterval(s.intervalTimer);
      s.intervalTimer = null;
    }
    if (s.quietTimer !== null) {
      clearTimeout(s.quietTimer);
      s.quietTimer = null;
    }
  }

  function noteRowVisible(repoId: string, rowKey: string): void {
    const s = ensureRepoFetchState(repoId);
    const wasEmpty = s.visibleRows.size === 0;
    s.visibleRows.add(rowKey);
    if (wasEmpty) startVisibleFetchLoop(repoId);
  }

  function noteRowHidden(repoId: string, rowKey: string): void {
    const s = repoFetchStates.get(repoId);
    if (!s) return;
    s.visibleRows.delete(rowKey);
    if (s.visibleRows.size === 0) stopVisibleFetchLoop(repoId);
  }

  const rowVisibilityObserver: IntersectionObserver | null =
    typeof window !== "undefined" && "IntersectionObserver" in window
      ? new IntersectionObserver(
          (entries) => {
            for (const entry of entries) {
              // Pause the row's decorative badge animations while it's
              // scrolled out of the viewport — no point ticking the
              // edge-flow streaks / pulsate blink on rows nobody can
              // see. Driven via the `.row-offscreen` class (see the rule
              // in worktree-row.css). We toggle a class rather than use
              // content-visibility:auto on purpose: containment would
              // collapse the row's layout box and feed StickyNotesLayer's
              // getBoundingClientRect math a wrong height. This keeps the
              // box intact and only stops the animation work.
              syncOffscreenClass(
                entry.target as HTMLElement,
                "row-offscreen",
                entry.isIntersecting,
              );
              const meta = rowNodeMeta.get(entry.target);
              if (!meta) continue;
              if (entry.isIntersecting) {
                noteRowVisible(meta.repoId, meta.rowKey);
              } else {
                noteRowHidden(meta.repoId, meta.rowKey);
              }
            }
          },
          // Any sliver visible is enough; users often see ahead/behind
          // peeking at the edge of the viewport while scrolling.
          { threshold: 0 },
        )
      : null;

  /** Svelte action — attach to each row <li>. Registers the node with
   *  the IntersectionObserver and feeds (repoId, rowKey) into the
   *  per-repo visibility tracker. When the bound repo changes (rare —
   *  rows are keyed by `${repo.id}|${wt.path}` so the same DOM node
   *  shouldn't host two different repos, but Svelte's keyed-each isn't
   *  guaranteed across rerenders), we mark the old repo as hidden so
   *  its loop drains cleanly. */
  function rowVisibility(
    node: HTMLElement,
    params: { repoId: string; rowKey: string },
  ) {
    if (!rowVisibilityObserver) return {};
    rowNodeMeta.set(node, params);
    rowVisibilityObserver.observe(node);
    return {
      update(next: { repoId: string; rowKey: string }) {
        const prev = rowNodeMeta.get(node);
        if (
          prev &&
          (prev.repoId !== next.repoId || prev.rowKey !== next.rowKey)
        ) {
          noteRowHidden(prev.repoId, prev.rowKey);
        }
        rowNodeMeta.set(node, next);
      },
      destroy() {
        rowVisibilityObserver?.unobserve(node);
        const prev = rowNodeMeta.get(node);
        if (prev) noteRowHidden(prev.repoId, prev.rowKey);
        rowNodeMeta.delete(node);
      },
    };
  }

  onDestroy(() => {
    rowVisibilityObserver?.disconnect();
    for (const repoId of repoFetchStates.keys()) stopVisibleFetchLoop(repoId);
    repoFetchStates.clear();
    stopBackgroundTuiSpawn();
    stopActiveWorktreePoll();
  });

  let daemonBuildTime: string | null = null;
  let daemonVersion: string | null = null;
  let temporaryWorkspace = false;
  let temporaryWorkspaceSource: string | null = null;

  /** Fetch system memory from the daemon (via /api/health) so the TUI
   *  hot/warm thresholds scale to a fraction of total RAM. Static for
   *  the lifetime of the daemon; one fetch on mount is enough. Also
   *  reads localIp + port so the tagline can show the LAN URL. */
  async function loadSystemInfo() {
    try {
      const res = await fetch(apiUrl("/api/health"));
      if (!res.ok) return;
      const body = (await res.json()) as {
        totalMemBytes?: unknown;
        buildTime?: unknown;
        version?: unknown;
        temporaryWorkspace?: unknown;
        sourceWorkspace?: unknown;
      };
      if (typeof body.totalMemBytes === "number" && body.totalMemBytes > 0) {
        systemMemBytes = body.totalMemBytes;
      }
      if (typeof body.buildTime === "string") {
        daemonBuildTime = body.buildTime;
      }
      if (typeof body.version === "string") {
        daemonVersion = body.version;
      }
      temporaryWorkspace = body.temporaryWorkspace === true;
      temporaryWorkspaceSource =
        typeof body.sourceWorkspace === "string" ? body.sourceWorkspace : null;
    } catch {
      // best-effort — we fall back to TUI_*_MEM_FALLBACK byte ceilings.
    }
  }

  onMount(() => {
    restoreExpanded();
    restoreOpenSessions();
    restoreVisibleWorktrees();
    restoreFoldedRepos();
    void loadInstalledAgents();
    void loadEditors();
    void loadDefaultShell();
    void loadSystemInfo();
    void refreshRunningCommands();
    void refreshCommandUrls();
    // Restore shells twice: once NOW (local daemon — snappy, no wait), and
    // again after load() resolves so `remoteDaemons` is populated and each
    // remote box's open shells fan in. Both passes are idempotent
    // (mergeLiveShells/mergePersistedTerminals dedupe by source), so the
    // local shells aren't duplicated. See restoreLiveShells().
    void restoreLiveShells().then(() => restorePersistedTerminals());
    fetch(apiUrl("/api/peer-discovery"))
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (d) peerDiscoveryEnabled = d.enabled === true;
      })
      .catch(() => {});
    // Global focus listener — whenever the user puts focus into a
    // session column (typing, clicking into the terminal, etc.)
    // clear that column's "unread" pulse so it doesn't keep
    // blinking while they're already looking at it.
    document.addEventListener("focusin", handleFocusInForUnread);
    document.addEventListener("focusout", handleFocusOutForUnread);
    startActiveWorktreePoll();
    // Persist the page scroll offset as the user scrolls, and restore it
    // once the initial load's repos have streamed in (see SCROLL_KEY).
    window.addEventListener("scroll", scrollSaver.trigger, { passive: true });
    void load("mount").then(() => {
      restoreScrollPosition();
      // Re-spawn live PTYs for restored terminal-mode sessions in the
      // background so their dock dots light at startup (regression #4 B).
      ensureBackgroundTuiSpawn();
      // Re-run shell restore now that load() has populated `remoteDaemons`,
      // so each remote box's open shells are fetched + merged in (the
      // onMount pass above only saw the local daemon).
      void restoreLiveShells().then(() => restorePersistedTerminals());
      // Open an SSE stream to each online remote daemon so remote-side
      // changes live-refresh the UI (load() / notes), like local ones.
      syncRemoteStreams();
    });
    // Note: SourceControlPane handles its own initial commits-load via
    // a `$: onExpandedChange(expanded, wt.path)` reactive when its
    // `expanded` prop is true on mount, so the parent doesn't (and
    // can't, post-refactor) drive that.
    const unsubErrors = subscribeErrors((list) => {
      errorEntries = list;
    });
    // Surface toast requests pushed by child components (e.g.
    // AgentUsageChip's usage warnings) through the local stack.
    const unsubToasts = subscribeToasts((req) => addToast(req));
    void hydrateFromServer();
    document.addEventListener("click", handleDocClick);
    // Esc exits zen mode. We don't preventDefault — the browser's own
    // fullscreen-exit-on-Esc still works independently because the API
    // fires Esc against fullscreen before document keydown ever sees it.
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && zenRowKey && !document.fullscreenElement) {
        const el = document.activeElement as HTMLElement | null;
        const inInput =
          el?.tagName === "INPUT" ||
          el?.tagName === "TEXTAREA" ||
          el?.isContentEditable ||
          !!el?.closest(".xterm");
        if (inInput) return;
        const wtPath = zenRowKey.split("|").slice(1).join("|");
        zenRowKey = null;
        notesShownInZen = false;
        resetZenMenu();
        if (wtPath) tick().then(() => jumpToWorktreeRow(wtPath));
      }
      // Cmd/Ctrl+Z → undo the most recent reversible workspace event;
      // Cmd/Ctrl+Shift+Z (or Cmd/Ctrl+Y) → redo. Skipped when an input
      // / textarea / contentEditable is focused so the user's local
      // text-undo still works while editing a sticky note or a form.
      // `e.code === "KeyZ"` instead of `e.key` so non-QWERTY layouts
      // and Caps-Lock states still trigger reliably.
      const mod = e.metaKey || e.ctrlKey;
      const isUndo = mod && !e.altKey && !e.shiftKey && e.code === "KeyZ";
      const isRedo =
        (mod && !e.altKey && e.shiftKey && e.code === "KeyZ") ||
        (mod && !e.altKey && !e.shiftKey && e.code === "KeyY");
      if (!isUndo && !isRedo) return;
      const t = e.target as HTMLElement | null;
      const tag = t?.tagName;
      if (
        tag === "INPUT" ||
        tag === "TEXTAREA" ||
        tag === "SELECT" ||
        t?.isContentEditable
      ) {
        return;
      }
      e.preventDefault();
      void runWorkspaceUndoRedo(isRedo ? "redo" : "undo");
    };
    // Window-level capture so this fires before any descendant handlers
    // can stopPropagation the keydown — which used to happen when a
    // popover swallowed Cmd+Z on its way to the document listener.
    window.addEventListener("keydown", handleKey, { capture: true });
    // Zen menu-pill reveal: arm when the cursor reaches the very top of
    // the viewport. No overlay/hot-zone element — we just read clientY —
    // so nothing near the top edge is ever click-blocked. Only active in
    // zen; otherwise the pill is always visible and this is a no-op.
    const handleZenPointer = (e: PointerEvent) => {
      if (zenRowKey === null) return;
      if (e.clientY <= ZEN_MENU_REVEAL_PX) armZenMenu();
    };
    window.addEventListener("pointermove", handleZenPointer, { passive: true });
    // Cmd+R / Ctrl+R / tab close — surface the browser's confirm dialog
    // when the user has open sessions (claude/codex chats, terminals).
    // No prompt on an empty dashboard so a fresh reload stays silent.
    // The dialog text is browser-controlled; setting `returnValue` is
    // enough to trigger it. Live TUI PTYs survive the reload on the
    // daemon (reattach via /api/shells + activity-tail), but the user
    // still loses in-page scroll position and any unsaved UI state.
    //
    // Dev (`import.meta.env.DEV`): never install the listener. HMR-driven
    // reloads happen constantly while editing CSS / Svelte and the
    // prompt is pure friction there.
    const handleBeforeUnload = (e: BeforeUnloadEvent) => {
      const hasOpen = Object.values(openSessionsByWt).some(
        (arr) => arr && arr.length > 0,
      );
      if (!hasOpen) return;
      e.preventDefault();
      e.returnValue = "";
    };
    if (!import.meta.env.DEV) {
      window.addEventListener("beforeunload", handleBeforeUnload);
    }
    // The SSE stream can go silently dead after the OS sleeps/locks: the
    // socket half-opens, the browser keeps EventSource.readyState === OPEN
    // and never fires `error`, so it never auto-reconnects — live pushes
    // (dirty/ahead badges, new sessions) just stop until a manual reload.
    // Tear it down and resubscribe when the user returns (tab visible
    // again) or the network comes back; resubscribing runs onopen → load()
    // so the dashboard also catches up on whatever was missed. A short
    // dedupe window collapses the visibility+online+focus burst that fires
    // together on wake into a single reconnect.
    let streamUnsub = subscribeToStream();
    let lastStreamReconnectMs = Date.now();
    const reconnectStream = (): void => {
      const nowReconnect = Date.now();
      if (nowReconnect - lastStreamReconnectMs < 2000) return;
      lastStreamReconnectMs = nowReconnect;
      streamUnsub();
      streamUnsub = subscribeToStream();
    };
    const onVisibleReconnect = (): void => {
      // Only on the hidden→visible edge; quick same-tab focus changes don't
      // background the stream, so don't churn a reconnect on those.
      if (typeof document !== "undefined" && document.hidden) return;
      reconnectStream();
    };
    document.addEventListener("visibilitychange", onVisibleReconnect);
    window.addEventListener("online", reconnectStream);
    const unsubStream = () => {
      document.removeEventListener("visibilitychange", onVisibleReconnect);
      window.removeEventListener("online", reconnectStream);
      streamUnsub();
    };
    // UI-idle gate: pauses visible-fetch + newSessionPoll while the tab
    // is hidden or the user hasn't interacted in the last 10 s. Avoids
    // the 15-20% daemon CPU pulse from background git fetches when
    // nobody's looking. SSE-driven refreshes still flow.
    const uninstallIdle = installIdleTracker();
    // Pause always-on decorative animations during keystroke bursts so each
    // keystroke's Layerize walks a smaller compositor tree (perf.md: Layerize
    // storm during typing). Toggles `body.is-typing`.
    const uninstallTyping = installTypingTracker();
    const RESUME_LOAD_DELAY_MS = 800;
    let resumeLoadTimer: ReturnType<typeof setTimeout> | null = null;
    function scheduleResumeLoad(): void {
      if (resumeLoadTimer) return;
      resumeLoadTimer = setTimeout(() => {
        resumeLoadTimer = null;
        void load("resume");
      }, RESUME_LOAD_DELAY_MS);
    }
    const unsubResume = onResume(() => {
      // User came back because they interacted. Let that interaction render
      // first, then refresh stale dashboard state in the background.
      scheduleResumeLoad();
    });
    const nowTimer = setInterval(() => {
      nowMs = Date.now();
    }, 3000);
    // Check whether any session has continuously needed attention past
    // the grace period and play the nudge once if so. 5s cadence is
    // plenty for a 60s threshold; play()'s selfCooldown dedupes
    // simultaneous crossings.
    //
    // Gated on tab visibility: browsers suspend the AudioContext in a
    // hidden tab, so a chime fired then would be silently lost — worse,
    // dueForChime *latches* the source as fired, eating the nudge for
    // good. We only evaluate (and thus latch) while visible, and the
    // visibilitychange handler re-checks the instant the user returns,
    // so a wait that crossed 60s while they were away still chimes on
    // their return — which is the whole point of the feature.
    const maybeChime = () => {
      if (typeof document !== "undefined" && document.hidden) return;
      if (dueForChime(attentionChime, chimeInputs, Date.now()).length > 0) {
        play("ai-needs-input");
      }
    };
    const chimeTimer = setInterval(maybeChime, 5000);
    document.addEventListener("visibilitychange", maybeChime);
    // Console aid (exposed in prod too, like __supergitFavicon):
    // `__supergitNudge()` plays the chime now so the audio path can be
    // verified without sitting through a real 60s awaiting prompt.
    (window as unknown as Record<string, unknown>).__supergitNudge = () =>
      play("ai-needs-input");
    // Click-on-saved-session-link → bring the session into view.
    // The chip writes a {source, ts} request into the focus store;
    // we locate which worktree it belongs to (via the live
    // repos[].worktrees[].agents data), open the column if it's not
    // already in the strip, scroll it into view, and apply a brief
    // outline-highlight so the user sees where the link landed.
    const unsubFocus = sessionFocusRequest.subscribe((req) => {
      if (!req) return;
      void focusSessionBySource(req.source);
    });
    return () => {
      document.removeEventListener("focusin", handleFocusInForUnread);
      document.removeEventListener("focusout", handleFocusOutForUnread);
      window.removeEventListener("scroll", scrollSaver.trigger);
      scrollSaver.cancel();
      cancelScrollRestore?.();
      document.removeEventListener("click", handleDocClick);
      window.removeEventListener("keydown", handleKey, { capture: true });
      window.removeEventListener("pointermove", handleZenPointer);
      resetZenMenu();
      window.removeEventListener("beforeunload", handleBeforeUnload);
      unsubStream();
      fsChangeBatcher.dispose();
      closeRemoteStreams();
      unsubErrors();
      unsubToasts();
      unsubFocus();
      unsubResume();
      if (resumeLoadTimer) clearTimeout(resumeLoadTimer);
      uninstallIdle();
      uninstallTyping();
      clearInterval(nowTimer);
      clearInterval(chimeTimer);
      document.removeEventListener("visibilitychange", maybeChime);
    };
  });

  /** Imperative side of "click a session sticky-link → focus the
   *  matching column in its worktree strip". Adds the session to
   *  openSessionsByWt if it isn't already open, then on the next
   *  tick scrolls the column into view and toggles a brief outline
   *  highlight via `.session-col-focused`. */
  async function focusSessionBySource(source: string): Promise<void> {
    const findInRepos = () => {
      let targetWtPath: string | null = null;
      let agentName: OpenSession["agent"] | null = null;
      for (const repo of repos) {
        for (const wt of repo.worktrees ?? []) {
          const found = (wt.agents ?? []).find((a) => a.source === source);
          if (found) {
            targetWtPath = wt.path;
            agentName = found.agent;
            break;
          }
        }
        if (targetWtPath) break;
      }
      return { targetWtPath, agentName };
    };

    let { targetWtPath, agentName } = findInRepos();
    if (!targetWtPath || !agentName) {
      // The session may have just been created (e.g. a freshly
      // imported session from session-share — we get the focus
      // request before `load()` has had time to refetch /api/repos).
      // Force one refresh and try again.
      await load();
      ({ targetWtPath, agentName } = findInRepos());
    }
    if (!targetWtPath || !agentName) {
      // On Windows the JSONL may not be visible to scanClaude
      // immediately after writeFile returns (NTFS journal flush,
      // antivirus scan-on-write). One more attempt after a short
      // delay covers this without a heavy polling loop.
      await new Promise((r) => setTimeout(r, 1500));
      await load();
      ({ targetWtPath, agentName } = findInRepos());
    }
    if (!targetWtPath || !agentName) return;
    // Find the row key so we can unfold a collapsed worktree row — the
    // session column otherwise renders inside `display: none` chrome
    // and the scroll-into-view below lands on nothing.
    const targetRepo = repos.find((r) =>
      (r.worktrees ?? []).some((w) => w.path === targetWtPath),
    );
    if (targetRepo) {
      const rowKey = `${targetRepo.id}|${targetWtPath}`;
      // In zen mode every other row is hidden (display:none), so revealing
      // and scrolling a session column in a *different* worktree is a no-op —
      // the column never enters the DOM and the querySelector below returns
      // null, so "Go to session" silently does nothing. Re-point zen at the
      // target worktree's row (restoring its visibility first), mirroring
      // switchZenToRepo, so navigation actually lands.
      if (zenRowKey !== null && zenRowKey !== rowKey) {
        const visible = effectiveVisibleWorktrees(
          repoPrefsKey(targetRepo),
          (targetRepo.worktrees ?? []).map((w) => w.path),
          visibleWorktreesByRepo,
        );
        if (!visible.includes(targetWtPath)) {
          visibleWorktreesByRepo = {
            ...visibleWorktreesByRepo,
            [repoPrefsKey(targetRepo)]: [...visible, targetWtPath],
          };
        }
        zenRowKey = rowKey;
        notesShownInZen = false;
        resetZenMenu();
      }
      if (rowFolded[rowKey]) {
        rowFolded = { ...rowFolded, [rowKey]: false };
        if (!rowHasBeenShown[rowKey]) {
          rowHasBeenShown = { ...rowHasBeenShown, [rowKey]: true };
          void stickAllSessionsInWtToBottom(targetWtPath);
        }
      }
    }
    const existing = openSessionsByWt[targetWtPath] ?? [];
    if (!existing.some((s) => s.source === source)) {
      openSessionsByWt = {
        ...openSessionsByWt,
        [targetWtPath]: [{ agent: agentName, source }, ...existing],
      };
    }
    // Wait for the {#each} to commit the new column to the DOM, then
    // scroll + flash the outline. Two ticks because scrollIntoView is
    // a sync read that needs the layout pass after the reactivity
    // update.
    await tick();
    await tick();
    const el = document.querySelector(
      `.session-col[data-session-source="${CSS.escape(source)}"]`,
    ) as HTMLElement | null;
    if (!el) return;
    el.scrollIntoView({
      behavior: "smooth",
      block: "center",
      inline: "center",
    });
    stickSessionColumnToTail(el);
    el.classList.add("session-col-focused");
    setTimeout(() => el.classList.remove("session-col-focused"), 1800);
  }
</script>

<main class:zen-row={zenRowKey !== null}>
  <header>
    {#if $showGreeting !== false && (daemonVersion || daemonBuildTime)}
      <p class="menubar-build">
        Welcome to the jungle –
        {#if daemonVersion}<code>v{daemonVersion}</code>{/if}
        {#if daemonVersion && daemonBuildTime}
          ·
        {/if}
        {#if daemonBuildTime}<code
            >built {new Date(daemonBuildTime).toLocaleString(undefined, {
              year: "numeric",
              month: "short",
              day: "numeric",
              hour: "2-digit",
              minute: "2-digit",
            })}</code
          >{/if}
        {#if (daemonVersion || daemonBuildTime) && typeof window !== "undefined" && window.location.port}
          · <code title="daemon port">:{window.location.port}</code>{/if}
      </p>
    {/if}
  </header>

  <!-- Fixed, horizontally-centred menubar. Always visible while the
       page scrolls; the brand lockup lives inside the pill. The
       full-width wrapper centres the pill without a transform (a
       transform would become the containing block for the
       JS-positioned fixed tooltips anchored inside). Per-button
       popovers still anchor to their own `.actions-anchor`. -->
  <div class="menubar-stack" class:zen-menu-armed={zenMenuArmed}>
    {#if temporaryWorkspace}
      <div
        class="temp-workspace-badge"
        title={temporaryWorkspaceSource
          ? `Temporary workspace copied from ${temporaryWorkspaceSource}`
          : "Temporary workspace"}
      >
        TEMP WORKSPACE
      </div>
    {/if}
    <nav class="menubar" aria-label="Workspace actions">
      <h1 class="menubar-brand">
        <a
          href="https://needle.tools"
          target="_blank"
          rel="noopener noreferrer"
        >
          <img src="/needle-logo.svg" alt="" class="brand-mark" />
          treetop
        </a>
      </h1>
      <!-- Per-agent usage buttons live leftmost — one icon-only button
         per detected coding agent (Claude / Codex / Ollama / Copilot),
         each with its own hover tooltip. Claude renders the real
         /api/oauth/usage bars; others fall back to local JSONL
         counts. AgentUsageChip iterates and emits the buttons here. -->
      <AgentUsageChip />

      <!-- Projects dropdown: jump to an added repo's row. Lists `repos`
         directly so the order matches the on-page row order (both are
         driven by the same `savedRepoOrder` sort). -->
      <div
        class="actions-anchor projects-anchor"
        on:mouseenter={openProjectsMenu}
        on:mouseleave={scheduleCloseProjectsMenu}
      >
        <button
          class="actions-btn projects-btn"
          class:open={projectsMenuOpen}
          on:click={() => (projectsMenuOpen = !projectsMenuOpen)}
          title="Jump to a project"
        >
          Projects<span class="count">{repos.length}</span>
        </button>
        {#if projectsMenuOpen}
          <Popover variant="actions" extraClass="projects-popover" unclamped>
            <svelte:fragment slot="head"><span>Projects</span></svelte:fragment>
            {#if repos.length === 0}
              <p class="muted small nopad">No projects yet.</p>
            {/if}
            <ul class="projects-list">
              {#if repos.length > 0}
                {#each projectMenuEntries as project (daemonRepoKey(project.repo))}
                  <li>
                    <button
                      class="projects-row"
                      class:has-live={project.liveCount > 0}
                      class:is-working={project.working}
                      class:is-awaiting={project.awaiting}
                      on:click={() => {
                        projectsMenuOpen = false;
                        void focusRepoRow(project.repo.id);
                      }}
                      title={project.latestActivity
                        ? `${project.repo.name}\nLast active ${relTime(project.latestActivity)}`
                        : project.repo.name}
                    >
                      <span
                        class="projects-dot"
                        style:--project-color={project.repo.color ||
                          "var(--text-muted)"}
                      >
                        <span class="projects-dot-core"></span>
                        <svg
                          class="projects-dot-spinner"
                          viewBox="0 0 24 24"
                          aria-hidden="true"
                        >
                          <circle cx="12" cy="12" r="9.5" pathLength="100" />
                        </svg>
                      </span>
                      <span class="projects-name">{project.repo.name}</span>
                      {#if project.latestActivity}
                        <span class="projects-time">
                          {relTime(project.latestActivity)}
                        </span>
                      {/if}
                    </button>
                  </li>
                {/each}
              {/if}
              <li class="projects-virtual-item">
                <button
                  class="projects-row projects-add-folder-row"
                  on:click={() => {
                    projectsMenuOpen = false;
                    void pickAndAdd();
                  }}
                >
                  <span class="projects-plus" aria-hidden="true">+</span>
                  <span class="projects-name">Add Folder</span>
                </button>
              </li>
              <li class="projects-import-item">
                <button
                  class="projects-row projects-add-folder-row"
                  on:click|stopPropagation={(e) => {
                    projectsMenuOpen = false;
                    toggleImportSessions(e, "projects");
                  }}
                  aria-haspopup="menu"
                  aria-expanded={importSessionsOpen &&
                    importMenuSource === "projects"}
                >
                  <span class="projects-plus" aria-hidden="true">
                    <svg
                      width="11"
                      height="11"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      stroke-width="2"
                      stroke-linecap="round"
                      stroke-linejoin="round"
                      aria-hidden="true"
                    >
                      <path d="M12 3v12" />
                      <path d="M7 10l5 5 5-5" />
                      <path d="M5 21h14" />
                    </svg>
                  </span>
                  <span class="projects-name">Open from sessions</span>
                </button>
              </li>
            </ul>
          </Popover>
        {/if}
      </div>

      <!-- "Open from sessions" popover. A menubar-level sibling of the
         Projects dropdown — deliberately NOT nested inside it. Two
         reasons: the projects popover scrolls long lists via
         overflow:auto (which would clip a child popover), and keeping
         it outside `.projects-anchor` means the projects menu's
         hover-open / hover-close handlers never fight it across the
         button↔popover gap. It carries `.import-sessions-anchor` so
         handleDocClick's outside-click test keeps it open while you
         interact, and `importMenuSource` gates it against the inline
         (footer / empty-state) copy that shares the same state. -->
      {#if importSessionsOpen && importMenuSource === "projects"}
        <div class="import-sessions-anchor projects-sessions-anchor">
          <Popover variant="actions" extraClass="projects-sessions-popover">
            <svelte:fragment slot="head">
              <div class="import-search-head">
                <input
                  type="search"
                  class="import-search-input"
                  bind:value={importQuery}
                  placeholder="Folders from detected sessions"
                  aria-label="Filter folders from detected sessions"
                  use:focusOnMount
                  on:click|stopPropagation
                  on:keydown|stopPropagation
                />
                {#if importQuery.trim()}
                  <span class="import-search-count"
                    >{importFiltered.length}/{importSuggestions.length}</span
                  >
                {/if}
              </div>
            </svelte:fragment>
            {#if importLoading}
              <div class="import-empty">
                <LoadingSpinner size="0.85rem" label="Scanning sessions" />
                <span>scanning sessions…</span>
              </div>
            {:else if importError}
              <div class="import-empty import-error">{importError}</div>
            {:else if importFiltered.length === 0}
              <div class="import-empty muted">
                {#if importQuery.trim()}
                  No folders match.
                {:else}
                  No new folders to suggest — every detected session's cwd is
                  already in the dashboard.
                {/if}
              </div>
            {:else}
              <ul class="import-list">
                {#each importFiltered as sug (sug.path)}
                  {@const busy = importAdding.has(sug.path)}
                  <li>
                    <button
                      type="button"
                      class="import-row"
                      class:busy
                      disabled={busy}
                      on:click={() => addRepoFromSuggestion(sug.path)}
                      title={`Add ${sug.path} to the dashboard`}
                    >
                      <span class="import-row-main">
                        {#if busy}
                          <span class="import-row-name"
                            ><LoadingSpinner size="0.75rem" /> Importing…</span
                          >
                        {:else}
                          <span class="import-row-name">{sug.name}</span>
                        {/if}
                        <span class="import-row-path muted small"
                          >{sug.path}</span
                        >
                        {#if sug.repoUrl}
                          <span class="import-row-url muted small"
                            >{sug.repoUrl}</span
                          >
                        {/if}
                      </span>
                      <span class="import-row-meta">
                        <span class="import-row-count">
                          <span
                            class="import-row-agents-icons"
                            aria-hidden="true"
                          >
                            {#each sug.agents as agent (agent)}
                              <AgentIcon {agent} size={14} />
                            {/each}
                          </span>
                          <span>
                            {sug.sessionCount} session{sug.sessionCount === 1
                              ? ""
                              : "s"}
                          </span>
                        </span>
                        <span class="import-row-time muted small">
                          {formatRelativeTime(sug.lastActive)}
                        </span>
                        <span class="import-row-agents-names muted small">
                          {sug.agents.join(", ")}
                        </span>
                      </span>
                    </button>
                  </li>
                {/each}
              </ul>
            {/if}
          </Popover>
        </div>
      {/if}

      <ProcessList
        bind:this={processListRef}
        {repos}
        {activityByCwd}
        {systemMemBytes}
        {daemonsOnline}
        on:focusSession={(e) => void focusSessionBySource(e.detail.source)}
      />

      <!-- Notes tray. Pinned in the menubar (no longer conditional on
         `orphanNotes.length > 0`) so the affordance stays put across
         the initial-load race where notes finish loading before
         repos do — that gap used to make the button flash in and
         out. Count badge only renders when there are orphans to
         action, but the button is always reachable. -->
      <div class="actions-anchor notes-tray-anchor">
        <button
          class="actions-btn"
          class:open={notesTrayOpen}
          on:click={() => (notesTrayOpen = !notesTrayOpen)}
          title={orphanNotes.length > 0
            ? `${orphanNotes.length} note${orphanNotes.length === 1 ? "" : "s"} whose repo/worktree was removed — click to re-anchor or delete`
            : "Notes whose repo/worktree was removed appear here for re-anchoring."}
        >
          Notes
          {#if orphanNotes.length > 0}
            <span class="count">{orphanNotes.length}</span>
          {/if}
        </button>
        {#if notesTrayOpen}
          <Popover variant="actions" extraClass="notes-tray-popover" unclamped>
            <span slot="head">Orphaned notes</span>
            {#if orphanNotes.length === 0}
              <p class="muted small nopad">
                No orphaned notes. When a repo or worktree gets removed, any
                notes anchored there land in this tray so you can re-anchor or
                delete them.
              </p>
            {:else}
              <ul class="orphan-list">
                {#each orphanNotes as n (n.id)}
                  <li class="orphan-row">
                    <div class="orphan-summary">
                      <span class="orphan-body" title={n.body}>
                        {noteExcerpt(n.body) || "(empty)"}
                      </span>
                      <span class="orphan-anchor" title={n.anchors.join("\n")}>
                        ⚓ {n.anchors[0] ?? "no anchor"}
                      </span>
                    </div>
                    <div class="orphan-actions">
                      <button
                        class="undo"
                        on:click={() =>
                          (orphanReanchorFor =
                            orphanReanchorFor === n.id ? null : n.id)}
                        >Re-anchor…</button
                      >
                      <button
                        class="undo"
                        on:click={() => void deleteOrphan(n.id)}
                        title="Delete (an Undo toast lets you bring it back)"
                        >Delete</button
                      >
                    </div>
                    {#if orphanReanchorFor === n.id}
                      <AnchorPicker
                        {repos}
                        currentAnchor={n.anchors[0] ?? null}
                        on:pick={(e) =>
                          void reassignOrphan(n.id, e.detail.anchor)}
                        on:cancel={() => (orphanReanchorFor = null)}
                      />
                    {/if}
                  </li>
                {/each}
              </ul>
            {/if}
          </Popover>
        {/if}
      </div>

      <div class="btn-group">
        <Tooltip placement="bottom">
          <button
            slot="trigger"
            class="actions-btn peer-toggle"
            class:peer-on={peerDiscoveryEnabled}
            disabled={peerToggleBusy}
            on:click={togglePeerDiscovery}
            >{#if peerDiscoveryEnabled}<svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
                stroke-linecap="round"
                stroke-linejoin="round"
                aria-hidden="true"
                ><path d="M5 12.55a11 11 0 0 1 14.08 0" /><path
                  d="M1.42 9a16 16 0 0 1 21.16 0"
                /><path d="M8.53 16.11a6 6 0 0 1 6.95 0" /><circle
                  cx="12"
                  cy="20"
                  r="1"
                /></svg
              >{:else}<svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
                stroke-linecap="round"
                stroke-linejoin="round"
                aria-hidden="true"
                ><line x1="1" y1="1" x2="23" y2="23" /><path
                  d="M16.72 11.06A10.94 10.94 0 0 1 19 12.55"
                /><path d="M5 12.55a10.94 10.94 0 0 1 5.17-2.39" /><path
                  d="M10.71 5.05A16 16 0 0 1 22.56 9"
                /><path d="M1.42 9a15.91 15.91 0 0 1 4.7-2.88" /><path
                  d="M8.53 16.11a6 6 0 0 1 6.95 0"
                /><line x1="12" y1="20" x2="12.01" y2="20" /></svg
              >{/if}</button
          >
          <span slot="content" class="peer-tooltip">
            <svg
              class="peer-tooltip-illustration"
              viewBox="0 0 180 64"
              fill="none"
              stroke="currentColor"
              stroke-width="1.8"
              stroke-linecap="round"
              stroke-linejoin="round"
              aria-hidden="true"
            >
              <!-- house roof -->
              <path d="M8 30L90 6l82 24" opacity="0.12" stroke-width="1.5" />
              <!-- left person: head, body, arms relaxed, sitting -->
              <circle
                cx="36"
                cy="24"
                r="4.5"
                opacity={peerDiscoveryEnabled ? "1" : "0.35"}
              />
              <path
                d="M36 28.5v7"
                opacity={peerDiscoveryEnabled ? "1" : "0.35"}
              />
              <path
                d="M31 31c2 1.5 8 1.5 10 0"
                opacity={peerDiscoveryEnabled ? "1" : "0.35"}
              />
              <path
                d="M32 35.5l-1 6M40 35.5l1 6"
                opacity={peerDiscoveryEnabled ? "1" : "0.35"}
              />
              <!-- left laptop -->
              <rect
                x="24"
                y="44"
                width="24"
                height="14"
                rx="2.5"
                opacity={peerDiscoveryEnabled ? "1" : "0.35"}
              />
              <rect
                x="27"
                y="46.5"
                width="18"
                height="9"
                rx="1.5"
                opacity={peerDiscoveryEnabled ? "0.5" : "0.15"}
              />
              {#if peerDiscoveryEnabled}
                <!-- small wifi dot on left screen -->
                <circle
                  cx="36"
                  cy="51"
                  r="1.2"
                  fill="currentColor"
                  stroke="none"
                  opacity="0.6"
                />
                <path
                  d="M33 49a4.2 4.2 0 0 1 6 0"
                  opacity="0.4"
                  stroke-width="1"
                />
              {/if}
              <!-- connection between laptops -->
              {#if peerDiscoveryEnabled}
                <!-- dashed path the envelope travels along -->
                <path
                  d="M50 36 Q90 18 130 36"
                  opacity="0.12"
                  stroke-dasharray="3 3"
                  stroke-width="1"
                  fill="none"
                />
                <!-- envelope flying left→right -->
                <g opacity="0.6">
                  <rect x="-5" y="-3.5" width="10" height="7" rx="1" />
                  <path d="M-5-3.5l5 4 5-4" />
                  <animateMotion
                    dur="3s"
                    repeatCount="indefinite"
                    path="M50,36 Q90,18 130,36"
                    rotate="auto"
                  />
                </g>
                <!-- envelope flying right→left (offset) -->
                <g opacity="0.4">
                  <rect x="-5" y="-3.5" width="10" height="7" rx="1" />
                  <path d="M-5-3.5l5 4 5-4" />
                  <animateMotion
                    dur="3.4s"
                    repeatCount="indefinite"
                    path="M130,36 Q90,18 50,36"
                    rotate="auto"
                    begin="0.8s"
                  />
                </g>
              {:else}
                <!-- broken / no signal -->
                <line
                  x1="60"
                  y1="32"
                  x2="120"
                  y2="32"
                  opacity="0.1"
                  stroke-dasharray="3 4"
                />
                <line
                  x1="84"
                  y1="26"
                  x2="96"
                  y2="38"
                  opacity="0.25"
                  stroke-width="1.5"
                />
                <line
                  x1="84"
                  y1="38"
                  x2="96"
                  y2="26"
                  opacity="0.25"
                  stroke-width="1.5"
                />
              {/if}
              <!-- right person: head, body, arms relaxed, sitting -->
              <circle
                cx="144"
                cy="24"
                r="4.5"
                opacity={peerDiscoveryEnabled ? "1" : "0.35"}
              />
              <path
                d="M144 28.5v7"
                opacity={peerDiscoveryEnabled ? "1" : "0.35"}
              />
              <path
                d="M139 31c2 1.5 8 1.5 10 0"
                opacity={peerDiscoveryEnabled ? "1" : "0.35"}
              />
              <path
                d="M140 35.5l-1 6M148 35.5l1 6"
                opacity={peerDiscoveryEnabled ? "1" : "0.35"}
              />
              <!-- right laptop -->
              <rect
                x="132"
                y="44"
                width="24"
                height="14"
                rx="2.5"
                opacity={peerDiscoveryEnabled ? "1" : "0.35"}
              />
              <rect
                x="135"
                y="46.5"
                width="18"
                height="9"
                rx="1.5"
                opacity={peerDiscoveryEnabled ? "0.5" : "0.15"}
              />
              {#if peerDiscoveryEnabled}
                <!-- small wifi dot on right screen -->
                <circle
                  cx="144"
                  cy="51"
                  r="1.2"
                  fill="currentColor"
                  stroke="none"
                  opacity="0.6"
                />
                <path
                  d="M141 49a4.2 4.2 0 0 1 6 0"
                  opacity="0.4"
                  stroke-width="1"
                />
              {/if}
            </svg>
            {#if peerDiscoveryEnabled}
              <span
                >LAN discovery is <span class="peer-badge peer-badge-on"
                  >ON</span
                > — other supergit instances on your local network can see this workspace
                and exchange messages. Click to disable.</span
              >
            {:else}
              <span
                >LAN discovery is <span class="peer-badge peer-badge-off"
                  >OFF</span
                > — this workspace is invisible to others on your network. Click to
                enable peer-to-peer messaging.</span
              >
            {/if}
          </span>
        </Tooltip>
        <MessagesInbox />
      </div>

      <div class="actions-anchor">
        <button
          class="actions-btn"
          class:open={actionsOpen}
          on:click={() => (actionsOpen = !actionsOpen)}
          title="Reversible workspace actions (undo / redo)"
        >
          Undo
          {#if visibleEvents.length > 0}
            <span class="count">{visibleEvents.length}</span>
          {/if}
        </button>
        {#if actionsOpen}
          <Popover variant="actions" unclamped>
            <span slot="head">Recent actions</span>
            {#if visibleEvents.length === 0}
              <p class="muted small nopad">No actions yet.</p>
            {:else}
              <ul class="events">
                {#each visibleEvents.slice(0, 50) as ev (ev.id)}
                  <li class:undone={ev.undone}>
                    <div class="ev-row">
                      <span class="ev-type">{eventLabel(ev, repos)}</span>
                      <span class="muted ev-time">{relTime(ev.timestamp)}</span>
                    </div>
                    <div class="ev-meta">
                      <span class="actor actor-{ev.actor}">{ev.actor}</span>
                      {#if ev.reversible}
                        {#if ev.undone}
                          <button
                            class="undo"
                            on:click={() => toggleEvent(ev.id, "redo")}
                            >Redo</button
                          >
                        {:else}
                          <button
                            class="undo"
                            on:click={() => toggleEvent(ev.id, "undo")}
                            >Undo</button
                          >
                        {/if}
                      {/if}
                    </div>
                  </li>
                {/each}
              </ul>
            {/if}
          </Popover>
        {/if}
      </div>

      <div class="actions-anchor events-anchor">
        <button
          class="actions-btn"
          class:open={eventsOpen}
          class:has-errors={errorEntries.length > 0}
          on:click={() => (eventsOpen = !eventsOpen)}
          title="Diagnostics — daemon 5xx, fetch failures, uncaught browser errors"
        >
          Events
          {#if errorEntries.length > 0}
            <span class="count">{errorEntries.length}</span>
          {/if}
        </button>
        {#if eventsOpen}
          <EventsPopover {errorEntries} on:clear={clearAllErrors} />
        {/if}
      </div>

      <div class="actions-anchor daemons-anchor">
        <button
          class="actions-btn daemons-btn"
          class:open={daemonsMenuOpen}
          on:click={() => (daemonsMenuOpen = !daemonsMenuOpen)}
          title="Remote daemons"
        >
          Daemons<span class="count">{remoteDaemons.length}</span>
        </button>
        {#if daemonsMenuOpen}
          <Popover variant="actions" extraClass="daemons-popover" unclamped>
            <svelte:fragment slot="head">
              <span>Remote daemons</span>
              <button
                class="daemons-redeploy"
                disabled={redeploying}
                title="Rebuild the prod SPA (packages/ui/dist) from the current source. Prod serves it fresh from disk — reload your prod tab to see it. No daemon restart, no dropped TUIs."
                on:click|stopPropagation={redeployProd}
              >
                {#if redeploying}Rebuilding…{:else}Redeploy prod{/if}
              </button>
            </svelte:fragment>
            {#if remoteDaemons.length === 0}
              <p class="muted small nopad">No remote daemons yet.</p>
            {:else}
              <ul class="daemons-list">
                {#each remoteDaemons as d (d.id)}
                  <li class="daemons-row">
                    <span
                      class="daemons-dot"
                      class:online={daemonsOnline.get(d.id)}
                      title={daemonsOnline.get(d.id)
                        ? "online"
                        : "offline / no tunnel"}
                    ></span>
                    <span class="daemons-meta">
                      <span class="daemons-label"
                        >{d.label}{#if d.user}<span
                            class="daemons-user"
                            class:root={d.user === "root"}
                            title={d.user === "root"
                              ? "runs as root — full access to the box"
                              : `runs as ${d.user}`}>{d.user}</span
                          >{/if}</span
                      >
                      <span class="daemons-host">{d.host}:{d.port}</span>
                    </span>
                    <button
                      class="daemons-addfolder"
                      title="Add a folder on this daemon"
                      on:click|stopPropagation={() => {
                        addRemoteFolderDaemonId = d.id;
                        addRemoteFolderOpen = true;
                        daemonsMenuOpen = false;
                      }}>+ Folder</button
                    >
                    <button
                      class="daemons-kebab"
                      title="Manage this daemon"
                      aria-label="Manage daemon"
                      disabled={daemonRemoving.has(d.id)}
                      on:click|stopPropagation={() => {
                        daemonDialogId = d.id;
                        daemonsMenuOpen = false;
                      }}
                    >
                      {#if daemonRemoving.has(d.id)}…{:else}
                        <svg
                          width="14"
                          height="14"
                          viewBox="0 0 16 16"
                          fill="none"
                          aria-hidden="true"
                        >
                          <path
                            d="M2 4h12M2 8h12M2 12h12"
                            stroke="currentColor"
                            stroke-width="1.5"
                            stroke-linecap="round"
                          />
                        </svg>
                      {/if}
                    </button>
                  </li>
                {/each}
              </ul>
            {/if}
            <div class="daemons-footer">
              <button
                class="add-folder-cta add-folder-cta-compact daemons-addremote"
                on:click|stopPropagation={() => {
                  provisionAttachJob = null;
                  addDaemonOpen = true;
                  daemonsMenuOpen = false;
                }}>+ Add remote</button
              >
            </div>
          </Popover>
        {/if}
      </div>

      <button
        class="actions-btn settings-menu-btn"
        class:open={settingsDialogOpen}
        on:click={() => (settingsDialogOpen = true)}
        title="Settings"
        aria-label="Settings"
        ><svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
          aria-hidden="true"
          ><circle cx="12" cy="12" r="3" /><path
            d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"
          /></svg
        ></button
      >

      <button
        class="actions-btn tutorial-btn"
        class:tour-active={tourRunning}
        on:click={restartTutorial}
        title={tourRunning
          ? "Stop the walkthrough"
          : "Start the UI walkthrough"}
        ><svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
          aria-hidden="true"
          ><circle cx="12" cy="12" r="10" /><path
            d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"
          /><line x1="12" y1="17" x2="12.01" y2="17" /></svg
        ></button
      >
    </nav>
  </div>

  {#if loading && repos.length === 0}
    <div class="loading-screen">
      <div class="loading-inline">
        <LoadingSpinner size="0.85rem" label="Loading" />
        <span>loading…</span>
      </div>
      {#if loadingTotal > 0}
        <p class="loading-slow">
          Scanning repos {loadingDone} / {loadingTotal}
        </p>
        <div class="loading-progress-track">
          <div
            class="loading-progress-bar"
            style="width: {loadingTotal > 0
              ? (loadingDone / loadingTotal) * 100
              : 0}%"
          ></div>
        </div>
      {:else if loadingSlow}
        <p class="loading-slow">Loading – scanning worktrees and sessions…</p>
      {/if}
    </div>
  {:else if rows.length === 0 || emptyReposDebug}
    <div class="empty-repos">
      <div class="add-folder-actions">
        <button
          class="add-folder-cta"
          on:click={pickAndAdd}
          disabled={addFolderBusy}
          title="Pick a folder to register as a repo"
        >
          {#if addFolderBusy}
            <LoadingSpinner size="0.85rem" />
            <span>Adding…</span>
          {:else}
            <svg
              class="add-folder-icon"
              width="20"
              height="20"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="1.8"
              stroke-linecap="round"
              stroke-linejoin="round"
              aria-hidden="true"
            >
              <path
                d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"
              />
              <path d="M12 11v6" />
              <path d="M9 14h6" />
            </svg>
            <span>Add folder</span>
          {/if}
        </button>
        <div class="import-sessions-anchor" class:flip-up={importFlipUp}>
          <button
            class="add-folder-cta"
            on:click|stopPropagation={toggleImportSessions}
            aria-haspopup="menu"
            aria-expanded={importSessionsOpen && importMenuSource === "inline"}
            title="Suggest folders to add based on detected AI agent sessions"
          >
            <svg
              class="add-folder-icon"
              width="20"
              height="20"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="1.8"
              stroke-linecap="round"
              stroke-linejoin="round"
              aria-hidden="true"
            >
              <path d="M12 3v12" />
              <path d="M7 10l5 5 5-5" />
              <path d="M5 21h14" />
            </svg>
            <span>Import from sessions</span>
          </button>
          {#if importSessionsOpen && importMenuSource === "inline"}
            <Popover variant="actions" extraClass="import-sessions-popover">
              <svelte:fragment slot="head">
                <div class="import-search-head">
                  <input
                    type="search"
                    class="import-search-input"
                    bind:value={importQuery}
                    placeholder="Folders from detected sessions"
                    aria-label="Filter folders from detected sessions"
                    use:focusOnMount
                    on:click|stopPropagation
                    on:keydown|stopPropagation
                  />
                  {#if importQuery.trim()}
                    <span class="import-search-count"
                      >{importFiltered.length}/{importSuggestions.length}</span
                    >
                  {/if}
                </div>
              </svelte:fragment>
              {#if importLoading}
                <div class="import-empty">
                  <LoadingSpinner size="0.85rem" label="Scanning sessions" />
                  <span>scanning sessions…</span>
                </div>
              {:else if importError}
                <div class="import-empty import-error">{importError}</div>
              {:else if importFiltered.length === 0}
                <div class="import-empty muted">
                  {#if importQuery.trim()}
                    No folders match.
                  {:else}
                    No new folders to suggest — every detected session's cwd is
                    already in the dashboard.
                  {/if}
                </div>
              {:else}
                <ul class="import-list">
                  {#each importFiltered as sug (sug.path)}
                    {@const busy = importAdding.has(sug.path)}
                    <li>
                      <button
                        type="button"
                        class="import-row"
                        class:busy
                        disabled={busy}
                        on:click={() => addRepoFromSuggestion(sug.path)}
                        title={`Add ${sug.path} to the dashboard`}
                      >
                        <span class="import-row-main">
                          {#if busy}
                            <span class="import-row-name"
                              ><LoadingSpinner size="0.75rem" /> Importing…</span
                            >
                          {:else}
                            <span class="import-row-name">{sug.name}</span>
                          {/if}
                          <span class="import-row-path muted small"
                            >{sug.path}</span
                          >
                          {#if sug.repoUrl}
                            <span class="import-row-url muted small"
                              >{sug.repoUrl}</span
                            >
                          {/if}
                        </span>
                        <span class="import-row-meta">
                          <span class="import-row-count">
                            <span
                              class="import-row-agents-icons"
                              aria-hidden="true"
                            >
                              {#each sug.agents as agent (agent)}
                                <AgentIcon {agent} size={14} />
                              {/each}
                            </span>
                            <span>
                              {sug.sessionCount} session{sug.sessionCount === 1
                                ? ""
                                : "s"}
                            </span>
                          </span>
                          <span class="import-row-time muted small">
                            {formatRelativeTime(sug.lastActive)}
                          </span>
                          <span class="import-row-agents-names muted small">
                            {sug.agents.join(", ")}
                          </span>
                        </span>
                      </button>
                    </li>
                  {/each}
                </ul>
              {/if}
            </Popover>
          {/if}
        </div>
        <button
          class="add-folder-cta"
          on:click={() => {
            provisionAttachJob = null;
            addDaemonOpen = true;
          }}
        >
          <svg
            class="add-folder-icon"
            width="20"
            height="20"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
            aria-hidden="true"
            ><rect x="2" y="3" width="20" height="14" rx="2" /><line
              x1="8"
              y1="21"
              x2="16"
              y2="21"
            /><line x1="12" y1="17" x2="12" y2="21" /></svg
          >
          <span>Add remote daemon</span>
        </button>
      </div>
      <p class="add-folder-sub muted small">
        Pick any folder on disk — git repo or not — to start tracking it.
      </p>
    </div>
  {:else}
    <ul class="rows">
      {#each rows as row, rowIdx (row.key)}
        {@const { repo, wt } = row}
        {@const summary = wt
          ? statusSummary(wt.fileStatus, wtSummaryByPath[wt.path])
          : null}
        {@const noteAnchor = wt ? `worktree:${wt.path}` : `repo:${repo.path}`}
        {@const noteCount = $notesCountByAnchor[noteAnchor] ?? 0}
        {@const isFirstOfRepo =
          rowIdx === 0 || rows[rowIdx - 1].repo.id !== repo.id}
        <li
          class="row"
          class:row-folded={rowFolded[row.key]}
          class:row-zen={zenRowKey === row.key}
          class:row-notes-hidden={zenRowKey !== null
            ? zenRowKey !== row.key || !notesShownInZen
            : !!notesHiddenByRow[row.key]}
          data-wt-row={wt ? wt.path : `${repo.id}|none`}
          data-repo-id={repo.id}
          use:rowVisibility={{ repoId: repo.id, rowKey: row.key }}
        >
          <div class="row-content">
            <div class="row-head">
              <button
                class="chevron fold-toggle"
                class:open={!rowFolded[row.key]}
                title={rowFolded[row.key]
                  ? `Expand \`${repo.name}${wt ? ` · ${wt.branch}` : ""}\``
                  : `Fold \`${repo.name}${wt ? ` · ${wt.branch}` : ""}\` to a minimal row`}
                aria-label={rowFolded[row.key] ? "Expand row" : "Fold row"}
                on:click|stopPropagation={() =>
                  toggleRowFolded(row.key, wt?.path)}
              >
                <span class="arrow">▸</span>
              </button>
              <!-- Clicking the chip opens an edit popover (name + accent
                 colour + a "Reorder repos…" entry point). The colour
                 picker's `input` fires continuously while dragging (live
                 chip preview via `repos = repos`); `change` fires once on
                 commit (when we persist). Right-click on it clears. -->
              <span class="repo-chip-anchor" data-repo-edit-anchor={row.key}>
                <button
                  class="repo-chip"
                  class:repo-chip-colored={!!repo.color}
                  title="Edit repo"
                  style={repo.color
                    ? `--repo-bg: ${repo.color}; --repo-fg: ${repoChipFg(repo.color)}`
                    : ""}
                  on:click|stopPropagation={() =>
                    editingRowKey === row.key
                      ? cancelRenameRepo()
                      : openRepoEdit(repo, row.key)}
                >
                  {#if repo.daemonId}<span class="daemon-scheme"
                      >{daemonLabelForRepo(repo.daemonId)}://</span
                    >{/if}{repo.name}
                  <span class="chip-tail">
                    <span class="pencil">✎</span>
                  </span>
                </button>
                {#if editingRowKey === row.key}
                  <Popover
                    variant="agents"
                    extraClass="repo-edit-popover"
                    headClass="repo-edit-popover-head"
                  >
                    <svelte:fragment slot="head">
                      <span>Edit repo</span>
                    </svelte:fragment>
                    <div class="repo-edit-body">
                      <label class="repo-edit-field">
                        <span class="repo-edit-label">Name</span>
                        <input
                          class="repo-edit-name"
                          use:focusAndSelect
                          bind:value={editRepoName}
                          on:keydown={(e) => {
                            if (e.key === "Enter") commitRenameRepo(repo.id);
                            if (e.key === "Escape") cancelRenameRepo();
                          }}
                        />
                      </label>
                      <div class="repo-edit-field">
                        <span class="repo-edit-label">Color</span>
                        <span class="repo-edit-color">
                          <input
                            class="repo-color-swatch"
                            type="color"
                            aria-label="Repo accent color"
                            title={repo.color
                              ? `Repo color (${repo.color}) — right-click to clear`
                              : "Set a repo accent color (right-click to clear)"}
                            value={repo.color ?? defaultChipHex}
                            style={repo.color
                              ? `--swatch-bg: ${repo.color}`
                              : `--swatch-bg: ${defaultChipHex}`}
                            on:input={(e) =>
                              previewRepoColor(
                                repo,
                                (e.currentTarget as HTMLInputElement).value,
                              )}
                            on:change={(e) =>
                              setRepoColor(
                                repo,
                                (e.currentTarget as HTMLInputElement).value,
                              )}
                            on:contextmenu|preventDefault={() =>
                              setRepoColor(repo, null)}
                          />
                          {#if repo.color}
                            <button
                              class="repo-edit-clear"
                              title="Clear accent color"
                              on:click|stopPropagation={() =>
                                setRepoColor(repo, null)}>Clear</button
                            >
                          {/if}
                        </span>
                      </div>
                      <button
                        class="repo-edit-reorder"
                        on:click|stopPropagation={() => {
                          void commitRenameRepo(repo.id);
                          // Key the highlight on repo.id (not row.key) so a
                          // repo with multiple worktree rows still maps to
                          // its single entry in the reorder list.
                          reorderHighlightRepoId = repo.id;
                          reorderDialogOpen = true;
                        }}
                      >
                        <svg
                          class="repo-edit-reorder-icon"
                          viewBox="0 0 24 24"
                          width="13"
                          height="13"
                          aria-hidden="true"
                          ><path
                            d="M8 5v14M8 5L4 9M8 5l4 4M16 19V5m0 14l-4-4m4 4l4-4"
                          /></svg
                        >
                        Reorder repos…
                      </button>
                      {#if repo.daemonId}
                        <button
                          class="repo-edit-remove-daemon"
                          on:click|stopPropagation={() => {
                            const d = repo.daemonId;
                            if (d) {
                              cancelRenameRepo();
                              void removeDaemon(d);
                            }
                          }}
                        >
                          Remove daemon
                        </button>
                      {/if}
                    </div>
                  </Popover>
                {/if}
              </span>

              {#if wt}
                {#if wt.nonGit}
                  <span class="branch muted">folder</span>
                {:else if wt.detached}
                  <span class="branch detached"
                    >detached @ {wt.head.slice(0, 7)}</span
                  >
                {:else if wt.bare}
                  <span class="branch bare">bare</span>
                {:else}
                  <span class="branch-anchor" data-branch-anchor={wt.path}>
                    <button
                      class="branch branch-button"
                      title={`Click to switch this worktree to another branch.\nDirty state opens a dialog with Stash / Force / Cancel.`}
                      on:click|stopPropagation={() => {
                        const opening = !branchPickerOpen[wt.path];
                        branchPickerOpen = {
                          ...branchPickerOpen,
                          [wt.path]: opening,
                        };
                        if (opening) void loadBranchesFor(repo.id, wt.path);
                      }}
                      ><svg
                        class="branch-icon"
                        viewBox="0 0 24 24"
                        width="12"
                        height="12"
                        aria-hidden="true"
                        ><path
                          d="M6 3v12M18 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM6 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM18 9c0 4-4 6-12 6"
                        /></svg
                      >{wt.branch}
                      <span class="branch-caret" aria-hidden="true">▾</span
                      ></button
                    >
                    {#if branchPickerOpen[wt.path]}
                      <Popover
                        variant="agents"
                        extraClass="branch-popover"
                        headClass="branch-popover-head"
                      >
                        <svelte:fragment slot="head">
                          <span>Switch branch in {wt.branch}</span>
                          <button
                            class="branch-sort-toggle"
                            title="Toggle branch sort order"
                            on:click|stopPropagation={() => {
                              branchSortMode =
                                branchSortMode === "recency"
                                  ? "alpha"
                                  : "recency";
                            }}
                          >
                            sort: {branchSortMode === "recency"
                              ? "recency"
                              : "A–Z"} ↻
                          </button>
                        </svelte:fragment>
                        {#if (repo.remotes ?? []).length > 1}
                          <label
                            class="branch-remote-field"
                            on:click|stopPropagation
                          >
                            <span>Remote</span>
                            <select
                              value={selectedRemoteFor(repo) ?? ""}
                              on:change={(e) =>
                                setSelectedRemote(
                                  repo,
                                  (e.currentTarget as HTMLSelectElement).value,
                                )}
                            >
                              {#each repo.remotes ?? [] as remote (remote.name)}
                                <option value={remote.name}>
                                  {remote.name}
                                </option>
                              {/each}
                            </select>
                          </label>
                        {/if}
                        {#if branchesLoading[wt.path]}
                          <p class="muted small nopad">Loading branches…</p>
                        {:else}
                          {@const b = branchesByWt[wt.path]}
                          {#if !b || (b.local.length === 0 && b.remote.length === 0)}
                            <p class="muted small nopad">No branches found.</p>
                          {:else}
                            {@const sortedLocal = sortBranches(
                              b.local,
                              branchSortMode,
                            )}
                            {@const sortedRemote = sortBranches(
                              b.remote,
                              branchSortMode,
                            )}
                            <ul class="agents-list">
                              {#each sortedLocal as bname (bname)}
                                <li>
                                  <button
                                    class="agent-row branch-row"
                                    class:branch-row-current={bname ===
                                      b.current}
                                    disabled={bname === b.current}
                                    on:click={() =>
                                      tryCheckout(repo.id, wt.path, bname)}
                                    title={bname === b.current
                                      ? "Currently checked out"
                                      : `Run \`git checkout ${bname}\` here`}
                                  >
                                    <span
                                      class="branch-tick"
                                      aria-hidden="true"
                                    >
                                      {bname === b.current ? "●" : ""}
                                    </span>
                                    <span class="agent-row-name">{bname}</span>
                                    <span class="agent-title muted">local</span>
                                  </button>
                                </li>
                              {/each}
                              {#each sortedRemote as bname (bname)}
                                <li>
                                  <button
                                    class="agent-row branch-row"
                                    on:click={() =>
                                      tryCheckout(repo.id, wt.path, bname)}
                                    title={`Create local tracking branch from \`${bname}\` and check it out`}
                                  >
                                    <span class="branch-tick" aria-hidden="true"
                                    ></span>
                                    <span class="agent-row-name">{bname}</span>
                                    <span class="agent-title muted">remote</span
                                    >
                                  </button>
                                </li>
                              {/each}
                            </ul>
                          {/if}
                        {/if}
                      </Popover>
                    {/if}
                  </span>
                {/if}
                {#if wt && badgeAnimDebug}
                  <span class="status-badge-debug-row">
                    <StatusBadge
                      ahead={1}
                      behind={0}
                      dirty={0}
                      pulsate={pulsateDebug}
                    />
                    <StatusBadge ahead={0} behind={1} dirty={0} />
                  </span>
                {:else if wt && !wt.nonGit}
                  {@const fAhead = pushCount(wt.branchStatus)}
                  {@const fBehind = wt.branchStatus?.behind ?? 0}
                  {@const fDirty =
                    wt.fileStatus.staged +
                    wt.fileStatus.unstaged +
                    wt.fileStatus.untracked}
                  {@const fDirtyWarn =
                    fDirty > 3 || (wt.fileStatus.dirtyLines ?? 0) > 200}
                  {#if fAhead > 0}
                    <Tooltip
                      variant="wide"
                      onShow={() => loadWtSummary(wt.path)}
                    >
                      <span slot="trigger" class="status-badge-trigger">
                        <StatusBadge
                          ahead={fAhead}
                          danger={pushBadgeDanger(wt.branchStatus)}
                          pulsate={wt.branchStatus
                            ? aheadAged(wt.branchStatus)
                            : false}
                          onClick={() => tryPush(repo.id, wt.path)}
                          busy={!!pushBusy[wt.path]}
                          title={wt.branchStatus?.upstream
                            ? `Push ${fAhead} commit${fAhead === 1 ? "" : "s"} to ${wt.branchStatus.upstream}`
                            : `${fAhead} commit${fAhead === 1 ? "" : "s"} on no remote — set an upstream to push`}
                        />
                      </span>
                      <span slot="content" class="wt-tt-content">
                        <div class="wt-tt-section-head">
                          {aheadTooltip(wt.branchStatus)}
                        </div>
                        {#if wtSummaryByPath[wt.path] === undefined || wtSummaryByPath[wt.path] === "loading"}
                          <span class="muted small">Loading commits…</span>
                        {:else}
                          {@const s = wtSummaryByPath[wt.path]}
                          {#if s !== "loading" && s !== undefined && s.unpushedCommits.length > 0}
                            <div class="wt-tt-commits">
                              {#each s.unpushedCommits.slice(0, COMMIT_TOOLTIP_LIMIT) as c}
                                <span class="wt-tt-sha"
                                  >{c.sha.slice(0, 7)}</span
                                >
                                <span
                                  class="wt-tt-author"
                                  title={c.author ?? ""}>{c.author ?? ""}</span
                                >
                                <span class="wt-tt-date"
                                  >{c.date ? relTime(c.date) : ""}</span
                                >
                                <span class="wt-tt-subject" title={c.subject}
                                  >{clampSubject(c.subject)}</span
                                >
                              {/each}
                            </div>
                            {#if s.unpushedCommits.length > COMMIT_TOOLTIP_LIMIT}
                              <div class="wt-tt-more">
                                +{s.unpushedCommits.length -
                                  COMMIT_TOOLTIP_LIMIT} more
                              </div>
                            {/if}
                          {/if}
                        {/if}
                      </span>
                    </Tooltip>
                  {/if}
                  {#if fBehind > 0}
                    <Tooltip
                      variant="wide"
                      onShow={() => loadWtSummary(wt.path)}
                    >
                      <span slot="trigger" class="status-badge-trigger">
                        <StatusBadge
                          behind={fBehind}
                          onClick={() => tryPull(repo.id, wt.path)}
                          busy={!!pullBusy[wt.path]}
                          title={`Pull ${fBehind} commit${fBehind === 1 ? "" : "s"} from ${wt.branchStatus?.upstream ?? "upstream"}`}
                        />
                      </span>
                      <span slot="content" class="wt-tt-content">
                        <div class="wt-tt-section-head">
                          {fBehind} commit{fBehind === 1 ? "" : "s"} to pull from
                          {wt.branchStatus?.upstream ?? "upstream"}
                        </div>
                        {#if wtSummaryByPath[wt.path] === undefined || wtSummaryByPath[wt.path] === "loading"}
                          <span class="muted small">Loading commits…</span>
                        {:else}
                          {@const s = wtSummaryByPath[wt.path]}
                          {#if s !== "loading" && s !== undefined && s.unfetchedCommits && s.unfetchedCommits.length > 0}
                            <div class="wt-tt-commits">
                              {#each s.unfetchedCommits.slice(0, COMMIT_TOOLTIP_LIMIT) as c}
                                <span class="wt-tt-sha"
                                  >{c.sha.slice(0, 7)}</span
                                >
                                <span
                                  class="wt-tt-author"
                                  title={c.author ?? ""}>{c.author ?? ""}</span
                                >
                                <span class="wt-tt-date"
                                  >{c.date ? relTime(c.date) : ""}</span
                                >
                                <span class="wt-tt-subject" title={c.subject}
                                  >{clampSubject(c.subject)}</span
                                >
                              {/each}
                            </div>
                            {#if s.unfetchedCommits.length > COMMIT_TOOLTIP_LIMIT}
                              <div class="wt-tt-more">
                                +{s.unfetchedCommits.length -
                                  COMMIT_TOOLTIP_LIMIT} more
                              </div>
                            {/if}
                          {/if}
                        {/if}
                      </span>
                    </Tooltip>
                  {/if}
                  {#if fDirty > 0}
                    <Tooltip
                      variant="wide"
                      onShow={() => loadWtSummary(wt.path)}
                    >
                      <span slot="trigger" class="status-badge-trigger">
                        <StatusBadge dirty={fDirty} warn={fDirtyWarn} />
                      </span>
                      <span slot="content" class="wt-tt-content">
                        <ChangedFilesTooltipBody
                          summary={wtSummaryByPath[wt.path]}
                          worktreePath={wt.path}
                          daemonId={daemonIdForWorktreePath(repos, wt.path)}
                          refreshing={!!wtSummaryRefreshing[wt.path]}
                        />
                      </span>
                    </Tooltip>
                  {/if}
                  {#if fAhead === 0 && fBehind === 0 && fDirty === 0 && wt.branchStatus?.upstream}
                    <span
                      class="status-badge status-badge-sync"
                      title="In sync with {wt.branchStatus.upstream}"
                    >
                      <svg
                        class="sync-check-icon"
                        viewBox="0 0 16 16"
                        fill="none"
                        stroke="currentColor"
                        stroke-width="2.2"
                        stroke-linecap="round"
                        stroke-linejoin="round"
                        ><polyline points="3.5 8.5 6.5 11.5 12.5 5" /></svg
                      >
                    </span>
                  {/if}
                {/if}
                {#if wt}
                  {@const a =
                    wt.agents && wt.agents.length > 0 ? wt.agents[0] : null}
                  {@const pickerSessions =
                    pickerSessionsByWt[wt.path] ?? wt.agents ?? []}
                  {@const activeTuis = activeTuisByWt[wt.path] ?? []}
                  <span
                    class="agent-wrap"
                    style={repo.color ? `--repo-bg: ${repo.color}` : ""}
                    data-agents-anchor={wt.path}
                    data-active-tuis-anchor={wt.path}
                    data-new-agent-anchor={wt.path}
                  >
                    <button
                      class="agent-add {a ? `agent-${a.agent}` : 'agent-empty'}"
                      title="Start a new session in this worktree"
                      on:click|stopPropagation={() => {
                        newAgentPopoverOpen = {
                          ...newAgentPopoverOpen,
                          [wt.path]: !newAgentPopoverOpen[wt.path],
                        };
                      }}>+</button
                    >
                    {#if newAgentPopoverOpen[wt.path]}
                      {@const rowDaemonId = daemonIdForWorktreePath(
                        repos,
                        wt.path,
                      )}
                      {@const rowAgents =
                        agentsByDaemon[rowDaemonId ?? "local"] ??
                        installedAgents}
                      {@const rowShell =
                        shellByDaemon[rowDaemonId ?? "local"] ?? defaultShell}
                      {@const rowShells =
                        shellsByDaemon[rowDaemonId ?? "local"] ?? []}
                      <Popover variant="agents" extraClass="new-agent-popover">
                        <svelte:fragment slot="head"
                          >Start a new session</svelte:fragment
                        >
                        <ul class="agents-list">
                          {#each rowAgents as ag (ag.name)}
                            <li>
                              {#if ag.name === "ollama"}
                                <button
                                  class="agent-row new-agent-row"
                                  on:click={() => {
                                    ollamaSubmenuOpen = {
                                      ...ollamaSubmenuOpen,
                                      [wt.path]: !ollamaSubmenuOpen[wt.path],
                                    };
                                    if (ollamaSubmenuOpen[wt.path]) {
                                      void ensureOllamaModelsLoaded();
                                    }
                                  }}
                                  title={`Pick an Ollama model to spawn \`ollama run <model>\` in ${wt.path}`}
                                >
                                  <img
                                    class="agent-row-icon"
                                    src="/agents/ollama.svg"
                                    alt=""
                                  />
                                  <span class="agent-row-name">Ollama</span>
                                  <span class="agent-title muted">
                                    {ollamaSubmenuOpen[wt.path] ? "▾" : "▸"} pick
                                    model
                                  </span>
                                </button>
                                {#if ollamaSubmenuOpen[wt.path]}
                                  <ul class="agents-list ollama-models-list">
                                    {#if ollamaModelsLoading}
                                      <li class="muted ollama-models-info">
                                        loading models…
                                      </li>
                                    {:else if ollamaModelsError}
                                      <li class="muted ollama-models-info">
                                        couldn't load models ({ollamaModelsError}).
                                        <button
                                          class="link-btn"
                                          on:click={() =>
                                            void ensureOllamaModelsLoaded(true)}
                                          >retry</button
                                        >
                                      </li>
                                    {:else if ollamaModels.length === 0}
                                      <li class="muted ollama-models-info">
                                        no models found. Run <code
                                          >ollama pull &lt;model&gt;</code
                                        > first.
                                      </li>
                                    {:else}
                                      {#each ollamaModels as m (m.name)}
                                        <li>
                                          <button
                                            class="agent-row new-agent-row ollama-model-row"
                                            on:click={() => {
                                              newAgentPopoverOpen = {
                                                ...newAgentPopoverOpen,
                                                [wt.path]: false,
                                              };
                                              ollamaSubmenuOpen = {
                                                ...ollamaSubmenuOpen,
                                                [wt.path]: false,
                                              };
                                              unfoldRowIfFolded(row.key);
                                              void openNewOllamaChat(
                                                wt.path,
                                                m.name,
                                              );
                                            }}
                                            title={`Open a chat with ${m.name} in ${wt.path} (API-driven, full memory)`}
                                          >
                                            <img
                                              class="agent-row-icon"
                                              src="/agents/ollama.svg"
                                              alt=""
                                            />
                                            <span class="agent-row-name"
                                              >{m.name}</span
                                            >
                                            <span class="agent-title muted">
                                              {m.parameterSize ?? ""}
                                            </span>
                                          </button>
                                        </li>
                                      {/each}
                                    {/if}
                                  </ul>
                                {/if}
                              {:else}
                                <button
                                  class="agent-row new-agent-row"
                                  on:click={() => {
                                    newAgentPopoverOpen = {
                                      ...newAgentPopoverOpen,
                                      [wt.path]: false,
                                    };
                                    unfoldRowIfFolded(row.key);
                                    openNewAgentSession(
                                      wt.path,
                                      ag.name as "claude" | "codex",
                                    );
                                  }}
                                  title={`Spawn \`${ag.name}\` CLI (no --resume) in ${wt.path}`}
                                >
                                  {#if ag.name === "claude"}
                                    <img
                                      class="agent-row-icon"
                                      src="/agents/claude.svg"
                                      alt=""
                                    />
                                  {:else if ag.name === "codex"}
                                    <img
                                      class="agent-row-icon"
                                      src="/agents/codex.svg"
                                      alt=""
                                    />
                                  {:else}
                                    <span class="agent-dot agent-shell"></span>
                                  {/if}
                                  <span class="agent-row-name">
                                    {ag.name === "claude"
                                      ? "Claude"
                                      : ag.name === "codex"
                                        ? "Codex CLI"
                                        : ag.name}
                                  </span>
                                  <span class="agent-title muted"
                                    >{ag.path}</span
                                  >
                                </button>
                                {#if ag.name === "codex"}
                                  <button
                                    class="agent-row new-agent-row"
                                    on:click={() => {
                                      newAgentPopoverOpen = {
                                        ...newAgentPopoverOpen,
                                        [wt.path]: false,
                                      };
                                      unfoldRowIfFolded(row.key);
                                      void openNewCodexAppSession(wt.path);
                                    }}
                                    title={`Start Codex app-server chat in ${wt.path}`}
                                  >
                                    <img
                                      class="agent-row-icon"
                                      src="/agents/codex.svg"
                                      alt=""
                                    />
                                    <span class="agent-row-name">Codex App</span
                                    >
                                    <span class="agent-title muted">
                                      app-server
                                    </span>
                                  </button>
                                {/if}
                              {/if}
                            </li>
                          {/each}
                          <!-- Terminal entry/entries. Spawns a plain PTY in
                             this worktree — no JSONL transcript, just an
                             interactive shell column. When the box reports
                             >1 shell (Windows: PowerShell + CMD via
                             /api/shells/available) we fan out one entry per
                             shell; otherwise a single "Terminal" running the
                             box's default $SHELL. -->
                          {#if rowShells.length > 1}
                            {#each rowShells as shellOpt}
                              <li>
                                <button
                                  class="agent-row new-agent-row"
                                  on:click={() => {
                                    newAgentPopoverOpen = {
                                      ...newAgentPopoverOpen,
                                      [wt.path]: false,
                                    };
                                    unfoldRowIfFolded(row.key);
                                    openNewTerminalInWt(wt.path, shellOpt);
                                  }}
                                  title={`Spawn ${shellOpt.shell} as a plain terminal in ${wt.path}`}
                                >
                                  <svg
                                    class="agent-row-icon-svg"
                                    viewBox="0 0 24 24"
                                    fill="none"
                                    stroke="currentColor"
                                    stroke-width="1.8"
                                    stroke-linecap="round"
                                    stroke-linejoin="round"
                                    aria-hidden="true"
                                    ><path d="M4 17l5-5-5-5" /><path
                                      d="M11 19h8"
                                    /></svg
                                  >
                                  <span class="agent-row-name"
                                    >{shellOpt.label}</span
                                  >
                                  <span class="agent-title muted"
                                    >{shellOpt.shell}</span
                                  >
                                </button>
                              </li>
                            {/each}
                          {:else}
                            <li>
                              <button
                                class="agent-row new-agent-row"
                                on:click={() => {
                                  newAgentPopoverOpen = {
                                    ...newAgentPopoverOpen,
                                    [wt.path]: false,
                                  };
                                  unfoldRowIfFolded(row.key);
                                  openNewTerminalInWt(wt.path);
                                }}
                                title={`Spawn ${rowShell} as a plain terminal in ${wt.path}`}
                              >
                                <svg
                                  class="agent-row-icon-svg"
                                  viewBox="0 0 24 24"
                                  fill="none"
                                  stroke="currentColor"
                                  stroke-width="1.8"
                                  stroke-linecap="round"
                                  stroke-linejoin="round"
                                  aria-hidden="true"
                                  ><path d="M4 17l5-5-5-5" /><path
                                    d="M11 19h8"
                                  /></svg
                                >
                                <span class="agent-row-name">Terminal</span>
                                <span class="agent-title muted">{rowShell}</span
                                >
                              </button>
                            </li>
                          {/if}
                          <li>
                            <button
                              class="agent-row new-agent-row"
                              on:click={() => {
                                newAgentPopoverOpen = {
                                  ...newAgentPopoverOpen,
                                  [wt.path]: false,
                                };
                                unfoldRowIfFolded(row.key);
                                openFileBrowser(wt.path);
                              }}
                              title={`Browse files in ${wt.path}`}
                            >
                              <svg
                                class="agent-row-icon-svg"
                                viewBox="0 0 24 24"
                                fill="none"
                                stroke="currentColor"
                                stroke-width="1.8"
                                stroke-linecap="round"
                                stroke-linejoin="round"
                                aria-hidden="true"
                                ><path
                                  d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"
                                /></svg
                              >
                              <span class="agent-row-name">Files</span>
                              <span class="agent-title muted">browse</span>
                            </button>
                          </li>
                          <li>
                            <button
                              class="agent-row new-agent-row"
                              on:click={() => {
                                newAgentPopoverOpen = {
                                  ...newAgentPopoverOpen,
                                  [wt.path]: false,
                                };
                                unfoldRowIfFolded(row.key);
                                openGitHistory(wt.path);
                              }}
                              title={`Git commit history for ${wt.path}`}
                            >
                              <svg
                                class="agent-row-icon-svg"
                                viewBox="0 0 24 24"
                                fill="none"
                                stroke="currentColor"
                                stroke-width="1.8"
                                stroke-linecap="round"
                                stroke-linejoin="round"
                                aria-hidden="true"
                                ><circle cx="12" cy="12" r="3" /><line
                                  x1="12"
                                  y1="3"
                                  x2="12"
                                  y2="9"
                                /><line x1="12" y1="15" x2="12" y2="21" /></svg
                              >
                              <span class="agent-row-name">History</span>
                              <span class="agent-title muted">commits</span>
                            </button>
                          </li>
                        </ul>
                      </Popover>
                    {/if}
                    {#if a}
                      <button
                        class="agent-badge agent-{a.agent}"
                        class:active={isSessionOpenInWt(wt.path, {
                          agent: a.agent,
                          source: a.source,
                          sessionId: a.sessionId,
                        })}
                        title={activeTuis.length > 1
                          ? `Jump to one of ${activeTuis.length} active TUIs in this worktree`
                          : `${a.manualTitle ?? a.aiTitle ?? `Show the latest ${a.agent} session`}\nLast active ${relTime(a.lastActive)}`}
                        on:click|stopPropagation={() => {
                          // With several live TUIs, the badge becomes a
                          // jumper popover — listing only sessions whose
                          // PTY is mounted right now — so the user can hop
                          // between them in one click instead of cycling
                          // via revealSession. With ≤1 active TUI the
                          // popover would be empty/redundant, so fall
                          // through to the classic reveal behavior.
                          if (activeTuis.length > 1) {
                            // Mutually exclusive with the count-chip's
                            // "all sessions" popover — only one of the two
                            // row-head popovers should be open at a time.
                            agentsPopoverOpen = {
                              ...agentsPopoverOpen,
                              [wt.path]: false,
                            };
                            activeTuisPopoverOpen = {
                              ...activeTuisPopoverOpen,
                              [wt.path]: !activeTuisPopoverOpen[wt.path],
                            };
                            return;
                          }
                          revealSession(row.key, wt.path, {
                            agent: a.agent,
                            source: a.source,
                            resumeSessionId: a.sessionId,
                          });
                        }}
                      >
                        {#if a.manualTitle}
                          <span class="agent-manual-title">{a.manualTitle}</span
                          >
                          <span class="muted small"
                            >{relTime(a.lastActive)}</span
                          >
                        {:else if a.aiTitle}
                          <span class="agent-manual-title ai-title"
                            >{a.aiTitle}</span
                          >
                          <span class="muted small"
                            >{relTime(a.lastActive)}</span
                          >
                        {:else if a.title}
                          <span class="agent-manual-title">{a.title}</span>
                          <span class="muted small"
                            >{relTime(a.lastActive)}</span
                          >
                        {:else}
                          {a.agent} {relTime(a.lastActive)}
                        {/if}
                      </button>
                      {#if activeTuisPopoverOpen[wt.path] && activeTuis.length > 1}
                        <SessionSearchList
                          sessions={activeTuis}
                          headText={`${activeTuis.length} active TUIs in this worktree`}
                          dismissedSources={dismissedSessions}
                          starredSources={starredSessions}
                          isOpen={(s) => isSessionOpenInWt(wt.path, s)}
                          tooltipFor={(s) => sessionTooltip(s)}
                          surfaceFor={sessionSurfaceForPicker}
                          on:pick={(e) => {
                            activeTuisPopoverOpen = {
                              ...activeTuisPopoverOpen,
                              [wt.path]: false,
                            };
                            revealSession(row.key, wt.path, {
                              agent: e.detail.agent,
                              source: e.detail.source,
                              resumeSessionId: e.detail.sessionId,
                            });
                          }}
                          on:close={(e) => {
                            toggleOpenSessionInWt(wt.path, {
                              agent: e.detail.agent,
                              source: e.detail.source,
                              resumeSessionId: e.detail.sessionId,
                            });
                          }}
                          on:dismiss={(e) => dismissSession(e.detail.source)}
                          on:restore={(e) => restoreSession(e.detail.source)}
                        />
                      {/if}
                    {/if}
                    {#if a && pickerSessions.length > 1}
                      <button
                        class="agent-more agent-{a.agent}"
                        class:has-search={stripSearchOpen[wt.path]}
                        title={`Pick from ${pickerSessions.length} sessions in this worktree`}
                        on:click|stopPropagation={() => {
                          // Mutually exclusive with the agent-badge's
                          // active-TUIs jumper — only one of the two
                          // row-head popovers should be open at a time.
                          activeTuisPopoverOpen = {
                            ...activeTuisPopoverOpen,
                            [wt.path]: false,
                          };
                          agentsPopoverOpen = {
                            ...agentsPopoverOpen,
                            [wt.path]: !agentsPopoverOpen[wt.path],
                          };
                        }}>{pickerSessions.length}</button
                      >
                      <button
                        class="agent-search agent-{a.agent}"
                        class:active={stripSearchOpen[wt.path]}
                        title="Filter this row's sessions by title or message"
                        aria-label="Filter sessions"
                        on:click|stopPropagation={() => {
                          if (stripSearchOpen[wt.path]) {
                            closeStripSearch(row.key, wt.path);
                          } else {
                            openStripSearch(row.key, wt.path);
                          }
                        }}
                      >
                        <svg
                          viewBox="0 0 16 16"
                          aria-hidden="true"
                          width="11"
                          height="11"
                        >
                          <path
                            fill="none"
                            stroke="currentColor"
                            stroke-width="1.8"
                            stroke-linecap="round"
                            d="M7 2.5a4.5 4.5 0 1 0 0 9 4.5 4.5 0 0 0 0-9zM13.5 13.5l-3-3"
                          />
                        </svg>
                      </button>
                      {#if stripSearchOpen[wt.path]}
                        <input
                          class="agent-search-input"
                          type="search"
                          placeholder="filter…"
                          bind:value={stripSearchQuery[wt.path]}
                          on:click|stopPropagation
                          on:keydown|stopPropagation={(e) => {
                            if (e.key === "Escape") {
                              closeStripSearch(row.key, wt.path);
                            } else if (e.key === "Enter") {
                              // Enter picks the top "not in strip" match —
                              // matches users typing to find a chat, then
                              // hitting return to open it without grabbing
                              // the mouse. No-op when there's no such match.
                              const top = stripFilterByWt[wt.path]?.notOpen[0];
                              if (top) {
                                pinRowOpenAfterPick(row.key);
                                revealSession(row.key, wt.path, {
                                  agent: top.agent,
                                  source: top.source,
                                  resumeSessionId: top.sessionId,
                                });
                              }
                            }
                          }}
                          use:focusOnMount
                        />
                      {/if}
                      {#if agentsPopoverOpen[wt.path]}
                        <SessionSearchList
                          sessions={pickerSessions}
                          headText={`${pickerSessions.length} sessions in this worktree`}
                          dismissedSources={dismissedSessions}
                          starredSources={starredSessions}
                          isOpen={(s) => isSessionOpenInWt(wt.path, s)}
                          tooltipFor={(s) => sessionTooltip(s)}
                          surfaceFor={sessionSurfaceForPicker}
                          on:pick={(e) => {
                            agentsPopoverOpen = {
                              ...agentsPopoverOpen,
                              [wt.path]: false,
                            };
                            // `revealSession` (mode "reveal") forces the
                            // scroll-to-center + flash cue even when the
                            // column is already open. The user's just
                            // pointed at a row in the picker — they need
                            // a clear visual confirmation of which one
                            // they chose, same affordance the synthetic
                            // not-in-strip list uses.
                            revealSession(row.key, wt.path, {
                              agent: e.detail.agent,
                              source: e.detail.source,
                              resumeSessionId: e.detail.sessionId,
                            });
                          }}
                          on:close={(e) => {
                            toggleOpenSessionInWt(wt.path, {
                              agent: e.detail.agent,
                              source: e.detail.source,
                              resumeSessionId: e.detail.sessionId,
                            });
                          }}
                          on:dismiss={(e) => dismissSession(e.detail.source)}
                          on:restore={(e) => restoreSession(e.detail.source)}
                        />
                      {/if}
                    {/if}
                  </span>
                {/if}
                {#if rowFolded[row.key] && wtHasRecentActivity(wt, nowMs)}
                  <!-- Lives right of the agent-wrap (sessions dropdown +
                     "+ new" cluster) and just before the wt-path, so
                     when an agent is mid-output the spinner sits with
                     the other agent UI instead of squeezing between
                     the branch chip and the dropdown. -->
                  <span
                    class="popover-spinner row-activity-spinner"
                    title="An agent in this row had output in the last 10s"
                    aria-label="agent activity"
                  ></span>
                {/if}
                <code class="wt-path">{wt.path}</code>
              {:else if repo.pending || !Array.isArray(repo.worktrees)}
                <!-- Skeleton from the manifest — its git fan-out hasn't
                   streamed in yet (repo.pending is set; both a skeleton and
                   an enriched-but-genuinely-empty repo have worktrees: [],
                   so the flag is what tells them apart). Show a centered
                   loading state instead of a misleading "no worktrees". -->
                <span class="repo-row-loading">
                  <span class="popover-spinner" aria-hidden="true"></span>
                  loading {repoName(repo)}
                </span>
              {:else}
                <code class="wt-path">{repo.path}</code>
                <span class="branch warn">no worktrees</span>
              {/if}

              <!-- Three-piece notes tag, fused via flex like the
                 repo-chip + color-swatch pair: count attachment on
                 the LEFT (only when there's at least one note),
                 `notes` toggle in the MIDDLE (CSS-only hide of this
                 row's notes — components stay mounted), `+` add on
                 the RIGHT. Same .new-wt dashed-tag styling as the
                 worktrees button so the row's action group reads as
                 a single family. -->
              {#if !rowFolded[row.key]}
                <span class="note-add-stack">
                  {#if noteCount > 0}
                    <span
                      class="row-note-count-anchor"
                      data-notes-list-anchor={row.key}
                    >
                      <button
                        type="button"
                        class="row-note-count"
                        class:open={!!notesListOpen[row.key]}
                        title={`${noteCount} sticky note${noteCount === 1 ? "" : "s"} pinned to this ${wt ? "worktree" : "repo"} — click to list / undo deletes`}
                        on:click|stopPropagation={() => {
                          notesListOpen = {
                            ...notesListOpen,
                            [row.key]: !notesListOpen[row.key],
                          };
                        }}>{noteCount}</button
                      >
                      {#if notesListOpen[row.key]}
                        {@const anchorStr = noteAnchor}
                        {@const rowNotes = $notesAll.filter((n) =>
                          n.anchors.some((a) => a === anchorStr),
                        )}
                        {@const rowDeletes =
                          removeNoteEventsByAnchor[anchorStr] ?? []}
                        {@const visibleNotes = rowNotes
                          .filter((n) => n.kind !== "emoji")
                          .map((n) => ({ n, display: notesListDisplay(n) }))
                          .filter((row) => row.display.text.length > 0)}
                        {@const visibleDeletes = rowDeletes
                          .filter((ev) => ev.inverse?.note?.kind !== "emoji")
                          .slice(0, 20)
                          .map((ev) => ({
                            ev,
                            display: notesListDisplay({
                              body:
                                (ev.inverse?.note?.body as
                                  | string
                                  | undefined) ?? "",
                              kind: ev.inverse?.note?.kind,
                              target: ev.inverse?.note?.target,
                            }),
                          }))
                          .filter((r) => r.display.text.length > 0)}
                        <Popover
                          variant="agents"
                          extraClass="notes-list-popover"
                        >
                          <svelte:fragment slot="head">
                            Notes on {wt
                              ? `${repo.name ?? repoName(repo)} · ${wt.branch ?? "?"}`
                              : (repo.name ?? repoName(repo))}
                          </svelte:fragment>
                          <div class="notes-list-section">
                            {#if visibleNotes.length === 0}
                              <p class="muted small nopad">
                                No notes with content.
                              </p>
                            {:else}
                              <ul class="notes-list">
                                {#each visibleNotes as row (row.n.id)}
                                  {@const n = row.n}
                                  <li
                                    class="notes-list-row"
                                    class:is-link={row.display.kind === "link"}
                                  >
                                    <span
                                      class="notes-list-kind"
                                      aria-hidden="true"
                                    >
                                      {#if row.display.kind === "link"}
                                        {#if row.display.agent || row.display.provider || row.display.glyph}
                                          <AttachmentIcon
                                            agent={row.display.agent}
                                            provider={row.display.provider}
                                            glyph={row.display.glyph}
                                            size={14}
                                          />
                                        {:else}
                                          <svg
                                            viewBox="0 0 24 24"
                                            width="12"
                                            height="12"
                                            fill="none"
                                            stroke="currentColor"
                                            stroke-width="2.2"
                                            stroke-linecap="round"
                                            stroke-linejoin="round"
                                            aria-hidden="true"
                                          >
                                            <path
                                              d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"
                                            />
                                            <path
                                              d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"
                                            />
                                          </svg>
                                        {/if}
                                      {:else}
                                        <NoteIcon size={13} />
                                      {/if}
                                    </span>
                                    <span
                                      class="notes-list-body"
                                      title={row.display.title}
                                      >{row.display.text}</span
                                    >
                                    <span class="muted ev-time"
                                      >{relTime(n.updatedAt)}</span
                                    >
                                  </li>
                                {/each}
                              </ul>
                            {/if}
                          </div>
                          <div class="notes-list-section">
                            <div class="notes-list-section-head">
                              Recently deleted ({visibleDeletes.length})
                            </div>
                            {#if visibleDeletes.length === 0}
                              <p class="muted small nopad">None.</p>
                            {:else}
                              <ul class="notes-list">
                                {#each visibleDeletes as r (r.ev.id)}
                                  <li
                                    class="notes-list-row deleted"
                                    class:is-link={r.display.kind === "link"}
                                  >
                                    <span
                                      class="notes-list-kind"
                                      aria-hidden="true"
                                    >
                                      {#if r.display.kind === "link"}
                                        {#if r.display.agent || r.display.provider || r.display.glyph}
                                          <AttachmentIcon
                                            agent={r.display.agent}
                                            provider={r.display.provider}
                                            glyph={r.display.glyph}
                                            size={14}
                                          />
                                        {:else}
                                          <svg
                                            viewBox="0 0 24 24"
                                            width="12"
                                            height="12"
                                            fill="none"
                                            stroke="currentColor"
                                            stroke-width="2.2"
                                            stroke-linecap="round"
                                            stroke-linejoin="round"
                                            aria-hidden="true"
                                          >
                                            <path
                                              d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"
                                            />
                                            <path
                                              d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"
                                            />
                                          </svg>
                                        {/if}
                                      {:else}
                                        <NoteIcon size={13} />
                                      {/if}
                                    </span>
                                    <span
                                      class="notes-list-body"
                                      title={r.display.title}
                                      >{r.display.text}</span
                                    >
                                    <span class="muted ev-time"
                                      >{relTime(r.ev.timestamp)}</span
                                    >
                                    <button
                                      class="undo"
                                      on:click={(e) =>
                                        void undoNoteDelete(
                                          r.ev,
                                          e.currentTarget as HTMLElement,
                                        )}
                                      title="Restore this deleted note"
                                      >Undo</button
                                    >
                                  </li>
                                {/each}
                              </ul>
                            {/if}
                          </div>
                        </Popover>
                      {/if}
                    </span>
                  {/if}
                  <button
                    class="new-wt notes-toggle"
                    class:active={zenRowKey === row.key
                      ? notesShownInZen
                      : !notesHiddenByRow[row.key]}
                    title={(
                      zenRowKey === row.key
                        ? notesShownInZen
                        : !notesHiddenByRow[row.key]
                    )
                      ? "Hide this row's sticky notes"
                      : "Show this row's sticky notes"}
                    on:click|stopPropagation={() => {
                      if (zenRowKey === row.key)
                        notesShownInZen = !notesShownInZen;
                      else toggleNotesHidden(row.key);
                    }}>notes</button
                  >
                  <button
                    class="new-wt notes-add"
                    title={wt
                      ? `Pin a sticky note to this worktree (\`${wt.branch}\`)`
                      : `Pin a sticky note to \`${repo.name ?? repo.path}\``}
                    on:click|stopPropagation={(e) => {
                      // Un-hide first so the freshly-spawned note is visible.
                      if (zenRowKey === row.key) {
                        notesShownInZen = true;
                      } else if (notesHiddenByRow[row.key]) {
                        notesHiddenByRow = {
                          ...notesHiddenByRow,
                          [row.key]: false,
                        };
                      }
                      const btn = e.currentTarget as HTMLButtonElement;
                      const anchor = wt
                        ? `worktree:${wt.path}`
                        : `repo:${repo.path}`;
                      void spawnNote({
                        anchor,
                        originRect: btn.getBoundingClientRect(),
                      });
                    }}>+</button
                  >
                  <!-- Link companion — same spawn machinery, kind: "link"
                   instead. Docked to + so the action group reads as
                   one family (count · notes · + · ⛓); the chip vs
                   paper-sticky render decision happens inside
                   StickyNote based on the note.kind discriminator.

                   Icon is inline SVG (not 🔗 emoji) so it inherits
                   the surrounding `color: var(--text-muted)` via
                   `stroke: currentColor` — same rendering hook every
                   other muted text glyph in this toolbar uses. The
                   emoji renders as a colour bitmap on every modern OS
                   and ignores `color`, which is why the previous
                   text-shadow workaround looked off-weight next to
                   the "+". -->
                  <button
                    class="new-wt notes-add notes-add-link"
                    title={wt
                      ? `Pin a link to this worktree (\`${wt.branch}\`) — URL, commit SHA, session, or file path`
                      : `Pin a link to \`${repo.name ?? repo.path}\` — URL, commit SHA, session, or file path`}
                    on:click|stopPropagation={(e) => {
                      if (zenRowKey === row.key) {
                        notesShownInZen = true;
                      } else if (notesHiddenByRow[row.key]) {
                        notesHiddenByRow = {
                          ...notesHiddenByRow,
                          [row.key]: false,
                        };
                      }
                      const btn = e.currentTarget as HTMLButtonElement;
                      const anchor = wt
                        ? `worktree:${wt.path}`
                        : `repo:${repo.path}`;
                      void spawnNote({
                        anchor,
                        originRect: btn.getBoundingClientRect(),
                        kind: "link",
                      });
                    }}
                    aria-label="Add link"
                  >
                    <svg
                      viewBox="0 0 24 24"
                      width="11"
                      height="11"
                      fill="none"
                      stroke="currentColor"
                      stroke-width="2.2"
                      stroke-linecap="round"
                      stroke-linejoin="round"
                      aria-hidden="true"
                    >
                      <path
                        d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"
                      />
                      <path
                        d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"
                      />
                    </svg>
                  </button>
                  <span
                    class="emoji-picker-anchor"
                    data-emoji-picker-anchor={row.key}
                  >
                    <button
                      class="new-wt notes-add notes-add-emoji"
                      title="Add sticker"
                      on:click|stopPropagation={() => {
                        emojiPickerOpen = {
                          ...emojiPickerOpen,
                          [row.key]: !emojiPickerOpen[row.key],
                        };
                      }}
                      aria-label="Add sticker"
                    >
                      <svg
                        viewBox="0 0 24 24"
                        width="11"
                        height="11"
                        fill="none"
                        stroke="currentColor"
                        stroke-width="2.2"
                        stroke-linecap="round"
                        stroke-linejoin="round"
                        aria-hidden="true"
                      >
                        <circle cx="12" cy="12" r="10" />
                        <circle cx="9" cy="9" r="1" />
                        <circle cx="15" cy="9" r="1" />
                        <path d="M8 14s1.5 2 4 2 4-2 4-2" />
                      </svg>
                    </button>
                    {#if emojiPickerOpen[row.key]}
                      <EmojiPicker
                        on:pick={(e) => {
                          // Keep the picker open so several stickers can be
                          // added in a row; close via cancel / click-outside.
                          if (zenRowKey === row.key) {
                            notesShownInZen = true;
                          } else if (notesHiddenByRow[row.key]) {
                            notesHiddenByRow = {
                              ...notesHiddenByRow,
                              [row.key]: false,
                            };
                          }
                          const anchor = wt
                            ? `worktree:${wt.path}`
                            : `repo:${repo.path}`;
                          const btn = document.querySelector(
                            `[data-wt-row="${CSS.escape(wt?.path ?? repo.id)}"] .notes-add-emoji`,
                          ) as HTMLElement | null;
                          const rect =
                            btn?.getBoundingClientRect() ??
                            new DOMRect(0, 0, 0, 0);
                          void spawnNote({
                            anchor,
                            originRect: rect,
                            kind: "emoji",
                            body: e.detail,
                          });
                        }}
                        on:cancel={() => {
                          emojiPickerOpen = {
                            ...emojiPickerOpen,
                            [row.key]: false,
                          };
                        }}
                      />
                    {/if}
                  </span>
                </span>
              {/if}
              {#if !rowFolded[row.key]}
                <span
                  class="wt-picker-anchor"
                  data-wt-picker-anchor={wt ? wt.path : repo.id}
                >
                  <button
                    class="new-wt"
                    title="Worktrees of this repo (switch to / remove / create new)"
                    on:click|stopPropagation={() => {
                      const key = wt ? wt.path : repo.id;
                      wtPickerOpen = {
                        ...wtPickerOpen,
                        [key]: !wtPickerOpen[key],
                      };
                    }}>worktrees ({repo.worktrees.length})</button
                  >
                  {#if wtPickerOpen[wt ? wt.path : repo.id]}
                    {@const diskPaths = repo.worktrees.map((w) => w.path)}
                    {@const visibleSet = new Set(
                      effectiveVisibleWorktrees(
                        repoPrefsKey(repo),
                        diskPaths,
                        visibleWorktreesByRepo,
                      ),
                    )}
                    <Popover variant="agents" extraClass="wt-picker-popover">
                      <svelte:fragment slot="head"
                        >Worktrees of {repo.name ??
                          repoName(repo)}</svelte:fragment
                      >
                      <ul class="agents-list">
                        {#each repo.worktrees as wOption (wOption.path)}
                          <li>
                            <div
                              class="agent-row wt-pick-row"
                              class:wt-pick-visible={visibleSet.has(
                                wOption.path,
                              )}
                              role="button"
                              tabindex="0"
                              on:click={() => {
                                toggleWorktreeVisibility(
                                  repo,
                                  wOption.path,
                                  diskPaths,
                                );
                              }}
                              on:keydown={(e) => {
                                if (e.key === "Enter" || e.key === " ") {
                                  e.preventDefault();
                                  toggleWorktreeVisibility(
                                    repo,
                                    wOption.path,
                                    diskPaths,
                                  );
                                }
                              }}
                              title={visibleSet.has(wOption.path)
                                ? `${wOption.path}\n\nVisible in the dashboard. Click to hide this row. The worktree itself stays on disk.`
                                : `${wOption.path}\n\nHidden. Click to show as a row in the dashboard.`}
                            >
                              <span class="wt-pick-tick" aria-hidden="true">
                                {visibleSet.has(wOption.path) ? "✓" : ""}
                              </span>
                              <span class="agent-row-name"
                                >{wOption.nonGit ? "—" : wOption.branch}</span
                              >
                              <span class="agent-title">{wOption.path}</span>
                              {#if !wOption.nonGit && wOption.path !== repo.path}
                                <button
                                  class="row-close wt-pick-kill"
                                  on:click|stopPropagation={() => {
                                    wtPickerOpen = {
                                      ...wtPickerOpen,
                                      [wt ? wt.path : repo.id]: false,
                                    };
                                    void removeWorktreeInRow(repo.id, {
                                      path: wOption.path,
                                      branch: wOption.branch,
                                    });
                                  }}
                                  title="Remove this worktree's directory from disk (branch ref is kept)"
                                  aria-label="Remove worktree from disk"
                                  >×</button
                                >
                              {/if}
                            </div>
                          </li>
                        {/each}
                      </ul>
                      {#if !repo.worktrees.some((w) => w.nonGit)}
                        <form
                          class="wt-pick-create-row"
                          on:submit|preventDefault={() => {
                            const branch = (newWtBranch[repo.id] ?? "").trim();
                            if (!branch) return;
                            const key = wt ? wt.path : repo.id;
                            wtPickerOpen = { ...wtPickerOpen, [key]: false };
                            void createWorktree(repo.id, wt?.path ?? null);
                          }}
                        >
                          <input
                            type="text"
                            placeholder="new branch — creates worktree on it"
                            bind:value={newWtBranch[repo.id]}
                            on:click|stopPropagation
                            class="wt-pick-create-input"
                            title={`Runs \`git worktree add ~/wt/${repoName(repo)}/<branch> -b <branch>\` — creates BOTH the new branch and a worktree directory for it.`}
                          />
                          <button
                            type="submit"
                            class="wt-pick-create-go"
                            disabled={!(newWtBranch[repo.id] ?? "").trim()}
                            title="git worktree add ~/wt/<repo>/<branch> -b <branch>"
                            >+ create</button
                          >
                        </form>
                      {/if}
                      <button
                        class="wt-pick-remove-repo"
                        on:click|stopPropagation={() => {
                          const ok = confirm(
                            `Remove repository \`${repoName(repo)}\` and all its worktree rows from supergit?\n\n` +
                              `This only untracks the repo from supergit's workspace — your repo at\n  ${repo.path}\nand any worktree directories on disk are NOT deleted.\n\n` +
                              `You can re-add it later via "+ Add" if you change your mind.`,
                          );
                          if (!ok) return;
                          wtPickerOpen = {
                            ...wtPickerOpen,
                            [wt ? wt.path : repo.id]: false,
                          };
                          void removeRepo(repo.id);
                        }}
                        title="Untrack the repo from supergit (the repo dir + worktrees on disk are kept)"
                        >Remove repository and all worktree rows from supergit</button
                      >
                    </Popover>
                  {/if}
                </span>
              {/if}
              {#if rowFolded[row.key] && wt}
                <OpenInActions
                  path={wt.path}
                  repoId={repo.id}
                  {editors}
                  remotes={repo.remotes ?? []}
                  customLinks={repo.customLinks ?? []}
                  {runningCommandIds}
                  editRequest={commandEditRequest}
                  onCommandClick={(l) => handleCommandClick(wt.path, l)}
                  {commandUrls}
                  {openIn}
                  {openRemote}
                  onAddCustomLink={(input) => addCustomLink(repo.id, input)}
                  onRemoveCustomLink={(linkId) =>
                    removeCustomLink(repo.id, linkId)}
                  onReorderCustomLinks={(orderedIds) =>
                    reorderCustomLinks(repo.id, orderedIds)}
                  onEditCustomLink={(linkId, input) =>
                    updateCustomLink(repo.id, linkId, input)}
                  daemonId={daemonIdForWorktreePath(repos, wt.path)}
                  iconOnly
                />
              {/if}
              <button
                class="row-zen-btn"
                class:open={zenRowKey === row.key}
                title={zenRowKey === row.key
                  ? "Exit zen — restore the rest of the dashboard (Esc)"
                  : `Zen — make \`${repo.name}${wt ? ` · ${wt.branch}` : ""}\` fill the viewport`}
                aria-label={zenRowKey === row.key ? "Exit zen" : "Enter zen"}
                on:click|stopPropagation={() => toggleZenRow(row.key)}
                >{zenRowKey === row.key ? "◱" : "▣"}</button
              >
              <button
                class="row-remove"
                title={wt && !wt.nonGit
                  ? "Hide this worktree's row from the dashboard. Worktree directory on disk is NOT deleted; the repo stays in supergit. Re-show via the worktrees picker."
                  : "Remove this folder from supergit's workspace. The folder on disk is NOT deleted."}
                on:click={() => {
                  if (wt && !wt.nonGit && repo.worktrees.length > 1) {
                    hideWorktreeRow(
                      repo,
                      wt.path,
                      repo.worktrees.map((w) => w.path),
                    );
                  } else {
                    void removeRepo(repo.id);
                  }
                }}>×</button
              >
            </div>

            <div class="row-body">
              {#if newWtOpen[repo.id]}
                <div class="new-wt-form">
                  <input
                    type="text"
                    class="new-wt-input"
                    placeholder="new branch name (e.g. feat/audio)"
                    bind:value={newWtBranch[repo.id]}
                    disabled={newWtBusy[repo.id]}
                    on:keydown={(e) => {
                      if (e.key === "Enter") {
                        createWorktree(repo.id, wt?.path ?? null);
                      }
                      if (e.key === "Escape") {
                        newWtOpen = { ...newWtOpen, [repo.id]: false };
                      }
                    }}
                  />
                  <button
                    class="tiny"
                    disabled={!newWtBranch[repo.id]?.trim() ||
                      newWtBusy[repo.id]}
                    on:click={() => createWorktree(repo.id, wt?.path ?? null)}
                  >
                    {newWtBusy[repo.id] ? "Creating…" : "Create"}
                  </button>
                  <span class="muted small">
                    will live at ~/wt/{repo.name}/{(newWtBranch[repo.id] ?? "")
                      .trim()
                      .replace(/[\/\\]/g, "-") || "…"}
                  </span>
                </div>
              {/if}

              {#if wt && summary}
                <div class="row-status">
                  {#if isFirstOfRepo && !newlyAddedRepoPaths.has(wt?.path ?? "") && !newlyAddedRepoPaths.has(repo.path)}
                    <RepoRecentSummary
                      repoId={repo.id}
                      repoName={repo.name}
                      daemonId={repo.daemonId}
                      inline
                    />
                  {/if}

                  <OpenInActions
                    path={wt.path}
                    repoId={repo.id}
                    {editors}
                    remotes={repo.remotes ?? []}
                    customLinks={repo.customLinks ?? []}
                    {runningCommandIds}
                    editRequest={commandEditRequest}
                    onCommandClick={(l) => handleCommandClick(wt.path, l)}
                    {commandUrls}
                    {openIn}
                    {openRemote}
                    onAddCustomLink={(input) => addCustomLink(repo.id, input)}
                    onRemoveCustomLink={(linkId) =>
                      removeCustomLink(repo.id, linkId)}
                    onReorderCustomLinks={(orderedIds) =>
                      reorderCustomLinks(repo.id, orderedIds)}
                    onEditCustomLink={(linkId, input) =>
                      updateCustomLink(repo.id, linkId, input)}
                    daemonId={daemonIdForWorktreePath(repos, wt.path)}
                  />
                </div>
              {/if}

              {#if wt && (newlyAddedRepoPaths.has(wt.path) || newlyAddedRepoPaths.has(repo.path) || onboardingByWt[wt.path] || walkthroughByWt[wt.path] != null)}
                {@const ob = onboardingByWt[wt.path]}
                <div class="onboarding-section">
                  {#if ob && (ob.status === "streaming" || ob.status === "done")}
                    <div class="onboarding-response">
                      <span class="onboarding-provider-badge">
                        {#if ob.provider === "ollama"}
                          <img
                            src="/agents/ollama.svg"
                            alt=""
                            class="onboarding-provider-icon"
                          />
                        {:else if ob.provider === "claude"}
                          <img
                            src="/agents/claude.svg"
                            alt=""
                            class="onboarding-provider-icon"
                          />
                        {/if}
                        <span class="muted small"
                          >{ob.model ?? ob.provider}</span
                        >
                        {#if ob.status === "streaming"}
                          <LoadingSpinner size="0.7rem" />
                        {/if}
                      </span>
                      <div class="onboarding-text">
                        {@html DOMPurify.sanitize(
                          marked.parse(ob.text || "", {
                            async: false,
                            breaks: true,
                            gfm: true,
                          }) as string,
                        )}
                      </div>
                    </div>
                    {#if ob.status === "done" && walkthroughByWt[wt.path] == null && !walkthroughSeen(wt.path)}
                      <div class="onboarding-tour-buttons">
                        <button
                          class="onboarding-btn"
                          on:click={() => {
                            walkthroughByWt = { [wt.path]: 0 };
                          }}>Tour the UI</button
                        >
                        <button
                          class="walkthrough-btn-skip"
                          on:click={() => {
                            markWalkthroughSeen(wt.path);
                            delete onboardingByWt[wt.path];
                            onboardingByWt = onboardingByWt;
                          }}>Skip onboarding</button
                        >
                      </div>
                    {/if}
                  {:else if ob && ob.status === "error"}
                    <div class="onboarding-error muted small">{ob.error}</div>
                    <button
                      class="onboarding-btn"
                      on:click={() => startOnboarding(wt.path)}>Retry</button
                    >
                  {:else if walkthroughByWt[wt.path] == null}
                    <div class="onboarding-cta-row">
                      <button
                        class="onboarding-btn"
                        on:click={() => {
                          walkthroughByWt = { [wt.path]: 0 };
                        }}>Tour the UI</button
                      >
                      <button
                        class="walkthrough-btn-skip"
                        on:click={() => {
                          newlyAddedRepoPaths.delete(wt.path);
                          newlyAddedRepoPaths.delete(repo.path);
                          markWalkthroughSeen(wt.path);
                          delete onboardingByWt[wt.path];
                          onboardingByWt = onboardingByWt;
                        }}>Skip</button
                      >
                    </div>
                  {/if}
                  {#if walkthroughByWt[wt.path] != null}
                    <OnboardingWalkthrough
                      wtPath={wt.path}
                      currentStep={walkthroughByWt[wt.path] ?? 0}
                      on:next={() => {
                        const s = (walkthroughByWt[wt.path] ?? 0) + 1;
                        if (s >= WALKTHROUGH_STEPS.length) {
                          markWalkthroughSeen(wt.path);
                          walkthroughByWt = {
                            ...walkthroughByWt,
                            [wt.path]: null,
                          };
                          delete onboardingByWt[wt.path];
                          onboardingByWt = onboardingByWt;
                        } else {
                          walkthroughByWt = {
                            ...walkthroughByWt,
                            [wt.path]: s,
                          };
                        }
                      }}
                      on:skip={() => {
                        markWalkthroughSeen(wt.path);
                        walkthroughByWt = {
                          ...walkthroughByWt,
                          [wt.path]: null,
                        };
                        delete onboardingByWt[wt.path];
                        onboardingByWt = onboardingByWt;
                      }}
                    />
                  {/if}
                </div>
              {/if}

              {#if wt && summary}
                {#if wt}
                  {@const stripFilter = stripFilterByWt[wt.path]}
                  {@const existingSources = new Set(
                    (wt.agents ?? []).flatMap((a) => sessionSurfaceKeys(a)),
                  )}
                  {@const visibleSessions = filterToExistingSessions(
                    openSessionsByWt[wt.path] ?? [],
                    existingSources,
                  )}
                  <!-- The strip always renders for an open worktree so each
                   project shows its task queue (QueueColumn, first child)
                   at terminal height, even with no live sessions. -->
                  <div
                    class="sessions-strip"
                    data-wt-strip={wt.path}
                    on:dragleave={(e) => handleStripDragLeave(e, wt.path)}
                  >
                    <QueueColumn
                      worktreePath={wt.path}
                      daemonId={daemonIdForWorktreePath(repos, wt.path)}
                      onStart={startTask}
                    />
                        <!-- Trailing spacer (the leading inset is handled by
                         `.sessions-strip { padding-left }`). Can't use
                         padding-right here — horizontally scrolling flex
                         containers drop it — so a real flex item gives
                         the last column the same breathing room. -->
                        {#each visibleSessions as s, i (openSessionRenderKey(s))}
                          <div
                            class="session-col"
                            class:session-col-filtered={stripFilter &&
                              !stripFilter.matched.has(s.source)}
                            class:session-col-pickable={!!stripFilter &&
                              stripFilter.matched.has(s.source)}
                            class:drop-before={dragOverTarget?.wtPath ===
                              wt.path &&
                              dragOverTarget.index === i &&
                              dragOverTarget.side === "left" &&
                              dragSource?.index !== i}
                            class:drop-after={dragOverTarget?.wtPath ===
                              wt.path &&
                              dragOverTarget.index === i &&
                              dragOverTarget.side === "right" &&
                              dragSource?.index !== i}
                            data-session-source={s.source}
                            use:colVisibility
                            animate:flip={{ duration: 220 }}
                            on:dragover={(e) =>
                              handleSessionDragOver(e, wt.path, i)}
                            on:drop={(e) => handleSessionDrop(e, wt.path, i)}
                            on:dragend={handleSessionDragEnd}
                            on:click={() => {
                              commitStripSearch(row.key, wt.path, s.source);
                              // Bubbles from any click inside the column — a
                              // child handler that closes the session will
                              // have run first, so guard against parking
                              // `focusedSource` on a session that's already
                              // been removed.
                              if (isSessionOpenInWt(wt.path, s)) {
                                focusOpenSessionColumn(s.source);
                              }
                            }}
                            out:closeColumn
                          >
                            {#if s.source.startsWith("__restore__:")}
                              {@const rInfo = persistedTerminals[s.source]}
                              <div class="session restore-card">
                                <div class="restore-header">
                                  <span class="restore-title"
                                    >{rInfo?.title || "Terminal"}</span
                                  >
                                  <span class="restore-status"
                                    >disconnected</span
                                  >
                                </div>
                                <code class="restore-cmd"
                                  >{rInfo?.firstCmd ||
                                    rInfo?.lastCmd ||
                                    rInfo?.cmd?.join(" ") ||
                                    ""}</code
                                >
                                <div class="restore-actions">
                                  <button
                                    class="restore-btn restore-resume"
                                    on:click={() =>
                                      resumePersistedTerminal(
                                        wt.path,
                                        s.source,
                                      )}>Resume</button
                                  >
                                  <button
                                    class="restore-btn"
                                    on:click={() =>
                                      dismissPersistedTerminal(
                                        wt.path,
                                        s.source,
                                      )}>Dismiss</button
                                  >
                                </div>
                              </div>
                            {:else if s.source.startsWith("__remote__:")}
                              {@const remoteTermId =
                                parseRemoteSource(s.source) ?? ""}
                              {@const termSource = `__attached__:shell:${remoteTermId}`}
                              <FileBrowser
                                wtPath="/"
                                source={s.source}
                                {remoteTermId}
                                remoteCwd={sshCwdByTermId[remoteTermId] ?? null}
                                onClose={() => closeSessionInWt(wt.path, s)}
                                onFocusTerminal={() => {
                                  focusedSource = termSource;
                                  const el = document.querySelector(
                                    `[data-session-source="${termSource}"]`,
                                  );
                                  el?.scrollIntoView({
                                    behavior: "smooth",
                                    inline: "center",
                                    block: "nearest",
                                  });
                                }}
                                onDragStart={(e) =>
                                  handleSessionDragStart(e, wt.path, i)}
                              />
                            {:else if s.source.startsWith("__files__:")}
                              <FileBrowser
                                wtPath={wt.path}
                                source={s.source}
                                daemonId={daemonIdForWorktreePath(
                                  repos,
                                  wt.path,
                                )}
                                onClose={() => closeSessionInWt(wt.path, s)}
                                onToast={(m) =>
                                  addToast({ kind: "warning", message: m })}
                                onDragStart={(e) =>
                                  handleSessionDragStart(e, wt.path, i)}
                              />
                            {:else if s.source.startsWith("__history__:")}
                              <GitHistory
                                wtPath={wt.path}
                                source={s.source}
                                onClose={() => closeSessionInWt(wt.path, s)}
                                onDragStart={(e) =>
                                  handleSessionDragStart(e, wt.path, i)}
                                fsChangeKey={fsChangeKey[wt.path] ?? 0}
                                daemonId={daemonIdForWorktreePath(
                                  repos,
                                  wt.path,
                                )}
                              />
                            {:else if s.source.startsWith("__transcript__:ollama:")}
                              <!-- Read-mode column for a stopped (or live)
                               Ollama session. OllamaTranscriptView is a
                               thin wrapper around SessionView so the
                               read view looks identical to Claude /
                               Codex; the wrapper only adds Ollama-
                               specific Resume actions. Needs the
                               on-disk JSONL path so SessionView's
                               /api/session fetch can parse it. -->
                              {@const ollamaTermId = s.source.slice(
                                "__transcript__:ollama:".length,
                              )}
                              {@const ollamaMeta = (wt.agents ?? []).find(
                                (a) =>
                                  a.agent === "ollama" &&
                                  a.sessionId === ollamaTermId,
                              )}
                              {@const ollamaModelLabel =
                                s.ollamaModel ??
                                ollamaMeta?.model ??
                                ollamaMeta?.title ??
                                "ollama"}
                              {@const ollamaSourcePath =
                                ollamaMeta?.source ??
                                ollamaSourcePathOverride[s.source]}
                              {#if ollamaSourcePath}
                                <OllamaTranscriptView
                                  termId={ollamaTermId}
                                  wt={wt.path}
                                  model={ollamaModelLabel}
                                  sourcePath={ollamaSourcePath}
                                  starred={starredSessions.has(
                                    ollamaSourcePath,
                                  )}
                                  onToggleStar={() =>
                                    toggleStarSession(ollamaSourcePath)}
                                  onContinueWith={(targetAgent, ollamaModel) =>
                                    void continueSessionWith(
                                      wt.path,
                                      ollamaSourcePath,
                                      targetAgent,
                                      ollamaModel,
                                    )}
                                  on:close={() => closeSessionInWt(wt.path, s)}
                                />
                              {:else}
                                <!-- No matching AgentSession yet (still
                                 mid-spawn or /api/repos hasn't
                                 rescanned). Show a brief placeholder
                                 instead of an empty frame. -->
                                <div
                                  class="session muted small"
                                  style="padding: 0.75rem 1rem;"
                                >
                                  starting…
                                </div>
                              {/if}
                            {:else if s.source.startsWith("__transcript__:")}
                              <!-- Read-mode column for a past shell session.
                               Renders the captured commands from the
                               JSONL and exposes a Resume button that
                               spawns a new PTY at the last cwd. -->
                              <div class="session shell-transcript-col">
                                <ShellView
                                  termId={s.source.split(":").pop() ?? ""}
                                  wt={wt.path}
                                  onResume={(lastCwd) =>
                                    resumePastShell(wt.path, s.source, lastCwd)}
                                  onClose={() => closeSessionInWt(wt.path, s)}
                                />
                              </div>
                            {:else if s.source.startsWith("__new__:") || s.source.startsWith("__attached__:")}
                              <!-- Transient column: a brand-new agent we just
                               spawned, before its JSONL has been created on
                               disk. NewSessionCol.svelte handles the shell
                               + claude/codex variants; we just feed it
                               props and react to its events. -->
                              {@const newAgentMeta = s.resumeSessionId
                                ? (wt.agents ?? []).find(
                                    (a) =>
                                      a.agent === s.agent &&
                                      a.sessionId === s.resumeSessionId,
                                  )
                                : undefined}
                              {@const titleSource = resolveTitleSource(
                                s,
                                wt.agents ?? [],
                              )}
                              <!-- {#key} on a per-source generation counter so a
                               model/effort switch (setClaudeSessionFlag) tears
                               down the TerminalView and respawns it via resume
                               with the new --model/--effort flag. -->
                              {#key claudeColGen[s.source] ?? 0}
                                <NewSessionCol
                                  agent={s.agent}
                                  source={titleSource}
                                  wtPath={wt.path}
                                  daemonId={daemonIdForWorktreePath(
                                    repos,
                                    wt.path,
                                  )}
                                  cmd={cmdForOpenSession(
                                    s,
                                    shellByDaemon[
                                      daemonIdForWorktreePath(repos, wt.path) ??
                                        "local"
                                    ] ?? defaultShell,
                                    shellArgsByDaemon[
                                      daemonIdForWorktreePath(repos, wt.path) ??
                                        "local"
                                    ] ?? defaultShellArgs,
                                  )}
                                  cwd={shellResumeCwd[s.source] ?? wt.path}
                                  procName={`supergit-tui-new-${s.agent}`}
                                  attachTermId={s.source.startsWith(
                                    "__attached__:",
                                  )
                                    ? s.source.split(":").pop()
                                    : undefined}
                                  resumeFromTermId={shellResumeFromTermId[
                                    s.source
                                  ]}
                                  prefillCmd={shellPrefillCmd[s.source]}
                                  manualTitle={newAgentMeta?.manualTitle ??
                                    newSessionTitles[titleSource] ??
                                    newSessionTitles[s.source]}
                                  aiTitle={newAgentMeta?.aiTitle}
                                  awaiting={!!transientAwaiting[s.source]}
                                  working={!!transientWorking[s.source]}
                                  totalMessageCount={newAgentMeta?.messageCount}
                                  contextTokens={newAgentMeta?.contextTokens}
                                  contextTokensExact={newAgentMeta?.contextTokensExact}
                                  contextWindow={newAgentMeta?.contextWindow}
                                  model={newAgentMeta?.model}
                                  claudeModel={s.claudeModel}
                                  claudeEffort={s.claudeEffort}
                                  lastActivityIso={newAgentMeta?.lastActive}
                                  lastUserMessage={newAgentMeta?.lastUserMessage}
                                  starred={starredSessions.has(titleSource) ||
                                    starredSessions.has(s.source)}
                                  onToggleStar={() =>
                                    toggleStarSession(titleSource)}
                                  on:close={() => closeSessionInWt(wt.path, s)}
                                  on:dispose={() =>
                                    disposeNewSessionColumn(
                                      wt.path,
                                      s,
                                      wt.agents ?? [],
                                    )}
                                  on:restart={() =>
                                    restartNewAgentSession(wt.path, s)}
                                  on:setModel={(e) =>
                                    setClaudeSessionFlag(wt.path, s.source, {
                                      claudeModel: e.detail.model,
                                    })}
                                  on:setEffort={(e) =>
                                    setClaudeSessionFlag(wt.path, s.source, {
                                      claudeEffort: e.detail.effort,
                                    })}
                                  on:spawn={(e) => {
                                    markTerminalLive(e.detail.id);
                                    // Capture the daemon-assigned termId for
                                    // every `__new__:` source (any agent) so
                                    // disposeNewSessionColumn can DELETE
                                    // /api/terminals/:id later.
                                    if (s.source.startsWith("__new__:")) {
                                      newTermIds = {
                                        ...newTermIds,
                                        [s.source]: e.detail.id,
                                      };
                                      markTransientDiscovery(s.source);
                                    }
                                    // Claude with a preassignedSessionId: by
                                    // this point claude has been exec'd with
                                    // `--session-id <uuid>` and has created
                                    // the JSONL. Promote the preassigned id to
                                    // resumeSessionId so a reload spawns
                                    // `claude --resume <uuid>` instead of
                                    // re-passing `--session-id` (which now
                                    // errors with "Session ID is already in
                                    // use"). The activity-tail stamping does
                                    // the same thing eventually, but it's
                                    // racy — the user can reload faster than
                                    // the SSE event arrives.
                                    if (
                                      s.source.startsWith("__new__:claude:") &&
                                      s.preassignedSessionId &&
                                      !s.resumeSessionId
                                    ) {
                                      const sid = s.preassignedSessionId;
                                      openSessionsByWt = {
                                        ...openSessionsByWt,
                                        [wt.path]: (
                                          openSessionsByWt[wt.path] ?? []
                                        ).map((x) =>
                                          x.source === s.source
                                            ? { ...x, resumeSessionId: sid }
                                            : x,
                                        ),
                                      };
                                    }
                                    // SHELLS only: also swap the persisted
                                    // source from `__new__:shell:<random>` to
                                    // `__attached__:shell:<termId>`. This is
                                    // the canonical "reattach to existing PTY"
                                    // form. Without the swap, a reload spawns a
                                    // fresh PTY (via the lingering __new__:
                                    // entry) *and* restoreLiveShells adds the
                                    // still-alive old PTY as a separate
                                    // __attached__:shell:<oldTermId> — the
                                    // "regular terminal duplicates after
                                    // reload" bug. The each-block remounts
                                    // briefly (key change), but TerminalView's
                                    // attach path reconnects via WS to the
                                    // same termId without killing the PTY
                                    // (daemon supports multiple subscribers).
                                    // Claude/Codex don't get this swap: they
                                    // use the activity-tail's resumeSessionId
                                    // mechanism for reload continuity.
                                    if (s.source.startsWith("__new__:shell:")) {
                                      const attachedSource = `__attached__:shell:${e.detail.id}`;
                                      promotedSources.add(s.source);
                                      openSessionsByWt = {
                                        ...openSessionsByWt,
                                        [wt.path]: (
                                          openSessionsByWt[wt.path] ?? []
                                        ).map((x) =>
                                          x.source === s.source
                                            ? {
                                                ...x,
                                                source: attachedSource,
                                                renderKey:
                                                  x.renderKey ?? x.source,
                                              }
                                            : x,
                                        ),
                                      };
                                      // If the user already named this column during
                                      // the brief "starting" phase before the PTY
                                      // came up, migrate the title to the new source
                                      // key so it survives the swap (otherwise the
                                      // synthetic-source title gets orphaned and the
                                      // header reverts to "Name this session…").
                                      transientWorking = moveSessionStateKey(
                                        transientWorking,
                                        s.source,
                                        attachedSource,
                                      );
                                      transientAwaiting = moveSessionStateKey(
                                        transientAwaiting,
                                        s.source,
                                        attachedSource,
                                      );
                                      transientExited = moveSessionStateKey(
                                        transientExited,
                                        s.source,
                                        attachedSource,
                                      );
                                      transientFinishedAt = moveSessionStateKey(
                                        transientFinishedAt,
                                        s.source,
                                        attachedSource,
                                      );
                                      workingStartedAt = moveSessionStateKey(
                                        workingStartedAt,
                                        s.source,
                                        attachedSource,
                                      );
                                      clearTransientDiscovery(s.source);
                                      void migrateSessionTitleOnServer(
                                        s.source,
                                        attachedSource,
                                      );
                                    }
                                  }}
                                  on:awaitingChange={(e) => {
                                    transientAwaiting = {
                                      ...transientAwaiting,
                                      [s.source]: e.detail.awaiting,
                                    };
                                  }}
                                  on:workingChange={(e) => {
                                    const wasWorking =
                                      !!transientWorking[s.source];
                                    const nowWorking = e.detail.working;
                                    transientWorking = {
                                      ...transientWorking,
                                      [s.source]: nowWorking,
                                    };
                                    if (wasWorking && !nowWorking) {
                                      const start = workingStartedAt[s.source];
                                      const worked = start
                                        ? Date.now() - start
                                        : 0;
                                      if (worked >= MIN_WORKING_FOR_PULSE_MS) {
                                        scheduleFinished(s.source);
                                      }
                                      workingStartedAt[s.source] = undefined;
                                    } else if (nowWorking && !wasWorking) {
                                      workingStartedAt[s.source] = Date.now();
                                      clearFinishedFor(s.source);
                                    }
                                  }}
                                  on:exit={() => {
                                    markTerminalExited(
                                      resolveTermId(s, newTermIds) ??
                                        s.attachTermId,
                                    );
                                    transientExited = {
                                      ...transientExited,
                                      [s.source]: true,
                                    };
                                    if (transientWorking[s.source]) {
                                      transientWorking = {
                                        ...transientWorking,
                                        [s.source]: false,
                                      };
                                    }
                                    workingStartedAt[s.source] = undefined;
                                    clearFinishedFor(s.source);
                                    if (transientAwaiting[s.source]) {
                                      transientAwaiting = {
                                        ...transientAwaiting,
                                        [s.source]: false,
                                      };
                                    }
                                  }}
                                  on:sshBrowse={() => {
                                    const termId = resolveTermIdFromSource(
                                      s.source,
                                      newTermIds,
                                    );
                                    if (termId)
                                      openRemoteBrowser(wt.path, termId, "");
                                  }}
                                  on:sshCwd={(e) => {
                                    const termId = resolveTermIdFromSource(
                                      s.source,
                                      newTermIds,
                                    );
                                    if (termId)
                                      sshCwdByTermId = {
                                        ...sshCwdByTermId,
                                        [termId]: e.detail.cwd,
                                      };
                                  }}
                                  on:titleSave={(e) =>
                                    void saveNewSessionTitle(
                                      titleSource,
                                      e.detail.title,
                                    )}
                                  on:titleEditingChange={(e) => {
                                    if (e.detail.editing) {
                                      editingTitleSources.add(s.source);
                                    } else {
                                      editingTitleSources.delete(s.source);
                                      flushDeferredPromotions(s.source);
                                    }
                                  }}
                                  onDragStart={(e) =>
                                    handleSessionDragStart(e, wt.path, i)}
                                />
                              {/key}
                            {:else}
                              {@const agentMeta = s.resumeSessionId
                                ? (wt.agents ?? []).find(
                                    (a) =>
                                      a.agent === s.agent &&
                                      a.sessionId === s.resumeSessionId,
                                  )
                                : (wt.agents ?? []).find(
                                    (a) => a.source === s.source,
                                  )}
                              {@const effectiveSessionForView = {
                                ...s,
                                resumeSessionId:
                                  s.resumeSessionId ?? agentMeta?.sessionId,
                                transcriptSource:
                                  s.transcriptSource ?? agentMeta?.source,
                              }}
                              {@const titleSource = resolveTitleSource(
                                effectiveSessionForView,
                                wt.agents ?? [],
                              )}
                              {#key claudeColGen[s.source] ?? 0}
                                <SessionView
                                  agent={s.agent as
                                    | "claude"
                                    | "codex"
                                    | "copilot"}
                                  source={s.source}
                                  focusComposerSeq={composerFocusSeqBySource[
                                    s.source
                                  ] ?? 0}
                                  resumeSessionId={s.resumeSessionId ??
                                    agentMeta?.sessionId}
                                  transcriptSource={s.transcriptSource}
                                  visualAppEnabled={isExplicitVisualSurface({
                                    ...s,
                                    resumeSessionId:
                                      s.resumeSessionId ?? agentMeta?.sessionId,
                                    transcriptSource:
                                      s.transcriptSource ?? agentMeta?.source,
                                  })}
                                  wtPath={wt.path}
                                  daemonId={daemonIdForWorktreePath(
                                    repos,
                                    wt.path,
                                  )}
                                  totalMessageCount={agentMeta?.messageCount}
                                  contextTokens={agentMeta?.contextTokens}
                                  contextTokensExact={agentMeta?.contextTokensExact}
                                  contextWindow={agentMeta?.contextWindow}
                                  model={agentMeta?.model}
                                  claudeModel={s.claudeModel}
                                  claudeEffort={s.claudeEffort}
                                  onSetClaudeModel={(m) =>
                                    setClaudeSessionFlag(wt.path, s.source, {
                                      claudeModel: m,
                                    })}
                                  onSetClaudeEffort={(e) =>
                                    setClaudeSessionFlag(wt.path, s.source, {
                                      claudeEffort: e,
                                    })}
                                  attachTermId={s.attachTermId}
                                  manualTitleOverride={agentMeta?.manualTitle ??
                                    newSessionTitles[titleSource] ??
                                    newSessionTitles[s.source]}
                                  onSpawn={(id) => {
                                    markTerminalLive(id);
                                    // Keep this session's attachTermId on the
                                    // live PTY so a remount (model/effort
                                    // switch) or reopen reattaches to the
                                    // running TUI instead of a stale id —
                                    // which would 404 and force a respawn.
                                    const next = setSessionAttachTermId(
                                      openSessionsByWt,
                                      wt.path,
                                      s.source,
                                      id,
                                    );
                                    if (next !== openSessionsByWt)
                                      openSessionsByWt = next;
                                  }}
                                  initialMode={s.mode === "terminal"
                                    ? "terminal"
                                    : "read"}
                                  initialTranscriptSurface={transcriptSurfaceForSession(
                                    {
                                      ...s,
                                      resumeSessionId:
                                        s.resumeSessionId ??
                                        agentMeta?.sessionId,
                                      transcriptSource:
                                        s.transcriptSource ?? agentMeta?.source,
                                    },
                                  )}
                                  onTranscriptSurfaceChange={(surface) => {
                                    rememberSessionSurface(
                                      {
                                        ...s,
                                        resumeSessionId:
                                          s.resumeSessionId ??
                                          agentMeta?.sessionId,
                                        transcriptSource:
                                          s.transcriptSource ??
                                          agentMeta?.source,
                                      },
                                      surface,
                                    );
                                  }}
                                  onVisualResume={() => {
                                    resumeCodexVisualSession(
                                      wt.path,
                                      s,
                                      s.resumeSessionId ?? agentMeta?.sessionId,
                                      s.transcriptSource ?? agentMeta?.source,
                                    );
                                  }}
                                  onStopVisualApp={(s.transcriptSource ??
                                  agentMeta?.source)
                                    ? () =>
                                        stopCodexVisualSession(
                                          wt.path,
                                          s,
                                          s.transcriptSource ??
                                            agentMeta?.source,
                                        )
                                    : undefined}
                                  onModeChange={(m) => {
                                    if (m === "terminal") {
                                      rememberSessionSurface(
                                        {
                                          ...s,
                                          resumeSessionId:
                                            s.resumeSessionId ??
                                            agentMeta?.sessionId,
                                          transcriptSource:
                                            s.transcriptSource ??
                                            agentMeta?.source,
                                        },
                                        "terminal",
                                      );
                                    }
                                    // Persist so a reload restores the same view —
                                    // otherwise a user who clicked "Resume in
                                    // terminal" before refreshing lands back in
                                    // history view.
                                    const next = setSessionMode(
                                      openSessionsByWt,
                                      wt.path,
                                      s.source,
                                      m,
                                    );
                                    if (next !== openSessionsByWt)
                                      openSessionsByWt = next;
                                  }}
                                  onWorkingChange={(w) => {
                                    const wasWorking =
                                      !!transientWorking[s.source];
                                    transientWorking = {
                                      ...transientWorking,
                                      [s.source]: w,
                                    };
                                    if (wasWorking && !w) {
                                      const start = workingStartedAt[s.source];
                                      const worked = start
                                        ? Date.now() - start
                                        : 0;
                                      if (worked >= MIN_WORKING_FOR_PULSE_MS) {
                                        scheduleFinished(s.source);
                                      }
                                      workingStartedAt[s.source] = undefined;
                                    } else if (w && !wasWorking) {
                                      workingStartedAt[s.source] = Date.now();
                                      markTransientDiscovery(s.source);
                                      clearFinishedFor(s.source);
                                    }
                                  }}
                                  onAwaitingChange={(a) => {
                                    transientAwaiting = {
                                      ...transientAwaiting,
                                      [s.source]: a,
                                    };
                                  }}
                                  starred={starredSessions.has(s.source)}
                                  onToggleStar={() =>
                                    toggleStarSession(s.source)}
                                  onContinueWith={(targetAgent, ollamaModel) =>
                                    void continueSessionWith(
                                      wt.path,
                                      s.transcriptSource ?? s.source,
                                      targetAgent,
                                      ollamaModel,
                                    )}
                                  onClose={() => closeSessionInWt(wt.path, s)}
                                  onDragStart={(e) =>
                                    handleSessionDragStart(e, wt.path, i)}
                                  onTitleChange={() => void load()}
                                />
                              {/key}
                            {/if}
                          </div>
                        {/each}
                        {#if stripFilter && stripFilter.notOpen.length > 0}
                          <!-- Synthetic column: matches that exist for this
                           worktree but aren't currently mounted in the
                           strip. Click a row → reveal it as a real
                           column (the row vanishes from this list
                           because the matched-but-open partition flips).
                           Lives inside the same flex strip so it scrolls
                           with everything else. -->
                          <div class="session-col session-col-extra">
                            <div class="session-col-extra-head">
                              {stripFilter.notOpen.length} match{stripFilter
                                .notOpen.length === 1
                                ? ""
                                : "es"} not in strip
                            </div>
                            <ul class="session-col-extra-list">
                              {#each stripFilter.notOpen as extra (extra.source)}
                                <li>
                                  <button
                                    class="session-col-extra-row brand-{extra.agent}"
                                    title={sessionTooltip(extra)}
                                    on:click={() => {
                                      pinRowOpenAfterPick(row.key);
                                      // Picking from the synthetic list is a
                                      // definitive selection — exit filter
                                      // mode in the same gesture so the strip
                                      // returns to its full view with the
                                      // just-revealed column centered. Without
                                      // this the user has to click the search
                                      // ×/Esc to leave the filtered state.
                                      stripSearchOpen = {
                                        ...stripSearchOpen,
                                        [wt.path]: false,
                                      };
                                      stripSearchQuery = {
                                        ...stripSearchQuery,
                                        [wt.path]: "",
                                      };
                                      // Use `revealSession` (mode "reveal") so
                                      // the just-mounted column gets the
                                      // outline-flash cue — same affordance the
                                      // header-bar "most recent session" badge
                                      // uses. `revealOrToggleSession` would
                                      // skip the flash on an already-expanded
                                      // row, which is wrong here: the column
                                      // is new on screen and the user needs to
                                      // find it.
                                      revealSession(row.key, wt.path, {
                                        agent: extra.agent,
                                        source: extra.source,
                                        resumeSessionId: extra.sessionId,
                                      });
                                    }}
                                  >
                                    {#if extra.agent === "claude"}
                                      <img
                                        class="agent-row-icon"
                                        src="/agents/claude.svg"
                                        alt=""
                                      />
                                    {:else}
                                      <span
                                        class="agent-dot agent-{extra.agent}"
                                      ></span>
                                    {/if}
                                    <span class="session-col-extra-title">
                                      {extra.manualTitle ??
                                        extra.aiTitle ??
                                        extra.title ??
                                        "(no title)"}
                                    </span>
                                    <span class="session-col-extra-meta"
                                      >{relTime(extra.lastActive)}</span
                                    >
                                  </button>
                                </li>
                              {/each}
                            </ul>
                          </div>
                        {/if}
                        <span class="sessions-strip-pad" aria-hidden="true"
                        ></span>
                  </div>

                  <!-- Source-control foldout removed — git history now lives
                   in a session column (GitHistory.svelte). -->
                {/if}
              {/if}
            </div>
          </div>
        </li>
      {/each}
    </ul>
    <div class="add-folder-footer">
      <div class="add-folder-actions">
        <button
          class="add-folder-cta add-folder-cta-compact"
          on:click={pickAndAdd}
          disabled={addFolderBusy}
          title="Pick a folder to register as a repo"
        >
          {#if addFolderBusy}
            <LoadingSpinner size="0.8rem" />
            <span>Adding…</span>
          {:else}
            <svg
              class="add-folder-icon"
              width="18"
              height="18"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="1.8"
              stroke-linecap="round"
              stroke-linejoin="round"
              aria-hidden="true"
            >
              <path
                d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"
              />
              <path d="M12 11v6" />
              <path d="M9 14h6" />
            </svg>
            <span>Add folder</span>
          {/if}
        </button>
        <div class="import-sessions-anchor" class:flip-up={importFlipUp}>
          <button
            class="add-folder-cta add-folder-cta-compact"
            on:click|stopPropagation={toggleImportSessions}
            aria-haspopup="menu"
            aria-expanded={importSessionsOpen}
            title="Suggest folders to add based on detected AI agent sessions"
          >
            <svg
              class="add-folder-icon"
              width="18"
              height="18"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="1.8"
              stroke-linecap="round"
              stroke-linejoin="round"
              aria-hidden="true"
            >
              <path d="M12 3v12" />
              <path d="M7 10l5 5 5-5" />
              <path d="M5 21h14" />
            </svg>
            <span>Import from sessions</span>
          </button>
          {#if importSessionsOpen && importMenuSource === "inline"}
            <Popover variant="actions" extraClass="import-sessions-popover">
              <svelte:fragment slot="head">
                <div class="import-search-head">
                  <input
                    type="search"
                    class="import-search-input"
                    bind:value={importQuery}
                    placeholder="Folders from detected sessions"
                    aria-label="Filter folders from detected sessions"
                    use:focusOnMount
                    on:click|stopPropagation
                    on:keydown|stopPropagation
                  />
                  {#if importQuery.trim()}
                    <span class="import-search-count"
                      >{importFiltered.length}/{importSuggestions.length}</span
                    >
                  {/if}
                </div>
              </svelte:fragment>
              {#if importLoading}
                <div class="import-empty">
                  <LoadingSpinner size="0.85rem" label="Scanning sessions" />
                  <span>scanning sessions…</span>
                </div>
              {:else if importError}
                <div class="import-empty import-error">{importError}</div>
              {:else if importFiltered.length === 0}
                <div class="import-empty muted">
                  {#if importQuery.trim()}
                    No folders match.
                  {:else}
                    No new folders to suggest — every detected session's cwd is
                    already in the dashboard.
                  {/if}
                </div>
              {:else}
                <ul class="import-list">
                  {#each importFiltered as sug (sug.path)}
                    {@const busy = importAdding.has(sug.path)}
                    <li>
                      <button
                        type="button"
                        class="import-row"
                        class:busy
                        disabled={busy}
                        on:click={() => addRepoFromSuggestion(sug.path)}
                        title={`Add ${sug.path} to the dashboard`}
                      >
                        <span class="import-row-main">
                          {#if busy}
                            <span class="import-row-name"
                              ><LoadingSpinner size="0.75rem" /> Importing…</span
                            >
                          {:else}
                            <span class="import-row-name">{sug.name}</span>
                          {/if}
                          <span class="import-row-path muted small"
                            >{sug.path}</span
                          >
                          {#if sug.repoUrl}
                            <span class="import-row-url muted small"
                              >{sug.repoUrl}</span
                            >
                          {/if}
                        </span>
                        <span class="import-row-meta">
                          <span class="import-row-count">
                            <span
                              class="import-row-agents-icons"
                              aria-hidden="true"
                            >
                              {#each sug.agents as agent (agent)}
                                <AgentIcon {agent} size={14} />
                              {/each}
                            </span>
                            <span>
                              {sug.sessionCount} session{sug.sessionCount === 1
                                ? ""
                                : "s"}
                            </span>
                          </span>
                          <span class="import-row-time muted small">
                            {formatRelativeTime(sug.lastActive)}
                          </span>
                          <span class="import-row-agents-names muted small">
                            {sug.agents.join(", ")}
                          </span>
                        </span>
                      </button>
                    </li>
                  {/each}
                </ul>
              {/if}
            </Popover>
          {/if}
        </div>
        <button
          class="add-folder-cta add-folder-cta-compact"
          on:click={() => {
            provisionAttachJob = null;
            addDaemonOpen = true;
          }}
        >
          <svg
            class="add-folder-icon"
            width="20"
            height="20"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
            aria-hidden="true"
            ><rect x="2" y="3" width="20" height="14" rx="2" /><line
              x1="8"
              y1="21"
              x2="16"
              y2="21"
            /><line x1="12" y1="17" x2="12" y2="21" /></svg
          >
          <span>Add remote daemon</span>
        </button>
      </div>
      <p class="add-folder-sub muted small">
        Track another folder — git repo or plain directory.
      </p>
    </div>
  {/if}
</main>

<SessionDock
  entries={dockEntries}
  {focusedSource}
  {dockRepoStatuses}
  {dockRepoWorktrees}
  wtSummaries={wtSummaryByPath}
  wtRefreshing={wtSummaryRefreshing}
  loadWtSummary={(path) => void loadWtSummary(path)}
  zen={zenRowKey !== null}
  on:pick={(e) => void onDockPick(e.detail)}
  on:scrollToRepo={(e) => {
    // In zen, switch zen to this repo instead of scrolling the page.
    if (switchZenToRepo(e.detail.repoId)) return;
    const el = document.querySelector(
      `.row[data-repo-id="${CSS.escape(e.detail.repoId)}"]`,
    ) as HTMLElement | null;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const maxY = document.documentElement.scrollHeight - window.innerHeight;
    animateValue({
      from: window.scrollY,
      to: centerScrollTarget(
        r.top,
        r.height,
        window.innerHeight,
        window.scrollY,
        maxY,
      ),
      duration: DOCK_SCROLL_MS,
      apply: (v) => window.scrollTo(0, v),
    });
  }}
/>

<StickyNotesLayer
  changeKey={notesChangeKey}
  {repos}
  {remoteDaemons}
  onCommandLinkOpen={handleCommandLinkOpen}
  onCommandLinkEdit={handleCommandLinkEdit}
  {runningCommandIds}
  {commandUrls}
/>

<DebugPanel />

<ConfirmDialog />
<SettingsDialog bind:open={settingsDialogOpen} />
<SummarizeDialog />
<ShareSessionDialog />
<ReceiveInviteDialog />
<CopySessionDialog />
<RepairSessionDialog />
<RepoReorderDialog
  bind:open={reorderDialogOpen}
  {repos}
  onReorder={reorderRepos}
  defaultColor={defaultChipHex}
  highlightId={reorderHighlightRepoId}
/>
<AddRemoteDaemonDialog
  bind:open={addDaemonOpen}
  onAdd={addRemoteDaemon}
  onConnect={connectRemoteDaemon}
  provision={provisionApi}
  canProvision={provisionCapable}
  {provisionUnavailableReason}
  attachJob={provisionAttachJob}
  onDone={({ status, mode }) => {
    if (status === "done") {
      void load();
      addToast({
        kind: "success",
        message:
          mode === "uninstall"
            ? "Daemon uninstalled from the box."
            : "Remote daemon provisioned + connected.",
      });
    }
  }}
  onClose={() => (provisionAttachJob = null)}
/>
<DaemonInfoDialog
  open={daemonDialogId !== null}
  daemon={remoteDaemons.find((d) => d.id === daemonDialogId) ?? null}
  repos={daemonDialogId
    ? repos.filter((r) => r.daemonId === daemonDialogId)
    : []}
  online={daemonDialogId ? daemonsOnline.get(daemonDialogId) : undefined}
  onRemove={async () => {
    const id = daemonDialogId;
    if (!id) return;
    if (await removeDaemon(id)) daemonDialogId = null;
  }}
  onUninstall={async () => {
    const id = daemonDialogId;
    if (!id) return;
    if (await uninstallDaemonOnBox(id)) daemonDialogId = null;
  }}
  onReconnect={async () => {
    const id = daemonDialogId;
    if (!id) return { ok: false, error: "no daemon" };
    return reconnectDaemon(id);
  }}
  onDiagnose={async () => {
    const id = daemonDialogId;
    if (!id) throw new Error("no daemon");
    return diagnoseDaemonConnection(id);
  }}
  onFocus={(r) => void focusRepoRow(r.id)}
  onClose={() => (daemonDialogId = null)}
/>
<AddRemoteFolderDialog
  bind:open={addRemoteFolderOpen}
  daemons={remoteDaemons}
  preselectDaemonId={addRemoteFolderDaemonId}
  {repos}
  onAdd={addRemoteFolder}
/>

{#if toasts.length > 0}
  <div class="toast-stack" role="region" aria-label="Notifications">
    {#each toasts as t (t.id)}
      <div
        class="toast toast-{t.kind}"
        class:toast-clickable={!!t.onClick}
        role={t.kind === "error" ? "alert" : "status"}
      >
        <span class="toast-icon" aria-hidden="true">
          {#if t.agent}
            <AgentIcon agent={t.agent} size={16} />
          {:else if t.kind === "error"}!{:else if t.kind === "warning"}⚠{:else if t.kind === "success"}✓{:else if t.kind === "invite"}⇆{:else}ℹ{/if}
        </span>
        <!-- svelte-ignore a11y-click-events-have-key-events a11y-no-static-element-interactions -->
        <div
          class="toast-body"
          class:toast-body-stacked={!!t.title}
          on:click={t.onClick
            ? () => {
                t.onClick?.();
                dismissToast(t.id);
              }
            : undefined}
        >
          {#if t.title}<strong class="toast-title">{t.title}</strong>{/if}
          <span
            class="toast-message"
            class:toast-message-italic={t.messageItalic}>{t.message}</span
          >
        </div>
        <button
          class="toast-close"
          on:click={() => dismissToast(t.id)}
          aria-label="Dismiss">×</button
        >
      </div>
    {/each}
  </div>
{/if}

<style>
  /*
   * App-wide CSS lives in packages/ui/src/styles/, imported from main.ts:
   *   tokens.css      — design tokens (colors, radii, scrollbars).
   *   base.css        — html/body resets, main layout, button/input
   *                     defaults, .muted/.small/.nopad utilities,
   *                     loading screen, error banner.
   *   popover.css     — Popover.svelte shell + variant overrides.
   *   agent-row.css   — .agent-row family used in every picker.
   *   new-session.css — transient new-session column shell + header.
   *   source-control.css — Unstaged/Staged tabs + diff + History.
   *   zen-row.css     — per-row "zen" focus layout.
   *   overlays.css    — dirty-checkout modal + toast stack.
   *   header.css      — top h1 strip + actions/events/tuis buttons.
   *   diagnostics.css — Recent actions + Errors list rows.
   *   worktree-row.css — .row layout, repo/branch chips, agent badge
   *                      cluster, status dot, ↑/↓ chips, new-wt, chevron.
   *   wt-picker.css   — worktree-picker rows + create-new + branch picker.
   *
   * App.svelte intentionally has no scoped <style> rules of its own.
   * Anything new shared across the dashboard should land in styles/
   * rather than in this block — see plans/PLAN.md → "App.svelte
   * refactor (componentization)".
   */
</style>
