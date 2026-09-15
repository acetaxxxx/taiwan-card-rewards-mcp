import { describe, expect, it } from 'vitest';
import { RewardService } from '../src/service.js';
import { emptyState, type LedgerStore, type StoredState } from '../src/store.js';
import { validatePaymentRouteSelector } from '../src/validation.js';

class MemoryStore implements LedgerStore {
  private state: StoredState = emptyState();
  read() { return structuredClone(this.state); }
  write(next: StoredState) { this.state = structuredClone(next); }
  update(mutator: (state: StoredState) => void) { const next = this.read(); mutator(next); this.write(next); return this.read(); }
  close() {}
}

describe('Offer Route Selector and Payment Route Generation', () => {
  it('validates PaymentRouteSelector with open service identifiers and enforces fail-closed types', () => {
    // Open identifiers without enums
    const valid = validatePaymentRouteSelector({
      paymentServiceAllowlist: ['custom_pay_alpha', 'vendor_beta_wallet'],
      acceptanceNetworkAllowlist: ['network_taiwan_qr', 'network_emvco'],
      fundingKinds: ['credit_card', 'account'],
      nodeRoles: ['funding_source', 'payment_service', 'merchant'],
      transitions: ['card_authorization', 'merchant_settlement'],
      excludedTransitions: ['wallet_top_up'],
      validFrom: '2026-01-01T00:00:00Z',
      validTo: '2026-12-31T23:59:59Z',
    });
    expect(valid.paymentServiceAllowlist).toEqual(['custom_pay_alpha', 'vendor_beta_wallet']);
    expect(valid.paymentServices).toEqual(['custom_pay_alpha', 'vendor_beta_wallet']);
    expect(valid.fundingKinds).toEqual(['credit_card', 'account']);
    expect(valid.transitions).toEqual(['card_authorization', 'merchant_settlement']);

    // Invalid fundingKind fails closed
    expect(() => validatePaymentRouteSelector({ fundingKinds: ['crypto_currency'] })).toThrow(/fundingKind is invalid/);

    // Invalid nodeRole fails closed
    expect(() => validatePaymentRouteSelector({ nodeRoles: ['invalid_role'] })).toThrow(/nodeRole is invalid/);

    // Invalid transition fails closed
    expect(() => validatePaymentRouteSelector({ transitions: ['teleport'] })).toThrow(/transition is invalid/);
  });

  it('matches multi-service allowlist (LINE Pay + JKO Pay) while unlisted service (PXPay) remains ready without rewards', () => {
    const store = new MemoryStore();
    const service = new RewardService(store, 'u1');
    service.registerCard({ id: 'card-tw-1', issuer: 'CTBC', productName: 'LinePay Card' });

    // Official evidence for capabilities
    const evidence = service.submitEvidence({
      id: 'ev-capabilities', requirementId: 'cap', sourceIdentity: 'merchant-portal', sourceType: 'official',
      authority: 'merchant', claim: { accepted: 'line_pay,jko_pay,px_pay' }, observedAt: '2026-09-01T00:00:00Z',
      confidence: 'high', contentHash: 'ev-hash', reviewState: 'accepted', sourceUrl: 'https://merchant.example/pay',
    });

    // Capabilities: LINE Pay, JKO Pay, and PX Pay (all support direct credit card authorization at this merchant)
    const capLinePay = service.upsertPaymentCapability({
      providerId: 'line_pay', consumerAppId: 'line_pay_app', acceptanceProviderId: 'line_network',
      fundingKinds: ['credit_card'], transitions: ['card_authorization', 'service_to_acceptance', 'merchant_settlement'],
      sourceUrl: 'https://merchant.example/pay', evidenceIds: [evidence.id], observedAt: '2026-09-01T00:00:00Z',
      idempotencyKey: 'cap-line-pay',
    });

    const capJkoPay = service.upsertPaymentCapability({
      providerId: 'jko_pay', consumerAppId: 'jko_pay_app', acceptanceProviderId: 'jko_network',
      fundingKinds: ['credit_card'], transitions: ['card_authorization', 'service_to_acceptance', 'merchant_settlement'],
      sourceUrl: 'https://merchant.example/pay', evidenceIds: [evidence.id], observedAt: '2026-09-01T00:00:00Z',
      idempotencyKey: 'cap-jko-pay',
    });

    const capPxPay = service.upsertPaymentCapability({
      providerId: 'px_pay', consumerAppId: 'px_pay_app', acceptanceProviderId: 'px_network',
      fundingKinds: ['credit_card'], transitions: ['card_authorization', 'service_to_acceptance', 'merchant_settlement'],
      sourceUrl: 'https://merchant.example/pay', evidenceIds: [evidence.id], observedAt: '2026-09-01T00:00:00Z',
      idempotencyKey: 'cap-px-pay',
    });

    // Offer snapshot and rule: 10% reward on LINE Pay or JKO Pay only
    const snapshot = {
      id: 'snap-mobile-offer', url: 'https://ctbc.example/offers/mobile-10', fetchedAt: '2026-09-01T00:00:00Z',
      contentHash: 'mobile-hash', parserVersion: '1', verified: true as const,
    };
    service.upsertOffer(snapshot, {
      id: 'rule-mobile-pay-10', version: '1', cardId: 'card-tw-1', sourceSnapshotId: snapshot.id, status: 'active',
      validFrom: '2026-01-01T00:00:00Z', settlementCurrency: 'TWD', match: {},
      reward: { kind: 'percentage', rateBps: 1000, roundingMode: 'floor' },
      routeSelector: {
        paymentServiceAllowlist: ['line_pay', 'jko_pay'],
        fundingKinds: ['credit_card'],
        transitions: ['card_authorization'],
      },
    });

    // Execute planned recommendation
    const result = service.recommendIntent({
      merchant: 'shop', amount: { amountMinor: 1000, currency: 'TWD' }, occurredAt: '2026-09-10T00:00:00Z',
    });

    // 1. LINE Pay candidate is generated, ready, and receives 100 TWD reward
    const linePayCandidate = result.candidates.find((c) => c.routeId?.includes(capLinePay.id));
    expect(linePayCandidate).toBeDefined();
    expect(linePayCandidate?.status).toBe('ready');
    expect(linePayCandidate?.reward).toEqual({ amountMinor: 100, currency: 'TWD' });
    expect(linePayCandidate?.netSpend).toEqual({ amountMinor: 900, currency: 'TWD' });
    expect(linePayCandidate?.matchedRules).toEqual([expect.objectContaining({ ruleId: 'rule-mobile-pay-10', status: 'matched' })]);

    // 2. JKO Pay candidate is generated, ready, and receives 100 TWD reward
    const jkoPayCandidate = result.candidates.find((c) => c.routeId?.includes(capJkoPay.id));
    expect(jkoPayCandidate).toBeDefined();
    expect(jkoPayCandidate?.status).toBe('ready');
    expect(jkoPayCandidate?.reward).toEqual({ amountMinor: 100, currency: 'TWD' });
    expect(jkoPayCandidate?.netSpend).toEqual({ amountMinor: 900, currency: 'TWD' });
    expect(jkoPayCandidate?.matchedRules).toEqual([expect.objectContaining({ ruleId: 'rule-mobile-pay-10', status: 'matched' })]);

    // 3. PX Pay candidate is generated and ready to pay, but NOT in allowlist: no reward, netSpend is full amount
    const pxPayCandidate = result.candidates.find((c) => c.routeId?.includes(capPxPay.id));
    expect(pxPayCandidate).toBeDefined();
    expect(pxPayCandidate?.status).toBe('ready');
    expect(pxPayCandidate?.reward).toBeUndefined();
    expect(pxPayCandidate?.netSpend).toEqual({ amountMinor: 1000, currency: 'TWD' });
    expect(pxPayCandidate?.matchedRules).toEqual([]);

    // 4. Ephemeral routes: no routes were persisted to durable store
    expect(store.read().paymentRoutes).toHaveLength(0);
    expect(service.listPaymentRoutes()).toHaveLength(0);
  });

  it('differentiates top-up vs direct authorization using routeSelector transitions', () => {
    const store = new MemoryStore();
    const service = new RewardService(store, 'u1');
    service.registerCard({ id: 'card-1', issuer: 'Bank', productName: 'Card' });

    const evidence = service.submitEvidence({
      id: 'ev-topup-vs-direct', requirementId: 'cap', sourceIdentity: 'wallet', sourceType: 'official',
      authority: 'wallet', claim: { routes: 'topup,direct' }, observedAt: '2026-09-01T00:00:00Z',
      confidence: 'high', contentHash: 'hash-1', reviewState: 'accepted', sourceUrl: 'https://wallet.example',
    });

    // Capability 1: Top-up only (wallet_top_up -> wallet_debit -> merchant_settlement)
    const capTopUp = service.upsertPaymentCapability({
      providerId: 'wallet-topup', consumerAppId: 'wallet-app', acceptanceProviderId: 'qr-net',
      fundingKinds: ['credit_card'], transitions: ['wallet_top_up', 'wallet_debit', 'merchant_settlement'],
      sourceUrl: 'https://wallet.example', evidenceIds: [evidence.id], observedAt: '2026-09-01T00:00:00Z',
      idempotencyKey: 'cap-topup',
    });

    // Capability 2: Direct Authorization only (card_authorization -> service_to_acceptance -> merchant_settlement)
    const capDirect = service.upsertPaymentCapability({
      providerId: 'wallet-direct', consumerAppId: 'wallet-app', acceptanceProviderId: 'qr-net',
      fundingKinds: ['credit_card'], transitions: ['card_authorization', 'service_to_acceptance', 'merchant_settlement'],
      sourceUrl: 'https://wallet.example', evidenceIds: [evidence.id], observedAt: '2026-09-01T00:00:00Z',
      idempotencyKey: 'cap-direct',
    });

    // Offer Rule: applies ONLY to direct authorization (excludes top-up)
    const snapshot = {
      id: 'snap-direct-only', url: 'https://bank.example/terms', fetchedAt: '2026-09-01T00:00:00Z',
      contentHash: 'hash-direct', parserVersion: '1', verified: true as const,
    };
    service.upsertOffer(snapshot, {
      id: 'rule-direct-only', version: '1', cardId: 'card-1', sourceSnapshotId: snapshot.id, status: 'active',
      validFrom: '2026-01-01T00:00:00Z', settlementCurrency: 'TWD', match: {},
      reward: { kind: 'flat', amountMinor: 50, currency: 'TWD' },
      routeSelector: {
        fundingKinds: ['credit_card'],
        transitions: ['card_authorization'],
        excludedTransitions: ['wallet_top_up'],
      },
    });

    const result = service.recommendIntent({
      merchant: 'shop', amount: { amountMinor: 500, currency: 'TWD' }, occurredAt: '2026-09-10T00:00:00Z',
    });

    // Direct authorization route matches and receives reward
    const directCandidate = result.candidates.find((c) => c.routeId?.includes(capDirect.id));
    expect(directCandidate).toBeDefined();
    expect(directCandidate?.status).toBe('ready');
    expect(directCandidate?.reward).toEqual({ amountMinor: 50, currency: 'TWD' });

    // Top-up route does NOT match rule (excluded by selector)
    const topUpCandidate = result.candidates.find((c) => c.routeId?.includes(capTopUp.id));
    expect(topUpCandidate).toBeDefined();
    expect(topUpCandidate?.matchedRules).toEqual([]);
  });

  it('supports multiple funding kinds (credit card, bank account, cash) and evaluates selectors per funding kind', () => {
    const store = new MemoryStore();
    const service = new RewardService(store, 'u1');
    service.registerCard({ id: 'my-card', issuer: 'Bank', productName: 'MyCard' });
    const account = service.upsertPaymentAccount({
      providerId: 'bank-acct', kind: 'linked_bank_account', displayName: 'Checking', status: 'active',
      observedAt: '2026-09-01T00:00:00Z', confirmation: { confirmedAt: '2026-09-01T00:00:00Z', confirmedBy: 'u1' },
      idempotencyKey: 'my-acct',
    });

    const evidence = service.submitEvidence({
      id: 'ev-all-fundings', requirementId: 'cap', sourceIdentity: 'pos-vendor', sourceType: 'official',
      authority: 'merchant', claim: { methods: 'card,account,cash' }, observedAt: '2026-09-01T00:00:00Z',
      confidence: 'high', contentHash: 'hash-all', reviewState: 'accepted', sourceUrl: 'https://pos.example',
    });

    // Capability 1: Card direct auth
    const capCard = service.upsertPaymentCapability({
      providerId: 'pos-card', acceptanceProviderId: 'visa-net', fundingKinds: ['credit_card'],
      transitions: ['card_authorization', 'service_to_acceptance', 'merchant_settlement'],
      sourceUrl: 'https://pos.example', evidenceIds: [evidence.id], observedAt: '2026-09-01T00:00:00Z',
      idempotencyKey: 'cap-card',
    });

    // Capability 2: Account direct debit
    const capAccount = service.upsertPaymentCapability({
      providerId: 'pos-twqr', acceptanceProviderId: 'twqr-net', fundingKinds: ['account'],
      transitions: ['account_debit', 'service_to_acceptance', 'merchant_settlement'],
      sourceUrl: 'https://pos.example', evidenceIds: [evidence.id], observedAt: '2026-09-01T00:00:00Z',
      idempotencyKey: 'cap-acct',
    });

    // Capability 3: Cash direct settlement
    const capCash = service.upsertPaymentCapability({
      providerId: 'pos-cash', fundingKinds: ['cash'], transitions: ['direct_settlement'],
      sourceUrl: 'https://pos.example', evidenceIds: [evidence.id], observedAt: '2026-09-01T00:00:00Z',
      idempotencyKey: 'cap-cash',
    });

    // Offer for Account Debit only (e.g. TWQR 5% cashback)
    const snapshot = {
      id: 'snap-account-offer', url: 'https://twqr.example/offer', fetchedAt: '2026-09-01T00:00:00Z',
      contentHash: 'hash-twqr', parserVersion: '1', verified: true as const,
    };
    service.upsertOffer(snapshot, {
      id: 'rule-account-5', version: '1', sourceSnapshotId: snapshot.id, status: 'active',
      validFrom: '2026-01-01T00:00:00Z', settlementCurrency: 'TWD', match: {},
      reward: { kind: 'percentage', rateBps: 500 },
      componentKind: 'payment_provider',
      routeSelector: {
        fundingKinds: ['account'],
        transitions: ['account_debit'],
      },
    });

    const result = service.recommendIntent({
      merchant: 'supermarket', amount: { amountMinor: 2000, currency: 'TWD' }, occurredAt: '2026-09-10T00:00:00Z',
    });

    // 1. Account route: generated, matches the rule, gets 100 TWD reward
    const accountCandidate = result.candidates.find((c) => c.routeId?.includes(capAccount.id));
    expect(accountCandidate).toBeDefined();
    expect(accountCandidate?.status).toBe('ready');
    expect(accountCandidate?.reward).toEqual({ amountMinor: 100, currency: 'TWD' });

    // 2. Card route: generated and ready, but fundingKind mismatch -> no reward
    const cardCandidate = result.candidates.find((c) => c.routeId?.includes(capCard.id));
    expect(cardCandidate).toBeDefined();
    expect(cardCandidate?.status).toBe('ready');
    expect(cardCandidate?.reward).toBeUndefined();
    expect(cardCandidate?.netSpend).toEqual({ amountMinor: 2000, currency: 'TWD' });

    // 3. Cash route: generated and ready, no reward claimed
    const cashCandidate = result.candidates.find((c) => c.routeId?.includes(capCash.id));
    expect(cashCandidate).toBeDefined();
    expect(cashCandidate?.status).toBe('ready');
    expect(cashCandidate?.reward).toBeUndefined();
    expect(cashCandidate?.netSpend).toEqual({ amountMinor: 2000, currency: 'TWD' });
  });

  it('preserves strict separation: OfferRouteSelector cannot create feasible routes without PaymentCapability', () => {
    const store = new MemoryStore();
    const service = new RewardService(store, 'u1');
    service.registerCard({ id: 'my-card', issuer: 'Bank', productName: 'Card' });

    // Register an offer that specifies payment services allowlist: ['fictional_pay']
    const snapshot = {
      id: 'snap-fictional', url: 'https://offer.example', fetchedAt: '2026-09-01T00:00:00Z',
      contentHash: 'hash-fic', parserVersion: '1', verified: true as const,
    };
    service.upsertOffer(snapshot, {
      id: 'rule-fictional-pay', version: '1', cardId: 'my-card', sourceSnapshotId: snapshot.id, status: 'active',
      validFrom: '2026-01-01T00:00:00Z', settlementCurrency: 'TWD', match: {},
      reward: { kind: 'flat', amountMinor: 200, currency: 'TWD' },
      routeSelector: { paymentServiceAllowlist: ['fictional_pay'] },
    });

    // Merchant has NO PaymentCapability for 'fictional_pay'
    const result = service.recommendIntent({
      merchant: 'shop', amount: { amountMinor: 1000, currency: 'TWD' }, occurredAt: '2026-09-10T00:00:00Z',
    });

    // No route is fabricated for fictional_pay because no PaymentCapability exists to define route feasibility
    const fictionalCandidate = result.candidates.find((c) => c.routeId?.includes('fictional_pay'));
    expect(fictionalCandidate).toBeUndefined();
  });
});
