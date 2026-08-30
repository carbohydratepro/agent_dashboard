/**
 * 使用量の定期取得。
 *
 * claude は CLI を 1 回起こす（モデル呼び出しは無いので課金されない）。
 * codex はファイルを読むだけ。どちらも軽いが、無闇に叩かないよう
 * 最短間隔を設けてある。
 */

import type { AgentKind } from './types.ts';
import type { StateStore } from './store.ts';
import type { UsageProbe, UsageSnapshot } from './usage.ts';

export interface UsageMonitorOptions {
  probes: UsageProbe[];
  store?: StateStore;
  /** 定期取得の間隔 */
  intervalMs?: number;
  /** これより短い間隔では取り直さない（ターン完了のたびに叩かないため） */
  minIntervalMs?: number;
  now?: () => number;
}

export class UsageMonitor {
  #probes: Map<AgentKind, UsageProbe>;
  #store: StateStore | undefined;
  #intervalMs: number;
  #minIntervalMs: number;
  #now: () => number;

  #snapshots = new Map<AgentKind, UsageSnapshot>();
  #lastFetchAt = new Map<AgentKind, number>();
  #inFlight = new Map<AgentKind, Promise<void>>();
  #timer: NodeJS.Timeout | null = null;

  constructor(opts: UsageMonitorOptions) {
    this.#probes = new Map(opts.probes.map((p) => [p.kind, p]));
    this.#store = opts.store;
    this.#intervalMs = opts.intervalMs ?? 5 * 60_000;
    this.#minIntervalMs = opts.minIntervalMs ?? 30_000;
    this.#now = opts.now ?? (() => Date.now());
  }

  get kinds(): AgentKind[] {
    return [...this.#probes.keys()];
  }

  snapshot(kind: AgentKind): UsageSnapshot | null {
    return this.#snapshots.get(kind) ?? null;
  }

  /** 取得する。最短間隔より短ければ何もしない（force で無視）。 */
  async refresh(kind?: AgentKind, opts: { force?: boolean } = {}): Promise<void> {
    const targets = kind ? [kind] : this.kinds;
    await Promise.all(targets.map((k) => this.#refreshOne(k, opts.force ?? false)));
  }

  async #refreshOne(kind: AgentKind, force: boolean): Promise<void> {
    const probe = this.#probes.get(kind);
    if (!probe) return;

    const running = this.#inFlight.get(kind);
    if (running) return running;

    const last = this.#lastFetchAt.get(kind) ?? 0;
    if (!force && this.#now() - last < this.#minIntervalMs) return;

    const task = (async () => {
      const snapshot = await probe.fetch();
      this.#snapshots.set(kind, snapshot);
      this.#lastFetchAt.set(kind, this.#now());
      this.#store?.emit({ t: 'usage_updated', kind });
    })().finally(() => {
      this.#inFlight.delete(kind);
    });

    this.#inFlight.set(kind, task);
    return task;
  }

  start(): void {
    if (this.#timer) return;
    void this.refresh(undefined, { force: true });
    this.#timer = setInterval(() => {
      void this.refresh(undefined, { force: true });
    }, this.#intervalMs);
    this.#timer.unref?.();
  }

  stop(): void {
    if (!this.#timer) return;
    clearInterval(this.#timer);
    this.#timer = null;
  }
}
