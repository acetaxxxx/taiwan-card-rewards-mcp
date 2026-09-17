# 10: Recommendation 與 Ingestion 的 refresh handoff

Status: completed

**Blocked by:** 07, 09.

**What to build:** Recommendation 發現優惠資料過期或缺漏時，可建立或連結 child ingestion；完成後以最新 canonical state 重新評估原始 intent。

## Definition of done

- [x] `REFRESH_BENEFIT` action 明確包含待更新 source/rule family、原因、freshness 要求與建立 ingestion 的提交契約。
- [x] 建立 child ingestion 後保存 parent continuation 的 intent fingerprint、parent resultVersion 與 child flow ID；不保存舊排名為真相。
- [x] 相同 refresh requirement 重試只建立或連結同一未完成 child flow，不產生重複 ingestion。
- [x] Child complete 前 parent 維持 partial/needs_input；failed/cancelled/needs_review 有明確可交付狀態和理由。
- [x] Child completion 後 recommendation 從目前 store 重新 discovery、evaluation、FX/cap/freshness validation 與 ranking。
- [x] Relevant state 已變更時舊 continuation 要求 restart；不把舊 `resultVersion` 強行接到新資料。
- [x] 跨 tenant flow、不同 source/rule family 或未授權 continuation 不能互相連結。
- [x] E2E 覆蓋 stale benefit → ingestion → manifest/leaves/finalize → resumed recommendation，以及 child failure/no-change 分支。
