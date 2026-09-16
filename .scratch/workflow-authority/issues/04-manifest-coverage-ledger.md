# 04: 建立 Manifest 與 coverage ledger

Status: ready-for-agent

**Blocked by:** 03.

**What to build:** 將完整來源拆成具穩定 ID、類型與依賴的 semantic leaves，讓 MCP 能決定下一個工作並證明 coverage。

## Definition of done

- [ ] Manifest leaf 至少支援 `benefit` 與 `exclusion` 類型、source-local stable ID、摘要、evidence locator 與 dependency IDs。
- [ ] Manifest 為 closed schema；重複 ID、未知類型、缺依賴、自我依賴與 dependency cycle 會 fail closed 並指出路徑。
- [ ] 成功提交後進入 `processing_leaves`，MCP 以 deterministic order 回下一個可處理 leaf action。
- [ ] 每個 leaf 最終只能有 `materialized`、`ignored` 或 `superseded` disposition；ignored/superseded 必須有理由和 evidence linkage。
- [ ] Coverage 回傳總數、各 disposition 數量、pending/blocked leaf IDs 與 `complete=false`。
- [ ] 修正版 manifest 必須建立新 revision 並保留舊版稽核關係，不在原 revision 中偷偷增刪 leaf。
- [ ] Large manifest 有明確上限或分頁策略；超限回可恢復診斷，不接受部分截斷後宣稱完整。
- [ ] 整合測試涵蓋多 benefit、shared exclusion、依賴順序、cycle、duplicate 與 interrupted resume。
