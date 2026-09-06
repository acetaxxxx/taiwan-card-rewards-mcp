# 優惠發現與分頁遍歷工作流程 (Offer Discovery & Pagination SOP)

本工作流程規範 Agent 在檢索有效優惠促銷時，如何正確進行**完整分頁遍歷（Exhaustive Pagination Traversal）**，確保所有適用規則皆納入計算，並遵守安全有界回應邊界。

---

## 1. 有界分頁設計原理 (Bounded Response Rationale)

為防止大型條款庫或多卡促銷造成 JSON-RPC stdio 管線緩衝區溢位、RPC 逾時或 LLM Token 超標，`search_active_offers`、`list_cards` 與 `remaining_caps` 嚴格限制單頁大小：
- **單頁上限 (Page Size Limit)**：`1 <= limit <= 20`（預設值通常為 10 或 20）。
- **頁碼 (1-based Page)**：`page >= 1`。

---

## 2. 完整遍歷遍歷虛擬碼與流程 (Exhaustive Pagination Loop)

> [!IMPORTANT]
> **嚴禁「只抓第一頁 (Take First Page)」**：
> 若查詢結果存在多頁（`hasMore: true`），Agent 必須循序取得所有頁面並聚合全部候選優惠，絕不能只取第一頁前 N 筆便進行排行。

```
   page = 1, allOffers = []
             │
             ▼
   [呼叫 search_active_offers(page, limit: 20)]
             │
             ▼
   將 offers 加入 allOffers
             │
             ▼
      hasMore === true ?
       ├── 是 ──► page = page + 1 ──► [重發請求]
       └── 否 ──► [聚合完畢，進入完整比對與排序]
```

### 遍歷實作範例

```typescript
async function fetchAllActiveOffers(cardId: string): Promise<OfferRule[]> {
  const allOffers: OfferRule[] = [];
  let currentPage = 1;
  let hasMore = true;

  while (hasMore) {
    const response = await mcpClient.callTool("search_active_offers", {
      cardId,
      page: currentPage,
      limit: 20,
      projection: "summary"
    });

    if (response.offers && response.offers.length > 0) {
      allOffers.push(...response.offers);
    }

    // 檢查是否有下一頁
    hasMore = response.hasMore === true;
    currentPage += 1;
  }

  return allOffers;
}
```
