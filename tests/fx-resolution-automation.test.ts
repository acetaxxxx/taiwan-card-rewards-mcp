import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  RewardService,
  FileStore,
  FX_USER_QUESTION,
  RewardServiceError,
  buildFxResolutionRequest,
} from '../src/index.js';
import type {
  CardDescriptor,
  OfferRuleVersion,
  OfferSourceSnapshot,
  TransactionTuple,
  FxSnapshot,
  PaymentEvent,
  PaymentEventRewardCandidateInput,
  EvidenceRecord,
} from '../src/types.js';

describe('Track B: FX Resolution & Provenance Freeze', () => {
  let tempDir: string;
  let store: FileStore;
  let service: RewardService;

  const cardJpy: CardDescriptor = {
    id: 'card-jpy-rewards',
    issuer: 'TestBank',
    productName: 'Japan Travel Card',
    network: 'JCB',
    country: 'TW',
    billingCycleDay: 15,
    timezone: 'Asia/Taipei',
  };

  const snapshot: OfferSourceSnapshot = {
    id: 'snap-jpy-1',
    url: 'https://bank.example.com/offers/jpy',
    fetchedAt: '2026-08-01T00:00:00Z',
    contentHash: 'hash-jpy-1',
    parserVersion: '1.0',
    verified: true,
  };

  const ruleJpy: OfferRuleVersion = {
    id: 'rule-jpy-3pct',
    cardId: 'card-jpy-rewards',
    version: '1',
    sourceSnapshotId: 'snap-jpy-1',
    status: 'active',
    validFrom: '2026-01-01T00:00:00Z',
    settlementCurrency: 'TWD',
    match: {},
    reward: { kind: 'percentage', rateBps: 300 }, // 3%
  };

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'card-fx-test-'));
    store = new FileStore({ dataDir: tempDir, user: 'test-user' });
    service = new RewardService(store, 'test-user');
    service.registerCard(cardJpy);
    service.upsertOffer(snapshot, ruleJpy);
  });

  afterEach(() => {
    store.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  describe('Vertical Slice 1: Fail-Closed fx_missing and Actionable FxResolutionRequest on Public Seams', () => {
    it('buildFxResolutionRequest: produces an actionable request for a planned cross-currency transaction', () => {
      const fxReq = buildFxResolutionRequest({
        transaction: { amount: { amountMinor: 100000, currency: 'JPY' }, occurredAt: '2026-09-01T12:00:00Z', mode: 'planned' },
        rules: [ruleJpy],
        card: cardJpy,
      });
      expect(fxReq.baseCurrency).toBe('JPY');
      expect(fxReq.quoteCurrency).toBe('TWD');
      expect(fxReq.transactionKind).toBe('planned');
      expect(fxReq.conversionOwner).toBe('card_scheme');
      expect(fxReq.retryAction).toBe('query_approved_fx_source');
    });

    it('recordTransaction: fails closed with fx_missing when cross-currency purchase lacks FX observation and writes NO half-baked records', () => {
      const txWithoutFx: TransactionTuple = {
        idempotencyKey: 'tx-no-fx-slice1',
        cardId: 'card-jpy-rewards',
        kind: 'purchase',
        mode: 'actual',
        occurredAt: '2026-09-01T12:00:00Z',
        amount: { amountMinor: 100000, currency: 'JPY' }, // 1000 JPY
      };

      try {
        service.recordTransaction(txWithoutFx);
        expect.unreachable('Should have failed closed without FX observation');
      } catch (error) {
        expect(error).toBeInstanceOf(RewardServiceError);
        const err = error as RewardServiceError;
        expect(err.code).toBe('fx_missing');
        expect(err.details).toBeDefined();

        const details = err.details as { code: string; fxResolutionRequest: any };
        expect(details.code).toBe('fx_missing');
        expect(details.fxResolutionRequest.baseCurrency).toBe('JPY');
        expect(details.fxResolutionRequest.quoteCurrency).toBe('TWD');
        expect(details.fxResolutionRequest.retryAction).toBe('query_approved_fx_source');
      }

      // Invariant: Fail-closed guarantees zero half-baked records in store
      expect(service.store.read().transactions).toHaveLength(0);
      expect(service.store.read().rewardComponents).toHaveLength(0);
    });

    it('recordValidatedEventReward: fails closed when cross-currency reward lacks FX and writes NO half-baked records', () => {
      const crossEvent: PaymentEvent = {
        id: 'event-jpy-slice1',
        kind: 'purchase',
        occurredAt: '2026-09-01T12:00:00Z',
        amount: { amountMinor: 200000, currency: 'JPY' },
        funding: { kind: 'cash' },
      };

      const eventInput: PaymentEventRewardCandidateInput = {
        eventId: 'event-jpy-slice1',
        ruleId: 'rule-jpy-3pct',
        ruleVersion: '1',
        evidenceId: 'snap-jpy-1',
        sponsor: 'test',
        benefitGroup: 'bg',
        reward: { kind: 'flat', amountMinor: 60, currency: 'TWD' },
        eligibility: { status: 'matched', reasons: ['test JPY event'] },
      };

      expect(() => {
        service.recordValidatedEventReward({
          event: crossEvent,
          rule: { id: 'rule-jpy-3pct', version: '1', eventKind: 'purchase' },
          candidate: eventInput,
          idempotencyKey: 'event-idemp-1',
        });
      }).toThrowError(/fx_missing/i);

      // Invariant: zero event rewards stored on fail-closed error
      expect(service.store.read().eventRewardLedger).toHaveLength(0);
    });
  });

  describe('Vertical Slice 2: Policy Matrix, Atomic Ingestion, Provenance Freeze & Workflow Verification', () => {
    describe('Policy Matrix via buildFxResolutionRequest', () => {
      it('maps card network / direct card to card_scheme', () => {
        const fxReq = buildFxResolutionRequest({
          transaction: { amount: { amountMinor: 100000, currency: 'JPY' }, occurredAt: '2026-09-01T12:00:00Z', mode: 'actual', routeContext: { transactionCurrency: 'JPY', conversionOwner: 'card_network' } },
        });
        expect(fxReq.conversionOwner).toBe('card_scheme');
        expect(fxReq.suggestedRateTypes).toEqual(['card_scheme']);
      });

      it('maps bank / issuer to cash_selling', () => {
        const fxReq = buildFxResolutionRequest({
          transaction: { amount: { amountMinor: 100000, currency: 'JPY' }, occurredAt: '2026-09-01T12:00:00Z', mode: 'actual', routeContext: { transactionCurrency: 'JPY', conversionOwner: 'issuer' } },
        });
        expect(fxReq.conversionOwner).toBe('issuer');
        expect(fxReq.suggestedRateTypes).toEqual(['cash_selling']);
      });

      it('maps wallet to spot_selling and mid_market', () => {
        const fxReq = buildFxResolutionRequest({
          transaction: { amount: { amountMinor: 100000, currency: 'JPY' }, occurredAt: '2026-09-01T12:00:00Z', mode: 'planned', route: { kind: 'wallet' } },
        });
        expect(fxReq.conversionOwner).toBe('wallet');
        expect(fxReq.suggestedRateTypes).toEqual(['spot_selling', 'mid_market']);
      });

      it('maps DCC to merchant_dcc with spot/cash selling', () => {
        const fxReq = buildFxResolutionRequest({
          transaction: { amount: { amountMinor: 100000, currency: 'JPY' }, occurredAt: '2026-09-01T12:00:00Z', mode: 'actual', routeContext: { transactionCurrency: 'JPY', dcc: true } },
        });
        expect(fxReq.conversionOwner).toBe('merchant_dcc');
        expect(fxReq.suggestedRateTypes).toEqual(['spot_selling', 'cash_selling']);
      });

      it('handles unknown conversionOwner: planned uses estimate; actual prompts single user question', () => {
        // Planned estimate: mid_market / spot_selling, no user question
        const plannedReq = buildFxResolutionRequest({
          transaction: { amount: { amountMinor: 100000, currency: 'JPY' }, occurredAt: '2026-09-01T12:00:00Z', mode: 'planned', routeContext: { transactionCurrency: 'JPY', conversionOwner: 'unknown' } },
        });
        expect(plannedReq.conversionOwner).toBe('unknown');
        expect(plannedReq.suggestedRateTypes).toEqual(['mid_market', 'spot_selling']);
        expect(plannedReq.retryAction).toBe('query_approved_fx_source');
        expect(plannedReq.userQuestion).toBeUndefined();

        // Actual settlement: prompt user with single clear question
        const actualReq = buildFxResolutionRequest({
          transaction: { amount: { amountMinor: 100000, currency: 'JPY' }, occurredAt: '2026-09-01T12:00:00Z', mode: 'actual', routeContext: { transactionCurrency: 'JPY', conversionOwner: 'unknown' } },
        });
        expect(actualReq.conversionOwner).toBe('unknown');
        expect(actualReq.suggestedRateTypes).toEqual(['card_scheme', 'cash_selling']);
        expect(actualReq.retryAction).toBe('ask_user');
        expect(actualReq.userQuestion).toBe(FX_USER_QUESTION);
      });
    });

    describe('Atomic Mutation Ingestion, Validation & Frozen Provenance', () => {
      it('fails closed when actual transaction attempts to use mid_market estimate', () => {
        const midMarketFx: FxSnapshot = {
          id: 'fx-jpy-mid',
          baseCurrency: 'JPY',
          quoteCurrency: 'TWD',
          ratePpm: 215000,
          capturedAt: '2026-09-01T00:00:00Z',
          provider: 'OpenExchange',
          rateType: 'mid_market',
        };

        const txMidMarket: TransactionTuple = {
          idempotencyKey: 'tx-mid-market-slice2',
          cardId: 'card-jpy-rewards',
          kind: 'purchase',
          mode: 'actual',
          occurredAt: '2026-09-01T12:00:00Z',
          amount: { amountMinor: 100000, currency: 'JPY' },
          fx: midMarketFx,
        };

        expect(() => service.recordTransaction(txMidMarket)).toThrowError(/mid_market rate cannot be used for actual transaction settlement/i);
        expect(service.store.read().transactions).toHaveLength(0);
      });

      it('fails closed when transaction amount currency and fx baseCurrency mismatch', () => {
        const mismatchedFx: FxSnapshot = {
          id: 'fx-usd-twd',
          baseCurrency: 'USD', // Mismatch with JPY amount
          quoteCurrency: 'TWD',
          ratePpm: 31800000,
          capturedAt: '2026-09-01T00:00:00Z',
          provider: 'Visa',
          rateType: 'card_scheme',
        };

        const txMismatch: TransactionTuple = {
          idempotencyKey: 'tx-mismatch-slice2',
          cardId: 'card-jpy-rewards',
          kind: 'purchase',
          mode: 'actual',
          occurredAt: '2026-09-01T12:00:00Z',
          amount: { amountMinor: 100000, currency: 'JPY' },
          fx: mismatchedFx,
        };

        expect(() => service.recordTransaction(txMismatch)).toThrowError(/baseCurrency does not match/i);
        expect(service.store.read().transactions).toHaveLength(0);
      });

      it('succeeds when valid card_scheme FX observation is supplied atomically, freezing appliedFx', () => {
        const validFx: FxSnapshot = {
          id: 'fx-jpy-visa-1',
          baseCurrency: 'JPY',
          quoteCurrency: 'TWD',
          ratePpm: 215000,
          capturedAt: '2026-09-01T00:00:00Z',
          provider: 'Visa',
          rateType: 'card_scheme',
          sourceUrl: 'https://usa.visa.com/support/consumer/travel-support/exchange-rate-calculator.html',
        };

        const txValid: TransactionTuple = {
          idempotencyKey: 'tx-valid-slice2',
          cardId: 'card-jpy-rewards',
          kind: 'purchase',
          mode: 'actual',
          occurredAt: '2026-09-01T12:00:00Z',
          amount: { amountMinor: 100000, currency: 'JPY' }, // 1000 JPY = 215 TWD
          fx: validFx,
        };

        const result = service.recordTransaction(txValid);
        expect(result.status).toBe('ok');
        expect(result.cappedReward?.amountMinor).toBe(645); // 3% of 215 TWD = 6.45 TWD -> 645 minor

        const record = service.store.read().transactions.find((r) => r.transaction.idempotencyKey === 'tx-valid-slice2');
        expect(record).toBeDefined();
        expect(record?.appliedFx).toBeDefined();
        expect(record?.appliedFx?.snapshotId).toBe('fx-jpy-visa-1');
        expect(record?.appliedFx?.ratePpm).toBe(215000);
        expect(record?.appliedFx?.conversionOwner).toBe('card_scheme');
      });

      it('freezes original applied FX rate on refund even when future rates change', () => {
        const initialFx: FxSnapshot = {
          id: 'fx-jpy-initial',
          baseCurrency: 'JPY',
          quoteCurrency: 'TWD',
          ratePpm: 215000, // 0.2150
          capturedAt: '2026-08-15T00:00:00Z',
          provider: 'Visa',
          rateType: 'card_scheme',
        };

        const purchaseTx: TransactionTuple = {
          idempotencyKey: 'purchase-jpy-aug',
          cardId: 'card-jpy-rewards',
          kind: 'purchase',
          mode: 'actual',
          occurredAt: '2026-08-15T12:00:00Z',
          amount: { amountMinor: 100000, currency: 'JPY' }, // 1000 JPY
          fx: initialFx,
        };

        const purchaseResult = service.recordTransaction(purchaseTx);
        expect(purchaseResult.status).toBe('ok');
        const originalRewardMinor = purchaseResult.cappedReward?.amountMinor ?? 0;
        expect(originalRewardMinor).toBe(645);

        // Refund of 50% occurred on Sep 15
        const refundTx: TransactionTuple = {
          idempotencyKey: 'refund-jpy-sep',
          refundOfId: 'purchase-jpy-aug',
          cardId: 'card-jpy-rewards',
          kind: 'refund',
          mode: 'actual',
          occurredAt: '2026-09-15T12:00:00Z',
          amount: { amountMinor: 50000, currency: 'JPY' }, // 500 JPY
        };

        const refundResult = service.recordTransaction(refundTx);
        expect(refundResult.status).toBe('ok');
        expect(refundResult.cappedReward?.amountMinor).toBe(-322);

        // Verify refund record kept the original applied FX snapshot ID and rate
        const refundRecord = service.store.read().transactions.find((r) => r.transaction.idempotencyKey === 'refund-jpy-sep');
        expect(refundRecord).toBeDefined();
        expect(refundRecord?.appliedFx?.snapshotId).toBe('fx-jpy-initial');
        expect(refundRecord?.appliedFx?.ratePpm).toBe(215000);
        expect(refundRecord?.transaction.fx?.ratePpm).toBe(215000);
      });
    });

    describe('Agent Skill Workflow Document Verification', () => {
      it('verifies payment-route-and-fx.md mandates search before submit and zero automated core network I/O', () => {
        const docPath = join(__dirname, '../docs/agents/taiwan-card-rewards-skill/workflows/payment-route-and-fx.md');
        const docContent = readFileSync(docPath, 'utf8');

        // Verify workflow mandates external search/query before mutation
        expect(docContent).toMatch(/FxResolutionRequest/);
        expect(docContent).toMatch(/query_approved_fx_source/);
        expect(docContent).toMatch(/fail-closed|失敗即關閉/i);

        // Verify core makes zero automated network requests
        expect(docContent).toMatch(/核心零直接網路\s*I\/O|零直接網路/);
        expect(docContent).toMatch(/mid_market/);
        expect(docContent).toMatch(/AppliedFxRate/);
      });
    });
  });
});
