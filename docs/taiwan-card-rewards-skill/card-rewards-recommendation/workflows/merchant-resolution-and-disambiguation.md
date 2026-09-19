# 特店消歧義與自訂特店標準作業程序 (Merchant Resolution SOP)

本標準作業程序規範 Agent 在調用 `recommend` 遇到特店名稱模糊 (`merchant_ambiguous`) 或型錄未收錄 (`merchant_not_found`) 時的標準處置步驟。

---

## 本 SOP 使用工具速查 (Scoped Tools)

| 工具 | 類型 | 本 SOP 中的用途 | 關鍵必填欄位 |
|---|:---:|---|---|
| `recommend` | read | 消歧義或補齊特店後重新調用推薦 | `merchant`（使用者選定名稱）, `expectedResultVersion` |
| `resolve_merchant` | read | 選填：在歧義時輔助查詢候選實體清單 | `query`（商家名稱字串） |

> [!NOTE]
> 詳細工具 Property 結構與 JSON 骨架，請參考 [推薦專屬工具規格](recommendation-tools-specification.md)。

---



## 1. 觸發條件 (Trigger Conditions)

| 診斷代碼 (`diagnostic.code`) | 觸發原因 | 處置主體 (`owner`) | 核心目標 |
|---|---|:---:|---|
| `merchant_ambiguous` | 輸入之特店名稱匹配到型錄中多個實體 | `user` | 向使用者澄清具體實體，避免誤套優惠 |
| `merchant_not_found` | 特店名稱未收錄於在地型錄白名單 | `agent` | 保留品牌名稱作為自訂特店，套用基礎回饋 |

---

## 2. 處置流程演算法 (Disambiguation Algorithm)

```text
SWITCH action.diagnostic.code:

    CASE "merchant_ambiguous":
        // 步驟 1：萃取候選實體清單
        candidates = action.candidateIds 或 action.diagnostic.message
        
        // 步驟 2：向使用者提問（必須給出 2~3 個具體選項）
        發問範例：
        "請問您的消費是在哪一個通路？
         1. 全家便利商店（超商門市）
         2. 全家國際餐飲（大戶屋、bb.q CHICKEN 等餐飲門市）"
        
        // 步驟 3：等待使用者選擇
        userChoice = 等待使用者回覆
        
        // 步驟 4：更新 merchant 重新調用 recommend
        recommend({
            ...原始 intent,
            merchant: userChoice,
            expectedResultVersion: response.resultVersion
        })

    CASE "merchant_not_found":
        // 步驟 1：確認特店性質
        IF (使用者提供明確品牌名稱，如「巷口阿嬤早餐店」):
            // 直接保留原品牌名稱，若已知通路則補充 channel
            recommend({
                ...原始 intent,
                merchant: 原始輸入名稱,
                channel: 已知通路 (如 'in_store' 或 'online'),
                expectedResultVersion: response.resultVersion
            })
            // 系統將自動回退至該卡片之一般消費基礎回饋
            
        ELSE IF (完全無法辨識特店名稱):
            向使用者詢問：「請問您預計消費的店家名稱或消費類別（如餐飲、機票）是什麼？」
```

---

## 3. 調用 Payload 範例

### 情境 A：消歧義後重試調用
```json
{
  "merchant": "全家便利商店",
  "amount": 150,
  "expectedResultVersion": 1
}
```

### 情境 B：未收錄自訂特店調用
```json
{
  "merchant": "台北私廚小館",
  "amount": 3500,
  "channel": "in_store",
  "expectedResultVersion": 1
}
```


---

## 4. 注意事項與防呆原則 (Guardrails)
1. **禁止捏造 ID**：不要自行猜測或發明不存在的 `canonicalId`，直接傳遞使用者確認的名稱字串。
2. **鎖定版本**：重試時務必帶入 `expectedResultVersion: response.resultVersion`，防止並行推薦狀態漂移。
3. **基礎回饋保障**：若特店未收錄，告知使用者系統已改用一般消費基礎回饋進行比價，而非直接回報無回饋。

