# 使用者安裝與 Skill 分發標準作業程序 (SOP)

**文件狀態**：正式營運與分發規範 (Normative Distribution & Installation SOP)
**適用範圍**：canonical 19-tool MCP contract（release tag 僅供部署管理）
**語言**：繁體中文
**遵循規範**：[`CONTEXT.md`](../../CONTEXT.md), [ADR 0001](../adr/0001-independent-card-rewards-domain-and-agent-supplied-rules.md), [ADR 0003](../adr/0003-complete-initial-mcp-surface-with-layered-trust-gates.md), [ADR 0004](../adr/0004-generic-benefit-status-and-schema-v2.md), [ADR 0005](../adr/0005-payment-route-opportunity-stacking.md), [ADR 0006](../adr/0006-multi-component-reward-ledger-and-cap-attribution.md), [Agent Research Skill SOP](agent-research-skill-and-preflight-sop.md), [Usage Guide](usage-guide.md).

---

## 1. Canonical Skill 分發政策 (Canonical Skill Distribution Policy)

為確保跨平台、多代理人（Multi-Agent）與各類宿主環境（AionCore、Claude Desktop、Cursor、自建 Agent 等）在調用 `taiwan-card-rewards-mcp` 時具備一致的計算權威與安全防線，本專案採行 **Canonical-Source + Local-Adapter 雙層分發政策**。

```
┌─────────────────────────────────────────────────────────────────────────┐
│              Canonical Source of Truth (本專案唯一權威版本)                │
│  - docs/agents/taiwan-card-rewards-skill/SKILL.md (Agent 入口)           │
│  - docs/agents/taiwan-card-rewards-skill/references/ (詳細 contract)     │
│  - canonical contract：19 tools | 語系：繁體中文 (zh-Hant-TW)             │
└────────────────────────────────────┬────────────────────────────────────┘
                                     │
           ┌─────────────────────────┴─────────────────────────┐
           ▼                                                   ▼
┌─────────────────────────────────────┐     ┌─────────────────────────────────────┐
│    直接引用模式 (Direct Reference)   │     │    適配器模式 (Local Adapter)       │
│  • 宿主環境直接載入 Canonical Skill  │     │  • 針對特定 Agent 框架轉譯/在地化   │
│  • 原汁原味保留所有 Invariants      │     │  • 必須標註 Metadata 與 Hash 溯源   │
│  • 推薦大多數標準部署優先採用       │     │  • 嚴禁放寬安全、計算與網路防線     │
└─────────────────────────────────────┘     └─────────────────────────────────────┘
```

### 1.1 Canonical Source 原則
1. **單一事實來源 (Single Source of Truth)**：Agent 入口是 [`docs/agents/taiwan-card-rewards-skill/SKILL.md`](taiwan-card-rewards-skill/SKILL.md)，詳細 contract 是其 [`references/mcp-tools.md`](taiwan-card-rewards-skill/references/mcp-tools.md)；模板與長版研究 SOP 是可移植輔助文件，不得覆蓋入口或 source contract。
2. **免除自行重構負擔**：使用者或整合商**不需要、亦不應被要求**自行從零編寫或推導完整 Skill 邏輯；安裝時應優先直接引用或複製 Canonical 檔案。

### 1.2 Local Adapter 轉接與在地化規範
若宿主 Agent 框架有特殊的 Prompt 格式要求（如 XML 標籤、自訂 Tool Wrapper）、不同界面語系翻譯需求，允許建立 **Local Adapter**，但必須嚴格遵守以下「不變量守則」：

> [!IMPORTANT]
> **Local Adapter 必備 Metadata**：
> 任何 Local Adapter 檔案檔頭必須包含以下機器可讀註記：
> - `sourceVersion`: 衍生之 Canonical 版本（如 `0.9.0`）。
> - `sourceHash`: 衍生時 Canonical 檔案之 SHA-256 雜湊值。
> - `mcpContractVersion`: 對應之 canonical MCP contract；不要在此欄位硬編 public tool count。
> - `lastVerifiedAt`: 最近一次通過健康檢查之 ISO 8601 時間戳記。
> - `canonicalLink`: 指向本專案 Canonical 文件的絕對或相對連結。

> [!CAUTION]
> **不可動搖之防線 (Non-Negotiable Invariants)**：
> 1. **不可放寬安全邊界**：嚴禁在 Adapter 中允許傳輸卡號（PAN）、CVV、OTP、密碼或 Token。
> 2. **不可篡改計算權威**：金額試算、上限池扣減與帳本狀態權威永遠屬於 MCP，Adapter 嚴禁自行編寫估算邏輯。
> 3. **不可破壞零網路原則**：MCP 內部無網路，Adapter 必須明確指示 Agent 自行負責網頁檢索與匯率 PPM 量化。
> 4. **不可實施 Fuzzy Auto-Accept**：模糊匹配必須維持歧義診斷，絕不自動寫入帳本。
> 5. **不可宣稱為 Canonical**：翻譯版或包裝版必須明確自稱為「Adapter」，嚴禁自稱官方 Canonical。

### 1.3 漂移偵測機制 (Adapter Drift Detection)
Agent 於每次啟動或定期維護時，應比對 Local Adapter 的 `sourceHash` 與官方最新釋出之 Canonical Hash：
- 若 Hash 不一致且 Canonical `sourceVersion` 升級，Agent 應主動提示使用者：「檢測到官方 Card Rewards Skill 已有更新版本，請評估同步 Local Adapter」。

---

## 2. 安裝前置條件 (Prerequisites)

在安裝與啟動 `taiwan-card-rewards-mcp` 之前，請確認系統環境滿足以下條件：

| 項目 | 最低要求 | 建議配置 | 檢查指令 | 完成標準 |
|---|---|---|---|---|
| **Node.js** | `>= 18.0.0` | `20.x` 或 `22.x` (LTS) | `node -v` | 輸出 `v18.0.0` 以上 |
| **npm / npx** | `>= 8.0.0` | 最新 LTS 隨附版本 | `npx -v` | 正常執行無錯誤 |
| **作業系統** | Linux / macOS / Windows | POSIX 相容環境 | `uname -s` | 支援檔案鎖與 stdio 管線 |
| **磁碟權限** | 專屬資料目錄讀寫權限 | 具備 Exclusive File Lock 支援 | `touch <data-dir>/test.tmp` | 可正常建立與刪除檔案 |

---

## 3. 人類安裝步驟 (Human Step-by-Step Installation SOP)

### 步驟 1：建立專屬資料目錄 (Data Directory Setup)
為確保使用者個人信用卡資料與消費帳本完全隔離，為每個使用者或環境建立獨立的絕對路徑資料夾：

```bash
mkdir -p /path/to/my-card-rewards-data
```
*驗證條件*：確認該目錄為目前使用者所有且具備可讀寫權限。

### 步驟 2：配置 MCP 伺服器啟動命令
依據您的執行環境，選擇以下任一種方式配置：

#### 方案 A：使用 Git / npx Pinned Tag（推薦免安裝模式）
直接透過 `npx` 執行指定發行版本（npm 會自動觸發 `prepare` 編譯）：

```bash
npx --yes github:acetaxxxx/taiwan-card-rewards-mcp#v0.11.0 \
  --data-dir /path/to/my-card-rewards-data \
  --user default-user
```

#### 方案 B：本地原始碼 Checkout 模式（開發與客製化）
```bash
git clone https://github.com/acetaxxxx/taiwan-card-rewards-mcp.git
cd taiwan-card-rewards-mcp
npm ci --ignore-scripts
npm run build
node dist/cli.js --data-dir /path/to/my-card-rewards-data --user default-user
```

#### 方案 C：宿主應用程式配置 (例如 Claude Desktop / Cursor / AionCore)
在宿主設定檔（如 `claude_desktop_config.json` 或 AionCore 配置）中加入 stdio MCP 伺服器：

```json
{
  "mcpServers": {
    "taiwan_card_rewards_mcp": {
      "command": "npx",
      "args": [
        "--yes",
        "github:acetaxxxx/taiwan-card-rewards-mcp#v0.11.0",
        "--data-dir",
        "/absolute/path/to/my-card-rewards-data",
        "--user",
        "my-user-id"
      ]
    }
  }
}
```

### 步驟 3：載入與安裝 Canonical Skill
1. 將本專案的 [`docs/agents/taiwan-card-rewards-skill/SKILL.md`](taiwan-card-rewards-skill/SKILL.md) 內容複製至您的 Agent 技能庫中（例如 AionCore Skills 或 Cursor Rules）。
2. 若您的 Agent 需要專用名稱，可在檔頭指定 `name: card-rewards-assistant`。
3. 確保 Agent 能讀取 [`docs/agents/taiwan-card-rewards-skill/references/mcp-tools.md`](taiwan-card-rewards-skill/references/mcp-tools.md) 與相關 workflow；研究細節可參考 [`docs/agents/agent-research-skill-and-preflight-sop.md`](agent-research-skill-and-preflight-sop.md)。

---

## 4. Agent 自動化安裝與健康檢查清單 (Agent Executable Checklist)

Agent 在接收到安裝或初始化指令時，應依照以下 Checklist 進行驗證：

```markdown
- [ ] 1. 環境檢驗 (Environment Check)
      - 執行 `node -v` 確認版本 >= 18.0.0。
      - 驗證 `--data-dir` 絕對路徑存在且具備讀寫權限。

- [ ] 2. 伺服器握手 (Handshake Validation)
      - 發送 `initialize` JSON-RPC 請求。
      - 驗證回應中的 `protocolVersion` 為 `2024-11-05`。
      - 驗證 `serverInfo.name` 為 `taiwan_card_rewards_mcp`，`serverInfo.version` 為 `0.11.0` (或更新相容版本)。

- [ ] 3. 19 項 canonical 公開工具檢核 (19-Tool Contract Verification)
      - 發送 `tools/list` 請求，確認 [`taiwan-card-rewards-skill/references/mcp-tools.md`](taiwan-card-rewards-skill/references/mcp-tools.md) 的 19 項工具完整存在：
        [ ] recommendation_preflight (唯讀，支援 preflight 診斷)
        [ ] recommend (唯讀，支援分頁與有界推薦)
        [ ] calculate_reward (唯讀，純數學計算)
        [ ] rank_cards (唯讀，多卡純排序)
        [ ] resolve_merchant (唯讀，實體消歧義)
        [ ] search_active_offers (唯讀，有效優惠探索)
        [ ] list_cards (唯讀，卡片清冊查詢)
        [ ] remaining_caps (唯讀，上限餘額查詢)
        [ ] get_user_benefit_status (唯讀，權益/登錄狀態)
        [ ] list_payment_routes (唯讀，支付路徑清冊查詢)
        [ ] register_payment_account (寫入，wallet/bank opaque identity)
        [ ] list_payment_accounts (唯讀，account identity 查詢)
        [ ] register_card (寫入，卡片登記)
        [ ] upsert_offer (寫入，快照與規則建立)
        [ ] upsert_payment_route (寫入，支付路徑拓撲與扣款設定)
        [ ] upsert_user_benefit_status (寫入，權益與登錄確認)
        [ ] record_transaction (寫入，實際交易記帳與退款)
        [ ] record_event_reward (寫入，event rule/chain eligibility)
        [ ] reverse_event_reward (寫入，explicit event refund reversal)

- [ ] 4. 聯通性健康檢查 (Connectivity Ping)
      - 呼叫 `list_cards`，預期回傳空陣列 `[]`（初始狀態）或已登記卡片。
      - 發起一次最簡 `recommendation_preflight` 測試，確認回傳結構包含 `ready`、`diagnostics` 與 `dataVersion`。

- [ ] 5. Skill 與 Adapter 整合確認 (Skill Integrity Check)
      - 若使用 Local Adapter，檢查檔頭包含 `sourceVersion`、`sourceHash` 與 `canonicalLink`。
      - 確認 Agent Workspace 已就緒，具備外部網頁檢索與匯率計算能力。
```

---

## 5. 版本升級與回滾程序 (Upgrade & Rollback SOP)

### 5.1 升級程序 (Upgrade Procedure)
1. **停止現有行程**：中斷正在執行的 MCP 行程，確認釋放 `card-rewards.lock` 檔案鎖。
2. **資料目錄備份**：
   ```bash
   cp -r /path/to/my-card-rewards-data /path/to/my-card-rewards-data.backup-$(date +%Y%m%d%H%M%S)
   ```
3. **更新版本宣告**：將啟動命令或設定檔中的版本 tag 指向新版本（例如 `#v0.11.0`）。
4. **重新執行健康檢查**：重跑第 4 節的 19 項工具驗證與 `recommendation_preflight`。

### 5.2 回滾程序 (Rollback Procedure)
若升級後遇到相容性問題或異常：
1. 立即停止新版本行程。
2. 將資料目錄還原為升級前之備份複本。
3. 將啟動命令改回前一穩定版本（例如 `#v0.9.0`）。
4. 重新啟動並驗證 `list_cards` 與 `remaining_caps` 資料完整性。

---

## 6. 多代理人與多租戶部署規範 (Multi-Agent & Multi-Tenant Deployment)

### 6.1 多租戶嚴格隔離 (Strict Tenant Isolation)
- **黃金原則**：**不同使用者（User）絕對不能共用同一個 `--data-dir`**。
- 每個獨立使用者的信用卡資料、持卡事實、消費帳本與退款紀錄必須保存在專屬的檔案系統路徑。

### 6.2 多代理人協同 (Multi-Agent on Single Tenant)
當同一個使用者的多個 AI Agent（例如一個負責日常記帳、一個負責旅遊推薦）同時服務該使用者時：
- **行程排他鎖控制**：`taiwan-card-rewards-mcp` 啟動時會在 `--data-dir` 建立 `card-rewards.lock`。同時間僅允許一個行程進行獨佔讀寫。
- **最佳實踐**：由宿主系統管理單一持久化 MCP 行程，所有代理人透過該行程轉接；或代理人依序啟動並在完成任務後釋放行程。

---

## 7. 故障排查與 Support Bundle 生成 (Troubleshooting & Support Bundle)

### 7.1 常見錯誤碼與排除對策

| 錯誤代碼 | 常見原因 | 排查與解決對策 |
|---|---|---|
| `LOCK_EXISTS` | 前一次行程未正常退出，或有其他行程正在使用該 `--data-dir` | 確認無其他 node 行程佔用後，檢查並清理目錄下的 `card-rewards.lock`。 |
| `SENSITIVE_FIELD_FORBIDDEN` | 請求參數中包含 `pan`, `cvv`, `otp`, `password`, `token` 等敏感欄位 | 檢查 Agent 送出的 payload，移除任何私密支付憑據。 |
| `INSUFFICIENT_FACTS` | 缺少必要的時區、國家、幣別或匯率快照 | 依據診斷回傳的 `requiredFacts`，向使用者詢問或透過 Research SOP 補齊資料。 |
| `STALE` | 優惠規則已過期或匯率快照超過最大有效時間 | 執行 Research SOP，取得最新官方牌告匯率或活動條款更新規則。 |
| `IDEMPOTENCY_CONFLICT` | 同一 `idempotencyKey` 送出不同內容的交易資料 | 確認交易唯一性金鑰是否重複使用，或修正衝突的交易屬性。 |
| `STORE_UNAVAILABLE` | 資料目錄無寫入權限或磁碟空間不足 | 檢查檔案系統權限與可用空間。 |

### 7.2 安全脫敏 Support Bundle 產生 SOP
當需要向專案團隊回報異常時，請依照以下步驟產出**安全脫敏診斷包 (Redacted Support Bundle)**：

1. **收集診斷資訊**：
   - MCP Server 版本號（`serverInfo.version`）。
   - 失敗工具呼叫之名稱與完整錯誤回應（包含 `diagnostics` 與 `requiredActions`）。
   - 相關之 `catalogVersion`、`indexVersion` 與 `ruleVersion`。
2. **強制脫敏檢查 (Sanitization Check)**：
   - [ ] 移除任何使用者的個人身分識別資訊（姓名、身分證字號、Email）。
   - [ ] 確認完全無任何信用卡卡號或帳號資訊。
   - [ ] 替換具體消費金額與私人商家備註。
3. **提交 Issue**：將脫敏後之 JSON 與重現步驟提交至專案 Issue Tracker。
