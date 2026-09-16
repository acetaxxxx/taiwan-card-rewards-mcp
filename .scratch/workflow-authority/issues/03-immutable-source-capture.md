# 03: 提交不可變來源與 provenance

Status: ready-for-agent

**Blocked by:** 02.

**What to build:** Agent 能針對預期 action 提交完整來源描述；MCP 驗證並保存不可變 source capture，然後產生 manifest action。

## Definition of done

- [ ] Source capture 支援官方 URL 或使用者來源描述，並保存 retrieved time、content hash、artifact reference、source type 與 submitter provenance。
- [ ] MCP 不抓取 URL、不信任 Agent 宣稱的 authority，且沿用 public/user-confirmed trust gate。
- [ ] Source hash、artifact reference 或 provenance 缺失／格式錯誤時回精確 path 與 required facts。
- [ ] 同 action 的相同提交 idempotent；不同內容提交產生 conflict，不靜默覆寫既有 source。
- [ ] 成功後原子轉為 `awaiting_manifest`，revision 增加，next action 為 `SUBMIT_MANIFEST`。
- [ ] 敏感欄位與任意本機路徑不能透過 artifact reference 寫入 durable state。
- [ ] 重新啟動後 source capture 與 next action 保持一致。
- [ ] Public MCP trace 覆蓋成功、缺欄位、hash 衝突、跨 tenant 與重試案例。
