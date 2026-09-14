import { describe, expect, it } from 'vitest';
import { RewardService } from '../src/service.js';
import { emptyState, type LedgerStore, type StoredState } from '../src/store.js';
import type { CardDescriptor, FxSnapshot, OfferRuleVersion, PaymentRouteRecord, TransactionTuple } from '../src/types.js';
import { isFxCompatible, findBestMatchingFx, getFxScopeSpecificity, isFxFresh } from '../src/fx.js';

class MemoryStore implements LedgerStore {
  private state = emptyState();
  read() { return structuredClone(this.state); }
  write(state: StoredState) { this.state = structuredClone(state); }
  update(change: (state: StoredState) => void) { const state = this.read(); change(state); this.write(state); return this.read(); }
  close() {}
}

const at = '2026-09-10T12:00:00Z';

function addCardRule(service: RewardService, cardId: string, ruleId: string, settlementCurrency = 'TWD', bps = 300) {
  service.upsertOffer(
    { id: `source-${ruleId}`, url: `https://issuer.example/${ruleId}`, fetchedAt: at, contentHash: ruleId, parserVersion: '1', verified: true },
    { id: ruleId, cardId, version: '1', sourceSnapshotId: `source-${ruleId}`, status: 'active', validFrom: '2026-01-01T00:00:00Z', settlementCurrency, match: {}, reward: { kind: 'percentage', rateBps: bps } },
  );
}

describe('Ticket 05: Compatible key FX reuse, isolation, scope precedence, and path costs', () => {
  describe('1. FX Compatibility & Specificity helper tests', () => {
    it('compares currency, rate direction, timing, owner, rate type, card scheme, and freshness', () => {
      const baseSnapshot: FxSnapshot = {
        id: 'fx-jcb-fresh',
        baseCurrency: 'JPY',
        quoteCurrency: 'TWD',
        ratePpm: 215_000,
        capturedAt: at,
        provider: 'JCB',
        cardScheme: 'JCB',
        rateType: 'card_scheme',
        conversionOwner: 'card_scheme',
        rateDirection: 'base_to_quote',
        conversionTiming: 'clearing',
        maxAgeSeconds: 3600,
      };

      // Exact match
      expect(isFxCompatible({
        snapshot: baseSnapshot,
        context: {
          baseCurrency: 'JPY',
          quoteCurrency: 'TWD',
          conversionOwner: 'card_scheme',
          cardScheme: 'JCB',
          rateDirection: 'base_to_quote',
          conversionTiming: 'clearing',
          asOf: at,
          requireFresh: true,
        },
      })).toBe(true);

      // Currency mismatch
      expect(isFxCompatible({
        snapshot: baseSnapshot,
        context: { baseCurrency: 'USD', quoteCurrency: 'TWD' },
      })).toBe(false);

      // Rate direction mismatch
      expect(isFxCompatible({
        snapshot: baseSnapshot,
        context: { baseCurrency: 'JPY', quoteCurrency: 'TWD', rateDirection: 'quote_to_base' },
      })).toBe(false);

      // Conversion timing mismatch
      expect(isFxCompatible({
        snapshot: baseSnapshot,
        context: { baseCurrency: 'JPY', quoteCurrency: 'TWD', conversionTiming: 'posting' },
      })).toBe(false);

      // Conversion owner mismatch: wallet cannot use card_scheme
      expect(isFxCompatible({
        snapshot: baseSnapshot,
        context: { baseCurrency: 'JPY', quoteCurrency: 'TWD', conversionOwner: 'wallet' },
      })).toBe(false);

      // Card scheme mismatch: Visa cannot use JCB
      expect(isFxCompatible({
        snapshot: baseSnapshot,
        context: { baseCurrency: 'JPY', quoteCurrency: 'TWD', conversionOwner: 'card_scheme', cardScheme: 'VISA' },
      })).toBe(false);

      // Freshness check
      expect(isFxFresh(baseSnapshot, at)).toBe(true);
      expect(isFxFresh(baseSnapshot, '2026-09-10T14:00:00Z')).toBe(false); // 2h > 3600s
    });

    it('calculates scope specificity hierarchy correctly', () => {
      const context = {
        baseCurrency: 'USD',
        quoteCurrency: 'TWD',
        cardId: 'card-1',
        issuer: 'BankA',
        routeId: 'route-1',
        edgeId: 'edge-1',
      };
      const general: FxSnapshot = { id: 'g', baseCurrency: 'USD', quoteCurrency: 'TWD', ratePpm: 30_000_000, capturedAt: at, provider: 'P', rateType: 'spot_selling' };
      const issuer: FxSnapshot = { ...general, id: 'i', issuerScope: 'BankA' };
      const card: FxSnapshot = { ...general, id: 'c', cardIdScope: 'card-1' };
      const route: FxSnapshot = { ...general, id: 'r', routeIdScope: 'route-1' };
      const edge: FxSnapshot = { ...general, id: 'e', routeIdScope: 'route-1', edgeIdScope: 'edge-1' };

      expect(getFxScopeSpecificity(general, context)).toBe(1);
      expect(getFxScopeSpecificity(issuer, context)).toBe(2);
      expect(getFxScopeSpecificity(card, context)).toBe(3);
      expect(getFxScopeSpecificity(route, context)).toBe(4);
      expect(getFxScopeSpecificity(edge, context)).toBe(5);

      const best = findBestMatchingFx([general, issuer, route, card, edge], context);
      expect(best?.id).toBe('e');
    });
  });

  describe('2. Candidate quote reuse across cards with identical clearing conditions', () => {
    it('groups direct cards with the same card scheme and reuses one fresh quote', () => {
      const store = new MemoryStore();
      const service = new RewardService(store, 'u1');

      const cardJcb1: CardDescriptor = { id: 'jcb-1', issuer: 'BankA', productName: 'JCB Card 1', network: 'JCB', country: 'TW' };
      const cardJcb2: CardDescriptor = { id: 'jcb-2', issuer: 'BankB', productName: 'JCB Card 2', network: 'JCB', country: 'TW' };
      const cardVisa: CardDescriptor = { id: 'visa-1', issuer: 'BankA', productName: 'Visa Card', network: 'VISA', country: 'TW' };

      service.registerCard(cardJcb1);
      service.registerCard(cardJcb2);
      service.registerCard(cardVisa);

      addCardRule(service, 'jcb-1', 'rule-jcb-1', 'TWD', 300);
      addCardRule(service, 'jcb-2', 'rule-jcb-2', 'TWD', 250);
      addCardRule(service, 'visa-1', 'rule-visa-1', 'TWD', 200);

      // Preflight without FX
      const initial = service.recommendIntent({
        merchant: 'Tokyo Hotel',
        amount: { amountMinor: 10_000, currency: 'JPY' },
        occurredAt: at,
      });

      // JCB cards share 1 action with scope { kind: 'card_scheme', cardScheme: 'JCB' }
      const jcbAction = initial.requiredActions.find((a) => a.fxResolutionRequest?.cardScheme === 'JCB');
      expect(jcbAction).toBeDefined();
      expect(jcbAction?.candidateIds).toContain('card:jcb-1');
      expect(jcbAction?.candidateIds).toContain('card:jcb-2');
      expect(jcbAction?.candidateIds).not.toContain('card:visa-1');

      const visaAction = initial.requiredActions.find((a) => a.fxResolutionRequest?.cardScheme === 'VISA');
      expect(visaAction).toBeDefined();
      expect(visaAction?.candidateIds).toEqual(['card:visa-1']);

      // Now provide a single fresh JCB quote
      const jcbFx: FxSnapshot = {
        id: 'fx-jcb-shared',
        baseCurrency: 'JPY',
        quoteCurrency: 'TWD',
        ratePpm: 215_000, // 0.215
        capturedAt: at,
        provider: 'JCB',
        cardScheme: 'JCB',
        rateType: 'card_scheme',
      };

      const withJcbFx = service.recommendIntent({
        merchant: 'Tokyo Hotel',
        amount: { amountMinor: 10_000, currency: 'JPY' },
        occurredAt: at,
        fx: jcbFx,
      });

      const candJcb1 = withJcbFx.candidates.find((c) => c.id === 'card:jcb-1');
      const candJcb2 = withJcbFx.candidates.find((c) => c.id === 'card:jcb-2');
      const candVisa = withJcbFx.candidates.find((c) => c.id === 'card:visa-1');

      // Both JCB cards successfully reuse the single JCB quote!
      expect(candJcb1?.status).toBe('ready');
      expect(candJcb1?.fxEstimate?.status).toBe('estimated');
      expect(candJcb2?.status).toBe('ready');
      expect(candJcb2?.fxEstimate?.status).toBe('estimated');

      // Visa card must NOT erroneously share the JCB quote and remains unresolved/unavailable
      expect(candVisa?.status).toBe('unknown');
      expect(candVisa?.fxEstimate?.status).toBe('unavailable');
    });
  });

  describe('3. Strict clearing context isolation', () => {
    it('isolates bank rates, wallet rates, DCC rates, and card schemes from sharing', () => {
      const store = new MemoryStore();
      const service = new RewardService(store, 'u1');

      const card = service.registerCard({ id: 'jcb-card', issuer: 'BankA', productName: 'JCB', network: 'JCB' });
      addCardRule(service, 'jcb-card', 'jcb-rule', 'TWD', 300);

      const bankQuote: FxSnapshot = {
        id: 'bank-fx',
        baseCurrency: 'JPY',
        quoteCurrency: 'TWD',
        ratePpm: 220_000,
        capturedAt: at,
        provider: 'Bank of Taiwan',
        conversionOwner: 'issuer',
        rateType: 'cash_selling',
      };

      // Card scheme conversion cannot use bank cash selling rate
      const resBank = service.recommendIntent({
        merchant: 'Shop',
        amount: { amountMinor: 10_000, currency: 'JPY' },
        occurredAt: at,
        fx: bankQuote,
      });
      expect(resBank.candidates.find((c) => c.id === 'card:jcb-card')?.status).toBe('unknown');
      expect(resBank.candidates.find((c) => c.id === 'card:jcb-card')?.fxEstimate?.status).toBe('unavailable');

      // Card scheme conversion cannot use DCC rate
      const dccQuote: FxSnapshot = {
        id: 'dcc-fx',
        baseCurrency: 'JPY',
        quoteCurrency: 'TWD',
        ratePpm: 230_000,
        capturedAt: at,
        provider: 'Shop DCC',
        conversionOwner: 'merchant_dcc',
        rateType: 'spot_selling',
      };
      const resDcc = service.recommendIntent({
        merchant: 'Shop',
        amount: { amountMinor: 10_000, currency: 'JPY' },
        occurredAt: at,
        fx: dccQuote,
      });
      expect(resDcc.candidates.find((c) => c.id === 'card:jcb-card')?.status).toBe('unknown');
      expect(resDcc.candidates.find((c) => c.id === 'card:jcb-card')?.fxEstimate?.status).toBe('unavailable');
    });
  });

  describe('4. Stale quote degradation and actual fail-closed enforcement', () => {
    it('degrades stale quote in planned recommendation and returns actionable refresh action', () => {
      const store = new MemoryStore();
      const service = new RewardService(store, 'u1');
      service.registerCard({ id: 'card-1', issuer: 'BankA', productName: 'Card 1', network: 'JCB' });
      addCardRule(service, 'card-1', 'rule-1', 'TWD', 300);

      const staleFx: FxSnapshot = {
        id: 'fx-stale',
        baseCurrency: 'JPY',
        quoteCurrency: 'TWD',
        ratePpm: 215_000,
        capturedAt: '2026-08-01T00:00:00Z', // > 1 month old
        maxAgeSeconds: 86400,
        provider: 'JCB',
        cardScheme: 'JCB',
        rateType: 'card_scheme',
      };

      const result = service.recommendIntent({
        merchant: 'Shop',
        amount: { amountMinor: 10_000, currency: 'JPY' },
        occurredAt: at,
        fx: staleFx,
      });

      const cand = result.candidates[0];
      expect(cand?.status).toBe('unknown');
      expect(cand?.fxEstimate?.status).toBe('stale_estimate');

      // Refresh action is emitted
      const refreshAction = result.requiredActions.find((a) => a.fxResolutionRequest);
      expect(refreshAction).toBeDefined();
      expect(refreshAction?.candidateIds).toContain('card:card-1');
    });

    it('rejects stale quote in recordTransaction with mode actual (fail-closed)', () => {
      const store = new MemoryStore();
      const service = new RewardService(store, 'u1');
      service.registerCard({ id: 'card-actual', issuer: 'BankA', productName: 'Card Actual', network: 'JCB' });
      addCardRule(service, 'card-actual', 'rule-actual', 'TWD', 300);

      const staleFx: FxSnapshot = {
        id: 'fx-stale-act',
        baseCurrency: 'JPY',
        quoteCurrency: 'TWD',
        ratePpm: 215_000,
        capturedAt: '2026-08-01T00:00:00Z',
        maxAgeSeconds: 86400,
        provider: 'JCB',
        cardScheme: 'JCB',
        rateType: 'card_scheme',
      };

      const tx: TransactionTuple = {
        idempotencyKey: 'tx-stale-test',
        cardId: 'card-actual',
        kind: 'purchase',
        mode: 'actual',
        occurredAt: at,
        amount: { amountMinor: 10_000, currency: 'JPY' },
        fx: staleFx,
      };

      expect(() => service.recordTransaction(tx)).toThrowError(/FX snapshot is stale/);
      expect(store.read().transactions).toHaveLength(0); // Nothing written
    });
  });

  describe('5. Path cost and netSpend ranking', () => {
    it('ranks candidate with lower netSpend first when rewards are identical but costs differ', () => {
      const store = new MemoryStore();
      const service = new RewardService(store, 'u1');

      const evidence = service.submitEvidence({
        id: 'ev-ranking', requirementId: 'route', sourceIdentity: 'issuer', sourceType: 'official',
        authority: 'issuer', claim: {}, observedAt: at, confidence: 'high', contentHash: 'hash',
        reviewState: 'accepted', sourceUrl: 'https://issuer.example/terms',
      });

      // Route 1: fee = 10 USD
      const routeLowFee = service.upsertPaymentRoute({
        status: 'active', idempotencyKey: 'route-low', layers: [], funding: { kind: 'cash' },
        observedAt: at, sourceUrl: 'https://issuer.example/terms', authority: 'issuer', confidence: 'high',
        evidenceIds: [evidence.id],
        nodes: [{ id: 'src', kind: 'funding_source', displayName: 'Cash' }, { id: 'dst', kind: 'merchant', displayName: 'Shop' }],
        edges: [{ edgeId: 'e-low', fromNodeId: 'src', toNodeId: 'dst', transition: 'direct_settlement', evidenceIds: [evidence.id], fee: { amountMinor: 100, currency: 'USD' } }],
        confirmation: { confirmedAt: at, confirmedBy: 'u1' },
      });

      // Route 2: fee = 20 USD
      const routeHighFee = service.upsertPaymentRoute({
        status: 'active', idempotencyKey: 'route-high', layers: [], funding: { kind: 'cash' },
        observedAt: at, sourceUrl: 'https://issuer.example/terms', authority: 'issuer', confidence: 'high',
        evidenceIds: [evidence.id],
        nodes: [{ id: 'src2', kind: 'funding_source', displayName: 'Cash' }, { id: 'dst2', kind: 'merchant', displayName: 'Shop' }],
        edges: [{ edgeId: 'e-high', fromNodeId: 'src2', toNodeId: 'dst2', transition: 'direct_settlement', evidenceIds: [evidence.id], fee: { amountMinor: 200, currency: 'USD' } }],
        confirmation: { confirmedAt: at, confirmedBy: 'u1' },
      });

      const fxRate: FxSnapshot = {
        id: 'fx-usd',
        baseCurrency: 'USD',
        quoteCurrency: 'TWD',
        ratePpm: 32_000_000,
        capturedAt: at,
        provider: 'route',
        rateType: 'spot_selling',
      };

      const result = service.recommendPaymentPaths({
        amount: { amountMinor: 10_000, currency: 'TWD' },
        asOf: at,
        routeIds: [routeHighFee.id, routeLowFee.id],
        routeFacts: [
          { routeId: routeLowFee.id, fx: fxRate },
          { routeId: routeHighFee.id, fx: fxRate },
        ],
      });

      expect(result.candidates).toHaveLength(2);
      // Low fee route should be ranked first (fee 3200 vs 6400)
      expect(result.candidates[0]?.routeId).toBe(routeLowFee.id);
      expect(result.candidates[1]?.routeId).toBe(routeHighFee.id);
    });
  });
});
