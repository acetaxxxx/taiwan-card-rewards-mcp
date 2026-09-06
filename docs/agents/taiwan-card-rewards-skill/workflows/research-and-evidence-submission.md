# 官方優惠查核與證據鏈提交 SOP (Research SOP)

**核心守則**：MCP 伺服器不具備網路連線。所有外部規則的蒐集、官方查證與證據物件組裝，皆由 **Agent Workspace** 負責執行。

---

## 1. 證據來源分級原則 (Evidence Hierarchy)

| 來源等級 | 允許來源 | 權威度 | 處理原則 |
|---|---|---|---|
| **第一級：官方一手來源 (Primary Official)** | 銀行官方網站、信用卡活動專頁、官方信用卡約定條款 PDF、國際發卡組織公告、行動支付官方公告 | 🌟 權威來源 | 允許直接提取並轉換為 `verified` 事實 |
| **第二級：引導性線索 (Lead-Only Community)** | PTT 卡版、Dcard 理財版、信用卡討論區、KOL 評測部落格、YouTube 影片 | ⚠️ 僅供線索 | **嚴禁直接入庫**。僅能作為搜尋關鍵字線索，必須找到第一級官方來源佐證後方可提交 |

---

## 2. 條款核心維度擷取清單 (Attribute Extraction Checklist)

在解析官方條款時，Agent 必須精確擷取以下結構化維度：

1. **活動有效期間**：開始日期 (`validFrom`)、結束日期 (`validTo`)。
2. **回饋比率與基數**：基礎比率（如 1%）、加碼比率（如 2%）、回饋幣別/點數類型（如現金回饋、小樹點、LINE POINTS）。
3. **計算與進位規則**：四捨五入 (`round`)、無條件捨去 (`floor`)、無條件進位 (`ceil`)，步進值（如每滿 100 元計一次）。
4. **上限池設定 (Cap Pool)**：
   - 週期類型：每期帳單 (`billing_cycle`)、每月曆月 (`calendar_month`)、活動全期 (`campaign_total`)。
   - 上限金額：例如每月上限 300 點。
5. **疊加模式 (Stacking Policy)**：
   - `additive` (累加)
   - `replace` (覆蓋/取代)
   - `best_of` (擇優)
   - `exclusive` (互斥)
   - `prerequisite` (需滿足前置條件)
6. **先決條件與門檻 (Prerequisites)**：是否需登錄、是否需綁定電子帳單、是否有低消門檻（如單筆滿 1,000 元）。

---

## 3. 提交至 MCP (`upsert_offer`)

將查核完成之資料組裝為標準格式提交：

```json
{
  "cardId": "fubon_j_card",
  "offer": {
    "offerName": "2026 日韓實體消費加碼 3%",
    "validFrom": "2026-01-01T00:00:00+08:00",
    "validTo": "2026-12-31T23:59:59+08:00",
    "stackingPolicy": "additive",
    "components": [
      {
        "componentName": "日韓實體加碼",
        "ratePpm": 30000,
        "capPoolRef": "cap_fubon_j_overseas_monthly",
        "rounding": "floor"
      }
    ],
    "evidence": {
      "sourceUrl": "https://www.fubon.com/banking/credit_card/j_card/promo.html",
      "extractedAt": "2026-09-06T12:00:00Z",
      "excerpt": "日本、韓國實體店家消費享加碼 3% 回饋，每曆月上限 500 點。"
    }
  }
}
```
