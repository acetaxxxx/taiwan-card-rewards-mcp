# 範例：實際消費記帳與退款對沖 (Actual Transaction & Refund)

**情境**：
1. 使用者在 2026-09-06 於 PChome 刷國泰 CUBE 卡 NT$ 2,000，請求記帳以扣減上限。
2. 三天後因退貨辦理全額退刷，請求記錄退款以還原額度。

---

## Part A: 記錄實際消費 (`record_transaction`)

### 1. 取得使用者確認
Agent 提示：「即將為您記錄 2026-09-06 於 PChome 消費 NT$ 2,000 (國泰 CUBE 卡)，預估扣減本月上限，請確認是否記錄？」
使用者：「確認」。

### 2. 呼叫 `record_transaction`
```json
{
  "idempotencyKey": "tx_req_20260906_pchome_2000",
  "cardId": "cathay_cube",
  "amount": 2000,
  "currency": "TWD",
  "transactionDate": "2026-09-06T14:30:00+08:00",
  "merchantName": "PChome 24h購物"
}
```

**MCP 回傳**：
```json
{
  "success": true,
  "transactionId": "tx_01JXXXX009A",
  "recordedReward": 60,
  "status": "confirmed"
}
```

---

## Part B: 記錄退款對沖

### 1. 取得使用者確認
使用者：「我把 PChome 2,000 那筆退掉了，幫我記退款」。

### 2. 呼叫 `record_transaction` 帶入負數金額與關聯交易 ID
```json
{
  "idempotencyKey": "refund_req_20260909_pchome_2000",
  "cardId": "cathay_cube",
  "amount": -2000,
  "currency": "TWD",
  "transactionDate": "2026-09-09T10:00:00+08:00",
  "merchantName": "PChome 24h購物",
  "refundReferenceTxId": "tx_01JXXXX009A"
}
```

**MCP 回傳**：
```json
{
  "success": true,
  "transactionId": "tx_01JXXXX009B",
  "recordedReward": -60,
  "status": "refunded",
  "message": "已成功對沖原始交易 tx_01JXXXX009A，回饋金與上限已正確還原。"
}
```
