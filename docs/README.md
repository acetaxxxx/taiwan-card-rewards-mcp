# Documentation map

This directory contains the design, research, specifications, and future Aion
integration contract for `taiwan-card-rewards-mcp`.

## Start here

- [AI Agent usage guide](agents/usage-guide.md)
- [Agent skill-authoring guide](agents/skill-authoring-guide.md)
- [Canonical Taiwan Card Rewards Skill Bundle](agents/taiwan-card-rewards-skill/SKILL.md)
- [使用者安裝與 Skill 分發 SOP](agents/user-installation-and-skill-distribution-sop.md)
- [Agent Research Skill 與 Pre-flight SOP (v0.10.0)](agents/agent-research-skill-and-preflight-sop.md)
- [Card-rewards skill template](agents/card-rewards-skill-template.md)
- [Card Rewards Schema v2 specification](specs/card-rewards-schema-v2-specification.md)
- [Multi-component reward ledger specification (v0.6.0)](specs/multi-component-ledger-and-cap-attribution-specification.md)
- [Market-aware MerchantIdentity 與有效優惠搜尋規格（待 Review）](specs/market-aware-merchant-identity-and-valid-offer-search-specification.md)
- [MCP nested schemas and actionable errors specification](specs/mcp-nested-schemas-actionable-errors-specification.md)
- [Agent-supplied FX and fail-closed specification](specs/agent-supplied-fx-and-fail-closed-specification.md)
- [FX Snapshot 儲存與 Current Rate 簡化政策（修訂）](specs/fx-snapshot-storage-and-current-rate-policy-specification.md)
- [MCP 有界回應、Page 分頁、Projection 與 Store Isolation 規格](specs/bounded-mcp-responses-pagination-projections-store-isolation-specification.md)
- [Recommendation 可配置筆數與 Page 分頁規格](specs/recommendation-pagination-and-configurable-limit-specification.md)
- [Agent Workspace 與 MCP Durable State 所有權規格](specs/agent-workspace-and-mcp-durable-state-ownership-specification.md)
- [Agent FX 與商家 Canonical Fact Recovery Workflow 規格](specs/agent-canonical-fact-recovery-workflow-specification.md)
- [Codebase design](design/codebase-design.md)
- [Domain and agent-supplied rule ADR](adr/0001-independent-card-rewards-domain-and-agent-supplied-rules.md)
- [Multi-component reward ledger ADR](adr/0006-multi-component-reward-ledger-and-cap-attribution.md)
- [Provider-neutral payment-route facts and evidence ADR](adr/0007-provider-neutral-payment-route-facts-and-evidence.md)
- [Official Taiwan credit-card research](research/taiwan-credit-cards-official-research.md)
- [Wallet and merchant-app stacked rewards research](research/wallet-and-merchant-app-stacked-rewards.md)
- [Payment-route chain reality and MCP design research](research/payment-route-chain-reality-and-mcp-design.md)
- [MCP tool schema vs agent failure analysis](research/mcp-contract-agent-failure-analysis.md)
- [FX lookup and merchant identity research](research/fx-lookup-and-merchant-identity-research.md)
- [Reference study and product plan](specs/taiwan-card-rewards-mcp-reference-study.md)
- [Repository and Aion integration contract](specs/card-rewards-mcp-repository.md)
- [Skill/Agent binding plan](integration/CARD_REWARDS_SKILL_BINDING_PLAN.md)

The integration plan is a planning document only. It does not create or
install an Aion Skill, and the MCP remains the authority for deterministic
calculation and user-scoped persistence.
