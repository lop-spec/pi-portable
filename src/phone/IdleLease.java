package com.lop.phone;

/** Monotonic per-workspace lease. Callers serialize renewal/expiry with workspace operations. */
final class IdleLease {
    static final long TIMEOUT_MS = 120_000L;
    volatile long lastUse;

    IdleLease(long now) { touch(now); }
    void touch(long now) { lastUse = now; }
    long remainingMs(long now) { return Math.max(0L, TIMEOUT_MS - Math.max(0L, now - lastUse)); }
    boolean expired(long now) { return remainingMs(now) == 0L; }
}
