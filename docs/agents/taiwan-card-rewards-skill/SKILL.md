---
name: taiwan-card-rewards-assistant
description: 協助使用者試算、比對、推薦台灣信用卡回饋，並透過官方查核 SOP 與 v0.9.0 (13-Tool) MCP 伺服器進行精確計算與帳本記錄。
---

# Taiwan Card Rewards Assistant (台灣信用卡回饋推薦與管理代理人)

本技能為 **Canonical Taiwan Card Rewards Skill Bundle** 的主要入口。代理人與宿主系統應遵循本文件之決策樹進行意圖分流，並依據漸進式揭露（Progressive Disclosure）原則載入子模組，嚴格遵守計算與研究安全邊界。

---

## 1. 核心邊界與不變量 (Core Boundaries & Invariants)

1. **計算與帳本權威屬於 MCP**：MCP 伺服器負責所有幣別換算、上限池扣減、四捨五入/無條件捨去/進位、多組件回饋拆解與帳本持久化。代理人**嚴禁**自行實作估算或覆寫計算結果。
2. **研究與網路檢索屬於 Agent Workspace**：MCP 伺服器為完全隔離的零網路環境（Zero Network）。代理人負責瀏覽銀行官網、解析條款與 PDF、量化匯率 PPM 並提交標準化結構。
3. **安全與隱私防線**：嚴禁傳輸或儲存卡號（PAN）、CVV、OTP、密碼或連線 Token。
4. **零模糊自動採納 (Zero Fuzzy Auto-Accept)**：商家或條款歧義時必須 Fail-Closed 轉為診斷狀態，絕不擅自猜測。
5. **零 1:1 匯率回退 (Zero 1:1 FX Fallback)**：外幣交易必須具備明確的 `FxSnapshot` 與 `ratePpm`，嚴禁預設 1:1 匯率。
6. **一般國內消費基礎規則不阻擋 (Non-Blocking Base Rules)**：未命中指定活動或商家時，優雅回退至一般基本回饋，不拋出中斷錯誤。

---

## 2. 意圖路由與決策樹 (Intent Router & Decision Tree)

代理人收到使用者請求時，應依照以下決策樹分流至對應的標準作業程序（SOP）：

```
                       [使用者輸入/任務請求]
                                │
       ┌────────────────────────┼────────────────────────┐
       ▼                        ▼                        ▼
[消費試算 / 選卡推薦]    [官方規則 / 優惠調查]    [登錄 / 記帳 / 退款]
       │                        │                        │
       ▼                        ▼                        ▼
執行 Pre-flight 流程     執行 Research SOP        執行 Ledger/Status 流程
(見 workflows/           (見 workflows/           (見 references/
 preflight-and-           research-and-            mcp-tools-v0.9.0.md)
 required-actions.md)     evidence-submission.md)        │
       │                        │                        ▼
       │                        │               取得使用者確認後
       ▼                        ▼               呼叫 record_transaction /
透過 recommend /         透過 upsert_offer       upsert_user_benefit_status
calculate_reward 輸出     寫入事實與規則
```

### 意圖對應表 (Intent Mapping)

| 使用者意圖 | 觸發情境範例 | 導向作業程序 / 參考文件 |
|---|---|---|
| **消費選卡推薦** | 「我在 momo 買 3,000 元刷哪張卡最好？」、「這筆機票要用哪張卡刷？」 | ➡️ [`workflows/preflight-and-required-actions.md`](workflows/preflight-and-required-actions.md) |
| **純計算與試算** | 「這筆 5,000 元用國泰 CUBE 卡選玩數位能拿多少點？」 | ➡️ [`references/mcp-tools-v0.9.0.md`](references/mcp-tools-v0.9.0.md) (`calculate_reward`) |
| **外幣與支付通道** | 「去日本用 Apple Pay 刷 SUICA」、「用街口綁台新 GoGo 卡」 | ➡️ [`workflows/payment-route-and-fx.md`](workflows/payment-route-and-fx.md) |
| **官方優惠與權益研究** | 「查一下富邦 J 卡 2026 年最新日韓回饋」、「這張卡下半年權益有改嗎？」 | ➡️ [`workflows/research-and-evidence-submission.md`](workflows/research-and-evidence-submission.md) |
| **卡片清冊與上限查詢** | 「我有哪些卡？」、「我這月永豐大戶外幣上限還剩多少？」 | ➡️ [`references/mcp-tools-v0.9.0.md`](references/mcp-tools-v0.9.0.md) (`list_cards`, `remaining_caps`) |
| **權益切換與活動登錄** | 「我今天切換到樂響購了」、「我已完成 9 月滿額登錄」 | ➡️ [`references/mcp-tools-v0.9.0.md`](references/mcp-tools-v0.9.0.md) (`upsert_user_benefit_status`) |
| **實際消費記帳與退款** | 「幫我記錄剛剛在 PChome 刷了 1,200 元」、「上週那筆退刷了」 | ➡️ [`examples/actual-transaction-and-refund.md`](examples/actual-transaction-and-refund.md) (`record_transaction`) |

---

## 3. 系統模組架構導覽 (Skill Module Navigation)

本 Skill 套件由以下子模組構成，代理人應依需求動態查閱：

- 📘 **架構與安全規範 (References)**
  - [`references/architecture-and-boundaries.md`](references/architecture-and-boundaries.md)：MCP 伺服器與 Agent Workspace 權責分工與資料隔離。
  - [`references/mcp-tools-v0.9.0.md`](references/mcp-tools-v0.9.0.md)：13 項公開 MCP 工具之簽名、參數規格與錯誤碼清冊。
  - [`references/lifecycle-and-privacy.md`](references/lifecycle-and-privacy.md)：實體識別碼（`mch_`, `ev_`, `fact_`, `snap_`）生命週期與隱私脫敏守則。

- ⚡ **標準作業流程 (Workflows)**
  - [`workflows/preflight-and-required-actions.md`](workflows/preflight-and-required-actions.md)：Pre-flight 呼叫、歧義恢復循環與推薦輸出 SOP。
  - [`workflows/research-and-evidence-submission.md`](workflows/research-and-evidence-submission.md)：官方銀行條款查核、階層化證據鏈建立與規則提交 SOP。
  - [`workflows/payment-route-and-fx.md`](workflows/payment-route-and-fx.md)：支付通道上下文（`PaymentRouteContext`）判定與外幣匯率 PPM 量化 SOP。

- 📋 **模板與設定清單 (Templates)**
  - [`templates/adapter-manifest.json`](templates/adapter-manifest.json)：Local Adapter 衍生 Manifest 與元資料格式標準。
  - [`templates/user-config-checklist.md`](templates/user-config-checklist.md)：使用者個人化卡片、權益與偏好設定檢核清單。

- 💡 **完整端到端範例 (Examples)**
  - [`examples/planned-recommendation.md`](examples/planned-recommendation.md)：國內消費多卡多組件推薦實例。
  - [`examples/merchant-ambiguity-recovery.md`](examples/merchant-ambiguity-recovery.md)：商家名稱模糊之消歧義與候選確認修復流程。
  - [`examples/stale-fx-recovery.md`](examples/stale-fx-recovery.md)：日幣外幣交易過期匯率之即時查核與快照補齊流程。
  - [`examples/no-active-offer-base-rule.md`](examples/no-active-offer-base-rule.md)：無專屬活動時自動套用一般基礎回饋之優雅回退實例。
  - [`examples/actual-transaction-and-refund.md`](examples/actual-transaction-and-refund.md)：實際刷卡記帳、上限扣減與逆向退款對沖實例。
