import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
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

function createMcpClient(dataDir: string, user = 'gemini-flash-user') {
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

describe('Gemini 3.8 Flash Medium deterministic public-contract workflow test', () => {
  it('verifies 20 MCP tools and full end-to-end guidance lifecycle over stdio', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'gemini-workflow-e2e-'));
    const client = createMcpClient(dataDir, 'gemini-flash-user');

    try {
      // Step 1: Initialize and verify 20 MCP tools
      const initRes = await client.send('initialize');
      expect(initRes.result).toBeDefined();
      expect(initRes.result.serverInfo.name).toBe('taiwan_card_rewards_mcp');

      const toolsRes = await client.send('tools/list');
      const toolNames = toolsRes.result.tools.map((t: any) => t.name);
      expect(toolNames).toHaveLength(20);
      expect(toolNames).toContain('recommend');
      expect(toolNames).toContain('resolve_merchant');
      expect(toolNames).toContain('upsert_offer');
      expect(toolNames).toContain('record_transaction');
      expect(toolNames).toContain('list_transactions');
      expect(toolNames).toContain('upsert_payment_capability');

      // Setup baseline cards
      await client.callTool('register_card', {
        card: {
          id: 'card-taishin-rose',
          issuer: 'Taishin Bank',
          productName: 'Richart Rose Card',
          network: 'Mastercard',
          country: 'TW',
        },
      });
      await client.callTool('register_card', {
        card: {
          id: 'card-esun-kuma-jcb',
          issuer: 'ESun Bank',
          productName: 'Kumamon Card',
          network: 'JCB',
          country: 'TW',
        },
      });
      await client.callTool('register_card', {
        card: {
          id: 'card-fubon-j-jcb',
          issuer: 'Fubon Bank',
          productName: 'J Card',
          network: 'JCB',
          country: 'TW',
        },
      });

      // Step 2: Merchant resolution & ambiguity handling
      // 2a. Unresolved merchant produces requiredFacts
      const unresolved = await client.callTool('resolve_merchant', {
        rawQuery: '未知的小攤販',
      });
      expect(unresolved.resolutionStatus).toBe('unresolved');
      expect(unresolved.requiredFacts).toContain('transaction.merchant');

      // 2b. Register merchant via upsert_offer candidate onboarding
      const merchantSnapshot = {
        id: 'snap-pxmart-official',
        url: 'https://pxmart.example/offers',
        fetchedAt: '2026-09-14T00:00:00Z',
        contentHash: 'hash-pxmart-2026',
        parserVersion: '1.0.0',
        verified: true,
      };
      const merchantOfferResult = await client.callTool('upsert_offer', {
        snapshot: merchantSnapshot,
        rule: {
          id: 'rule-pxmart-rose-candidate',
          cardId: 'card-taishin-rose',
          version: '1.0.0',
          sourceSnapshotId: merchantSnapshot.id,
          status: 'candidate',
          validFrom: '2026-01-01T00:00:00Z',
          settlementCurrency: 'TWD',
          match: {},
          reward: { kind: 'percentage', rateBps: 380 },
        },
        merchant: {
          canonicalNameZhHant: '全聯福利中心',
          canonicalNameLocale: 'zh-Hant-TW',
          status: 'candidate',
          officialAliases: ['全聯'],
          operatingMarkets: ['TW'],
          provenance: { version: '1', updatedAt: '2026-09-14T00:00:00Z' },
        },
      });
      expect(merchantOfferResult.rule.status).toBe('candidate');

      // Also register active general offer for Taishin Rose
      const generalSnapshot = {
        id: 'snap-taishin-general',
        url: 'https://bank.example/rose',
        fetchedAt: '2026-09-14T00:00:00Z',
        contentHash: 'hash-taishin-general',
        parserVersion: '1.0.0',
        verified: true,
      };
      await client.callTool('upsert_offer', {
        snapshot: generalSnapshot,
        rule: {
          id: 'rule-taishin-rose-active',
          cardId: 'card-taishin-rose',
          version: '1.0.0',
          sourceSnapshotId: generalSnapshot.id,
          status: 'active',
          validFrom: '2026-01-01T00:00:00Z',
          settlementCurrency: 'TWD',
          match: {},
          reward: { kind: 'percentage', rateBps: 380 },
        },
      });

      // 2c. Now resolve_merchant confirms exact/alias match
      const resolved = await client.callTool('resolve_merchant', {
        rawQuery: '全聯',
        country: 'TW',
        market: 'TW',
      });
      expect(resolved.resolutionStatus).toBe('confirmed');
      expect(resolved.merchant.canonicalNameZhHant).toBe('全聯福利中心');
      const canonicalMchId = resolved.merchant.canonicalId;

      // Step 3: Direct recommendation without prior card/route listing
      const recDirect = await client.callTool('recommend', {
        merchant: {
          canonicalId: canonicalMchId,
          canonicalNameZhHant: '全聯福利中心',
        },
        amount: { amountMinor: 150000, currency: 'TWD' },
        occurredAt: '2026-09-14T14:00:00Z',
      });
      expect(['ready', 'partial']).toContain(recDirect.status);
      expect(recDirect.candidates.length).toBeGreaterThan(0);
      const topDirect = recDirect.candidates.find((c: any) => c.cardId === 'card-taishin-rose');
      expect(topDirect).toBeDefined();
      expect(topDirect.status).toBe('ready');
      expect(topDirect.cardId).toBe('card-taishin-rose');
      expect(topDirect.reward.amountMinor).toBe(5700); // 1500 * 3.8% = 57 TWD (5700 minor)

      // Step 4: Route selector generated paths from capability
      // Add payment capabilities for LINE Pay and PX Pay
      const capLinePay = await client.callTool('upsert_payment_capability', {
        capability: {
          id: 'cap-line-pay',
          providerId: 'line_pay',
          acceptanceProviderId: 'line_network',
          consumerAppId: 'line_pay_app',
          fundingKinds: ['credit_card'],
          transitions: ['card_authorization', 'service_to_acceptance', 'merchant_settlement'],
          sourceUrl: 'https://linepay.example/specs',
          evidenceIds: ['ev-linepay-spec'],
          observedAt: '2026-09-14T00:00:00Z',
          idempotencyKey: 'cap-line-pay-key',
        },
      });
      expect(capLinePay.status).toBe('active');

      // Add offer with routeSelector allowing line_pay with 5% reward
      const routeOfferSnapshot = {
        id: 'snap-linepay-promo',
        url: 'https://bank.example/promo-linepay',
        fetchedAt: '2026-09-14T00:00:00Z',
        contentHash: 'hash-linepay-promo',
        parserVersion: '1.0.0',
        verified: true,
      };
      await client.callTool('upsert_offer', {
        snapshot: routeOfferSnapshot,
        rule: {
          id: 'rule-linepay-taishin-500',
          cardId: 'card-taishin-rose',
          version: '1.0.0',
          sourceSnapshotId: routeOfferSnapshot.id,
          status: 'active',
          validFrom: '2026-01-01T00:00:00Z',
          settlementCurrency: 'TWD',
          match: {},
          reward: { kind: 'percentage', rateBps: 500 },
          routeSelector: {
            paymentServiceAllowlist: ['line_pay'],
            fundingKinds: ['credit_card'],
            transitions: ['card_authorization'],
          },
        },
      });

      // Recommend again: dynamic generated payment_path candidate is generated
      const recWithRoute = await client.callTool('recommend', {
        merchant: '全聯福利中心',
        amount: { amountMinor: 150000, currency: 'TWD' },
        occurredAt: '2026-09-14T14:05:00Z',
      });
      expect(['ready', 'partial']).toContain(recWithRoute.status);
      const pathCandidate = recWithRoute.candidates.find(
        (c: any) => c.kind === 'payment_path' && c.matchedRules?.some((r: any) => r.ruleId === 'rule-linepay-taishin-500'),
      );
      expect(pathCandidate).toBeDefined();
      expect(pathCandidate.reward.amountMinor).toBe(13200); // 3.8% base (5700) + 5.0% line pay promo (7500) = 13200 minor

      // Step 5: Compatible-key FX reuse across cards
      // Register rules for both JCB cards in JPY
      const jcbSnapshot = {
        id: 'snap-jcb-japan',
        url: 'https://jcb.example/japan-rewards',
        fetchedAt: '2026-09-14T00:00:00Z',
        contentHash: 'hash-jcb-japan',
        parserVersion: '1.0.0',
        verified: true,
      };
      await client.callTool('upsert_offer', {
        snapshot: jcbSnapshot,
        rule: {
          id: 'rule-kuma-jp-200',
          cardId: 'card-esun-kuma-jcb',
          version: '1.0.0',
          sourceSnapshotId: jcbSnapshot.id,
          status: 'active',
          validFrom: '2026-01-01T00:00:00Z',
          settlementCurrency: 'TWD',
          match: { countries: ['JP'] },
          reward: { kind: 'percentage', rateBps: 200 },
        },
      });
      await client.callTool('upsert_offer', {
        snapshot: jcbSnapshot,
        rule: {
          id: 'rule-fubon-jp-300',
          cardId: 'card-fubon-j-jcb',
          version: '1.0.0',
          sourceSnapshotId: jcbSnapshot.id,
          status: 'active',
          validFrom: '2026-01-01T00:00:00Z',
          settlementCurrency: 'TWD',
          match: { countries: ['JP'] },
          reward: { kind: 'percentage', rateBps: 300 },
        },
      });

      // Recommend with single JCB FX snapshot
      const jcbFx = {
        id: 'fx-jcb-shared-snapshot',
        baseCurrency: 'JPY',
        quoteCurrency: 'TWD',
        ratePpm: 215000, // 0.215
        capturedAt: '2026-09-14T10:00:00Z',
        provider: 'JCB',
        rateType: 'card_scheme',
        cardScheme: 'JCB',
        conversionOwner: 'card_scheme',
        maxAgeSeconds: 86400,
      };
      const recFx = await client.callTool('recommend', {
        merchant: '唐吉訶德',
        amount: { amountMinor: 1000000, currency: 'JPY' },
        country: 'JP',
        occurredAt: '2026-09-14T10:00:00Z',
        fx: jcbFx,
      });
      expect(['ready', 'partial']).toContain(recFx.status);
      const kumaCand = recFx.candidates.find((c: any) => c.cardId === 'card-esun-kuma-jcb');
      const fubonCand = recFx.candidates.find((c: any) => c.cardId === 'card-fubon-j-jcb');
      expect(kumaCand?.status).toBe('ready');
      expect(kumaCand?.fxEstimate?.status).toBe('estimated');
      expect(fubonCand?.status).toBe('ready');
      expect(fubonCand?.fxEstimate?.status).toBe('estimated');

      // Step 6: External source failure handling (stop retrying, deliver requiredActions)
      const recMissingFx = await client.callTool('recommend', {
        merchant: '首爾樂天免稅店',
        amount: { amountMinor: 5000000, currency: 'KRW' },
        country: 'KR',
        occurredAt: '2026-09-14T10:00:00Z',
      });
      expect(['action_required', 'partial']).toContain(recMissingFx.status);
      expect(recMissingFx.requiredActions.length).toBeGreaterThan(0);
      const fxAction = recMissingFx.requiredActions.find((a: any) => a.action === 'query_approved_fx_source');
      expect(fxAction).toBeDefined();
      expect(fxAction.owner).toBe('agent');
      expect(fxAction.fxResolutionRequest.baseCurrency).toBe('KRW');
      expect(fxAction.fxResolutionRequest.referenceSourceUrls).toContain('https://rate.bot.com.tw/xrt?Lang=zh-TW');

      // Step 7: Two-phase user correction flow ("差異預覽 → 確認 → 寫入")
      // 7a. Unconfirmed user correction fails closed
      const userCorrectionSnap = {
        id: 'snap-user-correction-kuma',
        sourceType: 'user_input',
        fetchedAt: '2026-09-14T15:00:00Z',
        contentHash: 'hash-user-correction',
        parserVersion: '1.0.0',
        provenance: {
          sourceDescription: 'User chat correction',
          submitter: 'gemini-flash-user',
          submittedAt: '2026-09-14T15:00:00Z',
          contentFingerprint: 'fp-kuma-350',
        },
      };
      const userCorrectionRule = {
        id: 'rule-kuma-jp-override-v2',
        cardId: 'card-esun-kuma-jcb',
        version: '2.0.0',
        sourceSnapshotId: userCorrectionSnap.id,
        status: 'active',
        trustBasis: 'user_confirmed',
        validFrom: '2026-09-01T00:00:00Z',
        settlementCurrency: 'TWD',
        match: { countries: ['JP'] },
        reward: { kind: 'percentage', rateBps: 350 },
      };

      // 7a. Preview the correction against the current rule before any durable write.
      // calculate_reward is public and pure, so the agent can show this difference
      // without activating the user-supplied candidate.
      const correctionPreviewTransaction = {
        cardId: 'card-esun-kuma-jcb',
        kind: 'purchase',
        mode: 'planned',
        occurredAt: '2026-09-14T15:01:00Z',
        amount: { amountMinor: 100000, currency: 'TWD' },
        country: 'JP',
      };
      const currentRuleSnapshot = {
        ...jcbSnapshot,
        id: 'snap-jcb-fx',
      };
      const correctionPreviewContext = {
        now: '2026-09-14T15:01:00Z',
        sourceSnapshots: {
          [currentRuleSnapshot.id]: currentRuleSnapshot,
          [userCorrectionSnap.id]: userCorrectionSnap,
        },
      };
      const currentRulePreview = await client.callTool('calculate_reward', {
        rule: {
          id: 'rule-kuma-jp-200',
          cardId: 'card-esun-kuma-jcb',
          version: '1.0.0',
          sourceSnapshotId: currentRuleSnapshot.id,
          status: 'active',
          validFrom: '2026-01-01T00:00:00Z',
          settlementCurrency: 'TWD',
          match: { countries: ['JP'] },
          reward: { kind: 'percentage', rateBps: 200 },
        },
        transaction: correctionPreviewTransaction,
        context: correctionPreviewContext,
      });
      const candidatePreview = await client.callTool('calculate_reward', {
        rule: userCorrectionRule,
        transaction: correctionPreviewTransaction,
        context: correctionPreviewContext,
      });
      expect(currentRulePreview.grossReward.amountMinor).toBe(2000);
      expect(candidatePreview.grossReward.amountMinor).toBe(3500);

      // Writing without confirmation must fail
      await expect(
        client.callTool('upsert_offer', {
          snapshot: userCorrectionSnap,
          rule: userCorrectionRule,
        }),
      ).rejects.toThrow();

      // 7b. Writing with user confirmation succeeds
      const confirmedOfferResult = await client.callTool('upsert_offer', {
        snapshot: userCorrectionSnap,
        rule: userCorrectionRule,
        confirmation: {
          confirmedAt: '2026-09-14T15:05:00Z',
          confirmedBy: 'gemini-flash-user',
          sourceReference: 'chat_session_20260914',
          trustBasis: 'user_confirmed',
          termsFingerprint: 'fp-kuma-350',
          offerPeriod: { validFrom: '2026-09-01T00:00:00Z' },
          rewardUnit: 'TWD',
          rewardConditionsSummary: '日本實體加碼 3.5%',
          capSummary: '無上限',
        },
      });
      expect(confirmedOfferResult.rule.status).toBe('active');
      expect(confirmedOfferResult.rule.trustBasis).toBe('user_confirmed');

      // Verify confirmed rule applies in subsequent recommendation
      const recAfterCorrection = await client.callTool('recommend', {
        merchant: '唐吉訶德',
        amount: { amountMinor: 1000000, currency: 'JPY' },
        country: 'JP',
        occurredAt: '2026-09-14T15:10:00Z',
        fx: jcbFx,
      });
      const updatedKumaCand = recAfterCorrection.candidates.find((c: any) => c.cardId === 'card-esun-kuma-jcb');
      expect(updatedKumaCand?.status).toBe('ready');
      expect(updatedKumaCand?.matchedRules).toEqual(
        expect.arrayContaining([expect.objectContaining({ ruleId: 'rule-kuma-jp-override-v2', trustBasis: 'user_confirmed' })]),
      );

      // Step 8: Unified transactions with 4 funding sources
      // Funding 1: credit_card
      const txCard = await client.callTool('record_transaction', {
        transaction: {
          idempotencyKey: 'tx-001-credit-card',
          kind: 'purchase',
          mode: 'actual',
          occurredAt: '2026-09-14T11:00:00Z',
          amount: { amountMinor: 300000, currency: 'TWD' },
          cardId: 'card-taishin-rose',
          funding: { kind: 'credit_card', cardId: 'card-taishin-rose' },
          merchant: '全聯福利中心',
        },
      });
      expect(txCard.status).toBe('ok');

      // Funding 2: account (linked_bank_account)
      const txBank = await client.callTool('record_transaction', {
        transaction: {
          idempotencyKey: 'tx-002-linked-bank',
          kind: 'purchase',
          mode: 'actual',
          occurredAt: '2026-09-14T12:00:00Z',
          amount: { amountMinor: 120000, currency: 'TWD' },
          funding: { kind: 'account', subtype: 'linked_bank_account', accountId: 'acc-taishin-main' },
          merchant: '街口繳費',
        },
      });
      // Tier 1 Red line #3: Non-blocking write even when reward is unknown
      expect(txBank.status).toBe('unknown');

      // Funding 3: account (wallet_balance)
      const txWallet = await client.callTool('record_transaction', {
        transaction: {
          idempotencyKey: 'tx-003-wallet-balance',
          kind: 'purchase',
          mode: 'actual',
          occurredAt: '2026-09-14T13:00:00Z',
          amount: { amountMinor: 80000, currency: 'TWD' },
          funding: { kind: 'account', subtype: 'wallet_balance', accountId: 'acc-pxpay-wallet' },
          merchant: '全聯大安店',
        },
      });
      expect(txWallet.status).toBe('unknown');

      // Funding 4: cash (no cardId allowed)
      const txCash = await client.callTool('record_transaction', {
        transaction: {
          idempotencyKey: 'tx-004-cash',
          kind: 'purchase',
          mode: 'actual',
          occurredAt: '2026-09-14T14:00:00Z',
          amount: { amountMinor: 60000, currency: 'TWD' },
          funding: { kind: 'cash' },
          merchant: '傳統早市',
        },
      });
      expect(txCash.status).toBe('unknown');

      // Step 9: Dual time basis querying (occurred_at vs recorded_at)
      // Query by occurred_at
      const listByOccurred = await client.callTool('list_transactions', {
        startDate: '2026-09-14T00:00:00Z',
        endDate: '2026-09-14T23:59:59Z',
        timeBasis: 'occurred_at',
        projection: 'summary',
        limit: 50,
      });
      expect(listByOccurred.items).toHaveLength(4);
      expect(listByOccurred.pageInfo.total).toBe(4);
      expect(listByOccurred.items.map((t: any) => t.idempotencyKey)).toEqual([
        'tx-001-credit-card',
        'tx-002-linked-bank',
        'tx-003-wallet-balance',
        'tx-004-cash',
      ]);

      // Query by recorded_at
      const listByRecorded = await client.callTool('list_transactions', {
        timeBasis: 'recorded_at',
        projection: 'summary',
        limit: 50,
      });
      expect(listByRecorded.items).toHaveLength(4);
      expect(listByRecorded.pageInfo.total).toBe(4);
    } finally {
      await client.close();
      rmSync(dataDir, { recursive: true, force: true });
    }
  }, 30_000);
});
