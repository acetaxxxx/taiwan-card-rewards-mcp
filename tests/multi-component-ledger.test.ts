import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { FileStore } from '../src/store.js';
import { RewardService } from '../src/service.js';
import type { OfferRuleVersion, OfferSourceSnapshot, TransactionTuple } from '../src/types.js';

const source: OfferSourceSnapshot = { id: 's', url: 'https://bank.example/offer', fetchedAt: '2026-09-01T00:00:00Z', contentHash: 'h', parserVersion: '1', verified: true };
const rule = (id: string, kind: OfferRuleVersion['componentKind'], rateBps: number): OfferRuleVersion => ({ id, cardId: 'card', version: '1', sourceSnapshotId: 's', status: 'active', validFrom: '2026-01-01T00:00:00Z', settlementCurrency: 'TWD', match: {}, reward: { kind: 'percentage', rateBps }, componentKind: kind, stacking: 'confirmed' });

describe('v0.6 multi-component ledger', () => {
  it('persists one auditable component per independently applied reward rule', () => {
    const dir = mkdtempSync(join(tmpdir(), 'card-rewards-components-'));
    const store = new FileStore({ dataDir: dir });
    try {
      const service = new RewardService(store, undefined);
      service.registerCard({ id: 'card', issuer: 'Bank', productName: 'Card' });
      service.upsertOffer(source, { ...rule('merchant-rule', 'merchant_loyalty', 100), capPoolRefs: ['shared'] }, undefined, [{ id: 'shared', metric: 'reward', period: 'calendar_month', limit: 500, currency: 'TWD', timezone: 'Asia/Taipei' }]);
      service.upsertOffer(source, { ...rule('issuer-rule', 'card_issuer', 200), capPoolRefs: ['shared'] });
      const tx: TransactionTuple = { idempotencyKey: 'purchase-1', cardId: 'card', kind: 'purchase', mode: 'actual', occurredAt: '2026-09-05T00:00:00Z', amount: { amountMinor: 10000, currency: 'TWD' }, route: { kind: 'merchant_app', appId: 'merchant-app' } };

      const result = service.recordTransaction(tx);
      const records = store.read().rewardComponents;
      expect(result.components).toHaveLength(2);
      expect(records).toHaveLength(2);
      expect(new Set(records.map((record) => record.componentId)).size).toBe(2);
      expect(records.map((record) => record.transactionId)).toEqual(['purchase-1', 'purchase-1']);
      expect(records.find((record) => record.route === 'merchant')?.reward.value).toBe(100);
      expect(records.find((record) => record.route === 'card_issuer')?.reward.value).toBe(200);
      expect(records.every((record) => record.capUsages.some((usage) => usage.poolId === 'shared' && usage.metric === 'reward'))).toBe(true);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reverses each component proportionally and balances the final refund remainder', () => {
    const dir = mkdtempSync(join(tmpdir(), 'card-rewards-component-refund-'));
    const store = new FileStore({ dataDir: dir });
    try {
      const service = new RewardService(store, undefined);
      service.registerCard({ id: 'card', issuer: 'Bank', productName: 'Card' });
      service.upsertOffer(source, rule('merchant-rule', 'merchant_loyalty', 100));
      service.upsertOffer(source, rule('issuer-rule', 'card_issuer', 200));
      service.recordTransaction({ idempotencyKey: 'purchase-2', cardId: 'card', kind: 'purchase', mode: 'actual', occurredAt: '2026-09-05T00:00:00Z', amount: { amountMinor: 10000, currency: 'TWD' } });
      service.recordTransaction({ idempotencyKey: 'refund-1', refundOfId: 'purchase-2', cardId: 'card', kind: 'refund', mode: 'actual', occurredAt: '2026-09-06T00:00:00Z', amount: { amountMinor: 3333, currency: 'TWD' }, originalRewardMinor: 0 });
      service.recordTransaction({ idempotencyKey: 'refund-2', refundOfId: 'purchase-2', cardId: 'card', kind: 'refund', mode: 'actual', occurredAt: '2026-09-07T00:00:00Z', amount: { amountMinor: 6667, currency: 'TWD' }, originalRewardMinor: 0 });

      const records = store.read().rewardComponents.filter((record) => record.transactionId !== 'purchase-2');
      expect(records.filter((record) => record.transactionId === 'refund-1').map((record) => record.reward.value)).toEqual([-33, -66]);
      expect(records.filter((record) => record.transactionId === 'refund-2').map((record) => record.reward.value)).toEqual([-67, -134]);
      expect(records.filter((record) => record.ruleId === 'merchant-rule').reduce((sum, record) => sum + record.reward.value, 0)).toBe(-100);
      expect(records.filter((record) => record.ruleId === 'issuer-rule').reduce((sum, record) => sum + record.reward.value, 0)).toBe(-200);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('consumes shared spend and count pools once per transaction', () => {
    const dir = mkdtempSync(join(tmpdir(), 'card-rewards-shared-metrics-'));
    const store = new FileStore({ dataDir: dir });
    try {
      const service = new RewardService(store, undefined);
      service.registerCard({ id: 'card', issuer: 'Bank', productName: 'Card' });
      const pools = [
        { id: 'spend', metric: 'spend' as const, period: 'calendar_month' as const, limit: 10000, currency: 'TWD', timezone: 'Asia/Taipei' },
        { id: 'count', metric: 'transaction_count' as const, period: 'calendar_month' as const, limit: 1, timezone: 'Asia/Taipei' },
      ];
      service.upsertOffer(source, { ...rule('merchant-rule', 'merchant_loyalty', 100), capPoolRefs: ['spend', 'count'] }, undefined, pools);
      service.upsertOffer(source, { ...rule('issuer-rule', 'card_issuer', 200), capPoolRefs: ['spend', 'count'] });
      service.recordTransaction({ idempotencyKey: 'shared-1', cardId: 'card', kind: 'purchase', mode: 'actual', occurredAt: '2026-09-05T00:00:00Z', amount: { amountMinor: 10000, currency: 'TWD' } });
      expect(service.remainingCaps('card', '2026-09-05T00:00:00Z').map((cap) => cap.remaining.amountMinor).sort((a, b) => a - b)).toEqual([0, 0]);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
