/**
 * ネットワーク変更の検知（SPEC §10.2）。
 *
 * 外部への通信は行わない。os.networkInterfaces() の指紋をポーリングするだけ。
 * WiFi 切替は途中で複数の中間状態を通るので、指紋が一定時間安定してから
 * 「変わった」と判定する。
 *
 * テストしやすいよう、自分でタイマーを回さず tick() で駆動できるようにしてある。
 * start() を呼ぶと内部で setInterval が tick() を叩く。
 */

import { createHash } from 'node:crypto';
import { networkInterfaces } from 'node:os';
import { EventEmitter } from 'node:events';

import type { Clock } from './clock.ts';
import { systemClock } from './clock.ts';

export type NetworkEvent =
  | { t: 'network_changed'; from: string; to: string; cause: 'stable' | 'sleep' | 'manual' }
  | { t: 'network_lost' }
  | { t: 'network_restored' };

/** os.networkInterfaces() が返す形のうち、指紋に使う部分だけ */
export interface IfaceInfo {
  address: string;
  family: string | number;
  mac: string;
  internal: boolean;
}

export type ReadInterfaces = () => Record<string, IfaceInfo[] | undefined>;

export interface NetworkMonitorOptions {
  pollIntervalMs?: number;
  /** この時間だけ指紋が安定してから変更と判定する */
  stabilizeMs?: number;
  /** 前回 tick からこれ以上空いていたらスリープとみなし、安定判定を飛ばす */
  sleepDetectThresholdMs?: number;
  clock?: Clock;
  readInterfaces?: ReadInterfaces;
}

export interface Snapshot {
  fingerprint: string;
  online: boolean;
}

/** ループバックを除いた実インターフェースから指紋を作る */
export function snapshotOf(read: ReadInterfaces): Snapshot {
  const parts: string[] = [];
  for (const [name, list] of Object.entries(read())) {
    for (const i of list ?? []) {
      if (i.internal) continue;
      parts.push(`${name}:${i.family}:${i.address}:${i.mac}`);
    }
  }
  parts.sort();
  return {
    online: parts.length > 0,
    fingerprint: createHash('sha1').update(parts.join('|')).digest('hex').slice(0, 16),
  };
}

export class NetworkMonitor {
  #pollIntervalMs: number;
  #stabilizeMs: number;
  #sleepThresholdMs: number;
  #clock: Clock;
  #read: ReadInterfaces;
  #emitter = new EventEmitter();

  #current: string;
  #online: boolean;
  #pending: { fingerprint: string; since: number } | null = null;
  #lastTickAt: number;
  #timer: NodeJS.Timeout | null = null;

  constructor(opts: NetworkMonitorOptions = {}) {
    this.#pollIntervalMs = opts.pollIntervalMs ?? 5_000;
    this.#stabilizeMs = opts.stabilizeMs ?? 3_000;
    this.#sleepThresholdMs = opts.sleepDetectThresholdMs ?? 60_000;
    this.#clock = opts.clock ?? systemClock;
    this.#read = opts.readInterfaces ?? (networkInterfaces as ReadInterfaces);
    this.#emitter.setMaxListeners(0);

    const snap = snapshotOf(this.#read);
    this.#current = snap.fingerprint;
    this.#online = snap.online;
    this.#lastTickAt = this.#clock.now();
  }

  get fingerprint(): string {
    return this.#current;
  }

  get online(): boolean {
    return this.#online;
  }

  /** 変更判定の途中かどうか。復帰処理は安定するまで待つ（SPEC §10.3） */
  get settling(): boolean {
    return this.#pending !== null;
  }

  on(listener: (e: NetworkEvent) => void): () => void {
    this.#emitter.on('event', listener);
    return () => this.#emitter.off('event', listener);
  }

  start(): void {
    if (this.#timer) return;
    this.#timer = setInterval(() => this.tick(), this.#pollIntervalMs);
    this.#timer.unref?.();
  }

  stop(): void {
    if (!this.#timer) return;
    clearInterval(this.#timer);
    this.#timer = null;
  }

  /** 1 回分の評価。テストはこれを直接呼ぶ。 */
  tick(): void {
    const now = this.#clock.now();
    const gap = now - this.#lastTickAt;
    this.#lastTickAt = now;

    // ポーリング間隔よりずっと空いていたらマシンが寝ていた。安定判定を飛ばす。
    const slept = gap >= this.#sleepThresholdMs;
    this.#evaluate(snapshotOf(this.#read), now, slept ? 'sleep' : 'stable');
  }

  /** 手動再接続（R キー）。安定判定を飛ばして即座に判定する。 */
  refresh(): void {
    this.#lastTickAt = this.#clock.now();
    this.#evaluate(snapshotOf(this.#read), this.#clock.now(), 'manual');
  }

  #evaluate(snap: Snapshot, now: number, cause: 'stable' | 'sleep' | 'manual'): void {
    if (!snap.online) {
      // オフライン中は指紋を作成しない。戻ってきたときに前の状態と比べたいので。
      this.#pending = null;
      if (this.#online) {
        this.#online = false;
        this.#emitter.emit('event', { t: 'network_lost' } satisfies NetworkEvent);
      }
      return;
    }

    if (!this.#online) {
      this.#online = true;
      this.#emitter.emit('event', { t: 'network_restored' } satisfies NetworkEvent);
    }

    if (snap.fingerprint === this.#current) {
      this.#pending = null;
      return;
    }

    if (cause !== 'stable') {
      this.#commit(snap.fingerprint, cause);
      return;
    }

    if (!this.#pending || this.#pending.fingerprint !== snap.fingerprint) {
      // 中間状態かもしれない。安定するか様子を見る。
      this.#pending = { fingerprint: snap.fingerprint, since: now };
      return;
    }

    if (now - this.#pending.since >= this.#stabilizeMs) {
      this.#commit(snap.fingerprint, 'stable');
    }
  }

  #commit(fingerprint: string, cause: 'stable' | 'sleep' | 'manual'): void {
    const from = this.#current;
    this.#current = fingerprint;
    this.#pending = null;
    this.#emitter.emit('event', {
      t: 'network_changed',
      from,
      to: fingerprint,
      cause,
    } satisfies NetworkEvent);
  }
}
