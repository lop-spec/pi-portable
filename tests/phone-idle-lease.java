package com.lop.phone;

class PhoneIdleLeaseTest {
    static void check(boolean value, String reason) {
        if (!value) throw new AssertionError(reason);
    }
    public static void main(String[] args) throws Exception {
        IdleLease idle = new IdleLease(10_000L);
        check(idle.remainingMs(10_000L) == 120_000L, "initial two-minute lease");
        check(!idle.expired(129_999L), "must not expire early");
        check(idle.expired(130_000L), "exact idle deadline");
        check(idle.remainingMs(999_999L) == 0L, "no negative remaining time");
        idle.touch(140_000L);
        check(!idle.expired(259_999L), "successful activity renews");
        check(idle.expired(260_000L), "renewed deadline");
        IdleLease other = new IdleLease(10_000L);
        check(other.expired(140_000L) && !idle.expired(140_000L), "per-screen independence");
        check(idle.remainingMs(130_000L) == 120_000L, "clock reversal does not prematurely expire");
        // Observation alone cannot renew: repeated remaining/expired reads leave lastUse intact.
        long last = idle.lastUse;
        for (int i = 0; i < 20; i++) { idle.remainingMs(150_000L + i); idle.expired(150_000L + i); }
        check(idle.lastUse == last, "status reads cannot retain an abandoned screen");
        System.out.println("idle lease behavior: PASS");
    }
}
