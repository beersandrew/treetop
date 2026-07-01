import { test, expect, describe } from "bun:test";
import {
  mkdtemp,
  readFile,
  writeFile,
  readdir,
  mkdir,
  realpath,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, basename } from "node:path";
import { $ } from "bun";
import { DuplicateRepoError, Workspace } from "../src/workspace";

async function tempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "supergit-test-"));
}

describe("Workspace", () => {
  test("opens an empty workspace by creating repos.json", async () => {
    const path = await tempDir();
    await Workspace.open(path);
    const raw = await readFile(join(path, "repos.json"), "utf-8");
    expect(JSON.parse(raw)).toEqual({ repos: [] });
  });

  test("lists no repos initially", async () => {
    const ws = await Workspace.open(await tempDir());
    expect(await ws.listRepos()).toEqual([]);
  });

  test("adds a repo and returns it with id, name, addedAt", async () => {
    const ws = await Workspace.open(await tempDir());
    const repo = await ws.addRepo("/tmp/foo/bar");
    expect(repo.path).toBe("/tmp/foo/bar");
    expect(repo.name).toBe("bar");
    expect(repo.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(Date.parse(repo.addedAt)).not.toBeNaN();
  });

  test("lists previously added repos", async () => {
    const ws = await Workspace.open(await tempDir());
    await ws.addRepo("/tmp/foo");
    await ws.addRepo("/tmp/bar");
    const repos = await ws.listRepos();
    expect(repos.map((r) => r.path)).toEqual(["/tmp/foo", "/tmp/bar"]);
  });

  test("rejects duplicate repo paths", async () => {
    const ws = await Workspace.open(await tempDir());
    await ws.addRepo("/tmp/foo");
    await expect(ws.addRepo("/tmp/foo")).rejects.toThrow(/already registered/);
  });

  test("duplicate repo error carries the existing repo", async () => {
    const ws = await Workspace.open(await tempDir());
    const existing = await ws.addRepo("/tmp/foo");
    try {
      await ws.addRepo("/tmp/foo");
      throw new Error("expected duplicate add to reject");
    } catch (e) {
      expect(e).toBeInstanceOf(DuplicateRepoError);
      expect((e as DuplicateRepoError).repo).toEqual(existing);
    }
  });

  test("addRepo resolves a subdirectory to the git toplevel", async () => {
    const repoDir = await realpath(await tempDir());
    await $`git init ${repoDir}`.quiet();
    // Identity must be set locally — CI runners have no global git identity,
    // so an unconfigured `git commit` fails with exit 128 ("Author identity
    // unknown") before the test can assert anything.
    await $`git -C ${repoDir} config user.email test@example.com`.quiet();
    await $`git -C ${repoDir} config user.name TestUser`.quiet();
    await writeFile(join(repoDir, "README"), "hi");
    await $`git -C ${repoDir} add . && git -C ${repoDir} commit -m init`.quiet();
    const subDir = join(repoDir, "deep", "nested");
    await mkdir(subDir, { recursive: true });

    const ws = await Workspace.open(await tempDir());
    const repo = await ws.addRepo(subDir);
    expect(repo.path).toBe(repoDir);
    expect(repo.name).toBe(basename(repoDir));
  });

  test("addRepo deduplicates when subdirectory resolves to already-registered root", async () => {
    const repoDir = await realpath(await tempDir());
    await $`git init ${repoDir}`.quiet();
    await $`git -C ${repoDir} config user.email test@example.com`.quiet();
    await $`git -C ${repoDir} config user.name TestUser`.quiet();
    await writeFile(join(repoDir, "README"), "hi");
    await $`git -C ${repoDir} add . && git -C ${repoDir} commit -m init`.quiet();
    const subDir = join(repoDir, "sub");
    await mkdir(subDir, { recursive: true });

    const ws = await Workspace.open(await tempDir());
    await ws.addRepo(repoDir);
    await expect(ws.addRepo(subDir)).rejects.toThrow(/already registered/);
  });

  test("removes a repo by id and returns true", async () => {
    const ws = await Workspace.open(await tempDir());
    const repo = await ws.addRepo("/tmp/foo");
    const removed = await ws.removeRepo(repo.id);
    expect(removed).toBe(true);
    expect(await ws.listRepos()).toEqual([]);
  });

  test("returns false when removing a non-existent id", async () => {
    const ws = await Workspace.open(await tempDir());
    const removed = await ws.removeRepo("does-not-exist");
    expect(removed).toBe(false);
  });

  test("persists repos across re-opens of the same path", async () => {
    const path = await tempDir();
    const ws1 = await Workspace.open(path);
    await ws1.addRepo("/tmp/foo");
    const ws2 = await Workspace.open(path);
    expect((await ws2.listRepos()).map((r) => r.path)).toEqual(["/tmp/foo"]);
  });

  test("restoreRepo preserves id and metadata (for undo/redo round-trips)", async () => {
    const ws = await Workspace.open(await tempDir());
    const original = await ws.addRepo("/tmp/foo");
    await ws.removeRepo(original.id);
    await ws.restoreRepo(original);
    const repos = await ws.listRepos();
    expect(repos).toHaveLength(1);
    expect(repos[0]?.id).toBe(original.id);
    expect(repos[0]?.addedAt).toBe(original.addedAt);
  });

  test("restoreRepo rejects when id already exists", async () => {
    const ws = await Workspace.open(await tempDir());
    const repo = await ws.addRepo("/tmp/foo");
    await expect(ws.restoreRepo(repo)).rejects.toThrow(/already exists/);
  });

  test("renameRepo updates name and returns old + new", async () => {
    const ws = await Workspace.open(await tempDir());
    const repo = await ws.addRepo("/tmp/foo");
    const result = await ws.renameRepo(repo.id, "FancyName");
    expect(result).toEqual({ oldName: "foo", newName: "FancyName" });
    expect((await ws.listRepos())[0]?.name).toBe("FancyName");
  });

  test("renameRepo rejects empty name", async () => {
    const ws = await Workspace.open(await tempDir());
    const repo = await ws.addRepo("/tmp/foo");
    await expect(ws.renameRepo(repo.id, "   ")).rejects.toThrow(/empty/);
  });

  test("renameRepo throws when id is unknown", async () => {
    const ws = await Workspace.open(await tempDir());
    await expect(ws.renameRepo("nope", "X")).rejects.toThrow(/not found/);
  });

  test("setRepoColor persists hex color and returns old + new", async () => {
    const ws = await Workspace.open(await tempDir());
    const repo = await ws.addRepo("/tmp/foo");
    const result = await ws.setRepoColor(repo.id, "#FF8800");
    expect(result).toEqual({ oldColor: undefined, newColor: "#ff8800" });
    expect((await ws.listRepos())[0]?.color).toBe("#ff8800");
  });

  test("setRepoColor with null clears an existing color", async () => {
    const ws = await Workspace.open(await tempDir());
    const repo = await ws.addRepo("/tmp/foo");
    await ws.setRepoColor(repo.id, "#abcdef");
    const cleared = await ws.setRepoColor(repo.id, null);
    expect(cleared).toEqual({ oldColor: "#abcdef", newColor: undefined });
    expect((await ws.listRepos())[0]?.color).toBeUndefined();
  });

  test("setRepoColor rejects bad hex formats", async () => {
    const ws = await Workspace.open(await tempDir());
    const repo = await ws.addRepo("/tmp/foo");
    await expect(ws.setRepoColor(repo.id, "red")).rejects.toThrow(/hex/);
    await expect(ws.setRepoColor(repo.id, "#abc")).rejects.toThrow(/hex/);
    await expect(ws.setRepoColor(repo.id, "rgb(1,2,3)")).rejects.toThrow(/hex/);
  });

  test("setRepoColor is a no-op when value unchanged", async () => {
    const ws = await Workspace.open(await tempDir());
    const repo = await ws.addRepo("/tmp/foo");
    await ws.setRepoColor(repo.id, "#112233");
    const again = await ws.setRepoColor(repo.id, "#112233");
    expect(again).toEqual({ oldColor: "#112233", newColor: "#112233" });
  });

  test("setRepoColor throws when id is unknown", async () => {
    const ws = await Workspace.open(await tempDir());
    await expect(ws.setRepoColor("nope", "#112233")).rejects.toThrow(
      /not found/,
    );
  });

  test("session titles start empty", async () => {
    const ws = await Workspace.open(await tempDir());
    expect(await ws.listSessionTitles()).toEqual({});
  });

  test("setSessionTitle persists and roundtrips", async () => {
    const path = await tempDir();
    const ws1 = await Workspace.open(path);
    await ws1.setSessionTitle("/abs/session.jsonl", "Refactor billing");
    expect(await ws1.listSessionTitles()).toEqual({
      "/abs/session.jsonl": "Refactor billing",
    });
    const ws2 = await Workspace.open(path);
    expect(await ws2.listSessionTitles()).toEqual({
      "/abs/session.jsonl": "Refactor billing",
    });
  });

  test("setSessionTitle with empty string deletes the entry", async () => {
    const ws = await Workspace.open(await tempDir());
    await ws.setSessionTitle("/a.jsonl", "name");
    await ws.setSessionTitle("/b.jsonl", "other");
    await ws.setSessionTitle("/a.jsonl", "");
    expect(await ws.listSessionTitles()).toEqual({ "/b.jsonl": "other" });
  });

  test("setSessionTitle trims whitespace; whitespace-only clears", async () => {
    const ws = await Workspace.open(await tempDir());
    await ws.setSessionTitle("/a.jsonl", "  spaced  ");
    expect((await ws.listSessionTitles())["/a.jsonl"]).toBe("spaced");
    await ws.setSessionTitle("/a.jsonl", "   ");
    expect(await ws.listSessionTitles()).toEqual({});
  });

  test("migrateSessionTitle moves the title from oldSource to newSource", async () => {
    const ws = await Workspace.open(await tempDir());
    await ws.setSessionTitle("__new__:claude:abc", "Cool refactor");
    await ws.migrateSessionTitle("__new__:claude:abc", "/abs/real.jsonl");
    expect(await ws.listSessionTitles()).toEqual({
      "/abs/real.jsonl": "Cool refactor",
    });
  });

  test("migrateSessionTitle is a no-op when oldSource has no title", async () => {
    const ws = await Workspace.open(await tempDir());
    await ws.setSessionTitle("/abs/real.jsonl", "Already named");
    await ws.migrateSessionTitle("__new__:claude:abc", "/abs/real.jsonl");
    // No mutation: the existing newSource title is preserved.
    expect(await ws.listSessionTitles()).toEqual({
      "/abs/real.jsonl": "Already named",
    });
  });

  test("migrateSessionTitle preserves oldSource title if newSource already has one", async () => {
    // If the user manually named both sides we don't silently overwrite the
    // destination — the explicit later edit wins. Source is left intact too
    // so nothing is lost.
    const ws = await Workspace.open(await tempDir());
    await ws.setSessionTitle("__new__:claude:abc", "From synthetic");
    await ws.setSessionTitle("/abs/real.jsonl", "From real");
    await ws.migrateSessionTitle("__new__:claude:abc", "/abs/real.jsonl");
    expect(await ws.listSessionTitles()).toEqual({
      "__new__:claude:abc": "From synthetic",
      "/abs/real.jsonl": "From real",
    });
  });

  test("migrateSessionTitle rejects empty source strings", async () => {
    const ws = await Workspace.open(await tempDir());
    await expect(ws.migrateSessionTitle("", "/x")).rejects.toThrow();
    await expect(ws.migrateSessionTitle("/x", "")).rejects.toThrow();
  });

  test("setSessionTitle throws rather than clobbering an unparseable file", async () => {
    // Regression: a transient read returning {} from listSessionTitles would
    // make the next setSessionTitle rewrite session-titles.json with only the
    // new entry, wiping every previously-saved title. Corrupted contents must
    // surface as an error instead so the caller can retry without data loss.
    const path = await tempDir();
    const ws = await Workspace.open(path);
    await ws.setSessionTitle("/a.jsonl", "alpha");
    await ws.setSessionTitle("/b.jsonl", "beta");
    // Simulate a half-written / corrupt file (or a parse failure of any kind).
    await writeFile(join(path, "session-titles.json"), "{ this is not json");
    await expect(ws.setSessionTitle("/c.jsonl", "gamma")).rejects.toThrow(
      /session-titles/i,
    );
    // File contents are untouched — recovery is still possible by hand.
    const raw = await readFile(join(path, "session-titles.json"), "utf-8");
    expect(raw).toBe("{ this is not json");
  });

  test("migrateSessionTitle throws rather than clobbering an unparseable file", async () => {
    const path = await tempDir();
    const ws = await Workspace.open(path);
    await ws.setSessionTitle("/old.jsonl", "alpha");
    await writeFile(join(path, "session-titles.json"), "garbage");
    await expect(
      ws.migrateSessionTitle("/old.jsonl", "/new.jsonl"),
    ).rejects.toThrow(/session-titles/i);
    const raw = await readFile(join(path, "session-titles.json"), "utf-8");
    expect(raw).toBe("garbage");
  });

  test("setSessionTitle still works when session-titles.json is simply missing", async () => {
    // Missing-file (ENOENT) is the legitimate empty-start case; it must NOT
    // throw. Only "file exists but unreadable/unparseable" is the dangerous
    // case the hardening above guards against.
    const ws = await Workspace.open(await tempDir());
    await expect(
      ws.setSessionTitle("/a.jsonl", "alpha"),
    ).resolves.toBeUndefined();
    expect(await ws.listSessionTitles()).toEqual({ "/a.jsonl": "alpha" });
  });

  test("setSessionTitle writes atomically and leaves no .tmp behind", async () => {
    // We can't easily simulate a crash mid-write inside a unit test, but the
    // implementation property we want is "write to a tmp file then rename" —
    // verified here by asserting the tmp file is cleaned up after a normal
    // save (and that nothing else creeps into the workspace dir).
    const path = await tempDir();
    const ws = await Workspace.open(path);
    await ws.setSessionTitle("/a.jsonl", "alpha");
    await ws.setSessionTitle("/b.jsonl", "beta");
    const entries = await readdir(path);
    expect(entries).toContain("session-titles.json");
    expect(entries.some((e) => e.endsWith(".tmp"))).toBe(false);
  });

  test("addCustomLink persists a link on the repo and returns it", async () => {
    const ws = await Workspace.open(await tempDir());
    const repo = await ws.addRepo("/tmp/foo");
    const link = await ws.addCustomLink(repo.id, {
      url: "https://coolify.example.com/app/123",
      name: "Coolify",
    });
    expect(link.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(link.url).toBe("https://coolify.example.com/app/123");
    expect(link.name).toBe("Coolify");
    const persisted = (await ws.listRepos())[0]!;
    expect(persisted.customLinks).toEqual([link]);
  });

  test("addCustomLink trims fields and treats blank name as absent", async () => {
    const ws = await Workspace.open(await tempDir());
    const repo = await ws.addRepo("/tmp/foo");
    const link = await ws.addCustomLink(repo.id, {
      url: "  https://example.com/  ",
      name: "   ",
    });
    expect(link.url).toBe("https://example.com/");
    expect(link.name).toBeUndefined();
  });

  test("addCustomLink rejects bad URLs", async () => {
    const ws = await Workspace.open(await tempDir());
    const repo = await ws.addRepo("/tmp/foo");
    await expect(
      ws.addCustomLink(repo.id, { url: "not a url" }),
    ).rejects.toThrow(/url/i);
    await expect(ws.addCustomLink(repo.id, { url: "" })).rejects.toThrow(
      /url/i,
    );
    await expect(
      ws.addCustomLink(repo.id, { url: "ftp://example.com/x" }),
    ).rejects.toThrow(/http/i);
  });

  test("addCustomLink throws when the repo id is unknown", async () => {
    const ws = await Workspace.open(await tempDir());
    await expect(
      ws.addCustomLink("nope", { url: "https://x" }),
    ).rejects.toThrow(/not found/);
  });

  test("addCustomLink appends in order", async () => {
    const ws = await Workspace.open(await tempDir());
    const repo = await ws.addRepo("/tmp/foo");
    const a = await ws.addCustomLink(repo.id, { url: "https://a.test/" });
    const b = await ws.addCustomLink(repo.id, { url: "https://b.test/" });
    expect((await ws.listRepos())[0]!.customLinks).toEqual([a, b]);
  });

  test("removeCustomLink deletes the link and returns the removed entry", async () => {
    const ws = await Workspace.open(await tempDir());
    const repo = await ws.addRepo("/tmp/foo");
    const link = await ws.addCustomLink(repo.id, { url: "https://x.test/" });
    const removed = await ws.removeCustomLink(repo.id, link.id);
    expect(removed).toEqual(link);
    expect((await ws.listRepos())[0]!.customLinks ?? []).toEqual([]);
  });

  test("removeCustomLink returns null when the link id is unknown", async () => {
    const ws = await Workspace.open(await tempDir());
    const repo = await ws.addRepo("/tmp/foo");
    expect(await ws.removeCustomLink(repo.id, "missing-id")).toBeNull();
  });

  test("removeCustomLink throws when the repo id is unknown", async () => {
    const ws = await Workspace.open(await tempDir());
    await expect(ws.removeCustomLink("nope", "x")).rejects.toThrow(/not found/);
  });

  test("reorderCustomLinks rewrites the order to match the id list", async () => {
    const ws = await Workspace.open(await tempDir());
    const repo = await ws.addRepo("/tmp/foo");
    const a = await ws.addCustomLink(repo.id, { url: "https://a.test/" });
    const b = await ws.addCustomLink(repo.id, { url: "https://b.test/" });
    const c = await ws.addCustomLink(repo.id, { url: "https://c.test/" });
    const result = await ws.reorderCustomLinks(repo.id, [c.id, a.id, b.id]);
    expect(result.oldOrder).toEqual([a.id, b.id, c.id]);
    expect(result.newOrder).toEqual([c.id, a.id, b.id]);
    expect((await ws.listRepos())[0]!.customLinks?.map((l) => l.id)).toEqual([
      c.id,
      a.id,
      b.id,
    ]);
  });

  test("reorderCustomLinks is a no-op when the order is unchanged", async () => {
    const ws = await Workspace.open(await tempDir());
    const repo = await ws.addRepo("/tmp/foo");
    const a = await ws.addCustomLink(repo.id, { url: "https://a.test/" });
    const b = await ws.addCustomLink(repo.id, { url: "https://b.test/" });
    const result = await ws.reorderCustomLinks(repo.id, [a.id, b.id]);
    expect(result.oldOrder).toEqual([a.id, b.id]);
    expect(result.newOrder).toEqual([a.id, b.id]);
  });

  test("reorderCustomLinks rejects mismatched id sets", async () => {
    const ws = await Workspace.open(await tempDir());
    const repo = await ws.addRepo("/tmp/foo");
    const a = await ws.addCustomLink(repo.id, { url: "https://a.test/" });
    const b = await ws.addCustomLink(repo.id, { url: "https://b.test/" });
    // wrong length
    await expect(ws.reorderCustomLinks(repo.id, [a.id])).rejects.toThrow(
      /length/,
    );
    // unknown id
    await expect(
      ws.reorderCustomLinks(repo.id, [a.id, "ghost"]),
    ).rejects.toThrow(/Unknown link id/);
    // duplicates
    await expect(ws.reorderCustomLinks(repo.id, [a.id, a.id])).rejects.toThrow(
      /unique/,
    );
    void b;
  });

  test("reorderCustomLinks throws when the repo id is unknown", async () => {
    const ws = await Workspace.open(await tempDir());
    await expect(ws.reorderCustomLinks("nope", [])).rejects.toThrow(
      /not found/,
    );
  });

  test("reorderRepos rewrites the repo order to match the id list", async () => {
    const ws = await Workspace.open(await tempDir());
    const a = await ws.addRepo("/tmp/a");
    const b = await ws.addRepo("/tmp/b");
    const c = await ws.addRepo("/tmp/c");
    const result = await ws.reorderRepos([c.id, a.id, b.id]);
    expect(result.oldOrder).toEqual([a.id, b.id, c.id]);
    expect(result.newOrder).toEqual([c.id, a.id, b.id]);
    expect((await ws.listRepos()).map((r) => r.id)).toEqual([c.id, a.id, b.id]);
  });

  test("reorderRepos is a no-op when the order is unchanged", async () => {
    const ws = await Workspace.open(await tempDir());
    const a = await ws.addRepo("/tmp/a");
    const b = await ws.addRepo("/tmp/b");
    const result = await ws.reorderRepos([a.id, b.id]);
    expect(result.oldOrder).toEqual([a.id, b.id]);
    expect(result.newOrder).toEqual([a.id, b.id]);
    expect((await ws.listRepos()).map((r) => r.id)).toEqual([a.id, b.id]);
  });

  test("reorderRepos rejects mismatched id sets", async () => {
    const ws = await Workspace.open(await tempDir());
    const a = await ws.addRepo("/tmp/a");
    const b = await ws.addRepo("/tmp/b");
    // wrong length
    await expect(ws.reorderRepos([a.id])).rejects.toThrow(/length/);
    // unknown id
    await expect(ws.reorderRepos([a.id, "ghost"])).rejects.toThrow(
      /Unknown repo id/,
    );
    // duplicates
    await expect(ws.reorderRepos([a.id, a.id])).rejects.toThrow(/unique/);
    void b;
  });

  test("reorderRepos rejects a non-array argument", async () => {
    const ws = await Workspace.open(await tempDir());
    // @ts-expect-error testing runtime guard
    await expect(ws.reorderRepos("nope")).rejects.toThrow(/array/);
  });

  test("updateCustomLink rewrites the URL", async () => {
    const ws = await Workspace.open(await tempDir());
    const repo = await ws.addRepo("/tmp/foo");
    const link = await ws.addCustomLink(repo.id, {
      url: "https://a.test/",
      name: "Alpha",
    });
    const updated = await ws.updateCustomLink(repo.id, link.id, {
      url: "https://b.test/",
    });
    expect(updated).toEqual({
      id: link.id,
      kind: "url",
      url: "https://b.test/",
      name: "Alpha",
    });
    expect((await ws.listRepos())[0]!.customLinks?.[0]).toEqual(updated!);
  });

  test("updateCustomLink rewrites the name", async () => {
    const ws = await Workspace.open(await tempDir());
    const repo = await ws.addRepo("/tmp/foo");
    const link = await ws.addCustomLink(repo.id, { url: "https://a.test/" });
    const updated = await ws.updateCustomLink(repo.id, link.id, {
      name: "Production",
    });
    expect(updated?.name).toBe("Production");
  });

  test("updateCustomLink clears the name when set to blank", async () => {
    const ws = await Workspace.open(await tempDir());
    const repo = await ws.addRepo("/tmp/foo");
    const link = await ws.addCustomLink(repo.id, {
      url: "https://a.test/",
      name: "Alpha",
    });
    const updated = await ws.updateCustomLink(repo.id, link.id, { name: "  " });
    expect(updated?.name).toBeUndefined();
    expect((await ws.listRepos())[0]!.customLinks?.[0]).toEqual({
      id: link.id,
      kind: "url",
      url: "https://a.test/",
    });
  });

  test("updateCustomLink rejects bad URLs", async () => {
    const ws = await Workspace.open(await tempDir());
    const repo = await ws.addRepo("/tmp/foo");
    const link = await ws.addCustomLink(repo.id, { url: "https://a.test/" });
    await expect(
      ws.updateCustomLink(repo.id, link.id, { url: "not a url" }),
    ).rejects.toThrow(/url/i);
    await expect(
      ws.updateCustomLink(repo.id, link.id, { url: "ftp://x" }),
    ).rejects.toThrow(/http/i);
  });

  test("updateCustomLink returns null for unknown link id", async () => {
    const ws = await Workspace.open(await tempDir());
    const repo = await ws.addRepo("/tmp/foo");
    expect(
      await ws.updateCustomLink(repo.id, "missing", { name: "x" }),
    ).toBeNull();
  });

  test("updateCustomLink throws when the repo id is unknown", async () => {
    const ws = await Workspace.open(await tempDir());
    await expect(
      ws.updateCustomLink("nope", "x", { name: "y" }),
    ).rejects.toThrow(/not found/);
  });

  test("addCustomLink stores a file link with an absolute path", async () => {
    const ws = await Workspace.open(await tempDir());
    const repo = await ws.addRepo("/tmp/foo");
    const link = await ws.addCustomLink(repo.id, {
      kind: "file",
      path: "/abs/some/file.txt",
      name: "Spec",
    });
    expect(link).toEqual({
      id: link.id,
      kind: "file",
      path: "/abs/some/file.txt",
      name: "Spec",
    });
  });

  test("addCustomLink rejects relative file paths", async () => {
    const ws = await Workspace.open(await tempDir());
    const repo = await ws.addRepo("/tmp/foo");
    await expect(
      ws.addCustomLink(repo.id, { kind: "file", path: "relative/x" }),
    ).rejects.toThrow(/absolute/i);
    await expect(
      ws.addCustomLink(repo.id, { kind: "file", path: "   " }),
    ).rejects.toThrow(/non-empty/i);
  });

  test("updateCustomLink can flip a URL link into a file link", async () => {
    const ws = await Workspace.open(await tempDir());
    const repo = await ws.addRepo("/tmp/foo");
    const link = await ws.addCustomLink(repo.id, {
      url: "https://a.test/",
      name: "Old",
    });
    const updated = await ws.updateCustomLink(repo.id, link.id, {
      path: "/abs/spec.md",
    });
    expect(updated).toEqual({
      id: link.id,
      kind: "file",
      path: "/abs/spec.md",
      name: "Old",
    });
  });

  test("updateCustomLink rejects passing both url and path", async () => {
    const ws = await Workspace.open(await tempDir());
    const repo = await ws.addRepo("/tmp/foo");
    const link = await ws.addCustomLink(repo.id, { url: "https://a.test/" });
    await expect(
      ws.updateCustomLink(repo.id, link.id, {
        url: "https://b.test/",
        path: "/x",
      }),
    ).rejects.toThrow(/either url or path/);
  });

  // ── Command links ──────────────────────────────────────────────────

  test("addCustomLink stores a command link with all fields", async () => {
    const ws = await Workspace.open(await tempDir());
    const repo = await ws.addRepo("/tmp/foo");
    const link = await ws.addCustomLink(repo.id, {
      kind: "command",
      cmd: "npm run dev",
      cwd: "/abs/project",
      runMode: "shell",
      name: "Dev server",
    });
    expect(link).toEqual({
      id: link.id,
      kind: "command",
      cmd: "npm run dev",
      cwd: "/abs/project",
      runMode: "shell",
      name: "Dev server",
    });
    const persisted = (await ws.listRepos())[0]!;
    expect(persisted.customLinks).toEqual([link]);
  });

  test("addCustomLink command defaults runMode to internal", async () => {
    const ws = await Workspace.open(await tempDir());
    const repo = await ws.addRepo("/tmp/foo");
    const link = await ws.addCustomLink(repo.id, {
      kind: "command",
      cmd: "echo hello",
    });
    expect(link.kind).toBe("command");
    expect((link as any).runMode).toBe("internal");
  });

  test("addCustomLink command omits cwd when empty", async () => {
    const ws = await Workspace.open(await tempDir());
    const repo = await ws.addRepo("/tmp/foo");
    const link = await ws.addCustomLink(repo.id, {
      kind: "command",
      cmd: "ls",
      cwd: "",
    });
    expect((link as any).cwd).toBeUndefined();
  });

  test("addCustomLink command rejects empty cmd", async () => {
    const ws = await Workspace.open(await tempDir());
    const repo = await ws.addRepo("/tmp/foo");
    await expect(
      ws.addCustomLink(repo.id, { kind: "command", cmd: "  " }),
    ).rejects.toThrow(/non-empty/i);
  });

  test("addCustomLink command accepts relative cwd (relative to worktree)", async () => {
    const ws = await Workspace.open(await tempDir());
    const repo = await ws.addRepo("/tmp/foo");
    const link = await ws.addCustomLink(repo.id, {
      kind: "command",
      cmd: "ls",
      cwd: "packages/ui",
    });
    expect((link as { cwd?: string }).cwd).toBe("packages/ui");
  });

  test("addCustomLink command rejects cwd with '..' segments", async () => {
    const ws = await Workspace.open(await tempDir());
    const repo = await ws.addRepo("/tmp/foo");
    await expect(
      ws.addCustomLink(repo.id, {
        kind: "command",
        cmd: "ls",
        cwd: "../escape",
      }),
    ).rejects.toThrow(/\.\./);
  });

  test("updateCustomLink can edit a command link's fields", async () => {
    const ws = await Workspace.open(await tempDir());
    const repo = await ws.addRepo("/tmp/foo");
    const link = await ws.addCustomLink(repo.id, {
      kind: "command",
      cmd: "npm run dev",
      runMode: "shell",
      name: "Dev",
    });
    const updated = await ws.updateCustomLink(repo.id, link.id, {
      cmd: "npm run build",
      cwd: "/abs/out",
      runMode: "external",
      kind: "command",
    });
    expect(updated).toEqual({
      id: link.id,
      kind: "command",
      cmd: "npm run build",
      cwd: "/abs/out",
      runMode: "external",
      name: "Dev",
    });
  });

  test("addCustomLink command with runMode internal round-trips through persistence", async () => {
    const ws = await Workspace.open(await tempDir());
    const repo = await ws.addRepo("/tmp/foo");
    const link = await ws.addCustomLink(repo.id, {
      kind: "command",
      cmd: "npm run dev",
      cwd: "/abs/project",
      runMode: "internal",
      name: "Dev",
    });
    expect((link as any).runMode).toBe("internal");
    const persisted = (await ws.listRepos())[0]!.customLinks?.[0];
    expect(persisted).toEqual(link);
    expect((persisted as any).runMode).toBe("internal");
  });

  test("updateCustomLink can flip a URL link into a command link", async () => {
    const ws = await Workspace.open(await tempDir());
    const repo = await ws.addRepo("/tmp/foo");
    const link = await ws.addCustomLink(repo.id, { url: "https://a.test/" });
    const updated = await ws.updateCustomLink(repo.id, link.id, {
      kind: "command",
      cmd: "make build",
    });
    expect(updated?.kind).toBe("command");
    expect((updated as any).cmd).toBe("make build");
  });

  // ── Prefs ──────────────────────────────────────────────────────────

  test("getPrefs returns empty object when no prefs.json exists", async () => {
    const ws = await Workspace.open(await tempDir());
    expect(await ws.getPrefs()).toEqual({});
  });

  test("patchPrefs creates prefs.json and returns merged result", async () => {
    const dir = await tempDir();
    const ws = await Workspace.open(dir);
    const result = await ws.patchPrefs({ "supergit:notes-offsets": '{"a":1}' });
    expect(result).toEqual({ "supergit:notes-offsets": '{"a":1}' });
    const raw = await readFile(join(dir, "prefs.json"), "utf-8");
    expect(JSON.parse(raw)).toEqual({ "supergit:notes-offsets": '{"a":1}' });
  });

  test("patchPrefs merges with existing keys", async () => {
    const ws = await Workspace.open(await tempDir());
    await ws.patchPrefs({ a: "1", b: "2" });
    const result = await ws.patchPrefs({ b: "3", c: "4" });
    expect(result).toEqual({ a: "1", b: "3", c: "4" });
  });

  test("patchPrefs backs up replaced openSessions as parsed JSON files", async () => {
    const dir = await tempDir();
    const ws = await Workspace.open(dir);
    const first = {
      "/wt": [{ agent: "codex", source: "/sessions/one.jsonl" }],
    };
    const second = {
      "/wt": [{ agent: "codex", source: "/sessions/two.jsonl" }],
    };
    const third = {
      "/wt": [{ agent: "codex", source: "/sessions/three.jsonl" }],
    };

    await ws.patchPrefs({ "supergit:openSessions": JSON.stringify(first) });
    await ws.patchPrefs({ "supergit:openSessions": JSON.stringify(second) });
    await ws.patchPrefs({ "supergit:openSessions": JSON.stringify(third) });

    const root = join(
      dir,
      ".supergit",
      "backups",
      "prefs",
      "supergit_openSessions",
    );
    const latestFiles = await readdir(join(root, "latest"));
    const hourlyFiles = await readdir(join(root, "hourly"));
    const dailyFiles = await readdir(join(root, "daily"));

    expect(latestFiles).toHaveLength(2);
    expect(hourlyFiles).toHaveLength(1);
    expect(dailyFiles).toHaveLength(1);
    expect(latestFiles[0]!).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z(?:-\d+)?\.json$/,
    );
    expect(hourlyFiles[0]!).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}\.json$/);
    expect(dailyFiles[0]!).toMatch(/^\d{4}-\d{2}-\d{2}\.json$/);

    const latestBackups = await Promise.all(
      latestFiles.map((name) =>
        readFile(join(root, "latest", name), "utf-8").then(JSON.parse),
      ),
    );
    expect(latestBackups).toContainEqual(first);
    expect(latestBackups).toContainEqual(second);
    expect(
      JSON.parse(
        await readFile(join(root, "hourly", hourlyFiles[0]!), "utf-8"),
      ),
    ).toEqual(first);
    expect(
      JSON.parse(await readFile(join(root, "daily", dailyFiles[0]!), "utf-8")),
    ).toEqual(first);
  });

  test("openSessions backups keep only latest five, hourly 24, and daily 7", async () => {
    const dir = await tempDir();
    const ws = await Workspace.open(dir);
    const root = join(
      dir,
      ".supergit",
      "backups",
      "prefs",
      "supergit_openSessions",
    );
    await mkdir(join(root, "hourly"), { recursive: true });
    await mkdir(join(root, "daily"), { recursive: true });
    for (let i = 0; i < 30; i++) {
      await writeFile(
        join(
          root,
          "hourly",
          `2026-05-${String(i + 1).padStart(2, "0")}T00.json`,
        ),
        "{}",
      );
    }
    for (let i = 0; i < 10; i++) {
      await writeFile(
        join(root, "daily", `2026-05-${String(i + 1).padStart(2, "0")}.json`),
        "{}",
      );
    }

    await ws.patchPrefs({
      "supergit:openSessions": JSON.stringify({ "/wt": [] }),
    });
    for (let i = 0; i < 8; i++) {
      await ws.patchPrefs({
        "supergit:openSessions": JSON.stringify({
          "/wt": [{ agent: "codex", source: `/sessions/${i}.jsonl` }],
        }),
      });
    }

    expect(await readdir(join(root, "latest"))).toHaveLength(5);
    expect(await readdir(join(root, "hourly"))).toHaveLength(24);
    expect(await readdir(join(root, "daily"))).toHaveLength(7);
  });

  test("patchPrefs with null deletes a key", async () => {
    const ws = await Workspace.open(await tempDir());
    await ws.patchPrefs({ a: "1", b: "2" });
    const result = await ws.patchPrefs({ a: null });
    expect(result).toEqual({ b: "2" });
  });

  test("getPrefs round-trips through patchPrefs", async () => {
    const ws = await Workspace.open(await tempDir());
    await ws.patchPrefs({ x: "hello", y: '{"nested":true}' });
    const loaded = await ws.getPrefs();
    expect(loaded).toEqual({ x: "hello", y: '{"nested":true}' });
  });

  test("getPrefs tolerates corrupt prefs.json", async () => {
    const dir = await tempDir();
    const ws = await Workspace.open(dir);
    await writeFile(join(dir, "prefs.json"), "not json");
    expect(await ws.getPrefs()).toEqual({});
  });
});

describe("Workspace tasks", () => {
  test("lists no tasks initially (no tasks.json yet)", async () => {
    const ws = await Workspace.open(await tempDir());
    expect(await ws.listTasks()).toEqual([]);
  });

  test("addTask returns a task with id, createdAt, default status ready", async () => {
    const ws = await Workspace.open(await tempDir());
    const task = await ws.addTask({
      worktreePath: "/repos/app/main",
      agent: "claude",
      name: "Measure esfUsd caps",
    });
    expect(task.name).toBe("Measure esfUsd caps");
    expect(task.worktreePath).toBe("/repos/app/main");
    expect(task.agent).toBe("claude");
    expect(task.status).toBe("ready");
    expect(task.createdBy).toBe("user");
    expect(task.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(Date.parse(task.createdAt)).not.toBeNaN();
  });

  test("addTask keeps the optional prompt and createdBy=agent", async () => {
    const ws = await Workspace.open(await tempDir());
    const task = await ws.addTask({
      worktreePath: "/repos/app/main",
      agent: "codex",
      name: "Profile enrich storm",
      prompt: "Investigate the cold-start enrich storm and propose fixes.",
      createdBy: "agent",
    });
    expect(task.prompt).toBe(
      "Investigate the cold-start enrich storm and propose fixes.",
    );
    expect(task.createdBy).toBe("agent");
  });

  test("addTask rejects an empty name", async () => {
    const ws = await Workspace.open(await tempDir());
    await expect(
      ws.addTask({ worktreePath: "/wt", agent: "claude", name: "  " }),
    ).rejects.toThrow();
  });

  test("addTask rejects an unknown agent", async () => {
    const ws = await Workspace.open(await tempDir());
    await expect(
      ws.addTask({
        worktreePath: "/wt",
        // @ts-expect-error — exercising the runtime guard at the boundary
        agent: "gpt",
        name: "x",
      }),
    ).rejects.toThrow();
  });

  test("tasks persist across re-opens", async () => {
    const dir = await tempDir();
    const ws1 = await Workspace.open(dir);
    await ws1.addTask({ worktreePath: "/wt", agent: "claude", name: "one" });
    await ws1.addTask({ worktreePath: "/wt", agent: "codex", name: "two" });
    const ws2 = await Workspace.open(dir);
    expect((await ws2.listTasks()).map((t) => t.name)).toEqual(["one", "two"]);
  });

  test("updateTask patches status and returns the new + previous record", async () => {
    const ws = await Workspace.open(await tempDir());
    const task = await ws.addTask({
      worktreePath: "/wt",
      agent: "claude",
      name: "triage me",
    });
    const res = await ws.updateTask(task.id, { status: "done" });
    expect(res).not.toBeNull();
    expect(res!.previous.status).toBe("ready");
    expect(res!.task.status).toBe("done");
    // persisted
    expect((await ws.listTasks())[0]!.status).toBe("done");
  });

  test("updateTask records a blockedReason alongside status", async () => {
    const ws = await Workspace.open(await tempDir());
    const task = await ws.addTask({
      worktreePath: "/wt",
      agent: "claude",
      name: "blocked one",
    });
    const res = await ws.updateTask(task.id, {
      status: "blocked",
      blockedReason: "waiting on usd-67",
    });
    expect(res!.task.status).toBe("blocked");
    expect(res!.task.blockedReason).toBe("waiting on usd-67");
  });

  test("updateTask returns null for an unknown id", async () => {
    const ws = await Workspace.open(await tempDir());
    expect(await ws.updateTask("nope", { status: "done" })).toBeNull();
  });

  test("removeTask deletes by id and reports success", async () => {
    const ws = await Workspace.open(await tempDir());
    const task = await ws.addTask({
      worktreePath: "/wt",
      agent: "claude",
      name: "remove me",
    });
    expect(await ws.removeTask(task.id)).toBe(true);
    expect(await ws.listTasks()).toEqual([]);
    // removing again is a no-op false (mirrors removeRepo)
    expect(await ws.removeTask(task.id)).toBe(false);
  });

  test("restoreTask re-inserts with the original id + createdAt", async () => {
    const ws = await Workspace.open(await tempDir());
    const task = await ws.addTask({
      worktreePath: "/wt",
      agent: "claude",
      name: "restore me",
    });
    await ws.removeTask(task.id);
    await ws.restoreTask(task);
    const after = await ws.listTasks();
    expect(after).toHaveLength(1);
    expect(after[0]!.id).toBe(task.id);
    expect(after[0]!.createdAt).toBe(task.createdAt);
  });

  test("restoreTask refuses to duplicate an existing id", async () => {
    const ws = await Workspace.open(await tempDir());
    const task = await ws.addTask({
      worktreePath: "/wt",
      agent: "claude",
      name: "dupe",
    });
    await expect(ws.restoreTask(task)).rejects.toThrow();
  });

  test("listTasks tolerates a corrupt tasks.json", async () => {
    const dir = await tempDir();
    const ws = await Workspace.open(dir);
    await writeFile(join(dir, "tasks.json"), "not json");
    expect(await ws.listTasks()).toEqual([]);
  });
});
