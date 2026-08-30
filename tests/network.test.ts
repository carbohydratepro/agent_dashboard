/**
 * ネットワーク検知（SPEC §10.2）のテスト。
 * os.networkInterfaces() を差し替え、tick() を手で回して決定的に検証する。
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { NetworkMonitor, snapshotOf } from '../src/core/network.ts';
import type { IfaceInfo, NetworkEvent } from '../src/core/network.ts';
import { FakeClock } from '../src/core/clock.ts';

function iface(address: string, mac = 'aa:bb:cc:dd:ee:ff'): IfaceInfo {
  return { address, family: 'IPv4', mac, internal: false };
}

const LOOPBACK: IfaceInfo = {
  address: '127.0.0.1',
  family: 'IPv4',
  mac: '00:00:00:00:00:00',
  internal: true,
};

/** 差し替え可能なインターフェース表 */
function fakeNet(initial: Record<string, IfaceInfo[] | undefined>) {
  let current = initial;
  return {
    read: () => current,
    set(next: Record<string, IfaceInfo[] | undefined>) {
      current = next;
    },
  };
}

interface Harness {
  monitor: NetworkMonitor;
  clock: FakeClock;
  events: NetworkEvent[];
  net: ReturnType<typeof fakeNet>;
}

function harness(
  initial: Record<string, IfaceInfo[] | undefined> = { wlan0: [iface('192.168.1.10')] },
  opts: { stabilizeMs?: number; sleepDetectThresholdMs?: number } = {},
): Harness {
  const clock = new FakeClock();
  const net = fakeNet(initial);
  const monitor = new NetworkMonitor({
    clock,
    readInterfaces: net.read,
    stabilizeMs: opts.stabilizeMs ?? 3_000,
    sleepDetectThresholdMs: opts.sleepDetectThresholdMs ?? 60_000,
  });
  const events: NetworkEvent[] = [];
  monitor.on((e) => events.push(e));
  return { monitor, clock, events, net };
}

// ---------------------------------------------------------------------------

describe('指紋', () => {
  test('ループバックは無視する', () => {
    const a = snapshotOf(() => ({ lo: [LOOPBACK], wlan0: [iface('192.168.1.10')] }));
    const b = snapshotOf(() => ({ wlan0: [iface('192.168.1.10')] }));
    assert.equal(a.fingerprint, b.fingerprint);
  });

  test('実インターフェースが無ければオフライン', () => {
    assert.equal(snapshotOf(() => ({ lo: [LOOPBACK] })).online, false);
    assert.equal(snapshotOf(() => ({})).online, false);
  });

  test('列挙順が変わっても同じ指紋になる', () => {
    const a = snapshotOf(() => ({ eth0: [iface('10.0.0.1')], wlan0: [iface('192.168.1.10')] }));
    const b = snapshotOf(() => ({ wlan0: [iface('192.168.1.10')], eth0: [iface('10.0.0.1')] }));
    assert.equal(a.fingerprint, b.fingerprint);
  });

  test('アドレスが変われば指紋も変わる', () => {
    const a = snapshotOf(() => ({ wlan0: [iface('192.168.1.10')] }));
    const b = snapshotOf(() => ({ wlan0: [iface('192.168.1.11')] }));
    assert.notEqual(a.fingerprint, b.fingerprint);
  });
});

describe('安定判定（デバウンス）', () => {
  test('変化しなければ何も起きない', () => {
    const h = harness();
    for (let i = 0; i < 5; i += 1) {
      h.clock.advance(5_000);
      h.monitor.tick();
    }
    assert.equal(h.events.length, 0);
  });

  test('安定するまで変更と判定しない', () => {
    const h = harness();
    h.net.set({ wlan0: [iface('10.0.0.5')] });

    h.clock.advance(5_000);
    h.monitor.tick();
    assert.equal(h.events.length, 0, '1 回目は様子見');
    assert.equal(h.monitor.settling, true);

    h.clock.advance(1_000);
    h.monitor.tick();
    assert.equal(h.events.length, 0, 'まだ 1 秒しか経っていない');

    h.clock.advance(3_000);
    h.monitor.tick();
    assert.equal(h.events.length, 1);
    assert.equal(h.events[0]!.t, 'network_changed');
    assert.equal(h.monitor.settling, false);
  });

  test('中間状態を通っても、落ち着いた先だけを 1 回報告する', () => {
    const h = harness();

    // WiFi 切替の途中: いったん別アドレス → すぐまた別アドレス
    h.net.set({ wlan0: [iface('169.254.0.1')] });
    h.clock.advance(1_000);
    h.monitor.tick();

    h.net.set({ wlan0: [iface('10.0.0.5')] });
    h.clock.advance(1_000);
    h.monitor.tick();
    assert.equal(h.events.length, 0, '指紋が変わり続けている間は待つ');

    h.clock.advance(3_000);
    h.monitor.tick();
    assert.equal(h.events.length, 1, '最終的な状態だけを 1 回報告する');
  });

  test('元の状態に戻ったら報告しない', () => {
    const h = harness();
    const original = h.monitor.fingerprint;

    h.net.set({ wlan0: [iface('10.0.0.5')] });
    h.clock.advance(1_000);
    h.monitor.tick();

    h.net.set({ wlan0: [iface('192.168.1.10')] });
    h.clock.advance(5_000);
    h.monitor.tick();

    assert.equal(h.events.length, 0);
    assert.equal(h.monitor.fingerprint, original);
  });
});

describe('オフラインと復帰', () => {
  test('インターフェースが消えたら lost、戻ったら restored', () => {
    const h = harness();

    h.net.set({ lo: [LOOPBACK] });
    h.clock.advance(5_000);
    h.monitor.tick();
    assert.deepEqual(h.events.map((e) => e.t), ['network_lost']);
    assert.equal(h.monitor.online, false);

    h.net.set({ wlan0: [iface('192.168.1.10')] });
    h.clock.advance(5_000);
    h.monitor.tick();
    assert.deepEqual(h.events.map((e) => e.t), ['network_lost', 'network_restored']);
    assert.equal(h.monitor.online, true);
  });

  test('lost は繰り返さない', () => {
    const h = harness();
    h.net.set({});
    for (let i = 0; i < 3; i += 1) {
      h.clock.advance(5_000);
      h.monitor.tick();
    }
    assert.equal(h.events.filter((e) => e.t === 'network_lost').length, 1);
  });

  test('別のネットワークに繋ぎ直したら restored のあと changed も出る', () => {
    const h = harness();

    h.net.set({});
    h.clock.advance(5_000);
    h.monitor.tick();

    h.net.set({ wlan0: [iface('10.0.0.5')] });
    h.clock.advance(5_000);
    h.monitor.tick();
    h.clock.advance(5_000);
    h.monitor.tick();

    assert.deepEqual(
      h.events.map((e) => e.t),
      ['network_lost', 'network_restored', 'network_changed'],
    );
  });
});

describe('スリープ復帰と手動再接続', () => {
  test('時計が飛んでいたら安定判定を飛ばして即座に報告する', () => {
    const h = harness();
    h.net.set({ wlan0: [iface('10.0.0.5')] });

    // 5 秒間隔のはずが 10 分空いた = マシンが寝ていた
    h.clock.advance(10 * 60 * 1000);
    h.monitor.tick();

    assert.equal(h.events.length, 1);
    const e = h.events[0]!;
    assert.equal(e.t, 'network_changed');
    assert.equal(e.cause, 'sleep');
  });

  test('手動再接続も安定判定を飛ばす', () => {
    const h = harness();
    h.net.set({ wlan0: [iface('10.0.0.5')] });

    h.monitor.refresh();

    assert.equal(h.events.length, 1);
    const e = h.events[0]!;
    assert.equal(e.t, 'network_changed');
    assert.equal(e.cause, 'manual');
  });

  test('変わっていなければ手動再接続でも何も起きない', () => {
    const h = harness();
    h.monitor.refresh();
    assert.equal(h.events.length, 0);
  });
});
