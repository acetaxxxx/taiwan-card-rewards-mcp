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

  it('continues through the complete intent candidate set with a stable cursor', () => {
    const dir = mkdtempSync(join(tmpdir(), 'card-rewards-intent-page-'));
    const store = new FileStore({ dataDir: dir });
    try {
      const service = new RewardService(store, 'user');
      for (let index = 0; index < 31; index += 1) {
        const id = `card-${String(index).padStart(2, '0')}`;
        service.registerCard({ id, issuer: 'Bank', productName: `Card ${index}` });
        service.upsertOffer(source, { id: `rule-${id}`, cardId: id, version: '1', sourceSnapshotId: source.id, status: 'active', validFrom: '2026-01-01T00:00:00Z', settlementCurrency: 'TWD', match: {}, reward: { kind: 'percentage', rateBps: 100 } });
      }

      const first = service.recommendIntent({ merchant: 'Shop', amount: transaction.amount, occurredAt: transaction.occurredAt });
      expect(first.pageSize).toBe(10);
      expect(first.candidates).toHaveLength(10);
      expect(first.hasMore).toBe(true);
      expect(first.nextCursor).toBeTypeOf('string');
      expect(first.coverage.bounded).toBe(false);
      expect(first.coverage.explorationComplete).toBe(true);
      expect(first.coverage.total).toBe(31);

      const second = service.recommendIntent({ merchant: 'Shop', amount: transaction.amount, occurredAt: transaction.occurredAt, cursor: first.nextCursor });
      expect(second.resultVersion).toBe(first.resultVersion);
      expect(second.candidates).toHaveLength(10);
      expect(new Set([...first.candidates, ...second.candidates].map((candidate) => candidate.id)).size).toBe(20);

      const third = service.recommendIntent({ merchant: 'Shop', amount: transaction.amount, occurredAt: transaction.occurredAt, cursor: second.nextCursor });
      expect(third.candidates).toHaveLength(10);
      expect(third.hasMore).toBe(true);
      const fourth = service.recommendIntent({ merchant: 'Shop', amount: transaction.amount, occurredAt: transaction.occurredAt, cursor: third.nextCursor });
      expect(fourth.candidates).toHaveLength(1);
      expect(fourth.hasMore).toBe(false);
      expect(fourth.nextCursor).toBeUndefined();
      expect(new Set([...first.candidates, ...second.candidates, ...third.candidates, ...fourth.candidates].map((candidate) => candidate.id)).size).toBe(31);

      service.registerCard({ id: 'card-new', issuer: 'Bank', productName: 'New Card' });
      expect(() => service.recommendIntent({ merchant: 'Shop', amount: transaction.amount, occurredAt: transaction.occurredAt, cursor: first.nextCursor })).toThrow(/resultVersion changed/);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('supports stable limit plus page pagination as the primary continuation contract', () => {
    const dir = mkdtempSync(join(tmpdir(), 'card-rewards-intent-page-'));
    const store = new FileStore({ dataDir: dir });
    try {
      const service = new RewardService(store, 'u1');
      for (let index = 0; index < 21; index += 1) service.registerCard({ id: `page-card-${index}`, issuer: 'Bank', productName: `Card ${index}` });
      const first = service.recommendIntent({ merchant: 'Shop', amount: { amountMinor: 100, currency: 'TWD' }, occurredAt: '2026-09-10T00:00:00Z', limit: 10, page: 1 });
      const second = service.recommendIntent({ merchant: 'Shop', amount: { amountMinor: 100, currency: 'TWD' }, occurredAt: '2026-09-10T00:00:00Z', limit: 10, page: 2 });
      expect(first.page).toBe(1);
      expect(second.page).toBe(2);
      expect(first.candidates).toHaveLength(10);
      expect(second.candidates).toHaveLength(10);
      expect(second.candidates.every((candidate) => !first.candidates.some((firstCandidate) => firstCandidate.id === candidate.id))).toBe(true);
      expect(second.hasMore).toBe(true);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('keeps all applicable rules attached to one route when candidate pages are small', () => {
    const dir = mkdtempSync(join(tmpdir(), 'card-rewards-route-rules-page-'));
    const store = new FileStore({ dataDir: dir });
    try {
      const service = new RewardService(store, 'u1');
      const evidence = service.submitEvidence({ id: 'route-page-evidence', requirementId: 'route', sourceIdentity: 'merchant', sourceType: 'official', authority: 'merchant', claim: { route: 'route-page' }, observedAt: '2026-09-01T00:00:00Z', confidence: 'high', contentHash: 'route-page', reviewState: 'accepted', sourceUrl: 'https://merchant.example/payment' });
      const route = service.upsertPaymentRoute({ status: 'active', idempotencyKey: 'route-page', layers: [], funding: { kind: 'cash' }, observedAt: '2026-09-01T00:00:00Z', sourceUrl: 'https://merchant.example/payment', authority: 'merchant', confidence: 'high', evidenceIds: [evidence.id], nodes: [{ id: 'cash', kind: 'funding_source', displayName: 'cash' }, { id: 'merchant', kind: 'merchant', displayName: 'merchant' }], edges: [{ edgeId: 'settle', fromNodeId: 'cash', toNodeId: 'merchant', transition: 'direct_settlement', evidenceIds: [evidence.id] }], confirmation: { confirmedAt: '2026-09-01T00:00:00Z', confirmedBy: 'u1' } });
      for (let index = 0; index < 12; index += 1) service.upsertOffer(source, { id: `route-rule-${index}`, routeId: route.id, version: '1', sourceSnapshotId: source.id, status: 'active', validFrom: '2026-01-01T00:00:00Z', settlementCurrency: 'TWD', match: {}, reward: { kind: 'flat', amountMinor: index + 1, currency: 'TWD' }, componentKind: 'payment_provider', stacking: 'confirmed', combination: { mode: 'additive', groupId: `route-rule-${index}`, version: '1' } });
      const result = service.recommendIntent({ merchant: 'Shop', amount: { amountMinor: 1000, currency: 'TWD' }, occurredAt: '2026-09-02T00:00:00Z', routeIds: [route.id], limit: 1, page: 1 });
      expect(result.candidates).toHaveLength(1);
      expect(result.candidates[0]?.matchedRules).toHaveLength(12);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
