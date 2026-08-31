import { contentHash, FileStore, type RecordedTransaction, type StoredState } from './store.js';
import { evaluateOffer, rankCards } from './evaluator.js';
import type { CardDescriptor, EvaluationContext, Money, OfferRuleVersion, OfferSourceSnapshot, RankingEntry, RewardBreakdown, TransactionTuple } from './types.js';
import type { StartupConfig } from './startup.js';
import { RewardServiceError } from './errors.js';
import { validateCard, validateRule, validateSnapshot, validateTransaction } from './validation.js';
import { assertPublicAllowedHost, readResponseWithLimit } from './source-policy.js';

export { RewardServiceError } from './errors.js';

export interface RemainingCap { ruleId: string; usageKey: string; remaining: Money; }

function nowIso(): string { return new Date().toISOString(); }

export class RewardService {
  constructor(readonly store: FileStore, readonly metadataUser: string | undefined, readonly allowedSourceHosts: readonly string[] = []) {}

  private context(state: StoredState, now = nowIso()): EvaluationContext {
    const usageByKey: Record<string, Money> = {};
    for (const rule of state.rules) {
      if (!rule.cap) continue;
      const total = state.transactions
        .filter((record) => record.reward.ruleId === rule.id && record.transaction.kind === 'purchase' && record.transaction.mode === 'actual')
        .reduce((sum, record) => sum + (record.reward.cappedReward?.amountMinor ?? 0), 0);
      usageByKey[rule.cap.usageKey] = { amountMinor: total, currency: rule.cap.cap.currency };
    }
    return {
      now,
      usageByKey,
      sourceSnapshots: Object.fromEntries(state.snapshots.map((snapshot) => [snapshot.id, snapshot])),
    };
  }

  registerCard(card: CardDescriptor): CardDescriptor {
    card = validateCard(card);
    if (!card.id || !card.issuer || !card.productName) throw new RewardServiceError('INVALID_CARD', 'card id, issuer, and productName are required');
    let result!: CardDescriptor;
    this.store.update((state) => {
      const index = state.cards.findIndex((item) => item.id === card.id);
      if (index >= 0) state.cards[index] = card;
      else state.cards.push(card);
      result = card;
    });
    return result;
  }

  listCards(): CardDescriptor[] { return this.store.read().cards; }

  upsertOffer(snapshot: OfferSourceSnapshot, rule: OfferRuleVersion): { snapshot: OfferSourceSnapshot; rule: OfferRuleVersion } {
    snapshot = validateSnapshot(snapshot);
    rule = validateRule(rule);
    if (!snapshot.id || !snapshot.url || !snapshot.contentHash || !snapshot.parserVersion) throw new RewardServiceError('INVALID_OFFER', 'source snapshot metadata is incomplete');
    if (rule.sourceSnapshotId !== snapshot.id || !rule.id || !rule.cardId) throw new RewardServiceError('INVALID_OFFER', 'rule must reference its source snapshot');
    const snapshotHost = new URL(snapshot.url).hostname.toLowerCase();
    if (!this.allowedSourceHosts.includes(snapshotHost)) throw new RewardServiceError('INVALID_OFFER', 'snapshot hostname is not on the trusted official allowlist');
    if (rule.cap && rule.cap.cap.currency !== rule.settlementCurrency) throw new RewardServiceError('INVALID_OFFER', 'cap currency must match settlementCurrency in Phase 1');
    this.store.update((state) => {
      const snapshotIndex = state.snapshots.findIndex((item) => item.id === snapshot.id);
      if (snapshotIndex >= 0) state.snapshots[snapshotIndex] = snapshot;
      else state.snapshots.push(snapshot);
      const ruleIndex = state.rules.findIndex((item) => item.id === rule.id);
      if (ruleIndex >= 0) state.rules[ruleIndex] = rule;
      else state.rules.push(rule);
    });
    return { snapshot, rule };
  }

  recommend(transaction: TransactionTuple, limit = 5): RankingEntry[] {
    transaction = validateTransaction(transaction);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 5) throw new RewardServiceError('INVALID_INPUT', 'limit must be a safe integer from 1 to 5');
    const state = this.store.read();
    return rankCards(state.cards, state.rules, transaction, this.context(state), Math.min(5, Math.max(1, limit)));
  }

  recordTransaction(transaction: TransactionTuple): RewardBreakdown {
    transaction = validateTransaction(transaction);
    if (transaction.mode !== 'actual') throw new RewardServiceError('INVALID_TRANSACTION', 'record_transaction only accepts actual transactions');
    if (!transaction.idempotencyKey) throw new RewardServiceError('IDEMPOTENCY_REQUIRED', 'actual transactions require idempotencyKey');
    const state = this.store.read();
    const duplicate = state.transactions.find((record) => record.transaction.idempotencyKey === transaction.idempotencyKey);
    if (duplicate) {
      if (JSON.stringify(duplicate.transaction) !== JSON.stringify(transaction)) throw new RewardServiceError('IDEMPOTENCY_CONFLICT', 'idempotencyKey already belongs to a different transaction');
      return duplicate.reward;
    }
    if (transaction.kind === 'refund') {
      if (!transaction.refundOfId) throw new RewardServiceError('INVALID_REFUND', 'refund requires refundOfId');
      const original = state.transactions.find((record) => record.transaction.idempotencyKey === transaction.refundOfId);
      if (!original) throw new RewardServiceError('INVALID_REFUND', 'refundOfId does not reference a recorded transaction');
      if (original.transaction.cardId !== transaction.cardId) throw new RewardServiceError('INVALID_REFUND', 'refund must reference a transaction for the same card');
      transaction = { ...original.transaction, ...transaction, originalRewardMinor: original.reward.cappedReward?.amountMinor ?? 0 };
    }
    const results = state.rules
      .filter((rule) => rule.cardId === transaction.cardId)
      .map((rule) => evaluateOffer(rule, transaction, this.context(state, transaction.occurredAt)));
    const reward = results.filter((result) => result.status === 'ok').sort((a, b) => (b.cappedReward?.amountMinor ?? 0) - (a.cappedReward?.amountMinor ?? 0))[0];
    if (!reward) {
      const uncertain = results.find((result) => result.status !== 'no_match');
      throw new RewardServiceError(uncertain?.status === 'stale' ? 'STALE' : 'NEEDS_REVIEW', uncertain?.unknownReasons.join('; ') || 'no usable offer rule');
    }
    const record: RecordedTransaction = { transaction, reward };
    this.store.update((next) => { next.transactions.push(record); });
    return reward;
  }

  remainingCaps(cardId: string): RemainingCap[] {
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(cardId)) throw new RewardServiceError('INVALID_INPUT', 'cardId is invalid');
    const state = this.store.read();
    const context = this.context(state);
    return state.rules.filter((rule) => rule.cardId === cardId && rule.cap).map((rule) => {
      const cap = rule.cap!;
      const used = context.usageByKey?.[cap.usageKey]?.amountMinor ?? 0;
      return { ruleId: rule.id, usageKey: cap.usageKey, remaining: { amountMinor: Math.max(0, cap.cap.amountMinor - used), currency: cap.cap.currency } };
    });
  }

  async fetchPublicOffer(rawUrl: string): Promise<OfferSourceSnapshot> {
    let url: URL;
    try { url = new URL(rawUrl); } catch { throw new RewardServiceError('SOURCE_UNAVAILABLE', 'URL is invalid'); }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.port) throw new RewardServiceError('SOURCE_UNAVAILABLE', 'only public HTTP(S) URLs without credentials or custom ports are allowed');
    try {
      await assertPublicAllowedHost(url, this.allowedSourceHosts);
      const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(5000), headers: { accept: 'text/html,application/pdf,text/plain' } });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const contentType = response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase();
      if (contentType && !['text/html', 'application/pdf', 'text/plain'].includes(contentType)) throw new Error('source content type is not allowed');
      const body = await readResponseWithLimit(response, 1_000_000);
      return { id: `source-${contentHash(rawUrl).slice(0, 16)}`, url: rawUrl, fetchedAt: nowIso(), contentHash: contentHash(body), parserVersion: 'raw-text-1', excerpt: body.slice(0, 4000) };
    } catch (error) { throw new RewardServiceError('SOURCE_UNAVAILABLE', error instanceof Error ? error.message : 'source fetch failed'); }
  }
}
