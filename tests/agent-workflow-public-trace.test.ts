import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import * as readline from 'node:readline';

type Rpc = { jsonrpc: string; id: number; result?: any; error?: any };

function mcp(dataDir: string) {
  const child = spawn(process.execPath, [resolve('dist/cli.js'), '--data-dir', dataDir, '--user', 'trace-user'], { stdio: ['pipe', 'pipe', 'pipe'] });
  const lines = readline.createInterface({ input: child.stdout!, crlfDelay: Infinity });
  let nextId = 0;
  const pending = new Map<number, (response: Rpc) => void>();
  lines.on('line', (line) => { const response = JSON.parse(line) as Rpc; pending.get(response.id)?.(response); pending.delete(response.id); });
  const call = (name: string, args: Record<string, unknown>) => new Promise<Rpc>((resolveCall) => { const id = ++nextId; pending.set(id, resolveCall); child.stdin!.write(`${JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } })}\n`); });
  const close = () => new Promise<void>((resolveClose) => { child.once('close', () => resolveClose()); child.stdin!.end(); });
  return { call, close };
}

const snapshot = (id: string) => ({ id, url: 'https://bank.example/offer', fetchedAt: '2026-09-10T00:00:00Z', contentHash: id, parserVersion: '1', verified: true });

describe('deterministic public agent workflow trace', () => {
  it('supports direct recommendation, FX recovery, refresh, and stable continuation', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'agent-trace-'));
    const client = mcp(dataDir);
    const call = async (name: string, args: Record<string, unknown>) => {
      const response = await client.call(name, args);
      expect(response.error).toBeUndefined();
      return response.result.structuredContent;
    };
    try {
      await call('register_card', { card: { id: 'trace-card', issuer: 'Example Bank', productName: 'Trace Card' } });
      await call('upsert_offer', { snapshot: snapshot('trace-twd'), rule: { id: 'trace-twd-rule', cardId: 'trace-card', version: '1', sourceSnapshotId: 'trace-twd', status: 'active', validFrom: '2026-01-01T00:00:00Z', settlementCurrency: 'TWD', match: {}, reward: { kind: 'flat', amountMinor: 100, currency: 'TWD' } } });

      const direct = await call('recommend', { merchant: 'Trace Shop', amount: { amountMinor: 1000, currency: 'TWD' }, occurredAt: '2026-09-10T00:00:00Z' });
      expect(direct.candidates.some((candidate: any) => candidate.status === 'ready')).toBe(true);

      const missingAmount = await call('recommend', { merchant: 'Trace Shop', occurredAt: '2026-09-10T00:00:00Z' });
      expect(missingAmount.requiredActions).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'amount', submission: { tool: 'recommend', field: 'amount' } })]));
      const retried = await call('recommend', {
        merchant: 'Trace Shop',
        occurredAt: '2026-09-10T00:00:00Z',
        expectedResultVersion: missingAmount.resultVersion,
        supplementalFacts: { amount: { amountMinor: 1000, currency: 'TWD' } },
      });
      expect(retried.candidates.some((candidate: any) => candidate.status === 'ready')).toBe(true);
      const staleRetry = await client.call('recommend', {
        merchant: 'Trace Shop',
        occurredAt: '2026-09-10T00:00:00Z',
        expectedResultVersion: missingAmount.resultVersion.slice(0, -1) + '0',
        supplementalFacts: { amount: { amountMinor: 1000, currency: 'TWD' } },
      });
      expect(staleRetry.error?.data?.details).toEqual(expect.objectContaining({ code: 'stale_fact', path: 'expectedResultVersion' }));
      const conflictingRetry = await client.call('recommend', {
        merchant: 'Trace Shop',
        amount: { amountMinor: 900, currency: 'TWD' },
        occurredAt: '2026-09-10T00:00:00Z',
        supplementalFacts: { amount: { amountMinor: 1000, currency: 'TWD' } },
      });
      expect(conflictingRetry.error?.data?.details).toEqual(expect.objectContaining({ code: 'conflicting_fact' }));

      await call('upsert_offer', { snapshot: snapshot('trace-jpy'), rule: { id: 'trace-jpy-rule', cardId: 'trace-card', version: '1', sourceSnapshotId: 'trace-jpy', status: 'active', validFrom: '2026-01-01T00:00:00Z', settlementCurrency: 'TWD', match: {}, reward: { kind: 'flat', amountMinor: 100, currency: 'TWD' } } });
      const missing = await call('recommend', { merchant: 'Trace Shop', amount: { amountMinor: 1000, currency: 'JPY' }, occurredAt: '2026-09-10T00:00:00Z' });
      expect(missing.requiredActions).toEqual(expect.arrayContaining([expect.objectContaining({ action: 'query_approved_fx_source', owner: 'agent', fxResolutionRequest: expect.objectContaining({ referenceSourceUrls: ['https://rate.bot.com.tw/xrt?Lang=zh-TW'] }) })]));
      const repeated = await call('recommend', { merchant: 'Trace Shop', amount: { amountMinor: 1000, currency: 'JPY' }, occurredAt: '2026-09-10T00:00:00Z' });
      expect(repeated.requiredActions.map((action: any) => action.id)).toEqual(missing.requiredActions.map((action: any) => action.id));

      const refreshed = await call('recommend', { merchant: 'Trace Shop', amount: { amountMinor: 1000, currency: 'JPY' }, occurredAt: '2026-09-10T00:00:00Z', fx: { id: 'trace-fx', baseCurrency: 'JPY', quoteCurrency: 'TWD', ratePpm: 220000, capturedAt: '2026-09-10T00:00:00Z', provider: 'Example Bank', rateType: 'card_scheme', sourceUrl: 'https://bank.example/fx', contentHash: 'trace-fx' } });
      expect(refreshed.candidates.some((candidate: any) => candidate.status === 'ready')).toBe(true);
      expect(refreshed.requiredActions.some((action: any) => action.action === 'query_approved_fx_source')).toBe(false);

      const pageOne = await call('recommend', { merchant: 'Trace Shop', amount: { amountMinor: 1000, currency: 'TWD' }, occurredAt: '2026-09-10T00:00:00Z', limit: 1, page: 1 });
      const pageTwo = await call('recommend', { merchant: 'Trace Shop', amount: { amountMinor: 1000, currency: 'TWD' }, occurredAt: '2026-09-10T00:00:00Z', limit: 1, page: 2, resultVersion: pageOne.resultVersion });
      expect(pageOne.candidates.map((candidate: any) => candidate.id)).not.toEqual(pageTwo.candidates.map((candidate: any) => candidate.id));
    } finally {
      await client.close();
      rmSync(dataDir, { recursive: true, force: true });
    }
  }, 20_000);

  it('hands a stale benefit to source-scoped ingestion and preserves the parent result version', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'agent-refresh-trace-'));
    const client = mcp(dataDir);
    const call = async (name: string, args: Record<string, unknown>) => {
      const response = await client.call(name, args);
      expect(response.error).toBeUndefined();
      return response.result.structuredContent;
    };
    try {
      await call('register_card', { card: { id: 'stale-card', issuer: 'Example Bank', productName: 'Stale Card' } });
      await call('upsert_offer', {
        snapshot: { ...snapshot('stale-source'), fetchedAt: '2025-01-01T00:00:00Z' },
        rule: {
          id: 'stale-rule',
          familyId: 'stale-family',
          cardId: 'stale-card',
          version: '1',
          sourceSnapshotId: 'stale-source',
          status: 'stale',
          validFrom: '2025-01-01T00:00:00Z',
          validTo: '2025-12-31T23:59:59Z',
          settlementCurrency: 'TWD',
          match: {},
          reward: { kind: 'percentage', rateBps: 300 },
        },
      });
      const intent = { merchant: 'Stale Shop', amount: { amountMinor: 1000, currency: 'TWD' }, occurredAt: '2026-09-10T00:00:00Z' };
      const stale = await call('recommend', intent);
      const refresh = stale.requiredActions.find((action: any) => action.action === 'REFRESH_BENEFIT');
      expect(refresh).toEqual(expect.objectContaining({ submission: { tool: 'create_ingestion', field: 'sourceScope' } }));
      const child = await call('create_ingestion', {
        sourceScope: refresh.refreshBenefit.sourceScope,
        idempotencyKey: 'refresh-trace-1',
        parentContinuation: {
          intentFingerprint: 'trace-parent-intent',
          parentResultVersion: stale.resultVersion,
          sourceScope: refresh.refreshBenefit.sourceScope,
          ruleFamily: refresh.refreshBenefit.familyId,
        },
      });
      expect(child.flow.parentContinuation.parentResultVersion).toBe(stale.resultVersion);
      expect(child.flow.parentContinuation.sourceScope).toEqual(refresh.refreshBenefit.sourceScope);
      expect(child.nextAction.kind).toBe('SUBMIT_SOURCE');
    } finally {
      await client.close();
      rmSync(dataDir, { recursive: true, force: true });
    }
  }, 20_000);
});
