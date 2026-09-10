# 推薦體驗拆票草稿

Status: needs-triage

以下為待確認的拆分，尚未發布正式 implementation issues。每票涵蓋 public MCP schema、dispatcher、service、必要 persistence、Agent 操作文件及可觀察的驗收；不另拆純 schema、純後端或最後才補文件的票。

共通要求：保持現有輸入相容，推薦不寫交易或消耗 cap；unknown 不等於 0；來源／scope／tenant 檢查保持有效。必要的局部 prefactor 隨第一個使用它的切片完成，不先做全域重構。票 01 起即以穩定的候選及 action 識別支援後續擴充。

## 01：用消費意圖取得持卡與已登記付款路徑候選

**Blocked by:** None (can start immediately).

**What to build:** 商家及已知消費資料即可開始推薦，MCP 自行讀取使用者工具；只有商家時能探索，不要求先查卡或選路徑。

- [ ] public recommend 接受商家及選填金額／幣別、國家、通路、時間；部分輸入回候選或具體追問。
- [ ] 直接刷卡與既有可驗證路徑使用同一候選模型，含 matched／potential rules、來源、狀態及 coverage。
- [ ] cardIds／routeIds 僅為可選篩選；舊分支保持相容；傳入事實在 public 與 service 行為一致。
- [ ] Agent 正常入口直接 recommend；以 public 呼叫驗證不帶 cardId 的推薦及商家歧義。
- [ ] 這票可暫保留明示的有界集合；票 06 提供完整續查，這票不得宣稱已涵蓋所有結果。

## 02：推薦內建候選級診斷與補件重試

**Blocked by:** 01.

**What to build:** 同一次推薦回傳可用結果及所缺資料；補完再呼叫同一入口，無需 preflight 前置。

- [ ] 每個 action 有 owner、required facts、受影響候選、補交方式與完成條件，並去重。
- [ ] 一條路徑缺 FX／來源不阻擋其他候選；商家未解不阻擋不依賴商家的規則。
- [ ] preflight 與 recommend 共用內部判定，舊 preflight 保留相容；新版正常流程不要求呼叫。
- [ ] Agent 執行研究型 action，只詢問使用者擁有的事實；沒有新證據時停止相同重試。
- [ ] 以 public 呼叫驗證 partial → 補件 → 重算，且不產生 ledger mutation。

## 03：登記外幣產品時取得並保存換匯政策

**Blocked by:** 02.

**What to build:** 卡片／優惠／路徑登記會提醒並承接缺少的官方換匯政策，供推薦重用。

- [ ] 政策與價格分開保存，含適用範圍、換匯方、rateType／方向、時點、fee／markup 基礎、來源及版本。
- [ ] ingestion 缺政策回 research_fx_policy；推薦也能重現未解缺項，已登記不等於政策完整。
- [ ] 公開可用的 typed 保存／引用契約完成端到端驗證；Agent 查官方條款、提交並檢查結果。
- [ ] 未知政策保持未知；不把 owner 的粗略預設當成銀行實際條款。
- [ ] 多產品可重用適用政策；政策變更不改寫歷史交易。

## 04：保存並重用各路徑適用的 FX observation

**Blocked by:** 03.

**What to build:** Agent 查一次、提交一次，後续推薦可直接使用適用的新鮮報價。

- [ ] 完成 observation 寫入入口、推薦讀取與本次 typed evidence 補交；recommend 維持 read-only。
- [ ] 硬性驗證 pair、provider／policy、rateType、scope、方向、正值、來源時間與 freshness，再選報價。
- [ ] 同 pair 不同路徑政策不互相覆蓋；不讀其他 tenant 私人資料。
- [ ] refresh action 精確指出所需報價，共用需求去重；寫入後重算門檻、cap、成本與排序。
- [ ] Agent 範例涵蓋查來源 → 保存確認 → recommend，並驗證重啟後可重用資料。

## 05：缺新匯率時先回估算，再按需更新

**Blocked by:** 04.

**What to build:** 缺新鮮報價仍能用受時效限制的舊報價或公共參考匯率先試算，並完成更新循環。

- [ ] 依政策設定 freshFor／maxEstimateAge；有效政策報價、可用舊報價、公共參考、unknown 的選擇可測試。
- [ ] 預設公共參考政策為臺銀即期，明確定義方向／種類／單位；實際來源 observation 由 Agent 提供，不硬編價格。
- [ ] 回 policy_current／stale_estimate／reference_estimate／unavailable、來源時間、假設及 refresh actions。
- [ ] 比較可計算的總支出與回饋後淨支出；未知 fee 不當 0，參考 FX 不使未知資格變 matched。
- [ ] Agent 先展示估算，優先刷新影響當前決策的報價；掌握全部缺項但不以全部更新完成作一般查詢終止條件。
- [ ] 新報價改變門檻或排序時顯示更新結果；來源失敗可交付帶缺口的估算；actual 不沿用未確認估算。

## 06：所有可能路徑與優惠可續查，預設每頁 10 筆

**Blocked by:** 02.

**What to build:** 使用者可取得全部已知可能優惠，page size 不截斷探索或規則集合。

- [ ] 穩定分頁可取完超過 30 個候選與單一路徑超過 10 個優惠，保留低回饋、缺資料與 action-required 候選。
- [ ] 回 hasMore、continuation、resultVersion、coverage；未探索完只回 discoveredCount，不偽裝最終 total。
- [ ] 分頁綁定輸入與資料版本；任何相關資料更新時明確 restart，避免重複／漏列。
- [ ] actions 亦可完整取得且去重；正常查詢先展示 10 筆，要求全部時 Agent 才持續取得完整結果。
- [ ] 資源限制可續跑；不能續跑的模型限制明示範圍，沒有默默 top-N 截斷。

## 07：從已驗證支付關係建立暫存付款路徑

**Blocked by:** 03, 06.

**What to build:** 使用者不必事先登記每一種組合，MCP 從可信支付能力及使用者持有事實探索 planned 路徑。

- [ ] 明確分開公共支付能力、私人持有／綁定與暫存候選的資料所有權；以 ADR 記錄生成與版本策略。
- [ ] 由有證據的 transitions 生成並評估候選；可直接刷卡、帳戶／錢包路徑均可端到端展示。
- [ ] 新的 planned 組合不需 upsert durable route；待綁定／登記的路徑列為 action-required。
- [ ] 遵守 top-up／purchase 區別、funding provenance 與既有 stacking 政策；品牌名不推導受理關係。
- [ ] 有界探索能續查並揭露 coverage；Agent workflow 示範沒有已登記組合仍能探索付款方式。

## 08：以 Agent 呼叫軌跡驗收完整推薦工作流

**Blocked by:** 05, 06, 07.

**What to build:** 新版 Agent 從登記、推薦到補件與全部優惠探索可直接使用，舊版文件不再引導錯誤前置步驟。

- [ ] 各票已更新的契約與操作說明收斂為單一 canonical workflow；router、playbook、template、SOP 引用一致且標記版本。
- [ ] Agent trace 覆蓋直接推薦、外幣政策缺項、初估後 refresh／保存／重算、更多／全部、來源失敗停止。
- [ ] 一般推薦無不必要的 list/preflight；沒有要求所有 FX 更新完才交付；要求全部時沒有漏頁。
- [ ] 以實際 public MCP 呼叫驗證 schema、service、文件範例一致；沒有假造工具或敏感資料。
- [ ] 移除矛盾指引但保留 legacy adapter；刪除舊 public tool 不在本票範圍。

## 後續範圍（本批不建立 ready-for-agent 票）

MCP 外的定期 FX 更新器與跨使用者可信公共 cache 可後續另開規劃：需先決定部署位置、來源驗證／寫入權限、更新頻率與失敗維運責任。基本版使用 Agent 按需更新與本地可信 cache 即可完成，不以這些部署決策阻擋本批。

## 審閱問題

確認以上八票粒度、依賴與後續範圍；核可後按順序發布為獨立 issue 檔。可先執行 01；05 與 06 沒有直接依賴，08 統一驗證新匯率導致分頁版本更新的完整行為。
