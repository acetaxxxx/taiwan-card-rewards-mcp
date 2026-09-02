import type { CardDescriptor, CardSwitchCampaign, CardSwitchInput, CardSwitchProjection, CardSwitchStatus } from './types.js';

export function localParts(utc: string, timezone: string): { date: string; timestamp: string } {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(utc));
  const values = Object.fromEntries(parts.filter((part) => part.type !== 'literal').map((part) => [part.type, part.value]));
  const date = `${values.year}-${values.month}-${values.day}`;
  return { date, timestamp: `${date}T${values.hour}:${values.minute}:${values.second}` };
}

export function projectionFromInput(input: CardSwitchInput & { effectiveFrom?: string | undefined; effectiveTo?: string | undefined; campaignId?: string | undefined }): CardSwitchProjection {
  const local = localParts(input.switchedAtUtc, input.timezone);
  return { cardId: input.cardId, timezone: input.timezone, switchedAtUtc: input.switchedAtUtc, switchedAtLocal: local.timestamp, switchedLocalDate: local.date, benefit: input.benefit, sourceUrl: input.sourceUrl, sourceSnapshotAt: input.sourceSnapshotAt, ruleVersion: input.ruleVersion, confirmation: input.confirmation, action: input.action, idempotencyKey: input.idempotencyKey, ...(input.adjustmentReason === undefined ? {} : { adjustmentReason: input.adjustmentReason }), ...(input.effectiveFrom === undefined ? {} : { effectiveFrom: input.effectiveFrom }), ...(input.effectiveTo === undefined ? {} : { effectiveTo: input.effectiveTo }), ...(input.campaignId === undefined ? {} : { campaignId: input.campaignId }) };
}

function campaignMatchesCard(campaign: CardSwitchCampaign, card: CardDescriptor): string | undefined {
  if (campaign.issuer !== card.issuer) return 'issuer does not match this card';
  if (campaign.network !== undefined && campaign.network !== card.network) return 'network does not match this card';
  if (campaign.cardId !== undefined && campaign.cardId !== card.id) return 'campaign is scoped to another card';
  return undefined;
}

export function cardSwitchStatus(card: CardDescriptor, current: CardSwitchProjection | undefined, campaigns: readonly CardSwitchCampaign[], asOfUtc: string): CardSwitchStatus {
  const local = localParts(asOfUtc, card.timezone ?? 'Asia/Taipei');
  const availableCandidates: CardSwitchCampaign[] = [];
  const currentlyUnavailable: Array<{ campaign: CardSwitchCampaign; reason: string }> = [];
  for (const campaign of campaigns) {
    const mismatch = campaignMatchesCard(campaign, card);
    const at = Date.parse(asOfUtc);
    const from = Date.parse(campaign.effectiveFrom);
    const to = campaign.effectiveTo === undefined ? Number.POSITIVE_INFINITY : Date.parse(campaign.effectiveTo);
    const reason = mismatch ?? (!Number.isFinite(at) || Number.isNaN(from) || Number.isNaN(to) ? 'campaign effective dates are invalid' : at < from ? 'campaign is not yet effective' : at > to ? 'campaign has expired' : undefined);
    if (reason) currentlyUnavailable.push({ campaign, reason });
    else availableCandidates.push(campaign);
  }
  const warnings = availableCandidates.some((candidate) => candidate.eligibility?.length) ? ['some candidates have eligibility conditions requiring user confirmation'] : [];
  const alreadySwitchedToday = current?.switchedLocalDate === local.date;
  if (alreadySwitchedToday) warnings.push('a switch was already recorded today; another confirmed write is still allowed');
  return { cardId: card.id, ...(current ? { current } : {}), alreadySwitchedToday, availableCandidates, currentlyUnavailable, warnings };
}
