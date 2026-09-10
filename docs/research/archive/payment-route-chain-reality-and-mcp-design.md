# 實體支付路徑鏈、資金來源、匯率結算、回饋歸屬與 MCP 事實證據模型研究

> **文件狀態**：Lead-calibrated Research Report for Task `01a077e2-0d47-7f72-b27c-8640ead1a356`
> **調查日期**：2026-09-06（依官方最新 FAQ 校正）
> **研究依據**：嚴格遵循官方第一方公開條款、日本 PayPay 跨境支付規範、台灣各電子支付機構（街口支付、全支付、玉山 Wallet 等）最新官方 FAQ、財金資訊公司 TWQR 規格、國際卡組織清算手冊與主要發卡行信用卡權益手冊。
> **核心目標**：
> 1. 釐清「PayPay → 街口 → 信用卡」與「Taiwan Pay → 台新 Pay+ → 信用卡」等路徑於清算架構之真實機制，精準區分「直接信用卡清算軌道 (Direct Card Rail)」與「信用卡儲值電支餘額後結算 (Card-Topup Account Settlement)」。
> 2. 剖析各類資金來源（連結銀行帳戶扣款 vs. 電支帳戶儲值金 vs. 信用卡直刷/代扣 vs. 信用卡自動儲值）之發卡行回饋資格與排除差異。
> 3. 規範跨機構回饋歸屬（商家會員、錢包平台、發卡銀行）、MCC 改寫與排除、DCC（動態貨幣轉換）、海外交易手續費（1.5%）及匯率定價權責與結算時點。
> 4. 建立「中立且可擴充之支付路徑事實證據矩陣（Provider-Neutral Evidence Matrix）」，將觀察事實與 MCP 契約架構明確分離，確保未知或衝突條件嚴格 Fail-Closed。

---

## 1. 官方來源白名單與參照基準

| 機構 / 平台 / 協定 | 官方來源與規範條款 | 主要法規 / 業務範疇 | 查核日期 |
|---|---|---|:---:|
| **PayPay 株式会社 (日本)** | [支付方式](https://paypay.ne.jp/guide/payment/), [台灣合作錢包公告](https://about.paypay.ne.jp/en/pr/20230823/01/) | 日本 QR 支付方式、台灣合作錢包互通公告 | 2026-09-06 |
| **街口支付 (JKOPAY)** | [日本 PayPay FAQ](https://www.jkopay.com/application/faq), [匯率說明](https://www.jkopay.com/instructions/exchange.html) | PayPay 交易的資金來源、信用卡儲值語意、JKO 匯率 | 2026-09-06 |
| **全支付 (PXPay Plus)** | [官方服務首頁](https://www.pxpayplus.com/) | 僅作來源入口；具體資金來源須以當期官方條款逐案佐證 | 2026-09-06 |
| **玉山銀行 (E.SUN Wallet)** | [官方服務入口](https://www.esunbank.com.tw/) | 僅作來源入口；外幣帳戶／信用卡路徑須以當期官方條款逐案佐證 | 2026-09-06 |
| **財金資訊股份有限公司** | [TWQR 國家級共通 QR Code 支付標準規格書](https://www.fisc.com.tw/) | 跨機構收單標準、共通 QR Code 轉接清算 | 2026-09-06 |
| **台灣 Pay (Taiwan Pay)** | [台灣 Pay 行動支付服務條款與各行金融卡/信用卡規範](https://www.taiwanpay.com.tw/) | 財金銀行體系共通支付品牌 | 2026-09-06 |
| **台新銀行 (Richart Life / 台新 Pay+)** | [Pay+ FAQ](https://web.taishinbank.com.tw/TSB/personal/digital/E-Payment/Electronic-Payment/faq/) | PayPay 受理、帳戶／信用卡綁定、台新匯率與費用 | 2026-09-06 |
| **Visa / Mastercard / JCB** | [Visa DCC 說明](https://www.visa.com/en-us/personal/travel/dynamic-currency-conversion), [Visa 匯率工具](https://usa.visa.com/support/consumer/travel-support/exchange-rate-calculator.html) | DCC 呈現義務與匯率查詢；發卡行費率仍須逐卡查核 | 2026-09-06 |

---

## 2. 實體支付路徑真實性剖析：直接卡軌 vs. 儲值中介 vs. 共通標準

在 AI Agent 推薦與規則推論中，必須根據底層清算架構精準建模，避免將不同性質的交易路徑混為一談：

### 2.1 案例剖析一：日本 PayPay 跨境掃碼體系（街口、全支付、玉山）

```
真實清算架構剖析：
[日本商家 PayPay 收款碼/設備]
      │ (Hive / PayPay 跨境轉接協議)
      ▼
[台灣電子支付機構 App (如 街口支付 / 全支付 / 玉山 Wallet)]
      │
      ├── 街口支付 (JKOPAY)：
      │     ├─ 資金來源 A：街口帳戶餘額 / 連結銀行存款帳戶 / 台新街利存
      │     └─ 資金來源 B：綁定信用卡（底層為「信用卡儲值至電支帳戶餘額」後由電支結算；非直接卡軌）
      │
      ├── 全支付 (PXPay Plus)：
      │     ├─ 資金來源 A：全支付帳戶餘額 / 連結銀行存款帳戶
      │     └─ 資金來源 B：國泰世華銀行信用卡（專案合作通道）
      │
      └── 玉山 Wallet (E.SUN Wallet)：
            ├─ 資金來源 A：玉山銀行外幣帳戶（「日幣直接付」功能，直接扣日幣存款）
            ├─ 資金來源 B：玉山銀行臺幣存款帳戶
            └─ 資金來源 C：玉山銀行信用卡（玉山發卡行直連清算）
```

- **街口支付 (JKOPAY) 在日本 PayPay 掃碼之信用卡機制**：
  - **官方 FAQ 事實**：街口 FAQ 明載 PayPay 交易可綁定街利存、街口帳戶、銀行帳戶與街口聯名卡；選信用卡時，海外交易會先儲值至街口帳戶，再由帳戶餘額完成訂單，帳單會顯示 `JKO-Credit Card Top-up`，且不享有街口帳戶付款回饋（[官方 FAQ](https://www.jkopay.com/application/faq)）。
  - **MCP 語意**：這是一條 `credit_card_topup -> wallet_balance_debit` 的兩段式路徑，不能標成 PayPay 商家對信用卡的 direct card rail。發卡行是否給卡片回饋仍須查該卡條款；沒有證據時不得套用一般海外消費回饋。
  - **匯率事實**：街口另載 JPY 參考台新銀行即期賣出價、其他幣別參考現鈔賣出價，實際以交易當下 App 顯示為準（[官方匯率說明](https://www.jkopay.com/instructions/exchange.html)）。因此不能只用 `card_scheme` 或固定 1.5% 推算。

- **全支付與玉山 Wallet 之差異**：兩者不能由 PayPay 的合作公告推導出相同資金來源。Agent 必須分別找到當期官方 FAQ／活動／條款，將信用卡直授權、信用卡儲值、銀行帳戶與外幣帳戶拆成不同 route；找不到逐路徑證據就標為 `candidate`，不得把某一平台的結論套給另一平台。

---

### 2.2 案例剖析二：TWQR 與台灣 Pay 體系（以台新 Pay+ 為例）

```
標準架構（跨機構標準單次掃碼）：
[店家 TWQR / 台灣 Pay 共通收款碼]
      │
      ├── 消費者使用「台灣 Pay App」掃描 ───> 扣 台灣 Pay 綁定之金融卡/信用卡
      ├── 消費者使用「台新 Pay+ (Richart Life)」掃描 ───> 扣 台新銀行帳戶 / 台新信用卡
      └── 消費者使用「全支付 / 街口支付」掃描 ───> 扣 各電支帳戶 / 指定綁定卡
```

- **TWQR 共通標準特性**：
  - **TWQR** 是財金資訊公司推動的「國家級共通 QR Code 規格標準」，店家僅需一張立牌即可受理各電支與銀行錢包。
  - **台新 Pay+ 掃描 PayPay／TWQR**：官方 FAQ 顯示 Pay+ 支援綁定台新存款帳戶與台新信用卡；信用卡路徑在限額說明中明列為「信用卡儲值交易」。因此 route 應保留「Pay+ 介面／PayPay 商家受理」與「信用卡儲值或帳戶扣款」兩個事實，不能僅因畫面是在 Pay+ 就推定為一般海外刷卡。這仍是單次跨機構掃碼，不是台灣 Pay 內部再嵌套 Pay+（[台新 Pay+ FAQ](https://web.taishinbank.com.tw/TSB/personal/digital/E-Payment/Electronic-Payment/faq/)）。
  - **特店收款限制**：若店家僅向收單行開通「金融帳戶/電子支付帳戶收款」，消費者掃碼時將無法選擇信用卡扣款。

---

## 3. 資金來源類型與回饋資格矩陣 (Funding Sources & Reward Attribution)

| 資金來源代碼 (`FundingSourceType`) | 實體扣款方式 | 法規與清算路徑 | 發卡行信用卡回饋 | 電支/錢包平台回饋 | 商家會員點數 | 典型手續費結構 |
|---|---|---|:---:|:---:|:---:|:---:|
| `CREDIT_CARD_DIRECT_AUTH` | 錢包直接授權信用卡（只有在通道官方與發卡行證據均支持時才可使用） | 信用卡收單 / MCC 授權 | 依發卡行通路／排除條款 | 依錢包活動 | 依商家會員規則 | 必須查該通道與發卡行 |
| `CREDIT_CARD_TOPUP_BALANCE` | 信用卡自動儲值至電支餘額後結算（街口 PayPay FAQ 即屬此類） | 信用卡儲值電支帳戶 | 儲值回饋資格須逐卡查核；不自動視為海外消費 | 依錢包活動 | 依商家會員規則 | 依電支公告與 App 實際顯示 |
| `CREDIT_CARD_TOKENIZED` | 行動裝置感應 (Apple Pay, Google Pay) | EMVCo 代碼化信用卡通道 | 依發卡行條款 | 通常無平台點數，仍須查活動 | 依商家會員規則 | 依發卡行費率 |
| `LINKED_BANK_ACCOUNT` | 連結銀行存款帳戶直扣 (約定帳戶) | 電子支付帳戶清算 / ACH 直扣 | 不產生信用卡回饋 | 依錢包活動 | 依商家會員規則 | 依通道公告 |
| `WALLET_BALANCE_DEBIT` | 電支儲值帳戶餘額扣款 | 電子支付機構內部帳戶扣款 | 不產生信用卡回饋 | 依錢包活動 | 依商家會員規則 | 依通道公告 |
| `FOREIGN_CURRENCY_ACCOUNT` | 外幣存款帳戶直扣 | 銀行外幣帳戶清算 | 不產生信用卡回饋 | 依活動 | 依商家會員規則 | 依銀行／通道公告 |
| `TERMINAL_CASH_OR_TOPUP` | 超商/ATM 現金儲值後消費 | 現金/非授權交易 | **無** | 視活動提供 | **有** | 0% |

---

## 4. 回饋疊加層級、排除通路與 MCC 轉接模型

### 4.1 三層回饋疊加模型 (The 3-Layer Stacking Architecture)

在合規的綁定信用卡交易中，回饋金額由三方獨立決定、計算與發放：

```
┌────────────────────────────────────────────────────────────────────────┐
│ Layer 1: 商家會員權益 (Merchant Loyalty)                                 │
│   發放方：特約商店 (如 王品瘋美食 3% 瘋點數、新光三越 skm points)        │
│   上限池：由商家會員系統管轄，不佔用銀行刷卡回饋上限                    │
├────────────────────────────────────────────────────────────────────────┤
│ Layer 2: 支付錢包行銷活動 (Payment Wallet Operator Layer)               │
│   發放方：電子支付機構（活動比例與資格必須有當期官方證據）              │
│   上限池：錢包每戶每月/每筆上限，或活動總預算額滿公告截止                │
├────────────────────────────────────────────────────────────────────────┤
│ Layer 3: 發卡銀行信用卡權益 (Card Issuer Underlying Reward)              │
│   發放方：發卡銀行 (如 台新 @GoGo 指定支付 3.8%、國泰 CUBE 指定通路 3%)  │
│   上限池：發卡行帳單週期上限、卡片專屬加碼池                            │
└────────────────────────────────────────────────────────────────────────┘
```

$$R_{\text{total}} = \sum_{k \in \{\text{merchant, wallet, card}\}} \min\left(A \times r_k, \text{RemainingCap}_k\right)$$

### 4.2 特殊排除通路與 MCC 轉接特性
1. 商店、代收、公用事業、醫療、學雜費與稅捐等是否排除，必須由該發卡行與該活動條款共同證明；支付 App 不能覆寫發卡行 MCC／商戶類別。
2. 未取得發卡行條款時，MCP 回傳 `needs_review`，不把「多數銀行」當成可計算事實。

---

## 5. 外幣交易、DCC 動態貨幣轉換與匯率清算責任

### 5.1 匯率結算責任與時點 (Conversion Owner & Timing)

| 結算模式 | 匯率決定者 (Conversion Owner) | 匯率定價基準 | 結算與扣款時點 (Timing) | 1.5% 海外交易費 |
|---|---|---|---|:---:|
| **國際卡組織清算 (標準外幣消費)** | Visa / Mastercard / JCB + 發卡行 | 卡組織／發卡行條款與清算快照 | 依卡組織與發卡行時點 | 費率不可由 MCP 以 1.5% 預設，須逐卡查核 |
| **電子支付跨境掃碼 (如日本 PayPay)** | 電支業者／合作銀行 | 以該業者官方匯率頁、App 畫面與費用條款為準 | 常在交易頁或授權時顯示，但須保留實際快照 | 依業者公告；不可套用信用卡 FTF |
| **動態貨幣轉換 (DCC)** | 海外收單機構／商家 POS | 商家顯示的匯率、markup、費用與使用者選擇 | POS 當下 | DCC 的費用與發卡行跨境費必須分別查核；Visa 要求明示費用並允許拒絕（[Visa DCC](https://www.visa.com/en-us/personal/travel/dynamic-currency-conversion)） |

### 5.2 DCC (Dynamic Currency Conversion) 之危害與 Fail-Closed 防護
- **DCC 風險**：DCC 會由商家／收單端提供本幣轉換，Agent 必須保留商家顯示的匯率、markup 與費用，並確認使用者是否選擇；不能硬編 3%~5% 或 1.5%，也不能保證任一發卡行必然收取同一費率。
- **Agent 防護規範**：Agent 必須主動警示 DCC 風險，明確指示使用者選擇「當地貨幣（如 JPY、USD、EUR）」結帳。

---

## 6. 證據不足與衝突時之澄清問題 SOP (User Clarifying Protocol)

當使用者提供之交易資訊缺少關鍵支付路徑或資金來源時，Agent **嚴禁自作主張猜測匯率或臆造支援路徑**，必須依循以下最小化問題集向使用者提問：

```
┌────────────────────────────────────────────────────────────────────────┐
│ 缺少路徑事實時之標準提問流程：                                            │
│                                                                        │
│ 1.【確認錢包與操作介面】：                                             │
│    「請問您使用的是哪一個支付 App（例如：街口支付、全支付、玉山 Wallet、  │
│     LINE Pay，或是直接以實體卡/Apple Pay 刷卡）？」                     │
│                                                                        │
│ 2.【確認底層資金來源】：                                               │
│    「請問您在 App 內選擇的付款方式是：                                  │
│     (A) 直接綁定信用卡扣款                                              │
│     (B) 信用卡自動儲值至電支餘額扣款                                    │
│     (C) 連結銀行存款帳戶直接扣款                                        │
│     (D) 電子支付帳戶餘額 / 儲值金？」                                   │
│                                                                        │
│ 3.【確認結算幣別與是否跨境】（外幣/海外交易）：                          │
│    「請問結帳金額是以當地貨幣（例如日圓 JPY）計價，或是店家刷卡機有轉換為   │
│     新台幣 TWD 結帳（DCC）？」                                          │
└────────────────────────────────────────────────────────────────────────┘
```

---

## 7. 中立支付路徑事實證據矩陣 (Provider-Neutral Evidence Matrix)

### 7.1 觀察事實與證據屬性 (`EvidenceRecord`)
- `evidenceId`: `ev_<ULID>`
- `sourceUrl`: 官方公開條款或公告頁面 URL
- `sourceSnapshot`: 原文條款節錄（純文字或 Markdown）
- `contentSha256`: 原文內容之 SHA-256 雜湊值（確保不可篡改）
- `observedAt`: 查詢取得之 ISO-8601 時間戳記
- `validUntil`: 該條款官方載明之有效截止日
- `claim`: 該證據證明之具體事實
- `confidence`: 信心指標（`OFFICIAL_FIRST_PARTY` = 1.0）

### 7.2 MCP 契約設計對應（設計提案，不等於既有 runtime 欄位）

目前 MCP 仍以 `upsert_payment_route`／`list_payment_routes` 管理 route、以 `upsert_offer` 管理 reward rule；下列欄位是 route evidence 與 Agent workflow 的設計語意。任何新 provider 只新增開放字串與 evidence，不新增 PayPay 專用工具。

```typescript
/**
 * 資金來源列舉 (嚴格中立模型)
 */
export type FundingSourceType =
  | 'CREDIT_CARD_DIRECT_AUTH'     // 錢包直接授權信用卡 (如 LINE Pay, 瘋 Pay)
  | 'CREDIT_CARD_TOPUP_BALANCE'   // 信用卡自動儲值至電支餘額後結算
  | 'CREDIT_CARD_TOKENIZED'       // 裝置代碼化感應 (Apple Pay, Google Pay)
  | 'LINKED_BANK_ACCOUNT'         // 連結銀行帳戶直扣 (約定扣款)
  | 'WALLET_BALANCE_DEBIT'        // 電子支付帳戶儲值金/餘額
  | 'FOREIGN_CURRENCY_ACCOUNT'    // 銀行外幣存款帳戶直扣 (如日幣直接付)
  | 'TERMINAL_CASH_OR_TOPUP';     // 現金/終端機儲值

/**
 * 完整支付路徑情境
 */
export interface PaymentRouteContext {
  acceptanceProviderId?: string;   // 例如 paypay_qr、twqr；觀察到的商家受理網路
  consumerAppId?: string;          // 例如 jkopay、taishin_pay_plus
  interoperabilitySchemeId?: string; // 例如 hivex、twqr；有官方證據才填
  fundingSource: FundingSourceType;
  cardId?: string;                 // 若為信用卡扣款時之 Card ID
  isDccApplied?: boolean;          // 是否觸發 DCC；未知即缺 fact
  conversionOwner?: 'CARD_NETWORK' | 'WALLET_OPERATOR' | 'BANK' | 'MERCHANT_ACQUIRER' | 'UNKNOWN';
}
```

**規則綁定決策**：

- 需要精確證明「哪條 route 才適用」時，`OfferRuleVersion.routeId` 綁定 MCP-owned `route_<ULID>`；route 不存在、過期、衝突或 funding 與卡片不一致時回傳 `unknown`／`needs_review`。
- 沒有 `routeId` 的既有規則保持 generic，但只有已提供的交易 facts 能匹配；不能用 provider 名稱猜測另一條 route。
- `card_issuer` component 只有在 route terminal funding 明確為該 `credit_card` 時才可評估；`account`／`cash` 路徑不產生信用卡 issuer reward。
- 「可疊加」不是路徑拓撲的預設結論。每個 merchant／payment-provider／issuer component 都必須有自己的 rule、evidence、有效期、cap 與 combination policy；任何一層證據衝突就 fail closed。

---

## 8. 結論與後續執行規劃

1. **JKO／PayPay**：信用卡可作為街口資金來源，但官方描述是先 credit-card top-up、再以街口帳戶餘額結算；MCP 必須區分這條兩段式 route 與 direct card rail。街口帳戶付款回饋不適用於該 top-up path；發卡行回饋仍需逐卡條款證據。
2. **台新 Pay+／PayPay**：官方 FAQ 證實日本 PayPay 受理、可綁台新帳戶或台新信用卡，並且信用卡路徑被稱為信用卡儲值交易；MCP 應保存 funding path、當下匯率與費用，不把「PayPay」或「Pay+」自動轉成一般海外刷卡。
3. **新 provider 的加入**：只需由 Agent 研究官方受理、funding、FX、fee、reward 條款後，透過既有 route／offer 工具寫入開放識別碼與 evidence；只有新增計算語意時才需要 MCP contract 變更。
4. **零猜測與 Fail-Closed**：缺少 app、acceptance network、funding、交易／清算／帳單幣別、conversion owner、FX snapshot 或 reward eligibility 時，Preflight 回傳可操作 requiredActions，不進行虛構回饋計算。
5. **本研究產出**：已歸檔於 `docs/research/payment-route-chain-reality-and-mcp-design.md`；外部服務實際可用性、個別發卡行回饋與 production staging 仍需逐案驗證。
