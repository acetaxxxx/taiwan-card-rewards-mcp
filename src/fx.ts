import type {
  Currency,
  FxRateType,
  FxSnapshot,
  FxRateObservation,
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
    ...(needsUserQuestion ? { userQuestion: FX_USER_QUESTION } : {}),
  };
}

/**
 * Freeze an applied FX rate snapshot into an immutable historical settlement record.
 */
export function freezeAppliedFxRate(
  fx: FxSnapshot | FxRateObservation,
  appliedAtUtc: string,
  conversionOwner?: string | undefined,
): AppliedFxRate {
  const owner = conversionOwner ?? (typeof (fx as FxRateObservation).conversionOwner === 'string' ? (fx as FxRateObservation).conversionOwner : undefined);
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
    ...(owner !== undefined ? { conversionOwner: owner } : {}),
    appliedAtUtc,
  };
}

export interface FxCandidateObservation extends FxRateObservation {
  authority?: 'central_bank' | 'card_scheme' | 'issuer' | 'wallet' | 'merchant' | 'secondary' | undefined;
  freshnessWindowSeconds?: number | undefined;
  reason?: string | undefined;
}

export interface FxSelectionResult {
  selected?: FxRateObservation | undefined;
  conflict?: boolean | undefined;
  reason?: string | undefined;
}

/**
 * Select the highest authority and most specific FX rate candidate according to Section 4.5.
 * Order: applicable owner > pair match > date applicability > source authority > freshness > rate type policy.
 * Fail closed with conflict if two authoritative sources conflict significantly.
 */
export function selectFxCandidate(
  candidates: readonly FxRateObservation[],
  request: FxResolutionRequest,
  nowIso: string = new Date().toISOString(),
): FxSelectionResult {
  // 1. Pair match
  const pairMatches = candidates.filter(
    (c) => c.baseCurrency.toUpperCase() === request.baseCurrency.toUpperCase() &&
           c.quoteCurrency.toUpperCase() === request.quoteCurrency.toUpperCase(),
  );

  if (pairMatches.length === 0) {
    return { reason: `No FX observation candidates match pair ${request.baseCurrency}/${request.quoteCurrency}` };
  }

  // 2. Filter out stale candidates if maxAgeSeconds or freshnessWindow is provided
  const targetTime = request.asOf ? Date.parse(request.asOf) : Date.parse(nowIso);
  const nonStale = pairMatches.filter((c) => {
    const capturedTime = Date.parse(c.capturedAt);
    if (!Number.isFinite(capturedTime)) return false;
    const maxAgeMs = (c.maxAgeSeconds ?? 7 * 24 * 3600) * 1000;
    return (targetTime - capturedTime) <= maxAgeMs && (capturedTime <= targetTime + 86400000);
  });

  if (nonStale.length === 0) {
    return { reason: 'All matching FX observation candidates are stale for the requested asOf timestamp' };
  }

  // 3. For actual transactions, strictly reject mid_market rates
  const eligible = request.transactionKind === 'actual'
    ? nonStale.filter((c) => c.rateType !== 'mid_market')
    : nonStale;

  if (eligible.length === 0) {
    return { reason: 'Actual transactions require non-mid-market FX observation (card_scheme, cash_selling, spot_selling)' };
  }

  // 4. Score candidates based on:
  // - Conversion owner match
  // - Suggested rate types preference
  // - Scope specificity (cardIdScope / issuerScope)
  // - Freshness (closer capturedAt to targetTime)
  const scored = eligible.map((candidate) => {
    let score = 0;
    if (request.conversionOwner && candidate.conversionOwner === request.conversionOwner) {
      score += 100;
    }
    const rateTypeIndex = request.suggestedRateTypes.indexOf(candidate.rateType);
    if (rateTypeIndex !== -1) {
      score += 50 - (rateTypeIndex * 10);
    }
    if (candidate.cardIdScope) score += 20;
    if (candidate.issuerScope) score += 10;
    if (candidate.confidence === 'high') score += 15;
    else if (candidate.confidence === 'medium') score += 5;

    const capturedTime = Date.parse(candidate.capturedAt);
    const ageDiffHours = Math.abs(targetTime - capturedTime) / 3600000;
    score -= Math.min(10, ageDiffHours);

    return { candidate, score };
  });

  scored.sort((a, b) => b.score - a.score);

  // 5. Conflict check among top contenders:
  // If the top 2 candidates have virtually identical high scores but divergence in ratePpm > 1% (10,000 ppm = 1%)
  if (scored.length > 1 && scored[0] && scored[1]) {
    const top = scored[0];
    const second = scored[1];
    if (Math.abs(top.score - second.score) < 15 && top.candidate.provider !== second.candidate.provider) {
      const rateDiff = Math.abs(top.candidate.ratePpm - second.candidate.ratePpm);
      const avgRate = (top.candidate.ratePpm + second.candidate.ratePpm) / 2;
      if (avgRate > 0 && (rateDiff / avgRate) > 0.01) {
        return {
          conflict: true,
          reason: `Conflicting FX observations detected between ${top.candidate.provider} (${top.candidate.ratePpm} ppm) and ${second.candidate.provider} (${second.candidate.ratePpm} ppm) for ${request.baseCurrency}/${request.quoteCurrency}`,
        };
      }
    }
  }

  const best = scored[0];
  if (!best) {
    return { reason: 'No eligible FX observation candidates available' };
  }
  return { selected: best.candidate };
}
