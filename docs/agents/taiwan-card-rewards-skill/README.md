# Taiwan Card Rewards Skill Bundle (台灣信用卡回饋技能包)

歡迎使用台灣信用卡回饋分析與推薦技能包（Taiwan Card Rewards Skill Bundle）。本套件提供專為大型語言模型與代理人（AI Agents）設計的規範文件、流程 SOP 與模板，搭配 `taiwan-card-rewards-mcp` (v0.9.0, 15 Tools) 實現高精度、可解釋且安全的信用卡回饋試算、持卡登錄與消費管理。

---

## 快速安裝與配置 (Quick Installation)

### 1. 啟動 MCP 伺服器
依據您的執行環境，配置 MCP stdio 伺服器並指定專屬的 `--data-dir`（使用者資料絕對隔離）：

```bash
# 透過 npx 執行 Pinned Tag
npx --yes github:acetaxxxx/taiwan-card-rewards-mcp#v0.9.0 \
  --data-dir /path/to/my-card-rewards-data \
  --user default-user
```

#### 宿主設定範例 (Claude Desktop / Cursor / AionCore)
```json
{
  "mcpServers": {
    "taiwan-card-rewards": {
      "command": "npx",
      "args": [
        "--yes",
        "github:acetaxxxx/taiwan-card-rewards-mcp#v0.9.0",
        "--data-dir",
        "/absolute/path/to/my-card-rewards-data",
        "--user",
        "default-user"
      ]
    }
  }
}
```

### 2. 安裝本 Skill
- **直接引用模式 (推薦)**：將本目錄下的 [`SKILL.md`](SKILL.md) 加入至您的 Agent 技能清單（如 AionCore Skills、Claude Code Skills 或 Cursor Rules）。
- **適配器模式 (Local Adapter)**：若需要多語系轉譯或特定框架包裝，請複製範本並填寫 [`templates/adapter-manifest.json`](templates/adapter-manifest.json) 以維持不變量溯源。

---

## 模組目錄索引 (Directory Map)

```
docs/agents/taiwan-card-rewards-skill/
├── SKILL.md                                           # [入口] 技能主入口、意圖路由器與決策樹
├── README.md                                          # [導覽] 本說明文件與快速安裝指南
├── references/                                        # [規範] 架構與合約規範
│   ├── architecture-and-boundaries.md                 # MCP vs Agent 權責劃分與資料隔離
│   ├── mcp-tools-v0.9.0.md                            # 15 項公開 MCP 工具簽名、參數與錯誤碼
│   ├── mcp-tool-call-playbook.md                      # 15 項工具之標準實戰 JSON Payload 呼叫手冊
│   └── lifecycle-and-privacy.md                       # 實體 ID 生命週期與隱私脫敏守則
├── workflows/                                         # [流程] 標準作業程序 (SOP)
│   ├── card-onboarding-and-benefit-enrollment.md      # 初次持卡安全登錄與動態權益設定 SOP
│   ├── preflight-and-required-actions.md              # Pre-flight 診斷、消歧義與推薦 SOP
│   ├── merchant-resolution-and-disambiguation.md      # 商家實體確定性消歧義與候選比對 SOP
│   ├── offer-discovery-and-pagination.md              # 完整分頁遍歷與有界優惠發現 SOP
│   ├── research-and-evidence-submission.md            # 官方條款查核、證據鏈與規則寫入 SOP
│   └── payment-route-and-fx.md                        # 通用支付通道與外幣匯率 PPM SOP
├── templates/                                         # [模板] 設定與配置模板
│   ├── adapter-manifest.json                          # Local Adapter 衍生元資料規範
│   └── user-config-checklist.md                       # 使用者卡片與權益設定檢核清單
└── examples/                                          # [範例] 完整端到端實例
    ├── card-onboarding-and-benefit-setup.md           # 初次持卡登記與 CUBE 權益方案設定實例
    ├── planned-recommendation.md                      # 國內消費多卡多組件推薦實例
    ├── ambiguous-merchant-and-exhaustive-discovery.md # 商家消歧義與分頁遍歷搜尋實例
    ├── foreign-payment-route-and-fx.md                # 通用跨國支付通道與匯率量化實例
    ├── merchant-ambiguity-recovery.md                 # 商家名稱模糊之消歧義修復流程
    ├── stale-fx-recovery.md                           # 外幣即時匯率查核與快照補齊流程
    ├── no-active-offer-base-rule.md                   # 無專屬活動時基礎回饋回退實例
    └── actual-transaction-and-refund.md               # 實際刷卡記帳與退款對沖實例
```
