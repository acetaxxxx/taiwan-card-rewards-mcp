# Recommendation Pre-flight、外部資料新鮮度與 Agent Research Workflow 規格

Status: ready-for-agent

Version: 0.1.0

Date: 2026-09-06

## Problem Statement

目前 MCP 已能驗證結構化交易資料、保存部分 provenance、執行確定性的回饋計算與推薦，但 Agent 在呼叫推薦以前，無法透過一個穩定的 runtime 契約知道「這一次還缺哪些資料、哪些資料已過期、哪些資料互相衝突，以及下一步應採取什麼動作」。

這會造成幾個實際問題：

- Agent 必須自行記住不同卡片、商家、支付路徑與匯率情境的查詢清單。
- 缺少 merchant market、payment route、FX mechanism 或 eligibility facts 時，容易把不完整輸入直接送進推薦。
- 過期的優惠、匯率或支付服務資料沒有統一的 freshness 契約與 refresh action。
- 外部來源的 authority、confidence、適用範圍與衝突狀態沒有泛化的 evidence model。
- 商家解析結果、推薦分頁與診斷資訊尚未在所有 recommendation 路徑上形成一致的單一契約。
- MCP 若為補足資料而自行呼叫網路，會破壞零隱藏網路、可重現與 fail-closed 的架構邊界。

需要一個可由 Agent 重複執行的流程：先 pre-flight，再依 required actions 補齊 typed facts 或 evidence，最後重新 pre-flight 並呼叫 recommendation。MCP 應告訴 Agent 計算需要什麼；Research Skill 應告訴 Agent 如何研究與取得它；Agent 不應自行成為最終規則或回饋計算引擎。

## Solution

新增一個唯讀的 Recommendation Pre-flight domain capability，並以薄 MCP adapter 暴露為 `recommendation_preflight` 工具。它接收目前已知的 transaction、merchant、card、payment route、FX、eligibility 與時間情境，回傳有界、可追蹤且可重複判定的結果：

- 已知且可用的 facts；
- 缺少、過期、衝突或無效的 requirements；
- Agent 應執行的 required actions；
- 結構化 diagnostics；
- 是否已具備 recommendation 所需條件；
- recommendation 計算所依據的 data version 與評估時間。

Recommendation Pre-flight 不寫入 ledger、不扣 cap、不啟用 card 或 offer、不建立 merchant、不呼叫外部網路。它只檢查目前 MCP durable state 與本次輸入，並產生下一步 action。

外部資料以泛化的 External Data Requirement、Evidence Record 與 Fact Candidate 概念表示。原始 PDF、HTML、截圖、OCR、未驗證匯率與 Agent 的研究筆記仍留在 Agent Workspace；MCP 只接收通過 typed contract 的 evidence metadata、claims、facts 與 provenance。

推薦流程在 canonical merchant、payment route、FX mechanism、freshness、source trust 與 rule confirmation 都通過後，才可產生可計算的結果。任何未知、過期、衝突或未確認狀態都必須保留 machine-actionable diagnostics，不能猜測、平均、靜默歸零或使用 1:1 匯率回退。

新增公開工具後，MCP public contract 從目前的 12 項擴充為 13 項；完成相容性實作後，建議以 minor release 發布，例如 `0.9.0`，並同步更新 schema、文件、usage guide、CHANGELOG 與 contract tests。

## User Stories

1. As a cardholder, I want the Agent to run a pre-flight before recommending a card, so that I know whether the current facts are sufficient.
2. As a cardholder, I want pre-flight to return the facts already known, so that I do not repeat information I have already provided.
3. As a cardholder, I want pre-flight to identify each missing fact precisely, so that I can answer targeted questions instead of guessing.
4. As a cardholder, I want every missing fact to include a machine-actionable retry action, so that the Agent can continue the workflow deterministically.
5. As a cardholder, I want the Agent to distinguish missing, stale, conflicting, and invalid data, so that different recovery actions are not conflated.
6. As a cardholder, I want merchant resolution to preserve country and market context, so that a name shared by multiple markets cannot select the wrong offer.
7. As a cardholder, I want an ambiguous merchant to return bounded candidates and required facts, so that I can confirm the intended merchant without the Agent silently choosing one.
8. As a cardholder, I want an unresolved merchant to block only the affected merchant-specific calculation while preserving an explainable base-rule result when possible.
9. As a cardholder, I want canonical merchant identity to be used by recommendation after resolution, so that a raw merchant label cannot bypass the catalog boundary.
10. As a cardholder, I want the system to report when a merchant has no active verified offer, so that I understand why no special promotion was applied.
11. As a cardholder, I want card product, held-card identity, eligibility, billing cycle, and enrollment facts checked separately, so that product terms are not confused with my personal state.
12. As a cardholder, I want pre-flight to tell me when a new or unresolved card needs onboarding, so that a card name alone cannot create a false reward rule.
13. As a cardholder, I want payment route details checked before FX evaluation, so that the system does not assume every foreign transaction uses the same conversion mechanism.
14. As a cardholder, I want the payment route to preserve merchant, wallet, intermediate provider, card network, issuer, and funding source when known, so that the actual conversion path is auditable.
15. As a cardholder, I want the system to identify who controls currency conversion, so that card-network, issuer, wallet, merchant DCC, and other rates are not mixed.
16. As a cardholder, I want the FX rate type and conversion timing recorded, so that transaction-time, clearing-time, settlement-time, and posting-time rates remain distinguishable.
17. As a cardholder, I want foreign transaction fees, markups, service fees, and DCC costs represented explicitly, so that reward comparisons do not hide payment-route costs.
18. As a cardholder, I want pre-flight to mark an FX rate or mechanism stale, so that an old value cannot silently produce a current recommendation.
19. As a cardholder, I want a stale external-data result to include the known source and refresh instructions, so that the Agent can research a replacement efficiently.
20. As a cardholder, I want freshness policies to vary by data type, so that daily FX data, quarterly campaigns, and slower-changing payment mechanisms are not judged by one global TTL.
21. As a cardholder, I want source authority recorded, so that issuer, network, wallet, merchant, trusted secondary, community, and user-provided observations have different trust meaning.
22. As a cardholder, I want confidence and applicability context preserved with evidence, so that a claim found in a community discussion cannot silently become an authoritative rule.
23. As a cardholder, I want evidence to preserve source identity, observation time, validity period, content fingerprint, and claim context, so that later calculations can be traced.
24. As a cardholder, I want raw research artifacts to stay outside MCP durable state by default, so that PDF, HTML, OCR, and screenshots do not become an uncontrolled durable data store.
25. As a cardholder, I want conflicting evidence to produce a conflict diagnostic, so that the system asks for review instead of averaging incompatible offers or rates.
26. As a cardholder, I want the Agent to use official sources first, so that authoritative bank and payment terms receive priority.
27. As a cardholder, I want secondary and community sources to help discover edge cases without automatically authorizing a rule, so that practical findings remain visible but properly qualified.
28. As a cardholder, I want the Agent to expand research queries by card, market, payment path, network, FX, merchant, and exclusions, so that hidden conditions are less likely to be missed.
29. As a cardholder, I want the Agent to submit typed evidence rather than a bare statement such as “this card gives five percent,” so that MCP can validate and audit the claim.
30. As a cardholder, I want the Agent to rerun pre-flight after evidence submission, so that readiness is based on the updated durable facts rather than conversation memory.
31. As a cardholder, I want a ready result to state which requirements were satisfied, so that I can understand why recommendation is allowed.
32. As a cardholder, I want a non-ready result to remain safe to repeat, so that pre-flight never changes ledger balances, cap usage, merchant lifecycle, or offer activation.
33. As a cardholder, I want planned recommendation to remain read-only, so that exploring several payment scenarios has no financial side effects.
34. As a cardholder, I want recommendation results to preserve diagnostics for special-offer uncertainty while still calculating the applicable base rule, so that partial certainty is not confused with total failure.
35. As a cardholder, I want recommendations to paginate before truncation, so that requesting a later page returns the correct stable slice rather than an empty or repeated result.
36. As a cardholder, I want bounded recommendation responses with a stable data version, so that a result can be reproduced and safely compared across retries.
37. As a cardholder, I want active rules with missing verification or confirmation to fail closed, so that a candidate offer cannot produce a confident reward merely because it is present in storage.
38. As a cardholder, I want diagnostics to identify the field path and required facts, so that I can tell whether to answer a question, refresh data, resolve a merchant, or request review.
39. As an Agent, I want one stable pre-flight contract, so that I do not need to hardcode every future card, promotion, payment provider, or market-specific prerequisite.
40. As an Agent, I want a formal Research Skill SOP, so that official-first research, source expansion, evidence submission, conflict handling, and retry behavior are consistent across conversations.
41. As an Agent, I want source recovery instructions when a saved official URL is unavailable, so that I can rediscover an authoritative replacement and submit it without MCP fetching the Internet.
42. As an Agent, I want no-network behavior to be explicit, so that I know all browsing and external retrieval remains my responsibility.
43. As an operator, I want the pre-flight result and diagnostics to be deterministic, so that logs and support investigations can reproduce the same decision from the same state and input.
44. As an operator, I want external-data requirements to be versioned and scoped, so that a refresh for one payment route, market, or card does not accidentally satisfy another.
45. As an operator, I want the MCP to own authoritative IDs for durable FX snapshots and canonical merchants, so that an Agent cannot invent identity or overwrite another scope.
46. As an operator, I want the contract to reject unknown and sensitive fields, so that user IDs, data paths, credentials, PAN, CVV, cookies, tokens, and provider secrets cannot be smuggled through research payloads.
47. As an operator, I want historical transaction calculations to retain the exact rule, source, FX, and payment context used at posting time, so that later refreshes cannot rewrite the audit trail.
48. As an operator, I want a schema and documentation version bump to accompany the new public tool, so that clients can detect the contract change rather than silently misinterpreting it.

## Implementation Decisions

- The highest test seam is the stateful recommendation domain service. It should expose a `preflightRecommendation` capability alongside recommendation, while the MCP adapter remains a thin validator and dispatcher. The evaluator remains a pure calculation seam; persistence remains behind the existing store boundary.
- The public MCP adapter adds exactly one `recommendation_preflight` tool. Its schema accepts only the allowed transaction and context fields, rejects identity, path, secret, and unknown-field overrides, and does not accept an Agent-selected rule ID as an authority override.
- Pre-flight is strictly read-only. It must not append transactions, alter idempotency records, consume or restore caps, activate or deprecate merchants, confirm offers, mutate card enrollment, or persist a refresh merely because it inspected state.
- The pre-flight result uses a bounded envelope with `ready`, `knownFacts`, `requirements`, `requiredActions`, `diagnostics`, `evaluatedAt`, and `dataVersion`. Collections have explicit limits and stable ordering. Diagnostics use the existing actionable shape of code, path, required facts, and retry action.
- Each requirement has an MCP-owned stable identifier, a typed data category, its applicability scope, current status, freshness metadata where relevant, available evidence references, and a next action. Statuses include available, missing, stale, conflict, invalid, and needs review.
- Required actions are a closed set covering user clarification, merchant resolution, external-data refresh, evidence submission, card onboarding, and offer or source review. Actions must contain enough typed context for the Agent to continue without guessing, but must never contain credentials or arbitrary fetch instructions that bypass policy.
- Merchant input is separated into raw user wording and canonical identity. Raw wording may help produce a resolution request but cannot activate an offer. Recommendation must consume the confirmed canonical identity, market, country, channel, and other applicable context. Exact and normalized matching remain deterministic; fuzzy or embedding matches remain Agent-side proposals only.
- `no_active_offer`, `merchant_ambiguous`, `merchant_not_found`, and `missing_required_fact` are explicit diagnostics. Lack of a special offer must not suppress a valid base-rule calculation when the base rule is independently trusted and applicable.
- External data is modeled generically rather than as an FX-only special case. Categories may include FX rates, FX mechanisms, card-network pricing, payment-provider terms, seasonal card campaigns, enrollment limits, merchant promotions, and other time-sensitive facts.
- An External Data Requirement records the requirement identity, data category, payment/card/merchant scope, source hints, current evidence references, observed time, validity interval, refresh-after policy, and status. Freshness is evaluated according to the data category and scope; a single global TTL is not used.
- Evidence records contain a typed claim or fact candidate, source identity, source type, source authority, observation time, validity period, applicability context, confidence, content hash, and review state. Official issuer, card network, wallet, merchant, trusted secondary, community, and user-provided evidence remain distinguishable.
- Raw evidence artifacts remain in Agent Workspace or another explicitly authorized external adapter. MCP receives normalized metadata and claims only; MCP does not perform OCR, scrape arbitrary pages, or persist raw PDFs, HTML, screenshots, or research notes as hidden state.
- Evidence conflicts are first-class. Conflicting claims for the same scoped requirement produce a fail-closed conflict diagnostic until an authorized resolution creates a new reviewed fact or rule version. The evaluator must not average rates, choose the newest claim without policy, or silently drop the conflict.
- Payment route context preserves the known chain from merchant through wallet or intermediate provider to card network, issuer, and funding source. It also preserves transaction and settlement currencies, conversion owner, rate type, conversion timing, foreign transaction fees, markups, service fees, and DCC information when applicable.
- FX snapshots and FX mechanisms receive MCP-owned durable identities. Inline Agent-supplied identifiers cannot create an authoritative snapshot or replace an existing one. A snapshot records provider, currency pair, rate representation, captured time, validity policy, route scope, and provenance.
- Trust gates are enforced at calculation time as well as pre-flight time. A rule with missing source verification, invalid source scope, stale evidence, unresolved conflict, or missing confirmation cannot become a confident `ok` result merely because it has an active-looking status.
- Recommendation canonicalization and pagination are part of the same external contract. Merchant resolution occurs before offer matching, and page selection occurs before response bounding. A later page must not be calculated from an already truncated first page.
- Recommendation, pre-flight, merchant resolution, and active-offer search use stable data-version and ordering semantics. A changed catalog, requirement, or rule state must be observable through the returned data version or an explicit retry result.
- The Agent Research Skill is a separate operational document. It defines official-first source priority, search expansion, payment-route and FX SOP, source recovery, evidence-first submission, conflict handling, and the rule to rerun pre-flight after every material update. It does not embed current bank offers or call MCP internals.
- The contract remains zero-network inside MCP. Network retrieval, browsing, source recovery, and external adapter credentials stay outside the MCP process. MCP fails closed when supplied evidence is incomplete, untrusted, stale, out of scope, or contradictory.
- The new public tool and schema require a synchronized contract/documentation version bump. The intended release increment is a minor release after implementation and tests pass; the exact release number is selected from the repository's current release state at implementation time.

## Testing Decisions

- Tests assert externally observable behavior at the highest seam: stateful pre-flight and recommendation service behavior through the domain service, and request validation and dispatch through the MCP contract. Private helpers, JSON layout, and storage internals are not direct test seams.
- The first red tests cover a ready pre-flight, missing merchant context, ambiguous merchant candidates, stale FX data, missing payment-route mechanism, conflicting evidence, and a valid refresh action. Each test verifies the complete actionable diagnostic rather than only a boolean readiness flag.
- Merchant tests verify that a confirmed canonical identity affects recommendation matching, an ambiguous or unknown identity cannot silently select an offer, `no_active_offer` is explicit, and a trusted base rule can remain calculable when the special offer is unresolved.
- Pagination tests verify that page two returns the correct stable slice, that bounding happens after page selection, that limits are validated, and that data version and ordering remain stable across identical calls.
- Evidence tests verify source authority, confidence, applicability scope, validity periods, content fingerprints, unknown-field rejection, and conflict behavior. Community or user evidence must not pass an official trust gate without an explicit authorized review transition.
- Freshness tests verify category-specific stale behavior, refresh-after handling, valid-until boundaries, missing primary sources, source recovery actions, and the absence of hidden network calls.
- Payment-route and FX tests verify conversion owner, rate type, timing, fees, DCC context, route scope, currency-pair mismatch, stale snapshots, and MCP-owned snapshot identity. A raw foreign currency alone must not make a recommendation ready.
- Trust-gate tests verify that unconfirmed, unverified, stale, conflicted, and out-of-scope rules fail closed, while a fully verified and confirmed rule can produce the expected calculation.
- Side-effect tests snapshot store state before and after pre-flight and planned recommendation. Ledger entries, caps, merchant lifecycle, rule activation, idempotency records, and card state must be unchanged.
- Security tests verify rejection of user ID, data directory, path, token, cookie, PAN, CVV, credential, and provider-secret fields at every new boundary, including nested evidence and action payloads.
- Compatibility tests verify that the existing 12 tools retain their current behavior, that the new tool is included exactly once in the public contract, and that all schemas, dispatch, instructions, and documentation agree on the new count.
- Documentation contract tests or lint checks should verify that the Research Skill names the same action types, evidence categories, and pre-flight retry flow as the MCP schema.
- The existing evaluator, service, persistence, ownership, merchant-runtime, billing-cycle/FX, bounded-response, source-candidate, and contract-test patterns are the prior art for this work. Full unit tests, typecheck, build, formatting, and diff checks remain release gates.

## Out of Scope

- MCP-side HTTP fetching, browser automation, OCR, PDF parsing, screenshot parsing, web search, or arbitrary source discovery.
- Hardcoding future bank promotions, payment-provider policies, merchant campaigns, or a universal list of all possible external data requirements.
- Fuzzy matching, embeddings, autonomous translation, or Agent guesses being promoted directly into canonical merchant identity, active rules, or reward calculations.
- Automatic activation, confirmation, or deprecation of merchants and offers as a side effect of pre-flight or recommendation.
- Using community evidence as authoritative evidence without an explicit provenance and review transition.
- A universal real-time FX feed or a promise that every issuer, network, wallet, or DCC mechanism is implemented in the first release.
- Replacing the current persistence backend with SQLite/WAL as part of this contract; the existing store seam remains the migration boundary.
- Redesigning user preference ranking, conversational UI, or the Agent's final prose explanation beyond the structured action and diagnostic contract.
- Browser relay, AionCore integration, sidecar, Chromium, PWA bearer, or any unrelated transport work.
- Production catalog population, staging bank integrations, or verification of every bank's current public source.

## Further Notes

- This specification extends the current MCP design; it does not invalidate the existing deterministic calculation, user-scoped store, merchant catalog, evidence provenance, or fail-closed rules.
- The first implementation slice should combine the pre-flight contract with the correctness fixes already identified in recommendation canonical merchant mapping, post-pagination bounding, diagnostic coverage, calculation trust gating, and MCP-owned FX snapshot identity.
- The proposed seam is intentionally one stateful domain seam plus one thin protocol adapter. Before implementation begins, confirm that this division matches expectations: `RewardService` owns the pre-flight decision, while the MCP adapter owns schema and dispatch only.
- The terms raw evidence, typed evidence, fact candidate, verified fact, rule version, and recommendation result should remain distinct in all future documents. A source URL alone is not a verified fact.
- A successful pre-flight means the current inputs and stored facts satisfy the declared requirements at the evaluated time; it does not guarantee that an issuer will later post a reward or that an external source cannot change.
- The Agent should treat every refresh action as a bounded workflow: obtain evidence, preserve provenance and observation time, submit typed data, rerun pre-flight, then recommend only when the MCP says the calculation is ready.
