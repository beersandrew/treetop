import {
  join,
  resolve,
  normalize,
  sep,
  dirname,
  basename,
  relative,
  extname,
} from "node:path";
import {
  homedir,
  tmpdir,
  totalmem,
  networkInterfaces,
  hostname as osHostname,
} from "node:os";
import {
  stat as fsStat,
  readdir,
  writeFile as fsWriteFile,
  readFile,
  mkdir as fsMkdir,
  rename as fsRename,
  cp as fsCp,
  rm as fsRm,
} from "node:fs/promises";
import { existsSync, mkdirSync, statSync } from "node:fs";
import { DuplicateRepoError, Workspace } from "./workspace";
import { initDaemonLog } from "./daemon-log";
import { installCrashGuard } from "./process-safety-net";
import {
  repairAllClaudeJson,
  repairClaudeJsonFile,
} from "./claude-json-repair";
import {
  listWorktrees,
  mainWorktreePathFor,
  getWorktreeDetails,
  listCommits,
  getDiff,
  getFileDiff,
  getCommitDiff,
  fetchAll,
  createWorktree,
  removeWorktree,
  listBranches,
  checkoutBranch,
  pullFastForward,
  pushUpstream,
  listRemotes,
  getUpstreamRemoteName,
  pickRemoteUrlForShare,
  parseChangedFiles,
  parseNumstat,
  parseUnpushedCommits,
  type DiffKind,
  type FileDiffKind,
} from "./git";
import { createLimiter } from "./concurrency";
import { createStaleWhileRevalidateCache } from "./async-cache";
import { $, type ServerWebSocket } from "bun";
import {
  detectAgents,
  agentsForWorktree,
  groupSessionsByFolder,
  type FolderSuggestion,
} from "./agents";
import { computeAgentUsage, topClaudeSessionsByTokens } from "./agent-usage";
import { startActivityTail, onActivity } from "./activity";
import {
  getSessionResponseJson,
  getSessionsBatchResults,
  sessionCacheStats,
  parseSessionFile,
  readSessionInlineMedia,
  type BatchSessionCursor,
} from "./sessions";
import { diagnoseClaudeSession, repairClaudeSession } from "./session-repair";
import { serveImage } from "./images";
import { pickFolder, pickFile } from "./picker";
import { openIn, openDefault, detectEditors } from "./open";
import { EventLog } from "./events";
import { ErrorLog, type ErrorKind, type ErrorSource } from "./errors";
import { ShellsLog } from "./shells";
import { OllamaSessionsLog } from "./ollama-sessions";
import { feedShellInput, clearShellInputBuffer } from "./shell-input";
import { handleMcp, mcpServerInfo, type JsonRpcRequest } from "./mcp";
import * as inflight from "./inflight";
import { pingSubscribers } from "./sse-heartbeat";
import { changeKindInvalidatesRepos } from "./sse-change-kinds";
import { planWorktreeRecompute } from "./worktree-refresh-plan";
import {
  terminalBackend,
  detectAgentLabel,
  terminalGoneReason,
} from "./terminals/node-pty-backend";
import type { TerminalSubscriber } from "./terminals/types";
import { SoundMarkerScanner } from "./sound-marker";
import { watchWorktree } from "./worktree-watcher";
import {
  detectSshChildren,
  detectSshFromCmd,
  type SshSession,
} from "./ssh-detect";
import { OrphanCleaner } from "./orphan-cleanup";
import { IdleReaper } from "./idle-reaper";
import { trimTerminalBacklog } from "./terminal-backlog";
import { TerminalPersist } from "./terminal-persist";
import { SshPool } from "./ssh-pool";
import {
  listRemoteDir,
  downloadFile,
  uploadFile,
  cachePathFor,
  describeRemoteListError,
} from "./ssh-files";
import { SyncTracker } from "./ssh-sync";
import { TunnelManager } from "./tunnel-manager";
import {
  parseDaemonProxyPath,
  forwardWithReconnect,
  buildProxyWsUrl,
} from "./daemon-proxy";
import { RemoteWsBridge } from "./daemon-ws-proxy";
import { saveAttachment, serveAttachment } from "./attachments";
import {
  sampleProcs,
  sampleCwds,
  renameArgv,
  resolveAgentBinary,
  discoverRepoProcesses,
  throttleAsync,
  withTimeout,
  type ProcUsage,
} from "./procs";
import { listOllamaModels, OLLAMA_HOST, formatOllamaError } from "./ollama";
import { fetchClaudeOAuthUsage } from "./claude-oauth-usage";
import { fetchCodexOAuthUsage } from "./codex-oauth-usage";
import { SummariesStore, RepoSummariesStore } from "./summaries";
import { sampleSessionForSummary, cleanAiTitle } from "./ollama-summarize";
import {
  collectRepoActivity,
  formatActivityPrompt,
  shouldGenerate as shouldGenerateRepoSummary,
  pickRepoSinceHours,
  DEFAULT_MAX_AGE_HOURS as REPO_MAX_AGE_HOURS,
} from "./repo-summary";
import { NotesStore, type AttachmentKind, type LinkTarget } from "./notes";
import {
  stripThinkingArtifacts,
  defaultLoginShell,
  availableShells,
  URL_RE,
  urlPriority,
  sanitiseMachineId,
  parseKind,
  parseTarget,
  decodeHtmlEntities,
  extractIconHrefs,
  patchWorktreeDetailsInRepos,
  summarizeRequestCounts,
  applyCodexThreadTitleIndex,
  selectedRemoteForRepo,
  envFlag,
  readonlyRouteDecision,
  shouldReuseWorktreeDetailsCache,
  shouldCopyTempWorkspaceRelativePath,
  debugAnalyzeInstance,
  rewriteTempWorkspaceAttachmentRefs,
} from "./server-helpers";
import {
  normalizeRemote,
  prepareOutgoingJsonl,
  validateManifest,
  type SessionShareManifest,
} from "./session-share";
import {
  acceptOffer,
  declineOffer,
  gcStaleOffers,
  listPendingOffers,
  storePendingOffer,
  type RepoLookup,
} from "./session-share-store";
import {
  migrateLegacyImportedSessions,
  migrateClaudeImportsToProjects,
  migrateOllamaImportsToWorkspace,
  repairImportedSessionCwds,
} from "./session-share-migrate";
import {
  loadOrCreatePeerIdentity,
  setPeerLabel,
  type PeerIdentity,
} from "./peer-identity";
import { PeerDiscovery } from "./peer-discovery";
import { copySessionToWorktree } from "./session-copy";
import { disambiguatePeerLabels } from "./peer-registry";
import {
  addIncomingMessage,
  addOutgoingMessage,
  getMessages,
  deleteMessage,
  mutePeer,
  unmutePeer,
  listMutes,
  isPeerMuted,
  MAX_BODY_BYTES,
} from "./messages";
import { record, snapshot as timingsSnapshot } from "./timings";
import { buildDiagnostics, buildConnectionDiagnosis } from "./diagnostics";
import { decodeConnectionString } from "./connection-string";
import { writePrivateKey } from "./write-private-key";
import { resolveInstallPayload } from "./install-payload";
import { listDrives } from "./drives";
import { ProvisionManager } from "./provision-manager";
import { makeProvisionSpawner } from "./provision-spawn";
import { runDeploy } from "./deploy";
import { buildProvisionPlan } from "./provision";
import { ClaudeCliAdapter } from "./claude-cli-adapter";
import { CodexAppServerAdapter } from "./codex-app-server";
import { createNativeAgentRegistry } from "./native-agent-adapters";

const REQUESTED_WORKSPACE_PATH =
  process.env.SUPERGIT_WORKSPACE ??
  join(homedir(), "supergit", "workspaces", "default");
const TEMP_WORKSPACE_SOURCE = process.env.TREETOP_TEMP_WORKSPACE_FROM
  ? resolve(process.env.TREETOP_TEMP_WORKSPACE_FROM)
  : null;

function shouldCopyTempWorkspaceEntry(sourceRoot: string, sourcePath: string) {
  return shouldCopyTempWorkspaceRelativePath(relative(sourceRoot, sourcePath));
}

const TEMP_WORKSPACE_TEXT_EXTENSIONS = new Set([".json", ".jsonl", ".md"]);

async function rewriteTempWorkspaceMetadataRefs(
  source: string,
  target: string,
): Promise<void> {
  const visit = async (dir: string): Promise<void> => {
    const entries = await readdir(dir, { withFileTypes: true });
    await Promise.all(
      entries.map(async (entry) => {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name === "attachments") return;
          await visit(path);
          return;
        }
        if (
          !entry.isFile() ||
          !TEMP_WORKSPACE_TEXT_EXTENSIONS.has(extname(entry.name))
        ) {
          return;
        }
        const raw = await readFile(path, "utf-8");
        const next = rewriteTempWorkspaceAttachmentRefs(raw, source, target);
        if (next !== raw) await fsWriteFile(path, next);
      }),
    );
  };
  await visit(target);
}

async function prepareTempWorkspaceCopy(source: string): Promise<string> {
  const st = statSync(source);
  if (!st.isDirectory()) {
    throw new Error(
      `TREETOP_TEMP_WORKSPACE_FROM must be a directory: ${source}`,
    );
  }
  const baseDir = process.env.TREETOP_TEMP_WORKSPACE_DIR
    ? resolve(process.env.TREETOP_TEMP_WORKSPACE_DIR)
    : join(tmpdir(), "treetop-temp-workspaces");
  const target = join(
    baseDir,
    `${basename(source) || "workspace"}-${Date.now()}-${process.pid}`,
  );
  await fsRm(target, { recursive: true, force: true });
  await fsCp(source, target, {
    recursive: true,
    filter: (src) => shouldCopyTempWorkspaceEntry(source, src),
  });
  await rewriteTempWorkspaceMetadataRefs(source, target);
  return target;
}

const WORKSPACE_PATH = TEMP_WORKSPACE_SOURCE
  ? await prepareTempWorkspaceCopy(TEMP_WORKSPACE_SOURCE)
  : REQUESTED_WORKSPACE_PATH;
const TEMP_WORKSPACE_MODE = TEMP_WORKSPACE_SOURCE !== null;
const READONLY_MODE = envFlag(process.env.TREETOP_READONLY);
const SIDE_INSTANCE_MODE = READONLY_MODE || TEMP_WORKSPACE_MODE;
const INSTANCE_RUNTIME_PATH = process.env.TREETOP_RUNTIME_DIR
  ? resolve(process.env.TREETOP_RUNTIME_DIR)
  : process.env.TREETOP_LOG_DIR
    ? resolve(process.env.TREETOP_LOG_DIR)
    : READONLY_MODE
      ? join(tmpdir(), "treetop-readonly", `${Date.now()}-${process.pid}`)
      : WORKSPACE_PATH;
const INSTANCE_LOG_PATH = process.env.TREETOP_LOG_DIR
  ? resolve(process.env.TREETOP_LOG_DIR)
  : READONLY_MODE
    ? INSTANCE_RUNTIME_PATH
    : WORKSPACE_PATH;

// Tee console.* into daemon.log so instrumentation +
// startup banners survive headless runs. Best-effort; failures here
// are non-fatal — the daemon keeps logging to stderr regardless.
const daemonLogPath = await initDaemonLog(INSTANCE_LOG_PATH);

function stringFormValue(value: FormDataEntryValue | null): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

function pasteLogValue(value: unknown): string | null {
  if (typeof value === "number") {
    return Number.isFinite(value) ? String(Math.round(value)) : null;
  }
  if (typeof value === "boolean") return String(value);
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const normalized = trimmed.replace(/\s+/g, " ").slice(0, 180);
  return /^[A-Za-z0-9._:/,@+=-]+$/.test(normalized)
    ? normalized
    : JSON.stringify(normalized);
}

function pasteLogPart(key: string, value: unknown): string {
  const rendered = pasteLogValue(value);
  return rendered === null ? "" : ` ${key}=${rendered}`;
}

// Last-resort crash guard: a stray unhandledRejection / uncaughtException
// must NOT exit the daemon — every hosted TUI is a child of our PTY helper,
// so the process dying kills every live session at once. Installed after
// the log is teed so the cause lands in daemon.log. See process-safety-net.ts.
installCrashGuard(process);

// Port resolution order:
//   1. SUPERGIT_PORT — explicit override, wins.
//   2. PORT          — set by portless (and most npm tooling) when
//                      wrapping us; lets `portless` inject its own port.
//   3. 7777          — default.
const PORT = Number(process.env.SUPERGIT_PORT ?? process.env.PORT ?? 7777);

// Network interface the daemon listens on (the `hostname` passed to
// Bun.serve). The bind address is a kernel-level filter on where a
// connection may arrive *before* any route code runs:
//   - "0.0.0.0"   — all interfaces. Reachable from the LAN; needed for
//                   session sharing (see plans/PLAN-SESSION-SHARE.md).
//   - "127.0.0.1" — loopback only. Invisible to the LAN and the internet;
//                   the OS refuses any non-local connection. This is the
//                   correct posture for a daemon fronted by a tunnel
//                   (SSH/WireGuard) on a public box — the tunnel
//                   terminates on loopback, so the daemon still sees a
//                   trusted loopback request while nothing is exposed.
//                   See plans/PLAN-REMOTE-DAEMON.md.
// Default stays "0.0.0.0" so existing LAN session-sharing is unaffected;
// remote/tunnel deployments override with SUPERGIT_BIND=127.0.0.1.
const BIND = process.env.SUPERGIT_BIND || "0.0.0.0";

const codexAgent = new CodexAppServerAdapter();
const nativeAgents = createNativeAgentRegistry({
  claude: new ClaudeCliAdapter(),
  codex: codexAgent,
});

function codexApprovalPolicy(value: unknown): unknown | undefined {
  if (
    value === "untrusted" ||
    value === "on-failure" ||
    value === "on-request" ||
    value === "never"
  ) {
    return value;
  }
  if (value && typeof value === "object" && "granular" in value) return value;
  return undefined;
}

function codexSandboxPolicy(
  value: unknown,
  cwd: string,
): Record<string, unknown> | undefined {
  if (value && typeof value === "object") {
    const type = (value as Record<string, unknown>).type;
    if (
      type === "dangerFullAccess" ||
      type === "readOnly" ||
      type === "workspaceWrite" ||
      type === "externalSandbox"
    ) {
      return value as Record<string, unknown>;
    }
  }
  if (value === "dangerFullAccess") return { type: "dangerFullAccess" };
  if (value === "readOnly") {
    return { type: "readOnly", networkAccess: false };
  }
  if (value === "workspaceWrite" || value === "workspace-write") {
    return {
      type: "workspaceWrite",
      writableRoots: [cwd],
      networkAccess: false,
      excludeTmpdirEnvVar: false,
      excludeSlashTmp: false,
    };
  }
  return undefined;
}

function codexTurnString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/** Path to a built UI's `dist/` directory. When non-null the daemon
 *  serves static files from it for any GET that doesn't match an API
 *  route (with a SPA fallback to index.html for client-side routes).
 *  Resolution order:
 *    0. SUPERGIT_NO_UI_DIR=1 — force null (dev posture). dev.ts sets
 *       this so a stale `packages/ui/dist` doesn't accidentally flip
 *       the dev daemon into prod-style static serving.
 *    1. SUPERGIT_UI_DIR env — explicit override.
 *    2. ../../ui/dist relative to this file — auto-detected when the
 *       SPA has been built (handy when portless / a sidecar invokes
 *       the daemon's own start script and bypasses the root env vars).
 *    3. null — dev mode, Vite handles UI hosting.
 */
const UI_DIR = ((): string | null => {
  if (process.env.SUPERGIT_NO_UI_DIR === "1") return null;
  if (process.env.SUPERGIT_UI_DIR) {
    return resolve(process.cwd(), process.env.SUPERGIT_UI_DIR);
  }
  // Compiled binary: look for ui/ next to the executable.
  const exeAdj = resolve(dirname(process.execPath), "ui");
  if (existsSync(exeAdj)) return exeAdj;
  // Dev / uncompiled: sibling workspace package.
  const sibling = resolve(import.meta.dir, "../../ui/dist");
  return existsSync(sibling) ? sibling : null;
})();
if (UI_DIR) console.log(`supergit daemon: serving UI from ${UI_DIR}`);

// Build timestamp — set at compile time by build-native.ts via --define.
// Absent in dev mode (uncompiled). The native app uses this to detect
// whether a running daemon is older than its bundled binary.
const DAEMON_BUILD_TIME: string | undefined =
  process.env.SUPERGIT_BUILD_TIME || undefined;

// Set a readable process title so `ps`, `top`, `htop`, and macOS
// Activity Monitor's command column show "supergit dev" / "supergit
// prod" instead of "bun run src/server.ts". Dev = no built UI in
// front of us; prod = we're serving the dist. The explicit env
// SUPERGIT_PROCESS_TITLE wins if set (handy for one-off runs).
process.title =
  process.env.SUPERGIT_PROCESS_TITLE ??
  (UI_DIR ? "supergit-daemon" : "supergit-daemon dev");

const workspace = await Workspace.open(WORKSPACE_PATH);
const events = await EventLog.open(WORKSPACE_PATH);
const errors = await ErrorLog.open(INSTANCE_LOG_PATH);
const shells = await ShellsLog.open(
  READONLY_MODE ? INSTANCE_RUNTIME_PATH : WORKSPACE_PATH,
);
const ollamaSessions = await OllamaSessionsLog.open(WORKSPACE_PATH);

/** External (non-TUI) repo-resident processes for the Processes panel.
 *  This scan is the heaviest part of an /api/processes poll — a
 *  full-machine process enumeration plus a `git worktree list` per repo —
 *  and its result changes slowly, so we throttle it well below the panel's
 *  poll cadence (which is 5s while open). The TUI rows the user actually
 *  watches are still sampled fresh on every request; only this scan is
 *  cached. A newly spawned external process therefore appears within
 *  EXTERNAL_SCAN_TTL_MS rather than instantly — an acceptable trade for
 *  not re-enumerating every process on the box twice a poll. */
const EXTERNAL_SCAN_TTL_MS = 8_000;
const EXTERNAL_SCAN_TIMEOUT_MS = 3_000;
const PROCESS_REPO_LIST_TIMEOUT_MS = 1_500;
const PROCESS_SAMPLE_TIMEOUT_MS = 1_500;
const PROCESS_SAMPLE_TTL_MS = 750;
const PROCESS_WORKTREE_TIMEOUT_MS = 1_000;
const PROCESS_ROUTE_SLOW_MS = 1_000;
const PROCESS_EXTERNAL_SLOW_MS = 1_000;
let lastProcessSamples = new Map<number, ProcUsage>();
const processSamples = throttleAsync(async () => {
  const records = terminalBackend.list().filter((r) => !r.exitedAt);
  try {
    lastProcessSamples = await withTimeout(
      sampleProcs(records.map((r) => r.pid)),
      PROCESS_SAMPLE_TIMEOUT_MS,
      "process sample",
    );
  } catch (err) {
    console.warn(
      `supergit daemon: /api/processes process sample skipped — ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
  return lastProcessSamples;
}, PROCESS_SAMPLE_TTL_MS);

let lastExternalProcessRows: Array<{
  id: string;
  pid: number;
  agent: undefined;
  cmd: string[];
  cwd: string;
  ownerId: undefined;
  createdAt: undefined;
  lastOutputAt: undefined;
  cpuPercent: number;
  memBytes: number;
  kind: "external";
  comm: string;
}> = [];
const externalProcessRows = throttleAsync(async () => {
  const scanStarted = Date.now();
  let repoCount = 0;
  let pathCount = 0;
  let worktreeMs = 0;
  let discoverMs = 0;
  let skippedWorktrees = 0;
  let slowestWorktree: { repo: string; ms: number } | null = null;
  const records = terminalBackend.list().filter((r) => !r.exitedAt);
  const excludePids = new Set<number>([
    process.pid,
    ...records.map((r) => r.pid),
  ]);
  const repos = await withTimeout(
    workspace.listRepos(),
    PROCESS_REPO_LIST_TIMEOUT_MS,
    "process repo list",
  ).catch((err) => {
    console.warn(
      `supergit daemon: /api/processes repo list skipped — ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return null;
  });
  if (!repos) return lastExternalProcessRows;
  repoCount = repos.length;
  const allPaths = new Set(repos.map((r) => r.path));
  for (const repo of repos) {
    const wtStarted = Date.now();
    try {
      const wts = await withTimeout(
        listWorktrees(repo.path),
        PROCESS_WORKTREE_TIMEOUT_MS,
        `worktree list ${repo.path}`,
      );
      for (const wt of wts) allPaths.add(wt.path);
    } catch (err) {
      skippedWorktrees += 1;
      console.warn(
        `supergit daemon: /api/processes worktree list skipped repo=${repo.id} path=${repo.path} — ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    } finally {
      const elapsed = Date.now() - wtStarted;
      worktreeMs += elapsed;
      if (!slowestWorktree || elapsed > slowestWorktree.ms) {
        slowestWorktree = { repo: repo.id || basename(repo.path), ms: elapsed };
      }
    }
  }
  pathCount = allPaths.size;
  try {
    const discoverStarted = Date.now();
    const external = await withTimeout(
      discoverRepoProcesses([...allPaths], excludePids),
      EXTERNAL_SCAN_TIMEOUT_MS,
      "external process scan",
    );
    discoverMs = Date.now() - discoverStarted;
    lastExternalProcessRows = external.map((ep) => ({
      id: `ext-${ep.pid}`,
      pid: ep.pid,
      agent: undefined,
      cmd: [ep.args],
      cwd: ep.cwd,
      ownerId: undefined,
      createdAt: undefined,
      lastOutputAt: undefined,
      cpuPercent: ep.cpuPercent,
      memBytes: ep.memBytes,
      kind: "external" as const,
      comm: ep.comm,
    }));
  } catch (err) {
    console.warn(
      `supergit daemon: /api/processes external scan skipped — ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
  const totalMs = Date.now() - scanStarted;
  if (totalMs > PROCESS_EXTERNAL_SLOW_MS || skippedWorktrees > 0) {
    console.log(
      `supergit daemon: /api/processes external scan total=${totalMs}ms repos=${repoCount} paths=${pathCount} worktrees=${worktreeMs}ms skippedWorktrees=${skippedWorktrees} slowestWorktree=${
        slowestWorktree
          ? `${slowestWorktree.repo}:${slowestWorktree.ms}ms`
          : "none"
      } discover=${discoverMs}ms rows=${lastExternalProcessRows.length}`,
    );
  }
  return lastExternalProcessRows;
}, EXTERNAL_SCAN_TTL_MS);

/** Active /api/ollama/chat streams keyed by termId. Lets a second
 *  request (DELETE /api/ollama/chat/:termId, or a fresh POST while
 *  one is already running) abort the in-flight upstream fetch so the
 *  user's Stop button has bite. One generation per termId at a time
 *  — a POST while another is running cancels the prior. */
const ollamaChatAborts = new Map<string, AbortController>();
const summaries = await SummariesStore.open(WORKSPACE_PATH);
const repoSummaries = await RepoSummariesStore.open(WORKSPACE_PATH);
/** In-memory `source.toLowerCase()` → AI title map, mirroring the
 *  `title` field of the on-disk summaries. Seeded once at startup and
 *  kept warm by the summarize POST/DELETE handlers, so the hot
 *  `/api/repos` enrichment path can attach `aiTitle` to agents without
 *  touching disk. */
const aiTitles = new Map<string, string>();
for (const rec of await summaries.listAll()) {
  if (rec.frontmatter.title) {
    aiTitles.set(rec.frontmatter.source.toLowerCase(), rec.frontmatter.title);
  }
}
/** Attach the workspace's manual title and the cached AI title to a
 *  detected agent. Shared by every place that lists agents so the two
 *  title sources never drift apart. */
function withSessionTitles<T extends { source: string }>(
  s: T,
  titles: Record<string, string>,
): T {
  const manualTitle = titles[s.source];
  const aiTitle = aiTitles.get(s.source.toLowerCase());
  if (!manualTitle && !aiTitle) return s;
  return {
    ...s,
    ...(manualTitle ? { manualTitle } : {}),
    ...(aiTitle ? { aiTitle } : {}),
  };
}

async function syncCodexThreadTitleIndex(
  source: string,
  title: string,
): Promise<void> {
  const indexPath = join(homedir(), ".codex", "session_index.jsonl");
  const raw = await readFile(indexPath, "utf-8").catch((err) => {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw err;
  });
  const next = applyCodexThreadTitleIndex(
    raw,
    source,
    title,
    new Date().toISOString(),
  );
  if (!next.changed) return;
  const tmp = `${indexPath}.supergit-tmp`;
  await fsMkdir(dirname(indexPath), { recursive: true });
  await fsWriteFile(tmp, next.raw);
  await fsRename(tmp, indexPath);
}

/** Single-flight per `repoId` for /api/repos/:id/summarize. Joins
 *  concurrent triggers (the dashboard paints rows in parallel) so
 *  one Ollama call covers the whole burst. */
const repoSummaryInflight = new Map<string, Promise<void>>();
const notes = await NotesStore.open(WORKSPACE_PATH);

const sshPool = new SshPool();
const sshSyncTracker = new SyncTracker(
  async (hostKey, remotePath, localCachePath) => {
    const [userHost, portStr] = hostKey.split(":");
    const port = Number(portStr) || 22;
    const at = userHost!.indexOf("@");
    const user = at !== -1 ? userHost!.slice(0, at) : undefined;
    const host = at !== -1 ? userHost!.slice(at + 1) : userHost!;
    const sftp = await sshPool.connect(user, host, port);
    await uploadFile(sftp, localCachePath, remotePath);
  },
);

// Owns the ssh -L tunnels to attached remote daemons (Phase 4b). Requests
// to /api/daemons/<id>/* are reverse-proxied over these tunnels to the
// remote daemon's loopback. See plans/PLAN-REMOTE-DAEMON.md.
//
// SUPERGIT_TUNNEL_DIRECT=1 skips ssh and proxies straight at the remote's
// 127.0.0.1:<port> — ONLY for the two-daemon e2e harness, which runs both
// daemons on localhost (no real network hop to tunnel). Never set in prod.
// How long a proxied request waits for the remote's response headers before
// giving up (→ 502 → self-heal reopens). A half-dead tunnel after sleep still
// ACCEPTS the connection, so without this the fetch hangs for minutes and the
// daemon wedges. Cleared once headers arrive, so it never cuts a long body.
const PROXY_TIME_TO_HEADERS_MS =
  Number(process.env.SUPERGIT_PROXY_TIMEOUT_MS) || 15_000;

const tunnelManager = new TunnelManager({
  direct: process.env.SUPERGIT_TUNNEL_DIRECT === "1",
  // How long to wait for the ssh -L listener to bind. Windows cold-connects
  // routinely need >8s; override per-box with SUPERGIT_TUNNEL_READY_MS.
  readyTimeoutMs: Number(process.env.SUPERGIT_TUNNEL_READY_MS) || undefined,
  // Breadcrumbs to daemon.log so "the remote went offline after my laptop
  // slept" is diagnosable — the ssh exits on wake, the next request reopens.
  log: (msg) => console.log(`supergit daemon: ${msg}`),
});

/** Probe a remote daemon's `/api/health` through its local tunnel port.
 *  Shared by `/api/diagnose` and the per-daemon `/connection` check. Never
 *  throws — a failure becomes `{ ok: false, error }`. */
async function healthProbe(
  localPort: number,
): Promise<{ ok: boolean; status?: string; version?: string; error?: string }> {
  try {
    const r = await fetch(`http://127.0.0.1:${localPort}/api/health`, {
      signal: AbortSignal.timeout(4000),
    });
    const j = (await r.json().catch(() => ({}))) as Record<string, unknown>;
    return {
      ok: r.ok,
      status: typeof j.status === "string" ? j.status : undefined,
      version: typeof j.version === "string" ? j.version : undefined,
    };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** Ensure a tunnel is open for a registered remote daemon and return its
 *  local loopback port. Throws if the id isn't registered. */
async function ensureRemoteTunnelPort(id: string): Promise<number> {
  const daemons = await workspace.listRemoteDaemons();
  const daemon = daemons.find((d) => d.id === id);
  if (!daemon) throw new Error("remote daemon not found");
  const tunnel = await tunnelManager.open(daemon);
  return tunnel.localPort;
}

// ── Remote-daemon auto-provisioning ("connect a daemon") ─────────────────
// The install payload (source we tar+ship to a box) — resolved once: the
// bundled copy next to a packaged binary, or the live repo in dev. Mode
// "none" means this build can't auto-provision (manual paste still works).
const installPayload = resolveInstallPayload({
  execDir: dirname(process.execPath),
  sourceRoot: resolve(import.meta.dir, "../../.."),
  exists: existsSync,
});

/** Register a remote daemon from a `supergit1:` connection string: persist
 *  the (forward-only) key server-side, add the daemon, broadcast. Shared by
 *  the manual /api/daemons/connect route and auto-provisioning.
 *
 *  `hostOverride` (provisioning only): the installer's token embeds the box's
 *  SELF-detected IP (e.g. its LAN address), but the box can't know which
 *  address the operator actually reaches it by — a Tailscale/public IP, a
 *  hostname, etc. The provision flow DOES know: it's the host the user typed
 *  + ssh'd through. Prefer that for the tunnel, or the daemon registers at an
 *  address the user can't reach (→ permanently "offline"). */
async function registerRemoteFromConnectionString(
  cs: string,
  hostOverride?: string,
) {
  const decoded = decodeConnectionString(cs);
  if (!decoded.ok) throw new Error(decoded.error);
  const p = decoded.payload;
  let identityPath: string | undefined;
  if (p.privateKey) {
    const keysDir = join(WORKSPACE_PATH, "keys");
    await fsMkdir(keysDir, { recursive: true });
    identityPath = join(keysDir, crypto.randomUUID());
    await writePrivateKey(identityPath, p.privateKey);
  }
  const daemon = await workspace.addRemoteDaemon({
    label: p.label ?? "",
    host: hostOverride?.trim() || p.host,
    user: p.user,
    port: p.port,
    sshPort: p.sshPort,
    identityPath,
  });
  broadcast("change", { kind: "remote_daemon_add", id: daemon.id });
  return daemon;
}

const provisionManager = new ProvisionManager({
  spawn: makeProvisionSpawner(),
  newId: () => crypto.randomUUID(),
  register: async (token, hostOverride) => {
    // Register at the host the user provisioned THROUGH (reachable from here),
    // not the box's self-detected IP baked into the token.
    const daemon = await registerRemoteFromConnectionString(
      token,
      hostOverride,
    );
    // Best-effort: bring the tunnel up so the row goes live immediately. A
    // tunnel hiccup mustn't fail the (already-registered) provision.
    ensureRemoteTunnelPort(daemon.id).catch(() => {});
    return { id: daemon.id };
  },
  unregister: async (daemonId) => {
    await tunnelManager.close(daemonId);
    await workspace.removeRemoteDaemon(daemonId);
    broadcast("change", { kind: "remote_daemon_remove", id: daemonId });
  },
});

/** Per-terminal SSH session state. Updated by the 5s CWD sampling cycle. */
const termSshSessions = new Map<string, SshSession>();
const terminalPersist = new TerminalPersist(
  READONLY_MODE ? INSTANCE_RUNTIME_PATH : WORKSPACE_PATH,
);

const orphanCleaner = new OrphanCleaner({
  getTerminals: () =>
    terminalBackend.list().map((r) => ({
      id: r.id,
      pid: r.pid,
      isAlive: !r.exitedAt,
    })),
  killTerminal: async (id) => {
    const h = terminalBackend.get(id);
    if (h?.isAlive()) await h.kill();
  },
  log: (msg) => console.log(`supergit daemon: ${msg}`),
});

import type { Subprocess } from "bun";
import { customLinkKind, type CommandRunMode } from "./workspace";

interface RunningCommand {
  proc: Subprocess;
  linkId: string;
  repoId: string;
  pid: number;
  startedAt: string;
  cmd: string;
}
const runningCommands = new Map<string, RunningCommand>();

/** Wrap a raw command string for execution via the platform's shell. */
function shellExec(cmd: string): string[] {
  return process.platform === "win32"
    ? [process.env.COMSPEC ?? "cmd.exe", "/c", cmd]
    : ["sh", "-c", cmd];
}

// GUI launchers can give the daemon a minimal system PATH. Sample the user's
// login shell once so Supergit-launched commands can still find npm/bun/node.
async function readInteractiveShellPath(): Promise<string | undefined> {
  if (process.platform === "win32") return undefined;
  const shell = process.env.SHELL || "/bin/zsh";
  try {
    const proc = Bun.spawn(
      [shell, "-lic", "printf '\\n__SUPERGIT_PATH__%s\\n' \"$PATH\""],
      {
        stdin: "ignore",
        stdout: "pipe",
        stderr: "ignore",
        env: process.env,
      },
    );
    const timeout = setTimeout(() => {
      try {
        proc.kill();
      } catch {}
    }, 2000);
    const [stdout, code] = await Promise.all([
      new Response(proc.stdout).text(),
      proc.exited,
    ]);
    clearTimeout(timeout);
    if (code !== 0) return undefined;
    const line = stdout
      .split("\n")
      .filter((x) => x.startsWith("__SUPERGIT_PATH__"))
      .at(-1);
    const path = line?.slice("__SUPERGIT_PATH__".length).trim();
    return path && path.includes(":") ? path : undefined;
  } catch {
    return undefined;
  }
}

const INTERACTIVE_SHELL_PATH = await readInteractiveShellPath();
const COMMAND_PATH = INTERACTIVE_SHELL_PATH ?? process.env.PATH;

function terminalSpawnEnv(): Record<string, string> | undefined {
  return COMMAND_PATH && COMMAND_PATH !== process.env.PATH
    ? { PATH: COMMAND_PATH }
    : undefined;
}

function backgroundCommandEnv(): Record<string, string> {
  // Background commands do not get a login shell, so pass the sampled PATH
  // explicitly while still removing launcher/proxy variables that break Vite.
  const env = {
    ...process.env,
    ...(COMMAND_PATH ? { PATH: COMMAND_PATH } : {}),
  };
  delete env.PORT;
  delete env.PORTLESS_URL;
  delete env.NODE_EXTRA_CA_CERTS;
  return env;
}

const commandDetectedUrls = new Map<string, string[]>();

type DetectedPackageManager = "npm" | "yarn" | "bun";

async function detectPackageManagers(
  dir: string,
  pkg: unknown,
): Promise<DetectedPackageManager[]> {
  const found = new Set<DetectedPackageManager>();
  if (pkg && typeof pkg === "object") {
    const packageManager = (pkg as Record<string, unknown>).packageManager;
    if (typeof packageManager === "string") {
      const name = packageManager.split("@", 1)[0];
      if (name === "npm" || name === "yarn" || name === "bun") found.add(name);
    }
  }

  const locks: Array<[DetectedPackageManager, string]> = [
    ["npm", "package-lock.json"],
    ["npm", "npm-shrinkwrap.json"],
    ["yarn", "yarn.lock"],
    ["bun", "bun.lock"],
    ["bun", "bun.lockb"],
  ];
  for (const [manager, file] of locks) {
    if (
      await Bun.file(join(dir, file))
        .exists()
        .catch(() => false)
    ) {
      found.add(manager);
    }
  }

  if (found.size === 0) found.add("npm");
  return (["npm", "yarn", "bun"] as const).filter((manager) =>
    found.has(manager),
  );
}

function detectCommandUrl(
  handle: {
    subscribe: (sub: {
      onData: (chunk: Uint8Array) => void;
      onExit: () => void;
    }) => () => void;
    id: string;
  },
  linkId: string,
  repoId: string,
): void {
  const decoder = new TextDecoder();
  let buf = "";
  const seen = new Set<string>();
  let urls: string[] = [];

  function publish() {
    const sorted = [...urls].sort((a, b) => urlPriority(b) - urlPriority(a));
    commandDetectedUrls.set(linkId, sorted);
    broadcast("change", { kind: "command_url", linkId, repoId, urls: sorted });
  }

  const timeout = setTimeout(() => unsub(), 120_000);
  const unsub = handle.subscribe({
    onData(chunk: Uint8Array) {
      buf += decoder.decode(chunk, { stream: true });
      const clean = buf.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "");
      let m: RegExpExecArray | null;
      let added = false;
      URL_RE.lastIndex = 0;
      while ((m = URL_RE.exec(clean)) !== null) {
        const url = m[0].replace(/[.,;:]+$/, "");
        try {
          if (Number(new URL(url).port) === PORT) continue;
        } catch {
          continue;
        }
        if (seen.has(url)) continue;
        seen.add(url);
        urls.push(url);
        added = true;
      }
      if (added) publish();
      if (buf.length > 8192) buf = buf.slice(-4096);
    },
    onExit() {
      clearTimeout(timeout);
    },
  });
}

/** Reused by every /api/session* route to keep ?source= from being
 *  an arbitrary file-read. Returns the agent kind (claude/codex/
 *  ollama) when the path lives under a known agent root, null
 *  otherwise. Centralised so the summarize endpoints use the same
 *  allowlist as /api/session. */
function resolveSessionAgent(
  source: string,
): { agent: "claude" | "codex" | "ollama"; normalised: string } | null {
  const home = homedir();
  const claudeRoot = join(home, ".claude", "projects") + sep;
  const codexRoots = [
    join(home, ".codex", "sessions") + sep,
    join(home, ".config", "openai-codex", "sessions") + sep,
  ];
  const ollamaRoot = join(WORKSPACE_PATH, "ollama") + sep;
  // Imported sessions from session-share live under
  //   <workspace>/imported-sessions/<machine>/<agent>/<sid>.jsonl
  // The agent kind is encoded in the third-from-last path segment,
  // which is why acceptOffer writes the file at that depth — keeps
  // this resolver sync. The same path is recognised for either
  // claude or codex; ollama imports aren't supported yet.
  const importedRoot = join(WORKSPACE_PATH, "imported-sessions") + sep;
  const normalised = resolve(source);
  const ci = process.platform === "win32";
  const cmp = (s: string, prefix: string) =>
    ci
      ? s.toLowerCase().startsWith(prefix.toLowerCase())
      : s.startsWith(prefix);
  if (cmp(normalised, claudeRoot)) return { agent: "claude", normalised };
  if (codexRoots.some((r) => cmp(normalised, r)))
    return { agent: "codex", normalised };
  if (cmp(normalised, ollamaRoot)) return { agent: "ollama", normalised };
  if (cmp(normalised, importedRoot)) {
    // Path looks like .../imported-sessions/<machine>/<agent>/<sid>.jsonl
    // — peel three segments to extract the agent.
    const parts = normalised.split(sep);
    const agentSeg = parts[parts.length - 2];
    if (agentSeg === "claude" || agentSeg === "codex") {
      return { agent: agentSeg, normalised };
    }
  }
  return null;
}

/** Return the host's first private-LAN IPv4 address (192.168.x.x,
 *  10.x.x.x, or 172.16-31.x.x). Used by the dashboard's tagline strip
 *  to show the URL teammates / other machines should hit when sharing
 *  sessions on the LAN. Returns null if nothing usable is found
 *  (laptop offline, only loopback present, etc.). */
function findLocalIp(): string | null {
  const ifaces = networkInterfaces();
  const candidates: string[] = [];
  for (const list of Object.values(ifaces)) {
    if (!list) continue;
    for (const ni of list) {
      if (ni.family !== "IPv4" || ni.internal) continue;
      candidates.push(ni.address);
    }
  }
  const isPrivate = (ip: string) =>
    ip.startsWith("192.168.") ||
    ip.startsWith("10.") ||
    /^172\.(1[6-9]|2[0-9]|3[01])\./.test(ip);
  return candidates.find(isPrivate) ?? candidates[0] ?? null;
}

console.log(`supergit daemon: workspace = ${WORKSPACE_PATH}`);
if (TEMP_WORKSPACE_SOURCE) {
  console.log(
    `supergit daemon: temp workspace source = ${TEMP_WORKSPACE_SOURCE}`,
  );
}
if (READONLY_MODE) {
  console.log("supergit daemon: read-only mode enabled (TREETOP_READONLY=1)");
}
if (INSTANCE_RUNTIME_PATH !== WORKSPACE_PATH) {
  console.log(`supergit daemon: instance runtime = ${INSTANCE_RUNTIME_PATH}`);
}
if (INSTANCE_LOG_PATH !== INSTANCE_RUNTIME_PATH) {
  console.log(`supergit daemon: instance logs = ${INSTANCE_LOG_PATH}`);
}
if (daemonLogPath) {
  console.log(`supergit daemon: log file = ${daemonLogPath}`);
}
{
  const ip = findLocalIp();
  console.log(`supergit daemon: listening on http://0.0.0.0:${PORT}`);
  if (ip) console.log(`supergit daemon: LAN url       http://${ip}:${PORT}`);
}

if (READONLY_MODE) {
  console.log(
    "supergit daemon: workspace migrations disabled (read-only mode)",
  );
} else {
  // One-time migration for imported sessions written under the
  // pre-discovery layout (<machine>/<sid>.jsonl → <machine>/<agent>/<sid>.jsonl).
  // Idempotent — a daemon restart on a clean tree is a noop. Logs the
  // outcome so the user can spot if anything got left behind.
  void migrateLegacyImportedSessions(WORKSPACE_PATH)
    .then((r) => {
      if (r.moved > 0 || r.skipped > 0) {
        console.log(
          `supergit daemon: imported-sessions migrate — moved=${r.moved} skipped=${r.skipped}`,
        );
      }
    })
    .catch((e) => {
      console.error(
        `supergit daemon: imported-sessions migrate failed: ${
          e instanceof Error ? e.message : String(e)
        }`,
      );
    });

  // Second-stage migrate: rehouse legacy claude JSONLs that still live
  // under <ws>/imported-sessions/<machine>/claude/ into the equivalent
  // ~/.claude/projects/<encoded(cwd)>/ slot so Claude Code's --resume
  // finds them. Sidecar stays where it is, gains importedJsonlPath.
  // Idempotent.
  void migrateClaudeImportsToProjects(WORKSPACE_PATH)
    .then((r) => {
      if (r.moved > 0 || r.skipped > 0) {
        console.log(
          `supergit daemon: claude imports → projects — moved=${r.moved} skipped=${r.skipped}`,
        );
      }
    })
    .catch((e) => {
      console.error(
        `supergit daemon: claude imports → projects migrate failed: ${
          e instanceof Error ? e.message : String(e)
        }`,
      );
    });

  // Mirror for ollama imports: move them from
  // <ws>/imported-sessions/<machine>/ollama/<sid>.jsonl into
  // <ws>/ollama/<sid>.jsonl so scanOllama surfaces them as native
  // sessions. Sidecar stays under imported-sessions/, gains
  // importedJsonlPath.
  void migrateOllamaImportsToWorkspace(WORKSPACE_PATH)
    .then((r) => {
      if (r.moved > 0 || r.skipped > 0) {
        console.log(
          `supergit daemon: ollama imports → workspace — moved=${r.moved} skipped=${r.skipped}`,
        );
      }
    })
    .catch((e) => {
      console.error(
        `supergit daemon: ollama imports → workspace migrate failed: ${
          e instanceof Error ? e.message : String(e)
        }`,
      );
    });

  // Fourth-stage repair: re-apply the origin→local path rewrite to imported
  // claude sessions that under-rewrote at accept time (the forward-slash
  // `originRepoPath` vs backslash-cwd mismatch left a dead foreign cwd,
  // which made the terminal spawn fail with a misleading
  // `fork/exec /bin/bash: no such file or directory`). Idempotent: a
  // correctly-rewritten transcript no longer contains the origin path, so
  // the rewrite is a no-op. Pre-repair bytes are parked as `<jsonl>.repair-bak`.
  void repairImportedSessionCwds(WORKSPACE_PATH)
    .then((r) => {
      if (r.repaired > 0) {
        console.log(
          `supergit daemon: imported-session cwd repair — repaired=${r.repaired} scanned=${r.scanned}`,
        );
      }
    })
    .catch((e) => {
      console.error(
        `supergit daemon: imported-session cwd repair failed: ${
          e instanceof Error ? e.message : String(e)
        }`,
      );
    });
}

// Peer identity + mDNS discovery. Identity is the stable
// `(id, label)` pair this daemon advertises and that receivers store
// in their imported-session sidecars; discovery browses for other
// daemons advertising the same service type on the LAN. Both
// initialise asynchronously so the daemon's HTTP listener doesn't
// block on file I/O or bonjour init — routes check the module-level
// state and gracefully degrade (empty peer list, fallback hostname)
// during the brief startup window.
let peerIdentity: PeerIdentity | null = null;
let peerDiscovery: PeerDiscovery | null = null;
let peerModeEnabled = false;

function peerDiscoveryFrontendPort(): number {
  return UI_DIR ? PORT : Number(process.env.SUPERGIT_FRONTEND_PORT ?? 7779);
}

async function startPeerDiscovery(): Promise<void> {
  if (!peerIdentity) return;
  if (peerDiscovery) await peerDiscovery.stop();
  peerDiscovery = new PeerDiscovery({
    port: PORT,
    id: peerIdentity.id,
    label: peerIdentity.label,
    interfaceAddress: findLocalIp() ?? undefined,
    frontendPort: peerDiscoveryFrontendPort(),
  });
  peerDiscovery.start();
  peerModeEnabled = true;
  console.log(`supergit daemon: peer discovery started`);
}

async function stopPeerDiscovery(): Promise<void> {
  if (peerDiscovery) {
    await peerDiscovery.stop();
    peerDiscovery = null;
  }
  peerModeEnabled = false;
  console.log(`supergit daemon: peer discovery stopped`);
}

function isLoopback(addr: string): boolean {
  return addr === "127.0.0.1" || addr === "::1" || addr === "::ffff:127.0.0.1";
}

// The ONLY "METHOD /path" routes a remote (non-loopback) peer may reach,
// and only when peer mode is on. These are the discovery + session-share
// *receiver* endpoints another daemon legitimately calls:
//   - GET  /api/identity         peer liveness probe (peer-discovery.ts)
//   - GET  /api/health           connectivity/liveness check
//   - POST /api/sessions/offer   incoming session-share offer
//   - POST /api/messages/receive incoming peer message
// Everything not listed here — terminal spawn (RCE), command/run, open,
// open-default, file read/write, diff, npm-scripts, image, identity
// PATCH (rename), the SPA, etc. — stays loopback-only ALWAYS, so enabling
// session sharing can never expose the local control plane to other
// machines on the network. The match is method-aware on purpose: GET
// /api/identity is safe to expose, PATCH /api/identity is not.
// SECURITY: only add a route here if a remote peer must legitimately call
// it AND it cannot read arbitrary local files or run local processes.
const LAN_ALLOWED_ROUTES = new Set<string>([
  "GET /api/health",
  "GET /api/identity",
  "POST /api/sessions/offer",
  "POST /api/messages/receive",
]);

void (async () => {
  try {
    if (SIDE_INSTANCE_MODE) {
      console.log("supergit daemon: peer discovery disabled (side instance)");
      return;
    }
    const username = process.env.USER || process.env.USERNAME || "user";
    const defaultLabel = `${username}@${osHostname() || "unknown"}`;
    peerIdentity = await loadOrCreatePeerIdentity(WORKSPACE_PATH, {
      defaultLabel,
    });
    const prefs = await workspace.getPrefs();
    if (prefs.peerDiscovery === "on") {
      await startPeerDiscovery();
    }
    console.log(
      `supergit daemon: peer identity = ${peerIdentity.label} (${peerIdentity.id.slice(
        0,
        8,
      )}) — peer mode ${peerModeEnabled ? "on" : "off"}`,
    );
  } catch (e) {
    console.error(
      `supergit daemon: peer system init failed: ${
        e instanceof Error ? e.message : String(e)
      }`,
    );
  }
})();

// CORS allowlist. The wildcard `*` is a real attack surface: with `*` any
// website you visit could call localhost:7777 from your browser and read the
// responses (list repos, trigger openIn, etc.). We allowlist the Vite dev
// origin and nothing else. Programmatic clients (curl, agents, MCP) ignore
// CORS, so they keep working.
const ALLOWED_ORIGINS = new Set([
  "http://localhost:7779",
  "http://127.0.0.1:7779",
  // `portless` setups (https://github.com/vercel-labs/portless) put the
  // browser on `*.localhost`. Same-origin fetches from inside the SPA
  // bypass CORS already; we allowlist these explicitly so external
  // tools / curl with a forged Origin still work.
  "http://supergit.localhost",
  "https://supergit.localhost",
  "http://supergit-dev.localhost",
  "https://supergit-dev.localhost",
  ...(process.env.SUPERGIT_EXTRA_ORIGINS?.split(",")
    .map((o) => o.trim())
    .filter(Boolean) ?? []),
]);

import { clampCols, clampRows } from "./term-clamp";

function corsHeaders(req: Request): Record<string, string> {
  const origin = req.headers.get("Origin");
  if (origin && ALLOWED_ORIGINS.has(origin)) {
    return {
      "Access-Control-Allow-Origin": origin,
      "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      Vary: "Origin",
    };
  }
  // No Origin header (same-origin / programmatic): no CORS headers needed.
  // Disallowed origins get nothing back, so browsers refuse the response.
  return {};
}

// Hosts accepted in the `Host` request header — anti DNS-rebinding. A
// browser always sends Host = the page's origin host, so a rebinding page
// (its own domain re-pointed at 127.0.0.1) arrives here with that DOMAIN,
// never "localhost" or an IP. We accept loopback names, *.localhost
// (portless), any IP literal (so LAN-IP peer access keeps working —
// rebinding can't forge an IP Host), our own hostname, and any host from
// ALLOWED_ORIGINS / SUPERGIT_EXTRA_ORIGINS. Everything else is rejected,
// which blocks rebinding even on loopback (where the source IP looks safe
// but the Host header still carries the attacker's domain).
const ALLOWED_HOSTS = new Set<string>(
  [...ALLOWED_ORIGINS]
    .map((o) => {
      try {
        return new URL(o).hostname.toLowerCase();
      } catch {
        return "";
      }
    })
    .filter(Boolean),
);

function isAllowedHost(hostHeader: string | null): boolean {
  // No Host header => non-browser client (curl, agent, peer daemon). Not a
  // rebinding vector — that requires a browser, which always sends Host.
  if (!hostHeader) return true;
  // Strip the port. IPv6 literals are bracketed: "[::1]:7777".
  let host: string;
  if (hostHeader.startsWith("[")) {
    host = hostHeader.slice(1, hostHeader.indexOf("]"));
  } else {
    const colon = hostHeader.lastIndexOf(":");
    host = colon === -1 ? hostHeader : hostHeader.slice(0, colon);
  }
  host = host.toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  if (host === "127.0.0.1" || host === "::1" || host === "::ffff:127.0.0.1") {
    return true;
  }
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return true; // IPv4 literal
  if (host.includes(":")) return true; // IPv6 literal
  const self = (osHostname() || "").toLowerCase();
  if (self && (host === self || host === `${self}.local`)) return true;
  return ALLOWED_HOSTS.has(host);
}

// SSE subscriber registry. Mutating routes call broadcast() so connected
// clients refresh without polling.
const sseSubscribers = new Set<ReadableStreamDefaultController<Uint8Array>>();
const sseEncoder = new TextEncoder();

// Per-route request counter. Incremented at the top of the fetch handler
// and drained by the rolling logger below. Helps diagnose "supergit is
// making hundreds of fetches per second" without DevTools — every
// `REQUEST_RATE_INTERVAL_MS` we emit a line with the top routes and
// total request count for the window.
const requestCounts = new Map<string, number>();
const REQUEST_RATE_INTERVAL_MS = 10_000;
const REQUEST_RATE_MIN_TOTAL_TO_LOG = 50;
let requestWindowStartedAt = Date.now();
setInterval(() => {
  let total = 0;
  for (const n of requestCounts.values()) total += n;
  if (total >= REQUEST_RATE_MIN_TOTAL_TO_LOG) {
    const top = [...requestCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8)
      .map(([path, count]) => `${path}=${count}`)
      .join(" ");
    const perSec = (total / (REQUEST_RATE_INTERVAL_MS / 1000)).toFixed(1);
    console.log(
      `supergit daemon: request-rate window=${Math.round(REQUEST_RATE_INTERVAL_MS / 1000)}s ` +
        `total=${total} (${perSec}/s) top: ${top}`,
    );
  }
  requestCounts.clear();
  requestWindowStartedAt = Date.now();
}, REQUEST_RATE_INTERVAL_MS).unref?.();

// Periodic SSE comment-frame heartbeat. Without this, an EventSource
// only learns its connection is dead via TCP error — which on Windows
// after sleep/wake (or behind a proxy that drops idle conns) can take
// minutes, during which the dashboard's "● connected" pill silently
// lies and `change`/`fs_change` events go nowhere. Writing `: ping\n\n`
// on a fixed interval forces the half-open socket to error fast so
// EventSource's auto-reconnect can kick in. Override with
// SUPERGIT_SSE_HEARTBEAT_MS=0 to disable (e.g. in tests that spin up
// the daemon and want a quiet stream).
const SSE_HEARTBEAT_MS = Math.max(
  0,
  Number(process.env.SUPERGIT_SSE_HEARTBEAT_MS ?? 20_000),
);
if (SSE_HEARTBEAT_MS > 0) {
  setInterval(
    () => pingSubscribers(sseSubscribers),
    SSE_HEARTBEAT_MS,
  ).unref?.();
}

function broadcast(event: string, data: unknown): void {
  // Mutations expire the /api/repos cache so the UI's follow-up GET sees
  // the change. The set of "real" mutations is
  // narrow — see `sse-change-kinds.ts` for the rationale. Notification
  // kinds (sound_play, note_*, undo/redo, peerDiscovery, command_*,
  // message_*, session_invite_*) burst many times per second with live
  // sessions; invalidating on those forced every concurrent /api/repos
  // to re-run the full git fan-out + detectAgents() scan. fs_change
  // already invalidates per-path worktree details from its own handler
  // and the route mutations also invalidate explicitly, so we don't
  // need a blanket clear here.
  if (event === "change") {
    const kind = (data as { kind?: unknown } | null)?.kind;
    if (changeKindInvalidatesRepos(kind)) invalidateReposCache();
  }
  const payload = sseEncoder.encode(
    `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`,
  );
  for (const ctrl of sseSubscribers) {
    try {
      ctrl.enqueue(payload);
    } catch {
      sseSubscribers.delete(ctrl);
    }
  }
}

// Single-flight + 500ms freshness window for /api/repos. The route
// fans out to many `git` subprocesses per worktree (status, ahead/behind,
// numstats, untracked diffs); a single call can block the event loop
// for hundreds of ms on a large workspace. Without this, the dashboard
// auto-refresh + a coincident `fs_change` SSE event easily doubles or
// triples the fan-out within the same tick, starving terminal WS
// upgrades and "Open in <editor>" clicks behind it.
//
// Coalescing strategy:
//   - If a build is currently in flight, every caller awaits the SAME
//     promise. No duplicate git work.
//   - If the most recent build finished < REPOS_CACHE_MS ago, return
//     that cached payload directly. Mutations broadcast a `change`
//     event over SSE; the UI re-fetches, but if a burst of fs_change
//     events arrives we collapse them. The watcher itself already
//     debounces filesystem events to ~300ms (worktree-watcher.ts), so
//     500ms here just rounds up to the next debounce boundary.
//
// Wire format: the route returns NDJSON so the UI can render rows
// progressively. First line is a manifest of repo skeletons (id,
// path, name, color) so the dashboard can paint placeholder rows
// immediately; each subsequent line is a full enriched repo as the
// per-worktree git fan-out completes. The stream closes when all
// repos have flushed — there's no explicit "done" marker; EOF is
// sufficient. Cache hits stream the same shape from memory.
const REPOS_CACHE_MS = 2500;
type EnrichedRepo = Record<string, unknown> & { id: string };
let reposInflight: { key: string; promise: Promise<EnrichedRepo[]> } | null =
  null;
let reposCache: {
  at: number;
  key: string;
  selectedRemotes: Record<string, string>;
  value: EnrichedRepo[];
} | null = null;
let repsCacheGen = 0;

// /api/agent-usage caches its (detectAgents + computeAgentUsage)
// result for 60s. The data is for an at-a-glance hover tooltip — sub-
// minute freshness is overkill, and detectAgents() walks the whole
// ~/.claude + ~/.codex tree which is the bulk of the cost.
const AGENT_USAGE_CACHE_MS = 60_000;
let agentUsageCache: {
  at: number;
  value: Awaited<ReturnType<typeof computeAgentUsage>> | null;
} = { at: 0, value: null };

// /api/agent-usage/claude-top-sessions has its own cache because it's
// served from a different route now — top-sessions is the slowest
// part of the report (full JSONL scan over every Claude session
// active in the past week) so the tooltip fetches it lazily after
// the main payload lands. Same 60s TTL.
let claudeTopSessionsCache: {
  at: number;
  value: Awaited<ReturnType<typeof topClaudeSessionsByTokens>> | null;
} = { at: 0, value: null };

// detectAgents() walks ~/.claude + ~/.codex + workspaceStorage and is often
// the slowest part of /api/repos in a long-lived dashboard. The first scan
// blocks so the initial page has real agent rows; later expired reads reuse the
// last good snapshot and refresh in the background. That keeps periodic
// filesystem sweeps from holding the repo stream hostage.
import type { AgentSession } from "./agents";
const AGENTS_CACHE_MS = Number(process.env.SUPERGIT_AGENTS_CACHE_MS ?? 10_000);
const agentsCache = createStaleWhileRevalidateCache<AgentSession[]>({
  ttlMs: AGENTS_CACHE_MS,
  load: () => detectAgents(WORKSPACE_PATH),
  onRefreshError: (err) => {
    console.warn(
      "supergit daemon: background detectAgents refresh failed",
      err,
    );
  },
});

async function sharedDetectAgents(): Promise<AgentSession[]> {
  return agentsCache.get();
}

// Per-worktree git-status cache. Keyed by worktree path + selected remote;
// invalidated selectively when the fs watcher fires for that path. Without
// this, /api/repos spawns 3 git subprocesses per worktree on every
// refresh — a workspace with 5 repos × 3 worktrees = 45 processes.
// With the cache, only worktrees that actually changed re-run git.
import type { WorktreeDetails } from "./git";
const worktreeDetailsCache = new Map<
  string,
  { at: number; value: WorktreeDetails }
>();

// Cap concurrent cold git subprocesses across the whole daemon. /api/repos
// enrich fans out over every repo/worktree at once; on a cold cache (e.g.
// just after a restart) that herd spiked RSS into the GBs and stalled the
// event loop, starving PTY spawns. Cache hits bypass this entirely — only
// actual git work is gated. 8 keeps throughput high while bounding the peak.
const REPOS_GIT_CONCURRENCY = 8;
const reposGitLimit = createLimiter(REPOS_GIT_CONCURRENCY);

// A small, separate lane for refreshing the ONE worktree the user is actively
// interacting with (focused TUI / hovered row / dock click). The shared
// `reposGitLimit` above gets saturated by chatty background repos (dev servers
// firing fs_change continuously), which starves the focused repo's dirty badge.
// Keeping the priority refresh on its own slots means it never queues behind
// the herd — the UI polls it every few seconds so the focused repo stays live
// regardless of how busy everything else is.
const reposGitPriorityLimit = createLimiter(2);

// Per-worktree coalescing state for fs_change-driven recomputes. Bounds each
// worktree to one recompute per FS_RECOMPUTE_MIN_INTERVAL_MS (+ a trailing run)
// so a chatty worktree can't monopolize `reposGitLimit`. See planWorktreeRecompute.
const FS_RECOMPUTE_MIN_INTERVAL_MS = 2_500;
interface WtRecomputeRuntime {
  lastRunAtMs: number | null;
  inFlight: boolean;
  trailingTimer: ReturnType<typeof setTimeout> | null;
}
const wtRecomputeState = new Map<string, WtRecomputeRuntime>();
function wtRuntimeFor(wtPath: string): WtRecomputeRuntime {
  let s = wtRecomputeState.get(wtPath);
  if (!s) {
    s = { lastRunAtMs: null, inFlight: false, trailingTimer: null };
    wtRecomputeState.set(wtPath, s);
  }
  return s;
}

function worktreeDetailsCacheKey(
  wtPath: string,
  remote?: string | null,
): string {
  return `${wtPath}\0${remote ?? ""}`;
}

function getCachedWorktreeDetails(
  wtPath: string,
  remote?: string | null,
): WorktreeDetails | null {
  const key = worktreeDetailsCacheKey(wtPath, remote);
  const cached = worktreeDetailsCache.get(key);
  if (!cached) return null;
  if (
    !shouldReuseWorktreeDetailsCache({
      cachedAtMs: cached.at,
      nowMs: Date.now(),
    })
  ) {
    worktreeDetailsCache.delete(key);
    return null;
  }
  return cached.value;
}

function invalidateWorktreeDetails(wtPath: string): void {
  const prefix = `${wtPath}\0`;
  for (const key of worktreeDetailsCache.keys()) {
    if (key.startsWith(prefix)) worktreeDetailsCache.delete(key);
  }
}

function selectedRemoteForCachedWorktree(wtPath: string): string | null {
  if (!reposCache) return null;
  for (const repo of reposCache.value) {
    const worktrees = (repo as { worktrees?: Array<{ path?: unknown }> })
      .worktrees;
    if (!Array.isArray(worktrees)) continue;
    if (!worktrees.some((wt) => wt.path === wtPath)) continue;
    const remotes = (repo as { remotes?: Array<{ name?: unknown }> }).remotes;
    const validRemotes = Array.isArray(remotes)
      ? remotes.filter((r): r is { name: string } => typeof r.name === "string")
      : [];
    return selectedRemoteForRepo({
      selectedRemotes: reposCache.selectedRemotes,
      repoId: repo.id,
      remotes: validRemotes,
    });
  }
  return null;
}

// fs-watcher reaction: recompute just the changed worktree's git state and
// splice it into the cached /api/repos payload in place, THEN broadcast.
//
// Why not simply `invalidateWorktreeDetails(path)` + broadcast (the old
// behaviour)? The route's full-payload `reposCache` (REPOS_CACHE_MS)
// short-circuits before any rebuild, so the per-worktree delete was
// invisible until that payload TTL expired AND a later cache-missing fetch
// happened — push/pull/dirty badges went stale for an unbounded time after
// external edits/commits/fetches. Why not `invalidateReposCache()`? That
// forces a full rebuild including the expensive `detectAgents` JSONL scan on
// every fs_change (including no-op visible-fetch ticks) — the CPU pulse the
// change-kind gating was added to kill. Patching the one row that changed
// keeps badges live for ~free. Patch before broadcast so the UI's follow-up
// /api/repos GET sees the fresh row instead of racing the recompute.
// Recompute one worktree's git state and splice it into the cached /api/repos
// payload, THEN broadcast. `limit` selects the lane: the shared herd limiter
// for background fs_change recomputes, or the priority lane for the focused
// worktree's poll (so it never queues behind chatty repos).
async function recomputeWorktreeDetails(
  wtPath: string,
  limit: <T>(fn: () => Promise<T>) => Promise<T>,
): Promise<WorktreeDetails | null> {
  let details: WorktreeDetails;
  const selectedRemote = selectedRemoteForCachedWorktree(wtPath);
  try {
    details = await limit(() =>
      selectedRemote
        ? getWorktreeDetails(wtPath, { remote: selectedRemote })
        : getWorktreeDetails(wtPath),
    );
  } catch {
    // git failed (dir vanished mid-rename, etc.) — drop both caches so the
    // next GET rebuilds from scratch rather than serving a stale row.
    invalidateWorktreeDetails(wtPath);
    invalidateReposCache();
    broadcast("change", { kind: "fs_change", path: wtPath });
    return null;
  }
  worktreeDetailsCache.set(worktreeDetailsCacheKey(wtPath, selectedRemote), {
    at: Date.now(),
    value: details,
  });
  if (reposCache) {
    patchWorktreeDetailsInRepos(
      reposCache.value as Array<{ worktrees?: unknown }>,
      wtPath,
      details as unknown as Record<string, unknown>,
    );
  }
  broadcast("change", { kind: "fs_change", path: wtPath });
  return details;
}

// fs-watcher reaction, coalesced. A chatty worktree (dev server writing files)
// fires this every watcher debounce window; without coalescing each call takes
// a `reposGitLimit` slot and starves quiet repos' dirty badges. planWorktreeRecompute
// bounds each worktree to one recompute per FS_RECOMPUTE_MIN_INTERVAL_MS plus a
// single trailing run to capture whatever changed during the cooldown.
function onWorktreeFsChange(wtPath: string): void {
  const s = wtRuntimeFor(wtPath);
  const plan = planWorktreeRecompute(
    {
      lastRunAtMs: s.lastRunAtMs,
      inFlight: s.inFlight,
      hasPendingTrailing: s.trailingTimer !== null,
    },
    Date.now(),
    FS_RECOMPUTE_MIN_INTERVAL_MS,
  );
  if (plan.action === "skip") return;
  if (plan.action === "schedule-trailing") {
    s.trailingTimer = setTimeout(() => {
      s.trailingTimer = null;
      onWorktreeFsChange(wtPath);
    }, plan.delayMs);
    return;
  }
  void runWorktreeRecompute(wtPath, reposGitLimit);
}

async function runWorktreeRecompute(
  wtPath: string,
  limit: <T>(fn: () => Promise<T>) => Promise<T>,
): Promise<WorktreeDetails | null> {
  const s = wtRuntimeFor(wtPath);
  s.inFlight = true;
  s.lastRunAtMs = Date.now();
  try {
    return await recomputeWorktreeDetails(wtPath, limit);
  } finally {
    s.inFlight = false;
  }
}

function ndjsonHeaders(cors: Record<string, string>): Record<string, string> {
  return {
    "Content-Type": "application/x-ndjson; charset=utf-8",
    "Cache-Control": "no-store",
    ...cors,
  };
}

function manifestLineFor(
  repos: {
    id: string;
    path: string;
    name: string;
    addedAt: string;
    color?: string;
  }[],
): string {
  return (
    JSON.stringify({
      type: "manifest",
      repos: repos.map(({ id, path, name, addedAt, color }) => ({
        id,
        path,
        name,
        addedAt,
        color,
      })),
    }) + "\n"
  );
}

function repoLineFor(repo: EnrichedRepo): string {
  return JSON.stringify({ type: "repo", repo }) + "\n";
}

/** Resolve the accent colour (if any) of the repo that owns `cwd`.
 *  Worktrees live as siblings of the main checkout, so we map the cwd
 *  back to its main worktree path (via git) and match repos.json. Returns
 *  undefined when nothing matches or no repo has a colour — the terminal
 *  backend then falls back to the default user-box theme. Best-effort:
 *  any failure just yields undefined (the box still renders, untinted). */
async function repoColorForCwd(cwd: string): Promise<string | undefined> {
  try {
    const repos = await workspace.listRepos();
    if (!repos.some((r) => r.color)) return undefined; // nothing to match
    const main = await mainWorktreePathFor(cwd);
    if (!main) return undefined;
    const norm = (p: string) => resolve(p).replace(/[/\\]+$/, "");
    const target = norm(main);
    return repos.find((r) => norm(r.path) === target)?.color ?? undefined;
  } catch {
    return undefined;
  }
}

/** Response for the cache-hit / wait-for-inflight paths: flush the
 *  whole array in one go. Same shape as the streaming response so the
 *  client only needs one parser. */
function reposNDJSONFromCache(
  value: EnrichedRepo[],
  cors: Record<string, string>,
): Response {
  const enc = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      // Manifest first so the client can mount skeleton rows even from
      // a cache hit — keeps the render shape identical to the fresh
      // streaming path.
      const manifestRepos = value.map((r) => ({
        id: r.id as string,
        path: r.path as string,
        name: r.name as string,
        addedAt: r.addedAt as string,
        color: r.color as string | undefined,
      }));
      controller.enqueue(enc.encode(manifestLineFor(manifestRepos)));
      for (const r of value) controller.enqueue(enc.encode(repoLineFor(r)));
      controller.close();
    },
  });
  return new Response(stream, { headers: ndjsonHeaders(cors) });
}

/** Fresh build that yields each repo as soon as its worktrees finish
 *  enriching. Also populates the cache + resolves `reposInflight` so
 *  concurrent callers can share the work. */
function reposSelectionCacheKey(
  selectedRemotes: Record<string, string>,
): string {
  return JSON.stringify(
    Object.keys(selectedRemotes)
      .sort()
      .map((key) => [key, selectedRemotes[key]]),
  );
}

function parseSelectedRemotesParam(raw: string | null): Record<string, string> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (
        typeof key === "string" &&
        typeof value === "string" &&
        key.length > 0 &&
        value.length > 0
      ) {
        out[key] = value;
      }
    }
    return out;
  } catch {
    return {};
  }
}

/** Fresh build that yields each repo as soon as its worktrees finish
 *  enriching. Also populates the cache + resolves `reposInflight` so
 *  concurrent callers can share the work. */
function reposNDJSONFresh(
  cors: Record<string, string>,
  selectedRemotes: Record<string, string>,
  cacheKey: string,
): Response {
  const enc = new TextEncoder();
  const myGen = repsCacheGen;
  let resolveInflight: (v: EnrichedRepo[]) => void;
  let rejectInflight: (e: unknown) => void;
  reposInflight = {
    key: cacheKey,
    promise: new Promise<EnrichedRepo[]>((res, rej) => {
      resolveInflight = res;
      rejectInflight = rej;
    }),
  };

  // Client may abort mid-stream (fast page reload, navigating away).
  // Once that happens the underlying controller is closed and any
  // further enqueue/close/error throws `ERR_INVALID_STATE`. We still
  // want the git fan-out to run to completion so concurrent waiters
  // get the cached result — just stop touching the controller.
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const safeEnqueue = (chunk: Uint8Array): void => {
        if (cancelled) return;
        try {
          controller.enqueue(chunk);
        } catch {
          cancelled = true;
        }
      };
      // Phase timings for the /api/repos load. Logged as a single
      // structured line at the end so a slow load can be triaged from
      // the prod log (`/tmp/supergit-prod.log`) without needing to
      // re-run. Per-repo / per-worktree max times are surfaced so it's
      // obvious *which* repo or worktree dominated — the typical
      // pathologies (a slow drive, antivirus, a repo with many submodules)
      // all show up as one outlier.
      const t0 = performance.now();
      let tManifest = 0;
      let tEnrichStart = 0;
      const perRepoMs = new Map<string, number>();
      const perWorktreeMs: { wt: string; ms: number }[] = [];
      void (async () => {
        try {
          const tPrelude = performance.now();
          // Flush the manifest as soon as repos are listed — don't wait
          // for agent detection. The UI renders skeleton rows immediately.
          const repos = await workspace.listRepos();
          tManifest = performance.now() - tPrelude;
          safeEnqueue(enc.encode(manifestLineFor(repos)));

          // Agent detection + titles run in parallel with repo enrichment.
          // The git operations (listWorktrees, getWorktreeDetails) overlap
          // with agent scanning so the total wall time is max(git, agents)
          // instead of git + agents.
          const tAgentsStart = performance.now();
          let titledAgentCount = 0;
          let agentDetectMs = 0;
          const titledP = Promise.all([
            sharedDetectAgents(),
            workspace.listSessionTitles(),
          ]).then(([agents, titles]) => {
            const agentsMs = performance.now() - tAgentsStart;
            agentDetectMs = agentsMs;
            titledAgentCount = agents.length;
            if (agentsMs > 200) {
              console.log(
                `supergit daemon: agents=${agentsMs.toFixed(0)}ms (${agents.length} sessions)`,
              );
            }
            return agents.map((s) => withSessionTitles(s, titles));
          });

          const enriched: EnrichedRepo[] = [];
          tEnrichStart = performance.now();
          await Promise.all(
            repos.map(async (repo) => {
              const tRepo = performance.now();
              let result: EnrichedRepo;
              try {
                // Git ops + agent detection run concurrently. Await
                // agents only after git finishes so the overlap is real.
                const [[worktrees, remotes], titled] = await Promise.all([
                  Promise.all([
                    reposGitLimit(() => listWorktrees(repo.path)),
                    reposGitLimit(() => listRemotes(repo.path)),
                  ]),
                  titledP,
                ]);
                const selectedRemote = selectedRemoteForRepo({
                  selectedRemotes,
                  repoId: repo.id,
                  remotes,
                });
                const withDetails = await Promise.all(
                  worktrees.map(async (wt) => {
                    const tWt = performance.now();
                    let details = getCachedWorktreeDetails(
                      wt.path,
                      selectedRemote,
                    );
                    if (!details) {
                      details = await reposGitLimit(() =>
                        selectedRemote
                          ? getWorktreeDetails(wt.path, {
                              remote: selectedRemote,
                            })
                          : getWorktreeDetails(wt.path),
                      );
                      worktreeDetailsCache.set(
                        worktreeDetailsCacheKey(wt.path, selectedRemote),
                        {
                          at: Date.now(),
                          value: details,
                        },
                      );
                    }
                    perWorktreeMs.push({
                      wt: wt.path,
                      ms: performance.now() - tWt,
                    });
                    return {
                      ...wt,
                      ...details,
                      agents: agentsForWorktree(wt.path, titled),
                    };
                  }),
                );
                result = {
                  ...repo,
                  worktrees: withDetails,
                  remotes,
                } as EnrichedRepo;
              } catch {
                result = {
                  ...repo,
                  worktrees: [],
                  remotes: [],
                } as EnrichedRepo;
              }
              perRepoMs.set(repo.id, performance.now() - tRepo);
              enriched.push(result);
              safeEnqueue(enc.encode(repoLineFor(result)));
            }),
          );
          // Stable ordering for the cached array so cache-hit replays
          // match the workspace.listRepos() order. The streaming path
          // already flushed in completion-order, which is fine.
          const byId = new Map(enriched.map((r) => [r.id, r]));
          const ordered = repos
            .map((r) => byId.get(r.id))
            .filter((r): r is EnrichedRepo => r !== undefined);
          if (myGen === repsCacheGen) {
            reposCache = {
              at: Date.now(),
              key: cacheKey,
              selectedRemotes,
              value: ordered,
            };
          }
          resolveInflight(ordered);
          const totalMs = performance.now() - t0;
          const enrichMs = performance.now() - tEnrichStart;
          const slowestRepo = [...perRepoMs.entries()].sort(
            (a, b) => b[1] - a[1],
          )[0];
          const slowestWt = perWorktreeMs.sort((a, b) => b.ms - a.ms)[0];
          console.log(
            `supergit daemon: /api/repos total=${totalMs.toFixed(0)}ms ` +
              `prelude=${tManifest.toFixed(0)}ms agents=${agentDetectMs.toFixed(0)}ms(${titledAgentCount}) ` +
              `enrich=${enrichMs.toFixed(0)}ms repos=${repos.length}` +
              (slowestRepo
                ? ` slowestRepo=${slowestRepo[0]}:${slowestRepo[1].toFixed(0)}ms`
                : "") +
              (slowestWt
                ? ` slowestWt=${slowestWt.wt}:${slowestWt.ms.toFixed(0)}ms`
                : ""),
          );
          if (!cancelled) {
            try {
              controller.close();
            } catch {
              /* already closed */
            }
          }
        } catch (err) {
          rejectInflight(err);
          if (!cancelled) {
            try {
              controller.error(err);
            } catch {
              /* already closed */
            }
          }
        } finally {
          reposInflight = null;
        }
      })();
    },
    cancel() {
      cancelled = true;
    },
  });
  return new Response(stream, { headers: ndjsonHeaders(cors) });
}

async function reposNDJSONResponse(
  cors: Record<string, string>,
  jsonErr: (body: unknown, init?: ResponseInit) => Response,
  selectedRemotes: Record<string, string>,
): Promise<Response> {
  const now = Date.now();
  const cacheKey = reposSelectionCacheKey(selectedRemotes);
  if (
    reposCache &&
    reposCache.key === cacheKey &&
    now - reposCache.at < REPOS_CACHE_MS
  ) {
    return reposNDJSONFromCache(reposCache.value, cors);
  }
  if (reposInflight && reposInflight.key === cacheKey) {
    // Concurrent caller during a fresh build — wait for it, then
    // replay the cached array. We could splice ourselves into the
    // live stream, but a wait+replay is simpler and the cost is
    // bounded by the in-flight build's own latency.
    try {
      const value = await reposInflight.promise;
      return reposNDJSONFromCache(value, cors);
    } catch (err) {
      return jsonErr(
        { error: err instanceof Error ? err.message : String(err) },
        { status: 500 },
      );
    }
  }
  return reposNDJSONFresh(cors, selectedRemotes, cacheKey);
}

/** Invalidate the /api/repos result cache. Call from mutating routes so
 *  the next GET sees the user's change immediately instead of waiting
 *  out the 500ms window. The inflight promise can keep running — it's
 *  just no longer eligible to satisfy a later request from the cache. */
function invalidateReposCache(): void {
  reposCache = null;
  reposInflight = null;
  repsCacheGen++;
}

// In-memory favicon cache. Keyed by request URL; entries hold the bytes
// + content-type + an expiry timestamp. We don't persist to disk — the
// daemon restart will refetch, which is cheap (one HTTP round-trip per
// custom link the user has configured). TTL is generous: 24h hits
// browser cache anyway, but we still want to survive a few SSE-driven
// re-renders in a row without re-hitting the origin.
const FAVICON_TTL_MS = 24 * 60 * 60 * 1000;
const FAVICON_MAX_BYTES = 2 * 1024 * 1024;
const faviconCache = new Map<
  string,
  { at: number; bytes: Uint8Array; type: string }
>();

async function handleFavicon(
  url: URL,
  cors: Record<string, string>,
): Promise<Response> {
  const target = url.searchParams.get("url");
  if (!target) {
    return new Response(JSON.stringify({ error: "?url= is required" }), {
      status: 400,
      headers: { "Content-Type": "application/json", ...cors },
    });
  }
  let origin: URL;
  try {
    origin = new URL(target);
  } catch {
    return new Response(JSON.stringify({ error: "invalid url" }), {
      status: 400,
      headers: { "Content-Type": "application/json", ...cors },
    });
  }
  if (origin.protocol !== "http:" && origin.protocol !== "https:") {
    return new Response(JSON.stringify({ error: "http(s) only" }), {
      status: 400,
      headers: { "Content-Type": "application/json", ...cors },
    });
  }
  const cacheKey = `${origin.origin}/`;
  const cached = faviconCache.get(cacheKey);
  const now = Date.now();
  if (cached && now - cached.at < FAVICON_TTL_MS) {
    return new Response(cached.bytes, {
      headers: faviconHeaders(cached.type, cors),
    });
  }
  const found = await resolveFavicon(origin);
  if (!found) {
    return new Response(JSON.stringify({ error: "no favicon" }), {
      status: 404,
      headers: { "Content-Type": "application/json", ...cors },
    });
  }
  faviconCache.set(cacheKey, { at: now, bytes: found.bytes, type: found.type });
  return new Response(found.bytes, {
    headers: faviconHeaders(found.type, cors),
  });
}

function faviconHeaders(
  type: string,
  cors: Record<string, string>,
): Record<string, string> {
  return {
    "Content-Type": type,
    // Let the browser cache aggressively — favicons don't change often
    // and the daemon's own in-memory cache covers SSE-driven re-renders
    // within the daemon's lifetime.
    "Cache-Control": "public, max-age=86400",
    ...cors,
  };
}

/** Try the canonical `/favicon.ico` first, then parse the origin's HTML
 *  for `<link rel="icon">` / `apple-touch-icon` and follow the first
 *  one we find. Returns null when none of the candidates resolves to a
 *  reasonably-sized image response. */
async function resolveFavicon(
  origin: URL,
): Promise<{ bytes: Uint8Array; type: string } | null> {
  const candidates: string[] = [`${origin.origin}/favicon.ico`];
  try {
    const html = await fetchText(origin.toString());
    if (html) {
      for (const href of extractIconHrefs(html)) {
        try {
          candidates.push(new URL(href, origin.toString()).toString());
        } catch {
          // bad href in <link> tag — skip
        }
      }
    }
  } catch {
    // origin unreachable / non-HTML — fall through to /favicon.ico only
  }
  for (const candidate of candidates) {
    const result = await fetchImage(candidate);
    if (result) return result;
  }
  return null;
}

async function fetchText(target: string): Promise<string | null> {
  try {
    const res = await fetch(target, {
      method: "GET",
      headers: { Accept: "text/html,*/*;q=0.5" },
      redirect: "follow",
      signal: AbortSignal.timeout(4000),
    });
    if (!res.ok) return null;
    const ct = res.headers.get("Content-Type") ?? "";
    if (!/text\/html|application\/xhtml/i.test(ct)) return null;
    return await res.text();
  } catch {
    return null;
  }
}

async function fetchImage(
  target: string,
): Promise<{ bytes: Uint8Array; type: string } | null> {
  try {
    const res = await fetch(target, {
      method: "GET",
      headers: { Accept: "image/*" },
      redirect: "follow",
      signal: AbortSignal.timeout(4000),
    });
    if (!res.ok) return null;
    const ct = res.headers.get("Content-Type") ?? "application/octet-stream";
    if (!/^image\//i.test(ct) && !/icon/i.test(ct)) return null;
    const buf = await res.arrayBuffer();
    if (buf.byteLength === 0) return null;
    if (buf.byteLength > FAVICON_MAX_BYTES) return null;
    return { bytes: new Uint8Array(buf), type: ct };
  } catch {
    return null;
  }
}

/** Try `startAt` first, then `fallback`; return whichever exists (file
 *  or directory) so the picker can open in it. Picker.ts also stat()s
 *  but having the choice happen here lets us prefer the more
 *  specific hint over the broader fallback in one place. */
async function pickStartCandidate(
  startAt?: string,
  fallback?: string,
): Promise<string | undefined> {
  for (const cand of [startAt, fallback]) {
    if (!cand) continue;
    try {
      await fsStat(cand);
      return cand;
    } catch {
      // not present; try the next candidate
    }
  }
  return undefined;
}

/**
 * Best-effort `<title>` extractor for a remote URL. Used by the
 * custom-link "auto-fetch label" path so the chip can show something
 * better than the bare host when the user didn't pick a label. Same
 * 4s timeout + HTML-only content-type guard the favicon proxy uses;
 * returns null on any failure so the caller falls back to the host
 * name. Cached in-memory for the daemon's lifetime so repeated calls
 * during a session don't re-hit the origin.
 */
const PAGE_TITLE_TTL_MS = 24 * 60 * 60 * 1000;
const pageTitleCache = new Map<string, { at: number; title: string | null }>();

async function fetchPageTitle(target: string): Promise<string | null> {
  const cached = pageTitleCache.get(target);
  const now = Date.now();
  if (cached && now - cached.at < PAGE_TITLE_TTL_MS) return cached.title;
  let html: string | null = null;
  try {
    html = await fetchText(target);
  } catch {
    html = null;
  }
  let title: string | null = null;
  if (html) {
    const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    if (match?.[1]) {
      title = decodeHtmlEntities(match[1].trim());
      if (title.length === 0) title = null;
    }
  }
  pageTitleCache.set(target, { at: now, title });
  return title;
}

// FS watcher registry. One watcher per worktree path; events from the
// watcher debounce to a single broadcast("change", ...) so the UI
// re-fetches /api/repos and the affected row refreshes its status +
// open diffs. Watcher ignores node_modules/ and .git/ — see
// worktree-watcher.ts. Reconciled at startup and after any route that
// adds/removes a repo or worktree.
const worktreeWatchers = new Map<string, () => void>();

async function reconcileWorktreeWatchers(): Promise<void> {
  const repos = await workspace.listRepos();
  const wanted = new Set<string>();
  for (const repo of repos) {
    try {
      const wts = await listWorktrees(repo.path);
      for (const wt of wts) wanted.add(wt.path);
    } catch {
      // repo dir gone — skip silently; the next mutation will clean
      // it from the workspace anyway.
    }
  }
  // Stop watchers for paths no longer in the workspace.
  for (const [path, stop] of worktreeWatchers) {
    if (!wanted.has(path)) {
      stop();
      worktreeWatchers.delete(path);
    }
  }
  // Start watchers for new paths.
  for (const path of wanted) {
    if (worktreeWatchers.has(path)) continue;
    const stop = watchWorktree(path, () => {
      void onWorktreeFsChange(path);
    });
    worktreeWatchers.set(path, stop);
  }
}

async function recordServerError(
  req: Request,
  status: number,
  err: unknown,
): Promise<void> {
  const url = new URL(req.url);
  const entry = await errors.append({
    kind: "server",
    source: "daemon",
    route: url.pathname,
    method: req.method,
    status,
    message: err instanceof Error ? err.message : String(err),
    stack: err instanceof Error ? err.stack : undefined,
  });
  broadcast("error", entry);
}

// Per-terminal grace timers. When the last WS subscriber detaches we
// don't kill the PTY immediately — we wait `GRACE_MS` so a page reload
// can reconnect without losing the agent. Closing the panel for real
// just lets the timer fire and the PTY dies cleanly.
//
// 60s instead of 3s: with the Terminal-column reattach flow (GET
// /api/shells on mount, then attach via WS), the round-trip from
// "reload pressed" to "WS open frame" is dominated by browser cache
// behaviour and the SPA's JS evaluation — easily 5–10s on a cold
// devtools-disabled reload. 3s killed every shell before the new tab
// could attach. 60s is generous; a column the user actually closed
// will linger for that long but cost nothing.
const GRACE_MS = 60_000;
const graceTimers = new Map<string, ReturnType<typeof setTimeout>>();

// Per-shell live cwd cache. We sample `lsof -p <pid> -d cwd` every
// SHELL_CWD_INTERVAL_MS and remember the latest path so GET /api/shells
// can surface where the user has `cd`-ed to. In-memory only — a daemon
// restart kills the helper which kills every PTY, so there's nothing
// to persist across restarts. Map key is termId, not pid, so the
// /api/shells lookup is a direct hit.
//
// Hoisted above `Bun.serve(...)` (rather than next to its sampler at
// the bottom of the file) because route handlers close over it and
// requests landing during module init would otherwise hit a TDZ
// `ReferenceError: Cannot access 'shellCwds' before initialization`.
const SHELL_CWD_INTERVAL_MS = 5_000;
const shellCwds = new Map<string, string>();
/** Termids of currently-live shell PTYs. Used as an O(1) gate in the
 *  hot WS keystroke path before we do any line-buffer work. Same TDZ
 *  hoist reason as shellCwds. */
const shellTermIds = new Set<string>();

function cancelGrace(termId: string) {
  const t = graceTimers.get(termId);
  if (!t) return;
  clearTimeout(t);
  graceTimers.delete(termId);
}

function startGraceIfIdle(termId: string) {
  const handle = terminalBackend.get(termId);
  if (!handle) return;
  if (handle.subscriberCount() > 0) return;
  // Never grace-reap a live agent while the app is still open. A column
  // scrolled off-screen (or a reload) drops its terminal WS, but the app's SSE
  // stream keeps a frontend connected — so the PTY must survive and the column
  // cleanly reattaches on reveal. Cleanup is left to OrphanCleaner (fires only
  // when NO frontend is connected at all) and explicit dispose (DELETE
  // /api/terminals/:id). Without this gate, scrolling a working agent away
  // reaped its PTY after GRACE_MS and the session died offscreen.
  if (orphanCleaner.isFrontendConnected()) return;
  if (graceTimers.has(termId)) return;
  console.log(
    `supergit daemon: terminal grace scheduled id=${termId} pid=${handle.pid} delay=${GRACE_MS}ms`,
  );
  const timer = setTimeout(() => {
    graceTimers.delete(termId);
    const h = terminalBackend.get(termId);
    if (!h) return;
    if (h.subscriberCount() === 0 && h.isAlive()) {
      console.log(
        `supergit daemon: terminal grace reap id=${termId} pid=${h.pid}`,
      );
      void h.kill();
    }
  }, GRACE_MS);
  graceTimers.set(termId, timer);
}

// A connected WebSocket is one of two kinds:
//  - "terminal": a local PTY's live I/O (the original, only WS in the app)
//  - "proxy":    a REMOTE daemon's terminal, bridged over the ssh tunnel
//                (Phase 4b). The bridge is created in open() once we have
//                the ServerWebSocket to use as the browser-facing peer.
type TermWsData =
  | {
      kind: "terminal";
      termId: string;
      unsubscribe: (() => void) | null;
      outputVisible: boolean;
      outputDrainable: boolean;
      pendingOutput: Uint8Array[];
      pendingOutputBytes: number;
      outputBackpressured: boolean;
    }
  // Proxy WS to a remote daemon. We can't resolve the tunnel before
  // upgrading — Bun requires srv.upgrade() to run SYNCHRONOUSLY in the
  // fetch handler, before any await (an await detaches the request context
  // and the upgrade silently fails → the browser WS hangs "connecting…"
  // forever). So we stash the daemonId + path here and do the async
  // tunnel-open + bridge wiring inside the websocket open() handler.
  | {
      kind: "proxy";
      daemonId: string;
      rest: string;
      search: string;
      bridge: RemoteWsBridge | null;
    };

// If WebKit stops draining a terminal websocket, Bun will report
// backpressure from ws.send(). Before this guard we kept sending every PTY
// chunk anyway, so macOS showed multi-megabyte supergit->WebKit TCP send
// queues and later UI actions looked like they arrived minutes late.
//
// The backlog doubles as the non-drainable-socket buffer: output is queued here
// only when the browser says it cannot currently drain terminal bytes (for
// example a backgrounded / suspended WebKit window). When every socket for a
// terminal is non-drainable, helper-side pause is the pressure-relief valve; it
// blocks fresh output upstream instead of letting this queue grow forever.
//
// Hidden backlogs are byte-exact because terminal streams are stateful: cutting
// out older cursor / SGR sequences and later replaying the tail corrupts the
// xterm screen. The memory bound for the normal suspended-window case comes
// from helper-side output pause when no browser socket can drain bytes. The
// drainable path still has a hard cap as an OOM guard for sockets the browser
// reports drainable but that still stop consuming frames.

function queueTerminalOutput(
  ws: ServerWebSocket<TermWsData>,
  chunk: Uint8Array,
) {
  if (ws.data.kind !== "terminal") return;
  ws.data.pendingOutput.push(chunk);
  ws.data.pendingOutputBytes += chunk.byteLength;
  // Drainable-socket OOM guard: non-drainable sockets keep every queued byte,
  // while helper-side pause prevents that suspended-window queue from growing
  // indefinitely.
  ws.data.pendingOutputBytes = trimTerminalBacklog(
    ws.data.pendingOutput,
    ws.data.pendingOutputBytes,
    ws.data.outputDrainable,
  );
}

function sendTerminalIoObserved(
  ws: ServerWebSocket<TermWsData>,
  bytes: number,
): void {
  if (ws.data.kind !== "terminal" || bytes <= 0) return;
  try {
    ws.send(JSON.stringify({ type: "io", rxBytes: bytes }));
  } catch {
    // Socket may be closing; the buffered PTY bytes remain authoritative.
  }
}

function takeTerminalOutputBacklog(
  ws: ServerWebSocket<TermWsData>,
): Uint8Array | null {
  if (ws.data.kind !== "terminal") return null;
  if (ws.data.pendingOutput.length === 0) return null;
  const out = new Uint8Array(ws.data.pendingOutputBytes);
  let offset = 0;
  for (const chunk of ws.data.pendingOutput) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  ws.data.pendingOutput = [];
  ws.data.pendingOutputBytes = 0;
  return out;
}

function flushTerminalOutput(ws: ServerWebSocket<TermWsData>): void {
  const backlog = takeTerminalOutputBacklog(ws);
  if (!backlog || backlog.byteLength === 0) {
    if (ws.data.kind === "terminal") ws.data.outputBackpressured = false;
    return;
  }
  const status = ws.send(backlog);
  // -1 means Bun accepted the frame but the socket is still under
  // backpressure. New PTY chunks will accumulate in pendingOutput until the
  // next drain; don't requeue this frame or it would duplicate output. 0 means
  // Bun could not accept the frame (typically a closing/dead socket), so there
  // is no reliable future drain to wait for.
  if (ws.data.kind === "terminal") {
    ws.data.outputBackpressured = status === -1;
    if (status === 0) {
      ws.data.pendingOutput = [];
      ws.data.pendingOutputBytes = 0;
      try {
        ws.close(1013, "terminal websocket unavailable");
      } catch {
        // Already closing.
      }
    }
  }
}

function sendTerminalOutput(
  ws: ServerWebSocket<TermWsData>,
  chunk: Uint8Array,
): void {
  if (ws.data.kind !== "terminal") return;
  if (ws.data.outputBackpressured || ws.data.pendingOutput.length > 0) {
    queueTerminalOutput(ws, chunk);
    return;
  }
  const status = ws.send(chunk);
  if (status === -1) {
    // The current frame is already queued inside Bun. Buffer subsequent PTY
    // frames ourselves so OS/WebKit queues cannot grow without bound.
    ws.data.outputBackpressured = true;
    return;
  }
  if (status === 0) {
    // No backpressure callback is guaranteed after an unaccepted frame. Close
    // this browser socket and let the terminal grace/replay path handle
    // reattach instead of holding bytes that may never flush.
    try {
      ws.close(1013, "terminal websocket unavailable");
    } catch {
      // Already closing.
    }
  }
}

const visibleTerminalSockets = new Map<string, number>();
const drainableTerminalSockets = new Map<string, number>();
const terminalSpawnPendingWs = new Map<string, number>();
const terminalSpawnFinishedAt = new Map<string, number>();
const terminalWsOpenedAt = new Map<string, number>();
const TERMINAL_SPAWN_SLOW_MS = 1_000;

function addCount(map: Map<string, number>, termId: string): void {
  map.set(termId, (map.get(termId) ?? 0) + 1);
}

function removeCount(map: Map<string, number>, termId: string): void {
  const next = (map.get(termId) ?? 0) - 1;
  if (next > 0) map.set(termId, next);
  else map.delete(termId);
}

function updateTerminalOutputMute(termId: string): void {
  const handle = terminalBackend.get(termId);
  handle?.setOutputMuted?.((drainableTerminalSockets.get(termId) ?? 0) === 0);
}

function setTerminalOutputVisible(
  ws: ServerWebSocket<TermWsData>,
  visible: boolean,
  drainable: boolean = visible,
): void {
  if (ws.data.kind !== "terminal") return;
  const wasVisible = ws.data.outputVisible;
  const wasDrainable = ws.data.outputDrainable;
  if (wasVisible === visible && wasDrainable === drainable) return;
  ws.data.outputVisible = visible;
  ws.data.outputDrainable = drainable;
  if (visible && !wasVisible) addCount(visibleTerminalSockets, ws.data.termId);
  else if (!visible && wasVisible)
    removeCount(visibleTerminalSockets, ws.data.termId);
  if (drainable && !wasDrainable)
    addCount(drainableTerminalSockets, ws.data.termId);
  else if (!drainable && wasDrainable)
    removeCount(drainableTerminalSockets, ws.data.termId);
  if (drainable) {
    // Drain whatever buffered while this socket was hidden — same bytes, in
    // order, just delayed. No clear/repaint, so no risk of duplicated or
    // corrupted scrollback.
    flushTerminalOutput(ws);
  }
  updateTerminalOutputMute(ws.data.termId);
}

const server = Bun.serve<TermWsData, never>({
  port: PORT,
  // Network interface to listen on. Defaults to all interfaces (0.0.0.0)
  // so other machines on the LAN can reach the daemon for session sharing
  // (see plans/PLAN-SESSION-SHARE.md); override with SUPERGIT_BIND=127.0.0.1
  // for a loopback-only / tunnel-fronted deployment (see the BIND comment
  // near the PORT definition and plans/PLAN-REMOTE-DAEMON.md). We set it
  // explicitly so a future Bun default change can't silently flip us.
  hostname: BIND,
  // Bun's default maxRequestBodySize is too low for session-share
  // offers — a stripped Claude JSONL wrapped in JSON easily exceeds
  // it for longer sessions (2-5 MB is common, 20+ MB for marathon
  // sessions). Without this the receiver returns 413 before our
  // route handler ever sees the request, so no toast fires and the
  // sender gets an opaque "peer rejected offer (413)" error.
  // 50 MB matches MAX_OFFER_BYTES from session-share.ts.
  maxRequestBodySize: 50 * 1024 * 1024,
  // Bun's default per-request idle timeout is 10s. Some of our routes —
  // /api/diff on a large changeset, /api/session priming the cache on a
  // 100 MB+ JSONL, /api/fetch over a slow network — can legitimately
  // exceed that. When the timeout fires we observed `Bun.serve` (1.3.x)
  // leaving the listener in a broken state where new connections were
  // accepted-but-never-answered (`[Bun.serve]: request timed out…`
  // followed by silent listener death). 30s gives every legitimate
  // operation room and effectively eliminates the wedge in practice.
  idleTimeout: 30,
  // Top-level escape hatch. The fetch handler wraps its body in a
  // try/catch and returns 500 on a thrown error — but if a handler
  // ever returns `undefined` (a missing `return`), or if Bun.serve
  // itself throws synchronously, this is the only place we hear about
  // it. Logged + persisted so the Events popover surfaces it.
  error(err: Error) {
    console.error(`supergit daemon: Bun.serve error: ${err.stack ?? err}`);
    void errors
      .append({
        kind: "server",
        source: "daemon",
        status: 500,
        message: err?.message ?? String(err),
        stack: err?.stack,
      })
      .then((entry) => broadcast("error", entry))
      .catch(() => {});
    return new Response(
      JSON.stringify({ error: err?.message ?? "internal error" }),
      { status: 500, headers: { "Content-Type": "application/json" } },
    );
  },
  async fetch(req, srv) {
    const url = new URL(req.url);
    const CORS = corsHeaders(req);
    // Per-route request counter for the rolling rate log below. Bucket
    // by URL.pathname (verb-agnostic — same path different methods are
    // rare enough that the noise isn't worth the extra cardinality).
    requestCounts.set(url.pathname, (requestCounts.get(url.pathname) ?? 0) + 1);

    const json = (body: unknown, init: ResponseInit = {}): Response =>
      new Response(JSON.stringify(body), {
        ...init,
        headers: {
          "Content-Type": "application/json",
          ...CORS,
          ...(init.headers ?? {}),
        },
      });

    try {
      if (req.method === "OPTIONS") {
        return new Response(null, { headers: CORS });
      }

      // Anti DNS-rebinding: reject any request whose Host header isn't one
      // of ours, before any route runs. A rebinding page arrives with its
      // own domain in Host even though its source IP looks like loopback.
      if (!isAllowedHost(req.headers.get("Host"))) {
        return json({ error: "host not allowed" }, { status: 403 });
      }

      // Network authorization gate. Loopback requests get the full API.
      // Remote (LAN) requests are tightly restricted:
      //   - peer mode off -> rejected outright (user hasn't opted in).
      //   - peer mode on  -> only the session-share / peer receiver routes
      //     in LAN_ALLOWED_ROUTES are reachable. The local control plane
      //     (terminal spawn, command/run, open, file read/write, diff, the
      //     SPA, ...) stays loopback-only ALWAYS, so enabling sharing can
      //     never expose RCE or arbitrary file access to other machines.
      {
        const addr = srv.requestIP(req)?.address;
        const remote = addr ? !isLoopback(addr) : false;
        if (remote) {
          if (!peerModeEnabled) {
            return json({ error: "peer mode is off" }, { status: 403 });
          }
          if (!LAN_ALLOWED_ROUTES.has(`${req.method} ${url.pathname}`)) {
            return json(
              { error: "route not available over the network" },
              { status: 403 },
            );
          }
        }
      }

      if (READONLY_MODE) {
        const decision = readonlyRouteDecision(req.method, url.pathname);
        if (!decision.allowed) {
          return json(
            {
              error: "daemon is running in read-only mode",
              readonly: true,
              reason: decision.reason,
            },
            { status: 423 },
          );
        }
      }

      // WebSocket upgrade for terminal I/O — /api/terminals/:id/io.
      // CORS does not apply to WS handshakes, but we still validate the
      // termId exists in our manager before upgrading.
      {
        const m = url.pathname.match(/^\/api\/terminals\/([^/]+)\/io$/);
        if (m) {
          const termId = m[1]!;
          if (!terminalBackend.get(termId)) {
            return json({ error: "terminal not found" }, { status: 404 });
          }
          if (
            srv.upgrade(req, {
              data: {
                kind: "terminal",
                termId,
                unsubscribe: null,
                outputVisible: true,
                outputDrainable: true,
                pendingOutput: [],
                pendingOutputBytes: 0,
                outputBackpressured: false,
              },
            })
          ) {
            return undefined as unknown as Response;
          }
          return json({ error: "upgrade failed" }, { status: 500 });
        }
      }

      // WebSocket upgrade for a REMOTE daemon's terminal I/O —
      // /api/daemons/<id>/terminals/<t>/io. Bridged over the ssh tunnel to
      // the remote daemon's own terminal WS on its loopback, so the remote
      // socket is never exposed (same trust path as the HTTP proxy). This
      // sits after the LAN gate above, so it's loopback-only. See
      // daemon-ws-proxy.ts and plans/PLAN-REMOTE-DAEMON.md.
      {
        const m = url.pathname.match(
          /^\/api\/daemons\/([^/]+)\/(terminals\/[^/]+\/io)$/,
        );
        if (m) {
          const daemonId = m[1]!;
          // MUST upgrade synchronously — do NOT await the tunnel here (see
          // the TermWsData comment). The tunnel is opened + the bridge
          // wired inside open() below; browser frames that arrive before
          // the remote socket is ready are buffered by RemoteWsBridge.
          if (
            srv.upgrade(req, {
              data: {
                kind: "proxy",
                daemonId,
                rest: `/${m[2]!}`,
                search: url.search,
                bridge: null,
              },
            })
          ) {
            return undefined as unknown as Response;
          }
          return json({ error: "upgrade failed" }, { status: 500 });
        }
      }

      if (url.pathname === "/api/health") {
        // `totalMemBytes` lets the UI scale TUI-hot/warm thresholds to a
        // fraction of the user's RAM instead of a hardcoded MB number —
        // a 16 GB MacBook and a 96 GB Linux workstation shouldn't trip
        // the same alert. Static for the lifetime of the daemon, so the
        // UI caches it after the first /api/health response.
        //
        // `localIp` + `port` give the dashboard the URL teammates on the
        // LAN should hit when accepting a session-share invite, so the
        // tagline can show it inline without the user having to grep
        // ifconfig.
        return json({
          status: "ok",
          workspace: WORKSPACE_PATH,
          temporaryWorkspace: TEMP_WORKSPACE_MODE,
          sourceWorkspace: TEMP_WORKSPACE_SOURCE,
          totalMemBytes: totalmem(),
          localIp: findLocalIp(),
          port: PORT,
          buildTime: DAEMON_BUILD_TIME,
          version: "0.1.0",
          readonly: READONLY_MODE,
        });
      }

      if (url.pathname === "/api/diagnose" && req.method === "GET") {
        const sshPath = Bun.which("ssh");
        const remotes = await workspace.listRemoteDaemons();
        const daemonInputs = remotes.map((d) => {
          const t = tunnelManager.get(d.id);
          return {
            id: d.id,
            label: d.label,
            host: d.host,
            port: d.port,
            tunnelOpen: !!t,
            localPort: t?.localPort ?? null,
          };
        });
        // role: a daemon reached via the proxy is being diagnosed AS a remote;
        // detect that the same way other proxied routes do. Simplest robust
        // signal: if this request came in through /api/daemons/<id>/diagnose it
        // was rewritten before reaching here, so a plain /api/diagnose with NO
        // registered remotes on a loopback-bound box is "remote". Use:
        //   role = remotes.length === 0 && isLoopback(BIND) ? "remote" : "local"
        // (good enough; the report body is identical either way.)
        const role =
          remotes.length === 0 && isLoopback(BIND) ? "remote" : "local";
        const report = await buildDiagnostics({
          self: {
            bind: BIND,
            port: PORT,
            workspace: WORKSPACE_PATH,
            version: "0.1.0",
            loopbackOnly: isLoopback(BIND),
            peerModeEnabled,
            sshPath: sshPath ?? null,
          },
          role,
          daemons: daemonInputs,
          probe: (localPort) => healthProbe(localPort),
        });
        return json(report);
      }

      // The user's default login shell with platform-appropriate flags.
      // The frontend hits this once on mount so the "Terminal" entry in
      // the new-session picker can spawn the right shell without
      // hardcoding bash/zsh/powershell flags per platform.
      if (url.pathname === "/api/shell-default") {
        return json(defaultLoginShell());
      }

      // Every interactive shell this box can spawn for a plain terminal
      // column. On Windows that's PowerShell + CMD as separate picker
      // entries; on POSIX a single login shell. Daemon-routed, so a remote
      // row's picker lists the REMOTE box's shells (a Windows box reached
      // over SSH offers PowerShell, whose history works where cmd's doesn't).
      if (url.pathname === "/api/shells/available") {
        return json({ shells: availableShells() });
      }

      // Diagnostics: snapshot of the /api/session cache. Shows entries,
      // bounds, per-entry sizes, total bytes held. Used to find out where
      // heapUsed is actually going when the totals don't match the cache cap.
      if (url.pathname === "/api/debug/session-cache") {
        return json(sessionCacheStats());
      }

      // Diagnostics: process.memoryUsage() + an optional forced sync GC.
      // When ?gc=1 we run a full GC first and report the after-GC numbers so
      // you can tell V8-reserved-but-unused pages apart from a true working
      // set. Bounded, no side effects beyond GC pressure.
      if (url.pathname === "/api/debug/mem") {
        const force = url.searchParams.get("gc") === "1";
        const before = process.memoryUsage();
        let gcMs = 0;
        if (force) {
          const t = performance.now();
          Bun.gc(true);
          gcMs = performance.now() - t;
        }
        const after = process.memoryUsage();
        return json({
          pid: process.pid,
          uptimeSec: process.uptime(),
          gcRanMs: force ? gcMs : null,
          before,
          after,
        });
      }

      // Diagnostics: rolling latency percentiles for instrumented hot paths.
      // Returns the current snapshot from timings.ts: each named span has
      // { count, p50, p95, max, last } — all in milliseconds.
      if (url.pathname === "/api/debug/timings") {
        return json(timingsSnapshot());
      }

      if (url.pathname === "/api/debug/analyze" && req.method === "GET") {
        const startedAt = performance.now();
        const probe = async <T>(
          path: string,
          run: () => T | Promise<T>,
        ): Promise<
          | { path: string; ok: true; ms: number; value: T }
          | { path: string; ok: false; ms: number; error: string }
        > => {
          const t = performance.now();
          try {
            return {
              path,
              ok: true,
              ms: Math.round(performance.now() - t),
              value: await run(),
            };
          } catch (err) {
            return {
              path,
              ok: false,
              ms: Math.round(performance.now() - t),
              error: err instanceof Error ? err.message : String(err),
            };
          }
        };
        const terminalRecords = terminalBackend.list();
        const eventProbe = await probe("/api/events", async () => {
          const all = await events.list();
          return {
            count: all.length,
            recent: all
              .slice(-10)
              .reverse()
              .map((ev) => ({
                id: ev.id,
                type: ev.type,
                actor: ev.actor,
                timestamp: ev.timestamp,
                reversible: ev.reversible,
                undone: ev.undone,
              })),
          };
        });
        const errorProbe = await probe("/api/errors", async () => {
          const all = await errors.list();
          return {
            count: all.length,
            recent: all.slice(0, 10).map((entry) => ({
              id: entry.id,
              timestamp: entry.timestamp,
              kind: entry.kind,
              source: entry.source,
              method: entry.method,
              route: entry.route,
              status: entry.status,
              message: entry.message,
              count: (entry as { count?: number }).count,
              extra: entry.extra,
            })),
          };
        });
        const timingsProbe = await probe("/api/debug/timings", () =>
          timingsSnapshot(),
        );
        const memProbe = await probe("/api/debug/mem", () => ({
          pid: process.pid,
          uptimeSec: process.uptime(),
          memoryUsage: process.memoryUsage(),
        }));
        const terminalsProbe = await probe("/api/terminals", () => {
          const alive = terminalRecords.filter((t) => !t.exitedAt);
          return {
            total: terminalRecords.length,
            alive: alive.length,
            exited: terminalRecords.length - alive.length,
            visible: alive.filter(
              (t) => (visibleTerminalSockets.get(t.id) ?? 0) > 0,
            ).length,
            pendingWs: terminalSpawnPendingWs.size,
            byAgent: alive.reduce<Record<string, number>>((acc, t) => {
              const key = t.agent ?? "shell";
              acc[key] = (acc[key] ?? 0) + 1;
              return acc;
            }, {}),
            recent: alive.slice(-10).map((t) => ({
              id: t.id,
              pid: t.pid,
              agent: t.agent,
              cwd: t.cwd,
              cmd: t.cmd,
              createdAt: t.createdAt,
              lastOutputAt: t.lastOutputAt,
              visibleCount: visibleTerminalSockets.get(t.id) ?? 0,
            })),
          };
        });
        const requestRate = summarizeRequestCounts(requestCounts.entries(), {
          windowStartedAt: requestWindowStartedAt,
          now: Date.now(),
          windowMs: REQUEST_RATE_INTERVAL_MS,
        });
        const totalMs = Math.round(performance.now() - startedAt);
        record("debug-analyze", totalMs);
        const includeInstance = url.searchParams.get("instance") === "1";
        const report = {
          generatedAt: new Date().toISOString(),
          durationMs: totalMs,
          workspace: WORKSPACE_PATH,
          ...(includeInstance
            ? {
                instance: debugAnalyzeInstance({
                  workspace: WORKSPACE_PATH,
                  port: PORT,
                  temporaryWorkspace: TEMP_WORKSPACE_MODE,
                  sourceWorkspace: TEMP_WORKSPACE_SOURCE,
                  readonly: READONLY_MODE,
                }),
              }
            : {}),
          pid: process.pid,
          requestRate,
          probes: {
            events: eventProbe,
            errors: errorProbe,
            timings: timingsProbe,
            memory: memProbe,
            terminals: terminalsProbe,
          },
        };
        console.log(`supergit daemon: debug analyze ${JSON.stringify(report)}`);
        return json(report);
      }

      if (url.pathname === "/api/shutdown" && req.method === "POST") {
        console.log("supergit daemon: /api/shutdown requested");
        setTimeout(() => shutdown("/api/shutdown"), 50);
        return json({ ok: true, pid: process.pid });
      }

      // Rebuild the prod SPA (packages/ui/dist) from the current source —
      // the "redeploy dev → local prod" button. The prod daemon serves
      // that dir fresh from disk, so this is a full UI redeploy with no
      // daemon restart and no killed PTYs; the user just reloads their
      // prod tab. Ships UI changes only, not daemon-code changes.
      if (url.pathname === "/api/deploy" && req.method === "POST") {
        console.log("supergit daemon: /api/deploy (rebuild prod SPA) requested");
        const result = await runDeploy(resolve(import.meta.dir, "../../.."));
        console.log(
          `supergit daemon: deploy ${result.ok ? "ok" : "FAILED"} (exit ${result.code}) in ${result.durationMs}ms`,
        );
        return json(result, { status: result.ok ? 200 : 500 });
      }

      // Diagnostics: env snapshot of a spawned PTY. ?id=<termId> picks a
      // specific terminal; omitted = a list of every alive PTY with its
      // snapshot. Used to verify what env the helper actually handed to
      // the shell — primary use case is confirming whether the
      // SHELL_SESSIONS_DISABLE / TERM_PROGRAM / TERM_SESSION_ID combo
      // matches what we expect after a helper restart.
      if (url.pathname === "/api/debug/pty-env") {
        const id = url.searchParams.get("id");
        if (id) {
          const env = terminalBackend.getEnvSnapshot(id);
          if (!env)
            return json(
              { error: `unknown or pre-helper-restart termId: ${id}` },
              { status: 404 },
            );
          const rec = terminalBackend.list().find((t) => t.id === id);
          return json({ id, cmd: rec?.cmd, env });
        }
        const all = terminalBackend.list().map((t) => ({
          id: t.id,
          cmd: t.cmd,
          pid: t.pid,
          agent: t.agent,
          env: terminalBackend.getEnvSnapshot(t.id) ?? null,
        }));
        return json({ count: all.length, terminals: all });
      }

      if (url.pathname === "/api/attach" && req.method === "POST") {
        const attachStartedAt = performance.now();
        // Browser-side TerminalView posts a multipart form here when the
        // user pastes an image or drops a file onto an xterm column. We
        // write the bytes under `<workspace>/attachments/` and return the
        // absolute path so the client can write it into the PTY's stdin —
        // exactly the dance the VSCode terminal-image-paste extensions
        // do, with the upload going through the daemon instead of an
        // extension host. The agent then sees the path on its input line
        // and can attach it like any other file reference.
        //
        // The destination is daemon-owned (one folder per workspace);
        // callers can't influence where bytes land, so no worktree-path
        // validation needed.
        const form = await req.formData().catch(() => null);
        const formParsedAt = performance.now();
        if (!form) {
          return json(
            { error: "multipart/form-data body required" },
            {
              status: 400,
            },
          );
        }
        const file = form.get("file");
        if (!(file instanceof File)) {
          return json({ error: "file (Blob) is required" }, { status: 400 });
        }
        const bytes = new Uint8Array(await file.arrayBuffer());
        const bytesReadAt = performance.now();
        const filename =
          file.name && file.name !== "blob" ? file.name : undefined;
        const mimeType = file.type || undefined;
        const pasteDebugId = stringFormValue(form.get("pasteDebugId"));
        const pasteTermId = stringFormValue(form.get("termId"));
        const pasteSource = stringFormValue(form.get("source"));
        const clientAttachFields = [
          ["clientSource", form.get("clientSource")],
          ["clientInputBytes", form.get("clientInputBytes")],
          ["clientOutputBytes", form.get("clientOutputBytes")],
          ["clientInputType", form.get("clientInputType")],
          ["clientOutputType", form.get("clientOutputType")],
          ["clientReadMs", form.get("clientReadMs")],
          ["clientBlobMs", form.get("clientBlobMs")],
          ["clientShrinkMs", form.get("clientShrinkMs")],
          ["clientAlphaMs", form.get("clientAlphaMs")],
          ["clientBeforeUploadMs", form.get("clientBeforeUploadMs")],
        ] as const;
        const clientAttachDetails = clientAttachFields
          .map(([key, value]) => pasteLogPart(key, stringFormValue(value)))
          .join("");
        const result = await saveAttachment(
          join(WORKSPACE_PATH, "attachments"),
          bytes,
          { filename, mimeType },
        );
        const savedAt = performance.now();
        if (
          pasteDebugId ||
          pasteSource === "terminal-image-paste" ||
          pasteSource === "codex-visual-image-paste"
        ) {
          console.log(
            `supergit daemon: paste-debug id=${pasteDebugId ?? "unknown"} phase=attach-saved term=${pasteTermId ?? "unknown"} source=${pasteSource ?? "unknown"} size=${bytes.byteLength} mime=${mimeType ?? "unknown"} file=${basename(result.path)} formMs=${Math.round(formParsedAt - attachStartedAt)} readMs=${Math.round(bytesReadAt - formParsedAt)} saveMs=${Math.round(savedAt - bytesReadAt)} totalMs=${Math.round(savedAt - attachStartedAt)}${clientAttachDetails}`,
          );
        }
        return json(result, { status: 201 });
      }

      if (url.pathname === "/api/image" && req.method === "GET") {
        // Serve a local image file referenced from a Claude session message
        // (e.g. "[Image: source: /var/folders/.../shot.png]"). The validation
        // + lookup lives in serveImage() so it's unit-testable.
        const max = url.searchParams.get("max");
        const result = await serveImage(url.searchParams.get("path"), {
          maxSide: max === null ? undefined : Number(max),
        });
        if (result.status !== 200) {
          return json({ error: result.error }, { status: result.status });
        }
        return new Response("bytes" in result ? result.bytes : result.file, {
          headers: {
            ...CORS,
            ...(result.status === 200 && "mimeType" in result
              ? { "Content-Type": result.mimeType }
              : {}),
            "Cache-Control": "public, max-age=300",
          },
        });
      }

      if (url.pathname === "/api/attachment" && req.method === "GET") {
        const result = await serveAttachment(
          join(WORKSPACE_PATH, "attachments"),
          url.searchParams.get("path"),
        );
        if (result.status !== 200) {
          return json({ error: result.error }, { status: result.status });
        }
        return new Response(result.file, {
          headers: {
            ...CORS,
            "Cache-Control": "private, max-age=60",
          },
        });
      }

      if (url.pathname === "/api/session/media" && req.method === "GET") {
        const source = url.searchParams.get("source");
        if (!source) {
          return json(
            { error: "?source=<session-file> required" },
            { status: 400 },
          );
        }
        const resolved = resolveSessionAgent(source);
        if (!resolved) {
          return json(
            { error: "source is outside any known agent root" },
            { status: 403 },
          );
        }
        const result = await readSessionInlineMedia(
          resolved.normalised,
          url.searchParams.get("hash"),
          url.searchParams.has("max")
            ? { maxSide: Number(url.searchParams.get("max")) }
            : undefined,
        );
        if (result.status !== 200) {
          return json({ error: result.error }, { status: result.status });
        }
        return new Response(result.bytes, {
          headers: {
            ...CORS,
            "Content-Type": result.mimeType,
            "Cache-Control": "private, max-age=300",
          },
        });
      }

      if (url.pathname === "/api" || url.pathname === "/api/") {
        return json({
          name: "supergit",
          version: "0.0.0",
          workspace: WORKSPACE_PATH,
          endpoints: [
            {
              method: "GET",
              path: "/api",
              description: "this index (agent-discoverable route list)",
            },
            {
              method: "GET",
              path: "/api/health",
              description: "liveness + workspace path",
            },
            {
              method: "GET",
              path: "/api/shell-default",
              description:
                "the user's default login shell ($SHELL, falling back to /bin/zsh). Used by the new-session picker's 'Terminal' entry.",
            },
            {
              method: "GET",
              path: "/api/shells/available",
              description:
                "every interactive shell this box can spawn (Windows: PowerShell + CMD; POSIX: the login shell). Drives the new-session picker's per-shell entries.",
            },
            {
              method: "GET",
              path: "/api/debug/mem",
              description:
                "process.memoryUsage() snapshot. ?gc=1 runs a full sync GC first and reports both before/after — lets you tell V8-reserved-idle pages apart from true working set.",
            },
            {
              method: "GET",
              path: "/api/debug/timings",
              description:
                "rolling latency percentiles for instrumented hot paths. Each named span: { count, p50, p95, max, last } in ms.",
            },
            {
              method: "GET",
              path: "/api/debug/analyze",
              description:
                "bounded JSON diagnostic report for server/UI backpressure triage. Logs the same JSON to daemon.log.",
            },
            {
              method: "POST",
              path: "/api/shutdown",
              description:
                "graceful shutdown: flushes state, closes PTYs, stops the server. Used by start.ts to restart prod without manual kill.",
            },
            {
              method: "GET",
              path: "/api/image",
              description:
                "serve a local image file (?path=) for inline rendering in chat sessions",
            },
            {
              method: "GET",
              path: "/api/attachment",
              description:
                "serve a file previously saved under <workspace>/attachments/ (?path=)",
            },
            {
              method: "POST",
              path: "/api/attach",
              body: "multipart: file=<Blob>",
              description:
                "save a pasted/dropped attachment under <workspace>/attachments/; returns { path: absolute }",
            },
            {
              method: "GET",
              path: "/api/repos",
              description:
                "NDJSON stream of registered repos with their worktrees + detected agents. First line is {type:'manifest',repos:[{id,path,name,addedAt,color}]} for skeleton rows; each subsequent line is {type:'repo',repo:{...full enriched repo...}} flushed as that repo's git fan-out completes. Stream ends with EOF (no explicit done marker).",
            },
            {
              method: "GET",
              path: "/api/worktrees",
              description:
                "plain JSON inventory of registered repos and their current git worktrees. Use this from agents that only need repo/worktree paths and should not parse the dashboard's /api/repos NDJSON stream.",
            },
            {
              method: "GET",
              path: "/api/agents",
              description:
                "scan ~/.claude, ~/.codex, VSCode workspaceStorage for active AI agent sessions",
            },
            {
              method: "GET",
              path: "/api/sessions/folder-suggestions",
              description:
                "list folders the user could add to the dashboard, derived from detected sessions' cwd. Groups sessions by folder, filters already-registered repos + their worktrees, enriches with `git remote get-url origin`. Sorted newest-active first. Returns [{path,name,repoUrl?,sessionCount,lastActive,agents:string[],exists:true}].",
            },
            {
              method: "GET",
              path: "/api/session",
              description:
                "?source=<file>: normalized message stream for a known session (Claude or Codex)",
            },
            {
              method: "GET",
              path: "/api/session/context",
              description:
                "?source=<file>: sampled conversation text for handing off to another agent. Returns { context, agent, sessionId, cwd, totalMessages, includedMessages, estimatedTokens }.",
            },
            {
              method: "POST",
              path: "/api/session/start",
              body: {
                agent: "codex",
                cwd: "string",
              },
              description:
                "start a native app-server-backed session and return {agent, sessionId, cwd, source, model}. Currently Codex app-server only.",
            },
            {
              method: "POST",
              path: "/api/session/send",
              body: {
                agent: "claude|codex",
                sessionId: "provider session/thread id",
                cwd: "string",
                text: "string",
              },
              description:
                "send a prompt to a native agent session. Claude uses CLI resume; Codex uses app-server thread resume/start. Fire-and-forget: the provider writes to its session store and the UI polls for new messages. Returns the in-flight record id.",
            },
            {
              method: "POST",
              path: "/api/session/title",
              body: { source: "string", title: "string" },
              description:
                "set a manual title for the session keyed by `source`. Empty title clears.",
            },
            {
              method: "GET",
              path: "/api/session-titles",
              description:
                "return the full `{ [source]: title }` map of every saved manual title (including titles stored against synthetic `__new__:`/`__attached__:` sources).",
            },
            {
              method: "POST",
              path: "/api/session/title/migrate",
              body: { oldSource: "string", newSource: "string" },
              description:
                "move a saved manual title from `oldSource` to `newSource`. Used when a transient column's source flips to a new identity (shell PTY spawn, agent JSONL appears) so the user's typed title doesn't get orphaned.",
            },
            {
              method: "GET",
              path: "/api/active-sends",
              description:
                "list claude subprocesses still in flight from /api/session/send. Optional ?sessionId=<id> to filter.",
            },
            {
              method: "DELETE",
              path: "/api/active-sends/:id",
              description:
                "SIGTERM (then SIGKILL after 500ms) the claude subprocess for an in-flight send.",
            },
            {
              method: "POST",
              path: "/api/terminals",
              body: {
                cmd: ["string"],
                cwd: "string",
                cols: "number?",
                rows: "number?",
                ownerId: "string?",
              },
              description:
                "spawn a PTY via the supernode helper. Returns { id, pid }.",
            },
            {
              method: "GET",
              path: "/api/terminals",
              description:
                "list active terminals. Optional ?ownerId=<id> filter.",
            },
            {
              method: "GET",
              path: "/api/shells",
              description:
                "list every shell-column transcript we have on disk (`<workspace>/shells/<termId>.jsonl`), with `alive: true` for those whose PTY is still running and `alive: false` for past sessions the UI can render in read-mode.",
            },
            {
              method: "GET",
              path: "/api/shell-transcript",
              description:
                "?termId=<id> — full transcript: header, every captured command, exit info, last cwd. Used by ShellView for past-shell read mode + the Resume button.",
            },
            {
              method: "DELETE",
              path: "/api/terminals/:id",
              description: "SIGTERM (then SIGKILL after 500ms) the PTY.",
            },
            {
              method: "WS",
              path: "/api/terminals/:id/io",
              description:
                "bidirectional byte stream: binary frames are PTY bytes both ways; text frames are JSON control (e.g. {type:'resize',cols,rows}).",
            },
            {
              method: "GET",
              path: "/api/processes",
              description:
                "list of supergit-spawned PTYs plus external processes discovered in tracked repo directories, each with a live cpu%/memory sample. kind='tui' for PTYs, kind='external' for discovered processes.",
            },
            {
              method: "POST",
              path: "/api/fetch",
              description:
                "trigger an immediate git fetch of all registered repos",
            },
            {
              method: "POST",
              path: "/api/repos",
              body: { path: "string (absolute)" },
              description: "add a repo to the workspace",
            },
            {
              method: "POST",
              path: "/api/repos/order",
              body: { order: "string[] of repo ids" },
              description:
                "rewrite the global repo display order to match the provided id list (must be a permutation of the existing repo ids). Used by the drag-to-reorder dialog in the repo edit popover.",
            },
            {
              method: "DELETE",
              path: "/api/repos/:id",
              description: "remove a repo from the workspace",
            },
            {
              method: "POST",
              path: "/api/repos/:id/rename",
              body: { name: "string" },
              description: "rename a repo (undoable)",
            },
            {
              method: "POST",
              path: "/api/repos/:id/color",
              body: { color: "#rrggbb hex string or null" },
              description:
                "set or clear a repo's accent color (used wherever the name renders)",
            },
            {
              method: "POST",
              path: "/api/repos/:id/custom-links",
              body: { url: "http(s) URL", name: "string?" },
              description:
                "append a user-defined 'open in' link to the repo (Coolify dashboards, staging URLs, etc.). Returns the persisted link with its generated id.",
            },
            {
              method: "POST",
              path: "/api/repos/:id/custom-links/order",
              body: { order: "string[] of link ids" },
              description:
                "rewrite the repo's custom-links order to match the provided id list (must be a permutation of the existing ids). Used by the drag-to-reorder action in the dashboard's worktree row.",
            },
            {
              method: "DELETE",
              path: "/api/repos/:id/custom-links/:linkId",
              description:
                "remove a previously-added custom link from the repo.",
            },
            {
              method: "PATCH",
              path: "/api/repos/:id/custom-links/:linkId",
              body: { url: "string?", name: "string?" },
              description:
                "edit a custom link in place. Pass `url` to change the target, `name` to change the label (empty string clears the label).",
            },
            {
              method: "GET",
              path: "/api/favicon",
              description:
                "?url=<page-url> — proxy that fetches and caches the favicon for the given page (tries /favicon.ico and then parses <link rel='icon'> from the page HTML). Used so the UI can show a brand mark next to each custom link without CORS or third-party leaks.",
            },
            {
              method: "POST",
              path: "/api/repos/:id/worktrees",
              body: { branch: "string", base: "string?" },
              description:
                "create a new worktree for the repo on a new branch (at ~/wt/<repo>/<branch>)",
            },
            {
              method: "DELETE",
              path: "/api/repos/:id/worktrees",
              body: { path: "string", force: "boolean?" },
              description:
                "remove a worktree directory + its .git slot. Refuses on dirty state unless force=true. Returns 409 with {dirty:true} if uncommitted/untracked work exists.",
            },
            {
              method: "GET",
              path: "/api/repos/:id/branches",
              description:
                "list local + remote branches and the currently checked-out branch. Optional ?path=<wt> to query a specific worktree's HEAD (default: the repo's main worktree).",
            },
            {
              method: "POST",
              path: "/api/repos/:id/checkout",
              body: { path: "string", branch: "string", force: "boolean?" },
              description:
                "run `git checkout <branch>` in the given worktree. Refuses on dirty state unless force=true. Remote-style branches (origin/foo) get an implicit `-t` to create a tracking local branch.",
            },
            {
              method: "POST",
              path: "/api/repos/:id/pull",
              body: { path: "string", preStash: "boolean?" },
              description:
                "fast-forward the given worktree to its upstream via `git merge --ff-only @{u}` (NOT `git pull` — the daemon's background fetch cycle already keeps `@{u}` fresh, so we skip the extra network round-trip). Returns { ok, kind } where kind ∈ updated|up_to_date|diverged|dirty|no_upstream|error. With preStash=true, retries once after `git stash push --include-untracked` if kind=dirty, then `git stash pop` to reapply — response carries { stashed, stashRestored, stashConflict } (stashConflict=true means the pop conflicted and the stash was kept).",
            },
            {
              method: "POST",
              path: "/api/repos/:id/push",
              body: { path: "string" },
              description:
                "run `git push` in the given worktree against its tracked upstream. Never forces; non-fast-forward failures return 409 with the git error verbatim.",
            },
            {
              method: "POST",
              path: "/api/pick-folder",
              description:
                "open OS-native folder picker, returns chosen path or 204 if cancelled",
            },
            {
              method: "POST",
              path: "/api/pick-file",
              body: {
                prompt: "string?",
                startAt: "string? (file or dir to open the picker in)",
                fallback: "string? (used when startAt doesn't exist)",
              },
              description:
                "open OS-native file picker, returns chosen path or 204 if cancelled",
            },
            {
              method: "POST",
              path: "/api/open-default",
              body: { path: "string" },
              description:
                "open a file with the OS default application (same handler a Finder/Explorer double-click would route to). Used by file-flavoured custom links.",
            },
            {
              method: "GET",
              path: "/api/files",
              description:
                "?path=<dir> — list directory contents. Returns { entries: [{ name, type, size }] } where type is 'file' | 'directory' | 'symlink'. Used by the file browser panel.",
            },
            {
              method: "POST",
              path: "/api/exists",
              body: { paths: "string[]" },
              description:
                "bulk stat. Returns { results: { [path]: { exists: bool, type?: 'file'|'directory'|'symlink' } } }. Used by the starred-only view to strike through stars whose files were moved/deleted and to distinguish folders from files in the row icons.",
            },
            {
              method: "GET",
              path: "/api/page-title",
              description:
                "?url= — best-effort `<title>` extractor for a remote URL. Used by the custom-link 'auto-fill label' path so chips get a friendlier name than the bare host. Returns { url, title } where title may be null.",
            },
            {
              method: "GET",
              path: "/api/editors",
              description:
                "list editors detected on PATH (cursor, code, rider, ...)",
            },
            {
              method: "GET",
              path: "/api/commits",
              description:
                "list commits for a worktree: ?path=<wt>&before=<sha>&limit=<n>",
            },
            {
              method: "GET",
              path: "/api/diff",
              description:
                "git diff text for a worktree: ?path=<wt>&kind=workdir|staged",
            },
            {
              method: "GET",
              path: "/api/file-diff",
              description:
                "git diff text for a single file: ?path=<wt>&file=<rel-file>&kind=workdir|staged|untracked&context=<n> (default context=0). Used by the per-file hover popup in the worktree-row 'changed files' tooltip — fetches one path's hunks instead of the whole workdir diff.",
            },
            {
              method: "GET",
              path: "/api/commit",
              description:
                "git show output for one commit: ?path=<wt>&sha=<sha>",
            },
            {
              method: "POST",
              path: "/api/open",
              body: {
                path: "string",
                app: "fork | terminal | <editor cmd>",
                command: "string?",
              },
              description:
                "open a path in Fork / terminal / a detected editor via OS shell-out. `command` is honoured for app=terminal — runs the given shell command in the new window at the given cwd (drives e.g. `claude --resume <sid>` in macOS Terminal / Linux's preferred terminal)",
            },
            {
              method: "GET",
              path: "/api/stream",
              description:
                "Server-Sent Events stream; emits 'change' on every mutation so clients can refresh",
            },
            {
              method: "GET",
              path: "/api/events",
              description:
                "list recent events (mutations + observations) with undone/reversible flags",
            },
            {
              method: "POST",
              path: "/api/events/:id/undo",
              description: "reverse a reversible event",
            },
            {
              method: "POST",
              path: "/api/events/:id/redo",
              description: "re-apply a previously undone event",
            },
            {
              method: "GET",
              path: "/api/errors",
              description:
                "list recent errors (server 5xx, browser fetch failures, uncaught exceptions). Optional ?limit=<n>.",
            },
            {
              method: "POST",
              path: "/api/errors",
              body: {
                kind: "string?",
                source: "string?",
                message: "string",
                stack: "string?",
                route: "string?",
                method: "string?",
                status: "number?",
                extra: "object?",
              },
              description:
                "report a browser-side error so it lands in the workspace errors.jsonl and the Events popover.",
            },
            {
              method: "DELETE",
              path: "/api/errors",
              description: "clear the recorded error log",
            },
            {
              method: "GET",
              path: "/api/notes",
              description:
                "list workspace notes (newest first). Optional ?anchorPrefix=<prefix> filters to notes whose anchors startsWith() the prefix (e.g. anchorPrefix=worktree:/abs/path to get every note pinned to a worktree).",
            },
            {
              method: "POST",
              path: "/api/notes",
              body: {
                id: "string?",
                body: "string",
                anchors: "string[]?",
                tags: "string[]?",
              },
              description:
                "create a new note as <workspace>/notes/<id>.md. id is auto-generated as <yyyy-mm-dd>-<hex8> if omitted.",
            },
            {
              method: "PUT",
              path: "/api/notes/:id",
              body: {
                body: "string?",
                anchors: "string[]?",
                tags: "string[]?",
              },
              description:
                "update a note's body/anchors/tags; bumps updatedAt.",
            },
            {
              method: "DELETE",
              path: "/api/notes/:id",
              description: "delete a note file.",
            },
            { method: "GET", path: "/mcp", description: "MCP server info" },
            {
              method: "POST",
              path: "/mcp",
              description: "MCP JSON-RPC: initialize, tools/list, tools/call",
            },
          ],
          note: "All routes reachable at http://localhost:7777/api/* (daemon direct) or http://localhost:7779/api/* (Vite dev proxy). CORS is locked to the dev UI origin — set SUPERGIT_EXTRA_ORIGINS to allow others. Programmatic clients (curl, agents, MCP) ignore CORS and work either way.",
        });
      }

      if (url.pathname === "/api/repos" && req.method === "GET") {
        return reposNDJSONResponse(
          CORS,
          json,
          parseSelectedRemotesParam(url.searchParams.get("selectedRemotes")),
        );
      }

      // Priority refresh for a single worktree — the UI polls this every few
      // seconds for the worktree the user is actively in, so its dirty/ahead
      // badges stay live even when chatty background repos saturate the shared
      // git limiter. Runs on the dedicated priority lane, recomputes, patches
      // the /api/repos cache, broadcasts, and returns the fresh details.
      if (url.pathname === "/api/worktree-details" && req.method === "GET") {
        const wtPath = url.searchParams.get("path");
        if (!wtPath) return json({ error: "path required" }, { status: 400 });
        const details = await runWorktreeRecompute(
          wtPath,
          reposGitPriorityLimit,
        );
        if (!details)
          return json({ error: "recompute failed" }, { status: 502 });
        return json({ path: wtPath, details });
      }

      if (url.pathname === "/api/worktrees" && req.method === "GET") {
        const repos = await workspace.listRepos();
        const body = await Promise.all(
          repos.map(async (repo) => {
            const worktrees = await listWorktrees(repo.path).catch(() => []);
            const mainPath = await mainWorktreePathFor(repo.path).catch(
              () => repo.path,
            );
            return {
              id: repo.id,
              name: repo.name,
              path: repo.path,
              color: repo.color,
              worktrees: worktrees.map((wt) => ({
                path: wt.path,
                branch: wt.branch,
                main: wt.path === mainPath,
              })),
            };
          }),
        );
        return json({ repos: body });
      }

      if (url.pathname === "/api/agents" && req.method === "GET") {
        const [agents, titles] = await Promise.all([
          sharedDetectAgents(),
          workspace.listSessionTitles(),
        ]);
        return json(agents.map((s) => withSessionTitles(s, titles)));
      }

      // GET /api/agent-usage — sessions + messages per detected coding
      // agent, bucketed into rolling 24h and 7d windows. The UI uses this
      // to render the menubar agent-usage chip (per-agent logos + hover
      // tooltip). 60s in-memory cache keeps the JSONL scan from running
      // on every poll while still feeling live.
      //
      // Claude top-sessions is intentionally skipped here — it's the
      // slowest piece of the report (full JSONL token scan over every
      // Claude session active in the past week) so the UI fetches it
      // separately from /api/agent-usage/claude-top-sessions and
      // renders a spinner in the tooltip slot until it arrives. Keeps
      // the bars + live numbers visible quickly.
      if (url.pathname === "/api/agent-usage" && req.method === "GET") {
        const now = Date.now();
        if (
          agentUsageCache.value &&
          now - agentUsageCache.at < AGENT_USAGE_CACHE_MS
        ) {
          return json(agentUsageCache.value);
        }
        const agents = await sharedDetectAgents();
        const report = await computeAgentUsage(agents, now, {
          skipClaudeTopSessions: true,
        });
        agentUsageCache = { at: now, value: report };
        return json(report);
      }

      // GET /api/agent-usage/claude-top-sessions — slow companion to
      // /api/agent-usage. Returns just the top-N Claude sessions of the
      // past week ranked by weighted token total (in + out +
      // cache_write + 0.1·cache_read; weighted to keep cache_read from
      // dominating). 60s in-memory cache. Empty list when no Claude
      // sessions are detected or none have a usage block in window.
      if (
        url.pathname === "/api/agent-usage/claude-top-sessions" &&
        req.method === "GET"
      ) {
        const now = Date.now();
        if (
          claudeTopSessionsCache.value &&
          now - claudeTopSessionsCache.at < AGENT_USAGE_CACHE_MS
        ) {
          return json({ claudeTopSessions: claudeTopSessionsCache.value });
        }
        // Merge the workspace's manual session titles into the agents
        // list before computing — same pattern as /api/agents — so the
        // Top-Sessions list shows whatever the user renamed sessions to
        // rather than the auto-derived first-prompt title.
        const [agents, titles] = await Promise.all([
          sharedDetectAgents(),
          workspace.listSessionTitles(),
        ]);
        const enriched = agents.map((s) => withSessionTitles(s, titles));
        const top = await topClaudeSessionsByTokens(enriched, now, 5);
        claudeTopSessionsCache = { at: now, value: top };
        return json({ claudeTopSessions: top });
      }

      // GET /api/sessions/folder-suggestions — derive a list of folders the
      // user could add to the dashboard by scanning every detected agent
      // session's cwd. Sessions are grouped by folder; already-registered
      // repos and their worktrees are filtered out. Each suggestion is
      // enriched with the folder's `git remote get-url origin` (when the
      // path is a git repo). Sorted newest-active first so the list reads
      // as "where I was working most recently."
      if (
        url.pathname === "/api/sessions/folder-suggestions" &&
        req.method === "GET"
      ) {
        const [agents, repos] = await Promise.all([
          sharedDetectAgents(),
          workspace.listRepos(),
        ]);
        // Suppress already-registered repos AND every worktree they own,
        // so the user doesn't see paths they've already added under a
        // different surface (e.g. a `~/wt/<repo>/<branch>` worktree of an
        // already-registered repo at `~/git/<repo>`).
        const ci = process.platform === "win32";
        const norm = (s: string) =>
          ci ? resolve(s).toLowerCase() : resolve(s);
        const suppress = new Set<string>();
        for (const r of repos) suppress.add(norm(r.path));
        await Promise.all(
          repos.map(async (r) => {
            try {
              const wts = await listWorktrees(r.path);
              for (const w of wts) suppress.add(norm(w.path));
            } catch {
              // Repo path missing / not a git repo — fine, the repo.path
              // entry above is enough.
            }
          }),
        );
        const grouped = groupSessionsByFolder(agents, suppress);
        // Enrich each suggestion with the remote origin URL when the
        // folder is a git repo. `git -C <path> config --get
        // remote.origin.url` returns empty / non-zero exit when there's
        // no origin; we treat any failure as "no url."
        const enriched: (FolderSuggestion & {
          repoUrl?: string;
          exists: boolean;
        })[] = await Promise.all(
          grouped.map(async (g) => {
            let exists = false;
            try {
              const st = await fsStat(g.path);
              exists = st.isDirectory();
            } catch {
              exists = false;
            }
            let repoUrl: string | undefined;
            if (exists) {
              try {
                const out =
                  await $`git -C ${g.path} config --get remote.origin.url`
                    .quiet()
                    .text();
                const trimmed = out.trim();
                if (trimmed) repoUrl = trimmed;
              } catch {
                // Not a git repo / no remote — leave undefined.
              }
            }
            return { ...g, repoUrl, exists };
          }),
        );
        // Drop suggestions whose folder no longer exists on disk — the
        // user can't add a path that isn't there.
        const visible = enriched.filter((e) => e.exists);
        return json(visible);
      }

      if (url.pathname === "/api/session/title" && req.method === "POST") {
        const body = (await req.json().catch(() => null)) as {
          source?: unknown;
          title?: unknown;
        } | null;
        const source = body?.source;
        const title = body?.title;
        if (typeof source !== "string" || source.length === 0) {
          return json(
            { error: "body.source (non-empty string) is required" },
            { status: 400 },
          );
        }
        if (typeof title !== "string") {
          return json(
            { error: "body.title (string; empty clears) is required" },
            { status: 400 },
          );
        }
        try {
          await workspace.setSessionTitle(source, title);
          syncCodexThreadTitleIndex(source, title).catch((err) => {
            console.warn(
              `supergit daemon: failed to sync Codex thread title for ${source}: ${(err as Error).message}`,
            );
          });
          // Update the persisted terminal's title if applicable
          if (
            typeof source === "string" &&
            source.startsWith("__attached__:shell:")
          ) {
            const termId = source.split(":").pop();
            if (termId) {
              const persisted = await terminalPersist.list();
              const entry = persisted.find((t) => t.termId === termId);
              if (entry)
                void terminalPersist
                  .save({ ...entry, title: title || undefined })
                  .catch(() => {});
            }
          }
          const titles = await workspace.listSessionTitles();
          broadcast("change", { kind: "session_title", source });
          return json({ source, title: titles[source] ?? "" });
        } catch (e) {
          return json(
            { error: String(e instanceof Error ? e.message : e) },
            { status: 400 },
          );
        }
      }

      if (url.pathname === "/api/session-titles" && req.method === "GET") {
        // Expose the full title map so the UI can pre-populate its
        // in-memory cache for synthetic `__new__:` / `__attached__:`
        // sources after a page reload (the per-source titles still flow
        // through `/api/repos` for real JSONL paths, but synthetic-source
        // titles are never surfaced there because the daemon doesn't
        // know about transient client-side columns).
        const titles = await workspace.listSessionTitles();
        return json(titles);
      }

      if (
        url.pathname === "/api/session/title/migrate" &&
        req.method === "POST"
      ) {
        const body = (await req.json().catch(() => null)) as {
          oldSource?: unknown;
          newSource?: unknown;
        } | null;
        const oldSource = body?.oldSource;
        const newSource = body?.newSource;
        if (typeof oldSource !== "string" || oldSource.length === 0) {
          return json(
            { error: "body.oldSource (non-empty string) is required" },
            { status: 400 },
          );
        }
        if (typeof newSource !== "string" || newSource.length === 0) {
          return json(
            { error: "body.newSource (non-empty string) is required" },
            { status: 400 },
          );
        }
        try {
          await workspace.migrateSessionTitle(oldSource, newSource);
          const titles = await workspace.listSessionTitles();
          const migratedTitle = titles[newSource] ?? "";
          if (migratedTitle) {
            syncCodexThreadTitleIndex(newSource, migratedTitle).catch((err) => {
              console.warn(
                `supergit daemon: failed to sync migrated Codex thread title for ${newSource}: ${(err as Error).message}`,
              );
            });
          }
          broadcast("change", {
            kind: "session_title_migrate",
            oldSource,
            newSource,
          });
          return json({ oldSource, newSource, title: migratedTitle });
        } catch (e) {
          return json(
            { error: String(e instanceof Error ? e.message : e) },
            { status: 400 },
          );
        }
      }

      if (url.pathname === "/api/session" && req.method === "GET") {
        const source = url.searchParams.get("source");
        if (!source) {
          return json(
            { error: "?source=<session-file> required" },
            { status: 400 },
          );
        }
        // Allowlist: source must live under one of the agent roots we know
        // how to parse. Keeps this endpoint from becoming an arbitrary file
        // read, without depending on detectAgents() to currently re-find
        // the same file (which races with file-system updates).
        const resolved = resolveSessionAgent(source);
        if (!resolved) {
          return json(
            { error: "source is outside any known agent root" },
            { status: 403 },
          );
        }
        // Cheap 304 short-circuit BEFORE calling getSessionResponseJson.
        // The full ETag (and the response body inside getSessionResponseJson)
        // is derived from stat()'s mtimeMs + size, so a single stat() call
        // is enough to detect "nothing changed". This route is polled at
        // ~22 Hz while a session is interactive — skipping the cache walk
        // + manualTitle injection + JSON stringify on every quiet poll is
        // the entire point of the optimisation. Falls through to the full
        // path on cache miss / first hit / unparseable etag.
        const clientEtag = req.headers.get("If-None-Match");
        if (clientEtag) {
          const _t304 = performance.now();
          const st = await fsStat(source).catch(() => null);
          if (st) {
            const quickEtag = `"${st.mtimeMs}-${st.size}"`;
            if (clientEtag === quickEtag) {
              record("session-304-path", performance.now() - _t304);
              return new Response(null, {
                status: 304,
                headers: { ETag: quickEtag, ...CORS },
              });
            }
          }
        }
        const _tFull = performance.now();
        const agentKind = resolved.agent;
        const titles = await workspace.listSessionTitles();
        const { body, etag } = await getSessionResponseJson(
          agentKind,
          source,
          titles[source],
        );
        if (clientEtag && clientEtag === etag) {
          record("session-full-path", performance.now() - _tFull);
          return new Response(null, {
            status: 304,
            headers: { ETag: etag, ...CORS },
          });
        }
        record("session-full-path", performance.now() - _tFull);
        return new Response(body, {
          headers: { "Content-Type": "application/json", ETag: etag, ...CORS },
        });
      }

      // Batched sibling of GET /api/session: the dashboard coalesces every
      // mounted SessionView's 2 s poll into ONE request per daemon instead of
      // one-per-column (see plans/performance.md "per-column session-poll
      // storm"). Body: { sources: [{ source, etag?, messageCursor? }] }.
      // Per-source 304/206/200/403 mirrors the single route; logic lives in
      // getSessionsBatchResults so it stays unit-tested.
      if (url.pathname === "/api/sessions/batch" && req.method === "POST") {
        const payload = await req.json().catch(() => null);
        const sources = (payload as { sources?: unknown } | null)?.sources;
        if (!Array.isArray(sources)) {
          return json(
            { error: "{ sources: [{ source, etag? }] } required" },
            { status: 400 },
          );
        }
        const parseCursor = (
          value: unknown,
        ): BatchSessionCursor[] | undefined => {
          if (!Array.isArray(value)) return undefined;
          const cursor: BatchSessionCursor[] = [];
          for (const entry of value) {
            if (!entry || typeof entry !== "object") continue;
            const raw = entry as Record<string, unknown>;
            if (Number.isInteger(raw.index) && typeof raw.hash === "string") {
              cursor.push({ index: raw.index, hash: raw.hash });
            }
          }
          return cursor.length > 0 ? cursor : undefined;
        };
        const items = sources
          .filter(
            (s): s is Record<string, unknown> & { source: string } =>
              !!s && typeof s === "object" && typeof s.source === "string",
          )
          // Cap the fan-out so a malformed/hostile client can't ask the daemon
          // to stat+parse thousands of files in one request.
          .slice(0, 200)
          .map((s) => ({
            source: s.source,
            etag: typeof s.etag === "string" ? s.etag : undefined,
            messageCursor: parseCursor(s.messageCursor),
          }));
        const titles = await workspace.listSessionTitles();
        const results = await getSessionsBatchResults(
          items,
          (s) => resolveSessionAgent(s)?.agent ?? null,
          (s) => titles[s],
        );
        return json({ results });
      }

      if (url.pathname === "/api/session/context" && req.method === "GET") {
        const source = url.searchParams.get("source");
        if (!source) {
          return json(
            { error: "?source=<session-file> required" },
            { status: 400 },
          );
        }
        const resolved = resolveSessionAgent(source);
        if (!resolved) {
          return json(
            { error: "source is outside any known agent root" },
            { status: 403 },
          );
        }
        const parsed = await parseSessionFile(resolved.agent, source);
        const sampled = sampleSessionForSummary(parsed.messages, {
          targetMessages: 60,
          maxMsgChars: 4096,
          budgetChars: 64 * 1024,
        });
        if (!sampled.prompt) {
          return json(
            { error: "session has no text content" },
            { status: 404 },
          );
        }
        const ctxDir = join(WORKSPACE_PATH, "context-handoffs");
        try {
          mkdirSync(ctxDir, { recursive: true });
        } catch {}
        const ctxId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const ctxPath = join(ctxDir, `${ctxId}.md`);
        const header =
          `# Prior conversation context (${resolved.agent} session)\n` +
          `<!-- source: ${source} -->\n` +
          `<!-- ${sampled.includedMessages} of ${sampled.totalMessages} messages, ~${sampled.estimatedTokens} tokens -->\n\n` +
          "Pick up where the previous conversation left off.\n\n---\n\n";
        await fsWriteFile(ctxPath, header + sampled.prompt, "utf-8");
        return json({
          contextPath: ctxPath,
          context: sampled.prompt,
          agent: resolved.agent,
          sessionId: parsed.sessionId || undefined,
          cwd: parsed.cwd,
          totalMessages: sampled.totalMessages,
          includedMessages: sampled.includedMessages,
          estimatedTokens: sampled.estimatedTokens,
        });
      }

      if (url.pathname === "/api/session/start" && req.method === "POST") {
        const body = (await req.json().catch(() => null)) as {
          agent?: unknown;
          cwd?: unknown;
        } | null;
        const agent = body?.agent;
        const cwd = body?.cwd;
        if (typeof agent !== "string" || typeof cwd !== "string" || !cwd) {
          return json({ error: "agent, cwd required" }, { status: 400 });
        }
        try {
          const started = await nativeAgents.startSession({ agent, cwd });
          return json({ ok: true, ...started });
        } catch (e) {
          const message = e instanceof Error ? e.message : String(e);
          if (/not supported/.test(message)) {
            return json({ error: message }, { status: 501 });
          }
          return json({ error: message }, { status: 500 });
        }
      }

      if (url.pathname === "/api/codex-app/events" && req.method === "GET") {
        const threadId = url.searchParams.get("threadId") || undefined;
        let unsubscribe: (() => void) | null = null;
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            const send = (event: unknown) => {
              try {
                controller.enqueue(
                  sseEncoder.encode(
                    `event: codex\ndata: ${JSON.stringify(event)}\n\n`,
                  ),
                );
              } catch {
                unsubscribe?.();
              }
            };
            controller.enqueue(sseEncoder.encode(`: connected\n\n`));
            if (threadId) {
              const turnId = codexAgent.activeTurn(threadId);
              send({
                kind: "notification",
                method: "turn/status",
                params: { active: !!turnId, threadId, turnId },
                threadId,
                turnId,
                receivedAt: new Date().toISOString(),
              });
            }
            unsubscribe = codexAgent.subscribe(threadId, send);
          },
          cancel() {
            unsubscribe?.();
            unsubscribe = null;
          },
        });
        return new Response(stream, {
          headers: {
            ...CORS,
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache, no-transform",
            Connection: "keep-alive",
            "X-Accel-Buffering": "no",
          },
        });
      }

      if (url.pathname === "/api/codex-app/models" && req.method === "GET") {
        const cwd = url.searchParams.get("cwd") || WORKSPACE_PATH;
        try {
          const models = await codexAgent.listModels(cwd);
          return json({ ok: true, models });
        } catch (e) {
          return json(
            { error: e instanceof Error ? e.message : String(e) },
            { status: 500 },
          );
        }
      }

      if (url.pathname === "/api/codex-app/turns" && req.method === "POST") {
        const body = (await req.json().catch(() => null)) as {
          threadId?: unknown;
          cwd?: unknown;
          text?: unknown;
          input?: unknown;
          steer?: unknown;
          expectedTurnId?: unknown;
          model?: unknown;
          approvalPolicy?: unknown;
          sandboxPolicy?: unknown;
          effort?: unknown;
          summary?: unknown;
        } | null;
        const threadId =
          typeof body?.threadId === "string" && body.threadId
            ? body.threadId
            : undefined;
        const cwd = typeof body?.cwd === "string" ? body.cwd : "";
        const text = typeof body?.text === "string" ? body.text : "";
        const input = Array.isArray(body?.input)
          ? (body.input as Record<string, unknown>[])
          : undefined;
        if (!cwd || (!text.trim() && !input?.length)) {
          return json(
            { error: "cwd and text/input required" },
            { status: 400 },
          );
        }
        try {
          if (threadId && body?.steer === true) {
            const expectedTurnId =
              typeof body?.expectedTurnId === "string" && body.expectedTurnId
                ? body.expectedTurnId
                : undefined;
            if (!expectedTurnId) {
              return json(
                { error: "expectedTurnId required for steering" },
                { status: 400 },
              );
            }
            const steered = await codexAgent.steerTurn({
              threadId,
              expectedTurnId,
              text,
              input,
            });
            return json({ ok: true, steered: true, ...steered });
          }
          const turn = await codexAgent.startTurn({
            threadId,
            cwd,
            text,
            input,
            overrides: {
              model: codexTurnString(body?.model),
              approvalPolicy: codexApprovalPolicy(body?.approvalPolicy),
              sandboxPolicy: codexSandboxPolicy(body?.sandboxPolicy, cwd),
              effort: codexTurnString(body?.effort),
              summary: codexTurnString(body?.summary),
            },
          });
          return json({
            ok: true,
            steered: false,
            threadId: turn.threadId,
            turnId: turn.turnId,
          });
        } catch (e) {
          return json(
            { error: e instanceof Error ? e.message : String(e) },
            { status: 500 },
          );
        }
      }

      if (
        url.pathname === "/api/codex-app/turns/interrupt" &&
        req.method === "POST"
      ) {
        const body = (await req.json().catch(() => null)) as {
          threadId?: unknown;
          turnId?: unknown;
        } | null;
        if (typeof body?.threadId !== "string" || !body.threadId) {
          return json({ error: "threadId required" }, { status: 400 });
        }
        try {
          await codexAgent.interruptTurn(
            body.threadId,
            typeof body.turnId === "string" ? body.turnId : undefined,
          );
          return json({ ok: true });
        } catch (e) {
          return json(
            { error: e instanceof Error ? e.message : String(e) },
            { status: 500 },
          );
        }
      }

      if (
        url.pathname.startsWith("/api/codex-app/requests/") &&
        url.pathname.endsWith("/respond") &&
        req.method === "POST"
      ) {
        const encoded = url.pathname
          .slice("/api/codex-app/requests/".length)
          .slice(0, -"/respond".length);
        const rawId = decodeURIComponent(encoded);
        const requestId = /^\d+$/.test(rawId) ? Number(rawId) : rawId;
        const body = (await req.json().catch(() => null)) as {
          result?: unknown;
          error?: unknown;
          decision?: unknown;
          answers?: unknown;
        } | null;
        try {
          if (
            body?.error &&
            typeof body.error === "object" &&
            typeof (body.error as { message?: unknown }).message === "string"
          ) {
            codexAgent.respondToRequest(requestId, {
              error: body.error as { message: string },
            });
          } else if (body?.result && typeof body.result === "object") {
            codexAgent.respondToRequest(requestId, {
              result: body.result as Record<string, unknown>,
            });
          } else if (typeof body?.decision === "string") {
            codexAgent.respondToRequest(requestId, {
              result: { decision: body.decision },
            });
          } else if (body?.answers && typeof body.answers === "object") {
            codexAgent.respondToRequest(requestId, {
              result: { answers: body.answers as Record<string, unknown> },
            });
          } else {
            return json(
              { error: "result, decision, answers, or error required" },
              { status: 400 },
            );
          }
          return json({ ok: true });
        } catch (e) {
          return json(
            { error: e instanceof Error ? e.message : String(e) },
            { status: 500 },
          );
        }
      }

      if (url.pathname === "/api/session/send" && req.method === "POST") {
        const body = (await req.json().catch(() => null)) as {
          agent?: string;
          sessionId?: string;
          cwd?: string;
          text?: string;
        } | null;
        const agent = body?.agent;
        const sessionId = body?.sessionId;
        const cwd = body?.cwd;
        const text = body?.text;
        if (
          !agent ||
          !cwd ||
          !text ||
          typeof text !== "string" ||
          !text.trim()
        ) {
          return json({ error: "agent, cwd, text required" }, { status: 400 });
        }
        try {
          const proc = nativeAgents.sendTurn({
            agent,
            sessionId,
            cwd,
            text,
          });
          const rec = inflight.register({
            agent,
            sessionId: sessionId ?? "",
            cwd,
            text,
            proc,
          });
          return json({ ok: true, id: rec.id, pid: rec.pid });
        } catch (e) {
          const message = e instanceof Error ? e.message : String(e);
          if (/not supported/.test(message)) {
            return json({ error: message }, { status: 501 });
          }
          if (/needs sessionId/.test(message)) {
            return json({ error: message }, { status: 400 });
          }
          return json({ error: message }, { status: 500 });
        }
      }

      if (url.pathname === "/api/terminals" && req.method === "POST") {
        const terminalSpawnRouteStarted = performance.now();
        const body = (await req.json().catch(() => null)) as {
          cmd?: string[];
          cwd?: string;
          cols?: number;
          rows?: number;
          ownerId?: string;
          procName?: string;
          /** When this spawn is a Resume of a past shell, the prior
           *  termId. Daemon pre-seeds the new shell's JSONL with the
           *  prior cmd history so the user's command transcript
           *  carries over across Resume. */
          previousTermId?: string;
        } | null;
        if (
          !body ||
          !Array.isArray(body.cmd) ||
          body.cmd.length === 0 ||
          !body.cwd
        ) {
          return json({ error: "cmd[] and cwd required" }, { status: 400 });
        }
        // Detect the agent label from the ORIGINAL cmd before we wrap.
        // Otherwise wrapping with `bash -c '…'` would make the backend
        // see cmd[0]="bash" and mis-label every TUI as a shell.
        const agentHint = detectAgentLabel(body.cmd[0]);
        const head0 = body.cmd[0]?.split(/[\\/]/).pop()?.toLowerCase();
        // If cmd[0] is a BARE agent name (no path separators), resolve it
        // to an absolute path picking the newest install across known
        // prefixes. This sidesteps the "two installs of codex, PATH
        // points at the old one" trap: codex's self-update writes to
        // `~/.bun/bin/`, but a pre-existing `/opt/homebrew/bin/codex`
        // shadows it on PATH. resolveAgentBinary returns the newest
        // mtime, so a freshly-bun-installed codex wins.
        let resolvedCmd = body.cmd.slice();
        if (
          head0 &&
          !body.cmd[0]!.includes("/") &&
          (head0 === "claude" || head0 === "codex" || head0 === "ollama")
        ) {
          const abs = await resolveAgentBinary(head0);
          if (abs) resolvedCmd[0] = abs;
        }
        // Optional argv[0] rename via `bash -c 'exec -a NAME …'` so the PTY
        // shows up in `ps`/`top`/`htop` (and macOS Activity Monitor's
        // command column) as e.g. "supergit-tui-abc12345-claude" instead
        // of just "claude". Unix only; Windows ignores the hint.
        //
        // Critical exception for zsh shells: zsh reads its argv[0] to
        // decide its emulation mode. If the basename doesn't contain
        // "zsh" / "ksh" / "csh", zsh starts in **sh emulation** — no
        // /etc/zshrc, no ~/.zshrc, no zle line editor, prompt becomes
        // a bare "$ " (sh default). That's the "cursor on empty line
        // below the $, only last keypress visible" symptom on resume.
        // Prepend "zsh-" to the procName when the underlying command
        // is a zsh shell so zsh's name-based mode detection picks
        // "zsh" out of the renamed argv[0]. The ps-readable suffix
        // (and the rename-for-Activity-Monitor benefit) is preserved.
        let effectiveProcName = body.procName;
        const innerCmd0Base = (resolvedCmd[0] ?? "").split(/[/\\]/).pop() ?? "";
        if (
          effectiveProcName &&
          process.platform !== "win32" &&
          (innerCmd0Base === "zsh" || /^zsh-\d/.test(innerCmd0Base)) &&
          !/(^|[-_/])zsh([-_]|$)/.test(effectiveProcName)
        ) {
          effectiveProcName = `zsh-${effectiveProcName}`;
        }
        const cmd =
          effectiveProcName && process.platform !== "win32"
            ? renameArgv(effectiveProcName, resolvedCmd)
            : resolvedCmd;
        // For a shell Resume, fetch the prior column's cmd lines so the
        // spawned zsh's per-column HISTFILE can be seeded — arrow-up
        // inside the resumed shell then surfaces commands typed in this
        // column's lineage, not the user's global ~/.zsh_history.
        const historyPreload =
          agentHint === "shell" && body.previousTermId
            ? await shells
                .getCarryOverCmdLines(body.previousTermId)
                .catch(() => [])
            : undefined;
        // For Claude TUIs, look up the owning repo's accent colour so the
        // backend can tint the user-message box to match the repo chip.
        const userBoxColor =
          agentHint === "claude" ? await repoColorForCwd(body.cwd) : undefined;
        try {
          const terminalSpawnBackendStarted = performance.now();
          const handle = await terminalBackend.spawn({
            cmd,
            cwd: body.cwd,
            ownerId: body.ownerId,
            agent: agentHint,
            // Plain shell sessions initialize their own login shell; agent PTYs
            // need the daemon to supply the developer PATH explicitly.
            env: agentHint === "shell" ? undefined : terminalSpawnEnv(),
            userBoxColor,
            // Clamp absurd dims to a sane floor. The frontend reads
            // xterm.cols/rows in onMount; if the container hasn't laid out
            // yet (clientWidth ≈ 0), the FitAddon proposes 2 cols and zsh
            // wraps the prompt onto itself — visible bug: keystrokes
            // overwrite the prompt, dquote> from lost quotes. A later rAF
            // re-fit corrects the viewport but the PTY was already spawned
            // 2-wide. Floor of 20x5 is below any usable display but well
            // above the garbage-layout values.
            size: { cols: clampCols(body.cols), rows: clampRows(body.rows) },
            historyPreload,
          });
          const backendMs = performance.now() - terminalSpawnBackendStarted;
          const totalMs = performance.now() - terminalSpawnRouteStarted;
          record("terminal-spawn-backend", backendMs);
          record("terminal-spawn-post", totalMs);
          terminalSpawnPendingWs.set(handle.id, performance.now());
          terminalSpawnFinishedAt.set(handle.id, performance.now());
          console.log(
            `supergit daemon: terminal spawn id=${handle.id} owner=${body.ownerId ?? "-"} agent=${agentHint ?? "unknown"} pid=${handle.pid} totalMs=${Math.round(totalMs)} backendMs=${Math.round(backendMs)} cwd=${body.cwd}`,
          );
          if (totalMs > TERMINAL_SPAWN_SLOW_MS) {
            console.warn(
              `supergit daemon: /api/terminals slow total=${Math.round(totalMs)}ms backend=${Math.round(backendMs)}ms owner=${body.ownerId ?? "-"} agent=${agentHint ?? "unknown"} cwd=${body.cwd}`,
            );
          }
          // For shell PTYs, persist a header into <workspace>/shells/<id>.jsonl
          // so the workspace (not the browser's localStorage) is the source
          // of truth for "which Terminal columns are open." On reload the UI
          // hits GET /api/shells, gets the live set, and reattaches.
          if (agentHint === "shell") {
            await shells
              .writeHeader(
                {
                  kind: "header",
                  termId: handle.id,
                  wt: body.cwd,
                  spawnCwd: body.cwd,
                  createdAt: new Date().toISOString(),
                },
                body.previousTermId,
              )
              .catch((err) => {
                console.error(
                  `supergit daemon: shells.writeHeader failed for ${handle.id}: ${err}`,
                );
              });
            shellTermIds.add(handle.id);
            void terminalPersist
              .save({
                termId: handle.id,
                cmd,
                cwd: body.cwd,
                wtPath: body.cwd,
              })
              .catch(() => {});
            // Cleanup-only subscriber: when the PTY exits we drop the
            // in-memory bookkeeping and append a closing `exit` entry so
            // the JSONL becomes a complete transcript. We ignore onData
            // here — keystroke capture happens in the WS message handler.
            //
            // `cleanup` is declared with `let` BEFORE subscribe(): if the
            // PTY is already dead (e.g. it SIGHUP'd on spawn), subscribe()
            // fires onExit SYNCHRONOUSLY, which references `cleanup` — a
            // `const` assigned by subscribe()'s return would still be in
            // its temporal dead zone there ("Cannot access 'cleanup' before
            // initialization"). Pre-declaring + null-guarding makes the
            // synchronous-exit path safe.
            let cleanup: (() => void) | null = null;
            cleanup = handle.subscribe({
              onData() {},
              onExit(info) {
                shellTermIds.delete(handle.id);
                terminalSpawnPendingWs.delete(handle.id);
                terminalSpawnFinishedAt.delete(handle.id);
                terminalWsOpenedAt.delete(handle.id);
                clearShellInputBuffer(handle.id);
                shellCwds.delete(handle.id);
                void terminalPersist.remove(handle.id).catch(() => {});
                void shells
                  .append(handle.id, {
                    kind: "exit",
                    ts: new Date().toISOString(),
                    code: info.code,
                    signal: info.signal,
                  })
                  .catch(() => {});
                cleanup?.();
              },
            });
          }
          // Prefill: write command text to the PTY without pressing Enter.
          // Used by session restore to show the previous command at the prompt.
          if (
            typeof body.prefillCmd === "string" &&
            body.prefillCmd.length > 0
          ) {
            setTimeout(() => {
              try {
                handle.write(body.prefillCmd);
              } catch {}
            }, 500);
          }
          return json({ id: handle.id, pid: handle.pid });
        } catch (e) {
          console.warn(
            `supergit daemon: terminal spawn failed owner=${body.ownerId ?? "-"} agent=${agentHint ?? "unknown"} cwd=${body.cwd}: ${
              e instanceof Error ? e.message : String(e)
            }`,
          );
          return json(
            { error: e instanceof Error ? e.message : String(e) },
            { status: 500 },
          );
        }
      }

      // List currently-live shell columns (PTY still alive AND its header
      if (url.pathname === "/api/terminals/persisted" && req.method === "GET") {
        return json(await terminalPersist.list());
      }

      if (
        url.pathname === "/api/terminals/persisted" &&
        req.method === "DELETE"
      ) {
        await terminalPersist.clear();
        return json({ ok: true });
      }

      if (
        url.pathname === "/api/terminals/persisted/remove" &&
        req.method === "POST"
      ) {
        const body = await req.json().catch(() => null);
        if (!body || typeof body.termId !== "string") {
          return json({ error: "termId required" }, { status: 400 });
        }
        await terminalPersist.remove(body.termId);
        return json({ ok: true });
      }

      // file is still present in `<workspace>/shells/`). The UI calls this
      // on mount to repopulate Terminal columns after a reload.
      if (url.pathname === "/api/shells" && req.method === "GET") {
        const headers = await shells.listHeaders();
        // Pull manual titles keyed by `shell:<termId>` so past-shell columns
        // can show / edit a user-set name (same workspace storage the AI
        // session titles use, just a different key prefix).
        const titles = await workspace.listSessionTitles();
        const records = await Promise.all(
          headers.map(async (h) => {
            const alive = terminalBackend.get(h.termId) !== undefined;
            const summary = await shells.cmdSummary(h.termId);
            return {
              termId: h.termId,
              wt: h.wt,
              spawnCwd: h.spawnCwd,
              createdAt: h.createdAt,
              // The cwd sampler hasn't necessarily run yet for a freshly
              // spawned shell — fall back to spawnCwd so the UI can show
              // *something* immediately and refine on the next poll cycle.
              currentCwd: shellCwds.get(h.termId) ?? h.spawnCwd,
              alive,
              cmdCount: summary.count,
              // Last captured cmd line + its timestamp, so the picker can
              // render the most recent command inline as a muted snippet
              // (and sort/age the row by when it was actually used).
              lastCmd: summary.lastLine,
              lastCmdTs: summary.lastTs,
              manualTitle: titles[`shell:${h.termId}`],
            };
          }),
        );
        // Newest first so the UI's restore loop renders recent shells at
        // the front of each worktree's column strip.
        records.sort((a, b) =>
          a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0,
        );
        return json(records);
      }

      // Full transcript of one shell — header + every captured command +
      // the exit entry if the PTY has ended. Powers the read-mode column
      // (ShellView) that lets the user re-read past shell sessions and
      // resume a new one at the last cwd.
      if (url.pathname === "/api/shell-transcript" && req.method === "GET") {
        const termId = url.searchParams.get("termId");
        if (!termId) {
          return json({ error: "?termId required" }, { status: 400 });
        }
        const transcript = await shells.readTranscript(termId);
        if (!transcript) {
          return json({ error: "shell not found" }, { status: 404 });
        }
        const titles = await workspace.listSessionTitles();
        return json({
          ...transcript,
          alive: terminalBackend.get(termId) !== undefined,
          currentCwd: shellCwds.get(termId) ?? transcript.lastCwd,
          manualTitle: titles[`shell:${termId}`],
        });
      }

      if (url.pathname === "/api/terminals" && req.method === "GET") {
        const ownerId = url.searchParams.get("ownerId") ?? undefined;
        const records = terminalBackend.list();
        return json(
          ownerId ? records.filter((r) => r.ownerId === ownerId) : records,
        );
      }

      if (url.pathname === "/api/processes" && req.method === "GET") {
        const routeStarted = Date.now();
        const records = terminalBackend.list().filter((r) => !r.exitedAt);
        let sampleMs = 0;
        let externalMs = 0;
        const sampleStarted = Date.now();
        const samples = await processSamples();
        sampleMs = Date.now() - sampleStarted;
        const tuis = records.map((r) => {
          const s = samples.get(r.pid);
          return {
            id: r.id,
            pid: r.pid,
            agent: r.agent,
            cmd: r.cmd,
            cwd: r.cwd,
            ownerId: r.ownerId,
            createdAt: r.createdAt,
            lastOutputAt: r.lastOutputAt,
            cpuPercent: s?.cpuPercent ?? 0,
            memBytes: s?.memBytes ?? 0,
            kind: "tui" as const,
          };
        });
        // External rows come from a throttled full-machine scan (see
        // externalProcessRows). Do not await that scan on the route:
        // opening Procs should show fresh TUI rows immediately and reuse
        // the last external snapshot while the slow repo/process scan
        // refreshes in the background.
        let externalRows = lastExternalProcessRows;
        const externalStarted = Date.now();
        void externalProcessRows().catch((err) => {
          console.warn(
            `supergit daemon: /api/processes external rows skipped — ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        });
        externalMs = Date.now() - externalStarted;
        const rows = [...tuis, ...externalRows];
        const totalMs = Date.now() - routeStarted;
        if (totalMs > PROCESS_ROUTE_SLOW_MS) {
          console.log(
            `supergit daemon: /api/processes slow total=${totalMs}ms tuiRows=${tuis.length} externalRows=${externalRows.length} sample=${sampleMs}ms external=${externalMs}ms`,
          );
        }
        return json(rows);
      }

      if (
        url.pathname.startsWith("/api/terminals/") &&
        req.method === "DELETE"
      ) {
        const termId = url.pathname.slice("/api/terminals/".length);
        const handle = terminalBackend.get(termId);
        if (!handle) return json({ error: "not found" }, { status: 404 });
        cancelGrace(termId);
        console.log(
          `supergit daemon: terminal delete id=${termId} pid=${handle.pid}`,
        );
        void handle.kill();
        return json({ ok: true });
      }

      if (
        url.pathname.match(/^\/api\/processes\/\d+\/kill$/) &&
        req.method === "POST"
      ) {
        const pid = Number(url.pathname.split("/")[3]);
        const body = (await req.json().catch(() => ({}))) as {
          signal?: string;
        };
        const sig = body.signal === "SIGKILL" ? "SIGKILL" : "SIGTERM";
        try {
          process.kill(pid, sig);
        } catch (e: any) {
          if (e?.code === "ESRCH")
            return json({ error: "process not found" }, { status: 404 });
          return json({ error: e?.message ?? "kill failed" }, { status: 500 });
        }
        return json({ ok: true, signal: sig });
      }

      if (url.pathname === "/api/agents/installed" && req.method === "GET") {
        // Which interactive agent CLIs are installed? Uses
        // `resolveAgentBinary` so multi-install setups (e.g. homebrew
        // codex + bun-installed codex from a self-update) report the
        // newest binary, not whatever PATH order happens to pick.
        // Also probes nvm / fnm / volta / n prefixes so agents
        // installed via node version managers are found even when the
        // daemon's PATH doesn't include them.
        const candidates = ["claude", "codex", "ollama"];
        const resolved = await Promise.all(
          candidates.map(async (name) => ({
            name,
            path: await resolveAgentBinary(name),
          })),
        );
        const installed = resolved.filter(
          (entry): entry is { name: string; path: string } =>
            entry.path !== null,
        );
        return json({ installed });
      }

      if (url.pathname === "/api/ollama/sessions" && req.method === "POST") {
        // Create an empty API-driven Ollama session: a JSONL with just
        // the header (no PTY, no upstream call yet). Returns the new
        // termId so the UI can open it as a SessionView column and
        // start sending /api/ollama/chat requests against it. See
        // plans/ollama.md "Plan: API-driven chat mode".
        const body = (await req.json().catch(() => null)) as {
          model?: unknown;
          wt?: unknown;
          cwd?: unknown;
        } | null;
        const model = typeof body?.model === "string" ? body.model.trim() : "";
        const wt = typeof body?.wt === "string" ? body.wt : "";
        const cwd = typeof body?.cwd === "string" && body.cwd ? body.cwd : wt;
        if (!model) return json({ error: "model required" }, { status: 400 });
        if (!wt) return json({ error: "wt required" }, { status: 400 });
        // Generate a short, picker-friendly termId — same shape as the
        // PTY backend's ids so picker rows and dock dots use the same
        // 8-char prefix. We don't share the PTY backend's id generator
        // because no PTY is being spawned.
        const termId = crypto.randomUUID().replace(/-/g, "").slice(0, 12);
        try {
          await ollamaSessions.writeHeader({
            kind: "header",
            termId,
            wt,
            spawnCwd: cwd,
            model,
            createdAt: new Date().toISOString(),
          });
        } catch (e) {
          return json(
            { error: e instanceof Error ? e.message : String(e) },
            { status: 500 },
          );
        }
        const sourcePath = join(WORKSPACE_PATH, "ollama", `${termId}.jsonl`);
        return json({ termId, model, wt, source: sourcePath });
      }

      if (url.pathname === "/api/ollama/chat" && req.method === "POST") {
        // Stream a chat completion against the Ollama HTTP API. The
        // daemon owns the messages[] array — reconstructs it from the
        // session's JSONL, appends the new user turn, proxies the
        // streamed response back to the client, and writes both turns
        // when the stream completes (or `partial: true` on abort).
        //
        // Cancel semantics: if a stream is already running for this
        // termId, the new POST aborts the prior one. Client disconnect
        // also aborts via the ReadableStream's `cancel` callback.
        const body = (await req.json().catch(() => null)) as {
          termId?: unknown;
          content?: unknown;
        } | null;
        const termId = typeof body?.termId === "string" ? body.termId : "";
        const content = typeof body?.content === "string" ? body.content : "";
        if (!termId) return json({ error: "termId required" }, { status: 400 });
        if (!content.trim()) {
          return json({ error: "content required" }, { status: 400 });
        }
        // Read the prior conversation up front so we can fail fast on a
        // missing/invalid session before opening the SSE stream. The
        // model from this read is the source of truth for the upstream
        // call.
        const prior = await ollamaSessions.readMessagesForChat(termId);
        if (!prior) {
          return json({ error: "ollama session not found" }, { status: 404 });
        }
        // Persist the user turn immediately so it survives an abort
        // before any assistant chunks arrive (and so a refresh during
        // a long generation shows the prompt in the transcript).
        const userTs = new Date().toISOString();
        try {
          await ollamaSessions.appendTurn(termId, {
            kind: "turn",
            ts: userTs,
            role: "user",
            content,
            model: prior.model,
          });
        } catch (e) {
          return json(
            { error: e instanceof Error ? e.message : String(e) },
            { status: 500 },
          );
        }
        // Cancel any prior in-flight stream for this termId.
        const existing = ollamaChatAborts.get(termId);
        if (existing) existing.abort();
        const abort = new AbortController();
        ollamaChatAborts.set(termId, abort);

        const messagesForUpstream = [
          ...prior.messages,
          { role: "user" as const, content },
        ];
        const stream = new ReadableStream<Uint8Array>({
          async start(controller) {
            const send = (event: string, data: unknown): void => {
              try {
                controller.enqueue(
                  sseEncoder.encode(
                    `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`,
                  ),
                );
              } catch {
                // controller closed — client disconnected
              }
            };
            send("meta", { termId, model: prior.model, userTs });
            const collected = { text: "" };
            let partial = false;
            try {
              const res = await fetch(`${OLLAMA_HOST}/api/chat`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  model: prior.model,
                  stream: true,
                  messages: messagesForUpstream,
                }),
                signal: abort.signal,
              });
              if (!res.ok || !res.body) {
                let parsedError: string | null = null;
                try {
                  const errBody = await res.text();
                  try {
                    parsedError =
                      (JSON.parse(errBody) as { error?: string }).error ?? null;
                  } catch {
                    parsedError = errBody.slice(0, 200) || null;
                  }
                } catch {
                  // body unreadable
                }
                send("error", {
                  kind: "ollama_http",
                  message: formatOllamaError(
                    res.status,
                    res.statusText,
                    parsedError,
                    prior.model,
                  ),
                });
                try {
                  controller.close();
                } catch {}
                return;
              }
              const reader = res.body.getReader();
              const dec = new TextDecoder();
              let buf = "";
              while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                buf += dec.decode(value, { stream: true });
                let nl: number;
                while ((nl = buf.indexOf("\n")) !== -1) {
                  const line = buf.slice(0, nl).trim();
                  buf = buf.slice(nl + 1);
                  if (!line) continue;
                  try {
                    const obj = JSON.parse(line) as {
                      message?: { content?: string };
                      done?: boolean;
                      error?: string;
                    };
                    if (obj.error) {
                      send("error", {
                        kind: "ollama_payload",
                        message: obj.error,
                      });
                      try {
                        controller.close();
                      } catch {}
                      return;
                    }
                    const chunk = obj.message?.content ?? "";
                    if (chunk) {
                      collected.text += chunk;
                      send("chunk", { delta: chunk });
                    }
                    if (obj.done) break;
                  } catch {
                    // ignore malformed NDJSON line
                  }
                }
              }
            } catch (e) {
              // AbortError is the expected path when the user cancels.
              // We persist whatever we got as a partial assistant turn
              // rather than throwing it away.
              if ((e as { name?: string })?.name === "AbortError") {
                partial = true;
              } else {
                const msg = e instanceof Error ? e.message : String(e);
                send("error", { kind: "ollama_unreachable", message: msg });
                try {
                  controller.close();
                } catch {}
                if (ollamaChatAborts.get(termId) === abort) {
                  ollamaChatAborts.delete(termId);
                }
                return;
              }
            }
            // Write the assistant turn (partial or complete). Skip if
            // nothing was received AND we weren't aborted — that's the
            // upstream-error path which already closed the stream.
            if (collected.text.length > 0 || partial) {
              try {
                await ollamaSessions.appendTurn(termId, {
                  kind: "turn",
                  ts: new Date().toISOString(),
                  role: "assistant",
                  content: collected.text,
                  model: prior.model,
                  ...(partial ? { partial: true } : {}),
                });
              } catch {
                // Best-effort. The user already saw the response; if
                // disk write fails the next reload will be lossy but
                // the stream itself was fine.
              }
            }
            send("done", { partial });
            try {
              controller.close();
            } catch {}
            if (ollamaChatAborts.get(termId) === abort) {
              ollamaChatAborts.delete(termId);
            }
          },
          cancel() {
            // Client closed the SSE stream (Stop button, tab closed,
            // page nav). Abort the upstream fetch; the catch above
            // persists the partial turn.
            abort.abort();
          },
        });
        return new Response(stream, {
          headers: {
            ...CORS,
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache, no-transform",
            Connection: "keep-alive",
            "X-Accel-Buffering": "no",
          },
        });
      }

      if (
        url.pathname.startsWith("/api/ollama/chat/") &&
        req.method === "DELETE"
      ) {
        // Explicit cancel for an in-flight stream. The client could
        // also just close its EventSource, but a DELETE lets a separate
        // request (e.g. from a different tab) abort the run.
        const termId = url.pathname.slice("/api/ollama/chat/".length);
        const ac = ollamaChatAborts.get(termId);
        if (!ac) return new Response(null, { status: 404, headers: CORS });
        ac.abort();
        return new Response(null, { status: 204, headers: CORS });
      }

      if (url.pathname === "/api/ollama/models" && req.method === "GET") {
        // Lists installed Ollama models for the new-session picker
        // submenu. Hits the local HTTP API first (fast, structured),
        // falls back to `ollama list` if the server isn't running. The
        // picker calls this lazily when the user expands the Ollama row.
        try {
          const models = await listOllamaModels();
          return json({ models });
        } catch (e) {
          return json(
            { error: e instanceof Error ? e.message : String(e), models: [] },
            { status: 500 },
          );
        }
      }

      if (
        url.pathname === "/api/onboarding/describe" &&
        req.method === "POST"
      ) {
        const body = (await req.json().catch(() => null)) as {
          path?: unknown;
        } | null;
        const dirPath = typeof body?.path === "string" ? body.path.trim() : "";
        if (!dirPath) {
          return json({ error: "path required" }, { status: 400 });
        }
        const resolved = resolve(dirPath);

        let entries: { name: string; type: string }[] = [];
        try {
          const dirents = await readdir(resolved, { withFileTypes: true });
          entries = dirents
            .map((d) => ({
              name: d.name,
              type: d.isDirectory() ? "dir" : "file",
            }))
            .sort((a, b) => {
              if (a.type === "dir" && b.type !== "dir") return -1;
              if (a.type !== "dir" && b.type === "dir") return 1;
              return a.name.localeCompare(b.name);
            })
            .slice(0, 80);
        } catch {
          // empty listing is fine — AI can still comment on the path name
        }

        const fileList = entries
          .map((e) => `${e.type === "dir" ? "[dir]" : "     "} ${e.name}`)
          .join("\n");
        const prompt = [
          `I just added this folder to my project dashboard.`,
          `Describe what it contains and how to get started working on it.`,
          `Be concise — 2 to 3 short paragraphs max. Use markdown.`,
          ``,
          `Folder: ${resolved}`,
          entries.length > 0 ? `Contents:\n${fileList}` : `(empty folder)`,
        ].join("\n");

        // --- pick provider by lowest weekly usage (≥20% free) -----------
        type Candidate = { provider: string; free: number };
        const candidates: Candidate[] = [];

        const hasClaude = !!(await resolveAgentBinary("claude"));
        const hasCodex = !!(await resolveAgentBinary("codex"));

        const [claudeResult, codexResult] = await Promise.all([
          hasClaude
            ? fetchClaudeOAuthUsage().catch(() => ({
                usage: null,
                error: null,
              }))
            : Promise.resolve({ usage: null, error: null }),
          hasCodex
            ? fetchCodexOAuthUsage().catch(() => ({ usage: null, error: null }))
            : Promise.resolve({ usage: null, error: null }),
        ]);
        if (claudeResult.usage?.sevenDay) {
          const free = 1 - claudeResult.usage.sevenDay.utilization;
          if (free >= 0.2) candidates.push({ provider: "claude", free });
        }
        if (codexResult.usage?.secondaryWindow) {
          const free = 1 - codexResult.usage.secondaryWindow.utilization;
          if (free >= 0.2) candidates.push({ provider: "codex", free });
        }
        candidates.sort((a, b) => b.free - a.free);

        let provider = candidates[0]?.provider ?? null;
        let ollamaModel: string | undefined;

        if (!provider) {
          // fallback: Ollama
          try {
            const models = await listOllamaModels();
            if (models.length > 0) {
              provider = "ollama";
              ollamaModel = models[0]!.name;
            }
          } catch {
            /* no ollama */
          }
        } else if (provider === "codex") {
          // codex has no non-interactive mode — demote to ollama
          try {
            const models = await listOllamaModels();
            if (models.length > 0) {
              provider = "ollama";
              ollamaModel = models[0]!.name;
            }
          } catch {
            // keep codex? no — we can't run it without a TUI. drop.
            provider = null;
          }
        }

        if (!provider && !ollamaModel) {
          // last resort: use Claude even if > 80% utilized
          if (hasClaude) provider = "claude";
        }

        if (!provider) {
          return json(
            {
              error: "no AI provider available (install Claude CLI or Ollama)",
            },
            { status: 503 },
          );
        }

        // If Ollama was picked but no model chosen yet, resolve now
        if (provider === "ollama" && !ollamaModel) {
          try {
            const models = await listOllamaModels();
            ollamaModel = models[0]?.name;
          } catch {
            /* keep going */
          }
          if (!ollamaModel) {
            return json(
              { error: "ollama has no models installed" },
              { status: 503 },
            );
          }
        }

        // --- stream response as SSE ------------------------------------
        const stream = new ReadableStream<Uint8Array>({
          async start(controller) {
            const send = (event: string, data: unknown): void => {
              try {
                controller.enqueue(
                  sseEncoder.encode(
                    `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`,
                  ),
                );
              } catch {
                /* controller closed */
              }
            };

            const modelLabel =
              provider === "ollama"
                ? ollamaModel!
                : provider === "claude"
                  ? "Claude"
                  : provider!;
            send("meta", { provider, model: modelLabel });

            try {
              if (provider === "ollama") {
                const res = await fetch(`${OLLAMA_HOST}/api/chat`, {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({
                    model: ollamaModel,
                    stream: true,
                    messages: [{ role: "user", content: prompt }],
                  }),
                  signal: AbortSignal.timeout(120_000),
                });
                if (!res.ok || !res.body) {
                  let errMsg = `Ollama ${res.status}`;
                  try {
                    const eb = await res.text();
                    const parsed = JSON.parse(eb) as { error?: string };
                    if (parsed.error) errMsg = parsed.error;
                  } catch {}
                  send("error", { message: errMsg });
                  try {
                    controller.close();
                  } catch {}
                  return;
                }
                const reader = res.body.getReader();
                const dec = new TextDecoder();
                let buf = "";
                while (true) {
                  const { done, value } = await reader.read();
                  if (done) break;
                  buf += dec.decode(value, { stream: true });
                  let nl: number;
                  while ((nl = buf.indexOf("\n")) !== -1) {
                    const line = buf.slice(0, nl).trim();
                    buf = buf.slice(nl + 1);
                    if (!line) continue;
                    try {
                      const obj = JSON.parse(line) as {
                        message?: { content?: string };
                        done?: boolean;
                      };
                      const chunk = obj.message?.content ?? "";
                      if (chunk) send("chunk", { delta: chunk });
                      if (obj.done) break;
                    } catch {
                      /* skip */
                    }
                  }
                }
              } else if (provider === "claude") {
                // claude -p streams to stdout in print mode
                const claudeBin =
                  (await resolveAgentBinary("claude")) ?? "claude";
                const proc = Bun.spawn(
                  [claudeBin, "-p", "--output-format", "text", prompt],
                  { cwd: resolved, stdout: "pipe", stderr: "ignore" },
                );
                const reader = proc.stdout.getReader();
                const dec = new TextDecoder();
                while (true) {
                  const { done, value } = await reader.read();
                  if (done) break;
                  const text = dec.decode(value, { stream: true });
                  if (text) send("chunk", { delta: text });
                }
                await proc.exited;
              }
            } catch (e) {
              const msg = e instanceof Error ? e.message : String(e);
              send("error", { message: msg });
            }

            send("done", {});
            try {
              controller.close();
            } catch {}
          },
        });

        return new Response(stream, {
          headers: {
            ...CORS,
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache, no-transform",
            Connection: "keep-alive",
            "X-Accel-Buffering": "no",
          },
        });
      }

      if (url.pathname === "/api/sessions/summarize" && req.method === "GET") {
        // Cached-summary lookup. Returns the stored markdown + frontmatter
        // when a summary exists for this session, plus a staleness flag
        // the UI uses to decide between "Cached" and "Stale" badges.
        const source = url.searchParams.get("source");
        if (!source)
          return json({ error: "?source= required" }, { status: 400 });
        const resolved = resolveSessionAgent(source);
        if (!resolved) {
          return json(
            { error: "source is outside any known agent root" },
            { status: 403 },
          );
        }
        const { summary, stale } = await summaries.staleness(source);
        if (!summary) return json({ summary: null });
        return json({
          summary: { frontmatter: summary.frontmatter, body: summary.body },
          stale,
        });
      }

      if (
        url.pathname === "/api/sessions/summarize" &&
        req.method === "DELETE"
      ) {
        const source = url.searchParams.get("source");
        if (!source)
          return json({ error: "?source= required" }, { status: 400 });
        const resolved = resolveSessionAgent(source);
        if (!resolved) {
          return json(
            { error: "source is outside any known agent root" },
            { status: 403 },
          );
        }
        const removed = await summaries.delete(source);
        aiTitles.delete(source.toLowerCase());
        if (!removed) {
          return new Response(null, { status: 404, headers: CORS });
        }
        return new Response(null, { status: 204, headers: CORS });
      }

      if (url.pathname === "/api/sessions/summarize" && req.method === "POST") {
        // Stream a fresh summary from a local Ollama model. Two phases:
        //   1. sample the session into a compact prompt (pure, fast),
        //   2. open a stream to Ollama's /api/chat and forward each
        //      content delta to the SPA as an SSE `chunk` event.
        // On `done` we persist the joined body to <workspace>/summaries.
        const body = (await req.json().catch(() => null)) as {
          source?: unknown;
          model?: unknown;
        } | null;
        const source = typeof body?.source === "string" ? body.source : "";
        const model = typeof body?.model === "string" ? body.model : "";
        if (!source || !model) {
          return json({ error: "source and model required" }, { status: 400 });
        }
        const resolved = resolveSessionAgent(source);
        if (!resolved) {
          return json(
            { error: "source is outside any known agent root" },
            { status: 403 },
          );
        }
        const parsed = await parseSessionFile(resolved.agent, source);
        const sampled = sampleSessionForSummary(parsed.messages);
        // Stat the source so we can record its mtime alongside the
        // summary — that's what the staleness check compares later.
        let sourceMtimeMs = 0;
        try {
          sourceMtimeMs = (await fsStat(source)).mtimeMs;
        } catch {
          // Source missing — proceed but record 0; the next staleness
          // check will surface it as stale, which is correct.
        }

        const startedAt = Date.now();
        const abort = new AbortController();
        const stream = new ReadableStream<Uint8Array>({
          async start(controller) {
            const send = (event: string, data: unknown) => {
              try {
                controller.enqueue(
                  sseEncoder.encode(
                    `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`,
                  ),
                );
              } catch {
                // controller already closed — caller cancelled
              }
            };

            send("meta", {
              model,
              agent: resolved.agent,
              sessionId: parsed.sessionId || undefined,
              totalMessages: sampled.totalMessages,
              includedMessages: sampled.includedMessages,
              truncatedMessages: sampled.truncatedMessages,
              estimatedTokens: sampled.estimatedTokens,
            });

            if (sampled.includedMessages === 0) {
              send("error", {
                kind: "empty",
                message:
                  "Nothing to summarise: no user / assistant text in this session.",
              });
              try {
                controller.close();
              } catch {}
              return;
            }

            const agentLabel =
              resolved.agent === "claude"
                ? "Claude Code"
                : resolved.agent === "codex"
                  ? "Codex"
                  : "a local Ollama model";
            const systemPrompt =
              `You are a precise technical summariser. The excerpt below is a chat between you (the developer) and ${agentLabel}. ` +
              "Write a single brief paragraph — ideally under 300 characters — describing what you were trying to do and what was decided or built. " +
              'Address the developer as "you", not "the user". ' +
              "Plain text only: no markdown, no bullets, no headings, no backticks. " +
              "Do not echo the transcript.";

            const fullBody: { collected: string } = { collected: "" };
            try {
              const res = await fetch("http://127.0.0.1:11434/api/chat", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  model,
                  stream: true,
                  messages: [
                    { role: "system", content: systemPrompt },
                    { role: "user", content: sampled.prompt },
                    {
                      role: "user",
                      content: "Now summarise the conversation above.",
                    },
                  ],
                  options: {
                    num_ctx: Math.max(
                      8192,
                      Math.ceil(sampled.estimatedTokens * 1.5) + 2048,
                    ),
                  },
                  think: false,
                }),
                signal: abort.signal,
              });
              if (!res.ok || !res.body) {
                let parsedError: string | null = null;
                try {
                  const errBody = await res.text();
                  try {
                    parsedError =
                      (JSON.parse(errBody) as { error?: string }).error ?? null;
                  } catch {
                    parsedError = errBody.slice(0, 200) || null;
                  }
                } catch {
                  // body unreadable
                }
                send("error", {
                  kind: "ollama_http",
                  message: formatOllamaError(
                    res.status,
                    res.statusText,
                    parsedError,
                    model,
                  ),
                });
                try {
                  controller.close();
                } catch {}
                return;
              }
              const reader = res.body.getReader();
              const dec = new TextDecoder();
              let buf = "";
              while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                buf += dec.decode(value, { stream: true });
                let nl: number;
                while ((nl = buf.indexOf("\n")) !== -1) {
                  const line = buf.slice(0, nl).trim();
                  buf = buf.slice(nl + 1);
                  if (!line) continue;
                  try {
                    const obj = JSON.parse(line) as {
                      message?: { content?: string };
                      done?: boolean;
                      error?: string;
                    };
                    if (obj.error) {
                      send("error", {
                        kind: "ollama_payload",
                        message: obj.error,
                      });
                      try {
                        controller.close();
                      } catch {}
                      return;
                    }
                    const chunk = obj.message?.content ?? "";
                    if (chunk) {
                      fullBody.collected += chunk;
                      send("chunk", { delta: chunk });
                    }
                    if (obj.done) break;
                  } catch {
                    // ignore malformed line
                  }
                }
              }
            } catch (e) {
              const msg = e instanceof Error ? e.message : String(e);
              send("error", { kind: "ollama_unreachable", message: msg });
              try {
                controller.close();
              } catch {}
              return;
            }

            const elapsedMs = Date.now() - startedAt;
            const summaryBody = stripThinkingArtifacts(fullBody.collected);

            // Second, tiny Ollama call: turn the finished summary into a
            // short title. Non-streaming, thinking off. Best-effort — a
            // failure here leaves the title undefined and never blocks the
            // (already-streamed, about-to-be-saved) summary.
            let aiTitle: string | undefined;
            if (summaryBody.trim()) {
              try {
                const titleRes = await fetch(`${OLLAMA_HOST}/api/chat`, {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({
                    model,
                    stream: false,
                    think: false,
                    messages: [
                      {
                        role: "system",
                        content:
                          "You name developer chat sessions. Given a summary, reply with a single concise title of 3 to 6 words. " +
                          'Plain text only: no quotes, no markdown, no trailing punctuation, no preamble like "Title:". Reply with the title and nothing else.',
                      },
                      {
                        role: "user",
                        content: `Summary:\n${summaryBody}\n\nTitle:`,
                      },
                    ],
                    options: { num_ctx: 4096 },
                  }),
                  signal: abort.signal,
                });
                if (titleRes.ok) {
                  const tj = (await titleRes.json()) as {
                    message?: { content?: string };
                  };
                  const cleaned = cleanAiTitle(tj.message?.content ?? "");
                  if (cleaned) aiTitle = cleaned;
                }
              } catch {
                // Title is a nicety; never fail the summary over it.
              }
            }

            try {
              await summaries.write(source, {
                agent: resolved.agent,
                sessionId: parsed.sessionId || undefined,
                title: aiTitle,
                model,
                sourceMtimeMs,
                generatedAt: new Date(startedAt).toISOString(),
                includedMessages: sampled.includedMessages,
                totalMessages: sampled.totalMessages,
                truncatedMessages: sampled.truncatedMessages,
                estimatedTokens: sampled.estimatedTokens,
                elapsedMs,
                body: summaryBody,
              });
              // Keep the in-memory enrichment map in sync so the new title
              // shows up on the next /api/repos poll without a disk read.
              const key = source.toLowerCase();
              if (aiTitle) aiTitles.set(key, aiTitle);
              else aiTitles.delete(key);
            } catch (e) {
              const msg = e instanceof Error ? e.message : String(e);
              send("error", { kind: "write_failed", message: msg });
              try {
                controller.close();
              } catch {}
              return;
            }

            // Debug log: write the full prompt + response so bad
            // summaries (thinking artifacts, verbosity) can be
            // diagnosed after the fact without reproducing the run.
            try {
              const debugDir = join(workspace.path, ".debugging", "summaries");
              await fsMkdir(debugDir, { recursive: true });
              const ts = new Date(startedAt)
                .toISOString()
                .replace(/[:.]/g, "-");
              const slug = source.replace(/[/\\]/g, "__").slice(-80);
              const debugPath = join(debugDir, `${ts}__${slug}.md`);
              const debugContent = [
                `# Session summary debug log`,
                ``,
                `- **source:** \`${source}\``,
                `- **model:** ${model}`,
                `- **agent:** ${resolved.agent}`,
                `- **sessionId:** ${parsed.sessionId || "(none)"}`,
                `- **generatedAt:** ${new Date(startedAt).toISOString()}`,
                `- **elapsedMs:** ${elapsedMs}`,
                `- **totalMessages:** ${sampled.totalMessages}`,
                `- **includedMessages:** ${sampled.includedMessages}`,
                `- **truncatedMessages:** ${sampled.truncatedMessages}`,
                `- **estimatedTokens:** ${sampled.estimatedTokens}`,
                ``,
                `## System prompt`,
                ``,
                "```",
                systemPrompt,
                "```",
                ``,
                `## Sampled prompt (${sampled.prompt.length} chars)`,
                ``,
                "```",
                sampled.prompt,
                "```",
                ``,
                `## Response (${fullBody.collected.length} chars)`,
                ``,
                "```",
                fullBody.collected,
                "```",
                ``,
              ].join("\n");
              await fsWriteFile(debugPath, debugContent);
            } catch {
              // Debug logging is best-effort; never block the summary.
            }

            send("done", { elapsedMs, title: aiTitle });
            setTimeout(() => {
              try {
                controller.close();
              } catch {}
            }, 200);
          },
          cancel() {
            abort.abort();
          },
        });
        return new Response(stream, {
          headers: {
            ...CORS,
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache, no-transform",
            Connection: "keep-alive",
            "X-Accel-Buffering": "no",
          },
        });
      }

      // ──────────────────────────────────────────────────────────────
      // Session repair — diagnose and fix broken parent chains in
      // Claude Code JSONL files.
      // ──────────────────────────────────────────────────────────────

      if (url.pathname === "/api/sessions/repair" && req.method === "POST") {
        const body = (await req.json().catch(() => null)) as {
          source?: unknown;
          dryRun?: unknown;
        } | null;
        const source = typeof body?.source === "string" ? body.source : "";
        const dryRun = body?.dryRun === true;
        if (!source) {
          return json({ error: "source required" }, { status: 400 });
        }
        const resolved = resolveSessionAgent(source);
        if (!resolved) {
          return json(
            { error: "source is outside any known agent root" },
            { status: 403 },
          );
        }
        if (resolved.agent !== "claude") {
          return json(
            { error: "repair is only supported for Claude sessions" },
            { status: 400 },
          );
        }
        try {
          const text = await readFile(resolved.normalised, "utf-8");
          const diagnosis = diagnoseClaudeSession(text);
          const needsRepair =
            diagnosis.brokenLinks.length > 0 || diagnosis.orphanedTail !== null;
          if (dryRun || !needsRepair) {
            return json({
              diagnosis: {
                totalEntries: diagnosis.totalEntries,
                chainEntries: diagnosis.chainEntries,
                brokenLinks: diagnosis.brokenLinks.length,
                orphanedTail: diagnosis.orphanedTail
                  ? {
                      lineCount: diagnosis.orphanedTail.lineCount,
                      messageCountBefore:
                        diagnosis.orphanedTail.messageCountBefore,
                      messageCountAfter:
                        diagnosis.orphanedTail.messageCountAfter,
                    }
                  : null,
                details: diagnosis.brokenLinks.map((b) => ({
                  missingUuid: b.missingUuid.slice(0, 8),
                  referencedBy: b.referencedBy.slice(0, 8),
                  lineIndex: b.lineIndex,
                })),
              },
              repaired: false,
            });
          }
          const result = await repairClaudeSession(resolved.normalised);
          return json({
            diagnosis: {
              totalEntries: diagnosis.totalEntries,
              chainEntries: diagnosis.chainEntries,
              brokenLinks: diagnosis.brokenLinks.length,
              orphanedTail: diagnosis.orphanedTail
                ? {
                    lineCount: diagnosis.orphanedTail.lineCount,
                    messageCountBefore:
                      diagnosis.orphanedTail.messageCountBefore,
                    messageCountAfter: diagnosis.orphanedTail.messageCountAfter,
                  }
                : null,
              details: diagnosis.brokenLinks.map((b) => ({
                missingUuid: b.missingUuid.slice(0, 8),
                referencedBy: b.referencedBy.slice(0, 8),
                lineIndex: b.lineIndex,
              })),
            },
            repaired: true,
            repairedCount: result.repaired,
            trimmedLines: result.trimmedLines,
            backupPath: result.backupPath,
          });
        } catch (err) {
          return json(
            { error: err instanceof Error ? err.message : "Repair failed" },
            { status: 500 },
          );
        }
      }

      // ──────────────────────────────────────────────────────────────
      // Session-sharing routes — receive an offer from a peer, list
      // pending offers, accept / decline. See plans/PLAN-SESSION-SHARE.md.
      // Sender-side helpers live further down; storage + path rewrites
      // are in session-share-store.ts (tested separately).
      //
      // Best-effort sender callback. v1 skips this — the manifest
      // doesn't yet carry a return URL, so we can't post back without
      // additional wiring. Receiver-side acceptance still works; the
      // sender's UI just won't auto-flip the badge until the user
      // refreshes. Tracked in PLAN-SESSION-SHARE.md → rollout step 3
      // (peers panel adds peer URLs, at which point this can call
      // POST <peer>/api/sessions/offer-status).
      async function notifyOfferStatus(
        _manifest: SessionShareManifest,
        _status: "accepted" | "declined",
      ): Promise<void> {
        return;
      }
      // ──────────────────────────────────────────────────────────────

      /** Resolve an origin remote against the receiver's repos.json by
       *  running `git remote -v` for each repo and matching on the
       *  normalised URL. Worktree lookup is best-effort: if the origin
       *  manifest carries a worktree path, return the receiver's
       *  worktree with the matching branch name (last path segment)
       *  when present; otherwise leave undefined. */
      const repoLookup: RepoLookup = async (
        originRemote,
        originWorktreePath,
      ) => {
        const target = normalizeRemote(originRemote);
        if (!target) return null;
        const repos = await workspace.listRepos();
        for (const repo of repos) {
          const remotes = await listRemotes(repo.path);
          const hit = remotes.find((r) => normalizeRemote(r.url) === target);
          if (!hit) continue;
          let localWorktreePath: string | undefined;
          if (originWorktreePath) {
            const wantedName = originWorktreePath.split(/[\\/]/).pop() ?? "";
            if (wantedName) {
              const wts = await listWorktrees(repo.path);
              // Normalize both sides to forward slashes — Windows
              // worktrees use `\` which would never match the hard
              // `/` separator we previously used, so cross-platform
              // shares from a Mac sender silently failed to locate
              // the receiver's worktree even when one existed.
              const m = wts.find((w) =>
                w.path.replace(/\\/g, "/").endsWith(`/${wantedName}`),
              );
              if (m) localWorktreePath = m.path;
            }
          }
          return { localRepoPath: repo.path, localWorktreePath };
        }
        return null;
      };

      if (url.pathname === "/api/identity" && req.method === "GET") {
        // Surface our own (id, label) — UI uses this in the header so
        // the user can see/edit how peers see them.
        if (!peerIdentity) {
          return json({ error: "identity not ready" }, { status: 503 });
        }
        return json({ ...peerIdentity, buildTime: DAEMON_BUILD_TIME });
      }

      if (url.pathname === "/api/identity" && req.method === "PATCH") {
        // Rename. Updates the disk file, restarts the mDNS advert so
        // peers see the new label, then echoes the new state.
        const body = (await req.json().catch(() => null)) as {
          label?: unknown;
        } | null;
        if (typeof body?.label !== "string") {
          return json({ error: "label (string) required" }, { status: 400 });
        }
        try {
          peerIdentity = await setPeerLabel(workspace.path, body.label);
          if (peerModeEnabled) await startPeerDiscovery();
          return json(peerIdentity);
        } catch (e) {
          return json(
            { error: e instanceof Error ? e.message : String(e) },
            { status: 400 },
          );
        }
      }

      if (url.pathname === "/api/peer-discovery" && req.method === "GET") {
        return json({ enabled: peerModeEnabled });
      }

      if (url.pathname === "/api/peer-discovery" && req.method === "POST") {
        const body = (await req.json().catch(() => null)) as {
          enabled?: unknown;
        } | null;
        const enabled = body?.enabled === true;
        if (enabled && !peerModeEnabled) {
          await startPeerDiscovery();
          await workspace.patchPrefs({ peerDiscovery: "on" });
        } else if (!enabled && peerModeEnabled) {
          await stopPeerDiscovery();
          await workspace.patchPrefs({ peerDiscovery: "off" });
        }
        broadcast("peerDiscovery", { enabled: peerModeEnabled });
        return json({ enabled: peerModeEnabled });
      }

      if (url.pathname === "/api/peers" && req.method === "GET") {
        // Other supergit daemons discovered via mDNS on the LAN. The
        // Share dialog renders this as a clickable list; empty list is
        // fine — the dialog falls back to manual host:port.
        //
        // disambiguatePeerLabels suffixes labels in any collision group
        // (most often "marcel@windows-pc" advertised by both the dev
        // daemon on 7777 and the prod daemon on 27787) so the user can
        // tell sibling daemons apart in the UI without us having to
        // teach every consumer about ports.
        //
        // ?diag=1 appends mDNS health info (enabled, interface, errors)
        // so the Share dialog or curl can surface why discovery isn't
        // working without tailing daemon logs.
        const raw = peerDiscovery?.peers() ?? [];
        const resp: Record<string, unknown> = {
          peers: disambiguatePeerLabels(raw),
        };
        if (url.searchParams.get("diag") === "1") {
          resp.discovery = peerDiscovery?.diagnostics() ?? {
            enabled: false,
            interfaceAddress: null,
            port: PORT,
            initError: "peer discovery not initialized",
            platform: process.platform,
          };
        }
        return json(resp);
      }

      // ──────────────────────────────────────────────────────────────
      // Peer-to-peer message inbox. Tiny: max MAX_BODY_BYTES per
      // message, last 5 per sender, no chat threading. The receiver
      // never auto-acts on body content — UI shows monospace + a
      // Copy button. Mute is a receiver-side preference.
      // ──────────────────────────────────────────────────────────────

      if (url.pathname === "/api/messages" && req.method === "GET") {
        const [inbox, mutes] = await Promise.all([
          getMessages(workspace.path),
          listMutes(workspace.path),
        ]);
        return json({ inbox, mutes });
      }

      if (url.pathname === "/api/messages/send" && req.method === "POST") {
        // Sender side — POST our message to the chosen peer's
        // /api/messages/receive endpoint, then mirror the outbound
        // copy into our own inbox under the recipient peer's row so
        // the UI can show sent history alongside received.
        const body = (await req.json().catch(() => null)) as {
          peerHost?: unknown;
          peerPort?: unknown;
          body?: unknown;
        } | null;
        const peerHost =
          typeof body?.peerHost === "string" ? body.peerHost : "";
        const peerPort = typeof body?.peerPort === "number" ? body.peerPort : 0;
        const text = typeof body?.body === "string" ? body.body : "";
        if (!peerHost || !peerPort || !text) {
          return json(
            { error: "peerHost, peerPort, body (non-empty string) required" },
            { status: 400 },
          );
        }
        if (text.length > MAX_BODY_BYTES) {
          return json(
            { error: `body exceeds MAX_BODY_BYTES (${MAX_BODY_BYTES})` },
            { status: 413 },
          );
        }
        if (!peerIdentity) {
          return json({ error: "identity not ready" }, { status: 503 });
        }
        const payload = {
          from: { id: peerIdentity.id, label: peerIdentity.label },
          body: text,
          sentAt: new Date().toISOString(),
          // Stable delivery id so a retry (after a dropped ACK) is
          // deduped by the receiver instead of duplicated.
          id: crypto.randomUUID(),
        };
        const peerUrl = `http://${peerHost}:${peerPort}/api/messages/receive`;
        let peerRes: Response;
        try {
          peerRes = await fetch(peerUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
          });
        } catch (e) {
          return json(
            {
              error:
                "could not reach peer: " +
                (e instanceof Error ? e.message : String(e)),
            },
            { status: 502 },
          );
        }
        if (peerRes.status !== 202) {
          const errText = await peerRes.text().catch(() => "");
          return json(
            { error: `peer rejected message (${peerRes.status}): ${errText}` },
            { status: 502 },
          );
        }
        // Resolve the recipient's stable peer id + label from the mDNS
        // registry so the local sent-history row is grouped under the
        // same peer the receiver shows up under. Falls back to a
        // synthetic id derived from host:port when the peer isn't
        // currently advertising (manual host:port entry).
        const recipient = (peerDiscovery?.peers() ?? []).find(
          (p) => p.host === peerHost && p.port === peerPort,
        );
        const toId = recipient?.id ?? `manual:${peerHost}:${peerPort}`;
        const toLabel = recipient?.label ?? `${peerHost}:${peerPort}`;
        await addOutgoingMessage(
          workspace.path,
          { id: toId, label: toLabel },
          text,
          payload.sentAt,
        );
        broadcast("change", {
          kind: "message_sent",
          to: { id: toId, label: toLabel },
        });
        return json({ ok: true, sentAt: payload.sentAt }, { status: 202 });
      }

      if (url.pathname === "/api/messages/receive" && req.method === "POST") {
        // Receiver side — another daemon delivers a message to us.
        // Validate, store in the ring buffer, broadcast a change so
        // the dashboard can fire its toast and update the pill count.
        // The sender knows nothing about our mute state; we still
        // store muted messages (so they appear when the mute lifts)
        // but suppress the toast.
        const body = (await req.json().catch(() => null)) as {
          from?: { id?: unknown; label?: unknown };
          body?: unknown;
          sentAt?: unknown;
          id?: unknown;
        } | null;
        const deliveryId = typeof body?.id === "string" ? body.id : undefined;
        const fromId =
          body?.from && typeof body.from.id === "string" ? body.from.id : "";
        const fromLabel =
          body?.from && typeof body.from.label === "string"
            ? body.from.label
            : "";
        const text = typeof body?.body === "string" ? body.body : "";
        const sentAt = typeof body?.sentAt === "string" ? body.sentAt : "";
        if (!fromId || !fromLabel || !text || !sentAt) {
          return json(
            { error: "from.id, from.label, body, sentAt all required" },
            { status: 400 },
          );
        }
        if (text.length > MAX_BODY_BYTES) {
          return json(
            { error: `body exceeds MAX_BODY_BYTES (${MAX_BODY_BYTES})` },
            { status: 413 },
          );
        }
        await addIncomingMessage(workspace.path, {
          from: { id: fromId, label: fromLabel },
          body: text,
          sentAt,
          id: deliveryId,
        });
        const muted = await isPeerMuted(workspace.path, fromId);
        // A short single-line preview so the toast can show the gist
        // instead of just "click to read". Collapse whitespace and cap
        // length — the full body lives in the inbox.
        const preview = text.replace(/\s+/g, " ").trim().slice(0, 140);
        broadcast("change", {
          kind: "message_received",
          from: { id: fromId, label: fromLabel },
          preview,
          muted,
        });
        return json({ ok: true }, { status: 202 });
      }

      const muteMatch = url.pathname.match(/^\/api\/messages\/mute$/);
      if (muteMatch && req.method === "POST") {
        const body = (await req.json().catch(() => null)) as {
          peerId?: unknown;
          durationMinutes?: unknown;
        } | null;
        const peerId = typeof body?.peerId === "string" ? body.peerId : "";
        const dur =
          typeof body?.durationMinutes === "number" ? body.durationMinutes : 0;
        if (!peerId || !Number.isFinite(dur) || dur <= 0) {
          return json(
            { error: "peerId, durationMinutes (positive number) required" },
            { status: 400 },
          );
        }
        await mutePeer(workspace.path, peerId, dur);
        broadcast("change", { kind: "message_mute", peerId });
        return new Response(null, { status: 204, headers: CORS });
      }

      if (url.pathname === "/api/messages/unmute" && req.method === "POST") {
        const body = (await req.json().catch(() => null)) as {
          peerId?: unknown;
        } | null;
        const peerId = typeof body?.peerId === "string" ? body.peerId : "";
        if (!peerId) {
          return json({ error: "peerId required" }, { status: 400 });
        }
        await unmutePeer(workspace.path, peerId);
        broadcast("change", { kind: "message_unmute", peerId });
        return new Response(null, { status: 204, headers: CORS });
      }

      if (url.pathname === "/api/messages/delete" && req.method === "POST") {
        const body = (await req.json().catch(() => null)) as {
          peerId?: unknown;
          messageId?: unknown;
        } | null;
        const peerId = typeof body?.peerId === "string" ? body.peerId : "";
        const messageId =
          typeof body?.messageId === "string" ? body.messageId : "";
        if (!peerId || !messageId) {
          return json({ error: "peerId, messageId required" }, { status: 400 });
        }
        const deleted = await deleteMessage(workspace.path, peerId, messageId);
        if (!deleted) {
          return json({ error: "message not found" }, { status: 404 });
        }
        broadcast("change", { kind: "message_deleted", peerId, messageId });
        return new Response(null, { status: 204, headers: CORS });
      }

      if (url.pathname === "/api/copy-targets" && req.method === "GET") {
        // List every worktree across every repo in this workspace as a
        // potential "Copy to" target. The UI shows them grouped by repo
        // and lets the user pick one; the session JSONL is rewritten
        // from the source cwd to the target worktree path.
        const repos = await workspace.listRepos();
        const targets: Array<{
          repoName: string;
          repoPath: string;
          worktrees: Array<{ path: string; branch: string }>;
        }> = [];
        for (const r of repos) {
          const wts = await listWorktrees(r.path).catch(() => []);
          targets.push({
            repoName: r.name,
            repoPath: r.path,
            worktrees: wts.map((w) => ({ path: w.path, branch: w.branch })),
          });
        }
        return json({ targets });
      }

      if (url.pathname === "/api/sessions/copy-to" && req.method === "POST") {
        const body = (await req.json().catch(() => null)) as {
          source?: unknown;
          targetCwd?: unknown;
        } | null;
        const source = typeof body?.source === "string" ? body.source : "";
        const targetCwd =
          typeof body?.targetCwd === "string" ? body.targetCwd : "";
        if (!source || !targetCwd) {
          return json(
            { error: "source and targetCwd required" },
            { status: 400 },
          );
        }
        const resolved = resolveSessionAgent(source);
        if (!resolved) {
          return json({ error: "unknown session source" }, { status: 404 });
        }
        const parsed = await parseSessionFile(resolved.agent, source);
        const sourceCwd = parsed.cwd ?? "";
        if (!sourceCwd) {
          return json(
            { error: "session has no cwd — cannot rewrite paths" },
            { status: 400 },
          );
        }
        const result = await copySessionToWorktree({
          source,
          sourceCwd,
          targetCwd,
        });
        if (!result.ok) {
          return json({ error: result.error }, { status: 409 });
        }
        // Broadcast so the UI refreshes its agent list + session counts.
        // The copiedTo path is a new JSONL under the Claude projects dir
        // for targetCwd — detectAgents will pick it up on the next
        // /api/repos refresh.
        await events.append({
          type: "session_copied",
          actor: "user",
          payload: {
            source,
            targetCwd,
            copiedTo: result.copiedTo,
          },
        });
        broadcast("change", {
          kind: "session_copied",
          copiedTo: result.copiedTo,
        });
        return json({ ok: true, copiedTo: result.copiedTo });
      }

      if (url.pathname === "/api/sessions/offer" && req.method === "POST") {
        // Incoming offer from a peer daemon. Validate, store as pending,
        // fire the receiver-side event, respond 202.
        const body = (await req.json().catch(() => null)) as {
          manifest?: unknown;
          jsonl?: unknown;
        } | null;
        if (!body || typeof body !== "object") {
          return json({ error: "body required" }, { status: 400 });
        }
        const v = validateManifest(body.manifest);
        if (!v.ok) {
          return json({ error: v.error }, { status: 400 });
        }
        if (typeof body.jsonl !== "string") {
          return json({ error: "jsonl must be a string" }, { status: 400 });
        }
        const manifest = body.manifest as SessionShareManifest;
        await storePendingOffer(workspace.path, manifest, body.jsonl);
        await events.append({
          type: "session_invite_received",
          actor: "supergit",
          payload: {
            offerId: manifest.offerId,
            sid: manifest.sid,
            originMachine: manifest.originMachine,
            originRepoRemote: manifest.originRepoRemote,
            toolOutputs: manifest.toolOutputs,
          },
        });
        broadcast("change", {
          kind: "session_invite_received",
          offerId: manifest.offerId,
        });
        return json(
          { offerId: manifest.offerId, status: "pending" },
          { status: 202 },
        );
      }

      if (url.pathname === "/api/sessions/invites" && req.method === "GET") {
        // Inbox listing for the receiver-side UI. Also surfaces
        // needsClone so the card can offer "Clone repo first" without
        // a second round-trip to the daemon.
        const offers = await listPendingOffers(workspace.path);
        const enriched = await Promise.all(
          offers.map(async (o) => {
            const lookup = await repoLookup(
              o.manifest.originRepoRemote,
              o.manifest.originWorktreePath,
            );
            return {
              manifest: o.manifest,
              receivedAt: o.receivedAt,
              needsClone: lookup === null,
            };
          }),
        );
        return json({ invites: enriched });
      }

      const inviteAcceptMatch = url.pathname.match(
        /^\/api\/sessions\/invites\/([^/]+)\/accept$/,
      );
      if (inviteAcceptMatch && req.method === "POST") {
        const offerId = inviteAcceptMatch[1]!;
        // Body may carry { mode: "replace" | "keep_both" | "merge" }
        // when the user has already resolved a previous collision
        // prompt. Default (no body / no mode) is "abort_if_exists" —
        // the safe choice.
        const body = (await req.json().catch(() => null)) as {
          mode?: unknown;
        } | null;
        const mode =
          body?.mode === "replace" ||
          body?.mode === "keep_both" ||
          body?.mode === "merge"
            ? body.mode
            : "abort_if_exists";

        const result = await acceptOffer({
          workspaceDir: workspace.path,
          offerId,
          repoLookup,
          mode,
        });
        if (!result.ok) {
          if (result.error === "not_found") {
            return json({ error: "not_found" }, { status: 404 });
          }
          if (result.error === "needs_clone") {
            // Receiver needs to add the repo before accepting. Re-load
            // the manifest so the UI can surface the missing remote.
            const offers = await listPendingOffers(workspace.path);
            const pending = offers.find((o) => o.manifest.offerId === offerId);
            return json(
              {
                error: "needs_clone",
                remote: pending?.manifest.originRepoRemote,
              },
              { status: 409 },
            );
          }
          if (result.error === "merge_failed") {
            // Merge attempt threw or the write failed; existing file
            // has been restored from backup. Re-send divergence so the
            // UI can keep showing the conflict view (replace / keep
            // both / cancel) alongside the failure reason.
            return json(
              {
                error: "merge_failed",
                reason: result.reason,
                divergence: result.divergence,
                existingPath: result.existingPath,
              },
              { status: 409 },
            );
          }
          // result.error === "exists" — surface divergence stats so
          // the UI can show "update from N to M" or "diverged" copy
          // and the right three buttons.
          return json(
            {
              error: "exists",
              divergence: result.divergence,
              existingPath: result.existingPath,
            },
            { status: 409 },
          );
        }
        // Seed the manualTitle store with the sender's title so the
        // session-column header shows it without the user having to
        // re-name. The session list / activity popover already read
        // wt.agents[].title (which scanImported pulls from the
        // sidecar), but SessionHeader reads from /api/session's
        // manualTitle — without this the header showed the
        // "Name this session…" placeholder for imported sessions.
        // No-op when manifest.title is empty.
        if (result.manifest.title) {
          try {
            await workspace.setSessionTitle(
              result.importedPath,
              result.manifest.title,
            );
          } catch {
            // best-effort
          }
        }
        // Look up the local repo name so the events list can render a
        // human-readable "Imported into <repoName>" label instead of
        // showing the raw git remote URL. Best-effort — falls back to
        // origin/repo name from the manifest when no match in the
        // workspace's repos.json.
        let localRepoName = result.manifest.originRepoName ?? "";
        try {
          const normTarget = normalizeRemote(result.manifest.originRepoRemote);
          for (const r of await workspace.listRepos()) {
            const remotes = await listRemotes(r.path).catch(() => []);
            if (remotes.find((rm) => normalizeRemote(rm.url) === normTarget)) {
              localRepoName = r.name;
              break;
            }
          }
        } catch {
          // best-effort
        }
        await events.append({
          type: "session_imported",
          actor: "user",
          payload: {
            offerId,
            sid: result.manifest.sid,
            title: result.manifest.title,
            originMachine: result.manifest.originMachine,
            originMachineLabel: result.manifest.originMachineLabel,
            repoRemote: result.manifest.originRepoRemote,
            repoName: localRepoName,
            importedPath: result.importedPath,
            mode,
          },
        });
        broadcast("change", {
          kind: "session_imported",
          sid: result.manifest.sid,
        });
        // Best-effort notify the sender. We swallow failures — the
        // import has already happened locally and the user can see it.
        void notifyOfferStatus(result.manifest, "accepted");
        return json({
          sid: result.manifest.sid,
          importedAs: result.importedPath,
          title: result.manifest.title,
          repoName: localRepoName,
          agent: result.manifest.agent,
        });
      }

      const inviteDeclineMatch = url.pathname.match(
        /^\/api\/sessions\/invites\/([^/]+)\/decline$/,
      );
      if (inviteDeclineMatch && req.method === "POST") {
        const offerId = inviteDeclineMatch[1]!;
        // Look up the manifest before deleting so we can notify the sender.
        const offers = await listPendingOffers(workspace.path);
        const pending = offers.find((o) => o.manifest.offerId === offerId);
        const removed = await declineOffer(workspace.path, offerId);
        if (!removed) return json({ error: "not_found" }, { status: 404 });
        await events.append({
          type: "session_invite_declined",
          actor: "user",
          payload: { offerId, sid: pending?.manifest.sid },
        });
        broadcast("change", { kind: "session_invite_declined", offerId });
        if (pending) void notifyOfferStatus(pending.manifest, "declined");
        return new Response(null, { status: 204, headers: CORS });
      }

      if (
        url.pathname === "/api/sessions/offer-status" &&
        req.method === "POST"
      ) {
        // Sender side — receiver tells us "accepted" or "declined" for
        // an offer we sent. We broadcast so the session row badge can
        // flip from "awaiting" to "accepted"/"declined".
        const body = (await req.json().catch(() => null)) as {
          offerId?: unknown;
          status?: unknown;
        } | null;
        if (!body || typeof body.offerId !== "string") {
          return json({ error: "offerId required" }, { status: 400 });
        }
        if (body.status !== "accepted" && body.status !== "declined") {
          return json(
            { error: "status must be accepted|declined" },
            { status: 400 },
          );
        }
        broadcast("change", {
          kind: "session_offer_status",
          offerId: body.offerId,
          status: body.status,
        });
        return new Response(null, { status: 204, headers: CORS });
      }

      if (url.pathname === "/api/sessions/send" && req.method === "POST") {
        // Sender side — build an offer manifest from a session we host,
        // run the strip + redact pipeline, POST to the peer's
        // /api/sessions/offer. Body:
        //   { source, peerHost, peerPort, machineLabel?,
        //     includeToolOutputs?: boolean (default false),
        //     redactSecrets?: boolean (default true) }
        const body = (await req.json().catch(() => null)) as {
          source?: unknown;
          peerHost?: unknown;
          peerPort?: unknown;
          machineLabel?: unknown;
          includeToolOutputs?: unknown;
          redactSecrets?: unknown;
        } | null;
        const source = typeof body?.source === "string" ? body.source : "";
        const peerHost =
          typeof body?.peerHost === "string" ? body.peerHost : "";
        const peerPort = typeof body?.peerPort === "number" ? body.peerPort : 0;
        if (!source || !peerHost || !peerPort) {
          return json(
            { error: "source, peerHost, peerPort required" },
            { status: 400 },
          );
        }
        const resolved = resolveSessionAgent(source);
        if (!resolved) {
          return json({ error: "unknown session source" }, { status: 404 });
        }
        let jsonl: string;
        try {
          jsonl = await Bun.file(source).text();
        } catch (e) {
          return json(
            {
              error:
                "could not read session: " +
                (e instanceof Error ? e.message : String(e)),
            },
            { status: 500 },
          );
        }
        const parsed = await parseSessionFile(resolved.agent, source);
        const cwd = parsed.cwd ?? "";
        if (!cwd) {
          return json(
            {
              error:
                "session has no cwd recorded — cannot identify which repo it belongs to",
            },
            { status: 400 },
          );
        }
        // Find the matching repo so we can identify the origin remote +
        // repo root. The cwd may sit inside the repo's main path OR
        // inside one of its worktrees, which can live anywhere on disk
        // (`git worktree add ../foo-feat` creates a path outside the
        // repo dir). So we check both: first a simple prefix match
        // against repo.path, then a prefix match against each of the
        // repo's worktrees.
        const repos = await workspace.listRepos();
        let repo: (typeof repos)[number] | undefined;
        let originWorktreePath: string | undefined;
        const matchesPrefix = (p: string) =>
          cwd === p || cwd.startsWith(`${p}/`) || cwd.startsWith(`${p}\\`);
        for (const r of repos) {
          if (matchesPrefix(r.path)) {
            repo = r;
            // Even when r.path matches we still walk worktrees so we can
            // surface the *worktree* path in the manifest (the receiver
            // uses it to rewrite the cwd properly).
            const wts = await listWorktrees(r.path).catch(() => []);
            const wt = wts.find((w) => matchesPrefix(w.path));
            if (wt && wt.path !== r.path) originWorktreePath = wt.path;
            break;
          }
          const wts = await listWorktrees(r.path).catch(() => []);
          const wt = wts.find((w) => matchesPrefix(w.path));
          if (wt) {
            repo = r;
            if (wt.path !== r.path) originWorktreePath = wt.path;
            break;
          }
        }
        if (!repo) {
          return json(
            {
              error: `session cwd "${cwd}" is not inside any known repo or worktree — add the repo to supergit first`,
              cwd,
            },
            { status: 400 },
          );
        }
        const remotes = await listRemotes(repo.path);
        // In a multi-remote repo (a fork checkout where `origin` is your
        // fork and `upstream` is the canonical project), grabbing
        // remotes[0] would send the wrong URL — the receiver would clone
        // your private fork instead of the upstream the branch actually
        // came from. Inspect the checked-out branch in the WORKTREE that
        // hosts the session (not necessarily repo.path; the session can
        // live in `git worktree add ../foo-feat`) and use the remote it
        // tracks; fall back to remotes[0] only when no upstream is set.
        const branchWorktree = originWorktreePath ?? repo.path;
        const upstreamName = await getUpstreamRemoteName(branchWorktree);
        const originRemote = pickRemoteUrlForShare(remotes, upstreamName) ?? "";
        if (!originRemote) {
          return json(
            {
              error: "repo has no git remote — cannot identify across machines",
            },
            { status: 400 },
          );
        }

        // Two independent toggles. Defaults match the conservative
        // stance: tool outputs stripped, secrets redacted. The UI
        // exposes both as separate checkboxes so the user can opt into
        // full transcript without giving up secret redaction (and vice
        // versa).
        const includeToolOutputs = body?.includeToolOutputs === true;
        const redactSecrets = body?.redactSecrets !== false; // default true
        const prepared = prepareOutgoingJsonl(jsonl, {
          includeToolOutputs,
          redactSecrets,
        });

        const manifest: SessionShareManifest = {
          offerId: crypto.randomUUID(),
          sid:
            parsed.sessionId ??
            source
              .split("/")
              .pop()
              ?.replace(/\.jsonl$/, "") ??
            "unknown",
          title:
            (await workspace.listSessionTitles())[source] ??
            parsed.messages[0]?.blocks[0]?.text?.slice(0, 60) ??
            "Untitled session",
          // Share-side agent kind. resolved.agent is one of
          // claude|codex|ollama and ShareAgent covers all three — pass
          // through directly so the receiver knows how to route the
          // import (claude → claude projects dir, ollama → workspace
          // ollama dir, codex → imported-sessions sidecar).
          agent: resolved.agent,
          turnCount: parsed.messages.length,
          // originMachine becomes a directory name on the receiver, so
          // sanitise to [a-z0-9._-]. Source order:
          //   1. The peer-identity id (uuid, stable across restarts) —
          //      ideal because two different machines with the same
          //      hostname don't collide on the receiver's filesystem.
          //   2. Fallback to os.hostname() if identity hasn't loaded yet
          //      (early-boot send before the async init completes).
          originMachine: sanitiseMachineId(
            peerIdentity?.id || osHostname() || "unknown",
          ),
          // originMachineLabel is the human-readable name the receiver
          // shows in the inbox card. Prefer the peer identity's label
          // (user-editable, defaults to <username>@<hostname>) over the
          // per-send override and the bare hostname.
          originMachineLabel:
            (typeof body?.machineLabel === "string" && body.machineLabel) ||
            peerIdentity?.label ||
            osHostname() ||
            "unknown",
          originPlatform:
            process.platform === "win32"
              ? "win32"
              : process.platform === "darwin"
                ? "darwin"
                : "linux",
          originRepoRemote: originRemote,
          originRepoName: repo.name,
          originRepoPath: repo.path,
          originWorktreePath,
          createdAt: parsed.startedAt ?? new Date().toISOString(),
          sentAt: new Date().toISOString(),
          bytes: prepared.jsonl.length,
          toolOutputs: includeToolOutputs ? "included" : "stripped",
          strippedCount: prepared.strippedCount,
          secrets: redactSecrets ? "redacted" : "raw",
          redactionCount: prepared.redactions.reduce((n, r) => n + r.count, 0),
        };

        const peerUrl = `http://${peerHost}:${peerPort}/api/sessions/offer`;
        let peerRes: Response;
        try {
          peerRes = await fetch(peerUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ manifest, jsonl: prepared.jsonl }),
          });
        } catch (e) {
          return json(
            {
              error:
                "could not reach peer: " +
                (e instanceof Error ? e.message : String(e)),
            },
            { status: 502 },
          );
        }
        if (peerRes.status !== 202) {
          const text = await peerRes.text().catch(() => "");
          return json(
            { error: `peer rejected offer (${peerRes.status}): ${text}` },
            { status: 502 },
          );
        }
        await events.append({
          type: "session_invite_sent",
          actor: "user",
          payload: {
            offerId: manifest.offerId,
            sid: manifest.sid,
            peer: `${peerHost}:${peerPort}`,
            toolOutputs: manifest.toolOutputs,
            strippedCount: manifest.strippedCount,
            secrets: manifest.secrets,
            redactions: prepared.redactions,
          },
        });
        return json(
          {
            offerId: manifest.offerId,
            status: "pending",
            toolOutputs: manifest.toolOutputs,
            strippedCount: manifest.strippedCount,
            secrets: manifest.secrets,
            redactions: prepared.redactions,
          },
          { status: 202 },
        );
      }

      if (url.pathname === "/api/ollama/pull" && req.method === "POST") {
        // Stream `ollama pull <model>` progress lines as SSE so the
        // SPA can show a download spinner. We forward the CLI's
        // human-readable stderr lines verbatim — the structured
        // /api/pull HTTP endpoint would be cleaner but requires us to
        // handle the "Ollama server isn't running" case, which the CLI
        // already covers by talking to the local store directly.
        const body = (await req.json().catch(() => null)) as {
          model?: unknown;
        } | null;
        const model = typeof body?.model === "string" ? body.model.trim() : "";
        if (!model) return json({ error: "model required" }, { status: 400 });
        // Refuse anything that looks like a flag or shell trick; the
        // CLI argument is constrained to a tag like "name:tag".
        if (!/^[A-Za-z0-9_./:\-]+$/.test(model)) {
          return json({ error: "invalid model name" }, { status: 400 });
        }
        const ollamaBin = await resolveAgentBinary("ollama");
        if (!ollamaBin) {
          return json({ error: "ollama not installed" }, { status: 503 });
        }
        const proc = Bun.spawn([ollamaBin, "pull", model], {
          stdout: "pipe",
          stderr: "pipe",
        });
        const stream = new ReadableStream<Uint8Array>({
          async start(controller) {
            const send = (event: string, data: unknown) => {
              try {
                controller.enqueue(
                  sseEncoder.encode(
                    `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`,
                  ),
                );
              } catch {}
            };
            const pump = async (s: ReadableStream<Uint8Array> | null) => {
              if (!s) return;
              const reader = s.getReader();
              const dec = new TextDecoder();
              let buf = "";
              while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                buf += dec.decode(value, { stream: true });
                // Ollama uses CR for live progress repaints; split on
                // both so the client sees incremental updates.
                const parts = buf.split(/[\r\n]/);
                buf = parts.pop() ?? "";
                for (const p of parts) {
                  const line = p.trim();
                  if (line) send("progress", { line });
                }
              }
              if (buf.trim()) send("progress", { line: buf.trim() });
            };
            await Promise.all([pump(proc.stdout), pump(proc.stderr)]);
            const code = await proc.exited;
            if (code === 0) send("done", { code });
            else send("error", { kind: "pull_failed", code });
            try {
              controller.close();
            } catch {}
          },
          cancel() {
            try {
              proc.kill();
            } catch {}
          },
        });
        return new Response(stream, {
          headers: {
            ...CORS,
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache, no-transform",
            Connection: "keep-alive",
            "X-Accel-Buffering": "no",
          },
        });
      }

      if (url.pathname === "/api/active-sends" && req.method === "GET") {
        const sessionId = url.searchParams.get("sessionId") ?? undefined;
        // ETag derived from the in-memory revision counter + the
        // optional session-id filter. inflight bumps the revision on
        // every register / kill / process-exit, so a stable revision
        // means "nothing changed since your last poll" — return 304
        // and skip the O(n) Map iteration + JSON serialization. The
        // UI polls this at ~22 Hz while a session is interactive.
        const etag = `"rev-${inflight.getRevision()}-${sessionId ?? "all"}"`;
        const clientEtag = req.headers.get("If-None-Match");
        if (clientEtag === etag) {
          return new Response(null, {
            status: 304,
            headers: { ETag: etag, ...CORS },
          });
        }
        const body = JSON.stringify(inflight.list({ sessionId }));
        return new Response(body, {
          headers: { "Content-Type": "application/json", ETag: etag, ...CORS },
        });
      }

      // Trailing-id pattern: /api/active-sends/:id for DELETE.
      if (
        url.pathname.startsWith("/api/active-sends/") &&
        req.method === "DELETE"
      ) {
        const id = url.pathname.slice("/api/active-sends/".length);
        const ok = inflight.kill(id);
        if (!ok) return json({ error: "not found" }, { status: 404 });
        return json({ ok: true });
      }

      if (url.pathname === "/api/fetch" && req.method === "POST") {
        // Kick off an immediate fetch cycle. Returns immediately; the SSE
        // stream emits "change" when fetches complete. Optional body
        // `{ repos: [id, ...] }` restricts the cycle to those repo IDs —
        // used by the dashboard to keep on-screen repos fresh on a 30s
        // cadence without paying the cost of fetching the whole workspace.
        const body = (await req.json().catch(() => null)) as {
          repos?: unknown;
        } | null;
        const repoIds = Array.isArray(body?.repos)
          ? (body!.repos as unknown[]).filter(
              (v): v is string => typeof v === "string" && v.length > 0,
            )
          : undefined;
        void runFetchCycle(repoIds);
        return json({ status: "queued" });
      }

      if (url.pathname === "/api/repos" && req.method === "POST") {
        const body = (await req.json().catch(() => null)) as {
          path?: unknown;
        } | null;
        const path = body?.path;
        if (typeof path !== "string" || path.length === 0) {
          return json(
            { error: "body.path (non-empty string) is required" },
            {
              status: 400,
            },
          );
        }
        try {
          const repo = await workspace.addRepo(path);
          await events.append({
            type: "add_repo",
            actor: "user",
            payload: { path },
            inverse: { repo },
          });
          broadcast("change", { kind: "add_repo", repo });
          void reconcileWorktreeWatchers();
          return json(repo, { status: 201 });
        } catch (e) {
          if (e instanceof DuplicateRepoError) {
            return json(
              { ...e.repo, alreadyRegistered: true },
              { status: 200 },
            );
          }
          return json(
            { error: String(e instanceof Error ? e.message : e) },
            {
              status: 409,
            },
          );
        }
      }

      const wtCreateMatch = url.pathname.match(
        /^\/api\/repos\/([^/]+)\/worktrees$/,
      );
      if (wtCreateMatch && req.method === "POST") {
        const id = wtCreateMatch[1]!;
        const body = (await req.json().catch(() => null)) as {
          branch?: unknown;
          base?: unknown;
        } | null;
        const branch = body?.branch;
        if (typeof branch !== "string" || branch.trim().length === 0) {
          return json(
            { error: "body.branch (non-empty string) is required" },
            { status: 400 },
          );
        }
        const base = typeof body?.base === "string" ? body.base : undefined;
        const repos = await workspace.listRepos();
        const repo = repos.find((r) => r.id === id);
        if (!repo) return json({ error: "repo not found" }, { status: 404 });
        try {
          const created = await createWorktree(repo.path, branch.trim(), {
            base,
          });
          await events.append({
            type: "create_worktree",
            actor: "user",
            payload: { repoId: id, branch: created.branch, path: created.path },
          });
          invalidateReposCache();
          broadcast("change", { kind: "create_worktree", path: created.path });
          void reconcileWorktreeWatchers();
          return json(created, { status: 201 });
        } catch (e) {
          return json(
            { error: String(e instanceof Error ? e.message : e) },
            { status: 409 },
          );
        }
      }

      if (wtCreateMatch && req.method === "DELETE") {
        const id = wtCreateMatch[1]!;
        const body = (await req.json().catch(() => null)) as {
          path?: unknown;
          force?: unknown;
        } | null;
        const wtPath = body?.path;
        const force = body?.force === true;
        if (typeof wtPath !== "string" || wtPath.trim().length === 0) {
          return json(
            { error: "body.path (worktree path) is required" },
            { status: 400 },
          );
        }
        const repos = await workspace.listRepos();
        const repo = repos.find((r) => r.id === id);
        if (!repo) return json({ error: "repo not found" }, { status: 404 });
        try {
          await removeWorktree(repo.path, wtPath, { force });
          await events.append({
            type: "remove_worktree",
            actor: "user",
            payload: { repoId: id, path: wtPath, force },
          });
          invalidateWorktreeDetails(wtPath);
          invalidateReposCache();
          broadcast("change", { kind: "remove_worktree", path: wtPath });
          void reconcileWorktreeWatchers();
          return json({ ok: true });
        } catch (e) {
          const msg = String(e instanceof Error ? e.message : e);
          // Surface dirty-state errors with a recognizable shape so the UI
          // can offer a "force" retry.
          const isDirty = /uncommitted|modified|untracked|locked/i.test(msg);
          return json({ error: msg, dirty: isDirty }, { status: 409 });
        }
      }

      {
        const m = url.pathname.match(/^\/api\/repos\/([^/]+)\/branches$/);
        if (m && req.method === "GET") {
          const id = m[1]!;
          const path = url.searchParams.get("path");
          const repos = await workspace.listRepos();
          const repo = repos.find((r) => r.id === id);
          if (!repo) return json({ error: "repo not found" }, { status: 404 });
          const target = path && path.length > 0 ? path : repo.path;
          try {
            const branches = await listBranches(target);
            return json(branches);
          } catch (e) {
            return json(
              { error: String(e instanceof Error ? e.message : e) },
              { status: 500 },
            );
          }
        }
      }

      {
        const m = url.pathname.match(/^\/api\/repos\/([^/]+)\/pull$/);
        if (m && req.method === "POST") {
          const id = m[1]!;
          const body = (await req.json().catch(() => null)) as {
            path?: unknown;
            preStash?: unknown;
            remote?: unknown;
          } | null;
          const wtPath = body?.path;
          const preStash = body?.preStash === true;
          const remote = typeof body?.remote === "string" ? body.remote : null;
          if (typeof wtPath !== "string" || wtPath.trim().length === 0) {
            return json({ error: "body.path is required" }, { status: 400 });
          }
          const repos = await workspace.listRepos();
          const repo = repos.find((r) => r.id === id);
          if (!repo) return json({ error: "repo not found" }, { status: 404 });
          const remotes = await listRemotes(repo.path);
          const selectedRemote = selectedRemoteForRepo({
            selectedRemotes: remote ? { [id]: remote } : {},
            repoId: id,
            remotes,
          });
          const result = await pullFastForward(wtPath, {
            preStash,
            remote: selectedRemote,
          });
          if (result.ok) {
            await events.append({
              type: "pull",
              actor: "user",
              payload: {
                repoId: id,
                path: wtPath,
                kind: result.kind,
                stashed: result.stashed === true,
                stashRestored: result.stashRestored === true,
                stashConflict: result.stashConflict === true,
              },
            });
            invalidateWorktreeDetails(wtPath);
            invalidateReposCache();
            broadcast("change", { kind: "pull", path: wtPath });
            return json({
              ok: true,
              kind: result.kind,
              stashed: result.stashed === true,
              stashRestored: result.stashRestored === true,
              stashConflict: result.stashConflict === true,
            });
          }
          // Non-ok: surface the kind so the UI can pick the right dialog.
          return json(
            {
              ok: false,
              kind: result.kind,
              error: result.message,
            },
            { status: 409 },
          );
        }
      }

      {
        const m = url.pathname.match(/^\/api\/repos\/([^/]+)\/push$/);
        if (m && req.method === "POST") {
          const id = m[1]!;
          const body = (await req.json().catch(() => null)) as {
            path?: unknown;
            remote?: unknown;
          } | null;
          const wtPath = body?.path;
          const remote = typeof body?.remote === "string" ? body.remote : null;
          if (typeof wtPath !== "string" || wtPath.trim().length === 0) {
            return json({ error: "body.path is required" }, { status: 400 });
          }
          const repos = await workspace.listRepos();
          const repo = repos.find((r) => r.id === id);
          if (!repo) return json({ error: "repo not found" }, { status: 404 });
          const remotes = await listRemotes(repo.path);
          const selectedRemote = selectedRemoteForRepo({
            selectedRemotes: remote ? { [id]: remote } : {},
            repoId: id,
            remotes,
          });
          const result = await pushUpstream(wtPath, {
            remote: selectedRemote,
          });
          if (result.ok) {
            await events.append({
              type: "push",
              actor: "user",
              payload: { repoId: id, path: wtPath },
            });
            invalidateWorktreeDetails(wtPath);
            invalidateReposCache();
            broadcast("change", { kind: "push", path: wtPath });
            return json({ ok: true, message: result.message });
          }
          return json(
            { ok: false, error: result.message, kind: result.kind },
            { status: 409 },
          );
        }
      }

      {
        const m = url.pathname.match(/^\/api\/repos\/([^/]+)\/checkout$/);
        if (m && req.method === "POST") {
          const id = m[1]!;
          const body = (await req.json().catch(() => null)) as {
            path?: unknown;
            branch?: unknown;
            force?: unknown;
            preStash?: unknown;
          } | null;
          const wtPath = body?.path;
          const branch = body?.branch;
          const force = body?.force === true;
          const preStash = body?.preStash === true;
          if (
            typeof wtPath !== "string" ||
            wtPath.trim().length === 0 ||
            typeof branch !== "string" ||
            branch.trim().length === 0
          ) {
            return json(
              { error: "body.path and body.branch are required" },
              { status: 400 },
            );
          }
          const repos = await workspace.listRepos();
          const repo = repos.find((r) => r.id === id);
          if (!repo) return json({ error: "repo not found" }, { status: 404 });
          try {
            const result = await checkoutBranch(wtPath, branch.trim(), {
              force,
              preStash,
            });
            await events.append({
              type: "checkout_branch",
              actor: "user",
              payload: {
                repoId: id,
                path: wtPath,
                branch: branch.trim(),
                force,
                stashed: result.stashed,
              },
            });
            invalidateWorktreeDetails(wtPath);
            invalidateReposCache();
            broadcast("change", { kind: "checkout_branch", path: wtPath });
            return json({ ok: true, stashed: result.stashed });
          } catch (e) {
            const msg = String(e instanceof Error ? e.message : e);
            const isDirty = /uncommitted|untracked|stash/i.test(msg);
            return json({ error: msg, dirty: isDirty }, { status: 409 });
          }
        }
      }

      const colorMatch = url.pathname.match(/^\/api\/repos\/([^/]+)\/color$/);
      if (colorMatch && req.method === "POST") {
        const id = colorMatch[1]!;
        const body = (await req.json().catch(() => null)) as {
          color?: unknown;
        } | null;
        // `color: null` clears; a string sets. Missing => 400.
        const raw = body?.color;
        const color =
          raw === null ? null : typeof raw === "string" ? raw : undefined;
        if (color === undefined) {
          return json(
            { error: "body.color (#rrggbb hex string or null) is required" },
            { status: 400 },
          );
        }
        try {
          const { oldColor, newColor } = await workspace.setRepoColor(
            id,
            color,
          );
          if (oldColor !== newColor) {
            broadcast("change", { kind: "repo_color", id, color: newColor });
          }
          return json({ id, oldColor, newColor });
        } catch (e) {
          const msg = String(e instanceof Error ? e.message : e);
          return json(
            { error: msg },
            { status: /not found/.test(msg) ? 404 : 400 },
          );
        }
      }

      const customLinksMatch = url.pathname.match(
        /^\/api\/repos\/([^/]+)\/custom-links$/,
      );
      if (customLinksMatch && req.method === "POST") {
        const id = customLinksMatch[1]!;
        const body = (await req.json().catch(() => null)) as {
          kind?: unknown;
          url?: unknown;
          path?: unknown;
          name?: unknown;
        } | null;
        const rawName = typeof body?.name === "string" ? body.name : undefined;
        // The workspace input type is a discriminated union; pick the
        // arm based on `kind` so file/folder paths actually reach the
        // validator instead of getting silently stripped down to
        // `{ url: "" }`.
        let input:
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
            };
        if (body?.kind === "command") {
          const rawCmd =
            typeof (body as any)?.cmd === "string" ? (body as any).cmd : "";
          const rawCwd =
            typeof (body as any)?.cwd === "string"
              ? (body as any).cwd
              : undefined;
          const rawRunMode =
            typeof (body as any)?.runMode === "string"
              ? (body as any).runMode
              : undefined;
          input = {
            kind: "command",
            cmd: rawCmd,
            cwd: rawCwd,
            runMode: rawRunMode,
            name: rawName,
          };
        } else if (body?.kind === "file" || body?.kind === "folder") {
          const rawPath = typeof body?.path === "string" ? body.path : "";
          input = { kind: body.kind, path: rawPath, name: rawName };
        } else {
          const rawUrl = typeof body?.url === "string" ? body.url : "";
          input = { kind: "url", url: rawUrl, name: rawName };
        }
        try {
          const link = await workspace.addCustomLink(id, input);
          broadcast("change", { kind: "custom_link_add", id, linkId: link.id });
          return json({ id, link });
        } catch (e) {
          const msg = String(e instanceof Error ? e.message : e);
          return json(
            { error: msg },
            { status: /not found/.test(msg) ? 404 : 400 },
          );
        }
      }

      const customLinksOrderMatch = url.pathname.match(
        /^\/api\/repos\/([^/]+)\/custom-links\/order$/,
      );
      if (customLinksOrderMatch && req.method === "POST") {
        const id = customLinksOrderMatch[1]!;
        const body = (await req.json().catch(() => null)) as {
          order?: unknown;
        } | null;
        const order = Array.isArray(body?.order) ? body.order : null;
        if (!order) {
          return json(
            { error: "body.order must be an array of link ids" },
            { status: 400 },
          );
        }
        try {
          const { oldOrder, newOrder } = await workspace.reorderCustomLinks(
            id,
            order as string[],
          );
          if (oldOrder.join() !== newOrder.join()) {
            broadcast("change", { kind: "custom_link_reorder", id });
          }
          return json({ id, oldOrder, newOrder });
        } catch (e) {
          const msg = String(e instanceof Error ? e.message : e);
          return json(
            { error: msg },
            { status: /not found/.test(msg) ? 404 : 400 },
          );
        }
      }

      const customLinkOneMatch = url.pathname.match(
        /^\/api\/repos\/([^/]+)\/custom-links\/([^/]+)$/,
      );
      if (customLinkOneMatch && req.method === "DELETE") {
        const id = customLinkOneMatch[1]!;
        const linkId = customLinkOneMatch[2]!;
        try {
          const removed = await workspace.removeCustomLink(id, linkId);
          if (!removed)
            return json({ error: "link not found" }, { status: 404 });
          broadcast("change", { kind: "custom_link_remove", id, linkId });
          return json({ id, removed });
        } catch (e) {
          const msg = String(e instanceof Error ? e.message : e);
          return json(
            { error: msg },
            { status: /not found/.test(msg) ? 404 : 400 },
          );
        }
      }
      if (customLinkOneMatch && req.method === "PATCH") {
        const id = customLinkOneMatch[1]!;
        const linkId = customLinkOneMatch[2]!;
        const body = (await req.json().catch(() => null)) as {
          url?: unknown;
          path?: unknown;
          name?: unknown;
          kind?: unknown;
          cmd?: unknown;
          cwd?: unknown;
          runMode?: unknown;
        } | null;
        const input: {
          url?: string;
          path?: string;
          name?: string;
          kind?: string;
          cmd?: string;
          cwd?: string;
          runMode?: string;
        } = {};
        if (typeof body?.url === "string") input.url = body.url;
        if (typeof body?.path === "string") input.path = body.path;
        if (typeof body?.name === "string") input.name = body.name;
        if (typeof body?.kind === "string") input.kind = body.kind;
        if (typeof body?.cmd === "string") input.cmd = body.cmd;
        if (typeof body?.cwd === "string") input.cwd = body.cwd;
        if (typeof body?.runMode === "string") input.runMode = body.runMode;
        try {
          const updated = await workspace.updateCustomLink(
            id,
            linkId,
            input as any,
          );
          if (!updated)
            return json({ error: "link not found" }, { status: 404 });
          broadcast("change", { kind: "custom_link_update", id, linkId });
          return json({ id, link: updated });
        } catch (e) {
          const msg = String(e instanceof Error ? e.message : e);
          return json(
            { error: msg },
            { status: /not found/.test(msg) ? 404 : 400 },
          );
        }
      }

      // GET /api/npm-scripts?dir=<path>&repoPath=<base> — read package.json scripts.
      // dir may be absolute OR relative-to-repoPath. Empty dir = repoPath itself.
      if (url.pathname === "/api/npm-scripts" && req.method === "GET") {
        const dir = url.searchParams.get("dir") ?? "";
        const repoPath = url.searchParams.get("repoPath") ?? "";
        const isAbsolute = dir.startsWith("/") || /^[a-zA-Z]:[\\/]/.test(dir);
        let resolved: string;
        if (isAbsolute) {
          resolved = dir;
        } else if (repoPath) {
          resolved = dir ? join(repoPath, dir) : repoPath;
        } else if (dir) {
          resolved = dir;
        } else {
          return json({ scripts: [], packageManagers: [] });
        }
        try {
          const pkgPath = join(resolved, "package.json");
          const raw = await Bun.file(pkgPath).text();
          const pkg = JSON.parse(raw);
          const scripts =
            pkg && typeof pkg.scripts === "object" && pkg.scripts !== null
              ? Object.keys(pkg.scripts)
              : [];
          const packageManagers = await detectPackageManagers(resolved, pkg);
          return json({ scripts, packageManagers });
        } catch {
          return json({ scripts: [], packageManagers: [] });
        }
      }

      // ── Command execution routes ──────────────────────────────────
      // POST /api/command/run   — spawn a command-kind custom link
      // POST /api/command/stop  — SIGTERM → 2s grace → SIGKILL
      // GET  /api/commands/running — list running command link ids

      if (url.pathname === "/api/command/run" && req.method === "POST") {
        const body = (await req.json().catch(() => null)) as {
          linkId?: string;
          repoId?: string;
          repoPath?: string;
        } | null;
        const linkId = body?.linkId;
        const repoId = body?.repoId;
        const repoPath = body?.repoPath;
        if (!linkId || typeof linkId !== "string") {
          return json({ error: "linkId required" }, { status: 400 });
        }
        if (!repoId || typeof repoId !== "string") {
          return json({ error: "repoId required" }, { status: 400 });
        }
        if (runningCommands.has(linkId)) {
          return json(
            { error: "already running", pid: runningCommands.get(linkId)!.pid },
            { status: 409 },
          );
        }
        const repos = await workspace.listRepos();
        const repo = repos.find((r) => r.id === repoId);
        if (!repo) return json({ error: "repo not found" }, { status: 404 });
        const link = (repo.customLinks ?? []).find((l) => l.id === linkId);
        if (!link || customLinkKind(link) !== "command") {
          return json({ error: "command link not found" }, { status: 404 });
        }
        const cmdLink = link as {
          cmd: string;
          cwd?: string;
          runMode: CommandRunMode;
        };
        const baseDir = typeof repoPath === "string" ? repoPath : repo.path;
        const linkCwd = cmdLink.cwd;
        let cwd: string;
        if (!linkCwd) {
          cwd = baseDir;
        } else if (linkCwd.startsWith("/") || /^[a-zA-Z]:[\\/]/.test(linkCwd)) {
          cwd = linkCwd;
        } else {
          cwd = join(baseDir, linkCwd);
        }
        const runMode = cmdLink.runMode;

        if (runMode === "external") {
          try {
            const result = await openIn(cwd, "terminal", cmdLink.cmd);
            return json({ ok: true, mode: "external", via: result.via });
          } catch (e) {
            return json(
              { error: e instanceof Error ? e.message : String(e) },
              { status: 500 },
            );
          }
        }

        if (runMode === "internal") {
          try {
            const routeStarted = performance.now();
            const spawnCmd = shellExec(cmdLink.cmd);
            const spawnStarted = performance.now();
            const handle = await terminalBackend.spawn({
              cmd: spawnCmd,
              cwd,
              size: { cols: 120, rows: 30 },
              env: terminalSpawnEnv(),
            });
            const backendMs = performance.now() - spawnStarted;
            const totalMs = performance.now() - routeStarted;
            record("command-run-internal-spawn-backend", backendMs);
            record("command-run-internal-post", totalMs);
            terminalSpawnPendingWs.set(handle.id, performance.now());
            terminalSpawnFinishedAt.set(handle.id, performance.now());
            console.log(
              `supergit daemon: command internal spawn termId=${handle.id} linkId=${linkId} repoId=${repoId} pid=${handle.pid} totalMs=${Math.round(totalMs)} backendMs=${Math.round(backendMs)} cwd=${cwd} cmd=${JSON.stringify(cmdLink.cmd)}`,
            );
            if (totalMs > TERMINAL_SPAWN_SLOW_MS) {
              console.warn(
                `supergit daemon: /api/command/run internal slow total=${Math.round(totalMs)}ms backend=${Math.round(backendMs)} linkId=${linkId} repoId=${repoId} cwd=${cwd} cmd=${JSON.stringify(cmdLink.cmd)}`,
              );
            }
            // Scan PTY output for localhost/LAN URLs for up to 2 minutes
            detectCommandUrl(handle, linkId, repoId);
            // Track as a shell for input capture + persistence
            shellTermIds.add(handle.id);
            void terminalPersist
              .save({
                termId: handle.id,
                cmd: spawnCmd,
                cwd,
                wtPath: cwd,
                title: (link as { name?: string }).name || cmdLink.cmd,
                lastCmd: cmdLink.cmd,
              })
              .catch(() => {});
            const cmdCleanup = handle.subscribe({
              onData() {},
              onExit() {
                shellTermIds.delete(handle.id);
                clearShellInputBuffer(handle.id);
                void terminalPersist.remove(handle.id).catch(() => {});
                cmdCleanup();
              },
            });
            return json({
              ok: true,
              mode: "internal",
              termId: handle.id,
              pid: handle.pid,
            });
          } catch (e) {
            return json(
              { error: e instanceof Error ? e.message : String(e) },
              { status: 500 },
            );
          }
        }

        // runMode === "shell" — background child process
        try {
          const proc = Bun.spawn(shellExec(cmdLink.cmd), {
            cwd,
            stdout: "ignore",
            stderr: "ignore",
            stdin: "ignore",
            env: backgroundCommandEnv(),
          });
          const entry: RunningCommand = {
            proc,
            linkId,
            repoId,
            pid: proc.pid,
            startedAt: new Date().toISOString(),
            cmd: cmdLink.cmd,
          };
          runningCommands.set(linkId, entry);
          // Auto-clean when the process exits
          void proc.exited.then(() => {
            runningCommands.delete(linkId);
            broadcast("change", { kind: "command_exit", linkId, repoId });
          });
          broadcast("change", {
            kind: "command_start",
            linkId,
            repoId,
            pid: proc.pid,
          });
          return json({ ok: true, mode: "shell", pid: proc.pid });
        } catch (e) {
          return json(
            { error: e instanceof Error ? e.message : String(e) },
            { status: 500 },
          );
        }
      }

      if (url.pathname === "/api/command/stop" && req.method === "POST") {
        const body = (await req.json().catch(() => null)) as {
          linkId?: string;
        } | null;
        const linkId = body?.linkId;
        if (!linkId || typeof linkId !== "string") {
          return json({ error: "linkId required" }, { status: 400 });
        }
        const entry = runningCommands.get(linkId);
        if (!entry) {
          return json({ error: "not running" }, { status: 404 });
        }
        try {
          entry.proc.kill("SIGTERM");
        } catch {}
        // Grace period: SIGKILL after 2 seconds if still alive
        setTimeout(() => {
          try {
            if (runningCommands.has(linkId)) {
              entry.proc.kill("SIGKILL");
            }
          } catch {}
        }, 2000);
        return json({ ok: true, pid: entry.pid });
      }

      if (url.pathname === "/api/commands/running" && req.method === "GET") {
        const list = [...runningCommands.values()].map((e) => ({
          linkId: e.linkId,
          repoId: e.repoId,
          pid: e.pid,
          startedAt: e.startedAt,
          cmd: e.cmd,
        }));
        return json({ running: list });
      }

      if (url.pathname === "/api/commands/urls" && req.method === "GET") {
        const urls: Record<string, string[]> = {};
        for (const [k, v] of commandDetectedUrls) urls[k] = v;
        return json({ urls });
      }

      if (url.pathname === "/api/favicon" && req.method === "GET") {
        return await handleFavicon(url, CORS);
      }

      // GET /api/repos/:id/summary — return the cached "what happened
      // recently" + a staleness flag so the row can paint immediately
      // and the UI decides whether to fire a refresh.
      const repoSummaryGet = url.pathname.match(
        /^\/api\/repos\/([^/]+)\/summary$/,
      );
      if (repoSummaryGet && req.method === "GET") {
        const id = repoSummaryGet[1]!;
        const repo = (await workspace.listRepos()).find((r) => r.id === id);
        if (!repo) return json({ error: "repo not found" }, { status: 404 });
        const cached = await repoSummaries.read(id);
        // Current HEAD sha — `git rev-parse HEAD` against the canonical
        // repo path. If the repo dir is gone we degrade to "no summary",
        // not a 500.
        let currentSha = "";
        try {
          currentSha = (
            await $`git -C ${repo.path} rev-parse HEAD`.quiet().text()
          ).trim();
        } catch {
          // ignore
        }
        const reason = shouldGenerateRepoSummary(
          cached
            ? {
                lastSha: cached.frontmatter.lastSha,
                generatedAt: cached.frontmatter.generatedAt,
                commitCount: cached.frontmatter.commitCount,
              }
            : null,
          currentSha,
          REPO_MAX_AGE_HOURS,
        );
        return json({
          summary: cached
            ? { frontmatter: cached.frontmatter, body: cached.body }
            : null,
          stale: reason !== null,
          reason: reason ?? undefined,
          currentSha,
        });
      }

      // POST /api/repos/:id/summarize — stream a fresh repo summary
      // via SSE and persist it. Single-flight per repoId.
      const repoSummaryPost = url.pathname.match(
        /^\/api\/repos\/([^/]+)\/summarize$/,
      );
      if (repoSummaryPost && req.method === "POST") {
        const id = repoSummaryPost[1]!;
        const repo = (await workspace.listRepos()).find((r) => r.id === id);
        if (!repo) return json({ error: "repo not found" }, { status: 404 });
        const body = (await req.json().catch(() => null)) as {
          model?: unknown;
          force?: unknown;
        } | null;
        const model = typeof body?.model === "string" ? body.model.trim() : "";
        if (!model) return json({ error: "model required" }, { status: 400 });
        const force = body?.force === true;

        const startedAt = Date.now();
        const abort = new AbortController();
        const stream = new ReadableStream<Uint8Array>({
          async start(controller) {
            const send = (event: string, data: unknown) => {
              try {
                controller.enqueue(
                  sseEncoder.encode(
                    `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`,
                  ),
                );
              } catch {
                // already closed
              }
            };

            // Single-flight: if another caller is already generating
            // for this repoId, just join their promise and emit a meta
            // + done once they finish. We can't share the upstream
            // stream cleanly across SSE clients, so the joiner waits
            // and then reads the freshly-written cache.
            const existing = repoSummaryInflight.get(id);
            if (existing && !force) {
              send("meta", { joined: true });
              try {
                await existing;
              } catch {}
              send("done", { elapsedMs: Date.now() - startedAt, joined: true });
              // Delay close so Bun's chunked-encoding layer can flush
              // the last frame. Synchronous close drops the final chunk
              // → ERR_INCOMPLETE_CHUNKED_ENCODING in the browser.
              setTimeout(() => {
                try {
                  controller.close();
                } catch {}
              }, 200);
              return;
            }

            const work = (async () => {
              let currentSha = "";
              try {
                currentSha = (
                  await $`git -C ${repo.path} rev-parse HEAD`.quiet().text()
                ).trim();
              } catch {
                // ignore
              }
              // Weekend-aware window: 72h on Monday so Friday + weekend
              // commits stay in the digest; 24h on other weekdays.
              const sinceHours = pickRepoSinceHours();
              const activity = await collectRepoActivity(
                repo.path,
                repo.name,
                sinceHours,
              );
              send("meta", {
                repoId: id,
                repoName: repo.name,
                commitCount: activity.commits.length,
                dirtyWorktreeCount: activity.dirtyWorktrees.length,
                sinceHours,
                currentSha,
              });

              const prompt = formatActivityPrompt(activity);
              if (prompt === "EMPTY") {
                // Persist an empty-marker entry so the freshness check
                // doesn't re-fire until the sha actually changes.
                await repoSummaries.write(id, {
                  repoName: repo.name,
                  repoPath: repo.path,
                  model,
                  lastSha: currentSha,
                  generatedAt: new Date(startedAt).toISOString(),
                  sinceHours,
                  commitCount: 0,
                  dirtyWorktreeCount: 0,
                  totalInsertions: 0,
                  totalDeletions: 0,
                  estimatedTokens: 0,
                  elapsedMs: Date.now() - startedAt,
                  body:
                    "Nothing committed in the last " +
                    sinceHours +
                    " hours, no uncommitted work.",
                });
                send("chunk", {
                  delta:
                    "Nothing committed in the last " +
                    sinceHours +
                    " hours, no uncommitted work.",
                });
                return;
              }

              // Prompt is intentionally terse and structural. Earlier
              // versions asked for a "brief paragraph", which yielded
              // narrative recaps ("You did X, you also did Y. Now things
              // are clearer.") that aren't useful as a glance surface.
              // The user wants a topic list they can scan in <1s.
              const systemPrompt =
                "You are summarising recent git activity so the developer can recall at a glance what they worked on. " +
                `The window is the last ${sinceHours} hours. ` +
                "Output ONE single line, max 300 characters. Do NOT include thinking, reasoning, or preamble — output ONLY the summary line. " +
                "Address the developer as 'you', e.g. 'You worked on X – Y – Z'. " +
                "List 2 to 4 distinct work themes separated by ' – ' (space, en-dash, space). " +
                "Each theme is a short noun phrase (e.g. 'Ollama summarisation', 'Windows compat pass', 'sticky-notes drag-drop'). " +
                "If a parenthetical detail clarifies a theme, keep it under 6 words: 'Ollama summarisation (sessions + composer)'. " +
                "If there are dirty worktrees, append them as the final theme like '3 dirty worktrees'. " +
                "DO NOT echo commit messages verbatim. DO NOT echo these instructions. " +
                "DO NOT use markdown, bullets, quotes, or backticks. " +
                "If nothing substantial was done, output 'Nothing notable' or similar in under 10 words.";

              let collected = "";
              const estimatedTokens = Math.ceil(prompt.length / 4);
              // Surface prompt-side budget to the client so the status
              // strip can show "context ~5.2k" alongside the model name.
              send("prompt", { estimatedTokens, promptChars: prompt.length });
              let res: Response;
              try {
                res = await fetch("http://127.0.0.1:11434/api/chat", {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({
                    model,
                    stream: true,
                    messages: [
                      { role: "system", content: systemPrompt },
                      { role: "user", content: prompt },
                      { role: "user", content: "Now summarise this." },
                    ],
                    options: {
                      num_ctx: Math.max(8192, estimatedTokens * 2 + 2048),
                    },
                    think: false,
                  }),
                  signal: abort.signal,
                });
              } catch (e) {
                // Connect-time failure (Ollama not running, wrong port,
                // refused by firewall). Tag the SSE error so the client
                // can show "Ollama unreachable" instead of a generic
                // "network error" surfaced from the browser side.
                const msg = e instanceof Error ? e.message : String(e);
                throw Object.assign(new Error(`Ollama unreachable — ${msg}`), {
                  kind: "ollama_unreachable",
                });
              }
              if (!res.ok || !res.body) {
                // Ollama returns 404 with a JSON `error` field when the
                // model isn't installed (e.g. "model 'llama3.2:3b' not
                // found, try pulling it first") and 400 "does not
                // support chat" for a broken/non-chat manifest. The
                // formatter normalises both into install-flavoured
                // hints so the user knows to `ollama pull <model>`.
                let parsedError: string | null = null;
                try {
                  const errBody = await res.text();
                  try {
                    parsedError =
                      (JSON.parse(errBody) as { error?: string }).error ?? null;
                  } catch {
                    parsedError = errBody.slice(0, 200) || null;
                  }
                } catch {
                  // body unreadable or already consumed
                }
                throw Object.assign(
                  new Error(
                    formatOllamaError(
                      res.status,
                      res.statusText,
                      parsedError,
                      model,
                    ),
                  ),
                  {
                    kind:
                      res.status === 404
                        ? "ollama_model_missing"
                        : "ollama_http",
                  },
                );
              }
              const reader = res.body.getReader();
              const dec = new TextDecoder();
              let buf = "";
              while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                buf += dec.decode(value, { stream: true });
                let nl: number;
                while ((nl = buf.indexOf("\n")) !== -1) {
                  const line = buf.slice(0, nl).trim();
                  buf = buf.slice(nl + 1);
                  if (!line) continue;
                  try {
                    const obj = JSON.parse(line) as {
                      message?: { content?: string };
                      done?: boolean;
                      error?: string;
                    };
                    if (obj.error) {
                      throw Object.assign(new Error(obj.error), {
                        kind: "ollama_payload",
                      });
                    }
                    const c = obj.message?.content ?? "";
                    if (c) {
                      collected += c;
                      send("chunk", { delta: c });
                    }
                    if (obj.done) break;
                  } catch {
                    // ignore malformed line
                  }
                }
              }

              // Sum the insertions/deletions for the frontmatter
              // diagnostics — used by future "delta since last" UIs.
              let totalInsertions = 0;
              let totalDeletions = 0;
              for (const c of activity.commits) {
                totalInsertions += c.insertions;
                totalDeletions += c.deletions;
              }
              await repoSummaries.write(id, {
                repoName: repo.name,
                repoPath: repo.path,
                model,
                lastSha: currentSha,
                generatedAt: new Date(startedAt).toISOString(),
                sinceHours,
                commitCount: activity.commits.length,
                dirtyWorktreeCount: activity.dirtyWorktrees.length,
                totalInsertions,
                totalDeletions,
                estimatedTokens,
                elapsedMs: Date.now() - startedAt,
                body: stripThinkingArtifacts(collected),
              });
              broadcast("change", { kind: "repo_summary", repoId: id });
            })();

            repoSummaryInflight.set(id, work);
            try {
              await work;
              send("done", { elapsedMs: Date.now() - startedAt });
            } catch (e) {
              const msg = e instanceof Error ? e.message : String(e);
              // Propagate the `kind` tag attached upstream (ollama_unreachable,
              // ollama_model_missing, ollama_http, ollama_payload) so the
              // client can distinguish a connect failure from a bad model
              // from a mid-stream error instead of guessing.
              const kind =
                (e as { kind?: unknown }).kind &&
                typeof (e as { kind?: unknown }).kind === "string"
                  ? (e as { kind: string }).kind
                  : "unknown";
              send("error", { kind, message: msg });
            } finally {
              repoSummaryInflight.delete(id);
              // Delay close so Bun's chunked-encoding layer can flush
              // the last frame. Synchronous close drops the final chunk
              // → ERR_INCOMPLETE_CHUNKED_ENCODING in the browser.
              setTimeout(() => {
                try {
                  controller.close();
                } catch {}
              }, 200);
            }
          },
          cancel() {
            abort.abort();
          },
        });
        return new Response(stream, {
          headers: {
            ...CORS,
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache, no-transform",
            Connection: "keep-alive",
            "X-Accel-Buffering": "no",
          },
        });
      }

      // DELETE /api/repos/:id/summary — remove the cached repo summary.
      const repoSummaryDel = url.pathname.match(
        /^\/api\/repos\/([^/]+)\/summary$/,
      );
      if (repoSummaryDel && req.method === "DELETE") {
        const id = repoSummaryDel[1]!;
        const removed = await repoSummaries.delete(id);
        if (!removed) return new Response(null, { status: 404, headers: CORS });
        broadcast("change", { kind: "repo_summary", repoId: id });
        return new Response(null, { status: 204, headers: CORS });
      }

      // POST /api/repos/order — rewrite the global repo display order to
      // match the provided id list (must be a permutation of the existing
      // repo ids). Checked before the `:id` matchers so "order" can't be
      // captured as an id. Not undoable — mirrors custom-link reorder.
      if (url.pathname === "/api/repos/order" && req.method === "POST") {
        const body = (await req.json().catch(() => null)) as {
          order?: unknown;
        } | null;
        const order = Array.isArray(body?.order) ? body.order : null;
        if (!order) {
          return json(
            { error: "body.order must be an array of repo ids" },
            { status: 400 },
          );
        }
        try {
          const { oldOrder, newOrder } = await workspace.reorderRepos(
            order as string[],
          );
          if (oldOrder.join() !== newOrder.join()) {
            broadcast("change", { kind: "repos_reorder" });
          }
          return json({ oldOrder, newOrder });
        } catch (e) {
          const msg = String(e instanceof Error ? e.message : e);
          return json(
            { error: msg },
            { status: /not found/.test(msg) ? 404 : 400 },
          );
        }
      }

      const renameMatch = url.pathname.match(/^\/api\/repos\/([^/]+)\/rename$/);
      if (renameMatch && req.method === "POST") {
        const id = renameMatch[1]!;
        const body = (await req.json().catch(() => null)) as {
          name?: unknown;
        } | null;
        const newName = body?.name;
        if (typeof newName !== "string" || newName.trim().length === 0) {
          return json(
            { error: "body.name (non-empty string) is required" },
            { status: 400 },
          );
        }
        try {
          const { oldName, newName: nn } = await workspace.renameRepo(
            id,
            newName,
          );
          if (oldName !== nn) {
            await events.append({
              type: "rename_repo",
              actor: "user",
              payload: { id, newName: nn },
              inverse: { id, oldName },
            });
            broadcast("change", { kind: "rename_repo", id, newName: nn });
          }
          return json({ id, oldName, newName: nn });
        } catch (e) {
          return json(
            { error: String(e instanceof Error ? e.message : e) },
            { status: 400 },
          );
        }
      }

      const repoMatch = url.pathname.match(/^\/api\/repos\/([^/]+)$/);
      if (repoMatch && req.method === "DELETE") {
        const id = repoMatch[1]!;
        const repos = await workspace.listRepos();
        const repo = repos.find((r) => r.id === id);
        if (!repo) return json({ error: "not found" }, { status: 404 });
        const removed = await workspace.removeRepo(id);
        if (!removed) return json({ error: "not found" }, { status: 404 });
        await events.append({
          type: "remove_repo",
          actor: "user",
          payload: { id },
          inverse: { repo },
        });
        broadcast("change", { kind: "remove_repo", id });
        void reconcileWorktreeWatchers();
        return new Response(null, { status: 204, headers: CORS });
      }

      if (url.pathname === "/api/editors" && req.method === "GET") {
        return json(await detectEditors());
      }

      if (url.pathname === "/api/commit" && req.method === "GET") {
        const path = url.searchParams.get("path");
        const sha = url.searchParams.get("sha");
        const ctxParam = url.searchParams.get("context");
        const context = ctxParam ? Number(ctxParam) : 2;
        if (!path || !sha) {
          return json(
            { error: "?path=<worktree-path>&sha=<commit-sha> required" },
            { status: 400 },
          );
        }
        const content = await getCommitDiff(path, sha, context);
        return new Response(content, {
          headers: {
            "Content-Type": "text/plain; charset=utf-8",
            ...CORS,
          },
        });
      }

      if (url.pathname === "/api/wt-summary" && req.method === "GET") {
        // Feeds the hover-tooltip on the worktree row's status + ahead
        // badges. Two git calls, in parallel, both cheap: porcelain
        // status for the file lists, log @{u}..HEAD for the commit
        // subjects we haven't pushed yet. `nothrow()` on the log call
        // because git errors on missing upstream — we just return [].
        const path = url.searchParams.get("path");
        if (!path) {
          return json(
            { error: "?path=<worktree-path> is required" },
            { status: 400 },
          );
        }
        // %H<NUL>%s<NUL>%an<NUL>%aI — NUL between fields so subjects can
        // contain any whitespace and survive round-trip. %aI gives an
        // ISO-8601 author date so the UI can format its own relative
        // timestamps with consistent thresholds (git's %ar uses odd
        // breakpoints, e.g. "29 hours ago" instead of "1d ago").
        const fmt = "%H%x00%s%x00%an%x00%aI";
        const [statusOut, aheadOut, behindOut, numstatUnstaged, numstatStaged] =
          await Promise.all([
            $`git -C ${path} status --porcelain`.quiet().nothrow().text(),
            $`git -C ${path} log @{u}..HEAD --pretty=format:${fmt} -n 20`
              .quiet()
              .nothrow()
              .text(),
            $`git -C ${path} log HEAD..@{u} --pretty=format:${fmt} -n 20`
              .quiet()
              .nothrow()
              .text(),
            // --no-renames so paths line up 1:1 with parseChangedFiles output;
            // otherwise renames render as `{a => b}` and wouldn't match.
            $`git -C ${path} diff --numstat --no-renames`
              .quiet()
              .nothrow()
              .text(),
            $`git -C ${path} diff --cached --numstat --no-renames`
              .quiet()
              .nothrow()
              .text(),
          ]);
        const files = parseChangedFiles(statusOut);
        let unpushedCommits = parseUnpushedCommits(aheadOut);
        const unfetchedCommits = parseUnpushedCommits(behindOut);
        // No upstream → `@{u}..HEAD` above errored (nothrow → empty), so
        // the list is empty even though the badge may show a count from
        // `rev-list HEAD --not --remotes`. Fall back to that same
        // definition — commits on HEAD but on no remote-tracking ref —
        // so the tooltip list matches the badge. A branch in sync with
        // its upstream is also empty here, but then the fallback is
        // empty too (HEAD is on a remote ref), so it's harmless; and an
        // upstream branch that's genuinely ahead never reaches this
        // branch because `aheadOut` was non-empty.
        if (unpushedCommits.length === 0) {
          const orphanOut =
            await $`git -C ${path} log HEAD --not --remotes --pretty=format:${fmt} -n 20`
              .quiet()
              .nothrow()
              .text();
          unpushedCommits = parseUnpushedCommits(orphanOut);
        }
        // Per-path line stats. Two maps: one for the working tree (covers
        // `unstaged` + we synthesise entries for `untracked` below), one
        // for the index (`staged`). Looking up by path on the UI side is
        // O(1) and tolerates the lists drifting from the stats (e.g. a
        // file vanishing between status and diff — stats just come back
        // undefined and the tooltip shows the path without a count).
        const stats: Record<
          string,
          { added: number; removed: number; binary: boolean }
        > = {
          ...parseNumstat(numstatUnstaged),
        };
        const stagedStats = parseNumstat(numstatStaged);
        // Untracked files don't appear in `git diff`. Use --no-index per
        // file (parallel) so the tooltip can show "all new lines" instead
        // of a bare filename. Cap to keep an accidental 10k-untracked-dir
        // hover from spawning thousands of processes; rest fall back to
        // no-stats display.
        const UNTRACKED_STAT_CAP = 200;
        const untrackedToStat = files.untracked.slice(0, UNTRACKED_STAT_CAP);
        const untrackedResults = await Promise.all(
          untrackedToStat.map(async (rel) => {
            // --no-index always exits non-zero when files differ; nothrow
            // and just read stdout.
            const out =
              await $`git -C ${path} diff --no-index --numstat /dev/null ${rel}`
                .quiet()
                .nothrow()
                .text();
            return { rel, parsed: parseNumstat(out) };
          }),
        );
        for (const { rel, parsed } of untrackedResults) {
          // `git diff --no-index /dev/null <file>` reports the path as
          // `/dev/null => <file>` (a synthetic rename), so look up by
          // value: there's at most one entry per call.
          const entry = Object.values(parsed)[0];
          if (entry) stats[rel] = entry;
        }
        // Per-path mtimes (epoch ms) so the UI can sort buckets by
        // most-recently-touched. Stat every path across all three
        // buckets in parallel; deleted files (e.g. staged removals)
        // come back as undefined and the UI sorts them last. join()
        // resolves to an absolute path; relative paths from
        // parseChangedFiles are interpreted under the worktree.
        const allPaths = Array.from(
          new Set([...files.staged, ...files.unstaged, ...files.untracked]),
        );
        const mtimes: Record<string, number> = {};
        await Promise.all(
          allPaths.map(async (rel) => {
            try {
              const s = await fsStat(join(path, rel));
              mtimes[rel] = s.mtimeMs;
            } catch {
              // Vanished between status and stat (race on a fast rm) —
              // leave undefined; sort puts it at the bottom.
            }
          }),
        );
        return json({
          ...files,
          unpushedCommits,
          unfetchedCommits,
          stats,
          stagedStats,
          mtimes,
        });
      }

      if (url.pathname === "/api/diff" && req.method === "GET") {
        const path = url.searchParams.get("path");
        const kindParam = url.searchParams.get("kind");
        const kind: DiffKind = kindParam === "staged" ? "staged" : "workdir";
        const ctxParam = url.searchParams.get("context");
        const context = ctxParam ? Number(ctxParam) : 2;
        if (!path) {
          return json(
            { error: "?path=<worktree-path> is required" },
            { status: 400 },
          );
        }
        const diff = await getDiff(path, kind, context);
        return new Response(diff, {
          headers: {
            "Content-Type": "text/plain; charset=utf-8",
            ...CORS,
          },
        });
      }

      if (url.pathname === "/api/file-diff" && req.method === "GET") {
        const path = url.searchParams.get("path");
        const file = url.searchParams.get("file");
        const kindParam = url.searchParams.get("kind");
        const kind: FileDiffKind =
          kindParam === "staged"
            ? "staged"
            : kindParam === "untracked"
              ? "untracked"
              : "workdir";
        const ctxParam = url.searchParams.get("context");
        const context = ctxParam ? Number(ctxParam) : 0;
        if (!path || !file) {
          return json(
            { error: "?path=<worktree-path>&file=<file> are required" },
            { status: 400 },
          );
        }
        const diff = await getFileDiff(path, file, kind, context);
        return new Response(diff, {
          headers: {
            "Content-Type": "text/plain; charset=utf-8",
            ...CORS,
          },
        });
      }

      if (url.pathname === "/api/commits" && req.method === "GET") {
        const path = url.searchParams.get("path");
        const before = url.searchParams.get("before") ?? undefined;
        const limitParam = url.searchParams.get("limit");
        const limit = limitParam
          ? Math.max(1, Math.min(200, Number.parseInt(limitParam, 10)))
          : 20;
        if (!path) {
          return json(
            { error: "?path=<worktree-path> is required" },
            { status: 400 },
          );
        }
        const all = url.searchParams.get("all") === "1";
        const commits = await listCommits(path, { before, limit, all });
        return json(commits);
      }

      if (url.pathname === "/api/open" && req.method === "POST") {
        const body = (await req.json().catch(() => null)) as {
          path?: unknown;
          app?: unknown;
          command?: unknown;
        } | null;
        if (typeof body?.path !== "string" || typeof body?.app !== "string") {
          return json(
            { error: "body.path (string) and body.app (string) required" },
            { status: 400 },
          );
        }
        const command =
          typeof body.command === "string" ? body.command : undefined;
        try {
          const result = await openIn(body.path, body.app, command);
          return json(result);
        } catch (e) {
          return json(
            { error: String(e instanceof Error ? e.message : e) },
            { status: 500 },
          );
        }
      }

      if (url.pathname === "/api/stream" && req.method === "GET") {
        // Capture *this* connection's controller so cancel() can remove
        // exactly it. The ReadableStream cancel(reason) callback receives
        // the cancellation reason — NOT the controller — so we close over
        // the controller from start() instead. Removing only this entry
        // keeps the multi-client broadcast set correct: other connected
        // browsers stay subscribed. (broadcast() also prunes dead
        // controllers lazily on enqueue failure, but that only fires on
        // the next event — explicit removal here avoids an inflated
        // sseSubscribers.size between disconnect and the next broadcast,
        // which would keep the `size === 0` early-returns from firing.)
        let myController: ReadableStreamDefaultController<Uint8Array> | null =
          null;
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            myController = controller;
            sseSubscribers.add(controller);
            orphanCleaner.onFrontendConnected();
            controller.enqueue(sseEncoder.encode(`: connected\n\n`));
          },
          cancel() {
            orphanCleaner.onFrontendDisconnected();
            if (myController) sseSubscribers.delete(myController);
          },
        });
        return new Response(stream, {
          headers: {
            ...CORS,
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache, no-transform",
            Connection: "keep-alive",
            "X-Accel-Buffering": "no",
          },
        });
      }

      if (url.pathname === "/api/folder-stats" && req.method === "GET") {
        const wt = url.searchParams.get("wt");
        const folder = url.searchParams.get("folder");
        if (!wt || !folder) {
          return json(
            { error: "?wt=<worktree>&folder=<path> required" },
            { status: 400 },
          );
        }
        try {
          const rel = folder.startsWith(wt)
            ? folder.slice(wt.length).replace(/^\//, "")
            : folder;
          const [unstaged, staged, untracked] = await Promise.all([
            $`git -C ${wt} diff --numstat -- ${rel}`.quiet().nothrow().text(),
            $`git -C ${wt} diff --cached --numstat -- ${rel}`
              .quiet()
              .nothrow()
              .text(),
            $`git -C ${wt} ls-files --others --exclude-standard -- ${rel}`
              .quiet()
              .nothrow()
              .text(),
          ]);
          const files: {
            path: string;
            added: number;
            removed: number;
            status: string;
          }[] = [];
          const seen = new Set<string>();
          for (const line of unstaged.split("\n")) {
            const t1 = line.indexOf("\t");
            if (t1 < 0) continue;
            const t2 = line.indexOf("\t", t1 + 1);
            if (t2 < 0) continue;
            const a = parseInt(line.slice(0, t1), 10) || 0;
            const r = parseInt(line.slice(t1 + 1, t2), 10) || 0;
            const p = line.slice(t2 + 1);
            if (!p || seen.has(p)) continue;
            seen.add(p);
            files.push({ path: p, added: a, removed: r, status: "M" });
          }
          for (const line of staged.split("\n")) {
            const t1 = line.indexOf("\t");
            if (t1 < 0) continue;
            const t2 = line.indexOf("\t", t1 + 1);
            if (t2 < 0) continue;
            const a = parseInt(line.slice(0, t1), 10) || 0;
            const r = parseInt(line.slice(t1 + 1, t2), 10) || 0;
            const p = line.slice(t2 + 1);
            if (!p || seen.has(p)) continue;
            seen.add(p);
            files.push({ path: p, added: a, removed: r, status: "staged" });
          }
          for (const line of untracked.split("\n")) {
            const p = line.trim();
            if (!p || seen.has(p)) continue;
            seen.add(p);
            files.push({ path: p, added: 0, removed: 0, status: "?" });
          }
          return json({ files });
        } catch (e) {
          return json(
            { error: String(e instanceof Error ? e.message : e) },
            { status: 500 },
          );
        }
      }

      if (url.pathname === "/api/home" && req.method === "GET") {
        // This machine's home directory — a sensible starting point for the
        // file browser / the "add a folder on a remote daemon" dir picker.
        // Loopback-only (not in LAN_ALLOWED_ROUTES), so only reachable
        // locally or through the daemon proxy. Per-daemon by nature: the
        // proxied form returns the REMOTE box's home.
        return json({ home: homedir() });
      }

      if (url.pathname === "/api/drives" && req.method === "GET") {
        // Filesystem roots for the picker's "This PC" view. Per-daemon by
        // nature (proxied → the REMOTE box's drives). `platform` lets the UI
        // label them (drives vs "/") and decide whether to default to the
        // drive list (Windows) or home (POSIX).
        return json({
          drives: listDrives({ exists: existsSync }),
          platform: process.platform,
        });
      }

      if (url.pathname === "/api/files" && req.method === "GET") {
        const dirPath = url.searchParams.get("path");
        if (!dirPath) {
          return json({ error: "?path= is required" }, { status: 400 });
        }
        const resolved = resolve(dirPath);
        try {
          const dirents = await readdir(resolved, { withFileTypes: true });
          const entries = await Promise.all(
            dirents.map(async (d) => {
              const type = d.isSymbolicLink()
                ? ("symlink" as const)
                : d.isDirectory()
                  ? ("directory" as const)
                  : ("file" as const);
              let size: number | undefined;
              let mtime: string | undefined;
              try {
                const s = await fsStat(join(resolved, d.name));
                if (type === "file") size = s.size;
                mtime = s.mtime.toISOString();
              } catch {}
              return { name: d.name, type, size, mtime };
            }),
          );
          entries.sort((a, b) => {
            if (a.type === "directory" && b.type !== "directory") return -1;
            if (a.type !== "directory" && b.type === "directory") return 1;
            return a.name.localeCompare(b.name);
          });
          const gitWt = url.searchParams.get("git");
          if (gitWt) {
            try {
              const statusOut = await $`git -C ${gitWt} status --porcelain`
                .quiet()
                .nothrow()
                .text();
              const gitMap = new Map<string, string>();
              for (const line of statusOut.split("\n")) {
                if (line.length < 4) continue;
                const xy = line.slice(0, 2);
                let filePath = line.slice(3);
                const arrow = filePath.indexOf(" -> ");
                if (arrow >= 0) filePath = filePath.slice(arrow + 4);
                filePath = filePath.replace(/^"(.*)"$/, "$1");
                const abs = resolve(gitWt, filePath);
                const dirPrefix = resolved.endsWith("/")
                  ? resolved
                  : resolved + "/";
                if (abs.startsWith(dirPrefix)) {
                  const rel = abs.slice(dirPrefix.length).split("/")[0]!;
                  const existing = gitMap.get(rel);
                  if (!existing || xy.trim().length > existing.trim().length) {
                    gitMap.set(rel, xy);
                  }
                }
              }
              for (const e of entries) {
                const status = gitMap.get(e.name);
                if (status) (e as any).git = status.trim();
              }
            } catch {}
          }
          return json({ path: resolved, entries });
        } catch (e) {
          return json(
            { error: String(e instanceof Error ? e.message : e) },
            { status: 500 },
          );
        }
      }

      if (url.pathname === "/api/exists" && req.method === "POST") {
        const body = (await req.json().catch(() => null)) as {
          paths?: unknown;
        } | null;
        const paths = Array.isArray(body?.paths)
          ? body.paths.filter((p): p is string => typeof p === "string")
          : null;
        if (!paths) {
          return json(
            { error: "body.paths must be string[]" },
            { status: 400 },
          );
        }
        // lstat each path in parallel so symlinks come back as "symlink"
        // instead of resolving to their target. Any stat error means
        // "doesn't exist" (covers ENOENT and EACCES — both render as missing).
        const { lstat } = await import("node:fs/promises");
        const entries = await Promise.all(
          paths.map(async (p) => {
            try {
              const s = await lstat(p);
              const type = s.isSymbolicLink()
                ? "symlink"
                : s.isDirectory()
                  ? "directory"
                  : "file";
              return [p, { exists: true, type }] as const;
            } catch {
              return [p, { exists: false }] as const;
            }
          }),
        );
        const results: Record<string, { exists: boolean; type?: string }> = {};
        for (const [p, info] of entries) results[p] = info;
        return json({ results });
      }

      if (url.pathname === "/api/pick-folder" && req.method === "POST") {
        try {
          const body = (await req.json().catch(() => null)) as {
            prompt?: unknown;
            startAt?: unknown;
            fallback?: unknown;
          } | null;
          const prompt =
            typeof body?.prompt === "string" ? body.prompt : undefined;
          const startAt =
            typeof body?.startAt === "string" ? body.startAt : undefined;
          const fallback =
            typeof body?.fallback === "string" ? body.fallback : undefined;
          const startResolved = await pickStartCandidate(startAt, fallback);
          const result = await pickFolder(prompt, startResolved);
          if ("cancelled" in result) {
            return new Response(null, { status: 204, headers: CORS });
          }
          return json(result);
        } catch (e) {
          return json(
            { error: String(e instanceof Error ? e.message : e) },
            { status: 500 },
          );
        }
      }

      if (url.pathname === "/api/pick-file" && req.method === "POST") {
        try {
          const body = (await req.json().catch(() => null)) as {
            prompt?: unknown;
            startAt?: unknown;
            fallback?: unknown;
          } | null;
          const prompt =
            typeof body?.prompt === "string" ? body.prompt : undefined;
          // Prefer `startAt` (e.g. last-pick) but if that's stale fall
          // through to `fallback` (e.g. the worktree directory). The
          // picker itself is tolerant of missing paths, but this lets
          // the caller hand us a second-choice without an extra
          // round-trip.
          const startAt =
            typeof body?.startAt === "string" ? body.startAt : undefined;
          const fallback =
            typeof body?.fallback === "string" ? body.fallback : undefined;
          const startResolved = await pickStartCandidate(startAt, fallback);
          const result = await pickFile(prompt, startResolved);
          if ("cancelled" in result) {
            return new Response(null, { status: 204, headers: CORS });
          }
          return json(result);
        } catch (e) {
          return json(
            { error: String(e instanceof Error ? e.message : e) },
            { status: 500 },
          );
        }
      }

      if (url.pathname === "/api/open-default" && req.method === "POST") {
        const body = (await req.json().catch(() => null)) as {
          path?: unknown;
        } | null;
        const targetPath = typeof body?.path === "string" ? body.path : null;
        if (!targetPath || targetPath.length === 0) {
          return json({ error: "body.path is required" }, { status: 400 });
        }
        try {
          const result = await openDefault(targetPath);
          return json(result);
        } catch (e) {
          return json(
            { error: String(e instanceof Error ? e.message : e) },
            { status: 500 },
          );
        }
      }

      if (url.pathname === "/api/config-fix" && req.method === "POST") {
        const body = (await req.json().catch(() => null)) as {
          file?: unknown;
        } | null;
        const filePath = typeof body?.file === "string" ? body.file : null;
        if (!filePath) {
          return json({ error: "body.file is required" }, { status: 400 });
        }
        try {
          // Non-destructive repair: recover the first complete top-level
          // JSON object and drop trailing garbage, backing up the broken
          // original first. NEVER blank the file — losing the user's whole
          // Claude config (projects, history, auth) is worse than the
          // parse error. Same logic the startup scan uses.
          const outcome = await repairClaudeJsonFile(filePath);
          switch (outcome.status) {
            case "missing":
              return json({ error: "file not found" }, { status: 404 });
            case "valid":
              return json({ ok: true, alreadyValid: true });
            case "unrecoverable":
              return json(
                {
                  error:
                    "Couldn't auto-repair: no complete JSON object found. Open the file and fix it by hand.",
                },
                { status: 422 },
              );
            case "repaired":
              return json({ ok: true, backup: outcome.result.backupPath });
          }
        } catch (e) {
          return json(
            { error: String(e instanceof Error ? e.message : e) },
            { status: 500 },
          );
        }
      }

      if (url.pathname === "/api/page-title" && req.method === "GET") {
        const target = url.searchParams.get("url");
        if (!target) {
          return json({ error: "?url= is required" }, { status: 400 });
        }
        let origin: URL;
        try {
          origin = new URL(target);
        } catch {
          return json({ error: "invalid url" }, { status: 400 });
        }
        if (origin.protocol !== "http:" && origin.protocol !== "https:") {
          return json({ error: "http(s) only" }, { status: 400 });
        }
        const title = await fetchPageTitle(origin.toString());
        return json({ url: origin.toString(), title });
      }

      if (url.pathname === "/api/events" && req.method === "GET") {
        const all = await events.list();
        // newest first for the UI's benefit
        return json(all.slice().reverse());
      }

      if (url.pathname === "/api/errors" && req.method === "GET") {
        const limitParam = url.searchParams.get("limit");
        const limit = limitParam ? Math.max(1, Number(limitParam)) : undefined;
        return json(await errors.list(limit ? { limit } : {}));
      }

      if (url.pathname === "/api/errors" && req.method === "POST") {
        type BrowserErrorPostBody = {
          id?: string;
          kind?: ErrorKind;
          source?: ErrorSource;
          route?: string;
          method?: string;
          status?: number;
          message?: string;
          stack?: string;
          extra?: Record<string, unknown>;
        };
        const body = (await req.json().catch(() => null)) as
          | BrowserErrorPostBody
          | BrowserErrorPostBody[]
          | null;
        const bodies = Array.isArray(body) ? body : body ? [body] : [];
        if (
          bodies.length === 0 ||
          bodies.some(
            (entry) => typeof entry.message !== "string" || !entry.message,
          )
        ) {
          return json(
            { error: "body.message (string) is required" },
            { status: 400 },
          );
        }
        const appended = [];
        let diagnosticCount = 0;
        for (const item of bodies) {
          const entry = await errors.append(
            {
              kind: item.kind ?? "uncaught",
              source: item.source ?? "browser",
              route: item.route,
              method: item.method,
              status: item.status,
              message: item.message!,
              stack: item.stack,
              extra: item.extra,
            },
            item.id,
          );
          appended.push(entry);
          if (item.kind === "diagnostic") diagnosticCount += 1;
          broadcast("error", entry);
        }
        if (diagnosticCount === 1 && bodies.length === 1) {
          const item = bodies[0]!;
          console.log(
            `supergit daemon: browser diagnostic ${item.message} ${
              item.extra ? JSON.stringify(item.extra) : "{}"
            }`,
          );
        } else if (diagnosticCount > 0) {
          const sample = bodies
            .filter((item) => item.kind === "diagnostic")
            .slice(0, 3)
            .map((item) => item.message)
            .join(" | ");
          console.log(
            `supergit daemon: browser diagnostics batch count=${diagnosticCount}` +
              `${sample ? ` sample=${sample}` : ""}`,
          );
        }
        return json(Array.isArray(body) ? appended : appended[0]);
      }

      if (url.pathname === "/api/errors" && req.method === "DELETE") {
        const startedAt = performance.now();
        await errors.clear();
        broadcast("error_clear", { ts: new Date().toISOString() });
        const totalMs = performance.now() - startedAt;
        record("errors-clear", totalMs);
        if (totalMs > 1_000) {
          console.warn(
            `supergit daemon: /api/errors clear slow total=${Math.round(totalMs)}ms`,
          );
        }
        return json({ ok: true });
      }

      const toggleMatch = url.pathname.match(
        /^\/api\/events\/([^/]+)\/(undo|redo)$/,
      );
      if (toggleMatch && req.method === "POST") {
        const id = toggleMatch[1]!;
        const toggle = toggleMatch[2] as "undo" | "redo";
        const original = await events.findById(id);
        if (!original)
          return json({ error: "event not found" }, { status: 404 });
        if (original.type === "undo" || original.type === "redo")
          return json(
            { error: `cannot ${toggle} a toggle event` },
            { status: 400 },
          );
        if (!original.reversible || original.inverse === undefined)
          return json({ error: "event is not reversible" }, { status: 400 });
        if (toggle === "undo" && original.undone)
          return json({ error: "already undone" }, { status: 409 });
        if (toggle === "redo" && !original.undone)
          return json(
            { error: "nothing to redo (event is currently applied)" },
            { status: 409 },
          );

        try {
          if (toggle === "undo") {
            // Apply the inverse
            if (original.type === "add_repo") {
              const inv = original.inverse as { repo: { id: string } };
              const removed = await workspace.removeRepo(inv.repo.id);
              if (!removed) {
                return json(
                  { error: "inverse failed: repo no longer exists" },
                  { status: 409 },
                );
              }
            } else if (original.type === "remove_repo") {
              const inv = original.inverse as {
                repo: import("./workspace").Repo;
              };
              await workspace.restoreRepo(inv.repo);
            } else if (original.type === "rename_repo") {
              const inv = original.inverse as { id: string; oldName: string };
              await workspace.renameRepo(inv.id, inv.oldName);
            } else if (original.type === "create_note") {
              const inv = original.inverse as { note: { id: string } };
              await notes.remove(inv.note.id);
            } else if (original.type === "remove_note") {
              const inv = original.inverse as {
                note: {
                  id: string;
                  body: string;
                  anchors: string[];
                  tags: string[];
                  kind?: AttachmentKind;
                  target?: import("./notes").LinkTarget;
                };
              };
              await notes.create({
                id: inv.note.id,
                body: inv.note.body,
                anchors: inv.note.anchors,
                tags: inv.note.tags,
                kind: inv.note.kind,
                target: inv.note.target,
              });
            } else if (original.type === "add_task") {
              const inv = original.inverse as { task: { id: string } };
              const removed = await workspace.removeTask(inv.task.id);
              if (!removed) {
                return json(
                  { error: "inverse failed: task no longer exists" },
                  { status: 409 },
                );
              }
            } else if (original.type === "remove_task") {
              const inv = original.inverse as {
                task: import("./workspace").Task;
              };
              await workspace.restoreTask(inv.task);
            } else if (original.type === "update_task") {
              // Restore the prior record: drop the current row, re-insert the
              // snapshot stashed in the inverse.
              const inv = original.inverse as {
                previous: import("./workspace").Task;
              };
              await workspace.removeTask(inv.previous.id);
              await workspace.restoreTask(inv.previous);
            } else {
              return json(
                { error: `no inverse handler for type: ${original.type}` },
                { status: 501 },
              );
            }
          } else {
            // redo: re-apply the original effect (using inverse.repo to preserve id)
            if (original.type === "add_repo") {
              const inv = original.inverse as {
                repo: import("./workspace").Repo;
              };
              await workspace.restoreRepo(inv.repo);
            } else if (original.type === "remove_repo") {
              const inv = original.inverse as { repo: { id: string } };
              const removed = await workspace.removeRepo(inv.repo.id);
              if (!removed) {
                return json(
                  { error: "redo failed: repo no longer exists" },
                  { status: 409 },
                );
              }
            } else if (original.type === "rename_repo") {
              const p = original.payload as { id: string; newName: string };
              await workspace.renameRepo(p.id, p.newName);
            } else if (original.type === "create_note") {
              const inv = original.inverse as {
                note: {
                  id: string;
                  body: string;
                  anchors: string[];
                  tags: string[];
                  kind?: AttachmentKind;
                  target?: import("./notes").LinkTarget;
                };
              };
              await notes.create({
                id: inv.note.id,
                body: inv.note.body,
                anchors: inv.note.anchors,
                tags: inv.note.tags,
                kind: inv.note.kind,
                target: inv.note.target,
              });
            } else if (original.type === "remove_note") {
              const inv = original.inverse as { note: { id: string } };
              await notes.remove(inv.note.id);
            } else if (original.type === "add_task") {
              const inv = original.inverse as {
                task: import("./workspace").Task;
              };
              await workspace.restoreTask(inv.task);
            } else if (original.type === "remove_task") {
              const inv = original.inverse as { task: { id: string } };
              const removed = await workspace.removeTask(inv.task.id);
              if (!removed) {
                return json(
                  { error: "redo failed: task no longer exists" },
                  { status: 409 },
                );
              }
            } else if (original.type === "update_task") {
              const p = original.payload as {
                id: string;
                patch: import("./workspace").TaskPatch;
              };
              await workspace.updateTask(p.id, p.patch);
            } else {
              return json(
                { error: `no redo handler for type: ${original.type}` },
                { status: 501 },
              );
            }
          }

          const toggleEv = await events.append({
            type: toggle,
            actor: "user",
            payload: { eventId: id },
          });
          broadcast("change", { kind: toggle, eventId: id });
          return json({ [toggle]: id, by: toggleEv.id });
        } catch (e) {
          return json(
            { error: String(e instanceof Error ? e.message : e) },
            { status: 500 },
          );
        }
      }

      // ── Task queue (per-worktree backlog; see plans/PLAN-tasks.md) ───
      // Mirrors the /api/repos CRUD: each mutation appends a reversible event
      // and broadcasts a change so every client refreshes. Agent-filed tasks
      // (createdBy: "agent") carry actor:"agent" on their event.

      if (url.pathname === "/api/tasks" && req.method === "GET") {
        const wt = url.searchParams.get("worktree");
        const all = await workspace.listTasks();
        return json(wt ? all.filter((t) => t.worktreePath === wt) : all);
      }

      if (url.pathname === "/api/tasks" && req.method === "POST") {
        const body = (await req.json().catch(() => null)) as {
          worktreePath?: unknown;
          agent?: unknown;
          name?: unknown;
          prompt?: unknown;
          status?: unknown;
          createdBy?: unknown;
        } | null;
        if (typeof body !== "object" || body === null) {
          return json({ error: "body must be a JSON object" }, { status: 400 });
        }
        try {
          const task = await workspace.addTask({
            worktreePath: String(body.worktreePath ?? ""),
            agent: body.agent as import("./workspace").TaskAgent,
            name: String(body.name ?? ""),
            prompt: typeof body.prompt === "string" ? body.prompt : undefined,
            status:
              typeof body.status === "string"
                ? (body.status as import("./workspace").TaskStatus)
                : undefined,
            createdBy: body.createdBy === "agent" ? "agent" : "user",
          });
          await events.append({
            type: "add_task",
            actor: task.createdBy === "agent" ? "agent" : "user",
            payload: { name: task.name, worktreePath: task.worktreePath },
            inverse: { task },
          });
          broadcast("change", { kind: "add_task", task });
          return json(task, { status: 201 });
        } catch (e) {
          return json(
            { error: String(e instanceof Error ? e.message : e) },
            { status: 400 },
          );
        }
      }

      const taskMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)$/);
      if (taskMatch && req.method === "PATCH") {
        const id = taskMatch[1]!;
        const body = (await req.json().catch(() => null)) as {
          name?: unknown;
          prompt?: unknown;
          status?: unknown;
          blockedReason?: unknown;
        } | null;
        if (typeof body !== "object" || body === null) {
          return json({ error: "body must be a JSON object" }, { status: 400 });
        }
        const patch: import("./workspace").TaskPatch = {};
        if (typeof body.name === "string") patch.name = body.name;
        if (typeof body.prompt === "string") patch.prompt = body.prompt;
        if (typeof body.status === "string")
          patch.status = body.status as import("./workspace").TaskStatus;
        if (typeof body.blockedReason === "string")
          patch.blockedReason = body.blockedReason;
        try {
          const res = await workspace.updateTask(id, patch);
          if (!res) return json({ error: "not found" }, { status: 404 });
          await events.append({
            type: "update_task",
            actor: "user",
            payload: { id, patch },
            inverse: { previous: res.previous },
          });
          broadcast("change", { kind: "update_task", task: res.task });
          return json(res.task);
        } catch (e) {
          return json(
            { error: String(e instanceof Error ? e.message : e) },
            { status: 400 },
          );
        }
      }

      if (taskMatch && req.method === "DELETE") {
        const id = taskMatch[1]!;
        const tasks = await workspace.listTasks();
        const task = tasks.find((t) => t.id === id);
        if (!task) return json({ error: "not found" }, { status: 404 });
        await workspace.removeTask(id);
        await events.append({
          type: "remove_task",
          actor: "user",
          payload: { id },
          inverse: { task },
        });
        broadcast("change", { kind: "remove_task", id });
        return new Response(null, { status: 204, headers: CORS });
      }

      // ── UI preferences (shared across browser + native app) ──────────

      if (url.pathname === "/api/prefs" && req.method === "GET") {
        return json(await workspace.getPrefs());
      }

      // ── Remote daemons (Phase 4b: a remote box as a folder row) ──────
      // CRUD on the registry + a reverse proxy. The proxy forwards
      // /api/daemons/<id>/<rest> over the ssh -L tunnel to the remote
      // daemon's own /api/<rest>, which lands there as a loopback request →
      // full API. See plans/PLAN-REMOTE-DAEMON.md. These are loopback-only
      // (the LAN gate already blocks them remotely — not in
      // LAN_ALLOWED_ROUTES).
      if (url.pathname === "/api/daemons" && req.method === "GET") {
        return json(await workspace.listRemoteDaemons());
      }

      // SECURITY: the connection string carries a forward-only private key
      // encoded as an opaque token. It is decoded server-side so the secret
      // lives only in <workspace>/keys/ at 0600 and never round-trips
      // through the browser as separate fields.
      if (url.pathname === "/api/daemons/connect" && req.method === "POST") {
        // Manual one-paste onboarding: the browser sent the opaque
        // `supergit1:` token; persist its (forward-only) key + register.
        const body = (await req.json().catch(() => null)) as {
          connectionString?: unknown;
        } | null;
        const cs =
          body && typeof body.connectionString === "string"
            ? body.connectionString
            : "";
        try {
          const daemon = await registerRemoteFromConnectionString(cs);
          return json(daemon);
        } catch (e) {
          return json(
            { error: String(e instanceof Error ? e.message : e) },
            { status: 400 },
          );
        }
      }

      // ── Auto-provision ("connect a daemon"): ship the bundled source to a
      // box over the user's own ssh, run install.sh, capture the printed
      // token, and register — with live progress streamed to the dialog. ──
      if (
        url.pathname === "/api/daemons/provision/capability" &&
        req.method === "GET"
      ) {
        return json({
          available: installPayload.mode !== "none",
          mode: installPayload.mode,
          sshAvailable: !!Bun.which("ssh"),
        });
      }

      if (url.pathname === "/api/daemons/provision" && req.method === "POST") {
        if (installPayload.mode === "none" || !installPayload.root) {
          return json(
            {
              error:
                "this build has no install payload bundled — auto-provision is unavailable; paste a connection string instead",
            },
            { status: 400 },
          );
        }
        if (!Bun.which("ssh")) {
          return json(
            { error: "ssh is not on PATH — cannot provision a box" },
            { status: 400 },
          );
        }
        const body = (await req.json().catch(() => null)) as Record<
          string,
          unknown
        > | null;
        if (!body || typeof body.host !== "string" || !body.host.trim()) {
          return json(
            { error: "body.host (string) required" },
            { status: 400 },
          );
        }
        const jobId = provisionManager.start({
          payloadRoot: installPayload.root,
          mode: installPayload.mode === "dev" ? "dev" : "packaged",
          target: {
            host: body.host.trim(),
            user:
              typeof body.user === "string" && body.user.trim()
                ? body.user.trim()
                : undefined,
            sshPort:
              typeof body.sshPort === "number" ? body.sshPort : undefined,
            // Windows boxes need cmd/PowerShell commands (their default ssh
            // shell is cmd.exe); anything else ships the posix tar|bash plan.
            os: body.os === "windows" ? "windows" : undefined,
            // Run the daemon as root (full box access) vs the sandboxed user.
            runAsRoot: body.root === true,
          },
          label: typeof body.label === "string" ? body.label : undefined,
        });
        return json({ jobId });
      }

      {
        const abortM = url.pathname.match(
          /^\/api\/daemons\/provision\/([^/]+)\/abort$/,
        );
        if (abortM && req.method === "POST") {
          provisionManager.abort(abortM[1]!);
          return json({ ok: true });
        }

        const streamM = url.pathname.match(
          /^\/api\/daemons\/provision\/([^/]+)\/stream$/,
        );
        if (streamM && req.method === "GET") {
          const jobId = streamM[1]!;
          const stream = new ReadableStream<Uint8Array>({
            async start(controller) {
              const send = (event: string, data: unknown): void => {
                try {
                  controller.enqueue(
                    sseEncoder.encode(
                      `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`,
                    ),
                  );
                } catch {
                  // controller closed — client disconnected
                }
              };
              const job = provisionManager.get(jobId);
              if (!job) {
                send("error", { message: "unknown provision job" });
                try {
                  controller.close();
                } catch {}
                return;
              }
              // Replay accumulated output so a reconnecting dialog catches up.
              if (job.output) send("output", { chunk: job.output });
              send("status", {
                status: job.status,
                daemonId: job.daemonId,
                error: job.error,
              });
              if (
                job.status === "done" ||
                job.status === "error" ||
                job.status === "aborted"
              ) {
                send("done", {});
                try {
                  controller.close();
                } catch {}
                return;
              }
              const unsub = provisionManager.subscribe(jobId, (chunk) =>
                send("output", { chunk }),
              );
              await provisionManager.wait(jobId);
              unsub();
              const final = provisionManager.get(jobId);
              send("status", {
                status: final?.status,
                daemonId: final?.daemonId,
                error: final?.error,
              });
              send("done", {});
              try {
                controller.close();
              } catch {}
            },
            cancel() {
              // Client closed the stream (dialog closed / reload). The job
              // keeps running on the daemon and survives — the dialog can
              // reconnect and replay. Abort is an explicit, separate action.
            },
          });
          return new Response(stream, {
            headers: {
              ...CORS,
              "Content-Type": "text/event-stream",
              "Cache-Control": "no-cache, no-transform",
              Connection: "keep-alive",
            },
          });
        }

        const getM = url.pathname.match(/^\/api\/daemons\/provision\/([^/]+)$/);
        if (getM && req.method === "GET") {
          const job = provisionManager.get(getM[1]!);
          if (!job) {
            return json({ error: "unknown provision job" }, { status: 404 });
          }
          return json(job);
        }
      }

      {
        // Uninstall the daemon ON the box: SSH in as admin (the stored tunnel
        // key is forward-only and can't run commands), run the OS installer's
        // uninstall flag, then unregister locally. No ship — the code is
        // already on the box. Must precede the generic /api/daemons/<id> proxy.
        const uninstallM = url.pathname.match(
          /^\/api\/daemons\/([^/]+)\/uninstall$/,
        );
        if (uninstallM && req.method === "POST") {
          const id = uninstallM[1]!;
          const daemons = await workspace.listRemoteDaemons();
          const daemon = daemons.find((d) => d.id === id);
          if (!daemon) {
            return json({ error: "remote daemon not found" }, { status: 404 });
          }
          const sshBin = Bun.which("ssh");
          if (!sshBin) {
            return json({ error: "ssh is not on PATH" }, { status: 400 });
          }
          const body = (await req.json().catch(() => null)) as Record<
            string,
            unknown
          > | null;
          const adminUser =
            body && typeof body.user === "string" && body.user.trim()
              ? body.user.trim()
              : "root";
          const sshPort =
            body && typeof body.sshPort === "number"
              ? body.sshPort
              : daemon.sshPort;
          const isWin = (daemon as { os?: string }).os === "windows";
          // Start a streaming uninstall JOB (same manager/SSE as provision)
          // so the dialog shows the live uninstaller log. On success the
          // manager's `unregister` dep tears down the tunnel + forgets it.
          const jobId = provisionManager.start({
            kind: "uninstall",
            daemonId: id,
            payloadRoot: installPayload.root ?? "",
            target: {
              host: daemon.host,
              user: adminUser,
              sshPort: typeof sshPort === "number" ? sshPort : undefined,
              os: isWin ? "windows" : undefined,
              installArgs: isWin ? ["-Uninstall"] : ["--uninstall"],
            },
            label: daemon.label,
          });
          return json({ jobId });
        }
      }

      {
        // Force-reconnect a remote daemon's tunnel: tear down the (possibly
        // half-dead, post-sleep) ssh and open a fresh one. Manual counterpart
        // to the proxy's automatic self-heal. Must precede the generic proxy.
        const reM = url.pathname.match(/^\/api\/daemons\/([^/]+)\/reconnect$/);
        if (reM && req.method === "POST") {
          const id = reM[1]!;
          const daemons = await workspace.listRemoteDaemons();
          const daemon = daemons.find((d) => d.id === id);
          if (!daemon) {
            return json({ error: "remote daemon not found" }, { status: 404 });
          }
          console.log(
            `supergit daemon: [tunnel] manual reconnect requested for ${daemon.label || daemon.host}`,
          );
          await tunnelManager.close(id);
          try {
            const tunnel = await tunnelManager.open(daemon);
            return json({ ok: true, localPort: tunnel.localPort });
          } catch (e) {
            return json(
              { ok: false, error: e instanceof Error ? e.message : String(e) },
              { status: 502 },
            );
          }
        }
      }

      {
        // Diagnose ONE remote daemon's connection: ssh-on-PATH → tunnel up →
        // health probe (timed), returned as an ordered checklist. (Re)opens
        // the tunnel as part of the check so it doubles as a probe. Local —
        // must precede the generic proxy.
        const dgM = url.pathname.match(/^\/api\/daemons\/([^/]+)\/connection$/);
        if (dgM && req.method === "GET") {
          const id = dgM[1]!;
          const daemons = await workspace.listRemoteDaemons();
          const daemon = daemons.find((d) => d.id === id);
          if (!daemon) {
            return json({ error: "remote daemon not found" }, { status: 404 });
          }
          const sshPath = Bun.which("ssh");
          let tunnel: { ok: boolean; localPort: number | null; error?: string };
          let probe: Awaited<ReturnType<typeof healthProbe>> | null = null;
          let latencyMs: number | null = null;
          try {
            const localPort = await ensureRemoteTunnelPort(id);
            tunnel = { ok: true, localPort };
            const t0 = performance.now();
            probe = await healthProbe(localPort);
            latencyMs = Math.round(performance.now() - t0);
          } catch (e) {
            tunnel = {
              ok: false,
              localPort: null,
              error: e instanceof Error ? e.message : String(e),
            };
          }
          const diagnosis = buildConnectionDiagnosis({
            daemon: {
              label: daemon.label,
              host: daemon.host,
              port: daemon.port,
            },
            sshPath: sshPath ?? null,
            tunnel,
            probe,
            latencyMs,
          });
          return json(diagnosis);
        }
      }

      if (url.pathname === "/api/daemons" && req.method === "POST") {
        const body = (await req.json().catch(() => null)) as Record<
          string,
          unknown
        > | null;
        if (!body || typeof body.host !== "string") {
          return json(
            { error: "body.host (string) required" },
            { status: 400 },
          );
        }
        try {
          const daemon = await workspace.addRemoteDaemon({
            label: typeof body.label === "string" ? body.label : "",
            host: body.host,
            user: typeof body.user === "string" ? body.user : undefined,
            port: typeof body.port === "number" ? body.port : undefined,
            sshPort:
              typeof body.sshPort === "number" ? body.sshPort : undefined,
            identityPath:
              typeof body.identityPath === "string"
                ? body.identityPath
                : undefined,
            color: typeof body.color === "string" ? body.color : undefined,
          });
          broadcast("change", { kind: "remote_daemon_add", id: daemon.id });
          return json(daemon);
        } catch (e) {
          return json(
            { error: String(e instanceof Error ? e.message : e) },
            { status: 400 },
          );
        }
      }

      {
        const proxied = parseDaemonProxyPath(url.pathname);
        // Bare `/api/daemons/<id>` + DELETE = unregister (and tear down
        // the tunnel). Everything else under an id is reverse-proxied.
        if (proxied && proxied.rest === "/" && req.method === "DELETE") {
          await tunnelManager.close(proxied.id);
          const removed = await workspace.removeRemoteDaemon(proxied.id);
          if (!removed) {
            return json({ error: "remote daemon not found" }, { status: 404 });
          }
          broadcast("change", {
            kind: "remote_daemon_remove",
            id: proxied.id,
          });
          return json({ ok: true });
        }
        if (proxied) {
          // Forwarding (and the sleep/wake self-heal) live in daemon-proxy.ts
          // so they're testable against a real in-process remote. A stale
          // tunnel (laptop slept → ssh half-dead) makes the first forward
          // 502; forwardWithReconnect tears it down + reopens, retrying the
          // request inline when it's idempotent.
          try {
            return await forwardWithReconnect(proxied, req, url.search, CORS, {
              openPort: () => ensureRemoteTunnelPort(proxied.id),
              closeTunnel: () =>
                tunnelManager.close(proxied.id).then(() => undefined),
              log: (m) => console.log(`supergit daemon: ${m}`),
              timeToHeadersMs: PROXY_TIME_TO_HEADERS_MS,
            });
          } catch (e) {
            // ensureRemoteTunnelPort threw on the FIRST attempt. Distinguish
            // "no such daemon" (404) from "the tunnel couldn't be brought up"
            // (502) — they need different fixes, and lumping both under "not
            // found" hid real tunnel failures (auth, host unreachable).
            const msg = e instanceof Error ? e.message : String(e);
            const notFound = msg.includes("remote daemon not found");
            return json(
              { error: notFound ? msg : `tunnel failed: ${msg}` },
              { status: notFound ? 404 : 502 },
            );
          }
        }
      }

      if (url.pathname === "/api/prefs" && req.method === "PATCH") {
        const body = await req.json().catch(() => null);
        if (typeof body !== "object" || body === null || Array.isArray(body)) {
          return json({ error: "body must be a JSON object" }, { status: 400 });
        }
        const patch: Record<string, string | null> = {};
        for (const [k, v] of Object.entries(body as Record<string, unknown>)) {
          if (v === null) patch[k] = null;
          else if (typeof v === "string") patch[k] = v;
        }
        const updated = await workspace.patchPrefs(patch);
        return json(updated);
      }

      if (url.pathname === "/api/notes" && req.method === "GET") {
        const anchorPrefix = url.searchParams.get("anchorPrefix") ?? undefined;
        const list = await notes.list(
          anchorPrefix !== null &&
            anchorPrefix !== undefined &&
            anchorPrefix.length > 0
            ? { anchorPrefix }
            : {},
        );
        return json(list);
      }

      if (url.pathname === "/api/notes" && req.method === "POST") {
        const body = (await req.json().catch(() => null)) as {
          id?: unknown;
          body?: unknown;
          anchors?: unknown;
          tags?: unknown;
          kind?: unknown;
          target?: unknown;
          secret?: unknown;
        } | null;
        if (!body || typeof body.body !== "string") {
          return json(
            { error: "body.body (string) is required" },
            { status: 400 },
          );
        }
        try {
          const note = await notes.create({
            id: typeof body.id === "string" ? body.id : undefined,
            body: body.body,
            anchors: Array.isArray(body.anchors)
              ? (body.anchors as unknown[]).filter(
                  (x): x is string => typeof x === "string",
                )
              : undefined,
            tags: Array.isArray(body.tags)
              ? (body.tags as unknown[]).filter(
                  (x): x is string => typeof x === "string",
                )
              : undefined,
            kind: parseKind(body.kind),
            target: parseTarget(body.target),
            ...(body.secret === true ? { secret: true } : {}),
          });
          const ev = await events.append({
            type: "create_note",
            actor: "user",
            payload: { note },
            inverse: { note },
          });
          broadcast("change", {
            kind: "note_create",
            id: note.id,
            eventId: ev.id,
          });
          return json({ ...note, eventId: ev.id }, { status: 201 });
        } catch (e) {
          return json(
            { error: String(e instanceof Error ? e.message : e) },
            { status: 409 },
          );
        }
      }

      {
        const m = url.pathname.match(/^\/api\/notes\/([^/]+)$/);
        if (m && req.method === "PUT") {
          const id = m[1]!;
          const body = (await req.json().catch(() => null)) as {
            body?: unknown;
            anchors?: unknown;
            tags?: unknown;
            kind?: unknown;
            target?: unknown;
            secret?: unknown;
          } | null;
          if (!body) {
            return json({ error: "JSON body required" }, { status: 400 });
          }
          try {
            // Distinguish "client did not send target" (leave intact)
            // from "client sent target: null" (clear the existing target).
            // `in` keeps the tri-state intent crisp at this boundary.
            const targetField: LinkTarget | null | undefined =
              "target" in body && body.target === null
                ? null
                : parseTarget(body.target);
            const note = await notes.update(id, {
              body: typeof body.body === "string" ? body.body : undefined,
              anchors: Array.isArray(body.anchors)
                ? (body.anchors as unknown[]).filter(
                    (x): x is string => typeof x === "string",
                  )
                : undefined,
              tags: Array.isArray(body.tags)
                ? (body.tags as unknown[]).filter(
                    (x): x is string => typeof x === "string",
                  )
                : undefined,
              kind: parseKind(body.kind),
              target: targetField,
              ...(typeof body.secret === "boolean"
                ? { secret: body.secret }
                : {}),
            });
            broadcast("change", { kind: "note_update", id: note.id });
            return json(note);
          } catch (e) {
            const msg = String(e instanceof Error ? e.message : e);
            const status = /not found/.test(msg) ? 404 : 400;
            return json({ error: msg }, { status });
          }
        }
        if (m && req.method === "DELETE") {
          const id = m[1]!;
          // Read the full note before deletion so we have the inverse
          // payload needed for undo. If it's missing, treat as 404
          // identically to NotesStore.remove() returning false.
          const existing = await notes.get(id);
          if (!existing)
            return json({ error: "note not found" }, { status: 404 });
          const removed = await notes.remove(id);
          if (!removed)
            return json({ error: "note not found" }, { status: 404 });
          const ev = await events.append({
            type: "remove_note",
            actor: "user",
            payload: { id },
            inverse: { note: existing },
          });
          broadcast("change", { kind: "note_delete", id, eventId: ev.id });
          return json({ ok: true, eventId: ev.id });
        }
      }

      if (url.pathname === "/mcp" && req.method === "GET") {
        return json(mcpServerInfo());
      }

      if (url.pathname === "/mcp" && req.method === "POST") {
        const body = (await req
          .json()
          .catch(() => null)) as JsonRpcRequest | null;
        if (
          !body ||
          body.jsonrpc !== "2.0" ||
          typeof body.method !== "string"
        ) {
          return json(
            {
              jsonrpc: "2.0",
              id: body?.id ?? null,
              error: { code: -32600, message: "invalid JSON-RPC 2.0 request" },
            },
            { status: 400 },
          );
        }
        const result = await handleMcp(body, { workspace, events });
        return json(result);
      }

      // ── SSH remote filesystem routes ──────────────────────────────

      if (url.pathname === "/api/ssh/sessions" && req.method === "GET") {
        const out: Record<
          string,
          { user: string | undefined; host: string; port: number }
        > = {};
        for (const [termId, s] of termSshSessions) {
          out[termId] = { user: s.user, host: s.host, port: s.port };
        }
        return json(out);
      }

      if (url.pathname === "/api/ssh/files" && req.method === "GET") {
        const termId = url.searchParams.get("term");
        const dirPath = url.searchParams.get("path");
        if (!termId || !dirPath)
          return json({ error: "term and path required" }, { status: 400 });
        const session = termSshSessions.get(termId);
        if (!session)
          return json(
            { error: "no SSH session for this terminal" },
            { status: 404 },
          );
        try {
          const sftp = await sshPool.connect(
            session.user,
            session.host,
            session.port,
          );
          const entries = await listRemoteDir(sftp, dirPath);
          const tracked = sshSyncTracker.getTracked(
            sshPool.hostKey(session.user, session.host, session.port),
          );
          for (const e of entries) {
            const remoteFull = dirPath.endsWith("/")
              ? dirPath + e.name
              : dirPath + "/" + e.name;
            const t = tracked.find((f) => f.remotePath === remoteFull);
            if (t) (e as Record<string, unknown>).sync = t.state;
          }
          return json({ path: dirPath, entries });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.log(
            `supergit daemon: /api/ssh/files error for path=${dirPath}: ${msg}`,
          );
          const described = describeRemoteListError(dirPath, msg);
          // Use 403 when we detected a known permission case so the
          // client can distinguish "you can't see this" from "the
          // server crashed".
          return json(described, { status: described.hint ? 403 : 500 });
        }
      }

      if (url.pathname === "/api/ssh/open" && req.method === "POST") {
        const body = await req.json().catch(() => null);
        if (
          !body ||
          typeof body.termId !== "string" ||
          typeof body.remotePath !== "string"
        ) {
          return json(
            { error: "termId and remotePath required" },
            { status: 400 },
          );
        }
        const session = termSshSessions.get(body.termId);
        if (!session)
          return json(
            { error: "no SSH session for this terminal" },
            { status: 404 },
          );
        try {
          const hostKey = sshPool.hostKey(
            session.user,
            session.host,
            session.port,
          );
          const localPath = cachePathFor(
            WORKSPACE_PATH,
            hostKey,
            body.remotePath,
          );
          const sftp = await sshPool.connect(
            session.user,
            session.host,
            session.port,
          );
          await downloadFile(sftp, body.remotePath, localPath);
          sshSyncTracker.startTracking(hostKey, body.remotePath, localPath);
          await openDefault(localPath);
          return json({ localPath, state: "editing" });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.log(
            `supergit daemon: /api/ssh/open error for path=${body.remotePath}: ${msg}`,
          );
          return json({ error: msg }, { status: 500 });
        }
      }

      if (url.pathname === "/api/ssh/home" && req.method === "GET") {
        const termId = url.searchParams.get("term");
        if (!termId) return json({ error: "term required" }, { status: 400 });
        const session = termSshSessions.get(termId);
        if (!session)
          return json(
            { error: "no SSH session for this terminal" },
            { status: 404 },
          );
        try {
          await sshPool.connect(session.user, session.host, session.port);
          const homeProbe = await sshPool.exec(
            session.user,
            session.host,
            session.port,
            "echo %USERPROFILE%",
          );
          let home = homeProbe.trim();
          if (home === "%USERPROFILE%") {
            home =
              (
                await sshPool.exec(
                  session.user,
                  session.host,
                  session.port,
                  "echo $HOME",
                )
              ).trim() || "/";
          }
          home = home.replace(/\\/g, "/");
          return json({ home });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return json({ error: msg }, { status: 500 });
        }
      }

      if (url.pathname === "/api/ssh/status" && req.method === "GET") {
        const termId = url.searchParams.get("term");
        if (!termId) return json({ error: "term required" }, { status: 400 });
        const session = termSshSessions.get(termId);
        if (!session) return json({ files: [] });
        const hostKey = sshPool.hostKey(
          session.user,
          session.host,
          session.port,
        );
        return json({ files: sshSyncTracker.getTracked(hostKey) });
      }

      if (url.pathname === "/api/ssh/confirm-upload" && req.method === "POST") {
        const body = await req.json().catch(() => null);
        if (!body || typeof body.localPath !== "string") {
          return json({ error: "localPath required" }, { status: 400 });
        }
        try {
          await sshSyncTracker.confirmUpload(body.localPath);
          return json({ ok: true });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return json({ error: msg }, { status: 500 });
        }
      }

      if (url.pathname === "/api/ssh/dismiss-upload" && req.method === "POST") {
        const body = await req.json().catch(() => null);
        if (!body || typeof body.localPath !== "string") {
          return json({ error: "localPath required" }, { status: 400 });
        }
        sshSyncTracker.dismissModified(body.localPath);
        return json({ ok: true });
      }

      // Production UI fallback: when SUPERGIT_UI_DIR is set, serve the
      // built SPA from there for any GET request that didn't match an
      // /api/* route. In dev mode UI_DIR is unset and Vite handles UI
      // hosting, so this block is a no-op.
      if (UI_DIR && req.method === "GET") {
        // Resolve safely — normalize and reject anything escaping UI_DIR.
        const reqPath = url.pathname === "/" ? "/index.html" : url.pathname;
        const candidate = resolve(UI_DIR, "." + normalize(reqPath));
        if (candidate === UI_DIR || candidate.startsWith(UI_DIR + sep)) {
          const file = Bun.file(candidate);
          if (await file.exists()) {
            // Same-origin response, no CORS headers needed.
            return new Response(file);
          }
        }
        // SPA fallback: unknown route → serve index.html so the client
        // router can take over. We never reach this for /api/* paths
        // because they're handled above.
        const index = Bun.file(join(UI_DIR, "index.html"));
        if (await index.exists()) return new Response(index);
      }

      return json({ error: "not found" }, { status: 404 });
    } catch (err) {
      // An exception escaped a route handler. Log with stack so the
      // browser-side Events popover can surface it for debugging, then
      // return a generic 500 to the caller.
      await recordServerError(req, 500, err).catch(() => {});
      const msg = err instanceof Error ? err.message : String(err);
      return json({ error: msg }, { status: 500 });
    }
  },

  websocket: {
    /** Subscribe the connecting client to the terminal's byte stream.
     *  Stays attached for the WS lifetime; on close we detach and start
     *  a grace timer that disposes the PTY if nothing else attaches. */
    open(ws) {
      if (ws.data.kind === "proxy") {
        // Now that the browser WS is upgraded, open the tunnel (async is
        // fine HERE — unlike the fetch handler) and bridge to the remote
        // daemon's terminal WS. RemoteWsBridge buffers any browser frames
        // that arrive before the remote socket opens, so deferring this is
        // safe. On tunnel failure, close the browser socket with the reason.
        const data = ws.data;
        void ensureRemoteTunnelPort(data.daemonId)
          .then((localPort) => {
            // The socket may have closed while the tunnel was coming up.
            if (data.bridge === null && (ws.readyState ?? 1) === 1) {
              const remoteUrl = buildProxyWsUrl(
                localPort,
                data.rest,
                data.search,
              );
              data.bridge = new RemoteWsBridge(remoteUrl, ws);
            }
          })
          .catch((e) => {
            const msg = e instanceof Error ? e.message : String(e);
            try {
              ws.close(1011, `tunnel failed: ${msg}`.slice(0, 120));
            } catch {
              // already closing
            }
          });
        return;
      }
      const { termId } = ws.data;
      const handle = terminalBackend.get(termId);
      if (!handle) {
        // The PTY is gone. If it was forgotten *after* exiting (the
        // common "resume command died immediately" case), report the
        // exit code so the UI can say "exited code 1" instead of a bare
        // "WebSocket error".
        ws.close(1011, terminalGoneReason(terminalBackend.getExitInfo(termId)));
        return;
      }
      cancelGrace(termId);
      orphanCleaner.onFrontendConnected();
      const pendingSpawnAt = terminalSpawnPendingWs.get(termId);
      const openAfterSpawnMs =
        pendingSpawnAt === undefined
          ? undefined
          : performance.now() - pendingSpawnAt;
      if (openAfterSpawnMs !== undefined) {
        terminalSpawnPendingWs.delete(termId);
        record("terminal-ws-open-after-spawn", openAfterSpawnMs);
      }
      terminalWsOpenedAt.set(termId, performance.now());
      console.log(
        `supergit daemon: terminal ws open id=${termId} pid=${handle.pid}${
          openAfterSpawnMs === undefined
            ? ""
            : ` openAfterSpawnMs=${Math.round(openAfterSpawnMs)}`
        }`,
      );
      addCount(visibleTerminalSockets, termId);
      addCount(drainableTerminalSockets, termId);
      updateTerminalOutputMute(termId);
      const soundScanner = new SoundMarkerScanner();
      const sub: TerminalSubscriber = {
        onData(chunk) {
          const { output, tags } = soundScanner.scan(chunk);
          for (const tag of tags) {
            broadcast("change", { kind: "sound_play", tag, termId });
          }
          if (output.length > 0) {
            const now = performance.now();
            const spawnFinishedAt = terminalSpawnFinishedAt.get(termId);
            const wsOpenedAt = terminalWsOpenedAt.get(termId);
            if (spawnFinishedAt !== undefined || wsOpenedAt !== undefined) {
              terminalSpawnFinishedAt.delete(termId);
              terminalWsOpenedAt.delete(termId);
              const firstOutputAfterSpawnMs =
                spawnFinishedAt === undefined
                  ? undefined
                  : now - spawnFinishedAt;
              const firstOutputAfterWsOpenMs =
                wsOpenedAt === undefined ? undefined : now - wsOpenedAt;
              if (firstOutputAfterSpawnMs !== undefined) {
                record(
                  "terminal-first-output-after-spawn",
                  firstOutputAfterSpawnMs,
                );
              }
              if (firstOutputAfterWsOpenMs !== undefined) {
                record(
                  "terminal-first-output-after-ws-open",
                  firstOutputAfterWsOpenMs,
                );
              }
              console.log(
                `supergit daemon: terminal first output id=${termId} pid=${handle.pid} bytes=${output.byteLength}${
                  firstOutputAfterSpawnMs === undefined
                    ? ""
                    : ` afterSpawnMs=${Math.round(firstOutputAfterSpawnMs)}`
                }${
                  firstOutputAfterWsOpenMs === undefined
                    ? ""
                    : ` afterWsOpenMs=${Math.round(firstOutputAfterWsOpenMs)}`
                }`,
              );
            }
            // Golden path: if the browser can drain bytes, send them. The
            // client decides whether to paint immediately (visible) or buffer
            // locally (offscreen). Only non-drainable sockets queue here.
            if (ws.data.outputDrainable) sendTerminalOutput(ws, output);
            else {
              queueTerminalOutput(ws, output);
              sendTerminalIoObserved(ws, output.byteLength);
            }
          }
        },
        onState(state) {
          // Text frame carrying daemon-detected terminal state (e.g.
          // "awaiting input"). The UI uses this to outline the column.
          try {
            ws.send(JSON.stringify({ type: "state", ...state }));
          } catch {
            // ws may be mid-close; ignore
          }
        },
        onExit(info) {
          console.log(
            `supergit daemon: terminal exit id=${termId} pid=${handle.pid} code=${info.code}` +
              `${info.signal ? ` signal=${info.signal}` : ""}`,
          );
          ws.send(JSON.stringify({ type: "exit", ...info }));
          // Give the client a beat to render the exit notice, then close.
          setTimeout(() => {
            try {
              ws.close(1000, "exited");
            } catch {}
          }, 50);
        },
      };
      ws.data.unsubscribe = handle.subscribe(sub);
    },

    drain(ws) {
      if (ws.data.kind === "terminal") flushTerminalOutput(ws);
    },

    /** Client messages: binary = bytes to write to the PTY (keystrokes).
     *  Text = JSON control frames; currently just `{type:"resize",cols,rows}`. */
    message(ws, msg) {
      if (ws.data.kind === "proxy") {
        // Forward keystrokes / resize frames to the remote terminal.
        ws.data.bridge?.sendToRemote(msg as string | Uint8Array);
        return;
      }
      const handle = terminalBackend.get(ws.data.termId);
      if (!handle) return;
      if (typeof msg === "string") {
        try {
          const parsed = JSON.parse(msg);
          if (parsed?.type === "resize") {
            handle.resize({
              cols: clampCols(Number(parsed.cols)),
              rows: clampRows(Number(parsed.rows)),
            });
          } else if (parsed?.type === "visibility") {
            setTerminalOutputVisible(
              ws,
              parsed.visible === true,
              parsed.drain === true,
            );
          } else if (parsed?.type === "paste-debug") {
            const id = typeof parsed.id === "string" ? parsed.id : "unknown";
            const phase =
              typeof parsed.phase === "string" ? parsed.phase : "unknown";
            const file = typeof parsed.file === "string" ? parsed.file : "";
            const bytes =
              typeof parsed.bytes === "number" && Number.isFinite(parsed.bytes)
                ? parsed.bytes
                : null;
            const chars =
              typeof parsed.chars === "number" && Number.isFinite(parsed.chars)
                ? parsed.chars
                : null;
            const reserved = new Set([
              "type",
              "id",
              "phase",
              "termId",
              "file",
              "bytes",
              "chars",
            ]);
            const details = Object.entries(parsed)
              .map(([key, value]) =>
                reserved.has(key) ? "" : pasteLogPart(key, value),
              )
              .join("");
            console.log(
              `supergit daemon: paste-debug id=${id} phase=${phase} term=${ws.data.termId}` +
                `${file ? ` file=${basename(file)}` : ""}` +
                `${bytes === null ? "" : ` bytes=${bytes}`}` +
                `${chars === null ? "" : ` chars=${chars}`}` +
                details,
            );
          }
        } catch {
          // ignore garbage control frames
        }
        return;
      }
      // Binary keystrokes from xterm.js — write through to the PTY.
      const buf =
        msg instanceof Uint8Array ? msg : new Uint8Array(msg as ArrayBuffer);
      // For shell PTYs, also feed the keystrokes into the per-shell
      // line buffer. Any Enter-terminated lines get appended to the
      // shell's JSONL as `kind: "cmd"` entries — the command history
      // transcript. cwd at log time comes from the cwd sampler's
      // latest known value for this shell (falls back to "" if it
      // hasn't sampled yet).
      const termId = ws.data.termId;
      if (shellTermIds.has(termId)) {
        const lines = feedShellInput(termId, buf);
        if (lines.length > 0) {
          const ts = new Date().toISOString();
          const cwd = shellCwds.get(termId) ?? "";
          const lastLine = lines[lines.length - 1]!;
          for (const line of lines) {
            void shells
              .append(termId, { kind: "cmd", ts, line, cwd })
              .catch(() => {});
          }
          void terminalPersist.updateLastCmd(termId, lastLine).catch(() => {});
        }
      }
      handle.write(buf);
    },

    close(ws) {
      if (ws.data.kind === "proxy") {
        // Browser closed → close the remote terminal socket too.
        ws.data.bridge?.closeRemote();
        return;
      }
      const termId = ws.data.termId;
      console.log(`supergit daemon: terminal ws close id=${termId}`);
      if (ws.data.outputVisible) {
        removeCount(visibleTerminalSockets, termId);
      }
      if (ws.data.outputDrainable)
        removeCount(drainableTerminalSockets, termId);
      updateTerminalOutputMute(termId);
      try {
        ws.data.unsubscribe?.();
      } catch {}
      ws.data.unsubscribe = null;
      orphanCleaner.onFrontendDisconnected();
      // If this was the last subscriber, schedule a grace-then-dispose.
      startGraceIfIdle(termId);
    },
  },
});

// Release the port cleanly when --watch restarts us, or on Ctrl-C.
// Two failure modes we have to defend against:
//   1) Re-entry: SIGINT (from terminal) and SIGTERM (from parent
//      start.ts calling server.kill()) arrive back-to-back. Without a
//      guard we'd run the whole shutdown sequence twice in parallel,
//      racing on server.stop() and printing "stopping" twice.
//   2) server.stop(true) can hang indefinitely if Bun's accounting of
//      active WS connections / pending handles doesn't drain (we've
//      seen the daemon stuck after "SIGTERM -> stopping"). A hard
//      deadline guarantees the process actually exits and releases the
//      port — start.ts's lsof fallback would catch it otherwise, but
//      that's slower and noisier than just exiting promptly here.
let shuttingDown = false;
const shutdown = async (signal: string) => {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`supergit daemon: ${signal} -> stopping`);
  // Time we let live PTYs flush + exit on their own before force-killing
  // them. Stops hard-killing Claude mid-write to .claude.json on every
  // restart (the corrupt-config dialog). The hard-exit deadline below
  // covers this drain plus the rest of teardown.
  const PTY_DRAIN_MS = 2000;
  const hardExit = setTimeout(() => {
    console.log("supergit daemon: graceful shutdown stalled, forcing exit");
    process.exit(1);
  }, PTY_DRAIN_MS + 2000);
  hardExit.unref?.();
  try {
    if (fetchTimer) clearInterval(fetchTimer);
    stopActivity();
    // Soft-kill PTYs first (SIGTERM / ConPTY close), wait out the grace,
    // then force-kill stragglers — before we tear anything else down.
    await terminalBackend.gracefulShutdown(PTY_DRAIN_MS);
    orphanCleaner.dispose();
    idleReaper.dispose();
    sshSyncTracker.dispose();
    sshPool.disconnectAll();
    await tunnelManager.closeAll().catch(() => {});
    // De-advertise from mDNS so other peers drop us immediately
    // instead of waiting for the TTL to expire (~60s).
    await peerDiscovery?.stop().catch(() => {});
    await server.stop(true);
  } catch (err) {
    console.log(`supergit daemon: shutdown error: ${(err as Error).message}`);
  }
  process.exit(0);
};
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGHUP", () => shutdown("SIGHUP"));

// Periodic auto-fetch so ahead/behind stays accurate. Disable with
// SUPERGIT_FETCH_INTERVAL_MS=0.
const FETCH_INTERVAL_MS = Number(
  process.env.SUPERGIT_FETCH_INTERVAL_MS ?? 5 * 60 * 1000,
);
let fetchTimer: ReturnType<typeof setInterval> | null = null;
// Per-repo in-flight guard — was a single bool, but visibility-driven
// fetches from the dashboard can target a subset of repos concurrently
// with the global 5-minute cycle, and we want them to coexist (only
// the same repo can't fetch twice simultaneously).
const fetchInFlight = new Set<string>();

async function runFetchCycle(repoIds?: string[]): Promise<void> {
  const all = await workspace.listRepos();
  const targeted = repoIds ? all.filter((r) => repoIds.includes(r.id)) : all;
  // Drop any already being fetched — avoids stomping on an in-progress
  // cycle when the dashboard's 30s tick lands on top of the 5-min one.
  const claimed = targeted.filter((r) => !fetchInFlight.has(r.id));
  if (claimed.length === 0) return;
  for (const r of claimed) fetchInFlight.add(r.id);
  try {
    const results = await Promise.allSettled(
      claimed.map((r) => fetchAll(r.path)),
    );
    const ok = results.filter(
      (r) => r.status === "fulfilled" && r.value,
    ).length;
    const tag = repoIds ? "visible-fetch" : "auto-fetch";
    console.log(
      `supergit daemon: ${tag} — ${ok}/${claimed.length} repos updated`,
    );
    broadcast("change", { kind: "fetch_complete", ok, total: claimed.length });
  } finally {
    for (const r of claimed) fetchInFlight.delete(r.id);
  }
}

// Live tail of agent session JSONLs. New entries within a session arrive
// here and we forward each as an "activity" SSE event so the dashboard can
// render a live activity line per worktree.
const stopActivity = await startActivityTail({
  detectAgents: sharedDetectAgents,
});
onActivity((ev) => broadcast("activity", ev));
console.log("supergit daemon: agent activity tail started");

await reconcileWorktreeWatchers();
console.log(
  `supergit daemon: watching ${worktreeWatchers.size} worktree(s) for FS changes`,
);

// Check for corrupted .claude.json files in all monitored repos.
// Windows hard-kills Claude Code PTYs on shutdown, which can leave
// .claude.json mid-write (double JSON, trailing garbage).
if (SIDE_INSTANCE_MODE) {
  console.log("supergit daemon: .claude.json repair disabled (side instance)");
} else {
  const repos = await workspace.listRepos();
  const repairs = await repairAllClaudeJson(repos.map((r) => r.path));
  for (const r of repairs) {
    console.log(
      `supergit daemon: repaired corrupted .claude.json in ${r.repoPath} (backup: ${r.backupPath})`,
    );
  }
}

if (SIDE_INSTANCE_MODE) {
  console.log("supergit daemon: auto-fetch disabled (side instance)");
} else if (FETCH_INTERVAL_MS > 0) {
  // Kick off shortly after startup so the dashboard doesn't show stale
  // ahead/behind on first load.
  setTimeout(() => void runFetchCycle(), 4_000);
  fetchTimer = setInterval(() => void runFetchCycle(), FETCH_INTERVAL_MS);
  console.log(
    `supergit daemon: auto-fetch every ${Math.round(FETCH_INTERVAL_MS / 1000)}s`,
  );
} else {
  console.log(
    "supergit daemon: auto-fetch disabled (SUPERGIT_FETCH_INTERVAL_MS=0)",
  );
}

// shellCwds, shellTermIds, and SHELL_CWD_INTERVAL_MS are declared above
// Bun.serve(...) — see the TDZ comment near `graceTimers`. The sampler
// and its interval live here because they only run after module init,
// so they don't share that hazard.
async function sampleShellCwds(): Promise<void> {
  // Skip the lsof shell-out when no UI client is connected. The cwd
  // map is only consumed by /api/shells and /api/shell-transcript,
  // both of which fall back to spawnCwd when an entry is missing — so
  // a brief lag on first reconnect (next 5s tick) is the only cost,
  // and we stop burning event-loop time on lsof while the dashboard
  // is closed. Headless / agent-driven daemons (no SSE clients ever)
  // pay zero overhead.
  if (sseSubscribers.size === 0) return;
  // Filter terminalBackend's full list to shell PTYs only — no point
  // running lsof on a Claude/Codex agent process.
  const shellRecords = terminalBackend
    .list()
    .filter((r) => r.agent === "shell");
  if (shellRecords.length === 0) return;
  const pidToTerm = new Map<number, string>();
  for (const r of shellRecords) pidToTerm.set(r.pid, r.id);
  const cwds = await sampleCwds([...pidToTerm.keys()]);
  for (const [pid, cwd] of cwds) {
    const termId = pidToTerm.get(pid);
    if (termId) shellCwds.set(termId, cwd);
  }
  // Drop entries for shells that have exited (their pid is gone from
  // pidToTerm). Iterate the cache, not the live set, so we don't keep
  // them indefinitely.
  for (const termId of [...shellCwds.keys()]) {
    if (!shellRecords.some((r) => r.id === termId)) shellCwds.delete(termId);
  }
}
setInterval(() => {
  void sampleShellCwds();
  void sampleSshSessions();
}, SHELL_CWD_INTERVAL_MS);

// Reap backgrounded, idle ssh logins. "Closing" a terminal panel only
// backgrounds it (a hidden muted subscriber keeps the grace timer from
// firing), so an interactive `ssh` session can stay authenticated and
// re-attachable for hours. Kill ssh PTYs that no on-screen socket is
// watching once they've been silent for SUPERGIT_TERMINAL_IDLE_REAP_MS
// (default 10m). 0 disables. See idle-reaper.ts for why this is ssh-only.
const IDLE_REAP_MS = Number(
  process.env.SUPERGIT_TERMINAL_IDLE_REAP_MS ?? 10 * 60 * 1000,
);
const idleReaper = new IdleReaper({
  idleMs: IDLE_REAP_MS,
  getCandidates: () =>
    terminalBackend.list().map((r) => ({
      id: r.id,
      pid: r.pid,
      isAlive: !r.exitedAt,
      isSsh: !!detectSshFromCmd(r.cmd),
      visibleCount: visibleTerminalSockets.get(r.id) ?? 0,
      lastOutputAt: r.lastOutputAt,
    })),
  killTerminal: async (id) => {
    cancelGrace(id);
    const h = terminalBackend.get(id);
    if (h?.isAlive()) await h.kill();
  },
  log: (msg) => console.log(`supergit daemon: ${msg}`),
});
if (IDLE_REAP_MS > 0) {
  idleReaper.start();
} else {
  console.log(
    "supergit daemon: idle ssh reaper disabled (SUPERGIT_TERMINAL_IDLE_REAP_MS=0)",
  );
}

async function sampleSshSessions(): Promise<void> {
  if (sseSubscribers.size === 0) return;
  const shellRecords = terminalBackend
    .list()
    .filter((r) => r.agent === "shell" && !r.exitedAt);
  if (shellRecords.length === 0) {
    if (termSshSessions.size > 0) {
      termSshSessions.clear();
      broadcast("ssh_change", {});
    }
    return;
  }
  const pids = shellRecords.map((r) => r.pid);
  const sshMap = await detectSshChildren(pids);
  // Also detect from the terminal's spawn command (works on Windows
  // where process-tree inspection isn't available).
  for (const r of shellRecords) {
    if (!sshMap.has(r.pid)) {
      const fromCmd = detectSshFromCmd(r.cmd);
      if (fromCmd) sshMap.set(r.pid, fromCmd);
    }
  }
  let changed = false;
  for (const r of shellRecords) {
    const session = sshMap.get(r.pid);
    const prev = termSshSessions.get(r.id);
    if (session && !prev) {
      termSshSessions.set(r.id, session);
      changed = true;
    } else if (!session && prev) {
      termSshSessions.delete(r.id);
      changed = true;
    }
  }
  // Prune exited terminals
  for (const termId of [...termSshSessions.keys()]) {
    if (!shellRecords.some((r) => r.id === termId)) {
      termSshSessions.delete(termId);
      changed = true;
    }
  }
  if (changed) broadcast("ssh_change", {});
}
