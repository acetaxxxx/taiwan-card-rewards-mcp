---
name: taiwan-card-rewards-assistant
description: 協助使用者試算、比對、推薦台灣信用卡回饋，並透過官方查核 SOP 與 v0.9.0 (15-Tool) MCP 伺服器進行精確計算與帳本記錄。
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
       ┌───────────────────┬─────────────┴─────────────┬───────────────────┐
       ▼                   ▼                           ▼                   ▼
[初次持卡/登錄]    [消費試算/選卡推薦]         [官方規則/優惠調查]    [記帳/退款管理]
       │                   │                           │                   │
       ▼                   ▼                           ▼                   ▼
Onboarding SOP      Pre-flight SOP              Research SOP        Ledger SOP
(見 workflows/      (見 workflows/              (見 workflows/      (見 references/
 card-onboarding-    preflight-and-              research-and-       mcp-tools-
 and-benefit-        required-actions.md)        evidence-           v0.9.0.md)
 enrollment.md)            │                     submission.md)            │
       │                   ▼                           │                   ▼
       │            若遇商家歧義/外幣                  │           呼叫 record_
       │            轉至 merchant/fx SOP               │           transaction
       ▼                   │                           ▼           寫入帳本
呼叫 register_card         ▼                    呼叫 upsert_offer
與 upsert_user_     呼叫 recommend 輸出         提交事實快照
benefit_status      最佳推薦排序
```

### 意圖對應表 (Intent Mapping)

| 使用者意圖 | 觸發情境範例 | 導向作業程序 / 參考文件 |
|---|---|---|
| **初次持卡與方案登記** | 「我有富邦 J 卡和國泰 CUBE 卡」、「幫我設定 CUBE 卡玩數位」 | ➡️ [`workflows/card-onboarding-and-benefit-enrollment.md`](workflows/card-onboarding-and-benefit-enrollment.md) |
| **消費選卡推薦** | 「我在 momo 買 3,000 元刷哪張卡最好？」、「這筆機票要用哪張卡刷？」 | ➡️ [`workflows/preflight-and-required-actions.md`](workflows/preflight-and-required-actions.md) |
| **商家消歧義與辨識** | 「在 Uber 刷 500 元」、「高鐵 TGo 購票」 | ➡️ [`workflows/merchant-resolution-and-disambiguation.md`](workflows/merchant-resolution-and-disambiguation.md) |
| **優惠發現與完整分頁** | 「查一下這張卡的所有有效電商活動」 | ➡️ [`workflows/offer-discovery-and-pagination.md`](workflows/offer-discovery-and-pagination.md) |
| **外幣與通用支付通道** | 「去日本用 Apple Pay 刷 JCB」、「用街口/全支付跨境掃碼」 | ➡️ [`workflows/payment-route-and-fx.md`](workflows/payment-route-and-fx.md) |
| **官方優惠與權益研究** | 「查一下富邦 J 卡 2026 年最新日韓回饋」、「這張卡下半年權益有改嗎？」 | ➡️ [`workflows/research-and-evidence-submission.md`](workflows/research-and-evidence-submission.md) |
| **MCP 工具呼叫規範** | 查詢 15 項工具之標準 JSON 呼叫與參數定義 | ➡️ [`references/mcp-tool-call-playbook.md`](references/mcp-tool-call-playbook.md) |
| **卡片清冊與上限查詢** | 「我有哪些卡？」、「我這月永豐大戶外幣上限還剩多少？」 | ➡️ [`references/mcp-tools-v0.9.0.md`](references/mcp-tools-v0.9.0.md) (`list_cards`, `remaining_caps`) |
| **實際消費記帳與退款** | 「幫我記錄剛剛在 PChome 刷了 1,200 元」、「上週那筆退刷了」 | ➡️ [`examples/actual-transaction-and-refund.md`](examples/actual-transaction-and-refund.md) (`record_transaction`) |

---

## 3. 系統模組架構導覽 (Skill Module Navigation)

本 Skill 套件由以下子模組構成，代理人應依需求動態查閱：

- 📘 **架構與合約規範 (References)**
  - [`references/architecture-and-boundaries.md`](references/architecture-and-boundaries.md)：MCP 伺服器與 Agent Workspace 權責分工與資料隔離。
  - [`references/mcp-tools-v0.9.0.md`](references/mcp-tools-v0.9.0.md)：15 項公開 MCP 工具之簽名、參數規格與錯誤碼清冊。
  - [`references/mcp-tool-call-playbook.md`](references/mcp-tool-call-playbook.md)：15 項工具之標準實戰 JSON Payload 呼叫手冊。
  - [`references/lifecycle-and-privacy.md`](references/lifecycle-and-privacy.md)：實體識別碼（`mch_`, `ev_`, `fact_`, `snap_`, `tx_`）生命週期與隱私脫敏守則。

- ⚡ **標準作業流程 (Workflows)**
  - [`workflows/card-onboarding-and-benefit-enrollment.md`](workflows/card-onboarding-and-benefit-enrollment.md)：初次持卡安全登錄與動態權益設定 SOP。
  - [`workflows/preflight-and-required-actions.md`](workflows/preflight-and-required-actions.md)：Pre-flight 呼叫、歧義恢復循環與推薦輸出 SOP。
  - [`workflows/merchant-resolution-and-disambiguation.md`](workflows/merchant-resolution-and-disambiguation.md)：商家實體確定性消歧義與候選比對 SOP。
  - [`workflows/offer-discovery-and-pagination.md`](workflows/offer-discovery-and-pagination.md)：完整分頁遍歷與有界優惠發現 SOP。
  - [`workflows/research-and-evidence-submission.md`](workflows/research-and-evidence-submission.md)：官方銀行條款查核、階層化證據鏈建立與規則提交 SOP。
  - [`workflows/payment-route-and-fx.md`](workflows/payment-route-and-fx.md)：通用支付通道（`PaymentRouteContext`）判定與外幣匯率 PPM 量化 SOP。

- 📋 **模板與設定清單 (Templates)**
  - [`templates/adapter-manifest.json`](templates/adapter-manifest.json)：Local Adapter 衍生 Manifest 與元資料格式標準。
  - [`templates/user-config-checklist.md`](templates/user-config-checklist.md)：使用者個人化卡片、權益與偏好設定檢核清單。

- 💡 **完整端到端範例 (Examples)**
  - [`examples/card-onboarding-and-benefit-setup.md`](examples/card-onboarding-and-benefit-setup.md)：初次持卡登記與 CUBE 權益方案設定實例。
  - [`examples/planned-recommendation.md`](examples/planned-recommendation.md)：國內消費多卡多組件推薦實例。
  - [`examples/ambiguous-merchant-and-exhaustive-discovery.md`](examples/ambiguous-merchant-and-exhaustive-discovery.md)：商家消歧義與分頁遍歷搜尋實例。
  - [`examples/foreign-payment-route-and-fx.md`](examples/foreign-payment-route-and-fx.md)：通用跨國支付通道與匯率量化實例。
  - [`examples/merchant-ambiguity-recovery.md`](examples/merchant-ambiguity-recovery.md)：商家名稱模糊之消歧義與候選確認修復流程。
  - [`examples/stale-fx-recovery.md`](examples/stale-fx-recovery.md)：日幣外幣交易過期匯率之即時查核與快照補齊流程。
  - [`examples/no-active-offer-base-rule.md`](examples/no-active-offer-base-rule.md)：無專屬活動時自動套用一般基礎回饋之優雅回退實例。
  - [`examples/actual-transaction-and-refund.md`](examples/actual-transaction-and-refund.md)：實際刷卡記帳、上限扣減與逆向退款對沖實例。
