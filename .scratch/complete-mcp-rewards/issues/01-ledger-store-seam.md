# 01: Establish the LedgerStore persistence seam

**What to build:** Stateful reward operations use a replaceable LedgerStore boundary backed by the existing user-scoped FileStore, with durable writes, exclusive ownership, and explicit storage failures.

**Blocked by:** None (can start immediately)

**Status:** completed

- [x] Stateful service operations depend on the LedgerStore contract rather than FileStore details.
- [x] The FileStore adapter enforces canonical user-scoped directory binding, exclusive locking, atomic replacement, and explicit corrupt/unavailable state errors.
- [x] Restart and failure behavior is observable through the service/MCP contract without asserting the underlying JSON layout.
- [x] Tests cover normal persistence, lock conflicts, atomic replacement, corruption, and process restart recovery.
