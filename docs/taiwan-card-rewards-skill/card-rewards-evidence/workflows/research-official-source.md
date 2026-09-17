# 官方條款研究與優惠規則提交 SOP (Official Source Research & Offer SOP)

本 SOP 規範 Agent 如何針對信用卡優惠進行雙軌公開資料檢索、官方條款查核，以及在規則單純時透過快速路徑 (`upsert_offer`) 建立或更新優惠。若需要完整官方溯源與覆蓋範圍追蹤（包含葉節點與依賴關係），請改走 [Ingestion 完整作業流程](ingestion-action-loop.md)。

---

## 本 SOP 使用工具速查 (Scoped Tools)

| 工具 | 類型 | 本 SOP 中的用途 | 關鍵必填欄位 |
|---|:---:|---|---|
| `resolve_merchant` | read | 查詢特店之唯一權威 ID (`canonicalId`) | `query` (商家名稱) |
| `upsert_offer` | write | 快速路徑：直接寫入官方來源快照與優惠規則 | `snapshot.{id, url, fetchedAt, contentHash, sourceType}`, `rule.{id, cardId, version, match, reward}` |

---

## 1. 觸發條件 (Trigger Conditions)

- 使用者詢問「XX 卡的最新優惠是什麼？」並需要主動查詢。
- `recommend` 回傳之候選卡片狀態為 `stale` 或 `needs_review`，提示權益已過期。
- 使用者提出卡片權益勘誤，需至官網核實最新條款。

---

## 2. 雙軌資料研究演算法 (Dual-Track Research Algorithm)

```text
// 步驟 1：非官方公開線索探索（發現線索）
keywords = "[發卡行名稱] [卡片名稱] 2026 優惠 權益"
檢索來源: PTT 信用卡板、Dcard 信用卡板、CardU 卡優新聞網、Money101、iCard.AI
記錄探索線索（URL, 摘要, 查詢時間）
注意: 社群資料僅作探索線索，嚴禁直接以此建立 active 規則

// 步驟 2：官方一手來源查核（建立事實）
依據線索前往發卡行官網、官方 PDF 條款、國際卡組織活動頁面
檢查: 來源發布日期、生效期間、截止日是否仍在有效期內
錄取: 官方 URL、頁面快照時間 (retrievedAt)、條款摘要 (excerpt)

// 步驟 3：交叉比對與衝突仲裁
IF 社群線索與官方來源一致:
    提取為 verified 官方快照
IF 社群線索與官方來源衝突:
    遵守 Fail-Closed 原則，向使用者說明矛盾點，一律回歸官方標準
IF 官方條款已過期 (validTo < now):
    告知使用者條款已過期，重新檢索最新公告，不沿用失效規則
```

---

## 3. 快速路徑：`upsert_offer` 規則提交

適用於條款結構單純、不需要 Ingestion Manifest 葉節點依賴追蹤的情境。

### 3.1 特店實體解析 (Merchant Identity Gate)

```text
FOR EACH 條款中指定之特定特店:
    resolve_merchant({ query: 商家名稱 })
    SWITCH response.status:
        CASE "resolved":
            使用 response.canonicalId (mch_<ULID>) 填入 rule.match.merchants
        CASE "ambiguous":
            向使用者確認具體店家實體，嚴禁把原始未消歧義名稱寫入 active rule
        CASE "unresolved":
            若官方條款明確載明新店家，可在同一次 upsert_offer 傳入 merchant candidate 物件
```

### 3.2 `upsert_offer` 標準 Payload 範例

```json
{
  "snapshot": {
    "id": "snap_01J8Y7A9B0C1D2E3F4G5H6J7K9",
    "url": "https://www.taishinbank.com.tw/TSB/personal/credit/gogo-offer/",
    "fetchedAt": "2026-09-17T05:10:00Z",
    "contentHash": "sha256:7f83b1657ff1fc53b92dc18148a1d65dfc2d4b1fa3d677284addd200126d9069",
    "parserVersion": "1.0.0",
    "validFrom": "2026-01-01T00:00:00Z",
    "validTo": "2026-12-31T23:59:59Z",
    "excerpt": "精選網購加碼 3.3%，需綁定 Richart 自動扣繳，每期帳單上限 1,000 點。",
    "verified": true,
    "sourceType": "official"
  },
  "rule": {
    "id": "rule_taishin_gogo_online_2026",
    "cardId": "taishin_gogo",
    "version": "2026.09.01",
    "sourceSnapshotId": "snap_01J8Y7A9B0C1D2E3F4G5H6J7K9",
    "status": "active",
    "validFrom": "2026-01-01T00:00:00Z",
    "validTo": "2026-12-31T23:59:59Z",
    "settlementCurrency": "TWD",
    "match": {
      "merchants": ["mch_01J8Y7A9B0C1D2E3F4G5H6J7K8"],
      "countries": ["TW"],
      "channels": ["online"],
      "paymentMethods": ["direct_card"]
    },
    "reward": {
      "kind": "percentage",
      "code": "taishin_point",
      "rateBps": 330,
      "roundingMode": "floor"
    },
    "capPoolRefs": ["cap_taishin_gogo_monthly_online"]
  },
  "capPools": [
    {
      "id": "cap_taishin_gogo_monthly_online",
      "name": "GoGo卡精選通路每期帳單加碼上限",
      "metric": "reward",
      "period": "billing_cycle",
      "limit": 100000,
      "currency": "TWD",
      "timezone": "Asia/Taipei"
    }
  ]
}
```

---

## 4. 異常處理與防呆守則

- 若提交時回傳缺失事實或衝突，查閱通用手冊 [缺失事實與診斷代碼處置手冊](../../references/required-actions-and-diagnostics.md)。
- **搜尋摘要非事實**：必須檢驗原始官方條款與生效年份（如 2026 年）。
- **零敏感憑證**：嚴禁在任何欄位填入完整卡號、密碼或驗證碼。
