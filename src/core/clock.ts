/** 時刻とID生成を差し替え可能にする。テストを決定的にするため。 */

export interface Clock {
  now(): number;
}

export const systemClock: Clock = {
  now: () => Date.now(),
};

/** テスト用。時間を明示的に進める。 */
export class FakeClock implements Clock {
  #t: number;

  constructor(start = 1_700_000_000_000) {
    this.#t = start;
  }

  now(): number {
    return this.#t;
  }

  advance(ms: number): void {
    this.#t += ms;
  }
}

export interface IdGen {
  uuid(): string;
}

export const systemIdGen: IdGen = {
  uuid: () => crypto.randomUUID(),
};

/** テスト用。連番の UUID 風文字列を返す。 */
export class SeqIdGen implements IdGen {
  #n = 0;

  uuid(): string {
    this.#n += 1;
    const h = this.#n.toString(16).padStart(12, '0');
    return `00000000-0000-4000-8000-${h}`;
  }
}

/** 決定的な擬似乱数。ペルソナ生成をテスト可能にする。 */
export class Rng {
  #s: number;

  constructor(seed = 1) {
    this.#s = seed >>> 0 || 1;
  }

  /** xorshift32 */
  next(): number {
    let x = this.#s;
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    this.#s = x >>> 0;
    return this.#s / 0x1_0000_0000;
  }

  pick<T>(items: readonly T[]): T {
    if (items.length === 0) throw new Error('pick from empty array');
    return items[Math.floor(this.next() * items.length)]!;
  }
}
