# 官方條款查核、非官方線索與證據鏈提交 SOP (Research SOP)

**文件定位**：全技能套件資料研究、來源分級、證據提取與規則提交之唯一權威標準作業程序（Canonical Research SOP）。
**核心守則**：MCP 伺服器為完全隔離的零網路環境（Zero Network）。所有外部條款搜尋、PDF/官網解析、非官方線索交叉比對與證據提取，皆由 **Agent Workspace** 負責執行。

---

## 1. 雙軌資料檢索與來源分級原則 (Dual-Track Research & Evidence Grading)

Agent 在建立卡片、權益、支付路徑或促銷規則前，必須落實**雙軌資料檢索與交叉比對機制**：

```
┌─────────────────────────────────────────────────────────────────────────┐
│                    雙軌資料檢索 (Dual-Track Research)                   │
├────────────────────────────────────┬────────────────────────────────────┤
│ 官方一手來源 (Primary Official)    │ 非官方公開線索 (Community / Secondary)│
│ • 發卡銀行官方網站與權益公告專頁   │ • PTT 信用卡板 (creditcard)         │
│ • 信用卡約定條款 / 權益手冊 PDF    │ • Dcard 信用卡板 / 理財板           │
│ • 國際卡組織 (Visa/Mastercard/JCB) │ • 卡優新聞網 CardU / Money101       │
│ • 行動支付 / 電子錢包官方服務費率  │ • iCard.AI / KOL 評測與比較文章     │
└──────────────────┬─────────────────┴──────────────────┬─────────────────┘
                   │                                    │
                   │ (官方確認事實 verified)            │ (僅作探索線索 community/secondary)
                   ▼                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│              證據交叉比對與衝突仲裁 (Cross-Validation Gate)             │
│  - 非官方資料絕對不得單獨成為 active 規則依據。                         │
│  - 必須保存來源 URL、查詢時間、內容摘要與來源等級。                     │
│  - 官方 vs 非官方衝突 ──► Fail-Closed ──► 向使用者確認或回歸官方標準。   │
└─────────────────────────────────────────────────────────────────────────┘
```

### 1.1 來源分級定義與處理原則

| 等級 | 來源類別 | 範例與管道 | 處理與入庫原則 |
|---|---|---|---|
| 🥇 **等級 1：官方權威來源**<br>(`sourceType: "official"`) | 發卡銀行官網、官方條款 PDF、國際卡組織、電子支付官方公告 | 國泰世華/富邦/台新官網、LINE Pay/街口官方費率公告、Visa/Mastercard 活動專區 | 🌟 **唯一權威依據**。經 Agent 解析並取得使用者確認後，可直接建立或啟動 `active` 規則。 |
| 🥈 **等級 2：非官方引導性線索**<br>(EvidenceRecord `sourceType: "community"` 或 `"trusted_secondary"`) | 社群論壇、回饋整理站、比較平台、部落格評測 | PTT 卡板 (creditcard)、Dcard 信用卡板、卡優新聞網 CardU、Money101、iCard.AI | ⚠️ **僅供發現線索與交叉比對**。**嚴禁單獨入庫為 active 規則**。發現線索後必須至官方一手來源尋找佐證。<br>*註：MCP 之 `OfferSourceSnapshot.sourceType` 僅接受 `"official"` 或 `"user_input"`，非官方資料經官方查證後始得以 `"official"` 提交。* |

---

## 2. 推薦查核網站與檢索關鍵字組合 (Search Directory & Keywords)

### 2.1 推薦查核管道清冊

1. **官方發卡機構**：國泰世華、台北富邦、台新、玉山、聯邦、永豐、中信、星展等銀行信用卡權益與活動專區。
2. **官方支付通道**：LINE Pay、街口支付、全支付 PXPay Plus、台灣Pay、Apple Pay、Google Pay 官方公告。
3. **非官方整理平台**：卡優新聞網 (CardU)、Money101、iCard.AI、各大理財專欄。
4. **社群討論板塊**：PTT 信用卡板 (`bbs/creditcard`)、Dcard 信用卡板、Mobile01 信用卡理財區。

### 2.2 檢索關鍵字組合範例

- **權益查核**：`[發卡行名稱] [卡片名稱] 2026 權益公告`、`[卡片名稱] 權益手冊 約定條款 PDF`
- **加碼與排除通路**：`[卡片名稱] 精選通路 加碼 排除門檻`、`[卡片名稱] 登錄 滿額 限量 期限`
- **支付通道與跨境**：`[錢包名稱] 信用卡綁定 回饋 排除通路`、`[錢包名稱] 跨境 支援銀行 條款`
- **社群交叉比對**：`[卡片名稱] PTT`、`[卡片名稱] 肉測 災情 排除`

---

## 3. 證據品質守則與衝突處理 (Quality Invariants & Conflict Handling)

### 3.1 嚴禁把搜尋摘要當成事實 (No Unverified Snippet Auto-Accept)
- 搜尋引擎摘要、AI 生成的文字片段、社群發文或部落格比較表**皆非確定事實**。
- Agent 必須檢驗原始官方條款之發布日期、生效年份（如 2026 年）與活動截止日，**嚴禁套用過期年份之舊權益**。

### 3.2 衝突與過期處理 (Conflict & Stale Policy - Fail-Closed)
- **官方與非官方衝突（例如論壇稱有 5% 但官網條款僅寫 3%）**：
  - 嚴格遵守 **Fail-Closed** 原則，標註 `NEEDS_REVIEW`。
  - 向使用者明確提示矛盾點，要求使用者確認，或引導使用者回歸官方標準。
- **條款過期（`validTo < now`）**：
  - 標註為 `stale`，引導重新檢索最新下半年度官方公告，不沿用失效規則。

### 3.3 隱私與敏感金融資料防護 (Zero Sensitive Credentials)
- 嚴禁在研究、提問或提交證據時索取或輸入卡號 (PAN)、安全碼 (CVV/CVC)、簡訊認證碼 (OTP)、網銀密碼或 Token。

---

## 4. 缺少事實時之使用者最小提問清單 (Minimum Clarification Questions)

當 Preflight 診斷提示缺少通道、匯率或持卡事實時，Agent 應提出精確的最小提問：
1. **支付管道**：「請問您是使用實體卡感應、Apple Pay/Google Pay，還是透過特定電子錢包（如 LINE Pay、街口、全支付）結帳？」
2. **扣款方式**：「該電子錢包是綁定信用卡扣款，還是從銀行帳戶/錢包餘額扣款？」
3. **幣別與 DCC**：「結帳當下刷卡機顯示的幣別是當地外幣（如 JPY）還是已換算為新台幣 (DCC)？」
4. **當日權益**：「若使用多權益卡片（如 CUBE 卡），刷卡當天 App 設定的是哪一個權益方案？」

---

## 5. 商家實體解析與規則提交 (`upsert_offer`)

在提交促銷規則前，必須先完成 **Merchant Identity Gate**：
1. 對條款中的每一個特定商家呼叫 `resolve_merchant`，取得已確認的 `merchant.canonicalId` (`mch_<ULID>`) 放入 `rule.match.merchants`。
2. 遇到 `ambiguous` 必須向使用者確認；嚴禁把 raw merchant name 寫入 active rule。
3. 若 `resolve_merchant` 回傳 `unresolved` 但官方資料充足，可在同一次 `upsert_offer` 傳入 `merchant` 物件與 `candidate` rule，由 MCP 生成 ID 並原子保存。

### `upsert_offer` 結構化 Payload 範例

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
      "channels": ["in_store"],
      "paymentMethods": ["direct_card", "apple_pay"]
    },
    "reward": {
      "kind": "percentage",
      "code": "line_points",
      "rateBps": 300,
      "roundingMode": "floor"
    },
    "capPoolRefs": ["cap_fubon_j_overseas_monthly"]
  },
  "confirmation": {
    "confirmedAt": "2026-09-06T12:05:00Z",
    "confirmedBy": "user_explicit_statement",
    "sourceReference": "https://www.fubon.com/banking/credit_card/j_card/promo.html",
    "offerPeriod": {
      "validFrom": "2026-01-01T00:00:00Z",
      "validTo": "2026-12-31T23:59:59Z"
    },
    "rewardUnit": "TWD",
    "rewardConditionsSummary": "日韓實體消費感應或Apple Pay支付",
    "capSummary": "每曆月加碼上限500點"
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
