import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import * as readline from 'node:readline';
import { describe, expect, it } from 'vitest';
import { FileStore } from '../src/store.js';
import { RewardService } from '../src/service.js';

function callPublic(dataDir: string, args: Record<string, unknown>): Promise<any> {
  return new Promise((resolveCall, reject) => {
    const child = spawn(process.execPath, [resolve(__dirname, '../dist/cli.js'), '--data-dir', dataDir, '--user', 'intent-test'], { stdio: ['pipe', 'pipe', 'pipe'] });
    const lines = readline.createInterface({ input: child.stdout!, crlfDelay: Infinity });
    let result: unknown;
    const timeout = setTimeout(() => { child.kill(); reject(new Error('MCP response timed out')); }, 5000);
    lines.on('line', (line) => {
      try {
        const response = JSON.parse(line);
        if (response.id !== 1) return;
        lines.close(); child.stdin!.end();
        result = response;
      } catch { /* startup diagnostics are not protocol responses */ }
    });
    child.on('error', error => { clearTimeout(timeout); reject(error); });
    child.on('close', code => {
      clearTimeout(timeout);
      if (result === undefined || code !== 0) reject(new Error(`MCP exited without a successful response (${code})`));
      else resolveCall(result);
    });
    child.stdin!.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'recommend', arguments: args } }) + '\n');
  });
}

describe('public merchant intent path comparison', () => {
  it('returns direct card, wallet, and account candidates with layered rule terms', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'intent-paths-public-'));
    const store = new FileStore({ dataDir });
    try {
      const service = new RewardService(store, 'intent-test');
      service.registerCard({ id: 'card-direct', issuer: 'Bank', productName: 'Direct Card' });
      const evidence = service.submitEvidence({ id: 'route-evidence', requirementId: 'route', sourceIdentity: 'issuer', sourceType: 'official', authority: 'issuer', claim: { route: 'merchant-payments' }, observedAt: '2026-09-01T00:00:00Z', confidence: 'high', contentHash: 'route-evidence-hash', reviewState: 'accepted', sourceUrl: 'https://bank.example/terms' });
      const wallet = service.upsertPaymentAccount({ providerId: 'wallet', kind: 'wallet_balance', displayName: 'Wallet', status: 'active', observedAt: '2026-09-01T00:00:00Z', balance: { amountMinor: 100000, currency: 'TWD' }, evidenceIds: [evidence.id], confirmation: { confirmedAt: '2026-09-01T00:00:00Z', confirmedBy: 'intent-test' }, idempotencyKey: 'wallet-account' });
      const account = service.upsertPaymentAccount({ providerId: 'bank', kind: 'linked_bank_account', displayName: 'Bank account', status: 'active', observedAt: '2026-09-01T00:00:00Z', evidenceIds: [evidence.id], confirmation: { confirmedAt: '2026-09-01T00:00:00Z', confirmedBy: 'intent-test' }, idempotencyKey: 'linked-account' });
      const routeBase = { status: 'active' as const, layers: [{ kind: 'wallet' as const, providerId: 'wallet', evidenceIds: [evidence.id] }], observedAt: '2026-09-01T00:00:00Z', sourceUrl: 'https://bank.example/terms', authority: 'issuer' as const, confidence: 'high' as const, evidenceIds: [evidence.id], confirmation: { confirmedAt: '2026-09-01T00:00:00Z', confirmedBy: 'intent-test' } };
      const walletRoute = service.upsertPaymentRoute({ ...routeBase, idempotencyKey: 'wallet-route', funding: { kind: 'account' as const, subtype: 'wallet_balance' as const, accountId: wallet.id } });
      const accountRoute = service.upsertPaymentRoute({ ...routeBase, idempotencyKey: 'account-route', funding: { kind: 'account' as const, subtype: 'linked_bank_account' as const, accountId: account.id } });
      const source = (id: string) => ({ id: `source-${id}`, url: 'https://bank.example/terms', fetchedAt: '2026-09-01T00:00:00Z', contentHash: `hash-${id}`, parserVersion: '1', verified: true as const });
      service.upsertOffer(source('direct'), { id: 'rule-direct', cardId: 'card-direct', version: '1', sourceSnapshotId: 'source-direct', status: 'active', validFrom: '2026-01-01T00:00:00Z', settlementCurrency: 'TWD', match: {}, reward: { kind: 'flat', amountMinor: 100, currency: 'TWD' }, componentKind: 'card_issuer', sponsor: 'Bank', benefitGroup: 'direct', stacking: 'confirmed', combination: { mode: 'additive', groupId: 'direct', version: '1' } });
      service.upsertOffer(source('wallet'), { id: 'rule-wallet', routeId: walletRoute.id, version: '1', sourceSnapshotId: 'source-wallet', status: 'active', validFrom: '2026-01-01T00:00:00Z', settlementCurrency: 'TWD', match: {}, reward: { kind: 'flat', amountMinor: 80, currency: 'TWD' }, componentKind: 'payment_provider', sponsor: 'Wallet', benefitGroup: 'wallet', stacking: 'possible', combination: { mode: 'additive', groupId: 'wallet', version: '1' }, eventRule: { id: 'wallet-event', version: '1', eventKind: 'purchase', fundingKind: 'account', fundingSubtype: 'wallet_balance' } });
      service.upsertOffer(source('account'), { id: 'rule-account', routeId: accountRoute.id, version: '1', sourceSnapshotId: 'source-account', status: 'active', validFrom: '2026-01-01T00:00:00Z', settlementCurrency: 'TWD', match: {}, reward: { kind: 'flat', amountMinor: 60, currency: 'TWD' }, componentKind: 'payment_provider', sponsor: 'Bank', benefitGroup: 'account', stacking: 'confirmed', combination: { mode: 'additive', groupId: 'account', version: '1' }, eventRule: { id: 'account-event', version: '1', eventKind: 'purchase', fundingKind: 'account', fundingSubtype: 'linked_bank_account' } });
      service.upsertOffer(source('loyalty'), {
        id: 'rule-loyalty', cardId: 'card-direct', version: '1', sourceSnapshotId: 'source-loyalty',
        status: 'active', validFrom: '2026-01-01T00:00:00Z', settlementCurrency: 'TWD', match: {},
        reward: { kind: 'flat', amountMinor: 20, currency: 'TWD' }, componentKind: 'merchant_loyalty',
        stacking: 'confirmed', combination: { mode: 'additive', groupId: 'direct', version: '1' },
      });
      store.close();
      const response = await callPublic(dataDir, { merchant: 'shop', amount: { amountMinor: 10000, currency: 'TWD' }, occurredAt: '2026-09-05T00:00:00Z', limit: 10 });
      expect(response.error).toBeUndefined();
      const result = response.result.structuredContent;
      expect(result.candidates).toHaveLength(3);
      expect(result.candidates.map((candidate: any) => candidate.kind).sort()).toEqual(['direct_card', 'payment_path', 'payment_path']);
      expect(result.candidates.every((candidate: any) => candidate.matchedRules.length > 0)).toBe(true);
      expect(result.candidates.find((candidate: any) => candidate.kind === 'direct_card').matchedRules).toEqual(expect.arrayContaining([
        expect.objectContaining({ ruleId: 'rule-direct', component: 'card_issuer', status: 'matched' }),
        expect.objectContaining({ ruleId: 'rule-loyalty', component: 'merchant_loyalty', status: 'matched' }),
      ]));
      const rules = result.candidates.flatMap((candidate: any) => candidate.matchedRules);
      expect(rules).toEqual(expect.arrayContaining([expect.objectContaining({ ruleId: 'rule-direct', stacking: 'confirmed', combination: expect.objectContaining({ mode: 'additive' }) }), expect.objectContaining({ ruleId: 'rule-wallet', stacking: 'possible' }), expect.objectContaining({ ruleId: 'rule-account', stacking: 'confirmed' })]));
      expect(result.coverage).toEqual(expect.objectContaining({ bounded: false }));
    } finally {
      try { store.close(); } catch { /* already closed before public process */ }
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it('returns a candidate-local FX action, then recomputes when an observation is supplied', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'intent-fx-public-'));
    const store = new FileStore({ dataDir });
    try {
      const service = new RewardService(store, 'intent-test');
      service.registerCard({ id: 'fx-card', issuer: 'Bank', productName: 'FX Card' });
      service.upsertOffer({ id: 'fx-source', url: 'https://bank.example/fx', fetchedAt: '2026-09-01T00:00:00Z', contentHash: 'fx-source', parserVersion: '1', verified: true }, { id: 'fx-rule', cardId: 'fx-card', version: '1', sourceSnapshotId: 'fx-source', status: 'active', validFrom: '2026-01-01T00:00:00Z', settlementCurrency: 'TWD', match: {}, reward: { kind: 'percentage', rateBps: 100, currency: 'TWD' } });
      store.close();
      const base = { merchant: 'shop', amount: { amountMinor: 1000, currency: 'JPY' }, occurredAt: '2026-09-05T00:00:00Z' };
      const first = await callPublic(dataDir, base);
      expect(first.result.structuredContent.candidates[0]).toEqual(expect.objectContaining({ status: 'unknown' }));
      expect(first.result.structuredContent).toHaveProperty('fxResolutionRequest');
      expect(first.result.structuredContent.requiredActions).toEqual(expect.arrayContaining([expect.objectContaining({ action: 'query_approved_fx_source', candidateIds: expect.any(Array) })]));
      const second = await callPublic(dataDir, { ...base, fx: { id: 'fx-observation', baseCurrency: 'JPY', quoteCurrency: 'TWD', ratePpm: 220, capturedAt: '2026-09-05T00:00:00Z', provider: 'bank', rateType: 'card_scheme', sourceUrl: 'https://bank.example/fx', contentHash: 'fx-observation' } });
      expect(second.result.structuredContent.candidates[0]).toEqual(expect.objectContaining({ status: 'ready' }));
    } finally {
      try { store.close(); } catch { /* already closed */ }
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
