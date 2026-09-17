Credit Card MCP Flow Architecture

1. 核心設計

Credit Card MCP 不只是一個資料庫，也不應把完整工作流程交給 Agent 自己控制。

核心原則：

MCP 是 workflow authority。
Agent 是 semantic worker。

也就是：

MCP 決定下一步
      ↓
Agent 執行需要理解外部世界的工作
      ↓
Agent 回傳結果
      ↓
MCP 驗證、保存或計算
      ↓
MCP 決定下一步

目前主要有兩種 flow：

Ingestion Flow
Recommendation Flow

兩者共用：

Flow Control
Schema Contract
Research Skill
Canonical Data

⸻

2. Responsibility Boundary

Agent / Skill

負責：

搜尋官方來源
讀懂自然語言
辨識優惠內容
判斷 exclusion scope
merchant semantic resolution
取得外部動態資料
提供 evidence

例如：

這裡的「Donki」指的是 Don Quijote
這條「全聯不適用」
是套用在 LINE Pay 3% 優惠
目前 Visa JPY/TWD 匯率是多少

⸻

MCP

負責：

Flow Control
Schema
Validation
Canonicalization
Persistence
Versioning
Freshness
Exclusion Evaluation
Reward Calculation
Coverage
Completion

MCP 不應依賴 Agent 自己判斷：

「我應該做完了吧」

而是 MCP 明確知道流程是否完成。

⸻

3. Shared Flow Control

兩種 flow 都遵守同一個模式：

Request
   ↓
MCP Preflight
   ↓
Can complete now?
   │
   ├─ Yes → Execute → Complete
   │
   └─ No
        ↓
   get_next_action
        ↓
   Agent executes
        ↓
   submit result
        ↓
   MCP re-evaluates
        ↓
       loop

Agent 不自己管理 Phase。

Agent 的核心行為：

1. 取得 next action
2. 只執行該 action
3. Submit result
4. 再取得 next action
5. 直到 MCP 回傳 COMPLETE

⸻

4. Ingestion Flow

4.1 目的

把一份官方來源完整轉換成可運算的信用卡規則。

一次 ingestion 的 logical unit 是：

一份完整官方來源

不是：

一批 merchant

⸻

4.2 Flow

Create Ingestion
      ↓
Capture Source
      ↓
Discover Manifest
      ↓
Process Leaf
      ↓
Process Leaf
      ↓
...
      ↓
Finalize
      ↓
Complete

⸻

4.3 Source

保留完整原始來源：

source URL
retrieved time
content hash
artifact reference

後續所有 rule 與 evidence 都必須能追溯到來源。

⸻

4.4 Manifest

Agent 先盤點完整來源有哪些 semantic units。

例如：

L001 玩數位 3%
L002 趣旅行 3%
L003 慶生月餐廳 10%
L004 指定飯店 5%
L005 活動共同排除條款

Manifest 的目的：

建立 coverage boundary。

此階段不建立正式 rule。

⸻

4.5 Benefit Leaf

Benefit Leaf 可以包含：

reward
period
eligibility
merchant inclusion
payment method
limits
registration
exclusions
evidence

例如：

{
  "leafId": "L003",
  "reward": {
    "type": "cashback",
    "rate": 0.03
  },
  "paymentMethods": ["LINE_PAY"],
  "exclusions": [
    {
      "type": "merchant",
      "merchantName": "全聯福利中心"
    }
  ]
}

⸻

4.6 Exclusion

Exclusion 一定要包含：

type
target
scope
evidence

例如：

排除全聯福利中心

不能只保存文字。

應表達：

type = merchant
target = 全聯福利中心
scope = benefit

Local exclusion

只影響單一 benefit：

Benefit Leaf
└─ exclusions[]

Shared exclusion

套用多個 benefit：

Exclusion Leaf
scope = source

例如：

本活動不適用：
- 全聯
- 保費
- 繳稅

⸻

4.7 Completion

完成不是：

新增 282 個 merchants

而是：

Manifest 中所有 leaves
都有明確處理結果

例如：

materialized
ignored
superseded

只有全部 accounted for，MCP 才能回：

complete = true

⸻

5. Recommendation Flow

5.1 目的

根據實際 transaction context，判斷使用者目前應使用哪種付款方式或信用卡。

例如：

日本 Donki
50,000 JPY

⸻

5.2 Fast Path

Recommendation 不需要每次都進入長流程。

如果 MCP 已具備：

canonical merchant
transaction context
user cards
current benefits
FX
fees
reward limits
usage state

則：

Preflight
   ↓
Evaluate
   ↓
Complete

直接計算。

⸻

5.3 Controlled Path

如果缺資料：

Recommendation Request
        ↓
     Preflight
        ↓
 Missing Requirement
        ↓
 get_next_action
        ↓
 Agent obtains data
        ↓
 submit result
        ↓
 Preflight again

直到 MCP 有足夠資料計算。

⸻

6. Recommendation Actions

常見 action 可以包含：

RESOLVE_MERCHANT
FETCH_FX
REFRESH_BENEFIT
RESOLVE_PAYMENT_METHOD
REQUEST_TRANSACTION_CONTEXT
EVALUATE
COMPLETE

例如：

{
  "action": "FETCH_FX",
  "requirement": {
    "provider": "VISA",
    "from": "JPY",
    "to": "TWD"
  }
}

Agent 取得資料後 submit，Recommendation Flow 再繼續。

⸻

7. Freshness

MCP 必須知道資料是否仍可使用。

例如：

FX expired
Benefit expired
Source stale

此時 Recommendation Flow 不應偷偷使用舊資料。

而是產生 action：

FETCH_FX
REFRESH_BENEFIT

Agent Research Skill 負責取得最新資料。

⸻

8. Recommendation → Ingestion

如果 Recommendation 發現優惠資料需要更新：

Recommendation
      ↓
REFRESH_BENEFIT
      ↓
Ingestion Flow
      ↓
更新 Structured Rules
      ↓
返回 Recommendation
      ↓
Evaluate

因此兩個 Flow 不應互相獨立。

Recommendation 可以觸發 Ingestion。

⸻

9. Deterministic Evaluation

Recommendation 最終計算由 MCP 負責。

不要讓 Agent 自己做主要 reward calculation。

MCP 評估：

merchant match
payment method
country
currency
eligibility
reward
limits
usage state
exclusions
FX
foreign transaction fee

例如：

LINE Pay 3%
merchant = 全聯
payment method = LINE Pay
payment method match ✓
merchant exclusion match ✓
→ Benefit not applicable

⸻

10. Schema Contract

Schema ownership 在 MCP。

Skill 不應複製完整 schema。

Agent 透過：

MCP Tool Schema
+
get_next_action

知道要提交什麼。

例如：

{
  "action": "PROCESS_LEAF",
  "leafId": "L003",
  "submitTool": "submit_benefit_leaf"
}

或：

{
  "action": "FETCH_FX",
  "submitTool": "submit_fx_quote"
}

這樣 schema 只有一份 source of truth。

⸻

11. Agent Skill

Skill 主要負責三件事情：

Research SOP

定義資料來源優先序：

官方銀行
官方活動頁
官方條款 / PDF
其他來源補充

⸻

Flow Rule

Agent 必須：

Always follow MCP next action.
Do not skip steps.
Do not invent completion.
Do not bypass ingestion flow.

⸻

Semantic Extraction

告訴 Agent 怎麼理解：

benefit
merchant
eligibility
exclusion
scope
payment method
reward limit
evidence

但不在 Skill 裡重複 MCP schema。

⸻

12. MCP Tool Surface

Ingestion

create_ingestion
get_next_action
submit_source
submit_manifest
submit_benefit_leaf
submit_exclusion_leaf
finalize_ingestion

Recommendation

概念上：

recommend
get_next_action
submit_requirement_result

動態資料可以有 typed tools，例如：

submit_fx_quote
submit_merchant_resolution
submit_benefit_refresh

實際 API 可以再依現有 MCP schema 收斂。

⸻

13. Overall Architecture

               User / Agent
                    │
                    ▼
              Research Skill
                    │
                    ▼
            ┌───────────────┐
            │ Flow Controller│
            └───────┬───────┘
                    │
        ┌───────────┴───────────┐
        │                       │
        ▼                       ▼
 Ingestion Flow        Recommendation Flow
        │                       │
 Source / Manifest          Preflight
        │                       │
 Process Leaves          Missing Requirement
        │                       │
 Validate Rules          Agent Research
        │                       │
        ▼                       │
   Canonical Data ◄─────────────┘
        │
        ▼
 Evaluation Engine
        │
        ▼
 Recommendation

⸻

14. 核心原則

整個架構可以收斂成六點：

1. MCP Controls the Flow

Agent 不自己管理完整 workflow。

2. Agent Understands the World

搜尋、閱讀、語意判斷交給 Agent。

3. Schema Lives in MCP

資料格式不要散落在 Skill 與 Prompt。

4. Canonical Data Lives in MCP

merchant、rule、evidence、version 都由 MCP 管理。

5. Calculation Is Deterministic

最終 eligibility 與 reward evaluation 由 MCP 執行。

6. Missing Knowledge Becomes an Action

遇到不知道的事情，不要讓 Agent 自己偷偷補齊。

MCP 明確回：

下一步缺什麼

Agent 再負責取得。

7. Durable Drafts Have Bounded Lifetime

Ingestion draft 讓 Agent 中斷後可恢復，但 MCP 以 owner 與 normalized source scope 去重，避免同一來源累積多個未完成流程。Draft 逾期後進入 `expired`，清理 incomplete candidate artifacts 與未參照 payload，保留最小 audit tombstone；active rules、completed evidence 與歷史交易不可被清理。

此限制不是「全系統一次只能註冊一張卡」。一份官方來源可涵蓋多個產品，Held Card 註冊與 benefit ingestion 是不同責任；只限制同一 owner 的同一來源／目標範圍不能同時有多個 active draft。

最終 interaction model：

Agent:
「我要推薦這筆交易。」
MCP:
「缺 Visa JPY 匯率。」
Agent:
「這是官方最新匯率。」
MCP:
「優惠資料過期，需要更新。」
Agent:
「已完成新的官方來源 ingestion。」
MCP:
「資料完整，可以計算。」
→ Recommendation

這就是整個 Credit Card MCP 的 Flow Control 核心。
