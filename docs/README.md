# Documentation map

This directory contains the design, research, specifications, and future Aion
integration contract for `taiwan-card-rewards-mcp`.

## Start here

- [推薦體驗規劃與實作票：單一 recommend、完整付款路徑與缺項回復](../.scratch/recommend-experience/spec.md)
- [目前可用的商家意圖推薦流程](agents/taiwan-card-rewards-skill/workflows/recommendation-intent.md)
- [目標 Agent workflow：登記、推薦、匯率更新與完整分頁](../.scratch/recommend-experience/agent-workflow.md)
- [AI Agent usage guide](agents/usage-guide.md)
- [Agent skill-authoring guide](agents/skill-authoring-guide.md)
- [Canonical Taiwan Card Rewards Skill Bundle](agents/taiwan-card-rewards-skill/SKILL.md)
- [使用者安裝與 Skill 分發 SOP](agents/user-installation-and-skill-distribution-sop.md)
- [Agent Research Skill 與 Pre-flight SOP (v0.11.0)](agents/agent-research-skill-and-preflight-sop.md)
- [Card-rewards skill template](agents/card-rewards-skill-template.md)
- [Card Rewards Schema v2 specification](specs/card-rewards-schema-v2-specification.md)
- [Multi-component reward ledger specification (v0.6.0)](specs/multi-component-ledger-and-cap-attribution-specification.md)
- [MCP nested schemas and actionable errors specification](specs/mcp-nested-schemas-actionable-errors-specification.md)
- [Multi-layer payment path recommendation specification](specs/multi-layer-payment-path-recommendation-specification.md)
- [Codebase design](design/codebase-design.md)
- [Domain and agent-supplied rule ADR](adr/0001-independent-card-rewards-domain-and-agent-supplied-rules.md)
- [Multi-component reward ledger ADR](adr/0006-multi-component-reward-ledger-and-cap-attribution.md)
- [Provider-neutral payment-route facts and evidence ADR](adr/0007-provider-neutral-payment-route-facts-and-evidence.md)
- [Official Taiwan credit-card research](research/archive/taiwan-credit-cards-official-research.md)
- [Wallet and merchant-app stacked rewards research](research/archive/wallet-and-merchant-app-stacked-rewards.md)
- [Payment-route chain reality and MCP design research](research/archive/payment-route-chain-reality-and-mcp-design.md)
- [MCP tool schema vs agent failure analysis](research/archive/mcp-contract-agent-failure-analysis.md)
- [FX lookup and merchant identity research](research/archive/fx-lookup-and-merchant-identity-research.md)
- [Reference study and product plan](specs/taiwan-card-rewards-mcp-reference-study.md)
- [Repository and Aion integration contract](specs/card-rewards-mcp-repository.md)
- [Skill/Agent binding plan](integration/CARD_REWARDS_SKILL_BINDING_PLAN.md)

The integration plan is a planning document only. It does not create or
install an Aion Skill, and the MCP remains the authority for deterministic
calculation and user-scoped persistence.
