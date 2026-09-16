# 09: Typed 補件與 stateless recommendation retry

Status: completed

**Blocked by:** 08.

**What to build:** Agent 依 action 提交 merchant、FX、transaction facts 或已有 benefit evidence，再用同一 intent 重新評估；MCP 驗證補件而不是接受 Agent 宣告完成。

## Definition of done

- [x] 每種已支援 action 都指向實際存在的 typed tool/field；不得回傳不存在的 submit tool。
- [x] Retry 帶原始 intent、typed facts 與 expected `resultVersion`，不得用任意 context 覆寫 durable ownership 或 trust state。
- [x] Merchant resolution 經 canonical validation；FX 經 pair/provider/policy/scope/direction/freshness 驗證；user facts 保留時間與 evidence scope。
- [x] 相同補件不造成 durable duplicate；矛盾補件回 conflict diagnostic 並列出受影響 candidates。
- [x] 沒有新 facts 時 action 保持穩定並要求停止無限重試；來源不可用時仍回可交付的 partial results。
- [x] 補件後重新執行完整 preflight/evaluation/ranking，不能只修改顯示值或移除 action。
- [x] Actual transaction recording 仍不接受 planned estimate、stale/reference FX 或未確認 facts。
- [x] Public MCP traces 覆蓋 merchant ambiguity、FX refresh、缺 amount、conflicting facts、stale resultVersion 與 successful retry。
