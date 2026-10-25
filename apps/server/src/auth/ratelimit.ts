/**
 * Counts failures per key in a sliding window. In memory, so each server
 * instance limits on its own; with N instances an attacker gets N times the
 * budget, which is still small next to the cost of scrypt per guess.
 */
export class FailureLimiter {
  private readonly failures = new Map<string, number[]>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly maxKeys = 100_000,
  ) {}

  private recent(key: string, now: number): number[] {
    const list = (this.failures.get(key) ?? []).filter((t) => now - t < this.windowMs);
    if (list.length === 0) this.failures.delete(key);
    else this.failures.set(key, list);
    return list;
  }

  /** Milliseconds until another attempt is allowed, or 0 if allowed now. */
  retryAfter(key: string, now: number): number {
    const list = this.recent(key, now);
    if (list.length < this.limit) return 0;
    return (list[list.length - this.limit] ?? now) + this.windowMs - now;
  }

  fail(key: string, now: number): void {
    if (!this.failures.has(key) && this.failures.size >= this.maxKeys) {
      // Bounded memory: drop the oldest key rather than grow without limit.
      const oldest = this.failures.keys().next().value;
      if (oldest !== undefined) this.failures.delete(oldest);
    }
    const list = this.recent(key, now);
    list.push(now);
    this.failures.set(key, list);
  }

  reset(key: string): void {
    this.failures.delete(key);
  }

  get size(): number {
    return this.failures.size;
  }
}
