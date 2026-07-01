export interface TerminalInfo {
  id: string;
  pid: number;
  isAlive: boolean;
}

export interface OrphanCleanerOptions {
  orphanTimeoutMs?: number;
  killGraceMs?: number;
  getTerminals: () => TerminalInfo[];
  killTerminal: (id: string) => Promise<void>;
  log: (message: string) => void;
}

const DEFAULT_ORPHAN_TIMEOUT = 5 * 60 * 1000;
const DEFAULT_KILL_GRACE = 10_000;

export class OrphanCleaner {
  private frontendCount = 0;
  private orphanTimer: ReturnType<typeof setTimeout> | null = null;
  private lastDisconnectAt: number | null = null;
  private orphanTimeoutMs: number;
  private killGraceMs: number;
  private getTerminals: () => TerminalInfo[];
  private killTerminal: (id: string) => Promise<void>;
  private log: (message: string) => void;

  constructor(opts: OrphanCleanerOptions) {
    this.orphanTimeoutMs = opts.orphanTimeoutMs ?? DEFAULT_ORPHAN_TIMEOUT;
    this.killGraceMs = opts.killGraceMs ?? DEFAULT_KILL_GRACE;
    this.getTerminals = opts.getTerminals;
    this.killTerminal = opts.killTerminal;
    this.log = opts.log;
  }

  /** True while at least one frontend is connected — the app's SSE stream
   *  and/or any terminal WS. The per-terminal grace-reaper consults this so a
   *  live agent is never reaped while the app is still open: a column scrolled
   *  off-screen (or a reload) drops its terminal WS, but the SSE stream keeps
   *  this true across that churn. When it finally goes false (no frontend at
   *  all), the orphan timer below owns cleanup. */
  isFrontendConnected(): boolean {
    return this.frontendCount > 0;
  }

  onFrontendConnected(): void {
    this.frontendCount++;
    if (this.orphanTimer) {
      clearTimeout(this.orphanTimer);
      this.orphanTimer = null;
      this.log("orphan cleanup: frontend reconnected, cancelled cleanup timer");
    }
    this.lastDisconnectAt = null;
  }

  onFrontendDisconnected(): void {
    this.frontendCount = Math.max(0, this.frontendCount - 1);
    if (this.frontendCount > 0) return;

    this.lastDisconnectAt = Date.now();
    if (this.orphanTimer) return;

    this.log(
      `orphan cleanup: no frontend connected, will kill all terminals in ${Math.round(this.orphanTimeoutMs / 1000)}s`,
    );
    this.orphanTimer = setTimeout(() => {
      this.orphanTimer = null;
      void this.doCleanup();
    }, this.orphanTimeoutMs);
  }

  dispose(): void {
    if (this.orphanTimer) {
      clearTimeout(this.orphanTimer);
      this.orphanTimer = null;
    }
  }

  private async doCleanup(): Promise<void> {
    const orphanedFor = this.lastDisconnectAt
      ? Math.round((Date.now() - this.lastDisconnectAt) / 1000)
      : "?";
    const terminals = this.getTerminals();
    const alive = terminals.filter((t) => t.isAlive);

    if (alive.length === 0) {
      this.log(
        `orphan cleanup: no live terminals to clean up (orphaned ${orphanedFor}s)`,
      );
      return;
    }

    this.log(
      `orphan cleanup: killing ${alive.length} terminal(s) after ${orphanedFor}s with no frontend`,
    );

    for (const t of alive) {
      this.log(`orphan cleanup: SIGTERM ${t.id} (pid ${t.pid})`);
      try {
        await this.killTerminal(t.id);
        this.log(`orphan cleanup: ${t.id} (pid ${t.pid}) terminated`);
      } catch (err) {
        this.log(
          `orphan cleanup: ${t.id} (pid ${t.pid}) kill failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }
}
