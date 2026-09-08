import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { EventRewardLedger, FileStore, createPaymentEventRewardCandidate, validatePaymentEvent, type StartupConfig } from '../src/index.js';

const config = (dataDir: string): StartupConfig => ({ dataDir: resolve(dataDir) });
const event = validatePaymentEvent({ id: 'evt_durable', kind: 'purchase', amount: { amountMinor: 40000, currency: 'TWD' }, occurredAt: '2026-09-07T01:00:00Z', funding: { kind: 'account', subtype: 'wallet_balance' } });
const candidate = createPaymentEventRewardCandidate({ eligibility: { status: 'matched', reasons: [] }, eventId: event.id, ruleId: 'rule_durable', ruleVersion: 'v1', evidenceId: 'evidence-durable', sponsor: 'wallet', benefitGroup: 'purchase', reward: { kind: 'percentage', rateBps: 100 } });
const cap = { id: 'cap-durable', metric: 'reward' as const, period: 'calendar_month' as const, limit: 500, currency: 'TWD', timezone: 'Asia/Taipei' };

describe('durable event reward ledger state', () => {
  it('loads legacy v2 state with empty event collections', () => {
    const dir = mkdtempSync(join(tmpdir(), 'event-reward-v2-'));
    try {
      writeFileSync(join(dir, 'card-rewards.json'), JSON.stringify({ schemaVersion: 2, cards: [], snapshots: [], rules: [], transactions: [] }));
      const store = new FileStore(config(dir));
      expect(store.read().eventRewardLedger).toEqual([]);
      expect(store.read().eventRewardReversals).toEqual([]);
      expect(store.read().eventRewardCapUsage).toEqual([]);
      store.close();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('survives restart, replays idempotency, and isolates owners', () => {
    const dir = mkdtempSync(join(tmpdir(), 'event-reward-restart-'));
    try {
      const store1 = new FileStore(config(dir));
      const ledger1 = new EventRewardLedger('user-a', [cap], store1);
      const first = ledger1.record(candidate, event, 'durable-key');
      const refund = validatePaymentEvent({ id: 'evt_durable_refund', kind: 'refund', amount: { amountMinor: 40000, currency: 'TWD' }, occurredAt: '2026-09-07T02:00:00Z', funding: { kind: 'account', subtype: 'wallet_balance' }, relations: { refunds: [event.id] } });
      const reversal = ledger1.reverse(refund, 'durable-refund');
      store1.close();
      const store2 = new FileStore(config(dir));
      const ledger2 = new EventRewardLedger('user-a', [cap], store2);
      expect(ledger2.record(candidate, event, 'durable-key')).toEqual(first);
      expect(ledger2.reverse(refund, 'durable-refund')).toEqual(reversal);
      expect(new EventRewardLedger('user-b', [cap], store2).list()).toEqual([]);
      store2.close();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('fails closed on duplicate persisted event idempotency records', () => {
    const dir = mkdtempSync(join(tmpdir(), 'event-reward-corrupt-'));
    try {
      const store = new FileStore(config(dir));
      new EventRewardLedger('user-a', [cap], store).record(candidate, event, 'duplicate-key');
      store.close();
      const statePath = join(dir, 'card-rewards.json');
      const state = JSON.parse(readFileSync(statePath, 'utf8')) as { eventRewardLedger: unknown[] };
      state.eventRewardLedger.push(state.eventRewardLedger[0]);
      writeFileSync(statePath, JSON.stringify(state));
      expect(() => new FileStore(config(dir))).toThrow(/STORE_CORRUPT/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
