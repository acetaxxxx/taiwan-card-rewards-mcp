import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FileStore, RewardService, validateToolArgs } from '../src/index.js';

const source = { id: 'evt_topup', kind: 'top_up', amount: { amountMinor: 50000, currency: 'TWD' }, occurredAt: '2026-09-07T01:00:00Z', funding: { kind: 'account', subtype: 'linked_bank_account' } };
const target = { id: 'evt_wallet_purchase', kind: 'purchase', amount: { amountMinor: 10000, currency: 'TWD' }, occurredAt: '2026-09-07T02:00:00Z', funding: { kind: 'account', subtype: 'wallet_balance' }, relations: { funded_by: ['evt_topup'] } };
const chainRule = { id: 'rule_chain', version: 'v1', relation: 'funded_by', windowSeconds: 3600, sourceRule: { id: 'source-rule', version: 'v1', eventKind: 'top_up', fundingKind: 'account', fundingSubtype: 'linked_bank_account' }, targetRule: { id: 'target-rule', version: 'v1', eventKind: 'purchase', fundingKind: 'account', fundingSubtype: 'wallet_balance' } };
const candidate = { eventId: target.id, ruleId: 'rule_chain', ruleVersion: 'v1', evidenceId: 'e-chain', sponsor: 'wallet', benefitGroup: 'purchase', reward: { kind: 'percentage', rateBps: 100 }, eligibility: { status: 'matched', reasons: [] } };

describe('server-side event eligibility gate', () => {
  it('matches only the explicit linked-account top-up chain and rejects inferred paths', () => {
    const dir = mkdtempSync(join(tmpdir(), 'event-reward-gate-'));
    try {
      const store = new FileStore({ dataDir: resolve(dir) });
      const service = new RewardService(store, 'user-a');
      const record = service.recordValidatedEventReward({ event: target, sourceEvents: [source], chainRule, candidate, idempotencyKey: 'chain-key' });
      expect(record.eventId).toBe(target.id);
      expect(() => service.recordValidatedEventReward({ event: { ...target, relations: undefined }, sourceEvents: [source], chainRule, candidate, idempotencyKey: 'missing-relation' })).toThrow(/INELIGIBLE_EVENT_REWARD/);
      expect(() => service.recordValidatedEventReward({ event: { ...target, relations: { funded_by: ['evt_other'] } }, sourceEvents: [source], chainRule, candidate, idempotencyKey: 'inferred-path' })).toThrow(/INELIGIBLE_EVENT_REWARD/);
      store.close();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('ignores caller-forged matched status and fails closed for missing or ambiguous sources', () => {
    const dir = mkdtempSync(join(tmpdir(), 'event-reward-forge-'));
    try {
      const store = new FileStore({ dataDir: resolve(dir) });
      const service = new RewardService(store, 'user-a');
      const forgedRule = { id: 'forged', version: 'v1', eventKind: 'purchase', fundingKind: 'credit_card' };
      expect(() => service.recordValidatedEventReward({ event: target, sourceEvents: [], rule: forgedRule, candidate, idempotencyKey: 'forged-key' })).toThrow(/INELIGIBLE_EVENT_REWARD/);
      expect(() => service.recordValidatedEventReward({ event: target, sourceEvents: [source, source], chainRule, candidate, idempotencyKey: 'ambiguous-key' })).toThrow(/INELIGIBLE_EVENT_REWARD/);
      store.close();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('rejects duplicate sponsor/group rewards while allowing deterministic replay', () => {
    const dir = mkdtempSync(join(tmpdir(), 'event-reward-stack-'));
    try {
      const store = new FileStore({ dataDir: resolve(dir) });
      const service = new RewardService(store, 'user-a');
      const first = service.recordValidatedEventReward({ event: target, sourceEvents: [source], chainRule, candidate, idempotencyKey: 'stack-key-1' });
      expect(service.recordValidatedEventReward({ event: target, sourceEvents: [source], chainRule, candidate, idempotencyKey: 'stack-key-1' })).toEqual(first);
      expect(() => service.recordValidatedEventReward({ event: target, sourceEvents: [source], chainRule, candidate: { ...candidate, ruleId: 'other-rule' }, idempotencyKey: 'stack-key-2' })).toThrow(/NEEDS_REVIEW/);
      expect(() => validateToolArgs('record_event_reward_v2', { event: target, candidate, idempotencyKey: 'x', user_id: 'other' })).toThrow(/UNKNOWN_FIELD/);
      store.close();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
