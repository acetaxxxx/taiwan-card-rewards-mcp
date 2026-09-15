import type {
  Currency,
  FxRateType,
  FxSnapshot,
  AppliedFxRate,
  FxResolutionRequest,
  FxEvaluationContext,
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
  route?: PaymentRoute | any | undefined;
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

  const routeObj = params.route;
  const isWalletRoute =
    routeObj?.kind === 'wallet' ||
    routeObj?.funding?.subtype === 'wallet_balance' ||
    (Array.isArray(routeObj?.layers) && routeObj.layers.some((l: any) => l.kind === 'wallet'));
  if (isWalletRoute) {
    return 'wallet';
  }

  if (ctx?.conversionOwner === 'unknown') {
    return 'unknown';
  }

  const isCardPayment =
    Boolean(params.card) ||
    routeObj?.funding?.kind === 'credit_card' ||
    routeObj?.kind === 'direct_card';

  // Standard direct card payment without wallet/DCC defaults to card scheme conversion
  if (isCardPayment && !ctx?.dcc) {
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
 * Check whether an FX snapshot is fresh relative to asOf (default: now).
 */
export function isFxFresh(snapshot: FxSnapshot, asOf?: string): boolean {
  const target = asOf ? Date.parse(asOf) : Date.now();
  const captured = Date.parse(snapshot.capturedAt);
  if (!Number.isFinite(target) || !Number.isFinite(captured)) return false;
  const maxAgeMs = (snapshot.maxAgeSeconds ?? 7 * 24 * 3600) * 1000;
  return Math.abs(target - captured) <= maxAgeMs;
}

/**
 * Check whether an FX snapshot is compatible with an evaluation context.
 * Compares:
 * 1. Currencies & rate direction
 * 2. Conversion owner (card_scheme, issuer, wallet, merchant_dcc)
 * 3. Conversion timing (transaction, clearing, settlement, posting)
 * 4. Rate type (card_scheme, cash_selling, spot_selling, mid_market)
 * 5. Card scheme / provider network (JCB vs Visa vs Mastercard)
 * 6. Scope restrictions (cardId, issuer, routeId, edgeId)
 * 7. Freshness window (if requireFresh is true)
 */
export function isFxCompatible(params: {
  snapshot: FxSnapshot;
  context: FxEvaluationContext;
}): boolean {
  const { snapshot, context } = params;

  // 1. Currency compatibility
  if (snapshot.baseCurrency.toUpperCase() !== context.baseCurrency.toUpperCase()) {
    return false;
  }
  if (snapshot.quoteCurrency.toUpperCase() !== context.quoteCurrency.toUpperCase()) {
    return false;
  }

  // 2. Rate direction
  if (snapshot.rateDirection && context.rateDirection && snapshot.rateDirection !== context.rateDirection) {
    return false;
  }

  // 3. Conversion timing
  if (snapshot.conversionTiming && context.conversionTiming && snapshot.conversionTiming !== context.conversionTiming) {
    return false;
  }

  // 4. Conversion owner & Rate type isolation
  const ctxOwner: ConversionOwnerKind =
    context.conversionOwner === 'card_network' || context.conversionOwner === 'acquirer' ? 'card_scheme'
    : context.conversionOwner === 'issuer' || context.conversionOwner === 'bank' ? 'issuer'
    : context.conversionOwner === 'wallet' || context.conversionOwner === 'payment_provider' ? 'wallet'
    : context.conversionOwner === 'merchant' || context.conversionOwner === 'merchant_dcc' ? 'merchant_dcc'
    : (context.conversionOwner as ConversionOwnerKind) ?? 'unknown';

  const snapOwner: ConversionOwnerKind | undefined =
    snapshot.conversionOwner === 'card_network' || snapshot.conversionOwner === 'acquirer' ? 'card_scheme'
    : snapshot.conversionOwner === 'issuer' || snapshot.conversionOwner === 'bank' ? 'issuer'
    : snapshot.conversionOwner === 'wallet' || snapshot.conversionOwner === 'payment_provider' ? 'wallet'
    : snapshot.conversionOwner === 'merchant' || snapshot.conversionOwner === 'merchant_dcc' ? 'merchant_dcc'
    : (snapshot.conversionOwner as ConversionOwnerKind | undefined);

  if (snapOwner && ctxOwner !== 'unknown' && snapOwner !== ctxOwner) {
    return false;
  }

  // Rate type compatibility with conversion owner
  if (ctxOwner === 'card_scheme') {
    if (snapshot.rateType === 'cash_selling') return false;
  } else if (ctxOwner === 'issuer') {
    if (snapshot.rateType === 'card_scheme') return false;
  } else if (ctxOwner === 'wallet') {
    if (snapshot.rateType === 'card_scheme') return false;
  } else if (ctxOwner === 'merchant_dcc') {
    if (snapshot.rateType === 'card_scheme') return false;
  }

  // 5. Card scheme isolation (e.g. JCB vs Visa vs Mastercard)
  if (snapshot.cardScheme && context.cardScheme) {
    if (snapshot.cardScheme.toUpperCase() !== context.cardScheme.toUpperCase()) {
      return false;
    }
  }

  // A provider-qualified clearing context is equally restrictive.  Leave an
  // unknown provider reusable so a generic reference quote can still support
  // planned recommendations, but never cross a known provider boundary.
  if (context.provider && snapshot.provider.toUpperCase() !== context.provider.toUpperCase()) {
    return false;
  }

  // Non-card conversions (issuer, wallet, merchant_dcc) must never use card scheme quotes or rates
  if (ctxOwner !== 'card_scheme' && ctxOwner !== 'unknown') {
    if (snapshot.cardScheme || snapshot.rateType === 'card_scheme') {
      return false;
    }
  }

  // 6. Scope restrictions
  if (snapshot.cardIdScope && context.cardId && snapshot.cardIdScope !== context.cardId) {
    return false;
  }
  if (snapshot.issuerScope && context.issuer && snapshot.issuerScope !== context.issuer) {
    return false;
  }
  if (snapshot.routeIdScope && context.routeId && snapshot.routeIdScope !== context.routeId) {
    return false;
  }
  if (snapshot.edgeIdScope && context.edgeId && snapshot.edgeIdScope !== context.edgeId) {
    return false;
  }

  // 7. Freshness requirement
  if (context.requireFresh && !isFxFresh(snapshot, context.asOf)) {
    return false;
  }

  return true;
}

/**
 * Determine specificity score of an FX snapshot relative to context:
 * Level 5: route_edge (matches both routeId and edgeId)
 * Level 4: route (matches routeId)
 * Level 3: card (matches cardId via cardIdScope)
 * Level 2: issuer (matches issuer via issuerScope)
 * Level 1: general compatible quote (e.g. card scheme or general reference)
 */
export function getFxScopeSpecificity(snapshot: FxSnapshot, context: FxEvaluationContext): number {
  if (snapshot.edgeIdScope && snapshot.edgeIdScope === context.edgeId) return 5;
  if (snapshot.routeIdScope && snapshot.routeIdScope === context.routeId) return 4;
  if (snapshot.cardIdScope && snapshot.cardIdScope === context.cardId) return 3;
  if (snapshot.issuerScope && snapshot.issuerScope === context.issuer) return 2;
  return 1;
}

/**
 * Find best matching FX snapshot among candidates:
 * 1. Must be compatible
 * 2. Highest scope specificity (route_edge > route > card > issuer > general)
 * 3. Freshness (fresh before stale)
 * 4. Recency (capturedAt closest to asOf)
 */
export function findBestMatchingFx(
  snapshots: readonly FxSnapshot[],
  context: FxEvaluationContext,
): FxSnapshot | undefined {
  const compatible = snapshots.filter((s) => isFxCompatible({ snapshot: s, context }));
  if (compatible.length === 0) return undefined;

  const asOfTime = context.asOf ? Date.parse(context.asOf) : Date.now();

  const sorted = [...compatible].sort((a, b) => {
    // 1. Scope specificity
    const specDiff = getFxScopeSpecificity(b, context) - getFxScopeSpecificity(a, context);
    if (specDiff !== 0) return specDiff;

    // 2. Freshness
    const aFresh = isFxFresh(a, context.asOf);
    const bFresh = isFxFresh(b, context.asOf);
    if (aFresh !== bFresh) return Number(bFresh) - Number(aFresh);

    // 3. Recency (closest to asOf)
    const aDist = Math.abs(asOfTime - Date.parse(a.capturedAt));
    const bDist = Math.abs(asOfTime - Date.parse(b.capturedAt));
    return aDist - bDist;
  });

  return sorted[0];
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
  cardScheme?: string | undefined;
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
  const cardScheme = params.cardScheme ?? params.card?.network;

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
    ...(cardScheme ? { cardScheme } : {}),
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
