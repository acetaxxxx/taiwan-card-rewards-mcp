import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FileStore, RewardService, mcpTools, validateEventRewardInput, validateToolArgs } from '../src/index.js';

const event = { id: 'evt_mcp', kind: 'purchase', amount: { amountMinor: 10000, currency: 'TWD' }, occurredAt: '2026-09-07T01:00:00Z', funding: { kind: 'account', subtype: 'wallet_balance' } };
const candidate = { eventId: 'evt_mcp', ruleId: 'rule_mcp', ruleVersion: 'v1', evidenceId: 'evidence_mcp', sponsor: 'wallet', benefitGroup: 'purchase', reward: { kind: 'percentage', rateBps: 100 }, eligibility: { status: 'matched', reasons: [] } };

describe('event reward MCP contract and authenticated service seam', () => {
  it('validates representative record/reversal payloads and rejects owner or sensitive fields', () => {
    expect(validateEventRewardInput({ event, candidate, idempotencyKey: 'event-key' }).event.id).toBe('evt_mcp');
    expect(() => validateToolArgs('record_event_reward', { event, candidate, idempotencyKey: 'event-key', ownerUser: 'other' })).toThrow(/UNKNOWN_FIELD/);
    expect(() => validateToolArgs('reverse_event_reward', { event, idempotencyKey: 'event-key', token: 'secret' })).toThrow(/UNKNOWN_FIELD/);
  });

  it('records only matched candidates for the authenticated owner and supports explicit reversal', () => {
    const dir = mkdtempSync(join(tmpdir(), 'event-reward-mcp-'));
    try {
      const store = new FileStore({ dataDir: resolve(dir) });
      const service = new RewardService(store, 'user-a');
      const recorded = service.recordEventReward({ event, candidate, idempotencyKey: 'event-key' });
      expect(recorded.ownerUser).toBe('user-a');
      expect(service.recordEventReward({ event, candidate, idempotencyKey: 'event-key' })).toEqual(recorded);
      const refund = { ...event, id: 'evt_mcp_refund', kind: 'refund', amount: { amountMinor: 10000, currency: 'TWD' }, relations: { refunds: ['evt_mcp'] } };
      expect(service.reverseEventReward({ event: refund, idempotencyKey: 'refund-key' }).reward.amountMinor).toBe(-100);
      expect(() => service.recordEventReward({ event, candidate: { ...candidate, eligibility: { status: 'unknown', reasons: ['missing provenance'] } }, idempotencyKey: 'unknown-key' })).toThrow(/INELIGIBLE_EVENT_REWARD/);
      expect(new RewardService(store, 'user-b').recordEventReward).toBeTypeOf('function');
      store.close();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('publishes unversioned tools with closed nested schemas', () => {
    for (const name of ['record_event_reward', 'reverse_event_reward']) {
      const tool = mcpTools.find((candidate) => candidate.name === name);
      expect(tool?.inputSchema).toMatchObject({ type: 'object', additionalProperties: false });
      expect(tool?.inputSchema).toHaveProperty('required');
    }
    expect(mcpTools.some((candidate) => candidate.name === 'record_event_reward_v1')).toBe(false);
    expect(mcpTools.some((candidate) => candidate.name === 'record_event_reward_v2')).toBe(false);
    expect(mcpTools.some((candidate) => candidate.name === 'reverse_event_reward_v1')).toBe(false);
  });
});
