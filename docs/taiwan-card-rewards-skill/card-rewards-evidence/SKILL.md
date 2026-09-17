---
name: card-rewards-evidence
description: Research official Taiwan card-rewards terms and register cards, payment accounts, routes, or offers with traceable non-sensitive evidence.
---

# 信用卡資料研究與權益登錄 (Card Rewards Evidence)

本技能處理所有與**卡片登錄、官方條款研究、規則建立、以及外幣特殊匯率登錄**相關的任務。

> [!CAUTION]
> **零敏感憑證原則 (Zero Sensitive Credentials)**：嚴禁在任何工具呼叫或對話中索取或傳輸完整卡號 (PAN)、安全碼 (CVV/CVC)、簡訊認證碼 (OTP)、網銀帳密或 Token。違反本原則時立即中止並告知使用者。

---

## 意圖分流 (Intent Router)

根據使用者意圖或任務需求，選擇對應的標準作業程序：

```text
SWITCH 使用者意圖:

    CASE "告知持卡" | "登錄新卡" | "設定權益方案" | "切換方案":
        → 進入 [卡片登錄與權益設定 SOP](workflows/card-onboarding-and-benefit-enrollment.md)
        使用工具: register_card, list_cards, upsert_user_benefit_status

    CASE "查詢最新優惠" | "驗證卡片規則" | "建立官方來源 ingestion" | "更新條款":
        → 進入 [官方來源研究與 Ingestion SOP](workflows/research-source-and-ingestion.md)
        使用工具: create_ingestion, get_ingestion, submit_ingestion_source,
                  submit_ingestion_manifest, submit_benefit_leaf,
                  submit_exclusion_leaf, finalize_ingestion, upsert_offer,
                  resolve_merchant

    CASE "記錄支付路徑的特殊外幣匯率" | "為某個支付方式登錄匯率查詢來源":
        → 進入 [外幣特殊匯率登錄 SOP](workflows/fx-rate-ingestion.md)
        使用工具: upsert_payment_route, upsert_payment_capability,
                  register_payment_account
```

---

## 共用守則 (Shared Invariants)

- **MCP 零直接網路 I/O**：MCP 伺服器不自行爬取 URL 或驗證外部網站。所有官方來源查詢、頁面快照、PDF 解析，均由 Agent Workspace 負責。
- **Fail-Closed 原則**：遇到來源衝突、過期條款、或缺少確認事實時，一律保持 `needs_review` 狀態，並向使用者澄清，嚴禁以猜測激活規則。
- **嚴禁重送過期 Action**：在 Ingestion flow 中，Action 過期後必須先呼叫 `get_ingestion` 取得最新 action，禁止重送舊 `actionId`。

