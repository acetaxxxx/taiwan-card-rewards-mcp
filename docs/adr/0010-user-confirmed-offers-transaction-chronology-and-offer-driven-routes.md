---
status: accepted
---

# 使用者確認優惠、交易時間與優惠驅動路徑

本決策補充 ADR 0001、0003、0007、0008 與 0009。系統以可追溯性取代「只有官方來源才能啟用」的單一路徑：使用者明確確認後，可啟用只屬於該使用者的 `user_confirmed` Rule Version；它不能修改公共規則、不能假稱為官方驗證，也不能成為其他使用者的 Payment Capability。

每筆實際 Transaction 同時有 `occurredAt` 與 `recordedAt`。前者是使用者確認的交易發生時間，作為優惠、cap、FX 與旅程歷史的預設時間基礎；後者是 MCP 接受補登的稽核時間，不能取代前者。信用卡、帳戶、錢包餘額與現金均使用同一個 Transaction public surface；Reward Component 與跨事件資格以識別值附掛，而不是要求 Agent 為一般記帳選擇另一個服務。

Payment Capability 表達支付服務、受理網路與資金軌道是否能形成付款路徑；Offer Route Selector 表達特定優惠是否適用於該路徑。推薦必須將所有已知可付款方式列為候選，即使該候選沒有已知回饋；細則列出的指定支付服務清單是 Selector 的 allowlist，使用開放的 provider/app identifier，不是核心品牌 enum。推薦可以用 Selector、Capability 和使用者持有事實建立暫存 Generated Route，只有使用者專屬綁定、實際觀察、專屬條件或否決需要成為 durable Payment Route Record。

FX Snapshot 僅能在幣別與方向、conversion owner、conversion timing、rate type、provider 或 card scheme 與新鮮度窗口相容時重用。route edge、route、card 與 issuer 的精確 scope 優先；不相容或過期的報價不可被當作實際結算資料。

## Consequences

- 已核可的私有優惠需要不可變版本、確認紀錄、租戶隔離與推薦輸出的 trust basis。
- `list_transactions` 預設按 `occurredAt` 查詢，並可明確按 `recordedAt` 查詢補登歷史。
- Offer ingestion 必須將細則的支付清單與路徑條件保存為資料，不能由 Agent 依品牌名稱推測。
- ADR 0008 的事件生命週期方向被接受；其事件模型是 Transaction 的回饋關聯，不取代 Transaction 的公共記錄與查詢入口。
- 所有由本決策新增的 MCP 欄位或工具，在實作完成前不得寫成既有可用功能。
