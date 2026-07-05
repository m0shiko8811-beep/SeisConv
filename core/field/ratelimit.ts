// seisconv-core/field — token-bucket rate limiter (ported from rate_limiter.py)
//
// Pure + unit-testable: `consume(n)` performs the token-bucket math and RETURNS
// the number of *seconds the caller must sleep* (0 when unlimited or no debt).
// The socket engine awaits that sleep after releasing any shared state — the
// exact ordering of the Python original (release lock, THEN sleep). A single
// instance may be shared across concurrent server handlers.
//
// max_bps = max_kbps * 1024 (1 KB = 1024 B). max_kbps <= 0 → unlimited (no-op).

/** Monotonic clock in seconds (not affected by wall-clock adjustments). */
export function monotonicNow(): number {
  return performance.now() / 1000;
}

export class RateLimiter {
  private readonly maxBps: number;
  private allowance: number;
  private last: number;
  private readonly now: () => number;

  /** @param maxKbps KB/s cap (×1024 = bytes/s); <= 0 disables limiting.
   *  @param now injectable monotonic clock (seconds) — for deterministic tests. */
  constructor(maxKbps: number, now: () => number = monotonicNow) {
    this.maxBps = maxKbps > 0 ? maxKbps * 1024 : 0;
    this.now = now;
    this.last = now();
    this.allowance = this.maxBps;
  }

  /** Whether this limiter enforces any cap. */
  get enabled(): boolean {
    return this.maxBps > 0;
  }

  /**
   * Account for `n` bytes and return how long (seconds) to sleep to stay under
   * the cap. Mutates internal state exactly like the Python implementation,
   * including pre-advancing the clock past the pending sleep so the slept
   * interval isn't re-credited on the next call.
   */
  consume(n: number): number {
    if (this.maxBps <= 0) return 0;
    const now = this.now();
    this.allowance += (now - this.last) * this.maxBps;
    this.last = now;
    if (this.allowance > this.maxBps) {
      this.allowance = this.maxBps; // cap burst to ~1 s worth
    }
    this.allowance -= n;
    if (this.allowance < 0) {
      const sleepFor = -this.allowance / this.maxBps;
      this.allowance = 0;
      this.last = now + sleepFor; // pre-advance so the slept interval isn't re-credited
      return sleepFor;
    }
    return 0;
  }
}
