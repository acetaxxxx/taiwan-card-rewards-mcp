---
name: taiwan-card-rewards
description: "台灣信用卡消費推薦、官方權益維護與消費記帳工作流程路由 (Route Taiwan credit-card rewards requests)."
---

# 台灣信用卡消費助手 (Taiwan Card Rewards)

本技能為總入口路由器（Entry Intent Router）。請依據使用者的實際需求，載入對應的專屬任務子技能：

| 使用者意圖情境 | 載入專屬子技能 | 任務目標與主要工具 |
|---|---|---|
| **消費前比價推薦**<br>「買某東西刷哪張？」、「某通路回饋多少？」 | [`card-rewards-recommendation`](card-rewards-recommendation/SKILL.md) | 查詢最優信用卡、支付路徑與外幣試算。<br>核心工具：`recommend` |
| **卡片與權益維護**<br>「新增卡片」、「使用者糾錯回寫」、「查詢官方條款」 | [`card-rewards-evidence`](card-rewards-evidence/SKILL.md) | 建立/更新卡片與回饋規則、官方來源 Ingestion。<br>核心工具：`create_ingestion` 等 |
| **已消費記帳與對帳**<br>「剛剛刷了一筆」、「核對這期帳單扣款」 | [`card-rewards-ledger`](card-rewards-ledger/SKILL.md) | 記錄實際交易、扣抵額度與帳單對帳。<br>核心工具：`record_transaction`, `list_transactions` |

## 執行準則 (Guidelines)
1. **單一職責與漸進揭露（Scoped Context & Progressive Disclosure）**：進入子技能後，僅載入該子技能所需之流程與工具，避免一次性預先載入全量規則與例外手冊。
2. **區分預估與實際（Planned vs Actual）**：
   - 詢問「打算買」、「想去刷」等未來情境，一律走 **推薦子技能**，嚴禁在推薦階段調用記帳工具。
   - 使用者明確表達「已付款」、「刷了」才載入 **記帳子技能** 進行寫入。
