import { join, basename, normalize } from "node:path";
import {
  mkdir,
  readFile,
  writeFile,
  access,
  link,
  rename,
  unlink,
  readdir,
} from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { $ } from "bun";

/**
 * User-defined "open in" link. Three flavours:
 *  - `kind: "url"` — a plain web URL (Coolify dashboards, staging
 *    deploys). Opened in a new browser tab by the UI.
 *  - `kind: "file"` — a local file path opened with the operating
 *    system's default app (the same handler a Finder / Explorer
 *    double-click would route to).
 *  - `kind: "folder"` — a local directory opened in the OS file
 *    manager (Finder reveals the folder; Explorer opens it; xdg-open
 *    routes to the user's default file manager).
 *
 * The `kind` field is optional on read to keep older repos.json
 * files (written before file/folder links existed) interpretable —
 * entries without a kind default to "url" and carry their target in
 * `url`. New writes always include the explicit `kind`.
 */
export type CommandRunMode = "internal" | "external" | "shell";

export type CustomLink =
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

/** Resolve a CustomLink's effective kind, treating a missing field as
 *  "url" for backward-compat with pre-file-link repos.json entries. */
export function customLinkKind(
  link: CustomLink,
): "url" | "file" | "folder" | "command" {
  if (link.kind === "command") return "command";
  if (link.kind === "file") return "file";
  if (link.kind === "folder") return "folder";
  return "url";
}

/** Resolve a CustomLink's open target — URL for `url` links, absolute
 *  filesystem path for `file` / `folder` links. The shapes share no
 *  field name, so callers reach for this helper instead of
 *  `link.url ?? link.path`. */
export function customLinkTarget(link: CustomLink): string {
  const k = customLinkKind(link);
  if (k === "command") return (link as { cmd: string }).cmd;
  return k === "file" || k === "folder"
    ? (link as { path: string }).path
    : (link as { url: string }).url;
}

/** Validate raw user input and assemble a CustomLink with the given
 *  id. Shared by `addCustomLink` (which generates a fresh uuid) and
 *  `updateCustomLink` (which preserves the existing id while swapping
 *  the target). Throws on bad URLs / non-absolute file paths /
 *  unknown kinds. */
export type CustomLinkInput =
  | { url: string; name?: string }
  | { kind: "url"; url: string; name?: string }
  | { kind: "file"; path: string; name?: string }
  | { kind: "folder"; path: string; name?: string }
  | {
      kind: "command";
      cmd: string;
      cwd?: string;
      runMode?: CommandRunMode;
      name?: string;
    };

const VALID_RUN_MODES: ReadonlySet<string> = new Set([
  "internal",
  "external",
  "shell",
]);

function buildCustomLink(id: string, input: CustomLinkInput): CustomLink {
  if ("kind" in input && input.kind === "command") {
    const rawCmd = typeof input.cmd === "string" ? input.cmd.trim() : "";
    if (rawCmd.length === 0) throw new Error("cmd must be a non-empty string");
    const rawCwd = typeof input.cwd === "string" ? input.cwd.trim() : "";
    // cwd may be absolute OR relative-to-repo. Reject `..` segments to
    // keep relative paths inside the worktree.
    if (rawCwd.length > 0) {
      const isAbsolute =
        rawCwd.startsWith("/") || /^[a-zA-Z]:[\\/]/.test(rawCwd);
      if (!isAbsolute) {
        const segments = rawCwd.split(/[\\/]+/);
        if (segments.some((s) => s === "..")) {
          throw new Error("relative cwd may not contain '..' segments");
        }
      }
    }
    const mode: CommandRunMode =
      typeof input.runMode === "string" && VALID_RUN_MODES.has(input.runMode)
        ? input.runMode
        : "internal";
    const link: CustomLink = {
      id,
      kind: "command",
      cmd: rawCmd,
      runMode: mode,
    };
    if (rawCwd.length > 0) link.cwd = rawCwd;
    if (typeof input.name === "string") {
      const trimmed = input.name.trim();
      if (trimmed.length > 0) link.name = trimmed;
    }
    return link;
  }

  const pathKind =
    "kind" in input && (input.kind === "file" || input.kind === "folder")
      ? input.kind
      : null;
  if (pathKind) {
    const rawPath =
      typeof (input as { path: string }).path === "string"
        ? (input as { path: string }).path.trim()
        : "";
    if (rawPath.length === 0) {
      throw new Error("path must be a non-empty string");
    }
    if (!rawPath.startsWith("/") && !/^[a-zA-Z]:[\\/]/.test(rawPath)) {
      throw new Error("path must be absolute");
    }
    const link: CustomLink = { id, kind: pathKind, path: rawPath };
    if (typeof input.name === "string") {
      const trimmed = input.name.trim();
      if (trimmed.length > 0) link.name = trimmed;
    }
    return link;
  }
  // URL — either explicit `kind: "url"` or the legacy `{ url }` shape.
  const rawUrl =
    typeof (input as { url: string }).url === "string"
      ? (input as { url: string }).url.trim()
      : "";
  if (rawUrl.length === 0) {
    throw new Error("url must be a non-empty string");
  }
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error("url must be a valid URL");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("url must be http(s)");
  }
  const link: CustomLink = { id, kind: "url", url: rawUrl };
  if (typeof input.name === "string") {
    const trimmed = input.name.trim();
    if (trimmed.length > 0) link.name = trimmed;
  }
  return link;
}

export interface Repo {
  id: string;
  path: string;
  name: string;
  addedAt: string;
  /** Optional accent colour for the repo name — applied wherever the
   *  repo title renders (worktree header chip, TUI overview, etc.) so
   *  the user can tell repos apart at a glance. `#rrggbb` lowercase
   *  hex when set; absent means "use the default text colour". */
  color?: string;
  /** User-defined "open in <X>" links (e.g. Coolify dashboards, staging
   *  URLs). Render as extra chips in the worktree row's actions strip,
   *  with the target site's favicon as their icon. */
  customLinks?: CustomLink[];
}

export class DuplicateRepoError extends Error {
  constructor(
    public readonly repo: Repo,
    public readonly attemptedPath: string,
  ) {
    super(`Repo already registered: ${repo.path}`);
    this.name = "DuplicateRepoError";
  }
}

interface ReposFile {
  repos: Repo[];
}

/**
 * A remote supergit daemon the local daemon tunnels to and reverse-proxies
 * (Phase 4b — a remote box shown as a folder row). The local daemon owns an
 * `ssh -L` tunnel to `user@host:sshPort` forwarding to the remote daemon's
 * loopback `port`; requests to `/api/daemons/<id>/*` are forwarded there.
 * See plans/PLAN-REMOTE-DAEMON.md.
 */
export interface RemoteDaemon {
  id: string;
  /** User-friendly name shown on the row. */
  label: string;
  /** SSH host (hostname or IP) of the remote box. */
  host: string;
  /** SSH user. Absent → ssh's own default (config / current user). */
  user?: string;
  /** Port the remote supergit daemon listens on (its loopback). */
  port: number;
  /** SSH port. Absent → 22. */
  sshPort?: number;
  /** Path to the private key for the tunnel. Absent → ssh agent. */
  identityPath?: string;
  /** Optional accent colour for the row, mirroring Repo.color (`#rrggbb`). */
  color?: string;
  addedAt: string;
}

interface RemoteDaemonsFile {
  remoteDaemons: RemoteDaemon[];
}

/**
 * A queued task — a named unit of intended agent work parked against a
 * worktree's in-row queue (see plans/PLAN-tasks.md). Filled by a user or
 * another agent; worked off by a human. At this phase a task never spawns an
 * agent — it's a backlog entry with a triage status. `start` is deferred.
 */
export type TaskStatus = "ready" | "running" | "blocked" | "done";
export type TaskAgent = "claude" | "codex" | "shell";
const VALID_TASK_AGENTS: ReadonlySet<string> = new Set([
  "claude",
  "codex",
  "shell",
]);
const VALID_TASK_STATUSES: ReadonlySet<string> = new Set([
  "ready",
  "running",
  "blocked",
  "done",
]);

export interface Task {
  id: string;
  /** The worktree (cwd) this task is queued against. */
  worktreePath: string;
  agent: TaskAgent;
  name: string;
  /** The work for the agent; surfaced when a task is started (deferred). */
  prompt?: string;
  status: TaskStatus;
  /** Who filed it — `"agent"` for tasks posted by another agent via the CLI. */
  createdBy: "user" | "agent";
  createdAt: string;
  /** Free-text reason when `status === "blocked"`. */
  blockedReason?: string;
}

/** Fields a caller supplies when queueing a task; the store fills `id`,
 *  `createdAt`, and defaults `status` to `"ready"` and `createdBy` to
 *  `"user"`. */
export interface TaskInput {
  worktreePath: string;
  agent: TaskAgent;
  name: string;
  prompt?: string;
  status?: TaskStatus;
  createdBy?: "user" | "agent";
}

/** Mutable fields accepted by `updateTask`. */
export interface TaskPatch {
  name?: string;
  prompt?: string;
  status?: TaskStatus;
  blockedReason?: string;
}

interface TasksFile {
  tasks: Task[];
}

/** Fields a caller supplies when registering a remote daemon; the
 *  registry fills in `id` and `addedAt` and defaults `port`. */
export interface RemoteDaemonInput {
  label: string;
  host: string;
  user?: string;
  port?: number;
  sshPort?: number;
  identityPath?: string;
  color?: string;
}

const REPOS_FILE = "repos.json";
const SESSION_TITLES_FILE = "session-titles.json";
const PREFS_FILE = "prefs.json";
const OPEN_SESSIONS_PREF_KEY = "supergit:openSessions";
const OPEN_SESSIONS_BACKUP_DIR = "supergit_openSessions";
const REMOTE_DAEMONS_FILE = "remote-daemons.json";
const TASKS_FILE = "tasks.json";
const DEFAULT_REMOTE_DAEMON_PORT = 7777;

function backupTimestamp(date = new Date()): string {
  return date.toISOString().replace(/:/g, "-").replace(".", "-");
}

async function writeJsonFileAtomic(
  path: string,
  value: unknown,
): Promise<void> {
  const tmp = `${path}.tmp-${randomUUID()}`;
  await writeFile(tmp, JSON.stringify(value, null, 2));
  await rename(tmp, path);
}

async function writeJsonFileIfAbsentAtomic(
  path: string,
  value: unknown,
): Promise<void> {
  const tmp = `${path}.tmp-${randomUUID()}`;
  await writeFile(tmp, JSON.stringify(value, null, 2));
  try {
    await link(tmp, path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
  } finally {
    try {
      await unlink(tmp);
    } catch {}
  }
}

async function uniqueJsonPath(dir: string, basename: string): Promise<string> {
  let candidate = join(dir, `${basename}.json`);
  for (let i = 1; ; i++) {
    try {
      await access(candidate);
    } catch {
      return candidate;
    }
    candidate = join(dir, `${basename}-${i}.json`);
  }
}

async function pruneJsonFiles(dir: string, keep: number): Promise<void> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return;
  }
  const jsonFiles = names
    .filter((name) => name.endsWith(".json"))
    .sort((a, b) => b.localeCompare(a));
  for (const stale of jsonFiles.slice(keep)) {
    try {
      await unlink(join(dir, stale));
    } catch {}
  }
}

async function resolveGitToplevel(dir: string): Promise<string> {
  try {
    const top = await $`git -C ${dir} rev-parse --show-toplevel`.quiet().text();
    return normalize(top.trim());
  } catch {
    return dir;
  }
}

export class Workspace {
  private constructor(public readonly path: string) {}

  static async open(path: string): Promise<Workspace> {
    await mkdir(path, { recursive: true });
    const reposPath = join(path, REPOS_FILE);
    try {
      await access(reposPath);
    } catch {
      const empty: ReposFile = { repos: [] };
      await writeFile(reposPath, JSON.stringify(empty, null, 2));
    }
    return new Workspace(path);
  }

  /** Return all manual session titles as `{ [source]: title }`. Missing
   *  file or unparseable contents yield an empty map (tolerant of corrupt
   *  state — callers here are read-only display paths that prefer "show
   *  placeholders" over surfacing an error). The strict variant
   *  `readSessionTitlesStrict` is used for read-modify-write paths so a
   *  transient error can never clobber the file. */
  async listSessionTitles(): Promise<Record<string, string>> {
    try {
      return await this.readSessionTitlesStrict();
    } catch {
      return {};
    }
  }

  /** Read + parse session-titles.json. Returns `{}` when the file is
   *  legitimately absent (first run). Throws when the file exists but
   *  is unreadable or unparseable — used by set/migrate to refuse to
   *  overwrite an opaque file with a stripped-down one entry.
   *
   *  Background: previously every read returned `{}` on any error, so a
   *  Windows AV scan or partial-write race that briefly blocked the
   *  read would cause the next setSessionTitle call to JSON.stringify a
   *  single-entry object and writeFile it, wiping every other title the
   *  user had set. */
  private async readSessionTitlesStrict(): Promise<Record<string, string>> {
    const file = join(this.path, SESSION_TITLES_FILE);
    let raw: string;
    try {
      raw = await readFile(file, "utf-8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
      throw new Error(
        `failed to read session-titles.json: ${(err as Error).message}`,
      );
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      throw new Error(
        `failed to parse session-titles.json: ${(err as Error).message}`,
      );
    }
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed)
    ) {
      throw new Error("session-titles.json must be a JSON object");
    }
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof k !== "string" || k.length === 0) continue;
      if (typeof v !== "string" || v.length === 0) continue;
      out[k] = v;
    }
    return out;
  }

  /** Atomically replace session-titles.json. Writes to a sibling .tmp
   *  file then renames it over the destination — `rename` is atomic
   *  on a single volume on every supported OS, so a power loss or
   *  daemon crash mid-write can leave either the old or new file in
   *  place but never a half-written / empty one. */
  private async writeSessionTitles(
    titles: Record<string, string>,
  ): Promise<void> {
    const dst = join(this.path, SESSION_TITLES_FILE);
    const tmp = `${dst}.tmp`;
    await writeFile(tmp, JSON.stringify(titles, null, 2));
    try {
      await rename(tmp, dst);
    } catch (err) {
      // Best-effort cleanup so a failed rename doesn't leave a stray
      // .tmp behind. We swallow the unlink error because the rename
      // error is the one the caller cares about.
      await unlink(tmp).catch(() => {});
      throw err;
    }
  }

  /** Persist a manual title for a session, keyed by the session's `source`
   *  (its JSONL path, or the synthetic `__new__:…` source while a TUI is
   *  still spawning). Empty / whitespace-only `title` deletes the entry. */
  async setSessionTitle(source: string, title: string): Promise<void> {
    if (typeof source !== "string" || source.length === 0) {
      throw new Error("source must be a non-empty string");
    }
    const titles = await this.readSessionTitlesStrict();
    const trimmed = title.trim();
    if (trimmed.length === 0) {
      if (!(source in titles)) return;
      delete titles[source];
    } else {
      titles[source] = trimmed;
    }
    await this.writeSessionTitles(titles);
  }

  /** Move a manual title from `oldSource` to `newSource`. Used when a
   *  column's source string changes mid-flight (e.g. a `__new__:shell:<random>`
   *  PTY spawns and we swap to its `__attached__:shell:<termId>` form, or a
   *  `__new__:claude:<random>` agent's JSONL appears on disk and we swap to
   *  the real path). Without this, the title the user typed against the
   *  synthetic source would be silently orphaned.
   *
   *  No-op if `oldSource` has no title. Preserves both entries if `newSource`
   *  already has its own title (the more-explicit later edit wins; we never
   *  silently overwrite). */
  async migrateSessionTitle(
    oldSource: string,
    newSource: string,
  ): Promise<void> {
    if (typeof oldSource !== "string" || oldSource.length === 0) {
      throw new Error("oldSource must be a non-empty string");
    }
    if (typeof newSource !== "string" || newSource.length === 0) {
      throw new Error("newSource must be a non-empty string");
    }
    if (oldSource === newSource) return;
    const titles = await this.readSessionTitlesStrict();
    const oldTitle = titles[oldSource];
    if (!oldTitle) return;
    if (titles[newSource]) return; // destination already named; don't clobber
    delete titles[oldSource];
    titles[newSource] = oldTitle;
    await this.writeSessionTitles(titles);
  }

  async listRepos(): Promise<Repo[]> {
    const data = await readFile(join(this.path, REPOS_FILE), "utf-8");
    const parsed = JSON.parse(data) as ReposFile;
    return parsed.repos;
  }

  async addRepo(repoPath: string): Promise<Repo> {
    const resolved = await resolveGitToplevel(repoPath);
    const repos = await this.listRepos();
    const existing = repos.find((r) => r.path === resolved);
    if (existing) {
      throw new DuplicateRepoError(existing, resolved);
    }
    const name = basename(resolved) || resolved;
    const repo: Repo = {
      id: randomUUID(),
      path: resolved,
      name,
      addedAt: new Date().toISOString(),
    };
    repos.push(repo);
    await this.writeRepos(repos);
    return repo;
  }

  async removeRepo(id: string): Promise<boolean> {
    const repos = await this.listRepos();
    const next = repos.filter((r) => r.id !== id);
    if (next.length === repos.length) return false;
    await this.writeRepos(next);
    return true;
  }

  /**
   * Re-insert a repo with its original id and metadata. Used by undo/redo so
   * id stability lets later toggle events still reference the same repo.
   */
  async restoreRepo(repo: Repo): Promise<void> {
    const repos = await this.listRepos();
    if (repos.some((r) => r.id === repo.id)) {
      throw new Error(`Repo already exists with id ${repo.id}`);
    }
    if (repos.some((r) => r.path === repo.path)) {
      throw new Error(`Repo already exists at path ${repo.path}`);
    }
    repos.push(repo);
    await this.writeRepos(repos);
  }

  /**
   * Set (or clear with `null`) a repo's accent colour. Returns the
   * previous and new values so the caller can decide whether to emit
   * an event or skip a no-op write. Colours are validated as `#rrggbb`
   * hex; anything else is rejected.
   */
  async setRepoColor(
    id: string,
    color: string | null,
  ): Promise<{ oldColor?: string; newColor?: string }> {
    let nextColor: string | undefined;
    if (color !== null) {
      const trimmed = color.trim().toLowerCase();
      if (!/^#[0-9a-f]{6}$/.test(trimmed)) {
        throw new Error("color must be #rrggbb hex or null");
      }
      nextColor = trimmed;
    }
    const repos = await this.listRepos();
    const idx = repos.findIndex((r) => r.id === id);
    if (idx < 0) throw new Error(`Repo not found: ${id}`);
    const oldColor = repos[idx]!.color;
    if (oldColor === nextColor) return { oldColor, newColor: nextColor };
    const next: Repo = { ...repos[idx]! };
    if (nextColor === undefined) delete next.color;
    else next.color = nextColor;
    repos[idx] = next;
    await this.writeRepos(repos);
    return { oldColor, newColor: nextColor };
  }

  /**
   * Rename a registered repo. Returns the previous name so the caller can
   * record an inverse for undo.
   */
  async renameRepo(
    id: string,
    newName: string,
  ): Promise<{ oldName: string; newName: string }> {
    const trimmed = newName.trim();
    if (trimmed.length === 0) {
      throw new Error("name must not be empty");
    }
    const repos = await this.listRepos();
    const idx = repos.findIndex((r) => r.id === id);
    if (idx < 0) throw new Error(`Repo not found: ${id}`);
    const oldName = repos[idx]!.name;
    if (oldName === trimmed) return { oldName, newName: trimmed };
    repos[idx] = { ...repos[idx]!, name: trimmed };
    await this.writeRepos(repos);
    return { oldName, newName: trimmed };
  }

  /**
   * Reorder the registered repos to match the provided id list.
   * `orderedIds` must be a permutation of the existing repo ids — same
   * length, same set, just rearranged. Returns the previous order (id
   * list) so the caller can detect a no-op. Throws if the ids don't
   * match. Repo display order in the dashboard is derived straight from
   * this array order, so this is the single source of truth for it.
   */
  async reorderRepos(
    orderedIds: string[],
  ): Promise<{ oldOrder: string[]; newOrder: string[] }> {
    if (!Array.isArray(orderedIds)) {
      throw new Error("orderedIds must be an array of repo ids");
    }
    const repos = await this.listRepos();
    const oldOrder = repos.map((r) => r.id);
    if (orderedIds.length !== oldOrder.length) {
      throw new Error("orderedIds length must match existing repos");
    }
    const seen = new Set<string>();
    for (const rid of orderedIds) {
      if (typeof rid !== "string" || rid.length === 0) {
        throw new Error("orderedIds must contain non-empty strings");
      }
      if (seen.has(rid)) {
        throw new Error("orderedIds must be unique");
      }
      seen.add(rid);
    }
    const byId = new Map(repos.map((r) => [r.id, r]));
    const reordered: Repo[] = [];
    for (const rid of orderedIds) {
      const repo = byId.get(rid);
      if (!repo) throw new Error(`Unknown repo id: ${rid}`);
      reordered.push(repo);
    }
    if (oldOrder.every((rid, i) => rid === orderedIds[i])) {
      return { oldOrder, newOrder: [...orderedIds] };
    }
    await this.writeRepos(reordered);
    return { oldOrder, newOrder: [...orderedIds] };
  }

  /**
   * Append a user-defined "open in" link to a repo. Returns the newly
   * minted entry (with its generated id) so the caller can echo it
   * back to the client.
   *
   * Input shape is a discriminated union: pass `{ url: "https://…" }`
   * for a web link or `{ path: "/abs/path" }` for a file link. URLs
   * are validated as http(s); file paths must be absolute.
   */
  async addCustomLink(id: string, input: CustomLinkInput): Promise<CustomLink> {
    const repos = await this.listRepos();
    const idx = repos.findIndex((r) => r.id === id);
    if (idx < 0) throw new Error(`Repo not found: ${id}`);
    const link = buildCustomLink(randomUUID(), input);
    const next: Repo = { ...repos[idx]! };
    next.customLinks = [...(next.customLinks ?? []), link];
    repos[idx] = next;
    await this.writeRepos(repos);
    return link;
  }

  /**
   * Update a previously-added custom link in place. Pass `url` to
   * change a URL link's target (also implicitly converts a file link
   * to a URL one), `path` to set a file path, `name` to set or clear
   * (`""`) the label. Returns the updated link, or `null` if no link
   * with that id exists on the repo. Throws if the repo itself is
   * unknown or the new value fails validation.
   */
  async updateCustomLink(
    id: string,
    linkId: string,
    input: {
      url?: string;
      path?: string;
      cmd?: string;
      cwd?: string;
      runMode?: CommandRunMode;
      kind?: "url" | "file" | "folder" | "command";
      name?: string;
    },
  ): Promise<CustomLink | null> {
    const repos = await this.listRepos();
    const idx = repos.findIndex((r) => r.id === id);
    if (idx < 0) throw new Error(`Repo not found: ${id}`);
    const links = repos[idx]!.customLinks ?? [];
    const linkIdx = links.findIndex((l) => l.id === linkId);
    if (linkIdx < 0) return null;
    const current = links[linkIdx]!;

    const currentKind = customLinkKind(current);
    const currentName = current.name;

    let merged: CustomLinkInput;

    if (
      input.kind === "command" ||
      (input.cmd !== undefined && currentKind === "command")
    ) {
      const rawCmd =
        input.cmd ??
        (currentKind === "command" ? (current as { cmd: string }).cmd : "");
      const rawCwd =
        input.cwd ??
        (currentKind === "command"
          ? (current as { cwd?: string }).cwd
          : undefined);
      const rawMode =
        input.runMode ??
        (currentKind === "command"
          ? (current as { runMode: CommandRunMode }).runMode
          : "internal");
      merged = { kind: "command", cmd: rawCmd, cwd: rawCwd, runMode: rawMode };
    } else if (input.url !== undefined && input.path !== undefined) {
      throw new Error("pass either url or path, not both");
    } else if (input.url !== undefined) {
      merged = { kind: "url", url: input.url };
    } else if (input.path !== undefined) {
      const explicit =
        input.kind === "folder"
          ? "folder"
          : input.kind === "file"
            ? "file"
            : null;
      const inherited =
        currentKind === "folder"
          ? "folder"
          : currentKind === "file"
            ? "file"
            : "file";
      const newKind = explicit ?? inherited;
      merged = { kind: newKind, path: input.path };
    } else if (currentKind === "command") {
      merged = {
        kind: "command",
        cmd: (current as { cmd: string }).cmd,
        cwd: (current as { cwd?: string }).cwd,
        runMode: (current as { runMode: CommandRunMode }).runMode,
      };
    } else if (currentKind === "file") {
      merged = {
        kind: "file",
        path: (current as { path: string }).path,
      };
    } else if (currentKind === "folder") {
      merged = {
        kind: "folder",
        path: (current as { path: string }).path,
      };
    } else {
      merged = {
        kind: "url",
        url: (current as { url: string }).url,
      };
    }

    // Name: explicit blank clears, explicit value sets, undefined
    // preserves whatever was there before.
    if (input.name !== undefined) {
      const trimmedName = input.name.trim();
      if (trimmedName.length > 0) merged.name = trimmedName;
    } else if (currentName !== undefined) {
      merged.name = currentName;
    }

    const next = buildCustomLink(current.id, merged);
    const newLinks = [...links];
    newLinks[linkIdx] = next;
    const repo: Repo = { ...repos[idx]!, customLinks: newLinks };
    repos[idx] = repo;
    await this.writeRepos(repos);
    return next;
  }

  /**
   * Reorder the repo's custom links to match the provided id list.
   * `orderedIds` must be a permutation of the repo's existing link
   * ids — same length, same set, just rearranged. Returns the
   * previous order (id list) so the caller can record an inverse for
   * undo. Throws if the repo is unknown or the ids don't match.
   */
  async reorderCustomLinks(
    id: string,
    orderedIds: string[],
  ): Promise<{ oldOrder: string[]; newOrder: string[] }> {
    if (!Array.isArray(orderedIds)) {
      throw new Error("orderedIds must be an array of link ids");
    }
    const repos = await this.listRepos();
    const idx = repos.findIndex((r) => r.id === id);
    if (idx < 0) throw new Error(`Repo not found: ${id}`);
    const links = repos[idx]!.customLinks ?? [];
    const oldOrder = links.map((l) => l.id);
    if (orderedIds.length !== oldOrder.length) {
      throw new Error("orderedIds length must match existing links");
    }
    const seen = new Set<string>();
    for (const lid of orderedIds) {
      if (typeof lid !== "string" || lid.length === 0) {
        throw new Error("orderedIds must contain non-empty strings");
      }
      if (seen.has(lid)) {
        throw new Error("orderedIds must be unique");
      }
      seen.add(lid);
    }
    const byId = new Map(links.map((l) => [l.id, l]));
    const reordered: CustomLink[] = [];
    for (const lid of orderedIds) {
      const link = byId.get(lid);
      if (!link) throw new Error(`Unknown link id: ${lid}`);
      reordered.push(link);
    }
    if (oldOrder.every((lid, i) => lid === orderedIds[i])) {
      return { oldOrder, newOrder: [...orderedIds] };
    }
    const next: Repo = { ...repos[idx]!, customLinks: reordered };
    repos[idx] = next;
    await this.writeRepos(repos);
    return { oldOrder, newOrder: [...orderedIds] };
  }

  /**
   * Remove a custom link by its id. Returns the removed entry so the
   * caller can record an inverse, or `null` if no such link exists on
   * the repo. Throws if the repo itself is unknown.
   */
  async removeCustomLink(
    id: string,
    linkId: string,
  ): Promise<CustomLink | null> {
    const repos = await this.listRepos();
    const idx = repos.findIndex((r) => r.id === id);
    if (idx < 0) throw new Error(`Repo not found: ${id}`);
    const links = repos[idx]!.customLinks ?? [];
    const linkIdx = links.findIndex((l) => l.id === linkId);
    if (linkIdx < 0) return null;
    const removed = links[linkIdx]!;
    const next: Repo = { ...repos[idx]! };
    const remaining = links.filter((_, i) => i !== linkIdx);
    if (remaining.length === 0) delete next.customLinks;
    else next.customLinks = remaining;
    repos[idx] = next;
    await this.writeRepos(repos);
    return removed;
  }

  private async writeRepos(repos: Repo[]): Promise<void> {
    const payload: ReposFile = { repos };
    await writeFile(
      join(this.path, REPOS_FILE),
      JSON.stringify(payload, null, 2),
    );
  }

  // ── Remote daemons (Phase 4b: a remote box as a folder row) ──────
  // Mirrors the Repo CRUD above. Stored in its own remote-daemons.json
  // (not repos.json) so local repos and remote daemons never clobber each
  // other, and a tolerant read keeps a corrupt/absent file from breaking
  // the dashboard. See plans/PLAN-REMOTE-DAEMON.md.

  async listRemoteDaemons(): Promise<RemoteDaemon[]> {
    try {
      const raw = await readFile(
        join(this.path, REMOTE_DAEMONS_FILE),
        "utf-8",
      );
      const parsed = JSON.parse(raw) as RemoteDaemonsFile;
      if (!parsed || !Array.isArray(parsed.remoteDaemons)) return [];
      return parsed.remoteDaemons;
    } catch {
      return [];
    }
  }

  async addRemoteDaemon(input: RemoteDaemonInput): Promise<RemoteDaemon> {
    const host = input.host?.trim();
    if (!host) throw new Error("remote daemon host must be non-empty");
    const label = input.label?.trim() || host;
    const daemon: RemoteDaemon = {
      id: randomUUID(),
      label,
      host,
      port: input.port ?? DEFAULT_REMOTE_DAEMON_PORT,
      addedAt: new Date().toISOString(),
    };
    if (input.user?.trim()) daemon.user = input.user.trim();
    if (input.sshPort != null) daemon.sshPort = input.sshPort;
    if (input.identityPath?.trim())
      daemon.identityPath = input.identityPath.trim();
    if (input.color?.trim()) daemon.color = input.color.trim();
    const daemons = await this.listRemoteDaemons();
    daemons.push(daemon);
    await this.writeRemoteDaemons(daemons);
    return daemon;
  }

  async removeRemoteDaemon(id: string): Promise<boolean> {
    const daemons = await this.listRemoteDaemons();
    const next = daemons.filter((d) => d.id !== id);
    if (next.length === daemons.length) return false;
    await this.writeRemoteDaemons(next);
    return true;
  }

  /** Re-insert a remote daemon with its original id + metadata (undo/redo
   *  parity with restoreRepo). Refuses to duplicate an existing id. */
  async restoreRemoteDaemon(daemon: RemoteDaemon): Promise<void> {
    const daemons = await this.listRemoteDaemons();
    if (daemons.some((d) => d.id === daemon.id)) {
      throw new Error(`Remote daemon already exists with id ${daemon.id}`);
    }
    daemons.push(daemon);
    await this.writeRemoteDaemons(daemons);
  }

  private async writeRemoteDaemons(daemons: RemoteDaemon[]): Promise<void> {
    const payload: RemoteDaemonsFile = { remoteDaemons: daemons };
    await writeFile(
      join(this.path, REMOTE_DAEMONS_FILE),
      JSON.stringify(payload, null, 2),
    );
  }

  // ── Task queue (per-worktree backlog; see plans/PLAN-tasks.md) ───
  // Mirrors the Repo / RemoteDaemon CRUD. Stored in its own tasks.json so it
  // never clobbers repos.json, with a tolerant read so a corrupt/absent file
  // degrades to an empty queue rather than breaking the dashboard. Writes go
  // through writeTasks (temp + atomic rename).

  async listTasks(): Promise<Task[]> {
    try {
      const raw = await readFile(join(this.path, TASKS_FILE), "utf-8");
      const parsed = JSON.parse(raw) as TasksFile;
      if (!parsed || !Array.isArray(parsed.tasks)) return [];
      return parsed.tasks;
    } catch {
      return [];
    }
  }

  async addTask(input: TaskInput): Promise<Task> {
    const name = typeof input.name === "string" ? input.name.trim() : "";
    if (name.length === 0) throw new Error("task name must be non-empty");
    if (!VALID_TASK_AGENTS.has(input.agent)) {
      throw new Error(`unknown task agent: ${String(input.agent)}`);
    }
    const worktreePath =
      typeof input.worktreePath === "string" ? input.worktreePath.trim() : "";
    if (worktreePath.length === 0) {
      throw new Error("task worktreePath must be non-empty");
    }
    const status =
      input.status && VALID_TASK_STATUSES.has(input.status)
        ? input.status
        : "ready";
    const task: Task = {
      id: randomUUID(),
      worktreePath,
      agent: input.agent,
      name,
      status,
      createdBy: input.createdBy === "agent" ? "agent" : "user",
      createdAt: new Date().toISOString(),
    };
    const prompt =
      typeof input.prompt === "string" ? input.prompt.trim() : "";
    if (prompt.length > 0) task.prompt = prompt;
    const tasks = await this.listTasks();
    tasks.push(task);
    await this.writeTasks(tasks);
    return task;
  }

  /** Patch a task in place. Returns the new + previous records (so a caller
   *  can stash `previous` as an event inverse), or null when the id is
   *  unknown. */
  async updateTask(
    id: string,
    patch: TaskPatch,
  ): Promise<{ task: Task; previous: Task } | null> {
    const tasks = await this.listTasks();
    const idx = tasks.findIndex((t) => t.id === id);
    if (idx < 0) return null;
    const previous = tasks[idx]!;
    const next: Task = { ...previous };
    if (patch.name !== undefined) {
      const trimmed = patch.name.trim();
      if (trimmed.length === 0) throw new Error("task name must be non-empty");
      next.name = trimmed;
    }
    if (patch.prompt !== undefined) {
      const trimmed = patch.prompt.trim();
      if (trimmed.length > 0) next.prompt = trimmed;
      else delete next.prompt;
    }
    if (patch.status !== undefined) {
      if (!VALID_TASK_STATUSES.has(patch.status)) {
        throw new Error(`unknown task status: ${patch.status}`);
      }
      next.status = patch.status;
    }
    if (patch.blockedReason !== undefined) {
      const trimmed = patch.blockedReason.trim();
      if (trimmed.length > 0) next.blockedReason = trimmed;
      else delete next.blockedReason;
    }
    tasks[idx] = next;
    await this.writeTasks(tasks);
    return { task: next, previous };
  }

  async removeTask(id: string): Promise<boolean> {
    const tasks = await this.listTasks();
    const next = tasks.filter((t) => t.id !== id);
    if (next.length === tasks.length) return false;
    await this.writeTasks(next);
    return true;
  }

  /** Re-insert a task with its original id + metadata (undo/redo parity with
   *  restoreRepo). Refuses to duplicate an existing id. */
  async restoreTask(task: Task): Promise<void> {
    const tasks = await this.listTasks();
    if (tasks.some((t) => t.id === task.id)) {
      throw new Error(`Task already exists with id ${task.id}`);
    }
    tasks.push(task);
    await this.writeTasks(tasks);
  }

  private async writeTasks(tasks: Task[]): Promise<void> {
    const payload: TasksFile = { tasks };
    const dst = join(this.path, TASKS_FILE);
    const tmp = `${dst}.tmp`;
    await writeFile(tmp, JSON.stringify(payload, null, 2));
    try {
      await rename(tmp, dst);
    } catch (err) {
      await unlink(tmp).catch(() => {});
      throw err;
    }
  }

  // ── UI preferences (shared across all clients) ───────────────────

  async getPrefs(): Promise<Record<string, string>> {
    try {
      const raw = await readFile(join(this.path, PREFS_FILE), "utf-8");
      const parsed = JSON.parse(raw);
      if (
        typeof parsed !== "object" ||
        parsed === null ||
        Array.isArray(parsed)
      )
        return {};
      const out: Record<string, string> = {};
      for (const [k, v] of Object.entries(parsed)) {
        if (typeof v === "string") out[k] = v;
      }
      return out;
    } catch {
      return {};
    }
  }

  async patchPrefs(
    patch: Record<string, string | null>,
  ): Promise<Record<string, string>> {
    const current = await this.getPrefs();
    if (
      Object.prototype.hasOwnProperty.call(patch, OPEN_SESSIONS_PREF_KEY) &&
      typeof current[OPEN_SESSIONS_PREF_KEY] === "string"
    ) {
      await this.backupOpenSessionsPref(current[OPEN_SESSIONS_PREF_KEY]);
    }
    for (const [k, v] of Object.entries(patch)) {
      if (v === null) delete current[k];
      else current[k] = v;
    }
    await writeFile(
      join(this.path, PREFS_FILE),
      JSON.stringify(current, null, 2),
    );
    return current;
  }

  private async backupOpenSessionsPref(raw: string): Promise<void> {
    const parsed = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
      throw new Error("supergit:openSessions is not a JSON object");

    const root = join(
      this.path,
      ".supergit",
      "backups",
      "prefs",
      OPEN_SESSIONS_BACKUP_DIR,
    );
    const latestDir = join(root, "latest");
    const hourlyDir = join(root, "hourly");
    const dailyDir = join(root, "daily");
    await mkdir(latestDir, { recursive: true });
    await mkdir(hourlyDir, { recursive: true });
    await mkdir(dailyDir, { recursive: true });

    const now = new Date();
    const timestamp = backupTimestamp(now);
    await writeJsonFileAtomic(
      await uniqueJsonPath(latestDir, timestamp),
      parsed,
    );
    await writeJsonFileIfAbsentAtomic(
      join(hourlyDir, `${timestamp.slice(0, 13)}.json`),
      parsed,
    );
    await writeJsonFileIfAbsentAtomic(
      join(dailyDir, `${timestamp.slice(0, 10)}.json`),
      parsed,
    );

    await pruneJsonFiles(latestDir, 5);
    await pruneJsonFiles(hourlyDir, 24);
    await pruneJsonFiles(dailyDir, 7);
  }
}
