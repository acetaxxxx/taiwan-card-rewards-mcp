# 官方條款查核與證據鏈提交 SOP (Research SOP)

**核心守則**：MCP 伺服器為零網路環境。所有外部條款搜尋、PDF/官網解析與證據提取，皆由 **Agent Workspace** 執行。

---

## 1. 證據來源分級與審查原則

| 等級 | 來源類型 | 處理規範 |
|---|---|---|
| **一級：官方一手來源 (Primary Official)** | 銀行官網活動頁、官方信用卡約定條款 PDF、國際組織公告、行動支付官方費率公告 | 🌟 權威來源。允許提取並轉換為 `verified` 事實 |
| **二級：引導性線索 (Lead-Only Community)** | PTT 卡版、Dcard 理財版、信用卡討論社團、KOL 評測、YouTube 影片 | ⚠️ 僅供線索。**嚴禁直接入庫**，必須找到一級官方來源佐證 |

---

## 2. 缺少事實時之使用者最小提問清單 (Minimum Clarification Questions)

當 Preflight 診斷提示缺少通道或匯率事實時，Agent 應向使用者提出精確的最小提問：
1. **支付管道**：「請問您是使用實體卡感應、Apple Pay/Google Pay，還是透過特定電子錢包（如 LINE Pay、街口、全支付）結帳？」
2. **扣款方式**：「該電子錢包是綁定信用卡扣款，還是從銀行帳戶/錢包餘額扣款？」
3. **幣別與 DCC**：「結帳當下刷卡機顯示的幣別是當地外幣（如 JPY）還是已換算為新台幣 (DCC)？」
4. **當日權益**：「若使用多權益卡片（如 CUBE 卡），刷卡當天 App 設定的是哪一個權益方案？」

---

## 3. 提交促銷規則至 MCP (`upsert_offer`)

在提交前先完成 **Merchant Identity Gate**：對條款中的每一個特定商家呼叫 `resolve_merchant`，把已確認的 `merchant.canonicalId` 放入 `rule.match.merchants`。`ambiguous` 必須向使用者確認；不要把 raw merchant name 或自行產生的 `mch_<ULID>` 寫入 active rule。

若 `resolve_merchant` 回傳 `unresolved`，但官方來源已提供足夠的商家身份資料，Agent 可在同一次 `upsert_offer` 傳入嚴格的 `merchant` 物件與 `candidate` rule。MCP 會生成 MCP-owned `mch_<ULID>`、自動把 rule 綁到該 ID，並原子寫入 merchant、snapshot 與 rule；caller 不得提供或覆寫 canonical ID。這條路徑永遠先建立 `candidate` merchant，不能直接建立 active merchant-specific rule。若來源仍不足，保留候選 rule 或改用其他已證實 selector，並向使用者補問。

Merchant gate 通過後，組裝符合 `src/mcp-contract.ts` 之規範 payload 提交：

```json
{
  "snapshot": {
    "id": "snap_01J8Y7A9B0C1D2E3F4G5H6J7K9",
    "url": "https://www.fubon.com/banking/credit_card/j_card/promo.html",
    "fetchedAt": "2026-09-06T12:00:00Z",
    "contentHash": "sha256:7f83b1657ff1fc53b92dc18148a1d65dfc2d4b1fa3d677284addd200126d9069",
    "parserVersion": "1.0.0",
    "validFrom": "2026-01-01T00:00:00Z",
    "validTo": "2026-12-31T23:59:59Z",
    "excerpt": "日本、韓國實體店家消費享加碼 3% 回饋，每曆月上限 500 點。",
    "verified": true,
    "sourceType": "official"
  },
  "rule": {
    "id": "rule_fubon_j_jp_kr_2026",
    "cardId": "fubon_j",
    "version": "2026.09.01",
    "sourceSnapshotId": "snap_01J8Y7A9B0C1D2E3F4G5H6J7K9",
    "status": "active",
    "validFrom": "2026-01-01T00:00:00Z",
    "validTo": "2026-12-31T23:59:59Z",
    "settlementCurrency": "TWD",
    "match": {
      "countries": ["JP", "KR"],
      "channels": ["direct_card", "apple_pay"]
    },
    "reward": {
      "kind": "point",
      "code": "line_points",
      "rateBps": 30000,
      "roundingMode": "floor"
    },
    "capPoolRefs": ["cap_fubon_j_overseas_monthly"]
  },
  "capPools": [
    {
      "id": "cap_fubon_j_overseas_monthly",
      "name": "富邦J卡日韓加碼每月上限",
      "metric": "reward",
      "period": "calendar_month",
      "limit": 50000,
      "currency": "TWD",
      "timezone": "Asia/Taipei"
    }
  ]
}
```
