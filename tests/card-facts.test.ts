import { describe, expect, it } from 'vitest';
import { evaluateOffer } from '../src/evaluator.js';
import { validateEligibilityFact, validateHeldCard, validateCardProduct, validateContext } from '../src/validation.js';
import type { CardProduct, EligibilityFact, EvaluationContext, HeldCard, OfferRuleVersion, TransactionTuple } from '../src/types.js';

const transaction: TransactionTuple = {
  cardId: 'held_cube_1',
  kind: 'purchase',
  mode: 'planned',
  occurredAt: '2026-08-20T12:00:00Z',
  amount: { amountMinor: 50000, currency: 'TWD' },
  country: 'TW',
  channel: 'online',
  merchant: 'shopee',
};

const source = {
  id: 's1',
  url: 'https://bank.example/offers',
  fetchedAt: '2026-08-01T00:00:00Z',
  contentHash: 'hash123',
  parserVersion: '1',
};

const baseRule: OfferRuleVersion = {
  id: 'r_cube_online',
  cardId: 'held_cube_1',
  version: '1',
  sourceSnapshotId: 's1',
  status: 'active',
  validFrom: '2026-01-01T00:00:00Z',
  settlementCurrency: 'TWD',
  match: {},
  predicate: {
    op: 'AND',
    rules: [
      { field: 'transaction.country', op: 'EQUALS', value: 'TW' },
      { field: 'user.plan', op: 'EQUALS', value: 'digital_shopper' },
      { field: 'user.enrolled', op: 'EQUALS', value: true },
    ],
  },
  reward: { kind: 'percentage', rateBps: 300 },
};

describe('Ticket 05: Card Product, Held Card, and Eligibility Facts', () => {
  it('validates distinct CardProduct, HeldCard, and EligibilityFact shapes', () => {
    const product: CardProduct = validateCardProduct({
      id: 'cp_cube',
      issuer: 'Cathay United Bank',
      productName: 'CUBE Card',
      network: 'Mastercard',
      country: 'TW',
    });
    expect(product.id).toBe('cp_cube');
    expect(product.productName).toBe('CUBE Card');

    const held: HeldCard = validateHeldCard({
      id: 'held_cube_1',
      cardProductId: 'cp_cube',
      alias: 'Daily CUBE',
      billingCycleDay: 15,
      plan: 'digital_shopper',
      status: 'active',
    });
    expect(held.id).toBe('held_cube_1');
    expect(held.cardProductId).toBe('cp_cube');
    expect(held.plan).toBe('digital_shopper');

    const fact: EligibilityFact = validateEligibilityFact({
      id: 'fact_1',
      cardId: 'held_cube_1',
      factKey: 'user.enrolled',
      value: true,
      validFrom: '2026-08-01T00:00:00Z',
      validTo: '2026-08-31T23:59:59Z',
    });
    expect(fact.factKey).toBe('user.enrolled');
    expect(fact.value).toBe(true);
  });

  it('evaluates user.* predicate facts successfully when valid eligibility facts and held card plan are provided', () => {
    const context: EvaluationContext = {
      now: '2026-08-20T12:00:00Z',
      sourceSnapshots: { s1: source },
      heldCards: [
        { id: 'held_cube_1', cardProductId: 'cp_cube', plan: 'digital_shopper' },
      ],
      eligibilityFacts: [
        {
          cardId: 'held_cube_1',
          factKey: 'user.enrolled',
          value: true,
          validFrom: '2026-08-01T00:00:00Z',
          validTo: '2026-08-31T23:59:59Z',
        },
      ],
    };

    const result = evaluateOffer(baseRule, transaction, context);
    expect(result.status).toBe('ok');
    expect(result.grossReward?.amountMinor).toBe(1500);
  });

  it('fails closed with status unknown when user.* facts are missing', () => {
    const contextWithoutFacts: EvaluationContext = {
      now: '2026-08-20T12:00:00Z',
      sourceSnapshots: { s1: source },
      heldCards: [
        { id: 'held_cube_1', cardProductId: 'cp_cube' }, // plan is missing
      ],
      eligibilityFacts: [], // enrolled is missing
    };

    const result = evaluateOffer(baseRule, transaction, contextWithoutFacts);
    expect(result.status).toBe('unknown');
    expect(result.unknownReasons).toEqual(
      expect.arrayContaining(['missing user.plan', 'missing user.enrolled']),
    );
  });

  it('fails closed when an eligibility fact is expired relative to transaction time', () => {
    const contextWithExpiredFact: EvaluationContext = {
      now: '2026-08-20T12:00:00Z',
      sourceSnapshots: { s1: source },
      userFacts: {
        'user.plan': 'digital_shopper',
      },
      eligibilityFacts: [
        {
          cardId: 'held_cube_1',
          factKey: 'user.enrolled',
          value: true,
          validFrom: '2026-01-01T00:00:00Z',
          validTo: '2026-07-31T23:59:59Z', // Expired on 2026-07-31, transaction is on 2026-08-20
        },
      ],
    };

    const result = evaluateOffer(baseRule, transaction, contextWithExpiredFact);
    expect(result.status).toBe('unknown');
    expect(result.unknownReasons).toContain('missing user.enrolled');
  });

  it('flags needs_review when conflicting eligibility facts exist for the same key and card', () => {
    const contextWithConflict: EvaluationContext = {
      now: '2026-08-20T12:00:00Z',
      sourceSnapshots: { s1: source },
      heldCards: [
        { id: 'held_cube_1', cardProductId: 'cp_cube', plan: 'digital_shopper' },
      ],
      eligibilityFacts: [
        {
          cardId: 'held_cube_1',
          factKey: 'user.enrolled',
          value: true,
          validFrom: '2026-08-01T00:00:00Z',
          validTo: '2026-08-31T23:59:59Z',
        },
        {
          cardId: 'held_cube_1',
          factKey: 'user.enrolled',
          value: false,
          validFrom: '2026-08-01T00:00:00Z',
          validTo: '2026-08-31T23:59:59Z',
        },
      ],
    };

    const result = evaluateOffer(baseRule, transaction, contextWithConflict);
    expect(result.status).toBe('needs_review');
    expect(result.unknownReasons).toContain('conflicting user facts for user.enrolled');
  });

  it('validates context with userFacts, heldCards, and eligibilityFacts', () => {
    const validated = validateContext({
      now: '2026-08-20T00:00:00Z',
      userFacts: {
        'user.auto_debit': true,
      },
      heldCards: [
        { id: 'hc_1', cardProductId: 'cp_1', alias: 'My Card' },
      ],
      eligibilityFacts: [
        { factKey: 'user.new_cardholder', value: true },
      ],
    });
    expect(validated.userFacts).toEqual({ 'user.auto_debit': true });
    expect(validated.heldCards).toHaveLength(1);
    expect(validated.eligibilityFacts).toHaveLength(1);
  });
});
