# Payment routes support opportunity stacking

Status: accepted

Payment wallets and merchant applications are first-class Payment Routes, and a
transaction may produce independent merchant, payment-provider, and card-issuer
Reward Components. The calculator may merge compatible components when stacking
is `confirmed` or `possible`; `possible` may come from an ambiguous official
rule or a dated Community Observation and is eligible for formal recording under
this product decision, including each component's cap consumption. This trades
some false-positive risk for the ability to surface real-world stacking gaps;
expired, contradictory, or otherwise untrustworthy observations remain
`unknown` and cannot be recorded. Components retain their own rule, source,
rounding, native unit, and cap context, and no payment credential or raw source
document is stored.
