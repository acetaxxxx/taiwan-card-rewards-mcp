import { describe, expect, it } from 'vitest';
import { createPaymentEventRewardCandidate, decidePaymentEventRewards } from '../src/index.js';

describe('event reward decision seam', () => {
  it('creates a target-event candidate tied to matched rule evidence without inventing reward amount', () => {
    const candidate = createPaymentEventRewardCandidate({
      eligibility: { status: 'matched', reasons: [] }, eventId: 'evt_purchase_1', ruleId: 'target_1', ruleVersion: '1', evidenceId: 'evidence_offer_1', sponsor: 'easy_wallet', benefitGroup: 'wallet-purchase',
    });
    expect(candidate).toMatchObject({ eventId: 'evt_purchase_1', ruleId: 'target_1', evidenceId: 'evidence_offer_1' });
    expect(candidate.reward).toBeUndefined();
  });

  it('does not silently stack same sponsor/group', () => {
    const candidates = [
      createPaymentEventRewardCandidate({ eligibility: { status: 'matched', reasons: [] }, eventId: 'evt_purchase_1', ruleId: 'r1', ruleVersion: '1', evidenceId: 'e1', sponsor: 'wallet', benefitGroup: 'purchase' }),
      createPaymentEventRewardCandidate({ eligibility: { status: 'matched', reasons: [] }, eventId: 'evt_purchase_1', ruleId: 'r2', ruleVersion: '1', evidenceId: 'e2', sponsor: 'wallet', benefitGroup: 'purchase' }),
      createPaymentEventRewardCandidate({ eligibility: { status: 'matched', reasons: [] }, eventId: 'evt_purchase_1', ruleId: 'r3', ruleVersion: '1', evidenceId: 'e3', sponsor: 'issuer', benefitGroup: 'purchase', combination: { mode: 'additive', groupId: 'issuer-purchase', version: '1' } }),
    ];
    const decision = decidePaymentEventRewards(candidates);
    expect(decision.status).toBe('needs_review');
    expect(decision.candidates).toHaveLength(0);
    expect(decision.reasons).toContain('same sponsor and benefit group are not explicitly combinable');
  });

  it('returns no candidate for unknown eligibility', () => {
    const unknown = createPaymentEventRewardCandidate({ eligibility: { status: 'unknown', reasons: ['ambiguous wallet provenance'] }, eventId: 'evt_purchase_1', ruleId: 'r1', ruleVersion: '1', evidenceId: 'e1', sponsor: 'wallet', benefitGroup: 'purchase' });
    expect(unknown).toBeUndefined();
    expect(decidePaymentEventRewards([])).toMatchObject({ status: 'no_match', candidates: [] });
  });

  it('requires explicit additive policy across different sponsors/groups', () => {
    const wallet = createPaymentEventRewardCandidate({ eligibility: { status: 'matched', reasons: [] }, eventId: 'evt_purchase_1', ruleId: 'wallet-rule', ruleVersion: '1', evidenceId: 'e4', sponsor: 'wallet', benefitGroup: 'wallet-purchase' });
    const issuer = createPaymentEventRewardCandidate({ eligibility: { status: 'matched', reasons: [] }, eventId: 'evt_purchase_1', ruleId: 'issuer-rule', ruleVersion: '1', evidenceId: 'e5', sponsor: 'issuer', benefitGroup: 'issuer-purchase' });
    expect(decidePaymentEventRewards([wallet!, issuer!])).toMatchObject({ status: 'needs_review', candidates: [] });

    const additiveWallet = createPaymentEventRewardCandidate({ ...wallet!, eligibility: { status: 'matched', reasons: [] }, combination: { mode: 'additive', groupId: 'wallet-purchase', version: '1' } });
    const additiveIssuer = createPaymentEventRewardCandidate({ ...issuer!, eligibility: { status: 'matched', reasons: [] }, combination: { mode: 'additive', groupId: 'issuer-purchase', version: '1' } });
    expect(decidePaymentEventRewards([additiveWallet!, additiveIssuer!])).toMatchObject({ status: 'matched' });
    expect(decidePaymentEventRewards([additiveWallet!, additiveIssuer!]).candidates).toHaveLength(2);

    const replaceIssuer = createPaymentEventRewardCandidate({ ...issuer!, eligibility: { status: 'matched', reasons: [] }, combination: { mode: 'replace', groupId: 'issuer-purchase', version: '1' } });
    expect(decidePaymentEventRewards([additiveWallet!, replaceIssuer!])).toMatchObject({ status: 'needs_review', candidates: [] });
  });
});
