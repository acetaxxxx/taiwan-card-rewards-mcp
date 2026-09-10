# Taiwan Card Rewards Skill Bundle

這個 bundle 提供 Agent 可直接載入的 canonical Skill、19-tool MCP reference、workflows 與端到端呼叫範例。MCP 是零網路的 deterministic 計算核心與 user-scoped durable ledger；官方頁面、PDF、圖片、OCR 與匯率研究由 Agent/UI 在 MCP 外完成。

## 快速啟動

```bash
npx --yes github:acetaxxxx/taiwan-card-rewards-mcp#main \
  --data-dir /absolute/path/to/my-card-rewards-data \
  --user display-label
```

可將 `#main` 換成已驗證的 release tag。`--data-dir` 是唯一的 storage/tenant 邊界；`--user` 僅是 display/audit metadata，不能提供授權，也不能切換資料目錄。每一個 user/environment 應使用不同的絕對資料目錄。

Host 設定：

```json
{
  "mcpServers": {
    "taiwan_card_rewards_mcp": {
      "command": "npx",
      "args": [
        "--yes",
        "github:acetaxxxx/taiwan-card-rewards-mcp#main",
        "--data-dir",
        "/absolute/path/to/my-card-rewards-data",
        "--user",
        "display-label"
      ]
    }
  }
}
```

載入 [`SKILL.md`](SKILL.md) 後，Agent 依需求漸進載入 reference/workflow；不要複製猜測 schema。

## 目錄

```text
docs/agents/taiwan-card-rewards-skill/
├── SKILL.md                                  # 精簡 router 與 invariants
├── README.md                                 # 安裝與目錄導覽
├── references/
│   ├── mcp-tools.md                           # canonical 19-tool contract
│   ├── mcp-tool-call-playbook.md              # 合法呼叫骨架與順序
│   ├── architecture-and-boundaries.md        # Agent/MCP 權責與零網路邊界
│   └── lifecycle-and-privacy.md               # storage、evidence、敏感資料
├── workflows/                                 # intent、onboarding、research、preflight、route、event SOP
└── examples/
    ├── planned-recommendation.md              # card branch 的 planned recommendation
    ├── payment-path-recommendation.md         # account/card → wallet → acceptance → merchant
    ├── gold-evidence-and-fail-closed.md       # Gold evidence、valuation/FX/fee recovery
    ├── foreign-payment-route-and-fx.md        # nested foreign transaction + FX
    ├── stale-fx-recovery.md                   # stale FX recovery
    └── actual-transaction-and-refund.md       # actual ledger 與 linked refund
```

## 使用原則

- `recommend` 是唯一的推薦入口：merchant-first intent 的 `candidates[]` 已經同時包含直接刷卡（`direct_card`）與多層路徑（`payment_path`），不需要分開呼叫。
- 正常商家推薦直接送出 merchant-first intent；`list_cards`、account/route 清單是管理或明確查詢用途，不是必要前置。
- 外幣交易由 Agent 自行取得目前匯率，以單一 `fx` snapshot 附在 intent／transaction／event 上，通過檢查即直接信任套用，不需要先呼叫任何 FX 專用 tool。
- `upsert_payment_route`／`upsert_payment_capability` 的 `evidenceIds` 是 Agent 自帶的 self-asserted citation，直接信任，不需要先提交 evidence；使用者明確表示不可用時才標記 `failed`。
- `record_event_reward` 與 `reverse_event_reward` 是 canonical public names。歷史 versioned aliases（如 `record_event_reward_v1`）已完全移除，不是隱藏別名，呼叫會得到 `TOOL_NOT_FOUND`。
- `record_transaction` 只接受 actual purchase/refund；planned evaluations 絕不扣 caps 或寫 ledger。
- unknown/stale/needs_review、未證實銀行/sidecar/Chromium 路徑、缺官方來源都要明示，不得包裝成已支援。

## 驗證

文件變更後，從 repo 根目錄執行 `npm run typecheck`、`npm run build`、`npm test`、`git diff --check`；再檢查 Markdown links 與 canonical 19-tool/name grep。此 bundle 不代表真實銀行產品、sidecar 或 staging 已驗證。
