import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { FileStore } from '../src/store.js';
import { RewardService } from '../src/service.js';
import type { OfferRuleVersion, OfferSourceSnapshot, TransactionTuple } from '../src/types.js';

const source: OfferSourceSnapshot = { id: 's', url: 'https://bank.example/offer', fetchedAt: '2026-09-01T00:00:00Z', contentHash: 'h', parserVersion: '1', verified: true };
const transaction: TransactionTuple = { cardId: 'selected-later', kind: 'purchase', mode: 'planned', occurredAt: '2026-09-05T00:00:00Z', amount: { amountMinor: 10000, currency: 'TWD' } };

describe('bounded recommendation pagination', () => {
  it('defaults to ten recommendations, supports twenty, and leaves planned ledger unchanged', () => {
    const dir = mkdtempSync(join(tmpdir(), 'card-rewards-recommendation-page-'));
    const store = new FileStore({ dataDir: dir });
    try {
      const service = new RewardService(store, undefined);
      for (let index = 0; index < 12; index += 1) {
        const id = `card-${String(index).padStart(2, '0')}`;
        service.registerCard({ id, issuer: 'Bank', productName: `Card ${index}` });
        const rule: OfferRuleVersion = { id: `rule-${id}`, cardId: id, version: '1', sourceSnapshotId: source.id, status: 'active', validFrom: '2026-01-01T00:00:00Z', settlementCurrency: 'TWD', match: {}, reward: { kind: 'percentage', rateBps: 100 } };
        service.upsertOffer(source, rule);
      }
      expect(service.recommend(transaction)).toHaveLength(10);
      expect(service.recommend(transaction, 20)).toHaveLength(12);
      expect(store.read().transactions).toHaveLength(0);
      expect(() => service.recommend(transaction, 0)).toThrow(/1 to 20/);
      expect(() => service.recommend(transaction, 21)).toThrow(/1 to 20/);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('allows planned recommendations to omit cardId because ranking supplies candidates', () => {
    const dir = mkdtempSync(join(tmpdir(), 'card-rewards-recommendation-unbound-'));
    const store = new FileStore({ dataDir: dir });
    try {
      const service = new RewardService(store, undefined);
      service.registerCard({ id: 'card-one', issuer: 'Bank', productName: 'Card One' });
      service.upsertOffer(source, { id: 'rule-card-one', cardId: 'card-one', version: '1', sourceSnapshotId: source.id, status: 'active', validFrom: '2026-01-01T00:00:00Z', settlementCurrency: 'TWD', match: {}, reward: { kind: 'percentage', rateBps: 100 } });
      const rows = service.recommend({ kind: 'purchase', mode: 'planned', occurredAt: '2026-09-05T00:00:00Z', amount: { amountMinor: 10000, currency: 'TWD' } });
      expect(rows[0]?.cardId).toBe('card-one');
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
