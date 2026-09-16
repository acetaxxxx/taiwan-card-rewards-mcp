# 05: 驗證並 materialize Benefit Leaf

Status: ready-for-agent

**Blocked by:** 04.

**What to build:** 將單一 benefit leaf 的語意抽取結果轉成完整 candidate Rule Version 與相關 canonical references，但不提前進入 active offer index。

## Definition of done

- [ ] Benefit leaf 可表達 reward、period、eligibility、merchant inclusion、payment selector、limits、registration、local exclusions 與 evidence references。
- [ ] 實作重用既有 Offer Catalog／validation／canonicalization 的 Adapter，不在 flow controller 複製 rule validation。
- [ ] Merchant、route selector、cap pool、reward unit 或 evidence ambiguous 時回 structured diagnostics，leaf 保持 pending/needs_review。
- [ ] 成功 materialization 建立 candidate artifact，記錄對應 source/manifest/leaf/revision，且不會被 `search_active_offers` 或 `recommend` 使用。
- [ ] 相同 action/payload 重試不建立重複 Rule Version；不同 payload 重用 action 回 conflict。
- [ ] Local exclusion 與 benefit 的 scope 一起保存，不能只留自然語言摘要。
- [ ] 既有 `upsert_offer` 相容行為與信任邊界維持；workflow status 本身不能啟用 rule。
- [ ] 測試涵蓋完整 benefit、未知 canonical merchant、缺 cap/evidence、user-confirmed source 與 candidate invisibility。
