import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { FileStore, RewardService } from '../src/index.js';
import type { OfferRuleVersion, OfferSourceSnapshot, TransactionTuple } from '../src/types.js';

const source: OfferSourceSnapshot = { id: 's1', url: 'https://bank.example/', fetchedAt: '2026-08-01T00:00:00Z', contentHash: 'hash', parserVersion: '1' };
const rule: OfferRuleVersion = { id: 'r1', cardId: 'c1', version: '1', sourceSnapshotId: 's1', status: 'active', validFrom: '2026-01-01T00:00:00Z', settlementCurrency: 'TWD', match: {}, reward: { kind: 'percentage', rateBps: 200 } };
const purchase = (key: string, amountMinor: number): TransactionTuple => ({ idempotencyKey: key, cardId: 'c1', kind: 'purchase', mode: 'actual', occurredAt: '2026-08-20T00:00:00Z', amount: { amountMinor, currency: 'TWD' } });
const refund = (key: string, refundOfId: string, amountMinor: number): TransactionTuple => ({ idempotencyKey: key, cardId: 'c1', kind: 'refund', mode: 'actual', refundOfId, occurredAt: '2026-08-21T00:00:00Z', amount: { amountMinor, currency: 'TWD' } });

describe('purchase and refund reconciliation', () => {
  it('records partial refunds against the original reward and bounds repeated refunds', () => {
    const dir = mkdtempSync(join(tmpdir(), 'card-rewards-ledger-'));
    const store = new FileStore({ dataDir: dir, sourceHosts: ['bank.example'] });
    try {
      const service = new RewardService(store, undefined, ['bank.example']);
      service.registerCard({ id: 'c1', issuer: 'Bank', productName: 'Card' });
      service.upsertOffer(source, rule);
      const original = service.recordTransaction(purchase('p1', 10000));
      expect(original.cappedReward?.amountMinor).toBe(200);
      expect(service.recordTransaction(refund('f1', 'p1', 5000)).cappedReward?.amountMinor).toBe(-100);
      expect(service.recordTransaction(refund('f2', 'p1', 6000)).cappedReward?.amountMinor).toBe(-100);
      expect(service.recordTransaction(refund('f2', 'p1', 6000))).toEqual(service.recordTransaction(refund('f2', 'p1', 6000)));
    } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
  });
});
