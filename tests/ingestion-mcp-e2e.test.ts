import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import * as readline from 'node:readline';

interface JsonRpcResponse {
  jsonrpc: string;
  id: string | number | null;
  result?: any;
  error?: {
    code: number;
    message: string;
    data?: any;
  };
}

function createMcpClient(dataDir: string, user = 'workflow-user') {
  const cliPath = resolve('dist/cli.js');
  const child = spawn(process.execPath, [cliPath, '--data-dir', dataDir, '--user', user], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  const lines = readline.createInterface({
    input: child.stdout!,
    crlfDelay: Infinity,
  });

  let nextId = 0;
  const pending = new Map<number, (res: JsonRpcResponse) => void>();

  lines.on('line', (line) => {
    if (!line.trim()) return;
    try {
      const response = JSON.parse(line) as JsonRpcResponse;
      const id = typeof response.id === 'number' ? response.id : Number(response.id);
      if (pending.has(id)) {
        const handler = pending.get(id)!;
        pending.delete(id);
        handler(response);
      }
    } catch {
      // ignore non-json
    }
  });

  const send = (method: string, params?: Record<string, unknown>) =>
    new Promise<JsonRpcResponse>((resolveSend) => {
      const id = ++nextId;
      pending.set(id, resolveSend);
      child.stdin!.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, ...(params ? { params } : {}) })}\n`);
    });

  const callTool = async (name: string, args: Record<string, unknown> = {}) => {
    const response = await send('tools/call', { name, arguments: args });
    if (response.error) {
      const err = new Error(response.error.message || 'MCP tool call failed');
      (err as any).data = response.error.data;
      throw err;
    }
    return response.result?.structuredContent;
  };

  const close = () =>
    new Promise<void>((resolveClose) => {
      child.once('close', () => resolveClose());
      lines.close();
      child.stdin!.end();
    });

  return { send, callTool, close };
}

describe('Ticket 07 Public MCP Ingestion E2E Workflow', () => {
  it('verifies multi-benefit + shared exclusion, interrupted resume, atomic rollback, supersession, and recommendation visibility over stdio MCP', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'mcp-ingestion-e2e-'));
    let client = createMcpClient(dataDir, 'workflow-user');

    try {
      // 1. Initialize MCP server
      const initRes = await client.send('initialize');
      expect(initRes.result).toBeDefined();
      expect(initRes.result.serverInfo.name).toBe('taiwan_card_rewards_mcp');

      // 2. Register initial card and baseline active offer
      await client.callTool('register_card', {
        card: {
          id: 'card-premium',
          issuer: 'BankX',
          productName: 'Premium Rewards Card',
        },
      });

      await client.callTool('upsert_offer', {
        snapshot: {
          id: 'snap-baseline',
          url: 'https://bank.example/card-premium',
          fetchedAt: '2026-01-01T00:00:00.000Z',
          contentHash: 'hash-baseline',
          parserVersion: '1',
          verified: true,
          sourceType: 'official',
        },
        rule: {
          id: 'rule-baseline',
          cardId: 'card-premium',
          version: '1',
          sourceSnapshotId: 'snap-baseline',
          status: 'active',
          validFrom: '2026-01-01T00:00:00.000Z',
          settlementCurrency: 'TWD',
          match: {},
          reward: { kind: 'percentage', rateBps: 100 },
        },
      });

      // Baseline recommendation visibility
      const initialRec = await client.callTool('recommend', {
        country: 'TW',
        amount: { amountMinor: 10000, currency: 'TWD' },
        merchant: 'Bistro',
        channel: 'restaurant',
        occurredAt: '2026-09-16T12:00:00.000Z',
      });
      expect(initialRec.candidates).toHaveLength(1);
      expect(initialRec.candidates[0].matchedRules[0].ruleId).toBe('rule-baseline');
      expect(initialRec.candidates[0].reward.amountMinor).toBe(100);

      // 3. Create ingestion draft and test Interrupted Resume
      const createRes1 = await client.callTool('create_ingestion', {
        sourceScope: { kind: 'official_url', value: 'https://bank.example/card-premium-offers' },
        idempotencyKey: 'ingest-card-premium-2026',
      });
      expect(createRes1.flow.status).toBe('awaiting_source');
      expect(createRes1.nextAction.kind).toBe('SUBMIT_SOURCE');
      const flowId = createRes1.flow.id;

      // Inspect flow via get_ingestion
      const inspectRes = await client.callTool('get_ingestion', { flowId });
      expect(inspectRes.flow.id).toBe(flowId);
      expect(inspectRes.flow.status).toBe('awaiting_source');

      // Calling create_ingestion with same sourceScope resumes the active draft
      const resumeRes = await client.callTool('create_ingestion', {
        sourceScope: { kind: 'official_url', value: 'https://bank.example/card-premium-offers' },
        idempotencyKey: 'ingest-card-premium-resume',
      });
      expect(resumeRes.flow.id).toBe(flowId);
      expect(resumeRes.flow.status).toBe('awaiting_source');

      // 4. Submit source capture
      const sourceRes = await client.callTool('submit_ingestion_source', {
        flowId,
        actionId: resumeRes.nextAction.actionId,
        expectedRevision: resumeRes.nextAction.expectedRevision,
        sourceCapture: {
          sourceType: 'official',
          url: 'https://bank.example/card-premium-offers',
          retrievedAt: '2026-09-16T00:00:00.000Z',
          contentHash: 'hash-premium-capture-v1',
          artifactRef: 'artifact:card-premium-offers-v1',
          submitter: 'agent',
          submittedAt: '2026-09-16T00:00:00.000Z',
        },
      });
      expect(sourceRes.flow.status).toBe('awaiting_manifest');
      expect(sourceRes.nextAction.kind).toBe('SUBMIT_MANIFEST');

      // 5. Submit manifest with multi-benefit + shared exclusion
      const manifestRes = await client.callTool('submit_ingestion_manifest', {
        flowId,
        actionId: sourceRes.nextAction.actionId,
        expectedRevision: sourceRes.nextAction.expectedRevision,
        manifest: [
          {
            id: 'ex-wallet',
            kind: 'exclusion',
            summary: 'Exclude digital wallet proxy payments',
            evidenceLocator: 'page:1#exclusions',
            dependsOn: [],
          },
          {
            id: 'ben-dining',
            kind: 'benefit',
            summary: '5% Dining reward superseding baseline',
            evidenceLocator: 'page:2#dining',
            dependsOn: ['ex-wallet'],
          },
          {
            id: 'ben-online',
            kind: 'benefit',
            summary: '3% Online shopping reward',
            evidenceLocator: 'page:3#online',
            dependsOn: ['ex-wallet'],
          },
        ],
      });
      expect(manifestRes.flow.status).toBe('processing_leaves');
      expect(manifestRes.nextAction.kind).toBe('PROCESS_LEAF');
      expect(manifestRes.nextAction.leafId).toBe('ex-wallet');

      // 6. Submit shared exclusion leaf
      const exclusionRes = await client.callTool('submit_exclusion_leaf', {
        flowId,
        actionId: manifestRes.nextAction.actionId,
        expectedRevision: manifestRes.nextAction.expectedRevision,
        idempotencyKey: 'ex-wallet-key',
        leafId: 'ex-wallet',
        target: 'payment_method',
        scope: { kind: 'all_benefits' },
        predicate: { field: 'transaction.paymentMethod', op: 'EQUALS', value: 'wallet-x' },
        evidenceRefs: ['page:1#exclusions'],
      });
      expect(exclusionRes.flow.flow.status).toBe('processing_leaves');
      expect(exclusionRes.flow.nextAction.leafId).toBe('ben-dining');

      // 7. Submit benefit leaf: ben-dining (supersedes rule-baseline)
      const diningRes = await client.callTool('submit_benefit_leaf', {
        flowId,
        actionId: exclusionRes.flow.nextAction.actionId,
        expectedRevision: exclusionRes.flow.nextAction.expectedRevision,
        idempotencyKey: 'ben-dining-key',
        leafId: 'ben-dining',
        evidenceRefs: ['page:2#dining'],
        offer: {
          snapshot: {
            id: 'snap-dining',
            url: 'https://bank.example/card-premium-offers',
            fetchedAt: '2026-09-16T00:00:00.000Z',
            contentHash: 'hash-premium-capture-v1',
            parserVersion: '1',
            verified: true,
            sourceType: 'official',
          },
          rule: {
            id: 'rule-dining',
            cardId: 'card-premium',
            version: '1',
            sourceSnapshotId: 'snap-dining',
            status: 'candidate',
            validFrom: '2026-01-01T00:00:00.000Z',
            settlementCurrency: 'TWD',
            match: { channels: ['restaurant'] },
            reward: { kind: 'percentage', rateBps: 500 },
            supersedesRuleId: 'rule-baseline',
          },
        },
      });
      expect(diningRes.flow.flow.status).toBe('processing_leaves');
      expect(diningRes.flow.nextAction.leafId).toBe('ben-online');

      // 8. Submit benefit leaf: ben-online
      const onlineRes = await client.callTool('submit_benefit_leaf', {
        flowId,
        actionId: diningRes.flow.nextAction.actionId,
        expectedRevision: diningRes.flow.nextAction.expectedRevision,
        idempotencyKey: 'ben-online-key',
        leafId: 'ben-online',
        evidenceRefs: ['page:3#online'],
        offer: {
          snapshot: {
            id: 'snap-online',
            url: 'https://bank.example/card-premium-offers',
            fetchedAt: '2026-09-16T00:00:00.000Z',
            contentHash: 'hash-premium-capture-v1',
            parserVersion: '1',
            verified: true,
            sourceType: 'official',
          },
          rule: {
            id: 'rule-online',
            cardId: 'card-premium',
            version: '1',
            sourceSnapshotId: 'snap-online',
            status: 'candidate',
            validFrom: '2026-01-01T00:00:00.000Z',
            settlementCurrency: 'TWD',
            match: { channels: ['online'] },
            reward: { kind: 'percentage', rateBps: 300 },
          },
        },
      });
      expect(onlineRes.flow.flow.status).toBe('ready_to_finalize');
      expect(onlineRes.flow.nextAction.kind).toBe('FINALIZE');

      // Candidate rules must remain invisible before finalization
      const activeOffersBefore = await client.callTool('search_active_offers', { cardId: 'card-premium' });
      expect(activeOffersBefore.offers.map((o: any) => o.id)).toEqual(['rule-baseline']);

      // 9. Atomic Rollback Test
      // Simulate an interrupted process whose persisted candidate snapshot was
      // corrupted before it resumed and tried to finalize.
      await client.close();
      const stateFilePath = join(dataDir, 'card-rewards.json');
      const pristineStateText = readFileSync(stateFilePath, 'utf8');
      const tamperedState = JSON.parse(pristineStateText);
      tamperedState.snapshots = tamperedState.snapshots.filter((snapshot: any) => snapshot.id !== 'snap-online');
      writeFileSync(stateFilePath, JSON.stringify(tamperedState, null, 2));
      client = createMcpClient(dataDir, 'workflow-user');
      await client.send('initialize');

      await expect(
        client.callTool('finalize_ingestion', {
          flowId,
          actionId: onlineRes.flow.nextAction.actionId,
          expectedRevision: onlineRes.flow.nextAction.expectedRevision,
        })
      ).rejects.toThrow('NEEDS_REVIEW');

      // Verify atomic rollback: the predecessor remains active and candidates remain candidates.
      const stateAfterRollback = JSON.parse(readFileSync(stateFilePath, 'utf8'));
      expect(stateAfterRollback.rules.find((rule: any) => rule.id === 'rule-baseline').status).toBe('active');
      expect(stateAfterRollback.rules.find((rule: any) => rule.id === 'rule-dining').status).toBe('candidate');

      // Restore the exact persisted state, restart, and finalize the resumed flow.
      await client.close();
      writeFileSync(stateFilePath, pristineStateText);
      client = createMcpClient(dataDir, 'workflow-user');
      await client.send('initialize');

      // 10. Atomic Finalization & Supersession
      const finalizeRes = await client.callTool('finalize_ingestion', {
        flowId,
        actionId: onlineRes.flow.nextAction.actionId,
        expectedRevision: onlineRes.flow.nextAction.expectedRevision,
      });
      expect(finalizeRes.proof).toBeDefined();
      expect(finalizeRes.proof.leafTotals).toEqual({ total: 3, materialized: 3, ignored: 0, superseded: 0 });
      expect(finalizeRes.proof.activatedRules).toEqual([
        { ruleId: 'rule-dining', ruleVersion: '1' },
        { ruleId: 'rule-online', ruleVersion: '1' },
      ]);
      expect(finalizeRes.proof.awaitingConfirmationRules).toEqual([]);
      expect(finalizeRes.flow.flow.status).toBe('complete');

      // 11. Verify Recommendation Visibility & Exclusion Enforcement
      // A) Dining with credit_card: rule-dining matches (5% = 500 minor); superseded rule-baseline is invisible
      const diningRec = await client.callTool('recommend', {
        country: 'TW',
        amount: { amountMinor: 10000, currency: 'TWD' },
        merchant: 'Bistro',
        channel: 'restaurant',
        paymentMethod: 'credit_card',
        occurredAt: '2026-09-16T12:00:00.000Z',
      });
      expect(diningRec.candidates).toHaveLength(1);
      expect(diningRec.candidates[0].matchedRules.find((rule: any) => rule.status === 'matched').ruleId).toBe('rule-dining');
      expect(diningRec.candidates[0].reward.amountMinor).toBe(500);

      // B) Dining with wallet-x: excluded by shared exclusion ex-wallet
      const excludedRec = await client.callTool('recommend', {
        country: 'TW',
        amount: { amountMinor: 10000, currency: 'TWD' },
        merchant: 'Bistro',
        channel: 'restaurant',
        paymentMethod: 'wallet-x',
        occurredAt: '2026-09-16T12:00:00.000Z',
      });
      expect(excludedRec.candidates[0].status).toBe('no_match');
      expect(excludedRec.candidates[0].matchedRules.some((rule: any) => rule.status === 'excluded')).toBe(true);

      // C) Online channel: rule-online matches (3% = 300 minor)
      const onlineRec = await client.callTool('recommend', {
        country: 'TW',
        amount: { amountMinor: 10000, currency: 'TWD' },
        merchant: 'ShopOnline',
        channel: 'online',
        paymentMethod: 'credit_card',
        occurredAt: '2026-09-16T12:00:00.000Z',
      });
      expect(onlineRec.candidates).toHaveLength(1);
      expect(onlineRec.candidates[0].matchedRules.find((rule: any) => rule.status === 'matched').ruleId).toBe('rule-online');
      expect(onlineRec.candidates[0].reward.amountMinor).toBe(300);
    } finally {
      await client.close();
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
