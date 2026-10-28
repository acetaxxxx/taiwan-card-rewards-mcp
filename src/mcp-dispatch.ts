import type { CardDescriptor } from './types.js';
import { contentHash, type LedgerStore } from './store.js';
import { RewardService } from './service.js';
import { RewardServiceError } from './errors.js';
import { normalizeMcpToolArguments } from './mcp-contract.js';
import { evaluateOffer } from './evaluator.js';
import { validateUserBenefitInput, validateContext, validateToolArgs, validateTransaction, validateCard, validateCapPool, validateConfirmation, validateRule, validateSnapshot } from './validation.js';
import { projectPage } from './projections.js';

type MerchantResolutionFacts = Parameters<RewardService['resolveMerchant']>[1];
type ActiveOfferSearch = Parameters<RewardService['searchActiveOffers']>[0];

function merchantResolutionFacts(args: Record<string, unknown>): MerchantResolutionFacts {
  const facts: MerchantResolutionFacts = {};
  for (const field of ['country', 'market', 'mcc', 'channel'] as const) {
    if (typeof args[field] === 'string') facts[field] = args[field];
  }
  return facts;
}

function activeOfferSearch(args: Record<string, unknown>): ActiveOfferSearch {
  const search: ActiveOfferSearch = {};
  for (const field of ['rawQuery', 'cardId', 'canonicalMerchantId', 'country', 'market', 'mcc', 'channel', 'asOf'] as const) {
    if (typeof args[field] === 'string') search[field] = args[field];
  }
  for (const field of ['limit', 'page'] as const) {
    if (typeof args[field] === 'number') search[field] = args[field];
  }
  return search;
}

export async function callMcpTool(service: RewardService, params: Record<string, unknown>): Promise<unknown> {
  const name = params.name;
  if (typeof name !== 'string') throw new RewardServiceError('INVALID_INPUT', 'tool name is required');
  const rawArgs = params.arguments ?? {};
  const args = validateToolArgs(name, normalizeMcpToolArguments(name, rawArgs));
  const maybePaged = (value: unknown[], sortKey: (item: unknown) => string, maxItems = 20): unknown => {
    if (args.limit === undefined && args.page === undefined && args.projection === undefined) return value;
    const projection = typeof args.projection === 'string' ? args.projection : undefined;
    if (projection !== undefined && !['summary', 'detail', 'calculation', 'audit'].includes(projection)) throw new RewardServiceError('INVALID_INPUT', 'projection is invalid');
    const projected = projection === 'summary' ? value.map((item) => {
      if (!item || typeof item !== 'object') return item;
      const record = item as Record<string, unknown>;
      return { id: record.id, ...(record.issuer ? { issuer: record.issuer } : {}), ...(record.productName ? { productName: record.productName } : {}), ...(record.ruleId ? { ruleId: record.ruleId } : {}), ...(record.usageKey ? { usageKey: record.usageKey } : {}), ...(record.remaining ? { remaining: record.remaining } : {}) };
    }) : value;
    const effectivePage = typeof args.page === 'number' ? args.page : 1;
    const effectiveLimit = typeof args.limit === 'number' ? args.limit : 10;
    return projectPage(projected, { page: effectivePage, limit: effectiveLimit, maxItems, maxBytes: 256 * 1024, evaluatedAt: new Date().toISOString(), dataVersion: contentHash(JSON.stringify(projected)).slice(0, 16), sortKey });
  };
  switch (name) {
    case 'create_ingestion': return service.createIngestion(args);
    case 'get_ingestion': return service.inspectIngestion(String(args.flowId));
    case 'submit_ingestion_source': return service.submitIngestionSource(args);
    case 'submit_ingestion_manifest': return service.submitIngestionManifest(args);
    case 'correct_ingestion_manifest': return service.correctIngestionManifest(args);
    case 'submit_benefit_leaf': return service.submitBenefitLeaf(args);
    case 'submit_exclusion_leaf': return service.submitExclusionLeaf(args);
    case 'finalize_ingestion': return service.finalizeIngestion(args);
    case 'register_card': return service.registerCard(validateCard(args.card));
    case 'list_cards': return maybePaged(service.listCards(), (item) => String((item as CardDescriptor).id), 50);
    case 'upsert_offer': return service.upsertOffer(validateSnapshot(args.snapshot), validateRule(args.rule), args.confirmation !== undefined ? validateConfirmation(args.confirmation) : undefined, args.capPools === undefined ? undefined : (Array.isArray(args.capPools) ? args.capPools.map(validateCapPool) : []), args.merchant as any);
    case 'recommend': return service.recommendIntent(args);
    case 'upsert_payment_route': return service.upsertPaymentRoute(args.route);
    case 'list_payment_routes': return maybePaged([...service.listPaymentRoutes()], (item) => String((item as { id: string }).id), 50);
    case 'upsert_payment_capability': return service.upsertPaymentCapability(args.capability);
    case 'list_payment_capabilities': return service.listPaymentCapabilities();
    case 'register_payment_account': return service.upsertPaymentAccount(args.account);
    case 'list_payment_accounts': return maybePaged([...service.listPaymentAccounts()], (item) => String((item as { id: string }).id), 50);
    case 'record_transaction': return service.recordTransaction(validateTransaction(args.transaction));
    case 'list_transactions': return service.listTransactions(args);
    case 'record_event_reward': return service.recordValidatedEventReward(args);
    case 'reverse_event_reward': return service.reverseEventReward(args);
    case 'remaining_caps': return maybePaged(service.remainingCaps(String(args.cardId), typeof args.asOf === 'string' ? args.asOf : undefined, args.includeHistorical === true), (item) => String((item as { usageKey: string }).usageKey));
    case 'get_user_benefit_status': {
      const kind = args.kind;
      if (kind !== 'card_switch' && kind !== 'campaign_registration') throw new RewardServiceError('INVALID_INPUT', 'kind is invalid');
      return service.getUserBenefitStatus(kind, String(args.cardId), typeof args.asOfUtc === 'string' ? args.asOfUtc : undefined);
    }
    case 'upsert_user_benefit_status': return service.upsertUserBenefitStatus(validateUserBenefitInput(args.input));
    case 'resolve_merchant': {
      if (typeof args.rawQuery !== 'string') throw new RewardServiceError('INVALID_INPUT', 'rawQuery is required');
      return service.resolveMerchant(args.rawQuery, merchantResolutionFacts(args));
    }
    case 'search_active_offers': return service.searchActiveOffers(activeOfferSearch(args));
    case 'calculate_reward': return evaluateOffer(validateRule(args.rule), validateTransaction(args.transaction), validateContext(args.context));
    default: throw new RewardServiceError('TOOL_NOT_FOUND', `unknown tool: ${name}`);
  }
}
