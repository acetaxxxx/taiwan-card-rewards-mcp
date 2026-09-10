import type {
  Currency,
  FxRateType,
  FxSnapshot,
  AppliedFxRate,
  FxResolutionRequest,
  Money,
  TransactionMode,
  PaymentRouteContext,
  PaymentRoute,
  CardDescriptor,
  OfferRuleVersion,
} from './types.js';

export const FX_USER_QUESTION = '這筆交易是由商店做 DCC 換成台幣，還是由發卡行／卡組織換匯？若不確定，我可以先用中價匯率做 planned estimate，但不會直接當成實際入帳匯率。';

export type ConversionOwnerKind = 'card_scheme' | 'issuer' | 'wallet' | 'merchant_dcc' | 'unknown';

/**
 * Derive conversion owner from payment route, route context, and card facts.
 */
export function deriveConversionOwner(params: {
  routeContext?: PaymentRouteContext | undefined;
  route?: PaymentRoute | undefined;
  card?: CardDescriptor | undefined;
}): ConversionOwnerKind {
  const ctx = params.routeContext;
  if (ctx?.dcc === true || ctx?.conversionOwner === 'merchant') {
    return 'merchant_dcc';
  }
  if (ctx?.conversionOwner === 'card_network' || ctx?.conversionOwner === 'acquirer') {
    return 'card_scheme';
  }
  if (ctx?.conversionOwner === 'issuer' || ctx?.conversionOwner === 'bank') {
    return 'issuer';
  }
  if (ctx?.conversionOwner === 'wallet' || ctx?.conversionOwner === 'payment_provider') {
    return 'wallet';
  }
  if (params.route?.kind === 'wallet') {
    return 'wallet';
  }
  if (ctx?.conversionOwner === 'unknown') {
    return 'unknown';
  }
  // Standard direct card payment without wallet/DCC defaults to card scheme conversion
  if (params.card && (!params.route || params.route.kind === 'direct_card') && !ctx?.dcc) {
    return 'card_scheme';
  }
  return 'unknown';
}

/**
 * Derive suggested rate types according to Section 4.4 policy matrix.
 */
export function deriveSuggestedRateTypes(
  owner: ConversionOwnerKind,
  kind: 'planned' | 'actual',
): Array<FxRateType> {
  switch (owner) {
    case 'card_scheme':
      return ['card_scheme'];
    case 'issuer':
      return ['cash_selling'];
    case 'wallet':
      return ['spot_selling', 'mid_market'];
    case 'merchant_dcc':
      return ['spot_selling', 'cash_selling'];
    case 'unknown':
    default:
      if (kind === 'planned') {
        return ['mid_market', 'spot_selling'];
      }
      return ['card_scheme', 'cash_selling'];
  }
}

/**
 * Derive human-readable and auditable reason for source & rate type selection.
 */
export function deriveSourceSelectionReason(
  owner: ConversionOwnerKind,
  kind: 'planned' | 'actual',
): string {
  switch (owner) {
    case 'card_scheme':
      return 'Card scheme exchange rate for international network conversion';
    case 'issuer':
      return 'Card issuer cash selling settlement rate';
    case 'wallet':
      return 'Wallet provider conversion rate for pre-payment foreign exchange';
    case 'merchant_dcc':
      return 'Merchant dynamic currency conversion (DCC) rate at point of sale';
    case 'unknown':
    default:
      if (kind === 'planned') {
        return 'Planned estimate without known conversion owner; using mid-market or spot selling reference rate';
      }
      return 'Actual transaction requires confirmed conversion owner (card scheme or issuer); cannot guess DCC or mid-market';
  }
}

/**
 * Build typed machine-readable FxResolutionRequest projection for recommendation preflight and mutation errors.
 */
export function buildFxResolutionRequest(params: {
  transaction: {
    amount: Money;
    occurredAt: string;
    mode?: TransactionMode | undefined;
    routeContext?: PaymentRouteContext | undefined;
    route?: PaymentRoute | undefined;
    fx?: FxSnapshot | undefined;
  };
  rules?: OfferRuleVersion[] | undefined;
  card?: CardDescriptor | undefined;
  targetCurrency?: string | undefined;
  scope?: FxResolutionRequest['scope'];
  submission?: FxResolutionRequest['submission'];
}): FxResolutionRequest {
  const baseCurrency = params.transaction.amount.currency.toUpperCase();
  const quoteCurrency = (
    params.targetCurrency ??
    params.transaction.routeContext?.settlementCurrency ??
    params.rules?.find((r) => r.settlementCurrency !== baseCurrency)?.settlementCurrency ??
    params.rules?.[0]?.settlementCurrency ??
    (params.card?.country === 'TW' ? 'TWD' : 'TWD')
  ).toUpperCase();

  const transactionKind: 'planned' | 'actual' = params.transaction.mode === 'planned' ? 'planned' : 'actual';
  const conversionOwner = deriveConversionOwner({
    routeContext: params.transaction.routeContext,
    route: params.transaction.route,
    card: params.card,
  });
  const suggestedRateTypes = deriveSuggestedRateTypes(conversionOwner, transactionKind);
  const sourceSelectionReason = deriveSourceSelectionReason(conversionOwner, transactionKind);

  const needsUserQuestion = conversionOwner === 'unknown' && transactionKind === 'actual';
  const retryAction = needsUserQuestion ? 'ask_user' : 'query_approved_fx_source';
  const requiredFacts = needsUserQuestion
    ? ['transaction.routeContext.conversionOwner', 'transaction.fx']
    : ['transaction.fx'];
  const usesPublicReference = transactionKind === 'planned' && conversionOwner === 'unknown';

  return {
    baseCurrency,
    quoteCurrency,
    asOf: params.transaction.occurredAt,
    transactionKind,
    conversionOwner,
    suggestedRateTypes,
    requiredFacts,
    sourceSelectionReason,
    retryAction,
    ...(usesPublicReference ? { sourceUrls: ['https://rate.bot.com.tw/xrt?Lang=zh-TW'] } : {}),
    ...(transactionKind === 'planned' && !usesPublicReference ? { referenceSourceUrls: ['https://rate.bot.com.tw/xrt?Lang=zh-TW'] } : {}),
    sourceStatus: usesPublicReference ? 'known' : 'discovery_required',
    purpose: usesPublicReference ? 'reference_estimate' : transactionKind === 'planned' ? 'path_quote' : 'policy_research',
    rateDirection: 'base_to_quote',
    ...(params.scope ? { scope: params.scope } : {}),
    freshness: { maxAgeSeconds: params.transaction.fx?.maxAgeSeconds ?? 7 * 24 * 3600, targetTime: params.transaction.occurredAt },
    requiredFields: ['baseCurrency', 'quoteCurrency', 'ratePpm', 'capturedAt', 'provider', 'rateType', 'sourceUrl', 'contentHash'],
    submission: params.submission ?? { tool: transactionKind === 'planned' ? 'recommend' : 'record_transaction', field: transactionKind === 'planned' ? 'fx' : 'transaction.fx' },
    ...(needsUserQuestion ? { userQuestion: FX_USER_QUESTION } : {}),
  };
}

/**
 * Freeze an applied FX rate snapshot into an immutable historical settlement record.
 */
export function freezeAppliedFxRate(
  fx: FxSnapshot,
  appliedAtUtc: string,
  conversionOwner?: string | undefined,
): AppliedFxRate {
  return {
    snapshotId: fx.id,
    baseCurrency: fx.baseCurrency,
    quoteCurrency: fx.quoteCurrency,
    ratePpm: fx.ratePpm,
    capturedAt: fx.capturedAt,
    provider: fx.provider,
    rateType: fx.rateType,
    ...(fx.sourceUrl !== undefined ? { sourceUrl: fx.sourceUrl } : {}),
    ...(fx.contentHash !== undefined ? { contentHash: fx.contentHash } : {}),
    ...(conversionOwner !== undefined ? { conversionOwner } : {}),
    appliedAtUtc,
  };
}
