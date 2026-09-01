/**
 * このマシンとダッシュボード自身の負荷（SPEC §16.4）。
 *
 * CPU 使用率は「今この瞬間の値」が取れないので、2 回のサンプルの差から出す。
 * 最初の 1 回は差が取れないため null を返す。
 *
 * システム全体を見るのは、重いのが子プロセス（claude / codex 本体）だから。
 * 自分の常駐メモリだけ見ても、実際に食っている量は分からない。
 */

import { cpus, freemem, totalmem } from 'node:os';

export interface ResourceSample {
  /** ダッシュボード自身の常駐メモリ（バイト） */
  rss: number;
  /** システム全体のメモリ使用率 0..1 */
  memoryRatio: number;
  /** システム全体の CPU 使用率 0..1。最初のサンプルでは null */
  cpuRatio: number | null;
}

interface CpuTotals {
  idle: number;
  total: number;
}

function cpuTotals(): CpuTotals | null {
  const list = cpus();
  // 環境によっては空配列が返る（コンテナなど）。その場合 CPU は諦める。
  if (list.length === 0) return null;

  let idle = 0;
  let total = 0;
  for (const cpu of list) {
    idle += cpu.times.idle;
    total += cpu.times.user + cpu.times.nice + cpu.times.sys + cpu.times.idle + cpu.times.irq;
  }
  return { idle, total };
}

export class ResourceMonitor {
  #prev: CpuTotals | null = null;
  #rssOf: () => number;

  constructor(rssOf: () => number = () => process.memoryUsage.rss()) {
    this.#rssOf = rssOf;
  }

  sample(): ResourceSample {
    const total = totalmem();
    const memoryRatio = total > 0 ? (total - freemem()) / total : 0;

    const now = cpuTotals();
    let cpuRatio: number | null = null;

    if (now && this.#prev) {
      const dTotal = now.total - this.#prev.total;
      const dIdle = now.idle - this.#prev.idle;
      // 時計が動いていない、あるいは巻き戻った。次の周回に任せる。
      if (dTotal > 0) cpuRatio = clamp01((dTotal - dIdle) / dTotal);
    }
    if (now) this.#prev = now;

    return { rss: this.#rssOf(), memoryRatio, cpuRatio };
  }
}

function clamp01(n: number): number {
  if (Number.isNaN(n)) return 0;
  return Math.min(1, Math.max(0, n));
}

/** 159012 → '155M'。桁を増やさず、ひと目で大きさが分かる程度に。 */
export function formatBytes(bytes: number): string {
  const mb = bytes / 1024 / 1024;
  if (mb >= 1024) return `${(mb / 1024).toFixed(1)}G`;
  return `${Math.round(mb)}M`;
}
