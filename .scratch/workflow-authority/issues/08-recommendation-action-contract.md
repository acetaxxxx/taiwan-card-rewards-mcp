# 08: 統一 Recommendation action 與診斷契約

Status: completed

**Blocked by:** 01.

**What to build:** 將現有 `recommend.requiredActions` 深化為共用 action/diagnostic vocabulary，同時保留有完整資料時的一次呼叫 fast path。

## Definition of done

- [x] `recommend` 有足夠 facts 時直接回 evaluated candidates，不建立 durable flow 或要求額外 round trip。
- [x] 缺 merchant、amount/currency、FX、eligibility、route evidence、fee 或 benefit freshness 時回穩定 action ID、owner、affected candidates、required facts、submission contract 與 completion condition。
- [x] 欄位缺失、格式無法判斷、資料衝突及 stale 各自使用可辨識 diagnostic code/path/message/retryAction。
- [x] Candidate-scoped 缺項不阻擋其他可計算候選；頂層 ready/partial/needs_input/no_match 語意維持。
- [x] Actions 以需求內容去重，不受候選第一頁限制；coverage 說明 action count 與尚未探索範圍。
- [x] `resultVersion` 綁定 intent 與所有相關 state；資料改變後舊版本會要求 restart。
- [x] Recommendation 保持 read-only、不消耗 cap、不寫 transactions、rules、FX 或 durable sessions。
- [x] Legacy input normalization、public schema、dispatcher/service parity 及現有 recommendation tests 保持通過。

