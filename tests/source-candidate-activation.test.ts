import { describe, expect, it, beforeEach } from 'vitest';
import { RewardService } from '../src/service.js';
import { emptyState, type LedgerStore, type StoredState } from '../src/store.js';
import { mcpTools } from '../src/mcp-contract.js';
import { validateConfirmation, validateSnapshot, validateRule, validateToolArgs } from '../src/validation.js';
import type { OfferConfirmation, OfferRuleVersion, OfferSourceSnapshot, TransactionTuple } from '../src/types.js';

class InMemoryLedgerStore implements LedgerStore {
  private state: StoredState = emptyState();
  read(): StoredState { return structuredClone(this.state); }
  write(next: StoredState): void { this.state = structuredClone(next); }
  update(mutator: (state: StoredState) => void): StoredState {
    const next = this.read();
    mutator(next);
    this.write(next);
    return this.read();
  }
  close(): void {}
}

describe('Ticket 04 & Contract Convergence: 10 tools and Offer Confirmation in upsert_offer', () => {
  let store: InMemoryLedgerStore;
  let service: RewardService;

  beforeEach(() => {
    store = new InMemoryLedgerStore();
    service = new RewardService(store, 'test-user');
  });

  const validSnapshot: OfferSourceSnapshot = {
    id: 'snap-1',
    url: 'https://bank.example/promo-2026',
    fetchedAt: '2026-08-01T00:00:00Z',
    contentHash: 'hash-abc',
    parserVersion: '1.0',
    validFrom: '2026-08-01T00:00:00Z',
    validTo: '2026-12-31T23:59:59Z',
    provenance: {
      sourceUrl: 'https://bank.example/promo-2026',
      submitter: 'user',
      submittedAt: '2026-08-01T00:00:00Z',
      contentFingerprint: 'fp-123',
    },
  };

  const candidateRule: OfferRuleVersion = {
    id: 'rule-cand-1',
    cardId: 'card-1',
    version: '2026.1',
    sourceSnapshotId: 'snap-1',
    status: 'candidate',
    validFrom: '2026-08-01T00:00:00Z',
    validTo: '2026-12-31T23:59:59Z',
    settlementCurrency: 'TWD',
    match: { countries: ['JP'] },
    reward: { kind: 'percentage', rateBps: 300 },
  };

  it('maintains exactly 10 public MCP tools and does not expose a standalone confirm_offer tool', () => {
    expect(mcpTools).toHaveLength(10);
    const toolNames = mcpTools.map((t) => t.name);
    expect(toolNames).not.toContain('confirm_offer');
    expect(toolNames).toContain('upsert_offer');
    expect(() => validateToolArgs('confirm_offer', {})).toThrow(/TOOL_NOT_FOUND/);
  });

  it('stores candidate offer with provenance, and candidate rule fails closed in evaluation/recommendation', () => {
    service.registerCard({ id: 'card-1', issuer: 'Example Bank', productName: 'Travel Card' });
    service.upsertOffer(validSnapshot, candidateRule);

    const tx: TransactionTuple = {
      cardId: 'card-1',
      kind: 'purchase',
      mode: 'planned',
      occurredAt: '2026-08-15T12:00:00Z',
      amount: { amountMinor: 50000, currency: 'TWD' },
      country: 'JP',
    };

    const recs = service.recommend(tx);
    expect(recs).toHaveLength(1);
    expect(recs[0].status).toBe('needs_review');
    expect(recs[0].unknownReasons).toContain('rule status is candidate');
  });

  it('enforces immutability: rejects conflicting mutation of existing snapshot or rule version', () => {
    service.upsertOffer(validSnapshot, candidateRule);

    // Overwriting snapshot with different contentHash
    const modifiedSnapshot: OfferSourceSnapshot = { ...validSnapshot, contentHash: 'different-hash' };
    expect(() => service.upsertOffer(modifiedSnapshot, candidateRule)).toThrow(/immutable/i);

    // Overwriting rule version with different terms without version bump
    const modifiedRule: OfferRuleVersion = { ...candidateRule, reward: { kind: 'percentage', rateBps: 500 } };
    expect(() => service.upsertOffer(validSnapshot, modifiedRule)).toThrow(/immutable/i);
  });

  it('rejects candidate activation via upsert_offer if confirmation is missing required semantics or provenance is invalid', () => {
    service.upsertOffer(validSnapshot, candidateRule);

    // Missing sourceReference
    const badConfirmation1 = {
      confirmedAt: '2026-08-02T00:00:00Z',
      confirmedBy: 'user-1',
      rewardUnit: 'TWD',
      offerPeriod: { validFrom: '2026-08-01T00:00:00Z' },
    } as any;
    expect(() => service.upsertOffer(validSnapshot, { ...candidateRule, status: 'active' }, badConfirmation1)).toThrow();

    // Currency mismatch with settlement currency
    const badConfirmation2: OfferConfirmation = {
      confirmedAt: '2026-08-02T00:00:00Z',
      confirmedBy: 'user-1',
      sourceReference: 'https://bank.example/promo-2026',
      rewardUnit: 'USD',
      offerPeriod: { validFrom: '2026-08-01T00:00:00Z' },
    };
    expect(() => service.upsertOffer(validSnapshot, { ...candidateRule, status: 'active' }, badConfirmation2)).toThrow(/currency|unit/i);
  });

  it('successfully transitions candidate rule to active via upsert_offer with valid Offer Confirmation', () => {
    service.registerCard({ id: 'card-1', issuer: 'Example Bank', productName: 'Travel Card' });
    service.upsertOffer(validSnapshot, candidateRule);

    const validConfirmation: OfferConfirmation = {
      confirmedAt: '2026-08-02T00:00:00Z',
      confirmedBy: 'user-1',
      sourceReference: 'https://bank.example/promo-2026',
      rewardUnit: 'TWD',
      offerPeriod: { validFrom: '2026-08-01T00:00:00Z', validTo: '2026-12-31T23:59:59Z' },
      rewardConditionsSummary: '3% in JP',
    };

    const result = service.upsertOffer(validSnapshot, { ...candidateRule, status: 'active' }, validConfirmation);
    expect(result.rule.status).toBe('active');
    expect(result.rule.confirmation).toEqual(validConfirmation);
    expect(result.snapshot.verified).toBe(true);

    const tx: TransactionTuple = {
      cardId: 'card-1',
      kind: 'purchase',
      mode: 'planned',
      occurredAt: '2026-08-15T12:00:00Z',
      amount: { amountMinor: 10000, currency: 'TWD' },
      country: 'JP',
    };

    const recs = service.recommend(tx);
    expect(recs).toHaveLength(1);
    expect(recs[0].status).toBe('ok');
    expect(recs[0].grossReward?.amountMinor).toBe(300);
  });
});
