import { describe, expect, it } from 'vitest';
import { emptyState, RewardService } from '../src/index.js';
import type { LedgerStore } from '../src/store.js';
import type { CardSwitchInput } from '../src/types.js';

class MemoryStore implements LedgerStore {
  state = emptyState();
  read() { return structuredClone(this.state); }
  write(next: typeof this.state) { this.state = structuredClone(next); }
  update(mutator: (state: typeof this.state) => void) { const next = this.read(); mutator(next); this.write(next); return this.read(); }
  close() {}
}

const input = (key: string, at = '2026-09-01T00:30:00Z'): CardSwitchInput => ({
  action: 'record', cardId: 'c1', timezone: 'Asia/Taipei', switchedAtUtc: at, benefit: 'cashback', sourceUrl: 'https://bank.example/campaign', sourceSnapshotAt: '2026-08-31T00:00:00Z', ruleVersion: '2026-v1', idempotencyKey: key,
  confirmation: { confirmedBy: 'user', confirmedAtUtc: at, completed: true },
  campaign: { id: 'camp-1', issuer: 'Bank', cardId: 'c1', sourceUrl: 'https://bank.example/campaign', sourceSnapshotAt: '2026-08-31T00:00:00Z', ruleVersion: '2026-v1', effectiveFrom: '2026-09-01T00:00:00Z', effectiveTo: '2026-12-31T23:59:59Z', eligibility: ['enrollment'] },
});

describe('card switch status and campaign tools', () => {
  it('persists the latest projection, exposes candidates, and permits another same-day write', () => {
    const store = new MemoryStore();
    const service = new RewardService(store, undefined);
    service.registerCard({ id: 'c1', issuer: 'Bank', productName: 'Card', network: 'VISA', timezone: 'Asia/Taipei' });
    const first = service.upsertCardSwitch(input('k1'));
    expect(first.current?.switchedLocalDate).toBe('2026-09-01');
    expect(first.availableCandidates).toHaveLength(1);
    expect(first.warnings).toContain('some candidates have eligibility conditions requiring user confirmation');
    const second = service.upsertCardSwitch({ ...input('k2'), action: 'adjust', adjustmentReason: 'user changed plan', benefit: 'points' });
    expect(second.alreadySwitchedToday).toBe(true);
    expect(second.warnings).toContain('a switch was already recorded today; another confirmed write is still allowed');
    expect(second.current?.benefit).toBe('points');
  });

  it('rejects idempotency conflicts and exposes unavailable campaigns', () => {
    const store = new MemoryStore();
    const service = new RewardService(store, undefined);
    service.registerCard({ id: 'c1', issuer: 'Bank', productName: 'Card', timezone: 'Asia/Taipei' });
    service.upsertCardSwitch(input('k1'));
    expect(() => service.upsertCardSwitch({ ...input('k1'), benefit: 'different' })).toThrow(/IDEMPOTENCY_CONFLICT/);
    const status = service.getCardSwitchStatus('c1', '2027-01-01T00:00:00Z');
    expect(status.availableCandidates).toHaveLength(0);
    expect(status.currentlyUnavailable[0]?.reason).toBe('campaign has expired');
  });
});
