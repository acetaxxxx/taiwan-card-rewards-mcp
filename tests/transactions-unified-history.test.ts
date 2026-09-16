import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import * as readline from 'node:readline';
import { describe, expect, it } from 'vitest';
import {
  FileStore,
  RewardService,
  mcpTools,
  validateTransaction,
  validateListTransactionsOptions,
  type TransactionTuple,
  type SourceSnapshot,
  type OfferRuleVersion,
  type PaymentRouteRecord,
  type CapPool,
} from '../src/index.js';

interface JsonRpcResponse {
  jsonrpc: string;
  id: string | number | null;
  result?: any;
  error?: {
    code: number;
    message: string;
    data?: any;
  };
}

class McpProcessClient {
  private proc: ChildProcess;
  private rl: readline.Interface;
  private pending: Map<string | number, { resolve: (res: JsonRpcResponse) => void; reject: (err: any) => void }> = new Map();

  constructor(dataDir: string, user = 'test-user') {
    const cliPath = resolve(__dirname, '../dist/cli.js');
    const args = [cliPath, '--data-dir', dataDir, '--user', user];
    this.proc = spawn(process.execPath, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    this.rl = readline.createInterface({
      input: this.proc.stdout!,
      crlfDelay: Infinity,
    });

    this.rl.on('line', (line) => {
      if (!line.trim()) return;
      try {
        const parsed = JSON.parse(line) as JsonRpcResponse;
        if (parsed.id !== undefined && this.pending.has(parsed.id)) {
          const handler = this.pending.get(parsed.id)!;
          this.pending.delete(parsed.id);
          handler.resolve(parsed);
        }
      } catch {
        // ignore non-json line
      }
    });
  }

  send(request: { jsonrpc?: string; id?: string | number | null; method?: string; params?: any }): Promise<JsonRpcResponse> {
    return new Promise((res, rej) => {
      const id = request.id ?? Math.floor(Math.random() * 1000000);
      const payload = { jsonrpc: '2.0', id, ...request };
      this.pending.set(id, { resolve: res, reject: rej });
      this.proc.stdin!.write(JSON.stringify(payload) + '\n');
    });
  }

  close(): Promise<void> {
    return new Promise((res) => {
      this.rl.close();
      this.proc.stdin!.end();
      this.proc.on('close', () => res());
    });
  }
}

describe('Ticket 03: 統一交易記錄與時間查詢 (Unified Transactions & Time History)', () => {
  it('supports 4 funding sources (credit_card, account subtypes, cash) and allows transactions without cardId', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tx-funding-sources-'));
    try {
      const store = new FileStore({ dataDir: dir });
      const service = new RewardService(store, 'user-1');

      // 1. Credit card with cardId
      const txCard: TransactionTuple = {
        idempotencyKey: 'tx-card-1',
        kind: 'purchase',
        mode: 'actual',
        occurredAt: '2026-09-10T10:00:00Z',
        amount: { amountMinor: 50000, currency: 'TWD' },
        cardId: 'card-1',
        funding: { kind: 'credit_card', cardId: 'card-1' },
      };
      service.recordTransaction(txCard);

      // 2. Legacy credit card without explicit funding object (auto-normalized to credit_card)
      const txLegacyCard: TransactionTuple = {
        idempotencyKey: 'tx-legacy-card',
        kind: 'purchase',
        mode: 'actual',
        occurredAt: '2026-09-10T10:30:00Z',
        amount: { amountMinor: 30000, currency: 'TWD' },
        cardId: 'card-1',
      };
      service.recordTransaction(txLegacyCard);

      // 3. Credit card without cardId (generic / candidate credit card)
      const txCardNoId: TransactionTuple = {
        idempotencyKey: 'tx-card-no-id',
        kind: 'purchase',
        mode: 'actual',
        occurredAt: '2026-09-10T11:00:00Z',
        amount: { amountMinor: 20000, currency: 'TWD' },
        funding: { kind: 'credit_card' },
      };
      service.recordTransaction(txCardNoId);

      // 4. Linked bank account
      const txBank: TransactionTuple = {
        idempotencyKey: 'tx-bank-1',
        kind: 'purchase',
        mode: 'actual',
        occurredAt: '2026-09-10T12:00:00Z',
        amount: { amountMinor: 150000, currency: 'TWD' },
        funding: { kind: 'account', subtype: 'linked_bank_account', accountId: 'acc-bank-1' },
      };
      service.recordTransaction(txBank);

      // 5. Wallet balance
      const txWallet: TransactionTuple = {
        idempotencyKey: 'tx-wallet-1',
        kind: 'purchase',
        mode: 'actual',
        occurredAt: '2026-09-10T13:00:00Z',
        amount: { amountMinor: 8000, currency: 'TWD' },
        funding: { kind: 'account', subtype: 'wallet_balance', accountId: 'acc-wallet-1' },
      };
      service.recordTransaction(txWallet);

      // 6. Foreign currency account
      const txFca: TransactionTuple = {
        idempotencyKey: 'tx-fca-1',
        kind: 'purchase',
        mode: 'actual',
        occurredAt: '2026-09-10T14:00:00Z',
        amount: { amountMinor: 25000, currency: 'USD' },
        funding: { kind: 'account', subtype: 'foreign_currency_account', accountId: 'acc-fca-1' },
      };
      service.recordTransaction(txFca);

      // 7. Cash
      const txCash: TransactionTuple = {
        idempotencyKey: 'tx-cash-1',
        kind: 'purchase',
        mode: 'actual',
        occurredAt: '2026-09-10T15:00:00Z',
        amount: { amountMinor: 12000, currency: 'TWD' },
        funding: { kind: 'cash' },
      };
      service.recordTransaction(txCash);

      // Reject non-card funding with cardId
      expect(() => {
        service.recordTransaction(validateTransaction({
          idempotencyKey: 'tx-invalid-funding',
          kind: 'purchase',
          mode: 'actual',
          occurredAt: '2026-09-10T16:00:00Z',
          amount: { amountMinor: 1000, currency: 'TWD' },
          cardId: 'card-1',
          funding: { kind: 'cash' },
        }));
      }).toThrow(/must not be specified for non-card funding/);

      // Query all recorded transactions
      const list = service.listTransactions({ limit: 50 });
      expect(list.transactions).toHaveLength(7);

      // Verify funding kinds
      const kinds = list.transactions.map((t) => (t as any).funding?.kind);
      expect(kinds).toContain('credit_card');
      expect(kinds).toContain('account');
      expect(kinds).toContain('cash');

      store.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('records occurredAt and recordedAt, supporting evening backfilling and both timeBasis queries', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tx-time-basis-'));
    try {
      const store = new FileStore({ dataDir: dir });
      const service = new RewardService(store, 'user-1');

      // Tx A occurred in morning (09:00), but recorded during evening backfilling (21:00)
      const txA: TransactionTuple = {
        idempotencyKey: 'tx-morning-spend',
        kind: 'purchase',
        mode: 'actual',
        occurredAt: '2026-09-10T09:00:00Z',
        recordedAt: '2026-09-10T21:00:00Z',
        amount: { amountMinor: 10000, currency: 'TWD' },
        funding: { kind: 'cash' },
      };
      service.recordTransaction(txA);

      // Tx B occurred at 15:00, recorded at 15:05
      const txB: TransactionTuple = {
        idempotencyKey: 'tx-afternoon-spend',
        kind: 'purchase',
        mode: 'actual',
        occurredAt: '2026-09-10T15:00:00Z',
        recordedAt: '2026-09-10T15:05:00Z',
        amount: { amountMinor: 20000, currency: 'TWD' },
        funding: { kind: 'cash' },
      };
      service.recordTransaction(txB);

      // 1. Query with timeBasis: 'occurred_at' (default)
      const byOccurred = service.listTransactions({ timeBasis: 'occurred_at' });
      expect(byOccurred.transactions).toHaveLength(2);
      expect((byOccurred.transactions[0] as any).idempotencyKey).toBe('tx-morning-spend');
      expect((byOccurred.transactions[1] as any).idempotencyKey).toBe('tx-afternoon-spend');

      // Date range filtering by occurred_at
      const morningOnly = service.listTransactions({
        startDate: '2026-09-10T08:00:00Z',
        endDate: '2026-09-10T12:00:00Z',
        timeBasis: 'occurred_at',
      });
      expect(morningOnly.transactions).toHaveLength(1);
      expect((morningOnly.transactions[0] as any).idempotencyKey).toBe('tx-morning-spend');

      // 2. Query with timeBasis: 'recorded_at'
      const byRecorded = service.listTransactions({ timeBasis: 'recorded_at' });
      expect(byRecorded.transactions).toHaveLength(2);
      // In recorded_at order: afternoon spend was recorded first (15:05), morning spend was backfilled in evening (21:00)
      expect((byRecorded.transactions[0] as any).idempotencyKey).toBe('tx-afternoon-spend');
      expect((byRecorded.transactions[1] as any).idempotencyKey).toBe('tx-morning-spend');

      // Date range filtering by recorded_at
      const eveningOnly = service.listTransactions({
        startDate: '2026-09-10T20:00:00Z',
        endDate: '2026-09-10T22:00:00Z',
        timeBasis: 'recorded_at',
      });
      expect(eveningOnly.transactions).toHaveLength(1);
      expect((eveningOnly.transactions[0] as any).idempotencyKey).toBe('tx-morning-spend');

      store.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('validates time boundaries, timeBasis options, and funding filters', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tx-validation-'));
    try {
      const store = new FileStore({ dataDir: dir });
      const service = new RewardService(store, 'user-1');

      // Record mixed transactions
      service.recordTransaction({
        idempotencyKey: 'tx-c1',
        kind: 'purchase',
        mode: 'actual',
        occurredAt: '2026-09-10T10:00:00Z',
        amount: { amountMinor: 10000, currency: 'TWD' },
        cardId: 'card-1',
      });
      service.recordTransaction({
        idempotencyKey: 'tx-c2',
        kind: 'purchase',
        mode: 'actual',
        occurredAt: '2026-09-10T11:00:00Z',
        amount: { amountMinor: 20000, currency: 'TWD' },
        cardId: 'card-2',
      });
      service.recordTransaction({
        idempotencyKey: 'tx-acc',
        kind: 'purchase',
        mode: 'actual',
        occurredAt: '2026-09-10T12:00:00Z',
        amount: { amountMinor: 30000, currency: 'TWD' },
        funding: { kind: 'account', subtype: 'wallet_balance' },
      });
      service.recordTransaction({
        idempotencyKey: 'tx-cash',
        kind: 'purchase',
        mode: 'actual',
        occurredAt: '2026-09-10T13:00:00Z',
        amount: { amountMinor: 40000, currency: 'TWD' },
        funding: { kind: 'cash' },
      });

      // startDate > endDate throws INVALID_INPUT
      expect(() => {
        service.listTransactions({
          startDate: '2026-09-10T15:00:00Z',
          endDate: '2026-09-10T10:00:00Z',
        });
      }).toThrow(/startDate cannot be after endDate/);

      // Invalid timeBasis throws INVALID_INPUT
      expect(() => {
        service.listTransactions({
          timeBasis: 'invalid_basis' as any,
        });
      }).toThrow(/timeBasis is invalid/);

      // Filter by fundingKind
      const creditOnly = service.listTransactions({ fundingKind: 'credit_card' });
      expect(creditOnly.transactions).toHaveLength(2);

      const accountOnly = service.listTransactions({ fundingKind: 'account' });
      expect(accountOnly.transactions).toHaveLength(1);
      expect((accountOnly.transactions[0] as any).idempotencyKey).toBe('tx-acc');

      const cashOnly = service.listTransactions({ fundingKind: 'cash' });
      expect(cashOnly.transactions).toHaveLength(1);
      expect((cashOnly.transactions[0] as any).idempotencyKey).toBe('tx-cash');

      // Filter by cardId
      const card1Only = service.listTransactions({ cardId: 'card-1' });
      expect(card1Only.transactions).toHaveLength(1);
      expect((card1Only.transactions[0] as any).idempotencyKey).toBe('tx-c1');

      store.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('provides stable pagination with limit 1..50, total, totalPages, and hasMore', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tx-pagination-'));
    try {
      const store = new FileStore({ dataDir: dir });
      const service = new RewardService(store, 'user-1');

      // Record 12 transactions
      for (let i = 1; i <= 12; i++) {
        const pad = String(i).padStart(2, '0');
        service.recordTransaction({
          idempotencyKey: `tx-page-${pad}`,
          kind: 'purchase',
          mode: 'actual',
          occurredAt: `2026-09-10T${pad}:00:00Z`,
          amount: { amountMinor: i * 1000, currency: 'TWD' },
          funding: { kind: 'cash' },
        });
      }

      // Page 1, limit 5
      const page1 = service.listTransactions({ page: 1, limit: 5 });
      expect(page1.transactions).toHaveLength(5);
      expect(page1.pageInfo.page).toBe(1);
      expect(page1.pageInfo.limit).toBe(5);
      expect(page1.pageInfo.total).toBe(12);
      expect(page1.pageInfo.totalPages).toBe(3);
      expect(page1.pageInfo.hasMore).toBe(true);
      expect((page1.transactions[0] as any).idempotencyKey).toBe('tx-page-01');
      expect((page1.transactions[4] as any).idempotencyKey).toBe('tx-page-05');

      // Page 2, limit 5
      const page2 = service.listTransactions({ page: 2, limit: 5 });
      expect(page2.transactions).toHaveLength(5);
      expect(page2.pageInfo.page).toBe(2);
      expect(page2.pageInfo.hasMore).toBe(true);
      expect((page2.transactions[0] as any).idempotencyKey).toBe('tx-page-06');
      expect((page2.transactions[4] as any).idempotencyKey).toBe('tx-page-10');

      // Page 3, limit 5 (remaining 2)
      const page3 = service.listTransactions({ page: 3, limit: 5 });
      expect(page3.transactions).toHaveLength(2);
      expect(page3.pageInfo.page).toBe(3);
      expect(page3.pageInfo.hasMore).toBe(false);
      expect((page3.transactions[0] as any).idempotencyKey).toBe('tx-page-11');
      expect((page3.transactions[1] as any).idempotencyKey).toBe('tx-page-12');

      // Page 4 (after end)
      const page4 = service.listTransactions({ page: 4, limit: 5 });
      expect(page4.transactions).toHaveLength(0);
      expect(page4.pageInfo.hasMore).toBe(false);

      // Max limit 50 is accepted
      const page50 = service.listTransactions({ limit: 50 });
      expect(page50.transactions).toHaveLength(12);

      // Limit > 50 throws INVALID_INPUT
      expect(() => {
        service.listTransactions({ limit: 51 });
      }).toThrow(/limit must be 1..50/);

      // Limit < 1 throws INVALID_INPUT
      expect(() => {
        service.listTransactions({ limit: 0 });
      }).toThrow(/limit must be a safe integer/);

      store.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('projects summary vs detail linking reward, cap, route, and applied FX without a separate PFM service', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tx-projections-'));
    try {
      const store = new FileStore({ dataDir: dir });
      const service = new RewardService(store, 'user-1');

      // Setup card, rule, cap pool, and payment route
      service.registerCard({ id: 'card-1', issuer: 'TestBank', productName: 'Travel Card' });

      const snap: SourceSnapshot = {
        id: 'snap-1',
        url: 'https://bank.example.com/terms',
        fetchedAt: '2026-09-01T00:00:00Z',
        contentHash: 'hash-1',
        parserVersion: '1.0.0',
      };

      const capPool: CapPool = {
        id: 'cap-monthly-500',
        name: 'Monthly 500 TWD cap',
        metric: 'reward',
        period: 'calendar_month',
        limit: 50000,
        currency: 'TWD',
        timezone: 'Asia/Taipei',
      };

      const rule: OfferRuleVersion = {
        id: 'rule-travel-5pct',
        cardId: 'card-1',
        version: '1.0.0',
        sourceSnapshotId: 'snap-1',
        status: 'active',
        validFrom: '2026-09-01T00:00:00Z',
        validTo: '2026-09-30T23:59:59Z',
        settlementCurrency: 'TWD',
        match: { channels: ['in_store'] },
        reward: { kind: 'percentage', rateBps: 500 },
        capPoolRefs: ['cap-monthly-500'],
      };

      service.upsertOffer(snap, rule, undefined, [capPool]);

      const route: PaymentRouteRecord = {
        id: 'route-apple-pay',
        status: 'active',
        observedAt: '2026-09-01T00:00:00Z',
        idempotencyKey: 'route-key-1',
        layers: [{ kind: 'wallet', displayName: 'Apple Pay' }],
        funding: { kind: 'credit_card', cardId: 'card-1' },
      };
      const createdRoute = service.upsertPaymentRoute(route);

      // Record transaction with route and foreign FX
      const tx: TransactionTuple = {
        idempotencyKey: 'tx-tokyo-hotel',
        kind: 'purchase',
        mode: 'actual',
        occurredAt: '2026-09-10T12:00:00Z',
        amount: { amountMinor: 10000, currency: 'JPY' },
        cardId: 'card-1',
        channel: 'in_store',
        routeId: createdRoute.id,
        funding: { kind: 'credit_card', cardId: 'card-1' },
        fx: {
          id: 'fx-jpy-twd',
          baseCurrency: 'JPY',
          quoteCurrency: 'TWD',
          ratePpm: 215000, // 0.215
          capturedAt: '2026-09-10T10:00:00Z',
          provider: 'bank',
          rateType: 'card_scheme',
        },
      };

      const reward = service.recordTransaction(tx);
      expect(reward.status).toBe('ok');

      // 1. Summary projection
      const summaryList = service.listTransactions({ projection: 'summary' });
      expect(summaryList.transactions).toHaveLength(1);
      const summaryItem = summaryList.transactions[0] as any;
      expect(summaryItem.idempotencyKey).toBe('tx-tokyo-hotel');
      expect(summaryItem.kind).toBe('purchase');
      expect(summaryItem.amount).toEqual({ amountMinor: 10000, currency: 'JPY' });
      expect(summaryItem.funding).toEqual({ kind: 'credit_card', cardId: 'card-1' });
      expect(summaryItem.rewardStatus).toBe('ok');
      expect(summaryItem.channel).toBe('in_store');
      // Summary does not embed components, capUsages, or full route objects
      expect(summaryItem.components).toBeUndefined();
      expect(summaryItem.capUsages).toBeUndefined();

      // 2. Detail projection
      const detailList = service.listTransactions({ projection: 'detail' });
      expect(detailList.transactions).toHaveLength(1);
      const detailItem = detailList.transactions[0] as any;
      expect(detailItem.transaction.idempotencyKey).toBe('tx-tokyo-hotel');
      expect(detailItem.reward.status).toBe('ok');
      expect(detailItem.appliedFx).toBeDefined();
      expect(detailItem.appliedFx.baseCurrency).toBe('JPY');
      expect(detailItem.route).toBeDefined();
      expect(detailItem.route.id).toBe(createdRoute.id);
      expect(detailItem.components).toBeDefined();
      expect(detailItem.components.length).toBeGreaterThan(0);
      expect(detailItem.capUsages).toBeDefined();
      expect(detailItem.capUsages.length).toBeGreaterThan(0);
      expect(detailItem.capUsages[0].poolId).toBe('cap-monthly-500');

      store.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('handles idempotency, refunds, and non-blocking unknown reward', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tx-idempotency-refunds-'));
    try {
      const store = new FileStore({ dataDir: dir });
      const service = new RewardService(store, 'user-1');

      // 1. Unknown reward does NOT block transaction recording
      const unknownTx: TransactionTuple = {
        idempotencyKey: 'tx-unknown-promo',
        kind: 'purchase',
        mode: 'actual',
        occurredAt: '2026-09-10T10:00:00Z',
        amount: { amountMinor: 50000, currency: 'TWD' },
        funding: { kind: 'cash' },
      };
      const unknownReward = service.recordTransaction(unknownTx);
      expect(unknownReward.status).toBe('unknown');

      const storedTx = service.listTransactions({ limit: 10 });
      expect(storedTx.transactions).toHaveLength(1);
      expect((storedTx.transactions[0] as any).idempotencyKey).toBe('tx-unknown-promo');

      // 2. Idempotency: exact repeat returns same reward without duplicating record
      const repeatReward = service.recordTransaction(unknownTx);
      expect(repeatReward.status).toBe('unknown');
      expect(service.listTransactions({ limit: 10 }).transactions).toHaveLength(1);

      // 3. Idempotency conflict: same key, different amount throws IDEMPOTENCY_CONFLICT
      expect(() => {
        service.recordTransaction({
          ...unknownTx,
          amount: { amountMinor: 99999, currency: 'TWD' },
        });
      }).toThrow(/IDEMPOTENCY_CONFLICT/);

      // 4. Linked refund with matching funding instrument succeeds
      const refundTx: TransactionTuple = {
        idempotencyKey: 'tx-refund-unknown',
        kind: 'refund',
        mode: 'actual',
        refundOfId: 'tx-unknown-promo',
        occurredAt: '2026-09-10T11:00:00Z',
        amount: { amountMinor: 20000, currency: 'TWD' },
        funding: { kind: 'cash' },
      };
      const refundReward = service.recordTransaction(refundTx);
      expect(refundReward.status).toBe('unknown');

      // 5. Refund with mismatched funding instrument fails with INVALID_REFUND
      expect(() => {
        service.recordTransaction({
          idempotencyKey: 'tx-refund-bad-funding',
          kind: 'refund',
          mode: 'actual',
          refundOfId: 'tx-unknown-promo',
          occurredAt: '2026-09-10T12:00:00Z',
          amount: { amountMinor: 10000, currency: 'TWD' },
          funding: { kind: 'account', subtype: 'wallet_balance' },
        });
      }).toThrow(/refund must reference a transaction for the same funding instrument/);

      // 6. Complete refund of remaining 30000
      service.recordTransaction({
        idempotencyKey: 'tx-refund-remaining',
        kind: 'refund',
        mode: 'actual',
        refundOfId: 'tx-unknown-promo',
        occurredAt: '2026-09-10T12:30:00Z',
        amount: { amountMinor: 30000, currency: 'TWD' },
        funding: { kind: 'cash' },
      });

      // 7. Any further refund exceeds original amount and fails with INVALID_REFUND
      expect(() => {
        service.recordTransaction({
          idempotencyKey: 'tx-refund-over',
          kind: 'refund',
          mode: 'actual',
          refundOfId: 'tx-unknown-promo',
          occurredAt: '2026-09-10T13:00:00Z',
          amount: { amountMinor: 5000, currency: 'TWD' },
          funding: { kind: 'cash' },
        });
      }).toThrow(/refund exceeds the original purchase amount/);

      store.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('records a non-card foreign-currency spend without requiring FX from unrelated card rules', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tx-non-card-unrelated-fx-'));
    try {
      const store = new FileStore({ dataDir: dir });
      const service = new RewardService(store, 'user-1');
      service.upsertOffer(
        {
          id: 'foreign-card-rule-source',
          url: 'https://issuer.example/foreign-reward',
          fetchedAt: '2026-09-01T00:00:00Z',
          contentHash: 'foreign-card-rule-hash',
          parserVersion: '1',
          verified: true,
        },
        {
          id: 'foreign-card-rule',
          cardId: 'other-card',
          version: '1',
          sourceSnapshotId: 'foreign-card-rule-source',
          status: 'active',
          validFrom: '2026-09-01T00:00:00Z',
          settlementCurrency: 'TWD',
          match: {},
          reward: { kind: 'percentage', rateBps: 300 },
        },
      );

      expect(() => service.recordTransaction({
        idempotencyKey: 'cash-jpy-no-reward',
        kind: 'purchase',
        mode: 'actual',
        occurredAt: '2026-09-10T10:00:00Z',
        amount: { amountMinor: 1000, currency: 'JPY' },
        funding: { kind: 'cash' },
      })).not.toThrow();
      expect(service.listTransactions().transactions).toHaveLength(1);
      store.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('enforces multi-tenant isolation across recording, querying, and refunds', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tx-multi-tenant-'));
    try {
      const store = new FileStore({ dataDir: dir });
      const serviceAlice = new RewardService(store, 'alice');
      const serviceBob = new RewardService(store, 'bob');

      // Alice records transaction
      serviceAlice.recordTransaction({
        idempotencyKey: 'tx-alice-1',
        kind: 'purchase',
        mode: 'actual',
        occurredAt: '2026-09-10T10:00:00Z',
        amount: { amountMinor: 10000, currency: 'TWD' },
        funding: { kind: 'cash' },
      });

      // Bob records transaction
      serviceBob.recordTransaction({
        idempotencyKey: 'tx-bob-1',
        kind: 'purchase',
        mode: 'actual',
        occurredAt: '2026-09-10T11:00:00Z',
        amount: { amountMinor: 20000, currency: 'TWD' },
        funding: { kind: 'cash' },
      });

      // Alice only sees Alice's transactions
      const aliceList = serviceAlice.listTransactions();
      expect(aliceList.transactions).toHaveLength(1);
      expect((aliceList.transactions[0] as any).idempotencyKey).toBe('tx-alice-1');

      // Bob only sees Bob's transactions
      const bobList = serviceBob.listTransactions();
      expect(bobList.transactions).toHaveLength(1);
      expect((bobList.transactions[0] as any).idempotencyKey).toBe('tx-bob-1');

      // Bob cannot refund Alice's transaction
      expect(() => {
        serviceBob.recordTransaction({
          idempotencyKey: 'tx-bob-refund-alice',
          kind: 'refund',
          mode: 'actual',
          refundOfId: 'tx-alice-1',
          occurredAt: '2026-09-10T12:00:00Z',
          amount: { amountMinor: 5000, currency: 'TWD' },
          funding: { kind: 'cash' },
        });
      }).toThrow(/refundOfId does not reference a recorded transaction/);

      store.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('operates correctly end-to-end through MCP JSON-RPC protocol', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tx-mcp-jsonrpc-'));
    const client = new McpProcessClient(dir, 'mcp-user');
    try {
      // 1. Initialize
      const initRes = await client.send({
        method: 'initialize',
        params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test-client', version: '1.0' } },
      });
      expect(initRes.result?.serverInfo?.name).toBe('taiwan_card_rewards_mcp');

      // 2. tools/list includes list_transactions with 27 total tools
      const listRes = await client.send({ method: 'tools/list' });
      expect(listRes.result.tools).toHaveLength(27);
      const listTxTool = listRes.result.tools.find((t: any) => t.name === 'list_transactions');
      expect(listTxTool).toBeDefined();
      expect(listTxTool.inputSchema.properties.limit.maximum).toBe(50);

      // 3. Record transactions via tools/call with snake_case normalization
      const recRes1 = await client.send({
        method: 'tools/call',
        params: {
          name: 'record_transaction',
          arguments: {
            transaction: {
              idempotency_key: 'tx-mcp-cash',
              kind: 'purchase',
              mode: 'actual',
              occurred_at: '2026-09-10T10:00:00Z',
              amount: { amount_minor: 12300, currency: 'TWD' },
              funding: { kind: 'cash' },
            },
          },
        },
      });
      expect(recRes1.error).toBeUndefined();
      expect(recRes1.result.structuredContent.status).toBe('unknown');

      const recRes2 = await client.send({
        method: 'tools/call',
        params: {
          name: 'record_transaction',
          arguments: {
            transaction: {
              idempotencyKey: 'tx-mcp-account',
              kind: 'purchase',
              mode: 'actual',
              occurredAt: '2026-09-10T11:00:00Z',
              amount: { amountMinor: 45600, currency: 'TWD' },
              funding: { kind: 'account', subtype: 'wallet_balance' },
            },
          },
        },
      });
      expect(recRes2.error).toBeUndefined();

      // 4. Call list_transactions via tools/call with summary projection
      const querySummary = await client.send({
        method: 'tools/call',
        params: {
          name: 'list_transactions',
          arguments: {
            limit: 50,
            projection: 'summary',
            time_basis: 'occurred_at',
          },
        },
      });
      expect(querySummary.error).toBeUndefined();
      expect(querySummary.result.structuredContent.transactions).toHaveLength(2);
      expect(querySummary.result.structuredContent.pageInfo.total).toBe(2);

      // 5. Query with detail projection
      const queryDetail = await client.send({
        method: 'tools/call',
        params: {
          name: 'list_transactions',
          arguments: {
            projection: 'detail',
          },
        },
      });
      expect(queryDetail.error).toBeUndefined();
      expect(queryDetail.result.structuredContent.transactions[0].transaction).toBeDefined();

      // 6. Fail-closed on limit > 50
      const invalidLimit = await client.send({
        method: 'tools/call',
        params: {
          name: 'list_transactions',
          arguments: {
            limit: 51,
          },
        },
      });
      expect(invalidLimit.error?.message).toBe('INVALID_INPUT');

      // 7. Fail-closed on startDate > endDate
      const invalidRange = await client.send({
        method: 'tools/call',
        params: {
          name: 'list_transactions',
          arguments: {
            start_date: '2026-09-10T15:00:00Z',
            end_date: '2026-09-10T10:00:00Z',
          },
        },
      });
      expect(invalidRange.error?.message).toBe('INVALID_INPUT');
    } finally {
      await client.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
