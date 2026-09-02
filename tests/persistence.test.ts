import { mkdtempSync, rmSync, writeFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  FileStore,
  StoreError,
  RewardService,
  emptyState,
  type LedgerStore,
  type StoredState,
  type CardDescriptor,
  type OfferRuleVersion,
  type OfferSourceSnapshot,
} from "../src/index.js";
import type { StartupConfig } from "../src/startup.js";

function config(dataDir: string): StartupConfig {
  return { dataDir: resolve(dataDir) };
}

const sampleCard: CardDescriptor = { id: "card-1", issuer: "TestBank", productName: "TravelCard" };
const sampleSnapshot: OfferSourceSnapshot = {
  id: "snap-1",
  url: "https://bank.example/",
  fetchedAt: "2026-08-01T00:00:00Z",
  contentHash: "hash-1",
  parserVersion: "v1",
};
const sampleRule: OfferRuleVersion = {
  id: "rule-1",
  cardId: "card-1",
  version: "1",
  sourceSnapshotId: "snap-1",
  status: "active",
  validFrom: "2026-01-01T00:00:00Z",
  settlementCurrency: "TWD",
  match: { countries: ["TW"] },
  reward: { kind: "percentage", rateBps: 200 },
};

describe("LedgerStore persistence seam and FileStore adapter", () => {
  it("implements the LedgerStore contract with empty initial state and durable updates", () => {
    const dir = mkdtempSync(join(tmpdir(), "card-rewards-seam-"));
    try {
      const store: LedgerStore = new FileStore(config(dir));
      const initial = store.read();
      expect(initial.schemaVersion).toBe(1);
      expect(initial.cards).toEqual([]);
      expect(initial.snapshots).toEqual([]);
      expect(initial.rules).toEqual([]);
      expect(initial.transactions).toEqual([]);

      store.update((state) => {
        state.cards.push(sampleCard);
        state.snapshots.push(sampleSnapshot);
        state.rules.push(sampleRule);
      });

      const updated = store.read();
      expect(updated.cards).toHaveLength(1);
      expect(updated.cards[0]?.id).toBe("card-1");
      expect(updated.snapshots).toHaveLength(1);
      expect(updated.rules).toHaveLength(1);

      store.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("recovers all stored state across process restart on the same data directory", () => {
    const dir = mkdtempSync(join(tmpdir(), "card-rewards-restart-"));
    try {
      const store1: LedgerStore = new FileStore(config(dir));
      store1.update((state) => {
        state.cards.push(sampleCard);
        state.snapshots.push(sampleSnapshot);
        state.rules.push(sampleRule);
      });
      store1.close();

      const store2: LedgerStore = new FileStore(config(dir));
      const recovered = store2.read();
      expect(recovered.schemaVersion).toBe(1);
      expect(recovered.cards).toHaveLength(1);
      expect(recovered.cards[0]?.id).toBe("card-1");
      expect(recovered.snapshots[0]?.id).toBe("snap-1");
      expect(recovered.rules[0]?.id).toBe("rule-1");
      store2.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("enforces exclusive locking and allows re-acquisition only after close", () => {
    const dir = mkdtempSync(join(tmpdir(), "card-rewards-lock-"));
    try {
      const store1: LedgerStore = new FileStore(config(dir));
      expect(() => new FileStore(config(dir))).toThrowError(StoreError);
      expect(() => new FileStore(config(dir))).toThrow(/LOCK_EXISTS/);

      store1.close();
      const store2: LedgerStore = new FileStore(config(dir));
      expect(store2.read().cards).toEqual([]);
      store2.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("recovers a lock left by a process that no longer exists", () => {
    const dir = mkdtempSync(join(tmpdir(), "card-rewards-stale-lock-"));
    try {
      writeFileSync(join(dir, "card-rewards.lock"), JSON.stringify({ pid: 2147483647, startedAt: "2026-09-02T00:00:00.000Z" }));
      const store = new FileStore(config(dir));
      expect(store.read().schemaVersion).toBe(1);
      store.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("performs atomic replacement and leaves no temp files behind", () => {
    const dir = mkdtempSync(join(tmpdir(), "card-rewards-atomic-"));
    try {
      const store: LedgerStore = new FileStore(config(dir));
      for (let i = 0; i < 5; i++) {
        store.update((state) => {
          state.cards.push({ id: `card-${i}`, issuer: "Bank", productName: `Card ${i}` });
        });
      }
      const files = readdirSync(dir);
      const tmpFiles = files.filter((f) => f.includes(".tmp"));
      expect(tmpFiles).toHaveLength(0);
      store.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("fails with STORE_CORRUPT when state file has invalid JSON or invalid schema", () => {
    const dir = mkdtempSync(join(tmpdir(), "card-rewards-corrupt-"));
    try {
      const stateFile = join(dir, "card-rewards.json");
      writeFileSync(stateFile, "{ malformed json: true");
      expect(() => new FileStore(config(dir))).toThrowError(StoreError);
      expect(() => new FileStore(config(dir))).toThrow(/STORE_CORRUPT/);

      writeFileSync(stateFile, JSON.stringify({ schemaVersion: 99, cards: [] }));
      expect(() => new FileStore(config(dir))).toThrow(/STORE_CORRUPT/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("fails closed when a persisted nested record violates its domain schema", () => {
    const dir = mkdtempSync(join(tmpdir(), "card-rewards-nested-corrupt-"));
    try {
      writeFileSync(join(dir, "card-rewards.json"), JSON.stringify({
        schemaVersion: 1,
        cards: [{ id: "card-1", issuer: "TestBank", productName: "TravelCard", unexpected: true }],
        snapshots: [],
        rules: [],
        transactions: [],
      }));
      expect(() => new FileStore(config(dir))).toThrow(/STORE_CORRUPT/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("allows RewardService to operate over any LedgerStore implementation", () => {
    class InMemoryLedgerStore implements LedgerStore {
      private state: StoredState = emptyState();
      closed = false;

      read(): StoredState {
        return structuredClone(this.state);
      }
      write(next: StoredState): void {
        this.state = structuredClone(next);
      }
      update(mutator: (state: StoredState) => void): StoredState {
        const next = this.read();
        mutator(next);
        this.write(next);
        return this.read();
      }
      close(): void {
        this.closed = true;
      }
    }

    const memoryStore = new InMemoryLedgerStore();
    const service = new RewardService(memoryStore, "test-user");

    const registered = service.registerCard(sampleCard);
    expect(registered.id).toBe("card-1");

    const listed = service.listCards();
    expect(listed).toHaveLength(1);
    expect(listed[0]?.id).toBe("card-1");

    service.upsertOffer(sampleSnapshot, sampleRule);
    expect(memoryStore.read().rules).toHaveLength(1);
    expect(memoryStore.read().snapshots).toHaveLength(1);

    memoryStore.close();
    expect(memoryStore.closed).toBe(true);
  });
});
