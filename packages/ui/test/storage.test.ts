import { test, expect, describe } from "bun:test";
import {
  CommandTermStore,
  CommandUrlPickStore,
  DismissedSessionsStore,
  ExpandedStore,
  OpenSessionsStore,
  SessionSurfaceStore,
  StarredSessionsStore,
  VisibleWorktreesStore,
  applySessionSurfacePreference,
  claudeModelAlias,
  codexAppSource,
  cmdForOpenSession,
  defaultSessionSurface,
  effectiveVisibleWorktrees,
  filterToExistingSessions,
  hideVisibleWorktree,
  isLiveCodexAppSource,
  isForeignToWorktree,
  isSessionForeignToWorktree,
  dockSessionHiddenAsForeign,
  openSessionRenderKey,
  reconcileOpenSessionsWithSurfacePreferences,
  resolveTitleSource,
  sessionMatchesKnownKeys,
  sessionSurfacePreference,
  sessionSurfaceKeys,
  showVisibleWorktree,
  setSessionMode,
  setSessionAttachTermId,
  shouldPollSessionSource,
  stampDiscoveredSessionId,
  stampDiscoveredSessionIdWithDetail,
  toggleVisibleWorktree,
  transientDiscoverySources,
  type KVStore,
  type PersistedSession,
} from "../src/storage";

class MemStore implements KVStore {
  data = new Map<string, string>();
  getItem(k: string) {
    return this.data.get(k) ?? null;
  }
  setItem(k: string, v: string) {
    this.data.set(k, v);
  }
}

class ThrowingStore implements KVStore {
  getItem(): string | null {
    throw new Error("storage unavailable");
  }
  setItem(): void {
    throw new Error("quota exceeded");
  }
}

const KEY = "supergit:commitsExpanded";

describe("ExpandedStore", () => {
  test("returns empty set when nothing is stored", () => {
    const s = new ExpandedStore(new MemStore(), KEY);
    expect([...s.load()]).toEqual([]);
  });

  test("save then load round-trips paths in order", () => {
    const m = new MemStore();
    const s = new ExpandedStore(m, KEY);
    s.save(["/a", "/b/c", "/d e"]);
    expect([...s.load()]).toEqual(["/a", "/b/c", "/d e"]);
  });

  test("save replaces, not merges", () => {
    const m = new MemStore();
    const s = new ExpandedStore(m, KEY);
    s.save(["/a", "/b"]);
    s.save(["/c"]);
    expect([...s.load()]).toEqual(["/c"]);
  });

  test("save with empty input clears the set", () => {
    const m = new MemStore();
    const s = new ExpandedStore(m, KEY);
    s.save(["/a"]);
    s.save([]);
    expect([...s.load()]).toEqual([]);
  });

  test("survives across instances pointing at the same storage", () => {
    const m = new MemStore();
    new ExpandedStore(m, KEY).save(["/a", "/b"]);
    const second = new ExpandedStore(m, KEY);
    expect([...second.load()]).toEqual(["/a", "/b"]);
  });

  test("returns empty set when stored value is not JSON", () => {
    const m = new MemStore();
    m.setItem(KEY, "{not json");
    expect([...new ExpandedStore(m, KEY).load()]).toEqual([]);
  });

  test("returns empty set when stored value is not an array", () => {
    const m = new MemStore();
    m.setItem(KEY, JSON.stringify({ a: 1 }));
    expect([...new ExpandedStore(m, KEY).load()]).toEqual([]);
  });

  test("filters out non-string entries from the stored array", () => {
    const m = new MemStore();
    m.setItem(KEY, JSON.stringify(["a", 1, null, "b", { x: 1 }]));
    expect([...new ExpandedStore(m, KEY).load()]).toEqual(["a", "b"]);
  });

  test("swallows storage errors on save", () => {
    const s = new ExpandedStore(new ThrowingStore(), KEY);
    // Should not throw.
    s.save(["/anything"]);
  });

  test("returns empty set when storage throws on read", () => {
    const s = new ExpandedStore(new ThrowingStore(), KEY);
    expect([...s.load()]).toEqual([]);
  });
});

describe("StarredSessionsStore", () => {
  const SK = "supergit:starredSessions";

  test("returns empty set when nothing is stored", () => {
    const s = new StarredSessionsStore(new MemStore(), SK);
    expect([...s.load()]).toEqual([]);
  });

  test("save then load round-trips sources", () => {
    const m = new MemStore();
    const s = new StarredSessionsStore(m, SK);
    s.save(["/a.jsonl", "/b.jsonl"]);
    expect([...s.load()]).toEqual(["/a.jsonl", "/b.jsonl"]);
  });

  test("save replaces, not merges", () => {
    const m = new MemStore();
    const s = new StarredSessionsStore(m, SK);
    s.save(["a", "b"]);
    s.save(["c"]);
    expect([...s.load()]).toEqual(["c"]);
  });

  test("tolerates corrupt JSON", () => {
    const m = new MemStore();
    m.setItem(SK, "{not json");
    expect([...new StarredSessionsStore(m, SK).load()]).toEqual([]);
  });

  test("tolerates non-array values", () => {
    const m = new MemStore();
    m.setItem(SK, JSON.stringify({ a: 1 }));
    expect([...new StarredSessionsStore(m, SK).load()]).toEqual([]);
  });

  test("drops non-string entries", () => {
    const m = new MemStore();
    m.setItem(SK, JSON.stringify(["a", 1, null, "b"]));
    expect([...new StarredSessionsStore(m, SK).load()]).toEqual(["a", "b"]);
  });

  test("storage exceptions don't propagate", () => {
    const s = new StarredSessionsStore(new ThrowingStore(), SK);
    expect([...s.load()]).toEqual([]);
    expect(() => s.save(["a"])).not.toThrow();
  });
});

describe("DismissedSessionsStore", () => {
  const DK = "supergit:dismissedSessions";

  test("returns empty set when nothing is stored", () => {
    const s = new DismissedSessionsStore(new MemStore(), DK);
    expect([...s.load()]).toEqual([]);
  });

  test("save then load round-trips sources", () => {
    const m = new MemStore();
    const s = new DismissedSessionsStore(m, DK);
    s.save(["/a.jsonl", "__attached__:shell:abc"]);
    expect([...s.load()]).toEqual(["/a.jsonl", "__attached__:shell:abc"]);
  });

  test("save replaces, not merges", () => {
    const m = new MemStore();
    const s = new DismissedSessionsStore(m, DK);
    s.save(["a", "b"]);
    s.save(["c"]);
    expect([...s.load()]).toEqual(["c"]);
  });

  test("tolerates corrupt JSON", () => {
    const m = new MemStore();
    m.setItem(DK, "{not json");
    expect([...new DismissedSessionsStore(m, DK).load()]).toEqual([]);
  });

  test("tolerates non-array values", () => {
    const m = new MemStore();
    m.setItem(DK, JSON.stringify({ a: 1 }));
    expect([...new DismissedSessionsStore(m, DK).load()]).toEqual([]);
  });

  test("drops non-string entries", () => {
    const m = new MemStore();
    m.setItem(DK, JSON.stringify(["a", 1, null, "b"]));
    expect([...new DismissedSessionsStore(m, DK).load()]).toEqual(["a", "b"]);
  });

  test("storage exceptions don't propagate", () => {
    const s = new DismissedSessionsStore(new ThrowingStore(), DK);
    expect([...s.load()]).toEqual([]);
    expect(() => s.save(["a"])).not.toThrow();
  });
});

describe("OpenSessionsStore", () => {
  const KEY = "supergit:openSessions";

  test("returns {} when nothing is stored", () => {
    const s = new OpenSessionsStore(new MemStore(), KEY);
    expect(s.load()).toEqual({});
  });

  test("round-trips a multi-worktree map", () => {
    const m = new MemStore();
    const s = new OpenSessionsStore(m, KEY);
    s.save({
      "/Users/me/git/foo": [
        { agent: "claude", source: "/sess/a.jsonl" },
        { agent: "codex", source: "/sess/b.jsonl" },
      ],
      "/Users/me/git/bar": [{ agent: "claude", source: "/sess/c.jsonl" }],
    });
    expect(s.load()).toEqual({
      "/Users/me/git/foo": [
        { agent: "claude", source: "/sess/a.jsonl" },
        { agent: "codex", source: "/sess/b.jsonl" },
      ],
      "/Users/me/git/bar": [{ agent: "claude", source: "/sess/c.jsonl" }],
    });
  });

  test("save replaces previous data, not merges", () => {
    const m = new MemStore();
    const s = new OpenSessionsStore(m, KEY);
    s.save({ "/a": [{ agent: "claude", source: "/x.jsonl" }] });
    s.save({ "/b": [{ agent: "codex", source: "/y.jsonl" }] });
    expect(s.load()).toEqual({
      "/b": [{ agent: "codex", source: "/y.jsonl" }],
    });
  });

  test("returns {} on corrupted JSON", () => {
    const m = new MemStore();
    m.setItem(KEY, "{ not json");
    expect(new OpenSessionsStore(m, KEY).load()).toEqual({});
  });

  test("returns {} when stored value is an array, not an object", () => {
    const m = new MemStore();
    m.setItem(KEY, JSON.stringify(["/a", "/b"]));
    expect(new OpenSessionsStore(m, KEY).load()).toEqual({});
  });

  test("filters entries with invalid agent values", () => {
    const m = new MemStore();
    m.setItem(
      KEY,
      JSON.stringify({
        "/a": [
          { agent: "gpt5", source: "/bad.jsonl" },
          { agent: "claude", source: "/good.jsonl" },
        ],
      }),
    );
    expect(new OpenSessionsStore(m, KEY).load()).toEqual({
      "/a": [{ agent: "claude", source: "/good.jsonl" }],
    });
  });

  test("drops items without a source string", () => {
    const m = new MemStore();
    m.setItem(
      KEY,
      JSON.stringify({
        "/a": [
          { agent: "claude" },
          { agent: "claude", source: "" },
          { agent: "claude", source: "/ok.jsonl" },
          "not an object",
          null,
        ],
      }),
    );
    expect(new OpenSessionsStore(m, KEY).load()).toEqual({
      "/a": [{ agent: "claude", source: "/ok.jsonl" }],
    });
  });

  test("drops worktree entries whose list ends up empty", () => {
    const m = new MemStore();
    m.setItem(
      KEY,
      JSON.stringify({
        "/has-good": [{ agent: "claude", source: "/ok.jsonl" }],
        "/all-bad": [{ agent: "junk" }, null],
        "/non-array": "wat",
      }),
    );
    expect(new OpenSessionsStore(m, KEY).load()).toEqual({
      "/has-good": [{ agent: "claude", source: "/ok.jsonl" }],
    });
  });

  test("de-duplicates sessions by source within a worktree", () => {
    const m = new MemStore();
    m.setItem(
      KEY,
      JSON.stringify({
        "/a": [
          { agent: "claude", source: "/x.jsonl" },
          { agent: "claude", source: "/x.jsonl" },
          { agent: "claude", source: "/y.jsonl" },
        ],
      }),
    );
    expect(new OpenSessionsStore(m, KEY).load()).toEqual({
      "/a": [
        { agent: "claude", source: "/x.jsonl" },
        { agent: "claude", source: "/y.jsonl" },
      ],
    });
  });

  test("survives across instances pointing at the same storage", () => {
    const m = new MemStore();
    new OpenSessionsStore(m, KEY).save({
      "/r": [{ agent: "codex", source: "/s.jsonl" }],
    });
    const next = new OpenSessionsStore(m, KEY);
    expect(next.load()).toEqual({
      "/r": [{ agent: "codex", source: "/s.jsonl" }],
    });
  });

  test("save keeps the previous open-session payload as a recovery backup", () => {
    const m = new MemStore();
    const s = new OpenSessionsStore(m, KEY);
    s.save({
      "/wt": [
        { agent: "codex", source: "/one.jsonl" },
        { agent: "codex", source: "/two.jsonl" },
      ],
    });
    const first = m.getItem(KEY);
    s.save({
      "/wt": [{ agent: "codex", source: "/one.jsonl" }],
    });
    expect(m.getItem(`${KEY}:previous`)).toBe(first);
  });

  test("save does not churn the recovery backup when the payload is unchanged", () => {
    const m = new MemStore();
    const s = new OpenSessionsStore(m, KEY);
    const data = {
      "/wt": [{ agent: "codex" as const, source: "/one.jsonl" }],
    };
    s.save(data);
    m.setItem(`${KEY}:previous`, "sentinel");
    s.save(data);
    expect(m.getItem(`${KEY}:previous`)).toBe("sentinel");
  });

  test("round-trips claudeModel + claudeEffort", () => {
    const m = new MemStore();
    const s = new OpenSessionsStore(m, KEY);
    s.save({
      "/a": [
        {
          agent: "claude",
          source: "/x.jsonl",
          claudeModel: "opus",
          claudeEffort: "max",
        },
      ],
    });
    expect(s.load()).toEqual({
      "/a": [
        {
          agent: "claude",
          source: "/x.jsonl",
          claudeModel: "opus",
          claudeEffort: "max",
        },
      ],
    });
  });

  test("drops out-of-range claudeModel / claudeEffort values", () => {
    const m = new MemStore();
    m.setItem(
      KEY,
      JSON.stringify({
        "/a": [
          {
            agent: "claude",
            source: "/x.jsonl",
            claudeModel: "gpt-5",
            claudeEffort: "turbo",
          },
        ],
      }),
    );
    // Unknown values are stripped; the session still loads (it just falls
    // back to claude's configured default at spawn).
    expect(new OpenSessionsStore(m, KEY).load()).toEqual({
      "/a": [{ agent: "claude", source: "/x.jsonl" }],
    });
  });

  test("swallows storage errors on save and load", () => {
    const s = new OpenSessionsStore(new ThrowingStore(), KEY);
    s.save({ "/x": [{ agent: "claude", source: "/y.jsonl" }] });
    expect(s.load()).toEqual({});
  });

  test("preserves sessions whose source file is currently missing", () => {
    // The store does not validate paths against disk — it round-trips
    // exactly what callers hand it. This locks in the "don't forget a
    // session just because its file vanished temporarily" contract.
    const m = new MemStore();
    const s = new OpenSessionsStore(m, KEY);
    s.save({
      "/wt": [
        { agent: "claude", source: "/no/such/file/a.jsonl" },
        { agent: "codex", source: "/no/such/file/b.jsonl" },
      ],
    });
    expect(s.load()).toEqual({
      "/wt": [
        { agent: "claude", source: "/no/such/file/a.jsonl" },
        { agent: "codex", source: "/no/such/file/b.jsonl" },
      ],
    });
  });
});

describe("filterToExistingSessions", () => {
  const mkSess = (source: string): PersistedSession => ({
    agent: "claude",
    source,
  });

  test("returns only sessions whose source is in the existing set", () => {
    const persisted = [
      mkSess("/a.jsonl"),
      mkSess("/b.jsonl"),
      mkSess("/c.jsonl"),
    ];
    const existing = new Set(["/a.jsonl", "/c.jsonl"]);
    expect(filterToExistingSessions(persisted, existing)).toEqual([
      mkSess("/a.jsonl"),
      mkSess("/c.jsonl"),
    ]);
  });

  test("returns empty when the existing set has none of the persisted sources", () => {
    const persisted = [mkSess("/a.jsonl"), mkSess("/b.jsonl")];
    const existing = new Set<string>(["/other.jsonl"]);
    expect(filterToExistingSessions(persisted, existing)).toEqual([]);
  });

  test("returns empty when nothing is persisted", () => {
    expect(filterToExistingSessions([], new Set(["/a"]))).toEqual([]);
  });

  test("returns empty when existing set is empty even if persisted is not", () => {
    expect(
      filterToExistingSessions([mkSess("/a.jsonl")], new Set<string>()),
    ).toEqual([]);
  });

  test("keeps live Codex App sessions without waiting for a transcript scan", () => {
    const persisted: PersistedSession[] = [
      {
        agent: "codex",
        source: codexAppSource("019ed50f-696c-7a41-95b0-e824d2e5c372"),
        resumeSessionId: "019ed50f-696c-7a41-95b0-e824d2e5c372",
        transcriptSource: "/Users/me/.codex/sessions/rollout-new.jsonl",
      },
    ];
    expect(filterToExistingSessions(persisted, new Set<string>())).toEqual(
      persisted,
    );
  });

  test("does not keep raw transcript paths merely because a resume id exists", () => {
    const persisted: PersistedSession[] = [
      {
        agent: "codex",
        source: "/Users/me/.codex/sessions/rollout-new.jsonl",
        resumeSessionId: "019ed50f-696c-7a41-95b0-e824d2e5c372",
      },
    ];
    expect(filterToExistingSessions(persisted, new Set<string>())).toEqual([]);
  });

  test("keeps an open session when the known daemon session matches by provider session id", () => {
    const persisted: PersistedSession[] = [
      {
        agent: "codex",
        source: "/Users/me/.codex/sessions/older-path.jsonl",
        resumeSessionId: "019ed50f-696c-7a41-95b0-e824d2e5c372",
      },
    ];
    const existing = new Set([
      "session:codex:019ed50f-696c-7a41-95b0-e824d2e5c372",
    ]);
    expect(filterToExistingSessions(persisted, existing)).toEqual(persisted);
  });

  test("keeps an open session when the known daemon session matches by transcript source alias", () => {
    const persisted: PersistedSession[] = [
      {
        agent: "codex",
        source: "__codex_app__:019ed50f-696c-7a41-95b0-e824d2e5c372",
        transcriptSource: "/Users/me/.codex/sessions/current-path.jsonl",
      },
    ];
    const existing = new Set(["/Users/me/.codex/sessions/current-path.jsonl"]);
    expect(filterToExistingSessions(persisted, existing)).toEqual(persisted);
  });

  test("live Codex App sources are not session-file poll targets", () => {
    const source = codexAppSource("thread-123");
    expect(isLiveCodexAppSource(source)).toBe(true);
    expect(shouldPollSessionSource({ agent: "codex", source })).toBe(false);
    expect(
      shouldPollSessionSource({
        agent: "codex",
        source: "/Users/me/.codex/sessions/thread-123.jsonl",
      }),
    ).toBe(true);
  });

  test("does NOT mutate the persisted array (callers persist the full thing)", () => {
    // The whole point: if a file is missing the UI hides it, but the
    // store still keeps the entry. Verifying we don't accidentally
    // remove items from the input.
    const persisted = [mkSess("/keep.jsonl"), mkSess("/missing.jsonl")];
    const beforeJson = JSON.stringify(persisted);
    filterToExistingSessions(persisted, new Set(["/keep.jsonl"]));
    expect(JSON.stringify(persisted)).toBe(beforeJson);
  });

  // Regression: the "Terminal" column flow uses three synthetic source
  // prefixes that don't exist in /api/agents — they're supergit-internal
  // markers. The render-time filter must not drop them even when the
  // existing-sources set is empty (which it always is for shells, since
  // agentsForWorktree() only returns Claude/Codex/Copilot sessions).
  test("keeps __new__: synthetic sources even when existing is empty (brand-new TUI)", () => {
    const persisted = [mkSess("__new__:claude:abc")];
    expect(filterToExistingSessions(persisted, new Set<string>())).toEqual(
      persisted,
    );
  });

  test("keeps __attached__:shell: synthetic sources (reattached live shell after reload)", () => {
    // Without this, restoreLiveShells() in App.svelte would add the
    // column to openSessionsByWt but the render-time filter would
    // silently drop it because shells aren't in wt.agents.
    const persisted = [mkSess("__attached__:shell:t_abc_1")];
    expect(filterToExistingSessions(persisted, new Set<string>())).toEqual(
      persisted,
    );
  });

  test("keeps __transcript__:shell: synthetic sources (past-shell read-mode view)", () => {
    const persisted = [mkSess("__transcript__:shell:t_abc_1")];
    expect(filterToExistingSessions(persisted, new Set<string>())).toEqual(
      persisted,
    );
  });

  test("keeps synthetic sources mixed with file-backed ones", () => {
    const persisted = [
      mkSess("__attached__:shell:t_1"),
      mkSess("/agents/claude.jsonl"),
      mkSess("__transcript__:shell:t_2"),
      mkSess("/agents/missing.jsonl"),
    ];
    const existing = new Set(["/agents/claude.jsonl"]);
    expect(filterToExistingSessions(persisted, existing)).toEqual([
      mkSess("__attached__:shell:t_1"),
      mkSess("/agents/claude.jsonl"),
      mkSess("__transcript__:shell:t_2"),
    ]);
  });

  // Regression: the strip's `{#each visibleSessions as s, i (s.source)}`
  // throws `svelte/e/each_key_duplicate` if the same source appears
  // twice. Promotion paths (executePromotion, promoteTransientSessions)
  // can rewrite a `__new__:` entry's source to a real one that already
  // exists in the same worktree's array — e.g. when the same session is
  // opened a second time. The render-time filter dedupes so the crash
  // is structurally impossible from the {#each}'s point of view; the
  // promotion sites should still avoid creating dupes, but this is the
  // last line of defense.
  test("dedupes by source, keeping the first occurrence", () => {
    const persisted = [
      mkSess("/agents/dup.jsonl"),
      mkSess("/agents/other.jsonl"),
      mkSess("/agents/dup.jsonl"),
    ];
    const existing = new Set(["/agents/dup.jsonl", "/agents/other.jsonl"]);
    expect(filterToExistingSessions(persisted, existing)).toEqual([
      mkSess("/agents/dup.jsonl"),
      mkSess("/agents/other.jsonl"),
    ]);
  });

  test("dedupes duplicate synthetic sources too", () => {
    const persisted = [
      mkSess("__new__:claude:abc"),
      mkSess("__new__:claude:abc"),
    ];
    expect(filterToExistingSessions(persisted, new Set<string>())).toEqual([
      mkSess("__new__:claude:abc"),
    ]);
  });
});

describe("transientDiscoverySources", () => {
  test("ignores stale persisted __new__ agent sessions without a live spawned terminal", () => {
    const byWt = {
      "/wt": [{ agent: "codex" as const, source: "__new__:codex:t_stale" }],
    };
    expect(
      transientDiscoverySources(byWt, {
        newTermIds: {},
        liveTerminalIds: new Set(),
        discoveryDeadlineMs: { "__new__:codex:t_stale": 10_000 },
        nowMs: 1_000,
      }),
    ).toEqual([]);
  });

  test("keeps live current __new__ agent sessions inside the discovery window", () => {
    const source = "__new__:claude:t_current";
    const byWt = {
      "/wt": [{ agent: "claude" as const, source }],
    };
    expect(
      transientDiscoverySources(byWt, {
        newTermIds: { [source]: "term_1" },
        liveTerminalIds: new Set(["term_1"]),
        discoveryDeadlineMs: { [source]: 10_000 },
        nowMs: 1_000,
      }),
    ).toEqual([source]);
  });

  test("stops polling expired, dead, and shell transient sources", () => {
    const liveExpired = "__new__:codex:t_expired";
    const dead = "__new__:codex:t_dead";
    const shell = "__new__:shell:t_shell";
    const byWt = {
      "/wt": [
        { agent: "codex" as const, source: liveExpired },
        { agent: "codex" as const, source: dead },
        { agent: "shell" as const, source: shell },
      ],
    };
    expect(
      transientDiscoverySources(byWt, {
        newTermIds: {
          [liveExpired]: "term_expired",
          [dead]: "term_dead",
          [shell]: "term_shell",
        },
        liveTerminalIds: new Set(["term_expired", "term_shell"]),
        discoveryDeadlineMs: {
          [liveExpired]: 500,
          [dead]: 10_000,
          [shell]: 10_000,
        },
        nowMs: 1_000,
      }),
    ).toEqual([]);
  });
});

describe("isForeignToWorktree", () => {
  // The real-world bug this guards: a needle-logs-view session got filed
  // under the supergit worktree's open-sessions list. supergit's agent
  // snapshot doesn't list it, so it's foreign and the activity dock must
  // skip it — otherwise it renders as a phantom dot labelled with
  // supergit's branch ("supergit main"). The sessions-strip already drops
  // these via filterToExistingSessions; the dock was missing the gate.
  test("a real source absent from the worktree's known set is foreign", () => {
    const known = new Set([
      "/Users/me/.claude/projects/-Users-me-git-supergit/7081c9db.jsonl",
    ]);
    expect(
      isForeignToWorktree(
        "/Users/me/.claude/projects/-Users-me-git-needle-logs-view/abcf1abf.jsonl",
        known,
      ),
    ).toBe(true);
  });

  test("a real source present in the worktree's known set is not foreign", () => {
    const src =
      "/Users/me/.claude/projects/-Users-me-git-supergit/7081c9db.jsonl";
    expect(isForeignToWorktree(src, new Set([src]))).toBe(false);
  });

  test("synthetic sources are never foreign, even with an empty known set", () => {
    const empty = new Set<string>();
    expect(isForeignToWorktree("__new__:claude:abc", empty)).toBe(false);
    expect(isForeignToWorktree("__attached__:shell:t_1", empty)).toBe(false);
    expect(isForeignToWorktree("__restore__:t_2", empty)).toBe(false);
    expect(isForeignToWorktree("__transcript__:shell:t_3", empty)).toBe(false);
  });

  test("a session matching by provider session id is not foreign", () => {
    expect(
      isSessionForeignToWorktree(
        {
          agent: "codex",
          source: "/Users/me/.codex/sessions/old-path.jsonl",
          resumeSessionId: "019ed50f-696c-7a41-95b0-e824d2e5c372",
        },
        new Set(["session:codex:019ed50f-696c-7a41-95b0-e824d2e5c372"]),
      ),
    ).toBe(false);
  });

  test("a session matching by transcript source alias is not foreign", () => {
    expect(
      isSessionForeignToWorktree(
        {
          agent: "codex",
          source: "__codex_app__:019ed50f-696c-7a41-95b0-e824d2e5c372",
          transcriptSource: "/Users/me/.codex/sessions/current-path.jsonl",
        },
        new Set(["/Users/me/.codex/sessions/current-path.jsonl"]),
      ),
    ).toBe(false);
  });
});

describe("dockSessionHiddenAsForeign", () => {
  // Regression: at startup the per-worktree agent scan is deferred (perf), so
  // `knownSources` is empty for a worktree until its agents finish scanning.
  // A restored agent session would then be judged "foreign" and dropped from
  // the activity dock until the user scrolled the row into view. But a session
  // with a LIVE PTY (cwd-matched to this worktree during reconcile) is
  // authoritative proof it belongs here — it must show in the dock eagerly,
  // before the scan converges.
  const realSession = {
    agent: "claude" as const,
    source:
      "/Users/me/.claude/projects/-Users-me-git-supergit/7081c9db.jsonl",
  };

  test("a live TUI is never hidden, even with an empty known set", () => {
    expect(
      dockSessionHiddenAsForeign(realSession, new Set<string>(), {
        isLiveTui: true,
      }),
    ).toBe(false);
  });

  test("a non-live session absent from the known set is still hidden", () => {
    expect(
      dockSessionHiddenAsForeign(realSession, new Set<string>(), {
        isLiveTui: false,
      }),
    ).toBe(true);
  });

  test("a non-live session present in the known set is not hidden", () => {
    expect(
      dockSessionHiddenAsForeign(realSession, new Set([realSession.source]), {
        isLiveTui: false,
      }),
    ).toBe(false);
  });

  test("a user-opened terminal session (resume) is never hidden, even unscanned", () => {
    // The 34 persisted terminal-mode TUIs must show at startup before any PTY
    // exists and before the deferred agent scan lands.
    expect(
      dockSessionHiddenAsForeign(
        { ...realSession, resumeSessionId: "sess-123" },
        new Set<string>(),
        { isLiveTui: false, isRestorableTui: true },
      ),
    ).toBe(false);
  });

  test("a non-live synthetic session is never hidden", () => {
    expect(
      dockSessionHiddenAsForeign(
        { agent: "claude", source: "__new__:claude:abc" },
        new Set<string>(),
        { isLiveTui: false },
      ),
    ).toBe(false);
  });
});

describe("VisibleWorktreesStore", () => {
  const KEY = "supergit:visibleWorktrees";

  test("returns empty map when nothing stored", () => {
    const s = new VisibleWorktreesStore(new MemStore(), KEY);
    expect(s.load()).toEqual({});
  });

  test("round-trips a map of repoId -> paths", () => {
    const store = new MemStore();
    const s = new VisibleWorktreesStore(store, KEY);
    s.save({ rA: ["/path/a", "/path/b"], rB: ["/path/c"] });
    const reloaded = new VisibleWorktreesStore(store, KEY).load();
    expect(reloaded).toEqual({ rA: ["/path/a", "/path/b"], rB: ["/path/c"] });
  });

  test("save preserves empty arrays and drops non-string entries on the way out", () => {
    const store = new MemStore();
    const s = new VisibleWorktreesStore(store, KEY);
    s.save({
      rA: ["/keep"],
      rEmpty: [],
      rGarbage: ["/ok", 42 as unknown as string, ""],
    });
    const reloaded = new VisibleWorktreesStore(store, KEY).load();
    expect(reloaded).toEqual({
      rA: ["/keep"],
      rEmpty: [],
      rGarbage: ["/ok"],
    });
  });

  test("tolerates corrupt JSON without throwing", () => {
    const store = new MemStore();
    store.setItem(KEY, "{not json}");
    const s = new VisibleWorktreesStore(store, KEY);
    expect(s.load()).toEqual({});
  });

  test("tolerates a non-object root (array, string, null)", () => {
    const store = new MemStore();
    store.setItem(KEY, '["nope"]');
    expect(new VisibleWorktreesStore(store, KEY).load()).toEqual({});
    store.setItem(KEY, '"hello"');
    expect(new VisibleWorktreesStore(store, KEY).load()).toEqual({});
  });

  test("save swallows storage errors", () => {
    const s = new VisibleWorktreesStore(new ThrowingStore(), KEY);
    expect(() => s.save({ rA: ["/path"] })).not.toThrow();
  });

  test("load swallows storage errors", () => {
    const s = new VisibleWorktreesStore(new ThrowingStore(), KEY);
    expect(s.load()).toEqual({});
  });
});

describe("cmdForOpenSession", () => {
  test("shell always uses the user's default login shell, ignoring resumeSessionId", () => {
    // `-l` forces login-shell mode so .zprofile/.zlogin source and the
    // user's HISTFILE/HISTSIZE/SAVEHIST configuration applies — otherwise
    // zsh's defaults (HISTSIZE=10, SAVEHIST=0) silently break arrow-up
    // history and dispose wipes the session's commands.
    expect(cmdForOpenSession({ agent: "shell" }, "/bin/zsh")).toEqual([
      "/bin/zsh",
      "-l",
    ]);
    // Even with a sid stamped (shouldn't happen for shells, but the
    // helper must be defensive): still defaultShell, not anything else.
    expect(
      cmdForOpenSession(
        { agent: "shell", resumeSessionId: "sid" },
        "/bin/fish",
      ),
    ).toEqual(["/bin/fish", "-l"]);
  });

  test("shell with a shellCmd override spawns that exact command (CMD vs PowerShell pick)", () => {
    // The new-session picker stamps shellCmd when the box offers >1 shell
    // (Windows: PowerShell + CMD). It must win over the daemon's default
    // shell so the user gets the shell they clicked.
    expect(
      cmdForOpenSession(
        { agent: "shell", shellCmd: ["cmd.exe"] },
        "powershell.exe",
        ["-NoLogo"],
      ),
    ).toEqual(["cmd.exe"]);
    expect(
      cmdForOpenSession(
        { agent: "shell", shellCmd: ["powershell.exe", "-NoLogo"] },
        "cmd.exe",
        [],
      ),
    ).toEqual(["powershell.exe", "-NoLogo"]);
  });

  test("shell with an empty shellCmd falls back to the default login shell", () => {
    // Defensive: a stale/blank override must not spawn an empty command.
    expect(
      cmdForOpenSession({ agent: "shell", shellCmd: [] }, "/bin/zsh"),
    ).toEqual(["/bin/zsh", "-l"]);
  });

  test("brand-new claude column with neither sid nor preassignedSessionId spawns bare `claude`", () => {
    // Defensive fallback — in normal flow openNewAgentSession always
    // preassigns a UUID, but if some persisted entry predates that
    // change we still want a working spawn.
    expect(cmdForOpenSession({ agent: "claude" }, "/bin/zsh")).toEqual([
      "claude",
    ]);
  });

  test("brand-new claude column with preassignedSessionId spawns `claude --session-id <uuid>`", () => {
    // Forces a fresh session at the CLI level so newer Claude versions
    // can't auto-load the cwd's most-recent conversation. The UUID is
    // generated by openNewAgentSession and persisted so a reload before
    // the JSONL appears spawns the *same* session id again.
    expect(
      cmdForOpenSession(
        {
          agent: "claude",
          preassignedSessionId: "11111111-2222-3333-4444-555555555555",
        },
        "/bin/zsh",
      ),
    ).toEqual([
      "claude",
      "--session-id",
      "11111111-2222-3333-4444-555555555555",
    ]);
  });

  test("claude with both resumeSessionId and preassignedSessionId prefers --resume", () => {
    // Once the activity tail has stamped a real resumeSessionId, that
    // wins over the preassigned id — the user resumed an existing
    // conversation, the preassigned id is no longer relevant.
    expect(
      cmdForOpenSession(
        {
          agent: "claude",
          resumeSessionId: "abc-123",
          preassignedSessionId: "11111111-2222-3333-4444-555555555555",
        },
        "/bin/zsh",
      ),
    ).toEqual([
      "claude",
      "--resume",
      "abc-123",
      "--allow-dangerously-skip-permissions",
    ]);
  });

  test("claude with a stamped resumeSessionId uses `--resume` + dangerously-skip flag", () => {
    // This is the regression guard for the reload bug: once the activity
    // tail has surfaced the real claude session id, the next mount must
    // resume rather than spawn fresh. The --allow-dangerously-skip-
    // permissions flag matches the read-mode Resume path in SessionView.
    expect(
      cmdForOpenSession(
        { agent: "claude", resumeSessionId: "abc-123" },
        "/bin/zsh",
      ),
    ).toEqual([
      "claude",
      "--resume",
      "abc-123",
      "--allow-dangerously-skip-permissions",
    ]);
  });

  test("brand-new claude column with claudeModel appends `--model <alias>`", () => {
    expect(
      cmdForOpenSession(
        {
          agent: "claude",
          preassignedSessionId: "11111111-2222-3333-4444-555555555555",
          claudeModel: "opus",
        },
        "/bin/zsh",
      ),
    ).toEqual([
      "claude",
      "--session-id",
      "11111111-2222-3333-4444-555555555555",
      "--model",
      "opus",
    ]);
  });

  test("brand-new claude column with claudeEffort appends `--effort <level>`", () => {
    expect(
      cmdForOpenSession({ agent: "claude", claudeEffort: "high" }, "/bin/zsh"),
    ).toEqual(["claude", "--effort", "high"]);
  });

  test("resumed claude column threads --model/--effort after the dangerously flag", () => {
    // The model/effort flags must come *after* --allow-dangerously-skip-
    // permissions but they apply to the resumed conversation — switching
    // model mid-thread is exactly the "restart via resume" UX.
    expect(
      cmdForOpenSession(
        {
          agent: "claude",
          resumeSessionId: "abc-123",
          claudeModel: "sonnet",
          claudeEffort: "max",
        },
        "/bin/zsh",
      ),
    ).toEqual([
      "claude",
      "--resume",
      "abc-123",
      "--allow-dangerously-skip-permissions",
      "--model",
      "sonnet",
      "--effort",
      "max",
    ]);
  });

  test("claudeModel/effort flags precede the contextFilePath positional prompt", () => {
    // Flags must land before the trailing positional ("Pick up where…")
    // or claude treats the prompt as the value of the last flag.
    expect(
      cmdForOpenSession(
        {
          agent: "claude",
          preassignedSessionId: "aaaa-bbbb",
          claudeModel: "haiku",
          contextFilePath: "/tmp/ctx.md",
        },
        "/bin/zsh",
      ),
    ).toEqual([
      "claude",
      "--session-id",
      "aaaa-bbbb",
      "--model",
      "haiku",
      "--append-system-prompt-file",
      "/tmp/ctx.md",
      "--allow-dangerously-skip-permissions",
      "Pick up where the previous conversation left off.",
    ]);
  });

  test("model/effort flags are claude-only (codex ignores them)", () => {
    expect(
      cmdForOpenSession(
        { agent: "codex", claudeModel: "opus", claudeEffort: "high" } as never,
        "/bin/zsh",
      ),
    ).toEqual(["codex"]);
  });

  test("brand-new codex column (no sid) spawns bare `codex`", () => {
    expect(cmdForOpenSession({ agent: "codex" }, "/bin/zsh")).toEqual([
      "codex",
    ]);
  });

  test("codex with a stamped resumeSessionId uses `codex resume <sid>`", () => {
    // codex takes the session id as a positional after `resume`, matching
    // the read-mode Resume path in SessionView.svelte.
    expect(
      cmdForOpenSession(
        { agent: "codex", resumeSessionId: "ses_42" },
        "/bin/zsh",
      ),
    ).toEqual(["codex", "resume", "ses_42"]);
  });

  test("copilot ignores resumeSessionId in v0 (no resume semantics)", () => {
    expect(
      cmdForOpenSession(
        { agent: "copilot", resumeSessionId: "ignored" },
        "/bin/zsh",
      ),
    ).toEqual(["copilot"]);
  });

  // No ollama case — Ollama is API-driven (see plans/ollama.md "Plan:
  // API-driven chat mode"), so cmdForOpenSession is never called for
  // an Ollama OpenSession. The chat composer drives /api/ollama/chat
  // directly; there's no PTY to spawn.

  test("claude with contextFilePath appends --append-system-prompt-file + visible prompt", () => {
    expect(
      cmdForOpenSession(
        {
          agent: "claude",
          preassignedSessionId: "aaaa-bbbb",
          contextFilePath: "/tmp/supergit/context-handoffs/123.md",
        },
        "/bin/zsh",
      ),
    ).toEqual([
      "claude",
      "--session-id",
      "aaaa-bbbb",
      "--append-system-prompt-file",
      "/tmp/supergit/context-handoffs/123.md",
      "--allow-dangerously-skip-permissions",
      "Pick up where the previous conversation left off.",
    ]);
  });

  test("claude with contextFilePath but resumeSessionId ignores contextFilePath (resume wins)", () => {
    expect(
      cmdForOpenSession(
        {
          agent: "claude",
          resumeSessionId: "abc-123",
          contextFilePath: "/tmp/ctx.md",
        },
        "/bin/zsh",
      ),
    ).toEqual([
      "claude",
      "--resume",
      "abc-123",
      "--allow-dangerously-skip-permissions",
    ]);
  });

  test("codex with contextFilePath passes file reference as positional prompt", () => {
    const result = cmdForOpenSession(
      {
        agent: "codex",
        contextFilePath: "/tmp/supergit/context-handoffs/456.md",
      },
      "/bin/zsh",
    );
    expect(result[0]).toBe("codex");
    expect(result[1]).toContain("/tmp/supergit/context-handoffs/456.md");
  });

  test("codex with resumeSessionId ignores contextFilePath (resume wins)", () => {
    expect(
      cmdForOpenSession(
        {
          agent: "codex",
          resumeSessionId: "ses_99",
          contextFilePath: "/tmp/ctx.md",
        },
        "/bin/zsh",
      ),
    ).toEqual(["codex", "resume", "ses_99"]);
  });

  test("claude with initialPrompt auto-runs the seeded prompt (task start)", () => {
    // Starting a queued task seeds the task's prompt as a trailing
    // positional and pairs it with --allow-dangerously-skip-permissions
    // so the agent just gets to work (see plans/PLAN-tasks.md "Start").
    // The flags must precede the positional or claude reads the prompt as
    // a flag value.
    expect(
      cmdForOpenSession(
        {
          agent: "claude",
          preassignedSessionId: "aaaa-bbbb",
          initialPrompt: "Fix the flaky login test",
        },
        "/bin/zsh",
      ),
    ).toEqual([
      "claude",
      "--session-id",
      "aaaa-bbbb",
      "--allow-dangerously-skip-permissions",
      "Fix the flaky login test",
    ]);
  });

  test("claude initialPrompt is ignored once resumeSessionId is stamped (no re-send on reload)", () => {
    // Once the agent has minted its session id, reloads resume rather than
    // re-seeding the prompt — otherwise every reload would re-submit the
    // task prompt into the live conversation.
    expect(
      cmdForOpenSession(
        {
          agent: "claude",
          resumeSessionId: "abc-123",
          initialPrompt: "Fix the flaky login test",
        },
        "/bin/zsh",
      ),
    ).toEqual([
      "claude",
      "--resume",
      "abc-123",
      "--allow-dangerously-skip-permissions",
    ]);
  });

  test("claude contextFilePath wins over initialPrompt (handoff prompt is authoritative)", () => {
    // A context handoff and a task prompt shouldn't both land; the handoff
    // path is the established one, so it takes precedence.
    expect(
      cmdForOpenSession(
        {
          agent: "claude",
          contextFilePath: "/tmp/ctx.md",
          initialPrompt: "task prompt",
        },
        "/bin/zsh",
      ),
    ).toEqual([
      "claude",
      "--append-system-prompt-file",
      "/tmp/ctx.md",
      "--allow-dangerously-skip-permissions",
      "Pick up where the previous conversation left off.",
    ]);
  });

  test("codex with initialPrompt passes it as the positional prompt", () => {
    expect(
      cmdForOpenSession(
        { agent: "codex", initialPrompt: "Fix the flaky login test" },
        "/bin/zsh",
      ),
    ).toEqual(["codex", "Fix the flaky login test"]);
  });

  test("codex resumeSessionId wins over initialPrompt (no re-send on reload)", () => {
    expect(
      cmdForOpenSession(
        {
          agent: "codex",
          resumeSessionId: "ses_99",
          initialPrompt: "task prompt",
        },
        "/bin/zsh",
      ),
    ).toEqual(["codex", "resume", "ses_99"]);
  });

  test("shell ignores initialPrompt (no positional prompt for a plain PTY)", () => {
    expect(
      cmdForOpenSession(
        { agent: "shell", initialPrompt: "task prompt" },
        "/bin/zsh",
      ),
    ).toEqual(["/bin/zsh", "-l"]);
  });
});

describe("claudeModelAlias", () => {
  test("maps full model ids to their tier alias", () => {
    expect(claudeModelAlias("claude-opus-4-8")).toBe("opus");
    expect(claudeModelAlias("claude-sonnet-4-6")).toBe("sonnet");
    expect(claudeModelAlias("claude-haiku-4-5-20251001")).toBe("haiku");
  });

  test("passes the bare aliases through", () => {
    expect(claudeModelAlias("opus")).toBe("opus");
    expect(claudeModelAlias("sonnet")).toBe("sonnet");
    expect(claudeModelAlias("haiku")).toBe("haiku");
  });

  test("is case-insensitive", () => {
    expect(claudeModelAlias("Claude-OPUS-4-8")).toBe("opus");
  });

  test("returns undefined for unknown or empty input", () => {
    expect(claudeModelAlias(undefined)).toBeUndefined();
    expect(claudeModelAlias("")).toBeUndefined();
    expect(claudeModelAlias("gpt-5")).toBeUndefined();
  });
});

describe("stampDiscoveredSessionId", () => {
  const SID = "discovered-session-id";

  test("stamps the first matching __new__: column without a sid", () => {
    const before: Record<string, PersistedSession[]> = {
      "/wt": [{ agent: "claude", source: "__new__:claude:t_abc" }],
    };
    const after = stampDiscoveredSessionId(before, {
      agent: "claude",
      cwd: "/wt",
      sessionId: SID,
    });
    expect(after).toEqual({
      "/wt": [
        {
          agent: "claude",
          source: "__new__:claude:t_abc",
          resumeSessionId: SID,
        },
      ],
    });
    // Doesn't mutate the input map.
    expect(before["/wt"]![0]!.resumeSessionId).toBeUndefined();
  });

  test("returns the same reference when nothing matched (no churn)", () => {
    const before: Record<string, PersistedSession[]> = {
      "/wt": [{ agent: "claude", source: "/agents/already-on-disk.jsonl" }],
    };
    const after = stampDiscoveredSessionId(before, {
      agent: "claude",
      cwd: "/wt",
      sessionId: SID,
    });
    // Same reference — so reactive consumers can short-circuit.
    expect(after).toBe(before);
  });

  test("returns same reference when the cwd has no open sessions at all", () => {
    const before: Record<string, PersistedSession[]> = {
      "/other-wt": [{ agent: "claude", source: "__new__:claude:t_abc" }],
    };
    const after = stampDiscoveredSessionId(before, {
      agent: "claude",
      cwd: "/wt",
      sessionId: SID,
    });
    expect(after).toBe(before);
  });

  test("does NOT overwrite an already-stamped sid (first match wins)", () => {
    // Two columns: first already has a sid (stamped earlier), second is
    // unstamped. A second activity event should attach to the second one.
    const before: Record<string, PersistedSession[]> = {
      "/wt": [
        {
          agent: "claude",
          source: "__new__:claude:t_1",
          resumeSessionId: "first-sid",
        },
        { agent: "claude", source: "__new__:claude:t_2" },
      ],
    };
    const after = stampDiscoveredSessionId(before, {
      agent: "claude",
      cwd: "/wt",
      sessionId: SID,
    });
    expect(after["/wt"]).toEqual([
      {
        agent: "claude",
        source: "__new__:claude:t_1",
        resumeSessionId: "first-sid",
      },
      {
        agent: "claude",
        source: "__new__:claude:t_2",
        resumeSessionId: SID,
      },
    ]);
  });

  test("only matches the same agent — codex events don't stamp claude columns", () => {
    const before: Record<string, PersistedSession[]> = {
      "/wt": [{ agent: "claude", source: "__new__:claude:t_abc" }],
    };
    const after = stampDiscoveredSessionId(before, {
      agent: "codex",
      cwd: "/wt",
      sessionId: SID,
    });
    expect(after).toBe(before);
  });

  test("skips non-`__new__:` sources (existing JSONL columns already have their sid in the source)", () => {
    // A file-backed source's sessionId is the JSONL filename, so we
    // shouldn't stamp anything onto it from a drive-by activity event.
    const before: Record<string, PersistedSession[]> = {
      "/wt": [
        {
          agent: "claude",
          source: "/Users/me/.claude/projects/-Users-me-wt/abc-123.jsonl",
        },
      ],
    };
    const after = stampDiscoveredSessionId(before, {
      agent: "claude",
      cwd: "/wt",
      sessionId: SID,
    });
    expect(after).toBe(before);
  });

  test("ignores empty sessionId (defensive)", () => {
    const before: Record<string, PersistedSession[]> = {
      "/wt": [{ agent: "claude", source: "__new__:claude:t_abc" }],
    };
    const after = stampDiscoveredSessionId(before, {
      agent: "claude",
      cwd: "/wt",
      sessionId: "",
    });
    expect(after).toBe(before);
  });
});

describe("stampDiscoveredSessionIdWithDetail", () => {
  // The detail-returning variant exists so the activity-SSE handler in
  // App.svelte can migrate the user-typed manual title from the
  // disposable synthetic source (`__new__:claude:<rnd>`) onto the real
  // JSONL path the conversation lives at — the
  // [[feedback-titles-linked-to-real-session-ids]] bug fix. Without the
  // returned `stampedSource`, the caller would have to walk the map
  // again to find what just changed.
  const SID = "discovered-session-id";

  test("returns the synthetic source whose entry got the sid stamped onto it", () => {
    const before: Record<string, PersistedSession[]> = {
      "/wt": [{ agent: "claude", source: "__new__:claude:t_abc" }],
    };
    const result = stampDiscoveredSessionIdWithDetail(before, {
      agent: "claude",
      cwd: "/wt",
      sessionId: SID,
    });
    expect(result.stampedSource).toBe("__new__:claude:t_abc");
    expect(result.byWt["/wt"]).toEqual([
      {
        agent: "claude",
        source: "__new__:claude:t_abc",
        resumeSessionId: SID,
      },
    ]);
  });

  test("returns stampedSource: null and the same map ref when nothing matched", () => {
    const before: Record<string, PersistedSession[]> = {
      "/wt": [
        {
          agent: "claude",
          source: "__new__:claude:t_abc",
          resumeSessionId: "already-stamped",
        },
      ],
    };
    const result = stampDiscoveredSessionIdWithDetail(before, {
      agent: "claude",
      cwd: "/wt",
      sessionId: SID,
    });
    expect(result.stampedSource).toBeNull();
    expect(result.byWt).toBe(before);
  });

  test("when two `__new__:` columns share a cwd, returns the FIRST unstamped (race-known behaviour)", () => {
    // Pins the existing "first unstamped wins" race that the title-
    // migration fix actually depends on: the SSE handler migrates the
    // returned `stampedSource`, not whichever column the user typed
    // their title into. The bug the migration fixes is "title visible
    // on column A but resumed conversation came from column B" —
    // migrating to ev.source lets the next reload look up the title
    // via the matched agent's JSONL path so the title travels with the
    // conversation regardless of which synthetic key originally
    // received it.
    const before: Record<string, PersistedSession[]> = {
      "/wt": [
        { agent: "claude", source: "__new__:claude:t_first" },
        { agent: "claude", source: "__new__:claude:t_second" },
      ],
    };
    const result = stampDiscoveredSessionIdWithDetail(before, {
      agent: "claude",
      cwd: "/wt",
      sessionId: SID,
    });
    expect(result.stampedSource).toBe("__new__:claude:t_first");
  });

  test("ignores empty sessionId — no churn, no spurious migration trigger", () => {
    const before: Record<string, PersistedSession[]> = {
      "/wt": [{ agent: "claude", source: "__new__:claude:t_abc" }],
    };
    const result = stampDiscoveredSessionIdWithDetail(before, {
      agent: "claude",
      cwd: "/wt",
      sessionId: "",
    });
    expect(result.stampedSource).toBeNull();
    expect(result.byWt).toBe(before);
  });

  test("does NOT stamp a __new__: column with a sid already claimed by a sibling column in the same worktree", () => {
    // Bug scenario: an existing column resumed against sid-X is actively
    // chatting (440 messages, the user is typing). Each user/assistant
    // turn fires an activity event whose sessionId === sid-X. If a
    // separate brand-new `__new__:claude:` column also exists in the
    // same worktree (user clicked "New Claude" to open a fresh chat),
    // the old behaviour was to greedily stamp sid-X onto the new
    // column — because it's the "first unstamped __new__: column for
    // this (cwd, agent)". That mis-stamping causes:
    //   1. resolveTitleSource(new column) → resolves to sid-X's JSONL
    //      path, the same as the existing column. Both columns share
    //      one title.
    //   2. The new column's cmdForOpenSession picks up `--resume sid-X`
    //      on the next reload, so it boots into the EXISTING chat
    //      instead of starting fresh.
    // The fix: an activity event whose sid is already claimed (either
    // as another entry's resumeSessionId, or as the sid embedded in
    // an existing JSONL source path) must NOT be re-attributed to a
    // fresh `__new__:` column. The activity belongs to the column that
    // already owns that sid.
    const EXISTING_JSONL =
      "/Users/me/.claude/projects/-Users-me-wt/sid-X.jsonl";
    const before: Record<string, PersistedSession[]> = {
      "/wt": [
        { agent: "claude", source: EXISTING_JSONL },
        { agent: "claude", source: "__new__:claude:t_fresh" },
      ],
    };
    const result = stampDiscoveredSessionIdWithDetail(before, {
      agent: "claude",
      cwd: "/wt",
      sessionId: "sid-X",
      source: EXISTING_JSONL,
    });
    expect(result.stampedSource).toBeNull();
    expect(result.byWt).toBe(before);
  });

  test("does NOT stamp when another __new__: column already carries this sid as its resumeSessionId", () => {
    // Same invariant via the other identity channel: a previously
    // stamped synthetic column owns sid-X. A late activity event for
    // sid-X must not attribute to a still-unstamped sibling.
    const before: Record<string, PersistedSession[]> = {
      "/wt": [
        {
          agent: "claude",
          source: "__new__:claude:t_owner",
          resumeSessionId: "sid-X",
        },
        { agent: "claude", source: "__new__:claude:t_fresh" },
      ],
    };
    const result = stampDiscoveredSessionIdWithDetail(before, {
      agent: "claude",
      cwd: "/wt",
      sessionId: "sid-X",
      source: "/Users/me/.claude/projects/-Users-me-wt/sid-X.jsonl",
    });
    expect(result.stampedSource).toBeNull();
    expect(result.byWt).toBe(before);
  });
});

describe("resolveTitleSource", () => {
  // The bug: with two concurrent `__new__:claude:` columns in the same
  // worktree, the activity-SSE stamping order can race the open order,
  // so column A's persisted entry ends up resuming column B's
  // conversation. If the user-typed manual title stays keyed by A's
  // synthetic source, a reload renders "A's name, but B's chat" —
  // which is what surfaces as "TUI names are mixed".
  // The fix: bind the title to the real JSONL path as soon as the
  // resumeSessionId is stamped, so the title travels with the
  // conversation. `resolveTitleSource` is the pure resolver the render
  // path uses to decide where the title save/lookup should go.
  const JSONL_PATH = "/Users/me/.claude/projects/-Users-me-wt/sid-A.jsonl";

  test("falls back to the synthetic source when no resumeSessionId yet (brand-new TUI)", () => {
    const out = resolveTitleSource(
      { agent: "claude", source: "__new__:claude:t_abc" },
      [],
    );
    expect(out).toBe("__new__:claude:t_abc");
  });

  test("returns the matched agent's JSONL source once a sid is stamped", () => {
    const out = resolveTitleSource(
      {
        agent: "claude",
        source: "__new__:claude:t_abc",
        resumeSessionId: "sid-A",
      },
      [
        { agent: "claude", sessionId: "sid-A", source: JSONL_PATH },
        { agent: "claude", sessionId: "sid-B", source: "/other.jsonl" },
      ],
    );
    expect(out).toBe(JSONL_PATH);
  });

  test("falls back to synthetic when the stamped sid hasn't been re-detected yet", () => {
    // After a hard reload, /api/repos is fetched after openSessionsByWt
    // is hydrated from localStorage. There's a brief window where the
    // persisted entry has a resumeSessionId but the matching agent
    // isn't in the list yet — we must not lose the synthetic key as a
    // title source, or the column briefly renders title-less.
    const out = resolveTitleSource(
      {
        agent: "claude",
        source: "__new__:claude:t_abc",
        resumeSessionId: "sid-A",
      },
      [{ agent: "claude", sessionId: "sid-B", source: "/other.jsonl" }],
    );
    expect(out).toBe("__new__:claude:t_abc");
  });

  test("does not match across agents (codex sid never resolves a claude title)", () => {
    const out = resolveTitleSource(
      {
        agent: "claude",
        source: "__new__:claude:t_abc",
        resumeSessionId: "sid-A",
      },
      [{ agent: "codex", sessionId: "sid-A", source: JSONL_PATH }],
    );
    expect(out).toBe("__new__:claude:t_abc");
  });

  test("passes through non-synthetic sources unchanged (real JSONL columns)", () => {
    // A live SessionView column already has the real path as its
    // source. There's nothing to resolve — return as-is so the caller
    // can save / look up the title directly.
    const out = resolveTitleSource(
      { agent: "claude", source: JSONL_PATH, resumeSessionId: "sid-A" },
      [{ agent: "claude", sessionId: "sid-A", source: JSONL_PATH }],
    );
    expect(out).toBe(JSONL_PATH);
  });

  test("stores live Codex App titles on the transcript source when available", () => {
    const out = resolveTitleSource(
      {
        agent: "codex",
        source: "__codex_app__:sid-A",
        resumeSessionId: "sid-A",
        transcriptSource: JSONL_PATH,
      },
      [],
    );
    expect(out).toBe(JSONL_PATH);
  });

  test("falls back from live Codex App source to the detected session source", () => {
    const out = resolveTitleSource(
      {
        agent: "codex",
        source: "__codex_app__:sid-A",
        resumeSessionId: "sid-A",
      },
      [{ agent: "codex", sessionId: "sid-A", source: JSONL_PATH }],
    );
    expect(out).toBe(JSONL_PATH);
  });

  test("shells fall through to synthetic — they use `__attached__:shell:<termId>` semantics, not sid linking", () => {
    const out = resolveTitleSource(
      { agent: "shell", source: "__attached__:shell:t_xyz" },
      [],
    );
    expect(out).toBe("__attached__:shell:t_xyz");
  });
});

describe("setSessionMode", () => {
  const SOURCE = "/Users/me/.claude/projects/-Users-me-wt/abc.jsonl";

  test("adding terminal mode stamps the field on the matching entry only", () => {
    const before: Record<string, PersistedSession[]> = {
      "/wt-a": [
        { agent: "claude", source: SOURCE },
        { agent: "codex", source: "/other.jsonl" },
      ],
      "/wt-b": [{ agent: "claude", source: SOURCE }],
    };
    const after = setSessionMode(before, "/wt-a", SOURCE, "terminal");
    expect(after["/wt-a"]).toEqual([
      { agent: "claude", source: SOURCE, mode: "terminal" },
      { agent: "codex", source: "/other.jsonl" },
    ]);
    // Untouched wt is the same array reference (no churn).
    expect(after["/wt-b"]).toBe(before["/wt-b"]);
  });

  test("flipping back to read drops the field (no dead state left)", () => {
    const before: Record<string, PersistedSession[]> = {
      "/wt": [{ agent: "claude", source: SOURCE, mode: "terminal" }],
    };
    const after = setSessionMode(before, "/wt", SOURCE, "read");
    expect(after["/wt"]).toEqual([{ agent: "claude", source: SOURCE }]);
    // Specifically, the field is removed, not just falsy.
    expect("mode" in after["/wt"]![0]!).toBe(false);
  });

  test("returns same reference when the mode is already what was asked", () => {
    const terminal: Record<string, PersistedSession[]> = {
      "/wt": [{ agent: "claude", source: SOURCE, mode: "terminal" }],
    };
    expect(setSessionMode(terminal, "/wt", SOURCE, "terminal")).toBe(terminal);

    const read: Record<string, PersistedSession[]> = {
      "/wt": [{ agent: "claude", source: SOURCE }],
    };
    expect(setSessionMode(read, "/wt", SOURCE, "read")).toBe(read);
  });

  test("returns same reference when the wt is missing", () => {
    const before: Record<string, PersistedSession[]> = {
      "/wt": [{ agent: "claude", source: SOURCE }],
    };
    expect(setSessionMode(before, "/other-wt", SOURCE, "terminal")).toBe(
      before,
    );
  });

  test("returns same reference when the source isn't in the list", () => {
    const before: Record<string, PersistedSession[]> = {
      "/wt": [{ agent: "claude", source: "/different.jsonl" }],
    };
    expect(setSessionMode(before, "/wt", SOURCE, "terminal")).toBe(before);
  });

  test("preserves other fields on the entry (resumeSessionId, agent)", () => {
    const before: Record<string, PersistedSession[]> = {
      "/wt": [
        {
          agent: "claude",
          source: "__new__:claude:t_a",
          resumeSessionId: "sid-1",
        },
      ],
    };
    const after = setSessionMode(
      before,
      "/wt",
      "__new__:claude:t_a",
      "terminal",
    );
    expect(after["/wt"]).toEqual([
      {
        agent: "claude",
        source: "__new__:claude:t_a",
        resumeSessionId: "sid-1",
        mode: "terminal",
      },
    ]);
  });

  test("doesn't mutate the input map or its inner arrays", () => {
    const before: Record<string, PersistedSession[]> = {
      "/wt": [{ agent: "claude", source: SOURCE }],
    };
    const beforeJson = JSON.stringify(before);
    setSessionMode(before, "/wt", SOURCE, "terminal");
    expect(JSON.stringify(before)).toBe(beforeJson);
  });
});

describe("setSessionAttachTermId", () => {
  const SOURCE = "/Users/me/.claude/projects/-Users-me-wt/abc.jsonl";

  test("stamps the live terminal id on the matching entry only", () => {
    const before: Record<string, PersistedSession[]> = {
      "/wt-a": [
        { agent: "claude", source: SOURCE, mode: "terminal" },
        { agent: "codex", source: "/other.jsonl" },
      ],
      "/wt-b": [{ agent: "claude", source: SOURCE }],
    };
    const after = setSessionAttachTermId(before, "/wt-a", SOURCE, "t_new_1");
    expect(after["/wt-a"]).toEqual([
      { agent: "claude", source: SOURCE, mode: "terminal", attachTermId: "t_new_1" },
      { agent: "codex", source: "/other.jsonl" },
    ]);
    expect(after["/wt-b"]).toBe(before["/wt-b"]);
  });

  test("replaces a stale attachTermId with the fresh one", () => {
    // The daemon-restart case: the persisted/in-memory id is dead; after
    // the fallback respawns we must repoint it at the live PTY so a
    // subsequent remount doesn't 404 against the dead id again.
    const before: Record<string, PersistedSession[]> = {
      "/wt": [
        { agent: "claude", source: SOURCE, attachTermId: "t_dead_13" },
      ],
    };
    const after = setSessionAttachTermId(before, "/wt", SOURCE, "t_live_20");
    expect(after["/wt"]![0]!.attachTermId).toBe("t_live_20");
  });

  test("returns same reference when the id is unchanged", () => {
    const before: Record<string, PersistedSession[]> = {
      "/wt": [{ agent: "claude", source: SOURCE, attachTermId: "t_x" }],
    };
    expect(setSessionAttachTermId(before, "/wt", SOURCE, "t_x")).toBe(before);
  });

  test("returns same reference when the wt or source is missing", () => {
    const before: Record<string, PersistedSession[]> = {
      "/wt": [{ agent: "claude", source: SOURCE }],
    };
    expect(setSessionAttachTermId(before, "/nope", SOURCE, "t_1")).toBe(before);
    expect(setSessionAttachTermId(before, "/wt", "/missing.jsonl", "t_1")).toBe(
      before,
    );
  });

  test("doesn't mutate the input map or its inner arrays", () => {
    const before: Record<string, PersistedSession[]> = {
      "/wt": [{ agent: "claude", source: SOURCE }],
    };
    const beforeJson = JSON.stringify(before);
    setSessionAttachTermId(before, "/wt", SOURCE, "t_1");
    expect(JSON.stringify(before)).toBe(beforeJson);
  });

  test("attachTermId is dropped on load (only valid within its daemon run)", () => {
    // It must never be trusted across a reload: the PTY it names may be
    // gone. sanitizeSession deliberately omits it.
    const m = new MemStore();
    const store = new OpenSessionsStore(m, "supergit:openSessions-attach");
    store.save({
      "/wt": [{ agent: "claude", source: SOURCE, attachTermId: "t_dead" }],
    });
    expect(store.load()).toEqual({
      "/wt": [{ agent: "claude", source: SOURCE }],
    });
  });

  test("renderKey is dropped on load (only stabilizes current-page mounts)", () => {
    const m = new MemStore();
    const store = new OpenSessionsStore(m, "supergit:openSessions-render-key");
    store.save({
      "/wt": [
        {
          agent: "shell",
          source: "__attached__:shell:t_live",
          renderKey: "__new__:shell:synthetic",
        },
      ],
    });
    expect(store.load()).toEqual({
      "/wt": [{ agent: "shell", source: "__attached__:shell:t_live" }],
    });
  });

  test("openSessionRenderKey prefers the transient render key", () => {
    expect(
      openSessionRenderKey({
        source: "__attached__:shell:t_live",
        renderKey: "__new__:shell:synthetic",
      }),
    ).toBe("__new__:shell:synthetic");
    expect(openSessionRenderKey({ source: "__attached__:shell:t_live" })).toBe(
      "__attached__:shell:t_live",
    );
  });
});

describe("OpenSessionsStore + mode round-trip", () => {
  const KEY = "supergit:openSessions-mode";

  test("persists mode='terminal' alongside agent/source", () => {
    // This is the user-visible fix: clicking "Resume in terminal" must
    // survive a reload. Without persistence, the SessionView remounts
    // with mode='read' (its default) and the user lands back in the
    // history view despite a live PTY they were just typing into.
    const m = new MemStore();
    const s = new OpenSessionsStore(m, KEY);
    s.save({
      "/wt": [{ agent: "claude", source: "/agents/x.jsonl", mode: "terminal" }],
    });
    expect(s.load()).toEqual({
      "/wt": [{ agent: "claude", source: "/agents/x.jsonl", mode: "terminal" }],
    });
  });

  test("absence of mode round-trips as undefined (default = read)", () => {
    const m = new MemStore();
    new OpenSessionsStore(m, KEY).save({
      "/wt": [{ agent: "claude", source: "/agents/x.jsonl" }],
    });
    const loaded = new OpenSessionsStore(m, KEY).load();
    expect(loaded["/wt"]![0]!.mode).toBeUndefined();
  });

  test("ignores garbage mode values (only 'terminal' is accepted)", () => {
    const m = new MemStore();
    m.setItem(
      KEY,
      JSON.stringify({
        "/wt": [
          { agent: "claude", source: "/a.jsonl", mode: "terminal" },
          { agent: "claude", source: "/b.jsonl", mode: "read" },
          { agent: "claude", source: "/c.jsonl", mode: "weird" },
          { agent: "claude", source: "/d.jsonl", mode: 42 },
        ],
      }),
    );
    expect(new OpenSessionsStore(m, KEY).load()).toEqual({
      "/wt": [
        { agent: "claude", source: "/a.jsonl", mode: "terminal" },
        // "read" isn't a valid stored value — absence means read.
        { agent: "claude", source: "/b.jsonl" },
        { agent: "claude", source: "/c.jsonl" },
        { agent: "claude", source: "/d.jsonl" },
      ],
    });
  });
});

describe("SessionSurfaceStore", () => {
  const KEY = "supergit:sessionSurfaces";

  test("persists last visual/terminal surface by stable session key", () => {
    const m = new MemStore();
    const store = new SessionSurfaceStore(m, KEY);
    store.save({
      "/agents/claude.jsonl": "terminal",
      "session:codex:thread-1": "read",
    });

    expect(new SessionSurfaceStore(m, KEY).load()).toEqual({
      "/agents/claude.jsonl": "terminal",
      "session:codex:thread-1": "read",
    });
  });

  test("ignores malformed keys and surface values", () => {
    const m = new MemStore();
    m.setItem(
      KEY,
      JSON.stringify({
        "/agents/ok.jsonl": "terminal",
        "/agents/bad.jsonl": "weird",
        "": "terminal",
      }),
    );

    expect(new SessionSurfaceStore(m, KEY).load()).toEqual({
      "/agents/ok.jsonl": "terminal",
    });
  });

  test("tolerates missing, corrupt, and unavailable storage", () => {
    expect(new SessionSurfaceStore(new MemStore(), KEY).load()).toEqual({});

    const corrupt = new MemStore();
    corrupt.setItem(KEY, "{nope");
    expect(new SessionSurfaceStore(corrupt, KEY).load()).toEqual({});

    const throwing = new SessionSurfaceStore(new ThrowingStore(), KEY);
    expect(throwing.load()).toEqual({});
    expect(() => throwing.save({ "/agents/x.jsonl": "terminal" })).not.toThrow();
  });

  test("sessionSurfaceKeys aliases transcript sources and provider session ids", () => {
    expect(
      sessionSurfaceKeys({
        agent: "codex",
        source: "__codex_app__:thread-1",
        transcriptSource: "/agents/codex-thread-1.jsonl",
        resumeSessionId: "thread-1",
      }),
    ).toEqual([
      "__codex_app__:thread-1",
      "/agents/codex-thread-1.jsonl",
      "session:codex:thread-1",
    ]);
  });

  test("sessionSurfaceKeys accepts picker sessionId as an alias", () => {
    expect(
      sessionSurfaceKeys({
        agent: "claude",
        source: "/agents/claude.jsonl",
        sessionId: "sid-1",
      }),
    ).toEqual(["/agents/claude.jsonl", "session:claude:sid-1"]);
  });

  test("sessionMatchesKnownKeys matches source, transcript source, and provider session id aliases", () => {
    const known = new Set([
      "/agents/claude-transcript.jsonl",
      "session:codex:sid-2",
    ]);

    expect(
      sessionMatchesKnownKeys(
        {
          agent: "claude",
          source: "__new__:claude:t_1",
          transcriptSource: "/agents/claude-transcript.jsonl",
          resumeSessionId: "sid-1",
        },
        known,
      ),
    ).toBe(true);
    expect(
      sessionMatchesKnownKeys(
        {
          agent: "codex",
          source: "__codex_app__:sid-2",
          resumeSessionId: "sid-2",
        },
        known,
      ),
    ).toBe(true);
    expect(
      sessionMatchesKnownKeys(
        {
          agent: "claude",
          source: "/agents/other.jsonl",
          resumeSessionId: "sid-3",
        },
        known,
      ),
    ).toBe(false);
  });

  test("defaultSessionSurface keeps transcripts terminal-style by default", () => {
    expect(defaultSessionSurface({ agent: "claude" })).toBe("terminal");
    expect(defaultSessionSurface({ agent: "codex" })).toBe("terminal");
    expect(defaultSessionSurface({ agent: "ollama" })).toBe("terminal");
    expect(defaultSessionSurface({ agent: "claude", mode: "terminal" })).toBe(
      "terminal",
    );
  });

  test("sessionSurfacePreference requires an explicit remembered choice before a session becomes visual", () => {
    expect(
      sessionSurfacePreference(
        {
          agent: "claude",
          source: "/agents/claude.jsonl",
          sessionId: "sid-1",
        },
        {},
      ),
    ).toBe("terminal");

    expect(
      sessionSurfacePreference(
        {
          agent: "codex",
          source: "/agents/codex.jsonl",
          sessionId: "sid-2",
        },
        {},
      ),
    ).toBe("terminal");

    expect(
      sessionSurfacePreference(
        {
          agent: "claude",
          source: "/agents/claude.jsonl",
          sessionId: "sid-1",
        },
        { "session:claude:sid-1": "read" },
      ),
    ).toBe("read");
  });

  test("applySessionSurfacePreference stamps a provider session id without spawning a terminal", () => {
    expect(
      applySessionSurfacePreference(
        {
          agent: "codex",
          source: "/agents/codex.jsonl",
          sessionId: "sid-1",
        },
        {},
      ),
    ).toEqual({
      agent: "codex",
      source: "/agents/codex.jsonl",
      sessionId: "sid-1",
      resumeSessionId: "sid-1",
    });
  });

  test("applySessionSurfacePreference does not turn remembered terminal transcript style into a live TUI", () => {
    expect(
      applySessionSurfacePreference(
        {
          agent: "claude",
          source: "/agents/claude.jsonl",
          sessionId: "sid-1",
        },
        { "session:claude:sid-1": "terminal" },
      ),
    ).toEqual({
      agent: "claude",
      source: "/agents/claude.jsonl",
      sessionId: "sid-1",
      resumeSessionId: "sid-1",
    });
  });

  test("applySessionSurfacePreference keeps transcript aliases from forcing Codex App live mode", () => {
    expect(
      applySessionSurfacePreference(
        {
          agent: "codex",
          source: "__codex_app__:thread-1",
          transcriptSource: "/agents/codex-thread-1.jsonl",
          resumeSessionId: "thread-1",
        },
        { "/agents/codex-thread-1.jsonl": "terminal" },
      ),
    ).toEqual({
      agent: "codex",
      source: "__codex_app__:thread-1",
      transcriptSource: "/agents/codex-thread-1.jsonl",
      resumeSessionId: "thread-1",
    });
  });

  test("applySessionSurfacePreference keeps explicit Codex App visual chat mode", () => {
    expect(
      applySessionSurfacePreference(
        {
          agent: "codex",
          source: codexAppSource("thread-1"),
          transcriptSource: "/agents/codex-thread-1.jsonl",
          resumeSessionId: "thread-1",
          mode: "terminal",
        },
        { "session:codex:thread-1": "read" },
      ),
    ).toEqual({
      agent: "codex",
      source: codexAppSource("thread-1"),
      transcriptSource: "/agents/codex-thread-1.jsonl",
      resumeSessionId: "thread-1",
    });
  });

  test("applySessionSurfacePreference keeps visual mode only when explicitly remembered", () => {
    expect(
      applySessionSurfacePreference(
        {
          agent: "claude",
          source: "/agents/claude.jsonl",
          resumeSessionId: "sid-1",
          mode: "terminal",
        },
        { "/agents/claude.jsonl": "read" },
      ),
    ).toEqual({
      agent: "claude",
      source: "/agents/claude.jsonl",
      resumeSessionId: "sid-1",
    });
  });

  test("applySessionSurfacePreference does not force terminal for non-resumable sessions", () => {
    expect(
      applySessionSurfacePreference(
        { agent: "ollama", source: "/ollama/chat.jsonl", mode: "terminal" },
        { "/ollama/chat.jsonl": "terminal" },
      ),
    ).toEqual({ agent: "ollama", source: "/ollama/chat.jsonl" });
  });

  test("reconcileOpenSessionsWithSurfacePreferences lets explicit read beat stale terminal mode", () => {
    expect(
      reconcileOpenSessionsWithSurfacePreferences(
        {
          "/wt": [
            {
              agent: "codex",
              source: "/agents/codex.jsonl",
              resumeSessionId: "sid-1",
              mode: "terminal",
              attachTermId: "t_dead",
            },
          ],
        },
        {
          "/agents/codex.jsonl": "read",
          "session:codex:sid-1": "read",
        },
      ),
    ).toEqual({
      "/wt": [
        {
          agent: "codex",
          source: "/agents/codex.jsonl",
          resumeSessionId: "sid-1",
        },
      ],
    });
  });
});

describe("reload-resume terminal-mode round-trip (the SessionView path)", () => {
  // Locks in the exact scenario the user reported: a Claude session is
  // open in TUI mode → reload → expectation is the TUI comes back, not
  // the read-only history view. The mechanism is purely persistence of
  // `mode = "terminal"` — SessionView reads `initialMode` and hydrates
  // straight into the TerminalView branch.
  test("Resume in terminal → reload → still in terminal mode", () => {
    const m = new MemStore();
    const KEY = "supergit:openSessions-resume-mode";
    const store = new OpenSessionsStore(m, KEY);

    // 1. User clicks an existing claude session from the agent strip;
    //    the column mounts in read mode (the default).
    let byWt: Record<string, PersistedSession[]> = {
      "/Users/me/wt/feature": [
        { agent: "claude", source: "/agents/claude-real.jsonl" },
      ],
    };
    store.save(byWt);

    // 2. User clicks "Resume in terminal"; SessionView fires
    //    onModeChange("terminal") and the parent persists.
    byWt = setSessionMode(
      byWt,
      "/Users/me/wt/feature",
      "/agents/claude-real.jsonl",
      "terminal",
    );
    store.save(byWt);

    // 3. Hard reload: fresh OpenSessionsStore reading the same storage.
    const reloaded = new OpenSessionsStore(m, KEY).load();
    const restored = reloaded["/Users/me/wt/feature"]![0]!;
    expect(restored.mode).toBe("terminal");

    // 4. App.svelte's render branch hands SessionView `initialMode =
    //    "terminal"` based on this field; SessionView mounts straight
    //    into the live `claude --resume <sid>` PTY.
    expect(restored.mode === "terminal" ? "terminal" : "read").toBe("terminal");
  });

  test("Dispose terminal → mode goes back to read → next reload starts in read", () => {
    const m = new MemStore();
    const KEY = "supergit:openSessions-dispose-mode";
    const store = new OpenSessionsStore(m, KEY);
    let byWt: Record<string, PersistedSession[]> = {
      "/wt": [{ agent: "claude", source: "/x.jsonl", mode: "terminal" }],
    };
    store.save(byWt);

    // Dispose flips mode → "read" (SessionView's disposeTerminal does
    // this) and onModeChange propagates → setSessionMode drops the field.
    byWt = setSessionMode(byWt, "/wt", "/x.jsonl", "read");
    store.save(byWt);

    const reloaded = new OpenSessionsStore(m, KEY).load();
    expect(reloaded["/wt"]![0]!.mode).toBeUndefined();
  });
});

describe("OpenSessionsStore + resumeSessionId round-trip", () => {
  const KEY = "supergit:openSessions-resume";

  test("persists resumeSessionId alongside agent/source", () => {
    // The core of the reload fix: after we stamp a sid on a __new__:
    // column, it must survive a page reload. Otherwise the next mount
    // is back to bare `claude` and the live conversation is lost.
    const m = new MemStore();
    const s = new OpenSessionsStore(m, KEY);
    s.save({
      "/wt": [
        {
          agent: "claude",
          source: "__new__:claude:t_abc",
          resumeSessionId: "real-claude-sid-123",
        },
      ],
    });
    expect(s.load()).toEqual({
      "/wt": [
        {
          agent: "claude",
          source: "__new__:claude:t_abc",
          resumeSessionId: "real-claude-sid-123",
        },
      ],
    });
  });

  test("persists native app transcriptSource separately from live source", () => {
    const m = new MemStore();
    const s = new OpenSessionsStore(m, KEY);
    s.save({
      "/wt": [
        {
          agent: "codex",
          source: codexAppSource("thread-123"),
          resumeSessionId: "thread-123",
          transcriptSource: "/Users/me/.codex/sessions/thread-123.jsonl",
        },
      ],
    });
    expect(s.load()).toEqual({
      "/wt": [
        {
          agent: "codex",
          source: codexAppSource("thread-123"),
          resumeSessionId: "thread-123",
          transcriptSource: "/Users/me/.codex/sessions/thread-123.jsonl",
        },
      ],
    });
  });

  test("treats a missing resumeSessionId as plain optional (no field on output)", () => {
    const m = new MemStore();
    const s = new OpenSessionsStore(m, KEY);
    s.save({
      "/wt": [{ agent: "claude", source: "__new__:claude:t_abc" }],
    });
    const loaded = s.load();
    expect(loaded).toEqual({
      "/wt": [{ agent: "claude", source: "__new__:claude:t_abc" }],
    });
    expect(loaded["/wt"]![0]!.resumeSessionId).toBeUndefined();
  });

  test("ignores garbage resumeSessionId values (must be a non-empty string)", () => {
    const m = new MemStore();
    m.setItem(
      KEY,
      JSON.stringify({
        "/wt": [
          {
            agent: "claude",
            source: "__new__:claude:t_a",
            resumeSessionId: "",
          },
          {
            agent: "claude",
            source: "__new__:claude:t_b",
            resumeSessionId: 42,
          },
          {
            agent: "claude",
            source: "__new__:claude:t_c",
            resumeSessionId: "valid",
          },
        ],
      }),
    );
    expect(new OpenSessionsStore(m, KEY).load()).toEqual({
      "/wt": [
        { agent: "claude", source: "__new__:claude:t_a" },
        { agent: "claude", source: "__new__:claude:t_b" },
        {
          agent: "claude",
          source: "__new__:claude:t_c",
          resumeSessionId: "valid",
        },
      ],
    });
  });
});

describe("reload-resume round-trip (stamp → persist → load → cmd)", () => {
  // Integration-shaped: walks the full lifecycle the App.svelte handler
  // will drive. Locks in the actual user-visible behaviour: after a
  // fake hard-reload, the cmd for the column resumes the conversation
  // instead of starting fresh.
  test("activity → stamp → save → load → cmdForOpenSession resumes", () => {
    const m = new MemStore();
    const KEY = "supergit:openSessions-reload";
    const store = new OpenSessionsStore(m, KEY);

    // 1. User opens a brand-new claude TUI. Inline `agent: "claude"`
    //    source is the synthetic `__new__:` (mirrors openNewAgentSession
    //    in App.svelte).
    let byWt: Record<string, PersistedSession[]> = {
      "/Users/me/wt/feature": [
        { agent: "claude", source: "__new__:claude:t_xyz" },
      ],
    };
    store.save(byWt);

    // 2. Activity tail emits the first JSONL line — that's our cue that
    //    claude has minted a session id for this column.
    byWt = stampDiscoveredSessionId(byWt, {
      agent: "claude",
      cwd: "/Users/me/wt/feature",
      sessionId: "claude-sid-abcdef",
    });
    store.save(byWt);

    // 3. Hard reload: new browser tab, fresh OpenSessionsStore instance
    //    reads from the same localStorage.
    const reloaded = new OpenSessionsStore(m, KEY).load();
    const restoredCol = reloaded["/Users/me/wt/feature"]![0]!;
    expect(restoredCol.resumeSessionId).toBe("claude-sid-abcdef");

    // 4. The cmd handed to TerminalView on remount resumes the conversation.
    expect(cmdForOpenSession(restoredCol, "/bin/zsh")).toEqual([
      "claude",
      "--resume",
      "claude-sid-abcdef",
      "--allow-dangerously-skip-permissions",
    ]);
  });

  test("without the stamp step (reload before any activity), cmd falls back to bare `claude`", () => {
    // Locks in the no-regression: if the activity tail never got a
    // chance to fire (very fast reload), we still spawn bare claude
    // and the user sees the same behaviour as today — not worse.
    const m = new MemStore();
    const KEY = "supergit:openSessions-reload-fast";
    new OpenSessionsStore(m, KEY).save({
      "/Users/me/wt/feature": [
        { agent: "claude", source: "__new__:claude:t_xyz" },
      ],
    });
    const reloaded = new OpenSessionsStore(m, KEY).load();
    expect(
      cmdForOpenSession(reloaded["/Users/me/wt/feature"]![0]!, "/bin/zsh"),
    ).toEqual(["claude"]);
  });
});

describe("effectiveVisibleWorktrees", () => {
  test("returns [] when the repo has no worktrees on disk", () => {
    expect(effectiveVisibleWorktrees("rA", [], { rA: ["/anything"] })).toEqual(
      [],
    );
  });

  test("with no stored entry, defaults to the first worktree on disk only", () => {
    // This is THE rule for new repos: adding a repo to supergit shows
    // only its main worktree by default; further worktrees must be
    // explicitly enabled via the picker.
    expect(
      effectiveVisibleWorktrees(
        "rA",
        ["/repos/A", "/wt/A/feature", "/wt/A/other"],
        {},
      ),
    ).toEqual(["/repos/A"]);
  });

  test("respects an explicit stored list", () => {
    expect(
      effectiveVisibleWorktrees(
        "rA",
        ["/repos/A", "/wt/A/feature", "/wt/A/other"],
        { rA: ["/wt/A/feature"] },
      ),
    ).toEqual(["/wt/A/feature"]);
  });

  test("orders visible worktrees by git's current disk order, not stored order", () => {
    expect(
      effectiveVisibleWorktrees(
        "rA",
        ["/repos/A", "/wt/A/feature", "/wt/A/other"],
        { rA: ["/wt/A/other", "/repos/A", "/wt/A/feature"] },
      ),
    ).toEqual(["/repos/A", "/wt/A/feature", "/wt/A/other"]);
  });

  test("an explicit empty list keeps the repo hidden — does NOT fall back to first wt", () => {
    expect(
      effectiveVisibleWorktrees("rA", ["/repos/A", "/wt/A/feature"], {
        rA: [],
      }),
    ).toEqual([]);
  });

  test("filters out stored paths whose worktree no longer exists on disk", () => {
    expect(
      effectiveVisibleWorktrees("rA", ["/repos/A"], {
        rA: ["/wt/A/feature-deleted", "/repos/A"],
      }),
    ).toEqual(["/repos/A"]);
  });
});

describe("visible worktree mutations", () => {
  const disk = ["/repos/A", "/wt/A/feature", "/wt/A/other"];

  test("showVisibleWorktree reveals a new path after the originating worktree", () => {
    expect(
      showVisibleWorktree("rA", disk, {}, "/wt/A/feature", "/repos/A"),
    ).toEqual({ rA: ["/repos/A", "/wt/A/feature"] });
  });

  test("showVisibleWorktree appends when the origin is not visible", () => {
    expect(
      showVisibleWorktree(
        "rA",
        disk,
        { rA: ["/repos/A"] },
        "/wt/A/other",
        "/wt/A/feature",
      ),
    ).toEqual({ rA: ["/repos/A", "/wt/A/other"] });
  });

  test("hideVisibleWorktree keeps an explicit empty list instead of falling back", () => {
    expect(hideVisibleWorktree("rA", disk, {}, "/repos/A")).toEqual({
      rA: [],
    });
  });

  test("toggleVisibleWorktree hides visible paths and shows hidden paths", () => {
    expect(toggleVisibleWorktree("rA", disk, {}, "/repos/A")).toEqual({
      rA: [],
    });
    expect(toggleVisibleWorktree("rA", disk, {}, "/wt/A/feature")).toEqual({
      rA: ["/repos/A", "/wt/A/feature"],
    });
  });
});

describe("CommandUrlPickStore", () => {
  const PICK_KEY = "supergit:commandUrlPicks";

  test("returns empty map when nothing is stored", () => {
    const s = new CommandUrlPickStore(new MemStore(), PICK_KEY);
    expect(s.load()).toEqual({});
  });

  test("set then load round-trips the pick", () => {
    const m = new MemStore();
    const s = new CommandUrlPickStore(m, PICK_KEY);
    s.set("link-1", "http://localhost:7779");
    expect(s.load()).toEqual({ "link-1": "http://localhost:7779" });
  });

  test("the pick survives across instances pointing at the same storage", () => {
    // This is the bug: the pick must outlive the daemon run / terminal
    // session that surfaced the URLs. Two store instances over the same
    // backing storage stand in for "before reload" and "after reload".
    const m = new MemStore();
    new CommandUrlPickStore(m, PICK_KEY).set(
      "link-1",
      "http://192.168.0.174:7779",
    );
    const reopened = new CommandUrlPickStore(m, PICK_KEY);
    expect(reopened.load()["link-1"]).toBe("http://192.168.0.174:7779");
  });

  test("set updates one link's pick without clobbering the others", () => {
    const m = new MemStore();
    const s = new CommandUrlPickStore(m, PICK_KEY);
    s.set("link-1", "http://localhost:7779");
    s.set("link-2", "http://localhost:5173");
    s.set("link-1", "http://localhost:3000"); // re-pick link-1
    expect(s.load()).toEqual({
      "link-1": "http://localhost:3000",
      "link-2": "http://localhost:5173",
    });
  });

  test("returns empty map when stored value is not JSON", () => {
    const m = new MemStore();
    m.setItem(PICK_KEY, "{not json");
    expect(new CommandUrlPickStore(m, PICK_KEY).load()).toEqual({});
  });

  test("returns empty map when stored value is an array", () => {
    const m = new MemStore();
    m.setItem(PICK_KEY, JSON.stringify(["a", "b"]));
    expect(new CommandUrlPickStore(m, PICK_KEY).load()).toEqual({});
  });

  test("drops non-string values from the stored map", () => {
    const m = new MemStore();
    m.setItem(
      PICK_KEY,
      JSON.stringify({ a: "http://x", b: 1, c: null, d: { x: 1 } }),
    );
    expect(new CommandUrlPickStore(m, PICK_KEY).load()).toEqual({
      a: "http://x",
    });
  });

  test("swallows storage errors on set", () => {
    const s = new CommandUrlPickStore(new ThrowingStore(), PICK_KEY);
    // Should not throw.
    s.set("link-1", "http://localhost:7779");
  });

  test("returns empty map when storage throws on read", () => {
    const s = new CommandUrlPickStore(new ThrowingStore(), PICK_KEY);
    expect(s.load()).toEqual({});
  });
});

describe("CommandTermStore", () => {
  const KEY = "supergit:commandTermSources";

  test("returns empty map when nothing is stored", () => {
    expect(new CommandTermStore(new MemStore(), KEY).load()).toEqual({});
  });

  test("set then load round-trips the entry", () => {
    const m = new MemStore();
    const s = new CommandTermStore(m, KEY);
    s.set("link-1", {
      wtPath: "/repo/foo",
      source: "__attached__:shell:t-123",
    });
    expect(s.load()).toEqual({
      "link-1": { wtPath: "/repo/foo", source: "__attached__:shell:t-123" },
    });
  });

  test("the mapping survives across instances pointing at the same storage", () => {
    // The regression this guards: after a page reload, the in-memory
    // commandTermSources Map is gone — clicking a still-running command
    // chip spawns a NEW PTY instead of focusing the existing column.
    // The store must outlive a single page load so the reuse path can
    // still find prev.
    const m = new MemStore();
    new CommandTermStore(m, KEY).set("npm-start", {
      wtPath: "/repo/foo",
      source: "__attached__:shell:t-xyz",
    });
    const reopened = new CommandTermStore(m, KEY);
    expect(reopened.load()["npm-start"]).toEqual({
      wtPath: "/repo/foo",
      source: "__attached__:shell:t-xyz",
    });
  });

  test("delete removes a single entry", () => {
    const m = new MemStore();
    const s = new CommandTermStore(m, KEY);
    s.set("a", { wtPath: "/r", source: "__attached__:shell:t-a" });
    s.set("b", { wtPath: "/r", source: "__attached__:shell:t-b" });
    s.delete("a");
    expect(s.load()).toEqual({
      b: { wtPath: "/r", source: "__attached__:shell:t-b" },
    });
  });

  test("save persists the full map (replace, not merge)", () => {
    const m = new MemStore();
    const s = new CommandTermStore(m, KEY);
    s.set("a", { wtPath: "/r", source: "__attached__:shell:t-a" });
    s.save({ b: { wtPath: "/r2", source: "__attached__:shell:t-b" } });
    expect(s.load()).toEqual({
      b: { wtPath: "/r2", source: "__attached__:shell:t-b" },
    });
  });

  test("drops entries with missing or invalid fields", () => {
    const m = new MemStore();
    m.setItem(
      KEY,
      JSON.stringify({
        good: { wtPath: "/r", source: "__attached__:shell:t-a" },
        noWt: { source: "__attached__:shell:t-b" },
        noSource: { wtPath: "/r" },
        bothEmpty: { wtPath: "", source: "" },
        notObject: "string",
        nullVal: null,
      }),
    );
    expect(new CommandTermStore(m, KEY).load()).toEqual({
      good: { wtPath: "/r", source: "__attached__:shell:t-a" },
    });
  });

  test("returns empty map when stored value is not JSON", () => {
    const m = new MemStore();
    m.setItem(KEY, "{not json");
    expect(new CommandTermStore(m, KEY).load()).toEqual({});
  });

  test("returns empty map when stored value is an array", () => {
    const m = new MemStore();
    m.setItem(KEY, JSON.stringify(["a", "b"]));
    expect(new CommandTermStore(m, KEY).load()).toEqual({});
  });

  test("returns empty map when storage throws on read", () => {
    expect(new CommandTermStore(new ThrowingStore(), KEY).load()).toEqual({});
  });

  test("swallows storage errors on set", () => {
    new CommandTermStore(new ThrowingStore(), KEY).set("a", {
      wtPath: "/r",
      source: "__attached__:shell:t",
    });
  });
});
