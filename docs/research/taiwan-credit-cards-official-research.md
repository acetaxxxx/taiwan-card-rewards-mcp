# 台灣信用卡官方優惠研究

> **文件狀態**：Lead-reviewed research snapshot；不是可直接啟用的 production rule seed
> **查詢日期**：2026-08-31
> **來源邊界**：本文件只引用銀行／發卡機構第一方頁面。動態頁面可能在查詢後變更；正式匯入前仍須重新取得並保存實際 \`fetched_at\`、內容雜湊與規則版本。
> **研究目的**：為 \`taiwan-card-rewards-mcp\` 提供候選資料與待確認清單。AI agent 負責查詢、判斷來源、整理成 typed JSON；MCP 負責驗證、保存、週期／額度計算與帳本，不負責爬蟲或自然語言推薦。

## 1. 官方來源白名單

| 發卡行 | 官方頁面 | 查詢日期 | 可用期間／備註 |
|---|---|---:|---|
| 玉山銀行 | [玉山熊本熊卡](https://www.esunbank.com/zh-tw/personal/credit-card/intro/bank-card/kumamon_card) | 2026-08-31 | 日本活動頁標示 2026-07-01～2026-12-31；頁面同時包含其他活動，須按活動期間拆分 |
| 國泰世華銀行 | [CUBE 卡官方權益方案頁](https://www.cathaybk.com.tw/cathaybk/promo/event/credit-card/product/CUBE_rights/index.html) | 2026-08-31 | 頁面內容依權益期間更新；2026 固定回饋須以當期頁面／條款為準 |
| 永豐商業銀行 | [SPORT 卡官方權益頁](https://bank.sinopac.com/sinopacbt/personal/credit-card/introduction/bankcard/sportcard.html) | 2026-08-31 | 活動頁標示 2026-07-01～2026-12-31 |

研究檔案不保存信用卡號、PAN、CVV、OTP、銀行登入資訊或其他憑證。官方頁面列出的商店名稱只能作為候選條件，正式 rule 仍須保存來源版本與適用範圍。

## 2. 官方事實摘要

### 2.1 玉山熊本熊卡

[玉山官方頁](https://www.esunbank.com/zh-tw/personal/credit-card/intro/bank-card/kumamon_card) 的 2026 日本活動區段標示：

- 期間為 2026-07-01～2026-12-31。
- 日本一般消費現金回饋 2.5%，每期無上限。
- 指定日本商店最高為 8.5%，由日本一般消費 2.5% 加指定商店加碼 6% 組成；指定商店加碼為每歸戶每期上限 NT$500。
- 指定商店加碼需完成活動登錄；期間內登錄一次即可。商店須以刷卡後帳單帶出的商店名稱判定，若名稱無法辨識，可能不列入。
- 日本一般／指定商店活動均載明收取 1.5% 國外交易服務費。日圓雙幣卡的國外消費以日圓繳款，不代表免除該服務費。
- 符合活動條件的日幣消費，依帳款清算日前一營業日的玉山匯率折算新臺幣；現金回饋逐筆無條件捨去至新臺幣元。交易取消時，符合資格的回饋列入負項計算。
- 玉山頁面以每月帳單結帳日計算回饋；晚請款或假日順延可能使交易落入不同期帳單。實際結帳日是持卡人／卡片資料，不應寫死在通用規則。
- PayPay 綁定玉山 Wallet 有另行活動與例外，不能直接套用日本一般消費或指定商店規則。

**不應直接沿用的舊說法**：1%／2%／5%、日圓雙幣卡免 1.5% 手續費、7 月前版本的指定商店比例，均不能作為本研究日的 active rule。

### 2.2 國泰世華 CUBE 卡

[CUBE 官方權益頁](https://www.cathaybk.com.tw/cathaybk/promo/event/credit-card/product/CUBE_rights/index.html) 的內容具有日期與方案條件，研究時確認到：

- 一般消費基本回饋為 0.3% 小樹點（信用卡），官方頁標示無上限；但排除項目以當期官方方案與條款為準。
- 2026-08-03～2026-12-31 可切換至「固定回饋」方案一次；切換後至 2026-12-31，一般消費（不含保費）為 1.2%，海外實體消費為 2.5%。
- 其他權益方案仍有玩數位、樂饗購、趣旅行、集精選、慶生月等方案；指定通路／Level 條件與回饋率須依當期官方頁確認，不能把頁面上的舊 2024 權益分級數字視為 2026 全期規則。
- 固定回饋方案的官方說明包含分期、保費、稅費、繳費平台、便利商店、全聯、匯兌／投資平台等排除或特殊處理；排除條件應以逐版公告匯入，不能只用一個「一般消費」布林值。
- CUBE App 方案切換與資格可能有生效時間；MCP 應保存 \`active_plan\`、切換時間、資格／Level 的有效期間與來源版本。
- 小樹點的現金等值、入點與折抵方式應引用當期小樹點條款；若要換算台幣，必須明確保存 \`POINT_TREE -> TWD\` 的估值版本，而不是由 AI 猜測。

**待確認**：當期各方案完整通路表、Level 資格生效日、每月指定消費限制、海外／第三方支付認定、點數入帳與折抵細節。沒有對應版本的完整資料時，不能產生「一定享有」的計算結果。

### 2.3 永豐 SPORT 卡

[SPORT 官方權益頁](https://bank.sinopac.com/sinopacbt/personal/credit-card/introduction/bankcard/sportcard.html) 的 2026-07-01～2026-12-31活動區段標示：

- 一般消費最高 2%，指定支付／通路最高 5%。
- 基本回饋：電子化帳單在結帳日前設定完成時，國內外一般消費加碼 0.7%，合計基本最高 1%；否則為 0.3%。
- 運動獎勵與指定支付／通路加碼須註冊大咖 DACARD、串接運動數據；消費當月須達 10,000 大卡，或 Apple Watch 圓滿畫圈至少 10 次，且在規定時間前完成永豐／京城帳戶自動扣繳設定。
- 回饋計算期間是每月 1 日至月底，回饋明細於次次月第一個工作日查詢。
- 指定支付／通路加碼為 +3%，運動獎勵為 +1%；符合基本 1% 時可形成最高 5%。官方列有 Apple Pay、Google Pay、Samsung Pay、Garmin Pay、指定健身／醫藥保健／電競娛樂通路及細部帳單認定。
- 國外消費定義為特約商店或收單機構登記地非臺灣且交易非新臺幣；分期交易不享基本、運動及指定支付／通路回饋。
- 豐點設定折抵信用卡帳單時，官方頁標示 1 豐點 = NT$1，且每 100 豐點為折抵單位；未設定折抵時另有 20 點紅利換 1 豐點的處理，不能只以一個固定現金值表示。

**未納入 active rule 的項目**：本次官方 SPORT 產品頁可確認比例、條件與週期，但未在可讀內容中確認先前報告所寫的「運動 50 點／指定通路 300 點」現行上限。因此這兩個上限保留 \`needs_confirmation\`，不能匯入計算。

## 3. 研究結論與產品規格對齊

### 3.1 公開資料與 MCP 的責任分界

1. AI agent 以官方來源為優先，查閱銀行頁面／條款，判斷活動是否仍有效。
2. AI agent 將事實編譯成 typed JSON rule；MCP 只做結構驗證、保存與 deterministic evaluation。
3. MCP 不爬網頁、不把搜尋摘要直接當 rule、不做「哪張卡最好」的語意判斷。
4. MCP 可以提供明確欄位排序，例如現金等值、回饋率、剩餘額度，但最終推薦與自然語言解釋由 AI agent 負責。
5. 來源過期、條件缺漏、規則互斥或匯率過期時，MCP 回傳 \`stale\`／\`unknown\`／\`needs_confirmation\`，不猜測、不產生部分可信的 active 結果。

### 3.2 週期、額度與交易時間

- 卡片模型需保存 \`cycle_type\`（至少 \`CALENDAR_MONTH\`、\`BILLING_CYCLE\`、\`QUARTER\`、\`YEAR\`、\`CUSTOM\`）、時區、結帳／帳單日、有效起日與規則版本。
- 交易需分開保存 \`occurred_at\`、\`posted_at\`、\`settled_at\`；規則應明確指定使用哪個時間欄位。
- 新週期以區間聚合重新計算剩餘額度，舊週期保留。沒有明示 carry-over 的規則不得自動結轉。
- 回饋上限應以最小貨幣單位保存；不要用 SQLite \`REAL\`、JavaScript 浮點數或模糊的「刷卡金額上限」取代真正 cap ledger。
- 退款應關聯原交易並以反向流水沖銷，保留原規則版本、週期與計算軌跡。

### 3.3 多幣別、匯率與點數估值

銀行的匯率、結算日、海外服務費與回饋計算基準可能不同；1.5% 不得寫成「所有銀行的法定固定費率」。MCP 應保存：

- 原始金額／幣別、結算金額／幣別、回饋幣別與海外交易費的幣別。
- \`provider\`、來源 URL、\`fetched_at\`、\`effective_at\`、適用卡／發卡行、匯率方向與精度。
- 點數原生數量與台幣估值分開；只有有明確估值規則時才產生現金等值。使用者自訂估值要與官方折抵價值分開。
- 產品預設可接受七日內匯率，但這是 MCP freshness policy，不是銀行官方事實。超過 TTL 仍可回傳快照供檢視，但須標記 \`stale_fx_rate\` 並要求 AI agent 重新查詢；若使用 default FX，必須明示 \`is_default=true\`。

## 4. Candidate DSL 映射（非 active 規則）

以下僅示範 AI agent 應送入 MCP 的形狀；數值與條件在來源版本、使用者狀態與待確認項目完成前不得啟用。

\`\`\`json
{
  "card_id": "esun-kumamon",
  "rule_version": "2026-07-01-esun-kumamon-research",
  "status": "candidate",
  "effective": {
    "start": "2026-07-01",
    "end": "2026-12-31",
    "timezone": "Asia/Taipei"
  },
  "source": {
    "url": "https://www.esunbank.com/zh-tw/personal/credit-card/intro/bank-card/kumamon_card",
    "fetched_at": "2026-08-31",
    "review_on": "2026-09-07"
  },
  "cycle": {
    "type": "BILLING_CYCLE",
    "anchor": "cardholder_statement_closing_day"
  },
  "tiers": [
    {
      "tier_id": "jp-general",
      "rate_bps": 250,
      "reward_currency": "TWD",
      "predicate": {
        "op": "AND",
        "rules": [
          { "field": "transaction.merchant_country", "op": "EQUALS", "value": "JP" },
          { "field": "transaction.posted_merchant_country", "op": "EQUALS", "value": "JP" }
        ]
      },
      "cap": null,
      "requires": ["source_verified"]
    },
    {
      "tier_id": "jp-designated-store-bonus",
      "rate_bps": 600,
      "reward_currency": "TWD",
      "predicate": {
        "op": "AND",
        "rules": [
          { "field": "transaction.issuer_statement_merchant", "op": "MATCH_ALLOWLIST", "value": "source_defined_store_names" },
          { "field": "user.enrollment.esun_kumamon_2026_japan", "op": "EQUALS", "value": true }
        ]
      },
      "cap": {
        "amount_minor": 50000,
        "currency": "TWD",
        "period": "BILLING_CYCLE",
        "scope": "ACCOUNT"
      },
      "requires": ["source_verified", "user_confirmation"]
    }
  ]
}
\`\`\`

- \`MATCH_ALLOWLIST\`、\`FX_CONVERT\`、\`POINT_VALUE\`、\`ROUND_FLOOR\` 等算子應由 MCP operator registry 明確支援；不支援的算子回傳錯誤，不得靜默略過。
- 回饋計算應以整數 minor units／basis points 及明確捨入規則執行。
- CUBE 的方案切換、SPORT 的 DACARD／運動達標／自動扣繳，以及任何登錄活動，都應成為結構化 eligibility state，而不是藏在自然語言描述中。
- 若規則包含銀行頁面未確認的 cap、排除、入帳或匯率條件，狀態維持 \`candidate\` 或 \`needs_review\`。

## 5. 待確認清單

| 項目 | 原因 | 允許行為 |
|---|---|---|
| SPORT 運動／指定通路現行回饋上限 | 產品頁可讀內容未確認舊報告的 50／300 點數字 | 不匯入 cap；由 agent 查官方細則後再送版 |
| CUBE 當期方案完整通路與 Level 表 | 官方頁按期間、方案與資格變動 | 只保存已驗證的日期範圍與條件 |
| 各卡帳單日、入帳／請款／結算時間 | 多數是卡片或交易個別資料 | 向使用者／來源詢問；不可猜測 |
| 海外服務費與匯率基準 | 發卡行、卡別、幣別可能不同 | 保存卡別／provider scope 的 FX snapshot |
| 使用者是否登錄、切換方案、達成運動條件 | 不是公開頁面可推導的個人事實 | 由 AI agent 詢問 user，MCP 保存狀態與時間 |
| 點數是否可按 1:1 當現金 | 點數折抵、轉換、到期可能不同 | 保存 native points；有明確估值才換算 TWD |

## 6. 後續匯入門檻

一份規則只有在以下條件全數滿足後，才可由 \`candidate\` 轉為 \`active\`：

- 有可直接追溯的官方 URL、實際抓取日期、有效期間與 rule version。
- Schema、算子、幣別、週期、捨入、cap scope 與排除條件均可驗證。
- 需要使用者確認的登錄／方案／自動扣繳／達標狀態已具備時間戳。
- 沒有未解決的互斥 active rule、過期來源或 unknown operand。
- MCP 能產出 explain trace：命中的 tier、未命中的條件、規則版本、週期、cap 使用量、FX snapshot、費用、native reward 與估值。

本研究文件不建立 production active rule，也不取代銀行最新公告。
