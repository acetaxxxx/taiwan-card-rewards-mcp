# 實體識別碼生命週期與隱私保護規範

**規範版本**：v0.9.0
**標準格式**：ULID (Universally Unique Lexicographically Sortable Identifier)

---

## 1. 實體識別碼命名空間 (Identifier Namespaces)

為確保資料全域唯一、具備時間排序性且避免 UUID 碰撞，系統採行統一的 ULID 前綴標準：

| 實體類別 | 前綴格式 | 範例 | 產生者權威 | 說明 |
|---|---|---|---|---|
| **商家實體** | `mch_<ULID>` | `mch_01JXXXX001` | MCP 伺服器 | 權威商家標準檔 ID |
| **證據檔案** | `ev_<ULID>` | `ev_01JXXXX002` | Agent Workspace / MCP | 官方條款/公告之截圖或文字證據 |
| **事實資料** | `fact_<ULID>` | `fact_01JXXXX003` | MCP 伺服器 | 經交叉查核之結構化條款事實 |
| **優惠快照** | `snap_<ULID>` | `snap_01JXXXX004` | MCP 伺服器 | 具備版本控制之優惠規則快照 |
| **交易紀錄** | `tx_<ULID>` | `tx_01JXXXX005` | MCP 伺服器 | 實際扣減或退款之帳本交易紀錄 |

---

## 2. 隱私防線與敏感資料保護 (Privacy Guardrails)

> [!CAUTION]
> **嚴格禁止傳輸與儲存支付憑據 (Zero Sensitive Credentials)**：
> 1. **禁止卡號 (PAN)**：任何工具請求皆不得包含 13~19 位真實信用卡卡號。卡片僅以使用者自訂別名（如「富邦 J 卡」）或系統產生之 `cardId` 代表。
> 2. **禁止安全驗證碼 (CVV/CVC)**：嚴禁收集、輸入或儲存背面末三碼/四碼驗證碼。
> 3. **禁止簡訊認證碼 (OTP)**：嚴禁詢問或轉發任何銀行簡訊驗證碼。
> 4. **禁止網銀帳密與 Token**：嚴禁傳輸銀行網路銀行帳號、密碼或第三方 API 私鑰。

### 敏感欄位過濾與防護機制
若 Agent 或使用者意外在參數中傳入敏感欄位，MCP 伺服器將立即觸發 `SENSITIVE_FIELD_FORBIDDEN` 錯誤並終止請求，絕不寫入磁碟或日誌。

---

## 3. 證據生命週期與狀態機 (Evidence Lifecycle)

```
  [官方資料爬取/檢索]
          │
          ▼
   [產生 ev_<ULID>]
          │
          ▼
┌───────────────────┐      驗證失敗 / 衝突
│   needs_review    │ ────────────────────────► [ rejected ]
└─────────┬─────────┘
          │ 經交叉驗證 (Primary Official Corroborated)
          ▼
┌───────────────────┐      活動過期 / 條件變更
│     verified      │ ────────────────────────► [ stale / expired ]
└───────────────────┘
```

- **needs_review**：初次由 Agent 提取之候選規則，或來自社群/第三方之線索（Lead-only）。
- **verified**：具備銀行官方網址、條款文字與生效期間佐證，已通過驗證並啟用計算。
- **stale / expired**：超過條款宣告有效截止日，Preflight 將提示 `refresh_offer`。
- **rejected**：條款存在無法調和之矛盾或經查證為不實資訊。
