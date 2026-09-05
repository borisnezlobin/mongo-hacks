/**
 * A clock the tests drive by hand.
 *
 * Same shape as the one in capture-engine.test.ts, shared because four glasses
 * modules take injected timers and none of them should be tested by waiting.
 */
export interface TestClock {
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
  advance(ms: number): void;
  readonly now: number;
  readonly pendingCount: number;
}

export function createTestClock(): TestClock {
  let now = 0;
  let nextId = 1;
  const pending = new Map<number, { at: number; fn: () => void }>();
  return {
    setTimer(fn, ms) {
      const id = nextId++;
      pending.set(id, { at: now + ms, fn });
      return id;
    },
    clearTimer(handle) {
      pending.delete(handle as number);
    },
    advance(ms) {
      const target = now + ms;
      let guard = 0;
      for (;;) {
        const due = [...pending.entries()]
          .filter(([, timer]) => timer.at <= target)
          .sort(([, a], [, b]) => a.at - b.at)[0];
        if (!due || (guard += 1) > 200) break;
        pending.delete(due[0]);
        now = due[1].at;
        due[1].fn();
      }
      now = target;
    },
    get now() {
      return now;
    },
    get pendingCount() {
      return pending.size;
    },
  };
}
