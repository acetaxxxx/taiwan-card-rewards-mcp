import { describe, expect, it } from 'vitest';
import { RewardService } from '../src/service.js';
import { emptyState, type LedgerStore, type StoredState } from '../src/store.js';
import type { OfferConfirmation, OfferRuleVersion, OfferSourceSnapshot } from '../src/types.js';

class MemoryStore implements LedgerStore {
  private state: StoredState = emptyState();
  read(): StoredState { return structuredClone(this.state); }
  write(next: StoredState): void { this.state = structuredClone(next); }
  update(mutator: (state: StoredState) => void): StoredState { const next = this.read(); mutator(next); this.write(next); return this.read(); }
  close(): void {}
}

const snapshot: OfferSourceSnapshot = {
  id: 'user-attestation-1', sourceType: 'user_input', fetchedAt: '2026-09-01T00:00:00Z', contentHash: 'terms-hash', parserVersion: 'user-statement-v1',
  provenance: { sourceDescription: 'User supplied correction in chat', submitter: 'alice', submittedAt: '2026-09-01T00:00:00Z', contentFingerprint: 'terms-fingerprint' },
};
const rule: OfferRuleVersion = { id: 'alice-offer-v1', familyId: 'alice-offer', cardId: 'card-1', version: '1', sourceSnapshotId: snapshot.id, status: 'candidate', validFrom: '2026-09-01T00:00:00Z', validTo: '2026-12-31T23:59:59Z', settlementCurrency: 'TWD', match: { countries: ['JP'] }, reward: { kind: 'percentage', rateBps: 300 } };
const confirmation: OfferConfirmation = { confirmedAt: '2026-09-02T00:00:00Z', confirmedBy: 'alice', trustBasis: 'user_confirmed', termsFingerprint: 'terms-fingerprint', offerPeriod: { validFrom: rule.validFrom, validTo: rule.validTo }, rewardUnit: 'TWD' };

describe('user-confirmed private offer versions', () => {
  it('does not activate an unconfirmed user correction', () => {
    const service = new RewardService(new MemoryStore(), 'alice');
    expect(() => service.upsertOffer(snapshot, { ...rule, status: 'active' })).toThrow(/confirmation/i);
    const candidate = service.upsertOffer(snapshot, rule).rule;
    expect(candidate.status).toBe('candidate');
    expect(candidate.ownerUser).toBe('alice');
  });

  it('activates without official URL and keeps trust metadata in recommendation', () => {
    const service = new RewardService(new MemoryStore(), 'alice');
    service.registerCard({ id: 'card-1', issuer: 'Issuer', productName: 'Card' });
    const result = service.upsertOffer(snapshot, rule, confirmation);
    expect(result.rule).toMatchObject({ status: 'active', ownerUser: 'alice', trustBasis: 'user_confirmed' });
    expect(result.snapshot.url).toBeUndefined();
    expect(service.searchActiveOffers({ cardId: 'card-1' }).offers).toHaveLength(1);
    const recommendation = service.recommendIntent({ merchant: 'JP Shop', amount: { amountMinor: 10000, currency: 'TWD' }, country: 'JP', occurredAt: '2026-09-15T00:00:00Z', cardIds: ['card-1'] });
    expect(recommendation.candidates[0]?.status).toBe('ready');
    expect(recommendation.candidates[0]?.matchedRules[0]).toMatchObject({ trustBasis: 'user_confirmed', confirmedAt: confirmation.confirmedAt });
  });

  it('isolates private versions by authenticated user', () => {
    const shared = new MemoryStore();
    const alice = new RewardService(shared, 'alice');
    alice.upsertOffer(snapshot, rule, confirmation);
    const bob = new RewardService(shared, 'bob');
    expect(bob.searchActiveOffers().offers).toHaveLength(0);
    expect(() => bob.confirmOffer(rule.id, confirmation)).toThrow(/not found|owner/i);
  });

  it('supersedes a private version without mutating the old version', () => {
    const service = new RewardService(new MemoryStore(), 'alice');
    service.upsertOffer(snapshot, rule, confirmation);
    const nextSnapshot = { ...snapshot, id: 'user-attestation-2', contentHash: 'terms-hash-2', provenance: { ...snapshot.provenance!, contentFingerprint: 'terms-fingerprint-2' } };
    const nextRule: OfferRuleVersion = { ...rule, id: 'alice-offer-v2', version: '2', sourceSnapshotId: nextSnapshot.id, supersedesRuleId: rule.id, supersessionReason: 'user_correction', reward: { kind: 'percentage', rateBps: 500 } };
    const nextConfirmation: OfferConfirmation = { ...confirmation, termsFingerprint: 'terms-fingerprint-2', confirmedAt: '2026-09-03T00:00:00Z' };
    service.upsertOffer(nextSnapshot, nextRule, nextConfirmation);
    const state = service.store.read();
    expect(state.rules.find((candidate) => candidate.id === rule.id)?.status).toBe('superseded');
    expect(state.rules.find((candidate) => candidate.id === nextRule.id)).toMatchObject({ status: 'active', reward: nextRule.reward });
  });
});
